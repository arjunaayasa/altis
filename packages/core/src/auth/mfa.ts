import type { DB } from '@altis/db';
import { DomainError, isDomainError, newId } from '@altis/shared';
import type { RecoveryCodesResponse, SessionStage, TwoFactorSetupResponse } from '@altis/shared/api/auth';
import type { Transaction } from 'kysely';
import { loadGrants } from '../authz/grants.js';
import { errorFields, type CoreLogger, type TxCtx, type TxRunner } from '../context.js';
import { generateRecoveryCodes, normalizeRecoveryCode, recoveryCodeHash } from '../crypto/codes.js';
import type { PasswordHasher } from '../crypto/password.js';
import { openValue, sealValue, secretAad, type KeyringEntry } from '../crypto/secret-box.js';
import { deviceCookieAfterLogin } from './device.js';
import { BUCKETS, hit, refund, type BucketName, type Hit } from './rate-limit.js';
import { issueRememberToken } from './remember.js';
import { markReauth, revokeSession, revokeSubject, rotateSession, type SessionToken, type SessionView } from './sessions.js';
import { loadStaffAuthView, lockStaffRow, type StaffAuthView } from './staff.js';
import { base32Decode, base32Encode, generateTotpSecret, matchTotp, otpauthUri } from './totp.js';

// Staff two-factor authentication and re-authentication (spec §7.1, §7.3; decisions D15, D22; S10, S11, S18).
//
// - Enrolment: beginTotpSetup seals a new 20-byte secret into `totp_secret_enc` (as base32 text, AAD
//   `staff_users.totp_secret_enc.<id>`) with `totp_enabled = 0`; enableTotp switches it on once a code of it matches,
//   replaces the 10 recovery codes and revokes every session and remember-me token of the user, the requester's
//   included (S11, D22: only a password change keeps the current session). The user then signs in again.
// - The second factor of a sign-in: checkSecondFactor counts `2fa:session` and `2fa:user` (or `recovery:user` for a
//   recovery code), each in a transaction of its own committed before anything is checked, then uses the code up in a
//   transaction that the caller's success work (`onPass`) joins. A TOTP code is accepted for steps s-1..s+1 after
//   `totp_last_step` and stored with `UPDATE … WHERE totp_last_step < :step`; a recovery code with
//   `UPDATE … WHERE used_at IS NULL`. A right TOTP code gives its `2fa:user` hit back in that transaction (as a login
//   gives its buckets back: the limit is on guesses); `recovery:user` keeps counting used codes. A wrong code is
//   audited as `auth.login.failed {stage: '2fa' | 'recovery'}` in a transaction of its own; the failure that brings
//   `2fa:session` to its limit (5) deletes the pre-2FA session in that same transaction and answers AUTH_REQUIRED
//   (S10: the browser learns that its session ended), and a later attempt whose `2fa:session` hit is refused deletes
//   it too (401 AUTH_REQUIRED).
//   verifySecondFactor is the `auth/2fa/verify` flow on top of it: in stage `mfa` the login completes (remember-me
//   token first, then the rotated session that records it, B9; `last_login_at`; `auth.login.success`), in stage
//   `recovery` (`totp_reenroll`) a recovery code clears the secret and requires re-enrolment (D15), audited as
//   `auth.2fa.disable {reason: 'reenroll'}` (controller ruling; the route lists it in `alsoAudits`).
// - disableTotp clears the secret, the flags and the recovery codes and revokes every session and token (S11); its
//   caller has verified the password outside any transaction first (S18). A 2FA that the user flag or a role
//   requires stays on (MFA_REQUIRED_BY_POLICY).
// - reauthenticate (§7.3): `reauth:session`, the password outside any transaction, a TOTP code when 2FA is
//   enabled, then `sessions.reauth_at = now`.
// - Enabling, disabling and re-authenticating give their hit (`2fa:user`, `reauth:session`) back on success, in the
//   transaction of the success.
//
// Every transaction here that issues, changes or revokes the user's sessions or 2FA state starts by locking the
// user's row (lockStaffRow: a write that changes nothing, as login's transaction B and D14; lockAccount then reads
// the account again under that lock). A password change or reset, a 2FA change or a disable that writes the same
// row is then either seen here or waits until this transaction ends (and then revokes what it created); on
// MySQL/MariaDB the lock comes before the first plain read, so the reads see the latest commit (REPEATABLE READ).
//
// Every transaction goes through `run` (M38): the HTTP layer hands in `rc.withTx`, whose audits count for the
// route's audit-once check. scrypt never runs inside one (S18).

