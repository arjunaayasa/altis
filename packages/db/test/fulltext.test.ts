import fsp from 'node:fs/promises';
import os from 'node:os';
import path from 'node:path';
import { isDomainError } from '@altis/shared';
import {
  DummyDriver,
  Kysely,
  MysqlAdapter,
  MysqlIntrospector,
  MysqlQueryCompiler,
  PostgresAdapter,
  PostgresIntrospector,
  PostgresQueryCompiler,
  SqliteAdapter,
  SqliteIntrospector,
  SqliteQueryCompiler,
  sql,
  type DialectAdapter,
  type QueryCompiler,
} from 'kysely';
import { afterAll, beforeAll, describe, expect, it } from 'vitest';
import { engineLabel, testDb, testDbContext, type TestDbHandle } from '../../../tools/test/test-db.js';
import {
  FULLTEXT_DIALECT_OBJECTS,
  FULLTEXT_VIRTUAL_TABLES,
  PG_SEARCH_VECTOR_SQL,
  ensureFullText,
  fullTextFamily,
  pgSearchVectorOf,
  type FullTextSpec,
} from '../src/fulltext.js';
import { SEARCH_FULLTEXT } from '../src/migrations/0024_search_index.js';
import { PHASE1_MIGRATIONS } from '../src/migrations/index.js';
import { runMigrations } from '../src/migrator.js';
import { withTx } from '../src/tx.js';

// Phase 2 (catalog), Task 1: the registered full-text helpers (Phase 2 spec §4.3) and the index migration 0024 makes
// with them. The SQLite branch runs here; the MySQL/MariaDB and PostgreSQL branches run in the engine runs (Task 39).

const ctx = testDbContext();

/** A Kysely that compiles for one dialect without a connection. */
function compilerFor(adapter: DialectAdapter, compiler: () => QueryCompiler, introspector: (db: Kysely<unknown>) => unknown) {
  return new Kysely<unknown>({
    dialect: {
      createAdapter: () => adapter,
      createDriver: () => new DummyDriver(),
      createIntrospector: introspector as never,
      createQueryCompiler: compiler,
    },
  });
}

const pg = compilerFor(new PostgresAdapter(), () => new PostgresQueryCompiler(), (db) => new PostgresIntrospector(db));
const mysql = compilerFor(new MysqlAdapter(), () => new MysqlQueryCompiler(), (db) => new MysqlIntrospector(db));
const sqlite = compilerFor(new SqliteAdapter(), () => new SqliteQueryCompiler(), (db) => new SqliteIntrospector(db));

const SPEC: FullTextSpec = {
  table: 't_ft_doc',
  rowid: 'n',
  columns: ['a', 'b'],
  innodb: [{ name: 'ix_t_ft_doc_ft', columns: ['a', 'b'] }],
  pg: { name: 'ix_t_ft_doc_ft' },
  fts5: { name: 't_ft_fts' },
};

