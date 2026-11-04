import fsp from 'node:fs/promises';
import os from 'node:os';
import path from 'node:path';
import { sql } from 'kysely';
import { afterAll, beforeAll, beforeEach, describe, expect, it } from 'vitest';
import { emptyDatabase, engineLabel, testDb, testDbContext, type TestDbHandle } from '../../../tools/test/test-db.js';
import { readKeyedBatch } from '../src/batches.js';
import { readSchemaTableEntries, readSchemaTables, readTableColumns, readTableKeys, type CatalogFamily } from '../src/catalog.js';
import { TABLE_COLUMNS, TABLE_KEYS, type ColumnSpec } from '../src/columns.js';
import { ensureColumn, ensureTable } from '../src/ddl.js';
import { releaseMigrations } from '../src/migrations/index.js';
import { runMigrations } from '../src/migrator.js';
import { TABLE_CLASSES, type TableName } from '../src/registry.js';
import { listCatalogTables } from '../src/server-check.js';

// listCatalogTables (Task 15, ruling R55): what the installer's empty-database check sees, against the engine picked
// by ALTIS_TEST_DB.

const ctx = testDbContext();

describe.skipIf(!ctx.available)(`listCatalogTables [${engineLabel()}]`, () => {
  let h: TestDbHandle;

  beforeAll(async () => {
    h = await testDb();
  });

  afterAll(async () => {
    if (h === undefined) return;
    if (h.dialect === 'postgres') await sql`DROP SCHEMA IF EXISTS altis_other_schema CASCADE`.execute(h.db);
    await emptyDatabase(h);
    await h.close();
  });

  beforeEach(async () => {
    await emptyDatabase(h);
  });

  it('lists nothing in an empty database', async () => {
    expect(await listCatalogTables(h)).toEqual([]);
  });

  it('lists the tables and views of the current database, sorted', async () => {
    await h.db.schema.createTable('t_zeta').addColumn('id', 'integer').execute();
    await h.db.schema.createTable('staff_users').addColumn('id', 'integer').execute();
    await h.db.schema.createView('v_alpha').as(h.db.selectFrom('t_zeta' as never).selectAll()).execute();
    expect(await listCatalogTables(h)).toEqual(['staff_users', 't_zeta', 'v_alpha']);
  });

  it.runIf(ctx.engine === 'sqlite')('leaves out SQLite internal tables (sqlite_sequence)', async () => {
    await sql`CREATE TABLE t_auto (id INTEGER PRIMARY KEY AUTOINCREMENT, x TEXT)`.execute(h.db);
    await sql`INSERT INTO t_auto (x) VALUES ('a')`.execute(h.db);
    const internal = await sql<{ n: number }>`SELECT count(*) AS n FROM sqlite_master WHERE name = 'sqlite_sequence'`.execute(h.db);
    expect(Number(internal.rows[0]?.n)).toBe(1);
    expect(await listCatalogTables(h)).toEqual(['t_auto']);
  });

  it.runIf(ctx.engine.startsWith('pg'))('looks at current_schema() only, and counts a sequence', async () => {
    await sql`CREATE SCHEMA IF NOT EXISTS altis_other_schema`.execute(h.db);
    await sql`CREATE TABLE altis_other_schema.t_elsewhere (id integer)`.execute(h.db);
    expect(await listCatalogTables(h)).toEqual([]);
    await sql`CREATE SEQUENCE s_lonely`.execute(h.db);
    expect(await listCatalogTables(h)).toEqual(['s_lonely']);
    await sql`DROP SEQUENCE s_lonely`.execute(h.db);
  });
});

// The catalog as the generic exporter reads it (1d Task 6, spec §9.8 row 3 `schemaHold`; preflight M1): the tables
// `schema_tables` records, and each table's columns and keys from the database's own catalog (information_schema on
// MySQL/MariaDB, pg_attribute/pg_index/pg_constraint on PostgreSQL, PRAGMA table_info/foreign_key_list on SQLite),
// never from the code's registry. After every migration of the registry (the test builds' fixture level 3, so that
// `test_fixture` exists too) the catalog must describe every table as the registry does.

