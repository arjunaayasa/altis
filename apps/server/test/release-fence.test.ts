import fsp from 'node:fs/promises';
import os from 'node:os';
import path from 'node:path';
import { readCurrentState, updateCurrentState } from '@altis/platform';
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import type { AppState } from '../src/app.js';
import { createReleaseFence, releaseRestart, type ReleaseChange } from '../src/http/release-fence.js';
import { createJobRuntime, jobHandlers } from '../src/jobs/runtime.js';
import { createAppOps } from '../src/services.js';
import { recordingLogger } from './support.js';

// The release part of the §9.3 fence (plan Task 25; decision D1d-20; preflight 1D-21): `{active, pending}` of
// DATA_DIR/releases/current.json against this process's snapshot, looked at by requests and the worker loop at most
// every 2 s (never on a timer). A change fires `onChange` once per version: the process stops claiming, drains and asks
// for a restart, unless tmp/restart.txt was touched since `pendingSince` (Passenger restarts the pool then already, and
// a second touch would restart the boot-lock holder too). The process's own promotion is followed by `rebase()`.

const V1 = '0.1.0-test';
const V2 = '0.2.0-test';

let root: string;
let dataDir: string;
let appRoot: string;
let now: number;
const clock = (): number => now;

beforeEach(async () => {
  root = await fsp.realpath(await fsp.mkdtemp(path.join(os.tmpdir(), 'altis-release-fence-')));
  dataDir = path.join(root, 'data');
  appRoot = path.join(root, 'app');
  await fsp.mkdir(dataDir, { recursive: true });
  await readCurrentState(dataDir, V1); // active 0.1.0-test (bundled)
  now = Date.UTC(2026, 9, 30, 3, 0, 0);
});

afterEach(async () => {
  vi.restoreAllMocks();
  await fsp.rm(root, { recursive: true, force: true });
});

/** What another process does at the update's point of no return: `pending` = 0.2, `pendingSince`. */
async function setPending(at = Date.now()): Promise<void> {
  await updateCurrentState(dataDir, (s) => ({ ...s, pending: { version: V2, source: 'data' }, pendingSince: at, pinned: null }));
}

/** app.js's promotion of 0.2. */
async function promote(): Promise<void> {
  await updateCurrentState(dataDir, (s) => (s.pending === null ? null : { ...s, previous: s.active, active: s.pending, pending: null, pendingSince: null }));
}

