import { createHash } from 'node:crypto';
import {
  AUDIT_GENESIS_HASH,
  claimLock,
  connectSqliteFile,
  readSnapshot,
  releaseLock,
  releaseMigrations,
  sqliteSnapshotTo,
  withTx,
  type DB,
  type DbHandle,
  type Dialect,
} from '@altis/db';
import {
  backupPartPath,
  dataPath,
  ensureHeadroom,
  readBytes,
  removeTree,
  statOrNull,
  type DataPath,
  type Runtime,
} from '@altis/platform';
import { DomainError, ERROR_CODES, isDomainError, isUlid, newId, type ErrorCode } from '@altis/shared';
import type { Kysely, Transaction } from 'kysely';
import { z } from 'zod';
import { errorFields, type CoreLogger } from '../context.js';
import { publish } from '../events/publish.js';
import { isDiskQuota, notifyDiskLow } from '../files/disk-quota.js';
import type { JobContext, JobHandler, JobOutcome } from '../jobs/types.js';
import { notify } from '../notifications/service.js';
import { readOpFile } from '../ops/files.js';
import type { OpsMachine } from '../ops/machine.js';
import { readClockAnomaly } from '../scheduler/clock.js';
import { readSettings } from '../settings/service.js';
import { backupPathTablesOf } from './canonical.js';
import { createExporter, exportCheckpointSchema, type ExportCheckpoint } from './exporter.js';
import { readManifest, type BackupKind } from './manifest.js';
import { BACKUP_SNAPSHOT_LOCK, BACKUP_SNAPSHOT_LOCK_MS } from './mode.js';
import { applyBackupRetention } from './retention.js';

// The snapshot backup job `backup.create` (spec §9.9 "snapshot"; decisions C12, C38; preflight B5, S8, S18, S24; P7,
// P9, P17, P21), and what it shares with the frozen backup op (frozen-op.ts): the row, the headroom, the end and the
// failure of a backup.
//
// Every slice stays within its budget and hands the export checkpoint (Task 11's ExportCheckpoint: fixed-size, the
// parts are in the part log, ruling R1c-6) to the next one in `continueWith`:
//
// - first slice: `ensureHeadroom(DATA_DIR, max(1.5 × the newest ok backup's size, 64 MiB))` (S8), the named lock
//   `backup:snapshot` (owner `job:<jobId>`, a lease's time, renewed at every slice and heartbeat; `farFutureIsExpired`
//   while clock_anomaly is raised, S18), the `backups` row (`running`, `snapshot`). Its id is the job's own id when
//   that is free, so a first slice run again after a crash finds its row instead of adding a second one. While another
//   owner holds the lock (another snapshot backup, the files cleanup), any slice waits {@link SNAPSHOT_WAIT_MS} instead
//   (the outcome `waitUntil`, 1d T20-SNAPSHOT-HOLD-COUNTS-ATTEMPT): the queue runs it again then without counting an
//   attempt, so a busy lock never uses up the job's two attempts;
// - SQLite (C12, M40): one slice copies the live database (the handle the server writes through, M31) with
//   sqliteSnapshotTo into `backups/<id>/.work/snapshot.sqlite`; the later slices export from a read-only handle on that
//   copy and resume from the checkpoint in any process, so `/_cron` calls alone finish it, one slice per call;
// - MySQL/MariaDB/PostgreSQL (P17): the job session (`ctx.session`) holds a dedicated pool-1 connection with one open
//   readSnapshot transaction; the consecutive slices of one worker or `jobs:run` process reuse it. A slice whose session
//   is fresh while parts were already written (another process ran the job, or this one crashed) removes those parts
//   and starts the export again: a dead snapshot cannot be continued (C12). A slice run by `cron_http` or `drive` turns
//   the job into a frozen backup (the `backup` op, same kind and files; the job's row `failed`, its folder removed, the
//   job done with `progress_message` "converted to frozen"): its transaction could not outlive the request;
// - every slice publishes `backup.progress {backupId, progress}` on `system.backup` (S24);
// - done: the manifest (written by the exporter), the row `ok` with `size` (bytes of its files on disk) and `sha256`
//   (of `manifest.json`), `backup.done` on `system.backup`, `notification.backup_done`, then the retention (never of the
//   backup itself, and none while the clock anomaly is raised). The last two are best effort: once the row is `ok` nothing ends the backup as failed (abandonBackup leaves it alone, and a
//   slice failing after it ends the job done);
// - `DISK_QUOTA` (P21): the backup's folder removed, the row `failed`, `notification.disk_low` and
//   `notification.backup_failed`, and `DISK_QUOTA` thrown (`last_error` is the bare code). Any other failure ends the
//   backup the same way (without disk_low), except the ones the next attempt can resume from (a lost connection, a
//   conflict, an op held by another): those end it only on the job's last attempt. The automatic
//   retry of a job whose backup was ended throws its `last_error` again instead of starting over, so the job ends
//   `dead` after its two attempts (a continued slice resets the attempts: starting over would retry a full disk
//   forever), unless that error is one of the resumable ones (a conversion to frozen whose ops.begin was refused
//   failed the row first): that retry starts a new backup, as a retry asked for through the API does. A lost lease leaves everything to the process
//   that has the job now. A cancel request ends the backup too (the queue then ends the job `cancelled`).

