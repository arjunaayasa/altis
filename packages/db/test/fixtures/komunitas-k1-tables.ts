import { newId } from '@altis/shared';
import type { Selectable } from 'kysely';
import type { DB } from '../../src/schema.js';

// Komunitas K1: what tables.test.ts expects of the tables of migrations 0030–0033 (reports and accreditation), written
// out by hand, independently of TABLE_CLASSES/TABLE_COLUMNS/TABLE_KEYS, in the notations of tables.test.ts. Kept in
// its own module so that tables.test.ts only spreads it in (one block per list), like the catalogue's.

/** The Komunitas K1 tables. */
export type K1Table =
  | 'report_runs'
  | 'accred_periods'
  | 'accred_answers'
  | 'accred_results'
  | 'accred_snapshots'
  | 'accred_evidence'
  | 'usage_stats'
  | 'usage_group_map'
  | 'library_activities'
  | 'library_staff'
  | 'staff_trainings'
  | 'library_partnerships'
  | 'library_budgets'
  | 'library_documents';

/** Report runs and computed accreditation results are volatile (rebuilt, never restored); everything else is data. */
export const K1_CLASSES: Record<K1Table, 'data' | 'volatile'> = {
  report_runs: 'volatile',
  accred_periods: 'data',
  accred_answers: 'data',
  accred_results: 'volatile',
  accred_snapshots: 'data',
  accred_evidence: 'data',
  usage_stats: 'data',
  usage_group_map: 'data',
  library_activities: 'data',
  library_staff: 'data',
  staff_trainings: 'data',
  library_partnerships: 'data',
  library_budgets: 'data',
  library_documents: 'data',
};

/** Which migration creates which tables, in creation order (parents before the tables that reference them). */
export const K1_TABLES_BY_MIGRATION: Record<string, K1Table[]> = {
  '0030_reports_core': ['report_runs'],
  '0031_accreditation': [
    'accred_periods',
    'accred_answers',
    'accred_results',
    'accred_snapshots',
    'accred_evidence',
    'usage_stats',
    'usage_group_map',
  ],
  '0032_library_registers': [
    'library_activities',
    'library_staff',
    'staff_trainings',
    'library_partnerships',
    'library_budgets',
    'library_documents',
  ],
  // Four columns on records, one on items and one index on items: no table, so no class literal.
  '0033_catalog_accred_fields': [],
};

export const K1_PRIMARY_KEYS: Record<K1Table, string[]> = {
  report_runs: ['id'],
  accred_periods: ['id'],
  accred_answers: ['period_id', 'indicator_code'],
  accred_results: ['period_id', 'indicator_code'],
  accred_snapshots: ['id'],
  accred_evidence: ['id'],
  usage_stats: ['source', 'metric', 'span_from', 'span_to', 'branch_key', 'group_key'],
  usage_group_map: ['group_key'],
  library_activities: ['id'],
  library_staff: ['id'],
  staff_trainings: ['id'],
  library_partnerships: ['id'],
  library_budgets: ['id'],
  library_documents: ['id'],
};

export interface K1IndexFacts {
  table: string;
  name: string;
  unique: boolean;
  columns: string[];
}

/** Every ix_/uq_ index the K1 migrations make, the accession register's order on items (0033) included. */
export const K1_INDEXES: K1IndexFacts[] = [
  { table: 'accred_evidence', name: 'ix_accred_evidence_entity_entity_id', unique: false, columns: ['entity', 'entity_id'] },
  {
    table: 'accred_evidence',
    name: 'ix_accred_evidence_period_id_indicator_code',
    unique: false,
    columns: ['period_id', 'indicator_code'],
  },
  { table: 'accred_periods', name: 'ix_accred_periods_starts_on', unique: false, columns: ['starts_on'] },
  { table: 'accred_snapshots', name: 'ix_accred_snapshots_period_id_created_at', unique: false, columns: ['period_id', 'created_at'] },
  { table: 'items', name: 'ix_items_received_date_inventory_no', unique: false, columns: ['received_date', 'inventory_no'] }, // 0033
  { table: 'library_activities', name: 'ix_library_activities_held_on', unique: false, columns: ['held_on'] },
  { table: 'library_activities', name: 'ix_library_activities_kind_held_on', unique: false, columns: ['kind', 'held_on'] },
  { table: 'library_budgets', name: 'uq_library_budgets_scope_key_year', unique: true, columns: ['scope_key', 'year'] },
  { table: 'library_documents', name: 'ix_library_documents_kind', unique: false, columns: ['kind'] },
  { table: 'library_partnerships', name: 'ix_library_partnerships_starts_on', unique: false, columns: ['starts_on'] },
  { table: 'library_staff', name: 'ix_library_staff_role', unique: false, columns: ['role'] },
  { table: 'report_runs', name: 'ix_report_runs_created_by_created_at', unique: false, columns: ['created_by', 'created_at'] },
  { table: 'report_runs', name: 'ix_report_runs_expires_at', unique: false, columns: ['expires_at'] },
  {
    table: 'staff_trainings',
    name: 'ix_staff_trainings_library_staff_id_held_on',
    unique: false,
    columns: ['library_staff_id', 'held_on'],
  },
];

