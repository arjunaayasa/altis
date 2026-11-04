// Item barcodes (spec §3.4; decision P2-08). The server and any client that scans barcodes normalise the same way,
// so a hash computed on both sides agrees. `barcode_key` is the normalised value. Pure; no database.

import { isValidIsbn13Barcode } from './identifiers.js';

const BARCODE_MIN = 3;
const BARCODE_MAX = 64;

/** Characters trimmed at both ends: C0 controls, space and DEL. */
function trimmed(c: number): boolean {
  return c <= 0x20 || c === 0x7f;
}

/**
 * The normalisation of spec §3.4 (a scanner's AIM-prefix step is a device setting and does not apply here):
 * 1. remove CR, LF and TAB wherever they are;
 * 2. trim characters <= 0x20 and 0x7F at both ends;
 * 3. collapse each inner run of spaces to one space (P2-08: `'b 00  12'` → `'B 00 12'`; the space is not removed);
 * 4. upper-case `a`-`z` (ASCII only).
 * Other characters are kept as they are, for barcodeProblem to refuse.
 */
export function normalizeBarcode(raw: string): string {
  const s = raw.replace(/[\r\n\t]/g, '');
  let start = 0;
  let end = s.length;
  while (start < end && trimmed(s.charCodeAt(start))) start++;
  while (end > start && trimmed(s.charCodeAt(end - 1))) end--;
  return s
    .slice(start, end)
    .replace(/ {2,}/g, ' ')
    .replace(/[a-z]/g, (c) => c.toUpperCase());
}

/**
 * Why a normalised barcode cannot be stored, or null: `length` outside 3-64, `charset` for a character outside
 * 0x20-0x7E, `isbn_not_barcode` for a valid ISBN-13 starting 978/979 (VALIDATION_FAILED `{path: 'barcode', code}`).
 */
export function barcodeProblem(normalized: string): null | 'length' | 'charset' | 'isbn_not_barcode' {
  if (normalized.length < BARCODE_MIN || normalized.length > BARCODE_MAX) return 'length';
  for (let i = 0; i < normalized.length; i++) {
    const c = normalized.charCodeAt(i);
    if (c < 0x20 || c > 0x7e) return 'charset';
  }
  return isValidIsbn13Barcode(normalized) ? 'isbn_not_barcode' : null;
}
