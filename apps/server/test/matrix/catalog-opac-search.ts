import type { AreaMatrix } from './catalog.js';

// The matrix rows, fixtures and maintenance entries of the OPAC search and feeds (Phase 2 Task 33): `/cari`, `/cari/rss`
// and `/rss`, as the plan's route catalog gives them (public, `session: 'none'`, mode read, `maintenance: allow`, no
// idempotency store, no audit); the two search routes count the per-IP bucket `opac_search`. Every fixture is
// anonymous: no persona is turned away, none needs a seed (an empty catalogue answers an empty page or feed), and the
// matrix gives every call a client address of its own, so the bucket never fills up. The advanced search page
// (`/cari/lanjutan`) is a public page of the same kind, without a bucket: it runs no search.

const PUBLIC_PAGE = 'pub- | - | - | read | allow | none | null | -';

export const MATRIX: AreaMatrix = {
  rows: {
    'opac.search': `GET /cari | ${PUBLIC_PAGE} | ip:opac_search`,
    'opac.search.rss': `GET /cari/rss | ${PUBLIC_PAGE} | ip:opac_search`,
    'opac.rss': `GET /rss | ${PUBLIC_PAGE} | -`,
    'opac.search.advanced': `GET /cari/lanjutan | ${PUBLIC_PAGE} | -`,
  },
  fixtures: {
    'opac.search': async () => ({ query: { q: 'laskar', jenis: 'BUKU' } }),
    'opac.search.rss': async () => ({ query: { q: 'laskar' } }),
    'opac.rss': async () => ({}),
    'opac.search.advanced': async () => ({ query: { q: 'laskar', jenis: 'BUKU' } }),
  },
  maintenance: {
    'opac.search': 'allow',
    'opac.search.rss': 'allow',
    'opac.rss': 'allow',
    'opac.search.advanced': 'allow',
  },
};
