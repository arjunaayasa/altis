import { newId } from '@altis/shared';
import type { MatrixSeed } from '../matrix-fixtures.js';
import type { AreaMatrix } from './catalog.js';

// The matrix rows, fixtures, maintenance entries and `system` route ids of the monthly usage table and the member-type
// mapping: one row per route id in the row format of db/matrix.test.ts's CATALOG, one fixture per route in the same
// order. Every route is `deny` in maintenance and none is `system`, so there is no maintenance entry and no system route
// id. Reading takes `accreditation.workspace.read`, writing `accreditation.workspace.manage`.
//
// Each call that names a period seeds an open period of its own straight into the table, so that a super admin's call
// succeeds (one audit entry) whatever the personas before it did. The mapping write sets the row of deleted members,
// which may always be created.

/** An open, live statistics period at version 0; its id. */
async function seedPeriod(s: MatrixSeed): Promise<string> {
  const id = newId(s.now);
  await s.h.db
    .insertInto('accred_periods')
    .values({
      id,
      branch_id: null,
      name: 'Periode Matriks Penggunaan',
      kind: 'calendar_year',
      starts_on: '2025-01-01',
      ends_on: '2025-12-31',
      instrument_id: 'general-stats',
      status: 'open',
      frozen_at: null,
      frozen_by: null,
      profile: '{}',
      all_registered_confirmed: 0,
      archived_at: null,
      version: 0,
      created_at: s.now,
      created_by: null,
      updated_at: s.now,
      updated_by: null,
    })
    .execute();
  return id;
}

const READ = 'P:accreditation.workspace.read';
const MANAGE = 'P:accreditation.workspace.manage';

export const MATRIX: AreaMatrix = {
  rows: {
    'accreditation.usage.get': `GET /api/v1/accreditation/periods/:id/usage | ${READ} | - | - | read | deny | none | null | - | -`,
    'accreditation.usage.put': `PUT /api/v1/accreditation/periods/:id/usage | ${MANAGE} | - | - | write | deny | store | accreditation.usage.update | handler | -`,
    'accreditation.usage_groups.get': `GET /api/v1/accreditation/usage-groups | ${READ} | - | - | read | deny | none | null | - | -`,
    'accreditation.usage_groups.put': `PUT /api/v1/accreditation/usage-groups | ${MANAGE} | - | - | write | deny | store | accreditation.usage_groups.update | handler | -`,
  },
  fixtures: {
    'accreditation.usage.get': async (s) => ({ params: { id: await seedPeriod(s) } }),
    'accreditation.usage.put': async (s) => ({
      params: { id: await seedPeriod(s) },
      body: { cells: [{ metric: 'visits', month: '2025-03', groupKey: '', value: 120 }] },
    }),
    'accreditation.usage_groups.get': async () => ({}),
    'accreditation.usage_groups.put': async () => ({ body: { groups: [{ groupKey: 'member_unknown', accredGroup: 'student' }] } }),
  },
  maintenance: {},
  systemRoutes: [],
};
