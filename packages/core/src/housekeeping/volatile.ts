import { assertOutsideTx, withTx, type DbHandle } from '@altis/db';
import { dataPath, removeTree } from '@altis/platform';
import { isDomainError } from '@altis/shared';
import { withUploadLock, type UploadLockTiming } from '../files/uploads.js';
import { sweepVolatile } from '../maintenance/sweep.js';

// The purge of the volatile tables (`housekeeping.volatile`, schedule `retention.volatile`, every 10 minutes; 1b
// decision D19 replaced: the opportunistic per-process sweeper is gone, this scheduled job does the work in every
// runner mode):
//
// - 1b's sweepVolatile: `rate_limits`, `sessions`, `remember_tokens`, `password_resets`, `idempotency_keys`;
// - `locks` whose lease ended more than an hour ago (a named lock is claimed by `until`, so an expired row is only
//   left over: its holder died or never released it);
// - `upload_sessions` past `expires_at`, each with its staging folder `tmp/<id>/` (spec §7.5: staging is cleaned
//   after 24 h). Each is removed under the upload's own lock (`upload:<id>`, never waited for): an expired session no
//   longer takes chunks, but a request that took the lock before it expired may still be writing; a busy one waits for
//   the next run. The folder goes before the row, so a run killed in between leaves the row for the next run.

/** A `locks` row whose `until` is this far in the past is deleted. */
export const LOCK_KEEP_MS = 3_600_000;

/** Expired upload sessions read per statement. */
const UPLOAD_BATCH = 100;

/** The upload lock is tried once: a busy upload is left for the next run. */
const NO_WAIT: UploadLockTiming = Object.freeze({ ttlMs: 60_000, renewMs: 15_000, waitMs: 0 });

/** What one {@link purgeVolatile} deleted, per table; `more` when it stopped at its deadline. */
export interface VolatileResult {
  deleted: Record<string, number>;
  more: boolean;
}

/** Removes the expired upload `id` (folder, then row) under its lock; false when it is busy or already gone. */
async function dropUpload(h: DbHandle, id: string, o: { now: number; dataDir: string }): Promise<boolean> {
  try {
    return await withUploadLock(
      h,
      id,
      async () => {
        const row = await h.db.selectFrom('upload_sessions').select('id').where('id', '=', id).where('expires_at', '<', o.now).executeTakeFirst();
        if (row === undefined) return false;
        await removeTree(dataPath(o.dataDir, 'tmp', id));
        const gone = await withTx(h, (trx) =>
          trx.deleteFrom('upload_sessions').where('id', '=', id).where('expires_at', '<', o.now).executeTakeFirst(),
        );
        return Number(gone.numDeletedRows) === 1;
      },
      NO_WAIT,
    );
  } catch (error) {
    // Another request holds the upload's lock: the next run takes it.
    if (isDomainError(error) && error.code === 'TX_CONFLICT') return false;
    throw error;
  }
}

/**
 * Purges the volatile tables as of `o.now` (see the top of this file), each in short transactions of its own. With
 * `o.deadline` (a `Date.now()` reading) the expired uploads stop once it passed, after at least one batch.
 *
 * Call it outside any withTx callback (it opens its own transactions, R49).
 *
 * @returns the rows deleted per table (`upload_sessions` counts the sessions removed with their folders), and `more`
 *   when expired uploads may be left because the deadline passed
 * @throws TypeError inside a withTx callback or for a malformed `now`
 */
export async function purgeVolatile(h: DbHandle, o: { now: number; dataDir: string; deadline?: number }): Promise<VolatileResult> {
  assertOutsideTx('purgeVolatile');
  const { deleted } = await sweepVolatile(h, o.now);
  deleted['locks'] = await withTx(h, async (trx) =>
    Number((await trx.deleteFrom('locks').where('until', '<', o.now - LOCK_KEEP_MS).executeTakeFirst()).numDeletedRows),
  );
  let uploads = 0;
  let more = false;
  let after: string | null = null;
  for (;;) {
    let q = h.db.selectFrom('upload_sessions').select('id').where('expires_at', '<', o.now).orderBy('id').limit(UPLOAD_BATCH);
    if (after !== null) q = q.where('id', '>', after);
    const ids = (await q.execute()).map((r) => r.id);
    for (const id of ids) {
      after = id;
      if (await dropUpload(h, id, o)) uploads += 1;
    }
    if (ids.length < UPLOAD_BATCH) break;
    if (o.deadline !== undefined && Date.now() >= o.deadline) {
      more = true;
      break;
    }
  }
  deleted['upload_sessions'] = uploads;
  return { deleted, more };
}
