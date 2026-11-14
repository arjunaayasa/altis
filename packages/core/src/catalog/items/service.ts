import { fullTextFamily, type DB } from '@altis/db';
import { DomainError, isDomainError, newId, type ItemStatus } from '@altis/shared';
import type { FieldWarning } from '@altis/shared/api/catalog/common';
import { ItemCreateBody, ItemPatchBody } from '@altis/shared/api/catalog/items';
import { issueCode } from '@altis/shared/api/common';
import type { Kysely, Selectable, Transaction, Updateable } from 'kysely';
import type { z } from 'zod';
import type { AuditInput, TxCtx } from '../../context.js';
import { refuseItemOnLoan } from '../../circulation/availability.js';
import { publish } from '../../events/publish.js';
import { indexRecords } from '../../search/index-records.js';
import { readSettings } from '../../settings/service.js';
import { customValuesSchema, loadCustomDefs, readCustomValues, writeCustomValues, type CustomFieldDef } from '../data/custom-fields.js';
import { barcodeProblem, normalizeBarcode } from '../lib/barcode.js';
import { writeItemEvents, type ItemEventInput } from './events.js';
import { archivedAtAfter, checkTransition, itemStatusOf, ARCHIVED_STATUS } from './lifecycle.js';

// Saving items (Phase 2 spec §2.2 `items`, §2.5, §3.2, §3.4; plan Task 17). Every write path of an
// item goes through here or through batch.ts/bulk.ts, which share these helpers: the API, imports (`bulk` mode,
// `imported` events) and anything else that adds an item.
//
// - Items are branch-scoped (D2-02): the write routes name the branch in their path, and an item of another branch
//   is NOT_FOUND. A location must be one of the item's branch (`{path: 'locationId', code: 'invalid'}`); moving an
//   item to another branch is Phase 6.
// - A body is parsed again with the strict contract (ItemCreateBody / ItemPatchBody), so a body an importer builds
//   meets the API's rules, and everything is checked before anything is written, in one VALIDATION_FAILED: the record
//   (`not_found`, `archived`), the barcode, the collection type, the location, the supplier and the custom values.
// - The barcode (§3.4): normalizeBarcode, then barcodeProblem (`length`, `charset`, `isbn_not_barcode`),
//   then unique across branches (`taken`, checked with a SELECT: a UNIQUE_VIOLATION would abort a PostgreSQL
//   transaction). `barcode_display` and `barcode_key` both hold the normal form (P2-08: `'b 00  12'` → `'B 00 12'`). An
//   INSERT or UPDATE that still meets the unique index (a concurrent writer committed the same key after the check,
//   which a MySQL/MariaDB REPEATABLE READ snapshot may not show) is thrown as TX_CONFLICT, so the caller's withTx runs
//   the whole transaction again (R37) and its check then sees the key (as enqueue does for its unique key).
// - A price is a decimal string with at most 2 decimals; it is stored in minor units (`money()`, exponent 2, §3.4) with
//   its currency, by default `catalog.currency`. No price, no currency.
// - Status changes follow ITEM_TRANSITIONS (lifecycle.ts); a change to `withdrawn` archives the item. An item with an
//   open loan keeps its status and is not archived until it is returned (CIRC_ITEM_ON_LOAN). An item leaving
//   `withdrawn` is live again, so what it points to must be live too (reviveErrors; §3.1: an archived record has no
//   live item, and the archives of a location, a collection type and a supplier counted no withdrawn item): its record
//   (`{path: 'status', code: 'record_archived'}`), and the collection type, location and supplier it keeps (`archived`
//   at that field; a value the same change replaces is checked as the new one, a cleared one not at all).
// - Every change writes `item_events` (events.ts), sets the record's `changed_at` when the public side of the item
//   changed (barcode, call number, location, collection type, status; §2.1), indexes the record (`indexRecords`, §4.1)
//   and, in `interactive` mode, audits (`catalog.item.*`, `meta.fields`: names only) and publishes
//   `catalog.item.changed {id, recordId}` as the transaction's last statements. `bulk` mode (imports) leaves the audit
//   and the event to its caller.
// - Concurrency: an update or an archive first locks the item's row with a write that changes nothing, then its
//   record's row the same way (lockItemRecords, C05), both before its first plain read, so writers of one item
//   serialise, the record's index document is built after any record save of it committed and, on MySQL/MariaDB, the
//   reads after it see the latest commit when the locks are the transaction's first statements; `version` is then
//   compared (CONFLICT_STALE) and bumped. An update's lock matches only the version it was sent (lockItemAt): the WHERE
//   of an UPDATE reads the latest commit on every engine, while a transaction that read before (an import batch: its
//   MySQL/MariaDB snapshot predates the lock, and a write that changes nothing does not refresh it) would read the item
//   as it was. So an item changed meanwhile is CONFLICT_STALE before its custom values are written. A create first
//   locks its record's row with a write that matches only a live record (lockLiveRecord), so it cannot add an item to
//   a record that an archive or a merge running at the same time is taking away, nor to one an archive or a merge
//   committed after its transaction's snapshot (an import batch).
// - The collection type, the location and the supplier an item is given are locked the same way, by a write that
//   matches only a live row (lockLiveMaster, lockLiveLocation; Task 40 T17-KUNCI-LOKASI-SAAT-PENEMPATAN, T12
//   concern 1): their archive locks the row first and then counts the live items there, so it waits for an item
//   saved against the live row and counts it, and an item saved after the archive committed is refused (`archived`).
//   Every item writer takes its locks in one order, the items, then their records, then those masters, so two writers
//   never wait on each other in a circle.
// - Empty texts are stored as null.

