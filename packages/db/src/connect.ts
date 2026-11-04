import {
  dataPath,
  ensureDir,
  lockHostIdentity,
  poolSize,
  processStartMs,
  readBytes,
  removeFile,
  sqliteAllowed,
  statOrNull,
  writeBytesAtomic,
  type ConnectionLimits,
  type DataPath,
  type PoolPurpose,
  type Runtime,
} from '@altis/platform';
import { DomainError } from '@altis/shared';
import {
  Kysely,
  MysqlDialect,
  PostgresDialect,
  type DatabaseConnection,
  type Dialect as KyselyDialect,
  type MysqlPool,
  type MysqlPoolConnection,
  type PostgresPool,
  type PostgresPoolClient,
} from 'kysely';
import { createPool, type Pool, type PoolConnection, type PoolOptions } from 'mysql2';
import { createConnection as createMysqlConnection } from 'mysql2/promise';
import type { DatabaseSync } from 'node:sqlite';
import pg from 'pg';
import { normalizeConnectError, normalizeDbError } from './db-errors.js';
import { GuardedDialect, endsSession, type DiscardingDriver } from './driver-guard.js';
import type { DB } from './schema.js';
import { AltisSqliteDialect, adaptDatabaseSync, openSqlite } from './sqlite-dialect.js';

export const DIALECTS = ['mysql', 'mariadb', 'postgres', 'sqlite'] as const;

export type Dialect = (typeof DIALECTS)[number];

/**
 * Database settings from `config.json`. `mysql` and `mariadb` share the MySQL driver; either one may point at a
 * MySQL or a MariaDB server (`checkServer` reports which one it found). For `sqlite` only `file` applies, and the
 * only accepted name is `altis.sqlite` (the file always lives at `DATA_DIR/db/altis.sqlite`).
 */
export interface DbConfig {
  dialect: Dialect;
  /** Default `localhost`. */
  host?: string;
  /** Default 3306 (MySQL/MariaDB) or 5432 (PostgreSQL). */
  port?: number;
  user?: string;
  password?: string;
  database?: string;
  file?: string;
}

export interface ConnectOptions {
  runtime: Runtime;
  purpose: PoolPurpose;
  /** DATA_DIR: the SQLite database lives in its `db` area. */
  dataDir: string;
  /** How long opening a server connection may take, in ms (default 10000). */
  connectTimeoutMs?: number;
  /**
   * Called with the error of a pooled connection that is idle (L19): a PostgreSQL client whose session the server
   * ended (pg-pool's `error` event; the pool drops the client), a mysql2 connection closed by `wait_timeout`, a restart
   * or the network while it waited in the pool (mysql2 drops it). The server passes `log.warn`. Without it such
   * errors are dropped; either way they never crash the process, and the next statement gets a fresh connection.
   * An error of a checked-out connection is not passed here: the statement it fails reports it. If the callback
   * throws, that error is dropped too.
   */
  onIdleError?: (error: unknown) => void;
}

/**
 * An open database: the Kysely instance plus what the pool was sized from.
 *
 * One `DbHandle` per process for writes (L41): the server, a CLI command and the job runner each write through the
 * one handle connect() gave them. A second handle on the same database (readSnapshot's dedicated reader,
 * `connect(cfg, {purpose: 'cli'})`, pool 1, P17; a restore's work file, connectSqliteFile) never writes audit
 * entries: two handles whose transactions nest and both append audit wait on each other for audit_head's row lock,
 * for ever on PostgreSQL and 50 s on MySQL/MariaDB.
 */
export interface DbHandle {
  db: Kysely<DB>;
  dialect: Dialect;
  /** As read through the probe connection; SQLite reports `{maxUserConnections: 0, maxConnections: 1}`. */
  limits: ConnectionLimits;
  /** Connections in the pool (P17); always 1 for SQLite. */
  poolSize: number;
  /**
   * Closes the pool (or the SQLite file), also when the handle never ran a statement. Calling it again is harmless.
   */
  close(): Promise<void>;
}

/** Every MySQL/MariaDB connection runs this first (global constraints, spec §6.2). */
export const MYSQL_SQL_MODE = 'STRICT_ALL_TABLES,NO_ZERO_DATE,NO_ENGINE_SUBSTITUTION';
const SET_SQL_MODE = `SET SESSION sql_mode = '${MYSQL_SQL_MODE}'`;

const DEFAULT_CONNECT_TIMEOUT_MS = 10_000;
const IDLE_TIMEOUT_MS = 30_000;
/**
 * Callers that may wait for a pooled MySQL/MariaDB connection at once; one more is refused at once with
 * DB_UNAVAILABLE `busy` (`POOL_QUEUE_FULL`), so a stalled server cannot make requests pile up without bound.
 */
const POOL_QUEUE_LIMIT = 50;
/**
 * A caller waits at most the connect timeout plus this for a pooled MySQL/MariaDB connection (then DB_UNAVAILABLE
 * `busy`, `POOL_ACQUIRE_TIMEOUT`; the equivalent of pg-pool's connectionTimeoutMillis). The margin lets a caller
 * whose own connection attempt is under way see that attempt's connect timeout (`ETIMEDOUT`) first.
 */
