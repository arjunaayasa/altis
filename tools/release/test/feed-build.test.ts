import { createHash } from 'node:crypto';
import fsp from 'node:fs/promises';
import http from 'node:http';
import os from 'node:os';
import path from 'node:path';
import {
  COMPLETE_FILE,
  KEYSET_FILE,
  MANIFEST_FILE,
  buildManifest,
  parseStrictJson,
  validateManifest,
  type KeysetDoc,
  type ReleaseManifest,
  type TrustedKey,
} from '@altis/crypto';
import { entryMatchesManifest, verifyFeed, type FeedChannel, type FeedEntry } from '@altis/crypto/feed';
import { MIN_SERVER_VERSIONS } from '@altis/db';
import { runCli as signCli } from '@altis/sign-cli';
import { afterAll, beforeAll, describe, expect, it } from 'vitest';
import { buildFeed, parseFeedBuildArgs, type BuildFeedOptions } from '../feed/build.js';
import { startFeedDev } from '../feed/serve.js';
import { MIN_NODE, fixtureLevelOf, packageJsonText, schemaFacts } from '../src/build.js';
import { readZip, writeZip } from '../src/zip.js';

// Task 17 (spec §9.6, §12.6): buildFeed reads the signed manifest of each release zip and writes
// <out>/<channel>/{feed.json, feed.sig, freshness.json} (sign-cli `feed sign` and `freshness sign`, Task 8) and
// <out>/packages/<zip>; every entry equals its manifest (entryMatchesManifest) and names the zip's size and SHA-256.
//
// The zips are built here in the release layout (bundled-release/<v>/ with manifest.json, manifest.sig signed by
// dev-rel-1, the dev keyset.json, .complete last), with the manifest facts `pnpm release --profile test` gives
// 0.2.0-test and 0.3.0-test (schemaFacts of fixture levels 2 and 3, MIN_NODE, the minimum database servers). A real
// release build is not run: two release builds of one checkout must not run at once (they share apps/admin/dist), and
// build.test.ts runs them in parallel with this file.

const REPO_ROOT = path.resolve(import.meta.dirname, '..', '..', '..');
const DEV_KEYS = path.join(REPO_ROOT, 'tools', 'keys', 'dev');
const devKey = (kid: string): string => path.join(DEV_KEYS, `${kid}.key.json`);
const DEV_KEYSET = path.join(DEV_KEYS, 'keyset.json');
const DEV_ROOTS = path.join(DEV_KEYS, 'roots.json');
const DAY_MS = 86_400_000;

let tmp: string;
let counter = 0;
let devRoots: TrustedKey[];
let devKeyset: KeysetDoc[];
let zip02: string;
let zip03: string;

const sha256 = (bytes: Uint8Array): string => createHash('sha256').update(bytes).digest('hex');

async function freshDir(name: string): Promise<string> {
  const dir = path.join(tmp, `${name}-${counter++}`);
  await fsp.mkdir(dir, { recursive: true });
  return dir;
}

async function license(argv: string[]): Promise<void> {
  const lines: string[] = [];
  const code = await signCli(argv, { out: (l) => void lines.push(l), err: (l) => void lines.push(l) });
  if (code !== 0) throw new Error(`altis-sign ${argv.join(' ')} → ${code}: ${lines.join('\n')}`);
}

/** Every file under `root` as sorted POSIX paths, `.complete` last (the release zip's order). */
async function zipEntries(root: string): Promise<{ path: string; data: Buffer }[]> {
  const files: string[] = [];
  async function walk(dir: string, rel: string): Promise<void> {
    for (const entry of await fsp.readdir(dir, { withFileTypes: true })) {
      const child = rel === '' ? entry.name : `${rel}/${entry.name}`;
      if (entry.isDirectory()) await walk(path.join(dir, entry.name), child);
      else files.push(child);
    }
  }
  await walk(root, '');
  files.sort((a, b) => (a < b ? -1 : a > b ? 1 : 0));
  const complete = (p: string): boolean => path.posix.basename(p) === COMPLETE_FILE;
  const ordered = [...files.filter((p) => !complete(p)), ...files.filter(complete)];
  return Promise.all(ordered.map(async (p) => ({ path: p, data: await fsp.readFile(path.join(root, ...p.split('/'))) })));
}

