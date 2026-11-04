import type { AuditAction, Permission } from '@altis/shared';
import { Hono } from 'hono';
import { describe, expect, it } from 'vitest';
import { z } from 'zod';
import { createApp, type AppEnv } from '../src/app.js';
import { HEALTH_PATH } from '../src/http/health.js';
import { assertAllRoutesDeclared, declareMiddleware, defineRoutes, mountRoutes, type RouteDecl } from '../src/http/route.js';
import { ALL_ROUTES } from '../src/routes.js';
import { createServices } from '../src/services.js';
import { recordingLogger } from './support.js';

// The route-declaration contract (spec §4.6): every route the app serves is a RouteDecl, an incomplete or
// contradictory declaration fails startup (defineRoutes), and a Hono route without a declaration fails startup too
// (assertAllRoutesDeclared, called last by createApp).

/** A valid declaration: a permission route, POST, no idempotency store; `over` replaces keys (undefined removes). */
function decl(over: Partial<Record<keyof RouteDecl, unknown>> = {}): RouteDecl {
  const base: Record<string, unknown> = {
    id: 'fixture',
    method: 'POST',
    path: '/api/v1/fixture',
    permission: 'system.users.manage',
    idempotency: 'none',
    audit: 'users.update',
    handler: async () => ({ body: {} }),
  };
  for (const [k, v] of Object.entries(over)) {
    if (v === undefined) delete base[k];
    else base[k] = v;
  }
  return base as unknown as RouteDecl;
}

/** A public GET page declaration (`session: 'none'`), the shape of /_health. */
function page(over: Partial<Record<keyof RouteDecl, unknown>> = {}): RouteDecl {
  return decl({ id: 'page', method: 'GET', path: '/page', permission: undefined, public: true, session: 'none', audit: null, ...over });
}

function reasonOf(decls: RouteDecl[]): string {
  try {
    defineRoutes(decls);
  } catch (error) {
    return (error as Error).message;
  }
  return 'accepted';
}

