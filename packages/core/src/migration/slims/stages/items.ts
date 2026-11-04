import { createHash } from 'node:crypto';
import { fullTextFamily, type DB } from '@altis/db';
import { DomainError, newId, type ItemStatus } from '@altis/shared';
import type { Insertable, Transaction } from 'kysely';
import {
  CUSTOM_TEXT_MAX,
  coerceCustomValues,
  customValuesSchema,
  loadCustomDefs,
  writeCustomValues,
  type CustomFieldDef,
  type CustomFieldType,
} from '../../../catalog/data/custom-fields.js';
import { defaultCollectionTypeId, defaultMaterialTypeId } from '../../../catalog/data/defaults.js';
import { codeKey } from '../../../catalog/data/keys.js';
import { mapLegacy, type LegacyMapping } from '../../../catalog/data/legacy-map.js';
import { writeItemEvents } from '../../../catalog/items/events.js';
import { againOnBarcodeRace } from '../../../catalog/items/service.js';
import { titleKey } from '../../../catalog/lib/title-key.js';
import { txCtx, type Actor } from '../../../context.js';
import { indexRecords, stampChanged } from '../../../search/index-records.js';
import { readSettings } from '../../../settings/service.js';
import { slimsBarcode, withBarcodeSuffix, type SlimsBarcode } from '../maps/barcode.js';
import { slimsAcqSource, slimsItemStatus, type SlimsStatusRow } from '../maps/item-status.js';
import { slimsPrice } from '../maps/price.js';
import { cleanDate } from '../source/clean-text.js';
import { phpUnserialize } from '../source/php-unserialize.js';
import type { SlimsRow } from '../source/types.js';
import type { SlimsStage, SlimsStageContext } from '../stage.js';
import {
  againOnRace,
  cachedForRun,
  cutChars,
  fitChars,
  fitText,
  inBatch,
  intOf,
  keyFits,
  keyOf,
  mappedRows,
  nextPhase,
  oneLine,
  quietText,
  readCursor,
  runValue,
  scanAll,
  setRunValue,
  sourceCursor,
  sourceKeys,
  stageBBatch,
  stateOf,
  tableOf,
  targetsOf,
  textOf,
  writeCursor,
  type BatchIo,
  type Ledger,
  endOfStage,
} from './stage-b-kit.js';

// Items (Phase 2 spec §11.3 step 5, §11.4 rows `item`, `item.site`, `mst_coll_type`, `mst_item_status`, `mst_custom_field`
// + `item_custom`; D2-28, D2-29; preflight M13, S13; plan Task 38). Two phases, each a scan in batches of 500, each
// batch in one transaction:
//
// 1. `item` → `items` of the run's branch, written directly in bulk with the columns `createItem` writes (Task 17), one
//    `item_events` row `migrated` by the system each, the legacy map rows (entity `item`), `indexRecords` for the
//    batch's records and, last, their `changed_at` (the clock read right before the COMMIT, C14). Per item:
//    - the record migrated from `biblio_id`; an orphan item (no such record) goes under one hidden placeholder record
//      per missing `biblio_id` ("[Cantuman hilang - SLiMS #N]", entity `biblio_missing`, M13), so no item is dropped
//      and a later batch or run finds the placeholder instead of making another (`orphan_item`);
//    - the barcode (maps/barcode.ts): normalised, 1–2 characters flagged (`barcode_nonstandard`), `MIG<item_id>` for
//      an empty or unusable one (`barcode_replaced`, the original in `status_note`), then unique across the catalogue:
//      a code taken (by an item of the source or of the catalogue) gets `-2`, `-3`, … (`barcode_collision`);
//    - the status (maps/item-status.ts, through `mst_item_status`; `status_unknown`), the acquisition source, the
//      price (`priceMode`, maps/price.ts; `price_invalid`, `currency_invalid`), the dates (a zero or invalid date →
//      null, counted as a `date` repair);
//    - the room migrated from `location_id`, and inside it one shelf per normalised `site` text (entity `item_site`,
//      key `<room>|<SITE>`; `shelf_hint` = the text cut to 40); an unknown room → no location (`location_unknown`,
//      and `site_unplaced` for its site);
//    - the collection type migrated from `coll_type_id`; 0 or unknown → `catalog.defaultCollectionTypeId`
//      (`collection_type_default`); the supplier migrated from `supplier_id` (`supplier_unknown`);
//    - a real run locks the rows its items go to while they are live (the records, then the collection types, the
//      locations, the suppliers, as every item writer does: items/service.ts), so an admin's archive of one of them
//      (between two slices, or before a re-run) and the batch serialise (review X1-2; the migration itself never
//      archives a row it maps): an item whose record (or placeholder) was archived or merged is not written, and is
//      skipped `record_archived` (a re-run after the record is restored migrates it); an archived collection type gives
//      the default (`collection_type_archived`), an archived room no location and an archived shelf its room
//      (`location_archived`), an archived supplier none (`supplier_archived`).
// 2. `item_custom` → the items' custom values (the `cf_*` columns, through the definitions the masters stage made,
//    entity `mst_custom_field`; S19: coerced to the field's type, a refused value reported and left out).
//
// A dry run writes nothing: records, rooms, collection types, suppliers and custom fields are looked up in the source
// instead of the legacy map, and the barcodes the run would give are kept in this process for the run (rebuilt from
// the source's earlier batches when another process takes the run over), so a collision two batches apart is reported
// as a real run would.

const SYSTEM: Actor = Object.freeze({ type: 'system', id: null, ip: null });

const T = 'item';
const TC = 'item_custom';
const STATUS = 'mst_item_status';

/** Widths of the columns written here. */
const SHORT_MAX = 64;
const NAME_MAX = 191;
const HINT_MAX = 40;
const NOTE_MAX = 191;
const LOCATION_CODE_MAX = 32;
const SOURCE_MAX = 64;
/** Rows per INSERT of items (31 columns: far below every engine's parameter limit). */
const INSERT_ROWS = 100;
/** Ids per `IN (…)` list. */
const ID_BATCH = 500;

/** The title of the placeholder record of a missing `biblio_id` (§11.4, D2-29). */
export function placeholderTitle(biblioId: string): string {
  return `[Cantuman hilang ${String.fromCharCode(0x2014)} SLiMS #${biblioId}]`;
}

