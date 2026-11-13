import type { NoteRef } from '@altis/shared/api/accreditation';
import { describe, expect, it } from 'vitest';
import { instrumentById } from '../../src/accreditation/instruments/index.js';
import { evaluateSnp } from '../../src/accreditation/scoring/index.js';
import type { AccredInstrument, AccredMetricValue, SnpCheck } from '../../src/accreditation/types.js';

// The school standards of the compliance tab: each passes or fails by its own rule, is only reported, or waits for a
// later module; a standard whose input is missing is not evaluated, and says why through the notes of its value.

const LEVELS = { sd: 'sch-sd-2025', smp: 'sch-smp-2025', sma: 'sch-sma-2025' } as const;
type Level = keyof typeof LEVELS;

const check = (level: Level, code: string): SnpCheck => {
  const found = (instrumentById(LEVELS[level]) as AccredInstrument).snp.find((s) => s.code === `SNP-S-${code}`);
  if (found === undefined) throw new Error(`${level} has no SNP-S-${code}`);
  return found;
};
const val = (value: number | null, o: Partial<AccredMetricValue> = {}): AccredMetricValue => ({ value, unit: 'count', basis: 'live', notes: [], ...o });
const outcome = (level: Level, code: string, value: number | null, o: { size?: number | null; classes?: number | null; facts?: AccredMetricValue['facts'] } = {}) =>
  evaluateSnp(check(level, code), val(value, o.facts === undefined ? {} : { facts: o.facts }), o.size === undefined || o.size === null ? null : val(o.size), o.classes ?? null)
    .outcome;
const keys = (notes: readonly NoteRef[]): string[] => notes.map((n) => n.key);

describe('the standards of each level', () => {
  it('fourteen codes, with a label and the rule the tab prints', () => {
    for (const level of ['sd', 'smp', 'sma'] as const) {
      const snp = (instrumentById(LEVELS[level]) as AccredInstrument).snp;
      expect(snp.map((s) => s.code)).toEqual(Array.from({ length: 14 }, (_, k) => `SNP-S-${String(k + 1).padStart(2, '0')}`));
      for (const s of snp) expect(s.labelKey).toBe(`accred.snp.${s.code.slice(4)}`);
    }
  });

  it('a result carries the code, the label, the value and the printed rule', () => {
    const c = check('sma', '01');
    expect(evaluateSnp(c, val(1000), null, null)).toEqual({
      code: 'SNP-S-01',
      labelKey: 'accred.snp.S-01',
      outcome: 'pass',
      value: 1000,
      rule: c.ruleKey,
      notes: [],
    });
  });
});

describe('minimum counts', () => {
  it('S-01: at least 1 000 titles', () => {
    expect(outcome('sd', '01', 1000)).toBe('pass');
    expect(outcome('sd', '01', 999)).toBe('fail');
    expect(outcome('sd', '01', null)).toBe('not_evaluated');
    expect(evaluateSnp(check('sd', '01'), null, null, null).outcome).toBe('not_evaluated');
  });

  it('S-05: periodicals, 2 at SD and SMP and 3 at SMA', () => {
    expect([outcome('sd', '05', 2), outcome('sd', '05', 1)]).toEqual(['pass', 'fail']);
    expect([outcome('smp', '05', 2), outcome('sma', '05', 2), outcome('sma', '05', 3)]).toEqual(['pass', 'fail', 'pass']);
  });

  it('S-08: service hours, 30 a week at SD and 35 at SMP and SMA', () => {
    expect([outcome('sd', '08', 30), outcome('sd', '08', 29)]).toEqual(['pass', 'fail']);
    expect([outcome('smp', '08', 34), outcome('sma', '08', 35)]).toEqual(['fail', 'pass']);
  });

  it('S-10: promotion activities, at least 4, 7 and 8 a year', () => {
    expect([outcome('sd', '10', 4), outcome('sd', '10', 3)]).toEqual(['pass', 'fail']);
    expect([outcome('smp', '10', 7), outcome('smp', '10', 6)]).toEqual(['pass', 'fail']);
    expect([outcome('sma', '10', 8), outcome('sma', '10', 7)]).toEqual(['pass', 'fail']);
  });

  it('S-12: the library budget at least 5 % of the school budget', () => {
    expect([outcome('sma', '12', 5), outcome('sma', '12', 4), outcome('sma', '12', null)]).toEqual(['pass', 'fail', 'not_evaluated']);
  });
});

