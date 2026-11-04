import fsp from 'node:fs/promises';
import os from 'node:os';
import path from 'node:path';
import { isDomainError, type DomainError } from '@altis/shared';
import { Kysely, sql } from 'kysely';
import type { Pool } from 'mysql2';
import type pg from 'pg';
import { afterEach, describe, expect, it, vi } from 'vitest';
import { connect, guardedMysqlDialect, guardedPostgresDialect } from '../../src/connect.js';
import { normalizeConnectError } from '../../src/db-errors.js';

// Errors raised while CONNECTING (connect()'s probe, a pool opening or handing out a connection) that are about the
// network or TLS, not about the configuration: they must become DB_UNAVAILABLE, so that the server's start() keeps
// its db_unavailable retry loop (and a request gets 503) instead of treating a short network or TLS blip at boot as
// an explicit boot failure (final review, fixNow 1).

const createConnection = vi.hoisted(() => vi.fn());
vi.mock('mysql2/promise', async (importOriginal) => {
  const original = await importOriginal<typeof import('mysql2/promise')>();
  return { ...original, default: { ...original, createConnection }, createConnection };
});

afterEach(() => {
  createConnection.mockReset();
});

/** A Node system error as `net`/`tls` raise it (`read ECONNABORTED`, `write EPROTO`, ...). */
function systemError(code: string, syscall: string): Error {
  return Object.assign(new Error(`${syscall} ${code}`), { code, errno: -53, syscall });
}

/** A Node TLS error without a syscall (certificate verification, `ERR_SSL_*` from the TLS layer). */
function tlsError(code: string): Error {
  return Object.assign(new Error(`tls failure ${code}`), { code });
}

/** mysql2 overwrites the TLS error's code with HANDSHAKE_SSL_ERROR and flags it fatal (client_handshake.js). */
function handshakeSslError(wrapped: Error): Error {
  return Object.assign(wrapped, { code: 'HANDSHAKE_SSL_ERROR', fatal: true });
}

function expectUnavailable(error: unknown, reason: string, code: string): DomainError {
  expect(isDomainError(error)).toBe(true);
  const e = error as DomainError;
  expect(e.code).toBe('DB_UNAVAILABLE');
  expect(e.status).toBe(503);
  expect(e.meta).toMatchObject({ reason, code });
  // Only the safe fields of the driver error are kept (R16).
  expect(Object.keys(e.cause as object).every((k) => ['code', 'errno', 'sqlState', 'constraint'].includes(k))).toBe(true);
  return e;
}

