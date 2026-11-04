import type { AreaMatrix } from './catalog.js';

// The matrix rows, fixtures and maintenance entries of the OPAC shell (Phase 2 Task 21): robots.txt, the sitemaps and
// the old SLiMS links, as the plan's route catalog gives them (public, `session: 'none'`, mode read, `maintenance:
// allow`, no idempotency store, no audit). The home page `opac.home` keeps its 1b row in db/matrix.test.ts (its
// declaration did not change). Every fixture is anonymous: no persona is turned away, and none needs a seed.

const PUBLIC_PAGE = 'pub- | - | - | read | allow | none | null | - | -';

export const MATRIX: AreaMatrix = {
  rows: {
    'opac.robots': `GET /robots.txt | ${PUBLIC_PAGE}`,
    'opac.sitemap.index': `GET /sitemap.xml | ${PUBLIC_PAGE}`,
    'opac.sitemap.catalog': `GET /sitemap/katalog/:n | ${PUBLIC_PAGE}`,
    'opac.sitemap.pages': `GET /sitemap/halaman | ${PUBLIC_PAGE}`,
    'opac.legacy': `GET /index.php | ${PUBLIC_PAGE}`,
  },
  fixtures: {
    'opac.robots': async () => ({}),
    'opac.sitemap.index': async () => ({}),
    'opac.sitemap.catalog': async () => ({ params: { n: '1' } }),
    'opac.sitemap.pages': async () => ({}),
    'opac.legacy': async () => ({ query: { p: 'show_detail', id: '7' } }),
  },
  maintenance: {
    'opac.robots': 'allow',
    'opac.sitemap.index': 'allow',
    'opac.sitemap.catalog': 'allow',
    'opac.sitemap.pages': 'allow',
    'opac.legacy': 'allow',
  },
};
