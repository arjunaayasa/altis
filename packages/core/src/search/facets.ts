import type { DB } from '@altis/db';
import { sql, type Kysely, type SelectQueryBuilder, type Transaction } from 'kysely';
import type { CatalogSearchResult, FacetName } from './types.js';

// The facet counts of a search (Phase 2 spec §4.6): over the top hits only (at most SEARCH_FACET_TOP of them, in the
// search's order; the caller marks the counts approximate beyond), one GROUP BY over `search_facet`. The subject facet
// keeps its 10 largest values (§4.6), every other facet its 100 largest; ties go by value.

const FACETS: readonly FacetName[] = ['mt', 'lg', 'ct', 'br', 'lc', 'av', 'at', 'sb', 'cl'];
const SUBJECT_VALUES_MAX = 10;
const VALUES_MAX = 100;

type Db = Kysely<DB> | Transaction<DB>;

/** A query selecting the `record_id` of the hits whose facets are counted (already limited and ordered). */
// eslint-disable-next-line @typescript-eslint/no-explicit-any
export type TopHits = SelectQueryBuilder<any, any, { record_id: string }>;

/** The counts of every facet over `top` (see the top of this file); a facet without a value is left out. */
export async function countFacets(db: Db, top: TopHits): Promise<NonNullable<CatalogSearchResult['facets']>> {
  const rows = await (db as Kysely<DB & { top: { record_id: string } }>)
    .selectFrom('search_facet as f')
    .innerJoin(top.as('top'), 'top.record_id', 'f.record_id')
    .select(['f.facet', 'f.value_key', sql<number | string | bigint>`count(*)`.as('n')])
    .groupBy(['f.facet', 'f.value_key'])
    .execute();
  const byFacet = new Map<FacetName, { value: string; count: number }[]>();
  for (const r of rows) {
    const facet = r.facet as FacetName;
    if (!FACETS.includes(facet)) continue;
    const list = byFacet.get(facet) ?? [];
    list.push({ value: r.value_key, count: Number(r.n) });
    byFacet.set(facet, list);
  }
  const out: NonNullable<CatalogSearchResult['facets']> = {};
  for (const facet of FACETS) {
    const list = byFacet.get(facet);
    if (list === undefined) continue;
    list.sort((a, b) => b.count - a.count || (a.value < b.value ? -1 : a.value > b.value ? 1 : 0));
    out[facet] = list.slice(0, facet === 'sb' ? SUBJECT_VALUES_MAX : VALUES_MAX);
  }
  return out;
}
