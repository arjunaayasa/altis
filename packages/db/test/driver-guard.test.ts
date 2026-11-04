import {
  CompiledQuery,
  Kysely,
  SqliteAdapter,
  SqliteIntrospector,
  SqliteQueryCompiler,
  sql,
  type DatabaseConnection,
  type DatabaseIntrospector,
  type Dialect,
  type DialectAdapter,
  type Driver,
  type QueryCompiler,
  type QueryResult,
} from 'kysely';
import { beforeEach, describe, expect, it } from 'vitest';
import { GuardedDialect, mayModifyData } from '../src/driver-guard.js';

// The P17 retry and the in-doubt marking of GuardedDialect, against a scripted driver: which statement loses its
// connection is chosen exactly, so the rules are pinned down independently of a server (retry.test.ts kills real
// sessions on the server engines).

/** What a mysql2 connection reports when the server closed it. */
function connectionLost(): Error {
  return Object.assign(new Error('Connection lost: The server closed the connection.'), {
    code: 'PROTOCOL_CONNECTION_LOST',
    fatal: true,
  });
}

/** What mysql2 answers, without sending anything, when a statement is added to a connection that already died. */
function closedState(): Error {
  return Object.assign(new Error("Can't add new command when connection is in closed state"), { fatal: true });
}

/** MariaDB's answer when another session killed this one: errno 1927, which mysql2 has no code name for. */
function connectionKilled(): Error {
  return Object.assign(new Error('Connection was killed'), { errno: 1927, sqlState: '70100', sqlMessage: 'Connection was killed' });
}

/** What an established socket reports when it timed out in the middle of a statement (TCP keepalive). */
function socketTimeout(): Error {
  return Object.assign(new Error('read ETIMEDOUT'), { code: 'ETIMEDOUT', errno: -60, syscall: 'read', fatal: true });
}

interface Executed {
  conn: number;
  sql: string;
}

type ScriptedConnection = DatabaseConnection & { id: number };

/**
 * A driver with a pool, whose connections answer `[{conn: <id>}]` to every statement, except those `failOn` picks.
 * A released connection goes back to the pool and is handed out again; a discarded one never is.
 */
class ScriptedDriver implements Driver {
  readonly executed: Executed[] = [];
  /** Connections created (ids 1, 2, ...). */
  acquired = 0;
  /** Ids of the connections handed back to the pool, and of those discarded, in order. */
  readonly released: number[] = [];
  readonly discarded: number[] = [];
  readonly #idle: ScriptedConnection[] = [];
  /** Returns true for the (connection, statement) pairs that lose the connection. */
  failOn: (conn: number, sqlText: string) => boolean = () => false;
  /** The error a picked statement fails with. */
  failure: () => Error = connectionLost;
  /** Returns an error for the connections (1, 2, ...) whose creation fails. */
  acquireFails: (n: number) => Error | null = () => null;
  /** As a pooled driver of connect.ts has it (driver-guard.ts DiscardingDriver); a test may remove it. */
  discardConnection?: (connection: DatabaseConnection) => Promise<void> = async (connection) => {
    this.discarded.push((connection as ScriptedConnection).id);
  };

  async init(): Promise<void> {}

  async acquireConnection(): Promise<DatabaseConnection> {
    const idle = this.#idle.pop();
    if (idle !== undefined) return idle;
    const refused = this.acquireFails(this.acquired + 1);
    if (refused !== null) throw refused;
    this.acquired += 1;
    const id = this.acquired;
    const run = async <R>(query: CompiledQuery): Promise<QueryResult<R>> => {
      this.executed.push({ conn: id, sql: query.sql });
      if (this.failOn(id, query.sql)) throw this.failure();
      return { rows: [{ conn: id } as R] };
    };
    const stream = async function* <R>(this: void, query: CompiledQuery): AsyncIterableIterator<QueryResult<R>> {
      yield await run<R>(query);
    };
    const connection: ScriptedConnection = { id, executeQuery: run, streamQuery: stream };
    return connection;
  }

  async savepoint(c: DatabaseConnection, name: string): Promise<void> {
    await c.executeQuery(CompiledQuery.raw(`savepoint ${name}`));
  }

  async rollbackToSavepoint(c: DatabaseConnection, name: string): Promise<void> {
    await c.executeQuery(CompiledQuery.raw(`rollback to savepoint ${name}`));
  }

