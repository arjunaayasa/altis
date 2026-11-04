import { spawn } from 'node:child_process';
import fsp from 'node:fs/promises';
import http from 'node:http';
import path from 'node:path';
import type { OpFile } from '@altis/core';
import { TABLE_CLASSES, type DbHandle, type TableName } from '@altis/db';
import { lockHostIdentity, readCurrentState, resetTestFaults, updateCurrentState } from '@altis/platform';
import { isDomainError } from '@altis/shared';
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import { liveChecksums, seedInstallation } from '../../../../packages/core/test/fixtures/restore-support.js';
import { writeSignedRelease } from '../../../../packages/core/test/helpers/signed-release.js';
import { engineLabel, testDb, testDbConfig, testDbContext } from '../../../../tools/test/test-db.js';
import { writeConfig, type Config } from '../../src/config.js';
import { start, type BootContext } from '../../src/index.js';
import { readOpJson } from '../ops-support.js';
import { seedStaff, sessionCookieFor, sessionCsrfFor } from '../support-auth.js';
import { bootContext, closeTestServers, httpRequest, sampleConfig, useDataDir, type TestBootContext } from '../support.js';
import { DEV_ROOTS, feedEntryOf, publishFeed, releasePackage, startFeedDev, type FeedDev } from '../update-support.js';

// The update fault suite (spec §12.5, acceptance A7 "Kegagalan paksa … → kembali otomatis, data utuh"; plan Task 34)
// on the engine ALTIS_TEST_DB names: an installation of 0.1.0-test (fixture level 1) with data updates to 0.2.0-test
// (fixture level 2, + 9001_test_expand) from its signed feed (feed-dev), in this process, the way the releases and
// app.js would do it, with a fake bootloader context (the bootloader-level paths, a real app.js and its processes, are
// Task 16's and Task 35's):
//
//   1. 0.1.0-test's start(ctx) (runner off: the external mode of a Passenger host), then `POST updates/check` and
//      `POST updates/apply` as a re-authenticated super admin, then only `POST ops/drive` (what /admin/_update does)
//      until the op passes its point of no return (current.json `pending` = 0.2.0-test) or ends;
//   2. what app.js does with a pending release (packages/bootloader/src/pending.ts bootHolding), with the bootloader's
//      own code for the markers and the op record: ≥ 3 failed attempts (dead holders) or an op already settled →
//      revert without importing; otherwise 0.2.0-test's start(ctx) as the pending boot (`pendingBoot`, markHealthy
//      promoting it); a rejected start → recordPendingFailure, `pending = null`, the markers removed, then `active`
//      (0.1.0-test) started in this same process, which steps the revert;
//   3. this process's code is both releases: releaseMigrations() answers the fixture level of the release being
//      started (1 for 0.1.0-test, 2 for 0.2.0-test).
//
// Each A7 fault ends `aborted` (before the point of no return) or `rolled_back` (after it), 0.1.0-test serving again,
// and the checksum of every `data` table (notifications aside: an update notifies) equals the one taken just before
// `updates/apply`: `migrate:9001_test_expand`, `health:0.2.0-test`, `download-corrupt`, `disk-full:releases:1`, and
// `boot-crash` as three dead holders of boot.lock whose markers say they died right after `listening` (what the fault
// leaves behind: it kills the process there). `migrate-slow:12` holds the migration 12 s and must complete: no revert.

const fixture = vi.hoisted(() => ({ level: 1 as 1 | 2 }));
vi.mock('@altis/db', async (importOriginal) => {
  const actual = await importOriginal<typeof import('@altis/db')>();
  return { ...actual, releaseMigrations: (level?: Parameters<typeof actual.releaseMigrations>[0]) => actual.releaseMigrations(level ?? fixture.level) };
});
vi.mock('@altis/platform', async (importOriginal) => {
  const actual = await importOriginal<typeof import('@altis/platform')>();
  // A real probe writes up to 64 MiB per DATA_DIR; the headroom asked for is not what these tests are about.
  return { ...actual, ensureHeadroom: async () => {} };
});
const actualDb = await vi.importActual<typeof import('@altis/db')>('@altis/db');

