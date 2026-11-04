import { countRows, type DB, type DbHandle } from '@altis/db';
import { dataPath, statOrNull, type Runtime } from '@altis/platform';
import { isDomainError } from '@altis/shared';
import { sql, type Kysely, type Transaction } from 'kysely';
import { lastRuns, RUNNER_STALE_MS } from '../jobs/run-records.js';
import { JOB_LEASE_MS, type RunMode } from '../jobs/types.js';
import { backupTables } from './canonical.js';
import { readManifest, type BackupManifest } from './manifest.js';

// How a backup is made (spec §9.9 "Konsistensi"; decisions C31, C41; preflight S18):
//
//   snapshot  a worker or `jobs:run` (CLI cron) has run within the last 10 minutes: the `backup.create` job, whose
//             slices run back to back in that process (a snapshot transaction, or a copy of the SQLite file). Not on
//             passenger/litespeed when the estimate is over 10 minutes: their processes may be killed while idle,
//             and a snapshot that long would hold a transaction (and a connection) for the whole time;
//   frozen    otherwise (only the cron URL, drive or piggyback move work along): the `backup` op, under maintenance
//             with the job claims paused, one exporter step per op step, which any request-driven call resumes.
//
// The estimate (C31) comes from the previous `ok` backup's rate (rows per ms: its manifest's rows over the time from
// its `createdAt` to the manifest file's last write) when there is one, else 0.05 ms per row plus 20 MiB/s of files.
// A scheduled `frozen` backup estimated over 3 hours is skipped with a notification (§9.9).
//
// A running snapshot backup holds the named lock `backup:snapshot` (owner: its job), renewed with its heartbeats for
// a lease's time: a freezing op (a frozen backup, a restore) is refused meanwhile (OPS_BLOCKED_BY_BACKUP). Between the
// slices of a job driven by the cron URL it may lapse; the job is then only queued, and a frozen op that begins
// meanwhile pauses it (maintenance pauses claims) until the op ends.

/** The named lock a running snapshot backup holds (spec §9.4: a freezing op answers OPS_BLOCKED_BY_BACKUP meanwhile). */
export const BACKUP_SNAPSHOT_LOCK = 'backup:snapshot';

/** The lease of {@link BACKUP_SNAPSHOT_LOCK}: a job's lease, renewed with its heartbeats. */
export const BACKUP_SNAPSHOT_LOCK_MS = JOB_LEASE_MS;

/** On passenger/litespeed a snapshot backup must be estimated at no more than this (spec §9.9: "estimasi > 10 menit"). */
export const BACKUP_PASSENGER_SNAPSHOT_MAX_MS = 10 * 60_000;

/** A scheduled frozen backup estimated over this is skipped with a notification (spec §9.9: "> 3 jam"). */
export const BACKUP_FROZEN_SKIP_MS = 3 * 3_600_000;

/** Decision C31: the default rate of the table rows. */
const MS_PER_ROW = 0.05;
/** Decision C31: files are copied at 20 MiB/s. */
const FILE_BYTES_PER_MS = (20 * 1024 * 1024) / 1000;

/** The runner modes that can hold a snapshot (a process whose slices run back to back): the worker and `jobs:run`. */
const SNAPSHOT_RUNNERS: readonly RunMode[] = ['worker', 'cron_cli'];

function count(name: string, value: unknown): number {
  if (typeof value !== 'number' || !Number.isFinite(value) || value < 0) {
    throw new TypeError(`estimateBackupMs: ${name} must be a finite number of at least 0`);
  }
  return value;
}

/**
 * The time a backup of `rows` table rows and `fileBytes` of uploads is expected to take, in ms, rounded up (decision
 * C31): with the previous backup's `last` rate known (rows > 0, ms > 0), `rows × last.ms / last.rows`; otherwise
 * `rows × 0.05 ms + fileBytes / (20 MiB/s)`.
 *
 * @throws TypeError for a negative or non-finite input
 */
export function estimateBackupMs(o: { rows: number; fileBytes: number; last?: { rows: number; ms: number } }): number {
  const rows = count('rows', o.rows);
  const fileBytes = count('fileBytes', o.fileBytes);
  if (o.last !== undefined) {
    const lastRows = count('last.rows', o.last.rows);
    const lastMs = count('last.ms', o.last.ms);
    if (lastRows > 0 && lastMs > 0) return Math.ceil((rows * lastMs) / lastRows);
  }
  return Math.ceil(rows * MS_PER_ROW + fileBytes / FILE_BYTES_PER_MS);
}

/**
 * `snapshot` or `frozen` (spec §9.9 table): `snapshot` when a `worker` or `cron_cli` run is recorded within 10 minutes
 * of `now` (either way, as runnerFresh counts it), unless `runtime` is passenger/litespeed and `estimateMs` is over 10
 * minutes; `frozen` otherwise.
 */
