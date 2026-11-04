import fsp from 'node:fs/promises';
import path from 'node:path';
import { ensureInstallCode, formatInstallCode, installGate } from '@altis/core';
import { PHASE1_MIGRATIONS, connect, runMigrations, type DbConfig, type DbHandle } from '@altis/db';
import { DomainError } from '@altis/shared';
import { afterEach, beforeEach, describe, expect, it, vi, type MockInstance } from 'vitest';
import { createApp, type AppDeps, type AppState } from '../src/app.js';
import { writeConfig } from '../src/config.js';
import { cspHeader } from '../src/http/csp.js';
import { route, type RouteDecl } from '../src/http/route.js';
import { DATA_DIR_MISMATCH_DETAIL, DATA_VOLUME_MISSING_DETAIL, NOT_INSTALLED_DETAIL } from '../src/http/problem.js';
import { start } from '../src/index.js';
import { ENV_DB_RETRY_MS, announceInstallCode, createEnvDbInstallId, createInstallService, envDbConfig } from '../src/install/gate.js';
import { ALL_ROUTES } from '../src/routes.js';
import { bootContext, closeTestServers, closedPort, recordingLogger, sampleConfig, useDataDir } from './support.js';

// The install gate over HTTP (spec §7.7, §9.5, acceptance A2; plan Task 10): before a claim the wizard's API is
// closed (INSTALL_CLAIM_REQUIRED), the claim sets `altis_install` (SameSite=Strict), a claimed write needs the claim's
// Origin and the wizard's CSRF token, an install finished by another process closes /install* at once (404), a lost
// DATA_DIR or volume answers 503 (never the wizard), and an uninstalled app sends browsers to /install. Each test runs
// an app over a temporary, uninstalled DATA_DIR.

const VERSION = '0.1.0';
const ORIGIN = 'http://localhost:3000';
const INSTALL_HTML = [
  '<!doctype html>',
  '<html lang="id">',
  '<head><meta name="csp-nonce" content="__CSP_NONCE__">',
  '<script type="module" nonce="__CSP_NONCE__" src="/admin/assets/install-Ab12_cd.js"></script></head>',
  '<body><div id="root"></div></body>',
  '</html>',
].join('\n');
const ASSET = 'install-Ab12_cd.js';

const dirs = useDataDir();
let appRoot: string;
let releaseDir: string;
let stdout: MockInstance<typeof process.stdout.write>;

async function put(file: string, content: string): Promise<void> {
  await fsp.mkdir(path.dirname(file), { recursive: true });
  await fsp.writeFile(file, content);
}

beforeEach(async () => {
  await fsp.mkdir(dirs.dataDir);
  appRoot = path.join(dirs.root, 'app');
  releaseDir = path.join(appRoot, 'release');
  await put(path.join(releaseDir, 'public', 'admin', 'install.html'), INSTALL_HTML);
  await put(path.join(releaseDir, 'public', 'admin', 'assets', ASSET), 'console.log("wizard")');
  // The page and start() print the install code to stdout: kept out of the test output, and looked at.
  stdout = vi.spyOn(process.stdout, 'write').mockImplementation(() => true);
});

afterEach(async () => {
  vi.restoreAllMocks();
  await closeTestServers();
});

/** docker/compose.yml of this repository: what the Docker package ships. */
const COMPOSE_YML = path.resolve(import.meta.dirname, '..', '..', '..', 'docker', 'compose.yml');

/**
 * The app service's `environment:` of a compose file as Docker Compose hands it over: `${VAR}`, `${VAR-default}`
 * (default when unset), `${VAR:-default}` (also when blank) and `${VAR:?message}` resolved against `vars` (the .env).
 */
function composeAppEnv(compose: string, vars: Record<string, string>): Record<string, string> {
  const lines = compose.split('\n');
  const app = lines.indexOf('  app:');
  const start = lines.indexOf('    environment:', app);
  if (app === -1 || start === -1) throw new Error('no environment for the app service');
  const out: Record<string, string> = {};
  for (const line of lines.slice(start + 1)) {
    if (/^ {6}#/.test(line)) continue;
    const m = /^ {6}([A-Z0-9_]+): (.*)$/.exec(line);
    if (m === null) break;
    out[m[1]!] = m[2]!.replace(/\$\{([A-Z0-9_]+)(?:(:?)([-?])([^}]*))?\}/g, (_all, name: string, colon?: string, op?: string, arg?: string) => {
      const value = vars[name];
      const missing = value === undefined || (colon === ':' && value === '');
      if (op === '?' && missing) throw new Error(`${name}: ${arg ?? ''}`);
      return op === '-' && missing ? (arg ?? '') : (value ?? '');
    });
  }
  return out;
}

