import fsp from 'node:fs/promises';
import os from 'node:os';
import path from 'node:path';
import { createSmtpMailer, loadSmtpConfig } from '@altis/core';
import { PHASE1_MIGRATIONS, runMigrations, type DbHandle } from '@altis/db';
import type { Env } from '@altis/platform';
import { afterAll, afterEach, beforeAll, beforeEach, describe, expect, it } from 'vitest';
import { bodyOf, closedPort, headerOf, startFakeSmtp } from '../../../../packages/core/test/fake-smtp.js';
import { MAILPIT_SMTP, mailpit, mailpitMode } from '../../../../packages/core/test/mailpit.js';
import { engineLabel, testDb, testDbContext, type TestDbHandle } from '../../../../tools/test/test-db.js';
import { createApp } from '../../src/app.js';
import { applyEnvOverrides, loadConfig, writeConfig, type Config } from '../../src/config.js';
import type { ConfigFence } from '../../src/http/config-fence.js';
import { EMAIL_TEST_DEADLINE_MS, EMAIL_TEST_TIMEOUT_MS, type AppServices } from '../../src/services.js';
import { createAgent, type AgentReply } from '../agent.js';
import { recordingLogger, sampleConfig, type RecordedLine } from '../support.js';
import { TEST_KEYRING, seedStaff, sessionCookieFor, sessionCsrfFor } from '../support-auth.js';

// The system configuration API of Task 22 on the engine picked by ALTIS_TEST_DB (spec §7.6, §13.3 "Konfigurasi
// Sistem", P13, P15; decisions D27, D42; Review Focus 5). Super admin only (`system.config.manage`, which `admin`
// lacks), with reauth for every write:
// - `GET system/config`: config.json's baseUrl, proxy hops and allowed origins as this process uses them (the
//   environment overrides applied), the SMTP settings with the password write-only, and which fields an `ALTIS_*`
//   variable locks;
// - `PUT system/config`: validates everything first (env locks, baseUrl, the request's Origin against the new
//   baseUrl/allowedOrigins, the proxy hops against the request itself, the SMTP settings), then config.json
//   (updateConfig), then the SMTP settings and the audit in one transaction; this process applies the new config
//   at once, with the environment overrides still winning (S17);
// - `POST system/config/email-test` and `POST system/cron-token/rotate`.
//
// Each test gets a DATA_DIR of its own whose config.json is FILE, and a new app over it.

const ctx = testDbContext();
let h: TestDbHandle;

/** In the past: an audit entry may not be dated ahead of the real clock. */
const NOW = Date.UTC(2026, 9, 20, 9, 0, 5);
/** config.json of every test (one keyring and sessionKey for the whole file). */
const FILE: Config = sampleConfig({ db: { dialect: 'sqlite' }, keyring: TEST_KEYRING.map((entry) => ({ ...entry })) });
const BASE = 'https://perpus.sekolah.sch.id';
const WWW = 'https://www.sekolah.sch.id';
const ENV_BASE = 'https://env.perpus.test';
/** An install still on http (cPanel before AutoSSL, a LAN address). */
const HTTP_BASE = 'http://perpus.test';
const HTTPS_BASE = 'https://perpus.test';
const CONFIG_PATH = '/api/v1/system/config';
const EMAIL_TEST = '/api/v1/system/config/email-test';
const ROTATE = '/api/v1/system/cron-token/rotate';

const code = (res: AgentReply): string | undefined => (res.json as { code?: string } | undefined)?.code;
const errors = (res: AgentReply): { path: string; code: string }[] => (res.json as { errors?: { path: string; code: string }[] }).errors ?? [];

/** Every string anywhere in a JSON value, keys included. */
function strings(value: unknown): string[] {
  if (typeof value === 'string') return [value];
  if (value === null || typeof value !== 'object') return [];
  return Object.entries(value as Record<string, unknown>).flatMap(([key, v]) => [key, ...strings(v)]);
}

async function audits(action: string) {
  const rows = await h.db
    .selectFrom('audit_log')
    .select(['actor_type', 'actor_id', 'entity', 'entity_id', 'meta'])
    .where('action', '=', action)
    .orderBy('seq')
    .execute();
  return rows.map((r) => ({ ...r, meta: JSON.parse(r.meta) as Record<string, unknown> }));
}

type KyselyPlugin = Parameters<TestDbHandle['db']['withPlugin']>[0];

/** The test database seen through a plugin that fails every INSERT INTO audit_log (a database breaking then). */
function failingAuditInserts(): DbHandle {
  const plugin: KyselyPlugin = {
    transformQuery({ node }) {
      if (node.kind === 'InsertQueryNode' && JSON.stringify(node).includes('"name":"audit_log"')) {
        throw new Error('the injected statement failure');
      }
      return node;
    },
    transformResult: async ({ result }) => result,
  };
  return { ...h, db: h.db.withPlugin(plugin) };
}

