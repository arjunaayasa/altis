import { createHash } from 'node:crypto';
import { fullTextFamily, type DB } from '@altis/db';
import { DomainError, newId, type ItemStatus } from '@altis/shared';
import type { Insertable, Transaction, Updateable } from 'kysely';
import { writeCustomValues } from '../../../catalog/data/custom-fields.js';
import { defaultCollectionTypeId, defaultMaterialTypeId } from '../../../catalog/data/defaults.js';
import { codeKey } from '../../../catalog/data/keys.js';
import { mapLegacy, type LegacyMapping } from '../../../catalog/data/legacy-map.js';
import { writeItemEvents, type ItemEventInput } from '../../../catalog/items/events.js';
import { ARCHIVED_STATUS, archivedAtAfter, canChangeStatus, itemStatusOf } from '../../../catalog/items/lifecycle.js';
import { againOnBarcodeRace } from '../../../catalog/items/service.js';
import { titleKey } from '../../../catalog/lib/title-key.js';
import { openLoanDueDates } from '../../../circulation/availability.js';
import { txCtx, type Actor } from '../../../context.js';
import { indexRecords, stampChanged } from '../../../search/index-records.js';
import { readSettings } from '../../../settings/service.js';
import { slimsBarcode, withBarcodeSuffix, type SlimsBarcode } from '../maps/barcode.js';
import { slimsAcqSource, slimsItemStatus, type SlimsStatusRow } from '../maps/item-status.js';
import { slimsPrice } from '../maps/price.js';
import { cleanDate } from '../source/clean-text.js';
import type { SlimsRow } from '../source/types.js';
import type { SlimsStage, SlimsStageContext } from '../stage.js';
import { slimsCustomDefs, slimsCustomValues } from './custom-values.js';
import {
  againOnRace,
  cachedForRun,
  cutChars,
  fitChars,
  inBatch,
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
  Ledger,
  type BatchIo,
  type LedgerState,
  type StageCursor,
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
//    - the status (maps/item-status.ts, through `mst_item_status`; `status_unknown`; a copy weeded in SLiMS is made
//      archived), the acquisition source, the price (`priceMode`, maps/price.ts; `price_invalid`, `currency_invalid`),
//      the dates (a zero or invalid date → null, counted as a `date` repair), and `input_on`, the date the copy was
//      entered in SLiMS (`input_date`'s local date; `1970-01-01` → null too);
//    - the room migrated from `location_id`, and inside it one shelf per normalised `site` text (entity `item_site`,
//      key `<room>|<SITE>`; `shelf_hint` = the text cut to 40); an unknown room → no location (`location_unknown`,
//      and `site_unplaced` for its site);
//    - the collection type migrated from `coll_type_id`; 0 or unknown → `catalog.defaultCollectionTypeId`
//      (`collection_type_default`); the supplier migrated from `supplier_id` (`supplier_unknown`);
//    - a real run locks the rows its items go to while they are live (the records, then the collection types, the
//      locations, the suppliers, as every item writer does: items/service.ts), so an admin's archive of one of them
//      (between two slices, or before a re-run) and the batch serialise (only a re-sync archives a row it maps,
//      below): an item whose record (or placeholder) was archived or merged is not written, and is
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
//
// The catalogue re-sync (`catalogMode = sync`): an `item` row an earlier run mapped is not skipped `already_migrated`
// but worked out again as a first run would (its repairs and problems not counted again) and compared with the stored
// copy, source-derived values only (resyncItems): a copy no one edited in ALTIS (`updated_by` null) is rewritten where
// it differs, the status through the item lifecycle (a refused change keeps the status: `status_guard`; a copy out on
// loan keeps its status until it is returned: `status_on_loan`), with one `migrated` history row `{via: 'sync', fields}`
// for a status or location change; a copy edited in ALTIS is left as it is (`edited_in_altis`, the differing fields). It
// is locked first, then the rows it goes to, with the fresh items'. Two phases follow: the mapped items whose source row
// is gone, archived (`source_missing`; a copy out on loan stays live until it is returned, `source_missing_on_loan`, and
// a later re-sync archives it then), and then the mapped records whose source row is gone, archived once they have no
// live item (`source_missing`, else `source_missing_kept`). A dry
// run counts what the sync would write (`changed`, a sync dry run's `catalogChanges`) and lists the rows it would change
// (`sync_change`).

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
  /** `done`: mapped by an earlier run, handled by a re-sync (`catalogMode = sync`). */
  state: 'fresh' | 'replay' | 'done';
  /** The item a `done` row was mapped to. */
  targetId?: string;
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
    input_on: string | null;
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

/**
 * `item.input_date` as `items.input_on`: the date the copy was entered in SLiMS, the `YYYY-MM-DD` prefix of the cleaned
 * value (SLiMS keeps the library's local time). A zero, invalid or `1970-01-01` date is null, counted as a `date`
 * repair.
 */
function inputOnOf(l: Ledger, row: SlimsRow): string | null {
  const text = line(l, T, 'input_date', row);
  if (text === '') return null;
  const date = cleanDate(text);
  if (date === null || date.startsWith('1970-01-01')) {
    l.fixed(`${T}.input_date`, ['date'], text, '');
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
function planItem(c: SlimsStageContext, log: Ledger, key: string, row: SlimsRow, state: Plan['state'], statuses: ReadonlyMap<string, SlimsStatusRow>): Plan {
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
      input_on: inputOnOf(log, row),
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
  const done: Plan[] = [];
  for (const { key, row, log } of keyed) {
    const m = mapped.get(key);
    const state = stateOf(c, m);
    if (state !== 'done') plans.push(planItem(c, log, key, row, state, statuses));
    else if (c.options.catalogMode !== 'sync') log.skipped(T, 'already_migrated');
    // A re-sync works the row out again on a ledger of its own: its repairs and problems were counted when it was
    // first migrated; the row's own ledger gets what the re-sync does with it.
    else done.push({ ...planItem(c, Ledger.of({ s: {}, r: {} }), key, row, 'done', statuses), log, targetId: m!.targetId });
  }
  if (plans.length === 0 && done.length === 0) {
    l.join(logs);
    return;
  }

  // A re-sync's items, read first: in a real run with a locking read, before any other row is locked (the items, then
  // their records and masters: the order of every item writer, items/service.ts).
  const trx = io.trx;
  const stored = done.length === 0 ? new Map<string, StoredItem>() : await storedItems(io, done.map((p) => p.targetId!));
  const present = done.filter((p) => stored.has(p.targetId!));
  for (const p of done) {
    if (stored.has(p.targetId!)) continue;
    p.log.skipped(T, 'target_missing');
  }

  // Lookups: the legacy map in a real run (for the re-synced items too), the source in a dry run (which mapped
  // nothing; its re-synced items look the legacy map up below, dryTargets).
  const known = async (entity: string, table: string, column: string, keys: readonly string[]): Promise<(k: string) => string | null> => {
    if (trx !== null) {
      const targets = await targetsOf(c, trx, entity, keys);
      return (k) => targets.get(k) ?? null;
    }
    const sourced = await sourceKeys(c, table, column);
    return (k) => (sourced.has(k) ? `~${k}` : null);
  };
  const looked = trx === null ? plans : [...plans, ...present];
  const record = await known('biblio', 'biblio', 'biblio_id', looked.map((p) => p.biblioKey));
  const room = await known('mst_location', 'mst_location', 'location_id', looked.map((p) => p.roomKey));
  const collectionType = await known('mst_coll_type', 'mst_coll_type', 'coll_type_id', looked.map((p) => p.collectionType));
  const supplier = await known('mst_supplier', 'mst_supplier', 'supplier_id', looked.map((p) => p.supplier));
  const configured = (await readSettings(io.db, ['catalog.defaultCollectionTypeId'], []))['catalog.defaultCollectionTypeId'] as string | null;
  const fallbackType = await defaultCollectionTypeId(io.db, configured);
  // A room of another branch (this source migrated before into another branch) cannot hold this branch's items.
  const ownRooms = new Set<string>();
  if (trx !== null) {
    const roomIds = [...new Set(looked.map((p) => (p.roomKey === '' ? null : room(p.roomKey))).filter((id): id is string => id !== null))];
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

  // A real run: the placeholders of the orphans, then the rows the fresh (and re-synced) items go to locked while live
  // (see below).
  const maps: LegacyMapping[] = [];
  let fresh = plans.filter((p) => p.state === 'fresh');
  let synced = trx === null ? [] : present;
  let placeholder = new Map<string, string>();
  const recordOf = (p: Plan): string => record(p.biblioKey) ?? placeholder.get(p.biblioKey)!;
  let fates = new Map<string, Fate>();
  let shelves = new Map<string, string | null>();
  if (trx !== null && fresh.length + synced.length > 0) {
    const writing = [...fresh, ...synced];
    const orphanKeys = writing.filter((p) => record(p.biblioKey) === null).map((p) => p.biblioKey);
    if (orphanKeys.length > 0) placeholder = await placeholders(c, trx, orphanKeys, maps);
    fates = await lockTargets(trx, writing, { recordOf, typeOf, roomOf: ownRoom, fallbackType });
    fresh = fresh.filter((p) => !fates.get(p.key)!.stranded);
    synced = synced.filter((p) => !fates.get(p.key)!.stranded);
    const placed = [...fresh, ...synced];
    shelves = await shelvesFor(
      c,
      trx,
      placed.flatMap((p) => {
        const id = fates.get(p.key)!.roomArchived ? null : ownRoom(p);
        return id === null || p.site === null ? [] : [{ roomKey: p.roomKey, roomId: id, site: p.site }];
      }),
      maps,
    );
    for (const p of placed) {
      const id = ownRoom(p);
      if (id !== null && !fates.get(p.key)!.roomArchived && p.site !== null && shelves.get(`${id}|${codeKey(p.site)}`) === null) fates.get(p.key)!.shelfArchived = true;
    }
    const suppliers = await lockLive(trx, 'suppliers', placed.map(supplierOf).filter((id): id is string => id !== null));
    for (const p of placed) {
      const id = supplierOf(p);
      if (id !== null && !suppliers.has(id)) fates.get(p.key)!.supplierArchived = true;
    }
  }

  // Barcodes: given now to the fresh items, read back for the items this run wrote already (and, from what those were
  // stored with, the fallbacks their first pass took, so a replay reports them alike).
  const taken = dry ?? new Set<string>();
  const given = await assignBarcodes(io.db, fresh.map((p) => p.barcode.barcode), taken);
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
      const storedRow = p.state === 'replay' ? byId.get(mapped.get(p.key)!.targetId) : undefined;
      if (storedRow === undefined) continue;
      barcodeOf.set(p.key, storedRow.barcode_key);
      fates.set(p.key, storedFate(p, storedRow, { typeOf, roomOf: ownRoom, supplierOf }));
    }
  }
  const fateOf = (p: Plan): Fate => fates.get(p.key) ?? NO_FALLBACK;
  /** Where the item is placed: its room unless archived, the room's shelf of its site unless archived (then the room). */
  const placedRoom = (p: Plan): string | null => (fateOf(p).roomArchived ? null : ownRoom(p));
  const locationOf = (p: Plan): string | null => {
    const roomId = placedRoom(p);
    const shelf = roomId === null || p.site === null ? null : shelves.get(`${roomId}|${codeKey(p.site)}`);
    return roomId === null ? null : (shelf ?? roomId);
  };

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
    log.changed(T);
  }

  // The re-sync of the items an earlier run mapped: what a first run would write now, against what is stored.
  const wanted = new Map<string, ItemWanted>();
  if (trx !== null) {
    for (const p of present) {
      if (fateOf(p).stranded) continue;
      const fate = fateOf(p);
      wanted.set(p.key, {
        record_id: recordOf(p),
        location_id: locationOf(p),
        collection_type_id: fate.typeArchived ? fallbackType : (typeOf(p) ?? fallbackType),
        supplier_id: fate.supplierArchived ? null : supplierOf(p),
      });
    }
  } else if (present.length > 0) {
    for (const [key, w] of await dryTargets(c, io.db, present, fallbackType)) wanted.set(key, w);
  }
  const resync = await resyncItems(c, io, present, { stored, wanted, taken });
  l.join(logs);
  if (trx === null) return;
  if (fresh.length === 0 && resync.events.length === 0 && resync.records.length === 0) {
    if (maps.length > 0) await mapLegacy(trx, maps);
    return;
  }

  // A real run writes the fresh items whose record is live.
  const recordIds = [...new Set([...fresh.map(recordOf), ...resync.records])];
  const items: Insertable<DB['items']>[] = fresh.map((p) => {
    const fate = fateOf(p);
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
      location_id: locationOf(p),
      supplier_id: fate.supplierArchived ? null : supplierOf(p),
      // A copy weeded in SLiMS is archived as it is made (an archived item is `withdrawn` with `archived_at`).
      archived_at: p.columns.status === ARCHIVED_STATUS ? c.now : null,
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
  await writeItemEvents(txCtx(trx, c.now, SYSTEM), [
    ...items.map((it) => ({ itemId: it.id as string, type: 'migrated' as const, toStatus: it.status as ItemStatus, toLocationId: it.location_id ?? null })),
    ...resync.events,
  ]);
  await mapLegacy(trx, maps);
  await indexRecords(trx, recordIds, c.now);
  // The datestamp last, from the clock read right before the COMMIT (C14).
  await stampChanged(trx, recordIds, c.clock());
}

// ---- the catalogue re-sync of items mapped by an earlier run --------------------------------------------------------

/** What a re-sync reads of a stored item. */
interface StoredItem {
  id: string;
  record_id: string;
  barcode_key: string;
  inventory_no: string | null;
  call_number: string | null;
  status: string;
  status_note: string | null;
  acq_source: string | null;
  order_no: string | null;
  order_date: string | null;
  received_date: string | null;
  invoice_date: string | null;
  invoice_no: string | null;
  price: number | string | bigint | null;
  currency: string | null;
  input_on: string | null;
  collection_type_id: string;
  location_id: string | null;
  supplier_id: string | null;
  archived_at: number | string | bigint | null;
  updated_by: string | null;
  version: number | string | bigint;
}

/** The rows an item points to, as a first run would choose them now (its record, place, collection type, supplier). */
interface ItemWanted {
  record_id: string;
  location_id: string | null;
  collection_type_id: string;
  supplier_id: string | null;
}

/**
 * The item fields a re-sync compares and writes, by the name its report rows and history give: the source-derived
 * columns only. The bookkeeping (`created_at`, `updated_at`, `created_by`, `updated_by`, `version`) is never compared
 * and never written from the source, and neither are the columns staff fill (`note`, `parts_total`) or the branch.
 */
const ITEM_SYNC_FIELDS = Object.freeze([
  ['inventoryNo', 'inventory_no'],
  ['callNumber', 'call_number'],
  ['statusNote', 'status_note'],
  ['acqSource', 'acq_source'],
  ['orderNo', 'order_no'],
  ['orderDate', 'order_date'],
  ['receivedDate', 'received_date'],
  ['invoiceDate', 'invoice_date'],
  ['invoiceNo', 'invoice_no'],
  ['price', 'price'],
  ['currency', 'currency'],
  ['inputOn', 'input_on'],
] as const satisfies readonly (readonly [string, keyof StoredItem & keyof Plan['columns']])[]);

/** The numeric columns a re-sync compares (by value, whatever type a driver reads them back as). */
const NUMERIC_COLUMNS: ReadonlySet<string> = new Set(['price']);

/** A stored or computed cell of `column` as compared: a number by value, text as it is. */
function cellOf(column: string, v: unknown): string | number | null {
  if (v === null || v === undefined) return null;
  if (typeof v === 'bigint' || NUMERIC_COLUMNS.has(column)) return Number(v);
  if (typeof v === 'number' || typeof v === 'string') return v;
  return String(v);
}

/**
 * The items `ids`, read for a re-sync: in a real run with a locking read (FOR UPDATE where the engine has it; SQLite
 * has one writer), so they are the latest commit and an editor's save waits for the batch.
 */
async function storedItems(io: BatchIo, ids: readonly string[]): Promise<Map<string, StoredItem>> {
  const out = new Map<string, StoredItem>();
  const unique = [...new Set(ids)].sort();
  const locking = io.trx !== null && fullTextFamily(io.trx) !== 'fts5';
  for (let i = 0; i < unique.length; i += ID_BATCH) {
    const q = io.db
      .selectFrom('items')
      .select([
        'id',
        'record_id',
        'barcode_key',
        'inventory_no',
        'call_number',
        'status',
        'status_note',
        'acq_source',
        'order_no',
        'order_date',
        'received_date',
        'invoice_date',
        'invoice_no',
        'price',
        'currency',
        'input_on',
        'collection_type_id',
        'location_id',
        'supplier_id',
        'archived_at',
        'updated_by',
        'version',
      ])
      .where('id', 'in', unique.slice(i, i + ID_BATCH));
    for (const r of await (locking ? q.forUpdate() : q).execute()) out.set(r.id, r as StoredItem);
  }
  return out;
}

/** The ids of `table` among `ids` that are live, read without a lock (a dry run). */
async function liveIds(db: BatchIo['db'], table: LiveTable, ids: readonly string[]): Promise<Set<string>> {
  const unique = [...new Set(ids)];
  const live = new Set<string>();
  for (let i = 0; i < unique.length; i += ID_BATCH) {
    const rows = await db
      .selectFrom(table as 'records')
      .select('id')
      .where('id', 'in', unique.slice(i, i + ID_BATCH))
      .where('archived_at', 'is', null)
      .execute();
    for (const r of rows) live.add(r.id);
  }
  return live;
}

/**
 * A dry run's view of where the items `present` (an earlier run mapped them) would go now, from the legacy map without
 * locks and without making anything: a missing `biblio_id` that has no placeholder yet, or a shelf not made yet, is a
 * row the real run would make (a value no stored row holds, so it counts as a change). An item whose record is archived
 * is left out (the real run leaves it as it is).
 */
async function dryTargets(c: SlimsStageContext, db: BatchIo['db'], present: readonly Plan[], fallbackType: string): Promise<Map<string, ItemWanted>> {
  /**
   * The legacy map's targets of `keys`, and a stand-in for a key the source's `table` has that is not mapped yet (the
   * real run maps it before this stage): a value no stored item holds.
   */
  const lookup = async (entity: string, keys: readonly string[], source?: { table: string; column: string }): Promise<Map<string, string>> => {
    const found = await targetsOf(c, db, entity, keys);
    if (source === undefined) return found;
    const inSource = await sourceKeys(c, source.table, source.column);
    for (const k of keys) if (!found.has(k) && inSource.has(k)) found.set(k, `~${entity}:${k}`);
    return found;
  };
  const records = await lookup('biblio', present.map((p) => p.biblioKey), { table: 'biblio', column: 'biblio_id' });
  const placeholdersOf = await lookup('biblio_missing', present.map((p) => p.biblioKey));
  const rooms = await lookup('mst_location', present.map((p) => p.roomKey), { table: 'mst_location', column: 'location_id' });
  const types = await lookup('mst_coll_type', present.map((p) => p.collectionType), { table: 'mst_coll_type', column: 'coll_type_id' });
  const suppliers = await lookup('mst_supplier', present.map((p) => p.supplier), { table: 'mst_supplier', column: 'supplier_id' });
  const recordOf = (p: Plan): string => records.get(p.biblioKey) ?? placeholdersOf.get(p.biblioKey) ?? `~biblio_missing:${p.biblioKey}`;
  const liveRecords = await liveIds(db, 'records', present.map(recordOf));
  const ownRooms = new Set<string>();
  const roomIds = [...new Set(present.map((p) => rooms.get(p.roomKey)).filter((id): id is string => id !== undefined))];
  for (const id of roomIds) if (id.startsWith('~')) ownRooms.add(id);
  for (let i = 0; i < roomIds.length; i += ID_BATCH) {
    const own = await db.selectFrom('locations').select('id').where('id', 'in', roomIds.slice(i, i + ID_BATCH)).where('branch_id', '=', c.options.branchId).execute();
    for (const r of own) ownRooms.add(r.id);
  }
  const liveRooms = await liveIds(db, 'locations', [...ownRooms]);
  const live = (set: ReadonlySet<string>, id: string): boolean => id.startsWith('~') || set.has(id);
  const roomOf = (p: Plan): string | null => {
    const id = p.roomKey === '' ? undefined : rooms.get(p.roomKey);
    return id !== undefined && ownRooms.has(id) && live(liveRooms, id) ? id : null;
  };
  const shelfKey = (p: Plan): string => shelfLegacyKey(p.roomKey, codeKey(p.site!));
  const shelfIds = await lookup('item_site', present.flatMap((p) => (roomOf(p) === null || p.site === null ? [] : [shelfKey(p)])));
  const liveShelves = await liveIds(db, 'locations', [...shelfIds.values()]);
  const typeKey = (p: Plan): string | null => (p.collectionType === '' || p.collectionType === '0' ? null : (types.get(p.collectionType) ?? null));
  const liveTypes = await liveIds(db, 'collection_types', present.map(typeKey).filter((id): id is string => id !== null));
  const supplierKey = (p: Plan): string | null => (p.supplier === '' || p.supplier === '0' ? null : (suppliers.get(p.supplier) ?? null));
  const liveSuppliers = await liveIds(db, 'suppliers', present.map(supplierKey).filter((id): id is string => id !== null));
  const out = new Map<string, ItemWanted>();
  for (const p of present) {
    const recordId = recordOf(p);
    if (!recordId.startsWith('~') && !liveRecords.has(recordId)) continue;
    const roomId = roomOf(p);
    let location: string | null = roomId;
    if (roomId !== null && p.site !== null) {
      const legacy = shelfKey(p);
      const shelf = shelfIds.get(legacy);
      location = shelf === undefined ? `~item_site:${legacy}` : liveShelves.has(shelf) ? shelf : roomId;
    }
    const type = typeKey(p);
    const supplierId = supplierKey(p);
    out.set(p.key, {
      record_id: recordId,
      location_id: location,
      collection_type_id: type !== null && live(liveTypes, type) ? type : fallbackType,
      supplier_id: supplierId !== null && live(liveSuppliers, supplierId) ? supplierId : null,
    });
  }
  return out;
}

/** Whether `stored` is `base` with the suffix a first run gave it to tell two items apart (`-2`, `-3`, …). */
function suffixed(stored: string, base: string): boolean {
  const m = /-(\d{1,6})$/.exec(stored);
  if (m === null) return false;
  const n = Number(m[1]);
  return n >= 2 && withBarcodeSuffix(base, n) === stored;
}

/**
 * The barcode a re-synced item gets: the one stored when it is still the source's code (as given, or with the suffix a
 * collision gave it); else the source's code made unique as a first run makes it (the first suffix `-2`, `-3`, … that
 * no other item and no code given in this batch holds), added to `taken`.
 */
async function resyncedBarcode(db: BatchIo['db'], itemId: string, stored: string, base: string, taken: Set<string>): Promise<string> {
  if (stored === base || suffixed(stored, base)) return stored;
  const takenByOther = async (code: string): Promise<boolean> =>
    (await db.selectFrom('items').select('id').where('barcode_key', '=', code).where('id', '<>', itemId).executeTakeFirst()) !== undefined;
  let code = base;
  for (let n = 2; taken.has(code) || (await takenByOther(code)); n += 1) code = withBarcodeSuffix(base, n);
  taken.add(code);
  return code;
}

/**
 * The re-sync of the items `present` (an earlier run mapped them, `catalogMode = sync`; see the top of this file):
 * what a first run would write now (`wanted`: the rows it points to; the plan: every other source-derived value)
 * against what is stored. Per item, on its own ledger:
 * - no difference → migrated (unchanged);
 * - edited in ALTIS (`updated_by` set) → skipped `edited_in_altis`, reported with the differing fields, left as it is;
 * - a status change the lifecycle refuses (`checkTransition`) keeps the stored status, reported `status_guard`; so does
 *   one of a copy out on loan (an open loan keeps the item as it is until it is returned), reported `status_on_loan`;
 * - otherwise the differing columns are written (`version + 1`, `updated_at = now`, `updated_by` stays null; a change
 *   to `withdrawn` archives the item, one from it clears `archived_at`), and a status or location change writes one
 *   `migrated` history row `{via: 'sync', fields}`: migrated and changed.
 * An item whose record is archived is skipped `record_archived`, as a fresh one. A dry run counts and reports alike and
 * writes nothing.
 *
 * @returns the history rows to write and the records whose index and datestamp to renew (a real run)
 */
async function resyncItems(
  c: SlimsStageContext,
  io: BatchIo,
  present: readonly Plan[],
  o: { stored: ReadonlyMap<string, StoredItem>; wanted: ReadonlyMap<string, ItemWanted>; taken: Set<string> },
): Promise<{ events: ItemEventInput[]; records: string[] }> {
  const events: ItemEventInput[] = [];
  const records: string[] = [];
  // The open loans of the copies whose status the sync would change (locked: see openLoanDueDates).
  const statusChanges = present.flatMap((p) => {
    const s = o.stored.get(p.targetId!)!;
    return s.updated_by === null && itemStatusOf(s.status) !== p.columns.status ? [s.id] : [];
  });
  const onLoan = statusChanges.length === 0 ? new Map<string, string>() : await openLoanDueDates(io.db, statusChanges, { lock: io.trx !== null });
  for (const p of present) {
    const log = p.log;
    const before = o.stored.get(p.targetId!)!;
    const want = o.wanted.get(p.key);
    if (want === undefined) {
      log.report(T, p.key, 'record_archived', `biblio_id=${cutChars(p.biblioKey, 40)}`);
      log.skipped(T, 'record_archived');
      continue;
    }
    const barcode = await resyncedBarcode(io.db, before.id, before.barcode_key, p.barcode.barcode, o.taken);
    const set: Record<string, unknown> = {};
    const fields: string[] = [];
    const differs = (name: string, column: string, value: unknown, was: unknown): void => {
      if (cellOf(column, value) === cellOf(column, was)) return;
      fields.push(name);
      set[column] = value;
    };
    differs('record', 'record_id', want.record_id, before.record_id);
    differs('barcode', 'barcode_key', barcode, before.barcode_key);
    for (const [name, column] of ITEM_SYNC_FIELDS) differs(name, column, p.columns[column], before[column]);
    differs('collectionType', 'collection_type_id', want.collection_type_id, before.collection_type_id);
    differs('location', 'location_id', want.location_id, before.location_id);
    differs('supplier', 'supplier_id', want.supplier_id, before.supplier_id);
    const from = itemStatusOf(before.status);
    const to = p.columns.status;
    if (to !== from) fields.push('status');
    if (fields.length === 0) {
      log.migrated(T);
      continue;
    }
    fields.sort();
    if (before.updated_by !== null) {
      log.skipped(T, 'edited_in_altis');
      log.report(T, p.key, 'edited_in_altis', fields.join(','));
      continue;
    }
    let status = from;
    if (to !== from) {
      const refusal = !canChangeStatus(from, to) ? 'status_guard' : onLoan.has(before.id) ? 'status_on_loan' : null;
      if (refusal === null) status = to;
      else {
        fields.splice(fields.indexOf('status'), 1);
        log.report(T, p.key, refusal, `${from} -> ${to}`);
      }
    }
    log.migrated(T);
    if (fields.length === 0) continue;
    log.changed(T);
    // A dry run lists what the real run would change (a real run's history rows tell it).
    if (io.trx === null) {
      log.report(T, p.key, 'sync_change', fields.join(','));
      continue;
    }
    if (set['barcode_key'] !== undefined) set['barcode_display'] = barcode;
    if (status !== from) {
      set['status'] = status;
      set['archived_at'] = archivedAtAfter(from, status, before.archived_at === null ? null : Number(before.archived_at), c.now);
    }
    const updated = await againOnBarcodeRace(() =>
      io.trx!.updateTable('items')
        .set((eb) => ({ ...(set as Updateable<DB['items']>), updated_at: c.now, version: eb('version', '+', 1) }))
        .where('id', '=', before.id)
        .where('version', '=', Number(before.version))
        .where('updated_by', 'is', null)
        .executeTakeFirst(),
    );
    if (Number(updated.numUpdatedRows) !== 1) throw resyncConflict();
    const moved = fields.includes('location');
    if (status !== from || moved) {
      events.push({
        itemId: before.id,
        type: 'migrated',
        ...(status !== from ? { fromStatus: from, toStatus: status } : {}),
        ...(moved ? { fromLocationId: before.location_id, toLocationId: want.location_id } : {}),
        fields,
        via: 'sync',
      });
    }
    records.push(before.record_id, want.record_id);
  }
  return { events, records };
}

/** A row changed between the batch's locking read and its write: the batch runs again (withTx). */
function resyncConflict(): DomainError {
  return new DomainError('TX_CONFLICT', {
    detail: 'Baris katalog baru saja diubah; transaksi diulang / A catalogue row was just changed; the transaction is run again',
    meta: { attempts: 1, code: 'MIGRATION_SYNC_RACE' },
  });
}

// ---- the catalogue re-sync: mapped rows whose source row is gone ---------------------------------------------------

/**
 * The marks a re-sync writes beside the legacy map (same source and key, entity `<entity>:gone`, the run's id) for a
 * mapped row whose source row is gone, once it handled it (archived it, or reported it kept): a later run passes the row
 * over, and a slice of the same run redone after a crash (the mark's run is this one) counts and reports it again as
 * the first attempt did.
 */
const GONE = ':gone';

/** A mapped row of the batch whose source row is gone. */
interface Gone {
  key: string;
  targetId: string;
}

/** Writes the marks of `keys` of `entity` for this run (a mark an earlier run wrote is moved to this run). */
async function markGone(c: SlimsStageContext, trx: Transaction<DB>, entity: string, marks: ReadonlyMap<string, { targetId: string; runId: string }>, gone: readonly Gone[]): Promise<void> {
  const fresh: LegacyMapping[] = [];
  for (const g of gone) {
    if (marks.has(g.key)) {
      await trx
        .updateTable('migration_map')
        .set({ run_id: c.runId, target_id: g.targetId })
        .where('source', '=', c.options.sourceName)
        .where('entity', '=', `${entity}${GONE}`)
        .where('legacy_key', '=', g.key)
        .execute();
    } else {
      fresh.push({ source: c.options.sourceName, entity: `${entity}${GONE}`, legacyKey: g.key, targetId: g.targetId, runId: c.runId });
    }
  }
  if (fresh.length > 0) await mapLegacy(trx, fresh);
}

/**
 * The mapped items of one batch whose source row is gone (see the top of this file): an item no one edited in ALTIS is
 * archived (`withdrawn`, `archived_at`, `version + 1`, a `migrated` history row `{via: 'sync', fields: ['status']}`),
 * reported `source_missing` and counted under `archived` (vanished); one edited in ALTIS is kept, reported
 * `source_missing_kept`; one whose status cannot become `withdrawn` keeps it, reported `status_guard`. Each is handled
 * once (its mark); an item already archived, or gone from ALTIS too, needs nothing. An item no one edited that is out on
 * loan stays live, since its loan could not be returned once it is archived: reported `source_missing_on_loan` (its due
 * date) on each re-sync while the loan is open, neither marked nor counted as a change, and archived by the first
 * re-sync after its return.
 */
async function goneItems(c: SlimsStageContext, io: BatchIo, l: Ledger, gone: readonly Gone[]): Promise<void> {
  const marks = await mappedRows(c, io.db, `${T}${GONE}`, gone.map((g) => g.key));
  const stored = await storedItems(io, gone.map((g) => g.targetId));
  const candidates = [...stored.values()].filter((i) => i.archived_at === null && i.updated_by === null).map((i) => i.id);
  const onLoan = candidates.length === 0 ? new Map<string, string>() : await openLoanDueDates(io.db, candidates, { lock: io.trx !== null });
  const handled: Gone[] = [];
  const events: ItemEventInput[] = [];
  const records: string[] = [];
  for (const g of gone) {
    const mark = marks.get(g.key);
    const item = stored.get(g.targetId);
    if (item === undefined || (mark !== undefined && mark.runId !== c.runId)) continue;
    const from = itemStatusOf(item.status);
    if (mark !== undefined) {
      // Handled by this run's first attempt at the batch: counted and reported as then.
      if (item.archived_at !== null && from === ARCHIVED_STATUS) {
        l.report(T, g.key, 'source_missing', 'withdrawn');
        l.vanished(T);
      } else if (item.updated_by !== null) l.report(T, g.key, 'source_missing_kept', 'edited_in_altis');
      else l.report(T, g.key, 'status_guard', `source_missing: ${from} -> ${ARCHIVED_STATUS}`);
      l.changed(T);
      continue;
    }
    if (item.archived_at !== null) continue;
    const dueOn = item.updated_by === null ? onLoan.get(item.id) : undefined;
    if (dueOn !== undefined) {
      l.report(T, g.key, 'source_missing_on_loan', `due_on=${dueOn}`);
      continue;
    }
    l.changed(T);
    handled.push(g);
    if (item.updated_by !== null) {
      l.report(T, g.key, 'source_missing_kept', 'edited_in_altis');
      continue;
    }
    if (!canChangeStatus(from, ARCHIVED_STATUS)) {
      l.report(T, g.key, 'status_guard', `source_missing: ${from} -> ${ARCHIVED_STATUS}`);
      continue;
    }
    l.report(T, g.key, 'source_missing', 'withdrawn');
    l.vanished(T);
    if (io.trx === null) continue;
    const updated = await io.trx
      .updateTable('items')
      .set((eb) => ({ status: ARCHIVED_STATUS, archived_at: c.now, updated_at: c.now, version: eb('version', '+', 1) }))
      .where('id', '=', item.id)
      .where('version', '=', Number(item.version))
      .where('updated_by', 'is', null)
      .where('archived_at', 'is', null)
      .executeTakeFirst();
    if (Number(updated.numUpdatedRows) !== 1) throw resyncConflict();
    events.push({ itemId: item.id, type: 'migrated', fromStatus: from, toStatus: ARCHIVED_STATUS, fields: ['status'], via: 'sync' });
    records.push(item.record_id);
  }
  if (io.trx === null || handled.length === 0) return;
  await writeItemEvents(txCtx(io.trx, c.now, SYSTEM), events);
  await markGone(c, io.trx, T, marks, handled);
  await indexRecords(io.trx, records, c.now);
  await stampChanged(io.trx, records, c.clock());
}

/**
 * The live items of the records `ids`, per record. A dry run (which archived nothing) leaves out the items the real
 * run's previous phase would archive: mapped items whose source row is gone, no one edited in ALTIS, whose status may
 * become `withdrawn`, and that are not out on loan.
 */
async function liveItemsOf(c: SlimsStageContext, io: BatchIo, ids: readonly string[]): Promise<Map<string, number>> {
  const out = new Map<string, number>();
  const sourceItems = io.trx === null ? await sourceKeys(c, T, 'item_id') : null;
  for (let i = 0; i < ids.length; i += ID_BATCH) {
    const rows = await io.db
      .selectFrom('items as i')
      .leftJoin('migration_map as mm', (join) =>
        join.onRef('mm.target_id', '=', 'i.id').on('mm.source', '=', c.options.sourceName).on('mm.entity', '=', T),
      )
      .select(['i.id', 'i.record_id', 'i.status', 'i.updated_by', 'mm.legacy_key'])
      .where('i.record_id', 'in', ids.slice(i, i + ID_BATCH))
      .where('i.archived_at', 'is', null)
      .execute();
    const going =
      sourceItems === null
        ? []
        : rows.filter(
            (r) =>
              r.legacy_key !== null &&
              !sourceItems.has(r.legacy_key) &&
              r.updated_by === null &&
              canChangeStatus(itemStatusOf(r.status), ARCHIVED_STATUS),
          );
    const lent = going.length === 0 ? new Map<string, string>() : await openLoanDueDates(io.db, going.map((r) => r.id));
    const goes = new Set(going.filter((r) => !lent.has(r.id)).map((r) => r.id));
    for (const r of rows) if (!goes.has(r.id)) out.set(r.record_id, (out.get(r.record_id) ?? 0) + 1);
  }
  return out;
}

/**
 * The mapped records of one batch whose source row is gone (see the top of this file), after the items' phases: a
 * record no one edited in ALTIS without a live item is archived (`archived_at`, `version + 1`, its index and datestamp
 * renewed), reported `source_missing` and counted under `archived` (vanished); one with live items (or edited in ALTIS)
 * is kept, reported `source_missing_kept`, and archived by a later re-sync once its last live item is gone. Each is
 * reported once (its mark).
 */
async function goneRecords(c: SlimsStageContext, io: BatchIo, l: Ledger, gone: readonly Gone[]): Promise<void> {
  const B = 'biblio';
  const marks = await mappedRows(c, io.db, `${B}${GONE}`, gone.map((g) => g.key));
  const stored = new Map<string, { id: string; archived_at: unknown; updated_by: string | null; version: unknown }>();
  const ids = [...new Set(gone.map((g) => g.targetId))].sort();
  const locking = io.trx !== null && fullTextFamily(io.trx) !== 'fts5';
  for (let i = 0; i < ids.length; i += ID_BATCH) {
    const q = io.db.selectFrom('records').select(['id', 'archived_at', 'updated_by', 'version']).where('id', 'in', ids.slice(i, i + ID_BATCH));
    for (const r of await (locking ? q.forUpdate() : q).execute()) stored.set(r.id, r);
  }
  // The live items, read once the records are locked (an item writer locks the record too).
  const live = await liveItemsOf(c, io, ids);
  const handled: Gone[] = [];
  const archived: string[] = [];
  for (const g of gone) {
    const mark = marks.get(g.key);
    const record = stored.get(g.targetId);
    if (record === undefined) continue;
    const items = live.get(g.targetId) ?? 0;
    if (mark !== undefined && mark.runId === c.runId) {
      // Handled by this run's first attempt at the batch: counted and reported as then.
      if (record.archived_at !== null) {
        l.report(B, g.key, 'source_missing', 'archived');
        l.vanished(B);
      } else l.report(B, g.key, 'source_missing_kept', record.updated_by !== null ? 'edited_in_altis' : `items=${items}`);
      l.changed(B);
      continue;
    }
    if (record.archived_at !== null) continue;
    const archive = record.updated_by === null && items === 0;
    // Reported kept by an earlier run: archived once its last live item is gone.
    if (mark !== undefined && !archive) continue;
    l.changed(B);
    handled.push(g);
    if (!archive) {
      l.report(B, g.key, 'source_missing_kept', record.updated_by !== null ? 'edited_in_altis' : `items=${items}`);
      continue;
    }
    l.report(B, g.key, 'source_missing', 'archived');
    l.vanished(B);
    if (io.trx === null) continue;
    const updated = await io.trx
      .updateTable('records')
      .set((eb) => ({ archived_at: c.now, updated_at: c.now, version: eb('version', '+', 1) }))
      .where('id', '=', record.id)
      .where('version', '=', Number(record.version))
      .where('updated_by', 'is', null)
      .where('archived_at', 'is', null)
      .executeTakeFirst();
    if (Number(updated.numUpdatedRows) !== 1) throw resyncConflict();
    archived.push(record.id);
  }
  if (io.trx === null || handled.length === 0) return;
  await markGone(c, io.trx, B, marks, handled);
  await indexRecords(io.trx, archived, c.now);
  await stampChanged(io.trx, archived, c.clock());
}

/**
 * One batch of a re-sync's phase `entity` (`item`, then `biblio`): the next legacy map rows of the entity under the run's
 * source, after the key `at.c`, in key order; those whose source row is gone are handled (goneItems, goneRecords) in one
 * transaction (a dry run: none, writing nothing). A source without the table gives no batch: nothing is taken for gone
 * because a table is missing.
 */
async function goneBatch(c: SlimsStageContext, entity: 'item' | 'biblio', at: StageCursor): Promise<StageCursor> {
  const column = entity === T ? 'item_id' : 'biblio_id';
  if ((await tableOf(c, entity)) === null) return nextPhase(at);
  const inSource = await sourceKeys(c, entity, column);
  const batch = await c.h.db
    .selectFrom('migration_map')
    .select(['legacy_key', 'target_id'])
    .where('source', '=', c.options.sourceName)
    .where('entity', '=', entity)
    .$if(at.c !== null, (q) => q.where('legacy_key', '>', at.c!))
    .orderBy('legacy_key')
    .limit(stageBBatch())
    .execute();
  const gone = batch.filter((r) => !inSource.has(r.legacy_key)).map((r) => ({ key: r.legacy_key, targetId: r.target_id }));
  let carried: LedgerState = { s: at.s, r: at.r };
  if (gone.length > 0) {
    const { ledger } = await inBatch(c, at, async (io, l) => {
      if (entity === T) await goneItems(c, io, l, gone);
      else await goneRecords(c, io, l, gone);
    });
    ledger.apply(c);
    carried = ledger.state();
  }
  const last = batch.at(-1)?.legacy_key;
  return batch.length < stageBBatch() || last === undefined ? nextPhase({ ...at, ...carried }) : { ...at, ...carried, c: sourceCursor('items', last), i: 0, n: at.n + batch.length };
}

// ---- phase 2: custom values -----------------------------------------------------------------------------------------

async function customBatch(c: SlimsStageContext, rows: readonly SlimsRow[], io: BatchIo, l: Ledger, first: boolean, columns: readonly string[]): Promise<void> {
  const { defs, byColumn } = await slimsCustomDefs(c, io, 'items', columns);
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
    const values = slimsCustomValues(l, TC, key, row, defs, byColumn);
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
/** A re-sync's phases after them: the mapped items, then the mapped records, whose source row is gone. */
const GONE_PHASES = [T, 'biblio'] as const;

/** Items (§11.3 step 5, §11.4): see the top of this file. */
export const itemsStage: SlimsStage = Object.freeze({
  name: 'items' as const,
  reads: Object.freeze([T, TC, STATUS]) as readonly string[],
  async run(c: SlimsStageContext, cursor: string | null): Promise<{ done: boolean; cursor: string | null }> {
    let at = readCursor('items', cursor);
    let batches = 0;
    const phases = c.options.catalogMode === 'sync' ? PHASES.length + GONE_PHASES.length : PHASES.length;
    while (at.p < phases) {
      if (batches > 0 && c.budgetLeftMs() <= 0) return { done: false, cursor: writeCursor(at) };
      if (at.p >= PHASES.length) {
        at = await goneBatch(c, GONE_PHASES[at.p - PHASES.length]!, at);
        batches += 1;
        continue;
      }
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