type Setup = Partial<Pick<AppDeps, 'runtime' | 'env' | 'routes' | 'services'>> & { state?: AppState };

function setup(o: Setup = {}) {
  const state: AppState = o.state ?? { phase: 'not_installed' };
  const deps: AppDeps = {
    state,
    version: VERSION,
    buildId: VERSION,
    log: recordingLogger(),
    dataDir: dirs.dataDir,
    appRoot,
    runtime: o.runtime ?? 'standalone',
    env: o.env ?? {},
    release: { dir: releaseDir, previousDir: async () => null },
    ...(o.routes === undefined ? {} : { routes: o.routes }),
    ...(o.services === undefined ? {} : { services: o.services }),
  };
  return { app: createApp(deps), state, deps };
}

/** What @hono/node-server hands over as `c.env`: here only the socket's address (the peer of P15). */
const peer = (address = '127.0.0.1') => ({ incoming: { socket: { remoteAddress: address } } });

async function body(res: Response): Promise<Record<string, unknown>> {
  return (await res.json()) as Record<string, unknown>;
}

async function code(): Promise<string> {
  return (await ensureInstallCode(dirs.dataDir, { now: Date.now(), env: {} })).code;
}

/** The `altis_install=<token>` pair of a Set-Cookie line, for a Cookie header. */
function cookiePair(res: Response): string {
  const line = res.headers.getSetCookie().find((c) => /^(__Host-)?altis_install=/.test(c));
  if (line === undefined) throw new Error('no altis_install cookie');
  return line.split(';')[0]!;
}

async function claimed(app: ReturnType<typeof setup>['app'], env = peer()): Promise<{ cookie: string; csrf: string }> {
  const res = await app.request(
    '/install/api/claim',
    { method: 'POST', headers: { 'content-type': 'application/json', origin: ORIGIN }, body: JSON.stringify({ code: await code() }) },
    env,
  );
  expect(res.status).toBe(200);
  const json = await body(res);
  return { cookie: cookiePair(res), csrf: String(json['csrfToken']) };
}

/** A claimed write route besides ALL_ROUTES (1c Task 27 brings the real ones). */
const writeRoute = route({
  id: 'test.install.write',
  method: 'POST',
  path: '/install/api/_test/write',
  public: true,
  session: 'none',
  install: 'claimed',
  mode: 'system',
  maintenance: 'allow',
  tx: 'self',
  idempotency: 'none',
  audit: null,
  handler: async () => ({ body: { ok: true } }),
});

describe('before a claim', () => {
  it('every claimed /install/api/* route of ALL_ROUTES answers 403 INSTALL_CLAIM_REQUIRED', async () => {
    const { app } = setup();
    const claimedRoutes = ALL_ROUTES.filter((d) => d.install === 'claimed');
    expect(claimedRoutes.map((d) => d.id)).toContain('install.checks');
    for (const d of [...claimedRoutes, writeRoute] as RouteDecl[]) {
      const res = await setup({ routes: [...ALL_ROUTES, writeRoute] }).app.request(
        // A parameter gets a value its pattern accepts (the wizard's probe nonce: 16-64 characters, 1c Task 27).
        d.path.replace(/:[^/]+/g, 'x'.repeat(16)),
        { method: d.method, headers: { origin: ORIGIN, 'content-type': 'application/json' }, ...(d.method === 'GET' ? {} : { body: '{}' }) },
        peer(),
      );
      expect(res.status, d.id).toBe(403);
      expect((await body(res))['code'], d.id).toBe('INSTALL_CLAIM_REQUIRED');
    }
    // Every wizard route of ALL_ROUTES is `install`: nothing under /install is served otherwise.
    for (const d of ALL_ROUTES.filter((r) => r.path === '/install' || r.path.startsWith('/install/'))) expect(d.install, d.id).toBeDefined();
    // A stale or forged cookie is no claim.
    const forged = await app.request('/install/api/checks', { headers: { cookie: `altis_install=${'A'.repeat(43)}` } }, peer());
    expect((await body(forged))['code']).toBe('INSTALL_CLAIM_REQUIRED');
  });
});

