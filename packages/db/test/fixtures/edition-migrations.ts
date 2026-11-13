import { ensureTable } from '../../src/ddl.js';
import type { AltisMigration } from '../../src/migrator.js';

// A test-only lane of migrations of the other lane ("migrasi jalur lain"): one migration that makes a table of its
// own, class data, registered in schema_tables with the migration's name as its created_by, as such a lane records the
// tables it makes. Injected through `MigrationOptions.editionMigrations`; this edition ships no migration of the lane.

/** The name of the lane's one migration. */
export const EDITION_TEST_MIGRATION = 'e0001_test_widgets';

/** The table it makes. */
export const EDITION_TEST_TABLE = 'edtest_widgets';

/** `e0001_test_widgets`: the table `edtest_widgets (id ULID, label VARCHAR(64))`, class data. */
export const testWidgets: AltisMigration = {
  async up(db, dialect) {
    await ensureTable(db, dialect, 'edtest_widgets', 'data', 'e0001_test_widgets', (t) => {
      t.ulid('id');
      t.varchar('label', 64);
      t.primaryKey(['id']);
    });
  },
};

/** The test lane: `e0001_test_widgets` only. */
export const EDITION_TEST_MIGRATIONS: Readonly<Record<string, AltisMigration>> = Object.freeze({ e0001_test_widgets: testWidgets });
