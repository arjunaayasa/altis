import fsp from 'node:fs/promises';
import os from 'node:os';
import path from 'node:path';
import { PHASE1_MIGRATIONS, runMigrations, withTx } from '@altis/db';
import { newId } from '@altis/shared';
import { afterAll, beforeAll, beforeEach, describe, expect, it, vi } from 'vitest';
import { engineLabel, testDb, testDbContext, type TestDbHandle } from '../../../../tools/test/test-db.js';
import { applyBackupRetention, isoWeekOf } from '../../src/backup/retention.js';
import { writeSettings } from '../../src/settings/service.js';

// Count-based backup retention (spec §9.9 "Jadwal dan retensi"; decision C30): 7 daily (scheduled) backups plus the
// newest scheduled backup of each of the 4 ISO weeks before them (library time); the newest pre_update until two
// updates were done after it; 10 manual, 3 pre_restore, 5 external. A removed backup loses its folder and keeps its
// row as `deleted` (history rows are never deleted).

/** While `failing` names a backup id, removing its folder fails (a scanner holding a file on Windows, EBUSY). */
const removal = vi.hoisted(() => ({ failing: null as string | null }));
vi.mock('@altis/platform', async (importOriginal) => {
  const actual = await importOriginal<typeof import('@altis/platform')>();
  return {
    ...actual,
    removeTree: async (p: Parameters<typeof actual.removeTree>[0]): Promise<void> => {
      if (removal.failing !== null && p.endsWith(removal.failing)) throw Object.assign(new Error('EBUSY: resource busy (test)'), { code: 'EBUSY' });
      await actual.removeTree(p);
    },
  };
});

const ctx = testDbContext();
const TZ = 'Asia/Jakarta';
const DAY = 86_400_000;
/** 01:00 in Jakarta (UTC+7) on the given UTC calendar day: 18:00 UTC the day before. */
const at = (y: number, m: number, d: number): number => Date.UTC(y, m - 1, d, 1, 0, 0) - 7 * 3_600_000;
const NOW = at(2026, 9, 15) + 3_600_000;

describe('isoWeekOf (library time)', () => {
  it('names the ISO week of the local calendar day', () => {
    expect(isoWeekOf(at(2026, 9, 14), TZ)).toBe('2026-W38'); // a Monday
    expect(isoWeekOf(at(2026, 9, 13), TZ)).toBe('2026-W37'); // the Sunday before
    // 2026-09-13 20:00 UTC is already Monday 03:00 in Jakarta.
    expect(isoWeekOf(Date.UTC(2026, 8, 13, 20, 0, 0), TZ)).toBe('2026-W38');
    expect(isoWeekOf(Date.UTC(2026, 8, 13, 20, 0, 0), 'UTC')).toBe('2026-W37');
    // ISO years: 2027-01-01 is a Friday of 2026-W53; 2024-12-30 a Monday of 2025-W01.
    expect(isoWeekOf(Date.UTC(2027, 0, 1, 12), 'UTC')).toBe('2026-W53');
    expect(isoWeekOf(Date.UTC(2024, 11, 30, 12), 'UTC')).toBe('2025-W01');
  });
});

