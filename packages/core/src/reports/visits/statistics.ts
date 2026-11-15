import { datePrefix, sumGrouped } from '@altis/db';
import { VISIT_SOURCES, addDays, endOfMonth, isoWeekday, type MessageKey } from '@altis/shared';
import { z } from 'zod';
import { label, offsetPage, textParam, vocabLabel } from '../collection/common.js';
import { reportColumn, reportIdField, reportParam, reportYearField } from '../params.js';
import type { ReportCtx, ReportRow, TableReport } from '../types.js';
import { MONTH_COLUMNS, MONTH_KEYS, monthIndexOf, rowLabel, sumOf, yearParam } from '../circulation/common.js';

// The visit statistics (no personal data): people counted, each visit by its head count (a class visit counts its
// pupils), a voided visit not at all, by the member type, accreditation group and class a visit kept when it was made.
//
// - `visits.monthly`: one row per member type (or accreditation group, class, or source of the visit), the guests in
//   their own row, one column per month of the year and the total; filtered by branch, room and source.
// - `visits.daily`: one row per day of a month, members and guests apart, and the total; filtered by branch and source.

/** How the monthly visits are grouped. */
export const VISIT_GROUPINGS = Object.freeze(['member_type', 'accred_group', 'class', 'source'] as const);

/** The visits counted (alias `v`) between two days, with the filters. */
function counted(ctx: ReportCtx, from: string, to: string) {
  let q = ctx.db.selectFrom('visits as v').where('v.visited_on', '>=', from).where('v.visited_on', '<=', to).where('v.voided_at', 'is', null);
  const branchId = textParam(ctx, 'branchId');
  if (branchId !== null) q = q.where('v.branch_id', '=', branchId);
  const locationId = textParam(ctx, 'locationId');
  if (locationId !== null) q = q.where('v.location_id', '=', locationId);
  const source = textParam(ctx, 'source');
  if (source !== null) q = q.where('v.source', '=', source);
  return q;
}

/** The key of a monthly row: a member type, a group, a class or a source; guests, unknown members and none apart. */
type RowKey = { order: number; label: string };

async function monthly(ctx: ReportCtx): Promise<{ rows: ReportRow[]; totals: ReportRow }> {
  const year = yearParam(ctx);
  const grouping = (textParam(ctx, 'rowsBy') ?? 'member_type') as (typeof VISIT_GROUPINGS)[number];
  const groups = await sumGrouped(
    counted(ctx, `${year}-01-01`, `${year}-12-31`),
    { t: 'v.member_type_id', a: 'v.accred_group', c: 'v.class_name', s: 'v.source', m: datePrefix('v.visited_on', 'month') },
    'v.headcount',
  );
  const types = await ctx.db.selectFrom('member_types').select(['id', 'name_id', 'name_en', 'sort_order']).execute();
  const typeOf = new Map(types.map((t) => [t.id, t]));
  const guest = rowLabel(ctx, 'guests');
  const special = (a: string | number | null): RowKey | null => {
    if (a === 'guest') return { order: 900_000, label: guest };
    if (a === 'unknown') return { order: 900_001, label: vocabLabel(ctx, 'visit_group', 'unknown') ?? 'unknown' };
    return null;
  };
  const keyOf = (g: (typeof groups)[number]): RowKey => {
    if (grouping === 'source') return { order: VISIT_SOURCES.indexOf(String(g.s) as never), label: vocabLabel(ctx, 'visit_source', String(g.s)) ?? String(g.s) };
    const s = special(g.a);
    if (s !== null) return s;
    if (grouping === 'accred_group') {
      return g.a === null ? { order: 900_002, label: rowLabel(ctx, 'none') } : { order: 0, label: vocabLabel(ctx, 'accred_group', String(g.a)) ?? String(g.a) };
    }
    if (grouping === 'class') return g.c === null ? { order: 900_002, label: rowLabel(ctx, 'none') } : { order: 0, label: String(g.c) };
    const t = g.t === null ? undefined : typeOf.get(String(g.t));
    if (t === undefined) return { order: 900_002, label: rowLabel(ctx, 'none') };
    return { order: Number(t.sort_order), label: ctx.locale === 'en' ? (t.name_en ?? t.name_id) : t.name_id };
  };
  const byRow = new Map<string, { key: RowKey; months: number[] }>();
  for (const g of groups) {
    const key = keyOf(g);
    const id = `${key.order}|${key.label}`;
    let entry = byRow.get(id);
    if (entry === undefined) {
      entry = { key, months: MONTH_KEYS.map(() => 0) };
      byRow.set(id, entry);
    }
    const k = monthIndexOf(g.m);
    if (k !== null) entry.months[k] = (entry.months[k] ?? 0) + g.sum;
  }
  const sorted = [...byRow.values()].sort((a, b) => a.key.order - b.key.order || a.key.label.localeCompare(b.key.label));
  const rows: ReportRow[] = sorted.map((e) => [e.key.label, ...e.months, sumOf(e.months)]);
  const sums = MONTH_KEYS.map((_, k) => sumOf(sorted.map((e) => e.months[k]!)));
  return { rows, totals: [label(ctx, 'report.row.total' as MessageKey), ...sums, sumOf(sums)] };
}

