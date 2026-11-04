import { randomBytes } from 'node:crypto';
import { sql, type Kysely, type RawBuilder } from 'kysely';
import mysql from 'mysql2/promise';
import pg from 'pg';
import { afterAll, beforeAll, beforeEach, describe, expect, it } from 'vitest';
import {
  TEST_DB_ROOT_PASSWORD,
  engineLabel,
  testDb,
  testDbContext,
  type TestDbHandle,
} from '../../../tools/test/test-db.js';
import { isReadOnlyStatement } from '../src/driver-guard.js';
import { withTx } from '../src/tx.js';

// P17 / ruling R14: a read outside a transaction whose connection dies is run once more on a fresh connection;
// writes and anything inside a transaction are not. The connection is killed server-side while the statement
// runs (KILL on MySQL/MariaDB, pg_terminate_backend on PostgreSQL), from a separate root/superuser session.

describe('isReadOnlyStatement', () => {
  it.each([
    'select 1',
    '  SELECT * FROM t WHERE id = ?',
    '\n    SELECT current_setting(\'server_version\') AS v',
    '(select a from t) union (select a from u)',
    '-- note\nselect 1',
    '/* hint */ select 1',
    'with x as (select 1 as a) select a from x',
    'WITH RECURSIVE r AS (SELECT 1) SELECT * FROM r',
    'show variables like ?',
    'SHOW server_version',
    'PRAGMA journal_mode',
    'pragma foreign_keys;',
    'select `updated_at`, `inserted_by` from `t`', // whole words only
  ])('reads: %s', (text) => {
    expect(isReadOnlyStatement(text)).toBe(true);
  });

  it.each([
    'insert into t (a) values (?)',
    'update t set a = ?',
    'delete from t',
    'replace into t values (1)',
    'with d as (delete from t returning *) select * from d',
    'with u as (update t set a = 1 returning a) select a from u',
    'select * into new_table from t',
    'select a from t into @x',
    'select a from t for update',
    'select a from t lock in share mode',
    "select nextval('s')",
    'begin',
    'start transaction',
    'commit',
    'create table t (a int)',
    'drop table t',
    'set session sql_mode = ?',
    'PRAGMA journal_mode = WAL',
    'PRAGMA journal_mode(WAL)',
    'pragma table_info(t)',
    'explain select 1',
    'call proc()',
    '',
    // Lock functions: the lock belongs to the session, so the statement must not move to another connection.
    "select get_lock('ea586330-2c93-47c8-908d-981d9d270f9d', 3600)",
    "select release_lock('ea586330-2c93-47c8-908d-981d9d270f9d')",
    "SELECT IS_USED_LOCK('x')",
    "select is_free_lock('x')",
    'select release_all_locks()',
    'select pg_advisory_lock(3853314791062309107)',
    'select pg_advisory_unlock(3853314791062309107)',
    'SELECT pg_try_advisory_lock(1, 2)',
    'select pg_advisory_xact_lock(1)',
    'select pg_advisory_lock_shared(1)',
    'select pg_try_advisory_xact_lock_shared(1)',
    'select pg_advisory_unlock_all()',
    // Kysely's PostgresAdapter.acquireMigrationLock, verbatim.
    `
    with set_timeout as (
      select set_config('lock_timeout', '3600000', true) as config_val
    )
    select pg_advisory_lock(3853314791062309107)
    from set_timeout`,
  ])('does not count as a read: %s', (text) => {
    expect(isReadOnlyStatement(text)).toBe(false);
  });
});

const ctx = testDbContext();
const serverEngine = ctx.engine !== 'sqlite';

type Tables = { t_retry: { id: number; v: number } };

