import { createRoute } from '@tanstack/react-router';
import { lazyScreen, type shellRoute } from '@/routes';

// The admin route of Pengaturan Akreditasi: `/admin/settings/accreditation`, a page of Pengaturan beside the catalogue
// settings. Created with the final path on its screen's lazy chunk; the owning task edits no shared file.

/** The route of Pengaturan Akreditasi, a child of the shell. */
export function accreditationSettingsRoutes(shell: typeof shellRoute) {
  return [
    createRoute({
      getParentRoute: () => shell,
      path: 'settings/accreditation',
      component: lazyScreen(() => import('@/screens/settings/accreditation'), 'AccreditationSettingsScreen'),
    }),
    // ---- Komunitas (circulation core) ----
    createRoute({
      getParentRoute: () => shell,
      path: 'settings/circulation',
      component: lazyScreen(() => import('@/screens/settings/circulation'), 'CirculationSettingsScreen'),
    }),
    // ---- Komunitas K2 (visits, privacy) ----
    createRoute({
      getParentRoute: () => shell,
      path: 'settings/kunjungan',
      component: lazyScreen(() => import('@/screens/settings/visits'), 'VisitsSettingsScreen'),
    }),
    createRoute({
      getParentRoute: () => shell,
      path: 'settings/privasi',
      component: lazyScreen(() => import('@/screens/settings/visits'), 'PrivacySettingsScreen'),
    }),
  ];
}
