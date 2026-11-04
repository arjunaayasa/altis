// The ALTIS `csv-items` codec (Phase 2 spec §5.2, K6): one item per row, columns by header name in any order, upsert by
// barcode. The parent is `record_id` or `isbn`, masters and the branch are codes, a price is a decimal (`125000.00`;
// a decimal comma is read too), dates are `YYYY-MM-DD`, `custom.<code>` columns are raw strings (S19).
//
// - The barcode is kept as written (trimmed): the import normalises and checks it (spec §3.4) like every other path.
// - A cell that does not fit its field is reported in `errors` and left out; an empty cell is left out (an update
//   keeps the stored value). The `'` csvCell puts before a formula start is removed.
// Pure; no I/O.

import { ACQ_SOURCES, ITEM_STATUSES, isUlid, type AcqSource, type ItemStatus } from '@altis/shared';
import { parseIsbn } from '../lib/identifiers.js';
import {
  CUSTOM_PREFIX,
  CellReader,
  cachedHeaderIndex,
  customCells,
  hasExtraCells,
  inHeaderOrder,
  oneLine,
  unguard,
  type CsvFieldError,
  type HeaderIndex,
} from './multi.js';

/** The `csv-items` columns of §5.2, in their export order; `custom.<code>` columns follow. */
export const CSV_ITEM_COLUMNS = Object.freeze([
  'barcode',
  'record_id',
  'isbn',
  'branch',
  'location',
  'collection_type',
  'call_number',
  'inventory_no',
  'status',
  'acq_source',
  'order_no',
  'order_date',
  'received_date',
  'supplier',
  'invoice_no',
  'invoice_date',
  'price',
  'currency',
  'parts_total',
  'note',
] as const);

type ItemColumn = (typeof CSV_ITEM_COLUMNS)[number];

/** One `csv-items` row: what the file says about the item with `barcode`; absent fields were empty or not given. */
export interface ItemCsvRow {
  /** As written (trimmed); the import normalises it. Empty only with a `required` or `too_big` error. */
  barcode: string;
  /** The parent record, by id … */
  recordId?: string;
  /** … or by ISBN (as written; it parses as an ISBN). */
  isbn?: string;
  branchCode?: string;
  locationCode?: string;
  collectionTypeCode?: string;
  callNumber?: string;
  inventoryNo?: string;
  status?: ItemStatus;
  acqSource?: AcqSource;
  orderNo?: string;
  orderDate?: string;
  receivedDate?: string;
  supplierCode?: string;
  invoiceNo?: string;
  invoiceDate?: string;
  /** The API's decimal string (`125000.50`). */
  price?: string;
  /** ISO 4217, upper case. */
  currency?: string;
  /** 1-99. */
  partsTotal?: number;
  note?: string;
  /** `custom.<code>` cells by code, raw. */
  custom: Record<string, string>;
}

/** The header of a `csv-items` export: the columns, then `custom.<code>` for each code. */
export function csvItemHeader(customCodes: readonly string[] = []): string[] {
  return [...CSV_ITEM_COLUMNS, ...customCodes.map((c) => CUSTOM_PREFIX + c)];
}

/** The problems of a `csv-items` header, to report once per file: unknown, repeated or malformed columns, no barcode. */
export function csvItemHeaderErrors(header: readonly string[]): CsvFieldError[] {
  return itemHeaderIndex(header).errors;
}

const headerCache = new WeakMap<readonly string[], HeaderIndex>();

function itemHeaderIndex(header: readonly string[]): HeaderIndex {
  return cachedHeaderIndex(headerCache, header, CSV_ITEM_COLUMNS, 'barcode');
}

/** The longest barcode a body takes before normalisation (`rawBarcodeField`). */
const BARCODE_MAX = 200;

