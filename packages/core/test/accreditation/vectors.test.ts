import type { NoteRef } from '@altis/shared/api/accreditation';
import { describe, expect, it } from 'vitest';
import { instrumentById } from '../../src/accreditation/instruments/index.js';
import { routineFacts } from '../../src/accreditation/scoring/rules.js';
import { catalogueCode, gradeOf } from '../../src/accreditation/scoring/score.js';
import { evaluatePrerequisites, finalAnswers, scoreInstrument, suggestAnswer } from '../../src/accreditation/scoring/index.js';
import type { AccredIndicator, AccredInstrument, AccredMetricValue, Letter } from '../../src/accreditation/types.js';

// The worked examples of the 2025 school instruments and the edge cases around them, run through the real instrument
// data: a metric value (already cut to a whole number by its provider) gives a suggested answer, and the answers give
// the estimated score and its predicate.

const instrument = (id: string): AccredInstrument => instrumentById(id) as AccredInstrument;
const SD = instrument('sch-sd-2025');
const SMP = instrument('sch-smp-2025');
const SMA = instrument('sch-sma-2025');

const ik = (instr: AccredInstrument, code: string): AccredIndicator => {
  const found = instr.components.flatMap((c) => c.indicators).find((i) => i.code === code);
  if (found === undefined) throw new Error(`${instr.id} has no ${code}`);
  return found;
};

const val = (value: number | null, o: Partial<AccredMetricValue> = {}): AccredMetricValue => ({ value, unit: 'count', basis: 'live', notes: [], ...o });
const suggest = (instr: AccredInstrument, code: string, value: number | null, o: Partial<AccredMetricValue> = {}, size: number | null = null) =>
  suggestAnswer(ik(instr, code), val(value, o), size === null ? null : val(size)).suggestion;
const keys = (notes: readonly NoteRef[]): string[] => notes.map((n) => n.key);

/** Every indicator answered `letter`, then the exceptions (null: unanswered). */
function finals(instr: AccredInstrument, letter: Letter, except: Readonly<Record<string, Letter | null>> = {}): Map<string, Letter | null> {
  const out = new Map<string, Letter | null>();
  for (const i of instr.components.flatMap((c) => c.indicators)) out.set(catalogueCode(i), i.code in except ? (except[i.code] ?? null) : letter);
  return out;
}

describe('the decree examples', () => {
  it('K2 SMA: 250 fiction titles of 1 000 are 25 % and answer a', () => {
    expect(suggest(SMA, 'K2', 25)).toBe('a');
  });

  it('K2 SD: 400 fiction titles of 1 000 are 40 % and answer a; 41 % answers d', () => {
    expect(suggest(SD, 'K2', 40)).toBe('a');
    expect(suggest(SD, 'K2', 41)).toBe('d');
  });

  it('K6: 500 titles added to a starting collection of 1 500 are 33 % in the first tier and answer b', () => {
    expect(suggest(SD, 'K6', 33, { unit: 'percent' }, 1500)).toBe('b');
    expect(suggest(SMA, 'K6', 33, { unit: 'percent' }, 1500)).toBe('b');
  });

  it('SP4: 5 devices for 125 people are 4 % and answer a', () => {
    expect(suggest(SMA, 'SP4', 4)).toBe('a');
  });

  it('SP5: 1 computer for 2 staff is 50 % and answers c', () => {
    expect(suggest(SMA, 'SP5', 50)).toBe('c');
  });

  it('L14: 625 visits over 10 school months for 125 people are 50 % and answer c', () => {
    for (const instr of [SD, SMP, SMA]) expect(suggest(instr, 'L14', 50), instr.id).toBe('c');
  });

  it('T4: 12 trainings for 2 staff average 6 and answer c at SMA; 6 for 2 average 3 and answer c at SD', () => {
    expect(suggest(SMA, 'T4', 6)).toBe('c');
    expect(suggest(SD, 'T4', 3)).toBe('c');
  });

  it('T5: 178 people per 2 staff are 89 and answer c at SD; 123 per 2 are 61.5, cut to 61, and answer b at SMA', () => {
    expect(suggest(SD, 'T5', 89)).toBe('c');
    expect(suggest(SMA, 'T5', 61)).toBe('b');
  });

  it('K1: exactly 1 000 titles answer c in every instrument', () => {
    for (const instr of [SD, SMP, SMA]) expect(suggest(instr, 'K1', 1000), instr.id).toBe('c');
  });

  it('the estimate is 100.00 when every answer is a and 25.00 when every answer is d', () => {
    for (const instr of [SD, SMP, SMA]) {
      expect(scoreInstrument(instr, finals(instr, 'a'), { prerequisitesMet: true })!.na, instr.id).toBe('100.00');
      expect(scoreInstrument(instr, finals(instr, 'd'), { prerequisitesMet: true })!.na, instr.id).toBe('25.00');
    }
  });
});

