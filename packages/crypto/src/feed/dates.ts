/**
 * Calendar days of the update feed and the release manifest: `YYYY-MM-DD` in Asia/Jakarta, UTC+7 without daylight
 * saving (the install timezone). A release's `releasedAt` is such a day.
 */

/** Asia/Jakarta's offset from UTC: seven hours, all year. */
const JAKARTA_OFFSET_MS = 7 * 3_600_000;

const DATE = /^(\d{4})-(\d{2})-(\d{2})$/;

/** Midnight UTC of a day, or NaN when the text is not a real calendar day. */
function utcMidnight(value: unknown): number {
  const m = typeof value === 'string' ? DATE.exec(value) : null;
  if (m === null) return Number.NaN;
  const year = Number(m[1]);
  const month = Number(m[2]);
  const day = Number(m[3]);
  const date = new Date(0);
  date.setUTCFullYear(year, month - 1, day); // Date.UTC would map years 0-99 to 1900-1999
  if (date.getUTCFullYear() !== year || date.getUTCMonth() !== month - 1 || date.getUTCDate() !== day) return Number.NaN;
  return date.getTime();
}

/** A real calendar day as `YYYY-MM-DD` (four-digit year; `2027-02-29` is not one). */
export function isCalendarDate(value: unknown): value is string {
  return !Number.isNaN(utcMidnight(value));
}

const pad = (n: number, width: number): string => {
  let s = String(n);
  while (s.length < width) s = '0' + s;
  return s;
};

/**
 * The Jakarta calendar day (`YYYY-MM-DD`) of the instant `ms`.
 * @throws TypeError when `ms` is not a finite instant whose year has four digits
 */
export function jakartaDate(ms: number): string {
  if (typeof ms !== 'number' || !Number.isFinite(ms)) throw new TypeError('jakartaDate: not an instant: ' + String(ms));
  const date = new Date(ms + JAKARTA_OFFSET_MS);
  const year = date.getUTCFullYear();
  if (Number.isNaN(year) || year < 0 || year > 9999) throw new TypeError('jakartaDate: out of range: ' + String(ms));
  return pad(year, 4) + '-' + pad(date.getUTCMonth() + 1, 2) + '-' + pad(date.getUTCDate(), 2);
}
