import type { BranchListResponse } from '@altis/shared/api/branches';
import { SlimsStartBody, type MigrationSummary, type SlimsCutoverView } from '@altis/shared/api/catalog/migration';
import type { RunListResponse, RunView } from '@altis/shared/api/catalog/runs';
import { fireEvent, screen, waitFor, within } from '@testing-library/react';
import { afterEach, describe, expect, it, vi } from 'vitest';
import { BRANCH_MAIN, problem, startApp, superMe, type FakeHandler, type FakeRequest } from '../fake-api';

// Members, visits and circulation in the Migrasi SLiMS wizard: the options a dry run starts with (sent only where they
// differ from their defaults), the accreditation groups of the SLiMS member types a dry run listed (editable for the
// real run), "Cocokkan dengan SLiMS" in a real run's report, and the cut-over checklist that holds "Mulai melayani"
// back until every required item is done.

const ME = superMe();
const AT = Date.now() - 3_600_000;
const DRY_ID = '01JZ0000000000000000RN0001';
const REAL_ID = '01JZ0000000000000000RN0002';
const DUMP_UPLOAD = '01JZ0000000000000000DP0001';
const FIRST = { timeout: 10_000 };
const MAIN = { ...BRANCH_MAIN, id: '01JZ0000000000000000BR0001', active: true };
const BRANCHES: BranchListResponse = { items: [MAIN] };

