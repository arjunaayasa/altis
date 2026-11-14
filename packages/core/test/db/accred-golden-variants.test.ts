import { localDate } from '@altis/shared';
import type { ResultsView } from '@altis/shared/api/accreditation';
import { afterAll, beforeAll, describe, expect, it } from 'vitest';
import { engineLabel, testDbContext } from '../../../../tools/test/test-db.js';
import { metricParamsOf } from '../../src/accreditation/evaluate/compose.js';
import { getResults } from '../../src/accreditation/evaluate/index.js';
import { instrumentById } from '../../src/accreditation/instruments/index.js';
import type { AccredMetricId } from '../../src/accreditation/metric-ids.js';
import { readProfile } from '../../src/accreditation/periods/profile.js';
import { collectionProvider } from '../../src/accreditation/providers/collection.js';
import { ACCRED_METRIC_PROVIDERS } from '../../src/accreditation/providers/index.js';
import { AccredResultPayload, type AccredMetricValue, type ProviderResume } from '../../src/accreditation/types.js';
import { snapshotDate } from '../../src/accreditation/windows.js';
import { firstAcq, inStockAt, scanRecordStock, STOCK_SCAN_MAX_LIMIT } from '../../src/reports/stock/index.js';
import type { RecordStockFacts } from '../../src/reports/stock/stock.js';
import { loadAccredSettings } from '../../src/settings/accreditation.js';
import { GOLDEN_LEVELS, seedSmaContoh, type GoldenFixture, type GoldenLevel } from '../support/accreditation-golden.js';
import { drive, enqueue, openAccredDb, rowsOf, type AccredDb } from './accred-results-support.js';

// Two variants of the golden school dataset, each evaluated through the real job and the real providers:
// - without the school population (the student and education staff counts are not entered): the three indicators
//   divided by the population give no value and say why, so the score is only a range over the answered items;
// - with three acquisition-date edge cases added to the catalogue: a copy on order for a new title (never in the
//   stock, never an addition), a copy received after the snapshot date for a new title (not in the stock at that date
//   and outside the three-year window, which ends there), and one more record of the SLiMS migration whose input date
//   was invalid, so its creation time is the migration's own clock (its copy is undated: in the stock at every date,
//   never an addition). No copy the migration left undated counts as an addition in the year of the migration.

const ctx = testDbContext();

/** Evaluates the periods of `levels` through the real job; their results views. */
async function evaluate(db: AccredDb, fx: GoldenFixture, levels: readonly GoldenLevel[]): Promise<Map<GoldenLevel, ResultsView>> {
  await new Promise((resolve) => setTimeout(resolve, 5));
  const registry = db.registry(ACCRED_METRIC_PROVIDERS);
  const out = new Map<GoldenLevel, ResultsView>();
  for (const level of levels) {
    const { jobId } = await enqueue(db, registry, fx.periods[level]);
    expect((await drive(db, registry, jobId)).at(-1)).toBe('succeeded');
    out.set(level, await getResults(db.h.db, fx.periods[level], await loadAccredSettings(db.h.db), Date.now()));
  }
  return out;
}

/** The stored indicator row `code` of `periodId`. */
async function storedIndicator(db: AccredDb, periodId: string, code: string): Promise<Extract<AccredResultPayload, { kind: 'indicator' }>> {
  const row = AccredResultPayload.parse((await rowsOf(db, periodId)).get(code));
  if (row.kind !== 'indicator') throw new Error(`${code} is not an indicator row`);
  return row;
}

