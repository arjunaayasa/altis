// ISO 2709 (MARC 21 exchange format; Phase 2 spec §5.1, Review Focus 5, S9). Input is an untrusted file:
// - Records are split on the record terminator 0x1D, never on the leader's record length alone. A record that
//   disagrees with its leader is read anyway and flagged `leader_length`; a field or a record without its terminator
//   is read and flagged `missing_terminator` (two records joined by a lost 0x1D are told apart when a leader follows
//   the first one's directory extent and either leader length agrees); a record whose directory is broken is skipped
//   (`directory`) and the next one is read, even when the broken one lost its terminator (a record whose own leader
//   length reaches the 0x1D is found inside the bytes).
// - Bounded (S9): once 100 000 bytes have arrived without a 0x1D, the record is reported `truncated`, what is held is
//   dropped and the bytes up to the next 0x1D are skipped. A valid record is at most 99 999 bytes.
// - Text: leader/09 `a` is UTF-8 (bytes that are not UTF-8 → `encoding`); anything else is MARC-8, unless the data
//   is valid UTF-8 holding multibyte characters (a mislabelled UTF-8 record: decoding it as MARC-8 would store
//   mojibake silently).
// - Bounded memory: the reader keeps copies of at most about 100 000 bytes; while it skips a truncated record it keeps
//   the last 99 999 bytes, where a good record whose own leader length reaches the next 0x1D is still found.
// Output is always UTF-8 with leader/09 `a` (and the structure positions 10-11 `22`, 20-23 `4500`); a record above
// 99 999 bytes or a field above 9 999 bytes throws MarcTooLongError. Pure; no I/O.

import { createMarc8Decoder } from './marc8.js';
import {
  MARC_RECORD_MAX,
  MARC_TAG_RE,
  MarcTooLongError,
  isControlField,
  isControlTag,
  marcIndicator,
  unicodeLeader,
  type MarcControlField,
  type MarcDataField,
  type MarcReadResult,
  type MarcReadWarning,
  type MarcRecord,
} from './record.js';

const RECORD_TERMINATOR = 0x1d;
const FIELD_TERMINATOR = 0x1e;
const SUBFIELD_DELIMITER = 0x1f;

/** A record without a terminator is given up after this many bytes (S9). */
export const ISO2709_HOLD_MAX = 100_000;

/** The directory gives a field four digits of length. */
const FIELD_MAX = 9_999;

/** Bytes skipped before a record: line breaks, spaces, NUL and ^Z that some tools write between records. */
function isJunk(b: number): boolean {
  return b === 0x0a || b === 0x0d || b === 0x20 || b === 0x00 || b === 0x1a;
}

const WARNING_ORDER: readonly MarcReadWarning[] = ['leader_length', 'marc8_replaced', 'missing_terminator'];

const utf8Fatal = new TextDecoder('utf-8', { fatal: true, ignoreBOM: true });
const utf8Encoder = new TextEncoder();

/** The ASCII digits `bytes[from..to)` as a number, or -1. */
function digitsAt(bytes: Uint8Array, from: number, to: number): number {
  let n = 0;
  for (let i = from; i < to; i++) {
    const b = bytes[i];
    if (b === undefined || b < 0x30 || b > 0x39) return -1;
    n = n * 10 + (b - 0x30);
  }
  return n;
}

/** The parts joined into one array. */
function concatBytes(parts: readonly Uint8Array[]): Uint8Array {
  const out = new Uint8Array(parts.reduce((n, p) => n + p.length, 0));
  let at = 0;
  for (const p of parts) {
    out.set(p, at);
    at += p.length;
  }
  return out;
}

function latin1(bytes: Uint8Array, from: number, to: number): string {
  let s = '';
  for (let i = from; i < to; i++) s += String.fromCharCode(bytes[i]!);
  return s;
}

