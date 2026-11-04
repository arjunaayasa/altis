import { claimLock, releaseLock, withTx, type DB, type DbHandle } from '@altis/db';
import type { Expression, SqlBool, Transaction } from 'kysely';
import { publish } from '../events/publish.js';
import { notify } from '../notifications/service.js';
import { randomToken } from '../crypto/tokens.js';
import { HEAVY_LOCK, JOB_LEASE_MS, retryDelayMs, type ClaimedJob, type JobRegistry } from './types.js';

// Claims (spec §10.1, amended by decision C4 only: a compare-and-set on `attempts` in (b), `secret_param = NULL` and
// `finished_at` on the dead path (c), the clock-anomaly clause; M26). The three statements, every value computed by
// the application and bound as a parameter, no SET expression reading a column assigned earlier in it:
//
//   (a) UPDATE jobs SET status='running', lock_token=:t, locked_by=:w, locked_until=:now+:lease
//       WHERE id=:id AND status='queued' AND run_at<=:now
//   (b) UPDATE jobs SET attempts=attempts+1, lock_token=:t, locked_by=:w, locked_until=:now+:lease
//       WHERE id=:id AND status='running' AND locked_until < :now - :backoff AND attempts+1 < max_attempts
//         AND attempts = :read
//   (c) UPDATE jobs SET status='dead', last_error='LEASE_EXPIRED_MAX_ATTEMPTS', unique_key=NULL, lock_token=NULL,
//       locked_by=NULL, locked_until=NULL, secret_param=NULL, finished_at=:now, updated_at=:now
//       WHERE id=:id AND status='running' AND locked_until < :now AND attempts+1 >= max_attempts
//
// `:backoff` = retryDelayMs(attempts read) (C4). Under the clock anomaly (§10.4) a lease ending more than 2 × lease
// ahead counts as expired too: (b) and (c) add `OR locked_until > :now + 2 × :lease` to their locked_until
// condition, and `jobs:heavy` is claimed with `farFutureIsExpired` (S18). Claims leave `updated_at` as it was, so a
// claimed job's `updatedAt` names the last slice or heartbeat that wrote it (the job sessions of slice.ts compare it).
//
// A heavy job (`cpuHeavy` or `longRunning`) needs the named lock `jobs:heavy`, owned by the claim's token, for a new
// claim and a reclaim alike (S27): at most one heavy job runs per installation. The lock is taken before the job's
// row and given back when the row's claim fails.
//
// Each scan reads at most 20 rows, so the scans themselves filter in SQL what this claimant may take: its types (the
// registry's, within `o.types`, without the heavy ones under `excludeHeavy`), the exempt ids under maintenance, and
// for a reclaim the backoff of the attempts read. Rows it can never take (a type the registry no longer has, a job
// outside the maintenance exemption) therefore cannot fill a scan and stall the queue behind them. An expired job at
// its last attempt is still made dead (c) whatever its type. Once `jobs:heavy` is refused, the rest of the call skips
// heavy rows, and a full scan is read once more without them. The JS checks stay as guards.

/** What a claim may take. */
export interface ClaimOptions {
  /** Who claims: `locked_by` (`<host>:<pid>`, a CLI run, ...). At most 191 characters, no trailing blank. */
  worker: string;
  now: number;
  /** Non-null under maintenance: only these job ids may be claimed (the flag's `exemptJobIds`). */
  exempt?: readonly string[] | null;
  /** Skip `cpuHeavy` and `longRunning` jobs (piggyback). */
  excludeHeavy?: boolean;
  /** Only these job types. */
  types?: readonly string[];
  /** `clock_anomaly` is active (§10.4): a lease ending more than 2 × lease ahead counts as expired. */
  anomaly?: boolean;
}

/** Rows looked at per scan (expired leases, then due jobs). */
const CLAIM_SCAN = 20;
const SYSTEM_JOBS_LINK = '/admin/jobs';

type Candidate = { id: string; type: string };
type ExpiredRow = Candidate & { attempts: number; max_attempts: number; locked_until: number | null };

/** What one claim call has learnt: once `jobs:heavy` was refused (or heavy jobs are excluded), heavy rows are skipped. */
interface ScanState {
  skipHeavy: boolean;
}

