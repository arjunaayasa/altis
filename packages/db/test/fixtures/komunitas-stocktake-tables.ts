import { newId } from '@altis/shared';
import type { Selectable } from 'kysely';
import type { DB } from '../../src/schema.js';

// Komunitas K4, stocktake: what tables.test.ts expects of the tables of migration 0048 (sessions, their copies and the
// unknown codes), written out by hand, independently of TABLE_CLASSES/TABLE_COLUMNS/TABLE_KEYS, in the notations of
// tables.test.ts. Kept in its own module so that tables.test.ts only spreads it in.

/** The tables of 0048. */
export type StocktakeTableName = 'stocktakes' | 'stocktake_items' | 'stocktake_unknown_codes';

/** Every table of 0048 is class data. */
export const STOCKTAKE_CLASSES: Record<StocktakeTableName, 'data'> = { stocktakes: 'data', stocktake_items: 'data', stocktake_unknown_codes: 'data' };

/** Which migration creates which tables. */
export const STOCKTAKE_TABLES_BY_MIGRATION: Record<string, StocktakeTableName[]> = { '0048_stocktakes': ['stocktakes', 'stocktake_items', 'stocktake_unknown_codes'] };

export const STOCKTAKE_PRIMARY_KEYS: Record<StocktakeTableName, string[]> = {
  stocktakes: ['id'],
  stocktake_items: ['stocktake_id', 'item_id'],
  stocktake_unknown_codes: ['stocktake_id', 'code_key'],
};

export interface StocktakeIndexFacts {
  table: string;
  name: string;
  unique: boolean;
  columns: string[];
}

/** Every ix_/uq_ index of 0048. */
export const STOCKTAKE_INDEXES: StocktakeIndexFacts[] = [
  { table: 'stocktake_items', name: 'ix_stocktake_items_stocktake_id_scanned_by', unique: false, columns: ['stocktake_id', 'scanned_by'] },
  { table: 'stocktake_items', name: 'ix_stocktake_items_stocktake_id_state', unique: false, columns: ['stocktake_id', 'state'] },
  { table: 'stocktakes', name: 'ix_stocktakes_branch_id_started_at', unique: false, columns: ['branch_id', 'started_at'] },
  { table: 'stocktakes', name: 'uq_stocktakes_active_key', unique: true, columns: ['active_key'] },
];

/** The unique indexes above as `table(columns)`. */
export const STOCKTAKE_UNIQUE = STOCKTAKE_INDEXES.filter((i) => i.unique).map((i) => `${i.table}(${i.columns.join(', ')})`);

/** The copies and the unknown codes belong to their session (CASCADE). */
export const STOCKTAKE_FOREIGN_KEYS: { table: string; column: string; refTable: string; refColumn: string; onDelete: string }[] = [
  { table: 'stocktake_items', column: 'stocktake_id', refTable: 'stocktakes', refColumn: 'id', onDelete: 'cascade' },
  { table: 'stocktake_unknown_codes', column: 'stocktake_id', refTable: 'stocktakes', refColumn: 'id', onDelete: 'cascade' },
];

/** Every column in tables.test.ts's notation (`<type>[ null][ default][ auto]`). */
export const STOCKTAKE_COLUMNS: Record<StocktakeTableName, Record<string, string>> = {
  stocktakes: {
    id: 'char(26)',
    branch_id: 'char(26)',
    name: 'varchar(191)',
    scope: 'text',
    status: 'varchar(16)',
    active_key: 'char(26) null',
    options: 'text null',
    total: 'integer default',
    found: 'integer default',
    misplaced: 'integer default',
    on_loan: 'integer default',
    unexpected: 'integer default',
    unknown_codes: 'integer default',
    started_at: 'bigint',
    started_by: 'char(26) null',
    finished_at: 'bigint null',
    finished_by: 'char(26) null',
    minutes_file_id: 'char(26) null',
    report_file_id: 'char(26) null',
    source: 'varchar(16)',
    version: 'integer default',
    created_at: 'bigint',
    created_by: 'char(26) null',
    updated_at: 'bigint',
    updated_by: 'char(26) null',
  },
  stocktake_items: {
    stocktake_id: 'char(26)',
    item_id: 'char(26)',
    expected: 'smallint',
    state: 'varchar(16)',
    expected_location_id: 'char(26) null',
    expected_status: 'varchar(16) null',
    stat_ddc: 'varchar(8) null',
    collection_type_id: 'char(26) null',
    scanned_at: 'bigint null',
    scanned_by: 'char(26) null',
    scanned_by_name: 'varchar(191) null',
    scanned_location_id: 'char(26) null',
    result: 'varchar(16) null',
  },
  stocktake_unknown_codes: {
    stocktake_id: 'char(26)',
    code_key: 'varchar(191)',
    code_display: 'varchar(64)',
    first_at: 'bigint',
    last_at: 'bigint',
    seen: 'integer default',
    scanned_by: 'char(26) null',
  },
};

