import fsp from 'node:fs/promises';
import os from 'node:os';
import path from 'node:path';
import { authorizeChannels, createUpdateSource, loadGrants, type Mailer } from '@altis/core';
import { PHASE1_MIGRATIONS, runMigrations } from '@altis/db';
import { isDomainError, newId, type AuditAction, type Permission } from '@altis/shared';
import { afterAll, beforeAll, describe, expect, it } from 'vitest';
import { engineLabel, testDb, testDbContext, type TestDbHandle } from '../../../../tools/test/test-db.js';
import { testOnlyRoutes } from '../../src/api/test-only.js';
import { createApp } from '../../src/app.js';
import { loadConfig, writeConfig } from '../../src/config.js';
import { routeMode } from '../../src/http/edition-gate.js';
import { OPS_ANY_PERMISSIONS } from '../../src/http/ops-auth.js';
import { SECURITY_AUDIT_ACTIONS, type RouteDecl } from '../../src/http/route.js';
import { ALL_ROUTES } from '../../src/routes.js';
import { createAgent, type AgentReply } from '../agent.js';
import {
  EXPECTED_SYSTEM_ROUTES,
  MATRIX_FIXTURES,
  OPS_KIND_PERMISSIONS,
  allPersonas,
  expected,
  holds,
  isPartial,
  opsCookieOp,
  outcomeOf,
  personaSession,
  restoreUsers,
  seedBranch,
  seedOkBackup,
  seedPersona,
  seedRole,
  seedUser,
  sendCall,
  snapshotUsers,
  type MatrixCall,
  type OpsCookie,
  type Persona,
  type PersonaUser,
  type SeedContext,
  type UserSnapshot,
} from '../matrix-fixtures.js';
import { CATALOG_MATRIX } from '../matrix/catalog.js';
import { KOMUNITAS_MATRIX, KOMUNITAS_PENDING_ROUTES } from '../matrix/komunitas.js';
import { removeOp } from '../ops-support.js';
import { recordingLogger, sampleConfig } from '../support.js';
import { devPackageKeys } from '../update-support.js';

// The permission matrix (spec §7.2, acceptance A4; 1b Task 31 with D43, B7; 1c Task 33 with M38) on the engine picked
// by ALTIS_TEST_DB:
// - coverage: MATRIX_FIXTURES has exactly one fixture per route of ALL_ROUTES (the 1c and test-profile routes
//   included), in the order of CATALOG, and every declaration is its row of the plans' route catalogs (expected()
//   reads the declarations, so this ties the two); the routes declared `mode: 'system'` are EXPECTED_SYSTEM_ROUTES;
// - the matrix: every route × every persona (matrix-fixtures.ts; 1c adds `ops_cookie`) gets the gate outcome
//   `expected()` gives, read from `X-Altis-Test-Gate`; no call is refused by CSRF/Origin (every persona sends what step
//   8 wants); and a persona denied on `system.*` routes leaves at most one `authz.denied` entry per minute;
// - audit once: every route with an `audit` action, called by a fresh super admin, appends exactly one entry of it and
//   none of another non-security action;
// - the A4 escalation cases, each → 403 (and spec §7.2 rule 5 for the `admin` role, a controller note), 1c's: the
//   restore is not an admin's, Diagnostik's realtime switch is; the channel case at function level and over HTTP (M19);
//   the ops cookie opens nothing but the ops routes; an undeclared route failing startup; 1d (Task 33, decision
//   D1d-11): an admin is denied the update-run routes and allowed their read routes;
// - CSRF/Origin of the 1c and 1d routes: every non-GET cookie route, and the side-effect GETs, refuse a foreign Origin
//   with 403 before the gate; `POST /_cron` with that Origin and the right bearer token works.
//
// The persona users are seeded once; before each route their accounts are put back as seeded (a route may change its
// caller's password or 2FA), and every call gets a new session (some routes end the session they run in) and a peer
// address of its own (no per-IP bucket fills up). The `ops_cookie` persona's op is made current for its call only. The
// clock stands at NOW for the whole file, so every `authz.denied` entry falls in one minute.

const ctx = testDbContext();
let h: TestDbHandle;

/** 5 s into a minute (M26), in the past: an audit entry may not be dated ahead of the real clock. */
const NOW = Date.UTC(2026, 9, 26, 9, 15, 5);
const CONFIG = sampleConfig({ db: { dialect: 'sqlite' } });
const EVIL_ORIGIN = 'https://evil.example';

const ROUTES_BY_ID = new Map(ALL_ROUTES.map((d) => [d.id, d]));

function routeOf(id: string): RouteDecl {
  const decl = ROUTES_BY_ID.get(id);
  if (decl === undefined) throw new Error(`no route ${id}`);
  return decl;
}

const codeOf = (res: AgentReply): string | undefined => (res.json as { code?: string } | undefined)?.code;

/**
 * The plans' route catalogs, one row per route, in catalog order: the 1b catalog's API routes (the Phase 1b plan, with
 * its list of `tx: 'self'` routes), the 1c catalog (the Phase 1c plan, with the changed 1b rows and ruling R1c-9), the
 * 1b catalog's pages, then the test-profile routes. A row is `METHOD path | access | partialAuth | reauth | mode |
 * maintenance | idempotency | audit | tx | extras`:
 * - access is `P:<permission>` (`@<branchParam>` for a branch-scoped one), `ops` (`opsAuth`), `inst0:page`,
 *   `inst0:claim` or `inst` (the wizard's `install: 'page' | 'claim' | 'claimed'`, public with `session: 'none'`),
 *   `pub` (session optional), `pub+s` (session required) or `pub-` (`session: 'none'`);
 * - a blank mode of a catalog is the default (GET `read`, else `write`), a blank maintenance `deny`, a blank tx
 *   `handler` (`-` on a GET route, which has none);
 * - extras are what the catalogs name besides: `bearer` (`auth: 'bearer'`), `background`, `sideEffects`, `rawBody`,
 *   `also:<alsoAudits>` and `ip:<ipLimits>`; `-` for none.
 * expected() reads the declarations, so this table is what ties the matrix to the catalogs; a declaration that differs
 * from its row is fixed in the declaration, not here.
 */
