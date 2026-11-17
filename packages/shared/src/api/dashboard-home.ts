/**
 * The library figures of Beranda, beside the system dashboard (`@altis/shared/api/dashboard`). Counts only: no
 * person, no member number, no borrower in any of them. No Node built-ins here: the browser bundles this module.
 * Import it as `@altis/shared/api/dashboard-home`.
 *
 * - `GET branches/:branchId/dashboard` (`circulation.desk.use` at the branch) → {@link DeskDashboard}: today at the
 *   desk's branch, in the branch's time zone (the library's for a branch without one).
 * - `GET dashboard/library` (any signed-in staff user) → {@link LibraryDashboard}: each section only for a holder of
 *   the permission of its data, null otherwise.
 */
import type { DdcMain } from '../ddc.js';

/** "Memberships ending soon": a valid membership whose last day is today or within this many days. */
export const DASHBOARD_EXPIRING_DAYS = 14;

/** "Long overdue": an open loan more than this many days past its due date (in its own branch's calendar). */
export const DASHBOARD_LONG_OVERDUE_DAYS = 14;

/** The loans by subject and the most borrowed titles cover the loans lent in this many days up to today. */
export const DASHBOARD_USAGE_DAYS = 30;

/** How many of the most borrowed titles the dashboard lists. */
export const DASHBOARD_TOP_TITLES = 5;

/**
 * One hour of today at the desk's branch: the loans lent there and the copies given back there whose time falls in
 * the local hour `hour` (0–23) of the branch's time zone.
 */
export interface DeskHour {
  hour: number;
  loans: number;
  returns: number;
}

/**
 * `GET branches/:branchId/dashboard`. `on` is today at the branch and `weekAgo` the same weekday a week before.
 * `loaned` counts the loans lent there today (a voided one not), `returned` the copies given back there today, and the
 * `*WeekAgo` figures the same on `weekAgo`; `overdue` the open loans of the branch due before today and
 * `overdueMembers` the members who hold them; `holdsReady` the holds kept on its shelf for pickup, `holdsToClear` the
 * copies on its shelf whose hold is past its pickup date, expired or cancelled. `hours` holds all 24 local hours of
 * today, in order; their loans add up to `loaned` and their returns to `returned`.
 */
export interface DeskDashboard {
  branchId: string;
  on: string;
  timeZone: string;
  weekAgo: string;
  loaned: number;
  returned: number;
  loanedWeekAgo: number;
  returnedWeekAgo: number;
  overdue: number;
  overdueMembers: number;
  holdsReady: number;
  holdsToClear: number;
  hours: DeskHour[];
}

/** Loans of one DDC main class (the class the loan kept when it was lent). */
export interface SubjectLoans {
  main: DdcMain;
  loans: number;
}

/** One of the most borrowed titles: the record, its title and how often it was lent. */
export interface TopTitle {
  recordId: string;
  title: string;
  loans: number;
}

/**
 * `GET dashboard/library`. `today` is the library's day.
 *
 * - `members` (`members.records.read`): members whose membership is valid today, those who joined this month, and the
 *   valid ones whose membership ends within {@link DASHBOARD_EXPIRING_DAYS} days;
 * - `loans` (`circulation.records.read`): open loans more than {@link DASHBOARD_LONG_OVERDUE_DAYS} days overdue, at
 *   every branch;
 * - `usage` (`reports.statistics.read`): the loans lent from `from` to `to` ({@link DASHBOARD_USAGE_DAYS} days, every
 *   branch, voided ones not) by DDC main class (the classes with a loan, most first) and the
 *   {@link DASHBOARD_TOP_TITLES} most borrowed titles (most first, ties by title).
 */
export interface LibraryDashboard {
  today: string;
  members: { active: number; joinedThisMonth: number; expiringSoon: number } | null;
  loans: { longOverdue: number } | null;
  usage: { from: string; to: string; bySubject: SubjectLoans[]; topTitles: TopTitle[] } | null;
}
