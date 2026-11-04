import { assertOutsideTx, upsert, withTx, type DB, type DbHandle } from '@altis/db';
import type { ExpressionBuilder, Transaction } from 'kysely';
import { writeSettings } from '../settings/service.js';
import { dbInt, eventsFloor } from './reader.js';

// Event retention (spec §10.6, decision C43, M15). Events are deleted when older than 7 days and at or below the
// cursor of every enabled durable consumer, or when older than 30 days in any case. The highest seq ever deleted is
// kept in `system.events_floor` (an instance setting): the UI reader tells "older than retention" by it, and an
// enabled consumer whose cursor is below it has lost events and is flagged `needs_full_reindex`.

/** Events this young are always kept. */
export const EVENT_KEEP_MS = 7 * 86_400_000;
/** Events this old are deleted even when a consumer has not handled them. */
export const EVENT_MAX_AGE_MS = 30 * 86_400_000;

/** Rows deleted per transaction. */
const PURGE_BATCH = 5000;

/** The lowest cursor of the enabled consumers, or null when there is none (then nothing holds events back). */
async function slowestCursor(trx: Transaction<DB>): Promise<number | null> {
  const row = await trx
    .selectFrom('event_consumers')
    .select((eb) => eb.fn.min('cursor').as('low'))
    .where('enabled', '=', 1)
    .executeTakeFirst();
  const low: unknown = row?.low ?? null;
  return low === null ? null : dbInt(low, 'min(event_consumers.cursor)');
}

/**
 * One batch in one transaction: deletes up to 5000 of the oldest seqs retention allows, raises the floor to the
 * highest of them, and flags the enabled consumers left below the floor (also when nothing was deleted: a consumer
 * enabled again after it was left behind). Dialect-neutral: no DELETE … LIMIT (PostgreSQL has none); the seqs are
 * selected first and the DELETE takes their range, with the same conditions.
 */
async function purgeBatch(h: DbHandle, now: number): Promise<{ deleted: number; full: boolean; flagged: string[] }> {
  return withTx(h, async (trx) => {
    // First statement: lock the floor's row, so that batches of concurrent purges (other processes) run one after
    // another. Every later read then sees the batch before it committed (PostgreSQL READ COMMITTED reads per statement;
    // MySQL/MariaDB take the REPEATABLE READ snapshot at the first plain read, which comes after the lock), and the
    // floor read below is never older than one a concurrent batch wrote. 1c Task 18: the row is created (as the
    // default, 0) when it is absent, so that the very first purges lock it too: with no row to lock, two first batches
    // could each read 0 and the later commit could write a lower floor over a higher one. upsert's UPDATE changes
    // nothing on an existing row (the scope it sets is the registered one) but takes its lock; an INSERT that collides
    // with a concurrent one waits for it and then takes that row's lock.
    await upsert(
      trx,
      'settings',
      { key: 'system.events_floor' },
      { value: '0', is_secret: 0, scope: 'instance', updated_at: now, updated_by: null },
      { scope: 'instance' },
    );
    const low = await slowestCursor(trx);
    const purgeable = (eb: ExpressionBuilder<DB, 'events'>) =>
      eb.or([
        eb('created_at', '<', now - EVENT_MAX_AGE_MS),
        low === null
          ? eb('created_at', '<', now - EVENT_KEEP_MS)
          : eb.and([eb('created_at', '<', now - EVENT_KEEP_MS), eb('seq', '<=', low)]),
      ]);
    const seqs = await trx.selectFrom('events').select('seq').where(purgeable).orderBy('seq').limit(PURGE_BATCH).execute();

    let deleted = 0;
    let floor = await eventsFloor(trx);
    if (seqs.length > 0) {
      const first = dbInt(seqs[0]!.seq, 'events.seq');
      const last = dbInt(seqs[seqs.length - 1]!.seq, 'events.seq');
      const result = await trx
        .deleteFrom('events')
        .where('seq', '>=', first)
        .where('seq', '<=', last)
        .where(purgeable)
        .executeTakeFirst();
      deleted = Number(result.numDeletedRows);
      // `last` is gone whoever deleted it: created_at never changes and `low` is fixed for this statement, so the row
      // still qualified. The floor only ever goes up.
      if (last > floor) {
        floor = last;
        await writeSettings(trx, { 'system.events_floor': floor }, { keyring: [], now, actorId: null });
      }
    }

    const flagged: string[] = [];
    if (floor > 0) {
      const behind = await trx
        .selectFrom('event_consumers')
        .select('name')
        .where('enabled', '=', 1)
        .where('needs_full_reindex', '=', 0)
        .where('cursor', '<', floor)
        .orderBy('name')
        .execute();
      for (const { name } of behind) {
        const set = await trx
          .updateTable('event_consumers')
          .set({ needs_full_reindex: 1, updated_at: now })
          .where('name', '=', name)
          .where('enabled', '=', 1)
          .where('needs_full_reindex', '=', 0)
          .where('cursor', '<', floor)
          .executeTakeFirst();
        if (Number(set.numUpdatedRows) === 1) flagged.push(name);
      }
    }
    return { deleted, full: seqs.length === PURGE_BATCH, flagged };
  });
}

/**
 * Deletes the events retention no longer keeps (spec §10.6), in batches of at most 5000 by seq, each batch in a
 * transaction of its own (a run killed between batches leaves a consistent table and floor, P7):
 *
 * - (a) `created_at < now − 7 d AND seq ≤ min(cursor of the enabled consumers)`; with no enabled consumer there is no
 *   bound (a disabled consumer holds nothing back);
 * - (b) `created_at < now − 30 d`.
 *
 * Each batch records the highest deleted seq in `system.events_floor` (through the settings service, in the batch's
 * transaction), then sets `needs_full_reindex = 1` on the enabled consumers whose cursor is below the floor.
 *
 * The caller skips it while `clock_anomaly` is active (Task 18): ages are measured against `now`.
 *
 * 1c Task 18 (P9): with `o.deadline` (a `Date.now()` reading) no batch starts once it has passed, the first excepted
 * (every call makes progress); the result then says whether a batch was left (`more`), and the caller (the
 * `housekeeping.events` job) continues in its next slice.
 *
 * @returns how many events were deleted, and the consumers this run flagged (each once, in name order per batch);
 *   with a deadline also `more`: true when it stopped at the deadline after a full batch (more may be purgeable)
 * @throws TypeError inside a withTx callback (it runs its own transactions), for a `now` that is not an epoch-ms
 *   integer, or for a deadline that is not a finite number
 */
export async function purgeEvents(
  h: DbHandle,
  now: number,
  o: { deadline?: number } = {},
): Promise<{ deleted: number; reindexFlagged: string[]; more?: boolean }> {
  assertOutsideTx('purgeEvents');
  if (!Number.isSafeInteger(now) || now < 0) throw new TypeError('purgeEvents: now must be an epoch-ms integer');
  if (o.deadline !== undefined && !Number.isFinite(o.deadline)) throw new TypeError('purgeEvents: deadline must be a finite number');
  let deleted = 0;
  const reindexFlagged: string[] = [];
  for (;;) {
    const batch = await purgeBatch(h, now);
    deleted += batch.deleted;
    reindexFlagged.push(...batch.flagged);
    if (!batch.full) break;
    if (o.deadline !== undefined && Date.now() >= o.deadline) return { deleted, reindexFlagged, more: true };
  }
  return o.deadline === undefined ? { deleted, reindexFlagged } : { deleted, reindexFlagged, more: false };
}
