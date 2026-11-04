import type { Permission } from '@altis/shared';
import type { ImportSummary } from '@altis/shared/api/catalog/exchange';
import type { CollectionTypeView, MaterialTypeView } from '@altis/shared/api/catalog/masters';
import type { RecordDraft } from '@altis/shared/api/catalog/record-data';
import type { RunView } from '@altis/shared/api/catalog/runs';
import type { JobView } from '@altis/shared/api/jobs';
import { fireEvent, screen, waitFor, within } from '@testing-library/react';
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import { uploadFile } from '@/lib/upload';
import { BRANCH_MAIN, BRANCH_NORTH, json, problem, signedIn, startApp, type FakeRequest } from '../fake-api';

// Impor/Ekspor, the import wizard (Phase 2 spec §5.3, §13; plan Task 29): upload (`catalog.import`) → format and
// options → dry run (`POST catalog/imports {dryRun: true}` → the job's progress → the run summary with its warnings and
// up to 20 sample drafts) → the real run, which reuses the dry run's file through `fromRunId` (S3: the dry run took the
// staged upload) with the same options → its progress and report. The branch of `createItems` is one where the user
// holds `catalog.items.manage` (S11).

vi.mock('@/lib/upload', () => ({ uploadFile: vi.fn() }));

const T0 = 1_760_000_000_000;
const UPLOAD = '01JZ0000000000000000000U01';
const DRY = '01JZ0000000000000000000N01';
const DRY_2 = '01JZ0000000000000000000N02';
const REAL = '01JZ0000000000000000000N03';
const MT_BOOK = '01JZ0000000000000000000B01';
const CT_LOAN = '01JZ0000000000000000000C01';
// The dry run's note: nothing saved, and its counts are made per batch of 200 units (review L06: a dry batch is rolled
// back, so it does not see what an earlier one would have written).
const DRY_NOTE =
  'Ini hasil uji kering: belum ada yang disimpan ke katalog. Hitungannya dibuat per kelompok 200 cantuman atau baris, ' +
  'jadi cantuman atau barkod yang muncul lagi jauh di dalam berkas dapat terhitung dibuat dua kali di sini, sedangkan ' +
  'saat dijalankan ia dicocokkan dengan kemunculan pertamanya.';

const BOOK: MaterialTypeView = {
  id: MT_BOOK,
  code: 'BUKU',
  nameId: 'Buku',
  nameEn: 'Book',
  marcType: 'a',
  marcLevel: 'm',
  contentType: 'txt',
  mediaType: 'n',
  carrierType: 'nc',
  schemaType: 'Book',
  dcmiType: 'Text',
  template: { fields: {}, defaults: {}, customFields: [] },
  sortOrder: 0,
  usage: 1,
  archived: false,
  version: 1,
};

const LOAN: CollectionTypeView = {
  id: CT_LOAN,
  code: 'SIRKULASI',
  nameId: 'Sirkulasi',
  nameEn: 'Circulation',
  loanable: true,
  selfService: true,
  sortOrder: 0,
  usage: 0,
  archived: false,
  version: 1,
};

function draft(o: Partial<RecordDraft> & Pick<RecordDraft, 'title'>): RecordDraft {
  return {
    materialTypeCode: null,
    publisher: null,
    identifiers: [],
    agents: [],
    subjects: [],
    links: [],
    items: [],
    marcExtra: [],
    ...o,
  };
}

function summary(o: Partial<ImportSummary> = {}): ImportSummary {
  return { read: 0, created: 0, updated: 0, skipped: {}, duplicates: 0, itemsCreated: 0, errors: 0, warnings: [], ...o };
}

function run(o: Partial<RunView> & Pick<RunView, 'id'>): RunView {
  return {
    kind: 'import',
    status: 'succeeded',
    dryRun: false,
    format: 'csv-records',
    options: {},
    summary: null,
    reportFileId: null,
    outputName: null,
    outputSize: null,
    expiresAt: null,
    jobId: null,
    createdAt: T0,
    createdBy: 'U1',
    finishedAt: T0 + 60_000,
    ...o,
  };
}

