import { AUDIENCES, LOCAL_WORKS, LOCAL_WORK_KINDS, REFERENCE_KINDS } from '@altis/shared';
import { RecordDraft, type RecordData } from '@altis/shared/api/catalog/record-data';
import { describe, expect, it } from 'vitest';
import { CSV_RECORD_COLUMNS, createCsvReader, csvRecordHeader, csvRecordRow, recordCsvCells, type CsvRow } from '../../src/catalog/csv/index.js';
import { CSV_BOM, csvRow } from '../../src/export/csv.js';

// The four accreditation fields of a record in the `csv-records` codec: the columns `audience`, `local_work`,
// `local_work_kind` and `reference_kind`, appended after `opac_visible` so a file written before them stays valid. The
// export writes the codes; the import reads them in any case, leaves an empty cell out (an update keeps the stored
// value) and refuses an unknown code at its column with `invalid`.

const ID = '01JB00000000000000000000R9';

/** The columns a file written before the accreditation fields has. */
const OLD_COLUMNS = CSV_RECORD_COLUMNS.slice(0, CSV_RECORD_COLUMNS.indexOf('opac_visible') + 1);

/** A stored record as loadRecordData answers it, with the four fields set. */
function recordData(over: Partial<RecordData> = {}): RecordData {
  return {
    id: ID,
    createdAt: 1_700_000_000_000,
    updatedAt: 1_700_000_100_000,
    changedAt: 1_700_000_100_000,
    opacVisible: true,
    promoted: false,
    archived: false,
    mergedInto: null,
    materialType: { id: '01JB00000000000000000000M1', code: 'BUKU', nameId: 'Buku', nameEn: 'Book', marcType: 'a', marcLevel: 'm', schemaType: 'Book', dcmiType: 'Text' },
    materialTypeCode: 'BUKU',
    language: null,
    title: 'Kliping Sejarah Desa',
    publisher: null,
    identifiers: [],
    agents: [],
    subjects: [],
    links: [],
    marcExtra: [],
    custom: {},
    coverFileId: null,
    attachments: [],
    relations: [],
    items: [],
    customPublic: [],
    audience: 'children',
    localWork: 'student',
    localWorkKind: 'clipping',
    referenceKind: null,
    ...over,
  };
}

/** The rows of a CSV file's bytes. */
function readRows(bytes: Uint8Array): CsvRow[] {
  const reader = createCsvReader();
  return [...reader.push(bytes), ...reader.end()];
}

/** The cell of `column` in an export of `d`. */
const cellOf = (d: RecordData, column: string): string | undefined => recordCsvCells(d, [])[CSV_RECORD_COLUMNS.indexOf(column as never)];

describe('csv-records: the accreditation fields', () => {
  it('the four columns follow opac_visible, before the custom columns', () => {
    expect(CSV_RECORD_COLUMNS.slice(CSV_RECORD_COLUMNS.indexOf('opac_visible'))).toEqual(['opac_visible', 'audience', 'local_work', 'local_work_kind', 'reference_kind']);
    expect(csvRecordHeader(['halaman']).slice(-6)).toEqual(['opac_visible', 'audience', 'local_work', 'local_work_kind', 'reference_kind', 'custom.halaman']);
  });

  it('the export writes the codes, an empty cell for a null or absent field', () => {
    const d = recordData();
    expect([cellOf(d, 'audience'), cellOf(d, 'local_work'), cellOf(d, 'local_work_kind'), cellOf(d, 'reference_kind')]).toEqual(['children', 'student', 'clipping', '']);
    const { audience, localWork, localWorkKind, referenceKind, ...older } = d;
    void [audience, localWork, localWorkKind, referenceKind];
    expect(recordCsvCells(older, []).slice(-4)).toEqual(['', '', '', '']);
  });

  it('export then import keeps the four values, through a whole file', () => {
    const full = recordData({ audience: 'special_needs', localWork: 'teacher', localWorkKind: 'written_work', referenceKind: 'encyclopedia' });
    const header = csvRecordHeader([]);
    const text = CSV_BOM + csvRow(header, ';') + csvRow(recordCsvCells(full, []), ';') + csvRow(recordCsvCells(recordData(), []), ';');
    const rows = readRows(new TextEncoder().encode(text));
    const first = csvRecordRow(rows[0]!.cells, rows[1]!.cells);
    expect(first.errors).toEqual([]);
    expect(first.draft).toMatchObject({ audience: 'special_needs', localWork: 'teacher', localWorkKind: 'written_work', referenceKind: 'encyclopedia' });
    const second = csvRecordRow(rows[0]!.cells, rows[2]!.cells);
    expect(second.errors).toEqual([]);
    expect(second.draft).toMatchObject({ audience: 'children', localWork: 'student', localWorkKind: 'clipping' });
    // An empty cell is left out of the draft (an update keeps the stored value).
    expect('referenceKind' in second.draft).toBe(false);
    expect(RecordDraft.safeParse(first.draft).success).toBe(true);
  });

  it('every code of each list reads back as itself', () => {
    const lists = [
      ['audience', 'audience', AUDIENCES],
      ['local_work', 'localWork', LOCAL_WORKS],
      ['local_work_kind', 'localWorkKind', LOCAL_WORK_KINDS],
      ['reference_kind', 'referenceKind', REFERENCE_KINDS],
    ] as const;
    for (const [column, key, values] of lists) {
      for (const value of values) {
        const read = csvRecordRow(['title', column], ['Judul', value]);
        expect({ column, value, errors: read.errors, got: read.draft[key] }).toEqual({ column, value, errors: [], got: value });
      }
    }
  });

  it('a code in another case is read in lower case', () => {
    const read = csvRecordRow(['title', 'local_work', 'reference_kind'], ['Judul', 'STUDENT', ' Atlas ']);
    expect(read.errors).toEqual([]);
    expect(read.draft).toMatchObject({ localWork: 'student', referenceKind: 'atlas' });
  });

  it('a file written before them (the header ends at opac_visible) imports without them', () => {
    expect(OLD_COLUMNS.at(-1)).toBe('opac_visible');
    const cells = recordCsvCells(recordData(), []).slice(0, OLD_COLUMNS.length);
    const read = csvRecordRow(OLD_COLUMNS, cells);
    expect(read.errors).toEqual([]);
    expect(read.draft.title).toBe('Kliping Sejarah Desa');
    for (const key of ['audience', 'localWork', 'localWorkKind', 'referenceKind']) expect(key in read.draft, key).toBe(false);
    expect(RecordDraft.safeParse(read.draft).success).toBe(true);
  });

  it("local_work = 'alumni' → the row error {column: 'local_work', code: 'invalid'}, the field left out", () => {
    const read = csvRecordRow(['title', 'audience', 'local_work'], ['Judul', 'children', 'alumni']);
    expect(read.errors).toEqual([{ column: 'local_work', code: 'invalid' }]);
    expect(read.draft.audience).toBe('children');
    expect('localWork' in read.draft).toBe(false);
  });

  it('an unknown code in each column is its own row error, in header order', () => {
    const read = csvRecordRow(['reference_kind', 'title', 'audience', 'local_work_kind'], ['novel', 'Judul', 'adults', 'diary']);
    expect(read.errors).toEqual([
      { column: 'reference_kind', code: 'invalid' },
      { column: 'audience', code: 'invalid' },
      { column: 'local_work_kind', code: 'invalid' },
    ]);
  });
});
