import { isDomainError } from '@altis/shared';
import type { Kysely } from 'kysely';
import { ensureIndex, ensureTable } from '../ddl.js';
import type { AltisMigration } from '../migrator.js';

// 0004: settings and the hash-chained audit log (spec §6.3, §6.5, §7.8).
//
// - settings: the table is class data; each row's class follows its `scope` (SETTINGS_SCOPE_CLASS, ruling R30).
//   `value` is NULL for a secret that is cleared or could not be carried over by a restore (ruling R42).
// - audit_log: class history, rows never updated. `seq` is a BIGINT taken from audit_head under its row lock
//   (auditAppend), UNIQUE; `id` is the ULID primary key. `entity_id` is key191() (ruling R40b): entities such as a
//   settings key or a schedule name are not keyed by a ULID, and a CHAR column would be blank-padded on PostgreSQL
//   (breaking the hash chain). `actor_id` and `branch_id` stay CHAR(26): a ULID or NULL only, which auditAppend
//   (Task 10) validates.
// - audit_head: class install (kept by a restore), one row seeded here: id 1, last_seq 0, last_hash = 64 zeros
//   (the genesis prev_hash).

const NAME = '0004_settings_and_audit';

/** audit_head as this migration knows it (a migration runs against the schema of its moment in history). */
type HeadTables = { audit_head: { id: number; last_seq: number; last_hash: string } };

const HEAD_ID = 1;
const GENESIS_HASH = '0'.repeat(64);

/**
 * Inserts the audit_head row unless it is there. A duplicate insert (another connection seeded it in between,
 * UNIQUE_VIOLATION) counts as seeded once the row can be read back; inside a transaction (PostgreSQL runs the
 * migrations in one) the error stands, since PostgreSQL has aborted the transaction anyway (the migration locks
 * make that case unreachable).
 */
async function seedAuditHead(db: Kysely<HeadTables>): Promise<void> {
  const present = async () =>
    (await db.selectFrom('audit_head').select('id').where('id', '=', HEAD_ID).executeTakeFirst()) !== undefined;
  if (await present()) return;
  try {
    await db.insertInto('audit_head').values({ id: HEAD_ID, last_seq: 0, last_hash: GENESIS_HASH }).execute();
  } catch (error) {
    if (db.isTransaction || !isDomainError(error) || error.code !== 'UNIQUE_VIOLATION' || !(await present())) throw error;
  }
}

export const settingsAndAudit: AltisMigration = {
  async up(db, dialect) {
    await ensureTable(db, dialect, 'settings', 'data', NAME, (t) => {
      t.key191('key');
      t.text('value').nullable();
      t.bool('is_secret').default(0);
      // No default: backup and restore treat a row by its scope.
      t.varchar('scope', 32);
      t.timestamp('updated_at');
      t.ulid('updated_by').nullable();
      t.primaryKey(['key']);
    });

    await ensureTable(db, dialect, 'audit_log', 'history', NAME, (t) => {
      t.id();
      t.bigint('seq');
      t.timestamp('at');
      t.varchar('actor_type', 32);
      t.ulid('actor_id').nullable();
      t.varchar('action', 64);
      t.varchar('entity', 64).nullable();
      t.key191('entity_id').nullable();
      t.ulid('branch_id').nullable();
      t.varchar('ip', 45).nullable();
      t.json('meta');
      t.char('prev_hash', 64);
      t.char('hash', 64);
    });
    await ensureIndex(db, dialect, 'audit_log', 'uq_audit_log_seq', ['seq'], { unique: true });
    await ensureIndex(db, dialect, 'audit_log', 'ix_audit_log_at', ['at']);
    await ensureIndex(db, dialect, 'audit_log', 'ix_audit_log_actor_id', ['actor_id']);
    await ensureIndex(db, dialect, 'audit_log', 'ix_audit_log_entity_entity_id', ['entity', 'entity_id']);

    await ensureTable(db, dialect, 'audit_head', 'install', NAME, (t) => {
      t.smallint('id');
      t.bigint('last_seq');
      t.char('last_hash', 64);
      t.primaryKey(['id']);
    });
    await seedAuditHead(db as Kysely<HeadTables>);
  },
};
