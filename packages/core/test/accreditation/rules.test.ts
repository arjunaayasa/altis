import type { NoteRef } from '@altis/shared/api/accreditation';
import { describe, expect, it } from 'vitest';
import { instrumentById } from '../../src/accreditation/instruments/index.js';
import { evaluateRule, routineFacts, type RoutineSliceCounts } from '../../src/accreditation/scoring/rules.js';
import { suggestAnswer } from '../../src/accreditation/scoring/index.js';
import type { AccredIndicator, AccredInstrument, AccredMetricValue } from '../../src/accreditation/types.js';

// The rule indicators: how the collection is processed (k7), how automated and reachable the library system is (l11),
// the head of library's qualification (t1), the staff roles (t3) and how regularly reports are made (g4). Each rule
// reads the facts of its metric value and gives a letter or no suggestion, with the notes that explain it.

const keys = (notes: readonly NoteRef[]): string[] => notes.map((n) => n.key);
const note = (notes: readonly NoteRef[], key: string): NoteRef | undefined => notes.find((n) => n.key === `accred.note.${key}`);

describe('k7: processing and shelving', () => {
  const k7 = (live: number, processed: number, scanners: number | null, threshold = 100) => evaluateRule('k7', { live, processed, threshold, scanners });

  it('no copy in the collection gives no suggestion', () => {
    const r = k7(0, 0, 2);
    expect(r.suggestion).toBeNull();
    expect(keys(r.notes)).toEqual(['accred.note.collection_empty']);
  });

  it('94 % processed against the threshold of 100 % is a d, with the share and the threshold, but no "almost there"', () => {
    const r = k7(100, 94, 2);
    expect(r.suggestion).toBe('d');
    expect(note(r.notes, 'k7_unprocessed')?.params).toEqual({ pct: 94, threshold: 100 });
    expect(note(r.notes, 'k7_almost')).toBeUndefined();
  });

  it('96 % processed is still a d, now with the hint that the rest is close', () => {
    const r = k7(100, 96, 2);
    expect(r.suggestion).toBe('d');
    expect(keys(r.notes)).toEqual(['accred.note.k7_unprocessed', 'accred.note.k7_almost']);
  });

  it('the share is cut, never rounded up: 199 of 200 copies is 99 %', () => {
    expect(note(k7(200, 199, 2).notes, 'k7_unprocessed')?.params).toEqual({ pct: 99, threshold: 100 });
  });

  it('fully processed: more than one scanner a, one b, none c, unknown no suggestion', () => {
    expect([2, 1, 0].map((s) => k7(1200, 1200, s).suggestion)).toEqual(['a', 'b', 'c']);
    expect(k7(1200, 1200, 5).suggestion).toBe('a');
    const unknown = k7(1200, 1200, null);
    expect(unknown.suggestion).toBeNull();
    expect(note(unknown.notes, 'input_missing')?.params).toEqual({ field: 'jumlah pemindai barkod' });
  });

  it('a lowered threshold is compared exactly and always noted', () => {
    const r = k7(1000, 900, 1, 90);
    expect(r.suggestion).toBe('b');
    expect(note(r.notes, 'k7_threshold_lowered')?.params).toEqual({ threshold: 90 });
    expect(k7(1000, 899, 1, 90).suggestion).toBe('d');
    expect(note(k7(1200, 1200, 1).notes, 'k7_threshold_lowered')).toBeUndefined();
  });

  it('a value without its facts gives no suggestion', () => {
    expect(evaluateRule('k7', {}).suggestion).toBeNull();
  });
});

describe('l11: automation and reach', () => {
  const l11 = (cls: string, o: { membersUsed?: boolean | null; circulationUsed?: boolean | null } = {}) =>
    evaluateRule('l11', { class: cls, membersUsed: o.membersUsed ?? null, circulationUsed: o.circulationUsed ?? null });

  it('an address that is not set gives no suggestion', () => {
    const r = l11('unset');
    expect(r.suggestion).toBeNull();
    expect(keys(r.notes)).toEqual(['accred.note.base_url_unset']);
  });

  it('public a, private b, localhost c, each noting that membership and loans are not checked yet', () => {
    const pub = l11('public');
    expect(pub.suggestion).toBe('a');
    expect(keys(pub.notes)).toEqual(['accred.note.l11_unverified']);
    const priv = l11('private');
    expect(priv.suggestion).toBe('b');
    expect(keys(priv.notes)).toEqual(['accred.note.l11_private', 'accred.note.l11_unverified']);
    const local = l11('localhost');
    expect(local.suggestion).toBe('c');
    expect(keys(local.notes)).toEqual(['accred.note.l11_localhost', 'accred.note.l11_unverified']);
  });

  it('a public system whose members and circulation are in use is an a without the reservation', () => {
    const r = l11('public', { membersUsed: true, circulationUsed: true });
    expect(r.suggestion).toBe('a');
    expect(r.notes).toEqual([]);
    expect(keys(l11('public', { membersUsed: true, circulationUsed: false }).notes)).toEqual(['accred.note.l11_unverified']);
    expect(keys(l11('private', { membersUsed: true, circulationUsed: true }).notes)).toContain('accred.note.l11_unverified');
  });

  it('the manual answer d is never suggested', () => {
    for (const cls of ['public', 'private', 'localhost', 'unset', 'other']) expect(l11(cls).suggestion).not.toBe('d');
    expect(l11('other').suggestion).toBeNull();
  });
});

