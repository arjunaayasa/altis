import {
  SLICE_BUDGET_MS,
  claimById,
  closeJobSessions,
  createJobRegistry,
  enqueueSnapshotBackup,
  insertExternalBackupRow,
  readMaintenance,
  readUploadedHeader,
  runSlice,
  txCtx,
  uploadedArchivePath,
  type Actor,
  type BackupCreatePayload,
  type BackupItem,
  type OpStatus,
  type OpsMachine,
  type RestoreParams,
} from '@altis/core';
import { connect, withTx, type DbHandle } from '@altis/db';
import { copyOperatorFile, dataPath, isEnvSet, removeTree, type Env } from '@altis/platform';
import { DomainError, ERROR_CODES, isDomainError, isUlid, newId, type ErrorCode } from '@altis/shared';
import { confirmExternalRestore, prepareRestore } from '../api/backups.js';
import type { AppState } from '../app.js';
import { loadConfig } from '../config.js';
import { csrfKey } from '../http/csrf.js';
import type { BootContext } from '../index.js';
import { bindJobHandlers, jobHandlers, jobWorkerName, opKinds, testClockOffsetMs, updateRestoreRunner } from '../jobs/runtime.js';
import { createLogger, type Logger } from '../logger.js';
import { appUpdateKindDeps, createAppOps } from '../services.js';
import { CliError } from './common.js';
import { CLI_OP_ACTOR, notInstalled, opFailure } from './migrate.js';

// `node app.js backup:create [--files] [--json]` (spec §9.9, §13.6; plan Task 20): a snapshot backup made by this
// process, whose slices run back to back (C38: one session, so on MySQL/MariaDB/PostgreSQL one snapshot transaction
// on a dedicated connection, P17; on SQLite a copy of the file first). It is the `backup.create` job, enqueued with
// `uniqueKey 'backup:manual'` (a manual backup already queued or running is joined, not doubled), so the Backup
// screen, the job list and the notifications show it like any other. While another process runs that job the command
// waits for it to end, and while another snapshot backup holds `backup:snapshot` it waits its turn (1d). It ends with
// the backup's id, or fails with the job's error (a failure the queue retries later is reported at once). Refused
// under maintenance (an op runs, or `maintenance:on`). Warnings go to the server log (DATA_DIR/logs/altis.log).

/** What `backup:create` made. */
export interface BackupCreateResult {
  backupId: string;
  jobId: string;
}

/** The wait between two looks while another process runs the job. */
const WAIT_MS = 1000;

function pause(ms: number): Promise<void> {
  return new Promise((resolve) => setTimeout(resolve, ms));
}

function underMaintenance(): DomainError {
  return new DomainError('MAINTENANCE', {
    detail:
      'Mode pemeliharaan aktif (sebuah operasi sedang berjalan); coba lagi setelah selesai / ' +
      'Maintenance mode is on (an operation is running); try again once it ends',
  });
}

/** The job's error as the command reports it: its `last_error` code and detail, else BACKUP_FAILED. */
function failureOf(lastError: string | null, status: string): Error {
  const match = lastError === null ? null : /^([A-Z][A-Z0-9_]*)(?:: ([\s\S]*))?$/.exec(lastError);
  if (match !== null && Object.hasOwn(ERROR_CODES, match[1]!)) {
    const code = match[1] as ErrorCode;
    return new DomainError(code, { detail: match[2] ?? 'Cadangan gagal dibuat / The backup failed' });
  }
  return new CliError('BACKUP_FAILED', `Cadangan gagal dibuat (tugas ${status}) / The backup failed (job ${status})`);
}

/** The backup the succeeded job `jobId` made: the one of its last checkpoint, else (one slice did it all) its own id. */
async function backupOf(h: DbHandle, jobId: string, payload: string, startedAt: number): Promise<string> {
  let fromPayload: string | null;
  try {
    fromPayload = (JSON.parse(payload) as Partial<BackupCreatePayload>).backupId ?? null;
  } catch {
    fromPayload = null;
  }
  for (const id of [fromPayload, jobId]) {
    if (id === null) continue;
    const row = await h.db.selectFrom('backups').select('status').where('id', '=', id).executeTakeFirst();
    if (row?.status === 'ok') return id;
  }
  // A first slice that finished a backup under a new id (its job's id was taken by an earlier, failed one).
  const newest = await h.db
    .selectFrom('backups')
    .select('id')
    .where('kind', '=', 'manual')
    .where('status', '=', 'ok')
    .where('created_at', '>=', startedAt)
    .orderBy('created_at', 'desc')
    .orderBy('id', 'desc')
    .limit(1)
    .executeTakeFirst();
  if (newest === undefined) throw new CliError('BACKUP_FAILED', 'Cadangan tidak ditemukan / The backup was not found');
  return newest.id;
}