describe('S-02: the fiction share of enrichment books', () => {
  it('passes only at the target share of its level, 40, 30 or 25 %', () => {
    expect([outcome('sd', '02', 40), outcome('sd', '02', 41), outcome('sd', '02', 26)]).toEqual(['pass', 'fail', 'fail']);
    expect([outcome('smp', '02', 30), outcome('smp', '02', 29)]).toEqual(['pass', 'fail']);
    expect([outcome('sma', '02', 25), outcome('sma', '02', 26)]).toEqual(['pass', 'fail']);
  });
});

describe('S-03: enrichment books by the number of classes', () => {
  it('SMA 19 to 27 classes need 2 500 titles; SMP 19 to 24', () => {
    for (const classes of [19, 27]) {
      expect(outcome('sma', '03', 2499, { classes }), String(classes)).toBe('fail');
      expect(outcome('sma', '03', 2500, { classes }), String(classes)).toBe('pass');
    }
    expect(outcome('smp', '03', 2499, { classes: 24 })).toBe('fail');
    expect(outcome('smp', '03', 2500, { classes: 19 })).toBe('pass');
    expect(outcome('sma', '03', 2000, { classes: 18 })).toBe('pass');
    expect(outcome('sd', '03', 1000, { classes: 6 })).toBe('pass');
    expect(outcome('sd', '03', 1000, { classes: 7 })).toBe('fail');
  });

  it('a class count outside the ranges uses the nearest group and says so', () => {
    const r = evaluateSnp(check('sma', '03'), val(2500), null, 30);
    expect(r.outcome).toBe('pass');
    expect(r.notes).toContainEqual({ key: 'accred.note.snp_tier_outside', params: { classes: 30 } });
    expect(outcome('sma', '03', 2499, { classes: 30 })).toBe('fail');
    expect(outcome('smp', '03', 2499, { classes: 25 })).toBe('fail');
    const low = evaluateSnp(check('smp', '03'), val(1000), null, 2);
    expect(low.outcome).toBe('pass');
    expect(keys(low.notes)).toContain('accred.note.snp_tier_outside');
    expect(keys(evaluateSnp(check('sma', '03'), val(2500), null, 20).notes)).not.toContain('accred.note.snp_tier_outside');
  });

  it('without the class count it is not evaluated', () => {
    expect(outcome('sma', '03', 2500, { classes: null })).toBe('not_evaluated');
  });
});

describe('S-04: reference works', () => {
  const four = ['encyclopedia', 'dictionary', 'handbook', 'globe'];

  it('SD: the four named kinds and at least 4 kinds in all', () => {
    expect(outcome('sd', '04', 4, { facts: { elements: four } })).toBe('pass');
    expect(outcome('sd', '04', 4, { facts: { elements: ['encyclopedia', 'dictionary', 'handbook', 'atlas'] } })).toBe('fail');
    expect(outcome('sd', '04', 3, { facts: { elements: four } })).toBe('fail');
  });

  it('SMP: the same named kinds and at least 5; SMA adds the biography', () => {
    expect(outcome('smp', '04', 4, { facts: { elements: four } })).toBe('fail');
    expect(outcome('smp', '04', 5, { facts: { elements: [...four, 'atlas'] } })).toBe('pass');
    expect(outcome('sma', '04', 5, { facts: { elements: [...four, 'atlas'] } })).toBe('fail');
    expect(outcome('sma', '04', 5, { facts: { elements: [...four, 'biography'] } })).toBe('pass');
  });

  it('a value without the kinds found fails the named kinds', () => {
    expect(outcome('sd', '04', 6)).toBe('fail');
  });
});

