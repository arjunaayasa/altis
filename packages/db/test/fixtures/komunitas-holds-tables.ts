import { newId } from '@altis/shared';
import type { Selectable } from 'kysely';
import type { DB } from '../../src/schema.js';

// Komunitas, holds: what tables.test.ts expects of the table of migration 0041 (holds), written out by hand,
// independently of TABLE_CLASSES/TABLE_COLUMNS/TABLE_KEYS, in the notations of tables.test.ts. Kept in its own module so
// that tables.test.ts only spreads it in (one block per list), like the members and circulation fixture.

/** The tables of 0041. */
export type HoldsTable = 'holds';

export const HOLDS_CLASSES: Record<HoldsTable, 'data'> = { holds: 'data' };

/** Which migration creates which tables. */
export const HOLDS_TABLES_BY_MIGRATION: Record<string, HoldsTable[]> = { '0041_holds': ['holds'] };

export const HOLDS_PRIMARY_KEYS: Record<HoldsTable, string[]> = { holds: ['id'] };

export interface HoldsIndexFacts {
  table: string;
  name: string;
  unique: boolean;
  columns: string[];
}

/** Every ix_/uq_ index of 0041. */
export const HOLDS_INDEXES: HoldsIndexFacts[] = [
  { table: 'holds', name: 'ix_holds_member_id_status', unique: false, columns: ['member_id', 'status'] },
  { table: 'holds', name: 'ix_holds_record_id_status_placed_at', unique: false, columns: ['record_id', 'status', 'placed_at'] },
  { table: 'holds', name: 'ix_holds_status_pickup_until', unique: false, columns: ['status', 'pickup_until'] },
  { table: 'holds', name: 'uq_holds_active_key', unique: true, columns: ['active_key'] },
  { table: 'holds', name: 'uq_holds_trap_item_id', unique: true, columns: ['trap_item_id'] },
];

/** The unique indexes above as `table(columns)`. */
export const HOLDS_UNIQUE = HOLDS_INDEXES.filter((i) => i.unique).map((i) => `${i.table}(${i.columns.join(', ')})`);

/** A hold has no foreign key: its record, copy, member and branch are links the code keeps. */
export const HOLDS_FOREIGN_KEYS: { table: string; column: string; refTable: string; refColumn: string; onDelete: string }[] = [];

/** Every column in tables.test.ts's notation (`<type>[ null][ default][ auto]`). */
export const HOLDS_COLUMNS: Record<HoldsTable, Record<string, string>> = {
  holds: {
    id: 'char(26)',
    record_id: 'char(26)',
    item_id: 'char(26) null',
    pinned: 'smallint default',
    member_id: 'char(26) null',
    pickup_branch_id: 'char(26)',
    status: 'varchar(16)',
    active_key: 'varchar(191) null',
    trap_item_id: 'char(26) null',
    placed_on: 'char(10)',
    placed_at: 'bigint',
    placed_by: 'char(26) null',
    source: 'varchar(16)',
    expires_on: 'char(10) null',
    ready_at: 'bigint null',
    pickup_until: 'char(10) null',
    closed_at: 'bigint null',
    close_reason: 'varchar(24) null',
    shelf_cleared_at: 'bigint null',
    loan_id: 'char(26) null',
    version: 'integer default',
    created_at: 'bigint',
    created_by: 'char(26) null',
    updated_at: 'bigint',
    updated_by: 'char(26) null',
  },
};

/** The database default of every column the `DB` type marks `Generated`. */
export const HOLDS_DEFAULTS = {
  holds: { pinned: 0, version: 0 },
} as const;

const EPOCH_MS = 1767225600000; // 2026-01-01T00:00:00Z
const LATER_MS = EPOCH_MS + 86_400_000;

/**
 * Full rows of the table of 0041, typed by `DB` (tsc checks that every column is written), for the round trip of
 * tables.test.ts. Row B sets every nullable column to null. `branchId` and `staffId` are rows of the Phase 1 sample;
 * the ids are new ULIDs unless `newId` gives them; the times are fixed.
 */
export function holdsSampleRows(o: { branchId: string; staffId: string; newId?: () => string }): { [T in HoldsTable]: Selectable<DB[T]>[] } {
  const nextId = o.newId ?? newId;
  const recordId = nextId();
  const memberId = nextId();
  const itemId = nextId();
  return {
    holds: [
      {
        id: nextId(),
        record_id: recordId,
        item_id: itemId,
        pinned: 1,
        member_id: memberId,
        pickup_branch_id: o.branchId,
        status: 'ready',
        active_key: `${memberId}:${recordId}`,
        trap_item_id: itemId,
        placed_on: '2026-01-01',
        placed_at: EPOCH_MS,
        placed_by: o.staffId,
        source: 'desk',
        expires_on: '2026-03-31',
        ready_at: LATER_MS,
        pickup_until: '2026-01-05',
        closed_at: LATER_MS,
        close_reason: 'expired_pickup',
        shelf_cleared_at: LATER_MS,
        loan_id: nextId(),
        version: 3,
        created_at: EPOCH_MS,
        created_by: o.staffId,
        updated_at: LATER_MS,
        updated_by: o.staffId,
      },
      {
        id: nextId(),
        record_id: recordId,
        item_id: null,
        pinned: 0,
        member_id: null,
        pickup_branch_id: o.branchId,
        status: 'expired',
        active_key: null,
        trap_item_id: null,
        placed_on: '2020-02-29',
        placed_at: EPOCH_MS,
        placed_by: null,
        source: 'opac',
        expires_on: null,
        ready_at: null,
        pickup_until: null,
        closed_at: null,
        close_reason: null,
        shelf_cleared_at: null,
        loan_id: null,
        version: 0,
        created_at: EPOCH_MS,
        created_by: null,
        updated_at: EPOCH_MS,
        updated_by: null,
      },
    ],
  };
}
