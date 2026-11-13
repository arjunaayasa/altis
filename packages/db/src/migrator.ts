import { atomicWriteJson, dataPath, ensureDir, faultArmed, readJsonWithBak, withFileLock } from '@altis/platform';
import { DomainError, compareSemver, isDomainError, isSemver } from '@altis/shared';
import { MysqlAdapter, sql, type DialectAdapter, type Kysely } from 'kysely';
import { Migrator, type Migration, type MigrationProvider } from 'kysely/migration';
import type { DbHandle, Dialect } from './connect.js';
import { isDriverError, safeCause } from './db-errors.js';
import { ensureBootstrap, ensureTable } from './ddl.js';
import { EDITION_MIGRATIONS, EDITION_MIGRATION_NAME, EDITION_MIGRATOR_TABLES } from './edition-migrations.js';
import { yieldToEventLoop } from './yield.js';

// The migration runner (spec §6.4).
//
// - Kysely's Migrator, with the migrations given in code (no files), `up()` only, bookkept in schema_migrations
//   and schema_migrations_lock. Names are `NNNN_slug`, each number used once; `schema_meta` (one row, id 1) holds
//   `schema_version` (the NNNN of the last applied migration, `0000` before any) and `min_code_version` (raised
//   only by contract migrations, never lowered), and is mirrored to `DATA_DIR/releases/schema-meta.json` so the
//   bootloader can judge compatibility without a database connection.
//
// - Kysely's two tables are created here, with the DDL helpers, right after ensureBootstrap (ruling R27):
//   registered as class `migrator`, InnoDB/utf8mb4 with VARCHAR(191) binary keys on MySQL/MariaDB, keyed pk_<table>,
//   in current_schema() on PostgreSQL. The Migrator then finds them and runs no DDL of its own.
//
// - Decide before migrating (ruling R21). Under the lock, the applied names and schema_meta are read first:
//   - appVersion < min_code_version: mode `too-old` (the database needs newer code). The spec states this for a
//     database holding migrations this code does not know; it is applied whatever the names, because the floor
//     can also have been raised by a newer release's contract migration that stopped before it was recorded;
//   - otherwise, applied names this code does not know: mode `schema-ahead` (normal; nothing is run);
//   - otherwise the pending migrations run, unless the applied ones are not the first N of this code's list
//     (SCHEMA_CONFLICT `migration_order`).
//   In the first two modes the Kysely Migrator is never constructed, so it cannot fail with "corrupted
//   migrations" (it refuses applied names it does not know). The Migrator also runs with
//   allowUnorderedMigrations: it orders applied migrations by their recorded time, which a clock step can put out
//   of name order; the name order has been checked here instead.
//
// - Locks, outermost first:
//   1. `DATA_DIR/tmp/migrate.lock` (withFileLock: O_EXCL file, holder PID + start time + host, stale after 30 s
//      without a heartbeat; 10 min on SQLite, ruling R31), per DATA_DIR: serializes every process of one
//      installation — up to six Passenger workers, the CLI, cron. It covers the whole decide + migrate +
//      schema_meta + mirror sequence. The heartbeat refreshes the lock in one synchronous step whenever its timer
//      runs; the run yields to the event loop around every migration and SQLite statements yield at least every
//      second (ruling R25), so the timer gets its turns while node:sqlite works synchronously. One SQLite statement
//      can still block the event loop for longer than 30 s (a CREATE INDEX on a big table): hence the 10 minutes
//      there, where a crashed holder is still recognised at once by its pid (same host), and a holder from before
//      a reboot by its boot id (R36). A container recreated after a host reboot has a new PID namespace: its
//      predecessor's lock is judged by mtime, so the first run after the reboot waits up to 10 minutes.
//   2. The database's own lock, taken by the Migrator on the one connection it pins for the run:
//      - MySQL/MariaDB: `GET_LOCK('altis_mig_' + first 40 hex of SHA-256(DATABASE()), ceil(lockWaitMs / 1 s))`
//        (ruling R26). Named locks are server-wide, so the name is per database: installations on one shared
//        server (and other Kysely apps, whose stock name is a constant) never wait for each other. A lock not
//        obtained in time is DB_UNAVAILABLE `busy` (`meta.code: 'MIGRATION_LOCK'`), never an unlocked run;
//      - PostgreSQL: Kysely's session pg_advisory_lock, which is per database;
//      - SQLite: none (Kysely's SQLite lock is a no-op): the file lock is the only cross-process protection.
//      The driver layer never moves that pinned session to another connection and never reuses it once lost
//      (driver-guard.ts), so the lock cannot be silently lost while the run carries on.
//   Every process takes them in this order, so the two never deadlock against each other.
//   Ruling R29: one database shared by installations with separate DATA_DIRs is NOT supported (decide, reconcile
//   and the mirror run under the file lock only); spec §6.4 requires an empty database for each installation.
//
// - Per dialect (ruling R22): on PostgreSQL the Migrator runs all pending migrations of a run in ONE transaction
//   (transactional DDL): a failure rolls back the whole batch, schema_meta changes included, and inside it the DDL
//   helpers' race recovery is off (the locks above are the protection). MySQL/MariaDB and SQLite run each
//   statement on its own; a failed migration leaves the earlier ones applied and must be idempotent, so the next
//   run completes it.
//
// - Inside each migration's turn (same connection, same transaction on PostgreSQL): a contract first raises
//   min_code_version (so older code refuses the database before the contract's DDL changes it), then `up()` runs,
//   then schema_version moves to the migration's number. After the Migrator returns, schema_meta is reconciled
//   with schema_migrations (which is the truth, e.g. after a crash between the two) and mirrored to the file.
//
// - Migrasi jalur lain (edition-migrations.ts; `MigrationOptions.editionMigrations`, default EDITION_MIGRATIONS):
//   a second lane, `eNNNN_slug`, with its own plan, its own decision and its own bookkeeping
//   (`schema_migrations_edition`, `schema_migrations_edition_lock`, made with the two tables above on every run).
//   The core lane's plan, decision, Migrator and schema_meta are exactly as described above whatever that lane holds.
//   - An empty lane (this edition): `schema_migrations_edition` is never read for the decision and no second Migrator
//     is built; the outcome's `edition` is `{mode: 'empty', applied: []}`.
//   - Otherwise its applied names are read after the core lane's decision: a name the code does not know makes the
//     lane `schema-ahead` (nothing of it runs, no second Migrator is built); a gap in it is SCHEMA_CONFLICT
//     `migration_order` (`meta.lane: 'edition'`). Its pending migrations run in a second Kysely Migrator with its own
//     two tables, after the core lane's, under the same migrate.lock and the same database lock (taken again by the
//     second Migrator: GET_LOCK on MySQL/MariaDB, the advisory lock on PostgreSQL). Each turn runs `up()` only:
//     schema_meta follows the core lane alone, and a `contract` of the lane is ignored.
//   - `MigrationOutcome.mode` is the core lane's, except `schema-ahead` when only the other lane is ahead.
//
// - Progress (1d, preflight 1D-03; `onProgress`): reported before and after each migration, and by a 5 s timer for
//   the whole run, so a long wait for a migration lock (`waiting: true`) and a long statement inside a migration both
//   count as progress; only a hung process stalls. The timer is allowed under Passenger because the caller holds
//   `releases/boot.lock` or the migration lock (spec §9.3). A callback that throws or rejects is ignored: progress
//   never breaks a migration.
//
// - Update faults (test profile only, decision D1d-25): `migrate:<name>` throws before migration `<name>` runs (a
//   migration error like any other); `migrate-slow:<seconds>` waits, holding the migration lock, before the first
//   migration a run applies, until `<seconds>` have passed since the fault was first armed in this DATA_DIR
//   (`DATA_DIR/tmp/fault-migrate-slow.json`, so the wait is cumulative across holders a crash or Passenger replaces,
//   preflight S22), reporting progress every 5 s; `migrate-ddl:<k>` lives in ddl.ts.

