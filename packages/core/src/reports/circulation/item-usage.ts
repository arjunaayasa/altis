import { countGrouped, datePrefix } from '@altis/db';
import { normalizeKey } from '@altis/shared';
import { sql, type SqlBool } from 'kysely';
import { z } from 'zod';
import { anyOf, offsetPage, textParam } from '../collection/common.js';
import { reportColumn, reportIdField, reportParam, reportYearField } from '../params.js';
import type { ReportCtx, ReportRow, TableReport } from '../types.js';
import { MONTH_COLUMNS, MONTH_KEYS, escapeLike, intParam, monthIndexOf, sumOf, titleMatchSql, yearParam } from './common.js';

// The use of each copy over one year (January to December): how many loans began in each month, from one grouped
// query over the year's loans (a voided loan not counted), with the copy's barcode and title read in the same query.
// Filtered by branch (of the loan), by a word of the title or the start of the barcode, and by a least number of
// loans in the year. Ordered by barcode.

/** The rows of the year, whole (offset paged). */
async function usageRows(ctx: ReportCtx): Promise<ReportRow[]> {
  const year = yearParam(ctx);
  let q = ctx.db
    .selectFrom('loans as l')
    .innerJoin('items as i', 'i.id', 'l.item_id')
    .leftJoin('records as r', 'r.id', 'i.record_id')
    .where('l.loaned_on', '>=', `${year}-01-01`)
    .where('l.loaned_on', '<=', `${year}-12-31`)
    .where(sql<SqlBool>`(l.outcome is null or l.outcome <> 'voided')`);
  const branchId = textParam(ctx, 'branchId');
  if (branchId !== null) q = q.where('l.branch_id', '=', branchId);
  const search = textParam(ctx, 'search');
  if (search !== null) {
    const parts = [sql<SqlBool>`i.barcode_key like ${`${escapeLike(normalizeKey(search))}%`} escape '!'`];
    const title = titleMatchSql(search);
    if (title !== null) parts.push(title);
    q = q.where(anyOf(parts));
  }
  const groups = await countGrouped(q, { i: 'l.item_id', b: 'i.barcode_display', t: 'r.title', m: datePrefix('l.loaned_on', 'month') });
  const byItem = new Map<string, { barcode: string; title: string | null; months: number[] }>();
  for (const g of groups) {
    const id = String(g.i);
    let entry = byItem.get(id);
    if (entry === undefined) {
      entry = { barcode: String(g.b), title: g.t === null ? null : String(g.t), months: MONTH_KEYS.map(() => 0) };
      byItem.set(id, entry);
    }
    const k = monthIndexOf(g.m);
    if (k !== null) entry.months[k] = (entry.months[k] ?? 0) + g.count;
  }
  const least = intParam(ctx, 'minLoans', 1);
  return [...byItem.entries()]
    .filter(([, e]) => sumOf(e.months) >= least)
    .sort(([ida, a], [idb, b]) => a.barcode.localeCompare(b.barcode) || ida.localeCompare(idb))
    .map(([, e]) => [e.barcode, e.title, ...e.months, sumOf(e.months)]);
}

/** Loans per copy and month of one year (see the top of this file). */
export const circulationItemUsageReport: TableReport = Object.freeze<TableReport>({
  id: 'circulation.item_usage',
  module: 'circulation',
  kind: 'table',
  titleKey: 'report.circulation.item_usage.title',
  permission: 'reports.statistics.read',
  personal: false,
  formats: ['csv', 'xlsx', 'pdf'],
  orientation: 'landscape',
  params: [
    reportParam('year', 'year', { min: 1900, max: 2100 }),
    reportParam('branchId', 'branch'),
    reportParam('search', 'text'),
    reportParam('minLoans', 'int', { min: 1, max: 10_000 }),
  ],
  paramsSchema: z.strictObject({
    year: reportYearField.optional(),
    branchId: reportIdField.optional(),
    search: z.string().trim().min(1).max(200).optional(),
    minLoans: z.int().min(1).max(10_000).optional(),
  }),
  columns: [reportColumn('barcode', 'text', { widthChars: 16 }), reportColumn('title', 'text', { widthChars: 30 }), ...MONTH_COLUMNS],
  async rows(ctx, cursor, limit) {
    return offsetPage(await usageRows(ctx), cursor, limit);
  },
  async count(ctx) {
    return (await usageRows(ctx)).length;
  },
});
