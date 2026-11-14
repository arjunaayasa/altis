import type { Context } from 'hono';
import { getCookie, setCookie } from 'hono/cookie';
import type { Config } from '../config.js';
import type { AppEnv } from './request-id.js';

// The auth cookies (spec §7.1, §7.4, P13). Every one is `HttpOnly; SameSite=Lax; Path=/` and never has a Domain;
// with an https baseUrl it is also `Secure` and named with the `__Host-` prefix, which the browser only accepts from
// this very host over https (so a sibling subdomain cannot plant one). The scheme of config.json's baseUrl decides,
// never a request header (P13), and only the name it decides is ever read: on https a bare `altis_sid` is ignored.
//
// The request's config is the one step 4 (the config fence) put in the context; these helpers throw a TypeError
// when there is none (not installed), where no route that uses cookies is reachable anyway.

// 1c Task 15: `altis_ops` (spec §9.4) holds the token of an exclusive operation (http/ops-auth.ts issueOpsCookie), which
// opens the `opsAuth` routes without a session (a restore past its point of no return has no tables to hold one).
// Komunitas (member area): `altis_msid` holds the session of a member signed in to the OPAC member area
// (http/member-auth.ts); only the routes declared with `member` read it.
export type AuthCookie = 'altis_sid' | 'altis_rm' | 'altis_dev' | 'altis_csrf' | 'altis_ops' | 'altis_msid';

/** `altis_rm` lives 30 days (spec §7.1). */
export const REMEMBER_MAX_AGE_S = 2_592_000;
/** `altis_dev` lives 180 days (decision D21). */
export const DEVICE_MAX_AGE_S = 15_552_000;

/**
 * `altis_ops` lives 7 days (1c Task 15): longer than any op, so the browser keeps it while it follows the op; what
 * makes it valid is `OpsMachine.tokenMatches` (until the op ended + 1 hour).
 */
export const OPS_MAX_AGE_S = 604_800;

/** The longest Max-Age browsers keep (400 days); hono refuses more. */
const MAX_AGE_LIMIT_S = 34_560_000;

/** Whether `baseUrl` is https (P13: Secure, `__Host-`, HSTS); false for anything that does not parse. */
export function isSecureBase(baseUrl: string): boolean {
  try {
    return new URL(baseUrl).protocol === 'https:';
  } catch {
    return false;
  }
}

/** The cookie's name: `__Host-<base>` when `secure`, else `<base>`. */
export function cookieName(base: AuthCookie, secure: boolean): string {
  return secure ? `__Host-${base}` : base;
}

/** The config of this request (step 4). @throws TypeError when none is loaded */
export function requestConfig(c: Context<AppEnv>): Config {
  const config = c.get('config');
  if (config === undefined) throw new TypeError('auth cookies: no config is loaded for this request');
  return config;
}

function secureFor(c: Context<AppEnv>): boolean {
  return isSecureBase(requestConfig(c).baseUrl);
}

/** The value of the auth cookie `base` under the name the baseUrl decides; undefined when absent or empty. */
export function readAuthCookie(c: Context<AppEnv>, base: AuthCookie): string | undefined {
  const value = getCookie(c, cookieName(base, secureFor(c)));
  return value === undefined || value === '' ? undefined : value;
}

/**
 * Sets the auth cookie `base` to `value`: `Path=/; HttpOnly; SameSite=Lax`, plus `Secure` (and the `__Host-` name)
 * with an https baseUrl; `Max-Age` only with `o.maxAgeS` (else a browser-session cookie).
 *
 * @throws TypeError for a `maxAgeS` that is not an integer from 0 to 34 560 000 (400 days)
 */
export function setAuthCookie(c: Context<AppEnv>, base: AuthCookie, value: string, o: { maxAgeS?: number } = {}): void {
  const secure = secureFor(c);
  if (o.maxAgeS !== undefined && (!Number.isSafeInteger(o.maxAgeS) || o.maxAgeS < 0 || o.maxAgeS > MAX_AGE_LIMIT_S)) {
    throw new TypeError(`setAuthCookie: maxAgeS must be an integer from 0 to ${MAX_AGE_LIMIT_S}`);
  }
  setCookie(c, cookieName(base, secure), value, {
    path: '/',
    httpOnly: true,
    sameSite: 'Lax',
    secure,
    ...(o.maxAgeS === undefined ? {} : { maxAge: o.maxAgeS }),
  });
}

/** Removes the auth cookie `base` (an empty value with `Max-Age=0`, same name and attributes). */
export function clearAuthCookie(c: Context<AppEnv>, base: AuthCookie): void {
  setAuthCookie(c, base, '', { maxAgeS: 0 });
}
