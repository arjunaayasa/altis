import { DomainError, isDomainError } from '@altis/shared';
import { describe, expect, it } from 'vitest';
import {
  isConnectionLost,
  isDriverError,
  markInDoubt,
  normalizeDbError,
  normalizeStatementError,
  wasNotSent,
} from '../src/db-errors.js';

// Synthetic errors shaped like the ones the three drivers throw (mysql2, pg, node:sqlite). connect.test.ts checks
// the same mapping against real servers.

function mysqlError(code: string, errno: number, message: string): Error {
  return Object.assign(new Error(message), { code, errno, sqlState: 'HY000', sqlMessage: message, fatal: false });
}

function netError(code: string): Error {
  return Object.assign(new Error(`connect ${code} 127.0.0.1:3306`), { code, errno: -61, syscall: 'connect' });
}

function pgError(code: string, message: string, extra: Record<string, unknown> = {}): Error {
  return Object.assign(new Error(message), { code, severity: 'ERROR', ...extra });
}

function sqliteError(errcode: number, message: string): Error {
  return Object.assign(new Error(message), { code: 'ERR_SQLITE_ERROR', errcode, errstr: 'constraint failed' });
}

/** The keys a normalized error's `cause` may carry (R16): nothing that can hold SQL text or data values. */
const SAFE_CAUSE_KEYS = ['code', 'errno', 'sqlState', 'constraint'];

function expectDomain(e: unknown, code: string): DomainError {
  const result = normalizeDbError(e);
  expect(isDomainError(result)).toBe(true);
  expect(result).toMatchObject({ code });
  const cause = (result as DomainError).cause as Record<string, unknown>;
  expect(cause).not.toBe(e);
  expect(Object.keys(cause).every((k) => SAFE_CAUSE_KEYS.includes(k))).toBe(true);
  return result as DomainError;
}

describe('normalizeDbError: UNIQUE_VIOLATION', () => {
  it('maps MySQL 8 ER_DUP_ENTRY and strips the table prefix of the key', () => {
    const e = mysqlError('ER_DUP_ENTRY', 1062, "Duplicate entry 'a@example.com' for key 'staff_users.uq_staff_users_email'");
    const result = expectDomain(e, 'UNIQUE_VIOLATION');
    expect(result.status).toBe(409);
    expect(result.meta).toEqual({ constraint: 'uq_staff_users_email' });
  });

  it('maps MariaDB ER_DUP_ENTRY (key without table prefix)', () => {
    const e = mysqlError('ER_DUP_ENTRY', 1062, "Duplicate entry 'x' for key 'uq_branches_code'");
    expect(expectDomain(e, 'UNIQUE_VIOLATION').meta).toEqual({ constraint: 'uq_branches_code' });
  });

  it('maps a duplicate primary key on MySQL', () => {
    const e = mysqlError('ER_DUP_ENTRY', 1062, "Duplicate entry '1' for key 't.PRIMARY'");
    expect(expectDomain(e, 'UNIQUE_VIOLATION').meta).toEqual({ constraint: 'PRIMARY' });
  });

  it('maps PostgreSQL 23505 with the constraint name', () => {
    const e = pgError('23505', 'duplicate key value violates unique constraint "uq_roles_key"', {
      constraint: 'uq_roles_key',
      detail: 'Key (key)=(secret) already exists.',
    });
    expect(expectDomain(e, 'UNIQUE_VIOLATION').meta).toEqual({ constraint: 'uq_roles_key' });
  });

  it('maps SQLite SQLITE_CONSTRAINT_UNIQUE (2067) and _PRIMARYKEY (1555) with the columns', () => {
    expect(expectDomain(sqliteError(2067, 'UNIQUE constraint failed: t_conn.name'), 'UNIQUE_VIOLATION').meta).toEqual({
      constraint: 't_conn.name',
    });
    expect(
      expectDomain(sqliteError(1555, 'UNIQUE constraint failed: user_roles.user_id, user_roles.role_id'), 'UNIQUE_VIOLATION')
        .meta,
    ).toEqual({ constraint: 'user_roles.user_id, user_roles.role_id' });
  });

  it('never copies the duplicate value into the message, meta or cause', () => {
    const mysqlDup = Object.assign(mysqlError('ER_DUP_ENTRY', 1062, "Duplicate entry 'secret@example.com' for key 't.uq'"), {
      sql: "INSERT INTO t (email) VALUES ('secret@example.com')",
    });
    const pgDup = pgError('23505', 'duplicate key value violates unique constraint "uq"', {
      constraint: 'uq',
      detail: 'Key (email)=(secret@example.com) already exists.',
      table: 't',
    });
    const sqliteDup = sqliteError(2067, 'UNIQUE constraint failed: t.email');
    for (const e of [mysqlDup, pgDup, sqliteDup]) {
      const r = normalizeDbError(e) as DomainError;
      expect(r.message).not.toContain('secret@example.com');
      expect(JSON.stringify(r.meta)).not.toContain('secret@example.com');
      expect(JSON.stringify(r.cause)).not.toContain('secret@example.com');
      expect(r.cause).not.toHaveProperty('sql');
      expect(r.cause).not.toHaveProperty('sqlMessage');
      expect(r.cause).not.toHaveProperty('detail');
      expect(r.cause).not.toHaveProperty('message');
    }
    expect((normalizeDbError(mysqlDup) as DomainError).cause).toEqual({ code: 'ER_DUP_ENTRY', errno: 1062, sqlState: 'HY000' });
    expect((normalizeDbError(pgDup) as DomainError).cause).toEqual({ code: '23505', constraint: 'uq' });
    expect((normalizeDbError(sqliteDup) as DomainError).cause).toEqual({ code: 'ERR_SQLITE_ERROR', errno: 2067 });
  });

  it('keeps only the safe fields in the cause of DB_UNAVAILABLE too', () => {
    const e = Object.assign(
      mysqlError('ER_ACCESS_DENIED_ERROR', 1045, "Access denied for user 'budi'@'10.0.0.5' (using password: YES)"),
      { sql: 'SELECT 1' },
    );
    const r = expectDomain(e, 'DB_UNAVAILABLE');
    expect(r.cause).toEqual({ code: 'ER_ACCESS_DENIED_ERROR', errno: 1045, sqlState: 'HY000' });
    expect(JSON.stringify(r)).not.toContain('budi');
  });

  it('uses null when the constraint cannot be read', () => {
    const e = mysqlError('ER_DUP_ENTRY', 1062, 'Duplicate entry');
    expect(expectDomain(e, 'UNIQUE_VIOLATION').meta).toEqual({ constraint: null });
  });
});

