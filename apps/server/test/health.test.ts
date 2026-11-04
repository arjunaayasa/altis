import type { AltisMigration, DbHandle } from '@altis/db';
import { DomainError, isDomainError } from '@altis/shared';
import { Hono } from 'hono';
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import type { AppState } from '../src/app.js';
import { HEALTH_DB_TIMEOUT_MS, HEALTH_PATH, HEALTH_REUSE_MS, healthHandler, updateHealth, type PingDatabase } from '../src/http/health.js';
import type { AppEnv } from '../src/http/request-id.js';

// /_health single-flight (L48): concurrent live checks share one in-flight ping, and its answer is reused for
// 1000 ms, so a flood of /_health requests (or a stalled database) costs one `select 1` at a time. The ping is the
// handler's seam here; fake timers drive the clock.

const VERSION = '0.1.0';

/** Stands in for an open database: the ping seam never touches it. */
const fakeDb = (): DbHandle => ({ db: {} }) as unknown as DbHandle;

/** A ping that answers `ok` after `ms`, counting its calls. */
function slowPing(ms: number, ok: boolean | (() => boolean) = true) {
  return vi.fn<PingDatabase>(
    () => new Promise<boolean>((resolve) => setTimeout(() => resolve(typeof ok === 'function' ? ok() : ok), ms)),
  );
}

function appWith(state: AppState, ping: PingDatabase): Hono<AppEnv> {
  return new Hono<AppEnv>().get(HEALTH_PATH, healthHandler(state, VERSION, { ping }));
}

async function body(res: Response): Promise<unknown> {
  return res.json();
}

describe('/_health single-flight and 1 s reuse (L48)', () => {
  beforeEach(() => {
    vi.useFakeTimers({ toFake: ['setTimeout', 'clearTimeout', 'Date'] });
  });

  afterEach(() => {
    vi.useRealTimers();
  });

  it('reuses a result for 1000 ms', () => {
    expect(HEALTH_REUSE_MS).toBe(1000);
  });

  it('10 concurrent requests → one ping; 500 ms later → no new ping; 1100 ms later → a new one', async () => {
    const ping = slowPing(200);
    const db = fakeDb();
    const app = appWith({ phase: 'ready', db }, ping);

    const pending = Promise.all(Array.from({ length: 10 }, () => Promise.resolve(app.request(HEALTH_PATH))));
    await vi.advanceTimersByTimeAsync(200);
    const replies = await pending;
    expect(replies.map((r) => r.status)).toEqual(Array(10).fill(200));
    expect(await Promise.all(replies.map(body))).toEqual(Array(10).fill({ status: 'ok', version: VERSION }));
    expect(ping).toHaveBeenCalledTimes(1);
    expect(ping).toHaveBeenCalledWith(db, 2000);

    await vi.advanceTimersByTimeAsync(500);
    const reused = await app.request(HEALTH_PATH);
    expect(reused.status).toBe(200);
    expect(ping).toHaveBeenCalledTimes(1);

    await vi.advanceTimersByTimeAsync(600); // 1100 ms after the answer
    const again = Promise.resolve(app.request(HEALTH_PATH));
    await vi.advanceTimersByTimeAsync(200);
    expect((await again).status).toBe(200);
    expect(ping).toHaveBeenCalledTimes(2);
  });

  it('a failed check is shared and reused too: 503 db_unavailable for every caller, one ping', async () => {
    const ping = slowPing(200, false);
    const app = appWith({ phase: 'ready', db: fakeDb() }, ping);
    const pending = Promise.all(Array.from({ length: 5 }, () => Promise.resolve(app.request(HEALTH_PATH))));
    await vi.advanceTimersByTimeAsync(200);
    const replies = await pending;
    expect(replies.map((r) => r.status)).toEqual(Array(5).fill(503));
    expect(await body(replies[0] as Response)).toEqual({ status: 'db_unavailable', version: VERSION });
    await vi.advanceTimersByTimeAsync(999);
    expect((await app.request(HEALTH_PATH)).status).toBe(503);
    expect(ping).toHaveBeenCalledTimes(1);
    await vi.advanceTimersByTimeAsync(1);
    const again = Promise.resolve(app.request(HEALTH_PATH));
    await vi.advanceTimersByTimeAsync(200);
    await again;
    expect(ping).toHaveBeenCalledTimes(2);
  });

  it('the reuse window starts when the answer arrives, not when the ping started', async () => {
    const ping = slowPing(1500);
    const app = appWith({ phase: 'ready', db: fakeDb() }, ping);
    const first = Promise.resolve(app.request(HEALTH_PATH));
    await vi.advanceTimersByTimeAsync(1500);
    expect((await first).status).toBe(200);
    await vi.advanceTimersByTimeAsync(900); // 2400 ms after the ping started, 900 ms after its answer
    expect((await app.request(HEALTH_PATH)).status).toBe(200);
    expect(ping).toHaveBeenCalledTimes(1);
  });

  it('a request while the ping is in flight joins it, whenever it comes', async () => {
    const ping = slowPing(1800);
    const app = appWith({ phase: 'ready', db: fakeDb() }, ping);
    const first = Promise.resolve(app.request(HEALTH_PATH));
    await vi.advanceTimersByTimeAsync(1500);
    const late = Promise.resolve(app.request(HEALTH_PATH));
    await vi.advanceTimersByTimeAsync(300);
    expect([(await first).status, (await late).status]).toEqual([200, 200]);
    expect(ping).toHaveBeenCalledTimes(1);
  });

  it('another database handle gets its own ping (start() replaces the handle on a retry)', async () => {
    let answer = false;
    const ping = slowPing(100, () => answer);
    const state: AppState = { phase: 'ready', db: fakeDb() };
    const app = appWith(state, ping);
    const first = Promise.resolve(app.request(HEALTH_PATH));
    await vi.advanceTimersByTimeAsync(100);
    expect((await first).status).toBe(503);

    state.db = fakeDb();
    answer = true;
    const second = Promise.resolve(app.request(HEALTH_PATH));
    await vi.advanceTimersByTimeAsync(100);
    expect((await second).status).toBe(200);
    expect(ping).toHaveBeenCalledTimes(2);
    expect(ping.mock.calls[1]?.[0]).toBe(state.db);
  });

  it('a ping that throws counts as a failed check and is not stuck in flight', async () => {
    const ping = vi.fn<PingDatabase>(() => Promise.reject(new Error('boom')));
    const app = appWith({ phase: 'ready', db: fakeDb() }, ping);
    expect(await body(await app.request(HEALTH_PATH))).toEqual({ status: 'db_unavailable', version: VERSION });
    await vi.advanceTimersByTimeAsync(1000);
    expect((await app.request(HEALTH_PATH)).status).toBe(503);
    expect(ping).toHaveBeenCalledTimes(2);
  });

  it('a clock that steps back does not stretch the reuse', async () => {
    const ping = slowPing(0);
    const app = appWith({ phase: 'ready', db: fakeDb() }, ping);
    const first = Promise.resolve(app.request(HEALTH_PATH));
    await vi.advanceTimersByTimeAsync(0);
    await first;
    vi.setSystemTime(Date.now() - 60 * 60_000);
    const again = Promise.resolve(app.request(HEALTH_PATH));
    await vi.advanceTimersByTimeAsync(0);
    await again;
    expect(ping).toHaveBeenCalledTimes(2);
  });

  it('no ping at all outside phase ready', async () => {
    const ping = slowPing(0);
    for (const phase of ['starting', 'not_installed', 'db_unavailable', 'too_old'] as const) {
      expect((await appWith({ phase }, ping).request(HEALTH_PATH)).status).toBe(503);
    }
    expect((await appWith({ phase: 'ready' }, ping).request(HEALTH_PATH)).status).toBe(503);
    expect(ping).not.toHaveBeenCalled();
  });
});