describe('the claim', () => {
  it('POST /install/api/claim sets altis_install (HttpOnly, SameSite=Strict, Path=/), answers the CSRF token; then checks is open', async () => {
    const { app } = setup();
    const res = await app.request(
      '/install/api/claim',
      { method: 'POST', headers: { 'content-type': 'application/json', origin: ORIGIN }, body: JSON.stringify({ code: formatInstallCode(await code()) }) },
      peer(),
    );
    expect(res.status).toBe(200);
    expect(await body(res)).toEqual({ csrfToken: expect.stringMatching(/^[A-Za-z0-9_-]{43}$/), installState: null });
    const [line] = res.headers.getSetCookie();
    expect(line).toMatch(/^altis_install=[A-Za-z0-9_-]{43}; Path=\/; HttpOnly; SameSite=Strict$/);
    expect(res.headers.get('cache-control')).toBe('no-store');

    const checks = await app.request('/install/api/checks', { headers: { cookie: cookiePair(res) } }, peer());
    expect(checks.status).toBe(200);
  });

  it('with an https ALTIS_BASE_URL the cookie is __Host-altis_install and Secure (C19)', async () => {
    const env = { ALTIS_BASE_URL: 'https://perpus.example.sch.id' };
    const { app } = setup({ env });
    const res = await app.request(
      '/install/api/claim',
      { method: 'POST', headers: { 'content-type': 'application/json', origin: 'https://perpus.example.sch.id' }, body: JSON.stringify({ code: await code() }) },
      peer(),
    );
    expect(res.status).toBe(200);
    expect(res.headers.getSetCookie()[0]).toMatch(/^__Host-altis_install=[A-Za-z0-9_-]{43}; Path=\/; HttpOnly; Secure; SameSite=Strict$/);
    // The bare name is not read on https.
    const bare = cookiePair(res).replace('__Host-', '');
    expect((await body(await app.request('/install/api/checks', { headers: { cookie: bare } }, peer())))['code']).toBe('INSTALL_CLAIM_REQUIRED');
    expect((await app.request('/install/api/checks', { headers: { cookie: cookiePair(res) } }, peer())).status).toBe(200);
  });

  it('a claim needs an Origin, and no cross-site Sec-Fetch-Site; a wrong code is 403 INSTALL_CODE_INVALID', async () => {
    const { app } = setup();
    const post = (headers: Record<string, string>, given?: string) =>
      app.request(
        '/install/api/claim',
        { method: 'POST', headers: { 'content-type': 'application/json', ...headers }, body: JSON.stringify({ code: given ?? 'ABCDE-FGHJK-MNPQR-STVWX-YZ0123' }) },
        peer(),
      );
    expect((await body(await post({})))['code']).toBe('ORIGIN_DENIED');
    expect((await body(await post({ origin: 'null' })))['code']).toBe('ORIGIN_DENIED');
    expect((await body(await post({ origin: ORIGIN, 'sec-fetch-site': 'cross-site' })))['code']).toBe('ORIGIN_DENIED');
    await code();
    const wrong = await post({ origin: ORIGIN, 'sec-fetch-site': 'same-origin' });
    expect(wrong.status).toBe(403);
    expect((await body(wrong))['code']).toBe('INSTALL_CODE_INVALID');
    expect(wrong.headers.getSetCookie()).toEqual([]);
    expect((await app.request('/install/api/claim', { method: 'POST', headers: { origin: ORIGIN, 'content-type': 'application/json' }, body: '{"code":"x","more":1}' }, peer())).status).toBe(422);
  });

  it('a claimed write needs the claim\'s Origin and X-CSRF-Token', async () => {
    const { app } = setup({ routes: [...ALL_ROUTES, writeRoute] });
    const { cookie, csrf } = await claimed(app);
    const write = (headers: Record<string, string>) =>
      app.request('/install/api/_test/write', { method: 'POST', headers: { cookie, 'content-type': 'application/json', ...headers }, body: '{}' }, peer());

    expect((await body(await write({ origin: 'http://evil.example', 'x-csrf-token': csrf })))['code']).toBe('ORIGIN_DENIED');
    expect((await body(await write({ 'x-csrf-token': csrf })))['code']).toBe('ORIGIN_DENIED');
    expect((await body(await write({ origin: ORIGIN, 'x-csrf-token': csrf, 'sec-fetch-site': 'cross-site' })))['code']).toBe('ORIGIN_DENIED');
    expect((await body(await write({ origin: ORIGIN })))['code']).toBe('CSRF_INVALID');
    expect((await body(await write({ origin: ORIGIN, 'x-csrf-token': `${csrf.slice(1)}A` })))['code']).toBe('CSRF_INVALID');
    const ok = await write({ origin: ORIGIN, 'x-csrf-token': csrf });
    expect(ok.status).toBe(200);
    expect(await body(ok)).toEqual({ ok: true });
  });

  it('every wizard write of ALL_ROUTES but the claim needs the claim\'s Origin (ORIGIN_DENIED) and X-CSRF-Token (CSRF_INVALID)', async () => {
    const { app } = setup();
    const { cookie, csrf } = await claimed(app);
    // By path, not by declaration: a wizard write declared `claim` (any http(s) Origin passes) or not `install` at all
    // fails here.
    const writes = ALL_ROUTES.filter((d) => d.path.startsWith('/install/') && d.method !== 'GET' && d.id !== 'install.claim');
    expect(writes.map((d) => d.id)).toEqual([
      'install.exposure',
      'install.probe.methods.post',
      'install.probe.methods.put',
      'install.probe.methods.patch',
      'install.probe.methods.delete',
      'install.probe.chunk',
      'install.db_test',
      'install.config',
      'install.migrate',
      'install.profile',
      'install.admin',
      'install.cron_test',
      'install.finish',
    ]);
    for (const d of writes) {
      const send = (headers: Record<string, string>) =>
        app.request(
          // A parameter gets a value its pattern accepts (the wizard's probe nonce: 16-64 characters, 1c Task 27).
          d.path.replace(/:[^/]+/g, 'x'.repeat(16)),
          { method: d.method, headers: { cookie, 'content-type': 'application/json', ...headers }, body: '{}' },
          peer(),
        );
      const foreign = await send({ origin: 'https://evil.example', 'x-csrf-token': csrf });
      expect([foreign.status, (await body(foreign))['code']], d.id).toEqual([403, 'ORIGIN_DENIED']);
      const tokenless = await send({ origin: ORIGIN });
      expect([tokenless.status, (await body(tokenless))['code']], d.id).toEqual([403, 'CSRF_INVALID']);
    }
  });

  it('a second claim moves it: the first cookie is no claim any more', async () => {
    const { app } = setup();
    const first = await claimed(app);
    const second = await claimed(app, peer('127.0.0.2'));
    expect((await body(await app.request('/install/api/checks', { headers: { cookie: first.cookie } }, peer())))['code']).toBe('INSTALL_CLAIM_REQUIRED');
    expect((await app.request('/install/api/checks', { headers: { cookie: second.cookie } }, peer())).status).toBe(200);
  });

  it('runtime passenger, no config: claims are counted per visitor (X-Forwarded-For through one proxy), not per proxy (S22)', async () => {
    const { app } = setup({ runtime: 'passenger' });
    await code();
    const attempt = (visitor: string) =>
      app.request(
        '/install/api/claim',
        { method: 'POST', headers: { 'content-type': 'application/json', origin: ORIGIN, 'x-forwarded-for': visitor }, body: '{"code":"ABCDE-FGHJK-MNPQR-STVWX-YZ0123"}' },
        peer('127.0.0.1'),
      );
    for (let i = 0; i < 5; i += 1) expect((await body(await attempt('203.0.113.5')))['code']).toBe('INSTALL_CODE_INVALID');
    const sixth = await attempt('203.0.113.5');
    expect(sixth.status).toBe(429);
    expect(Number(sixth.headers.get('retry-after'))).toBeGreaterThan(0);
    // Another visitor behind the same proxy has a bucket of its own.
    expect((await body(await attempt('198.51.100.23')))['code']).toBe('INSTALL_CODE_INVALID');
  });
});

