import { withTx, type DbHandle } from '@altis/db';
import { z } from 'zod';
import { txCtx, type Actor } from '../context.js';
import type { JobHandler, JobOutcome } from '../jobs/types.js';
import { readClockAnomaly } from '../scheduler/clock.js';
import { scheduleWindowSchema } from '../scheduler/registry.js';
import { dueHoldIds, expireHold } from './holds.js';

// `circulation.holds` (every 15 minutes, scheduler/registry.ts): holds not picked up by their deadline expire and their
// copy is kept for the next in the queue (or listed to go back to the shelf), and waiting holds past their own end
// date expire. One transaction per hold (holds.ts expireHold: the hold, its copy, its record and its member locked
// first, the write conditional on the status read), in slices within the job's budget.
//
// The job does nothing while `system.clock_anomaly` is set: a clock that jumped ahead would expire the whole hold
// shelf. Such a run ends with the job message `date_jobs_postponed`. A run that expired anything writes one audit
// entry `circulation.holds.run` with its counts (a run with nothing to do writes none, so the log does not fill with
// empty runs every 15 minutes).

/** The holds a slice reads at a time. */
const BATCH = 100;

/** Below this much budget left, no further hold starts in this slice (the first one always runs). */
const MARGIN_MS = 1000;

/** The job message of a run skipped because the clock looked wrong. */
const POSTPONED = 'date_jobs_postponed';

const SYSTEM: Actor = { type: 'system', id: null, ip: null };

const counts = z.strictObject({
  expiredPickup: z.int().min(0),
  expiredWait: z.int().min(0),
  keptForNext: z.int().min(0),
});

/** The payload: the schedule window and, in a continuing job, the counts so far. */
export const holdsJobPayload = scheduleWindowSchema.extend({ counts: counts.optional() });

export type HoldsJobPayload = z.infer<typeof holdsJobPayload>;

export type HoldsRunCounts = z.infer<typeof counts>;

/**
 * Expires the holds due at `now` on `h` while `budgetLeftMs` allows; the counts and whether more are due.
 */
export async function runHoldExpiry(h: DbHandle, now: number, budgetLeftMs: () => number = () => Number.POSITIVE_INFINITY): Promise<HoldsRunCounts & { more: boolean }> {
  const out: HoldsRunCounts = { expiredPickup: 0, expiredWait: 0, keptForNext: 0 };
  const ids = await dueHoldIds(h.db, now, BATCH);
  let done = 0;
  for (const id of ids) {
    if (done > 0 && budgetLeftMs() < MARGIN_MS) break;
    const r = await withTx(h, (trx) => expireHold(txCtx(trx, now, SYSTEM), id));
    done += 1;
    if (r === null) continue;
    if (r.kind === 'pickup') out.expiredPickup += 1;
    else out.expiredWait += 1;
    if (r.keptForNext) out.keptForNext += 1;
  }
  return { ...out, more: done < ids.length || ids.length === BATCH };
}

/** The `circulation.holds` handler: permission `system.jobs.manage` (its schedule's), retryable from the API. */
export function holdsExpiryJob(): JobHandler<HoldsJobPayload> {
  return {
    type: 'circulation.holds',
    permission: 'system.jobs.manage',
    retryable: 'api',
    payload: holdsJobPayload,
    async run(ctx, p): Promise<JobOutcome<HoldsJobPayload>> {
      if ((await readClockAnomaly(ctx.db)) !== null) {
        ctx.log.info('circulation.holds: skipped while the clock looks wrong', { jobId: ctx.jobId });
        return { done: true, message: POSTPONED };
      }
      const r = await runHoldExpiry(ctx.handle, ctx.now(), () => ctx.budgetLeftMs());
      const total: HoldsRunCounts = {
        expiredPickup: (p.counts?.expiredPickup ?? 0) + r.expiredPickup,
        expiredWait: (p.counts?.expiredWait ?? 0) + r.expiredWait,
        keptForNext: (p.counts?.keptForNext ?? 0) + r.keptForNext,
      };
      if (r.more && !ctx.cancelled()) {
        return { continueWith: { windowStart: p.windowStart, windowEnd: p.windowEnd, counts: total }, progress: 50 };
      }
      if (total.expiredPickup + total.expiredWait > 0) {
        await ctx.audit({ action: 'circulation.holds.run', entity: null, entityId: null, meta: { ...total } });
      }
      return { done: true };
    },
  };
}