/** One item of a batch the stage handles. */
interface Plan {
  key: string;
  state: 'fresh' | 'replay';
  /** The item's own ledger: its rows stay in item order whatever the batch size. */
  log: Ledger;
  biblioKey: string;
  barcode: SlimsBarcode;
  statusNote: string | null;
  priceInvalid: string | null;
  currencyFallback: string | null;
  roomKey: string;
  site: string | null;
  collectionType: string;
  supplier: string;
  columns: {
    inventory_no: string | null;
    call_number: string | null;
    status: ItemStatus;
    status_note: string | null;
    acq_source: string;
    order_no: string | null;
    order_date: string | null;
    received_date: string | null;
    invoice_date: string | null;
    invoice_no: string | null;
    price: number | null;
    currency: string | null;
  };
}

// ---- cells ----------------------------------------------------------------------------------------------------------

/** `mst_item_status` by upper-case code (cached for the run). */
function statusRows(c: SlimsStageContext): Promise<ReadonlyMap<string, SlimsStatusRow>> {
  return cachedForRun(c, 'items:statuses', async () => {
    const rows = new Map<string, SlimsStatusRow>();
    await scanAll(c, STATUS, (row) => {
      const code = keyOf(row['item_status_id']).toUpperCase();
      if (code === '' || rows.has(code)) return;
      rows.set(code, { name: oneLine(quietText(row['item_status_name'])), noLoan: keyOf(row['no_loan']) === '1' });
    });
    return rows;
  });
}

/** Text of `column` of `table` as one line, repairs counted ('' for NULL). */
function line(l: Ledger, table: string, column: string, row: SlimsRow): string {
  return oneLine(textOf(l, table, column, row[column]) ?? '');
}

/** A date column: `YYYY-MM-DD`, or null (a zero or invalid date counted as a `date` repair, §11.5 step 6). */
function dateOf(l: Ledger, column: string, row: SlimsRow): string | null {
  const text = line(l, T, column, row);
  if (text === '') return null;
  const date = cleanDate(text);
  if (date === null) {
    l.fixed(`${T}.${column}`, ['date'], text, '');
    return null;
  }
  return date.slice(0, 10);
}

/** A number cell as it is, a text cell cleaned (maps/price.ts reads both). */
function rawOf(l: Ledger, column: string, row: SlimsRow): number | string | null {
  const v = row[column];
  if (v === null || v === undefined) return null;
  return typeof v === 'number' ? v : line(l, T, column, row);
}

/** The plan of one item (see the top of this file); repairs and cut values are reported to `log` as they are met. */
function planItem(c: SlimsStageContext, log: Ledger, key: string, row: SlimsRow, state: 'fresh' | 'replay', statuses: ReadonlyMap<string, SlimsStatusRow>): Plan {
  const statusCode = line(log, T, 'item_status_id', row);
  const status = slimsItemStatus(statusCode, statuses.get(statusCode.toUpperCase()) ?? null);
  const barcode = slimsBarcode(line(log, T, 'item_code', row), key);
  const notes: string[] = [];
  if (status.note !== null) notes.push(status.note);
  if (barcode.outcome === 'replaced' && barcode.original !== null) notes.push(`SLiMS: ${barcode.original}`);
  const priceCell = rawOf(log, 'price', row);
  const currencyCell = line(log, T, 'price_currency', row);
  const price = slimsPrice(priceCell, currencyCell, c.options.priceMode);
  const site = line(log, T, 'site', row);
  const source = row['source'];
  return {
    key,
    state,
    log,
    biblioKey: keyOf(row['biblio_id']) || '0',
    barcode,
    statusNote: status.unknown ? status.note : null,
    priceInvalid: price.invalidPrice ? String(priceCell) : null,
    currencyFallback: price.currencyFallback ? currencyCell : null,
    roomKey: keyOf(row['location_id']),
    site: site === '' ? null : site,
    collectionType: keyOf(row['coll_type_id']),
    supplier: keyOf(row['supplier_id']),
    columns: {
      inventory_no: fitChars(log, T, key, 'inventory_code', line(log, T, 'inventory_code', row), SHORT_MAX),
      call_number: fitChars(log, T, key, 'call_number', line(log, T, 'call_number', row), SHORT_MAX),
      status: status.status,
      status_note: notes.length === 0 ? null : cutChars(notes.join('; '), NOTE_MAX),
      acq_source: slimsAcqSource(typeof source === 'number' ? source : keyOf(source)),
      order_no: fitChars(log, T, key, 'order_no', line(log, T, 'order_no', row), SHORT_MAX),
      order_date: dateOf(log, 'order_date', row),
      received_date: dateOf(log, 'received_date', row),
      invoice_date: dateOf(log, 'invoice_date', row),
      invoice_no: fitChars(log, T, key, 'invoice', line(log, T, 'invoice', row), SHORT_MAX),
      price: price.price,
      currency: price.currency,
    },
  };
}

// ---- barcodes -------------------------------------------------------------------------------------------------------

/** The barcode keys among `keys` the catalogue holds already. */
async function storedBarcodes(db: BatchIo['db'], keys: readonly string[]): Promise<Set<string>> {
  const found = new Set<string>();
  const unique = [...new Set(keys)];
  for (let i = 0; i < unique.length; i += ID_BATCH) {
    const rows = await db.selectFrom('items').select('barcode_key').where('barcode_key', 'in', unique.slice(i, i + ID_BATCH)).execute();
    for (const r of rows) found.add(r.barcode_key);
  }
  return found;
}

/**
 * The barcode each of `planned` gets, in order: its own, or with the first suffix `-2`, `-3`, … that neither the
 * catalogue nor `taken` (the codes given before it) holds; each code given is added to `taken`.
 */
async function assignBarcodes(db: BatchIo['db'], planned: readonly string[], taken: Set<string>): Promise<string[]> {
  const stored = await storedBarcodes(db, planned);
  const out: string[] = [];
  for (const base of planned) {
    let code = base;
    for (let n = 2; taken.has(code) || (code === base ? stored.has(code) : (await storedBarcodes(db, [code])).size > 0); n += 1) {
      code = withBarcodeSuffix(base, n);
    }
    taken.add(code);
    out.push(code);
  }
  return out;
}