describe('the wizard page', () => {
  it('GET /install serves install.html with the request\'s nonce, the CSP and no-store; prints a fresh code once', async () => {
    const { app } = setup();
    const res = await app.request('/install', {}, peer());
    expect(res.status).toBe(200);
    expect(res.headers.get('content-type')).toBe('text/html; charset=utf-8');
    expect(res.headers.get('cache-control')).toBe('no-store');
    const html = await res.text();
    const nonce = /content="([A-Za-z0-9_-]{22})"/.exec(html)?.[1];
    expect(nonce).toBeDefined();
    expect(html).not.toContain('__CSP_NONCE__');
    expect(res.headers.get('content-security-policy')).toBe(cspHeader(nonce!));

    const shown = formatInstallCode(await code());
    const printed = () => stdout.mock.calls.filter(([text]) => String(text).includes(shown)).length;
    expect(printed()).toBe(1);
    await app.request('/install', {}, peer());
    expect(printed()).toBe(1); // the code was not new: not printed again
  });

  it('GET /install without install.html in the release: 503 ADMIN_UNAVAILABLE', async () => {
    await fsp.rm(path.join(releaseDir, 'public', 'admin', 'install.html'));
    const res = await setup().app.request('/install', {}, peer());
    expect(res.status).toBe(503);
    expect((await body(res))['code']).toBe('ADMIN_UNAVAILABLE');
  });
});

