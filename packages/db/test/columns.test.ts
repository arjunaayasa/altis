import fsp from 'node:fs/promises';
import os from 'node:os';
import path from 'node:path';
import {
  DataTypeNode,
  DummyDriver,
  Kysely,
  PostgresAdapter,
  PostgresIntrospector,
  PostgresQueryCompiler,
  sql,
  type ColumnDataType,
  type CompiledQuery,
  type DatabaseConnection,
} from 'kysely';
import { afterAll, beforeAll, describe, expect, it, vi } from 'vitest';
import { emptyDatabase, engineLabel, testDb, testDbContext, type TestDbHandle } from '../../../tools/test/test-db.js';
import { RUNNER_TABLES_SINCE, TABLE_COLUMNS, TABLE_KEYS, columnsAt, type ColumnSpec } from '../src/columns.js';
import { EDITION_MIGRATOR_TABLES } from '../src/edition-migrations.js';
import { FULLTEXT_DIALECT_OBJECTS } from '../src/fulltext.js';
import { PHASE1_MIGRATIONS, releaseMigrations } from '../src/migrations/index.js';
import { runMigrations } from '../src/migrator.js';
import { migrationsUpTo } from '../src/order.js';
import { TABLE_CLASSES, type TableName } from '../src/registry.js';
// ---- Komunitas K1 (tables) ----
import { K1_TABLES_BY_MIGRATION } from './fixtures/komunitas-k1-tables.js';

// The column registry (decision C11) against the live catalog: the drift test. TABLE_COLUMNS and TABLE_KEYS are
// written by hand; this keeps them honest on the engine picked by ALTIS_TEST_DB (default sqlite), after every
// migration (so `since` is checked too), not only after the last one. Under the test profile the registry also holds
// the fixture table `test_fixture` (decision D1d-26), made by 9001_test_expand and widened by 9002_test_contract: the
// drift test runs every fixture level (1: the last release migration, 2: 9001, 3: 9002) and compares the catalog with columnsAt(table,
// <last applied>), which is [] for a table not made yet.

const ctx = testDbContext();
const TABLES = Object.keys(TABLE_CLASSES) as TableName[];
/** Every migration of every fixture level, in order (level 3 is the union). */
const MIGRATIONS = Object.keys(releaseMigrations(3)).sort();
/** The last migration of the release (fixture level 1), by name, never named here (Phase 2 and later phases add theirs). */
const RELEASE_LAST = Object.keys(PHASE1_MIGRATIONS).sort().at(-1) as string;
/** The test-only fixture table (not a table of `DB`). */
const FIXTURE = 'test_fixture' as TableName;

/**
 * The catalog type of a column of kind `kind`, in ddl.ts's canonical spelling (`serial` reads `bigint auto`). Written
 * here independently of ddl.ts so that a wrong `kind` or `length` in the registry shows.
 */
function catalogType(c: ColumnSpec): string {
  switch (c.kind) {
    case 'id':
    case 'ulid':
    case 'char':
    case 'date':
      return `char(${String(c.length)})`;
    case 'key191':
    case 'varchar':
      return `varchar(${String(c.length)})`;
    case 'text':
    case 'json':
      return 'text';
    case 'bool':
    case 'smallint':
      return 'smallint';
    case 'int':
      return 'integer';
    case 'bigint':
    case 'timestamp':
    case 'money':
      return 'bigint';
    case 'serial':
      return 'bigint auto';
  }
}

/** MySQL/MariaDB collation of a column of kind `kind` (R17: the key and token kinds are binary). */
function mysqlCollation(c: ColumnSpec): string | null {
  if (c.kind === 'id' || c.kind === 'ulid' || c.kind === 'char' || c.kind === 'key191') return 'utf8mb4_bin';
  if (c.kind === 'date' || c.kind === 'varchar' || c.kind === 'text' || c.kind === 'json') return 'utf8mb4_unicode_ci';
  return null;
}

/**
 * PostgreSQL collation of a column of kind `kind`: the key and token kinds compare in byte order (`C`, the
 * counterpart of R17), the others in the database's default; null for numbers.
 */