/** The barcodes a dry run gave before the batch at source cursor `at` (see the top of this file), kept in this process. */
interface DryBarcodes {
  at: string | null;
  taken: Set<string>;
}

const DRY_BARCODES = 'items:dryBarcodes';

/**
 * The barcodes a dry run gave before the batch at `at`: the ones this process kept, or rebuilt from the source's
 * earlier batches. The caller owns them (they are forgotten here) until it keeps them again for the next batch.
 */
async function dryTaken(c: SlimsStageContext, at: string | null): Promise<Set<string>> {
  const kept = runValue<DryBarcodes>(c, DRY_BARCODES);
  setRunValue(c, DRY_BARCODES, undefined);
  if (kept !== undefined && kept.at === at) return kept.taken;
  // Rebuilt from the source: the batches before `at`, read with the batch size that led there.
  const taken = new Set<string>();
  let after: string | null = null;
  while (at !== null && after !== at) {
    const batch: { rows: SlimsRow[]; next: string | null } = await c.source.rows(T, after, stageBBatch());
    if (batch.rows.length === 0 || batch.next === null) throw new TypeError('SLiMS stage items: the cursor is not one of the source');
    const seen = new Set<string>();
    const keyed: { key: string; row: SlimsRow }[] = [];
    for (const row of batch.rows) {
      const key = keyOf(row['item_id']);
      if (!keyFits(key) || seen.has(key)) continue;
      seen.add(key);
      keyed.push({ key, row });
    }
    // As itemBatch: only the items not migrated already got a barcode.
    const mapped = await mappedRows(c, c.h.db, T, keyed.map((k) => k.key));
    const planned = keyed.filter((k) => !mapped.has(k.key)).map((k) => slimsBarcode(oneLine(quietText(k.row['item_code'])), k.key).barcode);
    await assignBarcodes(c.h.db, planned, taken);
    after = batch.next;
  }
  return taken;
}

// ---- shelves and placeholders (a real run) --------------------------------------------------------------------------

/** A location code (`codeField`: printable ASCII, ≤ 32) made from a room's code and a shelf's text, with suffix `n`. */
function shelfCode(room: string, site: string, n: number): string {
  const tail = site
    .normalize('NFKD')
    .replace(/\p{M}/gu, '')
    .toUpperCase()
    .replace(/[^A-Z0-9]+/g, '-')
    .replace(/^-+|-+$/g, '');
  const suffix = n > 1 ? `-${n}` : '';
  const head = room.replace(/[^\x21-\x7E]+/g, '-').slice(0, 16);
  const base = `${head}-${tail === '' ? 'RAK' : tail}`;
  return `${base.slice(0, LOCATION_CODE_MAX - suffix.length).replace(/[-\s]+$/, '')}${suffix}`;
}

/** The legacy key of shelf `siteKey` in room `roomKey` (entity `item_site`), within 191 characters. */
function shelfLegacyKey(roomKey: string, siteKey: string): string {
  const plain = `${roomKey}|${siteKey}`;
  if (Array.from(plain).length <= 191) return plain;
  return `${cutChars(roomKey, 120)}|#${createHash('sha256').update(siteKey, 'utf8').digest('hex').slice(0, 40)}`;
}

/**
 * The shelves `wanted` (a room and a site text each), by `<roomId>|<siteKey>`: found through the legacy map (and locked
 * while live, see lockLive; null for one archived since it was made: its items go to the room), else made (a location
 * of kind `shelf` under its room, its code unique in the branch) and mapped (pushed onto `maps`).
 */
async function shelvesFor(
  c: SlimsStageContext,
  trx: Transaction<DB>,
  wanted: readonly { roomKey: string; roomId: string; site: string }[],
  maps: LegacyMapping[],
): Promise<Map<string, string | null>> {
  const byLegacy = new Map<string, { roomId: string; site: string; siteKey: string }>();
  for (const w of wanted) {
    const siteKey = codeKey(w.site);
    const legacy = shelfLegacyKey(w.roomKey, siteKey);
    if (!byLegacy.has(legacy)) byLegacy.set(legacy, { roomId: w.roomId, site: w.site, siteKey });
  }
  const found = await targetsOf(c, trx, 'item_site', [...byLegacy.keys()]);
  const live = await lockLive(trx, 'locations', [...found.values()]);
  const roomCodes = new Map<string, string>();
  const out = new Map<string, string | null>();
  for (const [legacy, w] of byLegacy) {
    let id: string | null | undefined = found.get(legacy);
    if (id !== undefined && !live.has(id)) id = null;
    if (id === undefined) {
      let room = roomCodes.get(w.roomId);
      if (room === undefined) {
        room = (await trx.selectFrom('locations').select('code_display').where('id', '=', w.roomId).executeTakeFirstOrThrow()).code_display;
        roomCodes.set(w.roomId, room);
      }
      let code = shelfCode(room, w.site, 1);
      for (let n = 2; ; n += 1) {
        const taken = await trx.selectFrom('locations').select('id').where('branch_id', '=', c.options.branchId).where('code_key', '=', codeKey(code)).executeTakeFirst();
        if (taken === undefined) break;
        code = shelfCode(room, w.site, n);
      }
      id = newId(c.now);
      const values: Insertable<DB['locations']> = {
        id,
        branch_id: c.options.branchId,
        parent_id: w.roomId,
        kind: 'shelf',
        code_display: code,
        code_key: codeKey(code),
        name: cutChars(w.site, NAME_MAX),
        shelf_hint: cutChars(w.site, HINT_MAX),
        class_from: null,
        class_to: null,
        map_file_id: null,
        map_x: null,
        map_y: null,
        map_w: null,
        map_h: null,
        is_public: 1,
        sort_order: 0,
        archived_at: null,
        created_at: c.now,
        created_by: null,
        updated_at: c.now,
        updated_by: null,
      };
      await againOnRace(() => trx.insertInto('locations').values(values).execute());
      maps.push({ source: c.options.sourceName, entity: 'item_site', legacyKey: legacy, targetId: id, runId: c.runId });
    }
    out.set(`${w.roomId}|${w.siteKey}`, id);
  }
  return out;
}

