import type { AreaMatrix } from './catalog.js';

// The matrix rows, fixtures and maintenance entries of the index rebuild (Phase 2, Task 15): `POST catalog/search/reindex`
// as the plan's route catalog gives it (DM, mode system, maintenance deny, store, audit `catalog.search.reindex`). Its
// fixture needs nothing: the route queues (or joins) the one full rebuild.

export const MATRIX: AreaMatrix = {
  rows: {
    'catalog.search.reindex':
      'POST /api/v1/catalog/search/reindex | P:system.diagnostics.manage | - | - | system | deny | store | catalog.search.reindex | handler | -',
  },
  fixtures: {
    'catalog.search.reindex': async () => ({}),
  },
  maintenance: {},
};
