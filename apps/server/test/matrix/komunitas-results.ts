import { createHash } from 'node:crypto';
import { lastChangeOf, localStorageDriver } from '@altis/core';
import { newId } from '@altis/shared';
import type { MatrixSeed } from '../matrix-fixtures.js';
import type { AreaMatrix } from './catalog.js';

// The matrix rows, fixtures and `system` route ids of a period's results, its evaluation, its freeze and reopening and
// its snapshots: one row per route id in the row format of db/matrix.test.ts's CATALOG, one fixture per route in the
// same order. Every route is `deny` in maintenance, so there is no maintenance entry. Reading and queuing an evaluation
// take `accreditation.workspace.read`, freezing and reopening `accreditation.workspace.manage` (reopening after a fresh
// re-authentication); the download of a snapshot's evidence file is `system`, re-authenticated and audited.
//
// Each call seeds what it needs straight into the tables (and the stored files), so that a super admin's call succeeds
// whatever the personas before it did: an open period of the test profile's school instrument; for a freeze, results
// computed after the period's last change; a frozen period to reopen; a snapshot, with its evidence file copy for the
// download.

const READ = 'P:accreditation.workspace.read';
const MANAGE = 'P:accreditation.workspace.manage';
const PDF = '%PDF-1.4 berkas bukti matriks';
const PREREQUISITES = { titles: { pass: false, count: 0, asOf: '2026-06-30' }, npp: { pass: false }, foundingDecree: { pass: false }, met: false };

/** A period of `test-sch` in `status`, written at the seed's time; its id. */
async function seedPeriod(s: MatrixSeed, status: 'open' | 'frozen' = 'open'): Promise<string> {
  const id = newId(s.now);
  await s.h.db
    .insertInto('accred_periods')
    .values({
      id,
      branch_id: null,
      name: 'Periode Matriks',
      kind: 'school_year',
      starts_on: '2025-07-01',
      ends_on: '2026-06-30',
      instrument_id: 'test-sch',
      status,
      frozen_at: status === 'frozen' ? s.now : null,
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

/** An open period whose results were computed after its last change (whatever the routes before changed); its id. */
async function seedFreshPeriod(s: MatrixSeed): Promise<string> {
  const id = await seedPeriod(s);
  const computedAt = ((await lastChangeOf(s.h.db, id)) ?? s.now) + 1;
  await s.h.db
    .insertInto('accred_results')
    .values({
      period_id: id,
      indicator_code: '_meta',
      payload: JSON.stringify({ status: 'ready', startedAt: computedAt, jobId: newId(computedAt), computedAt, durationMs: 1, prerequisites: PREREQUISITES }),
      computed_at: computedAt,
    })
    .execute();
  return id;
}

/** A snapshot of a new frozen period, with an evidence file copy stored in the app's DATA_DIR when asked; its id. */
async function seedSnapshot(s: MatrixSeed, withDossier: boolean): Promise<string> {
  const periodId = await seedPeriod(s, 'frozen');
  const id = newId(s.now);
  let fileId: string | null = null;
  if (withDossier) {
    if (s.dataDir === undefined) throw new Error('the snapshot download fixture needs the DATA_DIR of the app');
    fileId = newId(s.now);
    const bytes = new TextEncoder().encode(PDF);
    const sha256 = createHash('sha256').update(bytes).digest('hex');
    await localStorageDriver(s.dataDir).put(fileId, bytes, { size: bytes.byteLength, sha256 });
    await s.h.db
      .insertInto('files')
      .values({
        id: fileId,
        original_name: 'berkas-bukti.pdf',
        mime: 'application/pdf',
        size: bytes.byteLength,
        sha256,
        context: 'accreditation.dossier',
        owner_type: 'accred_snapshots',
        owner_id: id,
        access: 'staff',
        status: 'ok',
        created_at: s.now,
        created_by: null,
      })
      .execute();
  }
  await s.h.db
    .insertInto('accred_snapshots')
    .values({
      id,
      period_id: periodId,
      instrument_id: 'test-sch',
      result_values: JSON.stringify({ i: {}, s: {}, p: PREREQUISITES, e: {} }),
      na: null,
      na_low: '25.00',
      na_high: '100.00',
      grade: null,
      prerequisites_met: 0,
      dossier_file_id: fileId,
      note: null,
      created_at: s.now,
      created_by: null,
    })
    .execute();
  return id;
}

export const MATRIX: AreaMatrix = {
  rows: {
    'accreditation.results.get': `GET /api/v1/accreditation/periods/:id/results | ${READ} | - | - | read | deny | none | null | - | -`,
    'accreditation.periods.evaluate': `POST /api/v1/accreditation/periods/:id/evaluate | ${READ} | - | - | read | deny | none | null | handler | -`,
    'accreditation.periods.freeze': `POST /api/v1/accreditation/periods/:id/freeze | ${MANAGE} | - | - | write | deny | store | accreditation.period.freeze | handler | -`,
    'accreditation.periods.unfreeze': `POST /api/v1/accreditation/periods/:id/unfreeze | ${MANAGE} | - | reauth | write | deny | store | accreditation.period.unfreeze | handler | -`,
    'accreditation.snapshots.list': `GET /api/v1/accreditation/periods/:id/snapshots | ${READ} | - | - | read | deny | none | null | - | -`,
    'accreditation.snapshots.get': `GET /api/v1/accreditation/snapshots/:id | ${READ} | - | - | read | deny | none | null | - | -`,
    'accreditation.snapshots.dossier': `GET /api/v1/accreditation/snapshots/:id/dossier | ${READ} | - | reauth | system | deny | none | reports.run.download | - | -`,
  },
  fixtures: {
    'accreditation.results.get': async (s) => ({ params: { id: await seedPeriod(s) } }),
    'accreditation.periods.evaluate': async (s) => ({ params: { id: await seedPeriod(s) } }),
    'accreditation.periods.freeze': async (s) => ({ params: { id: await seedFreshPeriod(s) }, body: { note: null } }),
    'accreditation.periods.unfreeze': async (s) => ({ params: { id: await seedPeriod(s, 'frozen') } }),
    'accreditation.snapshots.list': async (s) => ({ params: { id: await seedPeriod(s) } }),
    'accreditation.snapshots.get': async (s) => ({ params: { id: await seedSnapshot(s, false) } }),
    'accreditation.snapshots.dossier': async (s) => ({ params: { id: await seedSnapshot(s, true) } }),
  },
  maintenance: {},
  systemRoutes: ['accreditation.snapshots.dossier'],
};
