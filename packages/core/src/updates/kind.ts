import {
  COMPLETE_FILE,
  MANIFEST_FILE,
  SIGNATURE_FILE,
  readReleaseKeyset,
  verifyReleaseWithRoots,
  type KeysetSource,
  type ReleaseManifest,
  type TrustedKey,
} from '@altis/crypto';
import type { FeedEntry } from '@altis/crypto/feed';
import { migrateUpOne, withTx, type AltisMigration, type DbHandle } from '@altis/db';
import {
  copyFileTo,
  copyOperatorFile,
  dataPath,
  ensureDir,
  ensureHeadroom,
  fsyncDir,
  releaseDir,
  releaseStagingName,
  releaseStagingPath,
  removeFile,
  removeTree,
  renameRetry,
  stagedReleaseFile,
  statOrNull,
  updateCurrentState,
  writeBytesAtomic,
  type DataPath,
} from '@altis/platform';
import { DomainError, isDomainError, isSemver, isUlid, newId } from '@altis/shared';
import { z } from 'zod';
import { ensureSystemRoles } from '../authz/system-roles.js';
import {
  abandonBackup,
  auditHeadOf,
  backupFinished,
  backupHeadroomBytes,
  finishBackup,
  insertBackupRow,
  schemaVersionOf,
  type BackupDeps,
} from '../backup/create-job.js';
import { createExporter, exportCheckpointSchema, type ExportCheckpoint } from '../backup/exporter.js';
import { errorFields, type CoreLogger } from '../context.js';
import { isDiskQuota, notifyDiskLow } from '../files/disk-quota.js';
import { stagedUploadFile, takeStagedUpload, uploadOwner } from '../files/uploads.js';
import type { notify as notifyFn } from '../notifications/service.js';
import type { OpFile } from '../ops/files.js';
import type { OpKindHandler, OpStepContext } from '../ops/machine.js';
import type { RestoreRun, createRestoreRunner } from '../restore/runner.js';
import { schemaHoldInstruction } from './bundled.js';
import { candidateOf, type Candidate } from './candidate.js';
import { finishUpdate } from './finish.js';
import { persistKeysetDocs } from './keyset-store.js';
import { extractVerifiedRelease, readPackageManifest } from './package.js';
import { throwPrecheck, type PrecheckReport } from './precheck.js';
import { RELEASE_LOG_FINAL, insertReleaseLog, readReleaseLog, setReleaseLogStatus } from './releases-log.js';
import { restoringStep, revertingStep } from './revert.js';
import type { UpdateSource } from './source.js';

// The `update` op kind (spec §9.4, §9.6, §9.7): up to its point of no return (§9.6 steps 1–5; plan Task 24; decisions
// D1d-15, D1d-16, D1d-38, D1d-44; preflight B5, B7, S3, S5, S21, 1D-07, 1D-18, 1D-23), then the boot of the target
// and the automatic revert (§9.6 step 6, §9.3, §9.7; plan Task 25; decisions D1d-17, D1d-21, D1d-42; preflight B8,
// S1, S2, S3, 1D-02). The revert's states live in revert.ts.
//
// The machine raises the `update` maintenance flag only from `verified` (`maintenanceFrom`): the download and the
// verification run while the site serves. Right before the flag, `beforeMaintenance` refuses the op when a snapshot
// backup began meanwhile (§9.4 "ditolak sebelum freeze", 1D-23), and the machine waits for the freeze (C9).
//
//   checking     the `releases_log` row (`running`, its id the op's); the staging folder `releases/.tmp-<v>-<opId>/`
//                (D1d-16); an upload's staged file moved to `<staging>/package.zip` and the upload taken (B5); the
//                candidate (the feed entry, or the package's signed manifest); the prechecks → refused: `aborted`.
//   downloading  a feed package downloaded in slices that resume (P9); a dropped connection, a timeout, a status or
//                an unreachable feed leave the op here with `downloadTries` rising and a back-off (the partial file
//                kept), and the 5th failure ends it (1D-18); a whole file whose SHA-256 differs is downloaded once more
//                from the start (bytes lost to a power cut fail the hash), then refused. Then the one-pass verified
//                extraction (the feed entry must equal the manifest) and the package's keyset documents persisted, so a
//                revocation it carries outlives the release (1D-07).
//   verified     (flag up, frozen) the `releases_log` row when absent: an op begun here (bundled, self) skipped
//                `checking` (B7).
//   frozen       an abandoned `pre_update` backup of a broken freeze removed first (S5); `needsBackup` = the target's
//                `schemaLatest` > the database's; if so the `pre_update` backup (DB only, frozen), one exporter step
//                per op step on the op's dedicated connection (P17), its id chosen before its row (P7).
//   backed_up    a bundled release copied from `<appRoot>/bundled-release/<v>` into the staging folder and verified;
//                bundled and self: the release's keyset documents persisted (1D-07); `releases/<v>` reused when it is
//                there and verifies `all`, else the staged release renamed into it; the staging folder removed.
//   staged       → `switched` with `pointOfNoReturn`: op.json is written before current.json (D1d-15).
//   switched     (a release other than the target) `pending = {target, data}`, `pendingSince`, `pinned = null`
//                (§9.7: an explicit update clears the pin) written once (`pendingWritten`), after the boot markers
//                an earlier attempt at the target left (`releases/boot/<target>/`) are removed (D1d-19); once
//                written, a `pending` that is no longer the target means a revert cleared it, and the op goes to
//                `reverting` (S3: writing it again would loop a bad release); a restart requested at most once per
//                30 s.
//
// After the point of no return (Task 25; D1d-17). The target steps them only in the process that boots it, with the
// boot hooks `deps.boot()` (start()'s `update_boot` plan: the holder of `releases/boot.lock`, or a process of the
// promoted target finishing `verifying`); without them it leaves the op as it is. Review C08: in `switched`..`verifying`
// the machine's 15-minute stall rule does not apply (`stalls`): nothing steps the op while it waits for the target's
// boot, and only §9.3's rules revert the target.
//
//   switched     (the target) `marker.phase('listening')`; the database reachable → `booting`; else
//                `marker.waiting('db_unavailable')` and the op as it was (not a failed boot, §9.3).
//   booting      `marker.phase('migrating')` → `migrating`.
//   migrating    one migration of this release per step (migrateUpOne), its progress refreshing the boot marker every
//                5 s (`waiting` while another process holds a migration lock: `marker.waiting('migration_lock')`, the
//                op as it was), until nothing is pending → `verifying`. A migration error → `reverting` with
//                `UPDATE_BOOT_FAILED` `migration`. A lost connection, or a lock lost meanwhile, leaves the op as it
//                was (the machine).
//   verifying    the system roles (a throw: `needs_attention`, which is a failed boot of the target, 1D-02); the
//                health of §9.3 (`hooks.health()`: the database answers, nothing pending; false → `reverting` with
//                `health`; a DB_UNAVAILABLE throw, the database not reached in time, leaves the op as it was, review
//                C09); `hooks.markHealthy()` (app.js promotes the target; one that promoted nothing: a throw,
//                `needs_attention`, so no op ends `done` with its target not `active`); finishUpdate(`done`). Once the
//                target is `active` (promoted), nothing reverts it: a failure of finishUpdate leaves the op in
//                `verifying` for the next step, which skips straight to finishUpdate.
//   booting..verifying, stepped by a release other than the target (S3): `pending` still the target, or the target
//                `active` (promoted) → as it was (its holder boots it); otherwise a revert cleared `pending` without
//                recording the op → `reverting` with `repeated`, so no release waits behind it for ever.
//   reverting, restoring  revert.ts (never stepped by the target, B8).
//   Task 27: a `self` update (§9.8 row 3, `schemaHold`) has no release to revert to: its states past the point of no
//   return are {@link selfStep}'s, and a failure there ends it `restore_failed` (see the section above selfStep). Its
//   `pre_update` backup is made with the generic exporter (the database's catalog, decision D1d-24).
//
// Before the point of no return a failure ends the op `aborted` after the kind's own cleanup (the staging folder, the
// `pre_update` backup) and finishUpdate (the row, `update.apply`, `update_failed`), so cleanup always runs; a full
// disk also notifies `disk_low`. A lost database connection or a busy lock leaves the op for the next step (the
// machine). Every step is idempotent (P7): it starts again from the last op.json, and an op whose `releases_log` row
// is final already (finishUpdate committed, op.json not yet written) ends at its next step.
//
// `params` are part of the frozen opSchema-1 contract shared with N+1 and app.js (S21, D1d-44): read loosely, every
// field this release does not know written back as it was, `target`, `source` and `from` never renamed.

