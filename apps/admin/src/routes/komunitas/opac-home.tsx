import { createRoute } from '@tanstack/react-router';
import { lazyScreen, type shellRoute } from '@/routes';

// The admin route of OPAC › Halaman awal: `/admin/opac/beranda`, the home page of the public site (its photo, texts,
// profile blocks and the blocks shown), on its screen's lazy chunk.

/** The route of the OPAC home page's screen, a child of the shell. */
export function opacHomeRoutes(shell: typeof shellRoute) {
  return [
    createRoute({
      getParentRoute: () => shell,
      path: 'opac/beranda',
      component: lazyScreen(() => import('@/screens/opac-home/index'), 'OpacHomeScreen'),
    }),
  ];
}