/** Migration names: four digits, an underscore, then lower-case letters, digits and underscores. */
export const MIGRATION_NAME = /^\d{4}_[a-z0-9_]+$/;

/**
 * The tables of the Kysely Migrators, the core lane's and then the other lane's (EDITION_MIGRATOR_TABLES); all four
 * are created here on every run and registered in schema_tables as class `migrator`.
 */
export const MIGRATOR_TABLES = ['schema_migrations', 'schema_migrations_lock', ...EDITION_MIGRATOR_TABLES] as const;

/** A migration as the code ships it. `up()` must be idempotent (MySQL/MariaDB/SQLite rerun a failed one). */
export interface AltisMigration {
  // Kysely<any> like Kysely's own Migration: a migration runs against the schema of its moment in history, not
  // against the final `DB` type.
  // eslint-disable-next-line @typescript-eslint/no-explicit-any
  up(db: Kysely<any>, dialect: Dialect): Promise<void>;
  /** A contract migration (spec §6.4): from now on the database needs code of at least this version. */
  contract?: { minCodeVersion: string };
}

export interface MigrationOptions {
  /** The running code's version (SemVer). */
  appVersion: string;
  /** DATA_DIR: holds `tmp/migrate.lock` and `releases/schema-meta.json`. */
  dataDir: string;
  /** Every migration of this code, by name. */
  migrations: Record<string, AltisMigration>;
  /**
   * How long to wait for `migrate.lock` held by another process, and then (MySQL/MariaDB) for the database's
   * migration lock, in ms. Default 600 000 (10 minutes).
   */
  lockWaitMs?: number;
  /**
   * Progress of the run (1d, preflight 1D-03): called before and after each migration (`{migration: <its name>,
   * waiting: false}`), and every 5 s from the start of the run to its end with the current state: `waiting: true`
   * while the run waits for `migrate.lock` (or, on MySQL/MariaDB, the database's migration lock), otherwise the
   * migration whose turn it is (null before the first). The pending boot (Task 25) refreshes its boot marker from
   * it. Errors the callback throws or rejects with are ignored.
   */
  onProgress?: (e: MigrationProgress) => void;
  // ---- Komunitas K1 (edition lane) ----
  /**
   * The migrations of the other lane (`eNNNN_slug`), by name; default EDITION_MIGRATIONS (empty in this edition).
   * See the top of this file.
   */
  editionMigrations?: Readonly<Record<string, AltisMigration>>;
}

/** What {@link MigrationOptions.onProgress} receives. */
export interface MigrationProgress {
  /** The migration whose turn it is (or was last), null before the first. */
  migration: string | null;
  /** True while the run waits for a migration lock another process holds. */
  waiting: boolean;
}

export type MigrationMode = 'migrated' | 'up-to-date' | 'schema-ahead' | 'too-old';

/**
 * The other lane's part of a run: `empty` when the code ships no migration of it (its table is not read), `schema-ahead`
 * when the database holds a name of it the code does not know (nothing of it ran), else `migrated` or `up-to-date`.
 */
export type EditionLaneMode = 'empty' | 'migrated' | 'up-to-date' | 'schema-ahead';

export interface MigrationOutcome {
  /** The core lane's mode, except `schema-ahead` when only the other lane is ahead. */
  mode: MigrationMode;
  /** The core lane's migrations applied by this run, in order. */
  applied: string[];
  /** `schema_meta.schema_version` after the run. */
  schemaVersion: string;
  /** `schema_meta.min_code_version` after the run. */
  minCodeVersion: string;
  // ---- Komunitas K1 (edition lane) ----
  /** The other lane: its mode, and its migrations applied by this run, in order. */
  edition: { mode: EditionLaneMode; applied: string[] };
}

/** The content of `releases/schema-meta.json`. */
export interface SchemaMetaMirror {
  schemaVersion: string;
  minCodeVersion: string;
}

/** The handle the runner needs: the database and its dialect. */
export type MigrationHandle = Pick<DbHandle, 'db' | 'dialect'>;

/** What a failed run adds to the failure it reports (as `meta` of the error). */
export interface MigrationFailureMeta {
  /**
   * The migration that failed, or the last one started when the failure came after it (its bookkeeping, the
   * batch's COMMIT on PostgreSQL, the lock release); null when the run failed before any migration started.
   */
  migration: string | null;
  /**
   * The migrations this run applied and that stayed applied, read back from schema_migrations (none on PostgreSQL,
   * where the batch is rolled back). Null when that could not be read back and is not known otherwise.
   */
  applied: string[] | null;
  /** False when `applied` is null (unknown); true when it was read back or follows from PostgreSQL's rollback. */
  appliedVerified: boolean;
  /**
   * A later error while bringing schema_meta and the mirror up to date after the failure, if any. A raw database
   * driver error in it is kept only as its safe fields (code, errno, sqlState, constraint); a DomainError (such as
   * DB_UNAVAILABLE `busy`) stays one (see safeChain).
   */
  secondary?: unknown;
}

/** How many links of a cause chain (and levels of AggregateError.errors) are followed. */
const MAX_CAUSE_DEPTH = 5;

/**
 * A raw error of a database driver: an Error (mysql2, pg and node:sqlite all throw Errors) that isDriverError
 * recognises. The frozen plain object a normalized DomainError carries as its cause is not one: it holds only the
 * safe fields already.
 */
function isRawDriverError(error: unknown): error is Error {
  return error instanceof Error && isDriverError(error);
}

/**
 * A SuppressedError (`using` / `await using`, Node 24+), or the Error named SuppressedError that the TypeScript and
 * esbuild downlevel helpers build: the disposal error in `error`, the error it suppressed in `suppressed`.
 */
function isSuppressedError(error: Error): error is Error & { error: unknown; suppressed: unknown } {
  return error.name === 'SuppressedError' && 'error' in error && 'suppressed' in error;
}

/** The links below `error`: an AggregateError's `errors`, a SuppressedError's `error` and `suppressed`, its `cause`. */
function linksBelow(error: unknown): unknown[] {
  if (!(error instanceof Error)) return [];
  const below: unknown[] = error instanceof AggregateError && Array.isArray(error.errors) ? [...error.errors] : [];
  if (isSuppressedError(error)) below.push(error.error, error.suppressed);
  if (error.cause !== undefined) below.push(error.cause);
  return below;
}

/**
 * The raw database driver errors in `error` and below it (cause chains, AggregateError.errors, SuppressedError's
 * error and suppressed; at most MAX_CAUSE_DEPTH levels deep), in order; nothing is looked for below a raw driver
 * error.
 */
function driverErrorsIn(error: unknown, depth = 0): Error[] {
  if (isRawDriverError(error)) return [error];
  if (depth >= MAX_CAUSE_DEPTH) return [];
  return linksBelow(error).flatMap((link) => driverErrorsIn(link, depth + 1));
}

/** True when `message` repeats a text of `driverError` that can hold SQL or values (its message, sqlMessage, sql). */
function repeatsDriverText(message: string, driverError: unknown): boolean {
  const d = driverError as { message?: unknown; sqlMessage?: unknown; sql?: unknown; detail?: unknown };
  return [d.message, d.sqlMessage, d.sql, d.detail].some((t) => typeof t === 'string' && t !== '' && message.includes(t));
}

/** The first of `driverErrors` whose text `message` repeats, or undefined. */
function repeatedIn(message: string, driverErrors: readonly Error[]): Error | undefined {
  return driverErrors.find((d) => repeatsDriverText(message, d));
}

/** A driver error described by its safe fields: `galat database / database error ER_DUP_ENTRY, errno 1062, SQLSTATE 23000`. */
function describeDriverError(driverError: unknown): string {
  const safe = safeCause(driverError);
  const parts = [
    safe['code'],
    safe['errno'] === undefined ? undefined : `errno ${safe['errno']}`,
    safe['sqlState'] === undefined ? undefined : `SQLSTATE ${safe['sqlState']}`,
  ];
  return `galat database / database error ${parts.filter((x) => x !== undefined).join(', ')}`;
}