/** How many failed download attempts end the op (1D-18). */
export const UPDATE_DOWNLOAD_TRIES = 5;
/** The back-off after a failed download attempt `n` (1-based): 5, 10, 20, 40 s. */
export function downloadBackoffMs(tries: number): number {
  return Math.min(5_000 * 2 ** Math.max(0, tries - 1), 60_000);
}
/** `switched` requests a restart at most this often. */
export const UPDATE_RESTART_INTERVAL_MS = 30_000;
/** A whole download is extracted in the same step only when at least this much of the step's budget is left. */
const EXTRACT_MARGIN_MS = 5_000;

/** The progress (0 to 100) at each stage up to the point of no return, then of the target's boot (Task 25). */
const PROGRESS = Object.freeze({
  checking: 2,
  downloadFrom: 5,
  downloadTo: 35,
  verified: 40,
  exportFrom: 45,
  exportTo: 80,
  backedUp: 85,
  staged: 90,
  switched: 95,
  booting: 96,
  migrating: 97,
  verifying: 99,
});
/** A step of `migrating` waits at least this long for the migration locks (the rest of its budget when longer). */
const MIGRATION_LOCK_WAIT_MIN_MS = 1000;

/**
 * Core's structural copy of the bootloader's `BootContext['bootMarker']` with the health hooks (Task 25): `start()`
 * returns it from `deps.boot()` only in the process that boots the target (`update_boot`); null everywhere else.
 */
export interface BootHooks {
  version: string;
  marker: {
    phase(p: 'importing' | 'listening' | 'migrating'): void;
    progress(): void;
    waiting?(reason: 'db_unavailable' | 'migration_lock'): void;
  };
  /**
   * The health of §9.3: true healthy; false unhealthy (the update reverts).
   *
   * @throws DomainError `DB_UNAVAILABLE` when the database cannot be reached in time: a wait (the op as it was), never a
   *   revert (review C09, §9.3 "Bukan alasan revert")
   */
  health(): Promise<boolean>;
  markHealthy(): Promise<void>;
}

/** What the update kind needs from its process, read at every step (the config of the moment). */
export interface UpdateKindDeps {
  dataDir: string;
  /** The folder of app.js (`bundled-release/<v>` lives there). */
  appRoot: string;
  /** The running release. */
  appVersion: string;
  source: UpdateSource;
  /** The prechecks (runPrecheck, with the edition's entitlement) of a candidate. */
  precheck(c: Candidate): Promise<PrecheckReport>;
  /** The embedded root keys. */
  roots: readonly TrustedKey[];
  /** The root-signed keyset documents the installation holds (its store, its releases). */
  sources(): Promise<KeysetSource[]>;
  /** Production builds: documents that trust a `dev-` kid count for nothing (R65b). */
  refuseDevKids: boolean;
  /** The `pre_update` backup's manifest facts (its DATA_DIR is the machine's). */
  backup: BackupDeps;
  /** This release's migrations (Task 25 migrates the target with them). */
  migrations: Readonly<Record<string, AltisMigration>>;
  /** The restore runner of the "terlalu lama" revert (Task 25), with the SQLite swap; null where none is wired. */
  restore: ReturnType<typeof createRestoreRunner> | null;
  requestRestart(reason: string): Promise<void>;
  /** Task 25: the boot hooks of the process that boots the target; null everywhere else. */
  boot(): BootHooks | null;
  /** True while a snapshot backup runs (the named lock `backup:snapshot`). */
  snapshotBackupRunning(): Promise<boolean>;
  notify: typeof notifyFn;
  log: CoreLogger;
}

/**
 * `op.params` of an update op (frozen with opSchema 1, S21): `source`, `target`, `from` and `entry` as `begin` gave
 * them, then the checkpoints. Fields after `restore` are Task 24's additive checkpoints.
 */
export type UpdateParams = {
  source: 'feed' | 'upload' | 'bundled' | 'self';
  target: string;
  from: string;
  entry: FeedEntry | null;
  uploadId?: string;
  /**
   * Review L11 (additive, S21): the staff user whose upload `uploadId` is (`updates.upload`'s caller). A takeover
   * changes the op's actor, not whose upload it takes; absent in an op begun before it was recorded (the actor's then).
   */
  uploadBy?: string;
  /** The staging folder's name (`.tmp-<v>-<opId>`), or null before one is made. */
  staging: string | null;
  /** Whether the target brings a schema migration (a `pre_update` backup is made); null until `frozen` decides. */
  needsBackup: boolean | null;
  pendingWritten?: boolean;
  /** A `pre_update` backup a broken freeze left (S5), abandoned by the next `frozen` step. */
  abandonBackupId?: string;
  downloadTries?: number;
  export?: ExportCheckpoint;
  precheck?: PrecheckReport;
  restartAt?: number;
  restore?: RestoreRun;
  /** Epoch ms before which a failed download is not tried again (the back-off). */
  downloadRetryAt?: number;
  /** A whole download failed its SHA-256 once and was begun again. */
  hashRetried?: boolean;
  /** The target manifest's `schemaLatest` (4 digits), once the release is verified. */
  schemaLatest?: string;
  /** The audit chain head as the `pre_update` export froze (the manifest's; audit_log is exported up to it). */
  auditHead?: { seq: number; hash: string };
};

const epochMs = z.number().int().min(0).max(Number.MAX_SAFE_INTEGER);
const ulid = z.string().refine(isUlid, 'not a ULID');
const semver = z
  .string()
  .max(64)
  .refine((v) => isSemver(v), 'not SemVer');
const word = z.string().min(1).max(64);

/** A feed entry as the op keeps it: the fields the kind reads; any other is kept (a later release's). */
const entrySchema = z.looseObject({
  version: semver,
  channel: z.enum(['stable', 'beta']),
  releasedAt: z.string().regex(/^\d{4}-\d{2}-\d{2}$/),
  bootProtocol: z.number().int().min(1),
  minUpgradeFrom: word,
  minCodeVersionAfter: word,
  minNode: word,
  minDb: z.looseObject({ mysql: word, mariadb: word, postgres: word }),
  size: z.number().int().min(0).max(Number.MAX_SAFE_INTEGER),
  sha256: z.string().regex(/^[0-9a-f]{64}$/),
  url: z.string().min(1).max(2048),
  notesUrl: z.string().min(1).max(2048).nullable(),
});

/**
 * The precheck report the op keeps for its pages. Loose: a later release may add fields, failures or reasons (S21); this
 * release only shows it.
 */
const precheckSchema = z.looseObject({
  ok: z.boolean(),
  failures: z.array(z.string().min(1).max(64)).max(32),
  dbRestoreNeeded: z.boolean(),
  estimateMs: z.number().min(0),
  headroomBytes: z.number().min(0),
  steppingStone: z.boolean(),
  candidate: z.looseObject({ version: z.string().max(64), bootProtocol: z.number(), minUpgradeFrom: z.string().max(64) }),
  notEntitled: z.string().max(64).nullable(),
});

/** Loose at every level (S21): unknown keys are kept, and the op writes `op.params` back with them. */
export const updateParamsSchema = z.looseObject({
  source: z.enum(['feed', 'upload', 'bundled', 'self']),
  target: semver,
  from: semver,
  entry: entrySchema.nullable(),
  uploadId: ulid.optional(),
  uploadBy: ulid.optional(),
  staging: z.string().min(1).max(160).nullable(),
  needsBackup: z.boolean().nullable(),
  pendingWritten: z.boolean().optional(),
  abandonBackupId: ulid.optional(),
  downloadTries: z.number().int().min(0).max(1000).optional(),
  export: exportCheckpointSchema.optional(),
  precheck: precheckSchema.optional(),
  restartAt: epochMs.optional(),
  restore: z.looseObject({ state: z.string().min(1).max(32) }).optional(),
  downloadRetryAt: epochMs.optional(),
  hashRetried: z.boolean().optional(),
  schemaLatest: z
    .string()
    .regex(/^\d{4}$/)
    .optional(),
  auditHead: z.strictObject({ seq: z.number().int().min(0).max(Number.MAX_SAFE_INTEGER), hash: z.string().min(1).max(128) }).optional(),
});

