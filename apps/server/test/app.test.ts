import { connect, type DbHandle } from '@altis/db';
import { DomainError, isUlid } from '@altis/shared';
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import { createApp, type AppState } from '../src/app.js';
import { recordingLogger, useDataDir } from './support.js';

// The HTTP app (Task 14): /_health per phase, problem+json (ruling R53), request id and security headers on every
// response. Driven through Hono's app.request(); no socket.

const VERSION = '0.1.0';
const NOT_INSTALLED_DETAIL = 'Jalankan / Run: node app.js install --config <file>';
const PROBLEM_TYPE = 'application/problem+json';

function setup(state: AppState, o: { baseUrl?: string } = {}) {
  const log = recordingLogger();
  const app = createApp({ state, version: VERSION, buildId: 'b1d0001', log, ...o });
  return { app, log };
}

/**
 * A database whose every statement hangs (`hang`) or fails (`fail`), whatever the builder chain: any property is
 * the chain again, and `execute*` / `executeQuery` settle as asked.
 */
function brokenDb(mode: 'hang' | 'fail'): DbHandle {
  const settle = (): Promise<never> => (mode === 'hang' ? new Promise<never>(() => {}) : Promise.reject(new Error('connection refused')));
  const chain: unknown = new Proxy(function chain() {}, {
    get: (_target, prop) => (prop === 'then' ? undefined : String(prop).startsWith('execute') ? settle : chain),
    apply: () => chain,
  });
  return {
    db: chain as DbHandle['db'],
    dialect: 'mariadb',
    limits: { maxUserConnections: 0, maxConnections: 100 },
    poolSize: 8,
    close: async () => {},
  };
}

async function json(res: Response): Promise<Record<string, unknown>> {
  return (await res.json()) as Record<string, unknown>;
}

describe('/_health', () => {
  const dirs = useDataDir();
  let db: DbHandle | undefined;

  afterEach(async () => {
    await db?.close();
    db = undefined;
    vi.useRealTimers();
  });

  it('ready with a working database: 200 {status:"ok", version} after a live query', async () => {
    db = await connect({ dialect: 'sqlite' }, { runtime: 'standalone', purpose: 'server', dataDir: dirs.dataDir });
    const { app } = setup({ phase: 'ready', db });
    const res = await app.request('/_health');
    expect(res.status).toBe(200);
    expect(res.headers.get('content-type')).toMatch(/^application\/json/);
    expect(res.headers.get('cache-control')).toBe('no-store');
    expect(await json(res)).toEqual({ status: 'ok', version: VERSION });
  });

  it.each([
    ['not_installed', 'not_installed'],
    ['db_unavailable', 'db_unavailable'],
    ['too_old', 'schema_too_new'],
    ['starting', 'starting'],
  ] as const)('phase %s: 503 {status:"%s", version} and nothing else', async (phase, status) => {
    const { app } = setup({ phase });
    const res = await app.request('/_health');
    expect(res.status).toBe(503);
    expect(await json(res)).toEqual({ status, version: VERSION });
    expect(res.headers.get('retry-after')).toBeNull();
  });

  it('ready but the live query fails: 503 db_unavailable, the phase stays ready', async () => {
    vi.useFakeTimers({ toFake: ['Date'] });
    db = await connect({ dialect: 'sqlite' }, { runtime: 'standalone', purpose: 'server', dataDir: dirs.dataDir });
    const state: AppState = { phase: 'ready', db };
    const { app } = setup(state);
    expect((await app.request('/_health')).status).toBe(200);
    await db.close(); // the database goes away: every statement now fails
    // The 200 is reused for 1 s (L48, health.test.ts); the next live check comes after that.
    vi.setSystemTime(Date.now() + 1000);
    const res = await app.request('/_health');
    expect(res.status).toBe(503);
    expect(await json(res)).toEqual({ status: 'db_unavailable', version: VERSION });
    expect(state.phase).toBe('ready');
    expect(state.db).toBe(db);

    const failing = setup({ phase: 'ready', db: brokenDb('fail') });
    expect(await json(await failing.app.request('/_health'))).toEqual({ status: 'db_unavailable', version: VERSION });
  });

  it('ready but the live query hangs: 503 db_unavailable after 2 s, not before', async () => {
    vi.useFakeTimers({ toFake: ['setTimeout', 'clearTimeout'] });
    const { app } = setup({ phase: 'ready', db: brokenDb('hang') });
    let settled = false;
    const pending = Promise.resolve(app.request('/_health')).then((res) => {
      settled = true;
      return res;
    });
    await vi.advanceTimersByTimeAsync(1999);
    expect(settled).toBe(false);
    await vi.advanceTimersByTimeAsync(1);
    const res = await pending;
    expect(res.status).toBe(503);
    expect(await json(res)).toEqual({ status: 'db_unavailable', version: VERSION });
  });

  it('ready without a database handle: 503 db_unavailable', async () => {
    const { app } = setup({ phase: 'ready' });
    expect(await json(await app.request('/_health'))).toEqual({ status: 'db_unavailable', version: VERSION });
  });

  it('answers HEAD like GET, without a body', async () => {
    const { app } = setup({ phase: 'not_installed' });
    const res = await app.request('/_health', { method: 'HEAD' });
    expect(res.status).toBe(503);
    expect(await res.text()).toBe('');
    expect(isUlid(res.headers.get('x-request-id') ?? '')).toBe(true);
  });
});

