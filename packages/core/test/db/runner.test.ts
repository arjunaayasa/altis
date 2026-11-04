import { randomBytes } from 'node:crypto';
import fsp from 'node:fs/promises';
import os from 'node:os';
import path from 'node:path';
import { PHASE1_MIGRATIONS, runMigrations, withTx } from '@altis/db';
import { newId } from '@altis/shared';
import { z } from 'zod';
import { afterAll, afterEach, beforeAll, beforeEach, describe, expect, it, vi } from 'vitest';
import { engineLabel, testDb, testDbContext, type TestDbHandle } from '../../../../tools/test/test-db.js';
import type { CoreLogger } from '../../src/context.js';
import type { KeyringEntry } from '../../src/crypto/secret-box.js';
import { enqueue } from '../../src/jobs/enqueue.js';
import { createJobRegistry } from '../../src/jobs/registry.js';
import {
  CRON_FLIGHT_MS,
  RUNNER_STALE_MS,
  RUN_RECORD_MIN_GAP_MS,
  cronFlight,
  lastRuns,
  readCronSeen,
  recordRun,
  runnerFresh,
  writeCronSeen,
} from '../../src/jobs/run-records.js';
import { JOBS_RUN_DEFAULT_S, LIGHT_PER_PROCESS, createRunner, runnerMode, type Runner, type RunnerOptions } from '../../src/jobs/runner.js';
import { closeJobSessions } from '../../src/jobs/slice.js';
import type { JobContext, JobHandler, RunMode } from '../../src/jobs/types.js';
import { readMaintenance, writeMaintenance, type OpFile } from '../../src/ops/files.js';
import { createOpsMachine, type OpKindHandler, type OpsMachine } from '../../src/ops/machine.js';

// The runner (spec §10.2, decisions C36, C38, C39, C42; preflight B5, S2, S18, M20): passes (the op first, then the
// maintenance exemptions or the scheduler and the jobs), the concurrency limits (≤ 2 light slices per process, 1 heavy),
// the slicing rules of each mode (worker and jobs:run run a longRunning job's slices back to back with one session,
// even past their budget; `/_cron` and drive one slice of a job per call; piggyback one light slice in all), drive,
// the run records and the file-based `/_cron` single-flight. On the engine picked by ALTIS_TEST_DB.

const ctx = testDbContext();
const T = 1_767_225_600_000;
const keyring: KeyringEntry[] = [{ kid: 'k1', key: randomBytes(32).toString('base64url'), active: true }];
const silent: CoreLogger = { info() {}, warn() {}, error() {} };
const CLI = { type: 'cli', id: null } as const;

type NP = { k: number; n: number };
const nPayload = z.strictObject({ k: z.number().int().min(1), n: z.number().int().min(1) });

/** What the handlers saw, in order: `<type>:<jobId>:<k>:<mode>`, and `op` for each op step. */
let order: string[] = [];
/** The runner's clock; a handler may move it (`advancePerSlice`). */
let now = T;
let advancePerSlice = 0;

function sliced(type: string, extra: Partial<JobHandler<NP>> = {}): JobHandler<NP> {
  return {
    type,
    permission: 'system.jobs.manage',
    retryable: 'api',
    payload: nPayload,
    async run(c: JobContext, p: NP) {
      order.push(`${type}:${c.jobId}:${p.k}:${c.mode}`);
      now += advancePerSlice;
      return p.k >= p.n ? { done: true } : { continueWith: { k: p.k + 1, n: p.n }, progress: Math.floor((100 * p.k) / p.n) };
    },
    ...extra,
  };
}

const sessionOpen = vi.fn();
/** The slice of `test.long` that waits for the gate `long` (null: none). */
let holdLongAt: number | null = null;
const sessionClose = vi.fn();
const long: JobHandler<NP> = {
  ...sliced('test.long'),
  longRunning: true,
  async run(c, p) {
    const s = await c.session(
      async () => {
        sessionOpen(c.jobId);
        return { slices: 0 };
      },
      async () => {
        sessionClose(c.jobId);
      },
    );
    s.value.slices += 1;
    order.push(`test.long:${c.jobId}:${p.k}:${c.mode}:s${s.value.slices}`);
    if (p.k === holdLongAt) await new Promise<void>((resolve) => gates.set('long', resolve));
    now += advancePerSlice;
    return p.k >= p.n ? { done: true } : { continueWith: { k: p.k + 1, n: p.n }, progress: Math.floor((100 * p.k) / p.n) };
  },
};

