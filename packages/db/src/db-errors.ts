import { DomainError, isDomainError } from '@altis/shared';

// Driver errors -> DomainError, in one place for the three drivers (spec §6.2 "normalisasi hasil driver"):
// mysql2 (string `code` such as 'ER_DUP_ENTRY', numeric `errno`, `sqlState`), pg (`code` = SQLSTATE, `severity`,
// `constraint`) and node:sqlite (`code` 'ERR_SQLITE_ERROR', numeric extended result code `errcode`). Network errors
// from Node (`code` 'ECONNREFUSED', ...) come through mysql2 and pg unchanged.

/** Why the database is unavailable; carried in `meta.reason` of `DB_UNAVAILABLE`. */
export type DbUnavailableReason =
  | 'unreachable'
  | 'too_many_connections'
  | 'timeout'
  | 'connection_lost'
  | 'access_denied'
  | 'unknown_database'
  | 'host_blocked'
  | 'busy'
  | 'packet_too_large';

/**
 * The reasons with `meta.retryable: true`: transient, so running the work again may succeed. It says nothing about
 * the failed attempt: after a lost connection the outcome of a statement that may change data, or of a COMMIT, is
 * unknown (`meta.inDoubt`, set by the driver layer), so only idempotent work may be retried.
 */
const RETRYABLE: ReadonlySet<DbUnavailableReason> = new Set(['connection_lost', 'busy']);

/** Codes (mysql2 names, pg SQLSTATEs, Node network codes) and the reason each one maps to. */
const UNAVAILABLE_CODES: ReadonlyMap<string, DbUnavailableReason> = new Map<string, DbUnavailableReason>([
  // The server cannot be reached at all.
  ['ECONNREFUSED', 'unreachable'],
  ['EHOSTUNREACH', 'unreachable'],
  ['ENETUNREACH', 'unreachable'],
  ['ENOTFOUND', 'unreachable'],
  ['EAI_AGAIN', 'unreachable'],
  ['57P03', 'unreachable'], // cannot_connect_now: the server is starting up or shutting down
  // The server refuses another connection: MySQL/MariaDB max_connections (1040), the global max_user_connections
  // (1203) or the account's own MAX_USER_CONNECTIONS limit, which cPanel hosts set (1226); PostgreSQL
  // max_connections or the role's connection limit (53300).
  ['ER_CON_COUNT_ERROR', 'too_many_connections'],
  ['ER_TOO_MANY_USER_CONNECTIONS', 'too_many_connections'],
  ['ER_USER_LIMIT_REACHED', 'too_many_connections'],
  ['53300', 'too_many_connections'],
  // Connecting took longer than the connect timeout (mysql2 reports its own connectTimeout as ETIMEDOUT).
  ['ETIMEDOUT', 'timeout'],
  // Every pooled connection stayed in use while the caller waited (connect.ts's MySQL pool facade raises it).
  ['POOL_ACQUIRE_TIMEOUT', 'busy'],
  // An established connection died (P17: a read outside a transaction may be retried once).
  ['PROTOCOL_CONNECTION_LOST', 'connection_lost'],
  ['ECONNRESET', 'connection_lost'],
  ['EPIPE', 'connection_lost'],
  ['57P01', 'connection_lost'], // terminating connection due to administrator command (pg_terminate_backend)
  ['57P02', 'connection_lost'], // terminating connection because of crash of another server process
  ['57P05', 'connection_lost'], // terminating connection due to idle-session timeout
  // Server errors after which MySQL/MariaDB ends the session: shutdown in progress (1053), MySQL 8.0.24+ closing
  // an idle interactive session (4031). MariaDB's 1927 (ER_CONNECTION_KILLED), which mysql2 has no name for, is
  // matched by errno (SESSION_ENDING_ERRNO).
  ['ER_SERVER_SHUTDOWN', 'connection_lost'],
  ['ER_CLIENT_INTERACTION_TIMEOUT', 'connection_lost'],
  // A packet over max_allowed_packet (1153): the server refuses it without running it and closes the session.
  // Not retryable (the same statement fails again) and never in doubt.
  ['ER_NET_PACKET_TOO_LARGE', 'packet_too_large'],
  // Credentials or rights: 1045 wrong user/password, 1044 no rights on the database; pg 28P01 wrong password,
  // 28000 no pg_hba.conf entry / role cannot log in.
  ['ER_ACCESS_DENIED_ERROR', 'access_denied'],
  ['ER_DBACCESS_DENIED_ERROR', 'access_denied'],
  // mysql2's own authentication failures: an auth plugin it cannot complete, a server asking for the cleartext
  // password plugin, which mysql2 refuses unless enabled.
  ['AUTH_SWITCH_PLUGIN_ERROR', 'access_denied'],
  ['MYSQL_CLEAR_PASSWORD_NOT_ENABLED', 'access_denied'],
  ['28P01', 'access_denied'],
  ['28000', 'access_denied'],
  // The database does not exist (1049, pg 3D000).
  ['ER_BAD_DB_ERROR', 'unknown_database'],
  ['3D000', 'unknown_database'],
  // The server refuses this client host: 1129 blocked after too many connection errors, 1130 host not allowed.
  ['ER_HOST_IS_BLOCKED', 'host_blocked'],
  ['ER_HOST_NOT_PRIVILEGED', 'host_blocked'],
]);

