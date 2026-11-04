import fsp from 'node:fs/promises';
import os from 'node:os';
import path from 'node:path';
import { base32Decode, bumpAuthzVersion, createSettingsCache, hotp, randomToken, sha256hex, totpStep, type SettingsCache } from '@altis/core';
import { PHASE1_MIGRATIONS, countRows, runMigrations, withTx } from '@altis/db';
import { afterAll, beforeAll, beforeEach, describe, expect, it } from 'vitest';
import { engineLabel, testDb, testDbContext, type TestDbHandle } from '../../../../tools/test/test-db.js';
import { createApp } from '../../src/app.js';
import { csrfKey, preSessionCsrfToken } from '../../src/http/csrf.js';
import { ALL_ROUTES } from '../../src/routes.js';
import { createAgent, type Agent, type AgentReply } from '../agent.js';
import { recordingLogger, sampleConfig } from '../support.js';
import { TEST_KEYRING, seedStaff, sessionCsrfFor, type SeededStaff } from '../support-auth.js';

// The remember-me restore of Task 17 on the engine picked by ALTIS_TEST_DB (spec §7.1 "Ingat saya", §4.8): `GET
// auth/me`, the SPA's first request after a page load, turns a valid `altis_rm` into a session when the browser has
// none. The validator rotates on every use; within 30 s the previous one answers with the same session (parallel
// requests, D12); any other reuse revokes every session and token of the user (`auth.remember.reuse`). A token
// belongs to the session that issued it (B9): revoking that session, logging it out, or a change of the user's rights
// deletes it. Tokens issued without a second factor (`mfa_bound = 0`) die once 2FA is enabled or required.

const ctx = testDbContext();
let h: TestDbHandle;

const SEC = 1000;
const DAY = 86_400_000;
/** 09:00:05 UTC, 5 s into a TOTP step and a 15-minute window; in the past (an audit entry may not be dated ahead). */
const NOW = Date.UTC(2026, 9, 20, 9, 0, 5);
const STEP = totpStep(NOW);
/** The app opens the TOTP secrets seedStaff sealed: its config carries TEST_KEYRING. */
const CONFIG = sampleConfig({ keyring: TEST_KEYRING.map((entry) => ({ ...entry })) });

const AUTH = '/api/v1/auth';
const LOGIN = `${AUTH}/login`;
const LOGOUT = `${AUTH}/logout`;
const ME = `${AUTH}/me`;
const VERIFY = `${AUTH}/2fa/verify`;
const SETUP = `${AUTH}/2fa/setup`;
const ENABLE = `${AUTH}/2fa/enable`;
const REAUTH = `${AUTH}/reauth`;
const SESSIONS = `${AUTH}/sessions`;
const BRANCHES = '/api/v1/branches';
const IP = '203.0.113.9';
/** baseUrl is https: every auth cookie carries the `__Host-` prefix. */
const SID = '__Host-altis_sid';
const RM = '__Host-altis_rm';
const CSRF = '__Host-altis_csrf';
/** `<selector>.<validator>`: randomToken(18) and randomToken(32). */
const RM_COOKIE = /^[A-Za-z0-9_-]{24}\.[A-Za-z0-9_-]{43}$/;

/** The app on the test database with a fake clock at NOW (and, when given, its own settings cache). */
function appAt(o: { settings?: SettingsCache } = {}) {
  const clock = { now: NOW };
  const app = createApp({
    state: { phase: 'ready', db: h, config: CONFIG },
    version: '1.4.2',
    buildId: 'build-x',
    log: recordingLogger(),
    clock: () => clock.now,
    routes: ALL_ROUTES,
    ...(o.settings === undefined ? {} : { services: { settings: o.settings } }),
  });
  return { app, clock };
}

type TestApp = ReturnType<typeof appAt>;

/** A browser: its pre-session CSRF token (D20), replaced by its session's token once it has one (S9). */
interface Browser {
  agent: Agent;
  csrf: string;
}