/**
 * Makes a manual snapshot backup of the installed DATA_DIR (see the top of this file). Everything it opens (the
 * database, the job session's connection, op connections) is closed before it returns.
 *
 * @throws DomainError `NOT_INSTALLED`, `MAINTENANCE`, or the job's error (`DISK_QUOTA`, ...); CliError `BACKUP_FAILED`;
 *   what loadConfig and connect throw
 */
export async function backupCreate(ctx: BootContext, env: Env, o: { files: boolean }): Promise<BackupCreateResult> {
  const offset = testClockOffsetMs(env);
  const clock = (): number => Date.now() + offset;
  const config = await loadConfig(ctx.dataDir, env);
  if (config === null || config.installState !== 'complete') throw notInstalled();
  const log = createLogger({ dataDir: ctx.dataDir, level: config.log.level }).child({ command: 'backup:create' });
  const h = await connect(config.db, { runtime: ctx.runtime, purpose: 'cli', dataDir: ctx.dataDir });
  const state: AppState = { phase: 'ready', db: h, config };
  const ops = createAppOps(state, { dataDir: ctx.dataDir, version: ctx.release.version, log, clock, runtime: ctx.runtime });
  const reg = createJobRegistry(
    bindJobHandlers(jobHandlers(), {
      dataDir: ctx.dataDir,
      runtime: ctx.runtime,
      installId: config.install.id,
      appVersion: ctx.release.version,
      ops,
      config: () => state.config,
    }),
  );
  const worker = jobWorkerName('cli');
  try {
    if ((await readMaintenance(ctx.dataDir)) !== null) throw underMaintenance();
    const startedAt = clock();
    const payload: BackupCreatePayload = { backupId: null, kind: 'manual', includeFiles: o.files, checkpoint: null, snapshot: null };
    const { id: jobId } = await withTx(h, (trx) =>
      // A live manual job of the other files choice is refused (OPS_BLOCKED_BY_BACKUP), never reported as this one.
      enqueueSnapshotBackup(trx, { payload, uniqueKey: 'backup:manual', now: startedAt }),
    );
    for (;;) {
      const flag = await readMaintenance(ctx.dataDir);
      if (flag !== null && !flag.exemptJobIds.includes(jobId)) throw underMaintenance();
      const job = await claimById(h, reg, jobId, { worker, now: clock(), exempt: flag === null ? null : flag.exemptJobIds });
      if (job === null) {
        const row = await h.db.selectFrom('jobs').select('status').where('id', '=', jobId).executeTakeFirst();
        if (row === undefined || (row.status !== 'queued' && row.status !== 'running')) break;
        await pause(WAIT_MS); // another process runs it
        continue;
      }
      const result = await runSlice(h, reg, job, { mode: 'cron_cli', budgetMs: SLICE_BUDGET_MS, keyring: config.keyring, log, clock, env });
      // The next slice at once (one session); a failure the queue retries later is reported now. A slice that waits
      // for `backup:snapshot` (another snapshot backup holds it, 1d) is claimed again once its time has come.
      if (result.outcome !== 'continued' && result.outcome !== 'waiting' && result.outcome !== 'lost') break;
    }
    const row = await h.db.selectFrom('jobs').select(['status', 'payload', 'last_error']).where('id', '=', jobId).executeTakeFirstOrThrow();
    if (row.status !== 'succeeded') throw failureOf(row.last_error, row.status);
    return { backupId: await backupOf(h, jobId, row.payload, startedAt), jobId };
  } finally {
    await closeJobSessions(log);
    await ops.close();
    await h.close();
  }
}

/** The human line of a backup (the command and the backup's id first, so scripts can match them). */
export function describeBackupCreate(result: BackupCreateResult): string {
  return `backup:create: ${result.backupId} cadangan selesai / backup finished`;
}

