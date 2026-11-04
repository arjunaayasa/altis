import fsp from 'node:fs/promises';
import os from 'node:os';
import path from 'node:path';
import { sql, type KyselyPlugin, type RawNode } from 'kysely';
import { afterAll, beforeAll, beforeEach, describe, expect, it } from 'vitest';
import { ENGINE_SPECS, engineLabel, testDb, testDbContext, type TestDbHandle } from '../../../tools/test/test-db.js';
import { readPkBatch, readSnapshot, type PkValue } from '../src/batches.js';
import { TABLE_COLUMNS, TABLE_KEYS } from '../src/columns.js';
import { connect } from '../src/connect.js';
import { PHASE1_MIGRATIONS } from '../src/migrations/index.js';
import { runMigrations } from '../src/migrator.js';
import type { TableName } from '../src/registry.js';
import { withTx } from '../src/tx.js';

// Keyset batches in primary-key byte order (L31: no Kysely .stream()) and the snapshot reader (P17, M32), on the
// engine picked by ALTIS_TEST_DB (default sqlite).

const ctx = testDbContext();
const SQLITE = ctx.engine === 'sqlite';
const POSTGRES = ENGINE_SPECS[ctx.engine].dialect === 'postgres';
const MYSQL_FAMILY = ['mysql', 'mariadb'].includes(ENGINE_SPECS[ctx.engine].dialect);

/** Sends readPkBatch's own statement (one raw SQL node, its values bound as they are) as `EXPLAIN <statement>`. */
const EXPLAIN: KyselyPlugin = {
  transformQuery: ({ node }) => {
    if (node.kind !== 'RawNode') throw new Error(`expected readPkBatch's raw statement, got a ${node.kind}`);
    const raw: RawNode = node;
    return { ...raw, sqlFragments: [`explain ${raw.sqlFragments[0] ?? ''}`, ...raw.sqlFragments.slice(1)] };
  },
  transformResult: async ({ result }) => result,
};

/**
 * A key past every row of each kind of primary key (text, composite text, text + integer, three columns): the
 * batches a whole-table read takes after its first one.
 */
const AFTER: ReadonlyArray<[TableName, PkValue[]]> = [
  ['branches', ['A'.repeat(26)]],
  ['audit_log', ['A'.repeat(26)]],
  ['settings', ['k']],
  ['role_permissions', ['R'.repeat(26), 'p']],
  ['rate_limits', ['b'.repeat(64), 5]],
  ['idempotency_keys', ['user', 'U'.repeat(26), 'k']],
];

/** Code-point order, as the database's byte order must give it (UTF-8 bytes sort like code points). */
const byCodePoints = (a: string, b: string) => (a < b ? -1 : a > b ? 1 : 0);

function branch(id: string, code: string) {
  return { id, code_key: code, code_display: code, name: code, address: null, timezone: 'Asia/Jakarta', created_at: 1, updated_at: 1 };
}

