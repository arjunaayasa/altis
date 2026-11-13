import { readFileSync } from 'node:fs';
import { MESSAGES } from '@altis/shared';
import { describe, expect, it } from 'vitest';
import {
  GENERAL_STATS_HEADER,
  SCH_SD_2025_HEADER,
  SCH_SMA_2025_HEADER,
  SCH_SMP_2025_HEADER,
} from '../../src/accreditation/instruments/headers.js';
import { ACCRED_INSTRUMENTS, instrumentById } from '../../src/accreditation/instruments/index.js';
import { TEST_INSTRUMENTS } from '../../src/accreditation/instruments/test-instrument.js';
import { ACCRED_METRICS } from '../../src/accreditation/metric-ids.js';
import { ACCRED_NOTE_KEYS } from '../../src/accreditation/notes.js';
import type { AccredInstrument } from '../../src/accreditation/types.js';
import { REPORTS } from '../../src/reports/registry.js';

// The instruments of this build: the four headers (the three school instruments of 2025 and the statistics mode), still
// without indicators, and under the test profile `test-sch`, a scored school instrument with four real indicators of
// the school instruments (K1, K2, K3 and SP1), on which periods, answers and evidence are tested.

const MESSAGE_KEYS = new Set(Object.keys(MESSAGES.id));
const REPORT_IDS = new Set(REPORTS.map((d) => d.id));

describe('ACCRED_INSTRUMENTS', () => {
  it('the four headers in order, then the test instrument; each found by its id', () => {
    expect(ACCRED_INSTRUMENTS.map((i) => i.id)).toEqual(['sch-sd-2025', 'sch-smp-2025', 'sch-sma-2025', 'general-stats', 'test-sch']);
    for (const i of ACCRED_INSTRUMENTS) expect(instrumentById(i.id)).toBe(i);
    expect(instrumentById('sch-sma-2022')).toBeNull();
    for (const i of ACCRED_INSTRUMENTS.slice(0, 4)) expect([i.components, i.snp], i.id).toEqual([[], []]);
  });

  it('the school headers: the decree, the day they apply from, one level each, two period kinds, every form, scored', () => {
    const levels = [
      [SCH_SD_2025_HEADER, 'Kepka Perpusnas 157/2025', 'sd_mi'],
      [SCH_SMP_2025_HEADER, 'Kepka Perpusnas 158/2025', 'smp_mts'],
      [SCH_SMA_2025_HEADER, 'Kepka Perpusnas 159/2025', 'sma_smk_ma'],
    ] as const;
    for (const [h, decree, level] of levels) {
      expect(h, h.id).toMatchObject({
        decree,
        effectiveFrom: '2026-01-02',
        sourceStatus: 'P-copy',
        libraryTypes: ['sekolah'],
        schoolLevels: [level],
        periodKinds: ['school_year', 'rolling_12'],
        forms: ['submission', 'profile', 'certificate_name'],
        scored: true,
      });
      expect(h.decreeTitle, h.id).toContain(decree.slice(-8, -5));
      expect(h.defaultPeriodKind({ libraryType: 'sekolah', schoolLevel: level })).toBe('school_year');
    }
  });

  it('general-stats: every library type and level, every kind, a school year for a school and else a calendar year', () => {
    expect(GENERAL_STATS_HEADER).toMatchObject({
      decree: 'Peraturan Perpusnas 2/2022',
      sourceStatus: 'P',
      libraryTypes: ['sekolah', 'perguruan_tinggi', 'umum', 'khusus'],
      schoolLevels: ['sd_mi', 'smp_mts', 'sma_smk_ma', 'slb', 'paud'],
      periodKinds: ['school_year', 'calendar_year', 'rolling_12', 'custom'],
      forms: ['profile'],
      scored: false,
    });
    expect(GENERAL_STATS_HEADER.defaultPeriodKind({ libraryType: 'sekolah', schoolLevel: 'slb' })).toBe('school_year');
    expect(GENERAL_STATS_HEADER.defaultPeriodKind({ libraryType: 'umum', schoolLevel: null })).toBe('calendar_year');
    expect(GENERAL_STATS_HEADER.defaultPeriodKind({ libraryType: null, schoolLevel: null })).toBe('calendar_year');
  });

  it('the test instrument is spread under the same test-profile guard as the test reports', () => {
    const guard = (list: string) => `...(typeof __BUILD_PROFILE__ !== 'undefined' && __BUILD_PROFILE__ === 'test' ? ${list} : [])`;
    const instruments = readFileSync(new URL('../../src/accreditation/instruments/index.ts', import.meta.url), 'utf8');
    const reports = readFileSync(new URL('../../src/reports/registry.ts', import.meta.url), 'utf8');
    expect(instruments).toContain(guard('TEST_INSTRUMENTS'));
    expect(reports).toContain(guard('TEST_REPORTS'));
    expect(ACCRED_INSTRUMENTS.slice(-1)).toEqual(TEST_INSTRUMENTS);
  });
});