/** pg's own errors carry no code; these are matched by their exact message, and only when there is no code. */
const PG_MESSAGES: ReadonlyMap<string, DbUnavailableReason> = new Map<string, DbUnavailableReason>([
  ['timeout expired', 'timeout'], // Client: connectionTimeoutMillis elapsed
  ['Connection terminated due to connection timeout', 'timeout'], // Pool: the same, while opening a client
  ['Connection terminated unexpectedly', 'connection_lost'],
  ['Connection terminated', 'connection_lost'],
]);

/**
 * Code-less errors of a pool whose every connection is in use (`busy`, retryable), by message, with the `meta.code`
 * they get: pg-pool waited connectionTimeoutMillis for a client; mysql2 refused a caller because `queueLimit`
 * callers already wait. (connect.ts's MySQL facade reports its own wait timeout as `POOL_ACQUIRE_TIMEOUT` too.)
 */
const POOL_BUSY_MESSAGES: ReadonlyMap<string, string> = new Map([
  ['timeout exceeded when trying to connect', 'POOL_ACQUIRE_TIMEOUT'],
  ['Queue limit reached.', 'POOL_QUEUE_FULL'],
]);
const POOL_BUSY_CODES: ReadonlySet<string> = new Set(['POOL_ACQUIRE_TIMEOUT', 'POOL_QUEUE_FULL']);
const POOL_BUSY_TEXT =
  'Semua koneksi database sedang dipakai; coba lagi / Every database connection is in use; try again';

/**
 * Messages of code-less errors that refuse a statement on a connection already known to be dead, without sending
 * it (mysql2's closed state; pg's "not queryable"): `connection_lost` with `meta.code: 'NOT_SENT'`, never in doubt.
 */
const NOT_SENT_MESSAGES: ReadonlySet<string> = new Set([
  "Can't add new command when connection is in closed state",
  'Client has encountered a connection error and is not queryable',
  'Client was closed and is not queryable',
]);

/** Session-ending server errors mysql2 has no code name for, by errno: MariaDB 1927 ER_CONNECTION_KILLED. */
const SESSION_ENDING_ERRNO: ReadonlyMap<number, string> = new Map([[1927, 'ER_CONNECTION_KILLED']]);

/**
 * Transactions that lost a conflict with another transaction and were rolled back by the server, so running them
 * again may succeed (rulings R37, R37c): MySQL/MariaDB 1213 ER_LOCK_DEADLOCK (the whole transaction is rolled back),
 * MariaDB 1020 ER_CHECKREAD (with innodb_snapshot_isolation=ON, the default from MariaDB 11.6: a locking read of a
 * row changed since the transaction's read view; rolled back like a deadlock), PostgreSQL 40P01 deadlock_detected
 * and 40001 serialization_failure. A lock wait timeout (MySQL 1205, PostgreSQL 55P03) is not one: the transaction
 * is still open and only the statement failed.
 */
const TX_CONFLICT_CODES: ReadonlySet<string> = new Set(['ER_LOCK_DEADLOCK', 'ER_CHECKREAD', '40P01', '40001']);

