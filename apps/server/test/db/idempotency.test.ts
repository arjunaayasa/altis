import { createHmac } from 'node:crypto';
import fsp from 'node:fs/promises';
import os from 'node:os';
import path from 'node:path';
import { randomToken, sha256hex } from '@altis/core';
import { canonicalize } from '@altis/crypto';
import { PHASE1_MIGRATIONS, countRows, runMigrations } from '@altis/db';
import { DomainError, newId } from '@altis/shared';
import { afterAll, beforeAll, beforeEach, describe, expect, it } from 'vitest';
import { z } from 'zod';
import { engineLabel, testDb, testDbContext, type TestDbHandle } from '../../../../tools/test/test-db.js';
import { createApp } from '../../src/app.js';
import { csrfKey, preSessionCsrfToken } from '../../src/http/csrf.js';
import { IDEMPOTENCY_LOCK_MS, requestHash } from '../../src/http/idempotency.js';
import { defineRoutes, route, type RouteContext, type RouteDecl } from '../../src/http/route.js';
import { createAgent, type Agent, type AgentReply } from '../agent.js';
import { recordingLogger, sampleConfig } from '../support.js';
import { seedStaff, sessionCookieFor, sessionCsrfFor } from '../support-auth.js';

// Step 12 of the chain (spec §7.9) on the engine picked by ALTIS_TEST_DB: an `Idempotency-Key` on a `store` route of
// an authenticated subject books a `processing` row (its own transaction) before the handler runs, and the handler's
// transaction marks it `done` with the response; the same key again replays that response, a different request under
// the key is 422, a key still being processed 409, and a stale `processing` row (lock expired) is taken over. A 4xx
// from the handler deletes the row so that the client may retry; a 5xx leaves it until the lock expires.

const ctx = testDbContext();
let h: TestDbHandle;

const SEC = 1000;
const NOW = Date.UTC(2026, 9, 28, 9, 0, 5);
const CONFIG = sampleConfig();
/** baseUrl is https: the cookies carry the `__Host-` prefix. */
const SID = '__Host-altis_sid';
const BRANCHES = '/api/v1/_t/branches';

/** What the handlers did; reset per test. */
const seen = { runs: 0, failNext: 0, prepares: 0 };
/** The latch of `t.latched`: the handler signals `entered`, then waits for `release`. */
let latch: { entered: () => void; release: Promise<void> } | null = null;

async function insertBranch(rc: RouteContext<{ name: string }>, name: string): Promise<string> {
  const id = newId();
  const code = id.slice(-12);
  await rc
    .tx()
    .trx.insertInto('branches')
    .values({ id, code_key: code, code_display: code, name, timezone: 'Asia/Jakarta', created_at: rc.now, updated_at: rc.now })
    .execute();
  return id;
}

const NAME = z.strictObject({ name: z.string().min(1).max(100) });
const store = { permission: 'system.branches.manage', idempotency: 'store', audit: null } as const;

