import { MESSAGES } from '@altis/shared';
import type { DashboardResponse } from '@altis/shared/api/dashboard';
import type { DiagnosticsReport, SearchHealth } from '@altis/shared/api/diagnostics';
import type { JobView } from '@altis/shared/api/jobs';
import { fireEvent, screen, waitFor, within } from '@testing-library/react';
import { afterEach, describe, expect, it, vi } from 'vitest';
import { adminMe, json, problem, signedIn, startApp, type FakeHandler, type FakeRequest } from '../fake-api';

// Diagnostik, Phase 2 additions (spec §13 "Diagnostik (tambahan)", §4.8, §10; plan Task 28, B2): the search index
// block (its status, the documents against the live records, the last build, "Bangun ulang indeks" →
// `POST catalog/search/reindex` → the job's progress) and the OAI-PMH block (warning while it is on without an admin
// e-mail). Both say "Tidak tersedia" while the report has them as null.

afterEach(() => {
  vi.unstubAllGlobals();
  vi.restoreAllMocks();
});

const AT = 1_760_000_000_000;
const JOB_ID = '01JZ0000000000000000000JOB';

function report(o: Partial<DiagnosticsReport> = {}): DiagnosticsReport {
  return {
    release: {
      version: '0.1.0',
      appJsVersion: '0.1.0',
      bootProtocol: 1,
      missing: [],
      unadopted: [],
      // 1d Task 29: the pending and pinned releases, the bundled one, the keyset store.
      pending: null,
      pinned: null,
      bundled: null,
      keyset: { docs: 0, maxSeq: 0, full: false },
    },
    runtime: { runtime: 'pm2', transport: 'polling', runner: { mode: 'worker', lastRuns: {} } },
    queue: { queued: 0, running: 0, dead: 0, oldestQueuedMs: null },
    backup: { last: null },
    // The edition section (ruling R9).
    edition: { edition: 'community', status: 'active' },
    database: { dialect: 'sqlite', version: '3.50.0', fullText: true, limits: { maxUserConnections: 0, maxConnections: 0 }, poolSize: 1 },
    dataDir: null,
    memory: { rssBytes: 1, heapUsedBytes: 1, totalBytes: 1, freeBytes: 1 },
    network: { ipTrust: 'ok', hops: 0, suggestedHops: null },
    wasm: { ok: true, hint: null },
    http: { methods: null, methodOverride: false, chunkBytes: null, probedAt: null },
    audit: { chain: null },
    clock: { anomaly: null },
    exposure: null,
    disk: { lowAt: null },
    search: { status: 'ready', docs: 130, records: 130, builtAt: AT - 3_600_000, jobId: null },
    oai: { enabled: true, adminEmailSet: true },
    // ---- Komunitas K1 (edition lane) ----
    editionLane: { applied: 0 },
    // ---- Komunitas K4 (stocktake) ----
    stocktakes: [],
    ...o,
  };
}

function search(o: Partial<SearchHealth> = {}): SearchHealth {
  return { status: 'ready', docs: 130, records: 130, builtAt: AT - 3_600_000, jobId: null, ...o };
}

const DASHBOARD: DashboardResponse = {
  version: { current: '0.1.0', appJs: null, bootProtocol: 1, update: null },
  edition: { edition: 'community', status: 'active' },
  lastBackup: null,
  nextBackupAt: null,
  queue: null,
  scheduler: null,
  alerts: [],
};

function jobView(o: Partial<JobView> = {}): JobView {
  return {
    id: JOB_ID,
    type: 'catalog.reindex',
    status: 'running',
    progress: 40,
    progressMessage: null,
    attempts: 1,
    maxAttempts: 3,
    lastError: null,
    runAt: AT,
    createdAt: AT,
    updatedAt: AT,
    finishedAt: null,
    createdBy: adminMe().user.id, // the signed-in user's own job
    retryable: 'origin-only',
    cancellable: true,
    interactive: false,
    ...o,
  };
}

function routes(r: () => DiagnosticsReport, extra: Record<string, FakeHandler> = {}): Record<string, FakeHandler> {
  return { 'GET diagnostics': () => r(), 'GET dashboard': () => DASHBOARD, ...extra };
}

const block = (key: 'search' | 'oai'): HTMLElement => document.querySelector(`[data-diagnostics-block="${key}"]`) as HTMLElement;

const count = (requests: FakeRequest[], method: string, path: string): number => requests.filter((r) => r.method === method && r.path === path).length;

/** Opens Diagnostik and waits for the report. */
async function open(me: ReturnType<typeof adminMe>, r: () => DiagnosticsReport, extra: Record<string, FakeHandler> = {}) {
  const app = startApp({ me, path: '/admin/diagnostics', routes: routes(r, extra) });
  // The first screen of a file waits for its lazy chunk, slow on a loaded machine.
  await screen.findByRole('heading', { name: 'Indeks pencarian' }, { timeout: 5000 });
  await waitFor(() => expect(block('search')).not.toBeNull());
  return app;
}

