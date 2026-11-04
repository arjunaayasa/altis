import { createHash, createPrivateKey, type KeyObject } from 'node:crypto';
import { readFileSync } from 'node:fs';
import fsp from 'node:fs/promises';
import os from 'node:os';
import path from 'node:path';
import {
  RELEASE_TYP,
  signDetached,
  verifyReleaseWithRoots,
  type KeysetDoc,
  type KeysetSource,
  type ReleaseManifest,
  type TrustedKey,
} from '@altis/crypto';
import type { FeedEntry } from '@altis/crypto/feed';
import { releaseStagingPath, resetTestFaults, type DataPath } from '@altis/platform';
import { isDomainError, newId, type DomainError } from '@altis/shared';
import { afterAll, afterEach, beforeAll, beforeEach, describe, expect, it } from 'vitest';
import { extractVerifiedRelease, readPackageManifest } from '../src/updates/package.js';
import { rawZip } from './helpers/raw-zip.js';

// Release packages (spec §9.1, §9.6 "Verifikasi + ekstraksi dalam satu lintasan", §8.3; plan Task 21; preflight S10,
// 1D-19; Review Focus 3): the signed manifest of `bundled-release/<v>/` is read and verified first (over its raw bytes,
// with the root keys, the installation's keyset documents and the package's own keyset.json); then only the files it
// lists are extracted into the update's staging folder, each hashed while it is written, within the manifest's sizes
// and a deflate ratio of at most 10×; the zip's root files are ignored; `.complete`, then verifyReleaseWithRoots
// (check 'all'). Every refusal is UPDATE_PACKAGE_INVALID with its reason, and the staging folder goes.

// The packages are written by the release zip writer (tools/release), loaded by a path relative to this file: it is a
// module of the release tooling's own TypeScript project, which this package's project cannot reference (tools/release
// reaches packages/core through the bootloader and the server, so a reference would be a cycle). Only the deflate-ratio
// fixture is written again with the hostile-fixture builder (helpers/raw-zip.ts), which sets the method by hand.
type ZipInput = { path: string; data: Uint8Array };
type ZipModule = {
  writeZip(entries: readonly ZipInput[]): Buffer;
  readZip(input: Uint8Array): { path: string; data: Buffer; method: number; compressedSize: number }[];
};
const ZIP_MODULE = new URL('../../../tools/release/src/zip.ts', import.meta.url).href;
const { writeZip, readZip } = (await import(ZIP_MODULE)) as ZipModule;

const DEV_KEYS = path.resolve(import.meta.dirname, '..', '..', '..', 'tools', 'keys', 'dev');
const readDev = (name: string): unknown => JSON.parse(readFileSync(path.join(DEV_KEYS, name), 'utf8')) as unknown;
/** tools/keys/dev/roots.json: dev-root-1, the trust anchor of test builds. */
const ROOTS = readDev('roots.json') as TrustedKey[];
/** tools/keys/dev/keyset.json: dev-root-1 trusts dev-rel-1, dev-rel-2, dev-lic-1 and the other dev keys. */
const DEV_KEYSET_TEXT = readFileSync(path.join(DEV_KEYS, 'keyset.json'), 'utf8');

function devKey(kid: string): KeyObject {
  const file = readDev(`${kid}.key.json`) as { pkcs8: string };
  return createPrivateKey({ key: Buffer.from(file.pkcs8, 'base64'), format: 'der', type: 'pkcs8' });
}

/** A dev-root-1 keyset document revoking dev-rel-2 (Review Focus 3: a leaked release key). */
const REVOKE_REL_2: KeysetDoc = (() => {
  const payload = { seq: 2, keys: [], revokedKids: ['dev-rel-2'] };
  return { raw: JSON.stringify(payload), env: signDetached(payload, { typ: 'altis-keyset/1', kid: 'dev-root-1', privateKey: devKey('dev-root-1') }) };
})();

const MIN_DB = { mysql: '8.0.0', mariadb: '10.6.0', postgres: '15.0.0' };

