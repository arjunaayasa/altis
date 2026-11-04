import fsp from 'node:fs/promises';
import os from 'node:os';
import path from 'node:path';
import { SCHEDULES, seedSchedules, writeSettings, type OpsMachine } from '@altis/core';
import { PHASE1_MIGRATIONS, runMigrations, withTx } from '@altis/db';
import type { Runtime } from '@altis/platform';
import { newId } from '@altis/shared';
import type { DashboardResponse } from '@altis/shared/api/dashboard';
import type { ScheduleListResponse } from '@altis/shared/api/jobs';
import { afterAll, afterEach, beforeAll, beforeEach, describe, expect, it } from 'vitest';
import { engineLabel, testDb, testDbContext, type TestDbHandle } from '../../../../tools/test/test-db.js';
import { createApp, type AppState } from '../../src/app.js';
import { createJobRuntime, jobHandlers, type JobRuntime } from '../../src/jobs/runtime.js';
import { createAppOps } from '../../src/services.js';
import { createAgent, type Agent } from '../agent.js';
import { recordingLogger, sampleConfig } from '../support.js';
import { seedStaff, sessionCookieFor, sessionCsrfFor } from '../support-auth.js';

// GET dashboard (plan Task 26, spec §13.3 "Dasbor sistem", decision C33; route catalog `dashboard.get`) on the engine
// picked by ALTIS_TEST_DB: every signed-in staff user has a dashboard, each section and alert filtered by the
// permission of its data; a missing runner shows on `passenger` and one `POST /_cron` clears it (Review Focus 1).

const ctx = testDbContext();
/** In the past: an audit or event row may not be dated ahead of the real clock. 16:00:05 WIB, 27 October 2026. */
const NOW = Date.UTC(2026, 9, 27, 9, 0, 5);
const DAY = 86_400_000;
const SAMPLE = sampleConfig({ db: { dialect: 'sqlite' } });
/** The install date (`install.trialStartedAt`) 2026-10-27, the day of NOW: the backup_missing alert counts from it. */
const CONFIG = { ...SAMPLE, install: { ...SAMPLE.install, trialStartedAt: '2026-10-27' } };
/** baseUrl is https: the session cookie carries the `__Host-` prefix. */
const SID = '__Host-altis_sid';
const DASHBOARD = '/api/v1/dashboard';
/** The edition section every dashboard has (rulings R1, R10). */
const COMMUNITY = { edition: 'community', status: 'active' };

