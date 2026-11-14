import type { DB } from '@altis/db';
import type { Kysely, Transaction } from 'kysely';
import { randomToken, sha256hex } from '../../crypto/tokens.js';

// The sessions of members signed in to the OPAC member area (`/akun`). They live in the `sessions` table beside the
// staff sessions, as `subject_type = 'member'`, and every lookup here filters on it: a staff lookup never finds a
// member session and these never find a staff one (each kind has its own cookie as well, `altis_msid` and `altis_sid`).
//
// - The token is 256 bits; the row's id is its SHA-256 hex, so the database never holds a usable token. A sign-in always
//   makes a new one (the browser's previous member session is revoked).
// - `mfa_passed` is 1 (members have no second factor), there is no re-authentication time and no remember-me: library
//   computers are shared.
// - A session expires after `idleMs` without activity and at the latest `absoluteMs` after it was made (the settings
//   `members.session.idleMinutes` and `members.session.absoluteHours`); activity is written at most once a minute.
// - `authz_version` holds the member's `session_version` when the session was made: raising `members.session_version`
//   (a password change or reset, a suspension, an archive, a new member number, an anonymisation) ends every session
//   of the member at its next request; the writers also delete the rows at once (revokeMemberSessions).

export const MEMBER_SUBJECT = 'member';

/** `last_seen_at` is written at most this often. */
const TOUCH_INTERVAL_MS = 60_000;
/** A session token: 32 bytes as unpadded base64url. */
const TOKEN = /^[A-Za-z0-9_-]{43}$/;
/** The width of `sessions.user_agent`, in code points. */
const USER_AGENT_MAX = 191;

/** A member session as the HTTP layer sees it. */
export interface MemberSessionView {
  /** SHA-256 hex of the token. */
  id: string;
  memberId: string;
  createdAt: number;
  lastSeenAt: number;
  expiresAt: number;
  /** The member's `session_version` when the session was made. */
  sessionVersion: number;
}

/** The limits a member session lives within, in ms. */
export interface MemberSessionLimits {
  idleMs: number;
  absoluteMs: number;
}

function clipUserAgent(ua: string | null): string | null {
  if (ua === null) return null;
  const points = Array.from(ua);
  return points.length <= USER_AGENT_MAX ? ua : points.slice(0, USER_AGENT_MAX).join('');
}

const expiry = (createdAt: number, now: number, l: MemberSessionLimits): number => Math.min(now + l.idleMs, createdAt + l.absoluteMs);

/** Makes a member session in `trx` and returns its token (the `altis_msid` cookie) and id. */
export async function createMemberSession(
  trx: Transaction<DB>,
  o: { memberId: string; sessionVersion: number; ip: string | null; userAgent: string | null; now: number } & MemberSessionLimits,
): Promise<{ token: string; id: string }> {
  const token = randomToken(32);
  const id = sha256hex(token);
  await trx
    .insertInto('sessions')
    .values({
      id,
      subject_type: MEMBER_SUBJECT,
      subject_id: o.memberId,
      created_at: o.now,
      last_seen_at: o.now,
      expires_at: expiry(o.now, o.now, o),
      ip: o.ip,
      user_agent: clipUserAgent(o.userAgent),
      mfa_passed: 1,
      reauth_at: null,
      remember_selector: null,
      authz_version: o.sessionVersion,
    })
    .execute();
  return { token, id };
}

/** The live member session of `token` (`expires_at > now`), or null; a malformed token is null. */
export async function findMemberSession(db: Kysely<DB> | Transaction<DB>, token: string, now: number): Promise<MemberSessionView | null> {
  if (typeof token !== 'string' || !TOKEN.test(token)) return null;
  const r = await db
    .selectFrom('sessions')
    .select(['id', 'subject_id', 'created_at', 'last_seen_at', 'expires_at', 'authz_version'])
    .where('id', '=', sha256hex(token))
    .where('subject_type', '=', MEMBER_SUBJECT)
    .where('expires_at', '>', now)
    .executeTakeFirst();
  if (r === undefined) return null;
  return {
    id: r.id,
    memberId: r.subject_id,
    createdAt: Number(r.created_at),
    lastSeenAt: Number(r.last_seen_at),
    expiresAt: Number(r.expires_at),
    sessionVersion: Number(r.authz_version),
  };
}

/** Whether `s` is past the limits in force now (they may have been lowered since it was made). */
export function memberSessionExpired(s: MemberSessionView, now: number, l: MemberSessionLimits): boolean {
  return now >= s.lastSeenAt + l.idleMs || now >= s.createdAt + l.absoluteMs;
}

/**
 * Records activity on `s`: at most once a minute, `last_seen_at = now` and `expires_at = min(now + idle, created +
 * absolute)`, conditional on the row still having the `last_seen_at` of `s` (of two requests only one writes).
 */
export async function touchMemberSession(db: Kysely<DB>, s: MemberSessionView, now: number, l: MemberSessionLimits): Promise<void> {
  if (now - s.lastSeenAt < TOUCH_INTERVAL_MS) return;
  await db
    .updateTable('sessions')
    .set({ last_seen_at: now, expires_at: expiry(s.createdAt, now, l) })
    .where('id', '=', s.id)
    .where('subject_type', '=', MEMBER_SUBJECT)
    .where('last_seen_at', '=', s.lastSeenAt)
    .execute();
}

/** Deletes the member session `id` (a sign-out); nothing for another kind of session. */
export async function revokeMemberSession(db: Kysely<DB> | Transaction<DB>, id: string): Promise<void> {
  await db.deleteFrom('sessions').where('id', '=', id).where('subject_type', '=', MEMBER_SUBJECT).execute();
}

/**
 * Ends every session of the member `memberId`: `session_version + 1` (a request that still carries one is refused by
 * its version) and the rows deleted. Call it in the transaction that changes the member, after its lock.
 */
export async function revokeMemberSessions(trx: Transaction<DB>, memberId: string): Promise<void> {
  await trx
    .updateTable('members')
    .set((eb) => ({ session_version: eb('session_version', '+', 1) }))
    .where('id', '=', memberId)
    .execute();
  await trx.deleteFrom('sessions').where('subject_type', '=', MEMBER_SUBJECT).where('subject_id', '=', memberId).execute();
}
