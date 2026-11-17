import { countGrouped } from '@altis/db';
import { addDays, diffDays, isUlid, localDate, type LoanOutcome } from '@altis/shared';
import { DUE_SOON_DAYS, type LoanListItem, type LoanListQuery, type LoanListResponse, type LoanSearchBody } from '@altis/shared/api/circulation';
import { sql, type SqlBool } from 'kysely';
import { libraryTimeZone, memberValidationFailed, type Db } from '../members/common.js';
// ---- Komunitas (staff screens' data) ----
import { dueBeforeSql, memberMatchSql } from '../reports/circulation/common.js';
// ---- Komunitas (charges and payments) ----
import { FinePreviewer } from './fines.js';

// The loan list (`GET circulation/loans`): a member's open loans and history, an item's loans, and the overdue list.
//
// - `open` and `overdue` loans come by due date, then id (cursor `<dueOn>.<id>`); `closed` ones by return time, newest
//   first (cursor `<returnedAt>.<id>`).
// - Overdue = open and due before today in the time zone of the loan's branch. The library's branches are few, so the
//   condition is written per branch (`branch = b AND due_on < today_b`); `minDaysLate` moves each branch's bound back.
// - Days late: today for an open loan, the return day for a closed one (0 when on time). An overdue open loan has the
//   preview of its running fine (fines.ts).
// - The loan search (`POST circulation/loans/search`, the Terlambat & Jatuh Tempo screen) reads the same rows, open
//   ones only: overdue, or due soon (today to DUE_SOON_DAYS ahead), narrowed by the member's number or name and class.
//   Those are personal values, so they come in a POST body, never in a URL.

function badCursor(): never {
  throw memberValidationFailed([{ path: 'cursor', code: 'invalid' }]);
}

/** Today in every branch's time zone (the library's for a branch without one). */
async function branchTodays(db: Db, now: number): Promise<Map<string, string>> {
  const libraryZone = await libraryTimeZone(db);
  const rows = await db.selectFrom('branches').select(['id', 'timezone']).execute();
  return new Map(rows.map((b) => [b.id, localDate(b.timezone || libraryZone, now)]));
}

/** The loans with their item, record and member (aliases `l`, `i`, `r`, `m`), as the lists read them. */
function loanRows(db: Db) {
  return db
    .selectFrom('loans as l')
    .leftJoin('items as i', 'i.id', 'l.item_id')
    .leftJoin('records as r', 'r.id', 'l.record_id')
    .leftJoin('members as m', 'm.id', 'l.member_id')
    .select([
      'l.id',
      'l.version',
      'l.branch_id',
      'l.loaned_on',
      'l.due_on',
      'l.returned_on',
      'l.returned_at',
      'l.outcome',
      'l.renewals',
      'l.renew_limit',
      'l.fine_per_day_minor',
      'l.fine_cap_minor',
      'l.grace_days',
      'l.currency',
      'l.open_item_id',
      'l.item_id',
      'l.record_id',
      'l.member_id',
      'i.barcode_display',
      'i.call_number as item_call_number',
      'r.title',
      'r.call_number as record_call_number',
      'm.member_no_display',
      'm.name as member_name',
      'm.class_name',
      'm.member_type_id',
      'm.phone as member_phone',
    ]);
}

type LoanRowsQuery = ReturnType<typeof loanRows>;

/** `query` after the cursor `cursor` of an open (`<dueOn>.<id>`) or closed (`<returnedAt>.<id>`) list. */
function afterCursor(query: LoanRowsQuery, cursor: string, closed: boolean): LoanRowsQuery {
  const m = /^([0-9-]{10}|\d{1,15})\.([0-9A-Z]{26})$/.exec(cursor);
  if (m === null || !isUlid(m[2]!)) badCursor();
  const after = m[2]!;
  if (closed) {
    if (!/^\d{1,15}$/.test(m[1]!)) badCursor();
    const at = Number(m[1]);
    return query.where((eb) => eb.or([eb('l.returned_at', '<', at), eb.and([eb('l.returned_at', '=', at), eb('l.id', '<', after)])]));
  }
  const due = m[1]!;
  if (!/^\d{4}-\d{2}-\d{2}$/.test(due)) badCursor();
  return query.where((eb) => eb.or([eb('l.due_on', '>', due), eb.and([eb('l.due_on', '=', due), eb('l.id', '>', after)])]));
}

