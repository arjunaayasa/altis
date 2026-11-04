import { randomBytes } from 'node:crypto';
import fsp from 'node:fs/promises';
import os from 'node:os';
import path from 'node:path';
import { PHASE1_MIGRATIONS, claimLock, releaseLock, runMigrations, withTx } from '@altis/db';
import { z } from 'zod';
import { afterAll, afterEach, beforeAll, beforeEach, describe, expect, it, vi } from 'vitest';
import { engineLabel, testDb, testDbContext, type TestDbHandle } from '../../../../tools/test/test-db.js';
import type { KeyringEntry } from '../../src/crypto/secret-box.js';
import { claimById, claimNext } from '../../src/jobs/claim.js';
import { enqueue } from '../../src/jobs/enqueue.js';
import { createJobRegistry } from '../../src/jobs/registry.js';
import { runSlice } from '../../src/jobs/slice.js';
import { HEAVY_LOCK, JOB_LEASE_MS, type ClaimedJob, type EnqueueInput, type JobContext, type JobHandler } from '../../src/jobs/types.js';
import { runJobChildren } from '../fixtures/job-children.js';

// The claim protocol (spec §10.1, decision C4, S27): new claims (a), reclaims of expired leases after their backoff
// (b) with a compare-and-set on attempts, the dead path (c), the maintenance exemption, the heavy lock, and the
// clock-anomaly clause. On every engine (A5); the race runs in child processes, one connection each.
//
// claimLock reads Date.now(), so the clock is faked (M47) and every `now` below is Date.now().

const ctx = testDbContext();
const T = 1_767_225_600_000;
const keyring: KeyringEntry[] = [{ kid: 'k1', key: randomBytes(32).toString('base64url'), active: true }];
const silent = { info() {}, warn() {}, error() {} };

const empty = z.strictObject({});
const light: JobHandler<Record<string, never>> = {
  type: 'test.light',
  permission: 'system.jobs.manage',
  retryable: 'api',
  payload: empty,
  run: () => Promise.resolve({ done: true }),
};
const other: JobHandler<Record<string, never>> = { ...light, type: 'test.other' };
let heavyRun: (c: JobContext) => Promise<void> = () => Promise.resolve();
const heavy: JobHandler<Record<string, never>> = {
  type: 'test.heavy',
  permission: 'system.jobs.manage',
  retryable: 'api',
  cpuHeavy: true,
  payload: empty,
  async run(c) {
    await heavyRun(c);
    return { done: true };
  },
};
const long: JobHandler<Record<string, never>> = { ...heavy, type: 'test.long', cpuHeavy: false, longRunning: true };
const reg = createJobRegistry([light, other, heavy, long]);