const ROUTES: RouteDecl[] = defineRoutes([
  route({
    ...store,
    id: 't.branches.create',
    method: 'POST',
    path: BRANCHES,
    body: NAME,
    handler: async (rc) => {
      seen.runs += 1;
      return { status: 201, body: { id: await insertBranch(rc, rc.body.name) } };
    },
  }),
  route({
    ...store,
    id: 't.branches.create2',
    method: 'POST',
    path: '/api/v1/_t/branches2',
    body: NAME,
    handler: async (rc) => ({ status: 201, body: { id: await insertBranch(rc, rc.body.name) } }),
  }),
  route({
    ...store,
    id: 't.fail4xx',
    method: 'POST',
    path: '/api/v1/_t/fail4xx',
    body: NAME,
    handler: async (rc) => {
      seen.runs += 1;
      const id = await insertBranch(rc, rc.body.name);
      if (seen.failNext > 0) {
        seen.failNext -= 1;
        throw new DomainError('VALIDATION_FAILED', { meta: { errors: [{ path: 'name', code: 'custom' }] } });
      }
      return { status: 201, body: { id } };
    },
  }),
  route({
    ...store,
    id: 't.fail5xx',
    method: 'POST',
    path: '/api/v1/_t/fail5xx',
    body: NAME,
    handler: async (rc) => {
      seen.runs += 1;
      await insertBranch(rc, rc.body.name);
      throw new DomainError('INTERNAL');
    },
  }),
  route({
    ...store,
    id: 't.empty',
    method: 'DELETE',
    path: '/api/v1/_t/empty',
    handler: async () => {
      seen.runs += 1;
      return {};
    },
  }),
  route({
    ...store,
    id: 't.sized',
    method: 'POST',
    path: '/api/v1/_t/sized',
    body: z.strictObject({ n: z.int().min(0).max(100_000) }),
    // `{"pad":"…"}` is n + 10 bytes.
    handler: async (rc) => {
      seen.runs += 1;
      return { body: { pad: 'x'.repeat(rc.body.n) } };
    },
  }),
  route({
    ...store,
    id: 't.own-response',
    method: 'POST',
    path: '/api/v1/_t/own-response',
    handler: async () => new Response('{}', { headers: { 'Content-Type': 'application/json' } }),
  }),
  route({
    ...store,
    id: 't.prepare4xx',
    method: 'POST',
    path: '/api/v1/_t/prepare4xx',
    body: NAME,
    prepare: async () => {
      seen.prepares += 1;
      if (seen.failNext > 0) {
        seen.failNext -= 1;
        throw new DomainError('PASSWORD_TOO_WEAK', { meta: { reason: 'common' } });
      }
      return 'prepared';
    },
    handler: async (rc) => {
      seen.runs += 1;
      return { status: 201, body: { id: await insertBranch(rc, rc.body.name), prepared: rc.prepared } };
    },
  }),
  route({
    ...store,
    id: 't.headers',
    method: 'POST',
    path: '/api/v1/_t/headers',
    body: NAME,
    handler: async (rc) => {
      seen.runs += 1;
      return { status: 201, body: { id: await insertBranch(rc, rc.body.name) }, headers: { 'X-Not-Stored': 'yes' } };
    },
  }),
  route({
    ...store,
    id: 't.latched',
    method: 'POST',
    path: '/api/v1/_t/latched',
    body: NAME,
    handler: async (rc) => {
      const l = latch;
      if (l !== null) {
        l.entered();
        await l.release;
      }
      return { status: 201, body: { id: await insertBranch(rc, rc.body.name) } };
    },
  }),
  route({
    ...store,
    id: 't.stolen',
    method: 'POST',
    path: '/api/v1/_t/stolen',
    body: NAME,
    handler: async (rc) => {
      const id = await insertBranch(rc, rc.body.name);
      // Another request took the key over meanwhile (its lock had expired): the row carries a new locked_until.
      await rc
        .tx()
        .trx.updateTable('idempotency_keys')
        .set((eb) => ({ locked_until: eb('locked_until', '+', 1) }))
        .where('subject_id', '=', rc.auth!.subjectId)
        .execute();
      return { status: 201, body: { id } };
    },
  }),
  route({
    permission: 'system.branches.manage',
    idempotency: 'none',
    audit: null,
    id: 't.branches.plain',
    method: 'POST',
    path: '/api/v1/_t/plain',
    body: NAME,
    handler: async (rc) => ({ status: 201, body: { id: await insertBranch(rc, rc.body.name) } }),
  }),
  route({
    public: true,
    idempotency: 'none',
    audit: null,
    id: 't.public',
    method: 'POST',
    path: '/api/v1/_t/public',
    body: NAME,
    handler: async (rc) => ({ status: 201, body: { id: await insertBranch(rc, rc.body.name) } }),
  }),
]);

function appAt(start: number) {
  const clock = { now: start };
  const app = createApp({
    state: { phase: 'ready', db: h, config: CONFIG },
    version: '0.1.0',
    buildId: 'b',
    log: recordingLogger(),
    routes: ROUTES,
    clock: () => clock.now,
  });
  return { app, clock };
}