describe('Diagnostik: the search index', () => {
  it('building with no rebuild running: the status, the counts, why it stays, and "Bangun ulang indeks" posts and follows the job', async () => {
    let current = report({ search: search({ status: 'building', docs: 50, records: 130, jobId: null }) });
    let job = jobView();
    const app = await open(adminMe(), () => current, {
      'POST catalog/search/reindex': () => {
        current = report({ search: search({ status: 'building', docs: 50, records: 130, jobId: JOB_ID }) });
        return json({ jobId: JOB_ID }, 202);
      },
      'GET jobs/:id': () => job,
    });
    const s = block('search');
    expect(await within(s).findByText('Indeks sedang dibangun ulang')).toBeTruthy();
    expect(within(s).getByText('50 dari 130')).toBeTruthy();
    expect(within(s).getByText(/^Tidak ada pembangunan ulang yang berjalan\./)).toBeTruthy();

    fireEvent.click(within(s).getByRole('button', { name: 'Bangun ulang indeks' }));
    const dialog = await screen.findByRole('alertdialog', { name: 'Bangun ulang indeks pencarian?' });
    fireEvent.click(within(dialog).getByRole('button', { name: 'Bangun ulang indeks' }));

    await waitFor(() => expect(count(app.requests, 'POST', 'catalog/search/reindex')).toBe(1));
    expect(app.requests.find((r) => r.path === 'catalog/search/reindex')!.body).toBeUndefined();
    expect(await within(s).findByText('40 %')).toBeTruthy();
    expect(within(s).queryByRole('button', { name: 'Bangun ulang indeks' })).toBeNull();

    // The job ends: the report is read again and the block says so.
    job = jobView({ status: 'succeeded', progress: 100, finishedAt: AT + 60_000 });
    current = report({ search: search({ status: 'ready', docs: 130, records: 130, builtAt: AT + 60_000 }) });
    await app.queryClient.invalidateQueries({ queryKey: ['jobs'] });
    expect(await within(s).findByText('Indeks pencarian selesai dibangun ulang.', undefined, { timeout: 4000 })).toBeTruthy();
    await waitFor(() => expect(within(s).getByText('Siap')).toBeTruthy());
    expect(count(app.requests, 'GET', 'diagnostics')).toBeGreaterThanOrEqual(2);
  });

  it('a rebuild already queued or running shows its progress instead of the button', async () => {
    await open(adminMe(), () => report({ search: search({ status: 'building', docs: 10, records: 130, jobId: JOB_ID }) }), {
      'GET jobs/:id': () => jobView({ progress: 30 }),
    });
    const s = block('search');
    expect(await within(s).findByText('30 %')).toBeTruthy();
    expect(within(s).queryByRole('button', { name: 'Bangun ulang indeks' })).toBeNull();
    expect(within(s).queryByText(/^Tidak ada pembangunan ulang yang berjalan\./)).toBeNull();
  });

  it('a rebuild someone else runs is only named for a reader without system.jobs.read (its job would answer 404)', async () => {
    const app = await open(signedIn({ permissions: ['system.diagnostics.read'] }), () =>
      report({ search: search({ status: 'building', docs: 10, records: 130, jobId: JOB_ID }) }),
    );
    expect(await within(block('search')).findByText(/^Pembangunan ulang indeks sedang berjalan\./)).toBeTruthy();
    expect(app.requests.some((r) => r.path.startsWith('jobs/'))).toBe(false);
  });

  // C26/E22b: on a host where no worker runs (Passenger/LiteSpeed) the page drives the rebuild the boot queued after a
  // restore (no creator), for a holder of system.diagnostics.manage (the rebuild's own permission, which `GET jobs/:id`
  // and drive accept) even without system.jobs.read.
  it('a holder of system.diagnostics.manage without system.jobs.read follows and drives the rebuild the boot queued', async () => {
    let current = report({ search: search({ status: 'missing', docs: 0, builtAt: null, jobId: JOB_ID }) });
    let drives = 0;
    const boot = (o: Partial<JobView> = {}): JobView => jobView({ createdBy: null, interactive: true, status: 'queued', progress: 0, payload: { scope: 'all' }, ...o });
    let job = boot();
    const app = await open(signedIn({ permissions: ['system.diagnostics.read', 'system.diagnostics.manage'] }), () => current, {
      'GET jobs/:id': () => job,
      'GET dashboard': () => ({ ...DASHBOARD, scheduler: null }),
      'POST jobs/:id/drive': () => {
        drives += 1;
        if (drives < 2) job = boot({ status: 'running', progress: 60, updatedAt: AT + drives });
        else {
          job = boot({ status: 'succeeded', progress: 100, updatedAt: AT + drives, finishedAt: AT + drives });
          current = report({ search: search({ status: 'ready', docs: 130, records: 130, builtAt: AT + drives }) });
        }
        return job;
      },
    });
    const s = block('search');
    expect(within(s).queryByRole('button', { name: 'Bangun ulang indeks' })).toBeNull();
    expect(await within(s).findByText('Indeks pencarian selesai dibangun ulang.', undefined, { timeout: 4000 })).toBeTruthy();
    expect(count(app.requests, 'POST', `jobs/${JOB_ID}/drive`)).toBe(2);
    await waitFor(() => expect(within(s).getByText('Siap')).toBeTruthy());
  });

  it('ready with fewer documents than records warns as the dashboard does; matching counts do not', async () => {
    await open(adminMe(), () => report({ search: search({ docs: 128, records: 130 }) }));
    expect(await within(block('search')).findByText(MESSAGES.id['alert.search_index_mismatch'])).toBeTruthy();
  });

  it('ready with matching counts: no warning, the last build, and the button', async () => {
    await open(adminMe(), () => report());
    const s = block('search');
    expect(await within(s).findByText('Siap')).toBeTruthy();
    expect(within(s).getByText('130 dari 130')).toBeTruthy();
    expect(within(s).queryByText(MESSAGES.id['alert.search_index_mismatch'])).toBeNull();
    expect(within(s).getByRole('button', { name: 'Bangun ulang indeks' })).toBeTruthy();
  });

  it('missing: the index was never built (after a restore, say), and the button builds it', async () => {
    await open(adminMe(), () => report({ search: search({ status: 'missing', docs: 0, builtAt: null }) }));
    const s = block('search');
    expect(await within(s).findByText('Indeks belum dibangun')).toBeTruthy();
    expect(within(s).getByText(/^Indeks belum pernah dibangun/)).toBeTruthy();
    expect(within(s).getByRole('button', { name: 'Bangun ulang indeks' })).toBeTruthy();
  });

  it('without system.diagnostics.manage the health is shown with no rebuild button', async () => {
    await open(signedIn({ permissions: ['system.diagnostics.read'] }), () => report({ search: search({ status: 'building', jobId: null }) }));
    const s = block('search');
    expect(await within(s).findByText('Indeks sedang dibangun ulang')).toBeTruthy();
    expect(within(s).queryByRole('button', { name: 'Bangun ulang indeks' })).toBeNull();
  });

  it('a refused rebuild keeps its message in the dialog', async () => {
    const app = await open(adminMe(), () => report(), {
      'POST catalog/search/reindex': () => problem(409, 'TX_CONFLICT'),
    });
    fireEvent.click(within(block('search')).getByRole('button', { name: 'Bangun ulang indeks' }));
    const dialog = await screen.findByRole('alertdialog', { name: 'Bangun ulang indeks pencarian?' });
    fireEvent.click(within(dialog).getByRole('button', { name: 'Bangun ulang indeks' }));
    await waitFor(() => expect(count(app.requests, 'POST', 'catalog/search/reindex')).toBe(1));
    expect((await within(dialog).findByRole('alert')).textContent).toBe(MESSAGES.id['error.TX_CONFLICT']);
  });
});

