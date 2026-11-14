import type { ResultsView } from '@altis/shared/api/accreditation';
import { afterAll, beforeAll, describe, expect, it } from 'vitest';
import { engineLabel, testDbContext } from '../../../../tools/test/test-db.js';
import { getResults } from '../../src/accreditation/evaluate/index.js';
import { instrumentById } from '../../src/accreditation/instruments/index.js';
import { ACCRED_METRIC_PROVIDERS } from '../../src/accreditation/providers/index.js';
import { catalogueCode } from '../../src/accreditation/scoring/score.js';
import { AccredResultPayload, type AccredInstrument } from '../../src/accreditation/types.js';
import type { SliceResult } from '../../src/jobs/types.js';
import { loadAccredSettings } from '../../src/settings/accreditation.js';
import { GOLDEN_LEVELS, seedSmaContoh, type GoldenFixture, type GoldenLevel } from '../support/accreditation-golden.js';
import { drive, enqueue, openAccredDb, rowsOf, type AccredDb } from './accred-results-support.js';

// The golden school dataset ("SMA contoh") evaluated through the real evaluation job and the real metric providers,
// once under each of the three 2025 school instruments (upper secondary, lower secondary, primary): every computed
// indicator's stored value and suggested answer, the final answers with the four answered by hand, the component
// sums, the score as an integer fraction and its two-decimal form, the predicate, the largest gaps, the school
// standards and the official item numbers of the primary and lower secondary instruments. The expected values are the
// fixture's hand-computed table (with the formula of each value); none is read back from the engine.

const ctx = testDbContext();

type Payload = AccredResultPayload;

/** The least common multiple of the components' maximum scores (4 × items): the score's integer denominator. */
function lcmOfMaxima(score: NonNullable<ResultsView['score']>): number {
  const gcd = (a: number, b: number): number => (b === 0 ? a : gcd(b, a % b));
  return score.perComponent.reduce((l, c) => (l * 4 * c.n) / gcd(l, 4 * c.n), 1);
}

