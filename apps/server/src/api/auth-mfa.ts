import {
  beginTotpSetup,
  disableTotpWithCredentials,
  enableTotp,
  reauthenticate,
  regenerateRecoveryCodes,
  verifySecondFactor,
  type VerifyOutcome,
} from '@altis/core';
import { DomainError, isDomainError } from '@altis/shared';
import {
  ReauthBody,
  TwoFactorDisableBody,
  TwoFactorEnableBody,
  TwoFactorVerifyBody,
  type ReauthResponse,
  type RecoveryCodesResponse,
  type SessionStage,
  type TwoFactorSetupResponse,
  type TwoFactorVerifyResponse,
} from '@altis/shared/api/auth';
import { REAUTH_MS, sessionIdleMs } from '../http/auth.js';
import { DEVICE_MAX_AGE_S, REMEMBER_MAX_AGE_S, clearAuthCookie, readAuthCookie, setAuthCookie } from '../http/cookies.js';
import { csrfKey, setSessionCookie } from '../http/csrf.js';
import { problemResponse } from '../http/problem.js';
import { route, type RouteContext, type RouteDecl } from '../http/route.js';

// The 2FA and reauth routes of Task 16 (spec §7.1, §7.3, route catalog); the work is core's (auth/mfa.ts).
//
// - `auth.2fa.verify` (partialAuth, tx: 'self': its rate-limit hits and failure audits commit on their own, D3)
//   completes a sign-in in stage `mfa` with a TOTP code or a recovery code: the rotated session through
//   setSessionCookie (a new `altis_sid` and `X-CSRF-Token`, S9), `altis_dev`, and `altis_rm` when asked for. In stage
//   `recovery` a recovery code moves the session to `mfa_setup` (D15), audited as `auth.2fa.disable {reason:
//   'reenroll'}` (its `alsoAudits`). A session in stage `full` has nothing to verify and gets its stage back unchanged;
//   `mfa_setup` → 401 AUTH_MFA_REQUIRED. When the pre-2FA session ended (the fifth wrong code deletes it, S10), the
//   401 AUTH_REQUIRED clears `altis_sid`.
// - `auth.2fa.setup` and `auth.2fa.enable` (partialAuth): a pre-2FA session reaches them only in stage `mfa_setup`
//   (§7.1), otherwise 401 AUTH_MFA_REQUIRED. Enabling revokes every session of the user, the requester's included
//   (S11, D22): the response carries the 10 recovery codes and clears `altis_sid` and `altis_rm`.
// - `auth.2fa.disable` (password + code, S18) revokes every session too and clears both cookies.
// - `auth.2fa.recovery_codes` (reauth) answers 10 new codes.
// - `auth.reauth` sets `reauth_at` (§7.3) and answers until when it counts.
//
// Setup is `tx: 'self'` too: it reads the issuer (`library.name`) before its transaction, whose first statement must
// be the lock on the user's row (core's lockAccount; on SQLite a read beside an open transaction would wait for it).
// Every answer that holds a secret (the TOTP secret, recovery codes) is `Cache-Control: no-store`; none is idempotent
// (`auth/*` routes are `idempotency: 'none'`).

const AUTH = '/api/v1/auth';

const NO_STORE = { 'Cache-Control': 'no-store' };

/** §7.1: a pre-2FA session reaches setup and enable only while 2FA is required and not enrolled (stage `mfa_setup`). */
function assertEnrolmentStage(stage: SessionStage): void {
  if (stage === 'mfa' || stage === 'recovery') {
    throw new DomainError('AUTH_MFA_REQUIRED', {
      detail: 'Selesaikan verifikasi 2FA terlebih dahulu / Complete the 2FA verification first',
    });
  }
}

/** Every session of the user ended (S11): the browser's session and remember-me cookies go with them. */
function clearSignIn(rc: RouteContext<unknown, unknown, unknown>): void {
  clearAuthCookie(rc.c, 'altis_sid');
  clearAuthCookie(rc.c, 'altis_rm');
}

/** POST auth/2fa/verify. */
const twoFactorVerify = route({
  id: 'auth.2fa.verify',
  method: 'POST',
  path: `${AUTH}/2fa/verify`,
  public: true,
  session: 'required',
  partialAuth: true,
  mode: 'system',
  maintenance: 'allow',
  idempotency: 'none',
  audit: null,
  // The 2FA reset of a re-enrolment (stage `recovery`, D15).
  alsoAudits: ['auth.2fa.disable'],
  tx: 'self',
  body: TwoFactorVerifyBody,
  handler: async (rc) => {
    const auth = rc.auth!; // session: 'required' (step 9)
    if (auth.stage === 'full') {
      // Nothing is owed (another tab finished first): no code is checked, nothing changes.
      const body: TwoFactorVerifyResponse = { stage: 'full', mustChangePassword: auth.user.mustChangePassword };
      return { body };
    }
    let outcome: VerifyOutcome;
    try {
      outcome = await verifySecondFactor(rc.withTx, {
        session: auth.session,
        userId: auth.subjectId,
        stage: auth.stage,
        code: rc.body.code,
        recoveryCode: rc.body.recoveryCode,
        remember: rc.body.remember ?? false,
        now: rc.now,
        keyring: rc.config.keyring,
        idleMs: await sessionIdleMs(rc.services, rc.db.db),
        sessionKey: csrfKey(rc.config),
        deviceCookie: readAuthCookie(rc.c, 'altis_dev'),
      });
    } catch (error) {
      if (!isDomainError(error) || error.code !== 'AUTH_REQUIRED') throw error;
      // The pre-2FA session ended (S10: the fifth wrong code; or it was revoked meanwhile). The answer carries the
      // cleared cookie, so the SPA starts over from auth/me instead of sending a session CSRF token that no session
      // backs any more (which step 8 would refuse first). A thrown error would drop the handler's cookies (R1b-1 d).
      clearAuthCookie(rc.c, 'altis_sid');
      return problemResponse(error, rc.requestId);
    }
    if (outcome.session !== null) setSessionCookie(rc.c, outcome.session);
    if (outcome.deviceCookie !== null) setAuthCookie(rc.c, 'altis_dev', outcome.deviceCookie, { maxAgeS: DEVICE_MAX_AGE_S });
    if (outcome.rememberCookie !== null) {
      setAuthCookie(rc.c, 'altis_rm', outcome.rememberCookie, { maxAgeS: REMEMBER_MAX_AGE_S });
    }
    const body: TwoFactorVerifyResponse = { stage: outcome.stage, mustChangePassword: outcome.mustChangePassword };
    return { body };
  },
});