function pgCollation(c: ColumnSpec): string | null {
  if (c.kind === 'id' || c.kind === 'ulid' || c.kind === 'char' || c.kind === 'key191') return 'C';
  if (c.kind === 'date' || c.kind === 'varchar' || c.kind === 'text' || c.kind === 'json') return 'default';
  return null;
}

/** The migration before 0009, which the PostgreSQL collation case installs first. */
const BEFORE_0009 = '0008_access_indexes';

/**
 * The key and token columns the PostgreSQL collation case turns back to the database's default collation, as an
 * install of 0001–0008 made by an earlier build had them: the ones 0009 must convert to "C". The other migration
 * lane's runner tables are left out: they came after 0009, the runner makes them in "C" from the start, and 0009
 * (frozen) does not name them, so degrading them would describe no install that ever existed.
 */
function degradedBefore0009(): { table: TableName; column: string; type: ColumnDataType }[] {
  const later = new Set<string>(EDITION_MIGRATOR_TABLES);
  return TABLES.filter((table) => !later.has(table)).flatMap((table) =>
    columnsAt(table, BEFORE_0009)
      .filter((c) => pgCollation(c) === 'C')
      .map((c) => ({ table, column: c.name, type: catalogType(c) as ColumnDataType })),
  );
}

/**
 * A PostgreSQL Kysely without a server: every statement is recorded, and the catalog reads answer as an install of
 * 0001–0008 made in the database's default collation would (every table there, every key and token column of
 * `columnsAt(table, '0008…')` in collation "default"); any other read answers no row.
 */
function recordingPostgres(): { db: Kysely<unknown>; statements: CompiledQuery[] } {
  const statements: CompiledQuery[] = [];
  const answer = (q: CompiledQuery): unknown[] => {
    if (q.sql.includes('AS present FROM pg_catalog.pg_class')) return [{ present: 1 }];
    if (q.sql.includes('co.collname AS coll')) {
      return columnsAt(String(q.parameters[0]) as TableName, BEFORE_0009).map((c) => ({
        name: c.name,
        type: catalogType(c),
        coll: 'default',
        ns: 'pg_catalog',
      }));
    }
    return [];
  };
  const connection: DatabaseConnection = {
    executeQuery: <R>(q: CompiledQuery) => {
      statements.push(q);
      return Promise.resolve({ rows: answer(q) as R[] });
    },
    streamQuery: () => {
      throw new Error('not used here');
    },
  };
  class RecordingDriver extends DummyDriver {
    override acquireConnection(): Promise<DatabaseConnection> {
      return Promise.resolve(connection);
    }
  }
  const db = new Kysely<unknown>({
    dialect: {
      createAdapter: () => new PostgresAdapter(),
      createDriver: () => new RecordingDriver(),
      createIntrospector: (k) => new PostgresIntrospector(k),
      createQueryCompiler: () => new PostgresQueryCompiler(),
    },
  });
  return { db, statements };
}

/** A column as the drift test compares it: name, catalog type, nullability (and the collation on server dialects). */
interface CatalogColumn {
  name: string;
  type: string;
  nullable: boolean;
  collation?: string | null;
}