/** The unique indexes above as `table(columns)`. */
export const K1_UNIQUE = K1_INDEXES.filter((i) => i.unique).map((i) => `${i.table}(${i.columns.join(', ')})`);

export interface K1ForeignKeyFacts {
  table: string;
  column: string;
  refTable: string;
  refColumn: string;
  onDelete: string;
}

/**
 * Only ownership relations have a foreign key: a period owns its answers and snapshots, a staff member their trainings.
 * Computed results, evidence and the registers' file links have none.
 */
export const K1_FOREIGN_KEYS: K1ForeignKeyFacts[] = [
  { table: 'accred_answers', column: 'period_id', refTable: 'accred_periods', refColumn: 'id', onDelete: 'cascade' },
  { table: 'accred_snapshots', column: 'period_id', refTable: 'accred_periods', refColumn: 'id', onDelete: 'cascade' },
  { table: 'staff_trainings', column: 'library_staff_id', refTable: 'library_staff', refColumn: 'id', onDelete: 'cascade' },
];

/**
 * Key columns that are not binary on MySQL/MariaDB, each with the reason. Every other text column of a primary or
 * unique key is. usage_stats's primary key has six columns: four binary 191-character columns plus the two dates would
 * leave it a few bytes under MySQL's 3 072-byte index limit, so its two code columns stay plain.
 */
export const K1_NON_BINARY_KEY_COLUMNS: Record<string, string> = {
  'usage_stats.source': 'a lower-case source code ALTIS writes itself (manual or slims)',
  'usage_stats.metric': 'a lower-case metric code ALTIS writes itself',
  'usage_stats.span_from': 'a calendar date YYYY-MM-DD (digits and dashes only)',
  'usage_stats.span_to': 'a calendar date YYYY-MM-DD (digits and dashes only)',
};

const ARCHIVED_TRAIL = {
  archived_at: 'bigint null',
  version: 'integer default',
  created_at: 'bigint',
  created_by: 'char(26) null',
  updated_at: 'bigint',
  updated_by: 'char(26) null',
};

