import { SLICE_BUDGET_MS, createSettingsCache, writeCronSeen, type EditionService, type OpStatus } from '@altis/core';
import { connect, type DbHandle } from '@altis/db';
import type { Env } from '@altis/platform';
import type { OpKind } from '@altis/shared';
import type { AppState } from '../app.js';
import { loadConfig } from '../config.js';
import type { BootContext } from '../index.js';
import { createJobRuntime, jobHandlers, jobWorkerName, opKinds, testClockOffsetMs, updateRestoreRunner } from '../jobs/runtime.js';
import { createLogger } from '../logger.js';
import { appUpdateKindDeps, createAppEdition, createAppOps, createAppUpdateSource, jobMailer } from '../services.js';
import { withoutTestKinds } from './ops.js';

// `node app.js jobs:run [--budget <seconds>]` (spec §10.2, §10.3, §13.6): the cron line's main path, no token needed
// (whoever can run app.js owns the installation).
//
// - Before the install completes (no config.json, or its installState is not `complete`): `tmp/cron-seen.json` is
//   written, so the wizard's scheduler test (Task 27) sees the line work, and the command ends with exit 0.
// - Otherwise passes of ≤ 20 s (the op first, then the scheduler, then up to two light slices and one heavy) until
//   the budget (default 270 s, for a line every 5 minutes) is spent or a pass finds nothing to do; a `longRunning` job
//   runs to its end with one session, past the budget (C38). It runs on its own (R1c-7): while it does, the passes go
//   on within the budget (light jobs, the op, the run record), one every 5 s at most when they find nothing, and once
//   the budget is spent the command waits for that job to end. Each pass records `system.run.cron_cli` (at most once a
//   minute). Warnings go to the server log (DATA_DIR/logs/altis.log), never to the command's output.
// - The op is stepped with every kind of this release, `update` and `rollback` included (review C11; spec §9.4: an op
//   resumes "oleh siapa saja dan kapan saja: drive, worker, cron (URL/CLI)", §9.6 step 5: the cron goes on with an
//   update whose page was closed), as `ops:resume` steps it: over one edition and feed client of this command
//   (the update check's too), and with the SQLite swap of a restore (the update's revert included) over this
//   command's own handles. An op this command cannot move (one that needs attention, or of a kind this release does
//   not know, which the machine leaves alone with a warning) is no reason to pass again: unless jobs ran, the run ends.
// - The test hook ALTIS_TEST_CLOCK_OFFSET_MS (test profile only, M23) moves the clock of the claims and slices, and
//   ALTIS_TEST_CLI_OP_KINDS_WITHOUT (cli/ops.ts) leaves kinds out of the command's machine.

/** What one run did; `installed: false` before the install completes. */
export type JobsRunResult = { installed: false } | { installed: true; passes: number; slices: number };

/** An op still in progress whose step did nothing waits this long before the next pass (no busy loop). */
const OP_WAIT_MS = 1000;
/** While a `longRunning` job runs on its own (R1c-7), a pass that found nothing waits this long, or until it ends. */
const LONG_WAIT_MS = 5000;

/** Waits `ms`, or less when `until` settles first (a timer left behind would hold the command up). */
async function pause(ms: number, until: Promise<void> | null): Promise<void> {
  let timer: NodeJS.Timeout | undefined;
  const elapsed = new Promise<void>((resolve) => {
    timer = setTimeout(resolve, Math.max(0, ms));
  });
  await (until === null ? elapsed : Promise.race([elapsed, until]));
  clearTimeout(timer);
}

/**
 * Runs the job queue of `ctx.dataDir` for up to `budgetS` seconds (see the top of this file). Everything it opens (the
 * database, op connections, job sessions) is closed before it returns.
 *
 * @throws what loadConfig and connect throw (INVALID_CONFIG, DB_UNAVAILABLE, ...)
 */
