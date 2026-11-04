import { createPool, type Pool, type PoolConnection, type PoolOptions } from 'mysql2';

// A read-only client for a FOREIGN MySQL/MariaDB server (Phase 2 preflight B5): the SLiMS database the catalog
// migration reads (spec §11.1). It is not an ALTIS connection: it never applies ALTIS's session setup (sql_mode,
// time zone, the driver guard) nor its server checks (SLiMS often runs on MySQL 5.x or MariaDB 10.x), and no core file
// imports `mysql2` (only this module does).
//
// - One pooled connection; `LOCAL INFILE` off (`-LOCAL_FILES`, no `infileStreamFactory`), so a hostile server cannot
//   ask this process for a local file; no multiple statements.
// - Statements are formatted by mysql2 on the client: identifiers travel as `??` values (the `cf_*` column names come
//   from the source), values as `?`; the caller never splices a name into the SQL text.
// - Every character column (CHAR, VARCHAR, TEXT, ENUM, SET, and JSON) comes back as a Buffer of the bytes the server
//   sent, so the migration decodes and repairs them exactly as it does a dump's (K15). Integers are numbers (a BIGINT
//   past 2^53 its text), DECIMAL/FLOAT/DOUBLE their text unless an integer that fits, dates and times their text (zero
//   dates included), BIT a number: the same values the dump reader gives.

/** Where the foreign server is and how to log in (never stored past a run). */
export interface ForeignMysqlConfig {
  host: string;
  port: number;
  user: string;
  password: string;
  database: string;
  tls: boolean;
}

/** An open read-only session on the foreign server. */
export interface ForeignMysql {
  /** Runs one statement with `?`/`??` placeholders; text columns come back as Buffers (the caller decodes them). */
  query(sql: string, params: readonly unknown[]): Promise<Record<string, Buffer | number | string | null>[]>;
  /** Closes the session; idempotent. */
  close(): Promise<void>;
}

/** How long one statement may run before mysql2 gives up on it. */
const QUERY_TIMEOUT_MS = 60_000;

/** The pool mysql2 builds, as far as this module uses it. */
type ForeignPool = Pick<Pool, 'getConnection' | 'query' | 'end' | 'on'>;
type PoolFactory = (options: PoolOptions) => ForeignPool;

let poolFactory: PoolFactory = createPool;

/**
 * Test profile only (R57): builds the pool with `factory` instead of mysql2's createPool (null: mysql2's again). A
 * production build ignores it.
 */
export function __setForeignMysqlPoolFactory(factory: PoolFactory | null): void {
  if (typeof __BUILD_PROFILE__ !== 'undefined' && __BUILD_PROFILE__ === 'test') poolFactory = factory ?? createPool;
}

interface CastField {
  type: string;
  string(): string | null;
  buffer(): Buffer | null;
}

const CHARACTER_TYPES: ReadonlySet<string> = new Set(['STRING', 'VAR_STRING', 'VARCHAR', 'TINY_BLOB', 'MEDIUM_BLOB', 'LONG_BLOB', 'BLOB', 'ENUM', 'SET', 'JSON', 'GEOMETRY']);
const TEXT_TYPES: ReadonlySet<string> = new Set(['DATE', 'NEWDATE', 'TIME', 'TIME2', 'DATETIME', 'DATETIME2', 'TIMESTAMP', 'TIMESTAMP2']);
const NUMERIC_TEXT_TYPES: ReadonlySet<string> = new Set(['DECIMAL', 'NEWDECIMAL', 'FLOAT', 'DOUBLE', 'LONGLONG']);

/** The value of one column (see the module comment); `next` is mysql2's own conversion. */
function typeCast(field: CastField, next: () => unknown): unknown {
  if (CHARACTER_TYPES.has(field.type)) return field.buffer();
  if (TEXT_TYPES.has(field.type)) return field.string();
  if (NUMERIC_TEXT_TYPES.has(field.type)) {
    const text = field.string();
    if (text === null) return null;
    const n = Number(text);
    return /^-?\d+$/.test(text) && Number.isSafeInteger(n) ? n : text;
  }
  if (field.type === 'BIT') {
    const bytes = field.buffer();
    if (bytes === null) return null;
    return bytes.length <= 6 ? bytes.reduce((n, b) => n * 256 + b, 0) : bytes;
  }
  return next();
}

/** mysql2's pool.end() as a promise. */
function endPool(pool: ForeignPool): Promise<void> {
  return new Promise((resolve, reject) => pool.end((error) => (error ? reject(error) : resolve())));
}

/**
 * Opens a read-only session on the foreign server `cfg` and connects once (so an unreachable server or a refused
 * login fails here), giving up after `o.connectTimeoutMs`. The error of that first connection is thrown as mysql2
 * reports it (`code` ECONNREFUSED, ETIMEDOUT, ENOTFOUND, ER_ACCESS_DENIED_ERROR, ER_BAD_DB_ERROR, a TLS code, ...);
 * the pool is closed first.
 */
export async function openForeignMysql(cfg: ForeignMysqlConfig, o: { connectTimeoutMs: number }): Promise<ForeignMysql> {
  const options: PoolOptions = {
    host: cfg.host,
    port: cfg.port,
    user: cfg.user,
    password: cfg.password,
    database: cfg.database,
    charset: 'utf8mb4',
    connectionLimit: 1,
    maxIdle: 1,
    idleTimeout: 60_000,
    waitForConnections: true,
    queueLimit: 0,
    connectTimeout: o.connectTimeoutMs,
    enableKeepAlive: true,
    flags: ['-LOCAL_FILES', '-MULTI_STATEMENTS'],
    multipleStatements: false,
    dateStrings: true,
    supportBigNumbers: true,
    bigNumberStrings: false,
    decimalNumbers: false,
    typeCast: typeCast as PoolOptions['typeCast'],
    ...(cfg.tls ? { ssl: { rejectUnauthorized: true, minVersion: 'TLSv1.2' } } : {}),
  };
  const pool = poolFactory(options);
  // An idle connection the server drops (wait_timeout, a restart) reports an error event: without a listener Node
  // would throw it. The next statement then gets a fresh connection, or its own error.
  pool.on('connection', (conn: PoolConnection) => {
    conn.on('error', () => undefined);
  });
  let closed: Promise<void> | null = null;
  const close = (): Promise<void> => (closed ??= endPool(pool).catch(() => undefined));
  try {
    await new Promise<void>((resolve, reject) =>
      pool.getConnection((error, conn) => {
        if (error) {
          reject(error);
          return;
        }
        conn.release();
        resolve();
      }),
    );
  } catch (error) {
    await close();
    throw error;
  }
  return {
    query(sql, params) {
      return new Promise((resolve, reject) =>
        pool.query({ sql, values: [...params], timeout: QUERY_TIMEOUT_MS }, (error, rows) =>
          error ? reject(error) : resolve(rows as unknown as Record<string, Buffer | number | string | null>[]),
        ),
      );
    },
    close,
  };
}
