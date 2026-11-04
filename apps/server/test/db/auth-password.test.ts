import fsp from 'node:fs/promises';
import os from 'node:os';
import path from 'node:path';
import { performance } from 'node:perf_hooks';
import {
  createJobRegistry,
  createPasswordHasher,
  createSettingsCache,
  createSmtpMailer,
  hotp,
  loadSmtpConfig,
  randomToken,
  sha256hex,
  totpStep,
  writeSettings,
  type Mailer,
  type PasswordHasher,
  type SettingKey,
} from '@altis/core';
import { PHASE1_MIGRATIONS, countRows, runMigrations, withTx, type DbHandle } from '@altis/db';
import { newId, normalizeKey } from '@altis/shared';
import { afterAll, afterEach, beforeAll, beforeEach, describe, expect, it, vi } from 'vitest';
import { bodyOf, headerOf, startFakeSmtp, startSilentServer } from '../../../../packages/core/test/fake-smtp.js';
import { MAILPIT_SMTP, mailpit, mailpitMode } from '../../../../packages/core/test/mailpit.js';
import { engineLabel, testDb, testDbContext, type TestDbHandle } from '../../../../tools/test/test-db.js';
import { createApp, type AppState } from '../../src/app.js';
import { csrfKey, preSessionCsrfToken } from '../../src/http/csrf.js';
import { createJobRuntime, jobHandlers, type JobRuntime } from '../../src/jobs/runtime.js';
import { createAppOps, jobMailer } from '../../src/services.js';
import { createAgent, type Agent, type AgentReply } from '../agent.js';
import { recordingLogger, sampleConfig, type RecordedLine } from '../support.js';
import { TEST_KEYRING, seedStaff, type SeededStaff } from '../support-auth.js';

// The self-service account API of Task 18 on the engine picked by ALTIS_TEST_DB (spec §7.1 "Reset sandi",
// "Pencabutan"; §13.5 "Profil saya"): changing one's own password (`auth/password/change`: the current session is the
// one that stays), the password reset by mail (`auth/password/forgot` always answers 202; `auth/password/reset` with
// the token of the mail), the profile (`PATCH auth/me`) and one's own sessions (`GET/DELETE auth/sessions`).
//
// Mail goes through the library's SMTP settings (written with Task 8's writeSettings) to mailpit when the run asks for
// it (ALTIS_TEST_MAILPIT_REQUIRED=1 in CI, ALTIS_TEST_MAILPIT=1 for a developer who started it), and otherwise to the
// in-process SMTP server of packages/core/test/fake-smtp.ts, so that no case is skipped without Docker. Review Focus 4
// (a mail server that accepts and never greets) always uses a silent TCP server of its own.

const ctx = testDbContext();
let h: TestDbHandle;

const SEC = 1000;
const MIN = 60 * SEC;
/** 09:00:05 UTC: 5 s into every window (no case crosses one unless it moves the clock); in the past (audit dates). */
const NOW = Date.UTC(2026, 9, 20, 9, 0, 5);
/** The app opens the secrets sealed with TEST_KEYRING (the SMTP password, TOTP secrets). */
const CONFIG = sampleConfig({ keyring: TEST_KEYRING.map((entry) => ({ ...entry })) });

const AUTH = '/api/v1/auth';
const LOGIN = `${AUTH}/login`;
const ME = `${AUTH}/me`;
const CHANGE = `${AUTH}/password/change`;
const FORGOT = `${AUTH}/password/forgot`;
const RESET = `${AUTH}/password/reset`;
const SESSIONS = `${AUTH}/sessions`;
const BRANCHES = '/api/v1/branches';
const IP = '203.0.113.9';
/** baseUrl is https: every auth cookie carries the `__Host-` prefix. */
const SID = '__Host-altis_sid';
const RM = '__Host-altis_rm';
const CSRF = '__Host-altis_csrf';
const RESET_LINK = /https:\/\/perpus\.sekolah\.sch\.id\/admin\/reset-password#token=([A-Za-z0-9_-]{43})/;
const SMTP_PASSWORD = 'smtp-S3cret-pw-Rahasia';

// ---------------------------------------------------------------------------------------------------------------
// Mail

interface ReceivedMail {
  subject: string;
  text: string;
}

/** Where the app's mail ends up: its SMTP address, and what arrived there for one recipient. */
interface MailSink {
  smtp: { host: string; port: number };
  /** The messages to `to` received so far, oldest first. */
  to(to: string): Promise<ReceivedMail[]>;
  close(): Promise<void>;
}

/** The plain text of a message as the in-process server received it (7bit, quoted-printable or base64), LF line ends. */
function textOf(data: string): string {
  const encoding = (headerOf(data, 'Content-Transfer-Encoding') ?? '').toLowerCase();
  const text =
    encoding === 'base64'
      ? Buffer.from(data.slice(data.indexOf('\r\n\r\n') + 4).replace(/\s+/g, ''), 'base64').toString('utf8')
      : bodyOf(data);
  return text.replace(/\r\n/g, '\n');
}

/** mailpit when the run asks for it (and, unless required, answers); the in-process SMTP server otherwise. */
async function openSink(): Promise<MailSink> {
  const mode = mailpitMode();
  if (mode !== 'off') {
    const mp = mailpit();
    const up = await mp.available();
    if (!up && mode === 'required') throw new Error('mailpit does not answer, and ALTIS_TEST_MAILPIT_REQUIRED=1 requires it');
    if (up) {
      return {
        smtp: { ...MAILPIT_SMTP },
        to: async (to) =>
          (await mp.messages()).filter((m) => m.to.includes(to)).map((m) => ({ subject: m.subject, text: m.text.replace(/\r\n/g, '\n') })),
        close: async () => undefined,
      };
    }
  }
  const fake = await startFakeSmtp();
  return {
    smtp: { host: '127.0.0.1', port: fake.port },
    to: async (to) =>
      fake.messages.filter((m) => m.to.includes(to)).map((m) => ({ subject: headerOf(m.data, 'Subject') ?? '', text: textOf(m.data) })),
    close: () => fake.close(),
  };
}

let sink: MailSink;

