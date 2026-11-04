import { assertOutsideTx, withTx, type DbHandle } from '@altis/db';

// The notification retention (`housekeeping.notifications`, schedule `retention.notifications`, daily; spec §10.9,
// L38, decision C24): a notification is kept until its `expires_at` (`created_at` + 90 days); its read markers go with
// it (`notification_reads` references it ON DELETE CASCADE).

/** Notifications deleted per transaction. */
export const NOTIFICATION_PURGE_BATCH = 1000;

/**
 * Deletes the notifications with `expires_at < now`, oldest id first, in transactions of at most
 * {@link NOTIFICATION_PURGE_BATCH} (dialect-neutral: the ids are selected, then deleted with the same condition).
 * With `o.deadline` (a `Date.now()` reading) no batch starts once it passed, the first excepted.
 *
 * Call it outside any withTx callback (R49).
 *
 * @returns how many were deleted, and `more` when it stopped at the deadline after a full batch
 * @throws TypeError inside a withTx callback or for a malformed `now`
 */
export async function purgeNotifications(h: DbHandle, now: number, o: { deadline?: number } = {}): Promise<{ deleted: number; more: boolean }> {
  assertOutsideTx('purgeNotifications');
  if (!Number.isSafeInteger(now) || now < 0) throw new TypeError('purgeNotifications: now must be an epoch-ms integer');
  let deleted = 0;
  for (;;) {
    const batch = await withTx(h, async (trx) => {
      const ids = (
        await trx.selectFrom('notifications').select('id').where('expires_at', '<', now).orderBy('id').limit(NOTIFICATION_PURGE_BATCH).execute()
      ).map((r) => r.id);
      if (ids.length === 0) return { n: 0, full: false };
      const r = await trx.deleteFrom('notifications').where('id', 'in', ids).where('expires_at', '<', now).executeTakeFirst();
      return { n: Number(r.numDeletedRows), full: ids.length === NOTIFICATION_PURGE_BATCH };
    });
    deleted += batch.n;
    if (!batch.full) return { deleted, more: false };
    if (o.deadline !== undefined && Date.now() >= o.deadline) return { deleted, more: true };
  }
}
