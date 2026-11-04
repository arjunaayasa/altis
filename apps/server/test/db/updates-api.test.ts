import fsp from 'node:fs/promises';
import os from 'node:os';
import path from 'node:path';
import {
  COMMUNITY_EDITION,
  createOpsMachine,
  createUpdateSource,
  insertReleaseLog,
  notify,
  readOpFile,
  snapshotBackupRunning,
  writeSettings,
  type OpFile,
  type OpsMachine,
  type StoredUpdateCheck,
  type UpdateKindDeps,
  type UpdateSource,
} from '@altis/core';
import { jakartaDate, type FeedEntry } from '@altis/crypto/feed';
import { PHASE1_MIGRATIONS, connect, runMigrations, withTx } from '@altis/db';
import { readCurrentState, updateCurrentState, type Env, type Runtime } from '@altis/platform';
import { newId } from '@altis/shared';
import type { EventsResponse } from '@altis/shared/api/events';
import type { OpView } from '@altis/shared/api/ops';
import type { UpdateHistoryResponse, UpdateStatusView, UpdateUploadDryRun, UpdatesView } from '@altis/shared/api/updates';
import { afterAll, afterEach, beforeAll, beforeEach, describe, expect, it, vi } from 'vitest';
import { engineLabel, testDb, testDbContext, type TestDbHandle } from '../../../../tools/test/test-db.js';
import { createApp, type AppState } from '../../src/app.js';
import type { Config } from '../../src/config.js';
import { csrfKey } from '../../src/http/csrf.js';
import { createOpsFence } from '../../src/http/ops-fence.js';
import { createJobRuntime, jobHandlers, opKinds, type JobRuntime } from '../../src/jobs/runtime.js';
import { appPrecheck } from '../../src/services.js';
import { createAgent, type Agent, type AgentReply } from '../agent.js';
import { seedStaff, sessionCookieFor, sessionCsrfFor } from '../support-auth.js';
import { recordingLogger, sampleConfig } from '../support.js';
import { DEV_ROOTS, devPackageKeys, feedEntryOf, publishFeed, releasePackage, stagedUpdateUpload, startFeedDev, type FeedDev } from '../update-support.js';

// The updates API (spec §9.6-9.8, §13.5 "Update"; plan Task 28; decisions D1d-30, D1d-31; preflight B5, S20, 1D-12,
// 1D-23; acceptance A7, A8, A9) on the engine picked by ALTIS_TEST_DB: an installation running 0.1.0-test whose feed
// (feed-dev, signed with the dev keys) offers 0.2.0-test. The app is built as start() builds it on passenger (external
// runner mode: the check is driven in its request), with the update kind over the dev root (a server.mjs that the
// release build did not bundle embeds no root keys) and the community edition. The clock stands in
// the past (an audit row may not be dated ahead of the real clock) except where an event must have settled.

vi.mock('@altis/platform', async (importOriginal) => {
  const actual = await importOriginal<typeof import('@altis/platform')>();
  // A real probe writes up to 64 MiB per DATA_DIR; the headroom asked for is not what these tests are about.
  return { ...actual, ensureHeadroom: async () => {} };
});

const ctx = testDbContext();
const ACTIVE = '0.1.0-test';
const TARGET = '0.2.0-test';
const MIN = 60_000;
const SID = '__Host-altis_sid';
const OPS_COOKIE = '__Host-altis_ops';
const UPDATES = '/api/v1/updates';
const DAY = 86_400_000;

const code = (res: AgentReply): string | undefined => (res.json as { code?: string } | undefined)?.code;
const reason = (res: AgentReply): string | undefined => (res.json as { reason?: string } | undefined)?.reason;