/** Whether `bytes[at..at+24)` reads as a leader: printable ASCII, digits at 00-04 and 12-16. */
function looksLikeLeader(bytes: Uint8Array, at: number): boolean {
  if (bytes.length - at < 25) return false;
  for (let i = at; i < at + 24; i++) if (bytes[i]! < 0x20 || bytes[i]! > 0x7e) return false;
  return digitsAt(bytes, at, at + 5) >= 0 && digitsAt(bytes, at + 12, at + 17) >= 0;
}

/** Whether `bytes[from..to)` holds a byte above 0x7F and is valid UTF-8 throughout. */
function isMultibyteUtf8(bytes: Uint8Array, from: number, to: number): boolean {
  let high = false;
  for (let i = from; i < to; i++) {
    if (bytes[i]! >= 0x80) {
      high = true;
      break;
    }
  }
  if (!high) return false;
  try {
    utf8Fatal.decode(bytes.subarray(from, to));
    return true;
  } catch {
    return false;
  }
}

type Parsed =
  | { ok: true; record: MarcRecord; warnings: MarcReadWarning[]; split?: number }
  | { ok: false; error: 'directory' | 'encoding' };

class EncodingError extends Error {}

/**
 * One record's bytes (without the record terminator) → the record. `split` is set when the bytes hold a second
 * record after this one (a lost 0x1D): this record ends there.
 */
function parseRecord(r: Uint8Array, hadTerminator: boolean): Parsed {
  const warnings = new Set<MarcReadWarning>();
  if (r.length < 25) return { ok: false, error: 'directory' };
  for (let i = 0; i < 24; i++) if (r[i]! < 0x20 || r[i]! > 0x7e) return { ok: false, error: 'directory' };
  const leader = latin1(r, 0, 24);
  const dirEnd = r.indexOf(FIELD_TERMINATOR, 24);
  if (dirEnd < 0 || (dirEnd - 24) % 12 !== 0) return { ok: false, error: 'directory' };
  const base = dirEnd + 1;
  if (digitsAt(r, 12, 17) !== base) warnings.add('leader_length');

  const entries: { tag: string; from: number; to: number }[] = [];
  let extent = base;
  for (let e = 24; e < dirEnd; e += 12) {
    const tag = latin1(r, e, e + 3);
    const len = digitsAt(r, e + 3, e + 7);
    const start = digitsAt(r, e + 7, e + 12);
    if (!MARC_TAG_RE.test(tag) || len <= 0 || start < 0) return { ok: false, error: 'directory' };
    const from = base + start;
    let to = from + len;
    if (from >= r.length) return { ok: false, error: 'directory' };
    // A field that runs one byte past the record is the last one, its terminator missing.
    if (to === r.length + 1) to = r.length;
    else if (to > r.length) return { ok: false, error: 'directory' };
    extent = Math.max(extent, to);
    entries.push({ tag, from, to });
  }

  // A lost record terminator: a leader right after the directory's extent, and either this record's leader length
  // ends there or the next record's leader length reaches exactly the end of the bytes.
  const declared = digitsAt(r, 0, 5);
  let split: number | undefined;
  let size = r.length;
  if (looksLikeLeader(r, extent) && (declared === extent + 1 || digitsAt(r, extent, extent + 5) === r.length - extent + 1)) {
    split = extent;
    size = extent;
    warnings.add('missing_terminator');
    if (declared !== extent + 1) warnings.add('leader_length');
  } else {
    if (!hadTerminator) warnings.add('missing_terminator');
    if (declared !== r.length + 1) warnings.add('leader_length');
  }

  // An escape sequence only exists in MARC-8: such a record is MARC-8 even when its bytes happen to be valid UTF-8.
  const utf8 = leader[9] === 'a' || (isMultibyteUtf8(r, base, size) && !r.subarray(base, size).includes(0x1b));
  let replaced = 0;
  try {
    const fields: (MarcControlField | MarcDataField)[] = [];
    for (const { tag, from, to } of entries) {
      let end = to;
      if (r[end - 1] === FIELD_TERMINATOR) end--;
      else warnings.add('missing_terminator');
      const content = r.subarray(from, end);
      if (content.includes(FIELD_TERMINATOR) || content.includes(RECORD_TERMINATOR)) return { ok: false, error: 'directory' };
      const marc8 = utf8 ? null : createMarc8Decoder();
      const text = (bytes: Uint8Array): string => {
        if (marc8) return marc8.decode(bytes);
        try {
          return utf8Fatal.decode(bytes);
        } catch {
          throw new EncodingError();
        }
      };
      if (isControlTag(tag)) fields.push({ tag, value: text(content) });
      else {
        const field = dataField(tag, content, text);
        if (field === null) return { ok: false, error: 'directory' };
        fields.push(field);
      }
      replaced += marc8?.replaced ?? 0;
    }
    if (replaced > 0) warnings.add('marc8_replaced');
    const record: MarcRecord = { leader, fields };
    const ordered = WARNING_ORDER.filter((w) => warnings.has(w));
    return split === undefined ? { ok: true, record, warnings: ordered } : { ok: true, record, warnings: ordered, split };
  } catch (e) {
    if (e instanceof EncodingError) return { ok: false, error: 'encoding' };
    throw e;
  }
}