/** The placeholder records of the missing `biblio_id`s `keys`: found through the legacy map, else made and mapped. */
async function placeholders(c: SlimsStageContext, trx: Transaction<DB>, keys: readonly string[], maps: LegacyMapping[]): Promise<Map<string, string>> {
  const found = await targetsOf(c, trx, 'biblio_missing', keys);
  const missing = [...new Set(keys)].filter((k) => !found.has(k));
  if (missing.length === 0) return found;
  const configured = (await readSettings(trx, ['catalog.defaultMaterialTypeId'], []))['catalog.defaultMaterialTypeId'] as string | null;
  const materialType = await defaultMaterialTypeId(trx, configured);
  for (const k of missing) {
    const id = newId(c.now);
    const title = placeholderTitle(k);
    const values: Insertable<DB['records']> = {
      id,
      material_type_id: materialType,
      title,
      subtitle: null,
      responsibility: null,
      title_key: titleKey(title),
      edition: null,
      material_detail: null,
      publisher_id: null,
      publication_place: null,
      publication_year: null,
      publication_date_text: null,
      physical_desc: null,
      series: null,
      classification: null,
      call_number: null,
      language_id: null,
      content_type: null,
      media_type: null,
      carrier_type: null,
      summary: null,
      notes: null,
      cover_file_id: null,
      opac_visible: 0,
      promoted: 0,
      source: cutChars(`slims:${k}`, SOURCE_MAX),
      merged_into: null,
      changed_at: c.now,
      archived_at: null,
      created_at: c.now,
      created_by: null,
      updated_at: c.now,
      updated_by: null,
    };
    await trx.insertInto('records').values(values).execute();
    maps.push({ source: c.options.sourceName, entity: 'biblio_missing', legacyKey: k, targetId: id, runId: c.runId });
    found.set(k, id);
  }
  return found;
}

// ---- live rows (a real run) ------------------------------------------------------------------------------------------

/** The tables of the rows an item points to. */
type LiveTable = 'records' | 'collection_types' | 'locations' | 'suppliers';

/**
 * The rows `ids` of `table` that are live (`archived_at IS NULL`), locked: a locking read (FOR UPDATE on MySQL/MariaDB
 * and PostgreSQL; SQLite has one writer), so it reads the latest commit whatever this batch read before (on
 * MySQL/MariaDB a plain read would show the batch's older snapshot, in which a row archived since is still live), and
 * an archive of one of them that comes later waits for this batch's COMMIT and then counts its items, as it does for
 * createItem's lockLiveRecord, lockLiveMaster and lockLiveLocation (items/service.ts). A merged record is archived too.
 */
async function lockLive(trx: Transaction<DB>, table: LiveTable, ids: readonly string[]): Promise<Set<string>> {
  const unique = [...new Set(ids)].sort();
  const locking = fullTextFamily(trx) !== 'fts5';
  const live = new Set<string>();
  for (let i = 0; i < unique.length; i += ID_BATCH) {
    const q = trx
      .selectFrom(table as 'records')
      .select('id')
      .where('id', 'in', unique.slice(i, i + ID_BATCH))
      .where('archived_at', 'is', null);
    for (const r of await (locking ? q.forUpdate() : q).execute()) live.add(r.id);
  }
  return live;
}

/**
 * What became of one item against the rows it points to (see the top of this file): its record (or placeholder) was
 * archived or merged (`stranded`: not written, `record_archived`), or its collection type, room, shelf or supplier was
 * archived (the default type, no location, the room, no supplier; `collection_type_archived`, `location_archived`,
 * `supplier_archived`).
 */
interface Fate {
  stranded: boolean;
  typeArchived: boolean;
  roomArchived: boolean;
  shelfArchived: boolean;
  supplierArchived: boolean;
}

const NO_FALLBACK: Fate = Object.freeze({ stranded: false, typeArchived: false, roomArchived: false, shelfArchived: false, supplierArchived: false });

/**
 * Locks the records of the fresh items `fresh`, then the collection types and rooms of those whose record is live
 * (lockLive), in the order every item writer takes them (items/service.ts: the records, then the collection types, the
 * locations, the suppliers; the caller locks the shelves and the suppliers next); each item's fate by its key. The
 * default collection type `fallbackType` is locked too: archived after this batch read it, the batch runs again
 * (TX_CONFLICT) and reads the default anew.
 */
async function lockTargets(
  trx: Transaction<DB>,
  fresh: readonly Plan[],
  f: { recordOf(p: Plan): string; typeOf(p: Plan): string | null; roomOf(p: Plan): string | null; fallbackType: string },
): Promise<Map<string, Fate>> {
  const records = await lockLive(trx, 'records', fresh.map(f.recordOf));
  const fates = new Map<string, Fate>();
  for (const p of fresh) fates.set(p.key, { ...NO_FALLBACK, stranded: !records.has(f.recordOf(p)) });
  const placed = fresh.filter((p) => !fates.get(p.key)!.stranded);
  const types = await lockLive(trx, 'collection_types', [f.fallbackType, ...placed.map(f.typeOf).filter((id): id is string => id !== null)]);
  const rooms = await lockLive(trx, 'locations', placed.map(f.roomOf).filter((id): id is string => id !== null));
  for (const p of placed) {
    const fate = fates.get(p.key)!;
    const type = f.typeOf(p);
    if (type !== null && !types.has(type)) fate.typeArchived = true;
    const room = f.roomOf(p);
    if (room !== null && !rooms.has(room)) fate.roomArchived = true;
  }
  if (!types.has(f.fallbackType) && placed.some((p) => f.typeOf(p) === null || fates.get(p.key)!.typeArchived)) {
    throw new DomainError('TX_CONFLICT', {
      detail: 'Tipe koleksi bawaan baru saja diarsipkan; transaksi diulang / The default collection type was just archived; the transaction is run again',
      meta: { attempts: 1, code: 'MIGRATION_DEFAULT_ARCHIVED' },
    });
  }
  return fates;
}

/**
 * The fate of an item this run wrote already (a replay, see stage-b-kit.ts), from what it was stored with: a mapped
 * collection type it does not hold, a room it is not placed in (or placed in instead of its site's shelf), a mapped
 * supplier it has not.
 */
