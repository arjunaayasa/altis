import { ddcRowKind, t, type MessageKey } from '@altis/shared';
import { z } from 'zod';
import { PERIOD_PARAM, reportColumn, reportIdField } from '../../reports/params.js';
import type { ReportCtx, ReportRow, TableReport } from '../../reports/types.js';
import { ddcTable, ddcTotals } from '../providers/collection-metrics.js';
import { annexPass } from '../providers/collection-scan.js';

// The annex of the printed collection by DDC class (spec §10.8, the supporting evidence of the titles item): the
// printed titles in stock at the period's snapshot date (electronic material types left out) and their copies in
// stock, per main class (all ten, the Islamic expansion `2X` and the other numbers `NON`), each followed by the
// divisions that hold a title, and the totals row last. The figures are the period's `collection.ddc_printed_recap`.
// The annex reads the whole stock: while its pass runs it answers no rows and a cursor holding the counts so far.

const PARTS = new Set(['ddc'] as const);

/** The class and label cells of a row key: a main class by its name, a division by its numbers. */
function rowHead(ctx: ReportCtx, key: string): [string, string] {
  if (ddcRowKind(key) === 'division') {
    const from = key.slice(0, 3);
    return [key, `${from}–${from.slice(0, 2)}9`];
  }
  return [key, t(ctx.locale, `vocab.ddc_main.${key}` as MessageKey)];
}

/** Printed titles and copies per DDC class (with divisions), `2X` and the other classes, at the period's snapshot date. */
export const annexDdcReport: TableReport = Object.freeze<TableReport>({
  id: 'accreditation.annex.ddc',
  module: 'accreditation',
  kind: 'table',
  titleKey: 'report.accreditation.annex.ddc.title',
  permission: 'accreditation.workspace.read',
  personal: false,
  formats: ['csv', 'xlsx', 'pdf'],
  orientation: 'portrait',
  params: [PERIOD_PARAM],
  paramsSchema: z.strictObject({ periodId: reportIdField }),
  columns: [
    ...['class', 'label'].map((key) => reportColumn(key, 'text')),
    ...['titles', 'items'].map((key) => reportColumn(key, 'int')),
  ],
  scanBased: () => true,
  rows: async (ctx, cursor) => {
    const pass = await annexPass(ctx, cursor, PARTS);
    if (!pass.done) return { rows: [], nextCursor: pass.cursor };
    const c = pass.counts.counters;
    const rows: ReportRow[] = ddcTable(c).map(([key, titles, items]) => [...rowHead(ctx, key), titles, items]);
    rows.push([null, t(ctx.locale, 'report.row.total'), ...ddcTotals(c)]);
    return { rows, nextCursor: null };
  },
});
