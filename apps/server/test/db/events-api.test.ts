import fsp from 'node:fs/promises';
import os from 'node:os';
import path from 'node:path';
import { bumpDataEpoch, createSettingsCache, publish, readDataEpoch, revokeSession, sha256hex, writeSettings } from '@altis/core';
import { PHASE1_MIGRATIONS, runMigrations, withTx } from '@altis/db';
import type { Runtime } from '@altis/platform';
import { newId } from '@altis/shared';
import type { EventsResponse } from '@altis/shared/api/events';
import { afterAll, afterEach, beforeAll, beforeEach, describe, expect, it, vi } from 'vitest';
import { engineLabel, testDb, testDbContext, type TestDbHandle } from '../../../../tools/test/test-db.js';
import { createApp } from '../../src/app.js';
import { SSE_AUTH_MS, SSE_MAX_MS, SSE_READ_MS, createStreamCounter, sseEnabled, type StreamCounter } from '../../src/realtime/streams.js';
import { createAgent, type AgentReply } from '../agent.js';
import { recordingLogger, sampleConfig } from '../support.js';
import { seedStaff, sessionCookieFor } from '../support-auth.js';

// The events API of Task 8 (spec §10.6-10.8; route catalog `events.poll`, `events.stream`) on the engine picked by
// ALTIS_TEST_DB:
// - polling: `GET events?channels=…[&cursor=…]` authorizes every channel (403 for the whole request, M19 over HTTP),
//   then reads the settled events after the cursor of this data epoch; the first cursor is "now"; another epoch → 410;
//   a `background` route, so the session is never touched;
// - SSE: `GET events/stream` is off on passenger/litespeed while `realtime.sse` is null (409), takes one of the
//   process's four stream slots (204 above them), writes `retry: 1000`, then the events as `id`/`event`/`data`, checks
//   the session, the user, the rights, the channels and the epoch every 5 s, and ends by itself within 25 s.
//
// The SSE cases run on fake `setTimeout`/`clearTimeout`/`performance` (the stream's only clocks); the test itself
// waits on the real `setTimeout` saved below, and reads the stream as a browser would, all the time.

const ctx = testDbContext();
let h: TestDbHandle;

/** In the past: rows dated ahead of the real clock are never written. */
const NOW = Date.UTC(2026, 9, 27, 8, 0, 0);
const CONFIG = sampleConfig();
/** baseUrl is https: the cookies carry the `__Host-` prefix. */
const SID = '__Host-altis_sid';
const EVENTS = '/api/v1/events';
const STREAM = `${EVENTS}/stream`;
const PEER = { incoming: { socket: { remoteAddress: '203.0.113.10' } } };

const realSetTimeout = globalThis.setTimeout;
const realDelay = (ms: number): Promise<void> => new Promise((resolve) => realSetTimeout(resolve, ms));

const code = (res: AgentReply): string | undefined => (res.json as { code?: string } | undefined)?.code;

/** A stream as a browser reads it: everything that arrived so far, and whether it ended. */
interface OpenStream {
  status: number;
  headers: Headers;
  text(): string;
  ended(): boolean;
  /** The browser goes away (the tab closes). */
  cancel(): Promise<void>;
}

describe('sseEnabled', () => {
  it('the setting when set; when null, on except under passenger and litespeed', () => {
    for (const runtime of ['passenger', 'litespeed', 'pm2', 'docker', 'service', 'standalone'] as const) {
      expect(sseEnabled(true, runtime), runtime).toBe(true);
      expect(sseEnabled(false, runtime), runtime).toBe(false);
      expect(sseEnabled(null, runtime), runtime).toBe(runtime !== 'passenger' && runtime !== 'litespeed');
    }
  });
});

describe('createStreamCounter', () => {
  it('hands out at most `max` slots (default 4); a release frees one', () => {
    const streams = createStreamCounter();
    expect([1, 2, 3, 4, 5].map(() => streams.tryAcquire())).toEqual([true, true, true, true, false]);
    expect(streams.count()).toBe(4);
    streams.release();
    expect(streams.count()).toBe(3);
    expect(streams.tryAcquire()).toBe(true);
    expect(createStreamCounter(1).tryAcquire()).toBe(true);
  });
});

