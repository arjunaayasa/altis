import { countRows, fullTextFamily, type DB, type FullTextFamily } from '@altis/db';
import { sql, type Kysely, type Transaction } from 'kysely';
import { identifierQuery } from '../catalog/lib/identifiers.js';
import { countFacets } from './facets.js';
import { parseQuery, type ParsedQuery } from './query-parse.js';
import { correctedText, suggestCorrections } from './spelling.js';
import {
  SEARCH_FACET_TOP,
  SEARCH_PAGE_MAX,
  SEARCH_PAGE_SIZE_DEFAULT,
  SEARCH_PAGE_SIZE_MAX,
  SEARCH_TOTAL_CAP,
  fromSource,
  identifierIn,
  ordered,
  popularOrderBranches,
  scopeAndFilters,
  textPlan,
  textPredicates,
  type SearchQB,
  type SearchSort,
  type SearchSource,
} from './sql.js';
import type { CatalogSearchQuery, CatalogSearchResult } from './types.js';

// A catalogue search (Phase 2 spec §4.4–§4.7), the OPAC's and the admin's:
//
// 1. A query shaped like an ISBN or ISSN (with or without hyphens or a label) is matched against `record_identifiers`
//    first; when that finds a record, those are the hits (§4.4).
// 2. Otherwise the parsed query (query-parse.ts) is the text: the positive clauses through the full-text helpers, each
//    excluded clause as `doc_no NOT IN (…)`. Every search also takes its scope (OPAC: public records only) and its
//    filters (sql.ts).
// 3. The order: `relevance` by default with text, `newest` without (S14: read through `ix_search_doc_public_created`
//    or `ix_search_doc_created`, never by sorting `records`); then `title`, `year_desc`, `year_asc`; `doc_no` breaks
//    ties. Pages are 1-based, at most 50 deep (`pageLimitReached` past it, with no ids); the total is counted up to
//    10 000 (`totalCapped` beyond); facets over the top 5 000 hits (`facetsApproximate` beyond).
// 4. Typo tolerance (§4.7): the correctable words of the positive clauses that `search_term` does not hold are corrected
//    (spelling.ts). With no hit, the corrected query is run instead (`correction.applied`, when it finds something);
//    with hits, the correction is only offered.
// 5. `building`: `search_state` is missing or says a rebuild runs, so the results may be incomplete (§2.3).

type Db = Kysely<DB> | Transaction<DB>;

/** What a run of one parsed query answered. */
interface Run {
  recordIds: string[];
  total: number;
  totalCapped: boolean;
  facets: CatalogSearchResult['facets'];
  facetsApproximate: boolean;
}

/** The page and its size of `q`, bounded. */
function pageOf(q: CatalogSearchQuery): { page: number; size: number } {
  const page = typeof q.page === 'number' && Number.isInteger(q.page) && q.page >= 1 ? q.page : 1;
  const size =
    typeof q.pageSize === 'number' && Number.isInteger(q.pageSize) ? Math.min(SEARCH_PAGE_SIZE_MAX, Math.max(1, q.pageSize)) : SEARCH_PAGE_SIZE_DEFAULT;
  return { page, size };
}

/** The order of `q` when its text has (or has no) positive clause. */
function sortOf(q: CatalogSearchQuery, hasText: boolean): SearchSort {
  const s = q.sort;
  const known: readonly SearchSort[] = ['relevance', 'newest', 'title', 'year_desc', 'year_asc', 'popular'];
  if (s !== undefined && known.includes(s)) return s === 'relevance' && !hasText ? 'newest' : s;
  return hasText ? 'relevance' : 'newest';
}

/** The source (predicates, relevance join) of a parsed query, or of an identifier match. */
function sourceOf(family: FullTextFamily, q: CatalogSearchQuery, parsed: ParsedQuery | { id: { type: 'isbn' | 'issn'; key: string } }): {
  source: SearchSource;
  sort: SearchSort;
} {
  const where = scopeAndFilters(q);
  const popularBranches = popularOrderBranches(q);
  if ('id' in parsed) {
    const sort = sortOf(q, false);
    return { source: { family, where: [...where, identifierIn(parsed.id)], ranked: null, popularBranches }, sort };
  }
  const text = textPlan(parsed);
  const sort = sortOf(q, text.positive !== null);
  const ranked = sort === 'relevance' ? text.positive : null;
  return { source: { family, where: [...where, ...textPredicates(family, text, ranked !== null)], ranked, popularBranches }, sort };
}

/** The page query of a source: `search_doc.record_id` in `sort` order, one page. */
function pageQuery(db: Db, source: SearchSource, sort: SearchSort, page: number, size: number): SearchQB {
  return ordered(fromSource(db, source), sort, source.popularBranches)
    .select('search_doc.record_id')
    .limit(size)
    .offset((page - 1) * size) as unknown as SearchQB;
}

