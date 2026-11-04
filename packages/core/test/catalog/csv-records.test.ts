import { RecordDraft, type RecordData } from '@altis/shared/api/catalog/record-data';
import { describe, expect, it } from 'vitest';
import {
  CSV_RECORD_COLUMNS,
  createCsvReader,
  csvRecordHeader,
  csvRecordHeaderErrors,
  csvRecordRow,
  joinMulti,
  recordCsvCells,
  splitMulti,
  type CsvRow,
} from '../../src/catalog/csv/index.js';
import { CSV_BOM, csvRow } from '../../src/export/csv.js';

// The ALTIS `csv-records` codec (Phase 2 spec §5.2, K6): columns by header name in any order, multi-values joined
// with `|`, authors `Nama [peran]`, subjects `tipe:istilah`, custom columns as raw strings (S19).

const ID = '01JB00000000000000000000R1';

/** A stored record as loadRecordData answers it, with every field the CSV maps filled. */
function recordData(over: Partial<RecordData> = {}): RecordData {
  return {
    id: ID,
    createdAt: 1_700_000_000_000,
    updatedAt: 1_700_000_100_000,
    changedAt: 1_700_000_100_000,
    opacVisible: false,
    promoted: false,
    archived: false,
    mergedInto: null,
    materialType: { id: '01JB00000000000000000000M1', code: 'BUKU', nameId: 'Buku', nameEn: 'Book', marcType: 'a', marcLevel: 'm', schemaType: 'Book', dcmiType: 'Text' },
    materialTypeCode: 'BUKU',
    language: { code: 'ind', nameId: 'Indonesia', nameEn: 'Indonesian' },
    languageCode: 'ind',
    title: 'Bumi Manusia',
    subtitle: 'sebuah roman',
    responsibility: 'Pramoedya Ananta Toer',
    edition: 'Cet. 3',
    publisher: { id: '01JB00000000000000000000P1', name: 'Hasta Mitra', place: 'Jakarta' },
    publicationPlace: 'Jakarta',
    publicationYear: '1980',
    publicationDateText: 'c1980',
    physicalDesc: '535 hlm. ; 21 cm',
    series: 'Tetralogi Buru ; 1',
    classification: '899.221 3',
    callNumber: '899.221 3 TOE b',
    summary: 'Ringkasan, baris satu\nbaris "dua"',
    notes: 'Catatan | dengan pipa',
    identifiers: [
      { type: 'control', value: 'IndJ:00012' },
      { type: 'isbn', value: '979-97312-3-2', qualifier: 'jil. 1' },
      { type: 'issn', value: '0126-0537' },
      { type: 'isbn', value: '9786024246945' },
    ],
    agents: [
      { id: '01JB00000000000000000000A1', type: 'person', name: 'Toer, Pramoedya Ananta', dates: '1925-2006', role: 'aut', isMain: true },
      { id: '01JB00000000000000000000A2', type: 'organization', name: 'Badan Bahasa', role: 'edt', isMain: false },
      { id: '01JB00000000000000000000A3', type: 'person', name: 'Hirata | Andrea', role: 'trl', isMain: false },
    ],
    subjects: [
      { id: '01JB00000000000000000000S1', type: 'topic', term: 'Sejarah -- Indonesia', isPrimary: true },
      { id: '01JB00000000000000000000S2', type: 'geographic', term: 'Buru (Pulau)', isPrimary: false },
      { id: '01JB00000000000000000000S3', type: 'topic', term: 'name: bukan tipe', isPrimary: false },
    ],
    links: [],
    marcExtra: [],
    custom: { halaman: 535, tags: ['a', 'b|c'], flag: true, kosong: null },
    coverFileId: null,
    attachments: [],
    relations: [],
    items: [],
    customPublic: [],
    ...over,
  };
}

/** The draft the CSV of {@link recordData} reads back as: every field the CSV maps. */
const EXPECTED_DRAFT: RecordDraft = {
  materialTypeCode: 'BUKU',
  title: 'Bumi Manusia',
  subtitle: 'sebuah roman',
  responsibility: 'Pramoedya Ananta Toer',
  edition: 'Cet. 3',
  publisher: { name: 'Hasta Mitra', place: 'Jakarta' },
  publicationPlace: 'Jakarta',
  publicationYear: '1980',
  publicationDateText: 'c1980',
  physicalDesc: '535 hlm. ; 21 cm',
  series: 'Tetralogi Buru ; 1',
  classification: '899.221 3',
  callNumber: '899.221 3 TOE b',
  languageCode: 'ind',
  summary: 'Ringkasan, baris satu\nbaris "dua"',
  notes: 'Catatan | dengan pipa',
  identifiers: [
    { type: 'isbn', value: '979-97312-3-2', qualifier: 'jil. 1' },
    { type: 'isbn', value: '9786024246945' },
    { type: 'issn', value: '0126-0537' },
  ],
  agents: [
    { type: 'person', name: 'Toer, Pramoedya Ananta', dates: '1925-2006', role: 'aut', isMain: true },
    { type: 'organization', name: 'Badan Bahasa', role: 'edt', isMain: false },
    { type: 'person', name: 'Hirata | Andrea', role: 'trl', isMain: false },
  ],
  subjects: [
    { type: 'topic', term: 'Sejarah -- Indonesia', isPrimary: true },
    { type: 'geographic', term: 'Buru (Pulau)', isPrimary: false },
    { type: 'topic', term: 'name: bukan tipe', isPrimary: false },
  ],
  links: [],
  items: [],
  marcExtra: [],
  custom: { halaman: '535', tags: 'a|b\\|c', flag: '1' },
};

