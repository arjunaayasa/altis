import { newId } from '@altis/shared';
import type { MatrixSeed } from '../matrix-fixtures.js';
import type { AreaMatrix } from './catalog.js';

// The matrix rows and fixtures of the SLiMS usage import: one row per route id in the row format of db/matrix.test.ts's
// CATALOG, one fixture per route in the same order. Both routes are `deny` in maintenance (no maintenance entry) and
// neither is `mode: system`.
//
// The database the fixtures name is on the loopback at the discard port: the connection test fails at once and answers
// `{ok: false}` without the network. The start needs no connection: the first allowed caller starts an import from a
// period of its own, every later one joins the live import (one job row).

const DB = { host: '127.0.0.1', port: 9, user: 'baca', password: 'matriks-sandi', database: 'slims', tls: false };

/** A period of the accreditation workspace, written straight into its table. */
async function seedPeriod(s: MatrixSeed): Promise<string> {
  const id = newId();
  await s.h.db
    .insertInto('accred_periods')
    .values({
      id,
      branch_id: null,
      name: `Periode ${id.slice(-6)}`,
      kind: 'school_year',
      starts_on: '2025-07-01',
      ends_on: '2026-06-30',
      instrument_id: 'test-sch',
      status: 'open',
      frozen_at: null,
      frozen_by: null,
      profile: '{}',
      students: null,
      teachers: null,
      edu_staff: null,
      classes: null,
      population_served: null,
      teachers_using: null,
      user_pcs: null,
      staff_pcs: null,
      ict_devices: null,
      scanners: null,
      floor_m2: null,
      bandwidth_mbps: null,
      hours_per_week: null,
      services: null,
      external_website_url: null,
      created_at: s.now,
      updated_at: s.now,
      created_by: null,
      updated_by: null,
      archived_at: null,
    })
    .execute();
  return id;
}

export const MATRIX: AreaMatrix = {
  rows: {
    'accreditation.slims_usage.test':
      'POST /api/v1/accreditation/slims-usage/test-connection | P:accreditation.workspace.manage | - | reauth | read | deny | none | null | self | -',
    'accreditation.slims_usage.start':
      'POST /api/v1/accreditation/periods/:id/slims-usage | P:accreditation.workspace.manage | - | reauth | write | deny | none | accreditation.slims_usage.start | handler | -',
  },
  fixtures: {
    'accreditation.slims_usage.test': async () => ({ body: { db: DB } }),
    'accreditation.slims_usage.start': async (s) => ({ params: { id: await seedPeriod(s) }, body: { source: { kind: 'db', db: DB } } }),
  },
  maintenance: {},
  systemRoutes: [],
};
