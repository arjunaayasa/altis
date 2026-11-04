import fsp from 'node:fs/promises';
import os from 'node:os';
import path from 'node:path';
import type { OpKindHandler, OpsMachine } from '@altis/core';
import { PHASE1_MIGRATIONS, runMigrations, type DbHandle } from '@altis/db';
import type { Env } from '@altis/platform';
import type { OpView } from '@altis/shared/api/ops';
import { afterAll, afterEach, beforeAll, beforeEach, describe, expect, it, vi, type Mock } from 'vitest';
import { engineLabel, testDb, testDbContext, type TestDbHandle } from '../../../../tools/test/test-db.js';
import { createApp } from '../../src/app.js';
import { csrfKey, opsCsrfToken } from '../../src/http/csrf.js';
import { createOpsFence } from '../../src/http/ops-fence.js';
import { createAppOps } from '../../src/services.js';
import { createAgent, type Agent, type AgentReply } from '../agent.js';
import { flagOf, readOpJson, writeFlag, writeOp, type WrittenOp } from '../ops-support.js';
import { seedStaff, sessionCookieFor, sessionCsrfFor } from '../support-auth.js';
import { recordingLogger, sampleConfig } from '../support.js';

// The ops routes and `opsAuth` (spec §9.4, §7.4; plan Task 15, S3, decision C20) on the engine picked by ALTIS_TEST_DB:
// the `altis_ops` cookie alone opens them without a single SQL statement past a restore's point of no return; before
// it a session with the op kind's permission does too (S3); the cookie's CSRF token; drive in worker and external
// mode; cancel, takeover and the report.

const ctx = testDbContext();
/** In the past: an audit row may not be dated ahead of the real clock. */
const NOW = Date.UTC(2026, 9, 20, 9, 0, 5);
const CONFIG = sampleConfig({ db: { dialect: 'sqlite' } });
const OPS_COOKIE = '__Host-altis_ops'; // sampleConfig's baseUrl is https
const SID_COOKIE = '__Host-altis_sid';
const MINUTE = 60_000;

const code = (res: AgentReply): string | undefined => (res.json as { code?: string } | undefined)?.code;
const view = (res: AgentReply): OpView => res.json as OpView;

/** A `backup` kind that ends the op in one step (frozen → exporting → done), for drive in external mode. */
const backupKind: OpKindHandler = {
  kind: 'backup',
  initialState: 'frozen',
  maintenance: 'backup',
  freeze: false,
  step: async (_ctx, op) => ({ ...op, state: op.state === 'frozen' ? 'exporting' : 'done', progress: op.state === 'frozen' ? 50 : 100 }),
};

