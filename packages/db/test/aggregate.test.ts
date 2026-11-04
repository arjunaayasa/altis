import fsp from 'node:fs/promises';
import os from 'node:os';
import path from 'node:path';
import type { KyselyPlugin } from 'kysely';
import { afterAll, beforeAll, beforeEach, describe, expect, it } from 'vitest';
import { engineLabel, testDb, testDbContext, type TestDbHandle } from '../../../tools/test/test-db.js';
import { countRows } from '../src/aggregate.js';
import { runMigrations } from '../src/migrator.js';
import { PHASE1_MIGRATIONS } from '../src/migrations/index.js';
import { withTx } from '../src/tx.js';

// countRows (ruling L19): the one way every 1b count is made. count(*) is a BIGINT that the drivers hand back as a
// number, a string or a bigint depending on the engine and the size; countRows gives a JS number or a TypeError.
// On the real Phase 1 tables, on the engine picked by ALTIS_TEST_DB.

const ctx = testDbContext();

/** A plugin that replaces the value of the first column of the first row, whatever the driver returned. */
function driverReturns(value: unknown): KyselyPlugin {
  return {
    transformQuery: ({ node }) => node,
    async transformResult({ result }) {
      const [row] = result.rows;
      const [column] = row === undefined ? [] : Object.keys(row);
      if (row === undefined || column === undefined) return result;
      return { ...result, rows: [{ ...row, [column]: value }] };
    },
  };
}

/** A plugin that makes the query return no row at all. */
const returnsNoRow: KyselyPlugin = {
  transformQuery: ({ node }) => node,
  transformResult: async ({ result }) => ({ ...result, rows: [] }),
};