const CATALOG: Readonly<Record<string, string>> = {
  // 1c: `restore-allow` (it answers 503 `maintenance` during a restore itself).
  health: 'GET /_health | pub- | - | - | read | restore-allow | none | null | - | -',
  // ---- 1b: auth ----
  'auth.login': 'POST /api/v1/auth/login | pub | pA | - | system | allow | none | null | self | -',
  'auth.2fa.verify': 'POST /api/v1/auth/2fa/verify | pub+s | pA | - | system | allow | none | null | self | also:auth.2fa.disable',
  'auth.logout': 'POST /api/v1/auth/logout | pub+s | pA | - | system | allow | none | auth.logout | handler | -',
  'auth.me': 'GET /api/v1/auth/me | pub | pA | - | system | allow | none | null | - | -',
  'auth.me.update': 'PATCH /api/v1/auth/me | pub+s | - | - | system | deny | none | auth.profile.update | handler | -',
  'auth.password.change': 'POST /api/v1/auth/password/change | pub+s | - | - | system | deny | none | auth.password.change | self | -',
  'auth.password.forgot': 'POST /api/v1/auth/password/forgot | pub | - | - | system | deny | none | null | self | ip:forgot:ip',
  'auth.password.reset': 'POST /api/v1/auth/password/reset | pub | - | - | system | deny | none | auth.password.reset | handler | ip:reset:ip',
  // `tx: 'self'` besides the 1b list: setup reads the issuer before its transaction, whose first statement must lock
  // the user's row (api/auth-mfa.ts).
  'auth.2fa.setup': 'POST /api/v1/auth/2fa/setup | pub+s | pA | - | system | deny | none | null | self | -',
  'auth.2fa.enable': 'POST /api/v1/auth/2fa/enable | pub+s | pA | - | system | deny | none | auth.2fa.enable | self | -',
  'auth.2fa.disable': 'POST /api/v1/auth/2fa/disable | pub+s | - | - | system | deny | none | auth.2fa.disable | self | -',
  'auth.2fa.recovery_codes':
    'POST /api/v1/auth/2fa/recovery-codes | pub+s | - | reauth | system | deny | none | auth.2fa.recovery_codes | handler | -',
  'auth.sessions.list': 'GET /api/v1/auth/sessions | pub+s | - | - | system | deny | none | null | - | -',
  'auth.sessions.revoke': 'DELETE /api/v1/auth/sessions/:id | pub+s | - | - | system | deny | none | auth.session.revoke | handler | -',
  // Ruling R1c-9: `restore-allow`, and 409 OPS_POINT_OF_NO_RETURN past a restore's point of no return.
  'auth.reauth': 'POST /api/v1/auth/reauth | pub+s | - | - | system | restore-allow | none | null | self | -',
  // ---- 1b: users, permissions and roles ----
  'permissions.list': 'GET /api/v1/permissions | P:system.users.read | - | - | read | deny | none | null | - | -',
  'users.list': 'GET /api/v1/users | P:system.users.read | - | - | read | deny | none | null | - | -',
  'users.get': 'GET /api/v1/users/:id | P:system.users.read | - | - | read | deny | none | null | - | -',
  'users.create': 'POST /api/v1/users | P:system.users.manage | - | - | write | deny | store | users.create | handler | -',
  'users.update': 'PATCH /api/v1/users/:id | P:system.users.manage | - | - | write | deny | store | users.update | handler | -',
  'users.disable': 'POST /api/v1/users/:id/disable | P:system.users.manage | - | reauth | system | deny | store | users.disable | handler | -',
  'users.enable': 'POST /api/v1/users/:id/enable | P:system.users.manage | - | - | write | deny | store | users.enable | handler | -',
  'users.password.reset':
    'POST /api/v1/users/:id/reset-password | P:system.users.manage | - | reauth | write | deny | none | users.password.reset | handler | -',
  'users.2fa.reset': 'POST /api/v1/users/:id/reset-2fa | P:system.users.manage | - | reauth | write | deny | none | users.2fa.reset | handler | -',
  'users.roles.put':
    'PUT /api/v1/users/:id/roles | P:system.users.manage | - | reauth | system | deny | store | users.roles.update | handler | -',
  'roles.list': 'GET /api/v1/roles | P:system.users.read | - | - | read | deny | none | null | - | -',
  'roles.get': 'GET /api/v1/roles/:id | P:system.users.read | - | - | read | deny | none | null | - | -',
  'roles.create': 'POST /api/v1/roles | P:system.roles.manage | - | reauth | write | deny | store | roles.create | handler | -',
  'roles.update': 'PATCH /api/v1/roles/:id | P:system.roles.manage | - | reauth | write | deny | store | roles.update | handler | -',
  'roles.delete': 'DELETE /api/v1/roles/:id | P:system.roles.manage | - | reauth | write | deny | store | roles.delete | handler | -',
  // ---- 1b: branches ----
  'branches.list': 'GET /api/v1/branches | pub+s | - | - | read | deny | none | null | - | -',
  'branches.create': 'POST /api/v1/branches | P:system.branches.manage | - | - | write | deny | store | branches.create | handler | -',
  'branches.update': 'PATCH /api/v1/branches/:id | P:system.branches.manage | - | - | write | deny | store | branches.update | handler | -',
  'branches.archive': 'DELETE /api/v1/branches/:id | P:system.branches.manage | - | - | write | deny | store | branches.archive | handler | -',
  // ---- 1b: settings and system configuration ----
  'settings.get': 'GET /api/v1/settings/:group | P:system.settings.read | - | - | read | deny | none | null | - | -',
  'settings.security.put':
    'PUT /api/v1/settings/security | P:system.settings.manage | - | reauth | write | deny | store | settings.update | handler | -',
  'settings.library.put': 'PUT /api/v1/settings/library | P:system.settings.manage | - | - | write | deny | store | settings.update | handler | -',
  'settings.email.put': 'PUT /api/v1/settings/email | P:system.settings.manage | - | - | write | deny | store | settings.update | handler | -',
  'settings.opac.put': 'PUT /api/v1/settings/opac | P:system.settings.manage | - | - | write | deny | store | settings.update | handler | -',
  // ---- Phase 2 (catalog): Task 2 ----
  'settings.catalog.put':
    'PUT /api/v1/settings/catalog | P:system.settings.manage | - | - | write | deny | store | settings.update | handler | -',
  'catalog.config': 'GET /api/v1/catalog/config | P:catalog.records.read | - | - | read | deny | none | null | - | -',
  // ---- Komunitas K1 (settings) ----
  'settings.accreditation.put':
    'PUT /api/v1/settings/accreditation | P:system.settings.manage | - | - | write | deny | store | settings.update | handler | -',
  'system.config.get': 'GET /api/v1/system/config | P:system.config.manage | - | - | read | deny | none | null | - | -',
  'system.config.put': 'PUT /api/v1/system/config | P:system.config.manage | - | reauth | write | deny | none | system.config.update | self | -',
  'system.config.email_test':
    'POST /api/v1/system/config/email-test | P:system.config.manage | - | reauth | system | deny | none | system.config.email_test | self | -',
  'system.cron_token.rotate':
    'POST /api/v1/system/cron-token/rotate | P:system.config.manage | - | reauth | write | deny | none | system.config.cron_token_rotate | self | -',
  // ---- 1b: audit ----
  'audit.list': 'GET /api/v1/audit | P:system.audit.read | - | - | read | deny | none | null | - | -',
  'audit.verify': 'GET /api/v1/audit/verify | P:system.audit.read | - | - | read | deny | none | null | - | -',
  'audit.export': 'GET /api/v1/audit/export | P:system.audit.export | - | reauth | system | deny | none | audit.export | - | -',
  // ---- 1c: the cron call ----
  'cron.run': 'POST /_cron | pub | - | - | system | restore-allow | none | null | self | bearer',
  // ---- 1c: jobs and schedules ----
  'jobs.list': 'GET /api/v1/jobs | P:system.jobs.read | - | - | read | deny | none | null | - | -',
  'jobs.get': 'GET /api/v1/jobs/:id | pub+s | - | - | read | deny | none | null | - | -',
  'jobs.retry': 'POST /api/v1/jobs/:id/retry | P:system.jobs.manage | - | - | write | deny | store | jobs.retry | handler | -',
  'jobs.cancel': 'POST /api/v1/jobs/:id/cancel | P:system.jobs.manage | - | - | write | deny | store | jobs.cancel | handler | -',
  'jobs.drive': 'POST /api/v1/jobs/:id/drive | pub+s | - | - | system | deny | none | null | self | -',
  'schedules.list': 'GET /api/v1/schedules | P:system.jobs.read | - | - | read | deny | none | null | - | -',
  'schedules.update': 'PATCH /api/v1/schedules/:name | P:system.jobs.manage | - | - | write | deny | store | schedules.update | handler | -',
  // ---- 1c: ops ----
  'ops.current': 'GET /api/v1/ops/current | ops | - | - | system | restore-allow | none | null | - | -',
  'ops.drive': 'POST /api/v1/ops/drive | ops | - | - | system | restore-allow | none | null | self | -',
  'ops.cancel': 'POST /api/v1/ops/cancel | ops | - | reauth | system | restore-allow | none | ops.cancel | self | -',
  'ops.takeover': 'POST /api/v1/ops/takeover | ops | - | reauth | system | restore-allow | none | ops.takeover | self | -',
  'ops.report': 'GET /api/v1/ops/report | ops | - | - | system | restore-allow | none | null | - | -',
  'ops.update_page': 'GET /admin/_update | ops | - | - | system | restore-allow | none | null | - | -',
  // ---- 1c: events and notifications ----
  'events.poll': 'GET /api/v1/events | pub+s | - | - | system | allow | none | null | - | background',
  'events.stream': 'GET /api/v1/events/stream | pub+s | - | - | system | allow | none | null | - | background',
  'notifications.list': 'GET /api/v1/notifications | pub+s | - | - | system | deny | none | null | - | -',
  'notifications.read': 'POST /api/v1/notifications/:id/read | pub+s | - | - | system | deny | none | null | handler | -',
  'notifications.read_all': 'POST /api/v1/notifications/read-all | pub+s | - | - | system | deny | none | null | handler | -',
  // ---- 1c: the system dashboard ----
  'dashboard.get': 'GET /api/v1/dashboard | pub+s | - | - | read | deny | none | null | - | -',
  // ---- 1c: uploads and stored files ----
  'files.uploads.create': 'POST /api/v1/files/uploads | pub+s | - | - | system | deny | store | null | handler | -',
  'files.uploads.chunk': 'POST /api/v1/files/uploads/:id/chunks/:n | pub+s | - | - | system | deny | none | null | self | rawBody',
  'files.uploads.complete': 'POST /api/v1/files/uploads/:id/complete | pub+s | - | - | system | deny | none | null | self | -',
  'files.uploads.delete': 'DELETE /api/v1/files/uploads/:id | pub+s | - | - | system | deny | none | null | self | -',
  // Phase 2 (L10): `allow`, as every OPAC route whose covers, images and media it serves (spec §12.3).
  'files.get': 'GET /files/:id | pub | - | - | read | allow | none | null | - | -',
  // ---- 1c: backups (`backups.restore` audits nothing itself: the op writes `backup.restore` when it ends, C25) ----
  'backups.list': 'GET /api/v1/backups | P:system.backup.read | - | - | read | deny | none | null | - | -',
  'backups.create': 'POST /api/v1/backups | P:system.backup.create | - | - | system | deny | none | backup.create | self | -',
  'backups.prepare_download':
    'POST /api/v1/backups/:id/prepare-download | P:system.backup.download | - | reauth | system | deny | none | backup.download | handler | -',
  'backups.download': 'GET /api/v1/backups/:id/download | P:system.backup.download | - | - | system | deny | none | null | - | sideEffects',
  'backups.upload': 'POST /api/v1/backups/upload | P:system.backup.restore | - | reauth | system | deny | none | backup.upload | self | -',
  'backups.restore': 'POST /api/v1/backups/:id/restore | P:system.backup.restore | - | reauth | system | deny | none | null | self | -',
  // ---- 1c: Diagnostik (the probe write routes are `tx: 'self'`, as the catalog has them since the Task 30 fix) ----
  'diagnostics.get': 'GET /api/v1/diagnostics | P:system.diagnostics.read | - | - | system | deny | none | null | - | -',
  'diagnostics.realtime':
    'PUT /api/v1/diagnostics/realtime | P:system.diagnostics.manage | - | - | system | deny | none | diagnostics.realtime | handler | -',
  'diagnostics.clock_confirm':
    'POST /api/v1/diagnostics/clock-confirm | P:system.diagnostics.manage | - | reauth | system | deny | none | diagnostics.clock_confirm | self | -',
  'diagnostics.probe_result':
    'POST /api/v1/diagnostics/probe-result | P:system.diagnostics.manage | - | - | system | deny | none | diagnostics.probe_result | handler | -',
  'diagnostics.probe.poll': 'GET /api/v1/diagnostics/probe/poll | P:system.diagnostics.read | - | - | system | deny | none | null | - | -',
  'diagnostics.probe.sse': 'GET /api/v1/diagnostics/probe/sse | P:system.diagnostics.read | - | - | system | deny | none | null | - | -',
  'diagnostics.probe.hmac': 'GET /api/v1/diagnostics/probe/hmac/:nonce | P:system.diagnostics.read | - | - | system | deny | none | null | - | -',
  'diagnostics.probe.methods.post':
    'POST /api/v1/diagnostics/probe/methods | P:system.diagnostics.read | - | - | system | deny | none | null | self | -',
  'diagnostics.probe.methods.put': 'PUT /api/v1/diagnostics/probe/methods | P:system.diagnostics.read | - | - | system | deny | none | null | self | -',
  'diagnostics.probe.methods.patch':
    'PATCH /api/v1/diagnostics/probe/methods | P:system.diagnostics.read | - | - | system | deny | none | null | self | -',
  'diagnostics.probe.methods.delete':
    'DELETE /api/v1/diagnostics/probe/methods | P:system.diagnostics.read | - | - | system | deny | none | null | self | -',
  'diagnostics.probe.chunk': 'POST /api/v1/diagnostics/probe/chunk | P:system.diagnostics.read | - | - | system | deny | none | null | self | rawBody',
  // ---- 1d: updates (Task 28; the 1d route catalog: the ops write `update.apply` and `update.rollback` themselves) ----
  'updates.get': 'GET /api/v1/updates | P:system.update.read | - | - | system | deny | none | null | - | -',
  'updates.check': 'POST /api/v1/updates/check | P:system.update.read | - | - | system | deny | none | null | self | -',
  'updates.apply': 'POST /api/v1/updates/apply | P:system.update.run | - | reauth | system | deny | none | null | self | -',
  'updates.status': 'GET /api/v1/updates/status | ops | - | - | system | restore-allow | none | null | - | -',
  'updates.upload': 'POST /api/v1/updates/upload | P:system.update.run | - | reauth | system | deny | none | update.upload | self | -',
  'updates.rollback': 'POST /api/v1/updates/rollback | P:system.update.run | - | reauth | system | deny | none | null | self | -',
  'updates.channel': 'PUT /api/v1/updates/channel | P:system.update.run | - | - | system | deny | store | update.channel | handler | -',
  'updates.history': 'GET /api/v1/updates/history | P:system.update.read | - | - | system | deny | none | null | - | -',
  // ---- 1c: the install wizard (`install.admin` audits `users.create` through createFirstSuperAdmin) ----
  'install.page': 'GET /install | inst0:page | - | - | system | allow | none | null | - | -',
  'install.claim': 'POST /install/api/claim | inst0:claim | - | - | system | allow | none | null | self | -',
  'install.checks': 'GET /install/api/checks | inst | - | - | system | allow | none | null | - | -',
  'install.exposure': 'POST /install/api/exposure | inst | - | - | system | allow | none | null | self | -',
  'install.probe.poll': 'GET /install/api/probe/poll | inst | - | - | system | allow | none | null | - | -',
  'install.probe.sse': 'GET /install/api/probe/sse | inst | - | - | system | allow | none | null | - | -',
  'install.probe.hmac': 'GET /install/api/probe/:nonce{[A-Za-z0-9_-]{16,64}} | inst | - | - | system | allow | none | null | - | -',
  'install.probe.methods.post': 'POST /install/api/probe/methods | inst | - | - | system | allow | none | null | self | -',
  'install.probe.methods.put': 'PUT /install/api/probe/methods | inst | - | - | system | allow | none | null | self | -',
  'install.probe.methods.patch': 'PATCH /install/api/probe/methods | inst | - | - | system | allow | none | null | self | -',
  'install.probe.methods.delete': 'DELETE /install/api/probe/methods | inst | - | - | system | allow | none | null | self | -',
  'install.probe.chunk': 'POST /install/api/probe/chunk | inst | - | - | system | allow | none | null | self | rawBody',
  'install.db_test': 'POST /install/api/db/test | inst | - | - | system | allow | none | null | self | -',
  'install.config': 'POST /install/api/config | inst | - | - | system | allow | none | null | self | -',
  'install.migrate': 'POST /install/api/migrate | inst | - | - | system | allow | none | null | self | -',
  'install.progress': 'GET /install/api/progress | inst | - | - | system | allow | none | null | - | -',
  'install.profile': 'POST /install/api/profile | inst | - | - | system | allow | none | null | self | -',
  'install.admin': 'POST /install/api/admin | inst | - | - | system | allow | none | null | self | also:users.create',
  'install.cron_test': 'POST /install/api/cron/test | inst | - | - | system | allow | none | null | self | -',
  'install.finish': 'POST /install/api/finish | inst | - | - | system | allow | none | install.complete | self | -',
  // ---- 1b: pages (ruling R1c-9: the admin shell is `allow`, for a normal maintenance) ----
  'admin.assets': 'GET /admin/assets/:file | pub- | - | - | read | allow | none | null | - | -',
  'admin.root': 'GET /admin | pub- | - | - | read | allow | none | null | - | -',
  'admin.index': 'GET /admin/* | pub- | - | - | read | allow | none | null | - | -',
  'legal.notices': 'GET /legal/third-party-notices.txt | pub- | - | - | read | deny | none | null | - | -',
  'opac.assets': 'GET /assets/:file | pub- | - | - | read | allow | none | null | - | -',
  'opac.home': 'GET / | pub- | - | - | read | allow | none | null | - | -',
  // ---- test profile only (1b S14, 1c Task 13) ----
  'test.branch.user_roles':
    'PUT /api/v1/_test/branches/:branchId/user-roles | P:test.branch.manage@branchId | - | reauth | system | deny | store | users.roles.update | handler | -',
  'test.jobs.enqueue': 'POST /api/v1/_test/jobs | P:system.jobs.manage | - | - | system | deny | none | null | handler | -',
  // ---- Phase 2 (catalog): Task 3 ----
  // The catalog routes' rows, one file per area (matrix/catalog-<area>.ts); matrix-fixtures.ts spreads their fixtures
  // at the same place, so the order of the two maps stays the same.
  ...CATALOG_MATRIX.rows,
  // ---- Komunitas K1 (reports and accreditation) ----
  // The community rows, one file per area (matrix/komunitas-<area>.ts), merged in matrix/komunitas.ts.
  ...KOMUNITAS_MATRIX.rows,
};

