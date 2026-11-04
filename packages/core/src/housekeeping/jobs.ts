import { assertOutsideTx, withTx, type DB, type DbHandle } from '@altis/db';
import type { ExpressionBuilder } from 'kysely';

// The job retention (`housekeeping.jobs`, schedule `retention.jobs`, daily; decision C26): `succeeded` and `cancelled`
// jobs are deleted 7 days after `finished_at`, `dead` ones after 30 days (they stay longer for the admin to see why).
// A live job (`queued`, `running`) is never touched.

/** `succeeded` and `cancelled` jobs are kept this long after they finished. */
export const FINISHED_JOB_KEEP_MS = 7 * 86_400_000;
/** `dead` jobs are kept this long after they finished. */
export const DEAD_JOB_KEEP_MS = 30 * 86_400_000;

/** Jobs deleted per transaction. */
const JOB_PURGE_BATCH = 1000;

/**
 * Deletes the finished jobs retention no longer keeps as of `now` (see the top of this file), oldest id first, in
 * transactions of at most 1000. With `o.deadline` (a `Date.now()` reading) no batch starts once it passed, the first
 * excepted.
 *
 * Call it outside any withTx callback (R49).
 *
 * @returns how many were deleted, and `more` when it stopped at the deadline after a full batch
 * @throws TypeError inside a withTx callback or for a malformed `now`
 */
export async function purgeJobs(h: DbHandle, now: number, o: { deadline?: number } = {}): Promise<{ deleted: number; more: boolean }> {
  assertOutsideTx('purgeJobs');
  if (!Number.isSafeInteger(now) || now < 0) throw new TypeError('purgeJobs: now must be an epoch-ms integer');
  const purgeable = (eb: ExpressionBuilder<DB, 'jobs'>) =>
    eb.or([
      eb.and([eb('status', 'in', ['succeeded', 'cancelled']), eb('finished_at', '<', now - FINISHED_JOB_KEEP_MS)]),
      eb.and([eb('status', '=', 'dead'), eb('finished_at', '<', now - DEAD_JOB_KEEP_MS)]),
    ]);
  let deleted = 0;
  for (;;) {
    const batch = await withTx(h, async (trx) => {
      const ids = (await trx.selectFrom('jobs').select('id').where(purgeable).orderBy('id').limit(JOB_PURGE_BATCH).execute()).map((r) => r.id);
      if (ids.length === 0) return { n: 0, full: false };
      const r = await trx.deleteFrom('jobs').where('id', 'in', ids).where(purgeable).executeTakeFirst();
      return { n: Number(r.numDeletedRows), full: ids.length === JOB_PURGE_BATCH };
    });
    deleted += batch.n;
    if (!batch.full) return { deleted, more: false };
    if (o.deadline !== undefined && Date.now() >= o.deadline) return { deleted, more: true };
  }
}
