import fsp from 'node:fs/promises';
import os from 'node:os';
import path from 'node:path';
import {
  adminResetPassword,
  adminResetTotp,
  issueRememberToken,
  loadGrants,
  randomToken,
  replaceUserRoles,
  runnerFor,
  setUserStatus,
  sha256hex,
  txCtx,
  updateRole,
  writeSettings,
} from '@altis/core';
import { canonicalize } from '@altis/crypto';
import { PHASE1_MIGRATIONS, runMigrations, verifyAuditChain, withTx } from '@altis/db';
import { newId, systemRolePermissions, type Permission } from '@altis/shared';
import { afterAll, beforeAll, beforeEach, describe, expect, it } from 'vitest';
import { engineLabel, testDb, testDbContext, type TestDbHandle } from '../../../../tools/test/test-db.js';
import { createApp } from '../../src/app.js';
import { csrfKey, preSessionCsrfToken } from '../../src/http/csrf.js';
import { createAgent, type Agent, type AgentReply } from '../agent.js';
import { recordingLogger, sampleConfig } from '../support.js';
import { seedStaff, sessionCookieFor, sessionCsrfFor, type SeededStaff } from '../support-auth.js';

// The users API of Task 19 (spec §7.1, §7.2, §13.5 "Pengguna") on the engine picked by ALTIS_TEST_DB: list and read,
// create (the policy and the hash in `prepare`, keys taken → VALIDATION_FAILED `taken`), update (optimistic `version`,
// an e-mail change ends the reset tokens, a 2FA requirement ends the remember tokens without 2FA), disable/enable
// (rule 6 under the guard-row lock, B4, also with two concurrent disables), the admin password and 2FA resets, the
// role assignment with anti-escalation rules 2-5 (A4), and the test-profile branch route (S14).
//
// Personas: `sa` a super admin, `ad` an admin, `st` a staff user without roles. Every acting session is full and was
// re-authenticated at NOW (several routes need reauth, §7.3).

const ctx = testDbContext();
let h: TestDbHandle;

/** 09:00:05 UTC, in the past: an audit entry may not be dated ahead of the real clock. */
const NOW = Date.UTC(2026, 9, 21, 9, 0, 5);
const CONFIG = sampleConfig();
const API = '/api/v1/users';
const LOGIN = '/api/v1/auth/login';
/** baseUrl is https: the cookies carry the `__Host-` prefix. */
const SID = '__Host-altis_sid';
const CSRF = '__Host-altis_csrf';
/** A temporary password (Task 5): xxxx-xxxx-xxxx-xxxx in lower-case Crockford base32. */
const TEMPORARY = /^[0-9a-hjkmnp-tv-z]{4}(?:-[0-9a-hjkmnp-tv-z]{4}){3}$/;
const STRONG = 'kuda-lumping-biru-tujuh';

function appAt() {
  const app = createApp({
    state: { phase: 'ready', db: h, config: CONFIG },
    version: '1.0.0',
    buildId: 'build-x',
    log: recordingLogger(),
    clock: () => NOW,
  });
  return app;
}

type App = ReturnType<typeof appAt>;

/** An agent signed in as `userId`: a full session created at NOW, re-authenticated at NOW unless `reauth` is false. */
async function signIn(app: App, userId: string, o: { reauth?: boolean } = {}): Promise<Agent> {
  const token = await sessionCookieFor(h, userId, { now: NOW, reauthAt: o.reauth === false ? null : NOW });
  const agent = createAgent(app, { headers: { 'x-csrf-token': sessionCsrfFor(CONFIG, token) } });
  agent.setCookie(SID, token);
  return agent;
}

/** `POST auth/login` from a fresh browser. */
async function login(app: App, username: string, password: string): Promise<AgentReply> {
  const agent = createAgent(app, { peer: '203.0.113.9' });
  const value = randomToken(32);
  agent.setCookie(CSRF, value);
  return agent.post(LOGIN, { username, password }, { 'x-csrf-token': preSessionCsrfToken(csrfKey(CONFIG), value) });
}

const code = (res: AgentReply): string | undefined => (res.json as { code?: string } | undefined)?.code;
const errorsOf = (res: AgentReply): unknown => (res.json as { errors?: unknown } | undefined)?.errors;

async function audits(action: string) {
  const rows = await h.db
    .selectFrom('audit_log')
    .select(['actor_type', 'actor_id', 'entity', 'entity_id', 'meta'])
    .where('action', '=', action)
    .orderBy('seq')
    .execute();
  return rows.map((r) => ({ ...r, meta: JSON.parse(r.meta) as Record<string, unknown> }));
}

const sessionCount = async (userId: string): Promise<number> =>
  (await h.db.selectFrom('sessions').select('id').where('subject_id', '=', userId).execute()).length;

const userRow = (userId: string) => h.db.selectFrom('staff_users').selectAll().where('id', '=', userId).executeTakeFirstOrThrow();

/** A custom role holding `permissions`; returns its id. */
async function seedRole(permissions: Permission[], name = `Peran ${randomToken(4)}`): Promise<string> {
  const id = newId();
  await withTx(h, async (trx) => {
    await trx.insertInto('roles').values({ id, key: `r_${id}`, name, created_at: NOW, updated_at: NOW }).execute();
    if (permissions.length > 0) {
      await trx.insertInto('role_permissions').values(permissions.map((permission) => ({ role_id: id, permission }))).execute();
    }
  });
  return id;
}

/** A branch (archived when asked); returns its id. */
async function seedBranch(o: { archived?: boolean } = {}): Promise<string> {
  const id = newId();
  const code = id.slice(-10);
  await h.db
    .insertInto('branches')
    .values({
      id,
      code_key: code,
      code_display: code,
      name: `Cabang ${code}`,
      timezone: 'Asia/Jakarta',
      archived_at: o.archived === true ? NOW - 1000 : null,
      created_at: NOW,
      updated_at: NOW,
    })
    .execute();
  return id;
}

