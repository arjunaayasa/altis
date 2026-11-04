// Our own streaming XML tokenizer (spec §5.1, Global Constraints "XML input" and S9). Input is untrusted (MARCXML
// uploads, SRU answers), so the reader:
// - refuses any DOCTYPE or other markup declaration (no DTD, no external entity, no entity expansion);
// - accepts only the five predefined entities and numeric character references to characters XML 1.0 allows;
// - bounds the element depth, one text event, and every construct still open at a chunk's end (a start or end tag
//   with its attribute values, a comment, a CDATA section, a PI). Each bound is checked before the reader takes more
//   input in, so an unterminated construct fails with XmlError('limit') instead of holding a whole upload in memory.
// It checks well-formedness (one root element, matched tags, unique attributes, quoted values, valid names), not
// validity, and does no namespace processing: names keep their prefix (`marc:record`) and `xmlns:*` are attributes.
//
// Events do not depend on how the input is cut into chunks. Text is joined until the next start or end tag, across
// comments, PIs and CDATA sections (CDATA content is text), so a field's value is one event. Line ends are
// normalised (CRLF and CR → LF) and literal whitespace in attribute values becomes a space, as XML 1.0 requires.
// Character data is otherwise passed through: a control character in the input is not refused (writers strip them,
// see stripInvalidXmlChars). Pure; no I/O.

/**
 * One reader event.
 * - `open`: a start tag. `attrs` has a null prototype (test membership with `Object.hasOwn` or `in`, never
 *   `attrs.hasOwnProperty`). A self-closing element (`<x/>`) is an `open` with `selfClosing: true` immediately
 *   followed by its `close`, so a stack kept on open/close alone stays right.
 * - `close`: an end tag (or the end of a self-closing element).
 * - `text`: character data, references decoded, CDATA included, joined up to the next start or end tag.
 * Timing: an `open` or `close` event is returned by the write() call that delivered its `>`; the `text` event before
 * it comes in the same array, just ahead of it.
 */
export type XmlEvent =
  | { type: 'open'; name: string; attrs: Record<string, string>; selfClosing: boolean }
  | { type: 'close'; name: string }
  | { type: 'text'; text: string };

/**
 * Why the reader refused its input:
 * - `doctype`: a DOCTYPE or any other `<!` markup declaration;
 * - `entity`: an unknown entity, a bare `&`, or a reference to a character XML forbids;
 * - `nesting`: an end tag that does not match the open element;
 * - `limit`: maxDepth, maxTextBytes or maxTagBytes exceeded;
 * - `syntax`: anything else that is not well-formed;
 * - `truncated`: the input ended inside markup, with open elements, or without a root element.
 */
export type XmlErrorReason = 'doctype' | 'entity' | 'nesting' | 'limit' | 'syntax' | 'truncated';

export class XmlError extends Error {
  readonly reason: XmlErrorReason;

  constructor(reason: XmlErrorReason, message?: string) {
    // The message never quotes the input: it is untrusted and may be large.
    super(message ? `XML refused (${reason}): ${message}` : `XML refused (${reason})`);
    this.name = 'XmlError';
    this.reason = reason;
  }
}

export interface XmlReaderOptions {
  /** Deepest element nesting accepted (default 64). */
  maxDepth?: number;
  /** Largest text event, in UTF-8 bytes (default 1 MiB). */
  maxTextBytes?: number;
  /** Largest tag (with its attributes), comment, CDATA section or PI, in UTF-8 bytes (default 1 MiB; S9). */
  maxTagBytes?: number;
}

export interface XmlReader {
  /** Feeds the next chunk; returns the events it completed. Throws XmlError (and keeps throwing it) on bad input. */
  write(chunk: string): XmlEvent[];
  /** Ends the input; returns the last events, or throws XmlError('truncated') when the document is incomplete. */
  end(): XmlEvent[];
}

const MIB = 1024 * 1024;
const DEFAULTS = { maxDepth: 64, maxTextBytes: MIB, maxTagBytes: MIB } as const;

/** An entity or character reference (`#x1F600`, `amp`) is at most this long between `&` and `;`. */
const MAX_REF = 32;

