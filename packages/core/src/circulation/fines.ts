import { diffDays } from '@altis/shared';
import type { FinePreview } from '@altis/shared/api/charges';
import { formatPrice } from '../catalog/items/service.js';
import type { Db } from '../members/common.js';
import { readSettings } from '../settings/service.js';
import { closedBy, countOpenDays, loadClosedDayRules } from './calendars.js';

// Overdue fines. A loan copies its rule's terms when it is made (fine per day, cap, grace days); the fine of a late loan
// is computed from those terms when it is booked, never accrued day by day:
//
// - the days late are the days after the due date up to the day it is booked (its return, a late renewal, the day it
//   was declared lost), counted in the calendar and time zone of the loan's branch; with
//   `circulation.fines.skipClosedDays` (the default) only the days the library is open count;
// - within the grace days (days late <= grace) the fine is 0; past them it is the fine per day times every day late
//   (not only the days past the grace), then at most the cap when the rule has one;
// - everything is in minor units, so no rounding ever happens.
//
// An overdue open loan shows the same computation for today as a preview (the desk, the overdue list); nothing is
// written until the loan is booked.
//
// Every place that says how late a loan is (the desk, the return, the transaction slip, the overdue mail, /akun, the
// fine booked) goes through FinePreviewer.lateness: the calendar days late, and the days its fine counts (the open
// days only when closed days are not fined; none within the grace days or without a fine per day), so the days a
// fine names are never counted a second way.

/** The terms of a loan a fine is computed from (minor units). */
export interface FineTerms {
  finePerDayMinor: number;
  fineCapMinor: number | null;
  graceDays: number;
}

/**
 * The overdue fine of `lateDays` days late under `terms`: 0 within the grace days, else the fine per day times every
 * day late, at most the cap (and never above the largest safe integer).
 */
export function overdueFineMinor(lateDays: number, terms: FineTerms): number {
  const days = Math.max(0, Math.trunc(lateDays));
  const perDay = Math.max(0, Math.trunc(terms.finePerDayMinor));
  if (days === 0 || perDay === 0 || days <= Math.max(0, terms.graceDays)) return 0;
  const fine = Math.min(perDay * days, Number.MAX_SAFE_INTEGER);
  return terms.fineCapMinor === null ? fine : Math.min(fine, Math.max(0, Math.trunc(terms.fineCapMinor)));
}

/** Whether overdue fines leave the library's closed days out (`circulation.fines.skipClosedDays`). */
export async function finesSkipClosedDays(db: Db): Promise<boolean> {
  return (await readSettings(db, ['circulation.fines.skipClosedDays'], []))['circulation.fines.skipClosedDays'] === true;
}

/** A loan's due date, branch and fine terms, as the preview reads them. */
export interface PreviewLoan extends FineTerms {
  branchId: string;
  dueOn: string;
  currency: string;
}

/** How late a loan is on a day, and what its overdue fine counts then. */
export interface Lateness {
  /** Calendar days after the due date (0: not late). */
  daysLate: number;
  /**
   * The days the overdue fine counts: the open days late when the library's closed days are not fined, else every day
   * late; null when there is no fine (not late, no fine per day, or within the grace days).
   */
  finedDays: number | null;
  /** The overdue fine in minor units (0: none). */
  fineMinor: number;
}

/**
 * Counts days late and previews fines for many loans at once: the calendar of each branch is read once. `today` gives
 * the day to count to for a branch (the loan branch's today).
 */
export class FinePreviewer {
  readonly #db: Db;
  readonly #skip: boolean;
  readonly #closed = new Map<string, (d: string) => boolean>();

  private constructor(db: Db, skip: boolean) {
    this.#db = db;
    this.#skip = skip;
  }

  static async open(db: Db): Promise<FinePreviewer> {
    return new FinePreviewer(db, await finesSkipClosedDays(db));
  }

  /** The days late of a loan due `dueOn` at `until` (its branch's calendar when closed days are skipped). */
  async lateDays(branchId: string, dueOn: string, until: string): Promise<number> {
    if (until <= dueOn) return 0;
    if (!this.#skip) return Math.max(0, diffDays(dueOn, until));
    let closed = this.#closed.get(branchId);
    if (closed === undefined) {
      closed = closedBy(await loadClosedDayRules(this.#db, branchId));
      this.#closed.set(branchId, closed);
    }
    return countOpenDays(closed, dueOn, until);
  }

  /** How late `loan` (its branch, due date and fine terms) is at `until`, and what its fine counts then. */
  async lateness(loan: { branchId: string; dueOn: string } & FineTerms, until: string): Promise<Lateness> {
    const daysLate = until <= loan.dueOn ? 0 : Math.max(0, diffDays(loan.dueOn, until));
    if (daysLate === 0 || loan.finePerDayMinor <= 0) return { daysLate, finedDays: null, fineMinor: 0 };
    const days = await this.lateDays(loan.branchId, loan.dueOn, until);
    const fineMinor = overdueFineMinor(days, loan);
    return { daysLate, finedDays: fineMinor === 0 ? null : days, fineMinor };
  }

  /** The preview of `loan` at `until`: null when it is not late or its fine is 0. */
  async preview(loan: PreviewLoan, until: string): Promise<FinePreview | null> {
    const late = await this.lateness(loan, until);
    return late.finedDays === null ? null : { amount: formatPrice(late.fineMinor), currency: loan.currency, days: late.finedDays };
  }
}