type Db = Kysely<DB> | Transaction<DB>;
export type ItemRow = Selectable<DB['items']>;

/** How an item is saved: `interactive` audits and publishes; `bulk` (imports) leaves both to the caller. */
export interface ItemSaveOptions {
  mode?: 'interactive' | 'bulk';
  /** The history row of the new item: `created` (default), `imported`, `migrated`. */
  eventType?: 'created' | 'imported' | 'migrated';
}

const ID_BATCH = 500;
const CREATE_EVENTS: readonly string[] = ['created', 'imported', 'migrated'];

/** The API fields whose change shows on the public side of the record (OPAC, OAI, search facets). */
const PUBLIC_FIELDS: ReadonlySet<string> = new Set(['barcode', 'callNumber', 'locationId', 'collectionTypeId', 'status']);

// ---- errors ----------------------------------------------------------------------------------------------------------

export function itemValidationFailed(errors: readonly FieldWarning[]): DomainError {
  return new DomainError('VALIDATION_FAILED', { detail: 'Data eksemplar tidak valid / The item data is not valid', meta: { errors: [...errors] } });
}

export function itemNotFound(): DomainError {
  return new DomainError('NOT_FOUND', { detail: 'Eksemplar tidak ditemukan / Item not found' });
}

function itemStale(): DomainError {
  return new DomainError('CONFLICT_STALE', {
    detail: 'Eksemplar sudah diubah orang lain; muat ulang / The item was changed by someone else; reload it',
  });
}

/** The issues of a failed parse as field errors (`path` dot-joined, D10). */
function issuesToErrors(issues: readonly z.core.$ZodIssue[]): FieldWarning[] {
  return issues.map((issue) => ({ path: issue.path.map(String).join('.'), code: issueCode(issue) }));
}

/** `body` parsed with `schema`, or VALIDATION_FAILED with its issues. */
export function parseItemBody<T>(schema: z.ZodType<T>, body: unknown): T {
  const parsed = schema.safeParse(body);
  if (!parsed.success) throw itemValidationFailed(issuesToErrors(parsed.error.issues));
  return parsed.data;
}

/** A UNIQUE_VIOLATION of `write` (the barcode's unique index, met after the check) as TX_CONFLICT: run it all again. */
export async function againOnBarcodeRace<T>(write: () => Promise<T>): Promise<T> {
  try {
    return await write();
  } catch (error) {
    if (!isDomainError(error) || error.code !== 'UNIQUE_VIOLATION') throw error;
    throw new DomainError('TX_CONFLICT', {
      detail:
        'Barkod yang sama baru saja disimpan oleh permintaan lain; transaksi diulang / The same barcode was just stored by ' +
        'another request; the transaction is run again',
      meta: { attempts: 1, code: 'ITEM_BARCODE_TAKEN' },
    });
  }
}

// ---- values ----------------------------------------------------------------------------------------------------------

/** '' (or blank) as null; any other text as it is. */
function textOrNull(v: string | null | undefined): string | null {
  if (v === undefined || v === null) return null;
  return v.trim() === '' ? null : v;
}

const PRICE = /^(\d{1,13})(?:\.(\d{1,2}))?$/;

/** A decimal price (`'125000.00'`, at most 2 decimals) in minor units (`12500000`), or null when it is not one. */
export function parsePrice(text: string): number | null {
  const m = PRICE.exec(text);
  if (m === null) return null;
  return Number(m[1]) * 100 + Number((m[2] ?? '').padEnd(2, '0'));
}

/** Minor units as the decimal string of the API (`12500000` → `'125000.00'`). */
export function formatPrice(minor: number): string {
  const n = Math.trunc(Number(minor));
  return `${Math.trunc(n / 100)}.${String(n % 100).padStart(2, '0')}`;
}

/** The default currency (`catalog.currency`). */
async function defaultCurrency(db: Db): Promise<string> {
  return (await readSettings(db, ['catalog.currency'], []))['catalog.currency'] as string;
}

// ---- checks ----------------------------------------------------------------------------------------------------------

/** @throws DomainError NOT_FOUND unless `branchId` names a live branch */
export async function checkBranch(db: Db, branchId: string): Promise<void> {
  const row = await db.selectFrom('branches').select('archived_at').where('id', '=', branchId).executeTakeFirst();
  if (row === undefined || row.archived_at !== null) throw new DomainError('NOT_FOUND', { detail: 'Cabang tidak ditemukan / Branch not found' });
}


