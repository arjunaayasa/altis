// Komunitas, the agenda of the news: what tables.test.ts expects of migration 0051, written out by hand in the
// notations of tables.test.ts. It creates no table: it adds `pages.category`, `pages.event_starts_at`,
// `pages.event_ends_at` and `pages.event_place`, and two indexes. Kept in its own module so that tables.test.ts only
// spreads it in.

/** Which migration creates which tables: 0051 creates none. */
export const NEWS_AGENDA_TABLES_BY_MIGRATION: Record<string, string[]> = {
  '0051_news_agenda': [],
};

export interface NewsAgendaIndexFacts {
  table: string;
  name: string;
  unique: boolean;
  columns: string[];
}

/** The indexes of 0051. */
export const NEWS_AGENDA_INDEXES: NewsAgendaIndexFacts[] = [
  { table: 'pages', name: 'ix_pages_kind_status_event_starts_at', unique: false, columns: ['kind', 'status', 'event_starts_at'] },
  { table: 'pages', name: 'ix_pages_kind_status_category_published_at', unique: false, columns: ['kind', 'status', 'category', 'published_at'] },
];
