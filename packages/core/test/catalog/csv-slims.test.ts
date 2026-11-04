import { RecordDraft } from '@altis/shared/api/catalog/record-data';
import { describe, expect, it } from 'vitest';
import { SLIMS_ITEM_COLUMNS, SLIMS_RECORD_COLUMNS, createCsvReader, isSlimsCsvHeader, slimsCsvItem, slimsCsvRecord } from '../../src/catalog/csv/index.js';

// The SLiMS / CDS-ISIS (WinISIS) CSV layouts, import only (Phase 2 spec §5.2, K6): 18 record columns without a header,
// multi-values `<a><b>`; 19 item columns. Only the column orders are taken from SLiMS 9 (interoperability facts, no
// SLiMS code; clean-room, §1.3).

/** The cells of one CSV line read by the reader (`,`, as the SLiMS and WinISIS exports write it). */
function cellsOf(line: string): string[] {
  const reader = createCsvReader({ separator: ',' });
  const rows = [...reader.push(new TextEncoder().encode(line)), ...reader.end()];
  expect(rows).toHaveLength(1);
  return rows[0]!.cells;
}

describe('csv-slims: the 18 record columns', () => {
  it('lists the columns in the SLiMS export order', () => {
    expect(SLIMS_RECORD_COLUMNS).toEqual([
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
    ]);
  });

  it('an 18-column fixture row with <Toer, Pramoedya><Hirata, Andrea> → 2 agents, its topics and item codes', () => {
    const cells = cellsOf(
      '"Bumi manusia","Text","Cet. 3","979-97312-3-2; 0126-0537","Hasta Mitra","1980","535 hlm. ; 21 cm","Tetralogi Buru","899.221 3 TOE b",' +
        '"Indonesia","Jakarta","899.221 3","Catatan satu\\nbaris dua","bumi.jpg","Pramoedya Ananta Toer",' +
        '"<Toer, Pramoedya><Hirata, Andrea>","<Sejarah><Roman Indonesia>","<B001><B002>"\r\n',
    );
    expect(cells).toHaveLength(18);
    const r = slimsCsvRecord(cells);
    expect(r.errors).toEqual([]);
    expect(r.gmdName).toBe('Text');
    expect(r.imageName).toBe('bumi.jpg');
    expect(r.languageName).toBe('Indonesia');
    expect(r.itemCodes).toEqual(['B001', 'B002']);
    expect(r.draft).toEqual({
      materialTypeCode: null,
      title: 'Bumi manusia',
      responsibility: 'Pramoedya Ananta Toer',
      edition: 'Cet. 3',
      publisher: { name: 'Hasta Mitra', place: 'Jakarta' },
      publicationPlace: 'Jakarta',
      publicationYear: '1980',
      physicalDesc: '535 hlm. ; 21 cm',
      series: 'Tetralogi Buru',
      classification: '899.221 3',
      callNumber: '899.221 3 TOE b',
      notes: 'Catatan satu\nbaris dua',
      identifiers: [
        { type: 'isbn', value: '979-97312-3-2' },
        { type: 'issn', value: '0126-0537' },
      ],
      agents: [
        { type: 'person', name: 'Toer, Pramoedya', role: 'aut', isMain: true },
        { type: 'person', name: 'Hirata, Andrea', role: 'aut', isMain: false },
      ],
      subjects: [
        { type: 'topic', term: 'Sejarah', isPrimary: true },
        { type: 'topic', term: 'Roman Indonesia', isPrimary: false },
      ],
      links: [],
      items: [],
      marcExtra: [],
    });
    expect(RecordDraft.safeParse(r.draft).success).toBe(true);
  });

  it('reads a WinISIS (ISISEXP) line: a trailing `#`, ISBD punctuation, single values without brackets', () => {
    const cells = cellsOf(
      '"Laskar pelangi : sebuah novel /","","","","Bentang","2005","xiv, 529 hlm.","","","ind","Yogyakarta","813","","","",' +
        '"<Hirata, Andrea,><Toer, P.>","<Pendidikan - Indonesia><Novel>","<INV-1><INV-2><INV-1>"#\r\n',
    );
    const r = slimsCsvRecord(cells);
    expect(r.errors).toEqual([]);
    expect(r.draft.title).toBe('Laskar pelangi : sebuah novel');
    expect(r.draft.agents.map((a) => a.name)).toEqual(['Hirata, Andrea', 'Toer, P.']);
    expect(r.draft.subjects.map((s) => s.term)).toEqual(['Pendidikan - Indonesia', 'Novel']);
    expect(r.itemCodes).toEqual(['INV-1', 'INV-2']);
    expect(r).toMatchObject({ gmdName: null, imageName: null, languageName: 'ind' });
    // `#` as a cell of its own after the 18th is dropped too; a lone name without brackets is one value.
    const own = slimsCsvRecord([...cells.slice(0, 15), 'Toer, Pramoedya', '', '<B9>', '#']);
    expect(own.errors).toEqual([]);
    expect(own.draft.agents).toEqual([{ type: 'person', name: 'Toer, Pramoedya', role: 'aut', isMain: true }]);
    expect(own.itemCodes).toEqual(['B9']);
  });

  it('reads the `\\n` SLiMS writes for a line break as one, and a year as written with its first year', () => {
    const r = slimsCsvRecord(['Judul', '', '', '', '', 'c2005 [cet. 2]', '', '', '', '', '', '', 'satu\\r\\ndua\\nm\\rtiga']);
    expect(r.draft.notes).toBe('satu\ndua\nm\ntiga');
    expect(r.draft).toMatchObject({ publicationYear: '2005', publicationDateText: 'c2005 [cet. 2]' });
  });

  it('drops trailing ISBD punctuation in linear time, even past a long run of it inside a cell', () => {
    // A run of punctuation that does not end the value: a regex `[…]+$` retries it from every start (quadratic).
    const run = ';'.repeat(50_000);
    const started = performance.now();
    const r = slimsCsvRecord([`Judul${run}x`, '', '', '', `Penerbit ${run}`, '', `${run}x`, '', '', '', '', '', '', '', '', `<A${run}x><B ;>`]);
    expect(performance.now() - started).toBeLessThan(1000);
    expect(r.errors).toEqual([
      { column: 'collation', code: 'too_big' },
      { column: 'authors', code: 'too_big' },
    ]);
    expect(r.draft.title).toBe(`Judul${run}x`);
    expect(r.draft.publisher).toEqual({ name: 'Penerbit' });
    expect(r.draft.agents).toEqual([{ type: 'person', name: 'B', role: 'aut', isMain: true }]);
  });

  it('a missing title is `required`; short rows read as empty cells; extra cells are reported', () => {
    expect(slimsCsvRecord(['', 'Text']).errors).toEqual([{ column: 'title', code: 'required' }]);
    expect(slimsCsvRecord(['Judul']).draft.title).toBe('Judul');
    expect(slimsCsvRecord([...Array.from({ length: 18 }, (_, i) => (i === 0 ? 'T' : '')), 'lebih']).errors).toEqual([{ column: '', code: 'too_many_cells' }]);
    const long = slimsCsvRecord(['T', '', 'e'.repeat(192), '', '', '', '', '', 'c'.repeat(65)]);
    expect(long.errors).toEqual([
      { column: 'edition', code: 'too_big' },
      { column: 'call_number', code: 'too_big' },
    ]);
  });

  it('skips a header row only when it equals the known header, not because its first cell is `title`', () => {
    expect(isSlimsCsvHeader([...SLIMS_RECORD_COLUMNS], 'records')).toBe(true);
    expect(isSlimsCsvHeader([...SLIMS_RECORD_COLUMNS.map((c) => ` ${c.toUpperCase()} `), ''], 'records')).toBe(true);
    const book = ['title', 'Text', '', '', '', '', '', '', '', '', '', '', '', '', '', '', '', ''];
    expect(isSlimsCsvHeader(book, 'records')).toBe(false);
    expect(slimsCsvRecord(book).draft.title).toBe('title');
    expect(isSlimsCsvHeader([...SLIMS_RECORD_COLUMNS], 'items')).toBe(false);
    expect(isSlimsCsvHeader([...SLIMS_ITEM_COLUMNS], 'items')).toBe(true);
  });
});