function summary(o: Partial<MigrationSummary> = {}): MigrationSummary {
  return {
    version: '9',
    stage: 'report',
    tables: {},
    unread: [],
    reconciliation: { ok: true, tables: [] },
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

function run(o: { id?: string; dryRun?: boolean; summary?: MigrationSummary } = {}): RunView {
  return {
    id: o.id ?? DRY_ID,
    kind: 'migration',
    status: 'succeeded',
    dryRun: o.dryRun ?? true,
    format: null,
    options: { sourceKind: 'dump', db: null, branchId: MAIN.id, priceMode: 'major', sourceName: 'slims', allowNonEmpty: false, dumpStagingId: DUMP_UPLOAD, files: null, filesStagingId: null, filesDir: null, adoptedFrom: null },
    summary: (o.summary ?? summary()) as unknown as Record<string, unknown>,
    reportFileId: null,
    outputName: null,
    outputSize: null,
    expiresAt: null,
    jobId: null,
    createdAt: AT,
    createdBy: ME.user.id,
    finishedAt: AT + 60_000,
  };
}

function cutover(o: Partial<SlimsCutoverView> = {}): SlimsCutoverView {
  return {
    runId: REAL_ID,
    finishedAt: AT,
    deskStaff: 0,
    rooms: 1,
    roomsWithStation: 0,
    reprintOpenedAt: null,
    reconciled: true,
    stocktakeAvailable: false,
    ready: false,
    servingSince: null,
    circulationLive: false,
    ...o,
  };
}

function routes(o: { runs?: RunView[]; cutover?: () => SlimsCutoverView; step?: FakeHandler } = {}): Record<string, FakeHandler> {
  const runs = new Map<string, RunView>((o.runs ?? []).map((r) => [r.id, r]));
  return {
    'GET branches': () => BRANCHES,
    'GET members/types': () => ({ items: [] }),
    'GET catalog/runs': (): RunListResponse => ({ items: [...(o.runs ?? [])], nextCursor: null }),
    'GET catalog/runs/:id': (req) => runs.get(req.params['id']!) ?? problem(404, 'NOT_FOUND'),
    'GET catalog/migrations/slims/cutover': () => (o.cutover ?? (() => cutover({ runId: null })))(),
    'POST catalog/migrations/slims/cutover/steps': o.step ?? (() => cutover()),
    'POST catalog/migrations/slims': (req) => {
      const body = req.body as { dryRun: boolean };
      const id = body.dryRun ? DRY_ID : REAL_ID;
      runs.set(id, { ...run(), id, dryRun: body.dryRun });
      return new Response(JSON.stringify({ runId: id, jobId: '01JZ0000000000000000JB0001' }), { status: 201, headers: { 'Content-Type': 'application/json' } });
    },
    'POST files/uploads': () => ({ id: DUMP_UPLOAD, chunkSize: 256 * 1024, chunks: 1, expiresAt: AT + 86_400_000 }),
    'POST files/uploads/:id/chunks/:n': () => ({ received: 10, complete: true }),
    'POST files/uploads/:id/complete': (req) => ({ uploadId: req.params['id'], size: 10, sha256: 'a'.repeat(64), mime: 'text/plain' }),
  };
}

const starts = (requests: FakeRequest[]): Record<string, unknown>[] =>
  requests.filter((r) => r.method === 'POST' && r.path === 'catalog/migrations/slims').map((r) => r.body as Record<string, unknown>);

afterEach(() => {
  vi.unstubAllGlobals();
  vi.restoreAllMocks();
});

describe('Migrasi SLiMS: members, visits and circulation', () => {
  it('the dry run sends the member, visit and circulation options that differ from their defaults', async () => {
    const { requests } = startApp({ me: ME, path: '/admin/catalog/migration', routes: routes() });
    fireEvent.click(await screen.findByLabelText('Berkas dump SQL', undefined, FIRST));
    fireEvent.change(screen.getByLabelText(/Berkas dump \(/), { target: { files: [new File(['x'], 'slims.sql')] } });
    fireEvent.click(screen.getByRole('button', { name: 'Lanjut' }));
    const branch = (await screen.findByLabelText('Cabang tujuan')) as HTMLSelectElement;
    await waitFor(() => expect(branch.value).toBe(MAIN.id));
    fireEvent.click(screen.getByRole('radio', { name: 'Selaraskan anggota dengan SLiMS' }));
    fireEvent.click(screen.getByRole('radio', { name: 'Ganti sirkulasi hasil migrasi (hari pindah)' }));
    fireEvent.click(screen.getByRole('checkbox', { name: /Pindahkan akun petugas SLiMS/ }));
    fireEvent.click(screen.getByRole('button', { name: 'Mulai uji kering' }));
    await waitFor(() => expect(starts(requests)).toHaveLength(1));
    const body = starts(requests)[0]!;
    expect(body['people']).toEqual({ membersMode: 'update', circulationMode: 'replace', staffUsers: false });
    expect(SlimsStartBody.safeParse(body).success).toBe(true);
  });

  it('the real run shows the SLiMS member types with their guessed groups; a group changed is sent', async () => {
    const dry = run({ summary: summary({ memberTypes: [{ id: '1', name: 'Siswa', members: 120, group: 'student' }, { id: '7', name: 'Alumni', members: 4, group: 'public' }] }) });
    const { requests } = startApp({ me: ME, path: `/admin/catalog/migration?run=${DRY_ID}`, routes: routes({ runs: [dry] }) });
    const heading = await screen.findByRole('heading', { name: 'Jalankan migrasi' }, FIRST);
    const panel = heading.closest('section') as HTMLElement;
    const siswa = within(panel).getByLabelText('Kelompok tipe Siswa') as HTMLSelectElement;
    expect(siswa.value).toBe('student');
    fireEvent.change(within(panel).getByLabelText('Kelompok tipe Alumni'), { target: { value: 'other' } });
    fireEvent.click(within(panel).getByRole('button', { name: 'Jalankan migrasi' }));
    await waitFor(() => expect(starts(requests)).toHaveLength(1));
    expect(starts(requests)[0]!['people']).toEqual({ memberTypeGroups: { '7': 'other' } });
  });

  it('a real run\'s report lists "Cocokkan dengan SLiMS" with each number and whether it matches', async () => {
    const real = run({
      id: REAL_ID,
      dryRun: false,
      summary: summary({
        matches: [
          { key: 'open_loans', scope: '', source: 5, altis: 3, explained: 2, ok: true },
          { key: 'open_loans_item_missing', scope: '', source: 1, altis: 0, explained: 0, ok: false },
        ],
      }),
    });
    startApp({ me: ME, path: `/admin/catalog/migration?run=${REAL_ID}`, routes: routes({ runs: [real] }) });
    const title = await screen.findByRole('heading', { name: 'Cocokkan dengan SLiMS' }, FIRST);
    const section = title.closest('section') as HTMLElement;
    const rows = within(section).getAllByRole('row');
    expect(rows.map((r) => r.getAttribute('data-match')).filter((x) => x !== null)).toEqual(['ok', 'diff']);
    expect(within(section).getByText('Pinjaman terbuka yang eksemplarnya tidak ada di ALTIS')).toBeTruthy();
  });

  it('a dry run\'s report lists what to check before the real run, each with its count and samples, and asks for a catalogue re-sync when copies will be missing', async () => {
    const dry = run({
      id: DRY_ID,
      dryRun: true,
      summary: summary({
        dryLists: [
          { key: 'loan_terms_differ', count: 2, samples: ['M003 · B002', 'M003 · B005'] },
          { key: 'type_limit_changes', count: 1, samples: ['1 Siswa'] },
          { key: 'members_over_limit', count: 0, samples: [] },
          { key: 'all_rule_unused', count: 1, samples: ['1'] },
          { key: 'open_loan_item_missing', count: 3, samples: ['M001 · B009'] },
        ],
      }),
    });
    startApp({ me: ME, path: `/admin/catalog/migration?run=${DRY_ID}`, routes: routes({ runs: [dry] }) });
    const title = await screen.findByRole('heading', { name: 'Periksa sebelum run nyata' }, FIRST);
    const section = title.closest('section') as HTMLElement;
    const rows = within(section).getAllByRole('row').filter((r) => r.getAttribute('data-dry-list') !== null);
    expect(rows.map((r) => r.getAttribute('data-dry-list'))).toEqual(['loan_terms_differ', 'type_limit_changes', 'members_over_limit', 'all_rule_unused', 'open_loan_item_missing']);
    expect(within(rows[0]!).getByText('M003 · B002, M003 · B005')).toBeTruthy();
    expect(within(rows[0]!).getByText('Pinjaman terbuka yang jatuh tempo atau dendanya akan berbeda menurut aturan ALTIS')).toBeTruthy();
    expect(within(section).getByText(/jalankan dengan mode katalog Selaraskan/)).toBeTruthy();
  });

  it('the cut-over checklist holds "Mulai melayani" back; opening the reprint list marks its item, and a ready checklist serves', async () => {
    let state = cutover({ deskStaff: 1, rooms: 1, roomsWithStation: 1 });
    const steps: string[] = [];
    const { requests } = startApp({
      me: ME,
      path: '/admin/catalog/migration',
      routes: routes({
        cutover: () => state,
        step: (req) => {
          const step = (req.body as { step: string }).step;
          steps.push(step);
          state = step === 'serve' ? { ...state, servingSince: AT } : { ...state, reprintOpenedAt: AT, ready: true };
          return state;
        },
      }),
    });
    const title = await screen.findByRole('heading', { name: 'Pindah dari SLiMS' }, FIRST);
    const section = title.closest('section') as HTMLElement;
    expect(within(section).getByText(/Inventarisasi \(stock opname\) belum ada/)).toBeTruthy();
    const serve = within(section).getByRole('button', { name: 'Mulai melayani' }) as HTMLButtonElement;
    expect(serve.disabled).toBe(true);
    fireEvent.click(within(section).getByRole('button', { name: 'Buka daftar' }));
    await waitFor(() => expect(steps).toEqual(['reprint_opened']));
    expect(requests.some((r) => r.method === 'POST' && r.path === 'catalog/migrations/slims/cutover/steps')).toBe(true);
  });

  it('"Mulai melayani" asks first and names what it switches; once confirmed the checklist says since when the library serves', async () => {
    let state = cutover({ deskStaff: 1, rooms: 1, roomsWithStation: 1, reprintOpenedAt: AT, ready: true });
    const steps: string[] = [];
    startApp({
      me: ME,
      path: '/admin/catalog/migration',
      routes: routes({
        cutover: () => state,
        step: (req) => {
          steps.push((req.body as { step: string }).step);
          state = { ...state, servingSince: Date.UTC(2026, 10, 16, 3) };
          return state;
        },
      }),
    });
    const title = await screen.findByRole('heading', { name: 'Pindah dari SLiMS' }, FIRST);
    const section = title.closest('section') as HTMLElement;
    fireEvent.click(within(section).getByRole('button', { name: 'Mulai melayani' }));
    const dialog = await screen.findByRole('alertdialog', { name: 'Mulai melayani di ALTIS?' });
    expect(within(dialog).getByText(/mode sirkulasi Ganti tidak dapat dipakai lagi/)).toBeTruthy();
    expect(steps).toEqual([]);
    fireEvent.click(within(dialog).getByRole('button', { name: 'Mulai melayani' }));
    expect(await within(section).findByText('Perpustakaan melayani di ALTIS sejak 16 November 2026.')).toBeTruthy();
    expect(steps).toEqual(['serve']);
  });

  it('"Cocokkan dengan SLiMS" shows the unpaid fines as rupiah and names each SLiMS member type', async () => {
    const real = run({
      id: REAL_ID,
      dryRun: false,
      summary: summary({
        memberTypes: [{ id: '1', name: 'Siswa', members: 240, group: 'student' }],
        matches: [
          { key: 'unpaid_fines_minor', scope: '', source: 32_700_000, altis: 32_500_000, explained: 200_000, ok: true },
          { key: 'active_members', scope: '', source: 3, altis: 3, explained: 0, ok: true },
          { key: 'active_members', scope: '1', source: 90, altis: 90, explained: 0, ok: true },
        ],
      }),
    });
    startApp({ me: ME, path: `/admin/catalog/migration?run=${REAL_ID}`, routes: routes({ runs: [real] }) });
    const title = await screen.findByRole('heading', { name: 'Cocokkan dengan SLiMS' }, FIRST);
    const section = title.closest('section') as HTMLElement;
    const rows = within(section).getAllByRole('row').filter((r) => r.getAttribute('data-match') !== null);
    expect(rows.map((r) => r.textContent)).toEqual([
      'Total denda belum lunasRp 327.000Rp 325.000Rp 2.000Cocok',
      'Anggota aktif · tanpa tipe SLiMS330Cocok',
      'Anggota aktif · Siswa (1)90900Cocok',
    ]);
  });
});