describe('defineRoutes', () => {
  it('returns its input for valid declarations', () => {
    const decls = [
      decl(),
      page(),
      decl({ id: 'pub', path: '/api/v1/pub', permission: undefined, public: true, audit: null }),
      decl({ id: 'pub.s', path: '/api/v1/pubs', permission: undefined, public: true, session: 'required', idempotency: 'store' }),
      decl({ id: 'ops', path: '/api/v1/ops', permission: undefined, opsAuth: true }),
      decl({ id: 'self', path: '/api/v1/self', tx: 'self' }),
      decl({ id: 'store', path: '/api/v1/store', idempotency: 'store', tx: 'handler' }),
      decl({ id: 'get', method: 'GET', path: '/api/v1/fixture', audit: null, query: z.strictObject({ n: z.coerce.number() }) }),
      decl({ id: 'download', method: 'GET', path: '/api/v1/download', audit: null, sideEffects: true }),
      decl({ id: 'byid', method: 'PATCH', path: '/api/v1/fixture/:id', params: z.strictObject({ id: z.string() }), body: z.strictObject({ a: z.string() }) }),
      decl({ id: 'branch', path: '/api/v1/b/:branchId', permission: 'test.branch.manage', branchParam: 'branchId', reauth: true }),
      decl({
        id: 'nested',
        path: '/api/v1/nested',
        body: z.strictObject({
          a: z.strictObject({ b: z.string() }).optional(),
          list: z.array(z.strictObject({ c: z.number() }).nullable()).default([]),
          pick: z.discriminatedUnion('k', [z.strictObject({ k: z.literal('x') }), z.strictObject({ k: z.literal('y') })]),
          map: z.record(z.string(), z.strictObject({ d: z.boolean() })),
          tree: z.lazy(() => z.strictObject({ e: z.string() })),
        }),
      }),
      decl({ id: 'auth.x', path: '/api/v1/auth/x', permission: undefined, public: true, partialAuth: true, audit: null }),
      decl({ id: 'also', path: '/api/v1/also', audit: null, alsoAudits: ['auth.2fa.disable'] }),
      decl({ id: 'also.2', path: '/api/v1/also2', alsoAudits: ['auth.2fa.disable', 'users.disable'] }),
      // Wizard routes (1c Task 10, decision C19): `session: 'none'`, and then a non-GET route is allowed.
      page({ id: 'inst.page', path: '/install', install: 'page' }),
      page({ id: 'inst.claim', method: 'POST', path: '/install/api/claim', install: 'claim', tx: 'self' }),
      page({ id: 'inst.get', path: '/install/api/checks', install: 'claimed' }),
      page({ id: 'inst.post', method: 'POST', path: '/install/api/x/:id', install: 'claimed', audit: 'install.complete' }),
      // 1c Task 8: a GET route a page calls on its own never touches the session.
      decl({ id: 'bg', method: 'GET', path: '/api/v1/bg', permission: undefined, public: true, session: 'required', audit: null, background: true }),
    ];
    expect(defineRoutes(decls)).toBe(decls);
  });

  it('ALL_ROUTES is valid and starts with the /_health declaration', () => {
    expect(defineRoutes(ALL_ROUTES)).toBe(ALL_ROUTES);
    expect(ALL_ROUTES[0]).toMatchObject({
      id: 'health',
      method: 'GET',
      path: HEALTH_PATH,
      public: true,
      session: 'none',
      maintenance: 'restore-allow', // 1c Task 15: answered during a restore too (503 `maintenance`)
      idempotency: 'none',
      audit: null,
    });
  });

  it.each<[string, RouteDecl[]]>([
    ['access', [decl({ permission: undefined })]],
    ['access', [decl({ public: true })]],
    ['access', [decl({ opsAuth: true })]],
    ['access', [decl({ permission: undefined, public: true, opsAuth: true })]],
    ['access', [decl({ permission: undefined, public: false })]],
    ['session_without_public', [decl({ session: 'required' })]],
    ['session_without_public', [decl({ permission: undefined, opsAuth: true, session: 'optional' })]],
    ['unknown_permission', [decl({ permission: 'system.nope.manage' as Permission })]],
    ['unknown_audit', [decl({ audit: 'users.explode' as AuditAction })]],
    ['unknown_audit', [decl({ alsoAudits: ['users.explode'] })]],
    ['invalid_value', [decl({ alsoAudits: 'auth.2fa.disable' })]],
    ['invalid_value', [decl({ alsoAudits: [] })]],
    // Never the route's own action (exactly one entry of it) nor a security event (always allowed), never twice.
    ['also_audits_overlap', [decl({ alsoAudits: ['users.update'] })]],
    ['also_audits_overlap', [decl({ alsoAudits: ['auth.login.failed'] })]],
    ['also_audits_overlap', [decl({ alsoAudits: ['auth.2fa.disable', 'auth.2fa.disable'] })]],
    ['session_none_conflict', [page({ partialAuth: true })]],
    ['session_none_conflict', [page({ reauth: true })]],
    ['session_none_conflict', [page({ idempotency: 'store' })]],
    ['session_none_conflict', [page({ method: 'POST' })]],
    ['reauth_partial', [decl({ reauth: true, partialAuth: true })]],
    ['get_with_body', [decl({ method: 'GET', audit: null, body: z.strictObject({}) })]],
    ['get_idempotency', [decl({ method: 'GET', audit: null, idempotency: 'store' })]],
    ['tx_on_get', [decl({ method: 'GET', audit: null, tx: 'handler' })]],
    ['tx_on_get', [decl({ method: 'GET', audit: null, tx: 'self' })]],
    ['body_not_strict', [decl({ body: z.object({ a: z.string() }) })]],
    ['body_not_strict', [decl({ body: z.looseObject({ a: z.string() }) })]],
    ['body_not_strict', [decl({ body: z.string() })]],
    ['body_not_strict', [decl({ body: z.strictObject({ a: z.string() }).transform((v) => v) })]],
    ['query_not_strict', [decl({ query: z.object({ n: z.coerce.number() }) })]],
    ['params_not_strict', [decl({ path: '/api/v1/fixture/:id', params: z.object({ id: z.string() }) })]],
    // Strictness is recursive: every object nested in the schema must be strict too.
    ['body_not_strict', [decl({ body: z.strictObject({ a: z.object({ b: z.string() }) }) })]],
    ['body_not_strict', [decl({ body: z.strictObject({ a: z.object({ b: z.string() }).optional() }) })]],
    ['body_not_strict', [decl({ body: z.strictObject({ a: z.looseObject({}).nullable() }) })]],
    ['body_not_strict', [decl({ body: z.strictObject({ a: z.object({}).nullish() }) })]],
    ['body_not_strict', [decl({ body: z.strictObject({ a: z.array(z.object({ b: z.string() })) }) })]],
    ['body_not_strict', [decl({ body: z.strictObject({ a: z.object({}).default({}) }) })]],
    ['body_not_strict', [decl({ body: z.strictObject({ a: z.union([z.string(), z.object({ b: z.string() })]) }) })]],
    ['body_not_strict', [decl({ body: z.strictObject({ a: z.discriminatedUnion('k', [z.strictObject({ k: z.literal('x') }), z.object({ k: z.literal('y') })]) }) })]],
    ['body_not_strict', [decl({ body: z.strictObject({ a: z.record(z.string(), z.object({ b: z.string() })) }) })]],
    ['body_not_strict', [decl({ body: z.strictObject({ a: z.strictObject({ b: z.array(z.object({}).optional()) }) }) })]],
    ['body_not_strict', [decl({ body: z.strictObject({ a: z.object({}).catchall(z.string()) }) })]],
    ['body_not_strict', [decl({ body: z.strictObject({ a: z.object({}).readonly() }) })]],
    ['body_not_strict', [decl({ body: z.strictObject({ a: z.object({}).catch({}) }) })]],
    ['body_not_strict', [decl({ body: z.strictObject({ a: z.tuple([z.string()], z.object({})) }) })]],
    ['body_not_strict', [decl({ body: z.strictObject({ a: z.intersection(z.strictObject({}), z.object({})) }) })]],
    ['body_not_strict', [decl({ body: z.strictObject({ a: z.unknown().pipe(z.object({})) }) })]],
    ['body_not_strict', [decl({ body: z.strictObject({ a: z.lazy(() => z.object({})) }) })]],
    ['query_not_strict', [decl({ query: z.strictObject({ n: z.object({ m: z.string() }).optional() }) })]],
    ['params_not_strict', [decl({ path: '/api/v1/fixture/:id', params: z.strictObject({ id: z.union([z.string(), z.object({})]) }) })]],
    ['branch_param_missing', [decl({ path: '/api/v1/b/:branchId', permission: 'test.branch.manage' })]],
    ['branch_param_missing', [decl({ path: '/api/v1/b/:branchId', permission: 'test.branch.manage', branchParam: 'id' })]],
    ['auth_idempotency', [decl({ path: '/api/v1/auth/x', permission: undefined, public: true, session: 'required', idempotency: 'store' })]],
    ['store_needs_session', [decl({ permission: undefined, public: true, idempotency: 'store' })]],
    ['store_needs_session', [decl({ permission: undefined, public: true, session: 'optional', idempotency: 'store' })]],
    ['self_tx_store', [decl({ tx: 'self', idempotency: 'store' })]],
    // The request hash covers the method, path and body, not the query: two queries would share one stored response.
    ['store_with_query', [decl({ idempotency: 'store', query: z.strictObject({ n: z.coerce.number() }) })]],
    ['duplicate_id', [decl(), decl({ path: '/api/v1/other' })]],
    ['duplicate_route', [decl(), decl({ id: 'fixture.2' })]],
    ['duplicate_route', [decl({ path: '/api/v1/x/:id' }), decl({ id: 'fixture.2', path: '/api/v1/x/:key' })]],
    ['incomplete', [decl({ audit: undefined })]],
    ['incomplete', [decl({ idempotency: undefined })]],
    ['incomplete', [decl({ handler: undefined })]],
    ['incomplete', [decl({ id: '' })]],
    ['invalid_value', [decl({ method: 'OPTIONS' })]],
    ['invalid_value', [decl({ path: 'api/v1/fixture' })]],
    ['invalid_value', [decl({ mode: 'admin' })]],
    ['invalid_value', [decl({ tx: 'outer' })]],
    // T23: `sideEffects` marks a GET route (HEAD → 404, cross-site → ORIGIN_DENIED at step 8).
    ['invalid_value', [decl({ sideEffects: true })]],
    ['invalid_value', [decl({ method: 'GET', audit: null, sideEffects: 'yes' })]],
    // 1c Task 10: `install` needs `public: true` and `session: 'none'`, and a path of the wizard: `/install` for the
    // page (GET), `/install/api/...` for the claim and the claimed routes.
    ['invalid_value', [page({ path: '/install/api/x', install: 'wizard' })]],
    ['install_decl_invalid', [page({ path: '/install/api/x', install: 'claimed', session: undefined })]],
    ['install_decl_invalid', [page({ path: '/install/api/x', install: 'claimed', session: 'optional' })]],
    ['install_decl_invalid', [page({ path: '/install/api/x', install: 'claimed', session: 'required' })]],
    ['install_decl_invalid', [decl({ path: '/install/api/x', install: 'claimed' })]],
    ['install_decl_invalid', [page({ path: '/api/v1/install', install: 'claimed' })]],
    ['install_decl_invalid', [page({ path: '/install', install: 'claimed' })]],
    ['install_decl_invalid', [page({ path: '/installer/api/x', install: 'claimed' })]],
    ['install_decl_invalid', [page({ path: '/install/apix', install: 'claim' })]],
    ['install_decl_invalid', [page({ path: '/install/api/page', install: 'page' })]],
    ['install_decl_invalid', [page({ method: 'POST', path: '/install', install: 'page' })]],
    ['install_decl_invalid', [decl({ method: 'POST', path: '/install', permission: undefined, opsAuth: true, install: 'page' })]],
    // 1c Task 8: `background` (the session is never touched) is for GET routes only, and only `true`.
    ['background_not_get', [decl({ background: true })]],
    ['invalid_value', [decl({ method: 'GET', audit: null, background: 'yes' })]],
  ])('refuses: %s', (reason, decls) => {
    const id = decls.at(-1)!.id === '' ? '?' : decls.at(-1)!.id;
    expect(reasonOf(decls)).toBe(`ROUTE_DECL_INVALID:${id}:${reason}`);
  });

  // ---- Phase 2 (catalog): Task 2 ----
  // The narrow extension of the route contract for OAI-PMH's `POST /oai` (Phase 2 spec §10, decision D2-34): a non-GET
  // route that reads no cookie and writes nothing. Every condition is required; any other non-GET `session: 'none'`
  // route outside the wizard stays `session_none_conflict`.
  describe('Phase 2: a cookieless read-only POST (OAI-PMH)', () => {
    /** The shape of `oai.post`: public, `session: 'none'`, explicit `mode: 'read'`, no idempotency, no audit, no body. */
    const oai = (over: Partial<Record<keyof RouteDecl, unknown>> = {}): RouteDecl =>
      page({ id: 'oai.post', method: 'POST', path: '/oai', mode: 'read', maintenance: 'allow', tx: 'self', ...over });

    it('is accepted, with or without a per-IP bucket', () => {
      expect(reasonOf([oai()])).toBe('accepted');
      expect(reasonOf([oai({ ipLimits: ['oai'] })])).toBe('accepted');
      expect(reasonOf([oai({ tx: undefined })])).toBe('accepted');
    });

    it.each<[string, Partial<Record<keyof RouteDecl, unknown>>]>([
      ['mode omitted', { mode: undefined }],
      ['mode write', { mode: 'write' }],
      ['mode system', { mode: 'system' }],
      ['an audit action', { audit: 'settings.update' }],
      ['alsoAudits', { alsoAudits: ['auth.2fa.disable'] }],
      ['a body schema', { body: z.strictObject({ verb: z.string() }) }],
      ['idempotency store', { idempotency: 'store' }],
      ['reauth', { reauth: true }],
      ['partialAuth', { partialAuth: true }],
      ['a raw body', { rawBody: { type: 'multipart', maxBytes: 1024 } }],
    ])('is refused with %s: session_none_conflict', (_name, over) => {
      expect(reasonOf([oai(over)])).toBe('ROUTE_DECL_INVALID:oai.post:session_none_conflict');
    });

    it('with mode omitted → session_none_conflict; with audit settings.update → refused', () => {
      expect(reasonOf([oai({ mode: undefined })])).toBe('ROUTE_DECL_INVALID:oai.post:session_none_conflict');
      expect(reasonOf([oai({ audit: 'settings.update' })])).toBe('ROUTE_DECL_INVALID:oai.post:session_none_conflict');
      // Every other method too: a cookieless write is never a route.
      for (const method of ['PUT', 'PATCH', 'DELETE']) {
        expect(reasonOf([oai({ method })]), method).toBe('accepted');
        expect(reasonOf([oai({ method, mode: undefined })]), method).toBe('ROUTE_DECL_INVALID:oai.post:session_none_conflict');
      }
    });
  });
});

