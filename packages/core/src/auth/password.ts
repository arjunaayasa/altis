import type { DB } from '@altis/db';
import { DomainError, isDomainError, isLocale, normalizeKey, type Locale } from '@altis/shared';
import type { Kysely, Transaction } from 'kysely';
import { errorFields, type CoreLogger, type TxCtx, type TxRunner } from '../context.js';
import type { PasswordHasher } from '../crypto/password.js';
import { checkPasswordPolicy } from '../crypto/policy.js';
import { randomToken, sha256hex } from '../crypto/tokens.js';
import { hit, refund, type Hit } from './rate-limit.js';
import { revokeSessionLineage, revokeSubject, rotatedInto } from './sessions.js';
import { lockStaffRow } from './staff.js';

// A staff user's own account (spec §7.1 "Reset sandi", "Pencabutan"; §13.5 "Profil saya"; Task 18): changing the
// password, the password reset by mail, the profile, and revoking one of one's own sessions.
//
// - changePassword: the policy first (nothing is counted for a password that could never be set); `reauth:session`
//   counted in a transaction of its own; the current password verified and the new one hashed outside any transaction
//   (S18); a wrong current password → `auth.login.failed {stage: 'reauth'}` in a transaction of its own and
//   AUTH_INVALID_CREDENTIALS. Then one transaction sets the hash with `must_change_password = 0`, deletes the user's
//   password-reset tokens, revokes every other session and every remember-me token (the session changing its own
//   password is §7.1's one exception; it stays signed in without remember-me), gives the hit back (a right password
//   was no guess) and audits `auth.password.change`. A request sent with a token rotated away and still in its 30 s
//   grace (another tab, a parallel request) keeps the session it was rotated into too (rotatedInto): the browser's
//   cookie already names that one.
// - The reset (§7.1): startPasswordReset stores a 256-bit token as its SHA-256 for 30 minutes for an active account
//   with that e-mail key (the caller counts `forgot:email:5m` and `forgot:email:1d` first, and starts it after its
//   response, with the mail); completePasswordReset uses the token up once (`UPDATE … WHERE used_at IS NULL AND
//   expires_at > now`), sets the hash the caller prepared outside the transaction (S18) with
//   `must_change_password = 0`, deletes the user's other reset tokens, revokes every session and remember-me token,
//   and audits `auth.password.reset` with that user as the actor. It creates no session and leaves `status` alone
//   (a disabled account stays disabled) and 2FA too (the next login still asks for the code).
// - updateOwnProfile: name and language, audited as `auth.profile.update {fields}`.
// - revokeOwnSession: one of the user's own sessions with the rest of its sign-in (revokeSessionLineage: the sessions
//   it was rotated from and into, each with its remember-me token, B9); another user's session is NOT_FOUND.
//
// Every transaction here that changes the password or revokes sessions starts with the lock on the user's row
// (lockStaffRow, as its first statement; Tasks 15/16): a login or a 2FA verification that is issuing a session then
// either committed before (and its session is revoked here) or waits for this transaction and reads the new password
// hash (login's transaction B refuses a hash other than the one it verified). On MySQL/MariaDB the lock comes before
// the first plain read, so the reads that follow see the latest commit (REPEATABLE READ).

/** How long a password-reset token is good for (§7.1: 30 minutes). */
export const PASSWORD_RESET_TTL_MS = 1_800_000;

const STAFF = 'staff';
/** A reset token: randomToken(32), 43 base64url characters. */
const TOKEN = /^[A-Za-z0-9_-]{43}$/;

const tooManyAttempts = (retryAfterS: number): DomainError =>
  new DomainError('AUTH_TOO_MANY_ATTEMPTS', {
    detail: 'Terlalu banyak percobaan; coba lagi nanti / Too many attempts; try again later',
    meta: { retryAfterS },
  });

const sessionEnded = (): DomainError =>
  new DomainError('AUTH_REQUIRED', { detail: 'Sesi sudah berakhir; silakan masuk lagi / The session has ended; sign in again' });

const wrongPassword = (): DomainError =>
  new DomainError('AUTH_INVALID_CREDENTIALS', { detail: 'Kata sandi saat ini salah / The current password is wrong' });

const resetTokenInvalid = (): DomainError =>
  new DomainError('AUTH_RESET_TOKEN_INVALID', {
    detail:
      'Tautan atur ulang tidak dikenal, kedaluwarsa, atau sudah dipakai; minta tautan baru / ' +
      'The reset link is unknown, expired or already used; ask for a new one',
  });

/** A refusal inside a transaction: thrown to roll it back, then audited and `error` thrown. */
class Refused extends Error {
  constructor(readonly error: DomainError) {
    super(error.code);
    this.name = 'Refused';
  }
}