/** One page of `query` (already filtered and after its cursor) as list items, with the next cursor. */
async function loanPage(
  db: Db,
  query: LoanRowsQuery,
  o: { closed: boolean; limit: number; todays: ReadonlyMap<string, string>; fallbackToday: string; withPhone: boolean },
): Promise<LoanListResponse> {
  const { closed, todays, fallbackToday } = o;
  const ordered = closed ? query.orderBy('l.returned_at', 'desc').orderBy('l.id', 'desc') : query.orderBy('l.due_on').orderBy('l.id');
  const rows = await ordered.limit(o.limit + 1).execute();
  const page = rows.slice(0, o.limit);

  const fines = await FinePreviewer.open(db);
  const items: LoanListItem[] = [];
  for (const r of page) {
    const open = r.open_item_id !== null;
    const today = todays.get(r.branch_id) ?? fallbackToday;
    const until = open ? today : (r.returned_on ?? today);
    const daysLate = Math.max(0, diffDays(r.due_on, until));
    const finePreview = !open
      ? null
      : await fines.preview(
          {
            branchId: r.branch_id,
            dueOn: r.due_on,
            currency: r.currency,
            finePerDayMinor: Number(r.fine_per_day_minor),
            fineCapMinor: r.fine_cap_minor === null ? null : Number(r.fine_cap_minor),
            graceDays: Number(r.grace_days),
          },
          today,
        );
    items.push({
      id: r.id,
      version: Number(r.version),
      state: open ? 'open' : 'closed',
      overdue: open && daysLate > 0,
      daysLate,
      branchId: r.branch_id,
      loanedOn: r.loaned_on,
      dueOn: r.due_on,
      returnedOn: r.returned_on,
      outcome: (r.outcome as LoanOutcome | null) ?? null,
      renewals: Number(r.renewals),
      renewLimit: Number(r.renew_limit),
      item: r.item_id === null || r.barcode_display === null ? null : { id: r.item_id, barcode: r.barcode_display, callNumber: r.item_call_number ?? r.record_call_number ?? null },
      record: r.record_id === null || r.title === null ? null : { id: r.record_id, title: r.title },
      member:
        r.member_id === null || r.member_no_display === null
          ? null
          : {
              id: r.member_id,
              memberNo: r.member_no_display,
              name: r.member_name ?? '',
              className: r.class_name,
              typeId: r.member_type_id ?? '',
              ...(o.withPhone ? { phone: r.member_phone } : {}),
            },
      finePreview,
    });
  }
  const last = page[page.length - 1];
  const nextCursor = rows.length > o.limit && last !== undefined ? `${closed ? Number(last.returned_at) : last.due_on}.${last.id}` : null;
  return { items, nextCursor };
}

/**
 * A page of loans by `q` (see the top of this file) at `now`.
 *
 * @throws DomainError VALIDATION_FAILED (`cursor`, `invalid`)
 */
export async function listLoans(db: Db, q: LoanListQuery, now: number): Promise<LoanListResponse> {
  const todays = await branchTodays(db, now);
  const fallbackToday = localDate(await libraryTimeZone(db), now);
  let query = loanRows(db);
  if (q.memberId !== undefined) query = query.where('l.member_id', '=', q.memberId);
  if (q.itemId !== undefined) query = query.where('l.item_id', '=', q.itemId);
  if (q.branchId !== undefined) query = query.where('l.branch_id', '=', q.branchId);
  if (q.memberTypeId !== undefined) query = query.where('m.member_type_id', '=', q.memberTypeId);

  const closed = q.state === 'closed';
  if (closed) query = query.where('l.open_item_id', 'is', null);
  else query = query.where('l.open_item_id', 'is not', null);
  if (q.state === 'overdue') {
    const late = q.minDaysLate ?? 1;
    const bounds = [...todays.entries()].map(([branchId, today]) => sql<SqlBool>`(l.branch_id = ${branchId} and l.due_on <= ${addDays(today, -late)})`);
    if (bounds.length === 0) return { items: [], nextCursor: null };
    query = query.where(sql<SqlBool>`(${sql.join(bounds, sql` or `)})`);
  }
  if (q.cursor !== undefined) query = afterCursor(query, q.cursor, closed);
  return loanPage(db, query, { closed, limit: q.limit, todays, fallbackToday, withPhone: false });
}

