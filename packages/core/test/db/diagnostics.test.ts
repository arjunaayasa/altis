import { randomBytes } from 'node:crypto';
import fsp from 'node:fs/promises';
import os from 'node:os';
import path from 'node:path';
import { PHASE1_MIGRATIONS, checkServer, runMigrations, withTx } from '@altis/db';
import { newId } from '@altis/shared';
import type { DiagnosticsReport } from '@altis/shared/api/diagnostics';
import { afterAll, beforeAll, beforeEach, describe, expect, it, vi } from 'vitest';
import { engineLabel, testDb, testDbContext, type TestDbHandle } from '../../../../tools/test/test-db.js';
import type { CoreLogger } from '../../src/context.js';
import { collectDiagnostics, fullTextCapability, usageJob, type CollectOptions } from '../../src/diagnostics/collect.js';
import { createCommunityEdition, type EditionCheck, type EditionService } from '../../src/edition/edition.js';
import { recordProbeResult } from '../../src/diagnostics/probes.js';
import type { JobContext } from '../../src/jobs/types.js';
import { notify } from '../../src/notifications/service.js';
import { searchHealth } from '../../src/search/health.js';
import { readSettings, writeSettings } from '../../src/settings/service.js';
import { insertReleaseLog, setReleaseLogStatus } from '../../src/updates/releases-log.js';
import { DEV_KEYSET, DEV_ROOTS, rootDoc } from '../helpers/signed-release.js';

/** The backup ids whose manifest.json was read (the report's reads must stay cheap). */
const manifestReads = vi.hoisted((): string[] => []);
vi.mock('../../src/backup/manifest.js', async (importOriginal) => {
  const actual = await importOriginal<typeof import('../../src/backup/manifest.js')>();
  const readManifest: typeof actual.readManifest = async (dir, id) => {
    manifestReads.push(id);
    return actual.readManifest(dir, id);
  };
  return { ...actual, readManifest };
});

// The §11 report (plan Task 23, A9) on the engine picked by ALTIS_TEST_DB: every item, from cheap reads (settings the
// daily jobs write, counts, the newest backup row, current.json); the usage job; the browser test's result as
// `system.probe` and its effect on `system.ip_trust`. 1d Task 29 (A9 "semua butir §11", preflight S13, B7): the edition
// (the community edition: no database read, no licence state), and the releases: pending, pinned, the bundled release
// and what became of it, the keyset store.

const ctx = testDbContext();
/** In the past: an audit row may not be dated ahead of the real clock. */
const NOW = Date.UTC(2026, 9, 27, 9, 0, 0);
const MIN = 60_000;
const silent: CoreLogger = { info() {}, warn() {}, error() {} };

/** The community edition as Diagnostik shows it. */
const COMMUNITY_VIEW = { edition: 'community', status: 'active' };

/** The report's keys, literally (A9: every §11 item). */
const REPORT_KEYS = [
  'release',
  'runtime',
  'queue',
  'backup',
  'edition',
  'database',
  'dataDir',
  'memory',
  'network',
  'wasm',
  'http',
  'audit',
  'clock',
  'exposure',
  'disk',
  // ---- Phase 2 (catalog): Task 3 (B2): null until Task 15 fills them ----
  'search',
  'oai',
].sort();

