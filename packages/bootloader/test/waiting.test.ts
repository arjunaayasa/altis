import { createHash } from 'node:crypto';
import fsp from 'node:fs/promises';
import http from 'node:http';
import os from 'node:os';
import path from 'node:path';
import vm from 'node:vm';
import * as acorn from 'acorn';
import { MESSAGES, NEEDS_ATTENTION, OP_KINDS, OP_STATES, newId } from '@altis/shared';
import type { OpView } from '@altis/shared/api/ops';
import type { UpdateStatusView } from '@altis/shared/api/updates';
import { afterAll, afterEach, beforeAll, beforeEach, describe, expect, it, vi } from 'vitest';
import { buildBootloader } from '../src/build.js';
import type { BootLog } from '../src/log.js';
import {
  OPS_CURRENT_PATH,
  POLL_MS,
  UPDATE_PAGE_PATH,
  UPDATE_STATUS_PATH,
  WAITING_RETRY_AFTER_S,
  stateLabel,
  waitingHandler,
} from '../src/waiting.js';

// §9.2 step 6 (1d Task 22; Review Focus 4): a process that does not hold releases/boot.lock while another one boots the
// pending release answers, straight from DATA_DIR/ops/op.json and releases/current.json, `GET /api/v1/ops/current`,
// `GET /api/v1/updates/status` and `/admin/_update` to the holder of the op's `altis_ops` cookie, `/_health` 503
// `maintenance`, and a static 503 page with `Retry-After: 5` for anything else. Every request is the retry trigger of
// waitForBootLock (pending.ts).

const TOKEN = 't';
const PENDING = '0.2.0-test';
const ACTIVE = '0.1.0-test';
const HOUR_MS = 3_600_000;

const sha256hex = (s: string): string => createHash('sha256').update(s, 'utf8').digest('hex');

const silent: BootLog = {
  debug() {},
  info() {},
  warn() {},
  error() {},
  child() {
    return silent;
  },
};

let dataDir: string;
const servers: http.Server[] = [];

beforeEach(async () => {
  dataDir = await fsp.realpath(await fsp.mkdtemp(path.join(os.tmpdir(), 'altis-waiting-')));
});

afterEach(async () => {
  vi.restoreAllMocks();
  await Promise.all(
    servers.splice(0).map(
      (server) =>
        new Promise<void>((resolve) => {
          server.close(() => resolve());
          server.closeAllConnections();
        }),
    ),
  );
  await fsp.rm(dataDir, { recursive: true, force: true });
});

async function writeJson(file: string, value: unknown): Promise<void> {
  await fsp.mkdir(path.dirname(file), { recursive: true });
  await fsp.writeFile(file, `${JSON.stringify(value, null, 2)}\n`);
}

const opFile = (): string => path.join(dataDir, 'ops', 'op.json');

/** The server's `update` op of 0.2.0-test in `migrating` at 40 %, its `altis_ops` token `t`, with a field app.js does not know. */
function updateOp(o: Record<string, unknown> = {}): Record<string, unknown> {
  const now = Date.now();
  const op: Record<string, unknown> = {
    opSchema: 1,
    opId: newId(),
    kind: 'update',
    actor: { type: 'staff', id: newId() },
    state: 'migrating',
    version: PENDING,
    backupId: newId(),
    heartbeatAt: now - 1000,
    startedAt: now - 60_000,
    finishedAt: null,
    error: null,
    opsTokenHash: sha256hex(TOKEN),
    pointOfNoReturn: true,
    params: { target: PENDING, source: 'feed', from: ACTIVE, pendingWritten: true },
    progress: 40,
    message: 'Migrasi 3/7',
    secretParam: 'sealed-secret-never-shown',
    futureField: 'kept',
  };
  for (const key of Object.keys(o)) op[key] = o[key];
  return op;
}

async function writeCurrent(): Promise<void> {
  await writeJson(path.join(dataDir, 'releases', 'current.json'), {
    schema: 1,
    active: { version: ACTIVE, source: 'bundled' },
    previous: null,
    pending: { version: PENDING, source: 'data' },
    pendingSince: Date.now() - 5000,
    pinned: null,
  });
}

