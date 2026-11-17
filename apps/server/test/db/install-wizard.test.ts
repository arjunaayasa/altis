import { fork, type ChildProcess } from 'node:child_process';
import { createHash, randomBytes } from 'node:crypto';
import fsp from 'node:fs/promises';
import http from 'node:http';
import path from 'node:path';
import { hmacB64u, readSettings } from '@altis/core';
import { PHASE1_MIGRATIONS, auditAppend, connect, verifyAuditChain, withTx, type DbConfig, type DbHandle } from '@altis/db';
import type { Runtime } from '@altis/platform';
import type { CronTestResponse, InstallChecksResponse, MigrateResponse } from '@altis/shared/api/install';
import type { Hono } from 'hono';
import { afterEach, beforeEach, describe, expect, it, vi, type MockInstance } from 'vitest';
import { engineLabel, testDb, testDbConfig, testDbContext } from '../../../../tools/test/test-db.js';
import type { AppEnv } from '../../src/app.js';
import { start } from '../../src/index.js';
import { createAgent, type Agent, type AgentReply } from '../agent.js';
import { bootContext, closeTestServers, useDataDir, type TestBootContext } from '../support.js';

// The web wizard's API end to end (spec §9.5, §7.7, acceptance A2; plan Task 27) on the engine ALTIS_TEST_DB picks,
// through start(ctx) as app.js boots the server: SQLite under runtime `standalone`, a server engine under `passenger`
// (whose scheduler is required). claim → checks → exposure → db/test → config → migrate (one migration per call) →
// profile → admin → cron → finish, after which the process serves the installed system without a restart
// (L45); a process started before config.json existed boots once the install is complete (S12); an install interrupted
// after `config` resumes from a new code and claim, without any CLI; and the refusals of each step.

const engine = testDbContext();
const dirs = useDataDir();
const ADMIN = { username: 'admin', name: 'Admin Perpustakaan', email: 'admin@perpus.example.sch.id', password: 'kuda-lumping-biru' };
/**
 * The browser test's results: no proxy in front (the clean poll arrived with no X-Forwarded-For), and the forged poll's
 * entry taken as the client IP by the server's pre-install hops (1 on pm2/passenger/litespeed). The seed judges the
 * forged chain at the hops the admin confirmed in `POST config` (decision C22, P15): hops 0 take the socket peer (not
 * spoofable), hops 1 the forged entry (spoofable).
 */
const PROBE_RESULTS = {
  polling: true,
  sse: true,
  methods: { put: true, patch: false, delete: true },
  chunkBytes: 5_242_880,
  xff: { cleanXff: [], forgedXff: ['203.0.113.77'], forgedDerived: '203.0.113.77' },
};
const DAY_MS = 86_400_000;
const KNOWN = Object.keys(PHASE1_MIGRATIONS).sort();

/** SQLite runs single-process only (P20); a server engine runs the Passenger flow, whose scheduler is required. */
const RUNTIME: Runtime = engine.engine === 'sqlite' ? 'standalone' : 'passenger';

let appRoot: string;
let stdout: MockInstance<typeof process.stdout.write>;

beforeEach(async () => {
  await fsp.mkdir(dirs.dataDir);
  appRoot = path.join(dirs.root, 'app');
  await fsp.mkdir(path.join(appRoot, 'release', 'public', 'admin'), { recursive: true });
  await fsp.writeFile(path.join(appRoot, 'release', 'public', 'admin', 'install.html'), '<!doctype html><title>wizard</title>');
  await fsp.writeFile(path.join(appRoot, 'app.js'), '// the bootloader\n');
  await fsp.writeFile(path.join(appRoot, 'altis-data-dir.txt'), `${dirs.dataDir}\n`);
  // start() and GET /install print the install code to stdout: kept out of the test output.
  stdout = vi.spyOn(process.stdout, 'write').mockImplementation(() => true);
  if (engine.available && engine.engine !== 'sqlite') await (await testDb()).close(); // an empty database each test
});

afterEach(async () => {
  await closeTestServers();
  vi.useRealTimers();
  vi.restoreAllMocks();
  vi.unstubAllEnvs();
});

/** The database the wizard is given: the engine's (SQLite: DATA_DIR/db/altis.sqlite). */
function dbBody(): DbConfig {
  return testDbConfig();
}

/** A handle on the wizard's database, for the test's own reads and writes. */
function openDb(): Promise<DbHandle> {
  return connect(dbBody(), { runtime: 'standalone', purpose: 'cli', dataDir: dirs.dataDir });
}

