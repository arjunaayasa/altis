import { EVENT_CHANNELS_MAX, EVENT_TYPES, type EventItem, type EventsResponse } from '@altis/shared/api/events';
import type { QueryClient, QueryKey } from '@tanstack/react-query';
import { createContext, useContext, useEffect, useRef } from 'react';
import { api, inBackground } from './api';

/**
 * The SPA's realtime client (spec §10.6-10.8, Task 28): the hints of the events API (`GET events` polling,
 * `GET events/stream` SSE; wire format in @altis/shared/api/events) for the channels the open screens need. Events
 * are hints: a screen that hears one reads its data again (the shell invalidates React Query keys,
 * {@link realtimeQueryKeys}).
 *
 * One client per tab (the shell's {@link createRealtimeHub}) and one reader per browser (§10.8 "satu stream per
 * browser lewat tab pemimpin"):
 *
 *   election   while visible: navigator.locks.request('altis-realtime', lead)       // S20: held only while visible
 *              hidden → the leader closes its stream and releases the lock; a follower leaves the queue
 *              visible again → it asks for the lock again; no Locks API (or one that refuses: an opaque origin),
 *              or no BroadcastChannel → every tab is its own leader
 *   followers  BroadcastChannel('altis-realtime'): {events, cursor} | {resync} → the same handlers; each tab also
 *              announces its own channels ({want, tab, scope}: at start, on change, every 30 s, and when a new
 *              leader says {hello}); the leader reads the union with the channels of the tabs of the same user
 *              (scope) announced in the last 90 s, at most 20 (EVENT_CHANNELS_MAX)
 *   lead       a new leadership keeps the tab's cursor only when it is fresh: read with, or posted by a leader,
 *              within 30 s (a hand-off between live tabs); an older one is dropped and the screens read their data
 *              again (one resync) instead of replaying the backlog of a hidden hour
 *              loop while running and visible:
 *              transport 'sse' and no SSE back-off:
 *                open /api/v1/events/stream?channels=…[&cursor=…]; each typed event → cursor = its lastEventId,
 *                deliver; `expired` → resync (cursor null, seen seqs forgotten) and open again without a cursor;
 *                an error with readyState CLOSED (204 over the limit, 409 SSE off, 403) → failures (when the
 *                stream read other tabs' channels, one poll first says whether a 403 refused them: then they are
 *                left out for 5 min and the stream opens again at once, no failure counted); two within
 *                60 s → SSE backs off for 5 min (polling meanwhile; onTransportStale: the shell reads auth/me
 *                again), else open again after 1 s; an error while CONNECTING is the browser reconnecting (the
 *                server ends a stream within 25 s): nothing to do; the channels changing reopens the stream from
 *                the cursor; every 10 s an open stream counts as reading with the cursor (deliver)
 *              otherwise: poll(cursor, channels) with `X-Altis-Background: 1`; 410 → resync; a 403 while the
 *                union holds other tabs' channels → their channels are left out for 5 min, polled again at once; a
 *                403 of this tab's own → onDenied (its rights changed: the shell reads auth/me again), once a minute;
 *                then wait 2.5 s while active (input within 60 s), else 20 s; an input during the 20 s wait
 *                polls 2.5 s after the last poll at the latest; becoming visible polls at once; no wait past the
 *                end of an SSE back-off
 *   deliver    the seqs seen among the last 500 are dropped (the overlap rescan re-sends events), the rest is
 *              posted to the followers with the cursor (also when only the cursor moved, and at least every 10 s
 *              while the leader reads: the followers know it is fresh), then handed to onEvents
 *
 * Where the brief's algorithm is silent or this departs from it: a fresh cursor survives a change of leader (a new
 * leader starts from the last cursor the old one posted, so the events between the two are read rather than lost),
 * the SSE back-off and its failures belong to the tab (not to one leadership), the union of the followers' channels
 * and its 403 guard, `onDenied`, `onTransportStale`, and `update()` (the channels changed).
 */

