import { newId } from '@altis/shared';
import type { MatrixSeed } from '../matrix-fixtures.js';
import type { AreaMatrix } from './catalog.js';

// The matrix rows, fixtures, maintenance entries and `system` route ids of the bulk change of the records'
// accreditation fields: one row per route id in the row format of db/matrix.test.ts's CATALOG, one fixture per route
// in the same order. The route is `deny` in maintenance and `write` (no `system` route), so there is no maintenance
// entry and no system route id. Each call seeds a record of its own, so a super admin's call succeeds (one audit
// entry) whatever the personas before it did.

/** A live record of its own (version 0), seeded straight into the table; its id. */
async function seedRecord(s: MatrixSeed): Promise<string> {
  const buku = (await s.h.db.selectFrom('material_types').select('id').where('code_key', '=', 'BUKU').executeTakeFirstOrThrow()).id;
  const id = newId();
  await s.h.db
    .insertInto('records')
    .values({
      id,
      material_type_id: buku,
      title: 'Cantuman Massal Matriks',
      title_key: 'cantuman massal matriks',
      source: 'manual',
      changed_at: s.now,
      archived_at: null,
      created_at: s.now,
      created_by: null,
      updated_at: s.now,
      updated_by: null,
    })
    .execute();
  return id;
}

export const MATRIX: AreaMatrix = {
  rows: {
    'catalog.records.bulk':
      'POST /api/v1/catalog/records/bulk | P:catalog.records.manage | - | - | write | deny | store | catalog.record.bulk_update | handler | -',
  },
  fixtures: {
    'catalog.records.bulk': async (s) => ({ body: { ids: [await seedRecord(s)], set: { referenceKind: 'atlas' } } }),
  },
  maintenance: {},
  systemRoutes: [],
};
