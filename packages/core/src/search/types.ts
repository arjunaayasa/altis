// The vocabulary of the `builtin` search provider (spec §4; Phase 2 Task 3, owned by Task 15 afterwards).
//
// Task 3 fixes these shapes so that every Wave 1 task (records, items, the OPAC search, the dashboard) builds against
// them before Task 15 brings the provider; Task 15 may add to them but keeps every field.

/** The health of the index as Diagnostik shows it (B2: defined in `@altis/shared/api/diagnostics`). */
export type { SearchHealth } from '@altis/shared/api/diagnostics';

/**
 * The facets of `search_facet.facet` (§4.6): material type, language, collection type (of the items), branch, location
 * (room level), available (`1`), attachment kind, subject, and `cl` (M4), the first digit (`0`–`9`) of the record's
 * classification, which `indexRecords` writes and `filters.classDigit` / `/cari?kelas=N` match.
 */
export type FacetName = 'mt' | 'lg' | 'ct' | 'br' | 'lc' | 'av' | 'at' | 'sb' | 'cl';

/** A search (§4.4–§4.6) from the OPAC (`scope: 'opac'`: public records only) or the admin. */
export interface CatalogSearchQuery {
  /** The query text in the §4.4 syntax; '' for none (then the default order is `newest`). */
  text: string;
  scope: 'opac' | 'admin';
  filters?: {
    materialTypeIds?: string[];
    languageIds?: string[];
    collectionTypeIds?: string[];
    branchIds?: string[];
    locationIds?: string[];
    subjectIds?: string[];
    agentIds?: string[];
    /** Only records with an `available` item in a public location (facet `av`). */
    available?: boolean;
    /** Facet `at` values: `pdf`, `audio`, `video`, `image`, `url`, `other`. */
    attachmentKinds?: string[];
    /** Facet `cl` (M4): the first digit of the classification, 0–9. */
    classDigit?: number;
    yearFrom?: number;
    yearTo?: number;
    /** Admin only. */
    includeArchived?: boolean;
    /** Admin only: records with `opac_visible = 0`. */
    includeHidden?: boolean;
  };
  /** Default `relevance` with a query text, `newest` without. */
  sort?: 'relevance' | 'newest' | 'title' | 'year_desc' | 'year_asc';
  /** 1-based; at most 50 for relevance (§4.5). */
  page?: number;
  pageSize?: number;
  /** Count the facets of the hits (the OPAC result page). */
  facets?: boolean;
}

/** What a search answers: record ids in order (the caller loads what it shows), counts, facets, a spelling fix. */
export interface CatalogSearchResult {
  recordIds: string[];
  /** Counted up to 10 000 (`totalCapped` beyond). */
  total: number;
  totalCapped: boolean;
  /** The page asked for is past the deepest page served (§4.5: 50 pages, 1 000 hits). */
  pageLimitReached: boolean;
  /** Per facet, its values with their counts; null when facets were not asked for. */
  facets: Partial<Record<FacetName, { value: string; count: number }[]>> | null;
  /** The counts come from the top 5 000 hits only (§4.6). */
  facetsApproximate: boolean;
  /** §4.7: the corrected query, and whether it was run in place of the original (no hits). */
  correction: { from: string; to: string; applied: boolean } | null;
  /** `search_state` says a rebuild is running: the results may be incomplete. */
  building: boolean;
}
