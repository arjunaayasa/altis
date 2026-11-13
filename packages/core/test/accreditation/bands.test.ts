import { describe, expect, it } from 'vitest';
import { evaluateRange, matchingAnswers, pickTier, SCORE_OF } from '../../src/accreditation/scoring/bands.js';
import type { RangeBand } from '../../src/accreditation/types.js';

// The band engine: a value (already cut to a whole number by its provider) is tested against the bands in order a, b,
// c, d; the first band whose bounds hold it wins, and a value no band holds is a d. A sized band first picks the tier
// whose starting size the size value has reached.

const K1: readonly RangeBand[] = [{ answer: 'a', min: 1501 }, { answer: 'b', min: 1001, max: 1500 }, { answer: 'c', min: 1000, max: 1000 }, { answer: 'd' }];
const K2_SD: readonly RangeBand[] = [{ answer: 'a', min: 40, max: 40 }, { answer: 'b', min: 21, max: 39 }, { answer: 'c', min: 20, max: 20 }, { answer: 'd' }];
const K2_SMA: readonly RangeBand[] = [{ answer: 'a', min: 25, max: 25 }, { answer: 'b', min: 11, max: 25 }, { answer: 'c', min: 10, max: 10 }, { answer: 'd' }];
const T5_SD: readonly RangeBand[] = [{ answer: 'a', max: 27 }, { answer: 'b', min: 28, max: 83 }, { answer: 'c', min: 84, max: 112 }, { answer: 'd' }];

describe('evaluateRange', () => {
  it('both bounds are inclusive and the first band that holds the value wins', () => {
    expect([999, 1000, 1001, 1500, 1501].map((v) => evaluateRange(K1, v))).toEqual(['d', 'c', 'b', 'b', 'a']);
  });

  it('a value outside every band is a d, on either side of an exact band', () => {
    expect([19, 20, 21, 39, 40, 41].map((v) => evaluateRange(K2_SD, v))).toEqual(['d', 'c', 'b', 'b', 'a', 'd']);
  });

  it('a value two bands hold goes to the first of them, and both are reported', () => {
    expect(evaluateRange(K2_SMA, 25)).toBe('a');
    expect(matchingAnswers(K2_SMA, 25)).toEqual(['a', 'b', 'd']);
    expect(matchingAnswers(K2_SMA, 24)).toEqual(['b', 'd']);
  });

  it('a band with only an upper bound (lower is better) starts at zero', () => {
    expect([0, 27, 28, 83, 84, 112, 113].map((v) => evaluateRange(T5_SD, v))).toEqual(['a', 'a', 'b', 'b', 'c', 'c', 'd']);
  });

  it('a list without a catch-all band still answers d', () => {
    expect(evaluateRange([{ answer: 'a', min: 5 }], 4)).toBe('d');
  });
});

describe('pickTier', () => {
  const tiers = [
    { minSize: 0, name: 'first' },
    { minSize: 1501, name: 'second' },
    { minSize: 2000, name: 'third' },
  ];

  it('picks the last tier whose starting size the size has reached', () => {
    expect([1, 999, 1500, 1501, 1999, 2000, 50_000].map((s) => pickTier(tiers, s).name)).toEqual([
      'first',
      'first',
      'first',
      'second',
      'second',
      'third',
      'third',
    ]);
  });

  it('a size below every tier takes the first one', () => {
    expect(pickTier([{ minSize: 10 }, { minSize: 20 }], 5)).toEqual({ minSize: 10 });
  });
});

describe('SCORE_OF', () => {
  it('a = 4, b = 3, c = 2, d = 1', () => {
    expect(SCORE_OF).toEqual({ a: 4, b: 3, c: 2, d: 1 });
  });
});
