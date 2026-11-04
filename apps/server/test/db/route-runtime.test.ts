import fsp from 'node:fs/promises';
import os from 'node:os';
import path from 'node:path';
import { PHASE1_MIGRATIONS, countRows, runMigrations, verifyAuditChain, type DbHandle } from '@altis/db';
import { DomainError, newId } from '@altis/shared';
import { afterAll, beforeAll, beforeEach, describe, expect, it } from 'vitest';
import { z } from 'zod';
import { engineLabel, testDb, testDbContext, type TestDbHandle } from '../../../../tools/test/test-db.js';
import { createApp, type AppState } from '../../src/app.js';
import { defineRoutes, route, type RouteContext, type RouteDecl } from '../../src/http/route.js';
import { createAgent } from '../agent.js';
import { recordingLogger, sampleConfig } from '../support.js';

// The route runtime of Task 7 on the engine picked by ALTIS_TEST_DB: the handler transaction (one withTx per
// non-GET `tx: 'handler'` route, audit-once checked before COMMIT, afterCommit hooks per attempt), `tx: 'self'` and
// GET routes opening their own transactions, strict input validation, `prepare` outside any transaction, and
// `session: 'none'` routes that never touch the database (S29).
//
// The test declarations are `public: true` with `auth: 'bearer'`, which step 8 (CSRF/Origin, Task 12) exempts, so
// they stay valid once that step exists (S23).

const ctx = testDbContext();

/** Shared by the test routes and the tests: what the handlers saw and did. */
const seen = {
  hooks: [] as string[],
  order: [] as string[],
  runs: 0,
  afterCommitRows: [] as number[],
};

let h: TestDbHandle;

/** Inserts a branch in the handler's transaction (or `tx`), returning its id. */
async function insertBranch(rc: { now: number }, trx: NonNullable<RouteContext<unknown, unknown, unknown>['trx']>): Promise<string> {
  const id = newId();
  const code = id.slice(-10);
  await trx
    .insertInto('branches')
    .values({ id, code_key: code, code_display: code, name: `Cabang ${code}`, timezone: 'Asia/Jakarta', created_at: rc.now, updated_at: rc.now })
    .execute();
  return id;
}

const pub = { public: true, auth: 'bearer', idempotency: 'none' } as const;

