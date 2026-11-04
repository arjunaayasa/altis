import { can, type OpHandle, type OpsMachine } from '@altis/core';
import type { DbHandle } from '@altis/db';
import { NEEDS_ATTENTION, OP_KIND_PERMISSION, type Permission } from '@altis/shared';
import type { Context } from 'hono';
import type { AppPhase } from '../app.js';
import { REAUTH_MS, auditDenial, deny } from './auth.js';
import type { AuthState } from './auth-state.js';
import { OPS_MAX_AGE_S, readAuthCookie, setAuthCookie } from './cookies.js';
import type { OpsFence } from './ops-fence.js';
import type { AppEnv } from './request-id.js';
import type { RouteDecl } from './route.js';

// `opsAuth` (spec §9.4, §4.7 step 7 "Sesi/ops-auth"; plan Task 15, S3, decision C20): who may use the ops routes
// (`ops/current|drive|cancel|takeover|report`, `/admin/_update`). step 9 (http/auth.ts authorize) delegates here:
//
//   1. an `altis_ops` cookie whose token `OpsMachine.tokenMatches` (the current op: one that has not ended, or ended
//      less than an hour ago) → `{via: 'cookie', opId}`, read from DATA_DIR/ops/op.json only, never the database;
//   2. else, unless the restore passed its point of no return (its tables may be gone) or the process waits for an op
//      (`ops_wait`: no database at all), step 7's session: stage `full` (else AUTH_MFA_REQUIRED, as every route), no
//      pending password change, and the permission of the current op's kind (OP_KIND_PERMISSION; without one, any of
//      `system.update.run`, `system.backup.restore`, `system.backup.create`) → `{via: 'session', auth}`. 1d review C16:
//      in phase `updating` too (an update §9.8 begins belongs to the system actor, so no browser holds its cookie), as
//      long as the process has a database and no op moves the schema (`migrating`, `restoring`, `needs_attention`
//      left `restoring`, an unreadable op.json); a session the running release cannot read there counts as none
//      (http/route.ts). Such a session takes the op over (`ops/takeover`) for the cookie, which then opens the routes
//      on every process (§9.2 step 6's minimal serving included) and while the schema moves;
//   3. else 401 OPS_AUTH_REQUIRED without a session, 403 AUTHZ_DENIED with one that lacks the permission (counted and
//      audited as `authz.denied`, as a denied `system.*` permission is).
//
// A `reauth` route (`ops/cancel`, `ops/takeover`) is never opened by the cookie alone: it needs the session of step 2
// with a re-authentication of the last 5 minutes (AUTH_REAUTH_REQUIRED), whatever cookie the browser holds (§9.4:
// "reauth + izin jenis operasi").
//
// The route chain (http/route.ts) skips step 7 for an `opsAuth` route only where {@link opsSessionAllowed} says no:
// past a restore's point of no return, in `ops_wait`, and in `updating` without a database or while the schema moves
// (S3: before that point every table is there, so a super admin can still sign in, re-authenticate and cancel). The
// `altis_ops` CSRF token is http/csrf.ts opsCsrfToken.

/** What `opsAuth` decided: the cookie of the op `opId`, or a session holding the op kind's permission. */
export type OpsAuth = { via: 'cookie'; opId: string } | { via: 'session'; auth: AuthState };

/** Without a current op, any of these opens the ops routes to a session (spec §9.4: the permissions of the op kinds). */
export const OPS_ANY_PERMISSIONS: readonly Permission[] = Object.freeze(['system.update.run', 'system.backup.restore', 'system.backup.create']);

/** What step 9 hands to {@link authorizeOps} besides the request. */
export interface OpsAuthOptions {
  /** The process's ops fence (null in an app without DATA_DIR): whether a restore passed its point of no return. */
  fence: OpsFence | null;
  ops: OpsMachine;
  /** The app's phase: `ops_wait` opens the routes by cookie only (and `updating` while the schema moves). */
  phase: AppPhase;
  /** Step 7's session (null without one, and when step 7 was skipped). */
  auth: AuthState | null;
  db: DbHandle | undefined;
  now: number;
  ip: string | null;
}

/**
 * Sets the `altis_ops` cookie to the token of `h` (a route that begins an op, or `ops/takeover`): `HttpOnly;
 * SameSite=Lax; Path=/`, plus `Secure` and the `__Host-` name with an https baseUrl, Max-Age 7 days.
 */
export function issueOpsCookie(c: Context<AppEnv>, h: OpHandle): void {
  setAuthCookie(c, 'altis_ops', h.opsToken, { maxAgeS: OPS_MAX_AGE_S });
}