describe('the phase gate while not installed', () => {
  it('GET / and GET /admin* go to /install; /admin/assets/* is served; anything else is 503 NOT_INSTALLED', async () => {
    const { app } = setup();
    for (const p of ['/', '/admin', '/admin/', '/admin/users']) {
      const res = await app.request(p, {}, peer());
      expect(res.status, p).toBe(302);
      expect(res.headers.get('location'), p).toBe('/install');
    }
    const asset = await app.request(`/admin/assets/${ASSET}`, {}, peer());
    expect(asset.status).toBe(200);
    expect(await asset.text()).toBe('console.log("wizard")');
    for (const [p, method] of [['/api/v1/auth/login', 'POST'], ['/', 'POST'], ['/assets/x.css', 'GET'], ['/installer', 'GET']] as const) {
      const res = await app.request(p, { method }, peer());
      expect(res.status, p).toBe(503);
      expect(await body(res), p).toMatchObject({ code: 'NOT_INSTALLED', detail: NOT_INSTALLED_DETAIL });
    }
  });

  it('an unfinished install (config.json not complete) resumes: / still goes to /install', async () => {
    await writeConfig(dirs.dataDir, sampleConfig({ db: { dialect: 'sqlite' }, installState: 'profile' }));
    const { app } = setup();
    expect((await app.request('/', {}, peer())).headers.get('location')).toBe('/install');
    const { cookie } = await claimed(app);
    expect((await app.request('/install/api/checks', { headers: { cookie } }, peer())).status).toBe(200);
  });

  it('install.lock written by another process: /install/api/checks and GET /install are 404 at once', async () => {
    const { app } = setup();
    const { cookie } = await claimed(app);
    expect((await app.request('/install/api/checks', { headers: { cookie } }, peer())).status).toBe(200);
    await fsp.writeFile(path.join(dirs.dataDir, 'install.lock'), JSON.stringify({ installId: 'x', at: new Date().toISOString() }));
    for (const res of [
      await app.request('/install/api/checks', { headers: { cookie } }, peer()),
      await app.request('/install', {}, peer()),
      await app.request('/install/api/claim', { method: 'POST', headers: { 'content-type': 'application/json' }, body: '{"code":"x"}' }, peer()),
    ]) {
      expect(res.status).toBe(404);
      expect((await body(res))['code']).toBe('NOT_FOUND');
      expect(res.headers.get('x-altis-test-gate')).toBe('NOT_FOUND'); // the matrix's `gone` (D43, M38)
    }
    // A ready app answers the same.
    const ready = setup({ state: { phase: 'ready', config: sampleConfig() } }).app;
    expect((await ready.request('/install', {}, peer())).status).toBe(404);
  });

  it('a marker naming another DATA_DIR: 503 DATA_DIR_MISMATCH for /install and / (never the wizard); /_health stays', async () => {
    await put(path.join(appRoot, '.altis', 'installed.json'), JSON.stringify({ installId: 'x', dataDir: path.join(dirs.root, 'old-data') }));
    const { app } = setup();
    for (const p of ['/install', '/', '/admin/assets/' + ASSET, '/install/api/checks']) {
      const res = await app.request(p, {}, peer());
      expect(res.status, p).toBe(503);
      expect(await body(res), p).toMatchObject({ code: 'DATA_DIR_MISMATCH', detail: DATA_DIR_MISMATCH_DETAIL });
    }
    expect((await app.request('/_health', {}, peer())).status).toBe(503);
    expect(await body(await app.request('/_health', {}, peer()))).toEqual({ status: 'not_installed', version: VERSION });
  });

  it('a marker naming this very DATA_DIR, recreated empty: 503 DATA_DIR_MISMATCH, never the wizard (R1c-5)', async () => {
    await put(path.join(appRoot, '.altis', 'installed.json'), JSON.stringify({ installId: 'x', dataDir: dirs.dataDir }));
    const { app } = setup();
    for (const p of ['/install', '/', '/admin', '/install/api/checks']) {
      const res = await app.request(p, {}, peer());
      expect(res.status, p).toBe(503);
      expect(await body(res), p).toMatchObject({ code: 'DATA_DIR_MISMATCH', detail: DATA_DIR_MISMATCH_DETAIL });
    }
    const claim = await app.request(
      '/install/api/claim',
      { method: 'POST', headers: { 'content-type': 'application/json', origin: ORIGIN }, body: JSON.stringify({ code: await code() }) },
      peer(),
    );
    expect(claim.status).toBe(503);
    expect(stdout.mock.calls.map(([text]) => String(text)).join('')).not.toContain('ALTIS belum terpasang');
  });

  it('a lost Docker volume (the gate says volume_missing): 503 DATA_VOLUME_MISSING, never the wizard', async () => {
    const base = setup();
    const services = { install: { ...createInstallService(base.state, base.deps), gate: async () => ({ kind: 'volume_missing' as const }) } };
    const { app } = setup({ services });
    for (const p of ['/install', '/', '/install/api/checks']) {
      const res = await app.request(p, {}, peer());
      expect(res.status, p).toBe(503);
      expect(await body(res), p).toMatchObject({ code: 'DATA_VOLUME_MISSING', detail: DATA_VOLUME_MISSING_DETAIL });
    }
  });
});