/** Locks the item rows `ids` of `branchId` with a write that changes nothing (one statement, in index order). */
export async function lockItemRows(trx: Transaction<DB>, branchId: string, ids: readonly string[]): Promise<void> {
  const unique = [...new Set(ids)];
  for (let i = 0; i < unique.length; i += ID_BATCH) {
    await trx
      .updateTable('items')
      .set((eb) => ({ version: eb.ref('version') }))
      .where('id', 'in', unique.slice(i, i + ID_BATCH))
      .where('branch_id', '=', branchId)
      .execute();
  }
}

/**
 * Locks the item `id` of `branchId` with a write that changes nothing and matches only while the item holds `version`;
 * whether it matched (mysql2 counts matched rows: CLIENT_FOUND_ROWS). The UPDATE's WHERE reads the latest commit and
 * waits for a writer of the row (see the top of this file).
 */
async function lockItemAt(trx: Transaction<DB>, branchId: string, id: string, version: number): Promise<boolean> {
  const locked = await trx
    .updateTable('items')
    .set((eb) => ({ version: eb.ref('version') }))
    .where('id', '=', id)
    .where('branch_id', '=', branchId)
    .where('version', '=', version)
    .executeTakeFirst();
  return Number(locked.numUpdatedRows) === 1;
}

/**
 * Locks the record rows of the items `ids` of `branchId` with a write that changes nothing (C05): an item update, an
 * archive or a bulk change runs it right after its item lock (lockItemAt, lockItemRows) and before its first plain
 * read, so the record's index document it writes is built from the latest commit (on MySQL/MariaDB the snapshot starts
 * at that first plain read), never from one a record save committed meanwhile. The record ids come from a locking read
 * (FOR UPDATE; SQLite has one writer), which sees the latest commit and starts no snapshot; the item locks keep
 * `record_id` fixed until the commit. The records are then locked by their id list, never by an UPDATE with a subquery:
 * MariaDB before 11.1 runs that as a dependent subquery over the whole `records` table and keeps every row locked until
 * the COMMIT.
 */
export async function lockItemRecords(trx: Transaction<DB>, branchId: string, ids: readonly string[]): Promise<void> {
  const unique = [...new Set(ids)];
  const locking = fullTextFamily(trx) !== 'fts5';
  for (let i = 0; i < unique.length; i += ID_BATCH) {
    const q = trx.selectFrom('items').select('record_id').where('id', 'in', unique.slice(i, i + ID_BATCH)).where('branch_id', '=', branchId);
    const rows = await (locking ? q.forUpdate() : q).execute();
    const recordIds = [...new Set(rows.map((r) => r.record_id))].sort();
    if (recordIds.length === 0) continue;
    await trx
      .updateTable('records')
      .set((eb) => ({ version: eb.ref('version') }))
      .where('id', 'in', recordIds)
      .execute();
  }
}

/** The record's error at `recordId`: `not_found`, `archived` (a merged record is archived too); null when it is live. */
async function recordError(db: Db, id: string): Promise<FieldWarning | null> {
  const row = await db.selectFrom('records').select('archived_at').where('id', '=', id).executeTakeFirst();
  if (row === undefined) return { path: 'recordId', code: 'not_found' };
  return row.archived_at === null ? null : { path: 'recordId', code: 'archived' };
}

/**
 * Locks the record row `id` with a write that changes nothing and matches only a live record; null when it matched,
 * else the record's error at `recordId` (`not_found`, `archived`: a merged record is archived too). The WHERE of an
 * UPDATE reads the latest commit on every engine and waits for a writer of the row, so the answer holds wherever the
 * action runs in its transaction: a plain read after a lock that changes nothing still shows a MySQL/MariaDB
 * transaction's older snapshot (an import batch's), in which a record archived or merged meanwhile is live.
 */
export async function lockLiveRecord(trx: Transaction<DB>, id: string): Promise<FieldWarning | null> {
  const locked = await trx
    .updateTable('records')
    .set((eb) => ({ version: eb.ref('version') }))
    .where('id', '=', id)
    .where('archived_at', 'is', null)
    .executeTakeFirst();
  if (Number(locked.numUpdatedRows) === 1) return null;
  // None matched: the record is gone or archived; an older snapshot may still show it live.
  return (await recordError(trx, id)) ?? { path: 'recordId', code: 'archived' };
}

/** The masters an item names besides its location. */
export type ItemMaster = 'collection_types' | 'suppliers';

/** A master's error at `path`: `not_found`, `archived`; null when it is live. */
async function masterError(db: Db, table: ItemMaster, id: string, path: string): Promise<FieldWarning | null> {
  const row = await db
    .selectFrom(table as 'collection_types')
    .select('archived_at')
    .where('id', '=', id)
    .executeTakeFirst();
  if (row === undefined) return { path, code: 'not_found' };
  return row.archived_at === null ? null : { path, code: 'archived' };
}

/** A location's error at `path`: `invalid` (none, or of another branch), `archived`; null for a live one of the branch. */
async function locationError(db: Db, branchId: string, id: string, path: string): Promise<FieldWarning | null> {
  const row = await db.selectFrom('locations').select(['branch_id', 'archived_at']).where('id', '=', id).executeTakeFirst();
  if (row === undefined || row.branch_id !== branchId) return { path, code: 'invalid' };
  return row.archived_at === null ? null : { path, code: 'archived' };
}

