import fsp from 'node:fs/promises';
import os from 'node:os';
import path from 'node:path';
import { enqueue, readMaintenance, readOpFile, type JobHandler, type OpsMachine } from '@altis/core';
import { PHASE1_MIGRATIONS, runMigrations, withTx } from '@altis/db';
import type { Env, Runtime } from '@altis/platform';
import { z } from 'zod';
import { afterAll, afterEach, beforeAll, beforeEach, describe, expect, it, vi } from 'vitest';
import { engineLabel, testDb, testDbContext, type TestDbHandle } from '../../../../tools/test/test-db.js';
import { createApp, type AppState } from '../../src/app.js';
import { createJobRuntime, jobHandlers, type JobRuntime } from '../../src/jobs/runtime.js';
import { createAppOps, createServices } from '../../src/services.js';
import { createAgent } from '../agent.js';
import { writeOp } from '../ops-support.js';
import { recordingLogger, sampleConfig } from '../support.js';
import { seedStaff, sessionCookieFor, sessionCsrfFor } from '../support-auth.js';

// The job runtime of a server process (spec §10.2, P14; preflight S11, S19, M6, M13) on the engine picked by
// ALTIS_TEST_DB: the worker loop (runtime pm2) runs queued jobs without any request and checks the fences each pass;
// ALTIS_RUNNER=off and passenger have no loop; stop() drains (waits for the running slice, closes job sessions and the
// ops machine's connections); drive runs one slice in external mode and nothing in worker mode; services.ops exists
// before the app is ready; and the test-profile route `test.jobs.enqueue`.

const ctx = testDbContext();
const NOW = Date.UTC(2026, 9, 20, 9, 0, 5);
const CONFIG = sampleConfig({ db: { dialect: 'sqlite' } });

/** A job that waits for its gate in its first slice, keeping a session; then continues once. */
let release: (() => void) | undefined;
const sessionClosed = vi.fn();
const gated: JobHandler<{ k: number }> = {
  type: 'test.gated',
  permission: 'system.jobs.manage',
  retryable: 'api',
  payload: z.strictObject({ k: z.number().int() }),
  async run(c, p) {
    await c.session(async () => ({ open: true }), async () => {
      sessionClosed();
    });
    if (p.k === 1) await new Promise<void>((resolve) => (release = resolve));
    return { continueWith: { k: p.k + 1 }, progress: 50 };
  },
};

/** A three-slice `longRunning` job whose second slice waits for its gate (`release`), keeping one session. */
const sessionOpened = vi.fn();
const gatedLong: JobHandler<{ k: number }> = {
  type: 'test.gated_long',
  permission: 'system.jobs.manage',
  retryable: 'api',
  longRunning: true,
  payload: z.strictObject({ k: z.number().int() }),
  async run(c, p) {
    await c.session(
      async () => {
        sessionOpened();
        return { open: true };
      },
      async () => {
        sessionClosed();
      },
    );
    if (p.k === 2) await new Promise<void>((resolve) => (release = resolve));
    return p.k >= 3 ? { done: true } : { continueWith: { k: p.k + 1 }, progress: 33 * p.k };
  },
};