/** A failed confirmation of a signed-in user (§7.8: a security event, in a transaction of its own). */
function auditReauthFailure(tx: TxCtx, userId: string): Promise<void> {
  return tx.audit({ action: 'auth.login.failed', entity: 'staff_users', entityId: userId, meta: { stage: 'reauth' } });
}

/** Deletes every password-reset token of the staff user `userId` (or all but `exceptHash`). */
async function deleteResetTokens(trx: Transaction<DB>, userId: string, exceptHash?: string): Promise<void> {
  let q = trx.deleteFrom('password_resets').where('subject_type', '=', STAFF).where('subject_id', '=', userId);
  if (exceptHash !== undefined) q = q.where('token_hash', '<>', exceptHash);
  await q.execute();
}

// ---------------------------------------------------------------------------------------------------------------
// Changing one's own password

/** What {@link changePassword} takes. */
export interface ChangePasswordInput {
  userId: string;
  /**
   * The requesting session: it must still be live, and it is the one that stays (with the session it was rotated
   * into, when it is a rotated-away one in its grace).
   */
  sessionId: string;
  current: string;
  next: string;
  now: number;
  hasher: PasswordHasher;
  /** `security.password_min_length`. */
  minLength: number;
  /** For a failure no response reports. */
  log?: CoreLogger | undefined;
}

/**
 * Changes the password of `userId` (see the top of this file). Every transaction goes through `run` (M38).
 *
 * @throws DomainError PASSWORD_TOO_WEAK (before anything is counted), AUTH_TOO_MANY_ATTEMPTS (`meta.retryAfterS`),
 *   AUTH_INVALID_CREDENTIALS (also when the password changed while this one was being verified), AUTH_REQUIRED (the
 *   account is not active or the session is gone); AUTH_BUSY when the hash queue is full (the hit is given back)
 */
export async function changePassword(run: TxRunner, o: ChangePasswordInput): Promise<void> {
  checkPasswordPolicy(o.next, { minLength: o.minLength });
  const h = await run((tx) => hit(tx.trx, 'reauth:session', o.sessionId, o.now));
  if (!h.allowed) throw tooManyAttempts(h.retryAfterS);
  const phc = await run(async (tx) => {
    const row = await tx.trx.selectFrom('staff_users').select('password_hash').where('id', '=', o.userId).executeTakeFirst();
    return row?.password_hash ?? null;
  });
  if (phc === null) throw sessionEnded();

  // Outside any transaction (S18): verify the current password, then hash the new one.
  const nextHash = await hashing(run, [h], o.log, async () =>
    (await o.hasher.verify(o.current, phc)) ? o.hasher.hash(o.next) : null,
  );
  if (nextHash === null) {
    await run((tx) => auditReauthFailure(tx, o.userId));
    throw wrongPassword();
  }

  try {
    await run(async (tx) => {
      const { trx } = tx;
      await lockStaffRow(trx, o.userId); // first: this transaction revokes sessions
      const row = await trx.selectFrom('staff_users').select(['password_hash', 'status']).where('id', '=', o.userId).executeTakeFirst();
      if (row === undefined || row.status !== 'active') throw sessionEnded();
      const live = await trx
        .selectFrom('sessions')
        .select('id')
        .where('id', '=', o.sessionId)
        .where('subject_type', '=', STAFF)
        .where('subject_id', '=', o.userId)
        .where('expires_at', '>', o.now)
        .executeTakeFirst();
      if (live === undefined) throw sessionEnded();
      // Changed (another change, a reset) while this one was being verified: the verified password is not current.
      if (row.password_hash !== phc) throw new Refused(wrongPassword());
      await trx
        .updateTable('staff_users')
        .set((eb) => ({
          password_hash: nextHash,
          must_change_password: 0,
          version: eb('version', '+', 1),
          updated_at: o.now,
          updated_by: o.userId,
        }))
        .where('id', '=', o.userId)
        .execute();
      await deleteResetTokens(trx, o.userId);
      // The requesting session stays and, when its token was rotated away (in its grace), so does the session it was
      // rotated into: the browser holds that one's token (Review Focus 3).
      await revokeSubject(trx, o.userId, { exceptSessionId: [o.sessionId, ...(await rotatedInto(trx, o.sessionId))] });
      await refund(trx, h);
      await tx.audit({ action: 'auth.password.change', entity: 'staff_users', entityId: o.userId });
    });
  } catch (error) {
    if (!(error instanceof Refused)) throw error;
    await run((tx) => auditReauthFailure(tx, o.userId));
    throw error.error;
  }
}

