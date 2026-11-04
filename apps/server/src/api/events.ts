import {
  authorizeChannels,
  findSession,
  formatCursor,
  inRotationGrace,
  isEventType,
  loadStaffAuthView,
  readDataEpoch,
  readEvents,
  type ActorAuthz,
  type EventItem,
} from '@altis/core';
import type { DbHandle } from '@altis/db';
import { DomainError, isDomainError } from '@altis/shared';
import { EventsQuery, channelList, type EventsResponse, type StreamEventData } from '@altis/shared/api/events';
import { streamSSE, type SSEStreamingApi } from 'hono/streaming';
import { sessionIdleMs } from '../http/auth.js';
import type { AuthState } from '../http/auth-state.js';
import { readAuthCookie } from '../http/cookies.js';
import { route, type RouteContext, type RouteDecl } from '../http/route.js';
import { SSE_AUTH_MS, SSE_MAX_MS, SSE_READ_MS, SSE_RETRY_MS, sseEnabled } from '../realtime/streams.js';
import { loggableError } from '../safe-error.js';

// The events routes of Task 8 (spec §10.6-10.8, §13.5 "Event & notifikasi"; route catalog `events.poll`,
// `events.stream`; the wire format is described in @altis/shared/api/events). Every signed-in staff user (`public`
// with `session: 'required'`) reads the channels they may read (§10.7: one unknown or forbidden channel → 403 for the
// whole request, authorizeChannels); `mode: system` (they keep working in read-only), `maintenance: allow` (the admin
// shell keeps its live updates in a normal maintenance), no audit, no idempotency. Both are `background`: a page
// calls them on its own, so they never touch or rotate the session (an open tab must not keep an idle session alive).
//
// GET events (polling) reads the settled events after the cursor of the current data epoch (readEvents, ruling
// R1c-2). GET events/stream (SSE, decision C6):
//
//   if SSE is off (realtime.sse, else the runtime: sseEnabled)  → 409 REALTIME_SSE_DISABLED
//   authorizeChannels                                            → 403 for the whole request
//   a HEAD request                                               → 200 with the stream's headers, no stream
//   no free stream slot of this process (services.streams, 4)    → 204: the client polls instead
//   200 text/event-stream, Cache-Control: no-store, X-Accel-Buffering: no; `retry: 1000` first
//   from the cursor (Last-Event-ID wins over ?cursor), every 1 s until 25 s:
//     read (EVENTS_CURSOR_EXPIRED → `event: expired`, the end); each event as id/event/data, but for a row whose
//     type publish() refuses (isEventType: a control name such as `expired`, a type outside EVENT_TYPES), skipped;
//     `id: <cursor>` alone when the cursor moved without an event carrying it (a reconnecting browser sends it back
//     as Last-Event-ID)
//     every 5 s: data epoch unchanged (else `event: expired`, the end), session live and not idle, user active
//     without a pending password change, rights unchanged and the channels still allowed (else the end, silently);
//     then `: hb`
//   the slot is given back however the stream ends (the browser left: stream.onAbort stops the timers at once)
//
// The stream keeps its own clocks: setTimeout for its waits and its 25 s bound, performance.now() for the 1 s and
// 5 s cadence (monotonic: a wall clock moved back cannot stretch a stream). The events' `now` is the services clock.

const EVENTS = '/api/v1/events';
const NO_STORE = { 'Cache-Control': 'no-store' };
/** The cursor expired or the data epoch changed: the client reloads its data and starts again without a cursor. */
const EXPIRED = 'event: expired\nid: \ndata: {}\n\n';
const HEARTBEAT = ': hb\n\n';

type EventsContext = RouteContext<unknown, EventsQuery, unknown>;

/** The request's session (step 7). */
function authOf(rc: EventsContext): AuthState {
  // Unreachable: both routes require a session, which step 9 refuses without one.
  if (rc.auth === null) throw new TypeError('events routes run with a session');
  return rc.auth;
}

/** The creator of a job (null for an unknown job), for `jobs.<id>` channels (§10.7). */
function jobCreator(db: DbHandle['db']): (jobId: string) => Promise<string | null> {
  return async (jobId) => {
    const row = await db.selectFrom('jobs').select('created_by').where('id', '=', jobId).executeTakeFirst();
    return row?.created_by ?? null;
  };
}

/** Resolves when `actor` may read every one of `channels` (§10.7). @throws DomainError AUTHZ_DENIED for the whole list */
async function allowedChannels(db: DbHandle['db'], actor: ActorAuthz, channels: readonly string[]): Promise<void> {
  await authorizeChannels(actor, channels, { jobCreator: jobCreator(db) });
}

