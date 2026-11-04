import { afterEach, describe, expect, it, vi } from 'vitest';
import { CRON_BOOT_WAIT_MS, cronWaitsForBoot, waitForBoot } from '../src/api/cron.js';
import { createApp, type AppState } from '../src/app.js';
import { recordingLogger } from './support.js';

// Ruling R1c-14: the phase gate lets a `POST /_cron` that reaches a process still booting wait for the boot, bounded
// inside the call's 20 s budget, instead of answering 503 while `starting`. No database: the bound and the phases.

afterEach(() => {
  vi.useRealTimers();
});

const app = (state: AppState) => createApp({ state, version: '0.1.0', buildId: 'b', log: recordingLogger() });

/** Whether `p` is still pending (fake timers: every microtask has run). */
async function pending(p: Promise<unknown>): Promise<boolean> {
  let settled = false;
  void p.then(
    () => (settled = true),
    () => (settled = true),
  );
  await vi.advanceTimersByTimeAsync(0);
  return !settled;
}

describe('the /_cron boot wait (ruling R1c-14)', () => {
  it('waits only in the phases a boot passes through, and never on a retired handler', () => {
    expect(CRON_BOOT_WAIT_MS).toBe(15_000);
    expect(cronWaitsForBoot({ phase: 'starting' })).toBe(true);
    expect(cronWaitsForBoot({ phase: 'db_unavailable' })).toBe(true);
    for (const phase of ['ready', 'ops_wait', 'not_installed', 'too_old'] as const) expect(cronWaitsForBoot({ phase })).toBe(false);
    expect(cronWaitsForBoot({ phase: 'starting', retired: true })).toBe(false);
  });

  it('ends once the process is ready with its job runtime, ops_wait, not installed or too old, or retired', async () => {
    vi.useFakeTimers({ toFake: ['setTimeout', 'clearTimeout', 'performance'] });
    for (const end of [
      (s: AppState) => (s.phase = 'ops_wait'),
      (s: AppState) => (s.phase = 'not_installed'),
      (s: AppState) => (s.phase = 'too_old'),
      (s: AppState) => (s.retired = true),
    ]) {
      const state: AppState = { phase: 'starting' };
      const wait = waitForBoot(state, () => false);
      await vi.advanceTimersByTimeAsync(1_000);
      expect(await pending(wait)).toBe(true);
      end(state);
      await vi.advanceTimersByTimeAsync(100);
      expect(await pending(wait)).toBe(false);
    }
    // `ready` alone is not enough: start() makes the job runtime right after it.
    const state: AppState = { phase: 'starting' };
    let jobs = false;
    const wait = waitForBoot(state, () => jobs);
    state.phase = 'ready';
    await vi.advanceTimersByTimeAsync(1_000);
    expect(await pending(wait)).toBe(true);
    jobs = true;
    await vi.advanceTimersByTimeAsync(100);
    expect(await pending(wait)).toBe(false);
  });

  it(`gives up after ${CRON_BOOT_WAIT_MS} ms: the phase gate then answers 503 DB_UNAVAILABLE as before`, async () => {
    vi.useFakeTimers({ toFake: ['setTimeout', 'clearTimeout', 'performance'] });
    const res = Promise.resolve(app({ phase: 'starting' }).request('/_cron', { method: 'POST', headers: { authorization: 'Bearer x' } }));
    await vi.advanceTimersByTimeAsync(CRON_BOOT_WAIT_MS - 100);
    expect(await pending(res)).toBe(true);
    await vi.advanceTimersByTimeAsync(100);
    expect(await pending(res)).toBe(false);
    const reply = await res;
    expect(reply.status).toBe(503);
    expect(((await reply.json()) as { code: string }).code).toBe('DB_UNAVAILABLE');
  });

  it('only a POST /_cron waits: any other request of a starting process is answered at once', async () => {
    vi.useFakeTimers({ toFake: ['setTimeout', 'clearTimeout', 'performance'] });
    const starting = app({ phase: 'starting' });
    for (const [path, method] of [
      ['/_cron', 'GET'],
      ['/api/v1/auth/me', 'GET'],
      ['/api/v1/auth/login', 'POST'],
    ] as const) {
      const res = Promise.resolve(starting.request(path, { method }));
      expect(await pending(res), `${method} ${path}`).toBe(false);
      expect((await res).status).toBe(503);
    }
  });
});
