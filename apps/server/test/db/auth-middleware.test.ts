import fsp from 'node:fs/promises';
import os from 'node:os';
import path from 'node:path';
import {
  bumpAuthzVersion,
  findSession,
  issueRememberToken,
  lockStaffRow,
  mfaNeeded,
  revokeSubject,
  rotateSession,
  sha256hex,
  stageOf,
  writeSettings,
  type Grants,
  type StaffAuthView,
} from '@altis/core';
import { PHASE1_MIGRATIONS, runMigrations, withTx } from '@altis/db';
import { DomainError, newId } from '@altis/shared';
import { afterAll, beforeAll, beforeEach, describe, expect, it, vi } from 'vitest';
import { engineLabel, testDb, testDbContext, type TestDbHandle } from '../../../../tools/test/test-db.js';
import { createApp } from '../../src/app.js';
import { defineRoutes, route, type RouteDecl } from '../../src/http/route.js';
import { createAgent, type Agent, type AgentReply } from '../agent.js';
import { recordingLogger, sampleConfig } from '../support.js';
import { seedStaff, sessionCookieFor, sessionCsrfFor, type SeedStaffOptions } from '../support-auth.js';

// Steps 7 and 9 of the chain (spec §4.7, §7.1-7.3) on the engine picked by ALTIS_TEST_DB:
// - step 7 resolves the `altis_sid` session: the staff user (active only), the grants at the user's authz_version, a
//   token rotation when the rights changed (the old token keeps working for 30 s, Review Focus 3), and the touch of
//   `last_seen_at` (at most once per 60 s, never for `X-Altis-Background: 1`);
// - step 9 decides from the declaration: session, 2FA stage, pending password change, permission (branch-scoped
//   through `branchParam`; a `system.*` denial audited once per minute), reauth within 5 minutes.
// Under the test profile every step-9 denial carries `X-Altis-Test-Gate: <code>` (B7), and a request that passed step 9
// (or a `session: 'none'` route, which skips it) carries `X-Altis-Test-Gate: PASSED` (T31): a response without the
// header never reached the gate.

// findSession wrapped in a spy (calling the real one), for the `session: 'none'` case; lockStaffRow and rotateSession
// likewise, for the order of the rotation's statements (T10).
vi.mock('@altis/core', async (importOriginal) => {
  const actual = await importOriginal<typeof import('@altis/core')>();
  return {
    ...actual,
    findSession: vi.fn(actual.findSession),
    lockStaffRow: vi.fn(actual.lockStaffRow),
    rotateSession: vi.fn(actual.rotateSession),
  };
});

const ctx = testDbContext();
let h: TestDbHandle;

const SEC = 1000;
const MIN = 60 * SEC;
/** 5 s into a minute (M26), so that the one-minute `authz-denied` window does not turn over within a test. */
const NOW = Date.UTC(2026, 9, 27, 10, 30, 5);
const CONFIG = sampleConfig();
/** baseUrl is https: the session cookie is `__Host-altis_sid`. */
const SID = '__Host-altis_sid';

const echo = async (rc: { auth: { subjectId: string; stage: string } | null; actor: unknown }) => ({
  body: { subjectId: rc.auth?.subjectId ?? null, stage: rc.auth?.stage ?? null, actor: rc.actor },
});

const ROUTES: RouteDecl[] = defineRoutes([
  route({ id: 't.perm', method: 'GET', path: '/api/v1/_t/perm', permission: 'system.users.read', idempotency: 'none', audit: null, handler: echo }),
  route({
    id: 't.perm.write',
    method: 'POST',
    path: '/api/v1/_t/perm',
    permission: 'system.users.read',
    idempotency: 'none',
    audit: null,
    handler: async () => ({ body: { wrote: true } }),
  }),
  route({ id: 't.pub', method: 'GET', path: '/api/v1/_t/pub', public: true, idempotency: 'none', audit: null, handler: echo }),
  route({
    id: 't.pubs',
    method: 'GET',
    path: '/api/v1/_t/pubs',
    public: true,
    session: 'required',
    idempotency: 'none',
    audit: null,
    handler: echo,
  }),
  route({
    id: 't.partial',
    method: 'GET',
    path: '/api/v1/_t/partial',
    public: true,
    session: 'required',
    partialAuth: true,
    idempotency: 'none',
    audit: null,
    handler: echo,
  }),
  route({
    id: 'auth.password.change',
    method: 'GET',
    path: '/api/v1/_t/password-change',
    public: true,
    session: 'required',
    idempotency: 'none',
    audit: null,
    handler: echo,
  }),
  route({
    id: 't.branch',
    method: 'GET',
    path: '/api/v1/_t/branches/:branchId',
    permission: 'test.branch.manage',
    branchParam: 'branchId',
    idempotency: 'none',
    audit: null,
    handler: echo,
  }),
  route({
    id: 't.reauth',
    method: 'GET',
    path: '/api/v1/_t/reauth',
    permission: 'system.settings.read',
    reauth: true,
    idempotency: 'none',
    audit: null,
    handler: echo,
  }),
  route({
    id: 't.handler403',
    method: 'GET',
    path: '/api/v1/_t/handler403',
    public: true,
    session: 'required',
    idempotency: 'none',
    audit: null,
    handler: async () => {
      throw new DomainError('AUTHZ_DENIED');
    },
  }),
  route({
    id: 't.none',
    method: 'GET',
    path: '/t/none',
    public: true,
    session: 'none',
    idempotency: 'none',
    audit: null,
    handler: async (rc) => ({ body: { auth: rc.auth } }),
  }),
  // Ruling R1b-1.
  route({
    id: 't.own-response',
    method: 'GET',
    path: '/api/v1/_t/own-response',
    permission: 'system.users.read',
    idempotency: 'none',
    audit: null,
    handler: async () =>
      new Response('own', {
        status: 202,
        headers: [
          ['Content-Type', 'text/plain; charset=utf-8'],
          ['X-Own', 'yes'],
          ['Set-Cookie', 'own_a=1; Path=/'],
          ['Set-Cookie', 'own_b=2; Path=/'],
        ],
      }),
  }),
  route({
    id: 't.context-response',
    method: 'GET',
    path: '/api/v1/_t/context-response',
    permission: 'system.users.read',
    idempotency: 'none',
    audit: null,
    handler: async (rc) => {
      rc.c.header('Set-Cookie', 'ctx=1; Path=/', { append: true });
      return rc.c.json({ via: 'context' }, 200, { 'X-Own': 'yes' });
    },
  }),
  route({ id: 't.page', method: 'GET', path: '/t/page', permission: 'system.users.read', idempotency: 'none', audit: null, handler: echo }),
  route({
    id: 't.leak',
    method: 'POST',
    path: '/api/v1/_t/leak',
    permission: 'system.users.read',
    idempotency: 'none',
    audit: null,
    handler: async (rc) => {
      // What a login handler does before a later statement fails: its transaction rolls back, so must the cookie.
      rc.c.header('Set-Cookie', 'leak=1; Path=/', { append: true });
      rc.c.header('X-Handler', 'yes');
      throw new DomainError('CONFLICT_STALE');
    },
  }),
]);

