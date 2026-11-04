import { Buffer } from 'node:buffer';
import { createHash, type KeyObject } from 'node:crypto';
import fsp from 'node:fs/promises';
import os from 'node:os';
import path from 'node:path';
import { afterAll, beforeAll, describe, expect, it, vi } from 'vitest';
import { signDetached, type Envelope } from '../src/envelope.js';
import { generateKeyPair, type KeyUse, type TrustedKey } from '../src/keys.js';
import { execFileSync } from 'node:child_process';
import { KEYSET_MAX_DOCS, KEYSET_MAX_DOC_BYTES, resolveTrustedKeys, type KeysetDoc, type KeysetReport } from '../src/keyset.js';
import { KEYSET_FILE, KEYSET_MAX_FILE_BYTES } from '../src/keyset-file.js';
import {
  COMPLETE_FILE,
  MANIFEST_FILE,
  RELEASE_TYP,
  SIGNATURE_FILE,
  buildManifest,
  readReleaseKeyset,
  validateManifest,
  verifyRelease,
  verifyReleaseWithRoots,
  type ReleaseManifest,
} from '../src/manifest.js';

type TestKey = { privateKey: KeyObject; trusted: TrustedKey };

function makeKey(kid: string, use: KeyUse): TestKey {
  const { privateKey, pub } = generateKeyPair();
  return { privateKey, trusted: { kid, use, pub } };
}

const rel1 = makeKey('dev-rel-1', 'release');
const rel2 = makeKey('dev-rel-2', 'release');
const lic1 = makeKey('dev-lic-1', 'license');
const stranger = makeKey('dev-rel-9', 'release');
const TRUSTED = [rel1.trusted, rel2.trusted, lic1.trusted];
const rootKey = makeKey('dev-root-1', 'root');
const ROOTS = [rootKey.trusted];

/** A keyset document `{raw, env}` signed as altis-keyset/1 by `signer` (a root key unless told otherwise). */
function keysetDoc(payload: unknown, signer: TestKey = rootKey): KeysetDoc {
  return {
    raw: JSON.stringify(payload),
    env: signDetached(payload, { typ: 'altis-keyset/1', kid: signer.trusted.kid, privateKey: signer.privateKey }),
  };
}

/** The root-signed document that trusts rel1, rel2 and lic1. */
const ADD_RELEASE_KEYS = keysetDoc({ seq: 1, keys: [rel1.trusted, rel2.trusted, lic1.trusted], revokedKids: [] });

const META: Omit<ReleaseManifest, 'files'> = {
  version: '0.1.0-test',
  buildId: 'abc1234',
  bootProtocol: 1,
  releasedAt: '2026-10-27',
  schemaLatest: '0003',
  minCodeVersionAfter: '0.2.0',
  minUpgradeFrom: '0.1.0',
  minNode: '22.16.0',
  minDb: { mysql: '8.0', mariadb: '10.6', postgres: '15' },
};

/** 40 bytes: bytes 10-17 are "XXXXXXXX". */
const SERVER_SOURCE = '0123456789XXXXXXXXABCDEFGHIJKLMNOPQRSTU\n';
const CSS_SOURCE = 'body { margin: 0 }\n';

const sha256 = (bytes: Uint8Array | string): string => createHash('sha256').update(bytes).digest('hex');

let root: string;
let counter = 0;

beforeAll(async () => {
  root = await fsp.mkdtemp(path.join(os.tmpdir(), 'altis-manifest-'));
});

afterAll(async () => {
  await fsp.rm(root, { recursive: true, force: true });
});

/** A fresh directory holding `files` (POSIX path -> content). */
async function makeDir(files: Record<string, string | Buffer>): Promise<string> {
  const dir = path.join(root, `release-${counter++}`);
  await fsp.mkdir(dir, { recursive: true });
  for (const [rel, content] of Object.entries(files)) {
    const file = path.join(dir, ...rel.split('/'));
    await fsp.mkdir(path.dirname(file), { recursive: true });
    await fsp.writeFile(file, content);
  }
  return dir;
}

const BASE_FILES = { 'server.mjs': SERVER_SOURCE, 'public/a.css': CSS_SOURCE };

type Built = { dir: string; manifest: ReleaseManifest; env: Envelope };

/** Builds, signs (manifest.json, manifest.sig) and completes a release directory. */
async function makeRelease(
  files: Record<string, string | Buffer> = BASE_FILES,
  o: { key?: TestKey; wm?: Record<string, { offset: number; length: number }[]>; complete?: boolean } = {},
): Promise<Built> {
  const dir = await makeDir(files);
  const manifest = await buildManifest(dir, META, o.wm === undefined ? undefined : { wm: o.wm });
  const key = o.key ?? rel1;
  const env = signDetached(manifest, { typ: RELEASE_TYP, kid: key.trusted.kid, privateKey: key.privateKey });
  await fsp.writeFile(path.join(dir, MANIFEST_FILE), JSON.stringify(manifest, null, 2));
  await fsp.writeFile(path.join(dir, SIGNATURE_FILE), JSON.stringify(env));
  if (o.complete !== false) await fsp.writeFile(path.join(dir, COMPLETE_FILE), '');
  return { dir, manifest, env };
}

/** Replaces manifest.json and manifest.sig of `dir` by `payload` and its signature. */
async function signPayload(dir: string, payload: unknown, key: TestKey = rel1): Promise<void> {
  const env = signDetached(payload, { typ: RELEASE_TYP, kid: key.trusted.kid, privateKey: key.privateKey });
  await fsp.writeFile(path.join(dir, MANIFEST_FILE), JSON.stringify(payload));
  await fsp.writeFile(path.join(dir, SIGNATURE_FILE), JSON.stringify(env));
}

/** Awaits `promise`, expecting it to reject with exactly `RELEASE_INVALID:<reason>`. */
async function expectInvalid(promise: Promise<unknown>, reason: string): Promise<Error> {
  let error: unknown;
  try {
    await promise;
  } catch (err) {
    error = err;
  }
  expect(error).toBeInstanceOf(Error);
  expect((error as Error).message).toBe(`RELEASE_INVALID:${reason}`);
  return error as Error;
}

const ALL = { check: 'all' } as const;
const EXECUTED = { check: 'executed' } as const;

async function flipByte(file: string, index: number): Promise<void> {
  const bytes = await fsp.readFile(file);
  bytes.writeUInt8(bytes.readUInt8(index) ^ 0x01, index);
  await fsp.writeFile(file, bytes);
}

