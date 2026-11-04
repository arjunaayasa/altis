import fsp from 'node:fs/promises';
import path from 'node:path';
import { COMMUNITY_EDITION, collectDiagnostics, type OpFile } from '@altis/core';
import { readKeysetWithBak, type KeysetDoc } from '@altis/crypto';
import { jakartaDate } from '@altis/crypto/feed';
import { PHASE1_MIGRATIONS, connect, runMigrations, withTx, type DbHandle } from '@altis/db';
import { dataPath, readCurrentState, updateCurrentState } from '@altis/platform';
import { isDomainError, newId } from '@altis/shared';
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import { DEV_KEYSET, DEV_ROOTS, rootDoc, writeSignedRelease, type SignedReleaseOptions } from '../../../../packages/core/test/helpers/signed-release.js';
import { engineLabel, testDb, testDbConfig, testDbContext } from '../../../../tools/test/test-db.js';
import { writeConfig } from '../../src/config.js';
import { start, type BootContext } from '../../src/index.js';
import { readOpJson } from '../ops-support.js';
import { bootContext, closeTestServers, sampleConfig, useDataDir, type TestBootContext } from '../support.js';

// A bundled release newer than the active one whose folder is there (spec §9.8 row 1 and 2; plan Task 27; decision
// D1d-24; preflight B7, S9): after `ready`, start() runs the full prechecks of §9.6 step 2 on the bundled manifest
// (verifyReleaseWithRoots `all`, candidateOf) and begins an `update` op at `verified` (source `bundled`); a pin of that
// version, or a version whose update failed before (`releases_log`), begins nothing; failed prechecks record
// `update.bundled_blocked` and notify `update_blocked` once per version. Also at every start after `ready` (R65a,
// D1d-16, D1d-23): the keyset documents of the releases go to DATA_DIR/releases/keyset.json, the staging folders of
// no live op are swept, and the retention and adoption jobs are enqueued.

const engine = testDbContext();
const dirs = useDataDir();
const V1 = '0.1.0-test';
const V2 = '0.2.0-test';
const TODAY = jakartaDate(Date.now());

type Ctx = TestBootContext & { pendingBoot?: boolean; bootMarker: TestBootContext['bootMarker'] & { waiting: ReturnType<typeof vi.fn> } };

const handles: DbHandle[] = [];

beforeEach(async () => {
  if (engine.available) await (await testDb()).close(); // an empty database
  vi.stubGlobal('__TRUSTED_KEYS__', DEV_ROOTS); // what a test build of app.js and server.mjs embeds
});

afterEach(async () => {
  await closeTestServers();
  await Promise.all(handles.splice(0).map((h) => h.close()));
  vi.unstubAllEnvs();
  vi.unstubAllGlobals();
});

async function ownHandle(): Promise<DbHandle> {
  const h = await connect(testDbConfig(engine), { runtime: 'standalone', purpose: 'cli', dataDir: dirs.dataDir });
  handles.push(h);
  return h;
}

const appRoot = (): string => path.join(dirs.root, 'app');
const bundledDir = (version = V2): string => path.join(appRoot(), 'bundled-release', version);

/**
 * An installation of 0.1.0-test as data release (`releases/0.1.0-test`, active), its database migrated, its config, and
 * `bundled-release/<bundled>` beside app.js (released today).
 */
async function installation(o: { bundled?: SignedReleaseOptions; activeSource?: 'data' | 'bundled' } = {}): Promise<void> {
  await writeConfig(dirs.dataDir, sampleConfig({ db: testDbConfig(engine) }));
  const h = await ownHandle();
  await runMigrations(h, { appVersion: V1, dataDir: dirs.dataDir, migrations: PHASE1_MIGRATIONS });
  await readCurrentState(dirs.dataDir, V1);
  if (o.activeSource !== 'bundled') {
    await writeSignedRelease(path.join(dirs.dataDir, 'releases', V1), V1);
    await updateCurrentState(dirs.dataDir, (s) => ({ ...s, active: { version: V1, source: 'data' } }));
  }
  await writeSignedRelease(bundledDir(), V2, { ...o.bundled, meta: { releasedAt: TODAY, ...o.bundled?.meta } });
}