describe('normalizeConnectError', () => {
  it.each([
    ['EHOSTDOWN', systemError('EHOSTDOWN', 'connect'), 'unreachable'],
    ['ENETDOWN', systemError('ENETDOWN', 'connect'), 'unreachable'],
    ['EADDRNOTAVAIL', systemError('EADDRNOTAVAIL', 'connect'), 'unreachable'],
    ['EPROTO (a TLS alert)', systemError('EPROTO', 'write'), 'unreachable'],
    ['EAI_FAIL (name resolution)', systemError('EAI_FAIL', 'getaddrinfo'), 'unreachable'],
    ['UNKNOWN with a syscall', systemError('UNKNOWN', 'read'), 'unreachable'],
    ['ECONNABORTED (Windows)', systemError('ECONNABORTED', 'read'), 'connection_lost'],
    ['ENETRESET', systemError('ENETRESET', 'read'), 'connection_lost'],
    ['an E-code without a syscall', tlsError('EHOSTDOWN'), 'unreachable'],
    ['ERR_SSL_WRONG_VERSION_NUMBER', tlsError('ERR_SSL_WRONG_VERSION_NUMBER'), 'unreachable'],
    ['ERR_SSL_SSLV3_ALERT_HANDSHAKE_FAILURE', tlsError('ERR_SSL_SSLV3_ALERT_HANDSHAKE_FAILURE'), 'unreachable'],
    ['ERR_TLS_CERT_ALTNAME_INVALID', tlsError('ERR_TLS_CERT_ALTNAME_INVALID'), 'unreachable'],
    ['CERT_HAS_EXPIRED', tlsError('CERT_HAS_EXPIRED'), 'unreachable'],
    ['CERT_NOT_YET_VALID', tlsError('CERT_NOT_YET_VALID'), 'unreachable'],
    ['UNABLE_TO_VERIFY_LEAF_SIGNATURE', tlsError('UNABLE_TO_VERIFY_LEAF_SIGNATURE'), 'unreachable'],
    ['UNABLE_TO_GET_ISSUER_CERT_LOCALLY', tlsError('UNABLE_TO_GET_ISSUER_CERT_LOCALLY'), 'unreachable'],
    ['DEPTH_ZERO_SELF_SIGNED_CERT', tlsError('DEPTH_ZERO_SELF_SIGNED_CERT'), 'unreachable'],
    ['SELF_SIGNED_CERT_IN_CHAIN', tlsError('SELF_SIGNED_CERT_IN_CHAIN'), 'unreachable'],
  ])('maps %s to DB_UNAVAILABLE', (_name, error, reason) => {
    expectUnavailable(normalizeConnectError(error), reason, (error as Error & { code: string }).code);
  });

  it('maps mysql2 HANDSHAKE_SSL_ERROR wrapping a socket reset to connection_lost', () => {
    const error = handshakeSslError(systemError('ECONNRESET', 'read'));
    expectUnavailable(normalizeConnectError(error), 'connection_lost', 'HANDSHAKE_SSL_ERROR');
  });

  it('maps mysql2 HANDSHAKE_SSL_ERROR wrapping a TLS failure (no syscall) to unreachable', () => {
    const error = handshakeSslError(tlsError('CERT_HAS_EXPIRED'));
    expectUnavailable(normalizeConnectError(error), 'unreachable', 'HANDSHAKE_SSL_ERROR');
  });

  it('maps an AggregateError (Node tried IPv6 and IPv4) by the first code among its errors', () => {
    const error = new AggregateError([systemError('EHOSTDOWN', 'connect'), systemError('ENETDOWN', 'connect')], 'connect');
    expectUnavailable(normalizeConnectError(error), 'unreachable', 'EHOSTDOWN');
  });

  it('keeps what normalizeDbError already maps', () => {
    expectUnavailable(normalizeConnectError(systemError('ECONNREFUSED', 'connect')), 'unreachable', 'ECONNREFUSED');
    expectUnavailable(normalizeConnectError(systemError('ECONNRESET', 'read')), 'connection_lost', 'ECONNRESET');
    expectUnavailable(normalizeConnectError(systemError('ETIMEDOUT', 'connect')), 'timeout', 'ETIMEDOUT');
    const denied = Object.assign(new Error('Access denied'), { code: 'ER_ACCESS_DENIED_ERROR', errno: 1045, sqlState: '28000' });
    expectUnavailable(normalizeConnectError(denied), 'access_denied', 'ER_ACCESS_DENIED_ERROR');
  });

  it.each([
    ['a TypeError', new TypeError('bad argument')],
    ['a code-less Error', new Error('something else')],
    ['a code-less Error with a syscall', Object.assign(new Error('x'), { syscall: 'read' })],
    ['HANDSHAKE_NO_SSL_SUPPORT (configuration)', Object.assign(new Error('no ssl'), { code: 'HANDSHAKE_NO_SSL_SUPPORT', fatal: true })],
    ['HANDSHAKE_UNKNOWN_ERROR (protocol)', Object.assign(new Error('?'), { code: 'HANDSHAKE_UNKNOWN_ERROR', fatal: true })],
    ['an unmapped server error (ER_HANDSHAKE_ERROR)', Object.assign(new Error('Bad handshake'), { code: 'ER_HANDSHAKE_ERROR', errno: 1043, sqlState: '08S01' })],
    ['a Node programming error (ERR_INVALID_ARG_TYPE)', Object.assign(new TypeError('x'), { code: 'ERR_INVALID_ARG_TYPE' })],
    ['a mysql2 protocol timeout with a pseudo-syscall', Object.assign(new Error('Query inactivity timeout'), { code: 'PROTOCOL_SEQUENCE_TIMEOUT', syscall: 'query', fatal: true })],
    ['a string', 'boom'],
  ])('leaves %s as it is (same reference)', (_name, error) => {
    expect(normalizeConnectError(error)).toBe(error);
  });
});

