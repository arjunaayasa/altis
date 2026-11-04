// The SLiMS CSV layouts (Phase 2 spec §5.2, `csv-slims` and `csv-slims-items`, import only). Only their column
// orders are taken from SLiMS 9 (interoperability facts, no SLiMS code): the data format may be read, the code may not
// be copied (clean-room, §1.3).
//
// - Records: 18 columns without a header, multi-values written `<a><b>`. The same layout is what the CDS/ISIS
//   (WinISIS) export format writes, one record per line ending in `#`: that `#` is dropped, whether it is attached to
//   the last cell or a cell of its own. ISBD punctuation that ends a value (`Jakarta :`, `Hirata, Andrea,`) is dropped.
//   GMD, cover image and language come as names, so they are returned beside the draft for the import to look up;
//   every author is a person with the role `aut` (the first one the main entry), every topic a `topic`; the item codes
//   are returned as `itemCodes` (the draft's `items` stay empty).
// - Items: 19 columns in the SLiMS item export order; masters by name, the parent by its exact title. `source` 1/2
//   (purchase/gift), a SLiMS empty date `0000-00-00`, a date with a time.
// - The SLiMS export writes a line break inside a value as the two characters `\n`: they are read back as one.
// - A header row is skipped only when it equals the known header (isSlimsCsvHeader), never because its first cell is
//   `title`: a book may be called that.
// Pure; no I/O.

import { ACQ_SOURCES, type AcqSource } from '@altis/shared';
import type { RecordDraft } from '@altis/shared/api/catalog/record-data';
import { CellReader, hasExtraCells, oneLine, readYear, trimIsbd, type CsvFieldError } from './multi.js';
import { AgentList, IdentifierList, SubjectList } from './records.js';

/** The 18 record columns of the SLiMS biblio export (and of WinISIS' ISISEXP format), in order. */
export const SLIMS_RECORD_COLUMNS = Object.freeze([
  'title',
  'gmd_name',
  'edition',
  'isbn_issn',
  'publisher_name',
  'publish_year',
  'collation',
  'series_title',
  'call_number',
  'language_name',
  'place_name',
  'classification',
  'notes',
  'image',
  'sor',
  'authors',
  'topics',
  'item_code',
] as const);

/** The 19 columns of the SLiMS item export, in order. */
export const SLIMS_ITEM_COLUMNS = Object.freeze([
  'item_code',
  'call_number',
  'coll_type_name',
  'inventory_code',
  'received_date',
  'supplier_name',
  'order_no',
  'location_name',
  'order_date',
  'item_status_name',
  'site',
  'source',
  'invoice',
  'price',
  'price_currency',
  'invoice_date',
  'input_date',
  'last_update',
  'title',
] as const);

/** One SLiMS record row read. */
export interface SlimsCsvRecordRead {
  draft: RecordDraft;
  /** The GMD's name (`gmd_name`): the import maps it to a material type. */
  gmdName: string | null;
  /** The cover's file name (`image`); the file itself is not in the CSV. */
  imageName: string | null;
  /** The language's name (`language_name`, or a code in a WinISIS export): the import looks it up. */
  languageName: string | null;
  /** The item codes (`item_code`), each once, in order. */
  itemCodes: string[];
  errors: CsvFieldError[];
}

/** One SLiMS item row read: names as written, dates `YYYY-MM-DD`, a price as a decimal string. */
export interface SlimsItemCsvRow {
  itemCode: string;
  callNumber?: string;
  collTypeName?: string;
  inventoryCode?: string;
  receivedDate?: string;
  supplierName?: string;
  orderNo?: string;
  locationName?: string;
  orderDate?: string;
  itemStatusName?: string;
  /** The shelf location text. */
  site?: string;
  source?: AcqSource;
  invoice?: string;
  price?: string;
  priceCurrency?: string;
  invoiceDate?: string;
  /** SLiMS' own creation and change times, as written. */
  inputDate?: string;
  lastUpdate?: string;
  /** The parent record's title, cleaned as slimsCsvRecord cleans one (ISBD end punctuation dropped) for an exact match. */
  title: string;
}