/** How the second factor passed. */
export type SecondFactor = 'totp' | 'recovery';

/** Recovery codes per user (§7.1). */
const RECOVERY_CODE_COUNT = 10;

const mfaInvalid = (): DomainError =>
  new DomainError('AUTH_MFA_INVALID', {
    detail: 'Kode salah, kedaluwarsa, atau sudah dipakai / The code is wrong, expired or already used',
  });

const tooManyAttempts = (retryAfterS: number): DomainError =>
  new DomainError('AUTH_TOO_MANY_ATTEMPTS', {
    detail: 'Terlalu banyak percobaan; coba lagi nanti / Too many attempts; try again later',
    meta: { retryAfterS },
  });

const sessionEnded = (): DomainError =>
  new DomainError('AUTH_REQUIRED', { detail: 'Sesi sudah berakhir; silakan masuk lagi / The session has ended; sign in again' });

const wrongPassword = (): DomainError =>
  new DomainError('AUTH_INVALID_CREDENTIALS', { detail: 'Kata sandi salah / Wrong password' });

const alreadyEnabled = (): DomainError =>
  new DomainError('MFA_ALREADY_ENABLED', { detail: '2FA sudah aktif / 2FA is already enabled' });

const notEnabled = (detail = '2FA belum aktif / 2FA is not enabled'): DomainError => new DomainError('MFA_NOT_ENABLED', { detail });

const requiredByPolicy = (): DomainError =>
  new DomainError('MFA_REQUIRED_BY_POLICY', {
    detail: '2FA diwajibkan untuk akun ini dan tidak dapat dimatikan / 2FA is required for this account and cannot be switched off',
  });

/** A code or password refused inside a transaction: thrown to roll it back, then audited and `error` thrown. */
class Refused extends Error {
  constructor(readonly error: DomainError) {
    super(error.code);
    this.name = 'Refused';
  }
}

/** The user's account as read under the row lock: never leaves this module (it holds the hash and the sealed secret). */
interface Account {
  view: StaffAuthView;
  passwordHash: string;
  /** `v1:…` (sealed base32 text), pending or enabled; null without a secret. */
  secretEnc: string | null;
  lastStep: number;
}

const totpAad = (userId: string): string => secretAad('staff_users', 'totp_secret_enc', userId);

/**
 * Locks the user's row and reads the account under that lock (see the top of this file); null when there is no
 * such user. Call it first in its transaction, before any other statement.
 */
async function lockAccount(trx: Transaction<DB>, userId: string): Promise<Account | null> {
  await lockStaffRow(trx, userId);
  const row = await trx
    .selectFrom('staff_users')
    .select(['password_hash', 'totp_secret_enc', 'totp_last_step'])
    .where('id', '=', userId)
    .executeTakeFirst();
  const view = row === undefined ? null : await loadStaffAuthView(trx, userId);
  if (row === undefined || view === null) return null;
  return { view, passwordHash: row.password_hash, secretEnc: row.totp_secret_enc, lastStep: Number(row.totp_last_step) };
}

/**
 * lockAccount for a request of a signed-in user: the account must be active and, when `sessionId` is given, that
 * session still live at `now` (a revocation that committed meanwhile ends the request).
 *
 * @throws DomainError AUTH_REQUIRED otherwise
 */
async function activeAccount(trx: Transaction<DB>, userId: string, now: number, sessionId?: string): Promise<Account> {
  const account = await lockAccount(trx, userId);
  if (account === null || account.view.status !== 'active') throw sessionEnded();
  if (sessionId !== undefined) {
    const live = await trx
      .selectFrom('sessions')
      .select('id')
      .where('id', '=', sessionId)
      .where('expires_at', '>', now)
      .executeTakeFirst();
    if (live === undefined) throw sessionEnded();
  }
  return account;
}

/** The step of the account's secret (pending or enabled) that `code` matches after its last used step, or null. */
function totpStepOf(account: Account, code: string | undefined, now: number, keyring: readonly KeyringEntry[]): number | null {
  if (code === undefined || account.secretEnc === null) return null;
  const secret = base32Decode(openValue(keyring, totpAad(account.view.id), account.secretEnc));
  return matchTotp(secret, code, now, account.lastStep);
}

