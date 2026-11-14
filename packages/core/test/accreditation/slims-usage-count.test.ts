import { describe, expect, it } from 'vitest';
import {
  aggregateMonth,
  countMember,
  countVisit,
  emptyCounts,
  type MemberInfo,
  type MonthEntry,
  type RowContext,
  type UsageCounts,
} from '../../src/accreditation/slims-usage/count.js';
import { usageRowTransform } from '../../src/migration/slims/source/usage.js';

// The row rules of the SLiMS usage import over rows as its readers leave them (columns projected, member ids hashed):
// one member whose id SLiMS stores in two cases is one member, as SLiMS's own tables compare ids.

const KEY = Uint8Array.from({ length: 32 }, (_, i) => i + 7);
const SPANS = [{ from: '2026-01-01', to: '2026-12-31' }];

/** A row context over `counts` that collects the members, the types and the members' check-ins. */
function context(counts: UsageCounts): { c: RowContext; members: Map<string, MemberInfo>; visits: MonthEntry[] } {
  const members = new Map<string, MemberInfo>();
  const visits: MonthEntry[] = [];
  const c: RowContext = {
    counts,
    cutoverOn: null,
    spans: SPANS,
    members,
    items: new Map(),
    titles: new Map(),
    seenLoans: new Set(),
    types: {},
    addMember: (hash, info) => void members.set(hash, info),
    addItem: () => undefined,
    addTitle: () => undefined,
    addLoanId: () => undefined,
    entry: (kind, _month, e) => {
      if (kind === 'visits') visits.push(e);
    },
    used: () => undefined,
  };
  return { c, members, visits };
}

describe('member ids as SLiMS compares them', () => {
  it('one member written A01 in the member table and a01 or " A01 " in the visitor log is one visitor of its type', () => {
    const transform = usageRowTransform(KEY);
    const counts = emptyCounts();
    const { c, members, visits } = context(counts);
    countMember(c, transform('member', { member_id: 'A01', member_name: 'Ayu', member_type_id: 1, expire_date: '2030-12-31' }));
    for (const [id, at] of [
      ['a01', '2026-03-02 08:00:00'],
      [' A01 ', '2026-03-03 08:00:00'],
      ['A01', '2026-03-04 08:00:00'],
    ] as const) {
      countVisit(c, transform('visitor_count', { visitor_id: 1, member_id: id, checkin_date: at }));
    }
    expect(members.size).toBe(1);
    expect(new Set(visits.map((v) => v.hash)).size).toBe(1);
    aggregateMonth(counts, { month: '2026-03', visits, borrows: [], carryIn: new Map(), dedupeMinutes: 60, members, spans: SPANS, spanVisitors: [new Set()], spanBorrowers: [new Set()] });
    const cells = counts.monthly['2026-03']!;
    expect(cells['visits']).toEqual({ 'slims_type:1': 3, '': 3 });
    expect(cells['distinct_visitors']).toEqual({ 'slims_type:1': 1, '': 1 });
    expect(counts.memberUnknown.visits).toBe(0);
  });

  it('an id held as bytes that are not UTF-8 folds its ASCII letters the same way', () => {
    const transform = usageRowTransform(KEY);
    const lower = transform('loan', { loan_id: 1, member_id: Uint8Array.from([0x61, 0x30, 0x31, 0xe9]) }); // "a01é" in latin1
    const upper = transform('loan', { loan_id: 2, member_id: Uint8Array.from([0x41, 0x30, 0x31, 0xe9, 0x20]) }); // "A01é "
    expect(lower['member_id']).toBe(upper['member_id']);
  });
});