/**
 * The attempts from which the reclaim backoff stays at its cap: `retryDelayMs(a)` differs for every `a` below it. The
 * expired scan spells the backoff of (b) per attempts value below it, and once for it and above.
 */
const BACKOFF_CAPPED_FROM = (() => {
  let a = 0;
  while (retryDelayMs(a) !== retryDelayMs(a + 1)) a += 1;
  return a;
})();

/** C0 controls, DEL and C1 controls; lone surrogates (neither stores as utf8mb4). */
const UNSTORABLE = /\p{Cc}|\p{Cs}/u;

function checkOptions(o: ClaimOptions): void {
  const w: unknown = o.worker;
  if (typeof w !== 'string' || w.length === 0 || [...w].length > 191 || w.endsWith(' ') || UNSTORABLE.test(w)) {
    throw new TypeError('claim: worker must be 1-191 characters without controls or a trailing blank');
  }
  if (!Number.isSafeInteger(o.now) || o.now < 0) throw new TypeError('claim: now must be a safe non-negative integer (epoch ms)');
}

function isHeavy(reg: JobRegistry, type: string): boolean {
  const handler = reg.get(type);
  return handler !== undefined && (handler.cpuHeavy === true || handler.longRunning === true);
}

/** Whether this claimant may take a job of `row`: a known type, exempt under maintenance, the filters. */
function allowed(reg: JobRegistry, o: ClaimOptions, st: ScanState, row: Candidate): boolean {
  if (reg.get(row.type) === undefined) return false;
  if (o.exempt !== undefined && o.exempt !== null && !o.exempt.includes(row.id)) return false;
  if (st.skipHeavy && isHeavy(reg, row.type)) return false;
  if (o.types !== undefined && !o.types.includes(row.type)) return false;
  return true;
}

/** The job types this claimant may take (SQL side of {@link allowed}): known, within `o.types`, not heavy when skipped. */
function claimableTypes(reg: JobRegistry, o: ClaimOptions, st: ScanState): string[] {
  return reg.types().filter((t) => (o.types === undefined || o.types.includes(t)) && !(st.skipHeavy && isHeavy(reg, t)));
}

/** Whether no job at all can be claimed or reclaimed under the filters (a reap (c) still can). */
function nothingClaimable(types: readonly string[], o: ClaimOptions): boolean {
  return types.length === 0 || (o.exempt !== undefined && o.exempt !== null && o.exempt.length === 0);
}

/** The far-future bound of the anomaly clause: a lease ending after it counts as expired. */
const farBound = (now: number): number => now + 2 * JOB_LEASE_MS;

/** Whether the lease of `row` counts as expired at `now` (statement (c)'s condition). */
function expired(row: ExpiredRow, o: ClaimOptions): boolean {
  if (row.locked_until === null) return true;
  return row.locked_until < o.now || (o.anomaly === true && row.locked_until > farBound(o.now));
}

/** Whether `row`'s backoff has passed too (statement (b)'s condition). */
function reclaimable(row: ExpiredRow, o: ClaimOptions): boolean {
  if (row.locked_until === null) return true;
  return row.locked_until < o.now - retryDelayMs(row.attempts) || (o.anomaly === true && row.locked_until > farBound(o.now));
}

/** The claimed job read back by its token, or null when it is no longer ours (it cannot be, within the lease). */
async function claimed(h: DbHandle, reg: JobRegistry, id: string, token: string): Promise<ClaimedJob | null> {
  const row = await h.db
    .selectFrom('jobs')
    .select(['id', 'type', 'payload', 'attempts', 'max_attempts', 'created_by', 'point_of_no_return', 'cancel_requested', 'updated_at'])
    .where('id', '=', id)
    .where('lock_token', '=', token)
    .where('status', '=', 'running')
    .executeTakeFirst();
  if (row === undefined) return null;
  let payload: unknown = null;
  try {
    payload = JSON.parse(row.payload);
  } catch {
    // Not JSON: the slice's schema check fails it (the error path).
  }
  return {
    id: row.id,
    type: row.type,
    payload,
    attempts: Number(row.attempts),
    maxAttempts: Number(row.max_attempts),
    token,
    createdBy: row.created_by,
    heavy: isHeavy(reg, row.type),
    pointOfNoReturn: Number(row.point_of_no_return) === 1,
    cancelRequested: Number(row.cancel_requested) === 1,
    updatedAt: Number(row.updated_at),
  };
}

