import fsp from 'node:fs/promises';
import os from 'node:os';
import path from 'node:path';
import { PHASE1_MIGRATIONS, runMigrations, withTx } from '@altis/db';
import { endOfMonth, newId, type UsageMetric } from '@altis/shared';
import { afterAll, beforeAll, beforeEach, describe, expect, it } from 'vitest';
import { engineLabel, testDb, testDbContext, type TestDbHandle } from '../../../../tools/test/test-db.js';
import { instrumentById } from '../../src/accreditation/instruments/index.js';
import type { AccredMetricId } from '../../src/accreditation/metric-ids.js';
import { readProfile } from '../../src/accreditation/periods/profile.js';
import { usageProvider } from '../../src/accreditation/providers/usage.js';
import type { AccredMetricContext, AccredMetricValue } from '../../src/accreditation/types.js';
import { putUsageGroups } from '../../src/accreditation/usage/index.js';
import { txCtx, type Actor } from '../../src/context.js';
import { loadAccredSettings } from '../../src/settings/accreditation.js';
import { writeSettings } from '../../src/settings/service.js';

// The `usage` metric provider on the engine picked by ALTIS_TEST_DB: the school-month divisor, the share of the school
// community's visits (the decree's own worked example among the cases), the monthly series, the profile's monthly
// averages, the active members, the months covered and the reading interest against the previous twelve months. The
// visits of the SLiMS import count through the member-type mapping as it stands when the metrics are computed.

const ctx = testDbContext();
const NOW = Date.UTC(2026, 8, 1, 2, 0, 0);
const ACTOR: Actor = { type: 'staff', id: newId(NOW), ip: null };
const MONTHS = ['2025-07', '2025-08', '2025-09', '2025-10', '2025-11', '2025-12', '2026-01', '2026-02', '2026-03', '2026-04', '2026-05', '2026-06'];
const PREVIOUS = ['2024-07', '2024-08', '2024-09', '2024-10', '2024-11', '2024-12', '2025-01', '2025-02', '2025-03', '2025-04', '2025-05', '2025-06'];
const ALL: AccredMetricId[] = [
  'usage.school_months',
  'usage.school_visits_pct',
  'usage.monthly_series',
  'usage.profile_averages',
  'usage.members_active',
  'usage.coverage',
  'usage.reading_interest',
];

/** `total` spread over `months`: the remainder goes to the first months. */
function spread(total: number, months: readonly string[]): [string, number][] {
  const base = Math.floor(total / months.length);
  const rest = total - base * months.length;
  return months.map((m, i) => [m, base + (i < rest ? 1 : 0)]);
}

