import type { DashboardResponse } from '@altis/shared/api/dashboard';
import type { EventItem } from '@altis/shared/api/events';
import type { JobView } from '@altis/shared/api/jobs';
import { QueryClient, QueryClientProvider } from '@tanstack/react-query';
import { act, render, screen, waitFor } from '@testing-library/react';
import type { ReactNode } from 'react';
import { afterEach, describe, expect, it, vi } from 'vitest';
import { JOB_POLL_MS, JobProgress } from '@/components/job-progress';
import { ME_KEY } from '@/lib/me';
import { RealtimeContext, type RealtimeHub } from '@/lib/realtime';
import { json, signedIn } from '../fake-api';

// JobProgress (plan Task 4): a job's progress, live on `jobs.<id>` with `GET jobs/:id` polling as the fallback, and the
// terminal status handed to `onDone` once. An interactive job is driven from the page where no worker runs (§10.2).

afterEach(() => {
  vi.useRealTimers();
  vi.unstubAllGlobals();
  vi.restoreAllMocks();
});

const T0 = 1_760_000_000_000;

function jobView(o: Partial<JobView> = {}): JobView {
  return {
    id: 'J1',
    type: 'catalog.import',
    status: 'running',
    progress: 10,
    progressMessage: null,
    attempts: 1,
    maxAttempts: 3,
    lastError: null,
    runAt: T0,
    createdAt: T0,
    updatedAt: T0,
    finishedAt: null,
    createdBy: 'U1',
    retryable: 'origin-only',
    cancellable: true,
    interactive: false,
    ...o,
  };
}

function dashboardIn(mode: 'worker' | 'external'): DashboardResponse {
  return {
    version: { current: '0.1.0', appJs: null, bootProtocol: 1, update: null },
    edition: { edition: 'community', status: 'active' },
    lastBackup: null,
    nextBackupAt: null,
    queue: { queued: 0, running: 1, dead: 0, oldestQueuedMs: null },
    scheduler: { runner: { mode, lastRuns: {} }, schedules: [] },
    alerts: [],
  };
}

/** A hub the test drives: it records the subscriptions and hands them the events the test sends. */
function fakeHub() {
  const subs = new Set<{ channels: readonly string[]; onEvent(e: EventItem): void }>();
  const hub: RealtimeHub = {
    subscribe(channels, onEvent) {
      const s = { channels, onEvent };
      subs.add(s);
      return () => subs.delete(s);
    },
    start() {},
    stop() {},
    refresh() {},
  };
  let seq = 0;
  const send = (type: string, payload: Record<string, unknown>, channel = 'jobs.J1') => {
    seq += 1;
    const e: EventItem = { seq, channel, type, payload, at: T0 + seq };
    for (const s of [...subs]) if (s.channels.includes(channel)) s.onEvent(e);
  };
  return { hub, send, channels: () => [...subs].flatMap((s) => [...s.channels]) };
}

/** A fake `/api/v1` for the component: `routes['METHOD path']` answers; anything else is a 404 problem. */
function stubApi(routes: Record<string, () => unknown>) {
  const calls: string[] = [];
  const fetchMock = vi.fn<typeof fetch>(async (input, init) => {
    const url = new URL(String(input), 'https://altis.test');
    const key = `${init?.method ?? 'GET'} ${url.pathname.replace(/^\/api\/v1\//, '')}`;
    calls.push(key);
    const handler = routes[key];
    if (handler === undefined) {
      return new Response(JSON.stringify({ status: 404, code: 'NOT_FOUND' }), { status: 404, headers: { 'Content-Type': 'application/problem+json' } });
    }
    return json(handler());
  });
  vi.stubGlobal('fetch', fetchMock);
  return { calls };
}

function renderWith(node: ReactNode, hub: RealtimeHub | null, me = signedIn({ id: 'U1', permissions: [] })) {
  const queryClient = new QueryClient({ defaultOptions: { queries: { retry: false } } });
  // Signed in already: the component's reads wait for auth/me (useApiQuery), which the cache answers.
  queryClient.setQueryData(ME_KEY, me);
  return render(
    <QueryClientProvider client={queryClient}>
      <RealtimeContext.Provider value={hub}>{node}</RealtimeContext.Provider>
    </QueryClientProvider>,
  );
}

