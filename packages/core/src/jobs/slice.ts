import { setImmediate as yieldToLoop } from 'node:timers/promises';
import { decodeBase64Url } from '@altis/crypto';
import { claimLock, releaseLock, withTx, type DB, type DbHandle } from '@altis/db';
import { faultArmed, killSelf, type Env } from '@altis/platform';
import { DomainError, isDomainError } from '@altis/shared';
import type { Transaction, UpdateQueryBuilder, UpdateResult } from 'kysely';
import { errorFields, txCtx, type CoreLogger } from '../context.js';
import { openValue, secretAad, type KeyringEntry } from '../crypto/secret-box.js';
import { publish } from '../events/publish.js';
import { jobDead } from './claim.js';
import {
  HEAVY_LOCK,
  JOB_HEARTBEAT_MS,
  JOB_LEASE_MS,
  JOB_PAYLOAD_MAX,
  retryDelayMs,
  type ClaimedJob,
  type JobContext,
  type JobHandler,
  type JobOutcome,
  type JobRegistry,
  type RunMode,
  type SliceResult,
} from './types.js';

// One slice of a claimed job (spec §10.1, decisions C4, C38): the handler's run(), then its result written under the
// claim's fencing token, as the result table of §10.1 says (values computed here from the claimed row):
//
//   {continueWith} → status='queued', run_at=:now, attempts=0, payload=<checkpoint>, lock_*=NULL
//   {waitUntil}    → status='queued', run_at=:waitUntil, attempts and payload unchanged, lock_*=NULL (1d: a wait,
//                    T20-SNAPSHOT-HOLD-COUNTS-ATTEMPT; `progress_message` = its `message`, when it has one)
//   error          → attempts=:a+1, last_error, lock_*=NULL; then status='dead', unique_key=NULL when :a+1 ≥
//                    max_attempts, else status='queued', run_at=:now + retryDelayMs(:a+1)
//   {done: true}   → status='succeeded', unique_key=NULL (and `progress_message` = its `message`, when it has one)
//
// plus, on every terminal status, `secret_param = NULL` and `finished_at = :now` (C4), and `updated_at` on every
// write. Every write carries `AND lock_token = :t AND status = 'running'`: when it changes no row another claimant
// has the job (its lease expired and it was reclaimed), the slice reports `lost` and nothing it computed is kept.
//
// Cancellation (§10.1 "cancel_requested diperiksa oleh heartbeat()", §10.5): a job whose cancel was requested and
// that is not past its point of no return is not queued again: a continue, a wait or an error ends it `cancelled` instead
// (the condition is part of the write, so a request that arrived after the last heartbeat still counts). A slice that
// returns `{done: true}` has done its work and succeeds. After `markPointOfNoReturn()` cancel requests are ignored.
//
// The slice's event (`job.progress` or `job.finished` on `jobs.<id>`) is the last statement of the result's
// transaction (§10.6); a job that ends `dead` also notifies the holders of `system.jobs.read` (M34).

/** A progress or message change is written at once when this long has passed since the last write. */
const PROGRESS_MIN_GAP_MS = 2_000;
/** In piggyback mode the heartbeat yields to the event loop when this long has passed since the last yield (§10.2). */
const PIGGYBACK_YIELD_MS = 50;
/** `last_error` and `progress_message`: at most this many characters (code points). */
const TEXT_MAX = 500;

/** What runSlice runs with. */
export interface RunSliceOptions {
  mode: RunMode;
  /** The slice's budget (≤ SLICE_BUDGET_MS); `ctx.budgetLeftMs()` counts it down. */
  budgetMs: number;
  keyring: readonly KeyringEntry[];
  log: CoreLogger;
  clock: () => number;
  env: Env;
}

