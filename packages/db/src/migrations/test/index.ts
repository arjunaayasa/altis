import type { AltisMigration } from '../../migrator.js';
import { testExpand } from './9001_test_expand.js';
import { testContract } from './9002_test_contract.js';

// The fixture migrations of the test releases (decision D1d-26): what level 2 (0.2.0-test) and level 3 (0.3.0-test)
// add to PHASE1_MIGRATIONS. Only `migrationsForLevel` (../index.ts) reads this module; a production server bundle
// never references it, so esbuild leaves it out (the release's PRODUCTION_LEAK_NEEDLES check that).

/** The migrations fixture `level` adds to PHASE1_MIGRATIONS: none below 2, 9001 at 2, 9001 and 9002 at 3. */
export function fixtureMigrations(level: number): Record<string, AltisMigration> {
  if (level >= 3) return { '9001_test_expand': testExpand, '9002_test_contract': testContract };
  if (level === 2) return { '9001_test_expand': testExpand };
  return {};
}
