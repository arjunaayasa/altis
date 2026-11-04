import type { DB } from '@altis/db';
import { DomainError, parseChannel } from '@altis/shared';
import type { Kysely, Transaction } from 'kysely';
import { readSettings } from '../settings/service.js';
import { formatCursor, parseCursor } from './cursor.js';

// Reading events for the UI (spec §10.6, decision C5), behind GET events and the SSE stream (Task 8).
//
// An event becomes readable once it is settled: `created_at ≤ now − 2 s`. A transaction publishes its event as its
// last statement, so a settled event's lower seqs have committed too, unless a commit was slow; for those the reader
// also re-sends the settled events of the 2 s before (`created_at > now − 4 s`) even when `seq ≤ cursor`, and the
// client drops the seqs it has already seen. Events are hints: a client that missed one still fetches the data.

/** An event is settled (readable) once it is this old. */
export const EVENT_SETTLE_MS = 2000;
/** The settled events of this window before the settle line are re-sent even below the cursor. */
export const EVENT_OVERLAP_MS = 2000;
/** The most events one read returns. */
export const EVENT_PAGE = 500;

export type EventItem = { seq: number; channel: string; type: string; payload: Record<string, unknown>; at: number };

type Handle = Kysely<DB> | Transaction<DB>;

/**
 * A BIGINT column or aggregate as a JS number. connect.ts makes every driver return numbers (SQLite and PostgreSQL's
 * int8 parser throw outside the safe range, mysql2 runs with `bigNumberStrings: false`); a decimal string or a bigint
 * is still accepted, as countRows does.
 *
 * @throws TypeError for anything that is not a safe integer of at least 0
 */
export function dbInt(value: unknown, what: string): number {
  let n: number | undefined;
  if (typeof value === 'number') n = value;
  else if (typeof value === 'bigint') n = Number(value);
  else if (typeof value === 'string' && /^(?:0|[1-9][0-9]*)$/.test(value)) n = Number(value);
  if (n === undefined || !Number.isSafeInteger(n) || n < 0) {
    throw new TypeError(`events: ${what} is not a safe integer of at least 0`);
  }
  return n;
}

/** The highest seq in `events`, 0 for an empty table. */
export async function highestSeq(db: Handle): Promise<number> {
  const row = await db
    .selectFrom('events')
    .select((eb) => eb.fn.max('seq').as('top'))
    .executeTakeFirst();
  const top: unknown = row?.top ?? null;
  return top === null ? 0 : dbInt(top, 'max(events.seq)');
}

/** `system.events_floor`: the highest seq retention ever deleted (M15, decision C43); 0 when nothing was. */
export async function eventsFloor(db: Handle): Promise<number> {
  const value = (await readSettings(db, ['system.events_floor'], []))['system.events_floor'];
  return dbInt(value, 'system.events_floor');
}

/** The columns an {@link EventItem} is made of. */
export const EVENT_COLUMNS = ['seq', 'channel', 'type', 'payload', 'created_at'] as const;

/** A row of `events` as an {@link EventItem}; a payload that is not a JSON object (never written so) reads as `{}`. */
export function toEventItem(row: { seq: unknown; channel: string; type: string; payload: string; created_at: unknown }): EventItem {
  let payload: Record<string, unknown> = {};
  try {
    const parsed: unknown = JSON.parse(row.payload);
    if (typeof parsed === 'object' && parsed !== null && !Array.isArray(parsed)) payload = parsed as Record<string, unknown>;
  } catch {
    // publish() writes JSON objects only; a row written otherwise carries nothing.
  }
  return {
    seq: dbInt(row.seq, 'events.seq'),
    channel: row.channel,
    type: row.type,
    payload,
    at: dbInt(row.created_at, 'events.created_at'),
  };
}

function expired(why: 'malformed' | 'epoch' | 'ahead' | 'retention'): DomainError {
  return new DomainError('EVENTS_CURSOR_EXPIRED', {
    detail: 'Kursor event sudah kedaluwarsa; muat ulang data / The events cursor has expired; reload the data',
    meta: { why },
  });
}