/** node:sqlite extended result codes: SQLITE_CONSTRAINT_PRIMARYKEY, SQLITE_CONSTRAINT_UNIQUE. */
const SQLITE_UNIQUE: ReadonlySet<number> = new Set([1555, 2067]);
/** Primary result code SQLITE_BUSY (5): busy_timeout ran out waiting for another connection's lock. */
const SQLITE_BUSY = 5;

interface DriverErrorShape {
  code?: unknown;
  errno?: unknown;
  errcode?: unknown;
  sqlState?: unknown;
  severity?: unknown;
  constraint?: unknown;
  sqlMessage?: unknown;
  message?: unknown;
  fatal?: unknown;
  syscall?: unknown;
}

function shape(e: unknown): DriverErrorShape | null {
  return typeof e === 'object' && e !== null ? (e as DriverErrorShape) : null;
}

/** `code` as a string; for an AggregateError (Node tried IPv6 and IPv4) the first code among its errors. */
function codeOf(e: unknown): string | undefined {
  const s = shape(e);
  if (s === null) return undefined;
  if (typeof s.code === 'string' && s.code !== '') return s.code;
  if (e instanceof AggregateError) {
    for (const inner of e.errors) {
      const code = codeOf(inner);
      if (code !== undefined) return code;
    }
  }
  return undefined;
}

/**
 * True for an error raised by a database driver itself: a server error from mysql2 (`sqlState`, or an `ER_*` code
 * with a numeric `errno`), a mysql2 protocol error (`PROTOCOL_*`), a pg server error (`severity` and a 5-character
 * SQLSTATE `code`) or a node:sqlite error. Network errors (`ECONNRESET`, ...) are not counted: they look the same
 * whoever made the connection.
 */
export function isDriverError(e: unknown): boolean {
  const s = shape(e);
  if (s === null || isDomainError(e)) return false;
  const code = typeof s.code === 'string' ? s.code : '';
  if (typeof s.sqlState === 'string' && s.sqlState !== '') return true;
  if (code.startsWith('ER_') && typeof s.errno === 'number') return true;
  if (code.startsWith('PROTOCOL_')) return true;
  if (code === 'ERR_SQLITE_ERROR') return true;
  return typeof s.severity === 'string' && /^[0-9A-Z]{5}$/.test(code);
}

/**
 * The fields of a driver error that are safe to keep: never the SQL text, the server message (MySQL repeats the
 * duplicate value, pg's `detail` the key and value) or anything else that can hold personal data.
 * node:sqlite's `errcode` is reported as `errno`.
 */
export function safeCause(e: unknown): Readonly<Record<string, string | number>> {
  const s = shape(e);
  const cause: Record<string, string | number> = {};
  const code = codeOf(e);
  if (code !== undefined) cause['code'] = code;
  if (s !== null) {
    if (typeof s.errno === 'number') cause['errno'] = s.errno;
    else if (typeof s.errcode === 'number') cause['errno'] = s.errcode;
    if (typeof s.sqlState === 'string') cause['sqlState'] = s.sqlState;
    if (typeof s.constraint === 'string') cause['constraint'] = s.constraint;
  }
  return Object.freeze(cause);
}

/** `Duplicate entry '<value>' for key '<table>.<key>'` (MySQL 8) or `... for key '<key>'` (MariaDB) -> `<key>`. */
function mysqlConstraint(s: DriverErrorShape): string | null {
  const text = typeof s.sqlMessage === 'string' ? s.sqlMessage : typeof s.message === 'string' ? s.message : '';
  const match = /for key '([^']+)'$/.exec(text);
  if (match === null) return null;
  const key = match[1] ?? '';
  const dot = key.lastIndexOf('.');
  return dot === -1 ? key : key.slice(dot + 1);
}

/** `UNIQUE constraint failed: t.a, t.b` -> `t.a, t.b` (SQLite names the columns, not the index). */
function sqliteConstraint(s: DriverErrorShape): string | null {
  const text = typeof s.message === 'string' ? s.message : '';
  const prefix = 'UNIQUE constraint failed: ';
  return text.startsWith(prefix) ? text.slice(prefix.length) : null;
}

