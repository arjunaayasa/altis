import { describe, expect, it } from 'vitest';
import { titleKey } from '../../src/catalog/lib/index.js';

// Spec §2.1: title (+ subtitle) after NFKD, diacritics stripped, lower case, punctuation stripped, spaces collapsed,
// the leading article dropped by the nonfiling indicator when known, cut to 191 characters.

describe('titleKey', () => {
  it('drops the leading article by the nonfiling count', () => {
    expect(titleKey('The Hobbit', null, 4)).toBe('hobbit');
    expect(titleKey("L'été", null, 2)).toBe('ete');
  });

  it('ignores a nonfiling count that is unknown, out of range or swallows the whole title', () => {
    expect(titleKey('The Hobbit')).toBe('the hobbit');
    expect(titleKey('The Hobbit', null, 0)).toBe('the hobbit');
    expect(titleKey('The Hobbit', null, -1)).toBe('the hobbit');
    expect(titleKey('The Hobbit', null, 2.5)).toBe('the hobbit');
    expect(titleKey('The Hobbit', null, 10)).toBe('the hobbit');
    expect(titleKey('Ab', null, 2)).toBe('ab');
  });

  it('strips diacritics and punctuation and lower-cases', () => {
    expect(titleKey('Café: une histoire')).toBe('cafe une histoire');
    expect(titleKey('Çağdaş Türk Şiiri!')).toBe('cagdas turk siiri');
    expect(titleKey('Bumi Manusia — Tetralogi Buru (1)')).toBe('bumi manusia tetralogi buru 1');
    expect(titleKey('Øresund & Łódź; Straße')).toBe('oresund lodz strasse');
  });

  it('removes an apostrophe inside a word rather than splitting it', () => {
    expect(titleKey("Tafsir Al-Qur'an")).toBe('tafsir al quran');
    expect(titleKey('Tafsir Al-Qur\u{2019}an')).toBe('tafsir al quran');
  });

  it('appends the subtitle and collapses spaces', () => {
    expect(titleKey('  Laskar   Pelangi ', 'sebuah  novel')).toBe('laskar pelangi sebuah novel');
    expect(titleKey('The Hobbit', 'or There and Back Again', 4)).toBe('hobbit or there and back again');
    expect(titleKey('Laskar Pelangi', '')).toBe('laskar pelangi');
  });

  it('keeps letters of other scripts', () => {
    expect(titleKey('كتاب التوحيد')).toBe('كتاب التوحيد');
    expect(titleKey('Сказки')).toBe('сказки');
  });

  it('cuts to 191 characters and never ends with a space', () => {
    expect(titleKey('a'.repeat(300))).toHaveLength(191);
    expect(titleKey(`${'a'.repeat(190)} bcd`)).toBe('a'.repeat(190));
    // Characters are code points (MySQL varchar(191) in utf8mb4): an astral letter counts once, never cut in half.
    const astral = titleKey('\u{20000}'.repeat(300));
    expect(Array.from(astral)).toHaveLength(191);
    expect(astral).toBe('\u{20000}'.repeat(191));
  });

  it('is empty for a title of punctuation only', () => {
    expect(titleKey('...')).toBe('');
  });
});
