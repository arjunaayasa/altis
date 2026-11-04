import { createRoute } from '@tanstack/react-router';
import { lazyScreen, type shellRoute } from '@/routes';

// The admin routes of Data Induk (Phase 2): `/admin/catalog/masters` (`?tab=`, read by the screen),
// `/admin/catalog/masters/material-types/new` and `/admin/catalog/masters/material-types/$id` (a static `new`
// outranks `$id`). Created by Task 3 with the final paths, each on its screen's lazy chunk; Task 27 added the `new`
// page and edits no shared file (routes.tsx spreads catalogRoutes once). There is no `validateSearch`: the screen
// reads `?tab=` itself and ignores anything unknown, so the parser stays in its lazy chunk.

/** The routes of Data Induk, children of the shell. */
export function mastersRoutes(shell: typeof shellRoute) {
  return [
    createRoute({
      getParentRoute: () => shell,
      path: 'catalog/masters',
      component: lazyScreen(() => import('@/screens/catalog/masters/index'), 'MastersScreen'),
    }),
    createRoute({
      getParentRoute: () => shell,
      path: 'catalog/masters/material-types/new',
      component: lazyScreen(() => import('@/screens/catalog/masters/material-type'), 'MaterialTypeCreateScreen'),
    }),
    createRoute({
      getParentRoute: () => shell,
      path: 'catalog/masters/material-types/$id',
      component: lazyScreen(() => import('@/screens/catalog/masters/material-type'), 'MaterialTypeEditScreen'),
    }),
  ];
}
