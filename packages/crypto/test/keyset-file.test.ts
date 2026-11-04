import { execFileSync } from 'node:child_process';
import fsp from 'node:fs/promises';
import os from 'node:os';
import path from 'node:path';
import { afterAll, beforeAll, describe, expect, it } from 'vitest';
import { signDetached } from '../src/envelope.js';
import { generateKeyPair, type TrustedKey } from '../src/keys.js';
import { KEYSET_MAX_DOCS, KEYSET_MAX_DOC_BYTES, resolveKeysetSources, type KeysetDoc } from '../src/keyset.js';
import {
  KEYSET_MAX_FILE_BYTES,
  collectInstalledKeysets,
  isInvalidKeysetFile,
  readKeysetFile,
  readKeysetWithBak,
} from '../src/keyset-file.js';
import { RELEASE_TYP, buildManifest, verifyReleaseWithRoots } from '../src/manifest.js';

// keyset.json files (rulings R65a, R65c): one file in the frozen format; DATA_DIR's copy and its .bak together; every
// keyset.json of an installation gathered, so that a revocation survives while any copy of it does.

let tmp: string;
let counter = 0;

beforeAll(async () => {
  tmp = await fsp.realpath(await fsp.mkdtemp(path.join(os.tmpdir(), 'altis-keyset-file-')));
});

afterAll(async () => {
  await fsp.rm(tmp, { recursive: true, force: true });
});

const fresh = async (): Promise<string> => {
  const dir = path.join(tmp, `case-${counter++}`);
  await fsp.mkdir(dir, { recursive: true });
  return dir;
};

const root = generateKeyPair();
const ROOTS: TrustedKey[] = [{ kid: 'root-1', use: 'root', pub: root.pub }];
const rel1: TrustedKey = { kid: 'rel-1', use: 'release', pub: generateKeyPair().pub };
const rel2: TrustedKey = { kid: 'rel-2', use: 'release', pub: generateKeyPair().pub };

function doc(payload: unknown): KeysetDoc {
  return { raw: JSON.stringify(payload), env: signDetached(payload, { typ: 'altis-keyset/1', kid: 'root-1', privateKey: root.privateKey }) };
}

const ADD = doc({ seq: 1, keys: [rel1, rel2], revokedKids: [] });
const REVOKE_1 = doc({ seq: 2, keys: [], revokedKids: ['rel-1'] });

async function write(file: string, value: unknown): Promise<string> {
  await fsp.mkdir(path.dirname(file), { recursive: true });
  await fsp.writeFile(file, typeof value === 'string' ? value : JSON.stringify(value));
  return file;
}

const kids = (sources: Parameters<typeof resolveKeysetSources>[1]): string[] => resolveKeysetSources(ROOTS, sources).keys.map((k) => k.kid);

describe('readKeysetFile', () => {
  it('returns the documents of a JSON array, or null when there is no file', async () => {
    const dir = await fresh();
    expect(await readKeysetFile(await write(path.join(dir, 'keyset.json'), [ADD, REVOKE_1]))).toEqual([ADD, REVOKE_1]);
    expect(await readKeysetFile(path.join(dir, 'none.json'))).toBeNull();
    expect(await readKeysetFile(path.join(dir, 'keyset.json', 'below-a-file.json'))).toBeNull();
  });

  it.each([
    ['a bare document', JSON.stringify(ADD)],
    ['not JSON', '[{"raw":'],
    ['duplicate keys', '[{"raw":"x","raw":"y","env":{}}]'],
    ['not UTF-8', Buffer.from([0x5b, 0xff, 0x5d])],
  ])('refuses %s (KEYSET_FILE_INVALID)', async (_name, content) => {
    const file = path.join(await fresh(), 'keyset.json');
    await fsp.writeFile(file, content);
    const error = await readKeysetFile(file).catch((e: unknown) => e);
    expect(isInvalidKeysetFile(error)).toBe(true);
  });

  it('refuses a directory, a symbolic link and a FIFO at once (never blocks)', async () => {
    const dir = await fresh();
    await fsp.mkdir(path.join(dir, 'as-dir.json'));
    expect(isInvalidKeysetFile(await readKeysetFile(path.join(dir, 'as-dir.json')).catch((e: unknown) => e))).toBe(true);
    if (process.platform === 'win32') return;
    const target = await write(path.join(dir, 'target.json'), [ADD]);
    await fsp.symlink(target, path.join(dir, 'link.json'));
    expect(isInvalidKeysetFile(await readKeysetFile(path.join(dir, 'link.json')).catch((e: unknown) => e))).toBe(true);
    execFileSync('mkfifo', [path.join(dir, 'fifo.json')]);
    expect(isInvalidKeysetFile(await readKeysetFile(path.join(dir, 'fifo.json')).catch((e: unknown) => e))).toBe(true);
  }, 5_000);
});

