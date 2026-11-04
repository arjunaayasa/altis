import type { DB } from '@altis/db';
import type { Kysely, Transaction } from 'kysely';
import { classInRange, classNumberKey } from '../lib/class-number.js';

// The shelf suggestion (Phase 2 spec §3.4): an item without a location is offered (never given) the shelf of its branch
// whose call-number range holds the class of its call number, `class_from <= class <= class_to` over the normalised
// leading number (classInRange: exact decimal comparison). Of several, the narrowest range wins, then the shelf first
// by sort order and code.

type Db = Kysely<DB> | Transaction<DB>;

/** The hint of a location that has none: its name cut to 40 code points (§3.6, as locationPaths does). */
const SHELF_HINT_MAX = 40;

/**
 * The live shelf of `branchId` whose class range contains the class of `callNumber`, the narrowest first; null when
 * the call number holds no number or no range contains it.
 */
export async function suggestShelf(db: Db, branchId: string, callNumber: string): Promise<{ id: string; name: string; shelfHint: string | null } | null> {
  if (classNumberKey(callNumber) === null) return null;
  const shelves = await db
    .selectFrom('locations')
    .select(['id', 'name', 'shelf_hint', 'class_from', 'class_to', 'sort_order', 'code_key'])
    .where('branch_id', '=', branchId)
    .where('kind', '=', 'shelf')
    .where('archived_at', 'is', null)
    .where('class_from', 'is not', null)
    .where('class_to', 'is not', null)
    .execute();
  let best: { row: (typeof shelves)[number]; width: number } | null = null;
  for (const row of shelves) {
    const from = row.class_from as string;
    const to = row.class_to as string;
    if (!classInRange(callNumber, from, to)) continue;
    const width = (classNumberKey(to) ?? 0) - (classNumberKey(from) ?? 0);
    const better =
      best === null ||
      width < best.width ||
      (width === best.width &&
        (Number(row.sort_order) < Number(best.row.sort_order) || (Number(row.sort_order) === Number(best.row.sort_order) && row.code_key < best.row.code_key)));
    if (better) best = { row, width };
  }
  if (best === null) return null;
  const { row } = best;
  return { id: row.id, name: row.name, shelfHint: row.shelf_hint ?? (Array.from(row.name).slice(0, SHELF_HINT_MAX).join('').trimEnd() || null) };
}
