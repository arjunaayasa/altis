import fsp from 'node:fs/promises';
import os from 'node:os';
import path from 'node:path';
import { fileURLToPath } from 'node:url';
import { isDomainError, newId } from '@altis/shared';
import {
  DataTypeNode,
  InsertQueryNode,
  SelectQueryNode,
  TableNode,
  sql,
  type ColumnDataType,
  type InsertType,
  type Kysely,
  type KyselyPlugin,
  type OperationNode,
  type QueryId,
  type Selectable,
  type SelectType,
  type Transaction,
} from 'kysely';
import { afterAll, beforeAll, describe, expect, it } from 'vitest';
import { ENGINE_SPECS, emptyDatabase, engineLabel, testDb, testDbContext, type TestDbHandle } from '../../../tools/test/test-db.js';
import { TABLE_COLUMNS } from '../src/columns.js';
import type { Dialect } from '../src/connect.js';
import { dropRegisteredTables, ensureBootstrap, ensureIndex, ensureTable } from '../src/ddl.js';
// ---- Phase 2 (catalog): Task 1 ----
import { FULLTEXT_DIALECT_OBJECTS } from '../src/fulltext.js';
import {
  CATALOG_CLASSES,
  CATALOG_COLUMNS,
  CATALOG_DEFAULTS,
  CATALOG_FOREIGN_KEYS,
  CATALOG_INDEXES,
  CATALOG_NON_UNIQUE_BINARY_COLUMNS,
  CATALOG_PRIMARY_KEYS,
  CATALOG_TABLES_BY_MIGRATION,
  CATALOG_UNIQUE,
  catalogSampleRows,
} from './fixtures/catalog-tables.js';
// ---- Komunitas K1 (tables) ----
import {
  K1_CLASSES,
  K1_COLUMNS,
  K1_DEFAULTS,
  K1_FOREIGN_KEYS,
  K1_INDEXES,
  K1_NON_BINARY_KEY_COLUMNS,
  K1_PRIMARY_KEYS,
  K1_TABLES_BY_MIGRATION,
  K1_UNIQUE,
  k1SampleRows,
} from './fixtures/komunitas-k1-tables.js';
// ---- Komunitas (members and circulation) ----
import {
  CIRCULATION_CLASSES,
  CIRCULATION_COLUMNS,
  CIRCULATION_DEFAULTS,
  CIRCULATION_FOREIGN_KEYS,
  CIRCULATION_INDEXES,
  CIRCULATION_PRIMARY_KEYS,
  CIRCULATION_SEEDED_TABLES,
  CIRCULATION_TABLES_BY_MIGRATION,
  CIRCULATION_UNIQUE,
  circulationSampleRows,
} from './fixtures/komunitas-members-circulation-tables.js';
// ---- Komunitas (holds) ----
import {
  HOLDS_CLASSES,
  HOLDS_COLUMNS,
  HOLDS_DEFAULTS,
  HOLDS_FOREIGN_KEYS,
  HOLDS_INDEXES,
  HOLDS_PRIMARY_KEYS,
  HOLDS_TABLES_BY_MIGRATION,
  HOLDS_UNIQUE,
  holdsSampleRows,
} from './fixtures/komunitas-holds-tables.js';
// ---- Komunitas (member area) ----
import {
  MEMBER_AREA_CLASSES,
  MEMBER_AREA_COLUMNS,
  MEMBER_AREA_DEFAULTS,
  MEMBER_AREA_FOREIGN_KEYS,
  MEMBER_AREA_INDEXES,
  MEMBER_AREA_PRIMARY_KEYS,
  MEMBER_AREA_TABLES_BY_MIGRATION,
  MEMBER_AREA_UNIQUE,
  memberAreaSampleRows,
} from './fixtures/komunitas-member-area-tables.js';
import { MIGRATION_NAME, runMigrations } from '../src/migrator.js';
import { PHASE1_MIGRATIONS } from '../src/migrations/index.js';
import { SECRET_COLUMNS, SETTINGS_SCOPE_CLASS, TABLE_CLASSES, type SettingsScope, type TableName } from '../src/registry.js';
import type { DB } from '../src/schema.js';
import { withTx } from '../src/tx.js';

// The Phase 1 tables (spec §6.5): the nine migrations (0008 adds an index only, 0009 a column and an index), the
// table-class registry, the secret-column registry and the hand-written Kysely types, on the engine picked by
// ALTIS_TEST_DB (default sqlite); see tools/test/test-db.ts. Phase 2 (catalog, Task 1) adds the 27 tables of
// 0020–0025, three columns of 0026 and the seeds of 0027 through fixtures/catalog-tables.ts. Komunitas K1 adds the 14
// tables of 0030–0032 (reports and accreditation) and the columns and index of 0033 through
// fixtures/komunitas-k1-tables.ts; members and circulation the 5 tables of 0040 through
// fixtures/komunitas-members-circulation-tables.ts.

const ctx = testDbContext();

/**
 * TABLE_CLASSES without the release fixtures' table: under the test profile the registry also holds `test_fixture`
 * (decision D1d-26), which only 9001_test_expand makes (packages/db/test/fixtures.test.ts), never the Phase 1 list.
 */
const PHASE1_CLASSES: Partial<Record<TableName, string>> = Object.fromEntries(
  Object.entries(TABLE_CLASSES).filter(([table]) => table !== 'test_fixture'),
);

/** The §6.5 registry table, written out (wildcards expanded per ruling R30). */
const EXPECTED_CLASSES = {
  // data
  branches: 'data',
  staff_users: 'data',
  staff_recovery_codes: 'data',
  roles: 'data',
  role_permissions: 'data',
  user_roles: 'data',
  settings: 'data', // the table's class; rows split by scope, see SETTINGS_SCOPE_CLASS
  files: 'data',
  custom_field_defs: 'data',
  custom_values: 'data',
  notifications: 'data',
  notification_reads: 'data',
  // config
  schedules: 'config',
  // history
  audit_log: 'history',
  releases_log: 'history',
  backups: 'history',
  // install
  license_state: 'install',
  audit_head: 'install',
  // volatile
  sessions: 'volatile',
  remember_tokens: 'volatile',
  password_resets: 'volatile',
  rate_limits: 'volatile',
  idempotency_keys: 'volatile',
  events: 'volatile',
  event_consumers: 'volatile',
  jobs: 'volatile',
  locks: 'volatile',
  upload_sessions: 'volatile',
  // migrator
  schema_migrations: 'migrator',
  schema_migrations_lock: 'migrator',
  schema_meta: 'migrator',
  schema_tables: 'migrator',
  // ---- Phase 2 (catalog): Task 1 (Phase 2 spec §2.3) ----
  ...CATALOG_CLASSES,
  // ---- Komunitas K1 (tables) ----
  ...K1_CLASSES,
  // ---- Komunitas (members and circulation) ----
  ...CIRCULATION_CLASSES,
  // ---- Komunitas (holds) ----
  ...HOLDS_CLASSES,
  // ---- Komunitas (member area) ----
  ...MEMBER_AREA_CLASSES,
  // ---- Komunitas K1 (edition lane): the other migration lane's bookkeeping, made by the runner ----
  schema_migrations_edition: 'migrator',
  schema_migrations_edition_lock: 'migrator',
};

/** Which migration creates which tables, in creation order (parents before the tables that reference them). */
const TABLES_BY_MIGRATION: Record<string, TableName[]> = {
  '0001_meta_and_locks': ['locks'],
  '0002_org_and_identity': ['branches', 'staff_users', 'staff_recovery_codes', 'roles', 'role_permissions', 'user_roles'],
  '0003_sessions_and_limits': ['sessions', 'remember_tokens', 'password_resets', 'rate_limits'],
  '0004_settings_and_audit': ['settings', 'audit_log', 'audit_head'],
  '0005_jobs_events_notifications': ['jobs', 'schedules', 'events', 'event_consumers', 'notifications', 'notification_reads'],
  '0006_files_custom_idempotency': ['files', 'upload_sessions', 'custom_field_defs', 'custom_values', 'idempotency_keys'],
  '0007_license_releases_backups': ['license_state', 'releases_log', 'backups'],
  // Indexes only (1b): no table, so no class literal.
  '0008_access_indexes': [],
  // A column (jobs.point_of_no_return) and an index (1c): no table, so no class literal (R44).
  '0009_ops_jobs': [],
  // ---- Phase 2 (catalog): Task 1 (0020–0027) ----
  ...CATALOG_TABLES_BY_MIGRATION,
  // ---- Komunitas K1 (tables) ----
  ...K1_TABLES_BY_MIGRATION,
  // ---- Komunitas (members and circulation) ----
  ...CIRCULATION_TABLES_BY_MIGRATION,
  // ---- Komunitas (holds) ----
  ...HOLDS_TABLES_BY_MIGRATION,
  // ---- Komunitas (member area) ----
  ...MEMBER_AREA_TABLES_BY_MIGRATION,
};

/** The created_by of the tables the runner makes itself (ensureBootstrap, ruling R27). */
const RUNNER_TABLES: Record<string, string> = {
  schema_tables: 'bootstrap',
  schema_meta: 'bootstrap',
  schema_migrations: 'migrator',
  schema_migrations_lock: 'migrator',
  // ---- Komunitas K1 (edition lane) ----
  schema_migrations_edition: 'migrator',
  schema_migrations_edition_lock: 'migrator',
};

/** The primary key columns of every table, in key order. */
const EXPECTED_PRIMARY_KEYS: Record<TableName, string[]> = {
  locks: ['name'],
  branches: ['id'],
  staff_users: ['id'],
  staff_recovery_codes: ['id'],
  roles: ['id'],
  role_permissions: ['role_id', 'permission'],
  user_roles: ['id'],
  sessions: ['id'],
  remember_tokens: ['selector'],
  password_resets: ['token_hash'],
  rate_limits: ['bucket', 'window_start'],
  settings: ['key'],
  audit_log: ['id'],
  audit_head: ['id'],
  jobs: ['id'],
  schedules: ['name'],
  events: ['seq'],
  event_consumers: ['name'],
  notifications: ['id'],
  notification_reads: ['notification_id', 'user_id'],
  files: ['id'],
  upload_sessions: ['id'],
  custom_field_defs: ['id'],
  custom_values: ['field_id', 'entity_id'],
  idempotency_keys: ['subject_type', 'subject_id', 'key'],
  license_state: ['install_id'],
  releases_log: ['id'],
  backups: ['id'],
  schema_migrations: ['name'],
  schema_migrations_lock: ['id'],
  schema_meta: ['id'],
  schema_tables: ['name'],
  // ---- Phase 2 (catalog): Task 1 ----
  ...CATALOG_PRIMARY_KEYS,
  // ---- Komunitas K1 (tables) ----
  ...K1_PRIMARY_KEYS,
  // ---- Komunitas (members and circulation) ----
  ...CIRCULATION_PRIMARY_KEYS,
  // ---- Komunitas (holds) ----
  ...HOLDS_PRIMARY_KEYS,
  // ---- Komunitas (member area) ----
  ...MEMBER_AREA_PRIMARY_KEYS,
  // ---- Komunitas K1 (edition lane) ----
  schema_migrations_edition: ['name'],
  schema_migrations_edition_lock: ['id'],
};

interface IndexFacts {
  table: string;
  name: string;
  unique: boolean;
  columns: string[];
}

