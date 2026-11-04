// The `opac-pages` barrel (Phase 2): created empty by Task 3, filled by the task that owns the module (Task 20, Halaman &
// Berita). It exports only the names its task's Interfaces list, generic ones with a prefix (M14;
// packages/core/test/barrels.test.ts).
export { archivePage, createPage, getPage, listPages, previewBody, updatePage } from './service.js';
export { OPAC_NEWS_PER_PAGE, latestNews, newsPage, publishedPage } from './queries.js';
export type { OpacNewsItem, OpacNewsPage, OpacNewsText, OpacPageTranslation, OpacPublishedPage } from './queries.js';