/** One `csv-items` row: `cells` under `header` (columns by name, trimmed, any case); `errors` in header order. */
export function csvItemRow(header: readonly string[], cells: readonly string[]): { row: ItemCsvRow; errors: CsvFieldError[] } {
  const index = itemHeaderIndex(header);
  const r = new CellReader();
  const get = (c: ItemColumn): string => {
    const i = index.known.get(c);
    return i === undefined ? '' : unguard(cells[i] ?? '');
  };

  let barcode = get('barcode').trim();
  if (barcode === '') r.error('barcode', 'required');
  else if (barcode.length > BARCODE_MAX) {
    r.error('barcode', 'too_big');
    barcode = '';
  }
  const row: ItemCsvRow = { barcode, custom: {} };
  const put = <K extends keyof ItemCsvRow>(key: K, value: ItemCsvRow[K] | undefined): void => {
    if (value !== undefined) row[key] = value;
  };

  const recordId = oneLine(get('record_id')).toUpperCase();
  if (recordId !== '') {
    if (isUlid(recordId)) row.recordId = recordId;
    else r.error('record_id', 'invalid_format');
  }
  const isbn = oneLine(get('isbn'));
  if (isbn !== '') {
    if (parseIsbn(isbn) !== null) row.isbn = isbn;
    else r.error('isbn', 'invalid_format');
  }
  put('branchCode', r.code('branch', get('branch')));
  put('locationCode', r.code('location', get('location')));
  put('collectionTypeCode', r.code('collection_type', get('collection_type')));
  put('callNumber', r.short('call_number', get('call_number'), 64));
  put('inventoryNo', r.short('inventory_no', get('inventory_no'), 64));
  put('status', r.oneOf('status', get('status'), ITEM_STATUSES));
  put('acqSource', r.oneOf('acq_source', get('acq_source'), ACQ_SOURCES));
  put('orderNo', r.short('order_no', get('order_no'), 64));
  put('orderDate', r.date('order_date', get('order_date')));
  put('receivedDate', r.date('received_date', get('received_date')));
  put('supplierCode', r.code('supplier', get('supplier')));
  put('invoiceNo', r.short('invoice_no', get('invoice_no'), 64));
  put('invoiceDate', r.date('invoice_date', get('invoice_date')));
  put('price', r.price('price', get('price')));
  const currency = oneLine(get('currency')).toUpperCase();
  if (currency !== '') {
    if (/^[A-Z]{3}$/.test(currency)) row.currency = currency;
    else r.error('currency', 'invalid_format');
  }
  const parts = oneLine(get('parts_total'));
  if (parts !== '') {
    if (!/^\d{1,9}$/.test(parts)) r.error('parts_total', 'invalid_format');
    else if (Number(parts) < 1) r.error('parts_total', 'too_small');
    else if (Number(parts) > 99) r.error('parts_total', 'too_big');
    else row.partsTotal = Number(parts);
  }
  put('note', r.text('note', get('note')));
  row.custom = customCells(index, cells) ?? {};
  if (hasExtraCells(cells, header.length)) r.error('', 'too_many_cells');

  return { row, errors: inHeaderOrder(r.errors, (column) => index.known.get(column) ?? -1) };
}

/** The cells of `row` in the order of `csvItemHeader(customCodes)`, as text for csvRow. */
export function itemCsvCells(row: ItemCsvRow, customCodes: readonly string[] = []): string[] {
  const by: Record<ItemColumn, string> = {
    barcode: row.barcode,
    record_id: row.recordId ?? '',
    isbn: row.isbn ?? '',
    branch: row.branchCode ?? '',
    location: row.locationCode ?? '',
    collection_type: row.collectionTypeCode ?? '',
    call_number: row.callNumber ?? '',
    inventory_no: row.inventoryNo ?? '',
    status: row.status ?? '',
    acq_source: row.acqSource ?? '',
    order_no: row.orderNo ?? '',
    order_date: row.orderDate ?? '',
    received_date: row.receivedDate ?? '',
    supplier: row.supplierCode ?? '',
    invoice_no: row.invoiceNo ?? '',
    invoice_date: row.invoiceDate ?? '',
    price: row.price ?? '',
    currency: row.currency ?? '',
    parts_total: row.partsTotal === undefined ? '' : String(row.partsTotal),
    note: row.note ?? '',
  };
  return [...CSV_ITEM_COLUMNS.map((c) => by[c]), ...customCodes.map((code) => (Object.hasOwn(row.custom, code) ? row.custom[code]! : ''))];
}