describe.skipIf(!ctx.available)(`updates API [${engineLabel()}]`, () => {
  let h: TestDbHandle;
  let root: string;
  let CONFIG: Config;
  let ORIGIN: string;
  let admin: string;
  let reader: string;
  let dataDir: string;
  let feedDir: string;
  let dev: FeedDev | undefined;
  let entry: FeedEntry;
  let now: number;
  let state: AppState;
  let ops: OpsMachine | undefined;
  let runtime: JobRuntime | undefined;
  let app: ReturnType<typeof createApp>;
  let source: UpdateSource;
  let restarts: string[];
  /** The last audit seq before the test: each test reads its own entries (audit_log is never emptied). */
  let seq0: number;

  beforeAll(async () => {
    h = await testDb();
    CONFIG = sampleConfig({ db: h.config });
    ORIGIN = new URL(CONFIG.baseUrl).origin;
    root = await fsp.realpath(await fsp.mkdtemp(path.join(os.tmpdir(), 'altis-updates-api-')));
    await runMigrations(h, { appVersion: ACTIVE, dataDir: path.join(root, 'mig'), migrations: PHASE1_MIGRATIONS });
    admin = (await seedStaff(h, { username: 'kepala', roles: [{ key: 'super_admin' }] })).id;
    reader = (await seedStaff(h, { username: 'pembaca', roles: [{ permissions: ['system.update.read'] }] })).id;
  }, 60_000);

  afterAll(async () => {
    await h?.close();
    if (root !== undefined) await fsp.rm(root, { recursive: true, force: true });
  });

  beforeEach(async () => {
    const tables = ['jobs', 'locks', 'events', 'notifications', 'sessions', 'schedules', 'releases_log', 'backups', 'upload_sessions'] as const;
    for (const table of tables) await h.db.deleteFrom(table).execute();
    await h.db.deleteFrom('settings').where('key', 'like', 'update.%').execute();
    const base = await fsp.mkdtemp(path.join(root, 'case-'));
    dataDir = path.join(base, 'data');
    feedDir = path.join(base, 'feed');
    await fsp.mkdir(dataDir, { recursive: true });
    await fsp.mkdir(path.join(feedDir, 'packages'), { recursive: true });
    await readCurrentState(dataDir, ACTIVE); // current.json: active 0.1.0-test (bundled)
    now = Date.now() - 20 * MIN;
    restarts = [];
    seq0 = Number((await h.db.selectFrom('audit_head').select('last_seq').where('id', '=', 1).executeTakeFirstOrThrow()).last_seq);
    dev = await startFeedDev({ dir: feedDir });
    const pkg = await releasePackage();
    await fsp.writeFile(path.join(feedDir, 'packages', `altis-${TARGET}.zip`), pkg.zip);
    entry = feedEntryOf(pkg.zip, pkg.manifest, `${dev.url}/packages/altis-${TARGET}.zip`);
    await publishFeed(feedDir, 'stable', 5, [entry]);
  });

  afterEach(async () => {
    await runtime?.stop();
    runtime = undefined;
    await ops?.close();
    ops = undefined;
    await dev?.close();
    dev = undefined;
  });

  /**
   * The app as start() builds it on `o.runtime` (default passenger: external mode, no worker loop), with its job runtime;
   * `o.feed` false: no feed URL at all (a build without `--feed-url`). Returns the app's logger.
   */
  function build(o: { env?: Env; runtime?: Runtime; feed?: boolean } = {}): ReturnType<typeof recordingLogger> {
    const rt = o.runtime ?? 'passenger';
    const env = o.env ?? {};
    const log = recordingLogger();
    state = { phase: 'ready', db: h, config: CONFIG };
    const feed = o.feed === false ? undefined : dev;
    source = createUpdateSource({
      feedBase: () => feed?.url ?? null,
      dataDir,
      roots: DEV_ROOTS,
      sources: async () => [],
      refuseDevKids: false,
      allowLoopbackHttp: true,
      clock: () => now,
      log,
      persistKeysets: async () => {},
      onSignedTime: async () => {},
      env,
    });
    const deps = (): UpdateKindDeps => ({
      dataDir,
      appRoot: '',
      appVersion: ACTIVE,
      source,
      precheck: (c) => appPrecheck({ dataDir, h, edition: { check: async () => COMMUNITY_EDITION }, version: ACTIVE }, c),
      roots: DEV_ROOTS,
      sources: async () => [],
      refuseDevKids: false,
      backup: { dataDir, installId: CONFIG.install.id, appVersion: ACTIVE, sessionKey: csrfKey(CONFIG), kids: CONFIG.keyring.map((k) => k.kid) },
      migrations: PHASE1_MIGRATIONS,
      restore: null,
      requestRestart: async (why) => {
        restarts.push(why);
      },
      boot: () => null,
      snapshotBackupRunning: () => snapshotBackupRunning(h, Date.now()),
      notify,
      log,
    });
    // createAppOps's machine, except that its dedicated connection opens the test database.
    ops = createOpsMachine({
      dataDir,
      kinds: opKinds({ appVersion: ACTIVE, config: () => state.config, update: deps }),
      db: () => h,
      connect: () => connect(h.config, { runtime: 'standalone', purpose: 'cli', dataDir: h.dataDir }),
      keyring: () => CONFIG.keyring,
      clock: () => now,
      log,
      snapshotBackupRunning: () => snapshotBackupRunning(h, Date.now()),
      appVersion: ACTIVE,
    });
    runtime = createJobRuntime({
      state,
      runtime: rt,
      env,
      dataDir,
      log,
      clock: () => now,
      ops,
      handlers: jobHandlers({ updateCheck: { source: () => source } }),
      requestRestart: async () => {},
      installId: CONFIG.install.id,
      appVersion: ACTIVE,
    });
    state.jobs = runtime;
    const opsFence = createOpsFence({ dataDir, intervalMs: 0, clock: () => now, onEpoch() {}, onOpEnded() {} });
    app = createApp({
      state,
      version: ACTIVE,
      buildId: 'b',
      log,
      clock: () => now,
      env,
      dataDir,
      runtime: rt,
      services: { ops, opsFence, updates: { source, packageKeys: devPackageKeys } },
    });
    return log;
  }

  /** A browser signed in as `userId`, re-authenticated now unless `reauth` is false. */
  async function browser(userId: string, o: { reauth?: boolean } = {}): Promise<{ agent: Agent; csrf: Record<string, string> }> {
    const token = await sessionCookieFor(h, userId, { now, reauthAt: o.reauth === false ? null : now });
    const agent = createAgent(app, { headers: { origin: ORIGIN } });
    agent.setCookie(SID, token);
    return { agent, csrf: { 'x-csrf-token': sessionCsrfFor(CONFIG, token) } };
  }

  /** `update.check` as a check that found `available` would have stored it (its feed fresh for 7 days by default). */
  async function seedCheck(available: FeedEntry | null, o: { expiresAt?: number | null } = {}): Promise<void> {
    const expiresAt = o.expiresAt === undefined ? now + 7 * 24 * 60 * MIN : o.expiresAt;
    const check: StoredUpdateCheck = { at: now - 10 * MIN, ok: true, error: null, seq: 5, available, latest: available?.version ?? null, steppingStone: false, expiresAt };
    await withTx(h, (trx) => writeSettings(trx, { 'update.check': check }, { keyring: [], now, actorId: null }));
  }

  const opJson = async (): Promise<OpFile | null> => {
    const op = await readOpFile(dataDir);
    if (op === 'corrupt') throw new Error('op.json is corrupt');
    return op;
  };
  const auditOf = async (action: string) =>
    (
      await h.db
        .selectFrom('audit_log')
        .select(['entity', 'entity_id', 'actor_id', 'meta'])
        .where('action', '=', action)
        .where('seq', '>', seq0)
        .orderBy('seq')
        .execute()
    ).map((r) => ({
      ...r,
      meta: JSON.parse(r.meta) as Record<string, unknown>,
    }));
  const uploadRows = () => h.db.selectFrom('upload_sessions').select('id').execute();

  /**
   * `POST updates/check` as `agent`, then the end of its job: the request drives it, unless a piggyback slice after an
   * earlier response claimed it first (external mode), which then runs it right after.
   */
  async function checkNow(agent: Agent, csrf: Record<string, string>): Promise<{ res: AgentReply; jobId: string }> {
    const res = await agent.post(`${UPDATES}/check`, undefined, csrf);
    expect(res.status, res.text).toBe(202);
    const jobId = (res.json as { jobId: string }).jobId;
    for (let i = 0; i < 300; i += 1) {
      const job = await h.db.selectFrom('jobs').select('status').where('id', '=', jobId).executeTakeFirstOrThrow();
      if (job.status === 'succeeded') return { res, jobId };
      await new Promise((resolve) => setTimeout(resolve, 50));
    }
    throw new Error(`the update check ${jobId} did not end`);
  }
  const exists = (file: string): Promise<boolean> =>
    fsp.stat(file).then(
      () => true,
      () => false,
    );

  it('POST updates/check → 202; after the drive slice GET updates offers 0.2.0-test with precheck.ok; again within 60 s → 429', async () => {
    build();
    const { agent, csrf } = await browser(reader);
    const { jobId } = await checkNow(agent, csrf);
    // External mode: the request drove the job to its end.
    expect(await h.db.selectFrom('jobs').select(['type', 'status', 'payload', 'created_by']).where('id', '=', jobId).executeTakeFirstOrThrow()).toEqual({
      type: 'update.check',
      status: 'succeeded',
      payload: JSON.stringify({ reason: 'manual' }),
      created_by: reader,
    });
    expect(dev!.requests.map((r) => r.path)).toContain('/stable/feed.json');

    const got = await agent.get(UPDATES);
    expect(got.status, got.text).toBe(200);
    expect(got.headers.get('cache-control')).toBe('no-store');
    const view = got.json as UpdatesView;
    expect(view).toEqual({
      current: { version: ACTIVE, appJs: null, bootProtocol: 1 },
      channel: 'stable',
      check: { at: now, ok: true, error: null },
      available: { version: TARGET, releasedAt: '2026-10-20', notesUrl: null, steppingStone: false, latest: TARGET },
      precheck: {
        ok: true,
        failures: [],
        dbRestoreNeeded: false,
        estimateMs: expect.any(Number),
        headroomBytes: expect.any(Number),
        steppingStone: false,
        candidate: { version: TARGET, bootProtocol: 1, minUpgradeFrom: '0.0.0' },
        notEntitled: null,
      },
      rollback: { available: false, reason: 'no_previous', target: null },
      pinned: null,
      oneClick: true,
      dockerPull: false,
      onlineCheck: true,
      op: null,
      bundledBlocked: null,
    });
    // The check notified the holders of system.update.read once.
    expect(await h.db.selectFrom('notifications').select(['type', 'audience_permission']).where('type', 'like', 'update.%').execute()).toEqual([
      { type: 'update.available', audience_permission: 'system.update.read' },
    ]);

    const again = await agent.post(`${UPDATES}/check`, undefined, csrf);
    expect(again.status, again.text).toBe(429);
    expect(code(again)).toBe('UPDATE_CHECK_THROTTLED');
    expect(again.headers.get('retry-after')).toBe('60');
    now += 45_000;
    expect((await agent.post(`${UPDATES}/check`, undefined, csrf)).headers.get('retry-after')).toBe('15');
    now += 16_000;
    await checkNow(agent, csrf);
    expect(await h.db.selectFrom('jobs').select('id').where('type', '=', 'update.check').execute()).toHaveLength(2);
  });

  it('POST updates/apply: 401 without reauth; 200 {opId} + altis_ops with the op in checking; again → 409 OPS_IN_PROGRESS', async () => {
    build();
    await seedCheck(entry);
    const stale = await browser(admin, { reauth: false });
    const unauth = await stale.agent.post(`${UPDATES}/apply`, { version: TARGET }, stale.csrf);
    expect(unauth.status, unauth.text).toBe(401);
    expect(code(unauth)).toBe('AUTH_REAUTH_REQUIRED');
    const readerBrowser = await browser(reader);
    expect((await readerBrowser.agent.post(`${UPDATES}/apply`, { version: TARGET }, readerBrowser.csrf)).status).toBe(403);
    expect(await opJson()).toBeNull();

    const { agent, csrf } = await browser(admin);
    const other = await agent.post(`${UPDATES}/apply`, { version: '0.3.0-test' }, csrf);
    expect(other.status, other.text).toBe(404);
    expect(code(other)).toBe('UPDATE_NONE');
    expect((await agent.post(`${UPDATES}/apply`, { version: 'v0.2.0' }, csrf)).status).toBe(422);

    const res = await agent.post(`${UPDATES}/apply`, { version: TARGET }, csrf);
    expect(res.status, res.text).toBe(200);
    const { opId } = res.json as { opId: string };
    expect(res.headers.getSetCookie().some((c) => c.startsWith(`${OPS_COOKIE}=`))).toBe(true);
    expect(agent.cookies.get(OPS_COOKIE)).toEqual(expect.any(String));
    expect(await opJson()).toMatchObject({
      opId,
      kind: 'update',
      state: 'checking',
      actor: { type: 'staff', id: admin },
      params: { source: 'feed', target: TARGET, from: ACTIVE, entry, staging: null, needsBackup: null },
    });
    // No audit entry of the route: the op writes `update.apply` when it ends (C25).
    expect(await auditOf('update.apply')).toEqual([]);

    const again = await agent.post(`${UPDATES}/apply`, { version: TARGET }, csrf);
    expect(again.status, again.text).toBe(409);
    expect(code(again)).toBe('OPS_IN_PROGRESS');
  });

  it('review C07 (§9.6 "sudah kedaluwarsa ditolak"): an entry whose feed has expired is neither offered nor applied (404 UPDATE_NONE)', async () => {
    build();
    await seedCheck(entry, { expiresAt: now - 1 });
    const { agent, csrf } = await browser(admin);
    const view = (await agent.get(UPDATES)).json as UpdatesView;
    expect(view).toMatchObject({ check: { ok: true, error: null }, available: null, precheck: null });
    const res = await agent.post(`${UPDATES}/apply`, { version: TARGET }, csrf);
    expect(res.status, res.text).toBe(404);
    expect(code(res)).toBe('UPDATE_NONE');
    expect(await opJson()).toBeNull();
    // A check stored without the feed's expiry offers nothing either, until a new check stores it.
    await seedCheck(entry, { expiresAt: null });
    expect(((await agent.get(UPDATES)).json as UpdatesView).available).toBeNull();
    expect(code(await agent.post(`${UPDATES}/apply`, { version: TARGET }, csrf))).toBe('UPDATE_NONE');
    // Up to and including its expiresAt the entry is offered.
    await seedCheck(entry, { expiresAt: now });
    expect(((await agent.get(UPDATES)).json as UpdatesView).available).toMatchObject({ version: TARGET });
  });

  it('review L10: GET updates shows a blocked bundled release only while it is newer than the running one', async () => {
    build();
    const { agent } = await browser(reader);
    const blockedAs = async (version: string) => {
      await withTx(h, (trx) =>
        writeSettings(trx, { 'update.bundled_blocked': { version, at: now, failures: ['entitlement'] } }, { keyring: [], now, actorId: null }),
      );
      return ((await agent.get(UPDATES)).json as UpdatesView).bundledBlocked;
    };
    expect(await blockedAs(TARGET)).toEqual({ version: TARGET, failures: ['entitlement'] });
    // Installed since another way (one click, an offline upload): the record stays, the notice does not.
    expect(await blockedAs(ACTIVE)).toBeNull();
    expect(await blockedAs('0.0.9-test')).toBeNull();
  });

  it('A9 polling: during the pre_update backup GET events?channels=system.update returns rising op.progress hints', async () => {
    build();
    await seedCheck(entry);
    const { agent, csrf } = await browser(admin);
    const { opId } = (await agent.post(`${UPDATES}/apply`, { version: TARGET }, csrf)).json as { opId: string };
    // checking → downloading → verified (the package from feed-dev, verified and extracted), then the flag and the freeze.
    expect(await ops!.step(20_000)).toMatchObject({ opId, state: 'verified' });
    await ops!.step(20_000);
    now += 4000;
    let status = await ops!.step(1);
    for (let i = 0; i < 5 && status?.state !== 'frozen'; i += 1) status = await ops!.step(1);
    expect(status).toMatchObject({ state: 'frozen' });
    // The page's first poll: the cursor of now.
    const first = await agent.get('/api/v1/events?channels=system.update');
    expect(first.status, first.text).toBe(200);
    const cursor = (first.json as EventsResponse).cursor;

    // The export, one part per step, until a few hints went out (the backup is still running).
    const hints = () =>
      h.db.selectFrom('events').select('payload').where('channel', '=', 'system.update').where('type', '=', 'op.progress').execute();
    for (let i = 0; i < 200 && status?.state === 'frozen'; i += 1) {
      const frozenHints = (await hints()).filter((e) => (JSON.parse(e.payload) as { state: string }).state === 'frozen');
      if (frozenHints.length >= 3) break;
      status = await ops!.step(1);
    }
    expect(status).toMatchObject({ state: 'frozen' });
    expect((await opJson())?.params).toMatchObject({ needsBackup: true, export: expect.any(Object) });

    // The next poll, once the hints have settled (2 s).
    now = Date.now() + 3000;
    const next = await agent.get(`/api/v1/events?channels=system.update&cursor=${encodeURIComponent(cursor)}`);
    expect(next.status, next.text).toBe(200);
    const progress = (next.json as EventsResponse).events
      .filter((e) => e.type === 'op.progress' && e.payload['state'] === 'frozen')
      .map((e) => {
        expect(e.payload).toMatchObject({ opId, kind: 'update' });
        return e.payload['progress'] as number;
      });
    expect(progress.length).toBeGreaterThanOrEqual(2);
    for (let i = 1; i < progress.length; i += 1) expect(progress[i]!).toBeGreaterThanOrEqual(progress[i - 1]!);
    expect(progress.at(-1)!).toBeGreaterThan(progress[0]!);
    for (const p of progress) expect(p).toBeGreaterThanOrEqual(45);
  });

  it('POST updates/upload: a dry run checks the staged package and keeps the upload; the real call begins the op (B5)', async () => {
    build();
    const pkg = await releasePackage();
    const uploadId = await stagedUpdateUpload({ h, dataDir, now }, admin, pkg.zip);
    const { agent, csrf } = await browser(admin);

    const dry = await agent.post(`${UPDATES}/upload`, { uploadId, dryRun: true }, csrf);
    expect(dry.status, dry.text).toBe(200);
    expect(dry.json as UpdateUploadDryRun).toEqual({
      version: TARGET,
      releasedAt: '2026-10-20',
      precheck: expect.objectContaining({ ok: true, failures: [], candidate: { version: TARGET, bootProtocol: 1, minUpgradeFrom: '0.0.0' } }),
    });
    expect(await opJson()).toBeNull();
    expect(await uploadRows()).toEqual([{ id: uploadId }]);
    expect(await auditOf('update.upload')).toEqual([
      expect.objectContaining({ entity: 'upload_sessions', entity_id: uploadId, actor_id: admin, meta: { uploadId, version: TARGET, dryRun: true, ok: true } }),
    ]);

    // The same upload, for real.
    const res = await agent.post(`${UPDATES}/upload`, { uploadId }, csrf);
    expect(res.status, res.text).toBe(200);
    const { opId } = res.json as { opId: string };
    expect(agent.cookies.get(OPS_COOKIE)).toEqual(expect.any(String));
    // Review L11: whose upload it is goes with the op (a takeover changes who follows it, not whose upload it takes).
    expect(await opJson()).toMatchObject({ opId, kind: 'update', state: 'checking', params: { source: 'upload', uploadId, uploadBy: admin, target: TARGET, from: ACTIVE, entry: null } });
    expect(await uploadRows()).toEqual([{ id: uploadId }]); // the op's `checking` step takes it
    const audits = await auditOf('update.upload');
    expect(audits).toHaveLength(2);
    expect(audits[1]).toMatchObject({ entity: 'releases_log', entity_id: opId, meta: { uploadId, version: TARGET, dryRun: false, ok: true } });

    // One step: `checking` takes the upload into the staging folder, verifies it and runs the prechecks → downloading.
    expect(await ops!.step(1)).toMatchObject({ opId, state: 'downloading' });
    expect(await uploadRows()).toEqual([]);
    expect(await exists(path.join(dataDir, 'releases', `.tmp-${TARGET}-${opId}`, 'package.zip'))).toBe(true);
    // Another staff user's upload, or one taken already, is not this caller's.
    expect(code(await agent.post(`${UPDATES}/upload`, { uploadId, dryRun: true }, csrf))).toBe('NOT_FOUND');
  });

  it('A7 "typ salah": a package whose manifest.sig is typed altis-license/1 → 422 UPDATE_PACKAGE_INVALID reason signature', async () => {
    build();
    const bad = await releasePackage({ typ: 'altis-license/1' });
    const uploadId = await stagedUpdateUpload({ h, dataDir, now }, admin, bad.zip);
    const { agent, csrf } = await browser(admin);
    for (const dryRun of [true, false]) {
      const res = await agent.post(`${UPDATES}/upload`, { uploadId, dryRun }, csrf);
      expect(res.status, res.text).toBe(422);
      expect(code(res)).toBe('UPDATE_PACKAGE_INVALID');
      expect(reason(res)).toBe('signature');
    }
    // A key the installation does not trust for releases (dev-lic-1, of the reserved `license` key use) is refused too.
    const foreign = await releasePackage({ signer: 'dev-lic-1' });
    const other = await stagedUpdateUpload({ h, dataDir, now }, admin, foreign.zip);
    const res = await agent.post(`${UPDATES}/upload`, { uploadId: other, dryRun: true }, csrf);
    expect([res.status, code(res), reason(res)]).toEqual([422, 'UPDATE_PACKAGE_INVALID', 'signature']);
    expect(await opJson()).toBeNull();
    expect(await auditOf('update.upload')).toEqual([]);
    expect(await uploadRows()).toHaveLength(2);
  });

  it('PUT updates/channel beta → the setting, one update.channel entry, /beta/feed.json next; back to stable → its lower seq is accepted', async () => {
    build();
    const beta = { ...entry, version: '0.3.0-test', channel: 'beta' as const };
    await publishFeed(feedDir, 'beta', 10, [beta]);
    const { agent, csrf } = await browser(admin);
    const requested = (): string[] => dev!.requests.map((r) => r.path).filter((p) => p.endsWith('/feed.json'));

    await checkNow(agent, csrf);
    expect(requested()).toEqual(['/stable/feed.json']);

    const put = await agent.put(`${UPDATES}/channel`, { channel: 'beta' }, csrf);
    expect(put.status, put.text).toBe(200);
    expect(put.json).toEqual({ channel: 'beta' });
    expect((await h.db.selectFrom('settings').select('value').where('key', '=', 'update.channel').executeTakeFirstOrThrow()).value).toBe('"beta"');
    expect(await auditOf('update.channel')).toEqual([expect.objectContaining({ actor_id: admin, meta: { channel: 'beta', previous: 'stable' } })]);
    // The stable check's release belongs to the other channel, and so does the check itself (1d review L14): nothing
    // says beta was checked, and the stable check does not hold a beta check back for 60 s.
    expect((await agent.get(UPDATES)).json).toMatchObject({ channel: 'beta', check: null, available: null, precheck: null });

    await checkNow(agent, csrf);
    expect(requested()).toEqual(['/stable/feed.json', '/beta/feed.json']);
    expect((await agent.get(UPDATES)).json).toMatchObject({ check: { ok: true }, available: { version: '0.3.0-test' } });

    expect((await agent.put(`${UPDATES}/channel`, { channel: 'stable' }, csrf)).status).toBe(200);
    now += 61_000;
    await checkNow(agent, csrf);
    expect(requested()).toEqual(['/stable/feed.json', '/beta/feed.json', '/stable/feed.json']);
    // seq 5 on stable after seq 10 on beta: each channel keeps its own (1D-12).
    expect((await agent.get(UPDATES)).json).toMatchObject({ channel: 'stable', check: { ok: true, error: null }, available: { version: TARGET } });
    expect(await auditOf('update.channel')).toHaveLength(2);

    const readerBrowser = await browser(reader);
    expect((await readerBrowser.agent.put(`${UPDATES}/channel`, { channel: 'beta' }, readerBrowser.csrf)).status).toBe(403);
    expect((await agent.put(`${UPDATES}/channel`, { channel: 'nightly' }, csrf)).status).toBe(422);
  });

  it('GET updates/history: releases_log newest first, paged; updates/status with the op cookie alone; ops/current says X-Altis-Serving: server', async () => {
    build();
    const ids = [now - 3000, now - 2000, now - 1000].map((t) => newId(t));
    await withTx(h, async (trx) => {
      await insertReleaseLog(trx, { id: ids[0]!, version: '0.0.9-test', action: 'update', fromVersion: '0.0.8-test', startedAt: now - 3000, backupId: null });
      await insertReleaseLog(trx, { id: ids[1]!, version: '0.0.8-test', action: 'rollback', fromVersion: '0.0.9-test', startedAt: now - 2000, backupId: null });
      await insertReleaseLog(trx, { id: ids[2]!, version: ACTIVE, action: 'update', fromVersion: '0.0.8-test', startedAt: now - 1000, backupId: null });
    });
    await h.db.updateTable('releases_log').set({ status: 'done', finished_at: now - 500 }).where('id', '=', ids[2]!).execute();
    const { agent, csrf } = await browser(reader);
    const all = (await agent.get(`${UPDATES}/history`)).json as UpdateHistoryResponse;
    expect(all.items.map((i) => i.id)).toEqual([ids[2], ids[1], ids[0]]);
    expect(all.nextBefore).toBeNull();
    expect(all.items[0]).toEqual({ id: ids[2], version: ACTIVE, action: 'update', fromVersion: '0.0.8-test', status: 'done', startedAt: now - 1000, finishedAt: now - 500, backupId: null });
    const page = (await agent.get(`${UPDATES}/history?limit=2`)).json as UpdateHistoryResponse;
    expect([page.items.map((i) => i.id), page.nextBefore]).toEqual([[ids[2], ids[1]], ids[1]]);
    const rest = (await agent.get(`${UPDATES}/history?limit=2&before=${ids[1]!}`)).json as UpdateHistoryResponse;
    expect([rest.items.map((i) => i.id), rest.nextBefore]).toEqual([[ids[0]], null]);
    expect((await agent.get(`${UPDATES}/history?limit=0`)).status).toBe(422);

    // ops/current without an op: 404 OPS_NONE, from the server.
    const { agent: adminAgent, csrf: adminCsrf } = await browser(admin);
    const none = await adminAgent.get('/api/v1/ops/current');
    expect([none.status, code(none), none.headers.get('x-altis-serving')]).toEqual([404, 'OPS_NONE', 'server']);
    void csrf;

    await seedCheck(entry);
    const { opId } = (await adminAgent.post(`${UPDATES}/apply`, { version: TARGET }, adminCsrf)).json as { opId: string };
    const cookie = adminAgent.cookies.get(OPS_COOKIE)!;
    // Only the op's cookie: no session.
    const page2 = createAgent(app, { headers: { origin: ORIGIN } });
    page2.setCookie(OPS_COOKIE, cookie);
    const st = await page2.get(`${UPDATES}/status`);
    expect(st.status, st.text).toBe(200);
    expect(st.headers.get('x-altis-serving')).toBe('server');
    expect(st.json as UpdateStatusView).toEqual({
      op: expect.objectContaining({ opId, kind: 'update', state: 'checking' }),
      releases: { active: ACTIVE, previous: null, pending: null, pinned: null },
      serving: 'server',
      bundledBlocked: null, // 1d Task 29: an op runs
    });
    const cur = await page2.get('/api/v1/ops/current');
    expect(cur.status, cur.text).toBe(200);
    expect(cur.headers.get('x-altis-serving')).toBe('server');
    expect((cur.json as OpView).opId).toBe(opId);
    // Neither a cookie nor a session: the ops routes stay closed.
    expect((await createAgent(app).get(`${UPDATES}/status`)).status).toBe(401);
  });

  it('ALTIS_RELEASE_SOURCE=image → GET updates oneClick false, dockerPull true; apply, upload and rollback → 409 UPDATE_HIDDEN', async () => {
    build({ env: { ALTIS_RELEASE_SOURCE: 'image' } });
    await seedCheck(entry);
    const pkg = await releasePackage();
    const uploadId = await stagedUpdateUpload({ h, dataDir, now }, admin, pkg.zip);
    const { agent, csrf } = await browser(admin);
    expect((await agent.get(UPDATES)).json).toMatchObject({
      oneClick: false,
      dockerPull: true,
      available: { version: TARGET },
      rollback: { available: false, reason: 'image' },
    });
    for (const [url, body] of [
      [`${UPDATES}/apply`, { version: TARGET }],
      [`${UPDATES}/upload`, { uploadId, dryRun: true }],
      [`${UPDATES}/rollback`, undefined],
    ] as const) {
      const res = await agent.post(url, body, csrf);
      expect([res.status, code(res), reason(res)], url).toEqual([409, 'UPDATE_HIDDEN', 'image']);
    }
    expect(await opJson()).toBeNull();
    expect(await uploadRows()).toHaveLength(1);
    expect(await auditOf('update.upload')).toEqual([]);
  });

  it('the Docker runtime in data mode shows both the one-click update and the compose path', async () => {
    build({ runtime: 'docker' });
    const { agent } = await browser(reader);
    expect((await agent.get(UPDATES)).json).toMatchObject({ oneClick: true, dockerPull: true });
  });

  it('the community edition entitles every release: one out years ago is applied, and write routes keep working', async () => {
    build();
    const { agent, csrf } = await browser(admin);
    await seedCheck({ ...entry, releasedAt: jakartaDate(Date.now() - 4 * 365 * DAY) });
    const view = (await agent.get(UPDATES)).json as UpdatesView;
    expect(view.precheck).toMatchObject({ ok: true, failures: [], notEntitled: null });
    const applied = await agent.post(`${UPDATES}/apply`, { version: TARGET }, csrf);
    expect(applied.status, applied.text).toBe(200);
    expect(await opJson()).toMatchObject({ kind: 'update', state: 'checking' });
    // Nothing is refused for edition reasons meanwhile.
    const created = await agent.post('/api/v1/branches', { code: 'B-KOMUNITAS', name: 'Cabang', timezone: 'Asia/Jakarta' }, csrf);
    expect(created.status, created.text).toBe(201);
    await ops!.cancel({ type: 'system', id: null });
  });

  it('opening GET dashboard twice within an hour enqueues one update check', async () => {
    build();
    const { agent } = await browser(reader);
    expect((await agent.get('/api/v1/dashboard')).status).toBe(200);
    now += 10 * MIN;
    expect((await agent.get('/api/v1/dashboard')).status).toBe(200);
    const jobs = await h.db.selectFrom('jobs').select(['type', 'payload', 'status']).execute();
    // One job. Its status depends on timing (1d Task 29: the dashboard reads the edition too): the piggyback slice after
    // the first answer (passenger, no runner) may have claimed it before the second answer.
    expect(jobs.map(({ type, payload }) => ({ type, payload }))).toEqual([{ type: 'update.check', payload: JSON.stringify({ reason: 'dashboard' }) }]);
    expect(['queued', 'running', 'succeeded']).toContain(jobs[0]!.status);
    expect((await h.db.selectFrom('settings').select('value').where('key', '=', 'update.dashboard_check_at').executeTakeFirstOrThrow()).value).toBe(
      String(now - 10 * MIN),
    );
  });

  it('no feed URL (a build without --feed-url): onlineCheck false, the dashboard queues no check, a check stores nothing and warns nothing', async () => {
    const log = build({ feed: false });
    const { agent, csrf } = await browser(reader);
    expect((await agent.get('/api/v1/dashboard')).status).toBe(200);
    expect(await h.db.selectFrom('jobs').select('id').execute()).toEqual([]);
    // `POST updates/check` (the Pembaruan screen does not offer it then) ends without storing a check or a failure.
    await checkNow(agent, csrf);
    expect(await h.db.selectFrom('settings').select('value').where('key', '=', 'update.check').executeTakeFirst()).toBeUndefined();
    const view = (await agent.get(UPDATES)).json as UpdatesView;
    expect(view).toMatchObject({ onlineCheck: false, check: null, available: null, precheck: null, oneClick: true });
    expect(log.lines.filter((l) => l.level === 'warn' || l.level === 'error')).toEqual([]);
    expect(log.lines.map((l) => l.msg)).toContain('update check: no update feed is configured; online checks are off');
  });

  it('POST updates/rollback: the rollback op begun and stepped once → {opId}, previous active and the version left pinned', async () => {
    build();
    const previous = '0.0.1-test';
    await fsp.mkdir(path.join(dataDir, 'releases', previous), { recursive: true });
    await fsp.writeFile(path.join(dataDir, 'releases', previous, '.complete'), '');
    await updateCurrentState(dataDir, (s) => ({ ...s, previous: { version: previous, source: 'data' } }));
    const { agent, csrf } = await browser(admin);
    expect(((await agent.get(UPDATES)).json as UpdatesView).rollback).toEqual({ available: true, reason: null, target: previous });

    const readerBrowser = await browser(reader);
    expect((await readerBrowser.agent.post(`${UPDATES}/rollback`, undefined, readerBrowser.csrf)).status).toBe(403);
    const stale = await browser(admin, { reauth: false });
    expect(code(await stale.agent.post(`${UPDATES}/rollback`, undefined, stale.csrf))).toBe('AUTH_REAUTH_REQUIRED');

    const res = await agent.post(`${UPDATES}/rollback`, undefined, csrf);
    expect(res.status, res.text).toBe(200);
    const { opId } = res.json as { opId: string };
    expect(agent.cookies.get(OPS_COOKIE)).toEqual(expect.any(String));
    expect(await opJson()).toMatchObject({ opId, kind: 'rollback', state: 'done', actor: { type: 'staff', id: admin } });
    expect(await readCurrentState(dataDir, ACTIVE)).toMatchObject({ active: { version: previous, source: 'data' }, previous: null, pinned: ACTIVE });
    expect(restarts).toEqual(['rollback']);
    expect(await auditOf('update.rollback')).toEqual([expect.objectContaining({ entity_id: opId, actor_id: admin, meta: { from: ACTIVE, to: previous } })]);
    expect(((await agent.get(UPDATES)).json as UpdatesView).op).toMatchObject({ opId, kind: 'rollback', state: 'done' });

    const again = await agent.post(`${UPDATES}/rollback`, undefined, csrf);
    expect(again.status, again.text).toBe(409);
    expect([code(again), reason(again)]).toEqual(['ROLLBACK_UNAVAILABLE', 'no_previous']);
  });
});