function storedFate(
  p: Plan,
  stored: { collection_type_id: string; location_id: string | null; supplier_id: string | null },
  f: { typeOf(p: Plan): string | null; roomOf(p: Plan): string | null; supplierOf(p: Plan): string | null },
): Fate {
  const type = f.typeOf(p);
  const room = f.roomOf(p);
  const supplier = f.supplierOf(p);
  return {
    stranded: false,
    typeArchived: type !== null && stored.collection_type_id !== type,
    roomArchived: room !== null && stored.location_id === null,
    shelfArchived: room !== null && p.site !== null && stored.location_id === room,
    supplierArchived: supplier !== null && stored.supplier_id === null,
  };
}

// ---- phase 1: items -------------------------------------------------------------------------------------------------

async function itemBatch(
  c: SlimsStageContext,
  rows: readonly SlimsRow[],
  io: BatchIo,
  l: Ledger,
  dry: Set<string> | null,
  statuses: ReadonlyMap<string, SlimsStatusRow>,
): Promise<void> {
  // Every row gets a ledger of its own, joined in row order at the end.
  const logs: Ledger[] = [];
  const keyed: { key: string; row: SlimsRow; log: Ledger }[] = [];
  const seen = new Set<string>();
  for (const row of rows) {
    const log = l.fork();
    logs.push(log);
    const key = keyOf(row['item_id']);
    if (!keyFits(key)) {
      log.skipped(T, 'empty_key');
      log.report(T, null, 'empty_key', 'item_id kosong / empty');
    } else if (seen.has(key)) {
      log.skipped(T, 'duplicate_key');
      log.report(T, key, 'duplicate_key', 'item_id ganda / repeated');
    } else {
      seen.add(key);
      keyed.push({ key, row, log });
    }
  }
  const mapped = await mappedRows(c, io.db, T, keyed.map((k) => k.key));
  const plans: Plan[] = [];
  for (const { key, row, log } of keyed) {
    const state = stateOf(c, mapped.get(key));
    if (state === 'done') log.skipped(T, 'already_migrated');
    else plans.push(planItem(c, log, key, row, state, statuses));
  }
  if (plans.length === 0) {
    l.join(logs);
    return;
  }

  // Lookups: the legacy map in a real run, the source in a dry run (which mapped nothing).
  const trx = io.trx;
  const known = async (entity: string, table: string, column: string, keys: readonly string[]): Promise<(k: string) => string | null> => {
    if (trx !== null) {
      const targets = await targetsOf(c, trx, entity, keys);
      return (k) => targets.get(k) ?? null;
    }
    const present = await sourceKeys(c, table, column);
    return (k) => (present.has(k) ? `~${k}` : null);
  };
  const record = await known('biblio', 'biblio', 'biblio_id', plans.map((p) => p.biblioKey));
  const room = await known('mst_location', 'mst_location', 'location_id', plans.map((p) => p.roomKey));
  const collectionType = await known('mst_coll_type', 'mst_coll_type', 'coll_type_id', plans.map((p) => p.collectionType));
  const supplier = await known('mst_supplier', 'mst_supplier', 'supplier_id', plans.map((p) => p.supplier));
  const configured = (await readSettings(io.db, ['catalog.defaultCollectionTypeId'], []))['catalog.defaultCollectionTypeId'] as string | null;
  const fallbackType = await defaultCollectionTypeId(io.db, configured);
  // A room of another branch (this source migrated before into another branch) cannot hold this branch's items.
  const ownRooms = new Set<string>();
  if (trx !== null) {
    const roomIds = [...new Set(plans.map((p) => (p.roomKey === '' ? null : room(p.roomKey))).filter((id): id is string => id !== null))];
    for (let i = 0; i < roomIds.length; i += ID_BATCH) {
      const own = await trx.selectFrom('locations').select('id').where('id', 'in', roomIds.slice(i, i + ID_BATCH)).where('branch_id', '=', c.options.branchId).execute();
      for (const r of own) ownRooms.add(r.id);
    }
  }
  /** The room of the item's `location_id` (of the run's branch in a real run), or null. */
  const ownRoom = (p: Plan): string | null => {
    const id = p.roomKey === '' ? null : room(p.roomKey);
    return id !== null && (trx === null || ownRooms.has(id)) ? id : null;
  };
  const typeOf = (p: Plan): string | null => (p.collectionType === '' || p.collectionType === '0' ? null : collectionType(p.collectionType));
  const supplierOf = (p: Plan): string | null => (p.supplier === '' || p.supplier === '0' ? null : supplier(p.supplier));

  // A real run: the placeholders of the orphans, then the rows the fresh items go to locked while live (see below).
  const maps: LegacyMapping[] = [];
  let fresh = plans.filter((p) => p.state === 'fresh');
  let placeholder = new Map<string, string>();
  const recordOf = (p: Plan): string => record(p.biblioKey) ?? placeholder.get(p.biblioKey)!;
  let fates = new Map<string, Fate>();
  let shelves = new Map<string, string | null>();
  if (trx !== null && fresh.length > 0) {
    const orphanKeys = fresh.filter((p) => record(p.biblioKey) === null).map((p) => p.biblioKey);
    if (orphanKeys.length > 0) placeholder = await placeholders(c, trx, orphanKeys, maps);
    fates = await lockTargets(trx, fresh, { recordOf, typeOf, roomOf: ownRoom, fallbackType });
    fresh = fresh.filter((p) => !fates.get(p.key)!.stranded);
    shelves = await shelvesFor(
      c,
      trx,
      fresh.flatMap((p) => {
        const id = fates.get(p.key)!.roomArchived ? null : ownRoom(p);
        return id === null || p.site === null ? [] : [{ roomKey: p.roomKey, roomId: id, site: p.site }];
      }),
      maps,
    );
    for (const p of fresh) {
      const id = ownRoom(p);
      if (id !== null && !fates.get(p.key)!.roomArchived && p.site !== null && shelves.get(`${id}|${codeKey(p.site)}`) === null) fates.get(p.key)!.shelfArchived = true;
    }
    const suppliers = await lockLive(trx, 'suppliers', fresh.map(supplierOf).filter((id): id is string => id !== null));
    for (const p of fresh) {
      const id = supplierOf(p);
      if (id !== null && !suppliers.has(id)) fates.get(p.key)!.supplierArchived = true;
    }
  }

  // Barcodes: given now to the fresh items, read back for the items this run wrote already (and, from what those were
  // stored with, the fallbacks their first pass took, so a replay reports them alike).
  const given = await assignBarcodes(io.db, fresh.map((p) => p.barcode.barcode), dry ?? new Set());
  const barcodeOf = new Map(fresh.map((p, i) => [p.key, given[i]!]));
  const replayed = plans.filter((p) => p.state === 'replay').map((p) => mapped.get(p.key)!.targetId);
  for (let i = 0; i < replayed.length; i += ID_BATCH) {
    const rowsBack = await io.db
      .selectFrom('items')
      .select(['id', 'barcode_key', 'collection_type_id', 'location_id', 'supplier_id'])
      .where('id', 'in', replayed.slice(i, i + ID_BATCH))
      .execute();
    const byId = new Map(rowsBack.map((r) => [r.id, r]));
    for (const p of plans) {
      const stored = p.state === 'replay' ? byId.get(mapped.get(p.key)!.targetId) : undefined;
      if (stored === undefined) continue;
      barcodeOf.set(p.key, stored.barcode_key);
      fates.set(p.key, storedFate(p, stored, { typeOf, roomOf: ownRoom, supplierOf }));
    }
  }
  const fateOf = (p: Plan): Fate => fates.get(p.key) ?? NO_FALLBACK;
  /** Where the item is placed: its room unless archived, the room's shelf of its site unless archived (then the room). */
  const placedRoom = (p: Plan): string | null => (fateOf(p).roomArchived ? null : ownRoom(p));

  // The report rows of each item, in order.
  for (const p of plans) {
    const log = p.log;
    const fate = fateOf(p);
    if (fate.stranded) {
      log.report(T, p.key, 'record_archived', `biblio_id=${cutChars(p.biblioKey, 40)}`);
      log.skipped(T, 'record_archived');
      continue;
    }
    const orphan = record(p.biblioKey) === null;
    if (orphan) log.report(T, p.key, 'orphan_item', `biblio_id=${cutChars(p.biblioKey, 40)}`);
    if (p.barcode.outcome === 'nonstandard') log.report(T, p.key, 'barcode_nonstandard', p.barcode.barcode);
    if (p.barcode.outcome === 'replaced') log.report(T, p.key, 'barcode_replaced', `${p.barcode.reason}: ${cutChars(p.barcode.original ?? '', 64)} -> ${p.barcode.barcode}`);
    const barcode = barcodeOf.get(p.key) ?? p.barcode.barcode;
    if (barcode !== p.barcode.barcode) log.report(T, p.key, 'barcode_collision', `${p.barcode.barcode} -> ${barcode}`);
    if (p.statusNote !== null) log.report(T, p.key, 'status_unknown', p.statusNote);
    if (p.priceInvalid !== null) log.report(T, p.key, 'price_invalid', `price=${cutChars(p.priceInvalid, 40)}`);
    if (p.currencyFallback !== null) log.report(T, p.key, 'currency_invalid', `${cutChars(p.currencyFallback, 20)} -> IDR`);
    if (p.roomKey !== '' && room(p.roomKey) === null) log.report(T, p.key, 'location_unknown', `location_id=${cutChars(p.roomKey, 40)}`);
    else if (p.roomKey !== '' && ownRoom(p) === null) log.report(T, p.key, 'location_other_branch', `location_id=${cutChars(p.roomKey, 40)}`);
    else if (fate.roomArchived) log.report(T, p.key, 'location_archived', `location_id=${cutChars(p.roomKey, 40)}`);
    if (p.site !== null && placedRoom(p) === null) log.report(T, p.key, 'site_unplaced', `site=${cutChars(p.site, 60)}`);
    else if (p.site !== null && fate.shelfArchived) log.report(T, p.key, 'location_archived', `site=${cutChars(p.site, 60)}`);
    if (typeOf(p) === null) log.report(T, p.key, 'collection_type_default', `coll_type_id=${cutChars(p.collectionType, 40)}`);
    else if (fate.typeArchived) log.report(T, p.key, 'collection_type_archived', `coll_type_id=${cutChars(p.collectionType, 40)}`);
    if (p.supplier !== '' && p.supplier !== '0' && supplier(p.supplier) === null) log.report(T, p.key, 'supplier_unknown', `supplier_id=${cutChars(p.supplier, 40)}`);
    else if (fate.supplierArchived) log.report(T, p.key, 'supplier_archived', `supplier_id=${cutChars(p.supplier, 40)}`);
    log.migrated(T);
  }
  l.join(logs);
  if (trx === null) return;
  if (fresh.length === 0) {
    if (maps.length > 0) await mapLegacy(trx, maps);
    return;
  }

  // A real run writes the fresh items whose record is live.
  const recordIds = [...new Set(fresh.map(recordOf))];
  const items: Insertable<DB['items']>[] = fresh.map((p) => {
    const fate = fateOf(p);
    const roomId = placedRoom(p);
    const shelf = roomId === null || p.site === null ? null : shelves.get(`${roomId}|${codeKey(p.site)}`);
    const location = roomId === null ? null : (shelf ?? roomId);
    const barcode = barcodeOf.get(p.key)!;
    const id = newId(c.now);
    maps.push({ source: c.options.sourceName, entity: T, legacyKey: p.key, targetId: id, runId: c.runId });
    return {
      id,
      record_id: recordOf(p),
      branch_id: c.options.branchId,
      barcode_display: barcode,
      barcode_key: barcode,
      ...p.columns,
      collection_type_id: fate.typeArchived ? fallbackType : (typeOf(p) ?? fallbackType),
      location_id: location,
      supplier_id: fate.supplierArchived ? null : supplierOf(p),
      archived_at: null,
      parts_total: 1,
      note: null,
      created_at: c.now,
      created_by: null,
      updated_at: c.now,
      updated_by: null,
    };
  });
  for (let i = 0; i < items.length; i += INSERT_ROWS) {
    const slice = items.slice(i, i + INSERT_ROWS);
    await againOnBarcodeRace(() => trx.insertInto('items').values(slice).execute());
  }
  await writeItemEvents(
    txCtx(trx, c.now, SYSTEM),
    items.map((it) => ({ itemId: it.id as string, type: 'migrated' as const, toStatus: it.status as ItemStatus, toLocationId: it.location_id ?? null })),
  );
  await mapLegacy(trx, maps);
  await indexRecords(trx, recordIds, c.now);
  // The datestamp last, from the clock read right before the COMMIT (C14).
  await stampChanged(trx, recordIds, c.clock());
}