describe('the edges around the examples', () => {
  it('K1: 999 titles answer d, 1 001 and 1 500 b, 1 501 a', () => {
    expect([999, 1001, 1500, 1501].map((v) => suggest(SMA, 'K1', v))).toEqual(['d', 'b', 'b', 'a']);
  });

  it('K2 SMA: 24.9 % is cut to 24 and answers b; 26 % answers d, 10 % c and 9.9 % (cut to 9) d', () => {
    expect([24, 26, 10, 9].map((v) => suggest(SMA, 'K2', v))).toEqual(['b', 'd', 'c', 'd']);
  });

  it('K2 SMA: 25 % falls in both a and b of the decree; a is suggested and the overlap noted', () => {
    const r = suggestAnswer(ik(SMA, 'K2'), val(25, { unit: 'percent', facts: { rule: 'tipe koleksi FIKSI' } }), null);
    expect(r.suggestion).toBe('a');
    expect(keys(r.notes)).toContain('accred.note.k2_overlap');
    expect(keys(suggestAnswer(ik(SMA, 'K2'), val(24, { unit: 'percent' }), null).notes)).not.toContain('accred.note.k2_overlap');
    expect(keys(suggestAnswer(ik(SD, 'K2'), val(40, { unit: 'percent' }), null).notes)).not.toContain('accred.note.k2_overlap');
  });

  it('K2 SD: 20 % answers c, 21 % and 39 % b, 19 % d', () => {
    expect([20, 21, 39, 19].map((v) => suggest(SD, 'K2', v))).toEqual(['c', 'b', 'b', 'd']);
  });

  it('K6: 375 titles added to 1 501 are 24.98 %, cut to 24, in the second tier: c', () => {
    expect(suggest(SMA, 'K6', 24, { unit: 'percent' }, 1501)).toBe('c');
  });

  it('K6: from 2 000 titles, 18 % answers c and 19 % b in the third tier', () => {
    expect(suggest(SMA, 'K6', 18, { unit: 'percent' }, 2000)).toBe('c');
    expect(suggest(SMA, 'K6', 19, { unit: 'percent' }, 2000)).toBe('b');
  });

  it('K6: too many copies without an acquisition date print the value but suggest nothing; at the limit a suggestion is given', () => {
    const over = suggestAnswer(ik(SMA, 'K6'), val(43, { unit: 'percent', suggest: false }), val(700));
    expect(over.suggestion).toBeNull();
    expect(suggestAnswer(ik(SMA, 'K6'), val(43, { unit: 'percent' }), val(700)).suggestion).toBe('b');
  });

  it('K6: the tier is always named; a start below 1 000 titles uses the first tier and says so; no start gives nothing', () => {
    const below = suggestAnswer(ik(SD, 'K6'), val(43, { unit: 'percent' }), val(700));
    expect(below.notes).toContainEqual({ key: 'accred.note.k6_tier', params: { count: 700 } });
    expect(keys(below.notes)).toContain('accred.note.k6_start_below_1000');
    const tier3 = suggestAnswer(ik(SD, 'K6'), val(20, { unit: 'percent' }), val(2400));
    expect(tier3.notes).toContainEqual({ key: 'accred.note.k6_tier', params: { count: 2400 } });
    expect(keys(tier3.notes)).not.toContain('accred.note.k6_start_below_1000');
    for (const size of [0, null]) {
      const none = suggestAnswer(ik(SD, 'K6'), val(null, { unit: 'percent' }), size === null ? null : val(size));
      expect(none.suggestion, String(size)).toBeNull();
      expect(keys(none.notes), String(size)).toContain('accred.note.k6_no_start');
    }
  });

  it('T5 SMA: 35 people per staff answer a, 36 and 107 b, 108 and 144 c, 145 d', () => {
    expect([35, 36, 107, 108, 144, 145].map((v) => suggest(SMA, 'T5', v))).toEqual(['a', 'b', 'b', 'c', 'c', 'd']);
  });

  it('L14 without the repeat-visit filter: 700 visits over 10 months for 123 people are 56 % and answer b', () => {
    expect(suggest(SMA, 'L14', 56)).toBe('b');
  });

  it('L14 with 9 months of data: 625 visits over 8 months for 123 people are 63 % and answer b', () => {
    expect(suggest(SMA, 'L14', 63)).toBe('b');
  });

  it('SD with one service item at b and the rest at a is 99.32 (rounding would give 99.33), an A', () => {
    const s = scoreInstrument(SD, finals(SD, 'a', { L5: 'b' }), { prerequisitesMet: true })!;
    expect([s.na, s.grade]).toEqual(['99.32', 'A']);
  });

  it('SMA with one service item at b and the rest at a is 99.375, cut to 99.37, an A', () => {
    const s = scoreInstrument(SMA, finals(SMA, 'a', { L5: 'b' }), { prerequisitesMet: true })!;
    expect([s.na, s.grade]).toEqual(['99.37', 'A']);
  });

  it('every answer c is 50.00 and every answer b 75.00', () => {
    for (const instr of [SD, SMP, SMA]) {
      expect(scoreInstrument(instr, finals(instr, 'c'), { prerequisitesMet: true })!.na, instr.id).toBe('50.00');
      expect(scoreInstrument(instr, finals(instr, 'b'), { prerequisitesMet: true })!.na, instr.id).toBe('75.00');
    }
  });

  it('SMA with SP1 and SP2 unanswered and the rest at a: the range 97.85 to 100.00, 40 of 42 answered, no predicate', () => {
    const s = scoreInstrument(SMA, finals(SMA, 'a', { SP1: null, SP2: null }), { prerequisitesMet: true })!;
    expect([s.na, s.naLow, s.naHigh, s.answered, s.total, s.grade]).toEqual([null, '97.85', '100.00', 40, 42, null]);
  });

  it('the predicate edges: 91.00 A, 90.99 B, 76.00 B, 75.99 C, 60.00 C, 59.99 D', () => {
    expect([9100, 9099, 7600, 7599, 6000, 5999].map(gradeOf)).toEqual(['A', 'B', 'B', 'C', 'C', 'D']);
  });

  it('every indicator answered with 999 titles: the estimate is shown, the predicate is not', () => {
    const count = (value: number) => val(value);
    const p = evaluatePrerequisites({ titles: count(999), npp: count(1), foundingDecree: count(1), D: '2026-06-30' });
    expect(p.met).toBe(false);
    const s = scoreInstrument(SMA, finals(SMA, 'b'), { prerequisitesMet: p.met })!;
    expect([s.na, s.grade]).toEqual(['75.00', null]);
  });

  it('K3 SMA with seven aspects but the fifth required one missing is a d, naming the missing aspect', () => {
    const r = suggestAnswer(ik(SMA, 'K3'), val(7, { facts: { elements: ['a1', 'a2', 'a3', 'a4', 'a6', 'a7', 'a8'] } }), null);
    expect(r.suggestion).toBe('d');
    expect(r.notes).toContainEqual({ key: 'accred.note.mandatory_missing', params: { items: 'Aspek 5' } });
  });

  it('F1 with the founding decree, duties and structure but no library number is a d, naming the number', () => {
    const r = suggestAnswer(ik(SMA, 'F1'), val(3, { facts: { elements: ['founding_decree', 'duties', 'org_structure'] } }), null);
    expect(r.suggestion).toBe('d');
    expect(r.notes).toContainEqual({ key: 'accred.note.mandatory_missing', params: { items: 'Nomor Pokok Perpustakaan' } });
  });

  it('G3: yearly shares of 6.5 %, 5.2 % and 6.9 % average 6.2, cut to 6: b', () => {
    expect(suggest(SMA, 'G3', 6, { unit: 'percent' })).toBe('b');
  });

  it('L3 SD: 2 activities answer c whatever the decree writes for d, and the reading is noted', () => {
    const r = suggestAnswer(ik(SD, 'L3'), val(2), null);
    expect(r.suggestion).toBe('c');
    expect(keys(r.notes)).toContain('accred.note.l3_sd_option_d');
    expect(keys(suggestAnswer(ik(SMA, 'L3'), val(2), null).notes)).not.toContain('accred.note.l3_sd_option_d');
  });

  it('a value with no data gives no suggestion, and an indicator answered by hand never gets one', () => {
    expect(suggest(SMA, 'K1', null)).toBeNull();
    expect(suggestAnswer(ik(SMA, 'K1'), null, null).suggestion).toBeNull();
    expect(suggestAnswer(ik(SMA, 'SP1'), null, null).suggestion).toBeNull();
    expect(suggestAnswer(ik(SMA, 'F3'), val(3), null).suggestion).toBeNull();
  });
});

