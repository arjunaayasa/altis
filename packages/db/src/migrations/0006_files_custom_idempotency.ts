import { ensureIndex, ensureTable } from '../ddl.js';
import type { AltisMigration } from '../migrator.js';

// 0006: files and upload sessions (spec §7.5), custom fields (§6.1), idempotency keys (§7.9).
//
// - files (data): no paths in the database; a file's path is derived from its id. `owner_*` is the entity the file
//   belongs to, without a foreign key; `owner_id` is key191() (ruling R41), since an owner need not be ULID-keyed.
// - upload_sessions (volatile): `owner` is `<subject_type>:<subject_id>` (at most 3 sessions per subject).
// - custom_field_defs / custom_values (data): a value belongs to its field (CASCADE); `entity_id` is the id of the
//   extended row, without a foreign key (the entity varies per field).
// - idempotency_keys (volatile): `key` is key191() so keys compare exactly (binary collation on MySQL/MariaDB);
//   the code limits it to 64 characters (spec §7.9).
// Every text column of a primary or unique key is key191() (ruling R39b): custom_field_defs.entity,
// idempotency_keys.subject_type.

const NAME = '0006_files_custom_idempotency';

export const filesCustomIdempotency: AltisMigration = {
  async up(db, dialect) {
    await ensureTable(db, dialect, 'files', 'data', NAME, (t) => {
      t.id();
      t.varchar('original_name', 191);
      t.varchar('mime', 191);
      t.bigint('size');
      t.char('sha256', 64);
      t.varchar('context', 64);
      t.varchar('owner_type', 32).nullable();
      t.key191('owner_id').nullable();
      t.varchar('access', 32);
      t.varchar('status', 32);
      t.timestamp('created_at');
      t.ulid('created_by').nullable();
    });
    await ensureIndex(db, dialect, 'files', 'ix_files_sha256', ['sha256']);
    await ensureIndex(db, dialect, 'files', 'ix_files_owner_type_owner_id', ['owner_type', 'owner_id']);

    await ensureTable(db, dialect, 'upload_sessions', 'volatile', NAME, (t) => {
      t.id();
      // Binary (ruling R48): an identity (`<subject_type>:<subject_id>`) compared in WHERE clauses.
      t.key191('owner');
      t.varchar('context', 64);
      t.bigint('size');
      t.char('sha256', 64);
      t.int('chunk_size');
      t.bigint('received').default(0);
      t.timestamp('expires_at');
    });
    await ensureIndex(db, dialect, 'upload_sessions', 'ix_upload_sessions_owner', ['owner']);

    await ensureTable(db, dialect, 'custom_field_defs', 'data', NAME, (t) => {
      t.id();
      t.key191('entity');
      t.key191('code_key');
      t.varchar('code_display', 191);
      t.varchar('label', 191);
      t.varchar('type', 32);
      t.json('options').nullable();
      t.bool('is_required').default(0);
      t.int('sort_order').default(0);
      t.timestamp('archived_at').nullable();
      t.int('version').default(0);
      t.timestamp('created_at');
      t.ulid('created_by').nullable();
      t.timestamp('updated_at');
      t.ulid('updated_by').nullable();
    });
    await ensureIndex(db, dialect, 'custom_field_defs', 'uq_custom_field_defs_entity_code_key', ['entity', 'code_key'], {
      unique: true,
    });

    await ensureTable(db, dialect, 'custom_values', 'data', NAME, (t) => {
      t.ulid('field_id');
      t.ulid('entity_id');
      t.json('value');
      t.timestamp('updated_at');
      t.ulid('updated_by').nullable();
      t.primaryKey(['field_id', 'entity_id']);
      t.foreignKey('field_id', 'custom_field_defs', 'id', { onDelete: 'cascade' });
    });
    await ensureIndex(db, dialect, 'custom_values', 'ix_custom_values_entity_id', ['entity_id']);

    await ensureTable(db, dialect, 'idempotency_keys', 'volatile', NAME, (t) => {
      t.key191('subject_type');
      t.ulid('subject_id');
      t.key191('key');
      t.char('request_hash', 64);
      t.varchar('status', 32);
      t.timestamp('locked_until');
      t.smallint('response_status').nullable();
      t.text('response_body').nullable();
      t.timestamp('created_at');
      t.primaryKey(['subject_type', 'subject_id', 'key']);
    });
    await ensureIndex(db, dialect, 'idempotency_keys', 'ix_idempotency_keys_created_at', ['created_at']);
  },
};
