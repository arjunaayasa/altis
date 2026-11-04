import { DomainError } from '@altis/shared';

// Schedule expressions (spec §10.4, decision C2): a five-field cron subset evaluated in the library's local time.
//
// - Fields: minute 0–59, hour 0–23, day 1–31, month 1–12, weekday 0–6 (Sunday 0; 7 is refused). Each field is a
//   comma-separated list of `*`, `*/n`, `a`, `a-b` and `a-b/n` (n ≥ 1; no `a/n`). Fields are separated by blanks.
// - Day and weekday: when both are restricted (their sets are not the whole range) a date matching either one runs
//   (C2, as cron does); when one of them is the whole range, only the other counts. An expression that can never
//   match a date (`0 0 31 2 *`) is refused.
// - Local time is that of an IANA zone, read through Intl.DateTimeFormat. Runs are at whole minutes. A local time
//   that does not exist (the hour skipped when the clocks go forward) is skipped; a local time that happens twice
//   (when they go back) runs once, at its first occurrence, so a schedule never runs twice for one local time.

/** A parsed schedule expression. Build it with {@link parseCronExpr}. */
export interface CronExpr {
  /** The expression as given. */
  readonly source: string;
  /** Minutes and hours that run, ascending. */
  readonly minutes: readonly number[];
  readonly hours: readonly number[];
  /** `dayMask[d]` for day d (1–31), `monthMask[m]` for month m (1–12), `weekdayMask[w]` for weekday w (0–6). */
  readonly dayMask: readonly boolean[];
  readonly monthMask: readonly boolean[];
  readonly weekdayMask: readonly boolean[];
  /** Whether the day set, and the weekday set, are not the whole range (C2: both restricted → either matches). */
  readonly dayRestricted: boolean;
  readonly weekdayRestricted: boolean;
}

/** The longest expression (`schedules.expr` is VARCHAR(191)). */
const EXPR_MAX = 191;

const MINUTE_MS = 60_000;
const DAY_MS = 86_400_000;

/** How far nextRun looks ahead: 29 February can be 8 years away (2096 → 2104). */
const SEARCH_DAYS = 8 * 366 + 2;

interface FieldSpec {
  name: string;
  min: number;
  max: number;
}

const FIELDS: readonly FieldSpec[] = [
  { name: 'minute', min: 0, max: 59 },
  { name: 'hour', min: 0, max: 23 },
  { name: 'day', min: 1, max: 31 },
  { name: 'month', min: 1, max: 12 },
  { name: 'weekday', min: 0, max: 6 },
];

/** One list item: `*`, or a value or range, each optionally stepped (`/n`); one or two ASCII digits per number. */
const ITEM = /^(?:(\*)|(\d{1,2})(?:-(\d{1,2}))?)(?:\/(\d{1,2}))?$/;

/** The longest day of each month (February: 29). */
const MONTH_DAYS = [0, 31, 29, 31, 30, 31, 30, 31, 31, 30, 31, 30, 31];

function invalid(): DomainError {
  return new DomainError('VALIDATION_FAILED', {
    detail: 'Ekspresi jadwal tidak valid / The schedule expression is not valid',
    meta: { errors: [{ path: 'expr', code: 'invalid_format' }] },
  });
}

/** The values of one field as a mask over 0..max, or null when the field is malformed. */
function parseField(text: string, f: FieldSpec): boolean[] | null {
  const mask = new Array<boolean>(f.max + 1).fill(false);
  for (const item of text.split(',')) {
    const m = ITEM.exec(item);
    if (m === null) return null;
    const [, star, a, b, stepText] = m;
    let lo = f.min;
    let hi = f.max;
    if (star === undefined) {
      lo = Number(a);
      hi = b === undefined ? lo : Number(b);
      // `a/n` (a single value with a step) is not a form of the subset.
      if (b === undefined && stepText !== undefined) return null;
    }
    const step = stepText === undefined ? 1 : Number(stepText);
    if (lo < f.min || hi > f.max || lo > hi || step < 1 || step > f.max - f.min + 1) return null;
    for (let v = lo; v <= hi; v += step) mask[v] = true;
  }
  return mask;
}

function listOf(mask: readonly boolean[]): number[] {
  const out: number[] = [];
  mask.forEach((on, v) => {
    if (on) out.push(v);
  });
  return out;
}

function fullRange(mask: readonly boolean[], f: FieldSpec): boolean {
  for (let v = f.min; v <= f.max; v += 1) if (mask[v] !== true) return false;
  return true;
}

/**
 * Parses a schedule expression (see the top of this file).
 *
 * @throws DomainError `VALIDATION_FAILED` (`meta.errors: [{path: 'expr', code: 'invalid_format'}]`) for anything that
 *   is not five well-formed fields within their ranges, longer than 191 characters, or never matches a date
 */
export function parseCronExpr(expr: string): CronExpr {
  if (typeof expr !== 'string' || expr.length > EXPR_MAX) throw invalid();
  const parts = expr.trim().split(/[ \t]+/);
  if (parts.length !== FIELDS.length) throw invalid();
  const masks: boolean[][] = [];
  for (let i = 0; i < FIELDS.length; i += 1) {
    const mask = parseField(parts[i]!, FIELDS[i]!);
    if (mask === null) throw invalid();
    masks.push(mask);
  }
  const [minuteMask, hourMask, dayMask, monthMask, weekdayMask] = masks as [boolean[], boolean[], boolean[], boolean[], boolean[]];
  const dayRestricted = !fullRange(dayMask, FIELDS[2]!);
  const weekdayRestricted = !fullRange(weekdayMask, FIELDS[4]!);
  // Only the day decides (the weekday is the whole range): some chosen month must have some chosen day.
  if (dayRestricted && !weekdayRestricted) {
    const possible = listOf(monthMask).some((month) => listOf(dayMask).some((day) => day <= MONTH_DAYS[month]!));
    if (!possible) throw invalid();
  }
  return Object.freeze({
    source: expr,
    minutes: Object.freeze(listOf(minuteMask)),
    hours: Object.freeze(listOf(hourMask)),
    dayMask: Object.freeze(dayMask),
    monthMask: Object.freeze(monthMask),
    weekdayMask: Object.freeze(weekdayMask),
    dayRestricted,
    weekdayRestricted,
  });
}

