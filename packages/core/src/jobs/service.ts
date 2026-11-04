import type { DB } from '@altis/db';
import { DomainError, isUlid } from '@altis/shared';
import type { Kysely, Selectable, Transaction } from 'kysely';
import { publish } from '../events/publish.js';
import { JOB_STATUSES, type JobRegistry, type JobRow, type JobStatus } from './types.js';
import { JOB_TYPE } from './registry.js';

// The job service of the API and the screens (spec §10.1, §10.5; decision C34 leaves visibility to the routes):
// cancel, retry, read and list. Writes run in the caller's transaction, each with its `jobs.<id>` event as the
// transaction's last statement (§10.6).

/** The largest page of {@link listJobs}. */
export const JOBS_PAGE_MAX = 200;

const NOT_FOUND_DETAIL = 'Tugas tidak ditemukan / Job not found';

function isTransaction(trx: unknown): boolean {
  return typeof trx === 'object' && trx !== null && (trx as { isTransaction?: unknown }).isTransaction === true;
}

function checkTrx(trx: unknown, fn: string): void {
  if (!isTransaction(trx)) throw new TypeError(`${fn}() runs inside the caller’s transaction: pass the trx of withTx()`);
}

function checkNow(now: number, fn: string): void {
  if (!Number.isSafeInteger(now) || now < 0) throw new TypeError(`${fn}: now must be a safe non-negative integer (epoch ms)`);
}

function notFound(): DomainError {
  return new DomainError('NOT_FOUND', { detail: NOT_FOUND_DETAIL });
}

/**
 * Rounds of requestCancel's two UPDATEs before it gives up as TX_CONFLICT: a round misses only when another
 * transaction's write (a slice's result, a claim) landed between them.
 */
const CANCEL_ROUNDS = 3;

/**
 * Asks job `jobId` to stop at `now` (spec §10.1, §10.5):
 * - a queued job is cancelled at once (`cancelled`, `unique_key`/`secret_param` NULL, `finished_at`), with its
 *   `job.finished` event;
 * - a running one gets `cancel_requested = 1`: its next heartbeat makes `ctx.cancelled()` true, and its slice ends it
 *   `cancelled` instead of queuing it again.
 *
 * The two cases are two UPDATEs. When both miss, the job is read: a missing job is NOT_FOUND, a terminal one or one
 * past its point of no return is JOB_NOT_CANCELLABLE; one still queued or running moved between the two statements
 * (a slice's result re-queued it, a claim took it), and the UPDATEs run again, up to {@link CANCEL_ROUNDS} rounds.
 *
 * @returns `'cancelled'` or `'requested'`
 * @throws DomainError `NOT_FOUND` for an unknown id; `JOB_NOT_CANCELLABLE` (409) for a terminal job or one past its
 *   point of no return; `TX_CONFLICT` (409, `meta.code: 'JOB_CANCEL_RACE'`) when the job kept moving for every round
 *   (or this transaction's snapshot is older than the job), which the caller's withTx runs again
 */