describe.skipIf(!ctx.available)(`golden school dataset under the three school instruments [${engineLabel()}]`, () => {
  let db: AccredDb;
  let fx: GoldenFixture;
  const outcomes = new Map<GoldenLevel, SliceResult['outcome'][]>();
  const views = new Map<GoldenLevel, ResultsView>();
  const stored = new Map<GoldenLevel, Map<string, Payload>>();

  beforeAll(async () => {
    db = await openAccredDb('accred-golden');
    fx = await seedSmaContoh(db.h);
    // Every seeded change lies strictly before the evaluations' start.
    await new Promise((resolve) => setTimeout(resolve, 5));
    const registry = db.registry(ACCRED_METRIC_PROVIDERS);
    for (const level of GOLDEN_LEVELS) {
      const periodId = fx.periods[level];
      const { jobId } = await enqueue(db, registry, periodId);
      outcomes.set(level, await drive(db, registry, jobId));
      views.set(level, await getResults(db.h.db, periodId, await loadAccredSettings(db.h.db), Date.now()));
      const rows = new Map<string, Payload>();
      for (const [code, json] of await rowsOf(db, periodId)) {
        const parsed = AccredResultPayload.safeParse(json);
        if (parsed.success) rows.set(code, parsed.data);
      }
      stored.set(level, rows);
    }
  }, 180_000);

  afterAll(async () => {
    await db?.close();
  });

  const view = (level: GoldenLevel): ResultsView => views.get(level)!;
  const instrumentOf = (level: GoldenLevel): AccredInstrument => instrumentById(fx.instruments[level])!;
  const indicatorOf = (level: GoldenLevel, code: string) => view(level).indicators.find((i) => i.code === code);

  it.each(GOLDEN_LEVELS)('the %s period is evaluated by the real job to the end, with fresh results', (level) => {
    expect(outcomes.get(level)!.at(-1)).toBe('succeeded');
    const v = view(level);
    expect(v.status).toBe('ready');
    expect(v.stale).toBe(false);
    expect(v.prerequisites).toEqual({ titles: { pass: true, count: 1000, asOf: fx.expected.D }, npp: { pass: true }, foundingDecree: { pass: true }, met: true });
  });

  it.each(GOLDEN_LEVELS)('%s: every computed indicator stores the hand-computed value and suggests the expected answer', (level) => {
    const instr = instrumentOf(level);
    const rows = stored.get(level)!;
    const checked: string[] = [];
    for (const ind of instr.components.flatMap((c) => c.indicators)) {
      if (ind.band.kind === 'manual') continue;
      const code = catalogueCode(ind);
      const exp = fx.expected.indicators.find((e) => `SCH-${e.code}` === code);
      expect(exp, `${code} has an expected row`).toBeDefined();
      const row = rows.get(code);
      expect(row?.kind, code).toBe('indicator');
      if (row?.kind !== 'indicator') continue;
      expect({ code, value: row.value?.value ?? null, suggestion: row.suggestion }).toEqual({ code, value: exp!.value[level], suggestion: exp!.answer[level] });
      expect({ code, fraction: row.value?.numerator === undefined ? null : [row.value.numerator, row.value.denominator] }).toEqual({ code, fraction: exp!.fraction });
      const shown = indicatorOf(level, code)!;
      expect({ code, value: shown.value, suggestion: shown.suggestion }).toEqual({ code, value: exp!.value[level], suggestion: exp!.answer[level] });
      checked.push(exp!.code);
    }
    expect(checked).toHaveLength(level === 'sma' ? 38 : 37);
  });

  it.each(GOLDEN_LEVELS)('%s: the final answers are the suggestions and the four items answered by hand', (level) => {
    const finals = Object.fromEntries(view(level).indicators.map((i) => [i.code, i.final]));
    const expected = Object.fromEntries(
      fx.expected.indicators.filter((e) => e.answer[level] !== null).map((e) => [`SCH-${e.code}`, e.answer[level]]),
    );
    expect(finals).toEqual(expected);
    for (const code of ['SCH-SP1', 'SCH-SP2', 'SCH-SP3', 'SCH-F3']) {
      const i = indicatorOf(level, code)!;
      expect(i.suggestion).toBeNull();
      expect(i.answer?.mode).toBe('manual');
    }
  });

  it('the collection items carry their notes: e-books counted, undated copies, the three-year table and its tier', () => {
    const k1 = indicatorOf('sma', 'SCH-K1')!;
    expect(k1.notes).toEqual(
      expect.arrayContaining([
        { key: 'accred.note.electronic_counted', params: { count: 20 } },
        { key: 'accred.note.items_without_received_date', params: { count: 40 } },
      ]),
    );
    const k6 = stored.get('sma')!.get('SCH-K6');
    expect(k6?.kind).toBe('indicator');
    if (k6?.kind !== 'indicator') return;
    expect(k6.size?.value).toBe(700);
    expect(k6.value?.numerator).toBe(301);
    expect(k6.value?.denominator).toBe(700);
    expect(k6.value?.suggest).not.toBe(false);
    expect(k6.value?.table).toEqual([
      ['2023-12-31', 700],
      [2024, 100],
      [2025, 101],
      [2026, 100],
    ]);
    const keys = [...(k6.value?.notes ?? []), ...k6.notes];
    expect(keys).toEqual(
      expect.arrayContaining([
        { key: 'accred.note.items_without_received_date', params: { count: 40 } },
        { key: 'accred.note.k6_tier', params: { count: 700 } },
        { key: 'accred.note.k6_start_below_1000' },
      ]),
    );
    expect(keys.map((n) => n.key)).not.toContain('accred.note.undated_share_high');
  });

  it.each(GOLDEN_LEVELS)('%s: the component sums, the score as an integer fraction, its two decimals and the predicate', (level) => {
    const exp = fx.expected.totals[level];
    const score = view(level).score!;
    expect(score.answered).toBe(score.total);
    expect(score.perComponent.map((c) => c.code)).toEqual(['K', 'SP', 'L', 'T', 'F', 'G']);
    expect(score.perComponent.map((c) => c.sum)).toEqual(exp.sums);
    const L = lcmOfMaxima(score);
    const N = score.perComponent.reduce((n, c) => n + c.sum * c.weight * (L / (4 * c.n)), 0);
    expect({ N, L }).toEqual({ N: exp.n, L: exp.l });
    expect(score.na).toBe(exp.na);
    expect(score.grade).toBe(exp.grade);
  });

  it('upper secondary: the ten largest gaps in their order, with their sizes', () => {
    expect(view('sma').score!.gaps.map((g) => `${g.officialNo} ${g.gap}`)).toEqual(fx.expected.gaps.sma);
  });

  it('the school-visits item counts the deleted members as students and prints the raw visits, the guests and the divisor', () => {
    expect(indicatorOf('sma', 'SCH-L14')!.notes).toEqual(
      expect.arrayContaining([
        { key: 'accred.note.school_months', params: { divisor: 10 } },
        expect.objectContaining({ key: 'accred.note.member_unknown', params: expect.objectContaining({ count: 35 }) }),
        expect.objectContaining({ key: 'accred.note.visits_deduped', params: expect.objectContaining({ raw: 700 }) }),
        { key: 'accred.note.guests_excluded', params: { count: 70 } },
      ]),
    );
  });

  it.each(GOLDEN_LEVELS)('%s: the school standards pass, fail or are reported as expected', (level) => {
    const outcomesByCode = Object.fromEntries(view(level).snp.map((s) => [s.code, s.outcome]));
    const expected = Object.fromEntries(fx.expected.snp.map((s) => [s.code, s.outcome[level]]));
    expect(outcomesByCode).toEqual(expected);
    const s13 = view(level).snp.find((s) => s.code === 'SNP-S-13')!;
    expect(s13.notes.map((n) => n.key)).toContain('accred.note.snp_no_previous');
    for (const s of fx.expected.snp) {
      if (s.value === undefined) continue;
      expect({ code: s.code, value: view(level).snp.find((x) => x.code === s.code)!.value }).toEqual({ code: s.code, value: s.value });
    }
  });

  it.each(GOLDEN_LEVELS)('%s: the official item numbers of the results view', (level) => {
    const numbers = Object.fromEntries(view(level).indicators.map((i) => [i.code, i.officialNo]));
    expect(numbers).toEqual(fx.expected.officialNo[level]);
  });

  it('the primary and lower secondary instruments number the school-visits item L13', () => {
    expect(indicatorOf('sd', 'SCH-L14')!.officialNo).toBe('L13');
    expect(indicatorOf('smp', 'SCH-L14')!.officialNo).toBe('L13');
    expect(indicatorOf('sma', 'SCH-L14')!.officialNo).toBe('L14');
    expect(indicatorOf('sd', 'SCH-L7')).toBeUndefined();
    expect(indicatorOf('smp', 'SCH-L7')).toBeUndefined();
  });
});
