import type { ColumnKind } from './ddl.js';
import type { TableName } from './registry.js';

export type { ColumnKind } from './ddl.js';

// The column registry (decision C11): every column of every table, in table-definition order, and every table's
// keys, written by hand from the migrations 0001–0009 (Phase 2: 0020–0029; Komunitas K1: 0030–0033; members and circulation: 0040) and the runner's own tables (ddl.ts ensureBootstrap,
// migrator.ts). Backup and restore read it for the canonical row (registry column order), the per-version checks of
// an archive's rows (columnsAt) and the length checks against the code's DDL; restore's read-only pre-pass reads the
// unique keys (S5c) and the load order follows the foreign keys (order.ts).
//
// It is never derived from the catalog at runtime: test/columns.test.ts (the drift test) checks it against the live
// catalog of every dialect after every migration. Column additions follow expand-contract (spec §6.4): a migration
// that adds a column (ensureColumn) adds it here too, at the end of its table, with `since` = that migration.
//
// Under the test profile the registry also holds the release fixtures' table `test_fixture` (decision D1d-26), which
// only a database at fixture level 2 or 3 has: the registry then describes the union of the fixture levels, and what
// one database holds is columnsAt(table, <its schema version>) ([] for a table its schema does not have yet).

/** One column of a table, as its migration declared it. */
export interface ColumnSpec {
  readonly name: string;
  readonly kind: ColumnKind;
  /**
   * The most characters the column holds, for every character kind: 26 for `id`/`ulid`, 10 for `date`, 191 for
   * `key191`, as declared for `char`/`varchar`. Absent for the number kinds and for `text`/`json` (MySQL/MariaDB TEXT
   * holds at most 65 535 bytes).
   */
  readonly length?: number;
  readonly nullable: boolean;
  /**
   * The migration that added the column (its table's migration, or a later one that called ensureColumn).
   * {@link RUNNER_TABLES_SINCE} for the runner's own tables, which exist before any migration.
   */
  readonly since: string;
}

/** A foreign key: `column` of the table references `refColumn` of `table`. */
export interface ForeignKeyRef {
  readonly column: string;
  readonly table: TableName;
  readonly refColumn: string;
}

/** The keys of one table. */
export interface TableKeySpec {
  /** The primary key's columns, in key order. */
  readonly pk: readonly string[];
  /** Every UNIQUE index (the primary key not included), each as its columns in index order. */
  readonly unique: readonly (readonly string[])[];
  readonly fks: readonly ForeignKeyRef[];
}

/**
 * The `since` of the tables the migration runner makes before any migration (schema_tables, schema_meta,
 * schema_migrations, schema_migrations_lock; rulings R4, R27): it sorts before every migration name.
 * The other migration lane's two tables (schema_migrations_edition, schema_migrations_edition_lock) are made the same
 * way and carry it too.
 */
export const RUNNER_TABLES_SINCE = '0000_runner';

type Col = Omit<ColumnSpec, 'since'>;

/** The column helpers of ddl.ts's TableBuilder, as specs: each column NOT NULL unless wrapped in {@link nul}. */
const t = {
  id: (name = 'id'): Col => ({ name, kind: 'id', length: 26, nullable: false }),
  serial: (name: string): Col => ({ name, kind: 'serial', nullable: false }),
  ulid: (name: string): Col => ({ name, kind: 'ulid', length: 26, nullable: false }),
  bool: (name: string): Col => ({ name, kind: 'bool', nullable: false }),
  money: (name: string): Col => ({ name, kind: 'money', nullable: false }),
  timestamp: (name: string): Col => ({ name, kind: 'timestamp', nullable: false }),
  date: (name: string): Col => ({ name, kind: 'date', length: 10, nullable: false }),
  json: (name: string): Col => ({ name, kind: 'json', nullable: false }),
  key191: (name: string): Col => ({ name, kind: 'key191', length: 191, nullable: false }),
  varchar: (name: string, length: number): Col => ({ name, kind: 'varchar', length, nullable: false }),
  char: (name: string, length: number): Col => ({ name, kind: 'char', length, nullable: false }),
  text: (name: string): Col => ({ name, kind: 'text', nullable: false }),
  smallint: (name: string): Col => ({ name, kind: 'smallint', nullable: false }),
  int: (name: string): Col => ({ name, kind: 'int', nullable: false }),
  bigint: (name: string): Col => ({ name, kind: 'bigint', nullable: false }),
};

/** `.nullable()`. */
function nul(c: Col): Col {
  return { ...c, nullable: true };
}

/** The columns `list`, added by migration `since`. */
function added(since: string, ...list: Col[]): ColumnSpec[] {
  return list.map((c) => Object.freeze({ ...c, since }));
}

/** The trail columns (spec §6.1): acting staff user's id or null. */
function trail(since: string): ColumnSpec[] {
  return added(since, t.timestamp('created_at'), nul(t.ulid('created_by')), t.timestamp('updated_at'), nul(t.ulid('updated_by')));
}

const M0001 = '0001_meta_and_locks';
const M0002 = '0002_org_and_identity';
const M0003 = '0003_sessions_and_limits';
const M0004 = '0004_settings_and_audit';
const M0005 = '0005_jobs_events_notifications';
const M0006 = '0006_files_custom_idempotency';
const M0007 = '0007_license_releases_backups';
const M0009 = '0009_ops_jobs';
// ---- Phase 2 (catalog): Task 1 ----
const M0020 = '0020_catalog_authorities';
const M0021 = '0021_catalog_records';
const M0022 = '0022_catalog_items';
const M0023 = '0023_opac_pages';
const M0024 = '0024_search_index';
const M0025 = '0025_catalog_runs_migration';
const M0026 = '0026_custom_fields_i18n';
const M0029 = '0029_search_token_version';
// ---- Komunitas K1 (tables) ----
const M0030 = '0030_reports_core';
const M0031 = '0031_accreditation';
const M0032 = '0032_library_registers';
const M0033 = '0033_catalog_accred_fields';
// ---- Komunitas (members and circulation) ----
const M0040 = '0040_members_circulation';
// ---- Komunitas (holds) ----
const M0041 = '0041_holds';
// ---- Komunitas (member area) ----
const M0042 = '0042_member_area';

/** `archived_at` + `version`, then the trail columns (Phase 2 spec §2.2 "arsip+ver, jejak"). */
function archivedTrail(since: string): ColumnSpec[] {
  return [...added(since, nul(t.timestamp('archived_at')), t.int('version')), ...trail(since)];
}