/**
 * Uses the TOTP `code` up: 2FA enabled (and not waiting for re-enrolment), the code of a step after the last used
 * one, stored as the last used one unless a parallel request stored it (or a later one) first.
 */
async function useTotp(trx: Transaction<DB>, account: Account, code: string | undefined, now: number, keyring: readonly KeyringEntry[]): Promise<boolean> {
  if (!account.view.totpEnabled || account.view.totpReenroll) return false;
  const step = totpStepOf(account, code, now, keyring);
  if (step === null) return false;
  const r = await trx
    .updateTable('staff_users')
    .set({ totp_last_step: step })
    .where('id', '=', account.view.id)
    .where('totp_last_step', '<', step)
    .executeTakeFirst();
  return Number(r.numUpdatedRows) === 1;
}

/** Uses the recovery code `input` (as typed) up: an unused code of the user, marked used. */
async function useRecoveryCode(trx: Transaction<DB>, userId: string, input: string | undefined, now: number): Promise<boolean> {
  const normalized = input === undefined ? null : normalizeRecoveryCode(input);
  if (normalized === null) return false;
  const r = await trx
    .updateTable('staff_recovery_codes')
    .set({ used_at: now })
    .where('user_id', '=', userId)
    .where('code_hash', '=', recoveryCodeHash(userId, normalized))
    .where('used_at', 'is', null)
    .executeTakeFirst();
  return Number(r.numUpdatedRows) > 0;
}

/** Replaces every recovery code of the user with 10 new ones; returns them (the only time they are readable). */
async function replaceRecoveryCodes(trx: Transaction<DB>, userId: string, now: number): Promise<string[]> {
  await trx.deleteFrom('staff_recovery_codes').where('user_id', '=', userId).execute();
  const codes = generateRecoveryCodes(RECOVERY_CODE_COUNT);
  await trx
    .insertInto('staff_recovery_codes')
    .values(
      codes.map((code) => ({
        id: newId(),
        user_id: userId,
        code_hash: recoveryCodeHash(userId, normalizeRecoveryCode(code)!),
        used_at: null,
        created_at: now,
      })),
    )
    .execute();
  return codes;
}

/** Counts one hit of `name` for `subject` in a transaction of its own, committed before anything is checked. */
function count(run: TxRunner, name: BucketName, subject: string, now: number): Promise<Hit> {
  return run((tx) => hit(tx.trx, name, subject, now));
}

/** A verified failure (§7.8: a security event, in a transaction of its own). */
function auditFailure(tx: TxCtx, userId: string, stage: '2fa' | 'recovery' | 'reauth'): Promise<void> {
  return tx.audit({ action: 'auth.login.failed', entity: 'staff_users', entityId: userId, meta: { stage } });
}

/**
 * Verifies `password` against `phc` outside any transaction (S18). A full hash queue (AUTH_BUSY) verified nothing:
 * the hits are given back first (a failure to do so is logged, and the AUTH_BUSY still thrown), as login does.
 */
async function verifyPassword(
  run: TxRunner,
  o: { hasher: PasswordHasher; password: string; phc: string; hits: readonly Hit[]; log?: CoreLogger | undefined },
): Promise<boolean> {
  try {
    return await o.hasher.verify(o.password, o.phc);
  } catch (error) {
    if (isDomainError(error) && error.code === 'AUTH_BUSY') {
      try {
        await run(async (tx) => {
          for (const h of o.hits) await refund(tx.trx, h);
        });
      } catch (failure) {
        o.log?.error('2fa: the rate-limit hits of an attempt the busy hasher never verified were not given back', {
          error: errorFields(failure),
        });
      }
    }
    throw error;
  }
}

// ---------------------------------------------------------------------------------------------------------------
// Enrolment

/**
 * Starts (or restarts) a TOTP enrolment in `tx`: a new secret sealed into `totp_secret_enc` with `totp_enabled = 0`
 * (and `totp_last_step = 0`: no code of it was used yet). Returns the secret in base32 and its `otpauth://` URI
 * (`issuer`, the username as account). `sessionId`: the requesting session, which must still be live.
 *
 * @throws DomainError MFA_ALREADY_ENABLED; AUTH_REQUIRED when the account is not active or the session is gone
 */