// ---- phase 2: custom values -----------------------------------------------------------------------------------------

/** SLiMS custom field types → ALTIS (§11.4), as the masters stage makes the definitions. */
const CUSTOM_TYPES: Readonly<Record<string, CustomFieldType>> = Object.freeze({
  text: 'text',
  longtext: 'longtext',
  numeric: 'number',
  dropdown: 'select',
  checklist: 'multiselect',
  choice: 'select',
  date: 'date',
});

/** The strings of an unserialized list (a list of pairs, a list, an object of values). */
function listOf(value: unknown): unknown[] {
  return Array.isArray(value) ? value : typeof value === 'object' && value !== null ? Object.values(value) : [value];
}

/**
 * The item field definitions a dry run uses (it made none): the source's `mst_custom_field` rows of `item`, typed and
 * with their options as the masters stage makes them (cached for the run).
 */
function sourceItemDefs(c: SlimsStageContext): Promise<CustomFieldDef[]> {
  return cachedForRun(c, 'items:defs', async () => {
    const defs: CustomFieldDef[] = [];
    await scanAll(c, 'mst_custom_field', (row) => {
      if (keyOf(row['primary_table']).toLowerCase() !== 'item') return;
      const code = keyOf(row['dbfield']);
      if (code === '' || defs.some((d) => d.code === code)) return;
      const slimsType = keyOf(row['type']).toLowerCase();
      let type: CustomFieldType = Object.hasOwn(CUSTOM_TYPES, slimsType) ? CUSTOM_TYPES[slimsType]! : 'text';
      const options: CustomFieldDef['options'] = [];
      if (type === 'select' || type === 'multiselect') {
        const parsed = phpUnserialize(quietText(row['data']));
        const pairs: [string, string][] = [];
        if (parsed.ok) {
          for (const item of listOf(parsed.value)) {
            if (Array.isArray(item) && item[0] !== undefined && item[0] !== null) pairs.push([String(item[0]), String(item[1] ?? item[0])]);
            else if (typeof item === 'string' || typeof item === 'number') pairs.push([String(item), String(item)]);
          }
        } else {
          for (let i = 0; i < parsed.strings.length; i += 2) pairs.push([parsed.strings[i]!, parsed.strings[i + 1] ?? parsed.strings[i]!]);
        }
        for (const [v, label] of pairs) {
          const value = cutChars(oneLine(v), NAME_MAX);
          if (value !== '' && !options.some((o) => o.value === value)) options.push({ value, labelId: cutChars(oneLine(label), NAME_MAX) || value, labelEn: null });
        }
        if (options.length === 0) type = 'text';
      }
      defs.push({
        id: `~${code}`,
        code,
        type,
        labelId: code,
        labelEn: null,
        options,
        required: false,
        sortOrder: Math.max(0, intOf(row['field_id']) ?? 0),
        isPublic: false,
        isSearchable: false,
        archived: false,
      });
    });
    return defs;
  });
}

