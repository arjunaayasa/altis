import type { DB } from '@altis/db';
import type { Kysely, Transaction } from 'kysely';
import { rawSearchTokens } from './tokenize.js';

// The typo tolerance (Phase 2 spec §4.7, D2-10). `search_term` holds the vocabulary of the index (the words of letters
// only, 3 to 84 characters, with their document frequency `df`; terms.ts rebuilds it). A word of the query that is
// not in it is compared with the terms of the same first character and a length within ±2 (at most 5 000 rows, by
// `df`): the Damerau-Levenshtein distance, computed here in JS, may be at most 1 for a word of 4–7 letters and 2 from 8
// letters; a shorter word is never corrected. The candidate with the highest `df` wins (then the nearer one, then the
// first in code-unit order). searchCatalog runs the corrected query when the original found nothing (§4.7).

/** A word is corrected only from this many letters. */
const CORRECT_MIN = 4;
/** Words of up to this many letters may be one edit off; longer ones two. */
const ONE_EDIT_MAX = 7;
/** The longest word (a token's longest form). */
const WORD_MAX = 84;
/** The candidates read per word (§4.7). */
const CANDIDATES_MAX = 5000;
/** The words of one query that are looked at (a bound on its database reads). */
const WORDS_MAX = 8;
/** The length window of the candidates. */
const LENGTH_WINDOW = 2;

type Db = Kysely<DB> | Transaction<DB>;

const LETTERS_RE = /^\p{L}+$/u;

/** Whether `word` (a normalized token) may be corrected: letters only, 4 to 84 characters. */
export function correctableWord(word: string): boolean {
  if (!LETTERS_RE.test(word)) return false;
  const n = Array.from(word).length;
  return n >= CORRECT_MIN && n <= WORD_MAX;
}

/** The distance allowed for a word of `length` letters. */
export function spellingDistanceMax(length: number): number {
  return length <= ONE_EDIT_MAX ? 1 : 2;
}

/**
 * The Damerau-Levenshtein distance between `a` and `b` over code points, in its optimal-string-alignment form (an
 * insertion, a deletion, a substitution or a transposition of two adjacent characters counts one edit, and no
 * substring is edited twice); `max + 1` as soon as the distance is known to exceed `max`.
 */
export function damerauLevenshtein(a: string, b: string, max: number): number {
  const s = Array.from(a);
  const t = Array.from(b);
  if (Math.abs(s.length - t.length) > max) return max + 1;
  if (s.length === 0 || t.length === 0) return Math.min(Math.max(s.length, t.length), max + 1);
  const width = t.length + 1;
  let prev2: number[] = new Array<number>(width).fill(0);
  let prev: number[] = Array.from({ length: width }, (_, j) => j);
  for (let i = 1; i <= s.length; i += 1) {
    const cur: number[] = new Array<number>(width).fill(0);
    cur[0] = i;
    let rowMin = cur[0];
    for (let j = 1; j <= t.length; j += 1) {
      const cost = s[i - 1] === t[j - 1] ? 0 : 1;
      let d = Math.min(prev[j]! + 1, cur[j - 1]! + 1, prev[j - 1]! + cost);
      if (i > 1 && j > 1 && s[i - 1] === t[j - 2] && s[i - 2] === t[j - 1]) d = Math.min(d, prev2[j - 2]! + 1);
      cur[j] = d;
      if (d < rowMin) rowMin = d;
    }
    if (rowMin > max) return max + 1;
    prev2 = prev;
    prev = cur;
  }
  const d = prev[t.length]!;
  return d > max ? max + 1 : d;
}

/**
 * The corrections of `words` (normalized, unencoded tokens of a query): for each correctable word that is not in
 * `search_term` and has a candidate (see the top of this file), the word → its correction. At most 8 words are looked
 * at; two reads of `search_term` per corrected word at most.
 */
export async function suggestCorrections(db: Db, words: readonly string[]): Promise<Map<string, string>> {
  const out = new Map<string, string>();
  const wanted = [...new Set(words.filter((w) => typeof w === 'string' && correctableWord(w)))].slice(0, WORDS_MAX);
  if (wanted.length === 0) return out;
  const known = new Set((await db.selectFrom('search_term').select('term').where('term', 'in', wanted).execute()).map((r) => r.term));
  for (const word of wanted) {
    if (known.has(word)) continue;
    const letters = Array.from(word);
    const max = spellingDistanceMax(letters.length);
    const rows = await db
      .selectFrom('search_term')
      .select(['term', 'df'])
      .where('first_char', '=', letters[0]!)
      .where('len', '>=', letters.length - LENGTH_WINDOW)
      .where('len', '<=', letters.length + LENGTH_WINDOW)
      .orderBy('df', 'desc')
      .orderBy('term')
      .limit(CANDIDATES_MAX)
      .execute();
    let best: { term: string; df: number; distance: number } | null = null;
    for (const row of rows) {
      if (row.term === word) continue;
      const df = Number(row.df);
      // Rows come by df: once one is chosen, a row of lower df can no longer win.
      if (best !== null && df < best.df) break;
      const distance = damerauLevenshtein(word, row.term, max);
      if (distance > max) continue;
      if (best === null || distance < best.distance) best = { term: row.term, df, distance };
    }
    if (best !== null) out.set(word, best.term);
  }
  return out;
}

/** A run of the query's text that may hold one word (letters, digits, marks and apostrophes). */
const RUN_RE = /[\p{L}\p{N}\p{M}'`\u{2018}\u{2019}\u{2BC}]+/gu;

/**
 * `text` with each run whose one token is a corrected word replaced by its correction; the rest of the text (fields,
 * quotes, `-`, other words) stays as typed. The message "Menampilkan hasil untuk …" shows it.
 */
export function correctedText(text: string, corrections: ReadonlyMap<string, string>): string {
  return text.replace(RUN_RE, (run) => {
    const tokens = rawSearchTokens(run);
    if (tokens.length !== 1) return run;
    return corrections.get(tokens[0]!.word) ?? run;
  });
}
