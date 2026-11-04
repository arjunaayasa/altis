import { createHash, createPrivateKey, type KeyObject } from 'node:crypto';
import { readFileSync } from 'node:fs';
import fsp from 'node:fs/promises';
import os from 'node:os';
import path from 'node:path';
import { RELEASE_TYP, signDetached, verifyReleaseWithRoots, type KeysetDoc, type TrustedKey } from '@altis/crypto';
import type { FeedEntry } from '@altis/crypto/feed';
import { PHASE1_MIGRATIONS, connect, runMigrations, withTx } from '@altis/db';
import { readCurrentState, resetTestFaults, updateCurrentState } from '@altis/platform';
import { newId } from '@altis/shared';
import { afterAll, afterEach, beforeAll, beforeEach, describe, expect, it, vi } from 'vitest';
import { engineLabel, testDb, testDbContext, type TestDbHandle } from '../../../../tools/test/test-db.js';
import { snapshotBackupRunning as snapshotLockHeld } from '../../src/backup/mode.js';
import { COMMUNITY_EDITION, type EditionCheck } from '../../src/edition/edition.js';
import type { KeyringEntry } from '../../src/crypto/secret-box.js';
import { CHUNK_MIN_BYTES, uploadContext } from '../../src/files/contexts.js';
import { acceptChunk, completeUpload, createUpload, stagedUploadFile, uploadOwner } from '../../src/files/uploads.js';
import { notify } from '../../src/notifications/service.js';
import { clearMaintenance, readMaintenance, readOpFile, writeMaintenance, writeOpFile, type OpActor, type OpFile } from '../../src/ops/files.js';
import { createOpsMachine, type OpStatus, type OpsMachine } from '../../src/ops/machine.js';
import { updateKind, type UpdateKindDeps } from '../../src/updates/kind.js';
import { runPrecheck } from '../../src/updates/precheck.js';
import { createUpdateSource, type UpdateSource } from '../../src/updates/source.js';

// The `update` op kind up to its point of no return (spec §9.4, §9.6; plan Task 24; decisions D1d-15, D1d-38;
// preflight B5, B7, M13, S3, S5, S21, 1D-07, 1D-18, 1D-23) on the engine picked by ALTIS_TEST_DB, with the dev keys.
// The feed path downloads through the real feed client (createUpdateSource) from feed-dev serving a package built here,
// so the download faults (`download-corrupt`, `disk-full`) and feed-dev's knobs run in the real download (M13). The
// clock is the real one plus an offset the tests move (the freeze waits 3 s after the flag; the download backs off).

const hooks = vi.hoisted(() => ({ headroom: 0, pendingWrites: [] as { version: string; markers: boolean }[] }));
vi.mock('@altis/platform', async (importOriginal) => {
  const actual = await importOriginal<typeof import('@altis/platform')>();
  const { existsSync } = await import('node:fs');
  const nodePath = await import('node:path');
  // A real probe writes up to 64 MiB per DATA_DIR; the headroom asked for is not what these tests are about.
  return {
    ...actual,
    ensureHeadroom: async () => {
      hooks.headroom += 1;
    },
    // Each write that makes a release pending notes whether that release's boot markers were there at that moment.
    updateCurrentState: ((dataDir, change) =>
      actual.updateCurrentState(dataDir, (s) => {
        const next = change(s);
        if (next !== null && next.pending !== null && s.pending?.version !== next.pending.version) {
          const markers = existsSync(nodePath.join(dataDir, 'releases', 'boot', next.pending.version));
          hooks.pendingWrites.push({ version: next.pending.version, markers });
        }
        return next;
      })) as typeof actual.updateCurrentState,
  };
});

type ZipInput = { path: string; data: Uint8Array };
type ZipModule = { writeZip(entries: readonly ZipInput[]): Buffer };
interface FeedDev {
  url: string;
  requests: { path: string; range: string | null }[];
  close(): Promise<void>;
}
type StartFeedDev = (o: { dir: string; dropAfterBytes?: number }) => Promise<FeedDev>;

const REPO_ROOT = path.resolve(import.meta.dirname, '..', '..', '..', '..');
const DEV_KEYS = path.join(REPO_ROOT, 'tools', 'keys', 'dev');
const readDev = (name: string): unknown => JSON.parse(readFileSync(path.join(DEV_KEYS, name), 'utf8')) as unknown;
const ROOTS = readDev('roots.json') as TrustedKey[];
const DEV_KEYSET = readDev('keyset.json') as KeysetDoc[];

function devKey(kid: string): KeyObject {
  const file = readDev(`${kid}.key.json`) as { pkcs8: string };
  return createPrivateKey({ key: Buffer.from(file.pkcs8, 'base64'), format: 'der', type: 'pkcs8' });
}

/** A dev-root-1 document revoking dev-rel-2 (1D-07: the revocation a package carries). */
const REVOKE_REL_2: KeysetDoc = (() => {
  const payload = { seq: 2, keys: [], revokedKids: ['dev-rel-2'] };
  return { raw: JSON.stringify(payload), env: signDetached(payload, { typ: 'altis-keyset/1', kid: 'dev-root-1', privateKey: devKey('dev-root-1') }) };
})();

const ctx = testDbContext();
const ACTIVE = '0.1.0-test';
const TARGET = '0.2.0-test';
const KEY = new Uint8Array(32).fill(41);
const KEYRING: KeyringEntry[] = [{ kid: 'k1', key: Buffer.alloc(32, 7).toString('base64url'), active: true }];
const INSTALL_ID = newId();
const SYSTEM: OpActor = { type: 'system', id: null };
const silent = { info() {}, warn() {}, error() {} };
const sha256 = (data: Uint8Array): string => createHash('sha256').update(data).digest('hex');

/** `n` bytes no compressor can shrink, the same every run. */
function noise(n: number, seed: string): Buffer {
  const out = Buffer.alloc(n);
  for (let at = 0, i = 0; at < n; i += 1) at += createHash('sha256').update(`${seed}:${i}`).digest().copy(out, at);
  return out;
}

interface PackageOptions {
  version?: string;
  meta?: Record<string, unknown>;
  signer?: string;
  keyset?: KeysetDoc[];
  /** Bytes of incompressible filler in the release (a large package). */
  filler?: number;
}