describe('the full-text helpers without a database', () => {
  it('PG_SEARCH_VECTOR_SQL is the weighted vector over the four text columns, as text without a parameter', () => {
    const compiled = PG_SEARCH_VECTOR_SQL.compile(pg);
    expect(compiled.parameters).toEqual([]);
    expect(compiled.sql).toBe(
      `setweight(to_tsvector('simple', coalesce("t_title", '')), 'A') || ` +
        `setweight(to_tsvector('simple', coalesce("t_agents", '')), 'B') || ` +
        `setweight(to_tsvector('simple', coalesce("t_subjects", '')), 'C') || ` +
        `setweight(to_tsvector('simple', coalesce("t_rest", '')), 'D')`,
    );
  });

  it('0024 builds its PostgreSQL index from the same expression, byte for byte', () => {
    expect(pgSearchVectorOf(SEARCH_FULLTEXT).compile(pg).sql).toBe(PG_SEARCH_VECTOR_SQL.compile(pg).sql);
    expect(SEARCH_FULLTEXT).toEqual({
      table: 'search_doc',
      rowid: 'doc_no',
      columns: ['t_title', 't_agents', 't_subjects', 't_rest'],
      innodb: [
        { name: 'ix_search_doc_ft_all', columns: ['t_title', 't_agents', 't_subjects', 't_rest'] },
        { name: 'ix_search_doc_ft_title', columns: ['t_title'] },
        { name: 'ix_search_doc_ft_agents', columns: ['t_agents'] },
        { name: 'ix_search_doc_ft_subjects', columns: ['t_subjects'] },
      ],
      pg: { name: 'ix_search_doc_ft' },
      fts5: { name: 'search_fts' },
    });
  });

  it('fullTextFamily reads the adapter: innodb, pg, fts5', () => {
    expect(fullTextFamily(mysql)).toBe('innodb');
    expect(fullTextFamily(pg)).toBe('pg');
    expect(fullTextFamily(sqlite)).toBe('fts5');
  });

  it('names the FTS5 objects SQLite keeps outside the registry, and the virtual table a wipe drops first (B6)', () => {
    expect(FULLTEXT_DIALECT_OBJECTS).toEqual({
      mysql: [],
      mariadb: [],
      postgres: [],
      sqlite: ['search_fts', 'search_fts_data', 'search_fts_idx', 'search_fts_docsize', 'search_fts_config'],
    });
    expect(FULLTEXT_VIRTUAL_TABLES).toEqual({ mysql: [], mariadb: [], postgres: [], sqlite: ['search_fts'] });
  });

  it('refuses a spec that would not be portable, before touching the database (TypeError)', async () => {
    const bad: Partial<FullTextSpec>[] = [
      { table: 'Search' },
      { columns: [] },
      { columns: ['a', 'b', 'c', 'd', 'e'] },
      { columns: ['a', 'a'] },
      { columns: ['n', 'a'] },
      { innodb: [{ name: 'ft_x', columns: ['a'] }] },
      { innodb: [{ name: 'ix_x', columns: ['zz'] }] },
      { pg: { name: 'uq_x' } },
      { fts5: { name: 'sqlite_x' } },
    ];
    for (const over of bad) {
      // `sqlite` has no connection: a check that reached the database would fail differently.
      await expect(ensureFullText(sqlite, 'sqlite', { ...SPEC, ...over })).rejects.toThrow(TypeError);
    }
    await expect(ensureFullText(sqlite, 'oracle' as never, SPEC)).rejects.toThrow(TypeError);
  });
});