/** Light jobs that wait for their gate: what is running at once. */
const gates = new Map<string, () => void>();
let running = 0;
let maxRunning = 0;
const block: JobHandler<{ name: string }> = {
  type: 'test.block',
  permission: 'system.jobs.manage',
  retryable: 'api',
  payload: z.strictObject({ name: z.string() }),
  async run(_c, p) {
    running += 1;
    maxRunning = Math.max(maxRunning, running);
    order.push(`block:${p.name}`);
    await new Promise<void>((resolve) => gates.set(p.name, resolve));
    running -= 1;
    return { done: true };
  },
};

const reg = createJobRegistry([
  sliced('test.n'),
  sliced('test.heavy', { cpuHeavy: true }),
  // A light job that begins an op (as `backup.schedule` does): only a runner, which steps ops, may run it.
  sliced('test.opener', { piggyback: false }),
  long,
  block,
]);

describe('runnerMode (spec §10.2)', () => {
  it('worker on every runtime but passenger/litespeed, and not with ALTIS_RUNNER=off', () => {
    expect(runnerMode('passenger', {})).toBe('external');
    expect(runnerMode('litespeed', {})).toBe('external');
    for (const r of ['standalone', 'pm2', 'docker', 'service'] as const) expect(runnerMode(r, {})).toBe('worker');
    expect(runnerMode('pm2', { ALTIS_RUNNER: 'off' })).toBe('external');
    expect(runnerMode('docker', { ALTIS_RUNNER: ' OFF ' })).toBe('external');
    expect(runnerMode('service', { ALTIS_RUNNER: 'on' })).toBe('worker');
    expect(JOBS_RUN_DEFAULT_S).toBe(270);
    expect(LIGHT_PER_PROCESS).toBe(2);
  });
});

describe('runnerFresh (spec §10.2 piggyback: no worker/cron run in the last 10 minutes)', () => {
  it('worker, cron_cli or cron_http within 10 minutes; drive and piggyback never count', () => {
    const n = T;
    expect(RUNNER_STALE_MS).toBe(600_000);
    expect(runnerFresh({}, n)).toBe(false);
    expect(runnerFresh({ piggyback: n, drive: n }, n)).toBe(false);
    expect(runnerFresh({ worker: n - 9 * 60_000 }, n)).toBe(true);
    expect(runnerFresh({ cron_cli: n - 11 * 60_000 }, n)).toBe(false);
    expect(runnerFresh({ cron_http: n - 5 * 60_000, piggyback: n }, n)).toBe(true);
    // A record ahead of the clock (it moved back) counts only within the same 10 minutes.
    expect(runnerFresh({ cron_http: n + 5 * 60_000 }, n)).toBe(true);
    expect(runnerFresh({ cron_http: n + 11 * 60_000 }, n)).toBe(false);
  });
});

describe('the /_cron single-flight and cron-seen.json (decision C39, S18)', () => {
  let dataDir: string;

  beforeEach(async () => {
    dataDir = await fsp.mkdtemp(path.join(os.tmpdir(), 'altis-cron-flight-'));
  });

  afterEach(async () => {
    await fsp.rm(dataDir, { recursive: true, force: true });
  });

  it('a call < 30 s after the last one is refused, one 30 s or more after is let through', async () => {
    expect(CRON_FLIGHT_MS).toBe(30_000);
    expect(await cronFlight(dataDir, T)).toBe(true);
    expect(await cronFlight(dataDir, T + 10_000)).toBe(false);
    expect(await cronFlight(dataDir, T + 29_999)).toBe(false);
    expect(await cronFlight(dataDir, T + 31_000)).toBe(true);
    const flight = JSON.parse(await fsp.readFile(path.join(dataDir, 'tmp', 'cron-flight.json'), 'utf8')) as { until: number };
    expect(flight.until).toBe(T + 31_000 + 30_000);
  });

  it('two calls at once: exactly one goes through', async () => {
    const results = await Promise.all([cronFlight(dataDir, T), cronFlight(dataDir, T), cronFlight(dataDir, T)]);
    expect(results.filter(Boolean)).toHaveLength(1);
  });

  it('an `until` more than 60 s ahead (the clock moved back) counts as expired', async () => {
    await fsp.mkdir(path.join(dataDir, 'tmp'), { recursive: true });
    await fsp.writeFile(path.join(dataDir, 'tmp', 'cron-flight.json'), JSON.stringify({ until: T + 86_400_000 }));
    expect(await cronFlight(dataDir, T)).toBe(true);
    // 59 s ahead is a live flight.
    await fsp.writeFile(path.join(dataDir, 'tmp', 'cron-flight.json'), JSON.stringify({ until: T + 59_000 }));
    await fsp.rm(path.join(dataDir, 'tmp', 'cron-flight.json.bak'), { force: true });
    expect(await cronFlight(dataDir, T)).toBe(false);
  });

  it('an unreadable flight file counts as expired', async () => {
    await fsp.mkdir(path.join(dataDir, 'tmp'), { recursive: true });
    await fsp.writeFile(path.join(dataDir, 'tmp', 'cron-flight.json'), '{nope');
    expect(await cronFlight(dataDir, T)).toBe(true);
  });

  it('cron-seen.json records the mode and time of the last scheduler call; null before any', async () => {
    expect(await readCronSeen(dataDir)).toBeNull();
    await writeCronSeen(dataDir, 'cron_cli', T);
    expect(await readCronSeen(dataDir)).toEqual({ mode: 'cron_cli', at: T });
    await writeCronSeen(dataDir, 'cron_http', T + 5);
    expect(await readCronSeen(dataDir)).toEqual({ mode: 'cron_http', at: T + 5 });
  });
});