const ACQUIRE_GRACE_MS = 1000;
const SQLITE_FILE = 'altis.sqlite';
const SQLITE_LIMITS: ConnectionLimits = Object.freeze({ maxUserConnections: 0, maxConnections: 1 });

function invalid(field: string, detail: string): DomainError {
  return new DomainError('INVALID_CONFIG', { detail, meta: { field } });
}

interface ServerSettings {
  host: string;
  port: number;
  user: string;
  password: string;
  database: string;
  connectTimeoutMs: number;
}

/** Validates the server fields of `cfg` and fills in the defaults. */
function serverSettings(cfg: DbConfig, o: ConnectOptions, defaultPort: number): ServerSettings {
  const host = cfg.host ?? 'localhost';
  if (typeof host !== 'string' || host.trim() === '') {
    throw invalid('host', 'db.host harus berisi nama host / db.host must be a host name');
  }
  const port = cfg.port ?? defaultPort;
  if (!Number.isInteger(port) || port < 1 || port > 65535) {
    throw invalid('port', 'db.port harus bilangan bulat 1–65535 / db.port must be an integer from 1 to 65535');
  }
  if (typeof cfg.user !== 'string' || cfg.user === '') {
    throw invalid('user', 'db.user wajib diisi / db.user is required');
  }
  if (cfg.password !== undefined && typeof cfg.password !== 'string') {
    throw invalid('password', 'db.password harus berupa teks / db.password must be a string');
  }
  if (typeof cfg.database !== 'string' || cfg.database === '') {
    throw invalid('database', 'db.database wajib diisi / db.database is required');
  }
  const timeout = o.connectTimeoutMs ?? DEFAULT_CONNECT_TIMEOUT_MS;
  const connectTimeoutMs = Number.isFinite(timeout) && timeout > 0 ? Math.ceil(timeout) : DEFAULT_CONNECT_TIMEOUT_MS;
  return { host, port, user: cfg.user, password: cfg.password ?? '', database: cfg.database, connectTimeoutMs };
}

function toCount(value: unknown): number {
  const n = Number(value);
  return Number.isFinite(n) ? n : Number.NaN; // NaN gives the smallest pool (poolSize)
}

/**
 * On while a pool facade releases a connection whose session ended: the facade then closes the connection instead of
 * pooling it again (see {@link withDiscard}).
 */
interface DiscardSwitch {
  on: boolean;
}

/**
 * `dialect` whose driver also has discardConnection ({@link DiscardingDriver}), which the driver layer calls for a
 * connection whose session ended: it releases the connection through Kysely's driver with `discard` switched on, so
 * the pool facade (discardableMysqlPool, discardingDeadClients) closes it instead of pooling it again. Kysely's MySQL
 * and PostgreSQL drivers call the pool client's release() synchronously inside releaseConnection (kysely 0.29.7,
 * pinned), so exactly that release sees the switch. It is off again as soon as releaseConnection has returned its
 * promise: a Kysely that released later would only release the connection as before, never close another one
 * (test/unit/discard-facades.test.ts, in `pnpm test`, and retry.test.ts on MariaDB would then fail).
 */
function withDiscard(dialect: KyselyDialect, discard: DiscardSwitch): KyselyDialect {
  return {
    createDriver() {
      const driver = dialect.createDriver();
      const discardConnection = (connection: DatabaseConnection): Promise<void> => {
        discard.on = true;
        try {
          return driver.releaseConnection(connection);
        } finally {
          discard.on = false;
        }
      };
      return Object.assign(driver, { discardConnection } satisfies Pick<DiscardingDriver, 'discardConnection'>);
    },
    createQueryCompiler: () => dialect.createQueryCompiler(),
    createAdapter: () => dialect.createAdapter(),
    createIntrospector: (db) => dialect.createIntrospector(db),
  };
}

/**
 * What a dialect's connect function opened: the handle without close(), plus `release`, which closes the pool (or
 * the SQLite file) whether or not Kysely ever initialized its driver. Kysely's destroy() does nothing for a driver
 * that never ran a statement, which would leave the SQLite file open (EBUSY on Windows when it is replaced) and
 * mysql2's idle-connection timer running (it keeps the process alive). Idempotent: after Kysely's own destroy() it
 * does nothing more. Package-internal (sqlite-file.ts opens other SQLite files the same way).
 */
export interface Opened extends Omit<DbHandle, 'close'> {
  release(): Promise<void>;
}

/** Passes `error` to `onIdleError`, if any; a callback that throws is ignored (it must not crash the process). */
function reportIdle(onIdleError: ConnectOptions['onIdleError'], error: unknown): void {
  if (onIdleError === undefined) return;
  try {
    onIdleError(error);
  } catch {
    // the logger failed: the connection error is dropped, as without a callback
  }
}

/** Runs `close` and ignores its failure: a probe that already has its answer (or its error) keeps it. */
async function quietly(close: () => Promise<unknown>): Promise<void> {
  try {
    await close();
  } catch {
    // the original error matters more
  }
}

// ---------------------------------------------------------------------------------------------------------------
// MySQL / MariaDB

