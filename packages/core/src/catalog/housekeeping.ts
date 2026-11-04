import { withTx, type DbHandle } from '@altis/db';
import { z } from 'zod';
import { enqueue } from '../jobs/enqueue.js';
import { createJobRegistry } from '../jobs/registry.js';
import type { JobContext, JobHandler, JobOutcome, JobRegistry } from '../jobs/types.js';
import { slimsJobs } from '../migration/slims/jobs.js';
import { scheduleWindowSchema } from '../scheduler/registry.js';
import { searchHousekeepingStep } from '../search/housekeeping.js';
import { searchJobs } from '../search/jobs.js';
import { orphanUploadsStep } from './attachments/housekeeping.js';
import { exchangeJobs } from './exchange/jobs.js';
import type { CatalogJobDeps } from './jobs-deps.js';
import { expiredExportsStep } from './runs/housekeeping.js';
import { catalogRunJobs } from './runs/jobs.js';

// `catalog.housekeeping` (spec §12.6, decision P2-28; Phase 2 Task 3): the catalog's daily upkeep, scheduled at 03:40
// (scheduler/registry.ts). One job runs the catalog's owned steps in a fixed order, across slices:
//
//   search           Task 15  queue a reindex when the index is missing, else refresh `search_term`
//   orphan_uploads   Task 18  covers, attachments, floor plans and page images no one claimed within 24 h
//   expired_exports  Task 19  export files and finished runs' work folders older than 7 days
//
// The payload is the schedule's window plus the checkpoint `{step, cursor}`: the index of the step that runs next, and
// the cursor that step returned when it stopped. A step returns `{done: true}` when it finished (the next step starts
// with a null cursor, in the same slice while the budget lasts) or `{done: false, cursor}` when its budget ran out: the
// slice then ends, and the next slice (in whichever process claims the job, P7) hands that step its cursor. Every step
// is idempotent and bounded by `budgetLeftMs()`, so a slice killed anywhere simply runs that step again.

/** The longest cursor a step may return: the checkpoint is a job payload and stays small (R1c-6). */
export const CATALOG_HOUSEKEEPING_CURSOR_MAX = 1024;

/** The highest step index a checkpoint may name (far above the three steps; an update may add some). */
const STEP_INDEX_MAX = 63;

/** Below this much budget left, no further step starts in this slice (the first one always runs: a slice progresses). */
const STEP_MARGIN_MS = 2000;

/** The payload: the schedule window, and the checkpoint of a job that continues. */
export const catalogHousekeepingPayload = scheduleWindowSchema.extend({
  step: z.int().min(0).max(STEP_INDEX_MAX).optional(),
  cursor: z.string().max(CATALOG_HOUSEKEEPING_CURSOR_MAX).nullable().optional(),
});

export type CatalogHousekeepingPayload = z.infer<typeof catalogHousekeepingPayload>;

/** What a step gets for one run. */
export interface HousekeepingStepContext {
  /** The database handle. A step opens its own short transactions (`withTx`), never one around enqueue. */
  h: DbHandle;
  /** The slice's clock (epoch ms). */
  now: number;
  deps: CatalogJobDeps;
  /** Where the step stopped in an earlier slice; null on its first run of this job. */
  cursor: string | null;
  /** Milliseconds left of the slice's budget: a step returns `{done: false, cursor}` before it reaches 0. */
  budgetLeftMs(): number;
  /**
   * Queues a catalog job (`catalog.reindex`, ...) in a transaction of its own, by the system (no `created_by`); with a
   * `uniqueKey`, a live job holding it is joined. Never call it inside a `withTx` of the step's own (R49).
   *
   * @throws TypeError for a type that is not a catalog job; DomainError `VALIDATION_FAILED` for a payload its schema
   *   refuses
   */
  enqueue(type: string, payload: unknown, uniqueKey: string | null): Promise<void>;
}