// app.js's own code (packages/bootloader), loaded at run time: apps/server's TypeScript project cannot reference the
// bootloader, which references apps/server.
interface BootMarker {
  phase: 'importing' | 'listening' | 'migrating';
  lastProgressAt: number;
  refreshedAt: number;
  host: string;
  waiting: string | null;
  error: { detail: string; reason: string } | null;
}
interface MarkerRecord {
  pid: number;
  startMs: number;
  marker: BootMarker;
}
interface Bootloader {
  REVERT_FAILED_BOOTS: number;
  writeMarker(dataDir: string, version: string, pid: number, startMs: number, m: BootMarker): Promise<void>;
  readMarkers(dataDir: string, version: string): Promise<MarkerRecord[]>;
  removeMarkers(dataDir: string, version: string): Promise<void>;
  attemptEnded(m: MarkerRecord, now: number): boolean;
  classifyAttempts(markers: readonly MarkerRecord[], now: number, gone: (m: MarkerRecord, now: number) => boolean): { failed: number; interrupted: number; explicit: string | null };
  recordPendingFailure(dataDir: string, version: string, error: { code: 'UPDATE_BOOT_FAILED'; detail: string }, now: number): Promise<'written' | 'already' | 'none' | 'busy'>;
  readUpdateOpFor(dataDir: string, version: string): Promise<{ settled: boolean; detail: string | null } | null>;
}
const BOOTLOADER_SRC = path.resolve(import.meta.dirname, '..', '..', '..', '..', 'packages', 'bootloader', 'src');
const bootloader: Bootloader = {
  ...((await import(path.join(BOOTLOADER_SRC, 'markers.ts'))) as Omit<Bootloader, 'recordPendingFailure' | 'readUpdateOpFor'>),
  ...((await import(path.join(BOOTLOADER_SRC, 'op-record.ts'))) as Pick<Bootloader, 'recordPendingFailure' | 'readUpdateOpFor'>),
};

const engine = testDbContext();
const dirs = useDataDir();
const V1 = '0.1.0-test';
const V2 = '0.2.0-test';
const EXPAND = '9001_test_expand';
const UPDATES = '/api/v1/updates';
const SID = '__Host-altis_sid';
/** The `data` tables of 0.1.0-test (notifications aside: the update notifies its outcome). */
const DATA_TABLES = (Object.keys(TABLE_CLASSES) as TableName[]).filter(
  (t) => TABLE_CLASSES[t] === 'data' && !['notifications', 'notification_reads', 'test_fixture'].includes(t),
);
const handles: DbHandle[] = [];
let feed: FeedDev | undefined;

beforeEach(async () => {
  if (engine.available) await (await testDb()).close(); // an empty database
  vi.stubGlobal('__TRUSTED_KEYS__', DEV_ROOTS); // what a test build embeds: the dev root
  fixture.level = 1;
  resetTestFaults();
});

afterEach(async () => {
  await closeTestServers();
  await Promise.all(handles.splice(0).map((h) => h.close()));
  await feed?.close();
  feed = undefined;
  vi.unstubAllEnvs();
  vi.unstubAllGlobals();
  resetTestFaults();
});

async function ownHandle(): Promise<DbHandle> {
  const h = await actualDb.connect(testDbConfig(engine), { runtime: 'standalone', purpose: 'cli', dataDir: dirs.dataDir });
  handles.push(h);
  return h;
}

/** The data checksums of the installation now. */
async function dataChecksums(): Promise<Record<string, string>> {
  return liveChecksums(await ownHandle(), DATA_TABLES);
}

async function migrationNames(): Promise<string[]> {
  const h = await ownHandle();
  return (await h.db.selectFrom('schema_migrations').select('name').execute()).map((r) => r.name);
}

const releaseFolder = (version: string): string => path.join(dirs.dataDir, 'releases', version);

/**
 * 0.1.0-test's installation: config.json, its database at fixture level 1 seeded with data (system roles, settings and
 * a secret, branches, staff with TOTP, uploads, audit), a super admin, its release folder in DATA_DIR/releases
 * (current.json active {0.1.0-test, data}); and its feed (feed-dev) offering 0.2.0-test (schema 9001).
 */
