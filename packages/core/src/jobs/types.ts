import type { DB, DbHandle } from '@altis/db';
import type { Permission } from '@altis/shared';
import type { Kysely } from 'kysely';
import type { z } from 'zod';
import type { AuditInput, CoreLogger } from '../context.js';

// The job queue's vocabulary (spec §10.1, §13.8, extended additively; decisions C4, C38).
//
// Every job is sliced (decision C38, preflight B5): one `run()` call is one slice, which returns before
// `ctx.budgetLeftMs()` reaches 0 (≤ 20 s, P9) with a checkpoint in `continueWith`, or `{done: true}`. The queue keeps
// the checkpoint as the job's payload, so whichever process claims the job next continues from it (P7).

/** How long a claim holds a job (spec §10.1): renewed by `ctx.heartbeat()`. */
export const JOB_LEASE_MS = 50_000;

/** The heartbeat writes at most this often (spec §10.1: "±15 detik"). */
export const JOB_HEARTBEAT_MS = 15_000;

/** The longest slice (P9: "Potongan kerja … masing-masing ≤ 20 detik"). */
export const SLICE_BUDGET_MS = 20_000;

/** `max_attempts` of a job whose handler and enqueue name none (decision C4). */
export const DEFAULT_MAX_ATTEMPTS = 5;

/** The named lock (`locks`) a heavy job holds while it runs: at most one heavy job per installation (§10.2, S27). */
export const HEAVY_LOCK = 'jobs:heavy';

/** The largest payload (a checkpoint included), in bytes of its JSON text: `jobs.payload` is TEXT (MySQL: 65 535). */
export const JOB_PAYLOAD_MAX = 65_535;

/** The largest `secret` of an enqueue, in bytes (sealed, it stays far inside the TEXT column). */
export const JOB_SECRET_MAX = 4096;

/** The longest retry delay (spec §10.1: "min(2^(:a+1) × 10 detik, 1 jam)"). */
const RETRY_DELAY_MAX_MS = 3_600_000;
const RETRY_DELAY_BASE_MS = 10_000;

/**
 * The wait before a job that has failed `attempts` times may run again: `min(2^attempts × 10 s, 1 h)`. The error path
 * of a slice uses `retryDelayMs(a + 1)` (spec §10.1); the reclaim of an expired lease, statement (b), waits
 * `retryDelayMs(attempts)` past the lease's end (decision C4).
 *
 * @throws RangeError unless `attempts` is a non-negative integer
 */
export function retryDelayMs(attempts: number): number {
  if (!Number.isInteger(attempts) || attempts < 0) {
    throw new RangeError(`retryDelayMs: attempts must be a non-negative integer, got ${String(attempts)}`);
  }
  // 2^9 × 10 s is already past the cap; larger exponents only grow (2^1024 is Infinity, still capped).
  return Math.min(2 ** attempts * RETRY_DELAY_BASE_MS, RETRY_DELAY_MAX_MS);
}

/**
 * Who runs a slice (spec §10.2): the in-process worker loop, `jobs:run` (CLI cron), `POST /_cron`, a `drive` request,
 * or a piggyback slice after a response.
 */
export type RunMode = 'worker' | 'cron_cli' | 'cron_http' | 'drive' | 'piggyback';

/** The statuses of `jobs.status`. */
export const JOB_STATUSES = Object.freeze(['queued', 'running', 'succeeded', 'dead', 'cancelled'] as const);
export type JobStatus = (typeof JOB_STATUSES)[number];

/**
 * What a slice returns: the job is finished (with a last `message` for `progress_message`, additive: Task 20's
 * "converted to frozen"), or its checkpoint for the next slice, with its progress (0–100), or (1d,
 * T20-SNAPSHOT-HOLD-COUNTS-ATTEMPT) it cannot work before `waitUntil` (epoch ms on the slice clock: a lock another
 * holds): the job is queued again at that time with its stored payload, without counting an attempt.
 */
export type JobOutcome<P> =
  | { done: true; message?: string }
  | { continueWith: P; progress: number; message?: string }
  | { waitUntil: number; message?: string };

/** What a handler gets for one slice (spec §13.8, extended). */
export interface JobContext {
  jobId: string;
  mode: RunMode;
  /**
   * Renews the lease (at most every {@link JOB_HEARTBEAT_MS}, or at once when `progress`/`message` changed and 2 s
   * passed), renews `jobs:heavy` for a heavy job (S27), reads `cancel_requested` (→ {@link cancelled}), and in
   * piggyback mode yields to the event loop (`setImmediate`) when 50 ms passed since the last yield.
   *
   * Never call it inside a `withTx` of the handler's own (M28): it opens a transaction of its own.
   *
   * @throws DomainError `JOB_LEASE_LOST` when the job is no longer this slice's (another process reclaimed it):
   *   the handler must stop
   */
  heartbeat(o?: { progress?: number; message?: string }): Promise<void>;
  /**
   * True when the job was claimed with a cancel request pending, or once a heartbeat read one (and the job is not past
   * its point of no return).
   */
  cancelled(): boolean;
  /** Records that the job can no longer be cancelled (spec §10.5). @throws DomainError `JOB_LEASE_LOST` */
  markPointOfNoReturn(): Promise<void>;
  /** The secret given to `enqueue` (sealed in `secret_param`), or null when there is none. */
  secretParam(): Promise<Uint8Array | null>;
  /**
   * Writes an audit entry in a transaction of its own, by the actor `{type: 'system', id: null, ip: null}`, with
   * `meta.jobId`. Never inside a `withTx` of the handler's own (M28).
   */
  audit(e: AuditInput): Promise<void>;
  /**
   * The value this process keeps for this job across its consecutive slices (`fresh: false`), or a new one from
   * `open` (`fresh: true`). It is closed (`close`) when the job reaches a terminal status in this process, when
   * another process has run the job since, or when the runtime drains ({@link closeJobSessions}).
   */
  session<T>(open: () => Promise<T>, close: (s: T) => Promise<void>): Promise<{ value: T; fresh: boolean }>;
  db: Kysely<DB>;
  handle: DbHandle;
  log: CoreLogger;
  /** The slice's clock (epoch ms). */
  now(): number;
  /** Milliseconds left of the slice's budget (never negative). */
  budgetLeftMs(): number;
}

