import fsp from 'node:fs/promises';
import os from 'node:os';
import path from 'node:path';
import { reportExportPath, reportWorkPath, type DataPath } from '@altis/platform';
import { newId } from '@altis/shared';
import yauzl, { type Entry, type ZipFile } from 'yauzl';
import { afterEach, beforeEach, describe, expect, it } from 'vitest';
import { openArchive } from '../../src/archive/zip-reader.js';
import { XlsxTooManyRowsError, openXlsxWriter, type XlsxCheckpoint, type XlsxColumn } from '../../src/export/xlsx.js';
import type { ReportRow } from '../../src/reports/types.js';
import { createXmlReader, type XmlEvent } from '../../src/xml/index.js';

// The streaming XLSX writer: one sheet with a bold, frozen header row, column widths, text and dates as inline strings
// under the formula guard, numbers of `int`, `money` and `percent` columns as numbers. The sheet is the open deflate
// entry of the shared resumable ZIP writer, so rows are appended across slices and the file is closed at the end. Each
// file is read back with our own zip reader and XML reader.

const PARTS = [
  '[Content_Types].xml',
  '_rels/.rels',
  'xl/workbook.xml',
  'xl/_rels/workbook.xml.rels',
  'xl/styles.xml',
  'xl/worksheets/sheet1.xml',
];
const XLSX_PART = /^(\[Content_Types\]\.xml|_rels\/\.rels|xl\/[a-z0-9_/]+\.xml(\.rels)?)$/;

let dataDir: string;

beforeEach(async () => {
  dataDir = await fsp.mkdtemp(path.join(os.tmpdir(), 'altis-xlsx-'));
});

afterEach(async () => {
  await fsp.rm(dataDir, { recursive: true, force: true });
});

interface Files {
  path: DataPath;
  central: DataPath;
}

function files(): Files {
  const runId = newId();
  return { path: reportExportPath(dataDir, runId, 'xlsx'), central: reportWorkPath(dataDir, runId, 'output.central') };
}

async function rejection(p: Promise<unknown>): Promise<unknown> {
  try {
    await p;
  } catch (error) {
    return error;
  }
  throw new Error('expected a rejection');
}

/** Every part of the file, in archive order, as text (read with the guarded reader; sheet XML compresses well). */
async function readParts(p: DataPath): Promise<[string, string][]> {
  const reader = await openArchive(p, { allow: XLSX_PART, maxRatio: 1000 });
  try {
    const out: [string, string][] = [];
    for (const e of reader.entries()) {
      const parts: Buffer[] = [];
      for await (const chunk of reader.read(e)) parts.push(Buffer.from(chunk));
      out.push([e.name, Buffer.concat(parts).toString('utf8')]);
    }
    return out;
  } finally {
    await reader.close();
  }
}

/** yauzl opens the file and reads every entry with its sizes checked. */
async function yauzlNames(p: DataPath): Promise<string[]> {
  const bytes = await fsp.readFile(p);
  const zip = await new Promise<ZipFile>((resolve, reject) =>
    yauzl.fromBuffer(bytes, { lazyEntries: true, validateEntrySizes: true, strictFileNames: true }, (e, z) => (e ? reject(e) : resolve(z!))),
  );
  const names: string[] = [];
  await new Promise<void>((resolve, reject) => {
    zip.on('error', reject);
    zip.on('end', () => resolve());
    zip.on('entry', (entry: Entry) => {
      zip.openReadStream(entry, (error, stream) => {
        if (error) return reject(error);
        stream!.on('data', () => undefined);
        stream!.on('error', reject);
        stream!.on('end', () => {
          names.push(entry.fileName.toString());
          zip.readEntry();
        });
      });
    });
    zip.readEntry();
  });
  return names;
}

function events(xml: string): XmlEvent[] {
  const reader = createXmlReader();
  return [...reader.write(xml), ...reader.end()];
}