/**
 * The params of an update op (see {@link UpdateParams}), unknown fields kept.
 *
 * @throws TypeError when they are not an update op's
 */
export function parseUpdateParams(raw: unknown): UpdateParams {
  const parsed = updateParamsSchema.safeParse(raw);
  if (!parsed.success) {
    const issue = parsed.error.issues[0];
    throw new TypeError(`update op: the params are not valid (${issue === undefined ? 'shape' : `${issue.path.join('.')}: ${issue.message}`})`);
  }
  return parsed.data as unknown as UpdateParams;
}

/** `op` with `set` merged into its params and the keys of `drop` removed; every other param kept as it was (S21). */
function withParams(op: OpFile, set: Partial<UpdateParams>, drop: readonly (keyof UpdateParams)[] = []): OpFile {
  const params: Record<string, unknown> = { ...op.params, ...set };
  for (const key of drop) delete params[key];
  return { ...op, params };
}

/** What op.json records of a failure: the code, a 4xx DomainError's detail, and its registered `reason`. */
function errorOf(error: unknown): NonNullable<OpFile['error']> & { reason?: string } {
  if (!isDomainError(error)) return { code: 'INTERNAL' };
  const out: NonNullable<OpFile['error']> & { reason?: string } = { code: error.code };
  if (error.status < 500 && error.detail !== undefined) out.detail = error.detail;
  const reason = error.meta?.['reason'];
  if (typeof reason === 'string' && reason.length <= 64) out.reason = reason;
  return out;
}

/** Errors after which the same step may succeed later: the machine leaves the op as it was. */
function transient(error: unknown): boolean {
  if (!isDomainError(error)) return false;
  if (error.code === 'DB_UNAVAILABLE') return true;
  const reason = error.meta?.['reason'];
  return error.code === 'STATE_CORRUPT' && (reason === 'lock_timeout' || reason === 'lock_lost');
}

/** A download failure the op tries again after a back-off (1D-18). */
function retryableDownload(error: unknown): boolean {
  if (!isDomainError(error)) return false;
  if (error.code === 'FEED_UNREACHABLE') return true;
  const reason = error.meta?.['reason'];
  return error.code === 'UPDATE_DOWNLOAD_FAILED' && (reason === 'network' || reason === 'timeout' || reason === 'status');
}

/** A whole download whose SHA-256 differs from the feed's (its file removed by the source). */
function hashRefused(error: unknown): boolean {
  return isDomainError(error) && error.code === 'UPDATE_PACKAGE_INVALID' && error.meta?.['reason'] === 'hash';
}

function stagingCorrupt(what: string): DomainError {
  return new DomainError('STATE_CORRUPT', {
    detail: `Berkas pembaruan di folder sementara hilang (${what}); mulai pembaruan lagi / The update's staged files are gone (${what}); start the update again`,
    meta: { reason: 'staging' },
  });
}

/** This process's handle, or the op's dedicated connection (P17). */
async function dbOf(ctx: OpStepContext): Promise<DbHandle> {
  return ctx.db() ?? (await ctx.connectDedicated());
}

/** The 4-digit schema version `schema_meta` records (`0009`, `9001`), or null when it records none. */
async function databaseSchema(h: DbHandle): Promise<string | null> {
  const row = await h.db.selectFrom('schema_meta').select('schema_version').where('id', '=', 1).executeTakeFirst();
  const version = row?.schema_version;
  return typeof version === 'string' && /^\d{4}$/.test(version) ? version : null;
}

/** The keys a package or a release folder is verified with. */
async function keysOf(d: UpdateKindDeps): Promise<{ roots: readonly TrustedKey[]; sources: KeysetSource[]; refuseDevKids: boolean }> {
  return { roots: d.roots, sources: await d.sources(), refuseDevKids: d.refuseDevKids };
}

/**
 * `<appRoot>/bundled-release/<v>`: the release bundled beside app.js.
 *
 * @throws TypeError without an app folder (an app made without one has no bundled release)
 */
function bundledDir(d: UpdateKindDeps, version: string): string {
  if (d.appRoot === '') throw new TypeError('update op: a bundled release needs the app folder (UpdateKindDeps.appRoot)');
  return releaseDir(d.appRoot, d.dataDir, { version, source: 'bundled' });
}

/** Verifies the release folder `dir` (`check`), with the installation's keys. */
async function verifyFolder(d: UpdateKindDeps, dir: string, check: 'all' | 'executed'): Promise<ReleaseManifest> {
  const k = await keysOf(d);
  return verifyReleaseWithRoots(dir, k.roots.slice(), { check, sources: k.sources, refuseDevKids: k.refuseDevKids });
}

/** Whether the release folder `dir` is there and verifies `all`. */
async function folderVerifies(d: UpdateKindDeps, dir: string): Promise<boolean> {
  try {
    await verifyFolder(d, dir, 'all');
    return true;
  } catch {
    return false;
  }
}

/** Persists the keyset documents of the verified release folder `dir` (1D-07: a revocation outlives the release). */
async function persistReleaseKeyset(d: UpdateKindDeps, ctx: OpStepContext, dir: string): Promise<void> {
  const docs = await readReleaseKeyset(dir);
  await persistKeysetDocs({ dataDir: ctx.dataDir, roots: d.roots, docs, refuseDevKids: d.refuseDevKids, log: ctx.log, db: ctx.db(), now: ctx.now() });
}

/** Moves the file `from` to `to` (a rename; across file systems a copy, then the source removed). */
async function moveFile(from: DataPath, to: DataPath): Promise<void> {
  try {
    await renameRetry(from, to);
  } catch (error) {
    if ((error as { code?: unknown } | null)?.code !== 'EXDEV') throw error;
    await copyFileTo(from, to);
    await removeFile(from);
  }
}

/**
 * Removes what the op made before its point of no return: the staging folder, and the `pre_update` backup (its row
 * `failed`, its folder removed; a finished one is left as it is). Each part is tried on its own and logged on failure,
 * so a cleanup that cannot remove a folder never hides the op's own error (the boot sweep and the files cleanup catch
 * what is left).
 */
async function cleanup(ctx: OpStepContext, op: OpFile): Promise<void> {
  const target = typeof op.params['target'] === 'string' ? op.params['target'] : null;
  if (target !== null && isSemver(target)) {
    try {
      await removeTree(releaseStagingPath(ctx.dataDir, target, op.opId));
    } catch (error) {
      ctx.log.warn('update: the staging folder could not be removed; the boot sweep removes it', { opId: op.opId, ...errorFields(error) });
    }
  }
  const abandon = op.params['abandonBackupId'];
  const ids = new Set<string>();
  if (op.backupId !== null) ids.add(op.backupId);
  if (typeof abandon === 'string' && isUlid(abandon)) ids.add(abandon);
  if (ids.size === 0) return;
  try {
    const h = await dbOf(ctx);
    for (const backupId of ids) await abandonBackup(h, ctx.dataDir, { backupId, error: op.error, now: ctx.now(), log: ctx.log, notify: false });
  } catch (error) {
    if (transient(error)) throw error;
    ctx.log.warn('update: the pre_update backup could not be abandoned; the files cleanup ends it', { opId: op.opId, ...errorFields(error) });
  }
}

/**
 * Ends `op` before its point of no return with `error`: the kind's cleanup, `disk_low` for a full disk, finishUpdate
 * (`aborted`), then the op as the machine writes it. A database that cannot be reached for finishUpdate leaves the op
 * as it was (thrown on): the next step fails the same way and ends it then.
 */
