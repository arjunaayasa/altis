import type { BranchListResponse } from '@altis/shared/api/branches';
import { SlimsStartBody, type MigrationReconcileRow, type MigrationSummary } from '@altis/shared/api/catalog/migration';
import type { RunListResponse, RunView } from '@altis/shared/api/catalog/runs';
import { fireEvent, screen, waitFor, within } from '@testing-library/react';
import { afterEach, describe, expect, it, vi } from 'vitest';
import { BRANCH_MAIN, BRANCH_NORTH, problem, startApp, superMe, type FakeHandler, type FakeRequest } from '../fake-api';

// The SLiMS catalogue re-sync in the migration wizard: the options step offers the catalogue mode, "Tambah baris baru
// saja" (the earlier behaviour, whose sentence says a re-run only adds new rows) or "Selaraskan dengan SLiMS" (rows no
// one edited in ALTIS follow SLiMS again; rows edited in ALTIS are skipped and reported), which the dry run start
// sends as `catalogMode: 'sync'`. Under a dry run, "Lewati tahap katalog" can be ticked only when that dry run was a
// sync that found no catalogue change; the real run then sends `skipCatalog: true` with the dry run's mode, and a 422
// MIGRATION_PRECHECK_FAILED `catalog_changed` is answered with the advice to run a sync. The report names why a table
// is not read: a later module's table (with the hint about the separate aggregate import), or a derived table; a
// stored summary without that reason keeps the earlier label.

const ME = superMe();
/** An hour ago: a dry run can be taken over for 7 days after it ended. */
const AT = Date.now() - 3_600_000;
const DRY_ID = '01JZ0000000000000000RN0001';
const REAL_ID = '01JZ0000000000000000RN0002';
const DRY_JOB = '01JZ0000000000000000JB0001';
const REAL_JOB = '01JZ0000000000000000JB0002';
const DUMP_UPLOAD = '01JZ0000000000000000DP0001';
const FIRST = { timeout: 10_000 };

// Branch ids that are ULIDs, so the bodies the screen posts pass the strict start schema.
const MAIN = { ...BRANCH_MAIN, id: '01JZ0000000000000000BR0001', active: true };
const NORTH = { ...BRANCH_NORTH, id: '01JZ0000000000000000BR0002', active: true };
const BRANCHES: BranchListResponse = { items: [MAIN, NORTH] };

const ADD_ONLY_SENTENCE = /hanya menambah baris baru/;
const SYNC_TEXT = /belum disunting di ALTIS ditulis ulang mengikuti SLiMS/;

function reconRow(table: string, o: Partial<MigrationReconcileRow> = {}): MigrationReconcileRow {
  return { table, source: 10, migrated: 10, merged: 0, skipped: 0, archived: 0, unread: false, diff: 0, ...o };
}

function summary(o: Partial<MigrationSummary> = {}): MigrationSummary {
  return {
    version: '9',
    stage: 'report',
    tables: {},
    unread: [],
    reconciliation: { ok: true, tables: [reconRow('biblio'), reconRow('item')] },
    fixes: {},
    samples: [],
    charset: [],
    targets: [],
    checks: [],
    missingFiles: 0,
    nonstandardBarcodes: 0,
    warnings: [],
    ...o,
  };
}

function dryRun(o: { catalogMode?: 'append' | 'sync'; skipCatalog?: boolean; summary?: MigrationSummary } = {}): RunView {
  return {
    id: DRY_ID,
    kind: 'migration',
    status: 'succeeded',
    dryRun: true,
    format: null,
    options: {
      sourceKind: 'dump',
      db: null,
      branchId: MAIN.id,
      priceMode: 'major',
      sourceName: 'slims',
      allowNonEmpty: false,
      dumpStagingId: DUMP_UPLOAD,
      files: null,
      filesStagingId: null,
      filesDir: null,
      adoptedFrom: null,
      ...(o.catalogMode === undefined ? {} : { catalogMode: o.catalogMode }),
      ...(o.skipCatalog === undefined ? {} : { skipCatalog: o.skipCatalog }),
    },
    summary: (o.summary ?? summary()) as unknown as Record<string, unknown>,
    reportFileId: null,
    outputName: null,
    outputSize: null,
    expiresAt: null,
    jobId: DRY_JOB,
    createdAt: AT,
    createdBy: ME.user.id,
    finishedAt: AT + 60_000,
  };
}

