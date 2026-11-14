import { z } from 'zod';
import { PERIOD_PARAM, reportColumn, reportIdField } from '../../reports/params.js';
import type { ReportCtx, ReportRow, TableReport } from '../../reports/types.js';
import { annexPeriod, budgetRows, budgetShareMean, budgetSharePct, majorUnits, pageFixed, rowLabel } from '../providers/registers-metrics.js';
import { budgetYears } from '../windows.js';

// The budget annex of an accreditation period: the three budget years (the calendar years Y − 2 to Y, Y the year the
// period ends) of the whole library, in that order, each with its amounts in major units and the library's share of
// the parent budget without staff and upkeep cut to a whole percent; a year with no entry is a row without amounts.
// The last row is the budget indicator's value: the exact mean of the three shares, cut once (empty while a year
// lacks the parent budget).

async function budgetAnnexRows(ctx: ReportCtx, cursor: string | null, limit: number): Promise<{ rows: ReportRow[]; nextCursor: string | null }> {
  const { period } = await annexPeriod(ctx);
  const years = budgetYears(period.ends_on);
  const found = await budgetRows(ctx.db, years);
  const rows: ReportRow[] = years.map((year) => {
    const b = found.get(year);
    if (b === undefined) return [String(year), null, null, null, null, null, null];
    return [
      String(year),
      majorUnits(b.library),
      majorUnits(b.parent),
      majorUnits(b.parentNonpersonnel),
      majorUnits(b.collection),
      majorUnits(b.community),
      budgetSharePct(b),
    ];
  });
  rows.push([rowLabel(ctx.locale, 'budget_mean'), null, null, null, null, null, budgetShareMean(years.map((y) => found.get(y)))]);
  const { page, next } = pageFixed(rows, cursor, limit);
  return { rows: page, nextCursor: next };
}

/** The library's and the parent institution's budgets of the budget years, and the library's share. */
export const annexBudgetsReport: TableReport = Object.freeze<TableReport>({
  id: 'accreditation.annex.budgets',
  module: 'accreditation',
  kind: 'table',
  titleKey: 'report.accreditation.annex.budgets.title',
  permission: 'accreditation.workspace.read',
  personal: false,
  formats: ['csv', 'xlsx', 'pdf'],
  orientation: 'landscape',
  params: [PERIOD_PARAM],
  paramsSchema: z.strictObject({ periodId: reportIdField }),
  columns: [
    reportColumn('year', 'text'),
    ...['library', 'parent', 'parent_nonpersonnel', 'collection', 'community'].map((key) => reportColumn(key, 'money')),
    reportColumn('pct', 'percent'),
  ],
  rows: budgetAnnexRows,
});