/**
 * `error` safe to log and serialize: the safe-cause policy of normalizeDbError down the cause chain, through
 * AggregateError.errors and through a SuppressedError's error and suppressed (at most MAX_CAUSE_DEPTH levels).
 * Package-internal (tested directly).
 *
 * - A raw database driver error becomes its safe fields {code, errno, sqlState, constraint}.
 * - Anything without a raw driver error below it is kept as it is: a normalized DomainError (its cause is the safe
 *   fields already), a wrapper of one, an error from elsewhere.
 * - A DomainError with a raw driver error below it is rebuilt as a DomainError with the same code (so status) and
 *   meta and a safe cause; its detail is kept unless its message repeats a driver error's text, which the driver
 *   error's safe fields then replace (`galat database / database error ER_DUP_ENTRY, errno 1062, ...`).
 * - An AggregateError becomes `{name, message, errors}` (plus `cause` when it has one), a SuppressedError
 *   `{name, message, error, suppressed}` (plus `cause`), each link made safe; either loses its message when that
 *   repeats a driver error's text.
 * - Any other Error becomes `{name, message, cause}` with the cause made safe, unless its message repeats a driver
 *   error's text: then the chain is cut there and that driver error's safe fields take its place.
 */
export function safeChain(error: unknown, depth = 0): unknown {
  if (isRawDriverError(error)) return safeCause(error);
  const driverErrors = driverErrorsIn(error);
  if (driverErrors.length === 0 || !(error instanceof Error)) return error;
  const deeper = depth < MAX_CAUSE_DEPTH;
  const safeBelow = (link: unknown): unknown => (deeper ? safeChain(link, depth + 1) : undefined);
  const repeated = repeatedIn(error.message, driverErrors);
  if (isDomainError(error)) {
    const detail = repeated === undefined ? error.detail : describeDriverError(repeated);
    return new DomainError(error.code, {
      ...(detail === undefined ? {} : { detail }),
      ...(error.meta === undefined ? {} : { meta: error.meta }),
      ...(deeper && error.cause !== undefined ? { cause: safeBelow(error.cause) } : {}),
    });
  }
  const message = repeated === undefined ? { message: error.message } : {};
  const cause = error.cause === undefined ? {} : { cause: safeBelow(error.cause) };
  if (error instanceof AggregateError) {
    const errors = deeper && Array.isArray(error.errors) ? error.errors.map(safeBelow) : [];
    return { name: error.name, ...message, errors, ...cause };
  }
  if (isSuppressedError(error)) {
    return { name: error.name, ...message, error: safeBelow(error.error), suppressed: safeBelow(error.suppressed), ...cause };
  }
  if (repeated !== undefined) return safeCause(repeated);
  return { name: error.name, message: error.message, ...(deeper ? { cause: safeBelow(error.cause) } : {}) };
}

/**
 * A migration failed with an error that is not a {@link DomainError} (a DomainError is re-created with the same
 * code and this information added to its `meta` instead). A string `code` of the original error (a raw driver code
 * such as `ER_PARSE_ERROR` or `42P01`) is kept as `code`.
 *
 * Raw database driver errors follow the safe-cause policy of normalizeDbError, also further down the cause chain,
 * inside AggregateError.errors and inside a SuppressedError (a migration wrapping a driver error, reporting the
 * rejections of Promise.allSettled, or a disposal failing under `using`): neither `message` nor `cause` carries a
 * driver message, SQL text or values (which can hold personal data). A driver error is reduced to {code, errno,
 * sqlState, constraint}; a wrapping error keeps its own message unless that repeats a driver error's text, and a
 * DomainError in the chain keeps its code and meta, and its detail unless that repeats driver text (see safeChain). The raw driver error (the first one) stays reachable only as the non-enumerable
 * `driverError`, for local debugging. An error without a raw driver error in its chain (normalized DomainErrors
 * included: their cause is safe already) is the `cause` as it is, and its message is part of `message`.
 */
export class MigrationError extends Error {
  override readonly name = 'MigrationError';
  readonly code: string | undefined;
  readonly meta: MigrationFailureMeta;
  declare readonly driverError?: unknown;

  constructor(cause: unknown, meta: MigrationFailureMeta) {
    const what = meta.migration === null ? 'Migrasi gagal / Migration failed' : `Migrasi ${meta.migration} gagal / Migration ${meta.migration} failed`;
    const driverErrors = driverErrorsIn(cause);
    const driverError = driverErrors[0];
    let reason: string;
    if (driverError !== undefined && (cause === driverError || repeatedIn((cause as Error).message, driverErrors) !== undefined)) {
      // The message would carry the driver's text: describe the driver error by its safe fields instead.
      reason = describeDriverError(cause === driverError ? driverError : repeatedIn((cause as Error).message, driverErrors));
    } else {
      reason = cause instanceof Error ? cause.message : cause === undefined ? 'no reason given' : String(cause);
    }
    super(`${what}: ${reason}`, { cause: driverError === undefined ? cause : safeChain(cause) });
    const code = typeof cause === 'object' && cause !== null ? (cause as { code?: unknown }).code : undefined;
    this.code = typeof code === 'string' ? code : undefined;
    this.meta = meta;
    if (driverError !== undefined) {
      Object.defineProperty(this, 'driverError', { value: driverError, enumerable: false, configurable: true });
    }
  }
}

const [MIGRATION_TABLE, MIGRATION_LOCK_TABLE] = MIGRATOR_TABLES;
const [EDITION_TABLE, EDITION_LOCK_TABLE] = EDITION_MIGRATOR_TABLES;
const CREATED_BY = 'migrator';
const LOCK_FILE = 'migrate.lock';
const MIRROR_FILE = 'schema-meta.json';
const DEFAULT_LOCK_WAIT_MS = 600_000;
/** migrate.lock's stale time on SQLite (ruling R31); the default (30 s) elsewhere. */
const SQLITE_LOCK_STALE_MS = 600_000;
const META_ID = 1;
/** schema_version before any migration. */
const NO_SCHEMA = '0000';
/** min_code_version before any contract. */
const ANY_CODE = '0.0.0';
const SCHEMA_VERSION = /^\d{4}$/;
/** Widths of the columns that hold them: schema_migrations.name (key191), schema_meta.min_code_version. */
const MAX_NAME_LENGTH = 191;
const MAX_VERSION_LENGTH = 32;

type MetaTables = {
  schema_meta: { id: number; schema_version: string; min_code_version: string; install_id: string | null };
  schema_migrations: { name: string; timestamp: string };
  schema_migrations_edition: { name: string; timestamp: string };
};

function metaDb<T>(db: Kysely<T>): Kysely<MetaTables> {
  return db as unknown as Kysely<MetaTables>;
}

// ---------------------------------------------------------------------------------------------------------------
// Arguments

interface Plan {
  appVersion: string;
  dataDir: string;
  lockWaitMs: number;
  /** Every migration name, in order. */
  names: string[];
  byName: ReadonlyMap<string, AltisMigration>;
  onProgress: ((e: MigrationProgress) => void) | null;
}