describe('the frozen limits (R65c, raised in round 2 for the 1d append-only writer)', () => {
  it('4096 documents of at most 64 KiB, 8 MiB per file', async () => {
    expect([KEYSET_MAX_DOCS, KEYSET_MAX_DOC_BYTES, KEYSET_MAX_FILE_BYTES]).toEqual([4096, 64 * 1024, 8 * 1024 * 1024]);
    const dir = await fresh();
    const atLimit = await write(path.join(dir, 'at-limit.json'), new Array(KEYSET_MAX_DOCS).fill(ADD));
    expect(await readKeysetFile(atLimit)).toHaveLength(KEYSET_MAX_DOCS);
    const tooMany = await write(path.join(dir, 'too-many.json'), new Array(KEYSET_MAX_DOCS + 1).fill(ADD));
    expect(isInvalidKeysetFile(await readKeysetFile(tooMany).catch((e: unknown) => e))).toBe(true);
    const tooLarge = await write(path.join(dir, 'too-large.json'), `[${' '.repeat(KEYSET_MAX_FILE_BYTES)}]`);
    expect(isInvalidKeysetFile(await readKeysetFile(tooLarge).catch((e: unknown) => e))).toBe(true);
    const bigDoc = await write(path.join(dir, 'big-doc.json'), [{ raw: ' '.repeat(KEYSET_MAX_DOC_BYTES), env: ADD.env }]);
    expect(isInvalidKeysetFile(await readKeysetFile(bigDoc).catch((e: unknown) => e))).toBe(true);
  });
});

describe('readKeysetWithBak (R65a: the file and its .bak, both)', () => {
  it('unions keyset.json and keyset.json.bak: a revocation only in the .bak still counts', async () => {
    const file = path.join(await fresh(), 'keyset.json');
    await write(file, [ADD]);
    await write(`${file}.bak`, [ADD, REVOKE_1]);
    const found = await readKeysetWithBak(file, 'data');
    expect(found.sources.map((s) => s.name)).toEqual(['data', 'data.bak']);
    expect(kids(found.sources)).toEqual(['root-1', 'rel-2']);
  });

  it('skips an unusable copy when the other one is usable, and reports it', async () => {
    const file = path.join(await fresh(), 'keyset.json');
    await write(file, '{ torn');
    await write(`${file}.bak`, [ADD, REVOKE_1]);
    const found = await readKeysetWithBak(file, 'data');
    expect(found.sources.map((s) => s.name)).toEqual(['data.bak']);
    expect(found.skipped.map((s) => s.name)).toEqual(['data']);
  });

  it('an unreadable .bak (EACCES) next to a healthy keyset.json is skipped and reported; an unreadable main file still throws', async () => {
    if (process.platform === 'win32' || process.getuid?.() === 0) return; // chmod does not stop root
    const file = path.join(await fresh(), 'keyset.json');
    await write(file, [ADD, REVOKE_1]);
    await write(`${file}.bak`, [ADD]);
    await fsp.chmod(`${file}.bak`, 0o000);
    try {
      const found = await readKeysetWithBak(file, 'data');
      expect(found.sources.map((s) => s.name)).toEqual(['data']);
      expect(found.skipped.map((s) => s.name)).toEqual(['data.bak']);
      expect((found.skipped[0]!.error as NodeJS.ErrnoException).code).toBe('EACCES');
      await fsp.chmod(`${file}.bak`, 0o644);
      await fsp.chmod(file, 0o000);
      await expect(readKeysetWithBak(file, 'data')).rejects.toMatchObject({ code: 'EACCES' });
    } finally {
      await fsp.chmod(file, 0o644);
      await fsp.chmod(`${file}.bak`, 0o644);
    }
  });

  it('nothing when neither exists; KEYSET_CORRUPT when what exists is unusable (fail closed)', async () => {
    const dir = await fresh();
    expect(await readKeysetWithBak(path.join(dir, 'keyset.json'), 'data')).toEqual({ sources: [], skipped: [] });
    const only = await write(path.join(dir, 'keyset.json'), JSON.stringify(ADD)); // a bare document
    await expect(readKeysetWithBak(only, 'data')).rejects.toThrow(/^KEYSET_CORRUPT/);
    await write(`${only}.bak`, '[');
    await expect(readKeysetWithBak(only, 'data')).rejects.toThrow(/^KEYSET_CORRUPT/);
  });
});