describe('createReleaseFence', () => {
  it('another process sets pending → onChange once, not before 2 s; the change names the versions and pendingSince', async () => {
    const changes: ReleaseChange[] = [];
    const fence = createReleaseFence({ dataDir, clock, onChange: (c) => changes.push(c) });
    await fence.rebase(); // the boot snapshot: {0.1, null}
    await fence.check();
    expect(changes).toEqual([]);
    const since = Date.now();
    await setPending(since);
    now += 1000;
    await fence.check(); // 1 s after the last look: no look
    expect(changes).toEqual([]);
    expect(fence.changed()).toBe(false);
    now += 1000;
    await fence.check();
    expect(changes).toEqual([{ active: V1, pending: V2, pendingSince: since }]);
    expect(fence.changed()).toBe(true);
    // At most once per pending version: later looks, and the promotion of that same version, fire nothing more.
    now += 2000;
    await fence.check();
    await promote();
    now += 2000;
    await fence.check();
    expect(changes).toHaveLength(1);
  });

  it('the first look learns the snapshot when nothing rebased it', async () => {
    const onChange = vi.fn();
    const fence = createReleaseFence({ dataDir, clock, onChange });
    await fence.check();
    now += 2000;
    await fence.check();
    expect(onChange).not.toHaveBeenCalled();
    await setPending();
    now += 2000;
    await fence.check();
    expect(onChange).toHaveBeenCalledTimes(1);
  });

  it("after the process's own promotion and rebase(), no restart", async () => {
    await setPending();
    const onChange = vi.fn();
    const fence = createReleaseFence({ dataDir, clock, onChange }); // the pending boot of 0.2: {0.1, 0.2}
    await fence.rebase();
    await promote(); // markHealthy
    await fence.rebase();
    for (let i = 0; i < 3; i += 1) {
      now += 2000;
      await fence.check();
    }
    expect(onChange).not.toHaveBeenCalled();
    expect(fence.changed()).toBe(false);
    // A manual rollback later is a change again.
    await updateCurrentState(dataDir, (s) => ({ ...s, active: s.previous!, previous: null, pinned: V2 }));
    now += 2000;
    await fence.check();
    expect(onChange).toHaveBeenCalledTimes(1);
  });

  it('concurrent checks share one look; a clock that went back counts as due', async () => {
    const onChange = vi.fn();
    const fence = createReleaseFence({ dataDir, clock, onChange });
    await fence.rebase();
    await setPending();
    now += 2000;
    await Promise.all([fence.check(), fence.check(), fence.check()]);
    expect(onChange).toHaveBeenCalledTimes(1);

    const other = createReleaseFence({ dataDir, clock, onChange: vi.fn() });
    await other.rebase();
    await updateCurrentState(dataDir, (s) => ({ ...s, pending: null, pendingSince: null }));
    now -= 60_000;
    await other.check();
    expect(other.changed()).toBe(true);
  });

  it('a current.json that cannot be read keeps what the fence knew, logged once; check() never rejects', async () => {
    const log = recordingLogger();
    const onChange = vi.fn();
    const fence = createReleaseFence({ dataDir, clock, onChange, log });
    await fence.rebase();
    const file = path.join(dataDir, 'releases', 'current.json');
    await fsp.writeFile(file, '{torn');
    await fsp.writeFile(`${file}.bak`, '{torn');
    for (let i = 0; i < 3; i += 1) {
      now += 2000;
      await expect(fence.check()).resolves.toBeUndefined();
    }
    expect(onChange).not.toHaveBeenCalled();
    expect(log.lines.filter((l) => l.level === 'error')).toHaveLength(1);
  });

  it('intervalMs must be a finite number of at least 0', () => {
    expect(() => createReleaseFence({ dataDir, clock, onChange: () => {}, intervalMs: -1 })).toThrow(TypeError);
    expect(() => createReleaseFence({ dataDir, clock, onChange: () => {}, intervalMs: Number.NaN })).toThrow(TypeError);
  });
});

