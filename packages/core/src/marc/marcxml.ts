// MARCXML (MARC 21 slim; Phase 2 spec §5.1, S21) on top of our own streaming XML reader (Task 5), which refuses any
// DOCTYPE. The reader:
// - takes bytes (UTF-8) and reports each record's absolute byte offsets, so an import can checkpoint the end of its
//   last committed record. The bytes are cut after every `>` (0x3E, never part of a multibyte UTF-8 sequence) and
//   each piece is decoded on its own, so an event's position is exact; an incomplete UTF-8 sequence at the end of a
//   chunk waits for the next one;
// - resolves namespaces itself (the XML reader keeps prefixes): MARC elements are those in
//   http://www.loc.gov/MARC21/slim, with or without a prefix, at any depth (a collection, a single record as the root,
//   or records inside another vocabulary such as an SRU answer). Other elements inside a record are ignored;
// - skips a bad record and goes on: `directory` for a bad tag, indicator or subfield code, `encoding` for bytes that
//   are not UTF-8, `truncated` for a record above 1 MiB of text, 10 000 fields or 100 000 subfields. Malformed XML (a
//   DOCTYPE above all) throws XmlError: the whole document is refused;
// - resumes mid-file: prefixes() describes the context at the end of the last record read (the MARC namespace
//   bindings in scope and the elements still open, or that the record was the root), and a reader created with it
//   re-opens that context with synthetic start tags (not counted in the offsets) before it reads the remaining bytes;
//   after a root record, a stand-in root lets it read the rest as an uninterrupted parse would (a second root element
//   or text there is refused);
// - keeps copies of what it holds between pushes (a caller may reuse the buffer it pushed).
// Pure; no I/O.

import { XmlError, createXmlReader, isXmlName, type XmlEvent } from '../xml/reader.js';
import { XmlWriter } from '../xml/writer.js';
import {
  MARCXML_NS,
  MARC_TAG_RE,
  isControlField,
  isControlTag,
  marcIndicator,
  marcLeader24,
  unicodeLeader,
  type MarcDataField,
  type MarcReadResult,
  type MarcReadWarning,
  type MarcRecord,
} from './record.js';

/** The head of a MARCXML collection file; each record follows (writeMarcXmlRecord), then the close. */
export const MARCXML_COLLECTION_OPEN = `<?xml version="1.0" encoding="UTF-8"?>\n<collection xmlns="${MARCXML_NS}">\n`;
export const MARCXML_COLLECTION_CLOSE = '</collection>\n';

/**
 * The key of prefixes() that holds the elements still open (their qualified names, space separated, outermost
 * first). It can never be a namespace prefix: an XML prefix has no `#`.
 */
const OPEN_KEY = '#open';
/**
 * The key of prefixes() set (to `1`) when the last record read was the document's root element: what follows is read
 * as after the root (comments, processing instructions and white space only). No XML prefix has a `#` either.
 */
const AFTER_ROOT_KEY = '#after-root';
/** The element that stands in for the finished root on resume (never compared with the input's names). */
const AFTER_ROOT_WRAPPER = 'altis-after-root';
/** One element may declare at most this many namespaces, and at most this many prefixes may be in scope. */
const MAX_DECLARATIONS = 64;
const MAX_IN_SCOPE = 64;
/** The context of a record (its ancestors' names) is kept in a checkpoint: at most this many characters. */
const MAX_CONTEXT_CHARS = 4096;
/** At most this many MARC prefixes in scope where a record starts (a checkpoint holds them). */
const MAX_MARC_PREFIXES = 16;
/**
 * A record's text, fields and subfields are bounded; beyond, the record is reported `truncated`. An empty subfield adds
 * no text but is kept, so subfields are counted too; an ISO 2709 record (99 999 bytes) holds at most about 50 000.
 */
const MAX_RECORD_TEXT = 1024 * 1024;
const MAX_RECORD_FIELDS = 10_000;
const MAX_RECORD_SUBFIELDS = 100_000;
/**
 * The XML reader holds one text whole (S9): at most this many UTF-8 bytes, more than the 1 MiB characters of
 * MAX_RECORD_TEXT can take (3 bytes each at most), so the record bound decides for a text it could keep and a record
 * with a larger one is skipped (`truncated`, review L04); only a single text above this refuses the document.
 */
const MAX_TEXT_BYTES = 4 * MAX_RECORD_TEXT;

const GT = 0x3e;
const LT = 0x3c;

