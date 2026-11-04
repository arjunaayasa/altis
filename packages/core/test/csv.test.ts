import { describe, expect, it } from 'vitest';
import { CSV_BOM, csvCell, csvRow } from '../src/export/csv.js';

// The one CSV exporter (spec §7.4): every cell quoted with `"` doubled, and a cell that a spreadsheet would read as a
// formula (it starts with `= + - @`, TAB or CR, or a full-width `＝ ＋ － ＠`) gets a `'` in front, inside the quotes.

describe('csvCell', () => {
  it('prefixes a formula start with an apostrophe, inside the quotes', () => {
    expect(csvCell('=1+1')).toBe(`"'=1+1"`);
    expect(csvCell('+1')).toBe(`"'+1"`);
    expect(csvCell('-5')).toBe(`"'-5"`);
    expect(csvCell('@SUM(A1)')).toBe(`"'@SUM(A1)"`);
    expect(csvCell('\tx')).toBe(`"'\tx"`);
    expect(csvCell('\rx')).toBe(`"'\rx"`);
  });

  it('prefixes the full-width forms U+FF1D, U+FF0B, U+FF0D and U+FF20', () => {
    expect(csvCell('＝SUM(A1)')).toBe(`"'＝SUM(A1)"`);
    expect(csvCell('＋1')).toBe(`"'＋1"`);
    expect(csvCell('－1')).toBe(`"'－1"`);
    expect(csvCell('＠x')).toBe(`"'＠x"`);
  });

  it('quotes every cell and doubles an inner quote', () => {
    expect(csvCell('a"b')).toBe(`"a""b"`);
    expect(csvCell('plain')).toBe(`"plain"`);
    expect(csvCell('a,b;c\r\nd')).toBe(`"a,b;c\r\nd"`);
    expect(csvCell('=" "')).toBe(`"'="" """`);
  });

  it('leaves a formula character that is not the first one alone', () => {
    expect(csvCell('a=1')).toBe(`"a=1"`);
    expect(csvCell(' =1')).toBe(`" =1"`);
    expect(csvCell('')).toBe(`""`);
  });

  it('writes null and undefined as an empty cell', () => {
    expect(csvCell(null)).toBe(`""`);
    expect(csvCell(undefined)).toBe(`""`);
  });

  it('writes numbers and booleans as text, under the same prefix rule', () => {
    expect(csvCell(42)).toBe(`"42"`);
    expect(csvCell(-5)).toBe(`"'-5"`);
    expect(csvCell(true)).toBe(`"true"`);
  });

  it('writes an object as its JSON text, which starts with `{` and gets no prefix', () => {
    expect(csvCell({ usernameKey: '=HYPERLINK(1)' })).toBe(`"{""usernameKey"":""=HYPERLINK(1)""}"`);
    expect(csvCell({})).toBe(`"{}"`);
    expect(csvCell(['-1'])).toBe(`"[""-1""]"`);
  });
});

describe('csvRow', () => {
  it('joins the cells with the delimiter and ends the line with CRLF', () => {
    expect(csvRow(['a', 'b'], ';')).toBe(`"a";"b"\r\n`);
    expect(csvRow(['a', 'b'], ',')).toBe(`"a","b"\r\n`);
    expect(csvRow(['=1', null, 7], ',')).toBe(`"'=1","","7"\r\n`);
  });
});

describe('CSV_BOM', () => {
  it('is the UTF-8 byte order mark (Excel then reads the file as UTF-8)', () => {
    expect(CSV_BOM).toBe('﻿');
    expect([...Buffer.from(CSV_BOM, 'utf8')]).toEqual([0xef, 0xbb, 0xbf]);
  });
});
