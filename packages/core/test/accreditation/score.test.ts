import { describe, expect, it } from 'vitest';
import { instrumentById } from '../../src/accreditation/instruments/index.js';
import { catalogueCode, formatHundredths, gradeOf, instrumentScale } from '../../src/accreditation/scoring/score.js';
import { evaluatePrerequisites, finalAnswers, scoreInstrument } from '../../src/accreditation/scoring/index.js';
import type { AccredComponent, AccredIndicator, AccredInstrument, AccredMetricValue, Letter } from '../../src/accreditation/types.js';

// The estimated score: each component's answers summed (a = 4 … d = 1), weighted by the component and by its number
// of indicators, in whole numbers over the least common multiple of the components' maximum scores, cut to hundredths;
// a range while indicators are unanswered, a single value and a predicate only when all are answered and the
// registration prerequisites are met; and the largest gaps to an a, with the suggested action.

const instrument = (id: string): AccredInstrument => instrumentById(id) as AccredInstrument;
const SD = instrument('sch-sd-2025');
const SMA = instrument('sch-sma-2025');
const indicators = (i: AccredInstrument): AccredIndicator[] => i.components.flatMap((c) => c.indicators);

/** Every indicator of `instr` answered `letter`, then the given exceptions (null: unanswered). */
function finals(instr: AccredInstrument, letter: Letter | null, except: Readonly<Record<string, Letter | null>> = {}): Map<string, Letter | null> {
  const out = new Map<string, Letter | null>();
  for (const i of indicators(instr)) out.set(catalogueCode(i), i.code in except ? (except[i.code] ?? null) : letter);
  return out;
}

/** An instrument of one component with `n` indicators (weight 100), for exact hundredths. */
function single(n: number): AccredInstrument {
  const ind = (k: number): AccredIndicator => ({
    code: `K${k}`,
    officialNo: `K${k}`,
    labelKey: 'accred.ik.K1',
    window: 'current',
    band: { kind: 'manual' },
    evidence: [],
    actionKey: 'accred.gap.action.K1',
  });
  const K: AccredComponent = { code: 'K', labelKey: 'accred.component.K', weight: 100, indicators: Array.from({ length: n }, (_, k) => ind(k + 1)) };
  return { ...SD, id: 'single', components: [K], snp: [] };
}

describe('finalAnswers', () => {
  const sch = instrument('test-sch');

  it('a stored answer wins over the suggestion, the suggestion over nothing; every indicator has an entry', () => {
    const suggestions = new Map<string, Letter | null>([
      ['SCH-K1', 'c'],
      ['SCH-K2', 'a'],
      ['SCH-K3', null],
    ]);
    const answers = new Map([
      ['SCH-K2', { answer: 'b' as Letter, mode: 'override' as const }],
      ['SCH-SP1', { answer: 'a' as Letter, mode: 'manual' as const }],
    ]);
    expect([...finalAnswers(sch, suggestions, answers)]).toEqual([
      ['SCH-K1', 'c'],
      ['SCH-K2', 'b'],
      ['SCH-K3', null],
      ['SCH-SP1', 'a'],
    ]);
  });

  it('a stored answer without a letter leaves the indicator unanswered even when a suggestion exists', () => {
    const out = finalAnswers(sch, new Map([['SCH-K1', 'a']]), new Map([['SCH-K1', { answer: null, mode: 'override' as const }]]));
    expect(out.get('SCH-K1')).toBeNull();
  });
});

describe('instrumentScale', () => {
  it('the common multiple of the components’ maximum scores and each component’s factor', () => {
    expect(instrumentScale(SD)).toEqual({ lcm: 14_560, factors: { K: 455, SP: 520, L: 280, T: 728, F: 910, G: 910 } });
    expect(instrumentScale(SMA)).toEqual({ lcm: 1_120, factors: { K: 35, SP: 40, L: 20, T: 56, F: 70, G: 70 } });
  });
});

