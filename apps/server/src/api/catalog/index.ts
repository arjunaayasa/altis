import type { RouteDecl } from '../../http/route.js';
import { ATTACHMENTS_ROUTES } from './attachments.js';
import { AUTHORITIES_ROUTES } from './authorities.js';
import { COPY_ROUTES } from './copy.js';
import { EXCHANGE_ROUTES } from './exchange.js';
import { ITEMS_ROUTES } from './items.js';
import { LABELS_ROUTES } from './labels.js';
import { LOCATIONS_ROUTES } from './locations.js';
import { MASTERS_ROUTES } from './masters.js';
import { MIGRATION_ROUTES } from './migrations.js';
import { PAGES_API_ROUTES } from './pages.js';
import { RECORDS_ROUTES } from './records.js';
import { RUNS_ROUTES } from './runs.js';
import { SEARCH_ROUTES } from './search.js';

// The catalog's JSON API (Phase 2, spec §12.2), one file per area, each owned by its task (plan decision P2-02): a task
// fills its own list and never edits this file or routes.ts, which spreads CATALOG_ROUTES once, after the 1c API groups
// and before INSTALL_ROUTES. Hono serves the first match, so an area whose literal paths could be shadowed by a
// parameter of another (M3: the authorities' `catalog/agents`, never `catalog/:kind`) keeps literal paths.

export const CATALOG_ROUTES: RouteDecl[] = [
  ...MASTERS_ROUTES,
  ...AUTHORITIES_ROUTES,
  ...LOCATIONS_ROUTES,
  ...RECORDS_ROUTES,
  ...ATTACHMENTS_ROUTES,
  ...ITEMS_ROUTES,
  ...RUNS_ROUTES,
  ...EXCHANGE_ROUTES,
  ...COPY_ROUTES,
  ...LABELS_ROUTES,
  ...SEARCH_ROUTES,
  ...MIGRATION_ROUTES,
  ...PAGES_API_ROUTES,
];
