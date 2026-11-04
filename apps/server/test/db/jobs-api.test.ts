import fsp from 'node:fs/promises';
import os from 'node:os';
import path from 'node:path';
import { SCHEDULES, nextRun, parseCronExpr, seedSchedules, type JobHandler, type OpsMachine } from '@altis/core';
import { PHASE1_MIGRATIONS, runMigrations, withTx } from '@altis/db';
import { newId } from '@altis/shared';
import type { JobListResponse, JobView, ScheduleListResponse, ScheduleView } from '@altis/shared/api/jobs';
import { z } from 'zod';
import { afterAll, beforeAll, beforeEach, describe, expect, it } from 'vitest';
import { engineLabel, testDb, testDbContext, type TestDbHandle } from '../../../../tools/test/test-db.js';
import { createApp, type AppState } from '../../src/app.js';
import { createJobRuntime, type JobRuntime } from '../../src/jobs/runtime.js';
import { createAppOps } from '../../src/services.js';
import { createAgent, type AgentReply } from '../agent.js';
import { recordingLogger, sampleConfig } from '../support.js';
import { seedStaff, sessionCookieFor, sessionCsrfFor, type SeedRole } from '../support-auth.js';

// The jobs and schedules API of Task 17 (spec §10.1, §10.4, §10.5, §13.5 "Tugas"; decision C34, M33; route catalog
// `jobs.*`, `schedules.*`) on the engine picked by ALTIS_TEST_DB: the list pages and filters; a job is visible to its
// creator, to `system.jobs.read`, and for an interactive job to a holder of its handler's permission (whom drive
// accepts, C26/E22b), 404 to anyone else; its payload only to a holder of the handler's permission;
// retry and cancel need `system.jobs.manage` and the handler's permission; drive needs the creator or the handler's
// permission and an interactive job, and runs one slice in external mode; the schedules list, and their update with the
// schedule's own permission, `expr` only where it is editable, and `next_run_at` recomputed when the expression changes
// or a schedule is switched back on.

const ctx = testDbContext();
let h: TestDbHandle;

/** In the past: an audit entry may not be dated ahead of the real clock. 16:00:05 WIB, 20 October 2026. */
const NOW = Date.UTC(2026, 9, 20, 9, 0, 5);
const DAY = 86_400_000;
const CONFIG = sampleConfig();
/** baseUrl is https: the cookies carry the `__Host-` prefix. */
const SID = '__Host-altis_sid';
const JOBS = '/api/v1/jobs';
const SCHEDULE_PATH = '/api/v1/schedules';
/** `library.timezone` by default. */
const TZ = 'Asia/Jakarta';

type Payload = { k: number };
const payload = z.strictObject({ k: z.number().int().min(0).max(100) });

/** An interactive job of `system.jobs.manage` that may be retried through the API: one slice moves `k` on. */
const apiJob: JobHandler<Payload> = {
  type: 'test.api',
  permission: 'system.jobs.manage',
  retryable: 'api',
  interactive: true,
  payload,
  async run(_c, p) {
    return { continueWith: { k: p.k + 1 }, progress: 50, message: 'separuh' };
  },
};
/** Only the code that started it may run it again. */
const originJob: JobHandler<Payload> = { ...apiJob, type: 'test.origin', retryable: 'origin-only' };
/** A job of another permission (a backup's). */
const backupJob: JobHandler<Payload> = { ...apiJob, type: 'test.backupish', permission: 'system.backup.create' };
/** Of the same permission, not interactive: its holder may not drive it, so may not read it either. */
const backupBackgroundJob: JobHandler<Payload> = { ...backupJob, type: 'test.backupish_background', interactive: false };
/** Not interactive: drive refuses it. */
const backgroundJob: JobHandler<Payload> = { ...apiJob, type: 'test.background', interactive: false };

/** A browser signed in as one staff user. */
interface Client {
  userId: string;
  get(path: string): Promise<AgentReply>;
  post(path: string): Promise<AgentReply>;
  patch(path: string, body: unknown): Promise<AgentReply>;
}

const code = (res: AgentReply): string | undefined => (res.json as { code?: string } | undefined)?.code;
const reason = (res: AgentReply): string | undefined => (res.json as { reason?: string } | undefined)?.reason;
const errors = (res: AgentReply): unknown => (res.json as { errors?: unknown } | undefined)?.errors;
const view = (res: AgentReply): JobView => res.json as JobView;