describe('gradeOf and formatHundredths', () => {
  it('the predicate edges on hundredths', () => {
    expect([9100, 9099, 7600, 7599, 6000, 5999, 10_000, 2_500].map(gradeOf)).toEqual(['A', 'B', 'B', 'C', 'C', 'D', 'A', 'D']);
  });

  it('two decimals with a point', () => {
    expect([10_000, 9_932, 7_045, 2_500, 5, 0].map(formatHundredths)).toEqual(['100.00', '99.32', '70.45', '25.00', '0.05', '0.00']);
  });
});

describe('scoreInstrument', () => {
  it('per component: the sum of the answers, the maximum, the number of indicators and the weight', () => {
    const s = scoreInstrument(SMA, finals(SMA, 'a', { K1: 'c', SP1: null }), { prerequisitesMet: true })!;
    expect(s.perComponent).toEqual([
      { code: 'K', sum: 30, max: 32, n: 8, weight: 15 },
      { code: 'SP', sum: 24, max: 28, n: 7, weight: 10 },
      { code: 'L', sum: 56, max: 56, n: 14, weight: 35 },
      { code: 'T', sum: 20, max: 20, n: 5, weight: 15 },
      { code: 'F', sum: 16, max: 16, n: 4, weight: 15 },
      { code: 'G', sum: 16, max: 16, n: 4, weight: 10 },
    ]);
    expect([s.answered, s.total]).toEqual([41, 42]);
  });

  it('a single estimate and its predicate once everything is answered and the prerequisites are met', () => {
    const s = scoreInstrument(SD, finals(SD, 'a'), { prerequisitesMet: true })!;
    expect([s.na, s.naLow, s.naHigh, s.grade]).toEqual(['100.00', '100.00', '100.00', 'A']);
    expect(s.gaps).toEqual([]);
  });

  it('a range while any indicator is unanswered: the low end counts it as d, the high end as a', () => {
    const s = scoreInstrument(SD, finals(SD, null), { prerequisitesMet: true })!;
    expect([s.na, s.naLow, s.naHigh, s.grade, s.answered, s.total]).toEqual([null, '25.00', '100.00', null, 0, 41]);
  });

  it('every answered with the prerequisites failing: the estimate stays, the predicate goes', () => {
    const s = scoreInstrument(SD, finals(SD, 'a'), { prerequisitesMet: false })!;
    expect([s.na, s.grade]).toEqual(['100.00', null]);
  });

  it('the predicate from the estimate: 91.00, 76.00 and 60.00 are the lowest A, B and C', () => {
    const grade = (sum: number) => {
      const instr = single(100);
      const letters: Letter[] = [];
      let left = sum - 100;
      for (let k = 0; k < 100; k++) {
        const extra = Math.min(3, left);
        left -= extra;
        letters.push((['d', 'c', 'b', 'a'] as const)[extra]!);
      }
      const f = new Map(instr.components[0]!.indicators.map((i, k) => [catalogueCode(i), letters[k]!]));
      const s = scoreInstrument(instr, f, { prerequisitesMet: true })!;
      return [s.na, s.grade];
    };
    expect(grade(364)).toEqual(['91.00', 'A']);
    expect(grade(363)).toEqual(['90.75', 'B']);
    expect(grade(304)).toEqual(['76.00', 'B']);
    expect(grade(303)).toEqual(['75.75', 'C']);
    expect(grade(240)).toEqual(['60.00', 'C']);
    expect(grade(239)).toEqual(['59.75', 'D']);
  });

  it('the estimate is cut to hundredths, never rounded: 2 of 3 is 66.66 of a weight of 100', () => {
    const instr = single(3);
    const f = new Map(instr.components[0]!.indicators.map((i, k) => [catalogueCode(i), (k === 0 ? 'b' : 'a') as Letter]));
    expect(scoreInstrument(instr, f, { prerequisitesMet: true })!.na).toBe('91.66');
  });

  it('the gaps: (4 − score) of each indicator weighted like the estimate, the ten largest, with four decimals and the action', () => {
    const s = scoreInstrument(SMA, finals(SMA, 'a', { K1: 'c', K5: 'c', SP5: 'c', L5: 'c', L7: 'c', L10: 'c', L14: 'c', T4: 'c', F3: 'c', G1: 'c', G2: 'c', K3: 'b' }), {
      prerequisitesMet: true,
    })!;
    expect(s.gaps.map((g) => [g.code, g.officialNo, g.component, g.gap])).toEqual([
      ['SCH-F3', 'F3', 'F', '1.8750'],
      ['SCH-T4', 'T4', 'T', '1.5000'],
      ['SCH-L5', 'L5', 'L', '1.2500'],
      ['SCH-L7', 'L7', 'L', '1.2500'],
      ['SCH-L10', 'L10', 'L', '1.2500'],
      ['SCH-L14', 'L14', 'L', '1.2500'],
      ['SCH-G1', 'G1', 'G', '1.2500'],
      ['SCH-G2', 'G2', 'G', '1.2500'],
      ['SCH-K1', 'K1', 'K', '0.9375'],
      ['SCH-K5', 'K5', 'K', '0.9375'],
    ]);
    expect(s.gaps[0]!.actionKey).toBe('accred.gap.action.F3');
  });

  it('an unanswered indicator weighs as a d in the gaps; a ten-before-nine order is numeric', () => {
    const s = scoreInstrument(SD, finals(SD, 'a', { L10: null, L9: 'd', L8: 'd' }), { prerequisitesMet: true })!;
    // SD numbers the concepts L8, L9, L10 as L7, L8, L9.
    expect(s.gaps.map((g) => [g.code, g.officialNo, g.gap])).toEqual([
      ['SCH-L8', 'L7', '2.0192'],
      ['SCH-L9', 'L8', '2.0192'],
      ['SCH-L10', 'L9', '2.0192'],
    ]);
    const tie = scoreInstrument(SMA, finals(SMA, 'a', { L10: 'c', L9: 'c' }), { prerequisitesMet: true })!;
    expect(tie.gaps.map((g) => g.officialNo)).toEqual(['L9', 'L10']);
  });

  it('the statistics mode has no score', () => {
    expect(scoreInstrument(instrument('general-stats'), new Map(), { prerequisitesMet: true })).toBeNull();
  });
});

