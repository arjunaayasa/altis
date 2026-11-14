import { appendLine, reportWorkPath } from '@altis/platform';
import { z } from 'zod';
import { reportColumn, reportParam } from './params.js';
import type { DocumentReport, ReportDefinition, ReportRow, TableReport } from './types.js';

// The definitions of the test build profile (never in a production build: TEST_REPORTS builds them only under
// `__BUILD_PROFILE__ === 'test'`, the condition inline so a production build drops them, and the registry spreads them
// under the same condition). They give the report framework rows and documents of a known shape without a stock: the
// export job, the run routes and the screens are tested against them.

/** The most rows `test.rows` makes. */
const TEST_ROWS_MAX = 200_000;

/**
 * `test.rows`: `rows` rows; row n (from 1) is `[n, texts[(n - 1) mod texts.length] ?? 'baris ' + n, n × 1 500]`. Its
 * count is `rows`, or unknown with `countless` (so a run's size check waits for the rows). Never scan-based.
 */
function testRowsReport(): TableReport {
  return Object.freeze<TableReport>({
    id: 'test.rows',
    module: 'collection',
    kind: 'table',
    titleKey: 'report.test.rows.title',
    permission: 'reports.statistics.read',
    personal: false,
    formats: ['csv', 'xlsx', 'pdf'],
    orientation: 'portrait',
    params: [
      reportParam('rows', 'int', { required: true, min: 0, max: TEST_ROWS_MAX }),
      reportParam('texts', 'text', { multiple: true }),
      reportParam('countless', 'bool'),
    ],
    paramsSchema: z.strictObject({
      rows: z.int().min(0).max(TEST_ROWS_MAX),
      texts: z.array(z.string().max(200)).max(20).optional(),
      countless: z.boolean().optional(),
    }),
    columns: [reportColumn('n', 'int'), reportColumn('text', 'text'), reportColumn('amount', 'money')],
    async rows(ctx, cursor, limit) {
      const total = ctx.params['rows'] as number;
      const texts = (ctx.params['texts'] as string[] | undefined) ?? [];
      const after = cursor === null ? 0 : Number(cursor);
      const last = Math.min(total, after + limit);
      const rows: ReportRow[] = [];
      for (let n = after + 1; n <= last; n += 1) rows.push([n, texts[(n - 1) % texts.length] ?? `baris ${n}`, n * 1500]);
      return { rows, nextCursor: last < total ? String(last) : null };
    },
    count: async (ctx) => (ctx.params['countless'] === true ? null : (ctx.params['rows'] as number)),
  });
}

/** `test.personal`: three rows of one column sourced from a personal column, so the report is personal. */
function testPersonalReport(): TableReport {
  return Object.freeze<TableReport>({
    id: 'test.personal',
    module: 'collection',
    kind: 'table',
    titleKey: 'report.test.personal.title',
    permission: 'reports.statistics.read',
    personal: true,
    formats: ['csv', 'xlsx', 'pdf'],
    orientation: 'portrait',
    params: [],
    paramsSchema: z.strictObject({}),
    columns: [reportColumn('name', 'text', { source: { table: 'library_staff', column: 'name' } })],
    async rows(_ctx, cursor, limit) {
      const after = cursor === null ? 0 : Number(cursor);
      const last = Math.min(3, after + limit);
      const rows: ReportRow[] = [];
      for (let n = after + 1; n <= last; n += 1) rows.push([`Nama ${n}`]);
      return { rows, nextCursor: last < 3 ? String(last) : null };
    },
  });
}

/**
 * `test.document`: three slices. Slice n appends the line `test-document:<n>` to the run's `output.part`; slices 1 and 2
 * answer where to go on (`slice-<n + 1>`), slice 3 ends with 3 rows and the warning `test_warning`.
 */
function testDocumentReport(): DocumentReport {
  return Object.freeze<DocumentReport>({
    id: 'test.document',
    module: 'collection',
    kind: 'document',
    titleKey: 'report.test.document.title',
    permission: 'reports.statistics.read',
    personal: false,
    formats: ['pdf', 'zip'],
    orientation: 'portrait',
    params: [],
    paramsSchema: z.strictObject({}),
    async render(ctx, resume) {
      const n = resume === null ? 1 : Number(/^slice-(\d+)$/.exec(resume.phase)?.[1] ?? 1);
      await appendLine(reportWorkPath(ctx.dataDir, ctx.runId, 'output.part'), `test-document:${n}`);
      if (n < 3) return { done: false, resume: { phase: `slice-${n + 1}`, cursor: null, state: null } };
      return { done: true, rowCount: 3, nonLatinRows: 0, warnings: ['test_warning'] };
    },
  });
}

/** The test profile's definitions, in the order the registry appends them: `test.rows`, `test.personal`, `test.document`. */
export const TEST_REPORTS: readonly ReportDefinition[] = Object.freeze(
  typeof __BUILD_PROFILE__ !== 'undefined' && __BUILD_PROFILE__ === 'test' ? [testRowsReport(), testPersonalReport(), testDocumentReport()] : [],
);