/**
 * Runs `work` (scrypt, outside any transaction). A full hash queue (AUTH_BUSY) verified nothing: the hits are given
 * back first (a failure to do so is logged, and the AUTH_BUSY still thrown), as login and reauth do.
 */
async function hashing<T>(run: TxRunner, hits: readonly Hit[], log: CoreLogger | undefined, work: () => Promise<T>): Promise<T> {
  try {
    return await work();
  } catch (error) {
    if (isDomainError(error) && error.code === 'AUTH_BUSY') {
      try {
        await run(async (tx) => {
          for (const one of hits) await refund(tx.trx, one);
        });
      } catch (failure) {
        log?.error('password change: the rate-limit hit of an attempt the busy hasher never verified was not given back', {
          error: errorFields(failure),
        });
      }
    }
    throw error;
  }
}

// ---------------------------------------------------------------------------------------------------------------
// The password reset by mail

/** What a started reset gives the caller for the mail; `token` is in it only (the database keeps its hash). */
export interface PasswordResetStart {
  userId: string;
  name: string;
  username: string;
  /** The address the account holds (as typed when it was set): where the mail goes, never the one requested. */
  email: string;
  /** null: the library's language. */
  locale: Locale | null;
  /** 256 bits, 43 base64url characters: the `#token=` of the link. */
  token: string;
}

/**
 * Starts a password reset for `email` in `trx`: when an **active** staff user holds its key (`normalizeKey(email)`),
 * a `password_resets` row (`token_hash = sha256hex(token)`, expiring PASSWORD_RESET_TTL_MS after `now`) and what the
 * mail needs; otherwise null. Earlier tokens of the user stay valid until they expire or one is used.
 *
 * The caller counts `forgot:email:5m` and `forgot:email:1d` (subject `normalizeKey(email)`) in a transaction of its
 * own first and answers; it runs this after its response (D18), then sends the mail, so that the answer takes the
 * same work and time whether or not the address belongs to an account (Review Focus 4).
 */
export async function startPasswordReset(trx: Transaction<DB>, o: { email: string; now: number }): Promise<PasswordResetStart | null> {
  const user = await trx
    .selectFrom('staff_users')
    .select(['id', 'name', 'username_display', 'email_display', 'locale'])
    .where('email_key', '=', normalizeKey(o.email))
    .where('status', '=', 'active')
    .executeTakeFirst();
  if (user === undefined || user.email_display === null) return null;
  const token = randomToken(32);
  await trx
    .insertInto('password_resets')
    .values({
      token_hash: sha256hex(token),
      subject_type: STAFF,
      subject_id: user.id,
      expires_at: o.now + PASSWORD_RESET_TTL_MS,
      used_at: null,
    })
    .execute();
  return {
    userId: user.id,
    name: user.name,
    username: user.username_display,
    email: user.email_display,
    locale: user.locale !== null && isLocale(user.locale) ? user.locale : null,
    token,
  };
}

/**
 * The staff user whose unused, unexpired reset token `token` is at `now`. The reset route reads it before it hashes
 * the new password (so that a dead link costs no scrypt) and runs {@link completePasswordReset} as that user.
 *
 * @throws DomainError AUTH_RESET_TOKEN_INVALID for a token that is malformed, unknown, used or expired
 */
export async function passwordResetSubject(db: Kysely<DB> | Transaction<DB>, token: string, now: number): Promise<string> {
  if (typeof token !== 'string' || !TOKEN.test(token)) throw resetTokenInvalid();
  const row = await db
    .selectFrom('password_resets')
    .select('subject_id')
    .where('token_hash', '=', sha256hex(token))
    .where('subject_type', '=', STAFF)
    .where('used_at', 'is', null)
    .where('expires_at', '>', now)
    .executeTakeFirst();
  if (row === undefined) throw resetTokenInvalid();
  return row.subject_id;
}

/**
 * Completes a password reset in `tx` (see the top of this file), with `passwordHash` hashed by the caller outside the
 * transaction after checking the policy (S18). Run it as the token's user: `tx.actor = {type: 'staff', id:
 * passwordResetSubject(...)}`, so the audit names that user (§7.1) and the transaction's first statement locks that
 * user's row. The token must belong to that user, be unused and not have expired at `now`; it is marked used
 * (`used_at = now`) by the UPDATE that checks it.
 *
 * @throws DomainError AUTH_RESET_TOKEN_INVALID
 * @throws TypeError when `tx.actor` is not a staff user
 */