/**
 * Locks the master row `id` of `table` with a write that changes nothing and matches only a live row; null when it
 * matched, else its error at `path` (`not_found`, `archived`). The master's archive (archiveMaster) locks the row first
 * and then counts the live items that use it, so the two serialize (see the top of this file); the UPDATE's WHERE
 * reads the latest commit (see lockLiveRecord).
 */
export async function lockLiveMaster(trx: Transaction<DB>, table: ItemMaster, id: string, path: string): Promise<FieldWarning | null> {
  // Both tables have `id`, `version` and `archived_at`; Kysely cannot narrow a union of table names.
  const locked = await trx
    .updateTable(table as 'suppliers')
    .set((eb) => ({ version: eb.ref('version') }))
    .where('id', '=', id)
    .where('archived_at', 'is', null)
    .executeTakeFirst();
  if (Number(locked.numUpdatedRows) === 1) return null;
  return (await masterError(trx, table, id, path)) ?? { path, code: 'archived' };
}

/**
 * Locks the location `id` of `branchId` with a write that changes nothing and matches only a live one (the form of
 * parentErrors in locations/service.ts); null when it matched, else its error at `path` (`invalid`: none, or of
 * another branch; `archived`). archiveLocation locks the row first and then counts the live items placed there, so
 * the two serialize (see the top of this file).
 */
export async function lockLiveLocation(trx: Transaction<DB>, branchId: string, id: string, path: string): Promise<FieldWarning | null> {
  const locked = await trx
    .updateTable('locations')
    .set((eb) => ({ version: eb.ref('version') }))
    .where('id', '=', id)
    .where('branch_id', '=', branchId)
    .where('archived_at', 'is', null)
    .executeTakeFirst();
  if (Number(locked.numUpdatedRows) === 1) return null;
  return (await locationError(trx, branchId, id, path)) ?? { path, code: 'archived' };
}

/** Whether an item other than `exceptId` holds barcode key `key`. */
export async function barcodeTaken(db: Db, key: string, exceptId?: string): Promise<boolean> {
  let q = db.selectFrom('items').select('id').where('barcode_key', '=', key);
  if (exceptId !== undefined) q = q.where('id', '<>', exceptId);
  return (await q.executeTakeFirst()) !== undefined;
}

/**
 * A raw barcode normalised (spec §3.4) and checked: `{key, error}`, the error at `path` being barcodeProblem's code
 * (`length`, `charset`, `isbn_not_barcode`) or `taken` (by an item other than `exceptId`). The database is asked only
 * once the text is a possible barcode (no NUL ever reaches a PostgreSQL parameter).
 */
export async function checkBarcode(db: Db, raw: string, path: string, exceptId?: string): Promise<{ key: string; error: FieldWarning | null }> {
  const key = normalizeBarcode(raw);
  const problem = barcodeProblem(key);
  if (problem !== null) return { key, error: { path, code: problem } };
  return { key, error: (await barcodeTaken(db, key, exceptId)) ? { path, code: 'taken' } : null };
}

/** The custom values of a body checked against the live item definitions (§3.7): errors at `<prefix>custom.<code>`. */
function checkCustom(
  defs: readonly CustomFieldDef[],
  custom: Record<string, unknown> | undefined,
  mode: 'create' | 'patch',
  prefix: string,
): { values: Record<string, unknown>; errors: FieldWarning[] } {
  const input = custom ?? {};
  const parsed = customValuesSchema(defs, mode).safeParse(input);
  if (parsed.success) return { values: parsed.data, errors: [] };
  const errors = parsed.error.issues.map((issue) => {
    const code = issue.path.length === 1 ? String(issue.path[0]) : null;
    const missing = code !== null && issue.code === 'invalid_type' && (!Object.hasOwn(input, code) || input[code] === null);
    return { path: [`${prefix}custom`, ...issue.path.map(String)].join('.'), code: missing ? 'required' : issueCode(issue) };
  });
  return { values: {}, errors };
}

/** Which of an item's references a change leaves as they are (and so are checked as they are). */
export interface KeptReferences {
  collectionType: boolean;
  location: boolean;
  supplier: boolean;
}

/**
 * The errors of bringing `row` back from `withdrawn` (see the top of this file): its record must be live, and so must
 * the references `keep` names that it holds. Each is locked while live (lockLiveRecord, lockLiveMaster,
 * lockLiveLocation; the record first, as every item writer takes them), so an archive of any of them running at the
 * same time serializes with the change: it waits and then counts the live item, or the change sees it archived.
 */