interface Served {
  port: number;
  onRequest: ReturnType<typeof vi.fn>;
}

async function serve(o: { onRequest?: () => void; log?: BootLog } = {}): Promise<Served> {
  const onRequest = vi.fn(o.onRequest ?? (() => {}));
  const server = http.createServer(waitingHandler({ dataDir, log: o.log ?? silent, onRequest }));
  servers.push(server);
  await new Promise<void>((resolve) => server.listen(0, '127.0.0.1', resolve));
  return { port: (server.address() as { port: number }).port, onRequest };
}

interface Reply {
  status: number;
  headers: http.IncomingHttpHeaders;
  body: string;
}

function request(port: number, urlPath: string, o: { method?: string; cookie?: string; body?: string } = {}): Promise<Reply> {
  return new Promise((resolve, reject) => {
    const headers: http.OutgoingHttpHeaders = {};
    if (o.cookie !== undefined) headers['Cookie'] = o.cookie;
    const req = http.request({ host: '127.0.0.1', port, path: urlPath, method: o.method ?? 'GET', headers, agent: false }, (res) => {
      let body = '';
      res.setEncoding('utf8');
      res.on('data', (chunk: string) => (body += chunk));
      res.on('end', () => resolve({ status: res.statusCode ?? 0, headers: res.headers, body }));
      res.on('error', reject);
    });
    req.on('error', reject);
    req.end(o.body);
  });
}

const json = (reply: Reply): Record<string, unknown> => JSON.parse(reply.body) as Record<string, unknown>;

function expectOpsAuthRequired(reply: Reply): void {
  expect(reply.status).toBe(401);
  expect(reply.headers['content-type']).toMatch(/^application\/problem\+json/);
  expect(reply.headers['cache-control']).toBe('no-store');
  const body = json(reply);
  expect(body).toMatchObject({ type: 'about:blank', status: 401, code: 'OPS_AUTH_REQUIRED' });
  expect(typeof body['traceId']).toBe('string');
  expect(reply.body).not.toContain('opsTokenHash');
}