interface ZipSpec {
  version: string;
  releasedAt: string;
  minUpgradeFrom: string;
  /** Key file of the release key that signs the manifest (default dev-rel-1). */
  signer?: string;
  /** Zip file name (default altis-<version>.zip). */
  name?: string;
  /** Changes server.mjs after signing (the manifest no longer matches). */
  tamper?: boolean;
  /** Leaves the bundled release out (a zip that is no release). */
  noRelease?: boolean;
}

/** A release zip of `spec` in the layout of `pnpm release --profile test` (see the top of this file). */
async function releaseZip(spec: ZipSpec): Promise<string> {
  const stage = await freshDir('stage');
  const root = path.join(stage, 'zip');
  const releaseDir = path.join(root, 'bundled-release', spec.version);
  await fsp.mkdir(path.join(releaseDir, 'public'), { recursive: true });
  await fsp.writeFile(path.join(root, 'app.js'), "'use strict';\n");
  await fsp.writeFile(path.join(root, 'package.json'), packageJsonText(spec.version));
  if (spec.noRelease !== true) {
    await fsp.writeFile(path.join(releaseDir, 'server.mjs'), `export const bootProtocol = 1; // ${spec.version}\n`);
    await fsp.writeFile(path.join(releaseDir, 'public', 'THIRD_PARTY_NOTICES.txt'), 'notices\n');
    await fsp.copyFile(DEV_KEYSET, path.join(releaseDir, KEYSET_FILE));
    const triple = (v: readonly number[]): string => v.join('.');
    const manifest = await buildManifest(releaseDir, {
      version: spec.version,
      buildId: `feed-test-${spec.version}`,
      bootProtocol: 1,
      releasedAt: spec.releasedAt,
      ...schemaFacts(fixtureLevelOf('test', spec.version)),
      minUpgradeFrom: spec.minUpgradeFrom,
      minNode: MIN_NODE,
      minDb: { mysql: triple(MIN_SERVER_VERSIONS.mysql), mariadb: triple(MIN_SERVER_VERSIONS.mariadb), postgres: triple(MIN_SERVER_VERSIONS.postgres) },
    });
    await fsp.writeFile(path.join(releaseDir, MANIFEST_FILE), `${JSON.stringify(manifest, null, 2)}\n`);
    await license(['release', 'sign', '--dir', releaseDir, '--key', spec.signer ?? devKey('dev-rel-1')]);
    await fsp.writeFile(path.join(releaseDir, COMPLETE_FILE), '');
    if (spec.tamper === true) await fsp.appendFile(path.join(releaseDir, 'server.mjs'), '// changed after signing\n');
  } else {
    await fsp.rm(path.join(root, 'bundled-release'), { recursive: true, force: true });
  }
  const zipDir = await freshDir('zips');
  const file = path.join(zipDir, spec.name ?? `altis-${spec.version}.zip`);
  await fsp.writeFile(file, writeZip(await zipEntries(root)));
  return file;
}

/** The signed manifest inside a release zip. */
async function manifestOf(zipFile: string): Promise<ReleaseManifest> {
  const entry = readZip(await fsp.readFile(zipFile)).find((e) => /^bundled-release\/[^/]+\/manifest\.json$/.test(e.path));
  if (entry === undefined) throw new Error(`no manifest in ${zipFile}`);
  return validateManifest(parseStrictJson(entry.data.toString('utf8')));
}

interface Published {
  feedText: string;
  sigText: string;
  freshnessText: string;
}

async function readPublished(out: string, channel: FeedChannel): Promise<Published> {
  const read = (name: string): Promise<string> => fsp.readFile(path.join(out, channel, name), 'utf8');
  return { feedText: await read('feed.json'), sigText: await read('feed.sig'), freshnessText: await read('freshness.json') };
}