/** The context app.js hands 0.1.0-test booted as `active` with the bundled 0.2.0-test beside it (newer). */
function activeContext(o: { relation?: 'newer' | 'same' | 'older' } = {}): Ctx {
  const ctx = bootContext(dirs.dataDir, { version: V1 }) as Ctx;
  ctx.release = { version: V1, dir: path.join(dirs.dataDir, 'releases', V1), source: 'data' };
  ctx.bundledRelease = { version: V2, dir: bundledDir(), relation: o.relation ?? 'newer' };
  ctx.bootMarker = { phase: vi.fn(), progress: vi.fn(), waiting: vi.fn() };
  return ctx;
}

/** The context app.js hands 0.2.0-test booted as `pending` (markHealthy promotes it). */
function pendingContext(): Ctx {
  const ctx = bootContext(dirs.dataDir, { version: V2 }) as Ctx;
  ctx.release = { version: V2, dir: path.join(dirs.dataDir, 'releases', V2), source: 'data' };
  ctx.pendingBoot = true;
  ctx.bootMarker = { phase: vi.fn(), progress: vi.fn(), waiting: vi.fn() };
  ctx.markHealthy = vi.fn(async () => {
    await updateCurrentState(dirs.dataDir, (s) =>
      s.pending?.version === V2 ? { ...s, previous: s.active, active: s.pending, pending: null, pendingSince: null } : null,
    );
  });
  return ctx;
}

async function opOrNull(): Promise<OpFile | null> {
  try {
    return await readOpJson(dirs.dataDir);
  } catch {
    return null;
  }
}

async function logRows(version = V2): Promise<{ id: string; status: string }[]> {
  const h = await ownHandle();
  return h.db.selectFrom('releases_log').select(['id', 'status']).where('version', '=', version).execute();
}

async function blockedNotifications(): Promise<number> {
  const h = await ownHandle();
  return (await h.db.selectFrom('notifications').select('id').where('type', '=', 'update.blocked').execute()).length;
}

async function bundledBlocked(): Promise<unknown> {
  const h = await ownHandle();
  const row = await h.db.selectFrom('settings').select('value').where('key', '=', 'update.bundled_blocked').executeTakeFirst();
  return row?.value == null ? null : (JSON.parse(row.value) as unknown);
}

