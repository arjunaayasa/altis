import type { Permission } from '@altis/shared';
import type { RecordDetail } from '@altis/shared/api/catalog/records';
import type { DedupeScanSummary, RunView } from '@altis/shared/api/catalog/runs';
import type { JobView } from '@altis/shared/api/jobs';
import { fireEvent, screen, waitFor, within } from '@testing-library/react';
import { afterEach, describe, expect, it, vi } from 'vitest';
import { json, problem, signedIn, startApp, type FakeRequest } from '../fake-api';

// Duplikat (Phase 2 spec §3.3, §13; plan Task 29): start a scan (`POST catalog/dedupe-scans`) and follow its job, list
// the groups of the run summary's preview (the CSV report has them all), compare two records of a group side by side,
// and merge one into the other (`POST catalog/records/:id/merge {sourceId, version}`) after a confirmation.

const T0 = 1_760_000_000_000;
const SCAN = '01JZ0000000000000000000N05';
const OLD_SCAN = '01JZ0000000000000000000N04';
const MT_BOOK = '01JZ0000000000000000000B01';
const R1 = '01JZ0000000000000000000R01';
const R2 = '01JZ0000000000000000000R02';
const R3 = '01JZ0000000000000000000R03';
const R4 = '01JZ0000000000000000000R04';
const R5 = '01JZ0000000000000000000R05';

const SUMMARY: DedupeScanSummary = {
  groups: { isbn: 1, title_year: 1 },
  records: 5,
  preview: [
    { reason: 'isbn', recordIds: [R1, R2] },
    { reason: 'title_year', recordIds: [R3, R4, R5] },
  ],
};

function scanRun(o: Partial<RunView> & Pick<RunView, 'id'>): RunView {
  return {
    kind: 'dedupe_scan',
    status: 'succeeded',
    dryRun: false,
    format: null,
    options: {},
    summary: { ...SUMMARY },
    reportFileId: '01JZ0000000000000000000F05',
    outputName: null,
    outputSize: null,
    expiresAt: null,
    jobId: 'J7',
    createdAt: T0,
    createdBy: 'U1',
    finishedAt: T0 + 30_000,
    ...o,
  };
}

const job = (id: string): JobView => ({
  id,
  type: 'catalog.dedupe_scan',
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
});

function record(o: Partial<RecordDetail> & Pick<RecordDetail, 'id' | 'title'>): RecordDetail {
  return {
    version: 1,
    materialTypeId: MT_BOOK,
    languageId: null,
    source: null,
    custom: {},
    warnings: [],
    itemCounts: { total: 0, available: 0 },
    createdAt: T0,
    updatedAt: T0,
    changedAt: T0,
    opacVisible: true,
    promoted: false,
    archived: false,
    mergedInto: null,
    materialType: { id: MT_BOOK, code: 'BUKU', nameId: 'Buku', nameEn: 'Book', marcType: 'a', marcLevel: 'm', schemaType: 'Book', dcmiType: 'Text' },
    language: null,
    materialTypeCode: 'BUKU',
    publisher: null,
    identifiers: [],
    agents: [],
    subjects: [],
    links: [],
    items: [],
    marcExtra: [],
    coverFileId: null,
    attachments: [],
    relations: [],
    customPublic: [],
    ...o,
  };
}

const RECORDS: Record<string, RecordDetail> = {
  [R1]: record({
    id: R1,
    title: 'Laskar Pelangi',
    version: 3,
    publicationYear: '2005',
    identifiers: [{ type: 'isbn', value: '9789793062792' }],
    publisher: { id: '01JZ0000000000000000000P01', name: 'Bentang Pustaka', place: 'Yogyakarta' },
    itemCounts: { total: 4, available: 3 },
  }),
  [R2]: record({
    id: R2,
    title: 'Laskar pelangi',
    version: 8,
    publicationYear: '2008',
    identifiers: [{ type: 'isbn', value: '9789793062792' }],
    itemCounts: { total: 1, available: 1 },
  }),
  [R3]: record({ id: R3, title: 'Bumi Manusia', publicationYear: '1980' }),
  [R4]: record({ id: R4, title: 'Bumi manusia', publicationYear: '1980', archived: true, mergedInto: R3 }),
  [R5]: record({ id: R5, title: 'Bumi Manusia.', publicationYear: '1980', version: 2 }),
};

