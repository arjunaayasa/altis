import { Buffer } from 'node:buffer';
import { createPublicKey, generateKeyPairSync, verify, type KeyObject } from 'node:crypto';
import { describe, expect, it } from 'vitest';
import { TYP_USE, signDetached, useForTyp, verifyDetached, type Envelope } from '../src/envelope.js';
import { canonicalize } from '../src/jcs.js';
import { decodeBase64Url, encodeBase64Url, generateKeyPair, type KeyUse, type TrustedKey } from '../src/keys.js';

type TestKey = { privateKey: KeyObject; trusted: TrustedKey };

function makeKey(kid: string, use: KeyUse): TestKey {
  const { privateKey, pub } = generateKeyPair();
  return { privateKey, trusted: { kid, use, pub } };
}

const root = makeKey('dev-root-1', 'root');
const rel = makeKey('dev-rel-1', 'release');
const lic = makeKey('dev-lic-1', 'license');
const ts = makeKey('dev-ts-1', 'timestamp');
const dca = makeKey('dev-dca-1', 'device');
const KEYS = { root, release: rel, license: lic, timestamp: ts, device: dca } satisfies Record<KeyUse, TestKey>;
const TRUSTED = [root.trusted, rel.trusted, lic.trusted, ts.trusted, dca.trusted];

/** Some JSON document signed under a typ of the reserved `doc` use (any payload serves the envelope tests). */
const doc = {
  v: 1,
  id: 'DOC-1',
  note: 'reserved typ',
  items: [1, 2],
  nested: { a: 'x', b: null },
  issuedAt: '2026-11-01',
  flag: false,
};

const signDoc = (payload: unknown = doc, key: TestKey = lic, typ = 'altis-license/1'): Envelope =>
  signDetached(payload, { typ, kid: key.trusted.kid, privateKey: key.privateKey });

/** JSON text with every object's properties in reverse order and extra whitespace. */
function reversedJson(v: unknown): string {
  if (v === null || typeof v !== 'object') return JSON.stringify(v);
  if (Array.isArray(v)) return '[ ' + v.map(reversedJson).join(' , ') + ' ]';
  const entries = Object.keys(v)
    .reverse()
    .map((k) => JSON.stringify(k) + ' : ' + reversedJson((v as Record<string, unknown>)[k]));
  return '{\n  ' + entries.join(',\n  ') + '\n}';
}

/** XORs one byte of a buffer in place. */
function flip(bytes: Buffer, index: number, mask: number): void {
  bytes.writeUInt8(bytes.readUInt8(index) ^ mask, index);
}

/** `depth` arrays nested in each other: `[[...[]...]]` (depth 1 is `[]`). */
function nested(depth: number): unknown {
  let value: unknown = [];
  for (let i = 1; i < depth; i++) value = [value];
  return value;
}

/** Runs `fn` and returns the thrown error (fails the test if nothing is thrown). */
function thrown(fn: () => unknown): Error {
  try {
    fn();
  } catch (err) {
    expect(err).toBeInstanceOf(Error);
    return err as Error;
  }
  throw new Error('expected an error');
}

describe('TYP_USE', () => {
  it('maps every typ to its key use', () => {
    expect(TYP_USE).toEqual({
      'altis-license/1': 'license',
      'altis-deactivation/1': 'license',
      'altis-heartbeat/1': 'license',
      'altis-clock/1': 'license',
      'altis-feed/1': 'release',
      'altis-release/1': 'release',
      'altis-keyset/1': 'root',
      'altis-timestamp/1': 'timestamp',
      'altis-device-cert/1': 'device',
      'altis-device-revocations/1': 'device',
    });
  });

  it('keeps room for the reserved device revocation lists (D1d-35)', () => {
    expect(TYP_USE['altis-device-revocations/1']).toBe('device');
  });

  it('is frozen', () => {
    expect(Object.isFrozen(TYP_USE)).toBe(true);
  });

  it('has no prototype, so inherited names are not typs', () => {
    expect(Object.getPrototypeOf(TYP_USE)).toBeNull();
    for (const name of ['constructor', '__proto__', 'toString', 'hasOwnProperty', 'valueOf']) {
      expect(TYP_USE[name]).toBeUndefined();
      expect(name in TYP_USE).toBe(false);
    }
  });
});

