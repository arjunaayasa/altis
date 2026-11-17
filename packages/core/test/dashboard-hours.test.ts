import { describe, expect, it } from 'vitest';
import { dashboardHours, dashboardLocalHour } from '../src/dashboard/home.js';

// Beranda's desk hours are put into local hours in code, from UTC instants: the same on every engine, right in a zone
// with a half-hour offset and across a daylight saving change.

const at = (iso: string): number => Date.parse(iso);

describe('the local hour of an instant', () => {
  it('Asia/Jakarta (UTC+7), midnight included', () => {
    expect(dashboardLocalHour('Asia/Jakarta', at('2026-03-15T00:30:00Z'))).toBe(7);
    expect(dashboardLocalHour('Asia/Jakarta', at('2026-03-14T17:00:00Z'))).toBe(0);
    expect(dashboardLocalHour('Asia/Jakarta', at('2026-03-15T16:59:59Z'))).toBe(23);
  });

  it('a zone with a half-hour offset (Asia/Kolkata, UTC+5:30)', () => {
    expect(dashboardLocalHour('Asia/Kolkata', at('2026-03-15T00:20:00Z'))).toBe(5);
    expect(dashboardLocalHour('Asia/Kolkata', at('2026-03-15T00:40:00Z'))).toBe(6);
  });
});

describe('the 24 hours of a day', () => {
  it('count each loan and return in its local hour, every hour present', () => {
    const hours = dashboardHours(
      'Asia/Jakarta',
      [at('2026-03-15T00:30:00Z'), at('2026-03-15T01:10:00Z'), at('2026-03-15T01:50:00Z')],
      [at('2026-03-15T03:20:00Z')],
    );
    expect(hours).toHaveLength(24);
    expect(hours.map((h) => h.hour)).toEqual(Array.from({ length: 24 }, (_, k) => k));
    expect(hours.filter((h) => h.loans + h.returns > 0)).toEqual([
      { hour: 7, loans: 1, returns: 0 },
      { hour: 8, loans: 2, returns: 0 },
      { hour: 10, loans: 0, returns: 1 },
    ]);
  });

  it('across the start of daylight saving time the skipped hour stays empty (America/New_York, 8 March 2026)', () => {
    const hours = dashboardHours('America/New_York', [at('2026-03-08T06:30:00Z'), at('2026-03-08T07:30:00Z')], []);
    expect(hours.filter((h) => h.loans > 0).map((h) => h.hour)).toEqual([1, 3]);
    expect(hours[2]).toEqual({ hour: 2, loans: 0, returns: 0 });
  });

  it('across the end of daylight saving time the repeated hour holds both of its instants (America/New_York, 1 November 2026)', () => {
    const hours = dashboardHours('America/New_York', [], [at('2026-11-01T05:30:00Z'), at('2026-11-01T06:30:00Z')]);
    expect(hours.filter((h) => h.returns > 0)).toEqual([{ hour: 1, loans: 0, returns: 2 }]);
  });
});