function start(o: { runs?: RunView[]; permissions?: readonly Permission[]; merge?: (req: FakeRequest) => unknown } = {}) {
  const runs = o.runs ?? [scanRun({ id: OLD_SCAN, finishedAt: T0 - 86_400_000 })];
  return startApp({
    me: signedIn({ permissions: o.permissions ?? ['catalog.records.read', 'catalog.records.manage'] }),
    path: '/admin/catalog/duplicates',
    routes: {
      'GET catalog/runs': () => ({ items: runs, nextCursor: null }),
      'POST catalog/dedupe-scans': () => json({ runId: SCAN, jobId: 'J7' }, 202),
      'GET jobs/:id': (req) => job(req.params['id']!),
      'GET catalog/runs/:id': (req) => (req.params['id'] === SCAN ? scanRun({ id: SCAN }) : (runs.find((r) => r.id === req.params['id']) ?? problem(404, 'NOT_FOUND'))),
      'GET catalog/records/:id': (req) => RECORDS[req.params['id']!] ?? problem(404, 'NOT_FOUND'),
      'POST catalog/records/:id/merge': o.merge ?? ((req) => ({ id: req.params['id'], version: 99 })),
    },
  });
}

const merges = (requests: FakeRequest[]) => requests.filter((r) => r.method === 'POST' && /^catalog\/records\/[^/]+\/merge$/.test(r.path)).map((r) => ({ path: r.path, body: r.body }));

afterEach(() => {
  vi.unstubAllGlobals();
  vi.restoreAllMocks();
});

