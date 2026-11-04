import { describe, expect, it } from 'vitest';
import { CSV_ROW_MAX_BYTES, createCsvReader, type CsvRow } from '../../src/catalog/csv/index.js';

// The CSV reader of the catalog imports (Phase 2 spec §5.2, decision P2-15, Review Focus 1, S9): bytes in, rows out,
// with the separator and the encoding detected from the file, byte offsets to resume from, and a bounded row.

/** Bytes from text whose characters are all ≤ 0xFF, each one byte (`'T\xe9h'` is the cp1252 bytes of `Téh`). */
function bytes(s: string): Uint8Array {
  return Uint8Array.from(s, (c) => c.charCodeAt(0));
}

const utf8 = (s: string): Uint8Array => new TextEncoder().encode(s);

function concat(...parts: Uint8Array[]): Uint8Array {
  const out = new Uint8Array(parts.reduce((n, p) => n + p.length, 0));
  let at = 0;
  for (const p of parts) {
    out.set(p, at);
    at += p.length;
  }
  return out;
}

/** Every row of `data`, pushed in chunks of `chunk` bytes (all at once by default). */
function readAll(data: Uint8Array, o: { chunk?: number; separator?: ',' | ';' } = {}): { rows: CsvRow[]; reader: ReturnType<typeof createCsvReader> } {
  const reader = createCsvReader(o.separator === undefined ? {} : { separator: o.separator });
  const rows: CsvRow[] = [];
  const size = o.chunk ?? Math.max(1, data.length);
  for (let at = 0; at < data.length; at += size) rows.push(...reader.push(data.subarray(at, at + size)));
  rows.push(...reader.end());
  return { rows, reader };
}

const cellsOf = (rows: CsvRow[]) => rows.map((r) => r.cells);

/** A CSV row of `n` ASCII bytes plus CRLF: `<prefix>;xxxx…\r\n`. */
function filler(prefix: string, n: number): string {
  return `${prefix};${'x'.repeat(Math.max(0, n - prefix.length - 3))}\r\n`;
}

describe('createCsvReader: Review Focus 1 (Excel on an Indonesian Windows PC)', () => {
  const file = bytes('T\xe9h;Ma\xf1ana\r\n"a\r\nb";x\r\n');

  it('reads cp1252 with `;` and CRLF, keeps a CRLF inside quotes in its cell, and warns encoding_cp1252', () => {
    const { rows, reader } = readAll(file);
    expect(reader.info()).toEqual({ separator: ';', encoding: 'cp1252', bom: false, warnings: ['encoding_cp1252'] });
    expect(cellsOf(rows)).toEqual([
      ['T\u00e9h', 'Ma\u00f1ana'],
      ['a\r\nb', 'x'],
    ]);
    expect(rows.map((r) => [r.line, r.endOffset])).toEqual([
      [1, 12],
      [2, file.length],
    ]);
    expect(rows.every((r) => r.error === undefined && r.warning === undefined)).toBe(true);
  });

  it('reads the same rows when the bytes arrive one at a time', () => {
    expect(readAll(file, { chunk: 1 }).rows).toEqual(readAll(file).rows);
  });

  it('reads the same file with a UTF-8 BOM in front of it (the BOM is skipped, the encoding still cp1252)', () => {
    const { rows, reader } = readAll(concat(bytes('\xef\xbb\xbf'), file));
    expect(reader.info()).toEqual({ separator: ';', encoding: 'cp1252', bom: true, warnings: ['encoding_cp1252'] });
    expect(cellsOf(rows)).toEqual([
      ['T\u00e9h', 'Ma\u00f1ana'],
      ['a\r\nb', 'x'],
    ]);
    expect(rows[1]!.endOffset).toBe(file.length + 3);
  });

  it('maps the cp1252 bytes 0x80-0x9F (euro, curly quotes, dashes) and replaces the five undefined ones with a row warning', () => {
    const { rows } = readAll(bytes('\x80\x93ok\x94;\x96\n\x81;y\n'));
    expect(rows[0]).toEqual({ line: 1, endOffset: 8, cells: ['\u20ac\u201cok\u201d', '\u2013'] });
    expect(rows[1]).toEqual({ line: 2, endOffset: 12, cells: ['\ufffd', 'y'], warning: 'invalid_bytes' });
  });
});

