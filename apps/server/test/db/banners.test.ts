import fsp from 'node:fs/promises';
import os from 'node:os';
import path from 'node:path';
import { SCHEDULES, scheduleWindowSchema, type JobHandler, type ScheduleWindow } from '@altis/core';
import { PHASE1_MIGRATIONS, runMigrations } from '@altis/db';
import type { Banner, MeResponse } from '@altis/shared/api/auth';
import { afterAll, afterEach, beforeAll, beforeEach, describe, expect, it } from 'vitest';
import { engineLabel, testDb, testDbContext, type TestDbHandle } from '../../../../tools/test/test-db.js';
import { createApp, type AppState } from '../../src/app.js';
import { createJobRuntime, jobHandlers, type JobRuntime } from '../../src/jobs/runtime.js';
import { createAppOps } from '../../src/services.js';
import { createAgent } from '../agent.js';
import { recordingLogger, sampleConfig } from '../support.js';
import { seedStaff, sessionCookieFor } from '../support-auth.js';

// The clock banner (spec §10.4, decision D32; Task 14) on the engine picked by ALTIS_TEST_DB: the job runtime's pass
// seeds the schedules and ticks them, raising clock_anomaly when a schedule ran later than now; `GET auth/me` then lists
// a `clock` banner (warning, link to Diagnostik) for the holders of system.diagnostics.read, and for nobody else.

const ctx = testDbContext();
/** In the past: notifications and events are dated by it, never ahead of the real clock. */
const NOW = Date.UTC(2026, 9, 20, 9, 0, 5);
const MIN = 60_000;
const CONFIG = sampleConfig({ db: { dialect: 'sqlite' } });
/** baseUrl is https: the cookies carry the `__Host-` prefix. */
const SID = '__Host-altis_sid';
const ME = '/api/v1/auth/me';
const CLOCK_BANNER: Banner = { kind: 'clock', severity: 'warning', messageKey: 'banner.clock', link: '/admin/diagnostics' };

/** The handler of `retention.volatile`'s job type (Task 18 brings the real one). */
const volatile: JobHandler<ScheduleWindow> = {
  type: 'housekeeping.volatile',
  permission: 'system.jobs.manage',
  retryable: 'api',
  payload: scheduleWindowSchema,
  run: () => Promise.resolve({ done: true }),
};