const verify = (p: Published, channel: FeedChannel, o: { now?: number; minSeq?: number } = {}): ReturnType<typeof verifyFeed> =>
  verifyFeed({ ...p, channel, roots: devRoots, sources: [], refuseDevKids: false, now: o.now ?? Date.now(), minSeq: o.minSeq ?? 0 });

function options(out: string, over: Partial<BuildFeedOptions> = {}): BuildFeedOptions {
  return {
    zips: [zip03, zip02],
    channel: 'stable',
    baseUrl: 'https://feed.example.invalid/altis/',
    out,
    releaseKey: devKey('dev-rel-1'),
    timestampKey: devKey('dev-ts-1'),
    keyset: DEV_KEYSET,
    seq: 5,
    expiresInDays: 7,
    ...over,
  };
}

beforeAll(async () => {
  tmp = await fsp.realpath(await fsp.mkdtemp(path.join(os.tmpdir(), 'altis-feed-build-')));
  devRoots = JSON.parse(await fsp.readFile(DEV_ROOTS, 'utf8')) as TrustedKey[];
  devKeyset = JSON.parse(await fsp.readFile(DEV_KEYSET, 'utf8')) as KeysetDoc[];
  zip02 = await releaseZip({ version: '0.2.0-test', releasedAt: '2026-10-20', minUpgradeFrom: '0.1.0-test' });
  zip03 = await releaseZip({ version: '0.3.0-test', releasedAt: '2026-10-28', minUpgradeFrom: '0.2.0-test' });
});

afterAll(async () => {
  await fsp.rm(tmp, { recursive: true, force: true });
});