function releaseFiles(version: string, o: PackageOptions): Record<string, Buffer> {
  const files: Record<string, Buffer> = {
    'server.mjs': Buffer.from(`export const bootProtocol = 1;\nexport async function start() {}\nexport async function runCli() { return 0; }\n// ${version}\n`),
    'keyset.json': Buffer.from(`${JSON.stringify(o.keyset ?? DEV_KEYSET, null, 2)}\n`),
    'public/admin/index.html': Buffer.from(`<!doctype html><title>ALTIS ${version}</title>\n`),
    'public/admin/assets/app-3f2a.js': noise(2048, `app-${version}`),
  };
  if (o.filler !== undefined) files['public/filler.bin'] = noise(o.filler, `filler-${version}`);
  return files;
}

function manifestOf(version: string, files: Record<string, Buffer>, meta: Record<string, unknown> = {}): Record<string, unknown> {
  const list = Object.keys(files)
    .sort((a, b) => (a < b ? -1 : a > b ? 1 : 0))
    .map((p) => ({ path: p, sha256: sha256(files[p]!), size: files[p]!.byteLength }));
  return {
    version,
    buildId: `build-${version}`,
    bootProtocol: 1,
    releasedAt: '2026-11-01',
    schemaLatest: '9001',
    minCodeVersionAfter: '0.0.0',
    minUpgradeFrom: '0.0.0',
    minNode: '22.16.0',
    minDb: { mysql: '8.0.0', mariadb: '10.6.0', postgres: '15.0.0' },
    files: list,
    ...meta,
  };
}

/** A signed release: its files, manifest.json and manifest.sig. */
function signedRelease(o: PackageOptions = {}): { version: string; files: Record<string, Buffer>; manifest: Record<string, unknown>; sig: string } {
  const version = o.version ?? TARGET;
  const files = releaseFiles(version, o);
  const manifest = manifestOf(version, files, o.meta);
  const signer = o.signer ?? 'dev-rel-1';
  const sig = JSON.stringify(signDetached(manifest, { typ: RELEASE_TYP, kid: signer, privateKey: devKey(signer) }));
  return { version, files, manifest, sig };
}

let writeZip: ZipModule['writeZip'];
let startFeedDev: StartFeedDev;

/** The release package as `pnpm release` lays it out. */
function buildPackage(o: PackageOptions = {}): { zip: Buffer; manifest: Record<string, unknown> } {
  const r = signedRelease(o);
  const folder = `bundled-release/${r.version}/`;
  const entries: ZipInput[] = [
    { path: 'app.js', data: Buffer.from('"use strict";\n') },
    { path: 'package.json', data: Buffer.from(`{"name":"altis","version":${JSON.stringify(r.version)}}\n`) },
  ];
  const release: ZipInput[] = Object.entries(r.files).map(([p, data]) => ({ path: folder + p, data }));
  release.push({ path: `${folder}manifest.json`, data: Buffer.from(`${JSON.stringify(r.manifest, null, 2)}\n`) });
  release.push({ path: `${folder}manifest.sig`, data: Buffer.from(r.sig) });
  release.sort((a, b) => (a.path < b.path ? -1 : a.path > b.path ? 1 : 0));
  return { zip: writeZip([...entries, ...release, { path: `${folder}.complete`, data: Buffer.alloc(0) }]), manifest: r.manifest };
}

const exists = (file: string): Promise<boolean> =>
  fsp.lstat(file).then(
    () => true,
    () => false,
  );