describe('createCsvReader: resuming from state()', () => {
  it('a reader resumed from the state taken after row 1 reads the same rows 2…n', () => {
    const file = bytes('T\xe9h;Ma\xf1ana\r\n"a\r\nb";x\r\n\r\nlast;\xe9\r\nno end;z');
    const whole = readAll(file).rows;
    expect(cellsOf(whole)).toEqual([['T\u00e9h', 'Ma\u00f1ana'], ['a\r\nb', 'x'], ['last', '\u00e9'], ['no end', 'z']]);
    // The blank line is not a row but keeps its number, as a spreadsheet shows it.
    expect(whole.map((r) => r.line)).toEqual([1, 2, 4, 5]);

    const first = createCsvReader();
    // Row 1, its line break and two bytes of row 2: the encoding is known (é is not UTF-8), so row 1 comes out at once.
    expect(first.push(file.subarray(0, 14))).toEqual([whole[0]]);
    const state = first.state();
    expect(state).toEqual({ byteOffset: 12, line: 1, separator: ';', encoding: 'cp1252' });

    const resumed = createCsvReader({ resume: state });
    const rest = [...resumed.push(file.subarray(state.byteOffset)), ...resumed.end()];
    expect(rest).toEqual(whole.slice(1));
    expect(resumed.info()).toEqual({ separator: ';', encoding: 'cp1252', bom: false, warnings: ['encoding_cp1252'] });
    expect(resumed.state()).toEqual({ byteOffset: file.length, line: 5, separator: ';', encoding: 'cp1252' });
  });

  it('the state after any row is {byteOffset: row.endOffset, line: row.line, separator, encoding}', () => {
    // A UTF-8 file larger than the 64 KiB sniff window, read in 1000-byte chunks.
    let text = 'title,notes\n';
    for (let i = 0; text.length < 150_000; i++) text += `"Judul ${i}","Catatan, baris ${i}\nkedua"\n`;
    const file = utf8(text);
    const whole = readAll(file).rows;
    const reader = createCsvReader();
    let seen = 0;
    for (let at = 0; at < file.length; at += 1000) {
      const rows = reader.push(file.subarray(at, at + 1000));
      seen += rows.length;
      if (rows.length === 0) continue;
      const last = rows[rows.length - 1]!;
      expect(reader.state()).toEqual({ byteOffset: last.endOffset, line: last.line, separator: ',', encoding: 'utf-8' });
    }
    expect(seen).toBe(whole.length);
    for (const k of [0, 1, 500, whole.length - 2]) {
      const row = whole[k]!;
      const resumed = createCsvReader({ resume: { byteOffset: row.endOffset, line: row.line, separator: ',', encoding: 'utf-8' } });
      const rest = [...resumed.push(file.subarray(row.endOffset)), ...resumed.end()];
      expect(rest).toEqual(whole.slice(k + 1));
    }
  });

  it('state() and info() refuse to answer before the format is known', () => {
    const reader = createCsvReader();
    expect(reader.push(utf8('title,notes\n'))).toEqual([]);
    expect(() => reader.state()).toThrow(/not known/);
    expect(() => reader.info()).toThrow(/not known/);
  });
});

