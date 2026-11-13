import type { Letter, RangeBand } from '../types.js';

// The band engine. A value is tested against the bands in their order (a, b, c, d); a band holds it when the value is
// at least its `min` and at most its `max` (either may be absent); the first band that holds it wins, and a value no
// band holds is a d. Values arrive whole: a provider cuts every percentage and ratio before it reaches the bands.

/** The score of each answer. */
export const SCORE_OF: Readonly<Record<Letter, 1 | 2 | 3 | 4>> = Object.freeze({ a: 4, b: 3, c: 2, d: 1 });

/** Whether `band` holds `value`. */
export function bandHolds(band: RangeBand, value: number): boolean {
  return (band.min === undefined || value >= band.min) && (band.max === undefined || value <= band.max);
}

/** The answer `value` gets from `bands`: the first band that holds it, else d. */
export function evaluateRange(bands: readonly RangeBand[], value: number): Letter {
  return bands.find((b) => bandHolds(b, value))?.answer ?? 'd';
}

/** Every answer whose band holds `value`, in band order (more than one: the decree's bands overlap there). */
export function matchingAnswers(bands: readonly RangeBand[], value: number): Letter[] {
  return bands.filter((b) => bandHolds(b, value)).map((b) => b.answer);
}

/** The last tier whose starting size `size` has reached; the first tier for a size below all of them. */
export function pickTier<T extends { minSize: number }>(tiers: readonly T[], size: number): T {
  let picked = tiers[0];
  if (picked === undefined) throw new TypeError('a sized band needs at least one tier');
  for (const tier of tiers) if (tier.minSize <= size) picked = tier;
  return picked;
}
