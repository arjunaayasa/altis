import { describe, expect, it } from 'vitest';
import { textWidth, toWinAnsi } from '../../src/print/index.js';

// Phase 2 spec §7: the standard fonts are written in WinAnsiEncoding, not embedded. A character outside WinAnsi is
// transliterated (NFKD, combining marks stripped), and what is still outside becomes `?`.

/** Reads WinAnsi bytes with the platform's own code page 1252 decoder (an independent table). */
function cp1252(bytes: Uint8Array): string {
  return new TextDecoder('windows-1252').decode(bytes);
}

describe('toWinAnsi', () => {
  it('transliterates outside WinAnsi and replaces what is left with ? (K13 example)', () => {
    const r = toWinAnsi('\u{112}kspedisi \u{6771}\u{4EAC}');
    expect(cp1252(r.bytes)).toBe('Ekspedisi ??');
    expect(r.replaced).toBe(2);
  });

  it('keeps every printable ASCII character as its own byte', () => {
    const ascii = Array.from({ length: 95 }, (_, i) => String.fromCharCode(0x20 + i)).join('');
    const r = toWinAnsi(ascii);
    expect([...r.bytes]).toEqual(Array.from({ length: 95 }, (_, i) => 0x20 + i));
    expect(r.replaced).toBe(0);
  });

  it('keeps the characters WinAnsi has, a decomposed one composed first', () => {
    const s = 'Caf\u{E9} Cafe\u{301} Espa\u{F1}a \u{20AC} \u{201C}x\u{201D} \u{2013} \u{2026} \u{160}\u{178} \u{A0}\u{FF}';
    const r = toWinAnsi(s);
    expect(r.replaced).toBe(0);
    expect(cp1252(r.bytes)).toBe(s.normalize('NFC'));
    expect([...toWinAnsi('\u{E9}').bytes]).toEqual([0xe9]);
    expect([...toWinAnsi('\u{20AC}\u{2014}\u{2122}').bytes]).toEqual([0x80, 0x97, 0x99]);
  });

  it('maps every character of code page 1252 back to its byte', () => {
    const defined = Array.from({ length: 256 }, (_, b) => b).filter(
      (b) => b >= 0x20 && b !== 0x7f && ![0x81, 0x8d, 0x8f, 0x90, 0x9d].includes(b),
    );
    const text = cp1252(Uint8Array.from(defined));
    const r = toWinAnsi(text);
    expect(r.replaced).toBe(0);
    expect([...r.bytes]).toEqual(defined);
  });

  it('decomposes compatibility characters and strips marks the font cannot show', () => {
    expect(cp1252(toWinAnsi('\u{FB01}le \u{2460} \u{1EA0}\u{1EF9} \u{1E0C}ewi').bytes)).toBe('file 1 Ay Dewi');
    expect(toWinAnsi('\u{FB01}').replaced).toBe(0);
  });

  it('prints an invisible format character as nothing and a modifier letter of romanisation as its quotation mark', () => {
    for (const [given, printed] of [
      ['Sejarah\u{200B}Indonesia', 'SejarahIndonesia'],
      ['Kitab\u{FEFF}', 'Kitab'],
      ['a\u{200C}b\u{200D}c\u{2060}d\u{200E}e\u{200F}', 'abcde'],
      ['Tafsir al-Qur\u{2BC}an', 'Tafsir al-Qur\u{2019}an'],
      ['Tafs\u{12B}r al-Qur\u{2BE}\u{101}n', 'Tafsir al-Qur\u{2019}an'],
      ['Mu\u{1E25}ammad \u{2BF}Abduh', 'Muhammad \u{2018}Abduh'],
      ['Hawai\u{2BB}i', 'Hawai\u{2018}i'],
    ] as const) {
      const r = toWinAnsi(given);
      expect(cp1252(r.bytes), given).toBe(printed);
      expect([r.replaced, r.otherScript], given).toEqual([0, 0]);
    }
    // A soft hyphen is a format character WinAnsi has: it keeps its byte.
    expect([...toWinAnsi('a\u{AD}b').bytes]).toEqual([0x61, 0xad, 0x62]);
  });

  it('counts apart the characters of another writing system that print as ?: a symbol or an emoji is none', () => {
    // Five Arabic letters, two Han characters, a Javanese letter (its vowel sign is a mark, stripped).
    expect(toWinAnsi('\u{062A}\u{0641}\u{0633}\u{064A}\u{0631} \u{6771}\u{4EAC} \u{A9A0}\u{A9B8}')).toMatchObject({ replaced: 8, otherScript: 8 });
    expect(toWinAnsi('Belajar \u{1F680} \u{2605} \u{2192} \u{0}')).toMatchObject({ replaced: 4, otherScript: 0 });
    expect(toWinAnsi('\u{0663}\u{0660}')).toMatchObject({ replaced: 2, otherScript: 2 });
    expect(toWinAnsi('\u{14B}')).toMatchObject({ replaced: 1, otherScript: 0 });
  });

  it('replaces control characters, lone surrogates, astral characters and other scripts by one ? each', () => {
    const r = toWinAnsi('a\u{0}\u{1F}\u{7F}\u{85}b\u{D800}c\u{1F600}d\u{3B1}\u{5D0}');
    expect(cp1252(r.bytes)).toBe('a????b?c?d??');
    expect(r.replaced).toBe(8);
    expect(toWinAnsi('').bytes.length).toBe(0);
  });
});

describe('textWidth', () => {
  it('sums the published AFM widths of the standard fonts', () => {
    // Helvetica H 722, e 556, l 222, o 556; Helvetica-Bold H 722, e 556, l 278, o 611; Courier 600 each.
    expect(textWidth('Hello', 'Helvetica', 10)).toBeCloseTo(22.78, 10);
    expect(textWidth('Hello', 'Helvetica-Bold', 10)).toBeCloseTo(24.45, 10);
    expect(textWidth('Hello', 'Courier', 10)).toBeCloseTo(30, 10);
    expect(textWidth('', 'Helvetica', 12)).toBe(0);
  });

  it('measures the WinAnsi upper half and the ? that replaced a character', () => {
    expect(textWidth('\u{E9}\u{20AC}\u{2014}', 'Helvetica', 1)).toBeCloseTo((556 + 556 + 1000) / 1000, 10);
    expect(textWidth('W\u{C6}', 'Helvetica-Bold', 1)).toBeCloseTo((944 + 1000) / 1000, 10);
    expect(textWidth('\u{6771}', 'Helvetica', 1)).toBeCloseTo(textWidth('?', 'Helvetica', 1), 10);
    expect(textWidth('?', 'Helvetica', 1)).toBeCloseTo(0.556, 10);
  });

  it('gives the digits one width (tabular figures) and Courier one width for every character', () => {
    for (const font of ['Helvetica', 'Helvetica-Bold'] as const) {
      expect(new Set([...'0123456789'].map((d) => textWidth(d, font, 1)))).toEqual(new Set([0.556]));
    }
    const all = Array.from({ length: 95 }, (_, i) => String.fromCharCode(0x20 + i));
    expect(new Set(all.map((c) => textWidth(c, 'Courier', 1)))).toEqual(new Set([0.6]));
  });

  it('scales linearly with the size', () => {
    expect(textWidth('Perpustakaan', 'Helvetica', 9)).toBeCloseTo(textWidth('Perpustakaan', 'Helvetica', 1) * 9, 10);
  });
});
