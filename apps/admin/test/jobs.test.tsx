import type { DashboardResponse } from '@altis/shared/api/dashboard';
import type { EventsResponse } from '@altis/shared/api/events';
import type { JobListResponse, JobView, ScheduleView } from '@altis/shared/api/jobs';
import { act, cleanup, fireEvent, screen, waitFor, within } from '@testing-library/react';
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import { JOB_POLL_MS } from '@/components/job-progress';
import { DRIVE_IDLE_LIMIT, DRIVE_IDLE_MS, DRIVE_MIN_GAP_MS } from '@/screens/jobs/detail';
import { adminMe, problem, signedIn, startApp, superMe, type FakeHandler, type FakeRequest, type SignedIn } from './fake-api';

// Tugas dan Jadwal (spec §13.3 "Daftar, detail, ulangi/batalkan (§10.5), aktif/nonaktifkan jadwal", §10.2; Task 31):
// the jobs list with its status and type filters and keyset paging, a job's page with live progress (`jobs.<id>`),
// Ulangi/Batalkan by permission and by the job's own `retryable`/`cancellable`, "Jalankan sekarang" (drive) for an
// `interactive` job in external mode (auth/me's `client.runner`, 1d T31-RUNNER-MODE-FOR-ALL-STAFF), and the schedules
// with their switch and the daily backup's time.

afterEach(() => {
  vi.unstubAllGlobals();
  vi.restoreAllMocks();
});

const AT = 1_760_000_000_000;
const JOB_ID = '01JZ000000000000000000JOB1';
const OTHER = '01JZ000000000000000000JOB7';
const THIRD = '01JZ000000000000000000JOB8';

function job(o: Partial<JobView> = {}): JobView {
  return {
    id: JOB_ID,
    type: 'backup.create',
    status: 'running',
    progress: 10,
    progressMessage: null,
    attempts: 1,
    maxAttempts: 5,
    lastError: null,
    runAt: AT,
    createdAt: AT,
    updatedAt: AT,
    finishedAt: null,
    createdBy: null,
    retryable: 'api',
    cancellable: true,
    interactive: false,
    ...o,
  };
}

function schedule(o: Partial<ScheduleView> & { name: string }): ScheduleView {
  return {
    expr: '17 * * * *',
    enabled: true,
    nextRunAt: AT + 600_000,
    lastRunAt: AT - 3_000_000,
    jobType: 'housekeeping.events',
    exprEditable: false,
    permission: 'system.jobs.manage',
    ...o,
  };
}

function dashboardIn(mode: 'worker' | 'external'): DashboardResponse {
  return {
    version: { current: '0.1.0', appJs: null, bootProtocol: 1, update: null },
    edition: { edition: 'community', status: 'active' },
    lastBackup: null,
    nextBackupAt: null,
    queue: { queued: 1, running: 0, dead: 0, oldestQueuedMs: null },
    scheduler: { runner: { mode, lastRuns: {} }, schedules: [] },
    alerts: [],
  };
}

/** `me` on a host whose jobs are run by `runner` (auth/me's client hints). */
function inMode(me: SignedIn, runner: 'worker' | 'external'): SignedIn {
  return { ...me, client: { realtime: 'polling', methodOverride: false, chunkBytes: 5 * 1024 * 1024, probedAt: null, runner } };
}

/** A fake jobs API serving `current` at `GET jobs/:id`. */
function detailRoutes(current: () => JobView, extra: Record<string, FakeHandler> = {}): Record<string, FakeHandler> {
  return {
    'GET jobs/:id': () => current(),
    'GET dashboard': () => dashboardIn('worker'),
    ...extra,
  };
}

