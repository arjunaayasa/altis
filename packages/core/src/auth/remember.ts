import { assertOutsideTx, type DB, type DbHandle } from '@altis/db';
import type { Transaction } from 'kysely';
import { loadGrants, type Grants } from '../authz/grants.js';
import type { TxRunner } from '../context.js';
import { hmacB64u, randomToken, safeEqual, sha256hex } from '../crypto/tokens.js';
import {
  createSession,
  findSession,
  revokeRememberToken,
  revokeSubject,
  type SessionToken,
  type SessionView,
} from './sessions.js';
import { loadStaffAuthView, lockStaffRow, mfaNeeded, type StaffAuthView } from './staff.js';

// Remember-me tokens (spec §7.1): the cookie `altis_rm` is `<selector>.<validator>`; the database keeps the selector
// and the SHA-256 of the validator, never the validator.
//
// - Every use rotates the validator (a conditional UPDATE on the hash that was presented, so of two parallel uses
//   exactly one rotates).
// - For REMEMBER_GRACE_MS after a rotation the previous validator is still accepted ("grace") and answers with the
//   same session, without a new token: the session a remember token opens has the token
//   HMAC(sessionKey, 'rm-session:' + selector + ':' + validatorHash) of the current validator hash (D12), so the
//   grace request derives the very session the rotating request opened, and nothing secret is stored for it.
// - Any other validator for a live selector is reuse: a stolen cookie raced its owner. The caller revokes every
//   session and token of the subject and audits `auth.remember.reuse`.
// - A token lives REMEMBER_MS from its issue; rotation does not extend it. It belongs to the session that issued it
//   (B9): the caller issues it first and passes the selector to createSession or rotateSession.
// - restoreRememberedSession is the restore of `GET auth/me` (Task 17, §4.8): a use as above, then, in one
//   transaction that locks the user's row first, the session of the token (D12, an upsert shared by parallel
//   requests), or the token deleted when its user may no longer use it; a reuse revokes the subject and is audited.

/** The lifetime of a remember-me token. */
export const REMEMBER_MS = 30 * 86_400_000;
/** How long the previous validator keeps answering after a rotation. */
export const REMEMBER_GRACE_MS = 30_000;

const STAFF = 'staff';
/** `<selector>.<validator>`: randomToken(18) and randomToken(32). */
const COOKIE = /^([A-Za-z0-9_-]{24})\.([A-Za-z0-9_-]{43})$/;

/** What a use of a remember-me cookie comes to. */
export type RememberOutcome =
  | { kind: 'rotated'; subjectId: string; mfaBound: boolean; selector: string; cookie: string; sessionToken: string }
  | { kind: 'grace'; subjectId: string; mfaBound: boolean; selector: string; sessionToken: string }
  | { kind: 'reuse'; subjectId: string }
  | { kind: 'invalid' };

/**
 * Issues a token for a staff subject in `trx`, expiring REMEMBER_MS after `now`. `mfaBound` says it was issued
 * after a passed second factor (§7.1: tokens without it die once 2FA is enabled or required).
 *
 * @returns the cookie value `<selector>.<validator>` and the selector to record on the session (B9)
 */
export async function issueRememberToken(
  trx: Transaction<DB>,
  o: { subjectId: string; mfaBound: boolean; now: number },
): Promise<{ cookie: string; selector: string }> {
  const selector = randomToken(18);
  const validator = randomToken(32);
  await trx
    .insertInto('remember_tokens')
    .values({
      selector,
      validator_hash: sha256hex(validator),
      prev_validator_hash: null,
      rotated_at: null,
      subject_type: STAFF,
      subject_id: o.subjectId,
      expires_at: o.now + REMEMBER_MS,
      mfa_bound: o.mfaBound ? 1 : 0,
      last_used_at: null,
    })
    .execute();
  return { cookie: `${selector}.${validator}`, selector };
}

/**
 * The token of the session a remember-me token with this selector and current validator hash opens (D12):
 * `hmacB64u(sessionKey, 'rm-session:' + selector + ':' + validatorHash, 32)`, 43 characters. `sessionKey` is the
 * install's decoded 32-byte key (D45).
 */
export function rememberSessionToken(sessionKey: Uint8Array, selector: string, validatorHash: string): string {
  return hmacB64u(sessionKey, `rm-session:${selector}:${validatorHash}`, 32);
}

