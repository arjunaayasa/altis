import { L12_FEATURES, MESSAGES, SCHOOL_LEVELS } from '@altis/shared';
import { LIBRARY_TYPES } from '@altis/shared/api/settings';
import { describe, expect, it } from 'vitest';
import { GENERAL_STATS_METRICS } from '../../src/accreditation/instruments/general-stats.js';
import { ACCRED_INSTRUMENTS, instrumentById, instrumentMetricIds } from '../../src/accreditation/instruments/index.js';
import { EVIDENCE_SNAPSHOT_DATE, evidenceReportParams } from '../../src/accreditation/instruments/shared.js';
import { ACCRED_METRICS } from '../../src/accreditation/metric-ids.js';
import { ACCRED_NOTE_KEYS } from '../../src/accreditation/notes.js';
import { PREREQUISITE_METRICS } from '../../src/accreditation/scoring/prerequisites.js';
import { instrumentScale } from '../../src/accreditation/scoring/score.js';
import type { AccredIndicator, AccredInstrument, RangeBand } from '../../src/accreditation/types.js';
import { REPORTS, reportById } from '../../src/reports/registry.js';

// The three school instruments of 2025 as data, the statistics mode, and the invariants every instrument of this build
// keeps (the test profile's instrument included): sizes and weights, message keys, evidence that names a report, the
// window of each metric, and the school standards of the compliance tab.

const MESSAGE_KEYS = new Set(Object.keys(MESSAGES.id));
const REPORT_IDS = new Set(REPORTS.map((d) => d.id));
const instrument = (id: string): AccredInstrument => instrumentById(id) as AccredInstrument;
const SCHOOL = ['sch-sd-2025', 'sch-smp-2025', 'sch-sma-2025'] as const;
const indicators = (i: AccredInstrument): AccredIndicator[] => i.components.flatMap((c) => c.indicators);
const ik = (id: string, code: string): AccredIndicator => indicators(instrument(id)).find((i) => i.code === code)!;

/** Whether every object and array reachable from `value` is frozen. */
function deepFrozen(value: unknown, seen = new Set<unknown>()): boolean {
  if (value === null || typeof value !== 'object' || seen.has(value)) return true;
  seen.add(value);
  if (!Object.isFrozen(value)) return false;
  return Object.values(value).every((v) => deepFrozen(v, seen));
}

