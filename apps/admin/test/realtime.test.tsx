import { EVENT_TYPES, type EventItem, type EventsResponse, type StreamEventData } from '@altis/shared/api/events';
import { QueryClient, QueryObserver, type QueryKey } from '@tanstack/react-query';
import { act, render } from '@testing-library/react';
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import { api } from '@/lib/api';
import {
  RealtimeContext,
  createRealtime,
  createRealtimeHub,
  invalidateRealtimeKeys,
  realtimeQueryKeys,
  useRealtime,
  type Realtime,
} from '@/lib/realtime';

// The realtime client of the admin SPA (spec §10.8, Task 28) under fake timers: a fake document (its visibility), a
// fake EventSource, a fake lock manager (navigator.locks) and a fake BroadcastChannel bus that several "tabs" share.

const T0 = 1_760_000_000_000;

/** A document whose visibility a test sets. */
class FakeDoc extends EventTarget {
  hidden = false;
  get visibilityState(): DocumentVisibilityState {
    return this.hidden ? 'hidden' : 'visible';
  }
  setHidden(hidden: boolean): void {
    this.hidden = hidden;
    this.dispatchEvent(new Event('visibilitychange'));
  }
}

type Granted = (lock: Lock | null) => unknown;

/** navigator.locks with one exclusive lock: requests are granted in order, an aborted request leaves the queue. */
class FakeLocks {
  private held = false;
  private readonly queue: { cb: Granted; resolve(v: unknown): void; reject(e: unknown): void }[] = [];

  request(_name: string, a: LockOptions | Granted, b?: Granted): Promise<unknown> {
    const options: LockOptions = typeof a === 'function' ? {} : a;
    const cb = (typeof a === 'function' ? a : b) as Granted;
    return new Promise((resolve, reject) => {
      const aborted = () => reject(new DOMException('The request was aborted.', 'AbortError'));
      if (options.signal?.aborted === true) return aborted();
      const entry = { cb, resolve, reject };
      options.signal?.addEventListener('abort', () => {
        const i = this.queue.indexOf(entry);
        if (i < 0) return; // granted already: aborting changes nothing
        this.queue.splice(i, 1);
        aborted();
      });
      this.queue.push(entry);
      this.grant();
    });
  }

  private grant(): void {
    if (this.held) return;
    const entry = this.queue.shift();
    if (entry === undefined) return;
    this.held = true;
    void Promise.resolve()
      .then(() => entry.cb({ name: 'altis-realtime', mode: 'exclusive' } as Lock))
      .then(entry.resolve, entry.reject)
      .finally(() => {
        this.held = false;
        this.grant();
      });
  }
}

/** One BroadcastChannel name: a message posted by one end reaches every other open end, later (as a task would). */
class FakeBus {
  readonly ends = new Set<FakeEnd>();
  open(): BroadcastChannel {
    const end = new FakeEnd(this);
    this.ends.add(end);
    return end as unknown as BroadcastChannel;
  }
}

class FakeEnd extends EventTarget {
  constructor(private readonly bus: FakeBus) {
    super();
  }
  postMessage(data: unknown): void {
    const copy = structuredClone(data);
    for (const end of this.bus.ends) {
      if (end !== this) void Promise.resolve().then(() => end.dispatchEvent(new MessageEvent('message', { data: copy })));
    }
  }
  close(): void {
    this.bus.ends.delete(this);
  }
}

/** An EventSource the test drives: open, typed events with their id, `expired`, errors. */
class FakeEventSource extends EventTarget {
  readyState = 0;
  closed = false;
  constructor(readonly url: string) {
    super();
  }
  close(): void {
    this.readyState = 2;
    this.closed = true;
  }
  open(): void {
    this.readyState = 1;
    this.dispatchEvent(new Event('open'));
  }
  emit(type: string, id: string, data: StreamEventData): void {
    this.dispatchEvent(new MessageEvent(type, { data: JSON.stringify(data), lastEventId: id }));
  }
  expire(): void {
    this.dispatchEvent(new MessageEvent('expired', { data: '{}', lastEventId: '' }));
    this.readyState = 0; // the server ends the stream after `expired`; the browser would reconnect
  }
  /** An error: CLOSED (a 204, 409 or 403: the browser gives up) or CONNECTING (the server ended it: it reconnects). */
  fail(closed: boolean): void {
    this.readyState = closed ? 2 : 0;
    this.dispatchEvent(new Event('error'));
  }
  query(): URLSearchParams {
    return new URL(this.url, 'https://altis.test').searchParams;
  }
}

interface Poll {
  /** Milliseconds since T0. */
  at: number;
  cursor: string | null;
  channels: string[];
}

