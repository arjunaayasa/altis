import fs from 'node:fs';
import fsp from 'node:fs/promises';
import os from 'node:os';
import path from 'node:path';
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import { createApp, type AppDeps } from '../src/app.js';
import { writeConfig } from '../src/config.js';
import { cspHeader, cspNonce } from '../src/http/csp.js';
import { previousReleaseDir, start } from '../src/index.js';
import { ALL_ROUTES } from '../src/routes.js';
import { bootContext, closeTestServers, httpRequest, recordingLogger, sampleConfig, useDataDir } from './support.js';

// Admin page serving (Task 25, spec §4.8, §7.4, D31): index.html with a per-request CSP nonce and no-store, hashed
// assets that are immutable and fall back to the previous release, the asset folder never the SPA (1c Task 19 serves
// /admin/_update before admin.index, which sets it apart no more), the third-party notices. Every one of these routes is `session: 'none'`: the app below has no database at all.

const PROBLEM_TYPE = 'application/problem+json';
const IMMUTABLE = 'public, max-age=31536000, immutable';
const NONCE = /^[A-Za-z0-9_-]{22}$/;

const INDEX_HTML = [
  '<!doctype html>',
  '<html lang="id">',
  '<head>',
  '<meta charset="utf-8">',
  '<meta name="csp-nonce" content="__CSP_NONCE__">',
  '<script type="module" nonce="__CSP_NONCE__" src="/admin/assets/index-Bk3x_9aQ.js"></script>',
  '<style nonce="__CSP_NONCE__">body{margin:0}</style>',
  '</head>',
  '<body><div id="root"></div></body>',
  '</html>',
].join('\n');

let root: string;
let active: string;
let previous: string;

async function put(file: string, content: string | Buffer): Promise<void> {
  await fsp.mkdir(path.dirname(file), { recursive: true });
  await fsp.writeFile(file, content);
}

beforeEach(async () => {
  root = await fsp.realpath(await fsp.mkdtemp(path.join(os.tmpdir(), 'altis-admin-serve-')));
  active = path.join(root, 'releases', '0.2.0');
  previous = path.join(root, 'releases', '0.1.0');
  await put(path.join(active, 'public', 'admin', 'index.html'), INDEX_HTML);
  await put(path.join(active, 'public', 'admin', 'assets', 'index-Bk3x_9aQ.js'), 'console.log("0.2.0")');
  await put(path.join(active, 'public', 'admin', 'assets', 'index-Bk3x_9aQ.js.map'), '{"version":3}');
  await put(path.join(active, 'public', 'admin', 'assets', '.vite', 'manifest.json'), '{}');
  await put(path.join(active, 'public', 'THIRD_PARTY_NOTICES.txt'), 'react 19.3.0 MIT\n');
  await put(path.join(active, 'server.mjs'), 'export {}');
  await put(path.join(active, 'config.json'), '{"secret":true}');
  await put(path.join(previous, 'public', 'admin', 'index.html'), '<!doctype html><title>0.1.0</title>');
  await put(path.join(previous, 'public', 'admin', 'assets', 'index-Old0_1a.js'), 'console.log("0.1.0")');
  await put(path.join(previous, 'public', 'THIRD_PARTY_NOTICES.txt'), 'old notices');
});

afterEach(async () => {
  vi.restoreAllMocks();
  await fsp.rm(root, { recursive: true, force: true });
});

function setup(release: AppDeps['release'] | null = { dir: active, previousDir: async () => previous }) {
  const log = recordingLogger();
  const app = createApp({
    state: { phase: 'ready' },
    version: '0.2.0',
    buildId: '0.2.0',
    log,
    ...(release === null ? {} : { release }),
  });
  return { app, log };
}

/** The nonce of `<meta name="csp-nonce" content="…">`. */
function metaNonce(html: string): string | undefined {
  return /<meta name="csp-nonce" content="([^"]*)">/.exec(html)?.[1];
}