async function abort(d: UpdateKindDeps, ctx: OpStepContext, op: OpFile, error: unknown): Promise<OpFile> {
  ctx.log.warn('update: the op ends before its point of no return', { opId: op.opId, state: op.state, ...errorFields(error) });
  const failing: OpFile = { ...op, error: withSelfInstruction(op, errorOf(error)) }; // Task 27: a `self` op says what to do
  await cleanup(ctx, failing);
  if (isDiskQuota(error)) {
    const h = ctx.db();
    if (h !== undefined) await notifyDiskLow(h, ctx.now(), ctx.log);
  }
  try {
    await finishUpdate(ctx, failing, 'aborted', d);
  } catch (cause) {
    if (transient(cause)) throw cause;
    ctx.log.error('update: the end of the op could not be recorded', { opId: op.opId, ...errorFields(cause) });
  }
  return { ...failing, state: 'aborted' };
}

/** The candidate a feed entry describes (the prechecks read these fields; extraction checks them against the manifest). */
function candidateOfEntry(e: FeedEntry): Candidate {
  return {
    version: e.version,
    releasedAt: e.releasedAt,
    bootProtocol: e.bootProtocol,
    minUpgradeFrom: e.minUpgradeFrom,
    minCodeVersionAfter: e.minCodeVersionAfter,
    minNode: e.minNode,
    minDb: { mysql: e.minDb.mysql, mariadb: e.minDb.mariadb, postgres: e.minDb.postgres },
    size: e.size,
  };
}

/** Inserts the op's `releases_log` row unless it is there (idempotent by op id). */
async function logRunning(ctx: OpStepContext, op: OpFile, p: UpdateParams): Promise<void> {
  const h = await dbOf(ctx);
  await withTx(h, (trx) =>
    insertReleaseLog(trx, { id: op.opId, version: p.target, action: 'update', fromVersion: p.from, startedAt: op.startedAt, backupId: null }),
  );
}

/**
 * B5: the upload of an `upload` op, moved into the staging folder as `package.zip`, then taken (its session row
 * deleted). The file moves first: a step killed between the two finds the package in place and only takes the upload,
 * and one killed after the take finds the session gone and the package there. Its staging folder in `tmp/` goes last.
 * The upload is the uploader's (`params.uploadBy`, review L11), whoever took the op over since.
 */
async function takeUpload(ctx: OpStepContext, op: OpFile, p: UpdateParams): Promise<DataPath> {
  const zip = releaseStagingPath(ctx.dataDir, p.target, op.opId, 'package.zip');
  if (p.uploadId === undefined) throw new TypeError('update op: an upload op needs params.uploadId');
  const by = p.uploadBy ?? (op.actor.type === 'staff' ? op.actor.id : null);
  if (by === null) throw new TypeError('update op: an upload op is begun by a staff user');
  const ref = { uploadId: p.uploadId, owner: uploadOwner(by), context: 'update' as const, dataDir: ctx.dataDir };
  const h = await dbOf(ctx);
  if ((await statOrNull(zip)) === null) {
    const staged = await stagedUploadFile(h.db, ref);
    await moveFile(staged.path, zip);
  }
  try {
    await withTx(h, (trx) => takeStagedUpload(trx, ref));
  } catch (error) {
    // Taken by an earlier run of this step (its package is in place).
    if (!(isDomainError(error) && error.code === 'NOT_FOUND')) throw error;
  }
  await removeTree(dataPath(ctx.dataDir, 'tmp', p.uploadId)).catch(() => undefined);
  return zip;
}

async function checking(d: UpdateKindDeps, ctx: OpStepContext, op: OpFile, p: UpdateParams): Promise<OpFile> {
  await logRunning(ctx, op, p);
  const staging = releaseStagingName(p.target, op.opId);
  await ensureDir(releaseStagingPath(ctx.dataDir, p.target, op.opId));
  let candidate: Candidate;
  if (p.source === 'feed') {
    if (p.entry === null) throw new TypeError('update op: a feed op needs params.entry');
    if (p.entry.version !== p.target) throw new TypeError('update op: params.entry is not the target');
    candidate = candidateOfEntry(p.entry);
  } else if (p.source === 'upload') {
    const zip = await takeUpload(ctx, op, p);
    const manifest = await readPackageManifest(zip, await keysOf(d));
    if (manifest.version !== p.target) {
      throw new DomainError('UPDATE_PACKAGE_INVALID', {
        detail: `Paket berisi rilis ${manifest.version}, bukan ${p.target} / The package holds release ${manifest.version}, not ${p.target}`,
        meta: { reason: 'version' },
      });
    }
    const size = (await statOrNull(zip))?.size ?? 0;
    candidate = candidateOf(manifest, size);
  } else {
    throw new TypeError(`update op: a ${p.source} op begins at verified, not checking`);
  }
  const report = await d.precheck(candidate);
  const checked = withParams(op, { staging, precheck: report });
  try {
    throwPrecheck(report);
  } catch (error) {
    return abort(d, ctx, checked, error);
  }
  return { ...checked, state: 'downloading', version: p.target, progress: PROGRESS.downloadFrom, message: null };
}

/**
 * Whether a failed download still backs off at `now`: before `downloadRetryAt`, unless that lies further ahead than the
 * back-off of the failure that set it (review L04: the clock was set back, as `restartAt` is guarded in `switched`).
 */
function backingOff(p: UpdateParams, now: number): boolean {
  if (p.downloadRetryAt === undefined || now >= p.downloadRetryAt) return false;
  return p.downloadRetryAt - now <= downloadBackoffMs(p.downloadTries ?? UPDATE_DOWNLOAD_TRIES);
}

/** The progress of a download at `bytes` of `total`. */
function downloadProgress(bytes: number, total: number): number {
  const share = total <= 0 ? 1 : Math.min(1, bytes / total);
  return PROGRESS.downloadFrom + Math.floor((PROGRESS.downloadTo - PROGRESS.downloadFrom) * share);
}

async function downloading(d: UpdateKindDeps, ctx: OpStepContext, op: OpFile, p: UpdateParams): Promise<OpFile> {
  const zip = releaseStagingPath(ctx.dataDir, p.target, op.opId, 'package.zip');
  let entry: FeedEntry | null = null;
  let next = op;
  if (p.source === 'feed') {
    if (p.entry === null) throw new TypeError('update op: a feed op needs params.entry');
    entry = p.entry;
    if (backingOff(p, ctx.now())) return op;
    let result: { complete: boolean; bytes: number };
    try {
      result = await d.source.download(entry, zip, (bytes, total) => ctx.publish({ progress: downloadProgress(bytes, total) }), { deadline: ctx.deadline });
    } catch (error) {
      if (retryableDownload(error)) {
        const tries = (p.downloadTries ?? 0) + 1;
        if (tries >= UPDATE_DOWNLOAD_TRIES) throw error;
        ctx.log.warn('update: the download failed; it is tried again', { opId: op.opId, tries, ...errorFields(error) });
        return withParams(op, { downloadTries: tries, downloadRetryAt: ctx.now() + downloadBackoffMs(tries) });
      }
      if (hashRefused(error) && p.hashRetried !== true) {
        // Bytes lost to a power cut fail the hash of the whole file: it is downloaded once more from the start.
        ctx.log.warn('update: the downloaded package failed its hash; it is downloaded once more', { opId: op.opId });
        return withParams(op, { hashRetried: true }, ['downloadRetryAt']);
      }
      throw error;
    }
    next = { ...withParams(op, {}, ['downloadRetryAt']), progress: downloadProgress(result.bytes, entry.size) };
    if (!result.complete) return next;
    if (ctx.now() >= ctx.deadline - EXTRACT_MARGIN_MS) return next; // the next step extracts it
  } else if (p.source === 'upload') {
    if ((await statOrNull(zip)) === null) throw stagingCorrupt('package.zip');
  } else {
    throw new TypeError(`update op: a ${p.source} op has no download`);
  }
  const k = await keysOf(d);
  const manifest = await extractVerifiedRelease({
    zip,
    version: p.target,
    opId: op.opId,
    dataDir: ctx.dataDir,
    expect: entry,
    roots: k.roots,
    sources: k.sources,
    refuseDevKids: k.refuseDevKids,
  });
  await persistReleaseKeyset(d, ctx, releaseStagingPath(ctx.dataDir, p.target, op.opId, 'release'));
  return { ...withParams(next, { schemaLatest: manifest.schemaLatest }, ['downloadRetryAt']), state: 'verified', progress: PROGRESS.verified };
}