/** The app on a fake clock that the test moves. */
function appAt(start: number) {
  const clock = { now: start };
  const app = createApp({
    state: { phase: 'ready', db: h, config: CONFIG },
    version: '0.1.0',
    buildId: 'b',
    log: recordingLogger(),
    routes: ROUTES,
    clock: () => clock.now,
  });
  return { app, clock, agent: (token?: string): Agent => withSid(createAgent(app), token) };
}

function withSid(agent: Agent, token: string | undefined): Agent {
  if (token !== undefined) agent.setCookie(SID, token);
  return agent;
}

const code = (res: AgentReply): string | undefined => (res.json as { code?: string } | undefined)?.code;
const gate = (res: AgentReply): string | null => res.headers.get('x-altis-test-gate');

/** The `altis_sid` value a response sets ('' when it clears it), or undefined when it sets none. */
function sidSet(res: AgentReply): string | undefined {
  for (const line of res.headers.getSetCookie()) {
    if (line.startsWith(`${SID}=`)) return line.slice(SID.length + 1).split(';')[0];
  }
  return undefined;
}

let serial = 0;
/** A staff user with a unique username. */
function staff(o: Omit<SeedStaffOptions, 'username'> = {}) {
  serial += 1;
  return seedStaff(h, { username: `staf${serial}_${newId().slice(-6)}`, now: NOW, ...o });
}

const deniedRows = (userId: string) =>
  h.db.selectFrom('audit_log').select(['actor_type', 'actor_id', 'meta']).where('action', '=', 'authz.denied').where('actor_id', '=', userId).execute();

const sessionRow = (token: string) =>
  h.db.selectFrom('sessions').select(['last_seen_at', 'expires_at', 'authz_version']).where('id', '=', sha256hex(token)).executeTakeFirst();