const ROUTES: RouteDecl[] = defineRoutes([
  route({
    ...pub,
    id: 't.insert',
    method: 'POST',
    path: '/api/v1/_t/insert',
    audit: 'branches.create',
    handler: async (rc) => {
      const id = await insertBranch(rc, rc.tx().trx);
      await rc.audit({ entity: 'branches', entityId: id });
      rc.afterCommit(async () => {
        seen.hooks.push('insert.afterCommit');
        // After COMMIT: the connection is free again and the row is visible outside the transaction.
        seen.afterCommitRows.push(await countRows(h.db.selectFrom('branches')));
      });
      return { status: 201, body: { id }, headers: { 'X-Test': 'yes' } };
    },
  }),
  route({
    ...pub,
    id: 't.conflict',
    method: 'POST',
    path: '/api/v1/_t/conflict',
    audit: 'branches.create',
    handler: async (rc) => {
      const id = await insertBranch(rc, rc.tx().trx);
      await rc.audit({ entity: 'branches', entityId: id });
      rc.afterCommit(() => {
        seen.hooks.push('conflict.afterCommit');
      });
      rc.afterResponse(() => {
        seen.hooks.push('conflict.afterResponse');
      });
      throw new DomainError('CONFLICT_STALE');
    },
  }),
  route({
    ...pub,
    id: 't.noaudit',
    method: 'POST',
    path: '/api/v1/_t/noaudit',
    audit: 'branches.create',
    handler: async (rc) => {
      await insertBranch(rc, rc.tx().trx);
      rc.afterCommit(() => {
        seen.hooks.push('noaudit.afterCommit');
      });
      return { body: {} };
    },
  }),
  route({
    ...pub,
    id: 't.after',
    method: 'POST',
    path: '/api/v1/_t/after',
    audit: null,
    handler: async (rc) => {
      rc.afterResponse(() => {
        seen.hooks.push('after.1');
      });
      rc.afterResponse(async () => {
        throw new Error('hook boom');
      });
      rc.afterResponse(() => {
        seen.hooks.push('after.3');
      });
      return { body: { ok: true } };
    },
  }),
  route({
    ...pub,
    id: 't.body',
    method: 'POST',
    path: '/api/v1/_t/body',
    audit: null,
    body: z.strictObject({ a: z.number(), note: z.string().max(5).optional() }),
    handler: async (rc) => ({ body: { got: rc.body } }),
  }),
  route({
    ...pub,
    id: 't.text',
    method: 'POST',
    path: '/api/v1/_t/text',
    audit: null,
    body: z.strictObject({
      s: z.string().optional(),
      list: z.array(z.string()).optional(),
      map: z.record(z.string(), z.string()).optional(),
      deep: z.strictObject({ t: z.string() }).optional(),
    }),
    handler: async (rc) => {
      seen.runs += 1;
      return { body: { got: rc.body } };
    },
  }),
  route({
    ...pub,
    id: 't.query',
    method: 'GET',
    path: '/api/v1/_t/query',
    audit: null,
    query: z.strictObject({ n: z.coerce.number().int(), f: z.stringbool().optional() }),
    handler: async (rc) => ({ body: { got: rc.query } }),
  }),
  route({
    // A cookie route (the default): step 8 applies to it.
    public: true,
    idempotency: 'none',
    id: 't.side-effects',
    method: 'GET',
    path: '/api/v1/_t/side-effects',
    audit: null,
    sideEffects: true,
    handler: async () => {
      seen.runs += 1;
      return { body: { ran: true } };
    },
  }),
  route({
    ...pub,
    id: 't.params',
    method: 'GET',
    path: '/api/v1/_t/items/:id',
    audit: null,
    params: z.strictObject({ id: z.string().regex(/^\d+$/) }),
    handler: async (rc) => ({ body: { got: rc.params } }),
  }),
  route({
    ...pub,
    id: 't.get',
    method: 'GET',
    path: '/api/v1/_t/get',
    audit: null,
    handler: async (rc) => {
      let txError = '';
      try {
        rc.tx();
      } catch (error) {
        txError = (error as Error).name;
      }
      const n = await rc.withTx(async (tx) => (await tx.trx.selectFrom('branches').select('id').execute()).length);
      return { body: { trxNull: rc.trx === null, txError, n, actor: rc.actor } };
    },
  }),
  route({
    ...pub,
    id: 't.self429',
    method: 'POST',
    path: '/api/v1/_t/self429',
    tx: 'self',
    audit: 'branches.create',
    handler: async (rc) => {
      if (rc.trx !== null) throw new Error('a tx: self handler must not get a transaction');
      await rc.withTx(async (tx) => {
        const id = await insertBranch(rc, tx.trx);
        await rc.audit({ entity: 'branches', entityId: id });
      });
      throw new DomainError('AUTH_TOO_MANY_ATTEMPTS', { meta: { retryAfterS: 30 } });
    },
  }),
  route({
    ...pub,
    id: 't.self',
    method: 'POST',
    path: '/api/v1/_t/self',
    tx: 'self',
    audit: 'branches.create',
    handler: async (rc) => {
      await rc.withTx((tx) => insertBranch(rc, tx.trx));
      await rc.withTx(async (tx) => tx.audit({ action: 'branches.create', entity: 'branches', entityId: null }));
      return { body: {} };
    },
  }),
  route({
    ...pub,
    id: 't.repeat',
    method: 'POST',
    path: '/api/v1/_t/repeat',
    tx: 'self',
    audit: 'branches.create',
    body: z.strictObject({ actorId: z.string(), entityId: z.string(), alsoAudit: z.boolean().optional(), outside: z.boolean().optional() }),
    handler: async (rc) => {
      if (rc.body.outside === true) await rc.auditedBefore({ entity: 'branches', entityId: rc.body.entityId });
      const actor = { type: 'staff', id: rc.body.actorId, ip: null } as const;
      const repeated = await rc.withTx(
        async (tx) => {
          const found = await rc.auditedBefore({ entity: 'branches', entityId: rc.body.entityId });
          if (!found || rc.body.alsoAudit === true) await tx.audit({ action: 'branches.create', entity: 'branches', entityId: rc.body.entityId });
          return found;
        },
        { actor },
      );
      return { body: { repeated } };
    },
  }),
  route({
    ...pub,
    id: 't.self.none',
    method: 'POST',
    path: '/api/v1/_t/self-none',
    tx: 'self',
    audit: 'branches.create',
    handler: async (rc) => {
      await rc.withTx((tx) => insertBranch(rc, tx.trx));
      return { body: {} };
    },
  }),
  route({
    ...pub,
    id: 't.retry',
    method: 'POST',
    path: '/api/v1/_t/retry',
    audit: 'branches.create',
    handler: async (rc) => {
      seen.runs += 1;
      const id = await insertBranch(rc, rc.tx().trx);
      await rc.audit({ entity: 'branches', entityId: id });
      rc.afterCommit(() => {
        seen.hooks.push(`retry.afterCommit.${seen.runs}`);
      });
      if (seen.runs === 1) throw new DomainError('TX_CONFLICT');
      return { body: { runs: seen.runs } };
    },
  }),
  route({
    ...pub,
    id: 't.security',
    method: 'POST',
    path: '/api/v1/_t/security',
    audit: 'branches.create',
    handler: async (rc) => {
      await rc.audit({ entity: 'branches', entityId: null });
      await rc.tx().audit({ action: 'auth.login.success', entity: null, entityId: null });
      return { body: {} };
    },
  }),
  route({
    ...pub,
    id: 't.twice',
    method: 'POST',
    path: '/api/v1/_t/twice',
    audit: 'branches.create',
    handler: async (rc) => {
      await insertBranch(rc, rc.tx().trx);
      await rc.audit({ entity: 'branches', entityId: null });
      await rc.audit({ entity: 'branches', entityId: null });
      return { body: {} };
    },
  }),
  route({
    ...pub,
    id: 't.foreign',
    method: 'POST',
    path: '/api/v1/_t/foreign',
    audit: 'branches.create',
    handler: async (rc) => {
      await rc.audit({ entity: 'branches', entityId: null });
      await rc.tx().audit({ action: 'users.update', entity: 'staff_users', entityId: null });
      return { body: {} };
    },
  }),
  route({
    ...pub,
    id: 't.null.foreign',
    method: 'POST',
    path: '/api/v1/_t/null-foreign',
    audit: null,
    handler: async (rc) => {
      await rc.tx().audit({ action: 'users.update', entity: 'staff_users', entityId: null });
      return { body: {} };
    },
  }),
  route({
    ...pub,
    id: 't.null.security',
    method: 'POST',
    path: '/api/v1/_t/null-security',
    audit: null,
    handler: async (rc) => {
      await rc.tx().audit({ action: 'authz.denied', entity: null, entityId: null });
      return { body: {} };
    },
  }),
  route({
    ...pub,
    id: 't.null.also',
    method: 'POST',
    path: '/api/v1/_t/null-also',
    audit: null,
    alsoAudits: ['auth.2fa.disable'],
    handler: async (rc) => {
      await rc.tx().audit({ action: 'auth.2fa.disable', entity: null, entityId: null });
      return { body: {} };
    },
  }),
  route({
    ...pub,
    id: 't.also.foreign',
    method: 'POST',
    path: '/api/v1/_t/also-foreign',
    audit: 'branches.create',
    alsoAudits: ['auth.2fa.disable'],
    handler: async (rc) => {
      await rc.audit({ entity: 'branches', entityId: null });
      await rc.tx().audit({ action: 'users.update', entity: 'staff_users', entityId: null });
      return { body: {} };
    },
  }),
  route({
    ...pub,
    id: 't.also.declared',
    method: 'POST',
    path: '/api/v1/_t/also-declared',
    audit: 'branches.create',
    alsoAudits: ['auth.2fa.disable'],
    handler: async (rc) => {
      await rc.tx().audit({ action: 'auth.2fa.disable', entity: null, entityId: null });
      return { body: {} };
    },
  }),
  route({
    ...pub,
    id: 't.null.audit',
    method: 'POST',
    path: '/api/v1/_t/null-audit',
    audit: null,
    handler: async (rc) => {
      await rc.audit({ entity: null, entityId: null });
      return { body: {} };
    },
  }),
  route({
    ...pub,
    id: 't.prepare',
    method: 'POST',
    path: '/api/v1/_t/prepare',
    audit: null,
    body: z.strictObject({ secret: z.string() }),
    prepare: async (rc) => {
      seen.order.push(`prepare:${rc.trx === null ? 'no-trx' : 'trx'}`);
      return `prepared(${rc.body.secret.length})`;
    },
    handler: async (rc) => {
      seen.runs += 1;
      seen.order.push(`handler:${String(rc.prepared)}`);
      if (seen.runs === 1) throw new DomainError('TX_CONFLICT');
      return { body: { prepared: rc.prepared } };
    },
  }),
  route({
    ...pub,
    id: 't.prepare.audit',
    method: 'POST',
    path: '/api/v1/_t/prepare-audit',
    audit: 'branches.create',
    prepare: async (rc) => {
      seen.order.push('prepare');
      await rc.audit({ entity: 'branches', entityId: null });
    },
    handler: async (rc) => {
      seen.order.push('handler');
      await rc.audit({ entity: 'branches', entityId: null });
      return { body: {} };
    },
  }),
  route({
    ...pub,
    id: 't.prepare.withtx',
    method: 'POST',
    path: '/api/v1/_t/prepare-withtx',
    audit: null,
    prepare: async (rc) => {
      seen.order.push('prepare');
      await rc.withTx((tx) => insertBranch(rc, tx.trx));
    },
    handler: async () => {
      seen.order.push('handler');
      return { body: {} };
    },
  }),
  route({
    ...pub,
    id: 't.denied.prepare',
    method: 'POST',
    path: '/api/v1/_t/denied-prepare',
    audit: null,
    prepare: async (rc) => {
      seen.order.push('prepare');
      throw await rc.authzDenied('system.users.read');
    },
    handler: async () => {
      seen.order.push('handler');
      return { body: {} };
    },
  }),
  route({
    ...pub,
    id: 't.denied.tx',
    method: 'POST',
    path: '/api/v1/_t/denied-tx',
    audit: null,
    handler: async (rc) => {
      seen.order.push('handler');
      throw await rc.authzDenied('system.users.read');
    },
  }),
  route({
    ...pub,
    id: 't.self.prepare',
    method: 'POST',
    path: '/api/v1/_t/self-prepare',
    tx: 'self',
    audit: 'branches.create',
    prepare: async (rc) => {
      await rc.audit({ entity: 'branches', entityId: null });
    },
    handler: async (rc) => {
      if (seen.runs++ > 0) await rc.audit({ entity: 'branches', entityId: null });
      return { body: {} };
    },
  }),
  route({
    ...pub,
    id: 't.response',
    method: 'PUT',
    path: '/api/v1/_t/response',
    audit: null,
    handler: async (rc) => rc.c.text('plain', 202),
  }),
  route({
    ...pub,
    id: 't.empty',
    method: 'DELETE',
    path: '/api/v1/_t/empty',
    audit: null,
    handler: async () => ({}),
  }),
]);