function checkExpr(e: CronExpr, caller: string): void {
  if (typeof e !== 'object' || e === null || !Array.isArray(e.minutes) || !Array.isArray(e.dayMask)) {
    throw new TypeError(`${caller}: the expression must come from parseCronExpr`);
  }
}

function checkInstant(t: number, caller: string): void {
  if (typeof t !== 'number' || !Number.isSafeInteger(t) || t < 0) {
    throw new TypeError(`${caller}: the time must be a safe non-negative integer (epoch ms)`);
  }
}

// ---------------------------------------------------------------------------------------------------------------
// Local time of an IANA zone

/** One formatter per zone (a per-process cache of pure data, P6). */
const formatters = new Map<string, Intl.DateTimeFormat>();

/** @throws RangeError for a zone Intl does not know */
function formatter(timeZone: string): Intl.DateTimeFormat {
  let f = formatters.get(timeZone);
  if (f === undefined) {
    if (typeof timeZone !== 'string' || timeZone.length === 0) throw new RangeError('the time zone must be an IANA zone name');
    f = new Intl.DateTimeFormat('en-US', {
      timeZone,
      hourCycle: 'h23',
      year: 'numeric',
      month: 'numeric',
      day: 'numeric',
      hour: 'numeric',
      minute: 'numeric',
      second: 'numeric',
    });
    formatters.set(timeZone, f);
  }
  return f;
}

/** The wall-clock time of instant `t` in `timeZone`, written as if it were UTC (epoch ms of the same fields). */
function wallClock(t: number, timeZone: string): number {
  const fields: Record<string, number> = {};
  for (const part of formatter(timeZone).formatToParts(t)) {
    if (part.type !== 'literal') fields[part.type] = Number(part.value);
  }
  const wall = Date.UTC(fields['year']!, fields['month']! - 1, fields['day']!, fields['hour']! % 24, fields['minute']!, fields['second']!);
  return wall + (t % 1000);
}

/** The offset of `timeZone` from UTC at instant `t`, in ms (local = UTC + offset). */
function offsetAt(t: number, timeZone: string): number {
  return wallClock(t, timeZone) - t;
}

/**
 * The first instant whose local time in `timeZone` is the wall-clock time `local` (written as if UTC), or null when
 * that local time does not exist. The offsets a day before and a day after cover both sides of any transition near it.
 */
function firstInstant(local: number, timeZone: string): number | null {
  const before = local - offsetAt(Math.max(0, local - DAY_MS), timeZone);
  const after = local - offsetAt(local + DAY_MS, timeZone);
  for (const t of before <= after ? [before, after] : [after, before]) {
    if (t >= 0 && wallClock(t, timeZone) === local) return t;
  }
  return null;
}

function dateMatches(e: CronExpr, year: number, month: number, day: number): boolean {
  if (e.monthMask[month] !== true) return false;
  const dayOk = e.dayMask[day] === true;
  const weekdayOk = e.weekdayMask[new Date(Date.UTC(year, month - 1, day)).getUTCDay()] === true;
  if (e.dayRestricted && e.weekdayRestricted) return dayOk || weekdayOk;
  if (e.dayRestricted) return dayOk;
  if (e.weekdayRestricted) return weekdayOk;
  return true;
}

/**
 * The first run of `e` strictly after `after` (epoch ms), at a whole minute of the local time of `timeZone` (see the
 * top of this file for skipped and repeated local times).
 *
 * @throws TypeError for an expression not made by parseCronExpr or a malformed `after`; RangeError for an unknown zone
 */
export function nextRun(e: CronExpr, after: number, timeZone: string): number {
  checkExpr(e, 'nextRun');
  checkInstant(after, 'nextRun');
  const start = wallClock(after, timeZone);
  // The local wall-clock minute of `after`: earlier local times of that day ran at their first occurrence already.
  const startMinute = start - (((start % MINUTE_MS) + MINUTE_MS) % MINUTE_MS);
  const first = new Date(startMinute);
  for (let i = 0; i < SEARCH_DAYS; i += 1) {
    const date = new Date(Date.UTC(first.getUTCFullYear(), first.getUTCMonth(), first.getUTCDate() + i));
    const year = date.getUTCFullYear();
    const month = date.getUTCMonth() + 1;
    const day = date.getUTCDate();
    if (!dateMatches(e, year, month, day)) continue;
    for (const hour of e.hours) {
      for (const minute of e.minutes) {
        const local = Date.UTC(year, month - 1, day, hour, minute);
        if (local < startMinute) continue;
        const t = firstInstant(local, timeZone);
        if (t !== null && t > after) return t;
      }
    }
  }
  // parseCronExpr refuses an expression without any date, and every date it allows recurs within the search.
  throw new RangeError(`nextRun: no run of ${JSON.stringify(e.source)} within ${SEARCH_DAYS} days`);
}

/**
 * The gap between the next two runs of `e` after `at`, in ms (a day for `0 1 * * *`, 23 or 25 hours across a clock
 * change).
 *
 * @throws as {@link nextRun}
 */
export function periodMs(e: CronExpr, at: number, timeZone: string): number {
  const a = nextRun(e, at, timeZone);
  return nextRun(e, a, timeZone) - a;
}
