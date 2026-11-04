// The `builtin` search provider (spec §4; Phase 2). Task 3 created the seams with their final signatures; Task 15 filled
// them and added its own names here (prefixed per M14). Helpers (the SQL builders, the document builder, the vocabulary
// batches, the housekeeping step, which catalog/housekeeping.ts runs) stay internal.

export type { CatalogSearchQuery, CatalogSearchResult, FacetName, SearchHealth } from './types.js';
export { indexRecords } from './index-records.js';
export { searchCatalog } from './search.js';
export { titleCandidates } from './candidates.js';
export { searchHealth } from './health.js';
export {
  REINDEX_ALL_KEY,
  REINDEX_RECORD_IDS_MAX,
  REINDEX_TERMS_KEY,
  enqueueReindex,
  reindexJob,
  reindexPayload,
  searchJobs,
} from './jobs.js';
export type { ReindexPayload, ReindexScope } from './jobs.js';
// ---- Phase 2 (catalog): Task 15 ----
export { INNODB_STOPWORDS, SEARCH_TOKEN_VERSION, encodeSearchToken, searchTokenize } from './tokenize.js';
export { parseQuery as parseSearchQuery } from './query-parse.js';
export type { ParsedClause as ParsedSearchClause, ParsedQuery as ParsedSearchQuery, ParsedTerm as ParsedSearchTerm } from './query-parse.js';
export { suggestCorrections } from './spelling.js';
