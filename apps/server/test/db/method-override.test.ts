import { createHash } from 'node:crypto';
import fsp from 'node:fs/promises';
import os from 'node:os';
import path from 'node:path';
import { createSettingsCache, writeSettings } from '@altis/core';
import { PHASE1_MIGRATIONS, runMigrations, withTx } from '@altis/db';
import type { Runtime } from '@altis/platform';
import type { MeResponse } from '@altis/shared/api/auth';
import { afterAll, beforeAll, beforeEach, describe, expect, it } from 'vitest';
import { z } from 'zod';
import { engineLabel, testDb, testDbContext, type TestDbHandle } from '../../../../tools/test/test-db.js';
import { createApp } from '../../src/app.js';
import { defineRoutes, route, type RouteDecl } from '../../src/http/route.js';
import { createAgent, type AgentReply } from '../agent.js';
import { recordingLogger, sampleConfig } from '../support.js';
import { seedStaff, sessionCookieFor, sessionCsrfFor } from '../support-auth.js';

// Method override (spec §5 P10, decision C37, preflight M27; Task 16) on the engine picked by ALTIS_TEST_DB. A WAF
// that blocks PUT/PATCH/DELETE leaves the admin `POST` + `X-HTTP-Method-Override`: the request is dispatched again
// with the named method through the whole chain, so it needs a session and passes CSRF/Origin exactly as the real
// method would. Bearer routes, `session: 'none'` routes and the probe routes (which test the real methods) refuse it.
// `GET auth/me` hands the SPA its client hints: SSE or polling, whether to override, the chunk size to start with.

const ctx = testDbContext();
let h: TestDbHandle;

const NOW = Date.UTC(2026, 9, 28, 9, 0, 5);
const CONFIG = sampleConfig();
const SID = '__Host-altis_sid';
const OVERRIDE = 'x-http-method-override';
const MIB = 1024 * 1024;

const Named = z.strictObject({ name: z.string().max(50) });

/** What a test route saw: the method it ran under, its body, its session's user. */
const echo = async (rc: { c: { req: { method: string } }; body: unknown; auth: { subjectId: string } | null }) => ({
  body: { method: rc.c.req.method, body: rc.body ?? null, user: rc.auth?.subjectId ?? null },
});

const ROUTES: RouteDecl[] = defineRoutes([
  route({ id: 't.put', method: 'PUT', path: '/api/v1/_t/thing', public: true, idempotency: 'none', audit: null, body: Named, handler: echo }),
  route({ id: 't.patch', method: 'PATCH', path: '/api/v1/_t/thing', public: true, idempotency: 'none', audit: null, handler: echo }),
  route({ id: 't.delete', method: 'DELETE', path: '/api/v1/_t/thing', public: true, idempotency: 'none', audit: null, handler: echo }),
  route({ id: 't.post', method: 'POST', path: '/api/v1/_t/thing', public: true, idempotency: 'none', audit: null, handler: echo }),
  route({ id: 't.get', method: 'GET', path: '/api/v1/_t/thing', public: true, idempotency: 'none', audit: null, handler: echo }),
  route({
    id: 't.bearer.put',
    method: 'PUT',
    path: '/api/v1/_t/bearer',
    public: true,
    auth: 'bearer',
    idempotency: 'none',
    audit: null,
    handler: echo,
  }),
  // The id of the real probe route (Task 23): overriding it would hide the very WAF it tests for.
  route({
    id: 'diagnostics.probe.methods.put',
    method: 'PUT',
    path: '/api/v1/diagnostics/probe/methods',
    permission: 'system.diagnostics.read',
    mode: 'system',
    idempotency: 'none',
    audit: null,
    handler: echo,
  }),
]);

const code = (res: AgentReply): string | undefined => (res.json as { code?: string } | undefined)?.code;
const traceId = (res: AgentReply): string | undefined => (res.json as { traceId?: string } | undefined)?.traceId;

