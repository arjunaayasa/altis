import { newId } from '@altis/shared';
import type { Selectable } from 'kysely';
import type { DB } from '../../src/schema.js';

// Komunitas, members and circulation: what tables.test.ts expects of the tables of migration 0040 (member types,
// members, member events, loan rules and loans), written out by hand, independently of TABLE_CLASSES/TABLE_COLUMNS/
// TABLE_KEYS, in the notations of tables.test.ts. Kept in its own module so that tables.test.ts only spreads it in (one
// block per list), like the catalogue's and K1's.

/** The tables of 0040. */
export type CirculationTable = 'member_types' | 'members' | 'member_events' | 'policies' | 'loans';

/** Every table of 0040 is class data. */
export const CIRCULATION_CLASSES: Record<CirculationTable, 'data'> = {
  member_types: 'data',
  members: 'data',
  member_events: 'data',
  policies: 'data',
  loans: 'data',
};

/** Which migration creates which tables, in creation order (parents before the tables that reference them). */
export const CIRCULATION_TABLES_BY_MIGRATION: Record<string, CirculationTable[]> = {
  '0040_members_circulation': ['member_types', 'members', 'member_events', 'policies', 'loans'],
};

/** The seeded tables of 0040: tables.test.ts empties them before its round trips (the seed is migrations.test.ts's). */
export const CIRCULATION_SEEDED_TABLES = ['member_types', 'policies'] as const;

export const CIRCULATION_PRIMARY_KEYS: Record<CirculationTable, string[]> = {
  member_types: ['id'],
  members: ['id'],
  member_events: ['id'],
  policies: ['id'],
  loans: ['id'],
};

export interface CirculationIndexFacts {
  table: string;
  name: string;
  unique: boolean;
  columns: string[];
}

/** Every ix_/uq_ index of 0040. */
export const CIRCULATION_INDEXES: CirculationIndexFacts[] = [
  { table: 'loans', name: 'ix_loans_item_id_loaned_at', unique: false, columns: ['item_id', 'loaned_at'] },
  { table: 'loans', name: 'ix_loans_loaned_on', unique: false, columns: ['loaned_on'] },
  { table: 'loans', name: 'ix_loans_member_id_returned_at', unique: false, columns: ['member_id', 'returned_at'] },
  { table: 'loans', name: 'ix_loans_record_id_returned_at', unique: false, columns: ['record_id', 'returned_at'] },
  { table: 'loans', name: 'ix_loans_returned_at_due_on', unique: false, columns: ['returned_at', 'due_on'] },
  { table: 'loans', name: 'ix_loans_returned_on', unique: false, columns: ['returned_on'] },
  { table: 'loans', name: 'uq_loans_open_item_id', unique: true, columns: ['open_item_id'] },
  { table: 'member_events', name: 'ix_member_events_member_id_at', unique: false, columns: ['member_id', 'at'] },
  { table: 'member_types', name: 'uq_member_types_code_key', unique: true, columns: ['code_key'] },
  { table: 'members', name: 'ix_members_class_name', unique: false, columns: ['class_name'] },
  { table: 'members', name: 'ix_members_expires_on', unique: false, columns: ['expires_on'] },
  { table: 'members', name: 'ix_members_identity_no', unique: false, columns: ['identity_no'] },
  { table: 'members', name: 'ix_members_member_type_id', unique: false, columns: ['member_type_id'] },
  { table: 'members', name: 'ix_members_name_key', unique: false, columns: ['name_key'] },
  { table: 'members', name: 'uq_members_member_no_key', unique: true, columns: ['member_no_key'] },
  { table: 'policies', name: 'uq_policies_code_key', unique: true, columns: ['code_key'] },
  { table: 'policies', name: 'uq_policies_scope_key', unique: true, columns: ['scope_key'] },
];

/** The unique indexes above as `table(columns)`. */
export const CIRCULATION_UNIQUE = CIRCULATION_INDEXES.filter((i) => i.unique).map((i) => `${i.table}(${i.columns.join(', ')})`);

export interface CirculationForeignKeyFacts {
  table: string;
  column: string;
  refTable: string;
  refColumn: string;
  onDelete: string;
}

/** Only a member owns rows of these tables: its events. A member's type, a rule's dimensions and a loan's links have none. */
export const CIRCULATION_FOREIGN_KEYS: CirculationForeignKeyFacts[] = [
  { table: 'member_events', column: 'member_id', refTable: 'members', refColumn: 'id', onDelete: 'cascade' },
];

