import { ensureIndex, ensureTable } from '../ddl.js';
import type { AltisMigration } from '../migrator.js';

// 0005: jobs and schedules (spec §10.1, §10.4), events and their durable consumers (§10.6), notifications (§10.9).
//
// - jobs (volatile): claimed with the dialect-neutral UPDATEs of §10.1; `unique_key` is UNIQUE and set to NULL on a
//   terminal status, so a live job keeps its key and any number of finished ones have none.
// - schedules (config): `next_run_at` is never NULL, since a tick is `... WHERE next_run_at = :seen`.
// - events (volatile): `seq` is the BIGINT auto-increment key (spec §6.1 exception).
// - notifications, notification_reads (data): a read marker belongs to its notification (CASCADE).
// Free-text messages (progress, errors) are TEXT: a too long value must not fail a write under STRICT mode.

const NAME = '0005_jobs_events_notifications';

export const jobsEventsNotifications: AltisMigration = {
  async up(db, dialect) {
    await ensureTable(db, dialect, 'jobs', 'volatile', NAME, (t) => {
      t.id();
      t.varchar('type', 64);
      t.json('payload');
      t.text('secret_param').nullable();
      t.varchar('status', 32);
      t.timestamp('run_at');
      t.int('attempts').default(0);
      t.int('max_attempts');
      t.key191('unique_key').nullable();
      // Binary (ruling R48): the claim's fencing token and holder are compared for identity in WHERE clauses.
      t.key191('lock_token').nullable();
      t.key191('locked_by').nullable();
      t.timestamp('locked_until').nullable();
      t.bool('cancel_requested').default(0);
      t.int('progress').default(0);
      t.text('progress_message').nullable();
      t.text('last_error').nullable();
      t.ulid('created_by').nullable();
      t.timestamp('created_at');
      t.timestamp('updated_at');
      t.timestamp('finished_at').nullable();
    });
    await ensureIndex(db, dialect, 'jobs', 'uq_jobs_unique_key', ['unique_key'], { unique: true });
    await ensureIndex(db, dialect, 'jobs', 'ix_jobs_status_run_at', ['status', 'run_at']);

    await ensureTable(db, dialect, 'schedules', 'config', NAME, (t) => {
      t.key191('name');
      t.varchar('expr', 191);
      t.bool('enabled').default(1);
      t.timestamp('next_run_at');
      t.timestamp('last_run_at').nullable();
      t.primaryKey(['name']);
    });

    await ensureTable(db, dialect, 'events', 'volatile', NAME, (t) => {
      t.serial('seq');
      t.varchar('channel', 128);
      t.varchar('type', 64);
      t.json('payload');
      t.timestamp('created_at');
    });
    // Retention (spec §10.6) deletes by age (> 7 days below every cursor, > 30 days in any case).
    await ensureIndex(db, dialect, 'events', 'ix_events_created_at', ['created_at']);

    await ensureTable(db, dialect, 'event_consumers', 'volatile', NAME, (t) => {
      t.key191('name');
      t.bigint('cursor').default(0);
      t.bool('enabled').default(1);
      t.timestamp('updated_at');
      t.bool('needs_full_reindex').default(0);
      t.primaryKey(['name']);
    });

    await ensureTable(db, dialect, 'notifications', 'data', NAME, (t) => {
      t.id();
      // Permission names and message keys compare exactly, like role_permissions.permission (R17).
      t.key191('audience_permission').nullable();
      t.ulid('user_id').nullable();
      t.varchar('type', 64);
      t.key191('title_key');
      t.json('params');
      t.text('link').nullable();
      t.timestamp('created_at');
      t.timestamp('expires_at');
    });
    await ensureIndex(db, dialect, 'notifications', 'ix_notifications_user_id', ['user_id']);
    await ensureIndex(db, dialect, 'notifications', 'ix_notifications_audience_permission', ['audience_permission']);
    await ensureIndex(db, dialect, 'notifications', 'ix_notifications_created_at', ['created_at']);
    // Retention (90 days, spec §10.9) deletes by expires_at.
    await ensureIndex(db, dialect, 'notifications', 'ix_notifications_expires_at', ['expires_at']);

    await ensureTable(db, dialect, 'notification_reads', 'data', NAME, (t) => {
      t.ulid('notification_id');
      t.ulid('user_id');
      t.timestamp('read_at');
      t.primaryKey(['notification_id', 'user_id']);
      t.foreignKey('notification_id', 'notifications', 'id', { onDelete: 'cascade' });
    });
  },
};
