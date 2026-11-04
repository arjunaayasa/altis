import { hmacB64u } from '@altis/core';
import { decodeBase64Url } from '@altis/crypto';
import { Hono, type Context } from 'hono';
import { describe, expect, it } from 'vitest';
import type { AppEnv } from '../src/app.js';
import type { Config } from '../src/config.js';
import {
  DEVICE_MAX_AGE_S,
  REMEMBER_MAX_AGE_S,
  clearAuthCookie,
  cookieName,
  isSecureBase,
  readAuthCookie,
  setAuthCookie,
} from '../src/http/cookies.js';
import { csrfKey, ensurePreSessionCsrf, preSessionCsrfToken, sessionCsrfToken, setSessionCookie } from '../src/http/csrf.js';
import { sampleConfig } from './support.js';

// The auth cookies (spec §7.1, §7.4, P13): HttpOnly, SameSite=Lax, Path=/, no Domain; with an https baseUrl also
// Secure and the `__Host-` prefix. The scheme of baseUrl decides, never a request header.

const HTTPS = sampleConfig();
const HTTP = sampleConfig({ baseUrl: 'http://192.168.1.10:3000', allowedOrigins: [] });
const key = (config: Config): Uint8Array => decodeBase64Url(config.secrets.sessionKey)!;

/** An app whose requests run under `config` (what step 4 puts in the context), with `fn` as the only route. */
function appWith(config: Config, fn: (c: Context<AppEnv>) => unknown) {
  const app = new Hono<AppEnv>();
  app.use((c, next) => {
    c.set('config', config);
    return next();
  });
  app.all('/t', (c) => c.json({ out: fn(c) ?? null }));
  return app;
}

async function run(config: Config, fn: (c: Context<AppEnv>) => unknown, cookie?: string) {
  const res = await appWith(config, fn).request('/t', { headers: cookie === undefined ? {} : { cookie } });
  return { res, setCookie: res.headers.getSetCookie(), out: ((await res.json()) as { out: unknown }).out };
}

describe('cookie names and attributes', () => {
  it('isSecureBase follows the scheme of baseUrl; cookieName adds __Host- when secure', () => {
    expect(isSecureBase('https://perpus.sekolah.sch.id')).toBe(true);
    expect(isSecureBase('http://192.168.1.10:3000')).toBe(false);
    expect(isSecureBase('not a url')).toBe(false);
    expect(cookieName('altis_sid', true)).toBe('__Host-altis_sid');
    expect(cookieName('altis_csrf', false)).toBe('altis_csrf');
  });

  it('https baseUrl: __Host-altis_sid=…; Path=/; HttpOnly; SameSite=Lax; Secure; no Domain, no Max-Age', async () => {
    const { setCookie } = await run(HTTPS, (c) => setAuthCookie(c, 'altis_sid', 'tok'));
    expect(setCookie).toHaveLength(1);
    const line = setCookie[0]!;
    expect(line.startsWith('__Host-altis_sid=tok')).toBe(true);
    for (const part of ['; Path=/', '; HttpOnly', '; SameSite=Lax', '; Secure']) expect(line).toContain(part);
    expect(line).not.toMatch(/domain/i);
    expect(line).not.toMatch(/max-age/i);
  });

  it('http baseUrl: altis_sid=… without Secure', async () => {
    const { setCookie } = await run(HTTP, (c) => setAuthCookie(c, 'altis_sid', 'tok'));
    const line = setCookie[0]!;
    expect(line.startsWith('altis_sid=tok')).toBe(true);
    for (const part of ['; Path=/', '; HttpOnly', '; SameSite=Lax']) expect(line).toContain(part);
    expect(line).not.toContain('Secure');
  });

  it('maxAgeS sets Max-Age (remember-me 30 days, device 180 days)', async () => {
    expect(REMEMBER_MAX_AGE_S).toBe(2_592_000);
    expect(DEVICE_MAX_AGE_S).toBe(15_552_000);
    const { setCookie } = await run(HTTPS, (c) => setAuthCookie(c, 'altis_rm', 'r', { maxAgeS: REMEMBER_MAX_AGE_S }));
    expect(setCookie[0]).toContain('; Max-Age=2592000');
  });

  it('clearAuthCookie sends Max-Age=0 with the same name and attributes', async () => {
    const { setCookie } = await run(HTTPS, (c) => clearAuthCookie(c, 'altis_dev'));
    expect(setCookie[0]!.startsWith('__Host-altis_dev=;')).toBe(true);
    expect(setCookie[0]).toContain('; Max-Age=0');
    expect(setCookie[0]).toContain('; Path=/');
  });

  it('readAuthCookie reads the prefixed name on https and never the bare one; the bare name on http', async () => {
    expect((await run(HTTPS, (c) => readAuthCookie(c, 'altis_sid'), '__Host-altis_sid=a1')).out).toBe('a1');
    expect((await run(HTTPS, (c) => readAuthCookie(c, 'altis_sid'), 'altis_sid=planted')).out).toBeNull();
    expect((await run(HTTP, (c) => readAuthCookie(c, 'altis_sid'), 'altis_sid=b2')).out).toBe('b2');
    expect((await run(HTTP, (c) => readAuthCookie(c, 'altis_sid'))).out).toBeNull();
  });
});

