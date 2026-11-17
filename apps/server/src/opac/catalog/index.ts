import type { RouteDecl } from '../../http/route.js';
import { OPAC_ADVANCED_ROUTES } from './advanced-routes.js';
import { OPAC_DETAIL_ROUTES } from './detail-routes.js';
import { OAI_ROUTES } from './oai-routes.js';
import { OPAC_PAGES_ROUTES } from './pages-routes.js';
import { OPAC_SEARCH_ROUTES } from './search-routes.js';
import { OPAC_SHELL_ROUTES } from './shell-routes.js';

// The catalogue's public pages, feeds and machine endpoints (Phase 2, spec §9, §10), one file per area, each owned by
// its task. routes.ts spreads OPAC_CATALOG_ROUTES once, right before OPAC_ROUTES (whose `/` and `/assets/:file` come
// last). Every route here is `public`, `session: 'none'`, `mode: read`, `maintenance: allow`, `idempotency: none`,
// `audit: null`, without a `query` schema (§9.1); a page answers through opacPage (page.tsx), a missing object with
// `opacPage(…, {status: 404})` (S17).

export const OPAC_CATALOG_ROUTES: RouteDecl[] = [
  ...OPAC_PAGES_ROUTES,
  ...OPAC_SHELL_ROUTES,
  ...OPAC_SEARCH_ROUTES,
  // ---- Komunitas (OPAC look) ----
  ...OPAC_ADVANCED_ROUTES,
  ...OPAC_DETAIL_ROUTES,
  ...OAI_ROUTES,
];
