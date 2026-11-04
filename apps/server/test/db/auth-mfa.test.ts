import fsp from 'node:fs/promises';
import os from 'node:os';
import path from 'node:path';
import {
  base32Decode,
  generateRecoveryCodes,
  hotp,
  normalizeRecoveryCode,
  openValue,
  randomToken,
  recoveryCodeHash,
  secretAad,
  sha256hex,
  totpStep,
} from '@altis/core';
import { PHASE1_MIGRATIONS, countRows, runMigrations } from '@altis/db';
import { newId } from '@altis/shared';
import { afterAll, beforeAll, beforeEach, describe, expect, it } from 'vitest';
import { engineLabel, testDb, testDbContext, type TestDbHandle } from '../../../../tools/test/test-db.js';
import { createApp } from '../../src/app.js';
import { csrfKey, preSessionCsrfToken } from '../../src/http/csrf.js';
import { route } from '../../src/http/route.js';
import { ALL_ROUTES } from '../../src/routes.js';
import { createAgent, type Agent, type AgentReply } from '../agent.js';
import { recordingLogger, sampleConfig } from '../support.js';
import { TEST_KEYRING, seedStaff, sessionCookieFor, sessionCsrfFor, type SeededStaff } from '../support-auth.js';

// The 2FA and reauth API of Task 16 on the engine picked by ALTIS_TEST_DB (spec §7.1, §7.3): TOTP enrolment
// (`auth/2fa/setup`, `auth/2fa/enable`), the second factor of a login (`auth/2fa/verify`, with a TOTP code or a
// recovery code), forced enrolment by a role, re-enrolment after a restore (`totp_reenroll`), switching 2FA off,
// new recovery codes and `auth/reauth`. TOTP codes are computed with Task 5's `hotp` at the steps of a fake clock.

const ctx = testDbContext();
let h: TestDbHandle;

const SEC = 1000;
/**
 * 09:00:05 UTC: 5 s into a TOTP step, a 15-minute and an hour window, so that no case crosses a window boundary
 * unless it moves the clock on purpose; in the past, since an audit entry may not be dated ahead of the real clock.
 */
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
const DISABLE = `${AUTH}/2fa/disable`;
const RECOVERY_CODES = `${AUTH}/2fa/recovery-codes`;
const REAUTH = `${AUTH}/reauth`;
const USERS = '/api/v1/users';
const IP = '203.0.113.9';
/** baseUrl is https: every auth cookie carries the `__Host-` prefix. */
const SID = '__Host-altis_sid';
const DEV = '__Host-altis_dev';
const RM = '__Host-altis_rm';
const CSRF = '__Host-altis_csrf';
/** A recovery code as generateRecoveryCodes makes it. */
const RECOVERY_CODE = /^[0-9A-HJKMNP-TV-Z]{5}-[0-9A-HJKMNP-TV-Z]{5}$/;

/**
 * `GET users` (Task 19) once ALL_ROUTES has it; until then a stand-in on the same path behind the same permission,
 * so that step 9's stage rule is what the test sees either way.
 */
const ROUTES = ALL_ROUTES.some((r) => r.method === 'GET' && r.path === USERS)
  ? ALL_ROUTES
  : [
      ...ALL_ROUTES,
      route({
        id: 'test.users_probe',
        method: 'GET',
        path: USERS,
        permission: 'system.users.read',
        idempotency: 'none',
        audit: null,
        handler: async () => ({ body: [] }),
      }),
    ];

/** The app on the test database with a fake clock at NOW and the routes above. */
function appAt() {
  const clock = { now: NOW };
  const app = createApp({
    state: { phase: 'ready', db: h, config: CONFIG },
    version: '1.4.2',
    buildId: 'build-x',
    log: recordingLogger(),
    clock: () => clock.now,
    routes: ROUTES,
  });
  return { app, clock };
}

type TestApp = ReturnType<typeof appAt>;

/** A browser: its pre-session CSRF token (D20), and the token of its session once it has one. */
interface Browser {
  agent: Agent;
  /** The pre-session CSRF token of the agent's `altis_csrf` cookie. */
  preCsrf: string;
  /** The X-CSRF-Token of the session (S9), kept up to date by {@link send}. */
  csrf: string;
}

/** A browser without a session (a pre-session CSRF cookie and its token). */
function browser(t: TestApp): Browser {
  const agent = createAgent(t.app, { peer: IP });
  const value = randomToken(32);
  agent.setCookie(CSRF, value);
  const preCsrf = preSessionCsrfToken(csrfKey(CONFIG), value);
  return { agent, preCsrf, csrf: preCsrf };
}

/** POST `path` with the browser's current CSRF token; a new `X-CSRF-Token` in the answer replaces it. */
async function send(b: Browser, p: string, body?: unknown): Promise<AgentReply> {
  const res = await b.agent.post(p, body, { 'x-csrf-token': b.csrf });
  const next = res.headers.get('x-csrf-token');
  if (next !== null) b.csrf = next;
  return res;
}

/** A new browser that signed in with the password: its session is pre-2FA for a 2FA user. */
async function signIn(t: TestApp, user: { username: string; password: string }, o: { remember?: boolean; stage?: string } = {}) {
  const b = browser(t);
  const res = await send(b, LOGIN, { username: user.username, password: user.password, ...(o.remember === undefined ? {} : { remember: o.remember }) });
  expect(res.status).toBe(200);
  if (o.stage !== undefined) expect(res.json).toMatchObject({ stage: o.stage });
  return b;
}