interface TokenRow {
  validator_hash: string;
  prev_validator_hash: string | null;
  rotated_at: number | null;
  subject_id: string;
  expires_at: number;
  mfa_bound: number;
}

async function readToken(h: DbHandle, selector: string, now: number): Promise<TokenRow | null> {
  const r = await h.db
    .selectFrom('remember_tokens')
    .select(['validator_hash', 'prev_validator_hash', 'rotated_at', 'subject_id', 'expires_at', 'mfa_bound'])
    .where('selector', '=', selector)
    .where('subject_type', '=', STAFF)
    .executeTakeFirst();
  if (r === undefined || Number(r.expires_at) <= now) return null;
  return r;
}

/**
 * Uses a remember-me cookie at `now` (spec §7.1):
 *
 * - a malformed cookie, an unknown selector or an expired token → `invalid`;
 * - the current validator → `rotated`: a new validator replaces it (the old hash kept as `prev_validator_hash`,
 *   `rotated_at = now`), with the new cookie and the session token derived from the new hash;
 * - the previous validator within REMEMBER_GRACE_MS of the rotation → `grace`, with the session token of the current
 *   hash (the session the rotating request opened); also what the loser of two parallel uses gets;
 * - anything else → `reuse`: the caller revokes the subject (sessions and tokens) and audits it.
 *
 * Each statement runs on its own on `h` (no surrounding transaction), so the read after a lost rotation sees the
 * winner's committed row on every dialect (under MySQL/MariaDB REPEATABLE READ a transaction would keep showing its
 * first snapshot). Call it outside any withTx callback: inside one it throws a TypeError (assertOutsideTx; on SQLite
 * its statements would wait forever for the connection the transaction holds).
 */
export async function useRememberToken(
  h: DbHandle,
  cookie: string,
  now: number,
  sessionKey: Uint8Array,
): Promise<RememberOutcome> {
  assertOutsideTx('useRememberToken');
  const m = typeof cookie === 'string' ? COOKIE.exec(cookie) : null;
  if (m === null) return { kind: 'invalid' };
  const selector = m[1]!;
  const vh = sha256hex(m[2]!);

  let row = await readToken(h, selector, now);
  if (row === null) return { kind: 'invalid' };

  if (safeEqual(vh, row.validator_hash)) {
    const validator = randomToken(32);
    const newVh = sha256hex(validator);
    const result = await h.db
      .updateTable('remember_tokens')
      .set({ prev_validator_hash: vh, validator_hash: newVh, rotated_at: now, last_used_at: now })
      .where('selector', '=', selector)
      .where('validator_hash', '=', vh)
      .executeTakeFirst();
    if (Number(result.numUpdatedRows) === 1) {
      return {
        kind: 'rotated',
        subjectId: row.subject_id,
        mfaBound: Number(row.mfa_bound) === 1,
        selector,
        cookie: `${selector}.${validator}`,
        sessionToken: rememberSessionToken(sessionKey, selector, newVh),
      };
    }
    // A parallel use rotated first (or the token was revoked): judge the cookie against the row as it is now.
    row = await readToken(h, selector, now);
    if (row === null) return { kind: 'invalid' };
  }

  const prev = row.prev_validator_hash;
  const rotatedAt = row.rotated_at;
  if (prev !== null && rotatedAt !== null && safeEqual(vh, prev) && now - Number(rotatedAt) <= REMEMBER_GRACE_MS) {
    return {
      kind: 'grace',
      subjectId: row.subject_id,
      mfaBound: Number(row.mfa_bound) === 1,
      selector,
      sessionToken: rememberSessionToken(sessionKey, selector, row.validator_hash),
    };
  }
  return { kind: 'reuse', subjectId: row.subject_id };
}

// ---------------------------------------------------------------------------------------------------------------
// The restore (Task 17)

/** What {@link restoreRememberedSession} takes. */
export interface RestoreInput {
  /** The request's `altis_rm` cookie. */
  cookie: string;
  now: number;
  /** The install's decoded 32-byte sessionKey (D45). */
  sessionKey: Uint8Array;
  /** The client IP and user agent of the request, recorded on the session. */
  ip: string | null;
  userAgent: string | null;
  /** The idle limit of a full session (`security.session_idle_minutes`), in ms. */
  idleMs: number;
}