describe.skipIf(!ctx.available)(`session resolution and declarative authorization [${engineLabel()}]`, () => {
  let dataDir: string;

  beforeAll(async () => {
    h = await testDb();
    dataDir = await fsp.mkdtemp(path.join(os.tmpdir(), 'altis-auth-middleware-'));
    await runMigrations(h, { appVersion: '0.1.0', dataDir, migrations: PHASE1_MIGRATIONS });
  });

  afterAll(async () => {
    await h?.close();
    if (dataDir !== undefined) await fsp.rm(dataDir, { recursive: true, force: true });
  });

  beforeEach(async () => {
    await h.db.deleteFrom('sessions').execute();
    await h.db.deleteFrom('rate_limits').execute();
    await h.db.deleteFrom('settings').execute();
    vi.mocked(findSession).mockClear();
    vi.mocked(lockStaffRow).mockClear();
    vi.mocked(rotateSession).mockClear();
  });

  describe('no cookie (GET routes: a POST would fail CSRF at step 8 first, M27)', () => {
    it('a permission route → 401 AUTH_REQUIRED with X-Altis-Test-Gate; pub → 200 with PASSED; pub+s → 401', async () => {
      const t = appAt(NOW);
      const perm = await t.agent().get('/api/v1/_t/perm');
      expect(perm.status).toBe(401);
      expect(code(perm)).toBe('AUTH_REQUIRED');
      expect(gate(perm)).toBe('AUTH_REQUIRED');

      const pub = await t.agent().get('/api/v1/_t/pub');
      expect(pub.status).toBe(200);
      expect(gate(pub)).toBe('PASSED');
      expect(pub.json).toEqual({ subjectId: null, stage: null, actor: { type: 'anonymous', id: null, ip: '203.0.113.10' } });

      const pubs = await t.agent().get('/api/v1/_t/pubs');
      expect(pubs.status).toBe(401);
      expect(code(pubs)).toBe('AUTH_REQUIRED');
      expect(gate(pubs)).toBe('AUTH_REQUIRED');
    });

    it("a handler's own 401/403 carries X-Altis-Test-Gate: PASSED, never a denial code (B7)", async () => {
      const user = await staff();
      const t = appAt(NOW);
      const res = await t.agent(await sessionCookieFor(h, user.id, { now: NOW })).get('/api/v1/_t/handler403');
      expect(res.status).toBe(403);
      expect(code(res)).toBe('AUTHZ_DENIED');
      expect(gate(res)).toBe('PASSED');
    });

    it('a refusal before the gate carries no X-Altis-Test-Gate (a 404 of no route, a CSRF refusal at step 8)', async () => {
      const t = appAt(NOW);
      const missing = await t.agent().get('/api/v1/_t/no-such-route');
      expect(missing.status).toBe(404);
      expect(gate(missing)).toBeNull();
      const user = await staff({ roles: [{ permissions: ['system.users.read'] }] });
      const csrf = await t.agent(await sessionCookieFor(h, user.id, { now: NOW })).post('/api/v1/_t/perm', {}, { 'x-csrf-token': 'wrong' });
      expect(code(csrf)).toBe('CSRF_INVALID');
      expect(gate(csrf)).toBeNull();
      expect(gate(await t.agent().get('/t/none'))).toBe('PASSED');
    });

    it('a stale altis_sid cookie counts as none and is cleared', async () => {
      const t = appAt(NOW);
      const pub = await t.agent('s'.repeat(43)).get('/api/v1/_t/pub');
      expect(pub.status).toBe(200);
      expect(sidSet(pub)).toBe('');
      expect(pub.headers.getSetCookie().find((l) => l.startsWith(`${SID}=`))).toContain('Max-Age=0');

      const pubs = await t.agent('s'.repeat(43)).get('/api/v1/_t/pubs');
      expect(pubs.status).toBe(401);
      expect(code(pubs)).toBe('AUTH_REQUIRED');
      expect(sidSet(pubs)).toBe(''); // the clearing survives the error response
    });
  });

  describe('a full session', () => {
    it('resolves the staff user: subject, stage full, a staff actor', async () => {
      const user = await staff({ roles: [{ permissions: ['system.users.read'] }] });
      const t = appAt(NOW);
      const res = await t.agent(await sessionCookieFor(h, user.id, { now: NOW })).get('/api/v1/_t/perm');
      expect(res.status).toBe(200);
      expect(gate(res)).toBe('PASSED');
      expect(res.json).toEqual({ subjectId: user.id, stage: 'full', actor: { type: 'staff', id: user.id, ip: '203.0.113.10' } });
    });
  });

  describe('pre-2FA session', () => {
    it('a partialAuth route → 200; any other → 401 AUTH_MFA_REQUIRED', async () => {
      const user = await staff({ totp: true, roles: [{ key: 'super_admin' }] });
      const t = appAt(NOW);
      const token = await sessionCookieFor(h, user.id, { mfaPassed: false, now: NOW });

      const partial = await t.agent(token).get('/api/v1/_t/partial');
      expect(partial.status).toBe(200);
      expect((partial.json as { stage: string }).stage).toBe('mfa');

      for (const p of ['/api/v1/_t/perm', '/api/v1/_t/pubs', '/api/v1/_t/password-change']) {
        const res = await t.agent(token).get(p);
        expect(res.status, p).toBe(401);
        expect(code(res), p).toBe('AUTH_MFA_REQUIRED');
        expect(gate(res), p).toBe('AUTH_MFA_REQUIRED');
      }
      // A public route with an optional session passes whatever the stage.
      expect((await t.agent(token).get('/api/v1/_t/pub')).status).toBe(200);
    });

    it('the stage: mfa_setup (2FA required by the user or a role, not enrolled), recovery (totp_reenroll)', async () => {
      const t = appAt(NOW);
      const stageFor = async (o: Omit<SeedStaffOptions, 'username'>): Promise<string> => {
        const user = await staff(o);
        const res = await t.agent(await sessionCookieFor(h, user.id, { mfaPassed: false, now: NOW })).get('/api/v1/_t/partial');
        return (res.json as { stage: string }).stage;
      };
      expect(await stageFor({ mfaRequired: true })).toBe('mfa_setup');
      expect(await stageFor({ roles: [{ permissions: ['system.users.read'], mfaRequired: true }] })).toBe('mfa_setup');
      expect(await stageFor({ totp: true, totpReenroll: true })).toBe('recovery');
      expect(await stageFor({ totp: true })).toBe('mfa');
    });
  });

  describe('stageOf and mfaNeeded', () => {
    const user = (o: Partial<StaffAuthView> = {}): StaffAuthView => ({
      id: newId(),
      usernameKey: 'BUDI',
      username: 'budi',
      name: 'Budi',
      email: null,
      locale: null,
      status: 'active',
      totpEnabled: false,
      totpReenroll: false,
      mfaRequired: false,
      mustChangePassword: false,
      authzVersion: 1,
      ...o,
    });
    const grants = (roleMfaRequired = false): Grants => ({ global: new Set(), branches: new Map(), superAdmin: false, roleMfaRequired });
    const session = (mfaPassed: boolean) => ({
      id: 'x',
      subjectId: 'y',
      createdAt: 0,
      lastSeenAt: 0,
      expiresAt: 1,
      mfaPassed,
      reauthAt: null,
      rememberSelector: null,
      authzVersion: 1,
      ip: null,
      userAgent: null,
    });

    it('stageOf: full when 2FA passed; else recovery, mfa, mfa_setup in that order', () => {
      expect(stageOf(user({ totpEnabled: true, totpReenroll: true }), grants(), session(true))).toBe('full');
      expect(stageOf(user({ totpEnabled: true, totpReenroll: true }), grants(), session(false))).toBe('recovery');
      expect(stageOf(user({ totpEnabled: true }), grants(), session(false))).toBe('mfa');
      expect(stageOf(user({ mfaRequired: true }), grants(), session(false))).toBe('mfa_setup');
    });

    it('mfaNeeded: TOTP enabled or to re-enrol, the user flag, or a held role requiring it', () => {
      expect(mfaNeeded(user(), grants())).toBe(false);
      expect(mfaNeeded(user({ totpEnabled: true }), grants())).toBe(true);
      expect(mfaNeeded(user({ totpReenroll: true }), grants())).toBe(true);
      expect(mfaNeeded(user({ mfaRequired: true }), grants())).toBe(true);
      expect(mfaNeeded(user(), grants(true))).toBe(true);
    });
  });

  describe('password change pending', () => {
    it('must_change_password → a permission route 403 AUTH_PASSWORD_CHANGE_REQUIRED; auth.password.change and partialAuth routes pass', async () => {
      const user = await staff({ mustChangePassword: true, roles: [{ permissions: ['system.users.read'] }] });
      const t = appAt(NOW);
      const token = await sessionCookieFor(h, user.id, { now: NOW });

      const perm = await t.agent(token).get('/api/v1/_t/perm');
      expect(perm.status).toBe(403);
      expect(code(perm)).toBe('AUTH_PASSWORD_CHANGE_REQUIRED');
      expect(gate(perm)).toBe('AUTH_PASSWORD_CHANGE_REQUIRED');
      expect(code(await t.agent(token).get('/api/v1/_t/pubs'))).toBe('AUTH_PASSWORD_CHANGE_REQUIRED');

      expect((await t.agent(token).get('/api/v1/_t/password-change')).status).toBe(200);
      expect((await t.agent(token).get('/api/v1/_t/partial')).status).toBe(200);
      expect((await t.agent(token).get('/api/v1/_t/pub')).status).toBe(200);
    });
  });

  describe('denial audit', () => {
    it('a missing system.* permission → 403 AUTHZ_DENIED; one authz.denied row per subject per minute', async () => {
      const user = await staff({ roles: [{ permissions: ['system.settings.read'] }] });
      const t = appAt(NOW);
      const token = await sessionCookieFor(h, user.id, { now: NOW });

      for (const at of [NOW, NOW + 20 * SEC, NOW + 40 * SEC]) {
        t.clock.now = at;
        const res = await t.agent(token).get('/api/v1/_t/perm');
        expect(res.status).toBe(403);
        expect(code(res)).toBe('AUTHZ_DENIED');
        expect(gate(res)).toBe('AUTHZ_DENIED');
      }
      const first = await deniedRows(user.id);
      expect(first).toHaveLength(1);
      expect(first[0]!.actor_type).toBe('staff');
      expect(JSON.parse(first[0]!.meta)).toEqual({ route: 't.perm', permission: 'system.users.read' });

      t.clock.now = NOW + 61 * SEC;
      expect((await t.agent(token).get('/api/v1/_t/perm')).status).toBe(403);
      expect(await deniedRows(user.id)).toHaveLength(2);
    });

    it('a denied test.branch.manage route writes none', async () => {
      const user = await staff({ roles: [{ permissions: ['system.settings.read'] }] });
      const t = appAt(NOW);
      const res = await t.agent(await sessionCookieFor(h, user.id, { now: NOW })).get(`/api/v1/_t/branches/${newId()}`);
      expect(res.status).toBe(403);
      expect(code(res)).toBe('AUTHZ_DENIED');
      expect(await deniedRows(user.id)).toHaveLength(0);
    });
  });

  describe('branch scope', () => {
    it('test.branch.manage at B → /x/B 200 and /x/C 403', async () => {
      const [b, c] = [newId(), newId()];
      const user = await staff({ roles: [{ permissions: ['test.branch.manage'], branchId: b }] });
      const t = appAt(NOW);
      const token = await sessionCookieFor(h, user.id, { now: NOW });
      expect((await t.agent(token).get(`/api/v1/_t/branches/${b}`)).status).toBe(200);
      const other = await t.agent(token).get(`/api/v1/_t/branches/${c}`);
      expect(other.status).toBe(403);
      expect(gate(other)).toBe('AUTHZ_DENIED');

      // A global assignment holds it at every branch.
      const global = await staff({ roles: [{ permissions: ['test.branch.manage'] }] });
      const globalToken = await sessionCookieFor(h, global.id, { now: NOW });
      expect((await t.agent(globalToken).get(`/api/v1/_t/branches/${c}`)).status).toBe(200);
    });
  });

  describe('reauth', () => {
    it('reauthAt now − 299 s → 200 (300 s too); now − 301 s or none → 401 AUTH_REAUTH_REQUIRED', async () => {
      const user = await staff({ roles: [{ permissions: ['system.settings.read'] }] });
      const t = appAt(NOW);
      const at = async (reauthAt: number | null): Promise<AgentReply> =>
        t.agent(await sessionCookieFor(h, user.id, { now: NOW - 10 * MIN, reauthAt })).get('/api/v1/_t/reauth');

      expect((await at(NOW - 299 * SEC)).status).toBe(200);
      expect((await at(NOW - 300 * SEC)).status).toBe(200);
      for (const reauthAt of [NOW - 301 * SEC, null]) {
        const res = await at(reauthAt);
        expect(res.status, String(reauthAt)).toBe(401);
        expect(code(res)).toBe('AUTH_REAUTH_REQUIRED');
        expect(gate(res)).toBe('AUTH_REAUTH_REQUIRED');
      }
    });
  });

  describe('rotation when the rights change (Review Focus 3)', () => {
    it('the next request gets a new altis_sid and X-CSRF-Token; a POST with them passes step 8; the old cookie works for 30 s, without rotating again', async () => {
      const user = await staff({ roles: [{ permissions: ['system.users.read'] }] });
      const t = appAt(NOW);
      const old = await sessionCookieFor(h, user.id, { now: NOW });
      await withTx(h, (trx) => bumpAuthzVersion(trx, [user.id]));

      const T1 = NOW + 5 * SEC;
      t.clock.now = T1;
      const agent = t.agent(old);
      const first = await agent.get('/api/v1/_t/perm');
      expect(first.status).toBe(200);
      const fresh = sidSet(first);
      expect(fresh).toMatch(/^[A-Za-z0-9_-]{43}$/);
      expect(fresh).not.toBe(old);
      expect(first.headers.get('x-csrf-token')).toBe(sessionCsrfFor(CONFIG, fresh!));
      expect((await sessionRow(fresh!))?.authz_version).toBe(2);

      // The agent's jar now holds the new cookie: a write with the new token passes step 8, without rotating again.
      const write = await agent.post('/api/v1/_t/perm', {}, { 'x-csrf-token': first.headers.get('x-csrf-token')! });
      expect(write.status).toBe(200);
      expect(sidSet(write)).toBeUndefined();

      // Another tab still sending the old cookie and token.
      t.clock.now = T1 + 29 * SEC;
      const parallel = await t.agent(old).get('/api/v1/_t/perm');
      expect(parallel.status).toBe(200);
      expect(sidSet(parallel)).toBeUndefined();
      expect(parallel.headers.get('x-csrf-token')).toBeNull();
      const oldWrite = await t.agent(old).post('/api/v1/_t/perm', {}, { 'x-csrf-token': sessionCsrfFor(CONFIG, old) });
      expect(oldWrite.status).toBe(200);
      expect(await h.db.selectFrom('sessions').select('id').where('subject_id', '=', user.id).execute()).toHaveLength(2);

      t.clock.now = T1 + 31 * SEC;
      const late = await t.agent(old).get('/api/v1/_t/perm');
      expect(late.status).toBe(401);
      expect(code(late)).toBe('AUTH_REQUIRED');
    });

    it('a background request (X-Altis-Background: 1) never rotates: the row keeps its last_seen_at and expires_at', async () => {
      const user = await staff({ roles: [{ permissions: ['system.users.read'] }] });
      const t = appAt(NOW);
      const old = await sessionCookieFor(h, user.id, { now: NOW });
      await withTx(h, (trx) => bumpAuthzVersion(trx, [user.id]));
      const before = await sessionRow(old);

      t.clock.now = NOW + 26 * MIN;
      const poll = await t.agent(old).get('/api/v1/_t/perm', undefined, { 'x-altis-background': '1' });
      expect(poll.status).toBe(200);
      expect(sidSet(poll)).toBeUndefined();
      expect(poll.headers.get('x-csrf-token')).toBeNull();
      expect(await sessionRow(old)).toEqual(before);
      expect(await h.db.selectFrom('sessions').select('id').where('subject_id', '=', user.id).execute()).toHaveLength(1);
      expect(rotateSession).not.toHaveBeenCalled();

      // The idle window still ends where it did: no user activity kept it alive.
      t.clock.now = NOW + 30 * MIN;
      expect((await t.agent(old).get('/api/v1/_t/perm', undefined, { 'x-altis-background': '1' })).status).toBe(401);
    });

    it('T10: the rotation locks the staff row first (as a password change does), so a concurrent revoke cannot miss the new row', async () => {
      const user = await staff({ roles: [{ permissions: ['system.users.read'] }] });
      const t = appAt(NOW);
      const old = await sessionCookieFor(h, user.id, { now: NOW });
      await withTx(h, (trx) => bumpAuthzVersion(trx, [user.id]));
      t.clock.now = NOW + 5 * SEC;

      // The rotation's transaction is held open after rotateSession inserted the new row; meanwhile a password reset's
      // revoke (lockStaffRow, then revokeSubject) starts in a transaction of its own.
      let entered!: () => void;
      const inside = new Promise<void>((resolve) => (entered = resolve));
      let release!: () => void;
      const held = new Promise<void>((resolve) => (release = resolve));
      const real = vi.mocked(rotateSession).getMockImplementation()!;
      vi.mocked(rotateSession).mockImplementationOnce(async (...args) => {
        const out = await real(...args);
        entered();
        await held;
        return out;
      });
      const rotating = t.agent(old).get('/api/v1/_t/perm');
      await inside;
      const revoking = withTx(h, async (trx) => {
        await lockStaffRow(trx, user.id);
        await revokeSubject(trx, user.id);
      });
      release();
      // 200, or 401 when the revoke lands before the request reads its new session back: either way it ends signed out.
      expect([200, 401]).toContain((await rotating).status);
      await revoking;
      expect(await h.db.selectFrom('sessions').select('id').where('subject_id', '=', user.id).execute()).toEqual([]);

      const lock = vi.mocked(lockStaffRow).mock;
      const rotation = vi.mocked(rotateSession).mock;
      const first = lock.calls.findIndex(([, id]) => id === user.id);
      expect(first).toBeGreaterThanOrEqual(0);
      expect(lock.invocationCallOrder[first]!).toBeLessThan(rotation.invocationCallOrder[0]!);
    });

    it('two parallel requests with the old cookie rotate it once', async () => {
      const user = await staff({ roles: [{ permissions: ['system.users.read'] }] });
      const t = appAt(NOW);
      const old = await sessionCookieFor(h, user.id, { now: NOW });
      await withTx(h, (trx) => bumpAuthzVersion(trx, [user.id]));
      t.clock.now = NOW + 5 * SEC;

      const replies = await Promise.all([t.agent(old).get('/api/v1/_t/perm'), t.agent(old).get('/api/v1/_t/perm')]);
      expect(replies.map((r) => r.status)).toEqual([200, 200]);
      expect(replies.filter((r) => sidSet(r) !== undefined)).toHaveLength(1);
      expect(await h.db.selectFrom('sessions').select('id').where('subject_id', '=', user.id).execute()).toHaveLength(2);
    });
  });

  describe('grants per request', () => {
    it("deleting the user's role and bumping authz_version → the next request is 403 (the rotated cookie still goes out)", async () => {
      const user = await staff({ roles: [{ permissions: ['system.users.read'] }] });
      const t = appAt(NOW);
      const agent = t.agent(await sessionCookieFor(h, user.id, { now: NOW }));
      expect((await agent.get('/api/v1/_t/perm')).status).toBe(200);

      await withTx(h, async (trx) => {
        await trx.deleteFrom('user_roles').where('user_id', '=', user.id).execute();
        await bumpAuthzVersion(trx, [user.id]);
      });
      const res = await agent.get('/api/v1/_t/perm');
      expect(res.status).toBe(403);
      expect(code(res)).toBe('AUTHZ_DENIED');
      const fresh = sidSet(res);
      expect(fresh).toMatch(/^[A-Za-z0-9_-]{43}$/);
      expect(res.headers.get('x-csrf-token')).toBe(sessionCsrfFor(CONFIG, fresh!));
    });
  });

  describe('disabled user', () => {
    it.each(['locked', 'disabled'])(
      'a %s user: the request → 401 and every session and remember-me token of the user is revoked',
      async (status) => {
        const user = await staff({ roles: [{ permissions: ['system.users.read'] }] });
        const t = appAt(NOW);
        const token = await sessionCookieFor(h, user.id, { now: NOW });
        await sessionCookieFor(h, user.id, { now: NOW });
        await withTx(h, (trx) => issueRememberToken(trx, { subjectId: user.id, mfaBound: false, now: NOW }));
        await h.db.updateTable('staff_users').set({ status }).where('id', '=', user.id).execute();

        const res = await t.agent(token).get('/api/v1/_t/perm');
        expect(res.status).toBe(401);
        expect(code(res)).toBe('AUTH_REQUIRED');
        expect(sidSet(res)).toBe('');
        expect(await h.db.selectFrom('sessions').select('id').where('subject_id', '=', user.id).execute()).toEqual([]);
        expect(await h.db.selectFrom('remember_tokens').select('selector').where('subject_id', '=', user.id).execute()).toEqual([]);
        const locked = vi.mocked(lockStaffRow).mock.calls.filter(([, id]) => id === user.id);
        expect(locked).toHaveLength(1);
      },
    );

    it("a disabled user's session → 401, the row is gone and the cookie cleared", async () => {
      const user = await staff({ status: 'disabled', roles: [{ key: 'super_admin' }] });
      const t = appAt(NOW);
      const token = await sessionCookieFor(h, user.id, { now: NOW });
      const res = await t.agent(token).get('/api/v1/_t/pubs');
      expect(res.status).toBe(401);
      expect(code(res)).toBe('AUTH_REQUIRED');
      expect(sidSet(res)).toBe('');
      expect(await sessionRow(token)).toBeUndefined();
    });
  });

  describe('touch (session created at t0, M35)', () => {
    it('requests at t0 + 61 s and t0 + 91 s → one last_seen_at write (at +61 s); X-Altis-Background: 1 → none', async () => {
      const user = await staff({ roles: [{ permissions: ['system.users.read'] }] });
      const t = appAt(NOW);
      const token = await sessionCookieFor(h, user.id, { now: NOW });

      t.clock.now = NOW + 61 * SEC;
      expect((await t.agent(token).get('/api/v1/_t/perm')).status).toBe(200);
      expect((await sessionRow(token))?.last_seen_at).toBe(NOW + 61 * SEC);
      t.clock.now = NOW + 91 * SEC;
      expect((await t.agent(token).get('/api/v1/_t/perm')).status).toBe(200);
      expect((await sessionRow(token))?.last_seen_at).toBe(NOW + 61 * SEC);

      const background = await sessionCookieFor(h, user.id, { now: NOW });
      t.clock.now = NOW + 61 * SEC;
      const res = await t.agent(background).get('/api/v1/_t/perm', undefined, { 'x-altis-background': '1' });
      expect(res.status).toBe(200);
      expect(await sessionRow(background)).toMatchObject({ last_seen_at: NOW, expires_at: NOW + 30 * MIN });
    });

    it('with security.session_idle_minutes = 5: an untouched session is gone at t0 + 5 min + 1 ms; a touch extends it by 5 min', async () => {
      await withTx(h, (trx) => writeSettings(trx, { 'security.session_idle_minutes': 5 }, { keyring: [], now: NOW, actorId: null }));
      const user = await staff({ roles: [{ permissions: ['system.users.read'] }] });
      const t = appAt(NOW);

      const untouched = await sessionCookieFor(h, user.id, { now: NOW });
      t.clock.now = NOW + 5 * MIN + 1;
      expect((await t.agent(untouched).get('/api/v1/_t/perm')).status).toBe(401);

      const touched = await sessionCookieFor(h, user.id, { now: NOW, idleMs: 30 * MIN });
      t.clock.now = NOW + 61 * SEC;
      expect((await t.agent(touched).get('/api/v1/_t/perm')).status).toBe(200);
      expect((await sessionRow(touched))?.expires_at).toBe(NOW + 61 * SEC + 5 * MIN);
      t.clock.now = NOW + 61 * SEC + 5 * MIN + 1;
      expect((await t.agent(touched).get('/api/v1/_t/perm')).status).toBe(401);
    });
  });

  describe('idle limit lowered (security.session_idle_minutes, D26)', () => {
    it('240 → 5 min: a session idle for 10 min is expired on its next request (401, cookie cleared); one idle 4 min passes', async () => {
      await withTx(h, (trx) => writeSettings(trx, { 'security.session_idle_minutes': 240 }, { keyring: [], now: NOW, actorId: null }));
      const user = await staff({ roles: [{ permissions: ['system.users.read'] }] });
      const stale = await sessionCookieFor(h, user.id, { now: NOW });
      const fresh = await sessionCookieFor(h, user.id, { now: NOW + 6 * MIN });
      expect((await sessionRow(stale))?.expires_at).toBe(NOW + 240 * MIN);
      const { selector } = await withTx(h, (trx) => issueRememberToken(trx, { subjectId: user.id, mfaBound: false, now: NOW }));
      await h.db.updateTable('sessions').set({ remember_selector: selector }).where('id', '=', sha256hex(stale)).execute();
      await withTx(h, (trx) => writeSettings(trx, { 'security.session_idle_minutes': 5 }, { keyring: [], now: NOW, actorId: null }));
      const t = appAt(NOW + 10 * MIN);

      const res = await t.agent(stale).get('/api/v1/_t/perm');
      expect(res.status).toBe(401);
      expect(code(res)).toBe('AUTH_REQUIRED');
      expect(sidSet(res)).toBe('');
      expect(await sessionRow(stale)).toBeUndefined();
      // Expired, as if it had been written under the new limit: its remember-me token (if any) may still restore.
      expect(await h.db.selectFrom('remember_tokens').select('selector').where('selector', '=', selector).execute()).toHaveLength(1);

      const ok = await t.agent(fresh).get('/api/v1/_t/perm');
      expect(ok.status).toBe(200);
      expect((await sessionRow(fresh))?.expires_at).toBe(NOW + 10 * MIN + 5 * MIN);
    });
  });

  describe('ruling R1b-1', () => {
    /** A user holding system.users.read, its session at NOW, then an authz_version bump; the clock at NOW + 5 s. */
    async function bumped(o: { mfaPassed?: boolean } = {}) {
      const user = await staff({ totp: o.mfaPassed === false, roles: [{ permissions: ['system.users.read'] }] });
      const t = appAt(NOW);
      const old = await sessionCookieFor(h, user.id, { now: NOW, ...(o.mfaPassed === undefined ? {} : { mfaPassed: o.mfaPassed }) });
      await withTx(h, (trx) => bumpAuthzVersion(trx, [user.id]));
      t.clock.now = NOW + 5 * SEC;
      return { user, t, old };
    }
    const sessionCount = async (userId: string) =>
      (await h.db.selectFrom('sessions').select('id').where('subject_id', '=', userId).execute()).length;

    it("(a) a handler's own Response carries step 7's rotated altis_sid and X-CSRF-Token, its own headers and cookies kept", async () => {
      const { t, old } = await bumped();
      const res = await t.agent(old).get('/api/v1/_t/own-response');
      expect(res.status).toBe(202);
      expect(res.text).toBe('own');
      expect(res.headers.get('content-type')).toBe('text/plain; charset=utf-8');
      expect(res.headers.get('x-own')).toBe('yes');
      const fresh = sidSet(res);
      expect(fresh).toMatch(/^[A-Za-z0-9_-]{43}$/);
      expect(res.headers.get('x-csrf-token')).toBe(sessionCsrfFor(CONFIG, fresh!));
      const cookies = res.headers.getSetCookie();
      expect(cookies).toContain('own_a=1; Path=/');
      expect(cookies).toContain('own_b=2; Path=/');
      expect(res.headers.get('x-request-id')).toMatch(/^[0-9A-HJKMNP-TV-Z]{26}$/);
    });

    it('(a) a Response built through the context (rc.c.json) carries each cookie once', async () => {
      const { t, old } = await bumped();
      const res = await t.agent(old).get('/api/v1/_t/context-response');
      expect(res.status).toBe(200);
      expect(res.json).toEqual({ via: 'context' });
      expect(res.headers.get('x-own')).toBe('yes');
      const cookies = res.headers.getSetCookie();
      expect(cookies.filter((l) => l.startsWith(`${SID}=`))).toHaveLength(1);
      expect(cookies.filter((l) => l === 'ctx=1; Path=/')).toHaveLength(1);
      expect(cookies).toHaveLength(2);
      expect(res.headers.get('x-csrf-token')).toBe(sessionCsrfFor(CONFIG, sidSet(res)!));
    });

    it('(b) a pre-2FA session is not rotated on a bump: authz_version updated in place, same row, same expiry', async () => {
      const { user, t, old } = await bumped({ mfaPassed: false });
      const before = await sessionRow(old);
      const res = await t.agent(old).get('/api/v1/_t/partial');
      expect(res.status).toBe(200);
      expect((res.json as { stage: string }).stage).toBe('mfa');
      expect(sidSet(res)).toBeUndefined();
      expect(res.headers.get('x-csrf-token')).toBeNull();
      expect(await sessionRow(old)).toEqual({ ...before, authz_version: 2 });
      expect(before?.expires_at).toBe(NOW + 10 * MIN);
      expect(await sessionCount(user.id)).toBe(1);

      // The next request sees no mismatch any more.
      t.clock.now = NOW + 6 * SEC;
      const again = await t.agent(old).get('/api/v1/_t/partial');
      expect(again.status).toBe(200);
      expect(sidSet(again)).toBeUndefined();
      expect(await sessionCount(user.id)).toBe(1);
    });

    it('(c) only /api routes rotate: a page keeps the session as it is (grants still recomputed); the next /api request rotates', async () => {
      const { user, t, old } = await bumped();
      const page = await t.agent(old).get('/t/page');
      expect(page.status).toBe(200);
      expect((page.json as { subjectId: string }).subjectId).toBe(user.id);
      expect(sidSet(page)).toBeUndefined();
      expect(page.headers.get('x-csrf-token')).toBeNull();
      expect((await sessionRow(old))?.authz_version).toBe(1);
      expect(await sessionCount(user.id)).toBe(1);

      const api = await t.agent(old).get('/api/v1/_t/perm');
      expect(api.status).toBe(200);
      expect(sidSet(api)).toMatch(/^[A-Za-z0-9_-]{43}$/);
      expect(await sessionCount(user.id)).toBe(2);

      // Grants are recomputed per request on a page too: the role gone and the version bumped → 403, no rotation.
      const other = await staff({ roles: [{ permissions: ['system.users.read'] }] });
      const token = await sessionCookieFor(h, other.id, { now: NOW });
      await withTx(h, async (trx) => {
        await trx.deleteFrom('user_roles').where('user_id', '=', other.id).execute();
        await bumpAuthzVersion(trx, [other.id]);
      });
      const denied = await t.agent(token).get('/t/page');
      expect(denied.status).toBe(403);
      expect(code(denied)).toBe('AUTHZ_DENIED');
      expect(sidSet(denied)).toBeUndefined();
      expect((await sessionRow(token))?.authz_version).toBe(1);
    });

    it("(d) an error response keeps step 7's headers and drops those the handler set before it threw", async () => {
      const { t, old } = await bumped();
      const res = await t.agent(old).post('/api/v1/_t/leak', {}, { 'x-csrf-token': sessionCsrfFor(CONFIG, old) });
      expect(res.status).toBe(409);
      expect(code(res)).toBe('CONFLICT_STALE');
      expect(res.headers.get('content-type')).toBe('application/problem+json');
      const fresh = sidSet(res);
      expect(fresh).toMatch(/^[A-Za-z0-9_-]{43}$/);
      expect(res.headers.get('x-csrf-token')).toBe(sessionCsrfFor(CONFIG, fresh!));
      expect(res.headers.getSetCookie().filter((l) => l.startsWith('leak='))).toEqual([]);
      expect(res.headers.get('x-handler')).toBeNull();

      // Without a rotation the error response sets no cookie at all.
      const user = await staff({ roles: [{ permissions: ['system.users.read'] }] });
      const token = await sessionCookieFor(h, user.id, { now: NOW });
      const plain = await t.agent(token).post('/api/v1/_t/leak', {}, { 'x-csrf-token': sessionCsrfFor(CONFIG, token) });
      expect(plain.status).toBe(409);
      expect(plain.headers.getSetCookie()).toEqual([]);
      expect(plain.headers.get('x-handler')).toBeNull();
    });
  });

  describe("session: 'none'", () => {
    it('a request with an altis_sid cookie runs no session query (findSession spy)', async () => {
      const user = await staff();
      const t = appAt(NOW);
      const token = await sessionCookieFor(h, user.id, { now: NOW });

      const res = await t.agent(token).get('/t/none');
      expect(res.status).toBe(200);
      expect(res.json).toEqual({ auth: null });
      expect(sidSet(res)).toBeUndefined();
      expect(findSession).not.toHaveBeenCalled();

      // The control: a route that is not `session: 'none'` looks the session up.
      expect((await t.agent(token).get('/api/v1/_t/pub')).status).toBe(200);
      expect(findSession).toHaveBeenCalledTimes(1);
    });
  });
});
