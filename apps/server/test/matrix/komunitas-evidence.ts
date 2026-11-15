import { newId } from '@altis/shared';
import type { MatrixSeed } from '../matrix-fixtures.js';
import type { AreaMatrix } from './catalog.js';
import { seedBranch } from './komunitas-circulation.js';

// The matrix rows, fixtures, maintenance entries and `system` route ids of the evidence files: one row per route id in
// the row format of db/matrix.test.ts's CATALOG, one fixture per route in the same order. Every route is `deny` in
// maintenance and none is a `system` route, so there is no maintenance entry and no system route id.
//
// Each call gets its own open period of the test instrument `test-sch` and its own completed `accreditation.evidence`
// upload (a `files` row as completion leaves it; no route here reads the blob), so that a super admin's call succeeds
// (one audit entry) whatever the personas before it did. The minutes link gets a finished stocktake session of a branch
// of its own with its stored minutes, and a period of an instrument whose indicator takes them.

/** An open period of `test-sch` (or `instrumentId`); its id. */
async function seedPeriod(s: MatrixSeed, instrumentId = 'test-sch'): Promise<string> {
  const id = newId();
  await s.h.db
    .insertInto('accred_periods')
    .values({
      id,
      name: 'Periode Matriks',
      instrument_id: instrumentId,
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

// ---- the stocktake minutes as evidence ----
/** A finished stocktake session of a branch of its own, with its minutes stored (the row only); its id. */
async function seedMinutesSession(s: MatrixSeed): Promise<string> {
  const branchId = await seedBranch(s);
  const id = newId();
  const fileId = newId();
  await s.h.db
    .insertInto('files')
    .values({
      id: fileId,
      original_name: 'berita-acara-inventarisasi.pdf',
      mime: 'application/pdf',
      size: 512,
      sha256: '0'.repeat(64),
      context: 'stocktake.minutes',
      owner_type: 'stocktakes',
      owner_id: id,
      access: 'staff',
      status: 'ok',
      created_at: s.now,
      created_by: null,
    })
    .execute();
  await s.h.db
    .insertInto('stocktakes')
    .values({
      id,
      branch_id: branchId,
      name: 'Sesi Matriks',
      scope: '{}',
      status: 'finished',
      active_key: null,
      options: null,
      started_at: s.now,
      started_by: null,
      finished_at: s.now,
      finished_by: null,
      minutes_file_id: fileId,
      report_file_id: null,
      source: 'altis',
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
    'accreditation.evidence.list': 'GET /api/v1/accreditation/evidence | P:accreditation.workspace.read | - | - | read | deny | none | null | - | -',
    'accreditation.evidence.create':
      'POST /api/v1/accreditation/evidence | P:accreditation.workspace.manage | - | - | write | deny | store | accreditation.evidence.create | handler | -',
    'accreditation.evidence.archive':
      'DELETE /api/v1/accreditation/evidence/:id | P:accreditation.workspace.manage | - | - | write | deny | store | accreditation.evidence.archive | handler | -',
    // ---- the stocktake minutes as evidence ----
    'accreditation.evidence.minutes_list':
      'GET /api/v1/accreditation/evidence/stocktake-minutes | P:accreditation.workspace.manage | - | - | read | deny | none | null | - | -',
    'accreditation.evidence.minutes_attach':
      'POST /api/v1/accreditation/evidence/stocktake-minutes | P:accreditation.workspace.manage | - | - | write | deny | store | accreditation.evidence.create | handler | -',
  },
  fixtures: {
    'accreditation.evidence.list': async (s) => ({ query: { periodId: await seedPeriod(s) } }),
    'accreditation.evidence.create': async (s) => ({
      body: { uploadId: await seedUpload(s), periodId: await seedPeriod(s), indicatorCode: 'SCH-K1', evidenceCode: 'catalogue_screenshot', caption: 'Bukti Matriks' },
    }),
    'accreditation.evidence.archive': async (s) => ({ params: { id: await seedEvidence(s) } }),
    // ---- the stocktake minutes as evidence ----
    'accreditation.evidence.minutes_list': async () => ({}),
    'accreditation.evidence.minutes_attach': async (s) => ({
      body: { stocktakeId: await seedMinutesSession(s), periodId: await seedPeriod(s, 'sch-sma-2025'), indicatorCode: 'SCH-K7' },
    }),
  },
  maintenance: {},
  systemRoutes: [],
};
