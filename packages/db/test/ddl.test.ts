import { isDomainError, newId } from '@altis/shared';
import { sql, type Generated, type Kysely, type KyselyPlugin } from 'kysely';
import { afterAll, beforeAll, beforeEach, describe, expect, it } from 'vitest';
import {
  ENGINE_SPECS,
  emptyDatabase,
  engineLabel,
  testDb,
  testDbContext,
  type TestDbHandle,
} from '../../../tools/test/test-db.js';
import type { Dialect } from '../src/connect.js';
import {
  TABLE_CLASS_NAMES,
  dropRegisteredTables,
  ensureBootstrap,
  ensureByteOrder,
  ensureColumn,
  ensureIndex,
  ensureTable,
  type TableBuilder,
  type TableClass,
} from '../src/ddl.js';

// Portable DDL (spec §6.2) on the engine picked by ALTIS_TEST_DB (default sqlite); see tools/test/test-db.ts.

// Type aliases, not interfaces: withTables() needs an index signature.
type RegistryRow = { name: string; class: string; created_by: string };
type Tables = {
  schema_tables: RegistryRow;
  schema_meta: { id: number; schema_version: string; min_code_version: string; install_id: string | null };
  t_demo: { id: string; code_key: string; name: string; note: string | null };
  t_serial: { seq: Generated<number>; label: string };
  t_types: {
    id: string;
    ref: string | null;
    flag: Generated<number>;
    amount: number;
    at: number;
    day: string;
    doc: string;
    body: string;
    code: string;
    small: number;
    count: Generated<number>;
    big: number;
    n: Generated<number>;
    s: string | null;
    k: Generated<string>;
  };
  t_pair: { a: string; b: number; v: number };
  t_parent: { id: string };
  t_owned: { id: string; parent_id: string };
  t_guarded: { id: string; parent_id: string };
  t_fk_a: { id: string; b_id: string };
  t_fk_b: { id: string };
  t_fk_c: { id: string; a_id: string };
  t_tree: { id: string; parent_id: string | null };
  t_leaf: { id: string; tree_id: string };
  t_key: { id: string; k: string };
  t_grow: { id: string; name: string; flag: Generated<number>; tag: string | null; key: Generated<string> };
  t_order: { id: string; k: string; code: string; day: string; name: string };
};

const ctx = testDbContext();
const EPOCH_MS = 1767225600000; // 2026-01-01T00:00:00Z, above 2^32

/** The error `promise` rejects with (fails the test when it resolves). */
async function rejection(promise: Promise<unknown>): Promise<unknown> {
  try {
    await promise;
  } catch (error) {
    return error;
  }
  throw new Error('expected a rejection');
}

/** One column of every helper (except id/serial alternatives). */
const allTypes = (t: TableBuilder) => {
  t.id();
  t.ulid('ref').nullable();
  t.bool('flag').default(0);
  t.money('amount');
  t.timestamp('at');
  t.date('day');
  t.json('doc');
  t.text('body');
  t.char('code', 3).default('IDR');
  t.smallint('small');
  t.int('count').default(5);
  t.bigint('big');
  t.int('n').nullable().notNull().default(7); // the last nullability modifier wins
  t.varchar('s', 191).nullable().default(null);
  t.key191('k').default('K');
};

const demo = (t: TableBuilder) => {
  t.id();
  t.key191('code_key');
  t.varchar('name', 100);
  t.text('note').nullable();
};

