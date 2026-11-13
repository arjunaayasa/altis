import { createRoute } from '@tanstack/react-router';
import { lazyScreen, type shellRoute } from '@/routes';

// The admin routes of Laporan: `/admin/reports` (the report catalogue) and `/admin/reports/$reportId` (one report:
// filters, preview, print and exports). Created with the final paths, each on its screen's lazy chunk; the owning task
// may add a `validateSearch` here and edits no shared file (routes.tsx spreads komunitasRoutes once).

/** The routes of Laporan, children of the shell. */
export function reportsRoutes(shell: typeof shellRoute) {
  return [
    createRoute({
      getParentRoute: () => shell,
      path: 'reports',
      component: lazyScreen(() => import('@/screens/reports/catalog'), 'ReportsCatalogScreen'),
    }),
    createRoute({
      getParentRoute: () => shell,
      path: 'reports/$reportId',
      component: lazyScreen(() => import('@/screens/reports/detail'), 'ReportDetailScreen'),
    }),
  ];
}