/** `n` bytes no compressor can shrink (SHA-256 in counter mode, so every run builds the same zip). */
function noise(n: number, seed: string): Buffer {
  const out = Buffer.alloc(n);
  for (let at = 0, i = 0; at < n; i += 1) at += createHash('sha256').update(`${seed}:${i}`).digest().copy(out, at);
  return out;
}

/** A file that deflates about `ratio` times: incompressible bytes followed by zeros. */
function deflatesAbout(ratio: number, total = 100_000): Buffer {
  const random = Math.round(total / ratio);
  return Buffer.concat([noise(random, `ratio-${ratio}`), Buffer.alloc(total - random)]);
}

function defaultFiles(version: string): Record<string, Buffer> {
  return {
    'server.mjs': Buffer.from(
      `export const bootProtocol = 1;\nexport async function start(ctx) {\n  ctx.serve((req, res) => res.end(${JSON.stringify(version)}));\n}\n` +
        `export async function runCli(argv) {\n  return argv.length;\n}\n`,
    ),
    'keyset.json': Buffer.from(DEV_KEYSET_TEXT),
    'public/admin/index.html': Buffer.from(`<!doctype html><title>ALTIS ${version}</title><div id="root"></div>\n`),
    'public/admin/assets/app-3f2a.js': noise(2048, `app-${version}`),
    'public/THIRD_PARTY_NOTICES.txt': Buffer.from('kysely 0.29.7 (MIT)\nhono (MIT)\nzod 4.6.7 (MIT)\n'),
  };
}

const sha256 = (data: Uint8Array): string => createHash('sha256').update(data).digest('hex');

interface PackageOptions {
  version?: string;
  /** The release's files (default {@link defaultFiles}); the manifest lists exactly these. */
  files?: Record<string, Buffer>;
  /** Manifest fields set (or replaced) before signing. */
  meta?: Record<string, unknown>;
  signer?: string;
  /** Bytes written to the zip instead of the listed ones (null: the entry is left out). */
  tamper?: Record<string, Buffer | null>;
  /** Further zip entries, by their full name. */
  extra?: ZipInput[];
  /** manifest.sig's text instead of the signature. */
  sigText?: string;
  /** The release folder's name in the zip (default: the version). */
  folder?: string;
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
    minDb: { ...MIN_DB },
    files: list,
    ...meta,
  };
}

/** A release package as `pnpm release` lays it out: the root files, then `bundled-release/<v>/`, `.complete` last. */
function buildPackage(o: PackageOptions = {}): { zip: Buffer; manifest: Record<string, unknown> } {
  const version = o.version ?? '0.2.0-test';
  const files = o.files ?? defaultFiles(version);
  const manifest = manifestOf(version, files, o.meta);
  const signer = o.signer ?? 'dev-rel-1';
  const env = signDetached(manifest, { typ: RELEASE_TYP, kid: signer, privateKey: devKey(signer) });
  const folder = `bundled-release/${o.folder ?? version}/`;
  const entries: ZipInput[] = [
    { path: 'LICENSE', data: Buffer.from('GNU AFFERO GENERAL PUBLIC LICENSE (test)\n') },
    { path: 'NOTICE', data: Buffer.from('NOTICE (test)\n') },
    { path: 'app.js', data: Buffer.from('"use strict";\nmodule.exports = {};\n') },
    { path: 'package.json', data: Buffer.from(`{"name":"altis","version":${JSON.stringify(version)}}\n`) },
  ];
  const release: ZipInput[] = [];
  for (const [p, data] of Object.entries(files)) {
    const written = o.tamper !== undefined && p in o.tamper ? o.tamper[p] : data;
    if (written !== null && written !== undefined) release.push({ path: folder + p, data: written });
  }
  release.push({ path: `${folder}manifest.json`, data: Buffer.from(`${JSON.stringify(manifest, null, 2)}\n`) });
  release.push({ path: `${folder}manifest.sig`, data: Buffer.from(o.sigText ?? JSON.stringify(env)) });
  for (const [p, data] of Object.entries(o.tamper ?? {})) {
    if (!(p in files) && data !== null) release.push({ path: folder + p, data });
  }
  release.sort((a, b) => (a.path < b.path ? -1 : a.path > b.path ? 1 : 0));
  return {
    zip: writeZip([...entries, ...release, ...(o.extra ?? []), { path: `${folder}.complete`, data: Buffer.alloc(0) }]),
    manifest,
  };
}

