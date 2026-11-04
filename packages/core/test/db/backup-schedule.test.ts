import fsp from 'node:fs/promises';
import os from 'node:os';
import path from 'node:path';
import { PHASE1_MIGRATIONS, connect, runMigrations, withTx } from '@altis/db';
import { newId } from '@altis/shared';
import { afterAll, afterEach, beforeAll, beforeEach, describe, expect, it, vi } from 'vitest';
import { engineLabel, testDb, testDbContext, type TestDbHandle } from '../../../../tools/test/test-db.js';
import { BACKUP_CREATE_JOB, backupCreateJob, type BackupJobDeps } from '../../src/backup/create-job.js';
import { backupKind } from '../../src/backup/frozen-op.js';
import { snapshotBackupRunning } from '../../src/backup/mode.js';
import { BACKUP_SCHEDULE_JOB, backupScheduleJob } from '../../src/backup/schedule-job.js';
import type { KeyringEntry } from '../../src/crypto/secret-box.js';
import { claimById } from '../../src/jobs/claim.js';
import { createJobRegistry } from '../../src/jobs/registry.js';
import { createRunner } from '../../src/jobs/runner.js';
import { runSlice } from '../../src/jobs/slice.js';
import { readMaintenance, readOpFile } from '../../src/ops/files.js';
import { createOpsMachine, type OpsMachine } from '../../src/ops/machine.js';
import { SCHEDULES, scheduleWindowSchema } from '../../src/scheduler/registry.js';
import { seedSchedules, tickSchedules } from '../../src/scheduler/tick.js';

// The daily backup (spec §9.9 "Jadwal", §10.4; decisions C31, C41; preflight B5, S16) on the engine picked by
// ALTIS_TEST_DB: `backup.daily` enqueues the light job `backup.schedule` with its window; that job finishes in one slice
// (so `POST /_cron` alone runs it): without a worker or `jobs:run` it begins the frozen op (DB-only), or skips a frozen
// backup estimated over 3 hours with a notification; with one it enqueues `backup.create` (`backup:scheduled`).

vi.mock('@altis/platform', async (importOriginal) => {
  const actual = await importOriginal<typeof import('@altis/platform')>();
  return { ...actual, ensureHeadroom: async () => {} };
});

const ctx = testDbContext();
const KEY = new Uint8Array(32).fill(41);
const KEYRING: KeyringEntry[] = [{ kid: 'k1', key: Buffer.alloc(32, 5).toString('base64url'), active: true }];
const TZ = 'Asia/Jakarta';
const HOUR = 3_600_000;
const silent = { info() {}, warn() {}, error() {} };
const DAILY = SCHEDULES.filter((d) => d.name === 'backup.daily');