describe('GET /api/v1/ops/current from op.json (§9.2 step 6)', () => {
  it('altis_ops=t: 200 with the OpView fields of /admin/_update, mode external, no CSRF token, not driveable', async () => {
    const op = updateOp();
    await writeJson(opFile(), op);
    const { port } = await serve();
    const reply = await request(port, OPS_CURRENT_PATH, { cookie: `altis_ops=${TOKEN}` });
    expect(reply.status).toBe(200);
    expect(reply.headers['content-type']).toMatch(/^application\/json/);
    expect(reply.headers['cache-control']).toBe('no-store');
    expect(reply.headers['x-altis-serving']).toBe('app');
    expect(json(reply)).toEqual({
      opId: op['opId'],
      kind: 'update',
      state: 'migrating',
      terminal: false,
      needsAttention: false,
      startedAt: op['startedAt'],
      heartbeatAt: op['heartbeatAt'],
      finishedAt: null,
      progress: 40,
      message: 'Migrasi 3/7',
      error: null,
      pointOfNoReturn: true,
      backupId: op['backupId'],
      actor: op['actor'],
      mode: 'external',
      csrfToken: null,
      driveable: false,
    });
    // Exactly the keys of OpView (a compile-time list of them), but the optional `update` the server adds for an update op
    // (1d Task 29: op.json's params, which app.js never reads into a view).
    const keys: Record<Exclude<keyof OpView, 'update'>, true> = {
      opId: true,
      kind: true,
      state: true,
      terminal: true,
      needsAttention: true,
      startedAt: true,
      heartbeatAt: true,
      finishedAt: true,
      progress: true,
      message: true,
      error: true,
      pointOfNoReturn: true,
      backupId: true,
      actor: true,
      mode: true,
      csrfToken: true,
      driveable: true,
    };
    expect(Object.keys(json(reply)).sort()).toEqual(Object.keys(keys).sort());
    // Nothing else of op.json leaves the server: no hash, no secret, no params.
    expect(reply.body).not.toContain('sealed-secret');
    expect(reply.body).not.toContain(sha256hex(TOKEN));
    expect(reply.body).not.toContain('pendingWritten');
  });

  it('the __Host- cookie works the same, among other cookies; a quoted or percent-encoded value too', async () => {
    await writeJson(opFile(), updateOp({ state: 'verifying', progress: 90 }));
    const { port } = await serve();
    for (const cookie of [`altis_sid=x; __Host-altis_ops=${TOKEN}`, `altis_ops="${TOKEN}"`, 'altis_ops=%74', `altis_ops=wrong; __Host-altis_ops=${TOKEN}`]) {
      const reply = await request(port, OPS_CURRENT_PATH, { cookie });
      expect(reply.status, cookie).toBe(200);
      expect(json(reply), cookie).toMatchObject({ state: 'verifying', progress: 90 });
    }
  });

  it('a wrong cookie, none, an empty one, or another cookie name → 401 OPS_AUTH_REQUIRED problem+json', async () => {
    await writeJson(opFile(), updateOp());
    const { port } = await serve();
    for (const cookie of [undefined, 'altis_ops=wrong', 'altis_ops=', `altis_sid=${TOKEN}`, `xaltis_ops=${TOKEN}`, `altis_ops=${'t'.repeat(300)}`]) {
      expectOpsAuthRequired(await request(port, OPS_CURRENT_PATH, cookie === undefined ? {} : { cookie }));
    }
  });

  it('an op that ended 61 minutes ago → 401; one that ended 59 minutes ago → 200, terminal', async () => {
    const now = Date.now();
    await writeJson(opFile(), updateOp({ state: 'done', progress: 100, heartbeatAt: now - 61 * 60_000, finishedAt: now - 61 * 60_000 }));
    const { port } = await serve();
    expectOpsAuthRequired(await request(port, OPS_CURRENT_PATH, { cookie: `altis_ops=${TOKEN}` }));

    await writeJson(opFile(), updateOp({ state: 'done', progress: 100, heartbeatAt: now - 59 * 60_000, finishedAt: now - 59 * 60_000 }));
    const reply = await request(port, OPS_CURRENT_PATH, { cookie: `altis_ops=${TOKEN}` });
    expect(reply.status).toBe(200);
    expect(json(reply)).toMatchObject({ state: 'done', terminal: true, driveable: false, finishedAt: now - 59 * 60_000 });
  });

  it('an op that has not ended stays open to its cookie however old its last step (needs_attention after 15 min)', async () => {
    const now = Date.now();
    await writeJson(opFile(), updateOp({ state: NEEDS_ATTENTION, stateBefore: 'migrating', heartbeatAt: now - 3 * HOUR_MS }));
    const { port } = await serve();
    const reply = await request(port, OPS_CURRENT_PATH, { cookie: `altis_ops=${TOKEN}` });
    expect(reply.status).toBe(200);
    expect(json(reply)).toMatchObject({ state: NEEDS_ATTENTION, needsAttention: true, terminal: false, driveable: false });
  });

  it('no op.json, an op nobody may drive by cookie, one that is not opSchema 1, or op.json and its .bak unusable → 401', async () => {
    const { port } = await serve();
    const cookie = `altis_ops=${TOKEN}`;
    expectOpsAuthRequired(await request(port, OPS_CURRENT_PATH, { cookie }));
    await writeJson(opFile(), updateOp({ opsTokenHash: null }));
    expectOpsAuthRequired(await request(port, OPS_CURRENT_PATH, { cookie }));
    await writeJson(opFile(), updateOp({ opSchema: 2 }));
    expectOpsAuthRequired(await request(port, OPS_CURRENT_PATH, { cookie }));
    await writeJson(opFile(), updateOp({ opsTokenHash: sha256hex(TOKEN).toUpperCase() }));
    expectOpsAuthRequired(await request(port, OPS_CURRENT_PATH, { cookie }));
    await fsp.writeFile(opFile(), '{"opSchema": 1, "torn');
    expectOpsAuthRequired(await request(port, OPS_CURRENT_PATH, { cookie }));
  });

  it('a torn op.json: its .bak answers', async () => {
    await writeJson(`${opFile()}.bak`, updateOp({ progress: 35 }));
    await fsp.writeFile(opFile(), '{"opSchema": 1, "torn');
    const { port } = await serve();
    const reply = await request(port, OPS_CURRENT_PATH, { cookie: `altis_ops=${TOKEN}` });
    expect(reply.status).toBe(200);
    expect(json(reply)).toMatchObject({ progress: 35 });
  });

  it('HEAD: the same status and headers, no body', async () => {
    await writeJson(opFile(), updateOp());
    const { port } = await serve();
    const reply = await request(port, OPS_CURRENT_PATH, { method: 'HEAD', cookie: `altis_ops=${TOKEN}` });
    expect(reply.status).toBe(200);
    expect(reply.headers['x-altis-serving']).toBe('app');
    expect(reply.body).toBe('');
  });
});