/** Waits until `fn` returns something other than undefined (every 20 ms, at most `ms`). */
async function until<T>(fn: () => Promise<T | undefined> | T | undefined, ms = 8000, what = 'the condition'): Promise<T> {
  const end = Date.now() + ms;
  for (;;) {
    const value = await fn();
    if (value !== undefined) return value;
    if (Date.now() > end) throw new Error(`timed out waiting for ${what}`);
    await new Promise((resolve) => setTimeout(resolve, 20));
  }
}

/** The one mail to `to` (waits for it), and the reset token its link carries. */
async function resetMailTo(to: string): Promise<{ mail: ReceivedMail; token: string }> {
  const mails = await until(async () => {
    const got = await sink.to(to);
    return got.length > 0 ? got : undefined;
  }, 8000, `a mail to ${to}`);
  expect(mails).toHaveLength(1);
  const mail = mails[0]!;
  const token = RESET_LINK.exec(mail.text)?.[1];
  expect(token, mail.text).toBeDefined();
  return { mail, token: token! };
}

/** Lets every afterResponse hook of the requests made so far run, then a little more. */
const settle = (): Promise<void> => new Promise((resolve) => setTimeout(resolve, 250));

/** A unique address of the test domain (mailpit is shared between runs). */
const address = (name: string): string => `${name}.${newId().toLowerCase()}@perpus.test`;

async function settings(patch: Partial<Record<SettingKey, unknown>>): Promise<void> {
  await withTx(h, (trx) => writeSettings(trx, patch, { keyring: TEST_KEYRING, now: NOW, actorId: null }));
}

// ---------------------------------------------------------------------------------------------------------------
// The app and its browsers

interface AppOptions {
  /** The mail of the app's job handlers and services (default: the library's SMTP, as start() builds it). */
  mailer?: Mailer;
  hasher?: PasswordHasher;
  /** The test database as the app sees it (default: as it is). */
  db?: DbHandle;
  /**
   * The process's job runtime (1c Task 18: the reset mail is a job): `external` (default) a passenger process, which
   * drives the mail job after the answer; `none` no runtime yet (the job waits for a runner); or the one given.
   */
  jobs?: 'external' | 'none' | JobRuntime;
}

/** The job runtimes appAt made: each case stops its own. */
const runtimes: JobRuntime[] = [];
/** DATA_DIR of the job runtimes (the runner reads the maintenance flag there). */
let jobsDir: string;

/** The handlers of the app's job runtime, with `mailer`. */
const handlersWith = (mailer: Mailer) =>
  jobHandlers({
    housekeeping: { dataDir: jobsDir, mailer, baseUrl: () => CONFIG.baseUrl, settings: createSettingsCache({ ttlMs: 0 }) },
  });

/** The app on the test database with a fake clock at NOW, a recording logger and ALL_ROUTES. */
function appAt(o: AppOptions = {}) {
  const clock = { now: NOW };
  const log = recordingLogger();
  const state: AppState = { phase: 'ready', db: o.db ?? h, config: CONFIG };
  const mailer = o.mailer ?? jobMailer(state);
  if (o.jobs === undefined || o.jobs === 'external') {
    const runtime = createJobRuntime({
      state,
      runtime: 'passenger',
      env: {},
      dataDir: jobsDir,
      log,
      clock: () => clock.now,
      ops: createAppOps(state, { dataDir: jobsDir, version: '1.4.2', log, clock: () => clock.now }),
      handlers: handlersWith(mailer),
      requestRestart: async () => {},
      installId: CONFIG.install.id,
      appVersion: '1.4.2',
    });
    runtimes.push(runtime);
    state.jobs = runtime;
  } else if (o.jobs !== 'none') {
    state.jobs = o.jobs;
  }
  const app = createApp({
    state,
    version: '1.4.2',
    buildId: 'build-x',
    log,
    clock: () => clock.now,
    services: {
      ...(o.mailer === undefined ? {} : { mailer: o.mailer }),
      ...(o.hasher === undefined ? {} : { hasher: o.hasher }),
    },
  });
  return { app, clock, log };
}

type TestApp = ReturnType<typeof appAt>;

type KyselyPlugin = Parameters<TestDbHandle['db']['withPlugin']>[0];

/** The test database seen through a plugin that fails every INSERT INTO password_resets (as a database breaking then). */
function failingResetInserts(): DbHandle {
  const plugin: KyselyPlugin = {
    transformQuery({ node }) {
      if (node.kind === 'InsertQueryNode' && JSON.stringify(node).includes('"name":"password_resets"')) {
        throw new Error('the injected statement failure');
      }
      return node;
    },
    transformResult: async ({ result }) => result,
  };
  return { ...h, db: h.db.withPlugin(plugin) };
}

/** A browser: its CSRF token, the pre-session one (D20) until its session's replaces it (S9). */
interface Browser {
  agent: Agent;
  csrf: string;
}

function browser(t: TestApp): Browser {
  const agent = createAgent(t.app, { peer: IP });
  const value = randomToken(32);
  agent.setCookie(CSRF, value);
  return { agent, csrf: preSessionCsrfToken(csrfKey(CONFIG), value) };
}

/** A write with the browser's current CSRF token; a new `X-CSRF-Token` in the answer replaces it. */
async function send(b: Browser, method: 'post' | 'patch' | 'delete', p: string, body?: unknown): Promise<AgentReply> {
  const res = await b.agent[method](p, body, { 'x-csrf-token': b.csrf });
  const next = res.headers.get('x-csrf-token');
  if (next !== null) b.csrf = next;
  return res;
}

/** GET auth/me; its `csrfToken` becomes the browser's token (as the SPA does). */
async function me(b: Browser): Promise<AgentReply> {
  const res = await b.agent.get(ME);
  const token = (res.json as { csrfToken?: string } | undefined)?.csrfToken;
  if (token !== undefined) b.csrf = token;
  return res;
}

const authenticated = (res: AgentReply): boolean => (res.json as { authenticated?: boolean }).authenticated === true;

type Staff = SeededStaff & { username: string; email: string };