describe('releaseRestart (1D-21)', () => {
  /** ctx.requestRestart under Passenger: touches <appRoot>/tmp/restart.txt. */
  function passengerRestart(): { requestRestart: (reason: string) => Promise<void>; reasons: string[] } {
    const reasons: string[] = [];
    return {
      reasons,
      async requestRestart(reason) {
        reasons.push(reason);
        await fsp.mkdir(path.join(appRoot, 'tmp'), { recursive: true });
        const file = path.join(appRoot, 'tmp', 'restart.txt');
        await fsp.writeFile(file, '');
        const at = new Date();
        await fsp.utimes(file, at, at);
      },
    };
  }

  it('two old processes seeing the same pending change → one requestRestart, the second skipped by the restart.txt mtime; both stop claiming', async () => {
    const restart = passengerRestart();
    const stops = [vi.fn(async () => {}), vi.fn(async () => {})];
    const outcomes: Promise<'requested' | 'skipped'>[] = [];
    const fences = stops.map((stopClaims) => {
      const onChange = releaseRestart({ appRoot, runtime: 'passenger', requestRestart: restart.requestRestart, stopClaims, log: recordingLogger() });
      return createReleaseFence({ dataDir, clock, onChange: (c) => outcomes.push(onChange(c)) });
    });
    for (const f of fences) await f.rebase();
    await setPending(Date.now() - 1500);
    now += 2000;
    await fences[0]!.check();
    expect(await outcomes[0]).toBe('requested');
    await fences[1]!.check();
    expect(await outcomes[1]).toBe('skipped');
    expect(restart.reasons).toEqual(['release']);
    expect(stops[0]).toHaveBeenCalledTimes(1);
    expect(stops[1]).toHaveBeenCalledTimes(1);
  });

  it('a change without pendingSince (a promotion or a rollback seen late) asks for the restart', async () => {
    const restart = passengerRestart();
    await restart.requestRestart('earlier'); // a touch long ago does not matter
    const onChange = releaseRestart({ appRoot, runtime: 'passenger', requestRestart: restart.requestRestart, stopClaims: async () => {}, log: recordingLogger() });
    expect(await onChange({ active: V2, pending: null, pendingSince: null })).toBe('requested');
    expect(restart.reasons).toEqual(['earlier', 'release']);
  });

  it('outside Passenger and LiteSpeed restart.txt restarts nothing: every process asks for its own restart', async () => {
    const restart = passengerRestart();
    await restart.requestRestart('update'); // touched after pendingSince
    for (const runtime of ['pm2', 'docker', 'service', 'standalone'] as const) {
      const onChange = releaseRestart({ appRoot, runtime, requestRestart: restart.requestRestart, stopClaims: async () => {}, log: recordingLogger() });
      expect(await onChange({ active: V1, pending: V2, pendingSince: Date.now() - 60_000 }), runtime).toBe('requested');
    }
    const litespeed = releaseRestart({ appRoot, runtime: 'litespeed', requestRestart: restart.requestRestart, stopClaims: async () => {}, log: recordingLogger() });
    expect(await litespeed({ active: V1, pending: V2, pendingSince: Date.now() - 60_000 })).toBe('skipped');
  });

  it('a stopClaims or requestRestart that fails is logged, never thrown', async () => {
    const log = recordingLogger();
    const onChange = releaseRestart({
      appRoot,
      runtime: 'passenger',
      requestRestart: async () => {
        throw new Error('no restart');
      },
      stopClaims: async () => {
        throw new Error('no drain');
      },
      log,
    });
    await expect(onChange({ active: V1, pending: V2, pendingSince: Date.now() })).resolves.toBe('requested');
    expect(log.lines.filter((l) => l.level === 'warn' || l.level === 'error').length).toBeGreaterThanOrEqual(2);
  });
});

describe('the job runtime and the release fence', () => {
  it('the worker loop checks the fence before each pass and stops claiming once it changed; cron() claims nothing then', async () => {
    const log = recordingLogger();
    const state: AppState = { phase: 'ready' };
    const ops = createAppOps(state, { dataDir, version: V1, log, clock });
    const fence = createReleaseFence({ dataDir, clock, onChange: () => {} });
    await fence.rebase();
    const check = vi.spyOn(fence, 'check');
    const rt = createJobRuntime({
      state,
      runtime: 'pm2',
      env: {},
      dataDir,
      log,
      clock,
      ops,
      handlers: jobHandlers(),
      requestRestart: async () => {},
      installId: 'install',
      appVersion: V1,
      fences: () => [],
      releaseFence: fence,
    });
    const pass = vi.spyOn(rt.runner, 'pass').mockResolvedValue({ op: null, scheduled: 0, slices: 1 });
    try {
      rt.start();
      await vi.waitFor(() => expect(pass.mock.calls.length).toBeGreaterThanOrEqual(2), { timeout: 5000, interval: 10 });
      expect(check).toHaveBeenCalled();
      await setPending();
      now += 2000;
      await vi.waitFor(() => expect(fence.changed()).toBe(true), { timeout: 5000, interval: 10 });
      const calls = pass.mock.calls.length;
      await new Promise((resolve) => setTimeout(resolve, 300));
      expect(pass.mock.calls.length).toBeLessThanOrEqual(calls + 1); // at most the pass under way when it changed
      const settled = pass.mock.calls.length;
      await new Promise((resolve) => setTimeout(resolve, 300));
      expect(pass.mock.calls.length).toBe(settled);
      expect(await rt.cron('cron_http', 1000)).toEqual({ op: null, scheduled: 0, slices: 0 });
      expect(pass.mock.calls.length).toBe(settled);
    } finally {
      await rt.stop();
    }
  });
});