describe('buildManifest', () => {
  it('lists every file with sha256 and size, sorted by path, and carries the metadata', async () => {
    const dir = await makeDir({ 'public/a.css': CSS_SOURCE, 'server.mjs': SERVER_SOURCE });
    const manifest = await buildManifest(dir, META);
    expect(manifest).toEqual({
      ...META,
      files: [
        { path: 'public/a.css', sha256: sha256(CSS_SOURCE), size: CSS_SOURCE.length },
        { path: 'server.mjs', sha256: sha256(SERVER_SOURCE), size: SERVER_SOURCE.length },
      ],
    });
    expect(Object.keys(manifest)).toEqual([...Object.keys(META), 'files']);
  });

  it('sorts by the code units of the POSIX path', async () => {
    const dir = await makeDir({
      'b.js': 'b',
      'a/z.js': 'z',
      'a.js': 'a',
      'Z.js': 'Z',
      'public/x/y.css': 'y',
      'public/x.css': 'x',
      'é.txt': 'e',
      'z.txt': 'z',
    });
    const manifest = await buildManifest(dir, META);
    expect(manifest.files.map((f) => f.path)).toEqual([
      'Z.js',
      'a.js',
      'a/z.js',
      'b.js',
      'public/x.css',
      'public/x/y.css',
      'z.txt',
      'é.txt',
    ]);
  });

  it('is deterministic', async () => {
    const dir = await makeDir(BASE_FILES);
    expect(JSON.stringify(await buildManifest(dir, META))).toBe(JSON.stringify(await buildManifest(dir, META)));
  });

  it('excludes manifest.json, manifest.sig and .complete in the release root, and only there', async () => {
    const dir = await makeDir({
      ...BASE_FILES,
      [MANIFEST_FILE]: '{}',
      [SIGNATURE_FILE]: '{}',
      [COMPLETE_FILE]: '',
      'public/manifest.json': 'nested',
      'public/.complete': 'nested',
    });
    const manifest = await buildManifest(dir, META);
    expect(manifest.files.map((f) => f.path)).toEqual([
      'public/.complete',
      'public/a.css',
      'public/manifest.json',
      'server.mjs',
    ]);
  });

  it('hashes empty files and files larger than one read chunk', async () => {
    const big = Buffer.alloc(200_003, 0x61);
    big.writeUInt32LE(0xdeadbeef, 100_000);
    const dir = await makeDir({ 'empty.txt': '', 'big.bin': big });
    const { files } = await buildManifest(dir, META);
    expect(files).toEqual([
      { path: 'big.bin', sha256: sha256(big), size: 200_003 },
      { path: 'empty.txt', sha256: sha256(''), size: 0 },
    ]);
  });

  it('hashes with the wm ranges zero-filled, also across read chunk boundaries', async () => {
    const big = Buffer.alloc(200_000);
    for (let i = 0; i < big.length; i++) big[i] = (i * 7 + 3) & 0xff;
    const ranges = [
      { offset: 10, length: 8 },
      { offset: 65_530, length: 20 },
      { offset: 131_072, length: 65_536 },
      { offset: 199_999, length: 1 },
    ];
    const dir = await makeDir({ 'server.mjs': SERVER_SOURCE, 'big.bin': big });
    const manifest = await buildManifest(dir, META, { wm: { 'server.mjs': [ranges[0]!], 'big.bin': ranges } });
    const zeroed = Buffer.from(big);
    for (const r of ranges) zeroed.fill(0, r.offset, r.offset + r.length);
    const serverZeroed = Buffer.from(SERVER_SOURCE);
    serverZeroed.fill(0, 10, 18);
    expect(manifest.files).toEqual([
      { path: 'big.bin', sha256: sha256(zeroed), size: 200_000, wm: ranges },
      { path: 'server.mjs', sha256: sha256(serverZeroed), size: SERVER_SOURCE.length, wm: [{ offset: 10, length: 8 }] },
    ]);
    expect(manifest.files[0]!.sha256).not.toBe(sha256(big));
  });

  it('omits wm for files without ranges and for empty range lists', async () => {
    const dir = await makeDir(BASE_FILES);
    const { files } = await buildManifest(dir, META, { wm: { 'server.mjs': [] } });
    for (const file of files) expect(file).not.toHaveProperty('wm');
  });

  it('ignores other properties of a wm range and of the metadata, and leaves them out', async () => {
    const dir = await makeDir(BASE_FILES);
    const range = { offset: 4, length: 2, note: 'x' };
    const meta = { ...META, futureField: { a: 1 }, minDb: { ...META.minDb, sqlite: '3.45' } };
    const manifest = await buildManifest(dir, meta, { wm: { 'public/a.css': [range] } });
    expect(manifest).toEqual({
      ...META,
      files: [
        { path: 'public/a.css', sha256: expect.stringMatching(/^[0-9a-f]{64}$/) as string, size: CSS_SOURCE.length, wm: [{ offset: 4, length: 2 }] },
        { path: 'server.mjs', sha256: sha256(SERVER_SOURCE), size: SERVER_SOURCE.length },
      ],
    });
    expect(JSON.stringify(manifest)).not.toMatch(/futureField|sqlite|note/);
  });

  it.each([
    ['a range past the end of the file', { offset: 35, length: 6 }],
    ['an offset past the end of the file', { offset: 41, length: 1 }],
    ['a zero length', { offset: 4, length: 0 }],
    ['a negative offset', { offset: -1, length: 2 }],
    ['a fractional length', { offset: 4, length: 1.5 }],
  ])('refuses %s', async (_name, range) => {
    const dir = await makeDir(BASE_FILES);
    await expect(buildManifest(dir, META, { wm: { 'server.mjs': [range as never] } })).rejects.toThrow(
      /^MANIFEST_INVALID:files\[1\]\.wm\[0\]/,
    );
  });

  it('refuses overlapping or unsorted wm ranges', async () => {
    const dir = await makeDir(BASE_FILES);
    const overlap = [{ offset: 4, length: 8 }, { offset: 11, length: 2 }];
    const unsorted = [{ offset: 20, length: 2 }, { offset: 4, length: 2 }];
    for (const wm of [overlap, unsorted]) {
      await expect(buildManifest(dir, META, { wm: { 'server.mjs': wm } })).rejects.toThrow(
        /^MANIFEST_INVALID:files\[1\]\.wm\[1\]/,
      );
    }
    // touching ranges are fine
    await expect(
      buildManifest(dir, META, { wm: { 'server.mjs': [{ offset: 4, length: 8 }, { offset: 12, length: 2 }] } }),
    ).resolves.toBeDefined();
  });

  it('refuses wm ranges for a file that is not in the directory', async () => {
    const dir = await makeDir(BASE_FILES);
    await expect(buildManifest(dir, META, { wm: { 'nope.js': [{ offset: 0, length: 1 }] } })).rejects.toThrow(
      'MANIFEST_INVALID:wm:nope.js',
    );
  });

  it('refuses invalid metadata', async () => {
    const dir = await makeDir(BASE_FILES);
    const bad = (patch: Record<string, unknown>) => ({ ...META, ...patch }) as unknown as typeof META;
    const cases: [Record<string, unknown>, string][] = [
      [{ version: '1.0' }, 'version'],
      [{ version: 1 }, 'version'],
      [{ buildId: '' }, 'buildId'],
      [{ bootProtocol: 2 }, 'bootProtocol'],
      [{ releasedAt: '2026-02-30' }, 'releasedAt'],
      [{ releasedAt: '27-10-2026' }, 'releasedAt'],
      [{ schemaLatest: 3 }, 'schemaLatest'],
      [{ minCodeVersionAfter: '' }, 'minCodeVersionAfter'],
      [{ minUpgradeFrom: undefined }, 'minUpgradeFrom'],
      [{ minNode: null }, 'minNode'],
      [{ minDb: 'mysql 8.0' }, 'minDb'],
      [{ minDb: { mysql: '8.0', mariadb: '10.6' } }, 'minDb.postgres'],
      [{ minDb: { mysql: '8.0', mariadb: '10.6', postgres: 15 } }, 'minDb.postgres'],
    ];
    for (const [patch, field] of cases) {
      await expect(buildManifest(dir, bad(patch))).rejects.toThrow(new RegExp(`^MANIFEST_INVALID:${field}$`));
    }
    await expect(buildManifest(dir, null as never)).rejects.toThrow('MANIFEST_INVALID:meta');
  });

  it('refuses a directory that holds a symbolic link', async () => {
    if (process.platform === 'win32') return;
    const dir = await makeDir(BASE_FILES);
    await fsp.symlink(path.join(dir, 'server.mjs'), path.join(dir, 'link.mjs'));
    await expect(buildManifest(dir, META)).rejects.toThrow('MANIFEST_INVALID:unsupported:link.mjs');
  });

  it('refuses file names that are not portable release paths', async () => {
    if (process.platform === 'win32') return;
    const dir = await makeDir({ ...BASE_FILES, 'back\\slash.js': 'x' });
    await expect(buildManifest(dir, META)).rejects.toThrow('MANIFEST_INVALID:path:back\\slash.js');
  });

  it('refuses a directory that does not exist', async () => {
    await expect(buildManifest(path.join(root, 'missing'), META)).rejects.toThrow(/ENOENT/);
  });
});