/** The poll interval while the user is active (input within {@link ACTIVE_WINDOW_MS}; §10.8 "2–3 detik"). */
export const ACTIVE_POLL_MS = 2_500;
/** The poll interval while the user is idle (§10.8 "15–30 detik"). */
export const IDLE_POLL_MS = 20_000;
/** How long after the last input the user counts as active. */
export const ACTIVE_WINDOW_MS = 60_000;
/** The name of the leader lock and of the broadcast channel. */
export const REALTIME_NAME = 'altis-realtime';
/**
 * A new leadership starts from the tab's cursor only when the cursor was read with, or posted by a leader, within this
 * long (a hand-off between live tabs). An older cursor would replay what was published while no tab read (a tab
 * hidden for hours: up to 500 events a page), which the screens need not hear: they read their data again instead.
 */
export const HANDOFF_MS = 30_000;
/** A leader posts its cursor to the followers at least this often while it reads, even when it did not move. */
const CURSOR_KEEPALIVE_MS = 10_000;
const STREAM_PATH = '/api/v1/events/stream';
/** `EventSource.CLOSED` (the global is absent outside browsers). */
const ES_CLOSED = 2;
const SSE_FAILURE_WINDOW_MS = 60_000;
const SSE_BACKOFF_MS = 5 * 60_000;
const SSE_REOPEN_MS = 1_000;
/**
 * How often an open stream's loop looks again at the channels and the transport without being woken; an open stream
 * then counts as reading with the cursor (posted to the followers, {@link CURSOR_KEEPALIVE_MS}).
 */
const SSE_RECHECK_MS = CURSOR_KEEPALIVE_MS;
/** `EventSource.OPEN`. */
const ES_OPEN = 1;
const SEEN_MAX = 500;
const WANT_REFRESH_MS = 30_000;
const WANT_TTL_MS = 90_000;
const FOREIGN_OFF_MS = 5 * 60_000;
const DENIED_EVERY_MS = 60_000;

export interface RealtimeOptions {
  /** The channels this tab reads (`user.<id>`, `jobs.<id>`, `system.*`). */
  channels(): string[];
  /** `me.client.realtime`: SSE where the server allows it, else polling. Read again before each stream or poll. */
  transport(): 'sse' | 'polling';
  /** `GET events` (background); rejects with an error whose `status` is 410 for an expired cursor. */
  poll(cursor: string | null, channels: string[]): Promise<EventsResponse>;
  /** Opens `url` (`GET events/stream`). */
  openStream(url: string): EventSource;
  /** New events (never one already delivered), in order. */
  onEvents(events: EventItem[]): void;
  /** The cursor expired (a restore, a cursor older than retention): every screen reads its data again. */
  onResync(): void;
  /**
   * A poll of this tab's own channels was refused (403, §10.7: rights are checked again at every poll): the user's
   * rights may have changed, so the shell reads `auth/me` again (and with it the channels). At most once a minute.
   */
  onDenied?(): void;
  /**
   * SSE was refused twice within a minute and backs off for 5 min: the server may have turned it off (409
   * `REALTIME_SSE_DISABLED`), so the shell reads `auth/me` again (`me.client.realtime`, the transport to use).
   */
  onTransportStale?(): void;
  clock?: () => number;
  doc?: Document;
  /** The Locks API; null: none (every tab is its own leader). Default `navigator.locks`. */
  locks?: LockManager | null;
  /** The broadcast channel to the other tabs; null: none. Default a `BroadcastChannel` of its own while the Locks API exists. */
  channel?: BroadcastChannel | null;
  /** Whose channels these are (the signed-in user): the leader reads the channels of the tabs of the same scope only. */
  scope?: () => string;
}

export interface Realtime {
  start(): void;
  stop(): void;
  /** User input: the user counts as active (the short poll interval). */
  touch(): void;
  /** `channels()` or `transport()` changed: announced to the leader, read again by this tab if it leads. */
  update(): void;
}

/** A pending wait of the leader's loop: ends at its time, or at once (`done`). */
interface Waiter {
  /** The idle wait: an input shortens it. */
  idle: boolean;
  dueAt: number;
  timer: ReturnType<typeof setTimeout> | undefined;
  done(): void;
}

