import type { AreaMatrix } from './catalog.js';

// The matrix rows, fixtures and maintenance entries of SRU copy and ISBN lookup (Phase 2 Task 32; the plan's route
// catalog): the ISBN lookup and the SRU search need `catalog.records.manage` and are plain GETs (no transaction of
// their own declared, `idempotency: none`, no audit); the SRU server test needs `system.settings.manage` and is a
// read-only POST (`mode: read`) running `tx: 'self'`, so no transaction is open while it calls out. All three are
// `deny` in maintenance, so there is no maintenance entry.
//
// The fixtures never reach the network: with the seeded settings no SRU server is enabled, so the lookup asks no
// source and the search ends at its disabled server (422 after the gate); the test's URL is
// a cloud metadata address, which the outbound client refuses even with `catalog.sru.allowPrivateHosts` before it
// connects (200 `{ok: false, code: 'CATALOG_OUTBOUND_BLOCKED'}`).

export const MATRIX: AreaMatrix = {
  rows: {
    'catalog.lookup.isbn': 'GET /api/v1/catalog/lookup/isbn/:isbn | P:catalog.records.manage | - | - | read | deny | none | null | - | -',
    'catalog.sru.search': 'GET /api/v1/catalog/sru/search | P:catalog.records.manage | - | - | read | deny | none | null | - | -',
    'catalog.sru.test': 'POST /api/v1/catalog/sru/test | P:system.settings.manage | - | - | read | deny | none | null | self | -',
  },
  fixtures: {
    'catalog.lookup.isbn': async () => ({ params: { isbn: '9786020332956' } }),
    'catalog.sru.search': async () => ({ query: { server: 'perpusnas', index: 'title', q: 'matriks' } }),
    'catalog.sru.test': async () => ({ body: { url: 'http://169.254.169.254/sru', version: '1.2' } }),
  },
  maintenance: {},
};