function mysqlBase(s: ServerSettings): PoolOptions {
  return {
    host: s.host,
    port: s.port,
    user: s.user,
    password: s.password,
    database: s.database,
    charset: 'utf8mb4',
    timezone: 'Z',
    supportBigNumbers: true,
    bigNumberStrings: false,
    connectTimeout: s.connectTimeoutMs,
  };
}

/**
 * The pool's 'connection' listener: runs `statement` (the `SET sql_mode`) first on every new connection. mysql2
 * runs a connection's commands one after another, so it precedes every query made on that connection.
 *
 * A connection the statement failed on must not be used (it would run without strict mode). Its socket is
 * destroyed with the statement's error: mysql2 then fails the commands queued behind it with that error and
 * drops the connection from the pool. (`conn.destroy()` alone ends the socket quietly, and the next command
 * fails with an unrelated "write after end".)
 */
export function sessionSetup(statement: string): (conn: PoolConnection) => void {
  return (conn) => {
    conn.query(statement, (error) => {
      if (error === null) return;
      const socket = (conn as unknown as { stream?: { destroy(e: Error): void } }).stream;
      if (socket !== undefined && typeof socket.destroy === 'function') socket.destroy(error);
      else conn.destroy();
    });
  };
}

/** Reads the connection limits through one short-lived connection (P17). */
async function probeMysql(s: ServerSettings): Promise<ConnectionLimits> {
  const conn = await createMysqlConnection(mysqlBase(s));
  try {
    const [rows] = await conn.query('SELECT @@max_user_connections AS muc, @@max_connections AS mc');
    const row = (rows as Record<string, unknown>[])[0] ?? {};
    return { maxUserConnections: toCount(row['muc']), maxConnections: toCount(row['mc']) };
  } finally {
    await quietly(() => conn.end());
  }
}

/**
 * mysql2's pool as Kysely sees it: each connection is handed out behind a proxy (one per connection, so Kysely keeps
 * one wrapper per connection) whose release() closes the connection while `discard` is on. mysql2 then drops it from
 * the pool, and a waiting acquirer gets a new connection.
 *
 * mysql2 drops a connection by itself only after a fatal error (a socket error, the server closing the socket).
 * After a server error that ends the session without being fatal for mysql2 (1053 shutdown, 1153 packet too large,
 * MariaDB 1927, MySQL 4031), the server closes the socket only afterwards: released before that close is processed,
 * the connection would be pooled again and handed out dead.
 */
function discardableMysqlPool(
  pool: Pool,
  discard: DiscardSwitch,
  endPool: () => Promise<void>,
  acquireTimeoutMs: number,
): MysqlPool {
  const views = new WeakMap<PoolConnection, MysqlPoolConnection>();
  const view = (conn: PoolConnection): MysqlPoolConnection => {
    let proxy = views.get(conn);
    if (proxy === undefined) {
      proxy = new Proxy(conn, {
        get(target, prop) {
          if (prop === 'release') return () => (discard.on ? target.destroy() : target.release());
          const value: unknown = Reflect.get(target, prop, target);
          return typeof value === 'function' ? value.bind(target) : value;
        },
      }) as unknown as MysqlPoolConnection;
      views.set(conn, proxy);
    }
    return proxy;
  };
  return {
    getConnection: (callback) => {
      // mysql2 lets a caller wait in its queue for ever: give up after acquireTimeoutMs.
      let waiting = true;
      const timer = setTimeout(() => {
        waiting = false;
        const error = Object.assign(new Error(`no pooled connection became free within ${acquireTimeoutMs} ms`), {
          code: 'POOL_ACQUIRE_TIMEOUT',
        });
        callback(error, undefined as unknown as MysqlPoolConnection);
      }, acquireTimeoutMs);
      pool.getConnection((error, conn) => {
        if (!waiting) {
          // The caller has given up: a connection that still comes goes straight back to the pool.
          if (error === null) conn.release();
          return;
        }
        waiting = false;
        clearTimeout(timer);
        callback(error, error === null ? view(conn) : (conn as unknown as MysqlPoolConnection));
      });
    },
    end: (callback) => {
      endPool().then(() => callback(null), callback);
    },
  };
}

/** `end` called once however often it is called (Kysely's destroy() and DbHandle.close() both end the pool). */
function once(end: () => Promise<void>): () => Promise<void> {
  let ending: Promise<void> | undefined;
  return () => (ending ??= end());
}

/** mysql2's pool.end() as a promise. */
function endMysqlPool(pool: Pool): Promise<void> {
  return new Promise((resolve, reject) => pool.end((error) => (error ? reject(error) : resolve())));
}

async function connectMysql(cfg: DbConfig, o: ConnectOptions): Promise<Opened> {
  const s = serverSettings(cfg, o, 3306);
  const limits = await probeMysql(s);
  const size = poolSize(o.runtime, o.purpose, limits);
  const pool = createPool({
    ...mysqlBase(s),
    connectionLimit: size,
    maxIdle: 1,
    idleTimeout: IDLE_TIMEOUT_MS,
    enableKeepAlive: true,
    waitForConnections: true,
    queueLimit: POOL_QUEUE_LIMIT,
  });
  pool.on('connection', sessionSetup(SET_SQL_MODE));
  reportIdleConnectionErrors(pool, o.onIdleError);
  const end = once(() => endMysqlPool(pool));
  const acquireTimeoutMs = s.connectTimeoutMs + ACQUIRE_GRACE_MS;
  const db = new Kysely<DB>({ dialect: guardedMysqlDialect(pool, { end, acquireTimeoutMs }) });
  return { db, dialect: cfg.dialect, limits, poolSize: size, release: end };
}

