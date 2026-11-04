import { createHash } from 'node:crypto';
import { describe, expect, it } from 'vitest';
import { TYP_USE, signDetached } from '../../src/envelope.js';
import { canonicalize } from '../../src/jcs.js';
import { generateKeyPair, type TrustedKey } from '../../src/keys.js';
import type { KeysetDoc } from '../../src/keyset.js';
import type { ReleaseManifest } from '../../src/manifest.js';
import {
  FEED_TYP,
  FRESHNESS_MAX_MS,
  FRESHNESS_TYP,
  entryMatchesManifest,
  parseFeedPayload,
  parseFreshnessPayload,
  verifyFeed,
  type FeedEntry,
  type VerifiedFeed,
} from '../../src/feed/index.js';
import { devKey, devKeyset, devRoots, devTrusted, type DevKey } from './dev-keys.js';

// Spec §9.6: feed.json + feed.sig (release key) + freshness.json (altis-timestamp/1, timestamp key, at most 14 days);
// the feed carries the latest root-signed keyset documents (§8.3). Review Focus 3: a revocation carried by the feed
// applies to the feed itself.

const DAY = 86_400_000;
const ISSUED = Date.UTC(2026, 10, 1, 4);
const NOW = ISSUED + 3_600_000;

const rel1 = devKey('dev-rel-1');
const rel2 = devKey('dev-rel-2');
const ts1 = devKey('dev-ts-1');
const lic1 = devKey('dev-lic-1');
const root1 = devKey('dev-root-1');
const ROOTS = devRoots();
const SOURCES = [{ name: 'bundled', docs: devKeyset() }];
const pubOf = (kid: string): string => (devTrusted().find((k) => k.kid === kid) as TrustedKey).pub;

const ENTRY: FeedEntry = {
  version: '0.2.0-test',
  channel: 'stable',
  releasedAt: '2026-11-01',
  bootProtocol: 1,
  minUpgradeFrom: '0.0.0',
  minCodeVersionAfter: '0.1.0-test',
  minNode: '22.16.0',
  minDb: { mysql: '8.0', mariadb: '10.6', postgres: '15' },
  size: 12_345_678,
  sha256: 'ab'.repeat(32),
  url: 'https://updates.example.org/packages/altis-0.2.0-test.zip',
  notesUrl: null,
};
const ENTRY_03: FeedEntry = { ...ENTRY, version: '0.3.0-test', releasedAt: '2026-11-15', minCodeVersionAfter: '0.3.0-test', notesUrl: 'https://updates.example.org/notes/0.3.0-test' };

/** A root-signed keyset document. */
function rootDoc(payload: { seq: number; keys: TrustedKey[]; revokedKids: string[] }): KeysetDoc {
  return { raw: canonicalize(payload), env: signDetached(payload, { typ: 'altis-keyset/1', kid: root1.kid, privateKey: root1.privateKey }) };
}

type FeedOptions = {
  payload?: Record<string, unknown>;
  signer?: DevKey;
  /** The text of feed.json; default the canonical form of the payload. */
  feedText?: string;
  fresh?: Partial<{ feedSha256: string; seq: number; issuedAt: number; expiresAt: number }>;
  freshSigner?: DevKey;
};

type Texts = { feedText: string; sigText: string; freshnessText: string };

function makeFeed(o: FeedOptions = {}): Texts {
  const payload = o.payload ?? { v: 1, channel: 'stable', releases: [ENTRY, ENTRY_03], keyset: devKeyset() };
  const signer = o.signer ?? rel1;
  const feedText = o.feedText ?? canonicalize(payload);
  const sigText = JSON.stringify(signDetached(payload, { typ: FEED_TYP, kid: signer.kid, privateKey: signer.privateKey }));
  const fresh = {
    feedSha256: createHash('sha256').update(feedText, 'utf8').digest('hex'),
    seq: 7,
    issuedAt: ISSUED,
    expiresAt: ISSUED + 7 * DAY,
    ...o.fresh,
  };
  const freshSigner = o.freshSigner ?? ts1;
  const freshnessText = JSON.stringify({
    raw: canonicalize(fresh),
    env: signDetached(fresh, { typ: FRESHNESS_TYP, kid: freshSigner.kid, privateKey: freshSigner.privateKey }),
  });
  return { feedText, sigText, freshnessText };
}

