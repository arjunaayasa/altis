import { countGrouped, type DB } from '@altis/db';
import { sql, type Kysely, type Transaction } from 'kysely';

// What the OPAC says about a title's copies on a card, a result row and the record page: whether a copy can be taken
// home from the shelf now ("Tersedia", or "Tersedia 1 dari 3" when not every copy can), else when the first copy on
// loan is due back, else that the copies are for use in the library only, else that none is on the shelf. Never who
// holds a copy: the loans are read for their due dates only.
//
// The copies counted are those the OPAC lists (not archived, not withdrawn or lost: the public load of a record). Each
// is in exactly one state, decided in this order:
//   loan     it has an open loan (its catalogue status stays `available` while it is out);
//   held     it is kept on a hold shelf for a member;
//   shelf    `available`, and its collection type may be lent;
//   library  `not_for_loan`, or `available` in a collection type that is not lent (a reference copy);
//   other    anything else (on order, being processed, under repair, missing).
// `shelfCounts` decides it in SQL for the copies of many titles at once (one grouped read per page), `copyShelfState`
// in code for the copies a record page already loaded; the two follow the same order.

type Db = Kysely<DB> | Transaction<DB>;

/** The state of one copy (see the top of this file). */
export type CopyShelfState = 'loan' | 'held' | 'shelf' | 'library' | 'other';

/** The copies of one title per state, and the earliest due date of those on loan (`YYYY-MM-DD`). */
export interface ShelfCounts {
  shelf: number;
  library: number;
  loan: number;
  held: number;
  other: number;
  earliestDue: string | null;
}

/** What a card says of a title with copies (a title without any says nothing). */
export type ShelfStatus =
  | { kind: 'available'; shelf: number; total: number }
  | { kind: 'on_loan'; dueOn: string }
  | { kind: 'library_use' }
  | { kind: 'unavailable' };

/** The state of a copy from its status, whether its collection type is lent, and its loan and hold. */
export function copyShelfState(copy: { status: string; collectionLoanable: boolean; onLoan: boolean; kept: boolean }): CopyShelfState {
  if (copy.onLoan) return 'loan';
  if (copy.kept) return 'held';
  if (copy.status === 'available' && copy.collectionLoanable) return 'shelf';
  if (copy.status === 'not_for_loan' || copy.status === 'available') return 'library';
  return 'other';
}

/** No copy in any state. */
export function emptyShelfCounts(): ShelfCounts {
  return { shelf: 0, library: 0, loan: 0, held: 0, other: 0, earliestDue: null };
}

/** `counts` with one more copy in `state` (due on `dueOn` when on loan). */
export function addShelfCopy(counts: ShelfCounts, state: CopyShelfState, dueOn: string | null): ShelfCounts {
  const next = { ...counts, [state]: counts[state] + 1 };
  if (state === 'loan' && dueOn !== null && (next.earliestDue === null || dueOn < next.earliestDue)) next.earliestDue = dueOn;
  return next;
}

/** What a card says for `counts` (see {@link ShelfStatus}); null for a title without copies. */
export function shelfStatusOf(counts: ShelfCounts): ShelfStatus | null {
  const total = counts.shelf + counts.library + counts.loan + counts.held + counts.other;
  if (total === 0) return null;
  if (counts.shelf > 0) return { kind: 'available', shelf: counts.shelf, total };
  if (counts.loan > 0 && counts.earliestDue !== null) return { kind: 'on_loan', dueOn: counts.earliestDue };
  if (counts.library > 0) return { kind: 'library_use' };
  return { kind: 'unavailable' };
}

/** The state of a copy as SQL (the order of {@link copyShelfState}); literals only, so GROUP BY repeats it as is. */
const STATE_SQL = sql<string>`CASE WHEN ${sql.ref('l.id')} IS NOT NULL THEN 'loan' WHEN ${sql.ref('h.id')} IS NOT NULL THEN 'held' WHEN ${sql.ref('i.status')} = 'available' AND ${sql.ref('ct.loanable')} = 1 THEN 'shelf' WHEN ${sql.ref('i.status')} IN ('available', 'not_for_loan') THEN 'library' ELSE 'other' END`;

/** At most this many titles per read (a page of results is at most 50). */
const IDS_MAX = 500;

/**
 * The copies of each of `recordIds` per state, with the earliest due date of those on loan: one grouped read of the
 * copies with their open loan and hold for all of them (per record, state and due date). A title without copies is
 * absent from the map. No member is read.
 */
export async function shelfCounts(db: Db, recordIds: readonly string[]): Promise<Map<string, ShelfCounts>> {
  const out = new Map<string, ShelfCounts>();
  const ids = [...new Set(recordIds)];
  for (let i = 0; i < ids.length; i += IDS_MAX) {
    const rows = await countGrouped(
      db
        .selectFrom('items as i')
        .innerJoin('collection_types as ct', 'ct.id', 'i.collection_type_id')
        .leftJoin('loans as l', 'l.open_item_id', 'i.id')
        .leftJoin('holds as h', 'h.trap_item_id', 'i.id')
        .where('i.record_id', 'in', ids.slice(i, i + IDS_MAX))
        .where('i.archived_at', 'is', null)
        .where('i.status', 'not in', ['withdrawn', 'lost']),
      { recordId: 'i.record_id', state: STATE_SQL, dueOn: 'l.due_on' },
    );
    for (const row of rows) {
      const id = String(row.recordId);
      const state = String(row.state) as CopyShelfState;
      const counts = out.get(id) ?? emptyShelfCounts();
      // CHAR(10): PostgreSQL may pad; a due date is always ten characters.
      const due = row.dueOn === null ? null : String(row.dueOn).trim();
      const next = { ...counts, [state]: counts[state] + row.count };
      if (state === 'loan' && due !== null && (next.earliestDue === null || due < next.earliestDue)) next.earliestDue = due;
      out.set(id, next);
    }
  }
  return out;
}

/** {@link shelfCounts} as what each card says (a title without copies is absent). */
export async function shelfStatuses(db: Db, recordIds: readonly string[]): Promise<Map<string, ShelfStatus>> {
  const out = new Map<string, ShelfStatus>();
  for (const [id, counts] of await shelfCounts(db, recordIds)) {
    const status = shelfStatusOf(counts);
    if (status !== null) out.set(id, status);
  }
  return out;
}