const bar = (): HTMLElement => screen.getByRole('progressbar');

describe('JobProgress', () => {
  it('shows progress from a realtime event and calls onDone("succeeded") once', async () => {
    let current = jobView();
    stubApi({ 'GET jobs/J1': () => current, 'GET dashboard': () => dashboardIn('worker') });
    const { hub, send, channels } = fakeHub();
    const onDone = vi.fn();
    renderWith(<JobProgress jobId="J1" onDone={onDone} />, hub);

    await waitFor(() => expect(bar().getAttribute('aria-valuenow')).toBe('10'));
    // Subscribed once the job was read (a channel the caller may not read would refuse the whole poll, §10.7).
    await waitFor(() => expect(channels()).toEqual(['jobs.J1']));

    act(() => send('job.progress', { status: 'running', progress: 55 }));
    await waitFor(() => expect(bar().getAttribute('aria-valuenow')).toBe('55'));
    expect(screen.getByText('55 %')).toBeTruthy();
    expect(onDone).not.toHaveBeenCalled();

    current = jobView({ status: 'succeeded', progress: 100, finishedAt: T0 + 5 });
    act(() => send('job.finished', { status: 'succeeded' }));
    await waitFor(() => expect(onDone).toHaveBeenCalledWith('succeeded'));
    expect(screen.getByText('Berhasil')).toBeTruthy();
    // Another event of the same job does not call it again.
    act(() => send('job.finished', { status: 'succeeded' }));
    await act(async () => {
      await new Promise((r) => setTimeout(r, 20));
    });
    expect(onDone).toHaveBeenCalledTimes(1);
  });

  it('ignores an event of another channel and a payload that is not a status', async () => {
    stubApi({ 'GET jobs/J1': () => jobView({ progress: 30 }) });
    const { hub, send } = fakeHub();
    const onDone = vi.fn();
    renderWith(<JobProgress jobId="J1" onDone={onDone} />, hub);
    await waitFor(() => expect(bar().getAttribute('aria-valuenow')).toBe('30'));
    act(() => send('job.finished', { status: 'succeeded' }, 'jobs.J2'));
    act(() => send('job.progress', { status: 'exploded', progress: 'x' }));
    await act(async () => {
      await new Promise((r) => setTimeout(r, 20));
    });
    expect(bar().getAttribute('aria-valuenow')).toBe('30');
    expect(onDone).not.toHaveBeenCalled();
  });

  it('without realtime, polls GET jobs/:id until the job ends, then stops polling', async () => {
    vi.useFakeTimers({ shouldAdvanceTime: true });
    let reads = 0;
    const { calls } = stubApi({
      'GET jobs/J1': () => {
        reads += 1;
        return reads < 3 ? jobView({ progress: reads * 20 }) : jobView({ status: 'dead', progress: 40, lastError: 'CATALOG_IMPORT_FORMAT' });
      },
    });
    const onDone = vi.fn();
    renderWith(<JobProgress jobId="J1" onDone={onDone} />, null);
    await waitFor(() => expect(bar().getAttribute('aria-valuenow')).toBe('20'));
    await act(() => vi.advanceTimersByTimeAsync(JOB_POLL_MS));
    await waitFor(() => expect(bar().getAttribute('aria-valuenow')).toBe('40'));
    await act(() => vi.advanceTimersByTimeAsync(JOB_POLL_MS));
    await waitFor(() => expect(onDone).toHaveBeenCalledWith('dead'));
    expect(screen.getByText('CATALOG_IMPORT_FORMAT')).toBeTruthy();
    const before = calls.filter((c) => c === 'GET jobs/J1').length;
    await act(() => vi.advanceTimersByTimeAsync(JOB_POLL_MS * 5));
    expect(calls.filter((c) => c === 'GET jobs/J1').length).toBe(before);
    expect(onDone).toHaveBeenCalledTimes(1);
  });

  it('drives an interactive job from the page when no worker runs, until it ends', async () => {
    let drives = 0;
    const { calls } = stubApi({
      'GET jobs/J1': () => jobView({ interactive: true, progress: 0 }),
      'GET dashboard': () => dashboardIn('external'),
      'POST jobs/J1/drive': () => {
        drives += 1;
        return drives < 2
          ? jobView({ interactive: true, progress: 50, updatedAt: T0 + drives })
          : jobView({ interactive: true, status: 'succeeded', progress: 100, updatedAt: T0 + drives });
      },
    });
    const onDone = vi.fn();
    renderWith(<JobProgress jobId="J1" onDone={onDone} />, null);
    await waitFor(() => expect(onDone).toHaveBeenCalledWith('succeeded'), { timeout: 4000 });
    expect(calls.filter((c) => c === 'POST jobs/J1/drive')).toHaveLength(2);
    expect(bar().getAttribute('aria-valuenow')).toBe('100');
  });

  it('never drives where a worker runs the jobs, nor a job that is not interactive', async () => {
    vi.useFakeTimers({ shouldAdvanceTime: true });
    const { calls } = stubApi({
      'GET jobs/J1': () => jobView({ interactive: true }),
      'GET jobs/J2': () => jobView({ id: 'J2', interactive: false }),
      'GET dashboard': () => dashboardIn('worker'),
    });
    renderWith(
      <>
        <JobProgress jobId="J1" onDone={() => {}} />
        <JobProgress jobId="J2" onDone={() => {}} />
      </>,
      null,
    );
    await waitFor(() => expect(calls).toContain('GET dashboard'));
    await act(() => vi.advanceTimersByTimeAsync(JOB_POLL_MS * 2));
    expect(calls.filter((c) => c.startsWith('POST'))).toEqual([]);
  });

  it('says so when the job cannot be read', async () => {
    stubApi({});
    renderWith(<JobProgress jobId="J1" onDone={() => {}} />, null);
    expect(await screen.findByText('Tugas tidak ditemukan, atau Anda tidak berhak melihatnya.')).toBeTruthy();
  });

  // C26/E22b: `GET jobs/:id` also answers a holder of an interactive job's handler permission (whom drive accepts),
  // for a job the system queued (no creator). Its channel `jobs.<id>` stays the creator's and system.jobs.read's (§10.7).
  describe("a job read through its handler's permission (not the caller's, no system.jobs.read)", () => {
    const systems = (o: Partial<JobView> = {}): JobView => jobView({ createdBy: null, interactive: true, payload: { scope: 'all' }, ...o });

    it('is driven from the page where no worker runs, until it ends', async () => {
      let drives = 0;
      const { calls } = stubApi({
        'GET jobs/J1': () => systems({ progress: 0 }),
        'POST jobs/J1/drive': () => {
          drives += 1;
          return drives < 2 ? systems({ progress: 50, updatedAt: T0 + drives }) : systems({ status: 'succeeded', progress: 100, updatedAt: T0 + drives });
        },
      });
      const onDone = vi.fn();
      renderWith(<JobProgress jobId="J1" onDone={onDone} />, fakeHub().hub);
      await waitFor(() => expect(onDone).toHaveBeenCalledWith('succeeded'), { timeout: 4000 });
      expect(calls.filter((c) => c === 'POST jobs/J1/drive')).toHaveLength(2);
    });

    it('is never subscribed to (a refused channel refuses the whole poll), so it is read at the pace of a page without realtime', async () => {
      vi.useFakeTimers({ shouldAdvanceTime: true });
      let reads = 0;
      stubApi({
        'GET jobs/J1': () => {
          reads += 1;
          return systems();
        },
        'GET dashboard': () => dashboardIn('worker'),
      });
      const { hub, channels } = fakeHub();
      renderWith(<JobProgress jobId="J1" onDone={() => {}} />, hub);
      await waitFor(() => expect(bar().getAttribute('aria-valuenow')).toBe('10'));
      const first = reads;
      await act(() => vi.advanceTimersByTimeAsync(JOB_POLL_MS));
      await waitFor(() => expect(reads).toBe(first + 1));
      expect(channels()).toEqual([]);
    });

    it('a holder of system.jobs.read is subscribed to it', async () => {
      stubApi({ 'GET jobs/J1': () => systems(), 'GET dashboard': () => dashboardIn('worker') });
      const { hub, channels } = fakeHub();
      renderWith(<JobProgress jobId="J1" onDone={() => {}} />, hub, signedIn({ id: 'U1', permissions: ['system.jobs.read'] }));
      await waitFor(() => expect(channels()).toEqual(['jobs.J1']));
    });
  });
});