// Review C09 (spec §9.3 "Bukan alasan revert: … galat konektivitas DB"): updateHealth, the health of the update op's
// `verifying` step, says false only for a database that answers and lacks a migration (a revert); a database that
// cannot be reached, or answers too slowly, is a wait: DB_UNAVAILABLE, which leaves the op as it was.
describe('updateHealth: unhealthy (false) versus unreachable (DB_UNAVAILABLE)', () => {
  const MIGRATIONS = { '0001_a': {}, '0002_b': {} } as unknown as Readonly<Record<string, AltisMigration>>;
  const unavailable = (): DomainError => new DomainError('DB_UNAVAILABLE', { meta: { reason: 'connection_lost', code: 'ECONNRESET', retryable: true } });

  /** A handle whose `select 1` answers with `ping` and whose schema_migrations read with `names`. */
  function handle(o: { ping?: () => Promise<unknown>; names?: () => Promise<{ name: string }[]> }): DbHandle {
    const ping = o.ping ?? (async () => [{ ok: 1 }]);
    const names = o.names ?? (async () => [{ name: '0001_a' }, { name: '0002_b' }]);
    return {
      db: {
        selectNoFrom: () => ({ execute: ping }),
        selectFrom: () => ({ select: () => ({ execute: names }) }),
      },
    } as unknown as DbHandle;
  }

  afterEach(() => {
    vi.useRealTimers();
  });

  it('every migration applied → true; one missing → false (a revert)', async () => {
    expect(await updateHealth(handle({}), MIGRATIONS)).toBe(true);
    expect(await updateHealth(handle({ names: async () => [{ name: '0001_a' }] }), MIGRATIONS)).toBe(false);
  });

  it('schema_migrations unreadable for another reason than the connection → false', async () => {
    const h = handle({ names: () => Promise.reject(new Error('no such table: schema_migrations')) });
    expect(await updateHealth(h, MIGRATIONS)).toBe(false);
  });

  it('a ping that fails (a lost connection) → DB_UNAVAILABLE, never false', async () => {
    await expect(updateHealth(handle({ ping: () => Promise.reject(unavailable()) }), MIGRATIONS)).rejects.toMatchObject({ code: 'DB_UNAVAILABLE' });
  });

  it('a ping that takes longer than HEALTH_DB_TIMEOUT_MS (a throttled host) → DB_UNAVAILABLE, never false', async () => {
    vi.useFakeTimers({ toFake: ['setTimeout', 'clearTimeout'] });
    const outcome = updateHealth(handle({ ping: () => new Promise(() => {}) }), MIGRATIONS).then(
      (v) => v,
      (e: unknown) => e,
    );
    await vi.advanceTimersByTimeAsync(HEALTH_DB_TIMEOUT_MS + 1);
    const result = await outcome;
    expect(isDomainError(result) && result.code).toBe('DB_UNAVAILABLE');
  });

  it('the schema_migrations read losing the connection → DB_UNAVAILABLE, never false', async () => {
    await expect(updateHealth(handle({ names: () => Promise.reject(unavailable()) }), MIGRATIONS)).rejects.toMatchObject({ code: 'DB_UNAVAILABLE' });
  });
});