describe('the school instruments of 2025', () => {
  it('in order: the three levels, the statistics mode, then the test instrument', () => {
    expect(ACCRED_INSTRUMENTS.map((i) => i.id)).toEqual([...SCHOOL, 'general-stats', 'test-sch']);
    for (const i of ACCRED_INSTRUMENTS) expect(instrumentById(i.id)).toBe(i);
  });

  it('41, 41 and 42 indicators in six components of 8, 7, 13 or 14, 5, 4 and 4; maximum 164, 164 and 168', () => {
    const shape = (id: string) => instrument(id).components.map((c) => [c.code, c.indicators.length]);
    expect(shape('sch-sd-2025')).toEqual([['K', 8], ['SP', 7], ['L', 13], ['T', 5], ['F', 4], ['G', 4]]);
    expect(shape('sch-smp-2025')).toEqual([['K', 8], ['SP', 7], ['L', 13], ['T', 5], ['F', 4], ['G', 4]]);
    expect(shape('sch-sma-2025')).toEqual([['K', 8], ['SP', 7], ['L', 14], ['T', 5], ['F', 4], ['G', 4]]);
    expect(SCHOOL.map((id) => indicators(instrument(id)).length)).toEqual([41, 41, 42]);
    expect(SCHOOL.map((id) => indicators(instrument(id)).length * 4)).toEqual([164, 164, 168]);
  });

  it('the component weights 15, 10, 35, 15, 15, 10 add up to 100, with their labels', () => {
    for (const id of SCHOOL) {
      const comps = instrument(id).components;
      expect(comps.map((c) => [c.code, c.weight, c.labelKey]), id).toEqual(
        [
          ['K', 15],
          ['SP', 10],
          ['L', 35],
          ['T', 15],
          ['F', 15],
          ['G', 10],
        ].map(([code, w]) => [code, w, `accred.component.${code}`]),
      );
      expect(comps.reduce((s, c) => s + c.weight, 0), id).toBe(100);
    }
  });

  it('the whole-number factors of the estimate: 14 560 for SD and SMP, 1 120 for SMA', () => {
    const sdSmp = { lcm: 14_560, factors: { K: 455, SP: 520, L: 280, T: 728, F: 910, G: 910 } };
    expect(instrumentScale(instrument('sch-sd-2025'))).toEqual(sdSmp);
    expect(instrumentScale(instrument('sch-smp-2025'))).toEqual(sdSmp);
    expect(instrumentScale(instrument('sch-sma-2025'))).toEqual({ lcm: 1_120, factors: { K: 35, SP: 40, L: 20, T: 56, F: 70, G: 70 } });
  });

  it('the indicators answered by hand, with their four option labels', () => {
    for (const id of SCHOOL) {
      const manual = indicators(instrument(id)).filter((i) => i.band.kind === 'manual');
      expect(manual.map((i) => i.code), id).toEqual(['SP1', 'SP2', 'SP3', 'F3']);
      for (const i of manual) {
        expect(i.metric, `${id} ${i.code}`).toBeUndefined();
        expect(i.optionKeys, `${id} ${i.code}`).toEqual(['a', 'b', 'c', 'd'].map((o) => `accred.ik.${i.code}.option.${o}`));
      }
    }
  });

  it('the rule indicators, with their option labels', () => {
    for (const id of SCHOOL) {
      const rules = indicators(instrument(id)).filter((i) => i.band.kind === 'rule');
      expect(
        rules.map((i) => [i.code, i.band.kind === 'rule' ? i.band.rule : null, i.metric]),
        id,
      ).toEqual([
        ['K7', 'k7', 'collection.k7_organisation'],
        ['L11', 'l11', 'system.l11_automation'],
        ['T1', 't1', 'registers.head_qualification'],
        ['T3', 't3', 'registers.staff_roles'],
        ['G4', 'g4', 'registers.report_routine_3p'],
      ]);
      for (const i of rules) expect(i.optionKeys, `${id} ${i.code}`).toHaveLength(4);
    }
  });

  it('K6 picks its bands from the size of the collection at the start of the window, in three tiers', () => {
    for (const id of SCHOOL) {
      expect(ik(id, 'K6').band, id).toEqual({
        kind: 'sized_range',
        sizeMetric: 'collection.titles_window_start',
        tiers: [
          { minSize: 0, bands: [{ answer: 'a', min: 46 }, { answer: 'b', min: 31, max: 45 }, { answer: 'c', min: 30, max: 30 }, { answer: 'd' }] },
          { minSize: 1501, bands: [{ answer: 'a', min: 37 }, { answer: 'b', min: 25, max: 36 }, { answer: 'c', min: 24, max: 24 }, { answer: 'd' }] },
          { minSize: 2000, bands: [{ answer: 'a', min: 28 }, { answer: 'b', min: 19, max: 27 }, { answer: 'c', min: 18, max: 18 }, { answer: 'd' }] },
        ],
      });
      expect(ACCRED_METRICS['collection.titles_window_start'].window).toBe(ik(id, 'K6').window);
    }
  });

  it('the website indicator counts six features at SD (no FAQ) and seven at SMP and SMA', () => {
    const features = (id: string) => ik(id, 'L12');
    expect(features('sch-sd-2025')).toMatchObject({ metric: 'system.website_features', band: { kind: 'range' } });
    expect(features('sch-sd-2025').metricParams).toEqual({ features: ['profile', 'opac', 'services', 'contact', 'databases', 'social'] });
    for (const id of ['sch-smp-2025', 'sch-sma-2025']) expect(features(id).metricParams, id).toEqual({ features: [...L12_FEATURES] });
    expect(features('sch-sd-2025').labelKey).toBe('accred.ik.L12.sd');
    expect(features('sch-sma-2025').labelKey).toBe('accred.ik.L12');
  });

  it('the local works counted at L6: five kinds, and the abstract at SMA', () => {
    const five = ['written_work', 'clipping', 'short_stories', 'poetry', 'review'];
    expect(ik('sch-sd-2025', 'L6').metricParams).toEqual({ countedKinds: five });
    expect(ik('sch-smp-2025', 'L6').metricParams).toEqual({ countedKinds: five });
    expect(ik('sch-sma-2025', 'L6').metricParams).toEqual({ countedKinds: [...five, 'abstract'] });
  });

  it('the primary-school wording of L4, and the notes only one level prints', () => {
    expect(ik('sch-sd-2025', 'L4').labelKey).toBe('accred.ik.L4.sd');
    expect(ik('sch-smp-2025', 'L4').labelKey).toBe('accred.ik.L4');
    expect(ik('sch-sma-2025', 'K2').noteKeys).toContain('accred.note.k2_overlap');
    expect(ik('sch-sd-2025', 'K2').noteKeys).not.toContain('accred.note.k2_overlap');
    expect(ik('sch-sd-2025', 'L3').noteKeys).toContain('accred.note.l3_sd_option_d');
    expect(ik('sch-smp-2025', 'L3').noteKeys).not.toContain('accred.note.l3_sd_option_d');
    expect(ik('sch-sd-2025', 'SP3').noteKeys).toContain('accred.note.sp3_mandatory_hint');
    expect(ik('sch-sma-2025', 'SP3').noteKeys).not.toContain('accred.note.sp3_mandatory_hint');
  });

  it('the required elements of K3, L1, F1, F2 and G1', () => {
    for (const id of SCHOOL) {
      const req = Object.fromEntries(
        indicators(instrument(id))
          .filter((i) => i.mandatory !== undefined)
          .map((i) => [i.code, i.mandatory]),
      );
      expect(req, id).toEqual({
        K3: ['a1', 'a2', 'a3', 'a4', 'a5'],
        L1: ['rules', 'sop_membership'],
        F1: ['founding_decree', 'npp'],
        F2: ['pos_collection', 'pos_organisation', 'pos_service'],
        G1: ['a1', 'a2', 'a3'],
      });
    }
  });

  it('the bands of a level differ only where its decree does', () => {
    const bands = (id: string, code: string): readonly RangeBand[] | null => {
      const b = ik(id, code).band;
      return b.kind === 'range' ? b.bands : null;
    };
    expect(bands('sch-sd-2025', 'K2')).toEqual([{ answer: 'a', min: 40, max: 40 }, { answer: 'b', min: 21, max: 39 }, { answer: 'c', min: 20, max: 20 }, { answer: 'd' }]);
    expect(bands('sch-smp-2025', 'K2')).toEqual([{ answer: 'a', min: 30, max: 30 }, { answer: 'b', min: 16, max: 29 }, { answer: 'c', min: 15, max: 15 }, { answer: 'd' }]);
    expect(bands('sch-sma-2025', 'K2')).toEqual([{ answer: 'a', min: 25, max: 25 }, { answer: 'b', min: 11, max: 25 }, { answer: 'c', min: 10, max: 10 }, { answer: 'd' }]);
    expect(bands('sch-sd-2025', 'T5')).toEqual([{ answer: 'a', max: 27 }, { answer: 'b', min: 28, max: 83 }, { answer: 'c', min: 84, max: 112 }, { answer: 'd' }]);
    expect(bands('sch-smp-2025', 'T5')).toEqual([{ answer: 'a', max: 31 }, { answer: 'b', min: 32, max: 95 }, { answer: 'c', min: 96, max: 128 }, { answer: 'd' }]);
    expect(bands('sch-sma-2025', 'L13')).toEqual([{ answer: 'a', min: 10 }, { answer: 'b', min: 9, max: 9 }, { answer: 'c', min: 8, max: 8 }, { answer: 'd' }]);
    expect(bands('sch-sd-2025', 'F1')).toEqual([{ answer: 'a', min: 4, max: 4 }, { answer: 'b', min: 3, max: 3 }, { answer: 'c', min: 2, max: 2 }, { answer: 'd' }]);
    for (const id of SCHOOL) {
      for (const i of indicators(instrument(id))) {
        const lists = i.band.kind === 'range' ? [i.band.bands] : i.band.kind === 'sized_range' ? i.band.tiers.map((t) => t.bands) : [];
        for (const list of lists) {
          expect(list.map((b) => b.answer), `${id} ${i.code}`).toEqual(['a', 'b', 'c', 'd']);
          expect(list.at(-1), `${id} ${i.code}`).toEqual({ answer: 'd' });
        }
      }
    }
  });

  it('is frozen all the way down', () => {
    for (const id of SCHOOL) expect(deepFrozen(instrument(id)), id).toBe(true);
    expect(deepFrozen(instrument('general-stats'))).toBe(true);
  });
});