describe.skipIf(!ctx.available)(`the runner and the run records [${engineLabel()}]`, () => {
  let h: TestDbHandle;
  let migDir: string;
  let dataDir: string;
  let machines: OpsMachine[];
  const opKind = (kind: 'backup' | 'restore'): OpKindHandler => ({
    kind,
    initialState: kind === 'backup' ? 'frozen' : 'verifying',
    maintenance: kind,
    freeze: false,
    async step(_c, op: OpFile) {
      order.push('op');
      return op; // nothing to do yet: the op stays where it is
    },
  });

  function machine(): OpsMachine {
    const m = createOpsMachine({
      dataDir,
      kinds: [opKind('backup'), opKind('restore')],
      db: () => h,
      connect: () => Promise.reject(new Error('the live handle is used here')),
      keyring: () => keyring,
      clock: () => now,
      log: silent,
      snapshotBackupRunning: async () => false,
    });
    machines.push(m);
    return m;
  }

  function runner(o: Partial<RunnerOptions> = {}): Runner {
    return createRunner({
      db: () => h,
      reg,
      ops: o.ops ?? machine(),
      dataDir,
      scheduler: null,
      keyring: () => keyring,
      clock: () => now,
      log: silent,
      env: {},
      worker: 'runner-test',
      ...o,
    });
  }

  const put = (type: string, payload: unknown, runAt = now) =>
    withTx(h, (trx) => enqueue(trx, reg, { type, payload, runAt }, { now, keyring })).then((r) => r.id);
  const statusOf = async (id: string) => (await h.db.selectFrom('jobs').select('status').where('id', '=', id).executeTakeFirstOrThrow()).status;
  const runRow = (mode: RunMode) =>
    h.db.selectFrom('settings').select('value').where('key', '=', `system.run.${mode}`).executeTakeFirst().then((r) => (r === undefined ? null : r.value));

  beforeAll(async () => {
    h = await testDb();
    migDir = await fsp.mkdtemp(path.join(os.tmpdir(), 'altis-runner-mig-'));
    await runMigrations(h, { appVersion: '0.1.0', dataDir: migDir, migrations: PHASE1_MIGRATIONS });
  });

  afterAll(async () => {
    await closeJobSessions();
    await h?.close();
    if (migDir !== undefined) await fsp.rm(migDir, { recursive: true, force: true });
  });

  beforeEach(async () => {
    await closeJobSessions();
    for (const table of ['jobs', 'locks', 'notifications', 'events', 'settings'] as const) await h.db.deleteFrom(table).execute();
    dataDir = await fsp.mkdtemp(path.join(os.tmpdir(), 'altis-runner-'));
    machines = [];
    order = [];
    now = T;
    advancePerSlice = 0;
    holdLongAt = null;
    running = 0;
    maxRunning = 0;
    gates.clear();
    sessionOpen.mockClear();
    sessionClose.mockClear();
  });

  afterEach(async () => {
    for (const resolve of gates.values()) resolve();
    for (const m of machines) await m.close();
    await fsp.rm(dataDir, { recursive: true, force: true });
  });

  describe('pass', () => {
    it('under worker finishes a 3-slice job', async () => {
      const id = await put('test.n', { k: 1, n: 3 });
      const report = await runner().pass({ budgetMs: 20_000, mode: 'worker' });
      expect(report).toEqual({ op: null, scheduled: 0, slices: 3 });
      expect(await statusOf(id)).toBe('succeeded');
      expect(order).toEqual([`test.n:${id}:1:worker`, `test.n:${id}:2:worker`, `test.n:${id}:3:worker`]);
    });

    it('ticks the scheduler before it runs jobs, and reports what it enqueued', async () => {
      const tick = vi.fn(async (at: number) => {
        order.push(`tick:${at}`);
        await put('test.n', { k: 1, n: 1 });
        return 1;
      });
      const report = await runner({ scheduler: { tick } }).pass({ budgetMs: 20_000, mode: 'cron_http' });
      expect(report).toEqual({ op: null, scheduled: 1, slices: 1 });
      expect(order[0]).toBe(`tick:${T}`);
    });

    it('with a maintenance flag exempting job B: the op is stepped first, then only B runs (no tick)', async () => {
      const a = await put('test.n', { k: 1, n: 1 }, T - 2000);
      const b = await put('test.n', { k: 1, n: 1 }, T - 1000);
      const ops = machine();
      await ops.begin('backup', CLI, {});
      const flag = await readMaintenance(dataDir);
      expect(flag).toMatchObject({ reason: 'backup', exemptJobIds: [] });
      await writeMaintenance(dataDir, { ...flag!, exemptJobIds: [b] });
      const step = vi.spyOn(ops, 'step');
      const tick = vi.fn(async () => 0);
      const report = await runner({ ops, scheduler: { tick } }).pass({ budgetMs: 20_000, mode: 'worker' });
      expect(step).toHaveBeenCalledTimes(1);
      expect(report.op).toMatchObject({ kind: 'backup', state: 'frozen', terminal: false });
      expect(report.slices).toBe(1);
      expect(order).toEqual(['op', `test.n:${b}:1:worker`]);
      expect(await statusOf(a)).toBe('queued');
      expect(await statusOf(b)).toBe('succeeded');
      expect(tick).not.toHaveBeenCalled();
    });

    it('a maintenance flag without exemptions: the op is stepped, no job is claimed', async () => {
      const a = await put('test.n', { k: 1, n: 1 });
      const ops = machine();
      await ops.begin('backup', CLI, {});
      const report = await runner({ ops }).pass({ budgetMs: 20_000, mode: 'cron_http' });
      expect(report).toMatchObject({ op: { kind: 'backup' }, scheduled: 0, slices: 0 });
      expect(await statusOf(a)).toBe('queued');
    });

    it('during a restore only the op is stepped: no claim, not even of an exempt job', async () => {
      const a = await put('test.n', { k: 1, n: 1 });
      const ops = machine();
      await ops.begin('restore', CLI, {});
      const flag = await readMaintenance(dataDir);
      await writeMaintenance(dataDir, { ...flag!, exemptJobIds: [a] });
      const r = runner({ ops });
      expect(await r.pass({ budgetMs: 20_000, mode: 'cron_http' })).toMatchObject({ op: { kind: 'restore' }, slices: 0 });
      expect(await r.runFor({ budgetMs: 2000, mode: 'piggyback' })).toEqual([]);
      expect(order).toEqual(['op']);
      expect(await statusOf(a)).toBe('queued');
    });

    it('runs at most two light slices of this process at once; a third job waits for a free slot', async () => {
      const ids = [];
      for (const [i, name] of ['a', 'b', 'c'].entries()) ids.push(await put('test.block', { name }, T - 3000 + i));
      const done = runner().pass({ budgetMs: 20_000, mode: 'worker' });
      await vi.waitFor(() => expect(running).toBe(2));
      await new Promise((resolve) => setTimeout(resolve, 50));
      expect(order).toEqual(['block:a', 'block:b']);
      gates.get('a')!();
      await vi.waitFor(() => expect(order).toEqual(['block:a', 'block:b', 'block:c']));
      gates.get('b')!();
      await vi.waitFor(() => expect(gates.has('c')).toBe(true));
      gates.get('c')!();
      expect((await done).slices).toBe(3);
      expect(maxRunning).toBe(2);
      for (const id of ids) expect(await statusOf(id)).toBe('succeeded');
    });

    it('the slot limit is per process: two concurrent calls of one runner still run at most two light slices', async () => {
      for (const [i, name] of ['a', 'b', 'c', 'd'].entries()) await put('test.block', { name }, T - 4000 + i);
      const r = runner();
      const first = r.runFor({ budgetMs: 20_000, mode: 'cron_http' });
      const second = r.runFor({ budgetMs: 20_000, mode: 'cron_http' });
      await vi.waitFor(() => expect(running).toBe(2));
      await new Promise((resolve) => setTimeout(resolve, 50));
      expect(running).toBe(2);
      for (const name of ['a', 'b', 'c', 'd']) {
        await vi.waitFor(() => expect(gates.has(name)).toBe(true));
        gates.get(name)!();
      }
      const results = [...(await first), ...(await second)];
      expect(results.map((x) => x.outcome)).toEqual(['succeeded', 'succeeded', 'succeeded', 'succeeded']);
      expect(maxRunning).toBe(2);
    });

    it('stops claiming once the runner is stopping', async () => {
      const id = await put('test.n', { k: 1, n: 3 });
      let stopping = false;
      const r = runner({ stopping: () => stopping });
      expect(await r.runFor({ budgetMs: 20_000, mode: 'cron_http' })).toHaveLength(1);
      stopping = true;
      expect(await r.pass({ budgetMs: 20_000, mode: 'worker' })).toMatchObject({ slices: 0 });
      expect(await r.driveJob(id, { budgetMs: 20_000 })).toBeNull();
      expect(await statusOf(id)).toBe('queued');
    });

    it('a database that fails once the runner is stopping (the drain closing it) costs no warning', async () => {
      const warnings: string[] = [];
      const log: CoreLogger = { info() {}, warn: (msg) => warnings.push(msg), error: (msg) => warnings.push(msg) };
      const gone = new Proxy(h, {
        get() {
          throw new Error('driver has already been destroyed');
        },
      });
      // Not stopping when the call begins; stopping from the next look on.
      let looks = 0;
      const r = runner({ db: () => gone, log, stopping: () => (looks += 1) > 1 });
      expect(await r.runFor({ budgetMs: 20_000, mode: 'cron_http' })).toEqual([]);
      expect(looks).toBeGreaterThan(1);
      expect(warnings).toEqual([]);
      // While not stopping the same failure is worth a warning.
      expect(await runner({ db: () => gone, log }).runFor({ budgetMs: 20_000, mode: 'cron_http' })).toEqual([]);
      expect(warnings).toContain('jobs: reading clock_anomaly failed');
    });
  });

  describe('slicing per mode (preflight B5, decision C38)', () => {
    /** A runner whose continued longRunning jobs (R1c-7) land in `longJobs`, as the runtime adopts them. */
    function adopting(o: Partial<RunnerOptions> = {}): { r: Runner; longJobs: Promise<number>[] } {
      const longJobs: Promise<number>[] = [];
      return { r: runner({ adoptLongJob: (task) => longJobs.push(task), ...o }), longJobs };
    }

    it('jobs:run (cron_cli) runs every slice of a longRunning job back to back with one session, past its budget', async () => {
      const id = await put('test.long', { k: 1, n: 5 });
      advancePerSlice = 8000; // the 20 s budget is spent after the third slice
      const { r, longJobs } = adopting();
      // The pass reports the first slice; the job goes on on its own (R1c-7) and reports the other four when it ends.
      const report = await r.pass({ budgetMs: 20_000, mode: 'cron_cli' });
      expect(report.slices).toBe(1);
      expect(longJobs).toHaveLength(1);
      expect(await longJobs[0]).toBe(4);
      expect(await statusOf(id)).toBe('succeeded');
      expect(order).toEqual([1, 2, 3, 4, 5].map((k) => `test.long:${id}:${k}:cron_cli:s${k}`));
      expect(sessionOpen).toHaveBeenCalledTimes(1);
      expect(sessionClose).toHaveBeenCalledTimes(1);
    });

    it('worker likewise keeps a longRunning job in this process until it ends', async () => {
      const id = await put('test.long', { k: 1, n: 4 });
      advancePerSlice = 15_000;
      const { r, longJobs } = adopting();
      expect((await r.pass({ budgetMs: 20_000, mode: 'worker' })).slices).toBe(1);
      expect(await longJobs[0]).toBe(3);
      expect(await statusOf(id)).toBe('succeeded');
      expect(sessionOpen).toHaveBeenCalledTimes(1);
    });

    it('R1c-7: while a continued longRunning job runs on its own, later passes tick and run light jobs, skipping only the heavy lane', async () => {
      const id = await put('test.long', { k: 1, n: 3 }, T - 1000);
      holdLongAt = 2;
      const tick = vi.fn(async () => 0);
      const { r, longJobs } = adopting({ scheduler: { tick } });
      // The first pass runs the first slice and hands the job to a task of its own: it does not wait for the second.
      expect(await r.pass({ budgetMs: 20_000, mode: 'worker' })).toEqual({ op: null, scheduled: 0, slices: 1 });
      expect(longJobs).toHaveLength(1);
      await vi.waitFor(() => expect(gates.has('long')).toBe(true));
      const light = await put('test.n', { k: 1, n: 1 });
      const heavy = await put('test.heavy', { k: 1, n: 1 });
      expect(await r.pass({ budgetMs: 20_000, mode: 'worker' })).toEqual({ op: null, scheduled: 0, slices: 1 });
      expect(await r.pass({ budgetMs: 20_000, mode: 'cron_cli' })).toEqual({ op: null, scheduled: 0, slices: 0 });
      expect(tick).toHaveBeenCalledTimes(3);
      expect(await statusOf(light)).toBe('succeeded');
      expect(await statusOf(heavy)).toBe('queued');
      expect(await statusOf(id)).toBe('running');
      expect(longJobs).toHaveLength(1);
      gates.get('long')!();
      expect(await longJobs[0]).toBe(2);
      expect(await statusOf(id)).toBe('succeeded');
      expect(order.filter((o) => o.startsWith('test.long:'))).toEqual([1, 2, 3].map((k) => `test.long:${id}:${k}:worker:s${k}`));
      expect(sessionOpen).toHaveBeenCalledTimes(1);
      // The long job has ended: the heavy lane is back.
      expect(await r.pass({ budgetMs: 20_000, mode: 'worker' })).toMatchObject({ slices: 1 });
      expect(await statusOf(heavy)).toBe('succeeded');
    });

    it('R1c-7: a longRunning job running on its own stops after its slice once the runner is stopping', async () => {
      const id = await put('test.long', { k: 1, n: 3 });
      holdLongAt = 2;
      let stopping = false;
      const { r, longJobs } = adopting({ stopping: () => stopping });
      expect((await r.pass({ budgetMs: 20_000, mode: 'worker' })).slices).toBe(1);
      await vi.waitFor(() => expect(gates.has('long')).toBe(true));
      stopping = true;
      gates.get('long')!();
      expect(await longJobs[0]).toBe(1);
      // The second slice's checkpoint was written; nothing claimed the third.
      expect(await statusOf(id)).toBe('queued');
      expect(order).toEqual([1, 2].map((k) => `test.long:${id}:${k}:worker:s${k}`));
    });

    // Final review (jobs, Important): a job session is a snapshot transaction on MySQL/MariaDB/PostgreSQL; left idle
    // while maintenance pauses its job, it holds the table locks the DDL of a `migrate` or `reset` op waits for.
    it('a maintenance flag that stops a longRunning job running on its own closes its session', async () => {
      const id = await put('test.long', { k: 1, n: 5 });
      holdLongAt = 2;
      const ops = machine();
      const { r, longJobs } = adopting({ ops });
      expect((await r.pass({ budgetMs: 20_000, mode: 'worker' })).slices).toBe(1);
      await vi.waitFor(() => expect(gates.has('long')).toBe(true));
      await ops.begin('backup', CLI, {}); // a flag that is not a restore's, exempting nothing
      gates.get('long')!();
      expect(await longJobs[0]).toBe(1);
      expect(await statusOf(id)).toBe('queued');
      expect(sessionOpen).toHaveBeenCalledTimes(1);
      expect(sessionClose).toHaveBeenCalledTimes(1);
      // The passes under the flag claim nothing and open nothing.
      expect(await r.pass({ budgetMs: 20_000, mode: 'worker' })).toMatchObject({ slices: 0 });
      expect(sessionOpen).toHaveBeenCalledTimes(1);
    });

    it.each(['manual', 'restore'] as const)('a pass under a %s maintenance flag closes the idle session of a paused job', async (reason) => {
      const id = await put('test.long', { k: 1, n: 5 });
      const ops = machine();
      const r = runner({ ops });
      // A one-slice call leaves the job's session idle in this process for its next slice.
      expect((await r.pass({ budgetMs: 20_000, mode: 'cron_http' })).slices).toBe(1);
      expect(sessionOpen).toHaveBeenCalledTimes(1);
      expect(sessionClose).not.toHaveBeenCalled();
      if (reason === 'restore') await ops.begin('restore', CLI, {});
      else await writeMaintenance(dataDir, { reason, since: now, opId: null, exemptJobIds: [] });
      expect(await r.pass({ budgetMs: 20_000, mode: 'cron_http' })).toMatchObject({ slices: 0 });
      expect(sessionClose).toHaveBeenCalledTimes(1);
      expect(await statusOf(id)).toBe('queued');
    });

    it("a pass closes a paused job's idle session before it steps the op (whose DDL would wait for its locks)", async () => {
      await put('test.long', { k: 1, n: 5 });
      const ops = machine();
      const r = runner({ ops });
      expect((await r.pass({ budgetMs: 20_000, mode: 'cron_http' })).slices).toBe(1);
      await ops.begin('backup', CLI, {});
      order = [];
      sessionClose.mockImplementationOnce(() => order.push('session-close'));
      expect(await r.pass({ budgetMs: 20_000, mode: 'cron_http' })).toMatchObject({ op: { kind: 'backup' }, slices: 0 });
      expect(order).toEqual(['session-close', 'op']);
    });

    it('a pass under a maintenance flag keeps the session of a job the flag exempts', async () => {
      const id = await put('test.long', { k: 1, n: 5 });
      const r = runner();
      expect((await r.pass({ budgetMs: 20_000, mode: 'cron_http' })).slices).toBe(1);
      await writeMaintenance(dataDir, { reason: 'manual', since: now, opId: null, exemptJobIds: [id] });
      expect((await r.pass({ budgetMs: 20_000, mode: 'cron_http' })).slices).toBe(1);
      expect(order).toEqual([1, 2].map((k) => `test.long:${id}:${k}:cron_http:s${k}`));
      expect(sessionOpen).toHaveBeenCalledTimes(1);
      expect(sessionClose).not.toHaveBeenCalled();
    });

    it('POST /_cron (cron_http) advances it by exactly one slice per call; the fifth call finishes it', async () => {
      const id = await put('test.long', { k: 1, n: 5 });
      const { r, longJobs } = adopting();
      for (let call = 1; call <= 5; call += 1) {
        expect((await r.pass({ budgetMs: 20_000, mode: 'cron_http' })).slices).toBe(1);
        expect(await statusOf(id)).toBe(call < 5 ? 'queued' : 'succeeded');
      }
      expect(order.map((o) => o.split(':')[2])).toEqual(['1', '2', '3', '4', '5']);
      expect((await r.pass({ budgetMs: 20_000, mode: 'cron_http' })).slices).toBe(0);
      expect(longJobs).toEqual([]);
    });

    it('cron_http runs at most one slice of each job per call, light ones included', async () => {
      const a = await put('test.n', { k: 1, n: 3 }, T - 2000);
      const b = await put('test.n', { k: 1, n: 3 }, T - 1000);
      const r = runner();
      expect((await r.pass({ budgetMs: 20_000, mode: 'cron_http' })).slices).toBe(2);
      expect(order.sort()).toEqual([`test.n:${a}:1:cron_http`, `test.n:${b}:1:cron_http`].sort());
      expect((await r.pass({ budgetMs: 20_000, mode: 'cron_http' })).slices).toBe(2);
      expect((await r.pass({ budgetMs: 20_000, mode: 'cron_http' })).slices).toBe(2);
      expect(await statusOf(a)).toBe('succeeded');
      expect(await statusOf(b)).toBe('succeeded');
    });

    it('piggyback runs one light slice in all and never takes a longRunning or cpuHeavy job', async () => {
      const longId = await put('test.long', { k: 1, n: 5 }, T - 3000);
      const heavyId = await put('test.heavy', { k: 1, n: 1 }, T - 2000);
      const r = runner();
      expect(await r.runFor({ budgetMs: 2000, mode: 'piggyback', excludeHeavy: true })).toEqual([]);
      const light1 = await put('test.n', { k: 1, n: 3 }, T - 1000);
      await put('test.n', { k: 1, n: 3 }, T - 500);
      const results = await r.runFor({ budgetMs: 2000, mode: 'piggyback', excludeHeavy: true });
      expect(results).toEqual([{ jobId: light1, type: 'test.n', outcome: 'continued' }]);
      expect(order).toEqual([`test.n:${light1}:1:piggyback`]);
      expect(await statusOf(longId)).toBe('queued');
      expect(await statusOf(heavyId)).toBe('queued');
    });

    it('piggyback never takes a light job whose handler says `piggyback: false`; a cron call does', async () => {
      const opener = await put('test.opener', { k: 1, n: 1 }, T - 2000);
      const light = await put('test.n', { k: 1, n: 1 }, T - 1000);
      const r = runner();
      const results = await r.runFor({ budgetMs: 2000, mode: 'piggyback', excludeHeavy: true });
      expect(results).toEqual([{ jobId: light, type: 'test.n', outcome: 'succeeded' }]);
      expect(await statusOf(opener)).toBe('queued');
      expect(await r.runFor({ budgetMs: 2000, mode: 'piggyback', excludeHeavy: true })).toEqual([]);
      expect(await r.runFor({ budgetMs: 20_000, mode: 'cron_http' })).toEqual([{ jobId: opener, type: 'test.opener', outcome: 'succeeded' }]);
    });

    it('drive runs one slice of the job it names; null for one it cannot claim', async () => {
      const id = await put('test.n', { k: 1, n: 2 });
      const r = runner();
      expect(await r.driveJob(id, { budgetMs: 20_000 })).toEqual({ jobId: id, type: 'test.n', outcome: 'continued' });
      expect(await r.driveJob(id, { budgetMs: 20_000 })).toEqual({ jobId: id, type: 'test.n', outcome: 'succeeded' });
      expect(await r.driveJob(id, { budgetMs: 20_000 })).toBeNull();
      expect(await r.driveJob(newId(), { budgetMs: 20_000 })).toBeNull();
      expect(order).toEqual([`test.n:${id}:1:drive`, `test.n:${id}:2:drive`]);
    });

    it('drive takes one of the process’s light slots (R1c-7): none free → null without running; a heavy job needs none', async () => {
      for (const [i, name] of ['a', 'b'].entries()) await put('test.block', { name }, T - 3000 + i);
      const r = runner();
      const busy = r.runFor({ budgetMs: 20_000, mode: 'cron_http' });
      await vi.waitFor(() => expect(running).toBe(2));
      const light = await put('test.n', { k: 1, n: 1 });
      const heavy = await put('test.heavy', { k: 1, n: 1 });
      expect(await r.driveJob(light, { budgetMs: 20_000 })).toBeNull();
      expect(await statusOf(light)).toBe('queued');
      expect(await r.driveJob(heavy, { budgetMs: 20_000 })).toEqual({ jobId: heavy, type: 'test.heavy', outcome: 'succeeded' });
      gates.get('a')!();
      gates.get('b')!();
      await busy;
      // The slots are free again (a drive gives its slot back too).
      const later = await put('test.n', { k: 1, n: 2 });
      expect(await r.driveJob(later, { budgetMs: 20_000 })).toEqual({ jobId: later, type: 'test.n', outcome: 'continued' });
      expect(await r.driveJob(later, { budgetMs: 20_000 })).toEqual({ jobId: later, type: 'test.n', outcome: 'succeeded' });
      expect(maxRunning).toBe(2);
    });

    it('a light slice a drive runs counts against the process’s two slots', async () => {
      const d = await put('test.block', { name: 'd' }, T - 4000);
      const r = runner();
      const driving = r.driveJob(d, { budgetMs: 20_000 });
      await vi.waitFor(() => expect(running).toBe(1));
      for (const [i, name] of ['a', 'b'].entries()) await put('test.block', { name }, T - 3000 + i);
      const busy = r.runFor({ budgetMs: 20_000, mode: 'cron_http' });
      await vi.waitFor(() => expect(running).toBe(2));
      await new Promise((resolve) => setTimeout(resolve, 50));
      expect(running).toBe(2);
      expect(order).toEqual(['block:d', 'block:a']);
      gates.get('d')!();
      expect(await driving).toEqual({ jobId: d, type: 'test.block', outcome: 'succeeded' });
      // The lane that found no free slot has ended; the other runs b after a.
      gates.get('a')!();
      await vi.waitFor(() => expect(gates.has('b')).toBe(true));
      gates.get('b')!();
      expect((await busy).map((x) => x.outcome)).toEqual(['succeeded', 'succeeded']);
      expect(maxRunning).toBe(2);
    });
  });

  describe('run records (decision C42, M20, S2)', () => {
    it('recordRun writes system.run.<mode>, one key per mode, at most every 60 s per mode', async () => {
      expect(RUN_RECORD_MIN_GAP_MS).toBe(60_000);
      await recordRun(h, 'cron_http', T, { dataDir });
      expect(await runRow('cron_http')).toBe(String(T));
      await recordRun(h, 'cron_http', T + 30_000, { dataDir });
      expect(await runRow('cron_http')).toBe(String(T));
      await recordRun(h, 'worker', T + 30_000, { dataDir });
      expect(await runRow('worker')).toBe(String(T + 30_000));
      await recordRun(h, 'cron_http', T + 61_000, { dataDir });
      expect(await runRow('cron_http')).toBe(String(T + 61_000));
      expect(await lastRuns(h.db)).toEqual({ worker: T + 30_000, cron_http: T + 61_000 });
    });

    it('is skipped while a restore holds the maintenance flag', async () => {
      await writeMaintenance(dataDir, { reason: 'restore', since: T, opId: newId(), exemptJobIds: [] });
      await recordRun(h, 'cron_http', T, { dataDir });
      expect(await runRow('cron_http')).toBeNull();
      await writeMaintenance(dataDir, { reason: 'backup', since: T, opId: newId(), exemptJobIds: [] });
      await recordRun(h, 'cron_http', T, { dataDir });
      expect(await runRow('cron_http')).toBe(String(T));
    });

    it('lastRuns reads through a settings cache when given one', async () => {
      const get = vi.fn(async (_db: unknown, key: string) => (key === 'system.run.cron_cli' ? T - 1 : null));
      expect(await lastRuns(h.db, { cache: { get: get as never, invalidate() {} } })).toEqual({ cron_cli: T - 1 });
      expect(get).toHaveBeenCalledTimes(5);
    });
  });
});