/** A data field's content (indicators, then 0x1F-delimited subfields) → the field; null when a code is unusable. */
function dataField(tag: string, content: Uint8Array, text: (bytes: Uint8Array) => string): MarcDataField | null {
  // Missing indicators (a delimiter in their place) read as blanks.
  let at = 0;
  const ind: string[] = [];
  while (ind.length < 2 && at < content.length && content[at] !== SUBFIELD_DELIMITER) {
    const b = content[at]!;
    ind.push(b >= 0x20 && b <= 0x7e ? String.fromCharCode(b) : ' ');
    at++;
  }
  const subfields: [string, string][] = [];
  let next = content.indexOf(SUBFIELD_DELIMITER, at);
  while (next >= 0) {
    const start = next + 1;
    next = content.indexOf(SUBFIELD_DELIMITER, start);
    const end = next < 0 ? content.length : next;
    if (end === start) continue; // an empty delimiter
    const code = content[start]!;
    if (code < 0x21 || code > 0x7e) return null;
    subfields.push([String.fromCharCode(code), text(content.subarray(start + 1, end))]);
  }
  return { tag, ind1: ind[0] ?? ' ', ind2: ind[1] ?? ' ', subfields };
}

/** How many candidates anchoredRecord parses at most: the scan stays linear whatever the bytes hold. */
const ANCHOR_ATTEMPTS = 8;

/**
 * Where a record starts inside `bytes` (from `from` on) when the bytes before it belong to something unreadable: a
 * leader whose record length reaches exactly the end of `bytes` (the terminator follows, or is missing at the end of
 * the input), whose base address is the end of its directory, and that parses. -1 when there is none. The input is
 * untrusted, so this only recovers a record whose own leader, directory and length all agree, and it parses at most
 * ANCHOR_ATTEMPTS candidates.
 */
function anchoredRecord(bytes: Uint8Array, from: number, hadTerminator: boolean): number {
  let attempts = 0;
  let dirEnd = bytes.indexOf(FIELD_TERMINATOR, from + 24);
  for (let p = from; p + 25 <= bytes.length && dirEnd >= 0; p++) {
    if (digitsAt(bytes, p, p + 5) !== bytes.length - p + 1) continue;
    while (dirEnd >= 0 && dirEnd < p + 24) dirEnd = bytes.indexOf(FIELD_TERMINATOR, dirEnd + 1);
    if (dirEnd < 0) break;
    if ((dirEnd - p - 24) % 12 !== 0 || digitsAt(bytes, p + 12, p + 17) !== dirEnd - p + 1 || !looksLikeLeader(bytes, p)) continue;
    if (parseRecord(bytes.subarray(p), hadTerminator).ok) return p;
    if (++attempts >= ANCHOR_ATTEMPTS) break;
  }
  return -1;
}

/** A record result of a reader, with its absolute byte offsets. */
export type Iso2709Result = MarcReadResult & { startByte: number; endByte: number };

/** The bytes kept while a truncated record is skipped: enough for the largest record that may follow it. */
const TAIL_MAX = ISO2709_HOLD_MAX - 1;