async function problem(res: Response): Promise<Record<string, unknown>> {
  expect(res.headers.get('content-type')).toBe(PROBLEM_TYPE);
  return (await res.json()) as Record<string, unknown>;
}

describe('cspHeader and cspNonce', () => {
  it('the policy is exactly the spec §7.4 one, with no extra connect origin (1b)', () => {
    expect(cspHeader('abc_DEF-123')).toBe(
      "default-src 'self'; script-src 'self' 'nonce-abc_DEF-123'; style-src 'self' 'nonce-abc_DEF-123'; " +
        "img-src 'self' data:; connect-src 'self'; frame-ancestors 'self'; object-src 'none'; base-uri 'self'",
    );
  });

  it('a nonce is 22 base64url characters (16 random bytes), fresh each time', () => {
    const a = cspNonce();
    const b = cspNonce();
    expect(a).toMatch(NONCE);
    expect(b).toMatch(NONCE);
    expect(a).not.toBe(b);
  });

  it('refuses a nonce that could break out of the header', () => {
    expect(() => cspHeader("x'; script-src *")).toThrow(TypeError);
    expect(() => cspHeader('')).toThrow(TypeError);
  });
});

describe('the admin routes are declared', () => {
  it('admin.assets before admin.root and admin.index, then legal.notices; all session none, no audit', () => {
    const ids = ALL_ROUTES.map((d) => d.id);
    for (const id of ['admin.assets', 'admin.root', 'admin.index', 'legal.notices']) expect(ids).toContain(id);
    expect(ids.indexOf('admin.assets')).toBeLessThan(ids.indexOf('admin.index'));
    const byId = (id: string) => ALL_ROUTES.find((d) => d.id === id);
    expect(byId('admin.assets')).toMatchObject({ method: 'GET', path: '/admin/assets/:file', public: true, session: 'none', maintenance: 'allow', idempotency: 'none', audit: null });
    expect(byId('admin.root')).toMatchObject({ method: 'GET', path: '/admin', public: true, session: 'none', idempotency: 'none', audit: null });
    expect(byId('admin.index')).toMatchObject({ method: 'GET', path: '/admin/*', public: true, session: 'none', idempotency: 'none', audit: null });
    expect(byId('legal.notices')).toMatchObject({ method: 'GET', path: '/legal/third-party-notices.txt', public: true, session: 'none', idempotency: 'none', audit: null });
    // Ruling R1c-9: the shell is served during a normal maintenance (a restore still refuses `allow` routes).
    for (const id of ['admin.root', 'admin.index']) expect(byId(id)!.maintenance).toBe('allow');
    expect(byId('legal.notices')!.maintenance ?? 'deny').toBe('deny');
  });
});