describe.skipIf(!ctx.available)(`backup.schedule [${engineLabel()}]`, () => {
  let h: TestDbHandle;
  let root: string;
  let dataDir: string;
  let ops: OpsMachine;
  let offset: number;
  const clock = (): number => Date.now() + offset;
  const deps = (): BackupJobDeps => ({
    dataDir,
    installId: newId(),
    appVersion: '0.1.0',
    sessionKey: KEY,
    kids: ['k1'],
    runtime: 'passenger',
    connectSnapshot: () => connect(h.config, { runtime: 'standalone', purpose: 'cli', dataDir: h.dataDir }),
    ops,
  });
  const reg = createJobRegistry([backupScheduleJob(() => deps()), backupCreateJob(() => deps())]);

  beforeAll(async () => {
    h = await testDb();
    root = await fsp.realpath(await fsp.mkdtemp(path.join(os.tmpdir(), 'altis-backup-schedule-')));
    await runMigrations(h, { appVersion: '0.1.0', dataDir: path.join(root, 'mig'), migrations: PHASE1_MIGRATIONS });
  });

  afterAll(async () => {
    await h?.close();
    if (root !== undefined) await fsp.rm(root, { recursive: true, force: true });
  });

  beforeEach(async () => {
    for (const table of ['jobs', 'locks', 'backups', 'events', 'notifications', 'schedules'] as const) await h.db.deleteFrom(table).execute();
    await h.db.deleteFrom('settings').where('key', 'like', 'system.run.%').execute();
    dataDir = await fsp.mkdtemp(path.join(root, 'data-'));
    offset = 0;
    ops = createOpsMachine({
      dataDir,
      kinds: [backupKind(() => deps())],
      db: () => h,
      connect: () => connect(h.config, { runtime: 'standalone', purpose: 'cli', dataDir: h.dataDir }),
      keyring: () => KEYRING,
      clock,
      log: silent,
      snapshotBackupRunning: () => snapshotBackupRunning(h, Date.now()),
    });
  });

  afterEach(async () => {
    await ops.close();
  });

  /** `backup.daily` seeded a day ago and ticked now: the id of the job it enqueued. */
  async function due(): Promise<string> {
    const seededAt = Date.now() - 25 * HOUR;
    await withTx(h, (trx) => seedSchedules(trx, seededAt, TZ, DAILY));
    expect(await tickSchedules(h, reg, { now: Date.now(), tz: TZ, defs: DAILY, keyring: KEYRING, anomaly: false })).toBe(1);
    const job = await h.db.selectFrom('jobs').selectAll().where('type', '=', BACKUP_SCHEDULE_JOB).executeTakeFirstOrThrow();
    return job.id;
  }

  /** One slice of job `id` as `POST /_cron` runs it. */
  async function cronSlice(id: string) {
    const job = await claimById(h, reg, id, { worker: 'cron', now: clock() });
    if (job === null) throw new Error('not claimable');
    return runSlice(h, reg, job, { mode: 'cron_http', budgetMs: 20_000, keyring: KEYRING, log: silent, clock, env: process.env });
  }

  it('S16: the tick enqueues backup.schedule with the window as its payload, which the handler’s schema accepts', async () => {
    const id = await due();
    const row = await h.db.selectFrom('jobs').selectAll().where('id', '=', id).executeTakeFirstOrThrow();
    const payload: unknown = JSON.parse(row.payload);
    expect(scheduleWindowSchema.safeParse(payload).success).toBe(true);
    expect(reg.get(BACKUP_SCHEDULE_JOB)!.payload.safeParse(payload).success).toBe(true);
    expect(row.unique_key).toMatch(/^sched:backup\.daily:\d+$/);
  });

  it('passenger without a runner record → one cron slice begins the frozen op (scheduled, DB-only) and succeeds', async () => {
    const id = await due();
    expect(await cronSlice(id)).toEqual({ jobId: id, type: BACKUP_SCHEDULE_JOB, outcome: 'succeeded' });
    expect(await readOpFile(dataDir)).toMatchObject({
      kind: 'backup',
      state: 'frozen',
      actor: { type: 'system', id: null },
      params: { kind: 'scheduled', includeFiles: false, scheduleJob: id },
    });
    expect(await readMaintenance(dataDir)).toMatchObject({ reason: 'backup' });
    expect(await h.db.selectFrom('jobs').select('id').where('type', '=', BACKUP_CREATE_JOB).execute()).toEqual([]);
  });

  it('piggyback never takes it: the frozen op it begins would stay unstepped, in maintenance (final review, jobs)', async () => {
    const id = await due();
    const runner = createRunner({
      db: () => h,
      reg,
      ops,
      dataDir,
      scheduler: null,
      keyring: () => KEYRING,
      clock,
      log: silent,
      env: {},
      worker: 'page-view',
    });
    expect(await runner.runFor({ budgetMs: 2000, mode: 'piggyback', excludeHeavy: true })).toEqual([]);
    expect(await readOpFile(dataDir)).toBeNull();
    expect(await readMaintenance(dataDir)).toBeNull();
    expect((await h.db.selectFrom('jobs').select('status').where('id', '=', id).executeTakeFirstOrThrow()).status).toBe('queued');
  });

  it('a frozen backup estimated over 3 hours → skipped with notification.backup_skipped; no op', async () => {
    // A previous backup whose export took 4 hours for the same rows (its manifest written 4 h after it began).
    const { opId } = await ops.begin('backup', { type: 'system', id: null }, { kind: 'manual', includeFiles: false });
    offset = 4000;
    for (let i = 0; i < 200; i += 1) if ((await ops.step(5000))?.terminal === true) break;
    offset = 0;
    const manifest = path.join(dataDir, 'backups', opId, 'manifest.json');
    const createdAt = (JSON.parse(await fsp.readFile(manifest, 'utf8')) as { createdAt: number }).createdAt;
    await fsp.utimes(manifest, new Date(createdAt + 4 * HOUR), new Date(createdAt + 4 * HOUR));
    await h.db.deleteFrom('notifications').execute();

    const id = await due();
    expect((await cronSlice(id)).outcome).toBe('succeeded');
    expect(await readOpFile(dataDir)).toMatchObject({ opId, state: 'done' }); // still the previous one
    expect(await readMaintenance(dataDir)).toBeNull();
    expect(await h.db.selectFrom('notifications').select(['type', 'title_key', 'audience_permission']).execute()).toEqual([
      { type: 'backup.skipped', title_key: 'notification.backup_skipped.title', audience_permission: 'system.backup.read' },
    ]);
  });

  it('a worker run within 10 minutes → backup.create enqueued (scheduled, DB-only, unique key backup:scheduled)', async () => {
    await h.db.insertInto('settings').values({ scope: 'instance', key: 'system.run.worker', value: String(Date.now() - 60_000), updated_at: Date.now(), updated_by: null }).execute();
    const id = await due();
    expect((await cronSlice(id)).outcome).toBe('succeeded');
    const created = await h.db.selectFrom('jobs').selectAll().where('type', '=', BACKUP_CREATE_JOB).execute();
    expect(created).toHaveLength(1);
    expect(created[0]).toMatchObject({ status: 'queued', unique_key: 'backup:scheduled' });
    expect(JSON.parse(created[0]!.payload)).toEqual({ backupId: null, kind: 'scheduled', includeFiles: false, checkpoint: null, snapshot: null });
    expect(await readOpFile(dataDir)).toBeNull();
  });
});