function opens(xml: string, name: string): Record<string, string>[] {
  return events(xml).flatMap((e) => (e.type === 'open' && e.name === name ? [{ ...e.attrs }] : []));
}

interface Cell {
  attrs: Record<string, string>;
  /** The text of `<is><t>`, or of `<v>`. */
  text: string;
}

/** The cells of a sheet by reference (`A1`), and the row numbers in order. */
function sheetCells(xml: string): { cells: Map<string, Cell>; rows: number[] } {
  const cells = new Map<string, Cell>();
  const rows: number[] = [];
  let cell: Cell | null = null;
  let capture = false;
  for (const e of events(xml)) {
    if (e.type === 'open') {
      if (e.name === 'row') rows.push(Number(e.attrs['r']));
      if (e.name === 'c') cell = { attrs: { ...e.attrs }, text: '' };
      if (e.name === 't' || e.name === 'v') capture = true;
    } else if (e.type === 'close') {
      if (e.name === 't' || e.name === 'v') capture = false;
      if (e.name === 'c' && cell !== null) {
        cells.set(cell.attrs['r']!, cell);
        cell = null;
      }
    } else if (capture && cell !== null) {
      cell.text += e.text;
    }
  }
  return { cells, rows };
}

function partText(parts: [string, string][], name: string): string {
  const found = parts.find(([n]) => n === name);
  if (found === undefined) throw new Error(`no part ${name}`);
  return found[1];
}

const BOOK_COLUMNS: XlsxColumn[] = [
  { header: 'judul', type: 'text' },
  { header: 'eksemplar', type: 'int' },
  { header: 'harga', type: 'money' },
];

