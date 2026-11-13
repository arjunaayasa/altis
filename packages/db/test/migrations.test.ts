import fsp from 'node:fs/promises';
import os from 'node:os';
import path from 'node:path';
import { sql } from 'kysely';
import { afterAll, beforeAll, describe, expect, it } from 'vitest';
import { engineLabel, testDb, testDbContext, type TestDbHandle } from '../../../tools/test/test-db.js';
import { PHASE1_MIGRATIONS } from '../src/migrations/index.js';
import { runMigrations } from '../src/migrator.js';

// Phase 2 (catalog), Task 1: migrations 0020–0029 appended to the frozen migration map (decision P2-06), on the engine
// picked by ALTIS_TEST_DB. The tables themselves are tables.test.ts's and columns.test.ts's; the seeds
// catalog-seed.test.ts's; the full-text index fulltext.test.ts's.

const ctx = testDbContext();

const CATALOG_MIGRATIONS = [
  '0020_catalog_authorities',
  '0021_catalog_records',
  '0022_catalog_items',
  '0023_opac_pages',
  '0024_search_index',
  '0025_catalog_runs_migration',
  '0026_custom_fields_i18n',
  '0027_catalog_seed',
  '0028_catalog_perf_indexes',
  '0029_search_token_version',
];

describe('the Phase 2 migrations in the migration map (P2-06)', () => {
  it('appends 0020–0029 in order to the same frozen map; 0029_search_token_version is the last key', () => {
    const names = Object.keys(PHASE1_MIGRATIONS).sort();
    expect(names.filter((n) => n >= '0020' && n < '0040')).toEqual(CATALOG_MIGRATIONS);
    // Phase 2 is the newest range on this branch (Phase 1d's 0010–0019 sort before it).
    expect(names.at(-1)).toBe('0029_search_token_version');
    expect(Object.isFrozen(PHASE1_MIGRATIONS)).toBe(true);
    for (const name of CATALOG_MIGRATIONS) expect(typeof PHASE1_MIGRATIONS[name]?.up).toBe('function');
  });
});