describe('setSessionCookie (S9)', () => {
  it('sets altis_sid and X-CSRF-Token = sessionCsrfToken(sessionKey, id)', async () => {
    const { res, setCookie } = await run(HTTPS, (c) => setSessionCookie(c, { token: 'T'.repeat(43), id: 'ab'.repeat(32) }));
    expect(setCookie[0]!.startsWith(`__Host-altis_sid=${'T'.repeat(43)};`)).toBe(true);
    expect(res.headers.get('x-csrf-token')).toBe(sessionCsrfToken(key(HTTPS), 'ab'.repeat(32)));
  });
});

describe('CSRF tokens (§7.4, D20, D45)', () => {
  it('csrfKey is the sessionKey decoded to its 32 bytes', () => {
    expect(Buffer.from(csrfKey(HTTPS)).equals(Buffer.from(key(HTTPS)))).toBe(true);
  });

  it('session token = HMAC(sessionKey bytes, "csrf:" + id); pre-session = HMAC(sessionKey bytes, "csrf:pre:" + cookie)', () => {
    const k = key(HTTPS);
    expect(k).toHaveLength(32);
    expect(sessionCsrfToken(k, 'abc')).toBe(hmacB64u(k, 'csrf:abc'));
    expect(preSessionCsrfToken(k, 'xyz')).toBe(hmacB64u(k, 'csrf:pre:xyz'));
    expect(sessionCsrfToken(k, 'abc')).not.toBe(preSessionCsrfToken(k, 'abc'));
    expect(sessionCsrfToken(k, 'abc')).not.toBe(hmacB64u(HTTPS.secrets.sessionKey, 'csrf:abc'));
  });

  it('ensurePreSessionCsrf sets altis_csrf (43 characters) when absent and returns the token for it', async () => {
    const { setCookie, out } = await run(HTTPS, (c) => ensurePreSessionCsrf(c));
    expect(setCookie).toHaveLength(1);
    const match = /^__Host-altis_csrf=([A-Za-z0-9_-]{43});/.exec(setCookie[0]!);
    expect(match).not.toBeNull();
    expect(setCookie[0]).toContain('; HttpOnly');
    expect(out).toBe(preSessionCsrfToken(key(HTTPS), match![1]!));
  });

  it('ensurePreSessionCsrf keeps a present cookie (no Set-Cookie) and replaces a malformed one', async () => {
    const value = 'c'.repeat(43);
    const kept = await run(HTTPS, (c) => ensurePreSessionCsrf(c), `__Host-altis_csrf=${value}`);
    expect(kept.setCookie).toEqual([]);
    expect(kept.out).toBe(preSessionCsrfToken(key(HTTPS), value));
    const replaced = await run(HTTPS, (c) => ensurePreSessionCsrf(c), '__Host-altis_csrf=short');
    expect(replaced.setCookie).toHaveLength(1);
    expect(replaced.out).not.toBe(preSessionCsrfToken(key(HTTPS), 'short'));
  });
});
