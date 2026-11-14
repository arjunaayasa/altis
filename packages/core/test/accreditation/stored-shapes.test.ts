import { newId } from '@altis/shared';
import { describe, expect, it } from 'vitest';
import { slimsUsageRunSettings } from '../../src/accreditation/slims-usage/settings.js';
import { AccredMetaPayload, AccredResultPayload, AccredStoredValue } from '../../src/accreditation/types.js';

// The shapes the accreditation code stores as JSON and parses on every read: a result row's payload (an indicator, a
// standard or the prerequisites), a period's `_meta` row, and the options of a SLiMS usage import's run.

const value = {
  value: 42,
  numerator: 420,
  denominator: 1000,
  unit: 'percent',
  basis: 'live',
  notes: [{ key: 'accred.note.truncated' }, { key: 'accred.note.k6_tier', params: { count: 1200 } }],
  detail: { reportId: 'accreditation.annex.additions', params: { periodId: newId() } },
  table: [
    [2024, 40],
    [2025, 60],
  ],
};

const prerequisites = { titles: { pass: true, count: 1530, asOf: '2026-06-30' }, npp: { pass: true }, foundingDecree: { pass: false }, met: false };

describe('AccredResultPayload', () => {
  it('round-trips one payload of each kind', () => {
    const payloads = [
      { kind: 'indicator', metric: 'collection.title_additions_3y_pct', value, size: { value: 1200, unit: 'count', basis: 'live', notes: [] }, suggestion: 'b', notes: [] },
      { kind: 'indicator', metric: null, value: null, size: null, suggestion: null, notes: [{ key: 'accred.note.sp1_floor', params: { m2: 96 } }] },
      { kind: 'snp', metric: 'collection.titles', value: { value: 1530, unit: 'count', basis: 'live', notes: [] }, outcome: 'pass', rule: 'min', notes: [] },
      { kind: 'prerequisites', prerequisites, titles: { value: 1530, unit: 'count', basis: 'live', notes: [], suggest: false } },
    ];
    for (const p of payloads) expect(AccredResultPayload.parse(JSON.parse(JSON.stringify(p)))).toEqual(p);
  });

  it('refuses an unknown kind, a value with facts (never stored) and an unknown outcome', () => {
    expect(AccredResultPayload.safeParse({ kind: 'score', notes: [] }).success).toBe(false);
    expect(AccredStoredValue.safeParse({ ...value, facts: { live: 3 } }).success).toBe(false);
    expect(AccredStoredValue.safeParse({ ...value, tableTruncated: true }).success).toBe(true);
    expect(AccredResultPayload.safeParse({ kind: 'snp', metric: null, value: null, outcome: 'maybe', rule: 'min', notes: [] }).success).toBe(false);
  });
});

describe('AccredMetaPayload', () => {
  it('running, then ready with its computed time, duration and prerequisites', () => {
    const jobId = newId();
    expect(AccredMetaPayload.parse({ status: 'running', startedAt: 1, jobId })).toEqual({ status: 'running', startedAt: 1, jobId });
    const ready = { status: 'ready', startedAt: 1, jobId, computedAt: 1, durationMs: 900, prerequisites };
    expect(AccredMetaPayload.parse(ready)).toEqual(ready);
    expect(AccredMetaPayload.safeParse({ status: 'queued', startedAt: 1, jobId }).success).toBe(false);
  });
});

describe('slimsUsageRunSettings', () => {
  it('parses the stored options of an import, a repeat window of 0 included', () => {
    const stored = JSON.stringify({ sourceKind: 'dump', periodId: newId(), cutoverOn: null, memberTypeGroups: { '1': 'student', '7': null }, unknownMemberGroup: 'other', dedupeMinutes: 0 });
    expect(slimsUsageRunSettings.parse(JSON.parse(stored))).toEqual(JSON.parse(stored));
    expect(slimsUsageRunSettings.parse({ sourceKind: 'db', periodId: newId(), cutoverOn: '2026-07-01', dedupeMinutes: 60 })).toMatchObject({ dedupeMinutes: 60 });
  });

  it('refuses a window over 720 minutes, an unknown key and a missing cut-over field', () => {
    const base = { sourceKind: 'db', periodId: newId(), cutoverOn: null, dedupeMinutes: 60 };
    expect(slimsUsageRunSettings.safeParse({ ...base, dedupeMinutes: 721 }).success).toBe(false);
    expect(slimsUsageRunSettings.safeParse({ ...base, password: 'x' }).success).toBe(false);
    expect(slimsUsageRunSettings.safeParse({ sourceKind: 'db', periodId: newId(), dedupeMinutes: 60 }).success).toBe(false);
  });
});