/**
 * Gives every connection of the mysql2 pool a lasting `error` listener (L19): the error of a connection waiting idle
 * in the pool goes to `onIdleError`, the error of a checked-out one (between `acquire` and `release`) is left to the
 * statement it fails. mysql2 drops a failed connection itself, through a `once('error')` listener of its own; a
 * second error event would find no listener and crash the process.
 */
function reportIdleConnectionErrors(pool: Pool, onIdleError: ConnectOptions['onIdleError']): void {
  const checkedOut = new WeakSet<PoolConnection>();
  pool.on('acquire', (conn: PoolConnection) => checkedOut.add(conn));
  pool.on('release', (conn: PoolConnection) => checkedOut.delete(conn));
  pool.on('connection', (conn: PoolConnection) => {
    conn.on('error', (error: unknown) => {
      if (!checkedOut.has(conn)) reportIdle(onIdleError, error);
    });
  });
}

/** Options of the pool dialects; the defaults suit tests over a fake pool. */
export interface GuardedPoolOptions {
  /** Ends the pool; called when Kysely destroys its driver. Default: the pool's own end(). */
  end?: () => Promise<void>;
  /**
   * MySQL/MariaDB: how long a caller waits for a pooled connection before DB_UNAVAILABLE `busy`
   * (`POOL_ACQUIRE_TIMEOUT`). Default: the default connect timeout plus 1 s. (pg-pool bounds the wait itself, with
   * connectionTimeoutMillis.)
   */
  acquireTimeoutMs?: number;
}

/**
 * The dialect over a mysql2 pool: Kysely's MysqlDialect behind the pool facade and the driver layer. mysql2 drops a
 * pooled connection from the pool as soon as it fails fatally; the driver layer has the others whose session ended
 * closed on release (discardableMysqlPool), so a retry or the next acquirer gets a fresh one. Package-internal
 * (tested directly over a fake pool).
 */
export function guardedMysqlDialect(pool: Pool, o: GuardedPoolOptions = {}): GuardedDialect {
  const discard: DiscardSwitch = { on: false };
  const end = o.end ?? (() => endMysqlPool(pool));
  const acquireTimeoutMs = o.acquireTimeoutMs ?? DEFAULT_CONNECT_TIMEOUT_MS + ACQUIRE_GRACE_MS;
  const facade = discardableMysqlPool(pool, discard, end, acquireTimeoutMs);
  return new GuardedDialect(withDiscard(new MysqlDialect({ pool: facade }), discard));
}

// ---------------------------------------------------------------------------------------------------------------
// PostgreSQL

/** BIGINT (oid 20) as a JS number; a value outside the safe integer range throws instead of losing precision. */
function parseBigint(value: string): number {
  const n = Number(value);
  if (!Number.isSafeInteger(n)) {
    throw new RangeError(`BIGINT ${value} is outside the safe integer range of a JavaScript number`);
  }
  return n;
}

/** Per-pool type parsers, so the process-wide pg defaults stay untouched. */
function pgTypes(): pg.CustomTypesConfig {
  const types = new pg.TypeOverrides();
  types.setTypeParser(20, parseBigint);
  return types;
}

function pgBase(s: ServerSettings): pg.ClientConfig {
  return {
    host: s.host,
    port: s.port,
    user: s.user,
    password: s.password,
    database: s.database,
    connectionTimeoutMillis: s.connectTimeoutMs,
    keepAlive: true,
    application_name: 'altis',
    types: pgTypes(),
  };
}

/** `max_connections`, and the current role's `rolconnlimit` (-1 = no limit) as `maxUserConnections` (P17). */
async function probePostgres(s: ServerSettings): Promise<ConnectionLimits> {
  const client = new pg.Client(pgBase(s));
  client.on('error', () => {}); // a connection dying mid-probe rejects the pending query instead
  await client.connect();
  try {
    const { rows } = await client.query<{ mc: number; rcl: number | null }>(
      `SELECT current_setting('max_connections')::int AS mc, r.rolconnlimit AS rcl
         FROM pg_roles r WHERE r.rolname = current_user`,
    );
    const row = rows[0];
    const roleLimit = toCount(row?.rcl ?? -1);
    return { maxUserConnections: roleLimit > 0 ? roleLimit : 0, maxConnections: toCount(row?.mc) };
  } finally {
    await quietly(() => client.end());
  }
}

