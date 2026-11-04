/**
 * Field checks shared by the feed and signed-document validators of `@altis/crypto/feed` (internal, not exported from
 * the subpath). Hand-written, like keyset.ts: `@altis/crypto` has no dependency, so no Zod.
 *
 * Lengths count code points, as Zod and VARCHAR do (the settings registry's bounds, ruling R1d-2), and every text must
 * be well-formed UTF-16: a lone surrogate can never be signed (JCS refuses it), so it is refused here too.
 */

export function isRecord(value: unknown): value is Record<string, unknown> {
  return value !== null && typeof value === 'object' && !Array.isArray(value);
}

function hasOwn(o: object, key: string): boolean {
  return Object.prototype.hasOwnProperty.call(o, key);
}

/** The number of code points of `s`, a lone surrogate counting as one (as `Array.from(s).length`). */
function codePointLength(s: string): number {
  let n = 0;
  for (let i = 0; i < s.length; i++) {
    const c = s.charCodeAt(i);
    if (c >= 0xd800 && c <= 0xdbff && i + 1 < s.length) {
      const d = s.charCodeAt(i + 1);
      if (d >= 0xdc00 && d <= 0xdfff) i++;
    }
    n++;
  }
  return n;
}

/** No lone surrogate. */
function isWellFormed(s: string): boolean {
  for (let i = 0; i < s.length; i++) {
    const c = s.charCodeAt(i);
    if (c < 0xd800 || c > 0xdfff) continue;
    if (c > 0xdbff || i + 1 >= s.length) return false;
    const d = s.charCodeAt(i + 1);
    if (d < 0xdc00 || d > 0xdfff) return false;
    i++;
  }
  return true;
}

/** A well-formed string of `min` to `max` code points. */
export function isText(value: unknown, min: number, max: number): value is string {
  if (typeof value !== 'string' || !isWellFormed(value)) return false;
  // The code unit count bounds the code point count from above, and from below at half: skip the count when it decides.
  if (value.length < min || value.length > 2 * max) return false;
  const n = codePointLength(value);
  return n >= min && n <= max;
}

export function isSafeInteger(value: unknown, min: number): value is number {
  return typeof value === 'number' && Number.isSafeInteger(value) && value >= min;
}

const SHA256_HEX = /^[0-9a-f]{64}$/;

/** A SHA-256 as 64 lower-case hex digits (what `digest('hex')` writes). */
export function isSha256Hex(value: unknown): value is string {
  return typeof value === 'string' && SHA256_HEX.test(value);
}

/** The keys of `value` are exactly `keys` (in any order). */
export function hasExactKeys(value: Record<string, unknown>, keys: readonly string[]): boolean {
  const own = Object.keys(value);
  if (own.length !== keys.length) return false;
  for (const key of keys) if (!hasOwn(value, key)) return false;
  return true;
}
