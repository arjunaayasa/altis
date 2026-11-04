import { describe, expect, it } from 'vitest';
import { cleanDate, cleanText, decodeCell, extractYear, fixMojibake, textCell } from '../../src/migration/slims/source/index.js';

// The text clean-up of the SLiMS migration (spec §11.5 steps 1-3, 5 and 6): NUL and SLiMS's stored backslashes, double
// decoded UTF-8 (mojibake), bytes that are not UTF-8 (read as Windows-1252), years and dates.

const NUL = String.fromCharCode(0);
const bytes = (...b: number[]): Uint8Array => Uint8Array.from(b);
const utf8 = (s: string): Uint8Array => new Uint8Array(Buffer.from(s, 'utf8'));

describe('cleanText', () => {
  it('unescapes the backslashes SLiMS stores before quotes and backslashes', () => {
    expect(cleanText('O\\\'Reilly')).toEqual({ value: "O'Reilly", fixes: ['backslash'] });
    expect(cleanText('Kata \\"kunci\\"')).toEqual({ value: 'Kata "kunci"', fixes: ['backslash'] });
    expect(cleanText('C:\\\\data')).toEqual({ value: 'C:\\data', fixes: ['backslash'] });
    expect(cleanText('a\\nb')).toEqual({ value: 'a\\nb', fixes: [] });
  });

  it('repairs double decoded UTF-8', () => {
    expect(cleanText('CafÃ©')).toEqual({ value: 'Café', fixes: ['mojibake'] });
  });

  it('removes NUL', () => {
    expect(cleanText(`Ju${NUL}dul${NUL}`)).toEqual({ value: 'Judul', fixes: ['nul'] });
  });

  it('applies the steps in the order of §11.5 and reports each once', () => {
    expect(cleanText(`O\\'Reilly CafÃ©${NUL}`)).toEqual({ value: "O'Reilly Café", fixes: ['nul', 'backslash', 'mojibake'] });
  });

  it('decodes bytes that are not UTF-8 as Windows-1252', () => {
    expect(cleanText(bytes(0x43, 0x61, 0x66, 0xe9, 0x20, 0x80, 0x35))).toEqual({ value: 'Café €5', fixes: ['cp1252'] });
    expect(cleanText(bytes(0x4f, 0x5c, 0x27, 0x4e, 0xf1))).toEqual({ value: "O'Nñ", fixes: ['backslash', 'cp1252'] });
  });

  it('leaves clean text and valid UTF-8 bytes alone', () => {
    expect(cleanText('Laskar Pelangi')).toEqual({ value: 'Laskar Pelangi', fixes: [] });
    expect(cleanText('Café 中文 naïve Ñandú über')).toEqual({ value: 'Café 中文 naïve Ñandú über', fixes: [] });
    expect(cleanText(utf8('Café'))).toEqual({ value: 'Café', fixes: [] });
    expect(cleanText('')).toEqual({ value: '', fixes: [] });
  });
});

describe('fixMojibake', () => {
  it('reverses a Latin-1 and a Windows-1252 double decoding', () => {
    expect(fixMojibake('CafÃ©')).toBe('Café');
    expect(fixMojibake('Itâ€™s')).toBe('It’s');
    expect(fixMojibake(`It${String.fromCharCode(0xe2, 0x80, 0x99)}s`)).toBe('It’s');
    expect(fixMojibake('JosÃ© RizÃ¡l')).toBe('José Rizál');
    expect(fixMojibake('Â© 2001')).toBe('© 2001');
    expect(fixMojibake('ðŸ“š buku')).toBe(String.fromCodePoint(0x1f4da) + ' buku');
  });

  it('repairs only the double decoded runs of a mixed value', () => {
    expect(fixMojibake('CafÃ© 中文 é')).toBe('Café 中文 é');
  });

  it('repairs a value decoded twice over', () => {
    expect(fixMojibake('CafÃƒÂ©')).toBe('Café');
  });

  it('answers null when nothing looks double decoded or the reversal is not valid UTF-8', () => {
    expect(fixMojibake('Café')).toBeNull();
    expect(fixMojibake('naïve')).toBeNull();
    expect(fixMojibake('Ã')).toBeNull();
    expect(fixMojibake('Ã a')).toBeNull();
    expect(fixMojibake('plain ASCII')).toBeNull();
    expect(fixMojibake(`Â${String.fromCharCode(0x80)}`)).toBeNull(); // would decode to a C1 control
  });
});

describe('decodeCell and textCell', () => {
  it('decodes valid UTF-8 as it is and anything else as Windows-1252', () => {
    expect(decodeCell(utf8('Café'))).toEqual({ value: 'Café', cp1252: false });
    expect(decodeCell(bytes(0x43, 0x61, 0x66, 0xe9))).toEqual({ value: 'Café', cp1252: true });
    expect(decodeCell(bytes(0x93, 0x61, 0x94, 0x81))).toEqual({ value: `“a”${String.fromCharCode(0x81)}`, cp1252: true });
    expect(decodeCell(bytes(0xef, 0xbb, 0xbf, 0x41))).toEqual({ value: `${String.fromCharCode(0xfeff)}A`, cp1252: false });
    expect(decodeCell(bytes())).toEqual({ value: '', cp1252: false });
  });

  it('keeps bytes that are not UTF-8 as bytes, and gives text for the rest', () => {
    expect(textCell(utf8('Café'))).toBe('Café');
    expect(textCell(bytes(0x43, 0xe9))).toEqual(bytes(0x43, 0xe9));
    expect(textCell(bytes(0x43, 0xe9))).toBeInstanceOf(Uint8Array);
  });
});

describe('extractYear', () => {
  it.each([
    ['c1998?', '1998'],
    ['[2005?]', '2005'],
    ['1998-2000', '1998'],
    ['Jakarta, 1750', '1750'],
    ['2099', '2099'],
    ['tanpa tahun', null],
    ['1499', null],
    ['2100', null],
    ['', null],
  ])('%j → %j', (text, year) => {
    expect(extractYear(text)).toBe(year);
  });
});

describe('cleanDate', () => {
  it.each([
    ['2020-01-05', '2020-01-05'],
    ['2020-01-05 10:11:12', '2020-01-05 10:11:12'],
    [' 2020-02-29 ', '2020-02-29'],
    ['2020-01-05T10:11', '2020-01-05 10:11:00'],
    ['2020-01-05 10:11:12.500', '2020-01-05 10:11:12'],
    ['0000-00-00', null],
    ['0000-00-00 00:00:00', null],
    ['2020-00-10', null],
    ['2020-02-30', null],
    ['1900-02-29', null],
    ['2020-01-05 25:00:00', null],
    ['0999-01-01', null],
    ['MODS creation date', null],
    ['', null],
  ])('%j → %j', (text, date) => {
    expect(cleanDate(text)).toBe(date);
  });
});
