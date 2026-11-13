import { newId } from '@altis/shared';
import type { MatrixSeed } from '../matrix-fixtures.js';
import type { AreaMatrix } from './catalog.js';

// The matrix rows, fixtures, maintenance entries and `system` route ids of the instruments, the accreditation periods and
// their answers: one row per route id in the row format of db/matrix.test.ts's CATALOG, one fixture per route in the
// same order. Every route is `deny` in maintenance and none is `system`, so there is no maintenance entry and no system
// route id. Reading takes `accreditation.workspace.read`, writing `accreditation.workspace.manage`.
//
// Each call that names a period seeds an open period of its own straight into the table, so that a super admin's call
// succeeds (one audit entry) whatever the personas before it did: the statistics mode for the period routes (it fits
// every library type, the installation's unset one included), the test profile's school instrument for an answer.

/** An open, live period at version 0 of `instrumentId`; its id. */
async function seedPeriod(s: MatrixSeed, instrumentId: 'general-stats' | 'test-sch'): Promise<string> {
  const id = newId(s.now);
  const school = instrumentId === 'test-sch';
  await s.h.db
    .insertInto('accred_periods')
    .values({
      id,
      branch_id: null,
      name: 'Periode Matriks',
      kind: school ? 'school_year' : 'calendar_year',
      starts_on: school ? '2025-07-01' : '2025-01-01',
      ends_on: school ? '2026-06-30' : '2025-12-31',
      instrument_id: instrumentId,
      status: 'open',
      frozen_at: null,
      frozen_by: null,
      profile: school ? '{"schoolLevel":"sma_smk_ma"}' : '{}',
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
    'accreditation.instruments.list': `GET /api/v1/accreditation/instruments | ${READ} | - | - | read | deny | none | null | - | -`,
    'accreditation.periods.list': `GET /api/v1/accreditation/periods | ${READ} | - | - | read | deny | none | null | - | -`,
    'accreditation.periods.get': `GET /api/v1/accreditation/periods/:id | ${READ} | - | - | read | deny | none | null | - | -`,
    'accreditation.periods.create': `POST /api/v1/accreditation/periods | ${MANAGE} | - | - | write | deny | store | accreditation.period.create | handler | -`,
    'accreditation.periods.update': `PATCH /api/v1/accreditation/periods/:id | ${MANAGE} | - | - | write | deny | store | accreditation.period.update | handler | -`,
    'accreditation.periods.archive': `DELETE /api/v1/accreditation/periods/:id | ${MANAGE} | - | - | write | deny | store | accreditation.period.archive | handler | -`,
    'accreditation.answers.put': `PUT /api/v1/accreditation/periods/:id/answers/:code | ${MANAGE} | - | - | write | deny | store | accreditation.answer.update | handler | -`,
  },
  fixtures: {
    'accreditation.instruments.list': async () => ({}),
    'accreditation.periods.list': async () => ({}),
    'accreditation.periods.get': async (s) => ({ params: { id: await seedPeriod(s, 'general-stats') } }),
    'accreditation.periods.create': async () => ({
      body: { name: 'Statistik Matriks', instrumentId: 'general-stats', kind: 'calendar_year', startYear: 2025 },
    }),
    'accreditation.periods.update': async (s) => ({ params: { id: await seedPeriod(s, 'general-stats') }, body: { version: 0, students: 100 } }),
    'accreditation.periods.archive': async (s) => ({ params: { id: await seedPeriod(s, 'general-stats') } }),
    'accreditation.answers.put': async (s) => ({
      params: { id: await seedPeriod(s, 'test-sch'), code: 'SCH-SP1' },
      body: { answer: 'b', mode: 'manual', note: null },
    }),
  },
  maintenance: {},
  systemRoutes: [],
};