const utf8Fatal = new TextDecoder('utf-8', { fatal: true, ignoreBOM: true });
const utf8Lenient = new TextDecoder('utf-8', { ignoreBOM: true });

/** prefix → whether it is bound to the MARC namespace ('' is the default namespace). */
type Bindings = ReadonlyMap<string, boolean>;

interface Frame {
  name: string;
  ns: Bindings;
}

interface OpenRecord {
  startByte: number;
  /** The stack depth of the record element. */
  depth: number;
  leader: string | null;
  fields: MarcRecord['fields'];
  field: MarcDataField | null;
  collect: { kind: 'leader' } | { kind: 'control'; tag: string } | { kind: 'subfield'; code: string } | null;
  collectDepth: number;
  text: string;
  textChars: number;
  subfields: number;
  error: 'directory' | 'truncated' | null;
  badEncoding: boolean;
}

/** A MARCXML reader result, with the record's absolute byte offsets `[startByte, endByte)`. */
export type MarcXmlResult = MarcReadResult & { startByte: number; endByte: number };

function isPrefix(s: string): boolean {
  return s === '' || (isXmlName(s) && !s.includes(':'));
}

function validUtf8(bytes: Uint8Array): boolean {
  try {
    utf8Fatal.decode(bytes);
    return true;
  } catch {
    return false;
  }
}

/** How many bytes at the end of `b` start a UTF-8 sequence that is still missing bytes. */
function incompleteTail(b: Uint8Array): number {
  for (let k = 1; k <= 3 && k <= b.length; k++) {
    const c = b[b.length - k]!;
    if ((c & 0xc0) === 0x80) continue;
    const need = c >= 0xf0 && c <= 0xf7 ? 4 : c >= 0xe0 && c < 0xf0 ? 3 : c >= 0xc0 && c < 0xe0 ? 2 : 1;
    return need > k ? k : 0;
  }
  return 0;
}

/** The validated resume context: MARC prefixes, the names of the elements to re-open, and whether the root is done. */
function resumeContext(prefixes: Record<string, string>): { marc: string[]; open: string[]; afterRoot: boolean } {
  if (typeof prefixes !== 'object' || prefixes === null) throw new RangeError('readMarcXml: resume.prefixes must be the object prefixes() returned');
  const open = prefixes[OPEN_KEY];
  if (typeof open !== 'string' || open.length > MAX_CONTEXT_CHARS) throw new RangeError(`readMarcXml: resume.prefixes lacks the ${OPEN_KEY} context of prefixes()`);
  const names = open === '' ? [] : open.split(' ');
  if (names.length > MAX_DECLARATIONS || !names.every((n) => isXmlName(n))) throw new RangeError('readMarcXml: resume.prefixes holds a bad element name');
  const after = Object.hasOwn(prefixes, AFTER_ROOT_KEY) ? prefixes[AFTER_ROOT_KEY] : undefined;
  if (after !== undefined && (after !== '1' || names.length > 0)) throw new RangeError(`readMarcXml: resume.prefixes holds a bad ${AFTER_ROOT_KEY}`);
  const marc: string[] = [];
  for (const [key, value] of Object.entries(prefixes)) {
    if (key === OPEN_KEY || key === AFTER_ROOT_KEY) continue;
    if (!isPrefix(key) || typeof value !== 'string') throw new RangeError('readMarcXml: resume.prefixes holds a bad prefix');
    if (value === MARCXML_NS) marc.push(key);
  }
  if (marc.length > MAX_MARC_PREFIXES) throw new RangeError('readMarcXml: resume.prefixes holds too many prefixes');
  return { marc, open: names, afterRoot: after === '1' };
}

/**
 * A streaming MARCXML reader. push() takes the next bytes (UTF-8; a string source is passed as
 * `Buffer.from(text, 'utf8')`) and returns the records they completed; end() checks the document is complete.
 * - `baseOffset`: the absolute offset of the first byte pushed (a resumed slice).
 * - `resume.prefixes`: what prefixes() returned at the checkpoint; the remaining bytes are read as if the document's
 *   start had been read.
 * prefixes() returns the context at the end of the last record read (a JSON-safe object of a few hundred bytes);
 * consumedBytes() counts the bytes read so far (not those of an incomplete character waiting for the next chunk).
 * Throws XmlError for malformed XML (`doctype` for a DOCTYPE); a bad record is a result, not an exception.
 */
