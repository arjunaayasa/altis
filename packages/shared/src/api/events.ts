/**
 * The events API vocabulary shared by the server and the admin SPA (spec §10.6-10.8, §13.5 "Event & notifikasi"):
 * the query string of `GET events` (polling) and `GET events/stream` (SSE), the answer of a poll, and what an SSE
 * stream sends. No Node built-ins here: the browser bundles this module. Import it as `@altis/shared/api/events`.
 *
 * Events are hints: a client that sees one fetches the data it names (a notification event → `GET notifications`),
 * and a client that missed some reloads its data. A cursor is `<dataEpoch>.<seq>`; the first read without one starts
 * "now". A cursor of another data epoch (a restore happened), above the newest event or older than retention is
 * expired: 410 `EVENTS_CURSOR_EXPIRED` for a poll, `event: expired` in a stream; the client then reloads and starts
 * again without a cursor. The reader re-sends the events of a short overlap window (spec §10.6), so a client drops
 * the seqs it has already seen.
 *
 * An SSE stream (`text/event-stream`) sends, in order:
 * - `retry: 1000` (the browser reconnects 1 s after the stream ends);
 * - per event, `id: <epoch>.<seq>`, `event: <type>` and `data: <JSON of {@link StreamEventData}>`; a type is never
 *   `expired`, `error`, `message` or `open` (publish refuses them), so a listener of those hears only the stream's own
 *   signal or the EventSource's own events;
 * - `id: <cursor>` alone whenever the stream's cursor moved without an event that carries it (the first read, or only
 *   re-sent events), so a browser that reconnects sends it back as `Last-Event-ID` (which wins over `?cursor`);
 * - `: hb` every 5 s while the session, the user, the rights, the channels and the data epoch are as they were;
 * - `event: expired` with an empty `id` and `data: {}` when the cursor expired or the data epoch changed, then the
 *   end. A stream also ends without a word when the session or the rights no longer allow it, and by itself within
 *   25 s (the browser reconnects).
 *
 * `GET events/stream` answers 409 `REALTIME_SSE_DISABLED` while SSE is off (§10.8: by default on Passenger and
 * LiteSpeed) and 204 when the server holds all the streams it may (the client polls instead). Either route answers
 * 403 `AUTHZ_DENIED` for the whole request when one channel is unknown or not the caller's to read (§10.7).
 */
import { z } from 'zod';

/**
 * Every event type (R1c-8), one per line. publish() (packages/core) refuses any other type with a TypeError, and the
 * admin's SSE client listens for exactly these (an EventSource hands a named event only to a listener of that name),
 * so a type cannot silently miss a stream. **A task that publishes a new type adds it here in the same commit.** Each
 * one matches `/^[a-z][a-z0-9_.]{0,63}$/` and is never a control name of the stream (`expired`, `error`, `message`,
 * `open`).
 */
export const EVENT_TYPES: readonly string[] = Object.freeze([
  'notification', // user.<id> or system.status: a notification for the user or a permission (Task 7)
  'job.progress', // jobs.<id> (Task 5)
  'job.finished', // jobs.<id> (Task 5)
  'op.progress', // system.backup (backup, restore) or system.update (update, rollback): OpStepContext.publish (M43)
  'clock.anomaly', // system.status: the clock anomaly was raised (Task 14)
  'backup.progress', // system.backup: {backupId, progress} of each snapshot backup slice and each frozen backup op step (Task 20, S24, R1c-13)
  'backup.done', // system.backup: a backup finished (Task 20)
  // 1d
  'update.checked', // system.update: {available: string | null} an update check finished, with the version it found
  // ---- Phase 2 (catalog): Task 2 ----
  'catalog.record.changed', // catalog: {id} of a record written (Phase 2 spec §12.6; payloads carry ids only)
  'catalog.item.changed', // catalog: the ids of an item written (never a barcode or another value)
  'catalog.bulk.changed', // catalog: {runId} per slice of an import, a migration or a reindex
  // ---- Komunitas K1 (accreditation) ----
  'accreditation.results.changed', // accreditation: {periodId} when a period's stored results changed
]);

/** Whether `type` is in {@link EVENT_TYPES}. */
export function isRegisteredEventType(type: unknown): boolean {
  return typeof type === 'string' && EVENT_TYPES.includes(type);
}

/** The most channels one request names. */
export const EVENT_CHANNELS_MAX = 20;

/** The channels of a `channels` query value (comma-separated, as sent: an unknown name is the server's 403). */
export function channelList(channels: string): string[] {
  return channels.split(',');
}

/**
 * The query of `GET events` and `GET events/stream`: `channels`, comma-separated (1-20 names, at most 1000
 * characters), and `cursor`, the `cursor` of the previous answer (absent on the first read).
 */
export const EventsQuery = z.strictObject({
  channels: z
    .string()
    .min(1)
    .max(1000)
    .check((ctx) => {
      if (channelList(ctx.value).length > EVENT_CHANNELS_MAX) {
        ctx.issues.push({ code: 'too_big', origin: 'array', maximum: EVENT_CHANNELS_MAX, inclusive: true, input: ctx.value });
      }
    }),
  cursor: z.string().max(40).optional(),
});

export type EventsQuery = z.infer<typeof EventsQuery>;

/** One event: its `seq`, the channel and type it was published on, its payload (no personal data), `at` epoch ms. */
export interface EventItem {
  seq: number;
  channel: string;
  type: string;
  payload: Record<string, unknown>;
  at: number;
}

/** The answer of `GET events`: the events after the cursor, in seq order, and the cursor to send next time. */
export interface EventsResponse {
  cursor: string;
  events: EventItem[];
}

/** The `data` of one SSE event (its seq is in the `id`, its type is the event name). */
export interface StreamEventData {
  channel: string;
  payload: Record<string, unknown>;
  at: number;
}