describe('useForTyp', () => {
  it('returns the key use of each known typ', () => {
    for (const [typ, use] of Object.entries(TYP_USE)) expect(useForTyp(typ)).toBe(use);
    expect(useForTyp('altis-release/1')).toBe('release');
    expect(useForTyp('altis-keyset/1')).toBe('root');
  });

  it('returns undefined for unknown typs and inherited names', () => {
    for (const name of ['', 'altis-release/2', 'constructor', '__proto__', 'toString', 'hasOwnProperty']) {
      expect(useForTyp(name)).toBeUndefined();
    }
    expect(useForTyp(undefined as unknown as string)).toBeUndefined();
    expect(useForTyp(7 as unknown as string)).toBeUndefined();
  });
});

describe('signDetached', () => {
  it('returns {typ, kid, alg, sig} with a 64-byte base64url signature', () => {
    const env = signDoc();
    expect(Object.keys(env).sort()).toEqual(['alg', 'kid', 'sig', 'typ']);
    expect(env).toMatchObject({ typ: 'altis-license/1', kid: 'dev-lic-1', alg: 'Ed25519' });
    expect(env.sig).toMatch(/^[A-Za-z0-9_-]{86}$/);
    expect(decodeBase64Url(env.sig)).toHaveLength(64);
  });

  it('signs the UTF-8 bytes of canonicalize({typ, kid, alg, payload})', () => {
    const env = signDoc();
    const input = canonicalize({ typ: env.typ, kid: env.kid, alg: 'Ed25519', payload: doc });
    const sig = decodeBase64Url(env.sig) as Buffer;
    const pub = createPublicKey(lic.privateKey);
    expect(verify(null, Buffer.from(input, 'utf8'), pub, sig)).toBe(true);
    expect(verify(null, Buffer.from(canonicalize(doc), 'utf8'), pub, sig)).toBe(false);
  });

  it('is deterministic and independent of property order', () => {
    const reordered = JSON.parse(canonicalize(doc)) as unknown;
    expect(signDoc(reordered).sig).toBe(signDoc().sig);
  });

  it('refuses a key that is not an Ed25519 private key', () => {
    const o = { typ: 'altis-license/1', kid: 'k' };
    expect(() => signDetached(1, { ...o, privateKey: createPublicKey(lic.privateKey) })).toThrow(TypeError);
    expect(() => signDetached(1, { ...o, privateKey: generateKeyPairSync('x25519').privateKey })).toThrow(TypeError);
    expect(() => signDetached(1, { ...o, privateKey: 'pem' as unknown as KeyObject })).toThrow(TypeError);
  });

  it('refuses an empty typ or kid', () => {
    expect(() => signDetached(1, { typ: '', kid: 'k', privateKey: lic.privateKey })).toThrow(TypeError);
    expect(() => signDetached(1, { typ: 'altis-license/1', kid: '', privateKey: lic.privateKey })).toThrow(TypeError);
  });

  it('refuses a payload outside the JSON data model', () => {
    expect(() => signDoc({ n: NaN })).toThrow(/^JCS_INVALID:non_finite/);
    expect(() => signDoc({ s: '\ud800' })).toThrow(/^JCS_INVALID:lone_surrogate/);
  });

  it('refuses an undefined payload with SIGN_INVALID_PAYLOAD', () => {
    // signDoc() would substitute its default payload for undefined.
    const err = thrown(() => signDetached(undefined, { typ: 'altis-license/1', kid: 'dev-lic-1', privateKey: lic.privateKey }));
    expect(err).not.toBeInstanceOf(TypeError);
    expect(err.message).toBe('SIGN_INVALID_PAYLOAD');
  });

  it('refuses a payload that verifyDetached could never parse (nesting deeper than 64)', () => {
    expect(thrown(() => signDoc(nested(65))).message).toBe('SIGN_INVALID_PAYLOAD');
    expect(thrown(() => signDoc({ a: nested(64) })).message).toBe('SIGN_INVALID_PAYLOAD');
    expect(thrown(() => signDoc(nested(100_000))).message).toBe('SIGN_INVALID_PAYLOAD');
  });

  it('keeps the cause of a refused payload', () => {
    expect(thrown(() => signDoc(nested(65))).cause).toMatchObject({ message: 'JSON_TOO_DEEP' });
  });

  it('signs nesting of exactly 64, and the result verifies', () => {
    const deep = nested(64);
    const env = signDoc(deep);
    expect(verifyDetached(JSON.stringify(deep), env, TRUSTED, 'altis-license/1')).toEqual(deep);
  });

  it('signs scalars, arrays and an object with undefined members', () => {
    for (const payload of [null, 0, false, '', [], { a: undefined }]) {
      const env = signDoc(payload);
      expect(verifyDetached(JSON.stringify(payload), env, TRUSTED, 'altis-license/1')).toEqual(
        JSON.parse(JSON.stringify(payload)),
      );
    }
  });
});

