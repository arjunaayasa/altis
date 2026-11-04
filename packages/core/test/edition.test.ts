import type { DbHandle } from '@altis/db';
import { DomainError, EDITION_COMMUNITY } from '@altis/shared';
import { afterEach, describe, expect, it, vi, type Mock } from 'vitest';
import { errorFields, type CoreLogger } from '../src/context.js';
import { COMMUNITY_EDITION, createCommunityEdition } from '../src/edition/edition.js';
import * as core from '../src/index.js';
import { clearClockAnomaly } from '../src/scheduler/clock.js';

// The community edition seam (ruling R1, interface I-1): check() answers COMMUNITY_EDITION without a database or
// DATA_DIR and never throws, every release is entitled, a signed time is handed to clearClockAnomaly (spec §10.4) with
// the handle db() gives at that moment, a failure there is logged and not thrown, and invalidate() does nothing. The
// clearing itself, on a real database, is packages/core/test/db/clock.test.ts's.

vi.mock('../src/scheduler/clock.js', async (importOriginal) => {
  const actual = await importOriginal<typeof import('../src/scheduler/clock.js')>();
  return { ...actual, clearClockAnomaly: vi.fn(async () => true) };
});

const T = Date.UTC(2026, 10, 4, 3, 0, 0);
const MIN = 60_000;
/** A handle no test reads: clearClockAnomaly is a spy here. */
const HANDLE = { dialect: 'sqlite' } as unknown as DbHandle;

function logger(): CoreLogger & { warn: Mock<CoreLogger['warn']> } {
  return { info: vi.fn(), warn: vi.fn<CoreLogger['warn']>(), error: vi.fn() };
}

afterEach(() => {
  vi.mocked(clearClockAnomaly).mockReset();
  vi.mocked(clearClockAnomaly).mockImplementation(async () => true);
});

describe('COMMUNITY_EDITION', () => {
  it('is the active community edition, frozen, and entitles every release', () => {
    expect(COMMUNITY_EDITION.edition).toBe(EDITION_COMMUNITY);
    expect(COMMUNITY_EDITION.edition).toBe('community');
    expect(COMMUNITY_EDITION.status).toBe('active');
    expect(Object.isFrozen(COMMUNITY_EDITION)).toBe(true);
    for (const releasedAt of ['2026-01-01', '2099-12-31', '1970-01-01', '', 'not a date']) {
      expect(COMMUNITY_EDITION.notEntitled(releasedAt)).toBeNull();
    }
  });

  it('is exported by @altis/core', () => {
    expect(core.COMMUNITY_EDITION).toBe(COMMUNITY_EDITION);
    expect(core.createCommunityEdition).toBe(createCommunityEdition);
  });
});