describe('S-06: titles added in the period', () => {
  it('the threshold follows the size of the collection at the start: 10 %, 8 % above 1 500, 6 % above 2 000', () => {
    expect([outcome('sma', '06', 10, { size: 1200 }), outcome('sma', '06', 9, { size: 1200 })]).toEqual(['pass', 'fail']);
    expect([outcome('sma', '06', 8, { size: 1501 }), outcome('sma', '06', 7, { size: 2000 })]).toEqual(['pass', 'fail']);
    expect([outcome('sma', '06', 6, { size: 2001 }), outcome('sma', '06', 5, { size: 2001 })]).toEqual(['pass', 'fail']);
  });

  it('a start below 1 000 titles uses the first threshold and says so', () => {
    const r = evaluateSnp(check('sd', '06'), val(11), val(900), null);
    expect(r.outcome).toBe('pass');
    expect(keys(r.notes)).toContain('accred.note.snp_start_below_1000');
    expect(keys(evaluateSnp(check('sd', '06'), val(11), val(1000), null).notes)).not.toContain('accred.note.snp_start_below_1000');
  });

  it('too many undated copies, no start or no value: not evaluated', () => {
    const notes = [{ key: 'accred.note.undated_share_high', params: { pct: 12, max: 10 } }];
    const gated = evaluateSnp(check('sd', '06'), val(11, { suggest: false, notes }), val(1200), null);
    expect(gated.outcome).toBe('not_evaluated');
    expect(gated.notes).toEqual(notes);
    expect(outcome('sd', '06', 11, { size: null })).toBe('not_evaluated');
    expect(outcome('sd', '06', null, { size: 0 })).toBe('not_evaluated');
  });
});

describe('S-07: stock-taking and weeding', () => {
  const run = (lastStocktake: string | null, lastWeeding: string | null, D?: string) =>
    evaluateSnp(check('smp', '07'), val(1, { facts: { lastStocktake, lastWeeding } }), null, null, D === undefined ? {} : { D }).outcome;

  it('both within the three years to the snapshot date', () => {
    expect(run('2024-08-10', '2024-08-12', '2026-06-30')).toBe('pass');
    expect(run('2023-07-01', '2026-06-30', '2026-06-30')).toBe('pass');
    expect(run('2023-06-30', '2024-08-12', '2026-06-30')).toBe('fail');
    expect(run('2024-08-10', null, '2026-06-30')).toBe('fail');
    expect(run(null, null, '2026-06-30')).toBe('fail');
    expect(run('2024-08-10', '2024-08-12')).toBe('pass');
  });

  it('a value without data is not evaluated', () => {
    expect(evaluateSnp(check('smp', '07'), val(null), null, null).outcome).toBe('not_evaluated');
  });
});

describe('S-09: visit and loan reports', () => {
  it('passes with at least a month of visits and a month of loans', () => {
    expect(outcome('sd', '09', 12, { facts: { visitMonths: 12, loanMonths: 10 } })).toBe('pass');
    expect(outcome('sd', '09', 12, { facts: { visitMonths: 12, loanMonths: 0 } })).toBe('fail');
    expect(outcome('sd', '09', 0, { facts: { visitMonths: 0, loanMonths: 3 } })).toBe('fail');
    expect(outcome('sd', '09', 0)).toBe('not_evaluated');
  });
});

describe('S-11: the number of staff', () => {
  it('SD with 7 classes needs at least 3, with 6 at least 1', () => {
    expect([outcome('sd', '11', 2, { classes: 7 }), outcome('sd', '11', 3, { classes: 7 })]).toEqual(['fail', 'pass']);
    expect(outcome('sd', '11', 1, { classes: 6 })).toBe('pass');
  });

  it('SMP and SMA need 3 above 3 classes, else 1', () => {
    expect([outcome('smp', '11', 2, { classes: 4 }), outcome('sma', '11', 1, { classes: 3 }), outcome('sma', '11', 0, { classes: 3 })]).toEqual([
      'fail',
      'pass',
      'fail',
    ]);
  });

  it('without the class count or the staff it is not evaluated', () => {
    expect(outcome('sd', '11', 3, { classes: null })).toBe('not_evaluated');
    expect(outcome('sd', '11', null, { classes: 7 })).toBe('not_evaluated');
  });
});

describe('reported and later standards', () => {
  it('S-13 is reported, even without the previous period, whose note is kept', () => {
    const notes = [{ key: 'accred.note.snp_no_previous' }];
    const r = evaluateSnp(check('sma', '13'), val(null, { unit: 'percent', notes }), null, null);
    expect(r.outcome).toBe('reported');
    expect(r.notes).toEqual(notes);
    expect(evaluateSnp(check('sma', '13'), null, null, null).outcome).toBe('reported');
  });

  it('S-14 waits for the members module', () => {
    const r = evaluateSnp(check('sd', '14'), null, null, 7);
    expect([r.outcome, r.value, keys(r.notes)]).toEqual(['not_available', null, ['accred.note.snp_not_available']]);
  });
});
