import { Buffer } from 'node:buffer';
import { createHash, createPrivateKey, type KeyObject } from 'node:crypto';
import { readFileSync } from 'node:fs';
import fsp from 'node:fs/promises';
import path from 'node:path';
import { acceptChunk, completeUpload, createUpload, uploadContext, uploadOwner } from '@altis/core';
import { RELEASE_TYP, canonicalize, signDetached, type KeysetDoc, type KeysetSource, type TrustedKey } from '@altis/crypto';
import { FEED_TYP, FRESHNESS_TYP, type FeedChannel, type FeedEntry } from '@altis/crypto/feed';
import { withTx, type DbHandle } from '@altis/db';

// Release packages, signed feeds and staged update uploads for the update tests of Task 28 (the updates API, the
// permission matrix), with the dev keys of tools/keys/dev: `dev-rel-1` signs release manifests and feeds, `dev-ts-1` the
// freshness documents, and `dev-root-1` (roots.json) is what a test treats as the embedded root keys (a server.mjs that
// the release build did not bundle embeds none). The zip writer and feed-dev are tools/release's, loaded at run time
// (apps/server's TypeScript project cannot reference tools/release, which references apps/server).

/** tools/keys/dev: the public development keys (test fixtures only; a production build refuses every `dev-` kid). */
export const DEV_KEYS = path.resolve(import.meta.dirname, '..', '..', '..', 'tools', 'keys', 'dev');

/** A dev private key by kid. */
export function devKey(kid: string): { kid: string; privateKey: KeyObject } {
  const file = JSON.parse(readFileSync(path.join(DEV_KEYS, `${kid}.key.json`), 'utf8')) as { kid: string; pkcs8: string };
  return { kid: file.kid, privateKey: createPrivateKey({ key: Buffer.from(file.pkcs8, 'base64'), format: 'der', type: 'pkcs8' }) };
}

/** tools/keys/dev/roots.json: what a test build would embed as `__TRUSTED_KEYS__`. */
export const DEV_ROOTS = JSON.parse(readFileSync(path.join(DEV_KEYS, 'roots.json'), 'utf8')) as TrustedKey[];
/** tools/keys/dev/keyset.json: dev-root-1 trusts dev-rel-1, dev-ts-1 and the other dev keys. */
export const DEV_KEYSET = JSON.parse(readFileSync(path.join(DEV_KEYS, 'keyset.json'), 'utf8')) as KeysetDoc[];

/** The package keys of a test app (`services.updates.packageKeys`): the dev root, nothing else kept. */
export const devPackageKeys = async (): Promise<{ roots: readonly TrustedKey[]; sources: KeysetSource[]; refuseDevKids: boolean }> => ({
  roots: DEV_ROOTS,
  sources: [],
  refuseDevKids: false,
});

const REPO_ROOT = path.resolve(import.meta.dirname, '..', '..', '..');
const sha256 = (data: Uint8Array | string): string => createHash('sha256').update(data).digest('hex');

type ZipInput = { path: string; data: Uint8Array };
type WriteZip = (entries: readonly ZipInput[]) => Buffer;
let zipWriter: WriteZip | undefined;

/** feed-dev (tools/release/feed/serve.ts) as the tests use it. */
export interface FeedDev {
  url: string;
  requests: { path: string; range: string | null }[];
  close(): Promise<void>;
}

/** Starts feed-dev on `dir` (127.0.0.1, a free port). */
export async function startFeedDev(o: { dir: string }): Promise<FeedDev> {
  const mod = (await import(path.join(REPO_ROOT, 'tools', 'release', 'feed', 'serve.ts'))) as { startFeedDev(o: { dir: string }): Promise<FeedDev> };
  return mod.startFeedDev(o);
}

/** `n` bytes no compressor can shrink, the same every run. */
function noise(n: number, seed: string): Buffer {
  const out = Buffer.alloc(n);
  for (let at = 0, i = 0; at < n; i += 1) at += createHash('sha256').update(`${seed}:${i}`).digest().copy(out, at);
  return out;
}

export interface PackageOptions {
  /** Default `0.2.0-test`. */
  version?: string;
  /** Manifest fields replaced or added. */
  meta?: Record<string, unknown>;
  /** The kid that signs manifest.sig (default dev-rel-1). */
  signer?: string;
  /** The envelope's `typ` (default `altis-release/1`): A7's "typ salah" signs with another. */
  typ?: string;
}

/**
 * A release zip as `pnpm release` lays it out (app.js, package.json, `bundled-release/<v>/` with server.mjs, public
 * files, keyset.json, manifest.json, manifest.sig and `.complete`), and its manifest.
 */
