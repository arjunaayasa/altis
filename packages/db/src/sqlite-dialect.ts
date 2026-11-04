import { DomainError } from '@altis/shared';
import {
  CompiledQuery,
  SqliteDialect,
  SqliteDriver,
  type DatabaseConnection,
  type Driver,
  type QueryResult,
  type SqliteDatabase,
  type SqliteDialectConfig,
} from 'kysely';
import type { DatabaseSync, SQLInputValue } from 'node:sqlite';
import { yieldIfDue } from './yield.js';

// SQLite through node:sqlite (spec §4.3, P20). node:sqlite is only ever loaded with `await import()`: it is not
// there on every Node version, and the bundle keeps it external.

/** The P20 pragmas. busy_timeout comes first so that switching to WAL waits for a lock instead of failing. */
const PRAGMAS = [
  'PRAGMA busy_timeout = 5000',
  'PRAGMA journal_mode = WAL',
  'PRAGMA synchronous = FULL',
  'PRAGMA foreign_keys = ON',
] as const;

/**
 * A connection that gives the event loop a turn before a statement (and between streamed rows) whenever the last
 * one is a second old (ruling R25, see yield.ts): node:sqlite is synchronous, so without it a long run of
 * statements would starve every timer, the migrate.lock heartbeat included.
 */
class YieldingConnection implements DatabaseConnection {
  readonly #inner: DatabaseConnection;

  constructor(inner: DatabaseConnection) {
    this.#inner = inner;
  }

  async executeQuery<R>(
    compiledQuery: CompiledQuery,
    options?: Parameters<DatabaseConnection['executeQuery']>[1],
  ): Promise<QueryResult<R>> {
    await yieldIfDue();
    return this.#inner.executeQuery<R>(compiledQuery, options);
  }

  async *streamQuery<R>(
    compiledQuery: CompiledQuery,
    chunkSize: number,
    options?: Parameters<DatabaseConnection['streamQuery']>[2],
  ): AsyncIterableIterator<QueryResult<R>> {
    for await (const chunk of this.#inner.streamQuery<R>(compiledQuery, chunkSize, options)) {
      yield chunk;
      await yieldIfDue();
    }
  }
}

/**
 * Kysely's SQLite driver with two changes: transactions start with `BEGIN IMMEDIATE` (P20), which takes the write
 * lock up front (a deferred `BEGIN` that later tries to write while another process holds the lock fails with
 * SQLITE_BUSY at once instead of waiting for busy_timeout); and its one connection yields to the event loop at
 * least every second ({@link YieldingConnection}).
 */
class ImmediateSqliteDriver extends SqliteDriver {
  #connection: DatabaseConnection | undefined;

  override async acquireConnection(): Promise<DatabaseConnection> {
    const connection = await super.acquireConnection(); // always the same one
    this.#connection ??= new YieldingConnection(connection);
    return this.#connection;
  }

  override async beginTransaction(connection: DatabaseConnection): Promise<void> {
    // A constant statement, compiled the way Kysely's own driver compiles its `begin`.
    await connection.executeQuery(CompiledQuery.raw('begin immediate'));
  }
}

/** {@link SqliteDialect} with {@link ImmediateSqliteDriver}. */
export class AltisSqliteDialect extends SqliteDialect {
  readonly #config: SqliteDialectConfig;

  constructor(config: SqliteDialectConfig) {
    super(config);
    this.#config = config;
  }

  override createDriver(): Driver {
    return new ImmediateSqliteDriver(this.#config);
  }
}

/**
 * Adapts a node:sqlite `DatabaseSync` to the better-sqlite3-shaped interface Kysely's SQLite dialect expects:
 * parameters are spread instead of passed as an array, and `reader` (does the statement return rows?) comes from
 * the statement's result columns.
 */
export function adaptDatabaseSync(database: DatabaseSync): SqliteDatabase {
  return {
    close: () => database.close(),
    prepare(sqlText) {
      const stmt = database.prepare(sqlText);
      return {
        reader: stmt.columns().length > 0,
        all: (parameters) => stmt.all(...(parameters as SQLInputValue[])),
        run: (parameters) => stmt.run(...(parameters as SQLInputValue[])),
        iterate: (parameters) => stmt.iterate(...(parameters as SQLInputValue[])),
      };
    },
  };
}

/**
 * Opens (creating if needed) the SQLite database `file` and applies the P20 pragmas. The parent directory must
 * exist. Integers come back as JS numbers; one outside the safe range throws instead of losing precision.
 *
 * @throws DomainError `DB_UNSUPPORTED` when node:sqlite cannot be loaded or the file system does not allow WAL
 */
export async function openSqlite(file: string): Promise<DatabaseSync> {
  let mod: typeof import('node:sqlite');
  try {
    mod = await import('node:sqlite');
  } catch (error) {
    throw new DomainError('DB_UNSUPPORTED', {
      detail:
        `SQLite memerlukan modul node:sqlite (Node ${process.versions.node} tidak menyediakannya) / ` +
        `SQLite needs the node:sqlite module, which Node ${process.versions.node} does not provide`,
      meta: { dialect: 'sqlite', reason: 'no_node_sqlite' },
      cause: error,
    });
  }
  const database = new mod.DatabaseSync(file);
  try {
    for (const pragma of PRAGMAS) database.exec(pragma);
    const mode = database.prepare('PRAGMA journal_mode').get()?.['journal_mode'];
    if (mode !== 'wal') {
      throw new DomainError('DB_UNSUPPORTED', {
        detail:
          `Sistem berkas tidak mendukung mode WAL SQLite (journal_mode=${String(mode)}) / ` +
          `The file system does not support SQLite WAL mode (journal_mode=${String(mode)})`,
        meta: { dialect: 'sqlite', reason: 'no_wal', journalMode: String(mode) },
      });
    }
  } catch (error) {
    database.close();
    throw error;
  }
  return database;
}