export async function jobsRun(ctx: BootContext, env: Env, o: { budgetS: number }): Promise<JobsRunResult> {
  const offset = testClockOffsetMs(env);
  const clock = (): number => Date.now() + offset;
  const config = await loadConfig(ctx.dataDir, env);
  if (config === null || config.installState !== 'complete') {
    await writeCronSeen(ctx.dataDir, 'cron_cli', clock());
    return { installed: false };
  }
  const log = createLogger({ dataDir: ctx.dataDir, level: config.log.level }).child({ command: 'jobs:run' });
  const open = (): Promise<DbHandle> => connect(config.db, { runtime: ctx.runtime, purpose: 'cli', dataDir: ctx.dataDir });
  const state: AppState = { phase: 'ready', db: await open(), config };
  // 1c Task 25 (C17), review C11: what this process holds on a SQLite file, let go of for a restore's swap (the update's
  // revert included) and opened again after it, as `ops:resume` does.
  let released = false;
  const own = {
    async close(): Promise<void> {
      await ops.close();
      const h = state.db;
      state.db = undefined;
      if (h === undefined) return;
      released = true;
      await h.close();
    },
    async reopen(): Promise<void> {
      if (!released || state.db !== undefined) return;
      state.db = await open();
      released = false;
    },
  };
  const sqlite = { log, own };
  // 1d Task 28: the update check's feed client, made as the server makes its own (the edition takes the feed's signed
  // time), once and only when a check runs. Review C11: the update kind shares it and the edition.
  const where = { dataDir: ctx.dataDir, appRoot: ctx.appRoot, releaseDir: ctx.release.dir, clock, log };
  let edition: EditionService | undefined;
  const editionService = (): EditionService => (edition ??= createAppEdition(state, { clock, log }));
  let source: ReturnType<typeof createAppUpdateSource> | undefined;
  const updateSource = (): ReturnType<typeof createAppUpdateSource> =>
    (source ??= createAppUpdateSource(state, { ...where, env, edition: editionService }));
  // Review C11 (preflight S6): the update and rollback kinds, as every other machine of this release has them.
  const update = appUpdateKindDeps(state, {
    ...where,
    version: ctx.release.version,
    env,
    edition: editionService,
    source: updateSource,
    restore: updateRestoreRunner({ appVersion: ctx.release.version, config: () => state.config, dataDir: ctx.dataDir, sqlite }),
    requestRestart: (reason) => ctx.requestRestart(reason),
  });
  const kinds = withoutTestKinds(
    env,
    opKinds({ appVersion: ctx.release.version, config: () => state.config, dataDir: ctx.dataDir, sqlite, update }),
  );
  const steppable = new Set<OpKind>(kinds.map((k) => k.kind));
  const ops = createAppOps(state, { dataDir: ctx.dataDir, version: ctx.release.version, log, clock, runtime: ctx.runtime, kinds });
  const runtime = createJobRuntime({
    state,
    runtime: ctx.runtime,
    env,
    dataDir: ctx.dataDir,
    log,
    clock,
    ops,
    // 1c Task 23 (Diagnostik) and 1c Task 18 (housekeeping and mail; on cPanel this command may be the only runner).
    handlers: jobHandlers({
      diagnostics: { dataDir: ctx.dataDir, appRoot: ctx.appRoot, baseUrl: () => config.baseUrl },
      housekeeping: {
        dataDir: ctx.dataDir,
        mailer: jobMailer(state),
        baseUrl: () => config.baseUrl,
        settings: createSettingsCache({ clock }),
      },
      updateCheck: { source: updateSource }, // 1d Task 28
    }),
    requestRestart: ctx.requestRestart,
    installId: config.install.id,
    appVersion: ctx.release.version,
    worker: jobWorkerName('cli'),
  });
  /** Whether another pass may move `op` (review C11): not one that needs attention, nor of a kind this release lacks. */
  const movable = (op: OpStatus | null): boolean =>
    op !== null && !op.terminal && !op.needsAttention && op.kind !== null && steppable.has(op.kind);
  let passes = 0;
  let slices = 0;
  try {
    const deadline = clock() + o.budgetS * 1000;
    for (let left = deadline - clock(); left > 0; left = deadline - clock()) {
      const report = await runtime.cron('cron_cli', Math.min(SLICE_BUDGET_MS, left));
      passes += 1;
      slices += report.slices;
      const opRunning = movable(report.op);
      if (report.slices > 0) continue;
      const long = runtime.longJob();
      if (!opRunning && long === null) break;
      await pause(Math.min(opRunning ? OP_WAIT_MS : LONG_WAIT_MS, deadline - clock()), long);
    }
    // C38: a longRunning job runs to its end, past the budget.
    for (let long = runtime.longJob(); long !== null; long = runtime.longJob()) await long;
    slices += runtime.longJobSlices();
  } finally {
    await runtime.stop();
    await state.db?.close();
  }
  return { installed: true, passes, slices };
}

/** The human line for a run (bilingual; the command name first, so scripts can match it). */
export function describeJobsRun(result: JobsRunResult): string {
  if (!result.installed) {
    return 'jobs:run: ALTIS belum terpasang / not installed yet; panggilan penjadwal dicatat / the scheduler call was recorded';
  }
  return `jobs:run: ${result.passes} lintasan, ${result.slices} potongan / ${result.passes} pass(es), ${result.slices} slice(s)`;
}
