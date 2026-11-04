import type { Permission } from '@altis/shared';
import { z } from 'zod';
import { purgeEvents } from '../events/retention.js';
import type { JobContext, JobHandler, JobOutcome } from '../jobs/types.js';
import { readClockAnomaly } from '../scheduler/clock.js';
import { scheduleWindowSchema, type ScheduleWindow } from '../scheduler/registry.js';
import { anchorAudit, auditPointSchema } from './audit-anchor.js';
import { auditPurgeCheckpointSchema, purgeAudit, startAuditPurge } from './audit-retention.js';
import { cleanFiles, filesCheckpointSchema } from './files.js';
import { purgeJobs } from './jobs.js';
import { purgeNotifications } from './notifications.js';
import { purgeVolatile } from './volatile.js';

// The housekeeping job handlers (Task 18; spec §10.4's scheduled retention, decision D19 of 1b replaced): one handler
// per job type of the schedules in scheduler/registry.ts, each with its schedule's permission, its payload the
// schedule's window (S16; the two that continue across slices add an optional checkpoint to it).
//
// - Every purge (`housekeeping.*`, `audit.retention`) ends `{done: true}` without deleting anything while
//   `system.clock_anomaly` is set (§10.4: age-based purges are skipped while the clock looks wrong). `audit.anchor`
//   deletes nothing and runs regardless.
// - Each slice stops starting new batches (or items) once its budget is nearly spent and continues with a checkpoint
//   (P9, preflight B5): the database purges by their own order (they simply run again from the window), the files
//   cleanup and the audit retention by an explicit checkpoint in the payload.
// - All are idempotent: a slice killed anywhere is simply run again (P7).

/** What the housekeeping handlers are built with. */
export interface HousekeepingDeps {
  dataDir: string;
}

/** The part of a slice's budget kept back for the batch that is running when it is checked. */
const BUDGET_MARGIN_MS = 2000;

/** A `Date.now()` reading after which a slice starts no new batch. */
function deadlineOf(ctx: JobContext): number {
  return Date.now() + Math.max(0, ctx.budgetLeftMs() - BUDGET_MARGIN_MS);
}

/** The same deadline as a `performance.now()` reading (verifyAuditChain's clock). */
function monotonicDeadlineOf(ctx: JobContext): number {
  return performance.now() + Math.max(0, ctx.budgetLeftMs() - BUDGET_MARGIN_MS);
}

/** True (and noted) while `clock_anomaly` is active: purges are skipped. */
async function purgesPaused(ctx: JobContext): Promise<boolean> {
  if ((await readClockAnomaly(ctx.db)) === null) return false;
  ctx.log.info('housekeeping: skipped while the clock looks wrong (clock_anomaly)', { jobId: ctx.jobId });
  return true;
}

/** Logs what a purge deleted, when it deleted anything. */
function noted(ctx: JobContext, what: string, deleted: Record<string, number> | number): void {
  const any = typeof deleted === 'number' ? deleted > 0 : Object.values(deleted).some((n) => n > 0);
  if (any) ctx.log.info(`housekeeping: ${what}`, { jobId: ctx.jobId, deleted });
}

const windowPayload: z.ZodType<ScheduleWindow> = scheduleWindowSchema;
const filesPayload = scheduleWindowSchema.extend({ files: filesCheckpointSchema.optional() });
type FilesPayload = z.infer<typeof filesPayload>;
const auditPurgePayload = scheduleWindowSchema.extend({ purge: auditPurgeCheckpointSchema.optional() });
type AuditPurgePayload = z.infer<typeof auditPurgePayload>;
/** The anchor run's checkpoint (1d): the last entry its walk verified, and that walk; both or neither. */
const auditAnchorPayload = scheduleWindowSchema
  .extend({ from: auditPointSchema.optional(), walk: z.enum(['verified', 'anchor']).optional() })
  .refine((p) => (p.from === undefined) === (p.walk === undefined), { message: 'from and walk go together' });
type AuditAnchorPayload = z.infer<typeof auditAnchorPayload>;

/** A purge whose payload is the window: run, and continue (same window) when it stopped at its deadline. */
function windowPurge(
  type: string,
  permission: Permission,
  purge: (ctx: JobContext) => Promise<{ deleted: Record<string, number> | number; more: boolean }>,
): JobHandler<ScheduleWindow> {
  return {
    type,
    permission,
    retryable: 'api',
    payload: windowPayload,
    async run(ctx, p): Promise<JobOutcome<ScheduleWindow>> {
      if (await purgesPaused(ctx)) return { done: true };
      const { deleted, more } = await purge(ctx);
      noted(ctx, `${type} deleted`, deleted);
      return more ? { continueWith: p, progress: 50 } : { done: true };
    },
  };
}

