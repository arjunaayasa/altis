import fsp from 'node:fs/promises';
import path from 'node:path';
import { localStorageDriver, writeRunReport } from '@altis/core';
import { exportFilePath } from '@altis/platform';
import { newId } from '@altis/shared';
import type { MatrixFixture, MatrixSeed } from '../matrix-fixtures.js';
import type { AreaMatrix } from './catalog.js';

// The matrix rows, fixtures and maintenance entries of the catalog runs and the dedupe scan (Phase 2 Task 19; the
// plan's route catalog): one row per route id in the row format of db/matrix.test.ts's CATALOG, one fixture per route
// in the same order. Every route is `deny` in maintenance, so there is no maintenance entry. The download audits
// (`catalog.export.download`), which makes it a side-effect GET without a `sideEffects` flag of its own.
//
// The fixtures seed what a call needs straight into the tables and DATA_DIR (a run, its report, an export's file), each
// call its own, so that a super admin's call succeeds (audit once) whatever the personas before it did.
//
// GET of one run and of its report take any signed-in staff member (`pub+s`) and check the permission themselves: a
// catalogue reader, or an accreditation manager for a SLiMS usage import run only (the import wizard reads them). The
// per-persona rules are in db/api-catalog-runs.test.ts and db/api-slims-usage.test.ts.

const DAY = 86_400_000;

/** A finished run of `kind` (an export with its file's name, size and expiry when given); its id. */
async function seedRun(
  s: MatrixSeed,
  o: { kind: 'import' | 'export' | 'dedupe_scan'; format?: string | null; outputSize?: number; reportFileId?: string | null },
): Promise<string> {
  const id = newId(s.now);
  await s.h.db
    .insertInto('catalog_runs')
    .values({
      id,
      kind: o.kind,
      status: 'succeeded',
      dry_run: 0,
      format: o.format ?? null,
      options: '{}',
      summary: '{}',
      report_file_id: o.reportFileId ?? null,
      output_name: o.outputSize === undefined ? null : `${id}.csv`,
      output_size: o.outputSize ?? null,
      expires_at: o.outputSize === undefined ? null : s.now + 7 * DAY,
      job_id: null,
      created_at: s.now,
      created_by: null,
      finished_at: s.now,
    })
    .execute();
  return id;
}

function dataDirOf(s: MatrixSeed): string {
  if (s.dataDir === undefined) throw new Error('the catalog runs fixtures need the DATA_DIR of the app');
  return s.dataDir;
}

/** A dedupe scan run with its stored report CSV. */
const withReport: MatrixFixture = async (s) => {
  const id = await seedRun(s, { kind: 'dedupe_scan' });
  const fileId = await writeRunReport(s.h, localStorageDriver(dataDirOf(s)), id, ['group', 'reason'], [['1', 'isbn']], { now: s.now, createdBy: null });
  await s.h.db.updateTable('catalog_runs').set({ report_file_id: fileId }).where('id', '=', id).execute();
  return { params: { id } };
};

/** A `csv-records` export with its file, expiring 7 days after now. */
const withExportFile: MatrixFixture = async (s) => {
  const content = 'judul,tahun\r\nMatriks,2026\r\n';
  const id = await seedRun(s, { kind: 'export', format: 'csv-records', outputSize: Buffer.byteLength(content) });
  const file = exportFilePath(dataDirOf(s), id, 'csv');
  await fsp.mkdir(path.dirname(file), { recursive: true });
  await fsp.writeFile(file, content);
  return { params: { id } };
};

export const MATRIX: AreaMatrix = {
  rows: {
    'catalog.runs.list': 'GET /api/v1/catalog/runs | P:catalog.records.read | - | - | read | deny | none | null | - | -',
    'catalog.runs.get': 'GET /api/v1/catalog/runs/:id | pub+s | - | - | read | deny | none | null | - | -',
    'catalog.runs.report': 'GET /api/v1/catalog/runs/:id/report | pub+s | - | - | system | deny | none | null | - | -',
    'catalog.runs.download':
      'GET /api/v1/catalog/runs/:id/download | P:catalog.export.run | - | - | system | deny | none | catalog.export.download | - | -',
    'catalog.dedupe_scans.create':
      'POST /api/v1/catalog/dedupe-scans | P:catalog.records.manage | - | - | write | deny | store | null | handler | -',
  },
  fixtures: {
    'catalog.runs.list': async () => ({ query: { limit: '5', kind: 'import' } }),
    'catalog.runs.get': async (s) => ({ params: { id: await seedRun(s, { kind: 'import', format: 'marc21' }) } }),
    'catalog.runs.report': withReport,
    'catalog.runs.download': withExportFile,
    'catalog.dedupe_scans.create': async () => ({ body: {} }),
  },
  maintenance: {},
};