describe('verifyDetached: success', () => {
  it('sign then verify returns the payload', () => {
    const env = signDoc();
    expect(verifyDetached(JSON.stringify(doc), env, TRUSTED, 'altis-license/1')).toStrictEqual(doc);
  });

  it('accepts semantically equal JSON with other whitespace, escapes and property order', () => {
    const env = signDoc();
    const pretty = JSON.stringify(doc, null, 2) + '\n';
    expect(verifyDetached(pretty, env, TRUSTED, 'altis-license/1')).toStrictEqual(doc);
    const reordered = reversedJson(doc).replace('"DOC-1"', '"DOC\\u002d1"').replace('"v" : 1\n', '"v" : 1.0e0\n');
    expect(reordered).toContain('DOC\\u002d1');
    expect(reordered).toContain('1.0e0');
    expect(verifyDetached(reordered, env, TRUSTED, 'altis-license/1')).toStrictEqual(doc);
  });

  it.each([
    ['null', null],
    ['a number', 1.5],
    ['a string', 'é€😀'],
    ['an array', [1, 'two', { three: [3] }]],
  ])('round-trips %s as payload', (_name, payload) => {
    const env = signDoc(payload);
    expect(verifyDetached(JSON.stringify(payload), env, TRUSTED, 'altis-license/1')).toEqual(payload);
  });

  it('a payload signed as -0 verifies as 0 (JSON has no negative zero; both canonicalize to "0")', () => {
    const env = signDoc({ n: -0 });
    expect(verifyDetached('{"n":-0}', env, TRUSTED, 'altis-license/1')).toEqual({ n: -0 });
    expect(verifyDetached(JSON.stringify({ n: -0 }), env, TRUSTED, 'altis-license/1')).toEqual({ n: 0 });
  });

  it.each(Object.entries(TYP_USE))('verifies %s signed by a %s key', (typ, use) => {
    const env = signDoc({ typ }, KEYS[use], typ);
    expect(verifyDetached(JSON.stringify({ typ }), env, TRUSTED, typ)).toEqual({ typ });
  });

  it('accepts an envelope that went through JSON', () => {
    const env = JSON.parse(JSON.stringify(signDoc())) as Envelope;
    expect(verifyDetached(JSON.stringify(doc), env, TRUSTED, 'altis-license/1')).toStrictEqual(doc);
  });

  it('accepts a trusted list that repeats an identical key', () => {
    const env = signDoc();
    expect(verifyDetached(JSON.stringify(doc), env, [lic.trusted, { ...lic.trusted }], 'altis-license/1')).toEqual(doc);
  });
});