/** Every ix_/uq_ index of the Phase 1 tables (ruling R23 names: <prefix>_<table>_<columns>). */
const PHASE1_INDEXES: IndexFacts[] = [
  { table: 'audit_log', name: 'ix_audit_log_action_seq', unique: false, columns: ['action', 'seq'] },
  { table: 'audit_log', name: 'ix_audit_log_actor_id', unique: false, columns: ['actor_id'] },
  { table: 'audit_log', name: 'ix_audit_log_at', unique: false, columns: ['at'] },
  { table: 'audit_log', name: 'ix_audit_log_entity_entity_id', unique: false, columns: ['entity', 'entity_id'] },
  { table: 'audit_log', name: 'uq_audit_log_seq', unique: true, columns: ['seq'] },
  { table: 'branches', name: 'uq_branches_code_key', unique: true, columns: ['code_key'] },
  { table: 'custom_field_defs', name: 'uq_custom_field_defs_entity_code_key', unique: true, columns: ['entity', 'code_key'] },
  { table: 'custom_values', name: 'ix_custom_values_entity_id', unique: false, columns: ['entity_id'] },
  { table: 'events', name: 'ix_events_created_at', unique: false, columns: ['created_at'] },
  { table: 'files', name: 'ix_files_owner_type_owner_id', unique: false, columns: ['owner_type', 'owner_id'] },
  { table: 'files', name: 'ix_files_sha256', unique: false, columns: ['sha256'] },
  { table: 'idempotency_keys', name: 'ix_idempotency_keys_created_at', unique: false, columns: ['created_at'] },
  { table: 'jobs', name: 'ix_jobs_finished_at', unique: false, columns: ['finished_at'] }, // 0009: retention
  { table: 'jobs', name: 'ix_jobs_status_run_at', unique: false, columns: ['status', 'run_at'] },
  { table: 'jobs', name: 'uq_jobs_unique_key', unique: true, columns: ['unique_key'] },
  {
    table: 'notifications',
    name: 'ix_notifications_audience_permission',
    unique: false,
    columns: ['audience_permission'],
  },
  { table: 'notifications', name: 'ix_notifications_created_at', unique: false, columns: ['created_at'] },
  { table: 'notifications', name: 'ix_notifications_expires_at', unique: false, columns: ['expires_at'] },
  { table: 'notifications', name: 'ix_notifications_user_id', unique: false, columns: ['user_id'] },
  {
    table: 'password_resets',
    name: 'ix_password_resets_subject_type_subject_id',
    unique: false,
    columns: ['subject_type', 'subject_id'],
  },
  { table: 'rate_limits', name: 'ix_rate_limits_window_start', unique: false, columns: ['window_start'] },
  {
    table: 'remember_tokens',
    name: 'ix_remember_tokens_subject_type_subject_id',
    unique: false,
    columns: ['subject_type', 'subject_id'],
  },
  { table: 'roles', name: 'uq_roles_key', unique: true, columns: ['key'] },
  { table: 'sessions', name: 'ix_sessions_expires_at', unique: false, columns: ['expires_at'] },
  { table: 'sessions', name: 'ix_sessions_remember_selector', unique: false, columns: ['remember_selector'] },
  { table: 'sessions', name: 'ix_sessions_subject_type_subject_id', unique: false, columns: ['subject_type', 'subject_id'] },
  { table: 'staff_recovery_codes', name: 'ix_staff_recovery_codes_user_id', unique: false, columns: ['user_id'] },
  { table: 'staff_users', name: 'uq_staff_users_email_key', unique: true, columns: ['email_key'] },
  { table: 'staff_users', name: 'uq_staff_users_username_key', unique: true, columns: ['username_key'] },
  { table: 'upload_sessions', name: 'ix_upload_sessions_owner', unique: false, columns: ['owner'] },
  { table: 'user_roles', name: 'ix_user_roles_role_id', unique: false, columns: ['role_id'] },
  {
    table: 'user_roles',
    name: 'uq_user_roles_user_id_role_id_scope_key',
    unique: true,
    columns: ['user_id', 'role_id', 'scope_key'],
  },
];

/** Every ix_/uq_ index of the database but the full-text ones, sorted as {@link indexes} reads them. */
const EXPECTED_INDEXES: IndexFacts[] = [
  ...PHASE1_INDEXES,
  // ---- Phase 2 (catalog): Task 1 (its full-text indexes: fulltext.test.ts) ----
  ...CATALOG_INDEXES,
  // ---- Komunitas K1 (tables) ----
  ...K1_INDEXES,
  // ---- Komunitas (members and circulation) ----
  ...CIRCULATION_INDEXES,
  // ---- Komunitas (holds) ----
  ...HOLDS_INDEXES,
  // ---- Komunitas (member area) ----
  ...MEMBER_AREA_INDEXES,
].sort((a, b) => a.table.localeCompare(b.table) || a.name.localeCompare(b.name));

/** The full-text indexes, which {@link indexes} leaves out (an expression index has no column list on PostgreSQL). */
const FULLTEXT_INDEX = /^ix_search_doc_ft(?:_|$)/;

interface ForeignKeyFacts {
  table: string;
  column: string;
  refTable: string;
  refColumn: string;
  /** Lower case: `cascade` | `restrict`. */
  onDelete: string;
}

/** The foreign keys: ownership relations only (spec §6.1). */
const EXPECTED_FOREIGN_KEYS: ForeignKeyFacts[] = [
  { table: 'custom_values', column: 'field_id', refTable: 'custom_field_defs', refColumn: 'id', onDelete: 'cascade' },
  { table: 'notification_reads', column: 'notification_id', refTable: 'notifications', refColumn: 'id', onDelete: 'cascade' },
  { table: 'role_permissions', column: 'role_id', refTable: 'roles', refColumn: 'id', onDelete: 'cascade' },
  { table: 'staff_recovery_codes', column: 'user_id', refTable: 'staff_users', refColumn: 'id', onDelete: 'cascade' },
  { table: 'user_roles', column: 'role_id', refTable: 'roles', refColumn: 'id', onDelete: 'restrict' },
  { table: 'user_roles', column: 'user_id', refTable: 'staff_users', refColumn: 'id', onDelete: 'cascade' },
  // ---- Phase 2 (catalog): Task 1 ----
  ...CATALOG_FOREIGN_KEYS,
  // ---- Komunitas K1 (tables) ----
  ...K1_FOREIGN_KEYS,
  // ---- Komunitas (members and circulation) ----
  ...CIRCULATION_FOREIGN_KEYS,
  // ---- Komunitas (holds) ----
  ...HOLDS_FOREIGN_KEYS,
  // ---- Komunitas (member area) ----
  ...MEMBER_AREA_FOREIGN_KEYS,
].sort((a, b) => a.table.localeCompare(b.table) || a.column.localeCompare(b.column));

type MigratorTable =
  | 'schema_migrations'
  | 'schema_migrations_lock'
  | 'schema_meta'
  | 'schema_tables'
  // ---- Komunitas K1 (edition lane) ----
  | 'schema_migrations_edition'
  | 'schema_migrations_edition_lock';
/** The tables the Phase 1 migrations make. */
type Phase1Table = Exclude<TableName, MigratorTable>;

/** The trail columns (spec §6.1): acting staff user's id or null, without a foreign key. */
const TRAIL = { created_at: 'bigint', created_by: 'char(26) null', updated_at: 'bigint', updated_by: 'char(26) null' };

/**
 * Every column of every Phase 1 table as the catalog shows it: the type in ddl.ts's canonical spelling (key191() is
 * varchar(191), id()/ulid() char(26), bool() smallint, timestamp() bigint, json() text), then ` null` when
 * nullable, ` default` when the column has a database default, ` auto` for the auto-increment key.
 */