// ---------------------------------------------------------------------------------------------------------------
// Mail: mailpit when the run asks for it (ALTIS_TEST_MAILPIT_REQUIRED=1 in CI), the in-process SMTP server otherwise.

interface MailSink {
  smtp: { host: string; port: number };
  /** The subjects of the messages to `to` received so far, oldest first. */
  subjectsTo(to: string): Promise<string[]>;
  close(): Promise<void>;
}

async function openSink(): Promise<MailSink> {
  const mode = mailpitMode();
  if (mode !== 'off') {
    const mp = mailpit();
    const up = await mp.available();
    if (!up && mode === 'required') throw new Error('mailpit does not answer, and ALTIS_TEST_MAILPIT_REQUIRED=1 requires it');
    if (up) {
      return {
        smtp: { ...MAILPIT_SMTP },
        subjectsTo: async (to) => (await mp.messages()).filter((m) => m.to.includes(to)).map((m) => m.subject),
        close: async () => undefined,
      };
    }
  }
  const fake = await startFakeSmtp();
  return {
    smtp: { host: '127.0.0.1', port: fake.port },
    subjectsTo: async (to) => fake.messages.filter((m) => m.to.includes(to)).map((m) => headerOf(m.data, 'Subject') ?? bodyOf(m.data)),
    close: () => fake.close(),
  };
}

// ---------------------------------------------------------------------------------------------------------------

/** A browser signed in as one staff user, sending `Origin` with its writes when given one. */
interface Client {
  userId: string;
  get(path: string): Promise<AgentReply>;
  put(path: string, body: unknown, headers?: Record<string, string>): Promise<AgentReply>;
  post(path: string, body: unknown, headers?: Record<string, string>): Promise<AgentReply>;
}