/**
 * The pg pool as Kysely sees it, with three changes for a checked-out client:
 *
 * - It has an 'error' listener while it is checked out. pg-pool listens only while a client is idle in the pool,
 *   and Kysely adds none; a pinned client whose session dies between queries (pg_terminate_backend, a network
 *   drop) emits 'error' (twice: the FATAL message, then "Connection terminated unexpectedly"), which unhandled
 *   would be an uncaught exception that kills the process. The listener records the loss; the next query then
 *   fails with pg's "Client ... is not queryable", which the driver layer reports as DB_UNAVAILABLE
 *   connection_lost, never sent.
 * - A client whose query failed because its session ended, or that recorded such an error, is released with
 *   that error, which makes pg-pool discard it. Without this, pg-pool keeps such a client when the failed query
 *   comes back before the socket close has been processed (`pg_terminate_backend` sends the FATAL message
 *   first), and the P17 retry would be handed the same dead client. "Ended" is decided as in the driver layer
 *   (driver-guard.ts endsSession: connection lost, a FATAL or PANIC message, ...).
 * - A client released while `discard` is on (the driver layer discarding a connection whose session ended, see
 *   {@link withDiscard}) is released with an error as well.
 */
function discardingDeadClients(pool: pg.Pool, discard: DiscardSwitch, endPool: () => Promise<void>): PostgresPool {
  const deadBecause = new WeakMap<pg.PoolClient, Error>();
  const markDead = (client: pg.PoolClient, error: unknown) => {
    if (!deadBecause.has(client)) deadBecause.set(client, error instanceof Error ? error : new Error(String(error)));
  };
  const checkOut = (client: pg.PoolClient): PostgresPoolClient => {
    const onError = (error: unknown) => markDead(client, error);
    client.on('error', onError);
    const query = client.query.bind(client) as (...args: unknown[]) => unknown;
    return new Proxy(client, {
      get(target, prop) {
        if (prop === 'query') {
          return (...args: unknown[]) => {
            const result = query(...args);
            if (result instanceof Promise) {
              // Registered before the caller awaits it, so the mark is set before the caller sees the error.
              result.catch((error: unknown) => {
                if (endsSession(error)) markDead(target, error);
              });
            }
            return result;
          };
        }
        if (prop === 'release') {
          return () => {
            if (discard.on) markDead(target, new Error('the session of this connection ended'));
            const dead = deadBecause.get(target);
            // A dead client is discarded, and may still emit (the socket closing): keep swallowing that.
            if (dead === undefined) target.removeListener('error', onError);
            target.release(dead);
          };
        }
        return Reflect.get(target, prop, target);
      },
    }) as unknown as PostgresPoolClient;
  };
  return {
    options: pool.options,
    connect: async () => checkOut(await pool.connect()),
    end: endPool,
  };
}

async function connectPostgres(cfg: DbConfig, o: ConnectOptions): Promise<Opened> {
  const s = serverSettings(cfg, o, 5432);
  const limits = await probePostgres(s);
  const size = poolSize(o.runtime, o.purpose, limits);
  // connectionTimeoutMillis (pgBase) also bounds pg-pool's wait for a free client: "timeout exceeded when trying to
  // connect", DB_UNAVAILABLE busy (POOL_ACQUIRE_TIMEOUT).
  const pool = new pg.Pool({ ...pgBase(s), max: size, idleTimeoutMillis: IDLE_TIMEOUT_MS });
  // An idle client that loses its connection is dropped by the pool, which then emits 'error'; without a listener
  // that would crash the process. It goes to onIdleError (L19); the next query gets a fresh client.
  pool.on('error', (error) => reportIdle(o.onIdleError, error));
  const end = once(() => pool.end()); // pg-pool rejects a second end()
  const db = new Kysely<DB>({ dialect: guardedPostgresDialect(pool, { end }) });
  return { db, dialect: cfg.dialect, limits, poolSize: size, release: end };
}

/**
 * The dialect over a pg pool: Kysely's PostgresDialect behind the pool facade (discardingDeadClients) and the
 * driver layer. Package-internal (tested directly over a fake pool).
 */
export function guardedPostgresDialect(pool: pg.Pool, o: GuardedPoolOptions = {}): GuardedDialect {
  const discard: DiscardSwitch = { on: false };
  const end = o.end ?? (() => pool.end());
  return new GuardedDialect(withDiscard(new PostgresDialect({ pool: discardingDeadClients(pool, discard, end) }), discard));
}

// ---------------------------------------------------------------------------------------------------------------
// SQLite

/**
 * The node:sqlite database behind the Kysely instance of each SQLite handle: sqliteSnapshotTo copies it with
 * node:sqlite's backup(), which needs the database object itself.
 */
const SQLITE_DATABASES = new WeakMap<Kysely<DB>, DatabaseSync>();

/** The node:sqlite database of a SQLite handle's `db`, or undefined (another dialect, or a copy made with withPlugin). */
export function sqliteDatabaseOf(db: Kysely<DB>): DatabaseSync | undefined {
  return SQLITE_DATABASES.get(db);
}

/**
 * The handle parts of an open node:sqlite database: Kysely over one connection (BEGIN IMMEDIATE, yielding, the
 * driver layer), pool 1. Package-internal (connect() and connectSqliteFile()).
 */
