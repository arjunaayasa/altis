import { countDistinctGrouped, countGrouped, countRows } from '@altis/db';
import { DDC_MAINS, addDays, localDate } from '@altis/shared';
import { sql, type SqlBool } from 'kysely';
import { z } from 'zod';
import { closedBy, countOpenDays, loadClosedDayRules } from '../../circulation/calendars.js';
import { offsetPage, textParam, vocabLabel } from '../collection/common.js';
import { reportColumn, reportDateRangeField, reportIdField, reportParam } from '../params.js';
import type { ReportCtx, ReportRow, TableReport } from '../types.js';
import { branchTodays, classIndexOf, closedRange, dueBeforeSql, rowLabel, sectionLabel } from './common.js';

// Circulation at a glance for a date range (by default the 30 days up to today) at one branch or all: the loans
// (lent in the range), returns (given back in the range, at the branch of the return), renewals (each renewal the desk
// or the member area made in the range, from its audit entry: a migrated loan's renewals were never ALTIS's), the
// distinct borrowers, the loans per open day of the range (the library calendar's closed days left out, and no day
// after today), the busiest day, the overdue loans open today, and the active members who borrowed nothing in the
// range: counted as the active members with no loan in it, so it is never negative. Then the loans by material type,
// collection type and DDC main class, from the dimensions each loan kept. A voided loan is no loan.

/** The loans of the range at the branch (alias `l`). */
function loansIn(ctx: ReportCtx, range: { from: string; to: string }, branchId: string | null) {
  let q = ctx.db
    .selectFrom('loans as l')
    .where('l.loaned_on', '>=', range.from)
    .where('l.loaned_on', '<=', range.to)
    .where(sql<SqlBool>`(l.outcome is null or l.outcome <> 'voided')`);
  if (branchId !== null) q = q.where('l.branch_id', '=', branchId);
  return q;
}

/** The loans per open day of `range` (up to today), one decimal; null when the range has no open day. */
async function perOpenDay(ctx: ReportCtx, range: { from: string; to: string }, branchId: string | null, loans: number): Promise<number | null> {
  const to = range.to > ctx.today ? ctx.today : range.to;
  if (to < range.from) return null;
  const closed = closedBy(await loadClosedDayRules(ctx.db, branchId));
  const days = countOpenDays(closed, addDays(range.from, -1), to);
  return days === 0 ? null : Math.round((loans / days) * 10) / 10;
}

