import { migrationsUpTo, runMigrations, type AltisMigration, type DbHandle, type Dialect } from '@altis/db';
import { dataPath, ensureHeadroom, removeFile, removeTree, type DataPath } from '@altis/platform';
import { DomainError, isDomainError, isUlid } from '@altis/shared';
import { z } from 'zod';
import { columnKey } from '../archive/kdf.js';
import { backupTables } from '../backup/canonical.js';
import { abandonBackup, auditHeadOf, backupHeadroomBytes, insertBackupRow, schemaVersionOf } from '../backup/create-job.js';
import { createExporter, exportCheckpointSchema, type ExportCheckpoint } from '../backup/exporter.js';
import { unknownManifestFields, unverifiedManifestFields, verifyManifestHmac, type BackupManifest } from '../backup/manifest.js';
import { errorFields } from '../context.js';
import type { KeyringEntry } from '../crypto/secret-box.js';
import { isDiskQuota } from '../files/disk-quota.js';
import type { OpActor, OpFile } from '../ops/files.js';
import { OPS_STALL_MS, type OpStepContext } from '../ops/machine.js';
import {
  FINAL_STEPS,
  bumpEpochOnce,
  clearVolatile,
  finalCheckpointSchema,
  finishPreRestore,
  historyTables,
  importHistoryTable,
  newFinal,
  recordOutcome,
  restoredLists,
  type FinalCheckpoint,
  type RestoreOutcome,
} from './finalize.js';
import { restoreFilesStep } from './files.js';
import { KEPT_TABLES, newPreserve, preserveCheckpointSchema, preserveStep, restoreKeptStep } from './keep.js';
import { loadCheckpointSchema, loadStep, newLoad } from './load.js';
import {
  assertNoEditionTables,
  conflictsError,
  newPrepass,
  prepassCheckpointSchema,
  prepassStep,
  writeRestoreReport,
  type PrepassCheckpoint,
} from './prepass.js';
import { secretsBranch, type SecretsBranch } from './secrets.js';
import { kekOf, openRestoreSource, type RestoreSource } from './source.js';

// The steps of a restore (spec §9.10; decisions C16, C17, C18, C25, C44; preflight S21, 1D-08; rulings R1c-3, R1c-6,
// R1c-9, R1d-3; plan Tasks 22 (1c) and 12 (1d)), shared by two callers:
//
// - the `restore` op kind (kind.ts), whose op is the restore: its states are the op's states, its checkpoints the op's
//   params, and it owns `pre_restore` and `failed_restoring_pre` (the safety backup and the way back to it);
// - the restore runner ({@link createRestoreRunner}), which another kind steps inside its own op: the update's
//   automatic revert in the "terlalu lama" mode of spec §9.7 (Task 25), sub-state `restoring` of an `update` op. The
//   runner keeps the whole restore in one fixed-size {@link RestoreRun} (`op.params.restore` of that op): its sub-state,
//   the params it was begun with, the checkpoints, and its error.
//
// The states (see kind.ts for each one's work): verifying → prechecked → [pre_restore, the kind's own] → preserving →
// (point of no return) loading → migrating → finalizing → done. The runner never makes a `pre_restore` backup (its
// caller begins it with `skipPreRestore`: spec §9.7 "tanpa backup pre_restore"), so it has nothing to go back to.
//
// What the update revert needs (spec §9.7 `restoring`: "tanpa kunci baru; tanpa backup pre_restore; rahasia lewat
// cabang (a); targetSchema = backup (tanpa migrasi); menghapus tabel berdasarkan schema_tables di DB"):
//
// - `targetSchema: 'backup'` (C44 completed): `loading` applies migrationsUpTo(deps.migrations, the manifest's
//   schemaVersion) and nothing after it; `migrating` is skipped; finalizing runs no migration and puts the kept rows
//   back with the columns the backup's schema has. The database ends at the backup's schema and `min_code_version`.
// - `secrets: 'a'`: only branch (a) is accepted (this installation's HMAC, `keyring` secrets, every kid present), so
//   every sealed value is copied as it is and no key is made; anything else ends the restore `failed` with
//   BACKUP_INVALID `signature` before its point of no return. `'auto'` (the default) takes the branch the backup allows.
// - `dropBy: 'schema_tables'`: the drop of `loading` removes every table the database's `schema_tables` lists (a later
//   release's tables included, whatever this code's registry knows) and then `schema_tables` itself
//   (dropRegisteredTables, spec §6.2: "Restore menghapus tabel berdasarkan daftar ini, bukan registri kode"). 1c's
//   drop already reads that list, so `'registry'` (the 1c default, the name for "the database's registry") runs the
//   same drop; the field records what the caller relies on.
//
// Failures. Before the point of no return the database is as it was: the restore ends `failed` (tmp/<opId>/ and the
// kept copies removed, `backup.restore` audited with outcome `failed`). Past it, the kind goes back to its
// `pre_restore` backup (`failed_restoring_pre`), while the runner, which has none, throws the error: its caller's
// machine moves its op to `needs_attention` (maintenance kept), and a resumed op steps the runner again from its last
// checkpoint, the target's kept rows still in ops/<opId>/keep/ (a terminal failure there would lose them: the live
// tables are gone). On SQLite, a failure before the work file was swapped into place leaves the live file untouched, so
// it ends `failed` like one before the point of no return (Task 25, R1c-11).
//
// A lost connection or a busy lock leaves the restore for the next step in both: it is thrown on, unchanged.

/** What `begin('restore', …)` is given (1c Task 29's route and CLI), and what the runner is begun with. */
export type RestoreParams = {
  backupId: string;
  source: 'server' | 'archive';
  withoutFiles: boolean;
  confirmed: boolean;
  /**
   * `'latest'`: the archive's schema, then every migration of the code (C44: every boot migrates to the latest schema).
   * `'backup'` (1d, the update revert): the archive's schema and nothing after it.
   */
  targetSchema: 'latest' | 'backup';
  skipPreRestore?: boolean;
};

/**
 * The SQLite side of a restore (decision C17), implemented by Task 25: the load runs on `db/<opId>/restore.sqlite` and
 * finalizing swaps it into place. `swap` answers `'waiting'` while the owner processes have not released the live file
 * (the step returns unchanged and is retried, S19). The kind closes its work handles before `swap` and opens a new one
 * with `openWork` for the steps after it, so `openWork(opId)` must open the live file once the swap has happened (the
 * work file is the live file then).
 */
export interface SqliteSwap {
  workPath(opId: string): DataPath;
  openWork(opId: string): Promise<DbHandle>;
  swap(o: { opId: string; closeOwn(): Promise<void>; reopenOwn(): Promise<void>; wait?: SqliteSwapWait }): Promise<'swapped' | 'waiting'>;
  /** `'waiting'` (with `o.wait`'s bound) while the owner processes have not let go of the live file: tried again later. */
  renameBack(opId: string, o?: { wait?: SqliteSwapWait }): Promise<void | 'waiting'>;
  /**
   * Whether the live file was moved aside for op `opId` (`db/<opId>/pre-restore.sqlite` exists), whatever the op's
   * checkpoint says: a failure from then on goes back through `renameBack` (R1c-11). Without it the checkpoint decides.
   */
  swapped?(opId: string): Promise<boolean>;
}