describe('jobs list', () => {
  it('lists the jobs newest first with their status', async () => {
    startApp({
      me: adminMe(),
      path: '/admin/jobs',
      routes: {
        'GET jobs': (): JobListResponse => ({
          items: [job({ id: '01JZ000000000000000000JOB3', status: 'dead', type: 'mail.password_reset' }), job()],
          nextBefore: null,
        }),
      },
    });
    const table = await screen.findByRole('table');
    expect(within(table).getByText('Gagal')).toBeTruthy();
    expect(within(table).getByText('Berjalan')).toBeTruthy();
    expect(within(table).getByText('Mengirim e-mail atur ulang sandi')).toBeTruthy();
  });

  it('the status filter sends status=dead', async () => {
    const app = startApp({
      me: adminMe(),
      path: '/admin/jobs',
      routes: { 'GET jobs': (): JobListResponse => ({ items: [job()], nextBefore: null }) },
    });
    await screen.findByRole('table');
    expect(app.requests.filter((r) => r.path === 'jobs')[0]?.query.has('status')).toBe(false);
    fireEvent.change(screen.getByLabelText('Status'), { target: { value: 'dead' } });
    fireEvent.click(screen.getByRole('button', { name: 'Terapkan' }));
    await waitFor(() => expect(app.requests.filter((r) => r.path === 'jobs').at(-1)?.query.get('status')).toBe('dead'));
  });

  it('the type filter sends type=<type>, and a malformed type is refused before anything is asked', async () => {
    const app = startApp({
      me: adminMe(),
      path: '/admin/jobs',
      routes: { 'GET jobs': (): JobListResponse => ({ items: [job()], nextBefore: null }) },
    });
    await screen.findByRole('table');
    const lists = (): FakeRequest[] => app.requests.filter((r) => r.path === 'jobs');
    fireEvent.change(screen.getByLabelText('Jenis tugas'), { target: { value: 'Backup Create' } });
    fireEvent.click(screen.getByRole('button', { name: 'Terapkan' }));
    expect(await screen.findByText('Jenis tugas ditulis dengan huruf kecil, angka, titik, atau garis bawah.')).toBeTruthy();
    expect(lists()).toHaveLength(1);
    fireEvent.change(screen.getByLabelText('Jenis tugas'), { target: { value: 'backup.create' } });
    fireEvent.click(screen.getByRole('button', { name: 'Terapkan' }));
    await waitFor(() => expect(lists().at(-1)?.query.get('type')).toBe('backup.create'));
  });

  it('"Muat lagi" requests before=<nextBefore> and appends the page', async () => {
    const older = '01JZ000000000000000000JOB0';
    const app = startApp({
      me: adminMe(),
      path: '/admin/jobs',
      routes: {
        'GET jobs': (req): JobListResponse =>
          req.query.get('before') === JOB_ID
            ? { items: [job({ id: older, type: 'audit.anchor', status: 'succeeded' })], nextBefore: null }
            : { items: [job()], nextBefore: JOB_ID },
      },
    });
    await screen.findByRole('table');
    fireEvent.click(screen.getByRole('button', { name: 'Muat lagi' }));
    expect(await screen.findByText('Menjangkarkan dan memeriksa log audit')).toBeTruthy();
    expect(app.requests.filter((r) => r.path === 'jobs').at(-1)?.query.get('before')).toBe(JOB_ID);
    expect(screen.queryByRole('button', { name: 'Muat lagi' })).toBeNull();
  });

  it('each row opens the job page', async () => {
    const app = startApp({
      me: adminMe(),
      path: '/admin/jobs',
      routes: { 'GET jobs': (): JobListResponse => ({ items: [job()], nextBefore: null }), ...detailRoutes(() => job()) },
    });
    const table = await screen.findByRole('table');
    fireEvent.click(within(table).getByRole('link', { name: /Rincian/ }));
    await waitFor(() => expect(app.router.state.location.pathname).toBe(`/admin/jobs/${JOB_ID}`));
    expect(await screen.findByRole('progressbar')).toBeTruthy();
  });
});

