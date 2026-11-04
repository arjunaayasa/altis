import { createHash, createPrivateKey, randomBytes, type KeyObject } from 'node:crypto';
import { readFileSync } from 'node:fs';
import fsp from 'node:fs/promises';
import http from 'node:http';
import type { AddressInfo } from 'node:net';
import os from 'node:os';
import path from 'node:path';
import { canonicalize, generateKeyPair, readKeysetWithBak, signDetached, type KeysetDoc, type TrustedKey } from '@altis/crypto';
import { FEED_TYP, FRESHNESS_TYP, type FeedChannel, type FeedEntry } from '@altis/crypto/feed';
import { releaseStagingPath, resetTestFaults, type DataPath, type Env } from '@altis/platform';
import { DomainError, isDomainError } from '@altis/shared';
import { afterAll, afterEach, beforeAll, beforeEach, describe, expect, it } from 'vitest';
import type { CoreLogger } from '../src/context.js';
import { raiseFeedSeq, readFeedState } from '../src/updates/feed-state.js';
import { appendKeysetDocs, persistKeysetDocs } from '../src/updates/keyset-store.js';
import { createUpdateSource, type UpdateSource } from '../src/updates/source.js';

// The feed client, UpdateSource (spec §9.6, §13.8; plan Task 20; D1d-29; preflight 1D-12, 1D-18). fetchFeed fetches
// `<feedBase>/<channel>/feed.json`, `feed.sig` and `freshness.json` over node:https (plain http to loopback in tests),
// verifies them (verifyFeed of Task 3) against the roots and the installation's keyset documents with the channel's
// highest seq seen as the floor, then persists the feed's keyset documents, raises the seq in
// DATA_DIR/releases/feed-state.json (per channel) and reports the freshness `issuedAt` as signed time. download fetches
// a package into the update's staging folder, resumable with Range from the partial file's size (its identity kept in
// download.json), bounded by a deadline, refused as soon as it outgrows the entry's size, and checked by size and
// SHA-256 once whole.
//
// The feed folder has the layout of Task 17's feed:build output (<dir>/<channel>/{feed.json, feed.sig,
// freshness.json}, <dir>/packages/<zip>), written here with the dev keys exactly as sign-cli's `feed sign` and
// `freshness sign` write it, so each test can choose its seq, signer, expiry and keyset documents; feed-dev
// (tools/release/feed/serve.ts) serves it. feed-dev is loaded at run time: packages/core's TypeScript project cannot
// reference tools/release (which references apps/server, through the bootloader, and so packages/core).

interface FeedDev {
  url: string;
  requests: { path: string; range: string | null }[];
  close(): Promise<void>;
}
type StartFeedDev = (o: { dir: string; throttleBytesPerSec?: number; ignoreRange?: boolean; dropAfterBytes?: number }) => Promise<FeedDev>;
const REPO_ROOT = path.resolve(import.meta.dirname, '..', '..', '..');
const FEED_DEV_MODULE = path.join(REPO_ROOT, 'tools', 'release', 'feed', 'serve.ts');
const DEV_KEYS = path.join(REPO_ROOT, 'tools', 'keys', 'dev');
const readDev = (name: string): unknown => JSON.parse(readFileSync(path.join(DEV_KEYS, name), 'utf8')) as unknown;

function devKey(kid: string): KeyObject {
  const file = readDev(`${kid}.key.json`) as { pkcs8: string };
  return createPrivateKey({ key: Buffer.from(file.pkcs8, 'base64'), format: 'der', type: 'pkcs8' });
}

/** tools/keys/dev/roots.json: dev-root-1. */
const ROOTS = readDev('roots.json') as TrustedKey[];
/** tools/keys/dev/keyset.json: dev-root-1 trusts dev-rel-1, dev-rel-2, dev-ts-1 and the other dev keys. */
const DEV_KEYSET = readDev('keyset.json') as KeysetDoc[];

function rootSigned(payload: unknown): KeysetDoc {
  return { raw: JSON.stringify(payload), env: signDetached(payload, { typ: 'altis-keyset/1', kid: 'dev-root-1', privateKey: devKey('dev-root-1') }) };
}

/** A dev-root-1 document revoking dev-rel-2 (Review Focus 3: a leaked release key). */
const REVOKE_REL_2 = rootSigned({ seq: 2, keys: [], revokedKids: ['dev-rel-2'] });

const sha256 = (bytes: Uint8Array | string): string => createHash('sha256').update(bytes).digest('hex');
const DAY_MS = 86_400_000;
/** The clock of every source here (2027-01-15): freshness documents are dated relative to it. */
const NOW = 1_800_000_000_000;
const OP_ID = '01JBQ7Z8X5N0C3Y4V6T2R9M1KD';
const VERSION = '0.2.0-test';
const PKG_NAME = `altis-${VERSION}.zip`;
const PKG_SIZE = 3 * 1024 * 1024;

const silent: CoreLogger = { info() {}, warn() {}, error() {} };

let startFeedDev: StartFeedDev;
let tmp: string;
let counter = 0;
let feedDir: string;
let dataDir: string;
let pkg: Buffer;
const servers: { close(): Promise<void> }[] = [];