describe('the environment database of the volume check', () => {
  it('envDbConfig: ALTIS_DB_* of a server engine; none for SQLite (its file is in DATA_DIR), unknown or unset', () => {
    expect(
      envDbConfig({
        ALTIS_DB_DIALECT: ' MariaDB ',
        ALTIS_DB_HOST: ' db ',
        ALTIS_DB_PORT: '3306',
        ALTIS_DB_USER: 'altis',
        ALTIS_DB_PASSWORD: 'pw',
        ALTIS_DB_NAME: 'altis',
      }),
    ).toEqual({ dialect: 'mariadb', host: 'db', port: 3306, user: 'altis', password: 'pw', database: 'altis' });
    // dialect only: no host, so no database the gate could ask (fail-closed must not hold a dialect-only setup at 503)
    expect(envDbConfig({ ALTIS_DB_DIALECT: 'postgres' })).toBeNull();
    expect(envDbConfig({ ALTIS_DB_DIALECT: 'postgres', ALTIS_DB_HOST: '  ' })).toBeNull();
    for (const env of [{}, { ALTIS_DB_DIALECT: 'sqlite' }, { ALTIS_DB_DIALECT: 'oracle' }, { ALTIS_DB_DIALECT: ' ' }]) {
      expect(envDbConfig(env), JSON.stringify(env)).toBeNull();
    }
  });

  it("the shipped docker/compose.yml with altis-init's .env names the database: a lost data volume over it → volume_missing (A2)", async () => {
    // What the app container gets from compose.yml when .env holds only what altis-init writes (spec §9.11).
    const password = 'p'.repeat(32);
    const env = composeAppEnv(await fsp.readFile(COMPOSE_YML, 'utf8'), { ALTIS_DB_PASSWORD: password, ALTIS_DB_ROOT_PASSWORD: 'r'.repeat(32), ALTIS_INSTALL_CODE: '' });
    expect(envDbConfig(env)).toEqual({ dialect: 'mariadb', host: 'db', port: 3306, user: 'altis', password, database: 'altis' });
    const installId = '01JZ0000000000000000000000';
    const read = vi.fn<(cfg: DbConfig) => Promise<string | null>>().mockResolvedValue(installId);
    const lost = createEnvDbInstallId({ env, runtime: 'docker', dataDir: dirs.dataDir, log: recordingLogger(), read });
    // No config.json (the data volume is new and empty), the database still holds the install: 503, never the wizard.
    expect(await installGate({ dataDir: dirs.dataDir, appRoot: null, env, config: null, envDbInstallId: lost })).toEqual({ kind: 'volume_missing' });
    expect(read).toHaveBeenCalledWith(envDbConfig(env));
    // A first install (the database has no install id yet): the wizard.
    const first = createEnvDbInstallId({ env, runtime: 'docker', dataDir: dirs.dataDir, log: recordingLogger(), read: async () => null });
    expect(await installGate({ dataDir: dirs.dataDir, appRoot: null, env, config: null, envDbInstallId: first })).toEqual({ kind: 'fresh' });
  });

  it('an unreachable database fails closed: DB_UNAVAILABLE (logged once), not asked again for ENV_DB_RETRY_MS', async () => {
    const log = recordingLogger();
    const env = { ALTIS_DB_DIALECT: 'mariadb', ALTIS_DB_HOST: '127.0.0.1', ALTIS_DB_PORT: String(await closedPort()), ALTIS_DB_USER: 'a', ALTIS_DB_NAME: 'a' };
    const look = createEnvDbInstallId({ env, runtime: 'docker', dataDir: dirs.dataDir, log });
    await expect(look()).rejects.toMatchObject({ code: 'DB_UNAVAILABLE' });
    await expect(look()).rejects.toMatchObject({ code: 'DB_UNAVAILABLE' });
    expect(log.lines.filter((l) => l.level === 'warn')).toHaveLength(1);
    // No database named at all: null, and nothing to log.
    const none = createEnvDbInstallId({ env: {}, runtime: 'docker', dataDir: dirs.dataDir, log });
    expect(await none()).toBeNull();
    expect(log.lines).toHaveLength(1);
  });

  it('a look that fails is looked at again after ENV_DB_RETRY_MS; the first answer is kept for the process', async () => {
    let now = 1_767_225_600_000;
    const installId = '01JZ0000000000000000000000';
    const read = vi
      .fn<(cfg: DbConfig) => Promise<string | null>>()
      .mockRejectedValueOnce(new DomainError('DB_UNAVAILABLE', { meta: { reason: 'unreachable' } }))
      .mockResolvedValue(installId);
    const env = { ALTIS_DB_DIALECT: 'postgres', ALTIS_DB_HOST: 'db' };
    const look = createEnvDbInstallId({ env, runtime: 'docker', dataDir: dirs.dataDir, log: recordingLogger(), clock: () => now, read });
    await expect(look()).rejects.toMatchObject({ code: 'DB_UNAVAILABLE' });
    now += ENV_DB_RETRY_MS - 1;
    await expect(look()).rejects.toMatchObject({ code: 'DB_UNAVAILABLE' });
    expect(read).toHaveBeenCalledTimes(1);
    now += 1;
    expect(await look()).toBe(installId);
    expect(await look()).toBe(installId);
    expect(read).toHaveBeenCalledTimes(2);
    expect(read).toHaveBeenCalledWith({ dialect: 'postgres', host: 'db' });
  });

  it('while the environment database cannot be read, the app answers 503 DB_UNAVAILABLE: never the wizard, no code', async () => {
    const env = { ALTIS_DB_DIALECT: 'mariadb', ALTIS_DB_HOST: '127.0.0.1', ALTIS_DB_PORT: String(await closedPort()), ALTIS_DB_USER: 'a', ALTIS_DB_NAME: 'a' };
    const { app } = setup({ env });
    for (const p of ['/', '/admin', '/install', '/install/api/checks']) {
      const res = await app.request(p, {}, peer());
      expect(res.status, p).toBe(503);
      expect((await body(res))['code'], p).toBe('DB_UNAVAILABLE');
    }
    const claim = await app.request(
      '/install/api/claim',
      { method: 'POST', headers: { 'content-type': 'application/json', origin: ORIGIN }, body: JSON.stringify({ code: await code() }) },
      peer(),
    );
    expect(claim.status).toBe(503);
    expect(stdout.mock.calls.map(([text]) => String(text)).join('')).not.toContain('ALTIS belum terpasang');
  });
});