async function installation(): Promise<{ config: Config; admin: string }> {
  const config = sampleConfig({ db: testDbConfig(engine) });
  await writeConfig(dirs.dataDir, config);
  const h = await ownHandle();
  await actualDb.runMigrations(h, { appVersion: V1, dataDir: dirs.dataDir, migrations: actualDb.releaseMigrations(1) });
  await seedInstallation(h, { dataDir: dirs.dataDir, installId: config.install.id, keyring: config.keyring });
  const admin = await seedStaff(h, { username: 'kepala', roles: [{ key: 'super_admin' }], keyring: config.keyring });
  await writeSignedRelease(releaseFolder(V1), V1);
  await readCurrentState(dirs.dataDir, V1);
  await updateCurrentState(dirs.dataDir, (s) => ({ ...s, active: { version: V1, source: 'data' } }));

  const feedDir = path.join(dirs.root, 'feed');
  await fsp.mkdir(path.join(feedDir, 'packages'), { recursive: true });
  feed = await startFeedDev({ dir: feedDir });
  const pkg = await releasePackage({ version: V2 });
  await fsp.writeFile(path.join(feedDir, 'packages', `altis-${V2}.zip`), pkg.zip);
  await publishFeed(feedDir, 'stable', 1, [feedEntryOf(pkg.zip, pkg.manifest, `${feed.url}/packages/altis-${V2}.zip`)]);
  vi.stubEnv('ALTIS_UPDATE_FEED_URL', feed.url);
  vi.stubEnv('ALTIS_RUNNER', 'off');
  return { config, admin: admin.id };
}

/** What app.js hands the release `version` from its DATA_DIR folder; `pending`: booted as the pending release. */
function releaseContext(version: string, o: { pending?: boolean } = {}): TestBootContext & { pendingBoot?: boolean } {
  const ctx = bootContext(dirs.dataDir, { version }) as TestBootContext & { pendingBoot?: boolean; bootMarker: { waiting?: unknown } };
  ctx.release = { version, dir: releaseFolder(version), source: 'data' };
  ctx.bootMarker.waiting = vi.fn();
  if (o.pending === true) {
    ctx.pendingBoot = true;
    // app.js's markHealthy (current.ts promote): previous = active, active = pending, pending = null.
    ctx.markHealthy.mockImplementation(async () => {
      await updateCurrentState(dirs.dataDir, (s) =>
        s.pending?.version === version ? { ...s, previous: s.active, active: s.pending, pending: null, pendingSince: null } : null,
      );
      await bootloader.removeMarkers(dirs.dataDir, version);
    });
  }
  return ctx;
}

/** One request to the served app as a browser of the installation (its Origin), with a body. */
function send(port: number, method: string, urlPath: string, headers: Record<string, string>, body?: unknown): Promise<{ status: number; json: unknown; text: string }> {
  const text = body === undefined ? '' : JSON.stringify(body);
  return new Promise((resolve, reject) => {
    const req = http.request(
      {
        host: '127.0.0.1',
        port,
        method,
        path: urlPath,
        agent: false,
        headers: {
          origin: 'https://perpus.sekolah.sch.id',
          accept: 'application/json',
          ...(body === undefined ? {} : { 'content-type': 'application/json' }),
          'content-length': String(Buffer.byteLength(text)),
          ...headers,
        },
      },
      (res) => {
        let out = '';
        res.setEncoding('utf8');
        res.on('data', (chunk: string) => (out += chunk));
        res.on('end', () => {
          let json: unknown;
          try {
            json = out === '' ? undefined : (JSON.parse(out) as unknown);
          } catch {
            json = undefined;
          }
          resolve({ status: res.statusCode ?? 0, json, text: out });
        });
        res.on('error', reject);
      },
    );
    req.on('error', reject);
    req.end(text);
  });
}

/**
 * 0.1.0-test running: the update checked and applied by the super admin (`fault` armed right before the apply), then
 * driven by `POST ops/drive` only, until current.json names 0.2.0-test `pending` (the point of no return) or the op
 * ends. Returns the data checksums taken right before the apply, and the op.
 */
