import { createRoute, redirect } from '@tanstack/react-router';
import { lazyScreen, type shellRoute } from '@/routes';
import { OPAC_HOME_TABS } from '@/screens/opac-home/tabs';

// The admin routes of OPAC › Halaman awal: `/admin/opac/beranda/<tab>`, the home page of the public site (the hero's
// slides, the short profile, the services, the gallery, the hours and contact, the blocks shown), one screen whose
// tabs share one draft; `/admin/opac/beranda` and an address that names no tab go to the first tab. And of Situs / OPAC
// › Identitas situs: `/admin/opac/identitas` (the library's logo, icon, site name and tagline). Each on its screen's
// lazy chunk.

/** The routes of the OPAC home page's and the site identity's screens, children of the shell. */
export function opacHomeRoutes(shell: typeof shellRoute) {
  const toFirstTab = (): never => {
    throw redirect({ to: '/admin/opac/beranda/$tab', params: { tab: OPAC_HOME_TABS[0] }, replace: true });
  };
  return [
    createRoute({
      getParentRoute: () => shell,
      path: 'opac/beranda',
      beforeLoad: toFirstTab,
    }),
    createRoute({
      getParentRoute: () => shell,
      path: 'opac/beranda/$tab',
      beforeLoad: ({ params }) => {
        if (!(OPAC_HOME_TABS as readonly string[]).includes(params.tab)) toFirstTab();
      },
      component: lazyScreen(() => import('@/screens/opac-home/index'), 'OpacHomeScreen'),
    }),
    createRoute({
      getParentRoute: () => shell,
      path: 'opac/identitas',
      component: lazyScreen(() => import('@/screens/site-identity/index'), 'SiteIdentityScreen'),
    }),
  ];
}
