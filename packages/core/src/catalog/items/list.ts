import type { DB } from '@altis/db';
import type { AcqSource } from '@altis/shared';
import type { ItemDetail, ItemListItem, ItemListQuery, ItemListResponse, ItemLocationPath, ItemView } from '@altis/shared/api/catalog/items';
import type { Kysely, Transaction } from 'kysely';
import { readCustomValues } from '../data/custom-fields.js';
import { locationPaths, type LocationPath } from '../data/locations.js';
import { barcodeProblem, normalizeBarcode } from '../lib/barcode.js';
import { itemHistory } from './events.js';
import { itemStatusOf, loanability } from './lifecycle.js';
import { formatPrice, itemNotFound, itemValidationFailed } from './service.js';
import { suggestShelf } from './suggest.js';

// Reading items (Phase 2 spec §2.2, §2.5, §3.4, §12.2): one item with its history (getItem, itemByBarcode) and the
// admin list (listItems). Reads are not branch-scoped (`catalog.records.read` is global).
//
// - The view: the record's title, the branch, the location path (room › area › shelf), the shelf suggestion of an item
//   without a location (its call number, else the record's call number or classification; not stored), loanable and
//   self-service (§2.5), the price as a decimal string, the custom values. `callNumber` is the item's own (null: it
//   follows the record).
// - itemByBarcode normalises the raw text (spec §3.4) and checks it before any query, so a NUL or another character no
//   barcode can hold never reaches the database (PostgreSQL refuses NUL in a parameter): such text, or a valid ISBN, is
//   VALIDATION_FAILED at `barcode`.
// - The list is a keyset over `barcode_key` (the unique index), paged by the cursor `k.<last key>`. Filters: branch,
//   location (with the locations below it: a room lists the items of its shelves), status, collection type, record, and
//   a barcode prefix (normalised like a barcode, read as the key range `[prefix, prefix + DEL)`: every key is printable
//   ASCII, and a range uses the index where a LIKE would need an escape clause per dialect). A row's call number is the
//   item's, else its record's.

type Db = Kysely<DB> | Transaction<DB>;

const ID_BATCH = 500;
/** Every barcode key is 0x20-0x7E: a prefix followed by DEL sorts after every key that starts with it. */
const AFTER_ASCII = '\x7F';
const CURSOR = /^k\.([\x20-\x7E]{1,64})$/;

function pathView(p: LocationPath | undefined): ItemLocationPath | null {
  if (p === undefined) return null;
  return { roomId: p.roomId, roomName: p.roomName, areaName: p.areaName, shelfName: p.shelfName, shelfHint: p.shelfHint };
}

/** The views of the items `ids` that exist, in that order. */
async function itemViews(db: Db, ids: readonly string[]): Promise<ItemView[]> {
  const rows = await db
    .selectFrom('items as i')
    .innerJoin('records as r', 'r.id', 'i.record_id')
    .innerJoin('branches as b', 'b.id', 'i.branch_id')
    .innerJoin('collection_types as ct', 'ct.id', 'i.collection_type_id')
    .selectAll('i')
    .select([
      'r.title as record_title',
      'r.call_number as record_call_number',
      'r.classification as record_classification',
      'b.code_display as branch_code',
      'b.name as branch_name',
      'ct.loanable',
      'ct.self_service',
    ])
    .where('i.id', 'in', [...ids])
    .execute();
  const paths = await locationPaths(db, rows.flatMap((r) => (r.location_id === null ? [] : [r.location_id])));
  const custom = await readCustomValues(db, 'items', rows.map((r) => r.id));
  const views = new Map<string, ItemView>();
  for (const r of rows) {
    const callNumber = r.call_number ?? r.record_call_number ?? r.record_classification;
    const suggested = r.location_id === null && callNumber !== null ? await suggestShelf(db, r.branch_id, callNumber) : null;
    const status = itemStatusOf(r.status);
    views.set(r.id, {
      id: r.id,
      record: { id: r.record_id, title: r.record_title },
      branch: { id: r.branch_id, code: r.branch_code, name: r.branch_name },
      barcode: r.barcode_display,
      inventoryNo: r.inventory_no,
      callNumber: r.call_number,
      locationId: r.location_id,
      locationPath: r.location_id === null ? null : pathView(paths.get(r.location_id)),
      suggestedLocation: suggested,
      collectionTypeId: r.collection_type_id,
      status,
      statusNote: r.status_note,
      partsTotal: Number(r.parts_total),
      acqSource: r.acq_source as AcqSource | null,
      orderNo: r.order_no,
      orderDate: r.order_date,
      receivedDate: r.received_date,
      invoiceDate: r.invoice_date,
      supplierId: r.supplier_id,
      invoiceNo: r.invoice_no,
      price: r.price === null ? null : formatPrice(Number(r.price)),
      currency: r.currency,
      note: r.note,
      custom: custom.get(r.id) ?? {},
      ...loanability(status, r),
      archived: r.archived_at !== null,
      createdAt: Number(r.created_at),
      updatedAt: r.updated_at === null ? null : Number(r.updated_at),
      version: Number(r.version),
    });
  }
  return ids.flatMap((id) => {
    const v = views.get(id);
    return v === undefined ? [] : [v];
  });
}

/**
 * Item `id` with its history, newest first.
 *
 * @throws DomainError NOT_FOUND
 */
export async function getItem(db: Db, id: string): Promise<ItemDetail> {
  const [view] = await itemViews(db, [id]);
  if (view === undefined) throw itemNotFound();
  return { ...view, history: await itemHistory(db, id) };
}