async function updateFromV1(s: { config: Config; admin: string }, fault: string | null): Promise<{ before: Record<string, string>; op: OpFile }> {
  fixture.level = 1;
  const ctx = releaseContext(V1);
  await start(ctx as BootContext);
  const { port } = await ctx.served();
  const h = await ownHandle();
  const token = await sessionCookieFor(h, s.admin, { reauthAt: Date.now() });
  const headers = { cookie: `${SID}=${token}`, 'x-csrf-token': sessionCsrfFor(s.config, token) };

  const checked = await send(port, 'POST', `${UPDATES}/check`, headers);
  expect(checked.status, checked.text).toBe(202);
  const view = await send(port, 'GET', UPDATES, headers);
  expect(view.json).toMatchObject({ available: { version: V2 }, precheck: { ok: true } });

  const before = await dataChecksums();
  if (fault !== null) vi.stubEnv('ALTIS_TEST_FAULT', fault);
  const applied = await send(port, 'POST', `${UPDATES}/apply`, headers, { version: V2 });
  expect(applied.status, applied.text).toBe(200);
  const { opId } = applied.json as { opId: string };
  for (let i = 0; i < 600; i += 1) {
    const driven = await send(port, 'POST', '/api/v1/ops/drive', headers, {});
    expect(driven.status, driven.text).toBe(200);
    const op = await readOpJson(dirs.dataDir);
    expect(op.opId).toBe(opId);
    if (op.state === 'aborted' || op.state === 'failed' || op.state === 'needs_attention') break;
    if ((await readCurrentState(dirs.dataDir, V1)).pending?.version === V2) break;
    await new Promise((resolve) => setTimeout(resolve, 100));
  }
  vi.stubEnv('ALTIS_TEST_FAULT', '');
  // The release that began the update asks for its restart (P14); app.js would then end this process.
  await closeTestServers();
  return { before, op: await readOpJson(dirs.dataDir) };
}

/**
 * app.js holding releases/boot.lock with `pending` = 0.2.0-test (pending.ts bootHolding): the markers of ended attempts
 * counted and op.json looked at first; then 0.2.0-test's start() as the pending boot (`fault` armed), and on its
 * failure the revert: op.json first (recordPendingFailure), `pending = null`, the markers removed, then 0.1.0-test
 * started in this process (its start() steps the revert). Returns the context that serves at the end.
 */
async function appJsPendingBoot(fault: string | null): Promise<{ outcome: 'booted' | 'reverted'; detail: string | null; ctx: TestBootContext }> {
  const markers = await bootloader.readMarkers(dirs.dataDir, V2);
  const attempts = bootloader.classifyAttempts(markers, Date.now(), bootloader.attemptEnded);
  const settled = await bootloader.readUpdateOpFor(dirs.dataDir, V2);
  let detail: string;
  if (attempts.explicit !== null || attempts.failed >= bootloader.REVERT_FAILED_BOOTS || settled?.settled === true) {
    detail = attempts.explicit ?? settled?.detail ?? 'repeated'; // never imported (B8)
  } else {
    fixture.level = 2;
    if (fault !== null) vi.stubEnv('ALTIS_TEST_FAULT', fault);
    const target = releaseContext(V2, { pending: true });
    const error = await start(target as BootContext).then(
      () => null,
      (e: unknown) => e,
    );
    vi.stubEnv('ALTIS_TEST_FAULT', '');
    if (error === null) return { outcome: 'booted', detail: null, ctx: target };
    expect(isDomainError(error) && error.code, String(error)).toBe('UPDATE_BOOT_FAILED');
    detail = 'start';
  }
  const record = await bootloader.recordPendingFailure(dirs.dataDir, V2, { code: 'UPDATE_BOOT_FAILED', detail }, Date.now());
  expect(record).not.toBe('busy');
  await updateCurrentState(dirs.dataDir, (s) => (s.pending?.version === V2 ? { ...s, pending: null, pendingSince: null } : null));
  await bootloader.removeMarkers(dirs.dataDir, V2);
  fixture.level = 1;
  const active = releaseContext(V1);
  await start(active as BootContext);
  return { outcome: 'reverted', detail, ctx: active };
}

/** /_health of the release `ctx` serves. */
async function health(ctx: TestBootContext): Promise<{ status: number; body: unknown }> {
  const reply = await httpRequest((await ctx.served()).port, '/_health');
  return { status: reply.status, body: JSON.parse(reply.body) as unknown };
}

