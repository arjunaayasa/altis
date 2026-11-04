import type { EventsResponse } from '@altis/shared/api/events';
import type { JobView } from '@altis/shared/api/jobs';
import { screen, waitFor } from '@testing-library/react';
import { afterEach, describe, expect, it, vi } from 'vitest';
import { MAINTENANCE_RETRY_MS } from '@/lib/maintenance';
import { BRANCH_MAIN, adminMe, problem, startApp, type FakeRequest, type SignedIn } from './fake-api';

// A staff session ends after 30 minutes without activity (spec §7.1). The realtime client reads its events in the
// background (`X-Altis-Background: 1`: the server neither touches nor rotates the session for it), and so must every
// request it causes by itself: an unattended tab must not keep its session alive. The requests the user's own actions
// cause (opening a page) stay foreground.

afterEach(() => {
  vi.unstubAllGlobals();
  vi.restoreAllMocks();
});

const AT = 1_760_000_000_000;
const JOB_ID = '01JZ000000000000000000JOB1';

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

type App = ReturnType<typeof startApp>;

/** For each `GET /api/v1/<path>` the app sent (in order): whether it went out with `X-Altis-Background: 1`. */
function gets(app: App, path: string): boolean[] {
  return app.fetchMock.mock.calls
    .filter(([url, init]) => (init?.method ?? 'GET') === 'GET' && new URL(String(url), 'https://altis.test').pathname === `/api/v1/${path}`)
    .map(([, init]) => (init?.headers as Record<string, string> | undefined)?.['X-Altis-Background'] === '1');
}

const NOTIFICATIONS = { 'GET notifications': () => ({ items: [], unread: 0, nextBefore: null }) };

/** An EventSource the server refuses at once (a 204 over the stream limit, a 409, a 403): the browser gives up. */
class RefusedEventSource extends EventTarget {
  readyState = 0;
  constructor(readonly url: string) {
    super();
    setTimeout(() => {
      this.readyState = 2;
      this.dispatchEvent(new Event('error'));
    }, 0);
  }
  close(): void {
    this.readyState = 2;
  }
}

const sseMe = (): SignedIn => ({ ...adminMe(), client: { realtime: 'sse', methodOverride: false, chunkBytes: 5 * 1024 * 1024, probedAt: null, runner: 'worker' } });

describe('requests the realtime client causes by itself go out in the background', () => {
  it("a job.progress event reads the job again in the background; the page's first read stays the user's", async () => {
    let sent = false;
    const app = startApp({
      me: adminMe(),
      path: `/admin/jobs/${JOB_ID}`,
      routes: {
        ...NOTIFICATIONS,
        'GET jobs/:id': () => job({ progress: sent ? 60 : 10 }),
        'GET events': (req: FakeRequest): EventsResponse => {
          if (sent || !(req.query.get('channels')?.split(',') ?? []).includes(`jobs.${JOB_ID}`)) return { cursor: '1.6', events: [] };
          sent = true;
          return { cursor: '1.7', events: [{ seq: 7, channel: `jobs.${JOB_ID}`, type: 'job.progress', payload: { status: 'running', progress: 60 }, at: AT }] };
        },
      },
    });
    await waitFor(() => expect(gets(app, `jobs/${JOB_ID}`)).toHaveLength(2), { timeout: 4000 });
    expect(gets(app, `jobs/${JOB_ID}`)).toEqual([false, true]);
  });

  it('a backup.progress event reads the backups list again in the background', async () => {
    let listed = false;
    let sent = false;
    const app = startApp({
      me: adminMe(),
      path: '/admin/backups',
      routes: {
        ...NOTIFICATIONS,
        'GET backups': () => {
          listed = true;
          return { items: [], nextScheduledAt: null };
        },
        // The event comes once the list was read (an event during the first read joins it).
        'GET events': (): EventsResponse => {
          if (sent || !listed) return { cursor: '1.6', events: [] };
          sent = true;
          return { cursor: '1.7', events: [{ seq: 7, channel: 'system.backup', type: 'backup.progress', payload: { backupId: 'B1', progress: 5 }, at: AT }] };
        },
      },
    });
    await waitFor(() => expect(gets(app, 'backups')).toHaveLength(2), { timeout: 4000 });
    expect(gets(app, 'backups')).toEqual([false, true]);
  });

  it('SSE refused twice (the 5-minute back-off) reads auth/me again in the background', async () => {
    vi.stubGlobal('EventSource', RefusedEventSource);
    const app = startApp({ me: sseMe(), path: '/admin', routes: { ...NOTIFICATIONS, 'GET events': () => ({ cursor: '1.1', events: [] }) } });
    await waitFor(() => expect(gets(app, 'auth/me').length).toBeGreaterThanOrEqual(2), { timeout: 4000 });
    const [first, ...later] = gets(app, 'auth/me');
    expect(first).toBe(false);
    expect(later.every(Boolean)).toBe(true);
  });

  it('a poll refused for the tab\'s own channels (its rights changed) reads auth/me again in the background', async () => {
    const app = startApp({ me: adminMe(), path: '/admin', routes: { ...NOTIFICATIONS, 'GET events': () => problem(403, 'AUTHZ_DENIED') } });
    await waitFor(() => expect(gets(app, 'auth/me').length).toBeGreaterThanOrEqual(2), { timeout: 4000 });
    const [first, ...later] = gets(app, 'auth/me');
    expect(first).toBe(false);
    expect(later.every(Boolean)).toBe(true);
  });
});

describe('the maintenance screen lifting itself', () => {
  afterEach(() => {
    vi.useRealTimers();
  });

  it('reads the queries refused meanwhile again, in the background, so the screen below recovers by itself', async () => {
    vi.useFakeTimers({ shouldAdvanceTime: true });
    let down = true;
    const app = startApp({
      me: adminMe(),
      path: '/admin/branches',
      routes: {
        ...NOTIFICATIONS,
        'GET events': () => ({ cursor: '1.1', events: [] }),
        // A restore another admin runs (the admin may not follow it on the operations page): the blocking screen.
        'GET branches': () => (down ? problem(503, 'MAINTENANCE', { reason: 'restore' }) : { items: [BRANCH_MAIN] }),
      },
    });
    const screenUp = (): boolean => document.querySelector('[data-maintenance-screen]') !== null;
    await waitFor(() => expect(screenUp()).toBe(true));
    expect(gets(app, 'branches')).toEqual([false]);
    down = false;
    await vi.advanceTimersByTimeAsync(MAINTENANCE_RETRY_MS);
    await waitFor(() => expect(screenUp()).toBe(false));
    expect(await screen.findByText('PUSAT')).toBeTruthy();
    expect(gets(app, 'branches')).toEqual([false, true]);
  });
});