/**
 * How long one step of a SQLite swap (or rename back) waits for the owner processes to let go of the live file (Task 25,
 * R1c-11, P9): until `until`, the step's deadline. The whole wait has a budget (`releaseWaitMs`, 30 s) counted from its
 * first step, `since`, which the kind keeps in op params; once it is spent, an owner that still looks alive no longer
 * counts and the database file itself decides (its `-wal`/`-shm`).
 */
export interface SqliteSwapWait {
  /** The step's clock (`ctx.now`). */
  now(): number;
  /** On `now()`'s clock: this step waits no longer. */
  until: number;
  /** On `now()`'s clock: when the wait began on an earlier step of the op, or null for none yet. */
  since: number | null;
  /** The wait began (or began again, the clock having gone back) at `at`: the kind records it in op params. */
  began(at: number): void;
}

/** What the kind and the runner need from the installation. */
export interface RestoreKindDeps {
  /** DATA_DIR (the machine's: every file goes through `ctx.dataDir`, which must be the same). */
  dataDir: string;
  /** The running release (the `pre_restore` backup's manifest, the migrations' version check). */
  appVersion: string;
  /** Every migration of the code (releaseMigrations()). */
  migrations: Readonly<Record<string, AltisMigration>>;
  /** config.json's session key: the manifest HMAC (this installation's backups, the `pre_restore` backup). */
  sessionKey(): Uint8Array;
  keyring(): readonly KeyringEntry[];
  /** config.json's `install.id`: the `pre_restore` backup's manifest. */
  installId: string;
  /**
   * Asks the bootloader for a restart (P14) once the restore kind's op is done or went back to `pre_restore`. The
   * runner never asks: its caller does, once its own op has recorded the end (Task 25: `finishUpdate('restored')`, then
   * `requestRestart('restore')`).
   */
  requestRestart(reason: string): Promise<void>;
  /** Task 25's swap on SQLite; null elsewhere. */
  sqliteSwap: SqliteSwap | null;
  /**
   * Task 25: what this process itself holds on the live SQLite file (its server or CLI handle, the op's dedicated
   * connections), closed before the swap and before a rename back, reopened after the swap. Without it nothing is
   * closed, and a swap waits for as long as such a handle stays open.
   */
  sqliteOwn?: { close(): Promise<void>; reopen(): Promise<void> };
}

/** The runner's sub-states (spec §9.4's restore states without the kind's own `pre_restore` and `failed_restoring_pre`). */
export const RESTORE_SUB_STATES = Object.freeze(['verifying', 'prechecked', 'preserving', 'loading', 'migrating', 'finalizing', 'done', 'failed'] as const);
export type RestoreSubState = (typeof RESTORE_SUB_STATES)[number];

/** What the runner is begun with (see the top of this file for `secrets` and `dropBy`). */
export interface RestoreRunParams extends RestoreParams {
  /** `'a'`: branch (a) only; `'auto'` (absent): the branch the backup allows. */
  secrets?: 'auto' | 'a';
  /** Both drop every table `schema_tables` lists, then `schema_tables` (see the top of this file). */
  dropBy?: 'registry' | 'schema_tables';
}

/**
 * A restore stepped by the runner, as its caller keeps it (`op.params.restore` of an `update` op): fixed size (every
 * checkpoint is bounded, R1c-6). It is part of the frozen `opSchema 1` contract, so a release other than the one that
 * wrote it may step it (preflight S21, 1D-08, decision D1d-44): it is read loosely, and fields this release does not
 * know (at the top, in `params`, in `checkpoint`) are written back as they were.
 */
export type RestoreRun = {
  state: RestoreSubState;
  params: RestoreRunParams;
  /** The restore's checkpoints (what the kind keeps in its op params besides the begin params). */
  checkpoint: Record<string, unknown>;
  /**
   * A registered error code, an authored detail (≤ 2000 characters) and the error's registered `reason`
   * (BACKUP_INVALID `signature`, ...); null unless the restore failed.
   */
  error: { code: string; detail?: string; reason?: string } | null;
  /** 0 to 100 (additive: absent before the first step). */
  progress?: number;
};

/** A step of the load or of finalizing stops starting work this long before its deadline. */
const STEP_MARGIN_MS = 1000;
/**
 * The gunzip bound of a part is min(bytes × 1.1, headroom) (spec §7.5): the restore streams parts into the database,
 * not onto the disk, so the manifest's bytes are the bound that matters; the extraction proves its own headroom.
 */
const SOURCE_HEADROOM_BYTES = Number.MAX_SAFE_INTEGER;
/** Rows per transaction when the kept rows go back (they come from our own files). */
const KEPT_TX_ROWS = 5000;
/** The longest error detail op.json (and a RestoreRun) holds. */
const DETAIL_MAX = 2000;

const ulid = z.string().refine(isUlid, 'not a ULID');
const head = z.strictObject({ seq: z.number().int().min(0).max(Number.MAX_SAFE_INTEGER), hash: z.string().min(1).max(128) });
const errorSchema = z.looseObject({
  code: z.string().min(1).max(64),
  detail: z.string().max(DETAIL_MAX).optional(),
  reason: z.string().max(64).optional(),
});

/** The begin params of a restore (the kind's op params, the runner's `params`). */
const beginShape = {
  backupId: ulid,
  source: z.enum(['server', 'archive']),
  withoutFiles: z.boolean(),
  confirmed: z.boolean(),
  targetSchema: z.enum(['latest', 'backup']),
  skipPreRestore: z.boolean().optional(),
  secrets: z.enum(['auto', 'a']).optional(),
  dropBy: z.enum(['registry', 'schema_tables']).optional(),
};

/** The kind's op params (and the runner's `params` and `checkpoint` together): the begin params, then the checkpoints. */
const paramsSchema = z.looseObject({
  ...beginShape,
  // verifying
  archive: z.strictObject({ auditHead: head, installId: z.string().min(1).max(64), schemaVersion: z.string().max(191) }).optional(),
  hmacValid: z.boolean().optional(),
  secretsBranch: z.enum(['a', 'b', 'c']).optional(),
  archiveSha256: z.string().max(64).nullable().optional(),
  verify: z.strictObject({ checkpoint: z.number().int().min(0).max(Number.MAX_SAFE_INTEGER), done: z.boolean() }).optional(),
  // prechecked
  check: prepassCheckpointSchema.optional(),
  targetInstallId: z.string().max(64).nullable().optional(),
  targetSchemaVersion: z.string().max(191).optional(),
  // pre_restore
  preRestoreBackupId: ulid.optional(),
  pre: exportCheckpointSchema.nullable().optional(),
  preAuditHead: head.optional(),
  // preserving
  keep: preserveCheckpointSchema.optional(),
  // loading, finalizing
  load: loadCheckpointSchema.optional(),
  final: finalCheckpointSchema.optional(),
  // failed_restoring_pre
  failure: errorSchema.optional(),
  diskLow: z.boolean().optional(),
  replay: z
    .strictObject({
      phase: z.enum(['load', 'migrate', 'final', 'rename_back']),
      load: loadCheckpointSchema,
      final: finalCheckpointSchema,
    })
    .optional(),
});

