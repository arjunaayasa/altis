import { ensureColumn, ensureIndex } from '../ddl.js';
import type { AltisMigration } from '../migrator.js';

// 0051: the agenda of the OPAC's news. Expand only: four nullable columns without a default, each appended to `pages`
// with one ALTER TABLE ... ADD COLUMN, and two indexes. Only a row of `kind = news` ever fills them (the writer
// enforces it); a page leaves all four null.
//
// - pages.category: what kind of news it is, a stable code (`agenda`, `collection`, `announcement`, `activity`); null
//   for news without a category.
// - pages.event_starts_at, pages.event_ends_at: when the event the news announces starts and ends; null for news that
//   announces no event. An end is never stored without a start, and is never before it.
// - pages.event_place: where the event is held, a short free text.
// - ix_pages_kind_status_event_starts_at: the coming events, published news in the order of their start.
// - ix_pages_kind_status_category_published_at: the published news of one category, newest first.
// No table is created, so no class is named here.

export const newsAgenda: AltisMigration = {
  async up(db, dialect) {
    await ensureColumn(db, dialect, 'pages', (t) => t.varchar('category', 32).nullable());
    await ensureColumn(db, dialect, 'pages', (t) => t.timestamp('event_starts_at').nullable());
    await ensureColumn(db, dialect, 'pages', (t) => t.timestamp('event_ends_at').nullable());
    await ensureColumn(db, dialect, 'pages', (t) => t.varchar('event_place', 160).nullable());
    await ensureIndex(db, dialect, 'pages', 'ix_pages_kind_status_event_starts_at', ['kind', 'status', 'event_starts_at']);
    await ensureIndex(db, dialect, 'pages', 'ix_pages_kind_status_category_published_at', ['kind', 'status', 'category', 'published_at']);
  },
};
