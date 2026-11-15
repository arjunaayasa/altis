import { newId } from '@altis/shared';
import type { Selectable } from 'kysely';
import type { DB } from '../../src/schema.js';

// Komunitas, the circulation core: what tables.test.ts expects of the tables of migration 0042 (the library calendar,
// items read in place, numbered clearance letters), written out by hand, independently of TABLE_CLASSES/TABLE_COLUMNS/
// TABLE_KEYS, in the notations of tables.test.ts. Kept in its own module so that tables.test.ts only spreads it in.

/** The tables of 0042. */
export type CircCoreTable = 'calendars' | 'item_uses' | 'member_clearances';

/** Every table of 0042 is class data. */
export const CIRC_CORE_CLASSES: Record<CircCoreTable, 'data'> = {
  calendars: 'data',
  item_uses: 'data',
  member_clearances: 'data',
};

/** Which migration creates which tables, in creation order. */
export const CIRC_CORE_TABLES_BY_MIGRATION: Record<string, CircCoreTable[]> = {
  '0042_circulation_core': ['calendars', 'item_uses', 'member_clearances'],
};

export const CIRC_CORE_PRIMARY_KEYS: Record<CircCoreTable, string[]> = {
  calendars: ['id'],
  item_uses: ['id'],
  member_clearances: ['id'],
};

export interface CircCoreIndexFacts {
  table: string;
  name: string;
  unique: boolean;
  columns: string[];
}

/** Every ix_/uq_ index of 0042. */
export const CIRC_CORE_INDEXES: CircCoreIndexFacts[] = [
  { table: 'calendars', name: 'ix_calendars_branch_id_kind', unique: false, columns: ['branch_id', 'kind'] },
  { table: 'item_uses', name: 'ix_item_uses_item_id_used_on', unique: false, columns: ['item_id', 'used_on'] },
  { table: 'item_uses', name: 'ix_item_uses_record_id_used_on', unique: false, columns: ['record_id', 'used_on'] },
  { table: 'item_uses', name: 'ix_item_uses_used_on', unique: false, columns: ['used_on'] },
  { table: 'member_clearances', name: 'ix_member_clearances_member_id', unique: false, columns: ['member_id'] },
  { table: 'member_clearances', name: 'uq_member_clearances_year_seq', unique: true, columns: ['year', 'seq'] },
];

/** The unique indexes above as `table(columns)`. */
export const CIRC_CORE_UNIQUE = CIRC_CORE_INDEXES.filter((i) => i.unique).map((i) => `${i.table}(${i.columns.join(', ')})`);

export interface CircCoreForeignKeyFacts {
  table: string;
  column: string;
  refTable: string;
  refColumn: string;
  onDelete: string;
}

/** No table of 0042 has a foreign key. */
export const CIRC_CORE_FOREIGN_KEYS: CircCoreForeignKeyFacts[] = [];

/** Every column in tables.test.ts's notation (`<type>[ null][ default][ auto]`). */
export const CIRC_CORE_COLUMNS: Record<CircCoreTable, Record<string, string>> = {
  calendars: {
    id: 'char(26)',
    branch_id: 'char(26) null',
    kind: 'varchar(16)',
    weekday: 'smallint null',
    date_from: 'char(10) null',
    date_to: 'char(10) null',
    month_day_from: 'char(5) null',
    month_day_to: 'char(5) null',
    name: 'varchar(191)',
    archived_at: 'bigint null',
    version: 'integer default',
    created_at: 'bigint',
    created_by: 'char(26) null',
    updated_at: 'bigint',
    updated_by: 'char(26) null',
  },
  item_uses: {
    id: 'char(26)',
    item_id: 'char(26) null',
    record_id: 'char(26) null',
    branch_id: 'char(26)',
    used_on: 'char(10)',
    used_at: 'bigint',
    member_id: 'char(26) null',
    stat_ddc: 'varchar(8) null',
    stat_material_type_id: 'char(26) null',
    stat_collection_type_id: 'char(26) null',
    source: 'varchar(16)',
    created_by: 'char(26) null',
  },
  member_clearances: {
    id: 'char(26)',
    member_id: 'char(26)',
    year: 'smallint',
    seq: 'integer',
    number_display: 'varchar(64)',
    issued_on: 'char(10)',
    issued_at: 'bigint',
    issued_by: 'char(26)',
    purpose: 'varchar(16)',
    voided_at: 'bigint null',
    voided_by: 'char(26) null',
    void_reason: 'varchar(191) null',
  },
};

