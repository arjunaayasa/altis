import { randomBytes } from 'node:crypto';
import fsp from 'node:fs/promises';
import os from 'node:os';
import path from 'node:path';
import { PHASE1_MIGRATIONS, runMigrations, withTx } from '@altis/db';
import { newId } from '@altis/shared';
import { z } from 'zod';
import { afterAll, afterEach, beforeAll, beforeEach, describe, expect, it, vi } from 'vitest';
import { engineLabel, testDb, testDbContext, type TestDbHandle } from '../../../../tools/test/test-db.js';
import { runnerFor, txCtx, type Actor, type CoreLogger } from '../../src/context.js';
import type { KeyringEntry } from '../../src/crypto/secret-box.js';
import { claimNext } from '../../src/jobs/claim.js';
import { enqueue } from '../../src/jobs/enqueue.js';
import { createJobRegistry } from '../../src/jobs/registry.js';
import { createRunner } from '../../src/jobs/runner.js';
import { closeJobSessions } from '../../src/jobs/slice.js';
import { JOB_LEASE_MS, type JobHandler } from '../../src/jobs/types.js';
import { createOpsMachine, type OpsMachine } from '../../src/ops/machine.js';
import {
  CLOCK_TOLERANCE_MS,
  clearClockAnomaly,
  confirmClock,
  detectClockAnomaly,
  readClockAnomaly,
  refreshClockAnomaly,
} from '../../src/scheduler/clock.js';
import { nextRun, parseCronExpr } from '../../src/scheduler/cron-expr.js';
import { SCHEDULES, scheduleWindowSchema, type ScheduleWindow } from '../../src/scheduler/registry.js';
import { createScheduler, seedSchedules, tickSchedules } from '../../src/scheduler/tick.js';
import { readSettings, writeSettings } from '../../src/settings/service.js';

// clock_anomaly (spec §10.4, decision C3, preflight S18) on the engine picked by ALTIS_TEST_DB: raised when now is
// more than 5 minutes before the latest schedule run or audit entry, or a schedule's next run lies beyond twice its
// period (one notification to system.diagnostics.read, one `clock.anomaly` event on system.status); while it holds,
// ticks recompute next_run_at instead of running ahead of time and leases or locks far ahead count as expired; it
// never clears itself: an admin's confirmation (clamping the future timestamps, audited) or a signed time within
// ±5 minutes does.

// The runner's claimNext, spied on (the anomaly must reach it).
vi.mock('../../src/jobs/claim.js', async (importOriginal) => {
  const actual = await importOriginal<typeof import('../../src/jobs/claim.js')>();
  return { ...actual, claimNext: vi.fn(actual.claimNext) };
});

const ctx = testDbContext();
const keyring: KeyringEntry[] = [{ kid: 'k1', key: randomBytes(32).toString('base64url'), active: true }];
const TZ = 'Asia/Jakarta';
const MIN = 60_000;
const HOUR = 60 * MIN;
const DAY = 24 * HOUR;
const silent: CoreLogger = { info() {}, warn() {}, error() {} };
const SYSTEM: Actor = { type: 'system', id: null, ip: null };
/** Two days ago, on a whole minute: audit entries may not be dated ahead of the real clock (R51). */
const T = Math.floor(Date.now() / MIN) * MIN - 2 * DAY;

const windowed = (type: string, extra: Partial<JobHandler<ScheduleWindow>> = {}): JobHandler<ScheduleWindow> => ({
  type,
  permission: 'system.jobs.manage',
  retryable: 'api',
  payload: scheduleWindowSchema,
  run: () => Promise.resolve({ done: true }),
  ...extra,
});
const heavy: JobHandler<Record<string, never>> = {
  type: 'test.heavy',
  permission: 'system.jobs.manage',
  retryable: 'api',
  cpuHeavy: true,
  payload: z.strictObject({}),
  run: () => Promise.resolve({ done: true }),
};
const reg = createJobRegistry([windowed('backup.schedule'), windowed('housekeeping.volatile'), heavy]);