/** GET events. */
const eventsPoll = route({
  id: 'events.poll',
  method: 'GET',
  path: EVENTS,
  public: true,
  session: 'required',
  background: true,
  mode: 'system',
  maintenance: 'allow',
  idempotency: 'none',
  audit: null,
  query: EventsQuery,
  handler: async (rc) => {
    const auth = authOf(rc);
    const db = rc.db.db;
    const channels = channelList(rc.query.channels);
    await allowedChannels(db, { id: auth.subjectId, grants: auth.grants }, channels);
    const epoch = await readDataEpoch(rc.services.dataDir);
    const body: EventsResponse = await readEvents(db, { channels, cursor: rc.query.cursor ?? null, now: rc.now, epoch });
    return { body, headers: NO_STORE };
  },
});

/** What one stream works from, fixed when it opens. */
interface StreamPlan {
  channels: readonly string[];
  /** Where reading starts: Last-Event-ID, else `?cursor`, else null ("now"). */
  cursor: string | null;
  /** The cursor the browser already holds (its Last-Event-ID), or null. */
  held: string | null;
  epoch: number;
  /** The `altis_sid` token, to look the session up again at every check. */
  token: string;
  /** The `authz_version` the stream was authorized at. */
  authzVersion: number;
  /** Gives the stream slot back; only the first call counts. */
  release(): void;
}

/** One event as an SSE message (spec §10.8): `id: <epoch>.<seq>`, `event: <type>`, `data: {channel, payload, at}`. */
function eventMessage(id: string, e: EventItem): string {
  const data: StreamEventData = { channel: e.channel, payload: e.payload, at: e.at };
  // JSON.stringify escapes CR and LF inside strings: the data stays on one line.
  return `id: ${id}\nevent: ${e.type}\ndata: ${JSON.stringify(data)}\n\n`;
}

/**
 * The 5 s check (decision C6): `epoch` when the data epoch moved (a restore), `auth` when the session, the user, the
 * rights or a channel no longer allow the stream, else `ok`.
 */
async function recheck(rc: EventsContext, plan: StreamPlan): Promise<'ok' | 'auth' | 'epoch'> {
  if ((await readDataEpoch(rc.services.dataDir)) !== plan.epoch) return 'epoch';
  const db = rc.db.db;
  const now = rc.services.clock();
  const session = await findSession(db, plan.token, now);
  if (session === null || !session.mfaPassed) return 'auth';
  const user = await loadStaffAuthView(db, session.subjectId);
  if (user === null || user.status !== 'active' || user.mustChangePassword || user.authzVersion !== plan.authzVersion) {
    return 'auth';
  }
  // A background stream never touches its session: past the idle limit it ends, as step 7 would end it.
  if (!inRotationGrace(session) && now >= session.lastSeenAt + (await sessionIdleMs(rc.services, db))) return 'auth';
  const grants = await rc.services.grants.get(db, user.id, user.authzVersion);
  try {
    await allowedChannels(db, { id: user.id, grants }, plan.channels);
  } catch (error) {
    if (isDomainError(error) && error.code === 'AUTHZ_DENIED') return 'auth';
    throw error;
  }
  return 'ok';
}