/** The kind's op params, parsed (unknown keys kept). */
export type RestoreStepParams = z.infer<typeof paramsSchema>;
type Params = RestoreStepParams;

/** Parses op params of a restore (the kind's), or the runner's params and checkpoint merged. */
export function parseRestoreParams(params: unknown): ReturnType<typeof paramsSchema.safeParse> {
  return paramsSchema.safeParse(params);
}

/** `text` cut to at most `max` UTF-16 code units, never between the two halves of a surrogate pair. */
function cut(text: string, max: number): string {
  if (text.length <= max) return text;
  const last = text.charCodeAt(max - 1);
  return text.slice(0, last >= 0xd800 && last <= 0xdbff ? max - 1 : max);
}

/**
 * What the machine records of a failure: a code, and the detail of a 4xx DomainError (authored text, at most 2000
 * characters); with `o.reason` (the runner's), its `meta.reason` too when it is a short word. A full disk is
 * `DISK_QUOTA` however it was reported: the file system's ENOSPC/EDQUOT, or the database's own words for it while the
 * restore writes its tables (SQLite SQLITE_FULL, MySQL/MariaDB 1114/1021, PostgreSQL 53100: files/disk-quota.ts).
 */
export function restoreErrorOf(error: unknown, o: { reason?: boolean } = {}): { code: string; detail?: string; reason?: string } {
  if (isDomainError(error)) {
    const out: { code: string; detail?: string; reason?: string } = { code: error.code };
    if (error.status < 500 && error.detail !== undefined) out.detail = cut(error.detail, DETAIL_MAX);
    const reason = error.meta?.['reason'];
    if (o.reason === true && typeof reason === 'string' && /^[a-z][a-z0-9_]{0,63}$/.test(reason)) out.reason = reason;
    return out;
  }
  if (isDiskQuota(error)) return { code: 'DISK_QUOTA' };
  return { code: 'INTERNAL' };
}

/** Errors after which the same step may succeed later: the machine leaves the op as it was. */
export function transientRestoreError(error: unknown): boolean {
  if (!isDomainError(error)) return false;
  if (error.code === 'DB_UNAVAILABLE') return true;
  const reason = error.meta?.['reason'];
  return error.code === 'STATE_CORRUPT' && (reason === 'lock_timeout' || reason === 'lock_lost');
}

function testBuild(): boolean {
  return typeof __BUILD_PROFILE__ !== 'undefined' && __BUILD_PROFILE__ === 'test';
}

function confirmRequired(): DomainError {
  return new DomainError('BACKUP_CONFIRM_REQUIRED', {
    detail:
      'Backup ini berasal dari instalasi lain; konfirmasi diperlukan sebelum datanya menggantikan data ini / ' +
      'This backup comes from another installation; it needs a confirmation before its data replaces this data',
  });
}

/** `secrets: 'a'` and a backup whose secrets cannot be copied as they are (spec §9.7 "rahasia lewat cabang (a)"). */
function notBranchA(branch: SecretsBranch): DomainError {
  return new DomainError('BACKUP_INVALID', {
    detail:
      `Rahasia backup ini tidak dapat disalin apa adanya dengan kunci instalasi ini (cabang ${branch}, bukan a) / ` +
      `The secrets of this backup cannot be copied as they are with this installation's keys (branch ${branch}, not a)`,
    meta: { reason: 'signature', branch },
  });
}

/** The tables of a manifest checked against the code: the backup tables of its schema version, their columns. */
function checkManifestTables(m: BackupManifest): void {
  const known = new Map<string, string>(backupTables().map((t) => [t.table, t.cls]));
  for (const [table, t] of Object.entries(m.tables)) {
    const cls = known.get(table);
    if (cls === undefined || cls !== t.class) {
      throw new DomainError('BACKUP_INVALID', {
        detail: `Tabel ${table} tidak dikenal versi ini / The table ${table} is not known to this version`,
        meta: { reason: 'schema' },
      });
    }
  }
}

/** The op with `patch` merged into its params. */
function withParams(op: OpFile, patch: Partial<Params>): OpFile {
  return { ...op, params: { ...op.params, ...patch } };
}

/** Progress of each state (0 to 100), and the share of the state's own progress. */
const PROGRESS: Readonly<Record<string, [number, number]>> = {
  verifying: [0, 5],
  prechecked: [5, 10],
  pre_restore: [15, 15],
  preserving: [30, 5],
  loading: [35, 45],
  migrating: [80, 5],
  finalizing: [85, 15],
  failed_restoring_pre: [0, 100],
};

function progressAt(state: string, share: number): number {
  const [base, width] = PROGRESS[state] ?? [0, 0];
  return Math.min(100, Math.max(0, Math.floor(base + (width * Math.max(0, Math.min(100, share))) / 100)));
}

/** Who steps a restore: the restore kind (its op is the restore) or the runner (inside another kind's op). */
export type RestoreMode = 'kind' | 'runner';

/** The steps shared by the kind and the runner (see the top of this file). */
export interface RestoreEngine {
  /**
   * One step of the restore `op` (a restore op, or the runner's stand-in for one): its next version. Transient errors
   * are thrown on (the op unchanged); in `runner` mode so is a failure past the point of no return (see the top of this
   * file).
   */
  step(ctx: OpStepContext, op: OpFile): Promise<OpFile>;
  /** The kind's `cancel` (before the point of no return). */
  cancel(ctx: OpStepContext, op: OpFile): Promise<void>;
}

/**
 * The restore's steps on `deps`, for the kind or the runner (`mode`; see the top of this file).
 *
 * @throws TypeError when `deps` are not usable
 */