describe.skipIf(!ctx.available)(`clock_anomaly [${engineLabel()}]`, () => {
  let h: TestDbHandle;
  let dataDir: string;
  let machines: OpsMachine[];

  beforeAll(async () => {
    h = await testDb();
    dataDir = await fsp.mkdtemp(path.join(os.tmpdir(), 'altis-core-clock-'));
    await runMigrations(h, { appVersion: '0.1.0', dataDir, migrations: PHASE1_MIGRATIONS });
  });

  afterAll(async () => {
    await closeJobSessions();
    await h?.close();
    if (dataDir !== undefined) await fsp.rm(dataDir, { recursive: true, force: true });
  });

  beforeEach(async () => {
    for (const table of ['jobs', 'locks', 'schedules', 'settings', 'events', 'notifications', 'audit_log', 'backups'] as const) {
      await h.db.deleteFrom(table).execute();
    }
    await h.db.updateTable('audit_head').set({ last_seq: 0, last_hash: '0'.repeat(64) }).where('id', '=', 1).execute();
    machines = [];
    vi.mocked(claimNext).mockClear();
  });

  afterEach(async () => {
    for (const m of machines) await m.close();
  });

  const seed = (now: number) => withTx(h, (trx) => seedSchedules(trx, now, TZ, SCHEDULES));
  const set = (name: string, values: { next_run_at?: number; last_run_at?: number | null; enabled?: 0 | 1 }) =>
    h.db.updateTable('schedules').set(values).where('name', '=', name).execute();
  const schedule = (name: string) => h.db.selectFrom('schedules').selectAll().where('name', '=', name).executeTakeFirstOrThrow();
  const refresh = (now: number) => refreshClockAnomaly(h, { now, tz: TZ, defs: SCHEDULES });
  const notifications = () => h.db.selectFrom('notifications').selectAll().execute();
  const anomalyEvents = () => h.db.selectFrom('events').selectAll().where('type', '=', 'clock.anomaly').execute();
  const audit = (at: number) =>
    withTx(h, (trx) => txCtx(trx, at, SYSTEM).audit({ action: 'schedules.update', entity: 'schedules', entityId: 'backup.daily' }));
  const raise = (now: number, maxSeen: number) =>
    withTx(h, (trx) =>
      writeSettings(trx, { 'system.clock_anomaly': { detectedAt: now, maxSeen } }, { keyring: [], now, actorId: null }),
    );

  function machine(clock: () => number): OpsMachine {
    const m = createOpsMachine({
      dataDir,
      kinds: [],
      db: () => h,
      connect: () => Promise.reject(new Error('the live handle is used here')),
      keyring: () => keyring,
      clock,
      log: silent,
      snapshotBackupRunning: async () => false,
    });
    machines.push(m);
    return m;
  }

  describe('detection', () => {
    it('last_run_at = T, now = T − 6 min → raised: one notification to system.diagnostics.read, one clock.anomaly event', async () => {
      await seed(T - DAY);
      await set('backup.daily', { last_run_at: T });
      const now = T - 6 * MIN;
      expect(await refresh(now)).toEqual({ active: true });
      expect(await readClockAnomaly(h.db)).toEqual({ detectedAt: now, maxSeen: T });
      const sent = await notifications();
      expect(sent).toHaveLength(1);
      expect(sent[0]).toMatchObject({
        audience_permission: 'system.diagnostics.read',
        user_id: null,
        type: 'clock.anomaly',
        title_key: 'notification.clock_anomaly.title',
        link: '/admin/diagnostics',
      });
      const events = await anomalyEvents();
      expect(events).toHaveLength(1);
      expect(events[0]).toMatchObject({ channel: 'system.status' });
      expect(JSON.parse(events[0]!.payload)).toEqual({ detectedAt: now, maxSeen: T });
      // It holds and is kept: no second notification, no second event, the first detection stays.
      expect(await refresh(now + MIN)).toEqual({ active: true });
      expect(await readClockAnomaly(h.db)).toEqual({ detectedAt: now, maxSeen: T });
      expect(await notifications()).toHaveLength(1);
      expect(await anomalyEvents()).toHaveLength(1);
    });

    it('now = T − 4 min → none', async () => {
      await seed(T - DAY);
      await set('backup.daily', { last_run_at: T });
      expect(CLOCK_TOLERANCE_MS).toBe(5 * MIN);
      expect(await detectClockAnomaly(h.db, { now: T - 4 * MIN, tz: TZ, defs: SCHEDULES })).toBeNull();
      expect(await refresh(T - 4 * MIN)).toEqual({ active: false });
      expect(await readClockAnomaly(h.db)).toBeNull();
      expect(await notifications()).toEqual([]);
    });

    it('an audit entry dated T, now = T − 6 min → raised; T − 4 min → none', async () => {
      await audit(T);
      expect(await detectClockAnomaly(h.db, { now: T - 4 * MIN, tz: TZ, defs: SCHEDULES })).toBeNull();
      expect(await detectClockAnomaly(h.db, { now: T - 6 * MIN, tz: TZ, defs: SCHEDULES })).toEqual({ detectedAt: T - 6 * MIN, maxSeen: T });
    });

    it('a */10 schedule with next_run_at = now + 21 min → raised; now + 19 min → none; a disabled one never', async () => {
      await seed(T);
      await set('retention.volatile', { next_run_at: T + 19 * MIN });
      expect(await detectClockAnomaly(h.db, { now: T, tz: TZ, defs: SCHEDULES })).toBeNull();
      await set('retention.volatile', { next_run_at: T + 21 * MIN });
      // maxSeen: the latest time the clock must have shown, the far run less one period.
      expect(await detectClockAnomaly(h.db, { now: T, tz: TZ, defs: SCHEDULES })).toEqual({ detectedAt: T, maxSeen: T + 11 * MIN });
      await set('retention.volatile', { enabled: 0 });
      expect(await detectClockAnomaly(h.db, { now: T, tz: TZ, defs: SCHEDULES })).toBeNull();
    });

    it('the night the clocks go back: a */10 run 65 minutes ahead that nextRun gives from now is no anomaly', async () => {
      // Europe/Berlin, 2026-10-25 02:55 CEST: every local time up to 03:00 has run in the first pass of the repeated
      // hour, so the next run is 03:00 CET, 65 minutes later, more than two periods ahead.
      const tz = 'Europe/Berlin';
      const now = Date.UTC(2026, 9, 25, 0, 55);
      const next = nextRun(parseCronExpr('*/10 * * * *'), now, tz);
      expect(next).toBe(now + 65 * MIN);
      await seed(now);
      for (const d of SCHEDULES) await set(d.name, { enabled: 0 });
      await set('retention.volatile', { enabled: 1, next_run_at: next });
      expect(await detectClockAnomaly(h.db, { now, tz, defs: SCHEDULES })).toBeNull();
      // One period later than that was computed by a clock ahead.
      await set('retention.volatile', { next_run_at: next + 10 * MIN });
      expect(await detectClockAnomaly(h.db, { now, tz, defs: SCHEDULES })).toEqual({ detectedAt: now, maxSeen: next });
    });

    it('processes refreshing at once raise it once: one notification, one event', async () => {
      await seed(T - DAY);
      await set('backup.daily', { last_run_at: T });
      const results = await Promise.all([refresh(T - 10 * MIN), refresh(T - 10 * MIN), refresh(T - 10 * MIN)]);
      expect(results).toEqual([{ active: true }, { active: true }, { active: true }]);
      expect(await notifications()).toHaveLength(1);
      expect(await anomalyEvents()).toHaveLength(1);
    });
  });

  describe('while it is active', () => {
    it('a tick enqueues nothing ahead of time and recomputes next_run_at; a run already due still runs once', async () => {
      await seed(T - DAY);
      const now = T;
      await set('backup.daily', { next_run_at: now + 3 * DAY, last_run_at: now + 2 * DAY });
      await set('retention.volatile', { next_run_at: now - MIN });
      const scheduler = createScheduler({ db: () => h, reg, defs: SCHEDULES, keyring: () => keyring, log: silent });
      expect(await scheduler.tick(now)).toBe(1);
      // Raised by the far next run (and the last run ahead of now), so the tick ran under it.
      expect(await readClockAnomaly(h.db)).not.toBeNull();
      expect(await schedule('backup.daily')).toMatchObject({ next_run_at: nextRun(parseCronExpr('0 1 * * *'), now, TZ), last_run_at: now + 2 * DAY });
      const jobs = await h.db.selectFrom('jobs').select(['type', 'unique_key']).execute();
      expect(jobs).toEqual([{ type: 'housekeeping.volatile', unique_key: `sched:retention.volatile:${now - MIN}` }]);
      // Without the anomaly flag a run ahead of now is left alone.
      await set('backup.daily', { next_run_at: now + 3 * DAY });
      expect(await tickSchedules(h, reg, { now, tz: TZ, defs: SCHEDULES, keyring, anomaly: false, log: silent })).toBe(0);
      expect((await schedule('backup.daily')).next_run_at).toBe(now + 3 * DAY);
    });

    it('claimNext gets anomaly: true from the runner', async () => {
      const now = Date.now();
      await withTx(h, (trx) => enqueue(trx, reg, { type: 'housekeeping.volatile', payload: { windowStart: 0, windowEnd: 1 } }, { now, keyring }));
      await raise(now, now + DAY);
      const runner = createRunner({
        db: () => h,
        reg,
        ops: machine(() => now),
        dataDir,
        scheduler: createScheduler({ db: () => h, reg, defs: SCHEDULES, keyring: () => keyring, log: silent }),
        keyring: () => keyring,
        clock: () => now,
        log: silent,
        env: {},
        worker: 'clock-test',
      });
      const report = await runner.pass({ budgetMs: 20_000, mode: 'cron_http' });
      expect(report.slices).toBe(1);
      expect(vi.mocked(claimNext)).toHaveBeenCalled();
      for (const [, , o] of vi.mocked(claimNext).mock.calls) expect(o).toMatchObject({ anomaly: true });
    });

    it('a jobs:heavy lock row with until = now + 1 day does not block a heavy job (S18); without the anomaly it does', async () => {
      const now = Date.now();
      await h.db.insertInto('locks').values({ name: 'jobs:heavy', owner: 'gone-process', until: now + DAY }).execute();
      const id = await withTx(h, (trx) => enqueue(trx, reg, { type: 'test.heavy', payload: {} }, { now, keyring })).then((r) => r.id);
      const runner = () =>
        createRunner({
          db: () => h,
          reg,
          ops: machine(() => Date.now()),
          dataDir,
          scheduler: null,
          keyring: () => keyring,
          clock: () => Date.now(),
          log: silent,
          env: {},
          worker: 'clock-test',
        });
      expect((await runner().pass({ budgetMs: 20_000, mode: 'cron_http' })).slices).toBe(0);
      expect((await h.db.selectFrom('jobs').select('status').where('id', '=', id).executeTakeFirstOrThrow()).status).toBe('queued');
      await raise(now, now + DAY);
      expect((await runner().pass({ budgetMs: 20_000, mode: 'cron_http' })).slices).toBe(1);
      expect((await h.db.selectFrom('jobs').select('status').where('id', '=', id).executeTakeFirstOrThrow()).status).toBe('succeeded');
    });
  });

  describe('confirmClock (decision C3)', () => {
    it('clears it and clamps the future timestamps to now; one diagnostics.clock_confirm entry; later refreshes stay quiet', async () => {
      const now = T;
      await seed(T - DAY);
      await set('backup.daily', { last_run_at: now + 2 * DAY, next_run_at: now + 3 * DAY });
      await set('retention.volatile', { next_run_at: now + 5 * MIN, last_run_at: now - 10 * MIN });
      await audit(now + HOUR);
      expect(await refresh(now)).toEqual({ active: true });
      const raised = await readClockAnomaly(h.db);
      expect(raised).toEqual({ detectedAt: now, maxSeen: now + 2 * DAY });

      const put = async (patch: { status: string; run_at: number; locked_until: number | null }) => {
        const { id } = await withTx(h, (trx) => enqueue(trx, reg, { type: 'housekeeping.volatile', payload: { windowStart: 0, windowEnd: 1 } }, { now, keyring }));
        await h.db.updateTable('jobs').set(patch).where('id', '=', id).execute();
        return id;
      };
      const farLease = await put({ status: 'running', run_at: now, locked_until: now + 5 * MIN });
      const liveLease = await put({ status: 'running', run_at: now, locked_until: now + JOB_LEASE_MS });
      const farRun = await put({ status: 'queued', run_at: now + 2 * HOUR, locked_until: null });
      const retryRun = await put({ status: 'queued', run_at: now + 30 * MIN, locked_until: null });
      await h.db
        .insertInto('locks')
        .values([
          { name: 'jobs:heavy', owner: 'gone', until: now + DAY },
          { name: 'backup:snapshot', owner: 'alive', until: now + 5 * MIN },
        ])
        .execute();
      // Backups stamped while the clock ran ahead: ranked newest, the retention would keep them over the real ones.
      const backup = async (createdAt: number) => {
        const id = newId();
        await h.db
          .insertInto('backups')
          .values({ id, kind: 'scheduled', size: 1, sha256: null, schema_version: '0009_ops_jobs', app_version: '0.1.0', dialect: h.dialect, consistency: 'snapshot', status: 'ok', created_at: createdAt })
          .execute();
        return id;
      };
      const aheadBackup = await backup(now + 2 * DAY);
      const pastBackup = await backup(now - DAY);

      await confirmClock(runnerFor(h, now, { type: 'cli', id: null, ip: null }), { now });

      expect(await readClockAnomaly(h.db)).toBeNull();
      const head = await h.db.selectFrom('audit_head').select('last_seq').where('id', '=', 1).executeTakeFirstOrThrow();
      expect((await readSettings(h.db, ['system.clock_confirmed'], []))['system.clock_confirmed']).toEqual({ at: now, auditSeq: Number(head.last_seq) });
      expect(await schedule('backup.daily')).toMatchObject({ last_run_at: now, next_run_at: nextRun(parseCronExpr('0 1 * * *'), now, TZ) });
      expect(await schedule('retention.volatile')).toMatchObject({ last_run_at: now - 10 * MIN, next_run_at: now + 5 * MIN });
      const job = (id: string) => h.db.selectFrom('jobs').select(['run_at', 'locked_until']).where('id', '=', id).executeTakeFirstOrThrow();
      expect(await job(farLease)).toEqual({ run_at: now, locked_until: now });
      expect(await job(liveLease)).toEqual({ run_at: now, locked_until: now + JOB_LEASE_MS });
      expect(await job(farRun)).toEqual({ run_at: now, locked_until: null });
      expect(await job(retryRun)).toEqual({ run_at: now + 30 * MIN, locked_until: null });
      const locks = await h.db.selectFrom('locks').select(['name', 'until']).orderBy('name').execute();
      expect(locks).toEqual([
        { name: 'backup:snapshot', until: now + 5 * MIN },
        { name: 'jobs:heavy', until: now },
      ]);
      const createdAt = async (id: string) => Number((await h.db.selectFrom('backups').select('created_at').where('id', '=', id).executeTakeFirstOrThrow()).created_at);
      expect(await createdAt(aheadBackup)).toBe(now);
      expect(await createdAt(pastBackup)).toBe(now - DAY);
      const confirmations = await h.db.selectFrom('audit_log').selectAll().where('action', '=', 'diagnostics.clock_confirm').execute();
      expect(confirmations).toHaveLength(1);
      expect(confirmations[0]).toMatchObject({ at: now, actor_type: 'cli' });
      expect(JSON.parse(confirmations[0]!.meta)).toEqual({ maxSeen: now + 2 * DAY });

      // The audit entry dated an hour ahead was written before the confirmation: it no longer raises the anomaly.
      expect(await detectClockAnomaly(h.db, { now, tz: TZ, defs: SCHEDULES })).toBeNull();
      expect(await refresh(now)).toEqual({ active: false });
      expect(await notifications()).toHaveLength(1);
      // A new entry dated ahead does.
      await audit(now + HOUR);
      expect(await detectClockAnomaly(h.db, { now, tz: TZ, defs: SCHEDULES })).toEqual({ detectedAt: now, maxSeen: now + HOUR });
    });

    it('without an active anomaly: still clamps and records the confirmation (maxSeen null)', async () => {
      const now = T;
      await confirmClock(runnerFor(h, now, { type: 'cli', id: null, ip: null }), { now });
      const [entry] = await h.db.selectFrom('audit_log').selectAll().where('action', '=', 'diagnostics.clock_confirm').execute();
      expect(JSON.parse(entry!.meta)).toEqual({ maxSeen: null });
      expect(await readClockAnomaly(h.db)).toBeNull();
    });
  });

  describe('clearClockAnomaly (signed time, 1d)', () => {
    it('a trusted time 4 min off clears it (and the future timestamps); 6 min off does not', async () => {
      const now = T;
      await seed(T - DAY);
      await set('backup.daily', { last_run_at: now + DAY });
      await refresh(now);
      expect(await readClockAnomaly(h.db)).not.toBeNull();

      expect(await clearClockAnomaly(h, { now, trustedTime: now + 6 * MIN, source: 'feed' })).toBe(false);
      expect(await clearClockAnomaly(h, { now, trustedTime: now - 6 * MIN, source: 'heartbeat' })).toBe(false);
      expect(await readClockAnomaly(h.db)).not.toBeNull();

      expect(await clearClockAnomaly(h, { now, trustedTime: now - 4 * MIN, source: 'clock_token' })).toBe(true);
      expect(await readClockAnomaly(h.db)).toBeNull();
      expect((await schedule('backup.daily')).last_run_at).toBe(now);
      // Not raised again by what it clamped; nothing to clear any more.
      expect(await refresh(now)).toEqual({ active: false });
      expect(await clearClockAnomaly(h, { now, trustedTime: now, source: 'feed' })).toBe(false);
      // An automatic clear is not an admin confirmation: no audit entry.
      expect(await h.db.selectFrom('audit_log').selectAll().where('action', '=', 'diagnostics.clock_confirm').execute()).toEqual([]);
    });

    it('refuses a malformed time or source', async () => {
      await expect(clearClockAnomaly(h, { now: T, trustedTime: Number.NaN, source: 'feed' })).rejects.toThrow(TypeError);
      await expect(clearClockAnomaly(h, { now: T, trustedTime: T, source: 'ntp' as never })).rejects.toThrow(TypeError);
    });
  });
});