interface Tab {
  rt: Realtime;
  doc: FakeDoc;
  channels: string[];
  transport: 'sse' | 'polling';
  polls: Poll[];
  delivered: EventItem[];
  batches: number;
  resyncs: number;
  streams: FakeEventSource[];
  /** The answer of the next poll (a thrown value is the poll's failure). */
  answer: (p: Poll) => EventsResponse;
}

const tabs: Tab[] = [];

function tab(o: { channels?: string[]; transport?: 'sse' | 'polling'; locks?: FakeLocks; bus?: FakeBus; scope?: string | (() => string) } = {}): Tab {
  const doc = new FakeDoc();
  const t = {
    doc,
    channels: o.channels ?? ['system.status'],
    transport: o.transport ?? 'polling',
    polls: [],
    delivered: [],
    batches: 0,
    resyncs: 0,
    streams: [],
    answer: (p: Poll): EventsResponse => ({ cursor: `1.${p.at}`, events: [] }),
  } as Omit<Tab, 'rt'> as Tab;
  t.rt = createRealtime({
    channels: () => t.channels,
    transport: () => t.transport,
    poll: async (cursor, channels) => {
      const p = { at: Date.now() - T0, cursor, channels: [...channels] };
      t.polls.push(p);
      return t.answer(p);
    },
    openStream: (url) => {
      const es = new FakeEventSource(url);
      t.streams.push(es);
      return es as unknown as EventSource;
    },
    onEvents: (events) => {
      t.batches += 1;
      t.delivered.push(...events);
    },
    onResync: () => {
      t.resyncs += 1;
    },
    doc: doc as unknown as Document,
    locks: o.locks === undefined ? null : (o.locks as unknown as LockManager),
    channel: o.bus === undefined ? null : o.bus.open(),
    ...(o.scope === undefined ? {} : { scope: typeof o.scope === 'function' ? o.scope : () => o.scope as string }),
  });
  tabs.push(t);
  return t;
}

const ev = (seq: number, o: Partial<EventItem> = {}): EventItem => ({
  seq,
  channel: 'system.status',
  type: 'notification',
  payload: {},
  at: T0,
  ...o,
});

const seqs = (t: Tab): number[] => t.delivered.map((e) => e.seq);
const times = (t: Tab): number[] => t.polls.map((p) => p.at);
const advance = (ms: number) => vi.advanceTimersByTimeAsync(ms);
const flush = () => vi.advanceTimersByTimeAsync(0);

beforeEach(() => {
  vi.useFakeTimers({ now: T0 });
});

afterEach(() => {
  for (const t of tabs.splice(0)) t.rt.stop();
  vi.useRealTimers();
});

describe('createRealtime: polling', () => {
  it('polls at once, every 2.5 s while active and every 20 s after 60 s without input', async () => {
    const a = tab();
    a.rt.start();
    await flush();
    expect(times(a)).toEqual([0]);
    // Input while active changes nothing: the cadence stays 2.5 s.
    await advance(1_000);
    a.rt.touch();
    await advance(1_000);
    expect(times(a)).toEqual([0]);
    // The last input at 1 s: active until 61 s, then idle.
    await advance(100_500);
    expect(times(a)).toEqual([...Array.from({ length: 26 }, (_, i) => i * 2_500), 82_500, 102_500]);
  });

  it('an input during the idle wait brings the 2.5 s cadence back at once', async () => {
    const a = tab();
    a.rt.start();
    await advance(100_000); // the last poll at 100 s, the next one due at 120 s
    await advance(5_000);
    a.rt.touch();
    await flush();
    expect(times(a).slice(-2)).toEqual([100_000, 105_000]);
    await advance(5_000);
    expect(times(a).slice(-3)).toEqual([105_000, 107_500, 110_000]);
  });

  it('makes no request while the document is hidden and polls again as soon as it is visible', async () => {
    const a = tab();
    a.rt.start();
    await advance(1_000);
    a.doc.setHidden(true);
    await advance(60_000);
    expect(times(a)).toEqual([0]);
    a.doc.setHidden(false);
    await flush();
    expect(times(a)).toEqual([0, 61_000]);
    await advance(2_500);
    expect(times(a)).toEqual([0, 61_000, 63_500]);
  });

  it('sends the cursor of the previous answer; a 410 resyncs and starts again without a cursor', async () => {
    const a = tab();
    const answers: (EventsResponse | { status: number })[] = [
      { cursor: '1.5', events: [] },
      { status: 410 },
      { cursor: '2.0', events: [] },
      { cursor: '2.1', events: [] },
    ];
    a.answer = () => {
      const next = answers.shift()!;
      if ('status' in next) throw Object.assign(new Error('gone'), next);
      return next;
    };
    a.rt.start();
    await advance(7_500);
    expect(a.polls.map((p) => p.cursor)).toEqual([null, '1.5', null, '2.0']);
    expect(a.resyncs).toBe(1);
  });

  it('delivers an event read twice (the overlap rescan) once', async () => {
    const a = tab();
    const answers: EventsResponse[] = [
      { cursor: '1.2', events: [ev(1), ev(2)] },
      { cursor: '1.3', events: [ev(2), ev(3)] },
      { cursor: '1.3', events: [ev(3)] },
    ];
    a.answer = () => answers.shift() ?? { cursor: '1.3', events: [] };
    a.rt.start();
    await advance(5_000);
    expect(seqs(a)).toEqual([1, 2, 3]);
    expect(a.batches).toBe(2);
  });

  it("a 403 of the tab's own channels says so, at most once a minute", async () => {
    const denied = vi.fn();
    const rt = createRealtime({
      channels: () => ['system.backup'],
      transport: () => 'polling',
      poll: async () => {
        throw Object.assign(new Error('denied'), { status: 403 });
      },
      openStream: () => {
        throw new Error('no stream');
      },
      onEvents: () => {},
      onResync: () => {},
      onDenied: denied,
      doc: new FakeDoc() as unknown as Document,
      locks: null,
      channel: null,
    });
    rt.start();
    await advance(59_000);
    expect(denied).toHaveBeenCalledTimes(1);
    await advance(2_000);
    expect(denied).toHaveBeenCalledTimes(2);
    rt.stop();
  });

  it('started again after a stop (React StrictMode), runs one loop', async () => {
    const a = tab();
    a.rt.start();
    await flush();
    a.rt.stop();
    a.rt.start();
    await advance(5_000);
    expect(times(a)).toEqual([0, 0, 2_500, 5_000]);
  });

  it('leaves no timer behind once stopped', async () => {
    const a = tab();
    a.rt.start();
    await advance(3_000);
    a.rt.stop();
    await flush();
    expect(vi.getTimerCount()).toBe(0);
    await advance(60_000);
    expect(times(a)).toEqual([0, 2_500]);
  });
});

