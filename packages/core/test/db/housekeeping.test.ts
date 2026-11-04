import { randomBytes } from 'node:crypto';
import fsp from 'node:fs/promises';
import os from 'node:os';
import path from 'node:path';
import { PHASE1_MIGRATIONS, claimLock, countRows, runMigrations, withTx } from '@altis/db';
import { newId } from '@altis/shared';
import { afterAll, afterEach, beforeAll, beforeEach, describe, expect, it, vi } from 'vitest';
import { engineLabel, testDb, testDbContext, type TestDbHandle } from '../../../../tools/test/test-db.js';
import type { CoreLogger } from '../../src/context.js';
import type { KeyringEntry } from '../../src/crypto/secret-box.js';
import { purgeEvents } from '../../src/events/retention.js';
import { housekeepingJobs } from '../../src/housekeeping/handlers.js';
import { DEAD_JOB_KEEP_MS, FINISHED_JOB_KEEP_MS } from '../../src/housekeeping/jobs.js';
import { LOCK_KEEP_MS } from '../../src/housekeeping/volatile.js';
import { claimById } from '../../src/jobs/claim.js';
import { enqueue } from '../../src/jobs/enqueue.js';
import { createJobRegistry } from '../../src/jobs/registry.js';
import { runSlice } from '../../src/jobs/slice.js';
import type { JobRegistry } from '../../src/jobs/types.js';
import { sweepVolatile } from '../../src/maintenance/sweep.js';
import { SCHEDULES } from '../../src/scheduler/registry.js';
import { seedSchedules, tickSchedules } from '../../src/scheduler/tick.js';
import { readSettings, writeSettings } from '../../src/settings/service.js';
import { BACKUP_SNAPSHOT_LOCK, snapshotBackupRunning } from '../../src/backup/mode.js';

const hooks = vi.hoisted(() => ({
  /** Called with the path of every removeFile, before the file is removed. */
  beforeRemoveFile: null as ((p: string) => Promise<void>) | null,
}));
vi.mock('@altis/platform', async (importOriginal) => {
  const actual = await importOriginal<typeof import('@altis/platform')>();
  const removeFile: typeof actual.removeFile = async (p) => {
    await hooks.beforeRemoveFile?.(p);
    return actual.removeFile(p);
  };
  return { ...actual, removeFile };
});

// The housekeeping jobs of Task 18 (spec §6.5, §7.5, §10.4, §10.6, §10.9; decisions C24, C26; M24; preflight B5, S16)
// on the engine picked by ALTIS_TEST_DB: the scheduled purges of the volatile tables, events, notifications and
// finished jobs, and the files cleanup of DATA_DIR. While `system.clock_anomaly` is set every purge deletes nothing.
// 1b's sweep cases (D19, sweep.test.ts) live on here: `sweepVolatile` stays, its opportunistic sweeper is gone.

const ctx = testDbContext();
const keyring: KeyringEntry[] = [{ kid: 'k1', key: randomBytes(32).toString('base64url'), active: true }];
const silent: CoreLogger = { info() {}, warn() {}, error() {} };

const MIN = 60_000;
const HOUR = 60 * MIN;
const DAY = 24 * HOUR;
const TZ = 'Asia/Jakarta';

const hex = (n: number, len = 64): string => n.toString(16).padStart(len, '0');