describe('Phase 2: a cookieless read-only POST at run time (Task 2)', () => {
  const base = { state: { phase: 'ready' as const }, version: '0.1.0', buildId: 'b', log: recordingLogger() };
  /** What the test routes' handlers saw. */
  const seen: { body: string | null; auth: unknown }[] = [];
  const reading = defineRoutes([
    page({
      id: 't.oai',
      method: 'POST',
      path: '/t/oai',
      mode: 'read',
      maintenance: 'allow',
      tx: 'self',
      handler: async (rc: { c: { req: { text(): Promise<string> } }; auth: unknown }) => {
        seen.push({ body: await rc.c.req.text(), auth: rc.auth });
        return { body: { ok: true } };
      },
    }),
  ]);

  it('a POST from a foreign Origin without a cookie reaches the handler: step 8 is skipped, no cookie is read', async () => {
    seen.length = 0;
    const app = createApp({ ...base, routes: reading });
    const res = await app.request('/t/oai', {
      method: 'POST',
      headers: {
        origin: 'https://evil.example',
        'sec-fetch-site': 'cross-site',
        'content-type': 'application/x-www-form-urlencoded',
      },
      body: 'verb=Identify',
    });
    expect(res.status).toBe(200);
    expect(await res.json()).toEqual({ ok: true });
    expect(seen).toEqual([{ body: 'verb=Identify', auth: null }]);
  });

  it('a session cookie on the request changes nothing: it is never read (S29)', async () => {
    seen.length = 0;
    const app = createApp({ ...base, routes: reading });
    const res = await app.request('/t/oai', {
      method: 'POST',
      headers: { origin: 'https://evil.example', cookie: `altis_sid=${'a'.repeat(43)}`, 'content-type': 'application/x-www-form-urlencoded' },
      body: 'verb=ListSets',
    });
    expect(res.status).toBe(200);
    expect(seen).toEqual([{ body: 'verb=ListSets', auth: null }]);
  });
});

