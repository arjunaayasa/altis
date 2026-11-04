// Child process for the job queue's db tests (jobs-claim, jobs-enqueue, jobs-slice), started through
// `node --import tsx`: a process of its own with its own DbHandle, so that two claimants really are two processes
// (SQLite serializes them through BEGIN IMMEDIATE, a server engine through its row locks), and so that a SIGKILL in
// the middle of a slice (ALTIS_TEST_FAULT=kill-mid-slice:<k>) kills a whole process, as Passenger or the OOM killer
// would (P7).
//
// Usage: job-child.mjs <optionsJson>, options {config, dataDir, action, worker, clockOffsetMs?, uniqueKey?}:
// - 'enqueue': enqueues a `test.light` job with `uniqueKey` in a transaction of its own; reports {id, existing};
// - 'claim': one claimNext(); reports {claimed: <id> | null} (the lease is left as it is);
// - 'drain': claimNext() then runSlice() until claimNext() finds nothing; reports {outcomes: [...]}.
// The clock is Date.now() + clockOffsetMs (default 0), so a child can stand past a lease and its backoff.
//
// Handlers: `test.light` ({} → done) and `test.effects` ({k} → upserts the row (job_id, k) of the test's
// `test_job_effects` table, then {continueWith: {k: k + 1}} until k = 10, then done).
//
// The child sends 'ready' over IPC and waits for 'go'; it sends its report and exits 0 (1 on any failure). It exits 2
// when its parent's IPC channel closes, so it never outlives its test.
import { connect, upsert, withTx } from '@altis/db';
import { z } from 'zod';
import { claimNext } from '../../src/jobs/claim.ts';
import { enqueue } from '../../src/jobs/enqueue.ts';
import { createJobRegistry } from '../../src/jobs/registry.ts';
import { runSlice } from '../../src/jobs/slice.ts';

// The sources are run unbundled: give their test hooks the test profile that Vitest defines for the parent.
globalThis.__BUILD_PROFILE__ = 'test';

const o = JSON.parse(process.argv[2]);
process.on('disconnect', () => process.exit(2));

const clock = () => Date.now() + (o.clockOffsetMs ?? 0);
const silent = { info() {}, warn() {}, error() {} };

const reg = createJobRegistry([
  {
    type: 'test.light',
    permission: 'system.jobs.manage',
    retryable: 'api',
    payload: z.strictObject({}),
    run: async () => ({ done: true }),
  },
  {
    type: 'test.effects',
    permission: 'system.jobs.manage',
    retryable: 'api',
    payload: z.strictObject({ k: z.number().int().min(1).max(10) }),
    async run(ctx, p) {
      await withTx(ctx.handle, (trx) =>
        upsert(trx, 'test_job_effects', { job_id: ctx.jobId, k: p.k }, { done_at: ctx.now() }, { done_at: ctx.now() }),
      );
      return p.k >= 10 ? { done: true } : { continueWith: { k: p.k + 1 }, progress: p.k * 10 };
    },
  },
]);

// The production shape on a server engine: Passenger workers, each with its small pool (P17). SQLite is refused on
// Passenger, so it runs standalone.
const runtime = o.config.dialect === 'sqlite' ? 'standalone' : 'passenger';
const h = await connect(o.config, { runtime, purpose: 'server', dataDir: o.dataDir });

async function run() {
  if (o.action === 'enqueue') {
    return withTx(h, (trx) => enqueue(trx, reg, { type: 'test.light', payload: {}, uniqueKey: o.uniqueKey }, { now: clock(), keyring: [] }));
  }
  if (o.action === 'claim') {
    const job = await claimNext(h, reg, { worker: o.worker, now: clock() });
    return { claimed: job === null ? null : job.id };
  }
  if (o.action === 'drain') {
    const outcomes = [];
    for (;;) {
      const job = await claimNext(h, reg, { worker: o.worker, now: clock() });
      if (job === null) return { outcomes };
      const r = await runSlice(h, reg, job, { mode: 'worker', budgetMs: 20_000, keyring: [], log: silent, clock, env: process.env });
      outcomes.push(r.outcome);
    }
  }
  throw new Error(`unknown action ${o.action}`);
}

process.on('message', (message) => {
  if (message !== 'go') return;
  run()
    .then((report) => new Promise((resolve) => process.send(report, resolve)))
    .finally(() => h.close())
    .then(
      () => process.exit(0),
      (error) => {
        console.error(error);
        process.exit(1);
      },
    );
});
process.send('ready');
