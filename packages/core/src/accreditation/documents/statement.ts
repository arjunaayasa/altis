import { reportWorkPath, writeBytesAtomic } from '@altis/platform';
import { REPORT_PDF_MAX_ROWS } from '@altis/shared/api/reports';
import { z } from 'zod';
import { PERIOD_PARAM, reportIdField } from '../../reports/params.js';
import type { DocumentCtx, DocumentReport, DocumentResume, DocumentStep } from '../../reports/types.js';
import { COLLECT_START, collectRows, columnsOf, documentLayout, documentResults, loadDocPeriod, PDF_MIN_MS, printReportTable, readCollected, stateOf, tableReport } from './data.js';
import { writeStatement } from './sections/statement.js';
import { HEADINGS, titleListTooLong } from './texts.js';

// The statement that the library holds at least 1 000 titles (spec §10.9 item 3, also printed alone): the count and
// its date as the evaluation found them (the registration prerequisites), a signature block with the role, the place
// and the date and an empty line for the name (it names no one, so it is not personal), then the list of titles in
// stock on that date (`collection.title_list`). A list longer than a PDF holds (10 000 rows) is replaced by a line
// that refers to the list's own export. Always in Indonesian.
//
// Two phases: the titles are gathered into the run's `rows.ndjson` (across slices when the list reads the stock of an
// earlier day), then the PDF is laid out in one slice.

const TITLE_LIST = 'collection.title_list';

const count = z.number().int().min(0).max(Number.MAX_SAFE_INTEGER);
const listState = z.strictObject({ bytes: count, rows: count });

async function renderStatement(ctx: DocumentCtx, resume: DocumentResume | null): Promise<DocumentStep> {
  const p = await loadDocPeriod(ctx);
  const results = await documentResults(ctx, p);
  const asOf = results.prerequisites?.titles.asOf ?? p.D;
  const rowsFile = reportWorkPath(ctx.dataDir, ctx.runId, 'rows.ndjson');
  const def = tableReport(TITLE_LIST);
  const params = { asOf };

  let state = resume === null ? { ...COLLECT_START } : { ...stateOf(listState, resume), cursor: resume.cursor };
  if (resume === null || resume.phase === 'titles') {
    const r = await collectRows(ctx, def, params, rowsFile, state, { tag: 0, max: REPORT_PDF_MAX_ROWS });
    if (!r.done) return { done: false, resume: { phase: 'titles', cursor: r.state.cursor, state: { bytes: r.state.bytes, rows: r.state.rows } } };
    state = r.state;
    if (ctx.budgetLeftMs() < PDF_MIN_MS) return { done: false, resume: { phase: 'pdf', cursor: null, state: { bytes: state.bytes, rows: state.rows } } };
  }

  const layout = documentLayout(ctx, p, { title: HEADINGS.statement });
  writeStatement(layout, ctx, p, results.prerequisites, { names: false });
  layout.pageBreak();
  layout.heading(HEADINGS.titleList, 1);
  let printed = 0;
  if (state.rows > REPORT_PDF_MAX_ROWS) {
    layout.paragraph(titleListTooLong(state.rows, REPORT_PDF_MAX_ROWS), { bold: true });
  } else {
    const rows = (await readCollected(rowsFile, state.bytes)).get(0) ?? [];
    printReportTable(layout, columnsOf(def, def.paramsSchema.parse(params)), rows);
    printed = rows.length;
  }
  const bytes = layout.toBytes();
  await writeBytesAtomic(reportWorkPath(ctx.dataDir, ctx.runId, 'output.part'), bytes);
  return { done: true, rowCount: printed, nonLatinRows: layout.nonLatinRows, warnings: [] };
}

/** The statement that the collection holds at least 1 000 titles, with the list of titles. It names no one. */
export const statement1000Report: DocumentReport = Object.freeze<DocumentReport>({
  id: 'accreditation.statement_1000',
  module: 'accreditation',
  kind: 'document',
  titleKey: 'report.accreditation.statement_1000.title',
  permission: 'accreditation.workspace.read',
  personal: false,
  formats: ['pdf'],
  orientation: 'portrait',
  params: [PERIOD_PARAM],
  paramsSchema: z.strictObject({ periodId: reportIdField }),
  render: renderStatement,
});
