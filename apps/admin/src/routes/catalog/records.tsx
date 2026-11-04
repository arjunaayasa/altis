import { createRoute } from '@tanstack/react-router';
import { lazyScreen, type shellRoute } from '@/routes';

// The admin routes of Bibliografi (Phase 2): `/admin/catalog/records`, `/admin/catalog/records/new`,
// `/admin/catalog/records/$recordId`. Created by Task 3 with the final paths, each on its screen's lazy chunk; Task
// 24 edits no shared file (routes.tsx spreads catalogRoutes once). There is no `validateSearch`: the screens read their
// own search params (`parseRecordsSearch` in list.tsx, `?tab=` in edit.tsx), dropping anything unknown or malformed,
// so the parsers stay in the screens' lazy chunks.

/** The routes of Bibliografi, children of the shell. */
export function recordsRoutes(shell: typeof shellRoute) {
  return [
    createRoute({
      getParentRoute: () => shell,
      path: 'catalog/records',
      component: lazyScreen(() => import('@/screens/catalog/records/list'), 'RecordsListScreen'),
    }),
    createRoute({
      getParentRoute: () => shell,
      path: 'catalog/records/new',
      component: lazyScreen(() => import('@/screens/catalog/records/edit'), 'RecordCreateScreen'),
    }),
    createRoute({
      getParentRoute: () => shell,
      path: 'catalog/records/$recordId',
      component: lazyScreen(() => import('@/screens/catalog/records/edit'), 'RecordEditScreen'),
    }),
  ];
}
