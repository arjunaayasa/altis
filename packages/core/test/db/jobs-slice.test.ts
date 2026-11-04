import { randomBytes } from 'node:crypto';
import fsp from 'node:fs/promises';
import os from 'node:os';
import path from 'node:path';
import { PHASE1_MIGRATIONS, ensureTable, runMigrations, withTx, type DB } from '@altis/db';
import { DomainError, isDomainError, newId } from '@altis/shared';
import type { Kysely, Transaction } from 'kysely';
import { z } from 'zod';
import { afterAll, beforeAll, beforeEach, describe, expect, it, vi } from 'vitest';
import { engineLabel, testDb, testDbContext, type TestDbHandle } from '../../../../tools/test/test-db.js';
import type { KeyringEntry } from '../../src/crypto/secret-box.js';
import { claimNext } from '../../src/jobs/claim.js';
import { enqueue } from '../../src/jobs/enqueue.js';
import { createJobRegistry } from '../../src/jobs/registry.js';
import { getJob, listJobs, requestCancel, retryJob } from '../../src/jobs/service.js';
import { closeJobSessions, pruneJobSessions, runSlice } from '../../src/jobs/slice.js';
import {
  JOB_LEASE_MS,
  type ClaimedJob,
  type EnqueueInput,
  type JobContext,
  type JobHandler,
  type JobOutcome,
  type RunMode,
  type SliceResult,
} from '../../src/jobs/types.js';
import { runJobChildren } from '../fixtures/job-children.js';

// Slices (spec §10.1 result table, decisions C4, C38): continue, error with backoff, dead after max_attempts, done;
// fencing by the claim token; cancellation; retry; per-job sessions; and A5's exactly-once slice effects across a
// SIGKILL (child processes, every engine).

const ctx = testDbContext();
const T = 1_767_225_600_000;
const keyring: KeyringEntry[] = [{ kid: 'k1', key: randomBytes(32).toString('base64url'), active: true }];
const silent = { info() {}, warn() {}, error() {} };

type P = { k: number };
type Impl = (c: JobContext, p: P) => Promise<JobOutcome<P>>;
let impl: Impl = () => Promise.resolve({ done: true });
const stepPayload = z.strictObject({ k: z.number().int() });
const step: JobHandler<P> = {
  type: 'test.step',
  permission: 'system.jobs.manage',
  retryable: 'api',
  payload: stepPayload,
  run: (c, p) => impl(c, p),
};
const origin: JobHandler<P> = { ...step, type: 'test.origin', retryable: 'origin-only' };
const blob: JobHandler<{ s: string }> = {
  type: 'test.blob',
  permission: 'system.jobs.manage',
  retryable: 'api',
  payload: z.strictObject({ s: z.string() }),
  run: () => Promise.resolve({ continueWith: { s: 'x'.repeat(70_000) }, progress: 1 }),
};
/** The `k` on which test.picky's schema throws (a refine that throws, which zod's safeParse passes on); null: never. */
let refineThrowsAt: number | null = null;
const picky: JobHandler<P> = {
  ...step,
  type: 'test.picky',
  payload: stepPayload.refine((p) => {
    if (p.k === refineThrowsAt) throw new Error('refine blew up');
    return true;
  }),
};
const reg = createJobRegistry([step, origin, blob, picky]);

/** The slices' clock. */
let now = T;