describe('normalizeDbError: DB_UNAVAILABLE', () => {
  it.each([
    ['ECONNREFUSED', netError('ECONNREFUSED'), 'unreachable'],
    ['ETIMEDOUT', netError('ETIMEDOUT'), 'timeout'],
    ['ER_ACCESS_DENIED_ERROR (1045)', mysqlError('ER_ACCESS_DENIED_ERROR', 1045, 'Access denied for user'), 'access_denied'],
    ['ER_DBACCESS_DENIED_ERROR (1044)', mysqlError('ER_DBACCESS_DENIED_ERROR', 1044, 'Access denied to database'), 'access_denied'],
    ['pg 28P01', pgError('28P01', 'password authentication failed for user "altis"'), 'access_denied'],
    ['pg 28000', pgError('28000', 'no pg_hba.conf entry for host'), 'access_denied'],
    ['ER_BAD_DB_ERROR (1049)', mysqlError('ER_BAD_DB_ERROR', 1049, "Unknown database 'x'"), 'unknown_database'],
    ['pg 3D000', pgError('3D000', 'database "x" does not exist'), 'unknown_database'],
    ['ER_HOST_IS_BLOCKED (1129)', mysqlError('ER_HOST_IS_BLOCKED', 1129, 'Host is blocked'), 'host_blocked'],
    ['ER_HOST_NOT_PRIVILEGED (1130)', mysqlError('ER_HOST_NOT_PRIVILEGED', 1130, 'Host is not allowed'), 'host_blocked'],
    ['ENOTFOUND', netError('ENOTFOUND'), 'unreachable'],
    ['EHOSTUNREACH', netError('EHOSTUNREACH'), 'unreachable'],
    ['ER_TOO_MANY_USER_CONNECTIONS', mysqlError('ER_TOO_MANY_USER_CONNECTIONS', 1203, 'User altis already has more than max_user_connections active connections'), 'too_many_connections'],
    ['ER_CON_COUNT_ERROR', mysqlError('ER_CON_COUNT_ERROR', 1040, 'Too many connections'), 'too_many_connections'],
    ['ER_USER_LIMIT_REACHED', mysqlError('ER_USER_LIMIT_REACHED', 1226, "User 'altis' has exceeded the 'max_user_connections' resource (current value: 10)"), 'too_many_connections'],
    ['pg 53300', pgError('53300', 'sorry, too many clients already'), 'too_many_connections'],
    ['pg 57P03', pgError('57P03', 'the database system is starting up'), 'unreachable'],
    ['pg timeout', new Error('timeout expired'), 'timeout'],
    ['pg-pool timeout', new Error('Connection terminated due to connection timeout'), 'timeout'],
  ])('maps %s (not retryable)', (_name, e, reason) => {
    const result = expectDomain(e, 'DB_UNAVAILABLE');
    expect(result.status).toBe(503);
    expect(result.meta).toMatchObject({ reason, retryable: false });
  });

  it.each([
    ['PROTOCOL_CONNECTION_LOST', Object.assign(new Error('Connection lost: The server closed the connection.'), { code: 'PROTOCOL_CONNECTION_LOST', fatal: true })],
    ['ECONNRESET', netError('ECONNRESET')],
    ['EPIPE', netError('EPIPE')],
    ['pg 57P01', pgError('57P01', 'terminating connection due to administrator command')],
    ['pg 57P02', pgError('57P02', 'terminating connection because of crash of another server process')],
    ['pg 57P05', pgError('57P05', 'terminating connection due to idle-session timeout')],
    ['pg terminated unexpectedly', new Error('Connection terminated unexpectedly')],
    ['pg terminated', new Error('Connection terminated')],
    ['mysql2 closed state', Object.assign(new Error("Can't add new command when connection is in closed state"), { fatal: true })],
  ])('maps a lost connection (%s) as connection_lost, retryable', (_name, e) => {
    const result = expectDomain(e, 'DB_UNAVAILABLE');
    expect(result.meta).toMatchObject({ reason: 'connection_lost', retryable: true });
    expect(isConnectionLost(result)).toBe(true);
  });

  it.each([
    ['SQLITE_BUSY', 5],
    ['SQLITE_BUSY_RECOVERY', 261],
    ['SQLITE_BUSY_SNAPSHOT', 517],
    ['SQLITE_BUSY_TIMEOUT', 773],
  ])('maps %s (busy_timeout ran out) as busy, retryable', (_name, errcode) => {
    const e = Object.assign(new Error('database is locked'), { code: 'ERR_SQLITE_ERROR', errcode, errstr: 'database is locked' });
    const result = expectDomain(e, 'DB_UNAVAILABLE');
    expect(result.meta).toEqual({ reason: 'busy', code: 'SQLITE_BUSY', retryable: true });
    expect(isConnectionLost(result)).toBe(false);
  });

  it('reads the code of an AggregateError (IPv4 and IPv6 both refused)', () => {
    const e = Object.assign(new AggregateError([netError('ECONNREFUSED'), netError('ECONNREFUSED')], ''), {});
    expect(expectDomain(e, 'DB_UNAVAILABLE').meta).toMatchObject({ reason: 'unreachable', code: 'ECONNREFUSED' });
  });

  it('isConnectionLost is false for other reasons and for raw errors', () => {
    expect(isConnectionLost(normalizeDbError(netError('ECONNREFUSED')))).toBe(false);
    expect(isConnectionLost(netError('ECONNRESET'))).toBe(false); // not normalized
  });

  it('records the driver code in meta', () => {
    expect(expectDomain(netError('ECONNREFUSED'), 'DB_UNAVAILABLE').meta).toEqual({
      reason: 'unreachable',
      code: 'ECONNREFUSED',
      retryable: false,
    });
  });

  it.each([
    ['pg', new Error('Client has encountered a connection error and is not queryable')],
    ['pg', new Error('Client was closed and is not queryable')],
    [
      'mysql2',
      Object.assign(new Error("Can't add new command when connection is in closed state"), { fatal: true }),
    ],
  ])('maps a %s statement refused on a dead connection to connection_lost NOT_SENT (never reached the server)', (_driver, e) => {
    const result = expectDomain(e, 'DB_UNAVAILABLE');
    expect(result.meta).toEqual({ reason: 'connection_lost', code: 'NOT_SENT', retryable: true });
    expect(wasNotSent(result)).toBe(true);
  });

  it('wasNotSent is false for a connection lost while the statement ran, and for anything else', () => {
    expect(wasNotSent(normalizeDbError(netError('ECONNRESET')))).toBe(false);
    expect(wasNotSent(normalizeDbError(Object.assign(new Error('x'), { fatal: true })))).toBe(false); // CLOSED
    expect(wasNotSent(new Error("Can't add new command when connection is in closed state"))).toBe(false); // raw
  });

  it.each([
    ['ER_SERVER_SHUTDOWN', 1053],
    ['ER_CLIENT_INTERACTION_TIMEOUT', 4031],
  ])('maps %s (%i), after which the server ends the session, to connection_lost', (code, errno) => {
    const result = expectDomain(mysqlError(code, errno, 'session ends'), 'DB_UNAVAILABLE');
    expect(result.meta).toEqual({ reason: 'connection_lost', code, retryable: true });
  });

  it('maps ER_NET_PACKET_TOO_LARGE (1153) to packet_too_large: the session ends, but repeating cannot help', () => {
    const result = expectDomain(mysqlError('ER_NET_PACKET_TOO_LARGE', 1153, 'Got a packet bigger than'), 'DB_UNAVAILABLE');
    expect(result.meta).toEqual({ reason: 'packet_too_large', code: 'ER_NET_PACKET_TOO_LARGE', retryable: false });
    expect(isConnectionLost(result)).toBe(false); // never retried (P17), never in doubt: the server did not run it
  });

  it('maps MariaDB 1927 ER_CONNECTION_KILLED, which mysql2 has no name for, to connection_lost', () => {
    const e = Object.assign(new Error('Connection was killed'), { errno: 1927, sqlState: '70100', sqlMessage: 'Connection was killed' });
    const result = expectDomain(e, 'DB_UNAVAILABLE');
    expect(result.meta).toEqual({ reason: 'connection_lost', code: 'ER_CONNECTION_KILLED', retryable: true });
  });

  it.each(['PROTOCOL_PACKETS_OUT_OF_ORDER', 'HANDSHAKE_NO_SSL_SUPPORT', 'HANDSHAKE_UNKNOWN_ERROR'])(
    'leaves another mysql2 error flagged fatal (%s) as it is: only the driver layer knows whether a session ended',
    (code) => {
      const e = Object.assign(new Error('fatal'), { code, fatal: true });
      expect(normalizeDbError(e)).toBe(e);
    },
  );

  it.each(['AUTH_SWITCH_PLUGIN_ERROR', 'MYSQL_CLEAR_PASSWORD_NOT_ENABLED'])(
    'maps the authentication failure %s to access_denied, not retryable',
    (code) => {
      const e = Object.assign(new Error('auth'), { code, fatal: true });
      expect(expectDomain(e, 'DB_UNAVAILABLE').meta).toEqual({ reason: 'access_denied', code, retryable: false });
    },
  );

  describe('normalizeStatementError: a statement on an established connection (round 4, item 1)', () => {
    /** What mysql2 hands a statement whose established socket failed: the Node error, flagged fatal. */
    const socketError = (code: string, extra: Record<string, unknown> = {}): Error =>
      Object.assign(new Error(`read ${code}`), { code, errno: -53, syscall: 'read', fatal: true, ...extra });

    it.each(['ECONNABORTED', 'ENETRESET', 'ENETDOWN', 'EPROTO', 'EHOSTDOWN', 'ECANCELED'])(
      'maps a socket error mysql2 flags fatal (%s), which normalizeDbError leaves as it is, to connection_lost',
      (code) => {
        const e = socketError(code);
        expect(normalizeDbError(e)).toBe(e); // the connect-time contract is unchanged
        const result = normalizeStatementError(e);
        expect(isConnectionLost(result)).toBe(true);
        expect((result as DomainError).meta).toEqual({ reason: 'connection_lost', code, retryable: true });
        expect((result as DomainError).cause).toEqual({ code, errno: -53 });
      },
    );

    it('maps a fatal error with a syscall whatever its code (Windows: "read UNKNOWN"), and an E-code without one', () => {
      expect(isConnectionLost(normalizeStatementError(socketError('UNKNOWN')))).toBe(true);
      const noSyscall = Object.assign(new Error('write ECONNABORTED'), { code: 'ECONNABORTED', fatal: true });
      expect(isConnectionLost(normalizeStatementError(noSyscall))).toBe(true);
    });

    it.each([
      ['a mysql2 protocol error', Object.assign(new Error('Packets out of order'), { code: 'PROTOCOL_PACKETS_OUT_OF_ORDER', fatal: true })],
      ['a handshake error', Object.assign(new Error('handshake'), { code: 'HANDSHAKE_NO_SSL_SUPPORT', fatal: true })],
      ['a socket error not flagged fatal and without a syscall', Object.assign(new Error('ECONNABORTED'), { code: 'ECONNABORTED' })],
      // mysql2's query inactivity timeout carries `syscall: 'query'` but is no socket error (and not fatal).
      ['mysql2 PROTOCOL_SEQUENCE_TIMEOUT', Object.assign(new Error('Query inactivity timeout'), { code: 'PROTOCOL_SEQUENCE_TIMEOUT', errorno: 'PROTOCOL_SEQUENCE_TIMEOUT', syscall: 'query' })],
      ['a non-fatal error with a syscall and a non-socket code', Object.assign(new Error('x'), { code: 'ERR_SOMETHING', syscall: 'read' })],
      ['a server error mysql2 flags fatal', Object.assign(new Error('x'), { code: 'ER_NO_SUCH_TABLE', errno: 1146, sqlState: '42S02', fatal: true })],
    ])('leaves %s as normalizeDbError does', (_what, e) => {
      expect(normalizeStatementError(e)).toBe(e);
    });

    it.each(['ECONNABORTED', 'ENETRESET', 'ENETDOWN', 'EPROTO', 'UNKNOWN'])(
      'maps a socket error pg forwards to the active query unflagged (%s, with a syscall) to connection_lost (round 5, item 3)',
      (code) => {
        const e = Object.assign(new Error(`read ${code}`), { code, errno: -53, syscall: 'read' }); // pg sets no `fatal`
        expect(normalizeDbError(e)).toBe(e);
        expect((normalizeStatementError(e) as DomainError).meta).toEqual({ reason: 'connection_lost', code, retryable: true });
      },
    );

    it('agrees with normalizeDbError on everything normalizeDbError maps', () => {
      for (const e of [socketError('ECONNRESET'), socketError('ETIMEDOUT'), socketError('EHOSTUNREACH'), socketError('EPIPE')]) {
        expect(normalizeStatementError(e)).toEqual(normalizeDbError(e));
      }
      expect((normalizeStatementError(socketError('ETIMEDOUT')) as DomainError).meta?.['reason']).toBe('timeout');
    });
  });

  it('markInDoubt adds meta.inDoubt and says so, keeping code, reason and the safe cause', () => {
    const lost = expectDomain(mysqlError('PROTOCOL_CONNECTION_LOST', 0, 'Connection lost'), 'DB_UNAVAILABLE');
    expect(lost.meta?.['inDoubt']).toBeUndefined(); // normalizeDbError does not know which statement it was
    const marked = markInDoubt(lost);
    expect(isDomainError(marked)).toBe(true);
    expect(marked).toMatchObject({ code: 'DB_UNAVAILABLE', status: 503 });
    expect(marked.meta).toEqual({ ...lost.meta, inDoubt: true });
    expect(isConnectionLost(marked)).toBe(true);
    expect(marked.cause).toBe(lost.cause);
    expect(marked.detail).toContain(lost.detail);
    expect(marked.detail).toMatch(/unknown whether the change was saved/);
  });
});