describe.skipIf(!ctx.available)(`system configuration API [${engineLabel()}]`, () => {
  let root: string;
  let dataDir: string;
  let migrationsDir: string;
  let app: ReturnType<typeof createApp>;
  let log: ReturnType<typeof recordingLogger>;
  let superAdminId: string;
  let adminId: string;
  let serial = 0;
  /** config.json of the current app, as written. */
  let file: Config;

  /**
   * A new app over a DATA_DIR holding `o.file` (default FILE, written now), with `env` as the server's environment and
   * `services` replacing some of its services.
   */
  async function appWith(o: { env?: Env; db?: DbHandle; file?: Config; services?: Partial<AppServices> } = {}): Promise<void> {
    serial += 1;
    dataDir = path.join(root, `data-${serial}`);
    file = o.file ?? FILE;
    await writeConfig(dataDir, file);
    const env = o.env ?? {};
    log = recordingLogger();
    app = createApp({
      state: { phase: 'ready', db: o.db ?? h, config: applyEnvOverrides(file, env) },
      version: '0.1.0',
      buildId: 'b',
      log,
      clock: () => NOW,
      env,
      dataDir,
      ...(o.services === undefined ? {} : { services: o.services }),
    });
  }

  /** A browser of `userId` (a new session, re-authenticated just now unless `reauth` is false). */
  async function client(userId: string, o: { reauth?: boolean; peer?: string } = {}): Promise<Client> {
    const token = await sessionCookieFor(h, userId, { now: NOW, reauthAt: o.reauth === false ? null : NOW });
    const agent = createAgent(app, o.peer === undefined ? {} : { peer: o.peer });
    // An https baseUrl gives the cookies the `__Host-` prefix (P13).
    agent.setCookie(file.baseUrl.startsWith('https:') ? '__Host-altis_sid' : 'altis_sid', token);
    const csrf = { 'x-csrf-token': sessionCsrfFor(FILE, token) };
    return {
      userId,
      get: (p) => agent.get(p),
      put: (p, body, headers = {}) => agent.put(p, body, { ...csrf, ...headers }),
      post: (p, body, headers = {}) => agent.post(p, body, { ...csrf, ...headers }),
    };
  }

  const fileText = (): Promise<string> => fsp.readFile(path.join(dataDir, 'config.json'), 'utf8');
  const bakText = (): Promise<string> => fsp.readFile(path.join(dataDir, 'config.json.bak'), 'utf8');
  const fileConfig = async (): Promise<Config> => (await loadConfig(dataDir, {}))!;

  beforeAll(async () => {
    h = await testDb();
    root = await fsp.mkdtemp(path.join(os.tmpdir(), 'altis-system-config-'));
    migrationsDir = path.join(root, 'migrations');
    await runMigrations(h, { appVersion: '0.1.0', dataDir: migrationsDir, migrations: PHASE1_MIGRATIONS });
    superAdminId = (await seedStaff(h, { username: 'super_konfig', now: NOW, roles: [{ key: 'super_admin' }] })).id;
    adminId = (await seedStaff(h, { username: 'admin_konfig', now: NOW, roles: [{ key: 'admin' }] })).id;
  });

  afterAll(async () => {
    await h?.close();
    if (root !== undefined) await fsp.rm(root, { recursive: true, force: true });
  });

  beforeEach(async () => {
    await h.db.deleteFrom('settings').execute();
    await h.db.deleteFrom('audit_log').execute();
    await appWith();
  });

  describe('A4: system.config.manage is the super admin\'s alone', () => {
    it('an admin calling any of the 4 routes → 403 AUTHZ_DENIED, PUT {smtp: {host: "x"}} included; nothing changes', async () => {
      const admin = await client(adminId);
      const before = await fileText();
      const calls: [string, () => Promise<AgentReply>][] = [
        ['GET system/config', () => admin.get(CONFIG_PATH)],
        ['PUT system/config', () => admin.put(CONFIG_PATH, { smtp: { host: 'x' } })],
        ['POST email-test', () => admin.post(EMAIL_TEST, { to: 'staff@perpus.test' })],
        ['POST cron-token/rotate', () => admin.post(ROTATE, {})],
      ];
      for (const [name, call] of calls) {
        const res = await call();
        expect({ name, status: res.status, code: code(res) }).toEqual({ name, status: 403, code: 'AUTHZ_DENIED' });
      }
      expect(await fileText()).toBe(before);
      expect(await h.db.selectFrom('settings').select('key').execute()).toEqual([]);
    });

    it('the super admin passes; every write needs a reauth (401 AUTH_REAUTH_REQUIRED without one)', async () => {
      const stale = await client(superAdminId, { reauth: false });
      expect((await stale.get(CONFIG_PATH)).status).toBe(200);
      for (const res of [
        await stale.put(CONFIG_PATH, { smtp: { host: 'x' } }),
        await stale.post(EMAIL_TEST, { to: 'staff@perpus.test' }),
        await stale.post(ROTATE, {}),
      ]) {
        expect({ status: res.status, code: code(res) }).toEqual({ status: 401, code: 'AUTH_REAUTH_REQUIRED' });
      }
    });
  });

  describe('GET system/config', () => {
    it('shows config.json as this process uses it and the SMTP settings, no secret', async () => {
      const sa = await client(superAdminId);
      const res = await sa.get(CONFIG_PATH);
      expect(res.status).toBe(200);
      expect(res.headers.get('cache-control')).toBe('no-store');
      expect(res.json).toEqual({
        baseUrl: BASE,
        trustProxy: { hops: 1 },
        allowedOrigins: [WWW],
        smtp: { host: null, port: 587, security: 'starttls', username: null, password: { isSet: false }, from: null },
        cronToken: { isSet: true },
        locked: {},
      });
      expect(res.text).not.toContain(FILE.secrets.cronToken);
      expect(res.text).not.toContain(FILE.secrets.sessionKey);
    });
  });

  describe('PUT system/config', () => {
    it('secrets are write-only: the SMTP password is saved and shown as {isSet: true}, never its value', async () => {
      const sa = await client(superAdminId);
      const res = await sa.put(CONFIG_PATH, { smtp: { host: '127.0.0.1', port: 31025, security: 'none', from: 'perpus@x.test', password: 'p' } });
      expect(res.status, res.text).toBe(200);
      const get = await sa.get(CONFIG_PATH);
      for (const body of [res.json, get.json]) {
        expect((body as { smtp: unknown }).smtp).toEqual({
          host: '127.0.0.1',
          port: 31025,
          security: 'none',
          username: null,
          password: { isSet: true },
          from: 'perpus@x.test',
        });
        expect(strings(body)).not.toContain('p');
      }
      const row = await h.db.selectFrom('settings').select(['value', 'is_secret']).where('key', '=', 'smtp.password').executeTakeFirstOrThrow();
      expect(row.value).toMatch(/^v1:/);
      expect(Number(row.is_secret)).toBe(1);

      const entries = await audits('system.config.update');
      expect(entries).toHaveLength(1);
      expect(entries[0]).toMatchObject({ actor_type: 'staff', actor_id: superAdminId });
      expect(entries[0]!.meta).toEqual({ fields: ['smtp.host', 'smtp.port', 'smtp.security', 'smtp.password', 'smtp.from'] });
    });

    it('a bound secret: a new host without a new password clears it (password.isSet false)', async () => {
      const sa = await client(superAdminId);
      await sa.put(CONFIG_PATH, { smtp: { host: '127.0.0.1', port: 31025, security: 'none', from: 'perpus@x.test', password: 'p' } });
      const res = await sa.put(CONFIG_PATH, { smtp: { host: 'other' } });
      expect(res.status, res.text).toBe(200);
      expect((res.json as { smtp: { password: unknown } }).smtp.password).toEqual({ isSet: false });
      expect(((await sa.get(CONFIG_PATH)).json as { smtp: { password: unknown } }).smtp.password).toEqual({ isSet: false });
      expect((await audits('system.config.update')).at(-1)?.meta).toEqual({ fields: ['smtp.host', 'smtp.password'] });
    });

    it('env locks: with ALTIS_BASE_URL set, GET shows it locked and a PUT of baseUrl → 409 CONFIG_LOCKED_BY_ENV', async () => {
      await appWith({ env: { ALTIS_BASE_URL: ENV_BASE, ALTIS_TRUST_PROXY_HOPS: '1' } });
      const sa = await client(superAdminId);
      const get = await sa.get(CONFIG_PATH);
      expect(get.json).toMatchObject({ baseUrl: ENV_BASE, locked: { baseUrl: 'ALTIS_BASE_URL', 'trustProxy.hops': 'ALTIS_TRUST_PROXY_HOPS' } });

      const before = await fileText();
      const res = await sa.put(CONFIG_PATH, { baseUrl: 'https://baru.perpus.test' });
      expect({ status: res.status, code: code(res) }).toEqual({ status: 409, code: 'CONFIG_LOCKED_BY_ENV' });
      expect((res.json as { detail?: string }).detail).toContain('ALTIS_BASE_URL');
      const hops = await sa.put(CONFIG_PATH, { trustProxy: { hops: 1 } });
      expect({ status: hops.status, code: code(hops) }).toEqual({ status: 409, code: 'CONFIG_LOCKED_BY_ENV' });
      expect((hops.json as { detail?: string }).detail).toContain('ALTIS_TRUST_PROXY_HOPS');
      expect(await fileText()).toBe(before);
      expect(await audits('system.config.update')).toEqual([]);
    });

    it('a blank ALTIS_BASE_URL locks nothing', async () => {
      await appWith({ env: { ALTIS_BASE_URL: '  ' } });
      const sa = await client(superAdminId);
      expect(((await sa.get(CONFIG_PATH)).json as { locked: unknown }).locked).toEqual({});
    });

    it('Review Focus 5: a baseUrl the request\'s Origin would no longer match → 422 origin_mismatch, config.json unchanged', async () => {
      const sa = await client(superAdminId);
      const before = await fileText();
      const res = await sa.put(CONFIG_PATH, { baseUrl: 'https://other.example' }, { origin: BASE });
      expect(res.status, res.text).toBe(422);
      expect(res.json).toMatchObject({ code: 'INVALID_BASE_URL', reason: 'origin_mismatch' });
      expect((res.json as { detail?: string }).detail).toContain('allowedOrigins');
      expect(await fileText()).toBe(before);
      expect(await audits('system.config.update')).toEqual([]);

      // Removing the origin the admin is on from allowedOrigins locks them out just the same.
      const www = await sa.put(CONFIG_PATH, { allowedOrigins: [] }, { origin: WWW });
      expect(www.json).toMatchObject({ code: 'INVALID_BASE_URL', reason: 'origin_mismatch' });
      expect(await fileText()).toBe(before);
    });

    it('Review Focus 5: the same PUT with allowedOrigins holding the current origin → 200; config.json (mode 600) holds it', async () => {
      const sa = await client(superAdminId);
      const res = await sa.put(CONFIG_PATH, { baseUrl: 'https://other.example/', allowedOrigins: [`${BASE}/`, BASE] }, { origin: BASE });
      expect(res.status, res.text).toBe(200);
      expect(res.json).toMatchObject({ baseUrl: 'https://other.example', allowedOrigins: [BASE] });
      const file = await fileConfig();
      expect(file.baseUrl).toBe('https://other.example');
      expect(file.allowedOrigins).toEqual([BASE]);
      if (process.platform !== 'win32') expect((await fsp.stat(path.join(dataDir, 'config.json'))).mode & 0o777).toBe(0o600);
      expect((await audits('system.config.update')).map((e) => e.meta)).toEqual([{ fields: ['baseUrl', 'allowedOrigins'] }]);

      // This process uses the new config at once: the next write from the same origin passes the Origin check.
      const next = await sa.put(CONFIG_PATH, {}, { origin: BASE });
      expect(next.status, next.text).toBe(200);
      expect(next.json).toMatchObject({ baseUrl: 'https://other.example', allowedOrigins: [BASE] });
      const denied = await sa.put(CONFIG_PATH, {}, { origin: WWW });
      expect({ status: denied.status, code: code(denied) }).toEqual({ status: 403, code: 'ORIGIN_DENIED' });
    });

    it('Review Focus 5: from an http address, a change to an https baseUrl → 422 origin_mismatch whatever allowedOrigins holds', async () => {
      // The sign-in cookies would become `__Host-` and Secure (P13): a browser neither sends nor sets them over http,
      // so the admin would be signed out at the address they are on and could not sign in there again.
      await appWith({ file: { ...FILE, baseUrl: HTTP_BASE, allowedOrigins: [] } });
      const sa = await client(superAdminId);
      const before = await fileText();
      const res = await sa.put(CONFIG_PATH, { baseUrl: HTTPS_BASE, allowedOrigins: [HTTP_BASE] }, { origin: HTTP_BASE });
      expect(res.status, res.text).toBe(422);
      expect(res.json).toMatchObject({ code: 'INVALID_BASE_URL', reason: 'origin_mismatch' });
      const detail = (res.json as { detail?: string }).detail ?? '';
      expect(detail).toContain('https');
      expect(detail).not.toContain('allowedOrigins'); // adding the http address would not help, so it is not advised
      expect(await fileText()).toBe(before);
      expect(await audits('system.config.update')).toEqual([]);

      // Without allowedOrigins, by Referer (no Origin), likewise.
      const referer = await sa.put(CONFIG_PATH, { baseUrl: HTTPS_BASE }, { referer: `${HTTP_BASE}/admin/sistem` });
      expect(referer.json).toMatchObject({ code: 'INVALID_BASE_URL', reason: 'origin_mismatch' });
      expect(((referer.json as { detail?: string }).detail ?? '')).not.toContain('allowedOrigins');
      expect(await fileText()).toBe(before);
    });

    it('Review Focus 5: an http address allowed next to an https baseUrl cannot move the baseUrl either; resending it can', async () => {
      await appWith({ file: { ...FILE, allowedOrigins: [WWW, HTTP_BASE] } });
      const sa = await client(superAdminId);
      const before = await fileText();
      const moved = await sa.put(CONFIG_PATH, { baseUrl: 'https://baru.sekolah.sch.id', allowedOrigins: [HTTP_BASE] }, { origin: HTTP_BASE });
      expect(moved.json).toMatchObject({ status: 422, code: 'INVALID_BASE_URL', reason: 'origin_mismatch' });
      expect(await fileText()).toBe(before);
      // The baseUrl in use, sent again with the rest of the form, changes nothing that could lock anyone out.
      const same = await sa.put(CONFIG_PATH, { baseUrl: BASE, allowedOrigins: [WWW, HTTP_BASE] }, { origin: HTTP_BASE });
      expect(same.status, same.text).toBe(200);
      expect(same.json).toMatchObject({ baseUrl: BASE, signInAgain: false });
    });

    it('a scheme change that is accepted answers signInAgain: true (the sign-in cookies change their names); others false', async () => {
      // http → https from the https address (allowed already): accepted, and the admin will sign in again.
      await appWith({ file: { ...FILE, baseUrl: HTTP_BASE, allowedOrigins: [HTTPS_BASE] } });
      const up = await (await client(superAdminId)).put(CONFIG_PATH, { baseUrl: HTTPS_BASE }, { origin: HTTPS_BASE });
      expect(up.status, up.text).toBe(200);
      expect(up.json).toMatchObject({ baseUrl: HTTPS_BASE, signInAgain: true });
      expect((await fileConfig()).baseUrl).toBe(HTTPS_BASE);

      // https → http from the https address kept in allowedOrigins.
      await appWith();
      const sa = await client(superAdminId);
      const down = await sa.put(CONFIG_PATH, { baseUrl: HTTP_BASE, allowedOrigins: [BASE] }, { origin: BASE });
      expect(down.status, down.text).toBe(200);
      expect(down.json).toMatchObject({ baseUrl: HTTP_BASE, signInAgain: true });

      // No scheme change: false.
      await appWith();
      const same = await (await client(superAdminId)).put(CONFIG_PATH, { baseUrl: 'https://lain.example', allowedOrigins: [BASE] }, { origin: BASE });
      expect(same.status, same.text).toBe(200);
      expect(same.json).toMatchObject({ baseUrl: 'https://lain.example', signInAgain: false });
      const smtpOnly = await (await client(superAdminId)).put(CONFIG_PATH, { smtp: { from: 'perpus@perpus.test' } });
      expect(smtpOnly.json).toMatchObject({ signInAgain: false });
    });

    it('a baseUrl that is not one → 422 INVALID_BASE_URL with its reason; an allowed origin likewise', async () => {
      const sa = await client(superAdminId);
      const before = await fileText();
      const res = await sa.put(CONFIG_PATH, { baseUrl: 'https://perpus.test/opac' });
      expect(res.json).toMatchObject({ status: 422, code: 'INVALID_BASE_URL', reason: 'path' });
      const origin = await sa.put(CONFIG_PATH, { allowedOrigins: ['ftp://perpus.test'] });
      expect(origin.json).toMatchObject({ status: 422, code: 'INVALID_BASE_URL', reason: 'scheme' });
      const many = await sa.put(CONFIG_PATH, { allowedOrigins: Array.from({ length: 11 }, (_, i) => `https://o${i}.perpus.test`) });
      expect(many.status).toBe(422);
      expect(errors(many)[0]?.path).toBe('allowedOrigins');
      expect(await fileText()).toBe(before);
    });

    it('trustProxy is tested against this request: hops 0 behind a local proxy → collapsed, 3 for one proxy → chain_short, 1 → 200', async () => {
      const sa = await client(superAdminId, { peer: '127.0.0.1' });
      const xff = { 'x-forwarded-for': '198.51.100.7' };
      const before = await fileText();

      const zero = await sa.put(CONFIG_PATH, { trustProxy: { hops: 0 } }, xff);
      expect(zero.json).toMatchObject({ status: 422, code: 'TRUST_PROXY_INVALID', reason: 'collapsed' });
      const three = await sa.put(CONFIG_PATH, { trustProxy: { hops: 3 } }, xff);
      expect(three.json).toMatchObject({ status: 422, code: 'TRUST_PROXY_INVALID', reason: 'chain_short' });
      expect(await fileText()).toBe(before);

      const one = await sa.put(CONFIG_PATH, { trustProxy: { hops: 1 } }, xff);
      expect(one.status, one.text).toBe(200);
      expect(one.json).toMatchObject({ trustProxy: { hops: 1 } });

      const two = await sa.put(CONFIG_PATH, { trustProxy: { hops: 2 } }, { 'x-forwarded-for': '198.51.100.7, 10.0.0.2' });
      expect(two.status, two.text).toBe(200);
      expect((await fileConfig()).trustProxy.hops).toBe(2);
      expect((await audits('system.config.update')).map((e) => e.meta)).toEqual([{ fields: [] }, { fields: ['trustProxy.hops'] }]);
    });

    it('trustProxy: only a new value is tried; the hops in use sent again (a whole form) are accepted from anywhere', async () => {
      // No proxy header from this peer: hops 1 (in use) would be a short chain, hops 2 is one.
      const sa = await client(superAdminId);
      const same = await sa.put(CONFIG_PATH, { trustProxy: { hops: 1 }, smtp: { from: 'perpus@perpus.test' } });
      expect(same.status, same.text).toBe(200);
      expect((await audits('system.config.update')).map((e) => e.meta)).toEqual([{ fields: ['smtp.from'] }]);
      const two = await sa.put(CONFIG_PATH, { trustProxy: { hops: 2 } });
      expect(two.json).toMatchObject({ status: 422, code: 'TRUST_PROXY_INVALID', reason: 'chain_short' });
    });

    it('a whole form that changes no config.json field writes no config.json: the .bak keeps the real previous copy', async () => {
      const resets: Config[] = [];
      const fence: ConfigFence = { current: () => file, check: async () => undefined, reset: (config) => void resets.push(config) };
      await appWith({ services: { fence } });
      const sa = await client(superAdminId, { peer: '127.0.0.1' });
      const xff = { 'x-forwarded-for': '198.51.100.7' };
      const origins = [WWW, 'https://lain.sekolah.sch.id'];
      const first = await sa.put(CONFIG_PATH, { allowedOrigins: origins }, xff);
      expect(first.status, first.text).toBe(200);
      expect(resets).toHaveLength(1);
      const text = await fileText();
      const bak = await bakText();
      expect((JSON.parse(bak) as Config).allowedOrigins).toEqual([WWW]); // the copy before that change
      const mtime = (await fsp.stat(path.join(dataDir, 'config.json'))).mtimeMs;

      // The whole form again, with only an SMTP change: config.json is not touched, nor is the fence reset.
      const form = { baseUrl: `${BASE}/`, trustProxy: { hops: 1 }, allowedOrigins: [...origins, WWW], smtp: { from: 'perpus@perpus.test' } };
      const again = await sa.put(CONFIG_PATH, form, { ...xff, origin: BASE });
      expect(again.status, again.text).toBe(200);
      expect(again.json).toMatchObject({ baseUrl: BASE, trustProxy: { hops: 1 }, allowedOrigins: origins, signInAgain: false });
      expect(await fileText()).toBe(text);
      expect(await bakText()).toBe(bak);
      expect((await fsp.stat(path.join(dataDir, 'config.json'))).mtimeMs).toBe(mtime);
      expect(resets).toHaveLength(1);
      expect((await audits('system.config.update')).map((e) => e.meta)).toEqual([{ fields: ['allowedOrigins'] }, { fields: ['smtp.from'] }]);
    });

    it('S17: with ALTIS_BASE_URL set, a PUT of allowedOrigins → 200, and the next request still runs on the env baseUrl', async () => {
      await appWith({ env: { ALTIS_BASE_URL: ENV_BASE } });
      const sa = await client(superAdminId);
      const res = await sa.put(CONFIG_PATH, { allowedOrigins: [WWW, 'https://lain.sekolah.sch.id'] }, { origin: ENV_BASE });
      expect(res.status, res.text).toBe(200);

      const get = await sa.get(CONFIG_PATH);
      expect(get.json).toMatchObject({ baseUrl: ENV_BASE, allowedOrigins: [WWW, 'https://lain.sekolah.sch.id'], locked: { baseUrl: 'ALTIS_BASE_URL' } });
      // The Origin check of the next write uses the env baseUrl (config.json's own is not an allowed origin).
      const next = await sa.put(CONFIG_PATH, { allowedOrigins: [WWW] }, { origin: ENV_BASE });
      expect(next.status, next.text).toBe(200);
      const fromFileBase = await sa.put(CONFIG_PATH, {}, { origin: BASE });
      expect({ status: fromFileBase.status, code: code(fromFileBase) }).toEqual({ status: 403, code: 'ORIGIN_DENIED' });
      // The override is never written to the file.
      const file = await fileConfig();
      expect(file.baseUrl).toBe(BASE);
      expect(file.allowedOrigins).toEqual([WWW]);
    });

    it('an invalid SMTP setting stops everything: 422 at its setting path, config.json unchanged, nothing saved', async () => {
      const sa = await client(superAdminId);
      const before = await fileText();
      const res = await sa.put(CONFIG_PATH, { allowedOrigins: [WWW, 'https://lain.sekolah.sch.id'], smtp: { port: 0 } });
      expect(res.status).toBe(422);
      expect(code(res)).toBe('VALIDATION_FAILED');
      expect(errors(res).map((e) => e.path)).toEqual(['smtp.port']);
      const host = await sa.put(CONFIG_PATH, { allowedOrigins: [WWW, 'https://lain.sekolah.sch.id'], smtp: { host: 'bukan host!', from: 'bukan-alamat' } });
      expect(code(host)).toBe('VALIDATION_FAILED');
      expect(errors(host).map((e) => e.path).sort()).toEqual(['smtp.from', 'smtp.host']);
      expect(await fileText()).toBe(before);
      expect(await h.db.selectFrom('settings').select('key').execute()).toEqual([]);
      expect(await audits('system.config.update')).toEqual([]);
    });

    it('the body is strict at every level', async () => {
      const sa = await client(superAdminId);
      for (const body of [{ port: 3000 }, { smtp: { tls: true } }, { trustProxy: { hops: 1, extra: 1 } }, { trustProxy: { hops: 11 } }]) {
        const res = await sa.put(CONFIG_PATH, body);
        expect({ body, status: res.status, code: code(res) }).toEqual({ body, status: 422, code: 'VALIDATION_FAILED' });
      }
    });

    it('a failure after config.json was written is logged at error level with the field names, and answered', async () => {
      await appWith({ db: failingAuditInserts() });
      const sa = await client(superAdminId);
      const res = await sa.put(CONFIG_PATH, { allowedOrigins: [WWW, 'https://lain.sekolah.sch.id'] });
      expect(res.status).toBe(500);
      expect((await fileConfig()).allowedOrigins).toEqual([WWW, 'https://lain.sekolah.sch.id']);
      const line = log.lines.find((l: RecordedLine) => l.level === 'error' && l.msg.startsWith('config.json changed'));
      expect(line?.fields).toMatchObject({ fields: ['allowedOrigins'] });
      expect(JSON.stringify(line)).not.toContain('lain.sekolah');
      // This process follows the file all the same.
      expect(((await sa.get(CONFIG_PATH)).json as { allowedOrigins: string[] }).allowedOrigins).toEqual([WWW, 'https://lain.sekolah.sch.id']);
    });
  });

  describe('POST system/config/email-test', () => {
    let sink: MailSink | undefined;

    afterEach(async () => {
      await sink?.close();
      sink = undefined;
    });

    it('sends the test mail through the saved SMTP settings: 200 {sent: true}, one message, audited ok', async () => {
      sink = await openSink();
      const sa = await client(superAdminId);
      const saved = await sa.put(CONFIG_PATH, { smtp: { host: sink.smtp.host, port: sink.smtp.port, security: 'none', from: 'perpus@perpus.test' } });
      expect(saved.status, saved.text).toBe(200);
      const to = `uji.${Date.now()}.${serial}@perpus.test`;
      const res = await sa.post(EMAIL_TEST, { to });
      expect(res.status, res.text).toBe(200);
      expect(res.json).toEqual({ sent: true });
      expect(await sink.subjectsTo(to)).toEqual(['Email uji dari Perpustakaan']);
      expect((await audits('system.config.email_test')).map((e) => e.meta)).toEqual([{ ok: true }]);
      expect(JSON.stringify(await audits('system.config.email_test'))).not.toContain(to);
    });

    it('a closed SMTP port → 422 SMTP_FAILED (reason connect), and the failure is audited with ok false', async () => {
      const sa = await client(superAdminId);
      const port = await closedPort();
      await sa.put(CONFIG_PATH, { smtp: { host: '127.0.0.1', port, security: 'none', from: 'perpus@perpus.test' } });
      const res = await sa.post(EMAIL_TEST, { to: 'staff@perpus.test' });
      expect(res.status).toBe(422);
      expect(res.json).toMatchObject({ code: 'SMTP_FAILED', reason: 'connect' });
      const entries = await audits('system.config.email_test');
      expect(entries).toHaveLength(1);
      expect(entries[0]!.meta).toEqual({ ok: false, reason: 'connect' });
    });

    it('the whole send has a deadline (20 s; 8 s a phase): a tarpit is cut off with the stage it was in, and audited', async () => {
      expect({ deadlineMs: EMAIL_TEST_DEADLINE_MS, timeoutMs: EMAIL_TEST_TIMEOUT_MS }).toEqual({ deadlineMs: 20_000, timeoutMs: 8_000 });
      // The same tarpit at a smaller scale: every reply 200 ms late (inside a 1 s phase), the whole send at most 700 ms.
      const tarpit = await startFakeSmtp({ replyDelayMs: () => 200 });
      try {
        const emailTestMailer = createSmtpMailer(() => loadSmtpConfig(h.db, FILE.keyring), { timeoutMs: 1000, deadlineMs: 700 });
        await appWith({ services: { emailTestMailer } });
        const sa = await client(superAdminId);
        await sa.put(CONFIG_PATH, { smtp: { host: '127.0.0.1', port: tarpit.port, security: 'none', from: 'perpus@perpus.test' } });
        const started = Date.now();
        const res = await sa.post(EMAIL_TEST, { to: 'staff@perpus.test' });
        expect(Date.now() - started).toBeLessThan(1150); // the session alone would take 1200 ms
        expect(res.status, res.text).toBe(422);
        expect(res.json).toMatchObject({ code: 'SMTP_FAILED', reason: 'send' });
        expect((await audits('system.config.email_test')).map((e) => e.meta)).toEqual([{ ok: false, reason: 'send' }]);
        expect(tarpit.messages).toEqual([]);
      } finally {
        await tarpit.close();
      }
    });

    it('no SMTP settings → 409 SMTP_NOT_CONFIGURED, audited with ok false', async () => {
      const sa = await client(superAdminId);
      const res = await sa.post(EMAIL_TEST, { to: 'staff@perpus.test' });
      expect({ status: res.status, code: code(res) }).toEqual({ status: 409, code: 'SMTP_NOT_CONFIGURED' });
      expect((await audits('system.config.email_test')).map((e) => e.meta)).toEqual([{ ok: false, reason: 'not_configured' }]);
    });

    it('`to` must be one address', async () => {
      const sa = await client(superAdminId);
      const res = await sa.post(EMAIL_TEST, { to: 'a@perpus.test, b@perpus.test' });
      expect(res.status).toBe(422);
      expect(errors(res)[0]?.path).toBe('to');
      expect(await audits('system.config.email_test')).toEqual([]);
    });
  });

  describe('POST system/cron-token/rotate', () => {
    it('answers a new 43-character token once; config.json holds it; the audit does not', async () => {
      const sa = await client(superAdminId);
      const res = await sa.post(ROTATE, {});
      expect(res.status, res.text).toBe(200);
      expect(res.headers.get('cache-control')).toBe('no-store');
      const token = (res.json as { cronToken: string }).cronToken;
      expect(token).toMatch(/^[A-Za-z0-9_-]{43}$/);
      expect(token).not.toBe(FILE.secrets.cronToken);
      expect((await fileConfig()).secrets.cronToken).toBe(token);
      const entries = await audits('system.config.cron_token_rotate');
      expect(entries).toHaveLength(1);
      expect(entries[0]).toMatchObject({ actor_type: 'staff', actor_id: superAdminId });
      expect(JSON.stringify(entries)).not.toContain(token);

      const again = await sa.post(ROTATE, {});
      expect((again.json as { cronToken: string }).cronToken).not.toBe(token);
    });
  });
});