export async function beginTotpSetup(
  tx: TxCtx,
  userId: string,
  o: { keyring: readonly KeyringEntry[]; issuer: string; sessionId?: string },
): Promise<TwoFactorSetupResponse> {
  const account = await activeAccount(tx.trx, userId, tx.now, o.sessionId);
  if (account.view.totpEnabled) throw alreadyEnabled();
  const secret = generateTotpSecret();
  const text = base32Encode(secret);
  await tx.trx
    .updateTable('staff_users')
    .set({
      totp_secret_enc: sealValue(o.keyring, totpAad(userId), text),
      totp_enabled: 0,
      totp_last_step: 0,
      updated_at: tx.now,
      updated_by: userId,
    })
    .where('id', '=', userId)
    .execute();
  return { secret: text, otpauthUri: otpauthUri({ issuer: o.issuer, account: account.view.username, secret }) };
}

/**
 * Switches TOTP on with a code of the secret beginTotpSetup stored (see the top of this file): `2fa:user` is counted
 * first in a transaction of its own (wrong codes count); then, in one transaction, the code must match and the
 * replay-guarded UPDATE sets `totp_enabled = 1`, `totp_last_step` and `totp_reenroll = 0`; the recovery codes are
 * replaced, every session and remember-me token of the user is revoked (the current one included, S11), the
 * `2fa:user` hit is given back and `auth.2fa.enable` is audited. `sessionId`: the requesting session, which must
 * still be live.
 *
 * @returns the 10 new recovery codes
 * @throws DomainError AUTH_TOO_MANY_ATTEMPTS (`meta.retryAfterS`), AUTH_MFA_INVALID, MFA_ALREADY_ENABLED,
 *   MFA_NOT_ENABLED (no setup begun), AUTH_REQUIRED (the account is not active or the session is gone)
 */
export async function enableTotp(
  run: TxRunner,
  userId: string,
  code: string,
  o: { keyring: readonly KeyringEntry[]; now: number; sessionId?: string },
): Promise<RecoveryCodesResponse> {
  const h = await count(run, '2fa:user', userId, o.now);
  if (!h.allowed) throw tooManyAttempts(h.retryAfterS);
  return run(async (tx) => {
    const { trx } = tx;
    const account = await activeAccount(trx, userId, o.now, o.sessionId);
    if (account.view.totpEnabled) throw alreadyEnabled();
    if (account.secretEnc === null) throw notEnabled('Mulai penyiapan 2FA dulu / Start the 2FA setup first');
    const step = totpStepOf(account, code, o.now, o.keyring);
    if (step === null) throw mfaInvalid();
    const r = await trx
      .updateTable('staff_users')
      .set({ totp_enabled: 1, totp_last_step: step, totp_reenroll: 0, updated_at: o.now, updated_by: userId })
      .where('id', '=', userId)
      .where('totp_enabled', '=', 0)
      .where('totp_last_step', '<', step)
      .executeTakeFirst();
    if (Number(r.numUpdatedRows) !== 1) throw mfaInvalid();
    const codes = await replaceRecoveryCodes(trx, userId, o.now);
    await revokeSubject(trx, userId);
    await refund(trx, h);
    await tx.audit({ action: 'auth.2fa.enable', entity: 'staff_users', entityId: userId });
    return { codes };
  });
}

// ---------------------------------------------------------------------------------------------------------------
// The second factor of a sign-in

/** What {@link checkSecondFactor} takes. */
export interface SecondFactorInput {
  /** The pre-2FA session the code is for. */
  session: SessionView;
  userId: string;
  /** Exactly one of `code` (TOTP) and `recoveryCode` (as typed). */
  code?: string | undefined;
  recoveryCode?: string | undefined;
  now: number;
  keyring: readonly KeyringEntry[];
  /**
   * The caller's work once the code passed, in the transaction that used it up (so that a failure there leaves the
   * code unused), with the account as read under the row lock. It may run more than once (R37: a re-run
   * transaction); only the last run committed.
   */
  onPass?: (tx: TxCtx, pass: { method: SecondFactor; user: StaffAuthView }) => Promise<void>;
}

/**
 * Checks a second factor for `session` (see the top of this file):
 *
 * - `2fa:session` (subject: the session id) and `2fa:user` (`recovery:user` for a recovery code), each counted in a
 *   transaction of its own before anything is checked; a refused `2fa:session` deletes the session → AUTH_REQUIRED,
 *   a refused user bucket → AUTH_TOO_MANY_ATTEMPTS;
 * - one transaction: the user's row locked, the account active and the session live (else AUTH_REQUIRED), the code
 *   used up, then `onPass`, and a TOTP code's `2fa:user` hit given back;
 * - a wrong code → `auth.login.failed {stage: '2fa' | 'recovery'}` in a transaction of its own → AUTH_MFA_INVALID;
 *   when this failure brought `2fa:session` to its limit, that transaction also deletes the session (S10) →
 *   AUTH_REQUIRED.
 *
 * @throws TypeError unless exactly one of `code` and `recoveryCode` is given
 * @throws DomainError AUTH_REQUIRED, AUTH_TOO_MANY_ATTEMPTS (`meta.retryAfterS`), AUTH_MFA_INVALID
 */
