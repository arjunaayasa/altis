import type { Selectable } from 'kysely';
import type { DB } from '../../src/schema.js';

// Komunitas, member area: what tables.test.ts expects of the tables of migration 0042 (member_bookmarks,
// attachment_member_types), written out by hand, independently of TABLE_CLASSES/TABLE_COLUMNS/TABLE_KEYS, in the
// notations of tables.test.ts. Kept in its own module so that tables.test.ts only spreads it in (one block per list).

/** The tables of 0042. */
export type MemberAreaTable = 'member_bookmarks' | 'attachment_member_types';

export const MEMBER_AREA_CLASSES: Record<MemberAreaTable, 'data'> = { member_bookmarks: 'data', attachment_member_types: 'data' };

/** Which migration creates which tables. */
export const MEMBER_AREA_TABLES_BY_MIGRATION: Record<string, MemberAreaTable[]> = {
  '0042_member_area': ['member_bookmarks', 'attachment_member_types'],
};

export const MEMBER_AREA_PRIMARY_KEYS: Record<MemberAreaTable, string[]> = {
  member_bookmarks: ['member_id', 'record_id'],
  attachment_member_types: ['attachment_id', 'member_type_id'],
};

export interface MemberAreaIndexFacts {
  table: string;
  name: string;
  unique: boolean;
  columns: string[];
}

/** Every ix_/uq_ index of 0042. */
export const MEMBER_AREA_INDEXES: MemberAreaIndexFacts[] = [
  { table: 'attachment_member_types', name: 'ix_attachment_member_types_member_type_id', unique: false, columns: ['member_type_id'] },
  { table: 'member_bookmarks', name: 'ix_member_bookmarks_record_id', unique: false, columns: ['record_id'] },
];

/** The unique indexes above as `table(columns)` (none: both keys are primary keys). */
export const MEMBER_AREA_UNIQUE = MEMBER_AREA_INDEXES.filter((i) => i.unique).map((i) => `${i.table}(${i.columns.join(', ')})`);

/** A bookmark belongs to its member, a type list to its attachment. */
export const MEMBER_AREA_FOREIGN_KEYS: { table: string; column: string; refTable: string; refColumn: string; onDelete: string }[] = [
  { table: 'attachment_member_types', column: 'attachment_id', refTable: 'attachments', refColumn: 'id', onDelete: 'cascade' },
  { table: 'member_bookmarks', column: 'member_id', refTable: 'members', refColumn: 'id', onDelete: 'cascade' },
];

/** Every column in tables.test.ts's notation (`<type>[ null][ default][ auto]`). */
export const MEMBER_AREA_COLUMNS: Record<MemberAreaTable, Record<string, string>> = {
  member_bookmarks: { member_id: 'char(26)', record_id: 'char(26)', created_at: 'bigint' },
  attachment_member_types: { attachment_id: 'char(26)', member_type_id: 'char(26)' },
};

/** No column of these tables is `Generated`. */
export const MEMBER_AREA_DEFAULTS = { member_bookmarks: {}, attachment_member_types: {} } as const;

const EPOCH_MS = 1767225600000; // 2026-01-01T00:00:00Z

/**
 * Full rows of the tables of 0042, typed by `DB`, for the round trip of tables.test.ts: `memberId` is a member and
 * `attachmentId` an attachment of the other samples (both keys are foreign keys); the other ids are given.
 */
export function memberAreaSampleRows(o: {
  memberId: string;
  attachmentId: string;
  recordIds: readonly [string, string];
  memberTypeIds: readonly [string, string];
}): { [T in MemberAreaTable]: Selectable<DB[T]>[] } {
  return {
    member_bookmarks: [
      { member_id: o.memberId, record_id: o.recordIds[0], created_at: EPOCH_MS },
      { member_id: o.memberId, record_id: o.recordIds[1], created_at: EPOCH_MS + 1 },
    ],
    attachment_member_types: [
      { attachment_id: o.attachmentId, member_type_id: o.memberTypeIds[0] },
      { attachment_id: o.attachmentId, member_type_id: o.memberTypeIds[1] },
    ],
  };
}