function uniqueViolation(e: unknown, constraint: string | null): DomainError {
  // The driver message holds the duplicate value (often personal data): only the constraint name is kept.
  const name = constraint ?? '?';
  return new DomainError('UNIQUE_VIOLATION', {
    detail:
      `Data dengan nilai yang sama sudah ada (batasan ${name}) / ` +
      `A row with the same value already exists (constraint ${name})`,
    meta: { constraint },
    cause: safeCause(e),
  });
}

function txConflict(e: unknown, code: string): DomainError {
  // The driver message names locks, transactions and sometimes rows (pg's `detail`): only the code is kept.
  return new DomainError('TX_CONFLICT', {
    detail:
      `Transaksi bentrok dengan transaksi lain dan dibatalkan; coba lagi (${code}) / ` +
      `The transaction conflicted with another one and was rolled back; try again (${code})`,
    meta: { code },
    cause: safeCause(e),
  });
}

const UNAVAILABLE_TEXT: Readonly<Record<DbUnavailableReason, string>> = {
  unreachable: 'Server database tidak dapat dihubungi / The database server cannot be reached',
  too_many_connections:
    'Server database menolak koneksi baru: batas koneksi tercapai / ' +
    'The database server refuses new connections: the connection limit is reached',
  timeout: 'Waktu tunggu koneksi database habis / Timed out connecting to the database',
  connection_lost: 'Koneksi ke database terputus / The connection to the database was lost',
  access_denied:
    'Server database menolak pengguna, sandi, atau hak akses ke database / ' +
    'The database server refuses the user, the password or access to the database',
  unknown_database: 'Database yang dikonfigurasi tidak ada / The configured database does not exist',
  host_blocked:
    'Server database menolak koneksi dari host ini / The database server refuses connections from this host',
  busy:
    'Database sedang dikunci oleh proses lain; coba lagi / The database is locked by another process; try again',
  packet_too_large:
    'Pernyataan melebihi max_allowed_packet server database, yang menutup koneksi / ' +
    "The statement exceeds the database server's max_allowed_packet; the server closed the connection",
};

function unavailable(e: unknown, reason: DbUnavailableReason, code: string): DomainError {
  const text = POOL_BUSY_CODES.has(code) ? POOL_BUSY_TEXT : UNAVAILABLE_TEXT[reason];
  return new DomainError('DB_UNAVAILABLE', {
    detail: `${text} (${code})`,
    meta: { reason, code, retryable: RETRYABLE.has(reason) },
    cause: safeCause(e),
  });
}