describe('normalizeDbError: TX_CONFLICT (ruling R37)', () => {
  const deadlockText = 'Deadlock found when trying to get lock; try restarting transaction';

  it('maps MySQL/MariaDB 1213 ER_LOCK_DEADLOCK', () => {
    const raw = Object.assign(mysqlError('ER_LOCK_DEADLOCK', 1213, deadlockText), { sqlState: '40001' });
    const e = expectDomain(raw, 'TX_CONFLICT');
    expect(e.status).toBe(409);
    expect(e.meta).toEqual({ code: 'ER_LOCK_DEADLOCK' });
    expect(e.cause).toEqual({ code: 'ER_LOCK_DEADLOCK', errno: 1213, sqlState: '40001' });
    expect(e.message).not.toContain(deadlockText);
  });

  it('maps MariaDB 1020 ER_CHECKREAD (snapshot isolation: the record changed since the read view; R37c)', () => {
    const text = "Record has changed since last read in table 'audit_head'";
    const raw = Object.assign(mysqlError('ER_CHECKREAD', 1020, text), { sqlState: 'HY000' });
    const e = expectDomain(raw, 'TX_CONFLICT');
    expect(e.meta).toEqual({ code: 'ER_CHECKREAD' });
    expect(e.cause).toEqual({ code: 'ER_CHECKREAD', errno: 1020, sqlState: 'HY000' });
    expect(e.message).not.toContain('audit_head');
  });

  it.each([
    ['40P01', 'deadlock detected'],
    ['40001', 'could not serialize access due to concurrent update'],
  ])('maps PostgreSQL %s', (code, message) => {
    const e = expectDomain(pgError(code, message, { detail: 'Process 1 waits for ShareLock on transaction 2' }), 'TX_CONFLICT');
    expect(e.meta).toEqual({ code });
    expect(e.message).not.toContain(message);
    expect(e.message).not.toContain('Process 1');
  });

  it('normalizeStatementError maps them the same way', () => {
    const raw = Object.assign(mysqlError('ER_LOCK_DEADLOCK', 1213, deadlockText), { sqlState: '40001' });
    expect(normalizeStatementError(raw)).toMatchObject({ code: 'TX_CONFLICT', meta: { code: 'ER_LOCK_DEADLOCK' } });
    expect(normalizeStatementError(pgError('40P01', 'deadlock detected'))).toMatchObject({ code: 'TX_CONFLICT' });
  });

  it.each([
    ['a MySQL lock wait timeout (1205)', mysqlError('ER_LOCK_WAIT_TIMEOUT', 1205, 'Lock wait timeout exceeded')],
    [
      'another MySQL error with SQLSTATE 40001 (XA rollback)',
      Object.assign(mysqlError('ER_XA_RBDEADLOCK', 1614, 'XA_RBDEADLOCK'), { sqlState: '40001' }),
    ],
    ['a PostgreSQL lock_not_available (55P03)', pgError('55P03', 'could not obtain lock on row')],
    ['a PostgreSQL other class-40 error (40002)', pgError('40002', 'integrity constraint violation')],
  ])('leaves %s unchanged', (_name, e) => {
    expect(normalizeDbError(e)).toBe(e);
  });
});