describe('Diagnostik: OAI-PMH', () => {
  it('on without an admin e-mail: the warning and a link to the OPAC settings', async () => {
    await open(adminMe(), () => report({ oai: { enabled: true, adminEmailSet: false } }));
    const o = block('oai');
    expect(await within(o).findByText(MESSAGES.id['alert.oai_misconfigured'])).toBeTruthy();
    expect(within(o).getByRole('link', { name: 'Buka pengaturan OPAC' }).getAttribute('href')).toBe('/admin/settings/opac');
  });

  it('on with an admin e-mail, or off: no warning', async () => {
    await open(adminMe(), () => report({ oai: { enabled: false, adminEmailSet: false } }));
    const o = block('oai');
    expect(await within(o).findByText('Nonaktif')).toBeTruthy();
    expect(within(o).queryByText(MESSAGES.id['alert.oai_misconfigured'])).toBeNull();
  });
});

describe('Diagnostik: before the search provider fills the report (B2)', () => {
  it('search and oai as null read "Tidak tersedia", with no rebuild button and no warning', async () => {
    await open(adminMe(), () => report({ search: null, oai: null }));
    for (const key of ['search', 'oai'] as const) expect(await within(block(key)).findByText('Tidak tersedia')).toBeTruthy();
    expect(within(block('search')).queryByRole('button', { name: 'Bangun ulang indeks' })).toBeNull();
    expect(within(block('oai')).queryByText(MESSAGES.id['alert.oai_misconfigured'])).toBeNull();
  });
});