describe.skipIf(!ctx.available)(`GET dashboard [${engineLabel()}]`, () => {
  let h: TestDbHandle;
  let root: string;
  let dataDir: string;
  let superAdmin: string;
  let nobody: string;
  let jobsReader: string;
  let state: AppState;
  let ops: OpsMachine | undefined;
  let runtime: JobRuntime | undefined;
  let app: ReturnType<typeof createApp>;

  /** The app as start() builds it on `runtime`: its ops machine and, in external mode, the job runtime `/_cron` drives. */
  function build(o: { runtime?: Runtime } = {}): void {
    const rt = o.runtime ?? 'passenger';
    const log = recordingLogger();
    state = { phase: 'ready', db: h, config: CONFIG };
    ops = createAppOps(state, { dataDir, version: '0.1.0', log, clock: () => NOW });
    runtime = createJobRuntime({
      state,
      runtime: rt,
      env: {},
      dataDir,
      log,
      clock: () => NOW,
      ops,
      handlers: jobHandlers(),
      requestRestart: async () => {},
      installId: CONFIG.install.id,
      appVersion: '0.1.0',
    });
    state.jobs = runtime;
    app = createApp({ state, version: '0.1.0', buildId: 'b', log, clock: () => NOW, env: {}, dataDir, runtime: rt, appJsVersion: '0.0.9', services: { ops } });
  }

  /** A browser signed in as `userId`. */
  async function browser(userId: string): Promise<Agent> {
    const token = await sessionCookieFor(h, userId, { now: NOW });
    const agent = createAgent(app, { headers: { 'x-csrf-token': sessionCsrfFor(CONFIG, token) } });
    agent.setCookie(SID, token);
    return agent;
  }

  async function dashboardOf(userId: string): Promise<DashboardResponse> {
    const res = await (await browser(userId)).get(DASHBOARD);
    expect(res.status, res.text).toBe(200);
    expect(res.headers.get('cache-control')).toBe('no-store');
    return res.json as DashboardResponse;
  }

  const set = (values: Parameters<typeof writeSettings>[1]) =>
    withTx(h, (trx) => writeSettings(trx, values, { keyring: [], now: NOW, actorId: null }));

  /** Something wrong in every section: a clock anomaly, a failed exposure check, a dead job, a failed backup. */
  async function troubles(): Promise<void> {
    await set({
      'system.clock_anomaly': { detectedAt: NOW - 60_000, maxSeen: NOW + 3_600_000 },
      'system.exposure': { at: NOW - 60_000, ok: false, url: 'https://perpus.sekolah.sch.id/app.js' },
      'audit.verified': { at: NOW - 60_000, ok: false, head: 3, headHash: 'a'.repeat(64), brokenAt: 2 },
    });
    await h.db
      .insertInto('jobs')
      .values({
        id: newId(),
        type: 'test.slices',
        payload: '{}',
        secret_param: null,
        status: 'dead',
        run_at: NOW - DAY,
        max_attempts: 5,
        unique_key: null,
        lock_token: null,
        locked_by: null,
        locked_until: null,
        progress_message: null,
        last_error: 'LEASE_EXPIRED_MAX_ATTEMPTS',
        created_by: null,
        created_at: NOW - DAY,
        updated_at: NOW - DAY,
        finished_at: NOW - DAY,
      })
      .execute();
    await h.db
      .insertInto('backups')
      .values({
        id: newId(),
        kind: 'scheduled',
        size: null,
        sha256: null,
        schema_version: '0.1.0',
        app_version: '0.1.0',
        dialect: h.dialect,
        consistency: 'snapshot',
        status: 'failed',
        created_at: NOW - DAY,
      })
      .execute();
  }

  beforeAll(async () => {
    h = await testDb();
    root = await fsp.realpath(await fsp.mkdtemp(path.join(os.tmpdir(), 'altis-dashboard-api-')));
    await runMigrations(h, { appVersion: '0.1.0', dataDir: path.join(root, 'mig'), migrations: PHASE1_MIGRATIONS });
    superAdmin = (await seedStaff(h, { username: 'kepala', roles: [{ key: 'super_admin' }], now: NOW })).id;
    nobody = (await seedStaff(h, { username: 'tanpa_peran', now: NOW })).id;
    jobsReader = (await seedStaff(h, { username: 'pengamat', roles: [{ permissions: ['system.jobs.read'] }], now: NOW })).id;
  });

  afterAll(async () => {
    await h?.close();
    if (root !== undefined) await fsp.rm(root, { recursive: true, force: true });
  });

  beforeEach(async () => {
    for (const table of ['jobs', 'backups', 'settings', 'schedules', 'events', 'notifications'] as const) await h.db.deleteFrom(table).execute();
    await withTx(h, (trx) => seedSchedules(trx, NOW, 'Asia/Jakarta', SCHEDULES));
    dataDir = path.join(root, `data-${newId()}`);
    await fsp.mkdir(dataDir, { recursive: true });
    ops = undefined;
    runtime = undefined;
  });

  afterEach(async () => {
    await runtime?.stop();
    await ops?.close();
  });

  it('anonymous → 401; a staff user without permissions → the version only, every other section null, no alert', async () => {
    build();
    await troubles();
    expect((await createAgent(app).get(DASHBOARD)).status).toBe(401);
    expect(await dashboardOf(nobody)).toEqual({
      version: { current: '0.1.0', appJs: '0.0.9', bootProtocol: 1, update: null },
      edition: COMMUNITY,
      lastBackup: null,
      nextBackupAt: null,
      queue: null,
      scheduler: null,
      alerts: [],
    });
  });

  it('a super admin gets every section: the edition, the last backup, backup.daily’s next run, the schedules of GET schedules', async () => {
    build();
    await troubles();
    const admin = await browser(superAdmin);
    const res = await admin.get(DASHBOARD);
    expect(res.status, res.text).toBe(200);
    const r = res.json as DashboardResponse;
    const daily = await h.db.selectFrom('schedules').select('next_run_at').where('name', '=', 'backup.daily').executeTakeFirstOrThrow();
    // 1d Task 29: no update check yet; the community edition covers every release.
    expect(r.version).toEqual({
      current: '0.1.0',
      appJs: '0.0.9',
      bootProtocol: 1,
      update: { available: null, checkedAt: null, entitled: true, oneClick: true, pinned: null },
    });
    expect(r.edition).toEqual(COMMUNITY);
    expect(r).not.toHaveProperty('license');
    expect(r.lastBackup).toMatchObject({ status: 'failed', kind: 'scheduled', sameInstall: false });
    expect(r.nextBackupAt).toBe(Number(daily.next_run_at));
    expect(r.queue).toEqual({ queued: 0, running: 0, dead: 1, oldestQueuedMs: null });
    const schedules = (await admin.get('/api/v1/schedules')).json as ScheduleListResponse;
    expect(r.scheduler).toEqual({ runner: { mode: 'external', lastRuns: {} }, schedules: schedules.items });
    expect(r.alerts.map((a) => a.kind)).toEqual([
      'runner_stale',
      'exposure_failed',
      'audit_broken',
      'clock_anomaly',
      'backup_failed',
      'jobs_dead',
      'oai_misconfigured', // Phase 2 (Task 15): OAI is on and its admin e-mail empty by default (spec §10)
    ]);
    expect(r.alerts.find((a) => a.kind === 'jobs_dead')).toEqual({
      kind: 'jobs_dead',
      severity: 'warning',
      messageKey: 'alert.jobs_dead',
      params: { count: 1 },
      link: '/admin/jobs',
    });
  });

  it('system.jobs.read alone: the queue, the scheduler and their alerts, nothing else', async () => {
    build();
    await troubles();
    const r = await dashboardOf(jobsReader);
    expect(r.edition).toEqual(COMMUNITY);
    expect(r.lastBackup).toBeNull();
    expect(r.nextBackupAt).toBeNull();
    expect(r.queue).not.toBeNull();
    expect(r.scheduler?.runner.mode).toBe('external');
    expect(r.alerts.map((a) => a.kind)).toEqual(['runner_stale', 'jobs_dead']);
  });

  it('Review Focus 1: on passenger without a runner → runner_stale; one POST /_cron clears it', async () => {
    build();
    const before = await dashboardOf(jobsReader);
    expect(before.alerts).toContainEqual({
      kind: 'runner_stale',
      severity: 'error',
      messageKey: 'alert.runner_stale',
      link: '/admin/diagnostics',
    });
    const cron = await createAgent(app).post('/_cron', undefined, { authorization: `Bearer ${CONFIG.secrets.cronToken}` });
    expect(cron.status, cron.text).toBe(200);
    const after = await dashboardOf(jobsReader);
    expect(after.alerts.map((a) => a.kind)).not.toContain('runner_stale');
    // (The GET before it may have recorded a piggyback run after its response: no runner had run for 10 minutes.)
    expect(after.scheduler?.runner.lastRuns.cron_http).toBe(NOW);
  });

  it('worker mode (pm2): no runner_stale without any run record', async () => {
    build({ runtime: 'pm2' });
    const r = await dashboardOf(jobsReader);
    expect(r.scheduler?.runner).toEqual({ mode: 'worker', lastRuns: {} });
    expect(r.alerts).toEqual([]);
  });

  it('ops_attention from the app’s ops machine: an unreadable op.json needs attention', async () => {
    build();
    await fsp.mkdir(path.join(dataDir, 'ops'), { recursive: true });
    await fsp.writeFile(path.join(dataDir, 'ops', 'op.json'), 'bukan json');
    const r = await dashboardOf(superAdmin);
    expect(r.alerts).toContainEqual({ kind: 'ops_attention', severity: 'error', messageKey: 'alert.ops_attention', link: '/admin/_update' });
    expect((await dashboardOf(jobsReader)).alerts.map((a) => a.kind)).not.toContain('ops_attention');
  });
});