describe('GET /api/v1/updates/status from op.json and current.json (§9.2 step 6)', () => {
  it('UpdateStatusView: the op, the releases of current.json, serving app', async () => {
    const op = updateOp();
    await writeJson(opFile(), op);
    await writeCurrent();
    const { port } = await serve();
    const reply = await request(port, UPDATE_STATUS_PATH, { cookie: `altis_ops=${TOKEN}` });
    expect(reply.status).toBe(200);
    expect(reply.headers['x-altis-serving']).toBe('app');
    expect(reply.headers['cache-control']).toBe('no-store');
    const view = json(reply) as unknown as UpdateStatusView;
    expect(view.releases).toEqual({ active: ACTIVE, previous: null, pending: PENDING, pinned: null });
    expect(view.serving).toBe('app');
    expect(view.op).toMatchObject({ opId: op['opId'], kind: 'update', state: 'migrating', progress: 40, terminal: false });
    expect(Object.keys(view).sort()).toEqual(['op', 'releases', 'serving']);
    // The op of an UpdateStatusView is an OpStatusView: no mode, CSRF token or driveable.
    expect(view.op).not.toHaveProperty('mode');
    expect(view.op).not.toHaveProperty('csrfToken');
  });

  it('without a valid cookie → 401 OPS_AUTH_REQUIRED', async () => {
    await writeJson(opFile(), updateOp());
    await writeCurrent();
    const { port } = await serve();
    expectOpsAuthRequired(await request(port, UPDATE_STATUS_PATH));
    expectOpsAuthRequired(await request(port, UPDATE_STATUS_PATH, { cookie: 'altis_ops=nope' }));
  });

  it('current.json that cannot be read: 503 with Retry-After, never a made-up release', async () => {
    await writeJson(opFile(), updateOp());
    const { port } = await serve();
    const reply = await request(port, UPDATE_STATUS_PATH, { cookie: `altis_ops=${TOKEN}` });
    expect(reply.status).toBe(503);
    expect(reply.headers['retry-after']).toBe(String(WAITING_RETRY_AFTER_S));
  });
});

/** The nonce of `source` in `policy` (`'nonce-<n>'` of the directive `directive`). */
function nonceOf(policy: string, directive: string): string | null {
  const part = policy
    .split(';')
    .map((p) => p.trim())
    .find((p) => p.startsWith(`${directive} `));
  const match = part === undefined ? null : /'nonce-([^']+)'/.exec(part);
  return match === null ? null : (match[1] as string);
}

/** The text of every inline `<script>` of `html`, with its nonce attribute. */
function scriptsOf(html: string): { nonce: string | null; text: string }[] {
  const out: { nonce: string | null; text: string }[] = [];
  const re = /<script([^>]*)>([\s\S]*?)<\/script>/g;
  for (let m = re.exec(html); m !== null; m = re.exec(html)) {
    const nonce = /\snonce="([^"]*)"/.exec(m[1] as string);
    out.push({ nonce: nonce === null ? null : (nonce[1] as string), text: m[2] as string });
  }
  return out;
}

/** Every start tag of `html` outside script and style bodies. */
function tagsOf(html: string): string[] {
  const outside = html.replace(/<(script|style)([^>]*)>[\s\S]*?<\/\1>/g, '<$1$2>');
  return outside.match(/<[a-zA-Z][^>]*>/g) ?? [];
}