/** A staff user (seedStaff) with an e-mail address, and optionally a name and a locale. */
async function staff(o: Parameters<typeof seedStaff>[1] & { email?: string; name?: string; locale?: string | null }): Promise<Staff> {
  const { email = address(o.username), name, locale, ...seed } = o;
  const seeded = await seedStaff(h, { now: NOW, ...seed });
  await h.db
    .updateTable('staff_users')
    .set({ email_key: normalizeKey(email), email_display: email, ...(name === undefined ? {} : { name }), ...(locale === undefined ? {} : { locale }) })
    .where('id', '=', seeded.id)
    .execute();
  return { ...seeded, username: o.username, email };
}

/** A new browser signed in with the password; the login answered 200 with `stage`. */
async function signIn(t: TestApp, user: { username: string; password: string }, o: { remember?: boolean; stage?: string } = {}): Promise<Browser> {
  const b = browser(t);
  const res = await send(b, 'post', LOGIN, { username: user.username, password: user.password, ...(o.remember === true ? { remember: true } : {}) });
  expect(res.status, JSON.stringify(res.json)).toBe(200);
  expect(res.json).toMatchObject({ stage: o.stage ?? 'full' });
  return b;
}

/** The status of a login attempt with `password` from a new browser. */
async function loginStatus(t: TestApp, user: Staff, password: string): Promise<number> {
  return (await send(browser(t), 'post', LOGIN, { username: user.username, password })).status;
}

const code = (res: AgentReply): string | undefined => (res.json as { code?: string } | undefined)?.code;
const cookieLine = (res: AgentReply, name: string): string | undefined =>
  res.headers.getSetCookie().find((line) => line.startsWith(`${name}=`));