export const BACKUP_CREATE_JOB = 'backup.create';
/** Where the backup notifications lead (the Backup screen). */
export const BACKUPS_LINK = '/admin/backups';
/** The channel of the backup hints (S24, M43). */
export const BACKUP_CHANNEL = 'system.backup';
/** The `progress_message` of a snapshot job turned into a frozen backup. */
export const CONVERTED_TO_FROZEN = 'converted to frozen';

const MIB = 1024 * 1024;
/** The least headroom a backup proves (spec §9.9 "ensureHeadroom(1,5 × backup terakhir)", never below 64 MiB). */
const HEADROOM_MIN_BYTES = 64 * MIB;
const HEADROOM_FACTOR = 1.5;
/** A slice's export step ends this long before its budget: the result, the hint and the heartbeat follow. */
const SLICE_MARGIN_MS = 1000;
/** How long a slice that found `backup:snapshot` held by another owner waits before the job runs again. */
export const SNAPSHOT_WAIT_MS = 60_000;

/** The job's payload (its checkpoint between slices). */
export type BackupCreatePayload = {
  /** The backup (row and folder); null until the first slice made it. */
  backupId: string | null;
  kind: 'manual' | 'scheduled';
  includeFiles: boolean;
  /** Where the export stands (Task 11); null before its first step. */
  checkpoint: ExportCheckpoint | null;
  /** SQLite: the copy is made; other dialects: a snapshot transaction was opened (in some process's session). */
  snapshot: 'sqlite-copy' | 'transaction' | null;
};

export const backupCreatePayload = z.strictObject({
  backupId: z.string().refine(isUlid, 'not a ULID').nullable(),
  kind: z.enum(['manual', 'scheduled']),
  includeFiles: z.boolean(),
  checkpoint: exportCheckpointSchema.nullable(),
  snapshot: z.enum(['sqlite-copy', 'transaction']).nullable(),
}) satisfies z.ZodType<BackupCreatePayload>;

/** What a backup (the job, the op) needs from the installation. */
export interface BackupDeps {
  dataDir: string;
  /** config.json's `install.id`: the manifest's `installId`. */
  installId: string;
  /** The running release. */
  appVersion: string;
  /** config.json's session key (32 bytes): the manifest HMAC's key material (decision C13). */
  sessionKey: Uint8Array;
  /** The keyring's key ids (the manifest's `kids`). */
  kids: readonly string[];
}

/** What the backup jobs need besides {@link BackupDeps}. */
export interface BackupJobDeps extends BackupDeps {
  /** How this process runs (chooseConsistency). */
  runtime: Runtime;
  /** A dedicated pool-1 connection outside the pool (P17), for a snapshot transaction; closed by the job session. */
  connectSnapshot(): Promise<DbHandle>;
  /** The installation's ops machine: a frozen backup is its `backup` op. */
  ops: OpsMachine;
}

type Db = Kysely<DB> | Transaction<DB>;

// ---------------------------------------------------------------------------------------------------------------
// What the job and the op share

/** `backups/<id>/.work/snapshot.sqlite`: the SQLite copy a snapshot backup exports from. */
export function snapshotCopyPath(dataDir: string, backupId: string): DataPath {
  return dataPath(dataDir, 'backups', backupId, '.work', 'snapshot.sqlite');
}

/** The headroom to prove before a backup (spec §9.9, S8): 1.5 × the newest `ok` backup's size, at least 64 MiB. */
export async function backupHeadroomBytes(db: Db): Promise<number> {
  const row = await db
    .selectFrom('backups')
    .select('size')
    .where('status', '=', 'ok')
    .orderBy('created_at', 'desc')
    .orderBy('id', 'desc')
    .limit(1)
    .executeTakeFirst();
  const last = Number(row?.size ?? 0);
  return Math.max(Number.isFinite(last) ? Math.ceil(last * HEADROOM_FACTOR) : 0, HEADROOM_MIN_BYTES);
}

