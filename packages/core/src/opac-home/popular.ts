import { assertOutsideTx, countDistinctGrouped, countGrouped, sumGrouped, withTx, type DB, type DbHandle } from '@altis/db';
import { sql, type Kysely, type SqlBool, type Transaction } from 'kysely';
import type { ReportsHousekeepingStep } from '../reports/housekeeping/index.js';

// The OPAC's popular titles: the titles lent most over the last year, which the home page lists and the catalogue's
// "most borrowed" order follows. They come from one small aggregate, `opac_popular_titles`, that holds per branch and
// title the number of loans and nothing else: no borrower, no date of a single loan.
//
// - The daily reports housekeeping rebuilds it (step `popular_titles`): the loans lent in the last 365 days (a voided
//   loan not counted) of titles the OPAC shows (visible, not archived, not merged), counted per title and branch in
//   the database. A title is kept only when at least POPULAR_MIN_BORROWERS different members borrowed it at that
//   branch, so no title is listed on the strength of one reader; a loan whose borrower was anonymised counts as a loan
//   but not as a borrower. At most POPULAR_KEEP_PER_BRANCH titles per branch, the most lent first.
// - The member ids never leave the database: the distinct borrowers are counted by `count(DISTINCT member_id)` and
//   only the counts come back. The rebuild replaces the whole table in one transaction, so a reader sees the old list
//   or the new one.
// - Reading it, the titles are checked against the OPAC again (one may have been hidden since the rebuild). The home
//   page sums a title's branches; a search filtered to branches sums those branches only.

/** The loans of this many days up to the rebuild count. */
export const POPULAR_WINDOW_DAYS = 365;
/** A title is kept only when this many different members borrowed it at the branch. */
export const POPULAR_MIN_BORROWERS = 3;
/** At most this many titles per branch are kept. */
export const POPULAR_KEEP_PER_BRANCH = 500;

const DAY_MS = 86_400_000;
/** Rows inserted per statement. */
const INSERT_BATCH = 200;

type Db = Kysely<DB> | Transaction<DB>;

/** The loans that count, of titles the OPAC shows, lent from `since` on. */
function countedLoans(db: Db, since: number) {
  return db
    .selectFrom('loans as l')
    .innerJoin('records as r', 'r.id', 'l.record_id')
    .where('l.loaned_at', '>=', since)
    .where(sql<SqlBool>`(l.outcome is null or l.outcome <> 'voided')`)
    .where('r.opac_visible', '=', 1)
    .where('r.archived_at', 'is', null)
    .where('r.merged_into', 'is', null);
}

/** One row of the aggregate. */
interface PopularRow {
  record_id: string;
  branch_id: string;
  loans: number;
  refreshed_at: number;
}

/**
 * Rebuilds `opac_popular_titles` as of `now` (see the top of this file). Call it outside any transaction.
 *
 * @returns how many rows the aggregate holds now
 */
export async function refreshPopularTitles(h: DbHandle, now: number): Promise<{ titles: number }> {
  assertOutsideTx('refreshPopularTitles');
  if (!Number.isSafeInteger(now) || now < 0) throw new TypeError('refreshPopularTitles: now must be an epoch-ms integer');
  const since = now - POPULAR_WINDOW_DAYS * DAY_MS;
  const keys = { recordId: 'l.record_id', branchId: 'l.branch_id' } as const;
  const loans = await countGrouped(countedLoans(h.db, since), keys);
  const borrowers = await countDistinctGrouped(countedLoans(h.db, since), keys, 'l.member_id');
  const borrowersOf = new Map(borrowers.map((b) => [`${String(b.recordId)} ${String(b.branchId)}`, b.count]));

  const byBranch = new Map<string, PopularRow[]>();
  for (const g of loans) {
    const recordId = String(g.recordId);
    const branchId = String(g.branchId);
    if ((borrowersOf.get(`${recordId} ${branchId}`) ?? 0) < POPULAR_MIN_BORROWERS) continue;
    const list = byBranch.get(branchId) ?? [];
    list.push({ record_id: recordId, branch_id: branchId, loans: g.count, refreshed_at: now });
    byBranch.set(branchId, list);
  }
  const rows: PopularRow[] = [];
  for (const list of byBranch.values()) {
    list.sort((a, b) => b.loans - a.loans || (a.record_id < b.record_id ? -1 : a.record_id > b.record_id ? 1 : 0));
    rows.push(...list.slice(0, POPULAR_KEEP_PER_BRANCH));
  }
  await withTx(h, async (trx) => {
    await trx.deleteFrom('opac_popular_titles').execute();
    for (let at = 0; at < rows.length; at += INSERT_BATCH) {
      await trx.insertInto('opac_popular_titles').values(rows.slice(at, at + INSERT_BATCH)).execute();
    }
  });
  return { titles: rows.length };
}

/**
 * The ids of the `n` popular titles the OPAC shows, the most lent first (a title's loans summed over its branches;
 * ties by id).
 */
export async function popularRecordIds(db: Db, n: number): Promise<string[]> {
  if (!Number.isSafeInteger(n) || n <= 0) return [];
  const q = db
    .selectFrom('opac_popular_titles as p')
    .innerJoin('records as r', 'r.id', 'p.record_id')
    .where('r.opac_visible', '=', 1)
    .where('r.archived_at', 'is', null)
    .where('r.merged_into', 'is', null);
  const sums = await sumGrouped(q, { recordId: 'p.record_id' }, 'p.loans');
  return sums
    .map((s) => ({ id: String(s.recordId), loans: s.sum }))
    .sort((a, b) => b.loans - a.loans || (a.id < b.id ? -1 : a.id > b.id ? 1 : 0))
    .slice(0, n)
    .map((s) => s.id);
}

/** The step `popular_titles` of `reports.housekeeping`: the daily rebuild. Age-based (its window follows the clock). */
export const popularTitlesStep: ReportsHousekeepingStep = Object.freeze<ReportsHousekeepingStep>({
  name: 'popular_titles',
  ageBased: true,
  async run(c) {
    await refreshPopularTitles(c.h, c.now);
    return { done: true, cursor: null };
  },
});
