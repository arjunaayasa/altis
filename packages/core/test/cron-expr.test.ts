import { isDomainError, isPermission } from '@altis/shared';
import { describe, expect, it } from 'vitest';
import { nextRun, parseCronExpr, periodMs } from '../src/scheduler/cron-expr.js';
import { SCHEDULES, scheduleWindowSchema } from '../src/scheduler/registry.js';

// Schedule expressions (spec §10.4, decision C2): five cron fields (minute, hour, day, month, weekday with Sunday 0),
// each `*`, `*/n`, `a`, `a-b`, `a-b/n` or a list of those; day and weekday OR-ed when both are restricted; evaluated in
// the local time of an IANA zone; a local time that does not exist is skipped and a repeated one runs once.

const MIN = 60_000;
const HOUR = 60 * MIN;
const DAY = 24 * HOUR;

/** The VALIDATION_FAILED of an expression: `meta.errors` is `[{path: 'expr', code}]`. */
function refused(expr: unknown): void {
  let caught: unknown;
  try {
    parseCronExpr(expr as string);
  } catch (error) {
    caught = error;
  }
  expect(isDomainError(caught), `${JSON.stringify(expr)} must be refused`).toBe(true);
  if (!isDomainError(caught)) return;
  expect(caught.code).toBe('VALIDATION_FAILED');
  expect(caught.meta?.['errors']).toEqual([{ path: 'expr', code: 'invalid_format' }]);
}

describe('parseCronExpr', () => {
  it('accepts every field form: *, */n, a, a-b, a-b/n and lists of them', () => {
    for (const expr of ['* * * * *', '*/10 * * * *', '0 1 * * *', '0,30 9-17/2 * * 1-5', '5 0 1-31/7 */3 0,6', ' 0  1 * *\t* ', '59 23 31 12 6']) {
      expect(() => parseCronExpr(expr), expr).not.toThrow();
    }
  });

  it('refuses a value out of range, a missing field, a zero step, weekday 7 and other malformed fields', () => {
    for (const expr of [
      '60 * * * *',
      '* * * *',
      '*/0 * * * *',
      '0 0 * * 7',
      '* 24 * * *',
      '* * 0 * *',
      '* * * 13 *',
      '* * * 0 *',
      '* * * * * *',
      '5-1 * * * *',
      '5/2 * * * *',
      '*/ * * * *',
      '-1 * * * *',
      '1,,2 * * * *',
      ',1 * * * *',
      '1- * * * *',
      '001 * * * *',
      'a * * * *',
      '@daily',
      '',
      '   ',
      '０ 1 * * *',
      '0 0 31 2 *',
      '0 0 30,31 2 *',
      `${'0,'.repeat(100)}0 * * * *`,
    ]) {
      refused(expr);
    }
    refused(undefined);
    refused(5);
  });
});

