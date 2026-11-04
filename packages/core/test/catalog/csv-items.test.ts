import { describe, expect, it } from 'vitest';
import {
  CSV_ITEM_COLUMNS,
  createCsvReader,
  csvItemHeader,
  csvItemHeaderErrors,
  csvItemRow,
  itemCsvCells,
  type ItemCsvRow,
} from '../../src/catalog/csv/index.js';
import { CSV_BOM, csvRow } from '../../src/export/csv.js';

// The ALTIS `csv-items` codec (Phase 2 spec §5.2, K6): upsert by barcode, the parent by record_id or ISBN, masters by
// code, a price as a decimal, custom columns as raw strings (S19).

const FULL: ItemCsvRow = {
  barcode: 'B0000123',
  recordId: '01JB00000000000000000000R1',
  isbn: '978-602-03-1234-5',
  branchCode: 'PUSAT',
  locationCode: 'R1-A-03',
  collectionTypeCode: 'SIRKULASI',
  callNumber: '899.221 3 TOE b c.2',
  inventoryNo: 'INV/2024/0001',
  status: 'not_for_loan',
  acqSource: 'gift',
  orderNo: 'PO-77',
  orderDate: '2024-01-31',
  receivedDate: '2024-02-29',
  supplierCode: 'GRAMEDIA',
  invoiceNo: 'F-9',
  invoiceDate: '2024-03-01',
  price: '125000.50',
  currency: 'IDR',
  partsTotal: 3,
  note: 'Sampul rusak\nbaris dua; "dikutip"',
  custom: { rak: 'A|B', donatur: '=SUM(A1)' },
};

describe('csv-items: K6 (codec half)', () => {
  it('csvItemRow(header, itemCsvCells(row)) reproduces the row', () => {
    const header = csvItemHeader(['rak', 'donatur']);
    expect(header).toEqual([...CSV_ITEM_COLUMNS, 'custom.rak', 'custom.donatur']);
    const read = csvItemRow(header, itemCsvCells(FULL, ['rak', 'donatur']));
    expect(read).toEqual({ row: FULL, errors: [] });
    const sparse: ItemCsvRow = { barcode: 'B1', custom: {} };
    expect(csvItemRow(CSV_ITEM_COLUMNS, itemCsvCells(sparse))).toEqual({ row: sparse, errors: [] });
  });

  it('writes the §5.2 columns in order', () => {
    expect(CSV_ITEM_COLUMNS).toEqual([
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
    ]);
    expect(itemCsvCells(FULL)).toHaveLength(CSV_ITEM_COLUMNS.length);
  });

  it('a whole file reads back through the reader; formula starts are guarded on the way out and unguarded on the way in', () => {
    const header = csvItemHeader(['rak', 'donatur']);
    const text = CSV_BOM + csvRow(header, ';') + csvRow(itemCsvCells(FULL, ['rak', 'donatur']), ';');
    expect(text).toContain(`"'=SUM(A1)"`);
    const reader = createCsvReader();
    const rows = [...reader.push(new TextEncoder().encode(text)), ...reader.end()];
    expect(reader.info()).toMatchObject({ separator: ';', bom: true });
    expect(csvItemRow(rows[0]!.cells, rows[1]!.cells)).toEqual({ row: FULL, errors: [] });
  });
});

describe('csv-items: reading hand-made files', () => {
  const read = (values: Record<string, string>) => csvItemRow(Object.keys(values), Object.values(values));

  it('needs a barcode; the columns may come in any order and case', () => {
    expect(read({ ISBN: '979-1234-56-7', Barcode: ' b 001 ' })).toEqual({ row: { barcode: 'b 001', isbn: '979-1234-56-7', custom: {} }, errors: [] });
    expect(read({ barcode: '', note: 'x' }).errors).toEqual([{ column: 'barcode', code: 'required' }]);
    expect(read({ note: 'x' }).errors).toEqual([{ column: 'barcode', code: 'required' }]);
  });

  it('reads codes in any case, an Indonesian decimal comma, a lower-case currency', () => {
    expect(read({ barcode: 'B1', status: 'Available', acq_source: 'PURCHASE', price: '12500,5', currency: 'idr', parts_total: '2' }).row).toEqual({
      barcode: 'B1',
      status: 'available',
      acqSource: 'purchase',
      price: '12500.5',
      currency: 'IDR',
      partsTotal: 2,
      custom: {},
    });
  });

  it('reports what does not fit and leaves the field out', () => {
    const r = read({
      barcode: 'B1',
      record_id: 'x',
      isbn: '12345',
      branch: 'C\u00c9NTRAL',
      location: 'L'.repeat(33),
      status: 'dipinjam',
      acq_source: 'beli',
      order_date: '2023-02-29',
      received_date: '31/01/2024',
      price: '125,000',
      currency: 'RP',
      parts_total: '100',
      inventory_no: 'i'.repeat(65),
    });
    expect(r.errors).toEqual([
      { column: 'record_id', code: 'invalid_format' },
      { column: 'isbn', code: 'invalid_format' },
      { column: 'branch', code: 'invalid_format' },
      { column: 'location', code: 'too_big' },
      { column: 'status', code: 'invalid_value' },
      { column: 'acq_source', code: 'invalid_value' },
      { column: 'order_date', code: 'invalid_format' },
      { column: 'received_date', code: 'invalid_format' },
      { column: 'price', code: 'invalid_format' },
      { column: 'currency', code: 'invalid_format' },
      { column: 'parts_total', code: 'too_big' },
      { column: 'inventory_no', code: 'too_big' },
    ]);
    expect(r.row).toEqual({ barcode: 'B1', custom: {} });
    expect(read({ barcode: 'B1', parts_total: '0' }).errors).toEqual([{ column: 'parts_total', code: 'too_small' }]);
    expect(read({ barcode: 'B1', parts_total: '1.5' }).errors).toEqual([{ column: 'parts_total', code: 'invalid_format' }]);
    expect(read({ barcode: 'x'.repeat(201) }).errors).toEqual([{ column: 'barcode', code: 'too_big' }]);
  });

  it('custom.<code> columns are raw strings; an empty cell is left out', () => {
    expect(read({ barcode: 'B1', 'custom.rak': ' A ', 'custom.kosong': '' }).row.custom).toEqual({ rak: ' A ' });
  });

  it('csvItemHeaderErrors names unknown and repeated columns and a missing barcode', () => {
    expect(csvItemHeaderErrors(csvItemHeader(['rak']))).toEqual([]);
    expect(csvItemHeaderErrors(['barcode', 'lokasi', 'BARCODE'])).toEqual([
      { column: 'lokasi', code: 'unknown_column' },
      { column: 'BARCODE', code: 'duplicate_column' },
    ]);
    expect(csvItemHeaderErrors(['title'])).toEqual([
      { column: 'title', code: 'unknown_column' },
      { column: 'barcode', code: 'required' },
    ]);
  });
});
