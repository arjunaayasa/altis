import { EventEmitter } from 'node:events';
import { Kysely, sql } from 'kysely';
import type { Pool } from 'mysql2';
import type pg from 'pg';
import { describe, expect, it } from 'vitest';
import { guardedMysqlDialect, guardedPostgresDialect } from '../../src/connect.js';

// The pool facades that keep a connection whose session ended out of the pool (connect.ts withDiscard,
// discardableMysqlPool, discardingDeadClients), run through the real Kysely drivers and GuardedDialect over fake
// mysql2 and pg pools. No server is needed, so this runs in `pnpm test` (the unit project): a Kysely upgrade that no
// longer calls the pool client's release() synchronously inside releaseConnection fails here on every engine, not
// only in the MariaDB packet test (retry.test.ts).

type Failure = (conn: number, sqlText: string) => unknown;

/** A mysql2 PoolConnection as Kysely's MysqlConnection uses it: query() with a callback, release(), destroy(). */
class FakeMysqlConnection {
  readonly threadId: number;
  readonly config = {};
  constructor(
    readonly id: number,
    readonly pool: FakeMysqlPool,
  ) {
    this.threadId = id;
  }

  query(sqlText: string, _parameters: unknown, callback: (error: unknown, result?: unknown) => void): object {
    this.pool.executed.push(`${this.id}:${sqlText}`);
    const failure = this.pool.failOn(this.id, sqlText);
    setImmediate(() => (failure === null ? callback(null, [{ conn: this.id }]) : callback(failure)));
    return {};
  }

  release(): void {
    this.pool.events.push(`release ${this.id}`);
    this.pool.idle.push(this);
  }

  destroy(): void {
    this.pool.events.push(`destroy ${this.id}`);
  }
}

/** mysql2's pool as far as the facade uses it: getConnection() hands out an idle connection or a new one. */
class FakeMysqlPool {
  readonly events: string[] = [];
  readonly executed: string[] = [];
  readonly idle: FakeMysqlConnection[] = [];
  created = 0;
  failOn: Failure = () => null;

  getConnection(callback: (error: unknown, connection?: FakeMysqlConnection) => void): void {
    const connection = this.idle.pop() ?? new FakeMysqlConnection((this.created += 1), this);
    process.nextTick(() => callback(null, connection));
  }

  end(callback: (error: unknown) => void): void {
    callback(null);
  }
}

/** A pg PoolClient as Kysely's PostgresConnection and the facade use it: query(), release(err?), events. */
class FakePgClient extends EventEmitter {
  constructor(
    readonly id: number,
    readonly pool: FakePgPool,
  ) {
    super();
  }

  query(sqlText: string): PromiseLike<unknown> {
    this.pool.executed.push(`${this.id}:${sqlText}`);
    const failure = this.pool.failOn(this.id, sqlText);
    if (failure === null) return Promise.resolve({ command: 'SELECT', rowCount: 1, rows: [{ conn: this.id }] });
    if (!this.pool.thenables) return Promise.reject(failure);
    // Not a Promise: the facade does not watch it, so only the driver layer's discard can keep the client out.
    const thenable = { then: (_resolve: unknown, reject: (error: unknown) => void) => void setImmediate(() => reject(failure)) };
    return thenable as unknown as PromiseLike<unknown>;
  }

  release(error?: unknown): void {
    this.pool.events.push(error === undefined ? `release ${this.id}` : `discard ${this.id}`);
    if (error === undefined) this.pool.idle.push(this);
  }
}

class FakePgPool {
  readonly options = { max: 2 };
  readonly events: string[] = [];
  readonly executed: string[] = [];
  readonly idle: FakePgClient[] = [];
  created = 0;
  thenables = false;
  failOn: Failure = () => null;

  async connect(): Promise<FakePgClient> {
    return this.idle.pop() ?? new FakePgClient((this.created += 1), this);
  }

  async end(): Promise<void> {}
}

