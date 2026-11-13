import { newId } from '@altis/shared';
import type { MatrixSeed } from '../matrix-fixtures.js';
import type { AreaMatrix } from './catalog.js';

// The matrix rows, fixtures, maintenance entries and `system` route ids of the evidence files: one row per route id in
// the row format of db/matrix.test.ts's CATALOG, one fixture per route in the same order. Every route is `deny` in
// maintenance and none is a `system` route, so there is no maintenance entry and no system route id.
//
// Each call gets its own open period of the test instrument `test-sch` and its own completed `accreditation.evidence`
// upload (a `files` row as completion leaves it; no route here reads the blob), so that a super admin's call succeeds
// (one audit entry) whatever the personas before it did.

/** An open period of `test-sch`; its id. */
async function seedPeriod(s: MatrixSeed): Promise<string> {
  const id = newId();
  await s.h.db
    .insertInto('accred_periods')
    .values({
      id,
      name: 'Periode Matriks',
      instrument_id: 'test-sch',
      kind: 'school_year',
      starts_on: '2025-07-01',
      ends_on: '2026-06-30',
      branch_id: null,
      profile: '{}',
      all_registered_confirmed: 0,
      status: 'open',
      frozen_at: null,
      frozen_by: null,
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

/** A completed `accreditation.evidence` upload, owned by `owner` when given; its id. */
async function seedUpload(s: MatrixSeed, owner: { type: string; id: string } | null = null): Promise<string> {
  const id = newId();
  await s.h.db
    .insertInto('files')
    .values({
      id,
      original_name: 'bukti-matriks.pdf',
      mime: 'application/pdf',
      size: 512,
      sha256: '0'.repeat(64),
      context: 'accreditation.evidence',
      owner_type: owner?.type ?? null,
      owner_id: owner?.id ?? null,
      access: 'staff',
      status: 'ok',
      created_at: s.now,
      created_by: null,
    })
    .execute();
  return id;
}

/** An evidence row of an open period, owning its file; its id. */
async function seedEvidence(s: MatrixSeed): Promise<string> {
  const id = newId();
  const periodId = await seedPeriod(s);
  const fileId = await seedUpload(s, { type: 'accred_evidence', id });
  await s.h.db
    .insertInto('accred_evidence')
    .values({
      id,
      period_id: periodId,
      indicator_code: 'SCH-K1',
      evidence_code: 'catalogue_screenshot',
      entity: null,
      entity_id: null,
      file_id: fileId,
      caption: 'Bukti Matriks',
      sort_order: 0,
      created_at: s.now,
      created_by: null,
    })
    .execute();
  return id;
}

export const MATRIX: AreaMatrix = {
  rows: {
    'accreditation.evidence.list': 'GET /api/v1/accreditation/evidence | P:accreditation.workspace.read | - | - | read | deny | none | null | - | -',
    'accreditation.evidence.create':
      'POST /api/v1/accreditation/evidence | P:accreditation.workspace.manage | - | - | write | deny | store | accreditation.evidence.create | handler | -',
    'accreditation.evidence.archive':
      'DELETE /api/v1/accreditation/evidence/:id | P:accreditation.workspace.manage | - | - | write | deny | store | accreditation.evidence.archive | handler | -',
  },
  fixtures: {
    'accreditation.evidence.list': async (s) => ({ query: { periodId: await seedPeriod(s) } }),
    'accreditation.evidence.create': async (s) => ({
      body: { uploadId: await seedUpload(s), periodId: await seedPeriod(s), indicatorCode: 'SCH-K1', evidenceCode: 'catalogue_screenshot', caption: 'Bukti Matriks' },
    }),
    'accreditation.evidence.archive': async (s) => ({ params: { id: await seedEvidence(s) } }),
  },
  maintenance: {},
  systemRoutes: [],
};