/** The target's `schemaLatest`: from the verified package, the bundled release's manifest, or this release's own. */
async function targetSchemaLatest(d: UpdateKindDeps, p: UpdateParams): Promise<string> {
  if (p.schemaLatest !== undefined) return p.schemaLatest;
  if (p.source === 'bundled') {
    const manifest = await verifyFolder(d, bundledDir(d, p.target), 'executed');
    return manifest.schemaLatest;
  }
  if (p.source === 'self') {
    const last = Object.keys(d.migrations).sort().at(-1);
    if (last !== undefined && /^\d{4}_/.test(last)) return last.slice(0, 4);
  }
  throw stagingCorrupt('manifest.json');
}

/**
 * Where the pre_update backup's tables and columns come from. Task 27 (§9.8 row 3): `schemaHold` backs up a database
 * another release migrated, with the generic exporter (the tables and columns of the database's catalog, not this
 * release's registry), and its schema version is the database's own (schemaVersionOf).
 */
function columnsOf(p: UpdateParams): { columns?: 'catalog' } {
  return p.source === 'self' ? { columns: 'catalog' } : {};
}

async function frozen(d: UpdateKindDeps, ctx: OpStepContext, op: OpFile, p: UpdateParams): Promise<OpFile> {
  const h = await dbOf(ctx);
  if (p.abandonBackupId !== undefined) {
    // S5: the backup a broken freeze left goes first (refreeze cannot do I/O).
    await abandonBackup(h, ctx.dataDir, { backupId: p.abandonBackupId, error: null, now: ctx.now(), log: ctx.log, notify: false });
    return withParams(op, {}, ['abandonBackupId']);
  }
  if (p.needsBackup === null) {
    const latest = await targetSchemaLatest(d, p);
    const current = await databaseSchema(h);
    const needs = current === null || Number(latest) > Number(current);
    if (!needs) return { ...withParams(op, { needsBackup: false, schemaLatest: latest }), state: 'backed_up', progress: PROGRESS.exportTo };
    return withParams(op, { needsBackup: true, schemaLatest: latest });
  }
  if (!p.needsBackup) return { ...op, state: 'backed_up', progress: PROGRESS.exportTo };
  // The backup's id is chosen (and written to op.json) before its row exists, so a step run again finds its row.
  if (op.backupId === null) return { ...op, backupId: newId(ctx.now()) };
  const backupId = op.backupId;
  if (await backupFinished(h.db, backupId)) {
    // Finished by a step whose own op.json write was lost (P7).
    await withTx(h, (trx) => setReleaseLogStatus(trx, op.opId, 'running', { backupId }));
    return { ...withParams(op, {}, ['export', 'auditHead']), state: 'backed_up', progress: PROGRESS.exportTo };
  }
  let auditHead = p.auditHead;
  if (p.export === undefined || auditHead === undefined) {
    await ensureHeadroom(ctx.dataDir, await backupHeadroomBytes(h.db));
    await insertBackupRow(h, {
      id: backupId,
      kind: 'pre_update',
      consistency: 'frozen',
      dialect: h.dialect,
      schemaVersion: await schemaVersionOf(h.db, columnsOf(p)),
      appVersion: d.backup.appVersion,
      now: ctx.now(),
    });
    // The head as the database froze: the manifest records it, and audit_log is exported up to it.
    auditHead = await auditHeadOf(h.db);
  }
  const read = await ctx.connectDedicated();
  const exporter = createExporter({
    read: read.db,
    dialect: read.dialect,
    dataDir: ctx.dataDir,
    backupId,
    kind: 'pre_update',
    includeFiles: false,
    consistency: 'frozen',
    appVersion: d.backup.appVersion,
    schemaVersion: await schemaVersionOf(read.db, columnsOf(p)),
    installId: d.backup.installId,
    sessionKey: d.backup.sessionKey,
    kids: [...d.backup.kids],
    auditHead,
    clock: () => ctx.now(),
    ...columnsOf(p),
  });
  const r = await exporter.step(p.export ?? null, { deadline: ctx.deadline });
  const progress = PROGRESS.exportFrom + Math.floor(((PROGRESS.exportTo - PROGRESS.exportFrom) * r.progress) / 100);
  ctx.publish({ progress });
  if (!r.done) return { ...withParams(op, { export: r.checkpoint, auditHead }), progress };
  ctx.lock.assertHeld();
  await finishBackup(h, ctx.dataDir, { backupId, now: ctx.now(), log: ctx.log });
  // The row names the backup from now on (the machine reads it for an op.json nobody can read, spec §9.4).
  await withTx(h, (trx) => setReleaseLogStatus(trx, op.opId, 'running', { backupId }));
  return { ...withParams(op, {}, ['export', 'auditHead']), state: 'backed_up', progress: PROGRESS.exportTo };
}

/**
 * B7: copies the bundled release `<appRoot>/bundled-release/<v>` into `<staging>/release`: the source verified `all`
 * first, then each listed file (and the manifest with its signature) copied, `.complete` last, and the copy verified
 * `all` again. A previous attempt's copy is removed first (P7).
 */
async function copyBundled(d: UpdateKindDeps, ctx: OpStepContext, op: OpFile, p: UpdateParams): Promise<void> {
  const src = bundledDir(d, p.target);
  const manifest = await verifyFolder(d, src, 'all');
  const dest = releaseStagingPath(ctx.dataDir, p.target, op.opId, 'release');
  await removeTree(dest);
  await ensureHeadroom(ctx.dataDir, 2 * manifest.files.reduce((sum, f) => sum + f.size, 0));
  // The paths are the verified manifest's (stagedReleaseFile refuses any a release folder cannot hold), joined to
  // the release folder releaseDir built.
  const names = [...manifest.files.map((f) => f.path), MANIFEST_FILE, SIGNATURE_FILE];
  for (const name of names) await copyOperatorFile(`${src}/${name}`, stagedReleaseFile(ctx.dataDir, p.target, op.opId, name));
  const folders = new Set<string>();
  for (const name of names) {
    const parts = name.split('/');
    for (let n = parts.length - 1; n > 0; n -= 1) folders.add(parts.slice(0, n).join('/'));
  }
  for (const folder of [...folders].sort((a, b) => b.split('/').length - a.split('/').length)) {
    await fsyncDir(stagedReleaseFile(ctx.dataDir, p.target, op.opId, folder));
  }
  await fsyncDir(dest);
  await writeBytesAtomic(stagedReleaseFile(ctx.dataDir, p.target, op.opId, COMPLETE_FILE), '');
  try {
    await verifyFolder(d, dest, 'all');
  } catch (error) {
    throw new DomainError('UPDATE_PACKAGE_INVALID', {
      detail: `Salinan rilis terbundel ${p.target} tidak lolos verifikasi / The copy of the bundled release ${p.target} fails verification`,
      meta: { reason: 'hash' },
      cause: error,
    });
  }
}

async function backedUp(d: UpdateKindDeps, ctx: OpStepContext, op: OpFile, p: UpdateParams): Promise<OpFile> {
  if (p.source === 'self') {
    // Task 27 (§9.8 row 3): the running release is the target; nothing is copied or renamed.
    await persistReleaseKeyset(d, ctx, bundledDir(d, p.target));
    return { ...op, state: 'staged', progress: PROGRESS.staged };
  }
  const stagingDir = releaseStagingPath(ctx.dataDir, p.target, op.opId);
  if (p.source === 'bundled' && p.staging === null) {
    // B7: an op begun at `verified` made no staging folder at `checking`.
    await ensureDir(stagingDir);
    return withParams(op, { staging: releaseStagingName(p.target, op.opId) });
  }
  const installed = dataPath(ctx.dataDir, 'releases', p.target);
  const staged = releaseStagingPath(ctx.dataDir, p.target, op.opId, 'release');
  if (!(await folderVerifies(d, installed))) {
    if (p.source === 'bundled' && !(await folderVerifies(d, staged))) await copyBundled(d, ctx, op, p);
    if ((await statOrNull(staged)) === null) throw stagingCorrupt('release');
    // A folder of that version that does not verify (a copy cut short, a hand edit) gives way to the verified one.
    await removeTree(installed);
    ctx.lock.assertHeld();
    await renameRetry(staged, installed);
    await fsyncDir(dataPath(ctx.dataDir, 'releases'));
  }
  if (p.source === 'bundled') await persistReleaseKeyset(d, ctx, installed);
  await removeTree(stagingDir);
  return { ...op, state: 'staged', progress: PROGRESS.staged };
}

