import { describe, expect, it } from 'vitest';
import { detectImportFormat } from '../../src/catalog/exchange/detect.js';
import { MARCXML_COLLECTION_CLOSE, MARCXML_COLLECTION_OPEN, writeIso2709, writeMarcXmlRecord } from '../../src/marc/index.js';
import { cf, df } from '../support/marc-corpus.js';

// The format of an import file from its first bytes (Phase 2 Task 31; spec §5.3 "terdeteksi otomatis bila kosong"):
// ISO 2709, MARCXML in the MARC namespace (any prefix), the ALTIS CSV layouts by their header, the SLiMS layouts by
// their header or their column count; anything else null (CATALOG_IMPORT_FORMAT).

const record = { leader: '00000nam a2200000 i 4500', fields: [cf('001', 'D1'), df('245', '10', 'aDeteksi')] };
const bytes = (s: string): Uint8Array => Buffer.from(s, 'utf8');

describe('detectImportFormat', () => {
  it('reads ISO 2709 by its leader and directory, MARCXML by the namespace of its root (prefixed too, after a DOCTYPE)', () => {
    expect(detectImportFormat(writeIso2709(record))).toBe('marc21');
    expect(detectImportFormat(bytes(MARCXML_COLLECTION_OPEN + writeMarcXmlRecord(record) + MARCXML_COLLECTION_CLOSE))).toBe('marcxml');
    expect(detectImportFormat(bytes('\uFEFF<!-- ekspor -->\n<m:collection xmlns:m="http://www.loc.gov/MARC21/slim"><m:record/></m:collection>'))).toBe('marcxml');
    // The DOCTYPE is stepped over here; the reader refuses it (the run fails with CATALOG_IMPORT_FORMAT).
    expect(detectImportFormat(bytes('<?xml version="1.0"?>\n<!DOCTYPE c [<!ENTITY x "y">]>\n<collection xmlns="http://www.loc.gov/MARC21/slim"/>'))).toBe('marcxml');
    expect(detectImportFormat(bytes('<collection xmlns="http://example.org/lain"><record/></collection>'))).toBeNull();
  });

  it('reads the CSV layouts: a header with title or barcode, the SLiMS headers, 18 or 19 headerless columns', () => {
    expect(detectImportFormat(bytes('\uFEFFtitle;year\r\nSatu;2001\r\n'))).toBe('csv-records');
    expect(detectImportFormat(bytes('barcode,branch\r\nB1,PUSAT\r\n'))).toBe('csv-items');
    const row18 = Array.from({ length: 18 }, (_, i) => `"k${i}"`).join(',');
    const row19 = Array.from({ length: 19 }, (_, i) => `"k${i}"`).join(',');
    expect(detectImportFormat(bytes(`${row18}\r\n`))).toBe('csv-slims');
    expect(detectImportFormat(bytes(`${row19}\r\n`))).toBe('csv-slims-items');
    // A WinISIS row ends in a 19th cell `#`: still the record layout.
    expect(detectImportFormat(bytes(`${row18},"#"\r\n`))).toBe('csv-slims');
    expect(detectImportFormat(bytes('item_code,call_number,coll_type_name,inventory_code,received_date,supplier_name,order_no,location_name,order_date,item_status_name,site,source,invoice,price,price_currency,invoice_date,input_date,last_update,title\r\n'))).toBe('csv-slims-items');
  });

  it('reads the root tag in linear time: 64 KiB of name characters, or an attribute value that does not close', () => {
    // An attribute regex retries such a run from each of its starts (quadratic: 8 s for one upload's head).
    const run = 'a'.repeat(65_000);
    const started = performance.now();
    expect(detectImportFormat(bytes(`<${run}>`))).toBeNull();
    expect(detectImportFormat(bytes(`<collection x="${run}>`))).toBeNull();
    expect(performance.now() - started).toBeLessThan(1000);
    const many = Array.from({ length: 2000 }, (_, i) => `a${i} = 'v'`).join('\n ');
    expect(detectImportFormat(bytes(`<collection ${many} xmlns="http://www.loc.gov/MARC21/slim"><record/></collection>`))).toBe('marcxml');
    expect(detectImportFormat(bytes(`<collection a="xmlns='http://www.loc.gov/MARC21/slim'"><record/></collection>`))).toBeNull();
  });

  it('anything else is null: an empty file, plain text, a CSV of other columns', () => {
    expect(detectImportFormat(new Uint8Array(0))).toBeNull();
    expect(detectImportFormat(bytes('hanya sebaris teks\n'))).toBeNull();
    expect(detectImportFormat(bytes('judul,tahun\r\nSatu,2001\r\n'))).toBeNull();
    expect(detectImportFormat(bytes('00099nam  2200040 a 4500'))).toBeNull(); // a base address that ends no whole directory
  });
});