describe('the column registry (decision C11)', () => {
  it('describes exactly the tables of TABLE_CLASSES, in the same order, frozen', () => {
    expect(Object.keys(TABLE_COLUMNS)).toEqual(Object.keys(TABLE_CLASSES));
    expect(Object.keys(TABLE_KEYS)).toEqual(Object.keys(TABLE_CLASSES));
    expect(Object.isFrozen(TABLE_COLUMNS)).toBe(true);
    expect(Object.isFrozen(TABLE_KEYS)).toBe(true);
    for (const table of TABLES) {
      expect(Object.isFrozen(TABLE_COLUMNS[table])).toBe(true);
      for (const c of TABLE_COLUMNS[table]) expect(Object.isFrozen(c)).toBe(true);
      expect(Object.isFrozen(TABLE_KEYS[table].pk)).toBe(true);
    }
  });

  it('holds the fixture table test_fixture under the test profile only (D1d-26), columns `since` their migration', async () => {
    expect(TABLE_CLASSES[FIXTURE]).toBe('data');
    expect(TABLE_COLUMNS[FIXTURE]).toEqual([
      { name: 'id', kind: 'ulid', length: 26, nullable: false, since: '9001_test_expand' },
      { name: 'note', kind: 'varchar', length: 191, nullable: false, since: '9001_test_expand' },
      { name: 'created_at', kind: 'bigint', nullable: false, since: '9001_test_expand' },
      { name: 'extra', kind: 'varchar', length: 191, nullable: false, since: '9002_test_contract' },
    ]);
    expect(TABLE_KEYS[FIXTURE]).toEqual({ pk: ['id'], unique: [], fks: [] });
    expect(columnsAt(FIXTURE, RELEASE_LAST)).toEqual([]);
    expect(columnsAt(FIXTURE, '9001').map((c) => c.name)).toEqual(['id', 'note', 'created_at']);
    expect(columnsAt(FIXTURE, '9002_test_contract')).toEqual(TABLE_COLUMNS[FIXTURE]);

    // A production build drops it: the registries evaluated with __BUILD_PROFILE__ 'production'.
    vi.stubGlobal('__BUILD_PROFILE__', 'production');
    vi.resetModules();
    try {
      const registry = await import('../src/registry.js');
      const columns = await import('../src/columns.js');
      expect(Object.keys(registry.TABLE_CLASSES)).not.toContain('test_fixture');
      expect(Object.keys(columns.TABLE_COLUMNS)).not.toContain('test_fixture');
      expect(Object.keys(columns.TABLE_KEYS)).not.toContain('test_fixture');
      expect(Object.keys(registry.TABLE_CLASSES)).toEqual(TABLES.filter((t) => t !== FIXTURE));
    } finally {
      vi.unstubAllGlobals();
      vi.resetModules();
    }
  });

  it('gives every character kind its length and no other kind one', () => {
    const fixed: Partial<Record<ColumnSpec['kind'], number>> = { id: 26, ulid: 26, date: 10, key191: 191 };
    for (const table of TABLES) {
      for (const c of TABLE_COLUMNS[table]) {
        const where = `${table}.${c.name}`;
        if (c.kind === 'char' || c.kind === 'varchar') expect({ where, length: c.length }).toEqual({ where, length: expect.any(Number) });
        else expect({ where, length: c.length }).toEqual({ where, length: fixed[c.kind] });
      }
    }
  });

  it('names a known migration (or the runner) as `since`, and columns come in migration order', () => {
    for (const table of TABLES) {
      const since = TABLE_COLUMNS[table].map((c) => c.since);
      for (const s of since) expect([RUNNER_TABLES_SINCE, ...MIGRATIONS]).toContain(s);
      // A column added later comes last: the catalog appends it (ALTER TABLE ... ADD COLUMN).
      expect({ table, since }).toEqual({ table, since: [...since].sort() });
    }
  });

  it('keys name columns of their own table; foreign keys reference the primary key of a table', () => {
    for (const table of TABLES) {
      const names = TABLE_COLUMNS[table].map((c) => c.name);
      const { pk, unique, fks } = TABLE_KEYS[table];
      for (const c of [...pk, ...unique.flat(), ...fks.map((f) => f.column)]) expect({ table, c, in: names.includes(c) }).toEqual({ table, c, in: true });
      for (const f of fks) expect({ table, f, ref: TABLE_KEYS[f.table].pk }).toEqual({ table, f, ref: [f.refColumn] });
    }
  });

  it('columnsAt: the columns a table had once a migration had run', () => {
    expect(columnsAt('jobs', '0008_access_indexes').map((c) => c.name)).not.toContain('point_of_no_return');
    expect(columnsAt('jobs', '0009_ops_jobs').map((c) => c.name)).toContain('point_of_no_return');
    expect(columnsAt('jobs', '0009_ops_jobs')).toEqual(TABLE_COLUMNS.jobs);
    expect(columnsAt('jobs', '0008')).toEqual(TABLE_COLUMNS.jobs.slice(0, -1)); // a schema version as a manifest has it
    expect(columnsAt('jobs', '0004_settings_and_audit')).toEqual([]); // made by 0005
    expect(columnsAt('schema_meta', '0001_meta_and_locks')).toEqual(TABLE_COLUMNS.schema_meta);
    expect(() => columnsAt('jobs', 'latest')).toThrow(TypeError);
    expect(() => columnsAt('jobs', '9_x')).toThrow(TypeError);
    expect(() => columnsAt('nope' as TableName, '0009')).toThrow(TypeError);
  });

  it('the PostgreSQL collation case degrades exactly the key and token columns 0009 converts back to "C"', async () => {
    // Runs on every engine: the frozen 0009 against a recorded PostgreSQL, so a column the case degrades but 0009
    // never names (a runner table registered after 0009, for example) shows here, not only on a PostgreSQL run.
    const { db, statements } = recordingPostgres();
    await PHASE1_MIGRATIONS['0009_ops_jobs']!.up(db, 'postgres');
    const converted = statements
      .filter((q) => /^alter table /i.test(q.sql) && q.sql.includes('collate "C"'))
      .flatMap((q) => {
        const table = /^alter table "(\w+)"/i.exec(q.sql)?.[1];
        return [...q.sql.matchAll(/alter column "(\w+)" type /gi)].map((m) => `${String(table)}.${String(m[1])}`);
      });
    expect(converted.length).toBeGreaterThan(0);
    expect(new Set(converted).size).toBe(converted.length);
    expect(degradedBefore0009().map((b) => `${b.table}.${b.column}`).sort()).toEqual([...converted].sort());
  });
});