describe('phases other than ready', () => {
  it('not_installed: GET / and /admin go to the install wizard (1c Task 10)', async () => {
    const { app } = setup({ phase: 'not_installed' });
    for (const path of ['/', '/admin', '/admin/users']) {
      const res = await app.request(path);
      expect(res.status, path).toBe(302);
      expect(res.headers.get('location'), path).toBe('/install');
    }
  });

  it('not_installed: any other path is 503 problem NOT_INSTALLED with the fixed bilingual detail', async () => {
    const { app } = setup({ phase: 'not_installed' });
    for (const [path, method] of [
      ['/', 'POST'],
      ['/katalog', 'GET'],
      ['/api/v1/auth/login', 'POST'],
      ['/_health/x', 'GET'],
    ] as const) {
      const res = await app.request(path, { method });
      expect(res.status, path).toBe(503);
      expect(res.headers.get('content-type')).toBe(PROBLEM_TYPE);
      const body = await json(res);
      expect(body).toEqual({
        type: 'about:blank',
        title: expect.any(String),
        status: 503,
        code: 'NOT_INSTALLED',
        detail: NOT_INSTALLED_DETAIL,
        traceId: res.headers.get('x-request-id'),
      });
    }
  });

  it.each([
    ['starting', 'DB_UNAVAILABLE'],
    ['db_unavailable', 'DB_UNAVAILABLE'],
    ['too_old', 'SCHEMA_TOO_NEW'],
  ] as const)('%s: other paths are 503 problem %s without detail', async (phase, code) => {
    const { app } = setup({ phase });
    const res = await app.request('/api/v1/anything');
    expect(res.status).toBe(503);
    const body = await json(res);
    expect(body).toEqual({ type: 'about:blank', title: expect.any(String), status: 503, code, traceId: res.headers.get('x-request-id') });
    expect(res.headers.get('retry-after')).toBeNull();
  });
});

