import { createRoute } from '@tanstack/react-router';
import { lazyScreen, type shellRoute } from '@/routes';

// The admin routes of Lokasi & Rak (Phase 2): `/admin/catalog/locations` (`?branchId=`, read by the screen). Created by
// Task 3 with the final paths, each on its screen's lazy chunk; Task 27 edits no shared file (routes.tsx spreads
// catalogRoutes once). There is no `validateSearch`: the screen reads `?branchId=` itself and falls back to a branch
// the user may manage when it names no live branch, so the parser stays in its lazy chunk.

/** The routes of Lokasi & Rak, children of the shell. */
export function locationsRoutes(shell: typeof shellRoute) {
  return [
    createRoute({
      getParentRoute: () => shell,
      path: 'catalog/locations',
      component: lazyScreen(() => import('@/screens/catalog/locations/index'), 'LocationsScreen'),
    }),
  ];
}