  async releaseSavepoint(c: DatabaseConnection, name: string): Promise<void> {
    await c.executeQuery(CompiledQuery.raw(`release savepoint ${name}`));
  }

  async beginTransaction(c: DatabaseConnection): Promise<void> {
    await c.executeQuery(CompiledQuery.raw('begin'));
  }

  async commitTransaction(c: DatabaseConnection): Promise<void> {
    await c.executeQuery(CompiledQuery.raw('commit'));
  }

  async rollbackTransaction(c: DatabaseConnection): Promise<void> {
    await c.executeQuery(CompiledQuery.raw('rollback'));
  }

  async releaseConnection(connection: DatabaseConnection): Promise<void> {
    this.released.push((connection as ScriptedConnection).id);
    this.#idle.push(connection as ScriptedConnection);
  }

  async destroy(): Promise<void> {}
}

class ScriptedDialect implements Dialect {
  constructor(readonly driver: ScriptedDriver) {}
  createDriver(): Driver {
    return this.driver;
  }
  createQueryCompiler(): QueryCompiler {
    return new SqliteQueryCompiler();
  }
  createAdapter(): DialectAdapter {
    return new SqliteAdapter();
  }
  createIntrospector(db: Kysely<never>): DatabaseIntrospector {
    return new SqliteIntrospector(db);
  }
}