export async function reviveErrors(trx: Transaction<DB>, branchId: string, row: ItemRow, keep: KeptReferences): Promise<FieldWarning[]> {
  const errors: FieldWarning[] = [];
  if ((await lockLiveRecord(trx, row.record_id)) !== null) errors.push({ path: 'status', code: 'record_archived' });
  if (keep.collectionType) {
    const e = await lockLiveMaster(trx, 'collection_types', row.collection_type_id, 'collectionTypeId');
    if (e !== null) errors.push(e);
  }
  if (keep.location && row.location_id !== null) {
    const e = await lockLiveLocation(trx, branchId, row.location_id, 'locationId');
    if (e !== null) errors.push(e);
  }
  if (keep.supplier && row.supplier_id !== null) {
    const e = await lockLiveMaster(trx, 'suppliers', row.supplier_id, 'supplierId');
    if (e !== null) errors.push(e);
  }
  return errors;
}

// ---- the fields of a new item ------------------------------------------------------------------------------------------

/** What a new item takes besides its record and barcode: a create body without those, or a batch's `template`. */
export type ItemTemplate = Omit<ItemCreateBody, 'recordId' | 'barcode'>;

/** The columns of a new item besides its id, record, branch, barcode and trail. */
export interface ItemColumns {
  collection_type_id: string;
  status: ItemStatus;
  archived_at: number | null;
  status_note: string | null;
  parts_total: number;
  inventory_no: string | null;
  call_number: string | null;
  location_id: string | null;
  acq_source: string | null;
  order_no: string | null;
  order_date: string | null;
  received_date: string | null;
  invoice_date: string | null;
  supplier_id: string | null;
  invoice_no: string | null;
  price: number | null;
  currency: string | null;
  note: string | null;
}

/**
 * The template's fields checked (errors pushed onto `errors`, their paths after `prefix`) and turned into columns at
 * `now`: the collection type, the location of `branchId` and the supplier (each locked while live: lockLiveMaster,
 * lockLiveLocation), the price and the custom values.
 */
export async function templateColumns(
  trx: Transaction<DB>,
  branchId: string,
  t: ItemTemplate,
  defs: readonly CustomFieldDef[],
  errors: FieldWarning[],
  o: { prefix: string; now: number },
): Promise<{ columns: ItemColumns; custom: Record<string, unknown> }> {
  const ct = await lockLiveMaster(trx, 'collection_types', t.collectionTypeId, `${o.prefix}collectionTypeId`);
  if (ct !== null) errors.push(ct);
  if (t.locationId !== undefined && t.locationId !== null) {
    const e = await lockLiveLocation(trx, branchId, t.locationId, `${o.prefix}locationId`);
    if (e !== null) errors.push(e);
  }
  if (t.supplierId !== undefined && t.supplierId !== null) {
    const e = await lockLiveMaster(trx, 'suppliers', t.supplierId, `${o.prefix}supplierId`);
    if (e !== null) errors.push(e);
  }
  let price: number | null = null;
  if (t.price !== undefined && t.price !== null) {
    price = parsePrice(t.price);
    if (price === null) errors.push({ path: `${o.prefix}price`, code: 'invalid' });
  }
  const custom = checkCustom(defs, t.custom, 'create', o.prefix);
  errors.push(...custom.errors);
  const status = t.status;
  return {
    columns: {
      collection_type_id: t.collectionTypeId,
      status,
      archived_at: status === ARCHIVED_STATUS ? o.now : null,
      status_note: textOrNull(t.statusNote),
      parts_total: t.partsTotal,
      inventory_no: textOrNull(t.inventoryNo),
      call_number: textOrNull(t.callNumber),
      location_id: t.locationId ?? null,
      acq_source: t.acqSource ?? null,
      order_no: textOrNull(t.orderNo),
      order_date: t.orderDate ?? null,
      received_date: t.receivedDate ?? null,
      invoice_date: t.invoiceDate ?? null,
      supplier_id: t.supplierId ?? null,
      invoice_no: textOrNull(t.invoiceNo),
      price,
      currency: price === null ? null : (t.currency ?? (await defaultCurrency(trx))),
      note: textOrNull(t.note),
    },
    custom: custom.values,
  };
}

/**
 * Inserts items of `recordId` in `branchId` (`made`: their ids and barcode keys) with `columns`, their custom values
 * and one history row each (`eventType`). A barcode met at the unique index is TX_CONFLICT (see the top of this file).
 */
export async function insertItems(
  tx: TxCtx,
  branchId: string,
  recordId: string,
  made: readonly { id: string; barcode: string }[],
  columns: ItemColumns,
  custom: { values: Record<string, unknown>; defs: readonly CustomFieldDef[] },
  eventType: 'created' | 'imported' | 'migrated',
): Promise<void> {
  const trail = { created_at: tx.now, created_by: tx.actor.id, updated_at: tx.now, updated_by: tx.actor.id };
  const rows = made.map((m) => ({ id: m.id, record_id: recordId, branch_id: branchId, barcode_display: m.barcode, barcode_key: m.barcode, ...columns, ...trail }));
  // 30 columns: 100 rows stay far below every engine's parameter limit.
  for (let i = 0; i < rows.length; i += 100) {
    const slice = rows.slice(i, i + 100);
    await againOnBarcodeRace(() => tx.trx.insertInto('items').values(slice).execute());
  }
  if (Object.keys(custom.values).length > 0) {
    for (const m of made) await writeCustomValues(tx.trx, 'items', m.id, custom.values, custom.defs, { now: tx.now, actor: tx.actor.id });
  }
  await writeItemEvents(
    tx,
    made.map((m) => ({ itemId: m.id, type: eventType, toStatus: columns.status, toLocationId: columns.location_id })),
  );
}

