import type { DbHandle } from '@altis/db';
import { isEnvSet, type Env, type Runtime } from '@altis/platform';
import { errorFields, type CoreLogger } from '../context.js';
import type { KeyringEntry } from '../crypto/secret-box.js';
import { activeOp, readMaintenance, type MaintenanceFlag } from '../ops/files.js';
import type { OpStatus, OpsMachine } from '../ops/machine.js';
import { readSettings } from '../settings/service.js';
import { claimById, claimNext } from './claim.js';
import { closeIdleJobSessions, pruneJobSessions, runSlice } from './slice.js';
import { JOB_LEASE_MS, SLICE_BUDGET_MS, type ClaimedJob, type JobRegistry, type RunMode, type SliceResult } from './types.js';

// The runner (spec §10.2, decisions C36, C38; preflight B5, S2): what each runner mode does with the queue.
//
// A pass (worker loop, `jobs:run`, `POST /_cron`):
//   1. an active op (or the flag of one that ended) → `ops.step(budget left)`: ops come before jobs (spec §9.4);
//   2. a maintenance flag → only its `exemptJobIds` may be claimed (none during a restore, whose tables may be gone,
//      S2), and no scheduler tick; the idle job sessions of every other job are closed, before the op is stepped (a
//      paused snapshot transaction would hold the table locks an op's DDL waits for; the job's next slice starts from
//      its checkpoint, C12);
//   3. otherwise the scheduler tick (Task 14), then the jobs for what is left of the budget.
//
// Slices per call (decision C38, preflight B5); every slice is ≤ 20 s (P9), with one recorded exception: a resumed
// `.sql.gz` split slice of a SLiMS migration without its kept reader runs its re-inflation skip on top of its budget,
// renewing its lease every 64 MiB (decision P9-SLICE-GZ-LANJUT of the Phase 2 follow-ups):
//   worker, cron_cli   claim after claim until the budget is spent; a `longRunning` job whose slice continued is
//                      handed to a task of its own (ruling R1c-7), which claims it again at once by id (`claimById`),
//                      so its session (a snapshot transaction) stays in this process, and goes on past the budget until
//                      the job ends (§10.2 "tugas longRunning dijalankan sampai selesai"), may no longer run here, or
//                      the runtime drains. The call does not wait for that task: the runtime adopts it
//                      (`adoptLongJob`, which tracks it for the drain), and the passes after it keep stepping the op,
//                      ticking, running light slices and recording runs; only their heavy lane is skipped while it runs;
//   cron_http, drive   at most one slice of each job per call, so a host whose only scheduler is the curl line still
//                      finishes every job, one slice per call;
//   piggyback          one slice in all, never a `cpuHeavy` or `longRunning` job, nor one whose handler says
//                      `piggyback: false` (it begins an op, which piggyback never steps).
//
// Concurrency (§10.2 "≤ 1 tugas berat per instalasi; ringan ≤ 2 per proses"): a call runs one heavy lane (its claims
// need the named lock `jobs:heavy`, which also keeps other processes out; none while this runner's long job runs on
// its own) and two light lanes; the light slices of this runner (this process), drive's included, share
// {@link LIGHT_PER_PROCESS} slots. The claims of one call are made one at a time, so a job one lane ran is never
// claimed again by another lane of a one-slice-per-job call.

/** `jobs:run`'s default budget, in seconds (spec §10.2: "default 270 detik total"). */
export const JOBS_RUN_DEFAULT_S = 270;

/** Light slices one process runs at once (spec §10.2). */
export const LIGHT_PER_PROCESS = 2;

/** A claim needs this much of its call's budget left; a slice given less could do nothing useful. */
const MIN_SLICE_MS = 250;

/** Queued and expired jobs looked at for a one-slice-per-job call's next claim. */
const CANDIDATES = 100;