describe('assertAllRoutesDeclared', () => {
  function mounted(decls: RouteDecl[]): Hono<AppEnv> {
    const app = new Hono<AppEnv>();
    app.use(declareMiddleware(async (_c, next) => next())); // declared middleware entries are not routes
    const state = { phase: 'ready' as const };
    mountRoutes(app, decls, { state, services: createServices(state, { state, version: '0.1.0', buildId: 'b', log: recordingLogger() }) });
    return app;
  }

  it('passes when every route comes from a declaration', () => {
    const decls = defineRoutes([decl(), page()]);
    expect(() => assertAllRoutesDeclared(mounted(decls), decls)).not.toThrow();
  });

  it('a raw route fails: ROUTE_UNDECLARED:<METHOD> <path>', () => {
    const decls = defineRoutes([decl()]);
    const app = mounted(decls);
    app.post('/api/v1/raw', (c) => c.text('raw'));
    expect(() => assertAllRoutesDeclared(app, decls)).toThrow(new Error('ROUTE_UNDECLARED:POST /api/v1/raw'));
  });

  it('a raw handler on a declared method and path fails too', () => {
    const decls = defineRoutes([decl()]);
    const app = mounted(decls);
    app.post('/api/v1/fixture', (c) => c.text('shadow'));
    expect(() => assertAllRoutesDeclared(app, decls)).toThrow(new Error('ROUTE_UNDECLARED:POST /api/v1/fixture'));
  });

  it('a raw route with method ALL fails: ROUTE_UNDECLARED:ALL <path>', () => {
    const decls = defineRoutes([decl()]);
    const app = mounted(decls);
    app.all('/api/v1/raw', (c) => c.text('x'));
    expect(() => assertAllRoutesDeclared(app, decls)).toThrow(new Error('ROUTE_UNDECLARED:ALL /api/v1/raw'));
  });

  it('middleware that was not declared with declareMiddleware fails as well', () => {
    const decls = defineRoutes([decl()]);
    const app = mounted(decls);
    app.use('/api/*', async (_c, next) => next());
    expect(() => assertAllRoutesDeclared(app, decls)).toThrow(new Error('ROUTE_UNDECLARED:ALL /api/*'));
  });

  it('a mounted route whose declaration is not in the list fails', () => {
    const decls = defineRoutes([decl(), page()]);
    expect(() => assertAllRoutesDeclared(mounted(decls), [decls[0]!])).toThrow(new Error('ROUTE_UNDECLARED:GET /page'));
  });
});