/** One `start()` … `stop()`. */
interface Run {
  live: boolean;
  /** Waiting for the lock or leading. */
  electing: boolean;
  leading: boolean;
  /** The channels the leader reads with now (its last poll, its open stream). */
  usedKey: string;
  lockAbort: AbortController | null;
  waiter: Waiter | null;
}

/** The last {@link SEEN_MAX} seqs delivered. */
class RecentSeqs {
  private readonly order: number[] = [];
  private readonly set = new Set<number>();
  /** False when `seq` was seen; otherwise remembers it. */
  add(seq: number): boolean {
    if (this.set.has(seq)) return false;
    this.set.add(seq);
    this.order.push(seq);
    if (this.order.length > SEEN_MAX) this.set.delete(this.order.shift()!);
    return true;
  }
  clear(): void {
    this.order.length = 0;
    this.set.clear();
  }
}

function isRecord(value: unknown): value is Record<string, unknown> {
  return typeof value === 'object' && value !== null && !Array.isArray(value);
}

function isEventItem(value: unknown): value is EventItem {
  return (
    isRecord(value) &&
    Number.isSafeInteger(value['seq']) &&
    typeof value['channel'] === 'string' &&
    typeof value['type'] === 'string' &&
    isRecord(value['payload']) &&
    typeof value['at'] === 'number'
  );
}

/** The HTTP status an error carries (an ApiError), or null. */
function statusOf(error: unknown): number | null {
  return isRecord(error) && typeof error['status'] === 'number' ? error['status'] : null;
}

/** One SSE message as an event: its seq from `lastEventId` (`<epoch>.<seq>`), its type from the event name. */
function streamItem(ev: Event): EventItem | null {
  const m = ev as MessageEvent<unknown>;
  if (typeof m.lastEventId !== 'string' || typeof m.data !== 'string') return null;
  const dot = m.lastEventId.lastIndexOf('.');
  const seq = Number(m.lastEventId.slice(dot + 1));
  if (dot < 1 || m.lastEventId.length === dot + 1 || !Number.isSafeInteger(seq) || seq < 0) return null;
  let data: unknown;
  try {
    data = JSON.parse(m.data);
  } catch {
    return null;
  }
  if (!isRecord(data) || typeof data['channel'] !== 'string' || !isRecord(data['payload']) || typeof data['at'] !== 'number') return null;
  return { seq, channel: data['channel'], type: ev.type, payload: data['payload'], at: data['at'] };
}

function defaultLocks(): LockManager | null {
  if (typeof navigator === 'undefined') return null;
  return (navigator as { locks?: LockManager }).locks ?? null;
}

let tabCounter = 0;