/** A browser without a session (a pre-session CSRF cookie and its token). */
function browser(t: TestApp): Browser {
  const agent = createAgent(t.app, { peer: IP });
  const value = randomToken(32);
  agent.setCookie(CSRF, value);
  return { agent, csrf: preSessionCsrfToken(csrfKey(CONFIG), value) };
}

/** A request with the browser's current CSRF token; a new `X-CSRF-Token` in the answer replaces it. */
async function send(b: Browser, method: 'post' | 'delete', p: string, body?: unknown): Promise<AgentReply> {
  const res = await b.agent[method](p, body, { 'x-csrf-token': b.csrf });
  const next = res.headers.get('x-csrf-token');
  if (next !== null) b.csrf = next;
  return res;
}

/** GET auth/me; the answer's `csrfToken` becomes the browser's token (as the SPA does). */
async function me(b: Browser): Promise<AgentReply> {
  const res = await b.agent.get(ME);
  const token = (res.json as { csrfToken?: string } | undefined)?.csrfToken;
  if (token !== undefined) b.csrf = token;
  return res;
}

type Staff = SeededStaff & { username: string };

async function staff(o: Parameters<typeof seedStaff>[1]): Promise<Staff> {
  return { ...(await seedStaff(h, { now: NOW, ...o })), username: o.username };
}

/** A new browser signed in with the password (`remember` as given); its login answer is `res`. */
async function signIn(t: TestApp, user: Staff, o: { remember?: boolean } = {}): Promise<{ b: Browser; res: AgentReply }> {
  const b = browser(t);
  const res = await send(b, 'post', LOGIN, { username: user.username, password: user.password, ...(o.remember === undefined ? {} : { remember: o.remember }) });
  expect(res.status).toBe(200);
  return { b, res };
}

/** A browser that holds nothing but the remember-me cookie `rm` (the browser was closed and opened again). */
function reopened(t: TestApp, rm: string): Browser {
  const b = browser(t);
  b.agent.setCookie(RM, rm);
  return b;
}

const totp = (secret: Uint8Array, step: number): string => hotp(secret, step, 6);
const code = (res: AgentReply): string | undefined => (res.json as { code?: string } | undefined)?.code;
const cookieLine = (res: AgentReply, name: string): string | undefined =>
  res.headers.getSetCookie().find((line) => line.startsWith(`${name}=`));
const authenticated = (res: AgentReply): boolean => (res.json as { authenticated: boolean }).authenticated;
const selectorOf = (rm: string): string => rm.split('.')[0]!;
const sidOf = (b: Browser): string => b.agent.cookies.get(SID)!;

const sessionsOf = (userId: string) =>
  h.db
    .selectFrom('sessions')
    .select(['id', 'mfa_passed', 'remember_selector', 'reauth_at', 'ip'])
    .where('subject_id', '=', userId)
    .orderBy('id')
    .execute();
const tokensOf = (userId: string) =>
  h.db.selectFrom('remember_tokens').select(['selector', 'validator_hash', 'mfa_bound']).where('subject_id', '=', userId).execute();

async function audits(action: string) {
  const rows = await h.db
    .selectFrom('audit_log')
    .select(['actor_type', 'actor_id', 'entity', 'entity_id', 'ip', 'meta'])
    .where('action', '=', action)
    .orderBy('seq')
    .execute();
  return rows.map((r) => ({ ...r, meta: JSON.parse(r.meta) as Record<string, unknown> }));
}

/** Expects an anonymous `auth/me` answer that clears `altis_rm` and leaves the browser without a session cookie. */
function expectRefused(res: AgentReply, b: Browser): void {
  expect(res.status).toBe(200);
  expect(res.json).toMatchObject({ authenticated: false });
  expect(cookieLine(res, RM)).toMatch(/Max-Age=0/);
  expect(b.agent.cookies.has(RM)).toBe(false);
  expect(b.agent.cookies.has(SID)).toBe(false);
}

