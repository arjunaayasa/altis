import fsp from 'node:fs/promises';
import os from 'node:os';
import path from 'node:path';
import { isDomainError, newId } from '@altis/shared';
import { sql } from 'kysely';
import { afterAll, beforeAll, describe, expect, it } from 'vitest';
import { engineLabel, testDb, testDbContext, type TestDbHandle } from '../../../tools/test/test-db.js';
import { PHASE1_MIGRATIONS } from '../src/migrations/index.js';
import { runMigrations } from '../src/migrator.js';

// Phase 2 (catalog), Task 1: migrations 0020–0029 appended to the frozen migration map (decision P2-06), on the engine
// picked by ALTIS_TEST_DB. The tables themselves are tables.test.ts's and columns.test.ts's; the seeds
// catalog-seed.test.ts's; the full-text index fulltext.test.ts's. Komunitas K1 appends 0030–0033 (reports and
// accreditation) to the same map; its tables are tables.test.ts's (fixtures/komunitas-k1-tables.ts). Members and
// circulation append 0040 (tables: fixtures/komunitas-members-circulation-tables.ts); its seeds and the one-open-loan
// guarantee are checked here.

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

// ---- Komunitas K1 (tables) ----
const K1_MIGRATIONS = ['0030_reports_core', '0031_accreditation', '0032_library_registers', '0033_catalog_accred_fields'];

// ---- Komunitas (members and circulation) ----
const CIRCULATION_MIGRATIONS = ['0040_members_circulation'];
// ---- Komunitas (holds) ----
const HOLDS_MIGRATIONS = ['0041_holds'];
// ---- Komunitas (circulation core) ----
const CIRC_CORE_MIGRATIONS = ['0042_circulation_core'];
// ---- Komunitas K2 (visits) ----
const VISITS_MIGRATIONS = ['0043_visits'];
// ---- Komunitas (member area) ----
const MEMBER_AREA_MIGRATIONS = ['0044_member_area'];
// ---- Komunitas (charges and payments) ----
const CHARGES_MIGRATIONS = ['0045_charges'];
// ---- Komunitas (SLiMS members and circulation) ----
const SLIMS_PEOPLE_MIGRATIONS = ['0046_migration_subject'];