describe.skipIf(!ctx.available)(`the clock banner [${engineLabel()}]`, () => {
  let h: TestDbHandle;
  let migDir: string;
  let dataDir: string;
  let app: ReturnType<typeof createApp>;
  let runtime: JobRuntime | undefined;
  const tokens = new Map<string, string>();

  beforeAll(async () => {
    h = await testDb();
    migDir = await fsp.mkdtemp(path.join(os.tmpdir(), 'altis-banners-mig-'));
    await runMigrations(h, { appVersion: '0.1.0', dataDir: migDir, migrations: PHASE1_MIGRATIONS });
    app = createApp({ state: { phase: 'ready', db: h, config: CONFIG }, version: '0.1.0', buildId: 'b', log: recordingLogger(), clock: () => NOW });
    const users = {
      superAdmin: await seedStaff(h, { username: 'super', now: NOW, roles: [{ key: 'super_admin' }] }),
      diagnostics: await seedStaff(h, { username: 'diagnostik', now: NOW, roles: [{ permissions: ['system.diagnostics.read'] }] }),
      jobs: await seedStaff(h, { username: 'tugas', now: NOW, roles: [{ permissions: ['system.jobs.read', 'system.jobs.manage'] }] }),
    };
    for (const [name, user] of Object.entries(users)) tokens.set(name, await sessionCookieFor(h, user.id, { now: NOW }));
  });

  afterAll(async () => {
    await h?.close();
    if (migDir !== undefined) await fsp.rm(migDir, { recursive: true, force: true });
  });

  beforeEach(async () => {
    for (const table of ['jobs', 'locks', 'schedules', 'settings', 'events', 'notifications'] as const) await h.db.deleteFrom(table).execute();
    dataDir = await fsp.realpath(await fsp.mkdtemp(path.join(os.tmpdir(), 'altis-banners-')));
    runtime = undefined;
  });

  afterEach(async () => {
    await runtime?.stop();
    await fsp.rm(dataDir, { recursive: true, force: true });
  });

  /** The job runtime of a passenger process (no loop: each pass is a cron call). */
  function makeRuntime(clock: () => number): JobRuntime {
    const log = recordingLogger();
    const state: AppState = { phase: 'ready', db: h, config: CONFIG };
    runtime = createJobRuntime({
      state,
      runtime: 'passenger',
      env: {},
      dataDir,
      log,
      clock,
      ops: createAppOps(state, { dataDir, version: '0.1.0', log, clock }),
      handlers: [volatile, ...jobHandlers()],
      requestRestart: async () => {},
      installId: CONFIG.install.id,
      appVersion: '0.1.0',
    });
    return runtime;
  }

  async function bannersOf(user: string): Promise<Banner[]> {
    const agent = createAgent(app);
    agent.setCookie(SID, tokens.get(user)!);
    const res = await agent.get(ME);
    expect(res.status, res.text).toBe(200);
    const body = res.json as Extract<MeResponse, { authenticated: true }>;
    expect(body.stage).toBe('full');
    return body.banners;
  }

  it('the runtime seeds the schedules at start and ticks them in its passes: a due run is enqueued once and runs', async () => {
    let now = NOW;
    const rt = makeRuntime(() => now);
    rt.start();
    await expect.poll(async () => (await h.db.selectFrom('schedules').select('name').execute()).length).toBe(SCHEDULES.length);
    await h.db.updateTable('schedules').set({ next_run_at: NOW - MIN }).where('name', '=', 'retention.volatile').execute();
    now = NOW + 1000;
    const report = await rt.cron('cron_http', 20_000);
    expect(report).toMatchObject({ scheduled: 1, slices: 1 });
    const jobs = await h.db.selectFrom('jobs').select(['type', 'unique_key', 'status', 'payload']).execute();
    expect(jobs).toEqual([{ type: 'housekeeping.volatile', unique_key: null, status: 'succeeded', payload: expect.any(String) }]);
    expect(JSON.parse(jobs[0]!.payload)).toEqual({ windowStart: NOW - 11 * MIN, windowEnd: NOW - MIN });
    // The next pass finds nothing due.
    now = NOW + 2000;
    expect(await rt.cron('cron_http', 20_000)).toMatchObject({ scheduled: 0, slices: 0 });
    expect(await bannersOf('superAdmin')).toEqual([]);
  });

  it('a schedule that ran 10 minutes after now: the pass raises clock_anomaly; super admins and diagnostics readers see the clock banner, others none', async () => {
    const rt = makeRuntime(() => NOW);
    await rt.cron('cron_http', 20_000);
    expect(await bannersOf('superAdmin')).toEqual([]);
    await h.db.updateTable('schedules').set({ last_run_at: NOW + 10 * MIN }).where('name', '=', 'backup.daily').execute();
    await rt.cron('cron_http', 20_000);
    const anomaly = await h.db.selectFrom('settings').select('value').where('key', '=', 'system.clock_anomaly').executeTakeFirstOrThrow();
    expect(JSON.parse(anomaly.value!)).toEqual({ detectedAt: NOW, maxSeen: NOW + 10 * MIN });
    expect(await bannersOf('superAdmin')).toEqual([CLOCK_BANNER]);
    expect(await bannersOf('diagnostics')).toEqual([CLOCK_BANNER]);
    expect(await bannersOf('jobs')).toEqual([]);
    expect(await h.db.selectFrom('notifications').select('type').execute()).toEqual([{ type: 'clock.anomaly' }]);
  });
});