/**
 * The manifest's `schemaVersion`: the name of the migration whose tables and columns the export holds.
 *
 * - a registry export (default): this code's newest migration whose number is at most the one `schema_meta` records
 *   (`0009` → `0009_ops_jobs`). On a database a later release migrated further (spec §6.4 "schema-ahead", after a
 *   pointer-only rollback or the compatible revert of §9.7, "skema dibiarkan") the registry exporter writes this code's
 *   tables and columns only, so `0010` names `0009_ops_jobs` too: a name this release and every later one resolve
 *   (migrationsUpTo), never a bare number none can (phase-end review C12);
 * - `{ columns: 'catalog' }` (the generic exporter of a `schemaHold` pre_update, §9.8 row 3, which writes the
 *   database's own tables and columns): the database's own last migration, its name when this build knows it.
 */
export async function schemaVersionOf(db: Db, o: { columns?: 'registry' | 'catalog' } = {}): Promise<string> {
  const row = await db.selectFrom('schema_meta').select('schema_version').where('id', '=', 1).executeTakeFirst();
  const version = row?.schema_version;
  if (typeof version !== 'string' || !/^\d{4}$/.test(version)) {
    throw new DomainError('STATE_CORRUPT', {
      detail: 'schema_meta tidak mencatat versi skema / schema_meta records no schema version',
      meta: { reason: 'schema_meta' },
    });
  }
  // Every migration name this build can know: a test build names the fixture migrations of every level (decision
  // D1d-26: 9001 → 9001_test_expand, whatever level it runs at); a production build only PHASE1_MIGRATIONS. Names
  // begin with four distinct digits (`NNNN_slug`), so name order is number order.
  const names = Object.keys(releaseMigrations(3)).sort();
  if (o.columns === 'catalog') return names.find((name) => name.startsWith(`${version}_`)) ?? version;
  return names.filter((name) => name.slice(0, 4) <= version).at(-1) ?? version;
}

/** The audit chain head the manifest records (`audit_head`; the genesis before any entry). */
export async function auditHeadOf(db: Db): Promise<{ seq: number; hash: string }> {
  const row = await db.selectFrom('audit_head').select(['last_seq', 'last_hash']).where('id', '=', 1).executeTakeFirst();
  return row === undefined ? { seq: 0, hash: AUDIT_GENESIS_HASH } : { seq: Number(row.last_seq), hash: row.last_hash };
}

/** Inserts the `running` row of backup `id` unless it exists. */
export async function insertBackupRow(
  h: DbHandle,
  r: { id: string; kind: BackupKind; consistency: 'snapshot' | 'frozen'; dialect: Dialect; schemaVersion: string; appVersion: string; now: number },
): Promise<void> {
  await withTx(h, async (trx) => {
    const found = await trx.selectFrom('backups').select('id').where('id', '=', r.id).executeTakeFirst();
    if (found !== undefined) return;
    await trx
      .insertInto('backups')
      .values({
        id: r.id,
        kind: r.kind,
        size: null,
        sha256: null,
        schema_version: r.schemaVersion,
        app_version: r.appVersion,
        dialect: r.dialect,
        consistency: r.consistency,
        status: 'running',
        created_at: r.now,
      })
      .execute();
  });
}

/** Publishes `backup.progress {backupId, progress}` on `system.backup` (S24), in a transaction of its own. */
export async function publishBackupProgress(h: DbHandle, backupId: string, progress: number): Promise<void> {
  await withTx(h, (trx) => publish(trx, { channel: BACKUP_CHANNEL, type: 'backup.progress', payload: { backupId, progress } }));
}

/** `library.timezone` (the ISO weeks of the retention). */
async function libraryTimeZone(db: Db): Promise<string> {
  return (await readSettings(db, ['library.timezone'], []))['library.timezone'] as string;
}

/** The bytes the finished backup `id` holds on disk: `manifest.json` and every part file it lists. */
async function backupSize(dataDir: string, id: string, manifestBytes: number): Promise<number> {
  const manifest = await readManifest(dataDir, id);
  if (manifest === null) throw new DomainError('BACKUP_INVALID', { meta: { reason: 'format' } });
  const tables = backupPathTablesOf(manifest);
  let size = manifestBytes;
  for (const [table, t] of Object.entries(manifest.tables)) {
    for (const part of t.parts) {
      const info = await statOrNull(backupPartPath(dataDir, id, table, part.n, tables));
      size += info?.size ?? 0;
    }
  }
  return size;
}