describe('job page', () => {
  it('Ulangi is offered for a dead `api` job to a holder of system.jobs.manage, and posts retry', async () => {
    let current = job({ status: 'dead', lastError: 'MAIL_SEND_FAILED: SMTP menolak', finishedAt: AT + 1000 });
    const app = startApp({
      me: adminMe(),
      path: `/admin/jobs/${JOB_ID}`,
      routes: detailRoutes(() => current, {
        'POST jobs/:id/retry': () => {
          current = job({ status: 'queued', attempts: 0 });
          return current;
        },
      }),
    });
    fireEvent.click(await screen.findByRole('button', { name: 'Ulangi' }));
    await waitFor(() => expect(app.writes()).toEqual([`POST jobs/${JOB_ID}/retry`]));
    expect(await screen.findByText('Menunggu')).toBeTruthy();
  });

  it('Ulangi is hidden without system.jobs.manage', async () => {
    startApp({
      me: signedIn({ permissions: ['system.jobs.read'] }),
      path: `/admin/jobs/${JOB_ID}`,
      routes: detailRoutes(() => job({ status: 'dead' })),
    });
    await screen.findByRole('progressbar');
    expect(screen.queryByRole('button', { name: 'Ulangi' })).toBeNull();
    expect(screen.queryByRole('button', { name: 'Batalkan' })).toBeNull();
  });

  it('Ulangi is hidden for an origin-only job', async () => {
    startApp({
      me: superMe(),
      path: `/admin/jobs/${JOB_ID}`,
      routes: detailRoutes(() => job({ status: 'dead', type: 'backup.prepare_download', retryable: 'origin-only' })),
    });
    await screen.findByRole('progressbar');
    expect(screen.queryByRole('button', { name: 'Ulangi' })).toBeNull();
  });

  it('Batalkan is disabled when the job is not cancellable', async () => {
    startApp({ me: adminMe(), path: `/admin/jobs/${JOB_ID}`, routes: detailRoutes(() => job({ cancellable: false })) });
    const cancel = await screen.findByRole('button', { name: 'Batalkan' });
    expect((cancel as HTMLButtonElement).disabled).toBe(true);
  });

  it('Batalkan asks first, then posts cancel', async () => {
    let current = job({ status: 'queued', progress: 0 });
    const app = startApp({
      me: adminMe(),
      path: `/admin/jobs/${JOB_ID}`,
      routes: detailRoutes(() => current, {
        'POST jobs/:id/cancel': () => {
          current = job({ status: 'cancelled', progress: 0, cancellable: false, finishedAt: AT + 5 });
          return current;
        },
      }),
    });
    const cancel = await screen.findByRole('button', { name: 'Batalkan' });
    expect((cancel as HTMLButtonElement).disabled).toBe(false);
    fireEvent.click(cancel);
    const dialog = await screen.findByRole('alertdialog');
    expect(app.writes()).toEqual([]);
    fireEvent.click(within(dialog).getByRole('button', { name: 'Batalkan tugas' }));
    await waitFor(() => expect(app.writes()).toEqual([`POST jobs/${JOB_ID}/cancel`]));
    expect(await screen.findByText('Dibatalkan')).toBeTruthy();
  });

  it('a job.progress event moves the progress bar', async () => {
    let progress = 10;
    let sent = false;
    const events = (req: FakeRequest): EventsResponse => {
      const channels = req.query.get('channels')?.split(',') ?? [];
      if (!sent && channels.includes(`jobs.${JOB_ID}`)) {
        sent = true;
        progress = 60;
        const e = { seq: 7, channel: `jobs.${JOB_ID}`, type: 'job.progress', payload: { status: 'running', progress: 60 }, at: AT };
        return { cursor: '1.7', events: [e] };
      }
      return { cursor: '1.6', events: [] };
    };
    const app = startApp({
      me: adminMe(),
      path: `/admin/jobs/${JOB_ID}`,
      routes: detailRoutes(() => job({ progress }), { 'GET events': events }),
    });
    const bar = await screen.findByRole('progressbar');
    expect(bar.getAttribute('aria-valuenow')).toBe('10');
    await waitFor(() => expect(screen.getByRole('progressbar').getAttribute('aria-valuenow')).toBe('60'), { timeout: 4000 });
    expect(app.requests.some((r) => r.path === 'events' && r.query.get('channels')?.split(',').includes(`jobs.${JOB_ID}`))).toBe(true);
  });

  it('"Jalankan sekarang" in external mode drives the job until it ends', async () => {
    let current = job({
      type: 'backup.prepare_download',
      status: 'queued',
      progress: 0,
      retryable: 'origin-only',
      createdBy: 'U1',
      interactive: true,
    });
    let drives = 0;
    const app = startApp({
      me: inMode(adminMe(), 'external'),
      path: `/admin/jobs/${JOB_ID}`,
      routes: detailRoutes(() => current, {
        'POST jobs/:id/drive': () => {
          drives += 1;
          current =
            drives === 1
              ? { ...current, status: 'queued', progress: 50, updatedAt: AT + 1000 }
              : { ...current, status: 'succeeded', progress: 100, updatedAt: AT + 2000, finishedAt: AT + 2000, cancellable: false };
          return current;
        },
      }),
    });
    fireEvent.click(await screen.findByRole('button', { name: 'Jalankan sekarang' }));
    // The second call starts DRIVE_MIN_GAP_MS after the first, which moved the job.
    expect(await screen.findByText('Berhasil', undefined, { timeout: 4000 })).toBeTruthy();
    expect(app.writes()).toEqual([`POST jobs/${JOB_ID}/drive`, `POST jobs/${JOB_ID}/drive`]);
    expect(screen.getByRole('progressbar').getAttribute('aria-valuenow')).toBe('100');
    expect(screen.queryByRole('button', { name: 'Jalankan sekarang' })).toBeNull();
  });

  it('"Jalankan sekarang" is not offered in worker mode, nor while the runner mode is unknown', async () => {
    for (const me of [inMode(adminMe(), 'worker'), adminMe()]) {
      startApp({
        me,
        path: `/admin/jobs/${JOB_ID}`,
        routes: detailRoutes(() => job({ type: 'backup.prepare_download', status: 'queued', createdBy: 'U1', interactive: true })),
      });
      await screen.findByRole('progressbar');
      await new Promise((resolve) => setTimeout(resolve, 50));
      expect(screen.getByText('Menunggu')).toBeTruthy();
      expect(screen.queryByRole('button', { name: 'Jalankan sekarang' })).toBeNull();
      cleanup();
    }
  });

  // 1d T31-RUNNER-MODE-FOR-ALL-STAFF: the creator of a job who cannot read the dashboard's scheduler (no
  // system.jobs.read: `scheduler: null`) still knows the runner mode, from auth/me.
  it('a creator without system.jobs.read: no "Jalankan sekarang" in worker mode, offered in external mode', async () => {
    const creator = signedIn({ permissions: ['system.backup.download'] });
    const routes = detailRoutes(() => job({ type: 'backup.prepare_download', status: 'queued', createdBy: 'U1', interactive: true }), {
      'GET dashboard': () => ({ ...dashboardIn('worker'), scheduler: null }),
    });
    const worker = startApp({ me: inMode(creator, 'worker'), path: `/admin/jobs/${JOB_ID}`, routes });
    await screen.findByRole('progressbar');
    await new Promise((resolve) => setTimeout(resolve, 100));
    expect(screen.queryByRole('button', { name: 'Jalankan sekarang' })).toBeNull();
    expect(worker.writes()).toEqual([]);
    cleanup();

    startApp({ me: inMode(creator, 'external'), path: `/admin/jobs/${JOB_ID}`, routes });
    expect(await screen.findByRole('button', { name: 'Jalankan sekarang' })).toBeTruthy();
  });

  // C26/E22b: `GET jobs/:id` also answers a holder of an interactive job's handler permission (whom drive accepts). Its
  // channel stays the creator's and system.jobs.read's (§10.7): subscribing would refuse the tab's whole poll.
  it("a holder of the job's handler permission, neither its creator nor a holder of system.jobs.read: drive offered, its channel not read", async () => {
    const holder = signedIn({ permissions: ['system.diagnostics.read', 'system.diagnostics.manage'] });
    const app = startApp({
      me: inMode(holder, 'external'),
      path: `/admin/jobs/${JOB_ID}`,
      routes: detailRoutes(
        () => job({ type: 'catalog.reindex', status: 'queued', createdBy: null, retryable: 'origin-only', interactive: true, payload: { scope: 'all' } }),
        { 'GET events': () => ({ cursor: '1.6', events: [] }) },
      ),
    });
    expect(await screen.findByRole('button', { name: 'Jalankan sekarang' })).toBeTruthy();
    // The shell's own channels are read; the job's never is.
    await waitFor(() => expect(app.requests.some((r) => r.path === 'events')).toBe(true));
    await new Promise((resolve) => setTimeout(resolve, 300));
    expect(app.requests.some((r) => r.path === 'events' && r.query.get('channels')?.split(',').includes(`jobs.${JOB_ID}`))).toBe(false);
  });

  // Without the job's channel the page reads the job again every JOB_POLL_MS while it has work ahead. Those reads are
  // the page's own, not the user's: an unattended page (a rebuild backing off, a stuck runner) must not keep the staff
  // session past its idle limit (§7.1), so they go out in the background; the page's first read stays the user's.
  describe("following a job read through its handler's permission (worker mode)", () => {
    afterEach(() => {
      vi.useRealTimers();
    });

    /** For each `GET jobs/<JOB_ID>` sent: whether it carried `X-Altis-Background: 1`. */
    const jobReads = (app: ReturnType<typeof startApp>): boolean[] =>
      app.fetchMock.mock.calls
        .filter(([url, init]) => (init?.method ?? 'GET') === 'GET' && new URL(String(url), 'https://altis.test').pathname === `/api/v1/jobs/${JOB_ID}`)
        .map(([, init]) => (init?.headers as Record<string, string> | undefined)?.['X-Altis-Background'] === '1');

    it(`reads the job every ${JOB_POLL_MS} ms in the background; the first read stays the user's`, async () => {
      vi.useFakeTimers({ shouldAdvanceTime: true });
      const holder = signedIn({ permissions: ['system.diagnostics.read', 'system.diagnostics.manage'] });
      const app = startApp({
        me: inMode(holder, 'worker'),
        path: `/admin/jobs/${JOB_ID}`,
        routes: detailRoutes(
          () => job({ type: 'catalog.reindex', status: 'queued', createdBy: null, retryable: 'origin-only', interactive: true, payload: { scope: 'all' } }),
          { 'GET events': () => ({ cursor: '1.6', events: [] }) },
        ),
      });
      await screen.findByRole('progressbar');
      await waitFor(() => expect(jobReads(app)).toHaveLength(1));
      await act(() => vi.advanceTimersByTimeAsync(3 * JOB_POLL_MS));
      await waitFor(() => expect(jobReads(app).length).toBeGreaterThanOrEqual(3));
      expect(jobReads(app)[0]).toBe(false);
      expect(jobReads(app).slice(1).every(Boolean)).toBe(true);
    });

    it('stops reading once the job has ended', async () => {
      vi.useFakeTimers({ shouldAdvanceTime: true });
      const holder = signedIn({ permissions: ['system.diagnostics.read', 'system.diagnostics.manage'] });
      let reads = 0;
      const app = startApp({
        me: inMode(holder, 'worker'),
        path: `/admin/jobs/${JOB_ID}`,
        routes: detailRoutes(
          () => {
            reads += 1;
            return job({
              type: 'catalog.reindex',
              status: reads >= 2 ? 'succeeded' : 'running',
              progress: reads >= 2 ? 100 : 40,
              finishedAt: reads >= 2 ? AT + 1 : null,
              createdBy: null,
              retryable: 'origin-only',
              interactive: true,
              payload: { scope: 'all' },
            });
          },
          { 'GET events': () => ({ cursor: '1.6', events: [] }) },
        ),
      });
      await screen.findByRole('progressbar');
      await act(() => vi.advanceTimersByTimeAsync(JOB_POLL_MS));
      await waitFor(() => expect(jobReads(app)).toHaveLength(2));
      expect(await screen.findByText('Berhasil')).toBeTruthy();
      await act(() => vi.advanceTimersByTimeAsync(4 * JOB_POLL_MS));
      expect(jobReads(app)).toEqual([false, true]);
    });
  });

  it('"Jalankan sekarang" is not offered for a job that is not interactive, even in external mode', async () => {
    const app = startApp({
      me: inMode(superMe(), 'external'),
      path: `/admin/jobs/${JOB_ID}`,
      // Queued on a host without cron, created by this user, whose payload they may see: only the runner may run it.
      routes: detailRoutes(() => job({ type: 'backup.create', status: 'queued', createdBy: 'U1', payload: {} })),
    });
    await screen.findByRole('progressbar');
    await new Promise((resolve) => setTimeout(resolve, 100));
    expect(screen.getByText('Menunggu')).toBeTruthy();
    expect(screen.queryByRole('button', { name: 'Jalankan sekarang' })).toBeNull();
    expect(screen.queryByText(/Anda dapat menjalankan tugas ini dari halaman ini/)).toBeNull();
    expect(app.writes()).toEqual([]);
  });

  it('a 409 JOB_NOT_INTERACTIVE (a job the runner alone may run after all) says so and stops offering "Jalankan sekarang"', async () => {
    const app = startApp({
      me: inMode(adminMe(), 'external'),
      path: `/admin/jobs/${JOB_ID}`,
      // The admin holds the handler's permission (system.jobs.manage), so the job shows its payload (C34). The view says
      // interactive, the server refuses anyway (say, a release that changed in between): the 409 is the fallback.
      routes: detailRoutes(() => job({ type: 'housekeeping.files', status: 'queued', payload: { done: 0 }, interactive: true }), {
        'POST jobs/:id/drive': () => problem(409, 'JOB_NOT_INTERACTIVE'),
      }),
    });
    fireEvent.click(await screen.findByRole('button', { name: 'Jalankan sekarang' }));
    expect(await screen.findByText('Tugas ini berjalan otomatis di latar belakang dan tidak dapat dijalankan dari halaman ini.')).toBeTruthy();
    expect(app.writes()).toEqual([`POST jobs/${JOB_ID}/drive`]);
    expect(screen.queryByRole('button', { name: 'Jalankan sekarang' })).toBeNull();
  });

  describe('an idle drive loop', () => {
    let hidden = false;

    beforeEach(() => {
      hidden = false;
      Object.defineProperty(document, 'hidden', { configurable: true, get: () => hidden });
      // Fake timers that also follow the real clock, so the screen's own waits still run between the jumps.
      vi.useFakeTimers({ shouldAdvanceTime: true });
    });

    afterEach(() => {
      vi.useRealTimers();
      delete (document as { hidden?: boolean }).hidden;
    });

    /** A queued interactive job that never moves: every drive call answers it unchanged (it is not due yet). */
    function idleJob() {
      const current = job({ type: 'backup.prepare_download', status: 'queued', progress: 0, createdBy: 'U1', interactive: true });
      return startApp({
        me: inMode(adminMe(), 'external'),
        path: `/admin/jobs/${JOB_ID}`,
        routes: detailRoutes(() => current, { 'POST jobs/:id/drive': () => current }),
      });
    }

    const drives = (app: ReturnType<typeof startApp>): number => app.writes().filter((w) => w === `POST jobs/${JOB_ID}/drive`).length;

    it(`stops after ${DRIVE_IDLE_LIMIT} calls in a row that moved nothing, says so, and offers to run again`, async () => {
      const app = idleJob();
      fireEvent.click(await screen.findByRole('button', { name: 'Jalankan sekarang' }));
      await waitFor(() => expect(drives(app)).toBe(1));
      for (let i = 1; i < DRIVE_IDLE_LIMIT; i++) await act(() => vi.advanceTimersByTimeAsync(DRIVE_IDLE_MS));
      await waitFor(() => expect(drives(app)).toBe(DRIVE_IDLE_LIMIT));
      expect(await screen.findByText(/Tugas belum bergerak selama sekitar satu menit/)).toBeTruthy();
      expect(screen.queryByRole('button', { name: 'Hentikan' })).toBeNull();
      // No call after the last one, however long the page stays open.
      await act(() => vi.advanceTimersByTimeAsync(10 * DRIVE_IDLE_MS));
      expect(drives(app)).toBe(DRIVE_IDLE_LIMIT);
      // "Jalankan sekarang" starts a new loop.
      fireEvent.click(screen.getByRole('button', { name: 'Jalankan sekarang' }));
      await waitFor(() => expect(drives(app)).toBe(DRIVE_IDLE_LIMIT + 1));
      expect(screen.queryByText(/Tugas belum bergerak selama sekitar satu menit/)).toBeNull();
    });

    it('makes no call that moves nothing while the page is hidden, and goes on once it is visible', async () => {
      const app = idleJob();
      fireEvent.click(await screen.findByRole('button', { name: 'Jalankan sekarang' }));
      await waitFor(() => expect(drives(app)).toBe(1));
      hidden = true;
      document.dispatchEvent(new Event('visibilitychange'));
      await act(() => vi.advanceTimersByTimeAsync(20 * DRIVE_IDLE_MS));
      expect(drives(app)).toBe(1);
      expect(screen.getByRole('button', { name: 'Hentikan' })).toBeTruthy();
      hidden = false;
      document.dispatchEvent(new Event('visibilitychange'));
      await waitFor(() => expect(drives(app)).toBe(2));
    });
  });

  describe('a drive loop that moves the job', () => {
    beforeEach(() => {
      vi.useFakeTimers({ shouldAdvanceTime: true });
    });

    afterEach(() => {
      vi.useRealTimers();
    });

    it(`starts the next call ${DRIVE_MIN_GAP_MS} ms after the start of one that moved the job, not at once`, async () => {
      // Short slices: every drive call comes back at once with movement.
      let current = job({ type: 'backup.prepare_download', status: 'running', progress: 0, createdBy: 'U1', interactive: true });
      let calls = 0;
      const app = startApp({
        me: inMode(adminMe(), 'external'),
        path: `/admin/jobs/${JOB_ID}`,
        routes: detailRoutes(() => current, {
          'POST jobs/:id/drive': () => {
            calls += 1;
            current = { ...current, progress: Math.min(90, calls * 10), updatedAt: AT + calls };
            return current;
          },
        }),
      });
      const drives = (): number => app.writes().filter((w) => w === `POST jobs/${JOB_ID}/drive`).length;
      fireEvent.click(await screen.findByRole('button', { name: 'Jalankan sekarang' }));
      await waitFor(() => expect(drives()).toBe(1));
      await act(() => vi.advanceTimersByTimeAsync(DRIVE_MIN_GAP_MS / 2));
      expect(drives()).toBe(1);
      await act(() => vi.advanceTimersByTimeAsync(DRIVE_MIN_GAP_MS / 2));
      await waitFor(() => expect(drives()).toBe(2));
      fireEvent.click(screen.getByRole('button', { name: 'Hentikan' }));
    });
  });

  describe('moving to another job', () => {
    const OTHER_ID = '01JZ000000000000000000JOB2';
    const queuedInteractive = (id: string) =>
      job({ id, type: 'backup.prepare_download', status: 'queued', progress: 0, createdBy: 'U1', interactive: true });

    it("starts the other job's page afresh: a 409 and its notice on one job do not follow to the next", async () => {
      const app = startApp({
        me: inMode(adminMe(), 'external'),
        path: `/admin/jobs/${JOB_ID}`,
        routes: {
          'GET jobs/:id': (req) => queuedInteractive(req.params['id']!),
          'POST jobs/:id/drive': (req) => (req.params['id'] === JOB_ID ? problem(409, 'JOB_NOT_INTERACTIVE') : queuedInteractive(OTHER_ID)),
        },
      });
      fireEvent.click(await screen.findByRole('button', { name: 'Jalankan sekarang' }));
      const refusal = 'Tugas ini berjalan otomatis di latar belakang dan tidak dapat dijalankan dari halaman ini.';
      expect(await screen.findByText(refusal)).toBeTruthy();
      expect(screen.queryByRole('button', { name: 'Jalankan sekarang' })).toBeNull();
      await act(() => app.router.navigate({ href: `/admin/jobs/${OTHER_ID}` }));
      expect(await screen.findByText(OTHER_ID)).toBeTruthy();
      expect(await screen.findByRole('button', { name: 'Jalankan sekarang' })).toBeTruthy();
      expect(screen.queryByText(refusal)).toBeNull();
    });

    it("stops the drive loop of the job it leaves: the other job's page offers its own drive", async () => {
      const app = startApp({
        me: inMode(adminMe(), 'external'),
        path: `/admin/jobs/${JOB_ID}`,
        routes: {
          'GET jobs/:id': (req) => queuedInteractive(req.params['id']!),
          // Nothing moves (the job is not due yet): the loop waits before its next call.
          'POST jobs/:id/drive': (req) => queuedInteractive(req.params['id']!),
        },
      });
      fireEvent.click(await screen.findByRole('button', { name: 'Jalankan sekarang' }));
      await waitFor(() => expect(app.writes()).toEqual([`POST jobs/${JOB_ID}/drive`]));
      expect(screen.getByRole('button', { name: 'Hentikan' })).toBeTruthy();
      await act(() => app.router.navigate({ href: `/admin/jobs/${OTHER_ID}` }));
      expect(await screen.findByText(OTHER_ID)).toBeTruthy();
      expect(await screen.findByRole('button', { name: 'Jalankan sekarang' })).toBeTruthy();
      expect(screen.queryByRole('button', { name: 'Hentikan' })).toBeNull();
      expect(app.writes()).toEqual([`POST jobs/${JOB_ID}/drive`]);
    });
  });

  it("shows a handler's progress message in the user's language, and none it does not know (an internal word)", async () => {
    let current = job({ type: 'backup.create', status: 'succeeded', progress: 100, progressMessage: 'converted to frozen' });
    const { router } = startApp({ me: adminMe(), path: `/admin/jobs/${JOB_ID}`, routes: detailRoutes(() => current) });
    expect(await screen.findByText('Dilanjutkan sebagai cadangan yang dibekukan (mode pemeliharaan).')).toBeTruthy();
    expect(screen.queryByText('converted to frozen')).toBeNull();

    current = job({ id: OTHER, type: 'housekeeping.files', progress: 50, progressMessage: 'orphans' });
    await act(() => router.navigate({ href: `/admin/jobs/${OTHER}` }));
    expect(await screen.findByText('Mengakhiri cadangan yang tidak dikerjakan lagi')).toBeTruthy();
    expect(screen.queryByText('orphans')).toBeNull();

    current = job({ id: THIRD, type: 'housekeeping.files', progress: 50, progressMessage: 'fase baru' });
    await act(() => router.navigate({ href: `/admin/jobs/${THIRD}` }));
    expect(await screen.findByText(THIRD)).toBeTruthy();
    expect(screen.queryByText('fase baru')).toBeNull();
  });

  it('an unknown job (or one the caller may not see) says it was not found', async () => {
    startApp({ me: adminMe(), path: `/admin/jobs/${JOB_ID}`, routes: { 'GET dashboard': () => dashboardIn('worker') } });
    expect(await screen.findByText('Tugas tidak ditemukan, atau Anda tidak berhak melihatnya.')).toBeTruthy();
  });
});

