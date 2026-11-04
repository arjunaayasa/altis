import {
  fullTextExcluded,
  fullTextRanked,
  fullTextWhere,
  type DB,
  type FtExpr,
  type FullTextFamily,
  type FullTextField,
} from '@altis/db';
import { sql, type Expression, type Kysely, type SelectQueryBuilder, type SqlBool, type Transaction } from 'kysely';
import { INNODB_STOPWORDS, SEARCH_TOKEN_MAX, SEARCH_TOKEN_PREFIX, encodeSearchToken } from './tokenize.js';
import type { ParsedClause, ParsedQuery, ParsedTerm, SearchField } from './query-parse.js';
import type { CatalogSearchQuery, FacetName } from './types.js';

// The dialect-neutral SQL of a catalogue search (Phase 2 spec §4.4–§4.6) over `search_doc`: the scope, the filters (each
// facet filter an IN over `search_facet`'s (facet, value_key, record_id) index), the text (the registered full-text
// helpers of @altis/db, the only per-dialect SQL) and the orders. search.ts runs what this builds.

/** The deepest page served (§4.5: 50 pages, 1 000 hits at 20 a page). */
export const SEARCH_PAGE_MAX = 50;
/** Totals are counted up to this many hits ("lebih dari 10.000"). */
export const SEARCH_TOTAL_CAP = 10_000;
/** Facets are counted over at most this many top hits (§4.6). */
export const SEARCH_FACET_TOP = 5_000;
export const SEARCH_PAGE_SIZE_DEFAULT = 20;
/** The largest page (50 pages of 200 reach the counted total). */
export const SEARCH_PAGE_SIZE_MAX = 200;
/** The most values one filter takes; a value is 1–64 characters (`search_facet.value_key`). */
const FILTER_VALUES_MAX = 100;
const FILTER_VALUE_MAX = 64;

/** The tables of a search query: `search_doc`, and the relevance `ft` (`doc_no`, `score`) of a ranked one. */
export type SearchDB = DB & { ft: { doc_no: number; score: number } };
export type SearchQB = SelectQueryBuilder<SearchDB, 'search_doc' | 'ft', object>;

type Db = Kysely<DB> | Transaction<DB>;

/** The column group of each field of the syntax (`isbn`, `publisher`, `callno` live in `t_rest`). */
const FIELD_COLUMNS: Readonly<Record<SearchField, FullTextField>> = {
  all: 'all',
  title: 't_title',
  author: 't_agents',
  subject: 't_subjects',
  isbn: 'all',
  publisher: 'all',
  callno: 'all',
};

/** The encoded stopwords a prefix also stands for (`abo*` covers `about`, stored as `zqabout`). */
function stopwordsStartingWith(prefix: string): string[] {
  return [...new Set(INNODB_STOPWORDS)].filter((w) => w.startsWith(prefix)).map(encodeSearchToken);
}

/**
 * A prefix of digits, with an `e` after them or not, also begins float-like tokens (`2e10x`, stored `zq2e10x`). That
 * form is cut to the token limit as the stored token is (C07: 83 digits and a star would be an 85-character token,
 * which the full-text helpers refuse); the form is ASCII, so a UTF-16 cut is a code-point cut.
 */
const FLOAT_PREFIX_RE = /^[0-9]+e?$/;

/** The full-text expression of one term. */
function termExpr(t: ParsedTerm): FtExpr {
  const field = FIELD_COLUMNS[t.field];
  if (t.prefix) {
    const token = t.tokens[0]!;
    const plain = !token.startsWith(SEARCH_TOKEN_PREFIX);
    const forms = plain ? stopwordsStartingWith(token) : [];
    const floats: FtExpr[] =
      plain && FLOAT_PREFIX_RE.test(token) ? [{ kind: 'term', token: `${SEARCH_TOKEN_PREFIX}${token}`.slice(0, SEARCH_TOKEN_MAX), prefix: true, field }] : [];
    const items: FtExpr[] = [{ kind: 'term', token, prefix: true, field }, ...floats, ...forms.map((f): FtExpr => ({ kind: 'term', token: f, field }))];
    return items.length === 1 ? items[0]! : { kind: 'or', items };
  }
  if (t.phrase) return { kind: 'phrase', tokens: t.tokens, field };
  return { kind: 'term', token: t.tokens[0]!, field };
}

