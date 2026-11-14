import { z } from 'zod';
import { offsetPage } from '../../reports/collection/common.js';
import { PERIOD_PARAM, reportColumn, reportIdField } from '../../reports/params.js';
import type { ReportCtx, ReportRow, TableReport } from '../../reports/types.js';
import { annexMonthCount, annexUsage, sourceText, sourceWords, totalLabel } from '../usage/annex.js';
import type { ResolvedCell } from '../usage/index.js';
import { addCell, schoolMonths, usageMonth } from '../usage/series.js';
import type { UsageTable } from '../usage/resolve.js';

// The annex of the monthly usage (spec §10.7, §10.9): a row per month of the period with the visits counted of every
// group (the guests apart), the loans, the uses in the library and the source of the figures; the totals row sums the
// months up to the snapshot date and prints the divisor of the monthly averages (school months in a school, the months
// with data elsewhere).

/** The printed cells of a month, in the order of the columns after `month`. */
function cellsOf(table: UsageTable, month: string): ResolvedCell[] {
  const u = usageMonth(table, month);
  return [u.visits.student, u.visits.teacher, u.visits.edu_staff, u.visits.public, u.visits.other, u.visits.guest, u.loans, u.uses];
}

async function monthRows(ctx: ReportCtx): Promise<ReportRow[]> {
  const a = await annexUsage(ctx);
  return a.months.map((m) => {
    const cells = cellsOf(a.table, m);
    return [m, ...cells.map((c) => c.value), sourceText(ctx, cells)];
  });
}

/** Per month: visits by group, loans and in-library uses, with the source of the figures. */
export const annexUsageMonthlyReport: TableReport = Object.freeze<TableReport>({
  id: 'accreditation.annex.usage_monthly',
  module: 'accreditation',
  kind: 'table',
  titleKey: 'report.accreditation.annex.usage_monthly.title',
  permission: 'accreditation.workspace.read',
  personal: false,
  formats: ['csv', 'xlsx', 'pdf'],
  orientation: 'landscape',
  params: [PERIOD_PARAM],
  paramsSchema: z.strictObject({ periodId: reportIdField }),
  columns: [
    reportColumn('month', 'text'),
    ...['visits_student', 'visits_teacher', 'visits_edu_staff', 'visits_public', 'visits_other', 'visits_guest', 'loans', 'in_library_uses'].map((key) => reportColumn(key, 'int')),
    reportColumn('source', 'text'),
  ],
  rows: async (ctx, cursor, limit) => offsetPage(await monthRows(ctx), cursor, limit),
  count: annexMonthCount,
  totals: async (ctx) => {
    const a = await annexUsage(ctx);
    const perMonth = a.counted.map((m) => cellsOf(a.table, m));
    const sums = perMonth.reduce<(number | null)[]>((acc, cells) => acc.map((sum, i) => addCell(sum, cells[i]!)), Array<number | null>(8).fill(null));
    const withData = a.table.monthsWithDataIn('visits', a.counted);
    const divisor = a.school ? schoolMonths(withData) : withData > 0 ? withData : null;
    return [totalLabel(ctx, { withData, divisor, school: a.school }), ...sums, sourceWords(ctx, perMonth.flat())];
  },
});