type VerifyOptions = Partial<Omit<Parameters<typeof verifyFeed>[0], keyof Texts>>;

function verify(texts: Texts, o: VerifyOptions = {}): VerifiedFeed {
  return verifyFeed({ ...texts, channel: 'stable', roots: ROOTS, sources: SOURCES, refuseDevKids: false, now: NOW, minSeq: 0, ...o });
}

function reasonOf(texts: Texts, o: VerifyOptions = {}): string {
  try {
    verify(texts, o);
  } catch (err) {
    return (err as Error).message;
  }
  return 'accepted';
}

describe('feed constants', () => {
  it('typs and the freshness bound (§9.6)', () => {
    expect(FEED_TYP).toBe('altis-feed/1');
    expect(FRESHNESS_TYP).toBe('altis-timestamp/1');
    expect(TYP_USE[FEED_TYP]).toBe('release');
    expect(TYP_USE[FRESHNESS_TYP]).toBe('timestamp');
    expect(FRESHNESS_MAX_MS).toBe(14 * DAY);
  });
});

describe('verifyFeed', () => {
  it('a feed signed by dev-rel-1 with freshness by dev-ts-1, minSeq 0 → the entries and the seq', () => {
    const feed = verify(makeFeed());
    expect(feed.channel).toBe('stable');
    expect(feed.seq).toBe(7);
    expect(feed.issuedAt).toBe(ISSUED);
    expect(feed.expiresAt).toBe(ISSUED + 7 * DAY);
    expect(feed.entries).toStrictEqual([ENTRY, ENTRY_03]);
    expect(feed.keyset).toStrictEqual(devKeyset());
    expect(feed.revokedKids).toEqual([]);
    expect(feed.trusted.map((k) => k.kid).sort()).toEqual(['dev-dca-1', 'dev-lic-1', 'dev-rel-1', 'dev-rel-2', 'dev-root-1', 'dev-ts-1']);
  });

  it('accepts the bounds themselves: a 14-day window, now = expiresAt, seq = minSeq', () => {
    const texts = makeFeed({ fresh: { expiresAt: ISSUED + FRESHNESS_MAX_MS } });
    expect(verify(texts, { now: ISSUED + FRESHNESS_MAX_MS, minSeq: 7 }).seq).toBe(7);
  });

  it('feed.sig by dev-ts-1 → FEED_INVALID:signature', () => {
    expect(reasonOf(makeFeed({ signer: ts1 }))).toBe('FEED_INVALID:signature');
  });

  it('feed.sig by a licence key, or by a release key nobody trusts → FEED_INVALID:signature', () => {
    expect(reasonOf(makeFeed({ signer: lic1 }))).toBe('FEED_INVALID:signature');
    expect(reasonOf(makeFeed({ signer: { kid: 'dev-rel-9', privateKey: generateKeyPair().privateKey } }))).toBe('FEED_INVALID:signature');
  });

  it('a feed.sig that is not an envelope, or over other bytes → FEED_INVALID:signature', () => {
    const texts = makeFeed();
    expect(reasonOf({ ...texts, sigText: '{"typ":' })).toBe('FEED_INVALID:signature');
    expect(reasonOf({ ...texts, sigText: '[]' })).toBe('FEED_INVALID:signature');
    const other = makeFeed({ payload: { v: 1, channel: 'stable', releases: [ENTRY], keyset: devKeyset() } });
    expect(reasonOf({ ...texts, sigText: other.sigText })).toBe('FEED_INVALID:signature');
  });

  it('freshness signed by a release key → FEED_INVALID:signature', () => {
    expect(reasonOf(makeFeed({ freshSigner: rel1 }))).toBe('FEED_INVALID:signature');
  });

  it('freshness feedSha256 of other bytes → FEED_INVALID:hash', () => {
    const other = createHash('sha256').update('{}', 'utf8').digest('hex');
    expect(reasonOf(makeFeed({ fresh: { feedSha256: other } }))).toBe('FEED_INVALID:hash');
  });

  it('the hash covers the bytes of feed.json, not its meaning: re-serialised, the same payload fails', () => {
    const texts = makeFeed();
    const pretty = JSON.stringify(JSON.parse(texts.feedText), null, 2);
    expect(reasonOf({ ...texts, feedText: pretty })).toBe('FEED_INVALID:hash');
  });

  it('expiresAt − issuedAt = 15 d → FEED_INVALID:freshness', () => {
    expect(reasonOf(makeFeed({ fresh: { expiresAt: ISSUED + 15 * DAY } }))).toBe('FEED_INVALID:freshness');
    expect(reasonOf(makeFeed({ fresh: { expiresAt: ISSUED + FRESHNESS_MAX_MS + 1 } }))).toBe('FEED_INVALID:freshness');
    expect(reasonOf(makeFeed({ fresh: { expiresAt: ISSUED - 1 } }))).toBe('FEED_INVALID:freshness');
  });

  it('now > expiresAt → FEED_INVALID:expired', () => {
    expect(reasonOf(makeFeed(), { now: ISSUED + 7 * DAY + 1 })).toBe('FEED_INVALID:expired');
  });

  it('seq 4 with minSeq 5 → FEED_INVALID:seq', () => {
    expect(reasonOf(makeFeed({ fresh: { seq: 4 } }), { minSeq: 5 })).toBe('FEED_INVALID:seq');
  });

  it('channel beta asked, payload stable → FEED_INVALID:channel; an entry of another channel too', () => {
    expect(reasonOf(makeFeed(), { channel: 'beta' })).toBe('FEED_INVALID:channel');
    const mixed = { v: 1, channel: 'stable', releases: [ENTRY, { ...ENTRY_03, channel: 'beta' }], keyset: devKeyset() };
    expect(reasonOf(makeFeed({ payload: mixed }))).toBe('FEED_INVALID:channel');
    const beta = { v: 1, channel: 'beta', releases: [{ ...ENTRY, channel: 'beta' }], keyset: devKeyset() };
    expect(verify(makeFeed({ payload: beta }), { channel: 'beta' }).entries).toHaveLength(1);
  });

  it('entries are unique by version → FEED_INVALID:shape', () => {
    const twice = { v: 1, channel: 'stable', releases: [ENTRY, { ...ENTRY, url: 'https://mirror.example.org/x.zip' }], keyset: devKeyset() };
    expect(reasonOf(makeFeed({ payload: twice }))).toBe('FEED_INVALID:shape');
  });

  it('a payload, freshness document or file that is not of the format → FEED_INVALID:shape', () => {
    expect(reasonOf(makeFeed({ payload: { v: 2, channel: 'stable', releases: [], keyset: [] } }))).toBe('FEED_INVALID:shape');
    expect(reasonOf(makeFeed({ payload: { v: 1, channel: 'stable', releases: [{ ...ENTRY, size: -1 }], keyset: devKeyset() } }))).toBe(
      'FEED_INVALID:shape',
    );
    expect(reasonOf(makeFeed({ payload: { v: 1, channel: 'stable', releases: [], keyset: {} } }))).toBe('FEED_INVALID:shape');
    const texts = makeFeed();
    expect(reasonOf({ ...texts, feedText: texts.feedText + 'x' })).toBe('FEED_INVALID:shape');
    expect(reasonOf({ ...texts, freshnessText: '{"raw": "{}"}' })).toBe('FEED_INVALID:shape');
    expect(reasonOf(makeFeed({ fresh: { seq: -1 } }))).toBe('FEED_INVALID:shape');
  });

  it('an unknown top-level field (e.g. a reserved deviceRevocations list) is ignored', () => {
    const payload = { v: 1, channel: 'stable', releases: [ENTRY], keyset: devKeyset(), deviceRevocations: [{ raw: '{}', env: {} }] };
    const feed = verify(makeFeed({ payload }));
    expect(feed.entries).toStrictEqual([ENTRY]);
    expect(JSON.stringify(feed)).not.toMatch(/deviceRevocations/);
  });

  it('an unknown entry field is dropped from the entry', () => {
    const payload = { v: 1, channel: 'stable', releases: [{ ...ENTRY, firmware: { gate: '>=2.1' } }], keyset: devKeyset() };
    expect(verify(makeFeed({ payload })).entries).toStrictEqual([ENTRY]);
  });

  describe('Review Focus 3: a leaked release key revoked through the feed', () => {
    const revokeRel2 = rootDoc({ seq: 2, keys: [], revokedKids: ['dev-rel-2'] });

    it('control: a feed signed by dev-rel-2 verifies while nothing revokes it', () => {
      expect(verify(makeFeed({ signer: rel2 })).seq).toBe(7);
    });

    it('a feed signed by dev-rel-2 whose keyset carries a dev-root-1 document revoking dev-rel-2 → FEED_INVALID:signature', () => {
      const payload = { v: 1, channel: 'stable', releases: [ENTRY], keyset: [...devKeyset(), revokeRel2] };
      expect(reasonOf(makeFeed({ payload, signer: rel2 }))).toBe('FEED_INVALID:signature');
    });

    it('the same feed signed by dev-rel-1 verifies, reports the revoked kid and no longer trusts dev-rel-2', () => {
      const payload = { v: 1, channel: 'stable', releases: [ENTRY], keyset: [...devKeyset(), revokeRel2] };
      const feed = verify(makeFeed({ payload }));
      expect(feed.revokedKids).toEqual(['dev-rel-2']);
      expect(feed.trusted.map((k) => k.kid)).not.toContain('dev-rel-2');
      expect(feed.trusted.map((k) => k.pub)).not.toContain(pubOf('dev-rel-2'));
      expect(feed.keyset).toHaveLength(2);
    });

    it('a revocation in another source (DATA_DIR keyset.json) applies too', () => {
      const sources = [...SOURCES, { name: 'data', docs: [revokeRel2] }];
      expect(reasonOf(makeFeed({ signer: rel2 }), { sources })).toBe('FEED_INVALID:signature');
    });
  });

  describe('rotation through the feed', () => {
    const fresh = generateKeyPair();
    const rel3: DevKey = { kid: 'dev-rel-3', privateKey: fresh.privateKey };
    const trustRel3 = rootDoc({ seq: 2, keys: [{ kid: 'dev-rel-3', use: 'release', pub: fresh.pub }], revokedKids: [] });

    it('a feed signed by a freshly generated rel key that a dev-root-1 document in the same feed trusts → verified', () => {
      const payload = { v: 1, channel: 'stable', releases: [ENTRY], keyset: [...devKeyset(), trustRel3] };
      const feed = verify(makeFeed({ payload, signer: rel3 }));
      expect(feed.entries).toStrictEqual([ENTRY]);
      expect(feed.trusted).toContainEqual({ kid: 'dev-rel-3', use: 'release', pub: fresh.pub });
    });

    it('the feed documents count on their own, with no other source', () => {
      const payload = { v: 1, channel: 'stable', releases: [ENTRY], keyset: [...devKeyset(), trustRel3] };
      expect(verify(makeFeed({ payload, signer: rel3 }), { sources: [] }).seq).toBe(7);
    });

    it('control: without that document → FEED_INVALID:signature', () => {
      expect(reasonOf(makeFeed({ signer: rel3 }))).toBe('FEED_INVALID:signature');
    });

    it('a document in the feed signed by a release key, not a root, counts for nothing', () => {
      const payload = { seq: 3, keys: [{ kid: 'dev-rel-3', use: 'release', pub: fresh.pub }], revokedKids: [] };
      const byRelease: KeysetDoc = { raw: canonicalize(payload), env: signDetached(payload, { typ: 'altis-keyset/1', kid: rel1.kid, privateKey: rel1.privateKey }) };
      const feed = { v: 1, channel: 'stable', releases: [ENTRY], keyset: [...devKeyset(), byRelease] };
      expect(reasonOf(makeFeed({ payload: feed, signer: rel3 }))).toBe('FEED_INVALID:signature');
    });
  });

  it('refuseDevKids (production): documents trusting dev- keys count for nothing, so a dev-signed feed fails', () => {
    expect(reasonOf(makeFeed(), { refuseDevKids: true })).toBe('FEED_INVALID:signature');
  });

  describe('1d review C02: the seq floor belongs to the timestamp key that set it', () => {
    const MAX = Number.MAX_SAFE_INTEGER;
    const fresh = generateKeyPair();
    const ts2: DevKey = { kid: 'dev-ts-2', privateKey: fresh.privateKey };
    const ts2Key: TrustedKey = { kid: 'dev-ts-2', use: 'timestamp', pub: fresh.pub };
    /** A leaked timestamp key: a root document trusting ts-2 and revoking the leaked ts-1, carried by the feed. */
    const recovery = { v: 1, channel: 'stable', releases: [ENTRY], keyset: [...devKeyset(), rootDoc({ seq: 2, keys: [ts2Key], revokedKids: ['dev-ts-1'] })] };
    /** A planned rotation: ts-2 trusted next to ts-1. */
    const rotation = { v: 1, channel: 'stable', releases: [ENTRY], keyset: [...devKeyset(), rootDoc({ seq: 2, keys: [ts2Key], revokedKids: [] })] };

    it('reports the kid of the timestamp key that signed the freshness document', () => {
      expect(verify(makeFeed()).timestampKid).toBe('dev-ts-1');
      expect(verify(makeFeed({ payload: rotation, freshSigner: ts2 })).timestampKid).toBe('dev-ts-2');
    });

    it('a floor of 2^53-1 set by the leaked dev-ts-1 does not hold once the feed revokes dev-ts-1: dev-ts-2 at seq 8 → accepted', () => {
      const feed = verify(makeFeed({ payload: recovery, freshSigner: ts2, fresh: { seq: 8 } }), { minSeq: MAX, minSeqKid: 'dev-ts-1' });
      expect(feed.seq).toBe(8);
      expect(feed.timestampKid).toBe('dev-ts-2');
      // the leaked key itself signs nothing any more
      expect(reasonOf(makeFeed({ payload: recovery, fresh: { seq: MAX } }), { minSeq: MAX, minSeqKid: 'dev-ts-1' })).toBe('FEED_INVALID:signature');
    });

    it('a floor whose key is still trusted holds, whichever key signs now; so does one with no kid recorded', () => {
      const lower = makeFeed({ payload: rotation, freshSigner: ts2, fresh: { seq: 8 } });
      expect(reasonOf(lower, { minSeq: 9, minSeqKid: 'dev-ts-1' })).toBe('FEED_INVALID:seq');
      expect(reasonOf(lower, { minSeq: 9, minSeqKid: 'dev-ts-2' })).toBe('FEED_INVALID:seq');
      expect(reasonOf(lower, { minSeq: 9, minSeqKid: null })).toBe('FEED_INVALID:seq');
      expect(reasonOf(lower, { minSeq: 9 })).toBe('FEED_INVALID:seq');
      expect(verify(lower, { minSeq: 8, minSeqKid: 'dev-ts-1' }).seq).toBe(8);
    });
  });
});

