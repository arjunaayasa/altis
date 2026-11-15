import { countGrouped, countRows, datePrefix, sumGrouped, type DB } from '@altis/db';
import { localDate } from '@altis/shared';
import type { CollectionStatistics, LoanStatistics, MemberStatistics, VisitStatistics } from '@altis/shared/api/library-statistics';
import { sql, type Kysely, type SqlBool } from 'kysely';
import { loadAccredSettings } from '../../settings/accreditation.js';
import { dueBeforeSql } from '../circulation/common.js';
import { liveItemSql, stockTitleSql } from '../collection/common.js';
import { libraryTimeZone } from '../runs/service.js';

// The library's figures at a glance for the dashboard (the shapes and their routes: @altis/shared/api/library-statistics).
// Each is a handful of counts over the live rows, by the rules the reports use for the same figures: the stock of
// today as the collection reports read it, people visiting by head count without voided visits, loans without voided
// ones; days are the library's (a loan is overdue by its own branch's day).

/** Today and its year in the library's time zone. */
async function todayOf(db: Kysely<DB>, now: number): Promise<{ today: string; year: number }> {
  const today = localDate(await libraryTimeZone(db), now);
  return { today, year: Number(today.slice(0, 4)) };
}

/** The twelve monthly values of `year` from groups keyed by month `m` (`YYYY-MM`). */
function byMonthOf(year: number, groups: readonly { m: string | number | null; value: number }[]): number[] {
  const out = Array.from({ length: 12 }, () => 0);
  for (const g of groups) {
    const m = /^(\d{4})-(\d{2})/.exec(String(g.m));
    if (m === null || Number(m[1]) !== year) continue;
    out[Number(m[2]) - 1]! += g.value;
  }
  return out;
}

/** The titles and copies in the stock today, and the copies received this year. */
export async function libraryCollectionStatistics(db: Kysely<DB>, now: number): Promise<CollectionStatistics> {
  const { today, year } = await todayOf(db, now);
  const electronic = (await loadAccredSettings(db)).electronicMaterialTypeCodes;
  const copies = () =>
    db
      .selectFrom('items as i')
      .innerJoin('records as r', 'r.id', 'i.record_id')
      .where(liveItemSql('i', today))
      .where('r.archived_at', 'is', null);
  const received = sql<string>`coalesce(i.received_date, i.input_on, '')`;
  return {
    today,
    year,
    titles: await countRows(db.selectFrom('records as r').where(stockTitleSql('r', today, { branchId: null }, electronic))),
    items: await countRows(copies()),
    receivedThisYear: await countRows(copies().where(received, '>=', `${year}-01-01`)),
  };
}

/** The members on the register, those valid today, and those who joined this year. */
export async function libraryMemberStatistics(db: Kysely<DB>, now: number): Promise<MemberStatistics> {
  const { today, year } = await todayOf(db, now);
  const live = () => db.selectFrom('members as m').where('m.archived_at', 'is', null).where('m.anonymized_at', 'is', null);
  return {
    today,
    year,
    registered: await countRows(live()),
    valid: await countRows(
      live()
        .where('m.status', '=', 'active')
        .where((eb) => eb.or([eb('m.expires_on', 'is', null), eb('m.expires_on', '>=', today)])),
    ),
    joinedThisYear: await countRows(live().where('m.joined_on', '>=', `${year}-01-01`).where('m.joined_on', '<=', today)),
  };
}

/** The people who visited this month, this year and per month of the year. */
export async function libraryVisitStatistics(db: Kysely<DB>, now: number): Promise<VisitStatistics> {
  const { today, year } = await todayOf(db, now);
  const groups = await sumGrouped(
    db.selectFrom('visits as v').where('v.visited_on', '>=', `${year}-01-01`).where('v.visited_on', '<=', `${year}-12-31`).where('v.voided_at', 'is', null),
    { m: datePrefix('v.visited_on', 'month') },
    'v.headcount',
  );
  const byMonth = byMonthOf(
    year,
    groups.map((g) => ({ m: g.m, value: g.sum })),
  );
  return { today, year, thisMonth: byMonth[Number(today.slice(5, 7)) - 1] ?? 0, thisYear: byMonth.reduce((a, b) => a + b, 0), byMonth };
}

/** The loans lent this month, this year and per month of the year; the open and the overdue loans. */
export async function libraryLoanStatistics(db: Kysely<DB>, now: number): Promise<LoanStatistics> {
  const { today, year } = await todayOf(db, now);
  const groups = await countGrouped(
    db
      .selectFrom('loans as l')
      .where('l.loaned_on', '>=', `${year}-01-01`)
      .where('l.loaned_on', '<=', `${year}-12-31`)
      .where(sql<SqlBool>`(l.outcome is null or l.outcome <> 'voided')`),
    { m: datePrefix('l.loaned_on', 'month') },
  );
  const byMonth = byMonthOf(
    year,
    groups.map((g) => ({ m: g.m, value: g.count })),
  );
  const tz = await libraryTimeZone(db);
  const branches = await db.selectFrom('branches').select(['id', 'timezone']).execute();
  const todays = new Map(branches.map((b) => [b.id, localDate(b.timezone || tz, now)]));
  const open = () => db.selectFrom('loans as l').where('l.open_item_id', 'is not', null);
  return {
    today,
    year,
    thisMonth: byMonth[Number(today.slice(5, 7)) - 1] ?? 0,
    thisYear: byMonth.reduce((a, b) => a + b, 0),
    byMonth,
    open: await countRows(open()),
    overdue: todays.size === 0 ? 0 : await countRows(open().where(dueBeforeSql(todays, -1))),
  };
}
