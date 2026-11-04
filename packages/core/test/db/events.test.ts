import fsp from 'node:fs/promises';
import os from 'node:os';
import path from 'node:path';
import { PHASE1_MIGRATIONS, runMigrations, withTx, type DB } from '@altis/db';
import { newId } from '@altis/shared';
import { EVENT_TYPES } from '@altis/shared/api/events';
import type { Transaction } from 'kysely';
import { afterAll, beforeAll, beforeEach, describe, expect, it, vi } from 'vitest';
import { engineLabel, testDb, testDbContext, type TestDbHandle } from '../../../../tools/test/test-db.js';
import { runConsumers, type EventConsumer } from '../../src/events/consumers.js';
import { formatCursor } from '../../src/events/cursor.js';
import { EVENT_PAYLOAD_MAX, RESERVED_EVENT_TYPES, createRealtimeTransport, isEventType, publish } from '../../src/events/publish.js';
import { EVENT_OVERLAP_MS, EVENT_PAGE, EVENT_SETTLE_MS, readEvents } from '../../src/events/reader.js';
import { purgeEvents } from '../../src/events/retention.js';

// Events (spec §10.6, decision C5): publish as the last statement of a transaction with `created_at` read right
// before the INSERT (S17), the UI reader (settled reads, a 2 s overlap rescan, 410 EVENTS_CURSOR_EXPIRED, the floor
// of M15) and the durable consumers (30 s hold, cursor advanced with the handler's work). On the engine picked by
// ALTIS_TEST_DB.

const ctx = testDbContext();

const DAY = 86_400_000;
/** A fixed `now`. */
const NOW = 1_800_000_000_000;
/** The data epoch the reader is told. */
const EPOCH = 4;
const JOB = `jobs.${newId()}`;
const OTHER_JOB = `jobs.${newId()}`;
const USER = `user.${newId()}`;