/** `d` as a row of {@link CATALOG}. */
function catalogRow(d: RouteDecl): string {
  let access: string;
  if (d.permission !== undefined) access = `P:${d.permission}${d.branchParam === undefined ? '' : `@${d.branchParam}`}`;
  else if (d.opsAuth === true) access = 'ops';
  else if (d.install !== undefined) access = d.install === 'claimed' ? 'inst' : `inst0:${d.install}`;
  else access = { none: 'pub-', required: 'pub+s', optional: 'pub' }[d.session ?? 'optional'];
  const extras = [
    d.auth === 'bearer' ? 'bearer' : null,
    d.background === true ? 'background' : null,
    d.sideEffects === true ? 'sideEffects' : null,
    d.rawBody === undefined ? null : 'rawBody',
    d.alsoAudits === undefined ? null : `also:${d.alsoAudits.join(',')}`,
    d.ipLimits === undefined ? null : `ip:${d.ipLimits.join(',')}`,
  ].filter((x): x is string => x !== null);
  return [
    `${d.method} ${d.path}`,
    access,
    d.partialAuth === true ? 'pA' : '-',
    d.reauth === true ? 'reauth' : '-',
    d.mode ?? (d.method === 'GET' ? 'read' : 'write'),
    d.maintenance ?? 'deny',
    d.idempotency,
    d.audit ?? 'null',
    d.method === 'GET' ? '-' : (d.tx ?? 'handler'),
    extras.length === 0 ? '-' : extras.join(' '),
  ].join(' | ');
}