/** The rows of a CSV file's bytes. */
function readRows(bytes: Uint8Array): CsvRow[] {
  const reader = createCsvReader();
  return [...reader.push(bytes), ...reader.end()];
}

describe('csv-records: K6 (codec half)', () => {
  const customCodes = ['halaman', 'tags', 'flag', 'kosong'];

  it('csvRecordRow(header, recordCsvCells(data)) reproduces the mapped fields, multi-value authors and subjects included', () => {
    const header = csvRecordHeader(customCodes);
    expect(header).toEqual([...CSV_RECORD_COLUMNS, 'custom.halaman', 'custom.tags', 'custom.flag', 'custom.kosong']);
    const cells = recordCsvCells(recordData(), customCodes);
    expect(cells).toHaveLength(header.length);
    const read = csvRecordRow(header, cells);
    expect(read.errors).toEqual([]);
    expect(read.recordId).toBe(ID);
    expect(read.opacVisible).toBe(false);
    expect(read.draft).toEqual(EXPECTED_DRAFT);
    expect(RecordDraft.safeParse(read.draft).success).toBe(true);
    // Without custom codes there are no custom columns and no custom values.
    const plain = csvRecordRow(CSV_RECORD_COLUMNS, recordCsvCells(recordData(), []));
    expect(plain.draft).toEqual({ ...EXPECTED_DRAFT, custom: undefined });
    expect('custom' in plain.draft).toBe(false);
  });

  it('writes the CSV_RECORD_COLUMNS in the §5.2 order and readable multi-values', () => {
    expect(CSV_RECORD_COLUMNS).toEqual([
      'record_id',
      'title',
      'subtitle',
      'responsibility',
      'material_type',
      'edition',
      'isbn',
      'issn',
      'publisher',
      'place',
      'year',
      'physical_desc',
      'series',
      'classification',
      'call_number',
      'language',
      'authors',
      'subjects',
      'summary',
      'notes',
      'opac_visible',
    ]);
    const cells = Object.fromEntries(CSV_RECORD_COLUMNS.map((c, i) => [c, recordCsvCells(recordData(), [])[i]]));
    expect(cells).toMatchObject({
      isbn: '979-97312-3-2 (jil. 1)|9786024246945',
      issn: '0126-0537',
      year: 'c1980',
      authors: 'Toer, Pramoedya Ananta [aut, 1925-2006]|Badan Bahasa [edt, organization]|Hirata \\| Andrea [trl]',
      subjects: 'Sejarah -- Indonesia|geographic:Buru (Pulau)|topic:name: bukan tipe',
      opac_visible: '0',
    });
  });

  it('a whole file (BOM, `;`, CRLF, quoted line breaks) reads back to the same draft through the reader', () => {
    const header = csvRecordHeader(customCodes);
    const text = CSV_BOM + csvRow(header, ';') + csvRow(recordCsvCells(recordData(), customCodes), ';') + csvRow(recordCsvCells(recordData({ title: 'Anak Semua Bangsa', opacVisible: true }), customCodes), ';');
    const rows = readRows(new TextEncoder().encode(text));
    expect(rows).toHaveLength(3);
    expect(rows[0]!.cells).toEqual(header);
    const first = csvRecordRow(rows[0]!.cells, rows[1]!.cells);
    expect(first).toEqual({ recordId: ID, draft: EXPECTED_DRAFT, opacVisible: false, errors: [] });
    const second = csvRecordRow(rows[0]!.cells, rows[2]!.cells);
    expect(second.draft.title).toBe('Anak Semua Bangsa');
    expect(second.opacVisible).toBe(true);
  });

  it('a title `=1+1` is exported as `\'=1+1` (csvCell) and reads back as `=1+1`', () => {
    const cells = recordCsvCells(recordData({ title: '=1+1', subtitle: '@home', series: '-5', notes: '+62 21' }), []);
    const line = csvRow(cells, ',');
    expect(line).toContain(`"'=1+1"`);
    expect(line).toContain(`"'@home"`);
    const read = csvRecordRow(CSV_RECORD_COLUMNS, readRows(new TextEncoder().encode(line))[0]!.cells);
    expect(read.draft).toMatchObject({ title: '=1+1', subtitle: '@home', series: '-5', notes: '+62 21' });
    // A quote that does not guard a formula start is kept.
    expect(csvRecordRow(['title'], ["'Tis the season"]).draft.title).toBe("'Tis the season");
  });
});