beforeAll(async () => {
  ({ startFeedDev } = (await import(FEED_DEV_MODULE)) as { startFeedDev: StartFeedDev });
  tmp = await fsp.realpath(await fsp.mkdtemp(path.join(os.tmpdir(), 'altis-updates-source-')));
  pkg = randomBytes(PKG_SIZE);
});

beforeEach(async () => {
  const n = counter++;
  feedDir = path.join(tmp, `feed-${n}`);
  dataDir = path.join(tmp, `data-${n}`);
  await fsp.mkdir(path.join(feedDir, 'packages'), { recursive: true });
  await fsp.mkdir(dataDir, { recursive: true });
  await fsp.writeFile(path.join(feedDir, 'packages', PKG_NAME), pkg);
});

afterEach(async () => {
  for (const server of servers.splice(0)) await server.close();
});

afterAll(async () => {
  await fsp.rm(tmp, { recursive: true, force: true });
});

async function feedDev(o: { throttleBytesPerSec?: number; ignoreRange?: boolean; dropAfterBytes?: number } = {}): Promise<FeedDev> {
  const server = await startFeedDev({ dir: feedDir, ...o });
  servers.push(server);
  return server;
}

/** The entry of the package served at `base` (sha256 and size of the bytes, unless given). */
function entryAt(base: string, over: Partial<FeedEntry> = {}): FeedEntry {
  return {
    version: VERSION,
    channel: 'stable',
    releasedAt: '2026-10-20',
    bootProtocol: 1,
    minUpgradeFrom: '0.0.0',
    minCodeVersionAfter: '0.0.0',
    minNode: '22.16.0',
    minDb: { mysql: '8.0.0', mariadb: '10.6.0', postgres: '15.0.0' },
    size: pkg.length,
    sha256: sha256(pkg),
    url: `${base}/packages/${PKG_NAME}`,
    notesUrl: null,
    ...over,
  };
}

interface PublishOptions {
  seq: number;
  /** Default NOW − 1 h. */
  issuedAt?: number;
  /** freshness expiresAt − issuedAt in days (default 7). */
  days?: number;
  /** The release key that signs feed.json (default dev-rel-1). */
  signer?: string;
  /** Default the dev keyset (tools/keys/dev/keyset.json). */
  keyset?: KeysetDoc[];
  releases?: FeedEntry[];
  /** The timestamp key that signs freshness.json (default dev-ts-1). */
  ts?: { kid: string; privateKey: KeyObject };
}

/** Writes `<feedDir>/<channel>/{feed.json, feed.sig, freshness.json}` as sign-cli's `feed sign` and `freshness sign` do. */
async function publish(channel: FeedChannel, o: PublishOptions): Promise<void> {
  const payload = { v: 1, channel, releases: (o.releases ?? []).map((e) => ({ ...e, channel })), keyset: o.keyset ?? DEV_KEYSET };
  const text = canonicalize(payload);
  const signer = o.signer ?? 'dev-rel-1';
  const env = signDetached(payload, { typ: FEED_TYP, kid: signer, privateKey: devKey(signer) });
  const issuedAt = o.issuedAt ?? NOW - 3_600_000;
  const freshness = { feedSha256: sha256(text), seq: o.seq, issuedAt, expiresAt: issuedAt + (o.days ?? 7) * DAY_MS };
  const ts = o.ts ?? { kid: 'dev-ts-1', privateKey: devKey('dev-ts-1') };
  const freshnessEnv = signDetached(freshness, { typ: FRESHNESS_TYP, kid: ts.kid, privateKey: ts.privateKey });
  const out = path.join(feedDir, channel);
  await fsp.mkdir(out, { recursive: true });
  await fsp.writeFile(path.join(out, 'feed.json'), text);
  await fsp.writeFile(path.join(out, 'feed.sig'), `${JSON.stringify(env, null, 2)}\n`);
  await fsp.writeFile(path.join(out, 'freshness.json'), `${JSON.stringify({ raw: canonicalize(freshness), env: freshnessEnv }, null, 2)}\n`);
}

const storeFile = (): string => path.join(dataDir, 'releases', 'keyset.json');
const feedStateFile = (): string => path.join(dataDir, 'releases', 'feed-state.json');
const dest = (): DataPath => releaseStagingPath(dataDir, VERSION, OP_ID, 'package.zip');
const downloadJson = (): string => path.join(dataDir, 'releases', `.tmp-${VERSION}-${OP_ID}`, 'download.json');

interface Made {
  source: UpdateSource;
  signedTimes: { at: number; source: 'feed' }[];
}