const ARCHIVED_TRAIL = {
  archived_at: 'bigint null',
  version: 'integer default',
  created_at: 'bigint',
  created_by: 'char(26) null',
  updated_at: 'bigint',
  updated_by: 'char(26) null',
};

/** Every column in tables.test.ts's notation (`<type>[ null][ default][ auto]`). */
export const CIRCULATION_COLUMNS: Record<CirculationTable, Record<string, string>> = {
  member_types: {
    id: 'char(26)',
    code_display: 'varchar(191)',
    code_key: 'varchar(191)',
    name_id: 'varchar(191)',
    name_en: 'varchar(191) null',
    accred_group: 'varchar(16)',
    membership_days: 'smallint null',
    loan_limit: 'smallint null',
    holds_allowed: 'smallint default',
    holds_limit: 'smallint default',
    online_renewal: 'smallint default',
    sort_order: 'integer default',
    ...ARCHIVED_TRAIL,
  },
  members: {
    id: 'char(26)',
    member_no_display: 'varchar(64)',
    member_no_key: 'varchar(191)',
    member_type_id: 'char(26)',
    home_branch_id: 'char(26) null',
    status: 'varchar(16)',
    status_note: 'varchar(191) null',
    name: 'varchar(191)',
    name_key: 'varchar(191)',
    gender: 'varchar(8) null',
    birth_date: 'char(10) null',
    identity_no: 'varchar(64) null',
    institution: 'varchar(191) null',
    class_name: 'varchar(64) null',
    email: 'varchar(191) null',
    phone: 'varchar(64) null',
    address: 'text null',
    postal_code: 'varchar(16) null',
    mailing_address: 'text null',
    notes: 'text null',
    photo_file_id: 'char(26) null',
    locale: 'char(2) default',
    joined_on: 'char(10)',
    valid_from: 'char(10)',
    expires_on: 'char(10) null',
    password_hash: 'varchar(191) null',
    must_reset_password: 'smallint default',
    session_version: 'integer default',
    last_login_at: 'bigint null',
    anonymized_at: 'bigint null',
    source: 'varchar(191) null',
    ...ARCHIVED_TRAIL,
  },
  member_events: {
    id: 'char(26)',
    member_id: 'char(26)',
    at: 'bigint',
    type: 'varchar(16)',
    actor_type: 'varchar(32)',
    actor_id: 'char(26) null',
    meta: 'text',
  },
  policies: {
    id: 'char(26)',
    code_display: 'varchar(191)',
    code_key: 'varchar(191)',
    name: 'varchar(191)',
    member_type_id: 'char(26) null',
    collection_type_id: 'char(26) null',
    material_type_id: 'char(26) null',
    branch_id: 'char(26) null',
    scope_key: 'varchar(191)',
    loanable: 'smallint default',
    loan_days: 'smallint',
    loan_limit: 'smallint null',
    renew_limit: 'smallint default',
    fine_per_day_minor: 'bigint default',
    fine_cap_minor: 'bigint null',
    grace_days: 'smallint default',
    currency: 'char(3)',
    ...ARCHIVED_TRAIL,
  },
  loans: {
    id: 'char(26)',
    item_id: 'char(26) null',
    open_item_id: 'char(26) null',
    record_id: 'char(26) null',
    member_id: 'char(26) null',
    branch_id: 'char(26)',
    policy_id: 'char(26) null',
    loaned_on: 'char(10)',
    loaned_at: 'bigint',
    due_on: 'char(10)',
    renewals: 'smallint default',
    last_renewed_on: 'char(10) null',
    returned_on: 'char(10) null',
    returned_at: 'bigint null',
    return_branch_id: 'char(26) null',
    outcome: 'varchar(24) null',
    loan_days: 'smallint',
    renew_limit: 'smallint',
    grace_days: 'smallint',
    fine_per_day_minor: 'bigint',
    fine_cap_minor: 'bigint null',
    currency: 'char(3)',
    overrides: 'varchar(64) null',
    override_note: 'varchar(191) null',
    loaned_by: 'char(26) null',
    returned_by: 'char(26) null',
    source: 'varchar(16)',
    stat_ddc: 'varchar(8) null',
    stat_material_type_id: 'char(26) null',
    stat_collection_type_id: 'char(26) null',
    stat_location_id: 'char(26) null',
    stat_member_type_id: 'char(26) null',
    stat_accred_group: 'varchar(16) null',
    stat_class_name: 'varchar(64) null',
    version: 'integer default',
    created_at: 'bigint',
    created_by: 'char(26) null',
    updated_at: 'bigint',
    updated_by: 'char(26) null',
  },
};

