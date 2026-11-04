// Class numbers of call numbers (spec §3.4, shelf suggestion): `class_from <= class <= class_to`, compared over the
// normalised leading numeric part. The comparison is exact decimal arithmetic on the digit strings, never floating
// point. Pure; no database.

/** The first number of a call number: `899.221 TOE b` → `899.221`, `R 808.3` → `808.3`. */
const CLASS_NUMBER_RE = /\d+(?:\.\d+)?/;

/** A class number as digit strings: the integer part without leading zeros, the fraction as written. */
interface ClassNumber {
  int: string;
  frac: string;
}

function parseClass(s: string): ClassNumber | null {
  const m = CLASS_NUMBER_RE.exec(s);
  if (!m) return null;
  const [int = '', frac = ''] = m[0].split('.');
  return { int: int.replace(/^0+(?=\d)/, ''), frac };
}

/** Compares two class numbers: negative, 0 or positive. */
function compareClass(a: ClassNumber, b: ClassNumber): number {
  if (a.int.length !== b.int.length) return a.int.length - b.int.length;
  if (a.int !== b.int) return a.int < b.int ? -1 : 1;
  const width = Math.max(a.frac.length, b.frac.length);
  const fa = a.frac.padEnd(width, '0');
  const fb = b.frac.padEnd(width, '0');
  return fa === fb ? 0 : fa < fb ? -1 : 1;
}

/**
 * The leading numeric part of a call number as a number (`'899.221 TOE b'` → 899.221, `'R 808.3'` → 808.3, a prefix
 * such as `R` or `REF` skipped), or null when it holds no number.
 */
export function classNumberKey(callNo: string): number | null {
  const m = CLASS_NUMBER_RE.exec(callNo);
  if (!m) return null;
  const n = Number(m[0]);
  return Number.isFinite(n) ? n : null;
}

/**
 * Whether the class number of `callNo` lies in `[from, to]` (each bound read the same way as the call number). The
 * upper bound includes everything below it at its own precision: `809` covers `809.9`, `808.3` covers `808.37` but
 * not `808.4`. False when the call number or a bound holds no number.
 */
export function classInRange(callNo: string, from: string, to: string): boolean {
  const k = parseClass(callNo);
  const lo = parseClass(from);
  const hi = parseClass(to);
  if (!k || !lo || !hi) return false;
  if (compareClass(k, lo) < 0) return false;
  return compareClass({ int: k.int, frac: k.frac.slice(0, hi.frac.length) }, hi) <= 0;
}
