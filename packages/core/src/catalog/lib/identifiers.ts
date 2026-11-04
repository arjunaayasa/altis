// ISBN, ISSN and DOI (spec §3.2, §4.4, §5.1). ISBN-10 and ISBN-13 normalise to a 13-digit value_key; a wrong check
// digit is kept with valid: false. ISSN keys are 8 characters with an upper-case X. Mixed text from imports and
// migrations ("979-1234-56-7 (jil. 1); 0123-4567") is split and classified, the rest kept as the qualifier. There is
// no ISBN hyphenation table: the display form is the input form. Pure; no database.

/** One classified part of mixed identifier text (splitIdentifierText). */
interface IdentifierPart {
  type: 'isbn' | 'issn' | 'other';
  value: string;
  key: string | null;
  valid: boolean;
  qualifier: string | null;
}

/** Characters an ISBN/ISSN may carry between its digits: whitespace, the hyphen-minus, Unicode hyphens and dashes. */
const SEPARATORS_RE = /[\s\-\u{2010}-\u{2015}\u{2212}]/gu;
const ISBN10_RE = /^\d{9}[\dX]$/;
const ISBN13_RE = /^97[89]\d{10}$/;
const ISSN_RE = /^\d{7}[\dX]$/;

/** `record_identifiers.value_key` is a key191() column. */
const KEY_MAX = 191;

/** A part of mixed text is tried as an identifier over at most this many leading words (`978 - 602 - …`). */
const MAX_ID_WORDS = 20;
/** No ISBN or ISSN has more significant characters than this once separators are gone. */
const MAX_ID_COMPACT = 13;

/** The input with full-width forms folded (NFKC), separators removed and `x` upper-cased. */
function compact(s: string): string {
  return s.normalize('NFKC').replace(SEPARATORS_RE, '').toUpperCase();
}

/** The input form for value_display: NFKC, trimmed, inner whitespace collapsed, `x` upper-cased. */
function displayForm(s: string): string {
  return s.normalize('NFKC').trim().replace(/\s+/g, ' ').toUpperCase();
}

function digit(s: string, i: number): number {
  return s.charCodeAt(i) - 48;
}

/** The ISBN-10 check character of 9 digits (weights 10..2, mod 11; 10 is X). */
function isbn10Check(body: string): string {
  let sum = 0;
  for (let i = 0; i < 9; i++) sum += (10 - i) * digit(body, i);
  const r = (11 - (sum % 11)) % 11;
  return r === 10 ? 'X' : String(r);
}

/** The ISBN-13 (EAN-13) check digit of 12 digits (weights 1, 3, …, mod 10). */
function isbn13Check(body: string): string {
  let sum = 0;
  for (let i = 0; i < 12; i++) sum += digit(body, i) * (i % 2 === 0 ? 1 : 3);
  return String((10 - (sum % 10)) % 10);
}

/** The ISSN check character of 7 digits (weights 8..2, mod 11; 10 is X). */
function issnCheck(body: string): string {
  let sum = 0;
  for (let i = 0; i < 7; i++) sum += (8 - i) * digit(body, i);
  const r = (11 - (sum % 11)) % 11;
  return r === 10 ? 'X' : String(r);
}

/**
 * An ISBN-10 or ISBN-13, with or without hyphens and spaces; `X` (either case) only as the ISBN-10 check digit.
 * - An ISBN-10 maps to `978` + its 9 digits + a new check digit, even when its own check digit is wrong
 *   (`valid: false`).
 * - An ISBN-13 must start 978/979; with a wrong check digit its key is the 13 digits as entered (`valid: false`).
 * - Anything else (including a label such as `ISBN`, see splitIdentifierText) → null.
 */
export function parseIsbn(s: string): { key: string /* 13 digits */; valid: boolean; display: string } | null {
  const c = compact(s);
  if (ISBN10_RE.test(c)) {
    const body = `978${c.slice(0, 9)}`;
    return { key: body + isbn13Check(body), valid: isbn10Check(c) === c[9], display: displayForm(s) };
  }
  if (ISBN13_RE.test(c)) return { key: c, valid: isbn13Check(c) === c[12], display: displayForm(s) };
  return null;
}

/** An ISSN: 7 digits and a check character (mod 11), with or without the hyphen. The key upper-cases X. */
export function parseIssn(s: string): { key: string /* 8 characters, upper-case X */; valid: boolean; display: string } | null {
  const c = compact(s);
  if (!ISSN_RE.test(c)) return null;
  return { key: c, valid: issnCheck(c) === c[7], display: displayForm(s) };
}

/**
 * Whether a (normalised) barcode is a valid ISBN-13 starting 978/979: exactly 13 digits as a scanner reads an EAN-13,
 * with the right check digit. Such a value is refused as an item barcode (spec §3.2).
 */
export function isValidIsbn13Barcode(s: string): boolean {
  return ISBN13_RE.test(s) && isbn13Check(s) === s[12];
}

/** Splits `text` on `;`, `,` and `/` outside brackets. */
function splitOutsideBrackets(text: string): string[] {
  const parts: string[] = [];
  let depth = 0;
  let start = 0;
  for (let i = 0; i < text.length; i++) {
    const ch = text[i];
    if (ch === '(' || ch === '[') depth++;
    else if ((ch === ')' || ch === ']') && depth > 0) depth--;
    else if (depth === 0 && (ch === ';' || ch === ',' || ch === '/')) {
      parts.push(text.slice(start, i));
      start = i + 1;
    }
  }
  parts.push(text.slice(start));
  return parts;
}

