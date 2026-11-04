import type { DB } from '@altis/db';
import { DomainError, ITEM_EVENT_TYPES, ITEM_STATUSES, newId, type ItemEventType, type ItemStatus } from '@altis/shared';
import type { ItemEventView } from '@altis/shared/api/catalog/items';
import type { Kysely, Transaction } from 'kysely';
import type { TxCtx } from '../../context.js';

// The history of items (`item_events`, Phase 2 spec §2.2, §3.4): every change of an item writes rows here, in the
// transaction of the change: `created` (or `imported`/`migrated`) when it is made, `status` when its status changes
// (`archived` when it becomes withdrawn), `moved` when its location changes, `updated` for the other fields. `meta`
// names the changed fields only, never their values; `actor_type`/`actor_id` are the transaction's actor.

/** One row to write. */
export interface ItemEventInput {
  itemId: string;
  type: ItemEventType;
  fromStatus?: ItemStatus | null;
  toStatus?: ItemStatus | null;
  fromLocationId?: string | null;
  toLocationId?: string | null;
  /** The API names of the changed fields. */
  fields?: readonly string[];
}

/** Rows per INSERT (12 columns: far below every engine's parameter limit). */
const INSERT_BATCH = 500;

/** The most history rows one read answers (newest first). */
export const ITEM_HISTORY_MAX = 500;

type Db = Kysely<DB> | Transaction<DB>;

/** Writes `events` at `tx.now`, as `tx.actor`, in their order. */
export async function writeItemEvents(tx: TxCtx, events: readonly ItemEventInput[]): Promise<void> {
  const rows = events.map((e) => ({
    id: newId(tx.now),
    item_id: e.itemId,
    at: tx.now,
    type: e.type,
    from_status: e.fromStatus ?? null,
    to_status: e.toStatus ?? null,
    from_location_id: e.fromLocationId ?? null,
    to_location_id: e.toLocationId ?? null,
    actor_type: tx.actor.type,
    actor_id: tx.actor.id,
    meta: JSON.stringify({ fields: [...(e.fields ?? [])] }),
  }));
  for (let i = 0; i < rows.length; i += INSERT_BATCH) {
    await tx.trx.insertInto('item_events').values(rows.slice(i, i + INSERT_BATCH)).execute();
  }
}

/** A stored status, or null for one this version does not know. */
function statusOrNull(v: string | null): ItemStatus | null {
  return v !== null && (ITEM_STATUSES as readonly string[]).includes(v) ? (v as ItemStatus) : null;
}

/** The field names of a stored `meta`: `[]` when it holds none or cannot be read. */
function fieldsOf(meta: string): string[] {
  try {
    const parsed = JSON.parse(meta) as { fields?: unknown };
    return Array.isArray(parsed.fields) ? parsed.fields.filter((f): f is string => typeof f === 'string') : [];
  } catch {
    return [];
  }
}

/**
 * The history of item `id`, newest first (at most {@link ITEM_HISTORY_MAX} rows); rows of a type this version does not
 * know are left out.
 *
 * @throws DomainError NOT_FOUND when there is no such item
 */
export async function itemHistory(db: Db, id: string): Promise<ItemEventView[]> {
  const item = await db.selectFrom('items').select('id').where('id', '=', id).executeTakeFirst();
  if (item === undefined) throw new DomainError('NOT_FOUND', { detail: 'Eksemplar tidak ditemukan / Item not found' });
  const rows = await db
    .selectFrom('item_events')
    .selectAll()
    .where('item_id', '=', id)
    .orderBy('at', 'desc')
    .orderBy('id', 'desc')
    .limit(ITEM_HISTORY_MAX)
    .execute();
  return rows
    .filter((r) => (ITEM_EVENT_TYPES as readonly string[]).includes(r.type))
    .map((r) => ({
      id: r.id,
      at: Number(r.at),
      type: r.type as ItemEventType,
      fromStatus: statusOrNull(r.from_status),
      toStatus: statusOrNull(r.to_status),
      fromLocationId: r.from_location_id,
      toLocationId: r.to_location_id,
      actorType: r.actor_type,
      actorId: r.actor_id,
      fields: fieldsOf(r.meta),
    }));
}
