import { describe, expect, it } from 'vitest';
import { code128Modules, code39Modules } from '../../src/print/index.js';
import { CODE128_WIDTHS, CODE39_ELEMENTS, decodeCode128, decodeCode39, moduleRuns } from '../support/barcode-decode.js';

// Phase 2 spec §7 and K13: Code 128 (set B/C chosen automatically) and Code 39, drawn as vector bars. The module
// patterns exclude the quiet zones; the test decoder (test/support/barcode-decode.ts) reads them back.

/** Element widths ('2121…') as modules, starting with a bar. */
function expand(widths: string): string {
  return [...widths].map((w, k) => (k % 2 === 0 ? '1' : '0').repeat(Number(w))).join('');
}

/** Code 39 elements (1 = wide) as modules at a wide:narrow ratio of 2. */
function expand39(elements: string): string {
  return expand([...elements].map((e) => (e === '1' ? '2' : '1')).join(''));
}

const bits = (modules: readonly boolean[]): string => modules.map((m) => (m ? '1' : '0')).join('');

/** A small deterministic generator, so the property tests are the same on every run. */
function lcg(seed: number): () => number {
  let s = seed;
  return () => {
    s = (s * 1103515245 + 12345) % 2147483648;
    return s / 2147483648;
  };
}

describe('the test decoder tables', () => {
  it('Code 128: 107 distinct symbols of 11 modules (the stop 13), bars of even total width, the known start/stop', () => {
    expect(CODE128_WIDTHS).toHaveLength(107);
    expect(new Set(CODE128_WIDTHS).size).toBe(107);
    CODE128_WIDTHS.forEach((w, v) => {
      const widths = [...w].map(Number);
      expect(widths.reduce((a, b) => a + b, 0)).toBe(v === 106 ? 13 : 11);
      if (v < 106) expect((widths[0]! + widths[2]! + widths[4]!) % 2).toBe(0);
    });
    expect(expand(CODE128_WIDTHS[0]!)).toBe('11011001100');
    expect(expand(CODE128_WIDTHS[103]!)).toBe('11010000100');
    expect(expand(CODE128_WIDTHS[104]!)).toBe('11010010000');
    expect(expand(CODE128_WIDTHS[105]!)).toBe('11010011100');
    expect(expand(CODE128_WIDTHS[106]!)).toBe('1100011101011');
  });

  it('Code 39: 44 distinct characters of nine elements, three wide (two bars and a space, or three spaces)', () => {
    const entries = Object.entries(CODE39_ELEMENTS);
    expect(entries).toHaveLength(44);
    expect(new Set(entries.map(([, e]) => e)).size).toBe(44);
    for (const [ch, e] of entries) {
      const wideBars = [0, 2, 4, 6, 8].filter((k) => e[k] === '1').length;
      const wideSpaces = [1, 3, 5, 7].filter((k) => e[k] === '1').length;
      expect([wideBars, wideSpaces]).toEqual('$/+%'.includes(ch) ? [0, 3] : [2, 1]);
    }
    expect(expand39(CODE39_ELEMENTS['*']!)).toBe('100101101101');
    expect(expand39(CODE39_ELEMENTS.A!)).toBe('110101001011');
    expect(expand39(CODE39_ELEMENTS['0']!)).toBe('101001101101');
  });
});