// ---------------------------------------------------------------------------------------------------------------
// `node app.js backup:restore <file|backupId> [--without-files] [--yes-external <library name>] [--json]` (spec §9.10,
// §9.9 "frasa sandi CLI", §13.6; plan Task 29; preflight S6, S8):
//
// 1. The operand is a backup of this installation when a `backups` row has that id; otherwise it is the path of an
//    `.altisbak` file, copied into `backups/<newId>/archive.altisbak` (copyOperatorFile: a regular file only,
//    ensureHeadroom(DATA_DIR, 2 × size) first) and registered as the route registers an upload
//    (insertExternalBackupRow: kind `external`, status `uploaded`, the clear header's versions, dialect and
//    consistency, the file's size and SHA-256). Once the checks of step 2 passed, the registration stays and is
//    audited as the route audits an upload: one `backup.upload` entry by the actor `cli` (1d T29-CLI-REGISTER-AUDIT;
//    an operator's file has no upload session). A registration undone by a refusal leaves no entry; one undone
//    because `ops.begin` then refuses (another op, a snapshot backup) keeps its entry.
// 2. The checks of `POST backups/:id/restore` (api/backups.ts): an encrypted archive's passphrase comes from
//    ALTIS_BACKUP_PASSPHRASE, else from a prompt without echo at the terminal (none there: BACKUP_PASSPHRASE_REQUIRED);
//    another installation's backup needs `--yes-external` with this library's name (else BACKUP_CONFIRM_REQUIRED).
//    A failure here removes the copy registered in step 1 again.
// 3. `ops.begin('restore', {type: 'cli'}, params, {secret: kek})`, then the op is stepped by this process until it
//    ends (≤ 20 s per step), each new state or progress reported as a line (`--json`: one final line). On SQLite the
//    load runs on Task 25's work file, and this process lets go of the live file for the swap. Exit 0 on `done`, 1
//    otherwise (the op's error). Refused under maintenance (an op runs, or `maintenance:on`), as the route is.

/** What `backup:restore` restored. */
export interface BackupRestoreResult {
  backupId: string;
  opId: string;
  state: string;
}

export interface BackupRestoreOptions {
  /** The operand: a backup id of this installation, or the path of an `.altisbak` file. */
  target: string;
  withoutFiles: boolean;
  /** `--yes-external`: this library's name, the confirmation another installation's backup needs. */
  yesExternal?: string;
  /** Asks the operator for the passphrase without echo; null when there is no terminal. */
  promptSecret(question: string): Promise<string | null>;
  /** Called with every status whose state or progress differs from the last one (the human lines). */
  onStatus?(status: OpStatus): void;
}

/** The environment variable that holds an archive's passphrase (spec §9.9). */
const PASSPHRASE_ENV = 'ALTIS_BACKUP_PASSPHRASE';
/** A step that left the op as it was (the freeze, another stepper) is followed by this pause. */
const STEP_PAUSE_MS = 250;

/** Who the `backup.upload` entry of a registered file names. */
const CLI_AUDIT_ACTOR: Actor = { type: 'cli', id: null, ip: null };

/** The passphrase: ALTIS_BACKUP_PASSPHRASE, else what the operator types at the prompt; undefined for none. */
async function passphraseOf(env: Env, promptSecret: BackupRestoreOptions['promptSecret']): Promise<string | undefined> {
  if (isEnvSet(env, PASSPHRASE_ENV)) return env[PASSPHRASE_ENV];
  const typed = await promptSecret('Frasa sandi arsip / Archive passphrase: ');
  return typed === null || typed === '' ? undefined : typed;
}

function fileRefused(error: unknown): unknown {
  const code = (error as { code?: unknown } | null)?.code;
  if (code === 'ENOENT' || code === 'ENOTDIR') {
    return new DomainError('NOT_FOUND', {
      detail: 'Tidak ada backup dengan id itu maupun berkas di path itu / There is no backup with that id, nor a file at that path',
    });
  }
  if (isDomainError(error) && error.code === 'STATE_CORRUPT' && error.meta?.['reason'] === 'not_a_file') {
    return new DomainError('BACKUP_INVALID', {
      detail: 'Path itu bukan berkas arsip biasa / That path is not a regular archive file',
      meta: { reason: 'format' },
    });
  }
  if (code === 'EACCES' || code === 'EPERM') {
    return new CliError('FILE_UNREADABLE', 'Berkas arsip tidak dapat dibaca / The archive file cannot be read');
  }
  return error;
}

