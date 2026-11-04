import { statOrNull, withTempSibling, type DataPath } from '@altis/platform';
import { DomainError } from '@altis/shared';
import { sql } from 'kysely';
import type { DatabaseSync } from 'node:sqlite';
import { handleOf, sqliteDatabaseOf, sqliteOpened, type DbHandle } from './connect.js';
import { normalizeDbError } from './db-errors.js';
import { openSqlite } from './sqlite-dialect.js';
import { assertOutsideTx } from './tx.js';

// SQLite files other than the live database (spec §9.9, §9.10 on SQLite; S14): a backup copies the live file into
// `backups/<id>/.work/` and exports from the copy; a restore loads into a work file under `db/` and swaps it in
// (Task 25). Paths are DataPaths (dataPath and the typed builders), so a file outside DATA_DIR cannot be named.
// node:sqlite is loaded with `await import()` only (global constraints).

/** How long a statement waits for another connection's lock (the P20 busy_timeout of the live database). */
const BUSY_TIMEOUT_MS = 5000;

type SqliteModule = typeof import('node:sqlite');

async function loadSqlite(): Promise<SqliteModule> {
  try {
    return await import('node:sqlite');
  } catch (error) {
    throw new DomainError('DB_UNSUPPORTED', {
      detail:
        `SQLite memerlukan modul node:sqlite (Node ${process.versions.node} tidak menyediakannya) / ` +
        `SQLite needs the node:sqlite module, which Node ${process.versions.node} does not provide`,
      meta: { dialect: 'sqlite', reason: 'no_node_sqlite' },
      cause: error,
    });
  }
}

/** Opens `file` read-only: no journal mode change (that writes), every write refused (`query_only`). */
async function openReadOnly(file: string): Promise<DatabaseSync> {
  const mod = await loadSqlite();
  const database = new mod.DatabaseSync(file, { readOnly: true });
  try {
    database.exec(`PRAGMA busy_timeout = ${BUSY_TIMEOUT_MS}`);
    database.exec('PRAGMA query_only = ON');
    database.exec('PRAGMA foreign_keys = ON');
  } catch (error) {
    database.close();
    throw error;
  }
  return database;
}

/**
 * A handle on the SQLite file `path` (one connection, pool 1, like the live SQLite handle): a backup's copy
 * (`backups/<id>/.work/snapshot.sqlite`) or a restore's work file (`db/restore.sqlite`).
 *
 * - Read-write (default): the P20 pragmas of the live database (busy_timeout, WAL, synchronous FULL, foreign keys);
 *   transactions `BEGIN IMMEDIATE`. With `create` a missing file is created (its folder must exist).
 * - `readOnly`: opened read-only, `query_only` on: every write is refused. The journal mode is left as the file has
 *   it (sqliteSnapshotTo leaves its copies in rollback mode, so nothing is created beside them).
 *
 * Such a handle is a second handle of the process: it never writes audit entries (L41, connect.ts).
 *
 * @throws TypeError for `readOnly` together with `create`
 * @throws an Error with `code: 'ENOENT'` when the file does not exist and `create` is not set
 * @throws DomainError `STATE_CORRUPT` (`meta.reason: 'not_a_file'`) when `path` is a folder or anything but a file;
 *   `DB_UNSUPPORTED` when node:sqlite is missing or the file system refuses WAL; database errors normalized
 */
export async function connectSqliteFile(path: DataPath, o: { readOnly?: boolean; create?: boolean } = {}): Promise<DbHandle> {
  const readOnly = o.readOnly === true;
  const create = o.create === true;
  if (readOnly && create) throw new TypeError('connectSqliteFile(): a read-only handle cannot create its file');
  const info = await statOrNull(path);
  if (info === null && !create) {
    throw Object.assign(new Error(`ENOENT: no SQLite file at ${path}`), { code: 'ENOENT', path });
  }
  if (info !== null && info.kind !== 'file') {
    throw new DomainError('STATE_CORRUPT', {
      detail: `${path} bukan berkas SQLite / ${path} is not a SQLite file`,
      meta: { reason: 'not_a_file' },
    });
  }
  let database: DatabaseSync;
  try {
    database = readOnly ? await openReadOnly(path) : await openSqlite(path);
  } catch (error) {
    throw normalizeDbError(error);
  }
  return handleOf(sqliteOpened(database));
}

/**
 * Copies the SQLite database of `h` into `dest`, consistently, while the server keeps using `h` (spec §9.9
 * `snapshot` on SQLite): node:sqlite's `backup()` (Node ≥ 22.16) when it is there and `h` is a handle connect() or
 * connectSqliteFile() opened, else `VACUUM INTO`. The copy is written to a hidden temporary sibling of `dest`
 * (withTempSibling, S14), switched to rollback-journal mode (one self-contained file, which a read-only handle can
 * open without creating anything beside it), fsynced and renamed over `dest`.
 *
 * The copy holds `h`'s one connection (Kysely's, as a transaction does) from start to end, so it never meets a
 * transaction open on it: node:sqlite's backup() fails ("not an error", SQLITE_LOCKED underneath) when one of its steps
 * finds a write transaction of its own connection open, and the server's transactions keep that connection across
 * awaits. A request that needs the database meanwhile waits for the copy (one backup() step of every page, in the
 * thread pool: the event loop keeps turning), and a transaction under way when the copy is asked for ends first. A
 * write by another connection would make SQLite restart the copy (there is none: one connection per process, P20).
 * VACUUM INTO runs as one statement and blocks the event loop while it copies.
 *
 * @throws TypeError for a handle of another dialect, or inside a withTx callback (VACUUM cannot run in a transaction)
 * @throws DomainError `DISK_QUOTA` (P21) when the disk or quota is full (`ENOSPC`/`EDQUOT`, or SQLite's SQLITE_FULL
 *   as `ENOSPC`); the temporary copy is removed and `dest` keeps what it held
 */
