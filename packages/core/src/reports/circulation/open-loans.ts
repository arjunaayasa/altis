import { countRows } from '@altis/db';
import { diffDays } from '@altis/shared';
import { sql, type SqlBool } from 'kysely';
import { z } from 'zod';
import { overdueFineMinor, FinePreviewer } from '../../circulation/fines.js';
import { anyOf, decodeCursor, encodeCursor, moneyCell, rangeParam, textParam } from '../collection/common.js';
import { reportColumn, reportDateRangeField, reportIdField, reportParam } from '../params.js';
import type { ReportColumn, ReportCtx, ReportRow, TableReport } from '../types.js';
import { boolParam, branchTodays, dueBeforeSql, intParam, memberMatchSql, todayAt } from './common.js';

// The open loans with the borrower's contact (personal data), in three reports over the same rows:
//
// - `circulation.open_loans`: every open loan, grouped by member (by name, then the member, then the due date) or by
//   copy (by barcode); filtered by member, member type, class, branch, location, and overdue only.
// - `circulation.overdue`: the open loans due before today in their own branch, by member, each with the copy's price,
//   the days late and the running fine if it came back today (the loan's own terms; the closed days of its branch's
//   calendar left out when the library counts fines that way); filtered by branch, member type, class, a least number
//   of days late and the due dates.
// - `circulation.due_soon`: the open loans due from today to N days ahead (3 by default) in their own branch, by member.
//
// Member type and class are the member's current ones. Keyset paged over the order's columns.

const contactColumns: readonly ReportColumn[] = [
  reportColumn('member_no', 'text', { widthChars: 14 }),
  reportColumn('name', 'text', { source: { table: 'members', column: 'name' }, widthChars: 24 }),
  reportColumn('class', 'text', { source: { table: 'members', column: 'class_name' }, widthChars: 8 }),
  reportColumn('phone', 'text', { source: { table: 'members', column: 'phone' }, widthChars: 14 }),
  reportColumn('email', 'text', { source: { table: 'members', column: 'email' }, widthChars: 22 }),
  reportColumn('barcode', 'text', { widthChars: 14 }),
  reportColumn('title', 'text', { widthChars: 28 }),
];

/** How the open loans are grouped. */
export const OPEN_LOAN_GROUPS = Object.freeze(['member', 'item'] as const);

/** The keyset of the by-member order: name key, member id, due date, loan id. */
const memberKeyset = z.tuple([z.string().max(400), z.string().max(26), z.string().max(10), z.string().min(1).max(26)]);
/** The keyset of the by-copy order: barcode key, loan id. */
const itemKeyset = z.tuple([z.string().max(400), z.string().min(1).max(26)]);

/** Strictly after `values` in the order of `columns` (all ascending). */
function afterSql(columns: readonly string[], values: readonly string[]): ReturnType<typeof anyOf> {
  const parts = columns.map((column, k) => {
    const equal = columns.slice(0, k).map((c, j) => sql<SqlBool>`${sql.ref(c)} = ${values[j]}`);
    return sql<SqlBool>`(${sql.join([...equal, sql<SqlBool>`${sql.ref(column)} > ${values[k]}`], sql` and `)})`;
  });
  return anyOf(parts);
}

/** The open loans of a report (aliases `l`, `m`, `i`, `r`), with the shared filters. */
function openLoans(ctx: ReportCtx) {
  let q = ctx.db
    .selectFrom('loans as l')
    .innerJoin('members as m', 'm.id', 'l.member_id')
    .leftJoin('items as i', 'i.id', 'l.item_id')
    .leftJoin('records as r', 'r.id', 'l.record_id')
    .where('l.open_item_id', 'is not', null);
  const member = textParam(ctx, 'member');
  if (member !== null) q = q.where(memberMatchSql(member));
  const memberTypeId = textParam(ctx, 'memberTypeId');
  if (memberTypeId !== null) q = q.where('m.member_type_id', '=', memberTypeId);
  const className = textParam(ctx, 'className');
  if (className !== null) q = q.where('m.class_name', '=', className);
  const branchId = textParam(ctx, 'branchId');
  if (branchId !== null) q = q.where('l.branch_id', '=', branchId);
  const locationId = textParam(ctx, 'locationId');
  if (locationId !== null) q = q.where('i.location_id', '=', locationId);
  return q;
}