describe('t1: the head of library', () => {
  const t1 = (educationLevel: string | null, educationLibrary: boolean, libraryTraining: boolean, heads = 1) =>
    evaluateRule('t1', { educationLevel, educationLibrary, libraryTraining, heads });

  it('a bachelor or master in library science is an a, with or without training', () => {
    for (const level of ['s1', 's2']) {
      expect(t1(level, true, false).suggestion, level).toBe('a');
      expect(t1(level, true, true).suggestion, level).toBe('a');
    }
  });

  it('a bachelor or master in another field is a b with library training, else a d', () => {
    for (const level of ['s1', 's2']) {
      expect(t1(level, false, true).suggestion, level).toBe('b');
      expect(t1(level, false, false).suggestion, level).toBe('d');
      expect(t1(level, false, true).notes, level).toEqual([]);
    }
  });

  it('a four-year diploma counts as a bachelor and a doctorate as a master, and says so', () => {
    for (const level of ['d4', 's3']) {
      expect(t1(level, true, false).suggestion, level).toBe('a');
      expect(t1(level, false, true).suggestion, level).toBe('b');
      expect(t1(level, false, false).suggestion, level).toBe('d');
      expect(keys(t1(level, false, true).notes), level).toEqual(['accred.note.t1_equivalence']);
    }
  });

  it('a three-year diploma is a c in library science or with training, else a d', () => {
    expect(t1('d3', true, false).suggestion).toBe('c');
    expect(t1('d3', false, true).suggestion).toBe('c');
    expect(t1('d3', false, false).suggestion).toBe('d');
  });

  it('a lower or other education is a d whatever the training', () => {
    for (const level of ['sma', 'd1', 'd2', 'other']) {
      expect(t1(level, true, true).suggestion, level).toBe('d');
      expect(t1(level, false, false).suggestion, level).toBe('d');
    }
  });

  it('an unknown education gives no suggestion and asks for it', () => {
    const r = t1(null, true, true);
    expect(r.suggestion).toBeNull();
    expect(note(r.notes, 'input_missing')?.params).toEqual({ field: 'pendidikan kepala perpustakaan' });
  });

  it('no head gives no suggestion; more than one is noted', () => {
    const none = t1(null, false, false, 0);
    expect(none.suggestion).toBeNull();
    expect(keys(none.notes)).toEqual(['accred.note.head_missing']);
    const two = t1('s1', true, false, 2);
    expect(two.suggestion).toBe('a');
    expect(keys(two.notes)).toEqual(['accred.note.head_multiple']);
  });
});

describe('t3: librarians, ICT and technical staff', () => {
  const t3 = (librarians: number, ict: number, technical: number, technicalCertified: number) =>
    evaluateRule('t3', { librarians, ict, technical, technicalCertified });

  it('a librarian, ICT staff and technical staff together are an a', () => {
    expect(t3(1, 1, 1, 0).suggestion).toBe('a');
  });

  it('a librarian and technical staff are a b', () => {
    expect(t3(2, 0, 1, 0).suggestion).toBe('b');
  });

  it('certified technical staff without a librarian are a c', () => {
    expect(t3(0, 1, 2, 1).suggestion).toBe('c');
  });

  it('every other combination is a d: uncertified technical staff, a librarian alone, a librarian with ICT staff', () => {
    expect(t3(0, 0, 1, 0).suggestion).toBe('d');
    expect(t3(1, 0, 0, 0).suggestion).toBe('d');
    expect(t3(1, 1, 0, 0).suggestion).toBe('d');
  });

  it('no active staff gives no suggestion', () => {
    const r = evaluateRule('t3', {});
    expect(r.suggestion).toBeNull();
    expect(keys(r.notes)).toEqual(['accred.note.staff_missing']);
    expect(evaluateRule('t3', { librarians: 0, ict: 0, technical: 0, technicalCertified: 0, active: 0 }).suggestion).toBeNull();
  });
});