/** One step of `catalog.housekeeping`. */
export interface CatalogHousekeepingStep {
  /** Lower-case name, for logs. */
  name: string;
  run(c: HousekeepingStepContext): Promise<{ done: boolean; cursor: string | null }>;
}

/** The catalog's housekeeping steps, in the order they run (each owned by its task; see the top of this file). */
export const CATALOG_HOUSEKEEPING_STEPS: readonly CatalogHousekeepingStep[] = Object.freeze([
  searchHousekeepingStep,
  orphanUploadsStep,
  expiredExportsStep,
]);

/** The catalog job types a step may queue (every catalog job but this one), checked against their payload schemas. */
function catalogJobRegistry(deps: () => CatalogJobDeps): JobRegistry {
  return createJobRegistry([...searchJobs(deps), ...catalogRunJobs(deps), ...exchangeJobs(deps), ...slimsJobs(deps)]);
}

/**
 * The `catalog.housekeeping` handler (see the top of this file): permission `system.jobs.manage` (its schedule's),
 * retryable from the API.
 *
 * @param steps the steps to run, in order; default {@link CATALOG_HOUSEKEEPING_STEPS} (tests pass their own)
 */
export function catalogHousekeepingJob(
  deps: () => CatalogJobDeps,
  steps: readonly CatalogHousekeepingStep[] = CATALOG_HOUSEKEEPING_STEPS,
): JobHandler<CatalogHousekeepingPayload> {
  let registry: JobRegistry | undefined;
  const enqueueFrom =
    (ctx: JobContext, d: CatalogJobDeps) =>
    async (type: string, payload: unknown, uniqueKey: string | null): Promise<void> => {
      registry ??= catalogJobRegistry(deps);
      const reg = registry;
      if (reg.get(type) === undefined) throw new TypeError(`catalog.housekeeping: ${JSON.stringify(type)} is not a catalog job`);
      await withTx(ctx.handle, (trx) =>
        enqueue(trx, reg, { type, payload, createdBy: null, ...(uniqueKey === null ? {} : { uniqueKey }) }, { now: ctx.now(), keyring: d.keyring }),
      );
    };

  return {
    type: 'catalog.housekeeping',
    permission: 'system.jobs.manage',
    retryable: 'api',
    payload: catalogHousekeepingPayload,
    async run(ctx, p): Promise<JobOutcome<CatalogHousekeepingPayload>> {
      const window = { windowStart: p.windowStart, windowEnd: p.windowEnd };
      const progress = (index: number): number => (steps.length === 0 ? 100 : Math.floor((100 * index) / steps.length));
      const d = deps();
      const enqueueJob = enqueueFrom(ctx, d);
      let index = p.step ?? 0;
      let cursor = p.cursor ?? null;
      let ran = false;
      while (index < steps.length) {
        // Another step only while the budget lasts and no cancel is pending; the first one of a slice always runs.
        if (ran && (ctx.budgetLeftMs() < STEP_MARGIN_MS || ctx.cancelled())) {
          return { continueWith: { ...window, step: index, cursor }, progress: progress(index) };
        }
        const step = steps[index]!;
        const r = await step.run({
          h: ctx.handle,
          now: ctx.now(),
          deps: d,
          cursor,
          budgetLeftMs: () => ctx.budgetLeftMs(),
          enqueue: enqueueJob,
        });
        ran = true;
        if (!r.done) {
          if (r.cursor !== null && (typeof r.cursor !== 'string' || r.cursor.length > CATALOG_HOUSEKEEPING_CURSOR_MAX)) {
            throw new TypeError(`catalog.housekeeping: step ${step.name} returned a cursor that is not a string of at most ${CATALOG_HOUSEKEEPING_CURSOR_MAX} characters`);
          }
          return { continueWith: { ...window, step: index, cursor: r.cursor }, progress: progress(index) };
        }
        index += 1;
        cursor = null;
        await ctx.heartbeat({ progress: progress(index) });
      }
      return { done: true };
    },
  };
}
