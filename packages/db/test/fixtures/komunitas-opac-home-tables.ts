import { newId } from '@altis/shared';
import type { Selectable } from 'kysely';
import type { DB } from '../../src/schema.js';

// Komunitas, OPAC home page: what tables.test.ts expects of the tables of migrations 0049 (the OPAC's popular titles)
// and 0050 (the loans per class), written out by hand, independently of TABLE_CLASSES/TABLE_COLUMNS/TABLE_KEYS, in the
// notations of tables.test.ts. Kept in its own module so that tables.test.ts only spreads it in.

/** The tables of 0049 and 0050. */
export type OpacHomeTableName = 'opac_popular_titles' | 'opac_class_activity';

/** The aggregates are volatile: rebuilt from the loans, never backed up. */
export const OPAC_HOME_CLASSES: Record<OpacHomeTableName, 'volatile'> = { opac_popular_titles: 'volatile', opac_class_activity: 'volatile' };

/** Which migration creates which tables. */
export const OPAC_HOME_TABLES_BY_MIGRATION: Record<string, OpacHomeTableName[]> = {
  '0049_opac_popular': ['opac_popular_titles'],
  '0050_opac_class_activity': ['opac_class_activity'],
};

export const OPAC_HOME_PRIMARY_KEYS: Record<OpacHomeTableName, string[]> = { opac_popular_titles: ['record_id', 'branch_id'], opac_class_activity: ['place'] };

/** Every ix_/uq_ index of 0049 and 0050 (0050 has none: its rows are read by their primary key). */
export const OPAC_HOME_INDEXES: { table: string; name: string; unique: boolean; columns: string[] }[] = [
  { table: 'opac_popular_titles', name: 'ix_opac_popular_titles_branch_id_loans', unique: false, columns: ['branch_id', 'loans'] },
];

/** Every column in tables.test.ts's notation (`<type>[ null][ default][ auto]`). */
export const OPAC_HOME_COLUMNS: Record<OpacHomeTableName, Record<string, string>> = {
  opac_popular_titles: { record_id: 'char(26)', branch_id: 'char(26)', loans: 'integer', refreshed_at: 'bigint' },
  opac_class_activity: { place: 'integer', class_name: 'varchar(64)', loans: 'integer', titles: 'integer', refreshed_at: 'bigint' },
};

/** No column has a database default. */
export const OPAC_HOME_DEFAULTS = { opac_popular_titles: {}, opac_class_activity: {} } as const;

const EPOCH_MS = 1767225600000; // 2026-01-01T00:00:00Z

/** Full rows of the tables of 0049 and 0050, typed by `DB` (tsc checks that every column is written), for the round trip. */
export function opacHomeSampleRows(o: { branchId: string; newId?: () => string }): { [T in OpacHomeTableName]: Selectable<DB[T]>[] } {
  const nextId = o.newId ?? newId;
  return {
    opac_popular_titles: [
      { record_id: nextId(), branch_id: o.branchId, loans: 12, refreshed_at: EPOCH_MS },
      { record_id: nextId(), branch_id: o.branchId, loans: 3, refreshed_at: EPOCH_MS },
    ],
    opac_class_activity: [
      { place: 1, class_name: 'XI IPA 2', loans: 312, titles: 148, refreshed_at: EPOCH_MS },
      { place: 2, class_name: 'X-1', loans: 254, titles: 119, refreshed_at: EPOCH_MS },
    ],
  };
}
