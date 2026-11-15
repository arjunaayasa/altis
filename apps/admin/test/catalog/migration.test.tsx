import type { BranchListResponse } from '@altis/shared/api/branches';
import type { MigrationSummary, SlimsTestResponse } from '@altis/shared/api/catalog/migration';
import type { RunListResponse, RunView } from '@altis/shared/api/catalog/runs';
import type { JobView } from '@altis/shared/api/jobs';
import { fireEvent, screen, waitFor, within } from '@testing-library/react';
import { afterEach, describe, expect, it, vi } from 'vitest';
import { BRANCH_MAIN, BRANCH_NORTH, adminMe, problem, startApp, superMe, type FakeHandler, type FakeRequest } from '../fake-api';

// Migrasi SLiMS (Phase 2 spec §11, §13; plan Task 30; routes of Task 23) through the real router and API client
// against a fake `/api/v1`: the source (a SLiMS database with "Uji koneksi", or a dump upload, plus the files zip),
// the options (target branch, priceMode, source name, "izinkan target tidak kosong" with the library name typed out),
// the dry run and its report (the reconciliation, the samples, the charset sample, the target-table counts), then the
// real run, which takes the dry run over with `fromRunId` (S3): nothing uploaded again for a dump, the password asked
// again for a database.

/** An hour ago: a dry run can be taken over for 7 days after it ended, counted from the real clock. */
const AT = Date.now() - 3_600_000;
const DRY_ID = '01JZ0000000000000000RN0001';
const REAL_ID = '01JZ0000000000000000RN0002';
const DRY_JOB = '01JZ0000000000000000JB0001';
const REAL_JOB = '01JZ0000000000000000JB0002';
const DUMP_UPLOAD = '01JZ0000000000000000DP0001';
const FILES_UPLOAD = '01JZ0000000000000000FP0002';
const FIRST = { timeout: 10_000 };

// `GET branches` says whether each branch is active (L13; the community server marks every live branch active).
const BRANCHES: BranchListResponse = { items: [BRANCH_MAIN, BRANCH_NORTH].map((b) => ({ ...b, active: true })) };

function summary(o: Partial<MigrationSummary> = {}): MigrationSummary & Record<string, unknown> {
  return {
    version: '9',
    stage: 'report',
    tables: {},
    unread: ['member'],
    reconciliation: {
      ok: false,
      tables: [
        { table: 'biblio', source: 300, migrated: 296, merged: 0, skipped: 4, archived: 0, unread: false, diff: 0 },
        { table: 'item', source: 600, migrated: 590, merged: 0, skipped: 7, archived: 0, unread: false, diff: 3 },
        { table: 'member', source: 42, migrated: 0, merged: 0, skipped: 0, archived: 0, unread: true, diff: 0 },
      ],
    },
    fixes: { 'biblio.title': { mojibake: 12 } },
    samples: [{ column: 'biblio.title', fix: 'mojibake', before: 'Kisah dari SiÃ¢â‚¬â„¢ak', after: 'Kisah dari Si’ak' }],
    charset: [{ column: 'biblio.title', rows: 300, ascii: 250, utf8: 30, cp1252: 8, mojibake: 12, samples: ['SiÃ¢â‚¬â„¢ak'] }],
    targets: [
      { table: 'records', before: 0, after: 0 },
      { table: 'items', before: 0, after: 0 },
    ],
    checks: [],
    missingFiles: 2,
    nonstandardBarcodes: 1,
    warnings: ['reconciliation_diff'],
    // The framework's own fields (Task 23), which the screen ignores.
    resume: { stage: 11, cursor: null },
    checkSource: {},
    indexBuilding: false,
    ...o,
  };
}

