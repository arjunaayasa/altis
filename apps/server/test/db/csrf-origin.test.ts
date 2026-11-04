import fsp from 'node:fs/promises';
import os from 'node:os';
import path from 'node:path';
import { sha256hex, writeSettings } from '@altis/core';
import { decodeBase64Url } from '@altis/crypto';
import { PHASE1_MIGRATIONS, runMigrations, withTx } from '@altis/db';
import { newId } from '@altis/shared';
import { afterAll, beforeAll, beforeEach, describe, expect, it } from 'vitest';
import { engineLabel, testDb, testDbContext, type TestDbHandle } from '../../../../tools/test/test-db.js';
import { createApp } from '../../src/app.js';
import type { Config } from '../../src/config.js';
import { ensurePreSessionCsrf, preSessionCsrfToken, sessionCsrfToken } from '../../src/http/csrf.js';
import { defineRoutes, route, type RouteDecl } from '../../src/http/route.js';
import { createAgent, type Agent, type AgentReply } from '../agent.js';
import { recordingLogger, sampleConfig } from '../support.js';
import { seedStaff, sessionCookieFor } from '../support-auth.js';

// Steps 3, 6 and 8 of the chain (spec §4.7, §7.4, P15, decision D13) on the engine picked by ALTIS_TEST_DB:
// - step 3: the client IP from `[XFF…, peer]` and trustProxy.hops, with the persisted `system.ip_trust`;
// - step 6: a route's `ipLimits` buckets, counted per client IP, only while the IP can be trusted;
// - step 8: for non-GET cookie routes, Sec-Fetch-Site, then Origin (else Referer) against baseUrl/allowedOrigins,
//   then X-CSRF-Token: the session token with a session, else the pre-session double submit on `altis_csrf`.
// No CORS: nothing sets Access-Control-*, and OPTIONS is a 404.

const ctx = testDbContext();
let h: TestDbHandle;

/** Mid-hour, so that the hourly `forgot:ip` window never turns over during a test. */
const NOW = Date.UTC(2026, 9, 27, 10, 30, 0);
/** One config for every app and token of the file (sampleConfig() makes new secrets on every call). */
const CONFIG = sampleConfig();
const BASE = 'https://perpus.sekolah.sch.id';
const ALLOWED = 'https://www.sekolah.sch.id';

const ROUTES: RouteDecl[] = defineRoutes([
  route({
    id: 't.csrf.token',
    method: 'GET',
    path: '/api/v1/_t/csrf',
    public: true,
    idempotency: 'none',
    audit: null,
    handler: async (rc) => ({ body: { token: ensurePreSessionCsrf(rc.c) } }),
  }),
  route({
    id: 't.csrf.post',
    method: 'POST',
    path: '/api/v1/_t/csrf',
    public: true,
    idempotency: 'none',
    audit: null,
    handler: async () => ({ body: { ok: true } }),
  }),
  route({
    id: 't.csrf.delete',
    method: 'DELETE',
    path: '/api/v1/_t/csrf',
    public: true,
    idempotency: 'none',
    audit: null,
    handler: async () => ({}),
  }),
  route({
    id: 't.bearer',
    method: 'POST',
    path: '/api/v1/_t/bearer',
    public: true,
    auth: 'bearer',
    idempotency: 'none',
    audit: null,
    handler: async () => ({ body: { ok: true } }),
  }),
  route({
    id: 't.ip',
    method: 'GET',
    path: '/api/v1/_t/ip',
    public: true,
    idempotency: 'none',
    audit: null,
    handler: async (rc) => ({ body: { ip: rc.ip, ipTrust: rc.ipTrust, actorIp: rc.actor.ip } }),
  }),
  route({
    id: 't.forgot',
    method: 'POST',
    path: '/api/v1/_t/forgot',
    public: true,
    auth: 'bearer',
    tx: 'self',
    ipLimits: ['forgot:ip'],
    idempotency: 'none',
    audit: null,
    handler: async () => ({ body: { ok: true } }),
  }),
]);

function appWith(config: Config = CONFIG) {
  const app = createApp({ state: { phase: 'ready', db: h, config }, version: '0.1.0', buildId: 'b', log: recordingLogger(), routes: ROUTES, clock: () => NOW });
  return { app, agent: (peer?: string) => createAgent(app, peer === undefined ? {} : { peer }) };
}

const key = (config: Config = CONFIG): Uint8Array => decodeBase64Url(config.secrets.sessionKey)!;