describe.skipIf(!ctx.available)(`the column registry against the catalog: drift test [${engineLabel()}]`, () => {
  let h: TestDbHandle;
  let dataDir: string;
  const mysqlFamily = () => h.dialect === 'mysql' || h.dialect === 'mariadb';

  beforeAll(async () => {
    h = await testDb();
    dataDir = await fsp.mkdtemp(path.join(os.tmpdir(), 'altis-columns-'));
  });

  afterAll(async () => {
    await h?.close();
    if (dataDir !== undefined) await fsp.rm(dataDir, { recursive: true, force: true });
  });

  /** The columns of `table` in catalog order; [] when the table does not exist. */
  async function catalogColumns(table: string): Promise<CatalogColumn[]> {
    if (mysqlFamily()) {
      const { rows } = await sql<{ name: string; dt: string; len: unknown; nullable: string; extra: string; coll: string | null }>`
        SELECT COLUMN_NAME AS name, DATA_TYPE AS dt, CHARACTER_MAXIMUM_LENGTH AS len, IS_NULLABLE AS nullable,
               EXTRA AS extra, COLLATION_NAME AS coll
        FROM information_schema.COLUMNS WHERE TABLE_SCHEMA = DATABASE() AND TABLE_NAME = ${table}
        ORDER BY ORDINAL_POSITION`.execute(h.db);
      return rows.map((r) => {
        const dt = String(r.dt).toLowerCase();
        const type = dt === 'char' || dt === 'varchar' ? `${dt}(${Number(r.len)})` : dt === 'int' ? 'integer' : dt;
        const auto = /auto_increment/i.test(r.extra);
        return { name: r.name, type: auto ? `${type} auto` : type, nullable: r.nullable === 'YES', collation: r.coll };
      });
    }
    if (h.dialect === 'postgres') {
      const { rows } = await sql<{ name: string; type: string; notnull: boolean; identity: string; coll: string | null }>`
        SELECT a.attname AS name, format_type(a.atttypid, a.atttypmod) AS type, a.attnotnull AS notnull,
               a.attidentity AS identity, co.collname AS coll
        FROM pg_attribute a LEFT JOIN pg_collation co ON co.oid = a.attcollation
        WHERE a.attrelid = to_regclass(format('%I.%I', current_schema(), ${table}::text)) AND a.attnum > 0
          AND NOT a.attisdropped
        ORDER BY a.attnum`.execute(h.db);
      return rows.map((r) => {
        const type = r.type.replace(/^character varying/, 'varchar').replace(/^character\b/, 'char');
        return { name: r.name, type: r.identity === '' ? type : `${type} auto`, nullable: !r.notnull, collation: r.coll };
      });
    }
    const { rows } = await sql<{ name: string; type: string; nn: number; pk: number }>`
      SELECT name, type, "notnull" AS nn, pk FROM pragma_table_info(${table}) ORDER BY cid`.execute(h.db);
    const ddl = await sql<{ sql: string }>`SELECT sql FROM sqlite_master WHERE type = 'table' AND name = ${table}`.execute(h.db);
    return rows.map((r) => {
      // serial(): INTEGER PRIMARY KEY AUTOINCREMENT, the rowid (never NULL).
      const auto = r.pk === 1 && r.type.toLowerCase() === 'integer' && /autoincrement/i.test(ddl.rows[0]?.sql ?? '');
      return { name: r.name, type: auto ? 'bigint auto' : r.type.toLowerCase(), nullable: r.nn === 0 && !auto };
    });
  }

  /** The registry's view of `columns`, in the shape of {@link catalogColumns}. */
  function expected(columns: readonly ColumnSpec[]): CatalogColumn[] {
    return columns.map((c) => ({
      name: c.name,
      type: catalogType(c),
      nullable: c.nullable,
      ...(mysqlFamily() ? { collation: mysqlCollation(c) } : h.dialect === 'postgres' ? { collation: pgCollation(c) } : {}),
    }));
  }

  async function primaryKey(table: string): Promise<string[]> {
    let q;
    if (mysqlFamily()) {
      q = sql<{ col: string }>`SELECT COLUMN_NAME AS col FROM information_schema.STATISTICS
        WHERE TABLE_SCHEMA = DATABASE() AND TABLE_NAME = ${table} AND INDEX_NAME = 'PRIMARY' ORDER BY SEQ_IN_INDEX`;
    } else if (h.dialect === 'postgres') {
      q = sql<{ col: string }>`SELECT a.attname AS col FROM pg_index ix
        CROSS JOIN LATERAL unnest(ix.indkey::int2[]) WITH ORDINALITY AS k(attnum, ord)
        JOIN pg_attribute a ON a.attrelid = ix.indrelid AND a.attnum = k.attnum
        WHERE ix.indrelid = to_regclass(format('%I.%I', current_schema(), ${table}::text)) AND ix.indisprimary
        ORDER BY k.ord`;
    } else {
      q = sql<{ col: string }>`SELECT name AS col FROM pragma_table_info(${table}) WHERE pk > 0 ORDER BY pk`;
    }
    return (await q.execute(h.db)).rows.map((r) => String(r.col));
  }

  /** Every UNIQUE index of `table` but the primary key, as its columns in index order, sorted. */
  async function uniqueKeys(table: string): Promise<string[][]> {
    let rows: Array<{ name: string; col: string }>;
    if (mysqlFamily()) {
      ({ rows } = await sql<{ name: string; col: string }>`
        SELECT INDEX_NAME AS name, COLUMN_NAME AS col FROM information_schema.STATISTICS
        WHERE TABLE_SCHEMA = DATABASE() AND TABLE_NAME = ${table} AND NON_UNIQUE = 0 AND INDEX_NAME <> 'PRIMARY'
        ORDER BY INDEX_NAME, SEQ_IN_INDEX`.execute(h.db));
    } else if (h.dialect === 'postgres') {
      ({ rows } = await sql<{ name: string; col: string }>`
        SELECT i.relname AS name, a.attname AS col
        FROM pg_index ix
        JOIN pg_class i ON i.oid = ix.indexrelid
        CROSS JOIN LATERAL unnest(ix.indkey::int2[]) WITH ORDINALITY AS k(attnum, ord)
        JOIN pg_attribute a ON a.attrelid = ix.indrelid AND a.attnum = k.attnum
        WHERE ix.indrelid = to_regclass(format('%I.%I', current_schema(), ${table}::text))
          AND ix.indisunique AND NOT ix.indisprimary
        ORDER BY i.relname, k.ord`.execute(h.db));
    } else {
      ({ rows } = await sql<{ name: string; col: string }>`
        SELECT il.name AS name, ii.name AS col
        FROM pragma_index_list(${table}) il JOIN pragma_index_info(il.name) ii
        WHERE il."unique" = 1 AND il.origin <> 'pk'
        ORDER BY il.name, ii.seqno`.execute(h.db));
    }
    const byName = new Map<string, string[]>();
    for (const r of rows) byName.set(String(r.name), [...(byName.get(String(r.name)) ?? []), String(r.col)]);
    return [...byName.values()].sort((a, b) => a.join(',').localeCompare(b.join(',')));
  }

  /** The foreign keys of `table`: column -> table(refColumn), sorted by column. */
  async function foreignKeys(table: string): Promise<Array<{ column: string; table: string; refColumn: string }>> {
    let rows: Array<{ column: string; table: string; refColumn: string }>;
    if (mysqlFamily()) {
      ({ rows } = await sql<{ column: string; table: string; refColumn: string }>`
        SELECT COLUMN_NAME AS "column", REFERENCED_TABLE_NAME AS "table", REFERENCED_COLUMN_NAME AS "refColumn"
        FROM information_schema.KEY_COLUMN_USAGE
        WHERE TABLE_SCHEMA = DATABASE() AND TABLE_NAME = ${table} AND REFERENCED_TABLE_NAME IS NOT NULL`.execute(h.db));
    } else if (h.dialect === 'postgres') {
      ({ rows } = await sql<{ column: string; table: string; refColumn: string }>`
        SELECT ca.attname AS "column", pa.relname AS "table", pca.attname AS "refColumn"
        FROM pg_constraint c
        JOIN pg_class pa ON pa.oid = c.confrelid
        JOIN pg_attribute ca ON ca.attrelid = c.conrelid AND ca.attnum = c.conkey[1]
        JOIN pg_attribute pca ON pca.attrelid = c.confrelid AND pca.attnum = c.confkey[1]
        WHERE c.contype = 'f' AND c.conrelid = to_regclass(format('%I.%I', current_schema(), ${table}::text))`.execute(h.db));
    } else {
      ({ rows } = await sql<{ column: string; table: string; refColumn: string }>`
        SELECT f."from" AS "column", f."table" AS "table", f."to" AS "refColumn"
        FROM pragma_foreign_key_list(${table}) f`.execute(h.db));
    }
    return rows.map((r) => ({ column: r.column, table: r.table, refColumn: r.refColumn })).sort((a, b) => a.column.localeCompare(b.column));
  }

  it('after each migration of every fixture level, every table has exactly columnsAt(table, migration): names in order, types, nullability', async () => {
    expect(MIGRATIONS.slice(-3)).toEqual([RELEASE_LAST, '9001_test_expand', '9002_test_contract']);
    for (const migration of MIGRATIONS) {
      const outcome = await runMigrations(h, { appVersion: '0.3.0-test', dataDir, migrations: migrationsUpTo(releaseMigrations(3), migration) });
      expect(outcome.applied).toEqual([migration]);
      for (const table of TABLES) {
        expect({ migration, table, columns: await catalogColumns(table) }).toEqual({
          migration,
          table,
          columns: expected(columnsAt(table, migration)),
        });
      }
    }
  });

  it('at each fixture level, the catalog is columnsAt(table, <last applied>); after level 3, TABLE_COLUMNS', async () => {
    const last: Record<1 | 2 | 3, string> = { 1: RELEASE_LAST, 2: '9001_test_expand', 3: '9002_test_contract' };
    const versions: Record<1 | 2 | 3, string> = { 1: '0.1.0-test', 2: '0.2.0-test', 3: '0.3.0-test' };
    for (const level of [1, 2, 3] as const) {
      await emptyDatabase(h);
      const outcome = await runMigrations(h, { appVersion: versions[level], dataDir, migrations: releaseMigrations(level) });
      expect(Object.keys(releaseMigrations(level)).sort().at(-1)).toBe(last[level]);
      expect(outcome.schemaVersion).toBe(last[level].slice(0, 4));
      for (const table of TABLES) {
        expect({ level, table, columns: await catalogColumns(table) }).toEqual({ level, table, columns: expected(columnsAt(table, last[level])) });
      }
    }
    for (const table of TABLES) {
      expect({ table, columns: await catalogColumns(table) }).toEqual({ table, columns: expected(TABLE_COLUMNS[table]) });
    }
  });

  // ---- Phase 2 (catalog): Task 1 ----
  it('the only tables of the catalog outside the registry are the dialect’s full-text objects (search_fts* on SQLite)', async () => {
    let names: string[];
    if (mysqlFamily()) {
      names = (
        await sql<{ name: string }>`SELECT TABLE_NAME AS name FROM information_schema.TABLES WHERE TABLE_SCHEMA = DATABASE()`.execute(h.db)
      ).rows.map((r) => String(r.name));
    } else if (h.dialect === 'postgres') {
      names = (
        await sql<{ name: string }>`SELECT c.relname AS name FROM pg_class c JOIN pg_namespace n ON n.oid = c.relnamespace
          WHERE n.nspname = current_schema() AND c.relkind IN ('r', 'p')`.execute(h.db)
      ).rows.map((r) => String(r.name));
    } else {
      names = (
        await sql<{ name: string }>`SELECT name FROM sqlite_master WHERE type = 'table' AND substr(name, 1, 7) <> 'sqlite_'`.execute(h.db)
      ).rows.map((r) => String(r.name));
    }
    const outside = names.filter((n) => !(TABLES as string[]).includes(n)).sort();
    expect(outside).toEqual([...FULLTEXT_DIALECT_OBJECTS[h.dialect]].sort());
    if (h.dialect === 'sqlite') expect(outside).toEqual(['search_fts', 'search_fts_config', 'search_fts_data', 'search_fts_docsize', 'search_fts_idx']);
    else expect(outside).toEqual([]);
  });

  it('Phase 2: the 27 tables of 0020–0025 match the catalog, and custom_field_defs ends with the three columns of 0026', async () => {
    // Made by a migration of Phase 2's migrations 0020–0029 (Komunitas K1 starts at 0030).
    const catalogTables = TABLES.filter((t) => {
      const since = TABLE_COLUMNS[t][0]?.since ?? '';
      return since >= '0020' && since < '0030';
    });
    expect(catalogTables).toHaveLength(27);
    for (const table of catalogTables) {
      expect({ table, columns: await catalogColumns(table) }).toEqual({ table, columns: expected(TABLE_COLUMNS[table]) });
    }
    const defs = TABLE_COLUMNS.custom_field_defs;
    expect(defs.slice(-3).map((c) => [c.name, c.since])).toEqual([
      ['label_en', '0026_custom_fields_i18n'],
      ['is_public', '0026_custom_fields_i18n'],
      ['is_searchable', '0026_custom_fields_i18n'],
    ]);
    expect((await catalogColumns('custom_field_defs')).slice(-3).map((c) => c.name)).toEqual(['label_en', 'is_public', 'is_searchable']);
  });

  // ---- Komunitas K1 (tables) ----
  it('Komunitas K1: the 14 tables of 0030–0032 and their keys match the catalog; records and items end with the columns of 0033', async () => {
    const k1Tables = TABLES.filter((t) => {
      const since = TABLE_COLUMNS[t][0]?.since ?? '';
      return since >= '0030' && since < '0040';
    });
    expect(k1Tables).toEqual(Object.values(K1_TABLES_BY_MIGRATION).flat());
    expect(k1Tables).toHaveLength(14);
    for (const table of k1Tables) {
      expect({ table, columns: await catalogColumns(table) }).toEqual({ table, columns: expected(TABLE_COLUMNS[table]) });
      const keys = TABLE_KEYS[table];
      expect({ table, pk: await primaryKey(table) }).toEqual({ table, pk: keys.pk });
      expect({ table, unique: await uniqueKeys(table) }).toEqual({ table, unique: keys.unique.map((u) => [...u]) });
      expect({ table, fks: await foreignKeys(table) }).toEqual({
        table,
        fks: keys.fks.map((f) => ({ ...f })).sort((a, b) => a.column.localeCompare(b.column)),
      });
    }
    const since0033 = (table: TableName) => TABLE_COLUMNS[table].filter((c) => c.since === '0033_catalog_accred_fields');
    expect(since0033('records')).toEqual(TABLE_COLUMNS.records.slice(-4));
    expect(since0033('records').map((c) => [c.name, c.kind, c.length, c.nullable])).toEqual([
      ['audience', 'varchar', 16, true],
      ['local_work', 'varchar', 16, true],
      ['local_work_kind', 'varchar', 16, true],
      ['reference_kind', 'varchar', 16, true],
    ]);
    expect(since0033('items')).toEqual(TABLE_COLUMNS.items.slice(-1));
    expect(since0033('items').map((c) => [c.name, c.kind, c.length, c.nullable])).toEqual([['input_on', 'date', 10, true]]);
    expect((await catalogColumns('records')).slice(-4).map((c) => c.name)).toEqual(['audience', 'local_work', 'local_work_kind', 'reference_kind']);
    expect((await catalogColumns('items')).slice(-1).map((c) => c.name)).toEqual(['input_on']);
    for (const table of ['records', 'items'] as const) {
      expect({ table, columns: await catalogColumns(table) }).toEqual({ table, columns: expected(TABLE_COLUMNS[table]) });
    }
  });

  it('the first column of a table names the migration that made it (schema_tables.created_by)', async () => {
    const registry = await h.db.selectFrom('schema_tables').select(['name', 'created_by']).execute();
    for (const { name, created_by } of registry) {
      const since = TABLE_COLUMNS[name as TableName][0]?.since;
      const runner = created_by === 'bootstrap' || created_by === 'migrator';
      expect({ name, since }).toEqual({ name, since: runner ? RUNNER_TABLES_SINCE : created_by });
    }
  });

  it('TABLE_KEYS: primary keys, unique indexes (S5c) and foreign keys equal the catalog', async () => {
    for (const table of TABLES) {
      const keys = TABLE_KEYS[table];
      expect({ table, pk: await primaryKey(table) }).toEqual({ table, pk: keys.pk });
      expect({ table, unique: await uniqueKeys(table) }).toEqual({
        table,
        unique: keys.unique.map((u) => [...u]).sort((a, b) => a.join(',').localeCompare(b.join(','))),
      });
      expect({ table, fks: await foreignKeys(table) }).toEqual({
        table,
        fks: keys.fks.map((f) => ({ ...f })).sort((a, b) => a.column.localeCompare(b.column)),
      });
    }
  });

  // R1c-15: the key and token columns an earlier build made in the database's default collation become "C" when
  // 0009 runs through the migrator (one transaction on PostgreSQL, the migrator's own tables included).
  it.runIf(ctx.available && ctx.engine.startsWith('pg'))(
    'PostgreSQL: an install of 0001–0008 in the default collation is converted by 0009 through the migrator',
    async () => {
      await emptyDatabase(h);
      const upTo8 = await runMigrations(h, { appVersion: '0.1.0', dataDir, migrations: migrationsUpTo(PHASE1_MIGRATIONS, '0008_access_indexes') });
      expect(upTo8.applied).toHaveLength(8);
      await h.db.insertInto('settings').values({ scope: 'data', key: 'test.kept', value: '1', updated_at: 1, updated_by: null }).execute();
      const binary = degradedBefore0009();
      for (const b of binary) {
        const type = { toOperationNode: () => DataTypeNode.create(b.type) };
        await h.db.schema
          .alterTable(b.table)
          .alterColumn(b.column, (ac) => ac.setDataType(sql`${type} collate "default"`))
          .execute();
      }
      const before = await Promise.all(binary.map(async (b) => (await catalogColumns(b.table)).find((c) => c.name === b.column)?.collation));
      expect(new Set(before)).toEqual(new Set(['default']));

      expect((await runMigrations(h, { appVersion: '0.1.0', dataDir, migrations: PHASE1_MIGRATIONS })).applied).toEqual(
        Object.keys(PHASE1_MIGRATIONS)
          .sort()
          .filter((m) => m > '0008_access_indexes'),
      );
      for (const table of TABLES) {
        expect({ table, columns: await catalogColumns(table) }).toEqual({ table, columns: expected(columnsAt(table, RELEASE_LAST)) });
      }
      expect(await h.db.selectFrom('settings').select('value').where('key', '=', 'test.kept').execute()).toEqual([{ value: '1' }]);
    },
  );
});
