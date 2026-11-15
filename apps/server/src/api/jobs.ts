import {
  SCHEDULES,
  SLICE_BUDGET_MS,
  SLIMS_MIGRATION_JOB,
  SLIMS_USAGE_JOB,
  can,
  createJobRegistry,
  getJob,
  listJobs,
  nextRun,
  parseCronExpr,
  readSettings,
  releaseCancelledSlimsMigration,
  releaseCancelledUsageImport,
  requestCancel,
  retryJob,
  type Grants,
  type JobRegistry,
  type JobRow,
  type JobStatus,
  type ScheduleDef,
  type TxCtx,
} from '@altis/core';
import type { DbHandle } from '@altis/db';
import { DomainError } from '@altis/shared';
import { ulidField } from '@altis/shared/api/common';
import {
  JOB_PAGE_DEFAULT,
  JobListQuery,
  SchedulePatchBody,
  type JobListResponse,
  type JobStatusValue,
  type JobView,
  type ScheduleListResponse,
  type ScheduleView,
} from '@altis/shared/api/jobs';
import { z } from 'zod';
import type { AuthState } from '../http/auth-state.js';
import { route, type RouteContext, type RouteDecl } from '../http/route.js';
import { validationFailed } from '../http/validate.js';
import { jobHandlers } from '../jobs/runtime.js';

// The jobs and schedules routes of Task 17 (spec §10.1, §10.4, §10.5, §13.5 "Tugas"; decision C34, M33; route catalog
// `jobs.*`, `schedules.*`):
//
//   GET   jobs                 P:system.jobs.read: a page of jobs, newest first (JobListQuery)
//   GET   jobs/:id             the creator, system.jobs.read, or for an interactive job a holder of the handler's
//                              permission (whom drive accepts, C26/E22b); 404 to anyone else (existence is not leaked)
//   POST  jobs/:id/retry       P:system.jobs.manage + the handler's permission (else 403 AUTHZ_DENIED); audit jobs.retry
//   POST  jobs/:id/cancel      P:system.jobs.manage + the handler's permission (else 403 AUTHZ_DENIED); audit jobs.cancel
//   POST  jobs/:id/drive       the creator, or a holder of the handler's permission (else 404); an interactive job
//                              only (409 JOB_NOT_INTERACTIVE, M33); one slice ≤ 20 s in external mode (§10.2)
//   GET   schedules            P:system.jobs.read: the schedules of this release, in the code's order
//   PATCH schedules/:name      P:system.jobs.manage + the schedule's permission; `expr` only where it is editable
//                              (422 `not_editable`), checked by parseCronExpr; audit schedules.update {name, enabled?, expr?}
//
// - A job's `payload` is shown only to a holder of its handler's permission (C34); a type this release has no handler
//   for shows none, counts as `origin-only`, and is retried by nobody (JOB_NOT_RETRYABLE `state`); cancelling one
//   needs only `system.jobs.manage` (it can no longer run, so cancelling it only cleans up). `interactive` is the
//   handler's flag (false without a handler), so the admin offers drive only where it can work (Task 31).
// - GET jobs/:id answers everyone drive acts for: a page drives a job only once it read it, and the system queues
//   some interactive jobs itself (no creator: the search rebuild after a restore, which Diagnostik drives for a holder
//   of `system.diagnostics.manage`, C26/E22b). The view it then shows (payload included) is the one drive answers
//   anyway; a job that is not interactive keeps the creator-or-`system.jobs.read` rule. The `jobs.<id>` channel keeps
//   its own rule (§10.7: the creator, or `system.jobs.read`), so the admin subscribes only for those.
// - The handlers are the job runtime's (services.jobs.registry); a process without a runtime (not ready yet, a test
//   app) uses the registry of this release's handler array.
// - retry and cancel publish their `jobs.<id>` event as the last statement of the handler transaction (§10.6), so the
//   audit entry is appended first and the answer is the job as it was read, with the change the core call made.
// - `next_run_at` is computed from now when a schedule's expression changes, or when a disabled schedule is switched
//   on again (Task 14 controller note): its stale next run would otherwise start an immediate catch-up run, or look
//   like a clock anomaly. An enabled schedule switched on again keeps its next run (a due run stays due).
// - GET answers carry `Cache-Control: no-store`; the `store` routes carry no headers (they are not replayed).
// - A SLiMS usage import cancelled while queued never runs a slice again, and its run's folder holds the raw dump the
//   start moved there (member names and addresses): after the COMMIT the folder and the dump's upload leftovers are
//   removed and the run is ended (releaseCancelledUsageImport). The housekeeping still ends what a crash left.
// - A SLiMS migration cancelled while queued (between two slices) is ended after the COMMIT likewise, its rows in the
//   ALTIS tables counted again and its work folder removed (releaseCancelledSlimsMigration), so its screen shows its
//   real end at once.