export function sqliteOpened(database: DatabaseSync): Opened {
  const dialect = new GuardedDialect(new AltisSqliteDialect({ database: adaptDatabaseSync(database) }));
  const db = new Kysely<DB>({ dialect });
  SQLITE_DATABASES.set(db, database);
  // After Kysely's destroy() closed it (a handle that was used), isOpen is false: closing again would throw.
  const release = async () => {
    if (database.isOpen) database.close();
  };
  return { db, dialect: 'sqlite', limits: SQLITE_LIMITS, poolSize: 1, release };
}

// 1c Task 25 (spec §9.10 "SQLite", decision C17): a restore swaps a work file into the place of `db/altis.sqlite`
// under the file lock `tmp/sqlite.lock` (core restore/sqlite-swap.ts). While another process holds that lock, connect()
// opens nothing ("CLI lain ditolak"): DB_UNAVAILABLE `sqlite_swap`, retryable. The holder itself may open the files it
// swaps. A server process (purpose `server`) records itself in `tmp/sqlite-owner.json` `{pid, startMs, host}` once its
// file is open, and removes the record when its handle closes: the swap waits until no live process other than itself
// is recorded there (owners let go when their ops fence sees `maintenance.json.sqliteRelease`). The record is a hint
// for that wait; what makes the swap safe is its own check that no connection is left on the file (no -wal/-shm after
// its last connection closed).

/** A lock record whose mtime is older than this is stale (lock.ts: the holder refreshes it every 10 s at most). */
const SWAP_LOCK_STALE_MS = 30_000;
/** Two start times of one process, computed at different moments, differ by a few ms (lock.ts). */
const START_TOLERANCE_MS = 2000;
/** Lock and owner records are a few dozen bytes. */
const RECORD_MAX_BYTES = 4096;

/** A process as a lock record or `tmp/sqlite-owner.json` names it. */
export interface SqliteProcessRecord {
  pid: number;
  /** When it started (epoch ms): a pid reused by a later process is told apart by it. */
  startMs: number;
  /** Its host identity (lockHostIdentity); null when the record has none. */
  host: string | null;
}

function sqliteLockPath(dataDir: string): DataPath {
  return dataPath(dataDir, 'tmp', 'sqlite.lock');
}

function sqliteOwnerPath(dataDir: string): DataPath {
  return dataPath(dataDir, 'tmp', 'sqlite-owner.json');
}

/** The process `raw` names, or null when it is not a record (empty, partial, or not one). */
function parseProcessRecord(raw: Buffer | null): SqliteProcessRecord | null {
  if (raw === null) return null;
  let value: unknown;
  try {
    value = JSON.parse(raw.toString('utf8'));
  } catch {
    return null;
  }
  if (typeof value !== 'object' || value === null) return null;
  const { pid, startMs, host } = value as Record<string, unknown>;
  if (typeof pid !== 'number' || !Number.isInteger(pid) || pid < 1 || pid > 2 ** 31 - 1) return null;
  if (typeof startMs !== 'number' || !Number.isFinite(startMs)) return null;
  return { pid, startMs, host: typeof host === 'string' && host !== '' ? host : null };
}

/**
 * Whether the process `r` names is this one (`self`), no longer exists (`gone`), is alive (`alive`), or belongs to
 * another host identity (`foreign`: its pid says nothing here, lock.ts R33; a container recreated with a new PID
 * namespace, say).
 */
export function sqliteProcessStatus(r: SqliteProcessRecord): 'self' | 'gone' | 'alive' | 'foreign' {
  if (r.host !== lockHostIdentity()) return 'foreign';
  if (r.pid === process.pid) return Math.abs(r.startMs - processStartMs()) <= START_TOLERANCE_MS ? 'self' : 'gone';
  try {
    process.kill(r.pid, 0);
    return 'alive';
  } catch (error) {
    return (error as NodeJS.ErrnoException).code === 'ESRCH' ? 'gone' : 'alive'; // EPERM: someone else's process
  }
}

/** The server process recorded in `tmp/sqlite-owner.json`, or null when there is none (or it is not a record). */
export async function readSqliteOwner(dataDir: string): Promise<SqliteProcessRecord | null> {
  return parseProcessRecord(await readBytes(sqliteOwnerPath(dataDir), RECORD_MAX_BYTES));
}

/** Removes `tmp/sqlite-owner.json` (a gone owner's record, under the swap lock). */
export async function removeSqliteOwner(dataDir: string): Promise<void> {
  await removeFile(sqliteOwnerPath(dataDir));
}

/** DB_UNAVAILABLE `sqlite_swap` (retryable): a restore is swapping the SQLite file, or waits for it to be let go. */
export function sqliteSwapUnavailable(): DomainError {
  return new DomainError('DB_UNAVAILABLE', {
    detail:
      'Database SQLite sedang ditukar oleh pemulihan (restore); coba lagi sebentar lagi / ' +
      'The SQLite database is being swapped by a restore; try again shortly',
    meta: { reason: 'sqlite_swap', retryable: true },
  });
}