/**
 * Maps a driver error to a {@link DomainError}; anything else is returned unchanged (same reference), so callers
 * can always `throw normalizeDbError(e)`. A DomainError (already normalized) is returned as it is.
 *
 * - `UNIQUE_VIOLATION` (409), `meta: {constraint}`: the index/constraint name on MySQL/MariaDB (without the table
 *   prefix MySQL 8 adds) and PostgreSQL; on SQLite the failing columns (`'t.a, t.b'`); null when unreadable.
 * - `TX_CONFLICT` (409), `meta: {code}`: the server rolled the transaction back because it lost a conflict with
 *   another one: MySQL/MariaDB 1213 `ER_LOCK_DEADLOCK`, MariaDB 1020 `ER_CHECKREAD` (snapshot isolation),
 *   PostgreSQL 40P01 (deadlock) and 40001 (serialization failure). withTx runs the whole transaction again for these
 *   (rulings R37, R37b, R37c). SQLite has none: BEGIN IMMEDIATE
 *   serializes writers, and a writer that waited past busy_timeout gets `DB_UNAVAILABLE` `busy`.
 * - `DB_UNAVAILABLE` (503), `meta: {reason, code, retryable}`:
 *   - `unreachable`: `ECONNREFUSED`, `EHOSTUNREACH`, `ENETUNREACH`, `ENOTFOUND`, `EAI_AGAIN`, pg 57P03;
 *   - `too_many_connections`: `ER_CON_COUNT_ERROR`, `ER_TOO_MANY_USER_CONNECTIONS`, `ER_USER_LIMIT_REACHED`,
 *     pg 53300;
 *   - `timeout`: `ETIMEDOUT` and pg's connect timeouts;
 *   - `connection_lost` (retryable): `PROTOCOL_CONNECTION_LOST`, `ECONNRESET`, `EPIPE`, pg 57P01/57P02/57P05,
 *     pg "Connection terminated (unexpectedly)", and any other mysql2 error flagged `fatal` without a code
 *     ("Can't add new command when connection is in closed state"), the session-ending server errors 1053/4031
 *     and MariaDB's 1927 (`ER_CONNECTION_KILLED`), and pg's "Client ... is not queryable". Other errors mysql2
 *     flags `fatal` (with a code) are returned as they are: the driver layer treats them as the end of an
 *     established connection ({@link normalizeStatementError} maps the socket ones among them, and the socket
 *     errors pg forwards unflagged, to `connection_lost`). mysql2's closed state and pg's "not queryable" refuse
 *     a statement without sending it: `meta.code: 'NOT_SENT'` ({@link wasNotSent}). The driver layer adds
 *     `meta.inDoubt: true` when the lost statement had been sent and may change data, or was a COMMIT
 *     ({@link markInDoubt}): its outcome is unknown. It does the same for `timeout` on an established connection
 *     (a socket that timed out mid-statement);
 *   - `access_denied`: MySQL/MariaDB 1045/1044, mysql2's `AUTH_SWITCH_PLUGIN_ERROR` and
 *     `MYSQL_CLEAR_PASSWORD_NOT_ENABLED`, pg 28P01/28000;
 *   - `unknown_database`: 1049, pg 3D000;
 *   - `host_blocked`: 1129/1130;
 *   - `busy` (retryable): SQLITE_BUSY, i.e. busy_timeout ran out; a pool whose every connection stayed in use:
 *     `POOL_ACQUIRE_TIMEOUT` (pg-pool's "timeout exceeded when trying to connect", connect.ts's MySQL pool facade)
 *     and `POOL_QUEUE_FULL` (mysql2's "Queue limit reached.");
 *   - `packet_too_large` (not retryable): MySQL/MariaDB 1153; the server refused the statement unrun and closed
 *     the session.
 *
 *   `meta.code` is the driver's code; `PG_CLIENT` for pg's own code-less errors, `POOL_ACQUIRE_TIMEOUT` /
 *   `POOL_QUEUE_FULL` for a pool whose connections are all in use, `NOT_SENT` for a statement refused
 *   on a dead connection, `CLOSED` for other code-less fatal mysql2 errors, `ER_CONNECTION_KILLED` for MariaDB 1927,
 *   `SQLITE_BUSY` for SQLite. `retryable` means the condition is transient, not that the failed work
 *   is safe to repeat: the outcome of a lost write is unknown, so only idempotent work may be retried.
 *
 * The `cause` of the DomainError holds only `{code, errno, sqlState, constraint}` of the driver error: never the
 * SQL, the server message or pg's `detail`, which can contain personal data.
 */
export function normalizeDbError(e: unknown): DomainError | unknown {
  if (isDomainError(e)) return e;
  const s = shape(e);
  if (s === null) return e;
  const code = codeOf(e);

  if (code === undefined) {
    if (typeof s.message === 'string' && NOT_SENT_MESSAGES.has(s.message)) return unavailable(e, 'connection_lost', 'NOT_SENT');
    const reason = typeof s.message === 'string' ? PG_MESSAGES.get(s.message) : undefined;
    if (reason !== undefined) return unavailable(e, reason, 'PG_CLIENT');
    const poolCode = typeof s.message === 'string' ? POOL_BUSY_MESSAGES.get(s.message) : undefined;
    if (poolCode !== undefined) return unavailable(e, 'busy', poolCode);
    const ending = typeof s.errno === 'number' ? SESSION_ENDING_ERRNO.get(s.errno) : undefined;
    if (ending !== undefined) return unavailable(e, 'connection_lost', ending);
    return s.fatal === true ? unavailable(e, 'connection_lost', 'CLOSED') : e;
  }
  if (code === 'ER_DUP_ENTRY' || code === 'ER_DUP_ENTRY_WITH_KEY_NAME') return uniqueViolation(e, mysqlConstraint(s));
  if (code === '23505') return uniqueViolation(e, typeof s.constraint === 'string' ? s.constraint : null);
  if (TX_CONFLICT_CODES.has(code)) return txConflict(e, code);
  if (code === 'ERR_SQLITE_ERROR') {
    if (typeof s.errcode !== 'number') return e;
    if (SQLITE_UNIQUE.has(s.errcode)) return uniqueViolation(e, sqliteConstraint(s));
    // Extended codes keep the primary code in the low byte (SQLITE_BUSY_RECOVERY 261, _SNAPSHOT 517, _TIMEOUT 773).
    if ((s.errcode & 0xff) === SQLITE_BUSY) return unavailable(e, 'busy', 'SQLITE_BUSY');
    return e;
  }
  const reason = UNAVAILABLE_CODES.get(code);
  // Other errors mysql2 flags `fatal` stay as they are here: during the handshake they are connect() failures
  // ({@link normalizeConnectError} maps the network and TLS ones among them); on an established connection the
  // driver layer treats them as the end of that connection.
  return reason === undefined ? e : unavailable(e, reason, code);
}