/** Checks the options before anything touches the database or the file system (TypeError for each problem). */
function plan(o: MigrationOptions): Plan {
  if (typeof o !== 'object' || o === null) throw new TypeError('migration options are required');
  const { appVersion, dataDir, migrations } = o;
  const onProgress = o.onProgress ?? null;
  if (onProgress !== null && typeof onProgress !== 'function') throw new TypeError('onProgress must be a function');
  if (typeof appVersion !== 'string' || !isSemver(appVersion)) {
    throw new TypeError(`appVersion must be a semantic version, got ${JSON.stringify(appVersion)}`);
  }
  if (typeof dataDir !== 'string' || dataDir === '') throw new TypeError('dataDir must be a non-empty string');
  const lockWaitMs = o.lockWaitMs ?? DEFAULT_LOCK_WAIT_MS;
  if (typeof lockWaitMs !== 'number' || !Number.isFinite(lockWaitMs) || lockWaitMs < 0) {
    throw new TypeError(`lockWaitMs must be a finite number of milliseconds >= 0, got ${String(lockWaitMs)}`);
  }
  if (typeof migrations !== 'object' || migrations === null) throw new TypeError('migrations must be an object');
  const byName = new Map<string, AltisMigration>();
  const byNumber = new Map<string, string>();
  for (const [name, m] of Object.entries(migrations)) {
    if (!MIGRATION_NAME.test(name) || name.startsWith(NO_SCHEMA) || name.length > MAX_NAME_LENGTH) {
      throw new TypeError(
        `migration name ${JSON.stringify(name.slice(0, 64))} must look like 0001_slug (${MIGRATION_NAME}, not 0000, ` +
          `at most ${MAX_NAME_LENGTH} characters)`,
      );
    }
    const number = name.slice(0, 4);
    const other = byNumber.get(number);
    if (other !== undefined) throw new TypeError(`migrations ${other} and ${name} share the number ${number}`);
    byNumber.set(number, name);
    if (typeof m !== 'object' || m === null || typeof m.up !== 'function') {
      throw new TypeError(`migration ${name} must have an up() function`);
    }
    if (m.contract !== undefined) {
      const min = (m.contract as { minCodeVersion?: unknown } | null)?.minCodeVersion;
      if (typeof min !== 'string' || !isSemver(min) || min.length > MAX_VERSION_LENGTH) {
        throw new TypeError(
          `migration ${name}: contract.minCodeVersion must be a semantic version of at most ${MAX_VERSION_LENGTH} ` +
            `characters, got ${JSON.stringify(min)}`,
        );
      }
      // The code that carries a contract has to work with the schema the contract leaves behind.
      if (compareSemver(min, appVersion) > 0) {
        throw new TypeError(`migration ${name} is a contract for code ${min} or newer, but this code is ${appVersion}`);
      }
    }
    byName.set(name, m);
  }
  // Names have distinct four-digit numbers, so plain string order is number order (as Kysely sorts them too).
  return { appVersion, dataDir, lockWaitMs, names: [...byName.keys()].sort(), byName, onProgress };
}

// ---- Komunitas K1 (edition lane) ----

/** The other lane of a run: its migrations, by name and in order (none: the lane is neither read nor run). */
interface EditionPlan {
  names: string[];
  byName: ReadonlyMap<string, AltisMigration>;
}

/**
 * Checks the other lane's migrations (`o.editionMigrations`, default EDITION_MIGRATIONS) as {@link plan} checks the
 * core lane's, by the lane's own name rule (`e0001_slug`, distinct numbers, not e0000), before anything is touched. A
 * `contract` is not looked at: the lane never moves schema_meta.
 */
function planEdition(o: MigrationOptions): EditionPlan {
  const migrations = o.editionMigrations ?? EDITION_MIGRATIONS;
  if (typeof migrations !== 'object' || migrations === null) throw new TypeError('editionMigrations must be an object');
  const byName = new Map<string, AltisMigration>();
  const byNumber = new Map<string, string>();
  for (const [name, m] of Object.entries(migrations)) {
    if (!EDITION_MIGRATION_NAME.test(name) || name.startsWith(`e${NO_SCHEMA}`) || name.length > MAX_NAME_LENGTH) {
      throw new TypeError(
        `migration name ${JSON.stringify(name.slice(0, 64))} of the other lane must look like e0001_slug ` +
          `(${EDITION_MIGRATION_NAME}, not e0000, at most ${MAX_NAME_LENGTH} characters)`,
      );
    }
    const number = name.slice(1, 5);
    const other = byNumber.get(number);
    if (other !== undefined) throw new TypeError(`migrations ${other} and ${name} share the number ${number}`);
    byNumber.set(number, name);
    if (typeof m !== 'object' || m === null || typeof m.up !== 'function') {
      throw new TypeError(`migration ${name} must have an up() function`);
    }
    byName.set(name, m);
  }
  return { names: [...byName.keys()].sort(), byName };
}

// ---------------------------------------------------------------------------------------------------------------
// Progress (MigrationOptions.onProgress)

/** The progress timer's period, and the step of the `migrate-slow` fault's wait. */
const PROGRESS_INTERVAL_MS = 5000;

/** The progress of one run: its current state, reported on demand and by a timer while the run lasts. */
interface Progress {
  /** Sets the state and reports it at once. */
  report(state: Partial<MigrationProgress>): void;
  /** Sets the state without reporting it (the timer will). */
  set(state: Partial<MigrationProgress>): void;
  /** Stops the timer. */
  stop(): void;
}

/** A run's {@link Progress}: a no-op without a callback; otherwise a 5 s timer (unref'd) runs until `stop()`. */
function progressOf(onProgress: ((e: MigrationProgress) => void) | null): Progress {
  if (onProgress === null) return { report() {}, set() {}, stop() {} };
  const state: MigrationProgress = { migration: null, waiting: false };
  const emit = (): void => {
    try {
      const result: unknown = onProgress({ migration: state.migration, waiting: state.waiting });
      // An async callback: its rejection is ignored as a throw is (never an unhandled rejection).
      if (typeof (result as { catch?: unknown } | null)?.catch === 'function') (result as Promise<unknown>).catch(() => undefined);
    } catch {
      // Progress never breaks a migration.
    }
  };
  const timer = setInterval(emit, PROGRESS_INTERVAL_MS);
  timer.unref();
  return {
    report(next) {
      Object.assign(state, next);
      emit();
    },
    set(next) {
      Object.assign(state, next);
    },
    stop() {
      clearInterval(timer);
    },
  };
}

const sleep = (ms: number): Promise<void> => new Promise((resolve) => setTimeout(resolve, ms));

// ---------------------------------------------------------------------------------------------------------------
// Update faults (test profile only, decision D1d-25)

/** The test fault `migrate:<name>`: throws before migration `name` runs. */
function migrateFault(name: string): void {
  // Inline, so that a production build folds the condition to false and drops the block (R57).
  if (typeof __BUILD_PROFILE__ !== 'undefined' && __BUILD_PROFILE__ === 'test') {
    if (faultArmed(process.env, 'migrate') === name) {
      throw new Error(`test fault migrate:${name}: migration ${name} refused to run`);
    }
  }
}

/** `DATA_DIR/tmp/fault-migrate-slow.json`: the armed `migrate-slow` fault (its argument) and when it was first seen. */
function parseSlowFault(raw: unknown): { fault: string; armedAt: number } {
  const { fault, armedAt } = (typeof raw === 'object' && raw !== null ? raw : {}) as Record<string, unknown>;
  if (typeof fault !== 'string' || typeof armedAt !== 'number' || !Number.isSafeInteger(armedAt)) throw new TypeError('not a slow fault record');
  return { fault, armedAt };
}

/**
 * The test fault `migrate-slow:<seconds>`, before the first migration a run applies (`first`), under migrate.lock:
 * waits in 5 s steps, reporting progress at each, until `<seconds>` have passed since the fault was first armed in
 * this DATA_DIR. The first time is kept in `DATA_DIR/tmp/fault-migrate-slow.json` (written when the file is missing or
 * names another argument), so a holder that replaces a killed one only waits for the rest (preflight S22). Once that
 * time has passed, later runs in this DATA_DIR do not wait.
 */
async function migrateSlowFault(dataDir: string, first: string, progress: Progress): Promise<void> {
  if (typeof __BUILD_PROFILE__ !== 'undefined' && __BUILD_PROFILE__ === 'test') {
    const arg = faultArmed(process.env, 'migrate-slow');
    if (arg === null || !/^\d{1,6}$/.test(arg)) return;
    const file = dataPath(dataDir, 'tmp', 'fault-migrate-slow.json');
    const seen = await readJsonWithBak(file, parseSlowFault).catch(() => null);
    let armedAt = seen !== null && seen.fault === arg ? seen.armedAt : null;
    if (armedAt === null) {
      armedAt = Date.now();
      await atomicWriteJson(file, { fault: arg, armedAt });
    }
    const until = armedAt + Number(arg) * 1000;
    progress.set({ migration: first, waiting: false });
    for (let left = until - Date.now(); left > 0; left = until - Date.now()) {
      await sleep(Math.min(PROGRESS_INTERVAL_MS, left));
      progress.report({});
    }
  }
}

