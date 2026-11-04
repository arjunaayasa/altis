/**
 * The signed update feed (spec §9.6, §8.3; decisions D1d-3, D1d-35; ruling R1d-2).
 *
 * `<feedBase>/<channel>/feed.json` is the feed payload as text, `feed.sig` its `altis-feed/1` envelope by a `release`
 * key, and `freshness.json` a `{raw, env}` document `altis-timestamp/1` `{feedSha256, seq, issuedAt, expiresAt}` by a
 * `timestamp` key, renewed by automation; the client requires both. The feed carries the latest root-signed keyset
 * documents, so a key rotation or revocation reaches the client through the feed itself (Review Focus 3).
 *
 * Forward compatible: unknown top-level fields (room for `altis-device-revocations/1` lists, a reserved typ) and
 * unknown entry fields are ignored. An entry's own fields keep exactly the bounds of the `update.check` setting's
 * FEED_ENTRY (ruling R1d-2), so a parsed entry can always be stored as the last check's `available`.
 */
import { Buffer } from 'node:buffer';
import { createHash } from 'node:crypto';
import { verifyDetached, type Envelope } from '../envelope.js';
import type { TrustedKey } from '../keys.js';
import { isKeyset, parseKeysetDocs, resolveKeysetSources, type KeysetDoc, type KeysetSource } from '../keyset.js';
import type { ReleaseManifest } from '../manifest.js';
import { isSemverText } from '../semver.js';
import { parseStrictJson } from '../strict-json.js';
import { isCalendarDate } from './dates.js';
import { hasExactKeys, isRecord, isSafeInteger, isSha256Hex, isText } from './fields.js';
import { parseSignedDocFile } from './signed-doc.js';

export const FEED_TYP = 'altis-feed/1';
export const FRESHNESS_TYP = 'altis-timestamp/1';
/** Longest freshness window, `expiresAt − issuedAt` (§9.6: "expiresAt ≤ 14 hari"). */
export const FRESHNESS_MAX_MS = 14 * 86_400_000;

export type FeedChannel = 'stable' | 'beta';

/** One release of the feed (§9.6). After extraction its fields must equal the release manifest's (entryMatchesManifest). */
export interface FeedEntry {
  version: string;
  channel: FeedChannel;
  releasedAt: string;
  bootProtocol: number;
  minUpgradeFrom: string;
  minCodeVersionAfter: string;
  minNode: string;
  minDb: { mysql: string; mariadb: string; postgres: string };
  /** Bytes of the package. */
  size: number;
  /** Hex SHA-256 of the package. */
  sha256: string;
  url: string;
  notesUrl: string | null;
}

export interface FeedPayload {
  v: 1;
  channel: FeedChannel;
  releases: FeedEntry[];
  /** Root-signed keyset documents (§8.3); each counts only through its root signature. */
  keyset: KeysetDoc[];
}

export interface FreshnessPayload {
  /** Hex SHA-256 of the bytes of feed.json. */
  feedSha256: string;
  seq: number;
  issuedAt: number;
  expiresAt: number;
}

export interface VerifiedFeed {
  channel: FeedChannel;
  seq: number;
  /** Signed time: the freshness document's `issuedAt` (D1d-7 raises the clock high water with it). */
  issuedAt: number;
  expiresAt: number;
  entries: FeedEntry[];
  /** The feed's keyset documents as it carries them (Task 10 persists the verified ones). */
  keyset: KeysetDoc[];
  /** Every kid revoked by a valid keyset document, of `sources` or of the feed, sorted. */
  revokedKids: string[];
  /** The keys the feed was verified with: the roots plus what the valid documents trust. */
  trusted: TrustedKey[];
  /** The kid of the timestamp key that signed the freshness document (feed-state.json records it with the seq). */
  timestampKid: string;
}

export interface VerifyFeedOptions {
  feedText: string;
  sigText: string;
  freshnessText: string;
  channel: FeedChannel;
  /** The root keys the build embeds. */
  roots: readonly TrustedKey[];
  /** Root-signed keyset documents kept elsewhere (DATA_DIR/releases/keyset.json, bundled releases). */
  sources: readonly KeysetSource[];
  /** Production builds: documents that trust a `dev-` kid count for nothing (R65b). */
  refuseDevKids: boolean;
  /** Epoch ms. */
  now: number;
  /** The highest seq seen on this channel (feed-state.json): a lower one is refused. */
  minSeq: number;
  /**
   * The kid of the timestamp key whose freshness document set `minSeq` (feed-state.json). The floor holds only while
   * that key is a trusted timestamp key: a root-signed revocation of a leaked key (the feed's own documents included)
   * takes the floor it set with it, which a seq of up to 2^53-1 would otherwise freeze for good (1d review C02). Null or
   * absent: the floor always holds.
   */
  minSeqKid?: string | null;
}