describe('DuplicatesScreen', () => {
  it('starts a scan, follows its job, and lists the groups of its preview with the CSV link', async () => {
    const { requests } = start({ runs: [] });
    expect(await screen.findByText('Katalog belum pernah dipindai.')).toBeTruthy();
    expect(requests.find((r) => r.method === 'GET' && r.path === 'catalog/runs')?.query.toString()).toBe('kind=dedupe_scan&limit=1');
    fireEvent.click(screen.getByRole('button', { name: 'Pindai katalog' }));
    await waitFor(() => expect(requests.filter((r) => r.method === 'POST' && r.path === 'catalog/dedupe-scans').map((r) => r.body)).toEqual([{}]));

    const groups = await screen.findByRole('table', { name: 'Kelompok kemungkinan duplikat' });
    const rows = within(groups).getAllByRole('row').slice(1);
    expect(rows).toHaveLength(2);
    expect(within(rows[0]!).getByText('ISBN sama')).toBeTruthy();
    expect(within(rows[0]!).getByText('2')).toBeTruthy();
    expect(within(rows[1]!).getByText('Judul dan tahun sama')).toBeTruthy();
    expect(within(rows[1]!).getByText('3')).toBeTruthy();
    expect(screen.getByRole('link', { name: 'Unduh daftar lengkap (CSV)' }).getAttribute('href')).toBe(`/api/v1/catalog/runs/${SCAN}/report`);
    expect(screen.getByText(/1 kelompok ISBN sama, 1 kelompok judul dan tahun sama, 5 cantuman/)).toBeTruthy();
  });

  it('shows the last scan on opening; Compare shows two records side by side and the merge posts {sourceId, version}', async () => {
    const { requests } = start();
    const groups = await screen.findByRole('table', { name: 'Kelompok kemungkinan duplikat' });
    fireEvent.click(within(groups).getByRole('button', { name: 'Bandingkan kelompok 1' }));

    const compare = await screen.findByRole('table', { name: 'Perbandingan dua cantuman' });
    await waitFor(() => expect(within(compare).getByText('Laskar Pelangi')).toBeTruthy());
    expect(within(compare).getByText('Laskar pelangi')).toBeTruthy();
    expect(within(compare).getByText('2005')).toBeTruthy();
    expect(within(compare).getByText('2008')).toBeTruthy();
    expect(within(compare).getByText('Bentang Pustaka (Yogyakarta)')).toBeTruthy();
    // The rows that differ are marked.
    const yearRow = within(compare).getByText('2005').closest('tr')!;
    expect(yearRow.getAttribute('data-differs')).toBe('true');
    const isbnRow = within(compare).getAllByText('ISBN 9789793062792')[0]!.closest('tr')!;
    expect(isbnRow.getAttribute('data-differs')).toBe('false');

    fireEvent.click(screen.getByRole('button', { name: 'Gabungkan' }));
    const dialog = await screen.findByRole('alertdialog');
    expect(within(dialog).getByText(/tidak dapat dibatalkan/)).toBeTruthy();
    fireEvent.click(within(dialog).getByRole('button', { name: 'Gabungkan' }));
    await waitFor(() => expect(merges(requests)).toEqual([{ path: `catalog/records/${R1}/merge`, body: { sourceId: R2, version: 3 } }]));
    expect(await screen.findByText('“Laskar pelangi” sudah digabung ke “Laskar Pelangi”.')).toBeTruthy();
    // The group has one live record left.
    expect(await screen.findByText('Kelompok ini tinggal satu cantuman aktif.')).toBeTruthy();
  });

  it('"Tukar" merges the other way: the target is the other record, with its own version', async () => {
    const { requests } = start();
    const groups = await screen.findByRole('table', { name: 'Kelompok kemungkinan duplikat' });
    fireEvent.click(within(groups).getByRole('button', { name: 'Bandingkan kelompok 1' }));
    const compare = await screen.findByRole('table', { name: 'Perbandingan dua cantuman' });
    await waitFor(() => expect(within(compare).getByText('Laskar pelangi')).toBeTruthy());
    fireEvent.click(screen.getByRole('button', { name: 'Tukar' }));
    fireEvent.click(screen.getByRole('button', { name: 'Gabungkan' }));
    const dialog = await screen.findByRole('alertdialog');
    fireEvent.click(within(dialog).getByRole('button', { name: 'Gabungkan' }));
    await waitFor(() => expect(merges(requests)).toEqual([{ path: `catalog/records/${R2}/merge`, body: { sourceId: R1, version: 8 } }]));
  });

  it('a group of three offers its live records only; a merged record is shown but never offered', async () => {
    const { requests } = start();
    const groups = await screen.findByRole('table', { name: 'Kelompok kemungkinan duplikat' });
    fireEvent.click(within(groups).getByRole('button', { name: 'Bandingkan kelompok 2' }));
    const compare = await screen.findByRole('table', { name: 'Perbandingan dua cantuman' });
    await waitFor(() => expect(within(compare).getByText('Bumi Manusia.')).toBeTruthy());
    const target = screen.getByLabelText('Cantuman yang dipertahankan') as HTMLSelectElement;
    const source = screen.getByLabelText('Cantuman yang digabungkan') as HTMLSelectElement;
    expect([...target.options].map((option) => option.value)).toEqual([R3, R5]);
    expect([...source.options].map((option) => option.value)).toEqual([R3, R5]);
    expect(screen.getByText(/Bumi manusia.*sudah digabung/)).toBeTruthy();
    fireEvent.click(screen.getByRole('button', { name: 'Gabungkan' }));
    fireEvent.click(within(await screen.findByRole('alertdialog')).getByRole('button', { name: 'Gabungkan' }));
    await waitFor(() => expect(merges(requests)).toEqual([{ path: `catalog/records/${R3}/merge`, body: { sourceId: R5, version: 1 } }]));
  });

  it('a refused merge stays in the dialog with the reason', async () => {
    start({ merge: () => problem(409, 'CONFLICT_STALE') });
    const groups = await screen.findByRole('table', { name: 'Kelompok kemungkinan duplikat' });
    fireEvent.click(within(groups).getByRole('button', { name: 'Bandingkan kelompok 1' }));
    await screen.findByRole('table', { name: 'Perbandingan dua cantuman' });
    await screen.findAllByText('Laskar pelangi');
    fireEvent.click(screen.getByRole('button', { name: 'Gabungkan' }));
    const dialog = await screen.findByRole('alertdialog');
    fireEvent.click(within(dialog).getByRole('button', { name: 'Gabungkan' }));
    expect(await within(dialog).findByText('Data ini sudah diubah oleh orang lain. Muat ulang, lalu coba lagi.')).toBeTruthy();
  });

  it('without catalog.records.manage the screen says so and asks nothing', async () => {
    const { requests } = start({ permissions: ['catalog.records.read'] });
    expect(await screen.findByRole('heading', { name: 'Duplikat' })).toBeTruthy();
    expect(await screen.findByText('Anda tidak memiliki izin untuk melakukan ini.')).toBeTruthy();
    expect(screen.queryByRole('button', { name: 'Pindai katalog' })).toBeNull();
    expect(requests.filter((r) => r.path.startsWith('catalog/'))).toEqual([]);
  });
});
