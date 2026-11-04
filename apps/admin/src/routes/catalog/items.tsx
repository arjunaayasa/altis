import { createRoute } from '@tanstack/react-router';
import { lazyScreen, type shellRoute } from '@/routes';
import { itemsSearchOf } from '@/screens/catalog/items/search';

// The admin routes of Eksemplar (Phase 2): `/admin/catalog/items`, `/admin/catalog/items/$itemId`. Created by Task 3
// with the final paths, each on its screen's lazy chunk; Task 25 adds the list's `validateSearch` (its filters, from a
// small module outside the screen's chunk) and edits no shared file (routes.tsx spreads catalogRoutes once).

/** The routes of Eksemplar, children of the shell. */
export function itemsRoutes(shell: typeof shellRoute) {
  return [
    createRoute({
      getParentRoute: () => shell,
      path: 'catalog/items',
      validateSearch: itemsSearchOf,
      component: lazyScreen(() => import('@/screens/catalog/items/list'), 'ItemsListScreen'),
    }),
    createRoute({
      getParentRoute: () => shell,
      path: 'catalog/items/$itemId',
      component: lazyScreen(() => import('@/screens/catalog/items/edit'), 'ItemEditScreen'),
    }),
  ];
}