/**
 * What follows every write of items (see the top of this file): `changed_at = now` on the records of `publicRecords`,
 * the index of every record of `items`, then (when given) the audit entry and `catalog.item.changed` for each item, the
 * last statements of the transaction.
 */
export async function afterItemsWrite(
  tx: TxCtx,
  items: readonly { id: string; recordId: string }[],
  o: { publicRecords: readonly string[]; audit: AuditInput | null; publish: boolean },
): Promise<void> {
  const changed = [...new Set(o.publicRecords)];
  for (let i = 0; i < changed.length; i += ID_BATCH) {
    await tx.trx.updateTable('records').set({ changed_at: tx.now }).where('id', 'in', changed.slice(i, i + ID_BATCH)).execute();
  }
  const records = [...new Set(items.map((i) => i.recordId))];
  if (records.length > 0) await indexRecords(tx.trx, records, tx.now);
  if (o.audit !== null) await tx.audit(o.audit);
  if (o.publish) {
    for (const item of items) await publish(tx.trx, { channel: 'catalog', type: 'catalog.item.changed', payload: { id: item.id, recordId: item.recordId } });
  }
}

// ---- create ----------------------------------------------------------------------------------------------------------

/**
 * Creates an item of `body.recordId` in `branchId` (see the top of this file) and answers its id and version 0.
 *
 * @throws DomainError NOT_FOUND for a branch that is not live; VALIDATION_FAILED with every field error (nothing
 *   written); TX_CONFLICT when its barcode was stored concurrently after the check (the caller's withTx runs again)
 */
export async function createItem(tx: TxCtx, branchId: string, body: ItemCreateBody, o: ItemSaveOptions = {}): Promise<{ id: string; version: number }> {
  const eventType = o.eventType ?? 'created';
  if (!CREATE_EVENTS.includes(eventType)) throw new TypeError(`createItem(): eventType ${JSON.stringify(eventType)} is not created, imported or migrated`);
  const { trx } = tx;
  const b = parseItemBody(ItemCreateBody, body);
  const rec = await lockLiveRecord(trx, b.recordId);
  await checkBranch(trx, branchId);

  const errors: FieldWarning[] = [];
  if (rec !== null) errors.push(rec);
  const barcode = await checkBarcode(trx, b.barcode, 'barcode');
  if (barcode.error !== null) errors.push(barcode.error);
  const defs = await loadCustomDefs(trx, 'items');
  const t = await templateColumns(trx, branchId, b, defs, errors, { prefix: '', now: tx.now });
  if (errors.length > 0) throw itemValidationFailed(errors);

  const id = newId(tx.now);
  await insertItems(tx, branchId, b.recordId, [{ id, barcode: barcode.key }], t.columns, { values: t.custom, defs }, eventType);
  const sent = typeof body === 'object' && body !== null ? Object.keys(body) : [];
  const fields = sent.filter((k) => Object.hasOwn(b, k) && b[k as keyof typeof b] !== undefined && k !== 'recordId').sort();
  const interactive = (o.mode ?? 'interactive') === 'interactive';
  await afterItemsWrite(tx, [{ id, recordId: b.recordId }], {
    publicRecords: [b.recordId],
    audit: interactive ? { action: 'catalog.item.create', entity: 'items', entityId: id, branchId, meta: { fields } } : null,
    publish: interactive,
  });
  return { id, version: 0 };
}

// ---- update ----------------------------------------------------------------------------------------------------------

/** The item `id` of `branchId` (read after its lock), or NOT_FOUND. */
export async function readBranchItem(db: Db, branchId: string, id: string): Promise<ItemRow> {
  const row = await db.selectFrom('items').selectAll().where('id', '=', id).executeTakeFirst();
  if (row === undefined || row.branch_id !== branchId) throw itemNotFound();
  return row;
}

/** The API names of the columns an update may change, besides barcode, price/currency and custom. */
const PATCH_COLUMNS = Object.freeze({
  inventoryNo: 'inventory_no',
  callNumber: 'call_number',
  locationId: 'location_id',
  collectionTypeId: 'collection_type_id',
  statusNote: 'status_note',
  partsTotal: 'parts_total',
  acqSource: 'acq_source',
  orderNo: 'order_no',
  orderDate: 'order_date',
  receivedDate: 'received_date',
  invoiceDate: 'invoice_date',
  supplierId: 'supplier_id',
  invoiceNo: 'invoice_no',
  note: 'note',
} as const);

type PatchKey = keyof typeof PATCH_COLUMNS;
const PATCH_KEYS = Object.keys(PATCH_COLUMNS) as PatchKey[];
const TEXT_KEYS: ReadonlySet<string> = new Set(['inventoryNo', 'callNumber', 'statusNote', 'orderNo', 'invoiceNo', 'note']);