export function readMarcXml(o?: { resume?: { prefixes: Record<string, string> }; baseOffset?: number }): {
  push(bytes: Uint8Array): MarcXmlResult[];
  end(): MarcXmlResult[];
  prefixes(): Record<string, string>;
  consumedBytes(): number;
} {
  const baseOffset = o?.baseOffset ?? 0;
  const xml = createXmlReader({ maxTextBytes: MAX_TEXT_BYTES });
  const stack: Frame[] = [];
  const rootNs: Bindings = new Map();
  let pos = baseOffset;
  let carry: Uint8Array = new Uint8Array(0);
  let lastLt = -1;
  let index = 0;
  let ended = false;
  let synthetic = false;
  /** Resumed after a record that was the root: the stand-in root is open, and nothing but markup without content may follow. */
  let afterRoot = false;
  let rec: OpenRecord | null = null;
  /** The context at the end of the last record (or at the start); `rootDone` when that record was the root. */
  let context: { ns: Bindings; open: string[]; rootDone: boolean } = { ns: rootNs, open: [], rootDone: false };
  let out: MarcXmlResult[] = [];

  /** The bindings of an element: its parent's, changed by its own `xmlns` and `xmlns:*` attributes. */
  function scope(parent: Bindings, attrs: Record<string, string>): Bindings {
    let ns = parent;
    let declarations = 0;
    for (const key of Object.keys(attrs)) {
      let prefix: string;
      if (key === 'xmlns') prefix = '';
      else if (key.startsWith('xmlns:')) prefix = key.slice(6);
      else continue;
      if (++declarations > MAX_DECLARATIONS) throw new XmlError('limit', 'too many namespace declarations on one element');
      const isMarc = attrs[key] === MARCXML_NS;
      if ((ns.get(prefix) ?? false) === isMarc) continue;
      if (ns === parent) ns = new Map(parent);
      (ns as Map<string, boolean>).set(prefix, isMarc);
    }
    if (ns.size > MAX_IN_SCOPE) throw new XmlError('limit', 'too many namespace prefixes in scope');
    return ns;
  }

  function marcPrefixes(ns: Bindings): string[] {
    return [...ns].filter(([, marc]) => marc).map(([p]) => p);
  }

  function startRecord(): void {
    const open = stack.slice(0, -1).map((f) => f.name);
    const parentNs = stack.at(-2)?.ns ?? rootNs;
    if (open.join(' ').length > MAX_CONTEXT_CHARS || marcPrefixes(parentNs).length > MAX_MARC_PREFIXES) {
      throw new XmlError('limit', 'a MARC record sits in a context too large to checkpoint');
    }
    rec = {
      startByte: lastLt,
      depth: stack.length,
      leader: null,
      fields: [],
      field: null,
      collect: null,
      collectDepth: 0,
      text: '',
      textChars: 0,
      subfields: 0,
      error: null,
      badEncoding: false,
    };
  }

  function addField(r: OpenRecord, f: MarcRecord['fields'][number]): void {
    if (r.fields.length >= MAX_RECORD_FIELDS) r.error ??= 'truncated';
    else r.fields.push(f);
  }

  /** A child of the record or of one of its data fields. */
  function openInRecord(r: OpenRecord, local: string, isMarc: boolean, attrs: Record<string, string>): void {
    if (r.error || !isMarc) return;
    const rel = stack.length - r.depth;
    if (rel === 1 && local === 'leader' && r.leader === null) {
      r.collect = { kind: 'leader' };
    } else if (rel === 1 && local === 'controlfield') {
      const tag = attrs['tag'] ?? '';
      if (!MARC_TAG_RE.test(tag) || !isControlTag(tag)) r.error = 'directory';
      else r.collect = { kind: 'control', tag };
    } else if (rel === 1 && local === 'datafield') {
      const tag = attrs['tag'] ?? '';
      const ind1 = attrs['ind1'] ?? ' ';
      const ind2 = attrs['ind2'] ?? ' ';
      if (!MARC_TAG_RE.test(tag) || isControlTag(tag) || ind1.length > 1 || ind2.length > 1) r.error = 'directory';
      else {
        r.field = { tag, ind1: marcIndicator(ind1), ind2: marcIndicator(ind2), subfields: [] };
        addField(r, r.field);
      }
      return;
    } else if (rel === 2 && local === 'subfield' && r.field !== null) {
      if (++r.subfields > MAX_RECORD_SUBFIELDS) {
        // What the record holds is freed: once it has an error, nothing more of it is collected.
        r.error ??= 'truncated';
        r.fields = [];
        r.field = null;
        return;
      }
      const code = attrs['code'] ?? '';
      if (!/^[\x21-\x7E]$/.test(code)) r.error = 'directory';
      else r.collect = { kind: 'subfield', code };
    } else return;
    r.collectDepth = stack.length;
    r.text = '';
  }

  function closeInRecord(r: OpenRecord, depthBefore: number): void {
    if (r.collect !== null && depthBefore === r.collectDepth) {
      const text = r.text;
      if (r.collect.kind === 'leader') r.leader = text;
      else if (r.collect.kind === 'control') addField(r, { tag: r.collect.tag, value: text });
      else r.field?.subfields.push([r.collect.code, text]);
      r.collect = null;
      r.text = '';
    } else if (r.field !== null && depthBefore === r.depth + 1) r.field = null;
  }

  function finishRecord(r: OpenRecord, endByte: number): void {
    const startByte = r.startByte;
    const i = index++;
    if (r.badEncoding) return void out.push({ ok: false, index: i, error: 'encoding', startByte, endByte });
    if (r.error) return void out.push({ ok: false, index: i, error: r.error, startByte, endByte });
    if (r.leader === null && r.fields.length === 0) return void out.push({ ok: false, index: i, error: 'directory', startByte, endByte });
    const warnings: MarcReadWarning[] = [];
    let leader = r.leader ?? '';
    if (leader.length !== 24 || marcLeader24(leader) !== leader) {
      // The leading blanks dropped; marcLeader24 makes the trailing ones spaces anyway. No `[…]+$`: it retries a long
      // run of blanks from each of its starts (quadratic on a 1 MiB leader).
      leader = marcLeader24(leader.replace(/^[\t\n\r ]+/, ''));
      warnings.push('leader_length');
    }
    out.push({ ok: true, record: { leader, fields: r.fields }, index: i, warnings, startByte, endByte });
  }

  function onEvent(e: XmlEvent, endByte: number): void {
    // After the root (resumed): what an uninterrupted parse refuses outside the root element is refused here too.
    if (afterRoot && stack.length === 1) {
      if (e.type === 'open') throw new XmlError('syntax', 'a second root element');
      if (e.type === 'text' && /[^\t\n\r ]/.test(e.text)) throw new XmlError('syntax', 'text outside the root element');
    }
    if (e.type === 'text') {
      const r = rec;
      if (r !== null && r.collect !== null && stack.length === r.collectDepth) {
        r.textChars += e.text.length;
        if (r.textChars > MAX_RECORD_TEXT) {
          r.error ??= 'truncated';
          r.collect = null;
          r.text = '';
        } else r.text += e.text;
      }
      return;
    }
    if (e.type === 'open') {
      const parent = stack.at(-1)?.ns ?? rootNs;
      const ns = scope(parent, e.attrs);
      const colon = e.name.indexOf(':');
      const local = e.name.slice(colon + 1);
      const isMarc = ns.get(colon < 0 ? '' : e.name.slice(0, colon)) === true;
      stack.push({ name: e.name, ns });
      if (rec === null) {
        if (isMarc && local === 'record' && !synthetic) startRecord();
      } else openInRecord(rec, local, isMarc, e.attrs);
      return;
    }
    const depthBefore = stack.length;
    stack.pop();
    const r = rec;
    if (r === null) return;
    if (depthBefore === r.depth) {
      rec = null;
      finishRecord(r, endByte);
      context = { ns: stack.at(-1)?.ns ?? rootNs, open: stack.map((f) => f.name), rootDone: stack.length === 0 };
    } else closeInRecord(r, depthBefore);
  }

  /** Feeds one piece of input bytes (ending with `>`, or the end of the input) at the current position. */
  function feed(piece: Uint8Array): void {
    const pieceStart = pos;
    const lt = piece.lastIndexOf(LT);
    if (lt >= 0) lastLt = pieceStart + lt;
    let text: string;
    let invalid = false;
    try {
      text = utf8Fatal.decode(piece);
    } catch {
      text = utf8Lenient.decode(piece);
      invalid = true;
    }
    if (invalid && rec !== null) rec.badEncoding = true;
    const events = xml.write(text);
    pos += piece.length;
    for (const e of events) {
      const wasOpen = rec !== null;
      onEvent(e, pos);
      // A record that starts in a piece with bad bytes is bad when they lie after its `<`.
      const started: OpenRecord | null = rec;
      if (invalid && !wasOpen && started !== null && !validUtf8(piece.subarray(Math.max(0, started.startByte - pieceStart)))) started.badEncoding = true;
    }
  }

  function take(): MarcXmlResult[] {
    const results = out;
    out = [];
    return results;
  }

  if (o?.resume) {
    const { marc, open, afterRoot: done } = resumeContext(o.resume.prefixes);
    if (open.length > 0) {
      const declarations = marc.map((p) => (p === '' ? ` xmlns="${MARCXML_NS}"` : ` xmlns:${p}="${MARCXML_NS}"`)).join('');
      synthetic = true;
      for (const e of xml.write(open.map((name, i) => `<${name}${i === 0 ? declarations : ''}>`).join(''))) onEvent(e, pos);
      synthetic = false;
      context = { ns: stack.at(-1)?.ns ?? rootNs, open: stack.map((f) => f.name), rootDone: false };
    } else if (done) {
      // The root is finished: a stand-in root keeps the XML reader from asking for one, and is closed by end().
      for (const e of xml.write(`<${AFTER_ROOT_WRAPPER}>`)) onEvent(e, pos);
      afterRoot = true;
      context = { ns: rootNs, open: [], rootDone: true };
    }
  }

  return {
    push(bytes: Uint8Array): MarcXmlResult[] {
      if (ended) throw new Error('readMarcXml: push() after end()');
      let data = bytes;
      if (carry.length > 0) {
        data = new Uint8Array(carry.length + bytes.length);
        data.set(carry);
        data.set(bytes, carry.length);
      }
      const keep = incompleteTail(data);
      const usable = data.subarray(0, data.length - keep);
      carry = new Uint8Array(data.subarray(data.length - keep)); // a copy: Buffer#slice would share the caller's memory
      let i = 0;
      while (i < usable.length) {
        const gt = usable.indexOf(GT, i);
        const end = gt < 0 ? usable.length : gt + 1;
        feed(usable.subarray(i, end));
        i = end;
      }
      return take();
    },
    end(): MarcXmlResult[] {
      if (ended) throw new Error('readMarcXml: end() called twice');
      if (carry.length > 0) {
        const rest = carry;
        carry = new Uint8Array(0);
        feed(rest);
      }
      ended = true;
      if (afterRoot) {
        // Text the XML reader still holds comes out just before this end tag, and is checked as after the root.
        for (const e of xml.write(`</${AFTER_ROOT_WRAPPER}>`)) onEvent(e, pos);
        afterRoot = false;
      }
      for (const e of xml.end()) onEvent(e, pos);
      return take();
    },
    prefixes(): Record<string, string> {
      const result: Record<string, string> = Object.create(null) as Record<string, string>;
      for (const p of marcPrefixes(context.ns)) result[p] = MARCXML_NS;
      result[OPEN_KEY] = context.open.join(' ');
      if (context.rootDone) result[AFTER_ROOT_KEY] = '1';
      return { ...result };
    },
    consumedBytes(): number {
      return pos - baseOffset;
    },
  };
}