describe('index.html', () => {
  it('GET /admin: 200 text/html, no-store, and a CSP whose nonce is the one in the document', async () => {
    const { app } = setup();
    const res = await app.request('/admin');
    expect(res.status).toBe(200);
    expect(res.headers.get('content-type')).toBe('text/html; charset=utf-8');
    expect(res.headers.get('cache-control')).toBe('no-store');
    const html = await res.text();
    const nonce = metaNonce(html);
    expect(nonce).toMatch(NONCE);
    expect(res.headers.get('content-security-policy')).toBe(cspHeader(nonce!));
    expect(html).not.toContain('__CSP_NONCE__');
    expect(html).toBe(INDEX_HTML.replaceAll('__CSP_NONCE__', nonce!));
    expect(res.headers.get('x-content-type-options')).toBe('nosniff');
  });

  it('two requests get two different nonces', async () => {
    const { app } = setup();
    const first = metaNonce(await (await app.request('/admin')).text());
    const second = metaNonce(await (await app.request('/admin')).text());
    expect(first).toMatch(NONCE);
    expect(second).toMatch(NONCE);
    expect(first).not.toBe(second);
  });

  it.each(['/admin/', '/admin/users/01JABCDEFGHJKMNPQRSTVWXYZ0', '/admin/settings/email?tab=smtp', '/admin/login'])(
    'GET %s: the same document (SPA routes)',
    async (url) => {
      const { app } = setup();
      const res = await app.request(url);
      expect(res.status).toBe(200);
      expect(res.headers.get('cache-control')).toBe('no-store');
      const html = await res.text();
      const nonce = metaNonce(html)!;
      expect(res.headers.get('content-security-policy')).toBe(cspHeader(nonce));
      expect(html).toBe(INDEX_HTML.replaceAll('__CSP_NONCE__', nonce));
    },
  );

  it('index.html is read once per process (a release directory never changes)', async () => {
    const { app } = setup();
    const readFile = vi.spyOn(fs.promises, 'readFile');
    for (let i = 0; i < 3; i += 1) expect((await app.request('/admin')).status).toBe(200);
    const reads = readFile.mock.calls.filter(([file]) => String(file).endsWith('index.html'));
    expect(reads).toHaveLength(1);
  });

  // 1c Task 19: /admin/_update itself is ops.update_page, mounted before admin.index (test/db/update-page.test.ts);
  // admin.index no longer sets the paths below it apart, so the SPA answers them (its own not-found screen).
  it.each(['/admin/_update/', '/admin/_update/progress'])('GET %s: the SPA document (admin.index sets nothing apart there)', async (url) => {
    const { app } = setup();
    const res = await app.request(url);
    expect(res.status).toBe(200);
    const html = await res.text();
    expect(html).toBe(INDEX_HTML.replaceAll('__CSP_NONCE__', metaNonce(html)!));
  });

  it.each(['/admin/assets', '/admin/assets/', '/admin/assets/a/b.js'])(
    'GET %s: 404 problem NOT_FOUND, not the SPA',
    async (url) => {
      const { app } = setup();
      const res = await app.request(url);
      expect(res.status).toBe(404);
      expect(await problem(res)).toMatchObject({ status: 404, code: 'NOT_FOUND' });
      expect(res.headers.get('content-security-policy')).toBeNull();
    },
  );
});

describe('admin not built', () => {
  it('no index.html in the release: 503 problem ADMIN_UNAVAILABLE', async () => {
    await fsp.rm(path.join(active, 'public', 'admin', 'index.html'));
    const { app } = setup();
    for (const url of ['/admin', '/admin/users']) {
      const res = await app.request(url);
      expect(res.status).toBe(503);
      expect(await problem(res)).toMatchObject({ status: 503, code: 'ADMIN_UNAVAILABLE' });
    }
  });

  it('an index.html that appears later is served without a restart (only a document found is kept)', async () => {
    const html = path.join(active, 'public', 'admin', 'index.html');
    await fsp.rename(html, `${html}.later`);
    const { app } = setup();
    expect((await app.request('/admin')).status).toBe(503);
    await fsp.rename(`${html}.later`, html);
    expect((await app.request('/admin')).status).toBe(200);
  });

  it('an app without a release directory: /admin 503 ADMIN_UNAVAILABLE, assets and notices 404', async () => {
    const { app } = setup(null);
    const index = await app.request('/admin');
    expect(index.status).toBe(503);
    expect(await problem(index)).toMatchObject({ code: 'ADMIN_UNAVAILABLE' });
    expect((await app.request('/admin/assets/index-Bk3x_9aQ.js')).status).toBe(404);
    expect((await app.request('/legal/third-party-notices.txt')).status).toBe(404);
  });
});