export function createRestoreEngine(deps: RestoreKindDeps, mode: RestoreMode): RestoreEngine {
  if (typeof deps?.requestRestart !== 'function' || typeof deps.sessionKey !== 'function' || typeof deps.keyring !== 'function') {
    throw new TypeError('restoreKind: deps need sessionKey(), keyring() and requestRestart()');
  }
  /** Task 25's work handles, by op (closed when the op ends). */
  const works = new Map<string, Promise<DbHandle>>();

  /** The live database: this process's dedicated connection of the op (P17), outside the pool. */
  const live = (ctx: OpStepContext): Promise<DbHandle> => ctx.connectDedicated();

  /** The dialect of the target. */
  async function dialectOf(ctx: OpStepContext): Promise<Dialect> {
    return (ctx.db() ?? (await live(ctx))).dialect;
  }

  /**
   * Task 25 (R1c-11, P9): the bound of this step's wait for the owner processes of the live SQLite file: the step's
   * deadline less its margin, the budget counted from `since` (op params), `began` recording a new start (whole ms).
   */
  function ownersWait(ctx: OpStepContext, since: number | null, began: (at: number) => void): SqliteSwapWait {
    return { now: () => ctx.now(), until: ctx.deadline - STEP_MARGIN_MS, since, began: (at) => began(Math.floor(at)) };
  }

  /** Whether this restore swaps a SQLite work file into place (Task 25). */
  async function swapping(ctx: OpStepContext): Promise<boolean> {
    return deps.sqliteSwap !== null && (await dialectOf(ctx)) === 'sqlite';
  }

  /** The handle the load and finalizing write through: Task 25's work file on SQLite, else the dedicated connection. */
  async function workOf(ctx: OpStepContext, opId: string): Promise<DbHandle> {
    if (!(await swapping(ctx))) return live(ctx);
    let opened = works.get(opId);
    if (opened === undefined) {
      opened = deps.sqliteSwap!.openWork(opId);
      works.set(opId, opened);
      opened.catch(() => works.delete(opId));
    }
    return opened;
  }

  async function closeWorks(): Promise<void> {
    for (const [opId, opened] of [...works]) {
      works.delete(opId);
      try {
        await (await opened).close();
      } catch {
        // never opened, or gone
      }
    }
  }

  function sourceOf(ctx: OpStepContext, op: OpFile, p: Params, o: { pre?: boolean } = {}): Promise<RestoreSource> {
    if (o.pre === true) {
      return openRestoreSource({
        dataDir: ctx.dataDir,
        backupId: p.preRestoreBackupId!,
        source: 'server',
        kek: null,
        opId: op.opId,
        headroomBytes: SOURCE_HEADROOM_BYTES,
        clock: ctx.now,
      });
    }
    return openRestoreSource({
      dataDir: ctx.dataDir,
      backupId: p.backupId,
      source: p.source,
      kek: kekOf(ctx.secret()),
      opId: op.opId,
      headroomBytes: SOURCE_HEADROOM_BYTES,
      extracted: p.source === 'archive' && p.verify?.done === true,
      clock: ctx.now,
    });
  }

  async function withSource<T>(ctx: OpStepContext, op: OpFile, p: Params, fn: (s: RestoreSource) => Promise<T>, o: { pre?: boolean } = {}): Promise<T> {
    const source = await sourceOf(ctx, op, p, o);
    try {
      return await fn(source);
    } finally {
      await source.close();
    }
  }

  /** `tmp/<opId>/`: the extracted archive. */
  async function cleanTmp(ctx: OpStepContext, opId: string): Promise<void> {
    try {
      await removeTree(dataPath(ctx.dataDir, 'tmp', opId));
    } catch (error) {
      ctx.log.warn('restore: tmp/<opId> could not be removed', { opId, ...errorFields(error) });
    }
  }

  /**
   * `ops/<opId>/keep/`: the copies `preserving` made of the live history tables. Only a restore that goes on reads
   * them; one that fails or is cancelled before its point of no return never touched the live database, so they go
   * at once (P21: after a full disk the partial files are removed, or the retry fills the disk again).
   */
  async function cleanKeep(ctx: OpStepContext, opId: string): Promise<void> {
    try {
      await removeTree(dataPath(ctx.dataDir, 'ops', opId, 'keep'));
    } catch (error) {
      ctx.log.warn('restore: ops/<opId>/keep could not be removed', { opId, ...errorFields(error) });
    }
  }

  // -------------------------------------------------------------------------------------------------------------
  // The states before the point of no return

  async function verifying(ctx: OpStepContext, op: OpFile, p: Params): Promise<OpFile> {
    const dialect = await dialectOf(ctx);
    if (dialect === 'sqlite' && deps.sqliteSwap === null && !testBuild()) {
      // A test build restores SQLite in place on the dedicated connection; a release needs Task 25's swap.
      throw new TypeError('restore: a SQLite database is restored through the work file swap (sqliteSwap)');
    }
    return withSource(ctx, op, p, async (source) => {
      const m = source.manifest;
      let next = op;
      if (p.verify === undefined) {
        const hmacValid = verifyManifestHmac(deps.sessionKey(), m);
        const archive = { auditHead: m.auditHead, installId: m.installId, schemaVersion: m.schemaVersion };
        next = withParams(next, { archive, hmacValid });
        const failed = { ...p, archive, hmacValid };
        // A later release's fields are dropped only under this installation's HMAC, or under the passphrase of an
        // encrypted archive, whose manifest only its holder could have written (1D-08, D1d-44, ruling R1d-3).
        const unknown = unknownManifestFields(m);
        if (!hmacValid && source.dek === null && unknown.length > 0) return failBefore(ctx, next, failed, unverifiedManifestFields(unknown));
        if (!hmacValid && !p.confirmed) return failBefore(ctx, next, failed, confirmRequired());
        migrationsUpTo(deps.migrations, m.schemaVersion); // BACKUP_SCHEMA_TOO_NEW for a schema this code does not know
        checkManifestTables(m);
        const kids = new Set(ctx.keyring.map((k) => k.kid));
        const branch = secretsBranch({
          hmacValid,
          kidsPresent: m.kids.every((kid) => kids.has(kid)),
          secrets: m.secrets,
          dekOpened: source.dek !== null,
        });
        if (p.secrets === 'a' && branch !== 'a') return failBefore(ctx, next, failed, notBranchA(branch));
        const row = await (await live(ctx)).db.selectFrom('backups').select(['sha256', 'status']).where('id', '=', p.backupId).executeTakeFirst();
        if (row === undefined) throw new DomainError('NOT_FOUND', { detail: `Backup ${p.backupId} tidak ada / Backup ${p.backupId} does not exist` });
        next = withParams(next, { secretsBranch: branch, archiveSha256: row.sha256, verify: { checkpoint: 0, done: false } });
      }
      const at = (next.params['verify'] as { checkpoint: number }).checkpoint;
      const r = await source.verify({ deadline: ctx.deadline - STEP_MARGIN_MS, checkpoint: at });
      next = withParams(next, { verify: { checkpoint: r.checkpoint, done: r.done } });
      if (!r.done) return { ...next, progress: progressAt('verifying', 50) };
      return { ...withParams(next, { check: newPrepass() }), state: 'prechecked', progress: progressAt('prechecked', 0) };
    });
  }

  async function prechecked(ctx: OpStepContext, op: OpFile, p: Params): Promise<OpFile> {
    const h = await live(ctx);
    // ---- Komunitas K1 (edition lane): tables of the other migration lane this code does not ship are never dropped ----
    await assertNoEditionTables(h.db);
    const target = await dialectOf(ctx);
    return withSource(ctx, op, p, async (source) => {
      const r = await prepassStep(source, p.check ?? newPrepass(), {
        dialect: target,
        deadline: ctx.deadline - STEP_MARGIN_MS,
        clock: ctx.now,
        external: p.hmacValid !== true,
        withoutFiles: p.withoutFiles,
      });
      if (!r.done) return { ...withParams(op, { check: r.checkpoint }), progress: progressAt('prechecked', 50) };
      const conflicts = r.checkpoint.conflicts;
      ctx.lock.assertHeld();
      await writeRestoreReport(ctx.dataDir, op.opId, {
        ok: conflicts.length === 0,
        conflicts,
        checklist: { secrets: [], reenroll: [] },
        files: { missing: [] },
      });
      if (conflicts.length > 0) throw conflictsError(conflicts.length);
      // Read before anything is dropped (C16): the target keeps its installation id.
      const meta = await h.db.selectFrom('schema_meta').select('install_id').where('id', '=', 1).executeTakeFirst();
      const done: PrepassCheckpoint = { ...r.checkpoint, trimmed: [], seen: [] };
      const checked = withParams(op, { check: done, targetInstallId: meta?.install_id ?? null, targetSchemaVersion: await schemaVersionOf(h.db) });
      // The runner makes no pre_restore backup (begun with skipPreRestore): straight to preserving.
      if (mode === 'runner') return { ...withParams(checked, { keep: newPreserve() }), state: 'preserving', progress: progressAt('preserving', 0) };
      return { ...checked, state: 'pre_restore', progress: progressAt('pre_restore', 0) };
    });
  }

  async function preRestore(ctx: OpStepContext, op: OpFile, p: Params): Promise<OpFile> {
    if (p.skipPreRestore === true) return { ...withParams(op, { keep: newPreserve() }), state: 'preserving', progress: progressAt('preserving', 0) };
    const h = await live(ctx);
    const backupId = op.opId; // a step run again finds its own row and folder
    if (p.preRestoreBackupId === undefined) {
      await ensureHeadroom(ctx.dataDir, await backupHeadroomBytes(h.db));
      await insertBackupRow(h, {
        id: backupId,
        kind: 'pre_restore',
        consistency: 'frozen',
        dialect: h.dialect,
        schemaVersion: await schemaVersionOf(h.db),
        appVersion: deps.appVersion,
        now: ctx.now(),
      });
      return { ...withParams(op, { preRestoreBackupId: backupId, pre: null, preAuditHead: await auditHeadOf(h.db) }), backupId };
    }
    const exporter = createExporter({
      read: h.db,
      dialect: h.dialect,
      dataDir: ctx.dataDir,
      backupId,
      kind: 'pre_restore',
      includeFiles: false,
      consistency: 'frozen',
      appVersion: deps.appVersion,
      schemaVersion: p.targetSchemaVersion ?? (await schemaVersionOf(h.db)),
      installId: deps.installId,
      sessionKey: deps.sessionKey(),
      kids: deps.keyring().map((k) => k.kid),
      auditHead: p.preAuditHead ?? (await auditHeadOf(h.db)),
      clock: ctx.now,
    });
    const r = await exporter.step((p.pre ?? null) as ExportCheckpoint | null, { deadline: ctx.deadline });
    ctx.publish({ progress: progressAt('pre_restore', r.progress) });
    if (!r.done) return { ...withParams(op, { pre: r.checkpoint }), progress: progressAt('pre_restore', r.progress) };
    ctx.lock.assertHeld();
    await finishPreRestore(h, ctx.dataDir, backupId);
    return { ...withParams(op, { pre: r.checkpoint, keep: newPreserve() }), state: 'preserving', progress: progressAt('preserving', 0) };
  }

  async function preserving(ctx: OpStepContext, op: OpFile, p: Params): Promise<OpFile> {
    const h = await live(ctx);
    const schemaVersion = p.targetSchemaVersion ?? (await schemaVersionOf(h.db));
    const r = await preserveStep(
      h,
      { dataDir: ctx.dataDir, opId: op.opId, schemaVersion, stopAt: ctx.deadline - STEP_MARGIN_MS, clock: ctx.now, lock: ctx.lock },
      p.keep ?? newPreserve(),
    );
    const table = r.checkpoint.table;
    if (!r.done) return { ...withParams(op, { keep: r.checkpoint }), progress: progressAt('preserving', (100 * table) / KEPT_TABLES.length) };
    // The point of no return, written to op.json together with the move to `loading`: nothing is dropped before it.
    return {
      ...withParams(op, { keep: r.checkpoint, load: newLoad() }),
      state: 'loading',
      pointOfNoReturn: true,
      progress: progressAt('loading', 0),
    };
  }

  // -------------------------------------------------------------------------------------------------------------
  // Past the point of no return

  async function loading(ctx: OpStepContext, op: OpFile, p: Params, o: { replay: boolean }): Promise<{ op: OpFile; done: boolean }> {
    const work = await workOf(ctx, op.opId);
    const cp = o.replay ? p.replay!.load : (p.load ?? newLoad());
    return withSource(
      ctx,
      op,
      p,
      async (source) => {
        const branch: SecretsBranch = o.replay ? 'a' : (p.secretsBranch ?? 'c');
        const r = await loadStep(
          {
            work,
            source,
            dataDir: ctx.dataDir,
            appVersion: deps.appVersion,
            migrations: deps.migrations,
            targetInstallId: p.targetInstallId ?? null,
            secrets: { branch, keyring: ctx.keyring, columnKey: branch === 'b' && source.dek !== null ? columnKey(source.dek) : null },
            deadline: ctx.deadline,
            clock: ctx.now,
            log: ctx.log,
            lock: ctx.lock,
            replay: o.replay,
          },
          cp,
        );
        if (r.busy) return { op, done: false };
        const next = o.replay
          ? withParams(op, { replay: { ...p.replay!, load: r.checkpoint } })
          : withParams(op, { load: r.checkpoint });
        return { op: { ...next, progress: o.replay ? Math.floor(r.progress / 2) : progressAt('loading', r.progress) }, done: r.done };
      },
      { pre: o.replay },
    );
  }

  /** runMigrations to the code's latest schema; false while a migration lock is held elsewhere. */
  async function migrateAll(ctx: OpStepContext, opId: string): Promise<boolean> {
    const work = await workOf(ctx, opId);
    try {
      await runMigrations(work, {
        appVersion: deps.appVersion,
        dataDir: ctx.dataDir,
        migrations: deps.migrations,
        lockWaitMs: Math.max(1000, ctx.deadline - ctx.now()),
      });
    } catch (error) {
      const reason = isDomainError(error) ? error.meta?.['reason'] : undefined;
      if (isDomainError(error) && ((error.code === 'STATE_CORRUPT' && reason === 'lock_timeout') || (error.code === 'DB_UNAVAILABLE' && reason === 'busy'))) {
        return false;
      }
      throw error;
    }
    return true;
  }

  function outcomeOf(op: OpFile, p: Params, o: { outcome: 'done' | 'failed'; error?: string; notifyOutcome: boolean; diskLow: boolean; now: number }): RestoreOutcome {
    return {
      opId: op.opId,
      actor: op.actor,
      backupId: p.backupId,
      archiveSha256: p.archiveSha256 ?? null,
      archiveAuditHead: p.archive?.auditHead ?? { seq: 0, hash: '0'.repeat(64) },
      sourceInstallId: p.archive?.installId ?? '-',
      secretsBranch: p.secretsBranch ?? 'c',
      outcome: o.outcome,
      ...(o.error === undefined ? {} : { error: o.error }),
      notifyOutcome: o.notifyOutcome,
      diskLow: o.diskLow,
      now: o.now,
    };
  }

  /** The schema the restored database ends at: the backup's for `targetSchema: 'backup'`, else the code's latest. */
  function finalSchemaOf(p: Params): string | undefined {
    return p.targetSchema === 'backup' ? p.archive?.schemaVersion : undefined;
  }

  /**
   * Finalizing (finalize.ts) from `f`: sub-steps until the deadline. `replay` runs steps 1, 5, 6 and 7 only. Returns the
   * next checkpoint, or `waiting` (Task 25's swap: nothing to do yet), or `ended` once step 7 is written, or the error
   * of a step 7 that has been failing for longer than OPS_STALL_MS (`attention`: the op needs attention).
   */
  async function finalize(
    ctx: OpStepContext,
    op: OpFile,
    p: Params,
    f0: FinalCheckpoint,
    o: { replay: boolean },
  ): Promise<{ final: FinalCheckpoint; ended: boolean; waiting: boolean; attention?: { error: NonNullable<OpFile['error']>; cause: unknown } }> {
    const f = structuredClone(f0);
    const work = await workOf(ctx, op.opId);
    const stopAt = ctx.deadline - STEP_MARGIN_MS;
    const skip: ReadonlySet<string> = o.replay ? new Set(['history', 'files', 'swap']) : new Set();
    const nextStep = (): void => {
      let i = FINAL_STEPS.indexOf(f.step as (typeof FINAL_STEPS)[number]) + 1;
      while (i < FINAL_STEPS.length && skip.has(FINAL_STEPS[i]!)) i += 1;
      f.step = FINAL_STEPS[i] ?? 'done';
    };
    const sourced = <T>(fn: (s: RestoreSource) => Promise<T>): Promise<T> => withSource(ctx, op, p, fn, { pre: o.replay });
    const finalSchema = o.replay ? undefined : finalSchemaOf(p);
    let first = true;
    while (first || ctx.now() < stopAt) {
      first = false;
      switch (f.step) {
        case 'kept': {
          const r = await restoreKeptStep(
            work,
            {
              dataDir: ctx.dataDir,
              opId: op.opId,
              schemaVersion: p.targetSchemaVersion!,
              ...(finalSchema === undefined ? {} : { finalSchemaVersion: finalSchema }),
              txRows: KEPT_TX_ROWS,
              stopAt,
              clock: ctx.now,
              lock: ctx.lock,
            },
            f.kept,
          );
          f.kept = r.checkpoint;
          if (!r.done) return { final: f, ended: false, waiting: false };
          nextStep();
          break;
        }
        case 'history': {
          const ended = await sourced(async (s) => {
            if (f.history >= historyTables(s.manifest).length) return true;
            f.history = await importHistoryTable(s, ctx.dataDir, f.history);
            return false;
          });
          if (ended) nextStep();
          break;
        }
        case 'files': {
          const r = await sourced((s) =>
            restoreFilesStep(work, s, { dataDir: ctx.dataDir, withoutFiles: p.withoutFiles, stopAt, clock: ctx.now }, f.filesAfter),
          );
          f.filesAfter = r.after;
          if (!r.done) return { final: f, ended: false, waiting: false };
          nextStep();
          break;
        }
        case 'swap': {
          if (await swapping(ctx)) {
            await closeWorks(); // the work file is closed before it is swapped
            ctx.lock.assertHeld();
            // Task 25: this process's own handles on the live file (deps.sqliteOwn); other processes let go of it
            // through their ops fence.
            const own = deps.sqliteOwn;
            const r = await deps.sqliteSwap!.swap({
              opId: op.opId,
              closeOwn: async () => await own?.close(),
              reopenOwn: async () => await own?.reopen(),
              wait: ownersWait(ctx, f.releaseWaitSince ?? null, (at) => {
                f.releaseWaitSince = at;
              }),
            });
            if (r === 'waiting') return { final: f, ended: false, waiting: true }; // with when the wait began
          }
          nextStep();
          return { final: f, ended: false, waiting: false }; // recorded before anything else runs on the new file
        }
        case 'volatile':
          await clearVolatile(work, ctx.now(), finalSchema === undefined ? {} : { schemaVersion: finalSchema });
          nextStep();
          break;
        case 'epoch': {
          ctx.lock.assertHeld();
          const r = await bumpEpochOnce(ctx.dataDir, f.epochBefore);
          f.epochBefore = r.before;
          if (!r.bumped) return { final: f, ended: false, waiting: false }; // the value before goes to op.json first
          nextStep();
          break;
        }
        case 'audit': {
          // The data is restored (or back) and the epoch moved: the report, the audit entry and the notifications must
          // not send a finished restore back to pre_restore, nor be dropped (spec §9.10, C25). A failure leaves the
          // step here for the next step to try again (a lost connection as for any step); once it has failed for
          // longer than the machine's stall time, the op needs attention.
          try {
            if (!o.replay) {
              const lists = await restoredLists(work, p.secretsBranch ?? 'c');
              ctx.lock.assertHeld();
              await writeRestoreReport(ctx.dataDir, op.opId, { ok: true, conflicts: [], checklist: lists.checklist, files: { missing: lists.missing } });
            }
            await recordOutcome(
              work,
              outcomeOf(op, p, {
                outcome: o.replay ? 'failed' : 'done',
                ...(o.replay && p.failure !== undefined ? { error: p.failure.code } : {}),
                notifyOutcome: true,
                diskLow: o.replay && p.diskLow === true,
                now: ctx.now(),
              }),
            );
          } catch (error) {
            if (transientRestoreError(error)) throw error;
            const now = ctx.now();
            const since = f.auditFailedAt ?? now;
            ctx.log.error('restore: the outcome of the restore could not be recorded; it is tried again', {
              opId: op.opId,
              failingForMs: now - since,
              ...errorFields(error),
            });
            if (now - since > OPS_STALL_MS) {
              return { final: { ...f, auditFailedAt: null }, ended: false, waiting: false, attention: { error: restoreErrorOf(error), cause: error } };
            }
            return { final: { ...f, auditFailedAt: since }, ended: false, waiting: false };
          }
          Object.assign(f, { step: 'done', auditFailedAt: null });
          return { final: f, ended: true, waiting: false };
        }
        case 'done':
          return { final: f, ended: true, waiting: false };
      }
    }
    return { final: f, ended: false, waiting: false };
  }

  /** The end of a restore: its work handles and extracted archive gone, and (the kind only) the restart asked for. */
  async function restartAfter(ctx: OpStepContext, opId: string): Promise<void> {
    await closeWorks();
    await cleanTmp(ctx, opId);
    if (mode === 'runner') return; // its caller asks, once its own op records the end
    try {
      await deps.requestRestart('restore');
    } catch (error) {
      ctx.log.error('restore: requestRestart failed', { opId, ...errorFields(error) });
    }
  }

  async function mainPath(ctx: OpStepContext, op: OpFile, p: Params): Promise<OpFile> {
    if (op.state === 'loading') {
      const r = await loading(ctx, op, p, { replay: false });
      if (!r.done) return r.op;
      // targetSchema 'backup' (C44): the load stopped at the backup's schema, and nothing migrates after it.
      if (p.targetSchema === 'backup') return { ...withParams(r.op, { final: newFinal() }), state: 'finalizing', progress: progressAt('finalizing', 0) };
      return { ...r.op, state: 'migrating', progress: progressAt('migrating', 0) };
    }
    if (op.state === 'migrating') {
      if (p.targetSchema !== 'backup' && !(await migrateAll(ctx, op.opId))) return op;
      return { ...withParams(op, { final: newFinal() }), state: 'finalizing', progress: progressAt('finalizing', 0) };
    }
    // finalizing
    const r = await finalize(ctx, op, p, p.final ?? newFinal(), { replay: false });
    if (r.waiting) {
      // Unchanged, but for when the swap's wait for the owners began (R1c-11), the first time.
      return (r.final.releaseWaitSince ?? null) === (p.final?.releaseWaitSince ?? null) ? op : withParams(op, { final: r.final });
    }
    if (r.attention !== undefined) {
      // The runner has no state for it: its caller's op needs attention (the step is tried again once it is resumed).
      if (mode === 'runner') throw r.attention.cause;
      return { ...withParams(op, { final: r.final }), state: 'needs_attention', stateBefore: op.state, error: r.attention.error };
    }
    const index = r.final.step === 'done' ? FINAL_STEPS.length : FINAL_STEPS.indexOf(r.final.step);
    const next = { ...withParams(op, { final: r.final }), progress: progressAt('finalizing', (100 * index) / FINAL_STEPS.length) };
    if (!r.ended) return next;
    await restartAfter(ctx, op.opId);
    return { ...next, state: 'done', progress: 100, error: null };
  }

  /** failed_restoring_pre: back to the `pre_restore` backup (or, on SQLite, the file renamed back). */
  async function replay(ctx: OpStepContext, op: OpFile, p: Params): Promise<OpFile> {
    const r0 = p.replay ?? { phase: 'load' as const, load: newLoad(), final: newFinal() };
    const q: Params = { ...p, replay: r0 };
    if (r0.phase === 'rename_back') {
      ctx.lock.assertHeld();
      await closeWorks();
      await deps.sqliteOwn?.close(); // Task 25: this process's own handles on the live file, before it is renamed
      const before = r0.final.releaseWaitSince ?? null;
      let since = before;
      const r = await deps.sqliteSwap!.renameBack(op.opId, { wait: ownersWait(ctx, since, (at) => (since = at)) });
      if (r === 'waiting') return since === before ? op : withParams(op, { replay: { ...r0, final: { ...r0.final, releaseWaitSince: since } } });
      return { ...withParams(op, { replay: { ...r0, phase: 'final', final: { ...newFinal(), step: 'volatile' } } }) };
    }
    if (r0.phase === 'load') {
      const r = await loading(ctx, op, q, { replay: true });
      if (!r.done) return r.op;
      const after = r.op.params['replay'] as typeof r0;
      return withParams(r.op, { replay: { ...after, phase: 'migrate' } });
    }
    if (r0.phase === 'migrate') {
      if (!(await migrateAll(ctx, op.opId))) return op;
      return { ...withParams(op, { replay: { ...r0, phase: 'final' } }), progress: 80 };
    }
    const r = await finalize(ctx, op, q, r0.final, { replay: true });
    const next = withParams(op, { replay: { ...r0, final: r.final } });
    if (r.attention !== undefined) return { ...next, state: 'needs_attention', stateBefore: op.state, error: r.attention.error };
    if (!r.ended) return next;
    await restartAfter(ctx, op.opId);
    return { ...next, state: 'failed', progress: 100, error: p.failure ?? { code: 'INTERNAL' } };
  }

  // -------------------------------------------------------------------------------------------------------------
  // Failures

  /** A failure before the point of no return: the op ends `failed`, the database as it was. */
  async function failBefore(ctx: OpStepContext, op: OpFile, p: Params | null, error: unknown): Promise<OpFile> {
    ctx.log.error('restore: the restore failed before its point of no return', { opId: op.opId, state: op.state, ...errorFields(error) });
    const q = p;
    await cleanTmp(ctx, op.opId);
    await cleanKeep(ctx, op.opId);
    try {
      const h = await live(ctx);
      if (q?.preRestoreBackupId !== undefined) {
        await abandonBackup(h, ctx.dataDir, { backupId: q.preRestoreBackupId, error, now: ctx.now(), log: ctx.log, notify: false });
      }
      if (q !== null) {
        await recordOutcome(
          h,
          outcomeOf(op, q, { outcome: 'failed', error: restoreErrorOf(error).code, notifyOutcome: false, diskLow: isDiskQuota(error), now: ctx.now() }),
        );
      }
    } catch (secondary) {
      ctx.log.warn('restore: the failed restore could not be recorded', { opId: op.opId, ...errorFields(secondary) });
    }
    await closeWorks();
    return { ...op, state: 'failed', error: restoreErrorOf(error, { reason: mode === 'runner' }) };
  }

  /** A failure past the point of no return: back to `pre_restore` (failed_restoring_pre), or thrown by the runner. */
  async function failAfter(ctx: OpStepContext, op: OpFile, p: Params, error: unknown): Promise<OpFile> {
    ctx.log.error(
      mode === 'kind'
        ? 'restore: the restore failed past its point of no return; going back to pre_restore'
        : 'restore: the restore runner failed past its point of no return; its op needs attention',
      { opId: op.opId, state: op.state, ...errorFields(error) },
    );
    const failure = restoreErrorOf(error);
    const diskLow = isDiskQuota(error);
    if (await swapping(ctx)) {
      // R1c-11: judged by the files, not the checkpoint: the swap may fail after its first rename (its last steps, a
      // crash between the renames), before the op recorded it.
      const swap = deps.sqliteSwap!;
      const swapped =
        swap.swapped !== undefined
          ? await swap.swapped(op.opId)
          : op.state === 'finalizing' && p.final !== undefined && FINAL_STEPS.indexOf(p.final.step as (typeof FINAL_STEPS)[number]) > FINAL_STEPS.indexOf('swap');
      if (!swapped) {
        // The live file was never touched: the work file goes, the op fails.
        await closeWorks();
        await removeFile(swap.workPath(op.opId)).catch(() => undefined);
        return failBefore(ctx, { ...op, pointOfNoReturn: true }, p, error);
      }
      if (mode === 'runner') throw error; // nothing to go back to: its caller's op needs attention
      return {
        ...withParams(op, { failure, diskLow, replay: { phase: 'rename_back', load: newLoad(), final: newFinal() } }),
        state: 'failed_restoring_pre',
        error: failure,
      };
    }
    if (p.preRestoreBackupId === undefined) throw error; // nothing to go back to (skipPreRestore): needs attention
    return {
      ...withParams(op, { failure, diskLow, replay: { phase: 'load', load: newLoad(), final: newFinal() } }),
      state: 'failed_restoring_pre',
      error: failure,
      progress: 0,
    };
  }

  async function step(ctx: OpStepContext, op: OpFile): Promise<OpFile> {
    const parsed = paramsSchema.safeParse(op.params);
    if (!parsed.success) {
      if (op.pointOfNoReturn || mode === 'runner') throw new TypeError('restore: op.params are malformed');
      return failBefore(ctx, op, null, new DomainError('VALIDATION_FAILED', { detail: 'Parameter restore tidak sah / The restore parameters are not valid' }));
    }
    const p = parsed.data;
    try {
      switch (op.state) {
        case 'verifying':
          return await verifying(ctx, op, p);
        case 'prechecked':
          return await prechecked(ctx, op, p);
        case 'pre_restore':
          if (mode === 'runner') throw new TypeError('restore runner: pre_restore is the restore kind’s own state');
          return await preRestore(ctx, op, p);
        case 'preserving':
          return await preserving(ctx, op, p);
        case 'loading':
        case 'migrating':
        case 'finalizing':
          return await mainPath(ctx, op, p);
        case 'failed_restoring_pre':
          if (mode === 'runner') throw new TypeError('restore runner: failed_restoring_pre is the restore kind’s own state');
          return await replay(ctx, op, p);
        default:
          return op;
      }
    } catch (error) {
      if (transientRestoreError(error) || op.state === 'failed_restoring_pre') throw error;
      if (!op.pointOfNoReturn) return failBefore(ctx, op, p, error);
      return failAfter(ctx, op, p, error);
    }
  }

  async function cancel(ctx: OpStepContext, op: OpFile): Promise<void> {
    const unasked = op.error;
    if (unasked !== null) {
      // R1c-15 (final review G2): the machine ends the restore unasked (its freeze broke, or timed out after it did
      // work), so it failed before its point of no return: recorded as failBefore records it (backup.restore outcome
      // `failed`, best effort), and the copies `preserving` made (ops/<opId>/keep/) go with tmp/<opId>/.
      await removeTree(dataPath(ctx.dataDir, 'ops', op.opId, 'keep')).catch((error: unknown) => {
        ctx.log.warn('restore: ops/<opId>/keep could not be removed', { opId: op.opId, ...errorFields(error) });
      });
      const q = paramsSchema.safeParse(op.params);
      try {
        if (q.success) {
          const outcome = outcomeOf(op, q.data, { outcome: 'failed', error: unasked.code, notifyOutcome: false, diskLow: false, now: ctx.now() });
          await recordOutcome(await live(ctx), outcome);
        }
      } catch (error) {
        ctx.log.warn('restore: the failed restore could not be recorded', { opId: op.opId, ...errorFields(error) });
      }
    }
    await cleanTmp(ctx, op.opId);
    await closeWorks();
    await cleanKeep(ctx, op.opId);
    const p = paramsSchema.safeParse(op.params);
    const id = p.success ? p.data.preRestoreBackupId : undefined;
    if (id === undefined) return;
    try {
      await abandonBackup(await live(ctx), ctx.dataDir, { backupId: id, error: null, now: ctx.now(), log: ctx.log, notify: false });
    } catch (error) {
      ctx.log.warn('restore: the pre_restore backup of a cancelled restore could not be abandoned', { opId: op.opId, ...errorFields(error) });
    }
  }

  return { step, cancel };
}