describe('createCsvReader: bounded rows (S9)', () => {
  it('a quote opened on row 2 and never closed over 3 MiB → one row_too_long row, then the following rows, holding ≤ ~1 MiB', () => {
    const head = utf8('title;notes\r\n"');
    const long = new Uint8Array(3 * 1024 * 1024).fill(0x78);
    const tail = utf8('\r\nBumi Manusia;satu\r\nAnak Semua Bangsa;dua\r\n');
    const file = concat(head, long, tail);
    const reader = createCsvReader();
    const rows: CsvRow[] = [];
    let held = 0;
    for (let at = 0; at < file.length; at += 65_536) {
      rows.push(...reader.push(file.subarray(at, at + 65_536)));
      held = Math.max(held, reader.held());
    }
    rows.push(...reader.end());
    expect(rows.map((r) => ({ line: r.line, cells: r.cells, error: r.error }))).toEqual([
      { line: 1, cells: ['title', 'notes'], error: undefined },
      { line: 2, cells: [], error: 'row_too_long' },
      { line: 3, cells: ['Bumi Manusia', 'satu'], error: undefined },
      { line: 4, cells: ['Anak Semua Bangsa', 'dua'], error: undefined },
    ]);
    // The error row ends after the line break that ends the skipped bytes, so a resume from it is right.
    expect(rows[1]!.endOffset).toBe(head.length + long.length + 2);
    expect(held).toBeGreaterThan(CSV_ROW_MAX_BYTES / 2);
    expect(held).toBeLessThanOrEqual(CSV_ROW_MAX_BYTES + 64 * 1024);
    expect(reader.held()).toBe(0);
  });

  it('when the unclosed quote spans lines, the reader leaves the quote at the cap and resumes after the next line break', () => {
    const line = 'y'.repeat(99) + '\n';
    const file = utf8(`a,b\n"open,${line.repeat(12_000)}c,d\n`);
    const { rows } = readAll(file, { chunk: 100_000 });
    expect(rows[0]!.cells).toEqual(['a', 'b']);
    expect(rows[1]).toMatchObject({ line: 2, cells: [], error: 'row_too_long' });
    // The bytes after the cap's line break are read as rows again.
    expect(rows.slice(2, -1).every((r) => r.cells.length === 1 && /^y{99}$/.test(r.cells[0]!))).toBe(true);
    expect(rows[rows.length - 1]!.cells).toEqual(['c', 'd']);
    // Row 2 starts at byte 4 and its lines of 100 bytes at byte 10: the cap falls inside line `consumed - 1`.
    const consumed = Math.floor((4 + CSV_ROW_MAX_BYTES - 10) / 100) + 1;
    expect(rows.length).toBe(2 + (12_000 - consumed) + 1);
  });

  it('a row of exactly 1 MiB is read; one byte more is row_too_long, also without quotes', () => {
    const exact = 'z'.repeat(CSV_ROW_MAX_BYTES);
    expect(readAll(utf8(`a\n${exact}\nb\n`), { chunk: 300_000 }).rows.map((r) => r.cells[0]?.length ?? r.error)).toEqual([1, CSV_ROW_MAX_BYTES, 1]);
    expect(readAll(utf8(`a\n${exact}z\nb\n`), { chunk: 300_000 }).rows.map((r) => r.error ?? r.cells[0])).toEqual(['a', 'row_too_long', 'b']);
    expect(readAll(utf8(`a\n${exact}zz`)).rows.map((r) => r.error ?? r.cells[0])).toEqual(['a', 'row_too_long']);
  });

  it('a quote still open at the end of the file is unclosed_quote, never a cell that swallowed the rest', () => {
    const { rows } = readAll(utf8('title;notes\r\n"Bumi;satu\r\nAnak;dua\r\n'));
    expect(rows).toEqual([
      { line: 1, endOffset: 13, cells: ['title', 'notes'] },
      { line: 2, endOffset: 35, cells: [], error: 'unclosed_quote' },
    ]);
  });
});

