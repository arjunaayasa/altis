import { describe, expect, it } from 'vitest';
import { closedBy, closedDatesIn, computeDueDate, countOpenDays, ruleCloses, type ClosedDayRule } from '../src/circulation/calendars.js';
import { pickPolicy, rankPolicies, type PolicyDimensions } from '../src/circulation/policies.js';

// The pure rules of the circulation core: which loan rule wins (a truth table over every pair of dimension patterns,
// and the ranking the "which rule applies" tool shows), and how the library calendar moves a due date.

type Dim = 'member_type_id' | 'collection_type_id' | 'material_type_id' | 'branch_id';
const DIMS: readonly Dim[] = ['member_type_id', 'collection_type_id', 'material_type_id', 'branch_id'];
const LOAN: PolicyDimensions = { memberTypeId: 'M', collectionTypeId: 'C', materialTypeId: 'T', branchId: 'B' };
const VALUE: Record<Dim, string> = { member_type_id: 'M', collection_type_id: 'C', material_type_id: 'T', branch_id: 'B' };

/** The rule whose filled dimensions are the bits of `mask` (bit 3 = member type … bit 0 = branch), filled with `values`. */
function ruleOf(mask: number, values: Record<Dim, string> = VALUE) {
  const r: Record<string, string | null> = { id: `r${mask.toString(2).padStart(4, '0')}` };
  DIMS.forEach((d, i) => (r[d] = (mask >> (3 - i)) & 1 ? values[d] : null));
  return r as { id: string } & Record<Dim, string | null>;
}

const bits = (mask: number): number => [3, 2, 1, 0].reduce((n, i) => n + ((mask >> i) & 1), 0);

/** The expected winner of two fitting rules: more dimensions filled, then the earlier first differing filled one. */
function better(a: number, b: number): number {
  if (bits(a) !== bits(b)) return bits(a) > bits(b) ? a : b;
  return a > b ? a : b; // the masks read member type first, so the larger mask fills the earlier dimension
}

describe('loan rule resolution: the truth table', () => {
  const masks = Array.from({ length: 16 }, (_, i) => i);

  it('every pair of fitting rules: the one with more dimensions filled wins, a tie goes to the earlier dimension (240 cases)', () => {
    let cases = 0;
    for (const a of masks) {
      for (const b of masks) {
        if (a === b) continue;
        const want = ruleOf(better(a, b)).id;
        expect(pickPolicy([ruleOf(a), ruleOf(b)], LOAN)?.id, `${ruleOf(a).id} vs ${ruleOf(b).id}`).toBe(want);
        expect(pickPolicy([ruleOf(b), ruleOf(a)], LOAN)?.id, `${ruleOf(b).id} vs ${ruleOf(a).id}`).toBe(want);
        cases += 1;
      }
    }
    expect(cases).toBe(240);
  });

  it('a rule naming another value in any dimension never applies, however specific (15 cases); none left → null', () => {
    const other: Record<Dim, string> = { member_type_id: 'M2', collection_type_id: 'C2', material_type_id: 'T2', branch_id: 'B2' };
    for (const mask of masks.slice(1)) {
      expect(pickPolicy([ruleOf(mask, other), ruleOf(0)], LOAN)?.id, ruleOf(mask).id).toBe('r0000');
      expect(pickPolicy([ruleOf(mask, other)], LOAN)).toBeNull();
    }
  });

  it('the examples: member type + collection type beats member type + material type; member type beats collection type', () => {
    expect(pickPolicy([ruleOf(0b1010), ruleOf(0b1100)], LOAN)?.id).toBe('r1100');
    expect(pickPolicy([ruleOf(0b0100), ruleOf(0b1000)], LOAN)?.id).toBe('r1000');
    expect(pickPolicy([ruleOf(0b0110), ruleOf(0b1000)], LOAN)?.id).toBe('r0110');
  });

  it('a loan without a value in a dimension (no material type) fits only the rules leaving it "all"', () => {
    const noMaterial: PolicyDimensions = { ...LOAN, materialTypeId: null };
    expect(pickPolicy([ruleOf(0b1110), ruleOf(0b1100)], noMaterial)?.id).toBe('r1100');
  });

  it('the ranking of every fitting rule: the order of the truth table, each with why it stands there', () => {
    const ranked = rankPolicies(masks.map((m) => ruleOf(m)), LOAN);
    const order = [...masks].sort((a, b) => (better(a, b) === a ? -1 : 1));
    expect(ranked.map((r) => r.rule.id)).toEqual(order.map((m) => ruleOf(m).id));
    expect(ranked[0]!.reason).toBe('more_specific');
    expect(ranked.slice(1, 4).map((r) => r.reason)).toEqual(['less_specific', 'later_dimension', 'later_dimension']);
    expect(rankPolicies([ruleOf(0)], LOAN).map((r) => r.reason)).toEqual(['only']);
    expect(rankPolicies([ruleOf(0b0100), ruleOf(0b1000)], LOAN).map((r) => [r.rule.id, r.reason])).toEqual([
      ['r1000', 'earlier_dimension'],
      ['r0100', 'later_dimension'],
    ]);
  });
});