describe.skipIf(!ctx.available)(`update op kind to the point of no return [${engineLabel()}]`, () => {
  let h: TestDbHandle;
  let root: string;
  let dataDir: string;
  let appRoot: string;
  let feedDir: string;
  let ops: OpsMachine;
  let offset: number;
  let servers: FeedDev[];
  /**
   * The edition seam: null is the community edition (every release covered); a day makes a fake edition that covers
   * releases on or before it only.
   */
  let coveredUntil: string | null;
  let snapshot: boolean;
  let restarts: string[];
  let source: UpdateSource;
  let wrapDownload: ((d: UpdateSource['download']) => UpdateSource['download']) | null;
  const clock = (): number => Date.now() + offset;

  const editionCheck = (): EditionCheck => {
    const until = coveredUntil;
    if (until === null) return COMMUNITY_EDITION;
    return { edition: 'fake', status: 'limited', notEntitled: (releasedAt) => (releasedAt <= until ? null : 'released_after') };
  };

  const deps = (): UpdateKindDeps => ({
    dataDir,
    appRoot,
    appVersion: ACTIVE,
    source: wrapDownload === null ? source : { ...source, download: wrapDownload(source.download.bind(source)) },
    precheck: (c) =>
      runPrecheck(
        {
          dataDir,
          db: h,
          edition: { check: async () => editionCheck() },
          snapshotBackupRunning: async () => snapshot,
          nodeVersion: process.versions.node,
          appVersion: ACTIVE,
          migrationsAhead: () => 1,
        },
        c,
      ),
    roots: ROOTS,
    sources: async () => [],
    refuseDevKids: false,
    backup: { dataDir, installId: INSTALL_ID, appVersion: ACTIVE, sessionKey: KEY, kids: ['k1'] },
    migrations: PHASE1_MIGRATIONS,
    restore: null,
    requestRestart: async (reason) => {
      restarts.push(reason);
    },
    boot: () => null,
    snapshotBackupRunning: async () => snapshot || (await snapshotLockHeld(h, Date.now())),
    notify,
    log: silent,
  });

  beforeAll(async () => {
    ({ writeZip } = (await import(new URL('../../../../tools/release/src/zip.ts', import.meta.url).href)) as ZipModule);
    ({ startFeedDev } = (await import(path.join(REPO_ROOT, 'tools', 'release', 'feed', 'serve.ts'))) as { startFeedDev: StartFeedDev });
    h = await testDb();
    root = await fsp.realpath(await fsp.mkdtemp(path.join(os.tmpdir(), 'altis-update-kind-')));
    await runMigrations(h, { appVersion: ACTIVE, dataDir: path.join(root, 'mig'), migrations: PHASE1_MIGRATIONS });
  });

  afterAll(async () => {
    await h?.close();
    if (root !== undefined) await fsp.rm(root, { recursive: true, force: true });
  });

  beforeEach(async () => {
    for (const table of ['jobs', 'locks', 'backups', 'events', 'notifications', 'releases_log', 'upload_sessions'] as const) {
      await h.db.deleteFrom(table).execute();
    }
    const base = await fsp.mkdtemp(path.join(root, 'case-'));
    dataDir = path.join(base, 'data');
    appRoot = path.join(base, 'app');
    feedDir = path.join(base, 'feed');
    await fsp.mkdir(dataDir, { recursive: true });
    await fsp.mkdir(path.join(feedDir, 'packages'), { recursive: true });
    await fsp.mkdir(appRoot, { recursive: true });
    await readCurrentState(dataDir, ACTIVE); // current.json: active 0.1.0-test (bundled)
    offset = 0;
    servers = [];
    coveredUntil = null;
    snapshot = false;
    restarts = [];
    hooks.pendingWrites.length = 0;
    wrapDownload = null;
    source = createUpdateSource({
      feedBase: () => null,
      dataDir,
      roots: ROOTS,
      sources: async () => [],
      refuseDevKids: false,
      allowLoopbackHttp: true,
      clock,
      log: silent,
      persistKeysets: async () => {},
      onSignedTime: async () => {},
      env: process.env,
    });
    ops = createOpsMachine({
      dataDir,
      kinds: [updateKind(deps)],
      db: () => h,
      connect: () => connect(h.config, { runtime: 'standalone', purpose: 'cli', dataDir: h.dataDir }),
      keyring: () => KEYRING,
      clock,
      log: silent,
      snapshotBackupRunning: async () => snapshot,
      appVersion: ACTIVE,
    });
    resetTestFaults();
  });

  afterEach(async () => {
    await ops.close();
    for (const s of servers.splice(0)) await s.close();
    vi.unstubAllEnvs();
    resetTestFaults();
  });

  /** Serves `zip` from feed-dev; the feed entry of it (size and SHA-256 of the bytes unless given). */
  async function serve(zip: Buffer, manifest: Record<string, unknown>, o: { dropAfterBytes?: number; entry?: Partial<FeedEntry> } = {}): Promise<{ entry: FeedEntry; dev: FeedDev }> {
    const name = `altis-${String(manifest['version'])}.zip`;
    await fsp.writeFile(path.join(feedDir, 'packages', name), zip);
    const dev = await startFeedDev({ dir: feedDir, ...(o.dropAfterBytes === undefined ? {} : { dropAfterBytes: o.dropAfterBytes }) });
    servers.push(dev);
    const entry: FeedEntry = {
      version: manifest['version'] as string,
      channel: 'stable',
      releasedAt: manifest['releasedAt'] as string,
      bootProtocol: manifest['bootProtocol'] as number,
      minUpgradeFrom: manifest['minUpgradeFrom'] as string,
      minCodeVersionAfter: manifest['minCodeVersionAfter'] as string,
      minNode: manifest['minNode'] as string,
      minDb: { ...(manifest['minDb'] as FeedEntry['minDb']) },
      size: zip.byteLength,
      sha256: sha256(zip),
      url: `${dev.url}/packages/${name}`,
      notesUrl: null,
      ...o.entry,
    };
    return { entry, dev };
  }

  function feedParams(entry: FeedEntry, over: Record<string, unknown> = {}): Record<string, unknown> {
    return { source: 'feed', target: entry.version, from: ACTIVE, entry, staging: null, needsBackup: null, ...over };
  }

  /**
   * Steps the op until `until` holds or it ends (each call ≤ `budget` ms); the clock moves 4 s between calls (the freeze
   * settles, a back-off passes).
   */
  async function drive(until: (s: OpStatus) => boolean = () => false, o: { calls?: number; budget?: number } = {}): Promise<OpStatus> {
    let status: OpStatus | null = null;
    for (let i = 0; i < (o.calls ?? 60); i += 1) {
      status = await ops.step(o.budget ?? 20_000);
      if (status === null) throw new Error('no op');
      if (until(status) || status.terminal) return status;
      offset += 4000;
    }
    if (status === null) throw new Error('no op');
    return status;
  }

  const opJson = async (): Promise<OpFile> => {
    const op = await readOpFile(dataDir);
    if (op === null || op === 'corrupt') throw new Error('op.json');
    return op;
  };
  const stagingDir = (opId: string, version = TARGET): string => path.join(dataDir, 'releases', `.tmp-${version}-${opId}`);
  const logRows = () => h.db.selectFrom('releases_log').selectAll().execute();
  const backupRows = () => h.db.selectFrom('backups').selectAll().execute();
  const applies = async (opId: string) =>
    (await h.db.selectFrom('audit_log').select(['meta', 'actor_type']).where('action', '=', 'update.apply').where('entity_id', '=', opId).execute()).map((r) => ({
      actor: r.actor_type,
      meta: JSON.parse(r.meta) as Record<string, unknown>,
    }));
  const notifications = () => h.db.selectFrom('notifications').select(['type', 'audience_permission', 'params']).orderBy('created_at').execute();

  describe('feed path', () => {
    it('checking → downloading → verified with no flag; then the flag, the freeze, the pre_update backup, the staging, the point of no return', async () => {
      await updateCurrentState(dataDir, (s) => ({ ...s, pinned: TARGET })); // an explicit update clears the pin (§9.7)
      const pkg = buildPackage();
      const { entry } = await serve(pkg.zip, pkg.manifest);
      const { opId } = await ops.begin('update', SYSTEM, feedParams(entry));
      expect(await readMaintenance(dataDir)).toBeNull();

      // The first call runs checking, downloading and the verification, and stops at verified: no flag yet.
      const first = await ops.step(20_000);
      expect(first).toMatchObject({ opId, state: 'verified', terminal: false });
      expect(await readMaintenance(dataDir)).toBeNull();
      const verified = await opJson();
      expect(verified.params).toMatchObject({ staging: `.tmp-${TARGET}-${opId}`, schemaLatest: '9001', precheck: { ok: true, candidate: { version: TARGET } } });
      expect(verified.version).toBe(TARGET);
      expect(await exists(path.join(stagingDir(opId), 'release', '.complete'))).toBe(true);
      expect(await logRows()).toEqual([expect.objectContaining({ id: opId, version: TARGET, action: 'update', from_version: ACTIVE, status: 'running', backup_id: null })]);

      // The next call raises the flag and waits for the freeze.
      expect(await ops.step(20_000)).toMatchObject({ state: 'verified' });
      expect(await readMaintenance(dataDir)).toMatchObject({ reason: 'update', opId });
      offset += 4000;
      const status = await drive((s) => s.state === 'switched');
      expect(status).toMatchObject({ opId, state: 'switched', pointOfNoReturn: true, terminal: false });

      // frozen: exactly one pre_update backup (frozen, DB only), the op's backupId.
      const backups = await backupRows();
      expect(backups).toEqual([expect.objectContaining({ kind: 'pre_update', consistency: 'frozen', status: 'ok', dialect: h.dialect })]);
      const op = await opJson();
      expect(op.backupId).toBe(backups[0]!.id);
      const manifest = JSON.parse(await fsp.readFile(path.join(dataDir, 'backups', op.backupId!, 'manifest.json'), 'utf8')) as Record<string, unknown>;
      expect(manifest).toMatchObject({ kind: 'pre_update', consistency: 'frozen', includesFiles: false });
      expect(op.params['export']).toBeUndefined();
      expect(op.params['needsBackup']).toBe(true);

      // backed_up: the release in place, the staging folder gone.
      expect(await exists(path.join(dataDir, 'releases', TARGET, '.complete'))).toBe(true);
      await verifyReleaseWithRoots(path.join(dataDir, 'releases', TARGET), ROOTS, { check: 'all' });
      expect(await exists(stagingDir(opId))).toBe(false);

      // switched: op.json past its point of no return; current.json pending, the pin cleared; one restart.
      expect(op).toMatchObject({ state: 'switched', pointOfNoReturn: true, params: { pendingWritten: true } });
      const current = await readCurrentState(dataDir, ACTIVE);
      expect(current).toMatchObject({ active: { version: ACTIVE }, pending: { version: TARGET, source: 'data' }, pinned: null });
      expect(current.pendingSince).toEqual(expect.any(Number));
      expect(restarts).toEqual(['update']);
      expect(await logRows()).toEqual([expect.objectContaining({ id: opId, status: 'running', backup_id: op.backupId })]);
      // Still in maintenance: the pending release boots next.
      expect(await readMaintenance(dataDir)).toMatchObject({ reason: 'update', opId });

      // A later step within 30 s asks for no second restart.
      offset += 10_000;
      expect(await ops.step(20_000)).toMatchObject({ state: 'switched' });
      expect(restarts).toEqual(['update']);
    });

    it('a target with the schema of the database (schemaLatest 0009) → no backup row, backupId null', async () => {
      const pkg = buildPackage({ meta: { schemaLatest: '0009' } });
      const { entry } = await serve(pkg.zip, pkg.manifest);
      const { opId } = await ops.begin('update', SYSTEM, feedParams(entry));
      const status = await drive((s) => s.state === 'switched');
      expect(status).toMatchObject({ opId, state: 'switched', backupId: null });
      expect(await backupRows()).toEqual([]);
      expect((await opJson()).params['needsBackup']).toBe(false);
    });
  });

  describe('A7 rejections → aborted', () => {
    it('the seam: an edition that does not cover the release → UPDATE_NOT_ENTITLED: no flag, no staging folder, one update.apply, update_failed, releases_log aborted', async () => {
      coveredUntil = '2026-10-01';
      const pkg = buildPackage();
      const { entry, dev } = await serve(pkg.zip, pkg.manifest);
      const { opId } = await ops.begin('update', SYSTEM, feedParams(entry));
      const status = await ops.step(20_000);
      expect(status).toMatchObject({ opId, state: 'aborted', terminal: true, error: { code: 'UPDATE_NOT_ENTITLED', reason: 'released_after' } });
      expect(await readMaintenance(dataDir)).toBeNull();
      expect(await exists(stagingDir(opId))).toBe(false);
      expect(dev.requests.filter((r) => r.path.endsWith('.zip'))).toEqual([]);
      expect(await applies(opId)).toEqual([
        { actor: 'system', meta: { outcome: 'aborted', target: TARGET, from: ACTIVE, backupId: null, error: 'UPDATE_NOT_ENTITLED' } },
      ]);
      expect(await notifications()).toEqual([{ type: 'update.failed', audience_permission: 'system.update.run', params: JSON.stringify({ version: TARGET }) }]);
      expect(await logRows()).toEqual([expect.objectContaining({ id: opId, status: 'aborted', finished_at: expect.any(Number) })]);
      expect((await opJson()).params['precheck']).toMatchObject({ ok: false, failures: ['entitlement'], notEntitled: 'released_after' });
      // A second look changes nothing (the end is recorded once).
      await ops.step(20_000);
      expect(await applies(opId)).toHaveLength(1);
    });

    it('target 0.1 against active 0.1 → UPDATE_PRECHECK_FAILED reason not_newer', async () => {
      const pkg = buildPackage({ version: ACTIVE });
      const { entry } = await serve(pkg.zip, pkg.manifest);
      await ops.begin('update', SYSTEM, feedParams(entry));
      expect(await ops.step(20_000)).toMatchObject({ state: 'aborted', error: { code: 'UPDATE_PRECHECK_FAILED', reason: 'not_newer' } });
    });

    it('download-corrupt → downloaded once more, then UPDATE_PACKAGE_INVALID reason hash', async () => {
      vi.stubEnv('ALTIS_TEST_FAULT', 'download-corrupt');
      const pkg = buildPackage();
      const { entry, dev } = await serve(pkg.zip, pkg.manifest);
      const { opId } = await ops.begin('update', SYSTEM, feedParams(entry));
      const status = await drive();
      expect(status).toMatchObject({ opId, state: 'aborted', error: { code: 'UPDATE_PACKAGE_INVALID', reason: 'hash' } });
      expect(dev.requests.filter((r) => r.path.endsWith('.zip'))).toHaveLength(2);
      expect((await opJson()).params['hashRetried']).toBe(true);
      expect(await exists(stagingDir(opId))).toBe(false);
      expect(await readMaintenance(dataDir)).toBeNull();
      expect(await logRows()).toEqual([expect.objectContaining({ status: 'aborted' })]);
    });

    it('disk-full:releases:1 during the extraction → DISK_QUOTA and a disk_low notification', async () => {
      const pkg = buildPackage();
      const { entry } = await serve(pkg.zip, pkg.manifest);
      // Armed once the package is whole: the first write in `releases` after it is the extraction's first file.
      wrapDownload = (download) => async (e, dest, onProgress, o) => {
        const r = await download(e, dest, onProgress, o);
        if (r.complete) {
          vi.stubEnv('ALTIS_TEST_FAULT', 'disk-full:releases:1');
          resetTestFaults();
        }
        return r;
      };
      const { opId } = await ops.begin('update', SYSTEM, feedParams(entry));
      const status = await drive();
      expect(status).toMatchObject({ opId, state: 'aborted', error: { code: 'DISK_QUOTA' } });
      expect((await notifications()).map((n) => n.type).sort()).toEqual(['disk.low', 'update.failed']);
      expect(await exists(stagingDir(opId))).toBe(false);
    });

    it('a connection dropped on every attempt → unchanged with downloadTries rising, the partial file kept, aborted after the 5th', async () => {
      const pkg = buildPackage({ filler: 1024 * 1024 });
      const { entry } = await serve(pkg.zip, pkg.manifest, { dropAfterBytes: 64 * 1024 });
      const { opId } = await ops.begin('update', SYSTEM, feedParams(entry));
      const zip = path.join(stagingDir(opId), 'package.zip');
      const tries: number[] = [];
      let status: OpStatus | null = null;
      for (let i = 0; i < 100; i += 1) {
        status = await ops.step(20_000);
        if (status!.terminal) break;
        expect(status).toMatchObject({ state: 'downloading' });
        const n = (await opJson()).params['downloadTries'];
        if (typeof n === 'number' && tries.at(-1) !== n) {
          tries.push(n);
          expect((await fsp.stat(zip)).size).toBeGreaterThan(0); // the partial file is kept
        }
        offset += 4000;
      }
      expect(tries).toEqual([1, 2, 3, 4]);
      expect(status).toMatchObject({ opId, state: 'aborted', error: { code: 'UPDATE_DOWNLOAD_FAILED' } });
      expect(await exists(stagingDir(opId))).toBe(false);
    });

    it('review L04: a back-off further ahead than any back-off sets (the clock was set back) is over: the download is tried again', async () => {
      const pkg = buildPackage({ filler: 1024 * 1024 });
      const { entry } = await serve(pkg.zip, pkg.manifest, { dropAfterBytes: 64 * 1024 });
      await ops.begin('update', SYSTEM, feedParams(entry));
      expect(await ops.step(20_000)).toMatchObject({ state: 'downloading' });
      const first = (await opJson()).params;
      expect(first).toMatchObject({ downloadTries: 1, downloadRetryAt: expect.any(Number) });
      // Within its 5 s the back-off holds.
      offset += 1000;
      await ops.step(20_000);
      expect((await opJson()).params).toMatchObject({ downloadTries: 1, downloadRetryAt: first['downloadRetryAt'] });
      // The clock stepped back 3 hours: the back-off does not hold the update for those hours.
      offset -= 3 * 3_600_000;
      await ops.step(20_000);
      expect((await opJson()).params).toMatchObject({ downloadTries: 2 });
    });

    it('a server sending more than entry.size → aborted with reason size', async () => {
      const pkg = buildPackage();
      const { entry } = await serve(pkg.zip, pkg.manifest);
      await ops.begin('update', SYSTEM, feedParams({ ...entry, size: pkg.zip.byteLength - 10 }));
      expect(await drive()).toMatchObject({ state: 'aborted', error: { code: 'UPDATE_PACKAGE_INVALID', reason: 'size' } });
    });
  });

  it('a snapshot backup started during the download → at verified the op ends with OPS_BLOCKED_BY_BACKUP; no flag was ever written', async () => {
    const pkg = buildPackage();
    const { entry } = await serve(pkg.zip, pkg.manifest);
    const { opId } = await ops.begin('update', SYSTEM, feedParams(entry));
    expect(await ops.step(20_000)).toMatchObject({ state: 'verified' });
    snapshot = true;
    const status = await ops.step(20_000);
    expect(status).toMatchObject({ opId, state: 'aborted', error: { code: 'OPS_BLOCKED_BY_BACKUP' } });
    expect(await readMaintenance(dataDir)).toBeNull();
    expect(await exists(stagingDir(opId))).toBe(false);
    expect(await logRows()).toEqual([expect.objectContaining({ id: opId, status: 'aborted' })]);
    expect(await applies(opId)).toEqual([expect.objectContaining({ meta: expect.objectContaining({ outcome: 'aborted', error: 'OPS_BLOCKED_BY_BACKUP' }) })]);
  });

  it('a package keyset.json revoking dev-rel-2 → DATA_DIR/releases/keyset.json holds it after verified, and after a cancel (1D-07)', async () => {
    const pkg = buildPackage({ keyset: [...DEV_KEYSET, REVOKE_REL_2] });
    const { entry } = await serve(pkg.zip, pkg.manifest);
    const { opId } = await ops.begin('update', SYSTEM, feedParams(entry));
    expect(await ops.step(20_000)).toMatchObject({ state: 'verified' });
    const store = path.join(dataDir, 'releases', 'keyset.json');
    const held = (): Promise<string[]> => fsp.readFile(store, 'utf8').then((t) => (JSON.parse(t) as KeysetDoc[]).map((d) => d.raw));
    expect(await held()).toContain(REVOKE_REL_2.raw);
    expect(await ops.cancel(SYSTEM)).toMatchObject({ opId, state: 'aborted' });
    expect(await exists(stagingDir(opId))).toBe(false);
    expect(await held()).toContain(REVOKE_REL_2.raw);
  });

  describe('cancel and refreeze', () => {
    /** Seeds audit rows so that a pre_update export of parts of 5 rows takes many steps. */
    async function seedAudit(): Promise<void> {
      const at = Date.now();
      await withTx(h, async (trx) => {
        const rows = [];
        for (let i = 0; i < 200; i += 1) {
          rows.push({ id: newId(at + i), seq: 1_000_000 + i, at: at + i, actor_type: 'system', action: 'settings.update', meta: '{}', prev_hash: '0'.repeat(64), hash: '1'.repeat(64) });
        }
        await trx.insertInto('audit_log').values(rows).execute();
      });
    }

    /** Begins a feed update and drives it into `frozen` with part of its export written. */
    async function intoFrozen(): Promise<string> {
      vi.stubEnv('ALTIS_TEST_EXPORT_PART_ROWS', '5');
      await seedAudit();
      const pkg = buildPackage();
      const { entry } = await serve(pkg.zip, pkg.manifest);
      const { opId } = await ops.begin('update', SYSTEM, feedParams(entry));
      expect(await ops.step(20_000)).toMatchObject({ state: 'verified' });
      expect(await ops.step(20_000)).toMatchObject({ state: 'verified' }); // the flag; the freeze settles
      offset += 4000;
      // One handler step per call from here: a budget already spent once the step ran.
      for (let i = 0; i < 20; i += 1) {
        await ops.step(1);
        const op = await opJson();
        if (op.params['export'] !== undefined) break;
      }
      for (let i = 0; i < 3; i += 1) await ops.step(1);
      const op = await opJson();
      expect(op).toMatchObject({ state: 'frozen', params: { needsBackup: true } });
      expect(op.params['export']).toMatchObject({ phase: 'tables' });
      return opId;
    }

    afterEach(async () => {
      await h.db.deleteFrom('audit_log').where('seq', '>=', 1_000_000).execute();
    });

    it('an operator cancel in frozen → aborted: the pre_update backup abandoned, the flag lowered, the staging folder removed', async () => {
      const opId = await intoFrozen();
      const backupId = (await opJson()).backupId!;
      expect(await readMaintenance(dataDir)).toMatchObject({ opId });
      const status = await ops.cancel(SYSTEM);
      expect(status).toMatchObject({ opId, state: 'aborted', terminal: true });
      expect(await backupRows()).toEqual([expect.objectContaining({ id: backupId, kind: 'pre_update', status: 'failed' })]);
      expect(await exists(path.join(dataDir, 'backups', backupId))).toBe(false);
      expect(await readMaintenance(dataDir)).toBeNull();
      expect(await exists(stagingDir(opId))).toBe(false);
      expect(await logRows()).toEqual([expect.objectContaining({ id: opId, status: 'aborted' })]);
      expect(await applies(opId)).toEqual([{ actor: 'system', meta: { outcome: 'aborted', target: TARGET, from: ACTIVE, backupId } }]);
    });

    it('maintenance forced off in frozen with half the export done → the next step freezes again, params.export is dropped, the old backup is abandoned', async () => {
      const opId = await intoFrozen();
      const first = (await opJson()).backupId!;
      await clearMaintenance(dataDir, opId);
      // The broken freeze: back to verified (refreeze), the backup stashed for the next frozen step, the flag up again.
      expect(await ops.step(20_000)).toMatchObject({ state: 'verified' });
      const thawed = await opJson();
      expect(thawed.backupId).toBeNull();
      expect(thawed.params['export']).toBeUndefined();
      expect(thawed.params['abandonBackupId']).toBe(first);
      expect(thawed.params['frozenAt']).toBeUndefined();
      expect(await readMaintenance(dataDir)).toMatchObject({ reason: 'update', opId });
      offset += 4000;
      vi.stubEnv('ALTIS_TEST_EXPORT_PART_ROWS', '50000');
      const status = await drive((s) => s.state === 'switched');
      expect(status).toMatchObject({ state: 'switched' });
      const second = (await opJson()).backupId!;
      expect(second).not.toBe(first);
      const rows = await backupRows();
      expect(rows.find((r) => r.id === first)).toMatchObject({ status: 'failed' });
      expect(rows.find((r) => r.id === second)).toMatchObject({ status: 'ok', kind: 'pre_update' });
      expect(await exists(path.join(dataDir, 'backups', first))).toBe(false);
      expect((await opJson()).params['abandonBackupId']).toBeUndefined();
    });

    it('a cancel in switched → 409 OPS_POINT_OF_NO_RETURN', async () => {
      const pkg = buildPackage({ meta: { schemaLatest: '0009' } });
      const { entry } = await serve(pkg.zip, pkg.manifest);
      await ops.begin('update', SYSTEM, feedParams(entry));
      expect(await drive((s) => s.state === 'switched')).toMatchObject({ state: 'switched' });
      await expect(ops.cancel(SYSTEM)).rejects.toMatchObject({ code: 'OPS_POINT_OF_NO_RETURN', status: 409 });
    });
  });

  describe('switched without pending (Review Focus 1, S3)', () => {
    async function switchedFixture(params: Record<string, unknown>): Promise<string> {
      const now = clock();
      const opId = newId(now);
      const op: OpFile = {
        opSchema: 1,
        opId,
        kind: 'update',
        actor: SYSTEM,
        state: 'switched',
        version: TARGET,
        backupId: null,
        heartbeatAt: now,
        startedAt: now,
        finishedAt: null,
        error: null,
        opsTokenHash: null,
        pointOfNoReturn: true,
        params: { source: 'feed', target: TARGET, from: ACTIVE, entry: null, staging: `.tmp-${TARGET}-${opId}`, needsBackup: false, frozenAt: now, ...params },
        progress: 95,
        message: null,
      };
      await fsp.mkdir(path.join(dataDir, 'ops'), { recursive: true });
      await writeOpFile(dataDir, op);
      await writeMaintenance(dataDir, { reason: 'update', since: now, opId, exemptJobIds: [] });
      return opId;
    }

    it('op.json switched, no pending in current.json, pendingWritten unset → the next step writes pending and sets pendingWritten', async () => {
      const opId = await switchedFixture({});
      expect((await readCurrentState(dataDir, ACTIVE)).pending).toBeNull();
      expect(await ops.step(20_000)).toMatchObject({ opId, state: 'switched' });
      expect((await readCurrentState(dataDir, ACTIVE)).pending).toEqual({ version: TARGET, source: 'data' });
      expect((await opJson()).params).toMatchObject({ pendingWritten: true, restartAt: expect.any(Number) });
      expect(restarts).toEqual(['update']);
    });

    /** A boot marker an earlier attempt left in `releases/boot/<version>/<name>`; its folder. */
    async function leftoverMarker(name: string, marker: Record<string, unknown>, version = TARGET): Promise<string> {
      const folder = path.join(dataDir, 'releases', 'boot', version);
      await fsp.mkdir(folder, { recursive: true });
      await fsp.writeFile(path.join(folder, name), `${JSON.stringify(marker)}\n`);
      return folder;
    }
    const deadImporting = { phase: 'importing', lastProgressAt: 1, refreshedAt: 1, host: 'gone', waiting: null, error: null };

    it('markers an earlier attempt at the target left (a revert killed before removing them) → removed before pending is written (D1d-19)', async () => {
      // Three dead holders in importing and an explicit error: the first holder of the new period would revert at once.
      for (const name of ['999990-1', '999991-2', '999992-3']) await leftoverMarker(name, deadImporting);
      const folder = await leftoverMarker('999993-4', { ...deadImporting, error: { detail: 'verify', reason: 'RELEASE_INVALID' } });
      const opId = await switchedFixture({});
      expect(await ops.step(20_000)).toMatchObject({ opId, state: 'switched' });
      expect((await readCurrentState(dataDir, ACTIVE)).pending).toEqual({ version: TARGET, source: 'data' });
      expect(hooks.pendingWrites).toEqual([{ version: TARGET, markers: false }]);
      await expect(fsp.stat(folder)).rejects.toMatchObject({ code: 'ENOENT' });
      expect((await opJson()).params).toMatchObject({ pendingWritten: true });
    });

    it('pending names the target already (killed after current.json was written, before the checkpoint) → the markers of its boot stay', async () => {
      const since = clock();
      await updateCurrentState(dataDir, (s) => ({ ...s, pending: { version: TARGET, source: 'data' }, pendingSince: since }));
      const live = { phase: 'migrating', lastProgressAt: since, refreshedAt: since, host: 'here', waiting: null, error: null };
      const folder = await leftoverMarker(`${process.pid}-5`, live);
      const opId = await switchedFixture({});
      expect(await ops.step(20_000)).toMatchObject({ opId, state: 'switched' });
      expect(await readCurrentState(dataDir, ACTIVE)).toMatchObject({ pending: { version: TARGET, source: 'data' }, pendingSince: since });
      expect(await fsp.readdir(folder)).toEqual([`${process.pid}-5`]);
      expect((await opJson()).params).toMatchObject({ pendingWritten: true });
    });

    it('pendingWritten set and pending null (a revert cleared it) → reverting with detail repeated, pending not written again', async () => {
      const opId = await switchedFixture({ pendingWritten: true });
      const status = await ops.step(20_000);
      // Task 25: the same call goes on to step the revert in this release (0.1, which the database accepts).
      expect(status).toMatchObject({ opId, state: 'rolled_back', error: { code: 'UPDATE_BOOT_FAILED', detail: 'repeated' } });
      expect((await readCurrentState(dataDir, ACTIVE)).pending).toBeNull();
      expect(restarts).toEqual([]);
    });
  });

  describe('upload source (B5)', () => {
    async function staffUser(): Promise<string> {
      const id = newId();
      const now = Date.now();
      await h.db
        .insertInto('staff_users')
        .values({ id, username_key: `u_${id.toLowerCase()}`, username_display: `u_${id}`, name: 'Uji Pembaruan', password_hash: 'x', status: 'active', created_at: now, updated_at: now })
        .execute();
      return id;
    }

    /** A completed staged upload of `zip` in context `update` by staff `staffId`. */
    async function uploaded(staffId: string, zip: Buffer): Promise<string> {
      const owner = uploadOwner(staffId);
      const now = Date.now();
      const context = uploadContext('update')!;
      const s = await withTx(h, (trx) => createUpload(trx, { owner, context, size: zip.byteLength, sha256: sha256(zip), chunkBytes: CHUNK_MIN_BYTES, now, dataDir }));
      for (let n = 0, at = 0; at < zip.byteLength; n += 1, at += s.chunkSize) {
        await acceptChunk(h, { id: s.id, owner, n, data: zip.subarray(at, Math.min(at + s.chunkSize, zip.byteLength)), now, dataDir });
      }
      await completeUpload(h, { id: s.id, owner, now, dataDir });
      return s.id;
    }

    const sessionRow = (id: string) => h.db.selectFrom('upload_sessions').select('id').where('id', '=', id).executeTakeFirst();

    it('stagedUploadFile leaves the session; checking takes it, moves it to <staging>/package.zip, and prechecks its manifest', async () => {
      const staffId = await staffUser();
      const pkg = buildPackage({ meta: { releasedAt: '2026-11-02' } });
      const uploadId = await uploaded(staffId, pkg.zip);
      const read = await stagedUploadFile(h.db, { uploadId, owner: uploadOwner(staffId), context: 'update', dataDir });
      expect(read).toMatchObject({ size: pkg.zip.byteLength, sha256: sha256(pkg.zip) });
      expect(await sessionRow(uploadId)).toBeDefined();

      const { opId } = await ops.begin('update', { type: 'staff', id: staffId }, { source: 'upload', uploadId, target: TARGET, from: ACTIVE, entry: null, staging: null, needsBackup: null });
      expect(await ops.step(20_000)).toMatchObject({ opId, state: 'verified' });
      expect(await sessionRow(uploadId)).toBeUndefined();
      const zip = path.join(stagingDir(opId), 'package.zip');
      expect(sha256(await fsp.readFile(zip))).toBe(sha256(pkg.zip));
      expect(await exists(path.join(dataDir, 'tmp', uploadId))).toBe(false);
      expect((await opJson()).params['precheck']).toMatchObject({ ok: true, candidate: { version: TARGET } });
      expect(await exists(path.join(stagingDir(opId), 'release', '.complete'))).toBe(true);
    });

    it('review L11: taken over before its first step, the op still takes the upload of the staff user who uploaded it (params.uploadBy)', async () => {
      const staffId = await staffUser();
      const other = await staffUser();
      const pkg = buildPackage({ meta: { releasedAt: '2026-11-02' } });
      const uploadId = await uploaded(staffId, pkg.zip);
      const params = { source: 'upload', uploadId, uploadBy: staffId, target: TARGET, from: ACTIVE, entry: null, staging: null, needsBackup: null };
      const { opId } = await ops.begin('update', { type: 'staff', id: staffId }, params);
      await ops.takeover({ type: 'staff', id: other });
      expect(await ops.step(20_000)).toMatchObject({ opId, state: 'verified' });
      expect(await sessionRow(uploadId)).toBeUndefined();
      expect(sha256(await fsp.readFile(path.join(stagingDir(opId), 'package.zip')))).toBe(sha256(pkg.zip));
      expect(await opJson()).toMatchObject({ actor: { type: 'staff', id: other }, params: { uploadBy: staffId } });
    });

    it('a package whose manifest is signed by dev-lic-1 → aborted with reason signature', async () => {
      const staffId = await staffUser();
      const pkg = buildPackage({ signer: 'dev-lic-1' });
      const uploadId = await uploaded(staffId, pkg.zip);
      await ops.begin('update', { type: 'staff', id: staffId }, { source: 'upload', uploadId, target: TARGET, from: ACTIVE, entry: null, staging: null, needsBackup: null });
      expect(await ops.step(20_000)).toMatchObject({ state: 'aborted', error: { code: 'UPDATE_PACKAGE_INVALID', reason: 'signature' } });
    });
  });

  describe('bundled source (B7)', () => {
    /** Writes `<appRoot>/bundled-release/<v>/` as app.js's zip carries it. */
    async function bundled(o: PackageOptions = {}): Promise<void> {
      const r = signedRelease(o);
      const dir = path.join(appRoot, 'bundled-release', r.version);
      for (const [p, data] of Object.entries(r.files)) {
        await fsp.mkdir(path.dirname(path.join(dir, p)), { recursive: true });
        await fsp.writeFile(path.join(dir, p), data);
      }
      await fsp.writeFile(path.join(dir, 'manifest.json'), `${JSON.stringify(r.manifest, null, 2)}\n`);
      await fsp.writeFile(path.join(dir, 'manifest.sig'), r.sig);
      await fsp.writeFile(path.join(dir, '.complete'), '');
    }

    const bundledParams = { source: 'bundled', target: TARGET, from: ACTIVE, entry: null, staging: null, needsBackup: null };

    it('begun at verified: the releases_log row after verified, the staging folder at backed_up, the copy in releases/<v> verifying all', async () => {
      await bundled();
      const { opId } = await ops.begin('update', SYSTEM, bundledParams, { state: 'verified' });
      expect(await readMaintenance(dataDir)).toMatchObject({ reason: 'update', opId });
      offset += 4000;
      expect(await drive((s) => s.state === 'frozen', { budget: 1 })).toMatchObject({ state: 'frozen' });
      expect(await logRows()).toEqual([expect.objectContaining({ id: opId, version: TARGET, from_version: ACTIVE, status: 'running' })]);
      const status = await drive((s) => s.state === 'switched');
      expect(status).toMatchObject({ opId, state: 'switched' });
      const op = await opJson();
      expect(op.params['staging']).toBe(`.tmp-${TARGET}-${opId}`);
      await verifyReleaseWithRoots(path.join(dataDir, 'releases', TARGET), ROOTS, { check: 'all' });
      expect(await exists(stagingDir(opId))).toBe(false);
      expect((await readCurrentState(dataDir, ACTIVE)).pending).toEqual({ version: TARGET, source: 'data' });
    });

    it('the same op failing the freeze (OPS_FREEZE_TIMEOUT) → a releases_log row aborted', async () => {
      await bundled();
      const t = Date.now();
      await h.db
        .insertInto('jobs')
        .values({ id: newId(), type: 'x.y', payload: '{}', status: 'running', run_at: t, max_attempts: 5, lock_token: 'tok', locked_by: 'w', locked_until: t + 3_600_000, created_at: t, updated_at: t })
        .execute();
      const { opId } = await ops.begin('update', SYSTEM, bundledParams, { state: 'verified' });
      offset = 30_000;
      expect(await ops.step(1000)).toMatchObject({ state: 'verified' });
      offset = 61_000;
      expect(await ops.step(1000)).toMatchObject({ opId, state: 'aborted', error: { code: 'OPS_FREEZE_TIMEOUT' } });
      expect(await logRows()).toEqual([expect.objectContaining({ id: opId, version: TARGET, status: 'aborted' })]);
      expect(await readMaintenance(dataDir)).toBeNull();
    });
  });

  it('S21: params with an unknown field are stepped and keep it', async () => {
    const pkg = buildPackage();
    const { entry } = await serve(pkg.zip, pkg.manifest);
    await ops.begin('update', SYSTEM, feedParams(entry, { future: 1 }));
    expect(await ops.step(20_000)).toMatchObject({ state: 'verified' });
    expect((await opJson()).params['future']).toBe(1);
    offset += 4000;
    await ops.step(20_000);
    offset += 4000;
    expect(await drive((s) => s.state === 'switched')).toMatchObject({ state: 'switched' });
    expect((await opJson()).params['future']).toBe(1);
  });

  it('an op whose releases_log row is final already (its end recorded, op.json not written) ends at its next step', async () => {
    coveredUntil = '2026-10-01';
    const pkg = buildPackage();
    const { entry } = await serve(pkg.zip, pkg.manifest);
    const { opId } = await ops.begin('update', SYSTEM, feedParams(entry));
    const before = await opJson();
    expect(await ops.step(20_000)).toMatchObject({ state: 'aborted' });
    // A process that died between finishUpdate's commit and the ended op.json: op.json is the one before.
    await writeOpFile(dataDir, before);
    const status = await ops.step(20_000);
    expect(status).toMatchObject({ opId, state: 'aborted', error: { code: 'UPDATE_NOT_ENTITLED' } });
    expect(await applies(opId)).toHaveLength(1);
    expect(await notifications()).toHaveLength(1);
  });
});