function makeSource(o: { feedBase: string | null | (() => string | null); env?: Env; clock?: () => number; persisted?: () => Promise<void> }): Made {
  const signedTimes: { at: number; source: 'feed' }[] = [];
  const { feedBase } = o;
  const source = createUpdateSource({
    feedBase: typeof feedBase === 'function' ? feedBase : () => feedBase,
    dataDir,
    roots: ROOTS,
    // The installation's keyset documents: the store (DATA_DIR/releases/keyset.json with its .bak).
    sources: async () => (await readKeysetWithBak(storeFile(), 'DATA_DIR/releases/keyset.json')).sources,
    refuseDevKids: false,
    allowLoopbackHttp: true,
    clock: o.clock ?? (() => NOW),
    log: silent,
    persistKeysets: async (docs) => {
      await persistKeysetDocs({ dataDir, roots: ROOTS, docs, refuseDevKids: false, log: silent, now: NOW });
      await o.persisted?.();
    },
    onSignedTime: async (t) => {
      signedTimes.push(t);
    },
    env: o.env ?? {},
  });
  return { source, signedTimes };
}

async function failure(promise: Promise<unknown>): Promise<{ code: string; reason: unknown }> {
  try {
    await promise;
  } catch (error) {
    if (!isDomainError(error)) throw error;
    return { code: error.code, reason: error.meta?.['reason'] };
  }
  throw new Error('expected a DomainError, the call resolved');
}

const exists = (file: string): Promise<boolean> =>
  fsp.stat(file).then(
    () => true,
    () => false,
  );