function frozen(list: ColumnSpec[]): readonly ColumnSpec[] {
  return Object.freeze(list);
}

/**
 * The columns of every table, in table-definition order (the order of the catalog: a column added later comes
 * last), keyed in the order of TABLE_CLASSES (registry.ts).
 */
export const TABLE_COLUMNS: Readonly<Record<TableName, readonly ColumnSpec[]>> = Object.freeze({
  branches: frozen([
    ...added(
      M0002,
      t.id(),
      t.key191('code_key'),
      t.varchar('code_display', 191),
      t.varchar('name', 191),
      nul(t.text('address')),
      t.varchar('timezone', 64),
      t.bool('is_default'),
      nul(t.timestamp('archived_at')),
      t.int('version'),
    ),
    ...trail(M0002),
  ]),
  staff_users: frozen([
    ...added(
      M0002,
      t.id(),
      t.key191('username_key'),
      t.varchar('username_display', 191),
      t.varchar('name', 191),
      nul(t.key191('email_key')),
      nul(t.varchar('email_display', 191)),
      t.varchar('password_hash', 191),
      t.varchar('status', 32),
      nul(t.varchar('locale', 8)),
      nul(t.text('totp_secret_enc')),
      t.bool('totp_enabled'),
      t.bigint('totp_last_step'),
      t.bool('totp_reenroll'),
      t.bool('mfa_required'),
      t.bool('must_change_password'),
      t.int('authz_version'),
      nul(t.timestamp('last_login_at')),
      t.int('version'),
    ),
    ...trail(M0002),
  ]),
  staff_recovery_codes: frozen(
    added(M0002, t.id(), t.ulid('user_id'), t.char('code_hash', 64), nul(t.timestamp('used_at')), t.timestamp('created_at')),
  ),
  roles: frozen([
    ...added(
      M0002,
      t.id(),
      t.key191('key'),
      t.varchar('name', 191),
      nul(t.text('description')),
      t.bool('is_system'),
      t.bool('mfa_required'),
      t.int('version'),
    ),
    ...trail(M0002),
  ]),
  role_permissions: frozen(added(M0002, t.ulid('role_id'), t.key191('permission'))),
  user_roles: frozen(
    added(
      M0002,
      t.id(),
      t.ulid('user_id'),
      t.ulid('role_id'),
      nul(t.ulid('branch_id')),
      t.key191('scope_key'),
      t.timestamp('created_at'),
      nul(t.ulid('created_by')),
    ),
  ),
  settings: frozen(
    added(
      M0004,
      t.key191('key'),
      nul(t.text('value')),
      t.bool('is_secret'),
      t.varchar('scope', 32),
      t.timestamp('updated_at'),
      nul(t.ulid('updated_by')),
    ),
  ),
  files: frozen(
    added(
      M0006,
      t.id(),
      t.varchar('original_name', 191),
      t.varchar('mime', 191),
      t.bigint('size'),
      t.char('sha256', 64),
      t.varchar('context', 64),
      nul(t.varchar('owner_type', 32)),
      nul(t.key191('owner_id')),
      t.varchar('access', 32),
      t.varchar('status', 32),
      t.timestamp('created_at'),
      nul(t.ulid('created_by')),
    ),
  ),
  custom_field_defs: frozen([
    ...added(
      M0006,
      t.id(),
      t.key191('entity'),
      t.key191('code_key'),
      t.varchar('code_display', 191),
      t.varchar('label', 191),
      t.varchar('type', 32),
      nul(t.json('options')),
      t.bool('is_required'),
      t.int('sort_order'),
      nul(t.timestamp('archived_at')),
      t.int('version'),
    ),
    ...trail(M0006),
    // ---- Phase 2 (catalog): Task 1 ----
    ...added(M0026, nul(t.varchar('label_en', 191)), t.bool('is_public'), t.bool('is_searchable')),
  ]),
  custom_values: frozen(
    added(M0006, t.ulid('field_id'), t.ulid('entity_id'), t.json('value'), t.timestamp('updated_at'), nul(t.ulid('updated_by'))),
  ),
  notifications: frozen(
    added(
      M0005,
      t.id(),
      nul(t.key191('audience_permission')),
      nul(t.ulid('user_id')),
      t.varchar('type', 64),
      t.key191('title_key'),
      t.json('params'),
      nul(t.text('link')),
      t.timestamp('created_at'),
      t.timestamp('expires_at'),
    ),
  ),
  notification_reads: frozen(added(M0005, t.ulid('notification_id'), t.ulid('user_id'), t.timestamp('read_at'))),
  schedules: frozen(
    added(M0005, t.key191('name'), t.varchar('expr', 191), t.bool('enabled'), t.timestamp('next_run_at'), nul(t.timestamp('last_run_at'))),
  ),
  audit_log: frozen(
    added(
      M0004,
      t.id(),
      t.bigint('seq'),
      t.timestamp('at'),
      t.varchar('actor_type', 32),
      nul(t.ulid('actor_id')),
      t.varchar('action', 64),
      nul(t.varchar('entity', 64)),
      nul(t.key191('entity_id')),
      nul(t.ulid('branch_id')),
      nul(t.varchar('ip', 45)),
      t.json('meta'),
      t.char('prev_hash', 64),
      t.char('hash', 64),
    ),
  ),
  releases_log: frozen(
    added(
      M0007,
      t.id(),
      t.varchar('version', 32),
      t.varchar('action', 32),
      nul(t.varchar('from_version', 32)),
      t.varchar('status', 32),
      t.timestamp('started_at'),
      nul(t.timestamp('finished_at')),
      nul(t.ulid('backup_id')),
      nul(t.text('detail')),
    ),
  ),
  backups: frozen(
    added(
      M0007,
      t.id(),
      t.varchar('kind', 32),
      nul(t.bigint('size')),
      nul(t.char('sha256', 64)),
      t.varchar('schema_version', 32),
      t.varchar('app_version', 32),
      t.varchar('dialect', 32),
      t.varchar('consistency', 32),
      t.varchar('status', 32),
      t.timestamp('created_at'),
    ),
  ),
  license_state: frozen(
    added(
      M0007,
      t.ulid('install_id'),
      nul(t.text('license_raw')),
      nul(t.varchar('status_cache', 32)),
      nul(t.timestamp('checked_at')),
      nul(t.timestamp('grace_until')),
      nul(t.timestamp('last_heartbeat_at')),
      t.timestamp('clock_high_water'),
    ),
  ),
  audit_head: frozen(added(M0004, t.smallint('id'), t.bigint('last_seq'), t.char('last_hash', 64))),
  sessions: frozen(
    added(
      M0003,
      t.char('id', 64),
      t.varchar('subject_type', 32),
      t.ulid('subject_id'),
      t.timestamp('created_at'),
      t.timestamp('last_seen_at'),
      t.timestamp('expires_at'),
      nul(t.varchar('ip', 45)),
      nul(t.varchar('user_agent', 191)),
      t.bool('mfa_passed'),
      nul(t.timestamp('reauth_at')),
      nul(t.char('remember_selector', 24)),
      t.int('authz_version'),
    ),
  ),
  remember_tokens: frozen(
    added(
      M0003,
      t.char('selector', 24),
      t.char('validator_hash', 64),
      nul(t.char('prev_validator_hash', 64)),
      nul(t.timestamp('rotated_at')),
      t.varchar('subject_type', 32),
      t.ulid('subject_id'),
      t.timestamp('expires_at'),
      t.bool('mfa_bound'),
      nul(t.timestamp('last_used_at')),
    ),
  ),
  password_resets: frozen(
    added(
      M0003,
      t.char('token_hash', 64),
      t.varchar('subject_type', 32),
      t.ulid('subject_id'),
      t.timestamp('expires_at'),
      nul(t.timestamp('used_at')),
    ),
  ),
  rate_limits: frozen(added(M0003, t.char('bucket', 64), t.timestamp('window_start'), t.text('bucket_name'), t.int('count'))),
  idempotency_keys: frozen(
    added(
      M0006,
      t.key191('subject_type'),
      t.ulid('subject_id'),
      t.key191('key'),
      t.char('request_hash', 64),
      t.varchar('status', 32),
      t.timestamp('locked_until'),
      nul(t.smallint('response_status')),
      nul(t.text('response_body')),
      t.timestamp('created_at'),
    ),
  ),
  events: frozen(
    added(M0005, t.serial('seq'), t.varchar('channel', 128), t.varchar('type', 64), t.json('payload'), t.timestamp('created_at')),
  ),
  event_consumers: frozen(
    added(M0005, t.key191('name'), t.bigint('cursor'), t.bool('enabled'), t.timestamp('updated_at'), t.bool('needs_full_reindex')),
  ),
  jobs: frozen([
    ...added(
      M0005,
      t.id(),
      t.varchar('type', 64),
      t.json('payload'),
      nul(t.text('secret_param')),
      t.varchar('status', 32),
      t.timestamp('run_at'),
      t.int('attempts'),
      t.int('max_attempts'),
      nul(t.key191('unique_key')),
      nul(t.key191('lock_token')),
      nul(t.key191('locked_by')),
      nul(t.timestamp('locked_until')),
      t.bool('cancel_requested'),
      t.int('progress'),
      nul(t.text('progress_message')),
      nul(t.text('last_error')),
      nul(t.ulid('created_by')),
      t.timestamp('created_at'),
      t.timestamp('updated_at'),
      nul(t.timestamp('finished_at')),
    ),
    ...added(M0009, t.bool('point_of_no_return')),
  ]),
  locks: frozen(added(M0001, t.key191('name'), t.key191('owner'), t.timestamp('until'))),
  upload_sessions: frozen(
    added(
      M0006,
      t.id(),
      t.key191('owner'),
      t.varchar('context', 64),
      t.bigint('size'),
      t.char('sha256', 64),
      t.int('chunk_size'),
      t.bigint('received'),
      t.timestamp('expires_at'),
    ),
  ),
  schema_migrations: frozen(added(RUNNER_TABLES_SINCE, t.key191('name'), t.varchar('timestamp', 64))),
  schema_migrations_lock: frozen(added(RUNNER_TABLES_SINCE, t.key191('id'), t.int('is_locked'))),
  schema_meta: frozen(
    added(
      RUNNER_TABLES_SINCE,
      t.smallint('id'),
      t.varchar('schema_version', 32),
      t.varchar('min_code_version', 32),
      nul(t.char('install_id', 26)),
    ),
  ),
  schema_tables: frozen(added(RUNNER_TABLES_SINCE, t.key191('name'), t.varchar('class', 16), t.varchar('created_by', 191))),
  // ---- Phase 2 (catalog): Task 1 ----
  languages: frozen([
    ...added(M0020, t.id(), t.varchar('code_display', 191), t.key191('code_key'), t.varchar('name_id', 191), t.varchar('name_en', 191)),
    ...archivedTrail(M0020),
  ]),
  material_types: frozen([
    ...added(
      M0020,
      t.id(),
      t.varchar('code_display', 191),
      t.key191('code_key'),
      t.varchar('name_id', 191),
      t.varchar('name_en', 191),
      t.char('marc_type', 1),
      t.char('marc_level', 1),
      t.varchar('content_type', 8),
      t.varchar('media_type', 8),
      t.varchar('carrier_type', 8),
      t.varchar('schema_type', 32),
      t.varchar('dcmi_type', 32),
      t.json('template'),
      t.int('sort_order'),
    ),
    ...archivedTrail(M0020),
  ]),
  publishers: frozen([
    ...added(M0020, t.id(), t.varchar('name_display', 191), t.key191('name_key'), nul(t.varchar('place', 191)), nul(t.ulid('merged_into'))),
    ...archivedTrail(M0020),
  ]),
  agents: frozen([
    ...added(
      M0020,
      t.id(),
      t.key191('type'),
      t.varchar('name_display', 191),
      t.key191('name_key'),
      nul(t.varchar('dates', 64)),
      nul(t.varchar('authority_source', 64)),
      nul(t.varchar('authority_ref', 191)),
      nul(t.text('note')),
      nul(t.ulid('merged_into')),
    ),
    ...archivedTrail(M0020),
  ]),
  subjects: frozen([
    ...added(
      M0020,
      t.id(),
      t.key191('type'),
      t.varchar('term_display', 191),
      t.key191('term_key'),
      nul(t.varchar('classification', 64)),
      nul(t.text('scope_note')),
      nul(t.varchar('authority_source', 64)),
      nul(t.ulid('merged_into')),
    ),
    ...archivedTrail(M0020),
  ]),
  subject_relations: frozen(added(M0020, t.ulid('subject_id'), t.ulid('related_id'), t.key191('rel'))),
  records: frozen([
    ...added(
      M0021,
      t.id(),
      t.ulid('material_type_id'),
      t.text('title'),
      nul(t.text('subtitle')),
      nul(t.text('responsibility')),
      t.key191('title_key'),
      nul(t.varchar('edition', 191)),
      nul(t.varchar('material_detail', 191)),
      nul(t.ulid('publisher_id')),
      nul(t.varchar('publication_place', 191)),
      nul(t.char('publication_year', 4)),
      nul(t.varchar('publication_date_text', 64)),
      nul(t.varchar('physical_desc', 191)),
      nul(t.varchar('series', 191)),
      nul(t.varchar('classification', 64)),
      nul(t.varchar('call_number', 64)),
      nul(t.ulid('language_id')),
      nul(t.varchar('content_type', 8)),
      nul(t.varchar('media_type', 8)),
      nul(t.varchar('carrier_type', 8)),
      nul(t.text('summary')),
      nul(t.text('notes')),
      nul(t.ulid('cover_file_id')),
      t.bool('opac_visible'),
      t.bool('promoted'),
      nul(t.varchar('source', 191)),
      nul(t.ulid('merged_into')),
      t.timestamp('changed_at'),
    ),
    ...archivedTrail(M0021),
    // ---- Komunitas K1 (tables): the accreditation fields ----
    ...added(
      M0033,
      nul(t.varchar('audience', 16)),
      nul(t.varchar('local_work', 16)),
      nul(t.varchar('local_work_kind', 16)),
      nul(t.varchar('reference_kind', 16)),
    ),
  ]),
  record_identifiers: frozen(
    added(
      M0021,
      t.id(),
      t.ulid('record_id'),
      t.key191('type'),
      t.varchar('value_display', 64),
      t.key191('value_key'),
      nul(t.varchar('qualifier', 64)),
      t.bool('is_valid'),
      t.int('sort_order'),
    ),
  ),
  record_marc_extra: frozen(
    added(M0021, t.id(), t.ulid('record_id'), t.char('tag', 3), t.varchar('ind1', 1), t.varchar('ind2', 1), t.text('data'), t.int('sort_order')),
  ),
  record_agents: frozen(added(M0021, t.ulid('record_id'), t.ulid('agent_id'), t.key191('role'), t.bool('is_main'), t.int('sort_order'))),
  record_subjects: frozen(added(M0021, t.ulid('record_id'), t.ulid('subject_id'), t.bool('is_primary'), t.int('sort_order'))),
  record_relations: frozen(added(M0021, t.ulid('record_id'), t.ulid('related_id'), t.key191('type'))),
  attachments: frozen([
    ...added(
      M0021,
      t.id(),
      t.ulid('record_id'),
      t.varchar('kind', 8),
      nul(t.ulid('file_id')),
      nul(t.text('url')),
      t.varchar('title', 191),
      nul(t.text('description')),
      t.varchar('access', 16),
      nul(t.text('legacy_access_limit')),
      t.bigint('read_count'),
      t.int('sort_order'),
    ),
    ...archivedTrail(M0021),
  ]),
  locations: frozen([
    ...added(
      M0022,
      t.id(),
      t.ulid('branch_id'),
      nul(t.ulid('parent_id')),
      t.varchar('kind', 8),
      t.varchar('code_display', 191),
      t.key191('code_key'),
      t.varchar('name', 191),
      nul(t.varchar('shelf_hint', 40)),
      nul(t.varchar('class_from', 32)),
      nul(t.varchar('class_to', 32)),
      nul(t.ulid('map_file_id')),
      nul(t.smallint('map_x')),
      nul(t.smallint('map_y')),
      nul(t.smallint('map_w')),
      nul(t.smallint('map_h')),
      t.bool('is_public'),
      t.int('sort_order'),
    ),
    ...archivedTrail(M0022),
  ]),
  collection_types: frozen([
    ...added(
      M0022,
      t.id(),
      t.varchar('code_display', 191),
      t.key191('code_key'),
      t.varchar('name_id', 191),
      t.varchar('name_en', 191),
      t.bool('loanable'),
      t.bool('self_service'),
      t.int('sort_order'),
    ),
    ...archivedTrail(M0022),
  ]),
  suppliers: frozen([
    ...added(
      M0022,
      t.id(),
      t.varchar('code_display', 191),
      t.key191('code_key'),
      t.varchar('name', 191),
      nul(t.varchar('contact_name', 191)),
      nul(t.varchar('phone', 64)),
      nul(t.varchar('email', 191)),
      nul(t.text('address')),
      nul(t.text('note')),
    ),
    ...archivedTrail(M0022),
  ]),
  items: frozen([
    ...added(
      M0022,
      t.id(),
      t.ulid('record_id'),
      t.ulid('branch_id'),
      t.varchar('barcode_display', 64),
      t.key191('barcode_key'),
      nul(t.varchar('inventory_no', 64)),
      nul(t.varchar('call_number', 64)),
      nul(t.ulid('location_id')),
      t.ulid('collection_type_id'),
      t.varchar('status', 16),
      nul(t.varchar('status_note', 191)),
      t.smallint('parts_total'),
      nul(t.varchar('acq_source', 16)),
      nul(t.varchar('order_no', 64)),
      nul(t.date('order_date')),
      nul(t.date('received_date')),
      nul(t.date('invoice_date')),
      nul(t.ulid('supplier_id')),
      nul(t.varchar('invoice_no', 64)),
      nul(t.money('price')),
      nul(t.char('currency', 3)),
      nul(t.text('note')),
    ),
    ...archivedTrail(M0022),
    // ---- Komunitas K1 (tables): the source system's entry date ----
    ...added(M0033, nul(t.date('input_on'))),
  ]),
  item_events: frozen(
    added(
      M0022,
      t.id(),
      t.ulid('item_id'),
      t.timestamp('at'),
      t.varchar('type', 16),
      nul(t.varchar('from_status', 16)),
      nul(t.varchar('to_status', 16)),
      nul(t.ulid('from_location_id')),
      nul(t.ulid('to_location_id')),
      t.varchar('actor_type', 32),
      nul(t.ulid('actor_id')),
      t.json('meta'),
    ),
  ),
  pages: frozen([
    ...added(
      M0023,
      t.id(),
      t.key191('kind'),
      t.key191('slug_key'),
      t.varchar('status', 16),
      nul(t.timestamp('published_at')),
      t.bool('show_in_nav'),
      nul(t.ulid('cover_file_id')),
      t.int('sort_order'),
    ),
    ...archivedTrail(M0023),
  ]),
  page_translations: frozen(
    added(
      M0023,
      t.ulid('page_id'),
      t.key191('locale'),
      t.varchar('title', 191),
      nul(t.text('summary')),
      t.varchar('body_format', 16),
      t.text('body'),
      t.timestamp('updated_at'),
    ),
  ),
  search_doc: frozen(
    added(
      M0024,
      t.serial('doc_no'),
      t.ulid('record_id'),
      t.bool('is_public'),
      t.bool('is_archived'),
      t.text('t_title'),
      t.text('t_agents'),
      t.text('t_subjects'),
      t.text('t_rest'),
      t.key191('title_key'),
      nul(t.smallint('year')),
      t.timestamp('created_at'),
      t.timestamp('changed_at'),
    ),
  ),
  search_facet: frozen(added(M0024, t.ulid('record_id'), t.key191('facet'), t.key191('value_key'))),
  search_term: frozen(added(M0024, t.key191('term'), t.varchar('first_char', 4), t.smallint('len'), t.int('df'))),
  search_state: frozen([
    ...added(M0024, t.smallint('id'), t.varchar('status', 16), t.int('docs'), nul(t.ulid('job_id')), nul(t.timestamp('built_at'))),
    ...added(M0029, nul(t.smallint('token_version'))),
  ]),
  catalog_runs: frozen(
    added(
      M0025,
      t.id(),
      t.varchar('kind', 16),
      t.varchar('status', 16),
      t.bool('dry_run'),
      nul(t.varchar('format', 32)),
      t.json('options'),
      t.json('summary'),
      nul(t.ulid('report_file_id')),
      nul(t.varchar('output_name', 191)),
      nul(t.bigint('output_size')),
      nul(t.timestamp('expires_at')),
      nul(t.ulid('job_id')),
      t.timestamp('created_at'),
      nul(t.ulid('created_by')),
      nul(t.timestamp('finished_at')),
    ),
  ),
  migration_map: frozen(added(M0025, t.key191('source'), t.key191('entity'), t.key191('legacy_key'), t.ulid('target_id'), t.ulid('run_id'))),
  migration_archive: frozen(
    added(
      M0025,
      t.id(),
      t.ulid('run_id'),
      t.key191('source'),
      t.key191('table_name'),
      t.key191('legacy_key'),
      t.text('row_json'),
      t.timestamp('created_at'),
    ),
  ),
  // ---- Komunitas K1 (tables) ----
  report_runs: frozen(
    added(
      M0030,
      t.id(),
      t.varchar('report_id', 64),
      t.varchar('format', 8),
      t.char('locale', 2),
      t.json('params'),
      t.bool('personal'),
      t.varchar('status', 16),
      nul(t.int('row_count')),
      nul(t.int('non_latin_rows')),
      nul(t.varchar('output_name', 191)),
      nul(t.bigint('output_size')),
      nul(t.varchar('error_code', 64)),
      nul(t.ulid('job_id')),
      nul(t.timestamp('expires_at')),
      t.timestamp('created_at'),
      nul(t.ulid('created_by')),
      nul(t.timestamp('finished_at')),
    ),
  ),
  accred_periods: frozen([
    ...added(
      M0031,
      t.id(),
      nul(t.ulid('branch_id')),
      t.varchar('name', 191),
      t.varchar('kind', 16),
      t.date('starts_on'),
      t.date('ends_on'),
      t.varchar('instrument_id', 32),
      t.varchar('status', 16),
      nul(t.timestamp('frozen_at')),
      nul(t.ulid('frozen_by')),
      t.json('profile'),
      nul(t.int('students')),
      nul(t.int('teachers')),
      nul(t.int('edu_staff')),
      nul(t.int('classes')),
      nul(t.int('population_served')),
      nul(t.int('teachers_using')),
      t.bool('all_registered_confirmed'),
      nul(t.smallint('user_pcs')),
      nul(t.smallint('staff_pcs')),
      nul(t.smallint('ict_devices')),
      nul(t.smallint('scanners')),
      nul(t.int('floor_m2')),
      nul(t.int('bandwidth_mbps')),
      nul(t.smallint('hours_per_week')),
      nul(t.json('services')),
      nul(t.varchar('external_website_url', 191)),
    ),
    ...archivedTrail(M0031),
  ]),
  accred_answers: frozen(
    added(
      M0031,
      t.ulid('period_id'),
      t.key191('indicator_code'),
      t.char('answer', 1),
      t.varchar('mode', 16),
      nul(t.text('note')),
      t.timestamp('updated_at'),
      nul(t.ulid('updated_by')),
    ),
  ),
  accred_results: frozen(added(M0031, t.ulid('period_id'), t.key191('indicator_code'), t.json('payload'), t.timestamp('computed_at'))),
  accred_snapshots: frozen(
    added(
      M0031,
      t.id(),
      t.ulid('period_id'),
      t.varchar('instrument_id', 32),
      t.json('result_values'),
      nul(t.varchar('na', 8)),
      t.varchar('na_low', 8),
      t.varchar('na_high', 8),
      nul(t.char('grade', 1)),
      t.bool('prerequisites_met'),
      nul(t.ulid('dossier_file_id')),
      nul(t.varchar('note', 191)),
      t.timestamp('created_at'),
      nul(t.ulid('created_by')),
    ),
  ),
  accred_evidence: frozen(
    added(
      M0031,
      t.id(),
      nul(t.ulid('period_id')),
      nul(t.varchar('indicator_code', 16)),
      nul(t.varchar('evidence_code', 32)),
      nul(t.varchar('entity', 32)),
      nul(t.ulid('entity_id')),
      t.ulid('file_id'),
      t.varchar('caption', 191),
      t.int('sort_order'),
      t.timestamp('created_at'),
      nul(t.ulid('created_by')),
    ),
  ),
  usage_stats: frozen(
    added(
      M0031,
      t.varchar('source', 16),
      t.varchar('metric', 32),
      t.date('span_from'),
      t.date('span_to'),
      t.key191('branch_key'),
      t.key191('group_key'),
      t.bigint('value'),
      nul(t.ulid('run_id')),
      t.timestamp('updated_at'),
      nul(t.ulid('updated_by')),
    ),
  ),
  usage_group_map: frozen(
    added(M0031, t.key191('group_key'), t.varchar('label', 191), nul(t.varchar('accred_group', 16)), t.timestamp('updated_at'), nul(t.ulid('updated_by'))),
  ),
  library_activities: frozen([
    ...added(
      M0032,
      t.id(),
      nul(t.ulid('branch_id')),
      t.varchar('kind', 32),
      t.varchar('title', 191),
      t.date('held_on'),
      nul(t.date('ended_on')),
      nul(t.int('participants')),
      nul(t.varchar('partner', 191)),
      t.bool('uses_library_facility'),
      t.bool('external_speaker'),
      nul(t.text('description')),
    ),
    ...archivedTrail(M0032),
  ]),
  library_staff: frozen([
    ...added(
      M0032,
      t.id(),
      nul(t.ulid('branch_id')),
      nul(t.ulid('staff_user_id')),
      t.varchar('name', 191),
      nul(t.varchar('position', 191)),
      t.varchar('role', 16),
      t.bool('is_librarian'),
      nul(t.varchar('employment', 16)),
      nul(t.varchar('education_level', 16)),
      t.bool('education_library'),
      t.bool('library_training'),
      t.bool('competency_cert'),
      t.bool('association_member'),
      nul(t.varchar('appointment_ref', 191)),
      nul(t.date('starts_on')),
      nul(t.date('ends_on')),
    ),
    ...archivedTrail(M0032),
  ]),
  staff_trainings: frozen([
    ...added(
      M0032,
      t.id(),
      t.ulid('library_staff_id'),
      t.varchar('title', 191),
      nul(t.varchar('organizer', 191)),
      t.date('held_on'),
      nul(t.smallint('hours')),
      nul(t.ulid('certificate_file_id')),
    ),
    ...archivedTrail(M0032),
  ]),
  library_partnerships: frozen([
    ...added(
      M0032,
      t.id(),
      nul(t.ulid('branch_id')),
      t.varchar('partner', 191),
      t.varchar('kind', 16),
      t.date('starts_on'),
      nul(t.date('ends_on')),
      nul(t.text('scope')),
      nul(t.ulid('document_file_id')),
    ),
    ...archivedTrail(M0032),
  ]),
  library_budgets: frozen([
    ...added(
      M0032,
      t.id(),
      t.key191('scope_key'),
      nul(t.ulid('branch_id')),
      t.smallint('year'),
      t.bigint('library_minor'),
      nul(t.bigint('parent_minor')),
      nul(t.bigint('parent_nonpersonnel_minor')),
      nul(t.bigint('collection_minor')),
      nul(t.bigint('community_minor')),
      t.char('currency', 3),
      nul(t.text('note')),
    ),
    ...archivedTrail(M0032),
  ]),
  library_documents: frozen([
    ...added(
      M0032,
      t.id(),
      nul(t.ulid('branch_id')),
      t.varchar('kind', 32),
      t.varchar('title', 191),
      nul(t.varchar('reference', 191)),
      nul(t.date('issued_on')),
      nul(t.varchar('issued_by', 191)),
      nul(t.json('aspect_codes')),
      nul(t.date('valid_until')),
      nul(t.ulid('file_id')),
    ),
    ...archivedTrail(M0032),
  ]),
  // ---- Komunitas (members and circulation) ----
  member_types: frozen([
    ...added(
      M0040,
      t.id(),
      t.varchar('code_display', 191),
      t.key191('code_key'),
      t.varchar('name_id', 191),
      nul(t.varchar('name_en', 191)),
      t.varchar('accred_group', 16),
      nul(t.smallint('membership_days')),
      nul(t.smallint('loan_limit')),
      t.bool('holds_allowed'),
      t.smallint('holds_limit'),
      t.bool('online_renewal'),
      t.int('sort_order'),
    ),
    ...archivedTrail(M0040),
  ]),
  members: frozen([
    ...added(
      M0040,
      t.id(),
      t.varchar('member_no_display', 64),
      t.key191('member_no_key'),
      t.ulid('member_type_id'),
      nul(t.ulid('home_branch_id')),
      t.varchar('status', 16),
      nul(t.varchar('status_note', 191)),
      t.varchar('name', 191),
      t.key191('name_key'),
      nul(t.varchar('gender', 8)),
      nul(t.date('birth_date')),
      nul(t.varchar('identity_no', 64)),
      nul(t.varchar('institution', 191)),
      nul(t.varchar('class_name', 64)),
      nul(t.varchar('email', 191)),
      nul(t.varchar('phone', 64)),
      nul(t.text('address')),
      nul(t.varchar('postal_code', 16)),
      nul(t.text('mailing_address')),
      nul(t.text('notes')),
      nul(t.ulid('photo_file_id')),
      t.char('locale', 2),
      t.date('joined_on'),
      t.date('valid_from'),
      nul(t.date('expires_on')),
      nul(t.varchar('password_hash', 191)),
      t.bool('must_reset_password'),
      t.int('session_version'),
      nul(t.timestamp('last_login_at')),
      nul(t.timestamp('anonymized_at')),
      nul(t.varchar('source', 191)),
    ),
    ...archivedTrail(M0040),
  ]),
  member_events: frozen(
    added(
      M0040,
      t.id(),
      t.ulid('member_id'),
      t.timestamp('at'),
      t.varchar('type', 16),
      t.varchar('actor_type', 32),
      nul(t.ulid('actor_id')),
      t.json('meta'),
    ),
  ),
  policies: frozen([
    ...added(
      M0040,
      t.id(),
      t.varchar('code_display', 191),
      t.key191('code_key'),
      t.varchar('name', 191),
      nul(t.ulid('member_type_id')),
      nul(t.ulid('collection_type_id')),
      nul(t.ulid('material_type_id')),
      nul(t.ulid('branch_id')),
      t.key191('scope_key'),
      t.bool('loanable'),
      t.smallint('loan_days'),
      nul(t.smallint('loan_limit')),
      t.smallint('renew_limit'),
      t.bigint('fine_per_day_minor'),
      nul(t.bigint('fine_cap_minor')),
      t.smallint('grace_days'),
      t.char('currency', 3),
    ),
    ...archivedTrail(M0040),
  ]),
  loans: frozen([
    ...added(
      M0040,
      t.id(),
      nul(t.ulid('item_id')),
      nul(t.ulid('open_item_id')),
      nul(t.ulid('record_id')),
      nul(t.ulid('member_id')),
      t.ulid('branch_id'),
      nul(t.ulid('policy_id')),
      t.date('loaned_on'),
      t.timestamp('loaned_at'),
      t.date('due_on'),
      t.smallint('renewals'),
      nul(t.date('last_renewed_on')),
      nul(t.date('returned_on')),
      nul(t.timestamp('returned_at')),
      nul(t.ulid('return_branch_id')),
      nul(t.varchar('outcome', 24)),
      t.smallint('loan_days'),
      t.smallint('renew_limit'),
      t.smallint('grace_days'),
      t.bigint('fine_per_day_minor'),
      nul(t.bigint('fine_cap_minor')),
      t.char('currency', 3),
      nul(t.varchar('overrides', 64)),
      nul(t.varchar('override_note', 191)),
      nul(t.ulid('loaned_by')),
      nul(t.ulid('returned_by')),
      t.varchar('source', 16),
      nul(t.varchar('stat_ddc', 8)),
      nul(t.ulid('stat_material_type_id')),
      nul(t.ulid('stat_collection_type_id')),
      nul(t.ulid('stat_location_id')),
      nul(t.ulid('stat_member_type_id')),
      nul(t.varchar('stat_accred_group', 16)),
      nul(t.varchar('stat_class_name', 64)),
      t.int('version'),
    ),
    ...trail(M0040),
  ]),
  // ---- Komunitas (holds) ----
  holds: frozen([
    ...added(
      M0041,
      t.id(),
      t.ulid('record_id'),
      nul(t.ulid('item_id')),
      t.bool('pinned'),
      nul(t.ulid('member_id')),
      t.ulid('pickup_branch_id'),
      t.varchar('status', 16),
      nul(t.key191('active_key')),
      nul(t.ulid('trap_item_id')),
      t.date('placed_on'),
      t.timestamp('placed_at'),
      nul(t.ulid('placed_by')),
      t.varchar('source', 16),
      nul(t.date('expires_on')),
      nul(t.timestamp('ready_at')),
      nul(t.date('pickup_until')),
      nul(t.timestamp('closed_at')),
      nul(t.varchar('close_reason', 24)),
      nul(t.timestamp('shelf_cleared_at')),
      nul(t.ulid('loan_id')),
      t.int('version'),
    ),
    ...trail(M0041),
  ]),
  // ---- Komunitas (member area) ----
  member_bookmarks: frozen(added(M0042, t.ulid('member_id'), t.ulid('record_id'), t.timestamp('created_at'))),
  attachment_member_types: frozen(added(M0042, t.ulid('attachment_id'), t.ulid('member_type_id'))),
  // ---- Komunitas K1 (edition lane): the other migration lane's bookkeeping (made by the runner, like the two above) ----
  schema_migrations_edition: frozen(added(RUNNER_TABLES_SINCE, t.key191('name'), t.varchar('timestamp', 64))),
  schema_migrations_edition_lock: frozen(added(RUNNER_TABLES_SINCE, t.key191('id'), t.int('is_locked'))),
  // Test builds only (decision D1d-26): the release fixtures' table, made by 9001_test_expand and widened by
  // 9002_test_contract. The migration names are literals inside the dead branch, so a production build keeps none of
  // it (R57; the release's leak scan checks).
  ...(typeof __BUILD_PROFILE__ !== 'undefined' && __BUILD_PROFILE__ === 'test'
    ? {
        test_fixture: frozen([
          ...added('9001_test_expand', t.ulid('id'), t.varchar('note', 191), t.bigint('created_at')),
          ...added('9002_test_contract', t.varchar('extra', 191)),
        ]),
      }
    : {}),
} satisfies Record<TableName, readonly ColumnSpec[]>);

