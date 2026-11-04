import { countRows, type DbHandle } from '@altis/db';

// The freeze of an op that needs a quiet database (backup `frozen`, restore; spec §9.4, decision C9): its maintenance
// flag pauses new claims in every process, and the op waits in its first state until no job lease is alive any more,
// at least FREEZE_SETTLE_MS after the flag was raised (every process's fence has seen it by then) and at most
// FREEZE_WAIT_MS (then the op fails with OPS_FREEZE_TIMEOUT). The wait itself is in machine.ts's step.

/** The longest wait for live leases to end (spec §9.4: "maksimal 60 detik"; a lease is 50 s, §10.1). */
export const FREEZE_WAIT_MS = 60_000;

/** The shortest wait after the flag was raised: the 2 s fence interval plus a margin (decision C9). */
export const FREEZE_SETTLE_MS = 3_000;

/**
 * The number of jobs that hold a live lease at `now`: `running`, with `locked_until ≥ now`, other than the ones in
 * `exempt` (the flag's `exemptJobIds`, which the maintenance lets run on).
 */
export async function liveLeases(h: DbHandle, now: number, exempt: readonly string[]): Promise<number> {
  let q = h.db.selectFrom('jobs').where('status', '=', 'running').where('locked_until', '>=', now);
  if (exempt.length > 0) q = q.where('id', 'not in', [...exempt]);
  return countRows(q.select('id'));
}