describe.skipIf(!ctx.available)(`golden school dataset without the school population [${engineLabel()}]`, () => {
  let db: AccredDb;
  let fx: GoldenFixture;
  let views: Map<GoldenLevel, ResultsView>;

  beforeAll(async () => {
    db = await openAccredDb('accred-golden-nopop');
    fx = await seedSmaContoh(db.h, { withoutPopulation: true });
    views = await evaluate(db, fx, GOLDEN_LEVELS);
  }, 180_000);

  afterAll(async () => {
    await db?.close();
  });

  it.each(GOLDEN_LEVELS)('%s: the ICT, school-visits and population-per-staff items give no value and say the population is missing', (level) => {
    for (const code of ['SCH-SP4', 'SCH-L14', 'SCH-T5']) {
      const i = views.get(level)!.indicators.find((x) => x.code === code)!;
      expect({ code, value: i.value, suggestion: i.suggestion, final: i.final }).toEqual({ code, value: null, suggestion: null, final: null });
      expect(i.notes.map((n) => n.key)).toContain('accred.note.population_missing');
    }
  });

  it('the teachers stay entered, so the lesson-plan item is still computed', () => {
    const f4 = views.get('sma')!.indicators.find((x) => x.code === 'SCH-F4')!;
    expect([f4.value, f4.suggestion]).toEqual([40, 'b']);
  });

  it('upper secondary: a range over 39 of 42 answered items, without a single score or a predicate', () => {
    const score = views.get('sma')!.score!;
    expect([score.answered, score.total]).toEqual([39, 42]);
    expect(score.na).toBeNull();
    expect(score.grade).toBeNull();
    // Unanswered items scored 1 (low) and 4 (high): sums SP 16+1, L 38+1, T 11+1 → N 75 330 / 1 120 = 67.25…;
    // SP 16+4, L 38+4, T 11+4 → N 81 150 / 1 120 = 72.45….
    expect([score.naLow, score.naHigh]).toEqual(['67.25', '72.45']);
  });

  it.each(['smp', 'sd'] as const)('%s: a range over 38 of 41 answered items', (level) => {
    const score = views.get(level)!.score!;
    expect([score.answered, score.total, score.na, score.grade]).toEqual([38, 41, null, null]);
  });
});

