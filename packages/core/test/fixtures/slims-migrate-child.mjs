// Child process for slims-end-to-end.test.ts (Phase 2 Task 39, K15), started through `node --import tsx`: a process of
// its own with its own DbHandle, so that the test can SIGKILL it in the middle of a SLiMS migration, as Passenger or
// the OOM killer would (P7).
//
// Usage: slims-migrate-child.mjs <optionsJson>, options {config, dbDataDir, dataDir, jobId, now, batch, pauseStage,
// pauseMs}. Opens the test database (`dbDataDir` holds the SQLite file), sends 'ready' over IPC and waits for 'go'.
// Then it claims job `jobId` and runs its slices until the job stops continuing: the stages read `batch` rows per batch
// (both stage kits' test hooks), the split and analyze slices get 20 s and every other slice 2 s, the framework's save
// margin, so a slice runs one batch (or one file) of one stage. After a batch of the stage `pauseStage` committed, the
// slice's last heartbeat (the one just before the framework saves the counters and the checkpoint) waits `pauseMs`: the
// test kills the process there, so the batch's rows are stored and their counts are not. The clock stands at `now`.
// It sends {outcomes} and exits 0, or {error} and exits 1; it exits 2 when its parent's IPC channel closes, so it never
// outlives its test.
import { connect } from '@altis/db';
import { localStorageDriver } from '../../src/files/serve.ts';
import { claimById } from '../../src/jobs/claim.ts';
import { createJobRegistry } from '../../src/jobs/registry.ts';
import { runSlice } from '../../src/jobs/slice.ts';
import { slimsJobs } from '../../src/migration/slims/jobs.ts';
import { __setSlimsStageBatch } from '../../src/migration/slims/stages/stage-a-kit.ts';
import { __setSlimsStageBBatch } from '../../src/migration/slims/stages/stage-b-kit.ts';

// The sources are run unbundled: give their test hooks the test profile that Vitest defines for the parent.
globalThis.__BUILD_PROFILE__ = 'test';

const o = JSON.parse(process.argv[2]);
process.on('disconnect', () => process.exit(2));

const STAGES = new Set(['split', 'analyze', 'masters', 'records', 'relations', 'items', 'attachments', 'covers', 'content', 'archive', 'report']);
const silent = { info() {}, warn() {}, error() {} };
const sleep = (ms) => new Promise((resolve) => setTimeout(resolve, ms));
__setSlimsStageBatch(o.batch);
__setSlimsStageBBatch(o.batch);

const deps = () => ({ dataDir: o.dataDir, baseUrl: 'https://perpus.example.sch.id/', keyring: [], storage: localStorageDriver(o.dataDir), log: silent });
const [handler] = slimsJobs(deps);
/** The stage the framework named in its last heartbeat. */
let stage = null;
const reg = createJobRegistry([
  {
    ...handler,
    run: (ctx, payload) =>
      handler.run(
        {
          ...ctx,
          heartbeat: async (beat) => {
            if (beat !== undefined && STAGES.has(beat.message)) stage = beat.message;
            await ctx.heartbeat(beat);
            // The heartbeat without a beat is the one of the framework's save, after the slice's work committed.
            if (beat === undefined && stage === o.pauseStage) await sleep(o.pauseMs);
          },
        },
        payload,
      ),
  },
]);

const runtime = o.config.dialect === 'sqlite' ? 'standalone' : 'passenger';
const h = await connect(o.config, { runtime, purpose: 'server', dataDir: o.dbDataDir });

async function run() {
  const outcomes = [];
  for (;;) {
    const row = await h.db.selectFrom('jobs').select('payload').where('id', '=', o.jobId).executeTakeFirst();
    const at = row === undefined ? 0 : JSON.parse(row.payload).stage;
    const job = await claimById(h, reg, o.jobId, { worker: 'child', now: o.now });
    if (job === null) return { outcomes };
    const r = await runSlice(h, reg, job, { mode: 'worker', budgetMs: at < 2 ? 20_000 : 2_000, keyring: [], log: silent, clock: () => o.now, env: process.env });
    outcomes.push(r.outcome);
    if (r.outcome !== 'continued') return { outcomes };
  }
}

process.on('message', (message) => {
  if (message !== 'go') return;
  run()
    .then(
      (report) => new Promise((resolve) => process.send(report, () => resolve(0))),
      (error) => new Promise((resolve) => process.send({ error: String(error?.code ?? error?.name) }, () => resolve(1))),
    )
    .then(async (code) => {
      await h.close();
      process.exit(code);
    });
});
process.send('ready');