describe('verifyDetached: failures', () => {
  const raw = JSON.stringify(doc);
  const env = signDoc();
  const check = (r: string, e: unknown, trusted: TrustedKey[] = TRUSTED, typ = 'altis-license/1'): Error =>
    thrown(() => verifyDetached(r, e as Envelope, trusted, typ));

  it('a flipped payload byte -> SIG_INVALID:signature', () => {
    const bytes = Buffer.from(raw, 'utf8');
    flip(bytes, raw.indexOf('DOC-1') + 4, 0x01); // "DOC-1" -> "DOC-0", still valid JSON
    expect(check(bytes.toString('utf8'), env).message).toBe('SIG_INVALID:signature');
  });

  it('a payload that differs only in value -> SIG_INVALID:signature', () => {
    expect(raw).toContain('"flag":false');
    expect(check(raw.replace('"flag":false', '"flag":true'), env).message).toBe('SIG_INVALID:signature');
    expect(raw).toContain('"items":[1,2]');
    expect(check(raw.replace('"items":[1,2]', '"items":[1,2.5]'), env).message).toBe('SIG_INVALID:signature');
  });

  it('a flipped signature byte -> SIG_INVALID:signature', () => {
    const sig = decodeBase64Url(env.sig) as Buffer;
    flip(sig, 10, 0x80);
    expect(check(raw, { ...env, sig: encodeBase64Url(sig) }).message).toBe('SIG_INVALID:signature');
  });

  it('a malformed signature -> SIG_INVALID:signature', () => {
    for (const sig of ['', env.sig + '==', env.sig.slice(0, 85), env.sig + 'AA', '+' + env.sig.slice(1), 'x'.repeat(86)]) {
      expect(check(raw, { ...env, sig }).message, sig).toBe('SIG_INVALID:signature');
    }
  });

  it('typ altis-release/1 signed by a license-use key -> SIG_INVALID:use', () => {
    const e = signDoc(doc, lic, 'altis-release/1');
    expect(check(raw, e, TRUSTED, 'altis-release/1').message).toBe('SIG_INVALID:use');
  });

  it('every typ signed by a key of another use -> SIG_INVALID:use', () => {
    for (const [typ, use] of Object.entries(TYP_USE)) {
      for (const other of Object.values(KEYS)) {
        if (other.trusted.use === use) continue;
        const e = signDoc({ typ }, other, typ);
        expect(check(JSON.stringify({ typ }), e, TRUSTED, typ).message).toBe('SIG_INVALID:use');
      }
    }
  });

  it('an unknown kid -> SIG_INVALID:kid', () => {
    const stranger = makeKey('dev-lic-9', 'license');
    expect(check(raw, signDoc(doc, stranger)).message).toBe('SIG_INVALID:kid');
    expect(check(raw, env, [rel.trusted]).message).toBe('SIG_INVALID:kid');
    expect(check(raw, env, []).message).toBe('SIG_INVALID:kid');
  });

  it('a kid trusted twice with different keys -> SIG_INVALID:kid', () => {
    const other = makeKey('dev-lic-1', 'license');
    expect(check(raw, env, [lic.trusted, other.trusted]).message).toBe('SIG_INVALID:kid');
    expect(check(raw, env, [lic.trusted, { ...lic.trusted, use: 'release' }]).message).toBe('SIG_INVALID:kid');
  });

  it('an envelope kid swapped to another trusted key of the same use -> SIG_INVALID:signature', () => {
    const lic2 = makeKey('dev-lic-2', 'license');
    expect(check(raw, { ...env, kid: 'dev-lic-2' }, [...TRUSTED, lic2.trusted]).message).toBe('SIG_INVALID:signature');
  });

  it('expectTyp mismatch -> SIG_INVALID:typ', () => {
    expect(check(raw, env, TRUSTED, 'altis-heartbeat/1').message).toBe('SIG_INVALID:typ');
  });

  it('an envelope typ changed after signing -> SIG_INVALID:signature', () => {
    expect(check(raw, { ...env, typ: 'altis-heartbeat/1' }, TRUSTED, 'altis-heartbeat/1').message).toBe(
      'SIG_INVALID:signature',
    );
  });

  it('a typ without a key use -> SIG_INVALID:typ', () => {
    for (const typ of ['altis-unknown/1', 'altis-device-snapshot/1', '__proto__', 'toString', 'constructor']) {
      const e = signDoc(doc, lic, typ);
      expect(check(raw, e, TRUSTED, typ).message, typ).toBe('SIG_INVALID:typ');
    }
  });

  it('alg other than Ed25519 -> SIG_INVALID:alg', () => {
    for (const alg of ['none', 'ed25519', 'EdDSA', '']) {
      expect(check(raw, { ...env, alg }).message, alg).toBe('SIG_INVALID:alg');
    }
  });

  it('a malformed envelope -> SIG_INVALID:envelope', () => {
    const noSig: Partial<Envelope> = { ...env };
    delete noSig.sig;
    for (const bad of [
      null,
      undefined,
      'env',
      [env.typ, env.kid, env.alg, env.sig],
      noSig,
      { ...env, sig: 1 },
      { ...env, kid: null },
      { ...env, typ: ['altis-license/1'] },
      { ...env, extra: 'unsigned' },
    ]) {
      expect(check(raw, bad).message).toBe('SIG_INVALID:envelope');
    }
  });

  it('a malformed trusted pub -> SIG_INVALID:key', () => {
    for (const pub of ['', lic.trusted.pub.slice(1), lic.trusted.pub + '=', encodeBase64Url(Buffer.alloc(31))]) {
      expect(check(raw, env, [{ ...lic.trusted, pub }]).message, pub).toBe('SIG_INVALID:key');
    }
  });

  it('an unknown use on the trusted key -> SIG_INVALID:key', () => {
    expect(check(raw, env, [{ ...lic.trusted, use: 'admin' as KeyUse }]).message).toBe('SIG_INVALID:key');
  });

  it('a duplicate key in the raw payload is rejected before verification -> SIG_INVALID:payload', () => {
    // JSON.parse would keep the last "a" and the signature would verify; the strict parser refuses first.
    const e = signDoc({ a: 1 });
    expect(verifyDetached('{"a":1}', e, TRUSTED, 'altis-license/1')).toEqual({ a: 1 });
    const err = check('{"a":2,"a":1}', e);
    expect(err.message).toBe('SIG_INVALID:payload');
    expect((err.cause as Error).message).toBe('DUPLICATE_KEY:a');
  });

  it('trailing garbage, bad syntax or excessive depth in the raw payload -> SIG_INVALID:payload', () => {
    const e = signDoc({ a: 1 });
    expect(check('{"a":1}x', e).message).toBe('SIG_INVALID:payload');
    expect(check('{"a":1', e).message).toBe('SIG_INVALID:payload');
    expect(check('', e).message).toBe('SIG_INVALID:payload');
    expect((check('['.repeat(65) + ']'.repeat(65), e).cause as Error).message).toBe('JSON_TOO_DEEP');
  });

  it('an escaped lone surrogate in the raw payload -> SIG_INVALID:payload', () => {
    const err = check('{"s":"\\ud800"}', signDoc({ s: 'x' }));
    expect(err.message).toBe('SIG_INVALID:payload');
    expect((err.cause as Error).message).toMatch(/^JCS_INVALID:lone_surrogate/);
  });

  it('a raw payload that is not a string -> SIG_INVALID:payload', () => {
    expect(check(Buffer.from(raw) as unknown as string, env).message).toBe('SIG_INVALID:payload');
  });

  it('throws plain Errors with the SIG_INVALID prefix only', () => {
    const err = check(raw, env, []);
    expect(err.constructor).toBe(Error);
  });
});