describe('collectInstalledKeysets (R65a: every keyset.json of the installation)', () => {
  async function installation(): Promise<{ appRoot: string; dataDir: string; dataKeyset: string }> {
    const base = await fresh();
    const appRoot = path.join(base, 'app');
    const dataDir = path.join(base, 'data');
    await fsp.mkdir(path.join(appRoot, 'bundled-release'), { recursive: true });
    await fsp.mkdir(path.join(dataDir, 'releases'), { recursive: true });
    return { appRoot, dataDir, dataKeyset: path.join(dataDir, 'releases', 'keyset.json') };
  }

  it('reads DATA_DIR keyset.json and .bak, every bundled release, and the named releases, in that order', async () => {
    const inst = await installation();
    await write(inst.dataKeyset, [ADD]);
    await write(`${inst.dataKeyset}.bak`, [ADD]);
    await write(path.join(inst.appRoot, 'bundled-release', '1.1.0', 'keyset.json'), [ADD, REVOKE_1]);
    await write(path.join(inst.appRoot, 'bundled-release', '1.0.0', 'keyset.json'), [ADD]);
    await fsp.mkdir(path.join(inst.appRoot, 'bundled-release', 'not-a-version'));
    await write(path.join(inst.appRoot, 'bundled-release', 'not-a-version', 'keyset.json'), [ADD]);
    await write(path.join(inst.dataDir, 'releases', '0.9.0', 'keyset.json'), [ADD]);
    const found = await collectInstalledKeysets({
      appRoot: inst.appRoot,
      dataKeyset: inst.dataKeyset,
      releases: [
        { name: 'DATA_DIR/releases/0.9.0/keyset.json', dir: path.join(inst.dataDir, 'releases', '0.9.0') },
        { name: 'again', dir: path.join(inst.appRoot, 'bundled-release', '1.1.0') }, // already read
        { name: 'DATA_DIR/releases/0.8.0/keyset.json', dir: path.join(inst.dataDir, 'releases', '0.8.0') }, // pruned
      ],
    });
    expect(found.sources.map((s) => s.name)).toEqual([
      'DATA_DIR/releases/keyset.json',
      'DATA_DIR/releases/keyset.json.bak',
      'bundled-release/1.0.0/keyset.json',
      'bundled-release/1.1.0/keyset.json',
      'DATA_DIR/releases/0.9.0/keyset.json',
    ]);
    expect(found.skipped).toEqual([]);
    // The revocation shipped with the bundled release counts even though DATA_DIR never stored it.
    expect(kids(found.sources)).toEqual(['root-1', 'rel-2']);
  });

  it('a revocation survives the deletion of DATA_DIR keyset.json and its .bak while a bundled release carries it', async () => {
    const inst = await installation();
    await write(path.join(inst.appRoot, 'bundled-release', '1.1.0', 'keyset.json'), [ADD, REVOKE_1]);
    const found = await collectInstalledKeysets({ appRoot: inst.appRoot, dataKeyset: inst.dataKeyset, releases: [] });
    expect(kids(found.sources)).toEqual(['root-1', 'rel-2']);
  });

  it('an unusable release keyset.json is skipped and reported; an unusable DATA_DIR keyset (both copies) throws', async () => {
    const inst = await installation();
    await write(path.join(inst.appRoot, 'bundled-release', '1.0.0', 'keyset.json'), JSON.stringify(ADD));
    const found = await collectInstalledKeysets({ appRoot: inst.appRoot, dataKeyset: inst.dataKeyset, releases: [] });
    expect(found.sources).toEqual([]);
    expect(found.skipped.map((s) => s.name)).toEqual(['bundled-release/1.0.0/keyset.json']);

    await write(inst.dataKeyset, '[');
    await expect(collectInstalledKeysets({ appRoot: inst.appRoot, dataKeyset: inst.dataKeyset, releases: [] })).rejects.toThrow(/^KEYSET_CORRUPT/);
  });

  it('an app folder without bundled-release adds nothing', async () => {
    const base = await fresh();
    const found = await collectInstalledKeysets({ appRoot: path.join(base, 'nowhere'), dataKeyset: path.join(base, 'k.json'), releases: [] });
    expect(found).toEqual({ sources: [], skipped: [] });
  });
});

