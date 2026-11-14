import { normalizeBarcode } from '../catalog/lib/barcode.js';

// The keys of a member: the member number and the name. Pure; no database.
//
// - A member number is normalised exactly like an item barcode (normalizeBarcode: CR, LF and TAB removed, both ends
//   trimmed, every inner run of spaces one space, ASCII letters upper case), so a scanned card and a typed number
//   agree: `b 001`, ` B  001 ` and `B 001` are one number, while `B001` is another (the inner space is kept). The
//   normal form is both `member_no_display` and `member_no_key`; it holds 1-64 characters of 0x20-0x7E.
// - The name key sorts and searches names: compatibility decomposition, the combining marks removed, lower case, every
//   run of white space one space, trimmed, at most 191 code points (a key191() column).

/** The most characters of a member number (`member_no_display` is VARCHAR 64). */
export const MEMBER_NO_MAX_LENGTH = 64;

/** The most code points of `name_key`. */
const NAME_KEY_MAX = 191;

/** A raw member number in its normal form (see the top of this file). */
export function normalizeMemberNo(raw: string): string {
  return normalizeBarcode(raw);
}

/** `invalid` when a normalised member number cannot be stored (empty, longer than 64, a character outside 0x20-0x7E). */
export function memberNoProblem(normalized: string): 'invalid' | null {
  if (normalized.length < 1 || normalized.length > MEMBER_NO_MAX_LENGTH) return 'invalid';
  for (let i = 0; i < normalized.length; i++) {
    const c = normalized.charCodeAt(i);
    if (c < 0x20 || c > 0x7e) return 'invalid';
  }
  return null;
}

/** The sort and search key of a name (see the top of this file). */
export function memberNameKey(name: string): string {
  const key = name
    .normalize('NFKD')
    .replace(/\p{M}+/gu, '')
    .toLowerCase()
    .replace(/\s+/gu, ' ')
    .trim();
  const points = Array.from(key);
  return points.length <= NAME_KEY_MAX ? key : points.slice(0, NAME_KEY_MAX).join('').trimEnd();
}

/** The words of a search text as name-key words (empty words dropped). */
export function nameKeyWords(q: string): string[] {
  return memberNameKey(q)
    .split(' ')
    .filter((w) => w !== '');
}