// ---------------------------------------------------------------------------------------------------------------
// The runner

/** The states past the point of no return (the runner's own `pointOfNoReturn`). */
const PAST_NO_RETURN: ReadonlySet<string> = new Set(['loading', 'migrating', 'finalizing']);
const ENDED: ReadonlySet<string> = new Set(['done', 'failed']);

/** A run's begin params, as `begin` accepts them (strict: a typo is a caller's bug). */
const runParamsSchema = z.strictObject(beginShape).refine((p) => p.skipPreRestore === true, 'the runner makes no pre_restore backup: skipPreRestore must be true');

/** A RestoreRun as it is read back (loose at every level, D1d-44). */
const runSchema = z.looseObject({
  state: z.enum(RESTORE_SUB_STATES),
  params: z.looseObject({}),
  checkpoint: z.looseObject({}),
  error: errorSchema.nullable(),
  progress: z.number().int().min(0).max(100).optional(),
});

const SYSTEM_ACTOR: OpActor = Object.freeze({ type: 'system', id: null }) as OpActor;

/** A run's error as it is written: its known fields, the detail cut to op.json's limit. */
function errorCopy(e: { code: string; detail?: string; reason?: unknown }): NonNullable<RestoreRun['error']> {
  return {
    code: e.code,
    ...(e.detail === undefined ? {} : { detail: cut(e.detail, DETAIL_MAX) }),
    ...(typeof e.reason === 'string' ? { reason: e.reason } : {}),
  };
}

