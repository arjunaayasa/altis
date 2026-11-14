import type { ScoreView } from '@altis/shared/api/accreditation';
import type { AccredIndicator, AccredInstrument, Letter } from '../types.js';
import { SCORE_OF } from './bands.js';
import { largestGaps, type GapInput } from './gaps.js';

// The estimated score, in whole numbers so that no step rounds:
//
//   for each component k: n_k indicators, weight W_k, S_k the sum of the scores of its answers (a = 4 … d = 1),
//   u_k its unanswered indicators;
//   L = the least common multiple of every 4 · n_k (14 560 for the primary and lower secondary instruments,
//   1 120 for the upper secondary one), so each component's step W_k / (4 · n_k) is W_k · (L / (4 · n_k)) / L;
//   N(fill) = Σ_k (S_k + fill · u_k) · W_k · (L / (4 · n_k)), with the unanswered counted as d (fill 1) or as a (4);
//   the estimate in hundredths is floor(N · 100 / L): cut, never rounded.
//
// Every indicator answered: one estimate, and its predicate once the registration prerequisites are met (A from 91.00,
// B from 76.00, C from 60.00, else D). Otherwise the range from the low to the high end, and no predicate.

/** The catalogue code of an indicator of a school instrument (`SCH-L8`): the key of answers and results. */
export function catalogueCode(ind: AccredIndicator): string {
  return `SCH-${ind.code}`;
}

/** The common multiple of the components' maximum scores, and each component's factor `L / (4 · n_k)`. */
export interface InstrumentScale {
  lcm: number;
  factors: Record<string, number>;
}

const gcd = (a: number, b: number): number => (b === 0 ? a : gcd(b, a % b));
const lcmOf = (a: number, b: number): number => (a / gcd(a, b)) * b;
/** `a / b` cut to a whole number, for non-negative whole numbers. */
export const intDiv = (a: number, b: number): number => (a - (a % b)) / b;

/** The scale of `instr`'s estimate (components without indicators left out). */
export function instrumentScale(instr: AccredInstrument): InstrumentScale {
  const sized = instr.components.filter((c) => c.indicators.length > 0);
  const lcm = sized.reduce((l, c) => lcmOf(l, 4 * c.indicators.length), 1);
  const factors: Record<string, number> = {};
  for (const c of sized) factors[c.code] = lcm / (4 * c.indicators.length);
  return { lcm, factors };
}

/** The predicate of an estimate in hundredths. */
export function gradeOf(hundredths: number): 'A' | 'B' | 'C' | 'D' {
  return hundredths >= 9100 ? 'A' : hundredths >= 7600 ? 'B' : hundredths >= 6000 ? 'C' : 'D';
}

/** Hundredths as a number with two decimals and a point (`'70.45'`). */
export function formatHundredths(hundredths: number): string {
  return `${intDiv(hundredths, 100)}.${String(hundredths % 100).padStart(2, '0')}`;
}

/** Each indicator's final answer: a stored answer wins (even one without a letter), else the suggestion, else none. */
export function finalAnswers(
  instr: AccredInstrument,
  suggestions: ReadonlyMap<string, Letter | null>,
  answers: ReadonlyMap<string, { answer: Letter | null; mode: 'manual' | 'override' }>,
): Map<string, Letter | null> {
  const out = new Map<string, Letter | null>();
  for (const c of instr.components) {
    for (const i of c.indicators) {
      const code = catalogueCode(i);
      const stored = answers.get(code);
      out.set(code, stored !== undefined ? stored.answer : (suggestions.get(code) ?? null));
    }
  }
  return out;
}

/**
 * The estimated score of `instr` from the final answers (keyed by catalogue code; a missing key is unanswered), or
 * null for an instrument that is not scored.
 */
export function scoreInstrument(instr: AccredInstrument, finals: ReadonlyMap<string, Letter | null>, o: { prerequisitesMet: boolean }): ScoreView | null {
  if (!instr.scored || instr.components.every((c) => c.indicators.length === 0)) return null;
  const scale = instrumentScale(instr);
  let low = 0;
  let high = 0;
  let answered = 0;
  let total = 0;
  const perComponent: ScoreView['perComponent'] = [];
  const gaps: GapInput[] = [];
  for (const c of instr.components) {
    const n = c.indicators.length;
    if (n === 0) continue;
    const factor = scale.factors[c.code]!;
    let sum = 0;
    let unanswered = 0;
    for (const i of c.indicators) {
      const code = catalogueCode(i);
      const letter = finals.get(code) ?? null;
      total += 1;
      if (letter === null) {
        unanswered += 1;
      } else {
        answered += 1;
        sum += SCORE_OF[letter];
      }
      const score = letter === null ? 1 : SCORE_OF[letter];
      gaps.push({ code, officialNo: i.officialNo, component: c.code, actionKey: i.actionKey, scaled: (4 - score) * c.weight * factor });
    }
    low += (sum + unanswered) * c.weight * factor;
    high += (sum + 4 * unanswered) * c.weight * factor;
    perComponent.push({ code: c.code, sum, max: 4 * n, n, weight: c.weight });
  }
  const lowH = intDiv(low * 100, scale.lcm);
  const highH = intDiv(high * 100, scale.lcm);
  const na = answered === total ? formatHundredths(lowH) : null;
  return {
    answered,
    total,
    perComponent,
    na,
    naLow: formatHundredths(lowH),
    naHigh: formatHundredths(highH),
    grade: na !== null && o.prerequisitesMet ? gradeOf(lowH) : null,
    gaps: largestGaps(gaps, scale.lcm),
  };
}
