import fsp from 'node:fs/promises';
import os from 'node:os';
import path from 'node:path';
import { createOpsMachine, snapshotBackupRunning, writeSettings, type OpsMachine } from '@altis/core';
import { PHASE1_MIGRATIONS, connect, runMigrations, withTx } from '@altis/db';
import type { Env, Runtime } from '@altis/platform';
import type { BackupCreateResponse, BackupListResponse } from '@altis/shared/api/backups';
import { afterAll, afterEach, beforeAll, beforeEach, describe, expect, it, vi } from 'vitest';
import { engineLabel, testDb, testDbContext, type TestDbHandle } from '../../../../tools/test/test-db.js';
import { createApp, type AppState } from '../../src/app.js';
import { createOpsFence } from '../../src/http/ops-fence.js';
import type { Config } from '../../src/config.js';
import { createJobRuntime, jobHandlers, opKinds, type JobRuntime } from '../../src/jobs/runtime.js';
import { createAgent, type Agent, type AgentReply } from '../agent.js';
import { seedStaff, sessionCookieFor, sessionCsrfFor } from '../support-auth.js';
import { recordingLogger, sampleConfig } from '../support.js';

// The backup routes (spec §9.9, §13.5 "Backup"; plan Task 20, route catalog `backups.list|create`; Review Focus 1;
// preflight B5) on the engine picked by ALTIS_TEST_DB: the list, the permission, one `backup.create` audit entry per
// create; a manual backup on a host whose only scheduler is the cron URL is frozen, and `POST /_cron` alone takes it
// to `done` with maintenance lifted; with a recent `jobs:run` it is a snapshot job that `POST /_cron` advances one
// slice per call (SQLite: the copy, then the export from it).

vi.mock('@altis/platform', async (importOriginal) => {
  const actual = await importOriginal<typeof import('@altis/platform')>();
  // A real probe writes 64 MiB per new DATA_DIR; the job's own test checks the size it asks for.
  return { ...actual, ensureHeadroom: async () => {} };
});

const ctx = testDbContext();
/** In the past: an audit or event row may not be dated ahead of the real clock. */
const NOW = Date.UTC(2026, 9, 20, 9, 0, 5);
const SID = '__Host-altis_sid';
const OPS_COOKIE = '__Host-altis_ops';
const BACKUPS = '/api/v1/backups';

const code = (res: AgentReply): string | undefined => (res.json as { code?: string } | undefined)?.code;