describe('the Phase 2 migrations in the migration map (P2-06)', () => {
  it('appends 0020–0029 in order to the same frozen map; 0029_search_token_version is the last key', () => {
    const names = Object.keys(PHASE1_MIGRATIONS).sort();
    expect(names.filter((n) => n >= '0020' && n < '0030')).toEqual(CATALOG_MIGRATIONS);
    expect(Object.isFrozen(PHASE1_MIGRATIONS)).toBe(true);
    for (const name of CATALOG_MIGRATIONS) expect(typeof PHASE1_MIGRATIONS[name]?.up).toBe('function');
  });

  it('Komunitas K1 appends 0030–0033 in order', () => {
    const names = Object.keys(PHASE1_MIGRATIONS).sort();
    expect(names.filter((n) => n >= '0030' && n < '0040')).toEqual(K1_MIGRATIONS);
    for (const name of K1_MIGRATIONS) expect(typeof PHASE1_MIGRATIONS[name]?.up).toBe('function');
  });

  it('members and circulation append 0040, holds 0041, the circulation core 0042, visits 0043, the member area 0044, charges 0045, then the migration subject 0046; 0046_migration_subject is the last key', () => {
    const names = Object.keys(PHASE1_MIGRATIONS).sort();
    const all = [...CIRCULATION_MIGRATIONS, ...HOLDS_MIGRATIONS, ...CIRC_CORE_MIGRATIONS, ...VISITS_MIGRATIONS, ...MEMBER_AREA_MIGRATIONS, ...CHARGES_MIGRATIONS, ...SLIMS_PEOPLE_MIGRATIONS];
    expect(names.filter((n) => n >= '0040' && n < '0050')).toEqual(all);
    // The newest range on this branch (every earlier range sorts before it).
    expect(names.at(-1)).toBe('0046_migration_subject');
    for (const name of all) expect(typeof PHASE1_MIGRATIONS[name]?.up).toBe('function');
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

  it('migrates an empty database to 0046, and a second run reports it up to date', async () => {
    const first = await runMigrations(h, { appVersion: '0.1.0', dataDir, migrations: PHASE1_MIGRATIONS });
    expect(first.mode).toBe('migrated');
    const newest = [...CATALOG_MIGRATIONS, ...K1_MIGRATIONS, ...CIRCULATION_MIGRATIONS, ...HOLDS_MIGRATIONS, ...CIRC_CORE_MIGRATIONS, ...VISITS_MIGRATIONS, ...MEMBER_AREA_MIGRATIONS, ...CHARGES_MIGRATIONS, ...SLIMS_PEOPLE_MIGRATIONS];
    expect(first.applied.slice(-newest.length)).toEqual(newest);
    expect(first.schemaVersion).toBe('0046');
    const second = await runMigrations(h, { appVersion: '0.1.0', dataDir, migrations: PHASE1_MIGRATIONS });
    expect(second).toEqual({ mode: 'up-to-date', applied: [], schemaVersion: '0046', minCodeVersion: '0.0.0', edition: { mode: 'empty', applied: [] } });
    expect(await h.db.selectFrom('schema_meta').select('schema_version').execute()).toEqual([{ schema_version: '0046' }]);
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

  // ---- Komunitas K1 (tables) ----
  it('0033: the accession register reads items in (received_date, inventory_no) order through its index', async () => {
    expect(await indexColumns('items', 'ix_items_received_date_inventory_no')).toEqual(['received_date', 'inventory_no']);
  });

  it('every Komunitas K1 migration can run again without changing anything (idempotent)', async () => {
    const before = await h.db.selectFrom('schema_tables').selectAll().orderBy('name').execute();
    const indexes = await indexColumns('items', 'ix_items_received_date_inventory_no');
    for (const name of K1_MIGRATIONS) await PHASE1_MIGRATIONS[name]!.up(h.db, h.dialect);
    expect(await h.db.selectFrom('schema_tables').selectAll().orderBy('name').execute()).toEqual(before);
    expect(await indexColumns('items', 'ix_items_received_date_inventory_no')).toEqual(indexes);
    const k1 = before.filter((t) => t.created_by >= '0030' && t.created_by < '0040').map((t) => [t.name, t.class, t.created_by]);
    expect(k1).toEqual([
      ['accred_answers', 'data', '0031_accreditation'],
      ['accred_evidence', 'data', '0031_accreditation'],
      ['accred_periods', 'data', '0031_accreditation'],
      ['accred_results', 'volatile', '0031_accreditation'],
      ['accred_snapshots', 'data', '0031_accreditation'],
      ['library_activities', 'data', '0032_library_registers'],
      ['library_budgets', 'data', '0032_library_registers'],
      ['library_documents', 'data', '0032_library_registers'],
      ['library_partnerships', 'data', '0032_library_registers'],
      ['library_staff', 'data', '0032_library_registers'],
      ['report_runs', 'volatile', '0030_reports_core'],
      ['staff_trainings', 'data', '0032_library_registers'],
      ['usage_group_map', 'data', '0031_accreditation'],
      ['usage_stats', 'data', '0031_accreditation'],
    ]);
  });

  // ---- Komunitas (members and circulation) ----
  it('0040 seeds the four member types and the general loan rule (7 days, one renewal, every dimension "all")', async () => {
    const types = await h.db
      .selectFrom('member_types')
      .select(['code_key', 'accred_group', 'membership_days', 'loan_limit', 'holds_allowed', 'holds_limit', 'online_renewal'])
      .orderBy('sort_order')
      .execute();
    expect(types).toEqual([
      { code_key: 'SISWA', accred_group: 'student', membership_days: 365, loan_limit: 3, holds_allowed: 1, holds_limit: 2, online_renewal: 1 },
      { code_key: 'GURU', accred_group: 'teacher', membership_days: 365, loan_limit: 10, holds_allowed: 1, holds_limit: 2, online_renewal: 1 },
      { code_key: 'TENDIK', accred_group: 'edu_staff', membership_days: 365, loan_limit: 5, holds_allowed: 1, holds_limit: 2, online_renewal: 1 },
      { code_key: 'UMUM', accred_group: 'public', membership_days: 365, loan_limit: 2, holds_allowed: 1, holds_limit: 2, online_renewal: 1 },
    ]);
    const rules = await h.db.selectFrom('policies').selectAll().execute();
    expect(rules).toHaveLength(1);
    expect(rules[0]).toMatchObject({
      code_key: 'DEFAULT',
      scope_key: '*/*/*/*',
      member_type_id: null,
      collection_type_id: null,
      material_type_id: null,
      branch_id: null,
      loanable: 1,
      loan_days: 7,
      loan_limit: null,
      renew_limit: 1,
      fine_per_day_minor: 0,
      fine_cap_minor: null,
      grace_days: 0,
      currency: 'IDR',
      archived_at: null,
    });
  });

  it('0040 runs again without changing anything, and keeps a library\'s own edits of the seeds', async () => {
    await h.db.updateTable('member_types').set({ name_id: 'Peserta didik' }).where('code_key', '=', 'SISWA').execute();
    await h.db.updateTable('policies').set({ loan_days: 14 }).where('code_key', '=', 'DEFAULT').execute();
    const before = await h.db.selectFrom('schema_tables').selectAll().orderBy('name').execute();
    const types = await h.db.selectFrom('member_types').selectAll().orderBy('code_key').execute();
    const rules = await h.db.selectFrom('policies').selectAll().execute();
    await PHASE1_MIGRATIONS['0040_members_circulation']!.up(h.db, h.dialect);
    expect(await h.db.selectFrom('schema_tables').selectAll().orderBy('name').execute()).toEqual(before);
    expect(await h.db.selectFrom('member_types').selectAll().orderBy('code_key').execute()).toEqual(types);
    expect(await h.db.selectFrom('policies').selectAll().execute()).toEqual(rules);
    expect(before.filter((t) => t.created_by === '0040_members_circulation').map((t) => [t.name, t.class])).toEqual([
      ['loans', 'data'],
      ['member_events', 'data'],
      ['member_types', 'data'],
      ['members', 'data'],
      ['policies', 'data'],
    ]);
  });

  it('0040: one open loan per item: a second open loan of the same item is a unique violation, closed loans are not', async () => {
    const itemId = newId();
    const loan = (open: boolean) => ({
      id: newId(),
      item_id: itemId,
      open_item_id: open ? itemId : null,
      record_id: null,
      member_id: newId(),
      branch_id: newId(),
      policy_id: null,
      loaned_on: '2026-01-02',
      loaned_at: 0,
      due_on: '2026-01-09',
      returned_on: open ? null : '2026-01-05',
      returned_at: open ? null : 1,
      outcome: open ? null : 'returned',
      loan_days: 7,
      renew_limit: 1,
      grace_days: 0,
      fine_per_day_minor: 0,
      fine_cap_minor: null,
      currency: 'IDR',
      source: 'desk',
      created_at: 0,
      updated_at: 0,
    });
    try {
      await h.db.insertInto('loans').values([loan(false), loan(false), loan(true)]).execute();
      const second = await h.db
        .insertInto('loans')
        .values(loan(true))
        .execute()
        .then(
          () => null,
          (error: unknown) => error,
        );
      expect(isDomainError(second) && second.code).toBe('UNIQUE_VIOLATION');
      expect(await h.db.selectFrom('loans').select('id').where('item_id', '=', itemId).execute()).toHaveLength(3);
    } finally {
      await h.db.deleteFrom('loans').where('item_id', '=', itemId).execute();
    }
  });

  // ---- Komunitas (holds) ----
  it('0041: one active hold per member per title and one hold per kept copy; closed holds (keys null) are many', async () => {
    const recordId = newId();
    const memberId = newId();
    const itemId = newId();
    const hold = (active: boolean, trap: boolean) => ({
      id: newId(),
      record_id: recordId,
      member_id: memberId,
      pickup_branch_id: newId(),
      status: active ? 'waiting' : 'cancelled',
      active_key: active ? `${memberId}:${recordId}` : null,
      trap_item_id: trap ? itemId : null,
      placed_on: '2026-01-02',
      placed_at: 0,
      source: 'desk',
      created_at: 0,
      updated_at: 0,
    });
    const refused = (row: ReturnType<typeof hold>) =>
      h.db
        .insertInto('holds')
        .values(row)
        .execute()
        .then(
          () => null,
          (error: unknown) => error,
        );
    try {
      await h.db.insertInto('holds').values([hold(false, false), hold(false, false), hold(true, true)]).execute();
      const second = await refused(hold(true, false));
      expect(isDomainError(second) && second.code).toBe('UNIQUE_VIOLATION');
      const kept = await refused({ ...hold(false, true) });
      expect(isDomainError(kept) && kept.code).toBe('UNIQUE_VIOLATION');
      expect(await h.db.selectFrom('holds').select('id').where('record_id', '=', recordId).execute()).toHaveLength(3);
    } finally {
      await h.db.deleteFrom('holds').where('record_id', '=', recordId).execute();
    }
  });
});
