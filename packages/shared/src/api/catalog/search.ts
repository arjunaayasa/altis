/**
 * The search API vocabulary of the admin (Phase 2 spec §4.8, §12.2; plan Tasks 15, 28). The index health itself is
 * part of the Diagnostik report (`SearchHealth`, `@altis/shared/api/diagnostics`).
 *
 * No Node built-ins here: the browser bundles this module. Import it as `@altis/shared/api/catalog/search`.
 */

/** `POST catalog/search/reindex`: the queued (or joined) `catalog.reindex` job of the whole catalog. */
export interface ReindexResponse {
  jobId: string;
}
