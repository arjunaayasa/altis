import type { DB } from '@altis/db';
import type { ExportFileExt } from '@altis/platform';
import type { ExportFormat, ItemStatus, AcqSource } from '@altis/shared';
import type { RecordData } from '@altis/shared/api/catalog/record-data';
import type { Kysely, Transaction } from 'kysely';
import { CSV_BOM, csvRow } from '../../export/csv.js';
import { writeIso2709 } from '../../marc/iso2709.js';
import { recordToMarc } from '../../marc/map-export.js';
import { writeMarcJsonLine } from '../../marc/marcjson.js';
import { MARCXML_COLLECTION_CLOSE, MARCXML_COLLECTION_OPEN, writeMarcXmlRecord } from '../../marc/marcxml.js';
import type { MarcRecord } from '../../marc/record.js';
import { readCustomValues } from '../data/custom-fields.js';
import { csvItemHeader, itemCsvCells, type ItemCsvRow } from '../csv/items.js';
import { customValueText } from '../csv/multi.js';
import { csvRecordHeader, recordCsvCells } from '../csv/records.js';
import { formatPrice } from '../items/service.js';

// The file formats of an export (Phase 2 spec §5.1, §5.2, §5.4; plan Task 31): what a file starts with, each record
// (or each item row of `csv-items`), and what it ends with, as bytes.
//
// - MARC (ISO 2709, a MARCXML collection, MARC-in-JSON lines) through recordToMarc with the staff audience (S5: a staff
//   export keeps `marcExtra` for a lossless round trip; the generated fields carry no acquisition data). ISO 2709 throws
//   MarcTooLongError for a record above 99 999 bytes: the export skips it (P2-21).
// - `csv-records`: the BOM, the header with the record custom-field columns, one row per record (recordCsvCells).
// - `csv-items`: the BOM, the header with the item custom-field columns, one row per item, its acquisition data
//   included (a staff export, K6), with the record's first valid ISBN so that a parent is found in another installation.
// Every CSV cell goes through csvRow (formula guard, K6).

/** The bytes of `text` (UTF-8). */
export function utf8(text: string): Uint8Array {
  return Buffer.from(text, 'utf8');
}

/** How a record export writes MARC. */
export interface MarcExportOptions {
  orgCode: string | null;
  baseUrl: string;
  includeItems: boolean;
}

/** The MARC record of `d` for a staff export (S5). */
export function staffMarc(d: RecordData, o: MarcExportOptions): MarcRecord {
  return recordToMarc(d, { audience: 'staff', orgCode: o.orgCode, baseUrl: o.baseUrl, includeItems: o.includeItems });
}

/**
 * One record of a MARC export of `format`.
 *
 * @throws MarcTooLongError (ISO 2709 only) for a record that does not fit
 */
export function marcRecordBytes(format: 'marc21' | 'marcxml' | 'marcjson', rec: MarcRecord): Uint8Array {
  if (format === 'marc21') return writeIso2709(rec);
  return utf8(format === 'marcxml' ? writeMarcXmlRecord(rec) : writeMarcJsonLine(rec));
}

/** What a file of `format` starts with (`customCodes`: the CSV's custom-field columns). */
export function exportHead(format: ExportFormat, customCodes: readonly string[]): Uint8Array {
  switch (format) {
    case 'marcxml':
      return utf8(MARCXML_COLLECTION_OPEN);
    case 'csv-records':
      return utf8(CSV_BOM + csvRow(csvRecordHeader(customCodes), ','));
    case 'csv-items':
      return utf8(CSV_BOM + csvRow(csvItemHeader(customCodes), ','));
    default:
      return new Uint8Array(0);
  }
}

/** What a file of `format` ends with. */
export function exportTail(format: ExportFormat): Uint8Array {
  return format === 'marcxml' ? utf8(MARCXML_COLLECTION_CLOSE) : new Uint8Array(0);
}

/** One `csv-records` row of `d`. */
export function csvRecordBytes(d: RecordData, customCodes: readonly string[]): Uint8Array {
  return utf8(csvRow(recordCsvCells(d, customCodes), ','));
}

/** The file extension of each export format. */
export const EXPORT_EXTENSIONS: Readonly<Record<ExportFormat, ExportFileExt>> = Object.freeze({
  marc21: 'mrc',
  marcxml: 'xml',
  marcjson: 'jsonl',
  'csv-records': 'csv',
  'csv-items': 'csv',
});

type Db = Kysely<DB> | Transaction<DB>;

const ID_BATCH = 500;