/** Most releases one feed lists. */
const MAX_RELEASES = 4096;
const CHANNELS: readonly string[] = ['stable', 'beta'];
const DB_KEYS = ['mysql', 'mariadb', 'postgres'] as const;
const FEED_SOURCE = 'feed';

/** A short non-empty text of the feed: a version floor such as `minNode` (the setting's `word(64)`). */
const isWord = (value: unknown): value is string => isText(value, 1, 64);
/** A URL text (the setting's `word(2048)`). Where it may point is the feed client's business. */
const isUrlText = (value: unknown): value is string => isText(value, 1, 2048);

function feedFormat(path: string): never {
  throw new Error('FEED_FORMAT:' + path);
}

function readEntry(value: unknown, at: string): FeedEntry {
  if (!isRecord(value)) return feedFormat(at);
  const field = (key: string): unknown => value[key];
  const version = field('version');
  if (!isSemverText(version) || !isText(version, 1, 64)) return feedFormat(at + '.version');
  const channel = field('channel');
  if (typeof channel !== 'string' || CHANNELS.indexOf(channel) === -1) return feedFormat(at + '.channel');
  const releasedAt = field('releasedAt');
  if (!isCalendarDate(releasedAt)) return feedFormat(at + '.releasedAt');
  const bootProtocol = field('bootProtocol');
  if (!isSafeInteger(bootProtocol, 1)) return feedFormat(at + '.bootProtocol');
  const minUpgradeFrom = field('minUpgradeFrom');
  if (!isWord(minUpgradeFrom)) return feedFormat(at + '.minUpgradeFrom');
  const minCodeVersionAfter = field('minCodeVersionAfter');
  if (!isWord(minCodeVersionAfter)) return feedFormat(at + '.minCodeVersionAfter');
  const minNode = field('minNode');
  if (!isWord(minNode)) return feedFormat(at + '.minNode');
  const minDb = field('minDb');
  if (!isRecord(minDb) || !hasExactKeys(minDb, DB_KEYS)) return feedFormat(at + '.minDb'); // exactly three (R1d-2)
  for (const key of DB_KEYS) if (!isWord(minDb[key])) return feedFormat(at + '.minDb.' + key);
  const size = field('size');
  if (!isSafeInteger(size, 0)) return feedFormat(at + '.size');
  const sha256 = field('sha256');
  if (!isSha256Hex(sha256)) return feedFormat(at + '.sha256');
  const url = field('url');
  if (!isUrlText(url)) return feedFormat(at + '.url');
  const notesUrl = field('notesUrl');
  if (notesUrl !== null && !isUrlText(notesUrl)) return feedFormat(at + '.notesUrl');
  return {
    version,
    channel: channel as FeedChannel,
    releasedAt,
    bootProtocol,
    minUpgradeFrom,
    minCodeVersionAfter,
    minNode,
    minDb: { mysql: minDb['mysql'] as string, mariadb: minDb['mariadb'] as string, postgres: minDb['postgres'] as string },
    size,
    sha256,
    url,
    notesUrl,
  };
}

/** The feed's keyset documents in the frozen keyset file format (R65c): an array of at most 4096 documents of 64 KiB. */
function readKeysetDocs(value: unknown): KeysetDoc[] {
  try {
    return parseKeysetDocs(value);
  } catch (err) {
    void err; // the reason is the path
    return feedFormat('keyset');
  }
}

/**
 * Checks a feed payload (the parsed feed.json) and returns a fresh copy of its known fields; unknown fields are ignored
 * at the top and in entries. Entry bounds are those of the `update.check` setting (ruling R1d-2): `version` SemVer of at
 * most 64 characters; `channel` `stable` or `beta`; `releasedAt` a calendar day; `bootProtocol` a whole number >= 1;
 * `minUpgradeFrom`, `minCodeVersionAfter`, `minNode` and the three `minDb` values (exactly `mysql`, `mariadb`,
 * `postgres`) 1-64 code points; `size` a whole number >= 0; `sha256` 64 lower-case hex; `url` 1-2048 code points;
 * `notesUrl` null or 1-2048. Keyset documents are kept as they are (each counts only through a root signature).
 * Throws `Error('FEED_FORMAT:<path>')`: `payload`, `v`, `channel`, `releases`, `releases.3.minDb.mysql`, `keyset`...
 */
