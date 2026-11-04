import { CHUNK_DEFAULT_BYTES, lockStaffRow, login, restoreRememberedSession, revokeSessionLineage, runnerMode, sha256hex, stageOf } from '@altis/core';
import { permissionCatalog, type Locale, type Permission } from '@altis/shared';
import { LoginBody, type LoginResponse, type MeClient, type MeLibrary, type MeResponse } from '@altis/shared/api/auth';
import { REAUTH_MS, sessionIdleMs } from '../http/auth.js';
import type { AuthState } from '../http/auth-state.js';
import { DEVICE_MAX_AGE_S, REMEMBER_MAX_AGE_S, clearAuthCookie, readAuthCookie, setAuthCookie } from '../http/cookies.js';
import { csrfKey, ensurePreSessionCsrf, sessionCsrfToken, setSessionCookie } from '../http/csrf.js';
import { route, type RouteContext, type RouteDecl } from '../http/route.js';
import { sseEnabled } from '../realtime/streams.js';
import { collectBanners } from './banners.js';

// The auth routes of Task 15 (spec §7.1, route catalog): sign in, sign out, and `auth/me`, the SPA's first request.
//
// - `auth.login` (tx: 'self': its rate-limit hits and failure audits commit on their own, D3) runs core's login() with
//   `rc.withTx` as its runner (M38), sets `altis_sid` with the session's `X-CSRF-Token` (S9; the SPA's next write,
//   `auth/2fa/verify` included, carries it), `altis_dev` for 180 days after a completed login and `altis_rm` for 30
//   days when asked for; it audits through the auth layer (D9). (1b's opportunistic sweep after each attempt, D19, is
//   gone: 1c Task 18's scheduled `housekeeping.volatile` job does that work.)
// - `auth.logout` revokes the session with its remember-me token (B9) and the rest of its sign-in (the sessions it
//   was rotated from and into, revokeSessionLineage), audits `auth.logout` and clears `altis_sid` and `altis_rm`;
//   `altis_dev` stays (the device stays known). Its transaction locks the user's row first (lockStaffRow).
// - `auth.me` answers anonymous (with the pre-session CSRF token, D20) or the session's view: for a stage other than
//   `full` without any permission, banner or super-admin flag (M10). Without a live session it first tries the
//   remember-me restore (Task 17; only here, the SPA's first request after a page load, §4.8): a valid `altis_rm`
//   gives a full session (setSessionCookie, S9) and, when the validator rotated, a new `altis_rm` for 30 days; any
//   other outcome clears `altis_rm` and answers anonymous (core's restoreRememberedSession). A `full` session also
//   gets the client hints (1c Task 16, MeClient): SSE or polling, method override, the first chunk size.

const AUTH = '/api/v1/auth';

/**
 * The remember-me restore of `auth.me` (see the top of this file), for a request without a live session: the session
 * restored from `altis_rm` as step 7 would have resolved it, or null (no cookie, or one refused: then it is cleared).
 */
async function restoreFromCookie(rc: RouteContext<unknown, unknown, unknown>): Promise<AuthState | null> {
  const cookie = readAuthCookie(rc.c, 'altis_rm');
  if (cookie === undefined) return null;
  const outcome = await restoreRememberedSession(rc.withTx, rc.db, {
    cookie,
    now: rc.now,
    sessionKey: csrfKey(rc.config),
    ip: rc.ip,
    userAgent: rc.c.req.header('user-agent') ?? null,
    idleMs: await sessionIdleMs(rc.services, rc.db.db),
  });
  if (outcome.kind !== 'restored') {
    clearAuthCookie(rc.c, 'altis_rm');
    return null;
  }
  setSessionCookie(rc.c, outcome.session);
  if (outcome.cookie !== null) setAuthCookie(rc.c, 'altis_rm', outcome.cookie, { maxAgeS: REMEMBER_MAX_AGE_S });
  const { view, user, grants } = outcome;
  return { subjectId: user.id, session: view, user, grants, stage: stageOf(user, grants, view) };
}

