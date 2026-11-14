import type { RouteDecl } from '../../http/route.js';
import { REPORT_CATALOG_ROUTES } from './catalog.js';
import { REPORT_RUN_ROUTES } from './runs.js';

// The reports API (one list per area, each filled by the change that owns it): the catalogue and the preview, then the
// runs. Joined into ALL_ROUTES through KOMUNITAS_ROUTES (routes.ts).

export const REPORTS_ROUTES: RouteDecl[] = [...REPORT_CATALOG_ROUTES, ...REPORT_RUN_ROUTES];