export function parseFeedPayload(value: unknown): FeedPayload {
  if (!isRecord(value)) return feedFormat('payload');
  if (value['v'] !== 1) return feedFormat('v');
  const channel = value['channel'];
  if (typeof channel !== 'string' || CHANNELS.indexOf(channel) === -1) return feedFormat('channel');
  const list = value['releases'];
  if (!Array.isArray(list) || list.length > MAX_RELEASES) return feedFormat('releases');
  const releases: FeedEntry[] = [];
  for (let i = 0; i < list.length; i++) releases.push(readEntry(list[i], 'releases.' + i));
  const keyset = readKeysetDocs(value['keyset']);
  return { v: 1, channel: channel as FeedChannel, releases, keyset };
}

/**
 * Checks a freshness payload and returns a copy of its known fields (unknown ones ignored): `feedSha256` 64 lower-case
 * hex, `seq`, `issuedAt` and `expiresAt` whole numbers >= 0. Throws `Error('FRESHNESS_FORMAT:<path>')`.
 */
export function parseFreshnessPayload(value: unknown): FreshnessPayload {
  const invalid = (path: string): never => {
    throw new Error('FRESHNESS_FORMAT:' + path);
  };
  if (!isRecord(value)) return invalid('payload');
  const feedSha256 = value['feedSha256'];
  if (!isSha256Hex(feedSha256)) return invalid('feedSha256');
  const seq = value['seq'];
  if (!isSafeInteger(seq, 0)) return invalid('seq');
  const issuedAt = value['issuedAt'];
  if (!isSafeInteger(issuedAt, 0)) return invalid('issuedAt');
  const expiresAt = value['expiresAt'];
  if (!isSafeInteger(expiresAt, 0)) return invalid('expiresAt');
  return { feedSha256, seq, issuedAt, expiresAt };
}

type FeedReason = 'signature' | 'hash' | 'freshness' | 'expired' | 'seq' | 'channel' | 'shape';

function feedInvalid(reason: FeedReason, cause?: unknown): never {
  throw cause === undefined ? new Error('FEED_INVALID:' + reason) : new Error('FEED_INVALID:' + reason, { cause });
}

/**
 * Whether a seq floor set by the timestamp key `kid` still holds under `trusted` (see VerifyFeedOptions.minSeqKid): always
 * without a kid, else while that kid is a trusted timestamp key.
 */
export function floorHolds(trusted: readonly TrustedKey[], kid: string | null | undefined): boolean {
  return kid === undefined || kid === null || trusted.some((k) => k.kid === kid && k.use === 'timestamp');
}

/** The kids revoked by the documents of `sources` that were not rejected (copies of an accepted document included). */
function revokedKidsOf(sources: readonly KeysetSource[], rejected: { source: string; index: number }[]): string[] {
  const refused = new Set(rejected.map((r) => r.source + '\u0000' + String(r.index)));
  const kids = new Set<string>();
  for (const source of sources) {
    for (let i = 0; i < source.docs.length; i++) {
      if (refused.has(String(source.name) + '\u0000' + String(i))) continue;
      // Not rejected: verified by resolveKeysetSources (strict JSON, a keyset), or a copy of a document that was.
      let payload: unknown;
      try {
        payload = parseStrictJson((source.docs[i] as KeysetDoc).raw);
      } catch (err) {
        void err; // unreachable for a verified document; such a document revokes nothing here
        continue;
      }
      if (isKeyset(payload)) for (const kid of payload.revokedKids) kids.add(kid);
    }
  }
  return Array.from(kids).sort((a, b) => (a < b ? -1 : a > b ? 1 : 0));
}

/**
 * Verifies a fetched feed and returns what it says. Throws `Error('FEED_INVALID:<reason>')` (`cause` set where there is
 * one), checked in this order:
 * 1. `shape`: feed.json is not strict JSON, or its `keyset` is not a list of documents in the keyset file format. The
 *    trusted keys are then resolved from `roots`, `sources` and the feed's own keyset documents (root-signed, so they
 *    are self-validating: a key the feed's documents revoke is no longer trusted, one they add is);
 * 2. `signature`: feed.sig is not a valid `altis-feed/1` envelope over feedText by a trusted `release` key;
 *    `shape`: freshness.json is not a `{raw, env}` document; `signature`: it is not a valid `altis-timestamp/1`
 *    signature by a trusted `timestamp` key;
 * 3. `shape`: the freshness or the feed payload is not of its format (parseFreshnessPayload, parseFeedPayload);
 *    `hash`: `feedSha256` is not the SHA-256 of feedText's UTF-8 bytes;
 * 4. `freshness`: `expiresAt − issuedAt` is negative or above {@link FRESHNESS_MAX_MS}; `expired`: `now > expiresAt`;
 *    `seq`: `seq < minSeq`, while the key named by `minSeqKid` (when set) is a trusted timestamp key;
 * 5. `channel`: the payload's channel, or an entry's, is not `channel`; `shape`: two entries share a version.
 * A TypeError for invalid roots (a programming error).
 */