function run(o: Partial<RunView> & Pick<RunView, 'id'>): RunView {
  return {
    kind: 'migration',
    status: 'succeeded',
    dryRun: true,
    format: null,
    options: {
      sourceKind: 'dump',
      db: null,
      branchId: BRANCH_MAIN.id,
      priceMode: 'major',
      sourceName: 'slims',
      allowNonEmpty: false,
      dumpStagingId: DUMP_UPLOAD,
      files: 'zip',
      filesStagingId: FILES_UPLOAD,
      filesDir: null,
      adoptedFrom: null,
    },
    summary: summary(),
    reportFileId: '01JZ0000000000000000RP0001',
    outputName: null,
    outputSize: null,
    expiresAt: null,
    jobId: DRY_JOB,
    createdAt: AT,
    createdBy: 'U1',
    finishedAt: AT + 60_000,
    ...o,
  };
}

function job(id: string, o: Partial<JobView> = {}): JobView {
  return {
    id,
    type: 'catalog.migrate_slims',
    status: 'succeeded',
    progress: 100,
    progressMessage: null,
    attempts: 1,
    maxAttempts: 3,
    lastError: null,
    runAt: AT,
    createdAt: AT,
    updatedAt: AT + 60_000,
    finishedAt: AT + 60_000,
    createdBy: 'U1',
    retryable: 'origin-only',
    cancellable: false,
    interactive: true,
    ...o,
  };
}

/** The chunked upload of lib/upload.ts, answered for one upload id per context (`slims.dump`, `slims.files`). */
function uploadRoutes(): Record<string, FakeHandler> {
  return {
    'POST files/uploads': (req) => {
      const context = (req.body as { context: string }).context;
      return { id: context === 'slims.dump' ? DUMP_UPLOAD : FILES_UPLOAD, chunkSize: 256 * 1024, chunks: 1, expiresAt: AT + 86_400_000 };
    },
    'POST files/uploads/:id/chunks/:n': () => ({ received: 10, complete: true }),
    'POST files/uploads/:id/complete': (req) => ({ uploadId: req.params['id'], size: 10, sha256: 'a'.repeat(64), mime: 'text/plain' }),
  };
}

/** The options a run keeps (Task 23's `catalog_runs.options`, never the password) for the start `body`. */
function optionsFrom(body: Record<string, unknown>, dryRun: RunView | undefined): Record<string, unknown> {
  const source = body['source'] as { kind: 'db' | 'dump'; host?: string; port?: number; user?: string; database?: string; tls?: boolean } | undefined;
  const kind = source?.kind ?? (dryRun?.options['sourceKind'] as 'db' | 'dump' | undefined) ?? 'dump';
  return {
    sourceKind: kind,
    db: kind === 'db' && source !== undefined ? { host: source.host, port: source.port, user: source.user, database: source.database, tls: source.tls } : null,
    branchId: body['branchId'],
    priceMode: body['priceMode'],
    sourceName: body['sourceName'],
    allowNonEmpty: body['allowNonEmpty'],
    dumpStagingId: kind === 'dump' && body['fromRunId'] === undefined ? DUMP_UPLOAD : null,
    files: body['filesUploadId'] === undefined ? null : 'zip',
    filesStagingId: (body['filesUploadId'] as string | undefined) ?? null,
    filesDir: null,
    adoptedFrom: (body['fromRunId'] as string | undefined) ?? null,
  };
}

/** A migration that is fake from the dry run to the real run: each start makes the next run, each run ends at once. */
function migrationRoutes(o: { runs?: RunView[] } = {}): Record<string, FakeHandler> {
  const runs = new Map<string, RunView>();
  for (const r of o.runs ?? []) runs.set(r.id, r);
  return {
    'GET branches': () => BRANCHES,
    'GET catalog/runs': (): RunListResponse => ({ items: [...(o.runs ?? [])], nextCursor: null }),
    'GET catalog/runs/:id': (req) => runs.get(req.params['id']!) ?? problem(404, 'NOT_FOUND'),
    'GET jobs/:id': (req) => job(req.params['id']!),
    'POST catalog/migrations/slims': (req) => {
      const body = req.body as Record<string, unknown>;
      const options = optionsFrom(body, runs.get(DRY_ID));
      const r = body['dryRun'] === true
        ? run({ id: DRY_ID, jobId: DRY_JOB, options })
        : run({ id: REAL_ID, jobId: REAL_JOB, dryRun: false, options, summary: summary({ warnings: [] }) });
      runs.set(r.id, r);
      return new Response(JSON.stringify({ runId: r.id, jobId: r.jobId }), { status: 201, headers: { 'Content-Type': 'application/json' } });
    },
    ...uploadRoutes(),
  };
}