// XML 1.0 (fifth edition) names. The combining-mark range opens NAME_CHAR so that no mark follows a character in the
// class (which would read as one combined character).
const NAME_START =
  'A-Z_a-z:\\u00C0-\\u00D6\\u00D8-\\u00F6\\u00F8-\\u02FF\\u0370-\\u037D\\u037F-\\u1FFF\\u200C-\\u200D\\u2070-\\u218F' +
  '\\u2C00-\\u2FEF\\u3001-\\uD7FF\\uF900-\\uFDCF\\uFDF0-\\uFFFD\\u{10000}-\\u{EFFFF}';
const NAME_CHAR = `\\u0300-\\u036F${NAME_START}\\-.0-9\\u00B7\\u203F-\\u2040`;
const NAME_RE = new RegExp(`^[${NAME_START}][${NAME_CHAR}]*$`, 'u');
const NAME_AT_RE = new RegExp(`[${NAME_START}][${NAME_CHAR}]*`, 'uy');

/** Whether `s` is an XML 1.0 name (element or attribute; a prefix colon allowed). Internal: the writer uses it too. */
export function isXmlName(s: string): boolean {
  return NAME_RE.test(s);
}

/** Whether a code point is an XML 1.0 `Char`. */
function isXmlChar(cp: number): boolean {
  return (
    cp === 0x9 ||
    cp === 0xa ||
    cp === 0xd ||
    (cp >= 0x20 && cp <= 0xd7ff) ||
    (cp >= 0xe000 && cp <= 0xfffd) ||
    (cp >= 0x10000 && cp <= 0x10ffff)
  );
}

/** UTF-8 bytes of one UTF-16 code unit (a surrogate pair is 2 + 2). */
function unitBytes(c: number): number {
  if (c < 0x80) return 1;
  if (c < 0x800 || (c >= 0xd800 && c <= 0xdfff)) return 2;
  return 3;
}

function utf8Bytes(s: string, from: number, to: number): number {
  let n = 0;
  for (let i = from; i < to; i++) n += unitBytes(s.charCodeAt(i));
  return n;
}

function isSpace(c: number): boolean {
  return c === 0x20 || c === 0x0a || c === 0x09 || c === 0x0d;
}