describe('openXlsxWriter: the workbook', () => {
  it('writes the parts in order, a bold frozen header, inline-string text under the guard and numbers as numbers', async () => {
    const f = files();
    const w = await openXlsxWriter(f.path, f.central, { columns: BOOK_COLUMNS, sheetName: 'Daftar Judul', checkpoint: null });
    await w.appendRows([
      ['=SUM(A1)', 2, 15000],
      ['تفسير الجلالين', 1, null],
    ]);
    const { size, rows } = await w.finish();
    expect(rows).toBe(2);
    expect(size).toBe((await fsp.stat(f.path)).size);
    expect(await yauzlNames(f.path)).toEqual(PARTS);

    const parts = await readParts(f.path);
    expect(parts.map(([name]) => name)).toEqual(PARTS);

    const overrides = opens(partText(parts, '[Content_Types].xml'), 'Override');
    expect(overrides).toEqual(
      expect.arrayContaining([
        { PartName: '/xl/workbook.xml', ContentType: 'application/vnd.openxmlformats-officedocument.spreadsheetml.sheet.main+xml' },
        { PartName: '/xl/worksheets/sheet1.xml', ContentType: 'application/vnd.openxmlformats-officedocument.spreadsheetml.worksheet+xml' },
        { PartName: '/xl/styles.xml', ContentType: 'application/vnd.openxmlformats-officedocument.spreadsheetml.styles+xml' },
      ]),
    );
    expect(opens(partText(parts, '_rels/.rels'), 'Relationship')).toEqual([
      expect.objectContaining({ Target: 'xl/workbook.xml', Type: 'http://schemas.openxmlformats.org/officeDocument/2006/relationships/officeDocument' }),
    ]);

    const sheets = opens(partText(parts, 'xl/workbook.xml'), 'sheet');
    expect(sheets).toEqual([{ name: 'Daftar Judul', sheetId: '1', 'r:id': 'rId1' }]);
    const rels = opens(partText(parts, 'xl/_rels/workbook.xml.rels'), 'Relationship');
    expect(rels).toEqual(
      expect.arrayContaining([
        expect.objectContaining({ Id: 'rId1', Target: 'worksheets/sheet1.xml' }),
        expect.objectContaining({ Target: 'styles.xml' }),
      ]),
    );

    const styles = partText(parts, 'xl/styles.xml');
    expect(opens(styles, 'fonts')).toEqual([expect.objectContaining({ count: '2' })]);
    expect(opens(styles, 'b')).toHaveLength(1); // font 1 is bold
    expect(opens(styles, 'cellXfs')).toEqual([expect.objectContaining({ count: '2' })]);
    const xfs = opens(styles, 'xf');
    expect(xfs.at(-2)).toMatchObject({ fontId: '0' });
    expect(xfs.at(-1)).toMatchObject({ fontId: '1' });

    const sheet = partText(parts, 'xl/worksheets/sheet1.xml');
    expect(opens(sheet, 'pane')).toEqual([expect.objectContaining({ ySplit: '1', topLeftCell: 'A2', state: 'frozen' })]);
    // widths: by type, never below the header's length + 2 ("eksemplar" has 9 characters)
    expect(opens(sheet, 'col').map((c) => [c['min'], c['max'], c['width']])).toEqual([
      ['1', '1', '30'],
      ['2', '2', '11'],
      ['3', '3', '14'],
    ]);
    const { cells, rows: rowNumbers } = sheetCells(sheet);
    expect(rowNumbers).toEqual([1, 2, 3]);
    for (const [ref, header] of [
      ['A1', 'judul'],
      ['B1', 'eksemplar'],
      ['C1', 'harga'],
    ] as const) {
      expect(cells.get(ref)).toEqual({ attrs: { r: ref, t: 'inlineStr', s: '1' }, text: header });
    }
    expect(cells.get('A2')).toEqual({ attrs: { r: 'A2', t: 'inlineStr' }, text: "'=SUM(A1)" });
    expect(cells.get('B2')).toEqual({ attrs: { r: 'B2' }, text: '2' });
    expect(cells.get('C2')).toEqual({ attrs: { r: 'C2' }, text: '15000' });
    expect(cells.get('A3')!.text).toBe('تفسير الجلالين');
    expect(cells.get('B3')!.text).toBe('1');
    expect(cells.has('C3')).toBe(false); // null: no cell
    expect(sheet).toContain('<t xml:space="preserve">');
  });

  it('writes each column type as its own kind of cell', async () => {
    const f = files();
    const columns: XlsxColumn[] = [
      { header: 'teks', type: 'text', widthChars: 12 },
      { header: 'tanggal', type: 'date' },
      { header: 'persen', type: 'percent' },
      { header: 'jumlah', type: 'int' },
      { header: 'nilai', type: 'money', widthChars: 3 },
    ];
    const w = await openXlsxWriter(f.path, f.central, { columns, sheetName: 'Jenis', checkpoint: null });
    await w.appendRows([
      ['\u0001=1', '2026-01-02', 45, Number.NaN, Number.POSITIVE_INFINITY],
      [42, '=2026', -5, 0, -0],
      ['a & <b> "c"\r\nd\u0000', null, null, 1.5, '=1'],
      ['-5', '', 0, null, 1e21],
      ['a'.repeat(40_000), `${'b'.repeat(32_766)}😀`, null, null, null],
    ]);
    await w.finish();
    const sheet = partText(await readParts(f.path), 'xl/worksheets/sheet1.xml');
    expect(opens(sheet, 'col').map((c) => c['width'])).toEqual(['12', '12', '8', '10', '7']);
    const { cells } = sheetCells(sheet);
    const inline = (ref: string): string | undefined => (cells.get(ref)?.attrs['t'] === 'inlineStr' ? cells.get(ref)!.text : undefined);
    const number = (ref: string): string | undefined => (cells.get(ref)?.attrs['t'] === undefined ? cells.get(ref)?.text : undefined);
    // a control character is dropped before the guard looks at the first character
    expect(inline('A2')).toBe("'=1");
    expect(inline('B2')).toBe('2026-01-02');
    expect(number('C2')).toBe('45');
    expect(cells.has('D2')).toBe(false); // not a finite number: no cell
    expect(cells.has('E2')).toBe(false);
    expect(inline('A3')).toBe('42'); // a number in a text column is its text
    expect(inline('B3')).toBe("'=2026");
    expect(number('C3')).toBe('-5');
    expect(number('D3')).toBe('0');
    expect(number('E3')).toBe('0');
    expect(inline('A4')).toBe('a & <b> "c"\r\nd'); // escaped in the XML, kept byte for byte (CR included)
    expect(number('D4')).toBe('1.5');
    expect(inline('E4')).toBe("'=1"); // text in a number column stays text, under the guard
    expect(inline('A5')).toBe("'-5");
    expect(inline('B5')).toBe('');
    expect(number('C5')).toBe('0');
    expect(number('E5')).toBe('1e+21');
    // a text longer than a cell holds is cut to 32 767 characters, never inside a surrogate pair
    expect(inline('A6')).toBe('a'.repeat(32_767));
    expect(inline('B6')).toBe('b'.repeat(32_766));
  });

  it('escapes a literal _xHHHH_ in a text so a spreadsheet reads the text back as it was', async () => {
    const f = files();
    const texts = ['Baris_x000D_akhir', '_x005F_x000D_', 'a_x41_b _X0041_ _xZZZZ_', '_x0041_x0042_', 'tanpa urutan_x'];
    const w = await openXlsxWriter(f.path, f.central, { columns: [{ header: 'judul_x0041_', type: 'text' }], sheetName: 'Teks', checkpoint: null });
    await w.appendRows(texts.map((s) => [s]));
    await w.finish();
    const { cells } = sheetCells(partText(await readParts(f.path), 'xl/worksheets/sheet1.xml'));
    // How a spreadsheet reads the stored text: every _xHHHH_, left to right, is the character U+HHHH.
    const decode = (s: string): string => s.replace(/_x([0-9A-Fa-f]{4})_/g, (_m, hex: string) => String.fromCharCode(parseInt(hex, 16)));
    expect(cells.get('A2')!.text).toBe('Baris_x005F_x000D_akhir');
    expect(decode(cells.get('A1')!.text)).toBe('judul_x0041_');
    texts.forEach((s, i) => expect(decode(cells.get(`A${i + 2}`)!.text), s).toBe(s));
    // Text without such a sequence is stored as it is.
    expect(cells.get('A6')!.text).toBe('tanpa urutan_x');
  });

  it('names the sheet within the rules of a sheet name', async () => {
    for (const [given, expected] of [
      ['Laporan [2026]: koleksi/*?\\ sangat panjang sekali', 'Laporan 2026 koleksi sangat pan'],
      ['[]', 'Sheet1'],
      ["'Data'", 'Data'],
      ['تفسير', 'تفسير'],
    ] as const) {
      const f = files();
      const w = await openXlsxWriter(f.path, f.central, { columns: BOOK_COLUMNS, sheetName: given, checkpoint: null });
      await w.finish();
      expect(opens(partText(await readParts(f.path), 'xl/workbook.xml'), 'sheet')[0]!['name']).toBe(expected);
    }
  });
});