/** Keys of a table: `pk`, then optionally unique indexes and foreign keys. */
function keys(pk: string[], o: { unique?: string[][]; fks?: ForeignKeyRef[] } = {}): TableKeySpec {
  return Object.freeze({
    pk: Object.freeze(pk),
    unique: Object.freeze((o.unique ?? []).map((u) => Object.freeze(u))),
    fks: Object.freeze((o.fks ?? []).map((f) => Object.freeze(f))),
  });
}

/**
 * The primary key, unique indexes and foreign keys of every table, keyed in the order of TABLE_CLASSES. Only
 * ownership relations have foreign keys (spec §6.1).
 */
export const TABLE_KEYS: Readonly<Record<TableName, TableKeySpec>> = Object.freeze({
  branches: keys(['id'], { unique: [['code_key']] }),
  staff_users: keys(['id'], { unique: [['username_key'], ['email_key']] }),
  staff_recovery_codes: keys(['id'], { fks: [{ column: 'user_id', table: 'staff_users', refColumn: 'id' }] }),
  roles: keys(['id'], { unique: [['key']] }),
  role_permissions: keys(['role_id', 'permission'], { fks: [{ column: 'role_id', table: 'roles', refColumn: 'id' }] }),
  user_roles: keys(['id'], {
    unique: [['user_id', 'role_id', 'scope_key']],
    fks: [
      { column: 'user_id', table: 'staff_users', refColumn: 'id' },
      { column: 'role_id', table: 'roles', refColumn: 'id' },
    ],
  }),
  settings: keys(['key']),
  files: keys(['id']),
  custom_field_defs: keys(['id'], { unique: [['entity', 'code_key']] }),
  custom_values: keys(['field_id', 'entity_id'], {
    fks: [{ column: 'field_id', table: 'custom_field_defs', refColumn: 'id' }],
  }),
  notifications: keys(['id']),
  notification_reads: keys(['notification_id', 'user_id'], {
    fks: [{ column: 'notification_id', table: 'notifications', refColumn: 'id' }],
  }),
  schedules: keys(['name']),
  audit_log: keys(['id'], { unique: [['seq']] }),
  releases_log: keys(['id']),
  backups: keys(['id']),
  license_state: keys(['install_id']),
  audit_head: keys(['id']),
  sessions: keys(['id']),
  remember_tokens: keys(['selector']),
  password_resets: keys(['token_hash']),
  rate_limits: keys(['bucket', 'window_start']),
  idempotency_keys: keys(['subject_type', 'subject_id', 'key']),
  events: keys(['seq']),
  event_consumers: keys(['name']),
  jobs: keys(['id'], { unique: [['unique_key']] }),
  locks: keys(['name']),
  upload_sessions: keys(['id']),
  schema_migrations: keys(['name']),
  schema_migrations_lock: keys(['id']),
  schema_meta: keys(['id']),
  schema_tables: keys(['name']),
  // ---- Phase 2 (catalog): Task 1 (spec §2.2; foreign keys only where §2.2 names one, none self-referencing) ----
  languages: keys(['id'], { unique: [['code_key']] }),
  material_types: keys(['id'], { unique: [['code_key']] }),
  publishers: keys(['id'], { unique: [['name_key']] }),
  agents: keys(['id'], { unique: [['type', 'name_key']] }),
  subjects: keys(['id'], { unique: [['type', 'term_key']] }),
  subject_relations: keys(['subject_id', 'related_id', 'rel'], { fks: [{ column: 'subject_id', table: 'subjects', refColumn: 'id' }] }),
  records: keys(['id']),
  record_identifiers: keys(['id'], {
    unique: [['record_id', 'type', 'value_key']],
    fks: [{ column: 'record_id', table: 'records', refColumn: 'id' }],
  }),
  record_marc_extra: keys(['id'], { fks: [{ column: 'record_id', table: 'records', refColumn: 'id' }] }),
  record_agents: keys(['record_id', 'agent_id', 'role'], { fks: [{ column: 'record_id', table: 'records', refColumn: 'id' }] }),
  record_subjects: keys(['record_id', 'subject_id'], { fks: [{ column: 'record_id', table: 'records', refColumn: 'id' }] }),
  record_relations: keys(['record_id', 'related_id', 'type'], { fks: [{ column: 'record_id', table: 'records', refColumn: 'id' }] }),
  attachments: keys(['id'], { fks: [{ column: 'record_id', table: 'records', refColumn: 'id' }] }),
  locations: keys(['id'], {
    unique: [['branch_id', 'code_key']],
    fks: [{ column: 'branch_id', table: 'branches', refColumn: 'id' }],
  }),
  collection_types: keys(['id'], { unique: [['code_key']] }),
  suppliers: keys(['id'], { unique: [['code_key']] }),
  items: keys(['id'], { unique: [['barcode_key']], fks: [{ column: 'record_id', table: 'records', refColumn: 'id' }] }),
  item_events: keys(['id'], { fks: [{ column: 'item_id', table: 'items', refColumn: 'id' }] }),
  pages: keys(['id'], { unique: [['kind', 'slug_key']] }),
  page_translations: keys(['page_id', 'locale'], { fks: [{ column: 'page_id', table: 'pages', refColumn: 'id' }] }),
  search_doc: keys(['doc_no'], { unique: [['record_id']] }),
  search_facet: keys(['record_id', 'facet', 'value_key']),
  search_term: keys(['term']),
  search_state: keys(['id']),
  catalog_runs: keys(['id']),
  migration_map: keys(['source', 'entity', 'legacy_key']),
  migration_archive: keys(['id'], { unique: [['source', 'table_name', 'legacy_key']] }),
  // ---- Komunitas K1 (tables): foreign keys only for ownership (a period's answers and snapshots, a staff member's trainings) ----
  report_runs: keys(['id']),
  accred_periods: keys(['id']),
  accred_answers: keys(['period_id', 'indicator_code'], { fks: [{ column: 'period_id', table: 'accred_periods', refColumn: 'id' }] }),
  accred_results: keys(['period_id', 'indicator_code']),
  accred_snapshots: keys(['id'], { fks: [{ column: 'period_id', table: 'accred_periods', refColumn: 'id' }] }),
  accred_evidence: keys(['id']),
  usage_stats: keys(['source', 'metric', 'span_from', 'span_to', 'branch_key', 'group_key']),
  usage_group_map: keys(['group_key']),
  library_activities: keys(['id']),
  library_staff: keys(['id']),
  staff_trainings: keys(['id'], { fks: [{ column: 'library_staff_id', table: 'library_staff', refColumn: 'id' }] }),
  library_partnerships: keys(['id']),
  library_budgets: keys(['id'], { unique: [['scope_key', 'year']] }),
  library_documents: keys(['id']),
  // ---- Komunitas (members and circulation): a member owns its events; the other links have no foreign key ----
  member_types: keys(['id'], { unique: [['code_key']] }),
  members: keys(['id'], { unique: [['member_no_key']] }),
  member_events: keys(['id'], { fks: [{ column: 'member_id', table: 'members', refColumn: 'id' }] }),
  policies: keys(['id'], { unique: [['code_key'], ['scope_key']] }),
  loans: keys(['id'], { unique: [['open_item_id']] }),
  // ---- Komunitas (holds) ----
  holds: keys(['id'], { unique: [['active_key'], ['trap_item_id']] }),
  // ---- Komunitas (member area) ----
  member_bookmarks: keys(['member_id', 'record_id'], { fks: [{ column: 'member_id', table: 'members', refColumn: 'id' }] }),
  attachment_member_types: keys(['attachment_id', 'member_type_id'], {
    fks: [{ column: 'attachment_id', table: 'attachments', refColumn: 'id' }],
  }),
  // ---- Komunitas K1 (edition lane) ----
  schema_migrations_edition: keys(['name']),
  schema_migrations_edition_lock: keys(['id']),
  // Test builds only (decision D1d-26), as in TABLE_COLUMNS.
  ...(typeof __BUILD_PROFILE__ !== 'undefined' && __BUILD_PROFILE__ === 'test' ? { test_fixture: keys(['id']) } : {}),
} satisfies Record<TableName, TableKeySpec>);

