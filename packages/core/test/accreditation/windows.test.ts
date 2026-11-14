import { describe, expect, it } from 'vitest';
import { budgetYears, resolveWindow, snapshotDate } from '../../src/accreditation/windows.js';

// The windows a metric is measured over, resolved against a period and the snapshot date D: every one ends at D at the
// latest, the three periods come in three yearly slices, and the three calendar years name the day before them.

const SCHOOL_YEAR = { startsOn: '2025-07-01', endsOn: '2026-06-30' };

describe('snapshotDate', () => {
  it('is the period end, or today while the end lies ahead', () => {
    expect(snapshotDate('2026-06-30', '2026-03-01')).toBe('2026-03-01');
    expect(snapshotDate('2026-06-30', '2026-06-30')).toBe('2026-06-30');
    expect(snapshotDate('2026-06-30', '2027-01-15')).toBe('2026-06-30');
  });
});

describe('resolveWindow', () => {
  it('three calendar years: Y − 2 to Y (Y the year the period ends), capped at D, and the last day before them', () => {
    expect(resolveWindow('three_calendar_years', SCHOOL_YEAR, '2026-06-30')).toEqual({ from: '2024-01-01', to: '2026-06-30', slices: null, before: '2023-12-31' });
    expect(resolveWindow('three_calendar_years', { startsOn: '2026-01-01', endsOn: '2026-12-31' }, '2026-12-31')).toEqual({
      from: '2024-01-01',
      to: '2026-12-31',
      slices: null,
      before: '2023-12-31',
    });
  });

  it('three periods: from two years before the start, in three yearly slices', () => {
    expect(resolveWindow('three_periods', SCHOOL_YEAR, '2026-06-30')).toEqual({
      from: '2023-07-01',
      to: '2026-06-30',
      slices: [
        { from: '2023-07-01', to: '2024-06-30' },
        { from: '2024-07-01', to: '2025-06-30' },
        { from: '2025-07-01', to: '2026-06-30' },
      ],
      before: null,
    });
  });

  it('every window ends at D at the latest, a slice included', () => {
    const D = '2026-03-01';
    expect(resolveWindow('period', SCHOOL_YEAR, D)).toEqual({ from: '2025-07-01', to: D, slices: null, before: null });
    expect(resolveWindow('three_periods', SCHOOL_YEAR, D).slices!.at(-1)).toEqual({ from: '2025-07-01', to: D });
    expect(resolveWindow('three_calendar_years', SCHOOL_YEAR, D)).toMatchObject({ from: '2024-01-01', to: D });
    expect(resolveWindow('budget_years', SCHOOL_YEAR, D)).toEqual({ from: '2024-01-01', to: D, slices: null, before: null });
    expect(resolveWindow('period_and_previous', SCHOOL_YEAR, D)).toEqual({
      from: '2024-07-01',
      to: D,
      slices: [
        { from: '2024-07-01', to: '2025-06-30' },
        { from: '2025-07-01', to: D },
      ],
      before: null,
    });
  });

  it('the day D, the twelve months and the three years to D', () => {
    const D = '2026-06-30';
    expect(resolveWindow('snapshot', SCHOOL_YEAR, D)).toEqual({ from: D, to: D, slices: null, before: null });
    expect(resolveWindow('current', SCHOOL_YEAR, D)).toEqual({ from: D, to: D, slices: null, before: null });
    expect(resolveWindow('twelve_months', SCHOOL_YEAR, D)).toEqual({ from: '2025-07-01', to: D, slices: null, before: null });
    expect(resolveWindow('three_years', SCHOOL_YEAR, D)).toEqual({ from: '2023-07-01', to: D, slices: null, before: null });
    expect(resolveWindow('twelve_months', SCHOOL_YEAR, '2024-02-29')).toMatchObject({ from: '2023-03-01', to: '2024-02-29' });
  });
});

describe('budgetYears', () => {
  it('the calendar years Y − 2, Y − 1 and Y of the year the period ends', () => {
    expect(budgetYears('2026-06-30')).toEqual([2024, 2025, 2026]);
    expect(budgetYears('2025-12-31')).toEqual([2023, 2024, 2025]);
  });
});