describe.skipIf(!ctx.available)(`auth API: remember-me restore [${engineLabel()}]`, () => {
  let dataDir: string;

  beforeAll(async () => {
    h = await testDb();
    dataDir = await fsp.mkdtemp(path.join(os.tmpdir(), 'altis-auth-remember-'));
    await runMigrations(h, { appVersion: '0.1.0', dataDir, migrations: PHASE1_MIGRATIONS });
  });

  afterAll(async () => {
    await h?.close();
    if (dataDir !== undefined) await fsp.rm(dataDir, { recursive: true, force: true });
  });

  beforeEach(async () => {
    await h.db.deleteFrom('sessions').execute();
    await h.db.deleteFrom('remember_tokens').execute();
    await h.db.deleteFrom('rate_limits').execute();
    await h.db.deleteFrom('settings').execute();
    await h.db.deleteFrom('staff_users').execute(); // user_roles and recovery codes cascade
    await h.db.deleteFrom('audit_log').execute();
    await h.db.updateTable('audit_head').set({ last_seq: 0, last_hash: '0'.repeat(64) }).where('id', '=', 1).execute();
  });

  describe('restore', () => {
    it('login with remember (no 2FA) → altis_rm for 30 days, mfa_bound 0; a reopened browser → auth/me authenticated, a new altis_sid, a rotated altis_rm, reauthUntil null', async () => {
      const t = appAt();
      const budi = await staff({ username: 'budi', roles: [{ key: 'admin' }] });
      const { b, res } = await signIn(t, budi, { remember: true });
      expect(cookieLine(res, RM)).toMatch(/Max-Age=2592000/);
      const rm = b.agent.cookies.get(RM)!;
      expect(rm).toMatch(RM_COOKIE);
      const tokens = await tokensOf(budi.id);
      expect(tokens).toHaveLength(1);
      expect(tokens[0]!.selector).toBe(selectorOf(rm));
      expect(Number(tokens[0]!.mfa_bound)).toBe(0);
      const loginSid = sidOf(b);

      t.clock.now = NOW + 2 * DAY; // the login session is long gone
      const r = reopened(t, rm);
      const res2 = await me(r);
      expect(res2.status).toBe(200);
      expect(res2.headers.get('cache-control')).toBe('no-store');
      const sid = sidOf(r);
      expect(sid).toMatch(/^[A-Za-z0-9_-]{43}$/);
      expect(sid).not.toBe(loginSid);
      expect(res2.json).toMatchObject({
        authenticated: true,
        stage: 'full',
        mustChangePassword: false,
        user: { id: budi.id, username: 'budi', totpEnabled: false },
        superAdmin: false,
        reauthUntil: null,
        csrfToken: sessionCsrfFor(CONFIG, sid),
      });
      expect((res2.json as { permissions: string[] }).permissions).toContain('system.users.read');
      expect(res2.headers.get('x-csrf-token')).toBe(sessionCsrfFor(CONFIG, sid));
      // The validator rotated: same selector, a new validator, for 30 days again.
      expect(cookieLine(res2, RM)).toMatch(/Max-Age=2592000/);
      const rotated = r.agent.cookies.get(RM)!;
      expect(rotated).toMatch(RM_COOKIE);
      expect(selectorOf(rotated)).toBe(selectorOf(rm));
      expect(rotated).not.toBe(rm);
      expect((await tokensOf(budi.id))[0]!.validator_hash).toBe(sha256hex(rotated.split('.')[1]!));

      // The restored session: full, no reauth_at (§7.1), carrying the token (B9).
      const row = (await sessionsOf(budi.id)).find((s) => s.id === sha256hex(sid));
      expect(row).toMatchObject({ remember_selector: selectorOf(rm), reauth_at: null, ip: IP });
      expect(Number(row!.mfa_passed)).toBe(1);
      // It reads and writes like any session: a permission route, and a POST with its X-CSRF-Token.
      expect((await r.agent.get('/api/v1/users')).status).toBe(200);
      expect((await send(r, 'post', REAUTH, { password: budi.password })).status).toBe(200);
      // No audit entry for a restore.
      expect(await audits('auth.login.success')).toHaveLength(1);
    });

    it('T17: a reopened browser that still sends its idle-expired altis_sid with altis_rm is restored: the clear, then the new sid', async () => {
      const t = appAt();
      const budi = await staff({ username: 'budi', roles: [{ key: 'admin' }] });
      const { b } = await signIn(t, budi, { remember: true });
      const dead = sidOf(b);
      t.clock.now = NOW + 31 * 60 * SEC; // past security.session_idle_minutes (30)

      const res = await me(b);
      expect(res.status).toBe(200);
      expect(authenticated(res)).toBe(true);
      const sid = sidOf(b);
      expect(sid).toMatch(/^[A-Za-z0-9_-]{43}$/);
      expect(sid).not.toBe(dead);
      expect(res.json).toMatchObject({ csrfToken: sessionCsrfFor(CONFIG, sid) });
      // Two altis_sid lines: step 7's clear of the dead one first, the restored session last (the one a browser keeps).
      const lines = res.headers.getSetCookie().filter((line) => line.startsWith(`${SID}=`));
      expect(lines).toHaveLength(2);
      expect(lines[0]).toMatch(/Max-Age=0/);
      expect(lines[1]!.startsWith(`${SID}=${sid};`)).toBe(true);
      expect((await b.agent.get('/api/v1/users')).status).toBe(200);
    });

    it('T17: auth/me reads the settings before it rotates the token: a settings read that fails leaves the validator unrotated', async () => {
      const real = createSettingsCache();
      let failLibrary = true;
      const flaky: SettingsCache = {
        get: async (db, key) => {
          if (key === 'library.name' && failLibrary) {
            failLibrary = false;
            throw new Error('database blip');
          }
          return real.get(db, key);
        },
        invalidate: () => real.invalidate(),
      };
      const t = appAt({ settings: flaky });
      const budi = await staff({ username: 'budi' });
      const { b } = await signIn(t, budi, { remember: true });
      const rm = b.agent.cookies.get(RM)!;
      const before = await tokensOf(budi.id);

      t.clock.now = NOW + 2 * DAY;
      const failed = await reopened(t, rm).agent.get(ME);
      expect(failed.status).toBe(500);
      expect(await tokensOf(budi.id)).toEqual(before); // not rotated: the browser's v0 is still the current validator

      // The next page load, well past the 30 s grace, still presents v0: restored, not taken for a theft.
      t.clock.now = NOW + 2 * DAY + 5 * 60 * SEC;
      const again = await me(reopened(t, rm));
      expect(authenticated(again)).toBe(true);
      expect(await audits('auth.remember.reuse')).toEqual([]);
    });

    it('an auth/me with a live session restores nothing: the token is not used', async () => {
      const t = appAt();
      const budi = await staff({ username: 'budi' });
      const { b } = await signIn(t, budi, { remember: true });
      const before = await tokensOf(budi.id);
      const res = await me(b);
      expect(authenticated(res)).toBe(true);
      expect(cookieLine(res, RM)).toBeUndefined();
      expect(cookieLine(res, SID)).toBeUndefined();
      expect(await tokensOf(budi.id)).toEqual(before);
    });

    it('only auth/me restores: another route with only altis_rm → 401 AUTH_REQUIRED, the token untouched', async () => {
      const t = appAt();
      const budi = await staff({ username: 'budi' });
      const { b } = await signIn(t, budi, { remember: true });
      const rm = b.agent.cookies.get(RM)!;
      const before = await tokensOf(budi.id);
      const r = reopened(t, rm);
      const res = await r.agent.get(BRANCHES);
      expect({ status: res.status, code: code(res) }).toEqual({ status: 401, code: 'AUTH_REQUIRED' });
      expect(await tokensOf(budi.id)).toEqual(before);
      expect(r.agent.cookies.get(RM)).toBe(rm);
    });

    it('parallel restore: two tabs send the same altis_rm at once → both authenticated with the same altis_sid, one session row; only one gets a new altis_rm', async () => {
      const t = appAt();
      const budi = await staff({ username: 'budi' });
      const { b } = await signIn(t, budi, { remember: true });
      const rm = b.agent.cookies.get(RM)!;
      const loginSessionId = sha256hex(sidOf(b));
      t.clock.now = NOW + 60 * SEC;

      const one = reopened(t, rm);
      const two = reopened(t, rm);
      const [a, c] = await Promise.all([me(one), me(two)]);
      expect([authenticated(a), authenticated(c)]).toEqual([true, true]);
      expect(sidOf(one)).toBe(sidOf(two));
      expect((await sessionsOf(budi.id)).map((s) => s.id).sort()).toEqual([loginSessionId, sha256hex(sidOf(one))].sort());
      const renewed = [a, c].filter((res) => cookieLine(res, RM) !== undefined);
      expect(renewed).toHaveLength(1);
      expect(cookieLine(renewed[0]!, RM)).toMatch(/Max-Age=2592000/);
      expect(await audits('auth.remember.reuse')).toEqual([]);
    });

    it('grace: the previous validator within 30 s → the same session again and no new altis_rm; at 30 s still', async () => {
      const t = appAt();
      const budi = await staff({ username: 'budi' });
      const { b } = await signIn(t, budi, { remember: true });
      const rm = b.agent.cookies.get(RM)!;
      t.clock.now = NOW + 60 * SEC;
      const first = reopened(t, rm);
      expect(authenticated(await me(first))).toBe(true);

      for (const after of [10 * SEC, 30 * SEC]) {
        t.clock.now = NOW + 60 * SEC + after;
        const late = reopened(t, rm);
        const res = await me(late);
        expect(authenticated(res)).toBe(true);
        expect(sidOf(late)).toBe(sidOf(first));
        expect(cookieLine(res, RM)).toBeUndefined();
        expect(late.agent.cookies.get(RM)).toBe(rm);
      }
      expect(await sessionsOf(budi.id)).toHaveLength(2);
    });

    it('reuse: the old altis_rm 31 s after its rotation → anonymous, every session and token of the user gone, one auth.remember.reuse', async () => {
      const t = appAt();
      const budi = await staff({ username: 'budi' });
      const { b } = await signIn(t, budi, { remember: true });
      const rm = b.agent.cookies.get(RM)!;
      await signIn(t, budi, { remember: true }); // another browser, with a token of its own
      t.clock.now = NOW + 60 * SEC;
      const owner = reopened(t, rm);
      expect(authenticated(await me(owner))).toBe(true);
      expect(await sessionsOf(budi.id)).toHaveLength(3);
      expect(await tokensOf(budi.id)).toHaveLength(2);

      t.clock.now = NOW + 60 * SEC + 31 * SEC;
      const thief = reopened(t, rm);
      expectRefused(await me(thief), thief);
      expect(await sessionsOf(budi.id)).toEqual([]);
      expect(await tokensOf(budi.id)).toEqual([]);
      expect(await audits('auth.remember.reuse')).toEqual([
        { actor_type: 'anonymous', actor_id: null, entity: 'staff_users', entity_id: budi.id, ip: IP, meta: { sessions: 3, tokens: 2 } },
      ]);
      // The owner's browser is signed out too, and its rotated cookie restores nothing.
      expectRefused(await me(owner), owner);
    });

    it('an unknown, malformed or expired altis_rm → anonymous with altis_rm cleared; at 30 days − 1 ms a token still restores', async () => {
      const t = appAt();
      const budi = await staff({ username: 'budi' });
      const first = (await signIn(t, budi, { remember: true })).b.agent.cookies.get(RM)!;
      const second = (await signIn(t, budi, { remember: true })).b.agent.cookies.get(RM)!;

      for (const bad of ['garbage', `${'A'.repeat(24)}.${'B'.repeat(43)}`]) {
        const r = reopened(t, bad);
        expectRefused(await me(r), r);
      }

      t.clock.now = NOW + 30 * DAY - 1;
      expect(authenticated(await me(reopened(t, first)))).toBe(true);
      t.clock.now = NOW + 30 * DAY + 1;
      const late = reopened(t, second);
      expectRefused(await me(late), late);
      expect(await audits('auth.remember.reuse')).toEqual([]);
    });
  });

  describe('2FA', () => {
    it('a 2FA user: login with remember sets no altis_rm; verify with remember sets it (mfa_bound 1) and it restores a full session; a new device still needs password and code', async () => {
      const t = appAt();
      const sari = await staff({ username: 'sari', totp: true });
      const { b, res } = await signIn(t, sari, { remember: true });
      expect(res.json).toMatchObject({ stage: 'mfa' });
      expect(cookieLine(res, RM)).toBeUndefined();
      expect(await tokensOf(sari.id)).toEqual([]);

      const verified = await send(b, 'post', VERIFY, { code: totp(sari.totpSecret!, STEP), remember: true });
      expect(verified.status).toBe(200);
      expect(cookieLine(verified, RM)).toMatch(/Max-Age=2592000/);
      const rm = b.agent.cookies.get(RM)!;
      const tokens = await tokensOf(sari.id);
      expect(tokens.map((x) => [x.selector, Number(x.mfa_bound)])).toEqual([[selectorOf(rm), 1]]);

      t.clock.now = NOW + DAY;
      const r = reopened(t, rm);
      expect((await me(r)).json).toMatchObject({ authenticated: true, stage: 'full', user: { totpEnabled: true } });

      const elsewhere = await signIn(t, sari);
      expect(elsewhere.res.json).toMatchObject({ stage: 'mfa' });
      expect(elsewhere.b.agent.cookies.has(RM)).toBe(false);
    });

    it('2FA enabled later: the earlier mfa_bound 0 token is gone, and its cookie restores nothing', async () => {
      const t = appAt();
      const budi = await staff({ username: 'budi' });
      const rm = (await signIn(t, budi, { remember: true })).b.agent.cookies.get(RM)!;
      const { b } = await signIn(t, budi);
      const setup = await send(b, 'post', SETUP);
      const secret = base32Decode((setup.json as { secret: string }).secret);
      expect((await send(b, 'post', ENABLE, { code: totp(secret, STEP) })).status).toBe(200);
      expect(await tokensOf(budi.id)).toEqual([]);
      const r = reopened(t, rm);
      expectRefused(await me(r), r);
    });

    it('a token issued before a role started requiring 2FA → refused at use and deleted; the open session stays (D36)', async () => {
      const t = appAt();
      const dewi = await staff({ username: 'dewi', roles: [{ permissions: ['system.audit.read'] }] });
      const { b } = await signIn(t, dewi, { remember: true });
      const rm = b.agent.cookies.get(RM)!;
      // The role's flag set without going through the roles API (whose authz_version bump would delete the token).
      const { role_id: roleId } = await h.db.selectFrom('user_roles').select('role_id').where('user_id', '=', dewi.id).executeTakeFirstOrThrow();
      await h.db.updateTable('roles').set({ mfa_required: 1 }).where('id', '=', roleId).execute();

      const r = reopened(t, rm);
      expectRefused(await me(r), r);
      expect(await tokensOf(dewi.id)).toEqual([]);
      const sessions = await sessionsOf(dewi.id);
      expect(sessions.map((s) => [s.id, s.remember_selector])).toEqual([[sha256hex(sidOf(b)), null]]);
      expect(authenticated(await me(b))).toBe(true);
    });

    it('a user no longer active (status set without the revocation) → refused at use and deleted', async () => {
      const t = appAt();
      const budi = await staff({ username: 'budi' });
      const rm = (await signIn(t, budi, { remember: true })).b.agent.cookies.get(RM)!;
      await h.db.updateTable('staff_users').set({ status: 'locked' }).where('id', '=', budi.id).execute();
      const r = reopened(t, rm);
      expectRefused(await me(r), r);
      expect(await tokensOf(budi.id)).toEqual([]);
    });
  });

  describe('revocation (B9)', () => {
    it('DELETE auth/sessions/:id of the restored session removes its token', async () => {
      const t = appAt();
      const budi = await staff({ username: 'budi' });
      const { b } = await signIn(t, budi, { remember: true });
      const rm = b.agent.cookies.get(RM)!;
      t.clock.now = NOW + 60 * SEC;
      const r = reopened(t, rm);
      expect(authenticated(await me(r))).toBe(true);

      const res = await send(b, 'delete', `${SESSIONS}/${sha256hex(sidOf(r))}`);
      expect(res.status).toBe(200);
      expect(await tokensOf(budi.id)).toEqual([]);
      expectRefused(await me(r), r);
      expect(authenticated(await me(b))).toBe(true);
    });

    it('DELETE auth/sessions/:id of the login session that issued the token (from another session) removes the token; the cookie then restores nothing', async () => {
      const t = appAt();
      const budi = await staff({ username: 'budi' });
      const { b } = await signIn(t, budi, { remember: true });
      const rm = b.agent.cookies.get(RM)!;
      const other = (await signIn(t, budi)).b;

      const res = await send(other, 'delete', `${SESSIONS}/${sha256hex(sidOf(b))}`);
      expect(res.status).toBe(200);
      expect(await tokensOf(budi.id)).toEqual([]);
      const r = reopened(t, rm);
      expectRefused(await me(r), r);
    });

    it('logout of the issuing session → the token row is gone and altis_rm is cleared', async () => {
      const t = appAt();
      const budi = await staff({ username: 'budi' });
      const { b } = await signIn(t, budi, { remember: true });
      const rm = b.agent.cookies.get(RM)!;
      const out = await send(b, 'post', LOGOUT);
      expect(out.status).toBe(204);
      expect(cookieLine(out, RM)).toMatch(/Max-Age=0/);
      expect(await tokensOf(budi.id)).toEqual([]);
      const r = reopened(t, rm);
      expectRefused(await me(r), r);
    });

    it('logout of a restored session ends its token too', async () => {
      const t = appAt();
      const budi = await staff({ username: 'budi' });
      const rm = (await signIn(t, budi, { remember: true })).b.agent.cookies.get(RM)!;
      t.clock.now = NOW + 60 * SEC;
      const r = reopened(t, rm);
      await me(r);
      expect((await send(r, 'post', LOGOUT)).status).toBe(204);
      expect(await tokensOf(budi.id)).toEqual([]);
      expect(r.agent.cookies.has(RM)).toBe(false);
    });

    it('bumpAuthzVersion of the user (a role added by an admin) → the token row is gone, and the cookie then restores nothing', async () => {
      const t = appAt();
      const budi = await staff({ username: 'budi' });
      const rm = (await signIn(t, budi, { remember: true })).b.agent.cookies.get(RM)!;
      await withTx(h, (trx) => bumpAuthzVersion(trx, [budi.id]));
      expect(await tokensOf(budi.id)).toEqual([]);
      const r = reopened(t, rm);
      expectRefused(await me(r), r);
      expect(await countRows(h.db.selectFrom('sessions').where('subject_id', '=', budi.id))).toBe(1);
    });
  });

  describe('reauth', () => {
    it('a restored session on a reauth route → 401 AUTH_REAUTH_REQUIRED (no reauth_at, §7.1); after auth/reauth it passes the gate', async () => {
      const t = appAt();
      const root = await staff({ username: 'root', roles: [{ key: 'super_admin' }] });
      const target = await staff({ username: 'target' });
      const rm = (await signIn(t, root, { remember: true })).b.agent.cookies.get(RM)!;
      t.clock.now = NOW + DAY;
      const r = reopened(t, rm);
      expect((await me(r)).json).toMatchObject({ authenticated: true, superAdmin: true, reauthUntil: null });

      const denied = await send(r, 'post', `/api/v1/users/${target.id}/disable`);
      expect({ status: denied.status, code: code(denied) }).toEqual({ status: 401, code: 'AUTH_REAUTH_REQUIRED' });
      expect((await send(r, 'post', REAUTH, { password: root.password })).status).toBe(200);
      expect((await send(r, 'post', `/api/v1/users/${target.id}/disable`)).status).toBe(200);
    });
  });
});