const sha256 = (bytes: Uint8Array | string): string => createHash('sha256').update(bytes).digest('hex');

async function exists(file: string): Promise<boolean> {
  return fsp.stat(file).then(
    () => true,
    () => false,
  );
}

async function readJson(file: string): Promise<Record<string, unknown>> {
  return JSON.parse(await fsp.readFile(file, 'utf8')) as Record<string, unknown>;
}

async function installCode(): Promise<string> {
  return String((await readJson(path.join(dirs.dataDir, 'install-code.txt')))['code']);
}

/**
 * `app.request(...)` over a real socket to 127.0.0.1:`port` (node:http, no global fetch, P18), so that createAgent's
 * cookie jar drives a server that start() serves through ctx.serve.
 */
function overHttp(port: number): Hono<AppEnv> {
  const request = (urlPath: string, init: RequestInit = {}): Promise<Response> => {
    const headers: Record<string, string> = {};
    new Headers(init.headers).forEach((value, name) => {
      headers[name] = value;
    });
    const body = typeof init.body === 'string' ? init.body : undefined;
    if (body !== undefined) headers['content-length'] = String(Buffer.byteLength(body));
    return new Promise((resolve, reject) => {
      const req = http.request({ host: '127.0.0.1', port, path: urlPath, method: init.method ?? 'GET', headers, agent: false }, (res) => {
        const chunks: Buffer[] = [];
        res.on('data', (chunk: Buffer) => chunks.push(chunk));
        res.on('error', reject);
        res.on('end', () => {
          const h = new Headers();
          for (const [name, value] of Object.entries(res.headers)) {
            if (Array.isArray(value)) for (const v of value) h.append(name, v);
            else if (value !== undefined) h.set(name, value);
          }
          const status = res.statusCode ?? 0;
          resolve(new Response(status === 204 || status === 304 ? null : Buffer.concat(chunks), { status, headers: h }));
        });
      });
      req.on('error', reject);
      req.end(body);
    });
  };
  return { request } as unknown as Hono<AppEnv>;
}

/** A browser on the wizard of the server at `port`, sending `origin` as its Origin. */
interface Browser {
  agent: Agent;
  origin: string;
  port: number;
  csrf: string;
}

function browser(port: number, origin = `http://127.0.0.1:${port}`): Browser {
  return { agent: createAgent(overHttp(port), { headers: { origin } }), origin, port, csrf: '' };
}

function post(b: Browser, urlPath: string, body?: unknown): Promise<AgentReply> {
  return b.agent.post(urlPath, body, { 'x-csrf-token': b.csrf });
}

function json<T = Record<string, unknown>>(reply: AgentReply): T {
  return reply.json as T;
}

/** Starts a server (start(ctx), as app.js does) over DATA_DIR under `runtime`; its port once it serves. */
async function server(runtime: Runtime = RUNTIME): Promise<{ ctx: TestBootContext; port: number }> {
  const ctx = bootContext(dirs.dataDir, { runtime });
  await start(ctx);
  return { ctx, port: (await ctx.served()).port };
}

/** GET /install, then the claim with the code the page made: the browser holds `altis_install` and the CSRF token. */
async function claim(b: Browser, code?: string): Promise<AgentReply> {
  expect((await b.agent.get('/install')).status).toBe(200);
  const reply = await b.agent.post('/install/api/claim', { code: code ?? (await installCode()) });
  if (reply.status === 200) b.csrf = String(json(reply)['csrfToken']);
  return reply;
}

async function checks(b: Browser): Promise<InstallChecksResponse> {
  const reply = await b.agent.get('/install/api/checks');
  expect(reply.status).toBe(200);
  return json<InstallChecksResponse>(reply);
}

/** The exposure test's report with nothing served: every candidate answered 404. */
async function cleanExposure(b: Browser, c: InstallChecksResponse): Promise<void> {
  const reply = await post(b, '/install/api/exposure', { results: c.exposure.candidates.map((x) => ({ path: x.path, status: 404, sha256: null })) });
  expect(reply.status, reply.text).toBe(200);
  expect(reply.json).toEqual({ ok: true });
}

/** The base URL probe: a nonce and the HMAC this installation answers for it. */
async function probe(b: Browser): Promise<{ nonce: string; hmac: string }> {
  const nonce = randomBytes(18).toString('base64url');
  const reply = await b.agent.get(`/install/api/probe/${nonce}`);
  expect(reply.status).toBe(200);
  return { nonce, hmac: String(json(reply)['hmac']) };
}