describe('verifyRelease: success', () => {
  it('accepts a signed release with check all and with check executed, and returns the manifest', async () => {
    const { dir, manifest } = await makeRelease();
    expect(await verifyRelease(dir, TRUSTED, ALL)).toEqual(manifest);
    expect(await verifyRelease(dir, TRUSTED, EXECUTED)).toEqual(manifest);
    expect(manifest.files.map((f) => f.path)).toEqual(['public/a.css', 'server.mjs']);
  });

  it('accepts a manifest signed by any trusted release key', async () => {
    const { dir } = await makeRelease(BASE_FILES, { key: rel2 });
    await expect(verifyRelease(dir, TRUSTED, ALL)).resolves.toBeDefined();
  });

  it('accepts a release signed by a key that a root-signed keyset document added', async () => {
    const { keys } = resolveTrustedKeys(ROOTS, [keysetDoc({ seq: 1, keys: [stranger.trusted], revokedKids: [] })]);
    const { dir } = await makeRelease(BASE_FILES, { key: stranger });
    await expect(verifyRelease(dir, keys, ALL)).resolves.toBeDefined();
    await expect(verifyRelease(dir, ROOTS, ALL)).rejects.toThrow('RELEASE_INVALID:signature');
  });

  it('rejects a release signed by a key that a keyset revoked', async () => {
    const revoke = keysetDoc({ seq: 2, keys: [], revokedKids: ['dev-rel-2'] });
    const { keys } = resolveTrustedKeys(ROOTS, [ADD_RELEASE_KEYS, revoke]);
    const { dir } = await makeRelease(BASE_FILES, { key: rel2 });
    await expectInvalid(verifyRelease(dir, keys, ALL), 'signature');
  });

  it('a root key never signs a release itself', async () => {
    const { dir } = await makeRelease(BASE_FILES, { key: rootKey });
    await expectInvalid(verifyRelease(dir, [...ROOTS, ...TRUSTED], ALL), 'signature');
  });

  it('defaults the executed files to server.mjs and accepts a custom list', async () => {
    const { dir } = await makeRelease();
    await flipByte(path.join(dir, 'public', 'a.css'), 0);
    await expect(verifyRelease(dir, TRUSTED, EXECUTED)).resolves.toBeDefined();
    await expectInvalid(verifyRelease(dir, TRUSTED, { check: 'executed', executed: ['server.mjs', 'public/a.css'] }), 'hash:public/a.css');
    await expect(verifyRelease(dir, TRUSTED, { check: 'executed', executed: ['server.mjs'] })).resolves.toBeDefined();
  });

  it('ignores the content of .complete', async () => {
    const { dir } = await makeRelease();
    await fsp.writeFile(path.join(dir, COMPLETE_FILE), 'anything at all');
    await expect(verifyRelease(dir, TRUSTED, ALL)).resolves.toBeDefined();
  });

  it('verifies files larger than one read chunk', async () => {
    const big = Buffer.alloc(150_000, 0x41);
    const { dir } = await makeRelease({ ...BASE_FILES, 'public/big.bin': big });
    await expect(verifyRelease(dir, TRUSTED, ALL)).resolves.toBeDefined();
    await flipByte(path.join(dir, 'public', 'big.bin'), 140_000);
    await expectInvalid(verifyRelease(dir, TRUSTED, ALL), 'hash:public/big.bin');
  });
});

