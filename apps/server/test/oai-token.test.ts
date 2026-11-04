import { createHmac, hkdfSync, randomBytes } from 'node:crypto';
import type { KeyringEntry } from '@altis/core';
import { newId } from '@altis/shared';
import { describe, expect, it } from 'vitest';
import { OAI_TOKEN_MAX_LENGTH, OAI_TOKEN_TTL_MS, oaiTokenKeys, signToken, verifyToken, type OaiTokenPayload } from '../src/opac/catalog/oai/token.js';

// The stateless OAI-PMH resumption token (Phase 2 Task 35; spec §10, D2-24, M15): base64url(JSON) + `.` +
// base64url(HMAC-SHA256), keyed with HKDF-SHA256 of a keyring entry (info `altis oai-token v1`), valid 24 hours.
// - oaiTokenKeys derives one key per keyring entry, the active entry's first;
// - signToken always signs with the key it is given (the caller passes keys[0], the active one);
// - verifyToken accepts a token whose MAC verifies under any of the keys (a key rotation does not break a live
//   harvest), and refuses (null) a token with any character changed, an expired one, and one of a bad shape.

const NOW = Date.UTC(2026, 9, 30, 9, 15, 5);
const HOUR = 3_600_000;

const entry = (active: boolean): KeyringEntry => ({ kid: `k${randomBytes(4).toString('hex')}`, key: randomBytes(32).toString('base64url'), active });

/** The derivation the spec names: HKDF-SHA256 over the raw key, no salt, info `altis oai-token v1`, 32 bytes. */
const derived = (e: KeyringEntry): Buffer => Buffer.from(hkdfSync('sha256', Buffer.from(e.key, 'base64url'), new Uint8Array(0), 'altis oai-token v1', 32));

function payload(over: Partial<OaiTokenPayload> = {}): OaiTokenPayload {
  return {
    v: 1,
    verb: 'ListRecords',
    prefix: 'oai_dc',
    set: 'material:buku',
    from: Date.UTC(2026, 0, 1),
    until: null,
    after: newId(NOW - HOUR),
    size: 2500,
    exp: NOW + OAI_TOKEN_TTL_MS,
    ...over,
  };
}

/** `token` with the character at `i` replaced by another one of the base64url alphabet (or the dot by one). */
function changedAt(token: string, i: number): string {
  const c = token[i]!;
  const other = c === 'A' ? 'B' : c === '.' ? 'A' : 'A';
  return token.slice(0, i) + other + token.slice(i + 1);
}

describe('oaiTokenKeys (M15)', () => {
  it('derives one 32-byte key per keyring entry with HKDF-SHA256 (info `altis oai-token v1`), the active entry first', () => {
    const a = entry(false);
    const b = entry(true);
    const c = entry(false);
    const keys = oaiTokenKeys([a, b, c]);
    expect(keys.map((k) => k.toString('hex'))).toEqual([b, a, c].map((e) => derived(e).toString('hex')));
    for (const k of keys) expect(k.length).toBe(32);
    // A derived key, never the keyring's key itself (the purpose `oai-token` is separated from the sealed secrets).
    expect(keys[0]!.equals(Buffer.from(b.key, 'base64url'))).toBe(false);
  });

  it('refuses a keyring without exactly one active entry, or with a key that is not 32 bytes', () => {
    expect(() => oaiTokenKeys([entry(false)])).toThrow(TypeError);
    expect(() => oaiTokenKeys([entry(true), entry(true)])).toThrow(TypeError);
    expect(() => oaiTokenKeys([{ kid: 'x', key: 'c2hvcnQ', active: true }])).toThrow(TypeError);
  });
});

