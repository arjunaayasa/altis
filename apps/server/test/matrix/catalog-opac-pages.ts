import type { AreaMatrix } from './catalog.js';

// The matrix rows, fixtures and maintenance entries of the OPAC pages of Halaman & Berita (Phase 2 Task 20; the plan's
// route catalog) and of the library's profile and gallery: `public`, `session: 'none'`, mode read, `maintenance: allow`, no idempotency store, no audit; the
// feed is declared before `/berita/:slug`. Every fixture is anonymous: no persona is turned away (an unknown slug is
// the OPAC's own 404 page, past the gate), and none needs a seed.

const PUBLIC_PAGE = 'pub- | - | - | read | allow | none | null | - | -';

export const MATRIX: AreaMatrix = {
  rows: {
    'opac.page': `GET /halaman/:slug | ${PUBLIC_PAGE}`,
    'opac.news.rss': `GET /berita/rss | ${PUBLIC_PAGE}`,
    'opac.news.list': `GET /berita | ${PUBLIC_PAGE}`,
    'opac.news.get': `GET /berita/:slug | ${PUBLIC_PAGE}`,
    'opac.profile': `GET /profil | ${PUBLIC_PAGE}`,
    'opac.gallery': `GET /galeri | ${PUBLIC_PAGE}`,
  },
  fixtures: {
    'opac.page': async () => ({ params: { slug: 'tentang-kami' } }),
    'opac.news.rss': async () => ({}),
    'opac.news.list': async () => ({ query: { hal: '2' } }),
    'opac.news.get': async () => ({ params: { slug: 'pengumuman' } }),
    'opac.profile': async () => ({}),
    'opac.gallery': async () => ({}),
  },
  maintenance: {
    'opac.page': 'allow',
    'opac.news.rss': 'allow',
    'opac.news.list': 'allow',
    'opac.news.get': 'allow',
    'opac.profile': 'allow',
    'opac.gallery': 'allow',
  },
};
