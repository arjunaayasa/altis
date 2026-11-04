import { ensureByteOrder, ensureColumn, ensureIndex, type ByteOrderColumn } from '../ddl.js';
import type { AltisMigration } from '../migrator.js';

// 0009: what the Phase 1c job runner needs on `jobs` (spec §10.1), and byte-ordered keys on PostgreSQL. No table is
// created, so no table class is named here (ruling R44).
//
// - jobs.point_of_no_return: SMALLINT 0/1, default 0. Set by a handler's `markPointOfNoReturn()` (spec §10.1
//   JobContext): from then on the job can no longer be cancelled (JOB_NOT_CANCELLABLE). Added with one
//   ALTER TABLE ... ADD COLUMN; the default fills the rows already there.
// - ix_jobs_finished_at (jobs.finished_at): job retention deletes finished jobs by age (decision C26).
// - PostgreSQL only (ruling R1c-15): the key and token columns of 0001–0008 and of the runner's own tables
//   (id(), ulid(), char(), key191()) become COLLATE "C", as ensureTable now makes them. Columns made by an earlier
//   build kept the database's default collation, so keyset batches in byte order (readPkBatch) could not use their
//   primary key indexes: every batch scanned and sorted the rest of the table. MySQL/MariaDB (utf8mb4_bin since
//   their creation, R17) and SQLite (BINARY) send nothing for it. The columns are listed here as literals: a shipped
//   migration is frozen (R44), whatever TABLE_COLUMNS later holds.
//
// Expand-only and idempotent like the others: ensureColumn, ensureIndex and ensureByteOrder check the catalog
// first, so a run that stopped between two statements (MySQL/MariaDB and SQLite apply DDL statement by statement)
// is completed by running it again.

const id = (name = 'id'): ByteOrderColumn => ({ name, kind: 'id' });
const ulid = (name: string): ByteOrderColumn => ({ name, kind: 'ulid' });
const key191 = (name: string): ByteOrderColumn => ({ name, kind: 'key191' });
const char = (name: string, length: number): ByteOrderColumn => ({ name, kind: 'char', length });

/** The key and token columns of every table made before 0009, by table, in creation order. */
const BYTE_ORDER_COLUMNS: ReadonlyArray<readonly [string, readonly ByteOrderColumn[]]> = [
  ['schema_tables', [key191('name')]],
  ['schema_meta', [char('install_id', 26)]],
  ['schema_migrations', [key191('name')]],
  ['schema_migrations_lock', [key191('id')]],
  ['locks', [key191('name'), key191('owner')]],
  ['branches', [id(), key191('code_key'), ulid('created_by'), ulid('updated_by')]],
  ['staff_users', [id(), key191('username_key'), key191('email_key'), ulid('created_by'), ulid('updated_by')]],
  ['staff_recovery_codes', [id(), ulid('user_id'), char('code_hash', 64)]],
  ['roles', [id(), key191('key'), ulid('created_by'), ulid('updated_by')]],
  ['role_permissions', [ulid('role_id'), key191('permission')]],
  ['user_roles', [id(), ulid('user_id'), ulid('role_id'), ulid('branch_id'), key191('scope_key'), ulid('created_by')]],
  ['sessions', [char('id', 64), ulid('subject_id'), char('remember_selector', 24)]],
  ['remember_tokens', [char('selector', 24), char('validator_hash', 64), char('prev_validator_hash', 64), ulid('subject_id')]],
  ['password_resets', [char('token_hash', 64), ulid('subject_id')]],
  ['rate_limits', [char('bucket', 64)]],
  ['settings', [key191('key'), ulid('updated_by')]],
  ['audit_log', [id(), ulid('actor_id'), key191('entity_id'), ulid('branch_id'), char('prev_hash', 64), char('hash', 64)]],
  ['audit_head', [char('last_hash', 64)]],
  ['jobs', [id(), key191('unique_key'), key191('lock_token'), key191('locked_by'), ulid('created_by')]],
  ['schedules', [key191('name')]],
  ['event_consumers', [key191('name')]],
  ['notifications', [id(), key191('audience_permission'), ulid('user_id'), key191('title_key')]],
  ['notification_reads', [ulid('notification_id'), ulid('user_id')]],
  ['files', [id(), char('sha256', 64), key191('owner_id'), ulid('created_by')]],
  ['upload_sessions', [id(), key191('owner'), char('sha256', 64)]],
  ['custom_field_defs', [id(), key191('entity'), key191('code_key'), ulid('created_by'), ulid('updated_by')]],
  ['custom_values', [ulid('field_id'), ulid('entity_id'), ulid('updated_by')]],
  ['idempotency_keys', [key191('subject_type'), ulid('subject_id'), key191('key'), char('request_hash', 64)]],
  ['license_state', [ulid('install_id')]],
  ['releases_log', [id(), ulid('backup_id')]],
  ['backups', [id(), char('sha256', 64)]],
];

export const opsJobs: AltisMigration = {
  async up(db, dialect) {
    await ensureColumn(db, dialect, 'jobs', (t) => t.bool('point_of_no_return').default(0));
    await ensureIndex(db, dialect, 'jobs', 'ix_jobs_finished_at', ['finished_at']);
    for (const [table, columns] of BYTE_ORDER_COLUMNS) await ensureByteOrder(db, dialect, table, columns);
  },
};