describe('signToken / verifyToken', () => {
  const keys = oaiTokenKeys([entry(true)]);

  it('round-trips the payload: base64url JSON, a dot, base64url HMAC-SHA256', () => {
    const p = payload();
    const token = signToken(p, keys[0]!);
    expect(token).toMatch(/^[A-Za-z0-9_-]+\.[A-Za-z0-9_-]{43}$/);
    expect(token.length).toBeLessThanOrEqual(OAI_TOKEN_MAX_LENGTH);
    const [body] = token.split('.');
    expect(JSON.parse(Buffer.from(body!, 'base64url').toString('utf8'))).toEqual(p);
    expect(verifyToken(token, keys, NOW)).toEqual(p);
    // Every field round-trips, a null set and both bounds included.
    const q = payload({ verb: 'ListIdentifiers', prefix: 'marc21', set: null, from: null, until: Date.UTC(2026, 9, 31), size: 0 });
    expect(verifyToken(signToken(q, keys[0]!), keys, NOW)).toEqual(q);
    // Bounds before 1970 are negative epoch ms (a harvester asking from=0001-01-01).
    const old = payload({ from: -62_135_596_800_000 /* 0001-01-01T00:00:00Z */, until: Date.UTC(1969, 11, 31) });
    expect(old.from).toBeLessThan(0);
    expect(verifyToken(signToken(old, keys[0]!), keys, NOW)).toEqual(old);
  });

  it('a token with any one character changed is refused (badResumptionToken), the MAC compared as written', () => {
    const token = signToken(payload(), keys[0]!);
    for (let i = 0; i < token.length; i++) expect(verifyToken(changedAt(token, i), keys, NOW), `position ${i}`).toBeNull();
    // The last MAC character carries 2 unused bits: a decoder that ignored them would accept this one.
    const last = token.at(-1)!;
    const alphabet = 'ABCDEFGHIJKLMNOPQRSTUVWXYZabcdefghijklmnopqrstuvwxyz0123456789-_';
    const sibling = alphabet[alphabet.indexOf(last) ^ 1]!;
    const mac = token.split('.')[1]!;
    expect(Buffer.from(mac.slice(0, -1) + sibling, 'base64url').equals(Buffer.from(mac, 'base64url'))).toBe(true);
    expect(verifyToken(token.slice(0, -1) + sibling, keys, NOW)).toBeNull();
    expect(verifyToken(`${token}A`, keys, NOW)).toBeNull();
    expect(verifyToken(token.slice(0, -1), keys, NOW)).toBeNull();
  });

  it('expires after 24 hours: accepted at +23 h, refused at +25 h (a fake clock) and exactly at exp', () => {
    const token = signToken(payload(), keys[0]!);
    expect(verifyToken(token, keys, NOW + 23 * HOUR)).not.toBeNull();
    expect(verifyToken(token, keys, NOW + 25 * HOUR)).toBeNull();
    expect(verifyToken(token, keys, NOW + OAI_TOKEN_TTL_MS)).toBeNull();
  });

  it('refuses a token of a bad shape even when its MAC verifies', () => {
    const forged = (value: unknown): string => signToken(value as OaiTokenPayload, keys[0]!);
    const bad: unknown[] = [
      { ...payload(), v: 2 },
      { ...payload(), extra: 1 },
      { ...payload(), verb: 'GetRecord' },
      { ...payload(), prefix: 'mods' },
      { ...payload(), after: 'not-a-ulid' },
      { ...payload(), size: -1 },
      { ...payload(), size: 1.5 },
      { ...payload(), from: '2026-01-01' },
      { ...payload(), set: 'material:' },
      { ...payload(), set: 'material:a b' },
      { ...payload(), exp: 'tomorrow' },
      Object.fromEntries(Object.entries(payload()).filter(([k]) => k !== 'size')),
      [1, 2, 3],
      null,
      'ListRecords',
    ];
    for (const value of bad) expect(verifyToken(forged(value), keys, NOW), JSON.stringify(value)).toBeNull();
  });

  it('refuses what is not a token at all: empty, garbage, no dot, two dots, too long, not UTF-8 JSON', () => {
    const token = signToken(payload(), keys[0]!);
    for (const value of ['', '.', 'abc', token.replace('.', ''), `${token}.x`, 'x'.repeat(OAI_TOKEN_MAX_LENGTH + 1), `${token} `]) {
      expect(verifyToken(value, keys, NOW), value.slice(0, 40)).toBeNull();
    }
    // A valid MAC (over the base64url body as written) of bytes that are not UTF-8 JSON.
    const macOf = (body: string): string => `${body}.${createHmac('sha256', keys[0]!).update(body).digest('base64url')}`;
    const p = payload();
    expect(verifyToken(macOf(Buffer.from(JSON.stringify(p)).toString('base64url')), keys, NOW)).toEqual(p);
    for (const bytes of [Buffer.from('not json'), Buffer.from([0xff, 0xfe, 0x7b, 0x7d]), Buffer.from('{"v":1,"v":1}')]) {
      expect(verifyToken(macOf(bytes.toString('base64url')), keys, NOW)).toBeNull();
    }
    expect(verifyToken(token, [], NOW)).toBeNull();
  });

  it('M15: a token signed before a keyring rotation is still accepted; new tokens are signed with the new active key', () => {
    const old = entry(true);
    const before = oaiTokenKeys([old]);
    const p = payload();
    const token = signToken(p, before[0]!);

    // The rotation: a new active entry, the old one kept (no longer active).
    const fresh = entry(true);
    const after = oaiTokenKeys([{ ...old, active: false }, fresh]);
    expect(after[0]!.equals(derived(fresh))).toBe(true);
    expect(verifyToken(token, after, NOW)).toEqual(p);

    // What is signed now verifies under the new key alone, not under the old one.
    const next = signToken(payload(), after[0]!);
    expect(verifyToken(next, oaiTokenKeys([fresh]), NOW)).not.toBeNull();
    expect(verifyToken(next, before, NOW)).toBeNull();

    // Once the old entry leaves the keyring, its tokens are refused.
    expect(verifyToken(token, oaiTokenKeys([fresh]), NOW)).toBeNull();
  });

  it('a MAC made with the raw keyring key (not the derived one) is refused', () => {
    const e = entry(true);
    const raw = Buffer.from(e.key, 'base64url');
    expect(verifyToken(signToken(payload(), raw), oaiTokenKeys([e]), NOW)).toBeNull();
  });
});
