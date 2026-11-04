import {
  can,
  findSession,
  hit,
  inRotationGrace,
  loadStaffAuthView,
  lockStaffRow,
  revokeSession,
  revokeSubject,
  rotateSession,
  securityAudit,
  stageOf,
  touchSession,
  type SessionToken,
  type SessionView,
} from '@altis/core';
import { withTx, type DbHandle } from '@altis/db';
import type { OpsMachine } from '@altis/core';
import { DomainError, type ErrorCode } from '@altis/shared';
import type { Context } from 'hono';
import type { AppServices } from '../services.js';
import type { AppPhase } from '../app.js';
import type { AuthState } from './auth-state.js';
import { clearAuthCookie, readAuthCookie } from './cookies.js';
import { setSessionCookie } from './csrf.js';
import { authorizeOps, type OpsAuth } from './ops-auth.js';
import type { OpsFence } from './ops-fence.js';
import type { AppEnv } from './request-id.js';
import type { RouteDecl } from './route.js';

// Steps 7 and 9 of the middleware chain (spec §4.7, §7.1-7.3), which http/route.ts runs per route. Neither runs for
// a `session: 'none'` route (no cookie read, no database: S29), and step 7 reads no cookie for an `auth: 'bearer'`
// route (§7.4); both then see no session.
//
// Step 7, the session (resolveAuth):
//   1. the `altis_sid` cookie → findSession; no live session → none, and a cookie that named one is cleared;
//   2. the staff user (loadStaffAuthView) must be `active`: otherwise (`disabled`, `locked`, §7.1 Pencabutan) every
//      session and remember-me token of the user is revoked (revokeSubject, after the staff-row lock) and the cookie
//      cleared → none; a session whose user is gone is revoked alone;
//   3. the idle limit in force (`security.session_idle_minutes`, D26) holds for every full session, not only the
//      ones written after it changed: a full session outside its rotation grace with `now ≥ last_seen_at + idle` is
//      expired (its row deleted, as the sweep would; its remember-me token is left to restore) and the cookie
//      cleared → none;
//   4. the grants at the user's `authz_version`, through the per-process cache (`services.grants`);
//   5. the session's `authz_version` behind the user's (the rights changed; ruling R1b-1):
//      - a pre-2FA session (`mfa_passed` 0) is never rotated: its `authz_version` is updated in place (same token, same
//        PRE_MFA_MS window; it gets a new token when its second factor passes);
//      - a full session rotates only on a foreground route under /api (`rotate`), whose response the SPA reads the
//        new `X-CSRF-Token` from; elsewhere (pages, `X-Altis-Background: 1` and `background` routes, which must not
//        restart the idle window) it is kept as it is, and the next foreground /api request rotates it;
//      - the rotation runs in a transaction of its own whose first statement locks the user's staff row (as a
//        password change, a reset or a disable does before revokeSubject, so on PostgreSQL READ COMMITTED a revoke
//        cannot miss the row the rotation inserts), and the response carries the new `altis_sid` and
//        `X-CSRF-Token` (setSessionCookie). The old token stays valid for ROTATION_GRACE_MS and, while in that
//        grace, never rotates again: parallel requests and other tabs that still send it keep working (Review
//        Focus 3) instead of each minting a token of their own.
//      The grants always follow the user's current `authz_version`, whichever of these applies;
//   6. touchSession (at most once per TOUCH_INTERVAL_MS, never for `X-Altis-Background: 1` nor on a `background`
//      route, 1c Task 8: the events poll and stream), with the idle limit of `security.session_idle_minutes`.
//
// Step 8 (CSRF) checks the request's `X-CSRF-Token` against the session its cookie named (`csrfSessionId`): a write
// that arrives with the old token while its own response rotates it is still the SPA's own.
//
// Step 9, declarative authorization (authorize), deny by default, checked in this order:
//   0. 1c Task 15: an `opsAuth` route is decided by http/ops-auth.ts authorizeOps (the `altis_ops` cookie, or a
//      session holding the op kind's permission), whose answer authorize returns;
//   1. `public` with an optional session → pass;
//   2. no session → 401 AUTH_REQUIRED;
//   3. a stage other than `full` on a route that is not `partialAuth` → 401 AUTH_MFA_REQUIRED;
//   4. a pending password change, except on `partialAuth` routes and `auth.password.change` → 403
//      AUTH_PASSWORD_CHANGE_REQUIRED;
//   5. `permission` not held (at the branch of `params[branchParam]` for a branch-scoped one) → 403 AUTHZ_DENIED; a
//      denied `system.*` permission counts a hit on `authz-denied:<subject>` first, and the first hit of a minute
//      writes `authz.denied` (§7.8: a security event, in transactions of its own);
//   6. `reauth` without a re-authentication within REAUTH_MS → 401 AUTH_REAUTH_REQUIRED.
//
// Under the test profile only, a step-9 denial carries `X-Altis-Test-Gate: <code>`, which tells the permission
// matrix a gate denial from a handler's own 401/403 (B7, decision D43), and a request that passed step 9 (or skipped
// it: `session: 'none'`) carries `X-Altis-Test-Gate: PASSED`, so that a response without the header is one that never
// reached the gate (a wrong path, a 405, a 429, a 503: T31). Production builds drop both.