/** The restore runner: a restore stepped inside another kind's op (see the top of this file). */
export interface RestoreRunner {
  /**
   * A new run in `verifying` (nothing touched yet: the first step reads the backup).
   *
   * @throws TypeError for params that are not valid, or without `skipPreRestore: true`
   */
  begin(p: RestoreRunParams): RestoreRun;
  /**
   * One step of `run` (a copy; up to `ctx.deadline`), inside the op `o.opId` (its `ops/<opId>/keep/`, `tmp/<opId>/`,
   * the audit entry's `opId`), audited as `o.actor` (default: the system). A run that ended (`done`, `failed`) comes
   * back as it is. Fields of `run` this release does not know are written back.
   *
   * @throws TypeError for a run that is not one; `DB_UNAVAILABLE` and lock timeouts (the run unchanged: step again
   *   later); past the point of no return, the error of a failed step (its caller's op needs attention, and a resumed
   *   op steps it again from its last checkpoint)
   */
  step(ctx: OpStepContext, run: RestoreRun, o: { opId: string; actor?: OpActor }): Promise<RestoreRun>;
}

/**
 * The restore runner on `deps` (the 1d update revert, spec §9.7 `restoring`): the restore kind's steps, kept in a
 * {@link RestoreRun} instead of an op of their own.
 *
 * @throws TypeError when `deps` are not usable
 */
