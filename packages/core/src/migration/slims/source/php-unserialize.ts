// PHP's serialize() format, read without PHP (spec §11.5 step 4; clean-room from the format's description). SLiMS
// stores several values this way: `biblio.labels`, `biblio_attachment.access_limit`, `mst_item_status.rules`,
// `mst_custom_field.data`, checklist custom values and most `setting.setting_value` rows.
//
// Types read: `a` (array), `s` (string; `s:<n>` counts UTF-8 bytes, not characters), `i` (integer), `d` (float), `b`
// (boolean) and `N` (null). Objects, references and custom serializations are not read. Values written by an older
// SLiMS often disagree with their own byte counts (text re-encoded after it was serialized), so a payload that does
// not parse whole is not guessed at: the caller gets the strings it quotes, and reports it.

/** How deep arrays may nest. */
const MAX_DEPTH = 64;
/** The longest digit run of a count or integer. */
const MAX_DIGITS = 20;

const UTF8 = new TextDecoder('utf-8', { fatal: true, ignoreBOM: true });
const UTF8_LENIENT = new TextDecoder('utf-8', { ignoreBOM: true });

const QUOTE = 0x22;
const SEMI = 0x3b;
const COLON = 0x3a;

/** Thrown inside the reader when the payload is not one well-formed value. */
class Broken extends Error {}

const BROKEN = new Broken('broken payload');

interface Cursor {
  buf: Uint8Array;
  pos: number;
}

function expect(c: Cursor, byte: number): void {
  if (c.buf[c.pos] !== byte) throw BROKEN;
  c.pos += 1;
}

/** The digits (with an optional leading `-` when `signed`) up to the next byte `end`, which is consumed. */
function digitsUntil(c: Cursor, end: number, signed: boolean): string {
  const start = c.pos;
  if (signed && c.buf[c.pos] === 0x2d) c.pos += 1;
  const first = c.pos;
  while (c.pos < c.buf.length && c.buf[c.pos]! >= 0x30 && c.buf[c.pos]! <= 0x39) {
    c.pos += 1;
    if (c.pos - first > MAX_DIGITS) throw BROKEN;
  }
  if (c.pos === first) throw BROKEN;
  const text = Buffer.from(c.buf.subarray(start, c.pos)).toString('latin1');
  expect(c, end);
  return text;
}

/** A count (`s:<n>:`, `a:<n>:`) that fits in what is left of the payload, else broken. */
function count(c: Cursor, perItem: number): number {
  const n = Number(digitsUntil(c, COLON, false));
  if (!Number.isSafeInteger(n) || n * perItem > c.buf.length - c.pos) throw BROKEN;
  return n;
}

function readString(c: Cursor): string {
  expect(c, COLON);
  const n = count(c, 1);
  expect(c, QUOTE);
  const end = c.pos + n;
  if (end + 2 > c.buf.length || c.buf[end] !== QUOTE || c.buf[end + 1] !== SEMI) throw BROKEN;
  let text: string;
  try {
    text = UTF8.decode(c.buf.subarray(c.pos, end));
  } catch {
    throw BROKEN;
  }
  c.pos = end + 2;
  return text;
}

function readInteger(c: Cursor): number | string {
  expect(c, COLON);
  const text = digitsUntil(c, SEMI, true);
  const n = Number(text);
  return Number.isSafeInteger(n) ? n : text.replace(/^(-?)0+(?=\d)/, '$1');
}

const FLOAT = /^-?(?:\d+(?:\.\d*)?|\.\d+)(?:[eE][+-]?\d+)?$/;

function readFloat(c: Cursor): number {
  expect(c, COLON);
  const start = c.pos;
  while (c.pos < c.buf.length && c.buf[c.pos] !== SEMI) {
    c.pos += 1;
    if (c.pos - start > 64) throw BROKEN;
  }
  const text = Buffer.from(c.buf.subarray(start, c.pos)).toString('latin1');
  expect(c, SEMI);
  if (text === 'INF') return Infinity;
  if (text === '-INF') return -Infinity;
  if (text === 'NAN') return NaN;
  if (!FLOAT.test(text)) throw BROKEN;
  return Number(text);
}

/** Sets `key` on a null-prototype object as an own property (`__proto__` included). */
function setOwn(target: Record<string, unknown>, key: string, value: unknown): void {
  Object.defineProperty(target, key, { value, enumerable: true, writable: true, configurable: true });
}

