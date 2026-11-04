import { identifierQuery } from '../catalog/lib/identifiers.js';
import { encodeSearchToken, rawSearchTokens, searchPrefixToken } from './tokenize.js';

// The query syntax of the OPAC and the admin (Phase 2 spec §4.4), parsed into clauses for sql.ts:
//
// - words separated by spaces are ANDed (one clause each);
// - `"exact phrase"`: its tokens adjacent; a word that splits into several tokens (`e-book`) is a phrase of them;
// - `-word`, `-"phrase"`, `-field:word`: the clause excludes;
// - `ATAU` / `OR`, in upper case, between two (not excluded) terms joins them into one clause of alternatives;
// - `word*`: a prefix, when the word has at least 3 characters;
// - fields `judul:`, `pengarang:`, `subjek:`, `isbn:`, `penerbit:`, `nomor:` and the English `title:`, `author:`,
//   `subject:`, `publisher:`, `callno:` (any case) apply to the word or phrase right after the colon.
//
// Broken syntax never fails (§4.4): an unbalanced quote is ignored, an unknown field (`foo:bar`) is text, a stray
// `OR` is the word "or". The text is read up to QUERY_TEXT_MAX characters and at most QUERY_CLAUSES_MAX clauses are
// kept, so that a query's SQL stays bounded.

/** A field of the syntax. `isbn`, `publisher` and `callno` search the whole document (their text is in `t_rest`). */
export type SearchField = 'all' | 'title' | 'author' | 'subject' | 'isbn' | 'publisher' | 'callno';

const FIELD_NAMES: Readonly<Record<string, SearchField>> = Object.freeze({
  judul: 'title',
  title: 'title',
  pengarang: 'author',
  author: 'author',
  subjek: 'subject',
  subject: 'subject',
  isbn: 'isbn',
  penerbit: 'publisher',
  publisher: 'publisher',
  nomor: 'callno',
  callno: 'callno',
});

/** The most characters of a query that are read. */
export const QUERY_TEXT_MAX = 1000;
/** The most clauses a query keeps. */
export const QUERY_CLAUSES_MAX = 32;
/** The most alternatives one clause keeps. */
const CLAUSE_TERMS_MAX = 16;
/** The most tokens one phrase keeps. */
const PHRASE_TOKENS_MAX = 32;
/** A prefix needs this many characters before the `*`. */
const PREFIX_MIN = 3;

/** One word or phrase of a query. */
export interface ParsedTerm {
  field: SearchField;
  /** The term as typed, without its field, quotes or stars. */
  text: string;
  /**
   * What the index is searched for: the encoded tokens (encodeSearchToken), in order; for a prefix, its one word in
   * the form the tokens it begins are stored in (searchPrefixToken).
   */
  tokens: string[];
  /** The tokens before their encoding (the spelling correction reads them), one per token. */
  words: string[];
  /** The tokens must be adjacent (a quoted phrase, or a word that split into several tokens). */
  phrase: boolean;
  /** `word*`: the one token is a prefix. */
  prefix: boolean;
}

/** One clause: its terms are alternatives (joined by OR / ATAU); a negated clause excludes what it matches. */
export interface ParsedClause {
  negated: boolean;
  terms: ParsedTerm[];
}

/** A parsed query: its clauses are ANDed. No clause: the query has no searchable text. */
export interface ParsedQuery {
  clauses: ParsedClause[];
}

type Item = { kind: 'term'; negated: boolean; term: ParsedTerm } | { kind: 'or'; text: string };

const SPACE_RE = /\s/u;
const FIELD_RE = /^([A-Za-z]+):(?=[^\s])/;

