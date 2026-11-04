import { createRoute } from '@tanstack/react-router';
import { lazyScreen, type shellRoute } from '@/routes';

// The admin routes of Duplikat (Phase 2): `/admin/catalog/duplicates` (the last scan, its groups and the comparison;
// Task 29). Created by Task 3 with the final paths, each on its screen's lazy chunk; Task 29 needs no search params
// and edits no shared file (routes.tsx spreads catalogRoutes once).

/** The routes of Duplikat, children of the shell. */
export function duplicatesRoutes(shell: typeof shellRoute) {
  return [
    createRoute({
      getParentRoute: () => shell,
      path: 'catalog/duplicates',
      component: lazyScreen(() => import('@/screens/catalog/duplicates/index'), 'DuplicatesScreen'),
    }),
  ];
}
