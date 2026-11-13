import { describe, expect, it } from 'vitest';
import {
  addDays,
  addMonths,
  diffDays,
  endOfMonth,
  isCalendarDate,
  isoWeekday,
  localDate,
  monthOf,
  monthsBetween,
} from '../src/dates.js';
import * as root from '../src/index.js';

// Calendar dates as `YYYY-MM-DD` strings (the CHAR(10) columns of reports and accreditation): arithmetic on whole days
// with no time zone, and the one conversion from an instant to the library's local date. No Node built-in is used, so
// the admin SPA bundles the same code.

/** mulberry32: a small seeded generator, so a failing case can be replayed (no property-testing dependency). */
function prng(seed: number): () => number {
  let a = seed >>> 0;
  return () => {
    a = (a + 0x6d2b79f5) >>> 0;
    let t = a;
    t = Math.imul(t ^ (t >>> 15), t | 1);
    t ^= t + Math.imul(t ^ (t >>> 7), t | 61);
    return ((t ^ (t >>> 14)) >>> 0) / 4294967296;
  };
}

describe('isCalendarDate', () => {
  it('accepts real days written YYYY-MM-DD and nothing else', () => {
    for (const s of ['2024-02-29', '2025-12-31', '2026-01-01', '1999-06-15']) expect(isCalendarDate(s), s).toBe(true);
    for (const s of ['2023-02-29', '2024-04-31', '2024-13-01', '2024-00-10', '2024-01-00', '2024-1-01', '24-01-01', '2024-01-01T00:00', ' 2024-01-01', '']) {
      expect(isCalendarDate(s), JSON.stringify(s)).toBe(false);
    }
  });
});

describe('addDays and diffDays', () => {
  it('cross the end of February, leap year or not', () => {
    expect(addDays('2024-02-28', 1)).toBe('2024-02-29');
    expect(addDays('2023-02-28', 1)).toBe('2023-03-01');
    expect(addDays('2024-03-01', -1)).toBe('2024-02-29');
    expect(addDays('2025-12-31', 1)).toBe('2026-01-01');
    expect(addDays('2026-01-01', 0)).toBe('2026-01-01');
  });

  it('count the days from one date to the next, negative when the second is earlier', () => {
    expect(diffDays('2025-12-31', '2026-01-01')).toBe(1);
    expect(diffDays('2026-01-01', '2025-12-31')).toBe(-1);
    expect(diffDays('2024-01-01', '2025-01-01')).toBe(366);
    expect(diffDays('2025-07-01', '2025-07-01')).toBe(0);
  });

  it('diffDays undoes addDays for any shift within ten years either way (seeded random cases)', () => {
    const rand = prng(20261113);
    for (let i = 0; i < 2000; i += 1) {
      const start = addDays('2000-01-01', Math.floor(rand() * 15_000));
      const n = Math.floor(rand() * 7301) - 3650;
      const shifted = addDays(start, n);
      expect(isCalendarDate(shifted), `${start} ${n}`).toBe(true);
      expect(diffDays(start, shifted), `${start} ${n}`).toBe(n);
    }
  });

  it('refuse a string that is not a calendar date', () => {
    expect(() => addDays('2023-02-29', 1)).toThrow(TypeError);
    expect(() => diffDays('2024-01-01', 'besok')).toThrow(TypeError);
  });
});

describe('addMonths', () => {
  it('keeps the day of the month, clamped to the end of a shorter month', () => {
    expect(addMonths('2025-01-31', 1)).toBe('2025-02-28');
    expect(addMonths('2024-01-31', 1)).toBe('2024-02-29');
    expect(addMonths('2025-03-31', -1)).toBe('2025-02-28');
    expect(addMonths('2025-07-15', 12)).toBe('2026-07-15');
    expect(addMonths('2025-07-01', -13)).toBe('2024-06-01');
    expect(addMonths('2025-10-31', 2)).toBe('2025-12-31');
  });
});

describe('isoWeekday', () => {
  it('Monday is 1 and Sunday 7', () => {
    expect(isoWeekday('2026-01-01')).toBe(4);
    expect(isoWeekday('2026-01-04')).toBe(7);
    expect(isoWeekday('2026-01-05')).toBe(1);
    expect(isoWeekday('2024-02-29')).toBe(4);
    expect(isoWeekday('1970-01-01')).toBe(4);
  });
});

describe('localDate', () => {
  it('is the calendar date of an instant in the named time zone', () => {
    expect(localDate('Asia/Jakarta', Date.UTC(2025, 11, 31, 17, 0))).toBe('2026-01-01');
    expect(localDate('Asia/Jakarta', Date.UTC(2025, 11, 31, 16, 59))).toBe('2025-12-31');
    expect(localDate('Asia/Jayapura', Date.UTC(2025, 11, 31, 15, 0))).toBe('2026-01-01');
    expect(localDate('UTC', Date.UTC(2024, 1, 29, 23, 59))).toBe('2024-02-29');
  });
});

describe('months', () => {
  it('monthsBetween counts the calendar months a span touches, both ends included', () => {
    expect(monthsBetween('2025-07-01', '2026-06-30')).toBe(12);
    expect(monthsBetween('2025-07-15', '2025-07-20')).toBe(1);
    expect(monthsBetween('2025-07-31', '2025-08-01')).toBe(2);
    expect(monthsBetween('2025-01-01', '2025-12-31')).toBe(12);
    expect(monthsBetween('2026-01-01', '2025-12-31')).toBe(0);
  });

  it('monthOf and endOfMonth', () => {
    expect(monthOf('2026-02-14')).toBe('2026-02');
    expect(endOfMonth('2024-02')).toBe('2024-02-29');
    expect(endOfMonth('2025-02')).toBe('2025-02-28');
    expect(endOfMonth('2025-12')).toBe('2025-12-31');
    expect(() => endOfMonth('2025-13')).toThrow(TypeError);
  });
});

describe('the package root', () => {
  it('re-exports the date helpers', () => {
    expect(root.addDays).toBe(addDays);
    expect(root.localDate).toBe(localDate);
    expect(root.isCalendarDate).toBe(isCalendarDate);
  });
});
