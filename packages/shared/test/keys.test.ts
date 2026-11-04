import { describe, expect, it } from 'vitest';
import { IP_TRUST_VALUES, normalizeKey, type IpTrust } from '../src/keys.js';

describe('normalizeKey (spec §6.1 *_key: NFKC, trim, collapse whitespace, upper case)', () => {
  it('folds full-width letters, trims and collapses runs of spaces', () => {
    expect(normalizeKey('  ｂｕｄｉ   santoso ')).toBe('BUDI SANTOSO');
  });

  it('gives one key for composed and decomposed forms (macOS vs Windows keyboards)', () => {
    const composed = 'Café';
    const decomposed = 'Café';
    expect(composed).not.toBe(decomposed);
    expect(normalizeKey(composed)).toBe(normalizeKey(decomposed));
    expect(normalizeKey(decomposed)).toBe('CAFÉ');
  });

  it('turns every whitespace run (tab, newline, no-break and ideographic space) into one space', () => {
    expect(normalizeKey('a\tb\nc')).toBe('A B C');
    expect(normalizeKey('a  b')).toBe('A B');
    expect(normalizeKey('　a　　b　')).toBe('A B');
    expect(normalizeKey('a \r\n\t b')).toBe('A B');
  });

  it('upper-cases', () => {
    expect(normalizeKey('admin')).toBe('ADMIN');
    expect(normalizeKey('Admin')).toBe(normalizeKey('ADMIN'));
  });

  it('maps an all-whitespace string to the empty string', () => {
    expect(normalizeKey(' \t\n　 ')).toBe('');
    expect(normalizeKey('')).toBe('');
  });

  it('is idempotent on ordinary input', () => {
    for (const s of ['  ｂｕｄｉ   santoso ', 'Café', 'a\tb\nc', 'CAB-1', 'ａｄｍｉｎ']) {
      expect(normalizeKey(normalizeKey(s))).toBe(normalizeKey(s));
    }
  });
});

describe('IpTrust', () => {
  it('lists the three trust states in order (S7: shared by core and the server)', () => {
    expect(IP_TRUST_VALUES).toEqual(['ok', 'spoofable', 'collapsed']);
  });

  it('IpTrust is the union of the values', () => {
    const all: IpTrust[] = [...IP_TRUST_VALUES];
    expect(all).toHaveLength(3);
    // @ts-expect-error a value outside the list is not an IpTrust
    const bad: IpTrust = 'other';
    expect(bad).toBe('other');
  });
});