// ---------------------------------------------------------------------------------------------------------------
// Job sessions (C38): a value this process keeps for a job across its consecutive slices (a snapshot connection).
//
// Each entry carries a stamp: the job as this process left it at the end of its last slice (`updated_at` and the
// checkpoint text it wrote, with `attempts = 0`). Claims leave `updated_at` alone and every other write of the job
// (a slice's result, a heartbeat, a cancel request, a retry) sets it, so a job whose row no longer matches the stamp
// has been run (or touched) by someone else since, and its session is stale: the next slice gets a fresh one. While a
// slice of the job runs in this process the stamp is null, and nothing but that slice closes the session.
//
// A slice closes or keeps only the entry it took or opened itself, compared by identity: a slice that stalled past its
// lease can still be running when this process reclaims its job, and each of the two slices then has its own entry.
// The map holds the job's current one. An entry a slice opens while the map holds another one of its job stays out of
// the map; only a slice that continued the job makes its entry current there (settleSession). An entry in use that a
// newer one replaced there is still closed by its slice.

interface SessionEntry {
  value: unknown;
  close: (value: unknown) => Promise<void>;
  /** See above; null while a slice of the job runs in this process. */
  stamp: { updatedAt: number; payload: string } | null;
  /** Set when it is closed: an entry is closed once, by whichever of its slice, a prune or the drain comes first. */
  closed: boolean;
}

const sessions = new Map<string, SessionEntry>();

/** Whether the job's row (`updatedAt`, payload text, attempts) is still as this process's last slice left it. */
function matchesStamp(entry: SessionEntry, row: { updatedAt: number; payload: string | undefined; attempts: number }): boolean {
  const s = entry.stamp;
  return s !== null && s.updatedAt === row.updatedAt && s.payload === row.payload && row.attempts === 0;
}

/** Closes `entry` (once), and removes it from the map while it is still job `jobId`'s current session. */
async function closeEntry(jobId: string, entry: SessionEntry, log: CoreLogger | undefined): Promise<void> {
  if (sessions.get(jobId) === entry) sessions.delete(jobId);
  if (entry.closed) return;
  entry.closed = true;
  try {
    await entry.close(entry.value);
  } catch (error) {
    log?.warn('jobs: closing a job session failed', { jobId, ...errorFields(error) });
  }
}

/**
 * Closes every job session this process keeps (the runtime's drain, P14). Close errors are logged with `log` (or
 * dropped without one), never thrown.
 */
export async function closeJobSessions(log?: CoreLogger): Promise<void> {
  for (const [jobId, entry] of [...sessions.entries()]) await closeEntry(jobId, entry, log);
}

/**
 * Closes the idle sessions (no slice of this process running their job) of every job but those in `keep`. The runner
 * calls it while a maintenance flag pauses the claims (`keep`: the flag's exempt jobs, none during a restore): a paused
 * job's session is a snapshot transaction on MySQL/MariaDB/PostgreSQL, whose table locks the DDL of a `migrate` or
 * `reset` op would wait for, and its next slice, whenever it runs, starts from its checkpoint with a fresh session
 * (C12). Close errors are logged with `log` (or dropped without one), never thrown.
 */
export async function closeIdleJobSessions(keep: readonly string[], log?: CoreLogger): Promise<void> {
  for (const [jobId, entry] of [...sessions.entries()]) {
    // Checked with no await before the close: a slice that took the entry meanwhile (stamp null) keeps it.
    if (sessions.get(jobId) === entry && entry.stamp !== null && !keep.includes(jobId)) await closeEntry(jobId, entry, log);
  }
}

/**
 * Closes the sessions of jobs that no slice of this process is running and that have ended or been run by another
 * process since this process's last slice of them (see the stamps above). runSlice calls it before each slice; the
 * runner may call it between passes too, so that an idle process lets go of a session (a snapshot connection) once
 * another process has taken its job over. A failed read is logged, never thrown.
 */