export function verifyFeed(o: VerifyFeedOptions): VerifiedFeed {
  // 1. Keys: the roots, the documents kept elsewhere and the feed's own documents.
  let unverified: unknown;
  try {
    unverified = parseStrictJson(o.feedText);
  } catch (err) {
    return feedInvalid('shape', err);
  }
  let feedDocs: KeysetDoc[];
  try {
    feedDocs = isRecord(unverified) ? readKeysetDocs(unverified['keyset']) : feedFormat('payload');
  } catch (err) {
    return feedInvalid('shape', err);
  }
  const sources: KeysetSource[] = o.sources.slice();
  sources.push({ name: FEED_SOURCE, docs: feedDocs });
  const report = resolveKeysetSources(o.roots.slice(), sources, { refuseDevKids: o.refuseDevKids === true });
  const trusted = report.keys;

  // 2. Signatures: the feed, then its freshness document.
  let feedValue: unknown;
  try {
    feedValue = verifyDetached(o.feedText, parseStrictJson(o.sigText) as Envelope, trusted, FEED_TYP);
  } catch (err) {
    return feedInvalid('signature', err);
  }
  let freshnessDoc: { raw: string; env: Envelope };
  try {
    freshnessDoc = parseSignedDocFile(o.freshnessText);
  } catch (err) {
    return feedInvalid('shape', err);
  }
  let freshnessValue: unknown;
  try {
    freshnessValue = verifyDetached(freshnessDoc.raw, freshnessDoc.env, trusted, FRESHNESS_TYP);
  } catch (err) {
    return feedInvalid('signature', err);
  }

  // 3. Formats, and the freshness document names these very bytes.
  let freshness: FreshnessPayload;
  let feed: FeedPayload;
  try {
    freshness = parseFreshnessPayload(freshnessValue);
    feed = parseFeedPayload(feedValue);
  } catch (err) {
    return feedInvalid('shape', err);
  }
  const sha256 = createHash('sha256').update(Buffer.from(o.feedText, 'utf8')).digest('hex');
  if (freshness.feedSha256 !== sha256) return feedInvalid('hash');

  // 4. Freshness window, expiry, replay.
  const window = freshness.expiresAt - freshness.issuedAt;
  if (window < 0 || window > FRESHNESS_MAX_MS) return feedInvalid('freshness');
  if (!(o.now <= freshness.expiresAt)) return feedInvalid('expired');
  if (floorHolds(trusted, o.minSeqKid) && !(freshness.seq >= o.minSeq)) return feedInvalid('seq');

  // 5. Channel, and one entry per version.
  if (feed.channel !== o.channel) return feedInvalid('channel');
  const versions = new Set<string>();
  for (const entry of feed.releases) {
    if (entry.channel !== o.channel) return feedInvalid('channel');
    if (versions.has(entry.version)) return feedInvalid('shape');
    versions.add(entry.version);
  }

  return {
    channel: feed.channel,
    seq: freshness.seq,
    issuedAt: freshness.issuedAt,
    expiresAt: freshness.expiresAt,
    entries: feed.releases,
    keyset: feed.keyset,
    revokedKids: revokedKidsOf(sources, report.rejected),
    trusted,
    timestampKid: freshnessDoc.env.kid,
  };
}

/**
 * The first of `version`, `releasedAt`, `bootProtocol`, `minUpgradeFrom`, `minCodeVersionAfter`, `minNode`, `minDb`
 * in which the feed entry differs from the signed release manifest, or null when they are identical (§9.6: "Setelah
 * ekstraksi, nilai-nilai ini wajib identik dengan manifest rilis").
 */
export function entryMatchesManifest(e: FeedEntry, m: ReleaseManifest): string | null {
  if (e.version !== m.version) return 'version';
  if (e.releasedAt !== m.releasedAt) return 'releasedAt';
  if (e.bootProtocol !== m.bootProtocol) return 'bootProtocol';
  if (e.minUpgradeFrom !== m.minUpgradeFrom) return 'minUpgradeFrom';
  if (e.minCodeVersionAfter !== m.minCodeVersionAfter) return 'minCodeVersionAfter';
  if (e.minNode !== m.minNode) return 'minNode';
  for (const key of DB_KEYS) if (e.minDb[key] !== m.minDb[key]) return 'minDb';
  return null;
}