function configBody(b: Browser, p: { nonce: string; hmac: string }, over: Record<string, unknown> = {}) {
  return { baseUrl: b.origin, db: dbBody(), trustProxy: { hops: 0 }, probe: { ...p, results: PROBE_RESULTS }, ...over };
}

/** Claim, checks, a clean exposure test and the config step (`over` changes its body): installState `migrate`. */
async function throughConfig(b: Browser, over: (p: { nonce: string; hmac: string }) => Record<string, unknown> = () => ({})): Promise<InstallChecksResponse> {
  expect((await claim(b)).status).toBe(200);
  const c = await checks(b);
  await cleanExposure(b, c);
  const p = await probe(b);
  const reply = await post(b, '/install/api/config', configBody(b, p, over(p)));
  expect(reply.status, reply.text).toBe(200);
  expect(reply.json).toEqual({ installState: 'migrate' });
  return c;
}

/** POST migrate until done: the migration each call applied, in order. */
async function migrateAll(b: Browser): Promise<MigrateResponse[]> {
  const replies: MigrateResponse[] = [];
  for (let i = 0; i <= KNOWN.length + 1; i += 1) {
    const reply = await post(b, '/install/api/migrate');
    expect(reply.status, reply.text).toBe(200);
    replies.push(json<MigrateResponse>(reply));
    if (replies.at(-1)!.done) return replies;
  }
  throw new Error('the migrations never finished');
}

async function step(b: Browser, urlPath: string, body: unknown, installState: string): Promise<void> {
  const reply = await post(b, urlPath, body);
  expect(reply.status, `${urlPath}: ${reply.text}`).toBe(200);
  expect(reply.json).toEqual({ installState });
}

/** The cron token of config.json. */
async function cronToken(): Promise<string> {
  return String(((await readJson(path.join(dirs.dataDir, 'config.json')))['secrets'] as Record<string, unknown>)['cronToken']);
}

/**
 * From `migrate` to `finish`'s scheduler check, on a server started under `runtime`: on Passenger the cron URL is called
 * first, as the panel's job would. Any other runtime runs the worker and gets no cron call: a fresh `cron-seen.json`
 * would be what cron/test reports (its `mode`) instead of the worker.
 */
async function migrateToCron(b: Browser, runtime: Runtime = RUNTIME): Promise<CronTestResponse> {
  await migrateAll(b);
  await step(b, '/install/api/profile', { library: { name: 'Perpustakaan SMA 1', timezone: 'Asia/Jakarta', locale: 'id' }, branch: {} }, 'admin');
  await step(b, '/install/api/admin', ADMIN, 'cron');
  if (runtime === 'passenger') {
    const cron = await b.agent.post('/_cron', undefined, { authorization: `Bearer ${await cronToken()}` });
    expect(cron.status).toBe(200);
    expect(cron.json).toEqual({ installed: false });
  }
  const reply = await post(b, '/install/api/cron/test');
  expect(reply.status).toBe(200);
  return json<CronTestResponse>(reply);
}

/** Signs `ADMIN` in through the API the SPA uses. */
async function signIn(b: Browser): Promise<AgentReply> {
  const me = await b.agent.get('/api/v1/auth/me');
  const csrf = String(json(me)['csrfToken']);
  return b.agent.post('/api/v1/auth/login', { username: ADMIN.username, password: ADMIN.password }, { 'x-csrf-token': csrf });
}

