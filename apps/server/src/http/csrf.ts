import { hmacB64u, randomToken, safeEqual } from '@altis/core';
import { decodeBase64Url } from '@altis/crypto';
import { DomainError } from '@altis/shared';
import type { Context } from 'hono';
import type { Config } from '../config.js';
import { readAuthCookie, requestConfig, setAuthCookie } from './cookies.js';
import type { AppEnv } from './request-id.js';

// CSRF and Origin (spec §7.4, step 8 of §4.7; decisions D20, D45).
//
// - With a session, the token is `base64url(HMAC(sessionKey, 'csrf:' + sessions.id))`: the SPA receives it in the
//   `X-CSRF-Token` response header whenever a session is created or rotated (setSessionCookie, S9).
// - Without one (sign-in, forgot password), a double submit bound to the server: the HttpOnly `altis_csrf` cookie
//   holds a random value and the token is `HMAC(sessionKey, 'csrf:pre:' + value)`, which only the server can make;
//   the SPA gets it from a GET (`auth/me`) that calls ensurePreSessionCsrf.
// - The key is the install's `sessionKey` decoded to its 32 bytes, never its base64url text (M31).
// - The token travels only in `X-CSRF-Token`; no 1b route takes a form, so `_csrf` is not read (D20).
// - 1c Task 15: the `altis_ops` cookie of an exclusive operation has a token of its own,
//   `base64url(HMAC(sessionKey, 'csrf:ops:' + opId))` (opsCsrfToken), which `GET ops/current` hands to a caller
//   authenticated by that cookie and `/admin/_update` embeds (spec §7.4). An `opsAuth` route's write is checked by
//   checkOpsCsrfOrigin: the session's token or the op's (either one the request may hold).
//
// Step 8 applies to every non-GET route with `auth: 'cookie'`; Bearer routes read no cookie and are exempt. Nothing
// here sets an `Access-Control-*` header: there is no CORS, and an origin is never reflected.

const SESSION_PREFIX = 'csrf:';
const PRE_SESSION_PREFIX = 'csrf:pre:';
const OPS_PREFIX = 'csrf:ops:';
/** An `altis_csrf` value: randomToken(32). */
const PRE_SESSION_COOKIE = /^[A-Za-z0-9_-]{43}$/;

/** The HMAC key of `config`: its `sessionKey` as 32 bytes (D45). */
export function csrfKey(config: Config): Uint8Array {
  const key = decodeBase64Url(config.secrets.sessionKey);
  if (key === null || key.length !== 32) throw new TypeError('config.secrets.sessionKey is not 32 bytes of base64url');
  return key;
}

/** The CSRF token of the session `sessionId` (the row id, SHA-256 hex of its token). */
export function sessionCsrfToken(sessionKey: Uint8Array, sessionId: string): string {
  return hmacB64u(sessionKey, SESSION_PREFIX + sessionId);
}

/** The pre-session CSRF token for the `altis_csrf` cookie value `cookieValue`. */
export function preSessionCsrfToken(sessionKey: Uint8Array, cookieValue: string): string {
  return hmacB64u(sessionKey, PRE_SESSION_PREFIX + cookieValue);
}

/** The CSRF token of the `altis_ops` cookie of the op `opId` (1c Task 15, spec §7.4). */
export function opsCsrfToken(sessionKey: Uint8Array, opId: string): string {
  return hmacB64u(sessionKey, OPS_PREFIX + opId);
}

/**
 * Sets the session cookie `altis_sid` to `session.token` and the response header `X-CSRF-Token` to the session's
 * CSRF token (S9). Every place that creates or rotates a session uses it (login, 2FA verify, remember-me restore, the
 * rotation of step 7), so that the SPA's next write carries the right token.
 */
export function setSessionCookie(c: Context<AppEnv>, session: { token: string; id: string }): void {
  setAuthCookie(c, 'altis_sid', session.token);
  c.header('X-CSRF-Token', sessionCsrfToken(csrfKey(requestConfig(c)), session.id));
}

/**
 * The pre-session CSRF token of this browser: sets `altis_csrf` to a new randomToken(32) when the request has none
 * (or a malformed one), and returns the token for the value in use.
 */
export function ensurePreSessionCsrf(c: Context<AppEnv>): string {
  let value = readAuthCookie(c, 'altis_csrf');
  if (value === undefined || !PRE_SESSION_COOKIE.test(value)) {
    value = randomToken(32);
    setAuthCookie(c, 'altis_csrf', value);
  }
  return preSessionCsrfToken(csrfKey(requestConfig(c)), value);
}

/** The origin of an absolute http(s) URL, or null. */
function originOf(text: string): string | null {
  try {
    const url = new URL(text);
    return url.protocol === 'https:' || url.protocol === 'http:' ? url.origin : null;
  } catch {
    return null;
  }
}

