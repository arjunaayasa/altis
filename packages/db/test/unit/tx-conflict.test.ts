import { isDomainError } from '@altis/shared';
import { Kysely, sql } from 'kysely';
import type { Pool } from 'mysql2';
import type pg from 'pg';
import { describe, expect, it } from 'vitest';
import { guardedMysqlDialect, guardedPostgresDialect, type DbHandle } from '../../src/connect.js';
import type { DB } from '../../src/schema.js';
import { withTx } from '../../src/tx.js';

// A TX_CONFLICT inside a transaction ends that transaction for good (fix round 1, item 8): MySQL/MariaDB have
// already rolled everything back (statements after it would autocommit on their own), PostgreSQL has aborted it. The
// driver layer refuses every later statement and the COMMIT with the same error, even when the callback caught the
// conflict, so withTx rolls back and runs the callback again. Through the real Kysely drivers and GuardedDialect,
// over fake mysql2 and pg pools: no server needed.

type Failure = (sqlText: string) => unknown;

class FakeMysqlConnection {
  readonly threadId = 1;
  readonly config = {};
  constructor(readonly pool: FakeMysqlPool) {}

  query(sqlText: string, _parameters: unknown, callback: (error: unknown, result?: unknown) => void): object {
    this.pool.executed.push(sqlText);
    const failure = this.pool.failOn(sqlText);
    setImmediate(() => (failure === null ? callback(null, { affectedRows: 1 }) : callback(failure)));
    return {};
  }

  release(): void {
    this.pool.events.push('release');
  }

  destroy(): void {
    this.pool.events.push('destroy');
  }
}

class FakeMysqlPool {
  readonly executed: string[] = [];
  readonly events: string[] = [];
  failOn: Failure = () => null;
  readonly connection = new FakeMysqlConnection(this);

  getConnection(callback: (error: unknown, connection?: FakeMysqlConnection) => void): void {
    process.nextTick(() => callback(null, this.connection));
  }

  end(callback: (error: unknown) => void): void {
    callback(null);
  }
}

class FakePgClient {
  constructor(readonly pool: FakePgPool) {}
  on(): void {}
  removeListener(): void {}

  query(sqlText: string): Promise<unknown> {
    this.pool.executed.push(sqlText);
    const failure = this.pool.failOn(sqlText);
    return failure === null ? Promise.resolve({ command: 'UPDATE', rowCount: 1, rows: [] }) : Promise.reject(failure);
  }

  release(error?: unknown): void {
    this.pool.events.push(error === undefined ? 'release' : 'discard');
  }
}

class FakePgPool {
  readonly options = { max: 1 };
  readonly executed: string[] = [];
  readonly events: string[] = [];
  failOn: Failure = () => null;

  async connect(): Promise<FakePgClient> {
    return new FakePgClient(this);
  }

  async end(): Promise<void> {}
}

const mysqlDeadlock = () =>
  Object.assign(new Error('Deadlock found when trying to get lock; try restarting transaction'), {
    code: 'ER_LOCK_DEADLOCK',
    errno: 1213,
    sqlState: '40001',
    fatal: false,
  });

const pgDeadlock = () => Object.assign(new Error('deadlock detected'), { code: '40P01', severity: 'ERROR' });

function handles() {
  const mysqlPool = new FakeMysqlPool();
  const pgPool = new FakePgPool();
  return [
    {
      name: 'MySQL/MariaDB',
      pool: mysqlPool,
      conflict: mysqlDeadlock,
      h: { dialect: 'mysql', db: new Kysely<DB>({ dialect: guardedMysqlDialect(mysqlPool as unknown as Pool) }) } as unknown as DbHandle,
    },
    {
      name: 'PostgreSQL',
      pool: pgPool,
      conflict: pgDeadlock,
      h: { dialect: 'postgres', db: new Kysely<DB>({ dialect: guardedPostgresDialect(pgPool as unknown as pg.Pool) }) } as unknown as DbHandle,
    },
  ];
}

describe('a TX_CONFLICT poisons its transaction (fix round 1, item 8)', () => {
  it.each(handles().map((x) => [x.name, x] as const))(
    '%s: after a caught conflict, later statements and the COMMIT reject with it unsent; withTx rolls back and runs the callback again',
    async (_name, { pool, h, conflict }) => {
      let failed = false;
      pool.failOn = (text) => {
        if (text === 'update b' && !failed) {
          failed = true;
          return conflict();
        }
        return null;
      };
      let runs = 0;
      const caught: unknown[] = [];
      const later: unknown[] = [];
      await withTx(h, async (trx) => {
        runs += 1;
        await sql`update a`.execute(trx);
        try {
          await sql`update b`.execute(trx);
        } catch (error) {
          caught.push(error); // a callback that swallows the conflict and carries on
        }
        try {
          await sql`update c`.execute(trx);
        } catch (error) {
          later.push(error);
        }
        await sql`update d`.execute(trx).catch(() => {});
      });
      expect(runs).toBe(2);
      expect(caught).toHaveLength(1);
      expect(isDomainError(caught[0]) && caught[0].code === 'TX_CONFLICT').toBe(true);
      // The very same error object, without reaching the server.
      expect(later).toEqual([caught[0]]);
      expect(later[0]).toBe(caught[0]);
      const begin = 'begin';
      expect(pool.executed).toEqual([
        begin,
        'update a',
        'update b',
        'rollback', // never 'update c', 'update d' or 'commit' in the conflicted transaction
        begin,
        'update a',
        'update b',
        'update c',
        'update d',
        'commit',
      ]);
      // The session is fine: the connection goes back to the pool, not discarded.
      expect(pool.events.every((e) => e === 'release')).toBe(true);
    },
  );

  it.each(handles().map((x) => [x.name, x] as const))(
    '%s: a conflict outside a transaction does not poison the connection',
    async (_name, { pool, h, conflict }) => {
      let failed = false;
      pool.failOn = (text) => (text === 'update b' && !failed ? ((failed = true), conflict()) : null);
      const error = await h.db
        .connection()
        .execute(async (c) => {
          const e = await sql`update b`.execute(c).catch((x: unknown) => x);
          await sql`update c`.execute(c);
          return e;
        });
      expect(error).toMatchObject({ code: 'TX_CONFLICT' });
      expect(pool.executed).toEqual(['update b', 'update c']);
    },
  );
});