/**
 * A streaming ISO 2709 reader. push() takes the next bytes and returns the records they completed; end() reads what
 * is left (a final record without its terminator). Each result carries its byte offsets in the input
 * (`o.baseOffset` + bytes pushed: `[startByte, endByte)`); the results tile the input (separators between records
 * aside), so a caller can checkpoint after any result and resume at its `endByte`.
 * - A record that reaches 100 000 bytes without a terminator is `truncated` (S9): its bytes are dropped up to the
 *   next 0x1D, keeping only the last 99 999 of them, where a good record that lost no terminator of its own may begin
 *   (its leader length reaches exactly that 0x1D). The `truncated` result comes once its end is known (that 0x1D, the
 *   start of such a record, or the end of the input), so its `endByte` is a record boundary.
 * - It holds at most about 100 000 bytes, always its own copies (a caller may reuse the buffer it pushed).
 * `consumedBytes()` counts the bytes the reader no longer holds (pushed minus held).
 */
export function readIso2709(o?: { baseOffset?: number }): {
  push(chunk: Uint8Array): Iso2709Result[];
  end(): Iso2709Result[];
  consumedBytes(): number;
} {
  const baseOffset = o?.baseOffset ?? 0;
  /** The record being read (copies), and its size. */
  let held: Uint8Array[] = [];
  let heldBytes = 0;
  /** After 100 000 bytes without a terminator: bytes are dropped up to the next 0x1D, the last TAIL_MAX kept in a ring. */
  let skipping = false;
  let tail: Uint8Array | null = null;
  let tailLen = 0;
  let tailEnd = 0;
  let ended = false;
  let index = 0;
  /** Bytes pushed so far; `spanStart` is where the held (or skipped) record began. */
  let pushed = 0;
  let spanStart = 0;

  /** Reads the record bytes `span` (no terminator) that began at `start` and end at `end` (relative offsets). */
  function emit(span: Uint8Array, start: number, end: number, hadTerminator: boolean, out: Iso2709Result[]): void {
    let s = 0;
    while (s < span.length && isJunk(span[s]!)) s++;
    if (s === span.length) return; // nothing but separators, or an empty record
    let rest = span.subarray(s);
    let at = start + s;
    for (;;) {
      const parsed = parseRecord(rest, hadTerminator);
      if (parsed.ok && parsed.split !== undefined) {
        const { record, warnings, split } = parsed;
        out.push({ ok: true, record, index: index++, warnings, startByte: baseOffset + at, endByte: baseOffset + at + split });
        rest = rest.subarray(split);
        at += split;
        continue;
      }
      if (!parsed.ok) {
        // A broken record whose terminator was lost: a good record after it still reads.
        const p = anchoredRecord(rest, 1, hadTerminator);
        if (p > 0) {
          out.push({ ok: false, index: index++, error: parsed.error, startByte: baseOffset + at, endByte: baseOffset + at + p });
          rest = rest.subarray(p);
          at += p;
          continue;
        }
      }
      const startByte = baseOffset + at;
      const endByte = baseOffset + end;
      if (parsed.ok) out.push({ ok: true, record: parsed.record, index: index++, warnings: parsed.warnings, startByte, endByte });
      else out.push({ ok: false, index: index++, error: parsed.error, startByte, endByte });
      return;
    }
  }

  /** Keeps the last TAIL_MAX bytes skipped (a ring, allocated on the first truncated record). */
  function keepTail(bytes: Uint8Array): void {
    tail ??= new Uint8Array(TAIL_MAX);
    if (bytes.length >= TAIL_MAX) {
      tail.set(bytes.subarray(bytes.length - TAIL_MAX));
      tailLen = TAIL_MAX;
      tailEnd = 0;
      return;
    }
    const first = Math.min(bytes.length, TAIL_MAX - tailEnd);
    tail.set(bytes.subarray(0, first), tailEnd);
    tail.set(bytes.subarray(first), 0);
    tailEnd = (tailEnd + bytes.length) % TAIL_MAX;
    tailLen = Math.min(TAIL_MAX, tailLen + bytes.length);
  }

  /** The kept tail in input order. */
  function tailBytes(): Uint8Array {
    if (tail === null || tailLen === 0) return new Uint8Array(0);
    if (tailLen < TAIL_MAX) return tail.slice(tailEnd - tailLen, tailEnd);
    return concatBytes([tail.subarray(tailEnd), tail.subarray(0, tailEnd)]);
  }

  /** Starts skipping the held record and `piece` (its bytes go to the tail). */
  function startSkipping(piece: Uint8Array): void {
    skipping = true;
    tailLen = 0;
    tailEnd = 0;
    for (const part of held) keepTail(part);
    keepTail(piece);
    held = [];
    heldBytes = 0;
  }

  /**
   * Ends a skip at relative offset `end` (after the terminator, or the end of the input): the truncated result, then
   * a record that began in the tail and ends there, when there is one.
   */
  function stopSkipping(end: number, hadTerminator: boolean, out: Iso2709Result[]): void {
    const window = tailBytes();
    const windowStart = (hadTerminator ? end - 1 : end) - window.length;
    const p = anchoredRecord(window, 0, hadTerminator);
    const truncatedEnd = p >= 0 ? windowStart + p : end;
    out.push({ ok: false, index: index++, error: 'truncated', startByte: baseOffset + spanStart, endByte: baseOffset + truncatedEnd });
    if (p >= 0) emit(window.subarray(p), truncatedEnd, end, hadTerminator, out);
    skipping = false;
    tailLen = 0;
    tailEnd = 0;
  }

  return {
    push(chunk: Uint8Array): Iso2709Result[] {
      if (ended) throw new Error('readIso2709: push() after end()');
      const out: Iso2709Result[] = [];
      let i = 0;
      while (i < chunk.length) {
        // Separators before a record are not part of it (a record of the largest size may follow a line break).
        if (!skipping && heldBytes === 0) {
          while (i < chunk.length && isJunk(chunk[i]!)) {
            i++;
            pushed++;
          }
          spanStart = pushed;
          if (i === chunk.length) break;
        }
        const t = chunk.indexOf(RECORD_TERMINATOR, i);
        const piece = chunk.subarray(i, t < 0 ? chunk.length : t);
        if (skipping) keepTail(piece);
        else if (heldBytes + piece.length >= ISO2709_HOLD_MAX) startSkipping(piece);
        else if (t < 0) {
          held.push(new Uint8Array(piece)); // a copy: Buffer#slice would share the caller's memory
          heldBytes += piece.length;
        }
        pushed += piece.length;
        if (t < 0) break;
        pushed += 1;
        i = t + 1;
        if (skipping) stopSkipping(pushed, true, out);
        else {
          const span = held.length === 0 ? piece : concatBytes([...held, piece]);
          held = [];
          heldBytes = 0;
          emit(span, spanStart, pushed, true, out);
        }
        spanStart = pushed;
      }
      return out;
    },
    end(): Iso2709Result[] {
      if (ended) throw new Error('readIso2709: end() called twice');
      ended = true;
      const out: Iso2709Result[] = [];
      if (skipping) stopSkipping(pushed, false, out);
      else if (heldBytes > 0) {
        const span = concatBytes(held);
        held = [];
        heldBytes = 0;
        emit(span, spanStart, pushed, false, out);
      }
      return out;
    },
    consumedBytes(): number {
      return pushed - heldBytes - tailLen;
    },
  };
}