describe('verifyReleaseWithRoots (ruling R65: what app.js, doctor and the release build check)', () => {
  /** A release (signed by `o.key`, default rel1) that ships `keyset` as keyset.json: documents, or raw text. */
  function makeRootedRelease(keyset: unknown, o: { key?: TestKey; complete?: boolean } = {}): Promise<Built> {
    const text = typeof keyset === 'string' ? keyset : JSON.stringify(keyset, null, 2);
    return makeRelease({ ...BASE_FILES, [KEYSET_FILE]: text }, o);
  }

  it("fresh install: the release's own root-signed keyset.json trusts its signer, with the roots alone", async () => {
    const { dir, manifest } = await makeRootedRelease([ADD_RELEASE_KEYS]);
    expect(manifest.files.map((f) => f.path)).toEqual(['keyset.json', 'public/a.css', 'server.mjs']);
    await expect(verifyReleaseWithRoots(dir, ROOTS, ALL)).resolves.toEqual(manifest);
    await expect(verifyReleaseWithRoots(dir, ROOTS, EXECUTED)).resolves.toEqual(manifest);
    // The roots alone never sign a release.
    await expectInvalid(verifyRelease(dir, ROOTS, ALL), 'signature');
  });

  it('a release cannot vouch for itself: a keyset.json signed by a release key counts for nothing', async () => {
    const selfSigned = keysetDoc({ seq: 1, keys: [stranger.trusted], revokedKids: [] }, stranger);
    const { dir } = await makeRootedRelease([selfSigned], { key: stranger });
    await expectInvalid(verifyReleaseWithRoots(dir, ROOTS, ALL), 'signature');
    // Not even when the forger is a trusted release key.
    const byRel1 = keysetDoc({ seq: 9, keys: [stranger.trusted], revokedKids: [] }, rel1);
    const other = await makeRootedRelease([ADD_RELEASE_KEYS, byRel1], { key: stranger });
    await expectInvalid(verifyReleaseWithRoots(other.dir, ROOTS, ALL), 'signature');
  });

  it('documents kept outside the release (o.docs) count together with its own', async () => {
    const { dir } = await makeRootedRelease([]);
    await expectInvalid(verifyReleaseWithRoots(dir, ROOTS, ALL), 'signature');
    await expect(verifyReleaseWithRoots(dir, ROOTS, { ...ALL, sources: [{ name: 'data', docs: [ADD_RELEASE_KEYS] }] })).resolves.toBeDefined();
  });

  it('an outside root-signed document that revokes the signer makes the release invalid', async () => {
    const { dir } = await makeRootedRelease([ADD_RELEASE_KEYS]);
    const revoke = keysetDoc({ seq: 1, keys: [], revokedKids: ['dev-rel-1'] });
    await expectInvalid(verifyReleaseWithRoots(dir, ROOTS, { ...EXECUTED, sources: [{ name: 'data', docs: [revoke] }] }), 'signature');
    // A release key cannot revoke anything.
    const forged = keysetDoc({ seq: 99, keys: [], revokedKids: ['dev-rel-1'] }, rel2);
    await expect(verifyReleaseWithRoots(dir, ROOTS, { ...EXECUTED, sources: [{ name: 'data', docs: [forged] }] })).resolves.toBeDefined();
  });

  it('onResolved sees the resolution, rejections named by source (the release itself last), also when the check then fails', async () => {
    const forged = keysetDoc({ seq: 1, keys: [], revokedKids: [] }, rel1);
    const shapeless = keysetDoc({ seq: 0, keys: [], revokedKids: [] });
    const { dir } = await makeRootedRelease([ADD_RELEASE_KEYS, shapeless]);
    const seen: KeysetReport[] = [];
    await verifyReleaseWithRoots(dir, ROOTS, { ...ALL, sources: [{ name: 'data', docs: [forged] }], onResolved: (r) => seen.push(r) });
    expect(seen).toHaveLength(1);
    expect(seen[0]!.rejected).toEqual([
      { source: 'data', index: 0, reason: 'SIG_INVALID:kid' },
      { source: 'release', index: 1, reason: 'shape' },
    ]);
    expect(seen[0]!.keys.map((k) => k.kid)).toEqual(['dev-root-1', 'dev-lic-1', 'dev-rel-1', 'dev-rel-2']);

    const revoke = keysetDoc({ seq: 2, keys: [], revokedKids: ['dev-rel-1'] });
    await expectInvalid(
      verifyReleaseWithRoots(dir, ROOTS, { ...ALL, sources: [{ name: 'data', docs: [revoke] }], onResolved: (r) => seen.push(r) }),
      'signature',
    );
    expect(seen).toHaveLength(2);
    expect(seen[1]!.keys.map((k) => k.kid)).not.toContain('dev-rel-1');
  });

  it('keyset.json missing, not strict JSON, not a list of {raw, env}, a directory or a symbolic link: RELEASE_INVALID:keyset', async () => {
    const missing = await makeRelease();
    await expectInvalid(verifyReleaseWithRoots(missing.dir, ROOTS, ALL), 'keyset');
    const bare = JSON.stringify(ADD_RELEASE_KEYS);
    for (const text of ['[{"raw":', '[{"raw":"x","env":{},"raw":"y"}]', '"x"', '{}', bare, '\u00ff\u00fe']) {
      const { dir } = await makeRootedRelease(text);
      const error = await expectInvalid(verifyReleaseWithRoots(dir, ROOTS, EXECUTED), 'keyset');
      expect(error.cause).toBeDefined();
    }
    const asDirectory = await makeRelease();
    await fsp.mkdir(path.join(asDirectory.dir, KEYSET_FILE));
    await expectInvalid(verifyReleaseWithRoots(asDirectory.dir, ROOTS, EXECUTED), 'keyset');
    if (process.platform === 'win32') return;
    const linked = await makeRootedRelease([ADD_RELEASE_KEYS]);
    const copy = path.join(root, `keyset-copy-${counter++}`);
    await fsp.copyFile(path.join(linked.dir, KEYSET_FILE), copy);
    await fsp.rm(path.join(linked.dir, KEYSET_FILE));
    await fsp.symlink(copy, path.join(linked.dir, KEYSET_FILE));
    await expectInvalid(verifyReleaseWithRoots(linked.dir, ROOTS, EXECUTED), 'keyset');
  });

  it('a bad entry is skipped on its own: the other documents of the file still count', async () => {
    const { dir } = await makeRootedRelease([1, { raw: 'x' }, ADD_RELEASE_KEYS]);
    const seen: KeysetReport[] = [];
    await expect(verifyReleaseWithRoots(dir, ROOTS, { ...ALL, onResolved: (r) => seen.push(r) })).resolves.toBeDefined();
    expect(seen[0]!.rejected.map((r) => [r.index, r.reason])).toEqual([
      [0, 'SIG_INVALID:envelope'],
      [1, 'SIG_INVALID:envelope'],
    ]);
  });

  it(`the frozen limits (R65c): ${KEYSET_MAX_DOCS} documents, ${KEYSET_MAX_DOC_BYTES} bytes each, ${KEYSET_MAX_FILE_BYTES} bytes in all`, async () => {
    const atLimit = await makeRootedRelease(new Array(KEYSET_MAX_DOCS).fill(ADD_RELEASE_KEYS));
    await expect(verifyReleaseWithRoots(atLimit.dir, ROOTS, ALL)).resolves.toBeDefined();
    const tooMany = await makeRootedRelease(new Array(KEYSET_MAX_DOCS + 1).fill(ADD_RELEASE_KEYS));
    await expectInvalid(verifyReleaseWithRoots(tooMany.dir, ROOTS, ALL), 'keyset');
    const big = { raw: ADD_RELEASE_KEYS.raw + ' '.repeat(KEYSET_MAX_DOC_BYTES), env: ADD_RELEASE_KEYS.env };
    const tooLarge = await makeRootedRelease([ADD_RELEASE_KEYS, big]);
    await expectInvalid(verifyReleaseWithRoots(tooLarge.dir, ROOTS, ALL), 'keyset');
    const huge = await makeRootedRelease([ADD_RELEASE_KEYS]);
    await fsp.writeFile(path.join(huge.dir, KEYSET_FILE), `[${' '.repeat(KEYSET_MAX_FILE_BYTES)}]`);
    await expectInvalid(verifyReleaseWithRoots(huge.dir, ROOTS, EXECUTED), 'keyset');
  });

  it('a FIFO in place of keyset.json, manifest.json or manifest.sig fails at once instead of hanging', async () => {
    if (process.platform === 'win32') return;
    for (const [name, reason] of [
      [KEYSET_FILE, 'keyset'],
      [MANIFEST_FILE, 'signature'],
      [SIGNATURE_FILE, 'signature'],
    ] as const) {
      const { dir } = await makeRootedRelease([ADD_RELEASE_KEYS]);
      await fsp.rm(path.join(dir, name));
      execFileSync('mkfifo', [path.join(dir, name)]);
      await expectInvalid(verifyReleaseWithRoots(dir, ROOTS, EXECUTED), reason);
    }
  }, 5_000);

  it('refuseDevKids (production builds, R65b): a root-signed document that trusts a dev- kid counts for nothing', async () => {
    const devSigner = makeKey('dev-rel-7', 'release');
    const addDev = keysetDoc({ seq: 1, keys: [devSigner.trusted], revokedKids: [] });
    const { dir } = await makeRootedRelease([addDev], { key: devSigner });
    await expect(verifyReleaseWithRoots(dir, ROOTS, EXECUTED)).resolves.toBeDefined();
    const seen: KeysetReport[] = [];
    await expectInvalid(verifyReleaseWithRoots(dir, ROOTS, { ...EXECUTED, refuseDevKids: true, onResolved: (r) => seen.push(r) }), 'signature');
    expect(seen[0]!.rejected).toEqual([{ source: 'release', index: 0, reason: 'dev' }]);
  });

  it('incomplete is reported first, before the keyset', async () => {
    const { dir } = await makeRelease(BASE_FILES, { complete: false });
    await expectInvalid(verifyReleaseWithRoots(dir, ROOTS, ALL), 'incomplete');
    await expectInvalid(verifyReleaseWithRoots(path.join(root, 'nowhere'), ROOTS, ALL), 'incomplete');
  });

  it("keyset.json is trusted by its signatures: changed, it still verifies under 'executed', and fails 'all' as a hash", async () => {
    const { dir } = await makeRootedRelease([ADD_RELEASE_KEYS]);
    const revoke = keysetDoc({ seq: 2, keys: [], revokedKids: ['dev-rel-2'] });
    await fsp.writeFile(path.join(dir, KEYSET_FILE), JSON.stringify([ADD_RELEASE_KEYS, revoke]));
    await expect(verifyReleaseWithRoots(dir, ROOTS, EXECUTED)).resolves.toBeDefined();
    await expectInvalid(verifyReleaseWithRoots(dir, ROOTS, ALL), 'hash:keyset.json');
  });

  it('readReleaseKeyset returns the documents of <dir>/keyset.json', async () => {
    const { dir } = await makeRootedRelease([ADD_RELEASE_KEYS]);
    expect(await readReleaseKeyset(dir)).toEqual([ADD_RELEASE_KEYS]);
    await expectInvalid(readReleaseKeyset(path.join(root, 'nowhere')), 'keyset');
  });

  it('refuses invalid arguments with a TypeError', async () => {
    const { dir } = await makeRootedRelease([ADD_RELEASE_KEYS]);
    await expect(verifyReleaseWithRoots('', ROOTS, ALL)).rejects.toThrow(TypeError);
    await expect(verifyReleaseWithRoots(dir, ROOTS, null as unknown as typeof ALL)).rejects.toThrow(TypeError);
    await expect(verifyReleaseWithRoots(dir, ROOTS, { check: 'some' } as unknown as typeof ALL)).rejects.toThrow(TypeError);
    await expect(verifyReleaseWithRoots(dir, ROOTS, { ...ALL, sources: {} as unknown as [] })).rejects.toThrow(TypeError);
    await expect(verifyReleaseWithRoots(dir, TRUSTED, ALL)).rejects.toThrow(TypeError);
  });
});