/** `zip` with every occurrence of the name `from` replaced by `to` (same length), in the local and central headers. */
function renamed(zip: Buffer, from: string, to: string): Buffer {
  expect(Buffer.byteLength(to)).toBe(Buffer.byteLength(from));
  const out = Buffer.from(zip);
  const needle = Buffer.from(from);
  let hits = 0;
  for (let at = out.indexOf(needle); at !== -1; at = out.indexOf(needle, at + needle.length)) {
    Buffer.from(to).copy(out, at);
    hits += 1;
  }
  expect(hits).toBe(2);
  return out;
}

function feedEntryOf(m: Record<string, unknown>, over: Partial<FeedEntry> = {}): FeedEntry {
  return {
    version: m['version'] as string,
    channel: 'stable',
    releasedAt: m['releasedAt'] as string,
    bootProtocol: m['bootProtocol'] as number,
    minUpgradeFrom: m['minUpgradeFrom'] as string,
    minCodeVersionAfter: m['minCodeVersionAfter'] as string,
    minNode: m['minNode'] as string,
    minDb: { ...(m['minDb'] as FeedEntry['minDb']) },
    size: 1,
    sha256: 'c'.repeat(64),
    url: 'https://updates.example.test/stable/altis.zip',
    notesUrl: null,
    ...over,
  };
}

const exists = (file: string): Promise<boolean> =>
  fsp.lstat(file).then(
    () => true,
    () => false,
  );

let tmp: string;
let counter = 0;
let dataDir: string;
let opId: string;

beforeAll(async () => {
  tmp = await fsp.realpath(await fsp.mkdtemp(path.join(os.tmpdir(), 'altis-update-package-')));
});

afterAll(async () => {
  await fsp.rm(tmp, { recursive: true, force: true });
});

beforeEach(async () => {
  dataDir = path.join(tmp, `data-${counter++}`);
  await fsp.mkdir(path.join(dataDir, 'releases'), { recursive: true });
  opId = newId();
});

afterEach(() => {
  delete process.env['ALTIS_TEST_FAULT'];
  resetTestFaults();
});

/** Writes `zip` as the op's downloaded package (`releases/.tmp-<v>-<opId>/package.zip`, as the update op keeps it). */
async function placePackage(zip: Buffer, version = '0.2.0-test'): Promise<DataPath> {
  const p = releaseStagingPath(dataDir, version, opId, 'package.zip');
  await fsp.mkdir(path.dirname(p), { recursive: true });
  await fsp.writeFile(p, zip);
  return p;
}

const keys = (sources: KeysetSource[] = []) => ({ roots: ROOTS, sources, refuseDevKids: false });

function extract(zip: DataPath, o: { version?: string; expect?: FeedEntry | null; sources?: KeysetSource[] } = {}): Promise<ReleaseManifest> {
  return extractVerifiedRelease({
    zip,
    version: o.version ?? '0.2.0-test',
    opId,
    dataDir,
    expect: o.expect ?? null,
    ...keys(o.sources),
  });
}

async function refusal(promise: Promise<unknown>): Promise<DomainError> {
  try {
    await promise;
  } catch (error) {
    if (isDomainError(error)) return error;
    throw error;
  }
  throw new Error('expected a DomainError');
}

const stagingDir = (version = '0.2.0-test'): string => releaseStagingPath(dataDir, version, opId);
const releaseRoot = (version = '0.2.0-test'): string => releaseStagingPath(dataDir, version, opId, 'release');

/** The package is refused with UPDATE_PACKAGE_INVALID `reason`, and the staging folder is gone. */
async function expectRefused(promise: Promise<unknown>, reason: string, version = '0.2.0-test'): Promise<DomainError> {
  const e = await refusal(promise);
  expect({ code: e.code, reason: e.meta?.['reason'] }).toEqual({ code: 'UPDATE_PACKAGE_INVALID', reason });
  expect(e.status).toBe(422);
  expect(await exists(stagingDir(version))).toBe(false);
  return e;
}