/** `NNNN` or `NNNN_slug`: a migration name, or a schema version (a backup manifest's `schemaVersion`). */
const MIGRATION_OR_VERSION = /^\d{4}(?:_[a-z0-9_]+)?$/;

/**
 * The columns of `table` that existed once `migration` had run (by `since`), in table-definition order; [] when the
 * table did not exist yet. `migration` is a migration name (`0008_access_indexes`) or a schema version (`0008`, as a
 * backup manifest records it): only its number counts.
 *
 * @throws TypeError for a `table` that is not in the registry, or a `migration` that is neither
 */
export function columnsAt(table: TableName, migration: string): readonly ColumnSpec[] {
  const columns = Object.hasOwn(TABLE_COLUMNS, table) ? TABLE_COLUMNS[table] : undefined;
  if (columns === undefined) throw new TypeError(`columnsAt(): ${JSON.stringify(table)} is not a table of TABLE_COLUMNS`);
  if (typeof migration !== 'string' || !MIGRATION_OR_VERSION.test(migration)) {
    throw new TypeError(`columnsAt(): migration must be a migration name (0001_slug) or a schema version (0001), got ${JSON.stringify(migration)}`);
  }
  const version = migration.slice(0, 4);
  return Object.freeze(columns.filter((c) => c.since.slice(0, 4) <= version));
}
