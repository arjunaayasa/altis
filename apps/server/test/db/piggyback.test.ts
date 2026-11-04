import fsp from 'node:fs/promises';
import os from 'node:os';
import path from 'node:path';
import { enqueue, writeMaintenance, type JobContext, type JobHandler, type OpsMachine } from '@altis/core';
import { PHASE1_MIGRATIONS, runMigrations, upsert, withTx } from '@altis/db';
import type { Runtime } from '@altis/platform';
import { z } from 'zod';
import { afterAll, afterEach, beforeAll, beforeEach, describe, expect, it, vi } from 'vitest';
import { engineLabel, testDb, testDbContext, type TestDbHandle } from '../../../../tools/test/test-db.js';
import { createApp, type AppState } from '../../src/app.js';
import { createJobRuntime, type JobRuntime } from '../../src/jobs/runtime.js';
import { createAppOps } from '../../src/services.js';
import { recordingLogger, sampleConfig } from '../support.js';

// Piggyback (spec §10.2, decision C36; Review Focus 1: cPanel without cron, the admin's tab closed) on the engine
// picked by ALTIS_TEST_DB, runtime `passenger`: after an ordinary response, a process that has seen no worker or cron
// run for 10 minutes runs one light slice of ≤ 2 s, at most once per 30 s, never for health, assets or the cron call,
// never a heavy job, never during maintenance; and the slice keeps yielding to the event loop.

const ctx = testDbContext();
const NOW = Date.UTC(2026, 9, 20, 9, 0, 5);
const CONFIG = sampleConfig({ db: { dialect: 'sqlite' } });

type P = { k: number; n: number };
const payload = z.strictObject({ k: z.number().int().min(1), n: z.number().int().min(1) });
const ran = vi.fn<(type: string, k: number, mode: string) => void>();

function handler(type: string, extra: Partial<JobHandler<P>> = {}): JobHandler<P> {
  return {
    type,
    permission: 'system.jobs.manage',
    retryable: 'api',
    payload,
    async run(c: JobContext, p: P) {
      ran(type, p.k, c.mode);
      return p.k >= p.n ? { done: true } : { continueWith: { k: p.k + 1, n: p.n }, progress: 10 };
    },
    ...extra,
  };
}

/** Busy for ~800 ms in 5 ms steps, calling heartbeat() after each (it yields every 50 ms in piggyback mode). */
let sliceRunning = false;
const yielding: JobHandler<P> = {
  ...handler('test.yielding'),
  async run(c, p) {
    ran('test.yielding', p.k, c.mode);
    sliceRunning = true;
    const start = performance.now();
    while (performance.now() - start < 800) {
      const step = performance.now();
      while (performance.now() - step < 5) {
        // a CPU-bound step of the slice
      }
      await c.heartbeat();
    }
    sliceRunning = false;
    return { done: true };
  },
};

const threadCpuUsage = (process as { threadCpuUsage?: () => NodeJS.CpuUsage }).threadCpuUsage;

/**
 * The CPU time this thread has run, in ms: process.threadCpuUsage (Node 22.19+); before it, the process's CPU time,
 * which bounds the thread's from above.
 */
function cpuMs(): number {
  const u = threadCpuUsage === undefined ? process.cpuUsage() : threadCpuUsage.call(process);
  return (u.user + u.system) / 1000;
}

const HANDLERS = [handler('test.light'), handler('test.heavy', { cpuHeavy: true }), handler('test.long', { longRunning: true }), yielding];