describe('createCsvReader: RFC 4180 and the detection', () => {
  it('reads UTF-8 with a BOM, LF line ends, quoted separators and doubled quotes', () => {
    const { rows, reader } = readAll(utf8('\ufefftitle,notes\n"Laskar, Pelangi","Kata ""hai"", lalu\npergi"\n'));
    expect(reader.info()).toEqual({ separator: ',', encoding: 'utf-8', bom: true, warnings: [] });
    expect(cellsOf(rows)).toEqual([
      ['title', 'notes'],
      ['Laskar, Pelangi', 'Kata "hai", lalu\npergi'],
    ]);
  });

  it('takes the separator that appears more often outside quotes in the first line', () => {
    expect(readAll(utf8('"a;b;c",x,y\n1;2,3\n')).reader.info().separator).toBe(',');
    expect(readAll(utf8('"a,b,c";x;y\n1,2;3\n')).reader.info().separator).toBe(';');
    expect(readAll(utf8('\r\n\r\njudul;catatan\n')).reader.info().separator).toBe(';');
    expect(readAll(utf8('a,b;c;d\n')).reader.info().separator).toBe(';');
    // A tie, or a single column: the comma.
    expect(readAll(utf8('a;b,c\n')).reader.info().separator).toBe(',');
    expect(readAll(utf8('judul\nBumi\n')).reader.info().separator).toBe(',');
    // The caller's separator wins.
    const forced = readAll(utf8('a;b,c\n'), { separator: ';' });
    expect(forced.reader.info().separator).toBe(';');
    expect(forced.rows[0]!.cells).toEqual(['a', 'b,c']);
  });

  it('counts the first line with the parser\'s quoting: a quote inside an unquoted cell is a character, a BOM is not a cell', () => {
    // `12"` (inches) opens no quoted cell, so the separators after it count.
    const inches = readAll(utf8('ukuran 12";judul;tahun\n12;Bumi;1980\n'));
    expect(inches.reader.info().separator).toBe(';');
    expect(cellsOf(inches.rows)).toEqual([
      ['ukuran 12"', 'judul', 'tahun'],
      ['12', 'Bumi', '1980'],
    ]);
    // A quoted first cell right after the BOM is quoted: its commas do not count.
    expect(readAll(utf8('\ufeff"a,b,c";d\n')).reader.info().separator).toBe(';');
    // A doubled quote inside a quoted cell keeps it quoted.
    expect(readAll(utf8('"a "" b,c,d";e;f\n')).reader.info().separator).toBe(';');
  });

  it('ends rows on CRLF, LF or a lone CR, skips blank lines, and reads a last row without a line break', () => {
    const { rows } = readAll(utf8('a;b\rc;d\r\n\n;\ne;f;'));
    expect(rows.map((r) => [r.line, r.cells])).toEqual([
      [1, ['a', 'b']],
      [2, ['c', 'd']],
      [4, ['', '']],
      [5, ['e', 'f', '']],
    ]);
  });

  it('a lone CR at the end of a chunk waits for the next byte', () => {
    const file = utf8('a;b\r\nc;d\re;f');
    // A known format (a resume from the start), so rows come out before the 64 KiB sniff window is full.
    const reader = createCsvReader({ resume: { byteOffset: 0, line: 0, separator: ';', encoding: 'utf-8' } });
    expect(reader.push(file.subarray(0, 4))).toEqual([]);
    expect(reader.push(file.subarray(4, 9))).toEqual([{ line: 1, endOffset: 5, cells: ['a', 'b'] }]);
    expect(reader.push(file.subarray(9))).toEqual([{ line: 2, endOffset: 9, cells: ['c', 'd'] }]);
    expect(reader.end()).toEqual([{ line: 3, endOffset: 12, cells: ['e', 'f'] }]);
  });

  it('is lenient with a quote inside an unquoted cell and with text after a closing quote', () => {
    expect(cellsOf(readAll(utf8('ab"c;"Laskar" Pelangi;"x"""\n'), { separator: ';' }).rows)).toEqual([['ab"c', 'Laskar Pelangi', 'x"']]);
  });

  it('decides UTF-8 on a valid first 64 KiB even when a character crosses its end, and marks a later invalid byte', () => {
    // 65 535 ASCII bytes, then "é" (2 bytes) across the 64 KiB boundary, then a cp1252 "é" much later.
    const first = `h;x\n${'a'.repeat(65_530)}\n\u00e9;x\n`;
    expect(utf8(first)[65_535]).toBe(0xc3);
    const file = concat(utf8(first), utf8('ok;fine\n'), bytes('caf\xe9;y\n'));
    const { rows, reader } = readAll(file, { chunk: 4096 });
    expect(reader.info()).toEqual({ separator: ';', encoding: 'utf-8', bom: false, warnings: [] });
    expect(rows.slice(2).map((r) => [r.cells, r.warning])).toEqual([
      [['\u00e9', 'x'], undefined],
      [['ok', 'fine'], undefined],
      [['caf\ufffd', 'y'], 'invalid_bytes'],
    ]);
  });

  it('a short file that ends inside a UTF-8 sequence is not valid UTF-8: cp1252', () => {
    expect(readAll(bytes('judul;x\n\xc3')).reader.info().encoding).toBe('cp1252');
  });

  it('an empty file has no rows and the default format', () => {
    const { rows, reader } = readAll(new Uint8Array(0));
    expect(rows).toEqual([]);
    expect(reader.info()).toEqual({ separator: ',', encoding: 'utf-8', bom: false, warnings: [] });
    expect(reader.state()).toEqual({ byteOffset: 0, line: 0, separator: ',', encoding: 'utf-8' });
  });

  it('refuses push() after end()', () => {
    const reader = createCsvReader();
    reader.end();
    expect(() => reader.push(utf8('a\n'))).toThrow(/after end/);
  });

  it('reads a 64 KiB-plus file of many rows the same in any chunk size', () => {
    let text = '';
    for (let i = 0; i < 4000; i++) text += filler(`r${i}`, 24);
    const file = utf8(text);
    const once = readAll(file).rows;
    expect(once).toHaveLength(4000);
    for (const chunk of [1, 7, 4096, 65_536]) expect(readAll(file, { chunk }).rows).toEqual(once);
  });
});
