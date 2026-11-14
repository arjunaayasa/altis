import { createRoute } from '@tanstack/react-router';
import { lazyScreen, type shellRoute } from '@/routes';

// The admin routes of Anggota: `/admin/anggota` (the list), `/admin/anggota/baru` (a new member),
// `/admin/anggota/tipe` (member types), `/admin/anggota/impor` (the CSV import) and `/admin/anggota/$memberId` (one
// member; the static segments outrank it, and a member id is a ULID).

/** The routes of Anggota, children of the shell. */
export function membersRoutes(shell: typeof shellRoute) {
  return [
    createRoute({
      getParentRoute: () => shell,
      path: 'anggota',
      component: lazyScreen(() => import('@/screens/members/list'), 'MembersListScreen'),
    }),
    createRoute({
      getParentRoute: () => shell,
      path: 'anggota/baru',
      component: lazyScreen(() => import('@/screens/members/edit'), 'MemberCreateScreen'),
    }),
    createRoute({
      getParentRoute: () => shell,
      path: 'anggota/tipe',
      component: lazyScreen(() => import('@/screens/members/types'), 'MemberTypesScreen'),
    }),
    createRoute({
      getParentRoute: () => shell,
      path: 'anggota/impor',
      component: lazyScreen(() => import('@/screens/members/import'), 'MemberImportScreen'),
    }),
    // ---- Komunitas (circulation core): clearance letters ----
    createRoute({
      getParentRoute: () => shell,
      path: 'anggota/bebas-pustaka',
      component: lazyScreen(() => import('@/screens/members/clearances'), 'ClearancesScreen'),
    }),
    createRoute({
      getParentRoute: () => shell,
      path: 'anggota/$memberId',
      component: lazyScreen(() => import('@/screens/members/edit'), 'MemberDetailScreen'),
    }),
  ];
}