async function libraryOf(rc: RouteContext<unknown, unknown, unknown>): Promise<MeLibrary> {
  const name = await rc.services.settings.get<string>(rc.db.db, 'library.name');
  const locale = await rc.services.settings.get<Locale>(rc.db.db, 'library.locale');
  return { name, locale };
}

/** What `system.probe` holds that the client hints read (the browser test of Diagnostik, Task 23). */
interface ProbeHints {
  at: number;
  methods: { put: boolean; patch: boolean; delete: boolean };
  chunkBytes: number | null;
}

/**
 * The client hints of a `full` session (1c Task 16): `realtime` from `realtime.sse` and the runtime (sseEnabled),
 * `methodOverride` when the browser test saw any of PUT, PATCH and DELETE blocked, `chunkBytes` the largest chunk it
 * saw pass, else 5 MiB, `probedAt` when it ran (null: never), `runner` this process's runner mode (1d: the job
 * runtime's, else the runtime's rule, as `ops/current` tells it). Read through the settings cache: hints may be a
 * little stale (P6). Read for every `auth/me`, before the remember-me restore (T17: no settings read may fail after
 * it), and sent with stage `full` only.
 */
async function clientHints(rc: RouteContext<unknown, unknown, unknown>): Promise<MeClient> {
  const { settings, runtime } = rc.services;
  const sse = await settings.get<boolean | null>(rc.db.db, 'realtime.sse');
  const probe = await settings.get<ProbeHints | null>(rc.db.db, 'system.probe');
  return {
    realtime: sseEnabled(sse, runtime) ? 'sse' : 'polling',
    methodOverride: probe !== null && !(probe.methods.put && probe.methods.patch && probe.methods.delete),
    chunkBytes: probe?.chunkBytes ?? CHUNK_DEFAULT_BYTES,
    probedAt: probe?.at ?? null,
    runner: rc.services.jobs?.mode ?? runnerMode(runtime, rc.services.configWriter.env),
  };
}

/** The permissions of `held`, in catalog order. */
function inCatalogOrder(held: ReadonlySet<Permission>): Permission[] {
  return permissionCatalog()
    .map((def) => def.key)
    .filter((key) => held.has(key));
}

/** POST auth/login. */
const authLogin = route({
  id: 'auth.login',
  method: 'POST',
  path: `${AUTH}/login`,
  public: true,
  partialAuth: true,
  mode: 'system',
  maintenance: 'allow',
  idempotency: 'none',
  audit: null,
  tx: 'self',
  body: LoginBody,
  handler: async (rc) => {
    const deviceCookie = readAuthCookie(rc.c, 'altis_dev');
    const previousSessionId = rc.auth?.session.id;
    const outcome = await login(
      { username: rc.body.username, password: rc.body.password, remember: rc.body.remember ?? false },
      {
        run: rc.withTx,
        now: rc.now,
        ip: rc.ip,
        ipTrust: rc.ipTrust,
        userAgent: rc.c.req.header('user-agent') ?? null,
        sessionKey: csrfKey(rc.config),
        ...(deviceCookie === undefined ? {} : { deviceCookie }),
        hasher: rc.services.hasher,
        idleMs: await sessionIdleMs(rc.services, rc.db.db),
        ...(previousSessionId === undefined ? {} : { previousSessionId }),
        log: rc.log,
      },
    );
    setSessionCookie(rc.c, outcome.session);
    if (outcome.deviceCookie !== null) {
      setAuthCookie(rc.c, 'altis_dev', outcome.deviceCookie, { maxAgeS: DEVICE_MAX_AGE_S });
    }
    if (outcome.rememberCookie !== null) {
      setAuthCookie(rc.c, 'altis_rm', outcome.rememberCookie, { maxAgeS: REMEMBER_MAX_AGE_S });
    }
    const body: LoginResponse = { stage: outcome.stage, mustChangePassword: outcome.mustChangePassword };
    return { body };
  },
});

