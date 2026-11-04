import { createRoute } from '@tanstack/react-router';
import { lazyScreen, type shellRoute } from '@/routes';
import { validateExchangeSearch } from '@/screens/catalog/exchange/search';

// The admin routes of Impor/Ekspor and the catalog runs (Phase 2): `/admin/catalog/exchange` (the tabs Impor, Ekspor
// and Riwayat; `?tab=` and Bibliografi's `?export=selection` are search params, Task 29) and
// `/admin/catalog/runs/$runId` (one run). Created by Task 3 with the final paths, each on its screen's lazy chunk;
// Task 29 added the `validateSearch` (search.ts holds no React, so the screen stays in its chunk) and edits no shared
// file (routes.tsx spreads catalogRoutes once).

/** The routes of Impor/Ekspor and the catalog runs, children of the shell. */
export function exchangeRoutes(shell: typeof shellRoute) {
  return [
    createRoute({
      getParentRoute: () => shell,
      path: 'catalog/exchange',
      validateSearch: validateExchangeSearch,
      component: lazyScreen(() => import('@/screens/catalog/exchange/index'), 'ExchangeScreen'),
    }),
    createRoute({
      getParentRoute: () => shell,
      path: 'catalog/runs/$runId',
      component: lazyScreen(() => import('@/screens/catalog/exchange/run'), 'RunDetailScreen'),
    }),
  ];
}