describe('verifyRelease: incomplete', () => {
  it('without .complete', async () => {
    const { dir } = await makeRelease(BASE_FILES, { complete: false });
    await expectInvalid(verifyRelease(dir, TRUSTED, ALL), 'incomplete');
    await expectInvalid(verifyRelease(dir, TRUSTED, EXECUTED), 'incomplete');
  });

  it('when the directory does not exist', async () => {
    await expectInvalid(verifyRelease(path.join(root, 'nowhere'), TRUSTED, ALL), 'incomplete');
  });

  it('when .complete is a directory', async () => {
    const { dir } = await makeRelease(BASE_FILES, { complete: false });
    await fsp.mkdir(path.join(dir, COMPLETE_FILE));
    await expectInvalid(verifyRelease(dir, TRUSTED, ALL), 'incomplete');
  });

  it('is reported before a bad signature or a bad hash', async () => {
    const { dir } = await makeRelease(BASE_FILES, { key: stranger, complete: false });
    await flipByte(path.join(dir, 'server.mjs'), 0);
    await expectInvalid(verifyRelease(dir, TRUSTED, ALL), 'incomplete');
  });
});

describe('verifyRelease: hash', () => {
  it('one byte of server.mjs changed', async () => {
    const { dir } = await makeRelease();
    await flipByte(path.join(dir, 'server.mjs'), 20);
    await expectInvalid(verifyRelease(dir, TRUSTED, ALL), 'hash:server.mjs');
    await expectInvalid(verifyRelease(dir, TRUSTED, EXECUTED), 'hash:server.mjs');
  });

  it('server.mjs longer or shorter, same prefix', async () => {
    const { dir } = await makeRelease();
    await fsp.writeFile(path.join(dir, 'server.mjs'), SERVER_SOURCE + '\n');
    await expectInvalid(verifyRelease(dir, TRUSTED, EXECUTED), 'hash:server.mjs');
    await fsp.writeFile(path.join(dir, 'server.mjs'), SERVER_SOURCE.slice(0, -1));
    await expectInvalid(verifyRelease(dir, TRUSTED, EXECUTED), 'hash:server.mjs');
    await fsp.writeFile(path.join(dir, 'server.mjs'), '');
    await expectInvalid(verifyRelease(dir, TRUSTED, EXECUTED), 'hash:server.mjs');
  });

  it('a changed file that is not executed matters only under check all', async () => {
    const { dir } = await makeRelease();
    await flipByte(path.join(dir, 'public', 'a.css'), 3);
    await expect(verifyRelease(dir, TRUSTED, EXECUTED)).resolves.toBeDefined();
    await expectInvalid(verifyRelease(dir, TRUSTED, ALL), 'hash:public/a.css');
  });

  it('an executed file that is a directory', async () => {
    const { dir } = await makeRelease();
    await fsp.rm(path.join(dir, 'server.mjs'));
    await fsp.mkdir(path.join(dir, 'server.mjs'));
    await expectInvalid(verifyRelease(dir, TRUSTED, EXECUTED), 'hash:server.mjs');
  });

  it('an executed file replaced by a symbolic link to identical content', async () => {
    if (process.platform === 'win32') return;
    const { dir } = await makeRelease();
    const elsewhere = path.join(root, `elsewhere-${counter++}.mjs`);
    await fsp.writeFile(elsewhere, SERVER_SOURCE);
    await fsp.rm(path.join(dir, 'server.mjs'));
    await fsp.symlink(elsewhere, path.join(dir, 'server.mjs'));
    await expectInvalid(verifyRelease(dir, TRUSTED, EXECUTED), 'hash:server.mjs');
  });
});

describe('verifyRelease: extra and missing files', () => {
  it('an extra file under check all', async () => {
    const { dir } = await makeRelease();
    await fsp.writeFile(path.join(dir, 'evil.mjs'), 'x');
    await expectInvalid(verifyRelease(dir, TRUSTED, ALL), 'extra:evil.mjs');
    await expect(verifyRelease(dir, TRUSTED, EXECUTED)).resolves.toBeDefined();
  });

  it('an extra file in a nested directory, reported with its POSIX path', async () => {
    const { dir } = await makeRelease();
    await fsp.mkdir(path.join(dir, 'public', 'deep'), { recursive: true });
    await fsp.writeFile(path.join(dir, 'public', 'deep', 'x.js'), 'x');
    await expectInvalid(verifyRelease(dir, TRUSTED, ALL), 'extra:public/deep/x.js');
  });

  it('reports the first extra file in path order', async () => {
    const { dir } = await makeRelease();
    await fsp.writeFile(path.join(dir, 'zz.js'), 'x');
    await fsp.writeFile(path.join(dir, 'aa.js'), 'x');
    await expectInvalid(verifyRelease(dir, TRUSTED, ALL), 'extra:aa.js');
  });

  it('manifest.json, manifest.sig and .complete in the root are not extra, copies in subdirectories are', async () => {
    const { dir } = await makeRelease();
    await expect(verifyRelease(dir, TRUSTED, ALL)).resolves.toBeDefined();
    await fsp.writeFile(path.join(dir, 'public', 'manifest.sig'), 'x');
    await expectInvalid(verifyRelease(dir, TRUSTED, ALL), 'extra:public/manifest.sig');
  });

  it('a symbolic link is extra', async () => {
    if (process.platform === 'win32') return;
    const { dir } = await makeRelease();
    await fsp.symlink(path.join(dir, 'server.mjs'), path.join(dir, 'link.mjs'));
    await expectInvalid(verifyRelease(dir, TRUSTED, ALL), 'extra:link.mjs');
  });

  it('a listed file that is missing, under check all only', async () => {
    const { dir } = await makeRelease();
    await fsp.rm(path.join(dir, 'public', 'a.css'));
    await expectInvalid(verifyRelease(dir, TRUSTED, ALL), 'missing:public/a.css');
    await expect(verifyRelease(dir, TRUSTED, EXECUTED)).resolves.toBeDefined();
  });

  it('a missing server.mjs under either check', async () => {
    const { dir } = await makeRelease();
    await fsp.rm(path.join(dir, 'server.mjs'));
    await expectInvalid(verifyRelease(dir, TRUSTED, ALL), 'missing:server.mjs');
    await expectInvalid(verifyRelease(dir, TRUSTED, EXECUTED), 'missing:server.mjs');
  });

  it('an executed file that the manifest does not list', async () => {
    const { dir } = await makeRelease({ 'public/a.css': CSS_SOURCE });
    await fsp.writeFile(path.join(dir, 'server.mjs'), SERVER_SOURCE);
    await expectInvalid(verifyRelease(dir, TRUSTED, EXECUTED), 'missing:server.mjs');
    await expectInvalid(verifyRelease(dir, TRUSTED, ALL), 'missing:server.mjs');
    await expectInvalid(verifyRelease(dir, TRUSTED, { check: 'executed', executed: ['public/a.css', 'other.js'] }), 'missing:other.js');
  });

  it('refuses an executed path that is not a release path', async () => {
    const { dir } = await makeRelease();
    for (const executed of [['../server.mjs'], ['/etc/passwd'], ['']]) {
      await expect(verifyRelease(dir, TRUSTED, { check: 'executed', executed })).rejects.toThrow(TypeError);
    }
  });
});

