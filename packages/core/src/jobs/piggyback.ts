import type { DbHandle } from '@altis/db';
import { errorFields, type CoreLogger } from '../context.js';
import { readMaintenance } from '../ops/files.js';
import type { SettingsCache } from '../settings/service.js';
import { lastRuns, recordRun, runnerFresh } from './run-records.js';
import type { Runner } from './runner.js';
import type { SliceResult } from './types.js';

// Piggyback (spec §10.2, decision C36; Review Focus 1): on a host with neither a worker nor a working cron line
// (cPanel without cron, the admin's tab closed), ordinary page views still move the queue. After a response, at most
// once per 30 s per process, and only when no worker or cron run is recorded within the last 10 minutes and no
// maintenance is on, the process runs one light slice of ≤ 2 s; the slice's heartbeat yields to the event loop at least
// every 50 ms (slice.ts), so the requests this process serves meanwhile are not held up. Which requests count (never
// health, cron, assets, the wizard or an SSE stream) is the server's to say (apps/server jobs/runtime.ts).

/** A piggyback slice's budget (spec §10.2: "≤ 2 detik"). */
export const PIGGYBACK_BUDGET_MS = 2_000;

/** A piggyback slice's heartbeat yields with `setImmediate` at least this often (spec §10.2: "setiap 50 ms"). */
export const PIGGYBACK_YIELD_MS = 50;

/** A process piggybacks at most this often (decision C36). */
export const PIGGYBACK_MIN_GAP_MS = 30_000;

export interface Piggyback {
  /**
   * One piggyback attempt now: null when it was skipped (another one running in this process, the last one < 30 s
   * ago, no database, a live runner, maintenance), else the slices it ran (at most one). The run is recorded as
   * `system.run.piggyback`.
   */
  run(): Promise<SliceResult[] | null>;
}

export interface PiggybackOptions {
  runner: Runner;
  db(): DbHandle | undefined;
  dataDir: string;
  /** Epoch ms. */
  clock(): number;
  log: CoreLogger;
  /** The run records are read through it (P6: a value up to its time to live old is good enough here). */
  settings: SettingsCache;
}

/** The piggyback of one process: the time of its last run is this object's (per process, C36). */
export function createPiggyback(o: PiggybackOptions): Piggyback {
  let last: number | null = null;
  let inFlight = false;

  return Object.freeze({
    async run(): Promise<SliceResult[] | null> {
      const now = o.clock();
      // A clock that moved back counts as a gap passed.
      if (inFlight || (last !== null && now >= last && now - last < PIGGYBACK_MIN_GAP_MS)) return null;
      const h = o.db();
      if (h === undefined) return null;
      inFlight = true;
      try {
        // The flag (a file) first: during a restore the run records' table is being emptied and loaded again.
        if ((await readMaintenance(o.dataDir)) !== null) return null;
        if (runnerFresh(await lastRuns(h.db, { cache: o.settings }), now)) return null;
        last = now;
        const results = await o.runner.runFor({ budgetMs: PIGGYBACK_BUDGET_MS, mode: 'piggyback', excludeHeavy: true });
        try {
          await recordRun(h, 'piggyback', o.clock(), { dataDir: o.dataDir });
        } catch (error) {
          o.log.warn('jobs: recording the piggyback run failed', errorFields(error));
        }
        return results;
      } finally {
        inFlight = false;
      }
    },
  });
}
