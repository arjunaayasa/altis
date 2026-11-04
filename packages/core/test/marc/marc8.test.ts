import { describe, expect, it } from 'vitest';
import { decodeMarc8 } from '../../src/marc/index.js';
import { encodeMarc8 } from '../support/marc-corpus.js';

// Spec §5.1 and decision D2-12: MARC-8 is read as ASCII + ANSEL only. A combining mark comes before its base in MARC-8
// and after it in Unicode; the result is NFC. Any other character set becomes `?` and is counted.

const decode = (...bytes: number[]) => decodeMarc8(Uint8Array.from(bytes));

describe('decodeMarc8', () => {
  it('moves a combining mark after its base and composes (NFC)', () => {
    expect(decode(0x43, 0x61, 0x66, 0xe2, 0x65)).toEqual({ text: 'Café', replaced: 0 });
  });

  it('keeps several marks on one base in their order, and composes what Unicode composes', () => {
    // dot below + circumflex + a (Vietnamese ậ), and u-horn (spacing in ANSEL) + hook above (ử).
    expect(decode(0xf2, 0xe3, 0x61, 0x20, 0xe0, 0xbd)).toEqual({ text: 'ậ ử', replaced: 0 });
    // A mark Unicode does not compose with its base stays a combining character after it.
    expect(decode(0xe5, 0x71).text).toBe('q\u{0304}');
  });

  it('maps the ANSEL spacing characters', () => {
    expect(decode(0xa1, 0xa2, 0xa3, 0xa4, 0xa5, 0xa6, 0xb1, 0xb2, 0xb3, 0xb4, 0xb5, 0xb6, 0xb8, 0xc3, 0xc7, 0xc8)).toEqual({
      text: 'ŁØĐÞÆŒłøđþæœı©ß€',
      replaced: 0,
    });
    expect(decode(0xae, 0xb0, 0xa7, 0xb7, 0xa8, 0xb9, 0xc0, 0xc5, 0xc6).text).toBe('ʼʻʹʺ·£°¿¡');
  });

  it('decodes what the test encoder writes for every MARC-8 text of the corpus', () => {
    for (const s of ['Gödel', 'Über formal unentscheidbare Sätze', 'Đặng Thùy Trâm', 'Nhà xuất bản Hội Nhà văn', 'Lịch sử', 'Ångström, Øyvind', 'Straße und Łódź', 'garçon de São Paulo', 'Yılmaz', 'al-ʻilm wa-al-ʼadab', '©1999']) {
      expect(decodeMarc8(encodeMarc8(s))).toEqual({ text: s.normalize('NFC'), replaced: 0 });
    }
  });

  it('replaces the characters of another set designated by an escape with ?, and counts them (ESC ( 3)', () => {
    // ESC ( 3 designates Basic Arabic as G0; ESC ( B returns to ASCII.
    const r = decode(0x41, 0x1b, 0x28, 0x33, 0x48, 0x49, 0x20, 0x4a, 0x1b, 0x28, 0x42, 0x5a);
    expect(r).toEqual({ text: 'A?? ?Z', replaced: 3 });
    expect(r.replaced).toBeGreaterThan(0);
  });

  it('reads ANSEL designated as G1 explicitly, and returns to ASCII with ESC s', () => {
    expect(decode(0x1b, 0x29, 0x21, 0x45, 0xe8, 0x75, 0x1b, 0x67, 0x61, 0x1b, 0x73, 0x62)).toEqual({ text: 'ü?b', replaced: 1 });
  });

  it('counts a three-byte East Asian character as one ?', () => {
    expect(decode(0x1b, 0x24, 0x31, 0x21, 0x30, 0x21, 0x21, 0x30, 0x22, 0x1b, 0x28, 0x42, 0x2e)).toEqual({ text: '??.', replaced: 2 });
  });

  it('replaces undefined ANSEL bytes and C1 controls, drops the nonsort markers, maps the joiners', () => {
    expect(decode(0xaf, 0x41, 0x88, 0x42, 0x89, 0x8d, 0x8e, 0x90)).toEqual({ text: '?AB\u{200D}\u{200C}?', replaced: 2 });
  });

  it('keeps a dangling mark at the end (after the character before it), and a malformed escape becomes ?', () => {
    expect(decode(0x71, 0xe2)).toEqual({ text: 'q\u{0301}', replaced: 0 });
    expect(decode(0xe2)).toEqual({ text: '\u{0301}', replaced: 0 });
    expect(decode(0x61, 0x1b)).toEqual({ text: 'a?', replaced: 1 });
  });
});