const JOBS = '/api/v1/jobs';
const SCHEDULES_PATH = '/api/v1/schedules';
const NO_STORE = { 'Cache-Control': 'no-store' };

type Trx = TxCtx['trx'];

const IdParams = z.strictObject({ id: ulidField });
/** A schedule name: an unknown one is 404, so the shape only bounds the column width. */
const NameParams = z.strictObject({ name: z.string().min(1).max(191) });

// Core's job statuses are the shared ones (a compile-time check that the two lists stay one set).
const _statusIsShared: (s: JobStatus) => JobStatusValue = (s) => s;
const _sharedIsStatus: (s: JobStatusValue) => JobStatus = (s) => s;
void _statusIsShared;
void _sharedIsStatus;

let fallbackRegistry: JobRegistry | null = null;

/** The handlers of this release: the job runtime's, else (no runtime in this process yet) the handler array's. */
function registryOf(rc: RouteContext<unknown, unknown, unknown>): JobRegistry {
  const runtime = rc.services.jobs;
  if (runtime !== null) return runtime.registry;
  fallbackRegistry ??= createJobRegistry(jobHandlers());
  return fallbackRegistry;
}

/** The caller (every route here requires a session, which step 9 refuses without one). */
function authOf(rc: RouteContext<unknown, unknown, unknown>): AuthState {
  if (rc.auth === null) throw new DomainError('AUTH_REQUIRED');
  return rc.auth;
}

function jobNotFound(): DomainError {
  return new DomainError('NOT_FOUND', { detail: 'Tugas tidak ditemukan / Job not found' });
}

function scheduleNotFound(): DomainError {
  return new DomainError('NOT_FOUND', { detail: 'Jadwal tidak ditemukan / Schedule not found' });
}

/** Whether `grants` hold the permission of the handler of `type` (false for a type without a handler). */
function holdsHandler(reg: JobRegistry, grants: Grants, type: string): boolean {
  const handler = reg.get(type);
  return handler !== undefined && can(grants, handler.permission);
}

/** `row` as the API shows it to a caller with `grants` (see the top of this file for `payload`, `retryable` and `interactive`). */
export function jobView(row: JobRow, reg: JobRegistry, grants: Grants): JobView {
  const handler = reg.get(row.type);
  const view: JobView = {
    id: row.id,
    type: row.type,
    status: row.status,
    progress: row.progress,
    progressMessage: row.progressMessage,
    attempts: row.attempts,
    maxAttempts: row.maxAttempts,
    lastError: row.lastError,
    runAt: row.runAt,
    createdAt: row.createdAt,
    updatedAt: row.updatedAt,
    finishedAt: row.finishedAt,
    createdBy: row.createdBy,
    retryable: handler?.retryable ?? 'origin-only',
    cancellable: !row.pointOfNoReturn && (row.status === 'queued' || (row.status === 'running' && !row.cancelRequested)),
    interactive: handler?.interactive === true,
  };
  if (handler !== undefined && can(grants, handler.permission)) view.payload = row.payload;
  return view;
}

