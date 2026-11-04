import { createRoute } from '@tanstack/react-router';
import { lazyScreen, type shellRoute } from '@/routes';
import { validatePagesSearch } from '@/screens/pages/shared';

// The admin routes of Halaman & Berita (a static `new` outranks `$pageId`) (Phase 2): `/admin/opac/pages`,
// `/admin/opac/pages/new`, `/admin/opac/pages/$pageId`. Created by Task 3 with the final paths, each on its screen's
// lazy chunk; Task 20 may add `validateSearch` here and edits no shared file (routes.tsx spreads catalogRoutes once).
// The list and a new page take `?kind=news` (a static page without it; validatePagesSearch drops anything else).

/** The routes of Halaman & Berita, children of the shell. */
export function pagesRoutes(shell: typeof shellRoute) {
  return [
    createRoute({
      getParentRoute: () => shell,
      path: 'opac/pages',
      validateSearch: validatePagesSearch,
      component: lazyScreen(() => import('@/screens/pages/list'), 'PagesListScreen'),
    }),
    createRoute({
      getParentRoute: () => shell,
      path: 'opac/pages/new',
      validateSearch: validatePagesSearch,
      component: lazyScreen(() => import('@/screens/pages/edit'), 'PageCreateScreen'),
    }),
    createRoute({
      getParentRoute: () => shell,
      path: 'opac/pages/$pageId',
      component: lazyScreen(() => import('@/screens/pages/edit'), 'PageEditScreen'),
    }),
  ];
}