describe.skipIf(!ctx.available)(`ops routes and opsAuth [${engineLabel()}]`, () => {
  let h: TestDbHandle;
  let root: string;
  let dataDir: string;
  let now: number;
  let statements: number;
  let counted: DbHandle;
  let ops: OpsMachine;
  let step: Mock<OpsMachine['step']>;
  let app: ReturnType<typeof createApp>;
  let superAdmin: string;
  let admin: string;

  beforeAll(async () => {
    h = await testDb();
    root = await fsp.realpath(await fsp.mkdtemp(path.join(os.tmpdir(), 'altis-ops-api-')));
    await runMigrations(h, { appVersion: '0.1.0', dataDir: path.join(root, 'mig'), migrations: PHASE1_MIGRATIONS });
    superAdmin = (await seedStaff(h, { username: 'kepala', roles: [{ key: 'super_admin' }], now: NOW })).id;
    admin = (await seedStaff(h, { username: 'admin', roles: [{ key: 'admin' }], now: NOW })).id;
    // Every statement the app runs goes through this handle's plugin.
    const counter: Parameters<DbHandle['db']['withPlugin']>[0] = {
      transformQuery: ({ node }) => {
        statements += 1;
        return node;
      },
      transformResult: async ({ result }) => result,
    };
    counted = { ...h, db: h.db.withPlugin(counter) };
  });

  afterAll(async () => {
    await h?.close();
    if (root !== undefined) await fsp.rm(root, { recursive: true, force: true });
  });

  beforeEach(async () => {
    dataDir = await fsp.mkdtemp(path.join(root, 'data-'));
    now = NOW;
    statements = 0;
    await h.db.deleteFrom('sessions').execute();
  });

  afterEach(async () => {
    await ops?.close();
    vi.restoreAllMocks();
  });

  /** The app over the counted handle; `external` runs it with ALTIS_RUNNER=off (drive steps the op). */
  function build(o: { external?: boolean; resumeTakesMs?: number } = {}): void {
    const env: Env = o.external === true ? { ALTIS_RUNNER: 'off' } : {};
    const log = recordingLogger();
    const state = { phase: 'ready' as const, db: counted, config: CONFIG };
    ops = createAppOps(state, { dataDir, version: '0.1.0', log, clock: () => now, kinds: [backupKind] });
    step = vi.fn(ops.step.bind(ops));
    const resume = async (): ReturnType<OpsMachine['resume']> => {
      const status = await ops.resume();
      if (o.resumeTakesMs !== undefined) await new Promise((resolve) => setTimeout(resolve, o.resumeTakesMs));
      return status;
    };
    const machine: OpsMachine = { ...ops, step, resume };
    const opsFence = createOpsFence({ dataDir, intervalMs: 0, clock: () => now, onEpoch() {}, onOpEnded() {} });
    app = createApp({ state, version: '0.1.0', buildId: 'b', log, clock: () => now, env, dataDir, services: { ops: machine, opsFence } });
  }

  /** A browser holding `cookies` (`ops`: the op's token; `sid`: a session token). */
  function browser(cookies: { ops?: string; sid?: string } = {}): Agent {
    const agent = createAgent(app);
    if (cookies.ops !== undefined) agent.setCookie(OPS_COOKIE, cookies.ops);
    if (cookies.sid !== undefined) agent.setCookie(SID_COOKIE, cookies.sid);
    return agent;
  }

  const session = (userId: string, o: { reauth?: boolean } = {}): Promise<string> =>
    sessionCookieFor(h, userId, { now, reauthAt: o.reauth === true ? now : null });
  const opsToken = (opId: string): string => opsCsrfToken(csrfKey(CONFIG), opId);

  /** A restore op in `state` with its flag; past its point of no return from `loading` on. */
  async function restoreOp(state: string, pointOfNoReturn = state === 'loading'): Promise<WrittenOp> {
    const written = await writeOp(dataDir, { kind: 'restore', state, pointOfNoReturn, at: now });
    await writeFlag(dataDir, flagOf('restore', written.op.opId, now));
    return written;
  }

  const auditRows = (action: string) =>
    h.db.selectFrom('audit_log').select(['action', 'actor_id', 'entity_id', 'meta']).where('action', '=', action).execute();

  describe('a restore past its point of no return: the cookie alone, and no SQL', () => {
    it('a valid altis_ops and no session → GET ops/current 200, its CSRF token, and no statement on the database', async () => {
      build();
      const { op, token } = await restoreOp('loading');
      statements = 0;
      const res = await browser({ ops: token }).get('/api/v1/ops/current');
      expect(res.status, res.text).toBe(200);
      expect(view(res)).toMatchObject({ opId: op.opId, kind: 'restore', state: 'loading', pointOfNoReturn: true, terminal: false });
      expect(view(res).csrfToken).toBe(opsToken(op.opId));
      expect(view(res).driveable).toBe(true);
      expect(res.headers.get('x-altis-test-gate')).toBe('PASSED');
      expect(statements).toBe(0);
    });

    it('a wrong cookie → 401 OPS_AUTH_REQUIRED; a session is not even read (no statement)', async () => {
      build();
      await restoreOp('loading');
      const sid = await session(superAdmin);
      statements = 0;
      const wrong = await browser({ ops: 'x'.repeat(43) }).get('/api/v1/ops/current');
      expect(wrong.status).toBe(401);
      expect(code(wrong)).toBe('OPS_AUTH_REQUIRED');
      expect(wrong.headers.get('x-altis-test-gate')).toBe('OPS_AUTH_REQUIRED');
      const withSession = await browser({ sid }).get('/api/v1/ops/current');
      expect(code(withSession)).toBe('OPS_AUTH_REQUIRED');
      expect(statements).toBe(0);
    });

    it('the cookie works until an hour after the op finished: 59 min → 200, 61 min → 401', async () => {
      build();
      const { op, token } = await restoreOp('loading');
      await writeOp(dataDir, { ...op, state: 'done', at: now });
      await writeFlag(dataDir, null);
      now += 59 * MINUTE;
      expect((await browser({ ops: token }).get('/api/v1/ops/current')).status).toBe(200);
      now += 2 * MINUTE;
      const late = await browser({ ops: token }).get('/api/v1/ops/current');
      expect(late.status).toBe(401);
      expect(code(late)).toBe('OPS_AUTH_REQUIRED');
    });
  });

  describe('a restore before its point of no return (prechecked): sessions still work (S3)', () => {
    it('a super admin session → 200 (no CSRF token handed out); an admin session (no system.backup.restore) → 403', async () => {
      build();
      await restoreOp('prechecked');
      const ok = await browser({ sid: await session(superAdmin) }).get('/api/v1/ops/current');
      expect(ok.status, ok.text).toBe(200);
      expect(view(ok)).toMatchObject({ state: 'prechecked', pointOfNoReturn: false, csrfToken: null });
      const denied = await browser({ sid: await session(admin) }).get('/api/v1/ops/current');
      expect(denied.status).toBe(403);
      expect(code(denied)).toBe('AUTHZ_DENIED');
      expect(denied.headers.get('x-altis-test-gate')).toBe('AUTHZ_DENIED');
    });

    it('a super admin with a fresh reauth cancels it: failed, the flag lowered, one ops.cancel row', async () => {
      build();
      const { op } = await restoreOp('prechecked');
      const sid = await session(superAdmin, { reauth: true });
      const res = await browser({ sid }).post('/api/v1/ops/cancel', undefined, { 'x-csrf-token': sessionCsrfFor(CONFIG, sid) });
      expect(res.status, res.text).toBe(200);
      expect(view(res)).toMatchObject({ opId: op.opId, state: 'failed', terminal: true });
      expect((await readOpJson(dataDir)).state).toBe('failed');
      await expect(fsp.stat(path.join(dataDir, 'ops', 'maintenance.json'))).rejects.toMatchObject({ code: 'ENOENT' });
      const rows = await auditRows('ops.cancel');
      expect(rows).toHaveLength(1);
      expect(rows[0]).toMatchObject({ actor_id: superAdmin, entity_id: op.opId });
      expect(JSON.parse(rows[0]!.meta)).toEqual({ opId: op.opId, kind: 'restore' });
    });
  });

  describe('ops/drive', () => {
    it('only the cookie and no X-CSRF-Token → 403 CSRF_INVALID; with opsCsrfToken → 200; worker mode never steps', async () => {
      build();
      const { op, token } = await writeOp(dataDir, { kind: 'backup', state: 'frozen', at: now });
      const agent = browser({ ops: token });
      const refused = await agent.post('/api/v1/ops/drive', {});
      expect(refused.status).toBe(403);
      expect(code(refused)).toBe('CSRF_INVALID');
      // Another op's token: the last character changed, never to itself (a ULID ends in `0` once in 32).
      const otherOpId = `${op.opId.slice(0, -1)}${op.opId.endsWith('0') ? '1' : '0'}`;
      const wrong = await agent.post('/api/v1/ops/drive', {}, { 'x-csrf-token': opsToken(otherOpId) });
      expect(code(wrong)).toBe('CSRF_INVALID');
      const ok = await agent.post('/api/v1/ops/drive', {}, { 'x-csrf-token': opsToken(op.opId) });
      expect(ok.status, ok.text).toBe(200);
      expect(view(ok)).toMatchObject({ opId: op.opId, state: 'frozen', mode: 'worker', driveable: true });
      expect(step).not.toHaveBeenCalled();
    });

    it('external mode: one drive steps the op (≤ 20 s) and answers its new status', async () => {
      build({ external: true });
      const { op, token } = await writeOp(dataDir, { kind: 'backup', state: 'frozen', at: now });
      const res = await browser({ ops: token }).post('/api/v1/ops/drive', {}, { 'x-csrf-token': opsToken(op.opId) });
      expect(res.status, res.text).toBe(200);
      expect(step).toHaveBeenCalledTimes(1);
      expect(step).toHaveBeenCalledWith(20_000);
      expect(view(res)).toMatchObject({ opId: op.opId, state: 'done', terminal: true, mode: 'external', driveable: false });
    });

    it('{resume: true} brings an op in needs_attention back to the state it left (worker mode: not stepped)', async () => {
      build();
      const { op, token } = await writeOp(dataDir, { kind: 'backup', state: 'needs_attention', stateBefore: 'exporting', at: now });
      const before = await browser({ ops: token }).get('/api/v1/ops/current');
      expect(view(before)).toMatchObject({ needsAttention: true, driveable: false });
      const res = await browser({ ops: token }).post('/api/v1/ops/drive', { resume: true }, { 'x-csrf-token': opsToken(op.opId) });
      expect(res.status, res.text).toBe(200);
      expect(view(res)).toMatchObject({ state: 'exporting', needsAttention: false, driveable: true });
      expect(step).not.toHaveBeenCalled();
    });

    it('{resume: true} in external mode steps with what is left of the 20 s request (P9; final review)', async () => {
      build({ external: true, resumeTakesMs: 300 });
      const { op, token } = await writeOp(dataDir, { kind: 'backup', state: 'needs_attention', stateBefore: 'frozen', at: now });
      const res = await browser({ ops: token }).post('/api/v1/ops/drive', { resume: true }, { 'x-csrf-token': opsToken(op.opId) });
      expect(res.status, res.text).toBe(200);
      expect(step).toHaveBeenCalledTimes(1);
      const budget = step.mock.calls[0]![0];
      expect(budget).toBeGreaterThan(15_000);
      expect(budget).toBeLessThanOrEqual(20_000 - 300);
      expect(view(res)).toMatchObject({ opId: op.opId, state: 'done' });
    });

    it('a session holding the kind permission drives with the session CSRF token', async () => {
      build();
      await writeOp(dataDir, { kind: 'backup', state: 'frozen', at: now });
      const sid = await session(admin); // admin holds system.backup.create
      const res = await browser({ sid }).post('/api/v1/ops/drive', {}, { 'x-csrf-token': sessionCsrfFor(CONFIG, sid) });
      expect(res.status, res.text).toBe(200);
      expect(view(res).csrfToken).toBeNull();
    });
  });

  describe('ops/cancel', () => {
    it('without a fresh reauth → 401 AUTH_REAUTH_REQUIRED; the cookie alone → 401 OPS_AUTH_REQUIRED; the op untouched', async () => {
      build();
      const { op, token } = await writeOp(dataDir, { kind: 'backup', state: 'exporting', at: now });
      const before = (await auditRows('ops.cancel')).length;
      const sid = await session(superAdmin);
      const stale =await browser({ sid }).post('/api/v1/ops/cancel', undefined, { 'x-csrf-token': sessionCsrfFor(CONFIG, sid) });
      expect(stale.status).toBe(401);
      expect(code(stale)).toBe('AUTH_REAUTH_REQUIRED');
      const cookieOnly = await browser({ ops: token }).post('/api/v1/ops/cancel', undefined, { 'x-csrf-token': opsToken(op.opId) });
      expect(cookieOnly.status).toBe(401);
      expect(code(cookieOnly)).toBe('OPS_AUTH_REQUIRED');
      expect((await readOpJson(dataDir)).state).toBe('exporting');
      expect(await auditRows('ops.cancel')).toHaveLength(before);
    });

    it('past the point of no return → 409 OPS_POINT_OF_NO_RETURN, no audit row', async () => {
      build();
      await writeOp(dataDir, { kind: 'update', state: 'switched', pointOfNoReturn: true, at: now });
      const before = (await auditRows('ops.cancel')).length;
      const sid = await session(superAdmin, { reauth: true });
      const res = await browser({ sid }).post('/api/v1/ops/cancel', undefined, { 'x-csrf-token': sessionCsrfFor(CONFIG, sid) });
      expect(res.status).toBe(409);
      expect(code(res)).toBe('OPS_POINT_OF_NO_RETURN');
      expect((await readOpJson(dataDir)).state).toBe('switched');
      expect(await auditRows('ops.cancel')).toHaveLength(before);
    });
  });

  describe('ops/takeover', () => {
    it('another super admin: a new altis_ops, the old one stops matching, op.json actor changed, one ops.takeover row', async () => {
      build();
      const { op, token: old } = await writeOp(dataDir, { kind: 'backup', state: 'exporting', at: now });
      const other = (await seedStaff(h, { username: `pengganti${Date.now()}`, roles: [{ key: 'super_admin' }], now })).id;
      const sid = await session(other, { reauth: true });
      const agent = browser({ sid });
      const res = await agent.post('/api/v1/ops/takeover', undefined, { 'x-csrf-token': sessionCsrfFor(CONFIG, sid) });
      expect(res.status, res.text).toBe(200);
      const fresh = agent.cookies.get(OPS_COOKIE);
      expect(fresh).toBeDefined();
      expect(fresh).not.toBe(old);
      const setCookie = res.headers.getSetCookie().find((c) => c.startsWith(`${OPS_COOKIE}=`))!;
      expect(setCookie).toMatch(/HttpOnly/i);
      expect(setCookie).toMatch(/SameSite=Lax/i);
      expect(setCookie).toMatch(/Secure/i);
      expect(setCookie).toMatch(/Path=\//i);
      expect(setCookie).toMatch(/Max-Age=604800/i);
      expect(view(res)).toMatchObject({ opId: op.opId, actor: { type: 'staff', id: other }, csrfToken: opsToken(op.opId) });

      expect(await ops.tokenMatches(old)).toBe(false);
      expect(await ops.tokenMatches(fresh!)).toBe(true);
      expect((await readOpJson(dataDir)).actor).toEqual({ type: 'staff', id: other });
      expect((await browser({ ops: old }).get('/api/v1/ops/current')).status).toBe(401);
      expect((await browser({ ops: fresh! }).get('/api/v1/ops/current')).status).toBe(200);

      const rows = (await auditRows('ops.takeover')).filter((r) => r.entity_id === op.opId);
      expect(rows).toHaveLength(1);
      expect(rows[0]!.actor_id).toBe(other);
      expect(JSON.parse(rows[0]!.meta)).toEqual({ opId: op.opId, from: { type: 'cli', id: null } });
    });
  });

  describe('ops/report and ops/current without an op', () => {
    it('GET ops/report → the JSON as an attachment; 404 NOT_FOUND when the op has none', async () => {
      build();
      const { op, token } = await restoreOp('loading');
      const none = await browser({ ops: token }).get('/api/v1/ops/report');
      expect(none.status).toBe(404);
      expect(code(none)).toBe('NOT_FOUND');
      const report = { conflicts: [{ table: 'branches', key: 'X' }] };
      await fsp.mkdir(path.join(dataDir, 'ops', op.opId), { recursive: true });
      await fsp.writeFile(path.join(dataDir, 'ops', op.opId, 'report.json'), JSON.stringify(report));
      statements = 0;
      const res = await browser({ ops: token }).get('/api/v1/ops/report');
      expect(res.status, res.text).toBe(200);
      expect(res.headers.get('content-type')).toMatch(/^application\/json/);
      expect(res.headers.get('content-disposition')).toBe(`attachment; filename="altis-restore-${op.opId}-report.json"`);
      expect(res.json).toEqual(report);
      expect(statements).toBe(0);
    });

    it('no op: a super admin session → 404 OPS_NONE; a session without an op permission → 403', async () => {
      build();
      const none = await browser({ sid: await session(superAdmin) }).get('/api/v1/ops/current');
      expect(none.status).toBe(404);
      expect(code(none)).toBe('OPS_NONE');
      const nobody = (await seedStaff(h, { username: `biasa${Date.now()}`, now })).id;
      const denied = await browser({ sid: await session(nobody) }).get('/api/v1/ops/current');
      expect(denied.status).toBe(403);
      expect(code(denied)).toBe('AUTHZ_DENIED');
    });
  });
});
