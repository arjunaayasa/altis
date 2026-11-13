import { describe, expect, it } from 'vitest';
import {
  aggregateMonth,
  countVisit,
  emptyCounts,
  markRepeats,
  secondOfMonth,
  type MemberInfo,
  type MonthEntry,
  type RowContext,
  type UsageCounts,
} from '../../src/accreditation/slims-usage/count.js';

// The repeat-visit rule of the SLiMS usage import, over its aggregate step: a member's check-in is a repeat when the
// same member's previous check-in, kept or not, lies less than the window before it, with no reset at a month's end;
// a window of 0 keeps every check-in; a guest's visit is never a repeat.

const A = 'a'.repeat(32);
const B = 'b'.repeat(32);
const MEMBERS: ReadonlyMap<string, MemberInfo> = new Map([
  [A, { type: '1', expire: '2030-12-31' }],
  [B, { type: '2', expire: '2030-12-31' }],
]);
const SPANS = [
  { from: '2024-01-01', to: '2024-12-31' },
  { from: '2025-01-01', to: '2025-12-31' },
  { from: '2026-01-01', to: '2026-12-31' },
];

const at = (hash: string, text: string): MonthEntry => ({ hash, second: secondOfMonth(text) });

/** The aggregate step of `month` over `visits`, with what the month before carried; the counts and the carry out. */
function step(counts: UsageCounts, month: string, visits: MonthEntry[], dedupeMinutes: number, carryIn: ReadonlyMap<string, number> = new Map()): Map<string, number> {
  return aggregateMonth(counts, {
    month,
    visits,
    borrows: [],
    carryIn,
    dedupeMinutes,
    members: MEMBERS,
    spans: SPANS,
    spanVisitors: [new Set(), new Set(), new Set()],
    spanBorrowers: [new Set(), new Set(), new Set()],
  });
}

const cell = (counts: UsageCounts, month: string, metric: string, group: string): number => counts.monthly[month]?.[metric]?.[group] ?? 0;

describe('the repeat-visit rule of the aggregate step', () => {
  it('check-ins at 0, 50 and 100 minutes with a 60-minute window: one kept (each is compared with the one before it, kept or not)', () => {
    const counts = emptyCounts();
    step(counts, '2026-03', [at(A, '2026-03-02 08:00:00'), at(A, '2026-03-02 08:50:00'), at(A, '2026-03-02 09:40:00')], 60);
    expect(cell(counts, '2026-03', 'visits', 'slims_type:1')).toBe(3);
    expect(cell(counts, '2026-03', 'visits_deduped', 'slims_type:1')).toBe(1);
    expect(cell(counts, '2026-03', 'visits_deduped', '')).toBe(1);
  });

  it('check-ins exactly 60 minutes apart with a 60-minute window: both kept', () => {
    const counts = emptyCounts();
    step(counts, '2026-03', [at(A, '2026-03-02 08:00:00'), at(A, '2026-03-02 09:00:00')], 60);
    expect(cell(counts, '2026-03', 'visits_deduped', 'slims_type:1')).toBe(2);
  });

  it('a pair 20 minutes apart across a month boundary (23:50 and 00:10): one kept, the month before carrying its last check-in in', () => {
    const counts = emptyCounts();
    const carry = step(counts, '2026-01', [at(A, '2026-01-31 23:50:00'), at(B, '2026-01-31 10:00:00')], 60);
    expect([...carry]).toEqual([[A, -600]]);
    step(counts, '2026-02', [at(A, '2026-02-01 00:10:00')], 60, carry);
    expect(cell(counts, '2026-01', 'visits_deduped', 'slims_type:1') + cell(counts, '2026-02', 'visits_deduped', 'slims_type:1')).toBe(1);
    expect(cell(counts, '2026-02', 'visits', 'slims_type:1')).toBe(1);
    expect(cell(counts, '2026-02', 'visits_deduped', 'slims_type:1')).toBe(0);
  });

  it('a window of 0 keeps every check-in: deduplicated visits equal the raw visits, and nothing is carried', () => {
    const counts = emptyCounts();
    const visits = [at(A, '2026-03-02 08:00:00'), at(A, '2026-03-02 08:00:00'), at(A, '2026-03-02 08:50:00'), at(B, '2026-03-31 23:59:00')];
    const carry = step(counts, '2026-03', visits, 0);
    expect(carry.size).toBe(0);
    expect(counts.monthly['2026-03']!['visits_deduped']).toEqual(counts.monthly['2026-03']!['visits']);
    expect(cell(counts, '2026-03', 'visits', '')).toBe(4);
  });

  it('identical check-ins: the first is kept; a member without a type counts as a member SLiMS no longer has', () => {
    const counts = emptyCounts();
    const gone = 'c'.repeat(32);
    step(counts, '2026-03', [at(A, '2026-03-02 08:00:00'), at(A, '2026-03-02 08:00:00'), at(gone, '2026-03-02 08:00:00')], 60);
    expect(cell(counts, '2026-03', 'visits_deduped', 'slims_type:1')).toBe(1);
    expect(cell(counts, '2026-03', 'visits', 'member_unknown')).toBe(1);
    expect(cell(counts, '2026-03', 'distinct_visitors', '')).toBe(2);
    expect(counts.memberUnknown.visits).toBe(1);
  });

  it('sorts by member and time whatever order the check-ins come in', () => {
    const { kept } = markRepeats([at(A, '2026-03-02 09:40:00'), at(A, '2026-03-02 08:00:00'), at(A, '2026-03-02 08:50:00')], new Map(), 3600);
    expect(kept).toEqual([true, false, false]);
  });

  it('a guest\'s visits are never repeats: every one counts raw and deduplicated', () => {
    const counts = emptyCounts();
    const c: RowContext = {
      counts,
      cutoverOn: null,
      spans: SPANS,
      members: MEMBERS,
      items: new Map(),
      titles: new Map(),
      seenLoans: new Set(),
      types: {},
      addMember: () => undefined,
      addItem: () => undefined,
      addTitle: () => undefined,
      addLoanId: () => undefined,
      entry: () => {
        throw new Error('a guest visit never waits for the aggregate step');
      },
      used: () => undefined,
    };
    for (const memberId of ['', null, '']) countVisit(c, { member_id: memberId, checkin_date: '2026-03-02 08:00:00' });
    expect(cell(counts, '2026-03', 'visits', 'guest')).toBe(3);
    expect(cell(counts, '2026-03', 'visits_deduped', 'guest')).toBe(3);
    expect(cell(counts, '2026-03', 'visits_deduped', '')).toBe(3);
    expect(counts.monthly['2026-03']!['distinct_visitors']).toBeUndefined();
  });
});