export async function checkSecondFactor(run: TxRunner, o: SecondFactorInput): Promise<SecondFactor> {
  if ((o.code === undefined) === (o.recoveryCode === undefined)) {
    throw new TypeError('checkSecondFactor: give exactly one of code and recoveryCode');
  }
  const method: SecondFactor = o.code !== undefined ? 'totp' : 'recovery';

  const sessionHit = await count(run, '2fa:session', o.session.id, o.now);
  if (!sessionHit.allowed) {
    await run(async (tx) => {
      await lockStaffRow(tx.trx, o.userId);
      await revokeSession(tx.trx, o.session.id);
    });
    throw sessionEnded();
  }
  const userHit = await count(run, method === 'totp' ? '2fa:user' : 'recovery:user', o.userId, o.now);
  if (!userHit.allowed) throw tooManyAttempts(userHit.retryAfterS);

  try {
    await run(async (tx) => {
      const account = await activeAccount(tx.trx, o.userId, o.now, o.session.id);
      const passed =
        method === 'totp'
          ? await useTotp(tx.trx, account, o.code, o.now, o.keyring)
          : await useRecoveryCode(tx.trx, o.userId, o.recoveryCode, o.now);
      if (!passed) throw new Refused(mfaInvalid());
      await o.onPass?.(tx, { method, user: account.view });
      // A right TOTP code was no guess: its hit goes back, as a login's do. Used recovery codes keep counting.
      if (method === 'totp') await refund(tx.trx, userHit);
    });
  } catch (error) {
    if (!(error instanceof Refused)) throw error;
    // S10: the failure that brings the session's bucket to its limit ends the pre-2FA session, and the answer says so.
    const ends = sessionHit.count >= BUCKETS['2fa:session'].limit;
    await run(async (tx) => {
      if (ends) await lockStaffRow(tx.trx, o.userId);
      await auditFailure(tx, o.userId, method === 'totp' ? '2fa' : 'recovery');
      if (ends) await revokeSession(tx.trx, o.session.id);
    });
    throw ends ? sessionEnded() : error.error;
  }
  return method;
}

/** What {@link verifySecondFactor} takes. */
export interface VerifyInput {
  /** The pre-2FA session of the request. */
  session: SessionView;
  userId: string;
  /** The session's stage (step 7); a `full` session has nothing to verify (the route answers it). */
  stage: Exclude<SessionStage, 'full'>;
  /** Exactly one of `code` (TOTP, stage `mfa`) and `recoveryCode` (stage `mfa` or `recovery`). */
  code?: string | undefined;
  recoveryCode?: string | undefined;
  /** Issue a remember-me token bound to the passed second factor. */
  remember: boolean;
  now: number;
  keyring: readonly KeyringEntry[];
  /** The idle limit of a full session (`security.session_idle_minutes`), in ms. */
  idleMs: number;
  /** The install's decoded 32-byte sessionKey (D45): the device cookie's HMAC key. */
  sessionKey: Uint8Array;
  /** The request's `altis_dev` cookie. */
  deviceCookie?: string | undefined;
}

/** What a passed `auth/2fa/verify` comes to. */
export interface VerifyOutcome {
  /** `full` once the login completed; `mfa_setup` after a recovery code in stage `recovery` (D15). */
  stage: SessionStage;
  mustChangePassword: boolean;
  /** The rotated, full session (its token is the new `altis_sid`) once the login completed; null otherwise. */
  session: SessionToken | null;
  /** The new `altis_dev` value once the login completed (D21); null otherwise. */
  deviceCookie: string | null;
  /** The `altis_rm` value when `remember` was asked for and the login completed; null otherwise. */
  rememberCookie: string | null;
}

