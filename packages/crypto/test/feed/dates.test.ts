import { describe, expect, it } from 'vitest';
import { isCalendarDate, jakartaDate } from '../../src/feed/index.js';

// Feed and manifest dates are calendar days in Asia/Jakarta, UTC+7 without daylight saving (decision D1d-6).

/** The first instant of the Jakarta day `y-m-d` (17:00 UTC of the day before). */
const dayStart = (y: number, m: number, d: number): number => Date.UTC(y, m - 1, d) - 7 * 3_600_000;

describe('feed dates (D1d-6)', () => {
  it('jakartaDate names the Jakarta calendar day of an instant', () => {
    expect(jakartaDate(Date.UTC(2027, 10, 1, 17))).toBe('2027-11-02');
    expect(jakartaDate(Date.UTC(2027, 10, 1, 16, 59, 59, 999))).toBe('2027-11-01');
    expect(jakartaDate(dayStart(2026, 10, 1))).toBe('2026-10-01');
    expect(jakartaDate(dayStart(2026, 10, 2) - 1)).toBe('2026-10-01');
  });

  it('walks every day of a leap year', () => {
    let day = dayStart(2028, 1, 1);
    const seen = new Set<string>();
    for (let i = 0; i < 366; i++) {
      const date = jakartaDate(day);
      expect(isCalendarDate(date), date).toBe(true);
      seen.add(date);
      day += 86_400_000;
    }
    expect(seen.size).toBe(366);
    expect(seen.has('2028-02-29')).toBe(true);
    expect(jakartaDate(day)).toBe('2029-01-01');
  });

  it('pads years below 1000 (Date.UTC would map years 0-99 to 1900-1999)', () => {
    const date = new Date(0);
    date.setUTCFullYear(99, 2, 4);
    expect(jakartaDate(date.getTime())).toBe('0099-03-04');
  });

  it('isCalendarDate accepts real calendar days only', () => {
    for (const d of ['2026-10-01', '2028-02-29', '0001-01-01', '9999-12-31']) expect(isCalendarDate(d), d).toBe(true);
    for (const d of ['2026-13-01', '2027-02-29', '2026-10-1', '2026-10-01T00:00:00Z', ' 2026-10-01', '', null, 20261001]) {
      expect(isCalendarDate(d), String(d)).toBe(false);
    }
  });

  it('refuses an instant it cannot name, with a TypeError', () => {
    expect(() => jakartaDate(Number.NaN)).toThrow(TypeError);
    expect(() => jakartaDate(Number.POSITIVE_INFINITY)).toThrow(TypeError);
    expect(() => jakartaDate(Date.UTC(10000, 0, 1))).toThrow(TypeError);
  });
});