describe('createRealtime: SSE', () => {
  it("delivers a stream's events, and the cursor follows their lastEventId", async () => {
    const a = tab({ transport: 'sse', channels: ['user.U1', 'system.status'] });
    a.rt.start();
    await flush();
    expect(a.polls).toEqual([]);
    expect(a.streams).toHaveLength(1);
    const first = a.streams[0]!;
    expect(new URL(first.url, 'https://altis.test').pathname).toBe('/api/v1/events/stream');
    expect(first.query().get('channels')).toBe('user.U1,system.status');
    expect(first.query().has('cursor')).toBe(false);
    first.open();
    first.emit('job.progress', '4.10', { channel: 'jobs.J1', payload: { progress: 5 }, at: T0 + 1 });
    first.emit('notification', '4.11', { channel: 'user.U1', payload: {}, at: T0 + 2 });
    expect(a.delivered).toEqual([
      { seq: 10, channel: 'jobs.J1', type: 'job.progress', payload: { progress: 5 }, at: T0 + 1 },
      { seq: 11, channel: 'user.U1', type: 'notification', payload: {}, at: T0 + 2 },
    ]);
    // The server ends every stream within 25 s: the browser reconnects by itself (CONNECTING), nothing to do.
    first.fail(false);
    await advance(5_000);
    expect(a.streams).toHaveLength(1);
    // Closed for good (one 204): opened again from the cursor.
    first.fail(true);
    await advance(1_000);
    expect(first.closed).toBe(true);
    expect(a.streams).toHaveLength(2);
    expect(a.streams[1]!.query().get('cursor')).toBe('4.11');
  });

  it('listens for every type of the registry (R1c-8): EventSource hands a named event to its own listener only', async () => {
    const a = tab({ transport: 'sse' });
    a.rt.start();
    await flush();
    EVENT_TYPES.forEach((type, i) => {
      a.streams[0]!.emit(type, `1.${i + 1}`, { channel: 'system.status', payload: {}, at: T0 });
    });
    a.streams[0]!.emit('status.changed', '1.99', { channel: 'system.status', payload: {}, at: T0 });
    expect(a.delivered.map((e) => e.type)).toEqual([...EVENT_TYPES]);
    expect(a.delivered.map((e) => e.type)).toEqual(expect.arrayContaining(['backup.done', 'clock.anomaly']));
  });

  it('falls back to polling after two CLOSED errors within 60 s, and tries SSE again 5 min later', async () => {
    const a = tab({ transport: 'sse' });
    a.rt.start();
    await flush();
    a.streams[0]!.emit('notification', '2.3', { channel: 'system.status', payload: {}, at: T0 });
    a.streams[0]!.fail(true);
    await advance(1_000);
    expect(a.streams).toHaveLength(2);
    a.streams[1]!.fail(true);
    await flush();
    expect(a.streams[1]!.closed).toBe(true);
    expect(a.polls).toEqual([{ at: 1_000, cursor: '2.3', channels: ['system.status'] }]);
    await advance(2_500);
    expect(times(a)).toEqual([1_000, 3_500]);
    // Polling until 5 min after the second failure, then SSE again, from the cursor of the last poll.
    await advance(301_000 - 3_500 - 1);
    expect(a.streams).toHaveLength(2);
    const polled = a.polls.length;
    await advance(1);
    expect(a.streams).toHaveLength(3);
    expect(a.streams[2]!.query().get('cursor')).toBe(`1.${a.polls.at(-1)!.at}`);
    await advance(30_000);
    expect(a.polls).toHaveLength(polled);
  });

  it('an expired event resyncs and opens the stream again without a cursor', async () => {
    const a = tab({ transport: 'sse' });
    a.rt.start();
    await flush();
    a.streams[0]!.emit('notification', '5.8', { channel: 'system.status', payload: {}, at: T0 });
    a.streams[0]!.expire();
    await flush();
    expect(a.resyncs).toBe(1);
    expect(a.streams[0]!.closed).toBe(true);
    expect(a.streams).toHaveLength(2);
    expect(a.streams[1]!.query().has('cursor')).toBe(false);
    // After a restore the seqs start again: seq 8 of the new data epoch is a new event.
    a.streams[1]!.emit('notification', '6.8', { channel: 'system.status', payload: {}, at: T0 });
    expect(seqs(a)).toEqual([8, 8]);
  });

  it('delivers an event the stream sends twice once', async () => {
    const a = tab({ transport: 'sse' });
    a.rt.start();
    await flush();
    a.streams[0]!.emit('notification', '3.4', { channel: 'system.status', payload: {}, at: T0 });
    a.streams[0]!.emit('notification', '3.4', { channel: 'system.status', payload: {}, at: T0 });
    expect(seqs(a)).toEqual([4]);
  });

  it('a stream that cannot be opened counts as refused', async () => {
    const polls: (string | null)[] = [];
    let opened = 0;
    const rt = createRealtime({
      channels: () => ['system.status'],
      transport: () => 'sse',
      poll: async (cursor) => {
        polls.push(cursor);
        return { cursor: '1.1', events: [] };
      },
      openStream: () => {
        opened += 1;
        throw new SyntaxError('bad URL');
      },
      onEvents: () => {},
      onResync: () => {},
      doc: new FakeDoc() as unknown as Document,
      locks: null,
      channel: null,
    });
    rt.start();
    await advance(1_000);
    expect(opened).toBe(2);
    expect(polls).toEqual([null]);
    rt.stop();
  });

  it('closes the stream while the document is hidden', async () => {
    const a = tab({ transport: 'sse' });
    a.rt.start();
    await flush();
    a.doc.setHidden(true);
    await flush();
    expect(a.streams[0]!.closed).toBe(true);
    await advance(60_000);
    expect(a.streams).toHaveLength(1);
    a.doc.setHidden(false);
    await flush();
    expect(a.streams).toHaveLength(2);
  });
});

