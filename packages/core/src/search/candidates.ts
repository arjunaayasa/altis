import { fullTextFamily, type DB, type FtExpr } from '@altis/db';
import type { Kysely } from 'kysely';
import { fromSource, ordered } from './sql.js';
import { SEARCH_TOKEN_PREFIX, searchTokenize } from './tokenize.js';

// The candidates of duplicate detection (Phase 2 spec §3.3): the live records whose title shares words with `title`,
// best first by the full-text relevance over the title column. The similarity itself (Dice) is computed by the caller.

/** The most title words asked for (a bound on the query). */
const WORDS_MAX = 32;
/** The most candidates returned. */
const LIMIT_MAX = 200;

/**
 * The ids of at most `limit` live (not archived) records whose title matches a word of `title`, by relevance over
 * `t_title`. The encoded short words and stopwords (`zq…`) are used only when the title has no other word. An empty
 * title, or one without a token, has no candidate.
 */
export async function titleCandidates(db: Kysely<DB>, title: string, limit: number): Promise<string[]> {
  if (typeof title !== 'string') return [];
  const n = Number.isInteger(limit) ? Math.min(LIMIT_MAX, Math.max(0, limit)) : 0;
  if (n === 0) return [];
  const tokens = [...new Set(searchTokenize(title))];
  const plain = tokens.filter((t) => !t.startsWith(SEARCH_TOKEN_PREFIX));
  const words = (plain.length > 0 ? plain : tokens).slice(0, WORDS_MAX);
  if (words.length === 0) return [];
  const expr: FtExpr = { kind: 'or', items: words.map((token): FtExpr => ({ kind: 'term', token, field: 't_title' })) };
  const source = { family: fullTextFamily(db), where: [], ranked: expr };
  const rows = (await ordered(fromSource(db, source), 'relevance')
    .where('search_doc.is_archived', '=', 0)
    .select('search_doc.record_id')
    .limit(n)
    .execute()) as unknown as { record_id: string }[];
  return rows.map((r) => r.record_id);
}
