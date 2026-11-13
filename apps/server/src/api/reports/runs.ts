import type { RouteDecl } from '../../http/route.js';

// The routes of the report runs: their start (`POST reports/runs`, `reports/runs/personal`), their list and views, and
// the download of their file. Empty until they are written; the change that writes them fills this list, and the area's
// matrix rows and audit script.

export const REPORT_RUN_ROUTES: RouteDecl[] = [];
