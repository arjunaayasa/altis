import fsp from 'node:fs/promises';
import os from 'node:os';
import path from 'node:path';
import { PHASE1_MIGRATIONS, runMigrations } from '@altis/db';
import { DomainError, t } from '@altis/shared';
import { afterAll, beforeAll, describe, expect, it } from 'vitest';
import { engineLabel, testDb, testDbContext, type TestDbHandle } from '../../../../tools/test/test-db.js';
import { createApp } from '../../src/app.js';
import { cspHeader } from '../../src/http/csp.js';
import { route, type RouteDecl } from '../../src/http/route.js';
import { opacText } from '../../src/opac/catalog/messages.js';
import { ALL_ROUTES } from '../../src/routes.js';
import { createAgent } from '../agent.js';
import { recordingLogger, sampleConfig } from '../support.js';

// S17 (Phase 2 Task 3): an error a browser sees on a page is an HTML page. createApp's failure() answers a request whose
// path is not under /api/ and whose Accept header asks for text/html with the OPAC status page (opacStatusResponse) when
// the problem's status is 404, 410, 429 or 503, keeping `Retry-After`; a 500 keeps the 1c error page; every other
// status, every /api/ path and every request that does not ask for HTML keeps its problem+json. The routes here exist
// in this test only (the test build), on top of ALL_ROUTES.

const ctx = testDbContext();
const NOW = Date.UTC(2026, 9, 30, 9, 15, 5);
const CONFIG = sampleConfig({ db: { dialect: 'sqlite' } });
const HTML = { Accept: 'text/html,application/xhtml+xml,application/xml;q=0.9,*/*;q=0.8' };
const JSON_ACCEPT = { Accept: 'application/json' };

const page = (id: string, p: string, fail: () => never, extra: Partial<RouteDecl> = {}): RouteDecl =>
  route({
    id,
    method: 'GET',
    path: p,
    public: true,
    session: 'none',
    maintenance: 'allow',
    idempotency: 'none',
    audit: null,
    ...extra,
    handler: async () => fail(),
  });

/** A page behind a per-IP bucket of one hit a minute (`authz-denied`'s limit): the second request is over it. */
const limited = route({
  id: 'test.opac.limited',
  method: 'GET',
  path: '/_test/opac/limited',
  public: true,
  session: 'none',
  maintenance: 'allow',
  idempotency: 'none',
  audit: null,
  ipLimits: ['authz-denied'],
  handler: async (rc) => rc.c.text('ok'),
});

const TEST_ROUTES: RouteDecl[] = [
  limited,
  page('test.opac.missing', '/_test/opac/missing', () => {
    throw new DomainError('NOT_FOUND');
  }),
  page('test.opac.gone', '/_test/opac/gone', () => {
    throw new DomainError('UPLOAD_EXPIRED'); // a 410
  }),
  page('test.opac.down', '/_test/opac/down', () => {
    throw new DomainError('DB_UNAVAILABLE');
  }),
  page('test.opac.conflict', '/_test/opac/conflict', () => {
    throw new DomainError('CONFLICT_STALE'); // a 409: not a status page
  }),
  page('test.opac.broken', '/_test/opac/broken', () => {
    throw new Error('broken');
  }),
  page('test.api.missing', '/api/v1/_test/opac/missing', () => {
    throw new DomainError('NOT_FOUND');
  }),
];