/** Runs one source: the capped total, the page, the facets. */
async function run(db: Db, q: CatalogSearchQuery, source: SearchSource, sort: SearchSort, countOnly: boolean): Promise<Run> {
  const hits = fromSource(db, source).select(sql<number>`1`.as('one')).limit(SEARCH_TOTAL_CAP + 1);
  const counted = await countRows((db as Kysely<DB>).selectFrom(hits.as('hits') as never).selectAll());
  const total = Math.min(counted, SEARCH_TOTAL_CAP);
  const out: Run = { recordIds: [], total, totalCapped: counted > SEARCH_TOTAL_CAP, facets: q.facets === true ? {} : null, facetsApproximate: false };
  if (countOnly || total === 0) return out;

  const { page, size } = pageOf(q);
  if (page <= SEARCH_PAGE_MAX && (page - 1) * size < total) {
    const rows = (await pageQuery(db, source, sort, page, size).execute()) as unknown as { record_id: string }[];
    out.recordIds = rows.map((r) => r.record_id);
  }
  if (q.facets === true) {
    // Over every hit when there are at most 5 000 (no order needed), else over the first 5 000 in the search's order.
    const approximate = counted > SEARCH_FACET_TOP;
    let top = fromSource(db, source);
    if (approximate) top = ordered(top, sort, source.popularBranches);
    out.facets = await countFacets(db, top.select('search_doc.record_id').limit(SEARCH_FACET_TOP) as never);
    out.facetsApproximate = approximate;
  }
  return out;
}

/** Whether `search_state` says the index is complete. */
async function building(db: Db): Promise<boolean> {
  const state = await db.selectFrom('search_state').select('status').where('id', '=', 1).executeTakeFirst();
  return state?.status !== 'ready';
}

/** The normalized (unencoded) words of the positive, non-prefix terms: what the spelling correction looks at. */
function correctableWords(parsed: ParsedQuery): string[] {
  return parsed.clauses.filter((c) => !c.negated).flatMap((c) => c.terms.filter((t) => !t.prefix).flatMap((t) => t.words));
}

/**
 * The page query the text of a search runs (for tests: its plan; see the top of this file). The identifier match a
 * search tries first, at run time, is not part of it.
 */
export function searchPageQuery(db: Db, q: CatalogSearchQuery): SearchQB {
  const family = fullTextFamily(db);
  const { source, sort } = sourceOf(family, q, parseQuery(typeof q.text === 'string' ? q.text : ''));
  const { page, size } = pageOf(q);
  return pageQuery(db, source, sort, page, size);
}

/**
 * Runs a catalogue search (spec §4.4–§4.7; see the top of this file). `o.now` is the request's time (the search reads
 * no clock-dependent data). Never throws for any query text: broken syntax is read as words.
 */
export async function searchCatalog(db: Kysely<DB>, q: CatalogSearchQuery, o: { now: number }): Promise<CatalogSearchResult> {
  void o;
  const family = fullTextFamily(db);
  const text = typeof q.text === 'string' ? q.text : '';
  const { page } = pageOf(q);
  const pageLimitReached = page > SEARCH_PAGE_MAX;
  const isBuilding = await building(db);
  const result = (r: Run, correction: CatalogSearchResult['correction']): CatalogSearchResult => ({
    recordIds: r.recordIds,
    total: r.total,
    totalCapped: r.totalCapped,
    pageLimitReached,
    facets: r.facets,
    facetsApproximate: r.facetsApproximate,
    correction,
    building: isBuilding,
  });

  // 1. ISBN/ISSN first.
  const id = text.trim() === '' ? null : identifierQuery(text);
  if (id !== null) {
    const { source, sort } = sourceOf(family, q, { id });
    const byId = await run(db, q, source, sort, false);
    if (byId.total > 0) return result(byId, null);
  }

  // 2.-3. The text.
  const parsed = parseQuery(text);
  const { source, sort } = sourceOf(family, q, parsed);
  const first = await run(db, q, source, sort, false);

  // 4. Typo tolerance.
  const words = correctableWords(parsed);
  if (words.length === 0) return result(first, null);
  const fixes = await suggestCorrections(db, words);
  if (fixes.size === 0) return result(first, null);
  const to = correctedText(text, fixes);
  if (to === text) return result(first, null);
  if (first.total > 0) return result(first, { from: text, to, applied: false });
  const again = sourceOf(family, q, parseQuery(to));
  const second = await run(db, q, again.source, again.sort, false);
  if (second.total === 0) return result(first, { from: text, to, applied: false });
  return result(second, { from: text, to, applied: true });
}