/** The realtime client of one tab (see the top of this file). Nothing runs until `start()`. */
export function createRealtime(o: RealtimeOptions): Realtime {
  const clock = o.clock ?? (() => Date.now());
  const doc = o.doc ?? document;
  // Without a channel to the other tabs a follower would hear nothing: every tab leads then.
  const shared = o.channel === undefined ? typeof BroadcastChannel === 'function' : o.channel !== null;
  const locks = shared ? (o.locks === undefined ? defaultLocks() : o.locks) : null;
  const scope = o.scope ?? (() => '');
  const tab = `${Date.now().toString(36)}-${Math.random().toString(36).slice(2)}-${++tabCounter}`;

  let run: Run | null = null;
  let bus: BroadcastChannel | null = null;
  let ownBus = false;
  let refresh: ReturnType<typeof setInterval> | null = null;

  let cursor: string | null = null;
  /** When `cursor` was last known current: read with by this tab's leadership, or posted by a leader. */
  let cursorAt = -Infinity;
  let posted: string | null = null;
  let postedAt = -Infinity;
  const seen = new RecentSeqs();
  let sseBackoffUntil = 0;
  let failures: number[] = [];
  let lastInput = 0;
  let lastPollAt = -Infinity;
  /** The channels of the other tabs, by tab, with the user they were announced for. */
  const wants = new Map<string, { channels: string[]; at: number; scope: string }>();
  let foreignOffUntil = 0;
  let deniedAt = -Infinity;
  /** False once the Locks API refused a request for another reason than an abort (an opaque origin): every tab leads. */
  let lockable = locks !== null;

  function post(message: Record<string, unknown>): void {
    try {
      bus?.postMessage(message);
    } catch {
      // A closed channel: nobody to tell.
    }
  }

  function announce(): void {
    if (locks === null) return;
    post({ want: [...new Set(o.channels())], tab, scope: scope() });
  }

  /** What the leader reads: this tab's channels, then the other tabs' (same scope, fresh, not refused lately). */
  function readChannels(): { list: string[]; foreign: boolean } {
    const list = [...new Set(o.channels())];
    const own = list.length;
    const now = clock();
    const user = scope();
    if (locks !== null && now >= foreignOffUntil) {
      for (const [id, want] of wants) {
        // Expired, or announced for another user (someone else signed in on this browser since): left out at once.
        if (now - want.at > WANT_TTL_MS || want.scope !== user) {
          wants.delete(id);
          continue;
        }
        for (const channel of want.channels) if (!list.includes(channel)) list.push(channel);
      }
    }
    const read = list.slice(0, EVENT_CHANNELS_MAX);
    return { list: read, foreign: read.length > own };
  }

  const keyOf = (channels: readonly string[]): string => channels.join(',');

  function sleep(r: Run, ms: number, idle: boolean): Promise<void> {
    return new Promise((resolve) => {
      const w: Waiter = {
        idle,
        dueAt: clock() + ms,
        timer: undefined,
        done: () => {
          clearTimeout(w.timer);
          if (r.waiter === w) r.waiter = null;
          resolve();
        },
      };
      w.timer = setTimeout(w.done, ms);
      r.waiter = w;
    });
  }

  function wake(r: Run): void {
    r.waiter?.done();
  }

  function resync(broadcast: boolean): void {
    cursor = null;
    posted = null;
    seen.clear();
    if (broadcast) post({ resync: true });
    o.onResync();
  }

  /**
   * Hands the new ones of `events` to this tab and to the followers, with the cursor `next` the leader reads with now:
   * posted when it moved, and at least every {@link CURSOR_KEEPALIVE_MS} anyway (the followers keep it fresh).
   */
  function deliver(events: readonly EventItem[], next: string | null): void {
    const fresh = events.filter((e) => seen.add(e.seq));
    const now = clock();
    cursorAt = now;
    if (fresh.length > 0 || next !== posted || now - postedAt >= CURSOR_KEEPALIVE_MS) {
      post({ events: fresh, cursor: next });
      posted = next;
      postedAt = now;
    }
    if (fresh.length > 0) o.onEvents(fresh);
  }

  async function pollStep(r: Run): Promise<void> {
    const { list, foreign } = readChannels();
    if (list.length > 0) {
      r.usedKey = keyOf(list);
      lastPollAt = clock();
      try {
        const answer = await o.poll(cursor, list);
        if (!r.live) return;
        deliver(Array.isArray(answer.events) ? answer.events : [], answer.cursor);
        cursor = answer.cursor;
      } catch (error) {
        if (!r.live) return;
        const status = statusOf(error);
        if (status === 410) {
          resync(true);
        } else if (status === 403 && foreign) {
          // One refused channel refuses the whole request (§10.7): another tab's (a job it shows, rights it no longer
          // holds) must not keep this tab's own hints away. Its channels are left out for a while.
          foreignOffUntil = clock() + FOREIGN_OFF_MS;
          return;
        } else if (status === 403 && clock() >= deniedAt + DENIED_EVERY_MS) {
          deniedAt = clock();
          o.onDenied?.();
        }
        // Anything else (offline, a 5xx, the session gone: the shell handles that): the next poll tries again.
      }
    }
    if (!r.live || doc.hidden) return;
    const active = clock() - lastInput < ACTIVE_WINDOW_MS;
    let ms = active ? ACTIVE_POLL_MS : IDLE_POLL_MS;
    if (o.transport() === 'sse') ms = Math.min(ms, Math.max(0, sseBackoffUntil - clock()));
    await sleep(r, ms, !active);
  }

  async function stream(r: Run): Promise<void> {
    const { list, foreign } = readChannels();
    if (list.length === 0) {
      await sleep(r, IDLE_POLL_MS, false);
      return;
    }
    const key = keyOf(list);
    r.usedKey = key;
    const query = new URLSearchParams({ channels: key });
    if (cursor !== null) query.set('cursor', cursor);
    let outcome: 'expired' | 'failed' | null = null;
    let es: EventSource;
    try {
      es = o.openStream(`${STREAM_PATH}?${query.toString()}`);
    } catch {
      await streamFailed(r); // a stream that cannot even be opened counts as a refused one
      return;
    }
    const onEvent = (ev: Event): void => {
      if (!r.live || outcome !== null) return;
      const item = streamItem(ev);
      if (item === null) return;
      cursor = (ev as MessageEvent).lastEventId;
      deliver([item], cursor);
    };
    const onExpired = (): void => {
      outcome ??= 'expired';
      wake(r);
    };
    const onError = (): void => {
      // CONNECTING: the browser reconnects by itself (with Last-Event-ID). CLOSED: it gave up (a 204, 409 or 403).
      if (es.readyState !== ES_CLOSED) return;
      outcome ??= 'failed';
      wake(r);
    };
    // An EventSource hands a named event (`event: <type>`) only to a listener of that name: the stream is listened to
    // for every type of the registry (R1c-8: publish() refuses any other), and for unnamed messages.
    const types = [...EVENT_TYPES, 'message'];
    for (const type of types) es.addEventListener(type, onEvent);
    es.addEventListener('expired', onExpired);
    es.addEventListener('error', onError);
    try {
      while (r.live && !doc.hidden && outcome === null && o.transport() === 'sse' && keyOf(readChannels().list) === key) {
        await sleep(r, SSE_RECHECK_MS, false);
        // An open stream reads with the cursor: it is current (the followers hear so).
        if (r.live && outcome === null && es.readyState === ES_OPEN) deliver([], cursor);
      }
    } finally {
      for (const type of types) es.removeEventListener(type, onEvent);
      es.removeEventListener('expired', onExpired);
      es.removeEventListener('error', onError);
      es.close();
    }
    if (!r.live) return;
    if (outcome === 'expired') resync(true); // opened again at once, without a cursor
    else if (outcome === 'failed' && !(foreign && (await refusedForeign(r, list)))) await streamFailed(r);
  }

  /**
   * After a stream that read other tabs' channels failed: one poll with the same channels says why (an EventSource
   * does not tell a 403 from a 204 or a 409). A 403 may be another tab's channel (one refused channel refuses the whole
   * request, §10.7): as in a poll, their channels are left out for a while and true is returned, so the stream opens
   * again at once with this tab's own and no SSE failure is counted; a 410 resyncs (true as well). Otherwise the
   * poll's events are delivered and false is returned: the failure was the stream's own.
   */
  async function refusedForeign(r: Run, list: string[]): Promise<boolean> {
    lastPollAt = clock();
    try {
      const answer = await o.poll(cursor, list);
      if (!r.live) return true;
      deliver(Array.isArray(answer.events) ? answer.events : [], answer.cursor);
      cursor = answer.cursor;
      return false;
    } catch (error) {
      if (!r.live) return true;
      const status = statusOf(error);
      if (status === 410) {
        resync(true);
        return true;
      }
      if (status !== 403) return false;
      foreignOffUntil = clock() + FOREIGN_OFF_MS;
      return true;
    }
  }

  /** A stream the browser gave up on: the second within 60 s backs SSE off for 5 min, else it opens again after 1 s. */
  async function streamFailed(r: Run): Promise<void> {
    const now = clock();
    failures = failures.filter((at) => now - at < SSE_FAILURE_WINDOW_MS);
    failures.push(now);
    if (failures.length >= 2) {
      failures = [];
      sseBackoffUntil = now + SSE_BACKOFF_MS;
      o.onTransportStale?.();
    } else {
      await sleep(r, SSE_REOPEN_MS, false);
    }
  }

  async function lead(r: Run): Promise<void> {
    if (!r.live || doc.hidden) return;
    // Only a fresh hand-off carries the cursor over (HANDOFF_MS); the brief's runLeader starts with cursor = null.
    if (cursor !== null && clock() - cursorAt > HANDOFF_MS) resync(false);
    r.leading = true;
    post({ hello: true });
    try {
      while (r.live && !doc.hidden) {
        try {
          if (o.transport() === 'sse' && clock() >= sseBackoffUntil) await stream(r);
          else await pollStep(r);
        } catch {
          // A failure of this code or of a handler: never a busy loop.
          if (r.live && !doc.hidden) await sleep(r, ACTIVE_POLL_MS, false);
        }
      }
    } finally {
      r.leading = false;
      r.usedKey = '';
    }
  }

  /** Asks for the lead while visible (S20); without the Locks API, leads at once. */
  function elect(r: Run): void {
    if (!r.live || r.electing || doc.hidden) return;
    r.electing = true;
    let led: Promise<unknown>;
    if (locks === null || !lockable) {
      led = lead(r);
    } else {
      const abort = new AbortController();
      r.lockAbort = abort;
      led = locks.request(REALTIME_NAME, { signal: abort.signal }, () => {
        r.lockAbort = null;
        return lead(r);
      });
      // An aborted request (hidden, stopped) is expected; any other refusal would refuse every request again.
      led = led.catch(() => {
        if (!abort.signal.aborted) lockable = false;
      });
    }
    void led
      .catch(() => undefined)
      .then(() => {
        r.electing = false;
        r.lockAbort = null;
        elect(r); // visible again meanwhile
      });
  }

  const onVisibility = (): void => {
    const r = run;
    if (r === null) return;
    if (doc.hidden) {
      r.lockAbort?.abort(); // a follower leaves the queue
      wake(r); // a leader closes its stream and releases the lock
    } else {
      lastInput = clock();
      wake(r);
      elect(r);
    }
  };

  const onMessage = (ev: MessageEvent<unknown>): void => {
    const r = run;
    const m = ev.data;
    if (r === null || !isRecord(m)) return;
    if (m['resync'] === true) {
      if (!r.leading) resync(false);
      return;
    }
    if (Array.isArray(m['events'])) {
      const fresh = m['events'].filter(isEventItem).filter((e) => seen.add(e.seq));
      if (!r.leading && (typeof m['cursor'] === 'string' || m['cursor'] === null)) {
        cursor = m['cursor'];
        cursorAt = clock();
        posted = cursor;
      }
      if (fresh.length > 0) o.onEvents(fresh);
      return;
    }
    if (m['hello'] === true) {
      announce();
      return;
    }
    if (typeof m['tab'] === 'string' && Array.isArray(m['want']) && typeof m['scope'] === 'string') {
      if (locks === null || m['scope'] !== scope()) return;
      const before = keyOf(readChannels().list);
      const channels = m['want'].filter((c): c is string => typeof c === 'string');
      if (channels.length === 0) wants.delete(m['tab']);
      else wants.set(m['tab'], { channels, at: clock(), scope: m['scope'] });
      if (r.leading && keyOf(readChannels().list) !== before) wake(r);
    }
  };

  return {
    start() {
      if (run !== null) return;
      const r: Run = { live: true, electing: false, leading: false, usedKey: '', lockAbort: null, waiter: null };
      run = r;
      lastInput = clock();
      ownBus = o.channel === undefined;
      bus = ownBus ? (locks !== null && typeof BroadcastChannel === 'function' ? new BroadcastChannel(REALTIME_NAME) : null) : (o.channel ?? null);
      bus?.addEventListener('message', onMessage);
      doc.addEventListener('visibilitychange', onVisibility);
      if (locks !== null && bus !== null) {
        announce();
        refresh = setInterval(announce, WANT_REFRESH_MS);
      }
      elect(r);
    },
    stop() {
      const r = run;
      if (r === null) return;
      if (locks !== null) post({ want: [], tab, scope: scope() });
      run = null;
      r.live = false;
      if (refresh !== null) clearInterval(refresh);
      refresh = null;
      doc.removeEventListener('visibilitychange', onVisibility);
      bus?.removeEventListener('message', onMessage);
      if (ownBus) bus?.close();
      bus = null;
      r.lockAbort?.abort();
      wake(r); // the leader's loop ends (closing its stream) and releases the lock
    },
    touch() {
      lastInput = clock();
      const w = run?.waiter;
      if (w === null || w === undefined || !w.idle) return;
      w.idle = false;
      const dueAt = Math.min(w.dueAt, lastPollAt + ACTIVE_POLL_MS);
      if (dueAt >= w.dueAt) return;
      w.dueAt = dueAt;
      clearTimeout(w.timer);
      w.timer = setTimeout(w.done, Math.max(0, dueAt - clock()));
    },
    update() {
      const r = run;
      if (r === null) return;
      announce();
      if (r.leading && keyOf(readChannels().list) !== r.usedKey) wake(r);
    },
  };
}