export async function pruneJobSessions(h: DbHandle, log?: CoreLogger): Promise<void> {
  const idle = [...sessions.entries()].filter(([, e]) => e.stamp !== null);
  if (idle.length === 0) return;
  let rows: { id: string; status: string; updated_at: number; payload: string; attempts: number }[];
  try {
    const ids = idle.map(([id]) => id);
    rows = await h.db.selectFrom('jobs').select(['id', 'status', 'updated_at', 'payload', 'attempts']).where('id', 'in', ids).execute();
  } catch (error) {
    log?.warn('jobs: reading the jobs of job sessions failed', errorFields(error));
    return;
  }
  const byId = new Map(rows.map((r) => [r.id, r]));
  for (const [id, entry] of idle) {
    // A slice of it started meanwhile, or a newer entry replaced it: that slice decides.
    if (sessions.get(id) !== entry || entry.stamp === null) continue;
    const r = byId.get(id);
    const live = r !== undefined && (r.status === 'queued' || r.status === 'running');
    if (!live || !matchesStamp(entry, { updatedAt: Number(r.updated_at), payload: r.payload, attempts: Number(r.attempts) })) {
      await closeEntry(id, entry, log);
    }
  }
}

/**
 * Before a slice of `job`: the session it may keep, or undefined. An idle session is kept (marked in use, stamp null,
 * until the slice ends) when this process ran the job's previous slice and nobody has written the job since, and
 * closed otherwise. A session in use belongs to another slice of the job in this process (one that stalled past its
 * lease): it is left to that slice, and this slice opens its own.
 */
async function takeSession(job: ClaimedJob, log: CoreLogger): Promise<SessionEntry | undefined> {
  const entry = sessions.get(job.id);
  if (entry === undefined || entry.stamp === null) return undefined;
  let payload: string | undefined;
  try {
    payload = JSON.stringify(job.payload);
  } catch {
    payload = undefined;
  }
  if (matchesStamp(entry, { updatedAt: job.updatedAt, payload, attempts: job.attempts })) {
    entry.stamp = null;
    return entry;
  }
  await closeEntry(job.id, entry, log);
  return undefined;
}

/**
 * After a slice: `entry` (the session the slice took or opened) is kept for the job's next slice with `stamp` when the
 * slice continued the job, else closed. A kept entry becomes the job's current one; one it replaces there is closed
 * when idle (stale), and left to its own slice when in use.
 */
async function settleSession(jobId: string, entry: SessionEntry | undefined, stamp: SessionEntry['stamp'], log: CoreLogger): Promise<void> {
  if (entry === undefined) return;
  if (stamp === null || entry.closed) {
    await closeEntry(jobId, entry, log);
    return;
  }
  entry.stamp = stamp;
  const previous = sessions.get(jobId);
  if (previous === entry) return;
  sessions.set(jobId, entry);
  if (previous !== undefined && previous.stamp !== null) await closeEntry(jobId, previous, log);
}

// ---------------------------------------------------------------------------------------------------------------

/** `s` cut to {@link TEXT_MAX} code points. */
function capText(s: string): string {
  const points = [...s];
  return points.length <= TEXT_MAX ? s : points.slice(0, TEXT_MAX).join('');
}

/**
 * `last_error` for `e`: the DomainError code plus its authored detail, or the error's name only — never a message,
 * which could quote a driver's SQL or values.
 */
function errorText(e: unknown): string {
  if (isDomainError(e)) return capText(e.detail === undefined ? e.code : `${e.code}: ${e.detail}`);
  if (e instanceof Error && typeof e.name === 'string' && e.name !== '') return capText(e.name);
  return 'Error';
}

function leaseLost(): DomainError {
  return new DomainError('JOB_LEASE_LOST', {
    detail: 'Tugas sudah diambil alih proses lain / The job was taken over by another process',
  });
}

/** A progress of 0-100, rounded. @throws TypeError for anything but a finite number */
function progressOf(p: unknown): number {
  if (typeof p !== 'number' || !Number.isFinite(p)) throw new TypeError('jobs: progress must be a finite number from 0 to 100');
  return Math.min(100, Math.max(0, Math.round(p)));
}