describe('GET /admin/_update (§9.2 step 6)', () => {
  it('a minimal bilingual page: its inline script and style carry the nonce of its CSP; no on* attribute, no eval', async () => {
    await writeJson(opFile(), updateOp());
    const { port } = await serve();
    const reply = await request(port, UPDATE_PAGE_PATH, { cookie: `altis_ops=${TOKEN}` });
    expect(reply.status).toBe(200);
    expect(reply.headers['content-type']).toMatch(/^text\/html/);
    expect(reply.headers['cache-control']).toBe('no-store');
    expect(reply.headers['x-altis-serving']).toBe('app');
    const policy = reply.headers['content-security-policy'] as string;
    const nonce = nonceOf(policy, 'script-src');
    expect(nonce).toMatch(/^[A-Za-z0-9_-]{22}$/);
    expect(nonceOf(policy, 'style-src')).toBe(nonce);
    expect(policy).toContain("default-src 'none'");
    expect(policy).toContain("connect-src 'self'");
    expect(policy).not.toContain('unsafe-inline');
    expect(policy).not.toContain('unsafe-eval');

    const scripts = scriptsOf(reply.body);
    expect(scripts).toHaveLength(1);
    expect(scripts[0]?.nonce).toBe(nonce);
    expect(/<style nonce="([^"]*)">/.exec(reply.body)?.[1]).toBe(nonce);
    for (const tag of tagsOf(reply.body)) expect(tag).not.toMatch(/\son[a-z]*\s*=/i);
    expect(reply.body).not.toContain('eval(');
    expect(reply.body).not.toContain('Function(');
    expect(reply.body).not.toContain('innerHTML');

    // Bilingual, Indonesian first, the stage named in both languages from the shared catalogs.
    expect(reply.body).toMatch(/<html lang="id">/);
    expect(reply.body.indexOf('lang="id"')).toBeLessThan(reply.body.indexOf('lang="en"'));
    expect(reply.body).toContain(MESSAGES.id['ops.state.migrating']);
    expect(reply.body).toContain(MESSAGES.en['ops.state.migrating']);
    expect(reply.body).toContain('40%');

    // A fresh nonce per response.
    const again = await request(port, UPDATE_PAGE_PATH, { cookie: `altis_ops=${TOKEN}` });
    expect(nonceOf(again.headers['content-security-policy'] as string, 'script-src')).not.toBe(nonce);
  });

  it("escapes what op.json says (the message, the error's code and detail)", async () => {
    await writeJson(opFile(), updateOp({ message: '<img src=x onerror=alert(1)>', error: { code: 'UPDATE_BOOT_FAILED', detail: '</script><b>"x"</b>' } }));
    const { port } = await serve();
    const reply = await request(port, UPDATE_PAGE_PATH, { cookie: `altis_ops=${TOKEN}` });
    expect(reply.status).toBe(200);
    expect(reply.body).not.toContain('<img');
    expect(reply.body).not.toContain('<b>');
    expect(reply.body).toContain('&lt;img src=x onerror=alert(1)&gt;');
    expect(reply.body).toContain('UPDATE_BOOT_FAILED');
    expect(scriptsOf(reply.body)).toHaveLength(1);
  });

  it('without a valid cookie: a 401 HTML page that reloads by itself, no script', async () => {
    await writeJson(opFile(), updateOp());
    const { port } = await serve();
    for (const cookie of [undefined, 'altis_ops=nope']) {
      const reply = await request(port, UPDATE_PAGE_PATH, cookie === undefined ? {} : { cookie });
      expect(reply.status).toBe(401);
      expect(reply.headers['content-type']).toMatch(/^text\/html/);
      expect(reply.headers['cache-control']).toBe('no-store');
      expect(reply.body).toContain('<meta http-equiv="refresh" content="5">');
      expect(reply.body).toMatch(/<section lang="id">[\s\S]*<section lang="en">/);
      expect(scriptsOf(reply.body)).toEqual([]);
    }
  });
});

// The page's script, run against a fake browser: XMLHttpRequest, timers, the elements it writes and location.reload.