/** The summary's rows. */
async function summaryRows(ctx: ReportCtx): Promise<ReportRow[]> {
  const range = closedRange(ctx, 'range', 30);
  const branchId = textParam(ctx, 'branchId');
  const totals = sectionLabel(ctx, 'totals');
  const rows: ReportRow[] = [];

  const loans = await countRows(loansIn(ctx, range, branchId));
  let returns = ctx.db
    .selectFrom('loans as l')
    .where('l.returned_on', '>=', range.from)
    .where('l.returned_on', '<=', range.to)
    .where('l.outcome', '=', 'returned');
  if (branchId !== null) returns = returns.where('l.return_branch_id', '=', branchId);
  const fromAt = Date.parse(`${addDays(range.from, -1)}T00:00:00Z`);
  const toAt = Date.parse(`${addDays(range.to, 2)}T00:00:00Z`);
  // The audit entries of the days around the range, then each kept by its local day in the library's time zone.
  let renewals = ctx.db
    .selectFrom('audit_log')
    .select(['at'])
    .where('action', '=', 'circulation.loan.renew')
    .where('at', '>=', fromAt)
    .where('at', '<', toAt);
  if (branchId !== null) renewals = renewals.where('branch_id', '=', branchId);
  const renewed = (await renewals.execute()).filter((r) => {
    const day = localDate(ctx.tz, Number(r.at));
    return day >= range.from && day <= range.to;
  }).length;
  const borrowers = (await countDistinctGrouped(loansIn(ctx, range, branchId), {}, 'l.member_id'))[0]?.count ?? 0;
  rows.push([totals, rowLabel(ctx, 'loans'), loans]);
  rows.push([totals, rowLabel(ctx, 'returns'), await countRows(returns)]);
  rows.push([totals, rowLabel(ctx, 'renewals'), renewed]);
  rows.push([totals, rowLabel(ctx, 'borrowers'), borrowers]);
  rows.push([totals, rowLabel(ctx, 'per_open_day'), await perOpenDay(ctx, range, branchId, loans)]);
  const byDay = await countGrouped(loansIn(ctx, range, branchId), { d: 'l.loaned_on' });
  const busiest = [...byDay].sort((a, b) => b.count - a.count || String(a.d).localeCompare(String(b.d)))[0];
  rows.push([totals, rowLabel(ctx, 'busiest_day', { date: busiest === undefined ? '-' : String(busiest.d) }), busiest?.count ?? 0]);

  const todays = await branchTodays(ctx);
  let overdue = ctx.db.selectFrom('loans as l').where('l.open_item_id', 'is not', null).where(dueBeforeSql(todays, -1));
  if (branchId !== null) overdue = overdue.where('l.branch_id', '=', branchId);
  rows.push([totals, rowLabel(ctx, 'overdue_open'), todays.size === 0 ? 0 : await countRows(overdue)]);

  // Active today, and no loan in the range (at the branch, when one is chosen).
  const lentIn = loansIn(ctx, range, branchId).select(sql<number>`1`.as('one')).where(sql<SqlBool>`l.member_id = m.id`);
  const idle = ctx.db
    .selectFrom('members as m')
    .where('m.anonymized_at', 'is', null)
    .where('m.archived_at', 'is', null)
    .where('m.status', '<>', 'suspended')
    .where((eb) => eb.or([eb('m.expires_on', 'is', null), eb('m.expires_on', '>=', ctx.today)]))
    .where((eb) => eb.not(eb.exists(lentIn)));
  rows.push([totals, rowLabel(ctx, 'active_not_borrowing'), await countRows(idle)]);

  // Loans by material type and collection type (by the type each loan kept), most first.
  const byMaterial = await countGrouped(loansIn(ctx, range, branchId), { k: 'l.stat_material_type_id' });
  const materials = await ctx.db.selectFrom('material_types').select(['id', 'name_id', 'name_en']).execute();
  const materialName = new Map(materials.map((m) => [m.id, ctx.locale === 'en' ? m.name_en : m.name_id]));
  const byType = await countGrouped(loansIn(ctx, range, branchId), { k: 'l.stat_collection_type_id' });
  const types = await ctx.db.selectFrom('collection_types').select(['id', 'name_id', 'name_en']).execute();
  const typeName = new Map(types.map((m) => [m.id, ctx.locale === 'en' ? m.name_en : m.name_id]));
  const none = rowLabel(ctx, 'none');
  const listed = (section: string, groups: readonly { k: string | number | null; count: number }[], names: Map<string, string>): void => {
    const sorted = [...groups].sort((a, b) => b.count - a.count || String(a.k).localeCompare(String(b.k)));
    for (const g of sorted) rows.push([sectionLabel(ctx, section), g.k === null ? none : (names.get(String(g.k)) ?? String(g.k)), g.count]);
  };
  listed('by_material_type', byMaterial, materialName);
  listed('by_collection_type', byType, typeName);

  // Loans by DDC main class, every class listed.
  const byClass = await countGrouped(loansIn(ctx, range, branchId), { d: 'l.stat_ddc' });
  const counts = DDC_MAINS.map(() => 0);
  for (const g of byClass) {
    const k = classIndexOf(g.d === null ? null : String(g.d));
    counts[k] = (counts[k] ?? 0) + g.count;
  }
  DDC_MAINS.forEach((main, k) => rows.push([sectionLabel(ctx, 'by_class'), `${main} ${vocabLabel(ctx, 'ddc_main', main) ?? ''}`.trim(), counts[k]!]));
  return rows;
}

/** Circulation at a glance (see the top of this file). */
export const circulationSummaryReport: TableReport = Object.freeze<TableReport>({
  id: 'circulation.summary',
  module: 'circulation',
  kind: 'table',
  titleKey: 'report.circulation.summary.title',
  permission: 'reports.statistics.read',
  personal: false,
  formats: ['csv', 'xlsx', 'pdf'],
  orientation: 'portrait',
  params: [reportParam('range', 'dateRange'), reportParam('branchId', 'branch')],
  paramsSchema: z.strictObject({ range: reportDateRangeField.optional(), branchId: reportIdField.optional() }),
  columns: [reportColumn('section', 'text'), reportColumn('item', 'text'), reportColumn('value', 'int')],
  async rows(ctx, cursor, limit) {
    return offsetPage(await summaryRows(ctx), cursor, limit);
  },
});
