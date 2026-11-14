import { createRoute } from '@tanstack/react-router';
import { lazyScreen, type shellRoute } from '@/routes';

// The admin routes of Layanan (the circulation desk and its lists): `/admin/layanan` (Meja Layanan; `?member=<id>`
// opens that member's panel, from the member pages), `/admin/layanan/kembali` (Kembali Cepat, the desk in return mode
// as a page of its own), `/admin/layanan/terlambat` (the overdue list) and `/admin/layanan/aturan` (the loan rules).
// A member travels by id only, never by number or name.

/** The search of the desk: the member whose panel it opens (a ULID; anything else is ignored). */
export interface DeskSearch {
  member?: string;
}

export function validateDeskSearch(search: Record<string, unknown>): DeskSearch {
  const member = search['member'];
  return typeof member === 'string' && /^[0-9A-HJKMNP-TV-Z]{26}$/.test(member) ? { member } : {};
}

/** The routes of Layanan, children of the shell. */
export function circulationRoutes(shell: typeof shellRoute) {
  return [
    createRoute({
      getParentRoute: () => shell,
      path: 'layanan',
      validateSearch: validateDeskSearch,
      component: lazyScreen(() => import('@/screens/circulation/desk'), 'DeskScreen'),
    }),
    createRoute({
      getParentRoute: () => shell,
      path: 'layanan/kembali',
      component: lazyScreen(() => import('@/screens/circulation/desk'), 'QuickReturnScreen'),
    }),
    createRoute({
      getParentRoute: () => shell,
      path: 'layanan/terlambat',
      component: lazyScreen(() => import('@/screens/circulation/overdue'), 'OverdueScreen'),
    }),
    createRoute({
      getParentRoute: () => shell,
      path: 'layanan/aturan',
      component: lazyScreen(() => import('@/screens/circulation/policies'), 'PoliciesScreen'),
    }),
    // ---- Komunitas K2 (visits): the visit list and check-ins, and the guestbook stations ----
    createRoute({
      getParentRoute: () => shell,
      path: 'layanan/kunjungan',
      component: lazyScreen(() => import('@/screens/visits/visits'), 'VisitsScreen'),
    }),
    createRoute({
      getParentRoute: () => shell,
      path: 'layanan/buku-tamu',
      component: lazyScreen(() => import('@/screens/visits/visits'), 'StationsScreen'),
    }),
  ];
}