/**
 * `prepare` of a retry or a cancel: the route's permission was checked at step 9, the handler's is checked here (a type
 * without a handler needs none besides the route's), before the handler transaction, so that a refusal is counted and
 * audited as step 9's are (§7.8, rc.authzDenied). A missing job is left to the handler (404).
 *
 * @throws DomainError `AUTHZ_DENIED` without the handler's permission
 */
async function mayManage(rc: RouteContext<unknown, unknown, { id: string }>): Promise<void> {
  const job = await getJob(rc.db.db, rc.params.id);
  const handler = job === null ? undefined : registryOf(rc).get(job.type);
  if (handler !== undefined && !can(authOf(rc).grants, handler.permission)) throw await rc.authzDenied(handler.permission);
}

/**
 * The job `id` for a retry or a cancel by the caller, read in the handler transaction. A job's type never changes, so
 * the handler's permission {@link mayManage} checked still holds; it is checked again as the guard of the write itself.
 *
 * @throws DomainError `NOT_FOUND`; `AUTHZ_DENIED` without the handler's permission
 */
async function jobToManage(rc: RouteContext<unknown, unknown, { id: string }>, trx: Trx, reg: JobRegistry): Promise<JobRow> {
  const job = await getJob(trx, rc.params.id);
  if (job === null) throw jobNotFound();
  const handler = reg.get(job.type);
  if (handler !== undefined && !can(authOf(rc).grants, handler.permission)) throw new DomainError('AUTHZ_DENIED');
  return job;
}

/** GET jobs. */
const jobsList = route({
  id: 'jobs.list',
  method: 'GET',
  path: JOBS,
  permission: 'system.jobs.read',
  idempotency: 'none',
  audit: null,
  query: JobListQuery,
  handler: async (rc) => {
    const reg = registryOf(rc);
    const { grants } = authOf(rc);
    const page = await listJobs(rc.db.db, {
      limit: rc.query.limit ?? JOB_PAGE_DEFAULT,
      ...(rc.query.status === undefined ? {} : { status: rc.query.status }),
      ...(rc.query.type === undefined ? {} : { type: rc.query.type }),
      ...(rc.query.before === undefined ? {} : { before: rc.query.before }),
    });
    const body: JobListResponse = { items: page.items.map((row) => jobView(row, reg, grants)), nextBefore: page.nextBefore };
    return { body, headers: NO_STORE };
  },
});

/** GET jobs/:id. */
const jobsGet = route({
  id: 'jobs.get',
  method: 'GET',
  path: `${JOBS}/:id`,
  public: true,
  session: 'required',
  idempotency: 'none',
  audit: null,
  params: IdParams,
  handler: async (rc) => {
    const auth = authOf(rc);
    const reg = registryOf(rc);
    const job = await getJob(rc.db.db, rc.params.id);
    const reads =
      job !== null &&
      (job.createdBy === auth.subjectId ||
        can(auth.grants, 'system.jobs.read') ||
        (reg.get(job.type)?.interactive === true && holdsHandler(reg, auth.grants, job.type)));
    if (!reads) throw jobNotFound();
    return { body: jobView(job, reg, auth.grants), headers: NO_STORE };
  },
});

/** POST jobs/:id/retry. */
const jobsRetry = route({
  id: 'jobs.retry',
  method: 'POST',
  path: `${JOBS}/:id/retry`,
  permission: 'system.jobs.manage',
  idempotency: 'store',
  audit: 'jobs.retry',
  params: IdParams,
  prepare: mayManage,
  handler: async (rc) => {
    const reg = registryOf(rc);
    const trx = rc.tx().trx;
    const job = await jobToManage(rc, trx, reg);
    await rc.audit({ entity: 'jobs', entityId: job.id, meta: { type: job.type } });
    // Its event is the transaction's last statement (§10.6): nothing is written or read after it.
    await retryJob(trx, reg, job.id, rc.now);
    rc.afterCommit(() => rc.services.jobs?.kick());
    const queued: JobRow = {
      ...job,
      status: 'queued',
      attempts: 0,
      runAt: rc.now,
      lastError: null,
      cancelRequested: false,
      finishedAt: null,
      lockedBy: null,
      lockedUntil: null,
      updatedAt: rc.now,
    };
    return { body: jobView(queued, reg, authOf(rc).grants) };
  },
});