describe.skipIf(!ctx.available || !serverEngine)(`single retry after a dropped connection [${engineLabel()}]`, () => {
  let h: TestDbHandle;
  let db: Kysely<Tables>;
  let admin: {
    sessionOf(marker: string): Promise<number | null>;
    kill(id: number): Promise<void>;
    run(text: string): Promise<void>;
    close(): Promise<void>;
  };
  const isPg = () => h.dialect === 'postgres';

  beforeAll(async () => {
    h = await testDb();
    db = h.db.withTables<Tables>();
    await db.schema
      .createTable('t_retry')
      .addColumn('id', 'integer', (c) => c.primaryKey())
      .addColumn('v', 'integer')
      .execute();
    const { host, port } = h.config;
    if (isPg()) {
      // Connected to the test database: advisory locks are per database.
      const { database } = h.config;
      const client = new pg.Client({ host, port, user: 'postgres', password: TEST_DB_ROOT_PASSWORD, database });
      client.on('error', () => {});
      await client.connect();
      admin = {
        async sessionOf(marker) {
          const { rows } = await client.query<{ pid: number }>(
            'SELECT pid FROM pg_stat_activity WHERE query LIKE $1 AND pid <> pg_backend_pid()',
            [`%${marker}%`],
          );
          return rows[0]?.pid ?? null;
        },
        async kill(id) {
          await client.query('SELECT pg_terminate_backend($1)', [id]);
        },
        async run(text) {
          await client.query(text);
        },
        close: () => client.end(),
      };
    } else {
      const conn = await mysql.createConnection({ host, port, user: 'root', password: TEST_DB_ROOT_PASSWORD });
      admin = {
        async sessionOf(marker) {
          const [rows] = await conn.query(
            'SELECT ID AS id FROM information_schema.PROCESSLIST WHERE INFO LIKE ? AND ID <> CONNECTION_ID()',
            [`%${marker}%`],
          );
          const row = (rows as { id: number }[])[0];
          return row === undefined ? null : Number(row.id);
        },
        async kill(id) {
          await conn.query('KILL ?', [id]);
        },
        async run(text) {
          await conn.query(text);
        },
        close: () => conn.end(),
      };
    }
  });

  afterAll(async () => {
    await admin?.close();
    await h?.close();
  });

  beforeEach(async () => {
    await db.deleteFrom('t_retry').execute();
  });

  /** A unique word to find the statement in the server's session list. */
  const newMarker = () => `altis_retry_${randomBytes(4).toString('hex')}`;

  /** Runs `start()`, waits until the statement carrying `marker` is running, kills its session; returns that id. */
  async function killWhileRunning(
    marker: string,
    start: () => Promise<unknown>,
  ): Promise<{ killed: number; killedAt: number; outcome: Promise<{ ok: boolean; value?: unknown; error?: unknown; at: number }> }> {
    const outcome = start().then(
      (value) => ({ ok: true, value, at: Date.now() }),
      (error: unknown) => ({ ok: false, error, at: Date.now() }),
    );
    const deadline = Date.now() + 5000;
    let id: number | null = null;
    while (id === null && Date.now() < deadline) {
      id = await admin.sessionOf(marker);
      if (id === null) await new Promise((resolve) => setTimeout(resolve, 20));
    }
    if (id === null) throw new Error(`no session found running ${marker}`);
    await admin.kill(id);
    return { killed: id, killedAt: Date.now(), outcome };
  }

  /** `SELECT <session id> AS id` that sleeps 1 s, tagged with `marker`. */
  function slowSessionId(marker: string): RawBuilder<{ id: number }> {
    return isPg()
      ? sql<{ id: number }>`SELECT pg_backend_pid() AS id, pg_sleep(1) AS ${sql.id(marker)}`
      : sql<{ id: number }>`SELECT CONNECTION_ID() AS id, SLEEP(1) AS ${sql.id(marker)}`;
  }

  it('a SELECT succeeds through one retry on a fresh connection', async () => {
    const marker = newMarker();
    const query = slowSessionId(marker);
    const { killed, outcome } = await killWhileRunning(marker, () => query.execute(h.db));
    const result = await outcome;
    expect(result.error).toBeUndefined();
    expect(result.ok).toBe(true);
    const id = Number((result.value as { rows: { id: number }[] } | undefined)?.rows[0]?.id);
    expect(id).toBeGreaterThan(0);
    expect(id).not.toBe(killed); // answered by another session: the retry
  });

  it('an INSERT is executed once: it fails with DB_UNAVAILABLE retryable instead of being re-run', async () => {
    const marker = newMarker();
    // v records how the sleep ended: MySQL/MariaDB SLEEP() returns 1 when interrupted, 0 when it ran to the end.
    const insert = isPg()
      ? sql`INSERT INTO t_retry (id, v) SELECT 1, 0 FROM (SELECT pg_sleep(1)) AS ${sql.id(marker)}`
      : sql`INSERT INTO t_retry (id, v) SELECT 1, SLEEP(1) AS ${sql.id(marker)}`;
    const { killedAt, outcome } = await killWhileRunning(marker, () => insert.execute(h.db));
    const result = await outcome;
    expect(result.ok).toBe(false);
    // Whether the killed INSERT took effect is unknown to the client: the error says so.
    expect(result.error).toMatchObject({
      code: 'DB_UNAVAILABLE',
      meta: { reason: 'connection_lost', retryable: true, inDoubt: true },
    });
    // A second attempt would have slept another full second before answering.
    expect(result.at - killedAt).toBeLessThan(900);
    // Whether the killed attempt took effect is up to the server (that is why writes are not retried): MariaDB and
    // PostgreSQL roll it back, MySQL 8.4 may finish it with the interrupted SLEEP returning 1. Never a second row,
    // and never a row from an attempt that slept to the end.
    const rows = await db.selectFrom('t_retry').selectAll().execute();
    expect(rows.length).toBeLessThanOrEqual(1);
    if (rows.length === 1) expect(rows[0]).toEqual({ id: 1, v: 1 });
    if (isPg()) expect(rows).toEqual([]);
    await db.deleteFrom('t_retry').execute();
    // The pool recovers.
    await db.insertInto('t_retry').values({ id: 2, v: 2 }).execute();
    expect(await db.selectFrom('t_retry').select('id').execute()).toEqual([{ id: 2 }]);
  });

  it('a SELECT inside withTx is not retried', async () => {
    const marker = newMarker();
    const query = slowSessionId(marker);
    const { killedAt, outcome } = await killWhileRunning(marker, () => withTx(h, (trx) => query.execute(trx)));
    const result = await outcome;
    // A retry would have answered from a fresh session, a second later; the transaction fails at once instead.
    expect(result.ok).toBe(false);
    expect(result.at - killedAt).toBeLessThan(900);
    expect(result.error).toMatchObject({
      code: 'DB_UNAVAILABLE',
      meta: { reason: 'connection_lost', retryable: true },
    });
    expect((result.error as { meta: Record<string, unknown> }).meta['inDoubt']).toBeUndefined(); // a read
    const { rows } = await sql<{ one: number }>`SELECT 1 AS one`.execute(h.db);
    expect(rows).toEqual([{ one: 1 }]);
  });

  it('a later SELECT on a pinned connection is not retried: the session it ran in is gone', async () => {
    // Session state (a GET_LOCK, a pg advisory lock, SET values) taken by the first statement would not follow
    // the statement to a fresh connection, so the scope must fail instead of carrying on without it.
    const marker = newMarker();
    const query = slowSessionId(marker);
    let first: number | undefined;
    const { killed, killedAt, outcome } = await killWhileRunning(marker, () =>
      h.db.connection().execute(async (c) => {
        const { rows } = await (isPg()
          ? sql<{ id: number }>`SELECT pg_backend_pid() AS id`
          : sql<{ id: number }>`SELECT CONNECTION_ID() AS id`
        ).execute(c);
        first = Number(rows[0]?.id);
        return query.execute(c);
      }),
    );
    const result = await outcome;
    expect(first).toBe(killed); // both statements ran in the killed session
    expect(result.ok).toBe(false);
    expect(result.at - killedAt).toBeLessThan(900);
    expect(result.error).toMatchObject({ code: 'DB_UNAVAILABLE', meta: { reason: 'connection_lost' } });
    const { rows } = await sql<{ one: number }>`SELECT 1 AS one`.execute(h.db);
    expect(rows).toEqual([{ one: 1 }]);
  });

  it('a statement sent after the loss (a finally block) does not mask the original error', async () => {
    // Kysely's runWithLock releases its migration lock in `finally` on the same pinned connection.
    const marker = newMarker();
    const query = slowSessionId(marker);
    let original: unknown;
    const { outcome } = await killWhileRunning(marker, () =>
      h.db.connection().execute(async (c) => {
        await sql`SELECT 1 AS one`.execute(c);
        try {
          return await query.execute(c);
        } catch (error) {
          original = error;
          throw error;
        } finally {
          await (isPg() ? sql`SELECT pg_advisory_unlock(1)` : sql`SELECT RELEASE_LOCK('altis_retry_none')`).execute(c);
        }
      }),
    );
    const result = await outcome;
    expect(result.ok).toBe(false);
    expect(result.error).toBe(original);
    expect(result.error).toMatchObject({ code: 'DB_UNAVAILABLE', meta: { reason: 'connection_lost', retryable: true } });
  });

  it('a pinned connection whose session dies while idle does not crash the process (item 2)', async () => {
    // pg emits 'error' on a checked-out client whose connection dies between queries; pg-pool's own listener is
    // only there while the client is idle in the pool. Unhandled, that event would be an uncaught exception.
    const outcome = await h.db.connection().execute(async (c) => {
      const { rows } = await (isPg()
        ? sql<{ id: number }>`SELECT pg_backend_pid() AS id`
        : sql<{ id: number }>`SELECT CONNECTION_ID() AS id`
      ).execute(c);
      await admin.kill(Number(rows[0]?.id));
      await new Promise((resolve) => setTimeout(resolve, 500)); // the client sees its session end while idle
      return sql`SELECT 1 AS one`.execute(c).then(
        () => ({ ok: true as const, error: undefined }),
        (error: unknown) => ({ ok: false as const, error }),
      );
    });
    expect(outcome.ok).toBe(false);
    expect(outcome.error).toMatchObject({ code: 'DB_UNAVAILABLE', meta: { reason: 'connection_lost', code: 'NOT_SENT' } });
    expect((outcome.error as { meta: Record<string, unknown> }).meta['inDoubt']).toBeUndefined();
    // The pool recovers.
    const { rows } = await sql<{ one: number }>`SELECT 1 AS one`.execute(h.db);
    expect(rows).toEqual([{ one: 1 }]);
  });

  it.skipIf(!ctx.engine.startsWith('mariadb'))(
    'a connection whose session the server ended after an error is never handed out again (round 4, item 5)',
    async () => {
      // MariaDB answers a packet over max_allowed_packet (16 MiB by default; MySQL's 64 MiB would make this test
      // slow) with error 1153 and then closes the session. The error arrives before the socket close is processed:
      // a connection released at once would go back to the pool and be handed to the next acquirer dead.
      const { rows } = await sql<{ max: number }>`SELECT @@max_allowed_packet AS max`.execute(h.db);
      const big = 'x'.repeat(Number(rows[0]?.max) + 1024);
      for (let round = 0; round < 3; round += 1) {
        let ended = 0;
        const error = await h.db
          .connection()
          .execute(async (c) => {
            ended = Number((await sql<{ id: number }>`SELECT CONNECTION_ID() AS id`.execute(c)).rows[0]?.id);
            return sql`SELECT ${big} AS big`.execute(c);
          })
          .catch((e: unknown) => e);
        expect(error).toMatchObject({ code: 'DB_UNAVAILABLE', meta: { reason: 'packet_too_large' } });
        // At once, a statement that is never retried (it calls a lock function): on the dead connection it would fail.
        const next = await h.db
          .connection()
          .execute((c) => sql<{ id: number }>`SELECT CONNECTION_ID() AS id, IS_FREE_LOCK('altis_retry_none') AS f`.execute(c));
        expect(Number(next.rows[0]?.id)).toBeGreaterThan(0);
        expect(Number(next.rows[0]?.id)).not.toBe(ended);
      }
    },
  );

  it('a lock function is not retried even as the first statement of its connection', async () => {
    // The admin session holds the lock, so the statement waits for it until killed. A retry would wait again on a
    // fresh connection (3 s, then fail or return 0) instead of failing at once.
    const marker = newMarker();
    const key = Number.parseInt(marker.slice(-8), 16);
    if (isPg()) await admin.run(`SELECT pg_advisory_lock(${key})`);
    else await admin.run(`SELECT GET_LOCK('${marker}', 10)`);
    try {
      const lock = isPg()
        ? sql`WITH set_timeout AS (SELECT set_config('lock_timeout', '3000', true) AS v)
            SELECT pg_advisory_lock(${sql.lit(key)}) AS ${sql.id(marker)} FROM set_timeout`
        : sql`SELECT GET_LOCK(${sql.lit(marker)}, 3) AS got`;
      const { killedAt, outcome } = await killWhileRunning(marker, () => lock.execute(h.db));
      const result = await outcome;
      expect(result.ok).toBe(false);
      expect(result.at - killedAt).toBeLessThan(900);
      expect(result.error).toMatchObject({ code: 'DB_UNAVAILABLE', meta: { reason: 'connection_lost' } });
      // R28: a lock call changes no data, so it is not in doubt.
      expect((result.error as { meta: Record<string, unknown> }).meta['inDoubt']).toBeUndefined();
    } finally {
      if (isPg()) await admin.run(`SELECT pg_advisory_unlock(${key})`);
      else await admin.run(`SELECT RELEASE_LOCK('${marker}')`);
    }
  });
});