describe('readPackageManifest', () => {
  it('a signed package → its manifest; the root files are ignored and nothing is written', async () => {
    const { zip, manifest } = buildPackage();
    const p = await placePackage(zip);
    const m = await readPackageManifest(p, keys());
    expect(m.version).toBe('0.2.0-test');
    expect(m.releasedAt).toBe('2026-11-01');
    expect(m.schemaLatest).toBe('9001');
    expect(m.files.map((f) => f.path)).toEqual((manifest['files'] as { path: string }[]).map((f) => f.path));
    expect(await fsp.readdir(stagingDir())).toEqual(['package.zip']);
  });

  it('a signed package declaring bootProtocol 2 → 409 UPDATE_PRECHECK_FAILED boot_protocol with the manual-upgrade detail', async () => {
    const { zip } = buildPackage({ version: '0.3.0-test', meta: { bootProtocol: 2 } });
    const e = await refusal(readPackageManifest(await placePackage(zip), keys()));
    expect(e.code).toBe('UPDATE_PRECHECK_FAILED');
    expect(e.status).toBe(409);
    expect(e.meta).toMatchObject({ reason: 'boot_protocol', failures: ['boot_protocol'] });
    expect(e.detail).toContain('0.3.0-test');
    expect(e.detail).toMatch(/zip/);
    expect(e.detail).toMatch(/manual/i);
  });

  it('the same package with a broken signature → UPDATE_PACKAGE_INVALID signature (the signature comes first)', async () => {
    const good = buildPackage({ version: '0.3.0-test', meta: { bootProtocol: 2 } });
    const env = JSON.parse(readZip(good.zip).find((e) => e.path.endsWith('manifest.sig'))!.data.toString('utf8')) as { sig: string };
    const flipped = `${env.sig.slice(0, 10)}${env.sig[10] === 'A' ? 'B' : 'A'}${env.sig.slice(11)}`;
    const { zip } = buildPackage({ version: '0.3.0-test', meta: { bootProtocol: 2 }, sigText: JSON.stringify({ ...env, sig: flipped }) });
    const e = await refusal(readPackageManifest(await placePackage(zip), keys()));
    expect({ code: e.code, reason: e.meta?.['reason'] }).toEqual({ code: 'UPDATE_PACKAGE_INVALID', reason: 'signature' });
  });

  it('a manifest signed by dev-lic-1 (a licence key) → signature', async () => {
    const { zip } = buildPackage({ signer: 'dev-lic-1' });
    const e = await refusal(readPackageManifest(await placePackage(zip), keys()));
    expect(e.meta?.['reason']).toBe('signature');
  });

  it('Review Focus 3: a manifest signed by dev-rel-2 → signature once a kept document revokes it, though the package still trusts it', async () => {
    const { zip } = buildPackage({ signer: 'dev-rel-2' });
    const p = await placePackage(zip);
    expect((await readPackageManifest(p, keys())).version).toBe('0.2.0-test'); // not revoked: accepted
    const store: KeysetSource = { name: 'DATA_DIR/releases/keyset.json', docs: [REVOKE_REL_2] };
    const e = await refusal(readPackageManifest(p, keys([store])));
    expect(e.meta?.['reason']).toBe('signature');
  });

  it('a signed manifest missing a field → manifest; one whose version is not its folder → version', async () => {
    const files = defaultFiles('0.2.0-test');
    const noBuild = buildPackage({ files, meta: { buildId: '' } });
    expect((await refusal(readPackageManifest(await placePackage(noBuild.zip), keys()))).meta?.['reason']).toBe('manifest');
    const moved = buildPackage({ files, folder: '0.2.1-test' });
    expect((await refusal(readPackageManifest(await placePackage(moved.zip), keys()))).meta?.['reason']).toBe('version');
  });

  it('no keyset.json → keyset; no bundled release → manifest; two bundled releases → entry; not a zip → manifest', async () => {
    const files = defaultFiles('0.2.0-test');
    const noKeyset = buildPackage({ files, tamper: { 'keyset.json': null } });
    expect((await refusal(readPackageManifest(await placePackage(noKeyset.zip), keys()))).meta?.['reason']).toBe('keyset');

    const rootOnly = writeZip([{ path: 'app.js', data: Buffer.from('1') }]);
    expect((await refusal(readPackageManifest(await placePackage(rootOnly), keys()))).meta?.['reason']).toBe('manifest');

    const two = buildPackage({ extra: [{ path: 'bundled-release/0.1.0-test/server.mjs', data: Buffer.from('x') }] });
    expect((await refusal(readPackageManifest(await placePackage(two.zip), keys()))).meta?.['reason']).toBe('entry');

    expect((await refusal(readPackageManifest(await placePackage(Buffer.from('not a zip at all')), keys()))).meta?.['reason']).toBe('manifest');
  });
});