/** True while a live process other than this one holds `tmp/sqlite.lock` (a swap in progress). */
async function swapHeldElsewhere(dataDir: string): Promise<boolean> {
  const p = sqliteLockPath(dataDir);
  const info = await statOrNull(p);
  if (info === null || Date.now() - info.mtimeMs > SWAP_LOCK_STALE_MS) return false;
  let raw: Buffer | null;
  try {
    raw = await readBytes(p, RECORD_MAX_BYTES);
  } catch {
    return true; // a lock file that cannot be read is held (fail closed)
  }
  if (raw === null) return false; // released between the two looks
  const holder = parseProcessRecord(raw);
  // A record being written (the holder created the file a moment ago) holds the lock; so does one of another host
  // identity until its mtime is stale.
  if (holder === null) return true;
  const status = sqliteProcessStatus(holder);
  return status === 'alive' || status === 'foreign';
}

/** Records this process as the owner of the SQLite file (best effort: the record is a hint, see above). */
async function recordOwner(dataDir: string): Promise<void> {
  try {
    await writeBytesAtomic(
      sqliteOwnerPath(dataDir),
      JSON.stringify({ pid: process.pid, startMs: processStartMs(), host: lockHostIdentity() }),
    );
  } catch {
    // a full disk or a refused tmp/: the swap still sees the open file itself
  }
}

/** Removes the owner record when it names this process (best effort). */
async function forgetOwner(dataDir: string): Promise<void> {
  try {
    const owner = await readSqliteOwner(dataDir);
    if (owner !== null && sqliteProcessStatus(owner) === 'self') await removeFile(sqliteOwnerPath(dataDir));
  } catch {
    // the record stays; a swap finds this process gone or itself
  }
}

/** The handle of a server process's SQLite file: recorded as the owner while it is open (1c Task 25). */
async function ownedSqliteHandle(h: DbHandle, dataDir: string): Promise<DbHandle> {
  await recordOwner(dataDir);
  let closing: Promise<void> | undefined;
  return {
    ...h,
    close: () => (closing ??= h.close().finally(() => forgetOwner(dataDir))),
  };
}

async function connectSqlite(cfg: DbConfig, o: ConnectOptions): Promise<Opened> {
  if (!sqliteAllowed(o.runtime)) {
    throw new DomainError('SQLITE_NOT_ALLOWED', {
      detail:
        `SQLite tidak dapat dipakai pada runtime ${o.runtime} (beberapa proses pekerja); gunakan MySQL/MariaDB atau PostgreSQL / ` +
        `SQLite cannot be used on runtime ${o.runtime} (several worker processes); use MySQL/MariaDB or PostgreSQL`,
      meta: { runtime: o.runtime },
    });
  }
  if (cfg.file !== undefined && cfg.file !== SQLITE_FILE) {
    throw invalid('file', `db.file untuk SQLite hanya boleh "${SQLITE_FILE}" / db.file for SQLite can only be "${SQLITE_FILE}"`);
  }
  await ensureDir(dataPath(o.dataDir, 'db'));
  // 1c Task 25: nothing opens the file while another process swaps it; looked at again once open, for a swap that
  // took the lock in between (the swap then also finds this connection on the file, and waits).
  if (await swapHeldElsewhere(o.dataDir)) throw sqliteSwapUnavailable();
  const opened = sqliteOpened(await openSqlite(dataPath(o.dataDir, 'db', SQLITE_FILE)));
  if (await swapHeldElsewhere(o.dataDir)) {
    await opened.release();
    throw sqliteSwapUnavailable();
  }
  return opened;
}

/**
 * The {@link DbHandle} of `opened`: close() destroys Kysely, then releases what Kysely may not have touched; calling
 * it again is harmless. Package-internal (connect() and connectSqliteFile()).
 */
export function handleOf(opened: Opened): DbHandle {
  const { release, ...handle } = opened;
  const closeAll = async () => {
    try {
      await handle.db.destroy();
    } finally {
      await release(); // a handle that never ran a statement: Kysely's destroy() did nothing
    }
  };
  let closing: Promise<void> | undefined;
  return {
    ...handle,
    close: () => (closing ??= closeAll()),
  };
}

// ---------------------------------------------------------------------------------------------------------------