/** Every column in tables.test.ts's notation (`<type>[ null][ default][ auto]`). */
export const K1_COLUMNS: Record<K1Table, Record<string, string>> = {
  report_runs: {
    id: 'char(26)',
    report_id: 'varchar(64)',
    format: 'varchar(8)',
    locale: 'char(2)',
    params: 'text',
    personal: 'smallint',
    status: 'varchar(16)',
    row_count: 'integer null',
    non_latin_rows: 'integer null',
    output_name: 'varchar(191) null',
    output_size: 'bigint null',
    error_code: 'varchar(64) null',
    job_id: 'char(26) null',
    expires_at: 'bigint null',
    created_at: 'bigint',
    created_by: 'char(26) null',
    finished_at: 'bigint null',
  },
  accred_periods: {
    id: 'char(26)',
    branch_id: 'char(26) null',
    name: 'varchar(191)',
    kind: 'varchar(16)',
    starts_on: 'char(10)',
    ends_on: 'char(10)',
    instrument_id: 'varchar(32)',
    status: 'varchar(16)',
    frozen_at: 'bigint null',
    frozen_by: 'char(26) null',
    profile: 'text',
    students: 'integer null',
    teachers: 'integer null',
    edu_staff: 'integer null',
    classes: 'integer null',
    population_served: 'integer null',
    teachers_using: 'integer null',
    all_registered_confirmed: 'smallint default',
    user_pcs: 'smallint null',
    staff_pcs: 'smallint null',
    ict_devices: 'smallint null',
    scanners: 'smallint null',
    floor_m2: 'integer null',
    bandwidth_mbps: 'integer null',
    hours_per_week: 'smallint null',
    services: 'text null',
    external_website_url: 'varchar(191) null',
    ...ARCHIVED_TRAIL,
  },
  accred_answers: {
    period_id: 'char(26)',
    indicator_code: 'varchar(191)',
    answer: 'char(1)',
    mode: 'varchar(16)',
    note: 'text null',
    updated_at: 'bigint',
    updated_by: 'char(26) null',
  },
  accred_results: {
    period_id: 'char(26)',
    indicator_code: 'varchar(191)',
    payload: 'text',
    computed_at: 'bigint',
  },
  accred_snapshots: {
    id: 'char(26)',
    period_id: 'char(26)',
    instrument_id: 'varchar(32)',
    result_values: 'text',
    na: 'varchar(8) null',
    na_low: 'varchar(8)',
    na_high: 'varchar(8)',
    grade: 'char(1) null',
    prerequisites_met: 'smallint',
    dossier_file_id: 'char(26) null',
    note: 'varchar(191) null',
    created_at: 'bigint',
    created_by: 'char(26) null',
  },
  accred_evidence: {
    id: 'char(26)',
    period_id: 'char(26) null',
    indicator_code: 'varchar(16) null',
    evidence_code: 'varchar(32) null',
    entity: 'varchar(32) null',
    entity_id: 'char(26) null',
    file_id: 'char(26)',
    caption: 'varchar(191)',
    sort_order: 'integer default',
    created_at: 'bigint',
    created_by: 'char(26) null',
  },
  usage_stats: {
    source: 'varchar(16)',
    metric: 'varchar(32)',
    span_from: 'char(10)',
    span_to: 'char(10)',
    branch_key: 'varchar(191)',
    group_key: 'varchar(191)',
    value: 'bigint',
    run_id: 'char(26) null',
    updated_at: 'bigint',
    updated_by: 'char(26) null',
  },
  usage_group_map: {
    group_key: 'varchar(191)',
    label: 'varchar(191)',
    accred_group: 'varchar(16) null',
    updated_at: 'bigint',
    updated_by: 'char(26) null',
  },
  library_activities: {
    id: 'char(26)',
    branch_id: 'char(26) null',
    kind: 'varchar(32)',
    title: 'varchar(191)',
    held_on: 'char(10)',
    ended_on: 'char(10) null',
    participants: 'integer null',
    partner: 'varchar(191) null',
    uses_library_facility: 'smallint default',
    external_speaker: 'smallint default',
    description: 'text null',
    ...ARCHIVED_TRAIL,
  },
  library_staff: {
    id: 'char(26)',
    branch_id: 'char(26) null',
    staff_user_id: 'char(26) null',
    name: 'varchar(191)',
    position: 'varchar(191) null',
    role: 'varchar(16)',
    is_librarian: 'smallint default',
    employment: 'varchar(16) null',
    education_level: 'varchar(16) null',
    education_library: 'smallint',
    library_training: 'smallint',
    competency_cert: 'smallint',
    association_member: 'smallint',
    appointment_ref: 'varchar(191) null',
    starts_on: 'char(10) null',
    ends_on: 'char(10) null',
    ...ARCHIVED_TRAIL,
  },
  staff_trainings: {
    id: 'char(26)',
    library_staff_id: 'char(26)',
    title: 'varchar(191)',
    organizer: 'varchar(191) null',
    held_on: 'char(10)',
    hours: 'smallint null',
    certificate_file_id: 'char(26) null',
    ...ARCHIVED_TRAIL,
  },
  library_partnerships: {
    id: 'char(26)',
    branch_id: 'char(26) null',
    partner: 'varchar(191)',
    kind: 'varchar(16)',
    starts_on: 'char(10)',
    ends_on: 'char(10) null',
    scope: 'text null',
    document_file_id: 'char(26) null',
    ...ARCHIVED_TRAIL,
  },
  library_budgets: {
    id: 'char(26)',
    scope_key: 'varchar(191)',
    branch_id: 'char(26) null',
    year: 'smallint',
    library_minor: 'bigint',
    parent_minor: 'bigint null',
    parent_nonpersonnel_minor: 'bigint null',
    collection_minor: 'bigint null',
    community_minor: 'bigint null',
    currency: 'char(3)',
    note: 'text null',
    ...ARCHIVED_TRAIL,
  },
  library_documents: {
    id: 'char(26)',
    branch_id: 'char(26) null',
    kind: 'varchar(32)',
    title: 'varchar(191)',
    reference: 'varchar(191) null',
    issued_on: 'char(10) null',
    issued_by: 'varchar(191) null',
    aspect_codes: 'text null',
    valid_until: 'char(10) null',
    file_id: 'char(26) null',
    ...ARCHIVED_TRAIL,
  },
};