export async function requestCancel(trx: Transaction<DB>, jobId: string, now: number): Promise<'requested' | 'cancelled'> {
  checkTrx(trx, 'requestCancel');
  checkNow(now, 'requestCancel');
  if (typeof jobId !== 'string' || !isUlid(jobId)) throw notFound();
  for (let round = 0; round < CANCEL_ROUNDS; round += 1) {
    const queued = await trx
      .updateTable('jobs')
      .set({ status: 'cancelled', unique_key: null, secret_param: null, finished_at: now, updated_at: now })
      .where('id', '=', jobId)
      .where('status', '=', 'queued')
      .where('point_of_no_return', '=', 0)
      .executeTakeFirst();
    if (Number(queued.numUpdatedRows) === 1) {
      await publish(trx, { channel: `jobs.${jobId}`, type: 'job.finished', payload: { status: 'cancelled' } });
      return 'cancelled';
    }
    const running = await trx
      .updateTable('jobs')
      .set({ cancel_requested: 1, updated_at: now })
      .where('id', '=', jobId)
      .where('status', '=', 'running')
      .where('point_of_no_return', '=', 0)
      .executeTakeFirst();
    if (Number(running.numUpdatedRows) === 1) return 'requested';
    const row = await trx.selectFrom('jobs').select(['status', 'point_of_no_return']).where('id', '=', jobId).executeTakeFirst();
    if (row === undefined) throw notFound();
    if (Number(row.point_of_no_return) === 1 || (row.status !== 'queued' && row.status !== 'running')) {
      throw new DomainError('JOB_NOT_CANCELLABLE', {
        detail: 'Tugas ini sudah selesai atau melewati titik tanpa kembali / The job has ended or is past its point of no return',
      });
    }
  }
  throw new DomainError('TX_CONFLICT', {
    detail:
      'Status tugas berubah selama pembatalan; transaksi diulang / The job changed state while it was being cancelled; ' +
      'the transaction is run again',
    meta: { attempts: 1, code: 'JOB_CANCEL_RACE' },
  });
}

function notRetryable(reason: 'origin_only' | 'state'): DomainError {
  return new DomainError('JOB_NOT_RETRYABLE', {
    detail:
      reason === 'origin_only'
        ? 'Tugas ini hanya dapat diulang dari tempat asalnya / Only the place that started this job can retry it'
        : 'Hanya tugas yang gagal atau dibatalkan yang dapat diulang / Only a dead or cancelled job can be retried',
    meta: { reason },
  });
}

/**
 * Queues the dead or cancelled job `jobId` again at `now` (spec §10.5): `attempts = 0`, `run_at = now`, `last_error`,
 * `cancel_requested`, `finished_at` and the lock cleared, its stored payload (the last checkpoint) kept; a
 * `secret_param` cleared at its end stays missing, and so does its unique key. Publishes `job.progress`.
 *
 * @throws DomainError `NOT_FOUND` for an unknown id; `JOB_NOT_RETRYABLE` (409) with `meta.reason` `origin_only` for a
 *   job of an `origin-only` handler, `state` for any other status (or a type this release has no handler for)
 */
export async function retryJob(trx: Transaction<DB>, reg: JobRegistry, jobId: string, now: number): Promise<void> {
  checkTrx(trx, 'retryJob');
  checkNow(now, 'retryJob');
  if (typeof jobId !== 'string' || !isUlid(jobId)) throw notFound();
  const row = await trx.selectFrom('jobs').select(['type', 'status', 'progress']).where('id', '=', jobId).executeTakeFirst();
  if (row === undefined) throw notFound();
  const handler = reg.get(row.type);
  if (handler === undefined) throw notRetryable('state');
  if (handler.retryable === 'origin-only') throw notRetryable('origin_only');
  if (row.status !== 'dead' && row.status !== 'cancelled') throw notRetryable('state');
  const r = await trx
    .updateTable('jobs')
    .set({
      status: 'queued',
      attempts: 0,
      run_at: now,
      last_error: null,
      cancel_requested: 0,
      finished_at: null,
      lock_token: null,
      locked_by: null,
      locked_until: null,
      updated_at: now,
    })
    .where('id', '=', jobId)
    .where('status', '=', row.status)
    .executeTakeFirst();
  // Another request retried it first (compare-and-set on the status read).
  if (Number(r.numUpdatedRows) !== 1) throw notRetryable('state');
  await publish(trx, { channel: `jobs.${jobId}`, type: 'job.progress', payload: { status: 'queued', progress: Number(row.progress) } });
}

type Db = Kysely<DB> | Transaction<DB>;

const ROW_COLUMNS = [
  'id',
  'type',
  'status',
  'payload',
  'secret_param',
  'run_at',
  'attempts',
  'max_attempts',
  'unique_key',
  'locked_by',
  'locked_until',
  'cancel_requested',
  'point_of_no_return',
  'progress',
  'progress_message',
  'last_error',
  'created_by',
  'created_at',
  'updated_at',
  'finished_at',
] as const;