describe('extractVerifiedRelease', () => {
  it('a valid package → only the listed files, manifest.json, manifest.sig and .complete; verifyReleaseWithRoots(all) passes', async () => {
    const { zip } = buildPackage();
    const m = await extract(await placePackage(zip));
    expect(m.version).toBe('0.2.0-test');

    const dir = releaseRoot();
    expect(await exists(path.join(dir, '.complete'))).toBe(true);
    const verified = await verifyReleaseWithRoots(dir, ROOTS, { check: 'all' });
    expect(verified).toEqual(m);
    // The zip's root files stay out: one-click update never replaces app.js.
    expect(await exists(path.join(dir, 'app.js'))).toBe(false);
    expect(await exists(path.join(dir, 'package.json'))).toBe(false);
    expect((await fsp.readdir(dir)).sort()).toEqual(['.complete', 'keyset.json', 'manifest.json', 'manifest.sig', 'public', 'server.mjs']);
    expect(await fsp.readFile(path.join(dir, 'server.mjs'))).toEqual(defaultFiles('0.2.0-test')['server.mjs']);
    // The downloaded package is left where it was.
    expect(await exists(releaseStagingPath(dataDir, '0.2.0-test', opId, 'package.zip'))).toBe(true);
  });

  it('a feed entry equal to the signed manifest passes', async () => {
    const { zip, manifest } = buildPackage();
    expect((await extract(await placePackage(zip), { expect: feedEntryOf(manifest) })).version).toBe('0.2.0-test');
  });

  it('runs again over what a killed attempt left (a partial file, a stray one) and ends with the release alone', async () => {
    const { zip } = buildPackage();
    const p = await placePackage(zip);
    await fsp.mkdir(path.join(releaseRoot(), 'public'), { recursive: true });
    await fsp.writeFile(path.join(releaseRoot(), 'server.mjs'), 'half of it');
    await fsp.writeFile(path.join(releaseRoot(), 'public', 'stray.js'), 'left behind');
    await extract(p);
    expect(await exists(path.join(releaseRoot(), 'public', 'stray.js'))).toBe(false);
    await verifyReleaseWithRoots(releaseRoot(), ROOTS, { check: 'all' });
    // And once more over a complete one.
    await extract(p);
    await verifyReleaseWithRoots(releaseRoot(), ROOTS, { check: 'all' });
  });

  it('an entry bundled-release/0.2.0-test/../x → entry', async () => {
    const { zip } = buildPackage({ extra: [{ path: 'bundled-release/0.2.0-test/zz/x', data: Buffer.from('escape') }] });
    await expectRefused(extract(await placePackage(renamed(zip, 'bundled-release/0.2.0-test/zz/x', 'bundled-release/0.2.0-test/../x'))), 'entry');
  });

  it('an extra file under the release folder that the manifest does not list → entry', async () => {
    const { zip } = buildPackage({ tamper: { 'public/admin/assets/extra.js': Buffer.from('unlisted') } });
    await expectRefused(extract(await placePackage(zip)), 'entry');
  });

  it('a listed file missing from the zip → entry', async () => {
    const { zip } = buildPackage({ tamper: { 'public/admin/index.html': null } });
    await expectRefused(extract(await placePackage(zip)), 'entry');
  });

  it('a changed server.mjs → hash, whether its size changed or not', async () => {
    const original = defaultFiles('0.2.0-test')['server.mjs']!;
    const sameSize = Buffer.from(original);
    sameSize[10] = sameSize[10] === 0x41 ? 0x42 : 0x41;
    // Caught while it is written (the hash of its bytes, `meta.path`), not only by the final verification.
    const e = await expectRefused(extract(await placePackage(buildPackage({ tamper: { 'server.mjs': sameSize } }).zip)), 'hash');
    expect(e.meta?.['path']).toBe('server.mjs');
    await expectRefused(extract(await placePackage(buildPackage({ tamper: { 'server.mjs': Buffer.concat([original, Buffer.from('//')]) } }).zip)), 'hash');
  });

  it('a deflate entry at ratio 11× → bomb; one at about 9× is extracted', async () => {
    // The package's entries written again with big.js deflated and the rest stored, so its ratio does not depend on
    // the release zip writer's choice of method (a writer may store what would deflate past 10×).
    const at = (ratio: number) => {
      const files = { ...defaultFiles('0.2.0-test'), 'public/admin/assets/big.js': deflatesAbout(ratio) };
      const built = buildPackage({ files });
      const zip = rawZip(readZip(built.zip).map((e) => ({ name: e.path, data: e.data, method: e.path.endsWith('/big.js') ? 8 : 0 })));
      const entry = readZip(zip).find((e) => e.path.endsWith('/big.js'))!;
      return { zip, ratio: entry.data.byteLength / entry.compressedSize, method: entry.method };
    };
    const eleven = at(11);
    expect(eleven.method).toBe(8);
    expect(eleven.ratio).toBeGreaterThan(10.5);
    expect(eleven.ratio).toBeLessThan(11.5);
    await expectRefused(extract(await placePackage(eleven.zip)), 'bomb');

    const nine = at(9);
    expect(nine.ratio).toBeLessThan(10);
    opId = newId();
    expect((await extract(await placePackage(nine.zip))).version).toBe('0.2.0-test');
  });

  it('a manifest signed by dev-lic-1 → signature', async () => {
    await expectRefused(extract(await placePackage(buildPackage({ signer: 'dev-lic-1' }).zip)), 'signature');
  });

  it('Review Focus 3: a manifest signed by dev-rel-2 with the store revoking it → signature', async () => {
    const store: KeysetSource = { name: 'DATA_DIR/releases/keyset.json', docs: [REVOKE_REL_2] };
    await expectRefused(extract(await placePackage(buildPackage({ signer: 'dev-rel-2' }).zip), { sources: [store] }), 'signature');
  });

  it('a feed entry whose releasedAt differs → mismatch', async () => {
    const { zip, manifest } = buildPackage();
    const e = await expectRefused(extract(await placePackage(zip), { expect: feedEntryOf(manifest, { releasedAt: '2026-11-02' }) }), 'mismatch');
    expect(e.meta?.['field']).toBe('releasedAt');
  });

  it('a zip of 0.3 when 0.2 was expected → version', async () => {
    const { zip } = buildPackage({ version: '0.3.0-test' });
    await expectRefused(extract(await placePackage(zip)), 'version');
  });

  it('a signed bootProtocol 2 package → UPDATE_PRECHECK_FAILED boot_protocol, the staging folder gone', async () => {
    const { zip } = buildPackage({ meta: { bootProtocol: 2 } });
    const e = await refusal(extract(await placePackage(zip)));
    expect({ code: e.code, reason: e.meta?.['reason'] }).toEqual({ code: 'UPDATE_PRECHECK_FAILED', reason: 'boot_protocol' });
    expect(await exists(stagingDir())).toBe(false);
  });

  it('disk-full:releases:2 → DISK_QUOTA and the staging folder gone', async () => {
    const p = await placePackage(buildPackage().zip);
    process.env['ALTIS_TEST_FAULT'] = 'disk-full:releases:2';
    resetTestFaults();
    const e = await refusal(extract(p));
    expect(e.code).toBe('DISK_QUOTA');
    expect(await exists(stagingDir())).toBe(false);
  });
});