describe('schedules', () => {
  const DAILY = schedule({
    name: 'backup.daily',
    expr: '0 1 * * *',
    jobType: 'backup.schedule',
    exprEditable: true,
    permission: 'system.backup.create',
  });
  const EVENTS = schedule({ name: 'retention.events' });

  function scheduleRoutes(items: ScheduleView[]) {
    const state = { items: items.map((s) => ({ ...s })) };
    const routes: Record<string, FakeHandler> = {
      'GET schedules': () => ({ items: state.items }),
      'PATCH schedules/:name': (req) => {
        const s = state.items.find((i) => i.name === req.params['name']);
        if (s === undefined) return problem(404, 'NOT_FOUND');
        Object.assign(s, req.body as Partial<ScheduleView>);
        return s;
      },
    };
    return { state, routes };
  }

  it('lists the schedules with their times', async () => {
    startApp({ me: adminMe(), path: '/admin/jobs/schedules', routes: scheduleRoutes([DAILY, EVENTS]).routes });
    const table = await screen.findByRole('table');
    expect(within(table).getByText('Cadangan harian')).toBeTruthy();
    expect(within(table).getByText('Pembersihan event lama')).toBeTruthy();
    expect(within(table).getByText('Setiap jam, menit ke-17')).toBeTruthy();
  });

  it('the switch sends PATCH schedules/<name> {enabled: false}', async () => {
    const api = scheduleRoutes([DAILY, EVENTS]);
    const app = startApp({ me: adminMe(), path: '/admin/jobs/schedules', routes: api.routes });
    const toggle = await screen.findByRole('switch', { name: 'Aktifkan jadwal Pembersihan event lama' });
    expect((toggle as HTMLInputElement).checked).toBe(true);
    fireEvent.click(toggle);
    await waitFor(() => expect(app.writes()).toEqual(['PATCH schedules/retention.events']));
    const patch = app.requests.find((r) => r.method === 'PATCH');
    expect(patch?.body).toEqual({ enabled: false });
    await waitFor(() => expect((screen.getByRole('switch', { name: 'Aktifkan jadwal Pembersihan event lama' }) as HTMLInputElement).checked).toBe(false));
  });

  it('picking 02:30 for backup.daily sends {expr: "30 2 * * *"}', async () => {
    const api = scheduleRoutes([DAILY, EVENTS]);
    const app = startApp({ me: adminMe(), path: '/admin/jobs/schedules', routes: api.routes });
    const time = await screen.findByLabelText('Waktu Cadangan harian');
    expect((time as HTMLInputElement).value).toBe('01:00');
    fireEvent.change(time, { target: { value: '02:30' } });
    fireEvent.click(screen.getByRole('button', { name: 'Simpan waktu' }));
    await waitFor(() => expect(app.writes()).toEqual(['PATCH schedules/backup.daily']));
    expect(app.requests.find((r) => r.method === 'PATCH')?.body).toEqual({ expr: '30 2 * * *' });
  });

  it('without system.jobs.manage the switches and the time are read-only', async () => {
    startApp({
      me: signedIn({ permissions: ['system.jobs.read', 'system.backup.create'] }),
      path: '/admin/jobs/schedules',
      routes: scheduleRoutes([DAILY, EVENTS]).routes,
    });
    const toggle = await screen.findByRole('switch', { name: 'Aktifkan jadwal Pembersihan event lama' });
    expect((toggle as HTMLInputElement).disabled).toBe(true);
    expect((screen.getByLabelText('Waktu Cadangan harian') as HTMLInputElement).disabled).toBe(true);
    expect(screen.queryByRole('button', { name: 'Simpan waktu' })).toBeNull();
  });

  it('the daily backup needs its own permission besides system.jobs.manage', async () => {
    startApp({
      me: signedIn({ permissions: ['system.jobs.read', 'system.jobs.manage'] }),
      path: '/admin/jobs/schedules',
      routes: scheduleRoutes([DAILY, EVENTS]).routes,
    });
    expect(((await screen.findByRole('switch', { name: 'Aktifkan jadwal Cadangan harian' })) as HTMLInputElement).disabled).toBe(true);
    expect((screen.getByRole('switch', { name: 'Aktifkan jadwal Pembersihan event lama' }) as HTMLInputElement).disabled).toBe(false);
  });
});
