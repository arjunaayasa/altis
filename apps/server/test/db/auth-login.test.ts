import { fork, type ChildProcess } from 'node:child_process';
import fsp from 'node:fs/promises';
import os from 'node:os';
import path from 'node:path';
import { bumpAuthzVersion, createPasswordHasher, randomToken, sha256hex, writeSettings, type PasswordHasher } from '@altis/core';
import { PHASE1_MIGRATIONS, countRows, runMigrations, verifyAuditChain, withTx, type DbHandle } from '@altis/db';
import { DomainError, newId, systemRolePermissions } from '@altis/shared';
import { afterAll, afterEach, beforeAll, beforeEach, describe, expect, it, vi } from 'vitest';
import { engineLabel, testDb, testDbContext, type TestDbHandle } from '../../../../tools/test/test-db.js';
import { BANNER_PROVIDERS } from '../../src/api/banners.js';
import { createApp } from '../../src/app.js';
import type { Config } from '../../src/config.js';
import { csrfKey, preSessionCsrfToken } from '../../src/http/csrf.js';
import { createAgent, type Agent, type AgentReply } from '../agent.js';
import { recordingLogger, sampleConfig } from '../support.js';
import { seedStaff, sessionCsrfFor } from '../support-auth.js';

// The auth API of Task 15 on the engine picked by ALTIS_TEST_DB: `POST auth/login` (spec §7.1: the DB rate limits
// counted before any verification, the known-device bypass, the dummy hash for unknown users, the refunds in the
// session's transaction, 2FA sessions), `POST auth/logout` and `GET auth/me` (M10: a pre-2FA session learns nothing
// of the account's rights). The parallel-failure case runs three child processes on the same database (B5).

const ctx = testDbContext();
let h: TestDbHandle;

const SEC = 1000;
/**
 * 09:00:05 UTC: 5 s into a 15-minute and an hour window, so that no case crosses a window boundary (M26); in the past,
 * since an audit entry may not be dated ahead of the real clock.
 */
const NOW = Date.UTC(2026, 9, 20, 9, 0, 5);
const CONFIG = sampleConfig();
const VERSION = '1.4.2';
const LOGIN = '/api/v1/auth/login';
const LOGOUT = '/api/v1/auth/logout';
const ME = '/api/v1/auth/me';
const IP = '203.0.113.9';
/** baseUrl is https: every auth cookie carries the `__Host-` prefix. */
const SID = '__Host-altis_sid';
const DEV = '__Host-altis_dev';
const RM = '__Host-altis_rm';
const CSRF = '__Host-altis_csrf';

interface AppOptions {
  config?: Config;
  hasher?: PasswordHasher;
  /** Default: the test database itself. */
  db?: DbHandle;
}

/** The app on the test database with a fake clock at NOW and a recording logger; ALL_ROUTES. */
function appAt(o: AppOptions = {}) {
  const clock = { now: NOW };
  const config = o.config ?? CONFIG;
  const log = recordingLogger();
  const app = createApp({
    state: { phase: 'ready', db: o.db ?? h, config },
    version: VERSION,
    buildId: 'build-x',
    log,
    clock: () => clock.now,
    ...(o.hasher === undefined ? {} : { services: { hasher: o.hasher } }),
  });
  return { app, clock, config, log };
}

type KyselyPlugin = Parameters<TestDbHandle['db']['withPlugin']>[0];

/** One statement the app ran through {@link watched}: its node kind and the tables it names. */
interface Statement {
  kind: string;
  tables: string[];
}

const WATCHED_TABLES = ['staff_users', 'rate_limits', 'sessions', 'remember_tokens'];

/**
 * The test database seen through a plugin that records every statement, and fails the ones `failWhen` picks (as a
 * database that breaks at that moment would).
 */
function watched() {
  const statements: Statement[] = [];
  let fail: ((s: Statement) => boolean) | null = null;
  const plugin: KyselyPlugin = {
    transformQuery({ node }) {
      const json = JSON.stringify(node);
      const s = { kind: node.kind, tables: WATCHED_TABLES.filter((t) => json.includes(`"name":"${t}"`)) };
      statements.push(s);
      if (fail?.(s) === true) throw new Error('the injected statement failure');
      return node;
    },
    transformResult: async ({ result }) => result,
  };
  const handle: DbHandle = { ...h, db: h.db.withPlugin(plugin) };
  return {
    handle,
    statements,
    failWhen(f: ((s: Statement) => boolean) | null) {
      fail = f;
    },
  };
}

type TestApp = ReturnType<typeof appAt>;

interface Visitor {
  agent: Agent;
  /** The pre-session CSRF token of the agent's `altis_csrf` cookie. */
  csrf: string;
  login(body: unknown): Promise<AgentReply>;
}

/** A browser without a session at `peer` (default IP): a pre-session CSRF cookie and its token (D20). */
function visitor(t: TestApp, o: { peer?: string; headers?: Record<string, string> } = {}): Visitor {
  const agent = createAgent(t.app, { peer: o.peer ?? IP, ...(o.headers === undefined ? {} : { headers: o.headers }) });
  const value = randomToken(32);
  agent.setCookie(CSRF, value);
  const csrf = preSessionCsrfToken(csrfKey(t.config), value);
  return { agent, csrf, login: (body) => agent.post(LOGIN, body, { 'x-csrf-token': csrf }) };
}

const code = (res: AgentReply): string | undefined => (res.json as { code?: string } | undefined)?.code;
const withoutTraceId = (res: AgentReply): Record<string, unknown> => {
  const { traceId, ...rest } = res.json as Record<string, unknown>;
  expect(traceId).toEqual(expect.any(String));
  return rest;
};
const cookieLine = (res: AgentReply, name: string): string | undefined =>
  res.headers.getSetCookie().find((line) => line.startsWith(`${name}=`));

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

const sessionsOf = (userId: string) =>
  h.db.selectFrom('sessions').select(['id', 'mfa_passed', 'remember_selector', 'ip', 'user_agent']).where('subject_id', '=', userId).execute();