/** A job type's handler (spec §13.8, extended). */
export interface JobHandler<P> {
  /** `/^[a-z][a-z0-9_.]{0,63}$/` (the width of `jobs.type`). */
  type: string;
  /** What it takes to see the payload, retry, cancel or drive the job (§10.5). */
  permission: Permission;
  /** `origin-only`: only the code that enqueued it may run it again; a retry through the API → 409 (§10.5). */
  retryable: 'api' | 'origin-only';
  /** May be advanced by `drive` (M33). */
  interactive?: boolean;
  /** Counts as heavy: needs `jobs:heavy`, never piggybacked. */
  cpuHeavy?: boolean;
  /** Keeps a process-local session between consecutive slices (C38); counts as heavy. */
  longRunning?: boolean;
  /**
   * `false`: never piggybacked, though light. For a job that begins an op (`backup.schedule`): piggyback never steps
   * ops, and it runs only when no runner that does has run for 10 minutes (final review, jobs).
   */
  piggyback?: false;
  /** Default {@link DEFAULT_MAX_ATTEMPTS}. */
  maxAttempts?: number;
  /** Checks the payload at enqueue and before every slice. */
  payload: z.ZodType<P>;
  run(ctx: JobContext, payload: P): Promise<JobOutcome<P>>;
}

/** The handlers of the job types, by type. */
export interface JobRegistry {
  get(type: string): JobHandler<unknown> | undefined;
  types(): string[];
}

/** A job this process holds the lease of. */
export interface ClaimedJob {
  id: string;
  type: string;
  /** The stored payload (the last checkpoint), parsed from JSON; null when it is not JSON. */
  payload: unknown;
  /** Attempts after this claim (a reclaim of an expired lease counts one). */
  attempts: number;
  maxAttempts: number;
  /** The fencing token: every write of the slice carries `AND lock_token = :token`. */
  token: string;
  createdBy: string | null;
  /** `cpuHeavy` or `longRunning`: the claim holds `jobs:heavy` with the token as its owner. */
  heavy: boolean;
  pointOfNoReturn: boolean;
  /**
   * `jobs.cancel_requested` when the job was claimed (a request made before a reclaim): the slice starts with
   * `ctx.cancelled()` true unless the job is past its point of no return. Absent counts as false.
   */
  cancelRequested?: boolean;
  /** `jobs.updated_at` when the job was claimed (claims leave it as it was): tells a stale job session apart. */
  updatedAt: number;
}

/**
 * What one slice did (spec §10.1 result table; `waiting`: a `waitUntil` outcome, 1d); `error` is the stored
 * `last_error` of a `retry` or `dead`.
 */
export interface SliceResult {
  jobId: string;
  type: string;
  outcome: 'continued' | 'waiting' | 'succeeded' | 'retry' | 'dead' | 'cancelled' | 'lost';
  error?: string;
}

/** What `enqueue` takes. */
export interface EnqueueInput {
  type: string;
  payload: unknown;
  /** While a job holding this key is alive (not terminal), enqueue returns that job. ≤ 191 characters. */
  uniqueKey?: string;
  /** Epoch ms; default now. */
  runAt?: number;
  maxAttempts?: number;
  /** The staff user (ULID) who asked for it, or null. */
  createdBy?: string | null;
  /** Sealed into `secret_param` (AAD `jobs.secret_param.<id>`); never shown, cleared on a terminal status. */
  secret?: Uint8Array;
}

/** A job as the API and the screens see it (never its lock token or its secret). */
export interface JobRow {
  id: string;
  type: string;
  status: JobStatus;
  /** Parsed from JSON; null when the stored text is not JSON. */
  payload: unknown;
  /** Whether a `secret_param` is stored (the value itself is never read here). */
  hasSecret: boolean;
  runAt: number;
  attempts: number;
  maxAttempts: number;
  uniqueKey: string | null;
  lockedBy: string | null;
  lockedUntil: number | null;
  cancelRequested: boolean;
  pointOfNoReturn: boolean;
  progress: number;
  progressMessage: string | null;
  lastError: string | null;
  createdBy: string | null;
  createdAt: number;
  updatedAt: number;
  finishedAt: number | null;
}