/** How long a re-authentication (`sessions.reauth_at`) is good for (§7.3). */
export const REAUTH_MS = 300_000;

/**
 * The idle limit of a full session (`security.session_idle_minutes`, D26), in ms, through the settings cache: step 7
 * and every route that issues a session (login, 2FA, the remember-me restore) read it here.
 */
export async function sessionIdleMs(services: AppServices, db: DbHandle['db']): Promise<number> {
  return (await services.settings.get<number>(db, 'security.session_idle_minutes')) * 60_000;
}

/** What step 7 hands to steps 8 and 9. */
export interface ResolvedAuth {
  auth: AuthState | null;
  /** The id of the live session the request's cookie named (step 8 checks `X-CSRF-Token` against it), or null. */
  csrfSessionId: string | null;
}

const NO_AUTH: ResolvedAuth = Object.freeze({ auth: null, csrfSessionId: null });

/**
 * Rotates `s` to the user's `authzVersion` in a transaction of its own, unless a parallel request did it first.
 * The user's staff row is locked first (lockStaffRow: the staff → session order of changePassword and
 * completePasswordReset, so no new deadlock), then the session row by a write before it is read (as in
 * guardSuperAdmins, so that on MySQL/MariaDB the read sees the other request's commit); a row already in its grace is
 * left as it is (null). 'gone' when the row was revoked or expired meanwhile.
 */
async function rotateForAuthz(db: DbHandle, s: SessionView, o: { now: number; idleMs: number; authzVersion: number }): Promise<SessionToken | null | 'gone'> {
  return withTx(db, async (trx) => {
    await lockStaffRow(trx, s.subjectId);
    await trx
      .updateTable('sessions')
      .set((eb) => ({ last_seen_at: eb.ref('last_seen_at') }))
      .where('id', '=', s.id)
      .execute();
    const row = await trx.selectFrom('sessions').select(['last_seen_at', 'expires_at']).where('id', '=', s.id).executeTakeFirst();
    if (row === undefined || Number(row.expires_at) <= o.now) return 'gone';
    if (inRotationGrace({ lastSeenAt: Number(row.last_seen_at), expiresAt: Number(row.expires_at) })) return null;
    return rotateSession(trx, s, { now: o.now, idleMs: o.idleMs, authzVersion: o.authzVersion });
  });
}

/**
 * Step 7 (see the top of this file) for a route that reads the session cookie. `rotate`: the route is under /api, so
 * a full session whose rights changed rotates here (ruling R1b-1). `background`: the route is declared `background`
 * (1c, Task 8), so the request is a background one whatever its headers say: no rotation, no touch.
 *
 * @throws DomainError `DB_UNAVAILABLE` when the request carries a session cookie and there is no database
 */
export async function resolveAuth(
  c: Context<AppEnv>,
  o: { db: DbHandle | undefined; services: AppServices; now: number; rotate: boolean; background?: boolean },
): Promise<ResolvedAuth> {
  const token = readAuthCookie(c, 'altis_sid');
  if (token === undefined) return NO_AUTH;
  const { db, services, now } = o;
  if (db === undefined) throw new DomainError('DB_UNAVAILABLE');

  const found = await findSession(db.db, token, now);
  if (found === null) {
    clearAuthCookie(c, 'altis_sid');
    return NO_AUTH;
  }
  const user = await loadStaffAuthView(db.db, found.subjectId);
  if (user === null) {
    await withTx(db, (trx) => revokeSession(trx, found.id));
    clearAuthCookie(c, 'altis_sid');
    return NO_AUTH;
  }
  if (user.status !== 'active') {
    // Taken out of use (§7.1 Pencabutan): every session and remember-me token of the user goes, not only this one.
    await withTx(db, async (trx) => {
      await lockStaffRow(trx, user.id);
      await revokeSubject(trx, user.id);
    });
    clearAuthCookie(c, 'altis_sid');
    return NO_AUTH;
  }
  const idleMs = await sessionIdleMs(services, db.db);
  if (found.mfaPassed && !inRotationGrace(found) && now >= found.lastSeenAt + idleMs) {
    // Idle under the limit in force now (it may have been lowered since the row was written).
    await db.db.deleteFrom('sessions').where('id', '=', found.id).execute();
    clearAuthCookie(c, 'altis_sid');
    return NO_AUTH;
  }
  const grants = await services.grants.get(db.db, user.id, user.authzVersion);
  const background = o.background === true || c.req.header('x-altis-background') === '1';

  let session = found;
  if (found.authzVersion !== user.authzVersion && !found.mfaPassed) {
    // A pre-2FA session keeps its token and its window (ruling R1b-1 b).
    await db.db.updateTable('sessions').set({ authz_version: user.authzVersion }).where('id', '=', found.id).execute();
    session = { ...found, authzVersion: user.authzVersion };
  } else if (found.authzVersion !== user.authzVersion && o.rotate && !background && !inRotationGrace(found)) {
    const rotated = await rotateForAuthz(db, found, { now, idleMs, authzVersion: user.authzVersion });
    if (rotated === 'gone') {
      clearAuthCookie(c, 'altis_sid');
      return NO_AUTH;
    }
    if (rotated !== null) {
      const fresh = await findSession(db.db, rotated.token, now);
      if (fresh === null) {
        clearAuthCookie(c, 'altis_sid');
        return NO_AUTH;
      }
      setSessionCookie(c, rotated);
      session = fresh;
    }
  }
  await touchSession(db.db, session, { now, idleMs, background });

  return {
    auth: { subjectId: user.id, session, user, grants, stage: stageOf(user, grants, session) },
    csrfSessionId: found.id,
  };
}