describe('fetchFeed', () => {
  it('a valid feed → its entries; feed-state.json holds the seq; a lower seq next → seq, the file unchanged; expired → expired', async () => {
    const dev = await feedDev();
    const entry = entryAt(dev.url);
    await publish('stable', { seq: 5, releases: [entry] });
    const { source } = makeSource({ feedBase: dev.url });

    const feed = await source.fetchFeed('stable');
    expect(feed).toMatchObject({ channel: 'stable', seq: 5, issuedAt: NOW - 3_600_000 });
    expect(feed.entries).toEqual([entry]);
    expect(JSON.parse(await fsp.readFile(feedStateFile(), 'utf8'))).toEqual({ stable: { seq: 5, at: NOW, kid: 'dev-ts-1' } });
    expect(await readFeedState(dataDir, 'stable')).toEqual({ seq: 5, at: NOW, kid: 'dev-ts-1' });
    expect(dev.requests.map((r) => r.path).sort()).toEqual(['/stable/feed.json', '/stable/feed.sig', '/stable/freshness.json']);

    const before = await fsp.readFile(feedStateFile(), 'utf8');
    await publish('stable', { seq: 4, releases: [entry] });
    expect(await failure(source.fetchFeed('stable'))).toEqual({ code: 'FEED_INVALID', reason: 'seq' });
    expect(await fsp.readFile(feedStateFile(), 'utf8')).toBe(before);

    // The same seq again is accepted (a feed fetched twice); an expired freshness document is not.
    await publish('stable', { seq: 5, releases: [entry] });
    expect((await source.fetchFeed('stable')).seq).toBe(5);
    await publish('stable', { seq: 6, issuedAt: NOW - 10 * DAY_MS, days: 7, releases: [entry] });
    expect(await failure(source.fetchFeed('stable'))).toEqual({ code: 'FEED_INVALID', reason: 'expired' });
    expect(await readFeedState(dataDir, 'stable')).toEqual({ seq: 5, at: NOW, kid: 'dev-ts-1' });
  });

  it('1D-12: the seq is kept per channel (beta 40, stable 3 both accepted; beta 39 → seq; beta 41 → accepted)', async () => {
    const dev = await feedDev();
    const { source } = makeSource({ feedBase: dev.url });
    await publish('beta', { seq: 40 });
    await publish('stable', { seq: 3 });
    expect((await source.fetchFeed('beta')).seq).toBe(40);
    expect((await source.fetchFeed('stable')).seq).toBe(3);
    await publish('beta', { seq: 39 });
    expect(await failure(source.fetchFeed('beta'))).toEqual({ code: 'FEED_INVALID', reason: 'seq' });
    await publish('beta', { seq: 41 });
    expect((await source.fetchFeed('beta')).seq).toBe(41);
    expect(JSON.parse(await fsp.readFile(feedStateFile(), 'utf8'))).toEqual({
      stable: { seq: 3, at: NOW, kid: 'dev-ts-1' },
      beta: { seq: 41, at: NOW, kid: 'dev-ts-1' },
    });
    // The other channel's file is never read for a channel: stable is still 3.
    expect((await source.fetchFeed('stable')).seq).toBe(3);
  });

  it('Review Focus 3: with the store revoking dev-rel-2, a feed signed by dev-rel-2 → signature', async () => {
    const dev = await feedDev();
    const { source } = makeSource({ feedBase: dev.url });
    await publish('stable', { seq: 1, signer: 'dev-rel-2' });
    // Trusted through the dev keyset as long as nothing revokes it ...
    expect((await source.fetchFeed('stable')).seq).toBe(1);
    // ... and refused once the store holds the revocation, although the feed's own keyset still trusts it.
    const appended = await appendKeysetDocs({ dataDir, roots: ROOTS, docs: [REVOKE_REL_2], refuseDevKids: false, log: silent });
    expect(appended.added).toBe(1);
    await publish('stable', { seq: 2, signer: 'dev-rel-2' });
    expect(await failure(source.fetchFeed('stable'))).toEqual({ code: 'FEED_INVALID', reason: 'signature' });
    expect(await readFeedState(dataDir, 'stable')).toEqual({ seq: 1, at: NOW, kid: 'dev-ts-1' });
    // A feed signed by dev-rel-1 still passes, and is told about the revocation.
    await publish('stable', { seq: 2 });
    expect((await source.fetchFeed('stable')).revokedKids).toEqual(['dev-rel-2']);
  });

  it('a feed carrying a new root document → DATA_DIR/releases/keyset.json gains it; onSignedTime gets the freshness issuedAt', async () => {
    const dev = await feedDev();
    const { source, signedTimes } = makeSource({ feedBase: dev.url });
    const added = rootSigned({ seq: 3, keys: [], revokedKids: ['unused-kid-9'] });
    const issuedAt = NOW - 7_200_000;
    await publish('stable', { seq: 9, issuedAt, keyset: [...DEV_KEYSET, added] });

    const feed = await source.fetchFeed('stable');
    expect(feed.revokedKids).toEqual(['unused-kid-9']);
    const stored = JSON.parse(await fsp.readFile(storeFile(), 'utf8')) as KeysetDoc[];
    expect(stored).toContainEqual(added);
    expect(stored).toContainEqual(DEV_KEYSET[0]);
    expect(signedTimes).toEqual([{ at: issuedAt, source: 'feed' }]);

    // A revocation the feed carried keeps applying after the feed drops it: the store has it (Review Focus 3).
    await publish('stable', { seq: 10, keyset: DEV_KEYSET });
    expect((await source.fetchFeed('stable')).revokedKids).toEqual(['unused-kid-9']);
  });

  it('a feed signed by an untrusted key, or a missing file, persists nothing and raises no seq', async () => {
    const dev = await feedDev();
    const { source, signedTimes } = makeSource({ feedBase: dev.url });
    await publish('stable', { seq: 7, signer: 'dev-lic-1' }); // a licence key never signs feeds
    expect(await failure(source.fetchFeed('stable'))).toEqual({ code: 'FEED_INVALID', reason: 'signature' });
    await fsp.rm(path.join(feedDir, 'beta'), { recursive: true, force: true });
    expect(await failure(source.fetchFeed('beta'))).toEqual({ code: 'FEED_UNREACHABLE', reason: 'status' });
    expect(await exists(feedStateFile())).toBe(false);
    expect(await exists(storeFile())).toBe(false);
    expect(signedTimes).toEqual([]);
  });

  it('http://example.com/feed → FEED_UNREACHABLE reason insecure; no feed base → no_feed_url', async () => {
    expect(await failure(makeSource({ feedBase: 'http://example.com/feed' }).source.fetchFeed('stable'))).toEqual({
      code: 'FEED_UNREACHABLE',
      reason: 'insecure',
    });
    expect(await failure(makeSource({ feedBase: null }).source.fetchFeed('stable'))).toEqual({ code: 'FEED_UNREACHABLE', reason: 'no_feed_url' });
  });

  it('feedConfigured: true for a feed base (one fetchFeed refuses included), false for none or an empty one', () => {
    expect(makeSource({ feedBase: 'https://feed.example/altis' }).source.feedConfigured()).toBe(true);
    expect(makeSource({ feedBase: 'http://example.com/feed' }).source.feedConfigured()).toBe(true);
    expect(makeSource({ feedBase: null }).source.feedConfigured()).toBe(false);
    expect(makeSource({ feedBase: '' }).source.feedConfigured()).toBe(false);
    // A feed base that cannot be read counts as set: the check then reports why it fails, and no caller fails here.
    const unreadable = (): string | null => {
      throw new DomainError('INVALID_CONFIG');
    };
    expect(makeSource({ feedBase: unreadable }).source.feedConfigured()).toBe(true);
  });

  it('P6: a later seq another process accepted while this fetch ran → seq, and no signed time from the older feed', async () => {
    const dev = await feedDev();
    await publish('stable', { seq: 5 });
    // Another process accepts seq 6 of this channel between this fetch's verification and its raise.
    const { source, signedTimes } = makeSource({ feedBase: dev.url, persisted: () => raiseFeedSeq(dataDir, 'stable', 6, NOW + 1) });
    expect(await failure(source.fetchFeed('stable'))).toEqual({ code: 'FEED_INVALID', reason: 'seq' });
    expect(await readFeedState(dataDir, 'stable')).toEqual({ seq: 6, at: NOW + 1 });
    expect(signedTimes).toEqual([]);
  });

  it('1d review C02: a floor pushed to 2^53-1 by a leaked timestamp key goes with the key once a feed revokes it', async () => {
    const MAX = Number.MAX_SAFE_INTEGER;
    const pair = generateKeyPair();
    const ts2 = { kid: 'dev-ts-2', privateKey: pair.privateKey };
    const recovery = [...DEV_KEYSET, rootSigned({ seq: 2, keys: [{ kid: 'dev-ts-2', use: 'timestamp', pub: pair.pub }], revokedKids: ['dev-ts-1'] })];
    const dev = await feedDev();
    const { source } = makeSource({ feedBase: dev.url });
    // The holder of the leaked dev-ts-1 signs seq 2^53-1 over the genuine feed.
    await publish('stable', { seq: MAX });
    expect((await source.fetchFeed('stable')).seq).toBe(MAX);
    expect(await readFeedState(dataDir, 'stable')).toEqual({ seq: MAX, at: NOW, kid: 'dev-ts-1' });
    // The recovery from a leaked timestamp key: a root document trusting dev-ts-2 and revoking dev-ts-1 in the feed,
    // the freshness by dev-ts-2 with the counter's next seq. The floor of the revoked key no longer holds.
    await publish('stable', { seq: 6, ts: ts2, keyset: recovery });
    expect((await source.fetchFeed('stable')).seq).toBe(6);
    expect(await readFeedState(dataDir, 'stable')).toEqual({ seq: 6, at: NOW, kid: 'dev-ts-2' });
    // From then on the new floor holds, and the leaked key signs nothing, even under a feed without the revocation
    // (the store kept it).
    await publish('stable', { seq: 5, ts: ts2, keyset: recovery });
    expect(await failure(source.fetchFeed('stable'))).toEqual({ code: 'FEED_INVALID', reason: 'seq' });
    await publish('stable', { seq: MAX });
    expect(await failure(source.fetchFeed('stable'))).toEqual({ code: 'FEED_INVALID', reason: 'signature' });
    expect(await readFeedState(dataDir, 'stable')).toEqual({ seq: 6, at: NOW, kid: 'dev-ts-2' });
  });

  it('a feed base with a trailing slash names the same files', async () => {
    const dev = await feedDev();
    await publish('stable', { seq: 1 });
    expect((await makeSource({ feedBase: `${dev.url}/` }).source.fetchFeed('stable')).seq).toBe(1);
    expect(dev.requests.map((r) => r.path).sort()).toEqual(['/stable/feed.json', '/stable/feed.sig', '/stable/freshness.json']);
  });
});