/** The origin a request comes from: `Origin`, else the origin of `Referer`; null for one that does not parse; undefined for neither. */
export function requestOrigin(c: Context<AppEnv>): string | null | undefined {
  const origin = c.req.header('origin');
  if (origin !== undefined) return originOf(origin);
  const referer = c.req.header('referer');
  return referer === undefined ? undefined : originOf(referer);
}

/**
 * The Origin part of step 8 (steps 1 and 2 of {@link checkCsrfOrigin}):
 *
 * 1. `Sec-Fetch-Site` present and neither `same-origin` nor `none` → ORIGIN_DENIED;
 * 2. `Origin`, else the origin of `Referer`, present and neither the origin of baseUrl nor one of `allowedOrigins`
 *    (an origin that does not parse, `null` included, never matches) → ORIGIN_DENIED.
 *
 * @throws DomainError `ORIGIN_DENIED`
 */
export function checkOrigin(c: Context<AppEnv>): void {
  const config = requestConfig(c);
  const site = c.req.header('sec-fetch-site');
  if (site !== undefined && site !== 'same-origin' && site !== 'none') throw new DomainError('ORIGIN_DENIED');

  const origin = requestOrigin(c);
  if (origin !== undefined) {
    const allowed = [config.baseUrl, ...config.allowedOrigins].map(originOf);
    if (origin === null || !allowed.includes(origin)) throw new DomainError('ORIGIN_DENIED');
  }
}

/**
 * Step 8 for a GET `auth: 'cookie'` route with side effects (an audited GET such as `audit.export`, or one declared
 * `sideEffects`, T23): a HEAD request is not answered (404 NOT_FOUND: Hono would run the GET handler for it, writing
 * the audit entry and doing the work for a response without a body), and the request must come from the site itself
 * ({@link checkOrigin}): a link on another site, which the SameSite=Lax session cookie follows, never writes an
 * `audit.export` entry nor starts the work. A GET carries no CSRF token, so there is no token check.
 *
 * @throws DomainError `NOT_FOUND`, `ORIGIN_DENIED`
 */
export function checkSideEffectGet(c: Context<AppEnv>): void {
  if (c.req.method === 'HEAD') throw new DomainError('NOT_FOUND');
  checkOrigin(c);
}

/**
 * Step 8 for a non-GET `auth: 'cookie'` route, in this order:
 *
 * 1. and 2. {@link checkOrigin} → ORIGIN_DENIED;
 * 3. `X-CSRF-Token` must equal the session's token when `sessionId` is given (a session was resolved), else the
 *    pre-session token of the `altis_csrf` cookie (none → no token matches) → otherwise CSRF_INVALID.
 *
 * @throws DomainError `ORIGIN_DENIED`, `CSRF_INVALID`
 */
export function checkCsrfOrigin(c: Context<AppEnv>, sessionId: string | null): void {
  checkOrigin(c);
  const config = requestConfig(c);
  const key = csrfKey(config);
  let expected: string | undefined;
  if (sessionId !== null) {
    expected = sessionCsrfToken(key, sessionId);
  } else {
    const cookie = readAuthCookie(c, 'altis_csrf');
    if (cookie !== undefined) expected = preSessionCsrfToken(key, cookie);
  }
  const sent = c.req.header('x-csrf-token');
  if (expected === undefined || sent === undefined || !safeEqual(sent, expected)) throw new DomainError('CSRF_INVALID');
}

/**
 * Step 8 for a non-GET `opsAuth` route (1c Task 15), in this order:
 *
 * 1. and 2. {@link checkOrigin} → ORIGIN_DENIED;
 * 3. `X-CSRF-Token` must equal the session's token when `sessionId` is given (step 7 resolved one), or the op's
 *    token ({@link opsCsrfToken}) when `opId` is given (the request's `altis_ops` cookie is the op's); with neither,
 *    the pre-session token of the `altis_csrf` cookie, as {@link checkCsrfOrigin} → otherwise CSRF_INVALID. Step 9
 *    then decides whether the cookie or the session may use the route.
 *
 * @throws DomainError `ORIGIN_DENIED`, `CSRF_INVALID`
 */
export function checkOpsCsrfOrigin(c: Context<AppEnv>, sessionId: string | null, opId: string | null): void {
  if (sessionId === null && opId === null) {
    checkCsrfOrigin(c, null);
    return;
  }
  checkOrigin(c);
  const key = csrfKey(requestConfig(c));
  const expected: string[] = [];
  if (sessionId !== null) expected.push(sessionCsrfToken(key, sessionId));
  if (opId !== null) expected.push(opsCsrfToken(key, opId));
  const sent = c.req.header('x-csrf-token');
  // Every candidate is compared (no early exit), each in constant time.
  const matches = expected.map((e) => sent !== undefined && safeEqual(sent, e));
  if (!matches.includes(true)) throw new DomainError('CSRF_INVALID');
}
