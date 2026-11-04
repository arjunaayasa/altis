import fsp from 'node:fs/promises';
import os from 'node:os';
import path from 'node:path';
import { PHASE1_MIGRATIONS, runMigrations, withTx } from '@altis/db';
import { DomainError, isDomainError } from '@altis/shared';
import { afterAll, beforeAll, beforeEach, describe, expect, it, vi } from 'vitest';
import { engineLabel, testDb, testDbContext, type TestDbHandle } from '../../../../tools/test/test-db.js';
import { backupHeadroomBytes } from '../../src/backup/create-job.js';
import { COMMUNITY_EDITION, type EditionCheck } from '../../src/edition/edition.js';
import { writeSettings } from '../../src/settings/service.js';
import type { Candidate } from '../../src/updates/candidate.js';
import { PRECHECK_MIGRATION_MS, runPrecheck, throwPrecheck, type RunPrecheckDeps } from '../../src/updates/precheck.js';

// runPrecheck (spec §9.6 step 2; plan Task 21) on the engine picked by ALTIS_TEST_DB: it reads the database engine
// and version (minDb per engine, none for SQLite), the edition's entitlement for the candidate's releasedAt, a running
// snapshot backup, the C31 estimate of a DB-only backup and its headroom, the latest version the last check saw (the
// stepping stone), then proves the headroom with ensureHeadroom (a full disk → DISK_QUOTA) when everything passed.

const headroom = vi.hoisted(() => ({ calls: [] as number[], fail: null as Error | null }));
vi.mock('@altis/platform', async (importOriginal) => {
  const actual = await importOriginal<typeof import('@altis/platform')>();
  return {
    ...actual,
    ensureHeadroom: vi.fn(async (dir: string, bytes: number) => {
      headroom.calls.push(bytes);
      if (headroom.fail !== null) throw headroom.fail;
      return actual.ensureHeadroom(dir, bytes);
    }),
  };
});

const ctx = testDbContext();

/** A fake edition (the seam, ruling R1) that refuses every release for `why`. */
const refusing = (why: 'no_license' | 'released_after'): EditionCheck => ({ edition: 'fake', status: 'limited', notEntitled: () => why });

function candidate(over: Partial<Candidate> = {}): Candidate {
  return {
    version: '0.2.0-test',
    releasedAt: '2026-11-01',
    bootProtocol: 1,
    minUpgradeFrom: '0.0.0',
    minCodeVersionAfter: '0.0.0',
    minNode: '22.16.0',
    minDb: { mysql: '8.0.0', mariadb: '10.6.0', postgres: '15.0.0' },
    size: 3_000_000,
    ...over,
  };
}

