import { createRoute } from '@tanstack/react-router';
import { lazyScreen, type shellRoute } from '@/routes';

// The admin routes of the catalogue and OPAC settings page (Phase 2): `/admin/settings/catalog`. Created by Task 3
// with the final paths, each on its screen's lazy chunk; Task 28 may add `validateSearch` here and edits no shared
// file (routes.tsx spreads catalogRoutes once).

/** The routes of the catalogue and OPAC settings page, children of the shell. */
export function catalogSettingsRoutes(shell: typeof shellRoute) {
  return [
    createRoute({
      getParentRoute: () => shell,
      path: 'settings/catalog',
      component: lazyScreen(() => import('@/screens/settings/catalog'), 'CatalogSettingsScreen'),
    }),
  ];
}