describe('createRealtime: one leader per browser', () => {
  it("only the leader requests; a follower hears the leader's events and takes over when it stops", async () => {
    const locks = new FakeLocks();
    const bus = new FakeBus();
    const a = tab({ locks, bus });
    const b = tab({ locks, bus });
    let next = 1;
    a.answer = (p) => ({ cursor: `1.${next}`, events: p.at === 2_500 ? [ev(next++)] : [] });
    a.rt.start();
    await flush();
    b.rt.start();
    await advance(5_000);
    expect(times(a)).toEqual([0, 2_500, 5_000]);
    expect(b.polls).toEqual([]);
    expect(seqs(a)).toEqual([1]);
    expect(seqs(b)).toEqual([1]);
    a.rt.stop();
    await flush();
    // The follower leads from the leader's last cursor: nothing published between the two is lost.
    expect(b.polls).toEqual([{ at: 5_000, cursor: '1.2', channels: ['system.status'] }]);
  });

  it('a leader that becomes hidden releases the lock; a visible follower takes over and keeps receiving events (S20)', async () => {
    const locks = new FakeLocks();
    const bus = new FakeBus();
    const a = tab({ locks, bus });
    const b = tab({ locks, bus });
    a.rt.start();
    await flush();
    b.rt.start();
    await advance(2_500);
    expect(times(a)).toEqual([0, 2_500]);
    a.doc.setHidden(true);
    await flush();
    expect(times(b)).toEqual([2_500]);
    b.answer = (p) => ({ cursor: `2.${p.at}`, events: p.at === 5_000 ? [ev(7)] : [] });
    await advance(2_500);
    expect(seqs(b)).toEqual([7]);
    expect(seqs(a)).toEqual([7]);
    await advance(30_000);
    expect(times(a)).toEqual([0, 2_500]);
    // Visible again: the lock is the follower's now, so the first tab waits for it.
    a.doc.setHidden(false);
    await advance(5_000);
    expect(times(a)).toEqual([0, 2_500]);
    b.doc.setHidden(true);
    await flush();
    expect(times(a)).toEqual([0, 2_500, 40_000]);
  });

  it('a Locks API that refuses (an opaque origin) leaves the tab its own leader', async () => {
    const bus = new FakeBus();
    const locks = { request: () => Promise.reject(new DOMException('opaque origin', 'SecurityError')) };
    const a = tab({ locks: locks as unknown as FakeLocks, bus });
    a.rt.start();
    await advance(2_500);
    expect(times(a)).toEqual([0, 2_500]);
  });

  it('a hidden follower does not queue for the lock', async () => {
    const locks = new FakeLocks();
    const bus = new FakeBus();
    const a = tab({ locks, bus });
    const b = tab({ locks, bus });
    const c = tab({ locks, bus });
    a.rt.start();
    b.doc.hidden = true;
    b.rt.start();
    c.rt.start();
    await flush();
    a.rt.stop();
    await flush();
    expect(b.polls).toEqual([]);
    expect(times(c)).toEqual([0]);
  });

  it("the leader reads the channels of the followers of the same user too, and drops them on a 403", async () => {
    const locks = new FakeLocks();
    const bus = new FakeBus();
    const a = tab({ locks, bus, scope: 'U1', channels: ['user.U1', 'system.status'] });
    const b = tab({ locks, bus, scope: 'U1', channels: ['system.status', 'jobs.J1'] });
    const c = tab({ locks, bus, scope: 'U2', channels: ['user.U2'] });
    a.rt.start();
    await flush();
    b.rt.start();
    c.rt.start();
    await flush();
    expect(a.polls.at(-1)!.channels).toEqual(['user.U1', 'system.status', 'jobs.J1']);
    // A channel the server refuses (403 for the whole request, §10.7): this tab's own channels at once.
    a.answer = (p) => {
      if (p.channels.includes('jobs.J1')) throw Object.assign(new Error('denied'), { status: 403 });
      return { cursor: '1.1', events: [] };
    };
    await advance(2_500);
    expect(a.polls.slice(-2).map((p) => [p.at, p.channels])).toEqual([
      [2_500, ['user.U1', 'system.status', 'jobs.J1']],
      [2_500, ['user.U1', 'system.status']],
    ]);
    await advance(60_000);
    expect(a.polls.at(-1)!.channels).toEqual(['user.U1', 'system.status']);
    // A follower that stops takes its channels along.
    a.answer = (p) => ({ cursor: `1.${p.at}`, events: [] });
    await advance(5 * 60_000);
    expect(a.polls.at(-1)!.channels).toEqual(['user.U1', 'system.status', 'jobs.J1']);
    b.rt.stop();
    await advance(20_000);
    expect(a.polls.at(-1)!.channels).toEqual(['user.U1', 'system.status']);
  });

  it("a stream refused while it read a follower's channels: one poll says why; a 403 leaves them out and SSE goes on", async () => {
    const locks = new FakeLocks();
    const bus = new FakeBus();
    const a = tab({ locks, bus, scope: 'U1', transport: 'sse', channels: ['user.U1'] });
    const b = tab({ locks, bus, scope: 'U1', channels: ['jobs.J1'] });
    a.rt.start();
    await flush();
    b.rt.start();
    await flush();
    expect(a.streams.at(-1)!.query().get('channels')).toBe('user.U1,jobs.J1');
    // The user lost the right to the follower's job: every request with jobs.J1 is refused (403 for the whole request).
    a.answer = (p) => {
      if (p.channels.includes('jobs.J1')) throw Object.assign(new Error('denied'), { status: 403 });
      return { cursor: '1.1', events: [] };
    };
    a.streams.at(-1)!.fail(true); // an EventSource does not tell a 403 from a 204 or a 409
    await flush();
    await flush();
    // The poll said 403: the follower's channels are left out, and the stream opens again at once with this tab's own.
    expect(a.polls.map((p) => p.channels)).toEqual([['user.U1', 'jobs.J1']]);
    const own = a.streams.at(-1)!;
    expect([own.closed, own.query().get('channels')]).toEqual([false, 'user.U1']);
    // The refusal was no SSE failure: one failure of this stream opens it again after 1 s, SSE does not back off.
    own.fail(true);
    await advance(1_000);
    expect([a.streams.at(-1)!.closed, a.streams.at(-1)!.query().get('channels')]).toEqual([false, 'user.U1']);
    expect(a.polls).toHaveLength(1);
  });

  it('a stream refused while it read a follower\'s channels, whose poll passes, counts as an SSE failure', async () => {
    const locks = new FakeLocks();
    const bus = new FakeBus();
    const a = tab({ locks, bus, scope: 'U1', transport: 'sse', channels: ['user.U1'] });
    const b = tab({ locks, bus, scope: 'U1', channels: ['jobs.J1'] });
    a.rt.start();
    await flush();
    b.rt.start();
    await flush();
    a.answer = () => ({ cursor: '1.9', events: [ev(9, { channel: 'jobs.J1' })] });
    // Over the stream limit (204): the poll passes and delivers, so the refusal was the stream's own.
    a.streams.at(-1)!.fail(true);
    await flush();
    await flush();
    expect(a.polls.map((p) => p.channels)).toEqual([['user.U1', 'jobs.J1']]);
    expect(seqs(a)).toEqual([9]);
    await advance(1_000);
    a.streams.at(-1)!.fail(true);
    await flush();
    await flush();
    // The second failure within 60 s: SSE backs off, polling with both tabs' channels.
    expect(a.streams.at(-1)!.closed).toBe(true);
    expect(a.polls.at(-1)!.channels).toEqual(['user.U1', 'jobs.J1']);
  });

  it('a stream of the leader opens again with the channels a follower adds', async () => {
    const locks = new FakeLocks();
    const bus = new FakeBus();
    const a = tab({ locks, bus, transport: 'sse', channels: ['system.status'] });
    const b = tab({ locks, bus, channels: ['jobs.J2'] });
    a.rt.start();
    await flush();
    expect(a.streams).toHaveLength(1);
    b.rt.start();
    await flush();
    expect(a.streams[0]!.closed).toBe(true);
    expect(a.streams).toHaveLength(2);
    expect(a.streams[1]!.query().get('channels')).toBe('system.status,jobs.J2');
  });
});