/**
 * `jobs:heavy` for a heavy job (true for a light one); `release` gives it back when the row's claim failed. A refusal
 * makes the rest of the call skip heavy rows: the lock is held elsewhere, asking again per row only costs writes.
 */
async function takeHeavy(h: DbHandle, heavy: boolean, token: string, o: ClaimOptions, st: ScanState): Promise<boolean> {
  if (!heavy) return true;
  if (st.skipHeavy) return false;
  if (await claimLock(h, HEAVY_LOCK, token, JOB_LEASE_MS, { farFutureIsExpired: o.anomaly === true })) return true;
  st.skipHeavy = true;
  return false;
}

async function releaseHeavy(h: DbHandle, heavy: boolean, token: string): Promise<void> {
  if (heavy) await releaseLock(h, HEAVY_LOCK, token);
}

/** Statement (a) for `row`; the claimed job or null. */
async function claimQueued(
  h: DbHandle,
  reg: JobRegistry,
  row: Candidate,
  token: string,
  o: ClaimOptions,
  st: ScanState,
): Promise<ClaimedJob | null> {
  const heavy = isHeavy(reg, row.type);
  if (!(await takeHeavy(h, heavy, token, o, st))) return null;
  const r = await h.db
    .updateTable('jobs')
    .set({ status: 'running', lock_token: token, locked_by: o.worker, locked_until: o.now + JOB_LEASE_MS })
    .where('id', '=', row.id)
    .where('status', '=', 'queued')
    .where('run_at', '<=', o.now)
    .executeTakeFirst();
  if (Number(r.numUpdatedRows) === 1) {
    const job = await claimed(h, reg, row.id, token);
    if (job !== null) return job;
  }
  await releaseHeavy(h, heavy, token);
  return null;
}

/** Statement (b) for `row`, with the compare-and-set on the attempts read; the claimed job or null. */
async function reclaimExpired(
  h: DbHandle,
  reg: JobRegistry,
  row: ExpiredRow,
  token: string,
  o: ClaimOptions,
  st: ScanState,
): Promise<ClaimedJob | null> {
  const heavy = isHeavy(reg, row.type);
  if (!(await takeHeavy(h, heavy, token, o, st))) return null;
  const before = o.now - retryDelayMs(row.attempts);
  const r = await h.db
    .updateTable('jobs')
    // `attempts = attempts + 1` reads only the column it sets itself.
    .set((eb) => ({
      attempts: eb('attempts', '+', 1),
      lock_token: token,
      locked_by: o.worker,
      locked_until: o.now + JOB_LEASE_MS,
    }))
    .where('id', '=', row.id)
    .where('status', '=', 'running')
    .where((eb) =>
      o.anomaly === true ? eb.or([eb('locked_until', '<', before), eb('locked_until', '>', farBound(o.now))]) : eb('locked_until', '<', before),
    )
    .where((eb) => eb(eb('attempts', '+', 1), '<', eb.ref('max_attempts')))
    .where('attempts', '=', row.attempts)
    .executeTakeFirst();
  if (Number(r.numUpdatedRows) === 1) {
    const job = await claimed(h, reg, row.id, token);
    if (job !== null) return job;
  }
  await releaseHeavy(h, heavy, token);
  return null;
}

/**
 * Statement (c) for `row`, then the `job.finished` event and the `notification.job_dead` notification for the holders
 * of `system.jobs.read` (M34), in one transaction. True when this call made it dead.
 */
async function markDead(h: DbHandle, row: ExpiredRow, o: ClaimOptions): Promise<boolean> {
  return withTx(h, async (trx) => {
    const r = await trx
      .updateTable('jobs')
      .set({
        status: 'dead',
        last_error: 'LEASE_EXPIRED_MAX_ATTEMPTS',
        unique_key: null,
        lock_token: null,
        locked_by: null,
        locked_until: null,
        secret_param: null,
        finished_at: o.now,
        updated_at: o.now,
      })
      .where('id', '=', row.id)
      .where('status', '=', 'running')
      .where((eb) =>
        o.anomaly === true ? eb.or([eb('locked_until', '<', o.now), eb('locked_until', '>', farBound(o.now))]) : eb('locked_until', '<', o.now),
      )
      .where((eb) => eb(eb('attempts', '+', 1), '>=', eb.ref('max_attempts')))
      .executeTakeFirst();
    if (Number(r.numUpdatedRows) !== 1) return false;
    await jobDead(trx, row.id, row.type, o.now);
    return true;
  });
}