/** Removes the backup `backupId` that this run registered (its row and its folder): best effort. */
async function unregister(h: DbHandle | undefined, dataDir: string, backupId: string, log: Logger): Promise<void> {
  try {
    await removeTree(dataPath(dataDir, 'backups', backupId));
    if (h !== undefined) await h.db.deleteFrom('backups').where('id', '=', backupId).where('status', '=', 'uploaded').execute();
  } catch (error) {
    log.warn('backup:restore: the copied archive could not be removed again', { backupId, code: (error as { code?: unknown } | null)?.code });
  }
}

/**
 * The backup the operand names: a backup of this installation, or a new one registered from the file at that path
 * (see the top of this block). `registered` is the latter's row (null for the former).
 */
async function backupOfOperand(
  h: DbHandle,
  dataDir: string,
  target: string,
  now: number,
): Promise<{ backupId: string; registered: BackupItem | null }> {
  if (isUlid(target)) {
    const row = await h.db.selectFrom('backups').select('id').where('id', '=', target).executeTakeFirst();
    if (row !== undefined) return { backupId: target, registered: null };
  }
  const backupId = newId(now);
  const file = uploadedArchivePath(dataDir, backupId);
  let registered: BackupItem;
  try {
    const copied = await copyOperatorFile(target, file);
    const header = await readUploadedHeader(file);
    registered = await withTx(h, (trx) => insertExternalBackupRow(trx, { id: backupId, size: copied.size, sha256: copied.sha256, header, now }));
  } catch (error) {
    await removeTree(dataPath(dataDir, 'backups', backupId)).catch(() => undefined);
    throw fileRefused(error);
  }
  return { backupId, registered };
}

/** The `backup.upload` entry of an archive this command registered: the upload route's meta, by the actor `cli`. */
async function auditRegistration(h: DbHandle, item: BackupItem, now: number): Promise<void> {
  await withTx(h, (trx) =>
    txCtx(trx, now, CLI_AUDIT_ACTOR).audit({
      action: 'backup.upload',
      entity: 'backups',
      entityId: item.id,
      meta: { backupId: item.id, size: item.size, dialect: item.dialect, schemaVersion: item.schemaVersion, appVersion: item.appVersion },
    }),
  );
}

/**
 * Steps the op `opId` this command began until it ends (≤ 20 s per step; while another process steps it, this one
 * waits and looks again), reporting each new state or progress. When the command cannot finish it (a step throws, or
 * the op needs attention), a cancel is tried (refused past the point of no return: the op then waits for whoever steps
 * it next, maintenance kept), unless the step lock was taken over (`lock_lost`).
 */
async function stepRestore(ops: OpsMachine, opId: string, onStatus: BackupRestoreOptions['onStatus']): Promise<OpStatus> {
  let shown: string | null = null;
  let seen: string | null = null;
  try {
    for (;;) {
      const status = await ops.step(SLICE_BUDGET_MS);
      if (status === null || status.opId !== opId) {
        throw new DomainError('OPS_NONE', {
          detail: 'Operasi ini diambil alih atau dihapus oleh proses lain / This operation was taken over or removed by another process',
        });
      }
      const line = `${status.state}:${status.progress}`;
      if (line !== shown) onStatus?.(status);
      shown = line;
      if (status.terminal) return status;
      if (status.needsAttention) throw opFailure(status);
      const now = `${line}:${String(status.heartbeatAt)}`;
      if (now === seen) await pause(STEP_PAUSE_MS);
      seen = now;
    }
  } catch (error) {
    const lost = isDomainError(error) && error.code === 'STATE_CORRUPT' && error.meta?.['reason'] === 'lock_lost';
    // Only its own op (final review T24): one somebody else began after this one ended is left alone.
    if (!lost) await ops.cancel(CLI_OP_ACTOR, { opId }).catch(() => undefined);
    throw error;
  }
}

/**
 * Restores a backup into the installed DATA_DIR (see the top of this block). Everything it opens (the database, the
 * op's connections) is closed before it returns.
 *
 * @throws DomainError `NOT_INSTALLED`, `MAINTENANCE`, `NOT_FOUND`, `BACKUP_NOT_READY`, `BACKUP_INVALID`,
 *   `BACKUP_PASSPHRASE_REQUIRED`, `BACKUP_PASSPHRASE_INVALID`, `VALIDATION_FAILED` (a passphrase too short),
 *   `BACKUP_CONFIRM_REQUIRED`, `OPS_IN_PROGRESS`, `OPS_BLOCKED_BY_BACKUP`, `DISK_QUOTA`, or the error the op ended with
 *   (`RESTORE_CONFLICTS`, ...); CliError `FILE_UNREADABLE`; what loadConfig and connect throw
 */
