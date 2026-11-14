import { addDays, diffDays, isUlid, localDate, type LoanOutcome } from '@altis/shared';
import type { LoanListItem, LoanListQuery, LoanListResponse } from '@altis/shared/api/circulation';
import { sql, type SqlBool } from 'kysely';
import { libraryTimeZone, memberValidationFailed, type Db } from '../members/common.js';

// The loan list (`GET circulation/loans`): a member's open loans and history, an item's loans, and the overdue list.
//
// - `open` and `overdue` loans come by due date, then id (cursor `<dueOn>.<id>`); `closed` ones by return time, newest
//   first (cursor `<returnedAt>.<id>`).
// - Overdue = open and due before today in the time zone of the loan's branch. The library's branches are few, so the
//   condition is written per branch (`branch = b AND due_on < today_b`); `minDaysLate` moves each branch's bound back.
// - Days late: today for an open loan, the return day for a closed one (0 when on time).

function badCursor(): never {
  throw memberValidationFailed([{ path: 'cursor', code: 'invalid' }]);
}

/** Today in every branch's time zone (the library's for a branch without one). */
async function branchTodays(db: Db, now: number): Promise<Map<string, string>> {
  const libraryZone = await libraryTimeZone(db);
  const rows = await db.selectFrom('branches').select(['id', 'timezone']).execute();
  return new Map(rows.map((b) => [b.id, localDate(b.timezone || libraryZone, now)]));
}

/**
 * A page of loans by `q` (see the top of this file) at `now`.
 *
 * @throws DomainError VALIDATION_FAILED (`cursor`, `invalid`)
 */
export async function listLoans(db: Db, q: LoanListQuery, now: number): Promise<LoanListResponse> {
  const todays = await branchTodays(db, now);
  const fallbackToday = localDate(await libraryTimeZone(db), now);
  let query = db
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
    ]);
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

  if (q.cursor !== undefined) {
    const m = /^([0-9-]{10}|\d{1,15})\.([0-9A-Z]{26})$/.exec(q.cursor);
    if (m === null || !isUlid(m[2]!)) badCursor();
    const after = m[2]!;
    if (closed) {
      if (!/^\d{1,15}$/.test(m[1]!)) badCursor();
      const at = Number(m[1]);
      query = query.where((eb) => eb.or([eb('l.returned_at', '<', at), eb.and([eb('l.returned_at', '=', at), eb('l.id', '<', after)])]));
    } else {
      const due = m[1]!;
      if (!/^\d{4}-\d{2}-\d{2}$/.test(due)) badCursor();
      query = query.where((eb) => eb.or([eb('l.due_on', '>', due), eb.and([eb('l.due_on', '=', due), eb('l.id', '>', after)])]));
    }
  }
  query = closed ? query.orderBy('l.returned_at', 'desc').orderBy('l.id', 'desc') : query.orderBy('l.due_on').orderBy('l.id');
  const rows = await query.limit(q.limit + 1).execute();
  const page = rows.slice(0, q.limit);

  const items: LoanListItem[] = page.map((r) => {
    const open = r.open_item_id !== null;
    const today = todays.get(r.branch_id) ?? fallbackToday;
    const until = open ? today : (r.returned_on ?? today);
    const daysLate = Math.max(0, diffDays(r.due_on, until));
    return {
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
          : { id: r.member_id, memberNo: r.member_no_display, name: r.member_name ?? '', className: r.class_name, typeId: r.member_type_id ?? '' },
    };
  });
  const last = page[page.length - 1];
  const nextCursor = rows.length > q.limit && last !== undefined ? `${closed ? Number(last.returned_at) : last.due_on}.${last.id}` : null;
  return { items, nextCursor };
}