/**
 * The dead job's notification (for the holders of `system.jobs.read`, M34) and its `job.finished` event, the last
 * statements of the transaction that made it dead. Package-internal (slice.ts uses it too).
 */
export async function jobDead(trx: Transaction<DB>, id: string, type: string, now: number): Promise<void> {
  await notify(
    trx,
    {
      audience: { permission: 'system.jobs.read' },
      type: 'job.dead',
      titleKey: 'notification.job_dead.title',
      params: { name: type },
      link: SYSTEM_JOBS_LINK,
    },
    now,
  );
  await publish(trx, { channel: `jobs.${id}`, type: 'job.finished', payload: { status: 'dead' } });
}

/** The expired-lease handling of one running row: dead (c), reclaimed (b), or left for later. */
async function handleExpired(
  h: DbHandle,
  reg: JobRegistry,
  row: ExpiredRow,
  token: string,
  o: ClaimOptions,
  st: ScanState,
): Promise<ClaimedJob | null> {
  if (row.attempts + 1 >= row.max_attempts) {
    await markDead(h, row, o);
    return null;
  }
  if (!allowed(reg, o, st, row) || !reclaimable(row, o)) return null;
  return reclaimExpired(h, reg, row, token, o, st);
}

function normalizeExpired(r: { id: string; type: string; attempts: number; max_attempts: number; locked_until: number | null }): ExpiredRow {
  return {
    id: r.id,
    type: r.type,
    attempts: Number(r.attempts),
    max_attempts: Number(r.max_attempts),
    locked_until: r.locked_until === null ? null : Number(r.locked_until),
  };
}

/**
 * The expired leases of one scan, oldest first: those at their last attempt (any type: (c) makes them dead), and those
 * this claimant may reclaim with (b) now (its types and exemption, the backoff of the attempts read passed).
 */
async function scanExpired(h: DbHandle, reg: JobRegistry, o: ClaimOptions, st: ScanState): Promise<ExpiredRow[]> {
  const types = claimableTypes(reg, o, st);
  const rows = await h.db
    .selectFrom('jobs')
    .select(['id', 'type', 'attempts', 'max_attempts', 'locked_until'])
    .where('status', '=', 'running')
    .where((eb) =>
      o.anomaly === true ? eb.or([eb('locked_until', '<', o.now), eb('locked_until', '>', farBound(o.now))]) : eb('locked_until', '<', o.now),
    )
    .where((eb) => {
      const lastAttempt = eb(eb('attempts', '+', 1), '>=', eb.ref('max_attempts'));
      if (nothingClaimable(types, o)) return lastAttempt;
      // (b)'s `locked_until < :now - retryDelayMs(attempts)`, one bound per attempts value (dialect-neutral).
      const backoff: Expression<SqlBool>[] = [];
      for (let a = 0; a < BACKOFF_CAPPED_FROM; a += 1) {
        backoff.push(eb.and([eb('attempts', '=', a), eb('locked_until', '<', o.now - retryDelayMs(a))]));
      }
      backoff.push(eb.and([eb('attempts', '>=', BACKOFF_CAPPED_FROM), eb('locked_until', '<', o.now - retryDelayMs(BACKOFF_CAPPED_FROM))]));
      if (o.anomaly === true) backoff.push(eb('locked_until', '>', farBound(o.now)));
      const mine: Expression<SqlBool>[] = [eb('type', 'in', types), eb.or(backoff)];
      if (o.exempt !== undefined && o.exempt !== null) mine.push(eb('id', 'in', o.exempt));
      return eb.or([lastAttempt, eb.and(mine)]);
    })
    .orderBy('locked_until')
    .orderBy('id')
    .limit(CLAIM_SCAN)
    .execute();
  return rows.map(normalizeExpired);
}