/** Runs `fn` and logs (never throws) its failure: the steps after a backup turned `ok`. */
async function bestEffort(log: CoreLogger, backupId: string, what: string, fn: () => Promise<unknown>): Promise<void> {
  try {
    await fn();
  } catch (error) {
    log.warn(`backup: ${what} failed after the backup finished; the backup stays`, { backupId, ...errorFields(error) });
  }
}

/**
 * The end of backup `backupId`, whose manifest is written: its work files removed, the row `ok` with `size` and
 * `sha256` (of `manifest.json`) and `backup.done` on `system.backup` in one transaction, `notification.backup_done`
 * to the holders of `system.backup.read`, then the retention (which keeps this backup whatever its `created_at` says,
 * and removes nothing while the clock anomaly is raised). Idempotent: a row already `ok` gets no second event or
 * notification.
 *
 * Once the row is `ok` the backup is finished: the notification and the retention after it are best effort (a failure
 * is logged, never thrown), so a later failure (an old folder the retention cannot remove, a notification that cannot
 * be written) can never end the finished backup as failed.
 */
export async function finishBackup(h: DbHandle, dataDir: string, o: { backupId: string; now: number; log: CoreLogger }): Promise<void> {
  const id = o.backupId;
  await removeTree(dataPath(dataDir, 'backups', id, '.work'));
  const bytes = await readBytes(dataPath(dataDir, 'backups', id, 'manifest.json'), 64 * MIB);
  if (bytes === null) throw new DomainError('BACKUP_INVALID', { meta: { reason: 'format' } });
  const size = await backupSize(dataDir, id, bytes.byteLength);
  const sha256 = createHash('sha256').update(bytes).digest('hex');
  const finished = await withTx(h, async (trx) => {
    const r = await trx.updateTable('backups').set({ status: 'ok', size, sha256 }).where('id', '=', id).where('status', '=', 'running').executeTakeFirst();
    if (Number(r.numUpdatedRows) !== 1) return false;
    await publish(trx, { channel: BACKUP_CHANNEL, type: 'backup.done', payload: { backupId: id } });
    return true;
  });
  if (finished) {
    await bestEffort(o.log, id, 'the backup_done notification', () =>
      withTx(h, (trx) =>
        notify(
          trx,
          {
            audience: { permission: 'system.backup.read' },
            type: 'backup.done',
            titleKey: 'notification.backup_done.title',
            params: { name: id },
            link: BACKUPS_LINK,
          },
          o.now,
        ),
      ),
    );
  }
  await bestEffort(o.log, id, 'the retention', async () => {
    const deleted = await applyBackupRetention(h, dataDir, { now: o.now, tz: await libraryTimeZone(h.db), log: o.log, keep: [id] });
    if (deleted.length > 0) o.log.info('backup: retention removed backups', { backupId: id, removed: deleted.length });
  });
}

/** Whether backup `id` is finished (its row `ok`): nothing may end it as failed any more. */
export async function backupFinished(db: Db, id: string): Promise<boolean> {
  const row = await db.selectFrom('backups').select('status').where('id', '=', id).executeTakeFirst();
  return row?.status === 'ok';
}

/**
 * The failed end of a backup (P21): its row `failed` (when it is still `running`) and then its folder removed, then,
 * with `notify`, `notification.disk_low` (a full disk or quota, to the holders of `system.diagnostics.read`) and
 * `notification.backup_failed` (to the holders of `system.backup.read`). Each part is tried on its own: a failure is
 * logged, never thrown, so the caller's own error comes out.
 *
 * A finished backup is never touched: when the row is (or became meanwhile) anything but `failed` (`ok`, `uploaded`,
 * `deleted`), or its status cannot be read, neither its folder nor a notification is touched (a row still `running`
 * because the database was gone is left to the files cleanup, which reconciles such rows).
 *
 * @returns true when the backup is ended as failed (or there was none), false when it was left alone
 */
