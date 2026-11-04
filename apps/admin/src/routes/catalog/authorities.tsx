import { createRoute } from '@tanstack/react-router';
import { lazyScreen, type shellRoute } from '@/routes';
import { validateAuthoritiesSearch } from '@/screens/catalog/authorities/search';

// The admin routes of Otoritas (Phase 2): `/admin/catalog/authorities` (the tabs Nama/Subjek/Penerbit, each with its
// list and its orphans; the tab, the view and the applied filters are search params, Task 26) and
// `/admin/catalog/authorities/$kind/$id` (one authority; `$id` `new` creates one). Created by Task 3 with the final
// paths, each on its screen's lazy chunk; Task 26 added the `validateSearch` (search.ts holds no React, so the screens
// stay in their chunk) and edits no shared file (routes.tsx spreads catalogRoutes once).

/** The routes of Otoritas, children of the shell. */
export function authoritiesRoutes(shell: typeof shellRoute) {
  return [
    createRoute({
      getParentRoute: () => shell,
      path: 'catalog/authorities',
      validateSearch: validateAuthoritiesSearch,
      component: lazyScreen(() => import('@/screens/catalog/authorities/index'), 'AuthoritiesScreen'),
    }),
    createRoute({
      getParentRoute: () => shell,
      path: 'catalog/authorities/$kind/$id',
      component: lazyScreen(() => import('@/screens/catalog/authorities/edit'), 'AuthorityEditScreen'),
    }),
  ];
}