/** The routes 1c added (the 1c catalog's ids, the 1c test-profile route included). */
const PHASE_1C = /^(?:cron|jobs|schedules|ops|events|notifications|dashboard|files|backups|diagnostics|install|test\.jobs)\./;
/** The routes 1d added (the 1d route catalog: the updates group). */
const PHASE_1D = /^updates\./;

/** Mail goes nowhere: no route of this file needs to see it. */
const silentMailer: Mailer = { send: async () => {} };

describe.skipIf(!ctx.available)(`permission matrix, escalation, audit once [${engineLabel()}]`, () => {
  let root: string;
  let dataDir: string;
  let app: ReturnType<typeof createApp>;
  const users = new Map<Persona, PersonaUser | null>();
  let snapshot: UserSnapshot;
  let peerSerial = 0;

  /** A peer address of its own for each call (198.18.0.0/15, neither loopback nor private). */
  const nextPeer = (): string => {
    peerSerial += 1;
    return `198.18.${(peerSerial >> 8) & 255}.${peerSerial & 255}`;
  };
  const seed = (): SeedContext => ({ h, now: NOW, keyring: CONFIG.keyring, dataDir });
  const lastSeq = async (): Promise<number> =>
    Number((await h.db.selectFrom('audit_head').select('last_seq').where('id', '=', 1).executeTakeFirstOrThrow()).last_seq);
  /** Whether DATA_DIR/ops/op.json exists (an op was begun and not removed). */
  const opFileExists = (): Promise<boolean> =>
    fsp.stat(path.join(dataDir, 'ops', 'op.json')).then(
      () => true,
      () => false,
    );

  /** The staff user of a new persona `p`. */
  async function personaUser(p: Exclude<Persona, 'anonymous' | 'ops_cookie'>): Promise<PersonaUser> {
    const user = await seedPersona(seed(), p);
    if (user === null) throw new Error(`no user for ${p}`);
    return user;
  }

  /** `call` to the route `id` as `user`, in a new full session re-authenticated at NOW. */
  async function callAs(user: PersonaUser, id: string, call: MatrixCall): Promise<AgentReply> {
    const token = await personaSession(h, user, { now: NOW });
    return sendCall(app, CONFIG, routeOf(id), call, { token, peer: nextPeer() });
  }

  /** `call` to the route `id` holding only `ops`, the `altis_ops` cookie of the current op. */
  function callWithOpsCookie(ops: OpsCookie, id: string, call: MatrixCall = {}): Promise<AgentReply> {
    return sendCall(app, CONFIG, routeOf(id), call, { token: null, peer: nextPeer(), ops });
  }

  beforeAll(async () => {
    h = await testDb();
    root = await fsp.mkdtemp(path.join(os.tmpdir(), 'altis-matrix-'));
    await runMigrations(h, { appVersion: '0.1.0', dataDir: path.join(root, 'migrations'), migrations: PHASE1_MIGRATIONS });
    // config.json for the routes that write it (PUT system/config, the cron-token rotation) and `/_cron`'s token.
    dataDir = path.join(root, 'data');
    await writeConfig(dataDir, CONFIG);
    // 1d Task 28: no feed (the check's job never runs here), and the dev root as the package keys, so that an uploaded
    // package signed with the dev key verifies (this build embeds no root keys).
    const source = createUpdateSource({
      feedBase: () => null,
      dataDir,
      roots: [],
      sources: async () => [],
      refuseDevKids: false,
      allowLoopbackHttp: false,
      clock: () => NOW,
      log: { info() {}, warn() {}, error() {} },
      persistKeysets: async () => {},
      onSignedTime: async () => {},
      env: {},
    });
    app = createApp({
      state: { phase: 'ready', db: h, config: CONFIG },
      version: '0.1.0',
      buildId: 'matrix',
      log: recordingLogger(),
      clock: () => NOW,
      env: {},
      dataDir,
      services: { mailer: silentMailer, emailTestMailer: silentMailer, updates: { source, packageKeys: devPackageKeys } },
    });
    for (const p of allPersonas()) users.set(p, await seedPersona(seed(), p));
    snapshot = await snapshotUsers(
      h,
      [...users.values()].flatMap((u) => (u === null ? [] : [u.id])),
    );
  }, 120_000);

  afterAll(async () => {
    await h?.close();
    if (root !== undefined) await fsp.rm(root, { recursive: true, force: true });
  });

  it('coverage: one fixture per route of ALL_ROUTES (100%), the 1c and test-profile routes included, in catalog order', () => {
    expect(Object.keys(MATRIX_FIXTURES).sort()).toEqual(ALL_ROUTES.map((d) => d.id).sort());
    expect(Object.keys(MATRIX_FIXTURES)).toEqual(Object.keys(CATALOG));
    for (const id of ['test.branch.user_roles', 'test.jobs.enqueue', 'cron.run', 'ops.update_page', 'install.finish']) {
      expect(ROUTES_BY_ID.has(id), id).toBe(true);
    }
    expect(allPersonas()).toContain('ops_cookie');
  });

  it('every declaration is the one of the route catalog', () => {
    expect(Object.fromEntries(ALL_ROUTES.map((d) => [d.id, catalogRow(d)]))).toEqual(CATALOG);
  });

  it('the system routes: the ids declared `mode: system` are EXPECTED_SYSTEM_ROUTES, no more and no less (1D-13)', () => {
    const declared = ALL_ROUTES.filter((d) => routeMode(d) === 'system').map((d) => d.id);
    expect([...declared].sort()).toEqual([...EXPECTED_SYSTEM_ROUTES].sort());
    expect(new Set(EXPECTED_SYSTEM_ROUTES).size).toBe(EXPECTED_SYSTEM_ROUTES.length);
    // The exceptions are only what the list says they are: an `install.*` id is a wizard route (the install gate answers
    // 404 once installed, before any later step), and a `test.*` id is a test-profile route (none in a production build).
    const testProfile = new Set(testOnlyRoutes().map((d) => d.id));
    expect(EXPECTED_SYSTEM_ROUTES.filter((id) => id.startsWith('install.') && routeOf(id).install === undefined)).toEqual([]);
    expect(EXPECTED_SYSTEM_ROUTES.filter((id) => id.startsWith('test.') && !testProfile.has(id))).toEqual([]);
    // D1d-41: the security routes outside §8.6's list stay `write`.
    for (const id of ['users.password.reset', 'users.2fa.reset', 'system.cron_token.rotate', 'system.config.put']) {
      expect(routeMode(routeOf(id)), id).toBe('write');
    }
    // D36/M32: disabling a user and revoking roles are `system`; enabling one and creating one are not.
    expect(['users.disable', 'users.roles.put', 'users.enable', 'users.create'].map((id) => routeMode(routeOf(id)))).toEqual([
      'system',
      'system',
      'write',
      'write',
    ]);
    // The mode rule: as declared, else GET `read` and any other method `write`.
    expect(['branches.list', 'branches.create', 'auth.me', 'catalog.exports.create'].map((id) => routeMode(routeOf(id)))).toEqual([
      'read',
      'write',
      'system',
      'system',
    ]);
  });

  it('without a current op, the ops routes open to the permissions of the op kinds (§9.4), as expected() reads them', () => {
    expect(OPS_KIND_PERMISSIONS).toEqual(['system.update.run', 'system.backup.restore', 'system.backup.create']);
    expect(OPS_ANY_PERMISSIONS).toEqual(OPS_KIND_PERMISSIONS);
  });

  describe('route × persona: the gate outcome of every call is expected()', () => {
    for (const decl of ALL_ROUTES) {
      it(`${decl.id} (${decl.method} ${decl.path})`, async () => {
        const fixture = MATRIX_FIXTURES[decl.id];
        if (fixture === undefined) throw new Error(`MATRIX_FIXTURES has no fixture for ${decl.id}`);
        await restoreUsers(h, snapshot);
        const wrong: { persona: Persona; want: string; got: string; status: number; code: string | undefined }[] = [];
        for (const persona of allPersonas()) {
          const user = users.get(persona) ?? null;
          const token = user === null ? null : await personaSession(h, user, { now: NOW, partial: isPartial(persona) });
          const call = await fixture({ ...seed(), persona, user });
          // `ops_cookie`: the cookie of an op made current for this call only (it replaces any op the fixture made).
          const ops = persona === 'ops_cookie' ? await opsCookieOp(dataDir, NOW) : null;
          let res: AgentReply;
          try {
            res = await sendCall(app, CONFIG, decl, call, { token, peer: nextPeer(), ops });
          } finally {
            if (ops !== null) await removeOp(dataDir);
          }
          const want = expected(decl, persona, call.op);
          const got = outcomeOf(res.headers.get('x-altis-test-gate'));
          const code = codeOf(res);
          // Every persona sends a valid CSRF token and the baseUrl's Origin: a refusal at step 8 is a broken call.
          if (got !== want || code === 'CSRF_INVALID' || code === 'ORIGIN_DENIED') {
            wrong.push({ persona, want, got, status: res.status, code });
          }
        }
        await removeOp(dataDir); // an op an ops fixture made does not outlive its route
        expect(wrong).toEqual([]);
      }, 120_000);
    }
  });

  it('a persona denied on system.* routes leaves at most one authz.denied entry per minute', async () => {
    const rows = await h.db.selectFrom('audit_log').select(['actor_id', 'at']).where('action', '=', 'authz.denied').execute();
    const perMinute = new Map<string, number>();
    for (const r of rows) {
      const key = `${r.actor_id ?? ''}@${Math.floor(Number(r.at) / 60_000)}`;
      perMinute.set(key, (perMinute.get(key) ?? 0) + 1);
    }
    expect([...perMinute.values()].filter((n) => n > 1)).toEqual([]);
    // Each of them was denied many times within NOW's minute: the first denial wrote the one entry.
    const denied = allPersonas().filter((p) =>
      ALL_ROUTES.some((d) => d.permission?.startsWith('system.') === true && expected(d, p) === 'denied'),
    );
    expect(denied.length).toBeGreaterThan(20);
    expect(new Set(rows.map((r) => r.actor_id))).toEqual(new Set(denied.map((p) => users.get(p)?.id)));
  });

  describe('audit once: a fresh super admin call appends exactly one entry of the route action', () => {
    // The wizard's `install.finish` is gone in this installed app; audit-coverage.test.ts checks its one
    // `install.complete` entry in a wizard run of its own.
    for (const decl of ALL_ROUTES.filter((d) => d.audit !== null && d.install === undefined)) {
      // A community route whose handler is not written yet (matrix/komunitas.ts KOMUNITAS_PENDING_ROUTES).
      if (KOMUNITAS_PENDING_ROUTES.includes(decl.id)) {
        it.todo(`${decl.id} → one ${decl.audit} (its handler is not written yet)`);
        continue;
      }
      it(`${decl.id} → one ${decl.audit}`, async () => {
        const fixture = MATRIX_FIXTURES[decl.id];
        if (fixture === undefined) throw new Error(`MATRIX_FIXTURES has no fixture for ${decl.id}`);
        const user = await personaUser('super_admin');
        const token = await personaSession(h, user, { now: NOW });
        const call = await fixture({ ...seed(), persona: 'super_admin', user });
        const before = await lastSeq();
        let res: AgentReply;
        try {
          res = await sendCall(app, CONFIG, decl, call, { token, peer: nextPeer() });
        } finally {
          await removeOp(dataDir); // the op an ops fixture made (a takeover leaves it current) ends with its test
        }
        expect(res.status, res.text).toBeLessThan(300);
        const rows = await h.db.selectFrom('audit_log').select('action').where('seq', '>', before).orderBy('seq').execute();
        const added = rows.map((r) => r.action);
        expect(added.filter((a) => a === decl.audit)).toHaveLength(1);
        expect(added.filter((a) => a !== decl.audit && !SECURITY_AUDIT_ACTIONS.has(a as AuditAction))).toEqual([]);
      });
    }
  });

  describe('A4: each escalation → 403', () => {
    let sa: PersonaUser;
    let ad: PersonaUser;
    const roleIdOf = async (key: 'super_admin' | 'admin'): Promise<string> =>
      (await h.db.selectFrom('roles').select('id').where('key', '=', key).executeTakeFirstOrThrow()).id;

    beforeAll(async () => {
      sa = await personaUser('super_admin');
      ad = await personaUser('admin');
    });

    it('admin POST roles with system.update.run → 403 AUTHZ_ESCALATION, no role created', async () => {
      const res = await callAs(ad, 'roles.create', { body: { name: 'Pembaru Sistem', permissions: ['system.update.run'] } });
      expect(res.status).toBe(403);
      expect(codeOf(res)).toBe('AUTHZ_ESCALATION');
      expect(await h.db.selectFrom('roles').select('id').where('name', '=', 'Pembaru Sistem').execute()).toEqual([]);
    });

    it('admin POST users/<super admin>/reset-password and …/reset-2fa → 403 AUTHZ_ESCALATION, the account unchanged', async () => {
      const superAdmin = await seedUser(seed(), { totp: true, roles: [{ roleId: await roleIdOf('super_admin'), branchId: null }] });
      const account = () => h.db.selectFrom('staff_users').selectAll().where('id', '=', superAdmin.id).executeTakeFirstOrThrow();
      const before = await account();
      for (const id of ['users.password.reset', 'users.2fa.reset']) {
        const res = await callAs(ad, id, { params: { id: superAdmin.id } });
        expect(res.status, id).toBe(403);
        expect(codeOf(res), id).toBe('AUTHZ_ESCALATION');
      }
      expect(await account()).toEqual(before);
    });

    it('admin PATCH roles/<super_admin> {version: <current>, mfaRequired: false} → 403 AUTHZ_ESCALATION (S13)', async () => {
      const id = await roleIdOf('super_admin');
      await h.db.updateTable('roles').set({ mfa_required: 1 }).where('id', '=', id).execute();
      try {
        const { version } = await h.db.selectFrom('roles').select('version').where('id', '=', id).executeTakeFirstOrThrow();
        const call = { params: { id }, body: { version: Number(version), mfaRequired: false } };
        const res = await callAs(ad, 'roles.update', call);
        expect(res.status).toBe(403);
        expect(codeOf(res)).toBe('AUTHZ_ESCALATION');
        const after = await h.db.selectFrom('roles').select(['mfa_required', 'version']).where('id', '=', id).executeTakeFirstOrThrow();
        expect([Number(after.mfa_required), Number(after.version)]).toEqual([1, Number(version)]);
        // The control: the super admin may (the body passed Zod with the current version).
        const ok = await callAs(sa, 'roles.update', call);
        expect(ok.status, ok.text).toBe(200);
      } finally {
        await h.db.updateTable('roles').set({ mfa_required: 0 }).where('id', '=', id).execute();
      }
    });

    it("admin PUT system/config {smtp: {host: 'x'}} → 403, the SMTP host unchanged", async () => {
      const res = await callAs(ad, 'system.config.put', { body: { smtp: { host: 'x' } } });
      expect(res.status).toBe(403);
      expect(codeOf(res)).toBe('AUTHZ_DENIED');
      expect(await h.db.selectFrom('settings').select('key').where('key', '=', 'smtp.host').execute()).toEqual([]);
    });

    it('a branch admin (test.branch.manage at B) giving a global role at _test/branches/B → 403 AUTHZ_ESCALATION (S14)', async () => {
      const branch = await seedBranch(seed());
      const branchRole = await seedRole(seed(), { permissions: ['test.branch.manage'] });
      const branchAdmin = await seedUser(seed(), { roles: [{ roleId: branchRole.id, branchId: branch.id }] });
      const target = await seedUser(seed());
      const reader = await seedRole(seed(), { permissions: ['system.users.read'] });
      const res = await callAs(branchAdmin, 'test.branch.user_roles', {
        params: { branchId: branch.id },
        body: { userId: target.id, assignments: [{ roleId: reader.id, branchId: null }] },
      });
      expect(res.status).toBe(403);
      expect(codeOf(res)).toBe('AUTHZ_ESCALATION');
      expect(await h.db.selectFrom('user_roles').select('id').where('user_id', '=', target.id).execute()).toEqual([]);
      // The control: a branch role at B is theirs to give.
      const ok = await callAs(branchAdmin, 'test.branch.user_roles', {
        params: { branchId: branch.id },
        body: { userId: target.id, assignments: [{ roleId: branchRole.id, branchId: branch.id }] },
      });
      expect(ok.status, ok.text).toBe(200);
    });

    it("spec §7.2 rule 5: an admin neither gives nor takes the 'admin' role (403 AUTHZ_ESCALATION); a super admin does both", async () => {
      const adminRole = await roleIdOf('admin');
      const plain = await seedUser(seed());
      const otherAdmin = await seedUser(seed(), { roles: [{ roleId: adminRole, branchId: null }] });
      const give = { params: { id: plain.id }, body: { assignments: [{ roleId: adminRole, branchId: null }] } };
      const take = { params: { id: otherAdmin.id }, body: { assignments: [] } };
      for (const [what, call] of [['give', give], ['take', take]] as const) {
        const res = await callAs(ad, 'users.roles.put', call);
        expect(res.status, what).toBe(403);
        expect(codeOf(res), what).toBe('AUTHZ_ESCALATION');
      }
      const rolesOf = async (id: string): Promise<string[]> =>
        (await h.db.selectFrom('user_roles').select('role_id').where('user_id', '=', id).execute()).map((r) => r.role_id);
      expect(await rolesOf(plain.id)).toEqual([]);
      expect(await rolesOf(otherAdmin.id)).toEqual([adminRole]);
      for (const [what, call] of [['give', give], ['take', take]] as const) {
        const res = await callAs(sa, 'users.roles.put', call);
        expect(res.status, `${what}: ${res.text}`).toBe(200);
      }
      expect(await rolesOf(plain.id)).toEqual([adminRole]);
      expect(await rolesOf(otherAdmin.id)).toEqual([]);
    });

    it('admin POST backups/<id>/restore → 403 AUTHZ_DENIED (system.backup.restore is not an admin permission), nothing begun', async () => {
      const id = await seedOkBackup(seed());
      const res = await callAs(ad, 'backups.restore', { params: { id }, body: {} });
      expect([res.status, codeOf(res)]).toEqual([403, 'AUTHZ_DENIED']);
      await expect(fsp.stat(path.join(dataDir, 'ops', 'op.json'))).rejects.toMatchObject({ code: 'ENOENT' });
      // The control: a super admin passes the gate (an unknown backup, so no op is begun: 404 after it).
      const control = await callAs(sa, 'backups.restore', { params: { id: newId() }, body: {} });
      expect([control.status, codeOf(control)]).toEqual([404, 'NOT_FOUND']);
    });

    it('admin PUT diagnostics/realtime → 200 (system.diagnostics.manage is an admin permission)', async () => {
      const res = await callAs(ad, 'diagnostics.realtime', { body: { sse: null } });
      expect(res.status, res.text).toBe(200);
    });

    it('D1d-11: admin is denied the update-run routes and allowed their read routes; updates.status follows opsAuth', () => {
      // §7.2: system.update.run is not an admin permission; system.update.read is.
      const adminHolds = (p: Permission): boolean => holds('admin', p);
      expect((['system.update.run', 'system.update.read'] as const).map((p) => adminHolds(p))).toEqual([false, true]);
      const denied = ['updates.apply', 'updates.upload', 'updates.rollback', 'updates.channel'];
      const allowed = ['updates.get', 'updates.check', 'updates.history'];
      expect(denied.map((id) => [id, routeOf(id).permission, expected(routeOf(id), 'admin')])).toEqual(
        denied.map((id) => [id, 'system.update.run', 'denied']),
      );
      expect(allowed.map((id) => [id, routeOf(id).permission, expected(routeOf(id), 'admin')])).toEqual(
        allowed.map((id) => [id, 'system.update.read', 'allowed']),
      );
      // The super admin holds them all.
      for (const id of [...denied, ...allowed]) expect(expected(routeOf(id), 'super_admin'), id).toBe('allowed');
      // updates.status is an ops route (§9.2 step 6): the op's cookie, or a session holding the op kind's permission.
      const status = routeOf('updates.status');
      expect([status.opsAuth, status.permission, status.reauth ?? false]).toEqual([true, undefined, false]);
      expect(expected(status, 'ops_cookie')).toBe('allowed');
      expect(expected(status, 'admin', 'system.update.run')).toBe('denied');
      expect(expected(status, 'admin', 'system.backup.create')).toBe('allowed');
      expect(expected(status, 'perm:system.update.run', 'system.update.run')).toBe('allowed');
      expect(expected(status, 'anonymous')).toBe('unauthenticated');
    });

    it("authorizeChannels without system.update.read for ['system.update'] → AUTHZ_DENIED (function level, M19)", async () => {
      const actorOf = async (p: Exclude<Persona, 'anonymous' | 'ops_cookie'>) => {
        const user = await personaUser(p);
        return { id: user.id, grants: await loadGrants(h.db, user.id) };
      };
      const jobCreator = async (): Promise<string | null> => null;
      const refused = await authorizeChannels(await actorOf('perm:system.users.read'), ['system.update'], { jobCreator }).then(
        () => null,
        (error: unknown) => error,
      );
      expect(isDomainError(refused) && refused.code).toBe('AUTHZ_DENIED');
      // The control: with system.update.read the same subscription passes.
      const updater = await actorOf('perm:system.update.read');
      await expect(authorizeChannels(updater, ['system.update'], { jobCreator })).resolves.toBeUndefined();
    });

    it('staff without system.backup.read: GET events?channels=system.backup → 403 AUTHZ_DENIED (M19 over HTTP); with it → 200', async () => {
      const staff = await personaUser('perm:system.users.read');
      const res = await callAs(staff, 'events.poll', { query: { channels: 'system.backup' } });
      expect([res.status, codeOf(res)]).toEqual([403, 'AUTHZ_DENIED']);
      // One forbidden channel refuses the whole request (§10.7), a readable one beside it included.
      const mixed = await callAs(staff, 'events.poll', { query: { channels: 'system.status,system.backup' } });
      expect([mixed.status, codeOf(mixed)]).toEqual([403, 'AUTHZ_DENIED']);
      const reader = await personaUser('perm:system.backup.read');
      const ok = await callAs(reader, 'events.poll', { query: { channels: 'system.backup' } });
      expect(ok.status, ok.text).toBe(200);
    });

    // ---- Komunitas K1 (personas) ----
    it('the reports and accreditation permissions each have a persona, holding that permission only; admin holds all three', () => {
      for (const key of ['reports.statistics.read', 'accreditation.workspace.read', 'accreditation.workspace.manage'] as const) {
        expect(allPersonas(), key).toContain(`perm:${key}`);
        expect(holds(`perm:${key}`, key), key).toBe(true);
        expect(holds(`perm:${key}`, 'system.settings.manage'), key).toBe(false);
        expect(holds('admin', key), key).toBe(true);
      }
      // PUT settings/accreditation is a settings route: the accreditation managers do not hold it.
      expect(expected(routeOf('settings.accreditation.put'), 'perm:accreditation.workspace.manage')).toBe('denied');
      expect(expected(routeOf('settings.accreditation.put'), 'perm:system.settings.manage')).toBe('allowed');
    });

    it('staff without accreditation.workspace.read: GET events?channels=accreditation → 403 AUTHZ_DENIED; with it → 200', async () => {
      const manager = await personaUser('perm:accreditation.workspace.manage');
      const res = await callAs(manager, 'events.poll', { query: { channels: 'accreditation' } });
      expect([res.status, codeOf(res)]).toEqual([403, 'AUTHZ_DENIED']);
      const reporter = await personaUser('perm:reports.statistics.read');
      const other = await callAs(reporter, 'events.poll', { query: { channels: 'accreditation' } });
      expect([other.status, codeOf(other)]).toEqual([403, 'AUTHZ_DENIED']);
      const reader = await personaUser('perm:accreditation.workspace.read');
      const ok = await callAs(reader, 'events.poll', { query: { channels: 'accreditation' } });
      expect(ok.status, ok.text).toBe(200);
    });

    it('ops_cookie: the altis_ops of the current op alone → 401 AUTH_REQUIRED on GET backups; the ops routes open to it', async () => {
      const ops = await opsCookieOp(dataDir, NOW);
      try {
        const res = await callWithOpsCookie(ops, 'backups.list');
        expect([res.status, codeOf(res)]).toEqual([401, 'AUTH_REQUIRED']);
        // The control: the same cookie opens ops/current (and the op it names is the cookie's).
        const current = await callWithOpsCookie(ops, 'ops.current');
        expect(current.status, current.text).toBe(200);
        expect(current.json).toMatchObject({ opId: ops.opId, kind: 'update' });
        // A reauth ops route never opens by the cookie alone (§9.4).
        const takeover = await callWithOpsCookie(ops, 'ops.takeover');
        expect([takeover.status, codeOf(takeover)]).toEqual([401, 'OPS_AUTH_REQUIRED']);
      } finally {
        await removeOp(dataDir);
      }
    });

    it('createApp with an extra undeclared route throws ROUTE_UNDECLARED', () => {
      const build = (extra: boolean) =>
        createApp({
          state: { phase: 'ready', db: h, config: CONFIG },
          version: '0.1.0',
          buildId: 'matrix',
          log: recordingLogger(),
          testHooks: {
            beforeRouteCheck: (a) => {
              if (extra) a.get('/api/v1/_undeclared', (c) => c.text('nobody declared me'));
            },
          },
        });
      expect(() => build(false)).not.toThrow();
      expect(() => build(true)).toThrow(/^ROUTE_UNDECLARED:GET \/api\/v1\/_undeclared$/);
    });
  });

  describe(`CSRF/Origin of the 1c routes: Origin ${EVIL_ORIGIN} → 403 ORIGIN_DENIED before the gate`, () => {
    // Every 1c route a browser's cookie authenticates that changes something: the non-GET cookie routes (the wizard's
    // are gone here; install-gate.test.ts checks the Origin and CSRF token of each wizard write against a claim) and
    // the side-effect GET `backups.download`.
    const guarded = ALL_ROUTES.filter(
      (d) =>
        PHASE_1C.test(d.id) &&
        (d.auth ?? 'cookie') === 'cookie' &&
        d.install === undefined &&
        (d.method !== 'GET' || d.sideEffects === true || d.audit !== null),
    );

    it('the routes checked: every 1c non-GET cookie route and the side-effect GET', () => {
      expect(guarded.map((d) => d.id)).toEqual([
        'jobs.retry',
        'jobs.cancel',
        'jobs.drive',
        'schedules.update',
        'ops.drive',
        'ops.cancel',
        'ops.takeover',
        'notifications.read',
        'notifications.read_all',
        'files.uploads.create',
        'files.uploads.chunk',
        'files.uploads.complete',
        'files.uploads.delete',
        'backups.create',
        'backups.prepare_download',
        'backups.download',
        'backups.upload',
        'backups.restore',
        'diagnostics.realtime',
        'diagnostics.clock_confirm',
        'diagnostics.probe_result',
        'diagnostics.probe.methods.post',
        'diagnostics.probe.methods.put',
        'diagnostics.probe.methods.patch',
        'diagnostics.probe.methods.delete',
        'diagnostics.probe.chunk',
        'test.jobs.enqueue',
      ]);
    });

    for (const decl of guarded) {
      it(`${decl.id} (${decl.method} ${decl.path}): a super admin's call from ${EVIL_ORIGIN} → 403, nothing written`, async () => {
        const user = await personaUser('super_admin');
        const token = await personaSession(h, user, { now: NOW });
        const call = await MATRIX_FIXTURES[decl.id]!({ ...seed(), persona: 'super_admin', user });
        const before = await lastSeq();
        let res: AgentReply;
        try {
          res = await sendCall(app, CONFIG, decl, { ...call, headers: { ...call.headers, origin: EVIL_ORIGIN } }, { token, peer: nextPeer() });
        } finally {
          await removeOp(dataDir); // an op an ops fixture made must not reach the routes after it
        }
        expect([res.status, codeOf(res)], res.text).toEqual([403, 'ORIGIN_DENIED']);
        expect(res.headers.get('x-altis-test-gate')).toBeNull(); // refused at step 8, before the gate
        expect(await lastSeq()).toBe(before);
      });
    }

    it(`POST /_cron with Origin ${EVIL_ORIGIN} and the right bearer token → 200 (a Bearer route has no CSRF/Origin step)`, async () => {
      // An app of its own on config.json as it is now (the cron-token rotation of the matrix changed the token), whose
      // clock is past the 30 s single-flight window of the matrix's calls at NOW.
      const config = await loadConfig(dataDir, {});
      if (config === null) throw new Error('no config.json');
      const later = createApp({
        state: { phase: 'ready', db: h, config },
        version: '0.1.0',
        buildId: 'matrix',
        log: recordingLogger(),
        clock: () => NOW + 60_000,
        env: {},
        dataDir,
        services: { mailer: silentMailer, emailTestMailer: silentMailer },
      });
      const agent = createAgent(later, { peer: nextPeer(), headers: { origin: EVIL_ORIGIN } });
      const res = await agent.post('/_cron', undefined, { authorization: `Bearer ${config.secrets.cronToken}` });
      expect(res.status, res.text).toBe(200);
      expect(res.json).toEqual({ op: null, scheduled: 0, slices: 0 });
      // The control: the same call without the token → 401 CRON_TOKEN_INVALID.
      const without = await agent.post('/_cron');
      expect([without.status, codeOf(without)]).toEqual([401, 'CRON_TOKEN_INVALID']);
    });
  });

  describe(`CSRF/Origin of the 1d routes: Origin ${EVIL_ORIGIN} → 403 ORIGIN_DENIED before the gate`, () => {
    // Every 1d route a browser's cookie authenticates that changes something: the non-GET cookie routes.
    const guarded = ALL_ROUTES.filter(
      (d) =>
        PHASE_1D.test(d.id) &&
        (d.auth ?? 'cookie') === 'cookie' &&
        d.install === undefined &&
        (d.method !== 'GET' || d.sideEffects === true || d.audit !== null),
    );

    it('the routes checked: every 1d non-GET cookie route', () => {
      expect(guarded.map((d) => d.id)).toEqual(['updates.check', 'updates.apply', 'updates.upload', 'updates.rollback', 'updates.channel']);
    });

    for (const decl of guarded) {
      it(`${decl.id} (${decl.method} ${decl.path}): a super admin's call from ${EVIL_ORIGIN} → 403, nothing written`, async () => {
        const user = await personaUser('super_admin');
        const token = await personaSession(h, user, { now: NOW });
        const call = await MATRIX_FIXTURES[decl.id]!({ ...seed(), persona: 'super_admin', user });
        await removeOp(dataDir); // no op before the call: one after it was begun by it
        const before = await lastSeq();
        const res = await sendCall(app, CONFIG, decl, { ...call, headers: { ...call.headers, origin: EVIL_ORIGIN } }, { token, peer: nextPeer() });
        expect([res.status, codeOf(res)], res.text).toEqual([403, 'ORIGIN_DENIED']);
        expect(res.headers.get('x-altis-test-gate')).toBeNull(); // refused at step 8, before the gate
        expect(await lastSeq()).toBe(before);
        expect(await opFileExists()).toBe(false); // no update or rollback op begun
      });
    }
  });
});
