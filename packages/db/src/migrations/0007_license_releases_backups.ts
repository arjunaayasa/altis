import { ensureTable } from '../ddl.js';
import type { AltisMigration } from '../migrator.js';

// 0007: the edition state table, the release log (§9.6, §9.7) and the backup list (§9.9).
//
// - license_state (install): reserved for a commercial edition, which keeps its state there (the community edition
//   never writes it). Kept by a restore, like every install table. Keyed by install_id; `clock_high_water` is 0 until a
//   trusted time has been seen.
// - releases_log, backups (history): backed up as an archive; a restore keeps the target's rows.

const NAME = '0007_license_releases_backups';

export const licenseReleasesBackups: AltisMigration = {
  async up(db, dialect) {
    await ensureTable(db, dialect, 'license_state', 'install', NAME, (t) => {
      t.ulid('install_id');
      t.text('license_raw').nullable();
      t.varchar('status_cache', 32).nullable();
      t.timestamp('checked_at').nullable();
      t.timestamp('grace_until').nullable();
      t.timestamp('last_heartbeat_at').nullable();
      t.timestamp('clock_high_water').default(0);
      t.primaryKey(['install_id']);
    });

    await ensureTable(db, dialect, 'releases_log', 'history', NAME, (t) => {
      t.id();
      t.varchar('version', 32);
      t.varchar('action', 32);
      t.varchar('from_version', 32).nullable();
      t.varchar('status', 32);
      t.timestamp('started_at');
      t.timestamp('finished_at').nullable();
      t.ulid('backup_id').nullable();
      t.text('detail').nullable();
    });

    await ensureTable(db, dialect, 'backups', 'history', NAME, (t) => {
      t.id();
      t.varchar('kind', 32);
      t.bigint('size').nullable();
      t.char('sha256', 64).nullable();
      t.varchar('schema_version', 32);
      t.varchar('app_version', 32);
      t.varchar('dialect', 32);
      t.varchar('consistency', 32);
      t.varchar('status', 32);
      t.timestamp('created_at');
    });
  },
};