describe('code128Modules', () => {
  it('reads back B0001234 with a valid check symbol, switching to set C for the digits (K13)', () => {
    const modules = code128Modules('B0001234');
    const reading = decodeCode128(modules);
    expect(reading.text).toBe('B0001234');
    // Start B, "B", "0", CODE C, "00", "12", "34"; check = (104 + 34 + 2·16 + 3·99 + 4·0 + 5·12 + 6·34) mod 103 = 10.
    expect(reading.values).toEqual([104, 34, 16, 99, 0, 12, 34]);
    expect(reading.checksum).toBe(10);
    expect(modules).toHaveLength(11 * 8 + 13);
  });

  it('excludes the quiet zones: the pattern starts with the start symbol and ends with the stop', () => {
    const modules = bits(code128Modules('B0001234'));
    expect(modules.startsWith('11010010000')).toBe(true);
    expect(modules.endsWith('1100011101011')).toBe(true);
  });

  it('a corrupted check symbol or symbol fails to read', () => {
    const modules = code128Modules('B0001234');
    const runs = moduleRuns(modules);
    expect(runs.length).toBe(6 * 8 + 7);
    const flipped = [...modules];
    // The check symbol occupies modules 77..87: turn its last space into a bar.
    flipped[87] = true;
    expect(() => decodeCode128(flipped)).toThrow();
    // The data of B0001235 with the check symbol of B0001234.
    const other = code128Modules('B0001235');
    expect(() => decodeCode128([...other.slice(0, 77), ...modules.slice(77)])).toThrow(/check symbol/);
  });

  it('chooses the shortest B/C sequence', () => {
    expect(decodeCode128(code128Modules('12345678')).values).toEqual([105, 12, 34, 56, 78]);
    expect(decodeCode128(code128Modules('AB1234')).values).toEqual([104, 33, 34, 99, 12, 34]);
    // Two digits in the middle cost as much in set C (CODE C, 12, CODE B) as in set B: stay in B.
    expect(decodeCode128(code128Modules('AB12CD')).values).toEqual([104, 33, 34, 17, 18, 35, 36]);
    expect(decodeCode128(code128Modules('AB12')).values).toEqual([104, 33, 34, 17, 18]);
    expect(decodeCode128(code128Modules('1234567')).values).toHaveLength(6);
    expect(decodeCode128(code128Modules('12')).values).toEqual([105, 12]);
    expect(decodeCode128(code128Modules('1')).values).toEqual([104, 17]);
  });

  it('reads back every printable ASCII character and keeps lower case', () => {
    const ascii = Array.from({ length: 95 }, (_, i) => String.fromCharCode(0x20 + i)).join('');
    expect(decodeCode128(code128Modules(ascii)).text).toBe(ascii);
    expect(decodeCode128(code128Modules('b0001234 x')).text).toBe('b0001234 x');
  });

  it('reads back 300 generated digit-heavy strings, never longer than set B alone', () => {
    const next = lcg(7);
    const alphabet = '0123456789012345678901234567890123456789AB -/x';
    for (let k = 0; k < 300; k++) {
      const length = 1 + Math.floor(next() * 64);
      const data = Array.from({ length }, () => alphabet[Math.floor(next() * alphabet.length)]).join('');
      const reading = decodeCode128(code128Modules(data));
      expect(reading.text).toBe(data);
      expect(reading.values.length - 1).toBeLessThanOrEqual(data.length);
      if (/^(?:\d\d)+$/.test(data)) expect(reading.values.length - 1).toBe(data.length / 2);
    }
  });

  it('refuses an empty value and characters outside 0x20-0x7E with a TypeError', () => {
    for (const bad of ['', 'B\u{E9}1', 'B\n1', 'B\u{7F}1', 'B\u{1F}1', '\u{1F600}']) {
      expect(() => code128Modules(bad)).toThrow(TypeError);
    }
  });
});

describe('code39Modules', () => {
  it('reads back B0001234 (K13)', () => {
    const modules = code39Modules('B0001234');
    expect(decodeCode39(modules)).toBe('B0001234');
    // (8 + 2 framing) characters of 15 modules, with a one-module gap between them.
    expect(modules).toHaveLength(10 * 16 - 1);
  });

  it('frames the data with * at a wide:narrow ratio of 3, without quiet zones', () => {
    const modules = bits(code39Modules('A'));
    expect(modules.startsWith('100010111011101' + '0')).toBe(true);
    expect(modules.endsWith('0' + '100010111011101')).toBe(true);
  });

  it('reads back every character of the set and upper-cases letters', () => {
    const set = '0123456789ABCDEFGHIJKLMNOPQRSTUVWXYZ-. $/+%';
    expect(decodeCode39(code39Modules(set))).toBe(set);
    expect(code39Modules('b0001234')).toEqual(code39Modules('B0001234'));
    expect(decodeCode39(code39Modules('abc-xyz'))).toBe('ABC-XYZ');
  });

  it('refuses an empty value, * and characters outside its set with a TypeError', () => {
    for (const bad of ['', '*', 'B*1', 'B_1', 'B#1', 'B\u{E9}', 'B\t1', '\u{131}']) {
      expect(() => code39Modules(bad)).toThrow(TypeError);
    }
  });
});
