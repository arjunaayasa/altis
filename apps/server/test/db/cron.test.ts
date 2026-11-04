import fsp from 'node:fs/promises';
import os from 'node:os';
import path from 'node:path';
import { createOpsMachine, enqueue, type OpFile, type OpKindHandler, type OpsMachine } from '@altis/core';
import { PHASE1_MIGRATIONS, runMigrations, withTx } from '@altis/db';
import { afterAll, afterEach, beforeAll, beforeEach, describe, expect, it, vi } from 'vitest';
import { engineLabel, testDb, testDbContext, type TestDbHandle } from '../../../../tools/test/test-db.js';
import { createApp, type AppState } from '../../src/app.js';
import { writeConfig, type Config } from '../../src/config.js';
import { createJobRuntime, jobHandlers, type JobRuntime } from '../../src/jobs/runtime.js';
import { createAppOps } from '../../src/services.js';
import { createAgent, type AgentReply } from '../agent.js';
import { recordingLogger, sampleConfig, type RecordedLine } from '../support.js';

// POST /_cron (spec §10.3, decision C39, preflight B5/S2/S18; route catalog `cron.run`) on the engine picked by
// ALTIS_TEST_DB. The caller is a cron line's curl: a Bearer token, no Origin, no cookie.

const ctx = testDbContext();
/** In the past: an audit or event row may not be dated ahead of the real clock. */
const NOW = Date.UTC(2026, 9, 20, 9, 0, 5);
const CONFIG = sampleConfig({ db: { dialect: 'sqlite' } });
const TOKEN = CONFIG.secrets.cronToken;
const CRON = '/_cron';
const silent = { info() {}, warn() {}, error() {} };

const bearer = (token = TOKEN): Record<string, string> => ({ authorization: `Bearer ${token}` });
const code = (res: AgentReply): string | undefined => (res.json as { code?: string } | undefined)?.code;

