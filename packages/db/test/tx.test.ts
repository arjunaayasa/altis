import fsp from 'node:fs/promises';
import os from 'node:os';
import path from 'node:path';
import { isDomainError, type DomainError } from '@altis/shared';
import { sql, type Transaction } from 'kysely';
import { afterAll, beforeAll, beforeEach, describe, expect, it } from 'vitest';
import { engineLabel, testDb, testDbContext, type TestDbHandle } from '../../../tools/test/test-db.js';
import { runMigrations } from '../src/migrator.js';
import { PHASE1_MIGRATIONS } from '../src/migrations/index.js';
import type { DB } from '../src/schema.js';
import { withTx } from '../src/tx.js';

// withTx against real servers (ruling R37): a real deadlock between two transactions on two connections is
// normalized to TX_CONFLICT and the loser is run again; a conflict on every attempt ends in TX_CONFLICT after 5
// attempts on MySQL/MariaDB and 3 on PostgreSQL (ruling R37b). unit/tx-retry.test.ts covers the retry rules
// engine-independently. Rows of the `locks` table
// (migration 0001) are the playground.

const ctx = testDbContext();
const MYSQL_FAMILY = ['mysql80', 'mysql84', 'mariadb106', 'mariadb114'].includes(ctx.engine);
const MARIADB = ctx.engine === 'mariadb106' || ctx.engine === 'mariadb114';
const POSTGRES = ctx.engine === 'pg15' || ctx.engine === 'pg17';

/** A promise and the function that resolves it. */
function signal(): { promise: Promise<void>; fire: () => void } {
  let fire!: () => void;
  const promise = new Promise<void>((resolve) => {
    fire = resolve;
  });
  return { promise, fire };
}

/** Resolves for everyone once `parties` callers have arrived. */
function barrier(parties: number): () => Promise<void> {
  let arrived = 0;
  const all = signal();
  return async () => {
    arrived += 1;
    if (arrived === parties) all.fire();
    await all.promise;
  };
}

async function setOwner(trx: Transaction<DB>, name: string, owner: string): Promise<void> {
  await trx.updateTable('locks').set({ owner }).where('name', '=', name).execute();
}