type StoredRow = Pick<Selectable<DB['jobs']>, (typeof ROW_COLUMNS)[number]>;

function rowOf(r: StoredRow): JobRow {
  let payload: unknown = null;
  try {
    payload = JSON.parse(r.payload);
  } catch {
    // Not JSON (never written so): shown as null.
  }
  const num = (v: number | null): number | null => (v === null ? null : Number(v));
  return {
    id: r.id,
    type: r.type,
    status: r.status as JobStatus,
    payload,
    hasSecret: r.secret_param !== null,
    runAt: Number(r.run_at),
    attempts: Number(r.attempts),
    maxAttempts: Number(r.max_attempts),
    uniqueKey: r.unique_key,
    lockedBy: r.locked_by,
    lockedUntil: num(r.locked_until),
    cancelRequested: Number(r.cancel_requested) === 1,
    pointOfNoReturn: Number(r.point_of_no_return) === 1,
    progress: Number(r.progress),
    progressMessage: r.progress_message,
    lastError: r.last_error,
    createdBy: r.created_by,
    createdAt: Number(r.created_at),
    updatedAt: Number(r.updated_at),
    finishedAt: num(r.finished_at),
  };
}

/** Job `id`, or null when there is none. */
export async function getJob(db: Db, id: string): Promise<JobRow | null> {
  if (typeof id !== 'string' || !isUlid(id)) return null;
  const r = await db.selectFrom('jobs').select(ROW_COLUMNS).where('id', '=', id).executeTakeFirst();
  return r === undefined ? null : rowOf(r);
}

/**
 * A page of jobs, newest id first, keyset on `id` (`before`: the last id of the previous page): at most `limit`
 * (1–{@link JOBS_PAGE_MAX}), filtered by `status`, `type` and `createdBy`. `nextBefore` is the id to pass for the next
 * page, or null when this one is the last.
 *
 * @throws RangeError for a `limit` outside 1–200; TypeError for an unknown status, a malformed type, or a `before`
 *   or `createdBy` that is not a ULID
 */
export async function listJobs(
  db: Db,
  q: { status?: string; type?: string; createdBy?: string; before?: string; limit: number },
): Promise<{ items: JobRow[]; nextBefore: string | null }> {
  if (!Number.isSafeInteger(q.limit) || q.limit < 1 || q.limit > JOBS_PAGE_MAX) {
    throw new RangeError(`listJobs: limit must be an integer from 1 to ${JOBS_PAGE_MAX}`);
  }
  if (q.status !== undefined && !(JOB_STATUSES as readonly string[]).includes(q.status)) throw new TypeError('listJobs: unknown status');
  if (q.type !== undefined && (typeof q.type !== 'string' || !JOB_TYPE.test(q.type))) throw new TypeError('listJobs: malformed type');
  for (const [name, v] of [
    ['before', q.before],
    ['createdBy', q.createdBy],
  ] as const) {
    if (v !== undefined && (typeof v !== 'string' || !isUlid(v))) throw new TypeError(`listJobs: ${name} must be a ULID`);
  }
  let query = db.selectFrom('jobs').select(ROW_COLUMNS);
  if (q.status !== undefined) query = query.where('status', '=', q.status);
  if (q.type !== undefined) query = query.where('type', '=', q.type);
  if (q.createdBy !== undefined) query = query.where('created_by', '=', q.createdBy);
  if (q.before !== undefined) query = query.where('id', '<', q.before);
  const rows = await query
    .orderBy('id', 'desc')
    .limit(q.limit + 1)
    .execute();
  const items = rows.slice(0, q.limit).map(rowOf);
  return { items, nextBefore: rows.length > q.limit ? (items.at(-1)?.id ?? null) : null };
}