describe('csv-records: reading hand-made files', () => {
  it('reads the columns by name in any order and any case; a missing title is `required`', () => {
    const header = [' Notes ', 'TITLE', 'Authors', 'subjects'];
    const read = csvRecordRow(header, ['catatan', ' Laskar  Pelangi ', 'Hirata, Andrea|Toer, Pramoedya [EDT]', 'Pendidikan|GEOGRAPHIC: Belitung|Tidak: sebuah tipe']);
    expect(read.errors).toEqual([]);
    expect(read.recordId).toBeNull();
    expect(read.opacVisible).toBeNull();
    expect(read.draft).toEqual({
      materialTypeCode: null,
      title: 'Laskar Pelangi',
      publisher: null,
      notes: 'catatan',
      identifiers: [],
      agents: [
        { type: 'person', name: 'Hirata, Andrea', role: 'aut', isMain: true },
        { type: 'person', name: 'Toer, Pramoedya', role: 'edt', isMain: false },
      ],
      subjects: [
        { type: 'topic', term: 'Pendidikan', isPrimary: true },
        { type: 'geographic', term: 'Belitung', isPrimary: false },
        { type: 'topic', term: 'Tidak: sebuah tipe', isPrimary: false },
      ],
      links: [],
      items: [],
      marcExtra: [],
    });
    expect(csvRecordRow(['title', 'notes'], ['', 'x']).errors).toEqual([{ column: 'title', code: 'required' }]);
    expect(csvRecordRow(['notes'], ['x']).errors).toEqual([{ column: 'title', code: 'required' }]);
  });

  it('opac_visible accepts 0/1/true/false/ya/tidak in any case; anything else is invalid_value', () => {
    const visible = (v: string) => csvRecordRow(['title', 'opac_visible'], ['T', v]);
    for (const v of ['1', 'true', 'Ya', ' TRUE ']) expect(visible(v).opacVisible).toBe(true);
    for (const v of ['0', 'False', 'tidak', 'TIDAK']) expect(visible(v).opacVisible).toBe(false);
    expect(visible('').opacVisible).toBeNull();
    expect(visible('mungkin')).toMatchObject({ opacVisible: null, errors: [{ column: 'opac_visible', code: 'invalid_value' }] });
  });

  it('custom.<code> columns go to draft.custom as raw strings; an empty cell is left out', () => {
    const header = ['title', 'custom.halaman', 'Custom.Tags', 'custom.kosong', 'custom.__proto__'];
    const read = csvRecordRow(header, ['T', ' 12 ', 'a|b', '', 'x']);
    expect(read.errors).toEqual([]);
    expect(read.draft.custom).toEqual({ halaman: ' 12 ', Tags: 'a|b', ['__proto__']: 'x' });
    expect(Object.getPrototypeOf(read.draft.custom)).toBe(Object.prototype);
    expect(Object.keys(read.draft.custom!)).toEqual(['halaman', 'Tags', '__proto__']);
  });

  it('splits ISBN and ISSN cells into identifiers, keeping qualifiers and what is not a number', () => {
    const read = csvRecordRow(['title', 'isbn', 'issn'], ['T', 'ISBN 978-602-03-1234-5 (jil. 1); 979-1234-56-7|978-602-03-1234-5 (jil. 1)', '0126-0537|bukan nomor']);
    expect(read.errors).toEqual([]);
    expect(read.draft.identifiers).toEqual([
      { type: 'isbn', value: '978-602-03-1234-5', qualifier: 'jil. 1' },
      { type: 'isbn', value: '979-1234-56-7' },
      { type: 'issn', value: '0126-0537' },
      { type: 'other', value: 'bukan nomor' },
    ]);
  });

  it('reads the year as a year, or as the date text with its first year', () => {
    const year = (v: string) => {
      const d = csvRecordRow(['title', 'year'], ['T', v]).draft;
      return [d.publicationYear, d.publicationDateText];
    };
    expect(year('1998')).toEqual(['1998', undefined]);
    expect(year('c1998, cet. 2001')).toEqual(['1998', 'c1998, cet. 2001']);
    expect(year('[199-?]')).toEqual([undefined, '[199-?]']);
    expect(year('')).toEqual([undefined, undefined]);
  });

  it('reports what does not fit its column and leaves the field out', () => {
    const header = ['record_id', 'title', 'edition', 'material_type', 'language', 'classification', 'authors', 'subjects', 'year'];
    const read = csvRecordRow(
      header,
      ['bukan-ulid', 'T', 'e'.repeat(192), 'B\u00dcKU', 'ind', 'c'.repeat(65), `${'n'.repeat(192)}|Ok [xyz]|Ok2 [aut, 1990, 2000]`, 'genre:|t', 'y'.repeat(65)],
    );
    expect(read.recordId).toBeNull();
    expect(read.errors).toEqual([
      { column: 'record_id', code: 'invalid_format' },
      { column: 'edition', code: 'too_big' },
      { column: 'material_type', code: 'invalid_format' },
      { column: 'classification', code: 'too_big' },
      { column: 'authors', code: 'too_big' },
      { column: 'authors', code: 'invalid_value' },
      { column: 'subjects', code: 'invalid_value' },
      { column: 'year', code: 'too_big' },
    ]);
    expect(read.draft).toMatchObject({ materialTypeCode: null, languageCode: 'ind', title: 'T' });
    expect(read.draft.edition).toBeUndefined();
    expect(read.draft.classification).toBeUndefined();
    expect(read.draft.publicationDateText).toBeUndefined();
    // The agent with an unknown token keeps the default role; dates may hold a comma.
    expect(read.draft.agents).toEqual([
      { type: 'person', name: 'Ok', role: 'aut', isMain: true },
      { type: 'person', name: 'Ok2', dates: '1990, 2000', role: 'aut', isMain: false },
    ]);
    expect(read.draft.subjects).toEqual([{ type: 'topic', term: 't', isPrimary: true }]);
    expect(csvRecordRow(['record_id', 'title'], [ID, 'T']).recordId).toBe(ID);
  });

  it('keeps one-line fields on one line, and drops repeated authors and subjects', () => {
    const read = csvRecordRow(['title', 'authors', 'subjects'], ['Bumi\r\nManusia\t1', 'A [aut]|a [AUT]|A [edt]', 'X|x|geographic:X']);
    expect(read.draft.title).toBe('Bumi Manusia 1');
    expect(read.draft.agents.map((a) => `${a.name}/${a.role}`)).toEqual(['A/aut', 'A/edt']);
    expect(read.draft.subjects.map((s) => `${s.type}/${s.term}`)).toEqual(['topic/X', 'geographic/X']);
  });

  it('reports a list past its cap once, and keeps an ISBN-10 and its ISBN-13 as one identifier', () => {
    const many = Array.from({ length: 150 }, (_, i) => `Pengarang ${i}`).join('|');
    const read = csvRecordRow(['title', 'authors', 'isbn'], ['T', many, '979-97312-3-2|9789799731234']);
    expect(read.draft.agents).toHaveLength(100);
    expect(read.errors).toEqual([{ column: 'authors', code: 'too_big' }]);
    expect(read.draft.identifiers).toEqual([{ type: 'isbn', value: '979-97312-3-2' }]);
  });

  it('a non-empty cell past the header is too_many_cells', () => {
    expect(csvRecordRow(['title'], ['T', '', ' ']).errors).toEqual([]);
    expect(csvRecordRow(['title'], ['T', 'geser']).errors).toEqual([{ column: '', code: 'too_many_cells' }]);
  });

  it('csvRecordHeaderErrors names unknown, repeated and malformed columns and a missing title, once per file', () => {
    expect(csvRecordHeaderErrors(csvRecordHeader(['halaman']))).toEqual([]);
    expect(csvRecordHeaderErrors(['Title', 'titel', 'title', 'custom.', 'custom.ok', 'custom.dua kata ', 'custom.ok'])).toEqual([
      { column: 'titel', code: 'unknown_column' },
      { column: 'title', code: 'duplicate_column' },
      { column: 'custom.', code: 'invalid_format' },
      { column: 'custom.ok', code: 'duplicate_column' },
    ]);
    expect(csvRecordHeaderErrors(['notes'])).toEqual([{ column: 'title', code: 'required' }]);
  });
});

describe('splitMulti / joinMulti', () => {
  it('split on `|`, with `\\|` for a literal pipe; parts trimmed, empty ones dropped', () => {
    expect(splitMulti('a|b\\|c| |d ')).toEqual(['a', 'b|c', 'd']);
    expect(splitMulti('')).toEqual([]);
    expect(splitMulti('C:\\path|z')).toEqual(['C:\\path', 'z']);
    expect(joinMulti(['a', 'b|c'])).toBe('a|b\\|c');
  });

  it('round-trip every value, a trailing backslash or a literal `\\|` included', () => {
    for (const values of [['a'], ['a', 'b|c'], ['x\\', 'y'], ['x\\|y', 'z\\'], ['C:\\path', '|', 'a||b']]) {
      expect(splitMulti(joinMulti(values))).toEqual(values);
    }
  });
});