describe.skipIf(!engine.available)(`a newer bundled release (§9.8 rows 1-2) [${engineLabel()}]`, () => {
  it('→ an update op begun in verified with source bundled; the active release keeps serving until the op holds maintenance', async () => {
    vi.stubEnv('ALTIS_RUNNER', 'off');
    await installation();
    const ctx = activeContext();
    await start(ctx as BootContext);
    const op = await readOpJson(dirs.dataDir);
    expect(op).toMatchObject({ kind: 'update', actor: { type: 'system', id: null }, pointOfNoReturn: false });
    expect(['verified', 'frozen', 'backed_up']).toContain(op.state);
    expect(op.params).toMatchObject({ source: 'bundled', target: V2, from: V1, entry: null });
    expect(await bundledBlocked()).toBeNull();
  });

  it('pinned = 0.2.0-test → no op', async () => {
    vi.stubEnv('ALTIS_RUNNER', 'off');
    await installation();
    await updateCurrentState(dirs.dataDir, (s) => ({ ...s, pinned: V2 }));
    await start(activeContext() as BootContext);
    expect(await opOrNull()).toBeNull();
  });

  it('a releases_log row aborted for 0.2.0-test → no op; an older or same bundled release → no op', async () => {
    vi.stubEnv('ALTIS_RUNNER', 'off');
    await installation();
    const h = await ownHandle();
    const id = newId();
    await withTx(h, async (trx) => {
      await trx
        .insertInto('releases_log')
        .values({ id, version: V2, action: 'update', from_version: V1, status: 'aborted', started_at: Date.now() - 60_000, finished_at: Date.now() - 50_000, backup_id: null, detail: null })
        .execute();
    });
    await start(activeContext() as BootContext);
    expect(await opOrNull()).toBeNull();
    await closeTestServers();
    await h.db.deleteFrom('releases_log').execute();
    await start(activeContext({ relation: 'older' }) as BootContext);
    expect(await opOrNull()).toBeNull();
  });

  it("a manifest with minNode '99.0.0' → no op, update.bundled_blocked.failures = ['min_node'], one update_blocked notification (none at the next start)", async () => {
    vi.stubEnv('ALTIS_RUNNER', 'off');
    await installation({ bundled: { meta: { minNode: '99.0.0' } } });
    await start(activeContext() as BootContext);
    expect(await opOrNull()).toBeNull();
    expect(await bundledBlocked()).toMatchObject({ version: V2, failures: ['min_node'] });
    expect(await blockedNotifications()).toBe(1);
    await closeTestServers();
    await start(activeContext() as BootContext);
    expect(await opOrNull()).toBeNull();
    expect(await blockedNotifications()).toBe(1);
  });

  it(
    'real flow (B7): the bundled update fails health:0.2.0-test and ends rolled_back; a restart of 0.1 with the same bundled release begins nothing (failed_before)',
    async () => {
      await installation();
      // 0.1 boots (worker mode): the op begins at verified, and its worker loop steps it to the point of no return.
      const first = activeContext();
      await start(first as BootContext);
      const op = await readOpJson(dirs.dataDir);
      expect(op.params).toMatchObject({ source: 'bundled', target: V2 });
      await vi.waitFor(
        async () => {
          expect((await readOpJson(dirs.dataDir)).state).toBe('switched');
          expect((await readCurrentState(dirs.dataDir, V1)).pending).toEqual({ version: V2, source: 'data' });
        },
        { timeout: 40_000, interval: 200 },
      );
      expect(await fsp.readFile(path.join(dirs.dataDir, 'releases', V2, '.complete'), 'utf8')).toBe('');
      await closeTestServers();

      // app.js boots the pending 0.2 (boot.lock holder): its health check fails, the op goes to reverting.
      vi.stubEnv('ALTIS_RUNNER', 'off');
      vi.stubEnv('ALTIS_TEST_FAULT', `health:${V2}`);
      const error = await start(pendingContext() as BootContext).then(
        () => null,
        (e: unknown) => e,
      );
      expect(isDomainError(error) && error.code).toBe('UPDATE_BOOT_FAILED');
      expect(await readOpJson(dirs.dataDir)).toMatchObject({ opId: op.opId, state: 'reverting' });
      vi.stubEnv('ALTIS_TEST_FAULT', '');
      // app.js reverts: pending = null, then 0.1 in the same process, which steps the revert.
      await updateCurrentState(dirs.dataDir, (s) => ({ ...s, pending: null, pendingSince: null }));
      await start(activeContext() as BootContext);
      expect(await readOpJson(dirs.dataDir)).toMatchObject({ opId: op.opId, state: 'rolled_back' });
      expect(await logRows()).toEqual([{ id: op.opId, status: 'rolled_back' }]);

      // A restart of 0.1 with the same bundled release: no new op (failed_before), the row the op wrote is the only one.
      await closeTestServers();
      await start(activeContext() as BootContext);
      expect(await readOpJson(dirs.dataDir)).toMatchObject({ opId: op.opId, state: 'rolled_back' });
      expect(await logRows()).toEqual([{ id: op.opId, status: 'rolled_back' }]);

      // 1d Task 29 (preflight B7): Diagnostik shows it. app.js (built with 0.2.0-test, the release beside it) runs 0.1.
      const report = await collectDiagnostics({
        h: await ownHandle(),
        dataDir: dirs.dataDir,
        appRoot: appRoot(),
        runtime: 'standalone',
        env: {},
        version: V1,
        appJsVersion: V2,
        transport: 'polling',
        hops: 0,
        sessionKey: new Uint8Array(32),
        now: Date.now(),
        // The community edition (only the report's release section is looked at here).
        edition: { check: async () => COMMUNITY_EDITION },
        roots: DEV_ROOTS,
        refuseDevKids: false,
      });
      expect(report.release.bundled).toEqual({ version: V2, relation: 'newer', note: 'failed_before' });
    },
    120_000,
  );
});