describe('createRealtime: the cursor of a new leadership', () => {
  it('a tab hidden for an hour polls without a cursor when it becomes visible, and resyncs once', async () => {
    const a = tab();
    a.rt.start();
    await advance(2_500);
    expect(a.polls.map((p) => p.cursor)).toEqual([null, '1.0']);
    a.doc.setHidden(true);
    await advance(3_600_000);
    a.doc.setHidden(false);
    await flush();
    // Its old cursor would replay an hour of events (up to 500 a page) for nothing: the screens read their data again.
    expect(a.polls.at(-1)).toEqual({ at: 3_602_500, cursor: null, channels: ['system.status'] });
    expect(a.resyncs).toBe(1);
    await advance(2_500);
    expect(a.polls.at(-1)!.cursor).toBe('1.3602500');
    expect(a.resyncs).toBe(1);
  });

  it('a tab hidden for less than 30 s carries on from its cursor', async () => {
    const a = tab();
    a.rt.start();
    await advance(2_500);
    a.doc.setHidden(true);
    await advance(20_000);
    a.doc.setHidden(false);
    await flush();
    expect(a.polls.at(-1)).toEqual({ at: 22_500, cursor: '1.2500', channels: ['system.status'] });
    expect(a.resyncs).toBe(0);
  });

  it('a follower taking over from a live polling leader carries on from its cursor, however quiet the channels were', async () => {
    const locks = new FakeLocks();
    const bus = new FakeBus();
    const a = tab({ locks, bus });
    const b = tab({ locks, bus });
    a.answer = () => ({ cursor: '1.7', events: [] });
    a.rt.start();
    await flush();
    b.rt.start();
    await advance(10 * 60_000 + 15_000);
    a.doc.setHidden(true);
    await flush();
    expect(b.polls).toEqual([{ at: 615_000, cursor: '1.7', channels: ['system.status'] }]);
    expect(b.resyncs).toBe(0);
  });

  it('a follower taking over from a live SSE leader carries on from its cursor, however quiet the stream was', async () => {
    const locks = new FakeLocks();
    const bus = new FakeBus();
    const a = tab({ locks, bus, transport: 'sse' });
    const b = tab({ locks, bus });
    a.rt.start();
    await flush();
    b.rt.start();
    a.streams[0]!.open();
    a.streams[0]!.emit('notification', '1.3', { channel: 'system.status', payload: {}, at: T0 });
    await advance(10 * 60_000 + 5_000);
    a.doc.setHidden(true);
    await flush();
    expect(b.polls).toEqual([{ at: 605_000, cursor: '1.3', channels: ['system.status'] }]);
    expect(b.resyncs).toBe(0);
    expect(seqs(b)).toEqual([3]);
  });

  it('a follower taking over after an hour without a leader (every tab hidden) starts without a cursor and resyncs once', async () => {
    const locks = new FakeLocks();
    const bus = new FakeBus();
    const a = tab({ locks, bus });
    const b = tab({ locks, bus });
    a.rt.start();
    await flush();
    b.rt.start();
    await advance(2_500);
    a.doc.setHidden(true);
    b.doc.setHidden(true);
    await advance(3_600_000);
    expect(b.polls).toEqual([]);
    b.doc.setHidden(false);
    await flush();
    expect(b.polls).toEqual([{ at: 3_602_500, cursor: null, channels: ['system.status'] }]);
    expect(b.resyncs).toBe(1);
    expect(a.resyncs).toBe(0);
  });
});

