import fsp from 'node:fs/promises';
import os from 'node:os';
import path from 'node:path';
import { PHASE1_MIGRATIONS, runMigrations, withTx } from '@altis/db';
import { newId } from '@altis/shared';
import { afterAll, beforeAll, beforeEach, describe, expect, it } from 'vitest';
import { engineLabel, testDb, testDbContext, type TestDbHandle } from '../../../../tools/test/test-db.js';
import { EVENT_KEEP_MS, EVENT_MAX_AGE_MS, purgeEvents } from '../../src/events/retention.js';
import { readSettings } from '../../src/settings/service.js';

// Event retention (spec §10.6, decision C43, M15): events go when older than 7 days and at or below the cursor of
// every enabled consumer, or when older than 30 days in any case; the highest deleted seq becomes
// `system.events_floor`, and an enabled consumer whose cursor is below it is flagged `needs_full_reindex`. On the
// engine picked by ALTIS_TEST_DB.

const ctx = testDbContext();

const DAY = 86_400_000;
const NOW = 1_800_000_000_000;
const JOB = `jobs.${newId()}`;

describe.skipIf(!ctx.available)(`purgeEvents [${engineLabel()}]`, () => {
  let h: TestDbHandle;
  let dataDir: string;

  beforeAll(async () => {
    h = await testDb();
    dataDir = await fsp.mkdtemp(path.join(os.tmpdir(), 'altis-core-events-retention-'));
    await runMigrations(h, { appVersion: '0.1.0', dataDir, migrations: PHASE1_MIGRATIONS });
  });

  afterAll(async () => {
    await h?.close();
    if (dataDir !== undefined) await fsp.rm(dataDir, { recursive: true, force: true });
  });

  beforeEach(async () => {
    await h.db.deleteFrom('events').execute();
    await h.db.deleteFrom('event_consumers').execute();
    await h.db.deleteFrom('settings').where('key', '=', 'system.events_floor').execute();
  });

  /** `n` events created at `at`; their seqs in order. */
  async function bulk(n: number, at: number): Promise<number[]> {
    const top = await h.db.selectFrom('events').select((eb) => eb.fn.max('seq').as('m')).executeTakeFirst();
    const from = Number(top?.m ?? 0);
    for (let done = 0; done < n; done += 500) {
      const rows = Array.from({ length: Math.min(500, n - done) }, () => ({
        channel: JOB,
        type: 'job.progress',
        payload: '{}',
        created_at: at,
      }));
      await h.db.insertInto('events').values(rows).execute();
    }
    const seqs = await h.db.selectFrom('events').select('seq').where('seq', '>', from).orderBy('seq').execute();
    return seqs.map((r) => Number(r.seq));
  }

  async function consumer(name: string, cursor: number, enabled = 1): Promise<void> {
    await h.db.insertInto('event_consumers').values({ name, cursor, enabled, updated_at: NOW - DAY }).execute();
  }

  async function left(): Promise<number[]> {
    return (await h.db.selectFrom('events').select('seq').orderBy('seq').execute()).map((r) => Number(r.seq));
  }

  async function floor(): Promise<unknown> {
    return (await readSettings(h.db, ['system.events_floor'], []))['system.events_floor'];
  }

  async function flags(): Promise<Record<string, number>> {
    const rows = await h.db.selectFrom('event_consumers').select(['name', 'needs_full_reindex']).orderBy('name').execute();
    return Object.fromEntries(rows.map((r) => [r.name, Number(r.needs_full_reindex)]));
  }

  it('keeps for 7 days and at most 30', () => {
    expect(EVENT_KEEP_MS).toBe(7 * DAY);
    expect(EVENT_MAX_AGE_MS).toBe(30 * DAY);
  });

  it('deletes > 7 d below every enabled cursor and > 30 d in any case; records the floor and flags a consumer below it', async () => {
    const [first] = await bulk(1, NOW - 8 * DAY);
    const [second] = await bulk(1, NOW - 8 * DAY);
    const [oldest] = await bulk(1, NOW - 31 * DAY);
    const fresh = await bulk(2, NOW - DAY);
    // Between the two 8-day events.
    await consumer('c.index', first!);

    expect(await purgeEvents(h, NOW)).toEqual({ deleted: 2, reindexFlagged: ['c.index'] });
    expect(await left()).toEqual([second!, ...fresh]);
    expect(await floor()).toBe(oldest);
    expect(await flags()).toEqual({ 'c.index': 1 });
  });

  it('a disabled consumer holds nothing back and is not flagged', async () => {
    const old = await bulk(3, NOW - 8 * DAY);
    const fresh = await bulk(1, NOW - 6 * DAY);
    await consumer('c.off', 0, 0);

    expect(await purgeEvents(h, NOW)).toEqual({ deleted: 3, reindexFlagged: [] });
    expect(await left()).toEqual(fresh);
    expect(await floor()).toBe(old[2]);
    expect(await flags()).toEqual({ 'c.off': 0 });
  });

  it('without consumers deletes everything older than 7 days, not a millisecond younger', async () => {
    const [gone] = await bulk(1, NOW - 7 * DAY - 1);
    const [edge] = await bulk(1, NOW - 7 * DAY);
    expect(await purgeEvents(h, NOW)).toEqual({ deleted: 1, reindexFlagged: [] });
    expect(await left()).toEqual([edge!]);
    expect(await floor()).toBe(gone);
  });

  it('an enabled consumer at the end holds back nothing it has handled', async () => {
    const old = await bulk(4, NOW - 8 * DAY);
    await consumer('c.done', old[3]!);
    expect(await purgeEvents(h, NOW)).toEqual({ deleted: 4, reindexFlagged: [] });
    expect(await left()).toEqual([]);
    expect(await floor()).toBe(old[3]);
    expect(await flags()).toEqual({ 'c.done': 0 });
  });

  it('the slowest enabled consumer bounds the 7-day rule', async () => {
    const old = await bulk(4, NOW - 8 * DAY);
    await consumer('c.fast', old[3]!);
    await consumer('c.slow', old[1]!);
    expect(await purgeEvents(h, NOW)).toEqual({ deleted: 2, reindexFlagged: [] });
    expect(await left()).toEqual(old.slice(2));
    expect(await floor()).toBe(old[1]);
  });

  it('deletes in batches of at most 5000 until nothing is left to delete', async () => {
    const old = await bulk(5003, NOW - 31 * DAY);
    const fresh = await bulk(2, NOW - DAY);
    expect(await purgeEvents(h, NOW)).toEqual({ deleted: 5003, reindexFlagged: [] });
    expect(await left()).toEqual(fresh);
    expect(await floor()).toBe(old[5002]);
  });

  it('never lowers the floor, flags a consumer only once, and flags a re-enabled one left below the floor', async () => {
    const old = await bulk(2, NOW - 31 * DAY);
    await consumer('c.behind', 0);
    expect(await purgeEvents(h, NOW)).toEqual({ deleted: 2, reindexFlagged: ['c.behind'] });
    expect(await floor()).toBe(old[1]);

    // Nothing to delete: the floor stays, the flagged consumer is not reported again.
    expect(await purgeEvents(h, NOW)).toEqual({ deleted: 0, reindexFlagged: [] });
    expect(await floor()).toBe(old[1]);

    // A consumer that was disabled while events went, enabled again below the floor.
    await consumer('c.back', 0, 0);
    expect(await purgeEvents(h, NOW)).toEqual({ deleted: 0, reindexFlagged: [] });
    await h.db.updateTable('event_consumers').set({ enabled: 1 }).where('name', '=', 'c.back').execute();
    expect(await purgeEvents(h, NOW)).toEqual({ deleted: 0, reindexFlagged: ['c.back'] });
    expect(await flags()).toEqual({ 'c.back': 1, 'c.behind': 1 });
  });

  it('two purges at once delete each event once and agree on the floor', async () => {
    // A floor row to lock, as after any earlier purge.
    await h.db
      .insertInto('settings')
      .values({ key: 'system.events_floor', value: '0', is_secret: 0, scope: 'instance', updated_at: NOW - DAY, updated_by: null })
      .execute();
    const old = await bulk(6000, NOW - 31 * DAY);
    const fresh = await bulk(1, NOW - DAY);
    await consumer('c.race', 0);
    const [a, b] = await Promise.all([purgeEvents(h, NOW), purgeEvents(h, NOW)]);
    expect(a.deleted + b.deleted).toBe(6000);
    expect([...a.reindexFlagged, ...b.reindexFlagged]).toEqual(['c.race']);
    expect(await left()).toEqual(fresh);
    expect(await floor()).toBe(old[5999]);
  });

  it('refuses to run inside a transaction, and a now that is not an epoch-ms integer', async () => {
    await expect(withTx(h, () => purgeEvents(h, NOW))).rejects.toThrow(TypeError);
    await expect(purgeEvents(h, Number.NaN)).rejects.toThrow(TypeError);
    await expect(purgeEvents(h, -1)).rejects.toThrow(TypeError);
  });
});
