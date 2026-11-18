import { createRoute } from '@tanstack/react-router';
import { lazyScreen, type shellRoute } from '@/routes';

// The admin route of OPAC › Halaman awal: `/admin/opac/beranda`, the home page of the public site (its photo, texts,
// profile blocks and the blocks shown), and of Situs / OPAC › Identitas situs: `/admin/opac/identitas` (the library's
// logo, icon, site name and tagline), each on its screen's lazy chunk.

/** The routes of the OPAC home page's and the site identity's screens, children of the shell. */
export function opacHomeRoutes(shell: typeof shellRoute) {
  return [
    createRoute({
      getParentRoute: () => shell,
      path: 'opac/beranda',
      component: lazyScreen(() => import('@/screens/opac-home/index'), 'OpacHomeScreen'),
    }),
    createRoute({
      getParentRoute: () => shell,
      path: 'opac/identitas',
      component: lazyScreen(() => import('@/screens/site-identity/index'), 'SiteIdentityScreen'),
    }),
  ];
}