const EXPECTED_COLUMNS: Record<Phase1Table, Record<string, string>> = {
  locks: { name: 'varchar(191)', owner: 'varchar(191)', until: 'bigint' }, // R48: owner key191()
  branches: {
    id: 'char(26)',
    code_key: 'varchar(191)',
    code_display: 'varchar(191)',
    name: 'varchar(191)',
    address: 'text null',
    timezone: 'varchar(64)',
    is_default: 'smallint default',
    archived_at: 'bigint null',
    version: 'integer default',
    ...TRAIL,
  },
  staff_users: {
    id: 'char(26)',
    username_key: 'varchar(191)',
    username_display: 'varchar(191)',
    name: 'varchar(191)',
    email_key: 'varchar(191) null',
    email_display: 'varchar(191) null',
    password_hash: 'varchar(191)',
    status: 'varchar(32)',
    locale: 'varchar(8) null',
    totp_secret_enc: 'text null',
    totp_enabled: 'smallint default',
    totp_last_step: 'bigint default',
    totp_reenroll: 'smallint default',
    mfa_required: 'smallint default',
    must_change_password: 'smallint default',
    authz_version: 'integer default',
    last_login_at: 'bigint null',
    version: 'integer default',
    ...TRAIL,
  },
  staff_recovery_codes: {
    id: 'char(26)',
    user_id: 'char(26)',
    code_hash: 'char(64)',
    used_at: 'bigint null',
    created_at: 'bigint',
  },
  roles: {
    id: 'char(26)',
    key: 'varchar(191)',
    name: 'varchar(191)',
    description: 'text null',
    is_system: 'smallint default',
    mfa_required: 'smallint default',
    version: 'integer default',
    ...TRAIL,
  },
  role_permissions: { role_id: 'char(26)', permission: 'varchar(191)' },
  user_roles: {
    id: 'char(26)',
    user_id: 'char(26)',
    role_id: 'char(26)',
    branch_id: 'char(26) null',
    scope_key: 'varchar(191)', // R39: key191(), no default
    created_at: 'bigint',
    created_by: 'char(26) null',
  },
  sessions: {
    id: 'char(64)',
    subject_type: 'varchar(32)',
    subject_id: 'char(26)',
    created_at: 'bigint',
    last_seen_at: 'bigint',
    expires_at: 'bigint',
    ip: 'varchar(45) null',
    user_agent: 'varchar(191) null',
    mfa_passed: 'smallint default',
    reauth_at: 'bigint null',
    remember_selector: 'char(24) null',
    authz_version: 'integer default',
  },
  remember_tokens: {
    selector: 'char(24)',
    validator_hash: 'char(64)',
    prev_validator_hash: 'char(64) null',
    rotated_at: 'bigint null',
    subject_type: 'varchar(32)',
    subject_id: 'char(26)',
    expires_at: 'bigint',
    mfa_bound: 'smallint default',
    last_used_at: 'bigint null',
  },
  password_resets: {
    token_hash: 'char(64)',
    subject_type: 'varchar(32)',
    subject_id: 'char(26)',
    expires_at: 'bigint',
    used_at: 'bigint null',
  },
  rate_limits: { bucket: 'char(64)', window_start: 'bigint', bucket_name: 'text', count: 'integer default' }, // R43
  settings: {
    key: 'varchar(191)',
    value: 'text null', // R42
    is_secret: 'smallint default',
    scope: 'varchar(32)',
    updated_at: 'bigint',
    updated_by: 'char(26) null',
  },
  audit_log: {
    id: 'char(26)',
    seq: 'bigint',
    at: 'bigint',
    actor_type: 'varchar(32)',
    actor_id: 'char(26) null',
    action: 'varchar(64)',
    entity: 'varchar(64) null',
    entity_id: 'varchar(191) null', // R40b: key191()
    branch_id: 'char(26) null',
    ip: 'varchar(45) null',
    meta: 'text',
    prev_hash: 'char(64)',
    hash: 'char(64)',
  },
  audit_head: { id: 'smallint', last_seq: 'bigint', last_hash: 'char(64)' },
  jobs: {
    id: 'char(26)',
    type: 'varchar(64)',
    payload: 'text',
    secret_param: 'text null',
    status: 'varchar(32)',
    run_at: 'bigint',
    attempts: 'integer default',
    max_attempts: 'integer',
    unique_key: 'varchar(191) null',
    lock_token: 'varchar(191) null', // R48: key191()
    locked_by: 'varchar(191) null', // R48: key191()
    locked_until: 'bigint null',
    cancel_requested: 'smallint default',
    progress: 'integer default',
    progress_message: 'text null',
    last_error: 'text null',
    created_by: 'char(26) null',
    created_at: 'bigint',
    updated_at: 'bigint',
    finished_at: 'bigint null',
    point_of_no_return: 'smallint default', // 0009_ops_jobs
  },
  schedules: {
    name: 'varchar(191)',
    expr: 'varchar(191)',
    enabled: 'smallint default',
    next_run_at: 'bigint',
    last_run_at: 'bigint null',
  },
  events: { seq: 'bigint auto', channel: 'varchar(128)', type: 'varchar(64)', payload: 'text', created_at: 'bigint' },
  event_consumers: {
    name: 'varchar(191)',
    cursor: 'bigint default',
    enabled: 'smallint default',
    updated_at: 'bigint',
    needs_full_reindex: 'smallint default',
  },
  notifications: {
    id: 'char(26)',
    audience_permission: 'varchar(191) null',
    user_id: 'char(26) null',
    type: 'varchar(64)',
    title_key: 'varchar(191)',
    params: 'text',
    link: 'text null',
    created_at: 'bigint',
    expires_at: 'bigint',
  },
  notification_reads: { notification_id: 'char(26)', user_id: 'char(26)', read_at: 'bigint' },
  files: {
    id: 'char(26)',
    original_name: 'varchar(191)',
    mime: 'varchar(191)',
    size: 'bigint',
    sha256: 'char(64)',
    context: 'varchar(64)',
    owner_type: 'varchar(32) null',
    owner_id: 'varchar(191) null', // R41: key191()
    access: 'varchar(32)',
    status: 'varchar(32)',
    created_at: 'bigint',
    created_by: 'char(26) null',
  },
  upload_sessions: {
    id: 'char(26)',
    owner: 'varchar(191)', // R48: key191()
    context: 'varchar(64)',
    size: 'bigint',
    sha256: 'char(64)',
    chunk_size: 'integer',
    received: 'bigint default',
    expires_at: 'bigint',
  },
  custom_field_defs: {
    id: 'char(26)',
    entity: 'varchar(191)', // R39b: key191()
    code_key: 'varchar(191)',
    code_display: 'varchar(191)',
    label: 'varchar(191)',
    type: 'varchar(32)',
    options: 'text null',
    is_required: 'smallint default',
    sort_order: 'integer default',
    archived_at: 'bigint null',
    version: 'integer default',
    ...TRAIL,
    // ---- Phase 2 (catalog): Task 1 (0026_custom_fields_i18n, at the end of the table) ----
    label_en: 'varchar(191) null',
    is_public: 'smallint default',
    is_searchable: 'smallint default',
  },
  custom_values: {
    field_id: 'char(26)',
    entity_id: 'char(26)',
    value: 'text',
    updated_at: 'bigint',
    updated_by: 'char(26) null',
  },
  idempotency_keys: {
    subject_type: 'varchar(191)', // R39b: key191()
    subject_id: 'char(26)',
    key: 'varchar(191)',
    request_hash: 'char(64)',
    status: 'varchar(32)',
    locked_until: 'bigint',
    response_status: 'smallint null',
    response_body: 'text null',
    created_at: 'bigint',
  },
  license_state: {
    install_id: 'char(26)',
    license_raw: 'text null',
    status_cache: 'varchar(32) null',
    checked_at: 'bigint null',
    grace_until: 'bigint null',
    last_heartbeat_at: 'bigint null',
    clock_high_water: 'bigint default',
  },
  releases_log: {
    id: 'char(26)',
    version: 'varchar(32)',
    action: 'varchar(32)',
    from_version: 'varchar(32) null',
    status: 'varchar(32)',
    started_at: 'bigint',
    finished_at: 'bigint null',
    backup_id: 'char(26) null',
    detail: 'text null',
  },
  backups: {
    id: 'char(26)',
    kind: 'varchar(32)',
    size: 'bigint null',
    sha256: 'char(64) null',
    schema_version: 'varchar(32)',
    app_version: 'varchar(32)',
    dialect: 'varchar(32)',
    consistency: 'varchar(32)',
    status: 'varchar(32)',
    created_at: 'bigint',
  },
  // ---- Phase 2 (catalog): Task 1 ----
  ...CATALOG_COLUMNS,
  // ---- Komunitas K1 (tables) ----
  ...K1_COLUMNS,
  // ---- Komunitas (members and circulation) ----
  ...CIRCULATION_COLUMNS,
  // ---- Komunitas (holds) ----
  ...HOLDS_COLUMNS,
  // ---- Komunitas (member area) ----
  ...MEMBER_AREA_COLUMNS,
};

/**
 * key191() columns outside any unique key: binary as well on MySQL/MariaDB (R17, R40b, R41), among them the owner
 * and token columns that WHERE clauses compare for identity (R48).
 */
const NON_UNIQUE_BINARY_COLUMNS = [
  'audit_log.entity_id',
  'files.owner_id',
  'jobs.lock_token',
  'jobs.locked_by',
  'locks.owner',
  'notifications.audience_permission',
  'notifications.title_key',
  'upload_sessions.owner',
  // ---- Phase 2 (catalog): Task 1 ----
  ...CATALOG_NON_UNIQUE_BINARY_COLUMNS,
].sort();

/** The migrations in name order, the order the migrator applies them in. */
const MIGRATION_NAMES = Object.keys(TABLES_BY_MIGRATION).sort();
/** The last migration (by name; not named here: Phase 1d and later phases add theirs). */
const LAST_MIGRATION = Object.keys(PHASE1_MIGRATIONS).sort().at(-1) ?? '';
/** The schema version the last migration leaves (its number). */
const LAST_SCHEMA_VERSION = LAST_MIGRATION.slice(0, 4);
const GENESIS_HASH = '0'.repeat(64);
const MIGRATIONS_DIR = fileURLToPath(new URL('../src/migrations/', import.meta.url));

/**
 * Compiles only when the exported DDL helpers accept a Transaction<DB> as withTx hands it out (R45). Never called:
 * the runtime counterpart is the withTx test below (dropRegisteredTables would drop everything).
 */
export async function ddlHelpersAcceptTransactions(trx: Transaction<DB>, dialect: Dialect): Promise<void> {
  await ensureBootstrap(trx, dialect);
  await ensureTable(trx, dialect, 'locks', 'volatile', 'test', (t) => {
    t.key191('name');
    t.primaryKey(['name']);
  });
  await ensureIndex(trx, dialect, 'locks', 'ix_locks_until', ['until']);
  await dropRegisteredTables(trx, dialect);
}