/** The text of a reference between `&` and `;`: one of the five predefined entities or a character reference. */
function decodeRef(ref: string): string {
  switch (ref) {
    case 'lt':
      return '<';
    case 'gt':
      return '>';
    case 'amp':
      return '&';
    case 'apos':
      return "'";
    case 'quot':
      return '"';
  }
  let cp: number;
  if (/^#x[0-9A-Fa-f]+$/.test(ref)) cp = Number.parseInt(ref.slice(2), 16);
  else if (/^#[0-9]+$/.test(ref)) cp = Number.parseInt(ref.slice(1), 10);
  else throw new XmlError('entity', ref.startsWith('#') ? 'malformed character reference' : 'unknown entity');
  if (!isXmlChar(cp)) throw new XmlError('entity', 'reference to a character XML forbids');
  return String.fromCodePoint(cp);
}

/** An attribute value as written between its quotes → its value: references decoded, literal TAB/LF → space. */
function decodeAttrValue(raw: string): string {
  let out = '';
  let i = 0;
  for (;;) {
    const amp = raw.indexOf('&', i);
    const end = amp < 0 ? raw.length : amp;
    out += raw.slice(i, end).replace(/[\t\n]/g, ' ');
    if (amp < 0) return out;
    const semi = raw.indexOf(';', amp + 1);
    if (semi < 0 || semi - amp - 1 > MAX_REF) throw new XmlError('entity', 'unterminated reference');
    out += decodeRef(raw.slice(amp + 1, semi));
    i = semi + 1;
  }
}

function skipSpace(s: string, i: number): number {
  while (i < s.length && isSpace(s.charCodeAt(i))) i++;
  return i;
}

/** A complete start tag between `<` and `>` (`name a="1" b='2'` or `name/`). */
function parseStartTag(rawTag: string): { name: string; attrs: Record<string, string>; selfClosing: boolean } {
  const selfClosing = rawTag.endsWith('/');
  const body = selfClosing ? rawTag.slice(0, -1) : rawTag;
  NAME_AT_RE.lastIndex = 0;
  const nameMatch = NAME_AT_RE.exec(body);
  if (!nameMatch) throw new XmlError('syntax', 'invalid element name');
  const name = nameMatch[0];
  // A null prototype: an attribute named __proto__ or constructor is an own property like any other, and a lookup of
  // an absent attribute never finds an Object.prototype member.
  const attrs = Object.create(null) as Record<string, string>;
  let pos = name.length;
  while (pos < body.length) {
    const next = skipSpace(body, pos);
    if (next === pos) throw new XmlError('syntax', 'whitespace expected before an attribute');
    pos = next;
    if (pos === body.length) break;
    NAME_AT_RE.lastIndex = pos;
    const attrMatch = NAME_AT_RE.exec(body);
    if (!attrMatch) throw new XmlError('syntax', 'invalid attribute name');
    const attrName = attrMatch[0];
    pos = skipSpace(body, pos + attrName.length);
    if (body[pos] !== '=') throw new XmlError('syntax', 'attribute without a value');
    pos = skipSpace(body, pos + 1);
    const quote = body[pos];
    if (quote !== '"' && quote !== "'") throw new XmlError('syntax', 'attribute value without quotes');
    const close = body.indexOf(quote, pos + 1);
    if (close < 0) throw new XmlError('syntax', 'unterminated attribute value');
    const raw = body.slice(pos + 1, close);
    if (raw.includes('<')) throw new XmlError('syntax', '`<` in an attribute value');
    if (Object.hasOwn(attrs, attrName)) throw new XmlError('syntax', 'duplicate attribute');
    attrs[attrName] = decodeAttrValue(raw);
    pos = close + 1;
  }
  return { name, attrs, selfClosing };
}

/**
 * Where the reader is:
 * - `text`: character data (inside the root element) or the prolog/epilog (outside it: whitespace only);
 * - `ref`: after `&` in character data;
 * - `lt`: after `<`;
 * - `bang`: after `<!` (a comment, a CDATA section, or a refused declaration);
 * - `comment`, `cdata`, `pi`, `start_tag`, `end_tag`: inside that construct.
 */
type State = 'text' | 'ref' | 'lt' | 'bang' | 'comment' | 'cdata' | 'pi' | 'start_tag' | 'end_tag';

function checkLimit(name: keyof typeof DEFAULTS, value: number | undefined): number {
  if (value === undefined) return DEFAULTS[name];
  if (!Number.isSafeInteger(value) || value < 1) throw new RangeError(`createXmlReader: ${name} must be a positive integer`);
  return value;
}

/**
 * A streaming XML reader (spec §5.1). Feed it string chunks (decoded by the caller); each write() returns the events
 * its chunk completed. A self-closing element yields an `open` event with `selfClosing: true` followed by its `close`
 * event, so a consumer can keep a stack on open/close alone. An XmlError is sticky: once thrown, every later call
 * throws it again.
 */
export function createXmlReader(o?: XmlReaderOptions): XmlReader {
  const maxDepth = checkLimit('maxDepth', o?.maxDepth);
  const maxTextBytes = checkLimit('maxTextBytes', o?.maxTextBytes);
  const maxTagBytes = checkLimit('maxTagBytes', o?.maxTagBytes);

  let state: State = 'text';
  let out: XmlEvent[] = [];
  let failed: XmlError | null = null;
  let ended = false;
  let started = false;
  /** The previous chunk ended with CR: a LF opening this chunk belongs to it. */
  let pendingCr = false;

  const stack: string[] = [];
  let rootSeen = false;

  /** The pending text event, in pieces, and its size. */
  let textParts: string[] = [];
  let textBytes = 0;
  /** The pending tag (between `<` and `>`), in pieces. */
  let tagParts: string[] = [];
  /** UTF-8 bytes of the construct still open: the pending tag, comment, CDATA section or PI. */
  let openBytes = 0;
  /** `start_tag`: the quote (code unit) of the attribute value being read, 0 outside one. */
  let quote = 0;
  /** `bang`: what follows `<!` so far (at most 7 characters). */
  let bang = '';
  /** `ref`: the reference so far (at most MAX_REF characters). */
  let ref = '';
  /** `comment`: trailing `-` count; `cdata`: trailing `]` count; `pi`: 1 when the last character was `?`. */
  let run = 0;

  function addText(s: string): void {
    if (s === '') return;
    const bytes = utf8Bytes(s, 0, s.length);
    if (textBytes + bytes > maxTextBytes) throw new XmlError('limit', 'text longer than maxTextBytes');
    textBytes += bytes;
    textParts.push(s);
  }

  function flushText(): void {
    if (textParts.length === 0) return;
    out.push({ type: 'text', text: textParts.join('') });
    textParts = [];
    textBytes = 0;
  }

  /** Counts `bytes` more of the open construct, refusing it past maxTagBytes before anything is kept. */
  function grow(bytes: number): void {
    openBytes += bytes;
    if (openBytes > maxTagBytes) throw new XmlError('limit', 'tag, comment, CDATA section or PI longer than maxTagBytes');
  }

  function addTag(s: string, from: number, to: number): void {
    if (to <= from) return;
    grow(utf8Bytes(s, from, to));
    tagParts.push(s.slice(from, to));
  }

  function takeTag(): string {
    const rawTag = tagParts.join('');
    tagParts = [];
    openBytes = 0;
    return rawTag;
  }

  function startTag(): void {
    const { name, attrs, selfClosing } = parseStartTag(takeTag());
    if (stack.length === 0) {
      if (rootSeen) throw new XmlError('syntax', 'a second root element');
      rootSeen = true;
    }
    if (stack.length + 1 > maxDepth) throw new XmlError('limit', 'elements nested deeper than maxDepth');
    flushText();
    out.push({ type: 'open', name, attrs, selfClosing });
    if (selfClosing) out.push({ type: 'close', name });
    else stack.push(name);
  }

  function endTag(): void {
    const rawTag = takeTag();
    let end = rawTag.length;
    while (end > 0 && isSpace(rawTag.charCodeAt(end - 1))) end--;
    const name = rawTag.slice(0, end);
    if (!isXmlName(name)) throw new XmlError('syntax', 'invalid end tag');
    if (stack[stack.length - 1] !== name) throw new XmlError('nesting', stack.length === 0 ? 'end tag without an open element' : 'end tag does not match the open element');
    stack.pop();
    flushText();
    out.push({ type: 'close', name });
  }

  /** Text or the prolog/epilog, from `i`; returns where it stopped. */
  function inText(s: string, i: number): number {
    if (stack.length === 0) {
      for (; i < s.length; i++) {
        const c = s.charCodeAt(i);
        if (c === 0x3c) {
          state = 'lt';
          return i + 1;
        }
        if (!isSpace(c)) throw new XmlError('syntax', 'text outside the root element');
      }
      return i;
    }
    let j = i;
    while (j < s.length) {
      const c = s.charCodeAt(j);
      if (c === 0x3c || c === 0x26) break;
      j++;
    }
    if (j > i) addText(s.slice(i, j));
    if (j === s.length) return j;
    if (s.charCodeAt(j) === 0x3c) state = 'lt';
    else {
      state = 'ref';
      ref = '';
    }
    return j + 1;
  }

  function inRef(s: string, i: number): number {
    for (; i < s.length; i++) {
      const c = s.charCodeAt(i);
      if (c === 0x3b) {
        addText(decodeRef(ref));
        state = 'text';
        return i + 1;
      }
      if (isSpace(c) || c === 0x3c || c === 0x26 || ref.length >= MAX_REF) throw new XmlError('entity', 'bare `&` or unterminated reference');
      ref += s[i];
    }
    return i;
  }

  function inLt(s: string, i: number): number {
    const c = s.charCodeAt(i);
    openBytes = 0;
    if (c === 0x2f) {
      state = 'end_tag';
      return i + 1;
    }
    if (c === 0x3f) {
      state = 'pi';
      run = 0;
      return i + 1;
    }
    if (c === 0x21) {
      state = 'bang';
      bang = '';
      return i + 1;
    }
    // A name start: ASCII letter, `_`, `:` or any non-ASCII unit (the whole name is checked when the tag ends).
    if ((c >= 0x41 && c <= 0x5a) || (c >= 0x61 && c <= 0x7a) || c === 0x5f || c === 0x3a || c >= 0xc0) {
      state = 'start_tag';
      quote = 0;
      return i;
    }
    throw new XmlError('syntax', 'invalid character after `<`');
  }

  function inBang(s: string, i: number): number {
    for (; i < s.length; i++) {
      bang += s[i];
      if (bang === '--') {
        state = 'comment';
        run = 0;
        return i + 1;
      }
      if (bang === '[CDATA[') {
        if (stack.length === 0) throw new XmlError('syntax', 'CDATA section outside the root element');
        state = 'cdata';
        run = 0;
        return i + 1;
      }
      if (!'--'.startsWith(bang) && !'[CDATA['.startsWith(bang)) throw new XmlError('doctype', 'DOCTYPE and markup declarations are refused');
    }
    return i;
  }

  function inComment(s: string, i: number): number {
    for (; i < s.length; i++) {
      const c = s.charCodeAt(i);
      grow(unitBytes(c));
      if (c === 0x2d) run++;
      else if (c === 0x3e && run >= 2) {
        state = 'text';
        return i + 1;
      } else run = 0;
    }
    return i;
  }

  function inPi(s: string, i: number): number {
    for (; i < s.length; i++) {
      const c = s.charCodeAt(i);
      grow(unitBytes(c));
      if (c === 0x3e && run === 1) {
        state = 'text';
        return i + 1;
      }
      run = c === 0x3f ? 1 : 0;
    }
    return i;
  }

  function inCdata(s: string, i: number): number {
    while (i < s.length) {
      if (run > 0) {
        const c = s.charCodeAt(i);
        if (c === 0x5d) {
          grow(1);
          run++;
          i++;
          continue;
        }
        if (c === 0x3e && run >= 2) {
          addText(']'.repeat(run - 2));
          run = 0;
          state = 'text';
          return i + 1;
        }
        addText(']'.repeat(run));
        run = 0;
      }
      const bracket = s.indexOf(']', i);
      const end = bracket < 0 ? s.length : bracket;
      if (end > i) {
        grow(utf8Bytes(s, i, end));
        addText(s.slice(i, end));
      }
      if (bracket < 0) return s.length;
      grow(1);
      run = 1;
      i = bracket + 1;
    }
    return i;
  }

  function inStartTag(s: string, i: number): number {
    const start = i;
    // Code units are at most as many as UTF-8 bytes: stop scanning as soon as the tag cannot fit any more.
    const budget = maxTagBytes - openBytes;
    for (; i < s.length; i++) {
      if (i - start > budget) throw new XmlError('limit', 'tag longer than maxTagBytes');
      const c = s.charCodeAt(i);
      if (quote !== 0) {
        if (c === quote) quote = 0;
      } else if (c === 0x22 || c === 0x27) quote = c;
      else if (c === 0x3e) {
        addTag(s, start, i);
        startTag();
        state = 'text';
        return i + 1;
      }
    }
    addTag(s, start, i);
    return i;
  }

  function inEndTag(s: string, i: number): number {
    const gt = s.indexOf('>', i);
    const end = gt < 0 ? s.length : gt;
    addTag(s, i, end);
    if (gt < 0) return end;
    endTag();
    state = 'text';
    return gt + 1;
  }

  function step(s: string, i: number): number {
    switch (state) {
      case 'text':
        return inText(s, i);
      case 'ref':
        return inRef(s, i);
      case 'lt':
        return inLt(s, i);
      case 'bang':
        return inBang(s, i);
      case 'comment':
        return inComment(s, i);
      case 'cdata':
        return inCdata(s, i);
      case 'pi':
        return inPi(s, i);
      case 'start_tag':
        return inStartTag(s, i);
      case 'end_tag':
        return inEndTag(s, i);
    }
  }

  /** CRLF and CR → LF (XML 1.0 §2.11), across chunk boundaries. */
  function normalizeLineEnds(s: string): string {
    if (s === '') return s;
    if (pendingCr && s.charCodeAt(0) === 0x0a) s = s.slice(1);
    pendingCr = s !== '' && s.charCodeAt(s.length - 1) === 0x0d;
    return s.includes('\r') ? s.replace(/\r\n?/g, '\n') : s;
  }

  function take(): XmlEvent[] {
    const events = out;
    out = [];
    return events;
  }

  function guard<T>(fn: () => T): T {
    if (failed) throw failed;
    if (ended) throw new Error('createXmlReader: the input has already ended');
    try {
      return fn();
    } catch (e) {
      if (e instanceof XmlError) failed = e;
      throw e;
    }
  }

  return {
    write(chunk: string): XmlEvent[] {
      return guard(() => {
        let s = chunk;
        if (!started && s !== '') {
          started = true;
          if (s.charCodeAt(0) === 0xfeff) s = s.slice(1);
        }
        s = normalizeLineEnds(s);
        let i = 0;
        while (i < s.length) i = step(s, i);
        return take();
      });
    },
    end(): XmlEvent[] {
      return guard(() => {
        if (state !== 'text' || stack.length > 0 || !rootSeen) {
          throw new XmlError('truncated', rootSeen ? 'the input ended inside the document' : 'no root element');
        }
        ended = true;
        flushText();
        return take();
      });
    },
  };
}