describe('normalizeDbError: everything else passes through unchanged', () => {
  it.each([
    ['a DomainError', new DomainError('INVALID_CONFIG')],
    ['a plain Error', new Error('boom')],
    ['a MySQL syntax error', mysqlError('ER_PARSE_ERROR', 1064, 'You have an error in your SQL syntax')],
    ['a MySQL data-too-long error', mysqlError('ER_DATA_TOO_LONG', 1406, "Data too long for column 'name' at row 1")],
    ['a PostgreSQL undefined table', pgError('42P01', 'relation "x" does not exist')],
    ['a PostgreSQL foreign key violation', pgError('23503', 'insert or update violates foreign key constraint')],
    ['a SQLite foreign key violation', sqliteError(787, 'FOREIGN KEY constraint failed')],
    ['a SQLite error without errcode', Object.assign(new Error('x'), { code: 'ERR_SQLITE_ERROR' })],
    ['a mysql2 non-fatal error without code', Object.assign(new Error('Pool is closed.'), { fatal: false })],
    ['a string', 'boom'],
    ['null', null],
    ['undefined', undefined],
    ['an object without code', { message: 'x' }],
  ])('%s', (_name, e) => {
    expect(normalizeDbError(e)).toBe(e);
  });

  it('does not match timeout messages of errors that carry a code', () => {
    const e = Object.assign(new Error('timeout expired'), { code: 'ER_SOMETHING' });
    expect(normalizeDbError(e)).toBe(e);
  });
});

