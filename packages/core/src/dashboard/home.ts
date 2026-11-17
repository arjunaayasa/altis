import { countDistinctGrouped, countGrouped, countRows, type DB } from '@altis/db';
import { DDC_MAINS, addDays, isoWeekday, localDate } from '@altis/shared';
import type { OpacHomeContent } from '@altis/shared/api/opac-home';
import {
  DASHBOARD_DUE_SOON_DAYS,
  DASHBOARD_EXPIRING_DAYS,
  DASHBOARD_LONG_OVERDUE_DAYS,
  DASHBOARD_TOP_TITLES,
  DASHBOARD_USAGE_DAYS,
  type DeskDashboard,
  type DeskHour,
  type LibraryDashboard,
  type SubjectLoans,
  type TopTitle,
} from '@altis/shared/api/dashboard-home';
import { sql, type Kysely, type SqlBool } from 'kysely';
import { can, type Grants } from '../authz/grants.js';
import { circulationDaySummary } from '../circulation/day-summary.js';
import { branchTimeZone } from '../circulation/dates.js';
import { libraryTimeZone } from '../members/common.js';
import { classIndexOf, dueBeforeSql } from '../reports/circulation/common.js';
// ---- Komunitas (staff screens' data) ----
import { closedBy, loadClosedDayRules } from '../circulation/calendars.js';
import { readSettings } from '../settings/service.js';

// The library figures of Beranda (the shapes and their routes: @altis/shared/api/dashboard-home). Counts only, a
// handful of cheap reads each, by the rules the circulation summary and the reports use for the same figures: a voided
// loan never counts, a loan's dates are its own branch's, a loan keeps the class it had when it was lent (`stat_ddc`).
//
// The desk's hours: the instants of today's loans and returns at the branch are read as they are (UTC epoch ms) and
// put into the local hours of the branch's time zone here, in code, so every engine gives the same hours and no
// engine's date functions or time zone tables are involved. Only these numbers leave the function.

type Db = Kysely<DB>;

const HOUR_FORMATTERS = new Map<string, Intl.DateTimeFormat>();

/** The local hour (0–23) of the instant `epochMs` in the IANA time zone `timeZone`. */
export function dashboardLocalHour(timeZone: string, epochMs: number): number {
  let formatter = HOUR_FORMATTERS.get(timeZone);
  if (formatter === undefined) {
    formatter = new Intl.DateTimeFormat('en-US', { timeZone, hour: '2-digit', hourCycle: 'h23', numberingSystem: 'latn' });
    HOUR_FORMATTERS.set(timeZone, formatter);
  }
  const hour = Number(formatter.formatToParts(epochMs).find((p) => p.type === 'hour')?.value);
  // Some engines print midnight as 24 even with h23.
  return Number.isInteger(hour) ? hour % 24 : 0;
}

/** All 24 local hours, each with the loans and returns of `loanTimes` and `returnTimes` that fall in it. */
export function dashboardHours(timeZone: string, loanTimes: readonly number[], returnTimes: readonly number[]): DeskHour[] {
  const hours: DeskHour[] = Array.from({ length: 24 }, (_, hour) => ({ hour, loans: 0, returns: 0 }));
  for (const at of loanTimes) hours[dashboardLocalHour(timeZone, at)]!.loans += 1;
  for (const at of returnTimes) hours[dashboardLocalHour(timeZone, at)]!.returns += 1;
  return hours;
}

/** A loan (alias `l`) that was not voided. */
const notVoided = sql<SqlBool>`(l.outcome is null or l.outcome <> 'voided')`;