/**
 * The second factor of a sign-in (`auth/2fa/verify`, §7.1):
 *
 * - stage `mfa_setup` → AUTH_MFA_REQUIRED (2FA must be set up first; nothing is counted);
 * - stage `recovery` takes a recovery code only: a TOTP code → AUTH_MFA_INVALID (nothing is counted);
 * - otherwise {@link checkSecondFactor}, and in the transaction that used the code up:
 *   - the account waits for re-enrolment (`totp_reenroll`, stage `recovery`): the secret, `totp_enabled`,
 *     `totp_reenroll`, `totp_last_step` and the remaining recovery codes are cleared and `mfa_required = 1` is set
 *     (D15: enrolling again becomes compulsory); every other session and remember-me token of the user is revoked
 *     (a 2FA reset, audited as `auth.2fa.disable {reason: 'reenroll'}`); the session stays, now in stage `mfa_setup`;
 *   - otherwise the login completes: with `remember`, a remember-me token (`mfa_bound = 1`) first, then the session
 *     rotated to a full one that records the token (B9) at the account's `authz_version`; `last_login_at`; and
 *     `auth.login.success {stage: '2fa' | 'recovery'}`. The device cookie is renewed (D21).
 *
 * @throws DomainError AUTH_MFA_REQUIRED, and whatever checkSecondFactor throws
 */
export async function verifySecondFactor(run: TxRunner, o: VerifyInput): Promise<VerifyOutcome> {
  if (o.stage === 'mfa_setup') {
    throw new DomainError('AUTH_MFA_REQUIRED', { detail: 'Siapkan 2FA terlebih dahulu / Set up 2FA first' });
  }
  if (o.stage === 'recovery' && o.code !== undefined) throw mfaInvalid();

  let done: { outcome: Omit<VerifyOutcome, 'deviceCookie'>; usernameKey: string } | undefined;
  await checkSecondFactor(run, {
    session: o.session,
    userId: o.userId,
    code: o.code,
    recoveryCode: o.recoveryCode,
    now: o.now,
    keyring: o.keyring,
    onPass: async (tx, { method, user }) => {
      const { trx } = tx;
      if (user.totpReenroll) {
        // Only a recovery code gets here: useTotp refuses every code while the secret waits for re-enrolment.
        await trx
          .updateTable('staff_users')
          .set({
            totp_secret_enc: null,
            totp_enabled: 0,
            totp_reenroll: 0,
            totp_last_step: 0,
            mfa_required: 1,
            updated_at: o.now,
            updated_by: o.userId,
          })
          .where('id', '=', o.userId)
          .execute();
        await trx.deleteFrom('staff_recovery_codes').where('user_id', '=', o.userId).execute();
        await revokeSubject(trx, o.userId, { exceptSessionId: o.session.id });
        // The old 2FA is gone (a 2FA reset): audited with the reason (controller ruling on Task 16's review).
        await tx.audit({ action: 'auth.2fa.disable', entity: 'staff_users', entityId: o.userId, meta: { reason: 'reenroll' } });
        done = {
          outcome: { stage: 'mfa_setup', mustChangePassword: user.mustChangePassword, session: null, rememberCookie: null },
          usernameKey: user.usernameKey,
        };
        return;
      }
      const remember = o.remember ? await issueRememberToken(trx, { subjectId: o.userId, mfaBound: true, now: o.now }) : null;
      const session = await rotateSession(trx, o.session, {
        now: o.now,
        idleMs: o.idleMs,
        mfaPassed: true,
        authzVersion: user.authzVersion,
        ...(remember === null ? {} : { rememberSelector: remember.selector }),
      });
      await trx.updateTable('staff_users').set({ last_login_at: o.now }).where('id', '=', o.userId).execute();
      await tx.audit({
        action: 'auth.login.success',
        entity: 'staff_users',
        entityId: o.userId,
        meta: { stage: method === 'totp' ? '2fa' : 'recovery' },
      });
      done = {
        outcome: { stage: 'full', mustChangePassword: user.mustChangePassword, session, rememberCookie: remember?.cookie ?? null },
        usernameKey: user.usernameKey,
      };
    },
  });
  if (done === undefined) throw new TypeError('verifySecondFactor: the second factor passed without an outcome');
  const { outcome, usernameKey } = done;
  return {
    ...outcome,
    deviceCookie: outcome.stage === 'full' ? deviceCookieAfterLogin(o.sessionKey, o.deviceCookie, usernameKey) : null,
  };
}

// ---------------------------------------------------------------------------------------------------------------
// Switching 2FA off, new recovery codes