describe('problem+json (ruling R53)', () => {
  it('an unknown path while ready is 404 problem NOT_FOUND', async () => {
    const { app } = setup({ phase: 'ready' });
    const res = await app.request('/no/such/page?q=1');
    expect(res.status).toBe(404);
    expect(res.headers.get('content-type')).toBe(PROBLEM_TYPE);
    expect(await json(res)).toEqual({
      type: 'about:blank',
      title: expect.any(String),
      status: 404,
      code: 'NOT_FOUND',
      traceId: res.headers.get('x-request-id'),
    });
  });

  it('an unexpected error is 500 INTERNAL: nothing of it in the body, logged with the request id', async () => {
    const { app, log } = setup({ phase: 'ready' });
    app.get('/boom', () => {
      throw new Error('password=hunter2 at /srv/secret/path');
    });
    const res = await app.request('/boom');
    expect(res.status).toBe(500);
    expect(res.headers.get('content-type')).toBe(PROBLEM_TYPE);
    const text = await res.text();
    expect(text).not.toMatch(/hunter2|secret|srv|password/);
    const body = JSON.parse(text) as Record<string, unknown>;
    expect(body).toEqual({ type: 'about:blank', title: expect.any(String), status: 500, code: 'INTERNAL', traceId: res.headers.get('x-request-id') });
    const line = log.lines.find((l) => l.level === 'error');
    expect(line?.fields['requestId']).toBe(body['traceId']);
    expect(line?.fields['path']).toBe('/boom');
  });

  it('an unexpected database driver error is logged with its safe fields only: no message, SQL or value', async () => {
    const { app, log } = setup({ phase: 'ready' });
    const value = 'Budi Santoso 0812-3456-7890';
    app.get('/insert', () => {
      throw Object.assign(new Error(`Incorrect string value: '${value}' for column 'name' at row 1`), {
        code: 'ER_TRUNCATED_WRONG_VALUE_FOR_FIELD',
        errno: 1366,
        sqlState: 'HY000',
        sqlMessage: `Incorrect string value: '${value}' for column 'name' at row 1`,
        sql: `insert into members (name) values ('${value}')`,
      });
    });
    const res = await app.request('/insert');
    expect(res.status).toBe(500);
    expect((await json(res))['code']).toBe('INTERNAL');
    const line = log.lines.find((l) => l.level === 'error');
    expect(line?.fields['err']).toEqual({ name: 'Error', code: 'ER_TRUNCATED_WRONG_VALUE_FOR_FIELD', errno: 1366, sqlState: 'HY000' });
    expect(JSON.stringify(log.lines)).not.toContain('Budi');
  });

  it('a 5xx DomainError whose cause is a raw driver error is logged with that cause reduced to its safe fields', async () => {
    const { app, log } = setup({ phase: 'ready' });
    const raw = Object.assign(new Error('duplicate key value violates unique constraint "uq_members_phone"'), {
      code: '23505',
      severity: 'ERROR',
      constraint: 'uq_members_phone',
      detail: 'Key (phone)=(0812-3456-7890) already exists.',
    });
    app.get('/dup', () => {
      throw new DomainError('INTERNAL', { cause: raw });
    });
    expect((await app.request('/dup')).status).toBe(500);
    const err = log.lines.find((l) => l.level === 'error')?.fields['err'] as { code?: unknown; cause?: unknown };
    expect(err.code).toBe('INTERNAL');
    expect(err.cause).not.toBeInstanceOf(Error);
    expect(err.cause).toEqual({ name: 'Error', code: '23505', constraint: 'uq_members_phone' });
  });

  it('a thrown non-Error is 500 INTERNAL with every header too', async () => {
    const { app } = setup({ phase: 'ready' }, { baseUrl: 'https://perpus.example.sch.id' });
    app.get('/odd', () => {
      throw 'not an error object';
    });
    const res = await app.request('/odd');
    expect(res.status).toBe(500);
    expect((await json(res))['code']).toBe('INTERNAL');
    expect(isUlid(res.headers.get('x-request-id') ?? '')).toBe(true);
    expect(res.headers.get('x-content-type-options')).toBe('nosniff');
    expect(res.headers.get('strict-transport-security')).toBe('max-age=31536000');
  });

  it('a 5xx DomainError keeps its code but never its detail or meta, and adds no Retry-After', async () => {
    const { app, log } = setup({ phase: 'ready' });
    app.get('/db', () => {
      throw new DomainError('DB_UNAVAILABLE', {
        detail: 'host db.internal:3306 refused, lock held by pid 4242 on build-host',
        meta: { reason: 'packet_too_large', host: 'db.internal' },
      });
    });
    const res = await app.request('/db');
    expect(res.status).toBe(503);
    expect(res.headers.get('retry-after')).toBeNull();
    const body = await json(res);
    expect(body).toEqual({ type: 'about:blank', title: expect.any(String), status: 503, code: 'DB_UNAVAILABLE', traceId: res.headers.get('x-request-id') });
    expect(log.lines.some((l) => l.level === 'error' && l.fields['requestId'] === body['traceId'])).toBe(true);
  });

  it('a 5xx DomainError other than the gate never shows a NOT_INSTALLED-like detail either', async () => {
    const { app } = setup({ phase: 'ready' });
    app.get('/ni', () => {
      throw new DomainError('NOT_INSTALLED', { detail: 'config.json missing in /home/user/altis-data' });
    });
    const body = await json(await app.request('/ni'));
    expect(body['code']).toBe('NOT_INSTALLED');
    expect(body['detail']).toBe(NOT_INSTALLED_DETAIL);
  });

  it('a 4xx DomainError shows its detail but never its meta (only a registered reason, decision D10)', async () => {
    const { app } = setup({ phase: 'ready' });
    app.get('/bad', () => {
      throw new DomainError('INVALID_BASE_URL', {
        detail: 'baseUrl harus https / baseUrl must be https',
        meta: { reason: 'scheme', input: 'ftp://user:pw@host' },
      });
    });
    const res = await app.request('/bad');
    expect(res.status).toBe(422);
    expect(await json(res)).toEqual({
      type: 'about:blank',
      title: expect.any(String),
      status: 422,
      code: 'INVALID_BASE_URL',
      detail: 'baseUrl harus https / baseUrl must be https',
      reason: 'scheme',
      traceId: res.headers.get('x-request-id'),
    });
  });
});