describe.skipIf(!ctx.available)(`S17: browser errors are OPAC status pages [${engineLabel()}]`, () => {
  let h: TestDbHandle;
  let root: string;
  let app: ReturnType<typeof createApp>;
  let peerSerial = 0;
  const agent = () => createAgent(app, { peer: `198.18.7.${(peerSerial += 1)}` });

  beforeAll(async () => {
    h = await testDb();
    root = await fsp.mkdtemp(path.join(os.tmpdir(), 'altis-opac-status-'));
    await runMigrations(h, { appVersion: '0.1.0', dataDir: path.join(root, 'migrations'), migrations: PHASE1_MIGRATIONS });
    app = createApp({
      state: { phase: 'ready', db: h, config: CONFIG },
      version: '0.1.0',
      buildId: 'opac-status',
      log: recordingLogger(),
      clock: () => NOW,
      env: {},
      routes: [...ALL_ROUTES, ...TEST_ROUTES],
    });
  });

  afterAll(async () => {
    await h?.close();
    if (root !== undefined) await fsp.rm(root, { recursive: true, force: true });
  });

  /** The invariants of a status page: HTML, its own nonce in the policy, noindex, no-store, the title. */
  function expectStatusPage(res: { status: number; text: string; headers: Headers }, status: number, title: string): void {
    expect(res.status).toBe(status);
    expect(res.headers.get('content-type')).toBe('text/html; charset=utf-8');
    expect(res.headers.get('cache-control')).toBe('no-store');
    const nonce = /<meta name="csp-nonce" content="([^"]+)"/.exec(res.text)?.[1];
    expect(res.headers.get('content-security-policy')).toBe(cspHeader(nonce!));
    expect(res.headers.get('x-request-id')).toMatch(/^[0-9A-Z]{26}$/);
    expect(res.text.startsWith('<!DOCTYPE html>')).toBe(true);
    expect(res.text).toContain(`<h1>${title}</h1>`);
    expect(res.text).toContain('<meta name="robots" content="noindex"');
  }

  it('over a page rate limit, a browser gets the 429 page with Retry-After; a JSON client the problem', async () => {
    const a = agent();
    const first = await a.get('/_test/opac/limited', undefined, HTML);
    expect(first.status).toBe(200);
    const over = await a.get('/_test/opac/limited', undefined, HTML);
    expectStatusPage(over, 429, opacText('id', 'shell.status.429.title'));
    const wait = Number(over.headers.get('retry-after'));
    expect(Number.isInteger(wait) && wait > 0 && wait <= 60).toBe(true);
    expect(over.text).toContain(opacText('id', 'shell.status.429.body'));

    const json = await a.get('/_test/opac/limited', undefined, JSON_ACCEPT);
    expect(json.status).toBe(429);
    expect(json.headers.get('content-type')).toBe('application/problem+json');
    expect(json.json).toMatchObject({ status: 429, code: 'AUTH_TOO_MANY_ATTEMPTS' });
    expect(Number(json.headers.get('retry-after'))).toBeGreaterThan(0);
    // The bucket is per IP: another visitor still gets the page.
    expect((await agent().get('/_test/opac/limited', undefined, HTML)).status).toBe(200);
  });

  it('the 429 page follows ?lang', async () => {
    const a = agent();
    await a.get('/_test/opac/limited?lang=en', undefined, HTML);
    const over = await a.get('/_test/opac/limited?lang=en', undefined, HTML);
    expectStatusPage(over, 429, opacText('en', 'shell.status.429.title'));
    expect(over.text).toContain('<html lang="en"');
  });

  it("a DomainError('NOT_FOUND') thrown by an OPAC route: the 404 page for a browser, problem+json otherwise", async () => {
    expectStatusPage(await agent().get('/_test/opac/missing', undefined, HTML), 404, t('id', 'opac.not_found.title'));
    for (const headers of [JSON_ACCEPT, {}, { Accept: '*/*' }, { Accept: 'text/html;q=0' }]) {
      const res = await agent().get('/_test/opac/missing', undefined, headers);
      expect(res.status).toBe(404);
      expect(res.headers.get('content-type')).toBe('application/problem+json');
      expect(res.json).toMatchObject({ code: 'NOT_FOUND' });
    }
  });

  it('410 and 503 are status pages too; a 503 never waits for the settings (none is read)', async () => {
    expectStatusPage(await agent().get('/_test/opac/gone', undefined, HTML), 410, opacText('id', 'shell.status.410.title'));
    expectStatusPage(await agent().get('/_test/opac/down', undefined, HTML), 503, opacText('id', 'shell.status.503.title'));
  });

  it('a path under /api/ stays problem+json whatever the Accept header says', async () => {
    const res = await agent().get('/api/v1/_test/opac/missing', undefined, HTML);
    expect(res.status).toBe(404);
    expect(res.headers.get('content-type')).toBe('application/problem+json');
    expect(res.json).toMatchObject({ code: 'NOT_FOUND' });
  });

  it('other statuses keep their problem+json; a 500 keeps the 1c error page', async () => {
    const conflict = await agent().get('/_test/opac/conflict', undefined, HTML);
    expect(conflict.status).toBe(409);
    expect(conflict.headers.get('content-type')).toBe('application/problem+json');
    const broken = await agent().get('/_test/opac/broken', undefined, HTML);
    expect(broken.status).toBe(500);
    expect(broken.headers.get('content-type')).toBe('text/html; charset=utf-8');
    expect(broken.text).toContain(t('id', 'opac.error.title'));
  });

  it('a path no route serves keeps the 1b not-found page (with the library name from the settings)', async () => {
    const res = await agent().get('/tidak-ada-di-sini', undefined, HTML);
    expect(res.status).toBe(404);
    expect(res.headers.get('content-type')).toBe('text/html; charset=utf-8');
    expect(res.text).toContain(t('id', 'opac.not_found.title'));
  });
});