describe.skipIf(!ctx.available)(`job runtime [${engineLabel()}]`, () => {
  let h: TestDbHandle;
  let migDir: string;
  let dataDir: string;
  let state: AppState;
  let runtime: JobRuntime | undefined;
  let ops: OpsMachine | undefined;
  /** The log of the runtime make() made last. */
  let log: ReturnType<typeof recordingLogger>;

  beforeAll(async () => {
    h = await testDb();
    migDir = await fsp.mkdtemp(path.join(os.tmpdir(), 'altis-runtime-mig-'));
    await runMigrations(h, { appVersion: '0.1.0', dataDir: migDir, migrations: PHASE1_MIGRATIONS });
  });

  afterAll(async () => {
    await h?.close();
    if (migDir !== undefined) await fsp.rm(migDir, { recursive: true, force: true });
  });

  beforeEach(async () => {
    for (const table of ['jobs', 'locks', 'settings', 'events', 'notifications'] as const) await h.db.deleteFrom(table).execute();
    dataDir = await fsp.realpath(await fsp.mkdtemp(path.join(os.tmpdir(), 'altis-runtime-')));
    sessionClosed.mockClear();
    sessionOpened.mockClear();
    release = undefined;
    runtime = undefined;
    ops = undefined;
  });

  afterEach(async () => {
    release?.();
    await runtime?.stop();
    await ops?.close();
    await fsp.rm(dataDir, { recursive: true, force: true });
  });

  function make(
    runtimeName: Runtime,
    o: { env?: Env; handlers?: readonly JobHandler<never>[]; fences?: () => readonly { check(): Promise<void> }[]; clock?: () => number } = {},
  ): JobRuntime {
    log = recordingLogger();
    state = { phase: 'ready', db: h, config: CONFIG };
    const clock = o.clock ?? (() => Date.now());
    ops = createAppOps(state, { dataDir, version: '0.1.0', log, clock });
    runtime = createJobRuntime({
      state,
      runtime: runtimeName,
      env: o.env ?? {},
      dataDir,
      log,
      clock,
      ops,
      handlers: o.handlers ?? jobHandlers(),
      requestRestart: async () => {},
      installId: CONFIG.install.id,
      appVersion: '0.1.0',
      ...(o.fences === undefined ? {} : { fences: o.fences }),
    });
    state.jobs = runtime;
    return runtime;
  }

  const put = (rt: JobRuntime, type: string, payload: unknown) =>
    withTx(h, (trx) => enqueue(trx, rt.registry, { type, payload }, { now: Date.now(), keyring: CONFIG.keyring })).then((r) => r.id);
  const status = async (id: string) => (await h.db.selectFrom('jobs').select('status').where('id', '=', id).executeTakeFirstOrThrow()).status;

  it('under pm2 the worker loop runs a queued 3-slice job without any request, checking both fences before each pass', async () => {
    const configFence = { check: vi.fn(async () => {}) };
    const opsFence = { check: vi.fn(async () => {}) };
    const rt = make('pm2', { fences: () => [configFence, opsFence] });
    expect(rt.mode).toBe('worker');
    const pass = vi.spyOn(rt.runner, 'pass');
    const id = await put(rt, 'test.slices', { slices: 3, k: 1 });
    rt.start();
    await vi.waitFor(async () => expect(await status(id)).toBe('succeeded'), { timeout: 5000 });
    expect(await h.db.selectFrom('locks').select('name').where('name', 'like', `test-slice:${id}:%`).execute()).toHaveLength(3);
    expect(pass).toHaveBeenCalled();
    expect(pass.mock.calls[0]![0]).toEqual({ budgetMs: 20_000, mode: 'worker' });
    expect(configFence.check.mock.calls.length).toBeGreaterThanOrEqual(pass.mock.calls.length);
    expect(opsFence.check.mock.calls.length).toBe(configFence.check.mock.calls.length);
    await vi.waitFor(async () =>
      expect(await h.db.selectFrom('settings').select('key').where('key', '=', 'system.run.worker').execute()).toHaveLength(1),
    );
  });

  it('R1c-7: a longRunning job running on its own never blocks the loop: a light job queued after its first slice succeeds first, and system.run.worker is refreshed meanwhile', async () => {
    let offset = 0;
    const rt = make('pm2', { handlers: [gatedLong as JobHandler<never>, ...(jobHandlers() as JobHandler<never>[])], clock: () => Date.now() + offset });
    const longId = await put(rt, 'test.gated_long', { k: 1 });
    rt.start();
    // The first slice is done and the second waits for its gate.
    await vi.waitFor(() => expect(release).toBeDefined(), { timeout: 5000 });
    const gatedAt = Date.now();
    // A minute later (past the run record's 60 s gap) a light job is queued.
    offset = 61_000;
    const lightId = await put(rt, 'test.slices', { slices: 1, k: 1 });
    rt.kick();
    await vi.waitFor(async () => expect(await status(lightId)).toBe('succeeded'), { timeout: 5000 });
    expect(await status(longId)).toBe('running');
    await vi.waitFor(
      async () => {
        const row = await h.db.selectFrom('settings').select('value').where('key', '=', 'system.run.worker').executeTakeFirst();
        expect(Number(row?.value)).toBeGreaterThanOrEqual(gatedAt + 61_000);
      },
      { timeout: 7000 },
    );
    expect(await status(longId)).toBe('running');
    release!();
    await vi.waitFor(async () => expect(await status(longId)).toBe('succeeded'), { timeout: 5000 });
    expect(sessionOpened).toHaveBeenCalledTimes(1);
    expect(log.lines.filter((l) => l.level === 'warn' || l.level === 'error')).toEqual([]);
  }, 20_000);

  it('R1c-7: stop() drains a longRunning job running on its own: it waits for its slice, and no next slice is claimed', async () => {
    const rt = make('pm2', { handlers: [gatedLong as JobHandler<never>] });
    const id = await put(rt, 'test.gated_long', { k: 1 });
    rt.start();
    await vi.waitFor(() => expect(release).toBeDefined(), { timeout: 5000 });
    let stopped = false;
    const stopping = rt.stop().then(() => {
      stopped = true;
    });
    await new Promise((resolve) => setTimeout(resolve, 100));
    expect(stopped).toBe(false);
    expect(sessionClosed).not.toHaveBeenCalled();
    release!();
    await stopping;
    expect(sessionClosed).toHaveBeenCalledTimes(1);
    expect(await status(id)).toBe('queued');
    expect(log.lines.filter((l) => l.level === 'warn' || l.level === 'error')).toEqual([]);
  });

  it('a local enqueue wakes the idle loop at once (kick)', async () => {
    const rt = make('pm2');
    rt.start();
    // Let the loop go idle (its first pass found nothing; the next waits 2 s).
    await new Promise((resolve) => setTimeout(resolve, 100));
    const id = await put(rt, 'test.slices', { slices: 1, k: 1 });
    rt.kick();
    await vi.waitFor(async () => expect(await status(id)).toBe('succeeded'), { timeout: 1000 });
  });

  it('ALTIS_RUNNER=off and passenger: no loop', async () => {
    for (const [name, env] of [
      ['pm2', { ALTIS_RUNNER: 'off' }],
      ['passenger', {}],
    ] as const) {
      const rt = make(name, { env });
      expect(rt.mode).toBe('external');
      const pass = vi.spyOn(rt.runner, 'pass');
      const id = await put(rt, 'test.slices', { slices: 1, k: 1 });
      rt.start();
      await new Promise((resolve) => setTimeout(resolve, 300));
      expect(pass).not.toHaveBeenCalled();
      expect(await status(id)).toBe('queued');
      await rt.stop();
      await h.db.deleteFrom('jobs').execute();
    }
  });

  it('stop() waits for the running slice, then closes the job sessions and the ops connections', async () => {
    const rt = make('pm2', { handlers: [gated as JobHandler<never>] });
    const closeOps = vi.spyOn(ops!, 'close');
    const id = await put(rt, 'test.gated', { k: 1 });
    rt.start();
    await vi.waitFor(() => expect(release).toBeDefined(), { timeout: 5000 });
    let stopped = false;
    const stopping = rt.stop().then(() => {
      stopped = true;
    });
    await new Promise((resolve) => setTimeout(resolve, 100));
    expect(stopped).toBe(false);
    expect(sessionClosed).not.toHaveBeenCalled();
    release!();
    await stopping;
    expect(sessionClosed).toHaveBeenCalledTimes(1);
    expect(closeOps).toHaveBeenCalled();
    // The slice's result was written; nothing was claimed after the drain began.
    expect(await status(id)).toBe('queued');
    expect(await rt.cron('cron_http', 20_000)).toEqual({ op: null, scheduled: 0, slices: 0 });
  });

  it('a database closed under the drain (the retiring app closes it) costs no warning, and no run is recorded', async () => {
    const rt = make('pm2', { handlers: [gated as JobHandler<never>] });
    const id = await put(rt, 'test.gated', { k: 1 });
    rt.start();
    await vi.waitFor(() => expect(release).toBeDefined(), { timeout: 5000 });
    const stopping = rt.stop();
    // The app's handle is gone meanwhile (here: one whose every use fails); the running slice keeps the one it had.
    state.db = new Proxy(h, {
      get() {
        throw new Error('driver has already been destroyed');
      },
    });
    release!();
    await stopping;
    expect(log.lines.filter((l) => l.level === 'warn' || l.level === 'error')).toEqual([]);
    expect(await h.db.selectFrom('settings').select('key').where('key', '=', 'system.run.worker').execute()).toEqual([]);
    expect(await status(id)).toBe('queued');
  });

  it('drive: one slice in external mode; null without running in worker mode', async () => {
    const external = make('passenger');
    const id = await put(external, 'test.slices', { slices: 2, k: 1 });
    expect(await external.drive(id, { budgetMs: 20_000 })).toEqual({ jobId: id, type: 'test.slices', outcome: 'continued' });
    expect(await h.db.selectFrom('settings').select('key').where('key', '=', 'system.run.drive').execute()).toHaveLength(1);
    await external.stop();

    const worker = make('pm2');
    expect(await worker.drive(id, { budgetMs: 20_000 })).toBeNull();
    expect(await status(id)).toBe('queued');
    expect(await h.db.selectFrom('locks').select('name').where('name', 'like', `test-slice:${id}:%`).execute()).toHaveLength(1);
  });

  it('services.ops exists before the app is ready: install-migrate begins while not installed with a config present', async () => {
    const notInstalled: AppState = { phase: 'not_installed', config: { ...CONFIG, installState: 'migrate' } };
    const services = createServices(notInstalled, { state: notInstalled, version: '0.1.0', buildId: 'b', log: recordingLogger(), dataDir, env: {} });
    const handle = await services.ops.begin('install-migrate', { type: 'install', id: null }, {});
    expect(handle.opId).toMatch(/^[0-9A-Z]{26}$/);
    expect(await readOpFile(dataDir)).toMatchObject({ kind: 'install-migrate', state: 'running', version: '0.1.0' });
    expect(await readMaintenance(dataDir)).toMatchObject({ reason: 'install', opId: handle.opId });
    expect(services.jobs).toBeNull();
    await services.ops.close();
  });

  it('services.ops notifies the kind’s permission when an op needs attention (M34)', async () => {
    let now = NOW;
    const ready: AppState = { phase: 'ready', db: h, config: CONFIG };
    ops = createAppOps(ready, { dataDir, version: '0.1.0', log: recordingLogger(), clock: () => now });
    await ops.begin('reset', { type: 'cli', id: null }, {});
    // A reset step finishes at once; begin a migrate op that stalls instead: no step for 15 minutes.
    await ops.step(20_000);
    await ops.begin('migrate', { type: 'cli', id: null }, {});
    now += 15 * 60_000 + 1;
    expect(await ops.step(1)).toMatchObject({ kind: 'migrate', needsAttention: true });
    expect(await h.db.selectFrom('notifications').select(['type', 'title_key', 'audience_permission', 'params', 'link']).execute()).toEqual([
      {
        type: 'ops.attention',
        title_key: 'notification.ops_attention.title',
        audience_permission: 'system.config.manage',
        params: '{"name":"migrate"}',
        link: '/admin/_update',
      },
    ]);
  });

  it('no ops.attention notification for install-migrate, before the install completes, or a restore past its PONR', async () => {
    let now = NOW;
    // The wizard's install-migrate op (resumed after 15 minutes): the database may have no tables yet, and nobody to tell.
    const wizard: AppState = { phase: 'not_installed', config: { ...CONFIG, installState: 'migrate' } };
    const wlog = recordingLogger();
    ops = createAppOps(wizard, { dataDir, version: '0.1.0', log: wlog, clock: () => now, installDb: () => h });
    await ops.begin('install-migrate', { type: 'install', id: null }, {});
    now += 15 * 60_000 + 1;
    expect(await ops.step(1)).toMatchObject({ kind: 'install-migrate', needsAttention: true });
    expect(wlog.lines.filter((l) => l.level === 'error')).toEqual([]);
    expect(await h.db.selectFrom('notifications').select('type').execute()).toEqual([]);
    await ops.close();

    // A restore past its point of no return: its tables are being replaced, the row would be lost or pollute them.
    await fsp.rm(path.join(dataDir, 'ops'), { recursive: true, force: true });
    const ready: AppState = { phase: 'ready', db: h, config: CONFIG };
    ops = createAppOps(ready, { dataDir, version: '0.1.0', log: recordingLogger(), clock: () => now });
    await writeOp(dataDir, { kind: 'restore', state: 'loading', pointOfNoReturn: true, at: now });
    now += 15 * 60_000 + 1;
    expect(await ops.step(1)).toMatchObject({ kind: 'restore', needsAttention: true, pointOfNoReturn: true });
    expect(await h.db.selectFrom('notifications').select('type').execute()).toEqual([]);
  });

  it('test.jobs.enqueue (test profile): a holder of system.jobs.manage queues a test job and wakes the loop', async () => {
    const rt = make('pm2');
    rt.start();
    const app = createApp({ state, version: '0.1.0', buildId: 'b', log: recordingLogger(), env: {}, dataDir, runtime: 'pm2', services: { ops: ops! } });
    const user = await seedStaff(h, { username: 'penguji_tugas', roles: [{ permissions: ['system.jobs.manage'] }] });
    const token = await sessionCookieFor(h, user.id);
    const agent = createAgent(app);
    agent.setCookie('__Host-altis_sid', token);
    const headers = { 'x-csrf-token': sessionCsrfFor(CONFIG, token), origin: CONFIG.baseUrl };
    const res = await agent.post('/api/v1/_test/jobs', { type: 'test.slices', payload: { slices: 2, k: 1 } }, headers);
    expect(res.status, res.text).toBe(200);
    const { id } = res.json as { id: string };
    await vi.waitFor(async () => expect(await status(id)).toBe('succeeded'), { timeout: 2000 });
    expect((await h.db.selectFrom('jobs').select('created_by').where('id', '=', id).executeTakeFirstOrThrow()).created_by).toBe(user.id);

    const bad = await agent.post('/api/v1/_test/jobs', { type: 'test.slices', payload: { slices: 21, k: 1 } }, headers);
    expect(bad.status).toBe(422);
    const jobsBefore = await h.db.selectFrom('jobs').select('id').execute();
    const anonymous = await createAgent(app).post('/api/v1/_test/jobs', { type: 'test.slices', payload: { slices: 1, k: 1 } }, { origin: CONFIG.baseUrl });
    expect([401, 403]).toContain(anonymous.status);
    expect(await h.db.selectFrom('jobs').select('id').execute()).toHaveLength(jobsBefore.length);
  });
});