/**
 * One record as MARCXML: `<record xmlns="http://www.loc.gov/MARC21/slim">` (the namespace on the record, so it also
 * stands alone, as OAI-PMH embeds it), leader/09 `a`, every value escaped and stripped of the characters XML 1.0
 * forbids. An indicator that is not one printable ASCII character is written blank and a subfield without a usable
 * code is left out, as in ISO 2709.
 * @throws RangeError for a tag that is not three ASCII letters or digits
 */
export function writeMarcXmlRecord(rec: MarcRecord): string {
  const w = new XmlWriter();
  w.open('record', { xmlns: MARCXML_NS });
  w.leaf('leader', unicodeLeader(rec.leader));
  for (const f of rec.fields) {
    if (!MARC_TAG_RE.test(f.tag)) throw new RangeError('MARC field tag must be three ASCII letters or digits');
    const control = isControlField(f);
    if (control !== isControlTag(f.tag)) throw new RangeError(`MARC field ${f.tag}: a control field must have a 00X tag and the other way round`);
    if (control) w.leaf('controlfield', f.value, { tag: f.tag });
    else {
      w.open('datafield', { tag: f.tag, ind1: marcIndicator(f.ind1), ind2: marcIndicator(f.ind2) });
      for (const [code, value] of f.subfields) if (/^[\x21-\x7E]$/.test(code)) w.leaf('subfield', value, { code });
      w.close();
    }
  }
  return w.close().toString();
}