describe.skipIf(!ctx.available)(`golden school dataset with the ruled acquisition-date edge cases [${engineLabel()}]`, () => {
  let db: AccredDb;
  let fx: GoldenFixture;
  let views: Map<GoldenLevel, ResultsView>;

  beforeAll(async () => {
    db = await openAccredDb('accred-golden-edges');
    fx = await seedSmaContoh(db.h, { rulingEdges: true });
    views = await evaluate(db, fx, ['sma']);
  }, 180_000);

  afterAll(async () => {
    await db?.close();
  });

  /** The collection metrics `ids` of the upper secondary period, computed by the real provider to its end. */
  async function collectionValues(ids: readonly AccredMetricId[]): Promise<Map<AccredMetricId, AccredMetricValue>> {
    const periodId = fx.periods.sma;
    const period = await db.h.db.selectFrom('accred_periods').selectAll().where('id', '=', periodId).executeTakeFirstOrThrow();
    const settings = await loadAccredSettings(db.h.db);
    const instrument = instrumentById(period.instrument_id)!;
    const now = Date.now();
    const today = localDate(settings.timezone, now);
    const metricCtx = {
      db: db.h.db,
      periodId,
      period,
      profile: readProfile(period.profile),
      instrument,
      D: snapshotDate(period.ends_on, today),
      today,
      settings,
      baseUrl: null,
      now,
      budgetLeftMs: () => 20_000,
      paramsOf: metricParamsOf(instrument),
    };
    let resume: ProviderResume | null = null;
    for (;;) {
      const step = await collectionProvider.compute(metricCtx, ids, resume);
      if (step.done) return new Map(step.values);
      resume = step.resume;
    }
  }

  /** Every title of the catalogue with its copies, as the stock rules read them. */
  async function allTitles(): Promise<Map<string, RecordStockFacts>> {
    const out = new Map<string, RecordStockFacts>();
    let after: string | null = null;
    do {
      const batch = await scanRecordStock(db.h.db, { tz: 'Asia/Jakarta', after, limit: STOCK_SCAN_MAX_LIMIT });
      for (const r of batch.rows) out.set(r.recordId, r);
      after = batch.next;
    } while (after !== null);
    return out;
  }

  const EBOOK = new Set(['EBOOK']);

  it('the undated migrated record is in the stock at every date: 1 001 titles (K1 b) and 701 at the start of the window', async () => {
    const sma = views.get('sma')!;
    const k1 = sma.indicators.find((i) => i.code === 'SCH-K1')!;
    expect([k1.value, k1.suggestion]).toEqual([1001, 'b']);
    const k6 = await storedIndicator(db, fx.periods.sma, 'SCH-K6');
    expect(k6.size?.value).toBe(701);
    const v = await collectionValues(['collection.titles', 'collection.titles_window_start', 'collection.titles_period_start']);
    expect([v.get('collection.titles')?.value, v.get('collection.titles_window_start')?.value, v.get('collection.titles_period_start')?.value]).toEqual([1001, 701, 901]);
  });

  it('additions stay 301, so the three-year share is 30 100 ÷ 701 = 42 → b in the first tier, noted below 1 000 titles', async () => {
    const k6 = await storedIndicator(db, fx.periods.sma, 'SCH-K6');
    expect(k6.value?.value).toBe(42);
    expect([k6.value?.numerator, k6.value?.denominator]).toEqual([301, 701]);
    expect(k6.suggestion).toBe('b');
    expect(k6.value?.table).toEqual([
      ['2023-12-31', 701],
      [2024, 100],
      [2025, 101],
      [2026, 100],
    ]);
    expect([...(k6.value?.notes ?? []), ...k6.notes]).toEqual(
      expect.arrayContaining([
        { key: 'accred.note.k6_tier', params: { count: 701 } },
        { key: 'accred.note.k6_start_below_1000' },
        { key: 'accred.note.items_without_received_date', params: { count: 41 } },
      ]),
    );
  });

  it('41 of 1 201 live copies are undated', async () => {
    const v = await collectionValues(['collection.undated_items', 'collection.live_items']);
    expect(v.get('collection.undated_items')?.value).toBe(41);
    expect(v.get('collection.undated_items')?.facts).toEqual(expect.objectContaining({ live: 1201 }));
    expect(v.get('collection.live_items')?.value).toBe(1201);
  });

  it('the period additions are only the 100 titles received in 2026 (100 ÷ 901 = 11 %, the standard passes)', async () => {
    const v = await collectionValues(['collection.title_additions_period_pct']);
    expect(v.get('collection.title_additions_period_pct')?.value).toBe(11);
    expect([v.get('collection.title_additions_period_pct')?.numerator, v.get('collection.title_additions_period_pct')?.denominator]).toEqual([100, 901]);
    expect(views.get('sma')!.snp.find((s) => s.code === 'SNP-S-06')?.outcome).toBe('pass');
  });

  it('the ordered title is in no stock and never an addition', async () => {
    const r = (await allTitles()).get(fx.records.edges!.onOrder)!;
    for (const day of ['2023-12-31', '2025-06-30', fx.expected.D]) expect(inStockAt(r, day, EBOOK)).toBe(false);
    expect(firstAcq(r)).toBe('unknown');
  });

  it('the title received after the snapshot date is not in the stock at that date and outside the window', async () => {
    const r = (await allTitles()).get(fx.records.edges!.afterD)!;
    expect(inStockAt(r, fx.expected.D, EBOOK)).toBe(false);
    const first = firstAcq(r);
    expect(first).toBe('2026-08-01');
    expect(first > fx.expected.D).toBe(true);
  });

  it('no copy the migration left undated is an addition: each such title is in the stock at every date with an unknown first acquisition', async () => {
    const titles = await allTitles();
    const undated = [...fx.records.undated, fx.records.edges!.undatedLate];
    expect(undated).toHaveLength(41);
    for (const id of undated) {
      const r = titles.get(id)!;
      expect(r.createdOn, id).toBeNull();
      expect(r.items.every((i) => i.acqDate === null)).toBe(true);
      expect(firstAcq(r)).toBe('unknown');
      for (const day of ['2023-12-31', '2025-06-30', fx.expected.D]) expect(inStockAt(r, day, EBOOK)).toBe(true);
    }
    // The titles first acquired in 2026 are exactly the ones received here on 2026-02-15.
    const in2026 = [...titles.values()].filter((r) => {
      const first = firstAcq(r);
      return first !== 'unknown' && first >= '2026-01-01' && first <= fx.expected.D && !inStockAt(r, '2023-12-31', EBOOK);
    });
    expect(in2026).toHaveLength(100);
    expect(in2026.every((r) => r.items.length > 0 && r.items.every((i) => i.receivedDate === '2026-02-15'))).toBe(true);
  });
});