describe('the library calendar', () => {
  const weekly = (weekday: number): ClosedDayRule => ({ kind: 'weekly', weekday, date_from: null, date_to: null, month_day_from: null, month_day_to: null });
  const dates = (from: string, to: string): ClosedDayRule => ({ kind: 'dates', weekday: null, date_from: from, date_to: to, month_day_from: null, month_day_to: null });
  const yearly = (from: string, to: string): ClosedDayRule => ({ kind: 'yearly', weekday: null, date_from: null, date_to: null, month_day_from: from, month_day_to: to });

  it('closes weekdays (ISO), date ranges (both ends) and yearly days; 29 February only in a leap year', () => {
    expect(ruleCloses(weekly(7), '2026-11-15')).toBe(true); // a Sunday
    expect(ruleCloses(weekly(7), '2026-11-16')).toBe(false);
    expect([ruleCloses(dates('2026-12-24', '2026-12-26'), '2026-12-24'), ruleCloses(dates('2026-12-24', '2026-12-26'), '2026-12-27')]).toEqual([true, false]);
    expect([ruleCloses(yearly('08-17', '08-17'), '2031-08-17'), ruleCloses(yearly('08-17', '08-17'), '2031-08-18')]).toEqual([true, false]);
    expect(closedDatesIn([yearly('02-29', '02-29')], '2027-02-27', '2027-03-02')).toEqual([]);
    expect(closedDatesIn([yearly('02-29', '02-29')], '2028-02-27', '2028-03-02')).toEqual(['2028-02-29']);
  });

  it('a due date on a closed day moves to the next open day; one cut at the expiry steps back to an open day after the loan', () => {
    const closed = closedBy([weekly(6), weekly(7), dates('2026-11-23', '2026-11-23')]);
    // Saturday 21, Sunday 22 and Monday 23 November are closed.
    expect(computeDueDate({ loanedOn: '2026-11-14', days: 7, expiresOn: null }, closed)).toEqual({ dueOn: '2026-11-24', capped: false, moved: true });
    expect(computeDueDate({ loanedOn: '2026-11-14', days: 7, expiresOn: '2026-11-22' }, closed)).toEqual({ dueOn: '2026-11-20', capped: true, moved: false });
    // Every day back to the loan day closed: the loan day itself.
    expect(computeDueDate({ loanedOn: '2026-11-21', days: 3, expiresOn: '2026-11-23' }, closed)).toEqual({ dueOn: '2026-11-21', capped: true, moved: false });
  });

  it('366 closed days after the due date: CIRC_CALENDAR_CLOSED; 365 still finds the day after', () => {
    const year = closedBy([dates('2026-11-21', '2027-11-21')]); // 366 days
    expect(() => computeDueDate({ loanedOn: '2026-11-14', days: 7, expiresOn: null }, closedBy([dates('2026-11-21', '2027-11-21'), dates('2027-11-22', '2027-11-22')]))).toThrow(
      expect.objectContaining({ code: 'CIRC_CALENDAR_CLOSED' }),
    );
    expect(computeDueDate({ loanedOn: '2026-11-14', days: 7, expiresOn: null }, year).dueOn).toBe('2027-11-22');
  });

  it('open days of a span skip the closed ones (late days that skip closed days)', () => {
    const closed = closedBy([weekly(7)]);
    expect(countOpenDays(closed, '2026-11-13', '2026-11-20')).toBe(6); // Sunday 15 November is not counted
    expect(countOpenDays(closed, '2026-11-13', '2026-11-13')).toBe(0);
    expect(countOpenDays(closed, '2026-11-13', '2026-11-10')).toBe(0);
  });
});