describe.skipIf(!ctx.available)(`portable DDL [${engineLabel()}]`, () => {
  let h: TestDbHandle;
  let db: Kysely<Tables>;
  const mysqlFamily = () => h.dialect === 'mysql' || h.dialect === 'mariadb';

  /** The rows of schema_tables, by name. */
  const registry = () =>
    db.selectFrom('schema_tables').select(['name', 'class', 'created_by']).orderBy('name').execute();

  /** Table names through Kysely's introspection (a different path than the helpers' own existence checks). */
  const tableNames = async () => (await h.db.introspection.getTables()).map((t) => t.name).sort();

  /** Every index of `table` by name, as the catalog lists it (one entry per index, not per column). */
  async function indexNames(table: string): Promise<string[]> {
    let q;
    if (mysqlFamily()) {
      q = sql<{ name: string }>`SELECT DISTINCT INDEX_NAME AS name FROM information_schema.STATISTICS
        WHERE TABLE_SCHEMA = DATABASE() AND TABLE_NAME = ${table}`;
    } else if (h.dialect === 'postgres') {
      q = sql<{ name: string }>`SELECT indexname AS name FROM pg_indexes
        WHERE schemaname = current_schema() AND tablename = ${table}`;
    } else {
      q = sql<{ name: string }>`SELECT name FROM pragma_index_list(${table})`;
    }
    return (await q.execute(h.db)).rows.map((r) => r.name).sort();
  }

  /**
   * The columns of `table` as the catalog describes them, in a dialect-neutral spelling: `char(n)`, `varchar(n)`,
   * `smallint`, `integer`, `bigint`, `text`; `auto` for an auto-increment/identity column.
   */
  async function catalogColumns(table: string): Promise<Array<{ name: string; type: string; notNull: boolean; auto: boolean }>> {
    if (mysqlFamily()) {
      const { rows } = await sql<{ name: string; dt: string; len: number | null; nullable: string; extra: string }>`
        SELECT COLUMN_NAME AS name, DATA_TYPE AS dt, CHARACTER_MAXIMUM_LENGTH AS len, IS_NULLABLE AS nullable, EXTRA AS extra
        FROM information_schema.COLUMNS WHERE TABLE_SCHEMA = DATABASE() AND TABLE_NAME = ${table}
        ORDER BY ORDINAL_POSITION`.execute(h.db);
      return rows.map((r) => ({
        name: r.name,
        type: r.dt === 'char' || r.dt === 'varchar' ? `${r.dt}(${r.len})` : r.dt === 'int' ? 'integer' : r.dt,
        notNull: r.nullable === 'NO',
        auto: /auto_increment/i.test(r.extra),
      }));
    }
    if (h.dialect === 'postgres') {
      const { rows } = await sql<{ name: string; type: string; notnull: boolean; identity: string }>`
        SELECT a.attname AS name, format_type(a.atttypid, a.atttypmod) AS type, a.attnotnull AS notnull,
               a.attidentity AS identity
        FROM pg_attribute a WHERE a.attrelid = to_regclass(${table}::text) AND a.attnum > 0 AND NOT a.attisdropped
        ORDER BY a.attnum`.execute(h.db);
      return rows.map((r) => ({
        name: r.name,
        type: r.type.replace(/^character varying/, 'varchar').replace(/^character\b/, 'char'),
        notNull: r.notnull,
        auto: r.identity === 'd',
      }));
    }
    const { rows } = await sql<{ name: string; type: string; nn: number; pk: number }>`
      SELECT name, type, "notnull" AS nn, pk FROM pragma_table_info(${table}) ORDER BY cid`.execute(h.db);
    const ddl = await sql<{ sql: string }>`SELECT sql FROM sqlite_master WHERE type = 'table' AND name = ${table}`.execute(h.db);
    const autoincrement = /autoincrement/i.test(ddl.rows[0]?.sql ?? '');
    return rows.map((r) => ({
      name: r.name,
      type: r.type.toLowerCase(),
      // An INTEGER PRIMARY KEY is the rowid: never NULL whatever notnull says.
      notNull: r.nn === 1 || (r.pk === 1 && r.type.toLowerCase() === 'integer'),
      auto: r.pk === 1 && r.type.toLowerCase() === 'integer' && autoincrement,
    }));
  }

  /** MySQL/MariaDB: the collation of every character column of `table`. */
  async function collations(table: string): Promise<Record<string, string>> {
    const { rows } = await sql<{ col: string; coll: string }>`
      SELECT COLUMN_NAME AS col, COLLATION_NAME AS coll FROM information_schema.COLUMNS
      WHERE TABLE_SCHEMA = DATABASE() AND TABLE_NAME = ${table} AND COLLATION_NAME IS NOT NULL`.execute(h.db);
    return Object.fromEntries(rows.map((r) => [r.col, r.coll]));
  }

  /** PostgreSQL: the collation of every character column of `table` (`default` for the database's own). */
  async function pgCollations(table: string): Promise<Record<string, string>> {
    const { rows } = await sql<{ col: string; coll: string }>`
      SELECT a.attname AS col, c.collname AS coll FROM pg_attribute a JOIN pg_collation c ON c.oid = a.attcollation
      WHERE a.attrelid = to_regclass(${table}::text) AND a.attnum > 0 AND NOT a.attisdropped`.execute(h.db);
    return Object.fromEntries(rows.map((r) => [r.col, r.coll]));
  }

  /** `code` and `meta.reason` of a DomainError (or the error itself when it is something else). */
  const domainCode = (e: unknown) => (isDomainError(e) ? { code: e.code, reason: e.meta?.['reason'] } : e);

  beforeAll(async () => {
    h = await testDb();
    db = h.db.withTables<Tables>();
  });

  afterAll(async () => {
    await h?.close();
  });

  beforeEach(async () => {
    await emptyDatabase(h);
    await ensureBootstrap(h.db, h.dialect);
  });

  describe('ensureBootstrap', () => {
    it('creates schema_tables and schema_meta and registers both as migrator tables, idempotently', async () => {
      await ensureBootstrap(h.db, h.dialect); // second run (beforeEach ran the first)
      expect(await tableNames()).toEqual(['schema_meta', 'schema_tables']);
      expect(await registry()).toEqual([
        { name: 'schema_meta', class: 'migrator', created_by: 'bootstrap' },
        { name: 'schema_tables', class: 'migrator', created_by: 'bootstrap' },
      ]);
    });

    it('gives schema_meta a SMALLINT key and a nullable install_id, the other columns NOT NULL', async () => {
      expect(await catalogColumns('schema_meta')).toEqual([
        { name: 'id', type: 'smallint', notNull: true, auto: false },
        { name: 'schema_version', type: 'varchar(32)', notNull: true, auto: false },
        { name: 'min_code_version', type: 'varchar(32)', notNull: true, auto: false },
        { name: 'install_id', type: 'char(26)', notNull: false, auto: false },
      ]);
      expect(await catalogColumns('schema_tables')).toEqual([
        { name: 'name', type: 'varchar(191)', notNull: true, auto: false },
        { name: 'class', type: 'varchar(16)', notNull: true, auto: false },
        { name: 'created_by', type: 'varchar(191)', notNull: true, auto: false },
      ]);
      await db.insertInto('schema_meta').values({ id: 1, schema_version: '0001', min_code_version: '0.1.0', install_id: null }).execute();
      expect(await db.selectFrom('schema_meta').selectAll().execute()).toEqual([
        { id: 1, schema_version: '0001', min_code_version: '0.1.0', install_id: null },
      ]);
      await expect(
        db.insertInto('schema_meta').values({ id: 2, schema_version: null as unknown as string, min_code_version: '0.1.0' }).execute(),
      ).rejects.toThrow();
      const dup = await rejection(
        db.insertInto('schema_meta').values({ id: 1, schema_version: '0002', min_code_version: '0.1.0' }).execute(),
      );
      expect(isDomainError(dup) && dup.code).toBe('UNIQUE_VIOLATION');
    });

    it('survives two connections bootstrapping at the same time', async () => {
      await dropRegisteredTables(h.db, h.dialect);
      expect(await tableNames()).toEqual([]);
      const other = await testDb({ reset: false });
      try {
        // Both pools hold an open connection, so that neither side is slowed down by connecting.
        await Promise.all([sql`SELECT 1 AS one`.execute(h.db), sql`SELECT 1 AS one`.execute(other.db)]);
        await Promise.all([ensureBootstrap(h.db, h.dialect), ensureBootstrap(other.db, other.dialect)]);
      } finally {
        await other.close();
      }
      expect((await registry()).map((r) => r.name)).toEqual(['schema_meta', 'schema_tables']);
    });
  });

  describe('ensureTable', () => {
    it('accepts a table with a foreign key that another connection created after this one found it missing', async () => {
      await ensureTable(h.db, h.dialect, 't_parent', 'data', 'test', (t) => t.id());
      const owned = (t: TableBuilder) => {
        t.id();
        t.ulid('parent_id');
        t.foreignKey('parent_id', 't_parent', 'id', { onDelete: 'cascade' });
      };
      // B's first statement (the existence check) answers "missing"; its result is held back until A has created
      // the table, so B continues as if A had won the race in between. Kysely hands results to plugins after the
      // connection is released, so this works on SQLite's single connection too.
      let arrived!: () => void;
      let release!: () => void;
      const firstResultArrived = new Promise<void>((resolve) => (arrived = resolve));
      const gate = new Promise<void>((resolve) => (release = resolve));
      let held = false;
      const holdFirstResult: KyselyPlugin = {
        transformQuery: (args) => args.node,
        transformResult: async (args) => {
          if (!held) {
            held = true;
            arrived();
            await gate;
          }
          return args.result;
        },
      };
      const other = await testDb({ reset: false });
      let b: Promise<void> | undefined;
      try {
        b = ensureTable(other.db.withPlugin(holdFirstResult), other.dialect, 't_owned', 'data', 'test', owned);
        await Promise.race([firstResultArrived, b]); // b failing early must not leave this waiting
        // The race really happens: B's existence check was answered and is held, and B is still waiting on it (a
        // sentinel settled a macrotask later wins against it). Otherwise A and B would simply run one after the
        // other and the recovery path would never be exercised.
        expect(held).toBe(true);
        const pending = Symbol('pending');
        const sentinel = new Promise<symbol>((resolve) => setImmediate(() => resolve(pending)));
        expect(await Promise.race([b.then(() => 'settled', () => 'settled'), sentinel])).toBe(pending);
        await ensureTable(h.db, h.dialect, 't_owned', 'data', 'test', owned); // A
        release();
        await b;
      } finally {
        release();
        // Settled here whatever happened above, so a failure of b cannot become an unhandled rejection.
        await b?.catch(() => {});
        await other.close();
      }
      expect((await registry()).filter((r) => r.name === 't_owned')).toEqual([{ name: 't_owned', class: 'data', created_by: 'test' }]);
      await expect(db.insertInto('t_owned').values({ id: newId(), parent_id: newId() }).execute()).rejects.toThrow();
    });

    it("creates the table once and registers exactly one row ('t_demo','data','test')", async () => {
      await ensureTable(h.db, h.dialect, 't_demo', 'data', 'test', demo);
      await db.insertInto('t_demo').values({ id: newId(), code_key: 'K1', name: 'first' }).execute();
      await ensureTable(h.db, h.dialect, 't_demo', 'data', 'test', demo);
      // The row inserted between the calls is still there: the second call did not recreate the table.
      expect(await db.selectFrom('t_demo').select('code_key').execute()).toEqual([{ code_key: 'K1' }]);
      expect(await tableNames()).toEqual(['schema_meta', 'schema_tables', 't_demo']);
      expect(await registry()).toEqual([
        { name: 'schema_meta', class: 'migrator', created_by: 'bootstrap' },
        { name: 'schema_tables', class: 'migrator', created_by: 'bootstrap' },
        { name: 't_demo', class: 'data', created_by: 'test' },
      ]);
    });

    it('registers a table that already exists but has no schema_tables row', async () => {
      await ensureTable(h.db, h.dialect, 't_demo', 'data', 'test', demo);
      await db.deleteFrom('schema_tables').where('name', '=', 't_demo').execute();
      await ensureTable(h.db, h.dialect, 't_demo', 'data', 'test', demo);
      expect(await registry()).toContainEqual({ name: 't_demo', class: 'data', created_by: 'test' });
    });

    it('refuses a table registered under a different class, and keeps the first created_by (R19)', async () => {
      await ensureTable(h.db, h.dialect, 't_demo', 'data', 'first', demo);
      const error = await rejection(ensureTable(h.db, h.dialect, 't_demo', 'volatile', 'first', demo));
      expect(domainCode(error)).toEqual({ code: 'SCHEMA_CONFLICT', reason: 'class_mismatch' });
      expect(isDomainError(error) && error.meta).toMatchObject({ table: 't_demo', registered: 'data', declared: 'volatile' });
      await ensureTable(h.db, h.dialect, 't_demo', 'data', 'second', demo);
      expect((await registry()).filter((r) => r.name === 't_demo')).toEqual([{ name: 't_demo', class: 'data', created_by: 'first' }]);
      // A row without its table: the class is checked before anything is created.
      await db.insertInto('schema_tables').values({ name: 't_parent', class: 'history', created_by: 'x' }).execute();
      const missing = await rejection(ensureTable(h.db, h.dialect, 't_parent', 'data', 'test', (t) => t.id()));
      expect(domainCode(missing)).toEqual({ code: 'SCHEMA_CONFLICT', reason: 'class_mismatch' });
      expect(await tableNames()).not.toContain('t_parent');
      // ensureBootstrap goes through the same check.
      await db.updateTable('schema_tables').set({ class: 'data' }).where('name', '=', 'schema_meta').execute();
      expect(domainCode(await rejection(ensureBootstrap(h.db, h.dialect)))).toEqual({ code: 'SCHEMA_CONFLICT', reason: 'class_mismatch' });
    });

    it('creates the table when a schema_tables row exists without it', async () => {
      await db.insertInto('schema_tables').values({ name: 't_demo', class: 'data', created_by: 'test' }).execute();
      await ensureTable(h.db, h.dialect, 't_demo', 'data', 'test', demo);
      expect(await tableNames()).toContain('t_demo');
      expect((await registry()).filter((r) => r.name === 't_demo')).toHaveLength(1);
    });

    it.runIf(['mysql', 'mariadb'].includes(ENGINE_SPECS[ctx.engine].dialect))(
      'MySQL/MariaDB: InnoDB, table collation utf8mb4_unicode_ci, key191 column utf8mb4_bin',
      async () => {
        expect(mysqlFamily()).toBe(true);
        await ensureTable(h.db, h.dialect, 't_demo', 'data', 'test', demo);
        const tables = await sql<{ engine: string; coll: string; name: string }>`
          SELECT TABLE_NAME AS name, ENGINE AS engine, TABLE_COLLATION AS coll FROM information_schema.TABLES
          WHERE TABLE_SCHEMA = DATABASE() ORDER BY TABLE_NAME`.execute(h.db);
        expect(tables.rows).toEqual([
          { name: 'schema_meta', engine: 'InnoDB', coll: 'utf8mb4_unicode_ci' },
          { name: 'schema_tables', engine: 'InnoDB', coll: 'utf8mb4_unicode_ci' },
          { name: 't_demo', engine: 'InnoDB', coll: 'utf8mb4_unicode_ci' },
        ]);
        const columns = await sql<{ col: string; cs: string | null; coll: string | null }>`
          SELECT COLUMN_NAME AS col, CHARACTER_SET_NAME AS cs, COLLATION_NAME AS coll FROM information_schema.COLUMNS
          WHERE TABLE_SCHEMA = DATABASE() AND TABLE_NAME = 't_demo' ORDER BY ORDINAL_POSITION`.execute(h.db);
        expect(columns.rows).toEqual([
          { col: 'id', cs: 'utf8mb4', coll: 'utf8mb4_bin' },
          { col: 'code_key', cs: 'utf8mb4', coll: 'utf8mb4_bin' },
          { col: 'name', cs: 'utf8mb4', coll: 'utf8mb4_unicode_ci' },
          { col: 'note', cs: 'utf8mb4', coll: 'utf8mb4_unicode_ci' },
        ]);
        const key = await sql<{ coll: string }>`
          SELECT COLLATION_NAME AS coll FROM information_schema.COLUMNS
          WHERE TABLE_SCHEMA = DATABASE() AND TABLE_NAME = 'schema_tables' AND COLUMN_NAME = 'name'`.execute(h.db);
        expect(key.rows).toEqual([{ coll: 'utf8mb4_bin' }]);
      },
    );

    it.runIf(['mysql', 'mariadb'].includes(ENGINE_SPECS[ctx.engine].dialect))(
      'MySQL/MariaDB: id(), ulid(), char() and key191() are utf8mb4_bin; date(), varchar(), text() and json() are not (R17)',
      async () => {
        await ensureTable(h.db, h.dialect, 't_types', 'data', 'test', allTypes);
        expect(await collations('t_types')).toEqual({
          id: 'utf8mb4_bin',
          ref: 'utf8mb4_bin',
          day: 'utf8mb4_unicode_ci',
          doc: 'utf8mb4_unicode_ci',
          body: 'utf8mb4_unicode_ci',
          code: 'utf8mb4_bin',
          s: 'utf8mb4_unicode_ci',
          k: 'utf8mb4_bin',
        });
        expect(await collations('schema_meta')).toEqual({
          schema_version: 'utf8mb4_unicode_ci',
          min_code_version: 'utf8mb4_unicode_ci',
          install_id: 'utf8mb4_bin',
        });
      },
    );

    it.runIf(ENGINE_SPECS[ctx.engine].dialect === 'postgres')(
      'PostgreSQL: id(), ulid(), char() and key191() are COLLATE "C" (byte order, as R17 on MySQL); the other kinds keep the default',
      async () => {
        await ensureTable(h.db, h.dialect, 't_types', 'data', 'test', allTypes);
        expect(await pgCollations('t_types')).toEqual({
          id: 'C',
          ref: 'C',
          day: 'default',
          doc: 'default',
          body: 'default',
          code: 'C',
          s: 'default',
          k: 'C',
        });
        expect(await pgCollations('schema_meta')).toEqual({ schema_version: 'default', min_code_version: 'default', install_id: 'C' });
        expect((await pgCollations('schema_tables'))['name']).toBe('C');
      },
    );

    it('maps every helper to the documented column type, as the catalog reports it', async () => {
      await ensureTable(h.db, h.dialect, 't_types', 'data', 'test', allTypes);
      await ensureTable(h.db, h.dialect, 't_serial', 'volatile', 'test', (t) => {
        t.serial('seq');
        t.varchar('label', 20);
      });
      const c = (name: string, type: string, notNull = true) => ({ name, type, notNull, auto: false });
      expect(await catalogColumns('t_types')).toEqual([
        c('id', 'char(26)'),
        c('ref', 'char(26)', false),
        c('flag', 'smallint'),
        c('amount', 'bigint'),
        c('at', 'bigint'),
        c('day', 'char(10)'),
        c('doc', 'text'),
        c('body', 'text'),
        c('code', 'char(3)'),
        c('small', 'smallint'),
        c('count', 'integer'),
        c('big', 'bigint'),
        c('n', 'integer'),
        c('s', 'varchar(191)', false),
        c('k', 'varchar(191)'),
      ]);
      expect(await catalogColumns('t_serial')).toEqual([
        { name: 'seq', type: h.dialect === 'sqlite' ? 'integer' : 'bigint', notNull: true, auto: true },
        c('label', 'varchar(20)'),
      ]);
    });

    it("accepts 'ABC' and 'abc' in a unique key191 column, and still refuses a second 'ABC'", async () => {
      await ensureTable(h.db, h.dialect, 't_demo', 'data', 'test', demo);
      await ensureIndex(h.db, h.dialect, 't_demo', 'uq_t_demo_code_key', ['code_key'], { unique: true });
      await db.insertInto('t_demo').values({ id: newId(), code_key: 'ABC', name: 'upper' }).execute();
      await db.insertInto('t_demo').values({ id: newId(), code_key: 'abc', name: 'lower' }).execute();
      const rows = await db.selectFrom('t_demo').select('code_key').orderBy('name').execute();
      expect(rows.map((r) => r.code_key).sort()).toEqual(['ABC', 'abc']);
      const dup = await rejection(db.insertInto('t_demo').values({ id: newId(), code_key: 'ABC', name: 'again' }).execute());
      expect(isDomainError(dup) && dup.code).toBe('UNIQUE_VIOLATION');
    });

    it('auto-increments a serial column from 1', async () => {
      await ensureTable(h.db, h.dialect, 't_serial', 'volatile', 'test', (t) => {
        t.serial('seq');
        t.varchar('label', 20);
      });
      await db.insertInto('t_serial').values({ label: 'one' }).execute();
      await db.insertInto('t_serial').values({ label: 'two' }).execute();
      await db.insertInto('t_serial').values({ label: 'three' }).execute();
      expect(await db.selectFrom('t_serial').select(['seq', 'label']).orderBy('seq').execute()).toEqual([
        { seq: 1, label: 'one' },
        { seq: 2, label: 'two' },
        { seq: 3, label: 'three' },
      ]);
    });

    it('maps every column helper, makes columns NOT NULL unless nullable(), and applies defaults', async () => {
      await ensureTable(h.db, h.dialect, 't_types', 'data', 'test', allTypes);
      const id = newId();
      const full = { id, amount: 12_345, at: EPOCH_MS, day: '2026-01-01', doc: '{"a":1}', body: 'x', code: 'IDR', small: 3, big: 2 ** 53 - 1 };
      await db.insertInto('t_types').values(full).execute();
      expect(await db.selectFrom('t_types').selectAll().where('id', '=', id).executeTakeFirstOrThrow()).toEqual({
        ...full,
        ref: null,
        flag: 0,
        count: 5,
        n: 7,
        s: null,
        k: 'K',
      });
      // body is NOT NULL (the default for every helper)
      const withoutBody: Record<string, unknown> = { ...full, id: newId() };
      delete withoutBody['body'];
      await expect(db.insertInto('t_types').values(withoutBody as never).execute()).rejects.toThrow();
      await expect(db.insertInto('t_types').values({ ...full, id: newId(), ref: newId(), body: null as unknown as string }).execute()).rejects.toThrow();
    });

    it('creates a composite primary key with primaryKey(cols)', async () => {
      await ensureTable(h.db, h.dialect, 't_pair', 'volatile', 'test', (t) => {
        t.key191('a');
        t.bigint('b');
        t.int('v');
        t.primaryKey(['a', 'b']);
      });
      await db.insertInto('t_pair').values({ a: 'x', b: 1, v: 1 }).execute();
      await db.insertInto('t_pair').values({ a: 'x', b: 2, v: 1 }).execute();
      await db.insertInto('t_pair').values({ a: 'X', b: 1, v: 1 }).execute();
      const dup = await rejection(db.insertInto('t_pair').values({ a: 'x', b: 1, v: 2 }).execute());
      expect(isDomainError(dup) && dup.code).toBe('UNIQUE_VIOLATION');
    });

    it('creates real foreign keys: orphans are refused, cascade deletes, restrict refuses', async () => {
      await ensureTable(h.db, h.dialect, 't_parent', 'data', 'test', (t) => t.id());
      await ensureTable(h.db, h.dialect, 't_owned', 'data', 'test', (t) => {
        t.id();
        t.ulid('parent_id');
        t.foreignKey('parent_id', 't_parent', 'id', { onDelete: 'cascade' });
      });
      await ensureTable(h.db, h.dialect, 't_guarded', 'data', 'test', (t) => {
        t.id();
        t.ulid('parent_id');
        t.foreignKey('parent_id', 't_parent', 'id', { onDelete: 'restrict' });
      });
      const p1 = newId();
      const p2 = newId();
      await db.insertInto('t_parent').values([{ id: p1 }, { id: p2 }]).execute();
      await expect(db.insertInto('t_owned').values({ id: newId(), parent_id: newId() }).execute()).rejects.toThrow();
      await expect(db.insertInto('t_guarded').values({ id: newId(), parent_id: newId() }).execute()).rejects.toThrow();

      await db.insertInto('t_owned').values({ id: newId(), parent_id: p1 }).execute();
      await db.deleteFrom('t_parent').where('id', '=', p1).execute();
      expect(await db.selectFrom('t_owned').selectAll().execute()).toEqual([]);

      await db.insertInto('t_guarded').values({ id: newId(), parent_id: p2 }).execute();
      await expect(db.deleteFrom('t_parent').where('id', '=', p2).execute()).rejects.toThrow();
      expect(await db.selectFrom('t_parent').select('id').execute()).toEqual([{ id: p2 }]);
    });

    it('refuses a foreign key to a missing table or column on every dialect, creating and registering nothing', async () => {
      await ensureTable(h.db, h.dialect, 't_parent', 'data', 'test', (t) => t.id());
      const toMissingTable = await rejection(
        ensureTable(h.db, h.dialect, 't_owned', 'data', 'test', (t) => {
          t.id();
          t.ulid('parent_id');
          t.foreignKey('parent_id', 't_nowhere', 'id', { onDelete: 'cascade' });
        }),
      );
      expect(domainCode(toMissingTable)).toEqual({ code: 'SCHEMA_CONFLICT', reason: 'foreign_key_target_missing' });
      const toMissingColumn = await rejection(
        ensureTable(h.db, h.dialect, 't_owned', 'data', 'test', (t) => {
          t.id();
          t.ulid('parent_id');
          t.foreignKey('parent_id', 't_parent', 'code', { onDelete: 'cascade' });
        }),
      );
      expect(domainCode(toMissingColumn)).toEqual({ code: 'SCHEMA_CONFLICT', reason: 'foreign_key_target_missing' });
      expect(await tableNames()).toEqual(['schema_meta', 'schema_tables', 't_parent']);
      expect((await registry()).map((r) => r.name)).toEqual(['schema_meta', 'schema_tables', 't_parent']);
    });

    it('refuses a foreign key name another table already uses (unique per database on MySQL) on every dialect', async () => {
      await ensureTable(h.db, h.dialect, 't_parent', 'data', 'test', (t) => t.id());
      // fk_t_x_y_z_id from table t_x_y, column z_id ...
      await ensureTable(h.db, h.dialect, 't_x_y', 'data', 'test', (t) => {
        t.id();
        t.ulid('z_id');
        t.foreignKey('z_id', 't_parent', 'id', { onDelete: 'cascade' });
      });
      // ... and from table t_x, column y_z_id.
      const error = await rejection(
        ensureTable(h.db, h.dialect, 't_x', 'data', 'test', (t) => {
          t.id();
          t.ulid('y_z_id');
          t.foreignKey('y_z_id', 't_parent', 'id', { onDelete: 'cascade' });
        }),
      );
      expect(domainCode(error)).toEqual({ code: 'SCHEMA_CONFLICT', reason: 'constraint_name_taken' });
      expect(isDomainError(error) && error.meta).toMatchObject({ name: 'fk_t_x_y_z_id', table: 't_x_y' });
      expect(await tableNames()).not.toContain('t_x');
      expect((await registry()).map((r) => r.name)).not.toContain('t_x');
    });

    it('refuses a foreign key whose column type differs from the referenced column, on every dialect, writing nothing', async () => {
      await ensureTable(h.db, h.dialect, 't_parent', 'data', 'test', (t) => t.id());
      await ensureTable(h.db, h.dialect, 't_serial', 'volatile', 'test', (t) => {
        t.serial('seq');
        t.varchar('label', 20);
      });
      const cases: Array<[string, (t: TableBuilder) => void, string, string, string]> = [
        ['varchar(26) -> char(26) id', (t) => { t.id(); t.varchar('owner', 26); t.foreignKey('owner', 't_parent', 'id', { onDelete: 'cascade' }); }, 'owner', 't_parent', 'id'],
        ['char(25) -> char(26) id', (t) => { t.id(); t.char('owner', 25); t.foreignKey('owner', 't_parent', 'id', { onDelete: 'cascade' }); }, 'owner', 't_parent', 'id'],
        ['integer -> bigint serial', (t) => { t.id(); t.int('seq_ref'); t.foreignKey('seq_ref', 't_serial', 'seq', { onDelete: 'cascade' }); }, 'seq_ref', 't_serial', 'seq'],
      ];
      for (const [label, build, column, refTable, refColumn] of cases) {
        const error = await rejection(ensureTable(h.db, h.dialect, 't_ref', 'data', 'test', build));
        expect(domainCode(error), label).toEqual({ code: 'SCHEMA_CONFLICT', reason: 'fk_type_mismatch' });
        expect(isDomainError(error) && error.meta, label).toMatchObject({ table: 't_ref', column, refTable, refColumn });
      }
      expect(await tableNames()).toEqual(['schema_meta', 'schema_tables', 't_parent', 't_serial']);
      expect((await registry()).map((r) => r.name)).not.toContain('t_ref');
      // Matching types are accepted, a bigint column referencing serial() included (INTEGER on SQLite).
      await ensureTable(h.db, h.dialect, 't_ref', 'data', 'test', (t) => {
        t.id();
        t.ulid('parent_id');
        t.bigint('seq_ref');
        t.foreignKey('parent_id', 't_parent', 'id', { onDelete: 'cascade' });
        t.foreignKey('seq_ref', 't_serial', 'seq', { onDelete: 'cascade' });
      });
      expect(await tableNames()).toContain('t_ref');
    });

    it("reads an int() primary key as integer even when the word 'autoincrement' appears elsewhere in the table", async () => {
      await ensureTable(h.db, h.dialect, 't_codes', 'data', 'test', (t) => {
        t.int('n');
        t.varchar('kind', 20).default('autoincrement');
        t.primaryKey(['n']);
      });
      const bigintRef = await rejection(
        ensureTable(h.db, h.dialect, 't_ref', 'data', 'test', (t) => {
          t.id();
          t.bigint('n_ref');
          t.foreignKey('n_ref', 't_codes', 'n', { onDelete: 'cascade' });
        }),
      );
      expect(domainCode(bigintRef)).toEqual({ code: 'SCHEMA_CONFLICT', reason: 'fk_type_mismatch' });
      await ensureTable(h.db, h.dialect, 't_ref', 'data', 'test', (t) => {
        t.id();
        t.int('n_ref');
        t.foreignKey('n_ref', 't_codes', 'n', { onDelete: 'cascade' });
      });
      expect(await tableNames()).toContain('t_ref');
    });

    it('MySQL/MariaDB also compare collations: varchar(191) -> key191() is refused there (SCHEMA_CONFLICT, not a driver error)', async () => {
      await ensureTable(h.db, h.dialect, 't_key', 'data', 'test', (t) => {
        t.id();
        t.key191('k');
      });
      await ensureIndex(h.db, h.dialect, 't_key', 'uq_t_key_k', ['k'], { unique: true });
      const build = (t: TableBuilder) => {
        t.id();
        t.varchar('k_ref', 191);
        t.foreignKey('k_ref', 't_key', 'k', { onDelete: 'cascade' });
      };
      if (mysqlFamily()) {
        const error = await rejection(ensureTable(h.db, h.dialect, 't_ref', 'data', 'test', build));
        expect(domainCode(error)).toEqual({ code: 'SCHEMA_CONFLICT', reason: 'fk_type_mismatch' });
        expect(await tableNames()).not.toContain('t_ref');
      } else {
        // The catalog of PostgreSQL/SQLite does not say which helper made a varchar(191) column.
        await ensureTable(h.db, h.dialect, 't_ref', 'data', 'test', build);
        expect(await tableNames()).toContain('t_ref');
      }
    });

    it.runIf(['mysql', 'mariadb'].includes(ENGINE_SPECS[ctx.engine].dialect))(
      "MySQL/MariaDB utf8mb4_bin is PAD SPACE: a unique key191 column refuses 'abc ' after 'abc' (R24)",
      async () => {
        await ensureTable(h.db, h.dialect, 't_key', 'data', 'test', (t) => {
          t.id();
          t.key191('k');
        });
        await ensureIndex(h.db, h.dialect, 't_key', 'uq_t_key_k', ['k'], { unique: true });
        await db.insertInto('t_key').values({ id: newId(), k: 'abc' }).execute();
        const dup = await rejection(db.insertInto('t_key').values({ id: newId(), k: 'abc ' }).execute());
        expect(domainCode(dup)).toMatchObject({ code: 'UNIQUE_VIOLATION' });
        expect(await db.selectFrom('t_key').select('k').where('k', '=', 'abc ').execute()).toEqual([{ k: 'abc' }]);
      },
    );

    it.runIf(!['mysql', 'mariadb'].includes(ENGINE_SPECS[ctx.engine].dialect))(
      "PostgreSQL/SQLite keep trailing blanks distinct in a unique key191 column (R24: the app stores trimmed values)",
      async () => {
        await ensureTable(h.db, h.dialect, 't_key', 'data', 'test', (t) => {
          t.id();
          t.key191('k');
        });
        await ensureIndex(h.db, h.dialect, 't_key', 'uq_t_key_k', ['k'], { unique: true });
        await db.insertInto('t_key').values([{ id: newId(), k: 'abc' }, { id: newId(), k: 'abc ' }]).execute();
        expect((await db.selectFrom('t_key').select('k').execute()).map((r) => r.k).sort()).toEqual(['abc', 'abc ']);
      },
    );

    it('names every primary key pk_<table>, so no table can clash with an implicit <table>_pkey index (PostgreSQL)', async () => {
      await ensureTable(h.db, h.dialect, 't_demo', 'data', 'test', demo);
      await ensureTable(h.db, h.dialect, 't_serial', 'volatile', 'test', (t) => {
        t.serial('seq');
        t.varchar('label', 20);
      });
      // Before, PostgreSQL named t_demo's key index t_demo_pkey, and this create failed with 42P07.
      await ensureTable(h.db, h.dialect, 't_demo_pkey', 'data', 'test', (t) => t.id());
      expect(await tableNames()).toContain('t_demo_pkey');
      if (h.dialect === 'postgres') {
        expect(await indexNames('t_demo')).toEqual(['pk_t_demo']);
        expect(await indexNames('t_serial')).toEqual(['pk_t_serial']);
        const keys = await sql<{ name: string }>`SELECT conname AS name FROM pg_constraint
          WHERE contype = 'p' AND conrelid IN (to_regclass('t_demo'), to_regclass('t_serial'), to_regclass('t_demo_pkey'))
          ORDER BY conname`.execute(h.db);
        expect(keys.rows.map((r) => r.name)).toEqual(['pk_t_demo', 'pk_t_demo_pkey', 'pk_t_serial']);
      }
    });

    describe('refuses a definition that would not be portable, before touching the database', () => {
      const cases: Array<[string, string, (t: TableBuilder) => void]> = [
        ['an invalid table name', 'T-Demo', (t) => t.id()],
        ['a table name over 63 characters', `t_${'x'.repeat(62)}`, (t) => t.id()],
        ['a table name over 60 characters (its key is pk_<table>)', `t_${'x'.repeat(59)}`, (t) => t.id()],
        ['a table name ending in _seq (PostgreSQL identity sequences)', 't_serial_seq_seq', (t) => t.id()],
        ['a table name starting with sqlite_', 'sqlite_x', (t) => t.id()],
        ['an invalid column name', 't_bad', (t) => { t.id(); t.int('Count'); }],
        ['a duplicate column', 't_bad', (t) => { t.id(); t.int('n'); t.bigint('n'); }],
        ['no columns', 't_bad', () => {}],
        ['no primary key', 't_bad', (t) => { t.int('n'); }],
        ['two primary keys', 't_bad', (t) => { t.id(); t.serial('seq'); }],
        ['id() plus primaryKey()', 't_bad', (t) => { t.id(); t.int('n'); t.primaryKey(['id', 'n']); }],
        ['primaryKey() on an unknown column', 't_bad', (t) => { t.int('n'); t.primaryKey(['n', 'm']); }],
        ['a nullable primary key column', 't_bad', (t) => { t.int('n').nullable(); t.primaryKey(['n']); }],
        ['a nullable id()', 't_bad', (t) => { t.id().nullable(); }],
        ['varchar longer than 191', 't_bad', (t) => { t.id(); t.varchar('s', 192); }],
        ['varchar of length 0', 't_bad', (t) => { t.id(); t.varchar('s', 0); }],
        ['char longer than 191', 't_bad', (t) => { t.id(); t.char('s', 200); }],
        ['a default on a text column (MySQL refuses it)', 't_bad', (t) => { t.id(); t.text('s').default('x'); }],
        ['a default on a json column', 't_bad', (t) => { t.id(); t.json('s').default('{}'); }],
        ['a default on serial()', 't_bad', (t) => { t.serial('seq').default(1); }],
        ['a string default on an integer column', 't_bad', (t) => { t.id(); t.int('n').default('1'); }],
        ['a fractional default on an integer column', 't_bad', (t) => { t.id(); t.bigint('n').default(1.5); }],
        ['a bool default other than 0/1', 't_bad', (t) => { t.id(); t.bool('b').default(2); }],
        ['a number default on a text-like column', 't_bad', (t) => { t.id(); t.varchar('s', 10).default(1); }],
        ['a string default longer than the column', 't_bad', (t) => { t.id(); t.char('s', 3).default('ABCD'); }],
        ['a char(n) default shorter than n', 't_bad', (t) => { t.id(); t.char('s', 3).default('AB'); }],
        ['a date() default that is not 10 characters', 't_bad', (t) => { t.id(); t.date('d').default('2026-1-1'); }],
        ['a ulid() default that is not 26 characters', 't_bad', (t) => { t.id(); t.ulid('u').default('01ABC'); }],
        ['a self-reference to an unknown column', 't_bad', (t) => { t.id(); t.ulid('p'); t.foreignKey('p', 't_bad', 'nope', { onDelete: 'cascade' }); }],
        ['a self-reference of another type (varchar -> char id)', 't_bad', (t) => { t.id(); t.varchar('p', 26).nullable(); t.foreignKey('p', 't_bad', 'id', { onDelete: 'cascade' }); }],
        ['a self-reference of another collation class (date -> char(10))', 't_bad', (t) => { t.char('c', 10); t.date('d'); t.primaryKey(['c']); t.foreignKey('d', 't_bad', 'c', { onDelete: 'cascade' }); }],
        ['a char(n) default ending in a blank', 't_bad', (t) => { t.id(); t.char('s', 3).default('AB '); }],
        ['a date() default ending in a blank', 't_bad', (t) => { t.id(); t.date('d').default('2026-01-1 '); }],
        ['a ulid() default ending in a blank', 't_bad', (t) => { t.id(); t.ulid('u').default(`${'0'.repeat(25)} `); }],
        ['a table name with the index prefix ix_', 'ix_t', (t) => t.id()],
        ['a table name with the index prefix uq_', 'uq_t', (t) => t.id()],
        ['a table name with the constraint prefix pk_', 'pk_t_demo', (t) => t.id()],
        ['a table name with the constraint prefix fk_', 'fk_t', (t) => t.id()],
        ['a null default on a NOT NULL column', 't_bad', (t) => { t.id(); t.int('n').default(null); }],
        ['a foreign key on an unknown column', 't_bad', (t) => { t.id(); t.foreignKey('parent_id', 't_parent', 'id', { onDelete: 'cascade' }); }],
        ['a foreign key to an invalid table name', 't_bad', (t) => { t.id(); t.ulid('p'); t.foreignKey('p', 'T', 'id', { onDelete: 'cascade' }); }],
        ['an unknown onDelete action', 't_bad', (t) => { t.id(); t.ulid('p'); t.foreignKey('p', 't_parent', 'id', { onDelete: 'set null' as 'cascade' }); }],
        ['two foreign keys on one column', 't_bad', (t) => {
          t.id();
          t.ulid('p');
          t.foreignKey('p', 't_parent', 'id', { onDelete: 'cascade' });
          t.foreignKey('p', 't_other', 'id', { onDelete: 'cascade' });
        }],
      ];

      it.each(cases)('%s', async (_label, name, build) => {
        await expect(ensureTable(h.db, h.dialect, name, 'data', 'test', build)).rejects.toThrow(TypeError);
        expect(await tableNames()).toEqual(['schema_meta', 'schema_tables']);
        expect(await registry()).toHaveLength(2);
      });

      it('refuses an unknown dialect', async () => {
        const oracle = 'oracle' as Dialect;
        await expect(ensureBootstrap(h.db, oracle)).rejects.toThrow(TypeError);
        await expect(ensureTable(h.db, oracle, 't_bad', 'data', 'test', (t) => t.id())).rejects.toThrow(TypeError);
        await expect(ensureIndex(h.db, oracle, 'schema_tables', 'ix_x', ['class'])).rejects.toThrow(TypeError);
        await expect(dropRegisteredTables(h.db, oracle)).rejects.toThrow(TypeError);
        expect(await tableNames()).toEqual(['schema_meta', 'schema_tables']);
      });

      it('refuses an unknown class and an empty or over-long createdBy', async () => {
        await expect(ensureTable(h.db, h.dialect, 't_bad', 'archive' as TableClass, 'test', (t) => t.id())).rejects.toThrow(TypeError);
        await expect(ensureTable(h.db, h.dialect, 't_bad', 'data', '', (t) => t.id())).rejects.toThrow(TypeError);
        await expect(ensureTable(h.db, h.dialect, 't_bad', 'data', 'x'.repeat(192), (t) => t.id())).rejects.toThrow(TypeError);
        expect(await registry()).toHaveLength(2);
      });
    });

    it('lists the table classes of spec §6.5', () => {
      expect(TABLE_CLASS_NAMES).toEqual(['data', 'config', 'history', 'install', 'volatile', 'migrator']);
    });
  });

  describe('ensureIndex', () => {
    it('creates the index once when called twice', async () => {
      await ensureTable(h.db, h.dialect, 't_demo', 'data', 'test', demo);
      const before = await indexNames('t_demo');
      await ensureIndex(h.db, h.dialect, 't_demo', 'ix_t_demo_name', ['name', 'code_key']);
      const after = await indexNames('t_demo');
      await ensureIndex(h.db, h.dialect, 't_demo', 'ix_t_demo_name', ['name', 'code_key']);
      expect(await indexNames('t_demo')).toEqual(after);
      expect(after.filter((n) => n === 'ix_t_demo_name')).toHaveLength(1);
      expect(after).toHaveLength(before.length + 1);
    });

    it('creates a non-unique index by default', async () => {
      await ensureTable(h.db, h.dialect, 't_demo', 'data', 'test', demo);
      await ensureIndex(h.db, h.dialect, 't_demo', 'ix_t_demo_name', ['name']);
      await db.insertInto('t_demo').values([
        { id: newId(), code_key: 'a', name: 'same' },
        { id: newId(), code_key: 'b', name: 'same' },
      ]).execute();
      expect(await db.selectFrom('t_demo').select('id').execute()).toHaveLength(2);
    });

    it('refuses an index name another table already uses, on every dialect (it does not skip)', async () => {
      await ensureTable(h.db, h.dialect, 't_demo', 'data', 'test', demo);
      await ensureTable(h.db, h.dialect, 't_parent', 'data', 'test', (t) => t.id());
      await ensureIndex(h.db, h.dialect, 't_demo', 'ix_shared', ['name']);
      const before = await indexNames('t_parent');
      const error = await rejection(ensureIndex(h.db, h.dialect, 't_parent', 'ix_shared', ['id']));
      expect(domainCode(error)).toEqual({ code: 'SCHEMA_CONFLICT', reason: 'index_name_taken' });
      expect(isDomainError(error) && error.meta).toMatchObject({ name: 'ix_shared', table: 't_demo' });
      expect(await indexNames('t_parent')).toEqual(before);
    });

    it('requires index names to start with ix_ (plain) or uq_ (unique), so they never meet PRIMARY, fk_/pk_ or table names (R23)', async () => {
      await ensureTable(h.db, h.dialect, 't_demo', 'data', 'test', demo);
      await ensureTable(h.db, h.dialect, 't_parent', 'data', 'test', (t) => t.id());
      await ensureTable(h.db, h.dialect, 't_owned', 'data', 'test', (t) => {
        t.id();
        t.ulid('parent_id');
        t.foreignKey('parent_id', 't_parent', 'id', { onDelete: 'cascade' });
      });
      const before = await indexNames('t_demo');
      const refused: Array<[string, boolean]> = [
        ['primary', true], // MySQL matches PRIMARY case-insensitively: it used to be a silent no-op there
        ['fk_t_owned_parent_id', false], // InnoDB's implicit index of that foreign key
        ['pk_t_parent', true], // the primary key index name on PostgreSQL
        ['t_parent', false], // a table: same namespace as indexes on PostgreSQL/SQLite
        ['uq_t_demo_name', false], // uq_ but not unique
        ['ix_t_demo_name', true], // ix_ but unique
        ['idx_t_demo_name', false],
      ];
      for (const [name, unique] of refused) {
        await expect(ensureIndex(h.db, h.dialect, 't_demo', name, ['name'], { unique }), name).rejects.toThrow(TypeError);
      }
      expect(await indexNames('t_demo')).toEqual(before);
    });

    it('refuses invalid names and empty or duplicate column lists', async () => {
      await ensureTable(h.db, h.dialect, 't_demo', 'data', 'test', demo);
      const before = await indexNames('t_demo');
      await expect(ensureIndex(h.db, h.dialect, 't_demo', 'Ix', ['name'])).rejects.toThrow(TypeError);
      await expect(ensureIndex(h.db, h.dialect, 'T', 'ix_x', ['name'])).rejects.toThrow(TypeError);
      await expect(ensureIndex(h.db, h.dialect, 't_demo', 'ix_x', [])).rejects.toThrow(TypeError);
      await expect(ensureIndex(h.db, h.dialect, 't_demo', 'ix_x', ['name', 'name'])).rejects.toThrow(TypeError);
      await expect(ensureIndex(h.db, h.dialect, 't_demo', 'ix_x', ['bad-col'])).rejects.toThrow(TypeError);
      expect(await indexNames('t_demo')).toEqual(before);
    });
  });

  describe('ensureColumn', () => {
    const grow = (t: TableBuilder) => {
      t.id();
      t.varchar('name', 100);
    };

    /** t_grow with two rows that exist before any column is added. */
    async function growWithRows(): Promise<void> {
      await ensureTable(h.db, h.dialect, 't_grow', 'data', 'test', grow);
      // Only the columns the table has so far.
      await db
        .insertInto('t_grow')
        .values([
          { id: 'A'.repeat(26), name: 'first' },
          { id: 'B'.repeat(26), name: 'second' },
        ])
        .execute();
    }

    it('adds a bool column with a default once when called twice: one column, existing rows read the default', async () => {
      await growWithRows();
      await ensureColumn(h.db, h.dialect, 't_grow', (t) => t.bool('flag').default(0));
      await ensureColumn(h.db, h.dialect, 't_grow', (t) => t.bool('flag').default(0));
      const columns = await catalogColumns('t_grow');
      expect(columns.map((c) => c.name)).toEqual(['id', 'name', 'flag']);
      expect(columns.find((c) => c.name === 'flag')).toEqual({ name: 'flag', type: 'smallint', notNull: true, auto: false });
      expect(await db.selectFrom('t_grow').select(['id', 'flag']).orderBy('id').execute()).toEqual([
        { id: 'A'.repeat(26), flag: 0 },
        { id: 'B'.repeat(26), flag: 0 },
      ]);
      // A new row without the column gets the default too.
      await db.insertInto('t_grow').values({ id: 'C'.repeat(26), name: 'third' }).execute();
      expect(await db.selectFrom('t_grow').select('flag').where('id', '=', 'C'.repeat(26)).execute()).toEqual([{ flag: 0 }]);
    });

    it('adds a nullable column without a default (existing rows read NULL) and a key191 column with a default', async () => {
      await growWithRows();
      await ensureColumn(h.db, h.dialect, 't_grow', (t) => t.varchar('tag', 32).nullable());
      await ensureColumn(h.db, h.dialect, 't_grow', (t) => t.key191('key').default('K'));
      expect((await catalogColumns('t_grow')).map((c) => [c.name, c.type, c.notNull])).toEqual([
        ['id', 'char(26)', true],
        ['name', 'varchar(100)', true],
        ['tag', 'varchar(32)', false],
        ['key', 'varchar(191)', true],
      ]);
      expect(await db.selectFrom('t_grow').select(['tag', 'key']).orderBy('id').execute()).toEqual([
        { tag: null, key: 'K' },
        { tag: null, key: 'K' },
      ]);
      if (mysqlFamily()) expect((await collations('t_grow'))['key']).toBe('utf8mb4_bin'); // R17, as in ensureTable
      if (h.dialect === 'postgres') expect(await pgCollations('t_grow')).toEqual({ id: 'C', name: 'default', tag: 'default', key: 'C' });
    });

    it('leaves a column that exists already as it is (no comparison), like ensureTable and ensureIndex', async () => {
      await growWithRows();
      await ensureColumn(h.db, h.dialect, 't_grow', (t) => t.varchar('name', 50).default('x'));
      expect((await catalogColumns('t_grow')).map((c) => [c.name, c.type])).toEqual([
        ['id', 'char(26)'],
        ['name', 'varchar(100)'],
      ]);
    });

    it.each([
      ['id()', (t: TableBuilder) => t.id('other')],
      ['serial()', (t: TableBuilder) => t.serial('seq')],
      [
        'primaryKey()',
        (t: TableBuilder) => {
          t.primaryKey(['id']);
          return t.bool('flag').default(0);
        },
      ],
      [
        'foreignKey()',
        (t: TableBuilder) => {
          t.foreignKey('name', 't_parent', 'id', { onDelete: 'cascade' });
          return t.bool('flag').default(0);
        },
      ],
    ])('refuses the key helper %s with a TypeError, before touching the database', async (_name, build) => {
      await growWithRows();
      await expect(ensureColumn(h.db, h.dialect, 't_grow', build)).rejects.toThrow(TypeError);
      expect((await catalogColumns('t_grow')).map((c) => c.name)).toEqual(['id', 'name']);
    });

    it.each([
      ['a NOT NULL column without a default (SQLite cannot add one)', (t: TableBuilder) => t.bool('flag')],
      ['a NOT NULL column with a null default', (t: TableBuilder) => t.int('n').default(null)],
      ['a NOT NULL text column (TEXT takes no default on MySQL)', (t: TableBuilder) => t.text('body')],
      ['a text column with a default', (t: TableBuilder) => t.text('body').nullable().default('x')],
      ['a bool default other than 0 or 1', (t: TableBuilder) => t.bool('flag').default(2)],
      [
        'two columns',
        (t: TableBuilder) => {
          t.bool('a').default(0);
          return t.bool('b').default(0);
        },
      ],
      ['no column', (() => undefined) as unknown as (t: TableBuilder) => never],
      ['an invalid column name', (t: TableBuilder) => t.bool('Flag').default(0)],
    ])('refuses %s with a TypeError, before touching the database', async (_name, build) => {
      await growWithRows();
      await expect(ensureColumn(h.db, h.dialect, 't_grow', build)).rejects.toThrow(TypeError);
      expect((await catalogColumns('t_grow')).map((c) => c.name)).toEqual(['id', 'name']);
    });

    it('refuses an invalid table name or dialect with a TypeError, and a missing table with SCHEMA_CONFLICT', async () => {
      await expect(ensureColumn(h.db, h.dialect, 'T_grow', (t) => t.bool('flag').default(0))).rejects.toThrow(TypeError);
      await expect(ensureColumn(h.db, 'oracle' as Dialect, 't_grow', (t) => t.bool('flag').default(0))).rejects.toThrow(TypeError);
      const error = await rejection(ensureColumn(h.db, h.dialect, 't_absent', (t) => t.bool('flag').default(0)));
      expect(domainCode(error)).toEqual({ code: 'SCHEMA_CONFLICT', reason: 'table_missing' });
      expect(await tableNames()).toEqual(['schema_meta', 'schema_tables']);
    });

    it('accepts a transaction (Kysely<any>, as the other DDL helpers, R45)', async () => {
      await growWithRows();
      await h.db.transaction().execute(async (trx) => {
        // PostgreSQL: transactional DDL; MySQL/MariaDB commit implicitly; SQLite allows ALTER inside BEGIN.
        await ensureColumn(trx, h.dialect, 't_grow', (t) => t.bool('flag').default(1));
      });
      expect(await db.selectFrom('t_grow').select('flag').orderBy('id').execute()).toEqual([{ flag: 1 }, { flag: 1 }]);
    });
  });

  describe('ensureByteOrder', () => {
    const POSTGRES = ENGINE_SPECS[ctx.engine].dialect === 'postgres';
    /** The columns of t_order as the column registry (columns.ts) describes them. */
    const ORDER_COLUMNS = [
      { name: 'id', kind: 'id', length: 26 },
      { name: 'k', kind: 'key191', length: 191 },
      { name: 'code', kind: 'char', length: 3 },
      { name: 'day', kind: 'date', length: 10 },
      { name: 'name', kind: 'varchar', length: 100 },
    ] as const;

    /** Every statement sent through the returned instance, as its operation node kind. */
    function recorded(): { db: Kysely<Tables>; kinds: string[] } {
      const kinds: string[] = [];
      const plugin: KyselyPlugin = {
        transformQuery: ({ node }) => {
          kinds.push(node.kind);
          return node;
        },
        transformResult: async ({ result }) => result,
      };
      return { db: db.withPlugin(plugin), kinds };
    }

    /**
     * t_order as an earlier release made it on PostgreSQL: every column in the database's default collation, a
     * primary key, a unique index and a foreign key on the key columns, two rows.
     */
    async function defaultCollationTable(): Promise<void> {
      await db.schema
        .createTable('t_order')
        .addColumn('id', 'char(26)', (c) => c.notNull())
        .addColumn('k', 'varchar(191)', (c) => c.notNull())
        .addColumn('code', 'char(3)', (c) => c.notNull())
        .addColumn('day', 'char(10)', (c) => c.notNull())
        .addColumn('name', 'varchar(100)', (c) => c.notNull())
        .addPrimaryKeyConstraint('pk_t_order', ['id'])
        .execute();
      await db.schema.createIndex('uq_t_order_k').on('t_order').column('k').unique().execute();
      await db.schema
        .createTable('t_leaf')
        .addColumn('id', 'char(26)', (c) => c.notNull().primaryKey())
        .addColumn('tree_id', 'char(26)', (c) => c.notNull().references('t_order.id'))
        .execute();
      await db
        .insertInto('t_order')
        .values([
          { id: 'b'.repeat(26), k: 'b', code: 'IDR', day: '2026-01-01', name: 'second' },
          { id: 'B'.repeat(26), k: 'B', code: 'USD', day: '2026-01-02', name: 'first' },
        ])
        .execute();
      await db.insertInto('t_leaf').values({ id: 'L'.repeat(26), tree_id: 'b'.repeat(26) }).execute();
    }

    it.runIf(POSTGRES)('PostgreSQL: gives the key and token columns COLLATE "C", once; rows, keys and indexes stay', async () => {
      await defaultCollationTable();
      expect(await pgCollations('t_order')).toEqual({ id: 'default', k: 'default', code: 'default', day: 'default', name: 'default' });
      await ensureByteOrder(h.db, h.dialect, 't_order', ORDER_COLUMNS);
      expect(await pgCollations('t_order')).toEqual({ id: 'C', k: 'C', code: 'C', day: 'default', name: 'default' });
      expect((await catalogColumns('t_order')).map((c) => [c.name, c.type, c.notNull])).toEqual([
        ['id', 'char(26)', true],
        ['k', 'varchar(191)', true],
        ['code', 'char(3)', true],
        ['day', 'char(10)', true],
        ['name', 'varchar(100)', true],
      ]);
      expect(await indexNames('t_order')).toEqual(['pk_t_order', 'uq_t_order_k']);
      // Byte order now: 'B' (0x42) before 'b' (0x62), where en_US would put 'b' first.
      expect(await db.selectFrom('t_order').select('id').orderBy('id').execute()).toEqual([{ id: 'B'.repeat(26) }, { id: 'b'.repeat(26) }]);
      expect(await db.selectFrom('t_leaf').select('tree_id').execute()).toEqual([{ tree_id: 'b'.repeat(26) }]);
      const dup = await rejection(db.insertInto('t_order').values({ id: newId(), k: 'b', code: 'IDR', day: '2026-01-03', name: 'x' }).execute());
      expect(dup).toBeInstanceOf(Error);

      // Again: nothing left to alter, so only the catalog is read.
      const again = recorded();
      await ensureByteOrder(again.db, h.dialect, 't_order', ORDER_COLUMNS);
      expect(again.kinds.filter((k) => k !== 'RawNode' && k !== 'SelectQueryNode')).toEqual([]);
      expect(await pgCollations('t_order')).toEqual({ id: 'C', k: 'C', code: 'C', day: 'default', name: 'default' });
    });

    it.runIf(POSTGRES)('PostgreSQL: alters only the columns it is given, and accepts a transaction', async () => {
      await defaultCollationTable();
      await h.db.transaction().execute((trx) => ensureByteOrder(trx, h.dialect, 't_order', ORDER_COLUMNS.slice(1, 2)));
      expect(await pgCollations('t_order')).toEqual({ id: 'default', k: 'C', code: 'default', day: 'default', name: 'default' });
    });

    it.runIf(POSTGRES)('PostgreSQL: SCHEMA_CONFLICT for a missing table or column or another type, nothing altered', async () => {
      await defaultCollationTable();
      const cases: Array<[string, string, ReadonlyArray<{ name: string; kind: 'id' | 'key191' | 'char'; length?: number }>]> = [
        ['table_missing', 't_absent', [{ name: 'id', kind: 'id', length: 26 }]],
        ['column_missing', 't_order', [{ name: 'k', kind: 'key191', length: 191 }, { name: 'nope', kind: 'key191', length: 191 }]],
        ['column_type_mismatch', 't_order', [{ name: 'k', kind: 'key191', length: 191 }, { name: 'name', kind: 'key191', length: 191 }]],
        ['column_type_mismatch', 't_order', [{ name: 'code', kind: 'char', length: 4 }]],
      ];
      for (const [reason, table, columns] of cases) {
        const error = await rejection(ensureByteOrder(h.db, h.dialect, table, columns));
        expect({ reason, error: domainCode(error) }).toEqual({ reason, error: { code: 'SCHEMA_CONFLICT', reason } });
      }
      expect(await pgCollations('t_order')).toEqual({ id: 'default', k: 'default', code: 'default', day: 'default', name: 'default' });
    });

    it.skipIf(POSTGRES)('MySQL/MariaDB and SQLite: sends nothing (key columns are utf8mb4_bin from their creation; SQLite is BINARY)', async () => {
      const run = recorded();
      await ensureByteOrder(run.db, h.dialect, 't_absent', ORDER_COLUMNS);
      expect(run.kinds).toEqual([]);
    });

    it.each([
      ['an invalid table name', 'T_order', ORDER_COLUMNS],
      ['an invalid column name', 't_order', [{ name: 'Id', kind: 'id', length: 26 }]],
      ['a char() column without a valid length', 't_order', [{ name: 'code', kind: 'char', length: 0 }]],
      ['an unknown kind', 't_order', [{ name: 'id', kind: 'uuid' }]],
    ])('refuses %s with a TypeError on every dialect, before touching the database', async (_name, table, columns) => {
      const run = recorded();
      await expect(ensureByteOrder(run.db, h.dialect, table, columns as typeof ORDER_COLUMNS)).rejects.toThrow(TypeError);
      await expect(ensureByteOrder(run.db, 'oracle' as Dialect, 't_order', ORDER_COLUMNS)).rejects.toThrow(TypeError);
      expect(run.kinds).toEqual([]);
    });
  });

  describe('dropRegisteredTables', () => {
    /** b <- a <- c: both alphabetical orders would drop a referenced table first. */
    async function fkChain(): Promise<void> {
      await ensureTable(h.db, h.dialect, 't_fk_b', 'data', 'test', (t) => t.id());
      await ensureTable(h.db, h.dialect, 't_fk_a', 'data', 'test', (t) => {
        t.id();
        t.ulid('b_id');
        t.foreignKey('b_id', 't_fk_b', 'id', { onDelete: 'restrict' });
      });
      await ensureTable(h.db, h.dialect, 't_fk_c', 'data', 'test', (t) => {
        t.id();
        t.ulid('a_id');
        t.foreignKey('a_id', 't_fk_a', 'id', { onDelete: 'restrict' });
      });
      const b = newId();
      const a = newId();
      await db.insertInto('t_fk_b').values({ id: b }).execute();
      await db.insertInto('t_fk_a').values({ id: a, b_id: b }).execute();
      await db.insertInto('t_fk_c').values({ id: newId(), a_id: a }).execute();
    }

    /** t_tree references itself (C -> B -> A) and t_leaf references t_tree, all RESTRICT, all with rows. */
    async function selfReferencingTree(): Promise<void> {
      await ensureTable(h.db, h.dialect, 't_tree', 'data', 'test', (t) => {
        t.id();
        t.ulid('parent_id').nullable();
        t.foreignKey('parent_id', 't_tree', 'id', { onDelete: 'restrict' });
      });
      await ensureTable(h.db, h.dialect, 't_leaf', 'data', 'test', (t) => {
        t.id();
        t.ulid('tree_id');
        t.foreignKey('tree_id', 't_tree', 'id', { onDelete: 'restrict' });
      });
      const [a, b, c] = [newId(), newId(), newId()];
      await db.insertInto('t_tree').values({ id: a, parent_id: null }).execute();
      await db.insertInto('t_tree').values({ id: b, parent_id: a }).execute();
      await db.insertInto('t_tree').values({ id: c, parent_id: b }).execute();
      await db.insertInto('t_leaf').values([{ id: newId(), tree_id: a }, { id: newId(), tree_id: c }]).execute();
      await expect(db.deleteFrom('t_tree').where('id', '=', a).execute()).rejects.toThrow(); // RESTRICT is live
    }

    it('drops a self-referencing RESTRICT table with rows (and its RESTRICT children), then foreign keys still work', async () => {
      await selfReferencingTree();
      await dropRegisteredTables(h.db, h.dialect);
      expect(await tableNames()).toEqual([]);
      // Foreign keys are enforced again afterwards (SQLite turned them off for the drops only).
      await ensureBootstrap(h.db, h.dialect);
      await ensureTable(h.db, h.dialect, 't_parent', 'data', 'test', (t) => t.id());
      await ensureTable(h.db, h.dialect, 't_owned', 'data', 'test', (t) => {
        t.id();
        t.ulid('parent_id');
        t.foreignKey('parent_id', 't_parent', 'id', { onDelete: 'cascade' });
      });
      await expect(db.insertInto('t_owned').values({ id: newId(), parent_id: newId() }).execute()).rejects.toThrow();
      if (h.dialect === 'sqlite') {
        const { rows } = await sql<{ foreign_keys: number }>`PRAGMA foreign_keys`.execute(h.db);
        expect(rows).toEqual([{ foreign_keys: 1 }]);
      }
    });

    it.runIf(ctx.engine === 'sqlite')('SQLite: refuses to run inside a transaction, dropping nothing', async () => {
      await selfReferencingTree();
      const error = await rejection(h.db.transaction().execute((trx) => dropRegisteredTables(trx, h.dialect)));
      expect(domainCode(error)).toEqual({ code: 'SCHEMA_CONFLICT', reason: 'sqlite_transaction' });
      expect(await tableNames()).toEqual(['schema_meta', 'schema_tables', 't_leaf', 't_tree']);
    });

    it.runIf(ctx.engine === 'sqlite')(
      'SQLite: refuses a transaction begun outside Kysely (pragma read-back), dropping nothing',
      async () => {
        await selfReferencingTree();
        const { error, inside } = await h.db.connection().execute(async (c) => {
          await sql`begin`.execute(c);
          try {
            const refused = await rejection(dropRegisteredTables(c, h.dialect));
            // Read before the rollback, which would undo any drop made inside the transaction.
            const names = (await c.introspection.getTables()).map((t) => t.name).sort();
            return { error: refused, inside: names };
          } finally {
            await sql`rollback`.execute(c);
          }
        });
        expect(domainCode(error)).toEqual({ code: 'SCHEMA_CONFLICT', reason: 'sqlite_transaction' });
        expect(inside).toEqual(['schema_meta', 'schema_tables', 't_leaf', 't_tree']);
        expect(await tableNames()).toEqual(['schema_meta', 'schema_tables', 't_leaf', 't_tree']);
        expect((await sql<{ foreign_keys: number }>`PRAGMA foreign_keys`.execute(h.db)).rows).toEqual([{ foreign_keys: 1 }]);
      },
    );

    it('refuses registered names that are not plain identifiers, dropping nothing', async () => {
      await ensureTable(h.db, h.dialect, 't_demo', 'data', 'test', demo);
      for (const name of ['a.b', 'T_Demo']) {
        await db.insertInto('schema_tables').values({ name, class: 'data', created_by: 'test' }).execute();
        const error = await rejection(dropRegisteredTables(h.db, h.dialect));
        expect(domainCode(error)).toEqual({ code: 'SCHEMA_CONFLICT', reason: 'invalid_registered_name' });
        expect(isDomainError(error) && error.meta).toMatchObject({ tables: [name] });
        expect(await tableNames()).toEqual(['schema_meta', 'schema_tables', 't_demo']);
        await db.deleteFrom('schema_tables').where('name', '=', name).execute();
      }
    });

    it('refuses registered tables whose foreign keys form a cycle, dropping nothing', async () => {
      // Built by hand: the helpers cannot make a cycle (a foreign key needs its target to exist).
      const fk = (name: string, column: string, target: string) =>
        sql`constraint ${sql.id(name)} foreign key (${sql.id(column)}) references ${sql.id(target)} (${sql.id('id')})`;
      const options = mysqlFamily() ? sql`engine=InnoDB default charset=utf8mb4 collate=utf8mb4_unicode_ci` : sql``;
      if (h.dialect === 'sqlite') {
        // SQLite accepts a reference to a table that does not exist yet.
        await sql`create table t_cyc_a (id char(26) primary key, b_id char(26), ${fk('fk_cyc_a', 'b_id', 't_cyc_b')})`.execute(h.db);
        await sql`create table t_cyc_b (id char(26) primary key, a_id char(26), ${fk('fk_cyc_b', 'a_id', 't_cyc_a')})`.execute(h.db);
      } else {
        await sql`create table t_cyc_a (id char(26) primary key, b_id char(26)) ${options}`.execute(h.db);
        await sql`create table t_cyc_b (id char(26) primary key, a_id char(26), ${fk('fk_cyc_b', 'a_id', 't_cyc_a')}) ${options}`.execute(h.db);
        await sql`alter table t_cyc_a add ${fk('fk_cyc_a', 'b_id', 't_cyc_b')}`.execute(h.db);
      }
      await db.insertInto('schema_tables').values([
        { name: 't_cyc_a', class: 'data', created_by: 'test' },
        { name: 't_cyc_b', class: 'data', created_by: 'test' },
      ]).execute();
      const error = await rejection(dropRegisteredTables(h.db, h.dialect));
      expect(domainCode(error)).toEqual({ code: 'SCHEMA_CONFLICT', reason: 'foreign_key_cycle' });
      expect(isDomainError(error) && error.meta).toMatchObject({ tables: ['t_cyc_a', 't_cyc_b'] });
      expect(await tableNames()).toEqual(['schema_meta', 'schema_tables', 't_cyc_a', 't_cyc_b']);
      expect(await registry()).toHaveLength(4);
    });

    it('removes t_demo and its schema_tables row', async () => {
      await ensureTable(h.db, h.dialect, 't_demo', 'data', 'test', demo);
      await dropRegisteredTables(h.db, h.dialect);
      expect(await tableNames()).not.toContain('t_demo');
      await ensureBootstrap(h.db, h.dialect);
      expect((await registry()).map((r) => r.name)).toEqual(['schema_meta', 'schema_tables']);
    });

    it('drops children before parents (order from the catalog) and leaves unregistered tables alone', async () => {
      await fkChain();
      await h.db.schema.createTable('t_keep').addColumn('id', 'integer', (c) => c.primaryKey()).execute();
      await dropRegisteredTables(h.db, h.dialect);
      // Everything registered is gone, the registry and schema_meta included (spec §9.10 step 6: the migrator
      // tables are rebuilt by the migrations); the unregistered table stays.
      expect(await tableNames()).toEqual(['t_keep']);
    });

    it('deletes the schema_tables rows of registered tables that do not exist, and is a no-op without schema_tables', async () => {
      await ensureTable(h.db, h.dialect, 't_demo', 'data', 'test', demo);
      await db.insertInto('schema_tables').values({ name: 't_ghost', class: 'data', created_by: 'test' }).execute();
      await dropRegisteredTables(h.db, h.dialect);
      expect(await tableNames()).toEqual([]);
      await dropRegisteredTables(h.db, h.dialect); // nothing left: resolves
    });

    it('can resume after a partial run (registry kept, some tables already dropped)', async () => {
      await fkChain();
      await h.db.schema.dropTable('t_fk_c').execute(); // as if a previous run stopped after this drop
      await dropRegisteredTables(h.db, h.dialect);
      expect(await tableNames()).toEqual([]);
    });

    it('keeps schema_tables (without the dropped rows, ghost rows included) when it is not registered itself', async () => {
      await ensureTable(h.db, h.dialect, 't_demo', 'data', 'test', demo);
      await db.deleteFrom('schema_tables').where('name', '=', 'schema_tables').execute();
      await db.insertInto('schema_tables').values({ name: 't_ghost', class: 'data', created_by: 'test' }).execute();
      await dropRegisteredTables(h.db, h.dialect);
      expect(await tableNames()).toEqual(['schema_tables']);
      expect(await registry()).toEqual([]);
    });

    it('refuses, dropping nothing, when an unregistered table references a registered one', async () => {
      await ensureTable(h.db, h.dialect, 't_parent', 'data', 'test', (t) => t.id());
      await h.db.schema
        .createTable('t_foreign')
        .addColumn('id', 'integer', (c) => c.primaryKey())
        // MySQL: a referencing column needs the referenced column's collation (id() is utf8mb4_bin, R17).
        .addColumn('parent_id', 'char(26)', (c) => (mysqlFamily() ? c.modifyFront(sql`character set utf8mb4 collate utf8mb4_bin`) : c))
        .addForeignKeyConstraint('fk_t_foreign_parent', ['parent_id'], 't_parent', ['id'])
        .$call((b) => (mysqlFamily() ? b.modifyEnd(sql`engine=InnoDB default charset=utf8mb4 collate=utf8mb4_unicode_ci`) : b))
        .execute();
      const error = await rejection(dropRegisteredTables(h.db, h.dialect));
      expect(domainCode(error)).toEqual({ code: 'SCHEMA_CONFLICT', reason: 'unregistered_dependent' });
      expect(isDomainError(error) && error.meta).toMatchObject({ tables: ['t_foreign'] });
      expect(await tableNames()).toEqual(['schema_meta', 'schema_tables', 't_foreign', 't_parent']);
      expect(await registry()).toHaveLength(3);
    });
  });
});