const lastLoginAt = async (userId: string): Promise<number | null> => {
  const r = await h.db.selectFrom('staff_users').select('last_login_at').where('id', '=', userId).executeTakeFirstOrThrow();
  return r.last_login_at === null ? null : Number(r.last_login_at);
};

/** A fork of login-child.mjs per entry of `options`; each starts once all report 'ready' (as core's runChildren). */
async function runChildren<R>(options: object[], timeoutMs = 50_000): Promise<{ codes: (number | null)[]; reports: (R | undefined)[] }> {
  const children: ChildProcess[] = [];
  const timer = setTimeout(() => {
    for (const child of children) child.kill('SIGKILL');
  }, timeoutMs);
  try {
    const runs = options.map((o) => {
      const child = fork(path.join(import.meta.dirname, '../fixtures/login-child.mjs'), [JSON.stringify(o)], {
        cwd: path.resolve(import.meta.dirname, '../../../..'),
        env: process.env,
        execArgv: ['--import', 'tsx'],
        stdio: ['ignore', 'inherit', 'inherit', 'ipc'],
      });
      children.push(child);
      let report: R | undefined;
      const ready = new Promise<void>((resolve, reject) => {
        child.on('message', (message) => {
          if (message === 'ready') resolve();
          else report = message as R;
        });
        child.once('error', reject);
        child.once('exit', (exitCode) => reject(new Error(`child exited with ${String(exitCode)} before it was ready`)));
      });
      // 'close' comes after every IPC message has been delivered.
      const exited = new Promise<{ code: number | null; report: R | undefined }>((resolve) =>
        child.once('close', (exitCode) => resolve({ code: exitCode, report })),
      );
      return { child, ready, exited };
    });
    await Promise.all(runs.map((r) => r.ready));
    for (const r of runs) r.child.send('go');
    const done = await Promise.all(runs.map((r) => r.exited));
    return { codes: done.map((d) => d.code), reports: done.map((d) => d.report) };
  } finally {
    clearTimeout(timer);
    for (const child of children) if (child.exitCode === null && child.signalCode === null) child.kill('SIGKILL');
  }
}