function job(id: string, o: Partial<JobView> = {}): JobView {
  return {
    id,
    type: 'catalog.import',
    status: 'succeeded',
    progress: 100,
    progressMessage: null,
    attempts: 1,
    maxAttempts: 3,
    lastError: null,
    runAt: T0,
    createdAt: T0,
    updatedAt: T0,
    finishedAt: T0,
    createdBy: 'U1',
    retryable: 'origin-only',
    cancellable: true,
    interactive: true,
    ...o,
  };
}

/** What the dry run of the cp1252 CSV answers (Review Focus 1): the reader's warning and the first mapped record. */
const DRY_SUMMARY = summary({
  read: 2,
  created: 2,
  warnings: ['encoding_cp1252'],
  sample: [
    draft({
      title: 'Téh Mañana',
      publicationYear: '2005',
      identifiers: [{ type: 'isbn', value: '9786020000001' }],
      agents: [{ type: 'person', name: 'Hirata, Andrea', role: 'aut', isMain: true }],
    }),
    draft({ title: 'Bumi Manusia', materialTypeCode: 'BUKU' }),
  ],
});

const REAL_SUMMARY = summary({ read: 2, created: 1, updated: 1, skipped: { branch_denied: 1 }, itemsCreated: 3, errors: 1, warnings: ['encoding_cp1252'] });

const ITEMS_AT_NORTH: Permission[] = ['catalog.records.read', 'catalog.import.run'];

function start(o: { me?: ReturnType<typeof signedIn>; runs?: Record<string, RunView>; imports?: (req: FakeRequest) => unknown } = {}) {
  const me = o.me ?? { ...signedIn({ permissions: ITEMS_AT_NORTH }), branchPermissions: { [BRANCH_NORTH.id]: ['catalog.items.manage'] } };
  const runs: Record<string, RunView> = o.runs ?? {
    [DRY]: run({ id: DRY, dryRun: true, jobId: 'J1', summary: { ...DRY_SUMMARY }, reportFileId: '01JZ0000000000000000000F01' }),
    [DRY_2]: run({ id: DRY_2, dryRun: true, jobId: 'J3', summary: { ...DRY_SUMMARY } }),
    [REAL]: run({ id: REAL, jobId: 'J2', summary: { ...REAL_SUMMARY }, reportFileId: '01JZ0000000000000000000F02' }),
  };
  let dryRuns = 0;
  const imports =
    o.imports ??
    ((req: FakeRequest) => {
      const body = req.body as { dryRun: boolean };
      if (!body.dryRun) return json({ runId: REAL, jobId: 'J2' }, 202);
      dryRuns += 1;
      return json(dryRuns === 1 ? { runId: DRY, jobId: 'J1' } : { runId: DRY_2, jobId: 'J3' }, 202);
    });
  return startApp({
    me,
    path: '/admin/catalog/exchange',
    routes: {
      'GET branches': () => ({ items: [BRANCH_MAIN, BRANCH_NORTH] }),
      'GET catalog/material-types': () => ({ items: [BOOK] }),
      'GET catalog/collection-types': () => ({ items: [LOAN] }),
      'POST catalog/imports': imports,
      'GET jobs/:id': (req) => job(req.params['id']!),
      'GET catalog/runs/:id': (req) => runs[req.params['id']!] ?? problem(404, 'NOT_FOUND'),
    },
  });
}

/** The bodies of `POST catalog/imports`, in order. */
const importBodies = (requests: FakeRequest[]): unknown[] => requests.filter((r) => r.method === 'POST' && r.path === 'catalog/imports').map((r) => r.body);

/** Picks `name` and sends it (the chunked upload itself is lib/upload.ts's, mocked here). */
async function upload(name = 'koleksi.csv'): Promise<File> {
  const file = new File([new Uint8Array([0x54, 0xe9, 0x68])], name, { type: 'text/csv' });
  fireEvent.change(await screen.findByLabelText('Berkas impor'), { target: { files: [file] } });
  fireEvent.click(screen.getByRole('button', { name: 'Unggah berkas' }));
  await screen.findByRole('button', { name: 'Uji kering' });
  return file;
}