/**
 * The runner mode of a process (spec §10.2): `worker` (a loop inside the process) on every runtime but `passenger` and
 * `litespeed`, whose processes may run no timer, unless `ALTIS_RUNNER=off`; `external` otherwise (cron, drive and
 * piggyback do the work).
 */
export function runnerMode(runtime: Runtime, env: Env): 'worker' | 'external' {
  if (runtime === 'passenger' || runtime === 'litespeed') return 'external';
  if (isEnvSet(env, 'ALTIS_RUNNER') && env['ALTIS_RUNNER']!.trim().toLowerCase() === 'off') return 'external';
  return 'worker';
}

/** What a pass did: the op's status after its step (null without one), the jobs the scheduler enqueued, slices run. */
export interface PassReport {
  op: OpStatus | null;
  scheduled: number;
  slices: number;
}

export interface Runner {
  /** One pass (see the top of this file) within `budgetMs`. */
  pass(o: { budgetMs: number; mode: RunMode }): Promise<PassReport>;
  /** The jobs part of a pass: slices as `mode` allows within `budgetMs` (`excludeHeavy`: no heavy job). */
  runFor(o: { budgetMs: number; mode: RunMode; excludeHeavy?: boolean }): Promise<SliceResult[]>;
  /**
   * One slice of job `jobId` (mode `drive`), or null when it cannot be claimed now, or when it is a light job and both
   * of this process's light slots are taken (R1c-7).
   */
  driveJob(jobId: string, o: { budgetMs: number }): Promise<SliceResult | null>;
}

export interface RunnerOptions {
  /** This process's live handle; undefined while there is none (no job is claimed then). */
  db(): DbHandle | undefined;
  reg: JobRegistry;
  ops: OpsMachine;
  dataDir: string;
  /** The scheduler's tick (Task 14): the number of jobs it enqueued; null until there is one. */
  scheduler: { tick(now: number): Promise<number> } | null;
  keyring(): readonly KeyringEntry[];
  /** Epoch ms: the claims' and the slices' clock. */
  clock(): number;
  log: CoreLogger;
  /** The process environment (the test fault `kill-mid-slice` is read from it). */
  env: Env;
  /** `locked_by` of this runner's claims: 1-191 characters, no control character, no trailing blank. */
  worker: string;
  /** True once the runtime drains (P14): no new claim, no op step; slices already running finish. */
  stopping?(): boolean;
  /**
   * Takes each continued `longRunning` job this runner goes on running on its own (R1c-7: worker and cron_cli) as it
   * starts: the task settles, never rejecting, with the number of slices it ran after the first (which its pass
   * reported), once the job ends, may no longer run here, or `stopping()`. The runtime tracks it for its drain.
   * Without it nobody waits for that task.
   */
  adoptLongJob?(task: Promise<number>): void;
}

function checkBudget(budgetMs: number, caller: string): void {
  if (typeof budgetMs !== 'number' || !Number.isFinite(budgetMs) || budgetMs < 0) {
    throw new TypeError(`${caller}: budgetMs must be a finite number of at least 0`);
  }
}

/**
 * The runner of one process. The light-slot count lives in it, so a process has exactly one (the job runtime's, or
 * the one `jobs:run` makes).
 */