describe('feed-state.json (per channel, never lowered, atomic with .bak)', () => {
  it('raiseFeedSeq never lowers; a .bak follows the second write; unknown keys are kept', async () => {
    expect(await readFeedState(dataDir, 'stable')).toBeNull();
    await raiseFeedSeq(dataDir, 'stable', 5, NOW);
    await raiseFeedSeq(dataDir, 'stable', 3, NOW + 1);
    await raiseFeedSeq(dataDir, 'stable', 5, NOW + 2);
    expect(await readFeedState(dataDir, 'stable')).toEqual({ seq: 5, at: NOW });
    await raiseFeedSeq(dataDir, 'stable', 6, NOW + 3);
    expect(await readFeedState(dataDir, 'stable')).toEqual({ seq: 6, at: NOW + 3 });
    expect(JSON.parse(await fsp.readFile(`${feedStateFile()}.bak`, 'utf8'))).toEqual({ stable: { seq: 5, at: NOW } });

    // A later release's channel (or field) survives a write of this one.
    await fsp.writeFile(feedStateFile(), JSON.stringify({ stable: { seq: 6, at: NOW + 3 }, nightly: { seq: 99, at: 1 } }));
    await raiseFeedSeq(dataDir, 'beta', 2, NOW + 4);
    expect(JSON.parse(await fsp.readFile(feedStateFile(), 'utf8'))).toEqual({
      stable: { seq: 6, at: NOW + 3 },
      nightly: { seq: 99, at: 1 },
      beta: { seq: 2, at: NOW + 4 },
    });
  });

  it('1d review C02: a floor whose kid is no longer trusted is replaced, even by a lower seq; one without a kid always holds', async () => {
    const trusted = (kid: string): boolean => kid !== 'ts-1';
    await raiseFeedSeq(dataDir, 'stable', 90, NOW, { kid: 'ts-1', trusted });
    expect(await readFeedState(dataDir, 'stable')).toEqual({ seq: 90, at: NOW, kid: 'ts-1' });
    await raiseFeedSeq(dataDir, 'stable', 3, NOW + 1, { kid: 'ts-2', trusted });
    expect(await readFeedState(dataDir, 'stable')).toEqual({ seq: 3, at: NOW + 1, kid: 'ts-2' });
    await raiseFeedSeq(dataDir, 'stable', 2, NOW + 2, { kid: 'ts-2', trusted });
    await raiseFeedSeq(dataDir, 'stable', 3, NOW + 3, { kid: 'ts-2', trusted });
    expect(await readFeedState(dataDir, 'stable')).toEqual({ seq: 3, at: NOW + 1, kid: 'ts-2' });
    // A file of a release before C02 (no kid): its floor holds whatever key signs now.
    await fsp.writeFile(feedStateFile(), JSON.stringify({ beta: { seq: 50, at: 1 } }));
    await raiseFeedSeq(dataDir, 'beta', 4, NOW, { kid: 'ts-2', trusted: () => false });
    expect(await readFeedState(dataDir, 'beta')).toEqual({ seq: 50, at: 1 });
    for (const kid of ['', 5, 'x'.repeat(65)]) {
      await fsp.writeFile(feedStateFile(), JSON.stringify({ beta: { seq: 50, at: 1, kid } }));
      await fsp.rm(`${feedStateFile()}.bak`, { force: true });
      expect(await failure(readFeedState(dataDir, 'beta'))).toMatchObject({ code: 'STATE_CORRUPT' });
    }
  });

  it('concurrent raises keep the highest (releases/feed-state.lock)', async () => {
    const seqs = Array.from({ length: 12 }, (_, i) => (i * 7) % 12);
    await Promise.all(seqs.map((seq) => raiseFeedSeq(dataDir, 'stable', seq, NOW + seq)));
    expect(await readFeedState(dataDir, 'stable')).toEqual({ seq: 11, at: NOW + 11 });
    expect(await exists(path.join(dataDir, 'releases', 'feed-state.lock'))).toBe(false);
  });

  it('a damaged file falls back to its .bak; both damaged → STATE_CORRUPT', async () => {
    await raiseFeedSeq(dataDir, 'stable', 4, NOW);
    await raiseFeedSeq(dataDir, 'stable', 8, NOW + 1);
    await fsp.writeFile(feedStateFile(), '{"stable": {"seq": "eight"}}');
    expect(await readFeedState(dataDir, 'stable')).toEqual({ seq: 4, at: NOW });
    await fsp.writeFile(`${feedStateFile()}.bak`, 'not json');
    expect(await failure(readFeedState(dataDir, 'stable'))).toMatchObject({ code: 'STATE_CORRUPT' });
  });

  it('refuses a channel other than stable or beta and a seq that is not a whole number', async () => {
    await expect(readFeedState(dataDir, 'nightly' as FeedChannel)).rejects.toThrow(TypeError);
    await expect(raiseFeedSeq(dataDir, 'stable', -1, NOW)).rejects.toThrow(TypeError);
    await expect(raiseFeedSeq(dataDir, 'stable', 1.5, NOW)).rejects.toThrow(TypeError);
  });
});

