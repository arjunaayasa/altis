import fsp from 'node:fs/promises';
import os from 'node:os';
import path from 'node:path';
import { PHASE1_MIGRATIONS, runMigrations } from '@altis/db';
import { afterAll, beforeAll, beforeEach, describe, expect, it } from 'vitest';
import { engineLabel, testDb, testDbContext, type TestDbHandle } from '../../../../tools/test/test-db.js';
import { readSettings } from '../../src/settings/service.js';
import { clearBundledBlocked, recordBundledBlocked } from '../../src/updates/bundled.js';

// `update.bundled_blocked` and its `update_blocked` notification (spec §9.8 row 2; plan Task 27) on the engine picked by
// ALTIS_TEST_DB: one notification per blocked version, also when several processes start at once and each records the
// same blocked bundled release (review L05: the settings row is locked first, as the update check locks
// `update.notified`; on SQLite the transactions serialize anyway, on MySQL/MariaDB/PostgreSQL a read before the lock
// would let each process see no record and notify).

const ctx = testDbContext();
const NOW = 1_800_000_000_000;

describe.skipIf(!ctx.available)(`the blocked bundled release [${engineLabel()}]`, () => {
  let h: TestDbHandle;
  let root: string;

  beforeAll(async () => {
    h = await testDb();
    root = await fsp.realpath(await fsp.mkdtemp(path.join(os.tmpdir(), 'altis-bundled-blocked-')));
    await runMigrations(h, { appVersion: '0.1.0-test', dataDir: path.join(root, 'mig'), migrations: PHASE1_MIGRATIONS });
  });

  afterAll(async () => {
    await h?.close();
    if (root !== undefined) await fsp.rm(root, { recursive: true, force: true });
  });

  beforeEach(async () => {
    for (const table of ['events', 'notifications'] as const) await h.db.deleteFrom(table).execute();
    await h.db.deleteFrom('settings').where('key', '=', 'update.bundled_blocked').execute();
  });

  const blocked = async (): Promise<unknown> => (await readSettings(h.db, ['update.bundled_blocked'], []))['update.bundled_blocked'];
  const sent = async () =>
    (await h.db.selectFrom('notifications').select(['type', 'params']).where('type', '=', 'update.blocked').execute()).map((n) => ({
      ...n,
      params: JSON.parse(n.params ?? 'null') as unknown,
    }));

  it('records the version and its failures; the first record of a version notifies, a repeat does not', async () => {
    expect(await recordBundledBlocked(h, { version: '0.2.0-test', failures: ['min_node'], now: NOW })).toBe(true);
    expect(await blocked()).toEqual({ version: '0.2.0-test', at: NOW, failures: ['min_node'] });
    expect(await recordBundledBlocked(h, { version: '0.2.0-test', failures: ['min_node', 'entitlement'], now: NOW + 1 })).toBe(false);
    expect(await blocked()).toEqual({ version: '0.2.0-test', at: NOW + 1, failures: ['min_node', 'entitlement'] });
    expect(await recordBundledBlocked(h, { version: '0.3.0-test', failures: ['entitlement'], now: NOW + 2 })).toBe(true);
    expect(await sent()).toEqual([
      { type: 'update.blocked', params: { version: '0.2.0-test' } },
      { type: 'update.blocked', params: { version: '0.3.0-test' } },
    ]);
    await clearBundledBlocked(h, '0.2.0-test', NOW + 3); // another version: kept
    expect(await blocked()).toMatchObject({ version: '0.3.0-test' });
    await clearBundledBlocked(h, '0.3.0-test', NOW + 3);
    expect(await blocked()).toBeNull();
  });

  it('review L05 (P6): processes that start at once and record the same blocked version notify it once', async () => {
    const results = await Promise.all(
      Array.from({ length: 4 }, (_, i) => recordBundledBlocked(h, { version: '0.2.0-test', failures: ['entitlement'], now: NOW + i })),
    );
    expect(results.filter((r) => r)).toHaveLength(1);
    expect(await sent()).toEqual([{ type: 'update.blocked', params: { version: '0.2.0-test' } }]);
    expect(await blocked()).toMatchObject({ version: '0.2.0-test', failures: ['entitlement'] });
  });
});
