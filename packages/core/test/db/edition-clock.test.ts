import fsp from 'node:fs/promises';
import os from 'node:os';
import path from 'node:path';
import { PHASE1_MIGRATIONS, runMigrations, withTx } from '@altis/db';
import { afterAll, beforeAll, beforeEach, describe, expect, it, vi, type Mock } from 'vitest';
import { engineLabel, testDb, testDbContext, type TestDbHandle } from '../../../../tools/test/test-db.js';
import type { CoreLogger } from '../../src/context.js';
import { COMMUNITY_EDITION, createCommunityEdition } from '../../src/edition/edition.js';
import { readClockAnomaly } from '../../src/scheduler/clock.js';
import { writeSettings } from '../../src/settings/service.js';

// The community edition's signed time (ruling R1, interface I-1; spec §10.4) on the engine picked by ALTIS_TEST_DB:
// the update feed's freshness `issuedAt` within ±5 minutes of the clock clears an active clock_anomaly, one further off
// leaves it, and the edition writes no licence state at all (no `license_state` row, no `license.*` setting).

const ctx = testDbContext();
const MIN = 60_000;
/** On a whole minute, in the past: what clearClockAnomaly writes is dated by it. */
const NOW = Math.floor(Date.now() / MIN) * MIN - 60 * MIN;

describe.skipIf(!ctx.available)(`the community edition and the clock [${engineLabel()}]`, () => {
  let h: TestDbHandle;
  let tmp: string;
  let log: CoreLogger & { warn: Mock<CoreLogger['warn']> };

  const raise = () =>
    withTx(h, (trx) =>
      writeSettings(trx, { 'system.clock_anomaly': { detectedAt: NOW - 10 * MIN, maxSeen: NOW + 60 * MIN } }, { keyring: [], now: NOW, actorId: null }),
    );
  const licenceRows = async () => ({
    state: await h.db.selectFrom('license_state').selectAll().execute(),
    settings: await h.db.selectFrom('settings').select('key').where('key', 'like', 'license.%').execute(),
  });

  beforeAll(async () => {
    h = await testDb();
    tmp = await fsp.realpath(await fsp.mkdtemp(path.join(os.tmpdir(), 'altis-edition-clock-')));
    await runMigrations(h, { appVersion: '0.1.0-test', dataDir: path.join(tmp, 'migrate'), migrations: PHASE1_MIGRATIONS });
  });

  afterAll(async () => {
    await h?.close();
    if (tmp !== undefined) await fsp.rm(tmp, { recursive: true, force: true });
  });

  beforeEach(async () => {
    for (const table of ['settings', 'license_state', 'audit_log'] as const) await h.db.deleteFrom(table).execute();
    log = { info: vi.fn(), warn: vi.fn<CoreLogger['warn']>(), error: vi.fn() };
  });

  it('a signed time within ±5 minutes clears clock_anomaly; one 6 minutes off leaves it', async () => {
    const edition = createCommunityEdition({ db: () => h, clock: () => NOW, log });
    await raise();
    expect(await readClockAnomaly(h.db)).not.toBeNull();

    await edition.observeSignedTime({ at: NOW + 6 * MIN, source: 'feed' });
    expect(await readClockAnomaly(h.db)).not.toBeNull();

    await edition.observeSignedTime({ at: NOW - 4 * MIN, source: 'feed' });
    expect(await readClockAnomaly(h.db)).toBeNull();
    // An automatic clear is not an admin confirmation: no audit entry.
    expect(await h.db.selectFrom('audit_log').select('action').where('action', '=', 'diagnostics.clock_confirm').execute()).toEqual([]);
    // Nothing to clear any more: still quiet.
    await edition.observeSignedTime({ at: NOW, source: 'feed' });
    expect(await readClockAnomaly(h.db)).toBeNull();
    expect(log.warn).not.toHaveBeenCalled();
  });

  it('writes no licence state: no license_state row and no license.* setting, whatever it is asked', async () => {
    const edition = createCommunityEdition({ db: () => h, clock: () => NOW, log });
    await raise();
    await edition.observeSignedTime({ at: NOW, source: 'feed' });
    expect(await edition.check()).toBe(COMMUNITY_EDITION);
    expect(await edition.check({ fresh: true })).toBe(COMMUNITY_EDITION);
    edition.invalidate();
    expect((await edition.check()).notEntitled('2099-12-31')).toBeNull();
    expect(await licenceRows()).toEqual({ state: [], settings: [] });
  });
});