describe('createRealtime: hints of the transport and of the user', () => {
  it('SSE refused twice within a minute (it may have been turned off: 409) says so once, as the back-off starts', async () => {
    const stale = vi.fn();
    const streams: FakeEventSource[] = [];
    const rt = createRealtime({
      channels: () => ['system.status'],
      transport: () => 'sse',
      poll: async () => ({ cursor: '1.1', events: [] }),
      openStream: (url) => {
        const es = new FakeEventSource(url);
        streams.push(es);
        return es as unknown as EventSource;
      },
      onEvents: () => {},
      onResync: () => {},
      onTransportStale: stale,
      doc: new FakeDoc() as unknown as Document,
      locks: null,
      channel: null,
    });
    rt.start();
    await flush();
    streams[0]!.fail(true);
    await advance(1_000);
    expect(stale).not.toHaveBeenCalled();
    streams[1]!.fail(true);
    await flush();
    expect(stale).toHaveBeenCalledTimes(1);
    await advance(60_000);
    expect(stale).toHaveBeenCalledTimes(1);
    rt.stop();
  });

  it("the leader reads only the channels other tabs announced for the user signed in now", async () => {
    const locks = new FakeLocks();
    const bus = new FakeBus();
    const who = { id: 'U1' };
    const a = tab({ locks, bus, scope: () => who.id, channels: ['user.U1', 'system.status'] });
    const b = tab({ locks, bus, scope: 'U1', channels: ['system.status', 'jobs.J1'] });
    a.rt.start();
    await flush();
    b.rt.start();
    await flush();
    expect(a.polls.at(-1)!.channels).toEqual(['user.U1', 'system.status', 'jobs.J1']);
    // Another user signs in on this browser: the other tab's channels of the first user are not read meanwhile.
    who.id = 'U2';
    a.channels = ['user.U2', 'system.status'];
    a.rt.update();
    await advance(2_500);
    expect(a.polls.at(-1)!.channels).toEqual(['user.U2', 'system.status']);
  });
});

