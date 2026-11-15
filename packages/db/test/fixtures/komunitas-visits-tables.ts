import { newId } from '@altis/shared';
import type { Selectable } from 'kysely';
import type { DB } from '../../src/schema.js';

// Komunitas, visits: what tables.test.ts expects of the tables of migration 0043 (guestbook stations and visits),
// written out by hand, independently of TABLE_CLASSES/TABLE_COLUMNS/TABLE_KEYS, in the notations of tables.test.ts.
// Kept in its own module so that tables.test.ts only spreads it in (one block per list).

/** The tables of 0041. */
export type VisitsTableName = 'visit_stations' | 'visits';

export const VISITS_CLASSES: Record<VisitsTableName, 'data'> = { visit_stations: 'data', visits: 'data' };

/** Which migration creates which tables, in creation order. */
export const VISITS_TABLES_BY_MIGRATION: Record<string, VisitsTableName[]> = { '0043_visits': ['visit_stations', 'visits'] };

export const VISITS_PRIMARY_KEYS: Record<VisitsTableName, string[]> = { visit_stations: ['id'], visits: ['id'] };

export interface VisitsIndexFacts {
  table: string;
  name: string;
  unique: boolean;
  columns: string[];
}

/** Every ix_/uq_ index of 0041. */
export const VISITS_INDEXES: VisitsIndexFacts[] = [
  { table: 'visit_stations', name: 'ix_visit_stations_branch_id', unique: false, columns: ['branch_id'] },
  { table: 'visit_stations', name: 'uq_visit_stations_token_hash', unique: true, columns: ['token_hash'] },
  { table: 'visits', name: 'ix_visits_branch_id_visited_on', unique: false, columns: ['branch_id', 'visited_on'] },
  { table: 'visits', name: 'ix_visits_member_id_visited_at', unique: false, columns: ['member_id', 'visited_at'] },
  { table: 'visits', name: 'ix_visits_visited_on', unique: false, columns: ['visited_on'] },
  { table: 'visits', name: 'ix_visits_visited_on_class_name', unique: false, columns: ['visited_on', 'class_name'] },
  { table: 'visits', name: 'uq_visits_day_key', unique: true, columns: ['day_key'] },
];

/** The unique indexes above as `table(columns)`. */
export const VISITS_UNIQUE = VISITS_INDEXES.filter((i) => i.unique).map((i) => `${i.table}(${i.columns.join(', ')})`);

/** No foreign keys: a station and a visit point at a branch, a room and a member by id. */
export const VISITS_FOREIGN_KEYS: { table: string; column: string; refTable: string; refColumn: string; onDelete: string }[] = [];

/** Every column in tables.test.ts's notation (`<type>[ null][ default][ auto]`). */
export const VISITS_COLUMNS: Record<VisitsTableName, Record<string, string>> = {
  visit_stations: {
    id: 'char(26)',
    branch_id: 'char(26)',
    location_id: 'char(26) null',
    name: 'varchar(191)',
    token_hash: 'char(64) null',
    activation_hash: 'char(64) null',
    activation_expires_at: 'bigint null',
    activated_at: 'bigint null',
    last_seen_at: 'bigint null',
    revoked_at: 'bigint null',
    version: 'integer default',
    created_at: 'bigint',
    created_by: 'char(26) null',
    updated_at: 'bigint',
    updated_by: 'char(26) null',
  },
  visits: {
    id: 'char(26)',
    branch_id: 'char(26)',
    location_id: 'char(26) null',
    visited_on: 'char(10)',
    visited_at: 'bigint',
    source: 'varchar(16)',
    member_id: 'char(26) null',
    member_type_id: 'char(26) null',
    accred_group: 'varchar(16) null',
    class_name: 'varchar(64) null',
    guest_name: 'varchar(191) null',
    guest_institution: 'varchar(191) null',
    purpose: 'varchar(16) null',
    headcount: 'smallint default',
    is_repeat: 'smallint default',
    station_id: 'char(26) null',
    day_key: 'varchar(191) null',
    note: 'varchar(191) null',
    voided_at: 'bigint null',
    voided_by: 'char(26) null',
    created_by: 'char(26) null',
  },
};

/** The database default of every column the `DB` type marks `Generated`, per table. */
export const VISITS_DEFAULTS = {
  visit_stations: { version: 0 },
  visits: { headcount: 1, is_repeat: 0 },
} as const;

const EPOCH_MS = 1767225600000; // 2026-01-01T00:00:00Z
const LATER_MS = EPOCH_MS + 86_400_000;

/**
 * Full rows of every table of 0041, typed by `DB`, for the round trip of tables.test.ts. Row B of a table sets every
 * nullable column to null. `branchId` and `staffId` are rows of the Phase 1 sample; the ids are new ULIDs unless
 * `newId` gives them. Every name is made up.
 */
export function visitsSampleRows(o: { branchId: string; staffId: string; newId?: () => string }): {
  [T in VisitsTableName]: Selectable<DB[T]>[];
} {
  const nextId = o.newId ?? newId;
  const stationId = nextId();
  const memberId = nextId();
  return {
    visit_stations: [
      {
        id: stationId,
        branch_id: o.branchId,
        location_id: nextId(),
        name: 'Buku tamu pintu depan',
        token_hash: 'a'.repeat(64),
        activation_hash: 'b'.repeat(64),
        activation_expires_at: LATER_MS,
        activated_at: EPOCH_MS,
        last_seen_at: LATER_MS,
        revoked_at: LATER_MS,
        version: 3,
        created_at: EPOCH_MS,
        created_by: o.staffId,
        updated_at: LATER_MS,
        updated_by: o.staffId,
      },
      {
        id: nextId(),
        branch_id: o.branchId,
        location_id: null,
        name: 'Ruang baca',
        token_hash: null,
        activation_hash: null,
        activation_expires_at: null,
        activated_at: null,
        last_seen_at: null,
        revoked_at: null,
        version: 0,
        created_at: EPOCH_MS,
        created_by: null,
        updated_at: EPOCH_MS,
        updated_by: null,
      },
    ],
    visits: [
      {
        id: nextId(),
        branch_id: o.branchId,
        location_id: nextId(),
        visited_on: '2026-01-01',
        visited_at: EPOCH_MS,
        source: 'desk',
        member_id: memberId,
        member_type_id: nextId(),
        accred_group: 'student',
        class_name: 'VII-A',
        guest_name: 'Tamu Contoh',
        guest_institution: 'Sekolah Tetangga',
        purpose: 'read',
        headcount: 30,
        is_repeat: 1,
        station_id: stationId,
        day_key: `desk:${memberId}:${o.branchId}:2026-01-01`,
        note: 'Kunjungan kelas',
        voided_at: LATER_MS,
        voided_by: o.staffId,
        created_by: o.staffId,
      },
      {
        id: nextId(),
        branch_id: o.branchId,
        location_id: null,
        visited_on: '2020-02-29',
        visited_at: EPOCH_MS,
        source: 'migrated',
        member_id: null,
        member_type_id: null,
        accred_group: null,
        class_name: null,
        guest_name: null,
        guest_institution: null,
        purpose: null,
        headcount: 1,
        is_repeat: 0,
        station_id: null,
        day_key: null,
        note: null,
        voided_at: null,
        voided_by: null,
        created_by: null,
      },
    ],
  };
}