/**
 * Switches TOTP off in `tx` (see the top of this file), after the caller verified the password outside any
 * transaction (S18) and counted the attempt: the account is read again under the row lock, its password hash must
 * still be `passwordHash` (the one verified), 2FA must be enabled and not required (by the user flag or a role), and
 * `code` must be a TOTP code after the last used one. Then the secret, the flags, `totp_last_step` and the recovery
 * codes are cleared, every session and remember-me token of the user is revoked (the current one included, S11) and
 * `auth.2fa.disable` is audited. `sessionId`: the requesting session, which must still be live.
 *
 * @throws DomainError AUTH_INVALID_CREDENTIALS (the password changed meanwhile), MFA_NOT_ENABLED,
 *   MFA_REQUIRED_BY_POLICY, AUTH_MFA_INVALID, AUTH_REQUIRED (the account is not active or the session is gone)
 */
export async function disableTotp(
  tx: TxCtx,
  userId: string,
  o: { code: string; passwordHash: string; keyring: readonly KeyringEntry[]; sessionId?: string },
): Promise<void> {
  const { trx } = tx;
  const account = await activeAccount(trx, userId, tx.now, o.sessionId);
  if (account.passwordHash !== o.passwordHash) throw wrongPassword();
  if (!account.view.totpEnabled) throw notEnabled();
  const grants = await loadGrants(trx, userId);
  if (account.view.mfaRequired || grants.roleMfaRequired) throw requiredByPolicy();
  const step = account.view.totpReenroll ? null : totpStepOf(account, o.code, tx.now, o.keyring);
  if (step === null) throw mfaInvalid();
  const r = await trx
    .updateTable('staff_users')
    .set({
      totp_secret_enc: null,
      totp_enabled: 0,
      totp_reenroll: 0,
      totp_last_step: 0,
      updated_at: tx.now,
      updated_by: userId,
    })
    .where('id', '=', userId)
    .where('totp_last_step', '<', step)
    .executeTakeFirst();
  if (Number(r.numUpdatedRows) !== 1) throw mfaInvalid();
  await trx.deleteFrom('staff_recovery_codes').where('user_id', '=', userId).execute();
  await revokeSubject(trx, userId);
  await tx.audit({ action: 'auth.2fa.disable', entity: 'staff_users', entityId: userId });
}

/** What {@link disableTotpWithCredentials} takes. */
export interface DisableTotpInput {
  userId: string;
  /** The requesting session (it must still be live; it ends with every other one). */
  sessionId: string;
  password: string;
  code: string;
  now: number;
  hasher: PasswordHasher;
  keyring: readonly KeyringEntry[];
  /** For a failure no response reports. */
  log?: CoreLogger | undefined;
}

/**
 * `auth/2fa/disable` (§7.1: "Menonaktifkan 2FA butuh sandi + kode"): 2FA must be enabled (MFA_NOT_ENABLED) and not
 * required (MFA_REQUIRED_BY_POLICY), which is told before anything is counted; then `2fa:user` is counted in a
 * transaction of its own, the password verified outside any transaction (S18) and {@link disableTotp} run. A wrong
 * password or code is audited as `auth.login.failed {stage: 'reauth'}` (a confirmation of a signed-in user) in a
 * transaction of its own; a success gives the `2fa:user` hit back in its transaction.
 *
 * @throws DomainError MFA_NOT_ENABLED, MFA_REQUIRED_BY_POLICY, AUTH_TOO_MANY_ATTEMPTS (`meta.retryAfterS`),
 *   AUTH_INVALID_CREDENTIALS, AUTH_MFA_INVALID, AUTH_REQUIRED; AUTH_BUSY when the hash queue is full
 */
export async function disableTotpWithCredentials(run: TxRunner, o: DisableTotpInput): Promise<void> {
  const found = await run(async (tx) => {
    const view = await loadStaffAuthView(tx.trx, o.userId);
    const row = await tx.trx.selectFrom('staff_users').select('password_hash').where('id', '=', o.userId).executeTakeFirst();
    if (view === null || row === undefined) return null;
    return { view, roleMfaRequired: (await loadGrants(tx.trx, o.userId)).roleMfaRequired, passwordHash: row.password_hash };
  });
  if (found === null || found.view.status !== 'active') throw sessionEnded();
  if (!found.view.totpEnabled) throw notEnabled();
  if (found.view.mfaRequired || found.roleMfaRequired) throw requiredByPolicy();

  const h = await count(run, '2fa:user', o.userId, o.now);
  if (!h.allowed) throw tooManyAttempts(h.retryAfterS);
  const ok = await verifyPassword(run, { hasher: o.hasher, password: o.password, phc: found.passwordHash, hits: [h], log: o.log });
  if (!ok) {
    await run((tx) => auditFailure(tx, o.userId, 'reauth'));
    throw wrongPassword();
  }
  try {
    await run(async (tx) => {
      await disableTotp(tx, o.userId, { code: o.code, passwordHash: found.passwordHash, keyring: o.keyring, sessionId: o.sessionId });
      await refund(tx.trx, h);
    });
  } catch (error) {
    if (isDomainError(error) && (error.code === 'AUTH_MFA_INVALID' || error.code === 'AUTH_INVALID_CREDENTIALS')) {
      await run((tx) => auditFailure(tx, o.userId, 'reauth'));
    }
    throw error;
  }
}