describe('download', () => {
  it('a 3 MiB package throttled past the deadline → complete: false; the next call sends Range: bytes=<n>- and completes', async () => {
    const dev = await feedDev({ throttleBytesPerSec: 2 * 1024 * 1024 });
    const entry = entryAt(dev.url);
    const { source } = makeSource({ feedBase: dev.url });
    const progress: number[] = [];

    const first = await source.download(entry, dest(), (bytes, total) => {
      expect(total).toBe(PKG_SIZE);
      progress.push(bytes);
    }, { deadline: NOW + 500 });
    expect(first.complete).toBe(false);
    expect(first.bytes).toBeGreaterThan(128 * 1024);
    expect(first.bytes).toBeLessThan(PKG_SIZE);
    expect((await fsp.stat(dest())).size).toBe(first.bytes);
    expect(progress[progress.length - 1]).toBe(first.bytes);
    expect(JSON.parse(await fsp.readFile(downloadJson(), 'utf8'))).toEqual({ url: entry.url, sha256: entry.sha256 });

    const second = await source.download(entry, dest(), () => {}, { deadline: NOW + 20_000 });
    expect(second).toEqual({ complete: true, bytes: PKG_SIZE });
    expect(dev.requests).toEqual([
      { path: `/packages/${PKG_NAME}`, range: null },
      { path: `/packages/${PKG_NAME}`, range: `bytes=${first.bytes}-` },
    ]);
    expect(sha256(await fsp.readFile(dest()))).toBe(entry.sha256);

    // Complete already: verified again without a request.
    expect(await source.download(entry, dest(), () => {})).toEqual({ complete: true, bytes: PKG_SIZE });
    expect(dev.requests).toHaveLength(2);
  });

  it('ignoreRange: the 200 restarts from 0 and completes (the partial bytes are not kept)', async () => {
    const dev = await feedDev({ ignoreRange: true });
    const entry = entryAt(dev.url);
    // A partial file of other bytes, under this package's resume state: resuming it would end in a hash failure.
    await fsp.mkdir(path.dirname(dest()), { recursive: true });
    await fsp.writeFile(dest(), randomBytes(500_000));
    await fsp.writeFile(downloadJson(), JSON.stringify({ url: entry.url, sha256: entry.sha256 }));
    const { source } = makeSource({ feedBase: dev.url });

    expect(await source.download(entry, dest(), () => {})).toEqual({ complete: true, bytes: PKG_SIZE });
    expect(dev.requests).toEqual([{ path: `/packages/${PKG_NAME}`, range: 'bytes=500000-' }]);
    expect(sha256(await fsp.readFile(dest()))).toBe(entry.sha256);
  });

  it('dropAfterBytes: the dropped call fails with network and keeps its bytes; the next call resumes', async () => {
    const dev = await feedDev({ dropAfterBytes: 1024 * 1024 });
    const entry = entryAt(dev.url);
    const { source } = makeSource({ feedBase: dev.url });

    expect(await failure(source.download(entry, dest(), () => {}))).toEqual({ code: 'UPDATE_DOWNLOAD_FAILED', reason: 'network' });
    const kept = (await fsp.stat(dest())).size;
    expect(kept).toBeGreaterThan(0);
    expect(kept).toBeLessThanOrEqual(1024 * 1024);

    let result: { complete: boolean; bytes: number } | undefined;
    for (let attempt = 0; attempt < 5 && result === undefined; attempt++) {
      try {
        result = await source.download(entry, dest(), () => {});
      } catch (error) {
        if (!isDomainError(error) || error.code !== 'UPDATE_DOWNLOAD_FAILED') throw error;
      }
    }
    expect(result).toEqual({ complete: true, bytes: PKG_SIZE });
    expect(dev.requests[1]).toEqual({ path: `/packages/${PKG_NAME}`, range: `bytes=${kept}-` });
    const starts = dev.requests.map((r) => (r.range === null ? 0 : Number(/^bytes=(\d+)-$/.exec(r.range)?.[1])));
    expect(starts).toEqual([...starts].sort((a, b) => a - b));
    expect(new Set(starts).size).toBe(starts.length);
    expect(sha256(await fsp.readFile(dest()))).toBe(entry.sha256);
  });

  it('download-corrupt → UPDATE_PACKAGE_INVALID reason hash, dest removed', async () => {
    const dev = await feedDev();
    const entry = entryAt(dev.url);
    for (const fault of ['download-corrupt', 'download-corrupt:1048576']) {
      const { source } = makeSource({ feedBase: dev.url, env: { ALTIS_TEST_FAULT: fault } });
      expect(await failure(source.download(entry, dest(), () => {}))).toEqual({ code: 'UPDATE_PACKAGE_INVALID', reason: 'hash' });
      expect(await exists(dest())).toBe(false);
    }
    // Without the fault the same bytes pass.
    expect(await makeSource({ feedBase: dev.url }).source.download(entry, dest(), () => {})).toEqual({ complete: true, bytes: PKG_SIZE });
  });

  it('bytes that do not hash to entry.sha256 → reason hash, dest removed', async () => {
    const dev = await feedDev();
    const entry = entryAt(dev.url, { sha256: sha256('another package') });
    expect(await failure(makeSource({ feedBase: dev.url }).source.download(entry, dest(), () => {}))).toEqual({
      code: 'UPDATE_PACKAGE_INVALID',
      reason: 'hash',
    });
    expect(await exists(dest())).toBe(false);
  });

  it('a server sending more bytes than entry.size → reason size, dest removed (announced, or streamed without a length)', async () => {
    const dev = await feedDev();
    const small = entryAt(dev.url, { size: PKG_SIZE - 1 });
    expect(await failure(makeSource({ feedBase: dev.url }).source.download(small, dest(), () => {}))).toEqual({
      code: 'UPDATE_PACKAGE_INVALID',
      reason: 'size',
    });
    expect(await exists(dest())).toBe(false);

    // A mirror that streams without a length and does not stop: refused as soon as the bytes pass entry.size.
    let sent = 0;
    let closed = false;
    const server = http.createServer((_req, res) => {
      res.writeHead(200, { 'Content-Type': 'application/zip' });
      const chunk = randomBytes(64 * 1024);
      const pump = (): void => {
        if (closed || res.destroyed) return;
        sent += chunk.length;
        if (res.write(chunk)) setImmediate(pump);
        else res.once('drain', pump);
      };
      res.on('close', () => {
        closed = true;
      });
      pump();
    });
    await new Promise<void>((resolve) => server.listen(0, '127.0.0.1', resolve));
    servers.push({ close: () => new Promise<void>((resolve) => (server.close(() => resolve()), server.closeAllConnections())) });
    const base = `http://127.0.0.1:${(server.address() as AddressInfo).port}`;
    const endless = entryAt(base, { size: 300_000 });
    const sizes: number[] = [];
    expect(await failure(makeSource({ feedBase: base }).source.download(endless, dest(), (bytes) => void sizes.push(bytes)))).toEqual({
      code: 'UPDATE_PACKAGE_INVALID',
      reason: 'size',
    });
    expect(await exists(dest())).toBe(false);
    expect(Math.max(...sizes)).toBeLessThanOrEqual(300_000);
    await new Promise((resolve) => setTimeout(resolve, 100));
    expect(closed).toBe(true); // the client hung up
    expect(sent).toBeLessThan(64 * 1024 * 1024);
  });

  it('a partial file of another package (download.json) or without download.json is dropped: the download starts at 0', async () => {
    const dev = await feedDev();
    const entry = entryAt(dev.url);
    const { source } = makeSource({ feedBase: dev.url });
    await fsp.mkdir(path.dirname(dest()), { recursive: true });

    await fsp.writeFile(dest(), randomBytes(1000)); // killed before download.json? never: but a stray file is not trusted
    expect(await source.download(entry, dest(), () => {})).toEqual({ complete: true, bytes: PKG_SIZE });
    await fsp.writeFile(dest(), pkg.subarray(0, 1000));
    await fsp.writeFile(downloadJson(), JSON.stringify({ url: entry.url, sha256: sha256('an older package') }));
    expect(await source.download(entry, dest(), () => {})).toEqual({ complete: true, bytes: PKG_SIZE });
    expect(dev.requests.map((r) => r.range)).toEqual([null, null]);
    expect(JSON.parse(await fsp.readFile(downloadJson(), 'utf8'))).toEqual({ url: entry.url, sha256: entry.sha256 });
  });

  it('a partial file larger than entry.size → reason size, dest removed, nothing fetched', async () => {
    const dev = await feedDev();
    const entry = entryAt(dev.url, { size: 1000, sha256: sha256(pkg.subarray(0, 1000)) });
    await fsp.mkdir(path.dirname(dest()), { recursive: true });
    await fsp.writeFile(downloadJson(), JSON.stringify({ url: entry.url, sha256: entry.sha256 }));
    await fsp.writeFile(dest(), pkg.subarray(0, 2000));
    expect(await failure(makeSource({ feedBase: dev.url }).source.download(entry, dest(), () => {}))).toEqual({
      code: 'UPDATE_PACKAGE_INVALID',
      reason: 'size',
    });
    expect(await exists(dest())).toBe(false);
    expect(dev.requests).toEqual([]);
  });

  it('an empty package is fetched (the file made) and verified like any other', async () => {
    const dev = await feedDev();
    await fsp.writeFile(path.join(feedDir, 'packages', 'empty.zip'), '');
    const entry = entryAt(dev.url, { size: 0, sha256: sha256(''), url: `${dev.url}/packages/empty.zip` });
    const { source } = makeSource({ feedBase: dev.url });
    expect(await source.download(entry, dest(), () => {})).toEqual({ complete: true, bytes: 0 });
    expect((await fsp.stat(dest())).size).toBe(0);
    expect(await source.download(entry, dest(), () => {})).toEqual({ complete: true, bytes: 0 });
    expect(dev.requests).toHaveLength(1);
  });

  it('a deadline already passed → complete: false with nothing fetched', async () => {
    const dev = await feedDev();
    const { source } = makeSource({ feedBase: dev.url });
    expect(await source.download(entryAt(dev.url), dest(), () => {}, { deadline: NOW })).toEqual({ complete: false, bytes: 0 });
    expect(dev.requests).toEqual([]);
  });

  it('disk-full:releases:<n> applies: DISK_QUOTA', async () => {
    const dev = await feedDev();
    const entry = entryAt(dev.url);
    const { source } = makeSource({ feedBase: dev.url });
    const saved = process.env['ALTIS_TEST_FAULT'];
    try {
      for (const n of [1, 2]) {
        resetTestFaults();
        process.env['ALTIS_TEST_FAULT'] = `disk-full:releases:${n}`;
        expect(await failure(source.download(entry, dest(), () => {}))).toMatchObject({ code: 'DISK_QUOTA' });
      }
    } finally {
      if (saved === undefined) delete process.env['ALTIS_TEST_FAULT'];
      else process.env['ALTIS_TEST_FAULT'] = saved;
      resetTestFaults();
    }
    expect(await source.download(entry, dest(), () => {})).toEqual({ complete: true, bytes: PKG_SIZE });
  });

  it('refuses a dest that is not this DATA_DIR’s releases/.tmp-<v>-<opId>/package.zip', async () => {
    const dev = await feedDev();
    const { source } = makeSource({ feedBase: dev.url });
    const elsewhere = releaseStagingPath(dataDir, VERSION, OP_ID, 'download.json');
    await expect(source.download(entryAt(dev.url), elsewhere, () => {})).rejects.toThrow(TypeError);
    const otherData = releaseStagingPath(path.join(tmp, 'other-data'), VERSION, OP_ID, 'package.zip');
    await expect(source.download(entryAt(dev.url), otherData, () => {})).rejects.toThrow(TypeError);
    expect(dev.requests).toEqual([]);
  });

  it('an insecure package URL → UPDATE_DOWNLOAD_FAILED reason insecure', async () => {
    const { source } = makeSource({ feedBase: null });
    expect(await failure(source.download(entryAt('http://example.com'), dest(), () => {}))).toEqual({
      code: 'UPDATE_DOWNLOAD_FAILED',
      reason: 'insecure',
    });
  });
});

describe('P18', () => {
  it('the feed client never calls fetch (node:https only)', async () => {
    for (const name of ['https.ts', 'feed-state.ts', 'source.ts']) {
      const text = await fsp.readFile(path.join(REPO_ROOT, 'packages', 'core', 'src', 'updates', name), 'utf8');
      expect(text, name).not.toContain('fetch(');
      expect(text, name).not.toMatch(/(from|import\(|require\()\s*['"]undici/);
    }
  });
});

describe('portability (single PCs run Windows)', () => {
  it('download never truncates its package file: Windows refuses ftruncate on an append-mode handle', async () => {
    const text = await fsp.readFile(path.join(REPO_ROOT, 'packages', 'core', 'src', 'updates', 'source.ts'), 'utf8');
    expect(text).not.toMatch(/\.truncate\(/);
  });
});