/** The migration screen's reads, and a start that makes the next run (which ends at once). */
function routes(o: { runs?: RunView[]; start?: FakeHandler } = {}): Record<string, FakeHandler> {
  const runs = new Map<string, RunView>((o.runs ?? []).map((r) => [r.id, r]));
  return {
    'GET branches': () => BRANCHES,
    'GET catalog/runs': (): RunListResponse => ({ items: [...(o.runs ?? [])], nextCursor: null }),
    'GET catalog/runs/:id': (req) => runs.get(req.params['id']!) ?? problem(404, 'NOT_FOUND'),
    'POST catalog/migrations/slims':
      o.start ??
      ((req) => {
        const body = req.body as { dryRun: boolean };
        const id = body.dryRun ? DRY_ID : REAL_ID;
        runs.set(id, { ...dryRun(), id, dryRun: body.dryRun, jobId: body.dryRun ? DRY_JOB : REAL_JOB });
        return new Response(JSON.stringify({ runId: id, jobId: body.dryRun ? DRY_JOB : REAL_JOB }), { status: 201, headers: { 'Content-Type': 'application/json' } });
      }),
    'POST files/uploads': () => ({ id: DUMP_UPLOAD, chunkSize: 256 * 1024, chunks: 1, expiresAt: AT + 86_400_000 }),
    'POST files/uploads/:id/chunks/:n': () => ({ received: 10, complete: true }),
    'POST files/uploads/:id/complete': (req) => ({ uploadId: req.params['id'], size: 10, sha256: 'a'.repeat(64), mime: 'text/plain' }),
  };
}

const starts = (requests: FakeRequest[]): unknown[] => requests.filter((r) => r.method === 'POST' && r.path === 'catalog/migrations/slims').map((r) => r.body);

