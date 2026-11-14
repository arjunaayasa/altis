import { MESSAGES } from '@altis/shared';
import { describe, expect, it } from 'vitest';
import { ACCRED_METRICS, ACCRED_PROVIDER_IDS, metricsOfProvider, type AccredMetricId } from '../../src/accreditation/metric-ids.js';
import { ACCRED_NOTE_IN_DOSSIER, ACCRED_NOTE_KEYS } from '../../src/accreditation/notes.js';
import { ACCRED_METRIC_PROVIDERS } from '../../src/accreditation/providers/index.js';
import type { AccredMetricContext, AccredWindow } from '../../src/accreditation/types.js';
import { USAGE_SOURCES } from '../../src/accreditation/usage-sources.js';

// The metric catalogue (each metric's provider, unit and its one window), the providers that compute them, and the
// note catalogue with the notes the evidence file never prints (the ones about the answer itself).

const WINDOWS: readonly AccredWindow[] = [
  'snapshot',
  'current',
  'period',
  'three_periods',
  'three_calendar_years',
  'budget_years',
  'twelve_months',
  'three_years',
  'period_and_previous',
];

const ids = Object.keys(ACCRED_METRICS) as AccredMetricId[];

describe('ACCRED_METRICS', () => {
  it('every metric has one of the five providers, a unit and exactly one window', () => {
    expect(ACCRED_PROVIDER_IDS).toEqual(['collection', 'registers', 'period', 'system', 'usage']);
    for (const id of ids) {
      const m = ACCRED_METRICS[id];
      expect(ACCRED_PROVIDER_IDS, id).toContain(m.provider);
      expect(['count', 'percent', 'ratio', 'mbps', 'years', 'code'], id).toContain(m.unit);
      expect(WINDOWS, id).toContain(m.window);
      expect(Object.keys(m).sort(), id).toEqual(['provider', 'unit', 'window']);
    }
    expect(new Set(ids).size).toBe(ids.length);
  });

  it('each id starts with its provider, but the share of the collection used, whose base is the stock', () => {
    for (const id of ids) {
      if (id === 'usage.collection_used_pct') expect(ACCRED_METRICS[id].provider).toBe('collection');
      else expect(id.split('.')[0], id).toBe(ACCRED_METRICS[id].provider);
    }
    expect(Object.fromEntries(ACCRED_PROVIDER_IDS.map((p) => [p, metricsOfProvider(p).length]))).toEqual({
      collection: 17,
      registers: 32,
      period: 11,
      system: 3,
      usage: 7,
    });
  });

  it('the windows of the metrics whose definition names none or several', () => {
    const windowOf = (id: AccredMetricId): AccredWindow => ACCRED_METRICS[id].window;
    expect(windowOf('registers.budget_share_year')).toBe('budget_years');
    expect(windowOf('registers.budget_share_3y')).toBe('budget_years');
    expect(windowOf('registers.profile_budget')).toBe('budget_years');
    expect(windowOf('registers.profile_counts')).toBe('period');
    expect(windowOf('registers.founding_decree_registered')).toBe('current');
    expect(windowOf('collection.serial_titles_recent')).toBe('twelve_months');
    expect(windowOf('registers.stocktake_weeding_3y')).toBe('three_years');
    expect(windowOf('usage.reading_interest')).toBe('period_and_previous');
    for (const id of ids.filter((i) => i.startsWith('period.') || i.startsWith('system.'))) expect(windowOf(id), id).toBe('current');
  });
});

describe('the metric providers', () => {
  it('the five providers in order, each computing exactly the metrics of its id', () => {
    expect(ACCRED_METRIC_PROVIDERS.map((p) => p.id)).toEqual(['collection', 'registers', 'period', 'system', 'usage']);
    for (const p of ACCRED_METRIC_PROVIDERS) expect([...p.metrics], p.id).toEqual(ids.filter((id) => ACCRED_METRICS[id].provider === p.id));
    const all = ACCRED_METRIC_PROVIDERS.flatMap((p) => [...p.metrics]);
    expect([...all].sort()).toEqual([...ids].sort());
  });

  it('a provider not written yet answers no value at once', async () => {
    const ctx = {} as AccredMetricContext;
    const written = new Set(['registers', 'period', 'system', 'usage']);
    for (const p of ACCRED_METRIC_PROVIDERS.filter((q) => !written.has(q.id))) {
      const step = await p.compute(ctx, p.metrics, null);
      expect(step.done, p.id).toBe(true);
      if (step.done) expect(step.values.size, p.id).toBe(0);
    }
  });

  it('no live usage source in this milestone', () => {
    expect(USAGE_SOURCES).toEqual([]);
    expect(Object.isFrozen(USAGE_SOURCES)).toBe(true);
  });
});

describe('the note catalogue', () => {
  const ANSWER_NOTES = [
    'mandatory_missing',
    'register_empty',
    'k2_overlap',
    'undated_share_high',
    'k7_unprocessed',
    'l3_sd_option_d',
    'l6_manual',
    'l11_unverified',
    'sp1_floor',
    'sp3_mandatory_hint',
  ].map((k) => `accred.note.${k}`);

  it('holds every indicator and standard note of the shared messages, each once', () => {
    const workspace = new Set(['accred.note.catalogue_synced', 'accred.note.recompute_after_catalogue']);
    const notes = Object.keys(MESSAGES.id).filter((k) => k.startsWith('accred.note.') && !workspace.has(k));
    expect([...ACCRED_NOTE_KEYS].sort()).toEqual(notes.sort());
    expect(new Set(ACCRED_NOTE_KEYS).size).toBe(ACCRED_NOTE_KEYS.length);
  });

  it('the evidence file prints every note but the ten that state, suggest or ask for an answer', () => {
    expect(Object.keys(ACCRED_NOTE_IN_DOSSIER).sort()).toEqual([...ACCRED_NOTE_KEYS].sort());
    expect(ACCRED_NOTE_KEYS.filter((k) => !ACCRED_NOTE_IN_DOSSIER[k]).sort()).toEqual([...ANSWER_NOTES].sort());
    for (const k of ACCRED_NOTE_KEYS) expect(typeof ACCRED_NOTE_IN_DOSSIER[k], k).toBe('boolean');
    expect(ACCRED_NOTE_IN_DOSSIER['accred.note.truncated']).toBe(true);
    expect(ACCRED_NOTE_IN_DOSSIER['accred.note.snp_selected']).toBe(true);
  });
});