describe.skipIf(!ctx.available)(`runSlice and the job service (spec §10.1, C4, C38) [${engineLabel()}]`, () => {
  let h: TestDbHandle;
  let dataDir: string;

  beforeAll(async () => {
    h = await testDb();
    dataDir = await fsp.mkdtemp(path.join(os.tmpdir(), 'altis-core-jobs-slice-'));
    await runMigrations(h, { appVersion: '0.1.0', dataDir, migrations: PHASE1_MIGRATIONS });
  });

  afterAll(async () => {
    await closeJobSessions();
    await h?.close();
    if (dataDir !== undefined) await fsp.rm(dataDir, { recursive: true, force: true });
  });

  beforeEach(async () => {
    await closeJobSessions();
    for (const table of ['jobs', 'locks', 'notifications', 'events', 'audit_log'] as const) await h.db.deleteFrom(table).execute();
    now = T;
    impl = () => Promise.resolve({ done: true });
    refineThrowsAt = null;
  });

  const put = (input: Partial<EnqueueInput> = {}) =>
    withTx(h, (trx) => enqueue(trx, reg, { type: 'test.step', payload: { k: 1 }, ...input }, { now, keyring }));
  const row = (id: string) => h.db.selectFrom('jobs').selectAll().where('id', '=', id).executeTakeFirstOrThrow();
  const events = (id: string) =>
    h.db.selectFrom('events').select(['type', 'payload']).where('channel', '=', `jobs.${id}`).orderBy('seq').execute();
  const claim = async (worker = 'w1'): Promise<ClaimedJob> => {
    const job = await claimNext(h, reg, { worker, now });
    if (job === null) throw new Error('nothing to claim');
    return job;
  };
  const slice = (job: ClaimedJob, mode: RunMode = 'worker'): Promise<SliceResult> =>
    runSlice(h, reg, job, { mode, budgetMs: 20_000, keyring, log: silent, clock: () => now, env: {} });
  const errorOf = async (p: Promise<unknown>): Promise<DomainError> => {
    const e = await p.catch((error: unknown) => error);
    if (!isDomainError(e)) throw new Error(`expected a DomainError, got ${String(e)}`);
    return e;
  };

  it('{continueWith: {k: 2}, progress: 20} → queued, run_at = now, attempts 0, the checkpoint as payload, lock columns NULL', async () => {
    const { id } = await put({ uniqueKey: 'u' });
    const job = await claim();
    impl = async () => {
      now = T + 3000;
      return { continueWith: { k: 2 }, progress: 20, message: 'two' };
    };
    expect(await slice(job)).toEqual({ jobId: id, type: 'test.step', outcome: 'continued' });
    expect(await row(id)).toMatchObject({
      status: 'queued',
      run_at: T + 3000,
      attempts: 0,
      payload: '{"k":2}',
      lock_token: null,
      locked_by: null,
      locked_until: null,
      progress: 20,
      progress_message: 'two',
      unique_key: 'u',
      finished_at: null,
      updated_at: T + 3000,
    });
    expect(await events(id)).toEqual([{ type: 'job.progress', payload: '{"status":"queued","progress":20}' }]);
    // The next claim gets the checkpoint.
    expect((await claim()).payload).toEqual({ k: 2 });
  });

  it('a thrown error → queued after retryDelayMs(a + 1); thrown 5 times in a row → dead after exactly 5 attempts', async () => {
    const { id } = await put({ uniqueKey: 'u', secret: new Uint8Array([9]) });
    impl = () => Promise.reject(new DomainError('DISK_QUOTA'));
    const delays: number[] = [];
    const results: SliceResult[] = [];
    for (let i = 0; i < 5; i += 1) {
      const job = await claim();
      expect(job.attempts).toBe(i);
      results.push(await slice(job));
      const r = await row(id);
      if (r.status === 'queued') {
        delays.push(r.run_at - now);
        now = r.run_at;
      }
    }
    expect(results.map((r) => [r.outcome, r.error])).toEqual([
      ['retry', 'DISK_QUOTA'],
      ['retry', 'DISK_QUOTA'],
      ['retry', 'DISK_QUOTA'],
      ['retry', 'DISK_QUOTA'],
      ['dead', 'DISK_QUOTA'],
    ]);
    expect(delays).toEqual([20_000, 40_000, 80_000, 160_000]);
    expect(await row(id)).toMatchObject({
      status: 'dead',
      attempts: 5,
      last_error: 'DISK_QUOTA',
      unique_key: null,
      secret_param: null,
      lock_token: null,
      locked_until: null,
      finished_at: now,
    });
    const notes = await h.db.selectFrom('notifications').select(['title_key', 'audience_permission']).execute();
    expect(notes).toEqual([{ title_key: 'notification.job_dead.title', audience_permission: 'system.jobs.read' }]);
    expect((await events(id)).at(-1)).toEqual({ type: 'job.finished', payload: '{"status":"dead"}' });
    expect(await claimNext(h, reg, { worker: 'w', now: now + 10_000_000 })).toBeNull();
  });

  it('last_error is the DomainError code plus its detail (≤ 500 characters), or only the name of any other error', async () => {
    const cases: [unknown, string][] = [
      [new DomainError('DISK_QUOTA', { detail: 'Disk penuh / Disk full' }), 'DISK_QUOTA: Disk penuh / Disk full'],
      [new Error('connect ECONNREFUSED 10.0.0.1 password=hunter2'), 'Error'],
      [new TypeError('x is not a function'), 'TypeError'],
      ['a string', 'Error'],
    ];
    for (const [thrown, stored] of cases) {
      const { id } = await put();
      impl = () => Promise.reject(thrown);
      expect((await slice(await claim())).error).toBe(stored);
      expect((await row(id)).last_error).toBe(stored);
      await h.db.deleteFrom('jobs').execute();
    }
    const { id } = await put();
    impl = () => Promise.reject(new DomainError('DISK_QUOTA', { detail: '\u{1F600}'.repeat(600) }));
    await slice(await claim());
    const stored = (await row(id)).last_error!;
    expect([...stored]).toHaveLength(500);
    expect(stored.startsWith('DISK_QUOTA: \u{1F600}')).toBe(true);
  });

  it('a stored payload the schema refuses, or an outcome that is neither shape, takes the error path', async () => {
    const a = await put();
    await h.db.updateTable('jobs').set({ payload: '{"k":"x"}' }).where('id', '=', a.id).execute();
    expect(await slice(await claim())).toMatchObject({ outcome: 'retry', error: 'VALIDATION_FAILED' });
    await h.db.deleteFrom('jobs').execute();
    const b = await put();
    impl = () => Promise.resolve({ progress: 3 } as never);
    expect(await slice(await claim())).toMatchObject({ outcome: 'retry', error: 'TypeError' });
    expect((await row(b.id)).status).toBe('queued');
    await h.db.deleteFrom('jobs').execute();
    await put();
    impl = () => Promise.resolve({ continueWith: { k: 'no' } as never, progress: 1 });
    expect(await slice(await claim())).toMatchObject({ outcome: 'retry', error: 'VALIDATION_FAILED' });
    await h.db.deleteFrom('jobs').execute();
    impl = () => Promise.resolve({ continueWith: { k: 2 }, progress: Number.NaN });
    await put();
    expect(await slice(await claim())).toMatchObject({ outcome: 'retry', error: 'TypeError' });
    await h.db.deleteFrom('jobs').execute();
    // A checkpoint too large for jobs.payload (TEXT).
    await withTx(h, (trx) => enqueue(trx, reg, { type: 'test.blob', payload: { s: '' } }, { now, keyring }));
    expect(await slice(await claim())).toMatchObject({ outcome: 'retry', error: 'TypeError' });
  });

  it('{done: true} → succeeded, unique_key NULL, finished_at set, secret_param NULL, progress 100', async () => {
    const { id } = await put({ uniqueKey: 'u', secret: new Uint8Array([1]) });
    const job = await claim();
    now = T + 500;
    expect(await slice(job)).toEqual({ jobId: id, type: 'test.step', outcome: 'succeeded' });
    expect(await row(id)).toMatchObject({
      status: 'succeeded',
      unique_key: null,
      secret_param: null,
      finished_at: T + 500,
      lock_token: null,
      locked_by: null,
      locked_until: null,
      progress: 100,
    });
    expect(await events(id)).toEqual([{ type: 'job.finished', payload: '{"status":"succeeded"}' }]);
  });

  it('{done: true, message} → succeeded with that progress_message (Task 20: a backup converted to frozen); a malformed message → error', async () => {
    const { id } = await put();
    impl = () => Promise.resolve({ done: true, message: 'converted to frozen' });
    expect((await slice(await claim())).outcome).toBe('succeeded');
    expect(await row(id)).toMatchObject({ status: 'succeeded', progress: 100, progress_message: 'converted to frozen' });

    const other = await put();
    impl = () => Promise.resolve({ done: true, message: 7 } as unknown as JobOutcome<P>);
    expect(await slice(await claim())).toMatchObject({ jobId: other.id, outcome: 'retry', error: 'TypeError' });
  });

  // 1d T20-SNAPSHOT-HOLD-COUNTS-ATTEMPT: a slice that cannot work yet (a lock another holds) waits without an attempt.
  it('{waitUntil, message} → queued at run_at = waitUntil, attempts unchanged, the payload kept, lock columns NULL; not claimed before then', async () => {
    const { id } = await put({ uniqueKey: 'u' });
    // An earlier attempt failed (attempts 1): the wait neither adds one nor clears it.
    await h.db.updateTable('jobs').set({ attempts: 1, last_error: 'TX_CONFLICT' }).where('id', '=', id).execute();
    const job = await claim();
    impl = async () => {
      now = T + 2000;
      return { waitUntil: T + 62_000, message: 'waiting' };
    };
    expect(await slice(job)).toEqual({ jobId: id, type: 'test.step', outcome: 'waiting' });
    expect(await row(id)).toMatchObject({
      status: 'queued',
      run_at: T + 62_000,
      attempts: 1,
      last_error: 'TX_CONFLICT',
      payload: '{"k":1}',
      lock_token: null,
      locked_by: null,
      locked_until: null,
      progress_message: 'waiting',
      unique_key: 'u',
      finished_at: null,
      updated_at: T + 2000,
    });
    expect(await events(id)).toEqual([{ type: 'job.progress', payload: '{"status":"queued"}' }]);
    now = T + 61_999;
    expect(await claimNext(h, reg, { worker: 'w1', now })).toBeNull();
    now = T + 62_000;
    const again = await claim();
    expect([again.id, again.payload, again.attempts]).toEqual([id, { k: 1 }, 1]);
  });

  it('{waitUntil} with a cancel request pending ends the job cancelled; a waitUntil that is not an epoch-ms integer → error', async () => {
    const { id } = await put();
    const job = await claim();
    impl = async () => {
      await withTx(h, (trx) => requestCancel(trx, id, now));
      return { waitUntil: T + 60_000 };
    };
    expect(await slice(job)).toMatchObject({ outcome: 'cancelled' });
    expect(await row(id)).toMatchObject({ status: 'cancelled', finished_at: T });

    for (const waitUntil of [Number.NaN, -1, 1.5, '1' as unknown as number]) {
      await h.db.deleteFrom('jobs').execute();
      await put();
      impl = () => Promise.resolve({ waitUntil });
      expect(await slice(await claim())).toMatchObject({ outcome: 'retry', error: 'TypeError' });
    }
  });

  it('fencing: once another worker has reclaimed the job, the first worker’s result changes nothing (lost)', async () => {
    const { id } = await put({ uniqueKey: 'u' });
    const first = await claim('w1');
    let second = null as ClaimedJob | null;
    impl = async () => {
      now = T + JOB_LEASE_MS + 10_001;
      second = await claimNext(h, reg, { worker: 'w2', now });
      return { done: true };
    };
    expect(await slice(first)).toEqual({ jobId: id, type: 'test.step', outcome: 'lost' });
    expect(second).not.toBeNull();
    expect(await row(id)).toMatchObject({ status: 'running', lock_token: second!.token, locked_by: 'w2', attempts: 1, unique_key: 'u' });
    expect(await events(id)).toEqual([]);
  });

  it('fencing: the first worker’s next heartbeat throws JOB_LEASE_LOST, and its slice reports lost', async () => {
    const { id } = await put();
    const first = await claim('w1');
    const codes: string[] = [];
    impl = async (c) => {
      now = T + JOB_LEASE_MS + 10_001;
      await claimNext(h, reg, { worker: 'w2', now });
      codes.push((await errorOf(c.heartbeat())).code);
      // Once lost, it stays lost.
      codes.push((await errorOf(c.heartbeat())).code);
      codes.push((await errorOf(c.markPointOfNoReturn())).code);
      return { continueWith: { k: 2 }, progress: 50 };
    };
    expect((await slice(first)).outcome).toBe('lost');
    expect(codes).toEqual(['JOB_LEASE_LOST', 'JOB_LEASE_LOST', 'JOB_LEASE_LOST']);
    expect(await row(id)).toMatchObject({ status: 'running', payload: '{"k":1}', locked_by: 'w2' });
  });

  it('heartbeat: renews the lease at most every 15 s, at once for a progress change after 2 s; publishes job.progress', async () => {
    const { id } = await put();
    const job = await claim();
    const leases: (number | null)[] = [];
    impl = async (c) => {
      now = T + 1000;
      await c.heartbeat();
      leases.push((await row(id)).locked_until);
      now = T + 2000;
      await c.heartbeat({ progress: 40, message: 'half' });
      leases.push((await row(id)).locked_until);
      expect(await row(id)).toMatchObject({ progress: 40, progress_message: 'half', updated_at: T + 2000 });
      now = T + 3000;
      await c.heartbeat({ progress: 40, message: 'half' });
      leases.push((await row(id)).locked_until);
      now = T + 17_000;
      await c.heartbeat();
      leases.push((await row(id)).locked_until);
      return { done: true };
    };
    expect((await slice(job)).outcome).toBe('succeeded');
    expect(leases).toEqual([T + JOB_LEASE_MS, T + 2000 + JOB_LEASE_MS, T + 2000 + JOB_LEASE_MS, T + 17_000 + JOB_LEASE_MS]);
    expect(await events(id)).toEqual([
      { type: 'job.progress', payload: '{"status":"running","progress":40}' },
      { type: 'job.finished', payload: '{"status":"succeeded"}' },
    ]);
  });

  it('heartbeat in piggyback mode yields to the event loop once 50 ms passed since the last yield', async () => {
    await put();
    const job = await claim();
    const ran: boolean[] = [];
    impl = async (c) => {
      for (const advance of [60, 10, 45]) {
        now += advance;
        let flag = false;
        setImmediate(() => {
          flag = true;
        });
        await c.heartbeat();
        ran.push(flag);
      }
      return { done: true };
    };
    expect((await slice(job, 'piggyback')).outcome).toBe('succeeded');
    expect(ran).toEqual([true, false, true]);
  });

  it('now() and budgetLeftMs() follow the slice clock; the budget never goes below 0', async () => {
    await put();
    const job = await claim();
    const seen: [number, number][] = [];
    impl = async (c) => {
      seen.push([c.now(), c.budgetLeftMs()]);
      now += 15_000;
      seen.push([c.now(), c.budgetLeftMs()]);
      now += 15_000;
      seen.push([c.now(), c.budgetLeftMs()]);
      expect(c.jobId).toBe(job.id);
      expect(c.mode).toBe('worker');
      expect(c.db).toBe(h.db);
      return { done: true };
    };
    await slice(job);
    expect(seen).toEqual([
      [T, 20_000],
      [T + 15_000, 5_000],
      [T + 30_000, 0],
    ]);
  });

  it('requestCancel: a queued job is cancelled at once (unique_key NULL); a terminal one → JOB_NOT_CANCELLABLE; unknown → NOT_FOUND', async () => {
    const { id } = await put({ uniqueKey: 'u', secret: new Uint8Array([1]) });
    now = T + 100;
    expect(await withTx(h, (trx) => requestCancel(trx, id, now))).toBe('cancelled');
    expect(await row(id)).toMatchObject({ status: 'cancelled', unique_key: null, secret_param: null, finished_at: T + 100 });
    expect(await events(id)).toEqual([{ type: 'job.finished', payload: '{"status":"cancelled"}' }]);
    const again = await errorOf(withTx(h, (trx) => requestCancel(trx, id, now)));
    expect([again.code, again.status]).toEqual(['JOB_NOT_CANCELLABLE', 409]);
    expect((await errorOf(withTx(h, (trx) => requestCancel(trx, newId(), now)))).code).toBe('NOT_FOUND');
  });

  it('requestCancel on a running job: its next heartbeat makes cancelled() true, and a handler that then returns → cancelled', async () => {
    const { id } = await put({ uniqueKey: 'u' });
    const job = await claim();
    const flags: boolean[] = [];
    impl = async (c) => {
      expect(await withTx(h, (trx) => requestCancel(trx, c.jobId, now))).toBe('requested');
      flags.push(c.cancelled());
      now = T + 15_000;
      await c.heartbeat();
      flags.push(c.cancelled());
      return { continueWith: { k: 2 }, progress: 10 };
    };
    expect(await slice(job)).toEqual({ jobId: id, type: 'test.step', outcome: 'cancelled' });
    expect(flags).toEqual([false, true]);
    expect(await row(id)).toMatchObject({ status: 'cancelled', unique_key: null, finished_at: T + 15_000, lock_token: null });
  });

  it('a job claimed with a cancel request pending starts its slice with cancelled() true (unless past its point of no return)', async () => {
    const { id } = await put();
    await claim('w1');
    expect(await withTx(h, (trx) => requestCancel(trx, id, now))).toBe('requested');
    // Its process died before its next heartbeat: the job is reclaimed after the lease and the backoff.
    now = T + JOB_LEASE_MS + 10_001;
    const job = await claim('w2');
    expect(job).toMatchObject({ id, attempts: 1, cancelRequested: true, pointOfNoReturn: false });
    const seen: boolean[] = [];
    impl = async (c, p) => {
      seen.push(c.cancelled());
      return { continueWith: { k: p.k + 1 }, progress: 10 };
    };
    expect((await slice(job)).outcome).toBe('cancelled');
    expect(seen).toEqual([true]);

    // Past its point of no return a pending request no longer counts.
    const b = await put();
    await claim('w1');
    expect(await withTx(h, (trx) => requestCancel(trx, b.id, now))).toBe('requested');
    await h.db.updateTable('jobs').set({ point_of_no_return: 1 }).where('id', '=', b.id).execute();
    now += JOB_LEASE_MS + 10_001;
    const late = await claim('w2');
    expect(late).toMatchObject({ id: b.id, cancelRequested: true, pointOfNoReturn: true });
    expect((await slice(late)).outcome).toBe('continued');
    expect(seen).toEqual([true, false]);
  });

  it('a cancel request the handler never heard of still ends the job cancelled instead of queuing it again', async () => {
    const { id } = await put();
    const job = await claim();
    impl = async () => {
      await withTx(h, (trx) => requestCancel(trx, id, now));
      return { continueWith: { k: 2 }, progress: 10 };
    };
    expect((await slice(job)).outcome).toBe('cancelled');
    expect((await row(id)).status).toBe('cancelled');
  });

  /**
   * `trx` with `after(n)` run once the n-th UPDATE issued through it has completed: a write of another transaction
   * that lands between two statements (simulated in `trx` itself; SQLite's BEGIN IMMEDIATE leaves no gap there).
   */
  const racing = (trx: Transaction<DB>, after: (n: number) => Promise<void>): Transaction<DB> => {
    const updates = new Set<unknown>();
    let n = 0;
    return trx.withPlugin({
      transformQuery(args) {
        if (args.node.kind === 'UpdateQueryNode') updates.add(args.queryId);
        return args.node;
      },
      async transformResult(args) {
        if (updates.delete(args.queryId)) {
          n += 1;
          await after(n);
        }
        return args.result;
      },
    });
  };
  /** Job `id` as another process's write leaves it: re-queued by a slice's result, or claimed again. */
  const flip = async (trx: Transaction<DB>, id: string, status: 'queued' | 'running'): Promise<void> => {
    await trx
      .updateTable('jobs')
      .set(status === 'queued' ? { status, lock_token: null, locked_by: null, locked_until: null } : { status, lock_token: 'x', locked_until: now + JOB_LEASE_MS })
      .where('id', '=', id)
      .execute();
  };

  it('requestCancel: a slice result that lands between its two UPDATEs still cancels the job, which is still cancellable', async () => {
    const { id } = await put();
    await claim();
    // UPDATE #1 (queued → cancelled) sees `running`; the slice's continue then commits `queued`; UPDATE #2 (running →
    // requested) sees `queued`.
    const result = await withTx(h, (trx) => requestCancel(racing(trx, (n) => (n === 1 ? flip(trx, id, 'queued') : Promise.resolve())), id, now));
    expect(result).toBe('cancelled');
    expect(await row(id)).toMatchObject({ status: 'cancelled', unique_key: null });
  });

  it('requestCancel: a job that keeps changing under it → TX_CONFLICT (withTx runs it again), never JOB_NOT_CANCELLABLE', async () => {
    const { id } = await put();
    await claim();
    // Every UPDATE misses: after the queued one the job is queued, after the running one it is running again.
    const e = await errorOf(
      withTx(h, (trx) => requestCancel(racing(trx, (n) => flip(trx, id, n % 2 === 1 ? 'queued' : 'running')), id, now), { retry: false }),
    );
    expect([e.code, e.status]).toEqual(['TX_CONFLICT', 409]);
    expect(await row(id)).toMatchObject({ status: 'running', cancel_requested: 0 });
  });

  it('after markPointOfNoReturn() a cancel → 409 JOB_NOT_CANCELLABLE, also between slices', async () => {
    const { id } = await put();
    const job = await claim();
    const codes: string[] = [];
    impl = async (c) => {
      await c.markPointOfNoReturn();
      codes.push((await errorOf(withTx(h, (trx) => requestCancel(trx, c.jobId, now)))).code);
      return { continueWith: { k: 2 }, progress: 60 };
    };
    expect((await slice(job)).outcome).toBe('continued');
    expect(codes).toEqual(['JOB_NOT_CANCELLABLE']);
    expect(await row(id)).toMatchObject({ status: 'queued', point_of_no_return: 1 });
    expect((await errorOf(withTx(h, (trx) => requestCancel(trx, id, now)))).code).toBe('JOB_NOT_CANCELLABLE');
    expect((await claim()).pointOfNoReturn).toBe(true);
  });

  it('retryJob: a dead api job → queued, attempts 0, run_at now; origin-only → 409 origin_only; another status → 409 state', async () => {
    const { id } = await put({ maxAttempts: 1, uniqueKey: 'u' });
    impl = () => Promise.reject(new DomainError('DISK_QUOTA'));
    expect((await slice(await claim())).outcome).toBe('dead');
    now = T + 5000;
    await withTx(h, (trx) => retryJob(trx, reg, id, now));
    expect(await row(id)).toMatchObject({
      status: 'queued',
      attempts: 0,
      run_at: T + 5000,
      last_error: null,
      finished_at: null,
      payload: '{"k":1}',
      secret_param: null,
      unique_key: null,
    });
    expect((await events(id)).at(-1)).toEqual({ type: 'job.progress', payload: '{"status":"queued","progress":0}' });
    const queued = await errorOf(withTx(h, (trx) => retryJob(trx, reg, id, now)));
    expect([queued.code, queued.status, queued.meta?.['reason']]).toEqual(['JOB_NOT_RETRYABLE', 409, 'state']);
    impl = () => Promise.resolve({ done: true });
    expect((await slice(await claim())).outcome).toBe('succeeded');
    expect((await errorOf(withTx(h, (trx) => retryJob(trx, reg, id, now)))).meta?.['reason']).toBe('state');

    const o = await withTx(h, (trx) => enqueue(trx, reg, { type: 'test.origin', payload: { k: 1 }, maxAttempts: 1 }, { now, keyring }));
    impl = () => Promise.reject(new DomainError('DISK_QUOTA'));
    expect((await slice(await claim())).outcome).toBe('dead');
    const refused = await errorOf(withTx(h, (trx) => retryJob(trx, reg, o.id, now)));
    expect([refused.code, refused.status, refused.meta?.['reason']]).toEqual(['JOB_NOT_RETRYABLE', 409, 'origin_only']);
    expect((await row(o.id)).status).toBe('dead');
    expect((await errorOf(withTx(h, (trx) => retryJob(trx, reg, newId(), now)))).code).toBe('NOT_FOUND');
  });

  it('retryJob re-queues a cancelled job with its stored payload', async () => {
    const { id } = await put({ payload: { k: 4 } });
    await withTx(h, (trx) => requestCancel(trx, id, now));
    await withTx(h, (trx) => retryJob(trx, reg, id, now));
    expect(await row(id)).toMatchObject({ status: 'queued', payload: '{"k":4}', cancel_requested: 0 });
  });

  it('ctx.session: opened in slice 1, kept (fresh: false) in slice 2 of the same process, closed when the job succeeds', async () => {
    await put();
    const open = vi.fn(() => Promise.resolve({ conn: randomBytes(4).toString('hex') }));
    const close = vi.fn<(s: { conn: string }) => Promise<void>>(() => Promise.resolve());
    const got: { value: { conn: string }; fresh: boolean }[] = [];
    impl = async (c, p) => {
      got.push(await c.session(open, close));
      return p.k >= 3 ? { done: true } : { continueWith: { k: p.k + 1 }, progress: p.k * 30 };
    };
    for (const outcome of ['continued', 'continued', 'succeeded']) {
      expect((await slice(await claim())).outcome).toBe(outcome);
      if (outcome === 'continued') expect(close).not.toHaveBeenCalled();
      now += 1000;
    }
    expect(got.map((g) => g.fresh)).toEqual([true, false, false]);
    expect(new Set(got.map((g) => g.value)).size).toBe(1);
    expect(open).toHaveBeenCalledTimes(1);
    expect(close).toHaveBeenCalledTimes(1);
    expect(close).toHaveBeenCalledWith(got[0]?.value);
  });

  it('ctx.session: a job another process ran in between gets a fresh session (the stale one closed); closeJobSessions() drains', async () => {
    const { id } = await put();
    const open = vi.fn(() => Promise.resolve(randomBytes(4).toString('hex')));
    const close = vi.fn<(s: string) => Promise<void>>(() => Promise.resolve());
    const fresh: boolean[] = [];
    impl = async (c, p) => {
      fresh.push((await c.session(open, close)).fresh);
      return { continueWith: { k: p.k + 1 }, progress: 10 };
    };
    await slice(await claim());
    // Another process ran a slice meanwhile: the checkpoint moved on.
    await h.db.updateTable('jobs').set({ payload: '{"k":7}', updated_at: now + 1 }).where('id', '=', id).execute();
    await slice(await claim());
    expect(fresh).toEqual([true, true]);
    expect(close).toHaveBeenCalledTimes(1);
    await closeJobSessions();
    expect(close).toHaveBeenCalledTimes(2);
    await slice(await claim());
    expect(fresh).toEqual([true, true, true]);
    // A slice that fails or is lost closes its job's session.
    impl = async (c) => {
      await c.session(open, close);
      throw new DomainError('DISK_QUOTA');
    };
    expect((await slice(await claim())).outcome).toBe('retry');
    expect(close).toHaveBeenCalledTimes(3);
    expect(open).toHaveBeenCalledTimes(3);
  });

  it('ctx.session: a stalled slice and the slice that reclaimed its job in this process each close only their own session', async () => {
    await put();
    const opened: string[] = [];
    const open = () => {
      opened.push(`s${opened.length + 1}`);
      return Promise.resolve(opened.at(-1)!);
    };
    const close = vi.fn<(s: string) => Promise<void>>(() => Promise.resolve());
    const got: [string, boolean][] = [];
    let closedDuringSlice2: unknown[][] = [];
    let calls = 0;
    impl = async (c, p) => {
      calls += 1;
      const s = await c.session(open, close);
      got.push([s.value, s.fresh]);
      if (calls === 1) {
        // Slice 1 stalls past its lease and the backoff: this process reclaims the job and runs slice 2 meanwhile.
        now = T + JOB_LEASE_MS + 10_001;
        const job2 = await claim('w1');
        expect(job2.attempts).toBe(1);
        expect((await slice(job2)).outcome).toBe('continued');
        closedDuringSlice2 = [...close.mock.calls];
      }
      return { continueWith: { k: p.k + 1 }, progress: 10 };
    };
    expect((await slice(await claim())).outcome).toBe('lost');
    // Slice 2 left slice 1's session to it; slice 1 closed its own and not slice 2's.
    expect(closedDuringSlice2).toEqual([]);
    expect(close.mock.calls).toEqual([['s1']]);
    // The next slice in this process keeps slice 2's session.
    now += 1000;
    expect((await slice(await claim())).outcome).toBe('continued');
    expect(got).toEqual([
      ['s1', true],
      ['s2', true],
      ['s2', false],
    ]);
    expect(close.mock.calls).toEqual([['s1']]);
  });

  it('ctx.session: a stalled slice that opens its session after the slice that reclaimed its job continued leaves that session to the job', async () => {
    await put();
    const opened: string[] = [];
    const open = () => {
      opened.push(`s${opened.length + 1}`);
      return Promise.resolve(opened.at(-1)!);
    };
    const close = vi.fn<(s: string) => Promise<void>>(() => Promise.resolve());
    const got: [string, boolean][] = [];
    let calls = 0;
    impl = async (c, p) => {
      calls += 1;
      if (calls === 1) {
        // Slice 1 stalls before its first ctx.session call, past its lease and the backoff: this process reclaims the
        // job, and slice 2 opens s1 and continues, which keeps s1 for the job's next slice.
        now = T + JOB_LEASE_MS + 10_001;
        expect((await slice(await claim('w1'))).outcome).toBe('continued');
        expect(close).not.toHaveBeenCalled();
      }
      const s = await c.session(open, close);
      got.push([s.value, s.fresh]);
      return { continueWith: { k: p.k + 1 }, progress: 10 };
    };
    // Slice 1 (the stale one) opens s2 and closes only that one.
    expect((await slice(await claim())).outcome).toBe('lost');
    expect(close.mock.calls).toEqual([['s2']]);
    // The next slice in this process keeps slice 2's s1.
    now += 1000;
    expect((await slice(await claim())).outcome).toBe('continued');
    expect(got).toEqual([
      ['s1', true],
      ['s2', true],
      ['s1', false],
    ]);
    expect(close.mock.calls).toEqual([['s2']]);
  });

  it('ctx.session: a payload schema that throws (on the stored payload or on the checkpoint) still closes the slice’s session', async () => {
    await put({ type: 'test.picky' });
    const opened: string[] = [];
    const open = () => {
      opened.push(`s${opened.length + 1}`);
      return Promise.resolve(opened.at(-1)!);
    };
    const close = vi.fn<(s: string) => Promise<void>>(() => Promise.resolve());
    impl = async (c, p) => {
      await c.session(open, close);
      return { continueWith: { k: p.k + 1 }, progress: 10 };
    };
    expect((await slice(await claim())).outcome).toBe('continued');
    expect(close).not.toHaveBeenCalled();
    // Slice 2 takes s1, then the schema throws on the stored payload {k: 2}: runSlice rejects, and s1 is closed.
    refineThrowsAt = 2;
    now += 1000;
    await expect(slice(await claim())).rejects.toThrow('refine blew up');
    expect(close.mock.calls).toEqual([['s1']]);
    // Another job: run() opens s2, then the schema throws on its checkpoint {k: 11}.
    await put({ type: 'test.picky', payload: { k: 10 } });
    refineThrowsAt = 11;
    now += 1000;
    await expect(slice(await claim())).rejects.toThrow('refine blew up');
    expect(close.mock.calls).toEqual([['s1'], ['s2']]);
  });

  it('pruneJobSessions: an idle session is closed once another process ran or ended its job, kept while nobody did', async () => {
    const a = await put();
    const b = await put({ payload: { k: 5 } });
    const close = vi.fn<(s: string) => Promise<void>>(() => Promise.resolve());
    impl = async (c, p) => {
      await c.session(() => Promise.resolve(`s-${c.jobId}`), close);
      now = T + 10;
      return { continueWith: { k: p.k + 1 }, progress: 10 };
    };
    const first = await claim();
    expect(first.id).toBe(a.id);
    await slice(first);
    // a is due again at T + 10, b since T.
    const second = await claim();
    expect(second.id).toBe(b.id);
    await slice(second);
    // Nothing happened to either job: both sessions stay, also while one is claimed again.
    await pruneJobSessions(h);
    expect(close).not.toHaveBeenCalled();
    const again = await claim();
    expect(again.id).toBe(a.id);
    await pruneJobSessions(h);
    expect(close).not.toHaveBeenCalled();
    // Another process finishes b; the next prune (here: the next slice of a) lets go of b's session only.
    await h.db.updateTable('jobs').set({ status: 'succeeded', updated_at: now + 5 }).where('id', '=', b.id).execute();
    impl = async (c, p) => {
      expect((await c.session(() => Promise.resolve('new'), close)).fresh).toBe(false);
      return { continueWith: { k: p.k + 1 }, progress: 20 };
    };
    expect((await slice(again)).outcome).toBe('continued');
    expect(close.mock.calls).toEqual([[`s-${b.id}`]]);
    // A job deleted meanwhile (retention) loses its session too.
    await h.db.deleteFrom('jobs').where('id', '=', a.id).execute();
    await pruneJobSessions(h);
    expect(close.mock.calls).toEqual([[`s-${b.id}`], [`s-${a.id}`]]);
  });

  it('ctx.audit writes in a transaction of its own as the system actor with meta.jobId', async () => {
    const { id } = await put();
    impl = async (c) => {
      await c.audit({ action: 'jobs.cancel', entity: 'jobs', entityId: c.jobId, meta: { note: 1 } });
      return { done: true };
    };
    await slice(await claim());
    const entries = await h.db.selectFrom('audit_log').select(['actor_type', 'actor_id', 'ip', 'action', 'entity_id', 'meta', 'at']).execute();
    expect(entries).toEqual([
      { actor_type: 'system', actor_id: null, ip: null, action: 'jobs.cancel', entity_id: id, meta: JSON.stringify({ jobId: id, note: 1 }), at: T },
    ]);
  });

  it('getJob and listJobs (keyset on id, newest first, filters)', async () => {
    const creator = newId();
    const a = await put({ createdBy: creator, secret: new Uint8Array([1]) });
    const b = await put();
    const c = await withTx(h, (trx) => enqueue(trx, reg, { type: 'test.origin', payload: { k: 2 } }, { now, keyring }));
    expect(await getJob(h.db, newId())).toBeNull();
    expect(await getJob(h.db, a.id)).toEqual({
      id: a.id,
      type: 'test.step',
      status: 'queued',
      payload: { k: 1 },
      hasSecret: true,
      runAt: T,
      attempts: 0,
      maxAttempts: 5,
      uniqueKey: null,
      lockedBy: null,
      lockedUntil: null,
      cancelRequested: false,
      pointOfNoReturn: false,
      progress: 0,
      progressMessage: null,
      lastError: null,
      createdBy: creator,
      createdAt: T,
      updatedAt: T,
      finishedAt: null,
    });
    const page1 = await listJobs(h.db, { limit: 2 });
    expect(page1.items.map((j) => j.id)).toEqual([c.id, b.id]);
    expect(page1.nextBefore).toBe(b.id);
    const page2 = await listJobs(h.db, { limit: 2, before: page1.nextBefore! });
    expect(page2).toMatchObject({ items: [{ id: a.id }], nextBefore: null });
    expect((await listJobs(h.db, { limit: 10, type: 'test.origin' })).items.map((j) => j.id)).toEqual([c.id]);
    expect((await listJobs(h.db, { limit: 10, createdBy: creator })).items.map((j) => j.id)).toEqual([a.id]);
    await slice(await claim());
    expect((await listJobs(h.db, { limit: 10, status: 'succeeded' })).items.map((j) => j.id)).toEqual([a.id]);
    await expect(listJobs(h.db, { limit: 0 })).rejects.toThrow(RangeError);
    await expect(listJobs(h.db, { limit: 10, status: 'nope' })).rejects.toThrow(TypeError);
  });

  it('A5: a child SIGKILLed after the effect of slice k = 4 and before its result; after the lease and backoff a second child finishes; exactly 10 effects', async () => {
    await ensureTable(h.db, h.dialect, 'test_job_effects', 'volatile', 'test', (t) => {
      t.ulid('job_id');
      t.int('k');
      t.timestamp('done_at');
      t.primaryKey(['job_id', 'k']);
    });
    // eslint-disable-next-line @typescript-eslint/no-explicit-any
    const effects = h.db as unknown as Kysely<any>;
    await effects.deleteFrom('test_job_effects').execute();
    const { id } = await withTx(h, (trx) =>
      enqueue(trx, createJobRegistry([{ ...step, type: 'test.effects' }]), { type: 'test.effects', payload: { k: 1 } }, { now: Date.now(), keyring }),
    );
    const base = { config: h.config, dataDir: h.dataDir, action: 'drain' };
    const env = { ...process.env };
    delete env['ALTIS_TEST_FAULT'];

    const [killed] = await runJobChildren<{ outcomes: string[] }>([{ ...base, worker: 'w1' }], {
      env: () => ({ ...env, ALTIS_TEST_FAULT: 'kill-mid-slice:4' }),
    });
    expect(killed).toMatchObject({ code: null, signal: 'SIGKILL', report: undefined });
    const ks = async () => (await effects.selectFrom('test_job_effects').select('k').where('job_id', '=', id).orderBy('k').execute()).map((r) => r.k as number);
    expect(await ks()).toEqual([1, 2, 3, 4]);
    expect(await row(id)).toMatchObject({ status: 'running', payload: '{"k":4}', attempts: 0 });

    // Past the 50 s lease and the 10 s backoff of attempts 0.
    const [second] = await runJobChildren<{ outcomes: string[] }>([{ ...base, worker: 'w2', clockOffsetMs: 61_000 }], { env: () => env });
    expect(second?.code).toBe(0);
    expect(second?.report?.outcomes).toEqual(['continued', 'continued', 'continued', 'continued', 'continued', 'continued', 'succeeded']);
    expect(await ks()).toEqual([1, 2, 3, 4, 5, 6, 7, 8, 9, 10]);
    expect(await row(id)).toMatchObject({ status: 'succeeded', attempts: 0 });
  });
});