/** A staff user holding system.branches.manage, with a session; `send` posts as that user. */
async function staffAgent(app: ReturnType<typeof appAt>['app']) {
  const user = await seedStaff(h, { username: `idem_${newId().slice(-8)}`, now: NOW, roles: [{ permissions: ['system.branches.manage'] }] });
  const token = await sessionCookieFor(h, user.id, { now: NOW });
  const agent = createAgent(app);
  agent.setCookie(SID, token);
  const csrf = sessionCsrfFor(CONFIG, token);
  const send = (method: 'POST' | 'DELETE', p: string, body?: unknown, key?: string): Promise<AgentReply> => {
    const headers: Record<string, string> = { 'x-csrf-token': csrf };
    if (key !== undefined) headers['idempotency-key'] = key;
    return method === 'POST' ? agent.post(p, body, headers) : agent.delete(p, body, headers);
  };
  return { user, agent, post: (p: string, body: unknown, key?: string) => send('POST', p, body, key), send };
}

const code = (res: AgentReply): string | undefined => (res.json as { code?: string } | undefined)?.code;
const replayed = (res: AgentReply): string | null => res.headers.get('idempotent-replayed');
const branchesNamed = (name: string) => countRows(h.db.selectFrom('branches').where('name', '=', name));
const keyRows = (subjectId: string) =>
  h.db
    .selectFrom('idempotency_keys')
    .select(['key', 'status', 'locked_until', 'response_status', 'response_body', 'request_hash', 'subject_type'])
    .where('subject_id', '=', subjectId)
    .execute();

/** Books a row for `subjectId` and `key` as another process would have. */
function bookRow(subjectId: string, key: string, o: { hash: string; lockedUntil: number; status?: string }) {
  return h.db
    .insertInto('idempotency_keys')
    .values({
      subject_type: 'staff',
      subject_id: subjectId,
      key,
      request_hash: o.hash,
      status: o.status ?? 'processing',
      locked_until: o.lockedUntil,
      response_status: null,
      response_body: null,
      created_at: NOW - 40 * SEC,
    })
    .execute();
}

let serial = 0;
/** A fresh key and branch name per call. */
function fresh(): { key: string; name: string } {
  serial += 1;
  return { key: `key-${serial}-${randomToken(9)}`, name: `Cabang ${serial} ${newId().slice(-6)}` };
}

describe('requestHash (ruling R1b-3)', () => {
  const KEY = csrfKey(CONFIG);
  const hmacHex = (key: Uint8Array, msg: string) => createHmac('sha256', key).update(msg, 'utf8').digest('hex');

  it("is hex HMAC-SHA256(sessionKey, 'idem:' method \\n path \\n canonical body), body null when absent; key order does not matter", () => {
    expect(requestHash(KEY, 'POST', '/api/v1/x', { b: 2, a: 1 })).toBe(hmacHex(KEY, `idem:POST\n/api/v1/x\n${canonicalize({ a: 1, b: 2 })}`));
    expect(requestHash(KEY, 'POST', '/api/v1/x', { a: 1, b: 2 })).toBe(requestHash(KEY, 'POST', '/api/v1/x', { b: 2, a: 1 }));
    expect(requestHash(KEY, 'DELETE', '/api/v1/x', undefined)).toBe(hmacHex(KEY, 'idem:DELETE\n/api/v1/x\nnull'));
    expect(requestHash(KEY, 'POST', '/api/v1/x', { a: 1 })).not.toBe(requestHash(KEY, 'POST', '/api/v1/y', { a: 1 }));
    expect(requestHash(KEY, 'POST', '/api/v1/x', { a: 1 })).not.toBe(requestHash(KEY, 'PUT', '/api/v1/x', { a: 1 }));
    expect(IDEMPOTENCY_LOCK_MS).toBe(30_000);
  });

  it('is never the plain SHA-256 of the request, and depends on the key (64 hex characters, the column width)', () => {
    const hash = requestHash(KEY, 'POST', '/api/v1/users', { password: 'kuda-lumping-biru-tujuh' });
    expect(hash).toMatch(/^[0-9a-f]{64}$/);
    expect(hash).not.toBe(sha256hex(`POST\n/api/v1/users\n${canonicalize({ password: 'kuda-lumping-biru-tujuh' })}`));
    expect(requestHash(new Uint8Array(32).fill(1), 'POST', '/api/v1/users', { password: 'kuda-lumping-biru-tujuh' })).not.toBe(hash);
  });
});