function readArray(c: Cursor, depth: number): unknown[] | Record<string, unknown> {
  if (depth >= MAX_DEPTH) throw BROKEN;
  expect(c, COLON);
  const n = count(c, 4); // the shortest pair is `i:0;N;` (6 bytes); 4 keeps the bound loose and safe
  expect(c, 0x7b);
  const keys: (number | string)[] = [];
  const values: unknown[] = [];
  for (let i = 0; i < n; i += 1) {
    const type = c.buf[c.pos];
    c.pos += 1;
    if (type === 0x69) {
      keys.push(readInteger(c));
    } else if (type === 0x73) {
      keys.push(readString(c));
    } else {
      throw BROKEN;
    }
    values.push(readValue(c, depth + 1));
  }
  expect(c, 0x7d);
  if (keys.every((key, i) => key === i)) return values;
  const object = Object.create(null) as Record<string, unknown>;
  keys.forEach((key, i) => setOwn(object, String(key), values[i]));
  return object;
}

function readValue(c: Cursor, depth: number): unknown {
  const type = c.buf[c.pos];
  c.pos += 1;
  switch (type) {
    case 0x4e: // N
      expect(c, SEMI);
      return null;
    case 0x62: {
      // b
      expect(c, COLON);
      const v = c.buf[c.pos];
      if (v !== 0x30 && v !== 0x31) throw BROKEN;
      c.pos += 1;
      expect(c, SEMI);
      return v === 0x31;
    }
    case 0x69: // i
      return readInteger(c);
    case 0x64: // d
      return readFloat(c);
    case 0x73: // s
      return readString(c);
    case 0x61: // a
      return readArray(c, depth);
    default:
      throw BROKEN;
  }
}

/** True for an ASCII digit. */
function isDigit(b: number | undefined): boolean {
  return b !== undefined && b >= 0x30 && b <= 0x39;
}

/**
 * The strings a broken payload quotes: for every `s:<n>:"`, its `n` bytes when they are followed by `";`, otherwise
 * the bytes up to the next `";` (or to the end of the payload, a trailing `"` dropped). Bytes that are not UTF-8
 * become U+FFFD.
 */
function quotedStrings(buf: Uint8Array): string[] {
  const out: string[] = [];
  for (let i = 0; i < buf.length; ) {
    if (buf[i] !== 0x73 || buf[i + 1] !== COLON) {
      i += 1;
      continue;
    }
    let j = i + 2;
    while (isDigit(buf[j]) && j - (i + 2) <= MAX_DIGITS) j += 1;
    const digits = j - (i + 2);
    if (digits === 0 || digits > MAX_DIGITS || buf[j] !== COLON || buf[j + 1] !== QUOTE) {
      i += 1;
      continue;
    }
    const n = Number(Buffer.from(buf.subarray(i + 2, j)).toString('latin1'));
    const start = j + 2;
    let end: number;
    let next: number;
    if (Number.isSafeInteger(n) && start + n + 2 <= buf.length && buf[start + n] === QUOTE && buf[start + n + 1] === SEMI) {
      end = start + n;
      next = end + 2;
    } else {
      end = -1;
      for (let k = start; k + 1 < buf.length; k += 1) {
        if (buf[k] === QUOTE && buf[k + 1] === SEMI) {
          end = k;
          break;
        }
      }
      if (end === -1) {
        end = buf.length > start && buf[buf.length - 1] === QUOTE ? buf.length - 1 : buf.length;
        next = buf.length;
      } else {
        next = end + 2;
      }
    }
    out.push(UTF8_LENIENT.decode(buf.subarray(start, end)));
    i = next;
  }
  return out;
}

/**
 * Reads a PHP-serialized value. An array whose keys are 0, 1, 2, ... in order becomes a list; any other array becomes
 * an object without a prototype (so a key such as `__proto__` stays a plain key). An integer outside the safe range
 * stays its digits (a string). A payload that is not one well-formed value, with nothing after it, gives back the
 * strings it quotes instead (`ok: false`), for the caller to report.
 */
export function phpUnserialize(s: string): { ok: true; value: unknown } | { ok: false; strings: string[] } {
  if (typeof s !== 'string') return { ok: false, strings: [] };
  const buf = new Uint8Array(Buffer.from(s, 'utf8'));
  const c: Cursor = { buf, pos: 0 };
  try {
    const value = readValue(c, 0);
    if (c.pos !== buf.length) throw BROKEN;
    return { ok: true, value };
  } catch (error) {
    if (!(error instanceof Broken)) throw error;
    return { ok: false, strings: quotedStrings(buf) };
  }
}