describe.skipIf(!ctx.available)(`method override [${engineLabel()}]`, () => {
  let dataDir: string;
  let app: ReturnType<typeof createApp>;
  let userId: string;
  let token: string;
  /** Holds system.diagnostics.read. */
  let diagToken: string;

  beforeAll(async () => {
    h = await testDb();
    dataDir = await fsp.mkdtemp(path.join(os.tmpdir(), 'altis-method-override-'));
    await runMigrations(h, { appVersion: '0.1.0', dataDir, migrations: PHASE1_MIGRATIONS });
    app = createApp({
      state: { phase: 'ready', db: h, config: CONFIG, baseUrl: CONFIG.baseUrl },
      version: '0.1.0',
      buildId: 'b',
      log: recordingLogger(),
      routes: ROUTES,
      clock: () => NOW,
    });
    const user = await seedStaff(h, { username: 'override-user', now: NOW });
    userId = user.id;
    token = await sessionCookieFor(h, user.id, { now: NOW });
    const diag = await seedStaff(h, { username: 'override-diag', now: NOW, roles: [{ permissions: ['system.diagnostics.read'] }] });
    diagToken = await sessionCookieFor(h, diag.id, { now: NOW });
  });

  afterAll(async () => {
    await h?.close();
    if (dataDir !== undefined) await fsp.rm(dataDir, { recursive: true, force: true });
  });

  /** A browser of the user signed in with `sid` (or of nobody), sending its CSRF token unless told not to. */
  function browser(sid: string | null, o: { csrf?: boolean } = {}) {
    const agent = createAgent(app, { headers: { origin: CONFIG.baseUrl } });
    if (sid !== null) agent.setCookie(SID, sid);
    const csrf: Record<string, string> = sid !== null && o.csrf !== false ? { 'x-csrf-token': sessionCsrfFor(CONFIG, sid) } : {};
    return {
      post: (p: string, body: unknown, headers: Record<string, string> = {}) => agent.post(p, body, { ...csrf, ...headers }),
      put: (p: string, body: unknown, headers: Record<string, string> = {}) => agent.put(p, body, { ...csrf, ...headers }),
    };
  }

  describe('dispatch', () => {
    it('POST + override PUT, with a session and its X-CSRF-Token → 200; the handler runs as PUT with the body', async () => {
      const res = await browser(token).post('/api/v1/_t/thing', { name: 'Ani' }, { [OVERRIDE]: 'PUT' });
      expect(res.status, res.text).toBe(200);
      expect(res.json).toEqual({ method: 'PUT', body: { name: 'Ani' }, user: userId });
      expect(res.headers.get('x-request-id')).toMatch(/^[0-9A-HJKMNP-TV-Z]{26}$/);
      expect(res.headers.get('x-altis-build')).toBe('b');
      expect(res.headers.get('x-content-type-options')).toBe('nosniff');
    });

    it('the value is read in any case: patch → PATCH, Delete → DELETE', async () => {
      const patch = await browser(token).post('/api/v1/_t/thing', {}, { [OVERRIDE]: 'patch' });
      expect(patch.status, patch.text).toBe(200);
      expect((patch.json as { method: string }).method).toBe('PATCH');
      const del = await browser(token).post('/api/v1/_t/thing', undefined, { [OVERRIDE]: 'Delete' });
      expect(del.status, del.text).toBe(200);
      expect((del.json as { method: string }).method).toBe('DELETE');
    });

    it('a POST without the header is a POST', async () => {
      const res = await browser(token).post('/api/v1/_t/thing', {});
      expect(res.status).toBe(200);
      expect((res.json as { method: string }).method).toBe('POST');
    });

    it('an overridden request that fails inside the chain names one request id: X-Request-Id = the problem traceId', async () => {
      const res = await browser(token).post('/api/v1/_t/thing', { name: 'x'.repeat(51) }, { [OVERRIDE]: 'PUT' });
      expect(res.status).toBe(422);
      expect(code(res)).toBe('VALIDATION_FAILED');
      expect(traceId(res)).toBe(res.headers.get('x-request-id'));
    });
  });

  describe('refusals', () => {
    it('without a session → 403 METHOD_OVERRIDE_DENIED (the real PUT of a public route would pass)', async () => {
      const res = await browser(null).post('/api/v1/_t/thing', { name: 'Ani' }, { [OVERRIDE]: 'PUT' });
      expect(res.status).toBe(403);
      expect(code(res)).toBe('METHOD_OVERRIDE_DENIED');
      expect(traceId(res)).toBe(res.headers.get('x-request-id'));
    });

    it('with a session but without its X-CSRF-Token → 403 CSRF_INVALID (step 8 as for any write)', async () => {
      const res = await browser(token, { csrf: false }).post('/api/v1/_t/thing', { name: 'Ani' }, { [OVERRIDE]: 'PUT' });
      expect(res.status).toBe(403);
      expect(code(res)).toBe('CSRF_INVALID');
    });

    it('with a session from another origin → 403 ORIGIN_DENIED', async () => {
      const res = await browser(token).post('/api/v1/_t/thing', { name: 'Ani' }, { [OVERRIDE]: 'PUT', origin: 'https://evil.example' });
      expect(res.status).toBe(403);
      expect(code(res)).toBe('ORIGIN_DENIED');
    });

    it.each(['GET', 'POST', 'HEAD', 'OPTIONS', 'TRACE', 'PUTX', ''])(
      'override %j → 403 METHOD_OVERRIDE_DENIED with X-Request-Id and the security headers',
      async (value) => {
        const res = await browser(token).post('/api/v1/_t/thing', { name: 'Ani' }, { [OVERRIDE]: value });
        expect(res.status).toBe(403);
        expect(code(res)).toBe('METHOD_OVERRIDE_DENIED');
        expect(res.headers.get('content-type')).toMatch(/^application\/problem\+json/);
        expect(res.headers.get('x-request-id')).toMatch(/^[0-9A-HJKMNP-TV-Z]{26}$/);
        expect(traceId(res)).toBe(res.headers.get('x-request-id'));
        expect(res.headers.get('x-content-type-options')).toBe('nosniff');
        expect(res.headers.get('referrer-policy')).toBe('same-origin');
        expect(res.headers.get('strict-transport-security')).not.toBeNull();
      },
    );

    it('a Bearer route with override → 403 METHOD_OVERRIDE_DENIED, session or not', async () => {
      for (const sid of [token, null]) {
        const res = await browser(sid).post('/api/v1/_t/bearer', {}, { [OVERRIDE]: 'PUT', authorization: 'Bearer x' });
        expect(res.status).toBe(403);
        expect(code(res)).toBe('METHOD_OVERRIDE_DENIED');
      }
    });

    it('diagnostics.probe.methods.put overridden → 403 METHOD_OVERRIDE_DENIED; the real PUT → 200', async () => {
      const overridden = await browser(diagToken).post('/api/v1/diagnostics/probe/methods', {}, { [OVERRIDE]: 'PUT' });
      expect(overridden.status).toBe(403);
      expect(code(overridden)).toBe('METHOD_OVERRIDE_DENIED');
      const real = await browser(diagToken).put('/api/v1/diagnostics/probe/methods', {});
      expect(real.status, real.text).toBe(200);
      expect((real.json as { method: string }).method).toBe('PUT');
    });

    it('a real PUT that carries the header counts as overridden: it needs a session too', async () => {
      const res = await browser(null).put('/api/v1/_t/thing', { name: 'Ani' }, { [OVERRIDE]: 'PUT' });
      expect(res.status).toBe(403);
      expect(code(res)).toBe('METHOD_OVERRIDE_DENIED');
    });
  });

  describe('through the real routes', () => {
    function realApp(runtime: Runtime) {
      return createApp({
        state: { phase: 'ready', db: h, config: CONFIG },
        version: '0.1.0',
        buildId: 'b',
        log: recordingLogger(),
        clock: () => NOW,
        dataDir,
        runtime,
        services: { settings: createSettingsCache({ ttlMs: 0 }) },
      });
    }

    function realBrowser(runtime: Runtime, sid: string) {
      const agent = createAgent(realApp(runtime), { headers: { origin: CONFIG.baseUrl, 'x-csrf-token': sessionCsrfFor(CONFIG, sid) } });
      agent.setCookie(SID, sid);
      return agent;
    }

    async function setProbe(probe: Record<string, unknown> | null, sse: boolean | null = null): Promise<void> {
      await withTx(h, (trx) =>
        writeSettings(trx, { 'system.probe': probe, 'realtime.sse': sse }, { keyring: CONFIG.keyring, now: NOW, actorId: null }),
      );
    }

    const probe = (o: { put?: boolean; chunkBytes?: number | null } = {}) => ({
      at: NOW,
      polling: true,
      sse: true,
      methods: { put: o.put ?? true, patch: true, delete: true },
      chunkBytes: o.chunkBytes === undefined ? null : o.chunkBytes,
      xff: { spoofable: false, suggestedHops: 1 },
    });

    async function client(runtime: Runtime, sid = token): Promise<unknown> {
      const me = await realBrowser(runtime, sid).get('/api/v1/auth/me');
      expect(me.status, me.text).toBe(200);
      return (me.json as Extract<MeResponse, { authenticated: true }>).client;
    }

    beforeEach(async () => {
      await setProbe(null);
    });

    it('PATCH auth/me sent as POST + override: the profile changes, audited once', async () => {
      const res = await realBrowser('pm2', token).post('/api/v1/auth/me', { name: 'Ani Lestari' }, { [OVERRIDE]: 'PATCH' });
      expect(res.status, res.text).toBe(200);
      expect((res.json as { name: string }).name).toBe('Ani Lestari');
      const audits = await h.db.selectFrom('audit_log').select('action').where('entity_id', '=', userId).where('action', '=', 'auth.profile.update').execute();
      expect(audits).toHaveLength(1);
    });

    it('DELETE files/uploads/:id sent as POST + override cancels the upload', async () => {
      const agent = realBrowser('pm2', token);
      const data = new Uint8Array(1000).fill(7);
      const sha256 = createHash('sha256').update(data).digest('hex');
      const created = await agent.post('/api/v1/files/uploads', { context: 'test', size: data.byteLength, sha256 });
      expect(created.status, created.text).toBe(201);
      const id = (created.json as { id: string }).id;
      const res = await agent.post(`/api/v1/files/uploads/${id}`, undefined, { [OVERRIDE]: 'DELETE' });
      expect(res.status, res.text).toBe(204);
      expect(await h.db.selectFrom('upload_sessions').select('id').where('id', '=', id).executeTakeFirst()).toBeUndefined();
    });

    it('GET auth/me without a probe: no override, 5 MiB chunks, probedAt null; SSE on pm2, polling on passenger (realtime.sse null)', async () => {
      expect(await client('pm2')).toEqual({ realtime: 'sse', methodOverride: false, chunkBytes: 5 * MIB, probedAt: null, runner: 'worker' });
      expect(await client('passenger')).toEqual({ realtime: 'polling', methodOverride: false, chunkBytes: 5 * MIB, probedAt: null, runner: 'external' });
    });

    it('GET auth/me with system.probe.methods.put false and chunkBytes 1048576 → methodOverride true, chunkBytes 1048576, probedAt = the probe\'s at', async () => {
      await setProbe(probe({ put: false, chunkBytes: 1048576 }));
      expect(await client('passenger')).toEqual({ realtime: 'polling', methodOverride: true, chunkBytes: 1048576, probedAt: NOW, runner: 'external' });
      await setProbe(probe({ put: true, chunkBytes: null }));
      expect(await client('pm2')).toEqual({ realtime: 'sse', methodOverride: false, chunkBytes: 5 * MIB, probedAt: NOW, runner: 'worker' });
    });

    // 1d T31-RUNNER-MODE-FOR-ALL-STAFF: every staff user learns how this host runs its jobs (a job's page offers
    // "Jalankan sekarang" only where no worker is always on), with or without system.jobs.read.
    it('GET auth/me: client.runner is external on passenger and litespeed, worker on pm2 and standalone, for a user without system.jobs.read', async () => {
      const runner = async (runtime: Runtime): Promise<unknown> => ((await client(runtime, diagToken)) as { runner: string }).runner;
      expect(await runner('passenger')).toBe('external');
      expect(await runner('litespeed')).toBe('external');
      expect(await runner('pm2')).toBe('worker');
      expect(await runner('standalone')).toBe('worker');
    });

    it('realtime.sse decides when set: true → sse on passenger, false → polling on pm2', async () => {
      await setProbe(null, true);
      expect(((await client('passenger')) as { realtime: string }).realtime).toBe('sse');
      await setProbe(null, false);
      expect(((await client('pm2')) as { realtime: string }).realtime).toBe('polling');
    });

    it('a pre-2FA session gets no client hints (stage full only); an anonymous auth/me neither', async () => {
      const pending = await seedStaff(h, { username: 'override-mfa', now: NOW, totp: true });
      const sid = await sessionCookieFor(h, pending.id, { now: NOW, mfaPassed: false });
      const me = await realBrowser('pm2', sid).get('/api/v1/auth/me');
      expect((me.json as { stage: string }).stage).toBe('mfa');
      expect(me.json).not.toHaveProperty('client');
      const anonymous = await createAgent(realApp('pm2')).get('/api/v1/auth/me');
      expect(anonymous.json).not.toHaveProperty('client');
    });
  });
});