const systemRoleId = async (key: 'super_admin' | 'admin'): Promise<string> =>
  (await h.db.selectFrom('roles').select('id').where('key', '=', key).executeTakeFirstOrThrow()).id;

describe.skipIf(!ctx.available)(`users API [${engineLabel()}]`, () => {
  let dataDir: string;
  let sa: SeededStaff;
  let ad: SeededStaff;
  let st: SeededStaff;

  beforeAll(async () => {
    h = await testDb();
    dataDir = await fsp.mkdtemp(path.join(os.tmpdir(), 'altis-users-'));
    await runMigrations(h, { appVersion: '0.1.0', dataDir, migrations: PHASE1_MIGRATIONS });
  });

  afterAll(async () => {
    await h?.close();
    if (dataDir !== undefined) await fsp.rm(dataDir, { recursive: true, force: true });
  });

  beforeEach(async () => {
    await h.db.deleteFrom('sessions').execute();
    await h.db.deleteFrom('remember_tokens').execute();
    await h.db.deleteFrom('password_resets').execute();
    await h.db.deleteFrom('rate_limits').execute();
    await h.db.deleteFrom('idempotency_keys').execute();
    await h.db.deleteFrom('settings').execute();
    await h.db.deleteFrom('staff_users').execute(); // user_roles and recovery codes cascade
    await h.db.deleteFrom('roles').execute(); // role_permissions cascade
    await h.db.deleteFrom('branches').execute();
    await h.db.deleteFrom('audit_log').execute();
    await h.db.updateTable('audit_head').set({ last_seq: 0, last_hash: '0'.repeat(64) }).where('id', '=', 1).execute();
    sa = await seedStaff(h, { username: 'sa', roles: [{ key: 'super_admin' }], now: NOW });
    ad = await seedStaff(h, { username: 'ad', roles: [{ key: 'admin' }], now: NOW });
    st = await seedStaff(h, { username: 'st', now: NOW });
  });

  describe('list and read', () => {
    it('GET users?q=bud&pageSize=10: the matches (username or name) in username order, total as a number', async () => {
      const app = appAt();
      await seedStaff(h, { username: 'budiman', now: NOW });
      const budi = await seedStaff(h, { username: 'Budi', roles: [{ key: 'admin' }], now: NOW });
      const ani = await seedStaff(h, { username: 'ani', now: NOW });
      await h.db.updateTable('staff_users').set({ name: 'Ani Budiarti' }).where('id', '=', ani.id).execute();

      const res = await (await signIn(app, ad.id)).get(`${API}?q=bud&pageSize=10`);
      expect(res.status).toBe(200);
      const body = res.json as { items: { id: string; username: string }[]; total: unknown; page: number; pageSize: number };
      expect(body.total).toBe(3);
      expect(body.page).toBe(1);
      expect(body.pageSize).toBe(10);
      expect(body.items.map((u) => u.username)).toEqual(['ani', 'Budi', 'budiman']);
      const first = body.items.find((u) => u.id === budi.id);
      expect(first).toEqual({
        id: budi.id,
        username: 'Budi',
        name: 'Budi',
        email: null,
        status: 'active',
        totpEnabled: false,
        mfaRequired: false,
        lastLoginAt: null,
        roles: [{ roleId: await systemRoleId('admin'), key: 'admin', name: expect.any(String), branchId: null }],
      });
    });

    it('LIKE wildcards in q are literal; paging and the status filter; pageSize below 10 → 422', async () => {
      const app = appAt();
      await seedStaff(h, { username: 'budi', now: NOW });
      await seedStaff(h, { username: 'bob', status: 'disabled', now: NOW });
      const agent = await signIn(app, ad.id);

      const wild = await agent.get(`${API}?q=b_di`);
      expect(wild.status).toBe(200);
      expect((wild.json as { total: number }).total).toBe(0);
      const percent = await agent.get(`${API}?q=%25`);
      expect((percent.json as { total: number }).total).toBe(0);

      const page2 = await agent.get(`${API}?page=2&pageSize=10`);
      expect(page2.json).toMatchObject({ items: [], total: 5, page: 2, pageSize: 10 });
      const all = await agent.get(API);
      expect(all.json).toMatchObject({ total: 5, page: 1, pageSize: 25 });
      expect((all.json as { items: { username: string }[] }).items.map((u) => u.username)).toEqual(['ad', 'bob', 'budi', 'sa', 'st']);

      const disabled = await agent.get(`${API}?status=disabled`);
      expect((disabled.json as { items: { username: string }[] }).items.map((u) => u.username)).toEqual(['bob']);

      const small = await agent.get(`${API}?pageSize=5`);
      expect(small.status).toBe(422);
      expect(errorsOf(small)).toEqual([{ path: 'pageSize', code: 'too_small' }]);
    });

    it('GET users/:id → UserDetail; an unknown id → 404 NOT_FOUND; no system.users.read → 403', async () => {
      const app = appAt();
      const agent = await signIn(app, ad.id);
      const res = await agent.get(`${API}/${st.id}`);
      expect(res.status).toBe(200);
      expect(res.json).toEqual({
        id: st.id,
        username: 'st',
        name: 'st',
        email: null,
        status: 'active',
        totpEnabled: false,
        mfaRequired: false,
        lastLoginAt: null,
        roles: [],
        locale: null,
        mustChangePassword: false,
        version: 0,
        createdAt: NOW,
        updatedAt: NOW,
      });
      const missing = await agent.get(`${API}/${newId()}`);
      expect(missing.status).toBe(404);
      expect(code(missing)).toBe('NOT_FOUND');
      const malformed = await agent.get(`${API}/not-a-ulid`);
      expect(malformed.status).toBe(422);

      const denied = await (await signIn(app, st.id)).get(API);
      expect(denied.status).toBe(403);
      expect(code(denied)).toBe('AUTHZ_DENIED');
    });
  });

  describe('create', () => {
    it('with an Idempotency-Key: request_hash is keyed (no plain SHA-256 of a body holding the password); the replay still works', async () => {
      const app = appAt();
      const agent = await signIn(app, sa.id);
      const body = { username: 'wati', name: 'Wati', password: STRONG };
      const key = 'create-wati-0001';
      const res = await agent.post(API, body, { 'idempotency-key': key });
      expect(res.status).toBe(201);

      const row = await h.db.selectFrom('idempotency_keys').select(['request_hash', 'status']).where('key', '=', key).executeTakeFirstOrThrow();
      expect(row.status).toBe('done');
      expect(row.request_hash).toMatch(/^[0-9a-f]{64}$/);
      expect(row.request_hash).not.toBe(sha256hex(`POST\n${API}\n${canonicalize(body)}`));

      const again = await agent.post(API, body, { 'idempotency-key': key });
      expect(again.status).toBe(201);
      expect(again.headers.get('idempotent-replayed')).toBe('true');
      expect(again.json).toEqual(res.json);
      const other = await agent.post(API, { ...body, password: `${STRONG}-x` }, { 'idempotency-key': key });
      expect(other.status).toBe(422);
      expect(code(other)).toBe('IDEMPOTENCY_KEY_REUSED');
    });

    it('POST users → 201 UserDetail; keys normalized; created_by and users.create name the actor; the user can sign in', async () => {
      const app = appAt();
      const res = await (await signIn(app, sa.id)).post(API, {
        username: ' Siti ',
        name: 'Siti Aminah',
        email: 'Siti@Perpus.Sch.Id',
        password: STRONG,
        locale: 'en',
      });
      expect(res.status).toBe(201);
      const body = res.json as { id: string };
      expect(res.json).toEqual({
        id: expect.any(String),
        username: 'Siti',
        name: 'Siti Aminah',
        email: 'Siti@Perpus.Sch.Id',
        status: 'active',
        totpEnabled: false,
        mfaRequired: false,
        lastLoginAt: null,
        roles: [],
        locale: 'en',
        mustChangePassword: true,
        version: 0,
        createdAt: NOW,
        updatedAt: NOW,
      });
      const row = await userRow(body.id);
      expect(row).toMatchObject({
        username_key: 'SITI',
        username_display: 'Siti',
        email_key: 'SITI@PERPUS.SCH.ID',
        email_display: 'Siti@Perpus.Sch.Id',
        created_by: sa.id,
        updated_by: sa.id,
      });
      expect(row.password_hash).toMatch(/^\$scrypt\$/);
      expect(await audits('users.create')).toEqual([
        { actor_type: 'staff', actor_id: sa.id, entity: 'staff_users', entity_id: body.id, meta: { username: 'Siti' } },
      ]);

      const signedIn = await login(app, 'siti', STRONG);
      expect(signedIn.status).toBe(200);
      expect(signedIn.json).toEqual({ stage: 'full', mustChangePassword: true });
    });

    it("username ' Budi' when budi exists → 422 {path: username, code: taken}; a taken e-mail too", async () => {
      const app = appAt();
      const budi = await seedStaff(h, { username: 'budi', now: NOW });
      await h.db.updateTable('staff_users').set({ email_key: 'BUDI@X.ID', email_display: 'budi@x.id' }).where('id', '=', budi.id).execute();
      const agent = await signIn(app, sa.id);

      const res = await agent.post(API, { username: ' Budi', name: 'Budi Dua', password: STRONG });
      expect(res.status).toBe(422);
      expect(code(res)).toBe('VALIDATION_FAILED');
      expect(errorsOf(res)).toEqual([{ path: 'username', code: 'taken' }]);

      const both = await agent.post(API, { username: 'BUDI', name: 'Budi Dua', email: 'Budi@X.id', password: STRONG });
      expect(errorsOf(both)).toEqual([
        { path: 'username', code: 'taken' },
        { path: 'email', code: 'taken' },
      ]);
      expect(await audits('users.create')).toEqual([]);
    });

    it('a weak password → 422 PASSWORD_TOO_WEAK; nothing is written', async () => {
      const app = appAt();
      const res = await (await signIn(app, sa.id)).post(API, { username: 'siti', name: 'Siti', password: 'qwertyuiop' });
      expect(res.status).toBe(422);
      expect(code(res)).toBe('PASSWORD_TOO_WEAK');
      expect((res.json as { reason?: string }).reason).toBe('common');
      expect(await h.db.selectFrom('staff_users').select('id').where('username_key', '=', 'SITI').execute()).toEqual([]);
    });

    it('the minimum length setting applies (security.password_min_length)', async () => {
      const app = appAt();
      await withTx(h, (trx) => writeSettings(trx, { 'security.password_min_length': 24 }, { keyring: [], now: NOW, actorId: null }));
      const res = await (await signIn(app, sa.id)).post(API, { username: 'siti', name: 'Siti', password: STRONG });
      expect(res.status).toBe(422);
      expect((res.json as { reason?: string }).reason).toBe('too_short');
    });

    it('a username whose key is longer than 191 code points (64 × U+0390 → 192) → 422 VALIDATION_FAILED, not a DB error', async () => {
      const app = appAt();
      const res = await (await signIn(app, sa.id)).post(API, { username: 'ΐ'.repeat(64), name: 'Iota', password: STRONG });
      expect(res.status).toBe(422);
      expect(code(res)).toBe('VALIDATION_FAILED');
      expect(errorsOf(res)).toEqual([{ path: 'username', code: 'too_big' }]);
    });

    it('st (no system.users.manage) → 403 AUTHZ_DENIED before the password is hashed', async () => {
      const app = appAt();
      const res = await (await signIn(app, st.id)).post(API, { username: 'siti', name: 'Siti', password: STRONG });
      expect(res.status).toBe(403);
      expect(code(res)).toBe('AUTHZ_DENIED');
    });
  });

  describe('update', () => {
    it('a stale version → 409 CONFLICT_STALE; the current one → 200 with version + 1 and users.update', async () => {
      const app = appAt();
      const agent = await signIn(app, ad.id);
      const stale = await agent.patch(`${API}/${st.id}`, { version: 3, name: 'Santi' });
      expect(stale.status).toBe(409);
      expect(code(stale)).toBe('CONFLICT_STALE');

      const ok = await agent.patch(`${API}/${st.id}`, { version: 0, name: 'Santi', locale: 'id' });
      expect(ok.status).toBe(200);
      expect(ok.json).toMatchObject({ id: st.id, name: 'Santi', locale: 'id', version: 1 });
      expect(await userRow(st.id)).toMatchObject({ name: 'Santi', updated_by: ad.id });
      expect(await audits('users.update')).toEqual([
        { actor_type: 'staff', actor_id: ad.id, entity: 'staff_users', entity_id: st.id, meta: { fields: ['name', 'locale'] } },
      ]);
    });

    it("an e-mail change removes st's password reset rows", async () => {
      const app = appAt();
      await h.db
        .insertInto('password_resets')
        .values({ token_hash: sha256hex(randomToken(32)), subject_type: 'staff', subject_id: st.id, expires_at: NOW + 60_000 })
        .execute();
      const res = await (await signIn(app, ad.id)).patch(`${API}/${st.id}`, { version: 0, email: 'santi@perpus.sch.id' });
      expect(res.status).toBe(200);
      expect(res.json).toMatchObject({ email: 'santi@perpus.sch.id' });
      expect(await h.db.selectFrom('password_resets').select('token_hash').where('subject_id', '=', st.id).execute()).toEqual([]);
    });

    it("mfaRequired: true deletes st's mfa_bound = 0 remember token and the session carrying it", async () => {
      const app = appAt();
      // A session restored from (or issuing) a remember token without 2FA, and a plain session.
      await sessionCookieFor(h, st.id, { now: NOW });
      const token = await withTx(h, (trx) => issueRememberToken(trx, { subjectId: st.id, mfaBound: false, now: NOW }));
      await h.db.updateTable('sessions').set({ remember_selector: token.selector }).where('subject_id', '=', st.id).execute();
      await sessionCookieFor(h, st.id, { now: NOW });
      const res = await (await signIn(app, ad.id)).patch(`${API}/${st.id}`, { version: 0, mfaRequired: true });
      expect(res.status).toBe(200);
      expect(res.json).toMatchObject({ mfaRequired: true });
      expect(await h.db.selectFrom('remember_tokens').select('selector').where('subject_id', '=', st.id).execute()).toEqual([]);
      // The session that carried the token is gone; the plain one stays (its next login needs 2FA, §7.1).
      expect(await sessionCount(st.id)).toBe(1);
    });

    it('a username change to a taken one → 422 taken; a change of case of one’s own → 200', async () => {
      const app = appAt();
      await seedStaff(h, { username: 'budi', now: NOW });
      const santi = await seedStaff(h, { username: 'santi', now: NOW });
      const agent = await signIn(app, ad.id);
      const taken = await agent.patch(`${API}/${santi.id}`, { version: 0, username: 'ＢＵＤＩ' });
      expect(taken.status).toBe(422);
      expect(errorsOf(taken)).toEqual([{ path: 'username', code: 'taken' }]);
      const own = await agent.patch(`${API}/${santi.id}`, { version: 0, username: 'Santi' });
      expect(own.status).toBe(200);
      expect(own.json).toMatchObject({ username: 'Santi', version: 1 });
      expect(await userRow(santi.id)).toMatchObject({ username_key: 'SANTI', username_display: 'Santi' });
      expect((await audits('users.update'))[0]?.meta).toEqual({ fields: ['username'] });
    });

    it('on self: mfaRequired → 403 AUTHZ_ESCALATION, the name → 200; another account holding more → 403 (rule 3)', async () => {
      const app = appAt();
      const agent = await signIn(app, ad.id);
      const mfa = await agent.patch(`${API}/${ad.id}`, { version: 0, mfaRequired: false });
      expect(mfa.status).toBe(403);
      expect(code(mfa)).toBe('AUTHZ_ESCALATION');
      const name = await agent.patch(`${API}/${ad.id}`, { version: 0, name: 'Admin Perpus' });
      expect(name.status).toBe(200);
      const above = await agent.patch(`${API}/${sa.id}`, { version: 0, name: 'Bukan' });
      expect(above.status).toBe(403);
      expect(code(above)).toBe('AUTHZ_ESCALATION');
      expect((await userRow(sa.id)).name).toBe('sa');
    });
  });

  describe('admin resets', () => {
    it('A4: ad resets the password of sa → 403 AUTHZ_ESCALATION; ad resets the 2FA of sa → 403', async () => {
      const app = appAt();
      const agent = await signIn(app, ad.id);
      const password = await agent.post(`${API}/${sa.id}/reset-password`);
      expect(password.status).toBe(403);
      expect(code(password)).toBe('AUTHZ_ESCALATION');
      const totp = await agent.post(`${API}/${sa.id}/reset-2fa`);
      expect(totp.status).toBe(403);
      expect(code(totp)).toBe('AUTHZ_ESCALATION');
      expect(await audits('users.password.reset')).toEqual([]);
      expect(await audits('users.2fa.reset')).toEqual([]);
    });

    it("sa resets st's password: a temporary password once, st's sessions and reset rows gone, the next login must change it", async () => {
      const app = appAt();
      await sessionCookieFor(h, st.id, { now: NOW });
      await h.db
        .insertInto('password_resets')
        .values({ token_hash: sha256hex(randomToken(32)), subject_type: 'staff', subject_id: st.id, expires_at: NOW + 60_000 })
        .execute();
      const agent = await signIn(app, sa.id);

      const res = await agent.post(`${API}/${st.id}/reset-password`, undefined, { 'idempotency-key': 'reset-st-0001' });
      expect(res.status).toBe(200);
      expect(res.headers.get('cache-control')).toBe('no-store');
      const { temporaryPassword } = res.json as { temporaryPassword: string };
      expect(temporaryPassword).toMatch(TEMPORARY);
      expect(Object.keys(res.json as object)).toEqual(['temporaryPassword']);
      expect(await sessionCount(st.id)).toBe(0);
      expect(await h.db.selectFrom('password_resets').select('token_hash').where('subject_id', '=', st.id).execute()).toEqual([]);
      expect(Number((await userRow(st.id)).must_change_password)).toBe(1);

      const resets = await audits('users.password.reset');
      expect(resets).toEqual([{ actor_type: 'staff', actor_id: sa.id, entity: 'staff_users', entity_id: st.id, meta: {} }]);
      const raw = await h.db.selectFrom('audit_log').select('meta').execute();
      for (const r of raw) expect(r.meta).not.toContain(temporaryPassword);

      expect((await login(app, 'st', st.password)).status).toBe(401);
      const signedIn = await login(app, 'st', temporaryPassword);
      expect(signedIn.status).toBe(200);
      expect(signedIn.json).toEqual({ stage: 'full', mustChangePassword: true });

      // `idempotency: none`: the same key runs the reset again, with a new password.
      const again = await agent.post(`${API}/${st.id}/reset-password`, undefined, { 'idempotency-key': 'reset-st-0001' });
      expect(again.status).toBe(200);
      expect(again.headers.get('idempotent-replayed')).toBeNull();
      expect((again.json as { temporaryPassword: string }).temporaryPassword).not.toBe(temporaryPassword);
      expect(await audits('users.password.reset')).toHaveLength(2);
    });

    it('without a fresh reauth → 401 AUTH_REAUTH_REQUIRED; one’s own → 403 AUTHZ_ESCALATION', async () => {
      const app = appAt();
      const stale = await (await signIn(app, sa.id, { reauth: false })).post(`${API}/${st.id}/reset-password`);
      expect(stale.status).toBe(401);
      expect(code(stale)).toBe('AUTH_REAUTH_REQUIRED');
      const self = await (await signIn(app, sa.id)).post(`${API}/${sa.id}/reset-password`);
      expect(self.status).toBe(403);
      expect(code(self)).toBe('AUTHZ_ESCALATION');
    });

    it("sa resets st's 2FA: secret, codes and sessions gone, users.2fa.reset; the next login is full, or mfa_setup when 2FA is required", async () => {
      const app = appAt();
      const tini = await seedStaff(h, { username: 'tini', totp: true, now: NOW });
      const wajib = await seedStaff(h, { username: 'wajib', totp: true, mfaRequired: true, now: NOW });
      await h.db
        .insertInto('staff_recovery_codes')
        .values({ id: newId(), user_id: tini.id, code_hash: sha256hex('x'), used_at: null, created_at: NOW })
        .execute();
      await sessionCookieFor(h, tini.id, { now: NOW });
      expect((await login(app, 'tini', tini.password)).json).toMatchObject({ stage: 'mfa' });
      const agent = await signIn(app, sa.id);

      const res = await agent.post(`${API}/${tini.id}/reset-2fa`);
      expect(res.status).toBe(200);
      expect(res.json).toMatchObject({ id: tini.id, totpEnabled: false });
      const row = await userRow(tini.id);
      expect(row.totp_secret_enc).toBeNull();
      expect(Number(row.totp_enabled)).toBe(0);
      expect(Number(row.totp_reenroll)).toBe(0);
      expect(await h.db.selectFrom('staff_recovery_codes').select('id').where('user_id', '=', tini.id).execute()).toEqual([]);
      expect(await sessionCount(tini.id)).toBe(0);
      expect(await audits('users.2fa.reset')).toEqual([
        { actor_type: 'staff', actor_id: sa.id, entity: 'staff_users', entity_id: tini.id, meta: {} },
      ]);
      expect((await login(app, 'tini', tini.password)).json).toEqual({ stage: 'full', mustChangePassword: false });

      expect((await agent.post(`${API}/${wajib.id}/reset-2fa`)).status).toBe(200);
      expect((await login(app, 'wajib', wajib.password)).json).toEqual({ stage: 'mfa_setup', mustChangePassword: false });
    });
  });

  describe('disable and enable', () => {
    it('sa disabling the only super admin (self) → 403 AUTHZ_ESCALATION', async () => {
      const app = appAt();
      const res = await (await signIn(app, sa.id)).post(`${API}/${sa.id}/disable`);
      expect(res.status).toBe(403);
      expect(code(res)).toBe('AUTHZ_ESCALATION');
      expect((await userRow(sa.id)).status).toBe('active');
    });

    it('a second super admin disables the first while it remains → 200; disabling the last one → 409 LAST_SUPER_ADMIN', async () => {
      const app = appAt();
      const sa2 = await seedStaff(h, { username: 'sa2', roles: [{ key: 'super_admin' }], now: NOW });
      // Every permission through a custom role: rule 3 lets it manage a super admin; it is no super admin itself.
      const all = await seedStaff(h, { username: 'all', roles: [{ permissions: [...systemRolePermissions('super_admin')] }], now: NOW });

      const first = await (await signIn(app, sa2.id)).post(`${API}/${sa.id}/disable`);
      expect(first.status).toBe(200);
      expect(first.json).toMatchObject({ id: sa.id, status: 'disabled' });
      expect(await audits('users.disable')).toEqual([
        { actor_type: 'staff', actor_id: sa2.id, entity: 'staff_users', entity_id: sa.id, meta: {} },
      ]);

      const last = await (await signIn(app, all.id)).post(`${API}/${sa2.id}/disable`);
      expect(last.status).toBe(409);
      expect(code(last)).toBe('LAST_SUPER_ADMIN');
      expect((await userRow(sa2.id)).status).toBe('active');
      expect(await audits('users.disable')).toHaveLength(1);
    });

    it("a disabled user's sessions are gone; enable → active again, users.enable", async () => {
      const app = appAt();
      await sessionCookieFor(h, st.id, { now: NOW });
      const agent = await signIn(app, ad.id);
      const off = await agent.post(`${API}/${st.id}/disable`);
      expect(off.status).toBe(200);
      expect(await sessionCount(st.id)).toBe(0);
      expect((await login(app, 'st', st.password)).status).toBe(403);

      const on = await agent.post(`${API}/${st.id}/enable`);
      expect(on.status).toBe(200);
      expect(on.json).toMatchObject({ status: 'active', version: 2 });
      expect(await audits('users.enable')).toHaveLength(1);
      expect((await login(app, 'st', st.password)).status).toBe(200);
    });

    it('enable from locked revokes every session and remember-me token issued before the lock (§7.1); enabling an active user keeps them', async () => {
      const app = appAt();
      const before = await sessionCookieFor(h, st.id, { now: NOW });
      const { selector } = await withTx(h, (trx) => issueRememberToken(trx, { subjectId: st.id, mfaBound: false, now: NOW }));
      await h.db.updateTable('staff_users').set({ status: 'locked' }).where('id', '=', st.id).execute();

      const agent = await signIn(app, ad.id);
      const on = await agent.post(`${API}/${st.id}/enable`);
      expect(on.status).toBe(200);
      expect(on.json).toMatchObject({ status: 'active' });
      expect(await sessionCount(st.id)).toBe(0);
      expect(await h.db.selectFrom('remember_tokens').select('selector').where('selector', '=', selector).execute()).toEqual([]);
      const old = createAgent(app);
      old.setCookie(SID, before);
      expect((await old.get(`/api/v1/auth/me`)).json).toMatchObject({ authenticated: false });

      // Already active: nothing to end.
      await sessionCookieFor(h, st.id, { now: NOW });
      expect((await agent.post(`${API}/${st.id}/enable`)).status).toBe(200);
      expect(await sessionCount(st.id)).toBe(1);
    });

    it('B4: S1 disables S2 while S2 disables S1 → exactly one stays active; one 200, the other 409 LAST_SUPER_ADMIN or 401', async () => {
      const app = appAt();
      await h.db.deleteFrom('staff_users').where('id', 'in', [ad.id, sa.id]).execute();
      const s1 = await seedStaff(h, { username: 's1', roles: [{ key: 'super_admin' }], now: NOW });
      const s2 = await seedStaff(h, { username: 's2', roles: [{ key: 'super_admin' }], now: NOW });
      const a1 = await signIn(app, s1.id);
      const a2 = await signIn(app, s2.id);

      const replies = await Promise.all([a1.post(`${API}/${s2.id}/disable`), a2.post(`${API}/${s1.id}/disable`)]);
      const statuses = replies.map((r) => r.status).sort();
      expect(statuses[0]).toBe(200);
      const loser = replies.find((r) => r.status !== 200)!;
      expect([409, 401]).toContain(loser.status);
      expect(code(loser)).toBe(loser.status === 409 ? 'LAST_SUPER_ADMIN' : 'AUTH_REQUIRED');
      const active = await h.db.selectFrom('staff_users').select('id').where('id', 'in', [s1.id, s2.id]).where('status', '=', 'active').execute();
      expect(active).toHaveLength(1);
      expect(await audits('users.disable')).toHaveLength(1);
    });
  });

  describe('roles', () => {
    it('a role assigned at a branch that later gained a global permission can still be revoked there: 200, sessions revoked', async () => {
      const app = appAt();
      const branch = await seedBranch();
      const roleId = await seedRole([]);
      await h.db
        .insertInto('user_roles')
        .values({ id: newId(), user_id: st.id, role_id: roleId, branch_id: branch, scope_key: branch, created_at: NOW })
        .execute();
      // Edited after the assignment (updateRole has no scope check): it now carries a global permission.
      await h.db.insertInto('role_permissions').values({ role_id: roleId, permission: 'system.audit.read' }).execute();
      await sessionCookieFor(h, st.id, { now: NOW });

      const res = await (await signIn(app, sa.id)).put(`${API}/${st.id}/roles`, { assignments: [] });
      expect(res.status).toBe(200);
      expect(res.json).toMatchObject({ roles: [] });
      expect(await sessionCount(st.id)).toBe(0);
      expect((await audits('users.roles.update'))[0]?.meta).toEqual({ added: [], removed: [{ role: `r_${roleId}`, branchId: branch }] });
    });

    it("sa adds admin to st → 200, st's authz_version + 1, users.roles.update with meta.added", async () => {
      const app = appAt();
      const adminId = await systemRoleId('admin');
      const before = Number((await userRow(st.id)).authz_version);
      const res = await (await signIn(app, sa.id)).put(`${API}/${st.id}/roles`, { assignments: [{ roleId: adminId, branchId: null }] });
      expect(res.status).toBe(200);
      expect(res.json).toMatchObject({ id: st.id, roles: [{ roleId: adminId, key: 'admin', branchId: null }] });
      expect(Number((await userRow(st.id)).authz_version)).toBe(before + 1);
      expect(await audits('users.roles.update')).toEqual([
        {
          actor_type: 'staff',
          actor_id: sa.id,
          entity: 'staff_users',
          entity_id: st.id,
          meta: { added: [{ role: 'admin', branchId: null }], removed: [] },
        },
      ]);
    });

    it('ad adds a custom role of permissions ad holds → 200; adding admin (rule 5: it carries system.roles.manage) or super_admin → 403', async () => {
      const app = appAt();
      const reader = await seedRole(['system.users.read']);
      const agent = await signIn(app, ad.id);
      const ok = await agent.put(`${API}/${st.id}/roles`, { assignments: [{ roleId: reader, branchId: null }] });
      expect(ok.status).toBe(200);
      expect((await audits('users.roles.update'))[0]?.meta).toEqual({ added: [{ role: `r_${reader}`, branchId: null }], removed: [] });

      for (const key of ['admin', 'super_admin'] as const) {
        const res = await agent.put(`${API}/${st.id}/roles`, {
          assignments: [
            { roleId: reader, branchId: null },
            { roleId: await systemRoleId(key), branchId: null },
          ],
        });
        expect(res.status, key).toBe(403);
        expect(code(res), key).toBe('AUTHZ_ESCALATION');
      }
      expect(await audits('users.roles.update')).toHaveLength(1);
    });

    it('ad changing their own roles → 403 AUTHZ_ESCALATION (rule 4)', async () => {
      const app = appAt();
      const res = await (await signIn(app, ad.id)).put(`${API}/${ad.id}/roles`, { assignments: [] });
      expect(res.status).toBe(403);
      expect(code(res)).toBe('AUTHZ_ESCALATION');
    });

    it("removing st's role revokes st's sessions and remember tokens", async () => {
      const app = appAt();
      const reader = await seedRole(['system.users.read']);
      const sti = await seedStaff(h, { username: 'sti', roles: [{ permissions: ['system.audit.read'] }], now: NOW });
      await sessionCookieFor(h, sti.id, { now: NOW });
      await withTx(h, (trx) => issueRememberToken(trx, { subjectId: sti.id, mfaBound: false, now: NOW }));
      const before = Number((await userRow(sti.id)).authz_version);

      const res = await (await signIn(app, ad.id)).put(`${API}/${sti.id}/roles`, { assignments: [{ roleId: reader, branchId: null }] });
      expect(res.status).toBe(200);
      expect(await sessionCount(sti.id)).toBe(0);
      expect(await h.db.selectFrom('remember_tokens').select('selector').where('subject_id', '=', sti.id).execute()).toEqual([]);
      expect(Number((await userRow(sti.id)).authz_version)).toBe(before + 1);
      const meta = (await audits('users.roles.update'))[0]?.meta as { added: unknown[]; removed: { role: string }[] };
      expect(meta.added).toEqual([{ role: `r_${reader}`, branchId: null }]);
      expect(meta.removed).toHaveLength(1);
    });

    it('an archived branch → 422 archived; an unknown role → 422 not_found; a duplicate pair → 422', async () => {
      const app = appAt();
      const branchRole = await seedRole(['test.branch.manage']);
      const archived = await seedBranch({ archived: true });
      const agent = await signIn(app, sa.id);

      const res = await agent.put(`${API}/${st.id}/roles`, { assignments: [{ roleId: branchRole, branchId: archived }] });
      expect(res.status).toBe(422);
      expect(errorsOf(res)).toEqual([{ path: 'assignments.0.branchId', code: 'archived' }]);

      const unknown = await agent.put(`${API}/${st.id}/roles`, { assignments: [{ roleId: newId(), branchId: null }] });
      expect(unknown.status).toBe(422);
      expect(errorsOf(unknown)).toEqual([{ path: 'assignments.0.roleId', code: 'not_found' }]);

      const twice = await agent.put(`${API}/${st.id}/roles`, {
        assignments: [
          { roleId: branchRole, branchId: null },
          { roleId: branchRole, branchId: null },
        ],
      });
      expect(twice.status).toBe(422);
      expect(errorsOf(twice)).toEqual([{ path: 'assignments.1', code: 'custom' }]);
      expect(await audits('users.roles.update')).toEqual([]);
    });
  });

  describe('test route: PUT _test/branches/:branchId/user-roles (A4 branch admin, S14)', () => {
    it('a branch admin at B: a global role → 403; a global permission at B → 422 ROLE_SCOPE_INVALID; {test.branch.manage} at B → 200, at C → 403', async () => {
      const app = appAt();
      const b = await seedBranch();
      const c = await seedBranch();
      const branchAdmin = await seedStaff(h, { username: 'cabang', roles: [{ permissions: ['test.branch.manage'], branchId: b }], now: NOW });
      const reader = await seedRole(['system.users.read']);
      const manage = await seedRole(['test.branch.manage']);
      const agent = await signIn(app, branchAdmin.id);
      const at = (branchId: string) => `/api/v1/_test/branches/${branchId}/user-roles`;

      const global = await agent.put(at(b), { userId: st.id, assignments: [{ roleId: reader, branchId: null }] });
      expect(global.status).toBe(403);
      expect(code(global)).toBe('AUTHZ_ESCALATION');

      const scope = await agent.put(at(b), { userId: st.id, assignments: [{ roleId: reader, branchId: b }] });
      expect(scope.status).toBe(422);
      expect(code(scope)).toBe('ROLE_SCOPE_INVALID');

      const ok = await agent.put(at(b), { userId: st.id, assignments: [{ roleId: manage, branchId: b }] });
      expect(ok.status).toBe(200);
      expect(ok.json).toMatchObject({ id: st.id, roles: [{ roleId: manage, branchId: b }] });
      expect(await audits('users.roles.update')).toEqual([
        {
          actor_type: 'staff',
          actor_id: branchAdmin.id,
          entity: 'staff_users',
          entity_id: st.id,
          meta: { added: [{ role: `r_${manage}`, branchId: b }], removed: [] },
        },
      ]);

      const elsewhere = await agent.put(at(b), { userId: st.id, assignments: [{ roleId: manage, branchId: c }] });
      expect(elsewhere.status).toBe(403);
      expect(code(elsewhere)).toBe('AUTHZ_ESCALATION');
    });

    it("replaces only the user's assignments at that branch", async () => {
      const app = appAt();
      const b = await seedBranch();
      const branchAdmin = await seedStaff(h, { username: 'cabang', roles: [{ permissions: ['test.branch.manage'], branchId: b }], now: NOW });
      const manage = await seedRole(['test.branch.manage']);
      const reader = await seedRole(['system.users.read']);
      await withTx(h, (trx) =>
        trx
          .insertInto('user_roles')
          .values([
            { id: newId(), user_id: st.id, role_id: reader, branch_id: null, scope_key: '', created_at: NOW },
            { id: newId(), user_id: st.id, role_id: manage, branch_id: b, scope_key: b, created_at: NOW },
          ])
          .execute(),
      );
      // st now holds system.users.read, which the branch admin does not: rule 3 refuses any change to st.
      const agent = await signIn(app, branchAdmin.id);
      const refused = await agent.put(`/api/v1/_test/branches/${b}/user-roles`, { userId: st.id, assignments: [] });
      expect(refused.status).toBe(403);

      const superAgent = await signIn(app, sa.id);
      expect((await superAgent.put(`${API}/${st.id}/roles`, { assignments: [{ roleId: manage, branchId: b }] })).status).toBe(200);
      const res = await agent.put(`/api/v1/_test/branches/${b}/user-roles`, { userId: st.id, assignments: [] });
      expect(res.status).toBe(200);
      expect(res.json).toMatchObject({ roles: [] });
    });
  });

  describe('T20: a role assignment and a concurrent edit of that role', () => {
    /** The UPDATE statements a transaction runs, as `<table>` plus the values they bind, in order. */
    function updateRecorder(): { plugin: Parameters<TestDbHandle['db']['withPlugin']>[0]; updates: { table: string; values: unknown[] }[] } {
      const updates: { table: string; values: unknown[] }[] = [];
      const valuesOf = (node: unknown, out: unknown[] = []): unknown[] => {
        if (node === null || typeof node !== 'object') return out;
        const n = node as { kind?: string; value?: unknown };
        if (n.kind === 'ValueNode') out.push(n.value);
        for (const child of Object.values(node)) valuesOf(child, out);
        return out;
      };
      return {
        updates,
        plugin: {
          transformQuery({ node }) {
            if (node.kind === 'UpdateQueryNode') {
              const table = (node.table as unknown as { table?: { identifier?: { name?: string } } }).table?.identifier?.name ?? '?';
              updates.push({ table, values: valuesOf(node.where) });
            }
            return node;
          },
          transformResult: ({ result }) => Promise.resolve(result),
        },
      };
    }

    it('replaceUserRoles locks every requested role, in id order, after the guard row and before the user row', async () => {
      const [r1, r2] = [await seedRole([]), await seedRole([])].sort();
      const actor = { id: sa.id, grants: await loadGrants(h.db, sa.id) };
      const rec = updateRecorder();
      await withTx(h, (trx) =>
        replaceUserRoles(txCtx(trx.withPlugin(rec.plugin), NOW, { type: 'staff', id: sa.id, ip: null }), actor, st.id, [
          { roleId: r2!, branchId: null },
          { roleId: r1!, branchId: null },
          { roleId: r2!, branchId: null },
        ]),
      );
      expect(rec.updates.slice(0, 4)).toEqual([
        { table: 'roles', values: ['super_admin'] },
        { table: 'roles', values: [r1] },
        { table: 'roles', values: [r2] },
        { table: 'staff_users', values: [st.id] },
      ]);
    });

    it("an edit of the role committed after the assignment bumps the new holder (meaningful on PostgreSQL READ COMMITTED)", async () => {
      const roleId = await seedRole(['system.audit.read']);
      const actor = { id: sa.id, grants: await loadGrants(h.db, sa.id) };
      const staffActor = { type: 'staff', id: sa.id, ip: null } as const;
      const before = Number((await userRow(st.id)).authz_version);
      const version = Number((await h.db.selectFrom('roles').select('version').where('id', '=', roleId).executeTakeFirstOrThrow()).version);

      let entered!: () => void;
      const assigned = new Promise<void>((resolve) => (entered = resolve));
      let release!: () => void;
      const held = new Promise<void>((resolve) => (release = resolve));
      const t1 = withTx(h, async (trx) => {
        await replaceUserRoles(txCtx(trx, NOW, staffActor), actor, st.id, [{ roleId, branchId: null }]);
        entered();
        await held; // T1 keeps its transaction open while T2 starts
      });
      await assigned;
      const t2 = withTx(h, (trx) => updateRole(txCtx(trx, NOW, staffActor), actor, roleId, { version, permissions: [] }));
      release();
      await t1;
      await t2;
      // T1 bumped st once (the assignment) and T2 once more (st held the role it changed).
      expect(Number((await userRow(st.id)).authz_version)).toBe(before + 2);
    });
  });

  describe('the CLI actor {cli: true} (Task 24, S26)', () => {
    const cli = { type: 'cli', id: null, ip: null } as const;

    it('skips rules 2-5: resets the password and the 2FA of a super admin, audited with actor type cli', async () => {
      const run = runnerFor(h, NOW, cli);
      await run((tx) => adminResetPassword(tx, { cli: true }, sa.id, { passwordHash: '$scrypt$x' }));
      await run((tx) => adminResetTotp(tx, { cli: true }, sa.id));
      expect(await userRow(sa.id)).toMatchObject({ password_hash: '$scrypt$x', updated_by: null });
      expect(Number((await userRow(sa.id)).must_change_password)).toBe(1);
      expect(await audits('users.password.reset')).toEqual([
        { actor_type: 'cli', actor_id: null, entity: 'staff_users', entity_id: sa.id, meta: {} },
      ]);
      expect(await audits('users.2fa.reset')).toEqual([{ actor_type: 'cli', actor_id: null, entity: 'staff_users', entity_id: sa.id, meta: {} }]);
    });

    it('never rule 6: disabling the last super admin → LAST_SUPER_ADMIN; an unknown user → NOT_FOUND', async () => {
      const run = runnerFor(h, NOW, cli);
      await expect(run((tx) => setUserStatus(tx, { cli: true }, sa.id, 'disabled'))).rejects.toMatchObject({ code: 'LAST_SUPER_ADMIN' });
      expect((await userRow(sa.id)).status).toBe('active');
      await expect(run((tx) => adminResetTotp(tx, { cli: true }, newId()))).rejects.toMatchObject({ code: 'NOT_FOUND' });
      expect(await audits('users.disable')).toEqual([]);
    });
  });

  it('the audit chain verifies after a run of writes', async () => {
    const app = appAt();
    const agent = await signIn(app, sa.id);
    expect((await agent.post(API, { username: 'siti', name: 'Siti', password: STRONG })).status).toBe(201);
    expect((await agent.post(`${API}/${st.id}/disable`)).status).toBe(200);
    expect((await verifyAuditChain(h)).ok).toBe(true);
  });
});
