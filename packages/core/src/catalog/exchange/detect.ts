import type { ImportFormat } from '@altis/shared';
import { createCsvReader } from '../csv/reader.js';
import { isSlimsCsvHeader, SLIMS_ITEM_COLUMNS, SLIMS_RECORD_COLUMNS } from '../csv/slims.js';

// The format of an import file, detected from its first bytes (Phase 2 spec §5.3: "terdeteksi otomatis bila kosong";
// plan Task 31). The head is untrusted: nothing here allocates more than the head, and no regular expression runs over
// more than one tag.
//
// - ISO 2709: a leader (record length and base address as digits, a base address that ends a whole directory), and
//   the field terminator before the base address when the head holds it → `marc21`.
// - XML: after an optional BOM, the XML declaration, comments and a DOCTYPE (left for the reader to refuse), the root
//   element whose prefix is bound to the MARC 21 slim namespace → `marcxml`; any other root is read as CSV below (a
//   SLiMS row may start with `<`), which an XML document never passes.
// - CSV (the first row, read by the import's own CSV reader): the SLiMS export headers → `csv-slims` /
//   `csv-slims-items`; a header naming `title` → `csv-records`, naming `barcode` → `csv-items`; a headerless row of 18
//   cells → `csv-slims`, of 19 → `csv-slims-items` (a WinISIS row ends in a 19th cell `#`: `csv-slims`).
// - Anything else → null (the caller answers CATALOG_IMPORT_FORMAT).

/** How many bytes of the file the detection reads. */
export const IMPORT_DETECT_BYTES = 65_536;

const MARCXML_NS = 'http://www.loc.gov/MARC21/slim';
const FIELD_TERMINATOR = 0x1e;

function isDigit(b: number | undefined): boolean {
  return b !== undefined && b >= 0x30 && b <= 0x39;
}

/** The number written by the ASCII digits `head[from, to)`, or -1. */
function digits(head: Uint8Array, from: number, to: number): number {
  let n = 0;
  for (let i = from; i < to; i += 1) {
    if (!isDigit(head[i])) return -1;
    n = n * 10 + (head[i]! - 0x30);
  }
  return n;
}

/** Whether `head` starts like an ISO 2709 record. */
function looksIso2709(head: Uint8Array): boolean {
  if (head.length < 24) return false;
  const length = digits(head, 0, 5);
  const base = digits(head, 12, 17);
  if (length < 0 || base < 0) return false;
  // A leader, at least one directory entry of 12 bytes, the field terminator; inside the record.
  if (base < 37 || (base - 25) % 12 !== 0 || base > length) return false;
  for (let i = 5; i < 24; i += 1) if (head[i]! < 0x20 || head[i]! > 0x7e) return false;
  return head.length < base || head[base - 1] === FIELD_TERMINATOR;
}

/** The text of `head` as UTF-8 (a broken sequence at the cut becomes U+FFFD; only ASCII markup is read). */
function headText(head: Uint8Array): string {
  return new TextDecoder('utf-8', { fatal: false }).decode(head);
}

/**
 * Whether the head is XML whose root is in the MARC namespace: `marc`, another root (`other`), or not XML at all
 * (null). A root tag not complete within the head is `other`.
 */
