import { addDays, addMonths } from '@altis/shared';
import type { AccredWindow } from './types.js';

// The windows a metric is measured over (spec §10.5), resolved against a period and the snapshot date `D`. Every window
// ends at `D` at the latest, so a period still running is measured up to today.

/** A span of calendar days, both ends included. */
export interface DateSpan {
  from: string;
  to: string;
}

/** A resolved window: its span, its three yearly slices (three periods) or two (a period and the year before), and the day before it (three calendar years). */
export interface ResolvedWindow extends DateSpan {
  slices: readonly DateSpan[] | null;
  before: string | null;
}

/** The snapshot date of a period: its end, or today while the end lies ahead. */
export function snapshotDate(endsOn: string, today: string): string {
  return endsOn <= today ? endsOn : today;
}

const minDate = (a: string, b: string): string => (a <= b ? a : b);
const yearOf = (date: string): number => Number(date.slice(0, 4));
const pad4 = (y: number): string => String(y).padStart(4, '0');

/**
 * `w` for the period `p` with the snapshot date `D`:
 *
 * - `snapshot`, `current`: the day `D`;
 * - `period`: from the period's start to its end;
 * - `three_periods`: from two years before the period's start to its end, in three yearly slices;
 * - `three_calendar_years`, `budget_years`: the calendar years Y − 2 to Y, Y the year the period ends; `before` is the
 *   last day before them (three calendar years only);
 * - `twelve_months`: the twelve months to `D`; `three_years`: the three years to `D`;
 * - `period_and_previous`: the twelve months before the period and the period, as two slices.
 *
 * Every `to` (a slice's too) is capped at `D`.
 */
export function resolveWindow(w: AccredWindow, p: { startsOn: string; endsOn: string }, D: string): ResolvedWindow {
  const cap = (s: DateSpan): DateSpan => ({ from: s.from, to: minDate(s.to, D) });
  const end = minDate(p.endsOn, D);
  switch (w) {
    case 'snapshot':
    case 'current':
      return { from: D, to: D, slices: null, before: null };
    case 'period':
      return { from: p.startsOn, to: end, slices: null, before: null };
    case 'three_periods': {
      const from = addMonths(p.startsOn, -24);
      const slices = [
        { from, to: addDays(addMonths(p.startsOn, -12), -1) },
        { from: addMonths(p.startsOn, -12), to: addDays(p.startsOn, -1) },
        { from: p.startsOn, to: p.endsOn },
      ].map(cap);
      return { from, to: end, slices, before: null };
    }
    case 'three_calendar_years':
    case 'budget_years': {
      const y = yearOf(p.endsOn);
      const span = cap({ from: `${pad4(y - 2)}-01-01`, to: `${pad4(y)}-12-31` });
      return { ...span, slices: null, before: w === 'three_calendar_years' ? `${pad4(y - 3)}-12-31` : null };
    }
    case 'twelve_months':
      return { from: addDays(addMonths(D, -12), 1), to: D, slices: null, before: null };
    case 'three_years':
      return { from: addDays(addMonths(D, -36), 1), to: D, slices: null, before: null };
    case 'period_and_previous': {
      const from = addMonths(p.startsOn, -12);
      return { from, to: end, slices: [{ from, to: addDays(p.startsOn, -1) }, { from: p.startsOn, to: p.endsOn }].map(cap), before: null };
    }
  }
}

/** The three budget years of a period: the calendar years Y − 2, Y − 1 and Y, Y the year it ends. */
export function budgetYears(endsOn: string): [number, number, number] {
  const y = yearOf(endsOn);
  return [y - 2, y - 1, y];
}
