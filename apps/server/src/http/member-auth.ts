import {
  findMemberSession,
  hmacB64u,
  memberSessionExpired,
  revokeMemberSession,
  safeEqual,
  touchMemberSession,
  type MemberSessionLimits,
  type MemberSessionView,
} from '@altis/core';
import type { DbHandle } from '@altis/db';
import { DomainError } from '@altis/shared';
import type { Context } from 'hono';
import type { AppServices } from '../services.js';
import { clearAuthCookie, readAuthCookie, requestConfig, setAuthCookie } from './cookies.js';
import { checkOrigin, csrfKey, preSessionCsrfToken } from './csrf.js';
import type { AppEnv } from './request-id.js';

// The member side of the request chain (the OPAC member area, `/akun`), kept apart from the staff side (http/auth.ts):
//
// - The member session's cookie is `altis_msid` (HttpOnly, SameSite=Lax, Path=/; `__Host-` and Secure on https), read
//   only by the routes declared with `member` (and by the members' attachment check of `GET /files/:id`). Those routes
//   are `session: 'none'`, so the staff cookie `altis_sid` is never read there; the staff routes never read
//   `altis_msid`. A staff session is therefore never a member session, and the other way round.
// - resolveMemberAuth: the cookie → the live session row of subject `member` → the member, who must be live (not
//   archived or anonymised) with the `session_version` the session was made at; the idle and absolute limits in force
//   now (`members.session.idleMinutes`, `members.session.absoluteHours`); `members.opac.enabled` off → no member at all.
//   A session that fails any of these is deleted and the cookie cleared. Activity is written at most once a minute.
// - CSRF of the member area's forms: `base64url(HMAC(sessionKey, 'csrf:member:' + sessions.id))` with a session, the
//   pre-session token of the `altis_csrf` cookie (http/csrf.ts) for the sign-in, forgotten-password and set-password
//   forms; read from the form's `_csrf` field or the `X-CSRF-Token` header; the Origin rule of every write first.

/** What the member side of the chain knows about a signed-in member. */
export interface MemberAuthState {
  memberId: string;
  memberTypeId: string;
  session: MemberSessionView;
  mustResetPassword: boolean;
  /** The CSRF token of the session, for the hidden `_csrf` field of the member area's forms. */
  csrf: string;
}

const MEMBER_PREFIX = 'csrf:member:';

/** The CSRF token of the member session `sessionId`. */
export function memberCsrfToken(sessionKey: Uint8Array, sessionId: string): string {
  return hmacB64u(sessionKey, MEMBER_PREFIX + sessionId);
}

/** The session limits in force (`members.session.idleMinutes`, `members.session.absoluteHours`), in ms. */
export async function memberSessionLimits(services: Pick<AppServices, 'settings'>, db: DbHandle['db']): Promise<MemberSessionLimits> {
  const [idle, absolute] = await Promise.all([
    services.settings.get<number>(db, 'members.session.idleMinutes'),
    services.settings.get<number>(db, 'members.session.absoluteHours'),
  ]);
  return { idleMs: idle * 60_000, absoluteMs: absolute * 3_600_000 };
}

/** Sets `altis_msid` to the token of a new member session. */
export function setMemberSessionCookie(c: Context<AppEnv>, token: string): void {
  setAuthCookie(c, 'altis_msid', token);
}

/**
 * The signed-in member of the request (see the top of this file), or null. A session that is no longer good is deleted
 * and its cookie cleared.
 *
 * @throws DomainError DB_UNAVAILABLE when the request carries the cookie and there is no database
 */
export async function resolveMemberAuth(
  c: Context<AppEnv>,
  o: { db: DbHandle | undefined; services: Pick<AppServices, 'settings'>; now: number; touch?: boolean },
): Promise<MemberAuthState | null> {
  const token = readAuthCookie(c, 'altis_msid');
  if (token === undefined) return null;
  const { db, now } = o;
  if (db === undefined) throw new DomainError('DB_UNAVAILABLE');
  const found = await findMemberSession(db.db, token, now);
  if (found === null) {
    clearAuthCookie(c, 'altis_msid');
    return null;
  }
  if ((await o.services.settings.get<boolean>(db.db, 'members.opac.enabled')) !== true) return null;
  const member = await db.db
    .selectFrom('members')
    .select(['member_type_id', 'session_version', 'must_reset_password', 'archived_at', 'anonymized_at'])
    .where('id', '=', found.memberId)
    .executeTakeFirst();
  const limits = await memberSessionLimits(o.services, db.db);
  if (
    member === undefined ||
    member.archived_at !== null ||
    member.anonymized_at !== null ||
    Number(member.session_version) !== found.sessionVersion ||
    memberSessionExpired(found, now, limits)
  ) {
    await revokeMemberSession(db.db, found.id);
    clearAuthCookie(c, 'altis_msid');
    return null;
  }
  if (o.touch !== false) await touchMemberSession(db.db, found, now, limits);
  return {
    memberId: found.memberId,
    memberTypeId: member.member_type_id,
    session: found,
    mustResetPassword: Number(member.must_reset_password) === 1,
    csrf: memberCsrfToken(csrfKey(requestConfig(c)), found.id),
  };
}

/**
 * Step 8 of a member-area form: the Origin rule ({@link checkOrigin}), then the token sent in the form's `_csrf` field
 * (`formToken`) or in `X-CSRF-Token` must be the member session's ({@link memberCsrfToken}) or, on a pre-session form
 * (`preSession`), the one of the request's `altis_csrf` cookie.
 *
 * @throws DomainError `ORIGIN_DENIED`, `CSRF_INVALID`
 */
export function checkMemberCsrf(
  c: Context<AppEnv>,
  o: { sessionId: string | null; preSession: boolean; formToken: string | undefined; originOnly?: boolean },
): void {
  checkOrigin(c);
  if (o.originOnly === true) return;
  const key = csrfKey(requestConfig(c));
  let expected: string | undefined;
  if (o.preSession) {
    const cookie = readAuthCookie(c, 'altis_csrf');
    if (cookie !== undefined) expected = preSessionCsrfToken(key, cookie);
  } else if (o.sessionId !== null) {
    expected = memberCsrfToken(key, o.sessionId);
  }
  const sent = o.formToken ?? c.req.header('x-csrf-token');
  if (expected === undefined || sent === undefined || !safeEqual(sent, expected)) throw new DomainError('CSRF_INVALID');
}

/**
 * A 303 to `path` (a local path the code builds, never one taken from the request as it is), not stored: the member
 * area's answer to a form it handled, and its way back to the sign-in or password page.
 */
export function memberRedirect(c: Context<AppEnv>, path: string): Response {
  if (!path.startsWith('/') || path.startsWith('//') || path.startsWith('/\\')) throw new TypeError('memberRedirect: a local path only');
  c.header('Cache-Control', 'no-store');
  return c.redirect(path, 303);
}

/**
 * The 303 to the sign-in page, with `lanjut` (the page to come back to: a path of this site, checked again by the
 * sign-in page against the OPAC routes) when given; null: to the password page of a member who must set a new one.
 */
export function memberSignInRedirect(c: Context<AppEnv>, lanjut: string | null): Response {
  if (lanjut === null) return memberRedirect(c, '/akun/sandi');
  return memberRedirect(c, lanjut === '/akun' ? '/akun/masuk' : `/akun/masuk?lanjut=${encodeURIComponent(lanjut)}`);
}
