import { assertOutsideTx, countDistinctGrouped, countGrouped, withTx, type DB, type DbHandle } from '@altis/db';
import { sql, type Kysely, type SqlBool, type Transaction } from 'kysely';
import type { ReportsHousekeepingStep } from '../reports/housekeeping/index.js';
import { POPULAR_WINDOW_DAYS } from './popular.js';

// The loans per class of the OPAC home page ("the classes that read most"): which classes borrowed most over the last
// year, with their number of loans and of different titles. Counts only: the block never names a member, and a class
// shows only when enough different members of it borrowed, so no single reader's borrowing can be read off it. The
// block is off until a library switches it on (opac.home's blocks).
//
// - The daily reports housekeeping rebuilds `opac_class_activity` (step `class_activity`) from the loans lent in the
//   last POPULAR_WINDOW_DAYS days (a voided loan not counted), grouped by the class the loan's statistics snapshot names
//   (`loans.stat_class_name`, kept after a member is anonymised; a loan without one is not counted). Class names that
//   differ only in letter case are one class (grouped by `lower()` in the database, the same on every engine); the name
//   shown is the spelling most of its loans carry.
// - A class is kept only when at least CLASS_MIN_BORROWERS different members borrowed in it; a loan whose borrower was
//   anonymised counts as a loan but not as a borrower. The member ids never leave the database: the distinct borrowers
//   and titles are counted by `count(DISTINCT …)` and only the counts come back. At most CLASS_ACTIVITY_KEEP classes,
//   the most loans first (ties by name), numbered from 1 in `place`.
// - The rebuild replaces the whole table in one transaction, so a reader sees the old ranking or the new one.

/** A class is kept only when this many different members of it borrowed in the window. */
export const CLASS_MIN_BORROWERS = 5;
/** At most this many classes are kept. */
export const CLASS_ACTIVITY_KEEP = 20;

const DAY_MS = 86_400_000;

type Db = Kysely<DB> | Transaction<DB>;

/** The loans that count, lent from `since` on, with a class in their snapshot. */
function countedLoans(db: Db, since: number) {
  return db
    .selectFrom('loans as l')
    .where('l.loaned_at', '>=', since)
    .where(sql<SqlBool>`(l.outcome is null or l.outcome <> 'voided')`)
    .where('l.stat_class_name', 'is not', null)
    .where('l.stat_class_name', '<>', '');
}

/** The group of a loan's class: its name in lower case, as the database folds it. */
const classGroup = () => sql<string>`lower(${sql.ref('l.stat_class_name')})`;

/** One class as the home page shows it. */
export interface ClassActivity {
  /** 1 for the class with the most loans. */
  place: number;
  className: string;
  loans: number;
  titles: number;
}

/**
 * Rebuilds `opac_class_activity` as of `now` (see the top of this file). Call it outside any transaction.
 *
 * @returns how many classes the aggregate holds now
 */
export async function refreshClassActivity(h: DbHandle, now: number): Promise<{ classes: number }> {
  assertOutsideTx('refreshClassActivity');
  if (!Number.isSafeInteger(now) || now < 0) throw new TypeError('refreshClassActivity: now must be an epoch-ms integer');
  const since = now - POPULAR_WINDOW_DAYS * DAY_MS;
  const [loans, titles, borrowers, spellings] = await Promise.all([
    countGrouped(countedLoans(h.db, since), { group: classGroup() }),
    countDistinctGrouped(countedLoans(h.db, since), { group: classGroup() }, 'l.record_id'),
    countDistinctGrouped(countedLoans(h.db, since), { group: classGroup() }, 'l.member_id'),
    countGrouped(countedLoans(h.db, since), { group: classGroup(), name: 'l.stat_class_name' }),
  ]);
  const titlesOf = new Map(titles.map((t) => [String(t.group), t.count]));
  const borrowersOf = new Map(borrowers.map((b) => [String(b.group), b.count]));
  // The name of each group: its most used spelling (ties: the first in code-point order).
  const nameOf = new Map<string, { name: string; count: number }>();
  for (const s of spellings) {
    const group = String(s.group);
    const name = String(s.name);
    const best = nameOf.get(group);
    if (best === undefined || s.count > best.count || (s.count === best.count && name < best.name)) nameOf.set(group, { name, count: s.count });
  }

  const kept: Omit<ClassActivity, 'place'>[] = [];
  for (const g of loans) {
    const group = String(g.group);
    const name = nameOf.get(group)?.name;
    if (name === undefined || (borrowersOf.get(group) ?? 0) < CLASS_MIN_BORROWERS) continue;
    kept.push({ className: name, loans: g.count, titles: titlesOf.get(group) ?? 0 });
  }
  kept.sort((a, b) => b.loans - a.loans || (a.className < b.className ? -1 : a.className > b.className ? 1 : 0));
  const rows = kept.slice(0, CLASS_ACTIVITY_KEEP).map((c, i) => ({ place: i + 1, class_name: c.className, loans: c.loans, titles: c.titles, refreshed_at: now }));
  await withTx(h, async (trx) => {
    await trx.deleteFrom('opac_class_activity').execute();
    if (rows.length > 0) await trx.insertInto('opac_class_activity').values(rows).execute();
  });
  return { classes: rows.length };
}

/** The first `n` classes of the aggregate, the most loans first. */
export async function topClasses(db: Db, n: number): Promise<ClassActivity[]> {
  if (!Number.isSafeInteger(n) || n <= 0) return [];
  const rows = await db.selectFrom('opac_class_activity').select(['place', 'class_name', 'loans', 'titles']).orderBy('place').limit(n).execute();
  return rows.map((r) => ({ place: Number(r.place), className: r.class_name, loans: Number(r.loans), titles: Number(r.titles) }));
}

/** The step `class_activity` of `reports.housekeeping`: the daily rebuild. Age-based (its window follows the clock). */
export const classActivityStep: ReportsHousekeepingStep = Object.freeze<ReportsHousekeepingStep>({
  name: 'class_activity',
  ageBased: true,
  async run(c) {
    await refreshClassActivity(c.h, c.now);
    return { done: true, cursor: null };
  },
});