describe('every instrument of this build', () => {
  for (const instr of ACCRED_INSTRUMENTS) {
    it(`${instr.id}: evidence, message keys, windows and codes`, () => {
      const missing: string[] = [];
      const need = (key: string): void => {
        if (!MESSAGE_KEYS.has(key)) missing.push(key);
      };
      for (const c of instr.components) need(c.labelKey);
      const codes = indicators(instr).map((i) => i.code);
      expect(new Set(codes).size).toBe(codes.length);
      for (const i of indicators(instr)) {
        const where = `${instr.id} ${i.code}`;
        need(i.labelKey);
        need(i.actionKey);
        expect(i.actionKey, where).toBe(`accred.gap.action.${i.code}`);
        for (const o of i.optionKeys ?? []) need(o);
        for (const n of i.noteKeys ?? []) {
          need(n);
          expect(ACCRED_NOTE_KEYS, where).toContain(n);
        }
        expect(i.evidence.length, where).toBeGreaterThan(0);
        expect(i.evidence.filter((e) => e.primary === true).length, where).toBeGreaterThan(0);
        expect(new Set(i.evidence.map((e) => e.code)).size, where).toBe(i.evidence.length);
        for (const e of i.evidence) {
          need(e.labelKey);
          expect(e.labelKey, where).toBe(`accred.evidence.${i.code}.${e.code}`);
          if (e.kind === 'generated') expect(REPORT_IDS, `${where} ${e.code}`).toContain(e.reportId);
          else expect([e.reportId, e.params], `${where} ${e.code}`).toEqual([undefined, undefined]);
          if (e.kind !== 'screenshot') expect(e.screen, `${where} ${e.code}`).toBeUndefined();
        }
        if (i.metric !== undefined) expect(i.window, where).toBe(ACCRED_METRICS[i.metric].window);
        if (i.band.kind === 'sized_range') expect(ACCRED_METRICS[i.band.sizeMetric].window, where).toBe(i.window);
        if (i.band.kind === 'manual') expect(i.metric, where).toBeUndefined();
        else expect(i.metric, where).toBeDefined();
      }
      for (const s of instr.snp) {
        need(s.labelKey);
        need(s.ruleKey);
        if (s.metric !== null) expect(s.window, `${instr.id} ${s.code}`).toBe(ACCRED_METRICS[s.metric].window);
        if (s.rule.kind === 'min_by_size') expect(ACCRED_METRICS[s.rule.sizeMetric].window, s.code).toBe(s.window);
      }
      expect(missing).toEqual([]);
    });
  }

  it('the generated evidence of the school instruments runs its report with valid parameters at the snapshot date', () => {
    const periodId = '01JD0000000000000000000000';
    for (const id of SCHOOL) {
      for (const i of indicators(instrument(id))) {
        for (const e of i.evidence.filter((x) => x.kind === 'generated')) {
          const def = reportById(e.reportId!)!;
          const params = evidenceReportParams(e, { periodId, D: '2026-06-30' });
          expect(def.paramsSchema.safeParse(params).success, `${id} ${i.code} ${e.code} ${JSON.stringify(params)}`).toBe(true);
          expect(Object.values(params), `${id} ${i.code} ${e.code}`).not.toContain(EVIDENCE_SNAPSHOT_DATE);
          if (e.reportId!.startsWith('accreditation.')) expect(params['periodId']).toBe(periodId);
          if (def.params.some((p) => p.name === 'asOf')) expect(params['asOf'], `${id} ${i.code} ${e.code}`).toBe('2026-06-30');
        }
      }
    }
  });

  it('a generated list carries the filters of its indicator', () => {
    const params = (id: string, code: string, evidence: string) => ik(id, code).evidence.find((e) => e.code === evidence)!.params;
    expect(params('sch-sma-2025', 'K2', 'fiction_list')).toEqual({ asOf: EVIDENCE_SNAPSHOT_DATE, fictionOnly: true });
    expect(params('sch-sma-2025', 'K8', 'preservation_list')).toEqual({ kinds: ['preservation'], window: 'three_periods' });
    expect(params('sch-sma-2025', 'SP7', 'learning_list')).toEqual({ learning: true });
    expect(params('sch-sma-2025', 'L9', 'activity_list')).toEqual({ externalLiteracy: true });
    expect(params('sch-sma-2025', 'T4', 'training_recap')).toEqual({ section: 'trainings', window: 'three_periods' });
    expect(params('sch-sma-2025', 'G4', 'report_list')).toEqual({ kinds: ['report_annual', 'report_semester', 'report_quarterly', 'report_monthly'] });
  });
});