/** POST auth/logout. */
const authLogout = route({
  id: 'auth.logout',
  method: 'POST',
  path: `${AUTH}/logout`,
  public: true,
  session: 'required',
  partialAuth: true,
  mode: 'system',
  maintenance: 'allow',
  idempotency: 'none',
  audit: 'auth.logout',
  handler: async (rc) => {
    const auth = rc.auth!; // session: 'required' (step 9)
    const { trx } = rc.tx();
    await lockStaffRow(trx, auth.subjectId); // first: this transaction revokes sessions
    // The whole sign-in: a row still in its rotation grace (a tab that sent the old token) takes the session it was
    // rotated into with it, and with that the remember-me token rotation moved onto it.
    await revokeSessionLineage(trx, auth.session.id);
    // When step 7 rotated the session on this very request, the token the browser sent stays valid for its 30 s
    // grace: it goes too (it is of the same lineage; named here in case it is not).
    const sent = readAuthCookie(rc.c, 'altis_sid');
    if (sent !== undefined && sha256hex(sent) !== auth.session.id) await revokeSessionLineage(trx, sha256hex(sent));
    await rc.audit({ entity: 'staff_users', entityId: auth.subjectId });
    rc.afterCommit(() => {
      clearAuthCookie(rc.c, 'altis_sid');
      clearAuthCookie(rc.c, 'altis_rm');
    });
    return {};
  },
});

/** GET auth/me. */
const authMe = route({
  id: 'auth.me',
  method: 'GET',
  path: `${AUTH}/me`,
  public: true,
  partialAuth: true,
  mode: 'system',
  maintenance: 'allow',
  idempotency: 'none',
  audit: null,
  handler: async (rc) => {
    const headers = { 'Cache-Control': 'no-store' };
    // The settings first: once the restore has rotated the remember-me validator, a failure would drop the new
    // altis_rm with the error response (ruling R1b-1 d), and the browser's next page load (after the 30 s grace)
    // would present the old one, taken for a theft (T17). collectBanners catches its own errors.
    const library = await libraryOf(rc);
    const client = await clientHints(rc); // 1c Task 16; a settings read, so before the restore too
    const auth = rc.auth ?? (await restoreFromCookie(rc));
    const build = rc.services.version;
    if (auth === null) {
      const anonymous: MeResponse = { authenticated: false, csrfToken: ensurePreSessionCsrf(rc.c), library, build, ...maintenanceOf(rc) };
      return { body: anonymous, headers };
    }
    const { user, grants, session } = auth;
    // A pre-2FA session learns nothing about the account's rights (M10).
    const full = auth.stage === 'full';
    const body: MeResponse = {
      authenticated: true,
      csrfToken: sessionCsrfToken(csrfKey(rc.config), session.id),
      stage: auth.stage,
      mustChangePassword: user.mustChangePassword,
      user: {
        id: user.id,
        username: user.username,
        name: user.name,
        email: user.email,
        locale: user.locale,
        totpEnabled: user.totpEnabled,
        mfaRequired: user.mfaRequired || grants.roleMfaRequired,
      },
      permissions: full ? inCatalogOrder(grants.global) : [],
      branchPermissions: full
        ? Object.fromEntries([...grants.branches].map(([branchId, held]) => [branchId, inCatalogOrder(held)]))
        : {},
      superAdmin: full && grants.superAdmin,
      reauthUntil: session.reauthAt === null ? null : session.reauthAt + REAUTH_MS,
      library,
      build,
      banners: full
        ? await collectBanners({ db: rc.db, auth, now: rc.now, fence: rc.services.opsFence }, rc.log)
        : [],
      ...(full ? { client } : {}),
      ...maintenanceOf(rc),
    };
    return { body, headers };
  },
});

// ---- 1c Task 19: auth/me's `maintenance` field -----------------------------------------------------------------

/**
 * `{maintenance: true}` while a maintenance flag is up (the ops fence's view, at most 2 s old), else nothing: the admin's
 * maintenance screen lifts on its absence, whatever the session's stage and whether a banner provider failed.
 */
function maintenanceOf(rc: RouteContext<unknown, unknown, unknown>): { maintenance?: true } {
  const flag = rc.services.opsFence?.maintenance() ?? null;
  return flag === null ? {} : { maintenance: true };
}

/** The routes of this file, in the order of the route catalog. */
export const AUTH_ROUTES: RouteDecl[] = [authLogin, authLogout, authMe];