function messageOf(m: unknown): string {
  if (typeof m !== 'string') throw new TypeError('jobs: a progress message must be a string');
  return capText(m);
}

/** The value of `k` in the payload, as the `kill-mid-slice:<k>` fault spells it, or null. */
function payloadK(payload: unknown): string | null {
  if (typeof payload !== 'object' || payload === null || !Object.prototype.hasOwnProperty.call(payload, 'k')) return null;
  const k: unknown = (payload as { k?: unknown }).k;
  return typeof k === 'number' || typeof k === 'string' ? String(k) : null;
}

type Plan =
  | { kind: 'lost' }
  | { kind: 'done'; message: string | null }
  | { kind: 'continue'; payload: string; progress: number; message: string | null }
  | { kind: 'wait'; until: number; message: string | null }
  | { kind: 'error'; error: string };

/** What the handler's result asks for; a malformed result or checkpoint is an error. */
function planOf(handler: JobHandler<unknown>, outcome: unknown): Plan {
  if (typeof outcome === 'object' && outcome !== null) {
    if ((outcome as { done?: unknown }).done === true && !('continueWith' in outcome)) {
      const m = (outcome as { message?: unknown }).message;
      if (m === undefined) return { kind: 'done', message: null };
      try {
        return { kind: 'done', message: messageOf(m) };
      } catch (error) {
        return { kind: 'error', error: errorText(error) };
      }
    }
    if ('continueWith' in outcome) {
      const o = outcome as { continueWith: unknown; progress: unknown; message?: unknown };
      const parsed = handler.payload.safeParse(o.continueWith);
      if (!parsed.success) return { kind: 'error', error: 'VALIDATION_FAILED' };
      let payload: string | undefined;
      let progress: number;
      let message: string | null;
      try {
        payload = JSON.stringify(parsed.data);
        progress = progressOf(o.progress);
        message = o.message === undefined ? null : messageOf(o.message);
      } catch (error) {
        return { kind: 'error', error: errorText(error) };
      }
      // Not JSON, or too large for `jobs.payload` (TEXT): a programming error of the handler.
      if (typeof payload !== 'string' || Buffer.byteLength(payload, 'utf8') > JOB_PAYLOAD_MAX) return { kind: 'error', error: 'TypeError' };
      return { kind: 'continue', payload, progress, message };
    }
    if ('waitUntil' in outcome && !('done' in outcome)) {
      const o = outcome as { waitUntil: unknown; message?: unknown };
      if (typeof o.waitUntil !== 'number' || !Number.isSafeInteger(o.waitUntil) || o.waitUntil < 0) return { kind: 'error', error: 'TypeError' };
      try {
        return { kind: 'wait', until: o.waitUntil, message: o.message === undefined ? null : messageOf(o.message) };
      } catch (error) {
        return { kind: 'error', error: errorText(error) };
      }
    }
  }
  return { kind: 'error', error: 'TypeError' };
}

type JobsUpdate = UpdateQueryBuilder<DB, 'jobs', 'jobs', UpdateResult>;

/** The fencing condition of every write of the slice. */
function fenced(q: JobsUpdate, job: ClaimedJob): JobsUpdate {
  return q.where('id', '=', job.id).where('lock_token', '=', job.token).where('status', '=', 'running');
}

/** Not to be cancelled: no cancel requested, or past the point of no return. */
function notCancelled(q: JobsUpdate): JobsUpdate {
  return q.where((eb) => eb.or([eb('cancel_requested', '=', 0), eb('point_of_no_return', '=', 1)]));
}

const changed = (r: UpdateResult): boolean => Number(r.numUpdatedRows) === 1;

const CLEARED_LOCK = { lock_token: null, locked_by: null, locked_until: null } as const;