export async function abandonBackup(
  h: DbHandle,
  dataDir: string,
  o: { backupId: string | null; error: unknown; now: number; log: CoreLogger; notify: boolean },
): Promise<boolean> {
  const id = o.backupId;
  const attempt = async (what: string, fn: () => Promise<unknown>): Promise<boolean> => {
    try {
      await fn();
      return true;
    } catch (error) {
      o.log.warn(`backup: ${what} failed`, { backupId: id, ...errorFields(error) });
      return false;
    }
  };
  if (id !== null) {
    let status: string | null;
    try {
      await h.db.updateTable('backups').set({ status: 'failed' }).where('id', '=', id).where('status', '=', 'running').execute();
      status = (await h.db.selectFrom('backups').select('status').where('id', '=', id).executeTakeFirst())?.status ?? null;
    } catch (error) {
      o.log.warn('backup: marking a backup failed failed', { backupId: id, ...errorFields(error) });
      return false;
    }
    if (status !== null && status !== 'failed') {
      o.log.warn('backup: a failure after the backup ended leaves it as it is', { backupId: id, status, ...errorFields(o.error) });
      return false;
    }
    await attempt('removing the folder of a failed backup', () => removeTree(dataPath(dataDir, 'backups', id)));
  }
  if (!o.notify) return true;
  if (isDiskQuota(o.error)) await notifyDiskLow(h, o.now, o.log);
  await attempt('the backup_failed notification', () =>
    withTx(h, (trx) =>
      notify(
        trx,
        {
          audience: { permission: 'system.backup.read' },
          type: 'backup.failed',
          titleKey: 'notification.backup_failed.title',
          params: { name: id ?? '-' },
          link: BACKUPS_LINK,
        },
        o.now,
      ),
    ),
  );
  return true;
}

/** Whether the current op (ended or not) is a `backup` op begun with `params[key] = value` (a begin already done). */
export async function backupOpBegunBy(dataDir: string, key: string, value: string): Promise<boolean> {
  const op = await readOpFile(dataDir);
  return op !== null && op !== 'corrupt' && op.kind === 'backup' && op.params[key] === value;
}

// ---------------------------------------------------------------------------------------------------------------
// The snapshot job

/** A snapshot transaction on a dedicated connection, held open until `close()` (P17). */
interface SnapshotSession {
  db: Kysely<DB>;
  close(): Promise<void>;
}

/**
 * Opens a dedicated connection with `connect()` and one readSnapshot transaction on it, which stays open (the callback
 * waits) until `close()`, which ends it (COMMIT of a read-only transaction) and closes the connection.
 */
/** A promise with its settle functions (Promise.withResolvers is ES2024). */
function deferred<T>(): { promise: Promise<T>; resolve: (value: T) => void; reject: (error: unknown) => void } {
  const out = {} as { promise: Promise<T>; resolve: (value: T) => void; reject: (error: unknown) => void };
  out.promise = new Promise<T>((resolve, reject) => {
    out.resolve = resolve;
    out.reject = reject;
  });
  return out;
}

async function openSnapshotSession(connect: () => Promise<DbHandle>): Promise<SnapshotSession> {
  const h = await connect();
  const held = deferred<void>();
  const ready = deferred<Kysely<DB>>();
  // The snapshot's end: an error after the export (a connection that died meanwhile) is of no use any more.
  const ended = readSnapshot(h, async (db) => {
    ready.resolve(db);
    await held.promise;
  }).then(
    () => undefined,
    (error: unknown) => ready.reject(error),
  );
  let db: Kysely<DB>;
  try {
    db = await ready.promise;
  } catch (error) {
    await h.close().catch(() => undefined);
    throw error;
  }
  let closing: Promise<void> | null = null;
  return {
    db,
    close() {
      closing ??= (async () => {
        held.resolve();
        await ended;
        await h.close();
      })();
      return closing;
    },
  };
}

/** The outcome of a slice that found `backup:snapshot` held by another owner: the job runs again later. */
function waitForSnapshot(ctx: JobContext): JobOutcome<BackupCreatePayload> {
  return { waitUntil: ctx.now() + SNAPSHOT_WAIT_MS };
}

/**
 * Errors after which the backup can go on (the next attempt resumes it), or that are not this slice's to handle: a
 * lost lease (another process has the job), a lost connection or a conflict, a snapshot backup or another op where a
 * conversion wants to begin one (ops.begin's OPS_BLOCKED_BY_BACKUP, OPS_IN_PROGRESS). The lock `backup:snapshot` held
 * by another owner is no error at all: the slice waits (waitForSnapshot).
 */
const RESUMABLE: ReadonlySet<string> = new Set(['JOB_LEASE_LOST', 'DB_UNAVAILABLE', 'TX_CONFLICT', 'OPS_BLOCKED_BY_BACKUP', 'OPS_IN_PROGRESS']);

function resumable(error: unknown): boolean {
  return isDomainError(error) && RESUMABLE.has(error.code);
}