/** POST auth/2fa/setup. */
const twoFactorSetup = route({
  id: 'auth.2fa.setup',
  method: 'POST',
  path: `${AUTH}/2fa/setup`,
  public: true,
  session: 'required',
  partialAuth: true,
  mode: 'system',
  idempotency: 'none',
  audit: null,
  tx: 'self',
  handler: async (rc) => {
    const auth = rc.auth!;
    assertEnrolmentStage(auth.stage);
    const issuer = await rc.services.settings.get<string>(rc.db.db, 'library.name');
    const body: TwoFactorSetupResponse = await rc.withTx((tx) =>
      beginTotpSetup(tx, auth.subjectId, { keyring: rc.config.keyring, issuer, sessionId: auth.session.id }),
    );
    return { body, headers: NO_STORE };
  },
});

/** POST auth/2fa/enable. */
const twoFactorEnable = route({
  id: 'auth.2fa.enable',
  method: 'POST',
  path: `${AUTH}/2fa/enable`,
  public: true,
  session: 'required',
  partialAuth: true,
  mode: 'system',
  idempotency: 'none',
  audit: 'auth.2fa.enable',
  tx: 'self',
  body: TwoFactorEnableBody,
  handler: async (rc) => {
    const auth = rc.auth!;
    assertEnrolmentStage(auth.stage);
    const body: RecoveryCodesResponse = await enableTotp(rc.withTx, auth.subjectId, rc.body.code, {
      keyring: rc.config.keyring,
      now: rc.now,
      sessionId: auth.session.id,
    });
    clearSignIn(rc);
    return { body, headers: NO_STORE };
  },
});

/** POST auth/2fa/disable. */
const twoFactorDisable = route({
  id: 'auth.2fa.disable',
  method: 'POST',
  path: `${AUTH}/2fa/disable`,
  public: true,
  session: 'required',
  mode: 'system',
  idempotency: 'none',
  audit: 'auth.2fa.disable',
  tx: 'self',
  body: TwoFactorDisableBody,
  handler: async (rc) => {
    const auth = rc.auth!;
    await disableTotpWithCredentials(rc.withTx, {
      userId: auth.subjectId,
      sessionId: auth.session.id,
      password: rc.body.password,
      code: rc.body.code,
      now: rc.now,
      hasher: rc.services.hasher,
      keyring: rc.config.keyring,
      log: rc.log,
    });
    clearSignIn(rc);
    return {};
  },
});

/** POST auth/2fa/recovery-codes. */
const twoFactorRecoveryCodes = route({
  id: 'auth.2fa.recovery_codes',
  method: 'POST',
  path: `${AUTH}/2fa/recovery-codes`,
  public: true,
  session: 'required',
  reauth: true,
  mode: 'system',
  idempotency: 'none',
  audit: 'auth.2fa.recovery_codes',
  handler: async (rc) => {
    const auth = rc.auth!;
    const body: RecoveryCodesResponse = await regenerateRecoveryCodes(rc.tx(), auth.subjectId, { sessionId: auth.session.id });
    return { body, headers: NO_STORE };
  },
});

/** POST auth/reauth. */
const reauth = route({
  id: 'auth.reauth',
  method: 'POST',
  path: `${AUTH}/reauth`,
  public: true,
  session: 'required',
  mode: 'system',
  // Ruling R1c-9: open during a restore too (the operations page re-authenticates a session to cancel or take over),
  // except past the restore's point of no return, where step 5 answers 409 OPS_POINT_OF_NO_RETURN (http/maintenance.ts).
  maintenance: 'restore-allow',
  idempotency: 'none',
  audit: null,
  tx: 'self',
  body: ReauthBody,
  handler: async (rc) => {
    const auth = rc.auth!;
    await reauthenticate(rc.withTx, {
      session: auth.session,
      userId: auth.subjectId,
      password: rc.body.password,
      code: rc.body.code,
      now: rc.now,
      hasher: rc.services.hasher,
      keyring: rc.config.keyring,
      log: rc.log,
    });
    const body: ReauthResponse = { reauthUntil: rc.now + REAUTH_MS };
    return { body };
  },
});

/** The routes of this file, in the order of the route catalog. */
export const AUTH_MFA_ROUTES: RouteDecl[] = [
  twoFactorVerify,
  twoFactorSetup,
  twoFactorEnable,
  twoFactorDisable,
  twoFactorRecoveryCodes,
  reauth,
];