describe.skipIf(!ctx.available)(`idempotency keys [${engineLabel()}]`, () => {
  let dataDir: string;

  beforeAll(async () => {
    h = await testDb();
    dataDir = await fsp.mkdtemp(path.join(os.tmpdir(), 'altis-idempotency-'));
    await runMigrations(h, { appVersion: '0.1.0', dataDir, migrations: PHASE1_MIGRATIONS });
  });

  afterAll(async () => {
    await h?.close();
    if (dataDir !== undefined) await fsp.rm(dataDir, { recursive: true, force: true });
  });

  beforeEach(() => {
    seen.runs = 0;
    seen.failNext = 0;
    seen.prepares = 0;
    latch = null;
  });

  it('replay: the same key twice → the stored status and body with Idempotent-Replayed: true, one branch', async () => {
    const t = appAt(NOW);
    const s = await staffAgent(t.app);
    const { key, name } = fresh();

    const first = await s.post(BRANCHES, { name }, key);
    expect(first.status).toBe(201);
    expect(replayed(first)).toBeNull();
    const id = (first.json as { id: string }).id;
    expect(first.json).toEqual({ id });

    t.clock.now = NOW + 5 * SEC;
    const second = await s.post(BRANCHES, { name }, key);
    expect(second.status).toBe(201);
    expect(second.text).toBe(first.text);
    expect(second.headers.get('content-type')).toBe('application/json');
    expect(replayed(second)).toBe('true');
    expect(seen.runs).toBe(1);
    expect(await branchesNamed(name)).toBe(1);

    const rows = await keyRows(s.user.id);
    expect(rows).toHaveLength(1);
    expect(rows[0]).toMatchObject({
      key,
      subject_type: 'staff',
      status: 'done',
      response_status: 201,
      response_body: JSON.stringify({ id }),
      request_hash: requestHash(csrfKey(CONFIG), 'POST', BRANCHES, { name }),
    });
  });

  it('replay of a body-less response: 204 again, without a body', async () => {
    const t = appAt(NOW);
    const s = await staffAgent(t.app);
    const { key } = fresh();
    const first = await s.send('DELETE', '/api/v1/_t/empty', undefined, key);
    expect(first.status).toBe(204);
    const second = await s.send('DELETE', '/api/v1/_t/empty', undefined, key);
    expect(second.status).toBe(204);
    expect(second.text).toBe('');
    expect(replayed(second)).toBe('true');
    expect(seen.runs).toBe(1);
    expect((await keyRows(s.user.id))[0]).toMatchObject({ status: 'done', response_status: 204, response_body: null });
  });

  it('the key is unique per subject: another user with the same key runs the handler', async () => {
    const t = appAt(NOW);
    const [a, b] = [await staffAgent(t.app), await staffAgent(t.app)];
    const { key, name } = fresh();
    expect((await a.post(BRANCHES, { name }, key)).status).toBe(201);
    const other = await b.post(BRANCHES, { name }, key);
    expect(other.status).toBe(201);
    expect(replayed(other)).toBeNull();
    expect(await branchesNamed(name)).toBe(2);
  });

  it('reuse: the same key with another body, or on another route → 422 IDEMPOTENCY_KEY_REUSED', async () => {
    const t = appAt(NOW);
    const s = await staffAgent(t.app);
    const { key, name } = fresh();
    expect((await s.post(BRANCHES, { name }, key)).status).toBe(201);

    const other = await s.post(BRANCHES, { name: `${name} lain` }, key);
    expect(other.status).toBe(422);
    expect(code(other)).toBe('IDEMPOTENCY_KEY_REUSED');
    const elsewhere = await s.post('/api/v1/_t/branches2', { name }, key);
    expect(elsewhere.status).toBe(422);
    expect(code(elsewhere)).toBe('IDEMPOTENCY_KEY_REUSED');
    expect(await branchesNamed(name)).toBe(1);
    expect(await branchesNamed(`${name} lain`)).toBe(0);
  });

  it('in progress: a processing row of the same request locked until now + 30 s → 409 IDEMPOTENCY_IN_PROGRESS', async () => {
    const t = appAt(NOW);
    const s = await staffAgent(t.app);
    const { key, name } = fresh();
    await bookRow(s.user.id, key, { hash: requestHash(csrfKey(CONFIG), 'POST', BRANCHES, { name }), lockedUntil: NOW + IDEMPOTENCY_LOCK_MS });

    const res = await s.post(BRANCHES, { name }, key);
    expect(res.status).toBe(409);
    expect(code(res)).toBe('IDEMPOTENCY_IN_PROGRESS');
    expect(seen.runs).toBe(0);
    expect(await branchesNamed(name)).toBe(0);

    // Still held at its last millisecond (the takeover needs locked_until < now).
    t.clock.now = NOW + IDEMPOTENCY_LOCK_MS;
    expect(code(await s.post(BRANCHES, { name }, key))).toBe('IDEMPOTENCY_IN_PROGRESS');
    expect(seen.runs).toBe(0);
  });

  it('takeover: a stale processing row of the same request → taken over, the handler runs, done', async () => {
    const t = appAt(NOW);
    const s = await staffAgent(t.app);
    const { key, name } = fresh();
    await bookRow(s.user.id, key, { hash: requestHash(csrfKey(CONFIG), 'POST', BRANCHES, { name }), lockedUntil: NOW - 1 });

    const res = await s.post(BRANCHES, { name }, key);
    expect(res.status).toBe(201);
    expect(replayed(res)).toBeNull();
    expect(seen.runs).toBe(1);
    expect(await branchesNamed(name)).toBe(1);
    expect((await keyRows(s.user.id))[0]).toMatchObject({ status: 'done', response_status: 201, response_body: res.text });

    // A stale row of another request under the key is still 422.
    const other = fresh();
    await bookRow(s.user.id, other.key, { hash: requestHash(csrfKey(CONFIG), 'POST', BRANCHES, { name: 'x' }), lockedUntil: NOW - 1 });
    const reused = await s.post(BRANCHES, { name: other.name }, other.key);
    expect(reused.status).toBe(422);
    expect(code(reused)).toBe('IDEMPOTENCY_KEY_REUSED');
  });

  it('a 4xx DomainError from the handler deletes the row (and rolls back); a retry with the key runs the handler', async () => {
    const t = appAt(NOW);
    const s = await staffAgent(t.app);
    const { key, name } = fresh();
    seen.failNext = 1;

    const failed = await s.post('/api/v1/_t/fail4xx', { name }, key);
    expect(failed.status).toBe(422);
    expect(code(failed)).toBe('VALIDATION_FAILED');
    expect(await keyRows(s.user.id)).toEqual([]);
    expect(await branchesNamed(name)).toBe(0);

    const retry = await s.post('/api/v1/_t/fail4xx', { name }, key);
    expect(retry.status).toBe(201);
    expect(replayed(retry)).toBeNull();
    expect(seen.runs).toBe(2);
    expect(await branchesNamed(name)).toBe(1);
    expect((await keyRows(s.user.id))[0]?.status).toBe('done');
  });

  it('a 4xx DomainError from prepare deletes the row too; a retry with the key runs prepare and the handler', async () => {
    const t = appAt(NOW);
    const s = await staffAgent(t.app);
    const { key, name } = fresh();
    seen.failNext = 1;

    const failed = await s.post('/api/v1/_t/prepare4xx', { name }, key);
    expect(failed.status).toBe(422);
    expect(code(failed)).toBe('PASSWORD_TOO_WEAK');
    expect(seen.runs).toBe(0);
    expect(await keyRows(s.user.id)).toEqual([]);

    const retry = await s.post('/api/v1/_t/prepare4xx', { name }, key);
    expect(retry.status).toBe(201);
    expect(replayed(retry)).toBeNull();
    expect(retry.json).toMatchObject({ prepared: 'prepared' });
    expect([seen.prepares, seen.runs]).toEqual([2, 1]);
    expect(await branchesNamed(name)).toBe(1);
    expect((await keyRows(s.user.id))[0]).toMatchObject({ status: 'done', response_status: 201, response_body: retry.text });

    const again = await s.post('/api/v1/_t/prepare4xx', { name }, key);
    expect(replayed(again)).toBe('true');
    expect([seen.prepares, seen.runs]).toEqual([2, 1]);
  });

  it("a 'store' handler that returns headers → 500 (TypeError): they would not be replayed; nothing committed", async () => {
    const t = appAt(NOW);
    const s = await staffAgent(t.app);
    const { key, name } = fresh();
    const res = await s.post('/api/v1/_t/headers', { name }, key);
    expect(res.status).toBe(500);
    expect(code(res)).toBe('INTERNAL');
    expect(res.headers.get('x-not-stored')).toBeNull();
    expect(await branchesNamed(name)).toBe(0);
    expect((await keyRows(s.user.id)).map((r) => r.status)).toEqual(['processing']);
  });

  it('a body with text that is not well-formed (a lone surrogate) → 422 VALIDATION_FAILED before a key is booked', async () => {
    const t = appAt(NOW);
    const s = await staffAgent(t.app);
    const { key } = fresh();
    const res = await s.post(BRANCHES, '{"name":"Cabang \\ud800"}', key);
    expect(res.status).toBe(422);
    expect(code(res)).toBe('VALIDATION_FAILED');
    expect((res.json as { errors: unknown }).errors).toEqual([{ path: 'name', code: 'invalid_format' }]);
    expect(seen.runs).toBe(0);
    expect(await keyRows(s.user.id)).toEqual([]);
  });

  it('same transaction: a handler that inserts and then fails with a 500 → no branch, no done row; the key stays locked', async () => {
    const t = appAt(NOW);
    const s = await staffAgent(t.app);
    const { key, name } = fresh();

    const res = await s.post('/api/v1/_t/fail5xx', { name }, key);
    expect(res.status).toBe(500);
    expect(await branchesNamed(name)).toBe(0);
    const rows = await keyRows(s.user.id);
    expect(rows).toHaveLength(1);
    expect(rows[0]).toMatchObject({ status: 'processing', locked_until: NOW + IDEMPOTENCY_LOCK_MS, response_status: null, response_body: null });

    expect(code(await s.post('/api/v1/_t/fail5xx', { name }, key))).toBe('IDEMPOTENCY_IN_PROGRESS');
    expect(seen.runs).toBe(1);
  });

  it('a claim lost while the handler ran (the row no longer carries its lock) → 409, the handler rolled back', async () => {
    const t = appAt(NOW);
    const s = await staffAgent(t.app);
    const { key, name } = fresh();
    const res = await s.post('/api/v1/_t/stolen', { name }, key);
    expect(res.status).toBe(409);
    expect(code(res)).toBe('IDEMPOTENCY_IN_PROGRESS');
    expect(await branchesNamed(name)).toBe(0);
    expect((await keyRows(s.user.id)).filter((r) => r.status === 'done')).toEqual([]);
  });

  it('bad keys → 400 IDEMPOTENCY_KEY_INVALID before the handler runs', async () => {
    const t = appAt(NOW);
    const s = await staffAgent(t.app);
    for (const key of ['bad key x', 'k'.repeat(65), 'short', '']) {
      const { name } = fresh();
      const res = await s.post(BRANCHES, { name }, key);
      expect(res.status, JSON.stringify(key)).toBe(400);
      expect(code(res)).toBe('IDEMPOTENCY_KEY_INVALID');
      expect(await branchesNamed(name)).toBe(0);
    }
    expect(seen.runs).toBe(0);
    expect(await keyRows(s.user.id)).toEqual([]);
    // 64 characters of the whole alphabet pass.
    const ok = await s.post(BRANCHES, { name: fresh().name }, `aZ09._:-${'k'.repeat(56)}`);
    expect(ok.status).toBe(201);
  });

  it("ignored: on a 'none' route two calls make two branches; without a session the key plays no part", async () => {
    const t = appAt(NOW);
    const s = await staffAgent(t.app);
    const { key, name } = fresh();
    expect((await s.post('/api/v1/_t/plain', { name }, key)).status).toBe(201);
    expect((await s.post('/api/v1/_t/plain', { name }, key)).status).toBe(201);
    expect((await s.post('/api/v1/_t/plain', { name }, 'bad key x')).status).toBe(201);
    expect(await branchesNamed(name)).toBe(3);
    expect(await keyRows(s.user.id)).toEqual([]);

    // Anonymous (pre-session CSRF): a public route ignores the key; a `store` route answers 401, not 400.
    const anon: Agent = createAgent(t.app);
    const preSession = randomToken(32);
    anon.setCookie('__Host-altis_csrf', preSession);
    const headers = { 'x-csrf-token': preSessionCsrfToken(csrfKey(CONFIG), preSession), 'idempotency-key': 'bad key x' };
    const pub = fresh();
    expect((await anon.post('/api/v1/_t/public', { name: pub.name }, headers)).status).toBe(201);
    expect((await anon.post('/api/v1/_t/public', { name: pub.name }, headers)).status).toBe(201);
    expect(await branchesNamed(pub.name)).toBe(2);
    const denied = await anon.post(BRANCHES, { name: pub.name }, headers);
    expect(denied.status).toBe(401);
    expect(code(denied)).toBe('AUTH_REQUIRED');
    expect(await countRows(h.db.selectFrom('idempotency_keys').where('key', '=', 'bad key x'))).toBe(0);
  });

  it('a stored response is at most 60000 bytes: 60000 is stored and replayed, 60001 is a 500 (TypeError)', async () => {
    const t = appAt(NOW);
    const s = await staffAgent(t.app);
    const fits = fresh();
    const ok = await s.post('/api/v1/_t/sized', { n: 59_990 }, fits.key);
    expect(ok.status).toBe(200);
    expect(ok.text).toHaveLength(60_000);
    const again = await s.post('/api/v1/_t/sized', { n: 59_990 }, fits.key);
    expect(replayed(again)).toBe('true');
    expect(again.text).toBe(ok.text);

    const big = fresh();
    const res = await s.post('/api/v1/_t/sized', { n: 59_991 }, big.key);
    expect(res.status).toBe(500);
    expect(code(res)).toBe('INTERNAL');
    expect((await keyRows(s.user.id)).find((r) => r.key === big.key)?.status).toBe('processing');
    expect(seen.runs).toBe(2);

    // Without a key nothing is stored, so the size does not matter.
    expect((await s.post('/api/v1/_t/sized', { n: 70_000 })).status).toBe(200);
  });

  it("a 'store' handler that returns its own Response → 500 (TypeError): its response cannot be stored", async () => {
    const t = appAt(NOW);
    const s = await staffAgent(t.app);
    const res = await s.post('/api/v1/_t/own-response', undefined, fresh().key);
    expect(res.status).toBe(500);
    expect(code(res)).toBe('INTERNAL');
  });

  // On SQLite the second request would wait behind the latched transaction on the process's only connection (P20).
  describe.skipIf(ctx.engine === 'sqlite')('concurrency (not on SQLite: one connection per process, P20)', () => {
    it('two concurrent requests with one key while the handler waits on a latch → one 201, one 409', async () => {
      const t = appAt(NOW);
      const s = await staffAgent(t.app);
      const { key, name } = fresh();
      let entered!: () => void;
      const inside = new Promise<void>((resolve) => {
        entered = resolve;
      });
      let release!: () => void;
      latch = {
        entered,
        release: new Promise<void>((resolve) => {
          release = resolve;
        }),
      };

      const first = s.post('/api/v1/_t/latched', { name }, key);
      await inside;
      const second = await s.post('/api/v1/_t/latched', { name }, key);
      release();
      expect(second.status).toBe(409);
      expect(code(second)).toBe('IDEMPOTENCY_IN_PROGRESS');
      expect((await first).status).toBe(201);
      expect(await branchesNamed(name)).toBe(1);
      expect((await keyRows(s.user.id))[0]?.status).toBe('done');
    });
  });
});