/** The database default of every column the `DB` type marks `Generated`, per table (parents first). */
export const CIRCULATION_DEFAULTS = {
  member_types: { holds_allowed: 1, holds_limit: 2, online_renewal: 1, sort_order: 0, version: 0 },
  members: { locale: 'id', must_reset_password: 0, session_version: 0, version: 0 },
  member_events: {},
  policies: { loanable: 1, renew_limit: 0, fine_per_day_minor: 0, grace_days: 0, version: 0 },
  loans: { renewals: 0, version: 0 },
} as const;

const EPOCH_MS = 1767225600000; // 2026-01-01T00:00:00Z
const LATER_MS = EPOCH_MS + 86_400_000;

/**
 * Full rows of every table of 0040, typed by `DB` (tsc checks that every column is written), for the round trip of
 * tables.test.ts. Row B of a table sets every nullable column to null. `branchId` and `staffId` are rows of the Phase 1
 * sample. The ids are new ULIDs unless `newId` gives them; the times are fixed. Every name and number is made up, and
 * no code collides with a seeded one.
 */
export function circulationSampleRows(o: { branchId: string; staffId: string; newId?: () => string }): {
  [T in CirculationTable]: Selectable<DB[T]>[];
} {
  const nextId = o.newId ?? newId;
  const trail = { archived_at: LATER_MS, version: 2, created_at: EPOCH_MS, created_by: o.staffId, updated_at: LATER_MS, updated_by: o.staffId };
  const bare = { archived_at: null, version: 0, created_at: EPOCH_MS, created_by: null, updated_at: EPOCH_MS, updated_by: null };
  const typeId = nextId();
  const typeId2 = nextId();
  const memberId = nextId();
  const memberId2 = nextId();
  const policyId = nextId();
  const itemId = nextId();
  return {
    member_types: [
      {
        id: typeId,
        code_display: 'Siswa Contoh',
        code_key: 'SISWA CONTOH',
        name_id: 'Siswa Contoh',
        name_en: 'Sample pupil',
        accred_group: 'student',
        membership_days: 365,
        loan_limit: 3,
        holds_allowed: 0,
        holds_limit: 5,
        online_renewal: 0,
        sort_order: 30,
        ...trail,
      },
      {
        id: typeId2,
        code_display: 'TAMU-UJI',
        code_key: 'TAMU-UJI',
        name_id: 'Tamu Uji',
        name_en: null,
        accred_group: 'public',
        membership_days: null,
        loan_limit: null,
        holds_allowed: 1,
        holds_limit: 2,
        online_renewal: 1,
        sort_order: 0,
        ...bare,
      },
    ],
    members: [
      {
        id: memberId,
        member_no_display: 'b 0001',
        member_no_key: 'B 0001',
        member_type_id: typeId,
        home_branch_id: o.branchId,
        status: 'suspended',
        status_note: 'Kartu hilang',
        name: 'Ánggota Contoh',
        name_key: 'anggota contoh',
        gender: 'female',
        birth_date: '2010-05-17',
        identity_no: '0012345678',
        institution: 'Sekolah Contoh',
        class_name: 'VII-A',
        email: 'anggota@contoh.test',
        phone: '0800000000',
        address: 'Jalan Contoh 1',
        postal_code: '12345',
        mailing_address: 'Kotak Pos 1',
        notes: 'Catatan uji',
        photo_file_id: nextId(),
        locale: 'en',
        joined_on: '2025-07-14',
        valid_from: '2025-07-14',
        expires_on: '2026-07-14',
        password_hash: '$scrypt$uji',
        must_reset_password: 1,
        session_version: 3,
        last_login_at: LATER_MS,
        anonymized_at: LATER_MS,
        source: 'manual',
        ...trail,
      },
      {
        id: memberId2,
        member_no_display: 'M2',
        member_no_key: 'M2',
        member_type_id: typeId2,
        home_branch_id: null,
        status: 'active',
        status_note: null,
        name: 'Anggota Dua',
        name_key: 'anggota dua',
        gender: null,
        birth_date: null,
        identity_no: null,
        institution: null,
        class_name: null,
        email: null,
        phone: null,
        address: null,
        postal_code: null,
        mailing_address: null,
        notes: null,
        photo_file_id: null,
        locale: 'id',
        joined_on: '2026-01-01',
        valid_from: '2026-01-01',
        expires_on: null,
        password_hash: null,
        must_reset_password: 0,
        session_version: 0,
        last_login_at: null,
        anonymized_at: null,
        source: null,
        ...bare,
      },
    ],
    member_events: [
      {
        id: nextId(),
        member_id: memberId,
        at: EPOCH_MS,
        type: 'extended',
        actor_type: 'staff',
        actor_id: o.staffId,
        meta: '{"from":"2025-07-14","to":"2026-07-14"}',
      },
      { id: nextId(), member_id: memberId2, at: LATER_MS, type: 'created', actor_type: 'system', actor_id: null, meta: '{}' },
    ],
    policies: [
      {
        id: policyId,
        code_display: 'siswa-7',
        code_key: 'SISWA-7',
        name: 'Siswa tujuh hari',
        member_type_id: typeId,
        collection_type_id: nextId(),
        material_type_id: nextId(),
        branch_id: o.branchId,
        scope_key: `~${policyId}`,
        loanable: 0,
        loan_days: 14,
        loan_limit: 2,
        renew_limit: 3,
        fine_per_day_minor: 50_000,
        fine_cap_minor: 9_000_000_000,
        grace_days: 2,
        currency: 'IDR',
        ...trail,
      },
      {
        id: nextId(),
        code_display: 'UJI',
        code_key: 'UJI',
        name: 'Aturan uji',
        member_type_id: null,
        collection_type_id: null,
        material_type_id: null,
        branch_id: null,
        scope_key: `${typeId2}/*/*/*`,
        loanable: 1,
        loan_days: 0,
        loan_limit: null,
        renew_limit: 0,
        fine_per_day_minor: 0,
        fine_cap_minor: null,
        grace_days: 0,
        currency: 'USD',
        ...bare,
      },
    ],
    loans: [
      {
        id: nextId(),
        item_id: itemId,
        open_item_id: null,
        record_id: nextId(),
        member_id: memberId,
        branch_id: o.branchId,
        policy_id: policyId,
        loaned_on: '2026-01-02',
        loaned_at: EPOCH_MS,
        due_on: '2026-01-16',
        renewals: 2,
        last_renewed_on: '2026-01-09',
        returned_on: '2026-01-20',
        returned_at: LATER_MS,
        return_branch_id: o.branchId,
        outcome: 'returned',
        loan_days: 14,
        renew_limit: 3,
        grace_days: 2,
        fine_per_day_minor: 50_000,
        fine_cap_minor: 9_000_000_000,
        currency: 'IDR',
        overrides: 'limit,backdated',
        override_note: 'Dicatat dari buku tulis',
        loaned_by: o.staffId,
        returned_by: o.staffId,
        source: 'desk',
        stat_ddc: '590',
        stat_material_type_id: nextId(),
        stat_collection_type_id: nextId(),
        stat_location_id: nextId(),
        stat_member_type_id: typeId,
        stat_accred_group: 'student',
        stat_class_name: 'VII-A',
        version: 4,
        created_at: EPOCH_MS,
        created_by: o.staffId,
        updated_at: LATER_MS,
        updated_by: o.staffId,
      },
      {
        id: nextId(),
        item_id: null,
        open_item_id: null,
        record_id: null,
        member_id: null,
        branch_id: o.branchId,
        policy_id: null,
        loaned_on: '2020-02-29',
        loaned_at: EPOCH_MS,
        due_on: '2020-03-07',
        renewals: 0,
        last_renewed_on: null,
        returned_on: null,
        returned_at: null,
        return_branch_id: null,
        outcome: null,
        loan_days: 7,
        renew_limit: 1,
        grace_days: 0,
        fine_per_day_minor: 0,
        fine_cap_minor: null,
        currency: 'IDR',
        overrides: null,
        override_note: null,
        loaned_by: null,
        returned_by: null,
        source: 'migrated',
        stat_ddc: null,
        stat_material_type_id: null,
        stat_collection_type_id: null,
        stat_location_id: null,
        stat_member_type_id: null,
        stat_accred_group: null,
        stat_class_name: null,
        version: 0,
        created_at: EPOCH_MS,
        created_by: null,
        updated_at: EPOCH_MS,
        updated_by: null,
      },
    ],
  };
}