/** A SLiMS cell: the `\n` the export writes for a line break (also `\r\n`, `\r`) read back as one. */
function slimsCell(raw: string | undefined): string {
  return (raw ?? '').replace(/\\r\\n|\\n|\\r/g, '\n');
}

/** A one-line value without the ISBD punctuation that ends it. */
function plain(s: string): string {
  return trimIsbd(oneLine(s));
}

/** The values of a `<a><b>` cell; a cell without brackets is one value. */
function slimsValues(cell: string): string[] {
  const t = cell.trim();
  if (t === '') return [];
  const values = t.startsWith('<') && t.endsWith('>') ? t.slice(1, -1).split(/>\s*</) : [t];
  return values.map(plain).filter((v) => v !== '');
}

/** True when `cells` are the known header of `kind` (names trimmed, any case; empty cells after them ignored). */
export function isSlimsCsvHeader(cells: readonly string[], kind: 'records' | 'items'): boolean {
  const columns: readonly string[] = kind === 'records' ? SLIMS_RECORD_COLUMNS : SLIMS_ITEM_COLUMNS;
  let n = cells.length;
  while (n > 0 && cells[n - 1]!.trim() === '') n--;
  return n === columns.length && columns.every((c, i) => cells[i]!.trim().toLowerCase() === c);
}

/** `errors` in column order (the row error first). */
function byColumn(errors: CsvFieldError[], columns: readonly string[]): CsvFieldError[] {
  return errors
    .map((e, i) => ({ e, i, at: columns.indexOf(e.column) }))
    .sort((a, b) => a.at - b.at || a.i - b.i)
    .map((x) => x.e);
}