describe('invalidateRealtimeKeys', () => {
  function counted(client: QueryClient, key: QueryKey, fetches: { n: number }, ms = 0): () => void {
    const observer = new QueryObserver(client, {
      queryKey: key,
      queryFn: () => {
        fetches.n += 1;
        return new Promise<number>((resolve) => setTimeout(() => resolve(fetches.n), ms));
      },
      staleTime: Infinity,
    });
    return observer.subscribe(() => {});
  }

  it('refetches each key of a batch once, and never cancels a fetch under way to start another', async () => {
    const client = new QueryClient({ defaultOptions: { queries: { retry: false } } });
    const count = { n: 0 };
    const jobs = { n: 0 };
    const offCount = counted(client, ['notifications', 'count'], count, 1_000);
    const offJobs = counted(client, ['jobs', 'J1'], jobs);
    await advance(1_000);
    expect([count.n, jobs.n]).toEqual([1, 1]);
    const batch = [1, 2, 3, 4, 5].map((seq) => ev(seq, { channel: seq === 5 ? 'jobs.J1' : 'user.U1', type: seq === 5 ? 'job.progress' : 'notification' }));
    const invalidate = vi.spyOn(client, 'invalidateQueries');
    invalidateRealtimeKeys(client, batch.flatMap(realtimeQueryKeys), false);
    expect(invalidate.mock.calls.map(([filters]) => filters?.queryKey)).toEqual([['notifications'], ['jobs', 'J1']]);
    await advance(100);
    expect([count.n, jobs.n]).toEqual([2, 2]);
    // A second batch while the count is still being fetched joins that fetch.
    invalidateRealtimeKeys(client, [['notifications']], false);
    await advance(1_000);
    expect(count.n).toBe(2);
    offCount();
    offJobs();
    client.clear();
  });

  it('the fetches it starts go out in the background (X-Altis-Background: 1); a fetch started elsewhere does not', async () => {
    const fetchMock = vi.fn<typeof fetch>(async () => new Response('{"n":1}', { status: 200, headers: { 'Content-Type': 'application/json' } }));
    vi.stubGlobal('fetch', fetchMock);
    try {
      const client = new QueryClient({ defaultOptions: { queries: { retry: false } } });
      const observer = new QueryObserver(client, { queryKey: ['jobs', 'J1'], queryFn: () => api('GET', 'jobs/J1'), staleTime: Infinity });
      const off = observer.subscribe(() => {});
      await flush();
      invalidateRealtimeKeys(client, [['jobs', 'J1']], false);
      await flush();
      await observer.refetch();
      const background = fetchMock.mock.calls.map(([, init]) => (init?.headers as Record<string, string>)['X-Altis-Background'] === '1');
      expect(background).toEqual([false, true, false]);
      off();
      client.clear();
    } finally {
      vi.unstubAllGlobals();
    }
  });

  it('while the tab is hidden, only marks the queries stale (refetched when it is shown)', async () => {
    const client = new QueryClient({ defaultOptions: { queries: { retry: false } } });
    const count = { n: 0 };
    const off = counted(client, ['notifications', 'count'], count);
    await advance(0);
    expect(count.n).toBe(1);
    invalidateRealtimeKeys(client, [['notifications']], true);
    await advance(1_000);
    expect(count.n).toBe(1);
    expect(client.getQueryState(['notifications', 'count'])?.isInvalidated).toBe(true);
    off();
    client.clear();
  });
});