describe('createApp and the route check', () => {
  const base = { state: { phase: 'ready' as const }, version: '0.1.0', buildId: 'b', log: recordingLogger() };

  it('mounts ALL_ROUTES by default', async () => {
    const app = createApp({ ...base, state: { phase: 'not_installed' } });
    expect(app.routes.filter((r) => r.method !== 'ALL').map((r) => `${r.method} ${r.path}`)).toEqual(
      ALL_ROUTES.map((d) => `${d.method} ${d.path}`),
    );
    expect((await app.request(HEALTH_PATH)).status).toBe(503);
  });

  it('a raw route added before the check fails startup (testHooks.beforeRouteCheck, test profile only)', () => {
    expect(() =>
      createApp({
        ...base,
        testHooks: {
          beforeRouteCheck: (app) => {
            app.post('/api/v1/raw', (c) => c.text('raw'));
          },
        },
      }),
    ).toThrow(new Error('ROUTE_UNDECLARED:POST /api/v1/raw'));
  });

  it('a raw ALL route or undeclared middleware added before the check fails startup', () => {
    expect(() =>
      createApp({
        ...base,
        testHooks: {
          beforeRouteCheck: (app) => {
            app.all('/api/v1/raw', (c) => c.text('x'));
          },
        },
      }),
    ).toThrow(new Error('ROUTE_UNDECLARED:ALL /api/v1/raw'));
    expect(() =>
      createApp({
        ...base,
        testHooks: {
          beforeRouteCheck: (app) => {
            app.use(async (_c, next) => next());
          },
        },
      }),
    ).toThrow(/^ROUTE_UNDECLARED:ALL /);
  });

  it('an invalid declaration in deps.routes fails startup', () => {
    expect(() => createApp({ ...base, routes: [decl({ permission: undefined })] })).toThrow(
      new Error('ROUTE_DECL_INVALID:fixture:access'),
    );
  });
});