describe.skipIf(!engine.available)(`every start after ready: keyset, sweep, jobs [${engineLabel()}]`, () => {
  it('a bundled release whose keyset.json holds a new root document → DATA_DIR/releases/keyset.json holds it; staging folders swept; retention and adoption enqueued', async () => {
    vi.stubEnv('ALTIS_RUNNER', 'off');
    await writeConfig(dirs.dataDir, sampleConfig({ db: testDbConfig(engine) }));
    const h = await ownHandle();
    await runMigrations(h, { appVersion: V1, dataDir: dirs.dataDir, migrations: PHASE1_MIGRATIONS });
    await readCurrentState(dirs.dataDir, V1); // active 0.1.0-test (bundled)
    const fresh: KeysetDoc = rootDoc({ seq: 3, revokedKids: ['dev-rel-2'] });
    await writeSignedRelease(bundledDir(V1), V1, { keyset: [...DEV_KEYSET, fresh] });
    const stale = path.join(dirs.dataDir, 'releases', `.tmp-0.5.0-test-${newId()}`);
    await fsp.mkdir(path.join(stale, 'release'), { recursive: true });

    const ctx = bootContext(dirs.dataDir, { version: V1 });
    ctx.release = { version: V1, dir: bundledDir(V1), source: 'bundled' };
    await start(ctx as BootContext);

    const stored = (await readKeysetWithBak(dataPath(dirs.dataDir, 'releases', 'keyset.json'), 'store')).sources.flatMap((s) => s.docs as KeysetDoc[]);
    expect(stored.map((d) => d.raw)).toContain(fresh.raw);
    await expect(fsp.lstat(stale)).rejects.toMatchObject({ code: 'ENOENT' });
    const jobs = await h.db.selectFrom('jobs').select(['type', 'payload', 'unique_key']).execute();
    expect(jobs).toEqual(
      expect.arrayContaining([
        { type: 'release.retention', payload: '{}', unique_key: 'release.retention' },
        { type: 'release.adopt', payload: JSON.stringify({ version: V1 }), unique_key: `release.adopt:${V1}` },
      ]),
    );

    // A second start enqueues no second job of either kind (unique keys), and image mode enqueues no adoption. Phase 2:
    // the catalog's boot hook queues the first reindex of a never-built search index, once as well.
    await closeTestServers();
    await start(Object.assign(bootContext(dirs.dataDir, { version: V1 }), { release: ctx.release }) as BootContext);
    expect((await h.db.selectFrom('jobs').select('type').execute()).map((r) => r.type).sort()).toEqual([
      'catalog.reindex',
      'release.adopt',
      'release.retention',
    ]);
  });

  it('image mode (ALTIS_RELEASE_SOURCE=image): no adoption job, and a newer bundled release is not begun as an update', async () => {
    vi.stubEnv('ALTIS_RUNNER', 'off');
    vi.stubEnv('ALTIS_RELEASE_SOURCE', 'image');
    await installation({ activeSource: 'bundled' });
    await writeSignedRelease(bundledDir(V1), V1);
    const ctx = activeContext();
    ctx.release = { version: V1, dir: bundledDir(V1), source: 'bundled' };
    await start(ctx as BootContext);
    const h = await ownHandle();
    // Phase 2: beside the retention, the catalog's boot hook queues the first reindex of a never-built search index.
    expect((await h.db.selectFrom('jobs').select('type').execute()).map((r) => r.type).sort()).toEqual(['catalog.reindex', 'release.retention']);
    expect(await opOrNull()).toBeNull();
  });
});