describe('hashed assets', () => {
  it('in the active release: 200, immutable, the type of its extension', async () => {
    const { app } = setup();
    const res = await app.request('/admin/assets/index-Bk3x_9aQ.js');
    expect(res.status).toBe(200);
    expect(res.headers.get('cache-control')).toBe(IMMUTABLE);
    expect(res.headers.get('content-type')).toBe('text/javascript; charset=utf-8');
    expect(await res.text()).toBe('console.log("0.2.0")');
    expect(res.headers.get('x-content-type-options')).toBe('nosniff');
  });

  it.each([
    ['index-Dq0.css', 'text/css; charset=utf-8'],
    ['inter-latin-400.woff2', 'font/woff2'],
    ['logo-a1.svg', 'image/svg+xml'],
    ['icon-192.png', 'image/png'],
    ['favicon.ico', 'image/x-icon'],
    ['_virtual_react-jsx.js', 'text/javascript; charset=utf-8'],
  ])('%s is served as %s', async (name, type) => {
    const bytes = Buffer.from([0, 1, 2, 0xff, 0xfe, 0x7f]);
    await put(path.join(active, 'public', 'admin', 'assets', name), bytes);
    const { app } = setup();
    const res = await app.request(`/admin/assets/${name}`);
    expect(res.status).toBe(200);
    expect(res.headers.get('content-type')).toBe(type);
    expect(res.headers.get('cache-control')).toBe(IMMUTABLE);
    expect(Buffer.from(await res.arrayBuffer()).equals(bytes)).toBe(true);
  });

  it('only in the previous release: 200 from there (a tab loaded before the update)', async () => {
    const { app } = setup();
    const res = await app.request('/admin/assets/index-Old0_1a.js');
    expect(res.status).toBe(200);
    expect(res.headers.get('cache-control')).toBe(IMMUTABLE);
    expect(await res.text()).toBe('console.log("0.1.0")');
  });

  it('the active release wins over the previous one', async () => {
    await put(path.join(previous, 'public', 'admin', 'assets', 'index-Bk3x_9aQ.js'), 'stale');
    const { app } = setup();
    expect(await (await app.request('/admin/assets/index-Bk3x_9aQ.js')).text()).toBe('console.log("0.2.0")');
  });

  it('in neither release: 404 problem NOT_FOUND', async () => {
    const { app } = setup();
    const res = await app.request('/admin/assets/index-Missing1.js');
    expect(res.status).toBe(404);
    expect(await problem(res)).toMatchObject({ code: 'NOT_FOUND' });
    expect(res.headers.get('cache-control')).not.toBe(IMMUTABLE);
  });

  it('without a previous release: an asset missing from the active one is 404', async () => {
    const previousDir = vi.fn(async () => null);
    const { app } = setup({ dir: active, previousDir });
    expect((await app.request('/admin/assets/index-Old0_1a.js')).status).toBe(404);
    expect(previousDir).toHaveBeenCalledTimes(1);
  });

  it.each([
    '/admin/assets/..%2F..%2Fconfig.json',
    '/admin/assets/..%2F..%2F..%2Fconfig.json',
    '/admin/assets/..%2Fserver.mjs',
    '/admin/assets/.vite',
    '/admin/assets/.vite%2Fmanifest.json',
    '/admin/assets/index-Bk3x_9aQ.js.map',
    '/admin/assets/index.html',
    '/admin/assets/x.js%00',
    '/admin/assets/%2e%2e%2f%2e%2e%2fconfig.json',
  ])('GET %s: 404, and nothing outside public/ reaches the file system (M16)', async (url) => {
    const { app } = setup();
    const readFile = vi.spyOn(fs.promises, 'readFile');
    const realpath = vi.spyOn(fs.promises, 'realpath');
    const res = await app.request(url);
    expect(res.status).toBe(404);
    expect(await problem(res)).toMatchObject({ code: 'NOT_FOUND' });
    const touched = [...readFile.mock.calls, ...realpath.mock.calls].map(([file]) => path.resolve(String(file)));
    const publicDirs = [path.join(active, 'public'), path.join(previous, 'public')];
    for (const file of touched) {
      expect(publicDirs.some((dir) => file === dir || file.startsWith(dir + path.sep)), file).toBe(true);
    }
    // A name that fails ADMIN_ASSET_NAME is refused before any file system call at all.
    expect(touched).toEqual([]);
  });
});