/**
 * A pending period of `target` counts its boots from zero (D1d-19): the markers an earlier attempt left in
 * `releases/boot/<target>/` (a revert or a promotion killed before it removed them, a removal that failed) are removed
 * before `pending` names the target again; left there, they would revert the new attempt without importing it. Under
 * ops/step.lock, and only this step writes `pending`, so while it does not name the target no process boots it. Once
 * it does (a step done again after a kill before the `pendingWritten` checkpoint), a holder may be booting the target,
 * and its markers stay.
 */
async function clearLeftoverMarkers(ctx: OpStepContext, target: string): Promise<void> {
  const { state } = await updateCurrentState(ctx.dataDir, () => null);
  if (state.active.version === target || state.pending?.version === target) return;
  ctx.lock.assertHeld();
  await removeTree(dataPath(ctx.dataDir, 'releases', 'boot', target));
}

/**
 * `switched`, stepped by a release other than the target (D1d-15, S3). The target boots it with its hooks (Task 25,
 * {@link targetSwitched}); a target without them leaves it to the process that boots it.
 */
async function switched(d: UpdateKindDeps, ctx: OpStepContext, op: OpFile, p: UpdateParams): Promise<OpFile> {
  if (p.source === 'self') return selfStep(d, ctx, op, p); // Task 27 (§9.8 row 3)
  if (d.appVersion === p.target) {
    const hooks = d.boot();
    return hooks === null ? op : targetSwitched(ctx, op, hooks);
  }
  const now = ctx.now();
  let next = op;
  let pending: boolean;
  if (p.pendingWritten !== true) {
    await clearLeftoverMarkers(ctx, p.target);
    ctx.lock.assertHeld();
    const { state } = await updateCurrentState(ctx.dataDir, (s) => {
      if (s.active.version === p.target) return null; // promoted already
      if (s.pending !== null && s.pending.version === p.target && s.pinned === null) return null;
      const since = s.pending !== null && s.pending.version === p.target && s.pendingSince !== null ? s.pendingSince : now;
      return { ...s, pending: { version: p.target, source: 'data' }, pendingSince: since, pinned: null };
    });
    pending = state.pending?.version === p.target;
    next = withParams(op, { pendingWritten: true });
  } else {
    const { state } = await updateCurrentState(ctx.dataDir, () => null);
    pending = state.pending?.version === p.target;
    if (!pending && state.active.version !== p.target) {
      // S3: a revert cleared `pending`; writing it again would boot the bad release in a loop.
      return { ...op, state: 'reverting', error: { code: 'UPDATE_BOOT_FAILED', detail: 'repeated' } };
    }
  }
  if (pending && (p.restartAt === undefined || now - p.restartAt >= UPDATE_RESTART_INTERVAL_MS || now < p.restartAt)) {
    try {
      await d.requestRestart('update');
    } catch (error) {
      ctx.log.warn('update: the restart could not be requested; it is asked again', { opId: op.opId, ...errorFields(error) });
    }
    next = withParams(next, { restartAt: now });
  }
  return { ...next, progress: Math.max(next.progress, PROGRESS.switched) };
}

/** The op moved to `reverting` because its target failed to boot (`detail`: migration, health, repeated, ...). */
function bootFailed(op: OpFile, detail: string): OpFile {
  return { ...op, state: 'reverting', error: { code: 'UPDATE_BOOT_FAILED', detail } };
}

function isDbUnavailable(error: unknown): boolean {
  return isDomainError(error) && error.code === 'DB_UNAVAILABLE';
}

/** Another process holds a migration lock (migrate.lock, or the MySQL/MariaDB named lock): not the release's fault. */
function migrationLockBusy(error: unknown): boolean {
  if (!isDomainError(error)) return false;
  const reason = error.meta?.['reason'];
  if (error.code === 'STATE_CORRUPT') return reason === 'lock_timeout';
  return error.code === 'DB_UNAVAILABLE' && reason === 'busy' && error.meta?.['code'] === 'MIGRATION_LOCK';
}

/** Whether the target is `active` in current.json (app.js promoted it): from then on nothing reverts it. */
async function promoted(dataDir: string, target: string): Promise<boolean> {
  const { state } = await updateCurrentState(dataDir, () => null);
  return state.active.version === target;
}

/**
 * `switched`, stepped by the target in the process that boots it: the marker says `listening`, then the database must
 * answer. One that does not is a wait for the environment, never a failed boot (§9.3 "Bukan alasan revert").
 */
async function targetSwitched(ctx: OpStepContext, op: OpFile, hooks: BootHooks): Promise<OpFile> {
  hooks.marker.phase('listening');
  try {
    const h = await dbOf(ctx);
    await h.db.selectFrom('schema_meta').select('id').limit(1).execute();
  } catch (error) {
    if (!isDbUnavailable(error)) throw error;
    ctx.log.warn('update: the database cannot be reached; the boot of the target waits', { opId: op.opId, ...errorFields(error) });
    hooks.marker.waiting?.('db_unavailable');
    return op;
  }
  return { ...op, state: 'booting', progress: Math.max(op.progress, PROGRESS.booting), message: null };
}

/**
 * `migrating`, stepped by the target: one migration of this release (migrateUpOne, under its locks, waiting for them at
 * most the rest of the step's budget). Its progress, every 5 s and around each migration, is the boot marker's (the
 * 15-minute stall rule of app.js counts from it); a wait for a migration lock marks the boot as waiting.
 */
async function targetMigrating(d: UpdateKindDeps, ctx: OpStepContext, op: OpFile, hooks: BootHooks): Promise<OpFile> {
  const h = await dbOf(ctx);
  let outcome: { done: boolean; applied?: string };
  try {
    outcome = await migrateUpOne(h, {
      appVersion: d.appVersion,
      dataDir: ctx.dataDir,
      migrations: { ...d.migrations },
      lockWaitMs: Math.max(MIGRATION_LOCK_WAIT_MIN_MS, ctx.deadline - ctx.now()),
      onProgress: (e) => {
        if (e.waiting) hooks.marker.waiting?.('migration_lock');
        else hooks.marker.progress();
      },
    });
  } catch (error) {
    if (migrationLockBusy(error)) {
      ctx.log.info('update: a migration lock is busy; the boot of the target waits', { opId: op.opId });
      hooks.marker.waiting?.('migration_lock');
      return op;
    }
    // The database, or a lock lost meanwhile (migrate.lock taken over): the op as it was (the machine), never a revert.
    if (transient(error)) throw error;
    const migration = (error as { meta?: Record<string, unknown> } | null)?.meta?.['migration'];
    ctx.log.error('update: a migration of the target failed; the update reverts', {
      opId: op.opId,
      migration: typeof migration === 'string' ? migration : null,
      ...errorFields(error),
    });
    return bootFailed(op, 'migration');
  }
  hooks.marker.progress();
  if (!outcome.done) return { ...op, progress: PROGRESS.migrating, message: outcome.applied ?? op.message };
  return { ...op, state: 'verifying', progress: PROGRESS.verifying, message: null };
}

/**
 * `verifying`, stepped by the target (D1d-17): the system roles, the health of §9.3, the promotion by app.js, the end.
 * Before the promotion a failed health check reverts the update, and a throw (the roles) needs attention, which app.js
 * and start() treat as a failed boot (1D-02). After it the target is `active`, and nothing reverts it: the step only
 * records the end, and a failure to do so leaves the op here for the next step (a lost connection: the machine).
 */