describe.skipIf(!ctx.available)(`the Phase 2 migrations [${engineLabel()}]`, () => {
  let h: TestDbHandle;
  let dataDir: string;

  beforeAll(async () => {
    h = await testDb();
    dataDir = await fsp.mkdtemp(path.join(os.tmpdir(), 'altis-migrations-'));
  });

  afterAll(async () => {
    await h?.close();
    if (dataDir !== undefined) await fsp.rm(dataDir, { recursive: true, force: true });
  });

  /** The columns of the index `name` in index order; [] when there is no such index. */
  async function indexColumns(table: string, name: string): Promise<string[]> {
    if (h.dialect === 'mysql' || h.dialect === 'mariadb') {
      const { rows } = await sql<{ col: string }>`SELECT COLUMN_NAME AS col FROM information_schema.STATISTICS
        WHERE TABLE_SCHEMA = DATABASE() AND TABLE_NAME = ${table} AND INDEX_NAME = ${name} ORDER BY SEQ_IN_INDEX`.execute(h.db);
      return rows.map((r) => String(r.col));
    }
    if (h.dialect === 'postgres') {
      const { rows } = await sql<{ col: string }>`SELECT a.attname AS col FROM pg_index ix
        JOIN pg_class i ON i.oid = ix.indexrelid
        CROSS JOIN LATERAL unnest(ix.indkey::int2[]) WITH ORDINALITY AS k(attnum, ord)
        JOIN pg_attribute a ON a.attrelid = ix.indrelid AND a.attnum = k.attnum
        WHERE ix.indrelid = to_regclass(format('%I.%I', current_schema(), ${table}::text)) AND i.relname = ${name}
        ORDER BY k.ord`.execute(h.db);
      return rows.map((r) => String(r.col));
    }
    const { rows } = await sql<{ col: string }>`SELECT ii.name AS col FROM pragma_index_list(${table}) il
      JOIN pragma_index_info(il.name) ii WHERE il.name = ${name} ORDER BY ii.seqno`.execute(h.db);
    return rows.map((r) => String(r.col));
  }

  it('migrates an empty database to 0029, and a second run reports it up to date', async () => {
    const first = await runMigrations(h, { appVersion: '0.1.0', dataDir, migrations: PHASE1_MIGRATIONS });
    expect(first.mode).toBe('migrated');
    expect(first.applied.slice(-CATALOG_MIGRATIONS.length)).toEqual(CATALOG_MIGRATIONS);
    expect(first.schemaVersion).toBe('0029');
    const second = await runMigrations(h, { appVersion: '0.1.0', dataDir, migrations: PHASE1_MIGRATIONS });
    expect(second).toEqual({ mode: 'up-to-date', applied: [], schemaVersion: '0029', minCodeVersion: '0.0.0', edition: { mode: 'empty', applied: [] } });
    expect(await h.db.selectFrom('schema_meta').select('schema_version').execute()).toEqual([{ schema_version: '0029' }]);
  });

  it('S14: search_doc has the newest-first indexes (is_public, created_at) and (created_at)', async () => {
    expect(await indexColumns('search_doc', 'ix_search_doc_public_created')).toEqual(['is_public', 'created_at']);
    expect(await indexColumns('search_doc', 'ix_search_doc_created')).toEqual(['created_at']);
  });

  it.runIf(ctx.engine === 'sqlite')('S14 (SQLite): the newest public records are read through ix_search_doc_public_created', async () => {
    const { rows } = await sql<{ detail: string }>`EXPLAIN QUERY PLAN
      SELECT record_id FROM search_doc WHERE is_public = 1 ORDER BY created_at DESC, doc_no DESC LIMIT 20`.execute(h.db);
    expect(rows.map((r) => r.detail).join('\n')).toContain('ix_search_doc_public_created');
  });

  it('0028 (Task 39, K9): the masters usage counts and the promoted titles have their indexes', async () => {
    expect(await indexColumns('records', 'ix_records_language_id_archived_at')).toEqual(['language_id', 'archived_at']);
    expect(await indexColumns('records', 'ix_records_promoted_changed_at_id')).toEqual(['promoted', 'changed_at', 'id']);
    expect(await indexColumns('items', 'ix_items_collection_type_id_archived_at')).toEqual(['collection_type_id', 'archived_at']);
    expect(await indexColumns('items', 'ix_items_supplier_id_archived_at')).toEqual(['supplier_id', 'archived_at']);
  });

  it.runIf(ctx.engine === 'sqlite')('0028 (SQLite): a master\'s usage count reads its index alone; the promoted titles seek promoted = 1', async () => {
    const plan = async (q: { execute(db: typeof h.db): Promise<{ rows: { detail: string }[] }> }) => (await q.execute(h.db)).rows.map((r) => r.detail).join('\n');
    // The shapes of catalog/masters/in-use.ts and of the OPAC home page's promotedTitles (opac/catalog/queries.ts).
    expect(await plan(sql<{ detail: string }>`EXPLAIN QUERY PLAN SELECT language_id, count(*) FROM records
      WHERE language_id IN ('a', 'b') AND archived_at IS NULL GROUP BY language_id`)).toContain('COVERING INDEX ix_records_language_id_archived_at');
    expect(await plan(sql<{ detail: string }>`EXPLAIN QUERY PLAN SELECT collection_type_id, count(*) FROM items
      WHERE collection_type_id IN ('a', 'b') AND archived_at IS NULL GROUP BY collection_type_id`)).toContain('COVERING INDEX ix_items_collection_type_id_archived_at');
    expect(await plan(sql<{ detail: string }>`EXPLAIN QUERY PLAN SELECT supplier_id, count(*) FROM items
      WHERE supplier_id IN ('a', 'b') AND archived_at IS NULL GROUP BY supplier_id`)).toContain('COVERING INDEX ix_items_supplier_id_archived_at');
    const promoted = await plan(sql<{ detail: string }>`EXPLAIN QUERY PLAN SELECT id, title FROM records
      WHERE opac_visible = 1 AND archived_at IS NULL AND merged_into IS NULL AND promoted = 1
      ORDER BY changed_at DESC, id DESC LIMIT 8`);
    expect(promoted).toContain('ix_records_promoted_changed_at_id');
    expect(promoted).not.toContain('TEMP B-TREE');
  });

  it('every Phase 2 migration can run again without changing anything (idempotent)', async () => {
    const before = await h.db.selectFrom('schema_tables').selectAll().orderBy('name').execute();
    const seeded = await h.db.selectFrom('material_types').select(['id', 'code_key']).orderBy('code_key').execute();
    for (const name of CATALOG_MIGRATIONS) await PHASE1_MIGRATIONS[name]!.up(h.db, h.dialect);
    expect(await h.db.selectFrom('schema_tables').selectAll().orderBy('name').execute()).toEqual(before);
    expect(await h.db.selectFrom('material_types').select(['id', 'code_key']).orderBy('code_key').execute()).toEqual(seeded);
  });
});