describe('openXlsxWriter: across slices', () => {
  const ROWS: ReportRow[] = Array.from({ length: 1000 }, (_, i) => {
    const n = i + 1;
    const title = n % 7 === 0 ? `=judul ${n}` : n % 11 === 0 ? `تفسير ${n}` : `judul ${n}`;
    return [title, n, n * 1500];
  });

  async function oneBatch(): Promise<[string, string][]> {
    const f = files();
    const w = await openXlsxWriter(f.path, f.central, { columns: BOOK_COLUMNS, sheetName: 'Judul', checkpoint: null });
    await w.appendRows(ROWS);
    expect(await w.finish()).toMatchObject({ rows: 1000 });
    return readParts(f.path);
  }

  it('gives the same workbook for 1 000 rows in 4 batches, with a new writer after the second', async () => {
    const expected = await oneBatch();
    const f = files();
    let w = await openXlsxWriter(f.path, f.central, { columns: BOOK_COLUMNS, sheetName: 'Judul', checkpoint: null });
    await w.appendRows(ROWS.slice(0, 250));
    await w.appendRows(ROWS.slice(250, 500));
    const cp = JSON.parse(JSON.stringify(await w.checkpoint())) as XlsxCheckpoint;
    expect(cp.rows).toBe(500);
    expect(cp.zip.open?.name).toBe('xl/worksheets/sheet1.xml');
    // the slice wrote a third batch, then the process died before its checkpoint was recorded
    await w.appendRows(ROWS.slice(500, 750));
    await fsp.appendFile(f.path, Buffer.alloc(100, 0x7a));
    w = await openXlsxWriter(f.path, f.central, { columns: BOOK_COLUMNS, sheetName: 'Judul', checkpoint: cp });
    await w.appendRows(ROWS.slice(500, 750));
    await w.appendRows([]);
    await w.appendRows(ROWS.slice(750));
    expect(await w.finish()).toMatchObject({ rows: 1000 });
    const parts = await readParts(f.path);
    expect(parts).toEqual(expected);
    const { cells, rows } = sheetCells(partText(parts, 'xl/worksheets/sheet1.xml'));
    expect(rows).toHaveLength(1001);
    expect(cells.get('A8')!.text).toBe("'=judul 7");
    expect(cells.get('A12')!.text).toBe('تفسير 11');
    expect(cells.get('C1001')!.text).toBe(String(1000 * 1500));
  });

  it('refuses more rows than an XLSX export holds, before writing them', async () => {
    const f = files();
    const w = await openXlsxWriter(f.path, f.central, { columns: BOOK_COLUMNS, sheetName: 'Judul', checkpoint: null });
    const before = await w.checkpoint();
    const many: ReportRow[] = Array.from({ length: 100_001 }, (_, i) => [`judul ${i}`, i, i]);
    const error = await rejection(w.appendRows(many));
    expect(error).toBeInstanceOf(XlsxTooManyRowsError);
    expect(error).toMatchObject({ rows: 100_001, max: 100_000 });
    expect(await w.checkpoint()).toEqual(before);

    const g = files();
    const small = await openXlsxWriter(g.path, g.central, { columns: BOOK_COLUMNS, sheetName: 'Judul', checkpoint: null, maxRows: 5 });
    await small.appendRows(ROWS.slice(0, 3));
    await expect(small.appendRows(ROWS.slice(3, 6))).rejects.toMatchObject({ rows: 6, max: 5 });
    expect(await small.finish()).toMatchObject({ rows: 3 });
    expect(sheetCells(partText(await readParts(g.path), 'xl/worksheets/sheet1.xml')).rows).toEqual([1, 2, 3, 4]);
  });

  it('refuses columns, rows and checkpoints it cannot write', async () => {
    const f = files();
    await expect(openXlsxWriter(f.path, f.central, { columns: [], sheetName: 'x', checkpoint: null })).rejects.toThrow(TypeError);
    await expect(
      openXlsxWriter(f.path, f.central, { columns: [{ header: 'x', type: 'blob' as 'text' }], sheetName: 'x', checkpoint: null }),
    ).rejects.toThrow(TypeError);
    const w = await openXlsxWriter(f.path, f.central, { columns: BOOK_COLUMNS, sheetName: 'x', checkpoint: null });
    await expect(w.appendRows([['a', 1, 2, 3]])).rejects.toThrow(TypeError);
    const cp = await w.checkpoint();
    await expect(
      openXlsxWriter(f.path, f.central, { columns: BOOK_COLUMNS, sheetName: 'x', checkpoint: { ...cp, zip: { ...cp.zip, open: null } } }),
    ).rejects.toThrow(TypeError);
    await expect(openXlsxWriter(f.path, f.central, { columns: BOOK_COLUMNS, sheetName: 'x', checkpoint: { ...cp, rows: -1 } })).rejects.toThrow(
      TypeError,
    );
  });
});