/** The definitions of the item fields and, per `cf_*` column, the one that takes it. */
async function itemDefs(c: SlimsStageContext, io: BatchIo, columns: readonly string[]): Promise<{ defs: CustomFieldDef[]; byColumn: Map<string, CustomFieldDef> }> {
  const byColumn = new Map<string, CustomFieldDef>();
  if (io.trx !== null) {
    const mapped = await targetsOf(c, io.db, 'mst_custom_field', columns);
    const defs = await loadCustomDefs(io.db, 'items');
    const byId = new Map(defs.map((d) => [d.id, d]));
    for (const column of columns) {
      const def = byId.get(mapped.get(column) ?? '');
      if (def !== undefined) byColumn.set(column, def);
    }
    return { defs, byColumn };
  }
  const defs = await sourceItemDefs(c);
  for (const column of columns) {
    const def = defs.find((d) => d.code === column);
    if (def !== undefined) byColumn.set(column, def);
  }
  return { defs, byColumn };
}

/** Multi-line text: C0 controls but tab, line feed and carriage return removed, DEL too; trimmed. */
function multiLine(s: string): string {
  let out = '';
  for (const ch of s) {
    const code = ch.charCodeAt(0);
    if ((code < 0x20 && code !== 0x09 && code !== 0x0a && code !== 0x0d) || code === 0x7f) continue;
    out += ch;
  }
  return out.trim();
}

/** A list as coerceCustomValues reads a multiselect: joined with `|`, a literal `|` as `\|`. */
function pipes(list: readonly string[]): string {
  return list.map((s) => s.replace(/\|/g, '\\|')).join('|');
}