describe('csv-slims: the 19 item columns', () => {
  it('lists the columns in the SLiMS item export order', () => {
    expect(SLIMS_ITEM_COLUMNS).toEqual([
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
    ]);
  });

  it('a 19-column item row → its fields', () => {
    const cells = cellsOf(
      '"B00001","899.221 3 TOE b","Sirkulasi","INV/001","2023-05-02","Gramedia","PO-1","Perpustakaan Pusat","2023-04-30","",' +
        '"Rak 3","1","F-77","125000","Rupiah","2023-05-01","2023-05-02 10:11:12","2023-06-01 08:00:00","Bumi manusia"\n',
    );
    expect(cells).toHaveLength(19);
    expect(slimsCsvItem(cells)).toEqual({
      row: {
        itemCode: 'B00001',
        callNumber: '899.221 3 TOE b',
        collTypeName: 'Sirkulasi',
        inventoryCode: 'INV/001',
        receivedDate: '2023-05-02',
        supplierName: 'Gramedia',
        orderNo: 'PO-1',
        locationName: 'Perpustakaan Pusat',
        orderDate: '2023-04-30',
        site: 'Rak 3',
        source: 'purchase',
        invoice: 'F-77',
        price: '125000',
        priceCurrency: 'Rupiah',
        invoiceDate: '2023-05-01',
        inputDate: '2023-05-02 10:11:12',
        lastUpdate: '2023-06-01 08:00:00',
        title: 'Bumi manusia',
      },
      errors: [],
    });
  });

  it('reads source 2 as a gift, empty SLiMS dates as none, and reports what it cannot read', () => {
    const base = ['B1', '', '', '', '0000-00-00', '', '', '', '2023-02-30', 'Rusak', '', '2', '', '12,5', '', '2023-01-01 00:00:00', '', '', 'Judul'];
    const r = slimsCsvItem(base);
    expect(r.errors).toEqual([{ column: 'order_date', code: 'invalid_format' }]);
    expect(r.row).toEqual({ itemCode: 'B1', itemStatusName: 'Rusak', source: 'gift', price: '12.5', invoiceDate: '2023-01-01', title: 'Judul' });
    // The parent's title is cleaned as the record codec cleans it, so an exact match finds a WinISIS-era title.
    const isbd = 'Laskar pelangi : sebuah novel /';
    expect(slimsCsvItem([...base.slice(0, 18), isbd]).row.title).toBe(slimsCsvRecord([isbd]).draft.title);
    expect(slimsCsvItem([...base.slice(0, 18), isbd]).row.title).toBe('Laskar pelangi : sebuah novel');
    const bad = slimsCsvItem(['', '', '', '', '', '', '', '', '', '', '', '9', '', 'gratis', '', '', '', '', '']);
    expect(bad.errors).toEqual([
      { column: 'item_code', code: 'required' },
      { column: 'source', code: 'invalid_value' },
      { column: 'price', code: 'invalid_format' },
      { column: 'title', code: 'required' },
    ]);
  });
});
