import fsp from 'node:fs/promises';
import os from 'node:os';
import path from 'node:path';
import { isDomainError, newId } from '@altis/shared';
import {
  RawNode,
  SelectQueryNode,
  UpdateQueryNode,
  type KyselyPlugin,
  type OperationNode,
  type QueryId,
  type Transaction,
} from 'kysely';
import { afterAll, beforeAll, beforeEach, describe, expect, it } from 'vitest';
import { engineLabel, testDb, testDbContext, type TestDbHandle } from '../../../tools/test/test-db.js';
import { claimLock, increment, releaseLock, upsert } from '../src/concurrency.js';
import { runMigrations } from '../src/migrator.js';
import { PHASE1_MIGRATIONS } from '../src/migrations/index.js';
import type { DB } from '../src/schema.js';
import { withTx } from '../src/tx.js';
import { runChildren } from './fixtures/children.js';

// The concurrency primitives of spec §6.3 (rulings for Task 10, R37/R37b): upsert, increment and the named locks, on
// the real Phase 1 tables (settings, rate_limits, staff_users, locks), on the engine picked by ALTIS_TEST_DB.
//
// "Separate connections": on a server engine the in-process writers are spread over two handles (pools of 8), so up
// to 16 transactions run at once. SQLite has one connection per process (a second DatabaseSync in the same process
// would block the event loop in busy_timeout), so there the in-process writers share one handle (Kysely serializes
// them) and the cross-connection runs use child processes. The child processes run on every engine; on the server
// engines they are Passenger workers with a pool of 3 each. The largest run is the production maximum: 6 workers x 3
// connections, 54 increments of one absent counter.
//
// Races that timing alone would rarely produce are forced with Kysely plugins: a barrier after the primitive's
// UPDATE (every writer finds the row absent before any inserts), or a row that appears or vanishes between two of the
// primitive's statements. Each forced test asserts that the race happened and which path the engine took
// (MySQL/MariaDB: gap-lock deadlocks, retried by withTx; PostgreSQL: UNIQUE_VIOLATION absorbed by the savepoint).

const ctx = testDbContext();
const SQLITE = ctx.engine === 'sqlite';
const POSTGRES = ctx.engine === 'pg15' || ctx.engine === 'pg17';
const MYSQL_FAMILY = !SQLITE && !POSTGRES;

/** The SQL text of a raw node (the primitives' savepoint statements are constant `sql` templates). */
function rawText(node: OperationNode): string | null {
  return RawNode.is(node) ? node.sqlFragments.join('?') : null;
}

/** A plugin that, once the first statement matching `is` has returned, runs `then` before handing the result on. */
function afterFirst(is: (node: OperationNode) => boolean, then: () => Promise<void>): KyselyPlugin {
  let first: QueryId | null = null;
  return {
    transformQuery({ node, queryId }) {
      if (first === null && is(node)) first = queryId;
      return node;
    },
    async transformResult({ queryId, result }) {
      if (queryId === first) await then();
      return result;
    },
  };
}

const afterFirstUpdate = (then: () => Promise<void>) => afterFirst((n) => UpdateQueryNode.is(n), then);

/**
 * A race of `parties` writers that all pass the primitive's first UPDATE (finding no row) before any of them goes
 * on. `run` wraps one writer: the barrier on its first attempt only (a retried transaction must not wait for writers
 * already done), and on every attempt a count of the savepoint rollbacks (the UNIQUE_VIOLATION path).
 */
function forcedRace(parties: number) {
  let arrived = 0;
  let release!: () => void;
  const all = new Promise<void>((resolve) => {
    release = resolve;
  });
  const meet = async () => {
    arrived += 1;
    if (arrived === parties) release();
    await all;
  };
  const attempts: number[] = [];
  let rollbacks = 0;
  const counting: KyselyPlugin = {
    transformQuery({ node }) {
      if (rawText(node)?.startsWith('rollback to savepoint') === true) rollbacks += 1;
      return node;
    },
    transformResult: async ({ result }) => result,
  };
  const run = <T>(handle: TestDbHandle, f: (trx: Transaction<DB>) => Promise<T>): Promise<T> => {
    const i = attempts.push(0) - 1;
    return withTx(handle, (trx) => {
      attempts[i] = (attempts[i] ?? 0) + 1;
      const counted = trx.withPlugin(counting);
      return f(attempts[i] === 1 ? counted.withPlugin(afterFirstUpdate(meet)) : counted);
    });
  };
  /** The race happened, and each engine family took its path. */
  const expectRaced = () => {
    expect(arrived).toBe(parties);
    if (MYSQL_FAMILY) expect(Math.max(...attempts)).toBeGreaterThan(1); // gap-lock deadlocks, retried (R37)
    if (POSTGRES) {
      expect(attempts.every((a) => a === 1)).toBe(true); // no deadlock
      expect(rollbacks).toBe(parties - 1); // every loser's INSERT met the winner's row
    }
  };
  return { run, expectRaced };
}