interface FakeXhr {
  method: string;
  url: string;
  respond(status: number, body: unknown, headers?: Record<string, string>): void;
}

interface FakePage {
  timers: { fn: () => void; ms: number }[];
  requests: FakeXhr[];
  reload: ReturnType<typeof vi.fn>;
  text(id: string): string;
  value(id: string): unknown;
  /** Runs the last timer the script set (there must be exactly one pending). */
  tick(): void;
}

function runPage(html: string): FakePage {
  const [script] = scriptsOf(html);
  if (script === undefined) throw new Error('no script');
  const elements = new Map<string, { textContent: string; value: unknown }>();
  for (const m of html.matchAll(/\sid="([^"]+)"/g)) elements.set(m[1] as string, { textContent: '', value: undefined });
  const timers: FakePage['timers'] = [];
  const requests: FakeXhr[] = [];
  const reload = vi.fn();
  class XMLHttpRequest {
    status = 0;
    responseText = '';
    timeout = 0;
    private headers: Record<string, string> = {};
    private listeners: Record<string, (() => void)[]> = {};
    open(method: string, url: string): void {
      requests.push({
        method,
        url,
        respond: (status, body, headers = {}) => {
          this.status = status;
          this.responseText = typeof body === 'string' ? body : JSON.stringify(body);
          this.headers = Object.fromEntries(Object.entries(headers).map(([k, v]) => [k.toLowerCase(), v]));
          for (const fn of this.listeners['loadend'] ?? []) fn();
        },
      });
    }
    setRequestHeader(): void {}
    getResponseHeader(name: string): string | null {
      return this.headers[name.toLowerCase()] ?? null;
    }
    addEventListener(type: string, fn: () => void): void {
      (this.listeners[type] ??= []).push(fn);
    }
    send(): void {}
  }
  const context = vm.createContext({
    window: { location: { reload } },
    document: { getElementById: (id: string) => elements.get(id) ?? null },
    XMLHttpRequest,
    setTimeout: (fn: () => void, ms: number) => {
      timers.push({ fn, ms });
      return timers.length;
    },
  });
  vm.runInContext(script.text, context);
  return {
    timers,
    requests,
    reload,
    text: (id) => elements.get(id)?.textContent ?? '',
    value: (id) => elements.get(id)?.value,
    tick() {
      const timer = timers.shift();
      if (timer === undefined) throw new Error('no timer is pending');
      expect(timers).toEqual([]);
      timer.fn();
    },
  };
}

async function pageFor(o: Record<string, unknown> = {}): Promise<string> {
  await writeJson(opFile(), updateOp(o));
  const { port } = await serve();
  const reply = await request(port, UPDATE_PAGE_PATH, { cookie: `altis_ops=${TOKEN}` });
  expect(reply.status).toBe(200);
  return reply.body;
}

const opJson = (state: string, o: Record<string, unknown> = {}): Record<string, unknown> => ({
  opId: newId(),
  kind: 'update',
  state,
  terminal: ['done', 'aborted', 'rolled_back', 'restored', 'restore_failed'].includes(state),
  needsAttention: state === NEEDS_ATTENTION,
  progress: 50,
  message: null,
  error: null,
  ...o,
});

