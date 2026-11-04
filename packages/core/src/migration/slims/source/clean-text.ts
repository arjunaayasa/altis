// The text clean-up of the SLiMS migration (spec §11.5), applied per text value by the stages (Tasks 37, 38) and used
// by both sources so that a value read from a dump and the same value read from the database come out alike (K15):
//
//   1. NUL removed; SLiMS's stored backslashes before `'`, `"` and `\` removed (SLiMS escapes quotes before storing
//      them and strips the backslash only on display).
//   2. Double decoded UTF-8 ("mojibake": UTF-8 bytes once read as Latin-1 or Windows-1252, then stored as UTF-8)
//      reversed, accepted only when the result is valid and the pattern count drops.
//   3. Bytes that are not valid UTF-8 decoded as Windows-1252 for that value.
//   5. The first `(1[5-9]|20)\d{2}` of a free-text year.
//   6. Zero and invalid dates as null.
//
// Step 4 (PHP unserialize) is php-unserialize.ts. Both sources hand a text cell over as a string when its bytes are
// valid UTF-8 and as the raw bytes (a Uint8Array) when they are not (textCell), so step 3 runs in cleanText.
//
// Code points above U+007F are written as numbers in the code of this file.

/** A repair cleanText made (counted per column in the report, §11.5). */
export type SlimsTextFix = 'nul' | 'backslash' | 'mojibake' | 'cp1252';

const UTF8 = new TextDecoder('utf-8', { fatal: true, ignoreBOM: true });

/**
 * Windows-1252 bytes 0x80-0x9F as code points (WHATWG encoding standard: the five bytes Windows leaves undefined,
 * 0x81, 0x8D, 0x8F, 0x90 and 0x9D, stand for the C1 control of the same number). Every other byte is its own code point.
 */
const CP1252_HIGH: readonly number[] = [
  0x20ac, 0x81, 0x201a, 0x0192, 0x201e, 0x2026, 0x2020, 0x2021, 0x02c6, 0x2030, 0x0160, 0x2039, 0x0152, 0x8d, 0x017d, 0x8f,
  0x90, 0x2018, 0x2019, 0x201c, 0x201d, 0x2022, 0x2013, 0x2014, 0x02dc, 0x2122, 0x0161, 0x203a, 0x0153, 0x9d, 0x017e, 0x0178,
];

/** The byte a code point stands for in a Windows-1252 reading of a byte (besides 0x00-0xFF themselves). */
const CP1252_BYTE: ReadonlyMap<number, number> = new Map(CP1252_HIGH.map((code, i) => [code, 0x80 + i] as const));

/** The byte that a Latin-1 or Windows-1252 reading turned into the code unit `code`, or -1. */
function byteOf(code: number): number {
  if (code <= 0xff) return code;
  const b = CP1252_BYTE.get(code);
  return b === undefined ? -1 : b;
}

/**
 * `bytes` as text: UTF-8 when they are valid UTF-8 (a byte order mark is kept as U+FEFF), else each byte as
 * Windows-1252 (`cp1252: true`).
 */
export function decodeCell(bytes: Uint8Array): { value: string; cp1252: boolean } {
  try {
    return { value: UTF8.decode(bytes), cp1252: false };
  } catch {
    let value = '';
    for (let i = 0; i < bytes.length; i += 4096) {
      const codes: number[] = [];
      const end = Math.min(bytes.length, i + 4096);
      for (let j = i; j < end; j += 1) {
        const b = bytes[j]!;
        codes.push(b >= 0x80 && b <= 0x9f ? CP1252_HIGH[b - 0x80]! : b);
      }
      value += String.fromCharCode(...codes);
    }
    return { value, cp1252: true };
  }
}

/**
 * The cell a source hands over for the bytes of a text value: the text when the bytes are valid UTF-8, else a copy of
 * the bytes themselves (cleanText decodes them as Windows-1252 and reports `cp1252`).
 */
export function textCell(bytes: Uint8Array): string | Uint8Array {
  try {
    return UTF8.decode(bytes);
  } catch {
    return Uint8Array.from(bytes);
  }
}

/** One double decoded sequence found at `start`: its length in code units and the text it stands for. */
interface Sequence {
  length: number;
  text: string;
}

/**
 * The double decoded sequence starting at `start` of `s`: a lead (bytes 0xC2-0xF4) and the continuation bytes
 * (0x80-0xBF) its UTF-8 form needs, each read back through Latin-1 or Windows-1252, that decode as valid UTF-8 to
 * something other than a C0 or C1 control. Null when there is none.
 */
function sequenceAt(s: string, start: number): Sequence | null {
  const lead = byteOf(s.charCodeAt(start));
  const need = lead >= 0xc2 && lead <= 0xdf ? 1 : lead >= 0xe0 && lead <= 0xef ? 2 : lead >= 0xf0 && lead <= 0xf4 ? 3 : 0;
  if (need === 0 || start + need >= s.length) return null;
  const bytes = new Uint8Array(need + 1);
  bytes[0] = lead;
  for (let k = 1; k <= need; k += 1) {
    const b = byteOf(s.charCodeAt(start + k));
    if (b < 0x80 || b > 0xbf) return null;
    bytes[k] = b;
  }
  let text: string;
  try {
    text = UTF8.decode(bytes);
  } catch {
    return null;
  }
  const first = text.codePointAt(0)!;
  if (first < 0xa0) return null; // a C1 control (or less): not text anyone wrote
  return { length: need + 1, text };
}

