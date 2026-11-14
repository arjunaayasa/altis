import { newId } from '@altis/shared';
import type { MatrixSeed } from '../matrix-fixtures.js';
import type { AreaMatrix } from './catalog.js';

// The matrix rows, fixtures and `system` route ids of a period's accreditation documents: one row per route id in the
// row format of db/matrix.test.ts's CATALOG, one fixture per route in the same order. Every route is `deny` in
// maintenance, so there is no maintenance entry. Each takes `accreditation.workspace.read`, makes a file (`system`)
// and appends `reports.run.start`; the evidence file and the simulation print the staff's names, so they also want a
// fresh re-authentication, while the statement of 1 000 titles names no one.
//
// Each call seeds an open period of the test profile's school instrument straight into the table, so that a super
// admin's call succeeds whatever the personas before it did.

const READ = 'P:accreditation.workspace.read';

/** An open period of `test-sch`, written at the seed's time; its id. */
async function seedPeriod(s: MatrixSeed): Promise<string> {
  const id = newId(s.now);
  await s.h.db
    .insertInto('accred_periods')
    .values({
      id,
      branch_id: null,
      name: 'Periode Dokumen Matriks',
      kind: 'school_year',
      starts_on: '2025-07-01',
      ends_on: '2026-06-30',
      instrument_id: 'test-sch',
      status: 'open',
      frozen_at: null,
      frozen_by: null,
      profile: '{"schoolLevel":"sma_smk_ma"}',
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

export const MATRIX: AreaMatrix = {
  rows: {
    'accreditation.dossier.create': `POST /api/v1/accreditation/periods/:id/dossier | ${READ} | - | reauth | system | deny | store | reports.run.start | handler | -`,
    'accreditation.self_assessment.create': `POST /api/v1/accreditation/periods/:id/self-assessment | ${READ} | - | reauth | system | deny | store | reports.run.start | handler | -`,
    'accreditation.statement_1000.create': `POST /api/v1/accreditation/periods/:id/statement-1000 | ${READ} | - | - | system | deny | store | reports.run.start | handler | -`,
  },
  fixtures: {
    'accreditation.dossier.create': async (s) => ({ params: { id: await seedPeriod(s) }, body: { format: 'pdf' } }),
    'accreditation.self_assessment.create': async (s) => ({ params: { id: await seedPeriod(s) }, body: {} }),
    'accreditation.statement_1000.create': async (s) => ({ params: { id: await seedPeriod(s) }, body: {} }),
  },
  maintenance: {},
  systemRoutes: ['accreditation.dossier.create', 'accreditation.self_assessment.create', 'accreditation.statement_1000.create'],
};