/**
 * The job `backup.create` (see the top of this file): `longRunning` (a process-local session between its slices),
 * retryable through the API, two attempts. `deps` is read at every slice (the config of the moment).
 */
export function backupCreateJob(deps: () => BackupJobDeps): JobHandler<BackupCreatePayload> {
  return {
    type: BACKUP_CREATE_JOB,
    permission: 'system.backup.create',
    retryable: 'api',
    longRunning: true,
    maxAttempts: 2,
    payload: backupCreatePayload,
    run: (ctx, payload) => backupSlice(deps(), ctx, payload),
  };
}

/** The failure an earlier attempt of the job ended its backup with, thrown again as it was (`last_error` unchanged). */
class RepeatedFailure extends Error {
  constructor(readonly error: Error) {
    super('backup: the failure of an earlier attempt');
  }
}

/** An error whose `last_error` text (slice.ts errorText) is `lastError`: a bare code, `code: detail`, or a name. */
function failureFrom(lastError: string): Error {
  const match = /^([A-Z][A-Z0-9_]*)(?:: ([\s\S]*))?$/.exec(lastError);
  if (match !== null && Object.hasOwn(ERROR_CODES, match[1]!)) {
    const code = match[1] as ErrorCode;
    return match[2] === undefined ? new DomainError(code) : new DomainError(code, { detail: match[2] });
  }
  const error = new Error('backup: an earlier attempt failed');
  error.name = lastError;
  return error;
}

async function backupSlice(d: BackupJobDeps, ctx: JobContext, given: BackupCreatePayload): Promise<JobOutcome<BackupCreatePayload>> {
  const h = ctx.handle;
  const owner = `job:${ctx.jobId}`;
  let p = given;
  const release = async (): Promise<void> => {
    try {
      await releaseLock(h, BACKUP_SNAPSHOT_LOCK, owner);
    } catch (error) {
      ctx.log.warn('backup: releasing backup:snapshot failed', { jobId: ctx.jobId, ...errorFields(error) });
    }
  };
  /** Claims (or renews) `backup:snapshot` for this job; false while another owner holds it. */
  const hold = async (): Promise<boolean> => {
    const anomaly = (await readClockAnomaly(h.db)) !== null;
    return claimLock(h, BACKUP_SNAPSHOT_LOCK, owner, BACKUP_SNAPSHOT_LOCK_MS, { farFutureIsExpired: anomaly });
  };
  const job = () => h.db.selectFrom('jobs').select(['attempts', 'max_attempts', 'last_error']).where('id', '=', ctx.jobId).executeTakeFirst();

  try {
    // The job's backup: the one of its checkpoint, else the one its first slice makes under the job's own id.
    const current = p.backupId ?? ctx.jobId;
    const row = await h.db.selectFrom('backups').select('status').where('id', '=', current).executeTakeFirst();
    if (row?.status === 'ok') {
      // Finished by a slice whose own result was lost (P7).
      await release();
      return { done: true };
    }
    if (row !== undefined && row.status !== 'running') {
      // An earlier attempt of this job ended its backup (P21: a full disk, ...). An automatic retry ends the same way,
      // so the job dies after its attempts instead of filling the disk again; a retry asked for through the API
      // (attempts back at 0) starts a new backup.
      const j = await job();
      if (j !== undefined && Number(j.attempts) > 0 && j.last_error !== null) {
        const earlier = failureFrom(j.last_error);
        // An error the next attempt may resume from never ended the backup itself: the row was failed by a conversion
        // whose ops.begin was refused (OPS_IN_PROGRESS), and this attempt starts over.
        if (!resumable(earlier)) throw new RepeatedFailure(earlier);
      }
      p = { ...p, backupId: null, checkpoint: null, snapshot: null };
    }
    if (ctx.cancelled()) {
      await abandonBackup(h, d.dataDir, { backupId: p.backupId, error: null, now: ctx.now(), log: ctx.log, notify: false });
      await release();
      return { continueWith: p, progress: 0 }; // a cancel request pending: the queue ends the job cancelled
    }
    if (h.dialect !== 'sqlite' && (ctx.mode === 'cron_http' || ctx.mode === 'drive')) return await convertToFrozen(d, ctx, p, release);

    if (!(await hold())) return waitForSnapshot(ctx);
    if (p.backupId === null) p = await beginBackup(d, ctx, p);
    return h.dialect === 'sqlite' ? await sqliteSlice(d, ctx, p, hold, release) : await serverSlice(d, ctx, p, hold, release);
  } catch (error) {
    if (error instanceof RepeatedFailure) throw error.error;
    if (isDomainError(error) && error.code === 'JOB_LEASE_LOST') throw error; // the job is another process's now
    if (resumable(error)) {
      // The next attempt resumes the backup; after the last one nothing would, so it ends here.
      const j = await job().catch(() => undefined);
      if (j === undefined || Number(j.attempts) + 1 < Number(j.max_attempts)) throw error;
    }
    if (p.backupId !== null && (await backupFinished(h.db, p.backupId).catch(() => false))) {
      // The backup ended `ok` before the failure (finishBackup's commit whose answer was lost): it is done.
      ctx.log.warn('backup: a failure after the backup finished; the backup stays', { jobId: ctx.jobId, backupId: p.backupId, ...errorFields(error) });
      await release();
      return { done: true };
    }
    const quota = isDiskQuota(error);
    ctx.log.error('backup: the snapshot backup failed', { jobId: ctx.jobId, backupId: p.backupId, ...errorFields(error) });
    const backupId = p.backupId ?? (await ownRow(h, ctx.jobId).catch(() => null));
    await abandonBackup(h, d.dataDir, { backupId, error, now: ctx.now(), log: ctx.log, notify: true });
    await release();
    // `last_error` = the bare code (no path in it): the next attempt ends the same way, and the job is dead.
    if (quota) throw new DomainError('DISK_QUOTA', { cause: error });
    throw error;
  }
}

