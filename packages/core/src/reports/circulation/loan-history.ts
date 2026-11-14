import { countRows } from '@altis/db';
import { diffDays, normalizeKey } from '@altis/shared';
import { sql, type SqlBool } from 'kysely';
import { z } from 'zod';
import { decodeCursor, encodeCursor, rangeParam, textParam, vocabLabel } from '../collection/common.js';
import { reportColumn, reportDateRangeField, reportIdField, reportParam } from '../params.js';
import type { ReportCtx, ReportRow, TableReport } from '../types.js';
import { branchTodays, escapeLike, memberMatchSql, numberIdKeyset, titleMatchSql, todayAt, typeName } from './common.js';

// The loan history (personal data): every loan with its borrower (number and name; none once anonymised), the
// borrower's type and class when the loan was made, the copy, the dates, the renewals, the outcome and the days late
// (to today for an open loan, to the return for a closed one; calendar days). Filtered by member (number or name),
// member type, class, words of the title, the start of a barcode, the lending dates, the state (open, returned,
// lost), branch and location. Newest loan first, keyset paged. A voided loan is not listed.

/** The states the list can keep to. */
export const LOAN_HISTORY_STATES = Object.freeze(['open', 'returned', 'lost'] as const);

function filtered(ctx: ReportCtx) {
  let q = ctx.db
    .selectFrom('loans as l')
    .leftJoin('members as m', 'm.id', 'l.member_id')
    .leftJoin('items as i', 'i.id', 'l.item_id')
    .leftJoin('records as r', 'r.id', 'l.record_id')
    .where(sql<SqlBool>`(l.outcome is null or l.outcome <> 'voided')`);
  const member = textParam(ctx, 'member');
  if (member !== null) q = q.where(memberMatchSql(member));
  const memberTypeId = textParam(ctx, 'memberTypeId');
  if (memberTypeId !== null) q = q.where('l.stat_member_type_id', '=', memberTypeId);
  const className = textParam(ctx, 'className');
  if (className !== null) q = q.where('l.stat_class_name', '=', className);
  const title = textParam(ctx, 'titleWords');
  const titleSql = title === null ? null : titleMatchSql(title);
  if (titleSql !== null) q = q.where(titleSql);
  const barcode = textParam(ctx, 'barcode');
  if (barcode !== null) q = q.where(sql<SqlBool>`i.barcode_key like ${`${escapeLike(normalizeKey(barcode))}%`} escape '!'`);
  const loaned = rangeParam(ctx, 'loaned');
  if (loaned.from !== null) q = q.where('l.loaned_on', '>=', loaned.from);
  if (loaned.to !== null) q = q.where('l.loaned_on', '<=', loaned.to);
  const state = textParam(ctx, 'loanState');
  if (state === 'open') q = q.where('l.open_item_id', 'is not', null);
  else if (state === 'returned' || state === 'lost') q = q.where('l.outcome', '=', state);
  const branchId = textParam(ctx, 'branchId');
  if (branchId !== null) q = q.where('l.branch_id', '=', branchId);
  const locationId = textParam(ctx, 'locationId');
  if (locationId !== null) q = q.where('l.stat_location_id', '=', locationId);
  return q;
}

/** The loan history (see the top of this file). */
export const circulationLoanHistoryReport: TableReport = Object.freeze<TableReport>({
  id: 'circulation.loan_history',
  module: 'circulation',
  kind: 'table',
  titleKey: 'report.circulation.loan_history.title',
  permission: 'circulation.records.read',
  personal: true,
  formats: ['csv', 'xlsx', 'pdf'],
  orientation: 'landscape',
  params: [
    reportParam('member', 'text'),
    reportParam('memberTypeId', 'memberType'),
    reportParam('className', 'className'),
    reportParam('titleWords', 'text'),
    reportParam('barcode', 'text'),
    reportParam('loaned', 'dateRange'),
    reportParam('loanState', 'status', { options: LOAN_HISTORY_STATES }),
    reportParam('branchId', 'branch'),
    reportParam('locationId', 'location'),
  ],
  paramsSchema: z.strictObject({
    member: z.string().trim().min(1).max(191).optional(),
    memberTypeId: reportIdField.optional(),
    className: z.string().trim().min(1).max(64).optional(),
    titleWords: z.string().trim().min(1).max(200).optional(),
    barcode: z.string().trim().min(1).max(64).optional(),
    loaned: reportDateRangeField.optional(),
    loanState: z.enum(LOAN_HISTORY_STATES).optional(),
    branchId: reportIdField.optional(),
    locationId: reportIdField.optional(),
  }),
  columns: [
    reportColumn('member_no', 'text', { widthChars: 14 }),
    reportColumn('name', 'text', { source: { table: 'members', column: 'name' }, widthChars: 24 }),
    reportColumn('member_type', 'text', { widthChars: 12 }),
    reportColumn('class', 'text', { widthChars: 8 }),
    reportColumn('barcode', 'text', { widthChars: 14 }),
    reportColumn('title', 'text', { widthChars: 30 }),
    reportColumn('loaned_on', 'date'),
    reportColumn('due_on', 'date'),
    reportColumn('returned_on', 'date'),
    reportColumn('renewals', 'int'),
    reportColumn('outcome', 'text', { widthChars: 12 }),
    reportColumn('days_late', 'int'),
  ],
  async rows(ctx, cursor, limit) {
    let q = filtered(ctx)
      .leftJoin('member_types as t', 't.id', 'l.stat_member_type_id')
      .select([
        'l.id',
        'l.loaned_at',
        'l.branch_id',
        'l.loaned_on',
        'l.due_on',
        'l.returned_on',
        'l.renewals',
        'l.outcome',
        'l.open_item_id',
        'l.stat_class_name',
        'm.member_no_display',
        'm.name',
        't.name_id',
        't.name_en',
        'i.barcode_display',
        'r.title',
      ]);
    if (cursor !== null) {
      const [at, id] = decodeCursor(cursor, numberIdKeyset);
      q = q.where((eb) => eb.or([eb('l.loaned_at', '<', at), eb.and([eb('l.loaned_at', '=', at), eb('l.id', '<', id)])]));
    }
    const found = await q.orderBy('l.loaned_at', 'desc').orderBy('l.id', 'desc').limit(limit + 1).execute();
    const page = found.slice(0, limit);
    const todays = await branchTodays(ctx);
    const rows: ReportRow[] = page.map((r) => {
      const open = r.open_item_id !== null;
      const until = open ? todayAt(ctx, todays, r.branch_id) : (r.returned_on ?? r.due_on);
      const late = Math.max(0, diffDays(r.due_on, until));
      return [
        r.member_no_display,
        r.name,
        typeName(ctx, r),
        r.stat_class_name,
        r.barcode_display,
        r.title,
        r.loaned_on,
        r.due_on,
        r.returned_on,
        Number(r.renewals),
        open ? vocabLabel(ctx, 'loan_state', 'open') : vocabLabel(ctx, 'loan_outcome', r.outcome),
        late,
      ];
    });
    const last = page[page.length - 1];
    return { rows, nextCursor: found.length > limit && last !== undefined ? encodeCursor([Number(last.loaned_at), last.id]) : null };
  },
  async count(ctx) {
    return countRows(filtered(ctx));
  },
});