/** MySQL 1153 / MariaDB: the server refused the packet and closes the session; mysql2 does not flag it fatal. */
const packetTooLarge = () =>
  Object.assign(new Error('Got a packet bigger than max_allowed_packet'), {
    code: 'ER_NET_PACKET_TOO_LARGE',
    errno: 1153,
    sqlState: '08S01',
    fatal: false,
  });

const pgFatal = () => Object.assign(new Error('terminating connection due to idle-in-transaction timeout'), { code: '25P03', severity: 'FATAL' });

describe('MySQL/MariaDB pool facade (discardableMysqlPool through Kysely and GuardedDialect)', () => {
  const setup = () => {
    const pool = new FakeMysqlPool();
    const db = new Kysely<never>({ dialect: guardedMysqlDialect(pool as unknown as Pool) });
    return { pool, db };
  };

  it('releases a healthy connection to the pool, which hands it out again', async () => {
    const { pool, db } = setup();
    await sql`select 1`.execute(db);
    await sql`select 2`.execute(db);
    expect(pool.events).toEqual(['release 1', 'release 1']);
    expect(pool.created).toBe(1);
  });

  it('destroys a connection whose session ended instead of releasing it; the next acquirer gets a new one', async () => {
    const { pool, db } = setup();
    pool.failOn = (conn, text) => (conn === 1 && text === 'select 2' ? packetTooLarge() : null);
    const error = await db
      .connection()
      .execute(async (c) => {
        await sql`select 1`.execute(c);
        await sql`select 2`.execute(c);
      })
      .catch((e: unknown) => e);
    expect(error).toMatchObject({ code: 'DB_UNAVAILABLE', meta: { reason: 'packet_too_large' } });
    expect(pool.events).toEqual(['destroy 1']);
    const { rows } = await sql<{ conn: number }>`select 3`.execute(db);
    expect(rows).toEqual([{ conn: 2 }]);
    expect(pool.events).toEqual(['destroy 1', 'release 2']);
  });

  it('the P17 retry destroys the dead connection and runs the read on a new one', async () => {
    const { pool, db } = setup();
    const lost = () => Object.assign(new Error('Connection lost'), { code: 'PROTOCOL_CONNECTION_LOST', fatal: true });
    pool.failOn = (conn) => (conn === 1 ? lost() : null);
    const { rows } = await sql<{ conn: number }>`select 1`.execute(db);
    expect(rows).toEqual([{ conn: 2 }]);
    expect(pool.events).toEqual(['destroy 1', 'release 2']);
  });
});

describe('PostgreSQL pool facade (discardingDeadClients through Kysely and GuardedDialect)', () => {
  const setup = () => {
    const pool = new FakePgPool();
    const db = new Kysely<never>({ dialect: guardedPostgresDialect(pool as unknown as pg.Pool) });
    return { pool, db };
  };

  it('releases a healthy client without an error, so pg-pool keeps it', async () => {
    const { pool, db } = setup();
    await sql`select 1`.execute(db);
    await sql`select 2`.execute(db);
    expect(pool.events).toEqual(['release 1', 'release 1']);
  });

  it('releases a client whose session ended (a FATAL error) with an error, so pg-pool discards it', async () => {
    const { pool, db } = setup();
    pool.failOn = (conn, text) => (conn === 1 && text === 'select 2' ? pgFatal() : null);
    await db
      .connection()
      .execute(async (c) => {
        await sql`select 1`.execute(c);
        await sql`select 2`.execute(c);
      })
      .catch(() => undefined);
    expect(pool.events).toEqual(['discard 1']);
    const { rows } = await sql<{ conn: number }>`select 3`.execute(db);
    expect(rows).toEqual([{ conn: 2 }]);
  });

  it('discards it through the driver layer alone too, when the facade did not see the failure (withDiscard)', async () => {
    const { pool, db } = setup();
    pool.thenables = true;
    pool.failOn = (conn, text) => (conn === 1 && text === 'select 2' ? pgFatal() : null);
    await db
      .connection()
      .execute(async (c) => {
        await sql`select 1`.execute(c);
        await sql`select 2`.execute(c);
      })
      .catch(() => undefined);
    expect(pool.events).toEqual(['discard 1']);
  });
});