/** What each report adds to the shared filters. */
type Kind = 'open' | 'overdue' | 'due_soon';

async function scoped(ctx: ReportCtx, kind: Kind) {
  const todays = await branchTodays(ctx);
  let q = openLoans(ctx);
  if (kind === 'open' && boolParam(ctx, 'overdueOnly')) q = q.where(dueBeforeSql(todays, -1));
  if (kind === 'overdue') {
    q = q.where(dueBeforeSql(todays, -intParam(ctx, 'minDaysLate', 1)));
    const due = rangeParam(ctx, 'due');
    if (due.from !== null) q = q.where('l.due_on', '>=', due.from);
    if (due.to !== null) q = q.where('l.due_on', '<=', due.to);
  }
  if (kind === 'due_soon') q = q.where(dueBeforeSql(todays, intParam(ctx, 'days', 3))).where(dueBeforeSql(todays, -1, '>'));
  return { q, todays };
}

/** A page of one of the three reports. */
async function page(ctx: ReportCtx, kind: Kind, cursor: string | null, limit: number): Promise<{ rows: ReportRow[]; nextCursor: string | null }> {
  const { q: base, todays } = await scoped(ctx, kind);
  const byItem = kind === 'open' && ctx.params['groupBy'] === 'item';
  let q = base.select([
    'l.id',
    'l.member_id',
    'l.branch_id',
    'l.loaned_on',
    'l.due_on',
    'l.fine_per_day_minor',
    'l.fine_cap_minor',
    'l.grace_days',
    'm.name_key',
    'm.member_no_display',
    'm.name',
    'm.class_name',
    'm.phone',
    'm.email',
    'i.barcode_display',
    'i.barcode_key',
    'i.price',
    'r.title',
  ]);
  if (byItem) {
    if (cursor !== null) q = q.where(afterSql(['i.barcode_key', 'l.id'], decodeCursor(cursor, itemKeyset)));
    q = q.orderBy('i.barcode_key').orderBy('l.id');
  } else {
    if (cursor !== null) q = q.where(afterSql(['m.name_key', 'l.member_id', 'l.due_on', 'l.id'], decodeCursor(cursor, memberKeyset)));
    q = q.orderBy('m.name_key').orderBy('l.member_id').orderBy('l.due_on').orderBy('l.id');
  }
  const found = await q.limit(limit + 1).execute();
  const rows = found.slice(0, limit);
  const fines = kind === 'overdue' ? await FinePreviewer.open(ctx.db) : null;
  const out: ReportRow[] = [];
  for (const r of rows) {
    const today = todayAt(ctx, todays, r.branch_id);
    const contact = [r.member_no_display, r.name, r.class_name, r.phone, r.email, r.barcode_display, r.title];
    if (kind === 'due_soon') {
      out.push([...contact, r.loaned_on, r.due_on, Math.max(0, diffDays(today, r.due_on))]);
      continue;
    }
    const late = Math.max(0, diffDays(r.due_on, today));
    if (kind === 'open') {
      out.push([...contact, r.loaned_on, r.due_on, late]);
      continue;
    }
    const terms = {
      finePerDayMinor: Number(r.fine_per_day_minor),
      fineCapMinor: r.fine_cap_minor === null ? null : Number(r.fine_cap_minor),
      graceDays: Number(r.grace_days),
    };
    const fineDays = terms.finePerDayMinor > 0 && fines !== null ? await fines.lateDays(r.branch_id, r.due_on, today) : 0;
    out.push([...contact, moneyCell(r.price), r.loaned_on, r.due_on, late, moneyCell(overdueFineMinor(fineDays, terms))]);
  }
  const last = rows[rows.length - 1];
  let nextCursor: string | null = null;
  if (found.length > limit && last !== undefined) {
    nextCursor = byItem ? encodeCursor([last.barcode_key ?? '', last.id]) : encodeCursor([last.name_key, last.member_id ?? '', last.due_on, last.id]);
  }
  return { rows: out, nextCursor };
}