export async function releasePackage(o: PackageOptions = {}): Promise<{ zip: Buffer; manifest: Record<string, unknown> }> {
  const writeZip: WriteZip = (zipWriter ??= ((await import(new URL('../../../tools/release/src/zip.ts', import.meta.url).href)) as { writeZip: WriteZip }).writeZip);
  const version = o.version ?? '0.2.0-test';
  const files: Record<string, Buffer> = {
    'server.mjs': Buffer.from(`export const bootProtocol = 1;\nexport async function start() {}\nexport async function runCli() { return 0; }\n// ${version}\n`),
    'keyset.json': Buffer.from(`${JSON.stringify(DEV_KEYSET, null, 2)}\n`),
    'public/admin/index.html': Buffer.from(`<!doctype html><title>ALTIS ${version}</title>\n`),
    'public/admin/assets/app-3f2a.js': noise(2048, `app-${version}`),
  };
  const list = Object.keys(files)
    .sort((a, b) => (a < b ? -1 : a > b ? 1 : 0))
    .map((p) => ({ path: p, sha256: sha256(files[p]!), size: files[p]!.byteLength }));
  const manifest: Record<string, unknown> = {
    version,
    buildId: `build-${version}`,
    bootProtocol: 1,
    releasedAt: '2026-10-20',
    schemaLatest: '9001',
    minCodeVersionAfter: '0.0.0',
    minUpgradeFrom: '0.0.0',
    minNode: '22.16.0',
    minDb: { mysql: '8.0.0', mariadb: '10.6.0', postgres: '15.0.0' },
    files: list,
    ...o.meta,
  };
  const signer = devKey(o.signer ?? 'dev-rel-1');
  const sig = JSON.stringify(signDetached(manifest, { typ: o.typ ?? RELEASE_TYP, kid: signer.kid, privateKey: signer.privateKey }));
  const folder = `bundled-release/${version}/`;
  const release: ZipInput[] = Object.entries(files).map(([p, data]) => ({ path: folder + p, data }));
  release.push({ path: `${folder}manifest.json`, data: Buffer.from(`${JSON.stringify(manifest, null, 2)}\n`) });
  release.push({ path: `${folder}manifest.sig`, data: Buffer.from(sig) });
  release.sort((a, b) => (a.path < b.path ? -1 : a.path > b.path ? 1 : 0));
  const zip = writeZip([
    { path: 'app.js', data: Buffer.from('"use strict";\n') },
    { path: 'package.json', data: Buffer.from(`{"name":"altis","version":${JSON.stringify(version)}}\n`) },
    ...release,
    { path: `${folder}.complete`, data: Buffer.alloc(0) },
  ]);
  return { zip, manifest };
}

/** The feed entry of a package served at `url` (its size and SHA-256), with the manifest's facts. */
export function feedEntryOf(zip: Buffer, manifest: Record<string, unknown>, url: string, over: Partial<FeedEntry> = {}): FeedEntry {
  return {
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
    url,
    notesUrl: null,
    ...over,
  };
}

/**
 * Writes `<dir>/<channel>/{feed.json, feed.sig, freshness.json}` as sign-cli's `feed sign` and `freshness sign` do
 * (dev-rel-1 and dev-ts-1), issued at `issuedAt` (default an hour ago) and fresh for 7 days.
 */
export async function publishFeed(dir: string, channel: FeedChannel, seq: number, releases: readonly FeedEntry[], o: { issuedAt?: number } = {}): Promise<void> {
  const payload = { v: 1, channel, releases: releases.map((e) => ({ ...e, channel })), keyset: DEV_KEYSET };
  const text = canonicalize(payload);
  const rel = devKey('dev-rel-1');
  const ts = devKey('dev-ts-1');
  const env = signDetached(payload, { typ: FEED_TYP, kid: rel.kid, privateKey: rel.privateKey });
  const issuedAt = o.issuedAt ?? Date.now() - 3_600_000;
  const freshness = { feedSha256: sha256(text), seq, issuedAt, expiresAt: issuedAt + 7 * 86_400_000 };
  const freshnessEnv = signDetached(freshness, { typ: FRESHNESS_TYP, kid: ts.kid, privateKey: ts.privateKey });
  const out = path.join(dir, channel);
  await fsp.mkdir(out, { recursive: true });
  await fsp.writeFile(path.join(out, 'feed.json'), text);
  await fsp.writeFile(path.join(out, 'feed.sig'), `${JSON.stringify(env, null, 2)}\n`);
  await fsp.writeFile(path.join(out, 'freshness.json'), `${JSON.stringify({ raw: canonicalize(freshness), env: freshnessEnv }, null, 2)}\n`);
}

/** A completed upload of context `update` of staff user `userId` holding `zip`, staged in `s.dataDir`; its id. */
export async function stagedUpdateUpload(s: { h: DbHandle; dataDir: string; now: number }, userId: string, zip: Uint8Array): Promise<string> {
  const owner = uploadOwner(userId);
  const context = uploadContext('update');
  if (context === null) throw new Error('no `update` upload context');
  const { id } = await withTx(s.h, (trx) => createUpload(trx, { owner, context, size: zip.byteLength, sha256: sha256(zip), now: s.now, dataDir: s.dataDir }));
  await acceptChunk(s.h, { id, owner, n: 0, data: zip, now: s.now, dataDir: s.dataDir });
  await completeUpload(s.h, { id, owner, now: s.now, dataDir: s.dataDir });
  return id;
}