describe.skipIf(!ctx.available)(`accreditation usage provider [${engineLabel()}]`, () => {
  let h: TestDbHandle;
  let root: string;

  beforeAll(async () => {
    h = await testDb();
    root = await fsp.mkdtemp(path.join(os.tmpdir(), 'altis-core-accred-usage-provider-'));
    await runMigrations(h, { appVersion: '0.1.0', dataDir: path.join(root, 'migrations'), migrations: PHASE1_MIGRATIONS });
  });

  afterAll(async () => {
    await h?.close();
    if (root !== undefined) await fsp.rm(root, { recursive: true, force: true });
  });

  beforeEach(async () => {
    await h.db.deleteFrom('usage_stats').execute();
    await h.db.deleteFrom('usage_group_map').execute();
    await settings({ 'library.type': 'sekolah', 'accreditation.visits.dedupeLegacy': true, 'accreditation.unknownMemberGroup.default': 'auto' });
    await map('slims_type:1', 'student');
    await map('slims_type:2', 'teacher');
    await map('slims_type:3', 'public');
  });

  async function settings(patch: Record<string, unknown>): Promise<void> {
    await withTx(h, (trx) => writeSettings(trx, patch, { keyring: [], now: NOW, actorId: null }));
  }

  async function map(key: string, group: string | null): Promise<void> {
    await h.db.insertInto('usage_group_map').values({ group_key: key, label: key, accred_group: group, updated_at: NOW - 500, updated_by: null }).execute();
  }

  /** A school-year period 2025/2026 of the test profile's school instrument with this population (null: not filled in). */
  async function period(population: [number | null, number | null, number | null], o: { instrumentId?: string; kind?: string } = {}): Promise<string> {
    const id = newId(NOW);
    await h.db
      .insertInto('accred_periods')
      .values({
        id,
        branch_id: null,
        name: 'Tahun pelajaran 2025/2026',
        kind: o.kind ?? 'school_year',
        starts_on: '2025-07-01',
        ends_on: '2026-06-30',
        instrument_id: o.instrumentId ?? 'test-sch',
        status: 'open',
        frozen_at: null,
        frozen_by: null,
        profile: '{"schoolLevel":"sma_smk_ma"}',
        students: population[0],
        teachers: population[1],
        edu_staff: population[2],
        all_registered_confirmed: 0,
        archived_at: null,
        version: 0,
        created_at: NOW,
        created_by: null,
        updated_at: NOW,
        updated_by: null,
      })
      .execute();
    return id;
  }

  async function slims(metric: UsageMetric, span: string | { from: string; to: string }, key: string, value: number): Promise<void> {
    const from = typeof span === 'string' ? `${span}-01` : span.from;
    const to = typeof span === 'string' ? endOfMonth(span) : span.to;
    await h.db
      .insertInto('usage_stats')
      .values({ source: 'slims', metric, span_from: from, span_to: to, branch_key: '', group_key: key, value, run_id: null, updated_at: NOW - 500, updated_by: null })
      .execute();
  }

  /** `total` rows of `metric` and `key` spread over `months`. */
  async function slimsOver(metric: UsageMetric, key: string, total: number, months: readonly string[] = MONTHS): Promise<void> {
    for (const [m, v] of spread(total, months)) await slims(metric, m, key, v);
  }

  async function compute(periodId: string, ids: readonly AccredMetricId[] = ALL): Promise<Map<AccredMetricId, AccredMetricValue>> {
    const period = await h.db.selectFrom('accred_periods').selectAll().where('id', '=', periodId).executeTakeFirstOrThrow();
    const c: AccredMetricContext = {
      db: h.db,
      periodId,
      period,
      profile: readProfile(period.profile),
      instrument: instrumentById(period.instrument_id)!,
      D: period.ends_on,
      today: '2026-09-01',
      settings: await loadAccredSettings(h.db),
      baseUrl: null,
      now: NOW,
      budgetLeftMs: () => 10_000,
      paramsOf: () => ({}),
    };
    const step = await usageProvider.compute(c, ids, null);
    if (!step.done) throw new Error('the usage provider answers in one step');
    expect([...step.values.keys()].sort()).toEqual([...ids].sort());
    return new Map(step.values);
  }

  const value = async (periodId: string, id: AccredMetricId): Promise<AccredMetricValue> => (await compute(periodId, [id])).get(id)!;

  describe('the school-month divisor and the share of the school community visits', () => {
    it('625 visits without repeats over 12 months for 125 people: (625 × 100) ÷ (10 × 125) = 50', async () => {
      await slimsOver('visits_deduped', 'slims_type:1', 500);
      await slimsOver('visits_deduped', 'slims_type:2', 125);
      await slimsOver('visits', 'slims_type:1', 560);
      await slimsOver('visits', 'slims_type:2', 140);
      const id = await period([100, 20, 5]);
      const values = await compute(id);
      expect(values.get('usage.school_months')).toEqual({
        value: 10,
        unit: 'count',
        basis: 'imported',
        notes: [{ key: 'accred.note.school_months', params: { divisor: 10 } }],
        facts: { monthsWithData: 12, divisor: 10 },
      });
      expect(values.get('usage.school_visits_pct')).toEqual({
        value: 50,
        numerator: 625,
        denominator: 1250,
        unit: 'percent',
        basis: 'imported',
        notes: [
          { key: 'accred.note.school_months', params: { divisor: 10 } },
          { key: 'accred.note.visits_deduped', params: { minutes: 60, raw: 700 } },
        ],
        detail: { reportId: 'accreditation.annex.l14', params: { periodId: id } },
        facts: { visits: 625, raw: 700, guests: 0, publicVisits: 0, memberUnknown: 0, divisor: 10, population: 125 },
      });
    });

    it('raw visits while repeats are not removed: 700 visits for 123 people → 56, the decimals cut', async () => {
      await settings({ 'accreditation.visits.dedupeLegacy': false });
      await slimsOver('visits_deduped', 'slims_type:1', 625);
      await slimsOver('visits', 'slims_type:1', 560);
      await slimsOver('visits', 'slims_type:2', 140);
      const id = await period([108, 10, 5]);
      const v = await value(id, 'usage.school_visits_pct');
      expect([v.value, v.numerator, v.denominator]).toEqual([56, 700, 1230]);
      expect(v.notes).toEqual([{ key: 'accred.note.school_months', params: { divisor: 10 } }, { key: 'accred.note.truncated' }]);
      expect(v.facts).toMatchObject({ visits: 700, raw: 700 });
    });

    it('nine months with data: the divisor is 10 × 9 ÷ 12 rounded up = 8, and 625 visits for 123 people → 63', async () => {
      await slimsOver('visits_deduped', 'slims_type:1', 625, MONTHS.slice(0, 9));
      await slimsOver('visits', 'slims_type:1', 650, MONTHS.slice(0, 9));
      const id = await period([108, 10, 5]);
      const values = await compute(id, ['usage.school_months', 'usage.school_visits_pct']);
      const prorated = { key: 'accred.note.school_months_prorated', params: { months: 9, divisor: 8 } };
      expect(values.get('usage.school_months')).toMatchObject({ value: 8, notes: [prorated], facts: { monthsWithData: 9, divisor: 8 } });
      expect(values.get('usage.school_visits_pct')).toMatchObject({
        value: 63,
        numerator: 625,
        denominator: 984,
        notes: [prorated, { key: 'accred.note.visits_deduped', params: { minutes: 60, raw: 650 } }, { key: 'accred.note.truncated' }],
      });
    });

    it('no usage at all: no divisor and no share, with the note that asks for the monthly usage', async () => {
      const id = await period([100, 20, 5]);
      const values = await compute(id, ['usage.school_months', 'usage.school_visits_pct', 'usage.profile_averages']);
      const noData = [{ key: 'accred.note.usage_no_data' }];
      expect(values.get('usage.school_months')).toMatchObject({ value: null, basis: 'none', notes: noData });
      expect(values.get('usage.school_visits_pct')).toMatchObject({ value: null, basis: 'none', notes: noData });
      expect(values.get('usage.profile_averages')).toMatchObject({ value: null, notes: noData });
    });

    it('a population not filled in: no share, with the note that asks for it', async () => {
      await slimsOver('visits_deduped', 'slims_type:1', 625);
      const id = await period([null, 20, 5]);
      const v = await value(id, 'usage.school_visits_pct');
      expect(v.value).toBeNull();
      expect(v.notes.map((n) => n.key)).toEqual(['accred.note.school_months', 'accred.note.visits_deduped', 'accred.note.population_missing']);
      expect(v.facts).toMatchObject({ visits: 625, population: null, divisor: 10 });
    });

    it('a new mapping counts at once, without a new import: teachers moved to the public leave the share', async () => {
      await slimsOver('visits_deduped', 'slims_type:1', 500);
      await slimsOver('visits_deduped', 'slims_type:2', 125);
      const id = await period([100, 20, 5]);
      expect((await value(id, 'usage.school_visits_pct')).value).toBe(50);
      const rows = () => h.db.selectFrom('usage_stats').selectAll().orderBy('metric').orderBy('span_from').orderBy('group_key').execute();
      const before = await rows();

      await withTx(h, (trx) => putUsageGroups(txCtx(trx, NOW, ACTOR), { groups: [{ groupKey: 'slims_type:2', accredGroup: 'public' }] }, NOW));
      const v = await value(id, 'usage.school_visits_pct');
      expect([v.value, v.numerator]).toEqual([40, 500]);
      expect(v.notes).toContainEqual({ key: 'accred.note.guests_excluded', params: { count: 125 } });
      expect(v.facts).toMatchObject({ publicVisits: 125 });
      expect(await rows()).toEqual(before);
    });

    it('deleted members count in their default group on a school, with a note; a default of no group leaves them out', async () => {
      await slimsOver('visits_deduped', 'slims_type:1', 600);
      await slimsOver('visits_deduped', 'member_unknown', 25);
      const id = await period([100, 20, 5]);
      let v = await value(id, 'usage.school_visits_pct');
      expect([v.value, v.numerator]).toEqual([50, 625]);
      expect(v.notes).toContainEqual({ key: 'accred.note.member_unknown', params: { count: 25, group: 'siswa/mahasiswa' } });
      expect(v.facts).toMatchObject({ memberUnknown: 25 });

      await settings({ 'accreditation.unknownMemberGroup.default': null });
      v = await value(id, 'usage.school_visits_pct');
      expect([v.value, v.numerator]).toEqual([48, 600]);
      expect(v.notes.map((n) => n.key)).not.toContain('accred.note.member_unknown');
      expect(v.facts).toMatchObject({ memberUnknown: 0 });
    });

    it('guests and the public are printed apart and never counted as the school community', async () => {
      await slimsOver('visits_deduped', 'slims_type:1', 625);
      await slimsOver('visits_deduped', 'slims_type:3', 20);
      await slimsOver('visits_deduped', 'guest', 30);
      const id = await period([100, 20, 5]);
      const v = await value(id, 'usage.school_visits_pct');
      expect([v.value, v.numerator]).toEqual([50, 625]);
      expect(v.notes).toContainEqual({ key: 'accred.note.guests_excluded', params: { count: 50 } });
      expect(v.facts).toMatchObject({ guests: 30, publicVisits: 20 });
    });
  });

  describe('the series, the averages, the members and the months covered', () => {
    it('the monthly series with the source of every month, the averages per school month, the active members and the coverage', async () => {
      await slims('visits_deduped', '2025-08', 'slims_type:1', 40);
      await slims('visits_deduped', '2025-08', 'guest', 6);
      await slims('visits_deduped', { from: '2026-01-01', to: '2026-01-14' }, 'slims_type:2', 12);
      await slims('loans', '2025-08', '', 21);
      await slims('loans', '2025-09', '', 9);
      await slims('members_active', { from: '2025-07-01', to: '2026-06-30' }, 'slims_type:1', 110);
      await slims('members_active', { from: '2025-07-01', to: '2026-06-30' }, 'slims_type:2', 18);
      await h.db
        .insertInto('usage_stats')
        .values({ source: 'manual', metric: 'in_library_uses', span_from: '2025-09-01', span_to: '2025-09-30', branch_key: '', group_key: '', value: 35, run_id: null, updated_at: NOW, updated_by: null })
        .execute();
      const id = await period([100, 20, 5]);
      const values = await compute(id);

      const series = values.get('usage.monthly_series')!;
      expect(series).toMatchObject({ value: 58, unit: 'count', basis: 'imported', detail: { reportId: 'accreditation.annex.usage_monthly', params: { periodId: id } } });
      expect(series.table).toHaveLength(12);
      expect(series.table![0]).toEqual(['2025-07', '', '', '', '', '', '', '', '', 'none', '']);
      expect(series.table![1]).toEqual(['2025-08', 40, '', '', '', '', 6, 21, '', 'slims', '']);
      expect(series.table![2]).toEqual(['2025-09', '', '', '', '', '', '', 9, 35, 'manual+slims', '']);
      expect(series.table![6]).toEqual(['2026-01', '', 12, '', '', '', '', '', '', 'slims', '2026-01-14']);

      // Two months with visits: the divisor is 10 × 2 ÷ 12 rounded up = 2.
      expect(values.get('usage.profile_averages')).toMatchObject({
        value: 29,
        unit: 'count',
        table: [
          ['visitors', 58, 29],
          ['in_library_uses', 35, 17],
          ['loans', 30, 15],
        ],
        notes: [{ key: 'accred.note.school_months_prorated', params: { months: 2, divisor: 2 } }],
        facts: { divisor: 2, monthsWithData: 2, school: true },
      });
      expect(values.get('usage.members_active')).toMatchObject({
        value: 128,
        basis: 'imported',
        table: [
          ['student', 110],
          ['teacher', 18],
        ],
      });
      expect(values.get('usage.coverage')).toMatchObject({ value: 2, facts: { visitMonths: 2, loanMonths: 2 }, notes: [] });
    });

    it('outside a school the averages divide by the months with data; nothing imported leaves no active members and no coverage', async () => {
      await settings({ 'library.type': 'umum' });
      await slims('visits_deduped', '2025-08', '', 40);
      await slims('visits_deduped', '2025-09', '', 21);
      const id = await period([null, null, null], { instrumentId: 'general-stats', kind: 'school_year' });
      const values = await compute(id, ['usage.profile_averages', 'usage.members_active', 'usage.coverage']);
      expect(values.get('usage.profile_averages')).toMatchObject({ value: 30, notes: [], facts: { divisor: 2, monthsWithData: 2, school: false } });
      expect(values.get('usage.members_active')).toMatchObject({ value: null, basis: 'none', notes: [{ key: 'accred.note.usage_no_data' }] });
      expect(values.get('usage.coverage')).toMatchObject({ value: 2, facts: { visitMonths: 2, loanMonths: 0 } });
    });
  });

  describe('the reading interest against the previous twelve months', () => {
    it('visits 1 000 against 800 grow 25 %; 100 distinct visitors this period and 80 before give 10 visits each', async () => {
      await slimsOver('visits_deduped', '', 1000);
      await slimsOver('visits_deduped', '', 800, PREVIOUS);
      await slimsOver('loans', '', 500);
      await slimsOver('loans', '', 400, PREVIOUS);
      await slims('distinct_visitors', { from: '2025-07-01', to: '2026-06-30' }, '', 100);
      await slims('distinct_visitors', { from: '2024-07-01', to: '2025-06-30' }, '', 80);
      // A sum of monthly distinct visitors is not the distinct visitors of the period.
      await slimsOver('distinct_visitors', '', 600);
      const id = await period([100, 20, 5]);
      expect(await value(id, 'usage.reading_interest')).toEqual({
        value: 25,
        unit: 'percent',
        basis: 'imported',
        notes: [],
        table: [
          ['visits', 800, 1000, 25],
          ['loans', 400, 500, 25],
          ['frequency', 10, 10, ''],
        ],
        facts: {
          visits: 1000,
          visitsPrevious: 800,
          visitsGrowth: 25,
          loans: 500,
          loansPrevious: 400,
          loansGrowth: 25,
          distinctVisitors: 100,
          distinctVisitorsPrevious: 80,
          frequency: 10,
          frequencyPrevious: 10,
        },
      });
    });

    it('only monthly distinct visitors: no reading interest, with the note that there is nothing to compare with', async () => {
      await slimsOver('visits_deduped', '', 1000);
      await slimsOver('visits_deduped', '', 800, PREVIOUS);
      await slimsOver('distinct_visitors', '', 600);
      await slimsOver('distinct_visitors', '', 500, PREVIOUS);
      const id = await period([100, 20, 5]);
      expect(await value(id, 'usage.reading_interest')).toMatchObject({ value: null, notes: [{ key: 'accred.note.snp_no_previous' }] });
    });
  });
});
