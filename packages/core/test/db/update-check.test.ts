import { createHash, createPrivateKey, type KeyObject } from 'node:crypto';
import { readFileSync } from 'node:fs';
import fsp from 'node:fs/promises';
import os from 'node:os';
import path from 'node:path';
import { canonicalize, signDetached, type KeysetDoc, type TrustedKey } from '@altis/crypto';
import { FEED_TYP, FRESHNESS_TYP, type FeedChannel, type FeedEntry } from '@altis/crypto/feed';
import { PHASE1_MIGRATIONS, runMigrations, withTx } from '@altis/db';
import { readCurrentState, updateCurrentState } from '@altis/platform';
import { DomainError } from '@altis/shared';
import { afterAll, afterEach, beforeAll, beforeEach, describe, expect, it } from 'vitest';
import { engineLabel, testDb, testDbContext, type TestDbHandle } from '../../../../tools/test/test-db.js';
import type { CoreLogger } from '../../src/context.js';
import type { KeyringEntry } from '../../src/crypto/secret-box.js';
import { claimById } from '../../src/jobs/claim.js';
import { createJobRegistry } from '../../src/jobs/registry.js';
import { runSlice } from '../../src/jobs/slice.js';
import { SCHEDULES } from '../../src/scheduler/registry.js';
import { seedSchedules, tickSchedules } from '../../src/scheduler/tick.js';
import { readSettings, writeSettings } from '../../src/settings/service.js';
import {
  DASHBOARD_CHECK_INTERVAL_MS,
  UPDATE_CHECK_JOB,
  checkOfChannel,
  dashboardCheckDue,
  enqueueDashboardCheck,
  enqueueUpdateCheck,
  offeredUpdate,
  runUpdateCheck,
  updateCheckJob,
  updateCheckThrottle,
  type StoredUpdateCheck,
  type UpdateCheckDeps,
} from '../../src/updates/check-job.js';
import { createUpdateSource, type UpdateSource } from '../../src/updates/source.js';

// The update check (spec §9.6 step 1; plan Task 28; decision D1d-30; preflight 1D-12, M6) on the engine picked by
// ALTIS_TEST_DB: the daily schedule enqueues `update.check {reason: 'schedule'}`; one slice reads the signed feed of
// the channel through the real feed client (feed-dev serving 0.2 for an installation running 0.1), stores
// `update.check`, notifies `update_available` once per version and never for the pinned version, and publishes
// `update.checked`; a failed feed stores its code and keeps the last good entry; the dashboard's hourly check and the
// manual check's throttle.
//
// The feed folder is written here with the dev keys exactly as sign-cli's `feed sign` and `freshness sign` write it
// (as updates-source.test.ts does); feed-dev is loaded at run time (packages/core cannot reference tools/release).

interface FeedDev {
  url: string;
  requests: { path: string; range: string | null }[];
  close(): Promise<void>;
}
type StartFeedDev = (o: { dir: string }) => Promise<FeedDev>;

const REPO_ROOT = path.resolve(import.meta.dirname, '..', '..', '..', '..');
const DEV_KEYS = path.join(REPO_ROOT, 'tools', 'keys', 'dev');
const readDev = (name: string): unknown => JSON.parse(readFileSync(path.join(DEV_KEYS, name), 'utf8')) as unknown;
const ROOTS = readDev('roots.json') as TrustedKey[];
const DEV_KEYSET = readDev('keyset.json') as KeysetDoc[];

function devKey(kid: string): KeyObject {
  const file = readDev(`${kid}.key.json`) as { pkcs8: string };
  return createPrivateKey({ key: Buffer.from(file.pkcs8, 'base64'), format: 'der', type: 'pkcs8' });
}

const ctx = testDbContext();
const ACTIVE = '0.1.0-test';
const TZ = 'Asia/Jakarta';
const HOUR = 3_600_000;
const DAY = 86_400_000;
const KEYRING: KeyringEntry[] = [{ kid: 'k1', key: Buffer.alloc(32, 9).toString('base64url'), active: true }];
const silent: CoreLogger = { info() {}, warn() {}, error() {} };
const sha256 = (bytes: string): string => createHash('sha256').update(bytes).digest('hex');
const CHECK_DEF = SCHEDULES.filter((d) => d.name === 'update.check');