async function targetVerifying(d: UpdateKindDeps, ctx: OpStepContext, op: OpFile, p: UpdateParams, hooks: BootHooks): Promise<OpFile> {
  if (!(await promoted(ctx.dataDir, p.target))) {
    const h = await dbOf(ctx);
    const roles = await withTx(h, (trx) => ensureSystemRoles(trx, ctx.now()));
    if (roles.created.length > 0) ctx.log.info('update: system roles created', { opId: op.opId, roles: roles.created });
    if (!(await hooks.health())) {
      ctx.log.error('update: the target is not healthy; the update reverts', { opId: op.opId, target: p.target });
      return bootFailed(op, 'health');
    }
    try {
      await hooks.markHealthy();
    } catch (error) {
      // markHealthy may fail after its promotion (removing the markers, letting boot.lock go): promoted is promoted.
      if (!(await promoted(ctx.dataDir, p.target))) throw error;
      ctx.log.warn('update: markHealthy failed after the promotion; the update goes on', { opId: op.opId, ...errorFields(error) });
    }
    // An op ends `done` only with its target `active`: a markHealthy that promoted nothing (a release booted as
    // `active`, not as `pending`, whose markHealthy writes nothing) needs attention instead (the machine).
    if (!(await promoted(ctx.dataDir, p.target))) {
      throw new Error(`update op: markHealthy did not promote ${p.target}; the update cannot end done`);
    }
  }
  try {
    await finishUpdate(ctx, op, 'done', d);
  } catch (error) {
    if (transient(error)) throw error;
    ctx.log.error('update: the end of the promoted update could not be recorded; the next step tries again', { opId: op.opId, ...errorFields(error) });
    return op;
  }
  return { ...op, state: 'done', progress: 100, message: null };
}

/**
 * `booting`, `migrating` and `verifying`. The target steps them with its boot hooks; without them (a process that does
 * not boot it) it leaves the op as it is. Any other release only checks that the target is still pending or promoted
 * (S3): otherwise a revert cleared `pending` without recording the op, and the op goes to `reverting` (`repeated`).
 */
async function booting(d: UpdateKindDeps, ctx: OpStepContext, op: OpFile, p: UpdateParams): Promise<OpFile> {
  if (p.source === 'self') return selfStep(d, ctx, op, p); // Task 27 (§9.8 row 3)
  if (d.appVersion !== p.target) {
    const { state } = await updateCurrentState(ctx.dataDir, () => null);
    if (state.pending?.version === p.target || state.active.version === p.target) return op;
    ctx.log.warn('update: the target is no longer pending and the op was not recorded; it reverts', { opId: op.opId, state: op.state });
    return bootFailed(op, 'repeated');
  }
  const hooks = d.boot();
  if (hooks === null) return op;
  switch (op.state) {
    case 'booting':
      hooks.marker.phase('migrating');
      return { ...op, state: 'migrating', progress: PROGRESS.migrating, message: null };
    case 'migrating':
      return targetMigrating(d, ctx, op, hooks);
    default:
      return targetVerifying(d, ctx, op, p, hooks);
  }
}

// ---- Task 27: the `self` update of §9.8 row 3 (`schemaHold`; decision D1d-24; preflight 1D-04)
//
// The bundled release booted in `schemaHold` is the target and the only release there is: no older one can step a
// revert, so past the point of no return the target ends a failure itself (`restore_failed`, never `reverting`).
//
//   switched     (the target, with its boot hooks) current.json: `active = {target, bundled}`, `previous`, `pending`
//                and `pinned` null (D1d-24), then as any target: the database reachable → `booting`.
//   booting      → `migrating`.
//   migrating    this release's migrations one per step, as any target; a migration error → `restore_failed`.
//   verifying    the system roles and the health of §9.3 even though current.json names the target already (it was set
//                at `switched`, not by app.js's promotion); health false → `restore_failed`; finishUpdate(`done`),
//                then `requestRestart('update')`: the next boot runs the release as `active`, normally.
//   A failure past the point of no return (a migration, the health, any step's throw but a lost database or lock) →
//   finishUpdate(`restore_failed`) with 409 UPDATE_SCHEMA_HOLD_FAILED whose detail names the `pre_update` backup and
//   what to do ("jalankan lagi image/zip versi sebelumnya, lalu pulihkan backup `pre_update`"), maintenance kept, and
//   current.json `active` set back to `{from, bundled}`, so the previous image or zip boots again.
//   Each of these steps first reads the op's `releases_log` row: one that is final already (finishUpdate committed, the
//   op.json write was lost, P7) ends the op as recorded (`done`: the restart asked for again; `restore_failed`: the
//   pointer set back again). A release other than the target, or a process without the boot hooks, leaves the op as it
//   is.
//   Before the point of no return a failure ends the op `aborted` as for any source, its error detail followed by the
//   instruction (start() then keeps maintenance with a manual `update` flag).

/** current.json at a `self` update's point of no return: the target active (bundled), nothing else (D1d-24). */
async function selfPromote(ctx: OpStepContext, p: UpdateParams): Promise<void> {
  ctx.lock.assertHeld();
  await updateCurrentState(ctx.dataDir, (s) =>
    s.active.version === p.target && s.previous === null && s.pending === null && s.pinned === null
      ? null
      : { schema: 1, active: { version: p.target, source: 'bundled' }, previous: null, pending: null, pendingSince: null, pinned: null },
  );
}

/**
 * current.json after a `self` update failed past its point of no return: `active` back to `{from, bundled}` (the
 * previous image or zip boots it again), when it still names the target.
 */
async function selfPointerBack(ctx: OpStepContext, p: UpdateParams): Promise<void> {
  ctx.lock.assertHeld();
  await updateCurrentState(ctx.dataDir, (s) =>
    s.active.version !== p.target ? null : { ...s, active: { version: p.from, source: 'bundled' }, previous: null, pending: null, pendingSince: null },
  );
}

/** Asks for the restart after a `self` update ended `done`; a failure is logged (the next boot asks again). */
async function selfRestart(d: UpdateKindDeps, ctx: OpStepContext, op: OpFile): Promise<void> {
  try {
    await d.requestRestart('update');
  } catch (error) {
    ctx.log.warn('update: the restart after the schemaHold update could not be requested', { opId: op.opId, ...errorFields(error) });
  }
}

/** Ends a `self` update past its point of no return with `restore_failed` (see above); `reason` names what failed. */
async function selfFailed(d: UpdateKindDeps, ctx: OpStepContext, op: OpFile, p: UpdateParams, reason: string): Promise<OpFile> {
  const backupId = op.backupId ?? (await readReleaseLog((await dbOf(ctx)).db, op.opId))?.backupId ?? null;
  const error: NonNullable<OpFile['error']> & { reason: string } = {
    code: 'UPDATE_SCHEMA_HOLD_FAILED',
    detail: schemaHoldInstruction({ version: p.target, from: p.from, backupId }),
    reason,
  };
  const failing: OpFile = { ...op, backupId, error };
  ctx.log.error('update: the schemaHold update failed past its point of no return; maintenance stays', { opId: op.opId, reason, backupId });
  await finishUpdate(ctx, failing, 'restore_failed', d);
  await selfPointerBack(ctx, p);
  return { ...failing, state: 'restore_failed' };
}

/** The `self` op whose `releases_log` row is final already: ended as recorded (see above). */
async function selfRecorded(d: UpdateKindDeps, ctx: OpStepContext, op: OpFile, p: UpdateParams, row: { status: string; detail: Record<string, unknown> | null }): Promise<OpFile> {
  if (row.status === 'done') {
    await selfRestart(d, ctx, op);
    return { ...op, state: 'done', progress: 100, message: null };
  }
  const recorded = row.detail?.['error'];
  const error =
    typeof recorded === 'object' && recorded !== null && typeof (recorded as { code?: unknown }).code === 'string'
      ? (recorded as NonNullable<OpFile['error']>)
      : (op.error ?? { code: 'UPDATE_SCHEMA_HOLD_FAILED' });
  await selfPointerBack(ctx, p);
  return { ...op, state: 'restore_failed', error };
}

/** `verifying` of a `self` update: the roles and the health run although current.json names the target already. */
async function selfVerifying(d: UpdateKindDeps, ctx: OpStepContext, op: OpFile, p: UpdateParams, hooks: BootHooks): Promise<OpFile> {
  const h = await dbOf(ctx);
  const roles = await withTx(h, (trx) => ensureSystemRoles(trx, ctx.now()));
  if (roles.created.length > 0) ctx.log.info('update: system roles created', { opId: op.opId, roles: roles.created });
  if (!(await hooks.health())) {
    ctx.log.error('update: the schemaHold target is not healthy', { opId: op.opId, target: p.target });
    return selfFailed(d, ctx, op, p, 'health');
  }
  try {
    await finishUpdate(ctx, op, 'done', d);
  } catch (error) {
    if (transient(error)) throw error;
    ctx.log.error('update: the end of the schemaHold update could not be recorded; the next step tries again', { opId: op.opId, ...errorFields(error) });
    return op;
  }
  await selfRestart(d, ctx, op);
  return { ...op, state: 'done', progress: 100, message: null };
}