describe('nextRun (library time, minute resolution, strictly after)', () => {
  it('01:00 WIB is 18:00 UTC of the day before', () => {
    expect(nextRun(parseCronExpr('0 1 * * *'), Date.UTC(2026, 9, 28, 17, 59), 'Asia/Jakarta')).toBe(Date.UTC(2026, 9, 28, 18, 0));
    // Strictly after: from 18:00 itself the next run is a day later.
    expect(nextRun(parseCronExpr('0 1 * * *'), Date.UTC(2026, 9, 28, 18, 0), 'Asia/Jakarta')).toBe(Date.UTC(2026, 9, 29, 18, 0));
  });

  it('*/10 from 12:05:30 is 12:10:00; from 12:10:00 it is 12:20:00', () => {
    const e = parseCronExpr('*/10 * * * *');
    expect(nextRun(e, Date.UTC(2026, 9, 28, 12, 5, 30), 'UTC')).toBe(Date.UTC(2026, 9, 28, 12, 10));
    expect(nextRun(e, Date.UTC(2026, 9, 28, 12, 10), 'UTC')).toBe(Date.UTC(2026, 9, 28, 12, 20));
    expect(nextRun(e, Date.UTC(2026, 9, 28, 23, 55), 'UTC')).toBe(Date.UTC(2026, 9, 29, 0, 0));
  });

  it('0 0 1 * * from 31 January is 1 February; 0 0 29 2 * waits for the next leap year', () => {
    expect(nextRun(parseCronExpr('0 0 1 * *'), Date.UTC(2026, 0, 31, 12), 'UTC')).toBe(Date.UTC(2026, 1, 1));
    expect(nextRun(parseCronExpr('0 0 29 2 *'), Date.UTC(2026, 0, 31, 12), 'UTC')).toBe(Date.UTC(2028, 1, 29));
    expect(nextRun(parseCronExpr('0 0 31 * *'), Date.UTC(2026, 9, 31, 12), 'UTC')).toBe(Date.UTC(2026, 11, 31));
  });

  it('0 3 * * 1 is the next Monday 03:00', () => {
    // 2026-10-28 is a Wednesday, 2026-11-02 a Monday.
    expect(nextRun(parseCronExpr('0 3 * * 1'), Date.UTC(2026, 9, 28, 10), 'UTC')).toBe(Date.UTC(2026, 10, 2, 3));
    expect(nextRun(parseCronExpr('0 3 * * 0'), Date.UTC(2026, 9, 28, 10), 'UTC')).toBe(Date.UTC(2026, 10, 1, 3));
  });

  it('day and weekday both restricted: either one matches (C2); one of them * : only the other counts', () => {
    // The 13th or a Friday: from Wednesday 2026-10-28, Friday 30 October comes first; from 31 October, 6 November.
    const either = parseCronExpr('0 0 13 * 5');
    expect(nextRun(either, Date.UTC(2026, 9, 28), 'UTC')).toBe(Date.UTC(2026, 9, 30));
    // From Saturday 9 January 2027 the 13th (a Wednesday) comes before Friday the 15th.
    expect(nextRun(either, Date.UTC(2027, 0, 9), 'UTC')).toBe(Date.UTC(2027, 0, 13));
    expect(nextRun(either, Date.UTC(2027, 0, 13), 'UTC')).toBe(Date.UTC(2027, 0, 15));
    // A full range counts as unrestricted: the 13th only.
    expect(nextRun(parseCronExpr('0 0 13 * 0-6'), Date.UTC(2026, 9, 28), 'UTC')).toBe(Date.UTC(2026, 10, 13));
    expect(nextRun(parseCronExpr('0 0 * * 5'), Date.UTC(2026, 9, 28), 'UTC')).toBe(Date.UTC(2026, 9, 30));
  });

  it('lists, ranges and stepped ranges', () => {
    const e = parseCronExpr('15,45 9-17/4 * * 1-5');
    // Wednesday 2026-10-28: 09:15, 09:45, 13:15, 13:45, 17:15, 17:45, then Thursday 09:15.
    const runs: number[] = [];
    for (let t = Date.UTC(2026, 9, 28), i = 0; i < 7; i += 1) {
      t = nextRun(e, t, 'UTC');
      runs.push(t);
    }
    expect(runs.map((t) => new Date(t).toISOString().slice(5, 16))).toEqual([
      '10-28T09:15',
      '10-28T09:45',
      '10-28T13:15',
      '10-28T13:45',
      '10-28T17:15',
      '10-28T17:45',
      '10-29T09:15',
    ]);
  });

  it('Europe/Berlin, 2026-03-29: the missing 02:30 is skipped (the next run is 30 March)', () => {
    const e = parseCronExpr('30 2 * * *');
    // 28 March 02:30 CET = 01:30 UTC; 29 March 02:30 does not exist; 30 March 02:30 CEST = 00:30 UTC.
    expect(nextRun(e, Date.UTC(2026, 2, 28, 1, 0), 'Europe/Berlin')).toBe(Date.UTC(2026, 2, 28, 1, 30));
    expect(nextRun(e, Date.UTC(2026, 2, 28, 1, 30), 'Europe/Berlin')).toBe(Date.UTC(2026, 2, 30, 0, 30));
    // A time just after the gap runs on the day of the gap.
    expect(nextRun(parseCronExpr('0 3 * * *'), Date.UTC(2026, 2, 28, 2, 0), 'Europe/Berlin')).toBe(Date.UTC(2026, 2, 29, 1, 0));
  });

  it('Europe/Berlin, 2026-10-25: the repeated 02:30 runs once, at its first occurrence', () => {
    const e = parseCronExpr('30 2 * * *');
    const first = nextRun(e, Date.UTC(2026, 9, 24, 12), 'Europe/Berlin');
    expect(first).toBe(Date.UTC(2026, 9, 25, 0, 30)); // 02:30 CEST
    // Not 01:30 UTC (the second 02:30, CET): the next run is the next day.
    expect(nextRun(e, first, 'Europe/Berlin')).toBe(Date.UTC(2026, 9, 26, 1, 30));
    // From inside the repeated hour's second pass, a local time already run is not run again.
    expect(nextRun(parseCronExpr('45 2 * * *'), Date.UTC(2026, 9, 25, 1, 40), 'Europe/Berlin')).toBe(Date.UTC(2026, 9, 26, 1, 45));
    // *: every minute of the second pass already ran; the next new local time is 03:00 CET.
    expect(nextRun(parseCronExpr('* * * * *'), Date.UTC(2026, 9, 25, 1, 10), 'Europe/Berlin')).toBe(Date.UTC(2026, 9, 25, 2, 0));
  });

  it('refuses an unknown time zone and a malformed instant', () => {
    const e = parseCronExpr('0 1 * * *');
    expect(() => nextRun(e, Date.UTC(2026, 9, 28), 'Mars/Olympus')).toThrow(RangeError);
    expect(() => nextRun(e, Number.NaN, 'UTC')).toThrow(TypeError);
    expect(() => nextRun(e, -1, 'UTC')).toThrow(TypeError);
    expect(() => nextRun({} as never, 0, 'UTC')).toThrow(TypeError);
  });
});

