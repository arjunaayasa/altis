// Title similarity for duplicate detection (spec §3.3): 60 × the Dice coefficient of the bigrams of title_key. Pure.

/** The bigrams of a string without its whitespace, counted (a multiset), over code points. */
function bigrams(s: string): { counts: Map<string, number>; total: number } {
  const chars = Array.from(s);
  const counts = new Map<string, number>();
  for (let i = 0; i + 1 < chars.length; i++) {
    const g = `${chars[i]}${chars[i + 1]}`;
    counts.set(g, (counts.get(g) ?? 0) + 1);
  }
  return { counts, total: Math.max(chars.length - 1, 0) };
}

/**
 * The Sørensen-Dice coefficient of the character bigrams of two title keys, whitespace ignored: 2 × shared bigrams /
 * (bigrams of a + bigrams of b), shared counted as a multiset. 1 for identical keys, 0 when either is empty or they
 * share no bigram; symmetric, within 0..1.
 */
export function diceCoefficient(a: string, b: string): number {
  const x = a.replace(/\s+/g, '');
  const y = b.replace(/\s+/g, '');
  if (x === '' || y === '') return 0;
  if (x === y) return 1;
  const ga = bigrams(x);
  const gb = bigrams(y);
  if (ga.total + gb.total === 0) return 0;
  let shared = 0;
  for (const [g, n] of ga.counts) shared += Math.min(n, gb.counts.get(g) ?? 0);
  return (2 * shared) / (ga.total + gb.total);
}