/** The full-text expression of one clause: its alternatives ORed. */
export function clauseExpr(c: ParsedClause): FtExpr {
  return c.terms.length === 1 ? termExpr(c.terms[0]!) : { kind: 'or', items: c.terms.map(termExpr) };
}

/** What a parsed query asks of the text: the positive clauses ANDed (null without any), and each excluded clause. */
export interface TextPlan {
  positive: FtExpr | null;
  negative: FtExpr[];
}

export function textPlan(parsed: ParsedQuery): TextPlan {
  const pos = parsed.clauses.filter((c) => !c.negated).map(clauseExpr);
  return {
    positive: pos.length === 0 ? null : pos.length === 1 ? pos[0]! : { kind: 'and', items: pos },
    negative: parsed.clauses.filter((c) => c.negated).map(clauseExpr),
  };
}

/** `values` as a filter list: strings of 1–64 characters, at most 100, without repeats; null when none is left. */
function filterValues(values: unknown): string[] | null {
  if (!Array.isArray(values)) return null;
  const out = [...new Set(values.filter((v): v is string => typeof v === 'string' && v.length > 0 && v.length <= FILTER_VALUE_MAX))].slice(
    0,
    FILTER_VALUES_MAX,
  );
  return out.length === 0 ? null : out;
}

/** An integer of [min, max], else null. */
function intIn(v: unknown, min: number, max: number): number | null {
  return typeof v === 'number' && Number.isInteger(v) && v >= min && v <= max ? v : null;
}

/** `search_doc.record_id IN (the records with one of these facet values)`. */
function facetIn(facet: FacetName, values: readonly string[]): Expression<SqlBool> {
  return sql<SqlBool>`${sql.ref('search_doc.record_id')} IN (SELECT ${sql.ref('sf.record_id')} FROM ${sql.table('search_facet')} AS ${sql.id('sf')} WHERE ${sql.ref('sf.facet')} = ${facet} AND ${sql.ref('sf.value_key')} IN (${sql.join(values)}))`;
}

/** The predicates of the scope and the filters (each one AND). */
export function scopeAndFilters(q: CatalogSearchQuery): Expression<SqlBool>[] {
  const where: Expression<SqlBool>[] = [];
  const f = q.filters ?? {};
  if (q.scope === 'admin') {
    const archived = f.includeArchived === true;
    const hidden = f.includeHidden === true;
    if (!archived && !hidden) where.push(sql<SqlBool>`${sql.ref('search_doc.is_public')} = 1`);
    else if (!archived) where.push(sql<SqlBool>`${sql.ref('search_doc.is_archived')} = 0`);
    else if (!hidden) where.push(sql<SqlBool>`(${sql.ref('search_doc.is_public')} = 1 OR ${sql.ref('search_doc.is_archived')} = 1)`);
  } else {
    // The OPAC, and anything that is not `admin`: public records only.
    where.push(sql<SqlBool>`${sql.ref('search_doc.is_public')} = 1`);
  }
  const lists: [FacetName, unknown][] = [
    ['mt', f.materialTypeIds],
    ['lg', f.languageIds],
    ['ct', f.collectionTypeIds],
    ['br', f.branchIds],
    ['lc', f.locationIds],
    ['sb', f.subjectIds],
    ['at', f.attachmentKinds],
  ];
  for (const [facet, raw] of lists) {
    const values = filterValues(raw);
    if (values !== null) where.push(facetIn(facet, values));
  }
  if (f.available === true) where.push(facetIn('av', ['1']));
  const digit = intIn(f.classDigit, 0, 9);
  if (digit !== null) where.push(facetIn('cl', [String(digit)]));
  const agents = filterValues(f.agentIds);
  if (agents !== null) {
    where.push(
      sql<SqlBool>`${sql.ref('search_doc.record_id')} IN (SELECT ${sql.ref('ra.record_id')} FROM ${sql.table('record_agents')} AS ${sql.id('ra')} WHERE ${sql.ref('ra.agent_id')} IN (${sql.join(agents)}))`,
    );
  }
  const from = intIn(f.yearFrom, 0, 9999);
  const to = intIn(f.yearTo, 0, 9999);
  if (from !== null) where.push(sql<SqlBool>`${sql.ref('search_doc.year')} >= ${from}`);
  if (to !== null) where.push(sql<SqlBool>`${sql.ref('search_doc.year')} <= ${to}`);
  return where;
}

