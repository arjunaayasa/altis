import type { DB } from '@altis/db';
import type { Transaction } from 'kysely';
import { decodeSearchToken } from './tokenize.js';

// The spelling vocabulary `search_term` (Phase 2 spec §4.1, §4.7): each word of the public documents with its document
// frequency `df` (a word only a hidden or archived record holds is never offered to a visitor as a correction), rebuilt by `catalog.reindex` (after its documents) and by the daily refresh, never by a save (suggestions may
// lag ≤ 24 h). Only words the correction can use are kept: letters only, 3 to 84 characters, decoded (`zqthe` →
// `the`, a base-36 token to its letters: tokenize.ts step 6), with `first_char` (the first code point) and `len` (code
// points) for the candidate read.
//
// The rebuild is sliced, so that it fits the 20 s slices of a job (P9) on any catalogue: clearSearchTerms, then
// addSearchTermsBatch over the documents in `doc_no` order (each batch's counts merged into the table: the existing
// rows of its words read, deleted and written back with the sum), then finishSearchTerms keeps the 300 000 words of
// highest `df` (ties by word). The batch's `doc_no` is the job's checkpoint; a slice killed after a batch committed
// but before its checkpoint was saved counts that batch once more on its rerun, which only makes those words' `df`
// slightly high until the next rebuild (an accepted inaccuracy of a ranking hint).

/** The vocabulary keeps this many words (§4.1). */
export const SEARCH_TERMS_MAX = 300_000;
/** Documents per batch: 200 documents of at most 4 × 60 000 bytes stay below 50 MB of text. */
export const SEARCH_TERMS_BATCH = 200;
/** Words per read/delete/insert of a merge. */
const MERGE_CHUNK = 500;
const WORD_MIN = 3;
const LETTERS_RE = /^\p{L}+$/u;

/** The vocabulary word of an index token (its decoded form), or null when the correction cannot use it. */
export function vocabularyWord(token: string): string | null {
  const word = decodeSearchToken(token);
  if (word === null || !LETTERS_RE.test(word)) return null;
  return Array.from(word).length >= WORD_MIN ? word : null;
}

/** Empties `search_term` (the first step of a rebuild). */
export async function clearSearchTerms(trx: Transaction<DB>): Promise<void> {
  await trx.deleteFrom('search_term').execute();
}

/** Adds `counts` (word → documents) to the `df` of `search_term`. */
async function merge(trx: Transaction<DB>, counts: ReadonlyMap<string, number>): Promise<void> {
  const words = [...counts.keys()];
  for (let i = 0; i < words.length; i += MERGE_CHUNK) {
    const chunk = words.slice(i, i + MERGE_CHUNK);
    const existing = new Map(
      (await trx.selectFrom('search_term').select(['term', 'df']).where('term', 'in', chunk).execute()).map((r) => [r.term, Number(r.df)]),
    );
    if (existing.size > 0) await trx.deleteFrom('search_term').where('term', 'in', [...existing.keys()]).execute();
    await trx
      .insertInto('search_term')
      .values(
        chunk.map((term) => {
          const letters = Array.from(term);
          return { term, first_char: letters[0]!, len: letters.length, df: (existing.get(term) ?? 0) + counts.get(term)! };
        }),
      )
      .execute();
  }
}

/**
 * Counts the words of the next documents after `afterDocNo` (at most `limit`, in `doc_no` order) into `search_term`,
 * in `trx`. Returns the last `doc_no` read, or null when no document is left.
 */
export async function addSearchTermsBatch(trx: Transaction<DB>, afterDocNo: number, limit: number = SEARCH_TERMS_BATCH): Promise<number | null> {
  const docs = await trx
    .selectFrom('search_doc')
    .select(['doc_no', 't_title', 't_agents', 't_subjects', 't_rest'])
    .where('doc_no', '>', afterDocNo)
    .where('is_public', '=', 1)
    .orderBy('doc_no')
    .limit(limit)
    .execute();
  if (docs.length === 0) return null;
  const counts = new Map<string, number>();
  for (const d of docs) {
    const seen = new Set<string>();
    for (const text of [d.t_title, d.t_agents, d.t_subjects, d.t_rest]) {
      if (text === '') continue;
      for (const token of text.split(' ')) {
        const word = vocabularyWord(token);
        if (word !== null) seen.add(word);
      }
    }
    for (const w of seen) counts.set(w, (counts.get(w) ?? 0) + 1);
  }
  await merge(trx, counts);
  return Number(docs[docs.length - 1]!.doc_no);
}

/** Keeps the {@link SEARCH_TERMS_MAX} words of highest `df` (ties by word, in the column's byte order). */
export async function finishSearchTerms(trx: Transaction<DB>): Promise<void> {
  const last = await trx
    .selectFrom('search_term')
    .select(['term', 'df'])
    .orderBy('df', 'desc')
    .orderBy('term')
    .limit(1)
    .offset(SEARCH_TERMS_MAX - 1)
    .executeTakeFirst();
  if (last === undefined) return;
  await trx.deleteFrom('search_term').where('df', '<', last.df).execute();
  await trx.deleteFrom('search_term').where('df', '=', last.df).where('term', '>', last.term).execute();
}