describe('isDriverError', () => {
  it.each([
    ['a mysql2 server error', mysqlError('ER_DUP_ENTRY', 1062, 'Duplicate entry')],
    ['a mysql2 error with sqlState only', Object.assign(new Error('x'), { sqlState: '42000' })],
    ['a mysql2 protocol error', Object.assign(new Error('Connection lost'), { code: 'PROTOCOL_CONNECTION_LOST', fatal: true })],
    ['a pg server error', pgError('23505', 'duplicate key')],
    ['a node:sqlite error', sqliteError(2067, 'UNIQUE constraint failed: t.a')],
  ])('true for %s', (_name, e) => {
    expect(isDriverError(e)).toBe(true);
  });

  it.each([
    ['a plain Error', new Error('boom')],
    ['an error whose message looks like pg', new Error('timeout expired')],
    ['a network error', netError('ECONNRESET')],
    ['an HTTP-ish error with a code', Object.assign(new Error('x'), { code: 'ERR_HTTP_HEADERS_SENT' })],
    ['an ER_ code without errno', Object.assign(new Error('x'), { code: 'ER_FAKE' })],
    ['a DomainError', new DomainError('UNIQUE_VIOLATION')],
    ['null', null],
    ['a string', 'ER_DUP_ENTRY'],
  ])('false for %s', (_name, e) => {
    expect(isDriverError(e)).toBe(false);
  });
});
