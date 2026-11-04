import { randomBytes } from 'node:crypto';
import fsp from 'node:fs/promises';
import os from 'node:os';
import path from 'node:path';
import { PHASE1_MIGRATIONS, runMigrations, withTx } from '@altis/db';
import { z } from 'zod';
import { afterAll, beforeAll, beforeEach, describe, expect, it, vi } from 'vitest';
import { engineLabel, testDb, testDbContext, type TestDbHandle } from '../../../../tools/test/test-db.js';
import type { CoreLogger } from '../../src/context.js';
import type { KeyringEntry } from '../../src/crypto/secret-box.js';
import { createJobRegistry } from '../../src/jobs/registry.js';
import type { JobHandler } from '../../src/jobs/types.js';
import { nextRun, parseCronExpr, periodMs } from '../../src/scheduler/cron-expr.js';
import { SCHEDULES, scheduleWindowSchema, type ScheduleDef, type ScheduleWindow } from '../../src/scheduler/registry.js';
import { createScheduler, seedSchedules, tickSchedules } from '../../src/scheduler/tick.js';
import { writeSettings } from '../../src/settings/service.js';

// The scheduler (spec §10.4, §6.5 class `config`; decisions C2, C41; preflight S16) on the engine picked by
// ALTIS_TEST_DB: seeding keeps what an admin may edit and drops rows no definition names; a tick is the compare-and-set
// of §10.4, so of two processes ticking at once only one enqueues `sched:<name>:<scheduled_for>`; missed runs collapse
// into one catch-up run; the payload is the window `{windowStart: last_run_at, windowEnd: scheduled time}`.

const ctx = testDbContext();
const keyring: KeyringEntry[] = [{ kid: 'k1', key: randomBytes(32).toString('base64url'), active: true }];
const TZ = 'Asia/Jakarta';
const HOUR = 3_600_000;
const DAY = 24 * HOUR;
/** 2026-10-29 01:00 WIB: `backup.daily`'s run of that day. */
const T0 = Date.UTC(2026, 9, 28, 18, 0);

const silent: CoreLogger = { info() {}, warn() {}, error() {} };

/** What the handlers of the scheduled types accept: the window, as S16 requires. */
const windowed = (type: string): JobHandler<ScheduleWindow> => ({
  type,
  permission: 'system.jobs.manage',
  retryable: 'api',
  payload: scheduleWindowSchema,
  run: () => Promise.resolve({ done: true }),
});
const custom: JobHandler<ScheduleWindow & { kind: string }> = {
  type: 'test.custom',
  permission: 'system.jobs.manage',
  retryable: 'api',
  payload: scheduleWindowSchema.extend({ kind: z.string() }),
  run: () => Promise.resolve({ done: true }),
};
const reg = createJobRegistry([windowed('backup.schedule'), windowed('housekeeping.volatile'), windowed('audit.anchor'), custom]);

/** backup.daily and retention.volatile and a schedule whose payload is its own. */
const DEFS: readonly ScheduleDef[] = [
  SCHEDULES.find((d) => d.name === 'backup.daily')!,
  SCHEDULES.find((d) => d.name === 'retention.volatile')!,
  {
    name: 'test.custom',
    expr: '0 2 * * *',
    jobType: 'test.custom',
    permission: 'system.jobs.manage',
    enabledByDefault: false,
    payload: (w) => ({ ...w, kind: 'custom' }),
  },
];