describe.skipIf(!ctx.available)(`jobs and schedules API [${engineLabel()}]`, () => {
  let dataDir: string;
  let state: AppState;
  let ops: OpsMachine;
  let runtime: JobRuntime;
  let app: ReturnType<typeof createApp>;
  /** `system.jobs.read` and `system.jobs.manage`. */
  let manager: Client;
  /** `system.jobs.read` only. */
  let reader: Client;
  /** Every permission. */
  let superAdmin: Client;
  /** No job permission: the creator of their own jobs. */
  let staffA: Client;
  /** No job permission either. */
  let staffB: Client;

  async function signedIn(username: string, roles: SeedRole[]): Promise<Client> {
    const user = await seedStaff(h, { username, now: NOW, roles });
    const token = await sessionCookieFor(h, user.id, { now: NOW });
    const agent = createAgent(app);
    agent.setCookie(SID, token);
    const csrf = { 'x-csrf-token': sessionCsrfFor(CONFIG, token) };
    return {
      userId: user.id,
      get: (p) => agent.get(p),
      post: (p) => agent.post(p, undefined, csrf),
      patch: (p, body) => agent.patch(p, body, csrf),
    };
  }

  /** A job row as the queue would have it (`run_at` in the past); its id. */
  async function insertJob(o: {
    type: string;
    status?: 'queued' | 'running' | 'succeeded' | 'dead' | 'cancelled';
    createdBy?: string | null;
    k?: number;
    pointOfNoReturn?: boolean;
    id?: string;
  }): Promise<string> {
    const id = o.id ?? newId();
    const status = o.status ?? 'queued';
    const terminal = status === 'succeeded' || status === 'dead' || status === 'cancelled';
    await h.db
      .insertInto('jobs')
      .values({
        id,
        type: o.type,
        payload: JSON.stringify({ k: o.k ?? 1 }),
        status,
        run_at: NOW - 60_000,
        attempts: status === 'dead' ? 5 : 0,
        max_attempts: 5,
        lock_token: status === 'running' ? 'token-running' : null,
        locked_by: status === 'running' ? 'test:worker' : null,
        locked_until: status === 'running' ? NOW + 50_000 : null,
        last_error: status === 'dead' ? 'INTERNAL' : null,
        created_by: o.createdBy ?? null,
        created_at: NOW - 60_000,
        updated_at: NOW - 60_000,
        finished_at: terminal ? NOW - 30_000 : null,
        point_of_no_return: o.pointOfNoReturn === true ? 1 : 0,
      })
      .execute();
    return id;
  }

  const jobRow = (id: string) => h.db.selectFrom('jobs').selectAll().where('id', '=', id).executeTakeFirstOrThrow();
  /** The audit head when the current test began: auditRows sees only what the test appended. */
  let auditFrom = 0;
  const lastSeq = async (): Promise<number> =>
    Number((await h.db.selectFrom('audit_head').select('last_seq').where('id', '=', 1).executeTakeFirstOrThrow()).last_seq);
  const auditRows = (action: string) =>
    h.db
      .selectFrom('audit_log')
      .select(['action', 'entity', 'entity_id', 'actor_id', 'meta'])
      .where('action', '=', action)
      .where('seq', '>', auditFrom)
      .orderBy('seq')
      .execute();

  beforeAll(async () => {
    h = await testDb();
    dataDir = await fsp.realpath(await fsp.mkdtemp(path.join(os.tmpdir(), 'altis-jobs-api-')));
    await runMigrations(h, { appVersion: '0.1.0', dataDir, migrations: PHASE1_MIGRATIONS });
    const log = recordingLogger();
    state = { phase: 'ready', db: h, config: CONFIG };
    ops = createAppOps(state, { dataDir, version: '0.1.0', log, clock: () => NOW });
    // External mode (passenger), so drive runs its slice here; piggyback never runs (a worker run is always fresh).
    runtime = createJobRuntime({
      state,
      runtime: 'passenger',
      env: {},
      dataDir,
      log,
      clock: () => NOW,
      ops,
      handlers: [apiJob, originJob, backupJob, backgroundJob, backupBackgroundJob],
      requestRestart: async () => {},
      installId: CONFIG.install.id,
      appVersion: '0.1.0',
      settings: { get: async <T>(_db: unknown, key: string) => (key === 'system.run.worker' ? NOW : null) as T, invalidate() {} },
    });
    state.jobs = runtime;
    app = createApp({ state, version: '0.1.0', buildId: 'b', log, clock: () => NOW, dataDir });
    manager = await signedIn('pengelola_tugas', [{ permissions: ['system.jobs.read', 'system.jobs.manage'] }]);
    reader = await signedIn('pembaca_tugas', [{ permissions: ['system.jobs.read'] }]);
    superAdmin = await signedIn('adm_super', [{ key: 'super_admin' }]);
    staffA = await signedIn('staf_a', [{ permissions: ['system.users.read'] }]);
    staffB = await signedIn('staf_b', []);
  });

  afterAll(async () => {
    await runtime?.stop();
    await ops?.close();
    await h?.close();
    if (dataDir !== undefined) await fsp.rm(dataDir, { recursive: true, force: true });
  });

  beforeEach(async () => {
    await h.db.deleteFrom('jobs').execute();
    await h.db.deleteFrom('schedules').execute();
    await h.db.deleteFrom('events').execute();
    auditFrom = await lastSeq();
  });

  describe('GET jobs', () => {
    it('pages newest first with nextBefore, and filters by status and type', async () => {
      const ids = [newId(), newId(), newId(), newId(), newId()].sort();
      await insertJob({ id: ids[0], type: 'test.api', status: 'dead' });
      await insertJob({ id: ids[1], type: 'test.origin', status: 'queued' });
      await insertJob({ id: ids[2], type: 'test.api', status: 'succeeded' });
      await insertJob({ id: ids[3], type: 'test.origin', status: 'dead' });
      await insertJob({ id: ids[4], type: 'test.api', status: 'queued' });
      const newest = [...ids].reverse();

      const first = await manager.get(`${JOBS}?limit=2`);
      expect(first.status, first.text).toBe(200);
      expect(first.headers.get('cache-control')).toBe('no-store');
      const page1 = first.json as JobListResponse;
      expect(page1.items.map((j) => j.id)).toEqual(newest.slice(0, 2));
      expect(page1.nextBefore).toBe(newest[1]);
      const page2 = (await manager.get(`${JOBS}?limit=2&before=${page1.nextBefore}`)).json as JobListResponse;
      expect(page2.items.map((j) => j.id)).toEqual(newest.slice(2, 4));
      const page3 = (await manager.get(`${JOBS}?limit=2&before=${page2.nextBefore}`)).json as JobListResponse;
      expect(page3.items.map((j) => j.id)).toEqual(newest.slice(4));
      expect(page3.nextBefore).toBeNull();

      const all = (await manager.get(JOBS)).json as JobListResponse;
      expect(all.items).toHaveLength(5);
      expect(all.nextBefore).toBeNull();
      const dead = (await manager.get(`${JOBS}?status=dead`)).json as JobListResponse;
      expect(dead.items.map((j) => j.id)).toEqual([ids[3], ids[0]]);
      const origin = (await manager.get(`${JOBS}?type=test.origin`)).json as JobListResponse;
      expect(origin.items.map((j) => j.id)).toEqual([ids[3], ids[1]]);
      const both = (await manager.get(`${JOBS}?status=dead&type=test.api`)).json as JobListResponse;
      expect(both.items.map((j) => j.id)).toEqual([ids[0]]);
    });

    it('shows each job as a JobView', async () => {
      const id = await insertJob({ type: 'test.origin', status: 'dead', createdBy: staffA.userId, k: 7 });
      const item = ((await manager.get(JOBS)).json as JobListResponse).items[0];
      expect(item).toEqual({
        id,
        type: 'test.origin',
        status: 'dead',
        progress: 0,
        progressMessage: null,
        attempts: 5,
        maxAttempts: 5,
        lastError: 'INTERNAL',
        runAt: NOW - 60_000,
        createdAt: NOW - 60_000,
        updatedAt: NOW - 60_000,
        finishedAt: NOW - 30_000,
        createdBy: staffA.userId,
        payload: { k: 7 },
        retryable: 'origin-only',
        cancellable: false,
        interactive: true,
      } satisfies JobView);
    });

    it("says whether drive may advance a job: its handler's `interactive`, false for a type without a handler", async () => {
      const driveable = await insertJob({ type: 'test.api' });
      const background = await insertJob({ type: 'test.background' });
      const unknown = await insertJob({ type: 'test.gone' });
      const items = ((await manager.get(JOBS)).json as JobListResponse).items;
      const flag = (id: string) => items.find((j) => j.id === id)?.interactive;
      expect([flag(driveable), flag(background), flag(unknown)]).toEqual([true, false, false]);
      // The same on a job's own page (its creator, or a reader without the handler's permission).
      expect(view(await reader.get(`${JOBS}/${driveable}`)).interactive).toBe(true);
      expect(view(await reader.get(`${JOBS}/${background}`)).interactive).toBe(false);
    });

    it('refuses a malformed status, type or limit (422), and a caller without system.jobs.read (403)', async () => {
      for (const q of ['status=lost', 'type=Bad-Type', 'limit=101', 'limit=0', 'before=x', 'extra=1']) {
        const res = await manager.get(`${JOBS}?${q}`);
        expect(res.status, q).toBe(422);
        expect(code(res), q).toBe('VALIDATION_FAILED');
      }
      const res = await staffA.get(JOBS);
      expect(res.status).toBe(403);
      expect(code(res)).toBe('AUTHZ_DENIED');
    });
  });

  describe('GET jobs/:id', () => {
    it("a job created by staff A is visible to A without system.jobs.read, and 404 to staff B", async () => {
      const id = await insertJob({ type: 'test.api', createdBy: staffA.userId });
      const own = await staffA.get(`${JOBS}/${id}`);
      expect(own.status, own.text).toBe(200);
      expect(own.headers.get('cache-control')).toBe('no-store');
      expect(view(own).id).toBe(id);
      expect(view(own).createdBy).toBe(staffA.userId);
      const stranger = await staffB.get(`${JOBS}/${id}`);
      expect(stranger.status).toBe(404);
      expect(code(stranger)).toBe('NOT_FOUND');
      // The same answer as for an id that does not exist (no existence leak).
      const missing = await staffB.get(`${JOBS}/${newId()}`);
      expect([missing.status, code(missing)]).toEqual([404, 'NOT_FOUND']);
      // A holder of system.jobs.read sees it.
      expect((await reader.get(`${JOBS}/${id}`)).status).toBe(200);
    });

    it('shows the payload only to a holder of the handler permission', async () => {
      const own = await insertJob({ type: 'test.api', createdBy: staffA.userId, k: 3 });
      expect(view(await staffA.get(`${JOBS}/${own}`))).not.toHaveProperty('payload');
      expect(view(await reader.get(`${JOBS}/${own}`))).not.toHaveProperty('payload');
      expect(view(await manager.get(`${JOBS}/${own}`)).payload).toEqual({ k: 3 });
      const backup = await insertJob({ type: 'test.backupish', k: 4 });
      expect(view(await manager.get(`${JOBS}/${backup}`))).not.toHaveProperty('payload');
      expect(view(await superAdmin.get(`${JOBS}/${backup}`)).payload).toEqual({ k: 4 });
      const listed = ((await manager.get(JOBS)).json as JobListResponse).items;
      expect(listed.find((j) => j.id === backup)).not.toHaveProperty('payload');
      expect(listed.find((j) => j.id === own)?.payload).toEqual({ k: 3 });
    });

    // C26/E22b: a page drives an interactive job the system queued (Diagnostik, the rebuild after a restore) for a
    // holder of its handler's permission, whom drive accepts; the page must read the job first to follow it.
    it("answers a holder of an interactive job's handler permission, whom drive accepts, without system.jobs.read", async () => {
      const backuper = await signedIn('pencadang_tugas', [{ permissions: ['system.backup.create'] }]);
      // Queued by the system (no creator), as the boot queues a rebuild.
      const queued = await insertJob({ type: 'test.backupish', createdBy: null, k: 4 });
      const res = await backuper.get(`${JOBS}/${queued}`);
      expect(res.status, res.text).toBe(200);
      expect(res.headers.get('cache-control')).toBe('no-store');
      expect(view(res)).toMatchObject({ id: queued, createdBy: null, interactive: true, payload: { k: 4 } });
      // The same caller drives it, as the drive route always allowed.
      const driven = await backuper.post(`${JOBS}/${queued}/drive`);
      expect(driven.status, driven.text).toBe(200);
      expect(view(driven).payload).toEqual({ k: 5 });

      // Nothing more is shown than drive would act on: a job of another handler permission, and a job of this
      // permission that is not interactive, stay 404 (as for an id that does not exist).
      const other = await insertJob({ type: 'test.api', createdBy: staffA.userId });
      const background = await insertJob({ type: 'test.backupish_background' });
      for (const id of [other, background, newId()]) {
        const refused = await backuper.get(`${JOBS}/${id}`);
        expect([refused.status, code(refused)], id).toEqual([404, 'NOT_FOUND']);
      }
      // A caller without any of it still gets 404.
      expect((await staffB.get(`${JOBS}/${queued}`)).status).toBe(404);
    });
  });

  describe('POST jobs/:id/retry', () => {
    it('re-queues a dead api job, with one jobs.retry row', async () => {
      const id = await insertJob({ type: 'test.api', status: 'dead' });
      const res = await manager.post(`${JOBS}/${id}/retry`);
      expect(res.status, res.text).toBe(200);
      expect(view(res)).toMatchObject({ id, status: 'queued', attempts: 0, lastError: null, finishedAt: null, runAt: NOW });
      const row = await jobRow(id);
      expect([row.status, Number(row.attempts), Number(row.run_at)]).toEqual(['queued', 0, NOW]);
      const rows = await auditRows('jobs.retry');
      expect(rows).toHaveLength(1);
      expect(rows[0]).toMatchObject({ entity: 'jobs', entity_id: id, actor_id: manager.userId });
    });

    it('refuses an origin-only job (409 JOB_NOT_RETRYABLE origin_only), a queued one (state), and a missing one (404)', async () => {
      const origin = await insertJob({ type: 'test.origin', status: 'dead' });
      const res = await manager.post(`${JOBS}/${origin}/retry`);
      expect([res.status, code(res), reason(res)]).toEqual([409, 'JOB_NOT_RETRYABLE', 'origin_only']);
      const queued = await insertJob({ type: 'test.api' });
      const again = await manager.post(`${JOBS}/${queued}/retry`);
      expect([again.status, code(again), reason(again)]).toEqual([409, 'JOB_NOT_RETRYABLE', 'state']);
      const missing = await manager.post(`${JOBS}/${newId()}/retry`);
      expect([missing.status, code(missing)]).toEqual([404, 'NOT_FOUND']);
      expect(await auditRows('jobs.retry')).toHaveLength(0);
    });

    it('needs the handler permission besides system.jobs.manage (403 AUTHZ_DENIED)', async () => {
      const id = await insertJob({ type: 'test.backupish', status: 'dead' });
      const res = await manager.post(`${JOBS}/${id}/retry`);
      expect([res.status, code(res)]).toEqual([403, 'AUTHZ_DENIED']);
      expect((await jobRow(id)).status).toBe('dead');
      const ok = await superAdmin.post(`${JOBS}/${id}/retry`);
      expect(ok.status, ok.text).toBe(200);
      // Without system.jobs.manage the gate refuses first.
      const reading = await reader.post(`${JOBS}/${id}/retry`);
      expect([reading.status, code(reading)]).toEqual([403, 'AUTHZ_DENIED']);
    });
  });

  describe('POST jobs/:id/cancel', () => {
    it('cancels a queued job, with one jobs.cancel row', async () => {
      const id = await insertJob({ type: 'test.api' });
      const res = await manager.post(`${JOBS}/${id}/cancel`);
      expect(res.status, res.text).toBe(200);
      expect(view(res)).toMatchObject({ id, status: 'cancelled', cancellable: false, finishedAt: NOW });
      expect((await jobRow(id)).status).toBe('cancelled');
      const rows = await auditRows('jobs.cancel');
      expect(rows).toHaveLength(1);
      expect(rows[0]).toMatchObject({ entity: 'jobs', entity_id: id, actor_id: manager.userId });
    });

    it('asks a running job to stop: it stays running, no longer cancellable', async () => {
      const id = await insertJob({ type: 'test.api', status: 'running' });
      const before = await manager.get(`${JOBS}/${id}`);
      expect(view(before).cancellable).toBe(true);
      const res = await manager.post(`${JOBS}/${id}/cancel`);
      expect(res.status, res.text).toBe(200);
      expect(view(res)).toMatchObject({ status: 'running', cancellable: false });
      expect(Number((await jobRow(id)).cancel_requested)).toBe(1);
    });

    it('refuses a job past its point of no return, or ended (409 JOB_NOT_CANCELLABLE)', async () => {
      const pinned = await insertJob({ type: 'test.api', status: 'running', pointOfNoReturn: true });
      const res = await manager.post(`${JOBS}/${pinned}/cancel`);
      expect([res.status, code(res)]).toEqual([409, 'JOB_NOT_CANCELLABLE']);
      const ended = await insertJob({ type: 'test.api', status: 'succeeded' });
      const late = await manager.post(`${JOBS}/${ended}/cancel`);
      expect([late.status, code(late)]).toEqual([409, 'JOB_NOT_CANCELLABLE']);
      expect(await auditRows('jobs.cancel')).toHaveLength(0);
    });

    it('needs the handler permission besides system.jobs.manage (403 AUTHZ_DENIED)', async () => {
      const id = await insertJob({ type: 'test.backupish' });
      const res = await manager.post(`${JOBS}/${id}/cancel`);
      expect([res.status, code(res)]).toEqual([403, 'AUTHZ_DENIED']);
      expect((await jobRow(id)).status).toBe('queued');
    });
  });

  describe("a refusal by the job handler's permission", () => {
    it('writes authz.denied as step 9 does (§7.8), once a minute per user, for retry and for cancel', async () => {
      const dead = await insertJob({ type: 'test.backupish', status: 'dead' });
      const queued = await insertJob({ type: 'test.backupish' });
      const retrier = await signedIn('pengulang_tugas', [{ permissions: ['system.jobs.read', 'system.jobs.manage'] }]);
      const canceller = await signedIn('pembatal_tugas', [{ permissions: ['system.jobs.read', 'system.jobs.manage'] }]);
      for (let i = 0; i < 2; i += 1) {
        const retried = await retrier.post(`${JOBS}/${dead}/retry`);
        expect([retried.status, code(retried)]).toEqual([403, 'AUTHZ_DENIED']);
        const cancelled = await canceller.post(`${JOBS}/${queued}/cancel`);
        expect([cancelled.status, code(cancelled)]).toEqual([403, 'AUTHZ_DENIED']);
      }
      const rows = await auditRows('authz.denied');
      expect(rows.map((r) => [r.actor_id, JSON.parse(r.meta)])).toEqual([
        [retrier.userId, { route: 'jobs.retry', permission: 'system.backup.create' }],
        [canceller.userId, { route: 'jobs.cancel', permission: 'system.backup.create' }],
      ]);
      expect([(await jobRow(dead)).status, (await jobRow(queued)).status]).toEqual(['dead', 'queued']);
      expect([...(await auditRows('jobs.retry')), ...(await auditRows('jobs.cancel'))]).toEqual([]);
    });

    it('writes none for a job of a type without a handler, nor for a missing job', async () => {
      const gone = await insertJob({ type: 'test.gone' });
      const someone = await signedIn('pengelola_lain', [{ permissions: ['system.jobs.read', 'system.jobs.manage'] }]);
      expect((await someone.post(`${JOBS}/${newId()}/retry`)).status).toBe(404);
      expect((await someone.post(`${JOBS}/${gone}/cancel`)).status).toBe(200);
      expect(await auditRows('authz.denied')).toEqual([]);
    });
  });

  describe('POST jobs/:id/drive', () => {
    it('is 404 to a stranger, and runs one slice for the creator, answering a JobView', async () => {
      const id = await insertJob({ type: 'test.api', createdBy: staffA.userId, k: 1 });
      const stranger = await staffB.post(`${JOBS}/${id}/drive`);
      expect([stranger.status, code(stranger)]).toEqual([404, 'NOT_FOUND']);
      expect((await jobRow(id)).payload).toBe(JSON.stringify({ k: 1 }));

      const res = await staffA.post(`${JOBS}/${id}/drive`);
      expect(res.status, res.text).toBe(200);
      expect(res.headers.get('cache-control')).toBe('no-store');
      expect(view(res)).toMatchObject({ id, status: 'queued', progress: 50, progressMessage: 'separuh', createdBy: staffA.userId });
      expect(view(res)).not.toHaveProperty('payload');
      // The slice ran: its checkpoint is the job's payload now.
      expect(JSON.parse((await jobRow(id)).payload)).toEqual({ k: 2 });
    });

    it('lets a holder of the handler permission drive a job of another user', async () => {
      const id = await insertJob({ type: 'test.api', createdBy: staffA.userId, k: 5 });
      const res = await manager.post(`${JOBS}/${id}/drive`);
      expect(res.status, res.text).toBe(200);
      expect(view(res).payload).toEqual({ k: 6 });
    });

    it('refuses a job that is not interactive (409 JOB_NOT_INTERACTIVE), after the visibility check', async () => {
      const id = await insertJob({ type: 'test.background', createdBy: staffA.userId });
      const res = await staffA.post(`${JOBS}/${id}/drive`);
      expect([res.status, code(res)]).toEqual([409, 'JOB_NOT_INTERACTIVE']);
      const stranger = await staffB.post(`${JOBS}/${id}/drive`);
      expect([stranger.status, code(stranger)]).toEqual([404, 'NOT_FOUND']);
      expect((await jobRow(id)).payload).toBe(JSON.stringify({ k: 1 }));
    });
  });

  describe('schedules', () => {
    const seed = (now = NOW) => withTx(h, (trx) => seedSchedules(trx, now, TZ, SCHEDULES));
    const scheduleRow = (name: string) => h.db.selectFrom('schedules').selectAll().where('name', '=', name).executeTakeFirstOrThrow();

    it('GET schedules lists the SCHEDULES rows, in their order', async () => {
      await seed();
      const res = await reader.get(SCHEDULE_PATH);
      expect(res.status, res.text).toBe(200);
      expect(res.headers.get('cache-control')).toBe('no-store');
      const items = (res.json as ScheduleListResponse).items;
      expect(items.map((s) => s.name)).toEqual(SCHEDULES.map((d) => d.name));
      const daily = items.find((s) => s.name === 'backup.daily');
      expect(daily).toEqual({
        name: 'backup.daily',
        expr: '0 1 * * *',
        enabled: true,
        nextRunAt: nextRun(parseCronExpr('0 1 * * *'), NOW, TZ),
        lastRunAt: null,
        jobType: 'backup.schedule',
        exprEditable: true,
        permission: 'system.backup.create',
      } satisfies ScheduleView);
      expect(items.find((s) => s.name === 'retention.events')).toMatchObject({ exprEditable: false, permission: 'system.jobs.manage' });
      expect((await staffA.get(SCHEDULE_PATH)).status).toBe(403);
    });

    it('PATCH schedules/retention.events {enabled: false} → disabled, one schedules.update row', async () => {
      await seed();
      const res = await manager.patch(`${SCHEDULE_PATH}/retention.events`, { enabled: false });
      expect(res.status, res.text).toBe(200);
      expect(res.json as ScheduleView).toMatchObject({ name: 'retention.events', enabled: false });
      expect(Number((await scheduleRow('retention.events')).enabled)).toBe(0);
      const rows = await auditRows('schedules.update');
      expect(rows).toHaveLength(1);
      expect(rows[0]).toMatchObject({ entity: 'schedules', entity_id: 'retention.events', actor_id: manager.userId });
      expect(JSON.parse(rows[0]!.meta)).toEqual({ name: 'retention.events', enabled: false });
    });

    it('switching a schedule back on recomputes next_run_at from now (no catch-up run, no false clock anomaly)', async () => {
      await seed();
      await h.db.updateTable('schedules').set({ enabled: 0, next_run_at: NOW - 3 * DAY }).where('name', '=', 'retention.jobs').execute();
      const res = await manager.patch(`${SCHEDULE_PATH}/retention.jobs`, { enabled: true });
      expect(res.status, res.text).toBe(200);
      const next = nextRun(parseCronExpr('29 3 * * *'), NOW, TZ);
      expect(res.json as ScheduleView).toMatchObject({ enabled: true, nextRunAt: next });
      expect(Number((await scheduleRow('retention.jobs')).next_run_at)).toBe(next);
      // Switching an enabled schedule on again leaves its next run alone (a due run stays due).
      await h.db.updateTable('schedules').set({ next_run_at: NOW - 1000 }).where('name', '=', 'retention.jobs').execute();
      const again = await manager.patch(`${SCHEDULE_PATH}/retention.jobs`, { enabled: true });
      expect((again.json as ScheduleView).nextRunAt).toBe(NOW - 1000);
    });

    it("PATCH schedules/retention.events {expr: '0 2 * * *'} → 422 not_editable", async () => {
      await seed();
      const res = await manager.patch(`${SCHEDULE_PATH}/retention.events`, { expr: '0 2 * * *' });
      expect([res.status, code(res)]).toEqual([422, 'VALIDATION_FAILED']);
      expect(errors(res)).toEqual([{ path: 'expr', code: 'not_editable' }]);
      expect((await scheduleRow('retention.events')).expr).toBe('17 * * * *');
      expect(await auditRows('schedules.update')).toHaveLength(0);
    });

    it("PATCH schedules/backup.daily {expr: '0 2 * * *'} → nextRunAt at the next 02:00 library time", async () => {
      await seed();
      const res = await superAdmin.patch(`${SCHEDULE_PATH}/backup.daily`, { expr: '0 2 * * *' });
      expect(res.status, res.text).toBe(200);
      // 02:00 WIB on 21 October 2026 = 19:00 UTC on the 20th.
      const at = Date.UTC(2026, 9, 20, 19, 0);
      expect(res.json as ScheduleView).toMatchObject({ name: 'backup.daily', expr: '0 2 * * *', nextRunAt: at });
      const row = await scheduleRow('backup.daily');
      expect([row.expr, Number(row.next_run_at)]).toEqual(['0 2 * * *', at]);
      const rows = await auditRows('schedules.update');
      expect(rows).toHaveLength(1);
      expect(JSON.parse(rows[0]!.meta)).toEqual({ name: 'backup.daily', expr: '0 2 * * *' });
    });

    it('refuses an invalid expression (422, path expr)', async () => {
      await seed();
      for (const expr of ['61 * * * *', '* * * *', '0 0 31 2 *', 'jam dua']) {
        const res = await superAdmin.patch(`${SCHEDULE_PATH}/backup.daily`, { expr });
        expect([res.status, code(res)], expr).toEqual([422, 'VALIDATION_FAILED']);
        expect(errors(res), expr).toEqual([{ path: 'expr', code: 'invalid_format' }]);
      }
      const tooLong = await superAdmin.patch(`${SCHEDULE_PATH}/backup.daily`, { expr: `0 1 * * *${' '.repeat(190)}` });
      expect(tooLong.status).toBe(422);
      expect((await scheduleRow('backup.daily')).expr).toBe('0 1 * * *');
    });

    it("a refusal by the schedule's permission writes authz.denied as step 9 does (§7.8), once a minute per user", async () => {
      await seed();
      const jobsOnly = await signedIn('pengelola_jadwal', [{ permissions: ['system.jobs.read', 'system.jobs.manage'] }]);
      for (let i = 0; i < 2; i += 1) {
        const res = await jobsOnly.patch(`${SCHEDULE_PATH}/backup.daily`, { enabled: false });
        expect([res.status, code(res)]).toEqual([403, 'AUTHZ_DENIED']);
      }
      const rows = await auditRows('authz.denied');
      expect(rows.map((r) => [r.actor_id, JSON.parse(r.meta)])).toEqual([
        [jobsOnly.userId, { route: 'schedules.update', permission: 'system.backup.create' }],
      ]);
      expect(await auditRows('schedules.update')).toHaveLength(0);
    });

    it("needs the schedule's own permission (403 AUTHZ_DENIED), and an unknown schedule is 404", async () => {
      await seed();
      const res = await manager.patch(`${SCHEDULE_PATH}/backup.daily`, { enabled: false });
      expect([res.status, code(res)]).toEqual([403, 'AUTHZ_DENIED']);
      expect(Number((await scheduleRow('backup.daily')).enabled)).toBe(1);
      const unknown = await manager.patch(`${SCHEDULE_PATH}/tidak.ada`, { enabled: false });
      expect([unknown.status, code(unknown)]).toEqual([404, 'NOT_FOUND']);
      const strict = await manager.patch(`${SCHEDULE_PATH}/retention.events`, { enabled: false, name: 'x' });
      expect(strict.status).toBe(422);
    });
  });
});
