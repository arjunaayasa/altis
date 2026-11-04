import { EventEmitter } from 'node:events';
import fsp from 'node:fs/promises';
import os from 'node:os';
import path from 'node:path';
import type pg from 'pg';
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import { connect, type ConnectOptions, type DbHandle } from '../../src/connect.js';

// L19: an error of an idle pooled connection (a PostgreSQL client whose session the server ended, a mysql2
// connection dropped by wait_timeout or a restart) reaches ConnectOptions.onIdleError (the server passes log.warn)
// instead of being swallowed, and never crashes the process. connect() runs for real; only its probe connection is
// faked, and the pools' connections: pg-pool is the real one (over a fake Client), mysql2's pool a fake with the
// events of the real one ('connection', 'acquire', 'release').

const fakes = vi.hoisted(() => ({
  pgPools: [] as unknown[],
  mysqlPools: [] as unknown[],
}));

vi.mock('pg', async (importOriginal) => {
  const original = await importOriginal<{ default: typeof pg }>();
  const { EventEmitter: Emitter } = await import('node:events');

  /** connect()'s probe client: answers the limits query. */
  class ProbeClient {
    on(): void {}
    async connect(): Promise<void> {}
    async query(): Promise<{ rows: { mc: number; rcl: number | null }[] }> {
      return { rows: [{ mc: 100, rcl: null }] };
    }
    async end(): Promise<void> {}
  }

  /** A pg Client as pg-pool drives it: connect(callback), end(callback), the flags pg-pool reads. */
  class PooledClient extends Emitter {
    _queryable = true;
    _ending = false;
    connect(callback: (error: Error | null) => void): void {
      setImmediate(() => callback(null));
    }
    end(callback?: () => void): Promise<void> {
      this._ending = true;
      callback?.();
      return Promise.resolve();
    }
  }

  /** The real pg-pool, over PooledClient, recorded for the test. */
  class RecordingPool extends original.default.Pool {
    constructor(options: pg.PoolConfig) {
      super({ ...options, Client: PooledClient as unknown as typeof pg.Client });
      fakes.pgPools.push(this);
    }
  }

  return { ...original, default: { ...original.default, Client: ProbeClient, Pool: RecordingPool } };
});

vi.mock('mysql2/promise', async (importOriginal) => {
  const original = await importOriginal<typeof import('mysql2/promise')>();
  const probe = async () => ({ query: async () => [[{ muc: 0, mc: 100 }]], end: async () => undefined });
  return { ...original, default: { ...original, createConnection: probe }, createConnection: probe };
});

vi.mock('mysql2', async (importOriginal) => {
  const original = await importOriginal<typeof import('mysql2')>();
  const { EventEmitter: Emitter } = await import('node:events');
  /** mysql2's pool as connect() uses it: events, getConnection(), end(). */
  class FakePool extends Emitter {
    getConnection(): void {
      throw new Error('not used here');
    }
    end(callback: (error: unknown) => void): void {
      callback(null);
    }
  }
  const createPool = () => {
    const pool = new FakePool();
    fakes.mysqlPools.push(pool);
    return pool;
  };
  return { ...original, default: { ...original, createPool }, createPool };
});

/** A pooled mysql2 connection as the pool's listeners see it: query(sql, callback) and events. */
class FakeMysqlConnection extends EventEmitter {
  query(_sql: string, callback: (error: Error | null) => void): void {
    setImmediate(() => callback(null));
  }
}

let dataDir: string;
let handle: DbHandle | undefined;

beforeEach(async () => {
  dataDir = await fsp.mkdtemp(path.join(os.tmpdir(), 'altis-idle-'));
  fakes.pgPools.length = 0;
  fakes.mysqlPools.length = 0;
});

afterEach(async () => {
  await handle?.close();
  handle = undefined;
  await fsp.rm(dataDir, { recursive: true, force: true });
});

function options(extra: Partial<ConnectOptions> = {}): ConnectOptions {
  return { runtime: 'standalone', purpose: 'server', dataDir, ...extra };
}

const SERVER = { host: '127.0.0.1', user: 'u', password: 'p', database: 'd' } as const;