/** The database default of every column the `DB` type marks `Generated`, per table. */
export const CIRC_CORE_DEFAULTS = {
  calendars: { version: 0 },
  item_uses: {},
  member_clearances: {},
} as const;

const EPOCH_MS = 1767225600000; // 2026-01-01T00:00:00Z
const LATER_MS = EPOCH_MS + 86_400_000;

/**
 * Full rows of every table of 0042, typed by `DB` (tsc checks that every column is written), for the round trip of
 * tables.test.ts. Row B of a table sets every nullable column to null. `branchId` and `staffId` are rows of the Phase 1
 * sample. The ids are new ULIDs unless `newId` gives them; the times are fixed.
 */
export function circCoreSampleRows(o: { branchId: string; staffId: string; newId?: () => string }): {
  [T in CircCoreTable]: Selectable<DB[T]>[];
} {
  const nextId = o.newId ?? newId;
  return {
    calendars: [
      {
        id: nextId(),
        branch_id: o.branchId,
        kind: 'yearly',
        weekday: 7,
        date_from: '2026-03-20',
        date_to: '2026-03-21',
        month_day_from: '12-25',
        month_day_to: '12-26',
        name: 'Libur Natal',
        archived_at: LATER_MS,
        version: 3,
        created_at: EPOCH_MS,
        created_by: o.staffId,
        updated_at: LATER_MS,
        updated_by: o.staffId,
      },
      {
        id: nextId(),
        branch_id: null,
        kind: 'weekly',
        weekday: null,
        date_from: null,
        date_to: null,
        month_day_from: null,
        month_day_to: null,
        name: 'Minggu',
        archived_at: null,
        version: 0,
        created_at: EPOCH_MS,
        created_by: null,
        updated_at: EPOCH_MS,
        updated_by: null,
      },
    ],
    item_uses: [
      {
        id: nextId(),
        item_id: nextId(),
        record_id: nextId(),
        branch_id: o.branchId,
        used_on: '2026-01-02',
        used_at: EPOCH_MS,
        member_id: nextId(),
        stat_ddc: '2X',
        stat_material_type_id: nextId(),
        stat_collection_type_id: nextId(),
        source: 'desk',
        created_by: o.staffId,
      },
      {
        id: nextId(),
        item_id: null,
        record_id: null,
        branch_id: o.branchId,
        used_on: '2020-02-29',
        used_at: LATER_MS,
        member_id: null,
        stat_ddc: null,
        stat_material_type_id: null,
        stat_collection_type_id: null,
        source: 'migrated',
        created_by: null,
      },
    ],
    member_clearances: [
      {
        id: nextId(),
        member_id: nextId(),
        year: 2026,
        seq: 12,
        number_display: 'BP/2026/0012',
        issued_on: '2026-06-15',
        issued_at: EPOCH_MS,
        issued_by: o.staffId,
        purpose: 'graduation',
        voided_at: LATER_MS,
        voided_by: o.staffId,
        void_reason: 'Salah cetak',
      },
      {
        id: nextId(),
        member_id: nextId(),
        year: 2026,
        seq: 13,
        number_display: 'BP/2026/0013',
        issued_on: '2026-06-15',
        issued_at: LATER_MS,
        issued_by: o.staffId,
        purpose: 'transfer',
        voided_at: null,
        voided_by: null,
        void_reason: null,
      },
    ],
  };
}
