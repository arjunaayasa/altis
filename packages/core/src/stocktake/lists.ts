import { DomainError, isUlid, type StocktakeResult, type StocktakeState } from '@altis/shared';
import type {
  StocktakeItemView,
  StocktakeItemsQuery,
  StocktakeItemsResponse,
  StocktakeOfficersResponse,
  StocktakeUnknownQuery,
  StocktakeUnknownResponse,
} from '@altis/shared/api/stocktake';
import { sessionNotFound, type Db } from './common.js';

// The lists of a session: its copies by state (pending, on loan, found, misplaced, unexpected) or by officer, keyset
// paged by copy id; the unknown codes, paged by code; and the counts per officer. A session named by id must be of the
// branch in the path (else 404, as one that does not exist).

async function ownSession(db: Db, branchId: string, id: string): Promise<void> {
  const row = await db.selectFrom('stocktakes').select('id').where('id', '=', id).where('branch_id', '=', branchId).executeTakeFirst();
  if (row === undefined) throw sessionNotFound();
}

function badCursor(): DomainError {
  return new DomainError('VALIDATION_FAILED', { detail: 'Kursor tidak valid / The cursor is not valid', meta: { errors: [{ path: 'cursor', code: 'invalid' }] } });
}

/** The copies of the session `id` (see the top of this file). @throws DomainError NOT_FOUND, VALIDATION_FAILED (`cursor`) */
export async function listStocktakeItems(db: Db, branchId: string, id: string, q: StocktakeItemsQuery): Promise<StocktakeItemsResponse> {
  await ownSession(db, branchId, id);
  if (q.cursor !== undefined && !isUlid(q.cursor)) throw badCursor();
  let sel = db
    .selectFrom('stocktake_items as s')
    .innerJoin('items as i', 'i.id', 's.item_id')
    .innerJoin('records as r', 'r.id', 'i.record_id')
    .leftJoin('locations as el', 'el.id', 's.expected_location_id')
    .leftJoin('locations as sl', 'sl.id', 's.scanned_location_id')
    .leftJoin('collection_types as ct', 'ct.id', 's.collection_type_id')
    .leftJoin('staff_users as u', 'u.id', 's.scanned_by')
    .select([
      's.item_id',
      's.expected',
      's.state',
      's.expected_location_id',
      'el.name as expected_location_name',
      's.scanned_location_id',
      'sl.name as scanned_location_name',
      's.expected_status',
      'i.status as current_status',
      's.stat_ddc',
      's.collection_type_id',
      'ct.name_id as collection_type_name',
      's.scanned_at',
      's.scanned_by',
      'u.name as scanned_by_name',
      's.scanned_by_name as migrated_name',
      's.result',
      'i.barcode_display',
      'i.call_number',
      'r.call_number as record_call_number',
      'r.title',
    ])
    .where('s.stocktake_id', '=', id);
  if (q.state !== undefined) sel = sel.where('s.state', '=', q.state);
  if (q.scannedBy !== undefined) sel = sel.where('s.scanned_by', '=', q.scannedBy);
  if (q.cursor !== undefined) sel = sel.where('s.item_id', '>', q.cursor);
  const rows = await sel.orderBy('s.item_id').limit(q.limit + 1).execute();
  const page = rows.slice(0, q.limit);
  const items: StocktakeItemView[] = page.map((r) => ({
    itemId: r.item_id,
    barcode: r.barcode_display,
    title: r.title,
    callNumber: r.call_number ?? r.record_call_number,
    expected: Number(r.expected) === 1,
    state: r.state as StocktakeState,
    expectedLocation: r.expected_location_id === null ? null : { id: r.expected_location_id, name: r.expected_location_name ?? '?' },
    scannedLocation: r.scanned_location_id === null ? null : { id: r.scanned_location_id, name: r.scanned_location_name ?? '?' },
    expectedStatus: r.expected_status,
    currentStatus: r.current_status,
    statDdc: r.stat_ddc,
    collectionType: r.collection_type_id === null ? null : { id: r.collection_type_id, name: r.collection_type_name ?? '?' },
    scannedAt: r.scanned_at === null ? null : Number(r.scanned_at),
    scannedBy: r.scanned_by !== null ? { id: r.scanned_by, name: r.scanned_by_name ?? '?' } : r.migrated_name !== null ? { id: '', name: r.migrated_name } : null,
    result: r.result as StocktakeResult | null,
  }));
  return { items, nextCursor: rows.length > q.limit ? (page[page.length - 1]?.item_id ?? null) : null };
}

/** The unknown codes of the session `id`, by code. @throws DomainError NOT_FOUND */
export async function listStocktakeUnknown(db: Db, branchId: string, id: string, q: StocktakeUnknownQuery): Promise<StocktakeUnknownResponse> {
  await ownSession(db, branchId, id);
  let sel = db
    .selectFrom('stocktake_unknown_codes as c')
    .leftJoin('staff_users as u', 'u.id', 'c.scanned_by')
    .select(['c.code_key', 'c.code_display', 'c.first_at', 'c.last_at', 'c.seen', 'c.scanned_by', 'u.name'])
    .where('c.stocktake_id', '=', id);
  if (q.cursor !== undefined) sel = sel.where('c.code_key', '>', q.cursor);
  const rows = await sel.orderBy('c.code_key').limit(q.limit + 1).execute();
  const page = rows.slice(0, q.limit);
  return {
    items: page.map((r) => ({
      code: r.code_display,
      firstAt: Number(r.first_at),
      lastAt: Number(r.last_at),
      seen: Number(r.seen),
      scannedBy: r.scanned_by === null ? null : { id: r.scanned_by, name: r.name ?? '?' },
    })),
    nextCursor: rows.length > q.limit ? (page[page.length - 1]?.code_key ?? null) : null,
  };
}

/** What each officer scanned in the session (found, misplaced, unexpected), most first. */
export async function stocktakeOfficers(db: Db, id: string): Promise<StocktakeOfficersResponse> {
  const rows = await db
    .selectFrom('stocktake_items as s')
    .leftJoin('staff_users as u', 'u.id', 's.scanned_by')
    .select(['s.scanned_by', 's.scanned_by_name', 'u.name', 's.state'])
    .select((eb) => eb.fn.countAll<number>().as('n'))
    .where('s.stocktake_id', '=', id)
    .where('s.state', 'in', ['found', 'misplaced', 'unexpected'])
    .groupBy(['s.scanned_by', 's.scanned_by_name', 'u.name', 's.state'])
    .execute();
  const by = new Map<string, { id: string | null; name: string; found: number; misplaced: number; unexpected: number }>();
  for (const r of rows) {
    const key = r.scanned_by ?? `name:${r.scanned_by_name ?? ''}`;
    const o = by.get(key) ?? { id: r.scanned_by, name: r.name ?? r.scanned_by_name ?? '?', found: 0, misplaced: 0, unexpected: 0 };
    const n = Number(r.n);
    if (r.state === 'found') o.found += n;
    else if (r.state === 'misplaced') {
      o.found += n;
      o.misplaced += n;
    } else o.unexpected += n;
    by.set(key, o);
  }
  return { items: [...by.values()].sort((a, b) => b.found + b.unexpected - (a.found + a.unexpected) || a.name.localeCompare(b.name)) };
}

/** The session of `branchId` named `id`, or 404. */
export async function assertStocktakeOfBranch(db: Db, branchId: string, id: string): Promise<void> {
  await ownSession(db, branchId, id);
}