describe.skipIf(!engine.available)(`the install wizard [${engineLabel()}]`, () => {
  it(`A2: the whole wizard under ${RUNTIME}, then the installed system in the same process without a restart (L45)`, async () => {
    const { ctx, port } = await server();
    const b = browser(port);
    expect((await b.agent.get('/')).headers.get('location')).toBe('/install');
    expect((await claim(b)).json).toEqual({ csrfToken: b.csrf, installState: null });

    // Step 1: the checks, the exposure test, the probes.
    const c = await checks(b);
    expect(c).toMatchObject({ installState: null, runtime: RUNTIME, panelWarning: null, csrfToken: b.csrf });
    expect(c.preflight.ok).toBe(true);
    expect(Object.keys(c.preflight.checks)).toEqual(['node', 'dataDir', 'docroot', 'wasm', 'timezone', 'ram']);
    const probeFile = path.join(dirs.dataDir, 'tmp', c.exposure.probeId);
    expect(await fsp.readFile(probeFile, 'utf8')).toMatch(/^[0-9a-f]{64}$/);
    expect(c.exposure.candidates).toEqual(
      expect.arrayContaining([
        { kind: 'probe', path: `/${c.exposure.probeId}` },
        { kind: 'probe', path: `/tmp/${c.exposure.probeId}` },
        { kind: 'app', path: '/app.js' },
        { kind: 'pointer', path: '/altis-data-dir.txt' },
      ]),
    );
    expect((await checks(b)).exposure.probeId).toBe(c.exposure.probeId); // one probe file per claim
    await cleanExposure(b, c);

    // Step 2: the database, config.json, the migrations one by one.
    const tested = await post(b, '/install/api/db/test', { db: dbBody() });
    expect(tested.status, tested.text).toBe(200);
    expect(tested.json).toMatchObject({ ok: true, problems: [], empty: true, resumable: false, poolSize: expect.any(Number) });
    const p = await probe(b);
    expect((await post(b, '/install/api/config', configBody(b, p))).json).toEqual({ installState: 'migrate' });
    const config = await readJson(path.join(dirs.dataDir, 'config.json'));
    expect(config).toMatchObject({ baseUrl: b.origin, installState: 'migrate', trustProxy: { hops: 0 }, install: { runtime: RUNTIME } });
    const installId = String((config['install'] as Record<string, unknown>)['id']);
    expect((await b.agent.get('/install/api/progress')).json).toEqual({ installState: 'migrate', migrations: { applied: 0, total: KNOWN.length } });

    const migrated = await migrateAll(b);
    expect(migrated.map((m) => m.applied)).toEqual(KNOWN); // exactly one migration per call, in order
    expect(migrated.map((m) => m.remaining)).toEqual(KNOWN.map((_, i) => KNOWN.length - i - 1));
    expect(migrated.at(-1)?.done).toBe(true);
    expect((await b.agent.get('/install/api/progress')).json).toEqual({ installState: 'profile', migrations: { applied: KNOWN.length, total: KNOWN.length } });

    // Steps 3-6.
    await step(
      b,
      '/install/api/profile',
      { library: { name: 'Perpustakaan SMA 1', type: 'sekolah', address: 'Jl. Merdeka 1', timezone: 'asia/jakarta', locale: 'id' }, branch: { code: 'utama' } },
      'admin',
    );
    expect((await post(b, '/install/api/admin', { ...ADMIN, password: 'password' })).json).toMatchObject({ code: 'PASSWORD_TOO_WEAK' });
    // The community edition has no licence step: the super admin goes on to the scheduler, and the licence routes of
    // the commercial wizard are not there.
    await step(b, '/install/api/admin', ADMIN, 'cron');
    for (const [method, url] of [
      ['get', '/install/api/license/request-code'],
      ['post', '/install/api/license'],
    ] as const) {
      const gone = method === 'get' ? await b.agent.get(url) : await post(b, url, { mode: 'trial' });
      expect([url, gone.status, json(gone)['code']]).toEqual([url, 404, 'NOT_FOUND']);
    }

    const token = await cronToken();
    let cron = json<CronTestResponse>(await post(b, '/install/api/cron/test'));
    expect(cron.cronLine).toMatch(/^\*\/5 \* \* \* \* \S+ \S+\/app\.js jobs:run$/);
    expect(cron.cronLine).toContain(process.execPath);
    expect(cron.curlLine).toBe(`curl -fsS --retry 3 --retry-delay 10 -X POST -H "Authorization: Bearer ${token}" ${b.origin}/_cron`);
    if (RUNTIME === 'passenger') {
      expect(cron).toMatchObject({ required: true, detected: false, mode: null, at: null });
      const early = await post(b, '/install/api/finish');
      expect(early.status).toBe(409);
      expect(json(early)['code']).toBe('CRON_NOT_DETECTED');
      expect((await b.agent.post('/_cron', undefined, { authorization: `Bearer ${token}` })).json).toEqual({ installed: false });
      cron = json<CronTestResponse>(await post(b, '/install/api/cron/test'));
      expect(cron).toMatchObject({ required: true, detected: true, mode: 'cron_http', at: expect.any(Number) });
    } else {
      expect(cron).toMatchObject({ required: false, detected: true, mode: 'worker', at: null });
    }

    // Step 7.
    const finished = await post(b, '/install/api/finish');
    expect(finished.status, finished.text).toBe(200);
    expect(finished.json).toEqual({ next: '/admin/login' });
    expect(finished.headers.getSetCookie().some((line) => /^altis_install=; Max-Age=0/.test(line))).toBe(true);
    expect(await readJson(path.join(dirs.dataDir, 'install.lock'))).toEqual({ installId, at: expect.any(String) });
    expect(await readJson(path.join(appRoot, '.altis', 'installed.json'))).toEqual({ installId, dataDir: await fsp.realpath(dirs.dataDir) });
    expect((await readJson(path.join(dirs.dataDir, 'config.json')))['installState']).toBe('complete');
    expect(await exists(path.join(dirs.dataDir, 'install-code.txt'))).toBe(false);
    expect(await exists(path.join(dirs.dataDir, 'tmp', 'install-session.json'))).toBe(false);
    expect(await exists(probeFile)).toBe(false);

    // L45: the same process serves the installed system within 2 s, without a restart.
    expect((await b.agent.get('/install/api/checks')).status).toBe(404);
    expect((await b.agent.get('/install')).status).toBe(404);
    await vi.waitFor(async () => expect((await b.agent.get('/_health')).status).toBe(200), { timeout: 2000, interval: 25 });
    expect(ctx.requestRestart).not.toHaveBeenCalled();
    expect(ctx.markHealthy).toHaveBeenCalledTimes(1);
    expect((await signIn(b)).status).toBe(200);
    expect((await b.agent.get('/')).status).toBe(200);

    // What the wizard wrote.
    const h = await openDb();
    try {
      expect(await h.db.selectFrom('schema_meta').select('install_id').executeTakeFirst()).toEqual({ install_id: installId });
      // Nothing of a licence: no license_state row, no trial setting, no releases/clock.json.
      expect(await h.db.selectFrom('license_state').selectAll().execute()).toEqual([]);
      expect(await h.db.selectFrom('settings').select('key').where('key', 'like', 'license.%').execute()).toEqual([]);
      expect(await exists(path.join(dirs.dataDir, 'releases', 'clock.json'))).toBe(false);
      const branches = await h.db.selectFrom('branches').select(['code_key', 'code_display', 'name', 'timezone', 'is_default']).execute();
      expect(branches).toEqual([{ code_key: 'UTAMA', code_display: 'utama', name: 'Perpustakaan SMA 1', timezone: 'Asia/Jakarta', is_default: 1 }]);
      const settings = Object.fromEntries((await h.db.selectFrom('settings').select(['key', 'value']).execute()).map((r) => [r.key, JSON.parse(r.value ?? 'null') as unknown]));
      expect(settings).toMatchObject({
        'library.name': 'Perpustakaan SMA 1',
        'library.type': 'sekolah',
        'library.address': 'Jl. Merdeka 1',
        'library.timezone': 'Asia/Jakarta',
        'library.locale': 'id',
        // A fresh install starts with the design's blue accent.
        'opac.accent': 'blue',
        'system.probe': expect.objectContaining({ sse: true, methods: { put: true, patch: false, delete: true }, xff: { spoofable: false, suggestedHops: 0 } }),
      });
      // Hops 0 confirmed: the forged entry is never the client IP, whatever the pre-install hops derived.
      expect(await readSettings(h.db, ['system.ip_trust'], [])).toEqual({ 'system.ip_trust': 'ok' });
      const audit = await h.db.selectFrom('audit_log').select(['action', 'actor_type', 'entity_id']).orderBy('seq').execute();
      expect(audit.filter((a) => a.action === 'users.create')).toEqual([{ action: 'users.create', actor_type: 'system', entity_id: expect.any(String) }]);
      expect(audit.filter((a) => a.action === 'install.complete')).toEqual([{ action: 'install.complete', actor_type: 'system', entity_id: installId }]);
    } finally {
      await h.close();
    }
  }, 120_000);

  it('runtime docker: the install marker is not written (spec §7.7); the XFF seed is judged at the hops confirmed', async () => {
    const { port } = await server('docker');
    const b = browser(port);
    // Docker's pre-install hops (0) derived the socket peer for the forged poll, but the admin confirmed hops 1: with
    // them the forged entry becomes the client IP (P15 spoofable).
    const atPeer = { ...PROBE_RESULTS, xff: { ...PROBE_RESULTS.xff, forgedDerived: '127.0.0.1' } };
    await throughConfig(b, (p) => ({ trustProxy: { hops: 1 }, probe: { ...p, results: atPeer } }));
    const cron = await migrateToCron(b, 'docker');
    expect(cron).toMatchObject({ required: false, detected: true, mode: 'worker' });
    expect((await post(b, '/install/api/finish')).status).toBe(200);
    expect(await exists(path.join(dirs.dataDir, 'install.lock'))).toBe(true);
    expect(await exists(path.join(appRoot, '.altis', 'installed.json'))).toBe(false);
    await vi.waitFor(async () => expect((await b.agent.get('/_health')).status).toBe(200), { timeout: 2000, interval: 25 });
    const h = await openDb();
    try {
      const settings = await readSettings(h.db, ['system.ip_trust', 'system.probe'], []);
      expect(settings['system.ip_trust']).toBe('spoofable');
      expect(settings['system.probe']).toMatchObject({ xff: { spoofable: true, suggestedHops: 0 } });
    } finally {
      await h.close();
    }
  }, 120_000);

  it('D37: finish whose install.complete entry fails leaves the install unfinished, and the retry finishes it with one entry', async () => {
    const { port } = await server();
    const b = browser(port);
    await throughConfig(b);
    await migrateToCron(b);
    const configFile = path.join(dirs.dataDir, 'config.json');
    const installId = String(((await readJson(configFile))['install'] as Record<string, unknown>)['id']);
    // A row already holding the seq the next append takes: the entry's INSERT fails (uq_audit_log_seq), as a lost
    // connection would fail it.
    const h = await openDb();
    try {
      const head = await h.db.selectFrom('audit_head').select(['last_seq', 'last_hash']).where('id', '=', 1).executeTakeFirstOrThrow();
      await withTx(h, async (trx) => {
        await auditAppend(trx, { at: Date.now(), actorType: 'system', actorId: null, action: 'test.block', entity: null, entityId: null, branchId: null, ip: null, meta: {} });
        await trx.updateTable('audit_head').set({ last_seq: head.last_seq, last_hash: head.last_hash }).where('id', '=', 1).execute();
      });
      const failed = await post(b, '/install/api/finish');
      expect(json(failed)['code'], failed.text).toBe('UNIQUE_VIOLATION');
      // Nothing says the install is complete yet: /install still answers, and the step can run again.
      expect((await readJson(configFile))['installState']).toBe('cron');
      expect(await exists(path.join(dirs.dataDir, 'install.lock'))).toBe(false);
      await h.db.deleteFrom('audit_log').where('action', '=', 'test.block').execute();
      const retried = await post(b, '/install/api/finish');
      expect(retried.status, retried.text).toBe(200);
      expect((await readJson(configFile))['installState']).toBe('complete');
      const entries = await h.db.selectFrom('audit_log').select(['action', 'entity_id']).where('action', '=', 'install.complete').execute();
      expect(entries).toEqual([{ action: 'install.complete', entity_id: installId }]);
      expect(await verifyAuditChain(h)).toMatchObject({ ok: true });
    } finally {
      await h.close();
    }
  }, 120_000);

  it('the refusals: exposed, base URL, origin, probe HMAC, a database not empty, a step out of order', async () => {
    const { port } = await server();
    const b = browser(port);
    expect((await claim(b)).status).toBe(200);
    const c = await checks(b);
    const p = await probe(b);

    // config before any exposure test; then a fetch that returned the probe file blocks it (§9.5 "blokir").
    expect(json(await post(b, '/install/api/config', configBody(b, p)))['code']).toBe('INSTALL_STEP_ORDER');
    // A report that leaves a candidate out proves nothing (A2): 422, and config stays refused.
    const notFound = (x: { path: string }) => ({ path: x.path, status: 404, sha256: null });
    for (const results of [[], c.exposure.candidates.slice(1).map(notFound)]) {
      const incomplete = await post(b, '/install/api/exposure', { results });
      expect(incomplete.status, incomplete.text).toBe(422);
      expect(json(incomplete)).toMatchObject({ code: 'VALIDATION_FAILED', errors: [{ path: 'results', code: 'incomplete' }] });
    }
    expect(json(await post(b, '/install/api/config', configBody(b, p)))['code']).toBe('INSTALL_STEP_ORDER');
    const probeBytes = await fsp.readFile(path.join(dirs.dataDir, 'tmp', c.exposure.probeId));
    const exposed = await post(b, '/install/api/exposure', {
      results: [
        { path: '/app.js', status: 404, sha256: null },
        { path: `/tmp/${c.exposure.probeId}`, status: 200, sha256: sha256(probeBytes) },
      ],
    });
    expect(exposed.status).toBe(422);
    expect(json(exposed)['code']).toBe('INSTALL_EXPOSED');
    const blocked = await post(b, '/install/api/config', configBody(b, p));
    expect(blocked.status).toBe(409);
    expect(json(blocked)['code']).toBe('INSTALL_STEP_ORDER');
    // app.js served is exposure too.
    const appJs = await post(b, '/install/api/exposure', { results: [{ path: '/app.js', status: 200, sha256: sha256('// the bootloader\n') }] });
    expect(json(appJs)['code']).toBe('INSTALL_EXPOSED');
    await cleanExposure(b, c);

    const refusal = async (body: unknown) => {
      const reply = await post(b, '/install/api/config', body);
      return { status: reply.status, code: json(reply)['code'], reason: json(reply)['reason'] };
    };
    expect(await refusal(configBody(b, p, { baseUrl: `${b.origin}/perpus` }))).toEqual({ status: 422, code: 'INVALID_BASE_URL', reason: 'path' });
    expect(await refusal(configBody(b, p, { baseUrl: `http://localhost:${port}` }))).toEqual({
      status: 422,
      code: 'INVALID_BASE_URL',
      reason: 'origin_mismatch',
    });
    const forged = { nonce: p.nonce, hmac: hmacB64u(randomBytes(32).toString('base64url'), `probe:${p.nonce}`) };
    expect(await refusal(configBody(b, forged))).toEqual({ status: 422, code: 'INVALID_BASE_URL', reason: 'probe_failed' });

    // A database that holds another application's table.
    const h = await openDb();
    try {
      await h.db.schema.createTable('other_app').addColumn('id', 'integer').execute();
      const tested = await post(b, '/install/api/db/test', { db: dbBody() });
      expect(tested.json).toMatchObject({ ok: true, empty: false, resumable: false });
      expect(await refusal(configBody(b, p))).toEqual({ status: 409, code: 'DB_NOT_EMPTY', reason: undefined });
      expect(await exists(path.join(dirs.dataDir, 'config.json'))).toBe(false);
      await h.db.schema.dropTable('other_app').execute();
    } finally {
      await h.close();
    }

    // A step before its time.
    expect(json(await post(b, '/install/api/profile', { library: { name: 'X', timezone: 'Asia/Jakarta', locale: 'id' }, branch: {} }))['code']).toBe(
      'INSTALL_STEP_ORDER',
    );
    expect(json(await post(b, '/install/api/migrate'))['code']).toBe('INSTALL_STEP_ORDER');
    expect((await post(b, '/install/api/config', configBody(b, p))).json).toEqual({ installState: 'migrate' });
    const first = json<MigrateResponse>(await post(b, '/install/api/migrate'));
    expect(first).toEqual({ done: false, applied: KNOWN[0], remaining: KNOWN.length - 1 });
    const early = await post(b, '/install/api/profile', { library: { name: 'X', timezone: 'Asia/Jakarta', locale: 'id' }, branch: {} });
    expect(early.status).toBe(409);
    expect(json(early)['code']).toBe('INSTALL_STEP_ORDER');
    // The exposure and config steps are over once the migrations began... config may still run again (a resume).
    expect((await post(b, '/install/api/config', configBody(b, p))).json).toEqual({ installState: 'migrate' });
  }, 120_000);

  it('P20: SQLite on passenger is refused by db/test and config (422 SQLITE_NOT_ALLOWED)', async () => {
    const { port } = await server('passenger');
    const b = browser(port);
    expect((await claim(b)).status).toBe(200);
    await cleanExposure(b, await checks(b));
    const tested = await post(b, '/install/api/db/test', { db: { dialect: 'sqlite' } });
    expect(tested.status).toBe(422);
    expect(json(tested)['code']).toBe('SQLITE_NOT_ALLOWED');
    const config = await post(b, '/install/api/config', configBody(b, await probe(b), { db: { dialect: 'sqlite' } }));
    expect(config.status).toBe(422);
    expect(json(config)['code']).toBe('SQLITE_NOT_ALLOWED');
    expect(await exists(path.join(dirs.dataDir, 'config.json'))).toBe(false);
  }, 60_000);

  it('S12: a process started before config.json existed answers / with 302 until finish, then boots on its next request', async () => {
    // Both processes leave the work to the cron URL (no worker loops on one database).
    vi.stubEnv('ALTIS_RUNNER', 'off');
    const wizard = await server();
    const early = await server();
    const b = browser(wizard.port);
    const e = browser(early.port, b.origin);
    expect((await e.agent.get('/')).headers.get('location')).toBe('/install');

    await throughConfig(b);
    expect((await e.agent.get('/')).headers.get('location')).toBe('/install');
    await migrateToCron(b);
    expect((await e.agent.get('/')).headers.get('location')).toBe('/install');

    // The clock stands still from here: the early process boots without any 2 s wait passing.
    vi.useFakeTimers({ toFake: ['Date'], now: Date.now() });
    expect((await post(b, '/install/api/finish')).status).toBe(200);
    const next = await e.agent.get('/');
    expect([200, 503]).toContain(next.status);
    await vi.waitFor(
      async () => {
        const home = await e.agent.get('/');
        expect(home.status).toBe(200);
        expect(home.headers.get('content-type')).toMatch(/^text\/html/);
      },
      { timeout: 5000, interval: 25 },
    );
    expect((await e.agent.get('/_health')).status).toBe(200);
    expect(early.ctx.requestRestart).not.toHaveBeenCalled();
    expect((await e.agent.get('/install/api/checks')).status).toBe(404);
  }, 120_000);

  it('A2: an install interrupted after config resumes in a new process: a new code, a new claim, the steps to finish', async () => {
    // The killed process ran 25 h before this one (ALTIS_TEST_CLOCK_OFFSET_MS, M23): its code, its claim and its op are
    // that old here.
    const child = await serverChild(-DAY_MS - 3_600_000);
    let oldCode: string;
    try {
      const b = browser(child.port);
      await throughConfig(b);
      oldCode = await installCode();
    } finally {
      child.process.kill('SIGKILL');
      await child.exited;
    }
    expect((await readJson(path.join(dirs.dataDir, 'config.json')))['installState']).toBe('migrate');

    const { port } = await server();
    const b = browser(port, `http://127.0.0.1:${child.port}`);
    expect((await b.agent.get('/install')).status).toBe(200);
    const newCode = await installCode();
    expect(newCode).not.toBe(oldCode);
    expect(stdout.mock.calls.some(([text]) => String(text).includes(newCode.slice(0, 5)))).toBe(true);
    const refused = await b.agent.post('/install/api/claim', { code: oldCode });
    expect(refused.status).toBe(403);
    expect(json(refused)['code']).toBe('INSTALL_CODE_INVALID');
    expect((await claim(b, newCode)).json).toMatchObject({ installState: 'migrate' });
    expect((await checks(b)).installState).toBe('migrate');

    const cron = await migrateToCron(b);
    expect(cron.detected).toBe(true);
    expect((await post(b, '/install/api/finish')).status).toBe(200);
    await vi.waitFor(async () => expect((await b.agent.get('/_health')).status).toBe(200), { timeout: 2000, interval: 25 });
    expect((await signIn(b)).status).toBe(200);
  }, 120_000);
});