describe('GuardedDialect: retry and in-doubt rules (scripted driver)', () => {
  let driver: ScriptedDriver;
  let db: Kysely<never>;

  beforeEach(() => {
    driver = new ScriptedDriver();
    db = new Kysely<never>({ dialect: new GuardedDialect(new ScriptedDialect(driver)) });
  });

  const statements = () => driver.executed.map((e) => `${e.conn}:${e.sql}`);

  it('retries a read that is the only statement of its acquisition on a fresh connection', async () => {
    driver.failOn = (conn, text) => conn === 1 && text === 'select 1';
    const { rows } = await sql<{ conn: number }>`select 1`.execute(db);
    expect(rows).toEqual([{ conn: 2 }]);
    expect(statements()).toEqual(['1:select 1', '2:select 1']);
  });

  it('retries the first statement of a pinned connection; the rest of the scope uses the fresh one', async () => {
    driver.failOn = (conn, text) => conn === 1 && text === 'select 1';
    const seen = await db.connection().execute(async (c) => {
      const a = await sql<{ conn: number }>`select 1`.execute(c);
      const b = await sql<{ conn: number }>`select 2`.execute(c);
      return [a.rows[0]?.conn, b.rows[0]?.conn];
    });
    expect(seen).toEqual([2, 2]);
    expect(statements()).toEqual(['1:select 1', '2:select 1', '2:select 2']);
  });

  it('does not retry a later statement of a pinned connection: its session state would be lost', async () => {
    driver.failOn = (conn, text) => conn === 1 && text === 'select 2';
    const outcome = db.connection().execute(async (c) => {
      await sql`select 1`.execute(c);
      await sql`select 2`.execute(c);
    });
    await expect(outcome).rejects.toMatchObject({
      code: 'DB_UNAVAILABLE',
      meta: { reason: 'connection_lost', retryable: true },
    });
    expect(statements()).toEqual(['1:select 1', '1:select 2']);
    expect(driver.acquired).toBe(1);
  });

  it('does not retry after a pinned connection was used for a transaction', async () => {
    driver.failOn = (conn, text) => conn === 1 && text === 'select 2';
    const outcome = db.connection().execute(async (c) => {
      await c.transaction().execute(async (trx) => {
        await sql`select 1`.execute(trx);
      });
      await sql`select 2`.execute(c);
    });
    await expect(outcome).rejects.toMatchObject({ code: 'DB_UNAVAILABLE', meta: { reason: 'connection_lost' } });
    expect(driver.acquired).toBe(1);
  });

  it.each([
    "select get_lock('altis', 10)",
    "select release_lock('altis')",
    "select is_used_lock('altis')",
    'select pg_advisory_lock(42)',
    'select pg_try_advisory_lock(42)',
    'select pg_advisory_unlock(42)',
  ])('does not retry a lock function, even as the first statement, nor mark it in doubt: %s', async (text) => {
    driver.failOn = (conn) => conn === 1;
    const error = await db.executeQuery(CompiledQuery.raw(text)).catch((e: unknown) => e);
    expect(error).toMatchObject({ code: 'DB_UNAVAILABLE', meta: { reason: 'connection_lost' } });
    // R28: a lock call changes no data; the lock itself died with the session.
    expect((error as { meta: Record<string, unknown> }).meta['inDoubt']).toBeUndefined();
    expect(statements()).toEqual([`1:${text}`]);
    expect(driver.acquired).toBe(1);
  });

  it.each(['select a from t for update', 'select a from t lock in share mode', 'explain select 1', 'pragma journal_mode'])(
    'does not mark a lost statement that changes no data in doubt (R28): %s',
    async (text) => {
      driver.failOn = (_conn, sqlText) => sqlText === text; // only the statement under test, so it is really sent
      const error = await db
        .transaction()
        .execute((trx) => trx.executeQuery(CompiledQuery.raw(text)))
        .catch((e: unknown) => e);
      expect(statements()).toEqual(['1:begin', `1:${text}`]);
      expect(error).toMatchObject({ code: 'DB_UNAVAILABLE', meta: { reason: 'connection_lost' } });
      expect((error as { meta: Record<string, unknown> }).meta['inDoubt']).toBeUndefined();
    },
  );

  it('marks a write in doubt when its established socket times out mid-statement (R28), and does not retry it', async () => {
    driver.failure = socketTimeout;
    driver.failOn = () => true;
    const error = await db.executeQuery(CompiledQuery.raw('update t set a = 1')).catch((e: unknown) => e);
    expect(error).toMatchObject({ code: 'DB_UNAVAILABLE', meta: { reason: 'timeout', inDoubt: true } });
    const read = await db.executeQuery(CompiledQuery.raw('select 1')).catch((e: unknown) => e);
    expect(read).toMatchObject({ code: 'DB_UNAVAILABLE', meta: { reason: 'timeout' } });
    expect((read as { meta: Record<string, unknown> }).meta['inDoubt']).toBeUndefined();
    expect(driver.acquired).toBe(2); // the timed-out read was not retried either
  });

  it('does not retry a read after a stream on the same pinned connection', async () => {
    driver.failOn = (conn, text) => conn === 1 && text === 'select 2';
    const outcome = db.connection().execute(async (c) => {
      // The driver layer's stream path is under test; app code never streams (L31).
      // eslint-disable-next-line no-restricted-syntax
      for await (const row of c.selectNoFrom(sql<number>`1`.as('one')).stream()) void row;
      await sql`select 2`.execute(c);
    });
    await expect(outcome).rejects.toMatchObject({ code: 'DB_UNAVAILABLE', meta: { reason: 'connection_lost' } });
    expect(statements()).toEqual(['1:select 1 as "one"', '1:select 2']);
    expect(driver.acquired).toBe(1);
  });

  it('marks a lost write in doubt (it may have been applied) and does not retry it', async () => {
    driver.failOn = (conn) => conn === 1;
    const error = await db.executeQuery(CompiledQuery.raw('insert into t (a) values (1)')).catch((e: unknown) => e);
    expect(error).toMatchObject({
      code: 'DB_UNAVAILABLE',
      meta: { reason: 'connection_lost', retryable: true, inDoubt: true },
    });
    expect(driver.acquired).toBe(1);
  });

  it('does not mark a lost read in doubt', async () => {
    driver.failOn = (conn, text) => text === 'select 1' && conn === 1;
    const error = await db
      .transaction()
      .execute((trx) => sql`select 1`.execute(trx))
      .catch((e: unknown) => e);
    expect(error).toMatchObject({ code: 'DB_UNAVAILABLE', meta: { reason: 'connection_lost' } });
    expect((error as { meta: Record<string, unknown> }).meta['inDoubt']).toBeUndefined();
  });

  it('marks a lost COMMIT in doubt', async () => {
    driver.failOn = (_conn, text) => text === 'commit';
    const error = await db
      .transaction()
      .execute((trx) => sql`select 1`.execute(trx))
      .catch((e: unknown) => e);
    expect(error).toMatchObject({
      code: 'DB_UNAVAILABLE',
      meta: { reason: 'connection_lost', retryable: true, inDoubt: true },
    });
    // No rollback is sent on the dead connection.
    expect(statements()).toEqual(['1:begin', '1:select 1', '1:commit']);
  });

  describe('a lost connection is never used again', () => {
    it('later statements of the scope reject with the very error that reported the loss, without reaching the driver', async () => {
      driver.failOn = (conn, text) => conn === 1 && text === 'select 2';
      const errors: unknown[] = [];
      await db.connection().execute(async (c) => {
        await sql`select 1`.execute(c);
        for (const text of ['select 2', 'select 3', "select pg_advisory_unlock(42)", 'insert into t values (1)']) {
          errors.push(await c.executeQuery(CompiledQuery.raw(text)).catch((e: unknown) => e));
        }
      });
      expect(errors[0]).toMatchObject({ code: 'DB_UNAVAILABLE', meta: { reason: 'connection_lost' } });
      for (const e of errors.slice(1)) expect(e).toBe(errors[0]);
      // Neither marked in doubt by statements that were never sent.
      expect((errors[0] as { meta: Record<string, unknown> }).meta['inDoubt']).toBeUndefined();
      expect(statements()).toEqual(['1:select 1', '1:select 2']);
    });

    it("a Migrator-style try/finally surfaces the original failure, not the finally block's", async () => {
      // Kysely's runWithLock releases its lock in `finally` on the same pinned connection.
      driver.failOn = (conn, text) => conn === 1 && text.startsWith('insert');
      let original: unknown;
      const outcome = db.connection().execute(async (c) => {
        await c.executeQuery(CompiledQuery.raw("select get_lock('x', 10)"));
        try {
          await c.executeQuery(CompiledQuery.raw('insert into t values (1)'));
        } catch (error) {
          original = error;
          throw error;
        } finally {
          await c.executeQuery(CompiledQuery.raw("select release_lock('x')"));
        }
      });
      const error = await outcome.catch((e: unknown) => e);
      expect(error).toBe(original);
      expect(error).toMatchObject({ code: 'DB_UNAVAILABLE', meta: { reason: 'connection_lost', inDoubt: true } });
      expect(statements()).toEqual(["1:select get_lock('x', 10)", '1:insert into t values (1)']);
    });

    it('COMMIT, savepoints and streams after a loss reject the same way without reaching the driver', async () => {
      driver.failOn = (conn, text) => conn === 1 && text === 'select 1';
      const trx = await db.startTransaction().execute();
      const lost = await sql`select 1`.execute(trx).catch((e: unknown) => e);
      expect(lost).toMatchObject({ code: 'DB_UNAVAILABLE', meta: { reason: 'connection_lost' } });
      const after = [
        await trx.savepoint('sp1').execute().catch((e: unknown) => e),
        await (async () => {
          // The driver layer's stream path is under test; app code never streams (L31).
          // eslint-disable-next-line no-restricted-syntax
          for await (const row of trx.selectNoFrom(sql<number>`1`.as('one')).stream()) void row;
        })().catch((e: unknown) => e),
        await trx.commit().execute().catch((e: unknown) => e),
      ];
      for (const e of after) expect(e).toBe(lost);
      await trx.rollback().execute(); // nothing to roll back on a dead session: accepted without a statement
      expect(statements()).toEqual(['1:begin', '1:select 1']);
    });
  });

  describe('statements that never reached the server are never in doubt (item 6)', () => {
    it.each(['insert into t values (1)', 'commit'])('%s refused by mysql2 on a closed connection', async (text) => {
      driver.failure = closedState;
      driver.failOn = (_conn, sqlText) => sqlText === text;
      const error =
        text === 'commit'
          ? await db
              .transaction()
              .execute((trx) => sql`select 1`.execute(trx))
              .catch((e: unknown) => e)
          : await db.executeQuery(CompiledQuery.raw(text)).catch((e: unknown) => e);
      expect(error).toMatchObject({ code: 'DB_UNAVAILABLE', meta: { reason: 'connection_lost', code: 'NOT_SENT' } });
      expect((error as { meta: Record<string, unknown> }).meta['inDoubt']).toBeUndefined();
    });

    it("an INSERT that pg refuses as 'not queryable'", async () => {
      driver.failure = () => new Error('Client has encountered a connection error and is not queryable');
      driver.failOn = () => true;
      const error = await db.executeQuery(CompiledQuery.raw('insert into t values (1)')).catch((e: unknown) => e);
      expect(error).toMatchObject({ code: 'DB_UNAVAILABLE', meta: { reason: 'connection_lost', code: 'NOT_SENT' } });
      expect((error as { meta: Record<string, unknown> }).meta['inDoubt']).toBeUndefined();
    });
  });

  it('a session-ending server error (MariaDB 1927) marks the connection lost: later statements rethrow it (item 7)', async () => {
    driver.failure = connectionKilled;
    driver.failOn = (conn, text) => conn === 1 && text === 'select 2';
    const errors: unknown[] = [];
    await db.connection().execute(async (c) => {
      await sql`select 1`.execute(c);
      errors.push(await sql`select 2`.execute(c).catch((e: unknown) => e));
      errors.push(await sql`select 3`.execute(c).catch((e: unknown) => e));
    });
    expect(errors[0]).toMatchObject({ code: 'DB_UNAVAILABLE', meta: { reason: 'connection_lost', code: 'ER_CONNECTION_KILLED' } });
    expect(errors[1]).toBe(errors[0]);
    expect(statements()).toEqual(['1:select 1', '1:select 2']);
  });

  it('a raw error flagged fatal on an established connection ends it: later statements rethrow that error', async () => {
    const fatal = Object.assign(new Error('Packets out of order'), { code: 'PROTOCOL_PACKETS_OUT_OF_ORDER', fatal: true });
    driver.failure = () => fatal;
    driver.failOn = (conn, text) => conn === 1 && text === 'select 2';
    const errors: unknown[] = [];
    await db.connection().execute(async (c) => {
      await sql`select 1`.execute(c);
      errors.push(await sql`select 2`.execute(c).catch((e: unknown) => e));
      errors.push(await sql`select 3`.execute(c).catch((e: unknown) => e));
    });
    expect(errors[0]).toBe(fatal); // as it is: no DomainError mapping for it
    expect(errors[1]).toBe(fatal);
    expect(statements()).toEqual(['1:select 1', '1:select 2']);
  });

  describe('a socket error mysql2 flags fatal, whatever its code, is a lost connection (round 4, item 1)', () => {
    // On Windows "read ECONNABORTED", elsewhere ENETRESET/ENETDOWN/EPROTO...: not in normalizeDbError's table.
    const aborted = () =>
      Object.assign(new Error('read ECONNABORTED'), { code: 'ECONNABORTED', errno: -53, syscall: 'read', fatal: true });

    it('a first-statement read is retried once on a fresh connection (P17)', async () => {
      driver.failure = aborted;
      driver.failOn = (conn, text) => conn === 1 && text === 'select 1';
      const { rows } = await sql<{ conn: number }>`select 1`.execute(db);
      expect(rows).toEqual([{ conn: 2 }]);
      expect(statements()).toEqual(['1:select 1', '2:select 1']);
    });

    it('a sent INSERT is in doubt and not retried; the next statement rethrows the same error object', async () => {
      driver.failure = aborted;
      driver.failOn = (conn, text) => conn === 1 && text.startsWith('insert');
      const errors: unknown[] = [];
      await db.connection().execute(async (c) => {
        errors.push(await c.executeQuery(CompiledQuery.raw('insert into t values (1)')).catch((e: unknown) => e));
        errors.push(await c.executeQuery(CompiledQuery.raw('select 1')).catch((e: unknown) => e));
      });
      expect(errors[0]).toMatchObject({
        code: 'DB_UNAVAILABLE',
        meta: { reason: 'connection_lost', code: 'ECONNABORTED', retryable: true, inDoubt: true },
      });
      expect(errors[1]).toBe(errors[0]);
      expect(statements()).toEqual(['1:insert into t values (1)']);
    });

    it('a lost COMMIT is in doubt', async () => {
      driver.failure = aborted;
      driver.failOn = (_conn, text) => text === 'commit';
      const error = await db
        .transaction()
        .execute((trx) => sql`select 1`.execute(trx))
        .catch((e: unknown) => e);
      expect(error).toMatchObject({ code: 'DB_UNAVAILABLE', meta: { reason: 'connection_lost', inDoubt: true } });
    });
  });

  describe('a socket error pg forwards to the active query, unflagged, is a lost connection (round 5, item 3)', () => {
    // pg sets no `fatal`: a Windows `read ECONNABORTED` reaches the query as the raw Node error.
    const pgAborted = () => Object.assign(new Error('read ECONNABORTED'), { code: 'ECONNABORTED', errno: -4079, syscall: 'read' });

    it('a first-statement read is retried once on a fresh connection (P17)', async () => {
      driver.failure = pgAborted;
      driver.failOn = (conn, text) => conn === 1 && text === 'select 1';
      const { rows } = await sql<{ conn: number }>`select 1`.execute(db);
      expect(rows).toEqual([{ conn: 2 }]);
      expect(statements()).toEqual(['1:select 1', '2:select 1']);
    });

    it('a sent INSERT is in doubt; the next statement rethrows the same error object; the connection is discarded', async () => {
      driver.failure = pgAborted;
      driver.failOn = (conn, text) => conn === 1 && text.startsWith('insert');
      const errors: unknown[] = [];
      await db.connection().execute(async (c) => {
        errors.push(await c.executeQuery(CompiledQuery.raw('insert into t values (1)')).catch((e: unknown) => e));
        errors.push(await c.executeQuery(CompiledQuery.raw('select 1')).catch((e: unknown) => e));
      });
      expect(errors[0]).toMatchObject({
        code: 'DB_UNAVAILABLE',
        meta: { reason: 'connection_lost', code: 'ECONNABORTED', inDoubt: true },
      });
      expect(errors[1]).toBe(errors[0]);
      expect(statements()).toEqual(['1:insert into t values (1)']);
      expect(driver.discarded).toEqual([1]);
    });
  });

  describe('ER_NET_PACKET_TOO_LARGE (the server refused the packet and closed the session)', () => {
    const tooLarge = () =>
      Object.assign(new Error('Got a packet bigger than max_allowed_packet'), {
        code: 'ER_NET_PACKET_TOO_LARGE',
        errno: 1153,
        sqlState: '08S01',
        sqlMessage: 'Got a packet bigger than max_allowed_packet',
      });

    it('is not retried, even for a first-statement read', async () => {
      driver.failure = tooLarge;
      driver.failOn = (conn) => conn === 1;
      await expect(db.executeQuery(CompiledQuery.raw('select 1'))).rejects.toMatchObject({
        code: 'DB_UNAVAILABLE',
        meta: { reason: 'packet_too_large', retryable: false },
      });
      expect(driver.acquired).toBe(1);
    });

    it('is not in doubt for a write, and ends the connection', async () => {
      driver.failure = tooLarge;
      driver.failOn = (conn, text) => conn === 1 && text.startsWith('insert');
      const errors: unknown[] = [];
      await db.connection().execute(async (c) => {
        errors.push(await c.executeQuery(CompiledQuery.raw('insert into t values (1)')).catch((e: unknown) => e));
        errors.push(await c.executeQuery(CompiledQuery.raw('select 1')).catch((e: unknown) => e));
      });
      expect(errors[0]).toMatchObject({ code: 'DB_UNAVAILABLE', meta: { reason: 'packet_too_large' } });
      expect((errors[0] as { meta: Record<string, unknown> }).meta['inDoubt']).toBeUndefined();
      expect(errors[1]).toBe(errors[0]);
      expect(statements()).toEqual(['1:insert into t values (1)']);
    });
  });

  describe('a connection whose session ended is discarded, never pooled again (round 4, items 5-6)', () => {
    /** A server error mysql2 does not flag fatal, after which MySQL/MariaDB closes the session. */
    const serverError = (code: string, errno: number, sqlState: string) => () =>
      Object.assign(new Error(code), { code, errno, sqlState, sqlMessage: code, fatal: false });
    /** A pg ErrorResponse with this severity (pg errors carry no `fatal` flag). */
    const pgError = (code: string, severity: string) => () =>
      Object.assign(new Error(`pg ${code}`), { code, severity, length: 120, name: 'error' });

    it.each([
      ['connection_lost (PROTOCOL_CONNECTION_LOST)', connectionLost],
      ['MariaDB 1927 ER_CONNECTION_KILLED', connectionKilled],
      ['ER_SERVER_SHUTDOWN (1053)', serverError('ER_SERVER_SHUTDOWN', 1053, '08S01')],
      ['ER_NET_PACKET_TOO_LARGE (1153)', serverError('ER_NET_PACKET_TOO_LARGE', 1153, '08S01')],
      ['ER_CLIENT_INTERACTION_TIMEOUT (4031)', serverError('ER_CLIENT_INTERACTION_TIMEOUT', 4031, 'HY000')],
      ['a raw mysql2 error flagged fatal', () => Object.assign(new Error('Packets out of order'), { code: 'PROTOCOL_PACKETS_OUT_OF_ORDER', fatal: true })],
      ['a fatal socket error (ECONNABORTED)', () => Object.assign(new Error('read ECONNABORTED'), { code: 'ECONNABORTED', syscall: 'read', fatal: true })],
      ['an established socket timing out', socketTimeout],
      ['PostgreSQL FATAL 25P03 (idle_in_transaction_session_timeout)', pgError('25P03', 'FATAL')],
      ['PostgreSQL PANIC', pgError('XX000', 'PANIC')],
    ])('%s: the connection is discarded and the next acquirer gets a fresh one', async (_what, failure) => {
      driver.failure = failure;
      driver.failOn = (conn, text) => conn === 1 && text === 'select 2';
      await db.connection().execute(async (c) => {
        await sql`select 1`.execute(c);
        await sql`select 2`.execute(c).catch(() => undefined);
      });
      expect(driver.discarded).toEqual([1]);
      expect(driver.released).toEqual([]);
      const { rows } = await sql<{ conn: number }>`select 3`.execute(db);
      expect(rows).toEqual([{ conn: 2 }]);
      expect(driver.released).toEqual([2]);
    });

    it('a connection that only saw an ordinary SQL error goes back to the pool and is handed out again', async () => {
      driver.failure = () =>
        Object.assign(new Error('no such table'), { code: 'ER_NO_SUCH_TABLE', errno: 1146, sqlState: '42S02', fatal: false });
      driver.failOn = (conn, text) => conn === 1 && text === 'select 2';
      await db.connection().execute(async (c) => {
        await sql`select 2`.execute(c).catch(() => undefined);
      });
      await sql`select 3`.execute(db);
      expect(driver.released).toEqual([1, 1]);
      expect(driver.discarded).toEqual([]);
      expect(driver.acquired).toBe(1);
    });

    it('the P17 retry discards the dead connection before it takes a fresh one', async () => {
      driver.failOn = (conn, text) => conn === 1 && text === 'select 1';
      await sql`select 1`.execute(db);
      expect(driver.discarded).toEqual([1]);
      expect(statements()).toEqual(['1:select 1', '2:select 1']);
    });

    it('a driver that cannot discard (SQLite: one connection, no pool) gets releaseConnection', async () => {
      driver.discardConnection = undefined;
      driver.failOn = (conn, text) => conn === 1 && text.startsWith('insert');
      await db.executeQuery(CompiledQuery.raw('insert into t values (1)')).catch(() => undefined);
      expect(driver.released).toEqual([1]);
    });

    it('a PostgreSQL FATAL error ends the session: later statements rethrow the original error object (R32)', async () => {
      const fatal = pgError('25P03', 'FATAL')();
      driver.failure = () => fatal;
      driver.failOn = (conn, text) => conn === 1 && text === 'select 2';
      const errors: unknown[] = [];
      await db.connection().execute(async (c) => {
        await sql`select 1`.execute(c);
        errors.push(await sql`select 2`.execute(c).catch((e: unknown) => e));
        errors.push(await c.executeQuery(CompiledQuery.raw('insert into t values (1)')).catch((e: unknown) => e));
      });
      expect(errors[0]).toBe(fatal); // no DomainError fits 25P03: kept as it is
      expect(errors[1]).toBe(fatal);
      expect(statements()).toEqual(['1:select 1', '1:select 2']);
      expect(driver.discarded).toEqual([1]);
    });

    it.each([
      ['25P03', 'ВАЖНО'], // idle_in_transaction_session_timeout, lc_messages = ru_RU
      ['25P04', '致命的エラー'], // transaction_timeout (PostgreSQL 17), lc_messages = ja_JP
      ['57P04', 'SCHWERWIEGEND'], // database_dropped, lc_messages = de_DE
    ])(
      'a PostgreSQL error raised only as FATAL (%s) ends the session even with a localized severity (%s) (round 5, item 4)',
      async (code, severity) => {
        const fatal = pgError(code, severity)();
        driver.failure = () => fatal;
        driver.failOn = (conn, text) => conn === 1 && text === 'select 2';
        const errors: unknown[] = [];
        await db.connection().execute(async (c) => {
          await sql`select 1`.execute(c);
          errors.push(await sql`select 2`.execute(c).catch((e: unknown) => e));
          errors.push(await sql`select 3`.execute(c).catch((e: unknown) => e));
        });
        expect(errors[0]).toBe(fatal);
        expect(errors[1]).toBe(fatal);
        expect(statements()).toEqual(['1:select 1', '1:select 2']);
        expect(driver.discarded).toEqual([1]);
      },
    );

    it('a PostgreSQL ERROR with a localized severity does not end the session', async () => {
      driver.failure = pgError('42P01', 'ОШИБКА');
      driver.failOn = (conn, text) => conn === 1 && text === 'select 2';
      await db.connection().execute(async (c) => {
        await sql`select 2`.execute(c).catch(() => undefined);
        await sql`select 3`.execute(c);
      });
      expect(statements()).toEqual(['1:select 2', '1:select 3']);
      expect(driver.released).toEqual([1]);
    });

    it('a PostgreSQL ERROR (not FATAL) does not end the session', async () => {
      driver.failure = pgError('42P01', 'ERROR');
      driver.failOn = (conn, text) => conn === 1 && text === 'select 2';
      await db.connection().execute(async (c) => {
        await sql`select 2`.execute(c).catch(() => undefined);
        await sql`select 3`.execute(c);
      });
      expect(statements()).toEqual(['1:select 2', '1:select 3']);
      expect(driver.released).toEqual([1]);
    });
  });

  it('when the P17 retry cannot get a fresh connection, later statements rethrow that error (item 8)', async () => {
    driver.failOn = (conn, text) => conn === 1 && text === 'select 1';
    const refused = Object.assign(new Error('connect ECONNREFUSED 127.0.0.1:3306'), { code: 'ECONNREFUSED' });
    driver.acquireFails = (n) => (n === 2 ? refused : null);
    const errors: unknown[] = [];
    await db.connection().execute(async (c) => {
      errors.push(await sql`select 1`.execute(c).catch((e: unknown) => e)); // lost, retry cannot connect
      errors.push(await sql`select 2`.execute(c).catch((e: unknown) => e)); // e.g. a finally block
    });
    expect(errors[0]).toMatchObject({ code: 'DB_UNAVAILABLE', meta: { reason: 'unreachable' } });
    expect(errors[1]).toBe(errors[0]);
  });

  describe('mayModifyData (R28: which lost statements are in doubt)', () => {
    it.each([
      'insert into t (a) values (1)',
      'update t set a = 1',
      'delete from t',
      'replace into t values (1)',
      'create table t (a int)',
      'alter table t add b int',
      'drop table t',
      'commit',
      'call proc()',
      "select nextval('s')",
      'with d as (delete from t returning *) select * from d',
      'select a into @x from t',
      'explain analyze insert into t values (1)',
      'PRAGMA journal_mode = WAL',
      'something unknown',
      // item 9: a second statement, a long EXPLAIN option list, MariaDB compound statements, autocommit
      'select 1; delete from t',
      'select a from t /* ; */ ; update t set a = 1',
      'explain (format json, costs off, buffers on, verbose on, settings on, analyze on) delete from t',
      'explain (analyze, format json) insert into t values (1)',
      'begin not atomic insert into t values (1); end',
      'set autocommit = 1',
      'SET @@session.autocommit=1',
      // Round 3: stay conservative when the scan cannot be sure (backslashes, unterminated text, $, #, --).
      "select 'C:\\' as p, nextval('s')",
      "select 'C:\\' as p; delete from t",
      "select 'a\\'; delete from t' as x",
      "select 'abc",
      'select "abc',
      'select $$ abc',
      'select /* abc',
      "select 1 /* x */ , 'it''s",
      'select a$x$ as c; delete from t where c = b$x$',
      'select 1 # comment in MySQL, an operator elsewhere ; delete from t',
      'select 5--1; delete from t',
      // Read both ways (the dialect is not known): the MySQL reading has no dollar quotes and sees a second
      // statement. Over-marking is the safe direction.
      'select $$ ; delete from t $$ as x',
    ])('may modify data: %s', (text) => {
      expect(mayModifyData(text)).toBe(true);
    });

    it.each([
      'select 1',
      'select a from t for update',
      'select a from t for no key update nowait',
      'select a from t for share skip locked',
      'select a from t lock in share mode',
      "select get_lock('x', 10)",
      "select release_lock('x')",
      'select pg_advisory_lock(42)',
      'explain select 1',
      'show tables',
      'pragma journal_mode',
      'begin',
      'start transaction',
      'rollback',
      'savepoint sp1',
      'release savepoint sp1',
      "set session sql_mode = 'x'",
      'select 1;',
      "select ';' as x; ",
      "select 'it''s; fine' as x",
      'select 1 -- ; delete from t',
      'explain (format json) insert into t values (1)',
      'explain (analyze false) delete from t',
      'explain analyze verbose select 1',
      'set names utf8mb4',
      "select 'delete' as x",
      'select "update" from t',
    ])('changes no data: %s', (text) => {
      expect(mayModifyData(text)).toBe(false);
    });
  });
});