const MEMBER_FILTERS = [reportParam('memberTypeId', 'memberType'), reportParam('className', 'className'), reportParam('branchId', 'branch')];
const memberFilterSchema = {
  memberTypeId: reportIdField.optional(),
  className: z.string().trim().min(1).max(64).optional(),
  branchId: reportIdField.optional(),
};

/** Every open loan with the borrower's contact (see the top of this file). */
export const circulationOpenLoansReport: TableReport = Object.freeze<TableReport>({
  id: 'circulation.open_loans',
  module: 'circulation',
  kind: 'table',
  titleKey: 'report.circulation.open_loans.title',
  permission: 'circulation.records.read',
  personal: true,
  formats: ['csv', 'xlsx', 'pdf'],
  orientation: 'landscape',
  params: [
    reportParam('member', 'text'),
    ...MEMBER_FILTERS,
    reportParam('locationId', 'location'),
    reportParam('overdueOnly', 'bool'),
    reportParam('groupBy', 'status', { options: OPEN_LOAN_GROUPS }),
  ],
  paramsSchema: z.strictObject({
    member: z.string().trim().min(1).max(191).optional(),
    ...memberFilterSchema,
    locationId: reportIdField.optional(),
    overdueOnly: z.boolean().optional(),
    groupBy: z.enum(OPEN_LOAN_GROUPS).optional(),
  }),
  columns: [...contactColumns, reportColumn('loaned_on', 'date'), reportColumn('due_on', 'date'), reportColumn('days_late', 'int')],
  rows: (ctx, cursor, limit) => page(ctx, 'open', cursor, limit),
  async count(ctx) {
    return countRows((await scoped(ctx, 'open')).q);
  },
});

/** The overdue loans by member, with the running fines (see the top of this file). */
export const circulationOverdueReport: TableReport = Object.freeze<TableReport>({
  id: 'circulation.overdue',
  module: 'circulation',
  kind: 'table',
  titleKey: 'report.circulation.overdue.title',
  permission: 'circulation.records.read',
  personal: true,
  formats: ['csv', 'xlsx', 'pdf'],
  orientation: 'landscape',
  params: [...MEMBER_FILTERS, reportParam('minDaysLate', 'int', { min: 1, max: 3650 }), reportParam('due', 'dateRange')],
  paramsSchema: z.strictObject({
    ...memberFilterSchema,
    minDaysLate: z.int().min(1).max(3650).optional(),
    due: reportDateRangeField.optional(),
  }),
  columns: [
    ...contactColumns,
    reportColumn('price', 'money'),
    reportColumn('loaned_on', 'date'),
    reportColumn('due_on', 'date'),
    reportColumn('days_late', 'int'),
    reportColumn('fine', 'money'),
  ],
  rows: (ctx, cursor, limit) => page(ctx, 'overdue', cursor, limit),
  async count(ctx) {
    return countRows((await scoped(ctx, 'overdue')).q);
  },
});

/** The loans due soon, by member (see the top of this file). */
export const circulationDueSoonReport: TableReport = Object.freeze<TableReport>({
  id: 'circulation.due_soon',
  module: 'circulation',
  kind: 'table',
  titleKey: 'report.circulation.due_soon.title',
  permission: 'circulation.records.read',
  personal: true,
  formats: ['csv', 'xlsx', 'pdf'],
  orientation: 'landscape',
  params: [reportParam('days', 'int', { min: 0, max: 60 }), ...MEMBER_FILTERS],
  paramsSchema: z.strictObject({ days: z.int().min(0).max(60).optional(), ...memberFilterSchema }),
  columns: [...contactColumns, reportColumn('loaned_on', 'date'), reportColumn('due_on', 'date'), reportColumn('days_left', 'int')],
  rows: (ctx, cursor, limit) => page(ctx, 'due_soon', cursor, limit),
  async count(ctx) {
    return countRows((await scoped(ctx, 'due_soon')).q);
  },
});