function expectError(res: AgentReply, status: number, errorCode: string): void {
  expect({ status: res.status, code: code(res) }).toEqual({ status, code: errorCode });
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

/** The counts of the rate-limit rows of `label` (`<bucket>:<subject>`), one per window. */
async function limit(label: string): Promise<number[]> {
  const rows = await h.db.selectFrom('rate_limits').select('count').where('bucket_name', '=', label).orderBy('window_start').execute();
  return rows.map((r) => Number(r.count));
}

const sessionIds = async (userId: string): Promise<string[]> =>
  (await h.db.selectFrom('sessions').select('id').where('subject_id', '=', userId).orderBy('id').execute()).map((r) => r.id);
const tokenCount = (userId: string): Promise<number> => countRows(h.db.selectFrom('remember_tokens').where('subject_id', '=', userId));
const resetRows = async (userId: string) =>
  (
    await h.db
      .selectFrom('password_resets')
      .select(['token_hash', 'subject_type', 'expires_at', 'used_at'])
      .where('subject_id', '=', userId)
      .orderBy('token_hash')
      .execute()
  ).map((r) => ({ ...r, expires_at: Number(r.expires_at), used_at: r.used_at === null ? null : Number(r.used_at) }));
/** 1c Task 18: the `mail.password_reset` jobs, oldest first, with their payload parsed. */
const mailJobs = async () =>
  (
    await h.db
      .selectFrom('jobs')
      .select(['status', 'payload', 'secret_param', 'last_error', 'attempts'])
      .where('type', '=', 'mail.password_reset')
      .orderBy('id')
      .execute()
  ).map((j) => ({ ...j, payload: JSON.parse(j.payload) as unknown }));
const accountOf = (id: string) =>
  h.db
    .selectFrom('staff_users')
    .select(['password_hash', 'status', 'must_change_password', 'name', 'locale', 'version'])
    .where('id', '=', id)
    .executeTakeFirstOrThrow();
const sidOf = (b: Browser): string => b.agent.cookies.get(SID)!;

/** A password_resets row of `userId` written straight into the table (an earlier request). */
async function seedResetRow(userId: string): Promise<string> {
  const tokenHash = sha256hex(randomToken(32));
  await h.db
    .insertInto('password_resets')
    .values({ token_hash: tokenHash, subject_type: 'staff', subject_id: userId, expires_at: NOW + 30 * MIN, used_at: null })
    .execute();
  return tokenHash;
}

/**
 * The real hasher, whose next verify() can be held after it computed its answer: `pauseNextVerify()` resolves
 * `inVerify` once that call is held (a login that verified the password, outside any transaction) and lets it return
 * at `release()`.
 */
function pausingHasher() {
  const real = createPasswordHasher();
  let held: { entered: () => void; released: Promise<void> } | null = null;
  const hasher: PasswordHasher = {
    hash: (pw) => real.hash(pw),
    verifyDummy: (pw) => real.verifyDummy(pw),
    needsRehash: (phc) => real.needsRehash(phc),
    verify: async (pw, phc) => {
      const ok = await real.verify(pw, phc);
      const hold = held;
      held = null;
      if (hold !== null) {
        hold.entered();
        await hold.released;
      }
      return ok;
    },
  };
  return {
    hasher,
    pauseNextVerify() {
      let entered!: () => void;
      let release!: () => void;
      const inVerify = new Promise<void>((resolve) => (entered = resolve));
      held = { entered, released: new Promise<void>((resolve) => (release = resolve)) };
      return { inVerify, release };
    },
  };
}

const NEW_PASSWORD = 'kuda-lumping-berlari-7';

describe.skipIf(!ctx.available)(`auth API: password change and reset, profile, own sessions [${engineLabel()}]`, () => {
  let dataDir: string;

  beforeAll(async () => {
    h = await testDb();
    dataDir = await fsp.mkdtemp(path.join(os.tmpdir(), 'altis-auth-password-'));
    await runMigrations(h, { appVersion: '0.1.0', dataDir, migrations: PHASE1_MIGRATIONS });
    jobsDir = await fsp.realpath(await fsp.mkdtemp(path.join(os.tmpdir(), 'altis-auth-password-jobs-')));
    sink = await openSink();
  });

  afterEach(async () => {
    // The drain: no slice of a case outlives it.
    await Promise.all(runtimes.splice(0).map((runtime) => runtime.stop()));
  });

  afterAll(async () => {
    await sink?.close();
    await h?.close();
    if (dataDir !== undefined) await fsp.rm(dataDir, { recursive: true, force: true });
    if (jobsDir !== undefined) await fsp.rm(jobsDir, { recursive: true, force: true });
  });

  beforeEach(async () => {
    await h.db.deleteFrom('jobs').execute();
    await h.db.deleteFrom('sessions').execute();
    await h.db.deleteFrom('remember_tokens').execute();
    await h.db.deleteFrom('password_resets').execute();
    await h.db.deleteFrom('rate_limits').execute();
    await h.db.deleteFrom('settings').execute();
    await h.db.deleteFrom('staff_users').execute(); // user_roles and recovery codes cascade
    await h.db.deleteFrom('audit_log').execute();
    await h.db.updateTable('audit_head').set({ last_seq: 0, last_hash: '0'.repeat(64) }).where('id', '=', 1).execute();
    // The library's SMTP (Task 8 settings): the sink, plain SMTP, no login.
    await settings({ 'smtp.host': sink.smtp.host, 'smtp.port': sink.smtp.port, 'smtp.security': 'none', 'smtp.from': 'noreply@perpus.test' });
  });

  describe('change', () => {
    it('a wrong current password → 401, audited as auth.login.failed {stage: reauth}, counted in reauth:session; nothing changes', async () => {
      const t = appAt();
      const budi = await staff({ username: 'budi' });
      const b = await signIn(t, budi);
      const before = await accountOf(budi.id);

      expectError(await send(b, 'post', CHANGE, { current: 'not-the-password', next: NEW_PASSWORD }), 401, 'AUTH_INVALID_CREDENTIALS');
      expect((await accountOf(budi.id)).password_hash).toBe(before.password_hash);
      expect(await audits('auth.login.failed')).toEqual([
        { actor_type: 'staff', actor_id: budi.id, entity: 'staff_users', entity_id: budi.id, ip: IP, meta: { stage: 'reauth' } },
      ]);
      expect(await audits('auth.password.change')).toEqual([]);
      expect(await limit(`reauth:session:${sha256hex(sidOf(b))}`)).toEqual([1]);
      expect(authenticated(await me(b))).toBe(true);
    });

    it('next = 1234567890 → 422 PASSWORD_TOO_WEAK (common), before anything is counted or verified', async () => {
      const t = appAt();
      const budi = await staff({ username: 'budi' });
      const b = await signIn(t, budi);
      const res = await send(b, 'post', CHANGE, { current: budi.password, next: '1234567890' });
      expectError(res, 422, 'PASSWORD_TOO_WEAK');
      expect((res.json as { reason?: string }).reason).toBe('common');
      expect(await limit(`reauth:session:${sha256hex(sidOf(b))}`)).toEqual([]);
      expect(await audits('auth.login.failed')).toEqual([]);
    });

    it('with security.password_min_length = 12, 11 characters → 422 too_short; 12 → 200', async () => {
      await settings({ 'security.password_min_length': 12 });
      const t = appAt();
      const budi = await staff({ username: 'budi' });
      const b = await signIn(t, budi);
      const short = await send(b, 'post', CHANGE, { current: budi.password, next: 'gajah-terb7' });
      expectError(short, 422, 'PASSWORD_TOO_WEAK');
      expect((short.json as { reason?: string }).reason).toBe('too_short');
      expect((await send(b, 'post', CHANGE, { current: budi.password, next: 'gajah-terb7!' })).status).toBe(200);
    });

    it('success → the current session kept, every other session and every remember-me token gone, the reset rows deleted, auth.password.change', async () => {
      const t = appAt();
      const budi = await staff({ username: 'budi' });
      const ani = await staff({ username: 'ani' });
      const other = await signIn(t, budi, { remember: true });
      const third = await signIn(t, budi);
      const b = await signIn(t, budi, { remember: true });
      const aniBrowser = await signIn(t, ani);
      await seedResetRow(budi.id);
      await seedResetRow(ani.id);
      expect(await tokenCount(budi.id)).toBe(2);
      const before = await accountOf(budi.id);

      const res = await send(b, 'post', CHANGE, { current: budi.password, next: NEW_PASSWORD });
      expect(res.status).toBe(200);
      // The current session stays signed in, without remember-me: its token went with the others.
      expect(cookieLine(res, SID)).toBeUndefined();
      expect(cookieLine(res, RM)).toMatch(/Max-Age=0/);
      expect(await sessionIds(budi.id)).toEqual([sha256hex(sidOf(b))]);
      expect(await tokenCount(budi.id)).toBe(0);
      expect(await h.db.selectFrom('sessions').select('remember_selector').where('id', '=', sha256hex(sidOf(b))).executeTakeFirst()).toEqual({
        remember_selector: null,
      });
      expect(await resetRows(budi.id)).toEqual([]);
      expect(await resetRows(ani.id)).toHaveLength(1); // another user's rows stay
      const after = await accountOf(budi.id);
      expect(after.password_hash).not.toBe(before.password_hash);
      expect(Number(after.version)).toBe(Number(before.version) + 1);
      expect(await audits('auth.password.change')).toEqual([
        { actor_type: 'staff', actor_id: budi.id, entity: 'staff_users', entity_id: budi.id, ip: IP, meta: {} },
      ]);
      // A right password was no guess: the hit went back.
      expect(await limit(`reauth:session:${sha256hex(sidOf(b))}`)).toEqual([0]);

      expect(authenticated(await me(b))).toBe(true);
      expect(authenticated(await me(other))).toBe(false);
      expect(authenticated(await me(third))).toBe(false);
      expect(authenticated(await me(aniBrowser))).toBe(true);
      expect(await loginStatus(t, budi, budi.password)).toBe(401);
      expect(await loginStatus(t, budi, NEW_PASSWORD)).toBe(200);
    });

    it('with must_change_password = 1 the other routes answer 403, and the change is allowed and clears it', async () => {
      const t = appAt();
      const budi = await staff({ username: 'budi', mustChangePassword: true });
      const b = browser(t);
      const login = await send(b, 'post', LOGIN, { username: budi.username, password: budi.password });
      expect(login.json).toEqual({ stage: 'full', mustChangePassword: true });
      expectError(await b.agent.get(BRANCHES), 403, 'AUTH_PASSWORD_CHANGE_REQUIRED');
      expectError(await send(b, 'patch', ME, { locale: 'en' }), 403, 'AUTH_PASSWORD_CHANGE_REQUIRED');

      expect((await send(b, 'post', CHANGE, { current: budi.password, next: NEW_PASSWORD })).status).toBe(200);
      expect(Number((await accountOf(budi.id)).must_change_password)).toBe(0);
      expect((await me(b)).json).toMatchObject({ authenticated: true, mustChangePassword: false });
      expect((await b.agent.get(BRANCHES)).status).toBe(200);
    });

    it('from a token rotated away and still in its 30 s grace: the session it was rotated into stays too (the browser holds it); the other sign-in goes', async () => {
      const t = appAt();
      const budi = await staff({ username: 'budi' });
      const other = await signIn(t, budi);
      t.clock.now = NOW + 1 * SEC; // another sign-in from this IP, not the same one (revokeSessionLineage's rule)
      const b = await signIn(t, budi, { remember: true });
      const oldSid = sidOf(b);
      const oldCsrf = b.csrf;
      // The rights change: the browser's next /api request rotates its session (R1b-1); the old token keeps working 30 s.
      await h.db.updateTable('staff_users').set((eb) => ({ authz_version: eb('authz_version', '+', 1) })).where('id', '=', budi.id).execute();
      t.clock.now = NOW + 5 * SEC;
      expect(authenticated(await me(b))).toBe(true);
      const newSid = sidOf(b);
      expect(newSid).not.toBe(oldSid);

      // Another tab of the browser, whose request left before the rotation answered, changes the password.
      t.clock.now = NOW + 10 * SEC;
      const tab: Browser = { agent: createAgent(t.app, { peer: IP }), csrf: oldCsrf };
      tab.agent.setCookie(SID, oldSid);
      const res = await send(tab, 'post', CHANGE, { current: budi.password, next: NEW_PASSWORD });
      expect(res.status).toBe(200);
      expect(await sessionIds(budi.id)).toEqual([sha256hex(oldSid), sha256hex(newSid)].sort());
      expect(await tokenCount(budi.id)).toBe(0);
      expect(authenticated(await me(b))).toBe(true);
      expect(authenticated(await me(other))).toBe(false);
      expect(await audits('auth.password.change')).toHaveLength(1);
      // The old token ends with its grace; the browser's goes on.
      t.clock.now = NOW + 5 * SEC + 30 * SEC;
      expect(authenticated(await me(tab))).toBe(false);
      expect(authenticated(await me(b))).toBe(true);
    });

    it('a login that verified the old password while the change committed gets no session', async () => {
      const paused = pausingHasher();
      const t = appAt({ hasher: paused.hasher });
      const budi = await staff({ username: 'budi' });
      const b = await signIn(t, budi);
      const hold = paused.pauseNextVerify();
      const late = send(browser(t), 'post', LOGIN, { username: budi.username, password: budi.password });
      await hold.inVerify;
      expect((await send(b, 'post', CHANGE, { current: budi.password, next: NEW_PASSWORD })).status).toBe(200);
      hold.release();
      // The login's session transaction locks the row and reads the hash again: no longer the one it verified.
      expectError(await late, 401, 'AUTH_INVALID_CREDENTIALS');
      expect(await sessionIds(budi.id)).toEqual([sha256hex(sidOf(b))]);
    });

    it('a pre-2FA session cannot change the password (401 AUTH_MFA_REQUIRED)', async () => {
      const t = appAt();
      const budi = await staff({ username: 'budi', totp: true });
      const b = await signIn(t, budi, { stage: 'mfa' });
      expectError(await send(b, 'post', CHANGE, { current: budi.password, next: NEW_PASSWORD }), 401, 'AUTH_MFA_REQUIRED');
    });
  });

  describe('forgot', () => {
    it('an active user → 202 {accepted: true} and one mail to their address with the reset link; a reset row that lasts 30 min', async () => {
      const t = appAt();
      const budi = await staff({ username: 'budi', name: 'Budi Santoso' });
      const res = await send(browser(t), 'post', FORGOT, { email: budi.email });
      expect(res.status).toBe(202);
      expect(res.json).toEqual({ accepted: true });

      const { mail, token } = await resetMailTo(budi.email);
      // The library's language (no user locale): Indonesian, from the catalog.
      expect(mail.subject).toBe('Atur ulang kata sandi Anda di Perpustakaan');
      expect(mail.text).toContain('/admin/reset-password#token=');
      expect(mail.text).toContain('Halo Budi Santoso,');
      expect(mail.text).toContain('"budi"');
      expect(mail.text).toContain('30 menit');
      expect(await resetRows(budi.id)).toEqual([
        { token_hash: sha256hex(token), subject_type: 'staff', expires_at: NOW + 30 * MIN, used_at: null },
      ]);
      // No audit: the route writes none (catalog), and nothing tells the requester whether the account exists.
      expect(await countRows(h.db.selectFrom('audit_log'))).toBe(0);
    });

    it("the user's own locale, with the library's template override for it; the address is matched on its normalized key", async () => {
      await settings({
        'email.template.password_reset.en.subject': 'Password for {username} at {library}',
        'email.template.password_reset.en.body': 'Hi {name}, open {link} within {minutes} minutes.',
        'library.name': 'Perpus Pelita',
      });
      const t = appAt();
      const ani = await staff({ username: 'ani', name: 'Ani', locale: 'en' });
      const res = await send(browser(t), 'post', FORGOT, { email: ani.email.toUpperCase() });
      expect(res.status).toBe(202);
      const { mail, token } = await resetMailTo(ani.email);
      expect(mail.subject).toBe('Password for ani at Perpus Pelita');
      expect(mail.text.trim()).toBe(`Hi Ani, open https://perpus.sekolah.sch.id/admin/reset-password#token=${token} within 30 minutes.`);
    });

    it('an unknown email → 202 and no mail; a disabled user → 202 and no mail', async () => {
      const t = appAt();
      const unknown = address('nobody');
      const dina = await staff({ username: 'dina', status: 'disabled' });
      for (const email of [unknown, dina.email]) {
        const res = await send(browser(t), 'post', FORGOT, { email });
        expect(res.status).toBe(202);
        expect(res.json).toEqual({ accepted: true });
      }
      await settle();
      expect(await sink.to(unknown)).toEqual([]);
      expect(await sink.to(dina.email)).toEqual([]);
      expect(await countRows(h.db.selectFrom('password_resets'))).toBe(0);
    });

    it('a second request for the same email within 5 min → 429 with Retry-After (the same for an unknown one)', async () => {
      const t = appAt();
      const budi = await staff({ username: 'budi' });
      expect((await send(browser(t), 'post', FORGOT, { email: budi.email })).status).toBe(202);
      await resetMailTo(budi.email);
      t.clock.now = NOW + 4 * MIN;
      const again = await send(browser(t), 'post', FORGOT, { email: budi.email.toUpperCase() });
      expectError(again, 429, 'AUTH_TOO_MANY_ATTEMPTS');
      expect(Number(again.headers.get('retry-after'))).toBeGreaterThan(0);
      expect(await resetRows(budi.id)).toHaveLength(1);

      const unknown = address('nobody');
      expect((await send(browser(t), 'post', FORGOT, { email: unknown })).status).toBe(202);
      expectError(await send(browser(t), 'post', FORGOT, { email: unknown }), 429, 'AUTH_TOO_MANY_ATTEMPTS');
      expect(await limit(`forgot:email:5m:${normalizeKey(unknown)}`)).toEqual([2]);
      expect(await limit(`forgot:email:1d:${normalizeKey(unknown)}`)).toEqual([2]);
    });

    it('11 requests from one IP within an hour → the 11th 429 (forgot:ip)', async () => {
      const t = appAt();
      for (let i = 0; i < 10; i += 1) {
        t.clock.now = NOW + i * MIN;
        expect((await send(browser(t), 'post', FORGOT, { email: address(`x${i}`) })).status).toBe(202);
      }
      t.clock.now = NOW + 10 * MIN;
      const res = await send(browser(t), 'post', FORGOT, { email: address('x10') });
      expectError(res, 429, 'AUTH_TOO_MANY_ATTEMPTS');
      expect(res.headers.get('retry-after')).not.toBeNull();
    });

    it('the reset starts after the response: when its INSERT fails the answer is still 202 (counted first), and the failure is logged as mail failed {stage: start}', async () => {
      const t = appAt({ db: failingResetInserts() });
      const budi = await staff({ username: 'budi' });
      const res = await send(browser(t), 'post', FORGOT, { email: budi.email });
      expect(res.status).toBe(202);
      expect(res.json).toEqual({ accepted: true });
      expect(await limit(`forgot:email:5m:${normalizeKey(budi.email)}`)).toEqual([1]);

      const failed = await until(() => t.log.lines.find((line) => line.msg === 'mail failed'), 5000, 'the failure in the log');
      expect(failed.fields).toMatchObject({ stage: 'start', code: 'Error' });
      await settle();
      expect(await resetRows(budi.id)).toEqual([]);
      expect(await sink.to(budi.email)).toEqual([]);
      expect(JSON.stringify(t.log.lines)).not.toContain(budi.email);
      expect(await mailJobs()).toEqual([]);
    });

    // 1c Task 18 (decision C28): the mail goes through the job queue.
    it('1c: one mail.password_reset job, only for the existing user: {userId, locale} as its payload, the token only in secret_param', async () => {
      const t = appAt({ jobs: 'none' });
      const budi = await staff({ username: 'budi' });
      for (const email of [budi.email, address('nobody')]) {
        expect((await send(browser(t), 'post', FORGOT, { email })).status).toBe(202);
      }
      await settle();
      const jobs = await mailJobs();
      expect(jobs).toEqual([{ status: 'queued', payload: { userId: budi.id, locale: null }, secret_param: expect.any(String), last_error: null, attempts: 0 }]);
      // Nothing ran it (no runtime yet): no mail until a runner does.
      expect(await sink.to(budi.email)).toEqual([]);
      expect((await resetRows(budi.id)).map((r) => r.used_at)).toEqual([null]);
    });

    it('1c: a passenger process drives the job after the answer: the mail is sent, the job succeeded and its secret is gone', async () => {
      const t = appAt();
      const budi = await staff({ username: 'budi' });
      expect((await send(browser(t), 'post', FORGOT, { email: budi.email })).status).toBe(202);
      const { token } = await resetMailTo(budi.email);
      const jobs = await until(async () => {
        const all = await mailJobs();
        return all[0]?.status === 'succeeded' ? all : undefined;
      }, 5000, 'the job to succeed');
      expect(jobs).toEqual([{ status: 'succeeded', payload: { userId: budi.id, locale: null }, secret_param: null, last_error: null, attempts: 0 }]);
      expect(JSON.stringify(jobs)).not.toContain(token);
    });

    it('1c: in a worker process the job is enqueued and the worker loop woken (kick), never driven by the request', async () => {
      const kick = vi.fn();
      const drive = vi.fn(() => Promise.resolve(null));
      const worker = {
        mode: 'worker',
        registry: createJobRegistry(handlersWith(jobMailer({ phase: 'ready', db: h, config: CONFIG }))),
        kick,
        drive,
        maybePiggyback: () => {},
      } as unknown as JobRuntime;
      const t = appAt({ jobs: worker });
      const budi = await staff({ username: 'budi' });
      expect((await send(browser(t), 'post', FORGOT, { email: budi.email })).status).toBe(202);
      await until(() => (kick.mock.calls.length > 0 ? true : undefined), 5000, 'the kick');
      expect(kick).toHaveBeenCalledTimes(1);
      expect(drive).not.toHaveBeenCalled();
      expect((await mailJobs()).map((j) => j.status)).toEqual(['queued']);
    });
  });

  describe('reset', () => {
    /** The token of the mail a `forgot` for `user` sends. */
    async function tokenFor(t: TestApp, user: Staff): Promise<string> {
      expect((await send(browser(t), 'post', FORGOT, { email: user.email })).status).toBe(202);
      return (await resetMailTo(user.email)).token;
    }

    it('the token from the mail → 200 without any altis_sid; the password changed, used_at set, every session gone, auth.password.reset; the same token again → 400', async () => {
      const t = appAt();
      const budi = await staff({ username: 'budi' });
      const remembered = await signIn(t, budi, { remember: true });
      const other = await signIn(t, budi);
      const older = await seedResetRow(budi.id);
      const token = await tokenFor(t, budi);

      const r = browser(t);
      const res = await send(r, 'post', RESET, { token, password: NEW_PASSWORD });
      expect(res.status).toBe(200);
      expect(res.headers.getSetCookie().filter((line) => line.includes('altis_sid'))).toEqual([]);
      expect(r.agent.cookies.has(SID)).toBe(false);

      const rows = await resetRows(budi.id);
      expect(rows).toEqual([{ token_hash: sha256hex(token), subject_type: 'staff', expires_at: NOW + 30 * MIN, used_at: NOW }]);
      expect(rows.some((row) => row.token_hash === older)).toBe(false); // the other reset tokens of the user are gone
      expect(await sessionIds(budi.id)).toEqual([]);
      expect(await tokenCount(budi.id)).toBe(0);
      expect(authenticated(await me(remembered))).toBe(false);
      expect(authenticated(await me(other))).toBe(false);
      expect(await audits('auth.password.reset')).toEqual([
        { actor_type: 'staff', actor_id: budi.id, entity: 'staff_users', entity_id: budi.id, ip: IP, meta: {} },
      ]);

      expect(await loginStatus(t, budi, budi.password)).toBe(401);
      expect(await loginStatus(t, budi, NEW_PASSWORD)).toBe(200);
      expectError(await send(browser(t), 'post', RESET, { token, password: 'another-good-passw0rd' }), 400, 'AUTH_RESET_TOKEN_INVALID');
      expect(await audits('auth.password.reset')).toHaveLength(1);
    });

    it('a token at 30 min + 1 ms → 400; a weak password → 422 and leaves the token usable; an unknown token → 400', async () => {
      const t = appAt();
      const budi = await staff({ username: 'budi' });
      const token = await tokenFor(t, budi);

      const weak = await send(browser(t), 'post', RESET, { token, password: '1234567890' });
      expectError(weak, 422, 'PASSWORD_TOO_WEAK');
      expect((await resetRows(budi.id))[0]!.used_at).toBeNull();
      expectError(await send(browser(t), 'post', RESET, { token: randomToken(32), password: NEW_PASSWORD }), 400, 'AUTH_RESET_TOKEN_INVALID');

      t.clock.now = NOW + 30 * MIN + 1;
      expectError(await send(browser(t), 'post', RESET, { token, password: NEW_PASSWORD }), 400, 'AUTH_RESET_TOKEN_INVALID');
      expect((await resetRows(budi.id))[0]!.used_at).toBeNull();
      expect(await loginStatus(t, budi, budi.password)).toBe(200);
    });

    it("a disabled user's reset changes the password and the status stays disabled", async () => {
      const t = appAt();
      const budi = await staff({ username: 'budi' });
      const token = await tokenFor(t, budi);
      await h.db.updateTable('staff_users').set({ status: 'disabled' }).where('id', '=', budi.id).execute();

      expect((await send(browser(t), 'post', RESET, { token, password: NEW_PASSWORD })).status).toBe(200);
      expect((await accountOf(budi.id)).status).toBe('disabled');
      expect(await loginStatus(t, budi, NEW_PASSWORD)).toBe(403); // AUTH_ACCOUNT_DISABLED: the new password, a disabled account
      expect(await loginStatus(t, budi, budi.password)).toBe(401);
    });

    it("a 2FA user's next login still answers stage: 'mfa'", async () => {
      const t = appAt();
      const budi = await staff({ username: 'budi', totp: true });
      const token = await tokenFor(t, budi);
      expect((await send(browser(t), 'post', RESET, { token, password: NEW_PASSWORD })).status).toBe(200);
      const b = await signIn(t, { username: budi.username, password: NEW_PASSWORD }, { stage: 'mfa' });
      const code2fa = hotp(budi.totpSecret!, totpStep(NOW), 6);
      expect((await send(b, 'post', `${AUTH}/2fa/verify`, { code: code2fa })).json).toMatchObject({ stage: 'full' });
    });

    it('a login that verified the old password while the reset committed gets no session', async () => {
      const paused = pausingHasher();
      const t = appAt({ hasher: paused.hasher });
      const budi = await staff({ username: 'budi' });
      const token = await tokenFor(t, budi);
      const hold = paused.pauseNextVerify();
      const late = send(browser(t), 'post', LOGIN, { username: budi.username, password: budi.password });
      await hold.inVerify;
      expect((await send(browser(t), 'post', RESET, { token, password: NEW_PASSWORD })).status).toBe(200);
      hold.release();
      expectError(await late, 401, 'AUTH_INVALID_CREDENTIALS');
      expect(await sessionIds(budi.id)).toEqual([]);
    });
  });

  describe('Review Focus 4: a mail server that accepts and never greets', () => {
    it('forgot answers 202 at once for an existing and an unknown address alike; the failure is logged as mail failed {stage: connect}, without the password or the token', async () => {
      const silent = await startSilentServer();
      try {
        await settings({ 'smtp.host': '127.0.0.1', 'smtp.port': silent.port, 'smtp.username': 'mailer', 'smtp.password': SMTP_PASSWORD });
        // The services' mailer as services.ts builds it, with a timeout of 2.5 s instead of 20 s: longer than the
        // response bound below, so a route that waited for the mail could not answer within it. It keeps the message
        // it was asked to send, so the test knows the token the log must not hold.
        const real = createSmtpMailer(() => loadSmtpConfig(h.db, TEST_KEYRING), { timeoutMs: 2500 });
        const asked: string[] = [];
        const mailer: Mailer = {
          send: (m) => {
            asked.push(m.text);
            return real.send(m);
          },
        };
        const t = appAt({ mailer });
        const budi = await staff({ username: 'budi' });

        const time = async (email: string): Promise<number> => {
          const b = browser(t);
          const started = performance.now();
          const res = await send(b, 'post', FORGOT, { email });
          const elapsed = performance.now() - started;
          // When the 202 arrives the mail has not failed yet: it is still waiting for the greeting, after the answer.
          expect(t.log.lines.some((line) => line.msg === 'mail failed')).toBe(false);
          expect(res.status).toBe(202);
          expect(res.json).toEqual({ accepted: true });
          return elapsed;
        };
        const existing = await time(budi.email);
        const unknown = await time(address('nobody'));
        // Both well within the mailer's 2.5 s: neither answer waited for the mail server.
        expect(existing).toBeLessThan(1000);
        expect(unknown).toBeLessThan(1000);

        const failed = await until(() => t.log.lines.find((line) => line.msg === 'mail failed'), 8000, 'the mail failure in the log');
        expect(failed.fields).toMatchObject({ stage: 'connect' });
        expect(t.log.lines.filter((line: RecordedLine) => line.msg === 'mail failed')).toHaveLength(1);
        expect(asked).toHaveLength(1);
        const token = RESET_LINK.exec(asked[0]!)?.[1];
        expect(token).toBeDefined();
        const logged = JSON.stringify(t.log.lines);
        expect(logged).not.toContain(SMTP_PASSWORD);
        expect(logged).not.toContain(token!);
        expect(logged).not.toContain('#token=');
        // 1c Task 18: one job, for the existing address only, taken back for a retry; the token in neither its payload
        // nor its last_error.
        const jobs = await until(async () => {
          const all = await mailJobs();
          return all[0]?.attempts === 1 ? all : undefined;
        }, 5000, 'the retry');
        expect(jobs).toEqual([
          { status: 'queued', payload: { userId: budi.id, locale: null }, secret_param: expect.any(String), last_error: expect.stringMatching(/^SMTP_FAILED/), attempts: 1 },
        ]);
        expect(JSON.stringify(jobs)).not.toContain(token!);
      } finally {
        await silent.close();
      }
    });
  });

  describe('profile and own sessions', () => {
    it('PATCH auth/me {locale: en} → GET auth/me shows en; a name too; auth.profile.update with the changed fields', async () => {
      const t = appAt();
      const budi = await staff({ username: 'budi' });
      const b = await signIn(t, budi);
      const before = await accountOf(budi.id);

      const res = await send(b, 'patch', ME, { locale: 'en' });
      expect(res.status).toBe(200);
      expect(res.json).toMatchObject({ id: budi.id, username: 'budi', locale: 'en' });
      expect(((await me(b)).json as { user: { locale: string | null } }).user.locale).toBe('en');

      expect((await send(b, 'patch', ME, { name: '  Budi Santoso ', locale: null })).status).toBe(200);
      expect((await me(b)).json).toMatchObject({ user: { name: 'Budi Santoso', locale: null } });
      expect(Number((await accountOf(budi.id)).version)).toBe(Number(before.version) + 2);

      expect(await audits('auth.profile.update')).toEqual([
        { actor_type: 'staff', actor_id: budi.id, entity: 'staff_users', entity_id: budi.id, ip: IP, meta: { fields: ['locale'] } },
        { actor_type: 'staff', actor_id: budi.id, entity: 'staff_users', entity_id: budi.id, ip: IP, meta: { fields: ['name', 'locale'] } },
      ]);
      expectError(await send(b, 'patch', ME, { locale: 'fr' }), 422, 'VALIDATION_FAILED');
      expectError(await send(b, 'patch', ME, { status: 'active' }), 422, 'VALIDATION_FAILED');
    });

    it("GET auth/sessions lists the subject's 2 sessions with exactly one current; DELETE of the other → 200; of another user's session → 404", async () => {
      const t = appAt();
      const budi = await staff({ username: 'budi' });
      const ani = await staff({ username: 'ani' });
      const other = await signIn(t, budi, { remember: true });
      t.clock.now = NOW + 2 * SEC;
      const b = await signIn(t, budi);
      const aniBrowser = await signIn(t, ani);

      const list = await b.agent.get(SESSIONS);
      expect(list.status).toBe(200);
      const items = list.json as { id: string; current: boolean; createdAt: number; lastSeenAt: number; ip: string | null; userAgent: string | null; remembered: boolean }[];
      expect(items).toHaveLength(2);
      expect(items.filter((s) => s.current)).toHaveLength(1);
      expect(new Set(items.map((s) => s.id))).toEqual(new Set([sha256hex(sidOf(b)), sha256hex(sidOf(other))]));
      expect(items.find((s) => s.current)).toEqual({
        id: sha256hex(sidOf(b)),
        current: true,
        createdAt: NOW + 2 * SEC,
        lastSeenAt: NOW + 2 * SEC,
        ip: IP,
        userAgent: null,
        remembered: false,
      });
      expect(items.find((s) => !s.current)).toMatchObject({ id: sha256hex(sidOf(other)), createdAt: NOW, remembered: true });

      expectError(await send(b, 'delete', `${SESSIONS}/${sha256hex(sidOf(aniBrowser))}`), 404, 'NOT_FOUND');
      expectError(await send(b, 'delete', `${SESSIONS}/${'0'.repeat(64)}`), 404, 'NOT_FOUND');
      expect(authenticated(await me(aniBrowser))).toBe(true);

      const del = await send(b, 'delete', `${SESSIONS}/${sha256hex(sidOf(other))}`);
      expect(del.status).toBe(200);
      expect(authenticated(await me(other))).toBe(false);
      expect(await tokenCount(budi.id)).toBe(0); // the remember-me token of that session went with it (B9)
      expect(((await b.agent.get(SESSIONS)).json as unknown[]).length).toBe(1);
      expect(authenticated(await me(b))).toBe(true);
      expect(await audits('auth.session.revoke')).toEqual([
        { actor_type: 'staff', actor_id: budi.id, entity: 'staff_users', entity_id: budi.id, ip: IP, meta: { revoked: 1 } },
      ]);
    });

    it('DELETE of the current session signs this browser out (its cookies cleared)', async () => {
      const t = appAt();
      const budi = await staff({ username: 'budi' });
      const b = await signIn(t, budi, { remember: true });
      const res = await send(b, 'delete', `${SESSIONS}/${sha256hex(sidOf(b))}`);
      expect(res.status).toBe(200);
      expect(cookieLine(res, SID)).toMatch(/Max-Age=0/);
      expect(cookieLine(res, RM)).toMatch(/Max-Age=0/);
      expect(await sessionIds(budi.id)).toEqual([]);
      expect(authenticated(await me(b))).toBe(false);
    });
  });
});