// ---- Komunitas (staff screens' data) ----

/**
 * The overdue or due-soon open loans by `body` (LoanSearchBody) at `now`: past due by at least `minDaysLate` days, or
 * due from today to DUE_SOON_DAYS days ahead, each by its own branch's today; narrowed by the member's number or name
 * (`q`), class, type and the loan's branch. By due date, then id. `withPhone`: the members carry their phone.
 *
 * @throws DomainError VALIDATION_FAILED (`cursor`, `invalid`)
 */
export async function searchLoans(db: Db, body: LoanSearchBody, now: number, o: { withPhone: boolean }): Promise<LoanListResponse> {
  const todays = await branchTodays(db, now);
  if (todays.size === 0) return { items: [], nextCursor: null };
  const fallbackToday = localDate(await libraryTimeZone(db), now);
  let query = loanRows(db).where('l.open_item_id', 'is not', null);
  if (body.tab === 'due_soon') query = query.where(dueBeforeSql(todays, DUE_SOON_DAYS)).where(dueBeforeSql(todays, -1, '>'));
  else query = query.where(dueBeforeSql(todays, -(body.minDaysLate ?? 1)));
  const text = body.q?.trim() ?? '';
  if (text !== '') query = query.where(memberMatchSql(text));
  if (body.className !== undefined && body.className.trim() !== '') query = query.where('m.class_name', '=', body.className.trim());
  if (body.memberTypeId !== undefined) query = query.where('m.member_type_id', '=', body.memberTypeId);
  if (body.branchId !== undefined) query = query.where('l.branch_id', '=', body.branchId);
  if (body.cursor !== undefined) query = afterCursor(query, body.cursor, false);
  return loanPage(db, query, { closed: false, limit: body.limit, todays, fallbackToday, withPhone: o.withPhone });
}

/** The most class names a class list returns. */
export const CLASS_LIST_MAX = 2_000;

/** The class names of the live members holding an open loan, by name. */
export async function loanClassNames(db: Db): Promise<string[]> {
  const rows = await db
    .selectFrom('members as m')
    .select('m.class_name')
    .distinct()
    .where('m.class_name', 'is not', null)
    .where('m.anonymized_at', 'is', null)
    .where((eb) => eb.exists(eb.selectFrom('loans as l').select('l.id').whereRef('l.member_id', '=', 'm.id').where('l.open_item_id', 'is not', null)))
    .orderBy('m.class_name')
    .limit(CLASS_LIST_MAX)
    .execute();
  return rows.flatMap((r) => (r.class_name === null || r.class_name.trim() === '' ? [] : [r.class_name]));
}

/**
 * The open and the past-due loans of each member of `memberIds` (absent: none), each loan by its own branch's today:
 * one grouped read for the whole list, by member, branch and due date.
 */
export async function openLoanCounts(db: Db, memberIds: readonly string[], now: number): Promise<Map<string, { open: number; overdue: number }>> {
  const out = new Map<string, { open: number; overdue: number }>();
  if (memberIds.length === 0) return out;
  const todays = await branchTodays(db, now);
  const fallbackToday = localDate(await libraryTimeZone(db), now);
  const groups = await countGrouped(
    db.selectFrom('loans as l').where('l.open_item_id', 'is not', null).where('l.member_id', 'in', [...new Set(memberIds)]),
    { member: 'l.member_id', branch: 'l.branch_id', due: 'l.due_on' },
  );
  for (const g of groups) {
    const id = String(g.member);
    const today = todays.get(String(g.branch)) ?? fallbackToday;
    const c = out.get(id) ?? { open: 0, overdue: 0 };
    c.open += g.count;
    if (String(g.due) < today) c.overdue += g.count;
    out.set(id, c);
  }
  return out;
}