/**
 * Replaces the user's recovery codes with 10 new ones in `tx` and audits `auth.2fa.recovery_codes` (the route needs
 * a fresh re-authentication, §7.3). `sessionId`: the requesting session, which must still be live.
 *
 * @returns the new codes (the only time they are readable)
 * @throws DomainError MFA_NOT_ENABLED; AUTH_REQUIRED when the account is not active or the session is gone
 */
export async function regenerateRecoveryCodes(tx: TxCtx, userId: string, o: { sessionId?: string } = {}): Promise<RecoveryCodesResponse> {
  const account = await activeAccount(tx.trx, userId, tx.now, o.sessionId);
  if (!account.view.totpEnabled) throw notEnabled();
  const codes = await replaceRecoveryCodes(tx.trx, userId, tx.now);
  await tx.audit({ action: 'auth.2fa.recovery_codes', entity: 'staff_users', entityId: userId });
  return { codes };
}

// ---------------------------------------------------------------------------------------------------------------
// Re-authentication

/** What {@link reauthenticate} takes. */
export interface ReauthInput {
  /** The session to mark (the request's). */
  session: SessionView;
  userId: string;
  password: string;
  /** Required when 2FA is enabled. */
  code?: string | undefined;
  now: number;
  hasher: PasswordHasher;
  keyring: readonly KeyringEntry[];
  /** For a failure no response reports. */
  log?: CoreLogger | undefined;
}

/**
 * Re-authenticates the user of `session` (§7.3): `reauth:session` is counted in a transaction of its own; the
 * password is verified outside any transaction (S18); then, in one transaction with the user's row locked, the
 * password hash must still be the verified one, a TOTP code is used up when 2FA is enabled, `markReauth` sets
 * `reauth_at = now` and the `reauth:session` hit is given back. A wrong password or code → `auth.login.failed
 * {stage: 'reauth'}` in a transaction of its own.
 *
 * @throws DomainError AUTH_TOO_MANY_ATTEMPTS (`meta.retryAfterS`), AUTH_INVALID_CREDENTIALS, AUTH_MFA_INVALID,
 *   AUTH_REQUIRED (the account is not active or the session is gone); AUTH_BUSY when the hash queue is full
 */
export async function reauthenticate(run: TxRunner, o: ReauthInput): Promise<void> {
  const h = await count(run, 'reauth:session', o.session.id, o.now);
  if (!h.allowed) throw tooManyAttempts(h.retryAfterS);
  const phc = await run(async (tx) => {
    const row = await tx.trx.selectFrom('staff_users').select('password_hash').where('id', '=', o.userId).executeTakeFirst();
    return row?.password_hash ?? null;
  });
  if (phc === null) throw sessionEnded();
  const ok = await verifyPassword(run, { hasher: o.hasher, password: o.password, phc, hits: [h], log: o.log });
  if (!ok) {
    await run((tx) => auditFailure(tx, o.userId, 'reauth'));
    throw wrongPassword();
  }
  try {
    await run(async (tx) => {
      const account = await activeAccount(tx.trx, o.userId, o.now, o.session.id);
      if (account.passwordHash !== phc) throw new Refused(wrongPassword());
      if (account.view.totpEnabled && !(await useTotp(tx.trx, account, o.code, o.now, o.keyring))) {
        throw new Refused(mfaInvalid());
      }
      await markReauth(tx.trx, o.session.id, o.now);
      await refund(tx.trx, h);
    });
  } catch (error) {
    if (!(error instanceof Refused)) throw error;
    await run((tx) => auditFailure(tx, o.userId, 'reauth'));
    throw error.error;
  }
}