/** A client of the pg pool, checked out and released: idle in the pool, with pg-pool's idle listener. */
async function idlePgClient(): Promise<pg.PoolClient> {
  const pool = fakes.pgPools.at(-1) as pg.Pool;
  const client = await pool.connect();
  client.release();
  expect(pool.idleCount).toBe(1);
  return client;
}

describe('PostgreSQL: an idle client emitting error (L19)', () => {
  it('calls onIdleError once with the error, and the pool drops the client', async () => {
    const onIdleError = vi.fn();
    handle = await connect({ dialect: 'postgres', ...SERVER }, options({ onIdleError }));
    const client = await idlePgClient();
    const error = new Error('terminating connection due to administrator command');
    client.emit('error', error);
    // pg-pool keeps swallowing what the dead client emits afterwards (the socket closing).
    client.emit('error', new Error('Connection terminated unexpectedly'));
    expect(onIdleError).toHaveBeenCalledTimes(1);
    expect(onIdleError).toHaveBeenCalledWith(error);
    expect((fakes.pgPools.at(-1) as pg.Pool).totalCount).toBe(0);
  });

  it('without onIdleError nothing throws', async () => {
    handle = await connect({ dialect: 'postgres', ...SERVER }, options());
    const client = await idlePgClient();
    expect(() => client.emit('error', new Error('terminating connection due to administrator command'))).not.toThrow();
  });

  it('an onIdleError that throws does not crash the process: the error is dropped', async () => {
    const onIdleError = vi.fn(() => {
      throw new Error('the logger failed');
    });
    handle = await connect({ dialect: 'postgres', ...SERVER }, options({ onIdleError }));
    const client = await idlePgClient();
    expect(() => client.emit('error', new Error('terminating connection'))).not.toThrow();
    expect(onIdleError).toHaveBeenCalledTimes(1);
  });
});

describe('MySQL/MariaDB: a pooled connection emitting error (L19)', () => {
  /** A connection the pool opened, handed out and took back: idle. */
  function idleMysqlConnection(): FakeMysqlConnection {
    const pool = fakes.mysqlPools.at(-1) as EventEmitter;
    const conn = new FakeMysqlConnection();
    pool.emit('connection', conn);
    pool.emit('acquire', conn);
    pool.emit('release', conn);
    return conn;
  }

  it('calls onIdleError for an idle connection, every time it emits', async () => {
    const onIdleError = vi.fn();
    handle = await connect({ dialect: 'mariadb', ...SERVER }, options({ onIdleError }));
    const conn = idleMysqlConnection();
    const lost = Object.assign(new Error('Connection lost: The server closed the connection.'), {
      code: 'PROTOCOL_CONNECTION_LOST',
      fatal: true,
    });
    conn.emit('error', lost);
    expect(onIdleError).toHaveBeenCalledTimes(1);
    expect(onIdleError).toHaveBeenCalledWith(lost);
    // A second error event (mysql2's own listener is a once()) neither throws nor goes unreported.
    expect(() => conn.emit('error', new Error("Can't add new command when connection is in closed state"))).not.toThrow();
    expect(onIdleError).toHaveBeenCalledTimes(2);
  });

  it('leaves an error of a checked-out connection to the statement it fails (no onIdleError)', async () => {
    const onIdleError = vi.fn();
    handle = await connect({ dialect: 'mysql', ...SERVER }, options({ onIdleError }));
    const pool = fakes.mysqlPools.at(-1) as EventEmitter;
    const conn = new FakeMysqlConnection();
    pool.emit('connection', conn);
    pool.emit('acquire', conn);
    conn.emit('error', new Error('read ECONNRESET'));
    expect(onIdleError).not.toHaveBeenCalled();
    // Released and acquired again: still checked out.
    pool.emit('release', conn);
    pool.emit('acquire', conn);
    conn.emit('error', new Error('read ECONNRESET'));
    expect(onIdleError).not.toHaveBeenCalled();
  });

  it('without onIdleError nothing throws, also for a second error event', async () => {
    handle = await connect({ dialect: 'mariadb', ...SERVER }, options());
    const conn = idleMysqlConnection();
    expect(() => conn.emit('error', new Error('Connection lost'))).not.toThrow();
    expect(() => conn.emit('error', new Error('Connection lost'))).not.toThrow();
  });
});