describe.skipIf(!ctx.available)(`ensureFullText and migration 0024 [${engineLabel()}]`, () => {
  let h: TestDbHandle;
  let dataDir: string;

  beforeAll(async () => {
    h = await testDb();
    dataDir = await fsp.mkdtemp(path.join(os.tmpdir(), 'altis-fulltext-'));
    await runMigrations(h, { appVersion: '0.1.0', dataDir, migrations: PHASE1_MIGRATIONS });
  });

  afterAll(async () => {
    await h?.close();
    if (dataDir !== undefined) await fsp.rm(dataDir, { recursive: true, force: true });
  });

  /** What the catalog holds of the search index, per dialect, for comparing before and after. */
  async function fullTextObjects(): Promise<unknown> {
    if (h.dialect === 'sqlite') {
      return (await sql<{ type: string; name: string; ddl: string }>`SELECT type, name, sql AS ddl FROM sqlite_master
        WHERE name LIKE 'search_fts%' ORDER BY name`.execute(h.db)).rows;
    }
    if (h.dialect === 'postgres') {
      return (await sql<{ name: string; def: string }>`SELECT indexname AS name, indexdef AS def FROM pg_indexes
        WHERE schemaname = current_schema() AND indexname LIKE 'ix_search_doc_ft%' ORDER BY indexname`.execute(h.db)).rows;
    }
    return (await sql<{ name: string; type: string; col: string }>`SELECT INDEX_NAME AS name, INDEX_TYPE AS type, COLUMN_NAME AS col
      FROM information_schema.STATISTICS WHERE TABLE_SCHEMA = DATABASE() AND INDEX_NAME LIKE 'ix\\_search\\_doc\\_ft%'
      ORDER BY INDEX_NAME, SEQ_IN_INDEX`.execute(h.db)).rows;
  }

  it('fullTextFamily of the handle and of a transaction is the engine’s', async () => {
    const family = h.dialect === 'sqlite' ? 'fts5' : h.dialect === 'postgres' ? 'pg' : 'innodb';
    expect(fullTextFamily(h.db)).toBe(family);
    expect(await withTx(h, async (trx) => fullTextFamily(trx))).toBe(family);
  });

  it.runIf(ctx.engine === 'sqlite')('SQLite: search_fts is an FTS5 external-content table over search_doc (doc_no), unicode61', async () => {
    const { rows } = await sql<{ ddl: string }>`SELECT sql AS ddl FROM sqlite_master WHERE type = 'table' AND name = 'search_fts'`.execute(h.db);
    expect(rows).toHaveLength(1);
    const ddl = rows[0]!.ddl;
    expect(ddl).toMatch(/^CREATE VIRTUAL TABLE "search_fts" USING fts5\(/);
    expect(ddl).toContain(`content='search_doc'`);
    expect(ddl).toContain(`content_rowid='doc_no'`);
    expect(ddl).toContain(`tokenize='unicode61'`);
    const columns = await sql<{ name: string }>`SELECT name FROM pragma_table_info('search_fts') ORDER BY cid`.execute(h.db);
    expect(columns.rows.map((c) => c.name)).toEqual(['t_title', 't_agents', 't_subjects', 't_rest']);
    // Its shadow tables are exactly the dialect objects the drift and table tests skip.
    const objects = await sql<{ name: string }>`SELECT name FROM sqlite_master WHERE type = 'table' AND name LIKE 'search\\_fts%' ESCAPE '\\'`.execute(h.db);
    expect(objects.rows.map((o) => o.name).sort()).toEqual([...FULLTEXT_DIALECT_OBJECTS.sqlite].sort());
  });

  it.runIf(ctx.engine === 'sqlite')('SQLite: a document written to search_doc and to search_fts is found by MATCH, by column too', async () => {
    try {
      await sql`INSERT INTO search_doc (doc_no, record_id, is_public, is_archived, t_title, t_agents, t_subjects, t_rest, title_key, year, created_at, changed_at)
        VALUES (7, '01J0000000000000000000000A', 1, 0, 'laskar pelangi', 'hirata andrea', 'novel', 'zqab 9789793062792', 'laskar pelangi', 2005, 1, 1)`.execute(h.db);
      await sql`INSERT INTO search_fts (rowid, t_title, t_agents, t_subjects, t_rest)
        SELECT doc_no, t_title, t_agents, t_subjects, t_rest FROM search_doc WHERE doc_no = 7`.execute(h.db);
      const hit = async (q: string) =>
        (await sql<{ rowid: number }>`SELECT rowid FROM search_fts WHERE search_fts MATCH ${q}`.execute(h.db)).rows.map((r) => Number(r.rowid));
      expect(await hit('pelangi')).toEqual([7]);
      expect(await hit('{t_agents}: hirata')).toEqual([7]);
      expect(await hit('{t_title}: hirata')).toEqual([]);
      expect(await hit('zqab')).toEqual([7]);
      // External content: the index reads the text back from search_doc.
      const text = await sql<{ t: string }>`SELECT t_title AS t FROM search_fts WHERE search_fts MATCH 'pelangi'`.execute(h.db);
      expect(text.rows).toEqual([{ t: 'laskar pelangi' }]);
    } finally {
      await sql`INSERT INTO search_fts (search_fts) VALUES ('delete-all')`.execute(h.db);
      await h.db.deleteFrom('search_doc').execute();
    }
  });

  it.runIf(ctx.engine.startsWith('mysql') || ctx.engine.startsWith('mariadb'))(
    'MySQL/MariaDB: the four FULLTEXT indexes of search_doc',
    async () => {
      expect(await fullTextObjects()).toEqual([
        { name: 'ix_search_doc_ft_agents', type: 'FULLTEXT', col: 't_agents' },
        { name: 'ix_search_doc_ft_all', type: 'FULLTEXT', col: 't_title' },
        { name: 'ix_search_doc_ft_all', type: 'FULLTEXT', col: 't_agents' },
        { name: 'ix_search_doc_ft_all', type: 'FULLTEXT', col: 't_subjects' },
        { name: 'ix_search_doc_ft_all', type: 'FULLTEXT', col: 't_rest' },
        { name: 'ix_search_doc_ft_subjects', type: 'FULLTEXT', col: 't_subjects' },
        { name: 'ix_search_doc_ft_title', type: 'FULLTEXT', col: 't_title' },
      ]);
    },
  );

  it.runIf(ctx.engine.startsWith('pg'))('PostgreSQL: one GIN expression index ix_search_doc_ft over the weighted vector', async () => {
    const rows = (await fullTextObjects()) as { name: string; def: string }[];
    expect(rows.map((r) => r.name)).toEqual(['ix_search_doc_ft']);
    const def = rows[0]?.def ?? '';
    expect(def).toMatch(/ ON \S*search_doc USING gin \(/);
    expect(def).toMatch(/setweight\(to_tsvector\('simple'::regconfig, COALESCE\(t_title, ''::text\)\), 'A'::"char"\)/);
    expect(def).toMatch(/setweight\(to_tsvector\('simple'::regconfig, COALESCE\(t_rest, ''::text\)\), 'D'::"char"\)/);
  });

  it('a second ensureFullText (and a rerun of 0024) changes nothing', async () => {
    const before = await fullTextObjects();
    await ensureFullText(h.db, h.dialect, SEARCH_FULLTEXT);
    await PHASE1_MIGRATIONS['0024_search_index']!.up(h.db, h.dialect);
    expect(await fullTextObjects()).toEqual(before);
  });

  it('SCHEMA_CONFLICT: a missing table (table_missing), a name another object holds (fulltext_name_taken / index_name_taken)', async () => {
    const reason = async (p: Promise<unknown>) =>
      p.then(
        () => null,
        (e: unknown) => (isDomainError(e) ? `${e.code}:${String(e.meta?.['reason'])}` : String(e)),
      );
    expect(await reason(ensureFullText(h.db, h.dialect, SPEC))).toBe('SCHEMA_CONFLICT:table_missing');
    await h.db.schema
      .createTable('t_ft_doc')
      .addColumn('n', 'integer', (c) => c.primaryKey())
      .addColumn('a', 'text')
      .addColumn('b', 'text')
      .execute();
    try {
      if (h.dialect === 'sqlite') {
        await h.db.schema.createTable('t_ft_fts').addColumn('x', 'integer').execute();
        expect(await reason(ensureFullText(h.db, h.dialect, SPEC))).toBe('SCHEMA_CONFLICT:fulltext_name_taken');
        await h.db.schema.dropTable('t_ft_fts').execute();
        await ensureFullText(h.db, h.dialect, SPEC);
        const made = await sql<{ ddl: string }>`SELECT sql AS ddl FROM sqlite_master WHERE name = 't_ft_fts'`.execute(h.db);
        expect(made.rows[0]?.ddl).toContain(`content='t_ft_doc', content_rowid='n'`);
        await sql`DROP TABLE t_ft_fts`.execute(h.db);
      } else {
        const taken = { ...SPEC, innodb: [{ name: 'ix_search_doc_ft_all', columns: ['a'] }], pg: { name: 'ix_search_doc_ft' } };
        expect(await reason(ensureFullText(h.db, h.dialect, taken))).toBe('SCHEMA_CONFLICT:index_name_taken');
      }
    } finally {
      await h.db.schema.dropTable('t_ft_doc').ifExists().execute();
    }
  });
});