describe('the school standards', () => {
  it('fourteen per level, in order, each with its metric, window and rule kind', () => {
    for (const id of SCHOOL) {
      expect(
        instrument(id).snp.map((s) => [s.code, s.metric, s.rule.kind]),
        id,
      ).toEqual([
        ['SNP-S-01', 'collection.titles', 'min'],
        ['SNP-S-02', 'collection.enrichment_fiction_pct', 'ratio_target'],
        ['SNP-S-03', 'collection.enrichment_titles', 'min_by_classes'],
        ['SNP-S-04', 'collection.reference_kinds', 'named_and_min'],
        ['SNP-S-05', 'collection.serial_titles_recent', 'min'],
        ['SNP-S-06', 'collection.title_additions_period_pct', 'min_by_size'],
        ['SNP-S-07', 'registers.stocktake_weeding_3y', 'both_within'],
        ['SNP-S-08', 'period.hours_per_week', 'min'],
        ['SNP-S-09', 'usage.coverage', 'coverage'],
        ['SNP-S-10', 'registers.activities.promotion', 'min'],
        ['SNP-S-11', 'registers.active_staff', 'staff_by_classes'],
        ['SNP-S-12', 'registers.budget_share_year', 'min'],
        ['SNP-S-13', 'usage.reading_interest', 'reported'],
        ['SNP-S-14', null, 'not_available'],
      ]);
    }
    expect(instrument('general-stats').snp).toEqual([]);
  });
});