describe('parseFeedPayload', () => {
  const payload = { v: 1, channel: 'stable', releases: [ENTRY, ENTRY_03], keyset: devKeyset() };

  function formatError(value: unknown): string {
    try {
      parseFeedPayload(value);
    } catch (err) {
      return (err as Error).message;
    }
    return 'accepted';
  }
  const withEntry = (patch: Record<string, unknown>): unknown => ({ ...payload, releases: [ENTRY, { ...ENTRY_03, ...patch }] });

  it('returns {v, channel, releases, keyset}, unknown fields ignored at the top and in entries', () => {
    const parsed = parseFeedPayload({ ...payload, deviceRevocations: [], releases: [{ ...ENTRY, extra: 1 }, ENTRY_03] });
    expect(parsed).toStrictEqual(payload);
  });

  it('applies the bounds of the update.check setting (ruling R1d-2)', () => {
    expect(parseFeedPayload(withEntry({ version: '1.0.0-' + 'a'.repeat(58) })).releases[1]?.version).toHaveLength(64);
    expect(formatError(withEntry({ version: '1.0.0-' + 'a'.repeat(59) }))).toBe('FEED_FORMAT:releases.1.version');
    expect(formatError(withEntry({ version: 'v0.3.0' }))).toBe('FEED_FORMAT:releases.1.version');
    expect(formatError(withEntry({ channel: 'nightly' }))).toBe('FEED_FORMAT:releases.1.channel');
    expect(formatError(withEntry({ releasedAt: '2026-02-30' }))).toBe('FEED_FORMAT:releases.1.releasedAt');
    expect(formatError(withEntry({ bootProtocol: 0 }))).toBe('FEED_FORMAT:releases.1.bootProtocol');
    expect(formatError(withEntry({ bootProtocol: 1.5 }))).toBe('FEED_FORMAT:releases.1.bootProtocol');
    expect(parseFeedPayload(withEntry({ bootProtocol: 2 })).releases[1]?.bootProtocol).toBe(2);
    expect(formatError(withEntry({ minUpgradeFrom: '' }))).toBe('FEED_FORMAT:releases.1.minUpgradeFrom');
    expect(formatError(withEntry({ minCodeVersionAfter: 'x'.repeat(65) }))).toBe('FEED_FORMAT:releases.1.minCodeVersionAfter');
    expect(formatError(withEntry({ minNode: null }))).toBe('FEED_FORMAT:releases.1.minNode');
    expect(formatError(withEntry({ minDb: { ...ENTRY.minDb, sqlite: '3.45' } }))).toBe('FEED_FORMAT:releases.1.minDb');
    expect(formatError(withEntry({ minDb: { mysql: '8.0', mariadb: '10.6' } }))).toBe('FEED_FORMAT:releases.1.minDb');
    expect(formatError(withEntry({ minDb: { ...ENTRY.minDb, postgres: '' } }))).toBe('FEED_FORMAT:releases.1.minDb.postgres');
    expect(formatError(withEntry({ size: -1 }))).toBe('FEED_FORMAT:releases.1.size');
    expect(formatError(withEntry({ size: 2 ** 53 }))).toBe('FEED_FORMAT:releases.1.size');
    expect(parseFeedPayload(withEntry({ size: 0 })).releases[1]?.size).toBe(0);
    expect(formatError(withEntry({ sha256: 'AB'.repeat(32) }))).toBe('FEED_FORMAT:releases.1.sha256');
    expect(formatError(withEntry({ url: '' }))).toBe('FEED_FORMAT:releases.1.url');
    expect(parseFeedPayload(withEntry({ url: '😀'.repeat(2048) })).releases[1]?.url).toHaveLength(4096); // code points, as Zod
    expect(formatError(withEntry({ url: 'u'.repeat(2049) }))).toBe('FEED_FORMAT:releases.1.url');
    expect(formatError(withEntry({ notesUrl: '' }))).toBe('FEED_FORMAT:releases.1.notesUrl');
    expect(formatError(withEntry({ notesUrl: undefined }))).toBe('FEED_FORMAT:releases.1.notesUrl');
    expect(formatError(withEntry({ url: 'https://x/\ud800' }))).toBe('FEED_FORMAT:releases.1.url');
  });

  it('names the top-level fields it refuses', () => {
    expect(formatError(null)).toBe('FEED_FORMAT:payload');
    expect(formatError({ ...payload, v: 2 })).toBe('FEED_FORMAT:v');
    expect(formatError({ ...payload, channel: 'Stable' })).toBe('FEED_FORMAT:channel');
    expect(formatError({ ...payload, releases: {} })).toBe('FEED_FORMAT:releases');
    expect(formatError({ ...payload, releases: [null] })).toBe('FEED_FORMAT:releases.0');
    expect(formatError({ ...payload, keyset: undefined })).toBe('FEED_FORMAT:keyset');
    expect(formatError({ ...payload, keyset: [{ raw: 'x'.repeat(64 * 1024), env: {} }] })).toBe('FEED_FORMAT:keyset');
  });
});