describe.skipIf(!ctx.available)(`backup routes [${engineLabel()}]`, () => {
  let h: TestDbHandle;
  let root: string;
  let dataDir: string;
  let now: number;
  let state: AppState;
  let ops: OpsMachine;
  let runtime: JobRuntime | undefined;
  let app: ReturnType<typeof createApp>;
  let admin: string;
  let reader: string;
  /** The engine's own database settings: a snapshot job opens its dedicated connection with them (P17). */
  let CONFIG: Config;
  let ORIGIN: string;

  beforeAll(async () => {
    h = await testDb();
    CONFIG = sampleConfig({ db: h.config });
    ORIGIN = new URL(CONFIG.baseUrl).origin;
    root = await fsp.realpath(await fsp.mkdtemp(path.join(os.tmpdir(), 'altis-backups-api-')));
    await runMigrations(h, { appVersion: '0.1.0', dataDir: path.join(root, 'mig'), migrations: PHASE1_MIGRATIONS });
    admin = (await seedStaff(h, { username: 'kepala', roles: [{ key: 'super_admin' }], now: NOW })).id;
    reader = (await seedStaff(h, { username: 'pembaca', roles: [{ permissions: ['system.backup.read'] }], now: NOW })).id;
  }, 60_000);

  afterAll(async () => {
    await h?.close();
    if (root !== undefined) await fsp.rm(root, { recursive: true, force: true });
  });

  beforeEach(async () => {
    for (const table of ['jobs', 'locks', 'backups', 'events', 'notifications', 'sessions', 'schedules'] as const) await h.db.deleteFrom(table).execute();
    await h.db.deleteFrom('settings').where('key', 'like', 'system.run.%').execute();
    dataDir = await fsp.mkdtemp(path.join(root, 'data-'));
    now = NOW;
    runtime = undefined;
  });

  afterEach(async () => {
    await runtime?.stop();
    await ops?.close();
  });

  /** The app as start() builds it on `runtime` (ALTIS_RUNNER=off: no worker loop), with its job runtime. */
  function build(o: { runtime?: Runtime; env?: Env } = {}): void {
    const rt = o.runtime ?? 'passenger';
    const env = o.env ?? {};
    const log = recordingLogger();
    state = { phase: 'ready', db: h, config: CONFIG };
    // createAppOps's machine, except that its dedicated connection opens the test database (on SQLite the app's
    // DATA_DIR is not the one the database file lives in).
    ops = createOpsMachine({
      dataDir,
      kinds: opKinds({ appVersion: '0.1.0', config: () => state.config }),
      db: () => h,
      connect: () => connect(h.config, { runtime: 'standalone', purpose: 'cli', dataDir: h.dataDir }),
      keyring: () => CONFIG.keyring,
      clock: () => now,
      log,
      snapshotBackupRunning: () => snapshotBackupRunning(h, Date.now()),
      appVersion: '0.1.0',
    });
    runtime = createJobRuntime({
      state,
      runtime: rt,
      env,
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
    const opsFence = createOpsFence({ dataDir, intervalMs: 0, clock: () => now, onEpoch() {}, onOpEnded() {} });
    app = createApp({ state, version: '0.1.0', buildId: 'b', log, clock: () => now, env, dataDir, runtime: rt, services: { ops, opsFence } });
  }

  /** A browser signed in as `userId` (re-authenticated now). */
  async function browser(userId: string): Promise<{ agent: Agent; csrf: Record<string, string> }> {
    const token = await sessionCookieFor(h, userId, { now, reauthAt: now });
    const agent = createAgent(app, { headers: { origin: ORIGIN } });
    agent.setCookie(SID, token);
    return { agent, csrf: { 'x-csrf-token': sessionCsrfFor(CONFIG, token) } };
  }

  const cron = (): Promise<AgentReply> => createAgent(app).post('/_cron', undefined, { authorization: `Bearer ${CONFIG.secrets.cronToken}` });
  const auditRows = () => h.db.selectFrom('audit_log').select(['actor_id', 'entity', 'entity_id', 'meta']).where('action', '=', 'backup.create').orderBy('seq').execute();
  const backupRows = () => h.db.selectFrom('backups').selectAll().execute();
  const flagExists = () =>
    fsp.stat(path.join(dataDir, 'ops', 'maintenance.json')).then(
      () => true,
      () => false,
    );
  const recordCronCli = (at: number) => withTx(h, (trx) => writeSettings(trx, { 'system.run.cron_cli': at }, { keyring: [], now: at, actorId: null }));

  it('staff without system.backup.create → 403 on POST backups; with system.backup.read GET backups lists them', async () => {
    build();
    const { agent, csrf } = await browser(reader);
    const denied = await agent.post(BACKUPS, {}, csrf);
    const audited = (await auditRows()).length;
    expect(denied.status).toBe(403);
    expect(code(denied)).toBe('AUTHZ_DENIED');
    expect(await auditRows()).toHaveLength(audited);

    await h.db
      .insertInto('backups')
      .values({ id: '01JAAAAAAAAAAAAAAAAAAAAAAA', kind: 'scheduled', size: 1234, sha256: null, schema_version: '0009_ops_jobs', app_version: '0.1.0', dialect: h.dialect, consistency: 'snapshot', status: 'ok', created_at: NOW - 1000 })
      .execute();
    const list = await agent.get(BACKUPS);
    expect(list.status, list.text).toBe(200);
    const body = list.json as BackupListResponse;
    expect(body.nextScheduledAt).toBeNull();
    expect(body.items).toEqual([
      {
        id: '01JAAAAAAAAAAAAAAAAAAAAAAA',
        kind: 'scheduled',
        status: 'ok',
        size: 1234,
        createdAt: NOW - 1000,
        consistency: 'snapshot',
        includesFiles: false,
        external: false,
        sameInstall: false,
        schemaVersion: '0009_ops_jobs',
        appVersion: '0.1.0',
        dialect: h.dialect,
      },
    ]);
    // Once the schedules are seeded, the next daily run shows.
    await runtime!.cron('cron_cli', 1000);
    const next = (await agent.get(BACKUPS)).json as BackupListResponse;
    expect(next.nextScheduledAt).toEqual(expect.any(Number));
  });

  it('Review Focus 1: frozen on passenger without cron; POST /_cron alone takes it to done, maintenance lifted, row ok', async () => {
    build();
    const { agent, csrf } = await browser(admin);
    const res = await agent.post(BACKUPS, {}, csrf);
    expect(res.status, res.text).toBe(202);
    const body = res.json as Extract<BackupCreateResponse, { consistency: 'frozen' }>;
    expect(body).toEqual({ consistency: 'frozen', opId: expect.any(String) });
    expect(agent.cookies.get(OPS_COOKIE)).toEqual(expect.any(String));
    expect(await flagExists()).toBe(true);
    // A `deny` route is closed meanwhile.
    const closed = await agent.get('/api/v1/branches');
    expect(closed.status).toBe(503);
    expect(code(closed)).toBe('MAINTENANCE');
    const audit = (await auditRows()).filter((r) => r.entity_id === body.opId);
    expect(audit).toHaveLength(1);
    expect(audit[0]).toMatchObject({ actor_id: admin, entity: 'op', entity_id: body.opId });
    expect(JSON.parse(audit[0]!.meta)).toEqual({ consistency: 'frozen', includeFiles: false });

    // The admin closed the tab: only the cron line drives it, 31 s apart.
    let last: AgentReply | undefined;
    for (let call = 1; call <= 20 && (await flagExists()); call += 1) {
      now = NOW + call * 31_000;
      last = await cron();
      expect(last.status, last.text).toBe(200);
    }
    expect((last!.json as { op: { state: string } }).op).toMatchObject({ opId: body.opId, kind: 'backup', state: 'done', terminal: true });
    expect(await flagExists()).toBe(false);
    expect(await backupRows()).toMatchObject([{ id: body.opId, kind: 'manual', consistency: 'frozen', status: 'ok' }]);
    expect((await agent.get('/api/v1/branches')).status).toBe(200);
  });

  it.skipIf(ctx.engine !== 'sqlite')('B5: a snapshot backup (jobs:run 1 min ago) on SQLite advanced only by POST /_cron, one slice per call → ok', async () => {
    build({ runtime: 'standalone', env: { ALTIS_RUNNER: 'off' } });
    await recordCronCli(NOW - 60_000);
    const { agent, csrf } = await browser(admin);
    const res = await agent.post(BACKUPS, { includeFiles: false }, csrf);
    expect(res.status, res.text).toBe(202);
    const body = res.json as Extract<BackupCreateResponse, { consistency: 'snapshot' }>;
    expect(body).toEqual({ consistency: 'snapshot', jobId: expect.any(String) });
    expect(await flagExists()).toBe(false);
    // A second click joins the first job (`backup:manual`); each create is audited.
    const audited = (await auditRows()).length;
    expect((await agent.post(BACKUPS, {}, csrf)).json).toEqual(body);
    expect(await auditRows()).toHaveLength(audited + 1);

    const status = async () => (await h.db.selectFrom('jobs').select(['status', 'payload']).where('id', '=', body.jobId).executeTakeFirstOrThrow()).status;
    const payloads: string[] = [];
    for (let call = 1; call <= 10 && (await status()) !== 'succeeded'; call += 1) {
      now = NOW + call * 31_000;
      const r = await cron();
      expect(r.status, r.text).toBe(200);
      expect((r.json as { slices: number }).slices).toBe(1);
      payloads.push((await h.db.selectFrom('jobs').select('payload').where('id', '=', body.jobId).executeTakeFirstOrThrow()).payload);
    }
    expect(await status()).toBe('succeeded');
    // The first call made the copy (one slice), a later one exported from it.
    expect(JSON.parse(payloads[0]!)).toMatchObject({ backupId: body.jobId, snapshot: 'sqlite-copy', checkpoint: null });
    expect(payloads.length).toBeGreaterThanOrEqual(2);
    expect(await backupRows()).toMatchObject([{ id: body.jobId, kind: 'manual', consistency: 'snapshot', status: 'ok' }]);
  });
});