describe('general-stats', () => {
  it('accepts every library type and level, has no components, no standards and no score', () => {
    const g = instrument('general-stats');
    expect(g.libraryTypes).toEqual([...LIBRARY_TYPES]);
    expect(g.schoolLevels).toEqual([...SCHOOL_LEVELS]);
    expect([g.components, g.snp, g.scored, g.forms]).toEqual([[], [], false, ['profile']]);
  });

  it('measures the collection, usage, staff and profile statistics and the prerequisites', () => {
    expect(GENERAL_STATS_METRICS).toEqual([
      'collection.titles',
      'collection.profile_matrix',
      'collection.ddc_printed_recap',
      'collection.title_additions_3y_pct',
      'collection.undated_items',
      'usage.monthly_series',
      'usage.profile_averages',
      'usage.members_active',
      'registers.active_staff',
      'registers.profile_staff',
      'registers.profile_counts',
      'registers.profile_budget',
      'period.population',
      'period.npp_present',
      'registers.founding_decree_registered',
    ]);
  });
});

describe('instrumentMetricIds', () => {
  it('a school instrument: its indicators’ metrics and size metrics, its standards’ metrics, the class count and the prerequisites, once each', () => {
    const ids = instrumentMetricIds(instrument('sch-sma-2025'));
    expect(new Set(ids).size).toBe(ids.length);
    for (const i of indicators(instrument('sch-sma-2025'))) if (i.metric !== undefined) expect(ids).toContain(i.metric);
    for (const id of [
      'collection.titles_window_start',
      'collection.titles_period_start',
      'period.classes',
      'usage.reading_interest',
      ...PREREQUISITE_METRICS,
    ]) {
      expect(ids).toContain(id);
    }
    for (const id of ids) expect(ACCRED_METRICS[id], id).toBeDefined();
  });

  it('the statistics mode: its own list', () => {
    expect(instrumentMetricIds(instrument('general-stats'))).toEqual([...GENERAL_STATS_METRICS]);
  });
});