describe('third-party notices', () => {
  it('GET /legal/third-party-notices.txt: 200 text/plain from the active release', async () => {
    const { app } = setup();
    const res = await app.request('/legal/third-party-notices.txt');
    expect(res.status).toBe(200);
    expect(res.headers.get('content-type')).toBe('text/plain; charset=utf-8');
    expect(await res.text()).toBe('react 19.3.0 MIT\n');
  });

  it('missing from the active release: 404 (never the previous release)', async () => {
    await fsp.rm(path.join(active, 'public', 'THIRD_PARTY_NOTICES.txt'));
    const { app } = setup();
    const res = await app.request('/legal/third-party-notices.txt');
    expect(res.status).toBe(404);
    expect(await problem(res)).toMatchObject({ code: 'NOT_FOUND' });
  });
});

describe('start(ctx): the running release and its predecessor (index.ts)', () => {
  const dirs = useDataDir();

  afterEach(async () => {
    await closeTestServers();
  });

  async function writeCurrent(previousRef: unknown): Promise<void> {
    const file = path.join(dirs.dataDir, 'releases', 'current.json');
    const current = { schema: 1, active: { version: '0.2.0', source: 'data' }, previous: previousRef, pending: null, pendingSince: null, pinned: null };
    await put(file, JSON.stringify(current));
  }

  it('previousReleaseDir: current.json\'s previous release, bundled or in DATA_DIR/releases', async () => {
    const ctx = bootContext(dirs.dataDir);
    const log = recordingLogger();
    await writeCurrent({ version: '0.1.0', source: 'bundled' });
    expect(await previousReleaseDir(ctx, log)()).toBe(path.join(ctx.appRoot, 'bundled-release', '0.1.0'));
    await writeCurrent({ version: '0.1.0', source: 'data' });
    expect(await previousReleaseDir(ctx, log)()).toBe(path.join(dirs.dataDir, 'releases', '0.1.0'));
    await writeCurrent(null);
    expect(await previousReleaseDir(ctx, log)()).toBeNull();
    expect(log.lines).toEqual([]);
  });

  it('previousReleaseDir: no current.json is null; an unreadable one is null and a warning', async () => {
    const ctx = bootContext(dirs.dataDir);
    const log = recordingLogger();
    expect(await previousReleaseDir(ctx, log)()).toBeNull();
    expect(log.lines).toEqual([]);
    await writeCurrent({ version: 'latest', source: 'data' });
    expect(await previousReleaseDir(ctx, log)()).toBeNull();
    expect(log.lines).toEqual([
      expect.objectContaining({ level: 'warn', msg: 'previous release not readable; no admin asset fallback', fields: { error: expect.objectContaining({ code: 'STATE_CORRUPT' }) } }),
    ]);
  });

  it('serves the admin of ctx.release.dir, with the assets of current.json\'s previous release as fallback', async () => {
    await writeConfig(dirs.dataDir, sampleConfig({ db: { dialect: 'sqlite' } }));
    const ctx = bootContext(dirs.dataDir);
    await put(path.join(ctx.release.dir, 'public', 'admin', 'index.html'), INDEX_HTML);
    await put(path.join(ctx.appRoot, 'bundled-release', '0.0.9', 'public', 'admin', 'assets', 'index-Old0_1a.js'), 'old chunk');
    await writeCurrent({ version: '0.0.9', source: 'bundled' });
    await start(ctx);
    const served = await ctx.served();

    const index = await httpRequest(served.port, '/admin/users');
    expect(index.status).toBe(200);
    const nonce = metaNonce(index.body)!;
    expect(index.headers['content-security-policy']).toBe(cspHeader(nonce));
    const asset = await httpRequest(served.port, '/admin/assets/index-Old0_1a.js');
    expect(asset.status).toBe(200);
    expect(asset.headers['cache-control']).toBe(IMMUTABLE);
    expect(asset.body).toBe('old chunk');
  });
});
