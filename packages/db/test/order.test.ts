import { isDomainError } from '@altis/shared';
import { describe, expect, it } from 'vitest';
import { TABLE_KEYS } from '../src/columns.js';
import { PHASE1_MIGRATIONS } from '../src/migrations/index.js';
import { migrationsUpTo, tableLoadOrder } from '../src/order.js';
import { TABLE_CLASSES, type TableName } from '../src/registry.js';

// Load order and migration prefixes for backup and restore (no database needed).

const ALL = Object.keys(TABLE_CLASSES) as TableName[];

/** True when `before` comes before `after` in `order`. */
const precedes = (order: readonly string[], before: string, after: string) => order.indexOf(before) < order.indexOf(after);

describe('tableLoadOrder', () => {
  it('puts parents before the tables that reference them', () => {
    const { order, selfRefs } = tableLoadOrder([
      'notification_reads',
      'notifications',
      'staff_recovery_codes',
      'staff_users',
      'user_roles',
      'roles',
      'branches',
    ]);
    expect([...order].sort()).toEqual(
      ['branches', 'notification_reads', 'notifications', 'roles', 'staff_recovery_codes', 'staff_users', 'user_roles'].sort(),
    );
    expect(precedes(order, 'notifications', 'notification_reads')).toBe(true);
    expect(precedes(order, 'staff_users', 'staff_recovery_codes')).toBe(true);
    expect(precedes(order, 'staff_users', 'user_roles')).toBe(true);
    expect(precedes(order, 'roles', 'user_roles')).toBe(true);
    expect(selfRefs).toEqual({});
    // Ties by name: the first ready table by name each time.
    expect(order).toEqual(['branches', 'notifications', 'notification_reads', 'roles', 'staff_users', 'staff_recovery_codes', 'user_roles']);
  });

  it('orders every table of the registry: each foreign key target first, nothing self-referencing, deterministic', () => {
    const { order, selfRefs } = tableLoadOrder(ALL);
    expect([...order].sort()).toEqual([...ALL].sort());
    for (const table of ALL) {
      for (const fk of TABLE_KEYS[table].fks) expect({ table, parent: fk.table, first: precedes(order, fk.table, table) }).toEqual({ table, parent: fk.table, first: true });
    }
    expect(selfRefs).toEqual({});
    expect(tableLoadOrder([...ALL].reverse()).order).toEqual(order);
  });

  // ---- Phase 2 (catalog): Task 1 ----
  it('Phase 2: branches before locations, records before what they own, items before item_events, pages first', () => {
    const { order, selfRefs } = tableLoadOrder(ALL);
    expect(precedes(order, 'branches', 'locations')).toBe(true);
    for (const child of ['record_identifiers', 'record_marc_extra', 'record_agents', 'record_subjects', 'record_relations', 'attachments', 'items']) {
      expect({ child, after: precedes(order, 'records', child) }).toEqual({ child, after: true });
    }
    expect(precedes(order, 'items', 'item_events')).toBe(true);
    expect(precedes(order, 'pages', 'page_translations')).toBe(true);
    expect(precedes(order, 'subjects', 'subject_relations')).toBe(true);
    // No Phase 2 table references itself (§2.1: locations.parent_id, subject_relations and record_relations have none).
    expect(selfRefs).toEqual({});
    const catalog: TableName[] = [
      'locations',
      'records',
      'record_identifiers',
      'record_marc_extra',
      'record_agents',
      'record_subjects',
      'record_relations',
      'attachments',
      'agents',
      'subjects',
      'subject_relations',
      'publishers',
      'languages',
      'material_types',
      'items',
      'item_events',
      'collection_types',
      'suppliers',
      'pages',
      'page_translations',
      'search_doc',
      'search_facet',
      'search_term',
      'search_state',
      'catalog_runs',
      'migration_map',
      'migration_archive',
    ];
    expect(catalog).toHaveLength(27);
    expect(tableLoadOrder(catalog).selfRefs).toEqual({});
    for (const t of catalog) expect(TABLE_KEYS[t].fks.filter((fk) => fk.table === t)).toEqual([]);
  });

  // ---- Komunitas K1 (tables) ----
  it('Komunitas K1: a period before its answers and snapshots, a staff member before their trainings; nothing self-referencing', () => {
    const { order, selfRefs } = tableLoadOrder(ALL);
    expect(precedes(order, 'accred_periods', 'accred_answers')).toBe(true);
    expect(precedes(order, 'accred_periods', 'accred_snapshots')).toBe(true);
    expect(precedes(order, 'library_staff', 'staff_trainings')).toBe(true);
    expect(selfRefs).toEqual({});
    const k1: TableName[] = [
      'report_runs',
      'accred_periods',
      'accred_answers',
      'accred_results',
      'accred_snapshots',
      'accred_evidence',
      'usage_stats',
      'usage_group_map',
      'library_activities',
      'library_staff',
      'staff_trainings',
      'library_partnerships',
      'library_budgets',
      'library_documents',
    ];
    expect(k1).toHaveLength(14);
    const own = tableLoadOrder(k1);
    expect(own.selfRefs).toEqual({});
    expect(precedes(own.order, 'accred_periods', 'accred_answers')).toBe(true);
    expect(precedes(own.order, 'accred_periods', 'accred_snapshots')).toBe(true);
    expect(precedes(own.order, 'library_staff', 'staff_trainings')).toBe(true);
    for (const t of k1) expect(TABLE_KEYS[t].fks.filter((fk) => fk.table === t)).toEqual([]);
    // Only ownership relations have a foreign key: computed results and evidence reference nothing.
    expect(TABLE_KEYS.accred_results.fks).toEqual([]);
    expect(TABLE_KEYS.accred_evidence.fks).toEqual([]);
  });

  it('ignores a foreign key to a table that is not loaded', () => {
    expect(tableLoadOrder(['user_roles', 'roles']).order).toEqual(['roles', 'user_roles']);
    expect(tableLoadOrder(['user_roles']).order).toEqual(['user_roles']);
    expect(tableLoadOrder([])).toEqual({ order: [], selfRefs: {} });
  });

  it('reports a self-referencing table in selfRefs instead of ordering it by that key', () => {
    const keys = {
      t_tree: { fks: [{ column: 'parent_id', table: 't_tree' }] },
      t_leaf: { fks: [{ column: 'tree_id', table: 't_tree' }] },
      t_root: { fks: [] },
    };
    expect(tableLoadOrder(['t_leaf', 't_tree', 't_root'], keys)).toEqual({
      order: ['t_root', 't_tree', 't_leaf'],
      selfRefs: { t_tree: ['parent_id'] },
    });
  });

  it('refuses an unknown table, a table given twice, and a cycle through two tables', () => {
    expect(() => tableLoadOrder(['nope' as TableName])).toThrow(TypeError);
    expect(() => tableLoadOrder(['roles', 'roles'])).toThrow(TypeError);
    const cycle = { a: { fks: [{ column: 'b_id', table: 'b' }] }, b: { fks: [{ column: 'a_id', table: 'a' }] } };
    expect(() => tableLoadOrder(['a', 'b'], cycle)).toThrow(/cycle/);
  });
});

