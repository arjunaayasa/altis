import { z } from 'zod';
import { offsetPage } from '../../reports/collection/common.js';
import { PERIOD_PARAM, reportColumn, reportIdField } from '../../reports/params.js';
import type { ReportCtx, ReportRow, TableReport } from '../../reports/types.js';
import { annexMonthCount, annexUsage, sourceText, sourceWords, totalLabel } from '../usage/annex.js';
import { addCell, floorPct, SCHOOL_GROUPS, schoolVisits } from '../usage/series.js';

// The annex of the school community's visits (spec §10.5, §10.9): a row per month of the period with the visits
// counted of students, teachers and education staff, their sum, the school population, the share of that month (its
// visits × 100 ÷ population, cut) and the source of the figures; the totals row sums the months up to the snapshot
// date and prints the school-month divisor and the share the indicator reads (visits × 100 ÷ (divisor × population)).

async function monthRows(ctx: ReportCtx): Promise<ReportRow[]> {
  const a = await annexUsage(ctx);
  return a.months.map((m) => {
    const cells = SCHOOL_GROUPS.map((g) => a.table.cell('visits', m, g));
    const sum = cells.reduce(addCell, null);
    const pct = sum !== null && a.population !== null && a.population > 0 ? floorPct(sum, a.population) : null;
    return [m, cells[0]!.value, cells[1]!.value, cells[2]!.value, sum, a.population, pct, sourceText(ctx, cells)];
  });
}

/** Per month: the school community's visits by group, the population, the share and the source of the figures. */
export const annexL14Report: TableReport = Object.freeze<TableReport>({
  id: 'accreditation.annex.l14',
  module: 'accreditation',
  kind: 'table',
  titleKey: 'report.accreditation.annex.l14.title',
  permission: 'accreditation.workspace.read',
  personal: false,
  formats: ['csv', 'xlsx', 'pdf'],
  orientation: 'landscape',
  params: [PERIOD_PARAM],
  paramsSchema: z.strictObject({ periodId: reportIdField }),
  columns: [
    reportColumn('month', 'text'),
    ...['student', 'teacher', 'edu_staff', 'school_visits', 'population'].map((key) => reportColumn(key, 'int')),
    reportColumn('pct', 'percent'),
    reportColumn('source', 'text'),
  ],
  rows: async (ctx, cursor, limit) => offsetPage(await monthRows(ctx), cursor, limit),
  count: annexMonthCount,
  totals: async (ctx) => {
    const a = await annexUsage(ctx);
    const v = schoolVisits(a.table, a.counted, a.population);
    const cells = a.counted.flatMap((m) => SCHOOL_GROUPS.map((g) => a.table.cell('visits', m, g)));
    const any = SCHOOL_GROUPS.some((g) => v.byGroup[g] !== null);
    return [
      totalLabel(ctx, { withData: v.withData, divisor: v.divisor, school: true }),
      v.byGroup.student,
      v.byGroup.teacher,
      v.byGroup.edu_staff,
      any ? v.visits : null,
      a.population,
      v.value,
      sourceWords(ctx, cells),
    ];
  },
});