// ---------------------------------------------------------------------------------------------------------------
// The tab's hub: one client, the screens' subscriptions (useRealtime), user input

/** The tab's realtime client as the screens see it (the shell creates it and provides it, {@link RealtimeContext}). */
export interface RealtimeHub {
  /** Adds `channels` to the tab's; `onEvent` hears every event of them. Returns the function that takes them away. */
  subscribe(channels: readonly string[], onEvent: (e: EventItem) => void): () => void;
  start(): void;
  stop(): void;
  /** The transport changed (`me.client`). */
  refresh(): void;
}

/** What counts as user input (the active poll interval). */
const INPUT_EVENTS = ['pointerdown', 'pointermove', 'keydown', 'wheel', 'touchstart'] as const;

/** `GET events` in the background (it must not keep an idle session alive). */
function pollEvents(cursor: string | null, channels: string[]): Promise<EventsResponse> {
  const query = new URLSearchParams({ channels: channels.join(',') });
  if (cursor !== null) query.set('cursor', cursor);
  return api<EventsResponse>('GET', `events?${query.toString()}`, undefined, { background: true });
}

/**
 * The tab's client over the screens' subscriptions: it reads the union of their channels, hands every batch of events
 * to `onEvents` (the shell's invalidations, once per batch) and each event to the subscriptions of its channel, and
 * counts input on `doc` as activity.
 */
