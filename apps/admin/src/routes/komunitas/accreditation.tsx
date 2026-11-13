import { createRoute } from '@tanstack/react-router';
import { lazyScreen, type shellRoute } from '@/routes';
import { validateAccreditationSearch } from '@/screens/accreditation/search';

// The admin routes of Akreditasi: `/admin/accreditation` (the workspace, its latest period), `/admin/accreditation/new`
// (a new period; a static segment outranks `$periodId`) and `/admin/accreditation/$periodId?tab=` (one period, on one of
// its tabs; search.ts holds no React, so the screen stays in its chunk). Created with the final paths, each on its
// screen's lazy chunk; the owning tasks edit no shared file (routes.tsx spreads komunitasRoutes once).

/** The routes of Akreditasi, children of the shell. */
export function accreditationRoutes(shell: typeof shellRoute) {
  return [
    createRoute({
      getParentRoute: () => shell,
      path: 'accreditation',
      component: lazyScreen(() => import('@/screens/accreditation/index'), 'AccreditationScreen'),
    }),
    createRoute({
      getParentRoute: () => shell,
      path: 'accreditation/new',
      component: lazyScreen(() => import('@/screens/accreditation/new-period'), 'PeriodCreateScreen'),
    }),
    createRoute({
      getParentRoute: () => shell,
      path: 'accreditation/$periodId',
      validateSearch: validateAccreditationSearch,
      component: lazyScreen(() => import('@/screens/accreditation/index'), 'AccreditationScreen'),
    }),
  ];
}