describe('one school measured under the three instruments', () => {
  // A school year 2025/2026 of a school with 108 students, 10 teachers and 5 education staff (123 people), 1 000 titles
  // of which 250 fiction, 301 titles added to the 700 of the end of 2023, two active staff and one public address.
  const facts = {
    K3: { elements: ['a1', 'a2', 'a3', 'a4', 'a5', 'a6'] },
    K7: { live: 1200, processed: 1200, threshold: 100, scanners: 2 },
    L1: { elements: ['rules', 'sop_membership', 'sop_loan'] },
    L11: { class: 'public', membersUsed: null, circulationUsed: null },
    T1: { educationLevel: 's1', educationLibrary: false, libraryTraining: true, heads: 1 },
    T3: { librarians: 1, ict: 0, technical: 1, technicalCertified: 1 },
    F1: { elements: ['founding_decree', 'duties', 'npp'] },
    F2: { elements: ['pos_collection', 'pos_organisation', 'pos_service', 'pos_promotion'] },
    G1: { elements: ['a1', 'a2', 'a3'] },
    G4: routineFacts([
      { annual: 1, semester: 2, quarterly: 3, monthly: 0 },
      { annual: 1, semester: 2, quarterly: 3, monthly: 0 },
      { annual: 1, semester: 2, quarterly: 3, monthly: 0 },
    ]),
  } as const satisfies Record<string, AccredMetricValue['facts']>;
  const values: Readonly<Record<string, number>> = {
    K1: 1000,
    K2: 25,
    K3: 6,
    K4: 2,
    K5: 25,
    K6: 43,
    K7: 100,
    K8: 4,
    SP4: 4,
    SP5: 50,
    SP6: 30,
    SP7: 5,
    L1: 3,
    L2: 6,
    L3: 4,
    L4: 5,
    L5: 3,
    L7: 1,
    L8: 2,
    L9: 3,
    L10: 1,
    L11: 1,
    L12: 5,
    L13: 9,
    L14: 50,
    T1: 1,
    T2: 4,
    T3: 2,
    T4: 6,
    T5: 61,
    F1: 3,
    F2: 4,
    F4: 40,
    G1: 3,
    G2: 3,
    G3: 6,
    G4: 1,
  };
  const manual = new Map([
    ['SCH-SP1', { answer: 'a' as Letter, mode: 'manual' as const }],
    ['SCH-SP2', { answer: 'b' as Letter, mode: 'manual' as const }],
    ['SCH-SP3', { answer: 'c' as Letter, mode: 'manual' as const }],
    ['SCH-F3', { answer: 'c' as Letter, mode: 'manual' as const }],
  ]);

  function run(instr: AccredInstrument, localWorks: number) {
    const suggestions = new Map<string, Letter | null>();
    for (const i of instr.components.flatMap((c) => c.indicators)) {
      if (i.band.kind === 'manual') continue;
      const value = i.code === 'L6' ? localWorks : values[i.code]!;
      const v = val(value, { facts: (facts as Record<string, AccredMetricValue['facts']>)[i.code] });
      suggestions.set(catalogueCode(i), suggestAnswer(i, v, i.band.kind === 'sized_range' ? val(700) : null).suggestion);
    }
    const f = finalAnswers(instr, suggestions, manual);
    return { finals: f, score: scoreInstrument(instr, f, { prerequisitesMet: true })! };
  }

  const letters = (f: ReadonlyMap<string, Letter | null>): string => [...f.values()].join('');

  it('SMA: 70.45, a C', () => {
    const { finals: f, score } = run(SMA, 4);
    // K1…K8, SP1…SP7, L1…L14, T1…T5, F1…F4, G1…G4
    expect(letters(f)).toBe('cabbcbab' + 'abcaccb' + 'babbcbcbbcabbc' + 'bbbcb' + 'bbcb' + 'ccbb');
    expect(score.perComponent.map((c) => c.sum)).toEqual([24, 20, 40, 14, 11, 10]);
    expect([score.na, score.grade]).toEqual(['70.45', 'C']);
    expect(score.gaps.map((g) => `${g.officialNo} ${g.gap}`)).toEqual([
      'F3 1.8750',
      'T4 1.5000',
      'L5 1.2500',
      'L7 1.2500',
      'L10 1.2500',
      'L14 1.2500',
      'G1 1.2500',
      'G2 1.2500',
      'K1 0.9375',
      'K5 0.9375',
    ]);
  });

  it('SMP: 73.20, a C', () => {
    const { finals: f, score } = run(SMP, 3);
    expect(letters(f)).toBe('cbbbcbab' + 'abcaccb' + 'bababbbbcaba' + 'c' + 'bbbcb' + 'bbcb' + 'cbbb');
    expect(score.perComponent.map((c) => c.sum)).toEqual([23, 20, 41, 14, 11, 11]);
    expect([score.na, score.grade]).toEqual(['73.20', 'C']);
  });

  it('SD: 77.14, a B', () => {
    const { finals: f, score } = run(SD, 3);
    expect(letters(f)).toBe('cbabcbab' + 'abcaccb' + 'baaabbbbcaaa' + 'c' + 'bbbab' + 'bbcb' + 'cabb');
    expect(score.perComponent.map((c) => c.sum)).toEqual([24, 20, 43, 16, 11, 12]);
    expect([score.na, score.grade]).toEqual(['77.14', 'B']);
  });
});