/** A Node socket error code (`ECONNABORTED`, `ENETRESET`, `ENETDOWN`, `EPROTO`, ...). */
const SOCKET_CODE = /^E[A-Z]+$/;

/** A name-resolution error code of getaddrinfo (`EAI_FAIL`, ...); ENOTFOUND and EAI_AGAIN are mapped already. */
const RESOLVER_CODE = /^EAI_[A-Z]+$/;

/**
 * A TLS failure while connecting: Node's own TLS errors (`ERR_SSL_*`, `ERR_TLS_*`) and OpenSSL's certificate
 * verification codes as Node reports them (`CERT_HAS_EXPIRED`, `UNABLE_TO_VERIFY_LEAF_SIGNATURE`,
 * `DEPTH_ZERO_SELF_SIGNED_CERT`, ...).
 */
const TLS_CODE =
  /^(?:ERR_SSL_|ERR_TLS_|CERT_|CRL_|UNABLE_TO_|ERROR_IN_CERT_|ERROR_IN_CRL_)|^(?:DEPTH_ZERO_SELF_SIGNED_CERT|SELF_SIGNED_CERT_IN_CHAIN|INVALID_CA|INVALID_PURPOSE|PATH_LENGTH_EXCEEDED|HOSTNAME_MISMATCH)$/;

/** Socket errors that end a connection that was already open (during the handshake): not unreachable, but lost. */
const ABORT_CODES: ReadonlySet<string> = new Set(['ECONNABORTED', 'ENETRESET']);

/**
 * {@link normalizeDbError} for an error raised while CONNECTING: connect()'s probe and pool, a pool opening or handing
 * out a connection (the driver layer's acquisition, the P17 retry's fresh connection). In addition, a network or TLS
 * failure that normalizeDbError leaves as it is becomes `DB_UNAVAILABLE`, so that the server keeps its
 * db_unavailable retry loop at boot and answers 503 while ready (a raw error at boot is an explicit boot failure,
 * ruling R52, which nothing restarts from on the supported hosts):
 * - a Node socket error: a code like `EHOSTDOWN`, `ENETDOWN`, `EADDRNOTAVAIL`, `EPROTO` (with or without a
 *   `syscall`), a getaddrinfo code `EAI_*`, or `UNKNOWN` with a `syscall`: reason `unreachable`; `ECONNABORTED`
 *   (Windows) and `ENETRESET`, which end a connection already opened, `connection_lost` (as `ECONNRESET`);
 * - a TLS failure: `ERR_SSL_*`, `ERR_TLS_*` and the certificate verification codes (`CERT_*`, `UNABLE_TO_*`,
 *   `DEPTH_ZERO_SELF_SIGNED_CERT`, `SELF_SIGNED_CERT_IN_CHAIN`, ...), as pg hands them over: `unreachable`;
 * - mysql2's `HANDSHAKE_SSL_ERROR` (it overwrites the TLS error's code): `connection_lost` when it wraps a socket
 *   error (a `syscall`, e.g. a reset during the TLS handshake), `unreachable` otherwise.
 *
 * `meta.code` is the error's code. Anything else stays as it is, so configuration and protocol errors keep their
 * contract (rethrown raw, an explicit boot failure): mysql2's `HANDSHAKE_NO_SSL_SUPPORT` and
 * `HANDSHAKE_UNKNOWN_ERROR`, server errors normalizeDbError does not map, Node programming errors (`ERR_INVALID_*`),
 * code-less errors. Not for the SQLite file: its file system errors (`EACCES`, `ENOTDIR`) are DATA_DIR problems, not a
 * database outage, and connect() keeps normalizeDbError there.
 */