/** The job's own backup row (its first slice's), when it is still running: the backup a failed first slice leaves. */
async function ownRow(h: DbHandle, jobId: string): Promise<string | null> {
  const row = await h.db.selectFrom('backups').select('status').where('id', '=', jobId).executeTakeFirst();
  return row?.status === 'running' ? jobId : null;
}

/** The first slice's work: the headroom (S8) and the `running` row (its id: the job's when free). */
async function beginBackup(d: BackupJobDeps, ctx: JobContext, p: BackupCreatePayload): Promise<BackupCreatePayload> {
  const h = ctx.handle;
  await ensureHeadroom(d.dataDir, await backupHeadroomBytes(h.db));
  const own = await h.db.selectFrom('backups').select('status').where('id', '=', ctx.jobId).executeTakeFirst();
  const backupId = own === undefined || own.status === 'running' ? ctx.jobId : newId(ctx.now());
  await insertBackupRow(h, {
    id: backupId,
    kind: p.kind,
    consistency: 'snapshot',
    dialect: h.dialect,
    schemaVersion: await schemaVersionOf(h.db),
    appVersion: d.appVersion,
    now: ctx.now(),
  });
  // Whatever an earlier run of this first slice left in the folder goes (a copy, parts).
  await removeTree(dataPath(d.dataDir, 'backups', backupId));
  return { ...p, backupId, checkpoint: null, snapshot: null };
}

/** The exporter of backup `p.backupId` reading `read` (a snapshot). */
async function exporterOf(d: BackupJobDeps, ctx: JobContext, p: BackupCreatePayload & { backupId: string }, read: Kysely<DB>, dialect: Dialect) {
  return createExporter({
    read,
    dialect,
    dataDir: d.dataDir,
    backupId: p.backupId,
    kind: p.kind,
    includeFiles: p.includeFiles,
    consistency: 'snapshot',
    appVersion: d.appVersion,
    schemaVersion: await schemaVersionOf(read),
    installId: d.installId,
    sessionKey: d.sessionKey,
    kids: [...d.kids],
    auditHead: await auditHeadOf(read),
    clock: () => ctx.now(),
  });
}

/** The deadline of a slice's export step. */
function stepDeadline(ctx: JobContext): number {
  return ctx.now() + Math.max(0, ctx.budgetLeftMs() - SLICE_MARGIN_MS);
}

/**
 * After an export step that did not finish: the hint (S24), the heartbeat and the lock renewed. A lock another owner
 * took meanwhile (it lapsed) makes the job wait, its stored checkpoint unchanged.
 */
async function continued(
  ctx: JobContext,
  p: BackupCreatePayload & { backupId: string },
  r: { checkpoint: ExportCheckpoint; progress: number },
  hold: () => Promise<boolean>,
): Promise<JobOutcome<BackupCreatePayload>> {
  await publishBackupProgress(ctx.handle, p.backupId, r.progress);
  await ctx.heartbeat({ progress: r.progress });
  if (!(await hold())) return waitForSnapshot(ctx);
  return { continueWith: { ...p, checkpoint: r.checkpoint }, progress: r.progress };
}