/** A new browser signed in with the password and the TOTP code of `step`. */
async function fullSignIn(t: TestApp, user: Staff, step: number): Promise<Browser> {
  const b = await signIn(t, user, { stage: 'mfa' });
  const res = await send(b, VERIFY, { code: totp(user.totpSecret!, step) });
  expect(res.status).toBe(200);
  expect(res.json).toMatchObject({ stage: 'full' });
  return b;
}

type Staff = SeededStaff & { username: string };

async function staff(o: Parameters<typeof seedStaff>[1]): Promise<Staff> {
  return { ...(await seedStaff(h, { now: NOW, ...o })), username: o.username };
}

const totp = (secret: Uint8Array, step: number): string => hotp(secret, step, 6);

/** A 6-digit code that is none of the codes matchTotp accepts at `now` (steps s-1, s, s+1). */
function wrongCode(secret: Uint8Array, now: number): string {
  const s = totpStep(now);
  const valid = new Set([totp(secret, s - 1), totp(secret, s), totp(secret, s + 1)]);
  for (let n = 0; ; n += 1) {
    const candidate = String(n).padStart(6, '0');
    if (!valid.has(candidate)) return candidate;
  }
}

/** Ten recovery codes stored for `userId` (as enableTotp stores them); returns them as the user wrote them down. */
async function seedRecoveryCodes(userId: string): Promise<string[]> {
  const codes = generateRecoveryCodes(10);
  await h.db
    .insertInto('staff_recovery_codes')
    .values(codes.map((c) => ({ id: newId(), user_id: userId, code_hash: recoveryCodeHash(userId, normalizeRecoveryCode(c)!), used_at: null, created_at: NOW })))
    .execute();
  return codes;
}

const code = (res: AgentReply): string | undefined => (res.json as { code?: string } | undefined)?.code;
const cookieLine = (res: AgentReply, name: string): string | undefined =>
  res.headers.getSetCookie().find((line) => line.startsWith(`${name}=`));

function expectError(res: AgentReply, status: number, errorCode: string): void {
  expect({ status: res.status, code: code(res) }).toEqual({ status, code: errorCode });
}

/** The counts of the rate-limit rows of `label` (`<bucket>:<subject>`), one per window. */
async function limit(label: string): Promise<number[]> {
  const rows = await h.db.selectFrom('rate_limits').select('count').where('bucket_name', '=', label).orderBy('window_start').execute();
  return rows.map((r) => Number(r.count));
}

async function audits(action: string) {
  const rows = await h.db
    .selectFrom('audit_log')
    .select(['actor_type', 'actor_id', 'entity', 'entity_id', 'ip', 'meta'])
    .where('action', '=', action)
    .orderBy('seq')
    .execute();
  return rows.map((r) => ({ ...r, meta: JSON.parse(r.meta) as Record<string, unknown> }));
}

const account = async (id: string) => {
  const r = await h.db
    .selectFrom('staff_users')
    .select(['totp_secret_enc', 'totp_enabled', 'totp_last_step', 'totp_reenroll', 'mfa_required', 'last_login_at'])
    .where('id', '=', id)
    .executeTakeFirstOrThrow();
  return {
    secretEnc: r.totp_secret_enc,
    enabled: Number(r.totp_enabled),
    lastStep: Number(r.totp_last_step),
    reenroll: Number(r.totp_reenroll),
    mfaRequired: Number(r.mfa_required),
    lastLoginAt: r.last_login_at === null ? null : Number(r.last_login_at),
  };
};

const sessionsOf = (userId: string) =>
  h.db.selectFrom('sessions').select(['id', 'mfa_passed', 'remember_selector', 'reauth_at']).where('subject_id', '=', userId).execute();
const recoveryRows = (userId: string) =>
  h.db.selectFrom('staff_recovery_codes').select(['code_hash', 'used_at']).where('user_id', '=', userId).execute();
const hashOf = (userId: string, c: string): string => recoveryCodeHash(userId, normalizeRecoveryCode(c)!);
const sidOf = (b: Browser): string => b.agent.cookies.get(SID)!;