describe.skipIf(!ctx.available)(`the Diagnostik report [${engineLabel()}]`, () => {
  let h: TestDbHandle;
  let root: string;
  let dataDir: string;
  let appRoot: string;
  let edition: EditionService;
  const sessionKey = randomBytes(32);

  const options = (o: Partial<CollectOptions> = {}): CollectOptions => ({
    h,
    dataDir,
    appRoot,
    runtime: 'passenger',
    env: {},
    version: '0.1.0',
    appJsVersion: '0.1.0',
    transport: 'polling',
    hops: 1,
    sessionKey,
    now: NOW,
    edition,
    roots: DEV_ROOTS,
    refuseDevKids: false,
    ...o,
  });
  const set = (values: Parameters<typeof writeSettings>[1]) =>
    withTx(h, (trx) => writeSettings(trx, values, { keyring: [], now: NOW, actorId: null }));

  async function job(status: string, runAt: number, createdAt = runAt): Promise<void> {
    await h.db
      .insertInto('jobs')
      .values({
        id: newId(),
        type: 'test.slices',
        payload: '{}',
        secret_param: null,
        status,
        run_at: runAt,
        max_attempts: 5,
        unique_key: null,
        lock_token: null,
        locked_by: null,
        locked_until: null,
        progress_message: null,
        last_error: null,
        created_by: null,
        created_at: createdAt,
        updated_at: createdAt,
        finished_at: null,
      })
      .execute();
  }

  beforeAll(async () => {
    h = await testDb();
    root = await fsp.realpath(await fsp.mkdtemp(path.join(os.tmpdir(), 'altis-diagnostics-')));
    await runMigrations(h, { appVersion: '0.1.0', dataDir: path.join(root, 'mig'), migrations: PHASE1_MIGRATIONS });
  });

  afterAll(async () => {
    await h?.close();
    if (root !== undefined) await fsp.rm(root, { recursive: true, force: true });
  });

  beforeEach(async () => {
    dataDir = path.join(root, `data-${newId()}`);
    appRoot = path.join(root, `app-${newId()}`);
    await fsp.mkdir(path.join(dataDir, 'tmp'), { recursive: true });
    await fsp.mkdir(appRoot, { recursive: true });
    for (const table of ['jobs', 'backups', 'notifications', 'settings', 'license_state', 'releases_log', 'events'] as const) {
      await h.db.deleteFrom(table).execute();
    }
    edition = createCommunityEdition({ db: () => h, clock: () => NOW, log: silent });
  });

  it('a fresh installation: the exact key set, the community edition, nothing measured yet', async () => {
    const report = await collectDiagnostics(options());
    expect(Object.keys(report).sort()).toEqual(REPORT_KEYS);
    expect(report.edition).toEqual(COMMUNITY_VIEW);
    // The community edition keeps no licence state.
    expect(await h.db.selectFrom('license_state').select('install_id').execute()).toEqual([]);
    // Phase 2 (B2, Task 15): the search index's health, and OAI on without an admin e-mail (the spec's defaults).
    expect(report.search).toEqual(await searchHealth(h.db));
    expect(report.oai).toEqual({ enabled: true, adminEmailSet: false });
    expect(report.release).toEqual({
      version: '0.1.0',
      appJsVersion: '0.1.0',
      bootProtocol: 1,
      missing: [],
      unadopted: [],
      pending: null,
      pinned: null,
      bundled: null,
      keyset: { docs: 0, maxSeq: 0, full: false },
    });
    expect(report.runtime).toEqual({ runtime: 'passenger', transport: 'polling', runner: { mode: 'external', lastRuns: {} } });
    expect(report.queue).toEqual({ queued: 0, running: 0, dead: 0, oldestQueuedMs: null });
    expect(report.backup).toEqual({ last: null });
    expect(report.database).toMatchObject({ dialect: h.dialect, poolSize: h.poolSize, limits: h.limits });
    expect(report.database.version).not.toBe('');
    expect(report.database.fullText).toBe(!(await checkServer(h)).problems.includes('NO_FULLTEXT'));
    expect(report.dataDir).toBeNull();
    expect(report.memory.rssBytes).toBeGreaterThan(0);
    expect(report.memory.heapUsedBytes).toBeGreaterThan(0);
    expect(report.memory.totalBytes).toBe(os.totalmem());
    expect(report.memory.freeBytes).toBeGreaterThan(0);
    expect(report.network).toEqual({ ipTrust: 'ok', hops: 1, suggestedHops: null });
    expect(report.wasm).toEqual({ ok: true, hint: null });
    expect(report.http).toEqual({ methods: null, methodOverride: false, chunkBytes: null, probedAt: null });
    expect(report.audit).toEqual({ chain: null });
    expect(report.clock).toEqual({ anomaly: null });
    expect(report.exposure).toBeNull();
    expect(report.disk).toEqual({ lowAt: null });
  });

  // ---- Phase 2 (catalog): Task 15 (B2) ----
  it('the search block is searchHealth (a built index: ready, its build time); the OAI block follows its two settings', async () => {
    await h.db.deleteFrom('search_state').execute();
    await h.db.insertInto('search_state').values({ id: 1, status: 'ready', docs: 0, job_id: null, built_at: NOW - MIN }).execute();
    await set({ 'opac.oai.adminEmail': 'pustakawan@perpus.example.sch.id' });
    try {
      const report = await collectDiagnostics(options());
      expect(report.search).toMatchObject({ status: 'ready', builtAt: NOW - MIN, jobId: null });
      expect(report.search).toEqual(await searchHealth(h.db));
      expect(report.oai).toEqual({ enabled: true, adminEmailSet: true });
      await set({ 'opac.oai.enabled': false, 'opac.oai.adminEmail': '' });
      expect((await collectDiagnostics(options())).oai).toEqual({ enabled: false, adminEmailSet: false });
    } finally {
      await h.db.deleteFrom('search_state').execute();
    }
  });

  it('every item read from where its job or test left it', async () => {
    const headHash = 'a'.repeat(64);
    await set({
      'system.run.cron_cli': NOW - 3 * MIN,
      'system.run.piggyback': NOW - MIN,
      'system.ip_trust': 'spoofable',
      'system.probe': {
        at: NOW - 2 * MIN,
        polling: true,
        sse: false,
        methods: { put: true, patch: false, delete: true },
        chunkBytes: 1_048_576,
        xff: { spoofable: true, suggestedHops: 2 },
      },
      'system.exposure': { at: NOW - 5 * MIN, ok: false, url: 'https://perpus.example.test/altis-data/tmp/x' },
      'system.data_usage': { at: NOW - 6 * MIN, bytes: 123_456, files: 42, truncated: false },
      'audit.verified': { at: NOW - 7 * MIN, ok: false, head: 99, headHash, brokenAt: 57 },
      'system.clock_anomaly': { detectedAt: NOW - 8 * MIN, maxSeen: NOW + 3_600_000 },
    });
    await job('queued', NOW - 10 * MIN);
    await job('queued', NOW - 2 * MIN);
    await job('queued', NOW + 10 * MIN); // not due yet: it waits for its time, not for a runner
    await job('running', NOW - MIN);
    await job('dead', NOW - 60 * MIN);
    await job('succeeded', NOW - 60 * MIN);
    const older = newId();
    const newer = newId();
    for (const [id, status, at] of [
      [older, 'ok', NOW - 2 * 86_400_000],
      [newer, 'failed', NOW - 86_400_000],
    ] as const) {
      await h.db
        .insertInto('backups')
        .values({ id, kind: 'scheduled', size: null, sha256: null, schema_version: '0.1.0', app_version: '0.1.0', dialect: h.dialect, consistency: 'snapshot', status, created_at: at })
        .execute();
    }
    await withTx(h, (trx) =>
      notify(trx, { audience: { permission: 'system.diagnostics.read' }, type: 'disk.low', titleKey: 'notification.disk_low.title' }, NOW - 9 * MIN),
    );
    await withTx(h, (trx) =>
      notify(trx, { audience: { permission: 'system.diagnostics.read' }, type: 'disk.low', titleKey: 'notification.disk_low.title' }, NOW - 4 * MIN),
    );
    await withTx(h, (trx) =>
      notify(trx, { audience: { permission: 'system.backup.read' }, type: 'backup.done', titleKey: 'notification.backup_done.title', params: { name: 'x' } }, NOW),
    );

    manifestReads.length = 0;
    const report: DiagnosticsReport = await collectDiagnostics(options({ runtime: 'pm2', transport: 'sse', hops: 2 }));
    expect(manifestReads).toEqual([newer]); // the newest backup's manifest only, not every kept one's
    expect(report.runtime).toEqual({
      runtime: 'pm2',
      transport: 'sse',
      runner: { mode: 'worker', lastRuns: { cron_cli: NOW - 3 * MIN, piggyback: NOW - MIN } },
    });
    expect(report.queue).toEqual({ queued: 3, running: 1, dead: 1, oldestQueuedMs: 10 * MIN });
    expect(report.backup.last).toMatchObject({ id: newer, status: 'failed', kind: 'scheduled', createdAt: NOW - 86_400_000 });
    expect(report.dataDir).toEqual({ bytes: 123_456, files: 42, truncated: false, measuredAt: NOW - 6 * MIN });
    expect(report.network).toEqual({ ipTrust: 'spoofable', hops: 2, suggestedHops: 2 });
    expect(report.http).toEqual({
      methods: { put: true, patch: false, delete: true },
      methodOverride: true,
      chunkBytes: 1_048_576,
      probedAt: NOW - 2 * MIN,
    });
    expect(report.audit).toEqual({ chain: { ok: false, head: 99, brokenAt: 57, checkedAt: NOW - 7 * MIN } });
    expect(report.clock).toEqual({ anomaly: { detectedAt: NOW - 8 * MIN, maxSeen: NOW + 3_600_000 } });
    expect(report.exposure).toEqual({ ok: false, url: 'https://perpus.example.test/altis-data/tmp/x', checkedAt: NOW - 5 * MIN });
    // S25: the newest disk_low notification, whatever else was sent after it.
    expect(report.disk).toEqual({ lowAt: NOW - 4 * MIN });
  });

  it('releases: a version current.json names whose folder is gone is missing; a bundled one is not adopted', async () => {
    await fsp.mkdir(path.join(dataDir, 'releases'), { recursive: true });
    await fsp.mkdir(path.join(appRoot, 'bundled-release', '0.1.0'), { recursive: true });
    const state = {
      schema: 1,
      active: { version: '0.1.0', source: 'bundled' },
      previous: { version: '0.0.9', source: 'data' },
      pending: null,
      pendingSince: null,
      pinned: null,
    };
    await fsp.writeFile(path.join(dataDir, 'releases', 'current.json'), JSON.stringify(state));
    expect((await collectDiagnostics(options())).release).toMatchObject({ missing: ['0.0.9'], unadopted: ['0.1.0'] });
    // Adopted into DATA_DIR and the old one present again: nothing to report.
    await fsp.mkdir(path.join(dataDir, 'releases', '0.0.9'), { recursive: true });
    await fsp.mkdir(path.join(dataDir, 'releases', '0.1.0'), { recursive: true });
    await fsp.writeFile(path.join(dataDir, 'releases', 'current.json'), JSON.stringify({ ...state, active: { version: '0.1.0', source: 'data' } }));
    expect((await collectDiagnostics(options())).release).toMatchObject({ missing: [], unadopted: [] });
    // Without the app folder (an app built without one) a bundled release cannot be looked for: never "missing".
    await fsp.writeFile(path.join(dataDir, 'releases', 'current.json'), JSON.stringify(state));
    expect((await collectDiagnostics(options({ appRoot: undefined }))).release).toMatchObject({ missing: [], unadopted: ['0.1.0'] });
  });

  // ---- 1d Task 29 ------------------------------------------------------------------------------------------------
  describe('1d Task 29: the edition and the releases (A9 "semua butir §11")', () => {
    const writeCurrent = async (state: Record<string, unknown>): Promise<void> => {
      await fsp.mkdir(path.join(dataDir, 'releases'), { recursive: true });
      const full = { schema: 1, previous: null, pending: null, pendingSince: null, pinned: null, ...state };
      await fsp.writeFile(path.join(dataDir, 'releases', 'current.json'), JSON.stringify(full));
    };
    const bundledBeside = async (version: string): Promise<void> => {
      await fsp.mkdir(path.join(appRoot, 'bundled-release', version), { recursive: true });
    };

    it('every §11 item: the edition; pending; the older bundled release ignored; the keyset store', async () => {
      await writeCurrent({ active: { version: '0.1.0', source: 'data' }, pending: { version: '0.2.0', source: 'data' }, pendingSince: NOW - MIN });
      await fsp.mkdir(path.join(dataDir, 'releases', '0.1.0'), { recursive: true });
      await bundledBeside('0.0.9');
      const store = [...DEV_KEYSET, rootDoc({ seq: 7, revokedKids: ['dev-rel-2'] })];
      await fsp.writeFile(path.join(dataDir, 'releases', 'keyset.json'), JSON.stringify(store));

      const report = await collectDiagnostics(options({ appJsVersion: '0.0.9' }));
      expect(report.edition).toEqual(COMMUNITY_VIEW);
      // The pending folder is not there yet: missing, as 1c reports a folder current.json names.
      expect(report.release).toMatchObject({ pending: '0.2.0', pinned: null, unadopted: [] });
      expect(report.release.bundled).toEqual({ version: '0.0.9', relation: 'older', note: 'ignored' });
      expect(report.release.keyset).toEqual({ docs: store.length, maxSeq: 7, full: false });

      // The writer refused documents (R65c): full. Without the roots no document verifies: maxSeq 0.
      await set({ 'system.keyset_full': { at: NOW, refused: 3 } });
      expect((await collectDiagnostics(options())).release.keyset).toEqual({ docs: store.length, maxSeq: 7, full: true });
      expect((await collectDiagnostics(options({ roots: [] }))).release.keyset).toEqual({ docs: store.length, maxSeq: 0, full: true });
      // A store that cannot be read counts no document (the boot and the update steps report it; Diagnostik reads only).
      await fsp.writeFile(path.join(dataDir, 'releases', 'keyset.json'), 'nicht json');
      expect((await collectDiagnostics(options())).release.keyset).toEqual({ docs: 0, maxSeq: 0, full: true });
    });

    it('the edition seam: the check of the edition given is shown as plain data, its entitlement left out', async () => {
      const fake: EditionCheck = { edition: 'fake', status: 'limited', notEntitled: () => 'released_after' };
      let reads = 0;
      const report = await collectDiagnostics(
        options({
          edition: {
            check: async () => {
              reads += 1;
              return fake;
            },
          },
        }),
      );
      expect(report.edition).toEqual({ edition: 'fake', status: 'limited' });
      expect(Object.keys(report.edition).sort()).toEqual(['edition', 'status']);
      expect(reads).toBe(1);
    });

    it('pinned; a newer bundled release offered, blocked, ignored in image mode, pinned; the same one ignored; none → null', async () => {
      await writeCurrent({ active: { version: '0.1.0', source: 'data' }, previous: { version: '0.0.9', source: 'data' } });
      await bundledBeside('0.2.0');
      const bundled = async (o: Partial<CollectOptions> = {}) => (await collectDiagnostics(options({ appJsVersion: '0.2.0', ...o }))).release.bundled;
      expect(await bundled()).toEqual({ version: '0.2.0', relation: 'newer', note: 'offered' });
      await set({ 'update.bundled_blocked': { version: '0.2.0', at: NOW, failures: ['min_node'] } });
      expect(await bundled()).toEqual({ version: '0.2.0', relation: 'newer', note: 'blocked' });
      await set({ 'update.bundled_blocked': null });
      expect(await bundled({ env: { ALTIS_RELEASE_SOURCE: 'image' } })).toEqual({ version: '0.2.0', relation: 'newer', note: 'ignored' });
      await writeCurrent({ active: { version: '0.1.0', source: 'data' }, pinned: '0.2.0' });
      expect((await collectDiagnostics(options({ appJsVersion: '0.2.0' }))).release).toMatchObject({
        pinned: '0.2.0',
        bundled: { version: '0.2.0', relation: 'newer', note: 'pinned' },
      });
      // The same version as active (a fresh install runs its own bundled release): ignored.
      await writeCurrent({ active: { version: '0.2.0', source: 'bundled' } });
      expect(await bundled()).toEqual({ version: '0.2.0', relation: 'same', note: 'ignored' });
      // No folder of app.js's version, no app.js version, no app folder: no bundled release.
      expect(await bundled({ appJsVersion: '0.3.0' })).toBeNull();
      expect(await bundled({ appJsVersion: null })).toBeNull();
      expect(await bundled({ appRoot: undefined })).toBeNull();
    });

    it('B7: after a failed bundled update (the rolled_back row the Task 27 op writes) → failed_before; a pin wins over it', async () => {
      await writeCurrent({ active: { version: '0.1.0', source: 'data' } });
      await bundledBeside('0.2.0');
      // What the bundled update op leaves when it fails past its point of no return and reverts: its releases_log row
      // (by op id, inserted at `verified`, B7) that finishUpdate set `rolled_back`. apps/server's bundled-newer test runs
      // the real flow.
      const opId = newId(NOW - 10 * MIN);
      await withTx(h, (trx) => insertReleaseLog(trx, { id: opId, version: '0.2.0', action: 'update', fromVersion: '0.1.0', startedAt: NOW - 10 * MIN, backupId: null }));
      await withTx(h, (trx) => setReleaseLogStatus(trx, opId, 'rolled_back', { finishedAt: NOW - 5 * MIN }));
      const bundled = async () => (await collectDiagnostics(options({ appJsVersion: '0.2.0' }))).release.bundled;
      expect(await bundled()).toEqual({ version: '0.2.0', relation: 'newer', note: 'failed_before' });
      await writeCurrent({ active: { version: '0.1.0', source: 'data' }, pinned: '0.2.0' });
      expect((await bundled())?.note).toBe('pinned'); // bundledUpdatePlan: a pin wins over a failure (D1d-24)
    });
  });

  it('fullTextCapability: what checkServer says about full-text search', async () => {
    expect(await fullTextCapability(h)).toBe(!(await checkServer(h)).problems.includes('NO_FULLTEXT'));
  });

  it('the usage job: DATA_DIR bytes and files into system.data_usage, in one slice', async () => {
    await fsp.writeFile(path.join(dataDir, 'tmp', 'a.bin'), Buffer.alloc(1000));
    await fsp.mkdir(path.join(dataDir, 'logs'), { recursive: true });
    await fsp.writeFile(path.join(dataDir, 'logs', 'altis.log'), Buffer.alloc(24));
    const usage = usageJob({ dataDir });
    expect(usage.type).toBe('diagnostics.usage');
    expect(usage.permission).toBe('system.diagnostics.read');
    const jobCtx: JobContext = {
      jobId: newId(),
      mode: 'worker',
      heartbeat: async () => {},
      cancelled: () => false,
      markPointOfNoReturn: async () => {},
      secretParam: async () => null,
      audit: async () => {},
      session: async () => {
        throw new Error('no session in this test');
      },
      db: h.db,
      handle: h,
      log: silent,
      now: () => NOW,
      budgetLeftMs: () => 20_000,
    };
    expect(await usage.run(jobCtx, { windowStart: NOW - 86_400_000, windowEnd: NOW })).toEqual({ done: true });
    const stored = (await readSettings(h.db, ['system.data_usage'], []))['system.data_usage'];
    expect(stored).toEqual({ at: NOW, bytes: 1024, files: 2, truncated: false });
    expect((await collectDiagnostics(options())).dataDir).toEqual({ bytes: 1024, files: 2, truncated: false, measuredAt: NOW });
  });

  describe('recordProbeResult (the browser test)', () => {
    const result = (o: { forgedDerived: string; sse?: boolean }) => ({
      polling: true,
      sse: o.sse ?? true,
      methods: { put: true, patch: true, delete: false },
      chunkBytes: 5_242_880,
      xff: { cleanXff: ['198.51.100.7'], forgedXff: ['203.0.113.77', '198.51.100.7'], forgedDerived: o.forgedDerived },
    });
    const record = (body: ReturnType<typeof result>, now = NOW) => withTx(h, (trx) => recordProbeResult(trx, body, { now, actorId: null }));
    const trust = async () => (await readSettings(h.db, ['system.ip_trust'], []))['system.ip_trust'];

    it('spoofable → system.ip_trust spoofable and system.probe stored; then a clean result → ok', async () => {
      expect(await record(result({ forgedDerived: '203.0.113.77' }))).toEqual({
        ipTrust: 'spoofable',
        spoofable: true,
        suggestedHops: 1,
        methodsBlocked: ['delete'],
      });
      expect(await trust()).toBe('spoofable');
      expect((await readSettings(h.db, ['system.probe'], []))['system.probe']).toEqual({
        at: NOW,
        polling: true,
        sse: true,
        methods: { put: true, patch: true, delete: false },
        chunkBytes: 5_242_880,
        xff: { spoofable: true, suggestedHops: 1 },
      });
      expect((await record(result({ forgedDerived: '198.51.100.7' }), NOW + MIN)).ipTrust).toBe('ok');
      expect(await trust()).toBe('ok');
    });

    it('a clean result leaves collapsed as it is (only the sessions job clears it)', async () => {
      await set({ 'system.ip_trust': 'collapsed' });
      expect((await record(result({ forgedDerived: '198.51.100.7' }))).ipTrust).toBe('collapsed');
      expect(await trust()).toBe('collapsed');
    });
  });
});