/**
 * The item whose barcode is `raw` once normalised (spec §3.4), with its history.
 *
 * @throws DomainError VALIDATION_FAILED `{path: 'barcode', code: 'length' | 'charset' | 'isbn_not_barcode'}` for text no
 *   barcode can be (nothing is queried); NOT_FOUND when no item has it
 */
export async function itemByBarcode(db: Db, raw: string): Promise<ItemDetail> {
  const key = normalizeBarcode(raw);
  const problem = barcodeProblem(key);
  if (problem !== null) throw itemValidationFailed([{ path: 'barcode', code: problem }]);
  const row = await db.selectFrom('items').select('id').where('barcode_key', '=', key).executeTakeFirst();
  if (row === undefined) throw itemNotFound();
  return getItem(db, row.id);
}

/** `id` and the locations below it (at most two levels, §3.6), of its branch. */
async function locationAndBelow(db: Db, id: string): Promise<string[]> {
  const own = await db.selectFrom('locations').select('branch_id').where('id', '=', id).executeTakeFirst();
  if (own === undefined) return [id];
  const all = [id];
  let level = [id];
  for (let depth = 0; depth < 2 && level.length > 0; depth += 1) {
    const children: string[] = [];
    for (let i = 0; i < level.length; i += ID_BATCH) {
      const rows = await db
        .selectFrom('locations')
        .select('id')
        .where('branch_id', '=', own.branch_id)
        .where('parent_id', 'in', level.slice(i, i + ID_BATCH))
        .execute();
      for (const r of rows) if (!all.includes(r.id)) children.push(r.id);
    }
    all.push(...children);
    level = children;
  }
  return all;
}

function badCursor(): never {
  throw itemValidationFailed([{ path: 'cursor', code: 'invalid' }]);
}

/**
 * The statement of one page of the admin list: at most `q.limit + 1` items of `q` in barcode order, with their record's
 * title and call number and their branch's code. `locations` is the location of `q.locationId` with the locations
 * below it (locationAndBelow), or null without one.
 *
 * The page is chosen from `items` alone (filters, keyset, `ORDER BY barcode_key LIMIT`: the unique index), and the
 * record and the branch are joined to those rows only, which the outer ORDER BY then sorts again (at most a page).
 * Joined in one statement, MySQL and MariaDB start at the small `branches` table and sort every item (Phase 2 Task 39:
 * 693 ms p95 at 150 000 items on MariaDB 10.6).
 *
 * @throws DomainError VALIDATION_FAILED at `cursor` for a cursor that is not `k.<key>`
 */
export function itemListPageQuery(db: Db, q: ItemListQuery, locations: readonly string[] | null = null) {
  let page = db.selectFrom('items as p').select('p.id');
  if (q.branchId !== undefined) page = page.where('p.branch_id', '=', q.branchId);
  if (locations !== null) page = page.where('p.location_id', 'in', [...locations]);
  if (q.status !== undefined) page = page.where('p.status', '=', q.status);
  if (q.collectionTypeId !== undefined) page = page.where('p.collection_type_id', '=', q.collectionTypeId);
  if (q.recordId !== undefined) page = page.where('p.record_id', '=', q.recordId);
  if (q.barcodePrefix !== undefined) {
    const prefix = normalizeBarcode(q.barcodePrefix);
    page = page.where('p.barcode_key', '>=', prefix).where('p.barcode_key', '<', `${prefix}${AFTER_ASCII}`);
  }
  if (q.cursor !== undefined) {
    const after = CURSOR.exec(q.cursor)?.[1];
    if (after === undefined || after.trim() !== after) badCursor();
    page = page.where('p.barcode_key', '>', after);
  }
  return db
    .selectFrom(page.orderBy('p.barcode_key').limit(q.limit + 1).as('pg'))
    .innerJoin('items as i', 'i.id', 'pg.id')
    .innerJoin('records as r', 'r.id', 'i.record_id')
    .innerJoin('branches as b', 'b.id', 'i.branch_id')
    .select([
      'i.id',
      'i.barcode_display',
      'i.barcode_key',
      'i.record_id',
      'r.title as record_title',
      'i.branch_id',
      'b.code_display as branch_code',
      'i.location_id',
      'i.call_number',
      'r.call_number as record_call_number',
      'i.collection_type_id',
      'i.status',
      'i.archived_at',
      'i.version',
    ])
    .orderBy('i.barcode_key');
}

/** The admin list of items (see the top of this file). */
export async function listItems(db: Db, q: ItemListQuery): Promise<ItemListResponse> {
  const limit = q.limit;
  const locations = q.locationId === undefined ? null : await locationAndBelow(db, q.locationId);
  const rows = await itemListPageQuery(db, q, locations).execute();
  const page = rows.slice(0, limit);
  const paths = await locationPaths(db, page.flatMap((r) => (r.location_id === null ? [] : [r.location_id])));
  const items: ItemListItem[] = page.map((r) => ({
    id: r.id,
    barcode: r.barcode_display,
    record: { id: r.record_id, title: r.record_title },
    branch: { id: r.branch_id, code: r.branch_code },
    locationPath: r.location_id === null ? null : pathView(paths.get(r.location_id)),
    callNumber: r.call_number ?? r.record_call_number,
    collectionTypeId: r.collection_type_id,
    status: itemStatusOf(r.status),
    archived: r.archived_at !== null,
    version: Number(r.version),
  }));
  const last = page[page.length - 1];
  return { items, nextCursor: rows.length > limit && last !== undefined ? `k.${last.barcode_key}` : null };
}