// ---------------------------------------------------------------------------------------------------------------
// Database state

/**
 * Creates Kysely's two tables unless they exist (ruling R27), with the columns Kysely reads and writes:
 * `schema_migrations(name, timestamp)` (timestamp: an ISO 8601 string) and `schema_migrations_lock(id,
 * is_locked)`. Class `migrator`, created_by `migrator`.
 */
async function ensureMigratorTables(h: MigrationHandle): Promise<void> {
  await ensureTable(h.db, h.dialect, MIGRATION_TABLE, 'migrator', CREATED_BY, (t) => {
    t.key191('name');
    t.varchar('timestamp', 64);
    t.primaryKey(['name']);
  });
  await ensureTable(h.db, h.dialect, MIGRATION_LOCK_TABLE, 'migrator', CREATED_BY, (t) => {
    t.key191('id');
    t.int('is_locked').default(0);
    t.primaryKey(['id']);
  });
  // ---- Komunitas K1 (edition lane): the other lane's two tables, the same shapes, on every install ----
  await ensureTable(h.db, h.dialect, EDITION_TABLE, 'migrator', CREATED_BY, (t) => {
    t.key191('name');
    t.varchar('timestamp', 64);
    t.primaryKey(['name']);
  });
  await ensureTable(h.db, h.dialect, EDITION_LOCK_TABLE, 'migrator', CREATED_BY, (t) => {
    t.key191('id');
    t.int('is_locked').default(0);
    t.primaryKey(['id']);
  });
}

interface DbState {
  /** Names in schema_migrations, sorted. */
  applied: string[];
  /** The schema_meta row, or null when it is missing. */
  meta: SchemaMetaMirror | null;
}

function conflict(reason: string, detail: string, meta: Record<string, unknown>): DomainError {
  return new DomainError('SCHEMA_CONFLICT', { detail, meta: { reason, ...meta } });
}

async function readState(h: MigrationHandle): Promise<DbState> {
  const db = metaDb(h.db);
  const applied = (await db.selectFrom(MIGRATION_TABLE).select('name').execute()).map((r) => r.name).sort();
  const row = await db
    .selectFrom('schema_meta')
    .select(['schema_version', 'min_code_version'])
    .where('id', '=', META_ID)
    .executeTakeFirst();
  if (row === undefined) return { applied, meta: null };
  const { schema_version: schemaVersion, min_code_version: minCodeVersion } = row;
  if (typeof schemaVersion !== 'string' || !SCHEMA_VERSION.test(schemaVersion) || typeof minCodeVersion !== 'string' || !isSemver(minCodeVersion)) {
    throw conflict(
      'invalid_schema_meta',
      `schema_meta berisi nilai yang tidak valid (schema_version ${JSON.stringify(schemaVersion)}, ` +
        `min_code_version ${JSON.stringify(minCodeVersion)}) / schema_meta holds invalid values ` +
        `(schema_version ${JSON.stringify(schemaVersion)}, min_code_version ${JSON.stringify(minCodeVersion)})`,
      { schemaVersion, minCodeVersion },
    );
  }
  return { applied, meta: { schemaVersion, minCodeVersion } };
}

/** The NNNN of the highest applied name, or `0000`. */
function versionOf(applied: readonly string[]): string {
  let version = NO_SCHEMA;
  for (const name of applied) {
    const number = name.slice(0, 4);
    if (SCHEMA_VERSION.test(number) && number > version) version = number;
  }
  return version;
}

type Decision = { mode: 'too-old' | 'schema-ahead' } | { mode: 'migrate'; pending: string[] };

function decide(p: Plan, state: DbState): Decision {
  const minCodeVersion = state.meta?.minCodeVersion ?? ANY_CODE;
  if (compareSemver(p.appVersion, minCodeVersion) < 0) return { mode: 'too-old' };
  if (state.applied.some((name) => !p.byName.has(name))) return { mode: 'schema-ahead' };
  const applied = new Set(state.applied);
  const missing = p.names.slice(0, state.applied.length).filter((name) => !applied.has(name));
  if (missing.length > 0) {
    throw conflict(
      'migration_order',
      `Migrasi ${missing.join(', ')} belum dijalankan padahal migrasi sesudahnya sudah / ` +
        `Migration ${missing.join(', ')} was never applied although later ones were`,
      { missing },
    );
  }
  return { mode: 'migrate', pending: p.names.filter((name) => !applied.has(name)) };
}

// ---- Komunitas K1 (edition lane) ----

type EditionDecision =
  | { mode: 'empty' }
  | { mode: 'schema-ahead' }
  | { mode: 'migrate'; applied: string[]; pending: string[] };

/** The names in schema_migrations_edition, sorted. */
async function readEditionApplied(h: MigrationHandle): Promise<string[]> {
  return (await metaDb(h.db).selectFrom(EDITION_TABLE).select('name').execute()).map((r) => r.name).sort();
}

/**
 * The other lane's decision, as {@link decide} makes the core lane's: an empty lane is `empty` without reading its
 * table; a name the code does not know is `schema-ahead`; applied names that are not the first N of the lane are
 * SCHEMA_CONFLICT `migration_order` (`meta.lane: 'edition'`); otherwise its pending migrations.
 */
async function decideEdition(h: MigrationHandle, ep: EditionPlan): Promise<EditionDecision> {
  if (ep.names.length === 0) return { mode: 'empty' };
  const applied = await readEditionApplied(h);
  if (applied.some((name) => !ep.byName.has(name))) return { mode: 'schema-ahead' };
  const set = new Set(applied);
  const missing = ep.names.slice(0, applied.length).filter((name) => !set.has(name));
  if (missing.length > 0) {
    throw conflict(
      'migration_order',
      `Migrasi jalur lain ${missing.join(', ')} belum dijalankan padahal migrasi sesudahnya sudah / ` +
        `Migration ${missing.join(', ')} of the other lane was never applied although later ones were`,
      { missing, lane: 'edition' },
    );
  }
  return { mode: 'migrate', applied, pending: ep.names.filter((name) => !set.has(name)) };
}

/** Inserts the schema_meta row (id 1, `0000`, `0.0.0`, no install_id) when it is missing. */
async function ensureMetaRow(h: MigrationHandle): Promise<void> {
  const db = metaDb(h.db);
  const exists = async () =>
    (await db.selectFrom('schema_meta').select('id').where('id', '=', META_ID).executeTakeFirst()) !== undefined;
  if (await exists()) return;
  try {
    await db
      .insertInto('schema_meta')
      .values({ id: META_ID, schema_version: NO_SCHEMA, min_code_version: ANY_CODE, install_id: null })
      .execute();
  } catch (error) {
    // Another connection inserted it at the same time (no ON CONFLICT in shared SQL).
    if (!(isDomainError(error) && error.code === 'UNIQUE_VIOLATION' && (await exists()))) throw error;
  }
}

/**
 * Brings schema_meta in line with schema_migrations: schema_version is the number of the highest applied
 * migration, min_code_version the highest of its current value and every applied contract. Returns the values and
 * the applied names.
 */
async function reconcileMeta(h: MigrationHandle, p: Plan): Promise<SchemaMetaMirror & { applied: string[] }> {
  const state = await readState(h);
  const schemaVersion = versionOf(state.applied);
  let minCodeVersion = state.meta?.minCodeVersion ?? ANY_CODE;
  for (const name of state.applied) {
    const min = p.byName.get(name)?.contract?.minCodeVersion;
    if (min !== undefined && compareSemver(min, minCodeVersion) > 0) minCodeVersion = min;
  }
  if (state.meta?.schemaVersion !== schemaVersion || state.meta.minCodeVersion !== minCodeVersion) {
    await metaDb(h.db)
      .updateTable('schema_meta')
      .set({ schema_version: schemaVersion, min_code_version: minCodeVersion })
      .where('id', '=', META_ID)
      .execute();
  }
  return { schemaVersion, minCodeVersion, applied: state.applied };
}