export function createRestoreRunner(deps: RestoreKindDeps): RestoreRunner {
  const engine = createRestoreEngine(deps, 'runner');
  return {
    begin(p) {
      const parsed = runParamsSchema.safeParse(p);
      if (!parsed.success) throw new TypeError(`restore runner: the params are not valid (${parsed.error.issues[0]?.message ?? 'shape'})`);
      return { state: 'verifying', params: { ...p }, checkpoint: {}, error: null, progress: 0 };
    },
    async step(ctx, given, o) {
      if (typeof o?.opId !== 'string' || !isUlid(o.opId)) throw new TypeError('restore runner: opId must be a ULID');
      const parsed = runSchema.safeParse(given);
      if (!parsed.success) throw new TypeError('restore runner: the run is malformed');
      const run = parsed.data;
      if (ENDED.has(run.state)) return run as unknown as RestoreRun;
      const params = run.params;
      // The begin params win over a checkpoint that would name one of them.
      const merged: Record<string, unknown> = { ...run.checkpoint, ...params };
      const op: OpFile = {
        opSchema: 1,
        opId: o.opId,
        kind: 'restore',
        actor: o.actor ?? SYSTEM_ACTOR,
        state: run.state,
        version: deps.appVersion,
        backupId: null,
        heartbeatAt: ctx.now(),
        startedAt: ctx.now(),
        finishedAt: null,
        error: run.error,
        opsTokenHash: null,
        pointOfNoReturn: PAST_NO_RETURN.has(run.state),
        params: merged,
        progress: run.progress ?? 0,
        message: null,
      };
      const next = await engine.step(ctx, op);
      if (!(RESTORE_SUB_STATES as readonly string[]).includes(next.state)) {
        throw new TypeError(`restore runner: the restore reached ${next.state}, which is not a sub-state of the runner`);
      }
      const checkpoint: Record<string, unknown> = {};
      for (const [key, value] of Object.entries(next.params)) if (!Object.hasOwn(params, key)) checkpoint[key] = value;
      return {
        ...run,
        state: next.state as RestoreSubState,
        params,
        checkpoint,
        error: next.error === null ? null : errorCopy(next.error),
        progress: Math.min(100, Math.max(0, Math.floor(next.progress))),
      } as unknown as RestoreRun;
    },
  };
}