describe('buildFeed', () => {
  it('signs a feed of the 0.2.0-test and 0.3.0-test zips that verifyFeed accepts, each entry identical to its manifest', async () => {
    const out = await freshDir('out');
    const issuedAt = Date.now() - 3_600_000;
    const result = await buildFeed(options(out, { issuedAt }));

    expect(result.dir).toBe(out);
    const verified = verify(await readPublished(out, 'stable'), 'stable');
    expect(verified).toMatchObject({ channel: 'stable', seq: 5, issuedAt, expiresAt: issuedAt + 7 * DAY_MS });
    expect(verified.keyset).toEqual(devKeyset);
    expect(verified.trusted.map((k) => k.kid)).toContain('dev-rel-1');
    // Oldest first, whatever the order of `zips`; what buildFeed returns is what the feed says.
    expect(verified.entries.map((e) => e.version)).toEqual(['0.2.0-test', '0.3.0-test']);
    expect(result.entries).toEqual(verified.entries);

    for (const [entry, zipFile] of [
      [verified.entries[0], zip02],
      [verified.entries[1], zip03],
    ] as [FeedEntry, string][]) {
      const manifest = await manifestOf(zipFile);
      expect(entryMatchesManifest(entry, manifest)).toBeNull();
      const bytes = await fsp.readFile(zipFile);
      const name = path.basename(zipFile);
      expect(entry).toEqual({
        version: manifest.version,
        channel: 'stable',
        releasedAt: manifest.releasedAt,
        bootProtocol: manifest.bootProtocol,
        minUpgradeFrom: manifest.minUpgradeFrom,
        minCodeVersionAfter: manifest.minCodeVersionAfter,
        minNode: manifest.minNode,
        minDb: manifest.minDb,
        size: bytes.length,
        sha256: sha256(bytes),
        url: `https://feed.example.invalid/altis/packages/${name}`,
        notesUrl: null,
      });
      // The package is published byte for byte.
      expect(sha256(await fsp.readFile(path.join(out, 'packages', name)))).toBe(entry.sha256);
    }
    // The facts of the fixture levels reached the entries (not only equal: the right ones).
    expect(verified.entries[0]).toMatchObject({ releasedAt: '2026-10-20', minUpgradeFrom: '0.1.0-test', minCodeVersionAfter: '0.0.0' });
    expect(verified.entries[1]).toMatchObject({ releasedAt: '2026-10-28', minUpgradeFrom: '0.2.0-test', minCodeVersionAfter: '0.3.0-test' });
    // Nothing else in the output: no staging left behind.
    expect((await fsp.readdir(out)).sort()).toEqual(['packages', 'stable']);
    expect((await fsp.readdir(path.join(out, 'stable'))).sort()).toEqual(['feed.json', 'feed.sig', 'freshness.json']);
    expect((await fsp.readdir(path.join(out, 'packages'))).sort()).toEqual(['altis-0.2.0-test.zip', 'altis-0.3.0-test.zip']);
  });

  it('signs with the clock when issuedAt is not given; a beta feed is refused as stable (channel)', async () => {
    const out = await freshDir('out');
    const before = Date.now();
    await buildFeed(options(out, { channel: 'beta', zips: [zip03], seq: 1, expiresInDays: 14 }));
    const published = await readPublished(out, 'beta');
    const verified = verify(published, 'beta');
    expect(verified.issuedAt).toBeGreaterThanOrEqual(before);
    expect(verified.issuedAt).toBeLessThanOrEqual(Date.now());
    expect(verified.expiresAt - verified.issuedAt).toBe(14 * DAY_MS);
    expect(verified.entries).toHaveLength(1);
    expect(verified.entries[0]).toMatchObject({ version: '0.3.0-test', channel: 'beta' });
    expect(() => verify(published, 'stable')).toThrow(/^FEED_INVALID:channel/);
  });

  it('rebuilds into the same output with a higher seq, and refuses a seq lower than the one published there', async () => {
    const out = await freshDir('out');
    await buildFeed(options(out, { zips: [zip02], seq: 5 }));
    await buildFeed(options(out, { zips: [zip02, zip03], seq: 6 }));
    const verified = verify(await readPublished(out, 'stable'), 'stable', { minSeq: 6 });
    expect(verified.entries.map((e) => e.version)).toEqual(['0.2.0-test', '0.3.0-test']);

    // Clients refuse a seq lower than the highest they saw (§9.6): the tool refuses to publish one.
    const published = await readPublished(out, 'stable');
    await expect(buildFeed(options(out, { zips: [zip02], seq: 4 }))).rejects.toThrow(/^FEED_SEQ_BACKWARDS:/);
    expect(await readPublished(out, 'stable')).toEqual(published);
    // The same seq again is allowed (a re-sign that clients still accept).
    await buildFeed(options(out, { zips: [zip02, zip03], seq: 6 }));
  });

  it('with rootKeys verifies each package as the client will: a changed file or an untrusted signer is refused, nothing written', async () => {
    const roots = { rootKeys: DEV_ROOTS };
    const ok = await freshDir('out');
    await buildFeed(options(ok, roots));
    expect(verify(await readPublished(ok, 'stable'), 'stable').entries).toHaveLength(2);

    const tampered = await releaseZip({ version: '0.4.0-test', releasedAt: '2026-10-29', minUpgradeFrom: '0.0.0', tamper: true });
    const out = await freshDir('out');
    await expect(buildFeed(options(out, { ...roots, zips: [zip02, tampered] }))).rejects.toThrow(/^FEED_PACKAGE_INVALID:altis-0\.4\.0-test\.zip\b/);

    // A release key nobody trusts: a fresh key the dev keyset does not list.
    const keys = await freshDir('keys');
    await license(['keygen', '--use', 'release', '--kid', 'dev-rel-9', '--out', keys]);
    const stranger = await releaseZip({ version: '0.4.0-test', releasedAt: '2026-10-29', minUpgradeFrom: '0.0.0', signer: path.join(keys, 'dev-rel-9.key.json') });
    await expect(buildFeed(options(out, { ...roots, zips: [stranger] }))).rejects.toThrow(/^FEED_PACKAGE_INVALID:altis-0\.4\.0-test\.zip\b/);
    expect(await fsp.readdir(out)).toEqual([]);

    // Without rootKeys the signature is not checked against a trust anchor (a test may list a package that clients
    // must refuse), but the zip must still hold one signed bundled release.
    await buildFeed(options(out, { zips: [stranger] }));
    expect(verify(await readPublished(out, 'stable'), 'stable').entries.map((e) => e.version)).toEqual(['0.4.0-test']);
  });

  it('refuses what clients would refuse or what cannot be a feed, and writes nothing', async () => {
    const out = await freshDir('out');
    const refused = async (over: Partial<BuildFeedOptions>, pattern: RegExp): Promise<void> => {
      await expect(buildFeed(options(out, over)), JSON.stringify(over)).rejects.toThrow(pattern);
      expect(await fsp.readdir(out)).toEqual([]);
    };
    const copy = path.join(await freshDir('copy'), 'other-0.2.0-test.zip');
    await fsp.copyFile(zip02, copy);
    const sameName = path.join(await freshDir('copy'), path.basename(zip02));
    await fsp.copyFile(zip03, sameName);
    const notRelease = await releaseZip({ version: '0.5.0-test', releasedAt: '2026-10-29', minUpgradeFrom: '0.0.0', noRelease: true });
    const notZip = path.join(await freshDir('copy'), 'altis-0.6.0-test.zip');
    await fsp.writeFile(notZip, 'not a zip');
    const badName = path.join(await freshDir('copy'), 'altis 0.2.0.zip');
    await fsp.copyFile(zip02, badName);

    await refused({ zips: [zip02, copy] }, /^FEED_DUPLICATE_VERSION:0\.2\.0-test\b/);
    await refused({ zips: [zip02, sameName] }, /^FEED_PACKAGE_DUPLICATE:altis-0\.2\.0-test\.zip\b/);
    await refused({ zips: [notRelease] }, /^FEED_PACKAGE_INVALID:altis-0\.5\.0-test\.zip\b/);
    await refused({ zips: [notZip] }, /^FEED_PACKAGE_INVALID:altis-0\.6\.0-test\.zip\b/);
    await refused({ zips: [badName] }, /^FEED_PACKAGE_NAME:/);
    await refused({ zips: [path.join(tmp, 'missing.zip')] }, /^FEED_PACKAGE_UNREADABLE:/);
    for (const baseUrl of ['ftp://feed.example.invalid', 'https://user:pass@feed.example.invalid', 'https://feed.example.invalid/?x=1', 'feed', '']) {
      await refused({ baseUrl }, /^FEED_BASE_URL_INVALID:/);
    }
    await refused({ channel: 'nightly' as FeedChannel }, /^FEED_CHANNEL_INVALID:/);
    await refused({ seq: -1 }, /^FEED_SEQ_INVALID:/);
    await refused({ seq: 1.5 }, /^FEED_SEQ_INVALID:/);
    await refused({ expiresInDays: 15 }, /^FEED_EXPIRES_INVALID:/);
    await refused({ expiresInDays: 0 }, /^FEED_EXPIRES_INVALID:/);
    await refused({ issuedAt: Number.NaN }, /^FEED_ISSUED_AT_INVALID:/);
    // The signing commands' own refusals (Task 8) come through: a licence key never signs a feed, a timestamp key only
    // signs the freshness document.
    await refused({ releaseKey: devKey('dev-lic-1') }, /^FEED_SIGN_FAILED:.*KEY_USE:release/);
    await refused({ timestampKey: devKey('dev-rel-1') }, /^FRESHNESS_SIGN_FAILED:.*KEY_USE:timestamp/);
    await refused({ issuedAt: Date.now() + 10 * 60_000 }, /^FRESHNESS_SIGN_FAILED:.*ISSUED_AT_AHEAD/);
  });

  it('feeds feed-dev end to end: the feed and the packages fetched from 127.0.0.1 verify and hash as listed', async () => {
    const out = await freshDir('out');
    const dev = await startFeedDev({ dir: out });
    try {
      await buildFeed(options(out, { baseUrl: dev.url }));
      const get = (url: string): Promise<Buffer> =>
        new Promise((resolve, reject) => {
          http
            .get(url, { agent: false }, (res) => {
              const chunks: Buffer[] = [];
              res.on('data', (c: Buffer) => chunks.push(c));
              res.on('end', () => (res.statusCode === 200 ? resolve(Buffer.concat(chunks)) : reject(new Error(`${url} → ${res.statusCode}`))));
            })
            .on('error', reject);
        });
      const fetched: Published = {
        feedText: (await get(`${dev.url}/stable/feed.json`)).toString('utf8'),
        sigText: (await get(`${dev.url}/stable/feed.sig`)).toString('utf8'),
        freshnessText: (await get(`${dev.url}/stable/freshness.json`)).toString('utf8'),
      };
      const verified = verify(fetched, 'stable');
      for (const entry of verified.entries) {
        expect(entry.url.startsWith(`${dev.url}/packages/`)).toBe(true);
        const bytes = await get(entry.url);
        expect(bytes.length).toBe(entry.size);
        expect(sha256(bytes)).toBe(entry.sha256);
      }
      expect(dev.requests.map((r) => r.path)).toEqual([
        '/stable/feed.json',
        '/stable/feed.sig',
        '/stable/freshness.json',
        '/packages/altis-0.2.0-test.zip',
        '/packages/altis-0.3.0-test.zip',
      ]);
    } finally {
      await dev.close();
    }
  });
});

