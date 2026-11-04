import { parseIsbn, parseIssn } from '../catalog/lib/identifiers.js';

// The tokenizer of the built-in search (Phase 2 spec §4.2), the same for the index and the query, in TypeScript so that
// every dialect sees the same tokens (D2-08):
//
// 1. NFKD, nonspacing marks (the diacritics NFKD splits off) removed, lower case. The Latin letters NFKD keeps whole
//    are folded as the title key folds them (`ß` → `ss`, `ø` → `o`), and apostrophes are removed inside a word
//    (`Qur'an` → `quran`), so that a word is found however its apostrophe was typed.
// 2. Split on everything that is not a letter or a digit (`\p{L}`, `\p{N}`). A script written without spaces (CJK)
//    gives one token per run: an accepted limitation.
// 3. An ISBN or ISSN in the text also yields its key, right after its parts: the 13 digits of an ISBN (an ISBN-10 is
//    mapped to its 978 form), the 8 characters of an ISSN. Only a check-digit-valid number counts, so free numbers
//    rarely make one; a record's own identifiers carry their key whatever their check digit (doc.ts).
// 4. A token shorter than 3 characters, one of the 36 InnoDB default stopwords, or one that already starts with `zq`
//    gets the prefix `zq` (`ai` → `zqai`, `the` → `zqthe`, `zqx` → `zqzqx`, so the encoding stays one-to-one). InnoDB
//    indexes neither (innodb_ft_min_token_size 3, the default stopword list) and a shared host cannot change that, so
//    every dialect stores them prefixed: "AI", "C", "Go" and "The" stay searchable. So does a token that PostgreSQL's
//    parser would read as a number in scientific notation and cut there (`2e10x` → `2e10` and `x`): digits, `e`, a
//    digit (`2e10x` → `zq2e10x`).
// 5. A token is cut to 84 characters (InnoDB's innodb_ft_max_token_size), after the prefix.
// 6. A token with any character outside `a-z0-9` (what is left after step 1: Cyrillic, Greek, Arabic, the Indic and
//    Indonesian scripts, CJK, …) is written in ASCII: `zqx`, then each code point as 4 base-36 digits (`мир` →
//    `zqx00u400u000u8`), at most 20 code points (84 characters). The engines' parsers read the token text again, and
//    each treats such characters its own way: InnoDB's character table predates Javanese, Sundanese and Batak and
//    makes every character beyond the BMP a separator, and its collation (the server's default) equates hiragana with
//    katakana or a digit with the same digit of another script; PostgreSQL's parser follows the server's locale. In
//    ASCII every engine reads the same tokens (Task 39, K8). A prefix of a word is written the same way, and its code
//    points are a prefix of the word's (searchPrefixToken). `zqx` then 4 or more characters is no token of step 4
//    (a short word is at most `zq` and 2 characters, no stopword starts with `x`), so the encoding stays one-to-one.

/**
 * InnoDB's default stopword list (INFORMATION_SCHEMA.INNODB_FT_DEFAULT_STOPWORD): its 36 rows, in its order. `the`
 * appears twice there, so the list holds 35 distinct words.
 */
export const INNODB_STOPWORDS: readonly string[] = Object.freeze([
  'a',
  'about',
  'an',
  'are',
  'as',
  'at',
  'be',
  'by',
  'com',
  'de',
  'en',
  'for',
  'from',
  'how',
  'i',
  'in',
  'is',
  'it',
  'la',
  'of',
  'on',
  'or',
  'that',
  'the',
  'this',
  'to',
  'was',
  'what',
  'when',
  'where',
  'who',
  'will',
  'with',
  'und',
  'the',
  'www',
]);

const STOPWORDS: ReadonlySet<string> = new Set(INNODB_STOPWORDS);

/** The longest token, in characters (code points): InnoDB's innodb_ft_max_token_size. */
export const SEARCH_TOKEN_MAX = 84;

/** Tokens shorter than this many characters are prefixed (InnoDB's innodb_ft_min_token_size). */
const SEARCH_TOKEN_MIN = 3;

/** The prefix of an encoded token. */
export const SEARCH_TOKEN_PREFIX = 'zq';

/**
 * The token format of this release (Phase 2 big review, after Task 39b changed it): a build stores it in
 * `search_state.token_version` (migration 0029) when it makes the index ready, and the boot hook queues a full rebuild
 * when a ready index holds another one (NULL: built before it was stored). A build in flight across an update that
 * changes it never marks the index ready in two formats (X2-2): a full rebuild starts again from the clear
 * (search/jobs.ts, its checkpoint's `tokenVersion`), a SLiMS run queues one at its end (migration/slims/ending.ts).
 * Raise it with every change of what this file writes for the same text.
 */
export const SEARCH_TOKEN_VERSION = 1;