/** The term of `text` (a word unless `quoted`), or null when it holds no token. */
function makeTerm(text: string, field: SearchField, quoted: boolean, star: boolean): ParsedTerm | null {
  if (field === 'isbn' && !quoted) {
    const id = identifierQuery(text);
    if (id !== null) {
      const key = id.key.toLowerCase();
      return { field, text, tokens: [encodeSearchToken(key)], words: [key], phrase: false, prefix: false };
    }
  }
  let raw = rawSearchTokens(text);
  if (raw.length === 0) return null;
  // An ISBN/ISSN typed as a word is searched by its key alone: the parts around it may be written otherwise.
  if (!quoted && raw.some((t) => t.isbn)) raw = raw.filter((t) => t.isbn);
  raw = raw.slice(0, PHRASE_TOKENS_MAX);
  const words = raw.map((t) => t.word);
  if (star && !quoted && words.length === 1 && Array.from(words[0]!).length >= PREFIX_MIN) {
    return { field, text, tokens: [searchPrefixToken(words[0]!)], words, phrase: false, prefix: true };
  }
  return { field, text, tokens: words.map(encodeSearchToken), words, phrase: words.length > 1, prefix: false };
}

/** The items of `q`: terms (with their negation) and the `OR`/`ATAU` words, in order. */
function lex(q: string): Item[] {
  const s = Array.from(q).slice(0, QUERY_TEXT_MAX).join('');
  const items: Item[] = [];
  let pos = 0;
  const n = s.length;
  while (pos < n) {
    if (SPACE_RE.test(s[pos]!)) {
      pos += 1;
      continue;
    }
    let negated = false;
    if (s[pos] === '-' && pos + 1 < n && !SPACE_RE.test(s[pos + 1]!)) {
      negated = true;
      pos += 1;
    }
    let field: SearchField = 'all';
    const f = FIELD_RE.exec(s.slice(pos, pos + 32));
    if (f !== null) {
      const known = FIELD_NAMES[f[1]!.toLowerCase()];
      if (known !== undefined && Object.hasOwn(FIELD_NAMES, f[1]!.toLowerCase())) {
        field = known;
        pos += f[0].length;
      }
    }
    if (s[pos] === '"') {
      const close = s.indexOf('"', pos + 1);
      if (close < 0) {
        // An unbalanced quote is ignored: what follows it is read as words.
        pos += 1;
        continue;
      }
      const text = s.slice(pos + 1, close);
      pos = close + 1;
      const term = makeTerm(text, field, true, false);
      if (term !== null) items.push({ kind: 'term', negated, term });
      continue;
    }
    let end = pos;
    while (end < n && !SPACE_RE.test(s[end]!) && s[end] !== '"') end += 1;
    let word = s.slice(pos, end);
    pos = end;
    if (!negated && field === 'all' && (word === 'OR' || word === 'ATAU')) {
      items.push({ kind: 'or', text: word });
      continue;
    }
    const star = word.endsWith('*');
    if (star) word = word.replace(/\*+$/, '');
    const term = makeTerm(word, field, false, star);
    if (term !== null) items.push({ kind: 'term', negated, term });
  }
  return items;
}

/**
 * Parses `q` (see the top of this file). It never throws: whatever is not understood becomes words, and a part
 * without any token (punctuation, a lone `-` or `*`) is dropped.
 */
export function parseQuery(q: string): ParsedQuery {
  const items = typeof q === 'string' ? lex(q) : [];
  const clauses: ParsedClause[] = [];
  for (let i = 0; i < items.length && clauses.length < QUERY_CLAUSES_MAX; i += 1) {
    const item = items[i]!;
    if (item.kind === 'or') {
      const prev = items[i - 1];
      const next = items[i + 1];
      const last = clauses[clauses.length - 1];
      if (
        prev?.kind === 'term' &&
        !prev.negated &&
        next?.kind === 'term' &&
        !next.negated &&
        last !== undefined &&
        !last.negated
      ) {
        if (last.terms.length < CLAUSE_TERMS_MAX) last.terms.push(next.term);
        i += 1;
        continue;
      }
      // A stray OR is the word "or".
      const term = makeTerm(item.text, 'all', false, false);
      if (term !== null) clauses.push({ negated: false, terms: [term] });
      continue;
    }
    clauses.push({ negated: item.negated, terms: [item.term] });
  }
  return { clauses };
}