/** The end of a reverted update: rolled_back, 0.1.0-test active and serving, maintenance off, the data as before. */
async function expectRolledBack(served: TestBootContext, before: Record<string, string>, opId: string): Promise<void> {
  expect(await readOpJson(dirs.dataDir)).toMatchObject({ opId, kind: 'update', state: 'rolled_back', pointOfNoReturn: true });
  const state = await readCurrentState(dirs.dataDir, V1);
  expect(state.active).toEqual({ version: V1, source: 'data' });
  expect(state.pending).toBeNull();
  expect(await health(served)).toEqual({ status: 200, body: { status: 'ok', version: V1 } });
  await expect(fsp.stat(path.join(dirs.dataDir, 'ops', 'maintenance.json'))).rejects.toMatchObject({ code: 'ENOENT' });
  const h = await ownHandle();
  expect(await h.db.selectFrom('releases_log').select(['id', 'status']).execute()).toEqual([{ id: opId, status: 'rolled_back' }]);
  expect(await dataChecksums()).toEqual(before);
}

/** The end of an update refused before its point of no return: aborted, nothing installed, the data as before. */
async function expectAborted(before: Record<string, string>, op: OpFile, code: string): Promise<void> {
  expect(op).toMatchObject({ kind: 'update', state: 'aborted', pointOfNoReturn: false, error: { code } });
  const state = await readCurrentState(dirs.dataDir, V1);
  expect(state.active).toEqual({ version: V1, source: 'data' });
  expect(state.pending).toBeNull();
  await expect(fsp.stat(releaseFolder(V2))).rejects.toMatchObject({ code: 'ENOENT' });
  await expect(fsp.stat(path.join(dirs.dataDir, 'ops', 'maintenance.json'))).rejects.toMatchObject({ code: 'ENOENT' });
  expect(await migrationNames()).not.toContain(EXPAND);
  const h = await ownHandle();
  expect(await h.db.selectFrom('releases_log').select(['id', 'status']).execute()).toEqual([{ id: op.opId, status: 'aborted' }]);
  expect(await dataChecksums()).toEqual(before);
  // 0.1.0-test boots as before (a normal boot: no op holds maintenance).
  const ctx = releaseContext(V1);
  await start(ctx as BootContext);
  expect(await health(ctx)).toEqual({ status: 200, body: { status: 'ok', version: V1 } });
}

/** The PIDs of three processes that have ended (a holder killed by `boot-crash` leaves its PID dead). */
async function deadPids(n: number): Promise<number[]> {
  const pids: number[] = [];
  for (let i = 0; i < n; i += 1) {
    const child = spawn(process.execPath, ['-e', ''], { stdio: 'ignore' });
    await new Promise((resolve) => child.once('exit', resolve));
    pids.push(child.pid!);
  }
  return pids;
}