describe('verifyRelease: signature', () => {
  it('signed by a key that is not trusted', async () => {
    const { dir } = await makeRelease(BASE_FILES, { key: stranger });
    await expectInvalid(verifyRelease(dir, TRUSTED, ALL), 'signature');
    await expectInvalid(verifyRelease(dir, TRUSTED, EXECUTED), 'signature');
  });

  it('signed by a trusted key of another use', async () => {
    const { dir } = await makeRelease(BASE_FILES, { key: lic1 });
    await expectInvalid(verifyRelease(dir, TRUSTED, ALL), 'signature');
  });

  it('signed under another typ', async () => {
    const { dir, manifest } = await makeRelease();
    const env = signDetached(manifest, { typ: 'altis-feed/1', kid: 'dev-rel-1', privateKey: rel1.privateKey });
    await fsp.writeFile(path.join(dir, SIGNATURE_FILE), JSON.stringify(env));
    await expectInvalid(verifyRelease(dir, TRUSTED, ALL), 'signature');
  });

  it('with no trusted keys at all', async () => {
    const { dir } = await makeRelease();
    await expectInvalid(verifyRelease(dir, [], ALL), 'signature');
  });

  it('manifest.json changed after signing', async () => {
    const { dir, manifest } = await makeRelease();
    const forged = { ...manifest, version: '9.9.9' };
    await fsp.writeFile(path.join(dir, MANIFEST_FILE), JSON.stringify(forged));
    await expectInvalid(verifyRelease(dir, TRUSTED, ALL), 'signature');
  });

  it('manifest.json with a file entry swapped for a different hash', async () => {
    const { dir, manifest } = await makeRelease();
    await fsp.writeFile(path.join(dir, 'server.mjs'), 'malicious');
    const forged = {
      ...manifest,
      files: manifest.files.map((f) =>
        f.path === 'server.mjs' ? { ...f, sha256: sha256('malicious'), size: 'malicious'.length } : f,
      ),
    };
    await fsp.writeFile(path.join(dir, MANIFEST_FILE), JSON.stringify(forged));
    await expectInvalid(verifyRelease(dir, TRUSTED, ALL), 'signature');
  });

  it('is reported before any hash check', async () => {
    const { dir } = await makeRelease(BASE_FILES, { key: stranger });
    await flipByte(path.join(dir, 'server.mjs'), 0);
    await fsp.writeFile(path.join(dir, 'extra.js'), 'x');
    await expectInvalid(verifyRelease(dir, TRUSTED, ALL), 'signature');
  });

  it('accepts a manifest.json with other whitespace and property order than the one that was signed', async () => {
    const { dir, manifest } = await makeRelease();
    const reversed = Object.fromEntries(Object.entries(manifest).reverse());
    await fsp.writeFile(path.join(dir, MANIFEST_FILE), '\n\n' + JSON.stringify(reversed, null, '\t') + '\n');
    await expect(verifyRelease(dir, TRUSTED, ALL)).resolves.toEqual(manifest);
  });

  it('manifest.json with a duplicate key', async () => {
    const { dir } = await makeRelease();
    const text = await fsp.readFile(path.join(dir, MANIFEST_FILE), 'utf8');
    await fsp.writeFile(path.join(dir, MANIFEST_FILE), text.replace('"buildId"', '"version": "0.0.1", "buildId"'));
    await expectInvalid(verifyRelease(dir, TRUSTED, ALL), 'signature');
  });

  it('missing, unparseable or malformed manifest.json and manifest.sig', async () => {
    const files: [string, string | null][] = [
      [MANIFEST_FILE, null],
      [SIGNATURE_FILE, null],
      [MANIFEST_FILE, ''],
      [SIGNATURE_FILE, ''],
      [MANIFEST_FILE, 'not json'],
      [SIGNATURE_FILE, 'not json'],
      [SIGNATURE_FILE, '[]'],
      [SIGNATURE_FILE, '{}'],
      [SIGNATURE_FILE, 'null'],
    ];
    for (const [name, content] of files) {
      const { dir } = await makeRelease();
      if (content === null) await fsp.rm(path.join(dir, name));
      else await fsp.writeFile(path.join(dir, name), content);
      await expectInvalid(verifyRelease(dir, TRUSTED, ALL), 'signature');
    }
  });

  it('manifest.json that is not valid UTF-8', async () => {
    const { dir } = await makeRelease();
    await fsp.writeFile(path.join(dir, MANIFEST_FILE), Buffer.from([0x7b, 0xff, 0x7d]));
    await expectInvalid(verifyRelease(dir, TRUSTED, ALL), 'signature');
  });

  it('a signed manifest that is not a valid manifest', async () => {
    const { dir, manifest } = await makeRelease();
    const sha = manifest.files[0]!.sha256;
    const entry = { path: 'x.js', sha256: sha, size: 1 };
    const broken: Record<string, unknown>[] = [
      { ...manifest, bootProtocol: 2 },
      { ...manifest, version: 'latest' },
      { ...manifest, minDb: { mysql: '8.0', mariadb: '10.6' } },
      { ...manifest, buildId: undefined },
      { ...manifest, files: undefined },
      { ...manifest, files: 'none' },
      { ...manifest, files: [{ ...entry, sha256: sha.toUpperCase() }] },
      { ...manifest, files: [{ ...entry, sha256: 'abc' }] },
      { ...manifest, files: [{ ...entry, size: -1 }] },
      { ...manifest, files: [{ ...entry, size: 1.5 }] },
      { ...manifest, files: [{ path: 'x.js', size: 1 }] },
      { ...manifest, files: [{ ...entry, wm: null }] },
      { ...manifest, files: [entry, entry] },
      { ...manifest, files: [entry, { ...entry, path: 'X.JS' }] },
      { ...manifest, files: [{ ...entry, path: 'manifest.json' }] },
      { ...manifest, files: [{ ...entry, path: '.complete' }] },
      { ...manifest, files: [{ ...entry, path: '../x.js' }] },
      { ...manifest, files: [{ ...entry, path: 'a/../x.js' }] },
      { ...manifest, files: [{ ...entry, path: '/etc/passwd' }] },
      { ...manifest, files: [{ ...entry, path: 'a//b.js' }] },
      { ...manifest, files: [{ ...entry, path: './x.js' }] },
      { ...manifest, files: [{ ...entry, path: 'a\\b.js' }] },
      { ...manifest, files: [{ ...entry, path: 'C:/x.js' }] },
      { ...manifest, files: [{ ...entry, path: 'dir/' }] },
      { ...manifest, files: [{ ...entry, path: '' }] },
      { ...manifest, files: [{ ...entry, wm: [{ offset: 0, length: 2 }] }] },
      { ...manifest, files: [{ ...entry, wm: 'x' }] },
    ];
    for (const payload of broken) {
      const env = signDetached(payload, { typ: RELEASE_TYP, kid: 'dev-rel-1', privateKey: rel1.privateKey });
      await fsp.writeFile(path.join(dir, MANIFEST_FILE), JSON.stringify(payload));
      await fsp.writeFile(path.join(dir, SIGNATURE_FILE), JSON.stringify(env));
      await expectInvalid(verifyRelease(dir, TRUSTED, ALL), 'signature');
    }
  });

  it('throws plain Errors with the RELEASE_INVALID prefix only', async () => {
    const { dir } = await makeRelease();
    await flipByte(path.join(dir, 'server.mjs'), 0);
    const err = await expectInvalid(verifyRelease(dir, TRUSTED, ALL), 'hash:server.mjs');
    expect(err.constructor).toBe(Error);
  });

  it('keeps the signature failure as the cause', async () => {
    const { dir } = await makeRelease(BASE_FILES, { key: stranger });
    const err = await expectInvalid(verifyRelease(dir, TRUSTED, ALL), 'signature');
    expect((err.cause as Error).message).toBe('SIG_INVALID:kid');
  });
});