describe('the table-class registry and the Phase 1 migration list (spec §6.5)', () => {
  it('classifies every table exactly as the §6.5 registry does', () => {
    // Under the test profile the release fixtures' table comes on top (decision D1d-26; columns.test.ts checks that a
    // production build drops it).
    expect(TABLE_CLASSES).toEqual({ ...EXPECTED_CLASSES, test_fixture: 'data' });
    expect(PHASE1_CLASSES).toEqual(EXPECTED_CLASSES);
    expect(Object.isFrozen(TABLE_CLASSES)).toBe(true);
  });

  it('gives settings the table class data and splits its rows by scope (R30)', () => {
    expect(TABLE_CLASSES.settings).toBe('data');
    expect(SETTINGS_SCOPE_CLASS).toEqual({ data: 'data', instance: 'install' });
    expect(Object.isFrozen(SETTINGS_SCOPE_CLASS)).toBe(true);
  });

  it('lists the migrations by file stem, in order, all expand-only (no contract); Phase 2 ends at 0029_search_token_version', () => {
    expect(Object.keys(PHASE1_MIGRATIONS).sort()).toEqual(MIGRATION_NAMES);
    expect(LAST_MIGRATION).toBe(MIGRATION_NAMES.at(-1));
    // Phase 2's ten migrations, in its reserved range 0020–0039 (P2-06; 0028: Task 39's indexes; 0029: the token version).
    const catalog = MIGRATION_NAMES.filter((name) => name >= '0020' && name < '0030');
    expect(catalog).toEqual(Object.keys(CATALOG_TABLES_BY_MIGRATION));
    expect(catalog.at(-1)).toBe('0029_search_token_version');
    // Komunitas K1: reports and accreditation in its range 0030–0039; 0033 adds columns and an index only.
    const k1 = MIGRATION_NAMES.filter((name) => name >= '0030' && name < '0040');
    expect(k1).toEqual(Object.keys(K1_TABLES_BY_MIGRATION));
    expect(k1.at(-1)).toBe('0033_catalog_accred_fields');
    // Komunitas, members and circulation: one migration, 0040, in its range 0040–0049.
    // Holds: 0041, after it; the member area: 0042.
    const circulation = MIGRATION_NAMES.filter((name) => name >= '0040' && name < '0050');
    expect(circulation).toEqual([
      ...Object.keys(CIRCULATION_TABLES_BY_MIGRATION),
      ...Object.keys(HOLDS_TABLES_BY_MIGRATION),
      ...Object.keys(MEMBER_AREA_TABLES_BY_MIGRATION),
    ]);
    expect(circulation.at(-1)).toBe('0042_member_area');
    for (const [name, m] of Object.entries(PHASE1_MIGRATIONS)) {
      expect(name).toMatch(MIGRATION_NAME);
      expect(typeof m.up).toBe('function');
      expect(m.contract).toBeUndefined();
    }
    expect(Object.isFrozen(PHASE1_MIGRATIONS)).toBe(true);
  });

  it('makes every classified table exactly once: by one migration or by the runner (test tables complete)', () => {
    const made = [...Object.values(TABLES_BY_MIGRATION).flat(), ...Object.keys(RUNNER_TABLES)].sort();
    expect(made).toEqual(Object.keys(EXPECTED_CLASSES).sort());
    expect(Object.keys(EXPECTED_PRIMARY_KEYS).sort()).toEqual(made);
    expect([...Object.keys(EXPECTED_COLUMNS), ...Object.keys(RUNNER_TABLES)].sort()).toEqual(made);
  });

  it('migrations name each table and its class as literals, never through the live registry (R44)', async () => {
    for (const [migration, tables] of Object.entries(TABLES_BY_MIGRATION)) {
      const source = await fsp.readFile(path.join(MIGRATIONS_DIR, `${migration}.ts`), 'utf8');
      // Neither TABLE_CLASSES nor the `DB` type (keyof DB) of the current schema.
      const live = /from '\.\.\/(registry|schema)\.js'/.exec(source)?.[1] ?? null;
      expect({ migration, live }).toEqual({ migration, live: null });
      const calls = [...source.matchAll(/ensureTable\(db, dialect, '([a-z0-9_]+)', '([a-z]+)', NAME,/g)].map((m) => [m[1], m[2]]);
      // The literal class of every table is the one TABLE_CLASSES gives the current schema.
      expect({ migration, calls }).toEqual({ migration, calls: tables.map((t) => [t, TABLE_CLASSES[t]]) });
    }
  });

  it('restricts settings.scope to the SETTINGS_SCOPE_CLASS keys at compile time (spec §6.5)', () => {
    const scopes: SettingsScope[] = ['data', 'instance'];
    expect(Object.keys(SETTINGS_SCOPE_CLASS).sort()).toEqual(scopes);
    const insertUnclassified = (db: Kysely<DB>) =>
      db.insertInto('settings').values({
        key: 'x',
        value: null,
        // @ts-expect-error a scope SETTINGS_SCOPE_CLASS does not classify
        scope: 'tenant',
        updated_at: 0,
      });
    const updateUnclassified = (db: Kysely<DB>) =>
      // @ts-expect-error a scope SETTINGS_SCOPE_CLASS does not classify
      db.updateTable('settings').set({ scope: 'global' });
    expect([typeof insertUnclassified, typeof updateUnclassified]).toEqual(['function', 'function']);
  });
});

// ---------------------------------------------------------------------------------------------------------------
// Round-trip rows: one or two full rows per table, typed by the hand-written `DB` interface, so that tsc checks
// that every column of the type is written (Selectable needs them all) and the database checks that each one
// exists, accepts the value and reads it back unchanged. Where a table has nullable columns, row B sets every one of
// them to null.

const EPOCH_MS = 1767225600000; // 2026-01-01T00:00:00Z, above 2^32
const LATER_MS = EPOCH_MS + 86_400_000;
const hex = (c: string) => c.repeat(64);

/** Tables the round trip writes to (audit_head holds its seeded row only; the migrator tables are the runner's). */
type RoundTripTable = Exclude<TableName, MigratorTable | 'audit_head'>;

function sampleRows(): { [T in RoundTripTable]: Selectable<DB[T]>[] } {
  const staffId = newId();
  const staffId2 = newId();
  const roleId = newId();
  const branchId = newId();
  const notificationId = newId();
  const fieldId = newId();
  const trail = { created_at: EPOCH_MS, created_by: staffId, updated_at: LATER_MS, updated_by: staffId };
  const noTrail = { created_at: EPOCH_MS, created_by: null, updated_at: EPOCH_MS, updated_by: null };
  // The catalogue and member samples, made first: the member area's rows name one of their rows each.
  const catalogRows = catalogSampleRows({ branchId, staffId });
  const circulationRows = circulationSampleRows({ branchId, staffId });
  return {
    locks: [{ name: 'cron', owner: 'host-1:4242', until: LATER_MS }],
    branches: [
      {
        id: branchId,
        code_key: 'PUSAT',
        code_display: 'Pusat',
        name: 'Perpustakaan Pusat',
        address: 'Jl. Contoh 1',
        timezone: 'Asia/Jakarta',
        is_default: 1,
        archived_at: LATER_MS,
        version: 3,
        ...trail,
      },
      {
        id: newId(),
        code_key: 'CABANG',
        code_display: 'Cabang',
        name: 'Cabang',
        address: null,
        timezone: 'Asia/Makassar',
        is_default: 0,
        archived_at: null,
        version: 0,
        ...noTrail,
      },
    ],
    staff_users: [
      {
        id: staffId,
        username_key: 'ADMIN',
        username_display: 'admin',
        name: 'Admin',
        email_key: 'ADMIN@EXAMPLE.TEST',
        email_display: 'admin@example.test',
        password_hash: '$scrypt$ln=15,r=8,p=1$c2FsdHNhbHRzYWx0c2FsdA$aGFzaGhhc2hoYXNoaGFzaGhhc2hoYXNoaGFzaGhhc2g',
        status: 'active',
        locale: 'id',
        totp_secret_enc: 'v1:k1:iv:ct',
        totp_enabled: 1,
        totp_last_step: 58_907_520,
        totp_reenroll: 1,
        mfa_required: 1,
        must_change_password: 1,
        authz_version: 7,
        last_login_at: LATER_MS,
        version: 2,
        ...trail,
      },
      {
        id: staffId2,
        username_key: 'PETUGAS',
        username_display: 'petugas',
        name: 'Petugas',
        email_key: null,
        email_display: null,
        password_hash: '$scrypt$x',
        status: 'disabled',
        locale: null,
        totp_secret_enc: null,
        totp_enabled: 0,
        totp_last_step: 0,
        totp_reenroll: 0,
        mfa_required: 0,
        must_change_password: 0,
        authz_version: 1,
        last_login_at: null,
        version: 0,
        ...noTrail,
      },
    ],
    staff_recovery_codes: [
      { id: newId(), user_id: staffId, code_hash: hex('a'), used_at: LATER_MS, created_at: EPOCH_MS },
      { id: newId(), user_id: staffId, code_hash: hex('b'), used_at: null, created_at: EPOCH_MS },
    ],
    roles: [
      {
        id: roleId,
        key: 'circulation_desk',
        name: 'Sirkulasi',
        description: 'Petugas meja sirkulasi',
        is_system: 1,
        mfa_required: 1,
        version: 1,
        ...trail,
      },
      {
        id: newId(),
        key: 'viewer',
        name: 'Viewer',
        description: null,
        is_system: 0,
        mfa_required: 0,
        version: 0,
        ...noTrail,
      },
    ],
    role_permissions: [{ role_id: roleId, permission: 'system.jobs.read' }],
    user_roles: [
      {
        id: newId(),
        user_id: staffId,
        role_id: roleId,
        branch_id: branchId,
        scope_key: branchId,
        created_at: EPOCH_MS,
        created_by: staffId,
      },
      // The same user and role globally: scope_key '' is another key than the branch's.
      { id: newId(), user_id: staffId, role_id: roleId, branch_id: null, scope_key: '', created_at: EPOCH_MS, created_by: null },
    ],
    sessions: [
      {
        id: hex('c'),
        subject_type: 'staff',
        subject_id: staffId,
        created_at: EPOCH_MS,
        last_seen_at: LATER_MS,
        expires_at: LATER_MS,
        ip: '2001:db8::1',
        user_agent: 'Mozilla/5.0',
        mfa_passed: 1,
        reauth_at: LATER_MS,
        remember_selector: 'r'.repeat(24),
        authz_version: 7,
      },
      {
        id: hex('d'),
        subject_type: 'staff',
        subject_id: staffId2,
        created_at: EPOCH_MS,
        last_seen_at: EPOCH_MS,
        expires_at: LATER_MS,
        ip: null,
        user_agent: null,
        mfa_passed: 0,
        reauth_at: null,
        remember_selector: null,
        authz_version: 1,
      },
    ],
    remember_tokens: [
      {
        selector: 'r'.repeat(24),
        validator_hash: hex('e'),
        prev_validator_hash: hex('f'),
        rotated_at: LATER_MS,
        subject_type: 'staff',
        subject_id: staffId,
        expires_at: LATER_MS,
        mfa_bound: 1,
        last_used_at: LATER_MS,
      },
      {
        selector: 's'.repeat(24),
        validator_hash: hex('1'),
        prev_validator_hash: null,
        rotated_at: null,
        subject_type: 'staff',
        subject_id: staffId2,
        expires_at: LATER_MS,
        mfa_bound: 0,
        last_used_at: null,
      },
    ],
    password_resets: [
      { token_hash: hex('2'), subject_type: 'staff', subject_id: staffId, expires_at: LATER_MS, used_at: LATER_MS },
      { token_hash: hex('3'), subject_type: 'staff', subject_id: staffId2, expires_at: LATER_MS, used_at: null },
    ],
    rate_limits: [
      // R43: TEXT, since names built from a 191-character username_key and a 45-character IP exceed 191.
      { bucket: hex('4'), window_start: EPOCH_MS, bucket_name: `login:user-ip:${'U'.repeat(191)}:${'f'.repeat(45)}`, count: 5 },
    ],
    settings: [
      { key: 'library.name', value: '"Perpustakaan"', is_secret: 0, scope: 'data', updated_at: EPOCH_MS, updated_by: staffId },
      // R42: a secret that could not be carried over is NULL.
      { key: 'smtp.password', value: null, is_secret: 1, scope: 'instance', updated_at: EPOCH_MS, updated_by: null },
    ],
    audit_log: [
      {
        id: newId(),
        seq: 1,
        at: EPOCH_MS,
        actor_type: 'staff',
        actor_id: staffId,
        action: 'schedules.update',
        entity: 'schedules',
        entity_id: 'backup.daily', // R40b: not every entity is keyed by a ULID
        branch_id: branchId,
        ip: '192.0.2.1',
        meta: '{"field":"name"}',
        prev_hash: GENESIS_HASH,
        hash: hex('5'),
      },
      {
        id: newId(),
        seq: 2 ** 40, // BIGINT: above 2^31
        at: LATER_MS,
        actor_type: 'system',
        actor_id: null,
        action: 'diagnostics.clock_confirm',
        entity: null,
        entity_id: null,
        branch_id: null,
        ip: null,
        meta: '{}',
        prev_hash: hex('5'),
        hash: hex('6'),
      },
    ],
    jobs: [
      {
        id: newId(),
        type: 'backup.create',
        payload: '{"kind":"manual"}',
        secret_param: 'v1:k1:iv:ct',
        status: 'running',
        run_at: EPOCH_MS,
        attempts: 1,
        max_attempts: 5,
        unique_key: 'sched:backup.daily:2026-01-01',
        lock_token: newId(),
        locked_by: 'host-1:4242',
        locked_until: LATER_MS,
        cancel_requested: 1,
        progress: 40,
        progress_message: 'tables 4/10',
        last_error: 'LEASE_EXPIRED',
        created_by: staffId,
        created_at: EPOCH_MS,
        updated_at: LATER_MS,
        finished_at: LATER_MS,
        point_of_no_return: 1,
      },
      {
        id: newId(),
        type: 'events.purge',
        payload: '{}',
        secret_param: null,
        status: 'queued',
        run_at: EPOCH_MS,
        attempts: 0,
        max_attempts: 3,
        unique_key: null,
        lock_token: null,
        locked_by: null,
        locked_until: null,
        cancel_requested: 0,
        progress: 0,
        progress_message: null,
        last_error: null,
        created_by: null,
        created_at: EPOCH_MS,
        updated_at: EPOCH_MS,
        finished_at: null,
        point_of_no_return: 0,
      },
    ],
    schedules: [
      { name: 'backup.daily', expr: '0 1 * * *', enabled: 0, next_run_at: LATER_MS, last_run_at: EPOCH_MS },
      { name: 'events.purge', expr: '*/15 * * * *', enabled: 1, next_run_at: LATER_MS, last_run_at: null },
    ],
    events: [{ seq: 1, channel: 'system.status', type: 'maintenance.on', payload: '{}', created_at: EPOCH_MS }],
    event_consumers: [{ name: 'search', cursor: 2 ** 40, enabled: 0, updated_at: EPOCH_MS, needs_full_reindex: 1 }],
    notifications: [
      {
        id: notificationId,
        audience_permission: 'system.update.read',
        user_id: staffId,
        type: 'update.available',
        title_key: 'notifications.update.available',
        params: '{"version":"0.2.0"}',
        link: '/admin/system/update',
        created_at: EPOCH_MS,
        expires_at: LATER_MS,
      },
      {
        id: newId(),
        audience_permission: null,
        user_id: null,
        type: 'system.notice',
        title_key: 'notifications.notice',
        params: '{}',
        link: null,
        created_at: EPOCH_MS,
        expires_at: LATER_MS,
      },
    ],
    notification_reads: [{ notification_id: notificationId, user_id: staffId, read_at: LATER_MS }],
    files: [
      {
        id: newId(),
        original_name: 'sampul.png',
        mime: 'image/png',
        size: 5_000_000_000,
        sha256: hex('7'),
        context: 'branding',
        owner_type: 'settings',
        owner_id: 'branding.logo', // R41: polymorphic owner, not necessarily a ULID
        access: 'public',
        status: 'ok',
        created_at: EPOCH_MS,
        created_by: staffId,
      },
      {
        id: newId(),
        original_name: 'lampiran.pdf',
        mime: 'application/pdf',
        size: 0,
        sha256: hex('8'),
        context: 'import',
        owner_type: null,
        owner_id: null,
        access: 'staff',
        status: 'missing',
        created_at: EPOCH_MS,
        created_by: null,
      },
    ],
    upload_sessions: [
      {
        id: newId(),
        owner: `staff:${staffId}`,
        context: 'import',
        size: 5_000_000_000,
        sha256: hex('9'),
        chunk_size: 1_048_576,
        received: 4_294_967_296,
        expires_at: LATER_MS,
      },
    ],
    custom_field_defs: [
      {
        id: fieldId,
        entity: 'staff_users',
        code_key: 'NIP',
        code_display: 'NIP',
        label: 'Nomor Induk Pegawai',
        type: 'text',
        options: '{"maxLength":18}',
        is_required: 1,
        sort_order: 2,
        archived_at: LATER_MS,
        version: 1,
        ...trail,
        label_en: 'Employee number', // Phase 2 (catalog): Task 1, 0026
        is_public: 1,
        is_searchable: 1,
      },
      {
        id: newId(),
        entity: 'staff_users',
        code_key: 'JABATAN',
        code_display: 'Jabatan',
        label: 'Jabatan',
        type: 'select',
        options: null,
        is_required: 0,
        sort_order: 0,
        archived_at: null,
        version: 0,
        ...noTrail,
        label_en: null,
        is_public: 0,
        is_searchable: 0,
      },
      {
        // Same code_key, entity differing only in case: another key (R39b, binary on MySQL/MariaDB too).
        id: newId(),
        entity: 'Staff_Users',
        code_key: 'NIP',
        code_display: 'NIP',
        label: 'NIP',
        type: 'text',
        options: null,
        is_required: 0,
        sort_order: 0,
        archived_at: null,
        version: 0,
        ...noTrail,
        label_en: null,
        is_public: 0,
        is_searchable: 0,
      },
    ],
    custom_values: [
      { field_id: fieldId, entity_id: staffId, value: '"198001012005011001"', updated_at: EPOCH_MS, updated_by: staffId },
      { field_id: fieldId, entity_id: staffId2, value: '""', updated_at: EPOCH_MS, updated_by: null },
    ],
    idempotency_keys: [
      {
        subject_type: 'staff',
        subject_id: staffId,
        key: 'Key-1',
        request_hash: hex('a'),
        status: 'done',
        locked_until: LATER_MS,
        response_status: 201,
        response_body: '{"ok":true}',
        created_at: EPOCH_MS,
      },
      {
        // Same key in another case: a different key (binary collation on MySQL/MariaDB).
        subject_type: 'staff',
        subject_id: staffId,
        key: 'key-1',
        request_hash: hex('b'),
        status: 'processing',
        locked_until: LATER_MS,
        response_status: null,
        response_body: null,
        created_at: EPOCH_MS,
      },
      {
        // Same subject id and key, subject_type differing only in case: another key (R39b).
        subject_type: 'Staff',
        subject_id: staffId,
        key: 'Key-1',
        request_hash: hex('c'),
        status: 'done',
        locked_until: LATER_MS,
        response_status: 200,
        response_body: '{}',
        created_at: EPOCH_MS,
      },
    ],
    license_state: [
      {
        install_id: newId(),
        license_raw: '{"v":1}',
        status_cache: 'active',
        checked_at: EPOCH_MS,
        grace_until: LATER_MS,
        last_heartbeat_at: EPOCH_MS,
        clock_high_water: LATER_MS,
      },
      {
        install_id: newId(),
        license_raw: null,
        status_cache: null,
        checked_at: null,
        grace_until: null,
        last_heartbeat_at: null,
        clock_high_water: 0,
      },
    ],
    releases_log: [
      {
        id: newId(),
        version: '0.2.0',
        action: 'update',
        from_version: '0.1.0',
        status: 'succeeded',
        started_at: EPOCH_MS,
        finished_at: LATER_MS,
        backup_id: newId(),
        detail: '{"steps":7}',
      },
      {
        id: newId(),
        version: '0.1.0',
        action: 'install',
        from_version: null,
        status: 'running',
        started_at: EPOCH_MS,
        finished_at: null,
        backup_id: null,
        detail: null,
      },
    ],
    backups: [
      {
        id: newId(),
        kind: 'pre_update',
        size: 5_000_000_000,
        sha256: hex('c'),
        schema_version: '0007',
        app_version: '0.1.0',
        dialect: 'postgres',
        consistency: 'snapshot',
        status: 'ready',
        created_at: EPOCH_MS,
      },
      {
        id: newId(),
        kind: 'manual',
        size: null,
        sha256: null,
        schema_version: '0007',
        app_version: '0.1.0',
        dialect: 'sqlite',
        consistency: 'frozen',
        status: 'running',
        created_at: EPOCH_MS,
      },
    ],
    // ---- Phase 2 (catalog): Task 1 (locations reference the branch above) ----
    ...catalogRows,
    // ---- Komunitas K1 (tables) ----
    ...k1SampleRows({ branchId, staffId }),
    // ---- Komunitas (members and circulation) ----
    ...circulationRows,
    // ---- Komunitas (holds) ----
    ...holdsSampleRows({ branchId, staffId }),
    // ---- Komunitas (member area): a member and an attachment of the samples above ----
    ...memberAreaSampleRows({
      memberId: circulationRows.members[0]!.id,
      attachmentId: catalogRows.attachments[0]!.id,
      recordIds: [newId(), newId()],
      memberTypeIds: [newId(), newId()],
    }),
  };
}

/** The columns of a table type that an insert may leave out without being nullable: the `Generated` ones. */
type GeneratedKeys<R> = { [K in keyof R]-?: undefined extends InsertType<R[K]> ? K : never }[keyof R];

/**
 * The database default of every column the `DB` type marks `Generated` (events.seq: the auto-increment key), for
 * every table: tsc fails when a table or a Generated column is missing here. An insert without them must succeed
 * and read them back with these values.
 */
const DEFAULTS: { [T in RoundTripTable]: { [K in GeneratedKeys<DB[T]>]: SelectType<DB[T][K]> } } = {
  locks: {},
  staff_recovery_codes: {},
  role_permissions: {},
  user_roles: {},
  password_resets: {},
  audit_log: {},
  notifications: {},
  notification_reads: {},
  files: {},
  custom_values: {},
  idempotency_keys: {},
  releases_log: {},
  backups: {},
  branches: { is_default: 0, version: 0 },
  staff_users: {
    totp_enabled: 0,
    totp_last_step: 0,
    totp_reenroll: 0,
    mfa_required: 0,
    must_change_password: 0,
    authz_version: 1,
    version: 0,
  },
  roles: { is_system: 0, mfa_required: 0, version: 0 },
  sessions: { mfa_passed: 0, authz_version: 1 },
  remember_tokens: { mfa_bound: 0 },
  rate_limits: { count: 0 },
  settings: { is_secret: 0 },
  jobs: { attempts: 0, cancel_requested: 0, progress: 0, point_of_no_return: 0 },
  schedules: { enabled: 1 },
  events: { seq: expect.any(Number) as number },
  event_consumers: { cursor: 0, enabled: 1, needs_full_reindex: 0 },
  upload_sessions: { received: 0 },
  custom_field_defs: { is_required: 0, sort_order: 0, version: 0, is_public: 0, is_searchable: 0 },
  license_state: { clock_high_water: 0 },
  // ---- Phase 2 (catalog): Task 1 (parents first: the defaults test inserts in this order) ----
  ...CATALOG_DEFAULTS,
  // ---- Komunitas K1 (tables) ----
  ...K1_DEFAULTS,
  // ---- Komunitas (members and circulation) ----
  ...CIRCULATION_DEFAULTS,
  // ---- Komunitas (holds) ----
  ...HOLDS_DEFAULTS,
  // ---- Komunitas (member area) ----
  ...MEMBER_AREA_DEFAULTS,
};

/** One row of each table the runner fills itself, typed by `DB`: their keys are the columns the type declares. */
const RUNNER_ROW_SHAPES: { [T in MigratorTable | 'audit_head']: Selectable<DB[T]> } = {
  schema_tables: { name: 'x', class: 'data', created_by: 'x' },
  schema_meta: { id: 1, schema_version: '0007', min_code_version: '0.0.0', install_id: null },
  schema_migrations: { name: '0001_x', timestamp: '2026-01-01T00:00:00.000Z' },
  schema_migrations_lock: { id: 'migration_lock', is_locked: 0 },
  // ---- Komunitas K1 (edition lane): empty while this code ships no migration of the other lane (see the test below) ----
  schema_migrations_edition: { name: 'e0001_x', timestamp: '2026-01-01T00:00:00.000Z' },
  schema_migrations_edition_lock: { id: 'migration_lock', is_locked: 0 },
  audit_head: { id: 1, last_seq: 0, last_hash: GENESIS_HASH },
};

/** The table a SELECT or INSERT node reads from or writes to, if it is a plain table. */
function tableOf(node: OperationNode): string | null {
  const target = SelectQueryNode.is(node) ? node.from?.froms[0] : InsertQueryNode.is(node) ? node.into : undefined;
  return target !== undefined && TableNode.is(target) ? target.table.identifier.name : null;
}

/**
 * Plugins for `parties` connections that make them race on the audit_head seed: each connection's first SELECT of
 * audit_head returns only after every party's first SELECT has run (all of them see the table empty), so every
 * party then inserts. Counts the INSERTs into audit_head.
 */
function seedRace(parties: number) {
  let arrived = 0;
  let inserts = 0;
  let release!: () => void;
  const allArrived = new Promise<void>((resolve) => {
    release = resolve;
  });
  const plugin = (): KyselyPlugin => {
    const firstSelect: { id: QueryId | null } = { id: null };
    return {
      transformQuery({ node, queryId }) {
        if (tableOf(node) === 'audit_head') {
          if (SelectQueryNode.is(node) && firstSelect.id === null) firstSelect.id = queryId;
          if (InsertQueryNode.is(node)) inserts += 1;
        }
        return node;
      },
      async transformResult({ queryId, result }) {
        if (queryId === firstSelect.id) {
          arrived += 1;
          if (arrived === parties) release();
          await allArrived;
        }
        return result;
      },
    };
  };
  return { plugin, inserts: () => inserts };
}

describe.skipIf(!ctx.available)(`Phase 1 tables [${engineLabel()}]`, () => {
  let h: TestDbHandle;
  let db: Kysely<DB>;
  let dataDir: string;
  let firstRun: Awaited<ReturnType<typeof runMigrations>>;
  const mysqlFamily = () => h.dialect === 'mysql' || h.dialect === 'mariadb';
  const migrate = () => runMigrations(h, { appVersion: '0.1.0', dataDir, migrations: PHASE1_MIGRATIONS });

  /** Every base table of the database, except SQLite's internal ones (sqlite_sequence for AUTOINCREMENT). */
  async function tableNames(): Promise<string[]> {
    let q;
    if (mysqlFamily()) {
      q = sql<{ name: string }>`SELECT TABLE_NAME AS name FROM information_schema.TABLES
        WHERE TABLE_SCHEMA = DATABASE() AND TABLE_TYPE = 'BASE TABLE'`;
    } else if (h.dialect === 'postgres') {
      q = sql<{ name: string }>`SELECT c.relname AS name FROM pg_class c JOIN pg_namespace n ON n.oid = c.relnamespace
        WHERE n.nspname = current_schema() AND c.relkind IN ('r', 'p')`;
    } else {
      q = sql<{ name: string }>`SELECT name FROM sqlite_master WHERE type = 'table' AND name NOT LIKE 'sqlite\\_%' ESCAPE '\\'`;
    }
    // Phase 2 (catalog), Task 1: the dialect's full-text objects (SQLite's FTS5 table and its shadow tables) are no
    // registered tables; fulltext.test.ts checks them.
    const fullText = new Set(FULLTEXT_DIALECT_OBJECTS[h.dialect]);
    return (await q.execute(h.db)).rows
      .map((r) => String(r.name))
      .filter((name) => !fullText.has(name))
      .sort();
  }

  /** The columns of `table`'s primary key, in key order. */
  async function primaryKey(table: string): Promise<string[]> {
    let q;
    if (mysqlFamily()) {
      q = sql<{ col: string }>`SELECT COLUMN_NAME AS col FROM information_schema.STATISTICS
        WHERE TABLE_SCHEMA = DATABASE() AND TABLE_NAME = ${table} AND INDEX_NAME = 'PRIMARY' ORDER BY SEQ_IN_INDEX`;
    } else if (h.dialect === 'postgres') {
      q = sql<{ col: string }>`SELECT a.attname AS col FROM pg_index ix
        CROSS JOIN LATERAL unnest(ix.indkey::int2[]) WITH ORDINALITY AS k(attnum, ord)
        JOIN pg_attribute a ON a.attrelid = ix.indrelid AND a.attnum = k.attnum
        WHERE ix.indrelid = to_regclass(${table}::text) AND ix.indisprimary ORDER BY k.ord`;
    } else {
      q = sql<{ col: string }>`SELECT name AS col FROM pragma_table_info(${table}) WHERE pk > 0 ORDER BY pk`;
    }
    return (await q.execute(h.db)).rows.map((r) => String(r.col));
  }

  /** Every ix_/uq_ index of the database: table, name, uniqueness and columns in order. */
  async function indexes(): Promise<IndexFacts[]> {
    let rows: Array<{ table: string; name: string; uniq: unknown; col: string }>;
    if (mysqlFamily()) {
      ({ rows } = await sql<{ table: string; name: string; uniq: unknown; col: string }>`
        SELECT TABLE_NAME AS "table", INDEX_NAME AS name, NON_UNIQUE = 0 AS uniq, COLUMN_NAME AS col
        FROM information_schema.STATISTICS WHERE TABLE_SCHEMA = DATABASE()
        ORDER BY TABLE_NAME, INDEX_NAME, SEQ_IN_INDEX`.execute(h.db));
    } else if (h.dialect === 'postgres') {
      ({ rows } = await sql<{ table: string; name: string; uniq: unknown; col: string }>`
        SELECT t.relname AS "table", i.relname AS name, ix.indisunique AS uniq, a.attname AS col
        FROM pg_index ix
        JOIN pg_class i ON i.oid = ix.indexrelid
        JOIN pg_class t ON t.oid = ix.indrelid
        JOIN pg_namespace n ON n.oid = t.relnamespace
        CROSS JOIN LATERAL unnest(ix.indkey::int2[]) WITH ORDINALITY AS k(attnum, ord)
        JOIN pg_attribute a ON a.attrelid = t.oid AND a.attnum = k.attnum
        WHERE n.nspname = current_schema()
        ORDER BY t.relname, i.relname, k.ord`.execute(h.db));
    } else {
      ({ rows } = await sql<{ table: string; name: string; uniq: unknown; col: string }>`
        SELECT m.name AS "table", il.name AS name, il."unique" AS uniq, ii.name AS col
        FROM sqlite_master m
        JOIN pragma_index_list(m.name) il
        JOIN pragma_index_info(il.name) ii
        WHERE m.type = 'table'
        ORDER BY m.name, il.name, ii.seqno`.execute(h.db));
    }
    const byName = new Map<string, IndexFacts>();
    for (const r of rows) {
      const name = String(r.name);
      if (!name.startsWith('ix_') && !name.startsWith('uq_')) continue;
      if (FULLTEXT_INDEX.test(name)) continue; // Phase 2 (catalog), Task 1: fulltext.test.ts
      const unique = r.uniq === true || Number(r.uniq) === 1;
      const facts = byName.get(name) ?? { table: String(r.table), name, unique, columns: [] };
      facts.columns.push(String(r.col));
      byName.set(name, facts);
    }
    return [...byName.values()].sort((a, b) => a.table.localeCompare(b.table) || a.name.localeCompare(b.name));
  }

  /** Every foreign key of the database: table.column -> refTable.refColumn and its delete rule. */
  async function foreignKeys(): Promise<ForeignKeyFacts[]> {
    let rows: ForeignKeyFacts[];
    if (mysqlFamily()) {
      ({ rows } = await sql<ForeignKeyFacts>`
        SELECT k.TABLE_NAME AS "table", k.COLUMN_NAME AS "column", k.REFERENCED_TABLE_NAME AS "refTable",
               k.REFERENCED_COLUMN_NAME AS "refColumn", r.DELETE_RULE AS "onDelete"
        FROM information_schema.KEY_COLUMN_USAGE k
        JOIN information_schema.REFERENTIAL_CONSTRAINTS r
          ON r.CONSTRAINT_SCHEMA = k.CONSTRAINT_SCHEMA AND r.CONSTRAINT_NAME = k.CONSTRAINT_NAME
        WHERE k.TABLE_SCHEMA = DATABASE() AND k.REFERENCED_TABLE_NAME IS NOT NULL`.execute(h.db));
    } else if (h.dialect === 'postgres') {
      ({ rows } = await sql<ForeignKeyFacts>`
        SELECT ch.relname AS "table", ca.attname AS "column", pa.relname AS "refTable", pca.attname AS "refColumn",
               CASE c.confdeltype WHEN 'c' THEN 'cascade' WHEN 'r' THEN 'restrict' ELSE c.confdeltype::text END AS "onDelete"
        FROM pg_constraint c
        JOIN pg_class ch ON ch.oid = c.conrelid
        JOIN pg_namespace n ON n.oid = ch.relnamespace
        JOIN pg_class pa ON pa.oid = c.confrelid
        JOIN pg_attribute ca ON ca.attrelid = c.conrelid AND ca.attnum = c.conkey[1]
        JOIN pg_attribute pca ON pca.attrelid = c.confrelid AND pca.attnum = c.confkey[1]
        WHERE c.contype = 'f' AND n.nspname = current_schema()`.execute(h.db));
    } else {
      ({ rows } = await sql<ForeignKeyFacts>`
        SELECT m.name AS "table", f."from" AS "column", f."table" AS "refTable", f."to" AS "refColumn",
               f.on_delete AS "onDelete"
        FROM sqlite_master m JOIN pragma_foreign_key_list(m.name) f WHERE m.type = 'table'`.execute(h.db));
    }
    return rows
      .map((r) => ({ ...r, onDelete: String(r.onDelete).toLowerCase() }))
      .sort((a, b) => a.table.localeCompare(b.table) || a.column.localeCompare(b.column));
  }

  /** The columns of `table` in the notation of EXPECTED_COLUMNS, read from the catalog. */
  async function catalogColumns(table: string): Promise<Record<string, string>> {
    let facts: Array<{ name: string; type: string; nullable: boolean; hasDefault: boolean; auto: boolean }>;
    if (mysqlFamily()) {
      const { rows } = await sql<{ name: string; dt: string; len: unknown; nullable: string; dflt: string | null; extra: string }>`
        SELECT COLUMN_NAME AS name, DATA_TYPE AS dt, CHARACTER_MAXIMUM_LENGTH AS len, IS_NULLABLE AS nullable,
               COLUMN_DEFAULT AS dflt, EXTRA AS extra
        FROM information_schema.COLUMNS WHERE TABLE_SCHEMA = DATABASE() AND TABLE_NAME = ${table}`.execute(h.db);
      facts = rows.map((r) => {
        const dt = String(r.dt).toLowerCase();
        return {
          name: r.name,
          type: dt === 'char' || dt === 'varchar' ? `${dt}(${Number(r.len)})` : dt === 'int' ? 'integer' : dt,
          nullable: r.nullable === 'YES',
          // MariaDB reports the implicit DEFAULT NULL of a nullable column as the text NULL.
          hasDefault: r.dflt !== null && r.dflt !== 'NULL',
          auto: /auto_increment/i.test(r.extra),
        };
      });
    } else if (h.dialect === 'postgres') {
      const { rows } = await sql<{ name: string; type: string; nullable: boolean; has_default: boolean; auto: boolean }>`
        SELECT a.attname AS name, format_type(a.atttypid, a.atttypmod) AS type, NOT a.attnotnull AS nullable,
               a.atthasdef AS has_default, a.attidentity <> '' AS auto
        FROM pg_attribute a WHERE a.attrelid = to_regclass(${table}::text) AND a.attnum > 0 AND NOT a.attisdropped`.execute(
        h.db,
      );
      facts = rows.map((r) => ({
        name: r.name,
        type: r.type.replace(/^character varying/, 'varchar').replace(/^character\b/, 'char'),
        nullable: r.nullable,
        hasDefault: r.has_default,
        auto: r.auto,
      }));
    } else {
      const { rows } = await sql<{ name: string; type: string; nn: number; dflt: string | null; pk: number }>`
        SELECT name, type, "notnull" AS nn, dflt_value AS dflt, pk FROM pragma_table_info(${table})`.execute(h.db);
      const ddl = await sql<{ sql: string }>`SELECT sql FROM sqlite_master WHERE type = 'table' AND name = ${table}`.execute(h.db);
      facts = rows.map((r) => {
        // An INTEGER PRIMARY KEY AUTOINCREMENT is serial(): the rowid, never NULL.
        const auto = r.pk === 1 && r.type.toLowerCase() === 'integer' && /autoincrement/i.test(ddl.rows[0]?.sql ?? '');
        return {
          name: r.name,
          type: auto ? 'bigint' : r.type.toLowerCase(),
          nullable: r.nn === 0 && !auto,
          hasDefault: r.dflt !== null,
          auto,
        };
      });
    }
    return Object.fromEntries(
      facts.map((f) => [f.name, `${f.type}${f.nullable ? ' null' : ''}${f.hasDefault ? ' default' : ''}${f.auto ? ' auto' : ''}`]),
    );
  }

  async function registry() {
    return db.selectFrom('schema_tables').select(['name', 'class', 'created_by']).orderBy('name').execute();
  }

  async function auditHead() {
    return db.selectFrom('audit_head').selectAll().execute();
  }

  beforeAll(async () => {
    h = await testDb();
    db = h.db;
    dataDir = await fsp.mkdtemp(path.join(os.tmpdir(), 'altis-tables-'));
    firstRun = await migrate();
    // Phase 2 (catalog), Task 1: the seed rows of 0027 are catalog-seed.test.ts's; the round trips below start from
    // empty tables.
    for (const t of ['material_types', 'languages', 'collection_types'] as const) await db.deleteFrom(t).execute();
    // Komunitas (members and circulation): the seeded member types and general loan rule, likewise.
    for (const t of CIRCULATION_SEEDED_TABLES) await db.deleteFrom(t).execute();
  });

  afterAll(async () => {
    await h?.close();
    if (dataDir !== undefined) await fsp.rm(dataDir, { recursive: true, force: true });
  });

  it('applies every migration on an empty database', () => {
    expect(firstRun).toEqual({
      mode: 'migrated',
      applied: MIGRATION_NAMES,
      schemaVersion: LAST_SCHEMA_VERSION,
      minCodeVersion: '0.0.0',
      edition: { mode: 'empty', applied: [] },
    });
  });

  it('leaves exactly the tables of TABLE_CLASSES in the database (schema_migrations* included, R4)', async () => {
    expect(await tableNames()).toEqual(Object.keys(PHASE1_CLASSES).sort());
  });

  it('lists every table in schema_tables with its class from TABLE_CLASSES and the migration that made it', async () => {
    const createdBy: Record<string, string> = { ...RUNNER_TABLES };
    for (const [migration, tables] of Object.entries(TABLES_BY_MIGRATION)) for (const t of tables) createdBy[t] = migration;
    const expected = Object.entries(PHASE1_CLASSES)
      .map(([name, cls]) => ({ name, class: cls, created_by: createdBy[name] }))
      .sort((a, b) => (a.name < b.name ? -1 : 1));
    expect(await registry()).toEqual(expected);
  });

  it('keys every table as §6.5 says, composite keys included', async () => {
    const actual: Record<string, string[]> = {};
    for (const t of Object.keys(PHASE1_CLASSES)) actual[t] = await primaryKey(t);
    expect(actual).toEqual(EXPECTED_PRIMARY_KEYS);
    // The four composite keys the plan names explicitly.
    expect(actual['role_permissions']).toEqual(['role_id', 'permission']);
    expect(actual['rate_limits']).toEqual(['bucket', 'window_start']);
    expect(actual['notification_reads']).toEqual(['notification_id', 'user_id']);
    expect(actual['idempotency_keys']).toEqual(['subject_type', 'subject_id', 'key']);
  });

  it('has the unique indexes of §6.5 and the ix_ indexes, named per R23', async () => {
    const actual = await indexes();
    expect(actual).toEqual(EXPECTED_INDEXES);
    const unique = actual.filter((i) => i.unique).map((i) => `${i.table}(${i.columns.join(', ')})`);
    expect(unique.sort()).toEqual(
      [
        'staff_users(username_key)',
        'staff_users(email_key)',
        'branches(code_key)',
        'roles(key)',
        'user_roles(user_id, role_id, scope_key)',
        'audit_log(seq)',
        'jobs(unique_key)',
        'custom_field_defs(entity, code_key)',
        // ---- Phase 2 (catalog): Task 1 ----
        ...CATALOG_UNIQUE,
        // ---- Komunitas K1 (tables) ----
        ...K1_UNIQUE,
        // ---- Komunitas (members and circulation) ----
        ...CIRCULATION_UNIQUE,
        // ---- Komunitas (holds) ----
        ...HOLDS_UNIQUE,
  // ---- Komunitas (member area) ----
  ...MEMBER_AREA_UNIQUE,
      ].sort(),
    );
  });

  it('has ix_audit_log_action_seq on audit_log (action, seq): a plain index with the R23 name (0008)', async () => {
    expect((await indexes()).filter((i) => i.name === 'ix_audit_log_action_seq')).toEqual([
      { table: 'audit_log', name: 'ix_audit_log_action_seq', unique: false, columns: ['action', 'seq'] },
    ]);
  });

  it('0009_ops_jobs: jobs.point_of_no_return is a NOT NULL smallint with default 0, and ix_jobs_finished_at exists', async () => {
    expect((await catalogColumns('jobs'))['point_of_no_return']).toBe('smallint default');
    expect((await indexes()).filter((i) => i.name === 'ix_jobs_finished_at')).toEqual([
      { table: 'jobs', name: 'ix_jobs_finished_at', unique: false, columns: ['finished_at'] },
    ]);
    // A row written as 1c code before 0009 would write it: without the column.
    const withoutFlag = Object.fromEntries(
      Object.entries({ ...sampleRows().jobs[1]!, id: newId() }).filter(([column]) => column !== 'point_of_no_return'),
    ) as Omit<Selectable<DB['jobs']>, 'point_of_no_return'>;
    try {
      await db.insertInto('jobs').values(withoutFlag).execute();
      expect(await db.selectFrom('jobs').select('point_of_no_return').execute()).toEqual([{ point_of_no_return: 0 }]);
    } finally {
      await db.deleteFrom('jobs').execute();
    }
  });

  it.runIf(ENGINE_SPECS[ctx.engine].dialect === 'postgres')(
    '0009_ops_jobs on PostgreSQL: key and token columns made in the default collation become COLLATE "C", rows kept',
    async () => {
      // The key and token columns 0001–0008 and the runner made (`since` at most 0008): the ones 0009 converts. A later
      // migration (Phase 2's 0020–0027) makes its own in "C" from the start, and 0009 (frozen, R44) does not name them.
      // The other migration lane's runner tables came after 0009: the runner made them in "C" from the start.
      const later = new Set<string>(['schema_migrations_edition', 'schema_migrations_edition_lock']);
      const binary = Object.entries(TABLE_COLUMNS).flatMap(([table, columns]) =>
        columns
          .filter(() => !later.has(table))
          .filter((c) => c.kind === 'id' || c.kind === 'ulid' || c.kind === 'char' || c.kind === 'key191')
          .filter((c) => c.since.slice(0, 4) <= '0008')
          .map((c) => ({ table, column: c.name, type: (c.kind === 'key191' ? 'varchar(191)' : `char(${String(c.length)})`) as ColumnDataType })),
      );
      const collations = async () => {
        const { rows } = await sql<{ t: string; c: string; coll: string }>`
          SELECT k.relname AS t, a.attname AS c, co.collname AS coll
          FROM pg_attribute a JOIN pg_class k ON k.oid = a.attrelid JOIN pg_namespace n ON n.oid = k.relnamespace
          JOIN pg_collation co ON co.oid = a.attcollation
          WHERE n.nspname = current_schema() AND k.relkind = 'r' AND a.attnum > 0 AND NOT a.attisdropped`.execute(db);
        return Object.fromEntries(rows.map((r) => [`${r.t}.${r.c}`, r.coll]));
      };
      const expected = await collations();
      // The test build's registry also names the fixture levels' tables (test_fixture, 9001_test_expand), which this
      // database, migrated to Phase 1 only, does not have: only the tables it has are checked and converted.
      const tables = new Set(Object.keys(expected).map((k) => k.slice(0, k.indexOf('.'))));
      const present = binary.filter((b) => tables.has(b.table));
      expect(present.length).toBeGreaterThan(0);
      for (const b of present) expect({ ...b, coll: expected[`${b.table}.${b.column}`] }).toEqual({ ...b, coll: 'C' });
      await db.insertInto('settings').values({ scope: 'data', key: 'test.order', value: '1', updated_at: 1, updated_by: null }).execute();
      try {
        // As 0001–0008 of an earlier build made them: in the database's default collation (en_US.UTF-8 here).
        for (const b of present) {
          const type = { toOperationNode: () => DataTypeNode.create(b.type) };
          await db.schema
            .alterTable(b.table)
            .alterColumn(b.column, (ac) => ac.setDataType(sql`${type} collate "default"`))
            .execute();
        }
        const degraded = await collations();
        expect(present.filter((b) => degraded[`${b.table}.${b.column}`] !== 'default')).toEqual([]);
        await PHASE1_MIGRATIONS['0009_ops_jobs']!.up(h.db, h.dialect);
        expect(await collations()).toEqual(expected);
        expect(await db.selectFrom('settings').select('value').where('key', '=', 'test.order').execute()).toEqual([{ value: '1' }]);
        expect(await foreignKeys()).toEqual(EXPECTED_FOREIGN_KEYS);
      } finally {
        await db.deleteFrom('settings').where('key', '=', 'test.order').execute();
      }
    },
  );

  it('has foreign keys for ownership relations only', async () => {
    expect(await foreignKeys()).toEqual(EXPECTED_FOREIGN_KEYS);
  });

  it('SECRET_COLUMNS names columns of the catalog; each id column is the primary key of its table (§7.6 AAD)', async () => {
    for (const s of SECRET_COLUMNS) {
      const columns = Object.keys(await catalogColumns(s.table));
      expect({ secret: `${s.table}.${s.column}`, inCatalog: columns.includes(s.column) }).toEqual({
        secret: `${s.table}.${s.column}`,
        inCatalog: true,
      });
      // The AAD of a secret is `table.column.rowId`: the id must identify the row on its own.
      expect({ secret: `${s.table}.${s.column}`, key: await primaryKey(s.table) }).toEqual({
        secret: `${s.table}.${s.column}`,
        key: [s.idColumn],
      });
      if (s.onlyWhere !== undefined) expect(columns).toContain(s.onlyWhere);
    }
  });

  it('gives every Phase 1 column the type, length, nullability and default of EXPECTED_COLUMNS', async () => {
    const actual: Record<string, Record<string, string>> = {};
    for (const t of Object.keys(EXPECTED_COLUMNS)) actual[t] = await catalogColumns(t);
    expect(actual).toEqual(EXPECTED_COLUMNS);
  });

  it.runIf(ctx.engine.startsWith('mysql') || ctx.engine.startsWith('mariadb'))(
    'MySQL/MariaDB: every text column of a primary or unique key is utf8mb4_bin (R39b), and so are the other key191() columns',
    async () => {
      const { rows: keyed } = await sql<{ table: string; col: string; coll: string | null }>`
        SELECT DISTINCT s.TABLE_NAME AS "table", s.COLUMN_NAME AS col, c.COLLATION_NAME AS coll
        FROM information_schema.STATISTICS s
        JOIN information_schema.COLUMNS c
          ON c.TABLE_SCHEMA = s.TABLE_SCHEMA AND c.TABLE_NAME = s.TABLE_NAME AND c.COLUMN_NAME = s.COLUMN_NAME
        WHERE s.TABLE_SCHEMA = DATABASE() AND s.NON_UNIQUE = 0`.execute(h.db);
      const textual = keyed.filter((r) => r.coll !== null);
      expect(textual.map((r) => `${r.table}.${r.col}`)).toEqual(
        expect.arrayContaining(['user_roles.scope_key', 'custom_field_defs.entity', 'idempotency_keys.subject_type']),
      );
      // Komunitas K1: the named exceptions of usage_stats's primary key (codes and dates, see the fixture) are the only
      // key columns that are not binary.
      const nonBinary = textual.filter((r) => r.coll !== 'utf8mb4_bin').map((r) => `${r.table}.${r.col}`);
      expect(nonBinary.sort()).toEqual(Object.keys(K1_NON_BINARY_KEY_COLUMNS).sort());
      const { rows: all } = await sql<{ table: string; col: string; coll: string }>`
        SELECT TABLE_NAME AS "table", COLUMN_NAME AS col, COLLATION_NAME AS coll FROM information_schema.COLUMNS
        WHERE TABLE_SCHEMA = DATABASE() AND COLLATION_NAME IS NOT NULL`.execute(h.db);
      const binary = all.filter((r) => NON_UNIQUE_BINARY_COLUMNS.includes(`${r.table}.${r.col}`));
      expect(binary.map((r) => [`${r.table}.${r.col}`, r.coll]).sort()).toEqual(
        NON_UNIQUE_BINARY_COLUMNS.map((c) => [c, 'utf8mb4_bin']),
      );
      expect(new Set(all.map((r) => r.coll))).toEqual(new Set(['utf8mb4_bin', 'utf8mb4_unicode_ci']));
    },
  );

  it('seeds audit_head with exactly one row: id 1, last_seq 0, last_hash 64 zeros', async () => {
    expect(await auditHead()).toEqual([RUNNER_ROW_SHAPES.audit_head]);
  });

  it('rejects a recovery code whose user does not exist (foreign key enforced on every dialect)', async () => {
    const orphan = { id: newId(), user_id: newId(), code_hash: hex('a'), used_at: null, created_at: EPOCH_MS };
    await expect(db.insertInto('staff_recovery_codes').values(orphan).execute()).rejects.toThrow();
    expect(await db.selectFrom('staff_recovery_codes').select('id').execute()).toEqual([]);
    // Positive control: with its user present the same row goes in, and deleting the user deletes it (cascade).
    const [user] = sampleRows().staff_users;
    await db.insertInto('staff_users').values({ ...user!, id: orphan.user_id }).execute();
    try {
      await db.insertInto('staff_recovery_codes').values(orphan).execute();
      expect(await db.selectFrom('staff_recovery_codes').select('id').execute()).toEqual([{ id: orphan.id }]);
    } finally {
      await db.deleteFrom('staff_users').where('id', '=', orphan.user_id).execute();
    }
    expect(await db.selectFrom('staff_recovery_codes').select('id').execute()).toEqual([]);
  });

  it('every table accepts full rows written through the DB types and reads them back unchanged', async () => {
    const samples = sampleRows();
    const order = Object.values(TABLES_BY_MIGRATION)
      .flat()
      .filter((t): t is RoundTripTable => t !== 'audit_head');
    expect([...order].sort()).toEqual(Object.keys(samples).sort());
    const rows = samples as Record<RoundTripTable, unknown[]>;
    try {
      for (const t of order) await db.insertInto(t).values(rows[t] as never).execute();
      for (const t of order) {
        const pk = EXPECTED_PRIMARY_KEYS[t];
        const back = await db.selectFrom(t).selectAll().execute();
        const sortKey = (r: unknown) => pk.map((c) => String((r as Record<string, unknown>)[c])).join('|');
        const sorted = (list: readonly unknown[]) => [...list].sort((a, b) => sortKey(a).localeCompare(sortKey(b)));
        // `t` in both sides names the table in a failure message.
        expect({ t, rows: sorted(back) }).toEqual({ t, rows: sorted(rows[t]) });
      }
    } finally {
      for (const t of [...order].reverse()) await db.deleteFrom(t).execute();
    }
  });

  it('fills every Generated column of the DB type from a database default', async () => {
    const samples = sampleRows();
    const tables = (Object.keys(DEFAULTS) as RoundTripTable[]).filter((t) => Object.keys(DEFAULTS[t]).length > 0);
    try {
      for (const t of tables) {
        const defaults: Record<string, unknown> = DEFAULTS[t];
        const minimal = Object.fromEntries(Object.entries(samples[t][0] ?? {}).filter(([column]) => !(column in defaults)));
        await db.insertInto(t).values(minimal as never).execute();
        expect({ t, rows: await db.selectFrom(t).selectAll().execute() }).toEqual({ t, rows: [{ ...minimal, ...defaults }] });
      }
    } finally {
      // Children first (Phase 2: items RESTRICT their record).
      for (const t of [...tables].reverse()) await db.deleteFrom(t).execute();
    }
  });

  it('allows any number of NULLs but no duplicate value in the nullable unique keys (jobs.unique_key, email_key)', async () => {
    const samples = sampleRows();
    const job = (unique_key: string | null) => ({ ...samples.jobs[1]!, id: newId(), unique_key });
    const user = (username_key: string) => ({ ...samples.staff_users[1]!, id: newId(), username_key, email_key: null });
    try {
      await db.insertInto('jobs').values([job(null), job(null), job('sched:x:1')]).execute();
      await db.insertInto('staff_users').values([user('A'), user('B')]).execute();
      expect(await db.selectFrom('jobs').select('unique_key').orderBy('unique_key').execute()).toHaveLength(3);
      const duplicate = await db
        .insertInto('jobs')
        .values(job('sched:x:1'))
        .execute()
        .then(
          () => null,
          (error: unknown) => error,
        );
      expect(isDomainError(duplicate) && duplicate.code).toBe('UNIQUE_VIOLATION');
      const duplicateEmail = await db
        .insertInto('staff_users')
        .values([{ ...user('C'), email_key: 'X@EXAMPLE.TEST' }, { ...user('D'), email_key: 'X@EXAMPLE.TEST' }])
        .execute()
        .then(
          () => null,
          (error: unknown) => error,
        );
      expect(isDomainError(duplicateEmail) && duplicateEmail.code).toBe('UNIQUE_VIOLATION');
      expect(await db.selectFrom('staff_users').select('username_key').orderBy('username_key').execute()).toEqual([
        { username_key: 'A' },
        { username_key: 'B' },
      ]);
    } finally {
      await db.deleteFrom('jobs').execute();
      await db.deleteFrom('staff_users').execute();
    }
  });

  it('accepts a Transaction<DB> from withTx in the DDL helpers (R45)', async () => {
    await withTx(h, async (trx) => {
      await ensureBootstrap(trx, h.dialect);
      await ensureTable(trx, h.dialect, 'locks', 'volatile', 'test', (t) => {
        t.key191('name');
        t.key191('owner');
        t.timestamp('until');
        t.primaryKey(['name']);
      });
      await ensureIndex(trx, h.dialect, 'jobs', 'ix_jobs_status_run_at', ['status', 'run_at']);
    });
    expect(await indexes()).toEqual(EXPECTED_INDEXES);
    expect(typeof ddlHelpersAcceptTransactions).toBe('function');
  });

  it('seeds audit_head once when connections run 0004 at the same time: a duplicate insert counts as seeded', async () => {
    const others = [await testDb({ reset: false }), await testDb({ reset: false })];
    const handles = [h, ...others];
    try {
      for (let round = 0; round < 3; round += 1) {
        await db.deleteFrom('audit_head').execute();
        // Every connection first finds audit_head empty (its SELECT waits for the others'), then inserts: one insert
        // wins and the others get UNIQUE_VIOLATION, which the seed must take as "already seeded".
        const race = seedRace(handles.length);
        await Promise.all(
          handles.map((x) => PHASE1_MIGRATIONS['0004_settings_and_audit']!.up(x.db.withPlugin(race.plugin()), x.dialect)),
        );
        expect({ round, inserts: race.inserts() }).toEqual({ round, inserts: handles.length });
        expect(await auditHead()).toEqual([RUNNER_ROW_SHAPES.audit_head]);
      }
    } finally {
      for (const x of others) await x.close();
    }
  });

  it("declares exactly the columns of the runner's tables and of audit_head in the DB type", async () => {
    for (const [t, shape] of Object.entries(RUNNER_ROW_SHAPES)) {
      const row = await db.selectFrom(t as MigratorTable | 'audit_head').selectAll().executeTakeFirst();
      // The other lane's two tables hold no row while this code ships no migration of that lane: their catalog columns.
      const columns = row === undefined ? Object.keys(await catalogColumns(t)) : Object.keys(row);
      expect({ t, columns: columns.sort() }).toEqual({ t, columns: Object.keys(shape).sort() });
    }
  });

  it('a second run finds nothing to do', async () => {
    expect(await migrate()).toEqual({
      mode: 'up-to-date',
      applied: [],
      schemaVersion: LAST_SCHEMA_VERSION,
      minCodeVersion: '0.0.0',
      edition: { mode: 'empty', applied: [] },
    });
  });

  it('every migration can run again without changing anything (idempotent)', async () => {
    const before = { tables: await tableNames(), registry: await registry(), indexes: await indexes(), head: await auditHead() };
    for (const m of Object.values(PHASE1_MIGRATIONS)) await m.up(h.db, h.dialect);
    expect({ tables: await tableNames(), registry: await registry(), indexes: await indexes(), head: await auditHead() }).toEqual(
      before,
    );
    expect(await foreignKeys()).toEqual(EXPECTED_FOREIGN_KEYS);
  });

  it('a migration that stopped halfway is completed by running it again', async () => {
    const before = { tables: await tableNames(), registry: await registry(), indexes: await indexes() };
    // As if 0002 had stopped after registering user_roles (registry first, then CREATE TABLE) and before the unique
    // index on staff_users.email_key; 0004 before seeding audit_head.
    await db.schema.dropTable('user_roles').execute();
    const dropEmailIndex = db.schema.dropIndex('uq_staff_users_email_key');
    await (mysqlFamily() ? dropEmailIndex.on('staff_users') : dropEmailIndex).execute();
    await db.deleteFrom('audit_head').execute();
    // 0009 stopped after adding its column (MySQL/MariaDB/SQLite apply DDL statement by statement).
    const dropFinishedIndex = db.schema.dropIndex('ix_jobs_finished_at');
    await (mysqlFamily() ? dropFinishedIndex.on('jobs') : dropFinishedIndex).execute();
    await PHASE1_MIGRATIONS['0002_org_and_identity']!.up(h.db, h.dialect);
    await PHASE1_MIGRATIONS['0004_settings_and_audit']!.up(h.db, h.dialect);
    await PHASE1_MIGRATIONS['0009_ops_jobs']!.up(h.db, h.dialect);
    expect({ tables: await tableNames(), registry: await registry(), indexes: await indexes() }).toEqual(before);
    expect(await foreignKeys()).toEqual(EXPECTED_FOREIGN_KEYS);
    expect(await auditHead()).toEqual([RUNNER_ROW_SHAPES.audit_head]);
  });

  it('dropRegisteredTables removes every table again (the foreign keys form no cycle)', async () => {
    await dropRegisteredTables(h.db, h.dialect);
    expect(await tableNames()).toEqual([]);
    await emptyDatabase(h);
  });
});