// ---- writing -------------------------------------------------------------------------------------------------------

/** What a value may not hold in ISO 2709: the record terminator, the field terminator, the subfield delimiter. */
const STRUCTURE_CHARS = ['\u{1D}', '\u{1E}', '\u{1F}'] as const;

function stripStructure(s: string): string {
  let out = s;
  for (const c of STRUCTURE_CHARS) if (out.includes(c)) out = out.replaceAll(c, '');
  return out;
}

/** A usable subfield code: one printable ASCII character other than space. */
function isSubfieldCode(code: string): boolean {
  return code.length === 1 && code > '\x20' && code <= '\x7E';
}

/** Each field's bytes (content and its field terminator), the structure bytes removed from values. */
function encodeFields(rec: MarcRecord): { tag: string; bytes: Uint8Array }[] {
  return rec.fields.map((f) => {
    if (!MARC_TAG_RE.test(f.tag)) throw new RangeError('MARC field tag must be three ASCII letters or digits');
    const control = isControlField(f);
    if (control !== isControlTag(f.tag)) throw new RangeError(`MARC field ${f.tag}: a control field must have a 00X tag and the other way round`);
    let content: string;
    if (control) content = stripStructure(f.value);
    else {
      content = marcIndicator(f.ind1) + marcIndicator(f.ind2);
      for (const [code, value] of f.subfields) {
        if (isSubfieldCode(code)) content += `\u{1F}${code}${stripStructure(value)}`;
      }
    }
    const encoded = utf8Encoder.encode(content);
    const bytes = new Uint8Array(encoded.length + 1);
    bytes.set(encoded);
    bytes[encoded.length] = FIELD_TERMINATOR;
    return { tag: f.tag, bytes };
  });
}