/** The op each request's cookie belongs to, looked up once per request (step 8 and step 9 both ask). */
const cookieOps = new WeakMap<Context<AppEnv>, Promise<string | null>>();

async function matchCookie(c: Context<AppEnv>, ops: OpsMachine): Promise<string | null> {
  const token = readAuthCookie(c, 'altis_ops');
  if (token === undefined || !(await ops.tokenMatches(token))) return null;
  const current = await ops.current();
  // The token must still match once the op was read: a new op begun (or a takeover) in between is not the cookie's.
  if (current === null || current.opId === null || !(await ops.tokenMatches(token))) return null;
  return current.opId;
}

/**
 * The id of the op whose `altis_ops` this request carries (OpsMachine.tokenMatches: the current op, ended at most an
 * hour ago), or null. Reads DATA_DIR/ops/op.json only.
 */
export function opsCookieOp(c: Context<AppEnv>, ops: OpsMachine): Promise<string | null> {
  let found = cookieOps.get(c);
  if (found === undefined) {
    found = matchCookie(c, ops);
    cookieOps.set(c, found);
  }
  return found;
}

/**
 * 1d review C16: the states of an op whose steps move the schema under every reader: the migrations run, or the
 * revert's restore drops and loads the tables (spec §9.7 `restoring`).
 */
const SCHEMA_MOVING_STATES: ReadonlySet<string> = new Set(['migrating', 'restoring']);

/**
 * 1d review C16: whether the active op the fence knows moves the schema now ({@link SCHEMA_MOVING_STATES}), or left
 * `restoring` for `needs_attention` (its tables may be gone), or cannot be read at all (nothing may assume its tables are
 * there).
 */
function schemaMoving(fence: OpsFence | null): boolean {
  if (fence === null) return false;
  const op = fence.op();
  if (op === null) return fence.active(); // an unreadable op.json whose flag names no op
  if (op.state === NEEDS_ATTENTION) return op.stateBefore === undefined || op.stateBefore === 'restoring';
  return SCHEMA_MOVING_STATES.has(op.state);
}

/**
 * Whether step 7's session may open an ops route now (see the top of this file), and (1d review C16) whether phase
 * `updating` serves the sign-in (app.ts): never in `ops_wait` (no database) nor past a restore's point of no return;
 * in `updating` only with a database and while no op moves the schema ({@link schemaMoving}). `db`: the app's open
 * database (state.db).
 */
export function opsSessionAllowed(o: { fence: OpsFence | null; phase: AppPhase; db: DbHandle | undefined }): boolean {
  if (o.phase === 'ops_wait' || o.fence?.restorePastPonr() === true) return false;
  if (o.phase !== 'updating') return true;
  return o.db !== undefined && !schemaMoving(o.fence);
}

/**
 * `opsAuth` for `decl` (see the top of this file).
 *
 * @throws DomainError `OPS_AUTH_REQUIRED`, `AUTH_MFA_REQUIRED`, `AUTH_PASSWORD_CHANGE_REQUIRED`, `AUTHZ_DENIED`,
 *   `AUTH_REAUTH_REQUIRED` (each marked with `X-Altis-Test-Gate` under the test profile)
 */
export async function authorizeOps(c: Context<AppEnv>, decl: RouteDecl, o: OpsAuthOptions): Promise<OpsAuth> {
  if (decl.reauth !== true) {
    const opId = await opsCookieOp(c, o.ops);
    if (opId !== null) return { via: 'cookie', opId };
  }
  const auth = opsSessionAllowed(o) ? o.auth : null;
  if (auth === null) throw deny(c, 'OPS_AUTH_REQUIRED');
  if (auth.stage !== 'full') throw deny(c, 'AUTH_MFA_REQUIRED');
  if (auth.user.mustChangePassword) throw deny(c, 'AUTH_PASSWORD_CHANGE_REQUIRED');
  const current = await o.ops.current();
  const needed = current === null || current.kind === null ? OPS_ANY_PERMISSIONS : [OP_KIND_PERMISSION[current.kind]];
  if (!needed.some((p) => can(auth.grants, p))) {
    if (o.db !== undefined) await auditDenial(o.db, decl, needed[0]!, auth, o.now, o.ip);
    throw deny(c, 'AUTHZ_DENIED');
  }
  if (decl.reauth === true) {
    const at = auth.session.reauthAt;
    if (at === null || o.now - at > REAUTH_MS) throw deny(c, 'AUTH_REAUTH_REQUIRED');
  }
  return { via: 'session', auth };
}