/** The text outside brackets (each bracketed group replaced by a space) and the trimmed bracketed notes, in order. */
function extractNotes(part: string): { main: string; notes: string[] } {
  const notes: string[] = [];
  let main = '';
  let note = '';
  let depth = 0;
  for (const ch of part) {
    if (ch === '(' || ch === '[') {
      if (depth > 0) note += ch;
      depth++;
    } else if ((ch === ')' || ch === ']') && depth > 0) {
      depth--;
      if (depth > 0) note += ch;
      else {
        notes.push(note);
        note = '';
        main += ' ';
      }
    } else if (depth > 0) note += ch;
    else main += ch;
  }
  // An unclosed bracket still holds a note.
  if (depth > 0) notes.push(note);
  return { main: main.replace(/\s+/g, ' ').trim(), notes: notes.map((n) => n.replace(/\s+/g, ' ').trim()).filter((n) => n !== '') };
}

/** A leading `ISBN`, `ISBN-13:`, `e-ISBN`, `p-ISSN`, … label, and which kind it names. */
const LABEL_RE = /^(?:[ep]-?)?(isbn|issn)(?:-?1[03])?\s*:?\s*/i;

/** ISBD punctuation and dashes around the rest of a part are not part of its qualifier (a final `.` is kept). */
function trimRest(s: string): string {
  const junk = (ch: string | undefined) => ch !== undefined && /[\s:;=+\-\u{2013}\u{2014}]/u.test(ch);
  let start = 0;
  let end = s.length;
  while (start < end && junk(s[start])) start++;
  while (end > start && junk(s[end - 1])) end--;
  return s.slice(start, end);
}

function classifyPart(part: string): IdentifierPart | null {
  const { main, notes } = extractNotes(part);
  if (main === '') {
    const whole = part.replace(/\s+/g, ' ').trim();
    return whole === '' || notes.length === 0 ? null : { type: 'other', value: whole, key: null, valid: false, qualifier: null };
  }
  const label = LABEL_RE.exec(main);
  const hint = label?.[1]?.toLowerCase();
  const body = label ? main.slice(label[0].length) : main;
  const words = body === '' ? [] : body.split(' ');
  // The longest run of leading words that parses is the identifier; what follows is the rest.
  for (let n = Math.min(words.length, MAX_ID_WORDS); n >= 1; n--) {
    const candidate = words.slice(0, n).join(' ');
    if (compact(candidate).length > MAX_ID_COMPACT) continue;
    const isbn = hint === 'issn' ? null : parseIsbn(candidate);
    const issn = isbn || hint === 'isbn' ? null : parseIssn(candidate);
    const parsed = isbn ?? issn;
    if (!parsed) continue;
    const rest = trimRest(words.slice(n).join(' '));
    const qualifier = [...notes, ...(rest === '' ? [] : [rest])].join('; ');
    return {
      type: isbn ? 'isbn' : 'issn',
      value: parsed.display,
      key: parsed.key,
      valid: parsed.valid,
      qualifier: qualifier === '' ? null : qualifier,
    };
  }
  return { type: 'other', value: main, key: null, valid: false, qualifier: notes.length > 0 ? notes.join('; ') : null };
}

/**
 * Splits mixed identifier text (an import's or a migration's ISBN/ISSN field) on `;`, `,` and `/` outside brackets,
 * and classifies each part:
 * - A leading `ISBN`/`ISSN` label (also `ISBN-13:`, `e-ISBN`, `p-ISSN`) is dropped and restricts the kind.
 * - The longest run of leading words that parses as an ISBN or ISSN becomes `value` (its display form) with its `key`.
 * - The bracketed notes, then the remaining text, joined by `; `, become the `qualifier`.
 * - A part that holds no identifier is `other` (key null, valid false); empty parts are skipped.
 */
export function splitIdentifierText(text: string): IdentifierPart[] {
  const out: IdentifierPart[] = [];
  for (const part of splitOutsideBrackets(text)) {
    const classified = classifyPart(part);
    if (classified) out.push(classified);
  }
  return out;
}

const DOI_PREFIX_RE = /^(?:doi\s*:\s*|https?:\/\/(?:dx\.)?doi\.org\/)/i;
const DOI_RE = /^10\.\d{4,9}\/\S+$/u;

/**
 * The DOI key: `doi:` and the doi.org resolver prefixes removed, percent-escapes decoded, ASCII lower-cased (DOI names
 * are case-insensitive). Null when the result is not `10.<4-9 digits>/<suffix without spaces>`, when an escape is
 * malformed, or when it is longer than a key column holds (191).
 */
export function normalizeDoi(s: string): string | null {
  let v = s.normalize('NFKC').trim().replace(DOI_PREFIX_RE, '');
  if (v.includes('%')) {
    try {
      v = decodeURIComponent(v);
    } catch {
      return null;
    }
  }
  if (!DOI_RE.test(v)) return null;
  const key = v.replace(/[A-Z]/g, (c) => c.toLowerCase());
  return Array.from(key).length > KEY_MAX ? null : key;
}

/**
 * Whether a search query is shaped like an ISBN or ISSN (with or without hyphens, optionally after a label such as
 * `isbn:`, `ISSN` or `ISBN-13:`, which restricts the kind), so the search can match `record_identifiers` first
 * (spec §4.4). The check digit is not required: a stored ISBN with a wrong check digit is found by the same key.
 */
export function identifierQuery(q: string): { type: 'isbn' | 'issn'; key: string } | null {
  let v = q.normalize('NFKC').trim();
  const label = LABEL_RE.exec(v);
  const hint = label?.[1]?.toLowerCase();
  if (label) v = v.slice(label[0].length);
  if (hint !== 'issn') {
    const isbn = parseIsbn(v);
    if (isbn) return { type: 'isbn', key: isbn.key };
  }
  if (hint !== 'isbn') {
    const issn = parseIssn(v);
    if (issn) return { type: 'issn', key: issn.key };
  }
  return null;
}