describe.skipIf(!ctx.available)(`withTx: deadlocks and serialization failures (R37) [${engineLabel()}]`, () => {
  let h: TestDbHandle;
  let h2: TestDbHandle;
  let dataDir: string;

  beforeAll(async () => {
    h = await testDb();
    h2 = await testDb({ reset: false });
    dataDir = await fsp.mkdtemp(path.join(os.tmpdir(), 'altis-tx-'));
    await runMigrations(h, { appVersion: '0.1.0', dataDir, migrations: PHASE1_MIGRATIONS });
  });

  afterAll(async () => {
    await h2?.close();
    await h?.close();
    if (dataDir !== undefined) await fsp.rm(dataDir, { recursive: true, force: true });
  });

  beforeEach(async () => {
    await h.db.deleteFrom('locks').execute();
    const rows = ['a', 'b', ...Array.from({ length: 10 }, (_, i) => `pad${i}`)].map((name) => ({ name, owner: '-', until: 0 }));
    await h.db.insertInto('locks').values(rows).execute();
  });

  async function owners(): Promise<Record<string, string>> {
    const rows = await h.db.selectFrom('locks').select(['name', 'owner']).where('name', 'in', ['a', 'b']).execute();
    return Object.fromEntries(rows.map((r) => [r.name, r.owner]));
  }

  /**
   * Two transactions on two connections lock `a` and `b` in opposite orders; on their first attempt both wait at a
   * barrier holding their first row, so their second statements close a cycle the server must break.
   */
  function crossedPair(opts: { retry?: boolean } = {}) {
    const meet = barrier(2);
    const runs = { t1: 0, t2: 0 };
    const t1 = withTx(
      h,
      async (trx) => {
        runs.t1 += 1;
        await setOwner(trx, 'a', 't1');
        if (runs.t1 === 1) await meet();
        await setOwner(trx, 'b', 't1');
      },
      opts,
    );
    const t2 = withTx(
      h2,
      async (trx) => {
        runs.t2 += 1;
        await setOwner(trx, 'b', 't2');
        if (runs.t2 === 1) await meet();
        await setOwner(trx, 'a', 't2');
      },
      opts,
    );
    return { runs, settled: Promise.allSettled([t1, t2]) };
  }

  it.skipIf(!MYSQL_FAMILY && !POSTGRES)('a real deadlock: the loser is run again and both transactions commit', async () => {
    const { runs, settled } = crossedPair();
    const results = await settled;
    expect(results.map((r) => r.status)).toEqual(['fulfilled', 'fulfilled']);
    // Exactly one of them lost once and ran a second time; it committed last, so both rows are its own.
    expect(runs.t1 + runs.t2).toBe(3);
    const loser = runs.t1 === 2 ? 't1' : 't2';
    expect(await owners()).toEqual({ a: loser, b: loser });
  });

  it.skipIf(!MYSQL_FAMILY && !POSTGRES)(
    'with {retry: false} the loser gets TX_CONFLICT (attempts 1) carrying the engine code, and the winner commits',
    async () => {
      const { runs, settled } = crossedPair({ retry: false });
      const results = await settled;
      expect(runs).toEqual({ t1: 1, t2: 1 });
      const rejected = results.filter((r): r is PromiseRejectedResult => r.status === 'rejected');
      expect(rejected).toHaveLength(1);
      const error = rejected[0]!.reason as DomainError;
      expect(isDomainError(error)).toBe(true);
      expect(error).toMatchObject({
        code: 'TX_CONFLICT',
        status: 409,
        meta: { attempts: 1, code: MYSQL_FAMILY ? 'ER_LOCK_DEADLOCK' : '40P01' },
      });
      const winner = results[0]!.status === 'fulfilled' ? 't1' : 't2';
      expect(await owners()).toEqual({ a: winner, b: winner });
    },
  );

  it.skipIf(!POSTGRES)('PostgreSQL: a serialization failure on every attempt ends in TX_CONFLICT 40001 after 3 attempts', async () => {
    let runs = 0;
    const error = await withTx(h, async (trx) => {
      runs += 1;
      // REPEATABLE READ for this test only (withTx keeps the default): the snapshot is taken by the SELECT, then
      // another connection changes the row and commits, so updating it cannot be serialized.
      await sql`SET TRANSACTION ISOLATION LEVEL REPEATABLE READ`.execute(trx);
      await trx.selectFrom('locks').select('owner').where('name', '=', 'a').execute();
      await h2.db.updateTable('locks').set({ owner: `other${runs}` }).where('name', '=', 'a').execute();
      await setOwner(trx, 'a', 'me');
    }).catch((e: unknown) => e);
    expect(runs).toBe(3);
    expect(error).toMatchObject({ code: 'TX_CONFLICT', meta: { attempts: 3, code: '40001' } });
    expect((error as DomainError).cause).toEqual({ code: '40001' });
    expect(await owners()).toMatchObject({ a: 'other3' });
  });

  it.skipIf(!MYSQL_FAMILY)('MySQL/MariaDB: a deadlock on every attempt ends in TX_CONFLICT ER_LOCK_DEADLOCK after 5 attempts (R37b)', async () => {
    // Each attempt of the victim locks `a`; a helper transaction that has changed more rows (InnoDB rolls back the
    // lighter transaction) then holds `b` and waits for `a`, and the victim's request for `b` closes the cycle.
    let runs = 0;
    const helpers: Promise<unknown>[] = [];
    const error = await withTx(h, async (trx) => {
      runs += 1;
      await setOwner(trx, 'a', 'victim');
      const holdsB = signal();
      const attempt = runs;
      helpers.push(
        h2.db.transaction().execute(async (t) => {
          await t.updateTable('locks').set({ owner: `helper${attempt}` }).where('name', 'like', 'pad%').execute();
          await setOwner(t, 'b', `helper${attempt}`);
          holdsB.fire();
          await setOwner(t, 'a', `helper${attempt}`);
        }),
      );
      await holdsB.promise;
      await setOwner(trx, 'b', 'victim');
    }).catch((e: unknown) => e);
    const helperResults = await Promise.allSettled(helpers);
    expect(helperResults.map((r) => r.status)).toEqual(Array(5).fill('fulfilled'));
    expect(runs).toBe(5);
    expect(error).toMatchObject({ code: 'TX_CONFLICT', meta: { attempts: 5, code: 'ER_LOCK_DEADLOCK' } });
    expect((error as DomainError).cause).toEqual({ code: 'ER_LOCK_DEADLOCK', errno: 1213, sqlState: '40001' });
    expect(await owners()).toEqual({ a: 'helper5', b: 'helper5' });
  });

  it.skipIf(ctx.engine !== 'sqlite')('SQLite: writers are serialized (BEGIN IMMEDIATE), so opposite lock orders never deadlock', async () => {
    const runs = { t1: 0, t2: 0 };
    await Promise.all([
      withTx(h, async (trx) => {
        runs.t1 += 1;
        await setOwner(trx, 'a', 't1');
        await setOwner(trx, 'b', 't1');
      }),
      withTx(h, async (trx) => {
        runs.t2 += 1;
        await setOwner(trx, 'b', 't2');
        await setOwner(trx, 'a', 't2');
      }),
    ]);
    expect(runs).toEqual({ t1: 1, t2: 1 });
    expect(await owners()).toEqual({ a: 't2', b: 't2' });
  });

  it('a withTx nested on the same handle is refused at once with a TypeError, no hang (R49); the outer rolls back', async () => {
    const error = await withTx(h, async (trx) => {
      await setOwner(trx, 'a', 'outer');
      return withTx(h, async (inner) => setOwner(inner, 'b', 'inner'));
    }).catch((e: unknown) => e);
    expect(error).toBeInstanceOf(TypeError);
    expect((error as TypeError).message).toMatch(/pass the outer trx down/);
    expect(await owners()).toEqual({ a: '-', b: '-' });
  });

  it.skipIf(!MYSQL_FAMILY && !POSTGRES)('a withTx nested on another handle runs as a transaction of its own', async () => {
    await withTx(h, async (trx) => {
      await setOwner(trx, 'a', 'outer');
      await withTx(h2, async (inner) => setOwner(inner, 'b', 'inner'));
    });
    expect(await owners()).toEqual({ a: 'outer', b: 'inner' });
  });

  it.skipIf(!MYSQL_FAMILY && !POSTGRES)(
    'a callback that catches its deadlock and carries on commits nothing of that attempt; it is run again (item 8)',
    async () => {
      // MySQL/MariaDB rolled the loser back at the deadlock (its later statements would autocommit on their own);
      // PostgreSQL aborted it (its COMMIT would quietly roll back and withTx would return as if it had worked).
      const meet = barrier(2);
      const runs = { t1: 0, t2: 0 };
      let swallowed = 0;
      const run = (handle: TestDbHandle, name: 't1' | 't2', first: string, second: string, pad: number) =>
        withTx(handle, async (trx) => {
          runs[name] += 1;
          const attempt = runs[name];
          await setOwner(trx, first, name);
          if (attempt === 1) await meet();
          try {
            await setOwner(trx, second, name);
          } catch {
            swallowed += 1;
          }
          // A write after the swallowed conflict, one marker row per attempt; its failure is swallowed as well.
          await setOwner(trx, `pad${pad + attempt}`, `${name}#${attempt}`).catch(() => {});
        });
      await Promise.all([run(h, 't1', 'a', 'b', 0), run(h2, 't2', 'b', 'a', 5)]);
      expect(swallowed).toBe(1);
      expect(runs.t1 + runs.t2).toBe(3);
      const markers = await h.db.selectFrom('locks').select('owner').where('name', 'like', 'pad%').where('owner', '!=', '-').execute();
      expect(markers.map((r) => r.owner).sort()).toEqual([`t1#${runs.t1}`, `t2#${runs.t2}`].sort());
      const loser = runs.t1 === 2 ? 't1' : 't2';
      expect(await owners()).toEqual({ a: loser, b: loser });
    },
  );

  it.skipIf(!MARIADB)('MariaDB with innodb_snapshot_isolation=ON: ER_CHECKREAD is retried like a deadlock (R37c)', async () => {
    // The default from MariaDB 11.6: a locking read (UPDATE) of a row changed since this transaction's read view fails
    // with 1020 and the transaction is rolled back. Set per session on a handle of its own, closed afterwards.
    const victim = await testDb({ reset: false });
    try {
      let runs = 0;
      await withTx(victim, async (trx) => {
        runs += 1;
        await sql`SET SESSION innodb_snapshot_isolation = ON`.execute(trx);
        await trx.selectFrom('locks').select('owner').where('name', '=', 'a').execute(); // the read view
        if (runs === 1) await h.db.updateTable('locks').set({ owner: 'other' }).where('name', '=', 'a').execute();
        await setOwner(trx, 'a', `victim${runs}`);
      });
      expect(runs).toBe(2);
      expect(await owners()).toMatchObject({ a: 'victim2' });

      const error = await withTx(
        victim,
        async (trx) => {
          await sql`SET SESSION innodb_snapshot_isolation = ON`.execute(trx);
          await trx.selectFrom('locks').select('owner').where('name', '=', 'b').execute();
          await h.db.updateTable('locks').set({ owner: 'other' }).where('name', '=', 'b').execute();
          await setOwner(trx, 'b', 'victim');
        },
        { retry: false },
      ).catch((e: unknown) => e);
      expect(error).toMatchObject({ code: 'TX_CONFLICT', meta: { attempts: 1, code: 'ER_CHECKREAD' } });
    } finally {
      await victim.close();
    }
  });
});