const starts = (requests: FakeRequest[]): unknown[] => requests.filter((r) => r.method === 'POST' && r.path === 'catalog/migrations/slims').map((r) => r.body);
const uploads = (requests: FakeRequest[]): string[] => requests.filter((r) => r.method === 'POST' && r.path === 'files/uploads').map((r) => (r.body as { context: string }).context);

function type(label: string | RegExp, value: string): void {
  fireEvent.change(screen.getByLabelText(label), { target: { value } });
}

/** Picks a file for the file input labelled `label`. */
function pick(label: string | RegExp, name: string, content = 'INSERT INTO biblio VALUES (1);'): void {
  fireEvent.change(screen.getByLabelText(label), { target: { files: [new File([content], name, { type: 'application/octet-stream' })] } });
}

/** Waits until the options step shows the branches, the default one chosen. */
async function branchesShown(): Promise<void> {
  const select = (await screen.findByLabelText('Cabang tujuan')) as HTMLSelectElement;
  await waitFor(() => expect(select.value).toBe(BRANCH_MAIN.id));
}

/** Opens the screen and fills the dump source (with the files zip), then goes on to the options. */
async function dumpSource(): Promise<void> {
  fireEvent.click(await screen.findByLabelText('Berkas dump SQL', undefined, FIRST));
  pick(/Berkas dump \(/, 'slims.sql');
  pick(/Arsip berkas lampiran/, 'berkas.zip', 'PK');
  fireEvent.click(screen.getByRole('button', { name: 'Lanjut' }));
  await branchesShown();
}

/** Opens the screen and fills the database source, then goes on to the options. */
async function dbSource(): Promise<void> {
  fireEvent.click(await screen.findByLabelText('Basis data SLiMS (koneksi langsung)', undefined, FIRST));
  type('Host', 'db.perpus.local');
  type('Port', '3306');
  type('Pengguna basis data', 'slims_ro');
  type('Kata sandi basis data', 'rahasia-lama');
  type('Nama basis data', 'slims');
  fireEvent.click(screen.getByRole('button', { name: 'Lanjut' }));
  await branchesShown();
}

afterEach(() => {
  vi.unstubAllGlobals();
  vi.restoreAllMocks();
});

describe('Migrasi SLiMS', () => {
  it('L13: a branch the server marks inactive is not offered as the target branch', async () => {
    startApp({
      me: superMe(),
      path: '/admin/catalog/migration',
      routes: { ...migrationRoutes(), 'GET branches': () => ({ items: [{ ...BRANCH_MAIN, active: true }, { ...BRANCH_NORTH, active: false }] }) },
    });
    await dumpSource();
    const select = screen.getByLabelText('Cabang tujuan') as HTMLSelectElement;
    expect([...select.options].map((o) => o.value)).toEqual([BRANCH_MAIN.id]);
  });

  it('requires the library name when "Izinkan katalog tujuan yang tidak kosong" is on, and sends it', async () => {
    const { requests } = startApp({ me: superMe(), path: '/admin/catalog/migration', routes: migrationRoutes() });
    await dumpSource();
    fireEvent.click(screen.getByLabelText('Izinkan katalog tujuan yang tidak kosong'));
    const name = screen.getByLabelText(/Ketik nama perpustakaan ini untuk mengonfirmasi/);
    expect(screen.getByText(/Perpustakaan Arsya/, { selector: 'label' })).toBeTruthy();

    fireEvent.click(screen.getByRole('button', { name: 'Mulai uji kering' }));
    expect(await screen.findByText('Ketik nama perpustakaan untuk mengonfirmasi.')).toBeTruthy();
    expect(name.getAttribute('aria-invalid')).toBe('true');
    fireEvent.change(name, { target: { value: 'Perpustakaan Lain' } });
    fireEvent.click(screen.getByRole('button', { name: 'Mulai uji kering' }));
    expect(await screen.findByText('Nama yang diketik tidak sama dengan nama perpustakaan ini.')).toBeTruthy();
    expect(uploads(requests)).toEqual([]);
    expect(starts(requests)).toEqual([]);

    fireEvent.change(name, { target: { value: ' Perpustakaan Arsya ' } });
    fireEvent.click(screen.getByRole('button', { name: 'Mulai uji kering' }));
    await screen.findByRole('heading', { name: 'Laporan uji kering' });
    expect(uploads(requests)).toEqual(['slims.dump', 'slims.files']);
    expect(starts(requests)).toEqual([
      {
        source: { kind: 'dump', uploadId: DUMP_UPLOAD },
        filesUploadId: FILES_UPLOAD,
        branchId: BRANCH_MAIN.id,
        priceMode: 'major',
        sourceName: 'slims',
        allowNonEmpty: true,
        confirmLibraryName: ' Perpustakaan Arsya ',
        dryRun: true,
      },
    ]);
  });

  it('the dry run report shows a failing reconciliation row in red with its diff, the samples, the charset and the targets', async () => {
    startApp({ me: superMe(), path: `/admin/catalog/migration?run=${DRY_ID}`, routes: migrationRoutes({ runs: [run({ id: DRY_ID })] }) });
    const table = await screen.findByRole('table', { name: 'Rekonsiliasi per tabel SLiMS' }, FIRST);
    const rows = within(table).getAllByRole('row');
    const item = rows.find((r) => within(r).queryByRole('rowheader', { name: 'item' }) !== null)!;
    expect(item.className).toContain('text-destructive');
    expect(within(item).getByText('3')).toBeTruthy();
    expect(within(item).getByText('Tidak terjelaskan')).toBeTruthy();
    const biblio = rows.find((r) => within(r).queryByRole('rowheader', { name: 'biblio' }) !== null)!;
    expect(biblio.className).not.toContain('text-destructive');
    const member = rows.find((r) => within(r).queryByRole('rowheader', { name: 'member' }) !== null)!;
    expect(within(member).getByText('Tidak dibaca (belum didukung)')).toBeTruthy();
    expect(screen.getByText(/1 tabel punya selisih yang tidak terjelaskan/)).toBeTruthy();

    const charset = screen.getByRole('table', { name: 'Contoh set karakter (1.000 baris pertama)' });
    expect(within(charset).getByRole('rowheader', { name: 'biblio.title' })).toBeTruthy();
    expect(within(charset).getByText('12')).toBeTruthy();
    const samples = screen.getByRole('table', { name: 'Contoh perbaikan teks' });
    expect(within(samples).getByText('Kisah dari Si’ak')).toBeTruthy();
    const targets = screen.getByRole('table', { name: 'Baris di tabel ALTIS' });
    expect(within(targets).getByRole('rowheader', { name: 'records' })).toBeTruthy();
    expect(screen.getByText('Berkas lampiran yang hilang: 2')).toBeTruthy();
    expect(screen.getByRole('link', { name: 'Unduh laporan lengkap (CSV)' }).getAttribute('href')).toBe(`/api/v1/catalog/runs/${DRY_ID}/report`);
  });

  it('after a dump dry run, the real run posts {fromRunId, …} without source or filesUploadId (nothing uploaded again)', async () => {
    let reauthed = false;
    const base = migrationRoutes();
    const { requests } = startApp({
      me: superMe(),
      path: '/admin/catalog/migration',
      routes: {
        ...base,
        'POST auth/reauth': () => {
          reauthed = true;
          return { reauthUntil: AT + 300_000 };
        },
        'POST catalog/migrations/slims': (req) => ((req.body as { dryRun: boolean }).dryRun || reauthed ? base['POST catalog/migrations/slims']!(req) : problem(401, 'AUTH_REAUTH_REQUIRED')),
      },
    });
    await dumpSource();
    fireEvent.change(screen.getByLabelText('Cabang tujuan'), { target: { value: BRANCH_NORTH.id } });
    fireEvent.click(screen.getByLabelText(/Angka SLiMS sudah dalam sen/));
    type('Nama sumber', 'kampus');
    fireEvent.click(screen.getByRole('button', { name: 'Mulai uji kering' }));
    await screen.findByRole('heading', { name: 'Laporan uji kering' });
    expect(screen.getByText(/hanya menambah baris baru/)).toBeTruthy();

    fireEvent.click(screen.getByRole('button', { name: 'Jalankan migrasi' }));
    const dialog = await screen.findByRole('dialog', { name: 'Konfirmasi kata sandi' });
    fireEvent.change(within(dialog).getByLabelText('Kata sandi'), { target: { value: 'kata-sandi-ani' } });
    fireEvent.click(within(dialog).getByRole('button', { name: 'Konfirmasi' }));
    await screen.findByRole('heading', { name: 'Laporan migrasi' });

    expect(uploads(requests)).toEqual(['slims.dump', 'slims.files']);
    const [dry, ...real] = starts(requests);
    expect(dry).toEqual({
      source: { kind: 'dump', uploadId: DUMP_UPLOAD },
      filesUploadId: FILES_UPLOAD,
      branchId: BRANCH_NORTH.id,
      priceMode: 'minor',
      sourceName: 'kampus',
      allowNonEmpty: false,
      dryRun: true,
    });
    // Sent once, then again after the password confirmation: the dry run's options, its work taken over.
    const expected = { fromRunId: DRY_ID, branchId: BRANCH_NORTH.id, priceMode: 'minor', sourceName: 'kampus', allowNonEmpty: false, dryRun: false };
    expect(real).toEqual([expected, expected]);
  });

  it('after a database dry run, the real run asks the password again and posts the source with it', async () => {
    const { requests } = startApp({ me: superMe(), path: '/admin/catalog/migration', routes: migrationRoutes() });
    await dbSource();
    fireEvent.click(screen.getByRole('button', { name: 'Mulai uji kering' }));
    await screen.findByRole('heading', { name: 'Laporan uji kering' });
    expect(starts(requests)).toEqual([
      {
        source: { kind: 'db', host: 'db.perpus.local', port: 3306, user: 'slims_ro', password: 'rahasia-lama', database: 'slims', tls: false },
        branchId: BRANCH_MAIN.id,
        priceMode: 'major',
        sourceName: 'slims',
        allowNonEmpty: false,
        dryRun: true,
      },
    ]);
    expect(uploads(requests)).toEqual([]);

    // The password is never kept past the dry run's start: it is asked again.
    const password = screen.getByLabelText('Kata sandi basis data') as HTMLInputElement;
    expect(password.value).toBe('');
    fireEvent.click(screen.getByRole('button', { name: 'Jalankan migrasi' }));
    expect(await screen.findByText('Masukkan lagi kata sandi basis data SLiMS.')).toBeTruthy();
    expect(starts(requests)).toHaveLength(1);
    fireEvent.change(password, { target: { value: 'rahasia-baru' } });
    fireEvent.click(screen.getByRole('button', { name: 'Jalankan migrasi' }));
    await screen.findByRole('heading', { name: 'Laporan migrasi' });
    expect(starts(requests)[1]).toEqual({
      fromRunId: DRY_ID,
      source: { kind: 'db', host: 'db.perpus.local', port: 3306, user: 'slims_ro', password: 'rahasia-baru', database: 'slims', tls: false },
      branchId: BRANCH_MAIN.id,
      priceMode: 'major',
      sourceName: 'slims',
      allowNonEmpty: false,
      dryRun: false,
    });
  });

  it('a database user without a password: the real run sends an empty password once that is ticked', async () => {
    const dbRun = run({
      id: DRY_ID,
      options: { ...run({ id: DRY_ID }).options, sourceKind: 'db', db: { host: '127.0.0.1', port: 3306, user: 'root', database: 'slims', tls: false }, files: null },
    });
    const { requests } = startApp({ me: superMe(), path: `/admin/catalog/migration?run=${DRY_ID}`, routes: migrationRoutes({ runs: [dbRun] }) });
    fireEvent.click(await screen.findByRole('button', { name: 'Jalankan migrasi' }, FIRST));
    expect(await screen.findByText('Masukkan lagi kata sandi basis data SLiMS.')).toBeTruthy();
    fireEvent.click(screen.getByLabelText('Pengguna basis data ini tidak memakai kata sandi'));
    fireEvent.click(screen.getByRole('button', { name: 'Jalankan migrasi' }));
    await screen.findByRole('heading', { name: 'Laporan migrasi' });
    expect(starts(requests)).toEqual([
      {
        fromRunId: DRY_ID,
        source: { kind: 'db', host: '127.0.0.1', port: 3306, user: 'root', password: '', database: 'slims', tls: false },
        branchId: BRANCH_MAIN.id,
        priceMode: 'major',
        sourceName: 'slims',
        allowNonEmpty: false,
        dryRun: false,
      },
    ]);
  });

  it('a dry run taken over already links its migration; one 8 days old or of another user offers no run', async () => {
    const adopted = run({ id: DRY_ID, options: { ...run({ id: DRY_ID }).options, adoptedBy: REAL_ID } });
    const real = run({ id: REAL_ID, jobId: REAL_JOB, dryRun: false });
    startApp({ me: superMe(), path: `/admin/catalog/migration?run=${DRY_ID}`, routes: migrationRoutes({ runs: [adopted, real] }) });
    expect(await screen.findByText('Uji kering ini sudah dipakai untuk migrasi.', undefined, FIRST)).toBeTruthy();
    expect(screen.queryByRole('button', { name: 'Jalankan migrasi' })).toBeNull();
    fireEvent.click(screen.getByRole('button', { name: 'Lihat migrasinya' }));
    await screen.findByRole('heading', { name: 'Laporan migrasi' });
  });

  it.each([
    ['8 days old', { finishedAt: Date.now() - 8 * 24 * 60 * 60 * 1000 }, /lebih dari 7 hari, jadi tidak bisa dipakai/],
    ['of another user', { createdBy: 'U9' }, /dimulai oleh pengguna lain/],
  ])('a dry run %s offers no run', async (_, o, text) => {
    startApp({ me: superMe(), path: `/admin/catalog/migration?run=${DRY_ID}`, routes: migrationRoutes({ runs: [run({ id: DRY_ID, ...o })] }) });
    expect(await screen.findByText(text, undefined, FIRST)).toBeTruthy();
    expect(screen.queryByRole('button', { name: 'Jalankan migrasi' })).toBeNull();
  });

  it('"Uji koneksi" shows the version and the tables the source has, and a failure with its reason', async () => {
    let answer: SlimsTestResponse = { ok: true, version: '9', tables: [{ name: 'biblio', rows: 300 }, { name: 'item', rows: -1 }], missing: ['mst_voc_ctrl'] };
    const { requests } = startApp({
      me: superMe(),
      path: '/admin/catalog/migration',
      routes: { ...migrationRoutes(), 'POST catalog/migrations/slims/test-connection': () => answer },
    });
    fireEvent.click(await screen.findByLabelText('Basis data SLiMS (koneksi langsung)', undefined, FIRST));
    fireEvent.click(screen.getByRole('button', { name: 'Uji koneksi' }));
    expect(await screen.findAllByText('Wajib diisi.')).not.toHaveLength(0);
    expect(requests.filter((r) => r.path.endsWith('test-connection'))).toEqual([]);

    type('Host', 'db.perpus.local');
    type('Pengguna basis data', 'slims_ro');
    type('Kata sandi basis data', 'rahasia');
    type('Nama basis data', 'slims');
    fireEvent.click(screen.getByRole('button', { name: 'Uji koneksi' }));
    expect(await screen.findByText(/Terhubung: SLiMS 9/)).toBeTruthy();
    const tables = screen.getByRole('table', { name: 'Tabel yang dibaca migrasi' });
    expect(within(tables).getByText('300')).toBeTruthy();
    expect(within(tables).getByText('tidak diketahui')).toBeTruthy();
    expect(screen.getByText(/mst_voc_ctrl/)).toBeTruthy();
    expect(requests.filter((r) => r.path.endsWith('test-connection')).map((r) => r.body)).toEqual([
      { source: { kind: 'db', host: 'db.perpus.local', port: 3306, user: 'slims_ro', password: 'rahasia', database: 'slims', tls: false } },
    ]);

    answer = { ok: false, code: 'MIGRATION_SOURCE_UNREACHABLE', reason: 'ECONNREFUSED' };
    fireEvent.click(screen.getByRole('button', { name: 'Uji koneksi' }));
    expect(await screen.findByText(/ECONNREFUSED/)).toBeTruthy();
  });

  it('follows a migration that is still running when the screen opens, and shows its report once it ended', async () => {
    let polls = 0;
    const live = run({ id: REAL_ID, jobId: REAL_JOB, dryRun: false, status: 'running', summary: summary({ stage: 'items', reconciliation: null }), finishedAt: null });
    startApp({
      me: superMe(),
      path: '/admin/catalog/migration',
      routes: {
        ...migrationRoutes({ runs: [live] }),
        'GET catalog/runs/:id': () => (polls++ === 0 ? live : { ...live, status: 'succeeded', summary: summary({ warnings: [] }), finishedAt: AT + 120_000 }),
        'GET jobs/:id': () => job(REAL_JOB),
      },
    });
    expect(await screen.findByText(/Migrasi sedang berjalan/, undefined, FIRST)).toBeTruthy();
    expect(screen.queryByRole('button', { name: 'Lanjut' })).toBeNull();
    await screen.findByRole('heading', { name: 'Laporan migrasi' });
  });

  it('C17: a run still running whose job ended (cancelled while queued) is not followed: the wizard opens, and the run shows no progress', async () => {
    const left = run({ id: REAL_ID, jobId: REAL_JOB, dryRun: false, status: 'running', jobStatus: 'cancelled', summary: summary({ stage: 'items', reconciliation: null }), finishedAt: null });
    startApp({ me: superMe(), path: '/admin/catalog/migration', routes: { ...migrationRoutes({ runs: [left] }), 'GET jobs/:id': () => job(REAL_JOB, { status: 'cancelled' }) } });
    expect(await screen.findByLabelText('Berkas dump SQL', undefined, FIRST)).toBeTruthy();
    expect(screen.queryByText(/Migrasi sedang berjalan/)).toBeNull();
    // Opened from the history: no live progress, the button for a new migration instead.
    expect(screen.getByRole('row', { name: /Migrasi/ }).textContent).toContain('Dibatalkan');
    fireEvent.click(await screen.findByRole('button', { name: 'Lihat' }));
    expect(await screen.findByRole('button', { name: 'Mulai migrasi baru' })).toBeTruthy();
    expect(screen.queryByText(/Migrasi sedang berjalan/)).toBeNull();
    // It shows the end its job gave it, not "Berjalan".
    expect(screen.getByText('Proses ini dibatalkan.')).toBeTruthy();
    expect(screen.queryByText('Berjalan')).toBeNull();
  });

  it('an admin without catalog.migration.run is told so, and nothing is asked', async () => {
    const { requests } = startApp({ me: adminMe(), path: '/admin/catalog/migration', routes: migrationRoutes() });
    expect(await screen.findByText('Anda tidak memiliki izin untuk melakukan ini.', undefined, FIRST)).toBeTruthy();
    expect(requests.filter((r) => r.path.startsWith('catalog/') || r.path === 'branches')).toEqual([]);
  });
});
