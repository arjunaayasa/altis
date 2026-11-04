// Child process for catalog-import-resume.test.ts (Phase 2 Task 31, S21), started through `node --import tsx`: a process
// of its own with its own DbHandle, so that the test can SIGKILL it in the middle of an import slice, as Passenger or
// the OOM killer would (P7). (1c's `kill-mid-slice` fault keys on a test-job payload field, so it cannot target this
// job.)
//
// Usage: import-child.mjs <optionsJson>, options {config, dbDataDir, dataDir, jobId, now, pauseMs}. Opens the test
// database (`dbDataDir` holds the SQLite file), sends 'ready' over IPC and waits for 'go'. Then it claims job `jobId`
// and runs its slices (20 s budgets, the clock fixed at `now`) until the job stops continuing, pausing `pauseMs` after
// every heartbeat (the import beats once per batch of 200), so the test sees the run's counters move and can kill it
// between two batches. It sends {outcomes} and exits 0, or {error} and exits 1; it exits 2 when its parent's IPC channel
// closes, so it never outlives its test.
import { connect } from '@altis/db';
import { importJob } from '../../src/catalog/exchange/import-job.ts';
import { localStorageDriver } from '../../src/files/serve.ts';
import { claimById } from '../../src/jobs/claim.ts';
import { createJobRegistry } from '../../src/jobs/registry.ts';
import { runSlice } from '../../src/jobs/slice.ts';

// The sources are run unbundled: give their test hooks the test profile that Vitest defines for the parent.
globalThis.__BUILD_PROFILE__ = 'test';

const o = JSON.parse(process.argv[2]);
process.on('disconnect', () => process.exit(2));

const silent = { info() {}, warn() {}, error() {} };
const deps = () => ({ dataDir: o.dataDir, baseUrl: 'https://perpus.example.sch.id', keyring: [], storage: localStorageDriver(o.dataDir), log: silent });
const handler = importJob(deps);
const reg = createJobRegistry([
  {
    ...handler,
    run: (ctx, payload) =>
      handler.run(
        {
          ...ctx,
          heartbeat: async (beat) => {
            await ctx.heartbeat(beat);
            await new Promise((resolve) => setTimeout(resolve, o.pauseMs));
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
    const job = await claimById(h, reg, o.jobId, { worker: 'child', now: o.now });
    if (job === null) return { outcomes };
    const r = await runSlice(h, reg, job, { mode: 'worker', budgetMs: 20_000, keyring: [], log: silent, clock: () => o.now, env: process.env });
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