/** POST jobs/:id/cancel. */
const jobsCancel = route({
  id: 'jobs.cancel',
  method: 'POST',
  path: `${JOBS}/:id/cancel`,
  permission: 'system.jobs.manage',
  idempotency: 'store',
  audit: 'jobs.cancel',
  params: IdParams,
  prepare: mayManage,
  handler: async (rc) => {
    const reg = registryOf(rc);
    const trx = rc.tx().trx;
    const job = await jobToManage(rc, trx, reg);
    await rc.audit({ entity: 'jobs', entityId: job.id, meta: { type: job.type } });
    // Its event (a cancelled queued job) is the transaction's last statement (§10.6): nothing is written or read after.
    const result = await requestCancel(trx, job.id, rc.now);
    if (result === 'cancelled' && job.type === SLIMS_USAGE_JOB) {
      const { dataDir } = rc.services;
      rc.afterCommit(() => releaseCancelledUsageImport(rc.db, { jobId: job.id, dataDir, now: rc.now, log: rc.log }));
    }
    if (result === 'cancelled' && job.type === SLIMS_MIGRATION_JOB) {
      const { dataDir } = rc.services;
      rc.afterCommit(() => releaseCancelledSlimsMigration(rc.db, { jobId: job.id, dataDir, now: rc.now, log: rc.log }));
    }
    const after: JobRow =
      result === 'cancelled'
        ? { ...job, status: 'cancelled', uniqueKey: null, hasSecret: false, finishedAt: rc.now, updatedAt: rc.now }
        : { ...job, status: 'running', cancelRequested: true, updatedAt: rc.now };
    return { body: jobView(after, reg, authOf(rc).grants) };
  },
});

/** POST jobs/:id/drive. */
const jobsDrive = route({
  id: 'jobs.drive',
  method: 'POST',
  path: `${JOBS}/:id/drive`,
  public: true,
  session: 'required',
  mode: 'system',
  idempotency: 'none',
  audit: null,
  tx: 'self',
  params: IdParams,
  handler: async (rc) => {
    const auth = authOf(rc);
    const reg = registryOf(rc);
    const job = await getJob(rc.db.db, rc.params.id);
    if (job === null || (job.createdBy !== auth.subjectId && !holdsHandler(reg, auth.grants, job.type))) throw jobNotFound();
    if (reg.get(job.type)?.interactive !== true) {
      throw new DomainError('JOB_NOT_INTERACTIVE', {
        detail: 'Tugas ini hanya dijalankan oleh pelaksana latar belakang / Only the background runner runs this job',
      });
    }
    // One slice of ≤ 20 s in external mode; the worker loop runs it in worker mode (null, nothing run here).
    await rc.services.jobs?.drive(job.id, { budgetMs: SLICE_BUDGET_MS });
    const after = await getJob(rc.db.db, job.id);
    if (after === null) throw jobNotFound();
    return { body: jobView(after, reg, auth.grants), headers: NO_STORE };
  },
});

/** A `schedules` row as it is read. */
interface ScheduleRow {
  name: string;
  expr: string;
  enabled: number;
  next_run_at: number;
  last_run_at: number | null;
}

function scheduleView(row: ScheduleRow, def: ScheduleDef): ScheduleView {
  return {
    name: row.name,
    expr: row.expr,
    enabled: Number(row.enabled) === 1,
    nextRunAt: Number(row.next_run_at),
    lastRunAt: row.last_run_at === null ? null : Number(row.last_run_at),
    jobType: def.jobType,
    exprEditable: def.exprEditable === true,
    permission: def.permission,
  };
}