describe.skipIf(!ctx.available)(`piggyback [${engineLabel()}]`, () => {
  let h: TestDbHandle;
  let migDir: string;
  let dataDir: string;
  let now: number;
  let state: AppState;
  let runtime: JobRuntime;
  let ops: OpsMachine;
  let app: ReturnType<typeof createApp>;

  beforeAll(async () => {
    h = await testDb();
    migDir = await fsp.mkdtemp(path.join(os.tmpdir(), 'altis-piggyback-mig-'));
    await runMigrations(h, { appVersion: '0.1.0', dataDir: migDir, migrations: PHASE1_MIGRATIONS });
  });

  afterAll(async () => {
    await h?.close();
    if (migDir !== undefined) await fsp.rm(migDir, { recursive: true, force: true });
  });

  beforeEach(async () => {
    for (const table of ['jobs', 'locks', 'settings', 'events', 'notifications'] as const) await h.db.deleteFrom(table).execute();
    dataDir = await fsp.realpath(await fsp.mkdtemp(path.join(os.tmpdir(), 'altis-piggyback-')));
    now = NOW;
    ran.mockClear();
    sliceRunning = false;
    build();
  });

  afterEach(async () => {
    await runtime.stop();
    await fsp.rm(dataDir, { recursive: true, force: true });
  });

  /** The app as start() builds it on `runtimeName`, with a fresh runtime (so a fresh per-process piggyback time). */
  function build(runtimeName: Runtime = 'passenger', clock: () => number = () => now): void {
    const log = recordingLogger();
    state = { phase: 'ready', db: h, config: CONFIG };
    ops = createAppOps(state, { dataDir, version: '0.1.0', log, clock });
    runtime = createJobRuntime({
      state,
      runtime: runtimeName,
      env: {},
      dataDir,
      log,
      clock,
      ops,
      handlers: HANDLERS,
      requestRestart: async () => {},
      installId: CONFIG.install.id,
      appVersion: '0.1.0',
    });
    state.jobs = runtime;
    app = createApp({ state, version: '0.1.0', buildId: 'b', log, clock, env: {}, dataDir, runtime: runtimeName, services: { ops } });
  }

  const get = (urlPath: string) => app.request(urlPath, {}, { incoming: { socket: { remoteAddress: '203.0.113.7' } } });
  const put = (type: string, n = 3, runAt = now) =>
    withTx(h, (trx) => enqueue(trx, runtime.registry, { type, payload: { k: 1, n }, runAt }, { now, keyring: CONFIG.keyring })).then((r) => r.id);
  const status = async (id: string) => (await h.db.selectFrom('jobs').select('status').where('id', '=', id).executeTakeFirstOrThrow()).status;
  const quiet = () => new Promise((resolve) => setTimeout(resolve, 150));

  it('with no run recorded, a page view runs one light slice right after its response; none for /_health or assets', async () => {
    const id = await put('test.light');
    expect((await get('/_health')).status).toBe(200);
    await get('/admin/assets/x.js');
    await get('/assets/opac.css');
    await quiet();
    expect(ran).not.toHaveBeenCalled();

    expect((await get('/api/v1/auth/me')).status).toBe(200);
    await vi.waitFor(() => expect(ran).toHaveBeenCalledWith('test.light', 1, 'piggyback'), { timeout: 2000 });
    await quiet();
    expect(ran).toHaveBeenCalledTimes(1);
    await vi.waitFor(async () =>
      expect(await h.db.selectFrom('settings').select('value').where('key', '=', 'system.run.piggyback').executeTakeFirst()).toEqual({
        value: String(NOW),
      }),
    );
    expect(await status(id)).toBe('queued');
  });

  it('at most once per 30 s per process', async () => {
    await put('test.light');
    await get('/api/v1/auth/me');
    await vi.waitFor(() => expect(ran).toHaveBeenCalledTimes(1), { timeout: 2000 });
    now = NOW + 20_000;
    await get('/api/v1/auth/me');
    await get('/');
    await quiet();
    expect(ran).toHaveBeenCalledTimes(1);
    now = NOW + 31_000;
    await get('/api/v1/auth/me');
    await vi.waitFor(() => expect(ran).toHaveBeenCalledTimes(2), { timeout: 2000 });
    expect(ran).toHaveBeenLastCalledWith('test.light', 2, 'piggyback');
  });

  it('a worker or cron run recorded within 10 minutes → none', async () => {
    await put('test.light');
    await withTx(h, (trx) =>
      upsert(trx, 'settings', { key: 'system.run.cron_http' }, { value: String(NOW - 5 * 60_000), is_secret: 0, scope: 'instance', updated_at: NOW, updated_by: null }, { value: String(NOW - 5 * 60_000) }),
    );
    await get('/api/v1/auth/me');
    await quiet();
    expect(ran).not.toHaveBeenCalled();
    // 11 minutes later the cron line counts as gone (a fresh process: the cache is per process).
    now = NOW + 6 * 60_000 + 1;
    build();
    await get('/api/v1/auth/me');
    await vi.waitFor(() => expect(ran).toHaveBeenCalledTimes(1), { timeout: 2000 });
  });

  it('never takes a cpuHeavy or longRunning job', async () => {
    const heavy = await put('test.heavy', 1, NOW - 2000);
    const long = await put('test.long', 1, NOW - 1000);
    await get('/api/v1/auth/me');
    await quiet();
    expect(ran).not.toHaveBeenCalled();
    expect(await status(heavy)).toBe('queued');
    expect(await status(long)).toBe('queued');
  });

  it('none during maintenance, and none in worker mode', async () => {
    await put('test.light');
    await writeMaintenance(dataDir, { reason: 'manual', since: NOW, opId: null, exemptJobIds: [] });
    await get('/api/v1/auth/me');
    await quiet();
    expect(ran).not.toHaveBeenCalled();
    await fsp.rm(path.join(dataDir, 'ops'), { recursive: true, force: true });

    await runtime.stop();
    build('pm2');
    expect(runtime.mode).toBe('worker');
    await get('/api/v1/auth/me');
    await quiet();
    expect(ran).not.toHaveBeenCalled();
  });

  it('while its slice runs, the event loop keeps turning: it is never held more than 50 ms plus slack between two turns', async () => {
    await runtime.stop();
    build('passenger', () => Date.now());
    await put('test.yielding', 1, Date.now() - 1000);
    // How long the loop was held between two setImmediate turns is this thread's CPU time over the gap (never more
    // than its wall time). The wall time alone also counts the time the OS left the thread unscheduled: on a loaded
    // machine (a full multi-engine run beside other work) that adds tens of ms to a gap although the slice yielded on
    // time, which no yielding can prevent.
    let last = performance.now();
    let lastCpu = cpuMs();
    let maxHeld = 0;
    let ticks = 0;
    let measuring = true;
    const tick = (): void => {
      const t = performance.now();
      const cpu = cpuMs();
      if (sliceRunning) {
        maxHeld = Math.max(maxHeld, Math.min(t - last, cpu - lastCpu));
        ticks += 1;
      }
      last = t;
      lastCpu = cpu;
      if (measuring) setImmediate(tick);
    };
    setImmediate(tick);
    await get('/api/v1/auth/me');
    await vi.waitFor(() => expect(ran).toHaveBeenCalledWith('test.yielding', 1, 'piggyback'), { timeout: 2000 });
    await vi.waitFor(() => expect(sliceRunning).toBe(false), { timeout: 3000 });
    measuring = false;
    expect(ticks).toBeGreaterThan(5);
    expect(maxHeld).toBeLessThan(50 + 40);
  });
});