describe('connect() reports connect-time socket and TLS errors as DB_UNAVAILABLE', () => {
  const opts = { runtime: 'standalone', purpose: 'server', dataDir: '/nonexistent' } as const;
  const cfg = { dialect: 'mariadb', host: '127.0.0.1', port: 3306, user: 'u', password: 'p', database: 'd' } as const;

  it('maps a raw ECONNABORTED from the probe connection', async () => {
    createConnection.mockRejectedValueOnce(systemError('ECONNABORTED', 'read'));
    expectUnavailable(await connect(cfg, opts).catch((e: unknown) => e), 'connection_lost', 'ECONNABORTED');
  });

  it('maps an ERR_SSL_* failure from the probe connection', async () => {
    createConnection.mockRejectedValueOnce(tlsError('ERR_SSL_WRONG_VERSION_NUMBER'));
    expectUnavailable(await connect(cfg, opts).catch((e: unknown) => e), 'unreachable', 'ERR_SSL_WRONG_VERSION_NUMBER');
  });

  it('still rethrows a configuration-type handshake error as it is', async () => {
    const error = Object.assign(new Error('no ssl'), { code: 'HANDSHAKE_NO_SSL_SUPPORT', fatal: true });
    createConnection.mockRejectedValueOnce(error);
    expect(await connect(cfg, opts).catch((e: unknown) => e)).toBe(error);
  });

  it('leaves a SQLite DATA_DIR problem (a file system error) as it is: it is no database outage', async () => {
    const dir = await fsp.mkdtemp(path.join(os.tmpdir(), 'altis-connect-'));
    try {
      const notADirectory = path.join(dir, 'file');
      await fsp.writeFile(notADirectory, 'x');
      const error = await connect({ dialect: 'sqlite' }, { ...opts, dataDir: notADirectory }).catch((e: unknown) => e);
      expect(isDomainError(error)).toBe(false);
      expect(error).toMatchObject({ code: expect.stringMatching(/^E[A-Z]+$/) as unknown });
    } finally {
      await fsp.rm(dir, { recursive: true, force: true });
    }
  });
});

describe('the driver layer reports a failed pool acquisition as DB_UNAVAILABLE', () => {
  it('MySQL/MariaDB: a raw socket error while the pool opens a connection', async () => {
    const pool = {
      getConnection: (callback: (error: unknown) => void) => process.nextTick(() => callback(systemError('ECONNABORTED', 'read'))),
      end: (callback: (error: unknown) => void) => callback(null),
    };
    const db = new Kysely<never>({ dialect: guardedMysqlDialect(pool as unknown as Pool) });
    expectUnavailable(await sql`select 1`.execute(db).catch((e: unknown) => e), 'connection_lost', 'ECONNABORTED');
    await db.destroy();
  });

  it('MySQL/MariaDB: the P17 retry cannot get a fresh connection (raw socket error)', async () => {
    let calls = 0;
    const connection = {
      threadId: 1,
      config: {},
      query: (_sql: string, _parameters: unknown, callback: (error: unknown) => void) => {
        setImmediate(() => callback(Object.assign(new Error('Connection lost'), { code: 'PROTOCOL_CONNECTION_LOST', fatal: true })));
        return {};
      },
      release: () => undefined,
      destroy: () => undefined,
    };
    const pool = {
      getConnection: (callback: (error: unknown, connection?: unknown) => void) => {
        calls += 1;
        const failure = calls === 1 ? null : systemError('ENETDOWN', 'connect');
        process.nextTick(() => (failure === null ? callback(null, connection) : callback(failure)));
      },
      end: (callback: (error: unknown) => void) => callback(null),
    };
    const db = new Kysely<never>({ dialect: guardedMysqlDialect(pool as unknown as Pool) });
    expectUnavailable(await sql`select 1`.execute(db).catch((e: unknown) => e), 'unreachable', 'ENETDOWN');
    expect(calls).toBe(2);
    await db.destroy();
  });

  it('PostgreSQL: a TLS failure while the pool opens a client', async () => {
    const pool = {
      options: { max: 1 },
      connect: () => Promise.reject(tlsError('ERR_TLS_CERT_ALTNAME_INVALID')),
      end: () => Promise.resolve(),
    };
    const db = new Kysely<never>({ dialect: guardedPostgresDialect(pool as unknown as pg.Pool) });
    expectUnavailable(await sql`select 1`.execute(db).catch((e: unknown) => e), 'unreachable', 'ERR_TLS_CERT_ALTNAME_INVALID');
    await db.destroy();
  });
});