/** What a restore comes to. Every kind but `restored` means: clear `altis_rm`, answer anonymous. */
export type RestoreOutcome =
  | {
      kind: 'restored';
      /** The session of the token (its `altis_sid`). */
      session: SessionToken;
      view: SessionView;
      user: StaffAuthView;
      grants: Grants;
      /** The rotated `altis_rm` value; null in the grace (the previous validator answers without a new token). */
      cookie: string | null;
    }
  /** The token's user may no longer use it (not active, or 2FA now needed for a token issued without it): deleted. */
  | { kind: 'refused' }
  /** A reuse outside the grace: every session and token of the subject revoked, `auth.remember.reuse` audited. */
  | { kind: 'reuse' }
  /** Malformed, unknown, expired, or revoked since the use. */
  | { kind: 'invalid' };

/**
 * Restores a staff session from the remember-me cookie (spec §7.1; the SPA's first request after a page load, §4.8):
 *
 * 1. {@link useRememberToken} (on `h`, outside any transaction, as it requires);
 * 2. `invalid` → nothing more;
 * 3. `reuse` → one transaction: the user's row locked, revokeSubject (every session and token), and
 *    `auth.remember.reuse {sessions, tokens}` (a security event, by the request's actor);
 * 4. `rotated` or `grace` → one transaction, its first statement the lock on the user's row (lockStaffRow), then:
 *    - the token must still be live (a password change, a 2FA change, a role change or a logout that committed since
 *      the use revoked it) → else `invalid`;
 *    - the user must be `active`, and a token issued without a second factor (`mfa_bound = 0`) is good only while
 *      none is needed (mfaNeeded, from the role grants as they are now: "tokens with mfa_bound=0 die once 2FA is
 *      enabled or required") → else the token is deleted (revokeRememberToken; the sessions that carried it stay,
 *      D36) and `refused`;
 *    - otherwise createSession with the token's session token (D12: an upsert, so parallel requests share one row),
 *      2FA passed, no `reauth_at` (§7.1), the token's selector recorded on it (B9), at the user's `authz_version`.
 *
 * @throws TypeError inside a withTx callback (assertOutsideTx: it runs statements on `h` and opens its own
 *   transactions); whatever the database throws; nothing for a cookie that is refused
 */
export async function restoreRememberedSession(run: TxRunner, h: DbHandle, o: RestoreInput): Promise<RestoreOutcome> {
  assertOutsideTx('restoreRememberedSession');
  const use = await useRememberToken(h, o.cookie, o.now, o.sessionKey);
  if (use.kind === 'invalid') return { kind: 'invalid' };
  const subjectId = use.subjectId;
  if (use.kind === 'reuse') {
    await run(async (tx) => {
      await lockStaffRow(tx.trx, subjectId);
      const revoked = await revokeSubject(tx.trx, subjectId);
      await tx.audit({
        action: 'auth.remember.reuse',
        entity: 'staff_users',
        entityId: subjectId,
        meta: { sessions: revoked.sessions, tokens: revoked.tokens },
      });
    });
    return { kind: 'reuse' };
  }

  return run(async (tx): Promise<RestoreOutcome> => {
    const { trx } = tx;
    await lockStaffRow(trx, subjectId);
    const token = await trx
      .selectFrom('remember_tokens')
      .select('mfa_bound')
      .where('selector', '=', use.selector)
      .where('subject_type', '=', STAFF)
      .where('subject_id', '=', subjectId)
      .where('expires_at', '>', o.now)
      .executeTakeFirst();
    if (token === undefined) return { kind: 'invalid' };
    const user = await loadStaffAuthView(trx, subjectId);
    const grants = user === null ? null : await loadGrants(trx, user.id);
    if (user === null || grants === null || user.status !== 'active' || (Number(token.mfa_bound) !== 1 && mfaNeeded(user, grants))) {
      await revokeRememberToken(trx, use.selector);
      return { kind: 'refused' };
    }
    const session = await createSession(trx, {
      subjectId,
      mfaPassed: true,
      authzVersion: user.authzVersion,
      ip: o.ip,
      userAgent: o.userAgent,
      now: o.now,
      idleMs: o.idleMs,
      rememberSelector: use.selector,
      reauthAt: null,
      token: use.sessionToken,
    });
    const view = await findSession(trx, session.token, o.now);
    if (view === null) throw new TypeError('restoreRememberedSession: the session just written is not readable');
    return { kind: 'restored', session, view, user, grants, cookie: use.kind === 'rotated' ? use.cookie : null };
  });
}