/** The result of `plan` written in `trx` at `now`; the slice's outcome. */
async function writeResult(trx: Transaction<DB>, job: ClaimedJob, plan: Plan, now: number): Promise<SliceResult['outcome']> {
  const channel = `jobs.${job.id}`;
  const finished = (status: string) => publish(trx, { channel, type: 'job.finished', payload: { status } });
  /** The cancelled end of a job whose cancel was requested, instead of queuing it again. */
  const cancel = async (extra: { payload?: string; last_error?: string; attempts?: number; progress?: number }) => {
    const r = await fenced(trx.updateTable('jobs'), job)
      .set({ ...extra, status: 'cancelled', unique_key: null, ...CLEARED_LOCK, secret_param: null, finished_at: now, updated_at: now })
      .where('cancel_requested', '=', 1)
      .where('point_of_no_return', '=', 0)
      .executeTakeFirst();
    if (!changed(r)) return 'lost' as const;
    await finished('cancelled');
    return 'cancelled' as const;
  };

  switch (plan.kind) {
    case 'lost':
      return 'lost';
    case 'done': {
      const r = await fenced(trx.updateTable('jobs'), job)
        .set({
          status: 'succeeded',
          unique_key: null,
          ...CLEARED_LOCK,
          secret_param: null,
          progress: 100,
          ...(plan.message === null ? {} : { progress_message: plan.message }),
          finished_at: now,
          updated_at: now,
        })
        .executeTakeFirst();
      if (!changed(r)) return 'lost';
      await finished('succeeded');
      return 'succeeded';
    }
    case 'continue': {
      const r = await notCancelled(fenced(trx.updateTable('jobs'), job))
        .set({
          status: 'queued',
          run_at: now,
          attempts: 0,
          payload: plan.payload,
          ...CLEARED_LOCK,
          progress: plan.progress,
          progress_message: plan.message,
          updated_at: now,
        })
        .executeTakeFirst();
      if (!changed(r)) return cancel({ payload: plan.payload, progress: plan.progress });
      await publish(trx, { channel, type: 'job.progress', payload: { status: 'queued', progress: plan.progress } });
      return 'continued';
    }
    case 'wait': {
      const r = await notCancelled(fenced(trx.updateTable('jobs'), job))
        .set({
          status: 'queued',
          run_at: plan.until,
          ...CLEARED_LOCK,
          ...(plan.message === null ? {} : { progress_message: plan.message }),
          updated_at: now,
        })
        .executeTakeFirst();
      if (!changed(r)) return cancel({});
      await publish(trx, { channel, type: 'job.progress', payload: { status: 'queued' } });
      return 'waiting';
    }
    case 'error': {
      const attempts = job.attempts + 1;
      if (attempts >= job.maxAttempts) {
        const r = await notCancelled(fenced(trx.updateTable('jobs'), job))
          .set({
            status: 'dead',
            attempts,
            last_error: plan.error,
            unique_key: null,
            ...CLEARED_LOCK,
            secret_param: null,
            finished_at: now,
            updated_at: now,
          })
          .executeTakeFirst();
        if (!changed(r)) return cancel({ last_error: plan.error, attempts });
        await jobDead(trx, job.id, job.type, now);
        return 'dead';
      }
      const r = await notCancelled(fenced(trx.updateTable('jobs'), job))
        .set({ status: 'queued', attempts, last_error: plan.error, run_at: now + retryDelayMs(attempts), ...CLEARED_LOCK, updated_at: now })
        .executeTakeFirst();
      if (!changed(r)) return cancel({ last_error: plan.error, attempts });
      await publish(trx, { channel, type: 'job.progress', payload: { status: 'queued' } });
      return 'retry';
    }
  }
}