beforeEach(() => {
  vi.mocked(uploadFile).mockReset();
  vi.mocked(uploadFile).mockResolvedValue({ uploadId: UPLOAD });
});

afterEach(() => {
  vi.unstubAllGlobals();
  vi.restoreAllMocks();
});

describe('the import wizard', () => {
  it('posts the dry run with the chosen options, shows its warning and sample, then runs it again with fromRunId and no uploadId', async () => {
    const { requests } = start();
    const file = await upload();
    expect(uploadFile).toHaveBeenCalledWith(file, expect.objectContaining({ context: 'catalog.import' }));

    // The options: the format stays detected (nothing sent), the branch list holds only where items may be managed.
    expect((screen.getByLabelText('Format berkas') as HTMLSelectElement).value).toBe('');
    fireEvent.change(screen.getByLabelText('Cocokkan lewat'), { target: { value: 'isbn' } });
    fireEvent.change(screen.getByLabelText('Bila cocok dengan cantuman yang ada'), { target: { value: 'update' } });
    fireEvent.change(screen.getByLabelText('Bila kemungkinan duplikat'), { target: { value: 'skip' } });
    fireEvent.click(screen.getByLabelText('Buat eksemplar dari data eksemplar di berkas'));
    const branch = screen.getByLabelText('Cabang eksemplar') as HTMLSelectElement;
    const offered = [...branch.options].map((option) => option.value).filter((v) => v !== '');
    expect(offered).toEqual([BRANCH_NORTH.id]);
    fireEvent.change(branch, { target: { value: BRANCH_NORTH.id } });
    fireEvent.change(await screen.findByLabelText('Jenis bahan bawaan'), { target: { value: MT_BOOK } });
    fireEvent.change(screen.getByLabelText('Tipe koleksi bawaan'), { target: { value: CT_LOAN } });
    fireEvent.click(screen.getByRole('button', { name: 'Uji kering' }));

    await waitFor(() => expect(importBodies(requests)).toHaveLength(1));
    expect(importBodies(requests)[0]).toEqual({
      uploadId: UPLOAD,
      matchOn: 'isbn',
      onMatch: 'update',
      onDuplicate: 'skip',
      createItems: true,
      branchId: BRANCH_NORTH.id,
      defaultMaterialTypeId: MT_BOOK,
      defaultCollectionTypeId: CT_LOAN,
      dryRun: true,
    });

    // The dry run's summary: the reader's cp1252 warning (Review Focus 1), the counts and the first mapped records.
    const result = await screen.findByRole('region', { name: 'Hasil uji kering' });
    expect(within(result).getByText(/dibaca sebagai Windows-1252/)).toBeTruthy();
    expect(within(result).getByText(DRY_NOTE)).toBeTruthy();
    const sample = within(result).getByRole('table', { name: 'Contoh cantuman terpetakan' });
    expect(within(sample).getByText('Téh Mañana')).toBeTruthy();
    expect(within(sample).getByText('Hirata, Andrea')).toBeTruthy();
    expect(within(sample).getByText('9786020000001')).toBeTruthy();
    expect(within(sample).getByText('Bumi Manusia')).toBeTruthy();
    expect(within(result).getByRole('link', { name: 'Unduh laporan (CSV)' }).getAttribute('href')).toBe(`/api/v1/catalog/runs/${DRY}/report`);

    // The real run: the dry run's file (fromRunId), the same options, no upload id.
    fireEvent.click(within(result).getByRole('button', { name: 'Jalankan impor' }));
    await waitFor(() => expect(importBodies(requests)).toHaveLength(2));
    const real = importBodies(requests)[1] as Record<string, unknown>;
    expect(real).toEqual({
      fromRunId: DRY,
      matchOn: 'isbn',
      onMatch: 'update',
      onDuplicate: 'skip',
      createItems: true,
      branchId: BRANCH_NORTH.id,
      defaultMaterialTypeId: MT_BOOK,
      defaultCollectionTypeId: CT_LOAN,
      dryRun: false,
    });
    expect(real).not.toHaveProperty('uploadId');

    // Its progress, then its summary and report.
    const done = await screen.findByRole('region', { name: 'Hasil impor' });
    expect(within(done).queryByText(/belum ada yang disimpan ke katalog/)).toBeNull();
    expect(within(done).getByText('Cabang di luar hak Anda')).toBeTruthy();
    expect(within(done).getByRole('link', { name: 'Unduh laporan (CSV)' }).getAttribute('href')).toBe(`/api/v1/catalog/runs/${REAL}/report`);
    expect(within(done).getByRole('link', { name: 'Buka rincian proses' }).getAttribute('href')).toBe(`/admin/catalog/runs/${REAL}`);
    expect(uploadFile).toHaveBeenCalledTimes(1);
  });

  it('a format chosen by hand is sent; "Ubah opsi" runs the dry run again on the same file through fromRunId', async () => {
    const { requests } = start();
    await upload('ekspor.mrc');
    fireEvent.change(screen.getByLabelText('Format berkas'), { target: { value: 'marc21' } });
    fireEvent.click(screen.getByRole('button', { name: 'Uji kering' }));
    await screen.findByRole('region', { name: 'Hasil uji kering' });
    expect(importBodies(requests)[0]).toEqual({
      uploadId: UPLOAD,
      format: 'marc21',
      matchOn: 'isbn',
      onMatch: 'skip',
      onDuplicate: 'report',
      createItems: false,
      dryRun: true,
    });

    fireEvent.click(screen.getByRole('button', { name: 'Ubah opsi' }));
    fireEvent.change(await screen.findByLabelText('Bila cocok dengan cantuman yang ada'), { target: { value: 'create' } });
    fireEvent.click(screen.getByRole('button', { name: 'Uji kering' }));
    await waitFor(() => expect(importBodies(requests)).toHaveLength(2));
    expect(importBodies(requests)[1]).toEqual({
      fromRunId: DRY,
      format: 'marc21',
      matchOn: 'isbn',
      onMatch: 'create',
      onDuplicate: 'report',
      createItems: false,
      dryRun: true,
    });

    // The real run takes the latest dry run's file.
    fireEvent.click(await screen.findByRole('button', { name: 'Jalankan impor' }));
    await waitFor(() => expect(importBodies(requests)).toHaveLength(3));
    expect(importBodies(requests)[2]).toMatchObject({ fromRunId: DRY_2, onMatch: 'create', dryRun: false });
    expect(uploadFile).toHaveBeenCalledTimes(1);
  });

  it('L13: a branch the server marks inactive is not offered for the items', async () => {
    startApp({
      me: { ...signedIn({ permissions: ITEMS_AT_NORTH }), branchPermissions: { [BRANCH_MAIN.id]: ['catalog.items.manage'], [BRANCH_NORTH.id]: ['catalog.items.manage'] } },
      path: '/admin/catalog/exchange',
      routes: {
        'GET branches': () => ({ items: [{ ...BRANCH_MAIN, active: true }, { ...BRANCH_NORTH, active: false }] }),
        'GET catalog/material-types': () => ({ items: [BOOK] }),
        'GET catalog/collection-types': () => ({ items: [LOAN] }),
      },
    });
    await upload();
    const branch = screen.getByLabelText('Cabang eksemplar') as HTMLSelectElement;
    expect([...branch.options].map((o) => o.value).filter((v) => v !== '')).toEqual([BRANCH_MAIN.id]);
  });

  it('without catalog.items.manage at any branch, items cannot be created; creating items needs a branch', async () => {
    const { requests } = start({ me: signedIn({ permissions: ITEMS_AT_NORTH }) });
    await upload();
    const box = screen.getByLabelText('Buat eksemplar dari data eksemplar di berkas') as HTMLInputElement;
    expect(box.disabled).toBe(true);
    expect(screen.getByText(/tidak berhak mengelola eksemplar di cabang mana pun/)).toBeTruthy();
    expect(importBodies(requests)).toEqual([]);
  });

  it('asks for the branch before a dry run that creates items', async () => {
    const { requests } = start();
    await upload();
    fireEvent.click(screen.getByLabelText('Buat eksemplar dari data eksemplar di berkas'));
    fireEvent.click(screen.getByRole('button', { name: 'Uji kering' }));
    expect(await screen.findByText('Pilih cabang untuk eksemplar yang dibuat.')).toBeTruthy();
    expect(importBodies(requests)).toEqual([]);
  });

  it('a dry run that failed offers to start again with a new file', async () => {
    const runs = { [DRY]: run({ id: DRY, dryRun: true, status: 'failed', jobId: 'J1' }) };
    startApp({
      me: { ...signedIn({ permissions: ITEMS_AT_NORTH }), branchPermissions: {} },
      path: '/admin/catalog/exchange',
      routes: {
        'GET branches': () => ({ items: [BRANCH_MAIN] }),
        'GET catalog/material-types': () => ({ items: [] }),
        'GET catalog/collection-types': () => ({ items: [] }),
        'POST catalog/imports': () => json({ runId: DRY, jobId: 'J1' }, 202),
        'GET jobs/:id': (req) => job(req.params['id']!, { status: 'dead', lastError: 'CATALOG_IMPORT_FORMAT: DOCTYPE' }),
        'GET catalog/runs/:id': (req) => runs[req.params['id'] as typeof DRY] ?? problem(404, 'NOT_FOUND'),
      },
    });
    await upload();
    fireEvent.click(screen.getByRole('button', { name: 'Uji kering' }));
    expect(await screen.findByText(/Proses berhenti sebelum selesai/)).toBeTruthy();
    expect(screen.queryByRole('button', { name: 'Jalankan impor' })).toBeNull();
    fireEvent.click(screen.getByRole('button', { name: 'Mulai dari awal' }));
    expect(await screen.findByLabelText('Berkas impor')).toBeTruthy();
  });

  it('a dry run whose file is no longer there asks for the file again', async () => {
    let calls = 0;
    const { requests } = start({
      imports: () => {
        calls += 1;
        if (calls === 1) return json({ runId: DRY, jobId: 'J1' }, 202);
        return problem(422, 'VALIDATION_FAILED', { errors: [{ path: 'fromRunId', code: 'not_found' }] });
      },
    });
    await upload();
    fireEvent.click(screen.getByRole('button', { name: 'Uji kering' }));
    await screen.findByRole('region', { name: 'Hasil uji kering' });
    fireEvent.click(screen.getByRole('button', { name: 'Jalankan impor' }));
    expect(await screen.findByText(/Unggah berkasnya lagi/)).toBeTruthy();
    expect(importBodies(requests)).toHaveLength(2);
    fireEvent.click(screen.getByRole('button', { name: 'Mulai dari awal' }));
    expect(await screen.findByLabelText('Berkas impor')).toBeTruthy();
  });

  it('without catalog.import.run the wizard is not offered', async () => {
    start({ me: signedIn({ permissions: ['catalog.records.read'] }) });
    expect(await screen.findByRole('heading', { name: 'Impor/Ekspor' })).toBeTruthy();
    expect(screen.queryByRole('tab', { name: 'Impor' })).toBeNull();
    expect(screen.getByRole('tab', { name: 'Riwayat' })).toBeTruthy();
  });
});