/**
 * The schedules of this release as the API shows them, in the order of {@link SCHEDULES}: a definition without a row
 * (not seeded yet) and a row without a definition are left out. Task 26's dashboard shows the same list.
 */
export async function listScheduleViews(db: DbHandle['db'] | Trx): Promise<ScheduleView[]> {
  const rows = new Map<string, ScheduleRow>((await db.selectFrom('schedules').selectAll().execute()).map((r) => [r.name, r]));
  return SCHEDULES.flatMap((def) => {
    const row = rows.get(def.name);
    return row === undefined ? [] : [scheduleView(row, def)];
  });
}

/** GET schedules. */
const schedulesList = route({
  id: 'schedules.list',
  method: 'GET',
  path: SCHEDULES_PATH,
  permission: 'system.jobs.read',
  idempotency: 'none',
  audit: null,
  handler: async (rc) => {
    const body: ScheduleListResponse = { items: await listScheduleViews(rc.db.db) };
    return { body, headers: NO_STORE };
  },
});

/** PATCH schedules/:name. */
const schedulesUpdate = route({
  id: 'schedules.update',
  method: 'PATCH',
  path: `${SCHEDULES_PATH}/:name`,
  permission: 'system.jobs.manage',
  idempotency: 'store',
  audit: 'schedules.update',
  params: NameParams,
  body: SchedulePatchBody,
  // The schedule's own permission, refused before the handler transaction: counted and audited as step 9's (§7.8).
  prepare: async (rc): Promise<ScheduleDef> => {
    const def = SCHEDULES.find((d) => d.name === rc.params.name);
    if (def === undefined) throw scheduleNotFound();
    if (!can(authOf(rc).grants, def.permission)) throw await rc.authzDenied(def.permission);
    return def;
  },
  handler: async (rc) => {
    const def = rc.prepared as ScheduleDef;
    const { enabled, expr } = rc.body;
    let normalized: string | undefined;
    if (expr !== undefined) {
      if (def.exprEditable !== true) throw validationFailed([{ path: 'expr', code: 'not_editable' }]);
      // VALIDATION_FAILED {path: 'expr', code: 'invalid_format'} for an expression that is not one.
      parseCronExpr(expr);
      normalized = expr.trim().split(/[ \t]+/).join(' ');
    }
    const trx = rc.tx().trx;
    const row = await trx.selectFrom('schedules').selectAll().where('name', '=', def.name).executeTakeFirst();
    if (row === undefined) throw scheduleNotFound();
    const wasEnabled = Number(row.enabled) === 1;
    const nextExpr = normalized ?? row.expr;
    const nextEnabled = enabled ?? wasEnabled;
    const changes: { enabled?: number; expr?: string; next_run_at?: number } = {};
    if (nextEnabled !== wasEnabled) changes.enabled = nextEnabled ? 1 : 0;
    if (nextExpr !== row.expr) changes.expr = nextExpr;
    if (changes.expr !== undefined || (nextEnabled && !wasEnabled)) {
      const tz = (await readSettings(trx, ['library.timezone'], []))['library.timezone'] as string;
      changes.next_run_at = nextRun(parseCronExpr(nextExpr), rc.now, tz);
    }
    if (Object.keys(changes).length > 0) await trx.updateTable('schedules').set(changes).where('name', '=', def.name).execute();
    await rc.audit({
      entity: 'schedules',
      entityId: def.name,
      meta: { name: def.name, ...(enabled === undefined ? {} : { enabled }), ...(normalized === undefined ? {} : { expr: normalized }) },
    });
    const updated: ScheduleRow = {
      ...row,
      enabled: nextEnabled ? 1 : 0,
      expr: nextExpr,
      next_run_at: changes.next_run_at ?? row.next_run_at,
    };
    return { body: scheduleView(updated, def) };
  },
});

/** The jobs and schedules routes (route catalog `jobs.*`, `schedules.*`). */
export const JOBS_ROUTES: RouteDecl[] = [jobsList, jobsGet, jobsRetry, jobsCancel, jobsDrive, schedulesList, schedulesUpdate];