/** The due queued jobs of one scan that this claimant may take, oldest `run_at` first. */
async function scanDue(h: DbHandle, reg: JobRegistry, o: ClaimOptions, st: ScanState): Promise<Candidate[]> {
  const types = claimableTypes(reg, o, st);
  if (nothingClaimable(types, o)) return [];
  let q = h.db
    .selectFrom('jobs')
    .select(['id', 'type'])
    .where('status', '=', 'queued')
    .where('run_at', '<=', o.now)
    .where('type', 'in', types);
  if (o.exempt !== undefined && o.exempt !== null) q = q.where('id', 'in', o.exempt);
  return q.orderBy('run_at').orderBy('id').limit(CLAIM_SCAN).execute();
}

/**
 * The first row of `scan` that `take` claims. A full scan in which `jobs:heavy` was refused is read once more without
 * the heavy rows, so heavy jobs waiting for the lock cannot hide light ones behind them.
 */
async function firstOf<R>(
  st: ScanState,
  scan: () => Promise<R[]>,
  take: (row: R) => Promise<ClaimedJob | null>,
): Promise<ClaimedJob | null> {
  for (;;) {
    const skippedHeavy = st.skipHeavy;
    const rows = await scan();
    for (const row of rows) {
      const job = await take(row);
      if (job !== null) return job;
    }
    if (rows.length < CLAIM_SCAN || st.skipHeavy === skippedHeavy) return null;
  }
}

/**
 * Claims the next job this claimant may run at `o.now` (spec §10.1, decision C4):
 *
 * 1. expired leases first, oldest first (at most 20 looked at per scan): one at its last attempt becomes `dead` (c),
 *    whatever its type, with its notification and event; one whose backoff (`retryDelayMs(attempts)` past the
 *    lease's end) has passed is reclaimed (b), attempts + 1;
 * 2. then queued jobs that are due, oldest `run_at` first (at most 20 looked at per scan), with (a).
 *
 * Skipped, in the scans' SQL: unknown types, jobs not in `o.exempt` when it is non-null (maintenance), heavy jobs with
 * `o.excludeHeavy`, types outside `o.types`; and heavy jobs while another claim holds `jobs:heavy`. Each statement
 * runs on its own on `h`: call it outside any withTx callback (claimLock refuses one).
 *
 * @returns the claimed job, holding the lease until `o.now + 50 s` (and `jobs:heavy` when heavy), or null
 * @throws TypeError for a malformed worker or now
 */
export async function claimNext(h: DbHandle, reg: JobRegistry, o: ClaimOptions): Promise<ClaimedJob | null> {
  checkOptions(o);
  const token = randomToken();
  const st: ScanState = { skipHeavy: o.excludeHeavy === true };

  const reclaimed = await firstOf(
    st,
    () => scanExpired(h, reg, o, st),
    (row) => handleExpired(h, reg, row, token, o, st),
  );
  if (reclaimed !== null) return reclaimed;

  return firstOf(
    st,
    () => scanDue(h, reg, o, st),
    (row) => (allowed(reg, o, st, row) ? claimQueued(h, reg, row, token, o, st) : Promise.resolve(null)),
  );
}

/**
 * Claims job `id` at `o.now` (drive, and the runner's immediate re-claim of a `longRunning` job): a due queued job
 * with (a); a running one whose lease expired as in {@link claimNext} (dead at its last attempt, else reclaimed once
 * its backoff passed). The same filters and the heavy lock apply.
 *
 * @returns the claimed job, or null (unknown id, not claimable now, or another claimant was first)
 * @throws TypeError for a malformed worker or now
 */
export async function claimById(h: DbHandle, reg: JobRegistry, id: string, o: ClaimOptions): Promise<ClaimedJob | null> {
  checkOptions(o);
  const row = await h.db
    .selectFrom('jobs')
    .select(['id', 'type', 'status', 'run_at', 'attempts', 'max_attempts', 'locked_until'])
    .where('id', '=', id)
    .executeTakeFirst();
  if (row === undefined) return null;
  const token = randomToken();
  const st: ScanState = { skipHeavy: o.excludeHeavy === true };
  if (row.status === 'queued') {
    if (Number(row.run_at) > o.now || !allowed(reg, o, st, row)) return null;
    return claimQueued(h, reg, row, token, o, st);
  }
  if (row.status === 'running') {
    const r = normalizeExpired(row);
    if (!expired(r, o)) return null;
    return handleExpired(h, reg, r, token, o, st);
  }
  return null;
}