describe('an install route\'s database (MountOptions.dbFor)', () => {
  let db: DbHandle | undefined;

  afterEach(async () => {
    await db?.close();
    db = undefined;
  });

  it('rc.db, rc.withTx and the audit-once check use services.install.db(); without it a step answers DB_UNAVAILABLE', async () => {
    const auditing = route({
      id: 'test.install.audit',
      method: 'POST',
      path: '/install/api/_test/audit',
      public: true,
      session: 'none',
      install: 'claimed',
      mode: 'system',
      maintenance: 'allow',
      tx: 'self',
      idempotency: 'none',
      audit: 'install.complete',
      handler: async (rc) => {
        await rc.audit({ entity: null, entityId: null, meta: { step: 'test' } });
        return { body: { ok: true } };
      },
    });
    const routes = [...ALL_ROUTES, auditing];
    const headers = (s: { cookie: string; csrf: string }) => ({ cookie: s.cookie, origin: ORIGIN, 'x-csrf-token': s.csrf, 'content-type': 'application/json' });

    const without = setup({ routes });
    const s1 = await claimed(without.app);
    const refused = await without.app.request('/install/api/_test/audit', { method: 'POST', headers: headers(s1), body: '{}' }, peer());
    expect(refused.status).toBe(503);
    expect((await body(refused))['code']).toBe('DB_UNAVAILABLE');

    db = await connect({ dialect: 'sqlite' }, { runtime: 'standalone', purpose: 'server', dataDir: dirs.dataDir });
    await runMigrations(db, { appVersion: VERSION, dataDir: dirs.dataDir, migrations: PHASE1_MIGRATIONS });
    const handle = db;
    const base = setup({ routes });
    const install = { ...createInstallService(base.state, base.deps), db: () => handle };
    // The app's own database stays unset: only the wizard's handle is used.
    const { app, state } = setup({ routes, services: { install } });
    const s2 = await claimed(app);
    const ok = await app.request('/install/api/_test/audit', { method: 'POST', headers: headers(s2), body: '{}' }, peer());
    expect(ok.status).toBe(200);
    expect(state.db).toBeUndefined();
    const entries = await handle.db.selectFrom('audit_log').select(['action', 'actor_type']).execute();
    expect(entries).toEqual([{ action: 'install.complete', actor_type: 'anonymous' }]);
  });
});

