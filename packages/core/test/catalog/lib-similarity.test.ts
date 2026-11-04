import { describe, expect, it } from 'vitest';
import { diceCoefficient, titleKey } from '../../src/catalog/lib/index.js';

// Spec §3.3: title similarity is the Dice coefficient of the bigrams of title_key.

describe('diceCoefficient', () => {
  it('is 1 for identical keys', () => {
    expect(diceCoefficient('laskar pelangi', 'laskar pelangi')).toBe(1);
    expect(diceCoefficient('a', 'a')).toBe(1);
  });

  it('is 0 for keys without a shared bigram, or when one is empty', () => {
    expect(diceCoefficient('abc', 'xyz')).toBe(0);
    expect(diceCoefficient('', '')).toBe(0);
    expect(diceCoefficient('abc', '')).toBe(0);
    expect(diceCoefficient('a', 'b')).toBe(0);
  });

  it('counts shared bigrams as a multiset', () => {
    // night: ni ig gh ht; nacht: na ac ch ht -> 2 * 1 / 8
    expect(diceCoefficient('night', 'nacht')).toBe(0.25);
    // aaaa: aa aa aa; aa: aa -> 2 * 1 / 4
    expect(diceCoefficient('aaaa', 'aa')).toBe(0.5);
  });

  it('ignores spaces, is symmetric and stays within 0..1', () => {
    expect(diceCoefficient('laskar pelangi', 'laskarpelangi')).toBe(1);
    const a = titleKey('Laskar Pelangi');
    const b = titleKey('Laskar Pelangi: edisi revisi');
    const s = diceCoefficient(a, b);
    expect(s).toBe(diceCoefficient(b, a));
    expect(s).toBeGreaterThan(0.5);
    expect(s).toBeLessThan(1);
  });
});