describe('periodMs', () => {
  it('the gap between the next two runs after `at`', () => {
    expect(periodMs(parseCronExpr('0 1 * * *'), Date.UTC(2026, 9, 28, 12), 'Asia/Jakarta')).toBe(86_400_000);
    expect(periodMs(parseCronExpr('*/10 * * * *'), Date.UTC(2026, 9, 28, 12, 5), 'UTC')).toBe(10 * MIN);
    expect(periodMs(parseCronExpr('17 * * * *'), Date.UTC(2026, 9, 28, 12, 5), 'UTC')).toBe(HOUR);
    // Across the spring-forward night a daily local time is 23 hours apart.
    // 28 March 04:00 CET (03:00 UTC) to 29 March 04:00 CEST (02:00 UTC).
    expect(periodMs(parseCronExpr('0 4 * * *'), Date.UTC(2026, 2, 28, 1), 'Europe/Berlin')).toBe(DAY - HOUR);
  });
});

describe('SCHEDULES (the schedules this release defines)', () => {
  it('the table of Task 14: names, expressions, job types and permissions; only backup.daily is editable', () => {
    expect(SCHEDULES.map((d) => [d.name, d.expr, d.jobType, d.permission])).toEqual([
      ['backup.daily', '0 1 * * *', 'backup.schedule', 'system.backup.create'],
      ['retention.volatile', '*/10 * * * *', 'housekeeping.volatile', 'system.jobs.manage'],
      ['retention.events', '17 * * * *', 'housekeeping.events', 'system.jobs.manage'],
      ['retention.notifications', '23 3 * * *', 'housekeeping.notifications', 'system.jobs.manage'],
      ['retention.jobs', '29 3 * * *', 'housekeeping.jobs', 'system.jobs.manage'],
      ['files.cleanup', '41 * * * *', 'housekeeping.files', 'system.jobs.manage'],
      ['audit.anchor', '5 0 * * *', 'audit.anchor', 'system.audit.read'],
      ['audit.retention', '35 3 * * *', 'audit.retention', 'system.audit.read'],
      ['diagnostics.exposure', '47 2 * * *', 'diagnostics.exposure', 'system.diagnostics.manage'],
      ['diagnostics.ip_trust', '13 * * * *', 'diagnostics.ip_trust', 'system.diagnostics.manage'],
      ['diagnostics.usage', '53 4 * * *', 'diagnostics.usage', 'system.diagnostics.read'],
      // 1d Task 28 (§9.6 step 1): the daily update check.
      ['update.check', '0 4 * * *', 'update.check', 'system.update.read'],
      // ---- Phase 2 (catalog): Task 3 (§12.6: daily at 03:40) ----
      ['catalog.housekeeping', '40 3 * * *', 'catalog.housekeeping', 'system.jobs.manage'],
      // ---- Komunitas K1 (reports) ----
      ['reports.housekeeping', '50 3 * * *', 'reports.housekeeping', 'system.jobs.manage'],
      // ---- Komunitas K2 (privacy) ----
      ['privacy.anonymize', '15 2 * * *', 'privacy.anonymize', 'system.jobs.manage'],
    ]);
    expect(SCHEDULES.filter((d) => d.exprEditable === true).map((d) => d.name)).toEqual(['backup.daily']);
    for (const d of SCHEDULES) {
      expect(() => parseCronExpr(d.expr)).not.toThrow();
      expect(isPermission(d.permission)).toBe(true);
      expect(d.enabledByDefault).toBe(true);
    }
    // The window is every scheduled payload but the update check's, whose job takes who asked for it (S16).
    expect(SCHEDULES.filter((d) => d.payload !== undefined).map((d) => d.name)).toEqual(['update.check']);
    expect(SCHEDULES.find((d) => d.name === 'update.check')!.payload!({ windowStart: 1, windowEnd: 2 })).toEqual({ reason: 'schedule' });
    expect(Object.isFrozen(SCHEDULES)).toBe(true);
  });

  it('scheduleWindowSchema: the window every scheduled payload extends', () => {
    expect(scheduleWindowSchema.parse({ windowStart: 1, windowEnd: 2 })).toEqual({ windowStart: 1, windowEnd: 2 });
    expect(scheduleWindowSchema.safeParse({ windowStart: 1 }).success).toBe(false);
    expect(scheduleWindowSchema.safeParse({ windowStart: -1, windowEnd: 2 }).success).toBe(false);
    expect(scheduleWindowSchema.safeParse({ windowStart: 1, windowEnd: 2, extra: 1 }).success).toBe(false);
  });
});