describe.skipIf(!ctx.available)(`events API [${engineLabel()}]`, () => {
  let dataDir: string;
  let now = NOW;
  const clock = (): number => now;
  /** No role: reads `system.status` and its own `user.<id>`. */
  let plain: { id: string; token: string };
  /** Holds `system.update.read`. */
  let updater: { id: string; token: string };
  let streams: StreamCounter;
  let log = recordingLogger();
  const apps = new Map<Runtime, ReturnType<typeof createApp>>();
  const open: OpenStream[] = [];

  /** The app of `runtime`; every one shares the stream counter and reads settings afresh (no cache). */
  function appFor(runtime: Runtime = 'pm2'): ReturnType<typeof createApp> {
    let app = apps.get(runtime);
    if (app === undefined) {
      app = createApp({
        state: { phase: 'ready', db: h, config: CONFIG },
        version: '0.1.0',
        buildId: 'b',
        log,
        clock,
        dataDir,
        runtime,
        services: { settings: createSettingsCache({ ttlMs: 0 }), streams },
      });
      apps.set(runtime, app);
    }
    return app;
  }

  const epoch = (): Promise<number> => readDataEpoch(dataDir);
  const maxSeq = async (): Promise<number> => {
    const row = await h.db.selectFrom('events').select((eb) => eb.fn.max('seq').as('top')).executeTakeFirst();
    return Number(row?.top ?? 0);
  };
  /** One event on `channel`, created at `at` (default now); its seq. */
  async function send(channel: string, type: string, payload: Record<string, unknown> = {}, at = now): Promise<number> {
    await withTx(h, (trx) => publish(trx, { channel, type, payload }, () => at));
    return maxSeq();
  }
  async function setSse(value: boolean | null): Promise<void> {
    await withTx(h, (trx) => writeSettings(trx, { 'realtime.sse': value }, { keyring: CONFIG.keyring, now: NOW, actorId: null }));
  }

  async function signedIn(username: string, permissions: Parameters<typeof seedStaff>[1]['roles']): Promise<{ id: string; token: string }> {
    const user = await seedStaff(h, { username, now: NOW, ...(permissions === undefined ? {} : { roles: permissions }) });
    return { id: user.id, token: await sessionCookieFor(h, user.id, { now: NOW }) };
  }

  function agentOf(token: string, runtime?: Runtime) {
    const agent = createAgent(appFor(runtime));
    agent.setCookie(SID, token);
    return agent;
  }
  const poll = (token: string, query: string): Promise<AgentReply> => agentOf(token).get(`${EVENTS}?${query}`);

  /** Opens `GET events/stream?query` and reads it continuously. */
  async function stream(
    token: string,
    query: string,
    o: { runtime?: Runtime; headers?: Record<string, string>; app?: ReturnType<typeof createApp> } = {},
  ): Promise<OpenStream> {
    const res = await (o.app ?? appFor(o.runtime)).request(
      `${STREAM}?${query}`,
      { headers: { cookie: `${SID}=${token}`, accept: 'text/event-stream', ...o.headers } },
      PEER,
    );
    const reader = res.body?.getReader();
    let text = '';
    let ended = reader === undefined;
    if (reader !== undefined) {
      const decoder = new TextDecoder();
      void (async () => {
        try {
          for (;;) {
            const { done, value } = await reader.read();
            if (done) break;
            text += decoder.decode(value, { stream: true });
          }
        } catch {
          // cancelled
        }
        ended = true;
      })();
    }
    const s: OpenStream = {
      status: res.status,
      headers: res.headers,
      text: () => text,
      ended: () => ended,
      cancel: async () => {
        if (!ended) await reader?.cancel().catch(() => {});
      },
    };
    open.push(s);
    return s;
  }

  /** Lets due fake timers fire and the server's I/O finish, without moving the fake clock. */
  async function settle(): Promise<void> {
    for (let i = 0; i < 4; i += 1) {
      await vi.advanceTimersByTimeAsync(0);
      await realDelay(5);
    }
  }
  /** Moves the fake clock by `ms` in steps of one read interval, settling after each. */
  async function advance(ms: number): Promise<void> {
    for (let t = 0; t < ms; t += SSE_READ_MS) {
      await vi.advanceTimersByTimeAsync(Math.min(SSE_READ_MS, ms - t));
      await settle();
    }
  }
  /** Waits (real time, at most 5 s) until `cond` holds, firing due fake timers meanwhile. */
  async function until(cond: () => boolean, what: string): Promise<void> {
    const end = Date.now() + 5000;
    while (!cond()) {
      if (Date.now() > end) throw new Error(`timed out waiting for ${what}`);
      await vi.advanceTimersByTimeAsync(0);
      await realDelay(5);
    }
  }

  beforeAll(async () => {
    h = await testDb();
    dataDir = await fsp.mkdtemp(path.join(os.tmpdir(), 'altis-events-'));
    await runMigrations(h, { appVersion: '0.1.0', dataDir, migrations: PHASE1_MIGRATIONS });
    plain = await signedIn('staf_biasa', []);
    updater = await signedIn('pembaru', [{ permissions: ['system.update.read'] }]);
  });

  afterAll(async () => {
    await h?.close();
    if (dataDir !== undefined) await fsp.rm(dataDir, { recursive: true, force: true });
  });

  beforeEach(async () => {
    now = NOW;
    streams = createStreamCounter();
    log = recordingLogger();
    apps.clear();
    await h.db.deleteFrom('events').execute();
    await setSse(null);
  });

  describe('GET events (polling)', () => {
    it('without a cursor: no events and a cursor at the highest seq of this data epoch; not cached', async () => {
      await send('system.status', 'clock.anomaly', {}, now - 10_000);
      const res = await poll(plain.token, 'channels=system.status');
      expect(res.status, res.text).toBe(200);
      expect(res.headers.get('cache-control')).toBe('no-store');
      expect(res.json).toEqual({ cursor: `${await epoch()}.${await maxSeq()}`, events: [] } satisfies EventsResponse);
    });

    it('two events published, then 2 s later: both returned in seq order, the cursor at the second', async () => {
      const first = (await poll(plain.token, 'channels=system.status')).json as EventsResponse;
      const a = await send('system.status', 'clock.anomaly', { n: 1 });
      const b = await send('system.status', 'clock.anomaly', { n: 2 });
      await send(`user.${updater.id}`, 'notification', {}); // another channel
      const unsettled = (await poll(plain.token, `channels=system.status&cursor=${first.cursor}`)).json as EventsResponse;
      expect(unsettled).toEqual({ cursor: first.cursor, events: [] });
      now += 2000;
      const res = await poll(plain.token, `channels=system.status&cursor=${first.cursor}`);
      expect(res.status, res.text).toBe(200);
      const e = await epoch();
      expect(res.json).toEqual({
        cursor: `${e}.${b}`,
        events: [
          { seq: a, channel: 'system.status', type: 'clock.anomaly', payload: { n: 1 }, at: NOW },
          { seq: b, channel: 'system.status', type: 'clock.anomaly', payload: { n: 2 }, at: NOW },
        ],
      } satisfies EventsResponse);
    });

    it('system.update without system.update.read → 403 AUTHZ_DENIED (M19 over HTTP); with it → 200', async () => {
      const denied = await poll(plain.token, 'channels=system.update');
      expect(denied.status).toBe(403);
      expect(code(denied)).toBe('AUTHZ_DENIED');
      const allowed = await poll(updater.token, 'channels=system.update,system.status');
      expect(allowed.status, allowed.text).toBe(200);
    });

    it('Phase 2: catalog without catalog.records.read → 403 AUTHZ_DENIED; with it → 200', async () => {
      const denied = await poll(plain.token, 'channels=catalog');
      expect({ status: denied.status, code: code(denied) }).toEqual({ status: 403, code: 'AUTHZ_DENIED' });
      const reader = await signedIn('pembaca_katalog', [{ permissions: ['catalog.records.read'] }]);
      const allowed = await poll(reader.token, 'channels=catalog,system.status');
      expect(allowed.status, allowed.text).toBe(200);
    });

    it('an unknown or forbidden channel among allowed ones → 403 for the whole request', async () => {
      for (const channels of ['system.status,bogus', `system.status,user.${updater.id}`, 'system.status,system.backup', `jobs.${newId()}`]) {
        const res = await poll(plain.token, `channels=${channels}`);
        expect(res.status, channels).toBe(403);
        expect(code(res), channels).toBe('AUTHZ_DENIED');
      }
      expect((await poll(plain.token, `channels=user.${plain.id},system.status`)).status).toBe(200);
    });

    it('a cursor of another data epoch → 410 EVENTS_CURSOR_EXPIRED; so is every cursor once the epoch was raised', async () => {
      const before = (await poll(plain.token, 'channels=system.status')).json as EventsResponse;
      const other = await poll(plain.token, `channels=system.status&cursor=${(await epoch()) + 5}.0`);
      expect(other.status).toBe(410);
      expect(code(other)).toBe('EVENTS_CURSOR_EXPIRED');
      const raised = await bumpDataEpoch(dataDir); // what a restore does
      const old = await poll(plain.token, `channels=system.status&cursor=${before.cursor}`);
      expect(old.status).toBe(410);
      expect(code(old)).toBe('EVENTS_CURSOR_EXPIRED');
      const fresh = (await poll(plain.token, 'channels=system.status')).json as EventsResponse;
      expect(fresh.cursor).toBe(`${raised}.${await maxSeq()}`);
      expect((await poll(plain.token, `channels=system.status&cursor=${fresh.cursor}`)).status).toBe(200);
    });

    it('a malformed query → 422 VALIDATION_FAILED', async () => {
      const many = Array.from({ length: 21 }, () => 'system.status').join(',');
      for (const query of ['', 'channels=', `channels=${many}`, `channels=system.status&cursor=${'1'.repeat(41)}`, 'channels=system.status&page=2']) {
        const res = await poll(plain.token, query);
        expect(res.status, query).toBe(422);
        expect(code(res), query).toBe('VALIDATION_FAILED');
      }
      expect((await poll(plain.token, `channels=${Array.from({ length: 20 }, () => 'system.status').join(',')}`)).status).toBe(200);
    });

    it('anonymous → 401 AUTH_REQUIRED', async () => {
      const res = await createAgent(appFor()).get(`${EVENTS}?channels=system.status`);
      expect(res.status).toBe(401);
      expect(code(res)).toBe('AUTH_REQUIRED');
    });

    it("leaves the session untouched (background): last_seen_at is unchanged, where a foreground request moves it", async () => {
      const user = await seedStaff(h, { username: 'penyimak', now: NOW });
      const token = await sessionCookieFor(h, user.id, { now: NOW - 5 * 60_000 });
      const lastSeen = async (): Promise<number> =>
        Number((await h.db.selectFrom('sessions').select('last_seen_at').where('id', '=', sha256hex(token)).executeTakeFirstOrThrow()).last_seen_at);
      expect(await lastSeen()).toBe(NOW - 5 * 60_000);
      expect((await poll(token, 'channels=system.status')).status).toBe(200);
      expect(await lastSeen()).toBe(NOW - 5 * 60_000);
      // The control: an ordinary page request of the same session is a touch.
      expect((await agentOf(token).get('/api/v1/notifications')).status).toBe(200);
      expect(await lastSeen()).toBe(NOW);
    });
  });

  describe('GET events/stream (SSE)', () => {
    beforeEach(() => {
      vi.useFakeTimers({ toFake: ['setTimeout', 'clearTimeout', 'performance'] });
    });

    afterEach(async () => {
      try {
        for (const s of open.splice(0)) await s.cancel();
        await until(() => streams.count() === 0, 'every stream to end');
      } finally {
        vi.useRealTimers();
      }
      // Every stream ended by its own rules, none by an error.
      expect(log.lines.filter((l) => l.level === 'warn' || l.level === 'error')).toEqual([]);
    });

    it('sends retry: 1000, then a settled event published before it as id <epoch>.<seq> / event / data', async () => {
      await setSse(true);
      const start = (await poll(plain.token, 'channels=system.status')).json as EventsResponse;
      const seq = await send('system.status', 'clock.anomaly', { n: 7 }, now - 2500);
      const s = await stream(plain.token, `channels=system.status&cursor=${start.cursor}`);
      expect(s.status).toBe(200);
      expect(s.headers.get('content-type')).toMatch(/^text\/event-stream/);
      expect(s.headers.get('cache-control')).toBe('no-store');
      expect(s.headers.get('x-accel-buffering')).toBe('no');
      const message = `id: ${await epoch()}.${seq}\nevent: clock.anomaly\ndata: ${JSON.stringify({ channel: 'system.status', payload: { n: 7 }, at: now - 2500 })}\n\n`;
      await until(() => s.text().includes(message), 'the event');
      expect(s.text().startsWith('retry: 1000\n\n')).toBe(true);
      expect(streams.count()).toBe(1);
    });

    it('never sends a stored event under a control name or outside EVENT_TYPES (a row written past publish): skipped, the cursor still moves', async () => {
      await setSse(true);
      const start = (await poll(plain.token, 'channels=system.status')).json as EventsResponse;
      const at = now - 2500;
      const stored = (type: string) =>
        h.db.insertInto('events').values({ channel: 'system.status', type, payload: '{}', created_at: at }).execute();
      await stored('expired');
      const seq = await send('system.status', 'clock.anomaly', { n: 1 }, at);
      for (const type of ['error', 'message', 'open', 'status.changed']) await stored(type);
      const last = await maxSeq();
      const e = await epoch();
      const s = await stream(plain.token, `channels=system.status&cursor=${start.cursor}`);
      await until(() => s.text().includes(`id: ${e}.${last}\n`), 'the cursor past the last row');
      expect(s.text()).not.toMatch(/^event: (expired|error|message|open|status\.changed)$/m);
      expect(s.text()).toContain(`id: ${e}.${seq}\nevent: clock.anomaly\n`);
      // The cursor moves past the skipped rows as an `id` alone (no event carries it).
      expect(s.text()).toContain(`id: ${e}.${last}\n\n`);
      expect(s.ended()).toBe(false);
    });

    it('ends by itself after 25 s (fake timers), sending a heartbeat every 5 s, and frees its slot', async () => {
      const s = await stream(plain.token, 'channels=system.status');
      await until(() => s.text().startsWith('retry: 1000\n\n'), 'the stream to start');
      await advance(SSE_MAX_MS - SSE_READ_MS);
      expect(s.ended()).toBe(false);
      expect(s.text().split(': hb\n\n').length - 1).toBe(Math.floor((SSE_MAX_MS - SSE_READ_MS) / SSE_AUTH_MS));
      await advance(SSE_READ_MS);
      await until(() => s.ended(), 'the stream to end');
      await until(() => streams.count() === 0, 'the slot to be freed');
    });

    it('ends at 25 s also while a read waits on the database, and frees its slot then, not when the read returns', async () => {
      // The app's database answers nothing while `hold` is set (a pool without a free connection, a table locked by a
      // restore step): the stream's next read waits past the 25 s limit.
      let hold: Promise<void> | null = null;
      let letGo = (): void => {};
      const plugin: Parameters<TestDbHandle['db']['withPlugin']>[0] = {
        transformQuery: (a) => a.node,
        transformResult: async (a) => {
          if (hold !== null) await hold;
          return a.result;
        },
      };
      const app = createApp({
        state: { phase: 'ready', db: { ...h, db: h.db.withPlugin(plugin) }, config: CONFIG },
        version: '0.1.0',
        buildId: 'b',
        log,
        clock,
        dataDir,
        runtime: 'pm2',
        services: { settings: createSettingsCache({ ttlMs: 0 }), streams },
      });
      const s = await stream(plain.token, 'channels=system.status', { app });
      await until(() => s.text().startsWith('retry: 1000\n\n'), 'the stream to start');
      await advance(SSE_MAX_MS - 2 * SSE_READ_MS);
      hold = new Promise((resolve) => {
        letGo = resolve;
      });
      await advance(SSE_READ_MS); // the next read starts, and waits
      expect(s.ended()).toBe(false);
      await advance(SSE_READ_MS); // 25 s
      try {
        await until(() => s.ended(), 'the stream to end while its read waits');
        await until(() => streams.count() === 0, 'the slot to be freed while its read waits');
      } finally {
        hold = null;
        letGo();
      }
      await settle();
      expect(streams.count()).toBe(0);
    });

    it('a fifth concurrent stream → 204 while four are open; after one closes, a new one is accepted', async () => {
      const four: OpenStream[] = [];
      for (let i = 0; i < 4; i += 1) four.push(await stream(plain.token, 'channels=system.status'));
      for (const s of four) await until(() => s.text().startsWith('retry: 1000'), 'a stream to start');
      expect(four.map((s) => s.status)).toEqual([200, 200, 200, 200]);
      expect(streams.count()).toBe(4);
      const fifth = await stream(plain.token, 'channels=system.status');
      expect(fifth.status).toBe(204);
      expect(fifth.headers.get('content-type')).toBeNull();
      expect(streams.count()).toBe(4);
      await four[0]!.cancel();
      await until(() => streams.count() === 3, 'the closed stream to free its slot');
      const again = await stream(plain.token, 'channels=system.status');
      expect(again.status).toBe(200);
      expect(streams.count()).toBe(4);
    });

    it('revoking the session ends the stream at the next 5 s check, without an expired event', async () => {
      const user = await seedStaff(h, { username: 'dicabut', now: NOW });
      const token = await sessionCookieFor(h, user.id, { now: NOW });
      const s = await stream(token, 'channels=system.status');
      await until(() => s.text().startsWith('retry: 1000\n\n'), 'the stream to start');
      await withTx(h, (trx) => revokeSession(trx, sha256hex(token)));
      await advance(SSE_AUTH_MS - SSE_READ_MS);
      expect(s.ended()).toBe(false);
      await advance(SSE_READ_MS);
      await until(() => s.ended(), 'the stream to end');
      expect(s.text()).not.toContain('event: expired');
      expect(s.text()).not.toContain(': hb');
    });

    it('a data epoch raised mid-stream (a restore) → event: expired at the next 5 s check, then the end', async () => {
      const s = await stream(plain.token, 'channels=system.status');
      await until(() => s.text().startsWith('retry: 1000\n\n'), 'the stream to start');
      await bumpDataEpoch(dataDir);
      await advance(SSE_AUTH_MS);
      await until(() => s.ended(), 'the stream to end');
      expect(s.text()).toContain('event: expired\nid: \ndata: {}\n\n');
    });

    it('an expired cursor → event: expired in the stream (EventSource cannot read a 410), then the end', async () => {
      const s = await stream(plain.token, `channels=system.status&cursor=${(await epoch()) + 3}.0`);
      expect(s.status).toBe(200);
      await until(() => s.ended(), 'the stream to end');
      expect(s.text()).toBe('retry: 1000\n\nevent: expired\nid: \ndata: {}\n\n');
    });

    it('realtime.sse null: 409 REALTIME_SSE_DISABLED on passenger and litespeed, 200 on pm2; the setting wins', async () => {
      for (const runtime of ['passenger', 'litespeed'] as const) {
        const res = await agentOf(plain.token, runtime).get(`${STREAM}?channels=system.status`);
        expect(res.status, runtime).toBe(409);
        expect(code(res), runtime).toBe('REALTIME_SSE_DISABLED');
      }
      expect((await stream(plain.token, 'channels=system.status', { runtime: 'pm2' })).status).toBe(200);
      await setSse(true);
      expect((await stream(plain.token, 'channels=system.status', { runtime: 'passenger' })).status).toBe(200);
      await setSse(false);
      const off = await agentOf(plain.token, 'pm2').get(`${STREAM}?channels=system.status`);
      expect(off.status).toBe(409);
      expect(code(off)).toBe('REALTIME_SSE_DISABLED');
    });

    it('HEAD answers with the stream headers and opens no stream (no slot taken)', async () => {
      const res = await appFor().request(`${STREAM}?channels=system.status`, { method: 'HEAD', headers: { cookie: `${SID}=${plain.token}` } }, PEER);
      expect(res.status).toBe(200);
      expect(res.headers.get('content-type')).toMatch(/^text\/event-stream/);
      expect(await res.text()).toBe('');
      expect(streams.count()).toBe(0);
    });

    it('a channel the user may not read → 403 before any stream, no slot taken', async () => {
      const res = await agentOf(plain.token).get(`${STREAM}?channels=system.status,system.update`);
      expect(res.status).toBe(403);
      expect(code(res)).toBe('AUTHZ_DENIED');
      expect(streams.count()).toBe(0);
    });

    it('a Last-Event-ID header resumes after that seq, and wins over ?cursor', async () => {
      const start = (await poll(plain.token, 'channels=system.status')).json as EventsResponse;
      const seqs: number[] = [];
      for (let n = 1; n <= 3; n += 1) seqs.push(await send('system.status', 'clock.anomaly', { n }, now - 10_000));
      const e = await epoch();
      const s = await stream(plain.token, `channels=system.status&cursor=${start.cursor}`, { headers: { 'last-event-id': `${e}.${seqs[0]!}` } });
      await until(() => s.text().includes(`id: ${e}.${seqs[2]!}\n`), 'the last event');
      expect(s.text()).not.toContain(`id: ${e}.${seqs[0]!}\n`);
      expect(s.text()).toContain(`id: ${e}.${seqs[1]!}\n`);
    });

    it('anonymous → 401 AUTH_REQUIRED', async () => {
      const res = await createAgent(appFor()).get(`${STREAM}?channels=system.status`);
      expect(res.status).toBe(401);
      expect(code(res)).toBe('AUTH_REQUIRED');
    });
  });
});