describe.skipIf(!ctx.available)(`POST /_cron [${engineLabel()}]`, () => {
  let h: TestDbHandle;
  let migDir: string;
  let dataDir: string;
  let now: number;
  let log: ReturnType<typeof recordingLogger>;
  let state: AppState;
  let runtime: JobRuntime | undefined;
  let app: ReturnType<typeof createApp>;
  let machines: OpsMachine[];

  beforeAll(async () => {
    h = await testDb();
    migDir = await fsp.mkdtemp(path.join(os.tmpdir(), 'altis-cron-mig-'));
    await runMigrations(h, { appVersion: '0.1.0', dataDir: migDir, migrations: PHASE1_MIGRATIONS });
  });

  afterAll(async () => {
    await h?.close();
    if (migDir !== undefined) await fsp.rm(migDir, { recursive: true, force: true });
  });

  beforeEach(async () => {
    for (const table of ['jobs', 'locks', 'settings', 'events', 'notifications'] as const) await h.db.deleteFrom(table).execute();
    dataDir = await fsp.realpath(await fsp.mkdtemp(path.join(os.tmpdir(), 'altis-cron-')));
    now = NOW;
    log = recordingLogger();
    machines = [];
    runtime = undefined;
  });

  afterEach(async () => {
    await runtime?.stop();
    for (const m of machines) await m.close();
    await fsp.rm(dataDir, { recursive: true, force: true });
  });

  /** The app as start() builds it, on runtime `passenger` (external mode): no worker loop, the cron line does the work. */
  function build(o: { phase?: AppState['phase']; config?: Config | undefined; ops?: OpsMachine; withRuntime?: boolean } = {}): void {
    const config = 'config' in o ? o.config : CONFIG;
    state = { phase: o.phase ?? 'ready', ...(o.phase === 'not_installed' ? {} : { db: h }), ...(config === undefined ? {} : { config }) };
    const ops = o.ops ?? createAppOps(state, { dataDir, version: '0.1.0', log, clock: () => now });
    machines.push(ops);
    if (o.withRuntime !== false) {
      runtime = createJobRuntime({
        state,
        runtime: 'passenger',
        env: {},
        dataDir,
        log,
        clock: () => now,
        ops,
        handlers: jobHandlers(),
        requestRestart: async () => {},
        installId: CONFIG.install.id,
        appVersion: '0.1.0',
      });
      state.jobs = runtime;
    }
    app = createApp({ state, version: '0.1.0', buildId: 'b', log, clock: () => now, env: {}, dataDir, runtime: 'passenger', services: { ops } });
  }

  const post = (headers: Record<string, string> = bearer(), urlPath = CRON): Promise<AgentReply> => createAgent(app).post(urlPath, undefined, headers);
  const put = (slices: number, type = 'test.slices'): Promise<string> =>
    withTx(h, (trx) => enqueue(trx, runtime!.registry, { type, payload: { slices, k: 1 } }, { now, keyring: CONFIG.keyring })).then((r) => r.id);
  const status = async (id: string) => (await h.db.selectFrom('jobs').select('status').where('id', '=', id).executeTakeFirstOrThrow()).status;
  const effects = (id: string) =>
    h.db.selectFrom('locks').select(['name', 'owner']).where('name', 'like', `test-slice:${id}:%`).orderBy('name').execute();
  const runRecord = () =>
    h.db.selectFrom('settings').select('value').where('key', '=', 'system.run.cron_http').executeTakeFirst().then((r) => r?.value ?? null);
  const logText = (): string => JSON.stringify(log.lines satisfies RecordedLine[]);

  it('the right bearer → 200 {op, scheduled, slices}: one slice of each due job, and system.run.cron_http recorded', async () => {
    build();
    const id = await put(1);
    const res = await post();
    expect(res.status, res.text).toBe(200);
    expect(res.json).toEqual({ op: null, scheduled: 0, slices: 1 });
    expect(await status(id)).toBe('succeeded');
    expect(await runRecord()).toBe(String(NOW));
    expect(res.headers.get('cache-control')).toBe('no-store');
  });

  it('a wrong or missing bearer, or the token in the query → 401 CRON_TOKEN_INVALID; GET /_cron → 404', async () => {
    build();
    const id = await put(1);
    const wrong = await post(bearer(`${TOKEN.slice(0, -1)}${TOKEN.endsWith('A') ? 'B' : 'A'}`));
    expect(wrong.status).toBe(401);
    expect(code(wrong)).toBe('CRON_TOKEN_INVALID');
    expect(code(await post({}))).toBe('CRON_TOKEN_INVALID');
    expect(code(await post({ authorization: `Basic ${TOKEN}` }))).toBe('CRON_TOKEN_INVALID');
    const query = await post({}, `${CRON}?token=${encodeURIComponent(TOKEN)}`);
    expect(query.status).toBe(401);
    expect(code(query)).toBe('CRON_TOKEN_INVALID');
    const get = await createAgent(app).get(CRON);
    expect(get.status).toBe(404);
    expect(await status(id)).toBe('queued');
    expect(logText()).not.toContain(TOKEN);
    expect(logText()).not.toContain(encodeURIComponent(TOKEN));
  });

  it('two calls at once → one 200 and one 202 {skipped: busy}', async () => {
    build();
    const [a, b] = await Promise.all([post(), post()]);
    expect([a.status, b.status].sort()).toEqual([200, 202]);
    expect([a, b].find((r) => r.status === 202)!.json).toEqual({ skipped: 'busy' });
  });

  it('a call 10 s after the last → 202 without work; 31 s after → 200', async () => {
    build();
    expect((await post()).status).toBe(200);
    const id = await put(1);
    now = NOW + 10_000;
    expect((await post()).status).toBe(202);
    expect(await status(id)).toBe('queued');
    now = NOW + 31_000;
    expect((await post()).status).toBe(200);
    expect(await status(id)).toBe('succeeded');
  });

  it('tmp/cron-flight.json with `until` a day ahead (the clock moved back) → 200', async () => {
    build();
    await fsp.mkdir(path.join(dataDir, 'tmp'), { recursive: true });
    await fsp.writeFile(path.join(dataDir, 'tmp', 'cron-flight.json'), JSON.stringify({ until: NOW + 86_400_000 }));
    expect((await post()).status).toBe(200);
  });

  it('each call advances a job by one slice (B5): a 3-slice job needs three calls, a 5-slice longRunning one five', async () => {
    build();
    const light = await put(3);
    const long = await put(5, 'test.long');
    for (let call = 1; call <= 5; call += 1) {
      now = NOW + call * 31_000;
      const res = await post();
      expect(res.json).toEqual({ op: null, scheduled: 0, slices: call <= 3 ? 2 : 1 });
      expect(await effects(light)).toHaveLength(Math.min(call, 3));
      expect(await effects(long)).toHaveLength(call);
    }
    expect(await status(light)).toBe('succeeded');
    expect(await status(long)).toBe('succeeded');
  });

  it('not installed with a config present → 200 {installed: false} and tmp/cron-seen.json; without a config → 401', async () => {
    build({ phase: 'not_installed', config: { ...CONFIG, installState: 'migrate' }, withRuntime: false });
    const res = await post();
    expect(res.status, res.text).toBe(200);
    expect(res.json).toEqual({ installed: false });
    expect(JSON.parse(await fsp.readFile(path.join(dataDir, 'tmp', 'cron-seen.json'), 'utf8'))).toEqual({ mode: 'cron_http', at: NOW });
    // A wrong token learns nothing, installed or not.
    expect(code(await post(bearer('x'.repeat(43))))).toBe('CRON_TOKEN_INVALID');

    build({ phase: 'not_installed', config: undefined, withRuntime: false });
    expect(code(await post())).toBe('CRON_TOKEN_INVALID');
  });

  it('not installed, started before config.json existed: its first call after the config step checks the file\'s token', async () => {
    // Another process wrote config.json; this one has none in hand yet (its boot attempt is under way).
    build({ phase: 'not_installed', config: undefined, withRuntime: false });
    await writeConfig(dataDir, { ...CONFIG, installState: 'migrate' });
    const res = await post();
    expect(res.status, res.text).toBe(200);
    expect(res.json).toEqual({ installed: false });
    expect(code(await post(bearer('x'.repeat(43))))).toBe('CRON_TOKEN_INVALID');
  });

  it('during a restore only the op is stepped: no job is claimed and system.run.cron_http is not written (S2)', async () => {
    const steps: string[] = [];
    const restore: OpKindHandler = {
      kind: 'restore',
      initialState: 'verifying',
      maintenance: 'restore',
      freeze: false,
      async step(_c, op: OpFile) {
        steps.push(op.state);
        return op;
      },
    };
    const ops = createOpsMachine({
      dataDir,
      kinds: [restore],
      db: () => h,
      connect: () => Promise.reject(new Error('unused')),
      keyring: () => CONFIG.keyring,
      clock: () => now,
      log: silent,
      snapshotBackupRunning: async () => false,
    });
    build({ ops });
    await ops.begin('restore', { type: 'cli', id: null }, {});
    const id = await put(1);
    const res = await post();
    expect(res.status, res.text).toBe(200);
    expect(res.json).toMatchObject({ op: { kind: 'restore', state: 'verifying', terminal: false }, scheduled: 0, slices: 0 });
    expect(steps).toEqual(['verifying']);
    expect(await status(id)).toBe('queued');
    expect(await runRecord()).toBeNull();
  });

  it('a retired app (its handler replaced, the drain under way) starts no work: 202 {skipped: busy}, no op step, no flight taken', async () => {
    for (const withRuntime of [true, false]) {
      const ops = createAppOps({ phase: 'ready', db: h, config: CONFIG }, { dataDir, version: '0.1.0', log, clock: () => now });
      const step = vi.spyOn(ops, 'step');
      build({ ops, withRuntime });
      const pass = runtime === undefined ? undefined : vi.spyOn(runtime.runner, 'pass');
      const id = withRuntime ? await put(1) : null;
      state.retired = true;
      const res = await post();
      expect(res.status, res.text).toBe(202);
      expect(res.json).toEqual({ skipped: 'busy' });
      expect(step).not.toHaveBeenCalled();
      expect(pass ?? vi.fn()).not.toHaveBeenCalled();
      if (id !== null) expect(await status(id)).toBe('queued');
      // The single-flight was not taken: the handler that serves next answers the next call.
      await expect(fsp.stat(path.join(dataDir, 'tmp', 'cron-flight.json'))).rejects.toMatchObject({ code: 'ENOENT' });
      // A wrong token is still a wrong token.
      expect(code(await post(bearer('x'.repeat(43))))).toBe('CRON_TOKEN_INVALID');
      await runtime?.stop();
      runtime = undefined;
    }
  });

  describe('a call that reaches a process still booting (ruling R1c-14: the call that woke a cold process)', () => {
    const sleep = (ms: number): Promise<void> => new Promise((resolve) => setTimeout(resolve, ms));

    it('waits for `ready` and the job runtime start() makes after it, then does its work with the config read meanwhile', async () => {
      build();
      const { jobs, config } = state;
      delete state.jobs;
      delete state.config; // start() has not read config.json yet
      state.phase = 'starting';
      const id = await put(1);
      const reply = post();
      await sleep(250);
      state.config = config;
      state.phase = 'db_unavailable'; // a retried connection is still a boot
      await sleep(250);
      state.phase = 'ready'; // start() makes the job runtime right after the health check and markHealthy
      await sleep(250);
      state.jobs = jobs;
      const res = await reply;
      expect(res.status, res.text).toBe(200);
      expect(res.json).toEqual({ op: null, scheduled: 0, slices: 1 });
      expect(await status(id)).toBe('succeeded');
      expect(await runRecord()).toBe(String(NOW));
    });

    it('waits for `ops_wait` (an exclusive op holds the ops lock): the op is stepped', async () => {
      build({ withRuntime: false });
      const step = vi.spyOn(machines[0]!, 'step');
      state.phase = 'starting';
      const reply = post();
      await sleep(250);
      state.phase = 'ops_wait';
      const res = await reply;
      expect(res.status, res.text).toBe(200);
      expect(res.json).toEqual({ op: null, scheduled: 0, slices: 0 });
      expect(step).toHaveBeenCalledTimes(1);
    });

    it('the time it waited comes out of its 20 s budget, and the single-flight is dated when the work starts', async () => {
      build();
      const cron = vi.spyOn(runtime!, 'cron');
      state.phase = 'starting';
      const reply = post();
      await sleep(250);
      now = NOW + 12_000;
      state.phase = 'ready';
      expect((await reply).status).toBe(200);
      expect(cron).toHaveBeenCalledWith('cron_http', 8_000);
      const flight = JSON.parse(await fsp.readFile(path.join(dataDir, 'tmp', 'cron-flight.json'), 'utf8')) as { until: number };
      expect(flight.until).toBe(NOW + 12_000 + 30_000);
    });

    it('a wrong token waits like any call (the token is checked by the route), then gets 401', async () => {
      build();
      state.phase = 'starting';
      const reply = post(bearer('x'.repeat(43)));
      await sleep(250);
      state.phase = 'ready';
      expect(code(await reply)).toBe('CRON_TOKEN_INVALID');
    });
  });

  it('the log never holds the token', async () => {
    build();
    await put(2);
    await post();
    now += 31_000;
    await post(bearer('nope'));
    await post({}, `${CRON}?token=${TOKEN}`);
    expect(logText()).not.toContain(TOKEN);
  });
});
