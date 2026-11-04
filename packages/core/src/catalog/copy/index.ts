// The catalog's `copy` barrel (Phase 2): created empty by Task 3, filled by the task that owns the area. It exports
// only the names its task's Interfaces list, generic ones with a prefix (M14; packages/core/test/barrels.test.ts).

// ---- Task 9: the SRU client ----
export { parseSruResponse, sruSearch, sruSearchUrl } from './sru-client.js';
export type { SruDiagnostic, SruParsedResponse, SruSearchResult } from './sru-client.js';

// ---- Task 32: SRU copy and the ISBN lookup ----
export type { IsbnSource, MarcMaterialTypeFn } from './isbn-source.js';
export { copyMaterialTypeResolver, sruIsbnSource, sruSearchDrafts, sruTestServer } from './sru-source.js';
export { copyDuplicateHint, lookupIsbn } from './lookup.js';
export type { IsbnLookupOptions } from './lookup.js';