/** A page route: `session: 'none'`, no database at all (S29). */
const NONE_ROUTE = route({
  id: 't.none',
  method: 'GET',
  path: '/t/none',
  public: true,
  session: 'none',
  idempotency: 'none',
  audit: null,
  handler: async (rc) => ({ body: { ok: true, auth: rc.auth } }),
});

function appWith(state: AppState, routes: RouteDecl[] = ROUTES) {
  const log = recordingLogger();
  const app = createApp({ state, version: '0.1.0', buildId: 'b', log, routes });
  return { app, log, agent: createAgent(app) };
}

const count = (table: 'branches' | 'audit_log'): Promise<number> => countRows(h.db.selectFrom(table));

describe.skipIf(!ctx.available)(`route runtime [${engineLabel()}]`, () => {
  let dataDir: string;
  let t: ReturnType<typeof appWith>;

  beforeAll(async () => {
    h = await testDb();
    dataDir = await fsp.mkdtemp(path.join(os.tmpdir(), 'altis-route-runtime-'));
    await runMigrations(h, { appVersion: '0.1.0', dataDir, migrations: PHASE1_MIGRATIONS });
  });

  afterAll(async () => {
    await h?.close();
    if (dataDir !== undefined) await fsp.rm(dataDir, { recursive: true, force: true });
  });

  beforeEach(async () => {
    await h.db.deleteFrom('branches').execute();
    await h.db.deleteFrom('audit_log').execute();
    await h.db.updateTable('audit_head').set({ last_seq: 0, last_hash: '0'.repeat(64) }).where('id', '=', 1).execute();
    seen.hooks = [];
    seen.order = [];
    seen.runs = 0;
    seen.afterCommitRows = [];
    t = appWith({ phase: 'ready', db: h, config: sampleConfig() });
  });

  describe('handler transaction', () => {
    it('a POST that inserts and audits once → its status, body and headers; the row and one audit entry exist', async () => {
      const res = await t.agent.post('/api/v1/_t/insert');
      expect(res.status).toBe(201);
      expect(res.headers.get('x-test')).toBe('yes');
      const id = (res.json as { id: string }).id;
      expect(await h.db.selectFrom('branches').select('id').execute()).toEqual([{ id }]);
      const audit = await h.db.selectFrom('audit_log').selectAll().execute();
      expect(audit).toHaveLength(1);
      expect(audit[0]).toMatchObject({ action: 'branches.create', entity: 'branches', entity_id: id, actor_type: 'anonymous', actor_id: null });
      expect(await verifyAuditChain(h)).toMatchObject({ ok: true });
    });

    it('afterCommit runs once, after COMMIT', async () => {
      await t.agent.post('/api/v1/_t/insert');
      expect(seen.hooks).toEqual(['insert.afterCommit']);
      expect(seen.afterCommitRows).toEqual([1]);
    });

    it('a handler that inserts, audits and throws CONFLICT_STALE → 409: no row, no audit, no hook', async () => {
      const res = await t.agent.post('/api/v1/_t/conflict');
      expect(res.status).toBe(409);
      expect((res.json as { code: string }).code).toBe('CONFLICT_STALE');
      expect(await count('branches')).toBe(0);
      expect(await count('audit_log')).toBe(0);
      await new Promise((resolve) => setImmediate(resolve));
      expect(seen.hooks).toEqual([]);
    });

    it('a declared-audit handler that never audits → 500 AUDIT_MISSING, nothing committed, no hook', async () => {
      const res = await t.agent.post('/api/v1/_t/noaudit');
      expect(res.status).toBe(500);
      expect(res.json).toEqual({ type: 'about:blank', title: expect.any(String), status: 500, code: 'AUDIT_MISSING', traceId: expect.any(String) });
      expect(await count('branches')).toBe(0);
      expect(seen.hooks).toEqual([]);
      expect(t.log.lines.some((l) => l.level === 'error' && l.fields['code'] === 'AUDIT_MISSING')).toBe(true);
    });

    it('forced retry (B3): TX_CONFLICT on the first run → 200 after the retry, one audit row, the hook ran once', async () => {
      const res = await t.agent.post('/api/v1/_t/retry');
      expect(res.status).toBe(200);
      expect(res.json).toEqual({ runs: 2 });
      expect(await count('branches')).toBe(1);
      expect(await count('audit_log')).toBe(1);
      expect(seen.hooks).toEqual(['retry.afterCommit.2']);
    });

    it('a security event besides the declared entry → 200, both written', async () => {
      const res = await t.agent.post('/api/v1/_t/security');
      expect(res.status).toBe(200);
      expect((await h.db.selectFrom('audit_log').select('action').orderBy('seq').execute()).map((r) => r.action)).toEqual([
        'branches.create',
        'auth.login.success',
      ]);
    });

    it('a second entry of its own action, or another action → 500 AUDIT_MISSING, rolled back', async () => {
      for (const p of ['/api/v1/_t/twice', '/api/v1/_t/foreign', '/api/v1/_t/null-foreign']) {
        const res = await t.agent.post(p);
        expect(res.status, p).toBe(500);
        expect((res.json as { code: string }).code, p).toBe('AUDIT_MISSING');
      }
      expect(await count('branches')).toBe(0);
      expect(await count('audit_log')).toBe(0);
    });

    it('alsoAudits: a listed action may accompany (audit: null → 200); it never stands in for the declared entry, and others stay foreign (500)', async () => {
      expect((await t.agent.post('/api/v1/_t/null-also')).status).toBe(200);
      expect((await h.db.selectFrom('audit_log').select('action').execute()).map((r) => r.action)).toEqual(['auth.2fa.disable']);
      for (const p of ['/api/v1/_t/also-foreign', '/api/v1/_t/also-declared']) {
        const res = await t.agent.post(p);
        expect(res.status, p).toBe(500);
        expect((res.json as { code: string }).code, p).toBe('AUDIT_MISSING');
      }
      expect(await count('audit_log')).toBe(1);
    });

    it('audit: null allows the security set only; rc.audit throws there (500 INTERNAL)', async () => {
      expect((await t.agent.post('/api/v1/_t/null-security')).status).toBe(200);
      expect(await count('audit_log')).toBe(1);
      const res = await t.agent.post('/api/v1/_t/null-audit');
      expect(res.status).toBe(500);
      expect((res.json as { code: string }).code).toBe('INTERNAL');
      expect(await count('audit_log')).toBe(1);
    });

    it('prepare runs once, before (outside) the handler transaction, and its result is rc.prepared', async () => {
      const res = await t.agent.post('/api/v1/_t/prepare', { secret: 'abcd' });
      expect(res.status).toBe(200);
      expect(res.json).toEqual({ prepared: 'prepared(4)' });
      expect(seen.order).toEqual(['prepare:no-trx', 'handler:prepared(4)', 'handler:prepared(4)']);
    });

    it("tx: 'handler': rc.audit and rc.withTx throw a TypeError inside prepare (500 INTERNAL, nothing written, no handler)", async () => {
      for (const p of ['/api/v1/_t/prepare-audit', '/api/v1/_t/prepare-withtx']) {
        const res = await t.agent.post(p);
        expect(res.status, p).toBe(500);
        expect((res.json as { code: string }).code, p).toBe('INTERNAL');
        const err = t.log.lines.findLast((l) => l.level === 'error')?.fields['err'];
        expect(err, p).toBeInstanceOf(TypeError);
        expect((err as Error).message, p).toMatch(/prepare/);
      }
      expect(seen.order).toEqual(['prepare', 'prepare']);
      expect(await count('branches')).toBe(0);
      expect(await count('audit_log')).toBe(0);
    });

    it('rc.authzDenied: the 403 AUTHZ_DENIED to throw from prepare; a TypeError inside the handler transaction (500)', async () => {
      const denied = await t.agent.post('/api/v1/_t/denied-prepare');
      expect([denied.status, (denied.json as { code: string }).code]).toEqual([403, 'AUTHZ_DENIED']);
      const inside = await t.agent.post('/api/v1/_t/denied-tx');
      expect([inside.status, (inside.json as { code: string }).code]).toEqual([500, 'INTERNAL']);
      const err = t.log.lines.findLast((l) => l.level === 'error')?.fields['err'];
      expect(err).toBeInstanceOf(TypeError);
      expect((err as Error).message).toMatch(/rc\.authzDenied\(\): route t\.denied\.tx is inside a transaction/);
      expect(seen.order).toEqual(['prepare', 'handler']);
    });

    it("tx: 'self': an audit committed by prepare counts toward audit-once (once → 200; again in the handler → 500)", async () => {
      expect((await t.agent.post('/api/v1/_t/self-prepare')).status).toBe(200);
      expect(await count('audit_log')).toBe(1);
      const res = await t.agent.post('/api/v1/_t/self-prepare');
      expect(res.status).toBe(500);
      expect((res.json as { code: string }).code).toBe('AUDIT_MISSING');
      expect(await count('audit_log')).toBe(3);
    });

    it("rc.auditedBefore: the actor's earlier entry of the declared action on the entity stands for this request's one entry", async () => {
      const [x, y, entityId] = [newId(), newId(), newId()];
      const post = (body: Record<string, unknown>) => t.agent.post('/api/v1/_t/repeat', body);
      expect([(await post({ actorId: x, entityId })).json]).toEqual([{ repeated: false }]);
      // Repeated by the same actor: 200 with no new entry.
      const again = await post({ actorId: x, entityId });
      expect([again.status, again.json]).toEqual([200, { repeated: true }]);
      expect(await count('audit_log')).toBe(1);
      // Another actor, or another entity, finds none and audits as usual.
      expect((await post({ actorId: y, entityId })).json).toEqual({ repeated: false });
      expect((await post({ actorId: x, entityId: newId() })).json).toEqual({ repeated: false });
      expect(await count('audit_log')).toBe(3);
      // Found and audited again: two entries for one request → 500 AUDIT_MISSING.
      const both = await post({ actorId: x, entityId, alsoAudit: true });
      expect([both.status, (both.json as { code: string }).code]).toEqual([500, 'AUDIT_MISSING']);
      // Outside a transaction it is a programming error (500 INTERNAL).
      const outside = await post({ actorId: x, entityId, outside: true });
      expect([outside.status, (outside.json as { code: string }).code]).toEqual([500, 'INTERNAL']);
    });

    it('a Response from the handler is sent as it is; an empty result is 204', async () => {
      const res = await t.agent.put('/api/v1/_t/response');
      expect(res.status).toBe(202);
      expect(res.text).toBe('plain');
      const empty = await t.agent.delete('/api/v1/_t/empty');
      expect(empty.status).toBe(204);
      expect(empty.text).toBe('');
    });
  });

  describe('afterResponse', () => {
    it('runs after the response is built; a failing hook is only logged and the rest still run', async () => {
      const res = await t.app.request('/api/v1/_t/after', { method: 'POST' });
      expect(seen.hooks).toEqual([]); // not before the response
      expect(res.status).toBe(200);
      await new Promise((resolve) => setImmediate(resolve));
      await new Promise((resolve) => setImmediate(resolve));
      expect(seen.hooks).toEqual(['after.1', 'after.3']);
      const line = t.log.lines.find((l) => l.level === 'error');
      expect(line?.msg).toMatch(/afterResponse/);
      expect(line?.fields['requestId']).toBe(res.headers.get('x-request-id'));
    });

    it('a hook registered by a handler whose transaction rolled back never runs', async () => {
      await t.agent.post('/api/v1/_t/conflict');
      await new Promise((resolve) => setImmediate(resolve));
      expect(seen.hooks).toEqual([]);
    });
  });

  describe('GET and tx: self', () => {
    it('a GET handler has rc.trx === null, rc.tx() throws a TypeError, rc.withTx works; the actor is anonymous', async () => {
      const res = await t.agent.get('/api/v1/_t/get');
      expect(res.status).toBe(200);
      expect(res.json).toEqual({ trxNull: true, txError: 'TypeError', n: 0, actor: { type: 'anonymous', id: null, ip: '203.0.113.10' } });
    });

    it('a tx: self route that commits one rc.withTx (with its audit) and then throws 429 keeps that row', async () => {
      const res = await t.agent.post('/api/v1/_t/self429');
      expect(res.status).toBe(429);
      expect(res.headers.get('retry-after')).toBe('30');
      expect(await count('branches')).toBe(1);
      expect((await h.db.selectFrom('audit_log').select('action').execute()).map((r) => r.action)).toEqual(['branches.create']);
    });

    it('tx: self counts the audits of every rc.withTx: one → 200, none → 500 AUDIT_MISSING (its commits stay)', async () => {
      expect((await t.agent.post('/api/v1/_t/self')).status).toBe(200);
      const res = await t.agent.post('/api/v1/_t/self-none');
      expect(res.status).toBe(500);
      expect((res.json as { code: string }).code).toBe('AUDIT_MISSING');
      expect(await count('branches')).toBe(2);
      expect(await count('audit_log')).toBe(1);
    });
  });

  describe('validation (strict input, P10 body budget)', () => {
    it('a valid JSON body is parsed and validated', async () => {
      const res = await t.agent.post('/api/v1/_t/body', { a: 1 });
      expect(res.status).toBe(200);
      expect(res.json).toEqual({ got: { a: 1 } });
      const charset = await t.agent.post('/api/v1/_t/body', '{"a":2}', { 'content-type': 'application/json; charset=utf-8' });
      expect(charset.json).toEqual({ got: { a: 2 } });
    });

    it('1 000 001 bytes → 413 PAYLOAD_TOO_LARGE; 1 000 000 bytes are read (and then refused by the schema)', async () => {
      const sized = (n: number) => {
        const head = '{"a":1,"pad":"';
        return head + 'x'.repeat(n - head.length - 2) + '"}';
      };
      expect(sized(1_000_001)).toHaveLength(1_000_001);
      const over = await t.agent.post('/api/v1/_t/body', sized(1_000_001));
      expect(over.status).toBe(413);
      expect((over.json as { code: string }).code).toBe('PAYLOAD_TOO_LARGE');
      const at = await t.agent.post('/api/v1/_t/body', sized(1_000_000));
      expect(at.status).toBe(422);
      const chunked = await t.app.request('/api/v1/_t/body', {
        method: 'POST',
        headers: { 'content-type': 'application/json' },
        body: new ReadableStream({
          start(controller) {
            const chunk = new TextEncoder().encode(sized(1_000_001));
            controller.enqueue(chunk.slice(0, 500_000));
            controller.enqueue(chunk.slice(500_000));
            controller.close();
          },
        }),
        duplex: 'half',
      } as RequestInit);
      expect(chunked.status).toBe(413);
    });

    it('duplicate keys or bad JSON → 400 INVALID_JSON', async () => {
      for (const text of ['{"a":1,"a":2}', '{"a":1', '', '{"a":1} x']) {
        const res = await t.agent.post('/api/v1/_t/body', text);
        expect(res.status, text).toBe(400);
        expect((res.json as { code: string }).code).toBe('INVALID_JSON');
      }
      const bytes = new Uint8Array([0x7b, 0x22, 0x61, 0x22, 0x3a, 0x22, 0xff, 0x22, 0x7d]); // {"a":"\xff"}
      const invalidUtf8 = await t.app.request('/api/v1/_t/body', { method: 'POST', headers: { 'content-type': 'application/json' }, body: bytes });
      expect(invalidUtf8.status).toBe(400);
    });

    it('a body that is not application/json → 415 UNSUPPORTED_MEDIA_TYPE', async () => {
      const plain = await t.agent.post('/api/v1/_t/body', '{"a":1}', { 'content-type': 'text/plain' });
      expect(plain.status).toBe(415);
      expect((plain.json as { code: string }).code).toBe('UNSUPPORTED_MEDIA_TYPE');
      const none = await t.app.request('/api/v1/_t/body', { method: 'POST' });
      expect(none.status).toBe(415);
      const lookalike = await t.agent.post('/api/v1/_t/body', '{"a":1}', { 'content-type': 'application/jsonx' });
      expect(lookalike.status).toBe(415);
    });

    it('an unknown key → 422 VALIDATION_FAILED, errors[0].code unrecognized_keys; no input value in the body', async () => {
      const res = await t.agent.post('/api/v1/_t/body', { a: 1, zz: 'hunter2' });
      expect(res.status).toBe(422);
      const body = res.json as { code: string; errors: { path: string; code: string }[] };
      expect(body.code).toBe('VALIDATION_FAILED');
      expect(body.errors[0]?.code).toBe('unrecognized_keys');
      expect(res.text).not.toContain('hunter2');
      expect(res.text).not.toContain('zz');
      const typed = await t.agent.post('/api/v1/_t/body', { a: 'hunter2', note: 'too long note' });
      expect((typed.json as { errors: unknown }).errors).toEqual([
        { path: 'a', code: 'invalid_type' },
        { path: 'note', code: 'too_big' },
      ]);
      expect(typed.text).not.toContain('hunter2');
      expect(typed.text).not.toContain('too long note');
    });

    it('text that is not well-formed UTF-16 (a lone surrogate) → 422 VALIDATION_FAILED, path and code only; no handler', async () => {
      const cases: [string, { path: string; code: string }[]][] = [
        ['{"s":"a\\ud800b"}', [{ path: 's', code: 'invalid_format' }]],
        ['{"s":"\\udc00"}', [{ path: 's', code: 'invalid_format' }]],
        ['{"s":"\\ude00\\ud83d"}', [{ path: 's', code: 'invalid_format' }]],
        ['{"list":["ok","\\ud83d"]}', [{ path: 'list.1', code: 'invalid_format' }]],
        ['{"deep":{"t":"x\\udfffy"}}', [{ path: 'deep.t', code: 'invalid_format' }]],
        ['{"map":{"\\ud800":"v","ok":"\\udbff"}}', [{ path: 'map', code: 'invalid_key' }, { path: 'map.ok', code: 'invalid_format' }]],
        // The schemas run first: an unknown key is refused without its name (and the text under it is never looked
        // into), as is a body of the wrong type; no value is reported.
        ['{"s":"\\ud800","zz":1}', [{ path: '', code: 'unrecognized_keys' }]],
        ['{"zz\\ud800zz":"\\ud800"}', [{ path: '', code: 'unrecognized_keys' }]],
        ['"\\ud800"', [{ path: '', code: 'invalid_type' }]],
      ];
      for (const [text, errors] of cases) {
        const res = await t.agent.post('/api/v1/_t/text', text);
        expect(res.status, text).toBe(422);
        expect((res.json as { code: string }).code).toBe('VALIDATION_FAILED');
        expect((res.json as { errors: unknown }).errors, text).toEqual(errors);
        expect(res.text.toLowerCase()).not.toMatch(/ud[89a-f]/);
      }
      expect(seen.runs).toBe(0);
      // A surrogate pair is well-formed.
      const pair = await t.agent.post('/api/v1/_t/text', '{"s":"\\ud83d\\ude00","map":{"\\ud83d\\ude00":"ok"}}');
      expect(pair.status).toBe(200);
      expect(pair.json).toEqual({ got: { s: '\u{1F600}', map: { '\u{1F600}': 'ok' } } });
      expect(seen.runs).toBe(1);
    });

    it('T23: a GET route declared sideEffects: HEAD → 404 and a cross-site request → 403 ORIGIN_DENIED, its handler never runs', async () => {
      const head = await t.app.request('/api/v1/_t/side-effects', { method: 'HEAD' });
      expect(head.status).toBe(404);
      const cross = await t.agent.get('/api/v1/_t/side-effects', undefined, { 'sec-fetch-site': 'cross-site' });
      expect(cross.status).toBe(403);
      expect((cross.json as { code: string }).code).toBe('ORIGIN_DENIED');
      expect(seen.runs).toBe(0);
      const same = await t.agent.get('/api/v1/_t/side-effects', undefined, { 'sec-fetch-site': 'same-origin' });
      expect(same.json).toEqual({ ran: true });
      // An ordinary GET route answers HEAD and a cross-site GET as before.
      expect((await t.app.request('/api/v1/_t/query?n=1', { method: 'HEAD' })).status).toBe(200);
      expect((await t.agent.get('/api/v1/_t/query?n=1', undefined, { 'sec-fetch-site': 'cross-site' })).status).toBe(200);
    });

    it('query strings are coerced (z.coerce.number, z.stringbool) and strict', async () => {
      expect((await t.agent.get('/api/v1/_t/query?n=5&f=true')).json).toEqual({ got: { n: 5, f: true } });
      expect((await t.agent.get('/api/v1/_t/query?n=7')).json).toEqual({ got: { n: 7 } });
      const bad = await t.agent.get('/api/v1/_t/query?n=x');
      expect(bad.status).toBe(422);
      expect((bad.json as { errors: unknown }).errors).toEqual([{ path: 'n', code: 'invalid_type' }]);
      const extra = await t.agent.get('/api/v1/_t/query?n=1&zz=2');
      expect((extra.json as { errors: { code: string }[] }).errors[0]?.code).toBe('unrecognized_keys');
      expect((await t.agent.get('/api/v1/_t/query?n=1&n=2')).status).toBe(422);
    });

    it('path params are validated', async () => {
      expect((await t.agent.get('/api/v1/_t/items/42')).json).toEqual({ got: { id: '42' } });
      const bad = await t.agent.get('/api/v1/_t/items/abc');
      expect(bad.status).toBe(422);
      expect((bad.json as { errors: unknown }).errors).toEqual([{ path: 'id', code: 'invalid_format' }]);
    });
  });

  describe("session: 'none' (S29)", () => {
    it('with an altis_sid cookie and no database: 200, the database is never touched', async () => {
      const bare = appWith({ phase: 'ready' }, [NONE_ROUTE]);
      bare.agent.setCookie('altis_sid', 'a'.repeat(43));
      const res = await bare.agent.get('/t/none');
      expect(res.status).toBe(200);
      expect(res.json).toEqual({ ok: true, auth: null });

      const trap = new Proxy({} as DbHandle, {
        get: () => {
          throw new Error('the database was touched');
        },
      });
      const trapped = appWith({ phase: 'ready', db: trap }, [NONE_ROUTE]);
      trapped.agent.setCookie('altis_sid', 'a'.repeat(43));
      expect((await trapped.agent.get('/t/none')).status).toBe(200);
    });
  });
});