describe('parseFreshnessPayload', () => {
  const fresh = { feedSha256: 'cd'.repeat(32), seq: 3, issuedAt: ISSUED, expiresAt: ISSUED + DAY };

  it('reads {feedSha256, seq, issuedAt, expiresAt}, unknown fields ignored', () => {
    expect(parseFreshnessPayload({ ...fresh, mirror: 'x' })).toStrictEqual(fresh);
  });

  it('names the field it refuses', () => {
    const cases: [Record<string, unknown>, string][] = [
      [{ feedSha256: 'cd'.repeat(31) }, 'feedSha256'],
      [{ seq: 1.5 }, 'seq'],
      [{ seq: -1 }, 'seq'],
      [{ issuedAt: '2026-11-01' }, 'issuedAt'],
      [{ expiresAt: null }, 'expiresAt'],
    ];
    for (const [patch, path] of cases) {
      expect(() => parseFreshnessPayload({ ...fresh, ...patch })).toThrow(new RegExp(`^FRESHNESS_FORMAT:${path}$`));
    }
    expect(() => parseFreshnessPayload('x')).toThrow(/^FRESHNESS_FORMAT:payload$/);
  });
});

describe('entryMatchesManifest (§9.6: the entry must equal the signed manifest)', () => {
  const MANIFEST: ReleaseManifest = {
    version: ENTRY.version,
    buildId: 'abc1234',
    bootProtocol: 1,
    releasedAt: ENTRY.releasedAt,
    schemaLatest: '9001',
    minCodeVersionAfter: ENTRY.minCodeVersionAfter,
    minUpgradeFrom: ENTRY.minUpgradeFrom,
    minNode: ENTRY.minNode,
    minDb: { ...ENTRY.minDb },
    files: [{ path: 'server.mjs', sha256: 'ef'.repeat(32), size: 10 }],
  };

  it('identical → null', () => {
    expect(entryMatchesManifest(ENTRY, MANIFEST)).toBeNull();
  });

  it('names the first field that differs', () => {
    expect(entryMatchesManifest({ ...ENTRY, releasedAt: '2026-11-02' }, MANIFEST)).toBe('releasedAt');
    expect(entryMatchesManifest({ ...ENTRY, minDb: { ...ENTRY.minDb, mysql: '8.4' } }, MANIFEST)).toBe('minDb');
    expect(entryMatchesManifest({ ...ENTRY, version: '0.2.1', releasedAt: '2026-11-02' }, MANIFEST)).toBe('version');
    expect(entryMatchesManifest({ ...ENTRY, bootProtocol: 2 }, MANIFEST)).toBe('bootProtocol');
    expect(entryMatchesManifest({ ...ENTRY, minUpgradeFrom: '0.1.0' }, MANIFEST)).toBe('minUpgradeFrom');
    expect(entryMatchesManifest({ ...ENTRY, minCodeVersionAfter: '0.2.0' }, MANIFEST)).toBe('minCodeVersionAfter');
    expect(entryMatchesManifest({ ...ENTRY, minNode: '24.0.0' }, MANIFEST)).toBe('minNode');
  });

  it('ignores what the manifest alone carries (buildId, schemaLatest, files) and what the entry alone carries (size, url)', () => {
    expect(entryMatchesManifest({ ...ENTRY, size: 1, url: 'https://elsewhere.example/x.zip' }, { ...MANIFEST, buildId: 'zzz', schemaLatest: '1' })).toBeNull();
  });
});