/** Today at the desk's branch `branchId` (see `DeskDashboard`). */
export async function deskDashboard(db: Db, branchId: string, now: number): Promise<DeskDashboard> {
  const timeZone = await branchTimeZone(db, branchId);
  const summary = await circulationDaySummary(db, branchId, now);
  const on = summary.on;
  const weekAgo = addDays(on, -7);
  const lent = (day: string) => db.selectFrom('loans as l').where('l.loaned_on', '=', day).where('l.branch_id', '=', branchId).where(notVoided);
  const given = (day: string) =>
    db.selectFrom('loans as l').where('l.returned_on', '=', day).where('l.return_branch_id', '=', branchId).where('l.outcome', '=', 'returned');
  const [loanTimes, returnTimes, loanedWeekAgo, returnedWeekAgo, overdueMembers, holdsToClear] = await Promise.all([
    lent(on).select('l.loaned_at').execute(),
    given(on).select('l.returned_at').execute(),
    countRows(lent(weekAgo)),
    countRows(given(weekAgo)),
    countDistinctGrouped(
      db.selectFrom('loans as l').where('l.open_item_id', 'is not', null).where('l.due_on', '<', on).where('l.branch_id', '=', branchId),
      {},
      'l.member_id',
    ),
    countRows(
      db
        .selectFrom('holds as h')
        .where('h.pickup_branch_id', '=', branchId)
        .where((eb) =>
          eb.or([
            eb.and([eb('h.status', '=', 'ready'), eb('h.pickup_until', '<', on)]),
            eb.and([eb('h.status', 'in', ['expired', 'cancelled']), eb('h.ready_at', 'is not', null), eb('h.shelf_cleared_at', 'is', null)]),
          ]),
        ),
    ),
  ]);
  const hours = dashboardHours(
    timeZone,
    loanTimes.map((r) => Number(r.loaned_at)),
    returnTimes.flatMap((r) => (r.returned_at === null ? [] : [Number(r.returned_at)])),
  );
  return {
    branchId,
    on,
    timeZone,
    weekAgo,
    loaned: summary.loaned,
    returned: summary.returned,
    loanedWeekAgo,
    returnedWeekAgo,
    overdue: summary.overdue,
    overdueMembers: overdueMembers[0]?.count ?? 0,
    holdsReady: summary.holdsReady,
    holdsToClear,
    hours,
  };
}

/** The members section of the library dashboard. */
async function membersSection(db: Db, today: string): Promise<NonNullable<LibraryDashboard['members']>> {
  const valid = () =>
    db
      .selectFrom('members as m')
      .where('m.archived_at', 'is', null)
      .where('m.anonymized_at', 'is', null)
      .where('m.status', '=', 'active')
      .where((eb) => eb.or([eb('m.expires_on', 'is', null), eb('m.expires_on', '>=', today)]));
  const [active, joinedThisMonth, expiringSoon] = await Promise.all([
    countRows(valid()),
    countRows(
      db
        .selectFrom('members as m')
        .where('m.archived_at', 'is', null)
        .where('m.anonymized_at', 'is', null)
        .where('m.joined_on', '>=', `${today.slice(0, 7)}-01`)
        .where('m.joined_on', '<=', today),
    ),
    countRows(valid().where('m.expires_on', '<=', addDays(today, DASHBOARD_EXPIRING_DAYS))),
  ]);
  return { active, joinedThisMonth, expiringSoon };
}

/** The open loans more than DASHBOARD_LONG_OVERDUE_DAYS days past their due date, each by its own branch's today. */
async function longOverdue(db: Db, now: number, tz: string): Promise<number> {
  const branches = await db.selectFrom('branches').select(['id', 'timezone']).execute();
  if (branches.length === 0) return 0;
  const todays = new Map(branches.map((b) => [b.id, localDate(b.timezone || tz, now)]));
  return countRows(db.selectFrom('loans as l').where('l.open_item_id', 'is not', null).where(dueBeforeSql(todays, -(DASHBOARD_LONG_OVERDUE_DAYS + 1))));
}

// ---- Komunitas (staff screens' data) ----

/** The open loans due from today to DASHBOARD_DUE_SOON_DAYS days ahead, each by its own branch's today. */
async function dueSoon(db: Db, now: number, tz: string): Promise<number> {
  const branches = await db.selectFrom('branches').select(['id', 'timezone']).execute();
  if (branches.length === 0) return 0;
  const todays = new Map(branches.map((b) => [b.id, localDate(b.timezone || tz, now)]));
  return countRows(
    db
      .selectFrom('loans as l')
      .where('l.open_item_id', 'is not', null)
      .where(dueBeforeSql(todays, DASHBOARD_DUE_SOON_DAYS))
      .where(dueBeforeSql(todays, -1, '>')),
  );
}

/**
 * Today's opening hours as the public home page computes them: the rows of the OPAC home hours whose weekdays hold
 * today's, unless the library calendar closes today (library-wide rules). Null without such a row or with the home
 * page's visit block off.
 */