describe('start() while not installed', () => {
  it('prints the install code to stdout once, grouped 5-5-5-5-6, and never to the log file', async () => {
    const ctx = bootContext(dirs.dataDir);
    await start(ctx);
    const file = JSON.parse(await fsp.readFile(path.join(dirs.dataDir, 'install-code.txt'), 'utf8')) as { code: string };
    expect(file.code).toMatch(/^[0-9A-HJKMNP-TV-Z]{5}(-[0-9A-HJKMNP-TV-Z]{5}){3}-[0-9A-HJKMNP-TV-Z]{6}$/);
    const lines = stdout.mock.calls.map(([text]) => String(text)).filter((text) => text.includes(file.code));
    expect(lines).toHaveLength(1);
    expect(JSON.stringify(ctx.log.lines)).not.toContain(file.code);
    await expect(fsp.readFile(path.join(dirs.dataDir, 'logs', 'altis.log'), 'utf8').catch(() => '')).resolves.not.toContain(file.code);
  });

  it('the environment database cannot be read yet: no code printed or written; start() waits and retries', async () => {
    vi.stubEnv('ALTIS_DB_DIALECT', 'mariadb');
    vi.stubEnv('ALTIS_DB_HOST', '127.0.0.1');
    vi.stubEnv('ALTIS_DB_PORT', String(await closedPort()));
    vi.stubEnv('ALTIS_DB_USER', 'a');
    vi.stubEnv('ALTIS_DB_NAME', 'a');
    try {
      const ctx = bootContext(dirs.dataDir);
      const started = start(ctx);
      await vi.waitFor(() => expect(ctx.bootMarker.progress).toHaveBeenCalled(), { timeout: 3000 });
      expect(ctx.log.lines.map((l) => l.msg)).toContain('database unavailable, retrying');
      expect(stdout.mock.calls.map(([text]) => String(text)).join('')).not.toContain('ALTIS belum terpasang');
      await expect(fsp.stat(path.join(dirs.dataDir, 'install-code.txt'))).rejects.toMatchObject({ code: 'ENOENT' });
      // The handler retired (app.js closed its server): the pending start() settles.
      await closeTestServers();
      await expect(started).resolves.toBeUndefined();
    } finally {
      vi.unstubAllEnvs();
    }
  });

  it('the code start() makes is dated by the app\'s clock (services.clock), not Date.now()', async () => {
    const at = 1_767_225_600_000;
    const base = setup();
    const log = recordingLogger();
    await announceInstallCode(createInstallService(base.state, base.deps), { clock: () => at, log });
    const file = JSON.parse(await fsp.readFile(path.join(dirs.dataDir, 'install-code.txt'), 'utf8')) as { code: string; createdAt: number };
    expect(file.createdAt).toBe(at);
    expect(stdout.mock.calls.map(([text]) => String(text)).filter((text) => text.includes(file.code))).toHaveLength(1);
    // The same clock judges its age: at `at` + 1 h it is still the code (Date.now() would find it months old).
    await announceInstallCode(createInstallService(base.state, base.deps), { clock: () => at + 3_600_000, log });
    const again = JSON.parse(await fsp.readFile(path.join(dirs.dataDir, 'install-code.txt'), 'utf8')) as { code: string; createdAt: number };
    expect(again).toEqual(file);
    expect(stdout.mock.calls.map(([text]) => String(text)).filter((text) => text.includes(file.code))).toHaveLength(2);
  });

  it('a gate that fails on a file is logged, not a boot failure; DB_UNAVAILABLE and INVALID_CONFIG go up', async () => {
    const base = setup();
    const service = createInstallService(base.state, base.deps);
    const log = recordingLogger();
    const denied = Object.assign(new Error('EACCES: permission denied'), { code: 'EACCES' });
    await expect(announceInstallCode({ ...service, gate: () => Promise.reject(denied) }, { clock: () => Date.now(), log })).resolves.toBeUndefined();
    expect(log.lines.map((l) => [l.level, l.msg])).toEqual([['warn', 'install code not written']]);
    expect(stdout).not.toHaveBeenCalled();

    const unavailable = new DomainError('DB_UNAVAILABLE', { meta: { reason: 'unreachable' } });
    await expect(announceInstallCode({ ...service, gate: () => Promise.reject(unavailable) }, { clock: () => Date.now(), log })).rejects.toBe(unavailable);
    const bad = createInstallService(base.state, { ...base.deps, env: { ALTIS_INSTALL_CODE: 'ALTIS-CONTO-HKODE-INSTA-LASI01' } });
    await expect(announceInstallCode(bad, { clock: () => Date.now(), log })).rejects.toMatchObject({ code: 'INVALID_CONFIG' });
    expect(stdout).not.toHaveBeenCalled();
  });

  it('ALTIS_INSTALL_CODE set: says where the code comes from, without printing it', async () => {
    vi.stubEnv('ALTIS_INSTALL_CODE', 'ABCDE-FGHJK-MNPQR-STVWX-YZ0123');
    try {
      await start(bootContext(dirs.dataDir));
      const text = stdout.mock.calls.map(([t]) => String(t)).join('');
      expect(text).toContain('ALTIS_INSTALL_CODE');
      expect(text).not.toContain('ABCDE-FGHJK-MNPQR-STVWX-YZ0123');
      await expect(fsp.stat(path.join(dirs.dataDir, 'install-code.txt'))).rejects.toMatchObject({ code: 'ENOENT' });
    } finally {
      vi.unstubAllEnvs();
    }
  });
});