describe('test-sch', () => {
  const sch = instrumentById('test-sch') as AccredInstrument;
  const indicators = sch.components.flatMap((c) => c.indicators);

  it('is a scored upper secondary school instrument with K (K1, K2, K3) at 60 and SP (SP1) at 40', () => {
    expect(sch).toMatchObject({
      libraryTypes: ['sekolah'],
      schoolLevels: ['sma_smk_ma'],
      periodKinds: ['school_year', 'rolling_12'],
      forms: ['submission', 'profile', 'certificate_name'],
      scored: true,
      snp: [],
    });
    expect(sch.components.map((c) => [c.code, c.weight, c.indicators.map((i) => i.code)])).toEqual([
      ['K', 60, ['K1', 'K2', 'K3']],
      ['SP', 40, ['SP1']],
    ]);
    expect(sch.components.reduce((sum, c) => sum + c.weight, 0)).toBe(100);
    expect(sch.defaultPeriodKind({ libraryType: 'sekolah', schoolLevel: 'sma_smk_ma' })).toBe('school_year');
  });

  it('carries the metrics, windows and bands of the upper secondary instrument', () => {
    const k = (code: string) => indicators.find((i) => i.code === code)!;
    expect([k('K1').metric, k('K1').window, k('K1').band]).toEqual([
      'collection.titles',
      'snapshot',
      { kind: 'range', bands: [{ answer: 'a', min: 1501 }, { answer: 'b', min: 1001, max: 1500 }, { answer: 'c', min: 1000, max: 1000 }, { answer: 'd' }] },
    ]);
    expect([k('K2').metric, k('K2').window, k('K2').band]).toEqual([
      'collection.fiction_pct',
      'snapshot',
      { kind: 'range', bands: [{ answer: 'a', min: 25, max: 25 }, { answer: 'b', min: 11, max: 25 }, { answer: 'c', min: 10, max: 10 }, { answer: 'd' }] },
    ]);
    expect([k('K3').metric, k('K3').window, k('K3').band, k('K3').mandatory]).toEqual([
      'registers.collection_policy_aspects',
      'current',
      { kind: 'range', bands: [{ answer: 'a', min: 7 }, { answer: 'b', min: 6, max: 6 }, { answer: 'c', min: 5, max: 5 }, { answer: 'd' }] },
      ['a1', 'a2', 'a3', 'a4', 'a5'],
    ]);
    expect([k('SP1').metric, k('SP1').window, k('SP1').band, k('SP1').optionKeys]).toEqual([
      undefined,
      'current',
      { kind: 'manual' },
      ['accred.ik.SP1.option.a', 'accred.ik.SP1.option.b', 'accred.ik.SP1.option.c', 'accred.ik.SP1.option.d'],
    ]);
  });

  it('carries the evidence lists of the school instruments: codes, kinds, the primary item and the generated reports', () => {
    const evidence = Object.fromEntries(indicators.map((i) => [i.code, i.evidence.map((e) => [e.code, e.kind, e.primary === true, e.reportId ?? null])]));
    expect(evidence).toEqual({
      K1: [
        ['title_list', 'generated', true, 'collection.title_list'],
        ['catalogue_screenshot', 'screenshot', false, null],
        ['ddc_recap', 'generated', false, 'accreditation.annex.ddc'],
      ],
      K2: [
        ['fiction_list', 'generated', true, 'collection.title_list'],
        ['fiction_screenshot', 'screenshot', false, null],
      ],
      K3: [['policy_document', 'signed_document', true, null]],
      SP1: [
        ['floor_plan', 'upload', true, null],
        ['room_photos', 'photo', false, null],
      ],
    });
  });

  it('holds the invariants of every instrument: labels, actions, options and notes are messages, generated evidence names a report', () => {
    const missing: string[] = [];
    const need = (key: string): void => {
      if (!MESSAGE_KEYS.has(key)) missing.push(key);
    };
    for (const c of sch.components) need(c.labelKey);
    for (const i of indicators) {
      expect(i.labelKey).toBe(`accred.ik.${i.code}`);
      expect(i.actionKey).toBe(`accred.gap.action.${i.code}`);
      need(i.labelKey);
      need(i.actionKey);
      for (const o of i.optionKeys ?? []) need(o);
      for (const n of i.noteKeys ?? []) expect(ACCRED_NOTE_KEYS, i.code).toContain(n);
      expect(i.evidence.length, i.code).toBeGreaterThan(0);
      expect(i.evidence.filter((e) => e.primary === true).length, i.code).toBeGreaterThan(0);
      for (const e of i.evidence) {
        expect(e.labelKey).toBe(`accred.evidence.${i.code}.${e.code}`);
        need(e.labelKey);
        if (e.kind === 'generated') expect(REPORT_IDS, `${i.code}.${e.code}`).toContain(e.reportId);
        else expect(e.reportId, `${i.code}.${e.code}`).toBeUndefined();
      }
      if (i.metric !== undefined) expect(i.window, i.code).toBe(ACCRED_METRICS[i.metric].window);
      if (i.band.kind === 'manual') expect(i.optionKeys, i.code).toHaveLength(4);
      expect(i.officialNo).toBe(i.code);
    }
    expect(missing).toEqual([]);
  });
});
