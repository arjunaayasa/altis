import fsp from 'node:fs/promises';
import path from 'node:path';
import { reportExportPath } from '@altis/platform';
import { newId } from '@altis/shared';
import type { MatrixFixture, MatrixSeed } from '../matrix-fixtures.js';
import type { AreaMatrix } from './catalog.js';

// The matrix rows, fixtures and `system` route ids of the report catalogue, the preview, the runs and their download:
// one row per route id in the row format of db/matrix.test.ts's CATALOG, one fixture per route in the same order. Every
// route is `deny` in maintenance, so there is no maintenance entry.
//
// Every route takes any signed-in staff member (`pub+s`) and checks the definition's own permission itself (the
// declaration cannot name it), so the matrix shows every session persona `allowed` at the gate; db/api-reports.test.ts
// holds the per-definition rules per persona. The starts and the download are `mode: system` (an export is never
// locked), the preview a read-only POST outside a transaction.
//
// The fixtures use the test profile's definitions (`test.rows`, `test.personal`) and seed what a call needs straight
// into the tables and DATA_DIR, each call its own, so that a super admin's call succeeds (audit once): a finished run of
// the caller with its file for the download.

const DAY = 86_400_000;
const CONTENT = 'n,text,amount\r\n1,baris 1,1500\r\n';

function dataDirOf(s: MatrixSeed): string {
  if (s.dataDir === undefined) throw new Error('the report run fixtures need the DATA_DIR of the app');
  return s.dataDir;
}

/** A finished CSV run of `test.rows` by the caller (by nobody for a sessionless persona); its id. */
async function seedRun(s: MatrixSeed, o: { withFile: boolean }): Promise<string> {
  const id = newId(s.now);
  await s.h.db
    .insertInto('report_runs')
    .values({
      id,
      report_id: 'test.rows',
      format: 'csv',
      locale: 'id',
      params: '{"def":{"rows":1}}',
      personal: 0,
      status: 'succeeded',
      row_count: 1,
      non_latin_rows: 0,
      output_name: `${id}.csv`,
      output_size: Buffer.byteLength(CONTENT),
      error_code: null,
      job_id: null,
      expires_at: s.now + 7 * DAY,
      created_at: s.now,
      created_by: s.user?.id ?? null,
      finished_at: s.now,
    })
    .execute();
  if (o.withFile) {
    const file = reportExportPath(dataDirOf(s), id, 'csv');
    await fsp.mkdir(path.dirname(file), { recursive: true });
    await fsp.writeFile(file, CONTENT);
  }
  return id;
}

const withRunFile: MatrixFixture = async (s) => ({ params: { id: await seedRun(s, { withFile: true }) } });

export const MATRIX: AreaMatrix = {
  rows: {
    'reports.catalog': 'GET /api/v1/reports/catalog | pub+s | - | - | read | deny | none | null | - | -',
    'reports.preview': 'POST /api/v1/reports/:reportId/preview | pub+s | - | - | read | deny | none | null | self | -',
    'reports.runs.create': 'POST /api/v1/reports/runs | pub+s | - | - | system | deny | store | reports.run.start | handler | -',
    'reports.runs.create_personal':
      'POST /api/v1/reports/runs/personal | pub+s | - | reauth | system | deny | store | reports.run.start | handler | -',
    'reports.runs.list': 'GET /api/v1/reports/runs | pub+s | - | - | read | deny | none | null | - | -',
    'reports.runs.get': 'GET /api/v1/reports/runs/:id | pub+s | - | - | read | deny | none | null | - | -',
    'reports.runs.download': 'GET /api/v1/reports/runs/:id/download | pub+s | - | - | system | deny | none | reports.run.download | - | -',
  },
  fixtures: {
    'reports.catalog': async () => ({}),
    'reports.preview': async () => ({ params: { reportId: 'test.rows' }, body: { params: { rows: 3 }, limit: 2 } }),
    'reports.runs.create': async () => ({ body: { reportId: 'test.rows', format: 'csv', params: { rows: 3 } } }),
    'reports.runs.create_personal': async () => ({ body: { reportId: 'test.personal', format: 'csv', params: {} } }),
    'reports.runs.list': async () => ({ query: { limit: '5' } }),
    'reports.runs.get': async (s) => ({ params: { id: await seedRun(s, { withFile: false }) } }),
    'reports.runs.download': withRunFile,
  },
  maintenance: {},
  systemRoutes: ['reports.runs.create', 'reports.runs.create_personal', 'reports.runs.download'],
};