describe('migrationsUpTo', () => {
  it('returns the prefix of the migration list ending at the given migration, in name order', () => {
    const prefix = migrationsUpTo(PHASE1_MIGRATIONS, '0005_jobs_events_notifications');
    expect(Object.keys(prefix)).toHaveLength(5);
    expect(Object.keys(prefix)).toEqual(Object.keys(PHASE1_MIGRATIONS).sort().slice(0, 5));
    expect(prefix['0005_jobs_events_notifications']).toBe(PHASE1_MIGRATIONS['0005_jobs_events_notifications']);
    // The last migration by name (never named here: Phase 1d and later phases add theirs).
    const last = Object.keys(PHASE1_MIGRATIONS).sort().at(-1) ?? '';
    expect(Object.keys(migrationsUpTo(PHASE1_MIGRATIONS, last))).toEqual(Object.keys(PHASE1_MIGRATIONS).sort());
    expect(Object.keys(migrationsUpTo(PHASE1_MIGRATIONS, '0009_ops_jobs')).at(-1)).toBe('0009_ops_jobs');
    expect(Object.keys(migrationsUpTo(PHASE1_MIGRATIONS, '0001_meta_and_locks'))).toEqual(['0001_meta_and_locks']);
  });

  it('refuses a migration this code does not know: BACKUP_SCHEMA_TOO_NEW with meta.migration', () => {
    let error: unknown;
    try {
      migrationsUpTo(PHASE1_MIGRATIONS, '9999_x');
    } catch (e) {
      error = e;
    }
    expect(isDomainError(error) && { code: error.code, meta: error.meta }).toEqual({
      code: 'BACKUP_SCHEMA_TOO_NEW',
      meta: { migration: '9999_x' },
    });
  });
});