export async function openingHoursToday(db: Db, today: string): Promise<LibraryDashboard['openToday']> {
  const home = (await readSettings(db, ['opac.home'], []))['opac.home'] as OpacHomeContent | null;
  if (home === null || home.blocks.visit === false) return null;
  const weekday = isoWeekday(today);
  const rows = home.hours.filter((h) => h.weekdays.includes(weekday));
  if (rows.length === 0) return null;
  if (closedBy(await loadClosedDayRules(db, null))(today)) return { times: [], closed: true };
  return { times: rows.map((h) => h.time), closed: false };
}

/** The usage section of the library dashboard: the loans of the last DASHBOARD_USAGE_DAYS days by class and title. */
async function usageSection(db: Db, today: string): Promise<Usage> {
  const from = addDays(today, -(DASHBOARD_USAGE_DAYS - 1));
  const lent = () => db.selectFrom('loans as l').where('l.loaned_on', '>=', from).where('l.loaned_on', '<=', today).where(notVoided);
  const [byClass, byRecord] = await Promise.all([
    countGrouped(lent(), { d: 'l.stat_ddc' }),
    countGrouped(lent().innerJoin('records as r', 'r.id', 'l.record_id'), { id: 'r.id', t: 'r.title' }),
  ]);
  const perMain = DDC_MAINS.map(() => 0);
  for (const g of byClass) {
    const k = classIndexOf(g.d === null ? null : String(g.d));
    perMain[k] = (perMain[k] ?? 0) + g.count;
  }
  const bySubject: SubjectLoans[] = DDC_MAINS.map((main, k) => ({ main, loans: perMain[k] ?? 0 }))
    .filter((s) => s.loans > 0)
    .sort((a, b) => b.loans - a.loans || DDC_MAINS.indexOf(a.main) - DDC_MAINS.indexOf(b.main));
  const topTitles: TopTitle[] = byRecord
    .map((g) => ({ recordId: String(g.id), title: g.t === null ? '' : String(g.t), loans: g.count }))
    .sort((a, b) => b.loans - a.loans || a.title.localeCompare(b.title) || a.recordId.localeCompare(b.recordId))
    .slice(0, DASHBOARD_TOP_TITLES);
  return { from, to: today, bySubject, topTitles };
}

/** How long (ms) a process keeps the usage section of a day before it reads it again. */
export const DASHBOARD_USAGE_TTL_MS = 5 * 60_000;

type Usage = NonNullable<LibraryDashboard['usage']>;

/** The usage section read per database: the day it is of, the instant it was read at, and the read (shared while pending). */
const usageCache = new WeakMap<object, { today: string; at: number; value: Promise<Usage> }>();

/**
 * {@link usageSection}, kept for {@link DASHBOARD_USAGE_TTL_MS} per database and day: it groups a month of loans by
 * class and by title, Beranda polls it every minute in every open tab, and its figures barely move within minutes. It
 * is the same for every caller (the permission is checked before). A failed read is not kept; a clock that went back
 * reads again.
 */
function cachedUsageSection(db: Db, today: string, now: number): Promise<Usage> {
  const hit = usageCache.get(db);
  if (hit !== undefined && hit.today === today && now >= hit.at && now - hit.at < DASHBOARD_USAGE_TTL_MS) return hit.value;
  const value = usageSection(db, today);
  usageCache.set(db, { today, at: now, value });
  value.catch(() => {
    if (usageCache.get(db)?.value === value) usageCache.delete(db);
  });
  return value;
}

/** The library dashboard for a caller holding `grants` (see `LibraryDashboard`): each section only for its readers. */
export async function libraryDashboard(db: Db, grants: Grants, now: number): Promise<LibraryDashboard> {
  const tz = await libraryTimeZone(db);
  const today = localDate(tz, now);
  const readsLoans = can(grants, 'circulation.records.read');
  const [members, overdue, usage, soon, openToday] = await Promise.all([
    can(grants, 'members.records.read') ? membersSection(db, today) : null,
    readsLoans ? longOverdue(db, now, tz) : null,
    can(grants, 'reports.statistics.read') ? cachedUsageSection(db, today, now) : null,
    readsLoans ? dueSoon(db, now, tz) : null,
    openingHoursToday(db, today),
  ]);
  return { today, members, loans: overdue === null ? null : { longOverdue: overdue, dueSoon: soon ?? 0 }, usage, openToday };
}
