import { createHash } from 'node:crypto';
import { barcodeProblem, normalizeBarcode } from '../../../catalog/lib/barcode.js';

// SLiMS item codes as ALTIS barcodes (Phase 2 spec §11.4 row `item`, §3.4; plan Task 38). Pure; the items
// stage then makes a barcode unique against the catalogue (`withBarcodeSuffix`).
//
// - The code is normalised as every barcode is (normalizeBarcode: CR/LF/TAB removed, trimmed, inner spaces collapsed,
//   ASCII upper case).
// - 1–2 characters of 0x20–0x7E are kept, flagged `nonstandard` (§11.4: "panjang 1–2 diterima dengan tanda").
// - Empty → `MIG<item_id>`; characters outside 0x20–0x7E, more than 64 characters, or a valid ISBN-13 (which a scanner
//   would read as the book's ISBN, §3.4) → `MIG<item_id>`, the original kept for `status_note`.

/** A barcode holds at most this many characters (§3.4). */
export const BARCODE_MAX = 64;

/** What a SLiMS item code becomes. */
export type SlimsBarcode =
  | { barcode: string; outcome: 'ok' | 'nonstandard'; original: null }
  | { barcode: string; outcome: 'replaced'; reason: 'empty' | 'charset' | 'length' | 'isbn_not_barcode'; original: string | null };

/** `MIG<key>` for item `itemKey` (a SLiMS id: digits), or `MIG<hash>` when the key would not make a barcode. */
export function migBarcode(itemKey: string): string {
  const plain = `MIG${itemKey}`;
  if (/^[\x21-\x7E]+$/.test(itemKey) && barcodeProblem(normalizeBarcode(plain)) === null) return normalizeBarcode(plain);
  return `MIG${createHash('sha256').update(itemKey, 'utf8').digest('hex').slice(0, 20).toUpperCase()}`;
}

/** Whether every character of `s` is printable ASCII (0x20–0x7E). */
function printable(s: string): boolean {
  for (let i = 0; i < s.length; i += 1) {
    const c = s.charCodeAt(i);
    if (c < 0x20 || c > 0x7e) return false;
  }
  return true;
}

/** The barcode SLiMS item code `raw` (cleaned text) of item `itemKey` becomes (see the top of this file). */
export function slimsBarcode(raw: string, itemKey: string): SlimsBarcode {
  const normal = normalizeBarcode(raw);
  if (normal === '') return { barcode: migBarcode(itemKey), outcome: 'replaced', reason: 'empty', original: null };
  const original = raw.trim();
  if (normal.length <= 2) {
    return printable(normal)
      ? { barcode: normal, outcome: 'nonstandard', original: null }
      : { barcode: migBarcode(itemKey), outcome: 'replaced', reason: 'charset', original };
  }
  const problem = barcodeProblem(normal);
  if (problem === null) return { barcode: normal, outcome: 'ok', original: null };
  return { barcode: migBarcode(itemKey), outcome: 'replaced', reason: problem, original };
}

/**
 * `base` with the suffix `-<n>` (n ≥ 2) that tells two items apart once their codes normalised alike (§11.4), cut so
 * that the whole stays within 64 characters and never ends in a blank.
 */
export function withBarcodeSuffix(base: string, n: number): string {
  const suffix = `-${n}`;
  return `${base.slice(0, BARCODE_MAX - suffix.length).trimEnd()}${suffix}`;
}
