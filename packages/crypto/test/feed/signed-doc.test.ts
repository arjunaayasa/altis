import { describe, expect, it } from 'vitest';
import { canonicalize } from '../../src/jcs.js';
import { FRESHNESS_TYP, SIGNED_DOC_MAX_BYTES, parseSignedDocFile } from '../../src/feed/index.js';

// D1d-3: a signed document file (freshness.json) is exactly {raw, env}, strict JSON, at most 64 KiB of UTF-8.

describe('parseSignedDocFile (D1d-3: freshness.json)', () => {
  const raw = canonicalize({ feedSha256: 'ab'.repeat(32), seq: 1, issuedAt: 1, expiresAt: 2 });
  const env = { typ: FRESHNESS_TYP, kid: 'dev-ts-1', alg: 'Ed25519', sig: 'A'.repeat(86) };

  it('reads {raw, env}', () => {
    expect(parseSignedDocFile(JSON.stringify({ raw, env }, null, 2))).toStrictEqual({ raw, env });
  });

  it('refuses a duplicate key (strict JSON) → SIGNED_DOC_FORMAT:json', () => {
    const text = `{"raw": ${JSON.stringify(raw)}, "raw": "{}", "env": ${JSON.stringify(env)}}`;
    expect(() => parseSignedDocFile(text)).toThrow(/^SIGNED_DOC_FORMAT:json$/);
    const inEnv = `{"raw": ${JSON.stringify(raw)}, "env": {"typ": "a", "typ": "b", "kid": "k", "alg": "Ed25519", "sig": "s"}}`;
    expect(() => parseSignedDocFile(inEnv)).toThrow(/^SIGNED_DOC_FORMAT:json$/);
    expect(() => parseSignedDocFile('{"raw": "x", "env": {}} trailing')).toThrow(/^SIGNED_DOC_FORMAT:json$/);
  });

  it('refuses anything but exactly {raw, env} → SIGNED_DOC_FORMAT:shape', () => {
    for (const doc of [
      [raw, env],
      { raw },
      { raw, env, extra: 1 },
      { raw: 1, env },
      { raw, env: { ...env, extra: 'x' } },
      { raw, env: { ...env, sig: 1 } },
      { raw, env: { ...env, alg: 'RS256' } },
    ]) {
      expect(() => parseSignedDocFile(JSON.stringify(doc)), JSON.stringify(doc)).toThrow(/^SIGNED_DOC_FORMAT:shape$/);
    }
  });

  it(`refuses a file over ${SIGNED_DOC_MAX_BYTES} bytes → SIGNED_DOC_FORMAT:size`, () => {
    expect(SIGNED_DOC_MAX_BYTES).toBe(64 * 1024);
    const fill = (n: number): string => JSON.stringify({ raw: 'x'.repeat(n), env });
    const base = fill(0).length;
    expect(parseSignedDocFile(fill(SIGNED_DOC_MAX_BYTES - base)).raw).toHaveLength(SIGNED_DOC_MAX_BYTES - base);
    expect(() => parseSignedDocFile(fill(SIGNED_DOC_MAX_BYTES - base + 1))).toThrow(/^SIGNED_DOC_FORMAT:size$/);
    // Counted in UTF-8 bytes: 'é' is two.
    const half = Math.ceil((SIGNED_DOC_MAX_BYTES - base + 2) / 2);
    expect(() => parseSignedDocFile(JSON.stringify({ raw: 'é'.repeat(half), env }))).toThrow(/^SIGNED_DOC_FORMAT:size$/);
  });
});

describe('the feed subpath exports exactly interface I-3', () => {
  it('names every runtime export', async () => {
    const feed = await import('../../src/feed/index.js');
    expect(Object.keys(feed).sort()).toEqual(
      [
        'FEED_TYP',
        'FRESHNESS_MAX_MS',
        'FRESHNESS_TYP',
        'SIGNED_DOC_MAX_BYTES',
        'entryMatchesManifest',
        'floorHolds',
        'isCalendarDate',
        'jakartaDate',
        'parseFeedPayload',
        'parseFreshnessPayload',
        'parseSignedDocFile',
        'verifyFeed',
      ].sort(),
    );
  });
});