describe('useRealtime', () => {
  it("adds a screen's channels to the tab's client and hands it the events of those channels", async () => {
    const polls: string[][] = [];
    const all: EventItem[] = [];
    const answers: EventsResponse[] = [
      { cursor: '1.1', events: [] },
      { cursor: '1.3', events: [ev(2, { channel: 'jobs.J1', type: 'job.progress' }), ev(3)] },
    ];
    const hub = createRealtimeHub({
      transport: () => 'polling',
      scope: () => 'U1',
      onEvents: (events) => all.push(...events),
      onResync: () => {},
      poll: async (_cursor, channels) => {
        polls.push(channels);
        return answers.shift() ?? { cursor: '1.3', events: [] };
      },
      openStream: () => {
        throw new Error('no stream');
      },
      locks: null,
      channel: null,
    });
    const unsubscribe = hub.subscribe(['system.status'], () => {});
    const seen: EventItem[] = [];
    function JobScreen() {
      useRealtime(['jobs.J1'], (e) => seen.push(e));
      return null;
    }
    const view = render(
      <RealtimeContext.Provider value={hub}>
        <JobScreen />
      </RealtimeContext.Provider>,
    );
    await act(async () => {
      hub.start();
      await flush();
    });
    expect(polls).toEqual([['system.status', 'jobs.J1']]);
    await act(() => advance(2_500));
    expect(seen.map((e) => e.seq)).toEqual([2]);
    expect(all.map((e) => e.seq)).toEqual([2, 3]);
    // A key pressed after a minute and a half without input: polled at once (the hub listens for input).
    await act(() => advance(100_000));
    const before = polls.length;
    await act(async () => {
      document.dispatchEvent(new KeyboardEvent('keydown', { bubbles: true }));
      await flush();
    });
    expect(polls).toHaveLength(before + 1);
    // The screen leaves: its channel goes with it.
    view.unmount();
    await act(() => advance(2_500));
    expect(polls.at(-1)).toEqual(['system.status']);
    hub.stop();
    unsubscribe();
    expect(vi.getTimerCount()).toBe(0);
  });
});

describe('realtimeQueryKeys', () => {
  it('names the queries an event makes stale', () => {
    expect(realtimeQueryKeys(ev(1, { channel: 'user.U1', type: 'notification' }))).toEqual([['notifications']]);
    expect(realtimeQueryKeys(ev(1, { channel: 'system.status', type: 'notification' }))).toEqual([['notifications']]);
    expect(realtimeQueryKeys(ev(1, { channel: 'jobs.J1', type: 'job.progress' }))).toEqual([['jobs', 'J1']]);
    expect(realtimeQueryKeys(ev(1, { channel: 'jobs.J1', type: 'job.finished' }))).toEqual([['jobs', 'J1'], ['dashboard']]);
    expect(realtimeQueryKeys(ev(1, { channel: 'system.backup', type: 'op.progress' }))).toEqual([['ops'], ['backups']]);
    expect(realtimeQueryKeys(ev(1, { channel: 'system.backup', type: 'backup.progress' }))).toEqual([['backups']]);
    expect(realtimeQueryKeys(ev(1, { channel: 'system.update', type: 'op.progress' }))).toEqual([['ops']]);
    expect(realtimeQueryKeys(ev(1, { channel: 'system.backup', type: 'backup.done' }))).toEqual([['backups'], ['dashboard']]);
    expect(realtimeQueryKeys(ev(1, { channel: 'system.status', type: 'clock.anomaly' }))).toEqual([['dashboard']]);
  });
});