/** `X-Altis-Test-Gate: <value>` on the response, under the test profile only (see the top of this file). */
export function markTestGate(c: Context<AppEnv>, value: ErrorCode | 'PASSED'): void {
  // A dead branch once the build substitutes __BUILD_PROFILE__ with 'production'.
  if (typeof __BUILD_PROFILE__ !== 'undefined' && __BUILD_PROFILE__ === 'test') c.header('X-Altis-Test-Gate', value);
}

/** A step-9 denial: the error to throw, with `X-Altis-Test-Gate` on the response under the test profile only. */
export function deny(c: Context<AppEnv>, code: ErrorCode): DomainError {
  markTestGate(c, code);
  return new DomainError(code);
}

/**
 * Counts the denial of `permission` to `auth`'s subject on `authz-denied` and, for the first hit of the minute,
 * writes `authz.denied` (each in a transaction of its own, so neither depends on how the request ends).
 */
export async function auditDenial(db: DbHandle, decl: RouteDecl, permission: string, auth: AuthState, now: number, ip: string | null): Promise<void> {
  const h = await withTx(db, (trx) => hit(trx, 'authz-denied', auth.subjectId, now));
  if (h.count !== 1) return;
  await securityAudit(db, now, { type: 'staff', id: auth.subjectId, ip }, {
    action: 'authz.denied',
    entity: null,
    entityId: null,
    meta: { route: decl.id, permission },
  });
}

/** What step 9 needs for an `opsAuth` route (1c Task 15): the ops fence, the ops machine and the app's phase. */
export interface OpsGate {
  fence: OpsFence | null;
  ops: OpsMachine;
  phase: AppPhase;
}

/**
 * Step 9 (see the top of this file) for every route that is not `session: 'none'`. Returns what `opsAuth` decided for
 * an `opsAuth` route (`o.ops` is required there), null for any other route.
 *
 * @throws DomainError `AUTH_REQUIRED`, `AUTH_MFA_REQUIRED`, `AUTH_PASSWORD_CHANGE_REQUIRED`, `AUTHZ_DENIED`,
 *   `AUTH_REAUTH_REQUIRED`; for an `opsAuth` route also `OPS_AUTH_REQUIRED`
 */
export async function authorize(
  c: Context<AppEnv>,
  decl: RouteDecl,
  auth: AuthState | null,
  o: { db: DbHandle | undefined; now: number; ip: string | null; ops?: OpsGate },
): Promise<OpsAuth | null> {
  if (decl.opsAuth === true) {
    if (o.ops === undefined) throw deny(c, 'AUTHZ_DENIED'); // an app without an ops machine has no op to authorize
    return authorizeOps(c, decl, { ...o.ops, auth, db: o.db, now: o.now, ip: o.ip });
  }
  if (decl.public === true && (decl.session ?? 'optional') !== 'required') return null;
  if (auth === null) throw deny(c, 'AUTH_REQUIRED');
  const partial = decl.partialAuth === true;
  if (auth.stage !== 'full' && !partial) throw deny(c, 'AUTH_MFA_REQUIRED');
  if (auth.user.mustChangePassword && !partial && decl.id !== 'auth.password.change') {
    throw deny(c, 'AUTH_PASSWORD_CHANGE_REQUIRED');
  }
  const permission = decl.permission;
  if (permission !== undefined) {
    const branchId = decl.branchParam === undefined ? null : (c.req.param(decl.branchParam) ?? null);
    if (!can(auth.grants, permission, branchId)) {
      if (permission.startsWith('system.') && o.db !== undefined) await auditDenial(o.db, decl, permission, auth, o.now, o.ip);
      throw deny(c, 'AUTHZ_DENIED');
    }
  }
  if (decl.reauth === true) {
    const at = auth.session.reauthAt;
    if (at === null || o.now - at > REAUTH_MS) throw deny(c, 'AUTH_REAUTH_REQUIRED');
  }
  return null;
}
