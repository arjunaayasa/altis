import { t, type MessageKey } from '@altis/shared';
import { z } from 'zod';
import { PERIOD_PARAM, reportColumn, reportIdField } from '../../reports/params.js';
import type { ReportRow, TableReport } from '../../reports/types.js';
import { matrixTable } from '../providers/collection-metrics.js';
import { annexPass } from '../providers/collection-scan.js';

// The annex of the collection by medium and kind (spec §10.8, the collection figures of the library profile): the
// titles in stock at the period's snapshot date and their copies in stock, printed and electronic (by the electronic
// material types of the settings), each as fiction, non-fiction and reference. A title is reference when a copy of it
// is, else fiction by the fiction rule, else non-fiction; a copy is reference by its own collection type, else it
// follows its title's fiction. The totals row last. The figures are the period's `collection.profile_matrix`. The annex
// reads the whole stock: while its pass runs it answers no rows and a cursor holding the counts so far.

const PARTS = new Set(['matrix'] as const);

/** Titles and copies by medium (print, electronic) and kind (fiction, non-fiction, reference). */
export const annexCollectionMatrixReport: TableReport = Object.freeze<TableReport>({
  id: 'accreditation.annex.collection_matrix',
  module: 'accreditation',
  kind: 'table',
  titleKey: 'report.accreditation.annex.collection_matrix.title',
  permission: 'accreditation.workspace.read',
  personal: false,
  formats: ['csv', 'xlsx', 'pdf'],
  orientation: 'portrait',
  params: [PERIOD_PARAM],
  paramsSchema: z.strictObject({ periodId: reportIdField }),
  columns: [
    ...['medium', 'kind'].map((key) => reportColumn(key, 'text')),
    ...['titles', 'items'].map((key) => reportColumn(key, 'int')),
  ],
  scanBased: () => true,
  rows: async (ctx, cursor) => {
    const pass = await annexPass(ctx, cursor, PARTS);
    if (!pass.done) return { rows: [], nextCursor: pass.cursor };
    const c = pass.counts.counters;
    const group = (key: string): string => t(ctx.locale, `report.group.${key}` as MessageKey);
    const rows: ReportRow[] = matrixTable(c).map(([medium, kind, titles, items]) => [group(`medium.${medium}`), group(`fnr.${kind}`), titles, items]);
    rows.push([t(ctx.locale, 'report.row.total'), null, c.titles, c.liveItems]);
    return { rows, nextCursor: null };
  },
});