/** The database default of every column the `DB` type marks `Generated`. */
export const STOCKTAKE_DEFAULTS = {
  stocktakes: { total: 0, found: 0, misplaced: 0, on_loan: 0, unexpected: 0, unknown_codes: 0, version: 0 },
  stocktake_items: {},
  stocktake_unknown_codes: { seen: 1 },
} as const;

const EPOCH_MS = 1767225600000; // 2026-01-01T00:00:00Z
const LATER_MS = EPOCH_MS + 86_400_000;

/**
 * Full rows of the tables of 0048, typed by `DB` (tsc checks that every column is written), for the round trip of
 * tables.test.ts. Row B sets every nullable column to null.
 */
export function stocktakeSampleRows(o: { branchId: string; staffId: string; newId?: () => string }): { [T in StocktakeTableName]: Selectable<DB[T]>[] } {
  const nextId = o.newId ?? newId;
  const a = nextId();
  const b = nextId();
  return {
    stocktakes: [
      {
        id: a,
        branch_id: o.branchId,
        name: 'Inventarisasi 2026',
        scope: JSON.stringify({ classPrefixes: ['5*'] }),
        status: 'active',
        active_key: o.branchId,
        options: JSON.stringify({ markMissing: true, restoreFound: true }),
        total: 10,
        found: 4,
        misplaced: 1,
        on_loan: 2,
        unexpected: 1,
        unknown_codes: 3,
        started_at: EPOCH_MS,
        started_by: o.staffId,
        finished_at: LATER_MS,
        finished_by: o.staffId,
        minutes_file_id: nextId(),
        report_file_id: nextId(),
        source: 'altis',
        version: 2,
        created_at: EPOCH_MS,
        created_by: o.staffId,
        updated_at: LATER_MS,
        updated_by: o.staffId,
      },
      {
        id: b,
        branch_id: o.branchId,
        name: 'Inventarisasi SLiMS',
        scope: '{}',
        status: 'finished',
        active_key: null,
        options: null,
        total: 0,
        found: 0,
        misplaced: 0,
        on_loan: 0,
        unexpected: 0,
        unknown_codes: 0,
        started_at: EPOCH_MS,
        started_by: null,
        finished_at: null,
        finished_by: null,
        minutes_file_id: null,
        report_file_id: null,
        source: 'migrated',
        version: 0,
        created_at: EPOCH_MS,
        created_by: null,
        updated_at: EPOCH_MS,
        updated_by: null,
      },
    ],
    stocktake_items: [
      {
        stocktake_id: a,
        item_id: nextId(),
        expected: 1,
        state: 'misplaced',
        expected_location_id: nextId(),
        expected_status: 'available',
        stat_ddc: '590',
        collection_type_id: nextId(),
        scanned_at: LATER_MS,
        scanned_by: o.staffId,
        scanned_by_name: 'Petugas Lama',
        scanned_location_id: nextId(),
        result: 'none',
      },
      {
        stocktake_id: b,
        item_id: nextId(),
        expected: 0,
        state: 'unexpected',
        expected_location_id: null,
        expected_status: null,
        stat_ddc: null,
        collection_type_id: null,
        scanned_at: null,
        scanned_by: null,
        scanned_by_name: null,
        scanned_location_id: null,
        result: null,
      },
    ],
    stocktake_unknown_codes: [
      { stocktake_id: a, code_key: 'X-1', code_display: 'x-1', first_at: EPOCH_MS, last_at: LATER_MS, seen: 3, scanned_by: o.staffId },
      { stocktake_id: b, code_key: 'X-2', code_display: 'x-2', first_at: EPOCH_MS, last_at: EPOCH_MS, seen: 1, scanned_by: null },
    ],
  };
}
