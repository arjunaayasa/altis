import { performance } from 'node:perf_hooks';
import { upsert, withTx, type DB, type DbHandle } from '@altis/db';
import type { Kysely, Transaction } from 'kysely';
import { EVENT_COLUMNS, dbInt, eventsFloor, highestSeq, toEventItem, type EventItem } from './reader.js';

// Durable event consumers (spec §10.6): code that must see every event once, in seq order (Phase 2's search index,
// for instance), unlike the UI readers, for which events are hints. Each consumer has a row in `event_consumers`
// holding the last seq it handled.
//
// A consumer reads `seq > cursor ORDER BY seq` and stops at the first event created less than 30 s before `now`: a
// transaction lasts at most 3 s and publishes as its last statement, so by then every lower seq has committed and
// none can appear behind the cursor later. Each event is handled in one transaction with the cursor's advance, so a
// handler's writes and the cursor commit together (idempotent per seq, P7).

/** A consumer handles no event created after `now` minus this. */
export const CONSUMER_HOLD_MS = 30_000;

/** Events read per statement. */
const READ_BATCH = 100;

/** A consumer name: lower case, dot-separated words, like an event type. */
const CONSUMER_NAME = /^[a-z][a-z0-9_.]{0,63}$/;

export interface EventConsumer {
  /** Its `event_consumers.name`, unique among the consumers of a run. */
  name: string;
  /**
   * Handles `e` in `trx`, the transaction that also moves the cursor past it. It must be re-runnable (withTx may run
   * it again after a deadlock, R37): work only through `trx`, with no side effect outside it. Throwing rolls the
   * event's transaction back, so the cursor stays before it and the event comes again on the next run.
   */
  handle(trx: Transaction<DB>, e: EventItem): Promise<void>;
}

/** The consumer's row, created on its first run with the cursor at the highest seq ("from now on"). */
async function ensureRow(h: DbHandle, name: string, now: number): Promise<{ cursor: number; enabled: boolean }> {
  const read = (db: Kysely<DB> | Transaction<DB>) =>
    db.selectFrom('event_consumers').select(['cursor', 'enabled']).where('name', '=', name).executeTakeFirst();
  const row =
    (await read(h.db)) ??
    (await withTx(h, async (trx) => {
      // The floor too: retention may have emptied the table, and a cursor below the floor reads as left behind.
      const start = Math.max(await highestSeq(trx), await eventsFloor(trx));
      // A process that created the row meanwhile wins: its row is kept as it is (`name = name` changes nothing).
      await upsert(trx, 'event_consumers', { name }, { cursor: start, enabled: 1, updated_at: now, needs_full_reindex: 0 }, { name });
      return read(trx);
    }));
  if (row === undefined) throw new TypeError(`runConsumers: the row of consumer ${name} is missing after its insert`);
  return { cursor: dbInt(row.cursor, 'event_consumers.cursor'), enabled: Number(row.enabled) === 1 };
}

/**
 * Handles `e` for `consumer` and moves its cursor from `from` to `e.seq`, in one transaction. The compare-and-set on
 * the cursor comes first and holds the consumer's row until the commit, so a second runner of the same consumer
 * (another process) waits for it and then finds the cursor moved: false, and that runner stops. Also false when the
 * consumer was disabled meanwhile.
 */
async function handleOne(h: DbHandle, consumer: EventConsumer, from: number, e: EventItem, now: number): Promise<boolean> {
  return withTx(h, async (trx) => {
    const moved = await trx
      .updateTable('event_consumers')
      .set({ cursor: e.seq, updated_at: now })
      .where('name', '=', consumer.name)
      .where('cursor', '=', from)
      .where('enabled', '=', 1)
      .executeTakeFirst();
    if (Number(moved.numUpdatedRows) !== 1) return false;
    await consumer.handle(trx, e);
    return true;
  });
}

/**
 * Runs each consumer of `consumers` over the events after its cursor (spec §10.6):
 *
 * - its row is created on its first run, with the cursor at the highest seq (`max(max(seq), system.events_floor)`):
 *   a new consumer starts with the events published after it;
 * - a disabled row (`enabled = 0`) is skipped;
 * - the events with `seq > cursor` are handled in seq order, each in a transaction of its own that also moves the
 *   cursor to its seq, until the first event created after `o.now − 30 s`, which waits for a later run;
 * - a consumer flagged `needs_full_reindex` (retention deleted events it had not handled) still goes on from its
 *   cursor: rebuilding its state is its owner's job, which then clears the flag;
 * - a handler that throws stops its consumer with the cursor before that event; the other consumers still run, and
 *   runConsumers then rejects with that error (with an AggregateError when several consumers failed);
 * - no event is started once `o.budgetMs` has passed (measured from the call, on the monotonic clock).
 *
 * Several processes may run the same consumers at once: every event is handled once, by one of them. Call it
 * outside any withTx callback on `h`.
 *
 * @returns the number of events handled
 * @throws TypeError for a consumer name outside `/^[a-z][a-z0-9_.]{0,63}$/`, a name given twice, a `now` that is not
 *   an epoch-ms integer or a `budgetMs` that is not a finite number of at least 0 (before anything is written)
 */
export async function runConsumers(
  h: DbHandle,
  consumers: readonly EventConsumer[],
  o: { now: number; budgetMs: number },
): Promise<{ processed: number }> {
  const started = performance.now();
  if (!Number.isSafeInteger(o.now) || o.now < 0) throw new TypeError('runConsumers: now must be an epoch-ms integer');
  if (!Number.isFinite(o.budgetMs) || o.budgetMs < 0) throw new TypeError('runConsumers: budgetMs must be a finite number of at least 0');
  const names = new Set<string>();
  for (const consumer of consumers) {
    if (typeof consumer?.name !== 'string' || !CONSUMER_NAME.test(consumer.name)) {
      throw new TypeError(`runConsumers: a consumer name must match ${String(CONSUMER_NAME)}`);
    }
    if (typeof consumer.handle !== 'function') throw new TypeError(`runConsumers: consumer ${consumer.name} has no handle()`);
    if (names.has(consumer.name)) throw new TypeError(`runConsumers: consumer ${consumer.name} is listed twice`);
    names.add(consumer.name);
  }

  const holdFrom = o.now - CONSUMER_HOLD_MS;
  const spent = () => performance.now() - started >= o.budgetMs;
  const failures: unknown[] = [];
  let processed = 0;

  for (const consumer of consumers) {
    if (spent()) break;
    const row = await ensureRow(h, consumer.name, o.now);
    if (!row.enabled) continue;
    let cursor = row.cursor;
    try {
      reading: for (;;) {
        const batch = await h.db
          .selectFrom('events')
          .select(EVENT_COLUMNS)
          .where('seq', '>', cursor)
          .orderBy('seq')
          .limit(READ_BATCH)
          .execute();
        for (const raw of batch) {
          const e = toEventItem(raw);
          if (e.at > holdFrom || spent()) break reading;
          if (!(await handleOne(h, consumer, cursor, e, o.now))) break reading;
          cursor = e.seq;
          processed += 1;
        }
        if (batch.length < READ_BATCH) break;
      }
    } catch (error) {
      failures.push(error);
    }
  }

  if (failures.length === 1) throw failures[0];
  if (failures.length > 1) throw new AggregateError(failures, `runConsumers: ${failures.length} consumers failed`);
  return { processed };
}