export function chooseConsistency(o: {
  runtime: Runtime;
  runs: Partial<Record<RunMode, number>>;
  now: number;
  estimateMs: number;
}): 'snapshot' | 'frozen' {
  const fresh = SNAPSHOT_RUNNERS.some((mode) => {
    const at = o.runs[mode];
    return at !== undefined && Math.abs(o.now - at) <= RUNNER_STALE_MS;
  });
  if (!fresh) return 'frozen';
  const killable = o.runtime === 'passenger' || o.runtime === 'litespeed';
  return killable && o.estimateMs > BACKUP_PASSENGER_SNAPSHOT_MAX_MS ? 'frozen' : 'snapshot';
}

/**
 * Whether a snapshot backup runs: the lock {@link BACKUP_SNAPSHOT_LOCK} is held at `now` (its `until` not past). An
 * `until` more than two leases ahead was written by a clock that has since moved back (S18) and does not count.
 */
export async function snapshotBackupRunning(h: DbHandle, now: number): Promise<boolean> {
  const row = await h.db.selectFrom('locks').select('until').where('name', '=', BACKUP_SNAPSHOT_LOCK).executeTakeFirst();
  if (row === undefined) return false;
  const until = Number(row.until);
  return until >= now && until <= now + 2 * BACKUP_SNAPSHOT_LOCK_MS;
}

type Db = Kysely<DB> | Transaction<DB>;

/**
 * The rows of every table a backup holds (a count per table): the backup tables of the database's schema version
 * (schema_meta), so a registry table the database does not have yet is not read (the test builds' `test_fixture`,
 * decision D1d-26).
 */
async function backupRows(db: Db): Promise<number> {
  const meta = await db.selectFrom('schema_meta').select('schema_version').where('id', '=', 1).executeTakeFirst();
  const version = meta?.schema_version;
  const tables = backupTables(typeof version === 'string' && /^\d{4}$/.test(version) ? version : undefined);
  let rows = 0;
  for (const { table } of tables) rows += await countRows(db.selectFrom(table).select(sql<number>`1`.as('one')));
  return rows;
}

/** The bytes of the uploads a backup with files copies (`files` rows with status `ok`). */
async function uploadBytes(db: Db): Promise<number> {
  const row = await db
    .selectFrom('files')
    .select((eb) => eb.fn.sum<number | string | null>('size').as('total'))
    .where('status', '=', 'ok')
    .executeTakeFirst();
  const total = Number(row?.total ?? 0);
  return Number.isFinite(total) && total > 0 ? total : 0;
}

/** The manifest of `id`, or null when it has none or it cannot be read. */
async function manifestOrNull(dataDir: string, id: string): Promise<BackupManifest | null> {
  try {
    return await readManifest(dataDir, id);
  } catch (error) {
    if (isDomainError(error)) return null;
    throw error;
  }
}

/**
 * The rate of the newest `ok` backup that has a readable manifest: its rows, and the ms from its `createdAt` to the
 * last write of its `manifest.json` (the end of the export). Undefined without one.
 */
export async function lastBackupRate(db: Db, dataDir: string): Promise<{ rows: number; ms: number } | undefined> {
  const rows = await db
    .selectFrom('backups')
    .select('id')
    .where('status', '=', 'ok')
    .orderBy('created_at', 'desc')
    .orderBy('id', 'desc')
    .limit(3)
    .execute();
  for (const { id } of rows) {
    const manifest = await manifestOrNull(dataDir, id);
    if (manifest === null) continue;
    const info = await statOrNull(dataPath(dataDir, 'backups', id, 'manifest.json'));
    if (info === null) continue;
    let total = 0;
    for (const t of Object.values(manifest.tables)) total += t.rows;
    return { rows: total, ms: Math.max(0, Math.round(info.mtimeMs - manifest.createdAt)) };
  }
  return undefined;
}

/** The estimate (C31) of a backup of the database `db` now, with the uploads when `includeFiles`. */
export async function backupEstimateMs(db: Db, dataDir: string, o: { includeFiles: boolean }): Promise<number> {
  const rows = await backupRows(db);
  const fileBytes = o.includeFiles ? await uploadBytes(db) : 0;
  const last = await lastBackupRate(db, dataDir);
  return estimateBackupMs({ rows, fileBytes, ...(last === undefined ? {} : { last }) });
}

/**
 * The mode of a backup begun now on this installation (see the top of this file): the run records (`system.run.*`),
 * the runtime and the estimate.
 */
export async function decideBackupMode(
  db: Db,
  dataDir: string,
  o: { runtime: Runtime; now: number; includeFiles: boolean },
): Promise<{ consistency: 'snapshot' | 'frozen'; estimateMs: number }> {
  const estimateMs = await backupEstimateMs(db, dataDir, { includeFiles: o.includeFiles });
  const runs = await lastRuns(db);
  return { consistency: chooseConsistency({ runtime: o.runtime, runs, now: o.now, estimateMs }), estimateMs };
}