/** A feed entry of `version` (the package is never downloaded here). */
function entryOf(version: string, over: Partial<FeedEntry> = {}): FeedEntry {
  return {
    version,
    channel: 'stable',
    releasedAt: '2026-10-20',
    bootProtocol: 1,
    minUpgradeFrom: '0.0.0',
    minCodeVersionAfter: '0.0.0',
    minNode: '22.16.0',
    minDb: { mysql: '8.0.0', mariadb: '10.6.0', postgres: '15.0.0' },
    size: 1024,
    sha256: sha256(version),
    url: `https://updates.example.test/packages/altis-${version}.zip`,
    notesUrl: null,
    ...over,
  };
}

describe.skipIf(!ctx.available)(`the update check [${engineLabel()}]`, () => {
  let h: TestDbHandle;
  let root: string;
  let dataDir: string;
  let feedDir: string;
  let feedBase: string | null;
  let dev: FeedDev | undefined;
  let source: UpdateSource;
  let startFeedDev: StartFeedDev;
  let offset: number;
  const clock = (): number => Date.now() + offset;
  const deps = (): UpdateCheckDeps => ({ source, appVersion: ACTIVE, dataDir });
  const reg = createJobRegistry([updateCheckJob(() => deps())]);

  beforeAll(async () => {
    ({ startFeedDev } = (await import(path.join(REPO_ROOT, 'tools', 'release', 'feed', 'serve.ts'))) as { startFeedDev: StartFeedDev });
    h = await testDb();
    root = await fsp.realpath(await fsp.mkdtemp(path.join(os.tmpdir(), 'altis-update-check-')));
    await runMigrations(h, { appVersion: ACTIVE, dataDir: path.join(root, 'mig'), migrations: PHASE1_MIGRATIONS });
  });

  afterAll(async () => {
    await h?.close();
    if (root !== undefined) await fsp.rm(root, { recursive: true, force: true });
  });

  beforeEach(async () => {
    for (const table of ['jobs', 'locks', 'events', 'notifications', 'schedules'] as const) await h.db.deleteFrom(table).execute();
    await h.db.deleteFrom('settings').where('key', 'like', 'update.%').execute();
    const base = await fsp.mkdtemp(path.join(root, 'case-'));
    dataDir = path.join(base, 'data');
    feedDir = path.join(base, 'feed');
    await fsp.mkdir(dataDir, { recursive: true });
    await fsp.mkdir(feedDir, { recursive: true });
    await readCurrentState(dataDir, ACTIVE); // current.json: active 0.1.0-test (bundled)
    offset = 0;
    dev = await startFeedDev({ dir: feedDir });
    feedBase = dev.url;
    source = createUpdateSource({
      feedBase: () => feedBase,
      dataDir,
      roots: ROOTS,
      sources: async () => [],
      refuseDevKids: false,
      allowLoopbackHttp: true,
      clock,
      log: silent,
      persistKeysets: async () => {},
      onSignedTime: async () => {},
      env: {},
    });
  });

  afterEach(async () => {
    await dev?.close();
    dev = undefined;
  });

  /** `<feedDir>/<channel>/{feed.json, feed.sig, freshness.json}` as sign-cli signs them, issued an hour ago. */
  async function publish(channel: FeedChannel, seq: number, releases: FeedEntry[], o: { signer?: string } = {}): Promise<void> {
    const payload = { v: 1, channel, releases: releases.map((e) => ({ ...e, channel })), keyset: DEV_KEYSET };
    const text = canonicalize(payload);
    const signer = o.signer ?? 'dev-rel-1';
    const env = signDetached(payload, { typ: FEED_TYP, kid: signer, privateKey: devKey(signer) });
    const issuedAt = clock() - HOUR;
    const freshness = { feedSha256: sha256(text), seq, issuedAt, expiresAt: issuedAt + 7 * DAY };
    const freshnessEnv = signDetached(freshness, { typ: FRESHNESS_TYP, kid: 'dev-ts-1', privateKey: devKey('dev-ts-1') });
    const out = path.join(feedDir, channel);
    await fsp.mkdir(out, { recursive: true });
    await fsp.writeFile(path.join(out, 'feed.json'), text);
    await fsp.writeFile(path.join(out, 'feed.sig'), `${JSON.stringify(env, null, 2)}\n`);
    await fsp.writeFile(path.join(out, 'freshness.json'), `${JSON.stringify({ raw: canonicalize(freshness), env: freshnessEnv }, null, 2)}\n`);
  }

  /** `update.check` seeded a day ago and ticked now: the id of the job the schedule enqueued. */
  async function due(): Promise<string> {
    await withTx(h, (trx) => seedSchedules(trx, clock() - 25 * HOUR, TZ, CHECK_DEF));
    expect(await tickSchedules(h, reg, { now: clock(), tz: TZ, defs: CHECK_DEF, keyring: KEYRING, anomaly: false })).toBe(1);
    const job = await h.db.selectFrom('jobs').selectAll().where('type', '=', UPDATE_CHECK_JOB).where('status', '=', 'queued').executeTakeFirstOrThrow();
    return job.id;
  }

  /** One slice of job `id` as `POST /_cron` runs it. */
  async function cronSlice(id: string) {
    const job = await claimById(h, reg, id, { worker: 'cron', now: clock() });
    if (job === null) throw new Error('not claimable');
    return runSlice(h, reg, job, { mode: 'cron_http', budgetMs: 20_000, keyring: KEYRING, log: silent, clock, env: {} });
  }

  const stored = async (): Promise<StoredUpdateCheck | null> =>
    (await readSettings(h.db, ['update.check'], []))['update.check'] as StoredUpdateCheck | null;
  const notified = async (): Promise<unknown> => (await readSettings(h.db, ['update.notified'], []))['update.notified'];
  const notifications = async () =>
    (await h.db.selectFrom('notifications').select(['type', 'title_key', 'audience_permission', 'params', 'link']).execute()).map((n) => ({
      ...n,
      params: JSON.parse(n.params ?? 'null') as unknown,
    }));
  const checkedEvents = async () =>
    (await h.db.selectFrom('events').select(['channel', 'payload']).where('type', '=', 'update.checked').orderBy('seq').execute()).map((e) => ({
      channel: e.channel,
      payload: JSON.parse(e.payload) as unknown,
    }));
  const run = () => runUpdateCheck(h, deps(), { now: clock, log: silent });

  it('the schedule: update.check at 04:00 library time, not editable, payload {reason: schedule} that the handler accepts', async () => {
    expect(CHECK_DEF).toHaveLength(1);
    const def = CHECK_DEF[0]!;
    expect(def).toMatchObject({ expr: '0 4 * * *', jobType: 'update.check', permission: 'system.update.read', enabledByDefault: true });
    expect(def.exprEditable).toBeUndefined();
    const id = await due();
    const job = await h.db.selectFrom('jobs').selectAll().where('id', '=', id).executeTakeFirstOrThrow();
    expect(JSON.parse(job.payload)).toEqual({ reason: 'schedule' });
    expect(job.unique_key).toMatch(/^sched:update\.check:\d+$/);
    expect(reg.get(UPDATE_CHECK_JOB)).toMatchObject({ permission: 'system.update.read', retryable: 'api', interactive: true });
    expect(reg.get(UPDATE_CHECK_JOB)!.payload.safeParse({ reason: 'manual' }).success).toBe(true);
    expect(reg.get(UPDATE_CHECK_JOB)!.payload.safeParse({ windowStart: 0, windowEnd: 1 }).success).toBe(false);
  });

  it('the scheduled run stores the check, notifies update_available once, publishes update.checked; again → no notification', async () => {
    const v2 = entryOf('0.2.0-test');
    await publish('stable', 5, [entryOf(ACTIVE), v2]);
    expect(await cronSlice(await due())).toMatchObject({ outcome: 'succeeded' });

    expect(await stored()).toEqual({
      at: expect.any(Number),
      channel: 'stable',
      ok: true,
      error: null,
      seq: 5,
      available: v2,
      latest: '0.2.0-test',
      steppingStone: false,
      expiresAt: expect.any(Number),
    });
    expect(dev!.requests.map((r) => r.path).sort()).toEqual(['/stable/feed.json', '/stable/feed.sig', '/stable/freshness.json']);
    expect(await notifications()).toEqual([
      {
        type: 'update.available',
        title_key: 'notification.update_available.title',
        audience_permission: 'system.update.read',
        params: { version: '0.2.0-test' },
        link: '/admin/updates',
      },
    ]);
    expect(await notified()).toBe('0.2.0-test');
    expect(await checkedEvents()).toEqual([{ channel: 'system.update', payload: { available: '0.2.0-test' } }]);

    // The next day's run finds the same release: no second notification, a second update.checked.
    offset += DAY;
    expect(await run()).toEqual({ ok: true, error: null, available: '0.2.0-test', notified: false });
    expect(await notifications()).toHaveLength(1);
    expect(await checkedEvents()).toHaveLength(2);

    // A newer release is notified once more.
    const v3 = entryOf('0.3.0-test');
    await publish('stable', 6, [v2, v3]);
    expect(await run()).toMatchObject({ available: '0.3.0-test', notified: true });
    expect((await notifications()).map((n) => n.params)).toEqual([{ version: '0.2.0-test' }, { version: '0.3.0-test' }]);
    expect(await notified()).toBe('0.3.0-test');
  });

  it('P6: checks of two processes at once notify a version once (the update.notified row is locked first)', async () => {
    await publish('stable', 1, [entryOf('0.2.0-test')]);
    const results = await Promise.all([run(), run(), run()]);
    expect(results.filter((r) => r.notified)).toHaveLength(1);
    expect(results.map((r) => r.available)).toEqual(['0.2.0-test', '0.2.0-test', '0.2.0-test']);
    expect(await notifications()).toHaveLength(1);
    expect(await checkedEvents()).toHaveLength(3);
  });

  it('the pinned version (a manual rollback left it, §9.7) is never notified; it stays offered', async () => {
    await updateCurrentState(dataDir, (s) => ({ ...s, pinned: '0.2.0-test' }));
    await publish('stable', 1, [entryOf('0.2.0-test')]);
    expect(await cronSlice(await due())).toMatchObject({ outcome: 'succeeded' });
    expect(await run()).toEqual({ ok: true, error: null, available: '0.2.0-test', notified: false });
    expect(await notifications()).toEqual([]);
    expect(await notified()).toBeNull();
    expect((await stored())?.available?.version).toBe('0.2.0-test');
  });

  it('a stepping stone: the highest release the running one may update to, below the latest (D1d-43)', async () => {
    await publish('stable', 1, [entryOf('0.2.0-test'), entryOf('0.3.0-test', { minUpgradeFrom: '0.2.0-test' })]);
    await run();
    expect(await stored()).toMatchObject({ ok: true, available: { version: '0.2.0-test' }, latest: '0.3.0-test', steppingStone: true });
    // Nothing newer than the running release: nothing offered, nothing notified.
    await publish('stable', 2, [entryOf(ACTIVE)]);
    await run();
    expect(await stored()).toMatchObject({ ok: true, seq: 2, available: null, latest: null, steppingStone: false });
    expect((await notifications()).map((n) => n.params)).toEqual([{ version: '0.2.0-test' }]);
  });

  it('a failed check stores {ok: false, error: <code>}, keeps the last good entry, notifies nothing, publishes update.checked', async () => {
    const v2 = entryOf('0.2.0-test');
    await publish('stable', 3, [v2]);
    await run();
    const good = await stored();

    // The update server cannot be reached.
    await dev!.close();
    dev = undefined;
    offset += 2 * HOUR;
    expect(await run()).toEqual({ ok: false, error: 'FEED_UNREACHABLE', available: '0.2.0-test', notified: false });
    expect(await stored()).toEqual({ ...good, at: expect.any(Number), ok: false, error: 'FEED_UNREACHABLE' });
    expect((await stored())!.at).toBeGreaterThan(good!.at);

    // A feed signed by a key the installation does not trust: refused (the reason stays in the log, M6).
    dev = await startFeedDev({ dir: feedDir });
    feedBase = dev.url;
    await publish('stable', 4, [v2, entryOf('0.3.0-test')], { signer: 'dev-root-1' });
    expect(await run()).toMatchObject({ ok: false, error: 'FEED_INVALID', available: '0.2.0-test' });
    expect((await notifications()).map((n) => n.params)).toEqual([{ version: '0.2.0-test' }]);
    expect((await checkedEvents()).map((e) => e.payload)).toEqual([{ available: '0.2.0-test' }, { available: '0.2.0-test' }, { available: '0.2.0-test' }]);

    // Before any good check a failure stores no entry.
    await h.db.deleteFrom('settings').where('key', '=', 'update.check').execute();
    await dev!.close();
    dev = undefined;
    await run();
    expect(await stored()).toEqual({
      at: expect.any(Number),
      channel: 'stable',
      ok: false,
      error: 'FEED_UNREACHABLE',
      seq: null,
      available: null,
      latest: null,
      steppingStone: false,
      expiresAt: null,
    });
  });

  it('no feed URL (a build without --feed-url, none set): nothing is checked, stored or published, and nothing is warned', async () => {
    const lines: { level: string; msg: string }[] = [];
    const recording: CoreLogger = {
      info: (msg) => lines.push({ level: 'info', msg }),
      warn: (msg) => lines.push({ level: 'warn', msg }),
      error: (msg) => lines.push({ level: 'error', msg }),
    };
    feedBase = null;
    expect(await runUpdateCheck(h, deps(), { now: clock, log: recording })).toEqual({ ok: false, error: null, available: null, notified: false, noFeed: true });
    expect(await stored()).toBeNull();
    expect(await checkedEvents()).toEqual([]);
    expect(lines).toEqual([{ level: 'info', msg: 'update check: no update feed is configured; online checks are off' }]);

    // An earlier check (a feed set then) stays as it was: no failure is stored over it.
    feedBase = dev!.url;
    await publish('stable', 3, [entryOf('0.2.0-test')]);
    await run();
    const good = await stored();
    feedBase = null;
    offset += HOUR;
    expect(await run()).toMatchObject({ ok: false, error: null, noFeed: true });
    expect(await stored()).toEqual(good);
    expect(await checkedEvents()).toHaveLength(1);

    // The scheduled job ends done (the daily schedule stays on: a feed may be set later).
    feedBase = null;
    const id = await due();
    expect(await cronSlice(id)).toMatchObject({ outcome: 'succeeded' });
    expect(await stored()).toEqual(good);
  });

  it('review C07 (§9.6 "sudah kedaluwarsa ditolak"): the feed\'s expiresAt is stored; past it nothing is offered, and a failed check keeps no entry', async () => {
    const v2 = entryOf('0.2.0-test');
    const issuedAt = clock() - HOUR; // as publish() dates it
    await publish('stable', 3, [v2, entryOf('0.3.0-test', { minUpgradeFrom: '0.2.0-test' })]);
    await run();
    const good = (await stored())!;
    expect(good).toMatchObject({ ok: true, available: v2, latest: '0.3.0-test', steppingStone: true });
    expect(good.expiresAt).toBeGreaterThanOrEqual(issuedAt + 7 * DAY);
    expect(good.expiresAt).toBeLessThan(issuedAt + 7 * DAY + HOUR);
    const expiresAt = good.expiresAt!;

    // What GET updates, POST updates/apply and the dashboard offer: the entry of this channel, newer than the running
    // release, while the feed that listed it is fresh (up to and including expiresAt, as the feed client accepts it).
    expect(offeredUpdate(good, 'stable', ACTIVE, expiresAt)).toEqual(v2);
    expect(offeredUpdate(good, 'stable', ACTIVE, expiresAt + 1)).toBeNull();
    expect(offeredUpdate(good, 'beta', ACTIVE, clock())).toBeNull();
    expect(offeredUpdate(good, 'stable', '0.2.0-test', clock())).toBeNull();
    // A check stored without the feed's expiry (before it was recorded) offers nothing: a new check stores it.
    expect(offeredUpdate({ ...good, expiresAt: null }, 'stable', ACTIVE, clock())).toBeNull();
    expect(offeredUpdate(null, 'stable', ACTIVE, clock())).toBeNull();

    // Within the freshness window a failed check keeps the entry (it is still offered).
    await dev!.close();
    dev = undefined;
    offset += DAY;
    expect(await run()).toEqual({ ok: false, error: 'FEED_UNREACHABLE', available: '0.2.0-test', notified: false });
    expect(await stored()).toEqual({ ...good, at: expect.any(Number), ok: false, error: 'FEED_UNREACHABLE' });

    // The same feed past its expiresAt (its freshness never renewed): refused as expired, and the entry it offered is
    // dropped with it.
    dev = await startFeedDev({ dir: feedDir });
    feedBase = dev.url;
    offset += 7 * DAY;
    expect(await run()).toEqual({ ok: false, error: 'FEED_INVALID', available: null, notified: false });
    expect(await stored()).toEqual({ at: expect.any(Number), channel: 'stable', ok: false, error: 'FEED_INVALID', seq: 3, available: null, latest: null, steppingStone: false, expiresAt });
    // So does an unreachable feed past it.
    await withTx(h, (trx) => writeSettings(trx, { 'update.check': good }, { keyring: [], now: clock(), actorId: null }));
    await dev.close();
    dev = undefined;
    expect(await run()).toMatchObject({ ok: false, error: 'FEED_UNREACHABLE', available: null });
    expect(await stored()).toMatchObject({ available: null, latest: null, steppingStone: false, expiresAt });
    expect((await checkedEvents()).map((e) => e.payload)).toEqual([{ available: '0.2.0-test' }, { available: '0.2.0-test' }, { available: null }, { available: null }]);
  });

  // 1d review L14: a check is about one channel. Once `update.channel` changed, the last check says nothing of the new
  // channel (GET updates, the dashboard, the 60 s throttle read it through checkOfChannel), and a failed check of the
  // new channel keeps nothing of the old one's.
  it('the check names its channel; a failed check of another channel keeps nothing of the last one (1d review L14)', async () => {
    const v2 = entryOf('0.2.0-test');
    await publish('stable', 3, [v2]);
    await run();
    const good = await stored();
    expect(good).toMatchObject({ channel: 'stable', ok: true, available: v2 });
    expect(checkOfChannel(good, 'stable')).toEqual(good);
    expect(checkOfChannel(good, 'beta')).toBeNull();

    await withTx(h, (trx) => writeSettings(trx, { 'update.channel': 'beta' }, { keyring: [], now: clock(), actorId: null }));
    await dev!.close(); // nothing answers for beta
    dev = undefined;
    offset += 2 * HOUR;
    expect(await run()).toEqual({ ok: false, error: 'FEED_UNREACHABLE', available: null, notified: false });
    expect(await stored()).toEqual({
      at: expect.any(Number),
      channel: 'beta',
      ok: false,
      error: 'FEED_UNREACHABLE',
      seq: null,
      available: null,
      latest: null,
      steppingStone: false,
      expiresAt: null,
    });

    // A check stored before checks named their channel counts as the current channel's (what it was until now).
    const legacy: StoredUpdateCheck = { ...good! };
    delete legacy.channel;
    expect(checkOfChannel(legacy, 'beta')).toEqual(legacy);
    expect(checkOfChannel(null, 'beta')).toBeNull();
  });

  it('a lost database connection is thrown (the job is tried again), nothing is stored', async () => {
    const failing: UpdateCheckDeps = {
      source: { fetchFeed: () => Promise.reject(new DomainError('DB_UNAVAILABLE')) },
      appVersion: ACTIVE,
      dataDir,
    };
    await expect(runUpdateCheck(h, failing, { now: clock, log: silent })).rejects.toMatchObject({ code: 'DB_UNAVAILABLE' });
    expect(await stored()).toBeNull();
  });

  it('a manual or dashboard check joins the live one (unique key update.check)', async () => {
    const first = await withTx(h, (trx) => enqueueUpdateCheck(trx, { reason: 'manual', now: clock() }));
    const again = await withTx(h, (trx) => enqueueUpdateCheck(trx, { reason: 'dashboard', now: clock() }));
    expect(again).toEqual({ id: first.id, existing: true });
    const rows = await h.db.selectFrom('jobs').select(['type', 'payload', 'unique_key']).execute();
    expect(rows).toEqual([{ type: 'update.check', payload: JSON.stringify({ reason: 'manual' }), unique_key: 'update.check' }]);
  });

  it('the dashboard enqueues a check at most once an hour (update.dashboard_check_at, §9.6 step 1)', async () => {
    const t0 = clock();
    const first = await withTx(h, (trx) => enqueueDashboardCheck(trx, { now: t0 }));
    expect(first).toEqual(expect.any(String));
    expect((await readSettings(h.db, ['update.dashboard_check_at'], []))['update.dashboard_check_at']).toBe(t0);
    expect(await withTx(h, (trx) => enqueueDashboardCheck(trx, { now: t0 + 10 * 60_000 }))).toBeNull();
    expect(await withTx(h, (trx) => enqueueDashboardCheck(trx, { now: t0 + HOUR - 1 }))).toBeNull();
    expect(await h.db.selectFrom('jobs').select('id').execute()).toHaveLength(1);
    // The job ran meanwhile; an hour later the next open enqueues a new one.
    await h.db.updateTable('jobs').set({ status: 'succeeded', unique_key: null }).execute();
    const next = await withTx(h, (trx) => enqueueDashboardCheck(trx, { now: t0 + HOUR }));
    expect(next).toEqual(expect.any(String));
    expect(next).not.toBe(first);
    expect(await h.db.selectFrom('jobs').select('id').execute()).toHaveLength(2);
    // Two dashboards opened at once, an hour later still: one of them enqueues.
    await h.db.updateTable('jobs').set({ status: 'succeeded', unique_key: null }).execute();
    const both = await Promise.all([
      withTx(h, (trx) => enqueueDashboardCheck(trx, { now: t0 + 2 * HOUR })),
      withTx(h, (trx) => enqueueDashboardCheck(trx, { now: t0 + 2 * HOUR })),
    ]);
    expect(both.filter((id) => id !== null)).toHaveLength(1);
    expect(await h.db.selectFrom('jobs').select('id').execute()).toHaveLength(3);
    // A clock set back by more than an hour does not stop the checks.
    expect(dashboardCheckDue(t0, t0 - HOUR - 1)).toBe(true);
    expect(dashboardCheckDue(null, t0)).toBe(true);
    expect(dashboardCheckDue(t0, t0 + DASHBOARD_CHECK_INTERVAL_MS - 1)).toBe(false);
  });

  it('updateCheckThrottle: once per 60 s by `update.check.at`; the wait in whole seconds', () => {
    const t = 1_800_000_000_000;
    expect(updateCheckThrottle(null, t)).toBeNull();
    expect(updateCheckThrottle(t, t)).toBe(60);
    expect(updateCheckThrottle(t - 10_000, t)).toBe(50);
    expect(updateCheckThrottle(t - 59_001, t)).toBe(1);
    expect(updateCheckThrottle(t - 60_000, t)).toBeNull();
    // A last check a few seconds ahead (two processes' clocks): the full minute; far ahead (a clock set back): none.
    expect(updateCheckThrottle(t + 5_000, t)).toBe(60);
    expect(updateCheckThrottle(t + 120_000, t)).toBeNull();
  });

  it('the stored entry passes the strict setting (R1d-2) even when the feed client hands more fields', async () => {
    const extra = { ...entryOf('0.2.0-test'), firmware: { min: '1.0.0' } } as FeedEntry;
    const r = await runUpdateCheck(
      h,
      { source: { fetchFeed: async () => ({ channel: 'stable', seq: 9, issuedAt: 0, expiresAt: 0, entries: [extra], keyset: [], revokedKids: [], trusted: [], timestampKid: 'dev-ts-1' }) }, appVersion: ACTIVE, dataDir },
      { now: clock, log: silent },
    );
    expect(r).toMatchObject({ ok: true, available: '0.2.0-test' });
    expect((await stored())?.available).toEqual(entryOf('0.2.0-test'));
    // The setting refuses the extra field itself: writeSettings's strict schema is what the copy satisfies.
    const kept = (await stored())!;
    const refused = withTx(h, (trx) => writeSettings(trx, { 'update.check': { ...kept, available: extra } }, { keyring: [], now: clock(), actorId: null }));
    await expect(refused).rejects.toMatchObject({ code: 'VALIDATION_FAILED' });
  });
});