export interface ReadEventsOptions {
  /** Registered channel names (parseChannel), at least one; the caller has authorized every one (§10.7). */
  channels: readonly string[];
  /** The client's cursor, or null for its first read. */
  cursor: string | null;
  /** Epoch ms of the read. */
  now: number;
  /** The installation's current data epoch. */
  epoch: number;
}

/**
 * The settled events of `channels` after `cursor`, and the cursor to send next time (spec §10.6, decision C5):
 *
 * - no cursor: no events, and a cursor at the highest seq ("kursor awal = sekarang"); the highest seq is
 *   `max(max(events.seq), system.events_floor)`, so a table retention emptied does not start the client at 0;
 * - a malformed cursor, another epoch, a seq above that highest seq, or a seq below the floor (older than retention)
 *   → 410 `EVENTS_CURSOR_EXPIRED`;
 * - otherwise the events with `created_at ≤ now − 2 s` and `seq > cursor` in seq order, at most 500, plus the settled
 *   events of the overlap window (`created_at > now − 4 s`) with `seq ≤ cursor`. New events take the page first and
 *   re-sent ones fill what is left of it: when 500 or more already-seen events sit in the window, a read that put
 *   them first would send the same page again and never move on. The result is in seq order (the re-sent events
 *   all have lower seqs); the next cursor is the highest new seq, or the cursor itself when there is none.
 *
 * The highest seq is read before the floor: retention deletes and raises the floor in one transaction, so a purge
 * between the two reads leaves an old (higher) maximum and a new floor, never a maximum below a cursor it issued.
 *
 * Statements run on `db` one after another, outside any transaction of the caller's.
 *
 * @throws DomainError `EVENTS_CURSOR_EXPIRED` (410) as above
 * @throws TypeError for an empty channel list or an unknown channel, a `now` or `epoch` that is not a safe integer
 *   of at least 0, or a cursor that is neither a string nor null
 */
export async function readEvents(db: Kysely<DB>, o: ReadEventsOptions): Promise<{ cursor: string; events: EventItem[] }> {
  if (!Array.isArray(o.channels) || o.channels.length === 0) {
    throw new TypeError('readEvents: channels must name at least one channel');
  }
  for (const name of o.channels) {
    if (typeof name !== 'string' || parseChannel(name) === null) throw new TypeError('readEvents: unknown channel');
  }
  if (!Number.isSafeInteger(o.now) || o.now < 0) throw new TypeError('readEvents: now must be an epoch-ms integer');
  if (!Number.isSafeInteger(o.epoch) || o.epoch < 0) throw new TypeError('readEvents: epoch must be a safe integer of at least 0');
  if (o.cursor !== null && typeof o.cursor !== 'string') throw new TypeError('readEvents: cursor must be a string or null');

  const c = o.cursor === null ? null : parseCursor(o.cursor);
  if (o.cursor !== null && c === null) throw expired('malformed');

  const top = await highestSeq(db);
  const floor = await eventsFloor(db);
  const maxSeq = Math.max(top, floor);
  if (c === null) return { cursor: formatCursor(o.epoch, maxSeq), events: [] };
  if (c.epoch !== o.epoch) throw expired('epoch');
  if (c.seq > maxSeq) throw expired('ahead');
  if (c.seq < floor) throw expired('retention');

  const channels = [...new Set(o.channels)];
  const settledBy = o.now - EVENT_SETTLE_MS;
  const settled = db
    .selectFrom('events')
    .select(EVENT_COLUMNS)
    .where('channel', 'in', channels)
    .where('created_at', '<=', settledBy);
  const fresh = await settled.where('seq', '>', c.seq).orderBy('seq').limit(EVENT_PAGE).execute();
  const again =
    fresh.length < EVENT_PAGE
      ? await settled
          .where('seq', '<=', c.seq)
          .where('created_at', '>', settledBy - EVENT_OVERLAP_MS)
          .orderBy('seq')
          .limit(EVENT_PAGE - fresh.length)
          .execute()
      : [];
  const events = [...again, ...fresh].map(toEventItem);
  const last = fresh.length === 0 ? c.seq : Math.max(c.seq, dbInt(fresh[fresh.length - 1]!.seq, 'events.seq'));
  return { cursor: formatCursor(o.epoch, last), events };
}