/** The visits per month of a year (see the top of this file). */
export const visitsMonthlyReport: TableReport = Object.freeze<TableReport>({
  id: 'visits.monthly',
  module: 'visits',
  kind: 'table',
  titleKey: 'report.visits.monthly.title',
  permission: 'reports.statistics.read',
  personal: false,
  formats: ['csv', 'xlsx', 'pdf'],
  orientation: 'landscape',
  params: [
    reportParam('year', 'year', { min: 1900, max: 2100 }),
    reportParam('rowsBy', 'status', { options: VISIT_GROUPINGS }),
    reportParam('branchId', 'branch'),
    reportParam('locationId', 'location'),
    reportParam('source', 'status', { options: VISIT_SOURCES, optionLabelPrefix: 'vocab.visit_source.' }),
  ],
  paramsSchema: z.strictObject({
    year: reportYearField.optional(),
    rowsBy: z.enum(VISIT_GROUPINGS).optional(),
    branchId: reportIdField.optional(),
    locationId: reportIdField.optional(),
    source: z.enum(VISIT_SOURCES).optional(),
  }),
  columns: [reportColumn('group', 'text', { widthChars: 24 }), ...MONTH_COLUMNS],
  async rows(ctx, cursor, limit) {
    return offsetPage((await monthly(ctx)).rows, cursor, limit);
  },
  async totals(ctx) {
    return (await monthly(ctx)).totals;
  },
});

/** The month a daily calendar shows: `year` and `month`, else this month. */
function monthOf(ctx: ReportCtx): string {
  const year = yearParam(ctx);
  const month = typeof ctx.params['month'] === 'number' ? (ctx.params['month'] as number) : Number(ctx.today.slice(5, 7));
  return `${year}-${String(month).padStart(2, '0')}`;
}

async function daily(ctx: ReportCtx): Promise<{ rows: ReportRow[]; totals: ReportRow }> {
  const month = monthOf(ctx);
  const first = `${month}-01`;
  const last = endOfMonth(month);
  const groups = await sumGrouped(counted(ctx, first, last), { d: 'v.visited_on', a: 'v.accred_group' }, 'v.headcount');
  const members = new Map<string, number>();
  const guests = new Map<string, number>();
  for (const g of groups) {
    const map = g.a === 'guest' ? guests : members;
    map.set(String(g.d), (map.get(String(g.d)) ?? 0) + g.sum);
  }
  const rows: ReportRow[] = [];
  for (let day = first; day <= last; day = addDays(day, 1)) {
    const m = members.get(day) ?? 0;
    const g = guests.get(day) ?? 0;
    rows.push([day, label(ctx, `report.weekday.${isoWeekday(day)}` as MessageKey), m, g, m + g]);
  }
  const sum = (k: number): number => sumOf(rows.map((r) => Number(r[k])));
  return { rows, totals: [label(ctx, 'report.row.total' as MessageKey), null, sum(2), sum(3), sum(4)] };
}

/** The visits per day of a month (see the top of this file). */
export const visitsDailyReport: TableReport = Object.freeze<TableReport>({
  id: 'visits.daily',
  module: 'visits',
  kind: 'table',
  titleKey: 'report.visits.daily.title',
  permission: 'reports.statistics.read',
  personal: false,
  formats: ['csv', 'xlsx', 'pdf'],
  orientation: 'portrait',
  params: [
    reportParam('year', 'year', { min: 1900, max: 2100 }),
    reportParam('month', 'int', { min: 1, max: 12 }),
    reportParam('branchId', 'branch'),
    reportParam('source', 'status', { options: VISIT_SOURCES, optionLabelPrefix: 'vocab.visit_source.' }),
  ],
  paramsSchema: z.strictObject({
    year: reportYearField.optional(),
    month: z.int().min(1).max(12).optional(),
    branchId: reportIdField.optional(),
    source: z.enum(VISIT_SOURCES).optional(),
  }),
  columns: [
    reportColumn('date', 'date'),
    reportColumn('weekday', 'text'),
    reportColumn('members', 'int'),
    reportColumn('guests', 'int'),
    reportColumn('total', 'int'),
  ],
  async rows(ctx, cursor, limit) {
    return offsetPage((await daily(ctx)).rows, cursor, limit);
  },
  async totals(ctx) {
    return (await daily(ctx)).totals;
  },
  async count(ctx) {
    return (await daily(ctx)).rows.length;
  },
});