describe('headers on every response', () => {
  let state: AppState;
  beforeEach(() => {
    state = { phase: 'ready' };
  });

  async function responses(app: ReturnType<typeof setup>['app']): Promise<Response[]> {
    app.get('/boom', () => {
      throw new Error('x');
    });
    return [
      await app.request('/_health'),
      await app.request('/missing'),
      await app.request('/boom'),
      await app.request('/api/v1/x', { method: 'POST' }),
    ];
  }

  it('X-Request-Id is a fresh ULID per request, never the one the client sent; nosniff; Referrer-Policy', async () => {
    const { app } = setup(state);
    const seen = new Set<string>();
    for (const res of await responses(app)) {
      const id = res.headers.get('x-request-id') ?? '';
      expect(isUlid(id)).toBe(true);
      seen.add(id);
      expect(res.headers.get('x-content-type-options')).toBe('nosniff');
      expect(res.headers.get('referrer-policy')).toBe('same-origin');
    }
    expect(seen.size).toBe(4);
    const spoofed = await app.request('/_health', { headers: { 'X-Request-Id': 'attacker-chosen' } });
    expect(spoofed.headers.get('x-request-id')).not.toBe('attacker-chosen');
    expect(isUlid(spoofed.headers.get('x-request-id') ?? '')).toBe(true);
  });

  it('HSTS only when the baseUrl is https (from the deps or, once the config is read, from the state)', async () => {
    for (const res of await responses(setup(state, { baseUrl: 'https://perpus.example.sch.id' }).app)) {
      expect(res.headers.get('strict-transport-security')).toBe('max-age=31536000');
    }
    for (const res of await responses(setup(state, { baseUrl: 'http://192.168.1.10:3000' }).app)) {
      expect(res.headers.get('strict-transport-security')).toBeNull();
    }
    const bare = setup(state).app;
    expect((await bare.request('/_health')).headers.get('strict-transport-security')).toBeNull();
    state.baseUrl = 'https://perpus.example.sch.id';
    expect((await bare.request('/_health')).headers.get('strict-transport-security')).toBe('max-age=31536000');
  });

  it('API responses carry X-Altis-Build; /_health does not need it', async () => {
    const { app } = setup(state);
    expect((await app.request('/api/v1/x')).headers.get('x-altis-build')).toBe('b1d0001');
    const notInstalled = setup({ phase: 'not_installed' }).app;
    expect((await notInstalled.request('/api/v1/x')).headers.get('x-altis-build')).toBe('b1d0001');
  });
});
