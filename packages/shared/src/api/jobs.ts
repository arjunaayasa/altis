/**
 * The jobs and schedules API vocabulary shared by the server and the admin SPA (spec §10.1, §10.4, §10.5, §13.5
 * "Tugas"; decision C34): the query string of `GET jobs`, the job and schedule views, and the body of
 * `PATCH schedules/:name`. No Node built-ins here: the browser bundles this module. Import it as
 * `@altis/shared/api/jobs`.
 *
 * Query strings are text, so the page size goes through `z.coerce.number().int()` (M5); every object is strict (§7.4).
 */
import { z } from 'zod';
import type { Permission } from '../permissions.js';
import { ulidField } from './common.js';

/** The statuses of a job (`jobs.status`). */
export const JOB_STATUS_VALUES = Object.freeze(['queued', 'running', 'succeeded', 'dead', 'cancelled'] as const);
export type JobStatusValue = (typeof JOB_STATUS_VALUES)[number];

/** The default page size of `GET jobs`. */
export const JOB_PAGE_DEFAULT = 50;
/** The largest page size of `GET jobs`. */
export const JOB_PAGE_MAX = 100;

/** A job type: lower case, dot-separated words, at most 64 characters (the width of `jobs.type`). */
export const jobTypeField = z
  .string()
  .max(64)
  .regex(/^[a-z][a-z0-9_.]{0,63}$/);

/**
 * `GET jobs`: keyset paging on the job id, newest first: `before` is the `nextBefore` of the previous page (only jobs
 * older than it), `limit` the page size (1-100, default 50); `status` and `type` filter.
 */
export const JobListQuery = z.strictObject({
  status: z.enum(JOB_STATUS_VALUES).optional(),
  type: jobTypeField.optional(),
  before: ulidField.optional(),
  limit: z.coerce.number().int().min(1).max(JOB_PAGE_MAX).optional(),
});

export type JobListQuery = z.infer<typeof JobListQuery>;

/**
 * One job as the API shows it (never its lock token or its secret). Times are epoch ms. `payload` (the job's input,
 * or its last checkpoint) is present only for a holder of the job handler's permission (C34). `retryable` is the
 * handler's rule (`origin-only`: only the code that started it may run it again; also for a type this release has no
 * handler for); `cancellable`: a cancel request would still change something (queued, or running without a pending
 * request, and not past its point of no return); `interactive`: the handler lets `POST jobs/:id/drive` advance the job
 * (M33; false for a type this release has no handler for, which drive answers 409 `JOB_NOT_INTERACTIVE`).
 */
export interface JobView {
  id: string;
  type: string;
  status: JobStatusValue;
  /** 0-100. */
  progress: number;
  progressMessage: string | null;
  attempts: number;
  maxAttempts: number;
  /** An error code plus its authored detail, never a driver message. */
  lastError: string | null;
  runAt: number;
  createdAt: number;
  updatedAt: number;
  finishedAt: number | null;
  /** The staff user who started it (ULID), or null for the system. */
  createdBy: string | null;
  payload?: unknown;
  retryable: 'api' | 'origin-only';
  cancellable: boolean;
  interactive: boolean;
}

/** The answer of `GET jobs`: a page of jobs, newest first; `nextBefore` is the `before` of the next page, or null. */
export interface JobListResponse {
  items: JobView[];
  nextBefore: string | null;
}

/** The longest schedule expression (`schedules.expr` is VARCHAR(191)). */
export const SCHEDULE_EXPR_MAX = 191;

/**
 * One schedule (spec §10.4): its five-field expression in library time, whether it runs, the next and the last run
 * (epoch ms), the job type each run starts, whether an admin may change its expression (decision C2: only
 * `backup.daily`), and the permission it takes to change it besides `system.jobs.manage`.
 */
export interface ScheduleView {
  name: string;
  expr: string;
  enabled: boolean;
  nextRunAt: number;
  lastRunAt: number | null;
  jobType: string;
  exprEditable: boolean;
  permission: Permission;
}

/** The answer of `GET schedules`: every schedule of this release, in the order the code defines them. */
export interface ScheduleListResponse {
  items: ScheduleView[];
}

/**
 * `PATCH schedules/:name`: switch the schedule on or off, and (only where `exprEditable`) change its expression; a
 * field left out stays. The answer is the schedule's {@link ScheduleView}.
 */
export const SchedulePatchBody = z.strictObject({
  enabled: z.boolean().optional(),
  expr: z.string().max(SCHEDULE_EXPR_MAX).optional(),
});

export type SchedulePatchBody = z.infer<typeof SchedulePatchBody>;