/** The custom values of one `item_custom` row, checked against `defs` (S19); refused values reported and left out. */
function customValues(log: Ledger, key: string, row: SlimsRow, defs: readonly CustomFieldDef[], byColumn: ReadonlyMap<string, CustomFieldDef>): Record<string, unknown> {
  const raw: [string, string][] = [];
  for (const [column, def] of byColumn) {
    const cell = textOf(log, TC, column, row[column]);
    if (cell === null) continue;
    let s = def.type === 'longtext' ? multiLine(cell) : oneLine(cell);
    if (s === '') continue;
    if (def.type === 'multiselect') {
      const parsed = phpUnserialize(s);
      const list = parsed.ok ? listOf(parsed.value).filter((x) => typeof x === 'string' || typeof x === 'number').map(String) : parsed.strings;
      if (!parsed.ok) {
        log.fixed(`${TC}.${column}`, ['php'], s, JSON.stringify(list));
        log.report(TC, key, 'php_broken', `${column}: ${list.length} teks terbaca / strings recovered`);
      }
      s = pipes(list.map((x) => oneLine(x)).filter((x) => x !== ''));
    } else if (def.type === 'date') {
      const date = cleanDate(s);
      if (date === null) {
        log.fixed(`${TC}.${column}`, ['date'], s, '');
        log.report(TC, key, 'date_invalid', `${column}=${cutChars(s, 40)}`);
        continue;
      }
      s = date.slice(0, 10);
    } else if (def.type === 'text') {
      s = fitChars(log, TC, key, column, s, CUSTOM_TEXT_MAX) ?? '';
    } else if (def.type === 'longtext') {
      s = fitText(log, TC, key, column, s) ?? '';
    }
    if (s !== '') raw.push([def.code, s]);
  }
  const given = Object.fromEntries(raw);
  const coerced = coerceCustomValues(defs, given);
  for (const e of coerced.errors) {
    const code = e.path.replace(/^custom\./, '');
    log.report(TC, key, 'custom_value_invalid', `${code}=${cutChars(given[code] ?? '', 60)}`);
  }
  // The definitions' schema (S19): a value it refuses is reported and left out; the others are kept.
  const schema = customValuesSchema(defs, 'patch');
  let values: Record<string, unknown> = coerced.values;
  for (let round = 0; round < 8 && Object.keys(values).length > 0; round += 1) {
    const parsed = schema.safeParse(values);
    if (parsed.success) return parsed.data;
    const bad = new Set(parsed.error.issues.map((issue) => String(issue.path[0] ?? '')));
    if (bad.has('')) return {};
    for (const code of bad) {
      log.report(TC, key, 'custom_value_invalid', `${code}=${cutChars(given[code] ?? '', 60)}`);
      values = Object.fromEntries(Object.entries(values).filter(([k]) => k !== code));
    }
  }
  return values;
}

async function customBatch(c: SlimsStageContext, rows: readonly SlimsRow[], io: BatchIo, l: Ledger, first: boolean, columns: readonly string[]): Promise<void> {
  const { defs, byColumn } = await itemDefs(c, io, columns);
  if (first) {
    for (const column of columns) {
      if (!byColumn.has(column)) l.report(TC, null, 'custom_column_unmapped', `${column}: tanpa definisi ruas / no field definition`);
    }
  }
  const keyed: { key: string; row: SlimsRow }[] = [];
  const seen = new Set<string>();
  for (const row of rows) {
    const key = keyOf(row['item_id']);
    if (!keyFits(key)) {
      l.skipped(TC, 'empty_key');
      l.report(TC, null, 'empty_key', 'item_id kosong / empty');
    } else if (seen.has(key)) {
      l.skipped(TC, 'duplicate_key');
      l.report(TC, key, 'duplicate_key', 'item_id ganda / repeated');
    } else {
      seen.add(key);
      keyed.push({ key, row });
    }
  }
  const mapped = await mappedRows(c, io.db, TC, keyed.map((k) => k.key));
  const targets = io.trx === null ? null : await targetsOf(c, io.db, T, keyed.map((k) => k.key));
  const present = io.trx === null ? await sourceKeys(c, T, 'item_id') : null;
  const maps: LegacyMapping[] = [];
  for (const { key, row } of keyed) {
    const state = stateOf(c, mapped.get(key));
    if (state === 'done') {
      l.skipped(TC, 'already_migrated');
      continue;
    }
    const itemId = state === 'replay' ? mapped.get(key)!.targetId : targets !== null ? (targets.get(key) ?? null) : present!.has(key) ? `~${key}` : null;
    if (itemId === null) {
      l.skipped(TC, 'orphan');
      l.report(TC, key, 'item_missing', `item_id=${cutChars(key, 40)}`);
      continue;
    }
    const values = customValues(l, key, row, defs, byColumn);
    if (Object.keys(values).length === 0) {
      l.skipped(TC, 'no_values');
      continue;
    }
    l.migrated(TC);
    if (io.trx === null || state === 'replay') continue;
    await writeCustomValues(io.trx, 'items', itemId, values, defs, { now: c.now, actor: null });
    maps.push({ source: c.options.sourceName, entity: TC, legacyKey: key, targetId: itemId, runId: c.runId });
  }
  if (io.trx !== null && maps.length > 0) await mapLegacy(io.trx, maps);
}

// ---- the stage ------------------------------------------------------------------------------------------------------

/** The phases: the items, then their custom values. */
const PHASES = [T, TC] as const;

/** Items (§11.3 step 5, §11.4): see the top of this file. */
export const itemsStage: SlimsStage = Object.freeze({
  name: 'items' as const,
  reads: Object.freeze([T, TC, STATUS]) as readonly string[],
  async run(c: SlimsStageContext, cursor: string | null): Promise<{ done: boolean; cursor: string | null }> {
    let at = readCursor('items', cursor);
    let batches = 0;
    while (at.p < PHASES.length) {
      if (batches > 0 && c.budgetLeftMs() <= 0) return { done: false, cursor: writeCursor(at) };
      const table = PHASES[at.p]!;
      const info = await tableOf(c, table);
      if (info === null) {
        at = nextPhase(at);
        continue;
      }
      // What the batch needs from the source is read before its transaction (no file or source read inside one).
      const statuses = table === T ? await statusRows(c) : new Map<string, SlimsStatusRow>();
      const columns = info.columns.filter((column) => /^cf_/i.test(column));
      // A dry run takes the barcodes given so far for this batch; they are kept again only when it succeeded.
      const dry = c.dryRun && table === T ? await dryTaken(c, at.c) : null;
      const batch = await c.source.rows(table, at.c, stageBBatch());
      batches += 1;
      const next = sourceCursor('items', batch.rows.length === 0 ? null : batch.next);
      const first = at.c === null;
      const { ledger } = await inBatch(c, at, async (io, l) => {
        if (batch.rows.length === 0) return;
        if (table === T) await itemBatch(c, batch.rows, io, l, dry, statuses);
        else await customBatch(c, batch.rows, io, l, first, columns);
      });
      ledger.apply(c);
      if (dry !== null && next !== null) setRunValue(c, DRY_BARCODES, { at: next, taken: dry } satisfies DryBarcodes);
      const carried = ledger.state();
      at = next === null ? nextPhase({ ...at, ...carried }) : { ...at, ...carried, c: next, i: 0, n: at.n + batch.rows.length };
    }
    return endOfStage(c, 'items', at);
  },
});
