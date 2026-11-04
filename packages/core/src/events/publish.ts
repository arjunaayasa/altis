import { withTx, type DB, type DbHandle } from '@altis/db';
import { parseChannel } from '@altis/shared';
import { isRegisteredEventType } from '@altis/shared/api/events';
import type { Transaction } from 'kysely';

// Writing events (spec §10.6–10.8). An event is a hint for the clients of a channel ("something changed, fetch it
// again"), never the data itself: its payload carries no personal data and stays small.

/** The largest payload, in bytes of its JSON text (UTF-8). */
export const EVENT_PAYLOAD_MAX = 4096;

/** An event type: lower case, dot-separated words (`job.progress`, `backup.done`), at most 64 characters. */
const EVENT_TYPE = /^[a-z][a-z0-9_.]{0,63}$/;

/**
 * The names an SSE stream keeps for its control messages, never an event type: `expired` is the stream's own signal
 * (the cursor expired or the data epoch changed), `error` and `open` are the browser EventSource's own events, and
 * `message` is what an unnamed SSE message is dispatched as. An event under one of them would be mistaken for the
 * signal by the client.
 */
export const RESERVED_EVENT_TYPES: readonly string[] = Object.freeze(['expired', 'error', 'message', 'open']);

/**
 * Whether `type` is an event type: it is in the registry `EVENT_TYPES` of @altis/shared/api/events (R1c-8), matches
 * `/^[a-z][a-z0-9_.]{0,63}$/` and is not a {@link RESERVED_EVENT_TYPES} name.
 */
export function isEventType(type: unknown): type is string {
  return typeof type === 'string' && EVENT_TYPE.test(type) && !RESERVED_EVENT_TYPES.includes(type) && isRegisteredEventType(type);
}

export interface EventInput {
  /** A registered channel (parseChannel of @altis/shared): `user.<ulid>`, `jobs.<ulid>`, `system.*`. */
  channel: string;
  type: string;
  /** A plain JSON object of at most {@link EVENT_PAYLOAD_MAX} bytes; `{}` when left out. */
  payload?: Record<string, unknown>;
}

/** The checked event as its row, but for `created_at`, which is read at the INSERT. */
function prepare(caller: string, e: EventInput): { channel: string; type: string; payload: string } {
  if (typeof e !== 'object' || e === null) throw new TypeError(`${caller}: the event must be an object`);
  if (typeof e.channel !== 'string' || parseChannel(e.channel) === null) {
    throw new TypeError(`${caller}: the channel is not a registered channel name`);
  }
  if (typeof e.type !== 'string' || !EVENT_TYPE.test(e.type)) {
    throw new TypeError(`${caller}: the event type must match ${String(EVENT_TYPE)}`);
  }
  if (RESERVED_EVENT_TYPES.includes(e.type)) {
    throw new TypeError(`${caller}: the event type ${e.type} is a control name of the event stream`);
  }
  if (!isEventType(e.type)) {
    throw new TypeError(`${caller}: the event type ${e.type} is not in EVENT_TYPES (@altis/shared/api/events, R1c-8)`);
  }
  const value: unknown = e.payload === undefined ? {} : e.payload;
  if (typeof value !== 'object' || value === null || Array.isArray(value)) {
    throw new TypeError(`${caller}: the payload must be a plain JSON object`);
  }
  let payload: string;
  try {
    payload = JSON.stringify(value);
  } catch {
    // A cycle or a bigint: not JSON.
    throw new TypeError(`${caller}: the payload must be a plain JSON object`);
  }
  const bytes = Buffer.byteLength(payload, 'utf8');
  if (bytes > EVENT_PAYLOAD_MAX) {
    throw new TypeError(`${caller}: the payload is ${bytes} bytes of JSON, more than ${EVENT_PAYLOAD_MAX}`);
  }
  return { channel: e.channel, type: e.type, payload };
}

/**
 * Writes the event `e` in `trx`.
 *
 * **It must be the transaction's last statement** (spec §10.6; a review item, like D14's first-statement rule): the
 * readers only trust events older than 2 s, and that settle window holds because the row commits right after its
 * `created_at` was taken. For the same reason `created_at` is read from `clock` immediately before the INSERT (S17),
 * never from the request's or the slice's earlier reading of the time.
 *
 * Re-runnable as a whole (R37): it writes only through `trx`.
 *
 * @throws TypeError for a channel parseChannel does not know, a type outside `/^[a-z][a-z0-9_.]{0,63}$/`, among
 *   {@link RESERVED_EVENT_TYPES} or outside the registry `EVENT_TYPES` (R1c-8), or a payload that is not a plain JSON
 *   object or whose JSON text is over {@link EVENT_PAYLOAD_MAX} bytes; nothing is written then
 */
export async function publish(trx: Transaction<DB>, e: EventInput, clock: () => number = Date.now): Promise<void> {
  const row = prepare('publish', e);
  // created_at is evaluated after insertInto(): the clock reading closest to the INSERT this code can take.
  await trx
    .insertInto('events')
    .values({ ...row, created_at: clock() })
    .execute();
}

/** A real-time transport (spec §13.8). WebSocket is Phase 6; 1c serves polling and SSE from the `events` table. */
export interface RealtimeTransport {
  kind: 'polling' | 'sse' | 'websocket';
  publish(channel: string, type: string, payload: Record<string, unknown>): Promise<void>;
}

/**
 * The transport of 1c: polling and SSE both read the `events` table (Task 8), so publishing is writing one event.
 * `kind` is read at every access (the SSE switch, `realtime.sse`, can change while the process runs).
 *
 * Its `publish` writes one event in a transaction of its own: a hint tied to no data change (a progress tick). A data
 * change publishes with {@link publish}(trx, …) as the last statement of its own transaction instead, so that the
 * hint commits with the change or not at all. Call it outside any withTx callback on the same handle (withTx
 * refuses the nesting).
 *
 * @throws TypeError as {@link publish}, before any transaction is opened
 */
export function createRealtimeTransport(h: DbHandle, kind: () => 'polling' | 'sse'): RealtimeTransport {
  return {
    get kind() {
      return kind();
    },
    async publish(channel, type, payload) {
      const e = { channel, type, payload };
      prepare('RealtimeTransport.publish', e);
      await withTx(h, (trx) => publish(trx, e));
    },
  };
}