describe.skipIf(!ctx.available)(`events [${engineLabel()}]`, () => {
  let h: TestDbHandle;
  let dataDir: string;

  beforeAll(async () => {
    h = await testDb();
    dataDir = await fsp.mkdtemp(path.join(os.tmpdir(), 'altis-core-events-'));
    await runMigrations(h, { appVersion: '0.1.0', dataDir, migrations: PHASE1_MIGRATIONS });
  });

  afterAll(async () => {
    await h?.close();
    if (dataDir !== undefined) await fsp.rm(dataDir, { recursive: true, force: true });
  });

  beforeEach(async () => {
    // seq keeps counting up across tests (auto-increment): every test works with the seqs it created.
    await h.db.deleteFrom('events').execute();
    await h.db.deleteFrom('event_consumers').execute();
    await h.db.deleteFrom('locks').execute();
    await h.db.deleteFrom('settings').where('key', '=', 'system.events_floor').execute();
  });

  async function maxSeq(): Promise<number> {
    const row = await h.db.selectFrom('events').select((eb) => eb.fn.max('seq').as('m')).executeTakeFirst();
    return Number(row?.m ?? 0);
  }

  /** Publishes one event created at `at` in a transaction of its own; its seq. */
  async function emit(at: number, channel = JOB, payload: Record<string, unknown> = {}): Promise<number> {
    await withTx(h, (trx) => publish(trx, { channel, type: 'job.progress', payload }, () => at));
    return maxSeq();
  }

  /** `n` events created at `at`, inserted in a few statements; their seqs in order. */
  async function bulk(n: number, at: number, channel = JOB): Promise<number[]> {
    const from = await maxSeq();
    for (let done = 0; done < n; done += 200) {
      const rows = Array.from({ length: Math.min(200, n - done) }, (_, i) => ({
        channel,
        type: 'job.progress',
        payload: JSON.stringify({ i: done + i }),
        created_at: at,
      }));
      await h.db.insertInto('events').values(rows).execute();
    }
    const seqs = await h.db.selectFrom('events').select('seq').where('seq', '>', from).orderBy('seq').execute();
    return seqs.map((r) => Number(r.seq));
  }

  const read = (cursor: string | null, o: { channels?: string[]; now?: number; epoch?: number } = {}) =>
    readEvents(h.db, { channels: o.channels ?? [JOB], cursor, now: o.now ?? NOW, epoch: o.epoch ?? EPOCH });

  const seqsOf = (r: { events: { seq: number }[] }): number[] => r.events.map((e) => e.seq);

  describe('publish', () => {
    it('writes one row: the channel, the type, the payload as JSON and the clock reading as created_at', async () => {
      await withTx(h, (trx) => publish(trx, { channel: JOB, type: 'job.progress', payload: { progress: 40 } }, () => NOW));
      const rows = await h.db.selectFrom('events').selectAll().execute();
      expect(rows).toHaveLength(1);
      expect(rows[0]).toMatchObject({ channel: JOB, type: 'job.progress', created_at: NOW });
      expect(JSON.parse(rows[0]!.payload)).toEqual({ progress: 40 });
    });

    it('reads its clock right before the INSERT, not when it is called (S17)', async () => {
      let t = NOW;
      const clock = vi.fn(() => t);
      await withTx(h, async (trx) => {
        // The clock moves on by 5 s between the call and the INSERT (a slow statement before it, a busy event loop):
        // the spy advances it when the INSERT is being built.
        const spy = new Proxy(trx, {
          get(target, prop) {
            const value: unknown = Reflect.get(target, prop, target);
            if (prop === 'insertInto') {
              return (...args: unknown[]) => {
                t += 5000;
                return (value as (...a: unknown[]) => unknown).apply(target, args);
              };
            }
            return typeof value === 'function' ? (value as (...a: unknown[]) => unknown).bind(target) : value;
          },
        }) as Transaction<DB>;
        await publish(spy, { channel: JOB, type: 'job.progress' }, clock);
      });
      const row = await h.db.selectFrom('events').select(['created_at', 'payload']).executeTakeFirstOrThrow();
      expect(row.created_at).toBe(NOW + 5000);
      expect(row.payload).toBe('{}');
      expect(clock).toHaveBeenCalledTimes(1);
    });

    it('defaults its clock to Date.now', async () => {
      const before = Date.now();
      await withTx(h, (trx) => publish(trx, { channel: 'system.status', type: 'clock.anomaly' }));
      const after = Date.now();
      const row = await h.db.selectFrom('events').select('created_at').executeTakeFirstOrThrow();
      expect(row.created_at).toBeGreaterThanOrEqual(before);
      expect(row.created_at).toBeLessThanOrEqual(after);
    });

    it('accepts every registered channel kind', async () => {
      for (const channel of [JOB, USER, 'system.update', 'system.backup', 'system.status']) {
        await withTx(h, (trx) => publish(trx, { channel, type: 'notification' }, () => NOW));
      }
      expect(await h.db.selectFrom('events').select('seq').execute()).toHaveLength(5);
    });

    it('refuses an unknown channel with a TypeError and writes nothing', async () => {
      for (const channel of ['bogus', 'jobs.123', 'user.', 'System.status', `jobs.${newId()}.x`, 42, null]) {
        await expect(
          withTx(h, (trx) => publish(trx, { channel: channel as string, type: 'job.progress' }, () => NOW)),
        ).rejects.toThrow(TypeError);
      }
      expect(await h.db.selectFrom('events').select('seq').execute()).toEqual([]);
    });

    it('refuses a type outside /^[a-z][a-z0-9_.]{0,63}$/', async () => {
      for (const type of ['', 'Job.progress', '1job', '.job', 'job-progress', 'job progress', `a${'b'.repeat(64)}`, 'jöb', 7]) {
        await expect(withTx(h, (trx) => publish(trx, { channel: JOB, type: type as string }, () => NOW))).rejects.toThrow(TypeError);
      }
      expect(await h.db.selectFrom('events').select('seq').execute()).toEqual([]);
    });

    it('accepts every type of EVENT_TYPES and refuses a well-formed one outside it, writing nothing (R1c-8)', async () => {
      for (const type of EVENT_TYPES) await withTx(h, (trx) => publish(trx, { channel: JOB, type }, () => NOW));
      for (const type of [`a${'b'.repeat(63)}`, 'backup.progress_2', 'status.changed']) {
        await expect(withTx(h, (trx) => publish(trx, { channel: JOB, type }, () => NOW))).rejects.toThrow(TypeError);
      }
      const rows = await h.db.selectFrom('events').select('type').orderBy('seq').execute();
      expect(rows.map((r) => r.type)).toEqual([...EVENT_TYPES]);
    });

    it('refuses the control names of an SSE stream (expired, error, message, open) with a TypeError and writes nothing', async () => {
      expect([...RESERVED_EVENT_TYPES].sort()).toEqual(['error', 'expired', 'message', 'open']);
      for (const type of RESERVED_EVENT_TYPES) {
        expect(isEventType(type)).toBe(false);
        await expect(withTx(h, (trx) => publish(trx, { channel: JOB, type }, () => NOW))).rejects.toThrow(TypeError);
      }
      // None is in the registry, and no type of the registry is one.
      for (const type of EVENT_TYPES) expect(isEventType(type)).toBe(true);
      expect(await h.db.selectFrom('events').select('type').execute()).toEqual([]);
    });

    it('refuses a payload over 4096 bytes of JSON, counting UTF-8 bytes', async () => {
      expect(EVENT_PAYLOAD_MAX).toBe(4096);
      // {"s":"…"} is 8 bytes around the text.
      await withTx(h, (trx) => publish(trx, { channel: JOB, type: 'job.progress', payload: { s: 'a'.repeat(4088) } }, () => NOW));
      for (const payload of [{ s: 'a'.repeat(5000) }, { s: 'a'.repeat(4089) }, { s: 'é'.repeat(2045) }]) {
        await expect(withTx(h, (trx) => publish(trx, { channel: JOB, type: 'job.progress', payload }, () => NOW))).rejects.toThrow(TypeError);
      }
      expect(await h.db.selectFrom('events').select('seq').execute()).toHaveLength(1);
    });

    it('refuses a payload that is not a plain JSON object', async () => {
      const cyclic: Record<string, unknown> = {};
      cyclic['self'] = cyclic;
      for (const payload of [null, [], 'text', 3, cyclic, { n: 10n }]) {
        await expect(
          withTx(h, (trx) => publish(trx, { channel: JOB, type: 'job.progress', payload: payload as Record<string, unknown> }, () => NOW)),
        ).rejects.toThrow(TypeError);
      }
      expect(await h.db.selectFrom('events').select('seq').execute()).toEqual([]);
    });

    it('leaves no row when its transaction rolls back', async () => {
      await expect(
        withTx(h, async (trx) => {
          await publish(trx, { channel: JOB, type: 'job.progress' }, () => NOW);
          throw new Error('rolled back');
        }),
      ).rejects.toThrow('rolled back');
      expect(await h.db.selectFrom('events').select('seq').execute()).toEqual([]);
    });
  });

  describe('createRealtimeTransport', () => {
    it('says the kind it is given at every read and publishes in a transaction of its own', async () => {
      let kind: 'polling' | 'sse' = 'polling';
      const transport = createRealtimeTransport(h, () => kind);
      expect(transport.kind).toBe('polling');
      kind = 'sse';
      expect(transport.kind).toBe('sse');

      const before = Date.now();
      await transport.publish('system.status', 'clock.anomaly', { ok: true });
      const rows = await h.db.selectFrom('events').selectAll().execute();
      expect(rows).toHaveLength(1);
      expect(rows[0]).toMatchObject({ channel: 'system.status', type: 'clock.anomaly' });
      expect(JSON.parse(rows[0]!.payload)).toEqual({ ok: true });
      expect(rows[0]!.created_at).toBeGreaterThanOrEqual(before);
    });

    it('refuses what publish refuses, before opening a transaction', async () => {
      const transport = createRealtimeTransport(h, () => 'polling');
      await expect(transport.publish('bogus', 'job.progress', {})).rejects.toThrow(TypeError);
      await expect(transport.publish(JOB, 'X', {})).rejects.toThrow(TypeError);
      await expect(transport.publish(JOB, 'expired', {})).rejects.toThrow(TypeError);
      await expect(transport.publish(JOB, 'status.changed', {})).rejects.toThrow(TypeError);
      await expect(transport.publish(JOB, 'job.progress', { s: 'a'.repeat(5000) })).rejects.toThrow(TypeError);
      expect(await h.db.selectFrom('events').select('seq').execute()).toEqual([]);
    });
  });

  describe('readEvents', () => {
    it('without a cursor returns no events and a cursor at the highest seq ("now")', async () => {
      await emit(NOW - 10_000);
      const top = await emit(NOW - 9000);
      expect(await read(null)).toEqual({ cursor: formatCursor(EPOCH, top), events: [] });
    });

    it('without a cursor on an empty table starts at 0', async () => {
      expect(await read(null)).toEqual({ cursor: formatCursor(EPOCH, 0), events: [] });
    });

    it('returns settled events only: created at most now − 2 s', async () => {
      expect(EVENT_SETTLE_MS).toBe(2000);
      const { cursor } = await read(null);
      const settled = await emit(NOW - 2000, JOB, { n: 1 });
      await emit(NOW - 1999);
      const r = await read(cursor);
      expect(r.events).toEqual([{ seq: settled, channel: JOB, type: 'job.progress', payload: { n: 1 }, at: NOW - 2000 }]);
      expect(r.cursor).toBe(formatCursor(EPOCH, settled));
    });

    it('rescans the last 2 s of settled events below the cursor (overlap), not older ones', async () => {
      expect(EVENT_OVERLAP_MS).toBe(2000);
      const { cursor } = await read(null);
      const old = await emit(NOW - 4001);
      const recent = await emit(NOW - 3000);
      const first = await read(cursor);
      expect(seqsOf(first)).toEqual([old, recent]);
      expect(first.cursor).toBe(formatCursor(EPOCH, recent));

      // seq ≤ cursor: the one created at now − 3000 comes again, the one at now − 4001 does not.
      const again = await read(first.cursor);
      expect(seqsOf(again)).toEqual([recent]);
      expect(again.cursor).toBe(first.cursor);

      // Later, both have left the overlap window.
      expect(await read(first.cursor, { now: NOW + 1001 })).toEqual({ cursor: first.cursor, events: [] });
    });

    it('returns a lower seq that committed late, while it is in the overlap window', async () => {
      const { cursor } = await read(null);
      const late = await emit(NOW - 2500);
      const early = await emit(NOW - 2600);
      // `early` has the higher seq; a reader that saw it moved its cursor past `late`.
      const r = await read(formatCursor(EPOCH, early));
      expect(seqsOf(r)).toEqual([late, early]);
      expect(seqsOf(await read(cursor))).toEqual([late, early]);
    });

    it('returns only the requested channels', async () => {
      const { cursor } = await read(null);
      const a = await emit(NOW - 5000, JOB);
      await emit(NOW - 5000, OTHER_JOB);
      const u = await emit(NOW - 5000, USER);
      await emit(NOW - 5000, 'system.status');
      expect(seqsOf(await read(cursor, { channels: [JOB, USER] }))).toEqual([a, u]);
      const other = await read(cursor, { channels: [OTHER_JOB] });
      expect(other.events.map((e) => e.channel)).toEqual([OTHER_JOB]);
    });

    it('keeps the cursor where it was when nothing new matches', async () => {
      const { cursor } = await read(null);
      await emit(NOW - 5000, OTHER_JOB);
      expect(await read(cursor)).toEqual({ cursor, events: [] });
    });

    it('returns at most 500 events in seq order; the next call returns the rest', async () => {
      expect(EVENT_PAGE).toBe(500);
      const { cursor } = await read(null);
      const seqs = await bulk(600, NOW - 10_000);
      const first = await read(cursor);
      expect(seqsOf(first)).toEqual(seqs.slice(0, 500));
      expect(first.cursor).toBe(formatCursor(EPOCH, seqs[499]!));
      const second = await read(first.cursor);
      expect(seqsOf(second)).toEqual(seqs.slice(500));
      expect(second.cursor).toBe(formatCursor(EPOCH, seqs[599]!));
      expect((await read(second.cursor)).events).toEqual([]);
    });

    it('a full page inside the overlap window still moves on: new events come before re-sent ones', async () => {
      const { cursor } = await read(null);
      const seqs = await bulk(600, NOW - 3000);
      const first = await read(cursor);
      expect(seqsOf(first)).toEqual(seqs.slice(0, 500));
      // 500 already-seen events are in the overlap window: the 100 new ones still come, plus 400 re-sent ones.
      const second = await read(first.cursor);
      expect(second.events).toHaveLength(500);
      expect(seqsOf(second).slice(-100)).toEqual(seqs.slice(500));
      expect(seqsOf(second)).toEqual([...seqsOf(second)].sort((x, y) => x - y));
      expect(second.cursor).toBe(formatCursor(EPOCH, seqs[599]!));
    });

    it('a cursor of another epoch → 410 EVENTS_CURSOR_EXPIRED', async () => {
      const { cursor } = await read(null);
      const top = await emit(NOW - 5000);
      await expect(read(formatCursor(EPOCH + 1, top))).rejects.toMatchObject({ code: 'EVENTS_CURSOR_EXPIRED', status: 410 });
      await expect(read(cursor, { epoch: EPOCH - 1 })).rejects.toMatchObject({ code: 'EVENTS_CURSOR_EXPIRED' });
    });

    it('a seq above the highest one → 410', async () => {
      const top = await emit(NOW - 5000);
      await expect(read(formatCursor(EPOCH, top + 1))).rejects.toMatchObject({ code: 'EVENTS_CURSOR_EXPIRED', status: 410 });
      expect((await read(formatCursor(EPOCH, top))).events).toEqual([]);
    });

    it('a malformed cursor → 410', async () => {
      for (const cursor of ['', 'x', '4', '4.1.2', '-4.1', `${EPOCH}.a`]) {
        await expect(read(cursor), cursor).rejects.toMatchObject({ code: 'EVENTS_CURSOR_EXPIRED' });
      }
    });

    it('after purgeEvents deleted the first 10 events, a cursor below them → 410; one at the last deleted seq reads on', async () => {
      const old = await bulk(10, NOW - 8 * DAY);
      const kept = await bulk(2, NOW - 10_000);
      await purgeEvents(h, NOW);
      expect(Number((await h.db.selectFrom('events').select((eb) => eb.fn.countAll().as('n')).executeTakeFirstOrThrow()).n)).toBe(2);
      await expect(read(formatCursor(EPOCH, old[4]!))).rejects.toMatchObject({ code: 'EVENTS_CURSOR_EXPIRED', status: 410 });
      expect(seqsOf(await read(formatCursor(EPOCH, old[9]!)))).toEqual(kept);
    });

    it('after every event was purged, a new cursor is the floor and the next event is returned, not a 410 (M15)', async () => {
      const old = await bulk(3, NOW - 8 * DAY);
      await purgeEvents(h, NOW);
      expect(await maxSeq()).toBe(0);
      const start = await read(null);
      expect(start).toEqual({ cursor: formatCursor(EPOCH, old[2]!), events: [] });
      // A client that held the last cursor before the purge reads on too.
      expect(await read(start.cursor)).toEqual(start);
      const next = await emit(NOW - 2500);
      expect(seqsOf(await read(start.cursor))).toEqual([next]);
    });

    it('refuses a call that is not well formed with a TypeError', async () => {
      const bad: Parameters<typeof readEvents>[1][] = [
        { channels: [], cursor: null, now: NOW, epoch: EPOCH },
        { channels: ['bogus'], cursor: null, now: NOW, epoch: EPOCH },
        { channels: [JOB], cursor: null, now: Number.NaN, epoch: EPOCH },
        { channels: [JOB], cursor: null, now: NOW, epoch: -1 },
        { channels: [JOB], cursor: 3 as unknown as string, now: NOW, epoch: EPOCH },
      ];
      for (const o of bad) await expect(readEvents(h.db, o)).rejects.toThrow(TypeError);
    });
  });

  describe('runConsumers', () => {
    const budget = { budgetMs: 10_000 };

    /** A consumer that records the seqs it handled and writes a `locks` row per event in the cursor's transaction. */
    function recorder(name: string) {
      const seen: number[] = [];
      let failOn: number | null = null;
      const consumer: EventConsumer = {
        name,
        async handle(trx, e) {
          await trx.insertInto('locks').values({ name: `${name}:${e.seq}`, owner: 'test', until: e.at }).execute();
          if (e.seq === failOn) throw new Error(`boom at ${e.seq}`);
          seen.push(e.seq);
        },
      };
      return { consumer, seen, failOn: (seq: number) => (failOn = seq) };
    }

    async function row(name: string) {
      return h.db.selectFrom('event_consumers').selectAll().where('name', '=', name).executeTakeFirst();
    }

    async function written(name: string): Promise<number[]> {
      const rows = await h.db.selectFrom('locks').select('name').where('name', 'like', `${name}:%`).execute();
      return rows.map((r) => Number(r.name.slice(name.length + 1))).sort((a, b) => a - b);
    }

    it('creates the consumer row on its first run with the cursor at the highest seq; older events are not handled', async () => {
      const before = await emit(NOW - 120_000);
      const { consumer, seen } = recorder('test.first');
      expect(await runConsumers(h, [consumer], { now: NOW, ...budget })).toEqual({ processed: 0 });
      expect(await row('test.first')).toMatchObject({ cursor: before, enabled: 1, needs_full_reindex: 0, updated_at: NOW });
      expect(seen).toEqual([]);
    });

    it('starts a new consumer at the events floor when the table is empty', async () => {
      await bulk(3, NOW - 8 * DAY);
      await purgeEvents(h, NOW);
      const floor = await h.db.selectFrom('settings').select('value').where('key', '=', 'system.events_floor').executeTakeFirstOrThrow();
      const { consumer } = recorder('test.floor');
      await runConsumers(h, [consumer], { now: NOW, ...budget });
      expect(Number((await row('test.floor'))?.cursor)).toBe(Number(floor.value));
    });

    it('handles events in seq order and stops at the first one created after now − 30 s; a rerun changes nothing', async () => {
      const { consumer, seen } = recorder('test.hold');
      await runConsumers(h, [consumer], { now: NOW, ...budget });
      const a = await emit(NOW - 60_000);
      const b = await emit(NOW - 45_000);
      const c = await emit(NOW - 10_000);
      expect(await runConsumers(h, [consumer], { now: NOW, ...budget })).toEqual({ processed: 2 });
      expect(seen).toEqual([a, b]);
      expect(await row('test.hold')).toMatchObject({ cursor: b, updated_at: NOW });
      expect(await written('test.hold')).toEqual([a, b]);

      // Idempotent: the same run again handles nothing.
      expect(await runConsumers(h, [consumer], { now: NOW, ...budget })).toEqual({ processed: 0 });
      expect(seen).toEqual([a, b]);
      expect(Number((await row('test.hold'))?.cursor)).toBe(b);

      // 20 s later the third one is exactly 30 s old: handled.
      expect(await runConsumers(h, [consumer], { now: NOW + 20_000, ...budget })).toEqual({ processed: 1 });
      expect(seen).toEqual([a, b, c]);
      expect(Number((await row('test.hold'))?.cursor)).toBe(c);
    });

    it('reads every channel and hands the event over parsed', async () => {
      const got: unknown[] = [];
      const consumer: EventConsumer = {
        name: 'test.all',
        async handle(_trx, e) {
          got.push(e);
        },
      };
      await runConsumers(h, [consumer], { now: NOW, ...budget });
      const a = await emit(NOW - 60_000, USER, { k: 'v' });
      const b = await emit(NOW - 59_000, 'system.backup');
      await runConsumers(h, [consumer], { now: NOW, ...budget });
      expect(got).toEqual([
        { seq: a, channel: USER, type: 'job.progress', payload: { k: 'v' }, at: NOW - 60_000 },
        { seq: b, channel: 'system.backup', type: 'job.progress', payload: {}, at: NOW - 59_000 },
      ]);
    });

    it('a consumer that throws keeps its cursor before the event, loses that event’s writes, and other consumers go on', async () => {
      const bad = recorder('test.bad');
      const good = recorder('test.good');
      await runConsumers(h, [bad.consumer, good.consumer], { now: NOW, ...budget });
      const s1 = await emit(NOW - 60_000);
      const s2 = await emit(NOW - 50_000);
      const s3 = await emit(NOW - 40_000);
      bad.failOn(s2);
      await expect(runConsumers(h, [bad.consumer, good.consumer], { now: NOW, ...budget })).rejects.toThrow(`boom at ${s2}`);
      expect(bad.seen).toEqual([s1]);
      expect(Number((await row('test.bad'))?.cursor)).toBe(s1);
      expect(await written('test.bad')).toEqual([s1]);
      expect(good.seen).toEqual([s1, s2, s3]);
      expect(Number((await row('test.good'))?.cursor)).toBe(s3);

      // Fixed, it resumes at the event that failed.
      bad.failOn(-1);
      expect(await runConsumers(h, [bad.consumer, good.consumer], { now: NOW, ...budget })).toEqual({ processed: 2 });
      expect(bad.seen).toEqual([s1, s2, s3]);
      expect(await written('test.bad')).toEqual([s1, s2, s3]);
    });

    it('skips a disabled consumer', async () => {
      const { consumer, seen } = recorder('test.off');
      await runConsumers(h, [consumer], { now: NOW, ...budget });
      const start = Number((await row('test.off'))?.cursor);
      await h.db.updateTable('event_consumers').set({ enabled: 0 }).where('name', '=', 'test.off').execute();
      await emit(NOW - 60_000);
      expect(await runConsumers(h, [consumer], { now: NOW, ...budget })).toEqual({ processed: 0 });
      expect(seen).toEqual([]);
      expect(Number((await row('test.off'))?.cursor)).toBe(start);
    });

    it('handles nothing once the budget is spent', async () => {
      const { consumer, seen } = recorder('test.budget');
      await runConsumers(h, [consumer], { now: NOW, ...budget });
      await emit(NOW - 60_000);
      expect(await runConsumers(h, [consumer], { now: NOW, budgetMs: 0 })).toEqual({ processed: 0 });
      expect(seen).toEqual([]);
    });

    it('two runs at once handle each event once', async () => {
      const { consumer, seen } = recorder('test.race');
      await runConsumers(h, [consumer], { now: NOW, ...budget });
      const seqs = await bulk(20, NOW - 60_000);
      const [x, y] = await Promise.all([
        runConsumers(h, [consumer], { now: NOW, ...budget }),
        runConsumers(h, [consumer], { now: NOW, ...budget }),
      ]);
      expect(x.processed + y.processed).toBe(20);
      expect([...seen].sort((p, q) => p - q)).toEqual(seqs);
      expect(await written('test.race')).toEqual(seqs);
      expect(Number((await row('test.race'))?.cursor)).toBe(seqs[19]);
    });

    it('refuses a consumer list that is not well formed with a TypeError', async () => {
      const ok = recorder('test.ok').consumer;
      await expect(runConsumers(h, [ok, ok], { now: NOW, ...budget })).rejects.toThrow(TypeError);
      await expect(runConsumers(h, [{ ...ok, name: 'Bad Name' }], { now: NOW, ...budget })).rejects.toThrow(TypeError);
      await expect(runConsumers(h, [ok], { now: Number.NaN, ...budget })).rejects.toThrow(TypeError);
      await expect(runConsumers(h, [ok], { now: NOW, budgetMs: -1 })).rejects.toThrow(TypeError);
      expect(await row('test.ok')).toBeUndefined();
    });
  });
});
