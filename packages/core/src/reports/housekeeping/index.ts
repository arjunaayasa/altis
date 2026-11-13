import { z } from 'zod';
import type { CatalogJobDeps } from '../../catalog/jobs-deps.js';
import type { HousekeepingStepContext } from '../../catalog/housekeeping.js';
import type { JobHandler, JobOutcome } from '../../jobs/types.js';
import { readClockAnomaly } from '../../scheduler/clock.js';
import { scheduleWindowSchema } from '../../scheduler/registry.js';
import { abandonedRunsStep } from './abandoned-runs.js';
import { expiredRunsStep } from './expired-runs.js';
import { orphanUploadsReportsStep } from './orphan-uploads.js';
import { reportFilesStep } from './report-files.js';
import { workDirsStep } from './work-dirs.js';

// `reports.housekeeping` (spec §4.15, §5.6): the reports' daily upkeep, scheduled at 03:50 (scheduler/registry.ts). It
// sweeps only `exports/reports/` and `tmp/reports/` (the catalogue's housekeeping never looks there, and this one never
// looks anywhere else) and the community upload contexts' orphans. One job runs the steps in a fixed order across
// slices, as `catalog.housekeeping` does: the payload is the schedule's window plus the checkpoint `{step, cursor}`,
// and a step answers `{done: true}` when it finished or `{done: false, cursor}` when its budget ran out.
//
// A step whose work depends on the age of something (`ageBased`) is skipped while `system.clock_anomaly` is set: with a
// wrong clock it could remove what is not old at all. A run that skipped one carries `postponed` in its checkpoint and
// ends with the job message `date_jobs_postponed`, which Diagnostik and the jobs page show.

/** The longest cursor a step may return (the checkpoint is a job payload and stays small). */
export const REPORTS_HOUSEKEEPING_CURSOR_MAX = 1024;

/** The highest step index a checkpoint may name (far above the steps; later milestones append some). */
const STEP_INDEX_MAX = 63;

/** Below this much budget left, no further step starts in this slice (the first one always runs: a slice progresses). */
const STEP_MARGIN_MS = 2000;

/** The job message of a run that skipped an age-based step because the clock looked wrong. */
export const DATE_JOBS_POSTPONED = 'date_jobs_postponed';

/** The payload: the schedule window, and the checkpoint of a job that continues. */
export const reportsHousekeepingPayload = scheduleWindowSchema.extend({
  step: z.int().min(0).max(STEP_INDEX_MAX).optional(),
  cursor: z.string().max(REPORTS_HOUSEKEEPING_CURSOR_MAX).nullable().optional(),
  /** An age-based step was skipped in an earlier slice of this run. */
  postponed: z.literal(true).optional(),
});

export type ReportsHousekeepingPayload = z.infer<typeof reportsHousekeepingPayload>;

/** One step of `reports.housekeeping`. `ageBased`: skipped while the clock looks wrong. */
export interface ReportsHousekeepingStep {
  /** Lower-case name, for logs. */
  name: string;
  ageBased: boolean;
  run(c: HousekeepingStepContext): Promise<{ done: boolean; cursor: string | null }>;
}

/**
 * The steps, in the order they run; append-only (a later milestone appends its own). Abandoned runs are ended first, so
 * the work-folder step sweeps their folders in the same pass.
 */
export const REPORTS_HOUSEKEEPING_STEPS: readonly ReportsHousekeepingStep[] = Object.freeze([
  // ---- Komunitas K1 (reports) ----
  abandonedRunsStep,
  expiredRunsStep,
  reportFilesStep,
  workDirsStep,
  orphanUploadsReportsStep,
]);

/** No step of this job queues a job. */
async function enqueueNothing(type: string): Promise<void> {
  throw new TypeError(`reports.housekeeping: a step may not queue ${JSON.stringify(type)}`);
}

/**
 * The `reports.housekeeping` handler (see the top of this file): permission `system.jobs.manage` (its schedule's),
 * retryable from the API.
 *
 * @param steps the steps to run, in order; default {@link REPORTS_HOUSEKEEPING_STEPS} (tests pass their own)
 */
export function reportsHousekeepingJob(
  deps: () => CatalogJobDeps,
  steps: readonly ReportsHousekeepingStep[] = REPORTS_HOUSEKEEPING_STEPS,
): JobHandler<ReportsHousekeepingPayload> {
  return {
    type: 'reports.housekeeping',
    permission: 'system.jobs.manage',
    retryable: 'api',
    payload: reportsHousekeepingPayload,
    async run(ctx, p): Promise<JobOutcome<ReportsHousekeepingPayload>> {
      const window = { windowStart: p.windowStart, windowEnd: p.windowEnd };
      const progress = (index: number): number => (steps.length === 0 ? 100 : Math.floor((100 * index) / steps.length));
      const d = deps();
      const clockWrong = (await readClockAnomaly(ctx.db)) !== null;
      let postponed = p.postponed === true;
      let index = p.step ?? 0;
      let cursor = p.cursor ?? null;
      let ran = false;
      const checkpoint = (step: number, at: string | null): ReportsHousekeepingPayload => ({
        ...window,
        step,
        cursor: at,
        ...(postponed ? { postponed: true as const } : {}),
      });
      while (index < steps.length) {
        // Another step only while the budget lasts and no cancel is pending; the first one of a slice always runs.
        if (ran && (ctx.budgetLeftMs() < STEP_MARGIN_MS || ctx.cancelled())) {
          return { continueWith: checkpoint(index, cursor), progress: progress(index) };
        }
        const step = steps[index]!;
        if (step.ageBased && clockWrong) {
          ctx.log.info('reports.housekeeping: an age-based step is skipped while the clock looks wrong', { jobId: ctx.jobId, step: step.name });
          postponed = true;
          index += 1;
          cursor = null;
          continue;
        }
        const r = await step.run({
          h: ctx.handle,
          now: ctx.now(),
          deps: d,
          cursor,
          budgetLeftMs: () => ctx.budgetLeftMs(),
          enqueue: enqueueNothing,
        });
        ran = true;
        if (!r.done) {
          if (r.cursor !== null && (typeof r.cursor !== 'string' || r.cursor.length > REPORTS_HOUSEKEEPING_CURSOR_MAX)) {
            throw new TypeError(
              `reports.housekeeping: step ${step.name} returned a cursor that is not a string of at most ${REPORTS_HOUSEKEEPING_CURSOR_MAX} characters`,
            );
          }
          return { continueWith: checkpoint(index, r.cursor), progress: progress(index) };
        }
        index += 1;
        cursor = null;
        await ctx.heartbeat({ progress: progress(index) });
      }
      return postponed ? { done: true, message: DATE_JOBS_POSTPONED } : { done: true };
    },
  };
}