describe.skipIf(!ctx.available)(`scheduler [${engineLabel()}]`, () => {
  let h: TestDbHandle;
  let dataDir: string;

  beforeAll(async () => {
    h = await testDb();
    dataDir = await fsp.mkdtemp(path.join(os.tmpdir(), 'altis-core-scheduler-'));
    await runMigrations(h, { appVersion: '0.1.0', dataDir, migrations: PHASE1_MIGRATIONS });
  });

  afterAll(async () => {
    await h?.close();
    if (dataDir !== undefined) await fsp.rm(dataDir, { recursive: true, force: true });
  });

  beforeEach(async () => {
    for (const table of ['jobs', 'schedules', 'settings', 'events', 'notifications'] as const) await h.db.deleteFrom(table).execute();
  });

  const seed = (now: number, defs: readonly ScheduleDef[] = DEFS, tz = TZ) => withTx(h, (trx) => seedSchedules(trx, now, tz, defs));
  const rows = () => h.db.selectFrom('schedules').selectAll().orderBy('name').execute();
  const row = (name: string) => h.db.selectFrom('schedules').selectAll().where('name', '=', name).executeTakeFirstOrThrow();
  const set = (name: string, values: { next_run_at?: number; last_run_at?: number | null; enabled?: 0 | 1; expr?: string }) =>
    h.db.updateTable('schedules').set(values).where('name', '=', name).execute();
  const tick = (now: number, o: { defs?: readonly ScheduleDef[]; log?: CoreLogger; anomaly?: boolean } = {}) =>
    tickSchedules(h, reg, { now, tz: TZ, defs: o.defs ?? DEFS, keyring, anomaly: o.anomaly ?? false, log: o.log ?? silent });
  const jobs = () => h.db.selectFrom('jobs').select(['type', 'unique_key', 'payload', 'status']).orderBy('unique_key').execute();

  describe('seedSchedules', () => {
    it('inserts one row per definition (next_run_at = nextRun(expr, now), enabled = its default); seeding again changes nothing', async () => {
      const now = T0 - 5 * 60_000;
      await seed(now);
      const first = await rows();
      expect(first).toEqual([
        { name: 'backup.daily', expr: '0 1 * * *', enabled: 1, next_run_at: T0, last_run_at: null },
        {
          name: 'retention.volatile',
          expr: '*/10 * * * *',
          enabled: 1,
          next_run_at: nextRun(parseCronExpr('*/10 * * * *'), now, TZ),
          last_run_at: null,
        },
        { name: 'test.custom', expr: '0 2 * * *', enabled: 0, next_run_at: T0 + HOUR, last_run_at: null },
      ]);
      await seed(now + DAY);
      expect(await rows()).toEqual(first);
      // The definitions of this release seed as many rows.
      await seed(now, SCHEDULES);
      expect((await rows()).map((r) => r.name)).toEqual(SCHEDULES.map((d) => d.name).sort());
    });

    it('two seedings at once write one row per definition', async () => {
      await Promise.all([seed(T0), seed(T0), seed(T0)]);
      expect((await rows()).map((r) => r.name)).toEqual(['backup.daily', 'retention.volatile', 'test.custom']);
    });

    it('keeps enabled, the expression of an editable schedule and the run times; resets the expression of one that is not editable', async () => {
      await seed(T0 - HOUR);
      await set('retention.volatile', { enabled: 0, expr: '*/5 * * * *', next_run_at: T0 + 7 * 60_000 });
      await set('backup.daily', { expr: '30 2 * * *', next_run_at: T0 + 90 * 60_000, last_run_at: T0 - DAY });
      await set('test.custom', { enabled: 1 });
      await seed(T0);
      expect(await row('retention.volatile')).toEqual({
        name: 'retention.volatile',
        expr: '*/10 * * * *',
        enabled: 0,
        next_run_at: nextRun(parseCronExpr('*/10 * * * *'), T0, TZ),
        last_run_at: null,
      });
      expect(await row('backup.daily')).toEqual({
        name: 'backup.daily',
        expr: '30 2 * * *',
        enabled: 1,
        next_run_at: T0 + 90 * 60_000,
        last_run_at: T0 - DAY,
      });
      expect((await row('test.custom')).enabled).toBe(1);
    });

    it('an editable expression that no longer parses is reset to the definition', async () => {
      await seed(T0 - HOUR);
      await set('backup.daily', { expr: 'bukan cron' });
      await seed(T0);
      expect(await row('backup.daily')).toMatchObject({ expr: '0 1 * * *', next_run_at: T0 + DAY });
    });

    it('deletes a row no definition names', async () => {
      await seed(T0);
      await h.db.insertInto('schedules').values({ name: 'old.release', expr: '0 0 * * *', enabled: 1, next_run_at: T0, last_run_at: null }).execute();
      await seed(T0);
      expect((await rows()).map((r) => r.name)).toEqual(['backup.daily', 'retention.volatile', 'test.custom']);
      await seed(T0, []);
      expect(await rows()).toEqual([]);
    });
  });

  describe('tickSchedules', () => {
    it('two processes ticking at once: exactly one job with unique_key sched:backup.daily:<t>', async () => {
      await seed(T0 - HOUR);
      const now = T0 + 30_000;
      const counts = await Promise.all([tick(now), tick(now), tick(now)]);
      const daily = (await jobs()).filter((j) => j.type === 'backup.schedule');
      expect(daily).toHaveLength(1);
      expect(daily[0]!.unique_key).toBe(`sched:backup.daily:${T0}`);
      // retention.volatile was due at T0 too.
      expect(counts.reduce((a, b) => a + b, 0)).toBe(2);
      expect(await row('backup.daily')).toMatchObject({ next_run_at: T0 + DAY, last_run_at: now });
    });

    it('a server down for 3 days: one catch-up run, next_run_at tomorrow', async () => {
      await seed(T0 - HOUR);
      const lastRun = T0 - DAY + 2000;
      await set('backup.daily', { last_run_at: lastRun });
      await set('retention.volatile', { enabled: 0 });
      // Three days and five hours later (06:00 WIB).
      const now = T0 + 3 * DAY + 5 * HOUR;
      expect(await tick(now)).toBe(1);
      expect(await tick(now + 60_000)).toBe(0);
      const all = await jobs();
      expect(all).toHaveLength(1);
      expect(all[0]!.unique_key).toBe(`sched:backup.daily:${T0}`);
      expect(await row('backup.daily')).toMatchObject({ next_run_at: T0 + 4 * DAY, last_run_at: now });
      // The payload: from the last run to the time this run was scheduled for.
      expect(JSON.parse(all[0]!.payload)).toEqual({ windowStart: lastRun, windowEnd: T0 });
    });

    it('a schedule that never ran: the window starts one period before its scheduled time', async () => {
      await seed(T0 - HOUR);
      await set('retention.volatile', { enabled: 0 });
      expect(await tick(T0 + 1000)).toBe(1);
      const [job] = await jobs();
      expect(JSON.parse(job!.payload)).toEqual({ windowStart: T0 - periodMs(parseCronExpr('0 1 * * *'), T0, TZ), windowEnd: T0 });
      expect(JSON.parse(job!.payload)).toEqual({ windowStart: T0 - DAY, windowEnd: T0 });
    });

    it('ScheduleDef.payload builds the job payload from the window (S16)', async () => {
      await seed(T0 - HOUR);
      await set('test.custom', { enabled: 1, last_run_at: T0 - 100 });
      await set('backup.daily', { enabled: 0 });
      await set('retention.volatile', { enabled: 0 });
      expect(await tick(T0 + HOUR + 1)).toBe(1);
      const [job] = await jobs();
      expect(job!.unique_key).toBe(`sched:test.custom:${T0 + HOUR}`);
      expect(JSON.parse(job!.payload)).toEqual({ windowStart: T0 - 100, windowEnd: T0 + HOUR, kind: 'custom' });
    });

    it('a disabled schedule enqueues nothing and keeps its next_run_at; one not yet due is left alone', async () => {
      await seed(T0 - HOUR);
      await set('backup.daily', { enabled: 0 });
      await set('retention.volatile', { next_run_at: T0 + 5 * 60_000 });
      expect(await tick(T0 + 1000)).toBe(0);
      expect(await jobs()).toEqual([]);
      expect(await row('backup.daily')).toMatchObject({ next_run_at: T0, last_run_at: null });
      expect(await row('retention.volatile')).toMatchObject({ next_run_at: T0 + 5 * 60_000, last_run_at: null });
    });

    it('a job type without a handler in this release: skipped, logged once; a row no definition names: skipped', async () => {
      const missing: ScheduleDef = { name: 'test.missing', expr: '0 1 * * *', jobType: 'test.not_merged_yet', permission: 'system.jobs.manage', enabledByDefault: true };
      const defs = [...DEFS, missing];
      await seed(T0 - HOUR, defs);
      await h.db.insertInto('schedules').values({ name: 'stray.row', expr: '0 1 * * *', enabled: 1, next_run_at: T0, last_run_at: null }).execute();
      const log = { info: vi.fn(), warn: vi.fn(), error: vi.fn() };
      await tick(T0 + 1000, { defs, log });
      await tick(T0 + 2000, { defs, log });
      expect(await row('test.missing')).toMatchObject({ next_run_at: T0, last_run_at: null });
      expect(await row('stray.row')).toMatchObject({ next_run_at: T0, last_run_at: null });
      expect((await jobs()).map((j) => j.type).sort()).toEqual(['backup.schedule', 'housekeeping.volatile']);
      const notes = log.info.mock.calls.filter(([, fields]) => (fields as { jobType?: string } | undefined)?.jobType === 'test.not_merged_yet');
      expect(notes).toHaveLength(1);
      expect(log.warn).not.toHaveBeenCalled();
    });

    it('a stored expression that does not parse: the row is skipped with one warning', async () => {
      await seed(T0 - HOUR);
      await set('backup.daily', { expr: 'bukan cron' });
      const log = { info: vi.fn(), warn: vi.fn(), error: vi.fn() };
      await tick(T0 + 1000, { log });
      await tick(T0 + 2000, { log });
      expect(await row('backup.daily')).toMatchObject({ next_run_at: T0, last_run_at: null });
      expect(log.warn).toHaveBeenCalledTimes(1);
    });
  });

  describe('createScheduler (the runner’s tick)', () => {
    it('seeds on its first tick in library.timezone, then ticks; a later tick does not seed again', async () => {
      await withTx(h, (trx) => writeSettings(trx, { 'library.timezone': 'Asia/Makassar' }, { keyring: [], now: T0, actorId: null }));
      const scheduler = createScheduler({ db: () => h, reg, defs: DEFS, keyring: () => keyring, log: silent });
      expect(await scheduler.tick(T0 - 2 * HOUR)).toBe(0);
      // 01:00 WITA (UTC+8) is 17:00 UTC.
      expect(await row('backup.daily')).toMatchObject({ next_run_at: T0 - HOUR, last_run_at: null });
      await h.db.insertInto('schedules').values({ name: 'old.release', expr: '0 0 * * *', enabled: 0, next_run_at: T0, last_run_at: null }).execute();
      // backup.daily (17:00 UTC) and retention.volatile (16:10 UTC) are due.
      expect(await scheduler.tick(T0 - HOUR + 1000)).toBe(2);
      expect((await rows()).map((r) => r.name)).toContain('old.release');
      expect(await createScheduler({ db: () => undefined, reg, defs: DEFS, keyring: () => keyring, log: silent }).tick(T0)).toBe(0);
    });

    it('seed() seeds once per scheduler and concurrent calls share it; nothing is remembered without a handle or after a failure', async () => {
      const live: { handle?: TestDbHandle } = {};
      const defs: ScheduleDef[] = [...DEFS, { ...DEFS[0]!, name: 'test.broken', expr: '61 * * * *' }];
      const scheduler = createScheduler({ db: () => live.handle, reg, defs, keyring: () => keyring, log: silent });
      await scheduler.seed(T0);
      live.handle = h;
      await expect(scheduler.seed(T0)).rejects.toMatchObject({ code: 'VALIDATION_FAILED' });
      expect(await rows()).toEqual([]);
      defs.pop();
      await Promise.all([scheduler.seed(T0), scheduler.seed(T0)]);
      expect(await rows()).toHaveLength(3);
      await h.db.deleteFrom('schedules').execute();
      await scheduler.seed(T0);
      expect(await rows()).toEqual([]);
    });
  });
});