describe.skipIf(!ctx.available)(`auth API: login, logout, me [${engineLabel()}]`, () => {
  let dataDir: string;

  beforeAll(async () => {
    h = await testDb();
    dataDir = await fsp.mkdtemp(path.join(os.tmpdir(), 'altis-auth-login-'));
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

  afterEach(() => {
    BANNER_PROVIDERS.length = 0;
  });

  describe('success', () => {
    it('200 {stage: full, mustChangePassword: false}, altis_sid and altis_dev, and an X-CSRF-Token that auth/logout accepts', async () => {
      const t = appAt();
      const budi = await seedStaff(h, { username: 'budi', now: NOW });
      const v = visitor(t, { headers: { 'user-agent': 'Mozilla/5.0 (Uji)' } });

      const res = await v.login({ username: 'budi', password: budi.password });
      expect(res.status).toBe(200);
      expect(res.json).toEqual({ stage: 'full', mustChangePassword: false });

      const sid = v.agent.cookies.get(SID);
      expect(sid).toMatch(/^[A-Za-z0-9_-]{43}$/);
      expect(cookieLine(res, SID)).not.toMatch(/Max-Age/i); // a browser-session cookie
      expect(v.agent.cookies.get(DEV)).toMatch(/^[A-Za-z0-9_-]{22}\.[A-Za-z0-9_-]{22}$/);
      expect(cookieLine(res, DEV)).toMatch(/Max-Age=15552000/);
      expect(cookieLine(res, DEV)).toMatch(/HttpOnly/);
      expect(cookieLine(res, RM)).toBeUndefined();
      const csrf = res.headers.get('x-csrf-token');
      expect(csrf).toBe(sessionCsrfFor(CONFIG, sid!));

      const sessions = await sessionsOf(budi.id);
      expect(sessions).toHaveLength(1);
      expect(sessions[0]).toMatchObject({ id: sha256hex(sid!), ip: IP, user_agent: 'Mozilla/5.0 (Uji)', remember_selector: null });
      expect(Number(sessions[0]!.mfa_passed)).toBe(1);

      const out = await v.agent.post(LOGOUT, undefined, { 'x-csrf-token': csrf! });
      expect(out.status).toBe(204);
      expect(await sessionsOf(budi.id)).toEqual([]);
    });

    it('one auth.login.success row and last_login_at; login:ip and login:user lowered by 1, the login:user-ip rows gone', async () => {
      const t = appAt();
      const budi = await seedStaff(h, { username: 'budi', now: NOW });
      for (let i = 0; i < 2; i += 1) {
        expect((await visitor(t).login({ username: 'budi', password: `salah-${i}-sandi` })).status).toBe(401);
      }
      expect(await limit(`login:user-ip:BUDI:${IP}`)).toEqual([2]);
      expect(await limit(`login:ip:${IP}`)).toEqual([2]);
      expect(await limit('login:user:BUDI')).toEqual([2]);

      t.clock.now = NOW + 10 * SEC;
      expect((await visitor(t).login({ username: 'budi', password: budi.password })).status).toBe(200);
      expect(await limit(`login:user-ip:BUDI:${IP}`)).toEqual([]);
      expect(await limit(`login:ip:${IP}`)).toEqual([2]);
      expect(await limit('login:user:BUDI')).toEqual([2]);

      const success = await audits('auth.login.success');
      expect(success).toHaveLength(1);
      expect(success[0]).toMatchObject({ actor_type: 'staff', actor_id: budi.id, entity: 'staff_users', entity_id: budi.id, ip: IP });
      expect(await lastLoginAt(budi.id)).toBe(NOW + 10 * SEC);
    });

    it('a pending password change is reported; a login while signed in replaces the earlier session', async () => {
      const t = appAt();
      const budi = await seedStaff(h, { username: 'budi', mustChangePassword: true, now: NOW });
      const v = visitor(t);
      const first = await v.login({ username: 'budi', password: budi.password });
      expect(first.json).toEqual({ stage: 'full', mustChangePassword: true });
      const firstSid = v.agent.cookies.get(SID)!;

      // The browser now holds a session: its writes carry the session's CSRF token.
      const again = await v.agent.post(LOGIN, { username: 'budi', password: budi.password }, { 'x-csrf-token': first.headers.get('x-csrf-token')! });
      expect(again.status).toBe(200);
      const secondSid = v.agent.cookies.get(SID)!;
      expect(secondSid).not.toBe(firstSid);
      expect((await sessionsOf(budi.id)).map((s) => s.id)).toEqual([sha256hex(secondSid)]);
    });
  });

  describe('failures', () => {
    it('a wrong password → 401 AUTH_INVALID_CREDENTIALS and one auth.login.failed row (reason invalid_credentials)', async () => {
      const t = appAt();
      const budi = await seedStaff(h, { username: 'budi', now: NOW });
      const v = visitor(t);
      const res = await v.login({ username: ' Budi ', password: `${budi.password}x` });
      expect(res.status).toBe(401);
      expect(code(res)).toBe('AUTH_INVALID_CREDENTIALS');
      expect(v.agent.cookies.has(SID)).toBe(false);
      expect(v.agent.cookies.has(DEV)).toBe(false);
      expect(await sessionsOf(budi.id)).toEqual([]);
      const failed = await audits('auth.login.failed');
      expect(failed).toEqual([
        {
          actor_type: 'anonymous',
          actor_id: null,
          entity: 'staff_users',
          entity_id: budi.id,
          ip: IP,
          meta: { usernameKey: 'BUDI', reason: 'invalid_credentials', stage: 'password' },
        },
      ]);
    });

    it('an unknown username → the same status and body but the traceId; verifyDummy ran once', async () => {
      const real = createPasswordHasher();
      const hasher = {
        hash: vi.fn(real.hash),
        verify: vi.fn(real.verify),
        verifyDummy: vi.fn(real.verifyDummy),
        needsRehash: vi.fn(real.needsRehash),
      };
      const t = appAt({ hasher });
      const budi = await seedStaff(h, { username: 'budi', now: NOW });

      const wrong = await visitor(t).login({ username: 'budi', password: `${budi.password}x` });
      expect(hasher.verify).toHaveBeenCalledTimes(1);
      const unknown = await visitor(t).login({ username: 'tidak-ada', password: budi.password });
      expect(hasher.verifyDummy).toHaveBeenCalledTimes(1);
      expect(hasher.verify).toHaveBeenCalledTimes(1);
      expect(unknown.status).toBe(wrong.status);
      expect(withoutTraceId(unknown)).toEqual(withoutTraceId(wrong));
      expect(unknown.headers.getSetCookie()).toEqual(wrong.headers.getSetCookie());
      const failed = await audits('auth.login.failed');
      expect(failed[1]).toMatchObject({ entity_id: null, meta: { usernameKey: 'TIDAK-ADA', reason: 'invalid_credentials', stage: 'password' } });
    });

    it('a disabled or locked user with the right password → 403 AUTH_ACCOUNT_DISABLED, no session', async () => {
      const t = appAt();
      for (const status of ['disabled', 'locked']) {
        const user = await seedStaff(h, { username: `akun_${status}`, status, now: NOW });
        const v = visitor(t);
        const res = await v.login({ username: `akun_${status}`, password: user.password });
        expect(res.status).toBe(403);
        expect(code(res)).toBe('AUTH_ACCOUNT_DISABLED');
        expect(v.agent.cookies.has(SID)).toBe(false);
        expect(await sessionsOf(user.id)).toEqual([]);
      }
      expect((await audits('auth.login.failed')).map((a) => a.meta['reason'])).toEqual(['disabled', 'locked']);
    });

    it('a username no account can have (blank, a control character) → 401 without counting or auditing; a stray key → 422', async () => {
      const t = appAt();
      // U+FDFA is one code point that NFKC turns into 18: 60 of them pass the body schema (191 at most) and give a key
      // of 1080 characters, longer than any username key (191) and than a rate-limit subject (1024).
      const fdfa = String.fromCodePoint(0xfdfa);
      for (const username of ['   ', 'bu\u0000di', fdfa.repeat(60)]) {
        const res = await visitor(t).login({ username, password: 'sandi-apa-saja' });
        expect(res.status, JSON.stringify(username)).toBe(401);
        expect(code(res)).toBe('AUTH_INVALID_CREDENTIALS');
      }
      expect(await countRows(h.db.selectFrom('rate_limits'))).toBe(0);
      expect(await countRows(h.db.selectFrom('audit_log'))).toBe(0);
      const extra = await visitor(t).login({ username: 'budi', password: 'sandi-apa-saja', extra: 1 });
      expect(extra.status).toBe(422);
    });

    it('a busy hasher (AUTH_BUSY) → 429 with Retry-After: 1, nothing audited, the hits given back (no lockout)', async () => {
      const busy = (): Promise<never> => Promise.reject(new DomainError('AUTH_BUSY', { meta: { retryAfterS: 1 } }));
      const real = createPasswordHasher();
      const t = appAt({ hasher: { ...real, verify: busy, verifyDummy: busy } });
      const budi = await seedStaff(h, { username: 'budi', now: NOW });
      for (let i = 0; i < 6; i += 1) {
        const res = await visitor(t).login({ username: 'budi', password: budi.password });
        expect(res.status).toBe(429);
        expect(code(res)).toBe('AUTH_BUSY');
        expect(res.headers.get('retry-after')).toBe('1');
      }
      expect(await countRows(h.db.selectFrom('audit_log'))).toBe(0);
      expect(await sessionsOf(budi.id)).toEqual([]);
      expect(await limit(`login:user-ip:BUDI:${IP}`)).toEqual([0]);
      expect(await limit(`login:ip:${IP}`)).toEqual([0]);
      expect(await limit('login:user:BUDI')).toEqual([0]);
      // Once the queue has room, budi gets in from the same address.
      expect((await visitor(appAt()).login({ username: 'budi', password: budi.password })).status).toBe(200);
    });

    it('a busy hasher whose refund fails too → still 429 AUTH_BUSY with Retry-After: 1; the failure logged without the username', async () => {
      const w = watched();
      const real = createPasswordHasher();
      const busy = (): Promise<never> => {
        // The database breaks at the moment the hits would be given back.
        w.failWhen((st) => st.tables.includes('rate_limits'));
        return Promise.reject(new DomainError('AUTH_BUSY', { meta: { retryAfterS: 1 } }));
      };
      const t = appAt({ db: w.handle, hasher: { ...real, verify: busy, verifyDummy: busy } });
      const budi = await seedStaff(h, { username: 'budi', now: NOW });
      const res = await visitor(t).login({ username: 'budi', password: budi.password });
      expect(res.status).toBe(429);
      expect(code(res)).toBe('AUTH_BUSY');
      expect(res.headers.get('retry-after')).toBe('1');
      // Not given back: the hits stay.
      expect(await limit('login:user:BUDI')).toEqual([1]);
      const logged = t.log.lines.filter((line) => line.level === 'error');
      expect(logged).toEqual([expect.objectContaining({ msg: expect.stringMatching(/given back/) })]);
      expect(JSON.stringify(t.log.lines)).not.toMatch(/budi/i);
    });

    it('before the hash, a known and an unknown username run the same single staff_users query', async () => {
      const w = watched();
      const real = createPasswordHasher();
      let mark = -1;
      const marked =
        <A extends unknown[], R>(f: (...a: A) => Promise<R>) =>
        (...a: A): Promise<R> => {
          mark = w.statements.length;
          return f(...a);
        };
      const t = appAt({ db: w.handle, hasher: { ...real, verify: marked(real.verify), verifyDummy: marked(real.verifyDummy) } });
      await seedStaff(h, { username: 'budi', now: NOW });
      const beforeTheHash = async (username: string): Promise<Statement[]> => {
        const start = w.statements.length;
        expect((await visitor(t).login({ username, password: 'salah-sandi-waktu' })).status).toBe(401);
        expect(mark).toBeGreaterThanOrEqual(start);
        return w.statements.slice(start, mark).filter((st) => st.tables.includes('staff_users'));
      };
      const known = await beforeTheHash('budi');
      const unknown = await beforeTheHash('tidak-ada');
      expect(known).toEqual([{ kind: 'SelectQueryNode', tables: ['staff_users'] }]);
      expect(unknown).toEqual(known);
    });
  });

  describe('the account changed while the password was being verified (the session follows the row as it is then)', () => {
    /** The real hasher, whose verify() first lets another request commit `change`. */
    const changingHasher = (change: () => Promise<unknown>): PasswordHasher => {
      const real = createPasswordHasher();
      return {
        ...real,
        verify: async (password, phc) => {
          await change();
          return real.verify(password, phc);
        },
      };
    };
    const authzVersions = async (userId: string): Promise<number[]> =>
      (await h.db.selectFrom('sessions').select('authz_version').where('subject_id', '=', userId).execute()).map((r) => Number(r.authz_version));

    it('a password reset → 401 AUTH_INVALID_CREDENTIALS, no session, cookie or remember token; the hits stay; auth.login.failed', async () => {
      const budi = await seedStaff(h, { username: 'budi', now: NOW });
      const reset = await createPasswordHasher().hash('sandi-baru-dari-admin');
      const t = appAt({
        hasher: changingHasher(() => h.db.updateTable('staff_users').set({ password_hash: reset }).where('id', '=', budi.id).execute()),
      });
      const v = visitor(t);
      const res = await v.login({ username: 'budi', password: budi.password, remember: true });
      expect(res.status).toBe(401);
      expect(code(res)).toBe('AUTH_INVALID_CREDENTIALS');
      for (const name of [SID, DEV, RM]) expect(v.agent.cookies.has(name), name).toBe(false);
      expect(await sessionsOf(budi.id)).toEqual([]);
      expect(await countRows(h.db.selectFrom('remember_tokens'))).toBe(0);
      expect(await lastLoginAt(budi.id)).toBeNull();
      expect(await audits('auth.login.success')).toEqual([]);
      expect(await limit('login:user:BUDI')).toEqual([1]);
      expect(await limit(`login:user-ip:BUDI:${IP}`)).toEqual([1]);
      expect(await limit(`login:ip:${IP}`)).toEqual([1]);
      expect(await audits('auth.login.failed')).toEqual([
        expect.objectContaining({ actor_type: 'anonymous', entity_id: budi.id, meta: { usernameKey: 'BUDI', reason: 'invalid_credentials', stage: 'password' } }),
      ]);
      // The stored hash is the reset one.
      const row = await h.db.selectFrom('staff_users').select('password_hash').where('id', '=', budi.id).executeTakeFirstOrThrow();
      expect(row.password_hash).toBe(reset);
    });

    it('2FA enabled (and the rights changed) → stage mfa, mfa_passed 0, the new authz_version; no remember token, altis_dev or altis_rm', async () => {
      const budi = await seedStaff(h, { username: 'budi', now: NOW });
      const t = appAt({
        hasher: changingHasher(() =>
          h.db.updateTable('staff_users').set({ totp_enabled: 1, authz_version: 7 }).where('id', '=', budi.id).execute(),
        ),
      });
      const v = visitor(t);
      const res = await v.login({ username: 'budi', password: budi.password, remember: true });
      expect(res.status).toBe(200);
      expect(res.json).toEqual({ stage: 'mfa', mustChangePassword: false });
      expect(v.agent.cookies.has(SID)).toBe(true);
      expect(v.agent.cookies.has(DEV)).toBe(false);
      expect(v.agent.cookies.has(RM)).toBe(false);
      const sessions = await sessionsOf(budi.id);
      expect(sessions).toHaveLength(1);
      expect(Number(sessions[0]!.mfa_passed)).toBe(0);
      expect(sessions[0]!.remember_selector).toBeNull();
      expect(await authzVersions(budi.id)).toEqual([7]);
      expect(await countRows(h.db.selectFrom('remember_tokens'))).toBe(0);
      expect(await lastLoginAt(budi.id)).toBeNull();
      expect(await audits('auth.login.success')).toEqual([]);
    });

    it('a pending password change set meanwhile is reported', async () => {
      const budi = await seedStaff(h, { username: 'budi', now: NOW });
      const t = appAt({
        hasher: changingHasher(() => h.db.updateTable('staff_users').set({ must_change_password: 1 }).where('id', '=', budi.id).execute()),
      });
      const res = await visitor(t).login({ username: 'budi', password: budi.password });
      expect(res.json).toEqual({ stage: 'full', mustChangePassword: true });
    });

    it('disabled → 403 AUTH_ACCOUNT_DISABLED, no session; auth.login.failed with reason disabled; the hits stay', async () => {
      const budi = await seedStaff(h, { username: 'budi', now: NOW });
      const t = appAt({
        hasher: changingHasher(() => h.db.updateTable('staff_users').set({ status: 'disabled' }).where('id', '=', budi.id).execute()),
      });
      const v = visitor(t);
      const res = await v.login({ username: 'budi', password: budi.password, remember: true });
      expect(res.status).toBe(403);
      expect(code(res)).toBe('AUTH_ACCOUNT_DISABLED');
      expect(v.agent.cookies.has(SID)).toBe(false);
      expect(await sessionsOf(budi.id)).toEqual([]);
      expect(await countRows(h.db.selectFrom('remember_tokens'))).toBe(0);
      expect(await limit('login:user:BUDI')).toEqual([1]);
      expect((await audits('auth.login.failed')).map((a) => a.meta['reason'])).toEqual(['disabled']);
    });
  });

  describe('A3 rate limits', () => {
    it('5 failures for budi from one IP; the 6th with the right password → 429 with Retry-After; with a valid altis_dev → 200', async () => {
      const t = appAt();
      const budi = await seedStaff(h, { username: 'budi', now: NOW });
      // A device budi signed in on before, elsewhere.
      const device = visitor(t, { peer: '198.51.100.20' });
      expect((await device.login({ username: 'budi', password: budi.password })).status).toBe(200);
      const dev = device.agent.cookies.get(DEV)!;

      for (let i = 0; i < 5; i += 1) {
        expect((await visitor(t).login({ username: 'budi', password: `salah-${i}-sandi` })).status).toBe(401);
      }
      const sixth = await visitor(t).login({ username: 'budi', password: budi.password });
      expect(sixth.status).toBe(429);
      expect(code(sixth)).toBe('AUTH_TOO_MANY_ATTEMPTS');
      // 15-minute window from 09:00:00, now 09:00:05.
      expect(sixth.headers.get('retry-after')).toBe('895');
      expect(cookieLine(sixth, SID)).toBeUndefined();
      // A refused attempt is not verified, so not audited (D9).
      expect(await audits('auth.login.failed')).toHaveLength(5);

      const known = visitor(t);
      known.agent.setCookie(DEV, dev);
      const ok = await known.login({ username: 'budi', password: budi.password });
      expect(ok.status).toBe(200);
      // Counted in login:dev only (and given back), not in the per-IP buckets.
      expect(await limit(`login:dev:${dev.split('.')[0]}`)).toEqual([0]);
      expect(await limit(`login:user-ip:BUDI:${IP}`)).toEqual([6]);
      expect(await limit(`login:ip:${IP}`)).toEqual([6]);

      // The device cookie proves budi only: another username from it is counted per IP.
      const ani = await seedStaff(h, { username: 'ani', now: NOW });
      const other = visitor(t);
      other.agent.setCookie(DEV, dev);
      expect((await other.login({ username: 'ani', password: ani.password })).status).toBe(200);
      expect(await limit(`login:ip:${IP}`)).toEqual([6]);
      expect(await limit(`login:dev:${dev.split('.')[0]}`)).toEqual([0]);
      // ...and that login added ani to the device cookie.
      expect(other.agent.cookies.get(DEV)).toMatch(/^[A-Za-z0-9_-]{22}(\.[A-Za-z0-9_-]{22}){2}$/);
    });

    it('no false lockout: 25 successful logins of budi from one IP within 15 min (clock steps 30 s) → all 200', async () => {
      const t = appAt();
      const budi = await seedStaff(h, { username: 'budi', now: NOW });
      for (let i = 0; i < 25; i += 1) {
        t.clock.now = NOW + i * 30 * SEC;
        expect((await visitor(t).login({ username: 'budi', password: budi.password })).status, `login ${i + 1}`).toBe(200);
      }
      expect(await limit(`login:ip:${IP}`)).toEqual([0]);
      expect(await limit('login:user:BUDI')).toEqual([0]);
      expect(await audits('auth.login.success')).toHaveLength(25);
    });

    it('parallel: 50 failed logins of budi from 3 processes → at most 5 auth.login.failed, at least 45 × 429, the chain verifies', async () => {
      await seedStaff(h, { username: 'budi', now: NOW });
      const run = await runChildren<{ results: { status: number; code: string | null }[] }>(
        [17, 17, 16].map((count) => ({
          db: h.config,
          dataDir: h.dataDir,
          config: CONFIG,
          count,
          username: 'budi',
          password: 'salah-sandi-paralel',
          peer: IP,
          now: NOW,
        })),
      );
      expect(run.codes).toEqual([0, 0, 0]);
      const results = run.reports.flatMap((r) => r?.results ?? []);
      expect(results).toHaveLength(50);
      const refused = results.filter((r) => r.status === 429 && r.code === 'AUTH_TOO_MANY_ATTEMPTS');
      const wrong = results.filter((r) => r.status === 401 && r.code === 'AUTH_INVALID_CREDENTIALS');
      expect(refused.length + wrong.length).toBe(50);
      expect(refused.length).toBeGreaterThanOrEqual(45);
      const failed = (await audits('auth.login.failed')).filter((a) => a.meta['reason'] === 'invalid_credentials');
      expect(failed.length).toBeLessThanOrEqual(5);
      expect(failed).toHaveLength(wrong.length);
      expect(await verifyAuditChain(h)).toMatchObject({ ok: true });
    }, 60_000);

    it('login:ip: 20 failures for 20 usernames from one IP → a 21st user from that IP → 429', async () => {
      const t = appAt();
      const budi = await seedStaff(h, { username: 'budi', now: NOW });
      for (let i = 0; i < 20; i += 1) {
        expect((await visitor(t).login({ username: `tamu${i}`, password: 'salah-sandi-tamu' })).status).toBe(401);
      }
      const res = await visitor(t).login({ username: 'budi', password: budi.password });
      expect(res.status).toBe(429);
      expect(code(res)).toBe('AUTH_TOO_MANY_ATTEMPTS');
      // From another address budi still gets in.
      expect((await visitor(t, { peer: '198.51.100.30' }).login({ username: 'budi', password: budi.password })).status).toBe(200);
    });

    it('login:user: 50 failures for budi from 50 IPs → a 51st IP → 429', async () => {
      const t = appAt();
      const budi = await seedStaff(h, { username: 'budi', now: NOW });
      for (let i = 1; i <= 50; i += 1) {
        expect((await visitor(t, { peer: `198.51.100.${i}` }).login({ username: 'budi', password: 'salah-sandi-budi' })).status).toBe(401);
      }
      const res = await visitor(t, { peer: '192.0.2.51' }).login({ username: 'budi', password: budi.password });
      expect(res.status).toBe(429);
      expect(code(res)).toBe('AUTH_TOO_MANY_ATTEMPTS');
    }, 30_000);

    it('Review Focus 1: hops 0 behind a local proxy (collapsed): 30 failures for 30 usernames do not lock ani out; login:user still applies', async () => {
      const t = appAt({ config: sampleConfig({ trustProxy: { hops: 0 } }) });
      const ani = await seedStaff(h, { username: 'ani', now: NOW });
      const proxied = () => visitor(t, { peer: '127.0.0.1', headers: { 'x-forwarded-for': '198.51.100.7' } });

      for (let i = 0; i < 30; i += 1) {
        expect((await proxied().login({ username: `staf${i}`, password: 'salah-sandi-staf' })).status).toBe(401);
      }
      // The per-IP buckets are off for a collapsed request.
      expect(await limit('login:ip:127.0.0.1')).toEqual([]);
      expect((await proxied().login({ username: 'ani', password: ani.password })).status).toBe(200);

      for (let i = 0; i < 50; i += 1) {
        expect((await proxied().login({ username: 'ani', password: 'salah-sandi-ani' })).status).toBe(401);
      }
      const res = await proxied().login({ username: 'ani', password: ani.password });
      expect(res.status).toBe(429);
      expect(code(res)).toBe('AUTH_TOO_MANY_ATTEMPTS');
    }, 30_000);

    it("Review Focus 2: user admin signs in as '  ＡＤＭＩＮ  ' (and as 'Admin') → 200", async () => {
      const t = appAt();
      const admin = await seedStaff(h, { username: 'admin', roles: [{ key: 'admin' }], now: NOW });
      for (const username of ['  ＡＤＭＩＮ  ', 'Admin']) {
        const res = await visitor(t).login({ username, password: admin.password });
        expect(res.status, username).toBe(200);
      }
      expect((await audits('auth.login.success')).map((a) => a.actor_id)).toEqual([admin.id, admin.id]);
    });
  });

  describe('2FA and remember-me', () => {
    it('a 2FA user → {stage: mfa}, no altis_dev, no last_login_at; auth/me in that session → no permissions (M10)', async () => {
      const t = appAt();
      const sari = await seedStaff(h, { username: 'sari', totp: true, roles: [{ key: 'super_admin' }], now: NOW });
      const v = visitor(t);
      const res = await v.login({ username: 'sari', password: sari.password, remember: true });
      expect(res.status).toBe(200);
      expect(res.json).toEqual({ stage: 'mfa', mustChangePassword: false });
      expect(res.headers.get('x-csrf-token')).toBe(sessionCsrfFor(CONFIG, v.agent.cookies.get(SID)!));
      expect(v.agent.cookies.has(DEV)).toBe(false);
      expect(v.agent.cookies.has(RM)).toBe(false);
      expect(await lastLoginAt(sari.id)).toBeNull();
      expect(await audits('auth.login.success')).toEqual([]);
      expect(await countRows(h.db.selectFrom('remember_tokens'))).toBe(0);
      const sessions = await sessionsOf(sari.id);
      expect(sessions).toHaveLength(1);
      expect(Number(sessions[0]!.mfa_passed)).toBe(0);

      const me = await v.agent.get(ME);
      expect(me.status).toBe(200);
      expect(me.json).toMatchObject({
        authenticated: true,
        stage: 'mfa',
        permissions: [],
        branchPermissions: {},
        superAdmin: false,
        banners: [],
        user: { id: sari.id, totpEnabled: true },
      });
    });

    it('B9: remember: true → the session records the token selector; auth/logout right after → no remember_tokens row left', async () => {
      const t = appAt();
      const budi = await seedStaff(h, { username: 'budi', now: NOW });
      const v = visitor(t);
      const res = await v.login({ username: 'budi', password: budi.password, remember: true });
      expect(res.status).toBe(200);
      const rm = v.agent.cookies.get(RM)!;
      expect(rm).toMatch(/^[A-Za-z0-9_-]{24}\.[A-Za-z0-9_-]{43}$/);
      expect(cookieLine(res, RM)).toMatch(/Max-Age=2592000/);
      const selector = rm.split('.')[0]!;
      const sessions = await sessionsOf(budi.id);
      expect(sessions.map((s) => s.remember_selector)).toEqual([selector]);
      const tokens = await h.db.selectFrom('remember_tokens').select(['selector', 'subject_id', 'mfa_bound']).execute();
      expect(tokens).toHaveLength(1);
      expect(tokens[0]).toMatchObject({ selector, subject_id: budi.id });
      expect(Number(tokens[0]!.mfa_bound)).toBe(0);

      const out = await v.agent.post(LOGOUT, undefined, { 'x-csrf-token': res.headers.get('x-csrf-token')! });
      expect(out.status).toBe(204);
      expect(await h.db.selectFrom('remember_tokens').select('selector').where('subject_id', '=', budi.id).execute()).toEqual([]);
      expect(v.agent.cookies.has(RM)).toBe(false);
    });
  });

  describe('logout', () => {
    it('deletes the session and its remember token, clears altis_sid and altis_rm, writes auth.logout; the old cookie then → 401', async () => {
      const t = appAt();
      const budi = await seedStaff(h, { username: 'budi', now: NOW });
      const v = visitor(t);
      const res = await v.login({ username: 'budi', password: budi.password, remember: true });
      const sid = v.agent.cookies.get(SID)!;

      const out = await v.agent.post(LOGOUT, undefined, { 'x-csrf-token': res.headers.get('x-csrf-token')! });
      expect(out.status).toBe(204);
      expect(cookieLine(out, SID)).toMatch(/Max-Age=0/);
      expect(cookieLine(out, RM)).toMatch(/Max-Age=0/);
      expect(v.agent.cookies.has(SID)).toBe(false);
      // The device stays known.
      expect(v.agent.cookies.has(DEV)).toBe(true);
      expect(await sessionsOf(budi.id)).toEqual([]);
      expect(await countRows(h.db.selectFrom('remember_tokens'))).toBe(0);
      const logout = await audits('auth.logout');
      expect(logout).toHaveLength(1);
      expect(logout[0]).toMatchObject({ actor_type: 'staff', actor_id: budi.id, entity: 'staff_users', entity_id: budi.id });

      const stale = visitor(t);
      stale.agent.setCookie(SID, sid);
      const again = await stale.agent.post(LOGOUT, undefined, { 'x-csrf-token': stale.csrf });
      expect(again.status).toBe(401);
      expect(code(again)).toBe('AUTH_REQUIRED');
    });

    it('a session rotated by this very request (its rights changed) is revoked with the token the browser sent', async () => {
      const t = appAt();
      const budi = await seedStaff(h, { username: 'budi', now: NOW });
      const v = visitor(t);
      const res = await v.login({ username: 'budi', password: budi.password });
      const sid = v.agent.cookies.get(SID)!;
      await h.db.updateTable('staff_users').set({ authz_version: 2 }).where('id', '=', budi.id).execute();

      const out = await v.agent.post(LOGOUT, undefined, { 'x-csrf-token': res.headers.get('x-csrf-token')! });
      expect(out.status).toBe(204);
      // Step 7 rotated the session (a new altis_sid first), then the handler cleared it.
      expect(out.headers.getSetCookie().filter((line) => line.startsWith(`${SID}=`))).toHaveLength(2);
      expect(cookieLine(out, SID)).not.toMatch(/Max-Age=0/);
      expect(v.agent.cookies.has(SID)).toBe(false);
      expect(await sessionsOf(budi.id)).toEqual([]);
      const stale = visitor(t);
      stale.agent.setCookie(SID, sid);
      expect((await stale.agent.post(LOGOUT, undefined, { 'x-csrf-token': stale.csrf })).status).toBe(401);
    });

    it('lineage: a tab that still sends the rotated-away cookie (in its 30 s grace) logs out → the session it was rotated into ends too; another sign-in from the same IP stays', async () => {
      const t = appAt();
      const budi = await seedStaff(h, { username: 'budi', now: NOW });
      t.clock.now = NOW - 1 * SEC;
      const other = visitor(t);
      expect((await other.login({ username: 'budi', password: budi.password })).status).toBe(200);
      t.clock.now = NOW;
      const v = visitor(t);
      const res = await v.login({ username: 'budi', password: budi.password });
      const oldSid = v.agent.cookies.get(SID)!;
      const oldCsrf = res.headers.get('x-csrf-token')!;
      await withTx(h, (trx) => bumpAuthzVersion(trx, [budi.id]));
      t.clock.now = NOW + 5 * SEC;
      expect((await v.agent.get(ME)).json).toMatchObject({ authenticated: true }); // step 7 rotates: a new altis_sid
      expect(v.agent.cookies.get(SID)).not.toBe(oldSid);

      t.clock.now = NOW + 10 * SEC;
      const tab = visitor(t);
      tab.agent.setCookie(SID, oldSid);
      expect((await tab.agent.post(LOGOUT, undefined, { 'x-csrf-token': oldCsrf })).status).toBe(204);
      expect(((await v.agent.get(ME)).json as { authenticated: boolean }).authenticated).toBe(false);
      expect((await sessionsOf(budi.id)).map((s) => s.id)).toEqual([sha256hex(other.agent.cookies.get(SID)!)]);
      expect(((await other.agent.get(ME)).json as { authenticated: boolean }).authenticated).toBe(true);
    });

    it('a pre-2FA session may log out', async () => {
      const t = appAt();
      const sari = await seedStaff(h, { username: 'sari', totp: true, now: NOW });
      const v = visitor(t);
      const res = await v.login({ username: 'sari', password: sari.password });
      expect(res.json).toMatchObject({ stage: 'mfa' });
      const out = await v.agent.post(LOGOUT, undefined, { 'x-csrf-token': res.headers.get('x-csrf-token')! });
      expect(out.status).toBe(204);
      expect(await sessionsOf(sari.id)).toEqual([]);
    });
  });

  describe('auth/me', () => {
    it('anonymous → {authenticated: false, csrfToken, library, build} and altis_csrf; auth/login accepts that token', async () => {
      const t = appAt();
      await withTx(h, (trx) =>
        writeSettings(trx, { 'library.name': 'Perpustakaan SMA Negeri 1', 'library.locale': 'en' }, { now: NOW, actorId: null, keyring: CONFIG.keyring }),
      );
      const budi = await seedStaff(h, { username: 'budi', now: NOW });
      const agent = createAgent(t.app, { peer: IP });

      const me = await agent.get(ME);
      expect(me.status).toBe(200);
      const csrfToken = (me.json as { csrfToken: string }).csrfToken;
      expect(me.json).toEqual({
        authenticated: false,
        csrfToken,
        library: { name: 'Perpustakaan SMA Negeri 1', locale: 'en' },
        build: VERSION,
      });
      expect(cookieLine(me, CSRF)).toMatch(/HttpOnly/);
      expect(me.headers.get('cache-control')).toBe('no-store');
      expect(csrfToken).toBe(preSessionCsrfToken(csrfKey(CONFIG), agent.cookies.get(CSRF)!));
      // A second call keeps the cookie and the token.
      const second = await agent.get(ME);
      expect(cookieLine(second, CSRF)).toBeUndefined();
      expect((second.json as { csrfToken: string }).csrfToken).toBe(csrfToken);

      expect(code(await agent.post(LOGIN, { username: 'budi', password: budi.password }))).toBe('CSRF_INVALID');
      const ok = await agent.post(LOGIN, { username: 'budi', password: budi.password }, { 'x-csrf-token': csrfToken });
      expect(ok.status).toBe(200);
    });

    it('authenticated admin → the admin permission set, superAdmin false, the release version as build, banners []', async () => {
      const t = appAt();
      const admin = await seedStaff(h, { username: 'admin', roles: [{ key: 'admin' }], now: NOW });
      const v = visitor(t);
      const res = await v.login({ username: 'admin', password: admin.password });
      const me = await v.agent.get(ME);
      expect(me.status).toBe(200);
      expect(me.json).toEqual({
        authenticated: true,
        csrfToken: res.headers.get('x-csrf-token'),
        stage: 'full',
        mustChangePassword: false,
        user: { id: admin.id, username: 'admin', name: 'admin', email: null, locale: null, totpEnabled: false, mfaRequired: false },
        permissions: [...systemRolePermissions('admin')],
        branchPermissions: {},
        superAdmin: false,
        reauthUntil: null,
        library: { name: 'Perpustakaan', locale: 'id' },
        build: VERSION,
        banners: [],
        // 1c Task 16: no browser test yet, and SSE is on by default on this (standalone) runtime, whose jobs an
        // in-process worker runs (1d: `runner`).
        client: { realtime: 'sse', methodOverride: false, chunkBytes: 5 * 1024 * 1024, probedAt: null, runner: 'worker' },
      });
    });

    it('reauthUntil is reauth_at + 300 s; branch permissions by branch', async () => {
      const t = appAt();
      const branchId = newId();
      const branchCode = branchId.slice(-10);
      await h.db
        .insertInto('branches')
        .values({ id: branchId, code_key: branchCode, code_display: branchCode, name: 'Pusat', timezone: 'Asia/Jakarta', created_at: NOW, updated_at: NOW })
        .execute();
      const user = await seedStaff(h, {
        username: 'rina',
        now: NOW,
        roles: [{ permissions: ['system.audit.read'] }, { permissions: ['test.branch.manage'], branchId }],
      });
      const v = visitor(t);
      const res = await v.login({ username: 'rina', password: user.password });
      expect(res.json).toEqual({ stage: 'full', mustChangePassword: false });
      const sid = v.agent.cookies.get(SID)!;
      await h.db.updateTable('sessions').set({ reauth_at: NOW - 60 * SEC }).where('id', '=', sha256hex(sid)).execute();
      const me = await v.agent.get(ME);
      expect(me.json).toMatchObject({
        permissions: ['system.audit.read'],
        branchPermissions: { [branchId]: ['test.branch.manage'] },
        reauthUntil: NOW - 60 * SEC + 300 * SEC,
        user: { mfaRequired: false },
      });
    });

    it('a role that requires 2FA, not enrolled → stage mfa_setup; auth/me says mfaRequired', async () => {
      const t = appAt();
      const user = await seedStaff(h, { username: 'dewi', now: NOW, roles: [{ permissions: ['system.audit.read'], mfaRequired: true }] });
      const v = visitor(t);
      const res = await v.login({ username: 'dewi', password: user.password });
      expect(res.json).toEqual({ stage: 'mfa_setup', mustChangePassword: false });
      const me = await v.agent.get(ME);
      expect(me.json).toMatchObject({ authenticated: true, stage: 'mfa_setup', permissions: [], user: { mfaRequired: true, totpEnabled: false } });
    });

    it('a registered banner provider shows up in banners', async () => {
      const t = appAt();
      const budi = await seedStaff(h, { username: 'budi', now: NOW });
      const seen: unknown[] = [];
      BANNER_PROVIDERS.push(
        async (c) => {
          seen.push({ subjectId: c.auth.subjectId, now: c.now, db: c.db === h });
          return { kind: 'maintenance', severity: 'warning', messageKey: 'banner.maintenance' };
        },
        async () => null,
      );
      const v = visitor(t);
      await v.login({ username: 'budi', password: budi.password });
      const me = await v.agent.get(ME);
      expect((me.json as { banners: unknown }).banners).toEqual([{ kind: 'maintenance', severity: 'warning', messageKey: 'banner.maintenance' }]);
      expect(seen).toEqual([{ subjectId: budi.id, now: NOW, db: true }]);
      // Anonymous: no banners at all.
      expect(await visitor(t).agent.get(ME).then((r) => (r.json as { authenticated: boolean }).authenticated)).toBe(false);
      expect(seen).toHaveLength(1);
    });
  });
});