describe.skipIf(!engine.available)(`update faults, 0.1.0-test → 0.2.0-test [${engineLabel()}]`, () => {
  it(
    'migrate:9001_test_expand → the pending boot fails its migration → rolled_back by 0.1.0-test, data unchanged',
    async () => {
      const s = await installation();
      const { before, op } = await updateFromV1(s, null);
      expect(op).toMatchObject({ state: 'switched', pointOfNoReturn: true, params: { target: V2, from: V1 } });
      expect(op.backupId).not.toBeNull(); // the pre_update backup: the release brings a migration

      const { outcome, detail, ctx } = await appJsPendingBoot(`migrate:${EXPAND}`);
      expect([outcome, detail]).toEqual(['reverted', 'start']);
      expect(await readOpJson(dirs.dataDir)).toMatchObject({ error: { code: 'UPDATE_BOOT_FAILED', detail: 'migration' } });
      await expectRolledBack(ctx, before, op.opId);
      expect(await migrationNames()).not.toContain(EXPAND);
    },
    180_000,
  );

  it(
    'health:0.2.0-test → migrated, then found unhealthy → rolled_back (pointer only: the expand schema stays), data unchanged',
    async () => {
      const s = await installation();
      const { before, op } = await updateFromV1(s, null);
      expect(op).toMatchObject({ state: 'switched', pointOfNoReturn: true });

      const { outcome, ctx } = await appJsPendingBoot(`health:${V2}`);
      expect(outcome).toBe('reverted');
      expect(await readOpJson(dirs.dataDir)).toMatchObject({ error: { code: 'UPDATE_BOOT_FAILED', detail: 'health' } });
      await expectRolledBack(ctx, before, op.opId);
      // §9.7: an expand migration is additive; the pointer goes back, the schema stays for the next attempt.
      expect(await migrationNames()).toContain(EXPAND);
    },
    180_000,
  );

  it(
    'boot-crash: three holders of boot.lock that died right after listening → app.js reverts without importing → rolled_back, data unchanged',
    async () => {
      const s = await installation();
      const { before, op } = await updateFromV1(s, null);
      expect(op).toMatchObject({ state: 'switched', pointOfNoReturn: true });
      // What three boots killed by boot-crash:0.2.0-test leave: a marker each, phase `listening`, its process gone.
      const host = lockHostIdentity();
      const now = Date.now();
      for (const [i, pid] of (await deadPids(3)).entries()) {
        const at = now - (3 - i) * 4000;
        await bootloader.writeMarker(dirs.dataDir, V2, pid, at - 1500, { phase: 'listening', lastProgressAt: at, refreshedAt: at, host, waiting: null, error: null });
      }
      const attempts = bootloader.classifyAttempts(await bootloader.readMarkers(dirs.dataDir, V2), Date.now(), bootloader.attemptEnded);
      expect(attempts).toEqual({ failed: 3, interrupted: 0, explicit: null });

      const { outcome, detail, ctx } = await appJsPendingBoot(null);
      expect([outcome, detail]).toEqual(['reverted', 'repeated']);
      expect(await readOpJson(dirs.dataDir)).toMatchObject({ error: { code: 'UPDATE_BOOT_FAILED', detail: 'repeated' } });
      await expect(fsp.stat(path.join(dirs.dataDir, 'releases', 'boot', V2))).rejects.toMatchObject({ code: 'ENOENT' });
      await expectRolledBack(ctx, before, op.opId);
      expect(await migrationNames()).not.toContain(EXPAND); // 0.2.0-test never ran
    },
    180_000,
  );

  it(
    'download-corrupt → the package fails its hash twice → aborted before the point of no return, data unchanged',
    async () => {
      const s = await installation();
      const { before, op } = await updateFromV1(s, 'download-corrupt');
      await expectAborted(before, op, 'UPDATE_PACKAGE_INVALID');
    },
    180_000,
  );

  it(
    'disk-full:releases:1 → the download cannot be written → aborted before the point of no return, data unchanged',
    async () => {
      const s = await installation();
      const { before, op } = await updateFromV1(s, 'disk-full:releases:1');
      await expectAborted(before, op, 'DISK_QUOTA');
    },
    180_000,
  );

  it(
    'migrate-slow:12 → the migration held 12 s, the boot marker kept moving → done, no revert, 0.2.0-test active, data unchanged',
    async () => {
      const s = await installation();
      const { before, op } = await updateFromV1(s, null);
      expect(op).toMatchObject({ state: 'switched', pointOfNoReturn: true });

      const began = Date.now();
      const { outcome, ctx } = await appJsPendingBoot('migrate-slow:12');
      expect(outcome).toBe('booted');
      expect(Date.now() - began).toBeGreaterThanOrEqual(11_000);
      // The slow migration reported progress (every 5 s), which app.js writes into the boot marker.
      expect(vi.mocked(ctx.bootMarker.progress).mock.calls.length).toBeGreaterThanOrEqual(2);
      const done = await readOpJson(dirs.dataDir);
      expect(done).toMatchObject({ opId: op.opId, state: 'done', error: null });
      expect(done.stateBefore).toBeUndefined();
      expect(ctx.markHealthy).toHaveBeenCalledTimes(1);
      const state = await readCurrentState(dirs.dataDir, V1);
      expect(state).toMatchObject({ active: { version: V2, source: 'data' }, previous: { version: V1, source: 'data' }, pending: null });
      expect(await health(ctx)).toEqual({ status: 200, body: { status: 'ok', version: V2 } });
      expect(await migrationNames()).toContain(EXPAND);
      const h = await ownHandle();
      expect(await h.db.selectFrom('releases_log').select(['id', 'status']).execute()).toEqual([{ id: op.opId, status: 'done' }]);
      expect(await dataChecksums()).toEqual(before);
    },
    180_000,
  );
});