describe.skipIf(!ctx.available)(`auth API: 2FA and reauth [${engineLabel()}]`, () => {
  let dataDir: string;

  beforeAll(async () => {
    h = await testDb();
    dataDir = await fsp.mkdtemp(path.join(os.tmpdir(), 'altis-auth-mfa-'));
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

  describe('enrolment', () => {
    it('setup → a 20-byte secret and an otpauth URI, sealed in the row with totp_enabled 0; enable: a wrong code → 401, the right one → 10 codes and every session ended (S11)', async () => {
      const t = appAt();
      const budi = await staff({ username: 'budi' });
      const other = await signIn(t, budi, { remember: true }); // another browser, with a remember-me token
      const b = await signIn(t, budi, { stage: 'full' });

      const setup = await send(b, SETUP);
      expect(setup.status).toBe(200);
      expect(setup.headers.get('cache-control')).toBe('no-store');
      const { secret, otpauthUri } = setup.json as { secret: string; otpauthUri: string };
      const raw = base32Decode(secret);
      expect(raw).toHaveLength(20);
      expect(otpauthUri.startsWith('otpauth://totp/')).toBe(true);
      expect(otpauthUri).toBe(
        `otpauth://totp/Perpustakaan:budi?secret=${secret}&issuer=Perpustakaan&algorithm=SHA1&digits=6&period=30`,
      );
      const pending = await account(budi.id);
      expect(pending.secretEnc).toMatch(/^v1:/);
      expect(openValue(TEST_KEYRING, secretAad('staff_users', 'totp_secret_enc', budi.id), pending.secretEnc!)).toBe(secret);
      expect(pending.enabled).toBe(0);

      expectError(await send(b, ENABLE, { code: wrongCode(raw, NOW) }), 401, 'AUTH_MFA_INVALID');
      expect((await account(budi.id)).enabled).toBe(0);
      expect(await sessionsOf(budi.id)).toHaveLength(2);
      expect(await limit(`2fa:user:${budi.id}`)).toEqual([1]);

      const enable = await send(b, ENABLE, { code: totp(raw, STEP) });
      expect(enable.status).toBe(200);
      expect(enable.headers.get('cache-control')).toBe('no-store');
      const { codes } = enable.json as { codes: string[] };
      expect(codes).toHaveLength(10);
      expect(new Set(codes).size).toBe(10);
      for (const c of codes) expect(c).toMatch(RECOVERY_CODE);
      expect(await account(budi.id)).toMatchObject({ enabled: 1, lastStep: STEP, reenroll: 0 });
      const rows = await recoveryRows(budi.id);
      expect(rows.map((r) => r.code_hash).sort()).toEqual(codes.map((c) => hashOf(budi.id, c)).sort());
      expect(rows.every((r) => r.used_at === null)).toBe(true);
      const enabled = await audits('auth.2fa.enable');
      expect(enabled).toEqual([
        { actor_type: 'staff', actor_id: budi.id, entity: 'staff_users', entity_id: budi.id, ip: IP, meta: {} },
      ]);
      // The wrong code stays counted; the right one gave its hit back.
      expect(await limit(`2fa:user:${budi.id}`)).toEqual([1]);

      // S11, D22: every session of the user ends, the requester's included, and every remember-me token goes.
      expect(await sessionsOf(budi.id)).toEqual([]);
      expect(await countRows(h.db.selectFrom('remember_tokens'))).toBe(0);
      expect(cookieLine(enable, SID)).toMatch(/Max-Age=0/);
      expect(cookieLine(enable, RM)).toMatch(/Max-Age=0/);
      expect(b.agent.cookies.has(SID)).toBe(false);
      expect(((await other.agent.get(ME)).json as { authenticated: boolean }).authenticated).toBe(false);

      // The next sign-in asks for the code.
      t.clock.now = NOW + 30 * SEC;
      const again = await signIn(t, budi, { stage: 'mfa' });
      expect((await send(again, VERIFY, { code: totp(raw, STEP + 1) })).json).toEqual({ stage: 'full', mustChangePassword: false });
    });

    it('with 2FA enabled, setup again → 409 MFA_ALREADY_ENABLED; in stage mfa, setup and enable → 401 AUTH_MFA_REQUIRED', async () => {
      const t = appAt();
      const sari = await staff({ username: 'sari', totp: true });
      const before = (await account(sari.id)).secretEnc;
      const b = await signIn(t, sari, { stage: 'mfa' });
      expectError(await send(b, SETUP), 401, 'AUTH_MFA_REQUIRED');
      expectError(await send(b, ENABLE, { code: totp(sari.totpSecret!, STEP) }), 401, 'AUTH_MFA_REQUIRED');
      expect(await limit(`2fa:user:${sari.id}`)).toEqual([]);

      expect((await send(b, VERIFY, { code: totp(sari.totpSecret!, STEP) })).status).toBe(200);
      expectError(await send(b, SETUP), 409, 'MFA_ALREADY_ENABLED');
      expect((await account(sari.id)).secretEnc).toBe(before);
    });
  });

  describe('login with 2FA', () => {
    it('login → mfa and GET users → 401 AUTH_MFA_REQUIRED; verify with the login’s X-CSRF-Token and the step-s code → a new altis_sid and X-CSRF-Token, auth.login.success', async () => {
      const t = appAt();
      const sari = await staff({ username: 'sari', totp: true, roles: [{ key: 'super_admin' }] });
      const b = await signIn(t, sari, { stage: 'mfa' });
      const preSid = sidOf(b);
      const loginCsrf = b.csrf;

      expectError(await b.agent.get(USERS), 401, 'AUTH_MFA_REQUIRED');

      const res = await send(b, VERIFY, { code: totp(sari.totpSecret!, STEP) });
      expect(res.status).toBe(200);
      expect(res.json).toEqual({ stage: 'full', mustChangePassword: false });
      const sid = sidOf(b);
      expect(sid).not.toBe(preSid);
      expect(res.headers.get('x-csrf-token')).toBe(sessionCsrfFor(CONFIG, sid));
      expect(res.headers.get('x-csrf-token')).not.toBe(loginCsrf);
      expect(b.agent.cookies.get(DEV)).toMatch(/^[A-Za-z0-9_-]{22}\.[A-Za-z0-9_-]{22}$/);
      expect(cookieLine(res, RM)).toBeUndefined();

      const sessions = await sessionsOf(sari.id);
      const full = sessions.find((s) => s.id === sha256hex(sid));
      expect(Number(full?.mfa_passed)).toBe(1);
      expect(await account(sari.id)).toMatchObject({ lastStep: STEP, lastLoginAt: NOW });
      expect(await audits('auth.login.success')).toEqual([
        { actor_type: 'staff', actor_id: sari.id, entity: 'staff_users', entity_id: sari.id, ip: IP, meta: { stage: '2fa' } },
      ]);
      expect((await b.agent.get(USERS)).status).toBe(200);
      expect((await b.agent.get(ME)).json).toMatchObject({ authenticated: true, stage: 'full', superAdmin: true });

      // Replay: the same code in a new login.
      const second = await signIn(t, sari, { stage: 'mfa' });
      expectError(await send(second, VERIFY, { code: totp(sari.totpSecret!, STEP) }), 401, 'AUTH_MFA_INVALID');
      expect(await audits('auth.login.failed')).toEqual([
        { actor_type: 'staff', actor_id: sari.id, entity: 'staff_users', entity_id: sari.id, ip: IP, meta: { stage: '2fa' } },
      ]);
      expect(await audits('auth.login.success')).toHaveLength(1);
    });

    it('M3: a fresh user (totp_last_step 0) → the s−1 code is accepted; another fresh user’s s−2 code → 401', async () => {
      const t = appAt();
      const ani = await staff({ username: 'ani', totp: true });
      const eko = await staff({ username: 'eko', totp: true });
      expect((await account(ani.id)).lastStep).toBe(0);
      const a = await signIn(t, ani, { stage: 'mfa' });
      expect((await send(a, VERIFY, { code: totp(ani.totpSecret!, STEP - 1) })).status).toBe(200);
      expect((await account(ani.id)).lastStep).toBe(STEP - 1);
      const e = await signIn(t, eko, { stage: 'mfa' });
      expectError(await send(e, VERIFY, { code: totp(eko.totpSecret!, STEP - 2) }), 401, 'AUTH_MFA_INVALID');
      expect((await account(eko.id)).lastStep).toBe(0);
    });

    it('B9: verify with remember: true → altis_rm with mfa_bound 1 whose selector the rotated session records; logging that session out removes the token', async () => {
      const t = appAt();
      const sari = await staff({ username: 'sari', totp: true });
      const b = await signIn(t, sari, { remember: true, stage: 'mfa' });
      expect(b.agent.cookies.has(RM)).toBe(false); // no token before the second factor
      const res = await send(b, VERIFY, { code: totp(sari.totpSecret!, STEP), remember: true });
      expect(res.status).toBe(200);
      expect(cookieLine(res, RM)).toMatch(/Max-Age=2592000/);
      const selector = b.agent.cookies.get(RM)!.split('.')[0]!;
      const tokens = await h.db.selectFrom('remember_tokens').select(['selector', 'subject_id', 'mfa_bound']).execute();
      expect(tokens).toHaveLength(1);
      expect(tokens[0]).toMatchObject({ selector, subject_id: sari.id });
      expect(Number(tokens[0]!.mfa_bound)).toBe(1);
      const rotated = (await sessionsOf(sari.id)).find((s) => s.id === sha256hex(sidOf(b)));
      expect(rotated?.remember_selector).toBe(selector);

      // Revoking that session (auth/logout revokes it with the rest of its sign-in, revokeSessionLineage, as DELETE
      // auth/sessions/:id does) removes the token.
      expect((await send(b, LOGOUT)).status).toBe(204);
      expect(await countRows(h.db.selectFrom('remember_tokens'))).toBe(0);
    });

    it('logout lineage: a tab that still sends the pre-2FA cookie (in its 30 s grace) logs out → the verified session and the remember token moved onto it end too', async () => {
      const t = appAt();
      const sari = await staff({ username: 'sari', totp: true });
      const b = await signIn(t, sari, { stage: 'mfa' });
      const preSid = sidOf(b);
      const preCsrf = b.csrf;
      expect((await send(b, VERIFY, { code: totp(sari.totpSecret!, STEP), remember: true })).status).toBe(200);
      expect(await sessionsOf(sari.id)).toHaveLength(2); // the verified session and the pre-2FA one in its grace
      expect(await countRows(h.db.selectFrom('remember_tokens'))).toBe(1);

      // Another tab of the browser, whose request left before the verify answered.
      t.clock.now = NOW + 10 * SEC;
      const tab = createAgent(t.app, { peer: IP });
      tab.setCookie(SID, preSid);
      const out = await tab.post(LOGOUT, undefined, { 'x-csrf-token': preCsrf });
      expect(out.status).toBe(204);
      expect(await sessionsOf(sari.id)).toEqual([]);
      expect(await countRows(h.db.selectFrom('remember_tokens'))).toBe(0);
      expect(await audits('auth.logout')).toHaveLength(1);
      expect(((await b.agent.get(ME)).json as { authenticated: boolean }).authenticated).toBe(false);
    });

    it('a body with both or neither of code and recoveryCode → 422; in stage full, verify changes nothing → 200 {stage: full}', async () => {
      const t = appAt();
      const sari = await staff({ username: 'sari', totp: true });
      const b = await signIn(t, sari, { stage: 'mfa' });
      expectError(await send(b, VERIFY, { code: '123456', recoveryCode: 'AAAAA-AAAAA' }), 422, 'VALIDATION_FAILED');
      expectError(await send(b, VERIFY, { remember: true }), 422, 'VALIDATION_FAILED');
      expectError(await send(b, VERIFY, { code: '12345' }), 422, 'VALIDATION_FAILED');
      expect(await countRows(h.db.selectFrom('rate_limits').where('bucket_name', 'like', '2fa:%'))).toBe(0);

      const budi = await staff({ username: 'budi' });
      const full = await signIn(t, budi, { stage: 'full' });
      const sid = sidOf(full);
      const res = await send(full, VERIFY, { code: '000000' });
      expect(res.status).toBe(200);
      expect(res.json).toEqual({ stage: 'full', mustChangePassword: false });
      expect(sidOf(full)).toBe(sid);
      expect(await audits('auth.login.failed')).toEqual([]);
    });
  });

  describe('lockouts', () => {
    it('S10: five wrong codes sent as the SPA sends them (the session’s X-CSRF-Token) → the fifth deletes the session, clears altis_sid and answers 401 AUTH_REQUIRED', async () => {
      const t = appAt();
      const sari = await staff({ username: 'sari', totp: true });
      const b = await signIn(t, sari, { stage: 'mfa' });
      const sessionId = sha256hex(sidOf(b));
      expect(b.csrf).toBe(sessionCsrfFor(CONFIG, sidOf(b))); // what the login answered with, as the SPA keeps it
      const bad = wrongCode(sari.totpSecret!, NOW);
      for (let i = 1; i <= 4; i += 1) {
        const res = await send(b, VERIFY, { code: bad });
        expectError(res, 401, 'AUTH_MFA_INVALID');
        expect(cookieLine(res, SID)).toBeUndefined();
        expect((await sessionsOf(sari.id)).map((s) => s.id)).toEqual([sessionId]);
      }
      const fifth = await send(b, VERIFY, { code: bad });
      expectError(fifth, 401, 'AUTH_REQUIRED');
      expect(fifth.headers.get('content-type')).toBe('application/problem+json');
      expect(cookieLine(fifth, SID)).toMatch(/Max-Age=0/);
      expect(b.agent.cookies.has(SID)).toBe(false);
      expect(await sessionsOf(sari.id)).toEqual([]);
      expect(await limit(`2fa:session:${sessionId}`)).toEqual([5]);
      const failed = await audits('auth.login.failed');
      expect(failed).toHaveLength(5);
      expect(failed.every((a) => a.entity_id === sari.id && a.meta['stage'] === '2fa')).toBe(true);

      // Told that the session ended, the SPA starts over from auth/me (a pre-session token); even the right code is late.
      const me = await b.agent.get(ME);
      expect(me.json).toMatchObject({ authenticated: false });
      b.csrf = (me.json as { csrfToken: string }).csrfToken;
      expectError(await send(b, VERIFY, { code: totp(sari.totpSecret!, STEP) }), 401, 'AUTH_REQUIRED');
      expect(await audits('auth.login.success')).toEqual([]);
    });

    it('2fa:user: ten wrong codes across three sessions within 15 min → the eleventh, even the right code, → 429 with Retry-After', async () => {
      const t = appAt();
      const sari = await staff({ username: 'sari', totp: true });
      const bad = wrongCode(sari.totpSecret!, NOW);
      let last: Browser | undefined;
      for (const attempts of [4, 4, 2]) {
        last = await signIn(t, sari, { stage: 'mfa' });
        for (let i = 0; i < attempts; i += 1) expectError(await send(last, VERIFY, { code: bad }), 401, 'AUTH_MFA_INVALID');
      }
      const res = await send(last!, VERIFY, { code: totp(sari.totpSecret!, STEP) });
      expectError(res, 429, 'AUTH_TOO_MANY_ATTEMPTS');
      expect(res.headers.get('retry-after')).toBe('895'); // the rest of the 15-minute window that began at 09:00:00
      expect(await limit(`2fa:user:${sari.id}`)).toEqual([11]);
      expect(await audits('auth.login.failed')).toHaveLength(10);
      expect((await account(sari.id)).lastStep).toBe(0);
    });

    it('a right code gives its 2fa:user hit back (as a login gives its buckets back): eleven sign-ins with a code within 15 min all pass', async () => {
      const t = appAt();
      const sari = await staff({ username: 'sari', totp: true });
      for (let i = 0; i < 11; i += 1) {
        t.clock.now = NOW + i * 30 * SEC;
        await fullSignIn(t, sari, STEP + i);
      }
      expect(await limit(`2fa:user:${sari.id}`)).toEqual([0]);
      expect(await audits('auth.login.success')).toHaveLength(11);
    });

    it('a recovery code that signs in keeps its recovery:user hit (5 per hour, used or not)', async () => {
      const t = appAt();
      const sari = await staff({ username: 'sari', totp: true });
      const codes = await seedRecoveryCodes(sari.id);
      expect((await send(await signIn(t, sari, { stage: 'mfa' }), VERIFY, { recoveryCode: codes[0] })).status).toBe(200);
      expect(await limit(`recovery:user:${sari.id}`)).toEqual([1]);
    });
  });

  describe('recovery codes', () => {
    it('a recovery code signs in once; its second use → 401; the sixth recovery attempt within the hour → 429', async () => {
      const t = appAt();
      const sari = await staff({ username: 'sari', totp: true });
      const codes = await seedRecoveryCodes(sari.id);

      const first = await signIn(t, sari, { stage: 'mfa' });
      // As typed on a phone: lower case, spaces around.
      const ok = await send(first, VERIFY, { recoveryCode: ` ${codes[0]!.toLowerCase()} ` });
      expect(ok.status).toBe(200);
      expect(ok.json).toEqual({ stage: 'full', mustChangePassword: false });
      expect(await audits('auth.login.success')).toEqual([expect.objectContaining({ entity_id: sari.id, meta: { stage: 'recovery' } })]);
      const used = (await recoveryRows(sari.id)).filter((r) => r.used_at !== null);
      expect(used).toEqual([{ code_hash: hashOf(sari.id, codes[0]!), used_at: expect.anything() }]);
      expect(Number(used[0]!.used_at)).toBe(NOW);

      const second = await signIn(t, sari, { stage: 'mfa' });
      expectError(await send(second, VERIFY, { recoveryCode: codes[0] }), 401, 'AUTH_MFA_INVALID');
      expect(await audits('auth.login.failed')).toEqual([expect.objectContaining({ entity_id: sari.id, meta: { stage: 'recovery' } })]);
      for (let i = 0; i < 3; i += 1) expectError(await send(second, VERIFY, { recoveryCode: 'AAAAA-AAAAA' }), 401, 'AUTH_MFA_INVALID');

      const sixth = await send(second, VERIFY, { recoveryCode: codes[1] });
      expectError(sixth, 429, 'AUTH_TOO_MANY_ATTEMPTS');
      expect(sixth.headers.get('retry-after')).toBe('3595');
      expect(await limit(`recovery:user:${sari.id}`)).toEqual([6]);
      expect(await limit(`2fa:user:${sari.id}`)).toEqual([]);
      expect((await recoveryRows(sari.id)).filter((r) => r.used_at !== null)).toHaveLength(1);
    });
  });

  describe('enrolment forced by a role', () => {
    it('mfa_setup: verify → 401; setup and enable in the partial session → 10 codes and the session ends; a new login → mfa, and a code → full', async () => {
      const t = appAt();
      const dewi = await staff({ username: 'dewi', roles: [{ permissions: ['system.audit.read'], mfaRequired: true }] });
      const b = await signIn(t, dewi, { stage: 'mfa_setup' });
      expectError(await send(b, VERIFY, { code: '123456' }), 401, 'AUTH_MFA_REQUIRED');
      expectError(await b.agent.get(USERS), 401, 'AUTH_MFA_REQUIRED');

      const setup = await send(b, SETUP);
      expect(setup.status).toBe(200);
      const raw = base32Decode((setup.json as { secret: string }).secret);
      const enable = await send(b, ENABLE, { code: totp(raw, STEP) });
      expect(enable.status).toBe(200);
      expect((enable.json as { codes: string[] }).codes).toHaveLength(10);
      expect(await sessionsOf(dewi.id)).toEqual([]);
      expect(b.agent.cookies.has(SID)).toBe(false);
      expect(await audits('auth.login.success')).toEqual([]);

      t.clock.now = NOW + 30 * SEC;
      const again = await signIn(t, dewi, { stage: 'mfa' });
      const res = await send(again, VERIFY, { code: totp(raw, STEP + 1) });
      expect(res.json).toEqual({ stage: 'full', mustChangePassword: false });
      expect((await again.agent.get(ME)).json).toMatchObject({ stage: 'full', permissions: ['system.audit.read'] });
    });
  });

  describe('re-enrolment after a restore (totp_reenroll)', () => {
    it('login → recovery; a TOTP code → 401; a recovery code → mfa_setup, the secret cleared and 2FA required; then enrolment works', async () => {
      const t = appAt();
      const sari = await staff({ username: 'sari', totp: true, totpReenroll: true });
      const codes = await seedRecoveryCodes(sari.id);
      const other = await sessionCookieFor(h, sari.id, { now: NOW });
      const b = await signIn(t, sari, { stage: 'recovery' });

      expectError(await send(b, VERIFY, { code: totp(sari.totpSecret!, STEP) }), 401, 'AUTH_MFA_INVALID');
      expect((await account(sari.id)).lastStep).toBe(0);

      const res = await send(b, VERIFY, { recoveryCode: codes[3] });
      expect(res.status).toBe(200);
      expect(res.json).toEqual({ stage: 'mfa_setup', mustChangePassword: false });
      expect(await account(sari.id)).toMatchObject({ secretEnc: null, enabled: 0, reenroll: 0, mfaRequired: 1 });
      expect(await recoveryRows(sari.id)).toEqual([]);
      // Still the pre-2FA session, now in stage mfa_setup; the user's other sessions are gone.
      expect((await sessionsOf(sari.id)).map((s) => s.id)).toEqual([sha256hex(sidOf(b))]);
      expect((await sessionsOf(sari.id)).map((s) => s.id)).not.toContain(sha256hex(other));
      expect((await b.agent.get(ME)).json).toMatchObject({ stage: 'mfa_setup', permissions: [] });
      expect(await audits('auth.login.success')).toEqual([]);
      // The reset of the old 2FA is audited (controller ruling: auth.2fa.disable, reason reenroll).
      expect(await audits('auth.2fa.disable')).toEqual([
        { actor_type: 'staff', actor_id: sari.id, entity: 'staff_users', entity_id: sari.id, ip: IP, meta: { reason: 'reenroll' } },
      ]);

      const setup = await send(b, SETUP);
      const raw = base32Decode((setup.json as { secret: string }).secret);
      expect((await send(b, ENABLE, { code: totp(raw, STEP) })).status).toBe(200);
      expect(await account(sari.id)).toMatchObject({ enabled: 1, mfaRequired: 1 });
    });
  });

  describe('disable', () => {
    it('password and code → 2FA off, the recovery codes deleted, auth.2fa.disable, every session and token gone (S11)', async () => {
      const t = appAt();
      const sari = await staff({ username: 'sari', totp: true });
      await seedRecoveryCodes(sari.id);
      const b = await fullSignIn(t, sari, STEP);
      const other = await signIn(t, sari, { remember: true, stage: 'mfa' });
      t.clock.now = NOW + 30 * SEC;
      expect((await send(other, VERIFY, { code: totp(sari.totpSecret!, STEP + 1), remember: true })).status).toBe(200);
      expect(await countRows(h.db.selectFrom('remember_tokens'))).toBe(1);

      t.clock.now = NOW + 60 * SEC;
      const res = await send(b, DISABLE, { password: sari.password, code: totp(sari.totpSecret!, STEP + 2) });
      expect(res.status).toBe(204);
      expect(await account(sari.id)).toMatchObject({ secretEnc: null, enabled: 0 });
      expect(await recoveryRows(sari.id)).toEqual([]);
      expect(await audits('auth.2fa.disable')).toEqual([
        { actor_type: 'staff', actor_id: sari.id, entity: 'staff_users', entity_id: sari.id, ip: IP, meta: {} },
      ]);
      expect(await sessionsOf(sari.id)).toEqual([]);
      expect(await countRows(h.db.selectFrom('remember_tokens'))).toBe(0);
      expect(cookieLine(res, SID)).toMatch(/Max-Age=0/);
      expect(cookieLine(res, RM)).toMatch(/Max-Age=0/);
      // Two verifies and the disable, each with a right code: every 2fa:user hit given back.
      expect(await limit(`2fa:user:${sari.id}`)).toEqual([0]);

      // The next login needs no code.
      expect((await signIn(t, sari)).agent.cookies.has(SID)).toBe(true);
    });

    it('a wrong password → 401 AUTH_INVALID_CREDENTIALS, a wrong code → 401 AUTH_MFA_INVALID; nothing changes', async () => {
      const t = appAt();
      const sari = await staff({ username: 'sari', totp: true });
      await seedRecoveryCodes(sari.id);
      const b = await fullSignIn(t, sari, STEP);
      t.clock.now = NOW + 30 * SEC;
      const before = await account(sari.id);

      expectError(await send(b, DISABLE, { password: `${sari.password}x`, code: totp(sari.totpSecret!, STEP + 1) }), 401, 'AUTH_INVALID_CREDENTIALS');
      expectError(await send(b, DISABLE, { password: sari.password, code: wrongCode(sari.totpSecret!, t.clock.now) }), 401, 'AUTH_MFA_INVALID');
      expect(await account(sari.id)).toEqual(before);
      expect(await recoveryRows(sari.id)).toHaveLength(10);
      expect(await sessionsOf(sari.id)).toHaveLength(2); // the full session and the rotated-away one in its grace
      expect(await audits('auth.2fa.disable')).toEqual([]);
      expect((await audits('auth.login.failed')).map((a) => a.meta)).toEqual([{ stage: 'reauth' }, { stage: 'reauth' }]);
      // The two failures; the verify of the sign-in gave its hit back.
      expect(await limit(`2fa:user:${sari.id}`)).toEqual([2]);

      // The code of the failed attempt with the wrong password was not used up.
      expect((await send(b, DISABLE, { password: sari.password, code: totp(sari.totpSecret!, STEP + 1) })).status).toBe(204);
    });

    it('2FA required by a role or by the user flag → 409 MFA_REQUIRED_BY_POLICY; without 2FA → 409 MFA_NOT_ENABLED', async () => {
      const t = appAt();
      const dewi = await staff({ username: 'dewi', totp: true, roles: [{ permissions: ['system.audit.read'], mfaRequired: true }] });
      const rina = await staff({ username: 'rina', totp: true, mfaRequired: true });
      for (const user of [dewi, rina]) {
        const b = await fullSignIn(t, user, STEP);
        expectError(
          await send(b, DISABLE, { password: user.password, code: totp(user.totpSecret!, STEP + 1) }),
          409,
          'MFA_REQUIRED_BY_POLICY',
        );
        expect((await account(user.id)).enabled).toBe(1);
        expect(await sessionsOf(user.id)).not.toEqual([]);
      }
      const budi = await staff({ username: 'budi' });
      const b = await signIn(t, budi, { stage: 'full' });
      expectError(await send(b, DISABLE, { password: budi.password, code: '123456' }), 409, 'MFA_NOT_ENABLED');
      expect(await audits('auth.2fa.disable')).toEqual([]);
    });
  });

  describe('recovery-code regeneration', () => {
    it('without a fresh reauth → 401 AUTH_REAUTH_REQUIRED; after reauth → 10 new codes and auth.2fa.recovery_codes; the old codes fail', async () => {
      const t = appAt();
      const sari = await staff({ username: 'sari', totp: true });
      const old = await seedRecoveryCodes(sari.id);
      const b = await fullSignIn(t, sari, STEP);
      expectError(await send(b, RECOVERY_CODES), 401, 'AUTH_REAUTH_REQUIRED');

      t.clock.now = NOW + 30 * SEC;
      expect((await send(b, REAUTH, { password: sari.password, code: totp(sari.totpSecret!, STEP + 1) })).status).toBe(200);
      const res = await send(b, RECOVERY_CODES);
      expect(res.status).toBe(200);
      expect(res.headers.get('cache-control')).toBe('no-store');
      const { codes } = res.json as { codes: string[] };
      expect(codes).toHaveLength(10);
      for (const c of codes) expect(c).toMatch(RECOVERY_CODE);
      expect(codes.filter((c) => old.includes(c))).toEqual([]);
      expect((await recoveryRows(sari.id)).map((r) => r.code_hash).sort()).toEqual(codes.map((c) => hashOf(sari.id, c)).sort());
      expect(await audits('auth.2fa.recovery_codes')).toEqual([
        { actor_type: 'staff', actor_id: sari.id, entity: 'staff_users', entity_id: sari.id, ip: IP, meta: {} },
      ]);
      expect(await sessionsOf(sari.id)).not.toEqual([]); // nothing is revoked

      const next = await signIn(t, sari, { stage: 'mfa' });
      expectError(await send(next, VERIFY, { recoveryCode: old[0] }), 401, 'AUTH_MFA_INVALID');
      expect((await send(next, VERIFY, { recoveryCode: codes[0] })).status).toBe(200);
    });
  });

  describe('reauth', () => {
    it('password and code → reauth_at = now and {reauthUntil}; a reauth route then passes until +300 s, not after', async () => {
      const t = appAt();
      const sari = await staff({ username: 'sari', totp: true });
      const b = await fullSignIn(t, sari, STEP);
      const at = NOW + 30 * SEC;
      t.clock.now = at;
      const res = await send(b, REAUTH, { password: sari.password, code: totp(sari.totpSecret!, STEP + 1) });
      expect(res.status).toBe(200);
      expect(res.json).toEqual({ reauthUntil: at + 300 * SEC });
      expect((await sessionsOf(sari.id)).find((s) => s.id === sha256hex(sidOf(b)))?.reauth_at).toEqual(expect.anything());
      expect(Number((await sessionsOf(sari.id)).find((s) => s.id === sha256hex(sidOf(b)))!.reauth_at)).toBe(at);
      expect((await account(sari.id)).lastStep).toBe(STEP + 1);
      expect((await b.agent.get(ME)).json).toMatchObject({ reauthUntil: at + 300 * SEC });

      t.clock.now = at + 300 * SEC;
      expect((await send(b, RECOVERY_CODES)).status).toBe(200);
      t.clock.now = at + 300 * SEC + 1;
      expectError(await send(b, RECOVERY_CODES), 401, 'AUTH_REAUTH_REQUIRED');
      expect(await audits('auth.login.failed')).toEqual([]);
    });

    it('six wrong passwords within 15 min → each of the first five 401 with auth.login.failed {stage: reauth}, the sixth (even right) → 429', async () => {
      const t = appAt();
      const budi = await staff({ username: 'budi' });
      const b = await signIn(t, budi, { stage: 'full' });
      for (let i = 0; i < 5; i += 1) {
        expectError(await send(b, REAUTH, { password: `salah-sandi-${i}` }), 401, 'AUTH_INVALID_CREDENTIALS');
      }
      const sixth = await send(b, REAUTH, { password: budi.password });
      expectError(sixth, 429, 'AUTH_TOO_MANY_ATTEMPTS');
      expect(sixth.headers.get('retry-after')).toBe('895');
      expect(await limit(`reauth:session:${sha256hex(sidOf(b))}`)).toEqual([6]);
      const failed = await audits('auth.login.failed');
      expect(failed).toHaveLength(5);
      expect(failed[0]).toEqual({ actor_type: 'staff', actor_id: budi.id, entity: 'staff_users', entity_id: budi.id, ip: IP, meta: { stage: 'reauth' } });
      expect((await sessionsOf(budi.id))[0]!.reauth_at).toBeNull();
    });

    it('a right password gives its reauth:session hit back: six reauths of one session within 15 min all pass', async () => {
      const t = appAt();
      const budi = await staff({ username: 'budi' });
      const b = await signIn(t, budi, { stage: 'full' });
      for (let i = 0; i < 6; i += 1) {
        t.clock.now = NOW + i * 60 * SEC;
        expect((await send(b, REAUTH, { password: budi.password })).status).toBe(200);
      }
      expect(await limit(`reauth:session:${sha256hex(sidOf(b))}`)).toEqual([0]);
    });

    it('a TOTP user without a code → 401 AUTH_MFA_INVALID (audited); a user without 2FA needs only the password', async () => {
      const t = appAt();
      const sari = await staff({ username: 'sari', totp: true });
      const b = await fullSignIn(t, sari, STEP);
      t.clock.now = NOW + 30 * SEC;
      expectError(await send(b, REAUTH, { password: sari.password }), 401, 'AUTH_MFA_INVALID');
      expect((await audits('auth.login.failed')).map((a) => a.meta)).toEqual([{ stage: 'reauth' }]);
      expect((await sessionsOf(sari.id)).every((s) => s.reauth_at === null)).toBe(true);

      const budi = await staff({ username: 'budi' });
      const plain = await signIn(t, budi, { stage: 'full' });
      const res = await send(plain, REAUTH, { password: budi.password });
      expect(res.status).toBe(200);
      expect(res.json).toEqual({ reauthUntil: NOW + 30 * SEC + 300 * SEC });
    });

    it('a pre-2FA session cannot reauth or reach the full-session 2FA routes → 401 AUTH_MFA_REQUIRED', async () => {
      const t = appAt();
      const sari = await staff({ username: 'sari', totp: true });
      const b = await signIn(t, sari, { stage: 'mfa' });
      expectError(await send(b, REAUTH, { password: sari.password }), 401, 'AUTH_MFA_REQUIRED');
      expectError(await send(b, DISABLE, { password: sari.password, code: '123456' }), 401, 'AUTH_MFA_REQUIRED');
      expectError(await send(b, RECOVERY_CODES), 401, 'AUTH_MFA_REQUIRED');
      expect(await countRows(h.db.selectFrom('rate_limits').where('bucket_name', 'like', 'reauth:%'))).toBe(0);
    });
  });
});