describe.skipIf(!ctx.available)(`applyBackupRetention [${engineLabel()}]`, () => {
  let h: TestDbHandle;
  let root: string;
  let dataDir: string;

  beforeAll(async () => {
    h = await testDb();
    root = await fsp.realpath(await fsp.mkdtemp(path.join(os.tmpdir(), 'altis-backup-retention-')));
    await runMigrations(h, { appVersion: '0.1.0', dataDir: path.join(root, 'mig'), migrations: PHASE1_MIGRATIONS });
  });

  afterAll(async () => {
    await h?.close();
    if (root !== undefined) await fsp.rm(root, { recursive: true, force: true });
  });

  beforeEach(async () => {
    await h.db.deleteFrom('backups').execute();
    await h.db.deleteFrom('releases_log').execute();
    await h.db.deleteFrom('jobs').execute();
    await h.db.deleteFrom('settings').where('key', '=', 'system.clock_anomaly').execute();
    dataDir = await fsp.mkdtemp(path.join(root, 'data-'));
    removal.failing = null;
  });

  /** Raises `system.clock_anomaly` (as the scheduler's detector does), or clears it with `null`. */
  async function anomaly(value: { detectedAt: number; maxSeen: number } | null): Promise<void> {
    await withTx(h, (trx) => writeSettings(trx, { 'system.clock_anomaly': value }, { keyring: [], now: NOW, actorId: null }));
  }

  /** A backup row of `kind` made at `createdAt`, with a folder holding one file. */
  async function backup(kind: string, createdAt: number, status = 'ok'): Promise<string> {
    const id = newId(createdAt);
    await h.db
      .insertInto('backups')
      .values({
        id,
        kind,
        size: 10,
        sha256: null,
        schema_version: '0009_ops_jobs',
        app_version: '0.1.0',
        dialect: h.dialect,
        consistency: 'snapshot',
        status,
        created_at: createdAt,
      })
      .execute();
    await fsp.mkdir(path.join(dataDir, 'backups', id, 'tables'), { recursive: true });
    await fsp.writeFile(path.join(dataDir, 'backups', id, 'tables', 'x'), 'x');
    return id;
  }

  const statusOf = async (id: string) => (await h.db.selectFrom('backups').select('status').where('id', '=', id).executeTakeFirstOrThrow()).status;
  const folder = (id: string) =>
    fsp.stat(path.join(dataDir, 'backups', id)).then(
      () => true,
      () => false,
    );

  async function update(startedAt: number, status = 'done'): Promise<void> {
    await h.db
      .insertInto('releases_log')
      .values({ id: newId(startedAt), version: '0.2.0', action: 'update', from_version: '0.1.0', status, started_at: startedAt, finished_at: null, backup_id: null, detail: null })
      .execute();
  }

  it('12 scheduled backups over 40 days → the 7 newest and the newest of each of the 4 ISO weeks before them stay', async () => {
    // Five weekly ones (Wednesdays of 2026-W32..W36), then seven daily ones from Tuesday 8 to Monday 14 September.
    const weekly = [];
    for (const d of [5, 12, 19, 26]) weekly.push(await backup('scheduled', at(2026, 8, d)));
    weekly.push(await backup('scheduled', at(2026, 9, 2)));
    const daily = [];
    for (let d = 8; d <= 14; d += 1) daily.push(await backup('scheduled', at(2026, 9, d)));
    expect(at(2026, 9, 14) - at(2026, 8, 5)).toBe(40 * DAY);

    const deleted = await applyBackupRetention(h, dataDir, { now: NOW, tz: TZ });
    expect(deleted).toEqual([weekly[0]]);
    expect(await statusOf(weekly[0]!)).toBe('deleted');
    expect(await folder(weekly[0]!)).toBe(false);
    for (const id of [...weekly.slice(1), ...daily]) {
      expect(await statusOf(id)).toBe('ok');
      expect(await folder(id)).toBe(true);
    }
    // Idempotent.
    expect(await applyBackupRetention(h, dataDir, { now: NOW, tz: TZ })).toEqual([]);
  });

  it('two scheduled backups in one earlier week: only the newer of them is that week’s', async () => {
    const daily = [];
    for (let d = 8; d <= 14; d += 1) daily.push(await backup('scheduled', at(2026, 9, d)));
    const older = await backup('scheduled', at(2026, 9, 1)); // W36, Tuesday
    const newer = await backup('scheduled', at(2026, 9, 3)); // W36, Thursday
    // In the week of the oldest daily one (W37, Monday 7 September), but older than the seven: not a weekly one.
    const sameWeek = await backup('scheduled', at(2026, 9, 7));
    expect((await applyBackupRetention(h, dataDir, { now: NOW, tz: TZ })).sort()).toEqual([older, sameWeek].sort());
    expect(await statusOf(newer)).toBe('ok');
  });

  it('12 manual backups → the 2 oldest go (folders gone, rows deleted); failed and running rows are left alone', async () => {
    const manual = [];
    for (let i = 0; i < 12; i += 1) manual.push(await backup('manual', at(2026, 9, 1) + i * DAY));
    const failed = await backup('manual', at(2026, 8, 1), 'failed');
    const running = await backup('manual', at(2026, 8, 2), 'running');
    const deleted = await applyBackupRetention(h, dataDir, { now: NOW, tz: TZ });
    expect(deleted.sort()).toEqual(manual.slice(0, 2).sort());
    for (const id of manual.slice(0, 2)) {
      expect(await statusOf(id)).toBe('deleted');
      expect(await folder(id)).toBe(false);
    }
    for (const id of manual.slice(2)) expect(await statusOf(id)).toBe('ok');
    expect(await statusOf(failed)).toBe('failed');
    expect(await statusOf(running)).toBe('running');
    expect(await folder(running)).toBe(true);
    // History rows are never deleted.
    expect(Number((await h.db.selectFrom('backups').select((eb) => eb.fn.countAll<number>().as('n')).executeTakeFirstOrThrow()).n)).toBe(14);
  });

  it('a folder that cannot be removed is logged and left (housekeeping takes it later): the later ones still go', async () => {
    const manual = [];
    for (let i = 0; i < 12; i += 1) manual.push(await backup('manual', at(2026, 9, 1) + i * DAY));
    removal.failing = manual[0]!;
    const warnings: string[] = [];
    const log = { info() {}, warn: (message: string) => void warnings.push(message), error() {} };
    const deleted = await applyBackupRetention(h, dataDir, { now: NOW, tz: TZ, log });
    expect(deleted.sort()).toEqual(manual.slice(0, 2).sort());
    expect(await statusOf(manual[0]!)).toBe('deleted');
    expect(await folder(manual[0]!)).toBe(true);
    expect(await statusOf(manual[1]!)).toBe('deleted');
    expect(await folder(manual[1]!)).toBe(false);
    expect(warnings.filter((w) => w.includes('could not be removed'))).toHaveLength(1);
  });

  it('a backup whose prepared download may still be fetched stays: 1 h after it was ready, 5 min after it was fetched', async () => {
    const MIN = 60_000;
    const manual = [];
    for (let i = 0; i < 12; i += 1) manual.push(await backup('manual', at(2026, 9, 1) + i * DAY));
    const [oldest, second] = [manual[0]!, manual[1]!];
    const dir = path.join(dataDir, 'backups', oldest, 'downloads', newId());
    await fsp.mkdir(dir, { recursive: true });
    await fsp.writeFile(path.join(dir, 'archive.altisbak'), 'zip');
    const prepared = (readyAt: number, completedAt: number | null) =>
      fsp.writeFile(path.join(dir, 'prepared.json'), JSON.stringify({ jobId: newId(), readyAt, size: 3, encrypted: true, secrets: 'archive', completedAt }));
    // Ready 30 minutes ago, not fetched yet: the admin's download link still works.
    await prepared(NOW - 30 * MIN, null);
    expect(await applyBackupRetention(h, dataDir, { now: NOW, tz: TZ })).toEqual([second]);
    expect(await statusOf(oldest)).toBe('ok');
    expect(await folder(oldest)).toBe(true);
    // Fetched 4 minutes ago: a download manager may still ask for ranges.
    await prepared(NOW - 2 * 60 * MIN, NOW - 4 * MIN);
    expect(await applyBackupRetention(h, dataDir, { now: NOW, tz: TZ })).toEqual([]);
    // Fetched 6 minutes ago: its keep time is over, and so is the backup's.
    await prepared(NOW - 2 * 60 * MIN, NOW - 6 * MIN);
    expect(await applyBackupRetention(h, dataDir, { now: NOW, tz: TZ })).toEqual([oldest]);
    expect(await folder(oldest)).toBe(false);
  });

  it('a backup whose download is being prepared (a live backup.prepare_download job) stays until that job has ended', async () => {
    const manual = [];
    for (let i = 0; i < 12; i += 1) manual.push(await backup('manual', at(2026, 9, 1) + i * DAY));
    const [oldest, second] = [manual[0]!, manual[1]!];
    /** A prepare_download job of `backupId`: live (holding its unique key) or ended. */
    const job = async (backupId: string, status: 'queued' | 'running' | 'succeeded') => {
      const live = status !== 'succeeded';
      await h.db
        .insertInto('jobs')
        .values({
          id: newId(),
          type: 'backup.prepare_download',
          payload: '{}',
          status,
          run_at: NOW,
          max_attempts: 5,
          unique_key: live ? `backup.prepare_download:${backupId}:${newId()}` : null,
          created_at: NOW,
          updated_at: NOW,
          ...(live ? {} : { finished_at: NOW }),
        })
        .execute();
    };
    await job(oldest, 'running');
    await job(second, 'succeeded');
    expect(await applyBackupRetention(h, dataDir, { now: NOW, tz: TZ })).toEqual([second]);
    expect(await statusOf(oldest)).toBe('ok');
    expect(await folder(oldest)).toBe(true);
    // Once the preparation has ended (its unique key cleared), the next run removes it.
    await h.db.updateTable('jobs').set({ status: 'succeeded', unique_key: null, finished_at: NOW }).where('type', '=', 'backup.prepare_download').execute();
    expect(await applyBackupRetention(h, dataDir, { now: NOW, tz: TZ })).toEqual([oldest]);
    expect(await folder(oldest)).toBe(false);
  });

  it('pre_restore keeps 3, external 5 (uploaded included)', async () => {
    const pre = [];
    for (let i = 0; i < 4; i += 1) pre.push(await backup('pre_restore', at(2026, 9, 1) + i * DAY));
    const external = [];
    for (let i = 0; i < 6; i += 1) external.push(await backup('external', at(2026, 9, 1) + i * DAY, i % 2 === 0 ? 'uploaded' : 'ok'));
    expect((await applyBackupRetention(h, dataDir, { now: NOW, tz: TZ })).sort()).toEqual([pre[0], external[0]].sort());
  });

  it('the newest pre_update survives one later update and goes after the second; older pre_update backups go at once', async () => {
    const old = await backup('pre_update', at(2026, 8, 1));
    const newest = await backup('pre_update', at(2026, 9, 1));
    await update(at(2026, 8, 15)); // before the newest: does not count
    await update(at(2026, 9, 2), 'aborted'); // not done: does not count
    await update(at(2026, 9, 2));
    expect(await applyBackupRetention(h, dataDir, { now: NOW, tz: TZ })).toEqual([old]);
    expect(await statusOf(newest)).toBe('ok');
    await update(at(2026, 9, 10));
    expect(await applyBackupRetention(h, dataDir, { now: NOW, tz: TZ })).toEqual([newest]);
    expect(await folder(newest)).toBe(false);
  });

  it('while system.clock_anomaly is raised nothing is removed (spec §10.4); once it is cleared the retention runs again', async () => {
    const manual = [];
    for (let i = 0; i < 12; i += 1) manual.push(await backup('manual', at(2026, 9, 1) + i * DAY));
    const scheduled = [];
    for (let i = 0; i < 12; i += 1) scheduled.push(await backup('scheduled', at(2026, 8, 1) + i * 4 * DAY));
    await anomaly({ detectedAt: NOW, maxSeen: NOW + 365 * DAY });
    expect(await applyBackupRetention(h, dataDir, { now: NOW, tz: TZ })).toEqual([]);
    for (const id of [...manual, ...scheduled]) {
      expect(await statusOf(id)).toBe('ok');
      expect(await folder(id)).toBe(true);
    }
    await anomaly(null);
    expect(await applyBackupRetention(h, dataDir, { now: NOW, tz: TZ })).toContain(manual[0]);
  });

  it('never removes the backups it is told to keep: a backup that just finished, stamped oldest by a clock that went back', async () => {
    const manual = [];
    for (let i = 0; i < 10; i += 1) manual.push(await backup('manual', at(2026, 9, 1) + i * DAY));
    // Ten days before the oldest one: the eleventh by date, though it is the newest backup there is.
    const fresh = await backup('manual', at(2026, 8, 22));
    expect(await applyBackupRetention(h, dataDir, { now: at(2026, 8, 22), tz: TZ, keep: [fresh] })).toEqual([]);
    expect(await statusOf(fresh)).toBe('ok');
    expect(await folder(fresh)).toBe(true);
  });
});
