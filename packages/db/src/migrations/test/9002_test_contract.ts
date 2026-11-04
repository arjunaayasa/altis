import { ensureColumn } from '../../ddl.js';
import type { AltisMigration } from '../../migrator.js';

// 9002 (test builds only; decision D1d-26, spec §12.5 "0.3.0-test + 9002_test_contract (menaikkan
// min_code_version)"): a contract migration. It adds `test_fixture.extra` VARCHAR(191) NOT NULL DEFAULT '' (one ALTER
// TABLE ... ADD COLUMN), and declares that the database needs code 0.3.0-test or newer from then on: the migrator
// raises schema_meta.min_code_version before the column is added, so 0.2.0-test sees `too-old` and its revert has to
// restore the `pre_update` backup instead of moving the pointer back (spec §9.7, decision D1d-21).
//
// Frozen like a shipped migration (ruling R44). Only releaseMigrations() at fixture level 3 of a test build runs it.

export const testContract: AltisMigration = {
  contract: { minCodeVersion: '0.3.0-test' },
  async up(db, dialect) {
    await ensureColumn(db, dialect, 'test_fixture', (t) => t.varchar('extra', 191).default(''));
  },
};
