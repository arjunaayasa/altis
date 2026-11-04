import { DomainError, resolveLocale } from '@altis/shared';
import type { Context } from 'hono';
import { renderMaintenance } from '../opac/pages.js';
import { cspHeader, cspNonce } from './csp.js';
import { wantsHtml } from './html-request.js';
import type { OpsFence } from './ops-fence.js';
import { MAINTENANCE_RETRY_AFTER_S, problemResponse } from './problem.js';
import type { AppEnv } from './request-id.js';
import type { RouteDecl } from './route.js';

// Step 5 of the chain (spec §4.7, §9.4; decision C20): the maintenance gate, from the maintenance flag the ops fence
// read (http/ops-fence.ts, at most 2 s old). It runs before step 3's persisted `system.ip_trust` read, which a restore
// skips (S2: its tables may be gone).
//
//   no flag                          every route passes
//   a restore (op kind `restore`)    only `maintenance: 'restore-allow'` routes (the ops routes, `/_cron`, /_health,
//                                    `auth/reauth`); past the restore's point of no return a session route among them
//                                    answers 409 OPS_POINT_OF_NO_RETURN instead (ruling R1c-9, below)
//   any other flag                   `allow` and `restore-allow` routes, and the wizard's routes while the op is
//                                    `install-migrate`
//   else                             503 MAINTENANCE, `reason` = the flag's reason, `Retry-After: 30`
//
// A browser's HTML GET gets the OPAC maintenance page instead (1c Task 19: refusalResponse below, which the route chain
// answers for step 5; maintenanceResponse is what the `ops_wait` phase gate of app.ts answers). Under /admin that page
// also links the operations page `/admin/_update`: during a restore the admin shell is closed, the ops page is not
// (during a normal maintenance the shell is `allow`, ruling R1c-9).

/** The 503 of a request maintenance refuses: `meta.reason` (the flag's, when known) and `meta.retryAfterS` 30. */
export function maintenanceError(reason: string | null | undefined): DomainError {
  return new DomainError('MAINTENANCE', {
    meta: { ...(reason === null || reason === undefined ? {} : { reason }), retryAfterS: MAINTENANCE_RETRY_AFTER_S },
  });
}

/**
 * Step 5 (see the top of this file) for `decl`, from what `fence` knows: the 503 MAINTENANCE to answer (or, ruling
 * R1c-9, the 409 OPS_POINT_OF_NO_RETURN of a session route past a restore's point of no return), or null when the route
 * passes. The route chain answers it as it is (an expected refusal, never logged as a failure).
 */
export function maintenanceRefusal(decl: RouteDecl, fence: OpsFence): DomainError | null {
  const flag = fence.maintenance();
  if (flag === null) return null;
  const allowed = decl.maintenance ?? 'deny';
  if (fence.restoreInProgress()) return allowed === 'restore-allow' ? sessionPastPonr(decl, fence) : maintenanceError('restore');
  if (allowed === 'allow' || allowed === 'restore-allow') return null;
  if (decl.install !== undefined && fence.op()?.kind === 'install-migrate') return null;
  return maintenanceError(flag.reason);
}

// ---- Ruling R1c-9: a session route during a restore ----------------------------------------------------------------

/**
 * The refusal of a `restore-allow` route that reads a session (a cookie route, not `opsAuth`: `auth/reauth`) once the
 * restore passed its point of no return: 409 OPS_POINT_OF_NO_RETURN, before step 7 reads the session, since the
 * sessions and `staff_users` may then be half loaded. Before that point every table is there and the route passes.
 * (An `opsAuth` route reads no session past that point instead, http/ops-auth.ts.)
 */
function sessionPastPonr(decl: RouteDecl, fence: OpsFence): DomainError | null {
  const readsSession = decl.opsAuth !== true && decl.session !== 'none' && (decl.auth ?? 'cookie') === 'cookie';
  if (!readsSession || !fence.restorePastPonr()) return null;
  return new DomainError('OPS_POINT_OF_NO_RETURN', {
    detail: 'Pemulihan sudah melewati titik tanpa kembali / The restore is past its point of no return',
  });
}

/**
 * Step 5 for `decl` as a check (see {@link maintenanceRefusal}).
 *
 * @throws DomainError `MAINTENANCE` (503, `reason`, `Retry-After: 30`); `OPS_POINT_OF_NO_RETURN` (409, R1c-9)
 */
export function checkMaintenance(decl: RouteDecl, fence: OpsFence): void {
  const refusal = maintenanceRefusal(decl, fence);
  if (refusal !== null) throw refusal;
}

/** Whether `c` is a browser's GET (or HEAD) of a page: what the maintenance page answers instead of problem+json. */
function pageRequest(c: Context<AppEnv>, page: boolean): boolean {
  const method = c.req.method;
  return (method === 'GET' || method === 'HEAD') && page;
}

/**
 * The OPAC maintenance page: 503, `Retry-After: 30` (the page asks the browser to look again after that long), in the
 * language of `?lang=` (no setting is read: a restore may have dropped the tables). Under /admin it links the
 * operations page.
 */
function maintenancePage(c: Context<AppEnv>): Response {
  const nonce = cspNonce();
  const locale = resolveLocale(c.req.query('lang'));
  const urlPath = c.req.path;
  const updateLink = urlPath === '/admin' || urlPath.startsWith('/admin/');
  return c.body(renderMaintenance({ locale, nonce, retryAfterS: MAINTENANCE_RETRY_AFTER_S, updateLink }), 503, {
    'Content-Type': 'text/html; charset=utf-8',
    'Cache-Control': 'no-store',
    'Content-Security-Policy': cspHeader(nonce),
    'Retry-After': String(MAINTENANCE_RETRY_AFTER_S),
  });
}

/**
 * The answer to a request the maintenance refuses outside the route chain (app.ts's `ops_wait` phase gate): the OPAC
 * maintenance page for a browser's GET of a page (`o.page`: the caller's wantsHtml), problem+json 503 MAINTENANCE
 * otherwise.
 */
export function maintenanceResponse(c: Context<AppEnv>, reason: string | null | undefined, o: { page: boolean }): Response {
  if (pageRequest(c, o.page)) return maintenancePage(c);
  return problemResponse(maintenanceError(reason), c.get('requestId'));
}

/**
 * Step 5's answer to the refusal {@link maintenanceRefusal} made (1c Task 19): the OPAC maintenance page for a browser's
 * GET of a page (http/html-request.ts wantsHtml), else the refusal as problem+json (503 MAINTENANCE, `reason`,
 * `Retry-After: 30`).
 */
export function refusalResponse(c: Context<AppEnv>, refusal: DomainError): Response {
  if (refusal.code === 'MAINTENANCE' && pageRequest(c, wantsHtml(c))) return maintenancePage(c);
  return problemResponse(refusal, c.get('requestId'));
}
