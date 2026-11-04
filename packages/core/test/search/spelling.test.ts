import { describe, expect, it } from 'vitest';
import { correctableWord, correctedText, damerauLevenshtein, spellingDistanceMax } from '../../src/search/spelling.js';

// Phase 2 spec §4.7: the typo tolerance. Damerau-Levenshtein (adjacent transpositions count one edit) in JS: ≤ 1 for a
// token of 4–7 letters, ≤ 2 from 8 letters; a token shorter than 4 is never corrected. suggestCorrections itself reads
// search_term and is tested with the corpus (db/search-query.test.ts).

describe('damerauLevenshtein', () => {
  it('counts insertions, deletions, substitutions and adjacent transpositions', () => {
    expect(damerauLevenshtein('pendidkan', 'pendidikan', 2)).toBe(1);
    expect(damerauLevenshtein('pendidikan', 'pendidkan', 2)).toBe(1);
    expect(damerauLevenshtein('buku', 'buka', 2)).toBe(1);
    expect(damerauLevenshtein('sejarah', 'sejrah', 2)).toBe(1);
    expect(damerauLevenshtein('sejarah', 'sejaarh', 2)).toBe(1); // a transposition
    expect(damerauLevenshtein('abcd', 'abcd', 2)).toBe(0);
    expect(damerauLevenshtein('', 'abc', 5)).toBe(3);
  });

  it('stops at max: anything further away answers max + 1', () => {
    expect(damerauLevenshtein('pendidikan', 'pertanian', 2)).toBe(3);
    expect(damerauLevenshtein('kucing', 'harimau', 1)).toBe(2);
    expect(damerauLevenshtein('a'.repeat(20), 'b'.repeat(20), 2)).toBe(3);
  });

  it('works on code points, not UTF-16 units', () => {
    expect(damerauLevenshtein('\u{1D49C}bcd', 'abcd', 2)).toBe(1);
    expect(damerauLevenshtein('東京大学', '東京大字', 2)).toBe(1);
  });
});

describe('the correction rules', () => {
  it('only letter words of 4 to 84 characters are corrected', () => {
    expect(correctableWord('pendidkan')).toBe(true);
    expect(correctableWord('buku')).toBe(true);
    expect(correctableWord('bku')).toBe(false);
    expect(correctableWord('2010')).toBe(false);
    expect(correctableWord('abc1')).toBe(false);
    expect(correctableWord('x'.repeat(85))).toBe(false);
  });

  it('the distance allowed: 1 for 4-7 letters, 2 from 8', () => {
    expect([4, 7, 8, 20].map(spellingDistanceMax)).toEqual([1, 1, 2, 2]);
  });
});

describe('correctedText', () => {
  it('replaces each misspelt word of the query as typed, keeping the rest of the syntax', () => {
    const fix = new Map([['pendidkan', 'pendidikan']]);
    expect(correctedText('Pendidkan', fix)).toBe('pendidikan');
    expect(correctedText('judul:pendidkan -novel "sejarah pendidkan"', fix)).toBe('judul:pendidikan -novel "sejarah pendidikan"');
    expect(correctedText('pendidkanku', fix)).toBe('pendidkanku');
    expect(correctedText('laskar', fix)).toBe('laskar');
  });
});