/**
 * Opens the database described by `cfg`.
 *
 * - MySQL/MariaDB and PostgreSQL: one probe connection reads the server's connection limits, then a pool of
 *   `poolSize(runtime, purpose, limits)` connections is created (P17). mysql2 runs with `utf8mb4`, `timezone 'Z'`,
 *   BIGINTs as numbers, `maxIdle 1`, `idleTimeout 30000`, keep-alive, and `SET sql_mode` on every new connection;
 *   pg parses BIGINT into a number (throwing outside the safe integer range). A stalled server cannot make callers
 *   wait without bound: at most 50 callers wait for a MySQL/MariaDB connection (one more is refused at once), and a
 *   caller waits at most `connectTimeoutMs` + 1 s (MySQL/MariaDB) or `connectTimeoutMs` (pg-pool) for a free one;
 *   both are DB_UNAVAILABLE `busy` (retryable), `meta.code` `POOL_QUEUE_FULL` / `POOL_ACQUIRE_TIMEOUT`.
 * - SQLite: refused on `passenger`/`litespeed`; otherwise the `db` area of DATA_DIR is created when missing and
 *   `DATA_DIR/db/altis.sqlite` is opened with the P20 pragmas; one connection, transactions `BEGIN IMMEDIATE`. 1c
 *   Task 25: refused while another live process holds `tmp/sqlite.lock` (a restore's swap); with purpose `server` the
 *   process is recorded in `tmp/sqlite-owner.json` until its handle closes.
 * - Every dialect is wrapped in {@link GuardedDialect} (driver-guard.ts):
 *   - statements report errors through {@link normalizeDbError};
 *   - a read outside a transaction whose connection died is run once more on a fresh connection when it was the
 *     first statement of its connection acquisition (P17); lock-function calls never are. On an established
 *     connection a socket error mysql2 flags `fatal` counts as `connection_lost` whatever its code
 *     (`ECONNABORTED`, `ENETRESET`, ...; normalizeStatementError);
 *   - after a loss (DB_UNAVAILABLE `connection_lost`, `timeout` on an established connection, `packet_too_large`,
 *     a raw mysql2 error flagged `fatal`, or a PostgreSQL error with severity FATAL/PANIC or a code raised only as
 *     FATAL, 25P03/25P04/57P04, whatever the localized severity) a pinned connection (`db.connection()`, a
 *     transaction) is never used again: every later statement, stream, COMMIT or savepoint on it rejects with the
 *     very error object that reported the loss, without reaching the server, so a try/finally that sends one more
 *     statement surfaces the original failure (ruling R32). On release it is
 *     closed, not pooled again (MySQL/MariaDB: destroyed; PostgreSQL: released with an error, which pg-pool
 *     discards), so the next acquirer never gets the dead connection;
 *   - `meta.inDoubt: true` (ruling R28) only when the lost statement was actually sent and may change data
 *     (writes, DDL, COMMIT, `SET autocommit`, a second statement after `;`, ...), never for reads, row-locking
 *     reads, lock-function calls, EXPLAIN without ANALYZE, read PRAGMAs, BEGIN/SET/ROLLBACK, nor for a statement
 *     refused unsent on an already dead connection (`meta.code: 'NOT_SENT'`), nor for one the server refused
 *     unrun (`packet_too_large`, which is not retryable either). `retryable` means transient, not safe to repeat:
 *     after an in-doubt error only idempotent work may be retried.
 * - PostgreSQL: a checked-out client whose session dies between queries does not crash the process (it emits
 *   'error' outside pg-pool's idle listener); it is discarded on release.
 * - The error of a connection idle in the pool (PostgreSQL and MySQL/MariaDB) goes to `o.onIdleError` (L19), and
 *   never crashes the process.
 *
 * @throws DomainError `INVALID_CONFIG` (`meta.field`) for unusable settings, `SQLITE_NOT_ALLOWED` (`meta.runtime`),
 *   `DB_UNAVAILABLE` when the probe cannot connect or log in (`meta.reason` `unreachable`, `timeout`,
 *   `connection_lost`, `too_many_connections`, `access_denied` — including mysql2's `AUTH_SWITCH_PLUGIN_ERROR` and
 *   `MYSQL_CLEAR_PASSWORD_NOT_ENABLED`, not retryable —, `unknown_database`, `host_blocked`, and for SQLite
 *   `sqlite_swap`, retryable, while another process swaps the file; see
 *   {@link normalizeDbError}); on MySQL/MariaDB and PostgreSQL also for any network or TLS failure while connecting
 *   (`ECONNABORTED`, `EHOSTDOWN`, `EPROTO`, `ERR_SSL_*`, certificate errors, mysql2's `HANDSHAKE_SSL_ERROR`; see
 *   {@link normalizeConnectError}), so that the server's boot keeps retrying. `DB_UNSUPPORTED` when SQLite cannot run
 *   here. Other errors are rethrown as they are: configuration and protocol errors of the handshake (mysql2's
 *   `HANDSHAKE_NO_SSL_SUPPORT`, `HANDSHAKE_UNKNOWN_ERROR`), unmapped server errors, and SQLite's file system errors
 *   (DATA_DIR problems).
 */
export async function connect(cfg: DbConfig, o: ConnectOptions): Promise<DbHandle> {
  if (typeof cfg !== 'object' || cfg === null || !(DIALECTS as readonly unknown[]).includes(cfg.dialect)) {
    throw invalid('dialect', `db.dialect harus salah satu dari ${DIALECTS.join(', ')} / db.dialect must be one of ${DIALECTS.join(', ')}`);
  }
  let opened: Opened;
  try {
    if (cfg.dialect === 'sqlite') opened = await connectSqlite(cfg, o);
    else if (cfg.dialect === 'postgres') opened = await connectPostgres(cfg, o);
    else opened = await connectMysql(cfg, o);
  } catch (error) {
    // SQLite: a file system error is a DATA_DIR problem, not a database outage (normalizeConnectError would make it one).
    throw cfg.dialect === 'sqlite' ? normalizeDbError(error) : normalizeConnectError(error);
  }
  const h = handleOf(opened);
  // 1c Task 25: a server process's SQLite file is recorded as owned while its handle is open.
  return cfg.dialect === 'sqlite' && o.purpose === 'server' ? ownedSqliteHandle(h, o.dataDir) : h;
}