export function createRealtimeHub(o: {
  transport(): 'sse' | 'polling';
  /** The signed-in user (the leader reads other tabs' channels of the same user only). */
  scope(): string;
  onEvents(events: EventItem[]): void;
  onResync(): void;
  onDenied?(): void;
  onTransportStale?(): void;
  poll?: RealtimeOptions['poll'];
  openStream?: RealtimeOptions['openStream'];
  doc?: Document;
  locks?: LockManager | null;
  channel?: BroadcastChannel | null;
}): RealtimeHub {
  const doc = o.doc ?? document;
  const subscriptions = new Set<{ channels: readonly string[]; onEvent(e: EventItem): void }>();
  const rt = createRealtime({
    channels: () => [...new Set([...subscriptions].flatMap((s) => s.channels))],
    transport: () => o.transport(),
    scope: () => o.scope(),
    poll: o.poll ?? pollEvents,
    openStream: o.openStream ?? ((url) => new EventSource(url)),
    onEvents: (events) => {
      o.onEvents(events);
      for (const e of events) {
        for (const s of [...subscriptions]) if (s.channels.includes(e.channel)) s.onEvent(e);
      }
    },
    onResync: () => o.onResync(),
    onDenied: () => o.onDenied?.(),
    onTransportStale: () => o.onTransportStale?.(),
    doc,
    ...(o.locks === undefined ? {} : { locks: o.locks }),
    ...(o.channel === undefined ? {} : { channel: o.channel }),
  });
  const touch = (): void => rt.touch();
  return {
    subscribe(channels, onEvent) {
      const s = { channels: [...channels], onEvent };
      subscriptions.add(s);
      rt.update();
      return () => {
        if (subscriptions.delete(s)) rt.update();
      };
    },
    start() {
      for (const type of INPUT_EVENTS) doc.addEventListener(type, touch, { capture: true, passive: true });
      rt.start();
    },
    stop() {
      rt.stop();
      for (const type of INPUT_EVENTS) doc.removeEventListener(type, touch, { capture: true });
    },
    refresh() {
      rt.update();
    },
  };
}

