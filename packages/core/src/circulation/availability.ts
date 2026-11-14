import { fullTextFamily, type DB } from '@altis/db';
import { DomainError } from '@altis/shared';
import type { ItemCirculation } from '@altis/shared/api/catalog/items';
import type { Kysely, Transaction } from 'kysely';
import { keptItems } from './holds.js';

// Which items are on loan. "On loan" is not an item status: an item keeps its catalogue status (`available`) while a
// loan of it is open, and the open loan (`loans.open_item_id`) says it is out. The search index (facet `av`), the OPAC
// availability table, the admin, the catalogue's item writers and the SLiMS catalogue re-sync read it from here.

type Db = Kysely<DB> | Transaction<DB>;

const ID_BATCH = 500;

/**
 * The open loans of the items `itemIds`: item id → its due date. `lock` makes it a locking read (`FOR UPDATE`; not on
 * SQLite, which has one writer): it sees the latest commit even after a plain read started the transaction's snapshot
 * (MySQL/MariaDB), for a writer that took its item locks after such a read.
 */
export async function openLoanDueDates(db: Db, itemIds: readonly string[], o: { lock?: boolean } = {}): Promise<Map<string, string>> {
  const out = new Map<string, string>();
  const unique = [...new Set(itemIds)];
  const lock = o.lock === true && fullTextFamily(db) !== 'fts5';
  for (let i = 0; i < unique.length; i += ID_BATCH) {
    const q = db
      .selectFrom('loans')
      .select(['open_item_id', 'due_on'])
      .where('open_item_id', 'in', unique.slice(i, i + ID_BATCH));
    for (const r of await (lock ? q.forUpdate() : q).execute()) if (r.open_item_id !== null) out.set(r.open_item_id, r.due_on);
  }
  return out;
}

/**
 * The circulation state of each of the items `itemIds`: on loan, else kept on a hold shelf (`on_hold`), else
 * `{state: null}`.
 */
export async function itemCirculation(db: Db, itemIds: readonly string[]): Promise<Map<string, ItemCirculation>> {
  const out = new Map<string, ItemCirculation>();
  const unique = [...new Set(itemIds)];
  for (const id of unique) out.set(id, { state: null });
  // ---- Komunitas (holds) ----
  for (const [id, k] of await keptItems(db, unique)) out.set(id, { state: 'on_hold', holdId: k.holdId, ...(k.pickupUntil === null ? {} : { pickupUntil: k.pickupUntil }) });
  for (let i = 0; i < unique.length; i += ID_BATCH) {
    const rows = await db
      .selectFrom('loans')
      .select(['id', 'open_item_id', 'due_on'])
      .where('open_item_id', 'in', unique.slice(i, i + ID_BATCH))
      .execute();
    for (const r of rows) if (r.open_item_id !== null) out.set(r.open_item_id, { state: 'on_loan', dueOn: r.due_on, loanId: r.id });
  }
  return out;
}

/**
 * The guard of the catalogue's item writers: an item with an open loan keeps its status and stays live until it is
 * returned (a change of location or collection type is still allowed).
 *
 * @throws DomainError CIRC_ITEM_ON_LOAN when the item `itemId` has an open loan
 */
export async function refuseItemOnLoan(db: Db, itemId: string): Promise<void> {
  if ((await openLoanDueDates(db, [itemId])).size === 0) return;
  throw new DomainError('CIRC_ITEM_ON_LOAN', {
    detail: 'Eksemplar ini sedang dipinjam; kembalikan dahulu / This item is on loan; return it first',
    meta: { sameMember: false, reason: 'other_member' },
  });
}