describe.skipIf(!ctx.available)(`countRows (L19) [${engineLabel()}]`, () => {
  let h: TestDbHandle;
  let dataDir: string;

  beforeAll(async () => {
    h = await testDb();
    dataDir = await fsp.mkdtemp(path.join(os.tmpdir(), 'altis-aggregate-'));
    await runMigrations(h, { appVersion: '0.1.0', dataDir, migrations: PHASE1_MIGRATIONS });
  });

  afterAll(async () => {
    await h?.close();
    if (dataDir !== undefined) await fsp.rm(dataDir, { recursive: true, force: true });
  });

  beforeEach(async () => {
    await h.db.deleteFrom('locks').execute();
  });

  const insertLocks = () =>
    h.db
      .insertInto('locks')
      .values([
        { name: 'a', owner: 'x', until: 1 },
        { name: 'b', owner: 'x', until: 2 },
        { name: 'c', owner: 'y', until: 3 },
      ])
      .execute();

  it('counts 3 inserted rows as the number 3', async () => {
    await insertLocks();
    const n = await countRows(h.db.selectFrom('locks'));
    expect(n).toBe(3);
    expect(typeof n).toBe('number');
  });

  it('counts an empty table as the number 0', async () => {
    const n = await countRows(h.db.selectFrom('locks'));
    expect(n).toBe(0);
    expect(typeof n).toBe('number');
  });

  it('counts the rows a where leaves', async () => {
    await insertLocks();
    expect(await countRows(h.db.selectFrom('locks').where('owner', '=', 'x'))).toBe(2);
    expect(await countRows(h.db.selectFrom('locks').where('owner', '=', 'y').where('until', '>', 1))).toBe(1);
    expect(await countRows(h.db.selectFrom('locks').where('owner', '=', 'nobody'))).toBe(0);
  });

  it('replaces whatever the query selects, orders, limits or skips (a page query counts its total)', async () => {
    await insertLocks();
    const page = h.db.selectFrom('locks').select(['name', 'owner']).orderBy('until', 'desc').limit(1).offset(1);
    expect(await countRows(page)).toBe(3);
    expect(await countRows(h.db.selectFrom('locks').select('name').where('owner', '=', 'x').orderBy('name'))).toBe(2);
  });

  it('counts through a join and an alias', async () => {
    await insertLocks();
    // x pairs with x (2 x 2) and y with y (1 x 1).
    const joined = h.db.selectFrom('locks as l1').innerJoin('locks as l2', 'l2.owner', 'l1.owner').select('l1.name');
    expect(await countRows(joined)).toBe(5);
  });

  it("counts inside a transaction, seeing the transaction's own rows", async () => {
    await insertLocks();
    const inside = await withTx(h, async (trx) => {
      await trx.insertInto('locks').values({ name: 'd', owner: 'y', until: 4 }).execute();
      return countRows(trx.selectFrom('locks').where('owner', '=', 'y'));
    });
    expect(inside).toBe(2);
  });

  describe('normalizes what the driver returns', () => {
    const count = (value: unknown) => countRows(h.db.withPlugin(driverReturns(value)).selectFrom('locks'));

    it.each([
      ['a number', 3, 3],
      ['zero as a number', 0, 0],
      ['a string (PostgreSQL numeric, MySQL beyond 2^53)', '3', 3],
      ['zero as a string', '0', 0],
      ['a bigint', 3n, 3],
      ['zero as a bigint', 0n, 0],
      ['the largest safe integer as a number', Number.MAX_SAFE_INTEGER, Number.MAX_SAFE_INTEGER],
      ['the largest safe integer as a string', String(Number.MAX_SAFE_INTEGER), Number.MAX_SAFE_INTEGER],
      ['the largest safe integer as a bigint', BigInt(Number.MAX_SAFE_INTEGER), Number.MAX_SAFE_INTEGER],
    ])('accepts %s', async (_name, value, expected) => {
      const n = await count(value);
      expect(n).toBe(expected);
      expect(typeof n).toBe('number');
    });

    it.each([
      ['a number beyond the safe range', 2 ** 53],
      ['a string beyond the safe range', '9007199254740993'],
      ['a bigint beyond the safe range', 9007199254740993n],
      ['a bigint far beyond the safe range', 2n ** 80n],
      ['a fraction', 1.5],
      ['a fraction as a string', '3.5'],
      ['a negative number', -1],
      ['a negative bigint', -1n],
      ['a negative string', '-1'],
      ['NaN', Number.NaN],
      ['Infinity', Number.POSITIVE_INFINITY],
      ['an empty string', ''],
      ['text', 'three'],
      ['a number with a sign or leading zeros as a string', '+3'],
      ['hexadecimal text', '0x10'],
      ['exponent text', '1e3'],
      ['a blank-padded string', ' 3'],
      ['null', null],
      ['a boolean', true],
      ['an object', { n: 3 }],
    ])('refuses %s with a TypeError', async (_name, value) => {
      const error = await count(value).catch((e: unknown) => e);
      expect(error).toBeInstanceOf(TypeError);
      expect((error as TypeError).message).toMatch(/countRows/);
    });

    it('refuses a result without a row with a TypeError', async () => {
      const error = await countRows(h.db.withPlugin(returnsNoRow).selectFrom('locks')).catch((e: unknown) => e);
      expect(error).toBeInstanceOf(TypeError);
      expect((error as TypeError).message).toMatch(/countRows.*no row/);
    });
  });

  describe('refuses queries whose count(*) would not be the number of rows (a TypeError)', () => {
    it.each([
      ['a group by', () => h.db.selectFrom('locks').select('owner').groupBy('owner')],
      ['a having', () => h.db.selectFrom('locks').select('owner').groupBy('owner').having('owner', '=', 'x')],
      ['a distinct', () => h.db.selectFrom('locks').select('owner').distinct()],
      [
        'a union',
        () => h.db.selectFrom('locks').select('name').union(h.db.selectFrom('locks').select('owner as name')),
      ],
    ])('%s', async (_name, query) => {
      await insertLocks();
      const error = await countRows(query()).catch((e: unknown) => e);
      expect(error).toBeInstanceOf(TypeError);
      expect((error as TypeError).message).toMatch(/countRows/);
    });
  });
});