describe("/admin/_update's script (polls only: GET events answers 503 in this phase, preflight 1D-27)", () => {
  it(`polls ops/current every ${POLL_MS} ms and shows what it answers`, async () => {
    expect(POLL_MS).toBe(2000);
    const page = runPage(await pageFor());
    expect(page.timers.map((t) => t.ms)).toEqual([2000]);
    page.tick();
    expect(page.requests).toHaveLength(1);
    expect(page.requests[0]).toMatchObject({ method: 'GET', url: OPS_CURRENT_PATH });
    page.requests[0]?.respond(200, opJson('verifying', { progress: 80.4, message: 'Memeriksa', error: { code: 'X_CODE', detail: 'why' } }), {
      'X-Altis-Serving': 'app',
    });
    expect(page.text('state-id')).toBe(MESSAGES.id['ops.state.verifying']);
    expect(page.text('state-en')).toBe(MESSAGES.en['ops.state.verifying']);
    expect(page.value('progress')).toBe(80);
    expect(page.text('progress-text')).toBe('80%');
    expect(page.text('message')).toBe('Memeriksa');
    expect(page.text('error')).toBe('X_CODE: why');
    expect(page.reload).not.toHaveBeenCalled();
    expect(page.timers.map((t) => t.ms)).toEqual([2000]);
  });

  it('reloads as soon as an answer carries X-Altis-Serving: server, whatever its status', async () => {
    for (const status of [200, 401, 404]) {
      const page = runPage(await pageFor());
      page.tick();
      page.requests[0]?.respond(status, status === 200 ? opJson('migrating') : { code: 'OPS_NONE' }, { 'X-Altis-Serving': 'server' });
      expect(page.reload, String(status)).toHaveBeenCalledTimes(1);
      expect(page.timers).toEqual([]);
    }
  });

  it('reloads once the op it followed is terminal', async () => {
    const page = runPage(await pageFor());
    page.tick();
    page.requests[0]?.respond(200, opJson('verifying'));
    expect(page.reload).not.toHaveBeenCalled();
    page.tick();
    page.requests[1]?.respond(200, opJson('done', { progress: 100 }));
    expect(page.reload).toHaveBeenCalledTimes(1);
    expect(page.timers).toEqual([]);
  });

  it('a page opened on an op that had already ended does not reload in a loop: it waits for the server', async () => {
    const now = Date.now();
    const page = runPage(await pageFor({ state: 'rolled_back', finishedAt: now - 1000, heartbeatAt: now - 1000 }));
    page.tick();
    page.requests[0]?.respond(200, opJson('rolled_back'), { 'X-Altis-Serving': 'app' });
    expect(page.reload).not.toHaveBeenCalled();
    page.tick();
    page.requests[1]?.respond(200, opJson('rolled_back'), { 'X-Altis-Serving': 'server' });
    expect(page.reload).toHaveBeenCalledTimes(1);
  });

  it('401 from app.js: stops polling and says why; another failure: says it retries, and polls on', async () => {
    const page = runPage(await pageFor());
    page.tick();
    page.requests[0]?.respond(503, '<!doctype html>');
    expect(page.text('status-id')).toBe(MESSAGES.id['ops.page.retrying']);
    expect(page.text('status-en')).toBe(MESSAGES.en['ops.page.retrying']);
    page.tick();
    page.requests[1]?.respond(0, '');
    expect(page.text('status-en')).toBe(MESSAGES.en['ops.page.retrying']);
    page.tick();
    page.requests[2]?.respond(200, opJson('migrating'));
    expect(page.text('status-en')).toBe('');
    page.tick();
    page.requests[3]?.respond(401, { code: 'OPS_AUTH_REQUIRED' });
    expect(page.text('status-id')).toBe(MESSAGES.id['ops.page.lost']);
    expect(page.text('status-en')).toBe(MESSAGES.en['ops.page.lost']);
    expect(page.timers).toEqual([]);
    expect(page.reload).not.toHaveBeenCalled();
  });
});