export async function completePasswordReset(tx: TxCtx, o: { token: string; passwordHash: string; now: number }): Promise<{ userId: string }> {
  const userId = tx.actor.type === 'staff' ? tx.actor.id : null;
  if (userId === null) {
    throw new TypeError("completePasswordReset: run it as the token's user (tx.actor = {type: 'staff', id: passwordResetSubject(...)})");
  }
  const { trx } = tx;
  await lockStaffRow(trx, userId); // first: this transaction changes the password and revokes sessions
  if (typeof o.token !== 'string' || !TOKEN.test(o.token)) throw resetTokenInvalid();
  const tokenHash = sha256hex(o.token);
  const used = await trx
    .updateTable('password_resets')
    .set({ used_at: o.now })
    .where('token_hash', '=', tokenHash)
    .where('subject_type', '=', STAFF)
    .where('subject_id', '=', userId)
    .where('used_at', 'is', null)
    .where('expires_at', '>', o.now)
    .executeTakeFirst();
  if (Number(used.numUpdatedRows) !== 1) throw resetTokenInvalid();
  const changed = await trx
    .updateTable('staff_users')
    .set((eb) => ({
      password_hash: o.passwordHash,
      must_change_password: 0,
      version: eb('version', '+', 1),
      updated_at: o.now,
      updated_by: userId,
    }))
    .where('id', '=', userId)
    .executeTakeFirst();
  if (Number(changed.numUpdatedRows) !== 1) throw resetTokenInvalid(); // the account is gone
  await deleteResetTokens(trx, userId, tokenHash);
  await revokeSubject(trx, userId);
  await tx.audit({ action: 'auth.password.reset', entity: 'staff_users', entityId: userId });
  return { userId };
}

// ---------------------------------------------------------------------------------------------------------------
// The profile and one's own sessions

/** What {@link updateOwnProfile} changes; a field left out keeps its value. */
export interface ProfilePatch {
  name?: string | undefined;
  /** null: the library's language. */
  locale?: Locale | null | undefined;
}

/**
 * Sets the name and language of `userId` in `tx` (validated by the caller: `personNameField`, `localeField`) and
 * audits `auth.profile.update {fields}` (the names of the fields whose value changed; never the values). A change
 * bumps `version`, so that an admin's edit made from an older read is refused (S13). The account must be active.
 *
 * @throws DomainError AUTH_REQUIRED when the account is not active
 */
export async function updateOwnProfile(tx: TxCtx, userId: string, patch: ProfilePatch): Promise<void> {
  const { trx, now } = tx;
  const row = await trx.selectFrom('staff_users').select(['name', 'locale', 'status']).where('id', '=', userId).executeTakeFirst();
  if (row === undefined || row.status !== 'active') throw sessionEnded();
  const set: { name?: string; locale?: string | null } = {};
  const fields: string[] = [];
  if (patch.name !== undefined && patch.name !== row.name) {
    set.name = patch.name;
    fields.push('name');
  }
  if (patch.locale !== undefined && patch.locale !== row.locale) {
    set.locale = patch.locale;
    fields.push('locale');
  }
  if (fields.length > 0) {
    await trx
      .updateTable('staff_users')
      .set((eb) => ({ ...set, version: eb('version', '+', 1), updated_at: now, updated_by: userId }))
      .where('id', '=', userId)
      .execute();
  }
  await tx.audit({ action: 'auth.profile.update', entity: 'staff_users', entityId: userId, meta: { fields } });
}

/**
 * Revokes the session `sessionId` of `userId` in `tx` with the rest of its sign-in (revokeSessionLineage, B9) and
 * audits `auth.session.revoke {revoked}` (the number of sessions deleted). The user's row is locked first.
 *
 * @returns how many sessions went, and whether `currentSessionId` (the requesting session) is among them
 * @throws DomainError NOT_FOUND when there is no such session of that user (another user's id included)
 */
export async function revokeOwnSession(
  tx: TxCtx,
  o: { userId: string; sessionId: string; currentSessionId?: string },
): Promise<{ revoked: number; currentEnded: boolean }> {
  const { trx } = tx;
  await lockStaffRow(trx, o.userId); // first: this transaction revokes sessions
  const row = await trx.selectFrom('sessions').select(['subject_type', 'subject_id']).where('id', '=', o.sessionId).executeTakeFirst();
  if (row === undefined || row.subject_type !== STAFF || row.subject_id !== o.userId) {
    throw new DomainError('NOT_FOUND', { detail: 'Sesi tidak ditemukan / No such session' });
  }
  const revoked = await revokeSessionLineage(trx, o.sessionId);
  let currentEnded = false;
  if (o.currentSessionId !== undefined) {
    const current = await trx.selectFrom('sessions').select('id').where('id', '=', o.currentSessionId).executeTakeFirst();
    currentEnded = current === undefined;
  }
  await tx.audit({ action: 'auth.session.revoke', entity: 'staff_users', entityId: o.userId, meta: { revoked } });
  return { revoked, currentEnded };
}