/** The tab's hub, provided by the shell; null outside it ({@link useRealtime} then does nothing). */
export const RealtimeContext = createContext<RealtimeHub | null>(null);

/**
 * Reads `channels` while the calling component is mounted; `onEvent` hears their events (the latest `onEvent` is
 * called: it need not be stable). A screen showing a job uses `useRealtime([`jobs.${id}`], …)`; the shell already
 * makes the queries the event names stale ({@link realtimeQueryKeys}).
 */
export function useRealtime(channels: string[], onEvent: (e: EventItem) => void): void {
  const hub = useContext(RealtimeContext);
  const handler = useRef(onEvent);
  useEffect(() => {
    handler.current = onEvent;
  });
  const key = [...new Set(channels)].join(',');
  useEffect(() => {
    if (hub === null || key === '') return;
    return hub.subscribe(key.split(','), (e) => handler.current(e));
  }, [hub, key]);
}

/**
 * The React Query keys an event makes stale (the shell invalidates them): `notification` → `['notifications']`;
 * otherwise `jobs.<id>` → `['jobs', id]`, `op.*` → `['ops']`, `system.backup` → `['backups']`, and `['dashboard']`
 * for anything but a `*.progress` hint (a running job or op sends many).
 */
export function realtimeQueryKeys(e: EventItem): QueryKey[] {
  if (e.type === 'notification') return [['notifications']];
  const keys: QueryKey[] = [];
  if (e.channel.startsWith('jobs.')) keys.push(['jobs', e.channel.slice('jobs.'.length)]);
  if (e.type.startsWith('op.')) keys.push(['ops']);
  if (e.channel === 'system.backup') keys.push(['backups']);
  if (!e.type.endsWith('.progress')) keys.push(['dashboard']);
  return keys;
}