export async function backupRestore(ctx: BootContext, env: Env, o: BackupRestoreOptions): Promise<BackupRestoreResult> {
  const offset = testClockOffsetMs(env);
  const clock = (): number => Date.now() + offset;
  const config = await loadConfig(ctx.dataDir, env);
  if (config === null || config.installState !== 'complete') throw notInstalled();
  const log = createLogger({ dataDir: ctx.dataDir, level: config.log.level }).child({ command: 'backup:restore' });
  const open = (): Promise<DbHandle> => connect(config.db, { runtime: ctx.runtime, purpose: 'cli', dataDir: ctx.dataDir });
  const state: AppState = { phase: 'ready', db: await open(), config };
  // 1c Task 25 (C17): what this process holds on a SQLite file, let go of for the swap and opened again after it.
  let released = false;
  const own = {
    async close(): Promise<void> {
      await ops.close();
      const h = state.db;
      state.db = undefined;
      if (h === undefined) return;
      released = true;
      await h.close();
    },
    async reopen(): Promise<void> {
      if (!released || state.db !== undefined) return;
      state.db = await open();
      released = false;
    },
  };
  const sqlite = { log, own };
  // 1d Task 24 (preflight S6): the update kind, over this command's own edition and feed client.
  const update = appUpdateKindDeps(state, {
    dataDir: ctx.dataDir,
    appRoot: ctx.appRoot,
    releaseDir: ctx.release.dir,
    version: ctx.release.version,
    env,
    clock,
    log,
    restore: updateRestoreRunner({ appVersion: ctx.release.version, config: () => state.config, dataDir: ctx.dataDir, sqlite }),
    requestRestart: (reason) => ctx.requestRestart(reason),
  });
  const kinds = opKinds({ appVersion: ctx.release.version, config: () => state.config, dataDir: ctx.dataDir, sqlite, update });
  const ops: OpsMachine = createAppOps(state, { dataDir: ctx.dataDir, version: ctx.release.version, log, clock, runtime: ctx.runtime, kinds });
  let registered: string | null = null;
  try {
    if ((await readMaintenance(ctx.dataDir)) !== null) throw underMaintenance();
    const h = state.db!;
    const operand = await backupOfOperand(h, ctx.dataDir, o.target, clock());
    if (operand.registered !== null) registered = operand.backupId;
    const { backupId } = operand;
    const start = await prepareRestore({
      db: h.db,
      dataDir: ctx.dataDir,
      sessionKey: csrfKey(config),
      backupId,
      passphrase: () => passphraseOf(env, o.promptSecret),
    });
    if (!start.hmacValid) await confirmExternalRestore(h.db, o.yesExternal);
    // The checks passed: the registered archive stays, audited once (T29-CLI-REGISTER-AUDIT).
    if (operand.registered !== null) await auditRegistration(h, operand.registered, clock());
    const params: RestoreParams = { backupId, source: start.source, withoutFiles: o.withoutFiles, confirmed: !start.hmacValid, targetSchema: 'latest' };
    const { opId } = await ops.begin('restore', CLI_OP_ACTOR, params, start.kek === null ? {} : { secret: start.kek });
    registered = null; // the op restores it now: it stays, whatever the op's end
    const status = await stepRestore(ops, opId, o.onStatus);
    if (status.state !== 'done') throw opFailure(status);
    return { backupId, opId, state: status.state };
  } catch (error) {
    if (registered !== null) await unregister(state.db, ctx.dataDir, registered, log);
    throw error;
  } finally {
    await ops.close();
    await state.db?.close();
  }
}

/** The human line of a status of the restore op (the command and the op's id first). */
export function describeRestoreStatus(status: OpStatus): string {
  return `backup:restore: ${status.opId ?? '-'} ${status.state} ${status.progress}%`;
}

/** The human line of a finished restore (the command and the backup's id first, so scripts can match them). */
export function describeBackupRestore(result: BackupRestoreResult): string {
  return `backup:restore: ${result.backupId} dipulihkan / restored (op ${result.opId})`;
}