/**
 * The housekeeping handlers (see the top of this file): `housekeeping.volatile`, `housekeeping.events`,
 * `housekeeping.notifications`, `housekeeping.jobs`, `housekeeping.files`, `audit.anchor` and `audit.retention`.
 */
// eslint-disable-next-line @typescript-eslint/no-explicit-any
export function housekeepingJobs(deps: HousekeepingDeps): JobHandler<any>[] {
  const { dataDir } = deps;
  const files: JobHandler<FilesPayload> = {
    type: 'housekeeping.files',
    permission: 'system.jobs.manage',
    retryable: 'api',
    payload: filesPayload,
    async run(ctx, p) {
      if (await purgesPaused(ctx)) return { done: true };
      const { removed, next } = await cleanFiles(ctx.handle, {
        dataDir,
        now: ctx.now(),
        from: p.files ?? null,
        budgetLeft: () => ctx.budgetLeftMs() > BUDGET_MARGIN_MS,
        owner: `job:${ctx.jobId}`,
        log: ctx.log,
      });
      noted(ctx, 'housekeeping.files removed', removed);
      if (next === null) return { done: true };
      return { continueWith: { windowStart: p.windowStart, windowEnd: p.windowEnd, files: next }, progress: 50, message: next.phase };
    },
  };
  // Heavy (final review): never a request's piggyback slice, `jobs:heavy` keeps a second process from walking (and
  // notifying) at the same time, and the heartbeat between batches keeps the lease and that lock alive. A long walk (a
  // first one, or one after a break or a restore) goes on in the next slice from the last entry it verified (1d,
  // T18-AUDIT-ANCHOR-BUDGET: `{from, walk}` in the payload).
  const anchor: JobHandler<AuditAnchorPayload> = {
    type: 'audit.anchor',
    permission: 'system.audit.read',
    retryable: 'api',
    cpuHeavy: true,
    payload: auditAnchorPayload,
    async run(ctx, p) {
      const { verified, next } = await anchorAudit(ctx.handle, {
        dataDir,
        now: ctx.now(),
        heartbeat: () => ctx.heartbeat(),
        deadline: monotonicDeadlineOf(ctx),
        resume: p.from === undefined || p.walk === undefined ? null : { from: p.from, walk: p.walk },
      });
      if (next !== null) {
        return { continueWith: { windowStart: p.windowStart, windowEnd: p.windowEnd, from: next.from, walk: next.walk }, progress: 50 };
      }
      if (verified !== null && !verified.ok) ctx.log.error('audit chain broken', { jobId: ctx.jobId, brokenAt: verified.brokenAt });
      return { done: true };
    },
  };
  const retention: JobHandler<AuditPurgePayload> = {
    type: 'audit.retention',
    permission: 'system.audit.read',
    retryable: 'api',
    payload: auditPurgePayload,
    async run(ctx, p) {
      if (await purgesPaused(ctx)) return { done: true };
      if (p.purge === undefined) {
        // The run's cap first, stored as the checkpoint before anything is deleted (1d, T18-AUDIT-RETENTION-CAP).
        const run = await startAuditPurge(ctx.handle);
        if (run.maxSeq === 0) return { done: true };
        return { continueWith: { windowStart: p.windowStart, windowEnd: p.windowEnd, purge: run }, progress: 0 };
      }
      const { deleted, next } = await purgeAudit(ctx.handle, { now: ctx.now(), from: p.purge, deadline: deadlineOf(ctx) });
      noted(ctx, 'audit.retention deleted', deleted);
      if (next === null) return { done: true };
      const progress = next.limit === 0 ? 50 : Math.min(99, Math.floor((100 * next.deleted) / next.limit));
      return { continueWith: { windowStart: p.windowStart, windowEnd: p.windowEnd, purge: next }, progress };
    },
  };
  return [
    windowPurge('housekeeping.volatile', 'system.jobs.manage', (ctx) =>
      purgeVolatile(ctx.handle, { now: ctx.now(), dataDir, deadline: deadlineOf(ctx) }),
    ),
    windowPurge('housekeeping.events', 'system.jobs.manage', async (ctx) => {
      const r = await purgeEvents(ctx.handle, ctx.now(), { deadline: deadlineOf(ctx) });
      if (r.reindexFlagged.length > 0) ctx.log.warn('events: consumers left behind retention', { consumers: r.reindexFlagged });
      return { deleted: r.deleted, more: r.more === true };
    }),
    windowPurge('housekeeping.notifications', 'system.jobs.manage', (ctx) =>
      purgeNotifications(ctx.handle, ctx.now(), { deadline: deadlineOf(ctx) }),
    ),
    windowPurge('housekeeping.jobs', 'system.jobs.manage', (ctx) => purgeJobs(ctx.handle, ctx.now(), { deadline: deadlineOf(ctx) })),
    files,
    anchor,
    retention,
  ];
}
