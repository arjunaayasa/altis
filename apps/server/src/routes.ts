import { ADMIN_ROUTES } from './admin/serve.js';
import { AUDIT_ROUTES } from './api/audit.js';
import { AUTH_ROUTES } from './api/auth.js';
import { AUTH_MFA_ROUTES } from './api/auth-mfa.js';
import { AUTH_PASSWORD_ROUTES } from './api/auth-password.js';
import { BACKUP_ROUTES } from './api/backups.js';
import { ACCREDITATION_ROUTES } from './api/accreditation/index.js';
import { CATALOG_ROUTES } from './api/catalog/index.js';
import { CIRCULATION_ROUTES } from './api/circulation/index.js';
import { CRON_ROUTES } from './api/cron.js';
import { DASHBOARD_ROUTES } from './api/dashboard.js';
import { DIAGNOSTICS_ROUTES } from './api/diagnostics.js';
import { EVENTS_ROUTES } from './api/events.js';
import { FILES_ROUTES } from './api/files.js';
import { JOBS_ROUTES } from './api/jobs.js';
import { MEMBERS_ROUTES } from './api/members/index.js';
import { testOnlyRoutes } from './api/test-only.js';
import { USERS_ROUTES } from './api/users.js';
import { ROLE_ROUTES } from './api/roles.js';
import { BRANCH_ROUTES } from './api/branches.js';
import { NOTIFICATIONS_ROUTES } from './api/notifications.js';
import { REPORTS_ROUTES } from './api/reports/index.js';
import { OPS_ROUTES } from './api/ops.js';
import { SETTINGS_ROUTES } from './api/settings.js';
import { UPDATES_ROUTES } from './api/updates.js';
import { HEALTH_PATH } from './http/health.js';
import { defineRoutes, route, type RouteDecl } from './http/route.js';
import { INSTALL_ROUTES } from './install/routes.js';
import { OPAC_CATALOG_ROUTES } from './opac/catalog/index.js';
import { OPAC_ROUTES } from './opac/routes.js';

// Every route the app serves (spec §4.6, decision D4), in the order of the plan's route catalog. createApp mounts
// these and refuses to start when a Hono route has no declaration here. An edition appends its own routes here
// (ruling R2).

/**
 * GET /_health (spec §11): never behind a session, answered in every phase, no database work but its live check.
 * `maintenance: 'restore-allow'` (1c Task 15): it answers during a restore too, with 503 `maintenance` (http/health.ts).
 */
const health = route({
  id: 'health',
  method: 'GET',
  path: HEALTH_PATH,
  public: true,
  session: 'none',
  maintenance: 'restore-allow',
  idempotency: 'none',
  audit: null,
  handler: (rc) => rc.services.health(rc.c),
});

// ---- Komunitas K1 (reports and accreditation) ----
/**
 * The community routes: the reports, then the accreditation workspace (each area's list filled by its own change),
 * then members and circulation.
 */
export const KOMUNITAS_ROUTES: RouteDecl[] = [...REPORTS_ROUTES, ...ACCREDITATION_ROUTES, ...MEMBERS_ROUTES, ...CIRCULATION_ROUTES];

export const ALL_ROUTES: RouteDecl[] = defineRoutes([
  health,
  ...AUTH_ROUTES,
  ...AUTH_MFA_ROUTES,
  ...AUTH_PASSWORD_ROUTES,
  ...USERS_ROUTES,
  ...ROLE_ROUTES,
  ...BRANCH_ROUTES,
  ...SETTINGS_ROUTES,
  ...AUDIT_ROUTES,
  ...CRON_ROUTES,
  ...JOBS_ROUTES,
  // 1c Task 15: the ops routes; they must stay before ADMIN_ROUTES (M3: Hono serves the first match, and Task 19's
  // `/admin/_update` must precede `admin.index`).
  ...OPS_ROUTES,
  ...EVENTS_ROUTES,
  ...NOTIFICATIONS_ROUTES,
  ...DASHBOARD_ROUTES, // 1c Task 26
  ...FILES_ROUTES,
  ...BACKUP_ROUTES, // 1c Task 20
  ...DIAGNOSTICS_ROUTES, // 1c Task 23
  ...UPDATES_ROUTES, // 1d Task 28
  // ---- Phase 2 (catalog): Task 3 ----
  // The catalog API (api/catalog/index.ts, one list per area), after the 1c groups and before INSTALL_ROUTES.
  ...CATALOG_ROUTES,
  // ---- Komunitas K1 (reports and accreditation) ----
  // The reports and the accreditation workspace, after the catalog API and before INSTALL_ROUTES.
  ...KOMUNITAS_ROUTES,
  ...INSTALL_ROUTES,
  ...ADMIN_ROUTES,
  // ---- Phase 2 (catalog): Task 3 ----
  // The catalogue's OPAC pages, feeds and OAI-PMH (opac/catalog/index.ts), right before the OPAC's `/` and assets.
  ...OPAC_CATALOG_ROUTES,
  ...OPAC_ROUTES,
  // Test build profile only (S28): none in a production build.
  ...testOnlyRoutes(),
]);