/** The database default of every column the `DB` type marks `Generated`, per K1 table (parents first). */
export const K1_DEFAULTS = {
  report_runs: {},
  accred_periods: { all_registered_confirmed: 0, version: 0 },
  accred_answers: {},
  accred_results: {},
  accred_snapshots: {},
  accred_evidence: { sort_order: 0 },
  usage_stats: {},
  usage_group_map: {},
  library_activities: { uses_library_facility: 0, external_speaker: 0, version: 0 },
  library_staff: { is_librarian: 0, version: 0 },
  staff_trainings: { version: 0 },
  library_partnerships: { version: 0 },
  library_budgets: { version: 0 },
  library_documents: { version: 0 },
} as const;

const EPOCH_MS = 1767225600000; // 2026-01-01T00:00:00Z
const LATER_MS = EPOCH_MS + 86_400_000;

/**
 * Full rows of every K1 table, typed by `DB` (tsc checks that every column is written), for the round trip of
 * tables.test.ts. Row B of a table sets every nullable column to null. `branchId` and `staffId` are rows of the
 * Phase 1 sample. The ids are new ULIDs unless `newId` gives them; the times are fixed. Every name and number is
 * made up.
 */
export function k1SampleRows(o: { branchId: string; staffId: string; newId?: () => string }): { [T in K1Table]: Selectable<DB[T]>[] } {
  const nextId = o.newId ?? newId;
  const trail = { archived_at: LATER_MS, version: 2, created_at: EPOCH_MS, created_by: o.staffId, updated_at: LATER_MS, updated_by: o.staffId };
  const bare = { archived_at: null, version: 0, created_at: EPOCH_MS, created_by: null, updated_at: EPOCH_MS, updated_by: null };
  const periodId = nextId();
  const periodId2 = nextId();
  const staffRowId = nextId();
  const activityId = nextId();
  const documentId = nextId();
  const fileId = nextId();
  const runId = nextId();
  return {
    report_runs: [
      {
        id: runId,
        report_id: 'collection.ddc_recap',
        format: 'xlsx',
        locale: 'en',
        params: '{"def":{"asOf":"2026-01-01"},"pdf":{"paper":"F4"}}',
        personal: 1,
        status: 'succeeded',
        row_count: 120_000,
        non_latin_rows: 2,
        output_name: `${runId}.xlsx`,
        output_size: 5_000_000_000,
        error_code: 'REPORT_TOO_LARGE',
        job_id: nextId(),
        expires_at: LATER_MS,
        created_at: EPOCH_MS,
        created_by: o.staffId,
        finished_at: LATER_MS,
      },
      {
        id: nextId(),
        report_id: 'accreditation.dossier',
        format: 'zip',
        locale: 'id',
        params: '{"def":{}}',
        personal: 0,
        status: 'queued',
        row_count: null,
        non_latin_rows: null,
        output_name: null,
        output_size: null,
        error_code: null,
        job_id: null,
        expires_at: null,
        created_at: EPOCH_MS,
        created_by: null,
        finished_at: null,
      },
    ],
    accred_periods: [
      {
        id: periodId,
        branch_id: o.branchId,
        name: 'Tahun Pelajaran 2025/2026',
        kind: 'school_year',
        starts_on: '2025-07-01',
        ends_on: '2026-06-30',
        instrument_id: 'sch-sd-2025',
        status: 'frozen',
        frozen_at: LATER_MS,
        frozen_by: o.staffId,
        profile: '{"schoolHead":"Kepala Contoh","libraryHeadId":"000000"}',
        students: 480,
        teachers: 32,
        edu_staff: 6,
        classes: 18,
        population_served: 520,
        teachers_using: 20,
        all_registered_confirmed: 1,
        user_pcs: 4,
        staff_pcs: 2,
        ict_devices: 3,
        scanners: 1,
        floor_m2: 120,
        bandwidth_mbps: 50,
        hours_per_week: 40,
        services: '["reading_room","circulation"]',
        external_website_url: 'https://perpustakaan.example.test',
        ...trail,
      },
      {
        id: periodId2,
        branch_id: null,
        name: 'Tahun 2026',
        kind: 'calendar_year',
        starts_on: '2026-01-01',
        ends_on: '2026-12-31',
        instrument_id: 'general-stats',
        status: 'open',
        frozen_at: null,
        frozen_by: null,
        profile: '{}',
        students: null,
        teachers: null,
        edu_staff: null,
        classes: null,
        population_served: null,
        teachers_using: null,
        all_registered_confirmed: 0,
        user_pcs: null,
        staff_pcs: null,
        ict_devices: null,
        scanners: null,
        floor_m2: null,
        bandwidth_mbps: null,
        hours_per_week: null,
        services: null,
        external_website_url: null,
        ...bare,
      },
    ],
    accred_answers: [
      { period_id: periodId, indicator_code: 'SCH-K1', answer: 'b', mode: 'override', note: 'Dicek ulang', updated_at: LATER_MS, updated_by: o.staffId },
      // The same code in another case: another key (binary on MySQL/MariaDB too).
      { period_id: periodId, indicator_code: 'sch-k1', answer: 'a', mode: 'manual', note: null, updated_at: EPOCH_MS, updated_by: null },
    ],
    accred_results: [
      { period_id: periodId, indicator_code: '_meta', payload: '{"status":"ready"}', computed_at: LATER_MS },
      { period_id: periodId, indicator_code: 'SNP-S-01', payload: '{"value":12}', computed_at: EPOCH_MS },
    ],
    accred_snapshots: [
      {
        id: nextId(),
        period_id: periodId,
        instrument_id: 'sch-sd-2025',
        result_values: '{"i":{},"s":{},"p":{},"e":{}}',
        na: '81.25',
        na_low: '80.00',
        na_high: '82.50',
        grade: 'B',
        prerequisites_met: 1,
        dossier_file_id: fileId,
        note: 'Sebelum visitasi',
        created_at: LATER_MS,
        created_by: o.staffId,
      },
      {
        id: nextId(),
        period_id: periodId,
        instrument_id: 'sch-sd-2025',
        result_values: '{}',
        na: null,
        na_low: '0.00',
        na_high: '100.00',
        grade: null,
        prerequisites_met: 0,
        dossier_file_id: null,
        note: null,
        created_at: EPOCH_MS,
        created_by: null,
      },
    ],
    accred_evidence: [
      {
        id: nextId(),
        period_id: periodId,
        indicator_code: 'SCH-K3',
        evidence_code: 'policy_document',
        entity: 'library_documents',
        entity_id: documentId,
        file_id: fileId,
        caption: 'Kebijakan pengembangan koleksi',
        sort_order: 3,
        created_at: LATER_MS,
        created_by: o.staffId,
      },
      {
        id: nextId(),
        period_id: null,
        indicator_code: null,
        evidence_code: null,
        entity: null,
        entity_id: null,
        file_id: nextId(),
        caption: 'Foto kegiatan',
        sort_order: 0,
        created_at: EPOCH_MS,
        created_by: null,
      },
    ],
    usage_stats: [
      {
        source: 'manual',
        metric: 'visits',
        span_from: '2025-07-01',
        span_to: '2025-07-31',
        branch_key: '',
        group_key: 'grp:student',
        value: 2 ** 40, // BIGINT
        run_id: nextId(),
        updated_at: LATER_MS,
        updated_by: o.staffId,
      },
      {
        // The same cell with a member-type key differing only in case: another key (binary).
        source: 'manual',
        metric: 'visits',
        span_from: '2025-07-01',
        span_to: '2025-07-31',
        branch_key: '',
        group_key: 'GRP:student',
        value: 0,
        run_id: null,
        updated_at: EPOCH_MS,
        updated_by: null,
      },
    ],
    usage_group_map: [
      { group_key: 'slims_type:1', label: 'Siswa', accred_group: 'student', updated_at: LATER_MS, updated_by: o.staffId },
      { group_key: 'member_unknown', label: 'Anggota tidak dikenal', accred_group: null, updated_at: EPOCH_MS, updated_by: null },
    ],
    library_activities: [
      {
        id: activityId,
        branch_id: o.branchId,
        kind: 'satisfaction_survey',
        title: 'Survei kepuasan pemustaka',
        held_on: '2025-09-01',
        ended_on: '2025-09-05',
        participants: 150,
        partner: 'Dinas Perpustakaan Kota',
        uses_library_facility: 1,
        external_speaker: 1,
        description: 'Angket daring',
        ...trail,
      },
      {
        id: nextId(),
        branch_id: null,
        kind: 'other',
        title: 'Kegiatan',
        held_on: '2025-10-01',
        ended_on: null,
        participants: null,
        partner: null,
        uses_library_facility: 0,
        external_speaker: 0,
        description: null,
        ...bare,
      },
    ],
    library_staff: [
      {
        id: staffRowId,
        branch_id: o.branchId,
        staff_user_id: o.staffId,
        name: 'Pustakawan Contoh',
        position: 'Kepala Perpustakaan',
        role: 'head',
        is_librarian: 1,
        employment: 'civil_servant',
        education_level: 's1',
        education_library: 1,
        library_training: 1,
        competency_cert: 1,
        association_member: 1,
        appointment_ref: '800/001/2025',
        starts_on: '2020-01-02',
        ends_on: '2030-12-31',
        ...trail,
      },
      {
        id: nextId(),
        branch_id: null,
        staff_user_id: null,
        name: 'Tenaga Teknis',
        position: null,
        role: 'technical',
        is_librarian: 0,
        employment: null,
        education_level: null,
        education_library: 0,
        library_training: 0,
        competency_cert: 0,
        association_member: 0,
        appointment_ref: null,
        starts_on: null,
        ends_on: null,
        ...bare,
      },
    ],
    staff_trainings: [
      {
        id: nextId(),
        library_staff_id: staffRowId,
        title: 'Diklat pengelolaan perpustakaan sekolah',
        organizer: 'Perpustakaan Nasional',
        held_on: '2024-05-06',
        hours: 40,
        certificate_file_id: fileId,
        ...trail,
      },
      {
        id: nextId(),
        library_staff_id: staffRowId,
        title: 'Bimtek katalogisasi',
        organizer: null,
        held_on: '2025-02-03',
        hours: null,
        certificate_file_id: null,
        ...bare,
      },
    ],
    library_partnerships: [
      {
        id: nextId(),
        branch_id: o.branchId,
        partner: 'Perpustakaan Daerah',
        kind: 'mou',
        starts_on: '2025-01-15',
        ends_on: '2027-01-14',
        scope: 'Layanan keliling',
        document_file_id: fileId,
        ...trail,
      },
      {
        id: nextId(),
        branch_id: null,
        partner: 'Taman Bacaan',
        kind: 'other',
        starts_on: '2025-03-01',
        ends_on: null,
        scope: null,
        document_file_id: null,
        ...bare,
      },
    ],
    library_budgets: [
      {
        id: nextId(),
        scope_key: '',
        branch_id: o.branchId,
        year: 2025,
        library_minor: 2 ** 40,
        parent_minor: 5_000_000_000_00,
        parent_nonpersonnel_minor: 1_000_000_000_00,
        collection_minor: 30_000_000_00,
        community_minor: 2_000_000_00,
        currency: 'IDR',
        note: 'Dana BOS',
        ...trail,
      },
      {
        // An archived year keeps its row under `~<id>`, so the same year can be entered again.
        id: nextId(),
        scope_key: `~${nextId()}`,
        branch_id: null,
        year: 2025,
        library_minor: 0,
        parent_minor: null,
        parent_nonpersonnel_minor: null,
        collection_minor: null,
        community_minor: null,
        currency: 'IDR',
        note: null,
        ...bare,
      },
    ],
    library_documents: [
      {
        id: documentId,
        branch_id: o.branchId,
        kind: 'collection_policy',
        title: 'Kebijakan pengembangan koleksi',
        reference: '421/015/2025',
        issued_on: '2025-07-14',
        issued_by: 'Kepala Sekolah',
        aspect_codes: '["a1","a2","a3","a4","a5"]',
        valid_until: '2028-07-13',
        file_id: fileId,
        ...trail,
      },
      {
        id: nextId(),
        branch_id: null,
        kind: 'other',
        title: 'Catatan',
        reference: null,
        issued_on: null,
        issued_by: null,
        aspect_codes: null,
        valid_until: null,
        file_id: null,
        ...bare,
      },
    ],
  };
}