/** `switched`..`verifying` of a `self` update (see above). */
async function selfStep(d: UpdateKindDeps, ctx: OpStepContext, op: OpFile, p: UpdateParams): Promise<OpFile> {
  if (d.appVersion !== p.target) return op; // no other release steps it: there is nothing to revert to
  const recorded = await readReleaseLog((await dbOf(ctx)).db, op.opId);
  if (recorded !== null && RELEASE_LOG_FINAL.has(recorded.status)) return selfRecorded(d, ctx, op, p, recorded);
  const hooks = d.boot();
  if (hooks === null) return op; // the process that boots the target steps it
  try {
    switch (op.state) {
      case 'switched':
        await selfPromote(ctx, p);
        return await targetSwitched(ctx, op, hooks);
      case 'booting':
        hooks.marker.phase('migrating');
        return { ...op, state: 'migrating', progress: PROGRESS.migrating, message: null };
      case 'migrating': {
        const next = await targetMigrating(d, ctx, op, hooks);
        return next.state === 'reverting' ? await selfFailed(d, ctx, op, p, next.error?.detail ?? 'migration') : next;
      }
      default:
        return await selfVerifying(d, ctx, op, p, hooks);
    }
  } catch (error) {
    // A lost database or lock: the op as it was (the machine). Anything else is a failure of the update.
    if (transient(error)) throw error;
    ctx.log.error('update: a step of the schemaHold update failed past its point of no return', { opId: op.opId, state: op.state, ...errorFields(error) });
    return selfFailed(d, ctx, op, p, 'start');
  }
}

/** The longest error detail op.json holds (files.ts). */
const DETAIL_MAX = 2000;

/**
 * A `self` update's error before its point of no return, its detail followed by the instruction of §9.8 row 3 (the
 * database is untouched: no backup to restore), cut to op.json's bound.
 */
function withSelfInstruction(op: OpFile, error: NonNullable<OpFile['error']> & { reason?: string }): NonNullable<OpFile['error']> & { reason?: string } {
  const target = op.params['target'];
  const from = op.params['from'];
  if (op.params['source'] !== 'self' || typeof target !== 'string' || !isSemver(target)) return error;
  const instruction = schemaHoldInstruction({ version: target, from: typeof from === 'string' && isSemver(from) ? from : null, backupId: null });
  const text = error.detail === undefined ? instruction : `${error.detail} — ${instruction}`;
  return { ...error, detail: text.length <= DETAIL_MAX ? text : instruction.slice(0, DETAIL_MAX) };
}

/** The states before the point of no return, where a failure ends the op `aborted`. */
const BEFORE_PONR: ReadonlySet<string> = new Set(['checking', 'downloading', 'verified', 'frozen', 'backed_up', 'staged']);

/** The states past the point of no return in which the op waits for, or is moved by, the boot of its target. */
const TARGET_BOOT_STATES: ReadonlySet<string> = new Set(['switched', 'booting', 'migrating', 'verifying']);

async function stepUpdate(d: UpdateKindDeps, ctx: OpStepContext, op: OpFile): Promise<OpFile> {
  let p: UpdateParams;
  try {
    p = parseUpdateParams(op.params);
  } catch (error) {
    if (op.pointOfNoReturn || !BEFORE_PONR.has(op.state)) throw error;
    return abort(d, ctx, op, error);
  }
  try {
    if (!op.pointOfNoReturn && BEFORE_PONR.has(op.state)) {
      // finishUpdate committed, the ended op.json was not written (P7): the op ends as recorded.
      const logged = await readReleaseLog((await dbOf(ctx)).db, op.opId);
      if (logged !== null && RELEASE_LOG_FINAL.has(logged.status)) {
        const recorded = logged.detail?.['error'];
        const error =
          typeof recorded === 'object' && recorded !== null && typeof (recorded as { code?: unknown }).code === 'string'
            ? (recorded as NonNullable<OpFile['error']>)
            : op.error;
        await cleanup(ctx, op);
        return { ...op, state: 'aborted', error };
      }
    }
    switch (op.state) {
      case 'checking':
        return await checking(d, ctx, op, p);
      case 'downloading':
        return await downloading(d, ctx, op, p);
      case 'verified':
        await logRunning(ctx, op, p); // B7: an op begun here
        return { ...op, state: 'frozen', version: p.target, progress: PROGRESS.exportFrom };
      case 'frozen':
        return await frozen(d, ctx, op, p);
      case 'backed_up':
        return await backedUp(d, ctx, op, p);
      case 'staged':
        // The point of no return: op.json is written first, then `switched` writes current.json (D1d-15).
        return { ...op, state: 'switched', pointOfNoReturn: true, progress: PROGRESS.switched };
      case 'switched':
        return await switched(d, ctx, op, p);
      case 'booting':
      case 'migrating':
      case 'verifying':
        return await booting(d, ctx, op, p);
      case 'reverting':
        return await revertingStep(d, ctx, op, p);
      case 'restoring':
        return await restoringStep(d, ctx, op, p);
      default:
        return op;
    }
  } catch (error) {
    if (transient(error) || op.pointOfNoReturn || !BEFORE_PONR.has(op.state)) throw error;
    return abort(d, ctx, op, error);
  }
}

/**
 * The `update` op kind (see the top of this file): initial state `checking`, entry state `verified` (§9.8's bundled
 * and self updates), maintenance `update` from `verified`, freeze. `deps` is read at every step.
 */
export function updateKind(deps: () => UpdateKindDeps): OpKindHandler {
  return {
    kind: 'update',
    initialState: 'checking',
    entryStates: ['verified'],
    maintenance: 'update',
    maintenanceFrom: 'verified',
    freeze: true,
    // Review C08 (§9.3; Review Focus 1 and 4): past the point of no return, `switched`..`verifying` wait for the boot of
    // the target, which nothing steps in between (no request since `switched`, a holder killed mid-migration, a host
    // down): a heartbeat older than 15 min there is no stall. §9.3's own rules revert the target (≥ 3 failed boots, an
    // explicit error, a migration without progress in a live holder), and a release other than the target heals the op
    // (S3); a needs_attention from the stall rule would make app.js revert a target that never failed (B8).
    stalls: (op) => !(op.pointOfNoReturn && TARGET_BOOT_STATES.has(op.state)),
    step: (ctx, op) => stepUpdate(deps(), ctx, op),
    async beforeMaintenance() {
      // §9.4 "ditolak sebelum freeze" (1D-23): a snapshot backup that began during the download ends the op.
      if (await deps().snapshotBackupRunning()) {
        throw new DomainError('OPS_BLOCKED_BY_BACKUP', {
          detail:
            'Backup snapshot sedang berjalan, jadi pembaruan dibatalkan sebelum pemeliharaan; mulai lagi setelah backup selesai / ' +
            'A snapshot backup is running, so the update was cancelled before maintenance; start it again once the backup has finished',
        });
      }
    },
    refreeze(op) {
      // S5: the work done under the broken freeze is done again; the backup it made is abandoned by the next `frozen`.
      if (op.state !== 'frozen' && op.state !== 'backed_up' && op.state !== 'staged') return op;
      const params: Record<string, unknown> = { ...op.params, needsBackup: null };
      delete params['export'];
      delete params['auditHead'];
      if (op.backupId !== null) params['abandonBackupId'] = op.backupId;
      return { ...op, state: 'verified', backupId: null, params, progress: PROGRESS.verified };
    },
    async cancel(ctx, op) {
      const d = deps();
      await cleanup(ctx, op);
      try {
        await finishUpdate(ctx, op, 'aborted', d);
      } catch (error) {
        if (transient(error)) throw error;
        ctx.log.error('update: the end of the cancelled op could not be recorded', { opId: op.opId, ...errorFields(error) });
      }
    },
  };
}