describe('evaluatePrerequisites', () => {
  const count = (value: number | null): AccredMetricValue => ({ value, unit: 'count', basis: 'live', notes: [] });

  it('at least 1 000 titles at the snapshot date, the library number and the founding decree', () => {
    expect(evaluatePrerequisites({ titles: count(1000), npp: count(1), foundingDecree: count(1), D: '2026-06-30' })).toEqual({
      titles: { pass: true, count: 1000, asOf: '2026-06-30' },
      npp: { pass: true },
      foundingDecree: { pass: true },
      met: true,
    });
  });

  it('one failing check is enough to fail', () => {
    expect(evaluatePrerequisites({ titles: count(999), npp: count(1), foundingDecree: count(1), D: '2026-06-30' })).toMatchObject({
      titles: { pass: false, count: 999 },
      met: false,
    });
    expect(evaluatePrerequisites({ titles: count(1500), npp: count(0), foundingDecree: count(1), D: '2026-06-30' }).met).toBe(false);
    expect(evaluatePrerequisites({ titles: count(1500), npp: count(1), foundingDecree: count(0), D: '2026-06-30' }).met).toBe(false);
    expect(evaluatePrerequisites({ titles: count(null), npp: count(null), foundingDecree: count(null), D: '2026-06-30' })).toEqual({
      titles: { pass: false, count: 0, asOf: '2026-06-30' },
      npp: { pass: false },
      foundingDecree: { pass: false },
      met: false,
    });
  });
});
