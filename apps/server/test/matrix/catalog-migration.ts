import { newId } from '@altis/shared';
import type { MatrixSeed } from '../matrix-fixtures.js';
import type { AreaMatrix } from './catalog.js';

// The matrix rows, fixtures and maintenance entries of the SLiMS migration (Phase 2 Task 23; the plan's route catalog):
// one row per route id in the row format of db/matrix.test.ts's CATALOG, one fixture per route in the same order. Both
// routes are `deny` in maintenance, so there is no maintenance entry.
//
// The database the fixtures name is on the loopback at the discard port: whatever source reader is in place (Task 3's
// stub, Task 10's mysql2 reader) fails at once, and the connection test answers `{ok: false}` without the network. The
// start is a dry run into a branch of its own: the first allowed caller starts it, every later one joins the live
// migration (one job row).

const DB_SOURCE = { kind: 'db', host: '127.0.0.1', port: 9, user: 'baca', password: 'matriks-sandi', database: 'slims', tls: false };

/** A branch of its own, inserted straight into the table. */
async function seedMigrationBranch(s: MatrixSeed): Promise<string> {
  const id = newId();
  const code = `G${id.slice(-12)}`;
  await s.h.db
    .insertInto('branches')
    .values({ id, code_key: code, code_display: code, name: `Cabang ${code}`, timezone: 'Asia/Jakarta', created_at: s.now, updated_at: s.now })
    .execute();
  return id;
}

export const MATRIX: AreaMatrix = {
  rows: {
    'catalog.migrations.slims.test':
      'POST /api/v1/catalog/migrations/slims/test-connection | P:catalog.migration.run | - | reauth | read | deny | none | null | self | -',
    'catalog.migrations.slims.start':
      'POST /api/v1/catalog/migrations/slims | P:catalog.migration.run | - | reauth | write | deny | none | catalog.migration.start | handler | -',
  },
  fixtures: {
    'catalog.migrations.slims.test': async () => ({ body: { source: DB_SOURCE } }),
    'catalog.migrations.slims.start': async (s) => ({ body: { source: DB_SOURCE, branchId: await seedMigrationBranch(s), allowNonEmpty: false, dryRun: true } }),
  },
  maintenance: {},
};