/** One SLiMS (or WinISIS) record row of 18 cells; see the top of this file. */
export function slimsCsvRecord(cells: readonly string[]): SlimsCsvRecordRead {
  const r = new CellReader();
  let cs = cells;
  if (cs.length > SLIMS_RECORD_COLUMNS.length && cs[cs.length - 1]!.trim() === '#') cs = cs.slice(0, -1);
  if (hasExtraCells(cs, SLIMS_RECORD_COLUMNS.length)) r.error('', 'too_many_cells');
  const c = (i: number) => slimsCell(cs[i]);

  const title = r.line('title', plain(c(0)));
  if (title === undefined && !r.errors.some((e) => e.column === 'title')) r.error('title', 'required');
  const draft: RecordDraft = {
    materialTypeCode: null,
    title: title ?? '',
    publisher: null,
    identifiers: [],
    agents: [],
    subjects: [],
    links: [],
    items: [],
    marcExtra: [],
  };
  const put = <K extends keyof RecordDraft>(key: K, value: RecordDraft[K] | undefined): void => {
    if (value !== undefined) draft[key] = value;
  };
  const gmdName = r.short('gmd_name', plain(c(1)), 191) ?? null;
  put('edition', r.short('edition', plain(c(2)), 191));
  const ids = new IdentifierList();
  ids.add(r, 'isbn_issn', c(3));
  draft.identifiers = ids.list;
  const publisher = r.short('publisher_name', plain(c(4)), 191);
  const year = readYear(r, 'publish_year', c(5));
  put('publicationYear', year.publicationYear);
  put('publicationDateText', year.publicationDateText);
  put('physicalDesc', r.short('collation', plain(c(6)), 191));
  put('series', r.short('series_title', plain(c(7)), 191));
  put('callNumber', r.short('call_number', c(8), 64));
  const languageName = r.short('language_name', c(9), 191) ?? null;
  const place = r.short('place_name', plain(c(10)), 191);
  if (publisher !== undefined) draft.publisher = place === undefined ? { name: publisher } : { name: publisher, place };
  put('publicationPlace', place);
  put('classification', r.short('classification', c(11), 64));
  put('notes', r.text('notes', c(12)));
  const imageName = r.short('image', c(13), 191) ?? null;
  put('responsibility', r.line('sor', plain(c(14))));

  const agents = new AgentList();
  for (const name of slimsValues(c(15))) agents.add(r, 'authors', { type: 'person', name, role: 'aut' });
  draft.agents = agents.list;
  const subjects = new SubjectList();
  for (const term of slimsValues(c(16))) subjects.add(r, 'topics', { type: 'topic', term });
  draft.subjects = subjects.list;

  const itemCodes: string[] = [];
  for (const code of slimsValues(c(17).replace(/#\s*$/, ''))) {
    if (code.length > 200) r.error('item_code', 'too_big');
    else if (!itemCodes.includes(code)) itemCodes.push(code);
  }

  return { draft, gmdName, imageName, languageName, itemCodes, errors: byColumn(r.errors, SLIMS_RECORD_COLUMNS) };
}

/** The SLiMS `source` of an item: 1 purchase, 2 gift (also the ALTIS words); 0 or empty: none. */
function readSource(r: CellReader, raw: string): AcqSource | undefined {
  const v = oneLine(raw).toLowerCase();
  if (v === '' || v === '0') return undefined;
  if (v === '1') return 'purchase';
  if (v === '2') return 'gift';
  if ((ACQ_SOURCES as readonly string[]).includes(v)) return v as AcqSource;
  return r.error('source', 'invalid_value');
}

/** One SLiMS item row of 19 cells. */
export function slimsCsvItem(cells: readonly string[]): { row: SlimsItemCsvRow; errors: CsvFieldError[] } {
  const r = new CellReader();
  if (hasExtraCells(cells, SLIMS_ITEM_COLUMNS.length)) r.error('', 'too_many_cells');
  const c = (i: number) => slimsCell(cells[i]);

  let itemCode = c(0).trim();
  if (itemCode === '') r.error('item_code', 'required');
  else if (itemCode.length > 200) {
    r.error('item_code', 'too_big');
    itemCode = '';
  }
  const row: SlimsItemCsvRow = { itemCode, title: '' };
  const put = <K extends keyof SlimsItemCsvRow>(key: K, value: SlimsItemCsvRow[K] | undefined): void => {
    if (value !== undefined) row[key] = value;
  };
  const date = (column: string, i: number) => r.date(column, c(i), { withTime: true, zero: true });
  put('callNumber', r.short('call_number', c(1), 64));
  put('collTypeName', r.short('coll_type_name', c(2), 191));
  put('inventoryCode', r.short('inventory_code', c(3), 64));
  put('receivedDate', date('received_date', 4));
  put('supplierName', r.short('supplier_name', c(5), 191));
  put('orderNo', r.short('order_no', c(6), 64));
  put('locationName', r.short('location_name', c(7), 191));
  put('orderDate', date('order_date', 8));
  put('itemStatusName', r.short('item_status_name', c(9), 191));
  put('site', r.short('site', c(10), 191));
  put('source', readSource(r, c(11)));
  put('invoice', r.short('invoice', c(12), 64));
  put('price', r.price('price', c(13)));
  put('priceCurrency', r.short('price_currency', c(14), 64));
  put('invoiceDate', date('invoice_date', 15));
  put('inputDate', r.short('input_date', c(16), 64));
  put('lastUpdate', r.short('last_update', c(17), 64));
  // Cleaned as slimsCsvRecord cleans a title, so the import's exact title match finds the parent.
  const title = r.line('title', plain(c(18)));
  if (title === undefined && !r.errors.some((e) => e.column === 'title')) r.error('title', 'required');
  row.title = title ?? '';

  return { row, errors: byColumn(r.errors, SLIMS_ITEM_COLUMNS) };
}