// C21: a finished dry run can be continued from its own page (a reload, the run link, Riwayat, a session that ended),
// as the wizard would: the same options read from the stored run (`{body, stagingId, adoptedFrom}`) and the same
// `catalog-import:<dry run>` key, so a retry from either place gets the stored answer.
describe('the run page of a dry import run (C21)', () => {
  const DAY = 86_400_000;
  const STORED = {
    body: { uploadId: UPLOAD, format: 'marc21', matchOn: 'isbn', onMatch: 'update', onDuplicate: 'skip', createItems: true, branchId: BRANCH_NORTH.id, dryRun: true },
    stagingId: UPLOAD,
    adoptedFrom: null,
  };

  function startRunPage(o: { dry?: Partial<RunView>; me?: ReturnType<typeof signedIn>; imports?: (req: FakeRequest) => unknown } = {}) {
    const runs: Record<string, RunView> = {
      [DRY]: run({ id: DRY, dryRun: true, jobId: 'J1', options: STORED, summary: { ...DRY_SUMMARY }, finishedAt: Date.now() - DAY, ...o.dry }),
      [REAL]: run({ id: REAL, status: 'running', jobId: 'J2', summary: null, finishedAt: null, options: { body: { ...STORED.body, uploadId: undefined, fromRunId: DRY, dryRun: false } } }),
    };
    const app = startApp({
      me: o.me ?? { ...signedIn({ permissions: ITEMS_AT_NORTH }), branchPermissions: { [BRANCH_NORTH.id]: ['catalog.items.manage'] } },
      path: `/admin/catalog/runs/${DRY}`,
      routes: {
        'POST catalog/imports': o.imports ?? (() => json({ runId: REAL, jobId: 'J2' }, 202)),
        'GET jobs/:id': (req) => job(req.params['id']!, req.params['id'] === 'J2' ? { status: 'running', progress: 10, finishedAt: null } : {}),
        'GET catalog/runs/:id': (req) => runs[req.params['id']!] ?? problem(404, 'NOT_FOUND'),
      },
    });
    return app;
  }

  it('shows the options it was run with and runs the import with fromRunId, the same options and the wizard\'s key', async () => {
    const { requests, router, fetchMock } = startRunPage();
    const facts = await screen.findByRole('region', { name: 'Keterangan proses' });
    expect(within(facts).getByText('Perbarui cantuman yang ada')).toBeTruthy();
    expect(within(facts).getByText('Lewati, lalu catat di laporan')).toBeTruthy();
    fireEvent.click(await screen.findByRole('button', { name: 'Jalankan impor' }));
    await waitFor(() => expect(importBodies(requests)).toHaveLength(1));
    const real = importBodies(requests)[0];
    expect(real).toEqual({
      fromRunId: DRY,
      format: 'marc21',
      matchOn: 'isbn',
      onMatch: 'update',
      onDuplicate: 'skip',
      createItems: true,
      branchId: BRANCH_NORTH.id,
      dryRun: false,
    });
    const post = fetchMock.mock.calls.find(([input, init]) => String(input).endsWith('/catalog/imports') && init?.method === 'POST');
    expect(new Headers(post?.[1]?.headers).get('Idempotency-Key')).toBe(`catalog-import:${DRY}`);
    await waitFor(() => expect(router.state.location.pathname).toBe(`/admin/catalog/runs/${REAL}`));
  });

  it.each([
    ['already taken by a real run', { dry: { options: { ...STORED, adoptedBy: REAL } } }],
    ["another user's", { dry: { createdBy: 'U2' } }],
    ['older than 7 days', { dry: { finishedAt: Date.now() - 8 * DAY } }],
    ['that failed', { dry: { status: 'failed' as const } }],
    ['that is a real run', { dry: { dryRun: false } }],
    ['seen without catalog.import.run', { me: signedIn({ permissions: ['catalog.records.read'] }) }],
  ])('a run %s offers no "Jalankan impor"', async (_label, c) => {
    startRunPage(c);
    await screen.findByRole('region', { name: 'Keterangan proses' });
    await screen.findByRole('heading', { name: 'Ringkasan' });
    expect(screen.queryByRole('button', { name: 'Jalankan impor' })).toBeNull();
  });

  it('a dry run whose file the server no longer has asks for the file again', async () => {
    const { requests } = startRunPage({ imports: () => problem(422, 'VALIDATION_FAILED', { errors: [{ path: 'fromRunId', code: 'not_found' }] }) });
    fireEvent.click(await screen.findByRole('button', { name: 'Jalankan impor' }));
    expect(await screen.findByText(/Unggah berkasnya lagi/)).toBeTruthy();
    expect(importBodies(requests)).toHaveLength(1);
    expect(screen.queryByRole('button', { name: 'Jalankan impor' })).toBeNull();
  });
});