describe.skipIf(!ctx.available)(`runPrecheck [${engineLabel()}]`, () => {
  let h: TestDbHandle;
  let tmp: string;
  let counter = 0;
  let dataDir: string;

  beforeAll(async () => {
    h = await testDb();
    tmp = await fsp.realpath(await fsp.mkdtemp(path.join(os.tmpdir(), 'altis-run-precheck-')));
    await runMigrations(h, { appVersion: '0.1.0-test', dataDir: path.join(tmp, 'migrate'), migrations: PHASE1_MIGRATIONS });
  });

  afterAll(async () => {
    await h?.close();
    if (tmp !== undefined) await fsp.rm(tmp, { recursive: true, force: true });
  });

  beforeEach(async () => {
    await h.db.deleteFrom('settings').execute();
    dataDir = path.join(tmp, `data-${counter++}`);
    await fsp.mkdir(dataDir, { recursive: true });
    headroom.calls.length = 0;
    headroom.fail = null;
  });

  function deps(over: Partial<RunPrecheckDeps> = {}): RunPrecheckDeps {
    return {
      dataDir,
      db: h,
      edition: { check: async () => COMMUNITY_EDITION },
      snapshotBackupRunning: async () => false,
      nodeVersion: '22.16.0',
      appVersion: '0.1.0-test',
      migrationsAhead: () => 0,
      ...over,
    };
  }

  it('all clear: ok, the estimate and the headroom from the C31 backup estimate, then the headroom is proven', async () => {
    const r = await runPrecheck(deps({ migrationsAhead: () => 2 }), candidate());
    expect(r.failures).toEqual([]);
    expect(r.ok).toBe(true);
    expect(r.dbRestoreNeeded).toBe(false);
    expect(r.steppingStone).toBe(false);
    expect(r.candidate).toEqual({ version: '0.2.0-test', bootProtocol: 1, minUpgradeFrom: '0.0.0' });
    // The headroom: the package twice, plus a backup's (1.5 × the last backup, at least 64 MiB).
    expect(r.headroomBytes).toBe(3_000_000 * 2 + (await backupHeadroomBytes(h.db)));
    expect(r.headroomBytes).toBeGreaterThanOrEqual(3_000_000 * 2 + 64 * 1024 * 1024);
    // Two migrations add 30 s each to the backup's estimate (a few ms for an empty database).
    expect(r.estimateMs).toBeGreaterThanOrEqual(2 * PRECHECK_MIGRATION_MS);
    expect(r.estimateMs).toBeLessThan(2 * PRECHECK_MIGRATION_MS + 60_000);
    expect(headroom.calls).toEqual([r.headroomBytes]);
  });

  it('the engine is read from the server: minDb floors no server meets fail everywhere but SQLite', async () => {
    const r = await runPrecheck(deps(), candidate({ minDb: { mysql: '99.0.0', mariadb: '99.0.0', postgres: '99.0.0' } }));
    if (h.dialect === 'sqlite') expect(r.failures).toEqual([]);
    else expect(r.failures).toEqual(['min_db']);
    // The floors the release build writes (MIN_SERVER_VERSIONS) are met by every test engine.
    expect((await runPrecheck(deps(), candidate())).failures).toEqual([]);
  });

  it('the community edition entitles every release; the seam: an edition that does not cover it fails `entitlement`, UPDATE_NOT_ENTITLED', async () => {
    for (const releasedAt of ['2026-11-01', '2099-12-31']) {
      const r = await runPrecheck(deps(), candidate({ releasedAt }));
      expect(r.failures, releasedAt).toEqual([]);
      expect(r.notEntitled, releasedAt).toBeNull();
    }
    headroom.calls.length = 0;
    const after = await runPrecheck(deps({ edition: { check: async () => refusing('released_after') } }), candidate());
    expect(after.failures).toEqual(['entitlement']);
    expect(after.notEntitled).toBe('released_after');
    let caught: unknown;
    try {
      throwPrecheck(after);
    } catch (error) {
      caught = error;
    }
    expect(isDomainError(caught) && [caught.code, caught.meta?.['reason']]).toEqual(['UPDATE_NOT_ENTITLED', 'released_after']);
    const none = await runPrecheck(deps({ edition: { check: async () => refusing('no_license') } }), candidate());
    expect(none.notEntitled).toBe('no_license');
    expect(headroom.calls).toEqual([]); // nothing to install: no headroom probe
  });

  it('a snapshot backup running, the node version, minUpgradeFrom and a newer target from the deps', async () => {
    expect((await runPrecheck(deps({ snapshotBackupRunning: async () => true }), candidate())).failures).toEqual(['snapshot_backup']);
    expect((await runPrecheck(deps({ nodeVersion: '22.15.0' }), candidate())).failures).toEqual(['min_node']);
    expect((await runPrecheck(deps(), candidate({ version: '0.3.0-test', minUpgradeFrom: '0.2.0-test' }))).failures).toEqual(['min_upgrade_from']);
    expect((await runPrecheck(deps({ appVersion: '0.2.0-test' }), candidate())).failures).toEqual(['not_newer']);
    const restore = await runPrecheck(deps({ appVersion: '0.2.0-test' }), candidate({ version: '0.3.0-test', minCodeVersionAfter: '0.3.0-test' }));
    expect(restore.dbRestoreNeeded).toBe(true);
  });

  it('steppingStone: the candidate is below the latest version the last update check saw', async () => {
    const now = Date.now();
    await withTx(h, (trx) =>
      writeSettings(
        trx,
        { 'update.check': { at: now, ok: true, error: null, seq: 3, available: null, latest: '0.3.0-test', steppingStone: true } },
        { keyring: [], now, actorId: null },
      ),
    );
    expect((await runPrecheck(deps(), candidate())).steppingStone).toBe(true);
    expect((await runPrecheck(deps(), candidate({ version: '0.3.0-test' }))).steppingStone).toBe(false);
  });

  it('1d review L14: a check of another channel names no stepping stone (the channel was switched since)', async () => {
    const now = Date.now();
    const check = { at: now, channel: 'stable', ok: true, error: null, seq: 3, available: null, latest: '0.3.0-test', steppingStone: true };
    await withTx(h, (trx) => writeSettings(trx, { 'update.check': check, 'update.channel': 'beta' }, { keyring: [], now, actorId: null }));
    expect((await runPrecheck(deps(), candidate())).steppingStone).toBe(false);
    // Back on the channel the check read, it counts again.
    await withTx(h, (trx) => writeSettings(trx, { 'update.channel': 'stable' }, { keyring: [], now, actorId: null }));
    expect((await runPrecheck(deps(), candidate())).steppingStone).toBe(true);
  });

  it('a full disk → DISK_QUOTA from the headroom probe', async () => {
    headroom.fail = new DomainError('DISK_QUOTA', { detail: 'full', meta: { reason: 'headroom' } });
    let caught: unknown;
    try {
      await runPrecheck(deps(), candidate());
    } catch (error) {
      caught = error;
    }
    expect(isDomainError(caught) && caught.code).toBe('DISK_QUOTA');
  });
});