describe.skipIf(!ctx.available)(`claimNext / claimById (spec §10.1, C4, S27) [${engineLabel()}]`, () => {
  let h: TestDbHandle;
  let dataDir: string;

  beforeAll(async () => {
    h = await testDb();
    dataDir = await fsp.mkdtemp(path.join(os.tmpdir(), 'altis-core-jobs-claim-'));
    await runMigrations(h, { appVersion: '0.1.0', dataDir, migrations: PHASE1_MIGRATIONS });
  });

  afterAll(async () => {
    await h?.close();
    if (dataDir !== undefined) await fsp.rm(dataDir, { recursive: true, force: true });
  });

  beforeEach(async () => {
    vi.useFakeTimers({ toFake: ['Date'] });
    vi.setSystemTime(T);
    for (const table of ['jobs', 'locks', 'notifications', 'events'] as const) await h.db.deleteFrom(table).execute();
    heavyRun = () => Promise.resolve();
  });

  afterEach(() => {
    vi.useRealTimers();
  });

  const put = (input: EnqueueInput) => withTx(h, (trx) => enqueue(trx, reg, input, { now: Date.now(), keyring }));
  const row = (id: string) => h.db.selectFrom('jobs').selectAll().where('id', '=', id).executeTakeFirstOrThrow();
  const heavyLock = () => h.db.selectFrom('locks').select(['owner', 'until']).where('name', '=', HEAVY_LOCK).executeTakeFirst();
  const at = (ms: number) => vi.setSystemTime(ms);
  const slice = (job: ClaimedJob) =>
    runSlice(h, reg, job, { mode: 'worker', budgetMs: 20_000, keyring, log: silent, clock: () => Date.now(), env: {} });

  it('a new job → running, lease now + 50 000, the claim token and worker; ClaimedJob carries the row', async () => {
    const { id } = await put({ type: 'test.light', payload: {}, uniqueKey: 'u1' });
    at(T + 1000);
    const job = await claimNext(h, reg, { worker: 'host:1', now: T + 1000 });
    expect(job).toMatchObject({
      id,
      type: 'test.light',
      payload: {},
      attempts: 0,
      maxAttempts: 5,
      createdBy: null,
      heavy: false,
      pointOfNoReturn: false,
      cancelRequested: false,
      updatedAt: T,
    });
    expect(job!.token).toMatch(/^[A-Za-z0-9_-]{43}$/);
    expect(await row(id)).toMatchObject({
      status: 'running',
      lock_token: job!.token,
      locked_by: 'host:1',
      locked_until: T + 1000 + JOB_LEASE_MS,
      attempts: 0,
      unique_key: 'u1',
    });
    // Nothing else is due.
    expect(await claimNext(h, reg, { worker: 'host:1', now: T + 1000 })).toBeNull();
  });

  it('a job not yet due is not claimed; due jobs go oldest run_at first', async () => {
    const late = await put({ type: 'test.light', payload: {}, runAt: T + 5000 });
    const early = await put({ type: 'test.light', payload: {}, runAt: T + 1000 });
    expect(await claimNext(h, reg, { worker: 'w', now: T + 999 })).toBeNull();
    expect((await claimNext(h, reg, { worker: 'w', now: T + 6000 }))?.id).toBe(early.id);
    expect((await claimNext(h, reg, { worker: 'w', now: T + 6000 }))?.id).toBe(late.id);
  });

  it('two processes racing for one job → exactly one claim', async () => {
    const { id } = await put({ type: 'test.light', payload: {} });
    // The children read the real clock, well after T.
    const options = ['w1', 'w2'].map((worker) => ({ config: h.config, dataDir: h.dataDir, action: 'claim', worker }));
    const runs = await runJobChildren<{ claimed: string | null }>(options);
    expect(runs.map((r) => r.code)).toEqual([0, 0]);
    expect(runs.map((r) => r.report?.claimed).sort()).toEqual([id, null].sort());
    expect((await row(id)).status).toBe('running');
  });

  it('reclaim: expired at t with attempts 0 → not at t + 9 999, at t + 10 001 with attempts 1 and a new token', async () => {
    const { id } = await put({ type: 'test.light', payload: {} });
    const first = await claimNext(h, reg, { worker: 'w1', now: T });
    const t = T + JOB_LEASE_MS;
    at(t + 9_999);
    expect(await claimNext(h, reg, { worker: 'w2', now: t + 9_999 })).toBeNull();
    expect((await row(id)).lock_token).toBe(first!.token);
    at(t + 10_001);
    const second = await claimNext(h, reg, { worker: 'w2', now: t + 10_001 });
    expect(second).toMatchObject({ id, attempts: 1 });
    expect(second!.token).not.toBe(first!.token);
    expect(await row(id)).toMatchObject({
      status: 'running',
      attempts: 1,
      lock_token: second!.token,
      locked_by: 'w2',
      locked_until: t + 10_001 + JOB_LEASE_MS,
    });
    // The next backoff is retryDelayMs(1) = 20 s past the new lease.
    const t2 = t + 10_001 + JOB_LEASE_MS;
    expect(await claimNext(h, reg, { worker: 'w3', now: t2 + 19_999 })).toBeNull();
    expect(await claimNext(h, reg, { worker: 'w3', now: t2 + 20_001 })).toMatchObject({ id, attempts: 2 });
  });

  it('a running job whose lease another claimant renewed is not taken by id', async () => {
    const { id } = await put({ type: 'test.light', payload: {} });
    await claimNext(h, reg, { worker: 'w1', now: T });
    const now = T + JOB_LEASE_MS + 10_001;
    at(now);
    // Another claimant reclaimed it first: attempts is 1, the lease is fresh.
    await h.db.updateTable('jobs').set({ attempts: 1, lock_token: 'x', locked_until: now + JOB_LEASE_MS }).where('id', '=', id).execute();
    expect(await claimById(h, reg, id, { worker: 'w2', now })).toBeNull();
    expect((await row(id)).lock_token).toBe('x');
  });

  it('attempts + 1 = max_attempts and an expired lease → dead (c), unique_key and secret_param NULL, one job_dead notification', async () => {
    const { id } = await put({ type: 'test.light', payload: {}, uniqueKey: 'once', maxAttempts: 1, secret: new Uint8Array([1, 2, 3]) });
    await claimNext(h, reg, { worker: 'w1', now: T });
    const now = T + JOB_LEASE_MS + 1;
    at(now);
    expect(await claimNext(h, reg, { worker: 'w2', now })).toBeNull();
    expect(await row(id)).toMatchObject({
      status: 'dead',
      last_error: 'LEASE_EXPIRED_MAX_ATTEMPTS',
      unique_key: null,
      secret_param: null,
      lock_token: null,
      locked_by: null,
      locked_until: null,
      finished_at: now,
      attempts: 0,
    });
    const notes = await h.db.selectFrom('notifications').select(['title_key', 'audience_permission', 'params']).execute();
    expect(notes).toEqual([
      { title_key: 'notification.job_dead.title', audience_permission: 'system.jobs.read', params: '{"name":"test.light"}' },
    ]);
    const events = await h.db.selectFrom('events').select(['channel', 'type', 'payload']).where('channel', '=', `jobs.${id}`).execute();
    expect(events).toEqual([{ channel: `jobs.${id}`, type: 'job.finished', payload: '{"status":"dead"}' }]);
    // A second pass finds nothing more to do.
    expect(await claimNext(h, reg, { worker: 'w2', now: now + 1 })).toBeNull();
    expect(await h.db.selectFrom('notifications').select('id').execute()).toHaveLength(1);
  });

  it('exempt (maintenance): only the listed ids are claimed', async () => {
    const one = await put({ type: 'test.light', payload: {} });
    const two = await put({ type: 'test.light', payload: {} });
    expect((await claimNext(h, reg, { worker: 'w', now: T, exempt: [two.id] }))?.id).toBe(two.id);
    expect(await claimNext(h, reg, { worker: 'w', now: T, exempt: [two.id] })).toBeNull();
    expect(await claimNext(h, reg, { worker: 'w', now: T, exempt: [] })).toBeNull();
    expect((await claimNext(h, reg, { worker: 'w', now: T, exempt: null }))?.id).toBe(one.id);
  });

  it('types filter, unknown types and excludeHeavy are skipped', async () => {
    const unknown = await put({ type: 'test.light', payload: {} });
    await h.db.updateTable('jobs').set({ type: 'test.gone' }).where('id', '=', unknown.id).execute();
    const hv = await put({ type: 'test.heavy', payload: {} });
    const lt = await put({ type: 'test.light', payload: {} });
    const ot = await put({ type: 'test.other', payload: {} });
    expect((await claimNext(h, reg, { worker: 'w', now: T, types: ['test.other'] }))?.id).toBe(ot.id);
    expect((await claimNext(h, reg, { worker: 'w', now: T, excludeHeavy: true }))?.id).toBe(lt.id);
    expect(await claimNext(h, reg, { worker: 'w', now: T, excludeHeavy: true })).toBeNull();
    const job = await claimNext(h, reg, { worker: 'w', now: T });
    expect(job).toMatchObject({ id: hv.id, heavy: true });
    expect(await heavyLock()).toEqual({ owner: job!.token, until: T + JOB_LEASE_MS });
    expect((await row(unknown.id)).status).toBe('queued');
  });

  /** `n` jobs of `input`, enqueued one by one; their ids. */
  const many = async (n: number, input: EnqueueInput): Promise<string[]> => {
    const ids: string[] = [];
    for (let i = 0; i < n; i += 1) ids.push((await put(input)).id);
    return ids;
  };
  /** Jobs `ids` as a process left them that died holding them: running, lease ended at `until`, `attempts`. */
  const orphan = (ids: string[], until: number, attempts = 0) =>
    h.db
      .updateTable('jobs')
      .set({ status: 'running', lock_token: 'gone', locked_by: 'dead:1', locked_until: until, attempts })
      .where('id', 'in', ids)
      .execute();
  /** More rows than one scan looks at (20). */
  const CROWD = 25;

  it('due jobs this claimant may not take, however many sit ahead, never hide one it may take', async () => {
    const reset = () => h.db.deleteFrom('jobs').execute();
    // Unknown types (a handler removed, a version rolled back).
    const gone = await many(CROWD, { type: 'test.light', payload: {}, runAt: T - 1000 });
    await h.db.updateTable('jobs').set({ type: 'test.gone' }).where('id', 'in', gone).execute();
    const a = await put({ type: 'test.light', payload: {} });
    expect((await claimNext(h, reg, { worker: 'w', now: T }))?.id).toBe(a.id);
    expect((await row(gone[0]!)).status).toBe('queued');
    await reset();
    // Other types than the claimant runs.
    await many(CROWD, { type: 'test.other', payload: {}, runAt: T - 1000 });
    const b = await put({ type: 'test.light', payload: {} });
    expect((await claimNext(h, reg, { worker: 'w', now: T, types: ['test.light'] }))?.id).toBe(b.id);
    await reset();
    // Maintenance: jobs not exempt.
    await many(CROWD, { type: 'test.light', payload: {}, runAt: T - 1000 });
    const c = await put({ type: 'test.light', payload: {} });
    expect((await claimNext(h, reg, { worker: 'w', now: T, exempt: [c.id] }))?.id).toBe(c.id);
    await reset();
    // Piggyback: heavy jobs.
    await many(CROWD, { type: 'test.heavy', payload: {}, runAt: T - 1000 });
    const d = await put({ type: 'test.light', payload: {} });
    expect((await claimNext(h, reg, { worker: 'w', now: T, excludeHeavy: true }))?.id).toBe(d.id);
    await reset();
    // Heavy jobs while another holder has jobs:heavy.
    expect(await claimLock(h, HEAVY_LOCK, 'someone-else', JOB_LEASE_MS)).toBe(true);
    await many(CROWD, { type: 'test.heavy', payload: {}, runAt: T - 1000 });
    const e = await put({ type: 'test.light', payload: {} });
    expect((await claimNext(h, reg, { worker: 'w', now: T }))?.id).toBe(e.id);
    expect((await heavyLock())?.owner).toBe('someone-else');
  });

  it('expired leases this claimant may not reclaim yet, however many sit ahead, never hide one it may', async () => {
    const reset = () => h.db.deleteFrom('jobs').execute();
    const now = T + 10 * JOB_LEASE_MS;
    at(now);
    // Unknown types below their last attempt stay as they are; at their last attempt they still become dead (c).
    const gone = await many(CROWD, { type: 'test.light', payload: {} });
    await h.db.updateTable('jobs').set({ type: 'test.gone' }).where('id', 'in', gone).execute();
    await orphan(gone, now - 200_000);
    const last = await put({ type: 'test.light', payload: {} });
    await h.db.updateTable('jobs').set({ type: 'test.gone' }).where('id', '=', last.id).execute();
    await orphan([last.id], now - 200_000, 4);
    const a = await put({ type: 'test.light', payload: {} });
    await orphan([a.id], now - 100_000);
    expect(await claimNext(h, reg, { worker: 'w', now })).toMatchObject({ id: a.id, attempts: 1 });
    expect(await row(gone[0]!)).toMatchObject({ status: 'running', lock_token: 'gone', attempts: 0 });
    expect(await row(last.id)).toMatchObject({ status: 'dead', last_error: 'LEASE_EXPIRED_MAX_ATTEMPTS' });
    await reset();
    // Other types than the claimant runs.
    await orphan(await many(CROWD, { type: 'test.other', payload: {} }), now - 200_000);
    const b = await put({ type: 'test.light', payload: {} });
    await orphan([b.id], now - 100_000);
    expect((await claimNext(h, reg, { worker: 'w', now, types: ['test.light'] }))?.id).toBe(b.id);
    await reset();
    // Maintenance: jobs not exempt.
    await orphan(await many(CROWD, { type: 'test.light', payload: {} }), now - 200_000);
    const c = await put({ type: 'test.light', payload: {} });
    await orphan([c.id], now - 100_000);
    expect((await claimNext(h, reg, { worker: 'w', now, exempt: [c.id] }))?.id).toBe(c.id);
    await reset();
    // Leases whose backoff has not passed yet (attempts 3: 80 s past the lease's end).
    await orphan(await many(CROWD, { type: 'test.light', payload: {} }), now - 70_000, 3);
    const d = await put({ type: 'test.light', payload: {} });
    await orphan([d.id], now - 60_000);
    expect((await claimNext(h, reg, { worker: 'w', now }))?.id).toBe(d.id);
    await reset();
    // Heavy jobs while another holder has jobs:heavy.
    expect(await claimLock(h, HEAVY_LOCK, 'someone-else', JOB_LEASE_MS)).toBe(true);
    await orphan(await many(CROWD, { type: 'test.heavy', payload: {} }), now - 200_000);
    const e = await put({ type: 'test.light', payload: {} });
    await orphan([e.id], now - 100_000);
    expect((await claimNext(h, reg, { worker: 'w', now }))?.id).toBe(e.id);
    expect((await heavyLock())?.owner).toBe('someone-else');
  });

  it('while another holder has jobs:heavy, a heavy job is not claimed but a light one is', async () => {
    expect(await claimLock(h, HEAVY_LOCK, 'someone-else', JOB_LEASE_MS)).toBe(true);
    const hv = await put({ type: 'test.heavy', payload: {} });
    const lg = await put({ type: 'test.long', payload: {} });
    const lt = await put({ type: 'test.light', payload: {} });
    expect((await claimNext(h, reg, { worker: 'w', now: T }))?.id).toBe(lt.id);
    expect(await claimNext(h, reg, { worker: 'w', now: T })).toBeNull();
    expect(await claimById(h, reg, hv.id, { worker: 'w', now: T })).toBeNull();
    expect((await heavyLock())?.owner).toBe('someone-else');
    // Once it is released, one heavy job at a time.
    await releaseLock(h, HEAVY_LOCK, 'someone-else');
    const first = await claimNext(h, reg, { worker: 'w', now: T });
    expect(first?.id).toBe(hv.id);
    expect(await claimNext(h, reg, { worker: 'w', now: T })).toBeNull();
    expect((await row(lg.id)).status).toBe('queued');
  });

  it('S27: an expired heavy job is not reclaimed while another heavy job holds jobs:heavy; reclaimed, its heartbeats keep the lock past 50 s', async () => {
    const a = await put({ type: 'test.heavy', payload: {} });
    const b = await put({ type: 'test.heavy', payload: {}, runAt: T + 1 });
    const first = await claimNext(h, reg, { worker: 'w1', now: T });
    expect(first?.id).toBe(a.id);
    // A's process died. Its lease and jobs:heavy end at T + 50 s; B takes the lock just after.
    at(T + JOB_LEASE_MS + 1);
    const jobB = await claimById(h, reg, b.id, { worker: 'w2', now: T + JOB_LEASE_MS + 1 });
    expect(jobB?.id).toBe(b.id);
    // A's lease and its backoff have passed, but B holds jobs:heavy.
    const late = T + JOB_LEASE_MS + 10_001;
    at(late);
    expect(await claimNext(h, reg, { worker: 'w3', now: late })).toBeNull();
    expect((await row(a.id)).lock_token).toBe(first!.token);
    // B ends and releases the lock; A is reclaimed and takes it.
    expect((await slice(jobB!)).outcome).toBe('succeeded');
    expect(await heavyLock()).toBeUndefined();
    const again = await claimNext(h, reg, { worker: 'w3', now: late });
    expect(again).toMatchObject({ id: a.id, attempts: 1, heavy: true });
    expect((await heavyLock())?.owner).toBe(again!.token);

    // Its slice heartbeats every 20 s for 80 s: the lock stays its own, and no one else can take it.
    const intruder: boolean[] = [];
    heavyRun = async (c) => {
      for (let i = 1; i <= 4; i += 1) {
        at(late + i * 20_000);
        await c.heartbeat();
        intruder.push(await claimLock(c.handle, HEAVY_LOCK, 'intruder', JOB_LEASE_MS));
      }
      expect(await heavyLock()).toEqual({ owner: again!.token, until: late + 80_000 + JOB_LEASE_MS });
      expect((await row(a.id)).locked_until).toBe(late + 80_000 + JOB_LEASE_MS);
    };
    expect((await slice(again!)).outcome).toBe('succeeded');
    expect(intruder).toEqual([false, false, false, false]);
    expect(await heavyLock()).toBeUndefined();
  });

  it('a longRunning job counts as heavy and is claimed again by id while queued and due', async () => {
    const { id } = await put({ type: 'test.long', payload: {} });
    const job = await claimById(h, reg, id, { worker: 'w', now: T });
    expect(job).toMatchObject({ id, heavy: true });
    expect(await claimById(h, reg, id, { worker: 'w', now: T })).toBeNull();
    expect(await claimById(h, reg, '01JBX3Q5N2V8W9Y0Z1A2B3C4D5', { worker: 'w', now: T })).toBeNull();
  });

  it('anomaly: a lease that ends more than 2 × lease ahead (now + 10 min) counts as expired', async () => {
    const { id } = await put({ type: 'test.heavy', payload: {} });
    const first = await claimNext(h, reg, { worker: 'w1', now: T });
    // The clock ran ahead and came back: the lease and the heavy lock now end 10 minutes from now.
    await h.db.updateTable('jobs').set({ locked_until: T + 600_000 }).where('id', '=', id).execute();
    await h.db.updateTable('locks').set({ until: T + 600_000 }).where('name', '=', HEAVY_LOCK).execute();
    expect(await claimNext(h, reg, { worker: 'w2', now: T })).toBeNull();
    const job = await claimNext(h, reg, { worker: 'w2', now: T, anomaly: true });
    expect(job).toMatchObject({ id, attempts: 1 });
    expect(job!.token).not.toBe(first!.token);
    expect(await row(id)).toMatchObject({ locked_until: T + JOB_LEASE_MS, lock_token: job!.token });
    expect((await heavyLock())?.owner).toBe(job!.token);
  });

  it('refuses a malformed worker', async () => {
    await expect(claimNext(h, reg, { worker: '', now: T })).rejects.toThrow(TypeError);
    await expect(claimNext(h, reg, { worker: 'w ', now: T })).rejects.toThrow(TypeError);
    await expect(claimNext(h, reg, { worker: 'w\uD800', now: T })).rejects.toThrow(TypeError);
    await expect(claimNext(h, reg, { worker: 'w\u0000', now: T })).rejects.toThrow(TypeError);
    await expect(claimNext(h, reg, { worker: 'w', now: -1 })).rejects.toThrow(TypeError);
    expect(await claimNext(h, reg, { worker: 'host-\u{1F600}:1', now: T })).toBeNull();
  });
});