describe('g4: regular reports over three years', () => {
  const slice = (annual: number, semester = 0, quarterly = 0, monthly = 0): RoutineSliceCounts => ({ annual, semester, quarterly, monthly });
  const g4 = (a: RoutineSliceCounts, b: RoutineSliceCounts, c: RoutineSliceCounts, undated = 0) => evaluateRule('g4', routineFacts([a, b, c], undated));

  it('an annual report missing in the middle year is a d', () => {
    expect(g4(slice(1, 2), slice(0, 2), slice(1, 2)).suggestion).toBe('d');
  });

  it('annual and semester reports every year are a b', () => {
    expect(g4(slice(1, 2), slice(1, 2), slice(1, 3)).suggestion).toBe('b');
  });

  it('annual, semester and ten monthly reports in each year are an a', () => {
    expect(g4(slice(1, 2, 0, 10), slice(1, 2, 0, 10), slice(1, 2, 0, 12)).suggestion).toBe('a');
  });

  it('annual reports only are a c', () => {
    expect(g4(slice(1), slice(2), slice(1)).suggestion).toBe('c');
  });

  it('four quarterly reports each year make the periodic kind; quarterly and monthly reports are not added up', () => {
    expect(g4(slice(1, 0, 4), slice(1, 0, 4), slice(1, 0, 4)).suggestion).toBe('b');
    expect(g4(slice(1, 0, 3, 9), slice(1, 0, 4), slice(1, 0, 4)).suggestion).toBe('c');
    expect(g4(slice(1, 2, 4), slice(1, 1, 4), slice(1, 2, 4)).suggestion).toBe('b');
  });

  it('always prints the rule and counts the undated report documents', () => {
    const r = g4(slice(1), slice(1), slice(1), 3);
    expect(note(r.notes, 'g4_undated')?.params).toEqual({ count: 3 });
    expect(note(g4(slice(1), slice(1), slice(1)).notes, 'g4_undated')).toBeUndefined();
  });

  it('a value without its slices gives no suggestion', () => {
    expect(evaluateRule('g4', {}).suggestion).toBeNull();
  });
});

describe('the rule indicators of the school instruments', () => {
  const sma = instrumentById('sch-sma-2025') as AccredInstrument;
  const ik = (code: string): AccredIndicator => sma.components.flatMap((c) => c.indicators).find((i) => i.code === code)!;
  const value = (facts: AccredMetricValue['facts'], v: number | null = 1): AccredMetricValue => ({ value: v, unit: 'code', basis: 'live', notes: [], facts });

  it('K7, L11, T1, T3 and G4 suggest through their rules', () => {
    expect(suggestAnswer(ik('K7'), { ...value({ live: 1200, processed: 1200, threshold: 100, scanners: 2 }), value: 100, unit: 'percent' }, null).suggestion).toBe('a');
    expect(suggestAnswer(ik('L11'), value({ class: 'public', membersUsed: null, circulationUsed: null }), null).suggestion).toBe('a');
    expect(suggestAnswer(ik('T1'), value({ educationLevel: 's1', educationLibrary: false, libraryTraining: true, heads: 1 }), null).suggestion).toBe('b');
    expect(suggestAnswer(ik('T3'), value({ librarians: 1, ict: 0, technical: 1, technicalCertified: 1 }), null).suggestion).toBe('b');
    const g4 = routineFacts([
      { annual: 1, semester: 2, quarterly: 3, monthly: 0 },
      { annual: 1, semester: 2, quarterly: 3, monthly: 0 },
      { annual: 1, semester: 2, quarterly: 3, monthly: 0 },
    ]);
    const r = suggestAnswer(ik('G4'), value(g4), null);
    expect(r.suggestion).toBe('b');
    expect(keys(r.notes)).toContain('accred.note.g4_rule');
  });

  it('a rule value without data gives no suggestion, and a note the provider already gave is not repeated', () => {
    const empty: AccredMetricValue = { value: null, unit: 'code', basis: 'register', notes: [{ key: 'accred.note.staff_missing' }] };
    const r = suggestAnswer(ik('T3'), empty, null);
    expect(r.suggestion).toBeNull();
    expect(keys(r.notes)).not.toContain('accred.note.staff_missing');
    const l11 = suggestAnswer(ik('L11'), { ...value({ class: 'public', membersUsed: null, circulationUsed: null }), notes: [{ key: 'accred.note.l11_unverified' }] }, null);
    expect(l11.suggestion).toBe('a');
    expect(keys(l11.notes)).not.toContain('accred.note.l11_unverified');
  });
});