/** The stream's loop (see the top of this file); never throws, and gives the slot back when it ends. */
async function runStream(rc: EventsContext, stream: SSEStreamingApi, plan: StreamPlan): Promise<void> {
  const t0 = performance.now();
  const elapsed = (): number => performance.now() - t0;
  let stopped = false;
  /** The loop waits for its next read (it ends at once when stopped); otherwise it writes, or reads the database. */
  let sleeping = false;
  let wake: (() => void) | undefined;
  let sleepTimer: ReturnType<typeof setTimeout> | undefined;
  const stop = (): void => {
    stopped = true;
    clearTimeout(sleepTimer);
    const resolve = wake;
    wake = undefined;
    resolve?.();
  };
  // The browser went away: the timers stop now, not at the next tick.
  stream.onAbort(stop);
  // Every stream ends within 25 s (§10.8), also one whose write waits for a browser that stopped reading, or whose
  // read waits on the database (a pool without a free connection, a table a restore step holds): its response ends and
  // its slot is free at once; the loop sees `stopped` once that call returns.
  const limit = setTimeout(() => {
    const busy = !sleeping;
    stop();
    if (busy) {
      stream.abort();
      plan.release();
    }
  }, SSE_MAX_MS);
  const sleepUntil = (at: number): Promise<void> =>
    new Promise((resolve) => {
      if (stopped) {
        resolve();
        return;
      }
      wake = resolve;
      sleepTimer = setTimeout(
        () => {
          wake = undefined;
          resolve();
        },
        Math.max(0, at - elapsed()),
      );
    });
  // A closed or aborted stream swallows the write.
  const send = async (text: string): Promise<void> => {
    await stream.write(text);
  };

  try {
    await send(`retry: ${SSE_RETRY_MS}\n\n`);
    let cursor = plan.cursor;
    let held = plan.held;
    let checkedAt = 0;
    while (!stopped) {
      const readAt = elapsed();
      let page: { cursor: string; events: EventItem[] };
      try {
        page = await readEvents(rc.db.db, { channels: plan.channels, cursor, now: rc.services.clock(), epoch: plan.epoch });
      } catch (error) {
        if (!isDomainError(error) || error.code !== 'EVENTS_CURSOR_EXPIRED') throw error;
        await send(EXPIRED);
        return;
      }
      if (stopped) return;
      let last = held;
      for (const e of page.events) {
        // Only a type publish() accepts (EVENT_TYPES, R1c-8) reaches the `event:` line: never a control name of the
        // stream (`expired`, …), nor a line break, from a row written past publish().
        if (!isEventType(e.type)) continue;
        last = formatCursor(plan.epoch, e.seq);
        await send(eventMessage(last, e));
      }
      // The browser's Last-Event-ID follows the cursor, also when no event carried it (an `id` alone is no event).
      if (page.cursor !== last) await send(`id: ${page.cursor}\n\n`);
      held = page.cursor;
      cursor = page.cursor;

      sleeping = true;
      await sleepUntil(readAt + SSE_READ_MS);
      sleeping = false;
      if (stopped) return;
      if (elapsed() - checkedAt >= SSE_AUTH_MS) {
        checkedAt = elapsed();
        const verdict = await recheck(rc, plan);
        if (stopped) return;
        if (verdict === 'epoch') {
          await send(EXPIRED);
          return;
        }
        if (verdict === 'auth') return;
        await send(HEARTBEAT);
      }
    }
  } catch (error) {
    // The database went away, a file could not be read, …: the browser reconnects (or falls back to polling).
    rc.log.warn('event stream ended by an error', { route: 'events.stream', err: loggableError(error) });
  } finally {
    clearTimeout(limit);
    stop();
    plan.release();
  }
}

/** GET events/stream. */
const eventsStream = route({
  id: 'events.stream',
  method: 'GET',
  path: `${EVENTS}/stream`,
  public: true,
  session: 'required',
  background: true,
  mode: 'system',
  maintenance: 'allow',
  idempotency: 'none',
  audit: null,
  query: EventsQuery,
  handler: async (rc) => {
    const { services, c } = rc;
    const db = rc.db.db;
    const setting = await services.settings.get<boolean | null>(db, 'realtime.sse');
    if (!sseEnabled(setting, services.runtime)) throw new DomainError('REALTIME_SSE_DISABLED');
    const auth = authOf(rc);
    const channels = channelList(rc.query.channels);
    await allowedChannels(db, { id: auth.subjectId, grants: auth.grants }, channels);
    const streamHeaders = { 'Content-Type': 'text/event-stream', ...NO_STORE, 'X-Accel-Buffering': 'no' };
    // HEAD (Hono answers it with the GET route) would hold a slot for a stream nobody reads.
    if (c.req.method === 'HEAD') return new Response(null, { status: 200, headers: streamHeaders });

    const token = readAuthCookie(c, 'altis_sid');
    // Unreachable: step 7 found the session by this cookie.
    if (token === undefined) throw new TypeError('events.stream: no session cookie');
    const lastEventId = c.req.header('last-event-id');
    const held = lastEventId === undefined || lastEventId === '' ? null : lastEventId;
    const epoch = await readDataEpoch(services.dataDir);

    if (!services.streams.tryAcquire()) return { status: 204, headers: NO_STORE };
    let released = false;
    const plan: StreamPlan = {
      channels,
      cursor: held ?? rc.query.cursor ?? null,
      held,
      epoch,
      token,
      authzVersion: auth.user.authzVersion,
      release: () => {
        if (released) return;
        released = true;
        services.streams.release();
      },
    };
    try {
      const res = streamSSE(c, (stream) => runStream(rc, stream, plan));
      for (const [name, value] of Object.entries(streamHeaders)) res.headers.set(name, value);
      return res;
    } catch (error) {
      plan.release();
      throw error;
    }
  },
});

export const EVENTS_ROUTES: RouteDecl[] = [eventsPoll, eventsStream];
