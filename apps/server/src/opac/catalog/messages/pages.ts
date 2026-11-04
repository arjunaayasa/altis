import { defineOpacMessages } from './define.js';

// The OPAC copy of Halaman & Berita: page and news views, the news list and its feed (spec §9.5, §9.6). Owned by
// Task 20. Keys start with `pages.`; the same keys and {placeholders} in both languages, no English left in `id`
// (test/opac-messages.test.ts). Copy rules as for the shared catalogs: plain Indonesian, "Anda", one term per concept
// ("berita", "halaman", "umpan RSS").

export const PAGES_MESSAGES = defineOpacMessages(
  {
    'pages.fallback': 'Isi ini belum tersedia dalam bahasa Inggris, jadi ditampilkan dalam bahasa Indonesia.',
    'pages.news.title': 'Berita',
    'pages.news.title_paged': 'Berita, halaman {page}',
    'pages.news.description': 'Berita dan pengumuman terbaru dari {library}.',
    'pages.news.empty': 'Belum ada berita.',
    'pages.news.feed': 'Umpan RSS berita',
    'pages.news.feed_title': 'Berita {library}',
    'pages.news.published': 'Terbit {date}',
    'pages.news.back': 'Semua berita',
    'pages.news.pager': 'Halaman daftar berita',
    'pages.news.newer': 'Berita lebih baru',
    'pages.news.older': 'Berita lebih lama',
    'pages.news.page_of': 'Halaman {page} dari {pages}',
  },
  {
    'pages.fallback': 'This content is not available in English yet, so it is shown in Indonesian.',
    'pages.news.title': 'News',
    'pages.news.title_paged': 'News, page {page}',
    'pages.news.description': 'The latest news and announcements from {library}.',
    'pages.news.empty': 'There is no news yet.',
    'pages.news.feed': 'News RSS feed',
    'pages.news.feed_title': '{library} news',
    'pages.news.published': 'Published {date}',
    'pages.news.back': 'All news',
    'pages.news.pager': 'News list pages',
    'pages.news.newer': 'Newer news',
    'pages.news.older': 'Older news',
    'pages.news.page_of': 'Page {page} of {pages}',
  },
);