/** The query keys a resync makes stale: everything the events stand for. */
export const REALTIME_RESYNC_KEYS: readonly QueryKey[] = Object.freeze([['notifications'], ['dashboard'], ['backups'], ['jobs'], ['ops']]);

/**
 * Makes `keys` stale in `client`: the shell's handler of a batch of events ({@link realtimeQueryKeys} of each) or of a
 * resync. Each distinct key is invalidated once, however many events of the batch name it, and a fetch already under
 * way is joined rather than cancelled and started again (`cancelRefetch: false`): an event is read at least 2 s after
 * its transaction committed, so a fetch running by then normally sees what it hints at. While the tab is `hidden` the
 * queries are only marked stale (`refetchType: 'none'`, §10.8 "berhenti saat tab tersembunyi"): nobody sees them, and
 * refetchOnWindowFocus reads them again when the tab is shown. The fetches it starts are background requests
 * ({@link inBackground}): an event is no sign of the user, and must not keep an idle session alive (§7.1).
 */
export function invalidateRealtimeKeys(client: QueryClient, keys: readonly QueryKey[], hidden: boolean): void {
  const done = new Set<string>();
  for (const queryKey of keys) {
    const id = JSON.stringify(queryKey);
    if (done.has(id)) continue;
    done.add(id);
    inBackground(() => void client.invalidateQueries({ queryKey, refetchType: hidden ? 'none' : 'active' }, { cancelRefetch: false }));
  }
}