describe('feed:build command line', () => {
  it('parses the options, relative paths from INIT_CWD, --issued-at as an ISO date-time with a zone', () => {
    const argv = [
      '--zip', 'a.zip', '--zip', '/abs/b.zip', '--channel', 'beta', '--base-url', 'http://127.0.0.1:8790', '--out', 'feed',
      '--release-key', 'rel.key.json', '--timestamp-key', 'ts.key.json', '--keyset', 'keyset.json', '--seq', '12',
      '--expires-in-days', '7', '--issued-at', '2026-10-29T10:00:00+07:00', '--root-keys', 'roots.json',
    ];
    expect(parseFeedBuildArgs(argv, { INIT_CWD: '/work' }, '/elsewhere')).toEqual({
      zips: ['/work/a.zip', '/abs/b.zip'],
      channel: 'beta',
      baseUrl: 'http://127.0.0.1:8790',
      out: '/work/feed',
      releaseKey: '/work/rel.key.json',
      timestampKey: '/work/ts.key.json',
      keyset: '/work/keyset.json',
      seq: 12,
      expiresInDays: 7,
      issuedAt: Date.UTC(2026, 9, 29, 3),
      rootKeys: '/work/roots.json',
    });
    const minimal = parseFeedBuildArgs(argv.slice(0, 20), {}, '/here');
    expect(minimal).not.toHaveProperty('issuedAt');
    expect(minimal).not.toHaveProperty('rootKeys');
    expect(minimal.out).toBe('/here/feed');
  });

  it('refuses a missing or malformed option with USAGE', () => {
    const base = ['--zip', 'a.zip', '--channel', 'stable', '--base-url', 'http://127.0.0.1:1', '--out', 'o', '--release-key', 'r', '--timestamp-key', 't', '--keyset', 'k'];
    const env = {};
    expect(() => parseFeedBuildArgs([...base, '--seq', '1'], env, '/')).toThrow(/^USAGE:.*--expires-in-days/);
    expect(() => parseFeedBuildArgs([...base, '--seq', 'x', '--expires-in-days', '7'], env, '/')).toThrow(/^USAGE:.*--seq/);
    expect(() => parseFeedBuildArgs([...base, '--seq', '1', '--expires-in-days', '7', '--issued-at', '2026-10-29'], env, '/')).toThrow(/^USAGE:.*--issued-at/);
    expect(() => parseFeedBuildArgs([...base, '--seq', '1', '--expires-in-days', '7', '--bogus'], env, '/')).toThrow(/^USAGE:/);
  });
});