/**
 * The leader ISO 2709 writes for `rec`: the record length (capped at 99999), `a` at 09, the base address, and the
 * positions that describe the writer's own structure: 10-11 `22` (two indicators, a delimiter and a one-character
 * subfield code) and 20-23 `4500` (the directory entry map). A reader such as yaz takes the structure from them.
 */
function layoutLeader(leader: string, total: number, base: number): string {
  const l = unicodeLeader(leader);
  return `${String(Math.min(total, MARC_RECORD_MAX)).padStart(5, '0')}${l.slice(5, 10)}22${String(base).padStart(5, '0')}${l.slice(17, 20)}4500`;
}

/**
 * The leader `rec` would have in ISO 2709 (length, coding `a`, base address and the structure positions 10-11 and
 * 20-23 recomputed; a length above 99 999 shows as 99999). Internal: recordToMarc uses it so that every format shows
 * the same leader.
 */
export function iso2709Leader(rec: MarcRecord): string {
  const fields = encodeFields(rec);
  const base = 24 + 12 * fields.length + 1;
  const total = base + fields.reduce((n, f) => n + f.bytes.length, 0) + 1;
  return layoutLeader(rec.leader, total, base);
}

/**
 * `rec` as ISO 2709 bytes: UTF-8, leader positions 00-04 (length), 09 (`a`), 10-11 (`22`), 12-16 (base address) and
 * 20-23 (`4500`) recomputed, the other leader positions as given (made printable ASCII, 24 characters). Values lose 0x1D, 0x1E and 0x1F; an indicator
 * that is not one printable ASCII character is written blank and a subfield without a usable code is left out.
 * @throws MarcTooLongError above 99 999 bytes, or for a field above 9 999 bytes
 * @throws RangeError for a tag that is not three ASCII letters or digits
 */
export function writeIso2709(rec: MarcRecord): Uint8Array {
  const fields = encodeFields(rec);
  const base = 24 + 12 * fields.length + 1;
  let dataLength = 0;
  let directory = '';
  for (const f of fields) {
    if (f.bytes.length > FIELD_MAX) throw new MarcTooLongError(f.bytes.length, 'field');
    directory += f.tag + String(f.bytes.length).padStart(4, '0') + String(dataLength).padStart(5, '0');
    dataLength += f.bytes.length;
  }
  const total = base + dataLength + 1;
  if (total > MARC_RECORD_MAX) throw new MarcTooLongError(total);
  const out = new Uint8Array(total);
  out.set(utf8Encoder.encode(layoutLeader(rec.leader, total, base) + directory), 0);
  out[base - 1] = FIELD_TERMINATOR;
  let at = base;
  for (const f of fields) {
    out.set(f.bytes, at);
    at += f.bytes.length;
  }
  out[total - 1] = RECORD_TERMINATOR;
  return out;
}
