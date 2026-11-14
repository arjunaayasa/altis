import { countGrouped } from '@altis/db';
import { sql, type SqlBool } from 'kysely';
import { z } from 'zod';
import { classPrefixSql, offsetPage, textParam } from '../collection/common.js';
import { reportClassPrefixField, reportColumn, reportDateRangeField, reportIdField, reportParam } from '../params.js';
import type { ReportCtx, ReportRow, TableReport } from '../types.js';
import { closedRange, typeName } from './common.js';

// The most borrowed titles and the members who borrowed most, over a date range (by default the 365 days up to
// today): the loans lent in the range (a voided loan not counted), the first 10 or 50, ties by title or number. The
// titles list holds no borrower; the borrowers list is personal (number, name, type and class of each member). A loan
// whose borrower was anonymised counts for its title and for no member.

/** How many of the first a list shows. */
export const TOP_SIZES = Object.freeze(['10', '50'] as const);

const topOf = (ctx: ReportCtx): number => (ctx.params['top'] === '50' ? 50 : 10);

const TOP_PARAM = reportParam('top', 'status', { options: TOP_SIZES });

/** The most borrowed titles. */
async function titleRows(ctx: ReportCtx): Promise<ReportRow[]> {
  const range = closedRange(ctx, 'range', 365);
  let q = ctx.db
    .selectFrom('loans as l')
    .innerJoin('records as r', 'r.id', 'l.record_id')
    .where('l.loaned_on', '>=', range.from)
    .where('l.loaned_on', '<=', range.to)
    .where(sql<SqlBool>`(l.outcome is null or l.outcome <> 'voided')`);
  const branchId = textParam(ctx, 'branchId');
  if (branchId !== null) q = q.where('l.branch_id', '=', branchId);
  const prefix = textParam(ctx, 'classPrefix');
  if (prefix !== null) q = q.where(classPrefixSql('r', prefix));
  const groups = await countGrouped(q, { id: 'r.id', t: 'r.title', c: 'r.call_number' });
  const top = [...groups]
    .sort((a, b) => b.count - a.count || String(a.t).localeCompare(String(b.t)) || String(a.id).localeCompare(String(b.id)))
    .slice(0, topOf(ctx));
  return top.map((g, k) => [k + 1, String(g.t), g.c === null ? null : String(g.c), g.count]);
}

/** The members who borrowed most. */
async function borrowerRows(ctx: ReportCtx): Promise<ReportRow[]> {
  const range = closedRange(ctx, 'range', 365);
  let q = ctx.db
    .selectFrom('loans as l')
    .innerJoin('members as m', 'm.id', 'l.member_id')
    .where('l.loaned_on', '>=', range.from)
    .where('l.loaned_on', '<=', range.to)
    .where(sql<SqlBool>`(l.outcome is null or l.outcome <> 'voided')`);
  const memberTypeId = textParam(ctx, 'memberTypeId');
  if (memberTypeId !== null) q = q.where('m.member_type_id', '=', memberTypeId);
  const className = textParam(ctx, 'className');
  if (className !== null) q = q.where('m.class_name', '=', className);
  const groups = await countGrouped(q, { id: 'm.id', k: 'm.name_key' });
  const top = [...groups]
    .sort((a, b) => b.count - a.count || String(a.k).localeCompare(String(b.k)) || String(a.id).localeCompare(String(b.id)))
    .slice(0, topOf(ctx));
  if (top.length === 0) return [];
  const members = await ctx.db
    .selectFrom('members as m')
    .leftJoin('member_types as t', 't.id', 'm.member_type_id')
    .select(['m.id', 'm.member_no_display', 'm.name', 'm.class_name', 't.name_id', 't.name_en'])
    .where(
      'm.id',
      'in',
      top.map((g) => String(g.id)),
    )
    .execute();
  const byId = new Map(members.map((m) => [m.id, m]));
  return top.map((g, k) => {
    const m = byId.get(String(g.id));
    return [k + 1, m?.member_no_display ?? null, m?.name ?? null, m === undefined ? null : typeName(ctx, m), m?.class_name ?? null, g.count];
  });
}

/** The 10 or 50 most borrowed titles (see the top of this file). */
export const circulationTopTitlesReport: TableReport = Object.freeze<TableReport>({
  id: 'circulation.top_titles',
  module: 'circulation',
  kind: 'table',
  titleKey: 'report.circulation.top_titles.title',
  permission: 'reports.statistics.read',
  personal: false,
  formats: ['csv', 'xlsx', 'pdf'],
  orientation: 'portrait',
  params: [reportParam('range', 'dateRange'), reportParam('branchId', 'branch'), reportParam('classPrefix', 'classPrefix'), TOP_PARAM],
  paramsSchema: z.strictObject({
    range: reportDateRangeField.optional(),
    branchId: reportIdField.optional(),
    classPrefix: reportClassPrefixField.optional(),
    top: z.enum(TOP_SIZES).optional(),
  }),
  columns: [reportColumn('rank', 'int'), reportColumn('title', 'text', { widthChars: 40 }), reportColumn('call_number', 'text'), reportColumn('loans', 'int')],
  async rows(ctx, cursor, limit) {
    return offsetPage(await titleRows(ctx), cursor, limit);
  },
});

/** The 10 or 50 members who borrowed most (see the top of this file). */
export const circulationTopBorrowersReport: TableReport = Object.freeze<TableReport>({
  id: 'circulation.top_borrowers',
  module: 'circulation',
  kind: 'table',
  titleKey: 'report.circulation.top_borrowers.title',
  permission: 'circulation.records.read',
  personal: true,
  formats: ['csv', 'xlsx', 'pdf'],
  orientation: 'portrait',
  params: [reportParam('range', 'dateRange'), reportParam('memberTypeId', 'memberType'), reportParam('className', 'className'), TOP_PARAM],
  paramsSchema: z.strictObject({
    range: reportDateRangeField.optional(),
    memberTypeId: reportIdField.optional(),
    className: z.string().trim().min(1).max(64).optional(),
    top: z.enum(TOP_SIZES).optional(),
  }),
  columns: [
    reportColumn('rank', 'int'),
    reportColumn('member_no', 'text', { widthChars: 16 }),
    reportColumn('name', 'text', { source: { table: 'members', column: 'name' }, widthChars: 30 }),
    reportColumn('member_type', 'text'),
    reportColumn('class', 'text', { source: { table: 'members', column: 'class_name' } }),
    reportColumn('loans', 'int'),
  ],
  async rows(ctx, cursor, limit) {
    return offsetPage(await borrowerRows(ctx), cursor, limit);
  },
});