/**
 * The history rows of a change of `before` (fields `changed`, API names): `status` (`archived` when the item became
 * withdrawn), `moved`, then `updated` for the rest.
 */
export function changeEvents(
  itemId: string,
  changed: readonly string[],
  from: { status: ItemStatus; locationId: string | null },
  to: { status: ItemStatus; locationId: string | null },
): ItemEventInput[] {
  const events: ItemEventInput[] = [];
  if (changed.includes('status')) {
    events.push({ itemId, type: to.status === ARCHIVED_STATUS ? 'archived' : 'status', fromStatus: from.status, toStatus: to.status, fields: ['status'] });
  }
  if (changed.includes('locationId')) {
    events.push({ itemId, type: 'moved', fromLocationId: from.locationId, toLocationId: to.locationId, fields: ['locationId'] });
  }
  const rest = changed.filter((f) => f !== 'status' && f !== 'locationId');
  if (rest.length > 0) events.push({ itemId, type: 'updated', fields: rest });
  return events;
}

/**
 * Changes the fields `patch` sends and answers the new version. A status change is checked against ITEM_TRANSITIONS
 * (a change to `withdrawn` archives the item, `withdrawn → processing` clears `archived_at`). `meta.fields` of the
 * audit entry names the fields whose value really changed.
 *
 * @throws DomainError NOT_FOUND (none, or of another branch); CONFLICT_STALE; ITEM_STATUS_TRANSITION (409);
 *   VALIDATION_FAILED with every field error (nothing written); TX_CONFLICT (see createItem)
 */
export async function updateItem(tx: TxCtx, branchId: string, id: string, patch: ItemPatchBody): Promise<{ id: string; version: number }> {
  const { trx } = tx;
  const p = parseItemBody(ItemPatchBody, patch);
  // The version on the latest commit, before anything is written (see the top of this file). When it matched and the
  // snapshot holds the same version, the row read next is the latest commit: every write of an item bumps its version.
  const current = await lockItemAt(trx, branchId, id, p.version);
  await lockItemRecords(trx, branchId, [id]);
  const before = await readBranchItem(trx, branchId, id);
  if (!current || Number(before.version) !== p.version) throw itemStale();
  const fromStatus = itemStatusOf(before.status);
  const toStatus = p.status ?? fromStatus;
  checkTransition(fromStatus, toStatus);
  if (toStatus !== fromStatus) await refuseItemOnLoan(trx, id);

  const errors: FieldWarning[] = [];
  let barcodeKey: string | null = null;
  if (p.barcode !== undefined) {
    const checked = await checkBarcode(trx, p.barcode, 'barcode', id);
    if (checked.error !== null) errors.push(checked.error);
    else if (checked.key !== before.barcode_key) barcodeKey = checked.key;
  }
  // The masters a change names are locked while live, after the record's row (the order of the top of this file). An
  // item leaving `withdrawn` checks its record and what it keeps first (reviveErrors, which locks the record).
  const collectionTypeId = p.collectionTypeId !== undefined && p.collectionTypeId !== before.collection_type_id ? p.collectionTypeId : null;
  const locationId = p.locationId !== undefined && p.locationId !== null && p.locationId !== before.location_id ? p.locationId : null;
  const supplierId = p.supplierId !== undefined && p.supplierId !== null && p.supplierId !== before.supplier_id ? p.supplierId : null;
  if (fromStatus === ARCHIVED_STATUS && toStatus !== ARCHIVED_STATUS) {
    const keep = {
      collectionType: collectionTypeId === null,
      location: p.locationId === undefined || p.locationId === before.location_id,
      supplier: p.supplierId === undefined || p.supplierId === before.supplier_id,
    };
    errors.push(...(await reviveErrors(trx, branchId, before, keep)));
  }
  if (collectionTypeId !== null) {
    const e = await lockLiveMaster(trx, 'collection_types', collectionTypeId, 'collectionTypeId');
    if (e !== null) errors.push(e);
  }
  if (locationId !== null) {
    const e = await lockLiveLocation(trx, branchId, locationId, 'locationId');
    if (e !== null) errors.push(e);
  }
  if (supplierId !== null) {
    const e = await lockLiveMaster(trx, 'suppliers', supplierId, 'supplierId');
    if (e !== null) errors.push(e);
  }
  let price: number | null | undefined;
  if (p.price !== undefined) {
    price = p.price === null ? null : parsePrice(p.price);
    if (p.price !== null && price === null) errors.push({ path: 'price', code: 'invalid' });
  }
  const defs = p.custom === undefined ? [] : await loadCustomDefs(trx, 'items');
  const custom = p.custom === undefined ? null : checkCustom(defs, p.custom, 'patch', '');
  if (custom !== null) errors.push(...custom.errors);
  if (errors.length > 0) throw itemValidationFailed(errors);

  const changed: string[] = [];
  // Column → value; each value was checked above for its column (the API name maps to one column).
  const set: Record<string, string | number | null> = {};
  if (barcodeKey !== null) {
    changed.push('barcode');
    set.barcode_display = barcodeKey;
    set.barcode_key = barcodeKey;
  }
  if (toStatus !== fromStatus) {
    changed.push('status');
    set.status = toStatus;
    set.archived_at = archivedAtAfter(fromStatus, toStatus, before.archived_at === null ? null : Number(before.archived_at), tx.now);
  }
  for (const k of PATCH_KEYS) {
    const v = p[k];
    if (v === undefined) continue;
    const value = TEXT_KEYS.has(k) ? textOrNull(v as string | null) : v;
    const old = before[PATCH_COLUMNS[k]];
    if ((k === 'partsTotal' ? Number(old) : old) !== value) {
      changed.push(k);
      set[PATCH_COLUMNS[k]] = value as string | number | null;
    }
  }
  const beforePrice = before.price === null ? null : Number(before.price);
  const newPrice = price === undefined ? beforePrice : price;
  const newCurrency = newPrice === null ? null : (p.currency ?? before.currency ?? (await defaultCurrency(trx)));
  if (newPrice !== beforePrice) {
    changed.push('price');
    set.price = newPrice;
  }
  if (newCurrency !== before.currency) {
    changed.push('currency');
    set.currency = newCurrency;
  }
  if (custom !== null && Object.keys(custom.values).length > 0) {
    const stored = (await readCustomValues(trx, 'items', [id])).get(id) ?? {};
    const differs = Object.entries(custom.values).some(([code, v]) => JSON.stringify(v ?? null) !== JSON.stringify(Object.hasOwn(stored, code) ? stored[code] : null));
    if (differs) {
      changed.push('custom');
      await writeCustomValues(trx, 'items', id, custom.values, defs, { now: tx.now, actor: tx.actor.id });
    }
  }

  const updated = await againOnBarcodeRace(() =>
    trx
      .updateTable('items')
      .set((eb) => ({ ...(set as Updateable<DB['items']>), updated_at: tx.now, updated_by: tx.actor.id, version: eb('version', '+', 1) }))
      .where('id', '=', id)
      .where('version', '=', p.version)
      .executeTakeFirst(),
  );
  if (Number(updated.numUpdatedRows) !== 1) throw itemStale();

  changed.sort();
  const toLocation = set.location_id !== undefined ? (set.location_id as string | null) : before.location_id;
  await writeItemEvents(tx, changeEvents(id, changed, { status: fromStatus, locationId: before.location_id }, { status: toStatus, locationId: toLocation }));
  await afterItemsWrite(tx, [{ id, recordId: before.record_id }], {
    publicRecords: changed.some((f) => PUBLIC_FIELDS.has(f)) ? [before.record_id] : [],
    audit: { action: 'catalog.item.update', entity: 'items', entityId: id, branchId, meta: { fields: changed } },
    publish: true,
  });
  return { id, version: p.version + 1 };
}