describe('verifyRelease: watermarks', () => {
  // Watermark ranges are refused on executed files (R12b), so the tests mark public/a.css, a 19-byte file.
  const wm = { 'public/a.css': [{ offset: 10, length: 8 }] };
  const cssFile = (dir: string): string => path.join(dir, 'public', 'a.css');

  it('changing bytes 10-17 still verifies', async () => {
    const { dir, manifest } = await makeRelease(BASE_FILES, { wm });
    expect(manifest.files.find((f) => f.path === 'public/a.css')?.wm).toEqual([{ offset: 10, length: 8 }]);
    const bytes = await fsp.readFile(cssFile(dir));
    bytes.write('LIC-0042', 10, 'latin1');
    await fsp.writeFile(cssFile(dir), bytes);
    expect(bytes.subarray(10, 18).toString('latin1')).toBe('LIC-0042');
    await expect(verifyRelease(dir, TRUSTED, ALL)).resolves.toEqual(manifest);
    await expect(verifyRelease(dir, TRUSTED, EXECUTED)).resolves.toEqual(manifest);
  });

  it('the watermarked bytes may be anything, including bytes that are zero', async () => {
    const { dir } = await makeRelease(BASE_FILES, { wm });
    const bytes = await fsp.readFile(cssFile(dir));
    bytes.fill(0xff, 10, 18);
    await fsp.writeFile(cssFile(dir), bytes);
    await expect(verifyRelease(dir, TRUSTED, ALL)).resolves.toBeDefined();
    bytes.fill(0, 10, 18);
    await fsp.writeFile(cssFile(dir), bytes);
    await expect(verifyRelease(dir, TRUSTED, ALL)).resolves.toBeDefined();
  });

  it('changing the byte before or after the range does not verify', async () => {
    for (const index of [9, 18, 0]) {
      const { dir } = await makeRelease(BASE_FILES, { wm });
      await flipByte(cssFile(dir), index);
      await expectInvalid(verifyRelease(dir, TRUSTED, ALL), 'hash:public/a.css');
    }
  });

  it('a watermarked file must keep its size', async () => {
    const { dir } = await makeRelease(BASE_FILES, { wm });
    const bytes = await fsp.readFile(cssFile(dir));
    await fsp.writeFile(cssFile(dir), Buffer.concat([bytes, Buffer.from('x')]));
    await expectInvalid(verifyRelease(dir, TRUSTED, ALL), 'hash:public/a.css');
  });

  it('ranges across read chunk boundaries', async () => {
    const big = Buffer.alloc(200_000, 0x42);
    const ranges = [{ offset: 65_530, length: 20 }, { offset: 131_070, length: 6 }];
    const { dir } = await makeRelease({ ...BASE_FILES, 'public/big.bin': big }, { wm: { 'public/big.bin': ranges } });
    const file = path.join(dir, 'public', 'big.bin');
    const bytes = await fsp.readFile(file);
    bytes.fill(0x7a, 65_530, 65_550);
    bytes.fill(0x7b, 131_070, 131_076);
    await fsp.writeFile(file, bytes);
    await expect(verifyRelease(dir, TRUSTED, ALL)).resolves.toBeDefined();
    bytes.writeUInt8(0x00, 65_550);
    await fsp.writeFile(file, bytes);
    await expectInvalid(verifyRelease(dir, TRUSTED, ALL), 'hash:public/big.bin');
  });

  it('a signed manifest whose wm range lies outside the file is invalid', async () => {
    const { dir, manifest } = await makeRelease();
    const files = manifest.files.map((f) => (f.path === 'public/a.css' ? { ...f, wm: [{ offset: 15, length: 6 }] } : f));
    await signPayload(dir, { ...manifest, files });
    await expectInvalid(verifyRelease(dir, TRUSTED, ALL), 'signature');
  });

  it('wm ranges on an executed file are refused with wm:<path>, under either check', async () => {
    const { dir, manifest } = await makeRelease(BASE_FILES, { wm: { 'server.mjs': [{ offset: 10, length: 8 }] } });
    expect(manifest.files.find((f) => f.path === 'server.mjs')?.wm).toBeDefined();
    await expectInvalid(verifyRelease(dir, TRUSTED, ALL), 'wm:server.mjs');
    await expectInvalid(verifyRelease(dir, TRUSTED, EXECUTED), 'wm:server.mjs');
    // before any hash check
    await flipByte(path.join(dir, 'server.mjs'), 0);
    await expectInvalid(verifyRelease(dir, TRUSTED, EXECUTED), 'wm:server.mjs');
  });

  it('wm ranges are refused on every executed file, not only on server.mjs', async () => {
    const { dir } = await makeRelease(BASE_FILES, { wm });
    await expect(verifyRelease(dir, TRUSTED, EXECUTED)).resolves.toBeDefined();
    await expectInvalid(
      verifyRelease(dir, TRUSTED, { check: 'executed', executed: ['server.mjs', 'public/a.css'] }),
      'wm:public/a.css',
    );
  });

  it('an empty wm list on an executed file is fine', async () => {
    const { dir, manifest } = await makeRelease();
    const files = manifest.files.map((f) => (f.path === 'server.mjs' ? { ...f, wm: [] } : f));
    await signPayload(dir, { ...manifest, files });
    await expect(verifyRelease(dir, TRUSTED, ALL)).resolves.toBeDefined();
  });
});