async function expectTypeError(p: Promise<unknown>, pattern: RegExp): Promise<TypeError> {
  const error = await p.catch((e: unknown) => e);
  expect(error).toBeInstanceOf(TypeError);
  expect((error as TypeError).message).toMatch(pattern);
  return error as TypeError;
}

const user = (id: string, username: string) => ({
  id,
  username_key: username.toUpperCase(),
  username_display: username,
  name: username,
  password_hash: 'x',
  status: 'active',
  created_at: 1,
  updated_at: 1,
});

describe.skipIf(!ctx.available)(`concurrency primitives (spec §6.3) [${engineLabel()}]`, () => {
  let h: TestDbHandle;
  /** Server engines: h and one more handle, two pools of 8. SQLite: h only. */
  let handles: TestDbHandle[];
  let dataDir: string;
  const fixture = 'concurrency-child.mjs';

  beforeAll(async () => {
    h = await testDb();
    dataDir = await fsp.mkdtemp(path.join(os.tmpdir(), 'altis-concurrency-'));
    await runMigrations(h, { appVersion: '0.1.0', dataDir, migrations: PHASE1_MIGRATIONS });
    handles = [h];
    if (!SQLITE) handles.push(await testDb({ reset: false }));
  });

  afterAll(async () => {
    for (const x of (handles ?? []).slice(1)) await x.close();
    await h?.close();
    if (dataDir !== undefined) await fsp.rm(dataDir, { recursive: true, force: true });
  });

  beforeEach(async () => {
    await h.db.deleteFrom('settings').execute();
    await h.db.deleteFrom('rate_limits').execute();
    await h.db.deleteFrom('locks').execute();
    await h.db.deleteFrom('staff_users').execute();
  });

  /** The handle writer `i` uses. */
  const writer = (i: number) => handles[i % handles.length]!;
  const childBase = () => ({ config: h.config, dataDir: h.dataDir });

  async function setting(key: string) {
    return h.db.selectFrom('settings').select(['key', 'value', 'scope', 'updated_at']).where('key', '=', key).execute();
  }

  async function counter(bucket: string, windowStart: number) {
    return h.db
      .selectFrom('rate_limits')
      .select(['bucket', 'window_start', 'bucket_name', 'count'])
      .where('bucket', '=', bucket)
      .where('window_start', '=', windowStart)
      .execute();
  }

  const BUCKET = 'a'.repeat(64);
  const WINDOW = 1_767_225_600_000;
  const bucketWhere = { bucket: BUCKET, window_start: WINDOW };
  const MARKER = { key: 'marker', value: '1', scope: 'data', updated_at: 1 } as const;

  /**
   * Runs `call` inside a transaction, expects its TypeError, checks through the same transaction that it wrote
   * nothing to `table`, writes a marker row and commits: so a write made before the TypeError would be committed
   * (and seen), not hidden by a rollback.
   */
  async function refusedBeforeWriting(
    table: 'settings' | 'rate_limits',
    call: (trx: Transaction<DB>) => Promise<unknown>,
    pattern: RegExp,
  ): Promise<void> {
    await withTx(h, async (trx) => {
      await expectTypeError(call(trx), pattern);
      expect(await trx.selectFrom(table).selectAll().execute()).toEqual([]);
      await trx.insertInto('settings').values(MARKER).execute();
    });
    expect(await h.db.selectFrom('settings').select('key').execute()).toEqual([{ key: 'marker' }]);
    expect(await h.db.selectFrom('rate_limits').selectAll().execute()).toEqual([]);
  }

  /**
   * A plugin for one transaction `trx`: after the primitive's first UPDATE, a row appears (`appear`); after the
   * savepoint released following the rolled-back INSERT, it vanishes again (`vanish`), as when another writer
   * inserts the row and an admin deletes it before our second UPDATE (PostgreSQL READ COMMITTED).
   */
  function appearsThenVanishes(appear: () => Promise<void>, vanish: () => Promise<void>): KyselyPlugin {
    let firstUpdate: QueryId | null = null;
    let rolledBack = false;
    let releaseAfterRollback: QueryId | null = null;
    return {
      transformQuery({ node, queryId }) {
        if (firstUpdate === null && UpdateQueryNode.is(node)) firstUpdate = queryId;
        const text = rawText(node);
        if (text?.startsWith('rollback to savepoint') === true) rolledBack = true;
        if (rolledBack && releaseAfterRollback === null && text?.startsWith('release savepoint') === true) {
          releaseAfterRollback = queryId;
        }
        return node;
      },
      async transformResult({ queryId, result }) {
        if (queryId === firstUpdate) await appear();
        if (queryId === releaseAfterRollback) await vanish();
        return result;
      },
    };
  }

  // -------------------------------------------------------------------------------------------------------------
  describe('upsert', () => {
    const put = (trx: Transaction<DB>, key: string, value: string) =>
      upsert(trx, 'settings', { key }, { value, scope: 'data', updated_at: 1 }, { value, updated_at: 2 });

    it('inserts the row when the key is absent', async () => {
      expect(await withTx(h, (trx) => put(trx, 'k', '"one"'))).toBe('inserted');
      expect(await setting('k')).toEqual([{ key: 'k', value: '"one"', scope: 'data', updated_at: 1 }]);
    });

    it('updates only the updateSet columns when the key is present', async () => {
      await withTx(h, (trx) => put(trx, 'k', '"one"'));
      expect(await withTx(h, (trx) => put(trx, 'k', '"two"'))).toBe('updated');
      expect(await setting('k')).toEqual([{ key: 'k', value: '"two"', scope: 'data', updated_at: 2 }]);
    });

    it("counts a row whose values do not change as updated (MySQL reports matched rows: mysql2's FOUND_ROWS)", async () => {
      await withTx(h, (trx) => put(trx, 'k', '"one"'));
      await withTx(h, (trx) => put(trx, 'k', '"one"'));
      expect(await withTx(h, (trx) => put(trx, 'k', '"one"'))).toBe('updated');
      expect(await setting('k')).toHaveLength(1);
    });

    it("accepts an empty string as a key value (user_roles.scope_key '' is the global scope)", async () => {
      expect(await withTx(h, (trx) => put(trx, '', '"global"'))).toBe('inserted');
      expect(await withTx(h, (trx) => put(trx, '', '"again"'))).toBe('updated');
      expect(await setting('')).toEqual([{ key: '', value: '"again"', scope: 'data', updated_at: 2 }]);
    });

    it('a row that appears between its UPDATE and its INSERT: the UNIQUE_VIOLATION is rolled back to the savepoint and the UPDATE runs once', async () => {
      const result = await withTx(h, async (trx) => {
        const racing = trx.withPlugin(
          afterFirstUpdate(async () => {
            await trx.insertInto('settings').values({ key: 'k', value: '"other"', scope: 'data', updated_at: 9 }).execute();
          }),
        );
        const outcome = await put(racing, 'k', '"mine"');
        // The transaction is still usable afterwards (PostgreSQL aborts it unless the savepoint was rolled back).
        await trx.insertInto('settings').values({ key: 'after', value: '1', scope: 'data', updated_at: 3 }).execute();
        return outcome;
      });
      expect(result).toBe('updated');
      expect(await setting('k')).toEqual([{ key: 'k', value: '"mine"', scope: 'data', updated_at: 2 }]);
      expect(await setting('after')).toHaveLength(1);
    });

    it('a row that appears before its INSERT and vanishes before its second UPDATE: the INSERT is tried once more (item 10)', async () => {
      const result = await withTx(h, async (trx) => {
        const racing = trx.withPlugin(
          appearsThenVanishes(
            async () => {
              await trx.insertInto('settings').values({ key: 'k', value: '"other"', scope: 'data', updated_at: 9 }).execute();
            },
            async () => {
              await trx.deleteFrom('settings').where('key', '=', 'k').execute();
            },
          ),
        );
        return put(racing, 'k', '"mine"');
      });
      expect(result).toBe('inserted');
      expect(await setting('k')).toEqual([{ key: 'k', value: '"mine"', scope: 'data', updated_at: 1 }]);
    });

    it('rethrows a UNIQUE_VIOLATION of another unique key, and leaves the transaction usable', async () => {
      const first = newId();
      await h.db.insertInto('staff_users').values(user(first, 'ani')).execute();
      const second = newId();
      const seen = await withTx(h, async (trx) => {
        const error = await upsert(trx, 'staff_users', { id: second }, user(second, 'ani'), { name: 'x' }).catch(
          (e: unknown) => e,
        );
        await trx.insertInto('settings').values({ key: 'after', value: '1', scope: 'data', updated_at: 3 }).execute();
        return error;
      });
      expect(isDomainError(seen) && seen.code === 'UNIQUE_VIOLATION').toBe(true);
      expect(await h.db.selectFrom('staff_users').select('id').execute()).toEqual([{ id: first }]);
      expect(await setting('after')).toHaveLength(1);
    });

    it('several primitives at once on one transaction run one after another; their savepoints never interleave (item 7)', async () => {
      const taken = newId();
      await h.db.insertInto('staff_users').values(user(taken, 'ani')).execute();
      const [a, b] = [newId(), newId()];
      const bumpIt = (trx: Transaction<DB>) => increment(trx, 'rate_limits', bucketWhere, 'count', { bucket_name: 'x' });
      const results = await withTx(h, (trx) =>
        Promise.allSettled([
          upsert(trx, 'staff_users', { id: a }, user(a, 'ani'), { name: 'x' }), // collides on username_key
          upsert(trx, 'staff_users', { id: b }, user(b, 'budi'), { name: 'x' }),
          put(trx, 'k1', '"1"'),
          put(trx, 'k2', '"2"'),
          bumpIt(trx),
          bumpIt(trx),
        ]),
      );
      expect(results[0]).toMatchObject({ status: 'rejected', reason: { code: 'UNIQUE_VIOLATION' } });
      expect(results.slice(1).map((r) => (r.status === 'fulfilled' ? r.value : r.reason))).toEqual([
        'inserted',
        'inserted',
        'inserted',
        1,
        2,
      ]);
      expect((await h.db.selectFrom('staff_users').select('id').execute()).map((r) => r.id).sort()).toEqual([taken, b].sort());
      expect(await setting('k1')).toHaveLength(1);
      expect(await setting('k2')).toHaveLength(1);
      expect(await counter(BUCKET, WINDOW)).toMatchObject([{ count: 2 }]);
    });

    it('10 parallel upserts of one key on separate connections: 1 row, no error, one insert, the value of one writer', async () => {
      const values = Array.from({ length: 10 }, (_, i) => JSON.stringify(`w${i}`));
      const outcomes = await Promise.all(values.map((value, i) => withTx(writer(i), (trx) => put(trx, 'k', value))));
      expect(outcomes.filter((o) => o === 'inserted')).toHaveLength(1);
      expect(outcomes.filter((o) => o === 'updated')).toHaveLength(9);
      const rows = await setting('k');
      expect(rows).toHaveLength(1);
      expect(values).toContain(rows[0]!.value);
    });

    it.skipIf(SQLITE)('10 writers that all find the key absent before any inserts (forced race): 1 row, no error', async () => {
      const race = forcedRace(10);
      const values = Array.from({ length: 10 }, (_, i) => JSON.stringify(`w${i}`));
      const outcomes = await Promise.all(values.map((value, i) => race.run(writer(i), (trx) => put(trx, 'k', value))));
      race.expectRaced();
      expect(outcomes.filter((o) => o === 'inserted')).toHaveLength(1);
      const rows = await setting('k');
      expect(rows).toHaveLength(1);
      expect(values).toContain(rows[0]!.value);
    });

    it('2 processes x 5 upserts of one key: 1 row, no error, one insert, the value of one writer', async () => {
      const run = await runChildren<{ results: string[] }>(
        fixture,
        ['p0', 'p1'].map((tag) => ({ ...childBase(), op: 'upsert', count: 5, tag, key: 'k' })),
      );
      expect(run.codes).toEqual([0, 0]);
      const outcomes = run.reports.flatMap((r) => r?.results ?? []);
      expect(outcomes).toHaveLength(10);
      expect(outcomes.filter((o) => o === 'inserted')).toHaveLength(1);
      const rows = await setting('k');
      expect(rows).toHaveLength(1);
      const written = ['p0', 'p1'].flatMap((tag) => Array.from({ length: 5 }, (_, i) => JSON.stringify(`${tag}-${i}`)));
      expect(written).toContain(rows[0]!.value);
    });

    describe('arguments are checked before anything is written', () => {
      it('needs a transaction', async () => {
        await expectTypeError(
          upsert(h.db as unknown as Transaction<DB>, 'settings', { key: 'k' }, {}, { value: '1' }),
          /transaction/,
        );
      });

      it.each([
        ['an invalid table name', 'Settings', { key: 'k' }, {}, { value: '1' }, /table name/],
        ['an invalid column name in key', 'settings', { 'key; drop': 'k' }, {}, { value: '1' }, /column name/],
        ['an invalid column name in insertRow', 'settings', { key: 'k' }, { 'x-y': 1 }, { value: '1' }, /column name/],
        ['an invalid column name in updateSet', 'settings', { key: 'k' }, {}, { 'a b': '1' }, /column name/],
        ['an empty key', 'settings', {}, {}, { value: '1' }, /key/],
        ['an empty updateSet', 'settings', { key: 'k' }, {}, {}, /updateSet/],
        ['a null key value', 'settings', { key: null }, {}, { value: '1' }, /null/],
        ['a key value ending in a blank (MySQL PAD SPACE would match "k")', 'settings', { key: 'k ' }, {}, { value: '1' }, /blank/],
        ['a key value holding NUL', 'settings', { key: 'k\u0000' }, {}, { value: '1' }, /NUL/],
        ['a key value with a lone surrogate', 'settings', { key: 'k\uD800' }, {}, { value: '1' }, /surrogate/],
        ['an undefined value', 'settings', { key: 'k' }, { value: undefined }, { value: '1' }, /undefined/],
        ['a boolean value', 'settings', { key: 'k' }, {}, { is_secret: true }, /boolean/],
        ['an object value', 'settings', { key: 'k' }, {}, { value: { a: 1 } }, /value/],
        ['a non-finite number', 'settings', { key: 'k' }, {}, { updated_at: Number.NaN }, /finite/],
        ['an insertRow that contradicts the key', 'settings', { key: 'k' }, { key: 'other' }, { value: '1' }, /contradicts/],
      ])('TypeError for %s', async (_name, table, key, insertRow, updateSet, pattern) => {
        await refusedBeforeWriting(
          'settings',
          (trx) => upsert(trx, table as 'settings', key as Record<string, unknown>, insertRow as Record<string, unknown>, updateSet),
          pattern,
        );
      });
    });
  });

  // -------------------------------------------------------------------------------------------------------------
  describe('increment', () => {
    const bump = (trx: Transaction<DB>) => increment(trx, 'rate_limits', bucketWhere, 'count', { bucket_name: 'login:ani' });

    it('creates the row with the column at 1 when absent, then counts up; the value is read after the increment', async () => {
      expect(await withTx(h, bump)).toBe(1);
      expect(await withTx(h, bump)).toBe(2);
      expect(await withTx(h, bump)).toBe(3);
      expect(await counter(BUCKET, WINDOW)).toEqual([{ ...bucketWhere, bucket_name: 'login:ani', count: 3 }]);
    });

    it('reads its own increment inside the transaction, after earlier reads of the same row', async () => {
      await withTx(h, bump);
      const seen = await withTx(h, async (trx) => {
        const before = await trx.selectFrom('rate_limits').select('count').where('bucket', '=', BUCKET).executeTakeFirst();
        return [before?.count, await bump(trx)];
      });
      expect(seen).toEqual([1, 2]);
    });

    it('a row that appears between its UPDATE and its INSERT: rolled back to the savepoint, then incremented once', async () => {
      const value = await withTx(h, async (trx) => {
        const racing = trx.withPlugin(
          afterFirstUpdate(async () => {
            await trx.insertInto('rate_limits').values({ ...bucketWhere, bucket_name: 'other', count: 5 }).execute();
          }),
        );
        return bump(racing);
      });
      expect(value).toBe(6);
      expect(await counter(BUCKET, WINDOW)).toEqual([{ ...bucketWhere, bucket_name: 'other', count: 6 }]);
    });

    it('a row that appears before its INSERT and vanishes before its second UPDATE: the INSERT is tried once more (item 10)', async () => {
      const value = await withTx(h, async (trx) => {
        const racing = trx.withPlugin(
          appearsThenVanishes(
            async () => {
              await trx.insertInto('rate_limits').values({ ...bucketWhere, bucket_name: 'other', count: 5 }).execute();
            },
            async () => {
              await trx.deleteFrom('rate_limits').where('bucket', '=', BUCKET).execute();
            },
          ),
        );
        return bump(racing);
      });
      expect(value).toBe(1);
      expect(await counter(BUCKET, WINDOW)).toEqual([{ ...bucketWhere, bucket_name: 'login:ani', count: 1 }]);
    });

    it('50 parallel increments on separate connections: final value 50, each call read a distinct value 1..50', async () => {
      const values = await Promise.all(Array.from({ length: 50 }, (_, i) => withTx(writer(i), bump)));
      expect([...values].sort((a, b) => a - b)).toEqual(Array.from({ length: 50 }, (_, i) => i + 1));
      expect(await counter(BUCKET, WINDOW)).toEqual([{ ...bucketWhere, bucket_name: 'login:ani', count: 50 }]);
    });

    it.skipIf(SQLITE)('10 increments that all find the row absent before any inserts (forced race): final value 10', async () => {
      const race = forcedRace(10);
      const values = await Promise.all(Array.from({ length: 10 }, (_, i) => race.run(writer(i), bump)));
      race.expectRaced();
      expect([...values].sort((a, b) => a - b)).toEqual(Array.from({ length: 10 }, (_, i) => i + 1));
      expect(await counter(BUCKET, WINDOW)).toEqual([{ ...bucketWhere, bucket_name: 'login:ani', count: 10 }]);
    });

    it('the production maximum, 6 Passenger workers x pool 3, 54 increments of one absent counter: values exactly 1..54, no TX_CONFLICT (item 13)', async () => {
      const run = await runChildren<{ results: number[]; attempts: number }>(
        fixture,
        Array.from({ length: 6 }, (_, p) => ({ ...childBase(), op: 'increment', count: 9, tag: `p${p}`, bucket: BUCKET, windowStart: WINDOW })),
      );
      // A TX_CONFLICT (or any error) would make its child exit 1.
      expect(run.codes).toEqual([0, 0, 0, 0, 0, 0]);
      const values = run.reports.flatMap((r) => r?.results ?? []);
      expect([...values].sort((a, b) => a - b)).toEqual(Array.from({ length: 54 }, (_, i) => i + 1));
      expect(await counter(BUCKET, WINDOW)).toEqual([{ ...bucketWhere, bucket_name: BUCKET, count: 54 }]);
      // Every call ran at least once and at most the R37b limit (5 attempts on MySQL/MariaDB).
      const attempts = run.reports.reduce((n, r) => n + (r?.attempts ?? 0), 0);
      expect(attempts).toBeGreaterThanOrEqual(54);
      expect(attempts).toBeLessThanOrEqual(54 * 5);
    });

    describe('arguments are checked before anything is written', () => {
      it('needs a transaction', async () => {
        await expectTypeError(increment(h.db as unknown as Transaction<DB>, 'rate_limits', bucketWhere, 'count', {}), /transaction/);
      });

      it.each([
        ['an invalid column', 'rate_limits', bucketWhere, 'Count', {}, /column name/],
        ['a column that is part of where', 'rate_limits', bucketWhere, 'window_start', {}, /where/],
        ['an empty where', 'rate_limits', {}, 'count', {}, /where/],
        ['a where value ending in a blank', 'rate_limits', { bucket: 'b ', window_start: 1 }, 'count', {}, /blank/],
        ['an insertRow column value other than 1', 'rate_limits', bucketWhere, 'count', { count: 0 }, /1/],
        ['an insertRow that contradicts where', 'rate_limits', bucketWhere, 'count', { bucket: 'b'.repeat(64) }, /contradicts/],
      ])('TypeError for %s', async (_name, table, where, column, insertRow, pattern) => {
        await refusedBeforeWriting('rate_limits', (trx) => increment(trx, table as 'rate_limits', where, column, insertRow), pattern);
      });

      it('TypeError when where matches more than one row (and the transaction rolls back)', async () => {
        await h.db
          .insertInto('rate_limits')
          .values([
            { bucket: BUCKET, window_start: 1, bucket_name: 'x', count: 1 },
            { bucket: BUCKET, window_start: 2, bucket_name: 'x', count: 1 },
          ])
          .execute();
        await expectTypeError(
          withTx(h, (trx) => increment(trx, 'rate_limits', { bucket: BUCKET }, 'count', {})),
          /more than one row/,
        );
        const counts = await h.db.selectFrom('rate_limits').select('count').execute();
        expect(counts).toEqual([{ count: 1 }, { count: 1 }]);
      });
    });
  });

  // -------------------------------------------------------------------------------------------------------------
  describe('claimLock / releaseLock', () => {
    async function lockRow(name: string) {
      return h.db.selectFrom('locks').select(['name', 'owner', 'until']).where('name', '=', name).execute();
    }

    /** Lets the lock expire without waiting: until = now - 1. */
    async function expire(name: string): Promise<void> {
      await h.db.updateTable('locks').set({ until: Date.now() - 1 }).where('name', '=', name).execute();
    }

    it('claims an absent lock with until = now + ttlMs', async () => {
      const before = Date.now();
      expect(await claimLock(h, 'job:x', 'owner-a', 60_000)).toBe(true);
      const [row] = await lockRow('job:x');
      expect(row?.owner).toBe('owner-a');
      expect(row!.until).toBeGreaterThanOrEqual(before + 60_000);
      expect(row!.until).toBeLessThanOrEqual(Date.now() + 60_000);
    });

    it('two owners at once on separate connections: exactly one gets it; once expired the other takes it over', async () => {
      const results = await Promise.all([
        claimLock(writer(0), 'job:x', 'owner-a', 60_000),
        claimLock(writer(1), 'job:x', 'owner-b', 60_000),
      ]);
      expect(results.filter(Boolean)).toHaveLength(1);
      const winner = results[0] ? 'owner-a' : 'owner-b';
      const loser = results[0] ? 'owner-b' : 'owner-a';
      expect(await claimLock(h, 'job:x', loser, 60_000)).toBe(false); // still held
      await expire('job:x');
      expect(await claimLock(h, 'job:x', loser, 60_000)).toBe(true); // expired: taken over
      expect(await claimLock(h, 'job:x', winner, 60_000)).toBe(false);
      expect((await lockRow('job:x'))[0]?.owner).toBe(loser);
    });

    it('a lock expires after ttlMs of real time (wide margin)', async () => {
      expect(await claimLock(h, 'job:x', 'owner-a', 50)).toBe(true);
      await new Promise((resolve) => setTimeout(resolve, 300));
      expect(await claimLock(h, 'job:x', 'owner-b', 60_000)).toBe(true);
    });

    it('farFutureIsExpired (S18): a lock held until a day ahead (a clock that ran ahead) can be claimed as if expired', async () => {
      await h.db.insertInto('locks').values({ name: 'jobs:heavy', owner: 'owner-a', until: Date.now() + 86_400_000 }).execute();
      expect(await claimLock(h, 'jobs:heavy', 'owner-b', 30_000)).toBe(false);
      expect(await claimLock(h, 'jobs:heavy', 'owner-b', 30_000, { farFutureIsExpired: false })).toBe(false);
      const before = Date.now();
      expect(await claimLock(h, 'jobs:heavy', 'owner-b', 30_000, { farFutureIsExpired: true })).toBe(true);
      const [row] = await lockRow('jobs:heavy');
      expect(row?.owner).toBe('owner-b');
      expect(row!.until).toBeGreaterThanOrEqual(before + 30_000);
      expect(row!.until).toBeLessThanOrEqual(Date.now() + 30_000);
    });

    it('farFutureIsExpired: a lock within now + 2 × ttlMs is still held; the holder renews it as before', async () => {
      await h.db.insertInto('locks').values({ name: 'jobs:heavy', owner: 'owner-a', until: Date.now() + 50_000 }).execute();
      expect(await claimLock(h, 'jobs:heavy', 'owner-b', 30_000, { farFutureIsExpired: true })).toBe(false);
      expect(await claimLock(h, 'jobs:heavy', 'owner-a', 30_000, { farFutureIsExpired: true })).toBe(true);
      expect((await lockRow('jobs:heavy'))[0]?.owner).toBe('owner-a');
    });

    it('10 claimants of an absent lock at once: exactly one gets it, nobody gets an error', async () => {
      const results = await Promise.all(Array.from({ length: 10 }, (_, i) => claimLock(writer(i), 'job:x', `owner-${i}`, 60_000)));
      expect(results.filter(Boolean)).toHaveLength(1);
      expect((await lockRow('job:x'))[0]?.owner).toBe(`owner-${results.indexOf(true)}`);
    });

    it('2 processes x 5 claimants: exactly one gets it', async () => {
      const run = await runChildren<{ results: boolean[] }>(
        fixture,
        ['p0', 'p1'].map((tag) => ({ ...childBase(), op: 'claim', count: 5, tag, name: 'job:x', ttlMs: 60_000 })),
      );
      expect(run.codes).toEqual([0, 0]);
      const results = run.reports.flatMap((r) => r?.results ?? []);
      expect(results).toHaveLength(10);
      expect(results.filter(Boolean)).toHaveLength(1);
    });

    it('a re-claim by the holder renews until (= now + ttlMs)', async () => {
      expect(await claimLock(h, 'job:x', 'owner-a', 1_000)).toBe(true);
      const [first] = await lockRow('job:x');
      expect(await claimLock(h, 'job:x', 'owner-a', 60_000)).toBe(true);
      const [second] = await lockRow('job:x');
      expect(second!.owner).toBe('owner-a');
      expect(second!.until).toBeGreaterThan(first!.until + 50_000);
    });

    it('overlapping re-claims by the holder all return true (item 9)', async () => {
      await claimLock(h, 'job:x', 'owner-a', 60_000);
      const results = await Promise.all(Array.from({ length: 4 }, (_, i) => claimLock(writer(i), 'job:x', 'owner-a', 60_000)));
      expect(results).toEqual([true, true, true, true]);
    });

    it.skipIf(!POSTGRES)(
      'PostgreSQL: a re-claim whose row was renewed by another re-claim after it read it still returns true (item 9)',
      async () => {
        // READ COMMITTED: the conditional claim locks no row that it does not match, so another session can renew the
        // lock between this claim's read and its guarded renewal, which then matches no row.
        await claimLock(h, 'job:x', 'owner-a', 60_000);
        const other = handles[1]!;
        let renewedBetween = false;
        const racing = {
          ...h,
          db: h.db.withPlugin(
            afterFirst(
              (n) => SelectQueryNode.is(n),
              async () => {
                await other.db.updateTable('locks').set({ until: Date.now() + 120_000 }).where('name', '=', 'job:x').execute();
                renewedBetween = true;
              },
            ),
          ),
        };
        expect(await claimLock(racing, 'job:x', 'owner-a', 60_000)).toBe(true);
        expect(renewedBetween).toBe(true);
      },
    );

    it('releaseLock deletes only when the owner matches; the lock is then free at once', async () => {
      await claimLock(h, 'job:x', 'owner-a', 60_000);
      await releaseLock(h, 'job:x', 'owner-b');
      expect(await lockRow('job:x')).toHaveLength(1);
      await releaseLock(h, 'job:x', 'owner-a');
      expect(await lockRow('job:x')).toEqual([]);
      expect(await claimLock(h, 'job:x', 'owner-b', 60_000)).toBe(true);
      await releaseLock(h, 'job:absent', 'owner-a'); // nothing to release: no error
    });

    it('owners are compared exactly on every engine (no case folding, no PAD SPACE)', async () => {
      // locks.owner is binary (key191(), R48): with a unicode_ci column MySQL/MariaDB would match 'OWNER-A' and 'owner-a'.
      await claimLock(h, 'job:x', 'Owner-A', 60_000);
      expect(await claimLock(h, 'job:x', 'owner-a', 60_000)).toBe(false);
      expect(await claimLock(h, 'job:x', 'OWNER-A', 60_000)).toBe(false);
      await releaseLock(h, 'job:x', 'owner-a');
      await releaseLock(h, 'job:x', 'OWNER-A');
      expect((await lockRow('job:x'))[0]?.owner).toBe('Owner-A');
    });

    it('lock names are compared exactly (binary key: case matters)', async () => {
      expect(await claimLock(h, 'job:x', 'owner-a', 60_000)).toBe(true);
      expect(await claimLock(h, 'JOB:X', 'owner-b', 60_000)).toBe(true);
      expect(await h.db.selectFrom('locks').select('name').orderBy('name').execute()).toHaveLength(2);
    });

    it.each([
      ['an empty name', '', 'o', 1000, /name/],
      ['a name over 191 characters', 'n'.repeat(192), 'o', 1000, /name/],
      ['a name ending in a blank', 'job ', 'o', 1000, /blank/],
      ['an empty owner', 'job', '', 1000, /owner/],
      ['an owner over 191 characters', 'job', 'o'.repeat(192), 1000, /owner/],
      ['an owner ending in a blank', 'job', 'o ', 1000, /blank/],
      ['a ttlMs of 0', 'job', 'o', 0, /ttlMs/],
      ['a fractional ttlMs', 'job', 'o', 1.5, /ttlMs/],
      ['a non-number ttlMs', 'job', 'o', '1000', /ttlMs/],
      ['a ttlMs so large that now + ttlMs is no safe integer', 'job', 'o', Number.MAX_SAFE_INTEGER, /ttlMs/],
    ])('claimLock: TypeError for %s', async (_name, name, owner, ttlMs, pattern) => {
      await expectTypeError(claimLock(h, name, owner, ttlMs as number), pattern);
      expect(await h.db.selectFrom('locks').selectAll().execute()).toEqual([]);
    });

    it('releaseLock: TypeError for an invalid name or owner', async () => {
      await expectTypeError(releaseLock(h, '', 'o'), /name/);
      await expectTypeError(releaseLock(h, 'job', ''), /owner/);
    });

    it('error messages never repeat the text of a refused value, only its type and length (item 12)', async () => {
      const error = await expectTypeError(claimLock(h, 'job', 'o', 'budi.santoso@example.com' as unknown as number), /ttlMs/);
      expect(error.message).not.toContain('budi');
      expect(error.message).toContain('a string of 24 characters');
      const objectError = await expectTypeError(
        withTx(h, (trx) => upsert(trx, 'settings', { key: 'k' }, {}, { value: ['budi.santoso@example.com'] })),
        /value/,
      );
      expect(objectError.message).not.toContain('budi');
    });
  });
});