/**
 * Runs one slice of the claimed `job` (spec §10.1): the handler's `run(ctx, payload)` with a {@link JobContext}, then
 * its result written under the claim's token (see the top of this file). Afterwards `jobs:heavy` is released for a
 * heavy job, and the session this slice took or opened is closed unless the slice continued the job.
 *
 * The stored payload is checked by the handler's schema first (a payload it refuses takes the error path without
 * running the handler). The test fault `kill-mid-slice:<k>` (Task 2 grammar, S13) kills the process after `run()`
 * resolved and before its result is written, on the slice whose payload `k` is `<k>`.
 *
 * Call it outside any withTx callback: the context's heartbeat and audit, and the result, run their own
 * transactions.
 *
 * @returns what the slice did; `error` holds the stored `last_error` of a `retry` or `dead`
 * @throws TypeError when the job's type has no handler in `reg`; whatever the handler's payload schema (on the stored
 *   payload or on the checkpoint) or the result's transaction throws. The slice's session is then closed and
 *   `jobs:heavy` released; the lease simply expires, and the job is reclaimed.
 */
export async function runSlice(h: DbHandle, reg: JobRegistry, job: ClaimedJob, o: RunSliceOptions): Promise<SliceResult> {
  const handler = reg.get(job.type);
  if (handler === undefined) throw new TypeError(`runSlice: no handler for job type ${JSON.stringify(job.type)}`);
  const { clock, log } = o;
  const start = clock();
  const deadline = start + o.budgetMs;

  /** The job session this slice took or opened (closed or kept only by this slice, see settleSession). */
  let mine: SessionEntry | undefined;
  let lost = false;
  let pastNoReturn = job.pointOfNoReturn;
  // A request made before this claim (the previous holder died before its heartbeat) counts from the start.
  let cancelled = job.cancelRequested === true && !pastNoReturn;
  let lastWrite = start;
  let lastYield = start;
  let progress: number | null = null;
  let message: string | null | undefined;
  let pending = false;

  const ctx: JobContext = {
    jobId: job.id,
    mode: o.mode,
    async heartbeat(p) {
      if (o.mode === 'piggyback' && clock() - lastYield >= PIGGYBACK_YIELD_MS) {
        await yieldToLoop();
        lastYield = clock();
      }
      if (lost) throw leaseLost();
      if (p?.progress !== undefined) {
        const v = progressOf(p.progress);
        if (v !== progress) {
          progress = v;
          pending = true;
        }
      }
      if (p?.message !== undefined) {
        const m = messageOf(p.message);
        if (m !== message) {
          message = m;
          pending = true;
        }
      }
      const now = clock();
      const since = now - lastWrite;
      if (since < JOB_HEARTBEAT_MS && !(pending && since >= PROGRESS_MIN_GAP_MS)) return;
      const announce = pending;
      const flags = await withTx(h, async (trx) => {
        const r = await fenced(trx.updateTable('jobs'), job)
          .set({
            locked_until: now + JOB_LEASE_MS,
            updated_at: now,
            ...(progress === null ? {} : { progress }),
            ...(message === undefined ? {} : { progress_message: message }),
          })
          .executeTakeFirst();
        if (!changed(r)) return null;
        const row = await trx.selectFrom('jobs').select(['cancel_requested', 'point_of_no_return']).where('id', '=', job.id).executeTakeFirstOrThrow();
        if (announce) {
          await publish(trx, {
            channel: `jobs.${job.id}`,
            type: 'job.progress',
            payload: progress === null ? { status: 'running' } : { status: 'running', progress },
          });
        }
        return row;
      });
      if (flags === null) {
        lost = true;
        throw leaseLost();
      }
      lastWrite = now;
      pending = false;
      pastNoReturn = Number(flags.point_of_no_return) === 1;
      cancelled = Number(flags.cancel_requested) === 1 && !pastNoReturn;
      // S27: the heavy lock lives as long as the lease.
      if (job.heavy && !(await claimLock(h, HEAVY_LOCK, job.token, JOB_LEASE_MS))) {
        lost = true;
        throw leaseLost();
      }
    },
    cancelled: () => cancelled && !pastNoReturn,
    async markPointOfNoReturn() {
      if (lost) throw leaseLost();
      const now = clock();
      const r = await fenced(h.db.updateTable('jobs'), job).set({ point_of_no_return: 1, updated_at: now }).executeTakeFirst();
      if (!changed(r)) {
        lost = true;
        throw leaseLost();
      }
      pastNoReturn = true;
    },
    async secretParam() {
      const row = await h.db.selectFrom('jobs').select('secret_param').where('id', '=', job.id).executeTakeFirst();
      if (row === undefined || row.secret_param === null) return null;
      const text = openValue(o.keyring, secretAad('jobs', 'secret_param', job.id), row.secret_param);
      if (text === '') return new Uint8Array(0);
      const bytes = decodeBase64Url(text);
      if (bytes === null) {
        throw new DomainError('SECRET_UNREADABLE', {
          detail: 'Nilai rahasia tersimpan tidak dapat dibuka / A stored secret cannot be opened',
          meta: { reason: 'malformed' },
        });
      }
      return new Uint8Array(bytes);
    },
    async audit(e) {
      await withTx(h, (trx) =>
        txCtx(trx, clock(), { type: 'system', id: null, ip: null }).audit({ ...e, meta: { ...(e.meta ?? {}), jobId: job.id } }),
      );
    },
    async session<T>(open: () => Promise<T>, close: (s: T) => Promise<void>) {
      if (mine !== undefined && !mine.closed) return { value: mine.value as T, fresh: false };
      const value = await open();
      const entry: SessionEntry = { value, close: close as (v: unknown) => Promise<void>, stamp: null, closed: false };
      mine = entry;
      // Another entry of the job in the map is never closed or replaced here: takeSession left only one in use by an
      // older slice there, and an idle one has been kept since by a newer slice that continued the job, which makes
      // this slice the stale one. This entry then stays out of the map until settleSession keeps or closes it.
      if (!sessions.has(job.id)) sessions.set(job.id, entry);
      return { value, fresh: true };
    },
    db: h.db,
    handle: h,
    log,
    now: clock,
    budgetLeftMs: () => Math.max(0, deadline - clock()),
  };

  let plan: Plan = { kind: 'lost' };
  let outcome: SliceResult['outcome'] = 'lost';
  let end = start;
  // Every exit path from here on settles the slice's session and releases jobs:heavy, also when runSlice throws (a
  // payload schema whose refine throws, on the stored payload or on the checkpoint, or the result's transaction).
  try {
    mine = await takeSession(job, log);
    await pruneJobSessions(h, log);

    const parsed = handler.payload.safeParse(job.payload);
    if (!parsed.success) {
      plan = { kind: 'error', error: 'VALIDATION_FAILED' };
    } else {
      let result: JobOutcome<unknown> | undefined;
      let failure: unknown;
      let failed = false;
      try {
        result = await handler.run(ctx, parsed.data);
      } catch (error) {
        failed = true;
        failure = error;
      }
      if (!failed) {
        const k = faultArmed(o.env, 'kill-mid-slice');
        if (k !== null && k !== '' && payloadK(job.payload) === k) killSelf();
      }
      if (lost) plan = { kind: 'lost' };
      else if (failed) plan = { kind: 'error', error: errorText(failure) };
      else plan = planOf(handler, result);
    }

    end = clock();
    outcome = await withTx(h, (trx) => writeResult(trx, job, plan, end));
  } finally {
    const stamp = outcome === 'continued' && plan.kind === 'continue' ? { updatedAt: end, payload: plan.payload } : null;
    await settleSession(job.id, mine, stamp, log);
    if (job.heavy) {
      try {
        await releaseLock(h, HEAVY_LOCK, job.token);
      } catch (error) {
        log.warn('jobs: releasing jobs:heavy failed', { jobId: job.id, ...errorFields(error) });
      }
    }
  }
  const result: SliceResult = { jobId: job.id, type: job.type, outcome };
  if ((outcome === 'retry' || outcome === 'dead') && plan.kind === 'error') result.error = plan.error;
  return result;
}