describe('verifyRelease: forward compatibility (R12, R12b)', () => {
  /** A manifest of the base release plus properties that this version does not know. */
  async function futureRelease(): Promise<{ dir: string; manifest: ReleaseManifest; payload: Record<string, unknown> }> {
    const { dir, manifest } = await makeRelease(BASE_FILES, { wm: { 'public/a.css': [{ offset: 10, length: 8 }] } });
    const payload = {
      ...manifest,
      channel: 'stable',
      features: { a: [1, 2] },
      minDb: { ...manifest.minDb, sqlite: '3.45' },
      files: manifest.files.map((f) => ({
        ...f,
        mode: 420,
        ...(f.wm === undefined ? {} : { wm: f.wm.map((r) => ({ ...r, label: 'licence' })) }),
      })),
    };
    await signPayload(dir, payload);
    return { dir, manifest, payload };
  }

  it('ignores unknown properties at every level and returns the known fields only', async () => {
    const { dir, manifest } = await futureRelease();
    for (const check of [ALL, EXECUTED]) {
      const verified = await verifyRelease(dir, TRUSTED, check);
      expect(verified).toStrictEqual(manifest);
      expect(JSON.stringify(verified)).not.toMatch(/channel|features|sqlite|mode|label/);
    }
  });

  it('an unknown top-level field (e.g. a reserved firmware field, D1d-35) is valid and left out', () => {
    const payload = { ...META, firmware: {}, files: [{ path: 'server.mjs', sha256: 'ab'.repeat(32), size: 1 }] };
    const copy = validateManifest(payload);
    expect(copy).toStrictEqual({ ...META, files: [{ path: 'server.mjs', sha256: 'ab'.repeat(32), size: 1 }] });
    expect(copy).not.toHaveProperty('firmware');
  });

  it('validateManifest ignores unknown properties and returns a copy without them', async () => {
    const { manifest, payload } = await futureRelease();
    const copy = validateManifest(payload);
    expect(copy).toStrictEqual(manifest);
    expect(copy).not.toBe(payload);
  });

  it('still verifies the watermark ranges of a manifest with unknown range properties', async () => {
    const { dir } = await futureRelease();
    await flipByte(path.join(dir, 'public', 'a.css'), 0);
    await expectInvalid(verifyRelease(dir, TRUSTED, ALL), 'hash:public/a.css');
  });

  it('the signature covers the unknown properties: changing, adding or removing one fails', async () => {
    const { dir, payload } = await futureRelease();
    const manifestFile = path.join(dir, MANIFEST_FILE);
    const clone = (): Record<string, unknown> => JSON.parse(JSON.stringify(payload)) as Record<string, unknown>;
    type Files = Record<string, unknown>[];
    const tamper: [string, (m: Record<string, unknown>) => void][] = [
      ['top-level changed', (m) => (m['channel'] = 'beta')],
      ['top-level added', (m) => (m['extra'] = true)],
      ['top-level removed', (m) => delete m['features']],
      ['minDb changed', (m) => ((m['minDb'] as Record<string, unknown>)['sqlite'] = '3.46')],
      ['minDb added', (m) => ((m['minDb'] as Record<string, unknown>)['oracle'] = '19')],
      ['file entry changed', (m) => ((m['files'] as Files)[0]!['mode'] = 493)],
      ['file entry added', (m) => ((m['files'] as Files)[1]!['executable'] = true)],
      ['file entry removed', (m) => delete (m['files'] as Files)[0]!['mode']],
      [
        'wm range changed',
        (m) => (((m['files'] as Files)[0]!['wm'] as Record<string, unknown>[])[0]!['label'] = 'other'),
      ],
    ];
    for (const [name, change] of tamper) {
      const forged = clone();
      change(forged);
      await fsp.writeFile(manifestFile, JSON.stringify(forged));
      await expect(verifyRelease(dir, TRUSTED, ALL), name).rejects.toThrow('RELEASE_INVALID:signature');
    }
  });

  it('accepts an unknown minDb key on its own', async () => {
    const { dir, manifest } = await makeRelease();
    await signPayload(dir, { ...manifest, minDb: { ...manifest.minDb, sqlite: '3.45' } });
    await expect(verifyRelease(dir, TRUSTED, ALL)).resolves.toStrictEqual(manifest);
  });

  it('still needs the required fields: a missing minDb key or a missing file field is invalid', async () => {
    const { dir, manifest } = await makeRelease();
    const sha = manifest.files[0]!.sha256;
    const broken: Record<string, unknown>[] = [
      { ...manifest, minDb: { mysql: '8.0', mariadb: '10.6', sqlite: '3.45' } },
      { ...manifest, files: [{ path: 'x.js', sha256: sha }] },
      { ...manifest, files: [{ sha256: sha, size: 1 }] },
    ];
    for (const payload of broken) {
      await signPayload(dir, payload);
      await expectInvalid(verifyRelease(dir, TRUSTED, ALL), 'signature');
    }
  });

  it('bootProtocol stays strict', async () => {
    const { dir, manifest } = await makeRelease();
    for (const bootProtocol of [2, '1', 1.5, null]) {
      await signPayload(dir, { ...manifest, bootProtocol });
      await expectInvalid(verifyRelease(dir, TRUSTED, ALL), 'signature');
    }
  });
});

describe('verifyRelease: reading manifest.json and manifest.sig', () => {
  it('does not read a symbolic link', async () => {
    if (process.platform === 'win32') return;
    for (const name of [MANIFEST_FILE, SIGNATURE_FILE]) {
      const { dir } = await makeRelease();
      const copy = path.join(root, `copy-${counter++}`);
      await fsp.copyFile(path.join(dir, name), copy);
      await fsp.rm(path.join(dir, name));
      await fsp.symlink(copy, path.join(dir, name));
      await expectInvalid(verifyRelease(dir, TRUSTED, ALL), 'signature');
    }
  });

  it('does not read a directory, and refuses a file over 16 MiB', async () => {
    const { dir } = await makeRelease();
    await fsp.rm(path.join(dir, MANIFEST_FILE));
    await fsp.mkdir(path.join(dir, MANIFEST_FILE));
    await expectInvalid(verifyRelease(dir, TRUSTED, ALL), 'signature');
    await fsp.rmdir(path.join(dir, MANIFEST_FILE));
    await fsp.writeFile(path.join(dir, MANIFEST_FILE), Buffer.alloc(16 * 1024 * 1024 + 1, 0x20));
    await expectInvalid(verifyRelease(dir, TRUSTED, ALL), 'signature');
  });
});

describe('verifyRelease: each file is read once', () => {
  async function opensOf(dir: string, file: string, run: () => Promise<unknown>): Promise<number> {
    const spy = vi.spyOn(fsp, 'open');
    try {
      await run();
      return spy.mock.calls.filter(([target]) => target === path.join(dir, file)).length;
    } finally {
      spy.mockRestore();
    }
  }

  it('check all hashes server.mjs once, although it is both executed and listed', async () => {
    const { dir } = await makeRelease();
    expect(await opensOf(dir, 'server.mjs', () => verifyRelease(dir, TRUSTED, ALL))).toBe(1);
    expect(await opensOf(dir, path.join('public', 'a.css'), () => verifyRelease(dir, TRUSTED, ALL))).toBe(1);
  });

  it('a path repeated in executed is hashed once', async () => {
    const { dir } = await makeRelease();
    const run = () => verifyRelease(dir, TRUSTED, { check: 'executed', executed: ['server.mjs', 'server.mjs'] });
    expect(await opensOf(dir, 'server.mjs', run)).toBe(1);
  });
});