/** `search_doc.record_id IN (the records holding this identifier)`: the ISBN/ISSN-first match (§4.4). */
export function identifierIn(id: { type: 'isbn' | 'issn'; key: string }): Expression<SqlBool> {
  return sql<SqlBool>`${sql.ref('search_doc.record_id')} IN (SELECT ${sql.ref('ri.record_id')} FROM ${sql.table('record_identifiers')} AS ${sql.id('ri')} WHERE ${sql.ref('ri.type')} = ${id.type} AND ${sql.ref('ri.value_key')} = ${id.key})`;
}

/** What the rows of a search are: its predicates, and the relevance join when it ranks. */
export interface SearchSource {
  family: FullTextFamily;
  where: Expression<SqlBool>[];
  /** The positive text, joined as `ft` with its relevance (only when the order is relevance). */
  ranked: FtExpr | null;
}

/** The predicates of a text plan (the positive one too unless it is ranked, which its join already restricts). */
export function textPredicates(family: FullTextFamily, text: TextPlan, ranked: boolean): Expression<SqlBool>[] {
  const out: Expression<SqlBool>[] = [];
  if (text.positive !== null && !ranked) out.push(fullTextWhere(family, 'all', text.positive));
  for (const n of text.negative) out.push(fullTextExcluded(family, 'all', n));
  return out;
}

/** `FROM search_doc [JOIN (<relevance>) AS ft] WHERE …`, without a selection. */
export function fromSource(db: Db, s: SearchSource): SearchQB {
  let qb = db.selectFrom('search_doc') as unknown as SearchQB;
  if (s.ranked !== null) {
    const ft = sql<{ doc_no: number; score: number }>`(${fullTextRanked(s.family, 'all', s.ranked)})`.as('ft');
    qb = qb.innerJoin(ft as never, (join) => join.onRef('ft.doc_no' as never, '=', 'search_doc.doc_no' as never)) as unknown as SearchQB;
  }
  for (const w of s.where) qb = qb.where(w);
  return qb;
}

/** The sort orders of §4.5. */
export type SearchSort = NonNullable<CatalogSearchQuery['sort']>;

/** `qb` ordered by `sort`, each order ending with `doc_no` (§4.5: the tie-breaker). */
export function ordered(qb: SearchQB, sort: SearchSort): SearchQB {
  switch (sort) {
    case 'relevance':
      return qb.orderBy(sql.ref('ft.score'), 'desc').orderBy('search_doc.doc_no');
    case 'title':
      return qb.orderBy('search_doc.title_key').orderBy('search_doc.doc_no');
    case 'year_desc':
    case 'year_asc': {
      // A record without a year comes last either way (NULLs sort differently on each dialect).
      const missing = sql`CASE WHEN ${sql.ref('search_doc.year')} IS NULL THEN 1 ELSE 0 END`;
      const dir = sort === 'year_desc' ? 'desc' : 'asc';
      return qb.orderBy(missing).orderBy('search_doc.year', dir).orderBy('search_doc.doc_no');
    }
    case 'newest':
    default:
      // S14: (is_public, created_at) or (created_at), read backwards; doc_no is the rowid SQLite's index ends with.
      return qb.orderBy('search_doc.created_at', 'desc').orderBy('search_doc.doc_no', 'desc');
  }
}