describe.skipIf(!ctx.available)(`keyset batches and snapshots [${engineLabel()}]`, () => {
  let h: TestDbHandle;
  let dataDir: string;

  beforeAll(async () => {
    h = await testDb();
    dataDir = await fsp.mkdtemp(path.join(os.tmpdir(), 'altis-batches-'));
    await runMigrations(h, { appVersion: '0.1.0', dataDir, migrations: PHASE1_MIGRATIONS });
  });

  afterAll(async () => {
    await h?.close();
    if (dataDir !== undefined) await fsp.rm(dataDir, { recursive: true, force: true });
  });

  beforeEach(async () => {
    await h.db.deleteFrom('role_permissions').execute();
    await h.db.deleteFrom('roles').execute();
    await h.db.deleteFrom('branches').execute();
    await h.db.deleteFrom('events').execute();
    await h.db.deleteFrom('rate_limits').execute();
  });

  /** Every row of `table`, read in batches of `limit`, and the number of batches it took. */
  async function readAll(table: TableName, limit: number, columns?: readonly string[]) {
    const rows: Record<string, unknown>[] = [];
    let after: PkValue[] | null = null;
    let batches = 0;
    for (;;) {
      const batch = await readPkBatch(h.db, h.dialect, table, { after, limit, ...(columns === undefined ? {} : { columns }) });
      batches += 1;
      expect(batch.length).toBeLessThanOrEqual(limit);
      rows.push(...batch);
      const last = batch.at(-1);
      if (batch.length < limit || last === undefined) break;
      after = TABLE_KEYS[table].pk.map((c) => last[c] as PkValue);
    }
    return { rows, batches };
  }

  describe('readPkBatch', () => {
    // Byte order differs from a linguistic collation (en_US: case-insensitive first, punctuation ignored): '0' < 'A' <
    // 'B' < 'Z' < '_' < 'a' by code points. 26 characters each, as id() needs.
    const IDS = ['a', 'B', '0', 'Z', '_', 'A'].map((c) => c.repeat(26));

    it('reads every row once, in code-point order of the key, in batches of 2 (whatever the database collation)', async () => {
      // Out of order on purpose.
      for (const [i, id] of IDS.entries()) await h.db.insertInto('branches').values(branch(id, `C${i}`)).execute();
      if (h.dialect === 'postgres') {
        const { rows } = await sql<{ coll: string }>`SELECT datcollate AS coll FROM pg_database WHERE datname = current_database()`.execute(h.db);
        // Informative: the ordering below must hold for en_US.UTF-8 as for C.
        expect(typeof rows[0]?.coll).toBe('string');
      }
      const { rows, batches } = await readAll('branches', 2);
      expect(rows.map((r) => r['id'])).toEqual([...IDS].sort(byCodePoints));
      expect(batches).toBe(4); // 2 + 2 + 2 + an empty one
      // Every column of the registry, in registry order.
      expect(Object.keys(rows[0]!)).toEqual(TABLE_COLUMNS.branches.map((c) => c.name));
    });

    it('reads only the columns asked for (the key columns among them)', async () => {
      for (const [i, id] of IDS.entries()) await h.db.insertInto('branches').values(branch(id, `C${i}`)).execute();
      const { rows } = await readAll('branches', 4, ['id', 'code_key']);
      expect(rows).toEqual([...IDS].sort(byCodePoints).map((id) => ({ id, code_key: `C${IDS.indexOf(id)}` })));
    });

    it('reads a composite key (role_permissions) in batches of 3: every row once, ordered by (role_id, permission)', async () => {
      const roles = ['r', 'R'].map((c) => c.repeat(26));
      for (const id of roles) {
        await h.db
          .insertInto('roles')
          .values({ id, key: `k-${id.slice(0, 1)}`, name: 'x', description: null, created_at: 1, updated_at: 1 })
          .execute();
      }
      const pairs: Array<[string, string]> = [
        [roles[0]!, 'b.x'],
        [roles[1]!, 'a'],
        [roles[0]!, 'a.y'],
        [roles[1]!, 'c'],
        [roles[0]!, 'B.z'],
        [roles[1]!, 'b'],
        [roles[1]!, 'A'],
      ];
      for (const [role_id, permission] of pairs) await h.db.insertInto('role_permissions').values({ role_id, permission }).execute();
      const { rows, batches } = await readAll('role_permissions', 3);
      const expected = [...pairs]
        .sort((x, y) => byCodePoints(x[0], y[0]) || byCodePoints(x[1], y[1]))
        .map(([role_id, permission]) => ({ role_id, permission }));
      expect(rows).toEqual(expected);
      expect(batches).toBe(3);
    });

    it('reads integer keys numerically (events.seq) and mixed composite keys (rate_limits: bucket, window_start)', async () => {
      for (let i = 0; i < 12; i += 1) {
        await h.db.insertInto('events').values({ channel: 'system.status', type: 't', payload: '{}', created_at: i }).execute();
      }
      const events = await readAll('events', 5, ['seq', 'created_at']);
      expect(events.rows.map((r) => r['created_at'])).toEqual(Array.from({ length: 12 }, (_, i) => i));
      const seqs = events.rows.map((r) => r['seq'] as number);
      expect(seqs).toEqual([...seqs].sort((a, b) => a - b));

      const buckets = ['b', 'a', 'B'].map((c) => c.repeat(64));
      const windows = [9, 100, 10]; // 9 < 10 < 100 numerically, not as text
      for (const bucket of buckets) {
        for (const window_start of windows) {
          await h.db.insertInto('rate_limits').values({ bucket, window_start, bucket_name: 'x', count: 1 }).execute();
        }
      }
      const limits = await readAll('rate_limits', 2, ['bucket', 'window_start']);
      expect(limits.rows).toEqual(
        [...buckets].sort(byCodePoints).flatMap((bucket) => [9, 10, 100].map((window_start) => ({ bucket, window_start }))),
      );
    });

    it('works on a transaction too', async () => {
      await h.db.insertInto('branches').values(branch(IDS[0]!, 'C0')).execute();
      const rows = await withTx(h, (trx) => readPkBatch(trx, h.dialect, 'branches', { after: null, limit: 10, columns: ['id'] }));
      expect(rows).toEqual([{ id: IDS[0] }]);
    });

    // A batch that cannot use the primary key index scans and sorts every row after the cursor: reading a table
    // whole then grows with the square of its rows (final review, P20).
    it.runIf(POSTGRES)('PostgreSQL: every batch is a range scan of the primary key index, never a sort', async () => {
      const plan = (table: TableName, after: PkValue[] | null) =>
        h.db.transaction().execute(async (trx) => {
          // The tables are (nearly) empty, so the planner could prefer anything to an index scan: without a
          // sequential or bitmap scan or a sort to fall back on, the plan shows whether the index can serve the
          // batch at all (a plan that cannot do without one still shows it, at a prohibitive cost).
          await sql`set local enable_seqscan = off`.execute(trx);
          await sql`set local enable_bitmapscan = off`.execute(trx);
          await sql`set local enable_sort = off`.execute(trx);
          const rows = await readPkBatch(trx.withPlugin(EXPLAIN), h.dialect, table, { after, limit: 1000 });
          return rows.map((r) => String(r['QUERY PLAN'])).join('\n');
        });
      for (const [table, after] of [...AFTER, ['branches', null] as [TableName, null]]) {
        const p = await plan(table, after);
        expect({ table, after, indexScan: new RegExp(`Index (Only )?Scan using pk_${table} `).test(p), p }).toEqual({
          table,
          after,
          indexScan: true,
          p,
        });
        expect({ table, after, sort: /\bSort\b/.test(p), p }).toEqual({ table, after, sort: false, p });
        if (after !== null) expect({ table, after, indexCond: p.includes('Index Cond'), p }).toEqual({ table, after, indexCond: true, p });
      }
    });

    it.runIf(MYSQL_FAMILY)('MySQL/MariaDB: every batch after a key is a range on PRIMARY, never a filesort', async () => {
      for (const [table, after] of AFTER) {
        const rows = await readPkBatch(h.db.withPlugin(EXPLAIN), h.dialect, table, { after, limit: 1000 });
        const plan = rows.map((r) => ({ possible_keys: r['possible_keys'], key: r['key'], Extra: r['Extra'] }));
        // possible_keys lists PRIMARY only when the comparison is sargable: a row value `(a, b) > (?, ?)` is not on
        // MySQL/MariaDB (a full index scan that filters every row before the cursor, whatever the table holds). On
        // these near-empty tables the optimizer may still pick a full scan of a covering index over the range.
        expect({ table, plan }).toEqual({
          table,
          plan: [
            {
              possible_keys: expect.stringMatching(/(^|,)PRIMARY(,|$)/) as unknown,
              key: 'PRIMARY',
              Extra: expect.not.stringMatching(/filesort/) as unknown,
            },
          ],
        });
      }
    });

    it.each([
      ['a table outside the registry', { table: 'nope' }],
      ['a limit of 0', { limit: 0 }],
      ['a fractional limit', { limit: 1.5 }],
      ['a limit above 100 000', { limit: 100_001 }],
      ['an unknown column', { columns: ['id', 'nope'] }],
      ['a column given twice', { columns: ['id', 'id'] }],
      ['columns without the key', { columns: ['code_key'] }],
      ['an `after` with the wrong number of values', { after: ['x', 'y'] }],
      ['an `after` number for a text key', { after: [1] }],
      ['an `after` string for an integer key', { table: 'events', after: ['1'] }],
      ['an unsafe integer in `after`', { table: 'events', after: [2 ** 53] }],
      ['an unknown dialect', { dialect: 'oracle' }],
    ])('refuses %s with a TypeError', async (_name, o: Record<string, unknown>) => {
      const call = readPkBatch(
        h.db,
        (o['dialect'] ?? h.dialect) as typeof h.dialect,
        (o['table'] ?? 'branches') as TableName,
        {
          after: (o['after'] ?? null) as PkValue[] | null,
          limit: (o['limit'] ?? 10) as number,
          ...(o['columns'] === undefined ? {} : { columns: o['columns'] as string[] }),
        },
      );
      await expect(call).rejects.toThrow(TypeError);
    });
  });

  describe('readSnapshot', () => {
    it.runIf(SQLITE)('SQLite: TypeError (a SQLite snapshot copies the file: sqliteSnapshotTo)', async () => {
      await expect(readSnapshot(h, async () => 1)).rejects.toThrow(TypeError);
    });

    it.skipIf(SQLITE)('a row another handle inserts after the first read is not seen inside the snapshot', async () => {
      await h.db.insertInto('branches').values(branch('A'.repeat(26), 'A')).execute();
      // A dedicated pool-1 handle (P17), as backup and restore use; its session defaults to READ COMMITTED here,
      // which a host may set globally: the snapshot must not depend on the default (M32).
      const reader = await connect(h.config, { runtime: 'standalone', purpose: 'cli', dataDir: h.dataDir });
      try {
        expect(reader.poolSize).toBe(1);
        if (h.dialect === 'mysql' || h.dialect === 'mariadb') {
          await sql`SET SESSION TRANSACTION ISOLATION LEVEL READ COMMITTED`.execute(reader.db);
        } else {
          await sql`SET SESSION CHARACTERISTICS AS TRANSACTION ISOLATION LEVEL READ COMMITTED`.execute(reader.db);
        }
        // Control: an ordinary transaction under READ COMMITTED does see the other handle's row.
        const plain = await reader.db.transaction().execute(async (trx) => {
          const first = await trx.selectFrom('branches').select('id').execute();
          await h.db.insertInto('branches').values(branch('B'.repeat(26), 'B')).execute();
          const second = await trx.selectFrom('branches').select('id').execute();
          return [first.length, second.length];
        });
        expect(plain).toEqual([1, 2]);

        const seen = await readSnapshot(reader, async (db) => {
          const first = await db.selectFrom('branches').select('id').execute();
          await h.db.insertInto('branches').values(branch('C'.repeat(26), 'C')).execute();
          const second = await db.selectFrom('branches').select('id').execute();
          const batch = await readPkBatch(db, reader.dialect, 'branches', { after: null, limit: 10, columns: ['id'] });
          return [first.length, second.length, batch.length];
        });
        expect(seen).toEqual([2, 2, 2]);
        // After the snapshot the handle reads the current data again.
        expect(await reader.db.selectFrom('branches').select('id').execute()).toHaveLength(3);
      } finally {
        await reader.close();
      }
    });

    it.skipIf(SQLITE)('is read-only, and an error in the callback rolls back and comes out as it is', async () => {
      const reader = await connect(h.config, { runtime: 'standalone', purpose: 'cli', dataDir: h.dataDir });
      try {
        await expect(
          readSnapshot(reader, async (db) => {
            await db.insertInto('branches').values(branch('D'.repeat(26), 'D')).execute();
          }),
        ).rejects.toThrow();
        const boom = new Error('boom');
        await expect(
          readSnapshot(reader, async () => {
            throw boom;
          }),
        ).rejects.toBe(boom);
        // The connection is usable afterwards, outside any transaction.
        expect(await readSnapshot(reader, async (db) => (await db.selectFrom('branches').select('id').execute()).length)).toBe(0);
        await reader.db.insertInto('branches').values(branch('E'.repeat(26), 'E')).execute();
        expect(await h.db.selectFrom('branches').select('id').execute()).toEqual([{ id: 'E'.repeat(26) }]);
      } finally {
        await reader.close();
      }
    });

    it('refuses to run inside a withTx callback (it holds its own connection)', async () => {
      await expect(withTx(h, () => readSnapshot(h, async () => 1))).rejects.toThrow(TypeError);
    });
  });
});