function xmlRoot(head: Uint8Array): 'marc' | 'other' | null {
  const text = headText(head);
  let i = text.charCodeAt(0) === 0xfeff ? 1 : 0;
  const skipSpace = () => {
    while (i < text.length && /\s/.test(text[i]!)) i += 1;
  };
  skipSpace();
  if (text[i] !== '<') return null;
  for (;;) {
    skipSpace();
    if (text.startsWith('<?', i)) {
      const end = text.indexOf('?>', i + 2);
      if (end < 0) return 'other';
      i = end + 2;
    } else if (text.startsWith('<!--', i)) {
      const end = text.indexOf('-->', i + 4);
      if (end < 0) return 'other';
      i = end + 3;
    } else if (text.startsWith('<!', i)) {
      // A DOCTYPE (with an internal subset in brackets): the reader refuses it; here it is only stepped over.
      let depth = 0;
      let j = i + 2;
      for (; j < text.length; j += 1) {
        const c = text[j];
        if (c === '[') depth += 1;
        else if (c === ']') depth -= 1;
        else if (c === '>' && depth <= 0) break;
      }
      if (j >= text.length) return 'other';
      i = j + 1;
    } else break;
  }
  if (text[i] !== '<') return 'other';
  const end = text.indexOf('>', i);
  if (end < 0) return 'other';
  const tag = text.slice(i + 1, end);
  const name = /^[A-Za-z_][\w.:-]*/.exec(tag)?.[0];
  if (name === undefined) return 'other';
  const colon = name.indexOf(':');
  const prefix = colon < 0 ? '' : name.slice(0, colon);
  const wanted = prefix === '' ? 'xmlns' : `xmlns:${prefix}`;
  return attributeIs(tag, name.length, wanted, MARCXML_NS) ? 'marc' : 'other';
}

/**
 * Whether the start tag `tag` (its text between `<` and `>`), read from `from` (after its name), has the attribute
 * `name` with the value `value`. A scan, each character looked at once: an attribute regex retries a long run of name
 * characters from each of its starts (quadratic over a 64 KiB tag). Anything that is not `name = "value"` (or `'…'`)
 * ends the scan.
 */
function attributeIs(tag: string, from: number, name: string, value: string): boolean {
  const space = (c: string | undefined) => c !== undefined && /\s/.test(c);
  let i = from;
  for (;;) {
    while (space(tag[i])) i += 1;
    const start = i;
    if (i < tag.length && /[A-Za-z_]/.test(tag[i]!)) {
      i += 1;
      while (i < tag.length && /[\w.:-]/.test(tag[i]!)) i += 1;
    }
    if (i === start) return false;
    const attribute = tag.slice(start, i);
    while (space(tag[i])) i += 1;
    if (tag[i] !== '=') return false;
    i += 1;
    while (space(tag[i])) i += 1;
    const quote = tag[i];
    if (quote !== '"' && quote !== "'") return false;
    const close = tag.indexOf(quote, i + 1);
    if (close < 0) return false;
    if (attribute === name && tag.slice(i + 1, close) === value) return true;
    i = close + 1;
  }
}

/** The CSV format of the first row of `head`, or null. */
function csvFormat(head: Uint8Array): ImportFormat | null {
  let rows;
  try {
    const reader = createCsvReader();
    rows = [...reader.push(head), ...reader.end()];
  } catch {
    return null;
  }
  const first = rows.find((r) => r.error === undefined && r.cells.some((c) => c.trim() !== ''));
  if (first === undefined) return null;
  const cells = first.cells;
  if (isSlimsCsvHeader(cells, 'records')) return 'csv-slims';
  if (isSlimsCsvHeader(cells, 'items')) return 'csv-slims-items';
  const names = new Set(cells.map((c) => c.trim().toLowerCase()));
  if (names.has('title')) return 'csv-records';
  if (names.has('barcode')) return 'csv-items';
  if (cells.length === SLIMS_RECORD_COLUMNS.length) return 'csv-slims';
  if (cells.length === SLIMS_ITEM_COLUMNS.length) return cells[cells.length - 1]!.trim() === '#' ? 'csv-slims' : 'csv-slims-items';
  return null;
}

/**
 * The import format of a file from its first bytes (at most {@link IMPORT_DETECT_BYTES} are looked at), or null when
 * it is none of them (see the top of this file).
 */
export function detectImportFormat(head: Uint8Array): ImportFormat | null {
  const bytes = head.length > IMPORT_DETECT_BYTES ? head.subarray(0, IMPORT_DETECT_BYTES) : head;
  if (bytes.length === 0) return null;
  if (looksIso2709(bytes)) return 'marc21';
  if (xmlRoot(bytes) === 'marc') return 'marcxml';
  // Another XML root, or a CSV whose first cell starts with `<` (a SLiMS `<a><b>` list): the CSV reading decides.
  return csvFormat(bytes);
}
