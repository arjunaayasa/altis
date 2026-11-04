import { ensureTable } from '../../ddl.js';
import type { AltisMigration } from '../../migrator.js';

// 9001 (test builds only; decision D1d-26, spec §12.5 "0.2.0-test + migrasi 9001_test_expand"): an expand migration
// that makes one table, so that an update from 0.1.0-test to 0.2.0-test has a schema change to apply, to back up
// before (`pre_update`) and to revert.
//
// - test_fixture (data): `id` a ULID primary key, `note` VARCHAR(191), `created_at` BIGINT, all NOT NULL. Class
//   `data`, so a backup holds its rows and a restore loads them (spec §6.5).
//
// Frozen like a shipped migration (ruling R44): the table and its class are literals. Only releaseMigrations() at
// fixture level 2 or 3 of a test build runs it; production builds never contain it (the release's leak scan checks).

const NAME = '9001_test_expand';

export const testExpand: AltisMigration = {
  async up(db, dialect) {
    await ensureTable(db, dialect, 'test_fixture', 'data', NAME, (t) => {
      t.ulid('id');
      t.varchar('note', 191);
      t.bigint('created_at');
      t.primaryKey(['id']);
    });
  },
};