/**
 * The `csv-items` rows of the items of `recordIds` (in that order, each record's items by barcode), kept by `filter`
 * (an item of the branch, of the collection type, not archived unless `includeArchived`).
 */
export async function csvItemRows(
  db: Db,
  recordIds: readonly string[],
  filter: { branchId?: string; collectionTypeId?: string; includeArchived?: boolean },
  customCodes: readonly string[],
): Promise<{ rows: Uint8Array[]; count: number }> {
  if (recordIds.length === 0) return { rows: [], count: 0 };
  let q = db
    .selectFrom('items as i')
    .innerJoin('branches as b', 'b.id', 'i.branch_id')
    .innerJoin('collection_types as ct', 'ct.id', 'i.collection_type_id')
    .leftJoin('locations as l', 'l.id', 'i.location_id')
    .leftJoin('suppliers as s', 's.id', 'i.supplier_id')
    .select([
      'i.id',
      'i.record_id',
      'i.barcode_display',
      'i.barcode_key',
      'b.code_display as branch_code',
      'l.code_display as location_code',
      'ct.code_display as collection_type_code',
      'i.call_number',
      'i.inventory_no',
      'i.status',
      'i.acq_source',
      'i.order_no',
      'i.order_date',
      'i.received_date',
      's.code_display as supplier_code',
      'i.invoice_no',
      'i.invoice_date',
      'i.price',
      'i.currency',
      'i.parts_total',
      'i.note',
    ])
    .where('i.record_id', 'in', [...recordIds]);
  if (filter.branchId !== undefined) q = q.where('i.branch_id', '=', filter.branchId);
  if (filter.collectionTypeId !== undefined) q = q.where('i.collection_type_id', '=', filter.collectionTypeId);
  if (filter.includeArchived !== true) q = q.where('i.archived_at', 'is', null);
  const items = await q.orderBy('i.record_id').orderBy('i.barcode_key').execute();
  if (items.length === 0) return { rows: [], count: 0 };

  // The first valid ISBN of each record, as written.
  const isbn = new Map<string, string>();
  for (let i = 0; i < recordIds.length; i += ID_BATCH) {
    const rows = await db
      .selectFrom('record_identifiers')
      .select(['record_id', 'value_display'])
      .where('record_id', 'in', recordIds.slice(i, i + ID_BATCH))
      .where('type', '=', 'isbn')
      .where('is_valid', '=', 1)
      .orderBy('record_id')
      .orderBy('sort_order')
      .execute();
    for (const r of rows) if (!isbn.has(r.record_id)) isbn.set(r.record_id, r.value_display);
  }
  const custom = customCodes.length === 0 ? new Map<string, Record<string, unknown>>() : await readCustomValues(db, 'items', items.map((i) => i.id));
  const order = new Map(recordIds.map((id, i) => [id, i]));
  items.sort((a, b) => order.get(a.record_id)! - order.get(b.record_id)! || (a.barcode_key < b.barcode_key ? -1 : a.barcode_key > b.barcode_key ? 1 : 0));

  const text = (v: string | null): string | undefined => (v === null || v === '' ? undefined : v);
  const rows = items.map((i) => {
    const row: ItemCsvRow = { barcode: i.barcode_display, recordId: i.record_id, custom: {} };
    const put = <K extends keyof ItemCsvRow>(key: K, value: ItemCsvRow[K] | undefined): void => {
      if (value !== undefined) row[key] = value;
    };
    put('isbn', isbn.get(i.record_id));
    put('branchCode', i.branch_code);
    put('locationCode', text(i.location_code));
    put('collectionTypeCode', i.collection_type_code);
    put('callNumber', text(i.call_number));
    put('inventoryNo', text(i.inventory_no));
    put('status', i.status as ItemStatus);
    put('acqSource', (text(i.acq_source) as AcqSource | undefined) ?? undefined);
    put('orderNo', text(i.order_no));
    put('orderDate', text(i.order_date));
    put('receivedDate', text(i.received_date));
    put('supplierCode', text(i.supplier_code));
    put('invoiceNo', text(i.invoice_no));
    put('invoiceDate', text(i.invoice_date));
    if (i.price !== null) put('price', formatPrice(Number(i.price)));
    put('currency', text(i.currency));
    put('partsTotal', Number(i.parts_total));
    put('note', text(i.note));
    // As text, the way the CSV writes them (a multiselect joined with `|`, a boolean as 1/0); a key stays a key.
    row.custom = Object.fromEntries(Object.entries(custom.get(i.id) ?? {}).map(([code, v]) => [code, customValueText(v)]));
    return utf8(csvRow(itemCsvCells(row, customCodes), ','));
  });
  return { rows, count: rows.length };
}