/** A pre-session token: GET the token route (sets `altis_csrf` in the agent's jar) and return the token for it. */
async function preToken(agent: Agent): Promise<string> {
  const res = await agent.get('/api/v1/_t/csrf');
  expect(res.status).toBe(200);
  return (res.json as { token: string }).token;
}

function code(res: AgentReply): string | undefined {
  return (res.json as { code?: string } | undefined)?.code;
}

describe.skipIf(!ctx.available)(`CSRF, Origin and IP limits [${engineLabel()}]`, () => {
  let dataDir: string;
  let t: ReturnType<typeof appWith>;

  beforeAll(async () => {
    h = await testDb();
    dataDir = await fsp.mkdtemp(path.join(os.tmpdir(), 'altis-csrf-origin-'));
    await runMigrations(h, { appVersion: '0.1.0', dataDir, migrations: PHASE1_MIGRATIONS });
  });

  afterAll(async () => {
    await h?.close();
    if (dataDir !== undefined) await fsp.rm(dataDir, { recursive: true, force: true });
  });

  beforeEach(async () => {
    await h.db.deleteFrom('rate_limits').execute();
    await h.db.deleteFrom('sessions').execute();
    await h.db.deleteFrom('settings').execute();
    t = appWith();
  });

  describe('the CSRF token', () => {
    it('a POST without altis_csrf → 403 CSRF_INVALID', async () => {
      const res = await t.agent().post('/api/v1/_t/csrf', {});
      expect(res.status).toBe(403);
      expect(code(res)).toBe('CSRF_INVALID');
      const withHeader = await t.agent().post('/api/v1/_t/csrf', {}, { 'x-csrf-token': preSessionCsrfToken(key(), 'x'.repeat(43)) });
      expect(code(withHeader)).toBe('CSRF_INVALID');
    });

    it('pre-session double submit: the token of the altis_csrf cookie → 200; a token made for another cookie → 403', async () => {
      const agent = t.agent();
      const token = await preToken(agent);
      expect([...agent.cookies.keys()]).toEqual(['__Host-altis_csrf']);
      expect((await agent.post('/api/v1/_t/csrf', {}, { 'x-csrf-token': token })).status).toBe(200);
      expect((await agent.delete('/api/v1/_t/csrf', undefined, { 'x-csrf-token': token })).status).toBe(204);

      const other = await agent.post('/api/v1/_t/csrf', {}, { 'x-csrf-token': preSessionCsrfToken(key(), 'o'.repeat(43)) });
      expect(other.status).toBe(403);
      expect(code(other)).toBe('CSRF_INVALID');
      expect(code(await agent.post('/api/v1/_t/csrf', {}))).toBe('CSRF_INVALID');
    });

    it('a second GET keeps the same altis_csrf cookie and token', async () => {
      const agent = t.agent();
      const first = await preToken(agent);
      const cookie = agent.cookies.get('__Host-altis_csrf');
      expect(await preToken(agent)).toBe(first);
      expect(agent.cookies.get('__Host-altis_csrf')).toBe(cookie);
    });

    it('with a session: the session token → 200; the pre-session token → 403', async () => {
      const agent = t.agent();
      const pre = await preToken(agent);
      // Step 7 resolves only the session of an active staff user.
      const user = await seedStaff(h, { username: `csrf_${newId().slice(-8)}`, now: NOW });
      const token = await sessionCookieFor(h, user.id, { now: NOW });
      agent.setCookie('__Host-altis_sid', token);
      expect((await agent.post('/api/v1/_t/csrf', {}, { 'x-csrf-token': sessionCsrfToken(key(), sha256hex(token)) })).status).toBe(200);
      const res = await agent.post('/api/v1/_t/csrf', {}, { 'x-csrf-token': pre });
      expect(res.status).toBe(403);
      expect(code(res)).toBe('CSRF_INVALID');
    });

    it('a cookie of no live session counts as no session (the pre-session token applies)', async () => {
      const agent = t.agent();
      const pre = await preToken(agent);
      agent.setCookie('__Host-altis_sid', 's'.repeat(43));
      expect((await agent.post('/api/v1/_t/csrf', {}, { 'x-csrf-token': pre })).status).toBe(200);
    });

    it('GET is never checked; a Bearer route needs no token and is not Origin-checked (§7.4)', async () => {
      const hostile = { origin: 'https://evil.example', 'sec-fetch-site': 'cross-site' };
      expect((await t.agent().get('/api/v1/_t/ip', undefined, hostile)).status).toBe(200);
      expect((await t.agent().post('/api/v1/_t/bearer', {}, { origin: 'https://evil.example' })).status).toBe(200);
      expect((await t.agent().post('/api/v1/_t/bearer', {}, hostile)).status).toBe(200);
    });
  });

  describe('Origin, Referer and Sec-Fetch-Site', () => {
    async function post(headers: Record<string, string>): Promise<AgentReply> {
      const agent = t.agent();
      const token = await preToken(agent);
      return agent.post('/api/v1/_t/csrf', {}, { 'x-csrf-token': token, ...headers });
    }

    it('Origin: a foreign one → 403 ORIGIN_DENIED; the baseUrl origin or an allowedOrigins entry → 200', async () => {
      const evil = await post({ origin: 'https://evil.example' });
      expect(evil.status).toBe(403);
      expect(code(evil)).toBe('ORIGIN_DENIED');
      expect((await post({ origin: BASE })).status).toBe(200);
      expect((await post({ origin: ALLOWED })).status).toBe(200);
      for (const origin of ['null', 'http://perpus.sekolah.sch.id', 'https://perpus.sekolah.sch.id:8443', 'https://sekolah.sch.id']) {
        expect(code(await post({ origin })), origin).toBe('ORIGIN_DENIED');
      }
    });

    it('no Origin: a foreign Referer → 403; the baseUrl Referer → 200; neither header → 200', async () => {
      expect(code(await post({ referer: 'https://evil.example/x' }))).toBe('ORIGIN_DENIED');
      expect(code(await post({ referer: 'not a url' }))).toBe('ORIGIN_DENIED');
      expect((await post({ referer: `${BASE}/admin/users?x=1` })).status).toBe(200);
      expect((await post({})).status).toBe(200);
      // Origin wins over Referer.
      expect((await post({ origin: BASE, referer: 'https://evil.example/x' })).status).toBe(200);
    });

    it('Sec-Fetch-Site: cross-site → 403; same-site → 403; none → 200; same-origin → 200', async () => {
      expect(code(await post({ 'sec-fetch-site': 'cross-site' }))).toBe('ORIGIN_DENIED');
      expect(code(await post({ 'sec-fetch-site': 'same-site' }))).toBe('ORIGIN_DENIED');
      expect((await post({ 'sec-fetch-site': 'none' })).status).toBe(200);
      expect((await post({ 'sec-fetch-site': 'same-origin' })).status).toBe(200);
    });

    it('the Origin check comes before the token check', async () => {
      const res = await t.agent().post('/api/v1/_t/csrf', {}, { origin: 'https://evil.example' });
      expect(code(res)).toBe('ORIGIN_DENIED');
    });
  });

  describe('no CORS', () => {
    it('no response carries Access-Control-Allow-Origin; OPTIONS /api/v1/auth/login → 404', async () => {
      const agent = t.agent();
      const replies = [
        await agent.get('/api/v1/_t/csrf', undefined, { origin: 'https://evil.example' }),
        await agent.post('/api/v1/_t/csrf', {}, { origin: 'https://evil.example' }),
        await agent.post('/api/v1/_t/bearer', {}, { origin: 'https://evil.example' }),
      ];
      const preflight = await t.app.request('/api/v1/auth/login', {
        method: 'OPTIONS',
        headers: { origin: 'https://evil.example', 'access-control-request-method': 'POST' },
      });
      expect(preflight.status).toBe(404);
      expect(((await preflight.json()) as { code: string }).code).toBe('NOT_FOUND');
      const optionsDeclared = await t.app.request('/api/v1/_t/csrf', { method: 'OPTIONS', headers: { origin: BASE } });
      expect(optionsDeclared.status).toBe(404);
      for (const headers of [...replies.map((r) => r.headers), preflight.headers, optionsDeclared.headers]) {
        for (const name of headers.keys()) expect(name.startsWith('access-control-')).toBe(false);
      }
    });
  });

  describe('client IP (step 3) and IP limits (step 6)', () => {
    it('the client IP is the hops-th entry from the right (hops 1); a local proxy with hops 0 is collapsed', async () => {
      const behindProxy = t.agent('127.0.0.1');
      expect((await behindProxy.get('/api/v1/_t/ip', undefined, { 'x-forwarded-for': '6.6.6.6, 198.51.100.7' })).json).toEqual({
        ip: '198.51.100.7',
        ipTrust: 'ok',
        actorIp: '198.51.100.7',
      });
      const flat = appWith({ ...CONFIG, trustProxy: { hops: 0 } });
      expect((await flat.agent('127.0.0.1').get('/api/v1/_t/ip', undefined, { 'x-forwarded-for': '198.51.100.7' })).json).toEqual({
        ip: '127.0.0.1',
        ipTrust: 'collapsed',
        actorIp: '127.0.0.1',
      });
    });

    it('the persisted system.ip_trust applies when the request itself is not collapsed', async () => {
      await withTx(h, (trx) => writeSettings(trx, { 'system.ip_trust': 'spoofable' }, { keyring: [], now: NOW, actorId: null }));
      const res = await appWith().agent('203.0.113.9').get('/api/v1/_t/ip');
      expect(res.json).toEqual({ ip: '203.0.113.9', ipTrust: 'spoofable', actorIp: '203.0.113.9' });
    });

    it("ipLimits ['forgot:ip']: 10 POSTs from 203.0.113.9 pass, the 11th → 429 with Retry-After; another IP is not limited", async () => {
      const agent = t.agent('203.0.113.9');
      for (let i = 0; i < 10; i += 1) expect((await agent.post('/api/v1/_t/forgot', {})).status, `POST ${i + 1}`).toBe(200);
      const refused = await agent.post('/api/v1/_t/forgot', {});
      expect(refused.status).toBe(429);
      expect(code(refused)).toBe('AUTH_TOO_MANY_ATTEMPTS');
      expect(Number(refused.headers.get('retry-after'))).toBe(30 * 60);
      expect((await t.agent('203.0.113.10').post('/api/v1/_t/forgot', {})).status).toBe(200);
    });

    it('from a collapsed IP the per-IP buckets are skipped: never limited, nothing counted', async () => {
      const flat = appWith({ ...CONFIG, trustProxy: { hops: 0 } });
      const agent = flat.agent('127.0.0.1');
      for (let i = 0; i < 15; i += 1) {
        expect((await agent.post('/api/v1/_t/forgot', {}, { 'x-forwarded-for': '198.51.100.7' })).status, `POST ${i + 1}`).toBe(200);
      }
      expect(await h.db.selectFrom('rate_limits').selectAll().execute()).toEqual([]);
    });

    it('garbage left of the trusted hops (client-written) is ignored: the IP stays trusted and the per-IP buckets apply', async () => {
      const agent = t.agent('127.0.0.1');
      expect((await agent.get('/api/v1/_t/ip', undefined, { 'x-forwarded-for': 'garbage, 198.51.100.7' })).json).toEqual({
        ip: '198.51.100.7',
        ipTrust: 'ok',
        actorIp: '198.51.100.7',
      });
      // A client that changes its own garbage on every request is still counted as the one IP the proxy appended.
      for (let i = 0; i < 10; i += 1) {
        const res = await agent.post('/api/v1/_t/forgot', {}, { 'x-forwarded-for': `garbage-${i}, , 198.51.100.7` });
        expect(res.status, `POST ${i + 1}`).toBe(200);
      }
      const refused = await agent.post('/api/v1/_t/forgot', {}, { 'x-forwarded-for': 'not-an-ip, 198.51.100.7' });
      expect(refused.status).toBe(429);
      expect(code(refused)).toBe('AUTH_TOO_MANY_ATTEMPTS');
    });

    it('garbage in the trusted part (the entry the proxy appended) still collapses: never limited, nothing counted', async () => {
      const agent = t.agent('127.0.0.1');
      expect((await agent.get('/api/v1/_t/ip', undefined, { 'x-forwarded-for': '198.51.100.7, garbage' })).json).toEqual({
        ip: '127.0.0.1',
        ipTrust: 'collapsed',
        actorIp: '127.0.0.1',
      });
      for (let i = 0; i < 12; i += 1) {
        expect((await agent.post('/api/v1/_t/forgot', {}, { 'x-forwarded-for': '198.51.100.7, garbage' })).status, `POST ${i + 1}`).toBe(200);
      }
      expect(await h.db.selectFrom('rate_limits').selectAll().execute()).toEqual([]);
    });

    it('with a persisted trust other than ok the per-IP buckets are skipped too (D13)', async () => {
      await withTx(h, (trx) => writeSettings(trx, { 'system.ip_trust': 'spoofable' }, { keyring: [], now: NOW, actorId: null }));
      const agent = appWith().agent('203.0.113.9');
      for (let i = 0; i < 12; i += 1) expect((await agent.post('/api/v1/_t/forgot', {})).status, `POST ${i + 1}`).toBe(200);
      expect(await h.db.selectFrom('rate_limits').selectAll().execute()).toEqual([]);
    });
  });
});
