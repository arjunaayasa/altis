import { t } from '@altis/shared';
import { z } from 'zod';
import { PERIOD_PARAM, reportColumn, reportIdField } from '../../reports/params.js';
import type { ReportRow, TableReport } from '../../reports/types.js';
import { additionsShare, additionsTable } from '../providers/collection-metrics.js';
import { annexPass } from '../providers/collection-scan.js';

// The annex of the additions of the three calendar years ending in the year the period ends (spec §10.5, §10.8, the
// table of the additions item): the titles in stock on the last day before the three years, the titles first acquired
// in each year (a copy without an acquisition date or on order is never an addition), and their total with its share
// of the starting collection (cut to a whole number; none without a starting collection). The figures are the period's
// `collection.title_additions_3y_pct` and its table. The annex reads the whole stock: while its pass runs it answers no
// rows and a cursor holding the counts so far.

const PARTS = new Set(['threeYears'] as const);

/** The starting collection, the titles added per year of the three-year window, and their share. */
export const annexAdditionsReport: TableReport = Object.freeze<TableReport>({
  id: 'accreditation.annex.additions',
  module: 'accreditation',
  kind: 'table',
  titleKey: 'report.accreditation.annex.additions.title',
  permission: 'accreditation.workspace.read',
  personal: false,
  formats: ['csv', 'xlsx', 'pdf'],
  orientation: 'portrait',
  params: [PERIOD_PARAM],
  paramsSchema: z.strictObject({ periodId: reportIdField }),
  columns: [
    reportColumn('label', 'text'),
    reportColumn('titles', 'int'),
    reportColumn('pct', 'percent'),
  ],
  scanBased: () => true,
  rows: async (ctx, cursor) => {
    const pass = await annexPass(ctx, cursor, PARTS);
    if (!pass.done) return { rows: [], nextCursor: pass.cursor };
    const { counters: c, days } = pass.counts;
    const [start, ...years] = additionsTable(c, days);
    const rows: ReportRow[] = [[t(ctx.locale, 'report.row.accred_collection.start', { date: days.windowBefore }), start![1], null]];
    for (const [year, added] of years) rows.push([t(ctx.locale, 'report.row.accred_collection.year', { year }), added, null]);
    const share = additionsShare(c);
    rows.push([t(ctx.locale, 'report.row.accred_collection.total'), share.added, share.value]);
    return { rows, nextCursor: null };
  },
});