export function createRunner(o: RunnerOptions): Runner {
  const { reg, log } = o;
  const stopping = (): boolean => o.stopping?.() === true;
  const heavyTypes = reg.types().filter((type) => {
    const handler = reg.get(type);
    return handler?.cpuHeavy === true || handler?.longRunning === true;
  });
  const isLong = (type: string): boolean => reg.get(type)?.longRunning === true;
  /** The light types piggyback may take: not the ones whose handler says `piggyback: false`. */
  const piggybackTypes = reg.types().filter((type) => reg.get(type)?.piggyback !== false && !heavyTypes.includes(type));
  /** A failure while the runtime drains is the drain's (its database may be closing): not worth a warning. */
  const warn = (msg: string, fields: Record<string, unknown>): void => {
    if (!stopping()) log.warn(msg, fields);
  };
  /** Light slices of this process running now. */
  let lightBusy = 0;
  /** The continued `longRunning` job running on its own (R1c-7), or null: the heavy lane waits while it runs. */
  let longJob: Promise<number> | null = null;

  /** The jobs a maintenance flag lets be claimed: its exempt ids, none at all during a restore. */
  const pausedKeep = (flag: MaintenanceFlag): readonly string[] => (flag.reason === 'restore' ? [] : flag.exemptJobIds);

  /** What maintenance lets be claimed: null (no maintenance), or what {@link pausedKeep} says. */
  async function claimable(): Promise<readonly string[] | null> {
    const flag = await readMaintenance(o.dataDir);
    return flag === null ? null : pausedKeep(flag);
  }

  /** Whether `clock_anomaly` is raised (§10.4): a lease far ahead then counts as expired (claimNext's `anomaly`). */
  async function anomalyActive(h: DbHandle): Promise<boolean> {
    try {
      const value = (await readSettings(h.db, ['system.clock_anomaly'], []))['system.clock_anomaly'];
      return value !== null && value !== undefined;
    } catch (error) {
      warn('jobs: reading clock_anomaly failed', errorFields(error));
      return false;
    }
  }

  /** The jobs a one-slice-per-job call may claim next: queued and due, or holding an expired lease; none it ran. */
  async function candidates(h: DbHandle, now: number, anomaly: boolean, exempt: readonly string[] | null, ran: ReadonlySet<string>): Promise<string[]> {
    const expired = await h.db
      .selectFrom('jobs')
      .select('id')
      .where('status', '=', 'running')
      .where((eb) =>
        anomaly ? eb.or([eb('locked_until', '<', now), eb('locked_until', '>', now + 2 * JOB_LEASE_MS)]) : eb('locked_until', '<', now),
      )
      .orderBy('locked_until')
      .orderBy('id')
      .limit(CANDIDATES)
      .execute();
    const queued = await h.db
      .selectFrom('jobs')
      .select('id')
      .where('status', '=', 'queued')
      .where('run_at', '<=', now)
      .orderBy('run_at')
      .orderBy('id')
      .limit(CANDIDATES)
      .execute();
    return [...expired, ...queued].map((r) => r.id).filter((id) => !ran.has(id) && (exempt === null || exempt.includes(id)));
  }

  function slice(h: DbHandle, job: ClaimedJob, mode: RunMode, budgetMs: number): Promise<SliceResult> {
    return runSlice(h, reg, job, { mode, budgetMs, keyring: o.keyring(), log, clock: o.clock, env: o.env });
  }

  /**
   * C38, R1c-7: the slices after the first of a continued `longRunning` job, each claimed again at once by id, until
   * the job ends, may no longer be claimed (maintenance, another claimant) or the runner is stopping. The slices it
   * ran; never rejects.
   */
  async function followLong(h: DbHandle, job: ClaimedJob, mode: RunMode): Promise<number> {
    let slices = 0;
    for (;;) {
      if (stopping()) return slices;
      let again: ClaimedJob | null;
      try {
        const allowed = await claimable();
        if (allowed !== null && !allowed.includes(job.id)) {
          // Paused by maintenance: its session is not kept idle meanwhile (see pass).
          await closeIdleJobSessions(allowed, log);
          return slices;
        }
        const anomaly = await anomalyActive(h);
        again = await claimById(h, reg, job.id, { worker: o.worker, now: o.clock(), exempt: allowed, anomaly, types: heavyTypes });
      } catch (error) {
        warn('jobs: a claim failed', { jobId: job.id, type: job.type, mode, ...errorFields(error) });
        return slices;
      }
      if (again === null) return slices;
      let result: SliceResult;
      try {
        result = await slice(h, again, mode, SLICE_BUDGET_MS);
      } catch (error) {
        log.warn('jobs: a slice failed', { jobId: job.id, type: job.type, mode, ...errorFields(error) });
        return slices;
      }
      slices += 1;
      if (result.outcome !== 'continued') return slices;
    }
  }

  /** Hands a continued `longRunning` job to a task of its own (R1c-7), which the runtime adopts. */
  function startLong(h: DbHandle, job: ClaimedJob, mode: RunMode): void {
    const task = followLong(h, job, mode);
    longJob = task;
    void task.then(() => {
      if (longJob === task) longJob = null;
    });
    o.adoptLongJob?.(task);
  }

  async function runFor(r: { budgetMs: number; mode: RunMode; excludeHeavy?: boolean }): Promise<SliceResult[]> {
    checkBudget(r.budgetMs, 'runFor');
    const h = o.db();
    if (h === undefined || stopping()) return [];
    const exempt = await claimable();
    if (exempt !== null && exempt.length === 0) return [];
    const anomaly = await anomalyActive(h);
    const deadline = o.clock() + r.budgetMs;
    const piggyback = r.mode === 'piggyback';
    const onePerJob = piggyback || r.mode === 'cron_http' || r.mode === 'drive';
    const sticky = r.mode === 'worker' || r.mode === 'cron_cli';
    const excludeHeavy = piggyback || r.excludeHeavy === true;
    const results: SliceResult[] = [];
    const ran = new Set<string>();
    let started = 0;
    // The claims of this call, one at a time.
    let turn: Promise<unknown> = Promise.resolve();

    /** The next job of a lane, or null when the lane is done. A light job holds one of the process's slots. */
    function claimOne(heavy: boolean): Promise<ClaimedJob | null> {
      const next = turn.then(async (): Promise<ClaimedJob | null> => {
        if (stopping() || (piggyback && started >= 1) || deadline - o.clock() < MIN_SLICE_MS) return null;
        // A long job that another call of this runner started meanwhile runs on its own (R1c-7).
        if (heavy && longJob !== null) return null;
        if (!heavy && lightBusy >= LIGHT_PER_PROCESS) return null;
        let allow = exempt;
        if (onePerJob && ran.size > 0) {
          allow = await candidates(h!, o.clock(), anomaly, exempt, ran);
          if (allow.length === 0) return null;
        }
        // Checked again with no await before the increment: another call of this runner may have taken a slot.
        if (!heavy) {
          if (lightBusy >= LIGHT_PER_PROCESS) return null;
          lightBusy += 1;
        }
        let job: ClaimedJob | null = null;
        try {
          job = await claimNext(h!, reg, {
            worker: o.worker,
            now: o.clock(),
            exempt: allow,
            anomaly,
            ...(heavy ? { types: heavyTypes } : { excludeHeavy: true, ...(piggyback ? { types: piggybackTypes } : {}) }),
          });
        } finally {
          if (job === null && !heavy) lightBusy -= 1;
        }
        if (job !== null) {
          ran.add(job.id);
          started += 1;
        }
        return job;
      });
      turn = next.catch(() => undefined);
      return next;
    }

    async function lane(heavy: boolean): Promise<void> {
      for (;;) {
        let job: ClaimedJob | null;
        try {
          job = await claimOne(heavy);
        } catch (error) {
          warn('jobs: a claim failed', { mode: r.mode, ...errorFields(error) });
          return;
        }
        if (job === null) return;
        let result: SliceResult;
        try {
          const budget = Math.min(SLICE_BUDGET_MS, Math.max(MIN_SLICE_MS, deadline - o.clock()));
          result = await slice(h!, job, r.mode, budget);
          results.push(result);
        } catch (error) {
          log.warn('jobs: a slice failed', { jobId: job.id, type: job.type, mode: r.mode, ...errorFields(error) });
          return;
        } finally {
          if (!heavy) lightBusy -= 1;
        }
        // C38, R1c-7: the job goes on on its own, and this lane ends (the job is this process's one heavy job now).
        if (sticky && result.outcome === 'continued' && isLong(job.type) && !stopping()) {
          startLong(h!, job, r.mode);
          return;
        }
      }
    }

    const lanes: Promise<void>[] = [];
    // R1c-7: no heavy lane while this runner's long job runs on its own. It does not hold `jobs:heavy` between its
    // slices (each slice releases it and followLong claims it again), so another process's heavy lane may take the job
    // in that window; followLong then stops.
    if (!excludeHeavy && heavyTypes.length > 0 && longJob === null) lanes.push(lane(true));
    for (let i = 0; i < (piggyback ? 1 : LIGHT_PER_PROCESS); i += 1) lanes.push(lane(false));
    await Promise.all(lanes);
    return results;
  }

  async function pass(p: { budgetMs: number; mode: RunMode }): Promise<PassReport> {
    checkBudget(p.budgetMs, 'pass');
    const deadline = o.clock() + p.budgetMs;
    let op: OpStatus | null = null;
    if (stopping()) return { op, scheduled: 0, slices: 0 };
    const [active, raised] = await Promise.all([activeOp(o.dataDir), readMaintenance(o.dataDir)]);
    // Final review (jobs): the claims are paused, so no session waits idle for its job meanwhile, but an exempt job's;
    // closed before the op is stepped, whose DDL (`reset`, `migrate`) would otherwise wait for that session's locks.
    if (raised !== null) await closeIdleJobSessions(pausedKeep(raised), log);
    // An op that ended while its flag stayed up is stepped too: the step lowers the flag (P7).
    if (active !== null || (raised !== null && raised.opId !== null)) {
      try {
        op = await o.ops.step(Math.max(1, deadline - o.clock()));
      } catch (error) {
        warn('jobs: stepping the op failed', errorFields(error));
      }
    }
    const h = o.db();
    if (stopping()) return { op, scheduled: 0, slices: 0 };
    const flag = await readMaintenance(o.dataDir);
    // The same for a flag the step raised.
    if (flag !== null) await closeIdleJobSessions(pausedKeep(flag), log);
    if (h === undefined || flag?.reason === 'restore') return { op, scheduled: 0, slices: 0 };
    await pruneJobSessions(h, log);
    let scheduled = 0;
    if (flag === null && o.scheduler !== null) {
      try {
        scheduled = await o.scheduler.tick(o.clock());
      } catch (error) {
        warn('jobs: the scheduler tick failed', errorFields(error));
      }
    }
    const results = await runFor({ budgetMs: Math.max(0, deadline - o.clock()), mode: p.mode });
    return { op, scheduled, slices: results.length };
  }

  async function driveJob(jobId: string, d: { budgetMs: number }): Promise<SliceResult | null> {
    checkBudget(d.budgetMs, 'driveJob');
    const h = o.db();
    if (h === undefined || stopping() || typeof jobId !== 'string') return null;
    const exempt = await claimable();
    if (exempt !== null && !exempt.includes(jobId)) return null;
    const anomaly = await anomalyActive(h);
    // R1c-7: a light job takes one of this process's light slots like any other claimant; with both taken only a heavy
    // job (which needs `jobs:heavy` instead) may be claimed. Checked with no await before the increment.
    let holding = lightBusy < LIGHT_PER_PROCESS;
    if (!holding && heavyTypes.length === 0) return null;
    if (holding) lightBusy += 1;
    try {
      const job = await claimById(h, reg, jobId, { worker: o.worker, now: o.clock(), exempt, anomaly, ...(holding ? {} : { types: heavyTypes }) });
      if (job === null) return null;
      if (holding && heavyTypes.includes(job.type)) {
        lightBusy -= 1;
        holding = false;
      }
      return await slice(h, job, 'drive', Math.min(SLICE_BUDGET_MS, d.budgetMs));
    } finally {
      if (holding) lightBusy -= 1;
    }
  }

  return { pass, runFor, driveJob };
}