/** The value with every double decoded sequence replaced by what it stands for, and how many there were. */
function reverseOnce(s: string): { value: string; count: number } {
  let out = '';
  let count = 0;
  let from = 0;
  for (let i = 0; i < s.length; ) {
    const seq = s.charCodeAt(i) >= 0x80 ? sequenceAt(s, i) : null;
    if (seq === null) {
      i += 1;
      continue;
    }
    out += s.slice(from, i) + seq.text;
    count += 1;
    i += seq.length;
    from = i;
  }
  return { value: count === 0 ? s : out + s.slice(from), count };
}

/** How many double decoded sequences `s` holds. */
function patternCount(s: string): number {
  return reverseOnce(s).count;
}

/**
 * Reverses a Latin-1 or Windows-1252 double decoding of UTF-8 in `s` ("CafÃ©" back to "Café"), sequence by sequence,
 * so the clean parts of a mixed value stay as they are. A value decoded twice over is reversed again, at most three
 * times in all. The result is accepted only when every reversed sequence is valid UTF-8 and the number of double
 * decoded sequences drops.
 *
 * @returns the repaired value, or null when there is nothing to repair
 */
export function fixMojibake(s: string): string | null {
  let value = s;
  let before = patternCount(value);
  if (before === 0) return null;
  for (let round = 0; round < 3 && before > 0; round += 1) {
    const next = reverseOnce(value).value;
    const after = patternCount(next);
    if (after >= before) break;
    value = next;
    before = after;
  }
  return value === s ? null : value;
}

/** A backslash before `'`, `"` or `\` (SLiMS's stored escaping). */
const STORED_ESCAPE = /\\(['"\\])/g;

/**
 * The §11.5 clean-up of one text value, steps 1-3: NUL removed and SLiMS's stored backslashes before `'`, `"` and
 * `\` removed (`nul`, `backslash`), double decoded UTF-8 reversed (`mojibake`, see {@link fixMojibake}), and bytes
 * that are not valid UTF-8 (a cell given as bytes) decoded as Windows-1252 (`cp1252`). Each repair made is listed
 * once, in that order.
 */
export function cleanText(v: string | Uint8Array): { value: string; fixes: SlimsTextFix[] } {
  let value: string;
  let cp1252 = false;
  if (typeof v === 'string') {
    value = v;
  } else {
    const decoded = decodeCell(v);
    value = decoded.value;
    cp1252 = decoded.cp1252;
  }
  const fixes: SlimsTextFix[] = [];
  const nul = String.fromCharCode(0);
  if (value.includes(nul)) {
    value = value.split(nul).join('');
    fixes.push('nul');
  }
  const unescaped = value.replace(STORED_ESCAPE, '$1');
  if (unescaped !== value) {
    value = unescaped;
    fixes.push('backslash');
  }
  const repaired = fixMojibake(value);
  if (repaired !== null) {
    value = repaired;
    fixes.push('mojibake');
  }
  if (cp1252) fixes.push('cp1252');
  return { value, fixes };
}

/** §11.5 step 5: the first four-digit year from 1500 to 2099 in a free-text year (`c1998?` → `1998`), or null. */
export function extractYear(text: string): string | null {
  const m = /(1[5-9]|20)\d{2}/.exec(text);
  return m === null ? null : m[0];
}

const DATE = /^(\d{4})-(\d{2})-(\d{2})(?:[ T](\d{2}):(\d{2})(?::(\d{2})(?:\.\d{1,6})?)?)?$/;

/**
 * §11.5 step 6: a MySQL date or date-time as `YYYY-MM-DD` or `YYYY-MM-DD HH:MM:SS`, or null for a zero date
 * (`0000-00-00`), a date that does not exist (`2020-02-30`, a month or day of 0), a year before 1000, or any other
 * text. Surrounding white space is ignored; fractions of a second are dropped.
 */
export function cleanDate(text: string): string | null {
  const m = DATE.exec(text.trim());
  if (m === null) return null;
  const year = Number(m[1]);
  const month = Number(m[2]);
  const day = Number(m[3]);
  if (year < 1000 || month < 1 || month > 12 || day < 1) return null;
  const leap = (year % 4 === 0 && year % 100 !== 0) || year % 400 === 0;
  const days = [31, leap ? 29 : 28, 31, 30, 31, 30, 31, 31, 30, 31, 30, 31][month - 1]!;
  if (day > days) return null;
  const date = `${m[1]}-${m[2]}-${m[3]}`;
  if (m[4] === undefined) return date;
  const hour = Number(m[4]);
  const minute = Number(m[5]);
  const second = m[6] === undefined ? 0 : Number(m[6]);
  if (hour > 23 || minute > 59 || second > 59) return null;
  return `${date} ${m[4]}:${m[5]}:${String(second).padStart(2, '0')}`;
}