describe('CRITICAL regression (round 2): a tampered copy in DATA_DIR never hides a genuine revocation elsewhere', () => {
  const relKey = generateKeyPair();
  const REL1: TrustedKey = { kid: 'rel-1', use: 'release', pub: relKey.pub };
  const ADD_REL1 = doc({ seq: 1, keys: [REL1], revokedKids: [] });
  const tamperings: [string, (d: KeysetDoc) => unknown][] = [
    ['an extra envelope field', (d) => ({ raw: d.raw, env: { ...d.env, pad: 0 } })],
    ['a respelled raw text with an extra envelope field', (d) => ({ raw: ` ${d.raw}`, env: { ...d.env, pad: 0 } })],
    ['a broken signature', (d) => ({ raw: d.raw, env: { ...d.env, sig: (d.env.sig[0] === 'A' ? 'B' : 'A') + d.env.sig.slice(1) } })],
  ];

  /** An installation whose data release 6.6.6, signed by rel-1, ships only the document that adds rel-1. */
  async function setup(where: 'bundled' | 'named' | 'own'): Promise<{ appRoot: string; dataKeyset: string; release: string }> {
    const base = await fresh();
    const appRoot = path.join(base, 'app');
    const dataDir = path.join(base, 'data');
    const release = path.join(dataDir, 'releases', '6.6.6');
    const revoke = doc({ seq: 2, keys: [], revokedKids: ['rel-1'] });
    await write(path.join(release, 'server.mjs'), 'export const bootProtocol = 1;\n');
    await write(path.join(release, 'keyset.json'), where === 'own' ? [ADD_REL1, revoke] : [ADD_REL1]);
    const manifest = await buildManifest(release, {
      version: '6.6.6',
      buildId: 'x',
      bootProtocol: 1,
      releasedAt: '2026-10-27',
      schemaLatest: '0001',
      minCodeVersionAfter: '0.0.0',
      minUpgradeFrom: '0.0.0',
      minNode: '22.16.0',
      minDb: { mysql: '8.0', mariadb: '10.6', postgres: '15' },
    });
    await write(path.join(release, 'manifest.json'), manifest);
    await write(path.join(release, 'manifest.sig'), signDetached(manifest, { typ: RELEASE_TYP, kid: 'rel-1', privateKey: relKey.privateKey }));
    await write(path.join(release, '.complete'), '');
    if (where === 'bundled') await write(path.join(appRoot, 'bundled-release', '1.0.0', 'keyset.json'), [ADD_REL1, revoke]);
    if (where === 'named') await write(path.join(dataDir, 'releases', '5.0.0', 'keyset.json'), [ADD_REL1, revoke]);
    return { appRoot, dataKeyset: path.join(dataDir, 'releases', 'keyset.json'), release };
  }

  for (const [tampering, tamper] of tamperings) {
    for (const file of ['keyset.json', 'keyset.json.bak']) {
      for (const where of ['bundled', 'named', 'own'] as const) {
        it(`${tampering} in DATA_DIR ${file}; the genuine revocation in the ${where} keyset.json: rel-1 stays revoked`, async () => {
          const inst = await setup(where);
          const revoke = doc({ seq: 2, keys: [], revokedKids: ['rel-1'] });
          await write(path.join(path.dirname(inst.dataKeyset), file), [tamper(revoke)]);
          if (file.endsWith('.bak')) await write(inst.dataKeyset, []);
          const found = await collectInstalledKeysets({
            appRoot: inst.appRoot,
            dataKeyset: inst.dataKeyset,
            releases: [
              { name: 'DATA_DIR/releases/6.6.6/keyset.json', dir: inst.release },
              { name: 'DATA_DIR/releases/5.0.0/keyset.json', dir: path.join(path.dirname(inst.dataKeyset), '5.0.0') },
            ],
          });
          await expect(verifyReleaseWithRoots(inst.release, ROOTS, { check: 'executed', sources: found.sources })).rejects.toThrow(
            'RELEASE_INVALID:signature',
          );
        });
      }
    }
  }

  it('control: without any revocation the release verifies', async () => {
    const inst = await setup('own');
    await write(path.join(inst.release, 'keyset.json'), [ADD_REL1]); // not hashed under 'executed'
    await expect(verifyReleaseWithRoots(inst.release, ROOTS, { check: 'executed', sources: [] })).resolves.toBeDefined();
  });
});