// ---------------------------------------------------------------------------------------------------------------
// The Kysely side

/** The name of this database's migration lock on MySQL/MariaDB (named locks are server-wide; at most 64 chars). */
const MYSQL_LOCK_NAME = sql`concat('altis_mig_', left(sha2(database(), 256), 40))`;

/**
 * Kysely's MySQL adapter with the migration lock of ruling R26: named after the database, waited for at most
 * `timeoutSeconds`, and checked. Kysely's stock lock uses one constant name for every database on the server and
 * carries on unlocked when GET_LOCK times out. Used only by the runner's Migrator ({@link withAdapter}).
 */
class DatabaseScopedMysqlAdapter extends MysqlAdapter {
  readonly #timeoutSeconds: number;
  readonly #progress: Progress;

  constructor(timeoutSeconds: number, progress: Progress) {
    super();
    this.#timeoutSeconds = timeoutSeconds;
    this.#progress = progress;
  }

  // eslint-disable-next-line @typescript-eslint/no-explicit-any
  override async acquireMigrationLock(db: Kysely<any>): Promise<void> {
    this.#progress.set({ waiting: true });
    let rows: { got: unknown }[];
    try {
      ({ rows } = await sql<{ got: unknown }>`select get_lock(${MYSQL_LOCK_NAME}, ${this.#timeoutSeconds}) as got`.execute(db));
    } finally {
      this.#progress.set({ waiting: false });
    }
    if (Number(rows[0]?.got) === 1) return;
    throw new DomainError('DB_UNAVAILABLE', {
      detail:
        `Kunci migrasi database masih dipegang proses lain setelah ${this.#timeoutSeconds} detik; coba lagi / ` +
        `The database migration lock is still held by another process after ${this.#timeoutSeconds} s; try again`,
      meta: { reason: 'busy', code: 'MIGRATION_LOCK', retryable: true, waitedSeconds: this.#timeoutSeconds },
    });
  }

  // eslint-disable-next-line @typescript-eslint/no-explicit-any
  override async releaseMigrationLock(db: Kysely<any>): Promise<void> {
    await sql`select release_lock(${MYSQL_LOCK_NAME}) as released`.execute(db);
  }
}

/**
 * `db` as the Migrator sees it: the same instance (connections, transactions, plugins), except that its executor
 * reports `adapter` as the dialect adapter, which is where the Migrator takes its migration lock from.
 */
function withAdapter<T>(db: Kysely<T>, adapter: DialectAdapter): Kysely<T> {
  const bound = (target: object, prop: string | symbol): unknown => {
    const value: unknown = Reflect.get(target, prop, target);
    return typeof value === 'function' ? value.bind(target) : value;
  };
  const executor = db.getExecutor();
  const executorView = new Proxy(executor, { get: (target, prop) => (prop === 'adapter' ? adapter : bound(target, prop)) });
  return new Proxy(db, { get: (target, prop) => (prop === 'getExecutor' ? () => executorView : bound(target, prop)) });
}

/** The last migration whose turn started, for failure reports (not cleared at its end: see MigrationFailureMeta). */
interface InFlight {
  name: string | null;
}

/**
 * One migration's turn, on the Migrator's connection (inside its transaction on PostgreSQL): a contract raises
 * min_code_version first, then `up()`, then schema_version moves to this migration's number.
 */
async function applyOne(
  // eslint-disable-next-line @typescript-eslint/no-explicit-any
  db: Kysely<any>,
  dialect: Dialect,
  name: string,
  m: AltisMigration,
  inFlight: InFlight,
  progress: Progress,
): Promise<void> {
  inFlight.name = name;
  progress.report({ migration: name, waiting: false });
  migrateFault(name);
  const meta = metaDb(db);
  const min = m.contract?.minCodeVersion;
  if (min !== undefined) {
    const row = await meta.selectFrom('schema_meta').select('min_code_version').where('id', '=', META_ID).executeTakeFirst();
    const current = row?.min_code_version;
    if (typeof current !== 'string' || !isSemver(current) || compareSemver(min, current) > 0) {
      await meta.updateTable('schema_meta').set({ min_code_version: min }).where('id', '=', META_ID).execute();
    }
  }
  // R25: a turn for the event loop (the migrate.lock heartbeat) around each migration; SQLite also yields
  // inside long runs of statements (sqlite-dialect.ts).
  await yieldToEventLoop();
  await m.up(db, dialect);
  await yieldToEventLoop();
  await meta.updateTable('schema_meta').set({ schema_version: name.slice(0, 4) }).where('id', '=', META_ID).execute();
  progress.report({ migration: name, waiting: false });
}

function provider(dialect: Dialect, p: Plan, inFlight: InFlight, progress: Progress): MigrationProvider {
  return {
    async getMigrations() {
      const migrations: Record<string, Migration> = {};
      for (const [name, m] of p.byName) migrations[name] = { up: (db) => applyOne(db, dialect, name, m, inFlight, progress) };
      return migrations;
    },
  };
}

// ---- Komunitas K1 (edition lane) ----

/** One turn of the other lane: `up()` only (schema_meta follows the core lane alone; a contract is ignored). */
async function applyEditionOne(
  // eslint-disable-next-line @typescript-eslint/no-explicit-any
  db: Kysely<any>,
  dialect: Dialect,
  name: string,
  m: AltisMigration,
  inFlight: InFlight,
  progress: Progress,
): Promise<void> {
  inFlight.name = name;
  progress.report({ migration: name, waiting: false });
  migrateFault(name);
  await yieldToEventLoop();
  await m.up(db, dialect);
  await yieldToEventLoop();
  progress.report({ migration: name, waiting: false });
}

function editionProvider(dialect: Dialect, ep: EditionPlan, inFlight: InFlight, progress: Progress): MigrationProvider {
  return {
    async getMigrations() {
      const migrations: Record<string, Migration> = {};
      for (const [name, m] of ep.byName) migrations[name] = { up: (db) => applyEditionOne(db, dialect, name, m, inFlight, progress) };
      return migrations;
    },
  };
}

type KyselyRun =
  | { applied: string[]; failure: null }
  | {
      applied: string[];
      /** `inBatch`: Kysely reported the failing migration itself (the failure came from inside the batch). */
      failure: { error: unknown; migration: string | null; inBatch: boolean };
    };

/**
 * Runs all pending migrations, or only the next one. A run fails when Kysely reports an error or a migration
 * whose status is Error (a migration that rejected with `undefined` leaves `error` undefined).
 */
async function runKysely(h: MigrationHandle, p: Plan, step: 'all' | 'one', progress: Progress): Promise<KyselyRun> {
  const tables = { table: MIGRATION_TABLE, lock: MIGRATION_LOCK_TABLE };
  return runMigrator(h, p.lockWaitMs, tables, (inFlight) => provider(h.dialect, p, inFlight, progress), step, progress);
}

/**
 * The Kysely Migrator of one lane (its two tables, its provider), with the per-database migration lock on
 * MySQL/MariaDB (DatabaseScopedMysqlAdapter); see {@link runKysely}.
 */
async function runMigrator(
  h: MigrationHandle,
  lockWaitMs: number,
  tables: { table: string; lock: string },
  providerOf: (inFlight: InFlight) => MigrationProvider,
  step: 'all' | 'one',
  progress: Progress,
): Promise<KyselyRun> {
  const inFlight: InFlight = { name: null };
  const db = mysqlFamily(h.dialect)
    ? withAdapter(h.db, new DatabaseScopedMysqlAdapter(Math.ceil(lockWaitMs / 1000), progress))
    : h.db;
  const migrator = new Migrator({
    db,
    provider: providerOf(inFlight),
    migrationTableName: tables.table,
    migrationLockTableName: tables.lock,
    // The order of the applied names was checked by decide() (decideEdition() for the other lane); see the top of
    // this file.
    allowUnorderedMigrations: true,
  });
  const { error, results } = step === 'all' ? await migrator.migrateToLatest() : await migrator.migrateUp();
  const applied = (results ?? []).filter((r) => r.status === 'Success').map((r) => r.migrationName);
  const failed = results?.find((r) => r.status === 'Error');
  if (error === undefined && failed === undefined) return { applied, failure: null };
  // Without results (an error after the last up(): the batch's COMMIT, Kysely's lock release), the last migration
  // started, if any, is the one to name.
  const migration = failed?.migrationName ?? inFlight.name;
  const reason = error ?? new Error(`migration ${migration ?? '?'} rejected without a reason`);
  return { applied, failure: { error: reason, migration, inBatch: failed !== undefined } };
}

/**
 * What stayed applied after a failed run, for {@link MigrationFailureMeta}: read back from schema_migrations when
 * that worked (`reconciled`); otherwise known only on PostgreSQL for a failure inside the batch (its transaction
 * rolled back: nothing); otherwise unknown. Package-internal (tested directly).
 */
export function keptAfterFailure(o: {
  dialect: Dialect;
  before: readonly string[];
  reconciled: { applied: readonly string[] } | null;
  inBatch: boolean;
}): Pick<MigrationFailureMeta, 'applied' | 'appliedVerified'> {
  if (o.reconciled !== null) {
    return { applied: o.reconciled.applied.filter((name) => !o.before.includes(name)), appliedVerified: true };
  }
  if (o.dialect === 'postgres' && o.inBatch) return { applied: [], appliedVerified: true };
  return { applied: null, appliedVerified: false };
}

function mysqlFamily(dialect: Dialect): boolean {
  return dialect === 'mysql' || dialect === 'mariadb';
}

/**
 * The error a failed run rejects with: a DomainError again with its code and `meta` plus
 * {@link MigrationFailureMeta} (so whatever keys on the code still works), anything else a {@link MigrationError}.
 * A DomainError's detail that repeats the text of a raw driver error below it is replaced by that driver error's
 * safe fields, as in safeChain. Package-internal (tested directly).
 */
export function failureOf(error: unknown, meta: MigrationFailureMeta): Error {
  if (!isDomainError(error)) return new MigrationError(error, meta);
  const where = meta.migration === null ? '' : ` [migrasi / migration ${meta.migration}]`;
  const repeated = repeatedIn(error.message, driverErrorsIn(error));
  const detail = repeated === undefined ? (error.detail ?? error.code) : describeDriverError(repeated);
  return new DomainError(error.code, {
    detail: `${detail}${where}`,
    meta: { ...error.meta, ...meta },
    cause: safeChain(error.cause),
  });
}

/** {@link failureOf} for a failed run, with what stayed applied and any secondary error (kept safe). */
function runFailure(
  h: MigrationHandle,
  before: readonly string[],
  failure: { error: unknown; migration: string | null; inBatch: boolean },
  reconciled: { applied: readonly string[] } | null,
  secondary?: unknown,
): Error {
  const kept = keptAfterFailure({ dialect: h.dialect, before, reconciled, inBatch: failure.inBatch });
  const meta: MigrationFailureMeta = { migration: failure.migration, ...kept };
  if (secondary !== undefined) meta.secondary = safeChain(secondary);
  return failureOf(failure.error, meta);
}

// ---------------------------------------------------------------------------------------------------------------
// The mirror

function mirrorPath(dataDir: string): string {
  return dataPath(dataDir, 'releases', MIRROR_FILE);
}

async function writeMirror(dataDir: string, value: SchemaMetaMirror): Promise<void> {
  await atomicWriteJson(mirrorPath(dataDir), { schemaVersion: value.schemaVersion, minCodeVersion: value.minCodeVersion });
}

function parseMirror(raw: unknown): SchemaMetaMirror {
  if (typeof raw !== 'object' || raw === null || Array.isArray(raw)) throw new TypeError('not an object');
  const { schemaVersion, minCodeVersion } = raw as Record<string, unknown>;
  if (typeof schemaVersion !== 'string' || !SCHEMA_VERSION.test(schemaVersion)) throw new TypeError('schemaVersion');
  if (typeof minCodeVersion !== 'string' || !isSemver(minCodeVersion)) throw new TypeError('minCodeVersion');
  return { schemaVersion, minCodeVersion };
}

// ---------------------------------------------------------------------------------------------------------------
// The run

interface LockedResult {
  outcome: MigrationOutcome;
  /** Migrations of this code still pending after the run (0 unless `migrateUpOne` left some). */
  pendingAfter: number;
}

/** Everything that happens under migrate.lock. */
async function underLock(h: MigrationHandle, p: Plan, ep: EditionPlan, step: 'all' | 'one', progress: Progress): Promise<LockedResult> {
  const state = await readState(h);
  const decision = decide(p, state);
  if (decision.mode !== 'migrate') {
    // The database belongs to other code: read only, never the Migrator. The mirror follows the database.
    const current = state.meta ?? { schemaVersion: versionOf(state.applied), minCodeVersion: ANY_CODE };
    await writeMirror(p.dataDir, current);
    return { outcome: { mode: decision.mode, applied: [], ...current, edition: await editionAside(h, ep) }, pendingAfter: 0 };
  }
  const editionDecision = await decideEdition(h, ep);

  await ensureMetaRow(h);
  const first = decision.pending[0];
  if (first !== undefined) await migrateSlowFault(p.dataDir, first, progress);
  const run: KyselyRun = first !== undefined ? await runKysely(h, p, step, progress) : { applied: [], failure: null };

  // schema_meta and the mirror follow what is in schema_migrations, after a failure too (earlier migrations may
  // have been applied). After a failure, an error doing so is carried with the migration's own (meta.secondary),
  // and what stayed applied comes from the database when it could be read back.
  let current: (SchemaMetaMirror & { applied: string[] }) | null = null;
  try {
    current = await reconcileMeta(h, p);
    await writeMirror(p.dataDir, current);
  } catch (error) {
    if (run.failure === null) throw error;
    throw runFailure(h, state.applied, run.failure, current, error);
  }
  if (run.failure !== null) throw runFailure(h, state.applied, run.failure, current);
  const { schemaVersion, minCodeVersion } = current;
  const pendingAfter = decision.pending.length - run.applied.length;
  // One step (migrateUpOne) applies the other lane's migrations only once the core lane has nothing left to do.
  const editionStep = step === 'one' && (run.applied.length > 0 || pendingAfter > 0) ? 'none' : step;
  const lane = await runEditionLane(h, p, ep, editionDecision, editionStep, run.applied, progress);
  const mode = lane.edition.mode === 'schema-ahead' ? 'schema-ahead' : run.applied.length > 0 ? 'migrated' : 'up-to-date';
  return {
    outcome: { mode, applied: run.applied, schemaVersion, minCodeVersion, edition: lane.edition },
    pendingAfter: pendingAfter + lane.pendingAfter,
  };
}

// ---- Komunitas K1 (edition lane) ----

/**
 * The other lane's part of the outcome when the core lane does not run (`too-old`, `schema-ahead`): read only, never
 * run (an empty lane is not read).
 */
async function editionAside(h: MigrationHandle, ep: EditionPlan): Promise<MigrationOutcome['edition']> {
  if (ep.names.length === 0) return { mode: 'empty', applied: [] };
  const applied = await readEditionApplied(h);
  return { mode: applied.some((name) => !ep.byName.has(name)) ? 'schema-ahead' : 'up-to-date', applied: [] };
}

/**
 * The other lane after the core lane (see the top of this file): its second Migrator runs only for a decision with
 * pending migrations and a step that allows it (`none`: one step whose core lane had work). A failure is reported as
 * the core lane's are (failureOf), `meta.applied` holding the core migrations this run applied and the lane's that
 * stayed applied.
 */
async function runEditionLane(
  h: MigrationHandle,
  p: Plan,
  ep: EditionPlan,
  d: EditionDecision,
  step: 'all' | 'one' | 'none',
  coreApplied: readonly string[],
  progress: Progress,
): Promise<{ edition: MigrationOutcome['edition']; pendingAfter: number }> {
  if (d.mode !== 'migrate') return { edition: { mode: d.mode, applied: [] }, pendingAfter: 0 };
  if (d.pending.length === 0 || step === 'none') return { edition: { mode: 'up-to-date', applied: [] }, pendingAfter: d.pending.length };
  const tables = { table: EDITION_TABLE, lock: EDITION_LOCK_TABLE };
  const run = await runMigrator(h, p.lockWaitMs, tables, (inFlight) => editionProvider(h.dialect, ep, inFlight, progress), step, progress);
  if (run.failure !== null) {
    let reconciled: { applied: string[] } | null = null;
    let secondary: unknown;
    try {
      reconciled = { applied: await readEditionApplied(h) };
    } catch (error) {
      secondary = error;
    }
    const kept = keptAfterFailure({ dialect: h.dialect, before: d.applied, reconciled, inBatch: run.failure.inBatch });
    const meta: MigrationFailureMeta = {
      migration: run.failure.migration,
      applied: kept.applied === null ? null : [...coreApplied, ...kept.applied],
      appliedVerified: kept.appliedVerified,
    };
    if (secondary !== undefined) meta.secondary = safeChain(secondary);
    throw failureOf(run.failure.error, meta);
  }
  return {
    edition: { mode: run.applied.length > 0 ? 'migrated' : 'up-to-date', applied: run.applied },
    pendingAfter: d.pending.length - run.applied.length,
  };
}

async function locked(h: MigrationHandle, p: Plan, ep: EditionPlan, step: 'all' | 'one'): Promise<LockedResult> {
  const progress = progressOf(p.onProgress);
  try {
    // R20: schema_tables and schema_meta exist before anything else; R27: then Kysely's two tables. All of it is
    // idempotent and safe from several connections at once.
    await ensureBootstrap(h.db, h.dialect);
    await ensureMigratorTables(h);
    await ensureDir(dataPath(p.dataDir, 'tmp'));
    await ensureDir(dataPath(p.dataDir, 'releases'));
    const staleMs = h.dialect === 'sqlite' ? SQLITE_LOCK_STALE_MS : undefined; // R31
    progress.set({ waiting: true });
    return await withFileLock(
      dataPath(p.dataDir, 'tmp', LOCK_FILE),
      () => {
        progress.set({ waiting: false });
        return underLock(h, p, ep, step, progress);
      },
      { waitMs: p.lockWaitMs, ...(staleMs === undefined ? {} : { staleMs }) },
    );
  } finally {
    progress.stop();
  }
}

/**
 * Brings the database up to date with `o.migrations` (spec §6.4, P3: run after listen()), or reports why not:
 *
 * - `migrated`: the pending migrations were applied (`applied`, in order);
 * - `up-to-date`: nothing was pending;
 * - `schema-ahead`: the database holds migrations this code does not know, and this code is at least
 *   `min_code_version`: normal (a rollback to a compatible release), nothing is run;
 * - `too-old`: this code is older than `min_code_version`: maintenance only (spec §9.7).
 *
 * In every mode `schema_meta` is mirrored to `DATA_DIR/releases/schema-meta.json` ({@link readSchemaMetaMirror}),
 * and `schemaVersion`/`minCodeVersion` are the values of `schema_meta` afterwards. The Kysely Migrator is not even
 * constructed in the `schema-ahead` and `too-old` modes. Locks and per-dialect behaviour: see the top of this file.
 *
 * A failed contract migration: on MySQL/MariaDB and SQLite (no transactional DDL) the `min_code_version` it raised
 * before its DDL stays raised, so older code reports `too-old` (a revert needs the database restored, not just the
 * release pointer); on PostgreSQL the batch's transaction rolls it back with everything else. A contract that
 * refuses to run until its backfill is done must therefore check that before it is applied, not by failing in
 * `up()`.
 *
 * @throws TypeError for invalid options (names, contracts, versions, lengths), before anything is touched
 * @throws DomainError `STATE_CORRUPT` `meta.reason: 'lock_timeout'` when migrate.lock stays held for `lockWaitMs`
 *   (`'lock_io'` when the file system refuses the lock file); DomainError `DB_UNAVAILABLE` `meta {reason: 'busy',
 *   code: 'MIGRATION_LOCK'}` when the MySQL/MariaDB migration lock stays held for `lockWaitMs`
 * @throws DomainError `SCHEMA_CONFLICT` with `meta.reason` `migration_order` (`meta.missing`: a migration of this
 *   code was skipped while later ones were applied), `invalid_schema_meta`, or `class_mismatch` (schema_tables
 *   lists a migrator table under another class, R19)
 * @throws when a migration fails: its DomainError re-created with the same code and {@link MigrationFailureMeta}
 *   added to `meta`, or a {@link MigrationError} for anything else (a driver error reduced to its safe fields).
 *   `meta.migration` names the failing migration (or the last one started, for a failure after it);
 *   `meta.applied` lists what this run applied and kept, read back from the database (none on PostgreSQL, where
 *   the run's batch is rolled back as a whole), or null with `appliedVerified: false` when it cannot be known;
 *   `meta.secondary` is an error from updating schema_meta or the mirror afterwards. Running again continues
 *   there.
 */
export async function runMigrations(h: MigrationHandle, o: MigrationOptions): Promise<MigrationOutcome> {
  const p = plan(o);
  const ep = planEdition(o);
  return (await locked(h, p, ep, 'all')).outcome;
}

/**
 * Applies at most one pending migration (the install wizard migrates step by step, each request short, P9), under
 * the same locks and rules as {@link runMigrations}.
 *
 * @returns `{done: false, applied}` when more migrations are pending after `applied`; `{done: true, applied}` for
 *   the last one; `{done: true}` when nothing was pending or the database is ahead of this code (`schema-ahead`)
 * @throws DomainError `SCHEMA_TOO_NEW` (`meta: {appVersion, schemaVersion, minCodeVersion}`) when this code is
 *   older than `min_code_version` (`too-old`); otherwise as {@link runMigrations}
 */
export async function migrateUpOne(h: MigrationHandle, o: MigrationOptions): Promise<{ done: boolean; applied?: string }> {
  const p = plan(o);
  const ep = planEdition(o);
  const { outcome, pendingAfter } = await locked(h, p, ep, 'one');
  if (outcome.mode === 'too-old') {
    const { schemaVersion, minCodeVersion } = outcome;
    throw new DomainError('SCHEMA_TOO_NEW', {
      detail:
        `Skema database (${schemaVersion}) memerlukan ALTIS ${minCodeVersion} atau lebih baru; versi ini ${p.appVersion} / ` +
        `The database schema (${schemaVersion}) needs ALTIS ${minCodeVersion} or newer; this is ${p.appVersion}`,
      meta: { appVersion: p.appVersion, schemaVersion, minCodeVersion },
    });
  }
  // The core lane's migration, or (once the core lane is done) the other lane's.
  const applied = outcome.applied[0] ?? outcome.edition.applied[0];
  return applied === undefined ? { done: true } : { done: pendingAfter === 0, applied };
}

/**
 * Reads `DATA_DIR/releases/schema-meta.json` (falling back to its `.bak` copy when it is corrupt). Fields other
 * than `schemaVersion` and `minCodeVersion` are ignored, so a newer writer may add some.
 *
 * @returns the mirror, or null when there is none yet
 * @throws DomainError `STATE_CORRUPT` when the file and its `.bak` both exist but neither is usable
 */
export async function readSchemaMetaMirror(dataDir: string): Promise<SchemaMetaMirror | null> {
  return readJsonWithBak(mirrorPath(dataDir), parseMirror);
}