describe('everything else while waiting', () => {
  it('/_health → 503 {status: maintenance, version: null}', async () => {
    const { port } = await serve();
    const reply = await request(port, '/_health');
    expect(reply.status).toBe(503);
    expect(json(reply)).toEqual({ status: 'maintenance', version: null });
    expect(reply.headers['cache-control']).toBe('no-store');
  });

  it('GET /api/v1/users → the static bilingual 503 page with Retry-After: 5; so are other methods and paths', async () => {
    expect(WAITING_RETRY_AFTER_S).toBe(5);
    await writeJson(opFile(), updateOp());
    const { port } = await serve();
    const cookie = `altis_ops=${TOKEN}`;
    for (const [method, urlPath] of [
      ['GET', '/api/v1/users'],
      ['POST', '/api/v1/ops/drive'],
      ['POST', OPS_CURRENT_PATH],
      ['DELETE', UPDATE_PAGE_PATH],
      ['GET', '/admin'],
      ['POST', '/_cron'],
      ['GET', '/'],
      ['GET', `${OPS_CURRENT_PATH}/x`],
    ] as const) {
      const reply = await request(port, urlPath, { method, cookie, body: method === 'GET' ? undefined : '{}' });
      expect(reply.status, `${method} ${urlPath}`).toBe(503);
      expect(reply.headers['retry-after']).toBe('5');
      expect(reply.headers['content-type']).toMatch(/^text\/html/);
      expect(reply.body).toMatch(/<section lang="id">[\s\S]*<section lang="en">/);
      expect(reply.body).toContain(`href="${UPDATE_PAGE_PATH}"`);
      expect(reply.body).not.toContain('<script');
    }
    const head = await request(port, '/api/v1/users', { method: 'HEAD' });
    expect(head.status).toBe(503);
    expect(head.body).toBe('');
  });

  it('every request calls onRequest once, before it is answered; an onRequest that throws never fails one', async () => {
    await writeJson(opFile(), updateOp());
    await writeCurrent();
    const { port, onRequest } = await serve();
    const cookie = `altis_ops=${TOKEN}`;
    const paths = ['/api/v1/users', '/_health', OPS_CURRENT_PATH, UPDATE_STATUS_PATH, UPDATE_PAGE_PATH, '/api/v1/users'];
    for (let i = 0; i < paths.length; i += 1) {
      await request(port, paths[i] as string, { cookie });
      expect(onRequest).toHaveBeenCalledTimes(i + 1);
    }
    expect(onRequest.mock.calls.every((args) => args.length === 0)).toBe(true);

    const throwing = await serve({
      onRequest: () => {
        throw new Error('the retry failed');
      },
    });
    expect((await request(throwing.port, OPS_CURRENT_PATH, { cookie })).status).toBe(200);
    expect((await request(throwing.port, '/api/v1/users')).status).toBe(503);
    expect(throwing.onRequest).toHaveBeenCalledTimes(2);
  });

  it('op.json that cannot be read (a folder): logged, and the 503 page answers', async () => {
    await fsp.mkdir(opFile(), { recursive: true });
    const warn = vi.fn();
    const log: BootLog = { ...silent, warn };
    const { port } = await serve({ log });
    const reply = await request(port, OPS_CURRENT_PATH, { cookie: `altis_ops=${TOKEN}` });
    expect(reply.status).toBe(503);
    expect(reply.headers['retry-after']).toBe('5');
    expect(warn).toHaveBeenCalledTimes(1);
  });
});

describe('stage labels', () => {
  it('every state of every kind is named in both languages as the shared catalogs name it; an unknown one by itself', () => {
    for (const kind of OP_KINDS) {
      for (const state of [...OP_STATES[kind], NEEDS_ATTENTION]) {
        const key = `ops.state.${state}` as keyof (typeof MESSAGES)['id'];
        expect(stateLabel('id', state)).toBe(MESSAGES.id[key]);
        expect(stateLabel('en', state)).toBe(MESSAGES.en[key]);
      }
    }
    expect(stateLabel('en', 'later_state')).toBe('later_state');
    expect(stateLabel('en', 'constructor')).toBe('constructor');
  });
});

describe('app.js (ES2017, P1)', { timeout: 30_000 }, () => {
  let dir: string;

  beforeAll(async () => {
    dir = await fsp.realpath(await fsp.mkdtemp(path.join(os.tmpdir(), 'altis-waiting-build-')));
  });

  afterAll(async () => {
    await fsp.rm(dir, { recursive: true, force: true });
  });

  it('bundles waiting.ts, nothing of apps/, and stays an ES2017 script', async () => {
    const outfile = path.join(dir, 'app.js');
    const result = await buildBootloader({ profile: 'test', outfile, bundledVersion: '0.1.0-test' });
    const inputs = Object.keys(result.metafile.inputs).map((input) => input.split(path.sep).join('/'));
    expect(inputs).toContain('packages/bootloader/src/waiting.ts');
    expect(inputs.filter((input) => input.startsWith('apps/'))).toEqual([]);
    const text = await fsp.readFile(outfile, 'utf8');
    expect(() => acorn.parse(text, { ecmaVersion: 2017, sourceType: 'script' })).not.toThrow();
  });
});