/** Latin letters that NFKD does not decompose, folded as title_key folds them (catalog/lib/title-key.ts). */
const LATIN_FOLD: Readonly<Record<string, string>> = {
  ß: 'ss',
  æ: 'ae',
  œ: 'oe',
  ø: 'o',
  đ: 'd',
  ð: 'd',
  ł: 'l',
  þ: 'th',
  ı: 'i',
  ħ: 'h',
  ŧ: 't',
};
const LATIN_FOLD_RE = /[ßæœøđðłþıħŧ]/g;
const NONSPACING_MARKS_RE = /\p{Mn}+/gu;
/** Apostrophes (ASCII, grave, the right and left single quotation marks, the modifier letter apostrophe). */
const APOSTROPHES_RE = /(?<=[\p{L}\p{N}])['`\u{2018}\u{2019}\u{2BC}](?=[\p{L}\p{N}])/gu;
const WORD_RE = /[\p{L}\p{N}]+/gu;
/** One character between the parts of an ISBN or ISSN: whitespace, the hyphen-minus, Unicode hyphens and dashes. */
const NUMBER_SEPARATOR_RE = /^[\s\-\u{2010}-\u{2015}\u{2212}]$/u;
const DASH_RE = /^[-\u{2010}-\u{2015}\u{2212}]$/u;
/** A part of an ISBN/ISSN: digits, or digits ending in the check character `x`, or that `x` alone. */
const NUMBER_PART_RE = /^(?:\d+x?|x)$/;

/** The normalized text the tokens are cut from (steps 1 of the top of this file). */
export function normalizeSearchText(text: string): string {
  return text
    .normalize('NFKD')
    .replace(NONSPACING_MARKS_RE, '')
    .toLowerCase()
    .replace(LATIN_FOLD_RE, (c) => LATIN_FOLD[c] ?? c)
    .replace(APOSTROPHES_RE, '');
}

/** `s` cut to {@link SEARCH_TOKEN_MAX} code points. */
function cut(s: string): string {
  if (s.length <= SEARCH_TOKEN_MAX) return s;
  const points = Array.from(s);
  return points.length <= SEARCH_TOKEN_MAX ? s : points.slice(0, SEARCH_TOKEN_MAX).join('');
}

/** The number of code points of `s`, counted up to `limit`. */
function codePoints(s: string, limit: number): number {
  let n = 0;
  const it = s[Symbol.iterator]();
  while (n < limit && it.next().done !== true) n += 1;
  return n;
}

/** A token every engine reads as one word as it is (step 6). */
const PLAIN_TOKEN_RE = /^[a-z0-9]+$/;
/** What PostgreSQL's parser reads as the start of a number in scientific notation (step 4). */
const FLOAT_START_RE = /^[0-9]+e[0-9]/;
/** The mark of a token written in base 36 (step 6), and the digits of one code point. */
const ESCAPE_MARK = `${SEARCH_TOKEN_PREFIX}x`;
const ESCAPE_DIGITS = 4;
/** The code points an escaped token keeps: `zqx` and 20 × 4 digits fit in 84 characters. */
export const SEARCH_ESCAPED_MAX = Math.floor((SEARCH_TOKEN_MAX - ESCAPE_MARK.length) / ESCAPE_DIGITS);
const ESCAPED_RE = /^zqx(?:[0-9a-z]{4})+$/;

/** `t` (a token with a character outside `a-z0-9`) in base 36 (step 6). */
function escapeToken(t: string): string {
  let out = ESCAPE_MARK;
  let n = 0;
  for (const ch of t) {
    if (n === SEARCH_ESCAPED_MAX) break;
    out += ch.codePointAt(0)!.toString(36).padStart(ESCAPE_DIGITS, '0');
    n += 1;
  }
  return out;
}

/**
 * The stored form of one normalized token (steps 4–6 of the top of this file): written in base 36 when it has a
 * character outside `a-z0-9`; else prefixed with `zq` when it is shorter than 3 characters, an InnoDB stopword, starts
 * with `zq` or like a float (`2e10x`); cut to 84 characters.
 */
export function encodeSearchToken(t: string): string {
  if (!PLAIN_TOKEN_RE.test(t)) return escapeToken(t);
  const prefixed = codePoints(t, SEARCH_TOKEN_MIN) < SEARCH_TOKEN_MIN || STOPWORDS.has(t) || t.startsWith(SEARCH_TOKEN_PREFIX) || FLOAT_START_RE.test(t);
  return cut(prefixed ? `${SEARCH_TOKEN_PREFIX}${t}` : t);
}

/**
 * The stored form a prefix search (`word*`, a normalized word of 3 or more characters) looks for: every stored token
 * of a word that begins with `word` begins with it. Written in base 36 like a token (step 6), else prefixed with `zq`
 * when it starts with `zq` or like a float; never as a short word or a stopword (those are matched whole, sql.ts).
 */
export function searchPrefixToken(word: string): string {
  if (!PLAIN_TOKEN_RE.test(word)) return escapeToken(word);
  return cut(word.startsWith(SEARCH_TOKEN_PREFIX) || FLOAT_START_RE.test(word) ? `${SEARCH_TOKEN_PREFIX}${word}` : word);
}

/**
 * The word a stored token stands for (the inverse of encodeSearchToken; an escaped token's code points, at most 20),
 * or null for text no encoding could make (a character outside `a-z0-9`, a base-36 code point out of range).
 */
export function decodeSearchToken(token: string): string | null {
  if (ESCAPED_RE.test(token)) {
    let word = '';
    for (let i = ESCAPE_MARK.length; i < token.length; i += ESCAPE_DIGITS) {
      const cp = parseInt(token.slice(i, i + ESCAPE_DIGITS), 36);
      if (cp > 0x10ffff || (cp >= 0xd800 && cp <= 0xdfff)) return null;
      word += String.fromCodePoint(cp);
    }
    return word;
  }
  if (!PLAIN_TOKEN_RE.test(token)) return null;
  return token.startsWith(SEARCH_TOKEN_PREFIX) ? token.slice(SEARCH_TOKEN_PREFIX.length) : token;
}

/** A token before its encoding: `isbn` marks the key of an ISBN/ISSN found in the text (step 3). */
export interface RawSearchToken {
  /** The normalized token, cut to 84 characters. */
  word: string;
  isbn: boolean;
}

/** One word of the normalized text and what separates it from the next. */
interface Word {
  text: string;
  /** The text between this word and the next one ('' after the last). */
  gap: string;
}

/**
 * The ISBN/ISSN keys of the chain `words[from..to]` (digit groups each separated by one separator character), each
 * with the index of the word it follows: every window of consecutive groups whose characters form a check-digit-valid
 * ISBN-13, ISBN-10 or ISSN (an ISSN only as `dddd-dddX`, one dash between two groups of four).
 */
function numberKeys(words: readonly Word[], from: number, to: number): { after: number; key: string }[] {
  const keys: { after: number; key: string }[] = [];
  for (let i = from; i <= to; i += 1) {
    let compact = '';
    for (let j = i; j <= to && j - i < 13; j += 1) {
      const part = words[j]!.text;
      // The check character `x` only ends a window.
      if (compact.includes('x')) break;
      compact += part;
      if (compact.length > 13) break;
      if (compact.length === 13 && /^97[89]\d{10}$/.test(compact)) {
        const isbn = parseIsbn(compact);
        if (isbn?.valid === true && !(i === j && part === isbn.key)) keys.push({ after: j, key: isbn.key });
      } else if (compact.length === 10 && /^\d{9}[\dx]$/.test(compact)) {
        const isbn = parseIsbn(compact);
        if (isbn?.valid === true) keys.push({ after: j, key: isbn.key });
      } else if (
        compact.length === 8 &&
        j === i + 1 &&
        words[i]!.text.length === 4 &&
        DASH_RE.test(words[i]!.gap) &&
        /^\d{7}[\dx]$/.test(compact)
      ) {
        const issn = parseIssn(compact);
        if (issn?.valid === true) keys.push({ after: j, key: issn.key.toLowerCase() });
      }
    }
  }
  return keys;
}

/**
 * The tokens of `text` before their encoding (steps 1-3 and the cut of step 5), in text order, each ISBN/ISSN key right
 * after the word it ends with.
 */
export function rawSearchTokens(text: string): RawSearchToken[] {
  const s = normalizeSearchText(text);
  const words: Word[] = [];
  let last: Word | null = null;
  let lastEnd = 0;
  for (const m of s.matchAll(WORD_RE)) {
    if (last !== null) last.gap = s.slice(lastEnd, m.index);
    last = { text: m[0], gap: '' };
    words.push(last);
    lastEnd = m.index + m[0].length;
  }

  // The ISBN/ISSN keys, by the index of the word they follow.
  const extra = new Map<number, string[]>();
  for (let i = 0; i < words.length; ) {
    if (!NUMBER_PART_RE.test(words[i]!.text) || words[i]!.text === 'x') {
      i += 1;
      continue;
    }
    let end = i;
    while (end + 1 < words.length && NUMBER_SEPARATOR_RE.test(words[end]!.gap) && NUMBER_PART_RE.test(words[end + 1]!.text)) end += 1;
    for (const { after, key } of numberKeys(words, i, end)) extra.set(after, [...(extra.get(after) ?? []), key]);
    i = end + 1;
  }

  const out: RawSearchToken[] = [];
  words.forEach((w, i) => {
    out.push({ word: cut(w.text), isbn: false });
    for (const key of extra.get(i) ?? []) out.push({ word: key, isbn: true });
  });
  return out;
}

/** The tokens of `text` (spec §4.2; see the top of this file): normalized, split, ISBN/ISSN keys added, encoded. */
export function searchTokenize(text: string): string[] {
  return rawSearchTokens(text).map((t) => encodeSearchToken(t.word));
}