async function sqliteSlice(
  d: BackupJobDeps,
  ctx: JobContext,
  p: BackupCreatePayload,
  hold: () => Promise<boolean>,
  release: () => Promise<void>,
): Promise<JobOutcome<BackupCreatePayload>> {
  const backupId = p.backupId as string;
  const copy = snapshotCopyPath(d.dataDir, backupId);
  if (p.snapshot !== 'sqlite-copy' || (await statOrNull(copy)) === null) {
    // One slice copies the database (C12): through the handle the server writes with (M31). A copy lost after the
    // export began takes its parts with it (they come from that copy).
    if (p.checkpoint !== null) {
      await removeTree(dataPath(d.dataDir, 'backups', backupId, 'tables'));
    }
    await sqliteSnapshotTo(ctx.handle, copy);
    const next = { ...p, backupId, snapshot: 'sqlite-copy' as const, checkpoint: null };
    await publishBackupProgress(ctx.handle, backupId, 0);
    await ctx.heartbeat({ progress: 0 });
    if (!(await hold())) return waitForSnapshot(ctx);
    return { continueWith: next, progress: 0 };
  }
  const read = await connectSqliteFile(copy, { readOnly: true });
  let open = true;
  const close = async (): Promise<void> => {
    if (!open) return;
    open = false;
    await read.close();
  };
  try {
    const q = { ...p, backupId };
    const exporter = await exporterOf(d, ctx, q, read.db, 'sqlite');
    const r = await exporter.step(p.checkpoint, { deadline: stepDeadline(ctx) });
    if (!r.done) return await continued(ctx, q, r, hold);
    await close();
    await finishBackup(ctx.handle, d.dataDir, { backupId, now: ctx.now(), log: ctx.log });
    await release();
    return { done: true };
  } finally {
    await close();
  }
}

async function serverSlice(
  d: BackupJobDeps,
  ctx: JobContext,
  p: BackupCreatePayload,
  hold: () => Promise<boolean>,
  release: () => Promise<void>,
): Promise<JobOutcome<BackupCreatePayload>> {
  const backupId = p.backupId as string;
  const { value: snapshot, fresh } = await ctx.session(
    () => openSnapshotSession(() => d.connectSnapshot()),
    (s) => s.close(),
  );
  let checkpoint = p.checkpoint;
  if (fresh && checkpoint !== null) {
    // C12: the transaction those parts came from is gone; they cannot be continued from another one.
    ctx.log.info('backup: the snapshot transaction was lost; the export starts again', { jobId: ctx.jobId, backupId });
    await removeTree(dataPath(d.dataDir, 'backups', backupId));
    checkpoint = null;
  }
  const q = { ...p, backupId, snapshot: 'transaction' as const, checkpoint };
  const exporter = await exporterOf(d, ctx, q, snapshot.db, ctx.handle.dialect);
  const r = await exporter.step(checkpoint, { deadline: stepDeadline(ctx) });
  if (!r.done) return continued(ctx, q, r, hold);
  await finishBackup(ctx.handle, d.dataDir, { backupId, now: ctx.now(), log: ctx.log });
  await release();
  return { done: true };
}

/**
 * C12: a slice of a MySQL/MariaDB/PostgreSQL snapshot backup run by `cron_http` or `drive` cannot hold a snapshot
 * transaction past its request: the job's backup (if any) is removed and marked `failed`, its lock released, and the
 * frozen `backup` op begins in its place (same kind and files). The job is then done ("converted to frozen").
 */
async function convertToFrozen(
  d: BackupJobDeps,
  ctx: JobContext,
  p: BackupCreatePayload,
  release: () => Promise<void>,
): Promise<JobOutcome<BackupCreatePayload>> {
  const h = ctx.handle;
  if (p.backupId !== null) {
    await removeTree(dataPath(d.dataDir, 'backups', p.backupId));
    await h.db.updateTable('backups').set({ status: 'failed' }).where('id', '=', p.backupId).where('status', '=', 'running').execute();
  }
  await release();
  // A conversion whose result was lost (P7) has begun its op already.
  if (!(await backupOpBegunBy(d.dataDir, 'convertedFrom', ctx.jobId))) {
    await d.ops.begin('backup', { type: 'system', id: null }, { kind: p.kind, includeFiles: p.includeFiles, convertedFrom: ctx.jobId });
  }
  ctx.log.info('backup: a snapshot backup driven by the cron URL became a frozen backup', { jobId: ctx.jobId, mode: ctx.mode });
  return { done: true, message: CONVERTED_TO_FROZEN };
}