// ---- archive ---------------------------------------------------------------------------------------------------------

/**
 * Archives an item (§2.5): status `withdrawn` (the transition is checked) and `archived_at = now`, version + 1, an
 * `archived` history row, the record's `changed_at` and index, audits `catalog.item.archive` and publishes
 * `catalog.item.changed`. One already archived is answered as it is (its entry says `meta.alreadyArchived`), so a resent
 * request is harmless.
 *
 * @throws DomainError NOT_FOUND (none, or of another branch); CONFLICT_STALE; ITEM_STATUS_TRANSITION (e.g. a `missing`
 *   item: it is declared `lost` first)
 */
export async function archiveItem(tx: TxCtx, branchId: string, id: string, version: number): Promise<{ id: string; version: number }> {
  const { trx } = tx;
  await lockItemRows(trx, branchId, [id]);
  await lockItemRecords(trx, branchId, [id]);
  const before = await readBranchItem(trx, branchId, id);
  if (Number(before.version) !== version) throw itemStale();
  if (before.archived_at !== null) {
    await tx.audit({ action: 'catalog.item.archive', entity: 'items', entityId: id, branchId, meta: { alreadyArchived: true } });
    return { id, version };
  }
  const from = itemStatusOf(before.status);
  checkTransition(from, ARCHIVED_STATUS);
  await refuseItemOnLoan(trx, id);
  const updated = await trx
    .updateTable('items')
    .set((eb) => ({ status: ARCHIVED_STATUS, archived_at: tx.now, updated_at: tx.now, updated_by: tx.actor.id, version: eb('version', '+', 1) }))
    .where('id', '=', id)
    .where('version', '=', version)
    .executeTakeFirst();
  if (Number(updated.numUpdatedRows) !== 1) throw itemStale();
  await writeItemEvents(tx, [{ itemId: id, type: 'archived', fromStatus: from, toStatus: ARCHIVED_STATUS, fields: from === ARCHIVED_STATUS ? [] : ['status'] }]);
  await afterItemsWrite(tx, [{ id, recordId: before.record_id }], {
    publicRecords: [before.record_id],
    audit: { action: 'catalog.item.archive', entity: 'items', entityId: id, branchId, meta: {} },
    publish: true,
  });
  return { id, version: version + 1 };
}
