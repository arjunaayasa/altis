import { createRoute } from '@tanstack/react-router';
import { lazyScreen, type shellRoute } from '@/routes';

// The admin routes of Cetak Label (Phase 2): `/admin/catalog/labels`. Created by Task 3 with the final paths, each on
// its screen's lazy chunk; Task 30 may add `validateSearch` here and edits no shared file (routes.tsx spreads
// catalogRoutes once).

/** The routes of Cetak Label, children of the shell. */
export function labelsRoutes(shell: typeof shellRoute) {
  return [
    createRoute({
      getParentRoute: () => shell,
      path: 'catalog/labels',
      component: lazyScreen(() => import('@/screens/catalog/labels/index'), 'LabelsScreen'),
    }),
  ];
}