describe('createCommunityEdition', () => {
  it('check() answers COMMUNITY_EDITION with db() undefined, fresh or not, and reads neither the DB nor the clock', async () => {
    const db = vi.fn((): DbHandle | undefined => undefined);
    const clock = vi.fn(() => T);
    const edition = createCommunityEdition({ db, clock, log: logger() });
    await expect(edition.check()).resolves.toBe(COMMUNITY_EDITION);
    await expect(edition.check({ fresh: true })).resolves.toBe(COMMUNITY_EDITION);
    await expect(edition.check({})).resolves.toBe(COMMUNITY_EDITION);
    expect(db).not.toHaveBeenCalled();
    expect(clock).not.toHaveBeenCalled();
  });

  it('check() needs no database even when one is open', async () => {
    const db = vi.fn(() => HANDLE);
    const edition = createCommunityEdition({ db, clock: () => T, log: logger() });
    const c = await edition.check();
    expect(c).toBe(COMMUNITY_EDITION);
    expect(c.notEntitled('2030-06-30')).toBeNull();
    expect(db).not.toHaveBeenCalled();
  });

  it('invalidate() is a no-op', async () => {
    const db = vi.fn(() => HANDLE);
    const edition = createCommunityEdition({ db, clock: () => T, log: logger() });
    expect(edition.invalidate()).toBeUndefined();
    await expect(edition.check({ fresh: true })).resolves.toBe(COMMUNITY_EDITION);
    expect(db).not.toHaveBeenCalled();
  });

  it('observeSignedTime refuses a malformed time or source with a TypeError, before the DB is asked', async () => {
    const db = vi.fn(() => HANDLE);
    const log = logger();
    const edition = createCommunityEdition({ db, clock: () => T, log });
    const bad: unknown[] = [
      { at: Number.NaN, source: 'feed' },
      { at: -1, source: 'feed' },
      { at: 1.5, source: 'feed' },
      { at: Number.MAX_SAFE_INTEGER + 1, source: 'feed' },
      { at: Number.POSITIVE_INFINITY, source: 'feed' },
      { at: String(T), source: 'feed' },
      { source: 'feed' },
      { at: T, source: 'clock_token' },
      { at: T, source: 'heartbeat' },
      { at: T },
      null,
      undefined,
    ];
    for (const t of bad) {
      await expect(edition.observeSignedTime(t as { at: number; source: 'feed' })).rejects.toThrow(TypeError);
    }
    // Also with no database: the input is checked first.
    const none = createCommunityEdition({ db: () => undefined, clock: () => T, log });
    await expect(none.observeSignedTime({ at: -5, source: 'feed' })).rejects.toThrow(TypeError);
    expect(db).not.toHaveBeenCalled();
    expect(vi.mocked(clearClockAnomaly)).not.toHaveBeenCalled();
    expect(log.warn).not.toHaveBeenCalled();
  });

  it('observeSignedTime with db() undefined returns quietly', async () => {
    const log = logger();
    const edition = createCommunityEdition({ db: () => undefined, clock: () => T, log });
    await expect(edition.observeSignedTime({ at: T, source: 'feed' })).resolves.toBeUndefined();
    expect(vi.mocked(clearClockAnomaly)).not.toHaveBeenCalled();
    expect(log.warn).not.toHaveBeenCalled();
  });

  it('observeSignedTime hands the signed time to clearClockAnomaly through the DB handle, with the clock as now', async () => {
    const log = logger();
    const edition = createCommunityEdition({ db: () => HANDLE, clock: () => T, log });
    await expect(edition.observeSignedTime({ at: T + 2 * MIN, source: 'feed' })).resolves.toBeUndefined();
    expect(vi.mocked(clearClockAnomaly)).toHaveBeenCalledTimes(1);
    expect(vi.mocked(clearClockAnomaly)).toHaveBeenCalledWith(HANDLE, { now: T, trustedTime: T + 2 * MIN, source: 'feed' });
    // Outside the ±5 min tolerance it is still handed on: clearClockAnomaly decides (and leaves the anomaly).
    vi.mocked(clearClockAnomaly).mockResolvedValueOnce(false);
    await edition.observeSignedTime({ at: 0, source: 'feed' });
    expect(vi.mocked(clearClockAnomaly)).toHaveBeenLastCalledWith(HANDLE, { now: T, trustedTime: 0, source: 'feed' });
    expect(log.warn).not.toHaveBeenCalled();
  });

  it('observeSignedTime reads db() and the clock at each call (the edition may be built before the DB opens)', async () => {
    const live: { handle: DbHandle | undefined; now: number } = { handle: undefined, now: T };
    const edition = createCommunityEdition({ db: () => live.handle, clock: () => live.now, log: logger() });
    await edition.observeSignedTime({ at: T, source: 'feed' });
    expect(vi.mocked(clearClockAnomaly)).not.toHaveBeenCalled();
    live.handle = HANDLE;
    live.now = T + MIN;
    await edition.observeSignedTime({ at: T + MIN, source: 'feed' });
    expect(vi.mocked(clearClockAnomaly)).toHaveBeenCalledWith(HANDLE, { now: T + MIN, trustedTime: T + MIN, source: 'feed' });
  });

  it('observeSignedTime logs a failure of clearClockAnomaly (codes only) and does not throw it', async () => {
    const log = logger();
    const edition = createCommunityEdition({ db: () => HANDLE, clock: () => T, log });
    const failure = Object.assign(new Error('connect ECONNREFUSED 10.0.0.5:3306 password=secret'), { code: 'ECONNREFUSED' });
    vi.mocked(clearClockAnomaly).mockRejectedValueOnce(failure);
    await expect(edition.observeSignedTime({ at: T, source: 'feed' })).resolves.toBeUndefined();
    expect(log.warn).toHaveBeenCalledTimes(1);
    expect(log.warn).toHaveBeenCalledWith('clock_anomaly could not be cleared by a signed time', {
      source: 'feed',
      error: errorFields(failure),
    });
    expect(JSON.stringify(log.warn.mock.calls)).not.toContain('secret');

    vi.mocked(clearClockAnomaly).mockRejectedValueOnce(new DomainError('DB_UNAVAILABLE'));
    await expect(edition.observeSignedTime({ at: T, source: 'feed' })).resolves.toBeUndefined();
    expect(log.warn).toHaveBeenLastCalledWith('clock_anomaly could not be cleared by a signed time', {
      source: 'feed',
      error: { code: 'DB_UNAVAILABLE' },
    });
  });
});