/** Opens the wizard, fills the dump source and goes on to the options (the default branch chosen). */
async function toOptions(): Promise<void> {
  fireEvent.click(await screen.findByLabelText('Berkas dump SQL', undefined, FIRST));
  fireEvent.change(screen.getByLabelText(/Berkas dump \(/), { target: { files: [new File(['INSERT INTO biblio VALUES (1);'], 'slims.sql')] } });
  fireEvent.click(screen.getByRole('button', { name: 'Lanjut' }));
  const branch = (await screen.findByLabelText('Cabang tujuan')) as HTMLSelectElement;
  await waitFor(() => expect(branch.value).toBe(MAIN.id));
}

/** The real run panel under the dry run `run`. */
async function realPanel(run: RunView, extra: Record<string, FakeHandler> = {}) {
  const app = startApp({ me: ME, path: `/admin/catalog/migration?run=${DRY_ID}`, routes: { ...routes({ runs: [run] }), ...extra } });
  const heading = await screen.findByRole('heading', { name: 'Jalankan migrasi' }, FIRST);
  return { ...app, panel: heading.closest('section') as HTMLElement };
}

afterEach(() => {
  vi.unstubAllGlobals();
  vi.restoreAllMocks();
});

describe('Migrasi SLiMS: the catalogue mode', () => {
  it('"Selaraskan dengan SLiMS" replaces the add-only sentence by the re-sync text, and the dry run sends catalogMode sync', async () => {
    const { requests } = startApp({ me: ME, path: '/admin/catalog/migration', routes: routes() });
    await toOptions();
    const append = screen.getByRole('radio', { name: 'Tambah baris baru saja' }) as HTMLInputElement;
    expect(append.checked).toBe(true);
    expect(screen.getByText(ADD_ONLY_SENTENCE)).toBeTruthy();
    expect(screen.queryByText(SYNC_TEXT)).toBeNull();

    fireEvent.click(screen.getByRole('radio', { name: 'Selaraskan dengan SLiMS' }));
    const text = screen.getByText(SYNC_TEXT);
    expect(text.textContent).toMatch(/sudah disunting di ALTIS dilewati dan dicantumkan di laporan/);
    expect(screen.queryByText(ADD_ONLY_SENTENCE)).toBeNull();

    fireEvent.click(screen.getByRole('button', { name: 'Mulai uji kering' }));
    await waitFor(() => expect(starts(requests)).toHaveLength(1));
    const body = starts(requests)[0] as Record<string, unknown>;
    expect(body).toMatchObject({ dryRun: true, catalogMode: 'sync', source: { kind: 'dump', uploadId: DUMP_UPLOAD } });
    expect(body).not.toHaveProperty('skipCatalog');
    expect(SlimsStartBody.safeParse(body).success).toBe(true);
  });

  it('?catalogMode=sync (the link of the accreditation workspace) opens the wizard with the re-sync chosen', async () => {
    startApp({ me: ME, path: '/admin/catalog/migration?catalogMode=sync', routes: routes() });
    await toOptions();
    expect((screen.getByRole('radio', { name: 'Selaraskan dengan SLiMS' }) as HTMLInputElement).checked).toBe(true);
    expect(screen.getByText(SYNC_TEXT)).toBeTruthy();
  });

  it('an add-only dry run starts without catalogMode, as before', async () => {
    const { requests } = startApp({ me: ME, path: '/admin/catalog/migration', routes: routes() });
    await toOptions();
    fireEvent.click(screen.getByRole('button', { name: 'Mulai uji kering' }));
    await waitFor(() => expect(starts(requests)).toHaveLength(1));
    expect(starts(requests)[0]).not.toHaveProperty('catalogMode');
  });
});

describe('Migrasi SLiMS: skipping the catalogue after a sync dry run', () => {
  it('a sync dry run that found no catalogue change lets the real run skip the catalogue (sent with the dry run’s mode)', async () => {
    const { requests, panel } = await realPanel(dryRun({ catalogMode: 'sync', summary: summary({ catalogChanges: 0 }) }));
    expect(within(panel).getByText(SYNC_TEXT)).toBeTruthy();
    expect(within(panel).queryByText(ADD_ONLY_SENTENCE)).toBeNull();
    expect(screen.getByText('Cantuman dan eksemplar SLiMS yang baru, berubah, atau hilang: 0')).toBeTruthy();
    const skip = within(panel).getByRole('checkbox', { name: 'Lewati tahap katalog' }) as HTMLInputElement;
    expect(skip.disabled).toBe(false);
    expect(skip.checked).toBe(false);
    fireEvent.click(skip);
    fireEvent.click(within(panel).getByRole('button', { name: 'Jalankan migrasi' }));
    await waitFor(() => expect(starts(requests)).toHaveLength(1));
    const body = starts(requests)[0];
    expect(body).toEqual({
      fromRunId: DRY_ID,
      branchId: MAIN.id,
      priceMode: 'major',
      sourceName: 'slims',
      allowNonEmpty: false,
      dryRun: false,
      catalogMode: 'sync',
      skipCatalog: true,
    });
    expect(SlimsStartBody.safeParse(body).success).toBe(true);
  });

  it('a sync dry run whose real run goes through the catalogue sends catalogMode sync without skipCatalog', async () => {
    const { requests, panel } = await realPanel(dryRun({ catalogMode: 'sync', summary: summary({ catalogChanges: 12 }) }));
    fireEvent.click(within(panel).getByRole('button', { name: 'Jalankan migrasi' }));
    await waitFor(() => expect(starts(requests)).toHaveLength(1));
    expect(starts(requests)[0]).toMatchObject({ fromRunId: DRY_ID, catalogMode: 'sync', dryRun: false });
    expect(starts(requests)[0]).not.toHaveProperty('skipCatalog');
  });

  it.each([
    ['a sync dry run that found catalogue changes', dryRun({ catalogMode: 'sync', summary: summary({ catalogChanges: 4 }) })],
    ['a sync dry run whose summary counts no catalogue changes', dryRun({ catalogMode: 'sync' })],
    ['an add-only dry run', dryRun({ summary: summary({ catalogChanges: 0 }) })],
  ])('"Lewati tahap katalog" stays disabled after %s', async (_, run) => {
    const { panel } = await realPanel(run);
    const skip = within(panel).getByRole('checkbox', { name: 'Lewati tahap katalog' }) as HTMLInputElement;
    expect(skip.disabled).toBe(true);
    expect(within(panel).getByText(/Hanya dapat dipilih setelah uji kering dengan mode Selaraskan dengan SLiMS/)).toBeTruthy();
  });

  it('an add-only dry run keeps the add-only sentence in the real run panel', async () => {
    const { panel } = await realPanel(dryRun());
    expect(within(panel).getByText(ADD_ONLY_SENTENCE)).toBeTruthy();
    expect(within(panel).queryByText(SYNC_TEXT)).toBeNull();
  });

  it('a 422 MIGRATION_PRECHECK_FAILED catalog_changed suggests running a sync', async () => {
    const { panel } = await realPanel(dryRun({ catalogMode: 'sync', summary: summary({ catalogChanges: 0 }) }), {
      'POST catalog/migrations/slims': () => problem(422, 'MIGRATION_PRECHECK_FAILED', { reason: 'catalog_changed', detail: 'catalog_changed' }),
    });
    fireEvent.click(within(panel).getByRole('checkbox', { name: 'Lewati tahap katalog' }));
    fireEvent.click(within(panel).getByRole('button', { name: 'Jalankan migrasi' }));
    const message = await within(panel).findByText(/^Uji kering menemukan cantuman atau eksemplar SLiMS yang baru, berubah, atau hilang/);
    expect(message.textContent).toMatch(/mode katalog Selaraskan dengan SLiMS/);
  });
});

describe('Migrasi SLiMS: the report names why a table is not read', () => {
  it('a later module’s table, a derived table, and a stored row without a reason', async () => {
    const run = dryRun({
      summary: summary({
        reconciliation: {
          ok: true,
          tables: [
            reconRow('biblio'),
            reconRow('member', { unread: true, unreadKind: 'phase3', migrated: 0 }),
            reconRow('search_biblio', { unread: true, unreadKind: 'derived', migrated: 0 }),
            reconRow('plugin_kiriman', { unread: true, migrated: 0 }),
          ],
        },
      }),
    });
    startApp({ me: ME, path: `/admin/catalog/migration?run=${DRY_ID}`, routes: routes({ runs: [run] }) });
    const rowOf = async (table: string): Promise<HTMLElement> => (await screen.findByRole('rowheader', { name: table }, FIRST)).closest('tr') as HTMLElement;

    const member = await rowOf('member');
    expect(within(member).getByText('Tidak dibaca: modul Anggota/Sirkulasi')).toBeTruthy();
    expect(within(member).getByText('Impor agregat terpisah membaca sebagian kolom tanpa memigrasi.')).toBeTruthy();
    expect(member.getAttribute('data-reconcile')).toBe('unread');

    const derived = await rowOf('search_biblio');
    expect(within(derived).getByText('Tidak dibaca: tabel turunan')).toBeTruthy();
    expect(within(derived).queryByText(/Impor agregat/)).toBeNull();

    const stored = await rowOf('plugin_kiriman');
    expect(within(stored).getByText('Tidak dibaca (belum didukung)')).toBeTruthy();
    expect(within(stored).queryByText(/modul Anggota/)).toBeNull();
  });
});
