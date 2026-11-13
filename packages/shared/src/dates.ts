/**
 * Calendar dates as `YYYY-MM-DD` strings: the CHAR(10) dates of reports and accreditation (a receiving date, a period's
 * start and end, a month of usage). They are compared as text and shifted here in whole days, months and years, with
 * no time zone: only {@link localDate} turns an instant into the date it is somewhere. Day arithmetic is done on day
 * numbers (days since 1970-01-01) with integer formulas, never through `Date` (whose two-digit years and local time
 * zone would get in the way); `Intl` gives the local date. No Node built-ins here: the browser bundles this module.
 *
 * Every function that takes a date refuses a string that is not a real calendar day with a TypeError (a caller's bug,
 * not user input: the API contracts check dates before they reach report or accreditation code).
 */

const DATE = /^(\d{4})-(\d{2})-(\d{2})$/;
const MONTH = /^(\d{4})-(\d{2})$/;

interface Ymd {
  y: number;
  m: number;
  d: number;
}

function isLeap(y: number): boolean {
  return (y % 4 === 0 && y % 100 !== 0) || y % 400 === 0;
}

/** The number of days of month `m` (1-12) of year `y`. */
function monthDays(y: number, m: number): number {
  if (m === 2) return isLeap(y) ? 29 : 28;
  return m === 4 || m === 6 || m === 9 || m === 11 ? 30 : 31;
}

/** True for a real calendar day written `YYYY-MM-DD` (no 2023-02-29, no 2024-04-31), year 0001-9999. */
export function isCalendarDate(s: string): boolean {
  const match = DATE.exec(s);
  if (match === null) return false;
  const [y, m, d] = [Number(match[1]), Number(match[2]), Number(match[3])];
  return y >= 1 && m >= 1 && m <= 12 && d >= 1 && d <= monthDays(y, m);
}

function parse(date: string, what: string): Ymd {
  if (typeof date !== 'string' || !isCalendarDate(date)) {
    throw new TypeError(`${what}: not a calendar date YYYY-MM-DD: ${JSON.stringify(date)}`);
  }
  const match = DATE.exec(date)!;
  return { y: Number(match[1]), m: Number(match[2]), d: Number(match[3]) };
}

const pad = (n: number, width: number): string => String(n).padStart(width, '0');

function format({ y, m, d }: Ymd, what: string): string {
  if (y < 1 || y > 9999) throw new RangeError(`${what}: the result is outside the years 0001-9999`);
  return `${pad(y, 4)}-${pad(m, 2)}-${pad(d, 2)}`;
}

/** Days since 1970-01-01 of a proleptic Gregorian date (an integer formula valid for every year). */
function dayNumber({ y, m, d }: Ymd): number {
  const yy = m <= 2 ? y - 1 : y;
  const era = Math.floor(yy / 400);
  const yoe = yy - era * 400;
  const doy = Math.floor((153 * (m + (m > 2 ? -3 : 9)) + 2) / 5) + d - 1;
  const doe = yoe * 365 + Math.floor(yoe / 4) - Math.floor(yoe / 100) + doy;
  return era * 146_097 + doe - 719_468;
}

/** The date of a day number (the inverse of {@link dayNumber}). */
function fromDayNumber(z0: number): Ymd {
  const z = z0 + 719_468;
  const era = Math.floor(z / 146_097);
  const doe = z - era * 146_097;
  const yoe = Math.floor((doe - Math.floor(doe / 1460) + Math.floor(doe / 36_524) - Math.floor(doe / 146_096)) / 365);
  const doy = doe - (365 * yoe + Math.floor(yoe / 4) - Math.floor(yoe / 100));
  const mp = Math.floor((5 * doy + 2) / 153);
  const d = doy - Math.floor((153 * mp + 2) / 5) + 1;
  const m = mp < 10 ? mp + 3 : mp - 9;
  return { y: yoe + era * 400 + (m <= 2 ? 1 : 0), m, d };
}

/** `date` moved by `n` whole days (negative: back). */
export function addDays(date: string, n: number): string {
  if (!Number.isSafeInteger(n)) throw new TypeError(`addDays: ${n} is not a whole number of days`);
  return format(fromDayNumber(dayNumber(parse(date, 'addDays')) + n), 'addDays');
}

/** The days from `from` to `to`: `to − from` (negative when `to` is earlier). */
export function diffDays(from: string, to: string): number {
  return dayNumber(parse(to, 'diffDays')) - dayNumber(parse(from, 'diffDays'));
}

/** `date` moved by `n` calendar months; a day past the end of the target month becomes its last day. */
export function addMonths(date: string, n: number): string {
  if (!Number.isSafeInteger(n)) throw new TypeError(`addMonths: ${n} is not a whole number of months`);
  const { y, m, d } = parse(date, 'addMonths');
  const index = y * 12 + (m - 1) + n;
  const ty = Math.floor(index / 12);
  const tm = index - ty * 12 + 1;
  return format({ y: ty, m: tm, d: Math.min(d, monthDays(ty, tm)) }, 'addMonths');
}

/** The ISO weekday of `date`: Monday 1 … Sunday 7. */
export function isoWeekday(date: string): 1 | 2 | 3 | 4 | 5 | 6 | 7 {
  // 1970-01-01 was a Thursday (4).
  const n = dayNumber(parse(date, 'isoWeekday'));
  return ((((((n + 3) % 7) + 7) % 7) + 1) as 1 | 2 | 3 | 4 | 5 | 6 | 7);
}

const FORMATTERS = new Map<string, Intl.DateTimeFormat>();

/**
 * The calendar date of the instant `epochMs` in the IANA time zone `timeZone` (for example the library's
 * `library.timezone`, `Asia/Jakarta`).
 *
 * @throws RangeError for a time zone `Intl` does not know
 */
export function localDate(timeZone: string, epochMs: number): string {
  let formatter = FORMATTERS.get(timeZone);
  if (formatter === undefined) {
    formatter = new Intl.DateTimeFormat('en-US', {
      timeZone,
      year: 'numeric',
      month: '2-digit',
      day: '2-digit',
      calendar: 'gregory',
      numberingSystem: 'latn',
    });
    FORMATTERS.set(timeZone, formatter);
  }
  const parts: Partial<Record<string, string>> = {};
  for (const part of formatter.formatToParts(epochMs)) parts[part.type] = part.value;
  return format({ y: Number(parts['year']), m: Number(parts['month']), d: Number(parts['day']) }, 'localDate');
}

/** How many calendar months the span from `from` to `to` touches, both ends included; 0 when `to` is before `from`. */
export function monthsBetween(from: string, to: string): number {
  const a = parse(from, 'monthsBetween');
  const b = parse(to, 'monthsBetween');
  if (dayNumber(b) < dayNumber(a)) return 0;
  return b.y * 12 + b.m - (a.y * 12 + a.m) + 1;
}

/** The month of `date`: `YYYY-MM`. */
export function monthOf(date: string): string {
  parse(date, 'monthOf');
  return date.slice(0, 7);
}

/** The last day of `month` (`YYYY-MM`). */
export function endOfMonth(month: string): string {
  const match = typeof month === 'string' ? MONTH.exec(month) : null;
  const y = match === null ? NaN : Number(match[1]);
  const m = match === null ? NaN : Number(match[2]);
  if (!(y >= 1 && m >= 1 && m <= 12)) throw new TypeError(`endOfMonth: not a month YYYY-MM: ${JSON.stringify(month)}`);
  return format({ y, m, d: monthDays(y, m) }, 'endOfMonth');
}