describe.skipIf(!ctx.available)(`housekeeping jobs [${engineLabel()}]`, () => {
  let h: TestDbHandle;
  let migDir: string;
  let dataDir: string;
  /** The slices' clock: the real time when the test began (file times are real). */
  let now: number;
  const subject = newId();

  beforeAll(async () => {
    h = await testDb();
    migDir = await fsp.mkdtemp(path.join(os.tmpdir(), 'altis-core-housekeeping-mig-'));
    await runMigrations(h, { appVersion: '0.1.0', dataDir: migDir, migrations: PHASE1_MIGRATIONS });
  });

  afterAll(async () => {
    await h?.close();
    if (migDir !== undefined) await fsp.rm(migDir, { recursive: true, force: true });
  });

  beforeEach(async () => {
    for (const t of [
      'rate_limits',
      'sessions',
      'remember_tokens',
      'password_resets',
      'idempotency_keys',
      'upload_sessions',
      'locks',
      'notifications',
      'jobs',
      'events',
      'event_consumers',
      'schedules',
      'settings',
      'backups',
    ] as const) {
      await h.db.deleteFrom(t).execute();
    }
    dataDir = await fsp.realpath(await fsp.mkdtemp(path.join(os.tmpdir(), 'altis-core-housekeeping-')));
    now = Date.now();
    hooks.beforeRemoveFile = null;
  });

  afterEach(async () => {
    await fsp.rm(dataDir, { recursive: true, force: true });
  });

  const registry = (): JobRegistry => createJobRegistry(housekeepingJobs({ dataDir }));
  const window = () => ({ windowStart: now - 10 * MIN, windowEnd: now });

  /** Enqueues `type` and runs its slices (each claimed anew, as any process would) until it ends. */
  async function runJob(type: string, o: { payload?: unknown; budgetMs?: number } = {}): Promise<{ slices: number; status: string }> {
    const reg = registry();
    const { id } = await withTx(h, (trx) => enqueue(trx, reg, { type, payload: o.payload ?? window() }, { now, keyring }));
    let slices = 0;
    for (;;) {
      const job = await claimById(h, reg, id, { worker: 'test', now });
      if (job === null) break;
      slices += 1;
      if (slices > 500) throw new Error(`${type}: no end after 500 slices`);
      const result = await runSlice(h, reg, job, { mode: 'worker', budgetMs: o.budgetMs ?? 20_000, keyring, log: silent, clock: () => now, env: {} });
      if (result.outcome !== 'continued') {
        expect(result, type).toMatchObject({ outcome: 'succeeded' });
        break;
      }
    }
    const row = await h.db.selectFrom('jobs').select('status').where('id', '=', id).executeTakeFirstOrThrow();
    return { slices, status: row.status };
  }

  async function anomaly(): Promise<void> {
    await withTx(h, (trx) =>
      writeSettings(trx, { 'system.clock_anomaly': { detectedAt: now, maxSeen: now + HOUR } }, { keyring, now, actorId: null }),
    );
  }

  // ---------------------------------------------------------------------------------------------------------------

  describe('payloads (S16)', () => {
    it('every schedule of these jobs enqueues, at its tick, a payload its handler accepts; each handler has its schedule’s permission', async () => {
      const reg = registry();
      const defs = SCHEDULES.filter((d) => reg.get(d.jobType) !== undefined);
      expect(defs.map((d) => d.jobType).sort()).toEqual(
        [
          'audit.anchor',
          'audit.retention',
          'housekeeping.events',
          'housekeeping.files',
          'housekeeping.jobs',
          'housekeeping.notifications',
          'housekeeping.volatile',
        ].sort(),
      );
      for (const d of defs) expect(reg.get(d.jobType)!.permission, d.name).toBe(d.permission);
      await withTx(h, (trx) => seedSchedules(trx, now - DAY, TZ, defs));
      await h.db.updateTable('schedules').set({ next_run_at: now - MIN }).execute();
      expect(await tickSchedules(h, reg, { now, tz: TZ, defs, keyring, anomaly: false, log: silent })).toBe(defs.length);
      const jobs = await h.db.selectFrom('jobs').select(['type', 'payload']).execute();
      expect(jobs.map((j) => j.type).sort()).toEqual(defs.map((d) => d.jobType).sort());
      for (const job of jobs) {
        expect(reg.get(job.type)!.payload.safeParse(JSON.parse(job.payload)).success, job.type).toBe(true);
      }
    });
  });

  // ---------------------------------------------------------------------------------------------------------------

  describe('volatile', () => {
    async function session(n: number, expiresAt: number): Promise<void> {
      await h.db
        .insertInto('sessions')
        .values({ id: hex(n), subject_type: 'staff', subject_id: subject, created_at: now - HOUR, last_seen_at: now - HOUR, expires_at: expiresAt, ip: null, user_agent: null, reauth_at: null, remember_selector: null })
        .execute();
    }
    async function rememberToken(n: number, expiresAt: number): Promise<void> {
      await h.db
        .insertInto('remember_tokens')
        .values({ selector: hex(n, 24), validator_hash: hex(n), prev_validator_hash: null, rotated_at: null, subject_type: 'staff', subject_id: subject, expires_at: expiresAt, last_used_at: null })
        .execute();
    }
    async function passwordReset(n: number, expiresAt: number): Promise<void> {
      await h.db
        .insertInto('password_resets')
        .values({ token_hash: hex(n), subject_type: 'staff', subject_id: subject, expires_at: expiresAt, used_at: null })
        .execute();
    }
    async function rateLimit(n: number, windowStart: number): Promise<void> {
      await h.db.insertInto('rate_limits').values({ bucket: hex(n), window_start: windowStart, bucket_name: `test:${n}`, count: 3 }).execute();
    }
    async function idempotencyKey(n: number, createdAt: number): Promise<void> {
      await h.db
        .insertInto('idempotency_keys')
        .values({ subject_type: 'staff', subject_id: subject, key: `k-${n}`, request_hash: hex(n), status: 'done', locked_until: createdAt + 30_000, response_status: 200, response_body: '{}', created_at: createdAt })
        .execute();
    }

    async function left(): Promise<Record<string, string[]>> {
      return {
        rate_limits: (await h.db.selectFrom('rate_limits').select('bucket_name').orderBy('bucket_name').execute()).map((r) => r.bucket_name),
        sessions: (await h.db.selectFrom('sessions').select('id').orderBy('id').execute()).map((r) => r.id),
        remember_tokens: (await h.db.selectFrom('remember_tokens').select('selector').orderBy('selector').execute()).map((r) => r.selector),
        password_resets: (await h.db.selectFrom('password_resets').select('token_hash').orderBy('token_hash').execute()).map((r) => r.token_hash),
        idempotency_keys: (await h.db.selectFrom('idempotency_keys').select('key').orderBy('key').execute()).map((r) => r.key),
      };
    }

    /** Two expired rows, one exactly at the cut (kept: strictly older is expired) and one live row per table. */
    async function seed(at: number): Promise<void> {
      await rateLimit(1, at - 48 * HOUR - 15 * MIN);
      await rateLimit(2, at - 48 * HOUR - 1);
      await rateLimit(3, at - 48 * HOUR);
      await rateLimit(4, at);
      for (const fn of [session, rememberToken, passwordReset]) {
        await fn(1, at - HOUR);
        await fn(2, at - 1);
        await fn(3, at);
        await fn(4, at + HOUR);
      }
      await idempotencyKey(1, at - 25 * HOUR);
      await idempotencyKey(2, at - 24 * HOUR - 1);
      await idempotencyKey(3, at - 24 * HOUR);
      await idempotencyKey(4, at);
    }

    const kept = {
      rate_limits: ['test:3', 'test:4'],
      sessions: [hex(3), hex(4)],
      remember_tokens: [hex(3, 24), hex(4, 24)],
      password_resets: [hex(3), hex(4)],
      idempotency_keys: ['k-3', 'k-4'],
    };

    it('sweepVolatile (1b, D19) deletes exactly the expired rows of each table and keeps the rest', async () => {
      await seed(now);
      expect(await sweepVolatile(h, now)).toEqual({
        deleted: { rate_limits: 2, sessions: 2, remember_tokens: 2, password_resets: 2, idempotency_keys: 2 },
      });
      expect(await left()).toEqual(kept);
      expect(await sweepVolatile(h, now)).toEqual({
        deleted: { rate_limits: 0, sessions: 0, remember_tokens: 0, password_resets: 0, idempotency_keys: 0 },
      });
    });

    it('sweepVolatile runs its own transactions: refused inside a withTx callback (R49), nothing deleted', async () => {
      await seed(now);
      await expect(withTx(h, () => sweepVolatile(h, now))).rejects.toThrow(TypeError);
      expect((await left()).sessions).toHaveLength(4);
    });

    async function upload(id: string, expiresAt: number): Promise<string> {
      await h.db
        .insertInto('upload_sessions')
        .values({ id, owner: `staff:${subject}`, context: 'backup', size: 10, sha256: hex(9), chunk_size: 5 * 1024 * 1024, expires_at: expiresAt })
        .execute();
      const dir = path.join(dataDir, 'tmp', id);
      await fsp.mkdir(dir, { recursive: true });
      await fsp.writeFile(path.join(dir, 'upload.bin'), '12345');
      return dir;
    }
    const exists = (p: string): Promise<boolean> =>
      fsp.lstat(p).then(
        () => true,
        () => false,
      );

    it('housekeeping.volatile: the 1b sweep, an expired upload session with its staging folder, and locks an hour past their end', async () => {
      await seed(now);
      const expired = newId();
      const live = newId();
      const expiredDir = await upload(expired, now - 1);
      const liveDir = await upload(live, now + HOUR);
      await h.db
        .insertInto('locks')
        .values([
          { name: 'old', owner: 'x', until: now - 2 * HOUR },
          { name: 'edge', owner: 'x', until: now - LOCK_KEEP_MS },
          { name: 'recent', owner: 'x', until: now - 30 * MIN },
          { name: 'held', owner: 'x', until: now + MIN },
        ])
        .execute();

      expect(LOCK_KEEP_MS).toBe(HOUR);
      expect(await runJob('housekeeping.volatile')).toEqual({ slices: 1, status: 'succeeded' });
      expect(await left()).toEqual(kept);
      expect((await h.db.selectFrom('upload_sessions').select('id').execute()).map((r) => r.id)).toEqual([live]);
      expect(await exists(expiredDir)).toBe(false);
      expect(await exists(liveDir)).toBe(true);
      expect((await h.db.selectFrom('locks').select('name').orderBy('name').execute()).map((r) => r.name)).toEqual(['edge', 'held', 'recent']);
    });

    it('an expired upload session whose lock another request holds is left for the next run', async () => {
      const busy = newId();
      const dir = await upload(busy, now - 1);
      await h.db.insertInto('locks').values({ name: `upload:${busy}`, owner: 'someone', until: Date.now() + MIN }).execute();
      expect(await runJob('housekeeping.volatile')).toMatchObject({ status: 'succeeded' });
      expect(await countRows(h.db.selectFrom('upload_sessions'))).toBe(1);
      expect(await exists(dir)).toBe(true);
    });
  });

  // ---------------------------------------------------------------------------------------------------------------

  describe('boundaries', () => {
    async function notification(expiresAt: number, read = false): Promise<string> {
      const id = newId();
      await h.db
        .insertInto('notifications')
        .values({
          id,
          audience_permission: 'system.jobs.read',
          user_id: null,
          type: 'test.notice',
          title_key: 'notification.ops_attention.title',
          params: '{}',
          link: null,
          created_at: expiresAt - 90 * DAY,
          expires_at: expiresAt,
        })
        .execute();
      if (read) await h.db.insertInto('notification_reads').values({ notification_id: id, user_id: newId(), read_at: now - DAY }).execute();
      return id;
    }

    it('notifications: expired 1 ms ago deleted with its read markers, 1 ms ahead kept', async () => {
      const gone = await notification(now - 1, true);
      const stays = await notification(now + 1, true);
      expect(await runJob('housekeeping.notifications')).toEqual({ slices: 1, status: 'succeeded' });
      expect((await h.db.selectFrom('notifications').select('id').execute()).map((r) => r.id)).toEqual([stays]);
      expect((await h.db.selectFrom('notification_reads').select('notification_id').execute()).map((r) => r.notification_id)).toEqual([stays]);
      expect(gone).not.toBe(stays);
    });

    async function job(status: string, finishedAt: number | null): Promise<string> {
      const id = newId();
      await h.db
        .insertInto('jobs')
        .values({
          id,
          type: 'test.old',
          payload: '{}',
          secret_param: null,
          status,
          run_at: now - 40 * DAY,
          max_attempts: 5,
          unique_key: null,
          created_by: null,
          created_at: now - 40 * DAY,
          updated_at: finishedAt ?? now - 40 * DAY,
          finished_at: finishedAt,
        })
        .execute();
      return id;
    }

    it('jobs: succeeded/cancelled 7 d + 1 ms after finishing deleted, 7 d − 1 ms kept; dead 31 d deleted, 8 d kept; live jobs never', async () => {
      expect(FINISHED_JOB_KEEP_MS).toBe(7 * DAY);
      expect(DEAD_JOB_KEEP_MS).toBe(30 * DAY);
      const kept = [
        await job('succeeded', now - 7 * DAY + 1),
        await job('cancelled', now - 7 * DAY + 1),
        await job('succeeded', now - 7 * DAY),
        await job('dead', now - 8 * DAY),
        await job('dead', now - 30 * DAY),
        await job('queued', null),
        await job('running', null),
      ];
      await job('succeeded', now - 7 * DAY - 1);
      await job('cancelled', now - 7 * DAY - 1);
      await job('dead', now - 31 * DAY);
      await job('dead', now - 30 * DAY - 1);
      const { status } = await runJob('housekeeping.jobs');
      expect(status).toBe('succeeded');
      const ids = (await h.db.selectFrom('jobs').select('id').where('type', '=', 'test.old').orderBy('id').execute()).map((r) => r.id);
      expect(ids).toEqual([...kept].sort());
    });

    it('with system.clock_anomaly set every purge deletes nothing (and still ends done)', async () => {
      await h.db
        .insertInto('sessions')
        .values({ id: hex(1), subject_type: 'staff', subject_id: subject, created_at: now - DAY, last_seen_at: now - DAY, expires_at: now - HOUR, ip: null, user_agent: null, reauth_at: null, remember_selector: null })
        .execute();
      await h.db.insertInto('locks').values({ name: 'old', owner: 'x', until: now - 3 * HOUR }).execute();
      await notification(now - DAY);
      await job('succeeded', now - 10 * DAY);
      await h.db.insertInto('events').values({ channel: 'system.status', type: 'notification', payload: '{}', created_at: now - 40 * DAY }).execute();
      const tmp = path.join(dataDir, 'tmp', newId(now - 3 * DAY));
      await fsp.mkdir(tmp, { recursive: true });
      const old = new Date(now - 3 * DAY);
      await fsp.utimes(tmp, old, old);
      await anomaly();

      for (const type of ['housekeeping.volatile', 'housekeeping.events', 'housekeeping.notifications', 'housekeeping.jobs', 'housekeeping.files']) {
        expect(await runJob(type), type).toEqual({ slices: 1, status: 'succeeded' });
      }
      expect(await countRows(h.db.selectFrom('sessions'))).toBe(1);
      expect(await countRows(h.db.selectFrom('locks'))).toBe(1);
      expect(await countRows(h.db.selectFrom('notifications'))).toBe(1);
      expect(await countRows(h.db.selectFrom('jobs').where('type', '=', 'test.old'))).toBe(1);
      // (The jobs' own events are on `jobs.<id>`.)
      expect(await countRows(h.db.selectFrom('events').where('channel', '=', 'system.status'))).toBe(1);
      expect((await fsp.stat(tmp)).isDirectory()).toBe(true);
    });
  });

  // ---------------------------------------------------------------------------------------------------------------

  describe('events', () => {
    async function bulk(n: number, at: number): Promise<void> {
      for (let done = 0; done < n; done += 500) {
        const rows = Array.from({ length: Math.min(500, n - done) }, () => ({ channel: 'system.status', type: 'notification', payload: '{}', created_at: at }));
        await h.db.insertInto('events').values(rows).execute();
      }
    }
    const floor = async (): Promise<unknown> => (await readSettings(h.db, ['system.events_floor'], []))['system.events_floor'];

    it('purgeEvents with a deadline that has passed: one batch of 5000, then more: true; without one it runs to the end', async () => {
      await bulk(5200, now - 40 * DAY);
      expect(await purgeEvents(h, now, { deadline: Date.now() - 1 })).toEqual({ deleted: 5000, reindexFlagged: [], more: true });
      expect(await countRows(h.db.selectFrom('events'))).toBe(200);
      expect(await purgeEvents(h, now, { deadline: Date.now() + MIN })).toEqual({ deleted: 200, reindexFlagged: [], more: false });
      expect(await countRows(h.db.selectFrom('events'))).toBe(0);
    });

    it('the first purge creates the floor row, which then only goes up (carry-over: no lock without a row)', async () => {
      await bulk(3, now - 40 * DAY);
      expect(await h.db.selectFrom('settings').select('key').where('key', '=', 'system.events_floor').execute()).toEqual([]);
      const top = Number((await h.db.selectFrom('events').select((eb) => eb.fn.max('seq').as('m')).executeTakeFirstOrThrow()).m);
      await Promise.all([purgeEvents(h, now), purgeEvents(h, now)]);
      expect(await floor()).toBe(top);
      // Nothing left to delete: the floor stays where it is.
      await purgeEvents(h, now);
      expect(await floor()).toBe(top);
    });

    it('housekeeping.events purges by the retention rules', async () => {
      await bulk(3, now - 40 * DAY);
      await bulk(2, now - DAY);
      expect(await runJob('housekeeping.events')).toEqual({ slices: 1, status: 'succeeded' });
      expect(await countRows(h.db.selectFrom('events').where('channel', '=', 'system.status'))).toBe(2);
    });
  });

  // ---------------------------------------------------------------------------------------------------------------

  describe('files', () => {
    const P = (...segments: string[]): string => path.join(dataDir, ...segments);
    const exists = (p: string): Promise<boolean> =>
      fsp.lstat(p).then(
        () => true,
        () => false,
      );
    async function file(p: string, content = 'x', ageMs?: number): Promise<void> {
      await fsp.mkdir(path.dirname(p), { recursive: true });
      await fsp.writeFile(p, content);
      if (ageMs !== undefined) await age(p, ageMs);
    }
    async function age(p: string, ageMs: number): Promise<void> {
      const t = new Date(now - ageMs);
      await fsp.utimes(p, t, t);
    }
    function opJson(opId: string, o: { state: string; finishedAt: number | null; kind?: string }): string {
      return JSON.stringify({
        opSchema: 1,
        opId,
        kind: o.kind ?? 'restore',
        actor: { type: 'cli', id: null },
        state: o.state,
        version: '0.1.0',
        backupId: null,
        heartbeatAt: o.finishedAt ?? now,
        startedAt: (o.finishedAt ?? now) - HOUR,
        finishedAt: o.finishedAt,
        error: null,
        opsTokenHash: null,
        pointOfNoReturn: false,
        params: {},
        progress: 100,
        message: null,
      });
    }
    async function backupRow(id: string, status: string): Promise<void> {
      await h.db
        .insertInto('backups')
        .values({ id, kind: 'manual', size: null, sha256: null, schema_version: '0009', app_version: '0.1.0', dialect: 'sqlite', consistency: 'snapshot', status, created_at: now - DAY })
        .execute();
    }

    /** The DATA_DIR of every case below: what goes and what stays, by the rules of housekeeping.files. */
    async function fixture(): Promise<{ gone: string[]; stays: string[] }> {
      const gone: string[] = [];
      const stays: string[] = [];
      // Prepared downloads (C15): 5 min after completedAt, or 1 h after readyAt.
      const b1 = newId();
      const b2 = newId();
      const prepared = async (backup: string, readyAt: number, completedAt: number | null): Promise<string> => {
        const dir = P('backups', backup, 'downloads', newId());
        await file(path.join(dir, 'archive.altisbak'), 'zip');
        await file(path.join(dir, 'prepared.json'), JSON.stringify({ jobId: newId(), readyAt, size: 3, encrypted: true, completedAt }));
        return dir;
      };
      gone.push(await prepared(b1, now - 10 * MIN, now - 5 * MIN - 1));
      stays.push(await prepared(b1, now - 10 * MIN, now - 4 * MIN));
      gone.push(await prepared(b2, now - HOUR - 1, null));
      stays.push(await prepared(b2, now - 59 * MIN, null));
      // tmp/<ulid>/ older than 24 h: not of a live upload session nor of the active op.
      const oldTmp = P('tmp', newId(now - 2 * DAY));
      await file(path.join(oldTmp, 'upload.bin'), 'x', 2 * DAY);
      await age(oldTmp, 2 * DAY);
      gone.push(oldTmp);
      const sessionId = newId(now - 2 * DAY);
      const sessionTmp = P('tmp', sessionId);
      await file(path.join(sessionTmp, 'upload.bin'), 'x', 2 * DAY);
      await age(sessionTmp, 2 * DAY);
      await h.db
        .insertInto('upload_sessions')
        .values({ id: sessionId, owner: `staff:${newId()}`, context: 'backup', size: 1, sha256: hex(1), chunk_size: 1024, expires_at: now + HOUR })
        .execute();
      stays.push(sessionTmp);
      const activeOp = newId(now - 2 * DAY);
      const opTmp = P('tmp', activeOp, 'src');
      await fsp.mkdir(opTmp, { recursive: true });
      await age(P('tmp', activeOp), 2 * DAY);
      await file(P('ops', 'op.json'), opJson(activeOp, { state: 'loading', finishedAt: null }));
      stays.push(opTmp);
      const freshTmp = P('tmp', newId(now - 2 * DAY));
      await fsp.mkdir(freshTmp, { recursive: true }); // made now: its folder is young
      stays.push(freshTmp);
      await file(P('tmp', 'cron-flight.json'), '{}', 2 * DAY);
      stays.push(P('tmp', 'cron-flight.json'));
      // .work of a failed backup goes; of a running one stays.
      const failed = newId();
      const running = newId();
      await backupRow(failed, 'failed');
      await backupRow(running, 'running');
      await file(P('backups', failed, '.work', 'snapshot.sqlite'));
      await file(P('backups', running, '.work', 'snapshot.sqlite'));
      gone.push(P('backups', failed, '.work'));
      stays.push(P('backups', failed), P('backups', running, '.work'));
      // Archived ops (M24): keep/ and db/<opId>/pre-restore.sqlite 7 days after the op finished, op.json after 90.
      const o1 = newId(now - 9 * DAY);
      await file(P('ops', o1, 'op.json'), opJson(o1, { state: 'done', finishedAt: now - 7 * DAY - 1 }));
      await file(P('ops', o1, 'keep', 'audit_log.jsonl.gz'));
      await file(P('db', o1, 'pre-restore.sqlite'));
      gone.push(P('ops', o1, 'keep'), P('db', o1));
      stays.push(P('ops', o1, 'op.json'));
      const o2 = newId(now - 7 * DAY);
      await file(P('ops', o2, 'op.json'), opJson(o2, { state: 'failed', finishedAt: now - 6 * DAY }));
      await file(P('ops', o2, 'keep', 'audit_log.jsonl.gz'));
      await file(P('db', o2, 'pre-restore.sqlite'));
      stays.push(P('ops', o2, 'keep'), P('db', o2, 'pre-restore.sqlite'));
      const o3 = newId(now - 92 * DAY);
      await file(P('ops', o3, 'op.json'), opJson(o3, { state: 'done', finishedAt: now - 90 * DAY - 1, kind: 'migrate' }));
      gone.push(P('ops', o3));
      // Temporary siblings a killed process left in backups/ and backups/blobs/ (carry-over), older than 24 h.
      await file(P('backups', '.manifest.json.tmp-1-0123456789ab'), 'x', 25 * HOUR);
      await file(P('backups', 'blobs', `.${hex(7)}.tmp-1-0123456789ab`), 'x', 25 * HOUR);
      await file(P('backups', 'blobs', `.${hex(8)}.tmp-1-0123456789ab`), 'x', 23 * HOUR);
      gone.push(P('backups', '.manifest.json.tmp-1-0123456789ab'), P('backups', 'blobs', `.${hex(7)}.tmp-1-0123456789ab`));
      stays.push(P('backups', 'blobs', `.${hex(8)}.tmp-1-0123456789ab`));
      // ... and inside a backup's own folder and its table folders (a part a killed export was writing, Task 11), and in
      // the upload store's month folders (a stored file a killed request was writing).
      await file(P('backups', b1, '.manifest.json.tmp-2-0123456789ab'), 'x', 25 * HOUR);
      await file(P('backups', b1, 'tables', 'audit_log', '.00003.jsonl.gz.tmp-2-0123456789ab'), 'x', 25 * HOUR);
      await file(P('backups', b1, 'tables', 'audit_log', '.00004.jsonl.gz.tmp-3-0123456789ab'), 'x', 23 * HOUR);
      await file(P('backups', b1, 'tables', 'audit_log', '00001.jsonl.gz'), 'x', 25 * HOUR);
      gone.push(P('backups', b1, '.manifest.json.tmp-2-0123456789ab'), P('backups', b1, 'tables', 'audit_log', '.00003.jsonl.gz.tmp-2-0123456789ab'));
      stays.push(P('backups', b1, 'tables', 'audit_log', '.00004.jsonl.gz.tmp-3-0123456789ab'), P('backups', b1, 'tables', 'audit_log', '00001.jsonl.gz'));
      const stored = newId(now - 2 * DAY);
      await file(P('uploads', '2026', '10', `.${stored}.tmp-4-0123456789ab`), 'x', 25 * HOUR);
      await file(P('uploads', '2026', '10', stored), 'x', 25 * HOUR);
      gone.push(P('uploads', '2026', '10', `.${stored}.tmp-4-0123456789ab`));
      stays.push(P('uploads', '2026', '10', stored));
      // Blobs: none is in a kept backup's manifest, but a backup is running: gcBlobs waits.
      await file(P('backups', 'blobs', hex(5)));
      stays.push(P('backups', 'blobs', hex(5)));
      return { gone, stays };
    }

    async function check(f: { gone: string[]; stays: string[] }): Promise<void> {
      for (const p of f.gone) expect(await exists(p), `gone: ${path.relative(dataDir, p)}`).toBe(false);
      for (const p of f.stays) expect(await exists(p), `stays: ${path.relative(dataDir, p)}`).toBe(true);
    }

    it('housekeeping.files removes what its rules name and nothing else', async () => {
      const f = await fixture();
      expect(await runJob('housekeeping.files')).toEqual({ slices: 1, status: 'succeeded' });
      await check(f);
    });

    it('works per item against the slice budget: with none left after each item it continues by checkpoint, to the same end', async () => {
      const f = await fixture();
      const { slices, status } = await runJob('housekeeping.files', { budgetMs: 0 });
      expect(status).toBe('succeeded');
      expect(slices).toBeGreaterThan(5);
      await check(f);
    });

    it('gcBlobs runs once no backup is running and every kept backup has a readable manifest', async () => {
      const blob = P('backups', 'blobs', hex(5));
      await file(blob);
      const ok = newId();
      await backupRow(ok, 'ok'); // without a manifest: its blobs are unknown, so none is collected
      expect(await runJob('housekeeping.files')).toMatchObject({ status: 'succeeded' });
      expect(await exists(blob)).toBe(true);
      await h.db.updateTable('backups').set({ status: 'failed' }).where('id', '=', ok).execute();
      expect(await runJob('housekeeping.files')).toMatchObject({ status: 'succeeded' });
      expect(await exists(blob)).toBe(false);
    });

    it('gcBlobs holds backup:snapshot: a snapshot backup cannot start (nor a freezing op begin) while it removes blobs', async () => {
      const blob = P('backups', 'blobs', hex(5));
      await file(blob);
      let started: boolean | null = null;
      let blocked: boolean | null = null;
      hooks.beforeRemoveFile = async (p) => {
        if (started !== null || path.dirname(p) !== P('backups', 'blobs')) return;
        // A manual snapshot backup with files begins right now (backup.create's first slice: the lock, then its row;
        // its blobs phase would find this blob present and reuse it).
        started = await claimLock(h, BACKUP_SNAPSHOT_LOCK, `job:${newId()}`, 50_000);
        if (started) await backupRow(newId(), 'running');
        // What ops.begin asks before a freezing op (a frozen backup, a restore): OPS_BLOCKED_BY_BACKUP while true.
        blocked = await snapshotBackupRunning(h, Date.now());
      };
      expect(await runJob('housekeeping.files')).toMatchObject({ status: 'succeeded' });
      expect(started).toBe(false);
      expect(blocked).toBe(true);
      expect(await exists(blob)).toBe(false);
      // Released at the end of the slice.
      expect(await h.db.selectFrom('locks').select('name').where('name', '=', BACKUP_SNAPSHOT_LOCK).execute()).toEqual([]);
    });

    it('while another holds backup:snapshot (a snapshot backup between its checks and its row) no blob goes, and the lock stays its', async () => {
      const blob = P('backups', 'blobs', hex(5));
      await file(blob);
      const owner = `job:${newId()}`;
      expect(await claimLock(h, BACKUP_SNAPSHOT_LOCK, owner, 50_000)).toBe(true);
      expect(await runJob('housekeeping.files')).toMatchObject({ status: 'succeeded' });
      expect(await exists(blob)).toBe(true);
      expect(await h.db.selectFrom('locks').select('owner').where('name', '=', BACKUP_SNAPSHOT_LOCK).execute()).toEqual([{ owner }]);
    });

    it('yields to a snapshot backup that waits for its next slice: with a backup.create job queued it takes no lock and removes no blob', async () => {
      const blob = P('backups', 'blobs', hex(5));
      await file(blob);
      let taken = false;
      hooks.beforeRemoveFile = async (p) => {
        if (path.dirname(p) === P('backups', 'blobs')) taken = true;
      };
      const t = Date.now();
      await h.db
        .insertInto('jobs')
        .values({ id: newId(), type: 'backup.create', payload: JSON.stringify({ backupId: null, kind: 'manual', includeFiles: true, checkpoint: null, snapshot: null }), status: 'queued', run_at: t + MIN, max_attempts: 2, created_at: t, updated_at: t })
        .execute();
      expect(await runJob('housekeeping.files')).toMatchObject({ status: 'succeeded' });
      expect(taken).toBe(false);
      expect(await exists(blob)).toBe(true);
    });

    it('removes the blobs one by one against the slice budget (P9), continuing after the last one removed', async () => {
      const blobs = [1, 2, 3, 4, 5, 6].map((n) => P('backups', 'blobs', hex(n)));
      for (const b of blobs) await file(b);
      const removedPerSlice: number[] = [];
      let current = 0;
      hooks.beforeRemoveFile = async (p) => {
        if (path.dirname(p) === P('backups', 'blobs')) current += 1;
      };
      const reg = registry();
      const { id } = await withTx(h, (trx) => enqueue(trx, reg, { type: 'housekeeping.files', payload: window() }, { now, keyring }));
      for (let i = 0; i < 100; i += 1) {
        const job = await claimById(h, reg, id, { worker: 'test', now });
        if (job === null) break;
        current = 0;
        const r = await runSlice(h, reg, job, { mode: 'worker', budgetMs: 0, keyring, log: silent, clock: () => now, env: {} });
        removedPerSlice.push(current);
        if (r.outcome !== 'continued') break;
      }
      for (const b of blobs) expect(await exists(b)).toBe(false);
      expect(Math.max(...removedPerSlice)).toBe(1);
    });

    /** `backups/<id>/` with one part, every folder of it last changed `ageMs` ago. */
    async function backupFolder(id: string, ageMs: number): Promise<string> {
      await file(P('backups', id, 'tables', 'audit_log', '00001.jsonl.gz'), 'x', ageMs);
      for (const dir of [P('backups', id, 'tables', 'audit_log'), P('backups', id, 'tables'), P('backups', id)]) await age(dir, ageMs);
      return P('backups', id);
    }

    it('leftovers: the folder of a deleted or failed backup, or of none, goes once it is 24 h old; any other stays', async () => {
      const old = 25 * HOUR;
      const gone: string[] = [];
      const stays: string[] = [];
      for (const status of ['deleted', 'failed']) {
        const id = newId(now - 3 * DAY);
        await backupRow(id, status);
        gone.push(await backupFolder(id, old));
        const young = newId(now - 3 * DAY);
        await backupRow(young, status);
        stays.push(await backupFolder(young, HOUR)); // its removal is under way, or just failed
      }
      gone.push(await backupFolder(newId(now - 3 * DAY), old)); // no row: retention's row and folder out of step
      stays.push(await backupFolder(newId(now - HOUR), old)); // no row yet, made an hour ago (an archive copied in)
      for (const status of ['ok', 'uploaded']) {
        const id = newId(now - 3 * DAY);
        await backupRow(id, status);
        stays.push(await backupFolder(id, old));
      }
      await file(P('backups', 'blobs', hex(9)), 'x', old);
      const blobs = P('backups', 'blobs');
      await age(blobs, old);
      await backupRow(newId(), 'ok'); // its manifest is missing: the blobs stay as they are
      stays.push(P('backups', 'blobs', hex(9)));
      expect(await runJob('housekeeping.files')).toMatchObject({ status: 'succeeded' });
      for (const p of gone) expect(await exists(p), `gone: ${path.relative(dataDir, p)}`).toBe(false);
      for (const p of stays) expect(await exists(p), `stays: ${path.relative(dataDir, p)}`).toBe(true);
    });

    it('leftovers wait while a backup is not at rest: a backup.create job queued, or an op active', async () => {
      const leftover = await backupFolder(newId(now - 3 * DAY), 25 * HOUR);
      const t = Date.now();
      const job = newId();
      await h.db
        .insertInto('jobs')
        .values({ id: job, type: 'backup.create', payload: JSON.stringify({ backupId: null, kind: 'manual', includeFiles: false, checkpoint: null, snapshot: null }), status: 'queued', run_at: t + MIN, max_attempts: 2, created_at: t, updated_at: t })
        .execute();
      expect(await runJob('housekeeping.files')).toMatchObject({ status: 'succeeded' });
      expect(await exists(leftover)).toBe(true);
      await h.db.deleteFrom('jobs').where('id', '=', job).execute();
      await file(P('ops', 'op.json'), opJson(newId(), { state: 'loading', finishedAt: null }));
      expect(await runJob('housekeeping.files')).toMatchObject({ status: 'succeeded' });
      expect(await exists(leftover)).toBe(true);
      await fsp.rm(P('ops', 'op.json'));
      expect(await runJob('housekeeping.files')).toMatchObject({ status: 'succeeded' });
      expect(await exists(leftover)).toBe(false);
    });

    it('a downloads folder without prepared.json goes once nothing in it changed for 24 h (a preparation that died)', async () => {
      const dead = P('backups', newId(), 'downloads', newId());
      await file(path.join(dead, 'archive.altisbak'), 'part', 25 * HOUR);
      await age(dead, 25 * HOUR);
      const busy = P('backups', newId(), 'downloads', newId());
      await file(path.join(busy, 'archive.altisbak'), 'part', MIN);
      expect(await runJob('housekeeping.files')).toMatchObject({ status: 'succeeded' });
      expect(await exists(dead)).toBe(false);
      expect(await exists(busy)).toBe(true);
    });
  });
});