export async function sqliteSnapshotTo(h: DbHandle, dest: DataPath): Promise<void> {
  if (h.dialect !== 'sqlite') throw new TypeError(`sqliteSnapshotTo() copies a SQLite database, not ${String(h.dialect)}`);
  const mod = await loadSqlite();
  const hasBackup = typeof (mod as { backup?: unknown }).backup === 'function';
  await sqliteSnapshotWith(h, dest, hasBackup && sqliteDatabaseOf(h.db) !== undefined ? 'backup' : 'vacuum');
}

/**
 * The pages node:sqlite's backup() copies per step: all of them in one step (sqlite3_backup_step with a page count no
 * database reaches). A negative rate meant the same to SQLite, but Node 26.12 refuses one ("options.rate must be a
 * positive integer", ERR_OUT_OF_RANGE); the int32 maximum passes every Node release's check.
 */
const BACKUP_ALL_PAGES = 2_147_483_647;

/** How often {@link awake} turns the event loop while a backup() runs. */
const AWAKE_INTERVAL_MS = 10;

/**
 * `copy` (node:sqlite's backup()), awaited on an event loop that keeps turning. backup() settles its promise without
 * waking the event loop (seen on Node 26.5): on a loop that only waits for I/O (a server on a quiet night, a CLI
 * holding an idle socket) the caller would resume only at the next unrelated event, seconds or minutes later. An
 * unreferenced interval that does nothing turns the loop every 10 ms while the copy runs, so the continuation runs
 * at once; it never keeps the process alive and is cleared when the copy ends.
 */
async function awake<T>(copy: Promise<T>): Promise<T> {
  const ticker = setInterval(() => undefined, AWAKE_INTERVAL_MS);
  ticker.unref();
  try {
    return await copy;
  } finally {
    clearInterval(ticker);
  }
}

/** {@link sqliteSnapshotTo} with the copy method chosen by the caller. Package-internal (tests both methods). */
export async function sqliteSnapshotWith(h: DbHandle, dest: DataPath, method: 'backup' | 'vacuum'): Promise<void> {
  if (h.dialect !== 'sqlite') throw new TypeError(`sqliteSnapshotTo() copies a SQLite database, not ${String(h.dialect)}`);
  assertOutsideTx('sqliteSnapshotTo');
  const mod = await loadSqlite();
  const database = sqliteDatabaseOf(h.db);
  if (method === 'backup' && database === undefined) {
    throw new TypeError('sqliteSnapshotTo(): backup() needs a handle opened by connect() or connectSqliteFile()');
  }
  await withTempSibling(dest, async (tmp) => {
    try {
      await h.db.connection().execute(async (held) => {
        if (method === 'backup' && database !== undefined) await awake(mod.backup(database, tmp, { rate: BACKUP_ALL_PAGES }));
        else await sql`vacuum into ${tmp}`.execute(held);
      });
      const copy = new mod.DatabaseSync(tmp);
      try {
        copy.exec('PRAGMA journal_mode = DELETE');
      } finally {
        copy.close();
      }
    } catch (error) {
      throw asNoSpace(error);
    }
  });
}

/**
 * Moves everything the write-ahead log of the SQLite file behind `h` holds into the file itself and truncates the log
 * to nothing (`wal_checkpoint(TRUNCATE)`): before a file is renamed or copied as a whole (the restore's swap, Task 25),
 * so that what it holds does not depend on its `-wal`. The engine-specific statement lives here, beside the other
 * SQLite file helpers, not in packages/core (dialect boundary).
 *
 * @throws TypeError for a handle of another dialect
 */
export async function checkpointSqliteFile(h: DbHandle): Promise<void> {
  if (h.dialect !== 'sqlite') throw new TypeError(`checkpointSqliteFile() checkpoints a SQLite file, not ${String(h.dialect)}`);
  await sql`pragma wal_checkpoint(TRUNCATE)`.execute(h.db);
}

/** SQLite's primary result code SQLITE_FULL: "database or disk is full". */
const SQLITE_FULL = 13;

/**
 * SQLITE_FULL from node:sqlite (`errcode`, the primary code in its low byte) as an `ENOSPC` error, which
 * withTempSibling turns into DomainError `DISK_QUOTA` after removing the partial copy (P21: SQLite reports a full disk
 * and an exhausted quota alike); any other error as it is.
 */
function asNoSpace(error: unknown): unknown {
  const errcode = typeof error === 'object' && error !== null ? (error as { errcode?: unknown }).errcode : undefined;
  if (typeof errcode !== 'number' || (errcode & 0xff) !== SQLITE_FULL) return error;
  return Object.assign(new Error('ENOSPC: SQLite reports the database or disk is full (SQLITE_FULL)', { cause: error }), {
    code: 'ENOSPC',
  });
}