export function normalizeConnectError(e: unknown): DomainError | unknown {
  const normalized = normalizeDbError(e);
  if (normalized !== e) return normalized;
  const code = codeOf(e);
  if (code === undefined) return e;
  const syscall = typeof shape(e)?.syscall === 'string';
  let reason: DbUnavailableReason | undefined;
  if (code === 'HANDSHAKE_SSL_ERROR') reason = syscall ? 'connection_lost' : 'unreachable';
  else if (ABORT_CODES.has(code)) reason = 'connection_lost';
  else if (SOCKET_CODE.test(code) || RESOLVER_CODE.test(code) || TLS_CODE.test(code)) reason = 'unreachable';
  else if (code === 'UNKNOWN' && syscall) reason = 'unreachable';
  return reason === undefined ? e : unavailable(e, reason, code);
}

/**
 * {@link normalizeDbError} for the error of a statement (or COMMIT, ...) on an ESTABLISHED connection. In addition,
 * a Node socket error that normalizeDbError leaves as it is becomes `DB_UNAVAILABLE` `connection_lost` (`meta.code`:
 * its code): whatever the code (`read ECONNABORTED` on Windows, `ENETRESET`, `ENETDOWN`, `EPROTO`, `read UNKNOWN`),
 * the established socket died, so the P17 retry of a first-statement read and the in-doubt marking of a sent data
 * change or COMMIT apply as for ECONNRESET. A socket error is recognised as the drivers deliver it:
 * - mysql2 flags it `fatal`: a string `code` with a `syscall`, or a code like `ECONNABORTED`;
 * - pg hands the raw Node error to the active query without a flag: a `syscall` and a code like `ECONNABORTED` or
 *   `UNKNOWN`. (mysql2's PROTOCOL_SEQUENCE_TIMEOUT, `syscall: 'query'`, is no socket error and stays as it is.)
 *
 * Not for connecting: connect() and acquiring a pooled connection use {@link normalizeConnectError}, which maps
 * network and TLS failures but leaves configuration and protocol errors of the handshake as they are.
 */
export function normalizeStatementError(e: unknown): DomainError | unknown {
  const normalized = normalizeDbError(e);
  if (normalized !== e) return normalized;
  const s = shape(e);
  if (s === null || typeof s.code !== 'string' || s.code === '') return e;
  const syscall = typeof s.syscall === 'string';
  const socket =
    s.fatal === true ? syscall || SOCKET_CODE.test(s.code) : syscall && (SOCKET_CODE.test(s.code) || s.code === 'UNKNOWN');
  return socket ? unavailable(e, 'connection_lost', s.code) : e;
}

/**
 * True for a {@link normalizeDbError} result saying the statement was refused on a connection already known to be
 * dead and so never reached the server (`meta.code: 'NOT_SENT'`): its outcome is known, it is never in doubt.
 */
export function wasNotSent(normalized: unknown): boolean {
  return isConnectionLost(normalized) && (normalized as DomainError).meta?.['code'] === 'NOT_SENT';
}

/**
 * `error` (a `DB_UNAVAILABLE` from {@link normalizeDbError}) again, with `meta.inDoubt: true` and a sentence saying
 * so: the statement that lost its connection (or whose established connection timed out mid-statement) was sent
 * and may change data, or was a COMMIT, so the server may or may not have applied it before the connection died
 * (ruling R28). Only idempotent work may be retried after such an error.
 */
export function markInDoubt(error: DomainError): DomainError {
  return new DomainError(error.code, {
    detail:
      `${error.detail ?? ''} Tidak diketahui apakah perubahan sempat tersimpan / ` +
      'It is unknown whether the change was saved',
    meta: { ...error.meta, inDoubt: true },
    cause: error.cause,
  });
}

/** True for a {@link normalizeDbError} result meaning the connection died (`reason: 'connection_lost'`). */
export function isConnectionLost(normalized: unknown): boolean {
  return (
    isDomainError(normalized) && normalized.code === 'DB_UNAVAILABLE' && normalized.meta?.['reason'] === 'connection_lost'
  );
}
