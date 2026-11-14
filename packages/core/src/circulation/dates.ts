import { addDays, localDate } from '@altis/shared';
import { libraryTimeZone, type Db } from '../members/common.js';

// The dates of a loan. Every date of a loan (the day it was lent, its due date, "today" when it is renewed or returned,
// days late) is a calendar date in the time zone of the loan's branch (`loans.branch_id`, `branches.timezone`; the
// library's `library.timezone` when the branch is gone), never the desk's.
//
// The due date has one seam, dueDateFor: this edition counts every day (no closed days yet); a library calendar plugs
// in there, so no caller changes when it does.

/** The time zone of the branch `branchId` (else the library's). */
export async function branchTimeZone(db: Db, branchId: string): Promise<string> {
  const row = await db.selectFrom('branches').select('timezone').where('id', '=', branchId).executeTakeFirst();
  return row?.timezone ?? (await libraryTimeZone(db));
}

/** Today at `now` in the time zone of the branch `branchId`. */
export async function branchToday(db: Db, branchId: string, now: number): Promise<string> {
  return localDate(await branchTimeZone(db, branchId), now);
}

/** What a due date is computed from. */
export interface DueDateInput {
  /** The day the loan period starts: the day it was lent, or the day of a renewal. */
  loanedOn: string;
  /** The rule's loan days (0: due the same day). */
  days: number;
  /** The member's last valid day, or null when the membership never ends. */
  expiresOn: string | null;
  /** The loan's branch (the branch whose calendar will count). */
  branchId: string;
}

/**
 * The due date of a loan: `loanedOn + days`, cut to the member's `expiresOn` when that comes first (`capped`), never
 * before `loanedOn`. Closed days are not counted in this edition (see the top of this file).
 */
export async function dueDateFor(db: Db, i: DueDateInput): Promise<{ dueOn: string; capped: boolean }> {
  void db;
  let due = addDays(i.loanedOn, i.days);
  let capped = false;
  if (i.expiresOn !== null && due > i.expiresOn) {
    due = i.expiresOn;
    capped = true;
  }
  if (due < i.loanedOn) due = i.loanedOn;
  return { dueOn: due, capped };
}