/**
 * The family the catalog gives a column of kind `c.kind`: the integer kinds `integer`; a character column `binary`
 * when it compares in byte order by its own collation (the R17 key kinds: utf8mb4_bin on MySQL/MariaDB, "C" on
 * PostgreSQL; every character column on SQLite, whose default collation is BINARY), `text` otherwise.
 */
function familyOf(c: ColumnSpec, dialect: TestDbHandle['dialect']): CatalogFamily {
  if (['serial', 'bool', 'money', 'timestamp', 'smallint', 'int', 'bigint'].includes(c.kind)) return 'integer';
  if (dialect === 'sqlite') return 'binary';
  return ['id', 'ulid', 'char', 'key191'].includes(c.kind) ? 'binary' : 'text';
}

describe.skipIf(!ctx.available)(`the catalog of the generic exporter [${engineLabel()}]`, () => {
  let h: TestDbHandle;
  let dataDir: string;
  const tables = Object.keys(TABLE_CLASSES) as TableName[];

  beforeAll(async () => {
    h = await testDb();
    dataDir = await fsp.mkdtemp(path.join(os.tmpdir(), 'altis-catalog-'));
    // Every table the registry describes, the test builds' `test_fixture` (decision D1d-26) included: fixture level 3.
    await runMigrations(h, { appVersion: '0.3.0-test', dataDir, migrations: releaseMigrations(3) });
  });

  afterAll(async () => {
    if (h !== undefined) {
      await emptyDatabase(h);
      await h.close();
    }
    if (dataDir !== undefined) await fsp.rm(dataDir, { recursive: true, force: true });
  });

  it('readSchemaTables: the names schema_tables records, sorted; a table made by ensureTable joins them', async () => {
    expect(await readSchemaTables(h.db)).toEqual([...tables].sort());
    await ensureTable(h.db, h.dialect, 't_catalog_extra', 'data', 'test', (t) => t.id());
    expect(await readSchemaTables(h.db)).toEqual([...tables, 't_catalog_extra'].sort());
    expect(await readSchemaTableEntries(h.db)).toContainEqual({ name: 't_catalog_extra', class: 'data' });
    expect((await readSchemaTableEntries(h.db)).find((e) => e.name === 'audit_log')).toEqual({ name: 'audit_log', class: 'history' });
  });

  it('readTableColumns: every table as TABLE_COLUMNS describes it (order, family, length, nullability)', async () => {
    for (const table of tables) {
      const expected = TABLE_COLUMNS[table].map((c) => ({
        name: c.name,
        family: familyOf(c, h.dialect),
        nullable: c.nullable,
        length: c.length ?? null,
      }));
      expect({ table, columns: await readTableColumns(h.db, h.dialect, table) }).toEqual({ table, columns: expected });
    }
  });

  it('readTableKeys: the primary key and the foreign keys of every table equal TABLE_KEYS', async () => {
    for (const table of tables) {
      const keys = await readTableKeys(h.db, h.dialect, table);
      expect({ table, pk: keys.pk }).toEqual({ table, pk: [...TABLE_KEYS[table].pk] });
      const fks = [...keys.fks].sort((a, b) => a.column.localeCompare(b.column));
      expect({ table, fks }).toEqual({ table, fks: TABLE_KEYS[table].fks.map((f) => ({ ...f })).sort((a, b) => a.column.localeCompare(b.column)) });
    }
  });

  it('a table made by ensureTable, a column ensureColumn adds last, a composite key and a foreign key', async () => {
    await ensureTable(h.db, h.dialect, 't_catalog_parent', 'data', 'test', (t) => t.serial('seq'));
    await ensureTable(h.db, h.dialect, 't_catalog_kinds', 'config', 'test', (t) => {
      t.key191('k');
      t.bigint('parent_seq');
      t.date('day').nullable();
      t.json('doc').nullable();
      t.varchar('label', 40);
      t.char('code', 3);
      t.bool('flag');
      t.primaryKey(['k', 'parent_seq']);
      t.foreignKey('parent_seq', 't_catalog_parent', 'seq', { onDelete: 'cascade' });
    });
    await ensureColumn(h.db, h.dialect, 't_catalog_kinds', (t) => t.text('note').nullable());
    const text = h.dialect === 'sqlite' ? 'binary' : 'text';
    expect(await readTableColumns(h.db, h.dialect, 't_catalog_kinds')).toEqual([
      { name: 'k', family: 'binary', nullable: false, length: 191 },
      { name: 'parent_seq', family: 'integer', nullable: false, length: null },
      { name: 'day', family: text, nullable: true, length: 10 },
      { name: 'doc', family: text, nullable: true, length: null },
      { name: 'label', family: text, nullable: false, length: 40 },
      { name: 'code', family: 'binary', nullable: false, length: 3 },
      { name: 'flag', family: 'integer', nullable: false, length: null },
      { name: 'note', family: text, nullable: true, length: null },
    ]);
    expect(await readTableColumns(h.db, h.dialect, 't_catalog_parent')).toEqual([{ name: 'seq', family: 'integer', nullable: false, length: null }]);
    expect(await readTableKeys(h.db, h.dialect, 't_catalog_kinds')).toEqual({
      pk: ['k', 'parent_seq'],
      fks: [{ column: 'parent_seq', table: 't_catalog_parent', refColumn: 'seq' }],
    });
    expect(await readTableKeys(h.db, h.dialect, 't_catalog_parent')).toEqual({ pk: ['seq'], fks: [] });
  });

  it('readKeyedBatch: a table the registry does not know, batch after batch in byte order of its composite key', async () => {
    await ensureTable(h.db, h.dialect, 't_catalog_keyed', 'data', 'test', (t) => {
      t.key191('k');
      t.int('n');
      t.text('body').nullable();
      t.primaryKey(['k', 'n']);
    });
    for (const [k, n] of [['b', 2], ['B', 1], ['é', 1], ['a', 3], ['b', 1]] as const) {
      await sql`INSERT INTO t_catalog_keyed (k, n, body) VALUES (${k}, ${n}, ${`${k}${n}`})`.execute(h.db);
    }
    const col = (name: string, kind: ColumnSpec['kind'], nullable = false): ColumnSpec => ({ name, kind, nullable, since: 'test' });
    const spec = { columns: [col('k', 'key191'), col('n', 'int'), col('body', 'text', true)], pk: ['k', 'n'] };
    const seen: unknown[] = [];
    let after: (string | number)[] | null = null;
    for (;;) {
      const batch = await readKeyedBatch(h.db, h.dialect, 't_catalog_keyed', spec, { after, limit: 2 });
      seen.push(...batch.map((r) => [r['k'], Number(r['n']), r['body']]));
      const last = batch.at(-1);
      if (batch.length < 2 || last === undefined) break;
      after = [String(last['k']), Number(last['n'])];
    }
    expect(seen).toEqual([
      ['B', 1, 'B1'],
      ['a', 3, 'a3'],
      ['b', 1, 'b1'],
      ['b', 2, 'b2'],
      ['é', 1, 'é1'],
    ]);
    const only = await readKeyedBatch(h.db, h.dialect, 't_catalog_keyed', spec, { after: ['b', 1], limit: 10, columns: ['k', 'n'] });
    expect(only.map((r) => ({ ...r, n: Number(r['n']) }))).toEqual([
      { k: 'b', n: 2 },
      { k: 'é', n: 1 },
    ]);
    const refused = [
      () => readKeyedBatch(h.db, h.dialect, 'Bad Name', spec, { after: null, limit: 1 }),
      () => readKeyedBatch(h.db, h.dialect, 't_catalog_keyed', { ...spec, pk: [] }, { after: null, limit: 1 }),
      () => readKeyedBatch(h.db, h.dialect, 't_catalog_keyed', { ...spec, pk: ['nope'] }, { after: null, limit: 1 }),
      () => readKeyedBatch(h.db, h.dialect, 't_catalog_keyed', { ...spec, columns: [...spec.columns, col('k', 'text')] }, { after: null, limit: 1 }),
      () => readKeyedBatch(h.db, h.dialect, 't_catalog_keyed', spec, { after: ['b'], limit: 1 }),
      () => readKeyedBatch(h.db, h.dialect, 't_catalog_keyed', spec, { after: null, limit: 1, columns: ['body'] }),
    ];
    for (const call of refused) await expect(call()).rejects.toBeInstanceOf(TypeError);
  });

  it('native types ALTIS does not create: boolean, decimal, date (json where native); a type outside the families is refused', async () => {
    if (h.dialect === 'sqlite') {
      await sql`CREATE TABLE t_native (a BOOLEAN NOT NULL, b DECIMAL(10,2), c JSON, d DATE, f DATETIME)`.execute(h.db);
      await sql`CREATE TABLE t_odd (id INTEGER PRIMARY KEY, g BLOB)`.execute(h.db);
    } else if (h.dialect === 'postgres') {
      await sql`CREATE TABLE t_native (a boolean NOT NULL, b numeric(10,2), c jsonb, d date, f timestamp)`.execute(h.db);
      await sql`CREATE TABLE t_odd (id integer PRIMARY KEY, g bytea)`.execute(h.db);
    } else {
      // MariaDB's JSON is LONGTEXT (a text column), so the MySQL family gets a second date column instead.
      await sql`CREATE TABLE t_native (a tinyint(1) NOT NULL, b decimal(10,2), c date, d date, f datetime)`.execute(h.db);
      await sql`CREATE TABLE t_odd (id int PRIMARY KEY, g blob)`.execute(h.db);
    }
    const third = h.dialect === 'sqlite' || h.dialect === 'postgres' ? 'json' : 'date';
    expect(await readTableColumns(h.db, h.dialect, 't_native')).toEqual([
      { name: 'a', family: 'boolean', nullable: false, length: null },
      { name: 'b', family: 'decimal', nullable: true, length: null },
      { name: 'c', family: third, nullable: true, length: null },
      { name: 'd', family: 'date', nullable: true, length: null },
      { name: 'f', family: 'date', nullable: true, length: null },
    ]);
    await expect(readTableColumns(h.db, h.dialect, 't_odd')).rejects.toThrow(/t_odd\.g/);
    await expect(readTableColumns(h.db, h.dialect, 't_odd')).rejects.toBeInstanceOf(TypeError);
  });

  it('floating-point types are refused at catalog time (ruling R1d-3): a backup has no canonical form for them', async () => {
    // Drivers return FLOAT/DOUBLE/REAL as JS numbers that the canonical `text` kind would refuse mid-export; the catalog
    // names the column before any part is written instead.
    if (h.dialect === 'sqlite') {
      await sql`CREATE TABLE t_float_0 (id INTEGER PRIMARY KEY, e REAL)`.execute(h.db);
      await sql`CREATE TABLE t_float_1 (id INTEGER PRIMARY KEY, e FLOAT)`.execute(h.db);
      await sql`CREATE TABLE t_float_2 (id INTEGER PRIMARY KEY, e DOUBLE PRECISION)`.execute(h.db);
    } else if (h.dialect === 'postgres') {
      await sql`CREATE TABLE t_float_0 (id integer PRIMARY KEY, e real)`.execute(h.db);
      await sql`CREATE TABLE t_float_1 (id integer PRIMARY KEY, e float8)`.execute(h.db);
      await sql`CREATE TABLE t_float_2 (id integer PRIMARY KEY, e double precision)`.execute(h.db);
    } else {
      await sql`CREATE TABLE t_float_0 (id int PRIMARY KEY, e float)`.execute(h.db);
      await sql`CREATE TABLE t_float_1 (id int PRIMARY KEY, e double)`.execute(h.db);
      await sql`CREATE TABLE t_float_2 (id int PRIMARY KEY, e real)`.execute(h.db);
    }
    for (const table of ['t_float_0', 't_float_1', 't_float_2']) {
      await expect(readTableColumns(h.db, h.dialect, table), table).rejects.toThrow(new RegExp(`${table}\\.e`));
      await expect(readTableColumns(h.db, h.dialect, table), table).rejects.toBeInstanceOf(TypeError);
    }
  });

  it('a table that does not exist has no columns and no keys; a bad name or dialect is refused', async () => {
    expect(await readTableColumns(h.db, h.dialect, 't_catalog_missing')).toEqual([]);
    expect(await readTableKeys(h.db, h.dialect, 't_catalog_missing')).toEqual({ pk: [], fks: [] });
    await expect(readTableColumns(h.db, h.dialect, 'Bad Name')).rejects.toBeInstanceOf(TypeError);
    await expect(readTableKeys(h.db, 'oracle' as never, 'branches')).rejects.toBeInstanceOf(TypeError);
  });
});