/** A server child (fixtures/runtime-child.mjs) over DATA_DIR with its clock `offsetMs` off. */
async function serverChild(offsetMs: number): Promise<{ process: ChildProcess; port: number; exited: Promise<unknown> }> {
  const child = fork(path.join(import.meta.dirname, '..', 'fixtures', 'runtime-child.mjs'), [JSON.stringify({ dataDir: dirs.dataDir, appRoot, runtime: RUNTIME })], {
    cwd: path.resolve(import.meta.dirname, '../../../..'),
    env: { PATH: process.env['PATH'] ?? '', HOME: process.env['HOME'] ?? '', ALTIS_TEST_CLOCK_OFFSET_MS: String(offsetMs) },
    execArgv: ['--import', 'tsx'],
    stdio: ['ignore', 'pipe', 'pipe', 'ipc'],
  });
  child.stdout?.resume(); // the install code it prints
  let stderr = '';
  child.stderr?.on('data', (chunk: Buffer) => {
    stderr += chunk.toString('utf8');
  });
  const exited = new Promise((resolve) => child.once('exit', resolve));
  const port = await new Promise<number>((resolve, reject) => {
    child.once('message', (m) => resolve((m as { port: number }).port));
    child.once('exit', (code, signal) => reject(new Error(`server child exited (${String(code ?? signal)}): ${stderr}`)));
  });
  return { process: child, port, exited };
}
