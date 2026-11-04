import { Buffer } from 'node:buffer';
import { KeyObject, createPublicKey, generateKeyPairSync, sign, verify } from 'node:crypto';
import { describe, expect, it } from 'vitest';
import {
  KEY_USES,
  decodeBase64Url,
  encodeBase64Url,
  generateKeyPair,
  importPublicKey,
  isTrustedKey,
  rawPublicKey,
} from '../src/keys.js';

describe('base64url', () => {
  it('encodes without padding', () => {
    expect(encodeBase64Url(Buffer.from(''))).toBe('');
    expect(encodeBase64Url(Buffer.from('f'))).toBe('Zg');
    expect(encodeBase64Url(Buffer.from('fo'))).toBe('Zm8');
    expect(encodeBase64Url(Buffer.from('foo'))).toBe('Zm9v');
    expect(encodeBase64Url(Uint8Array.from([0xfb, 0xff, 0xbf]))).toBe('-_-_');
  });

  it('round-trips random bytes', () => {
    for (let n = 0; n < 70; n++) {
      const bytes = Buffer.alloc(n, 0).map((_, i) => (i * 37 + n) & 0xff);
      expect(decodeBase64Url(encodeBase64Url(bytes))).toEqual(Buffer.from(bytes));
    }
  });

  it('decodes strictly', () => {
    expect(decodeBase64Url('Zm9v')).toEqual(Buffer.from('foo'));
    expect(decodeBase64Url('-_-_')).toEqual(Buffer.from([0xfb, 0xff, 0xbf]));
    for (const bad of ['Zg==', 'Zg=', 'Zm9v+', '+/+/', 'Zm 9v', 'Zm9v\n', 'Z', 'Zm9vZ', 'Zh', 'Zm9', 'é', '%%']) {
      expect(decodeBase64Url(bad), bad).toBeNull();
    }
    // 'Zh' and 'Zm9' have non-zero unused bits: they would decode, but are not canonical.
  });

  it('rejects non-strings', () => {
    expect(decodeBase64Url(undefined as unknown as string)).toBeNull();
    expect(decodeBase64Url(42 as unknown as string)).toBeNull();
  });
});

describe('generateKeyPair', () => {
  it('returns an Ed25519 private key and its raw public key in base64url', () => {
    const { privateKey, pub } = generateKeyPair();
    expect(privateKey).toBeInstanceOf(KeyObject);
    expect(privateKey.type).toBe('private');
    expect(privateKey.asymmetricKeyType).toBe('ed25519');
    expect(pub).toMatch(/^[A-Za-z0-9_-]{43}$/);
    expect(decodeBase64Url(pub)).toHaveLength(32);
    const jwk = createPublicKey(privateKey).export({ format: 'jwk' });
    expect(pub).toBe(jwk.x);
  });

  it('produces a pub that verifies signatures of the private key', () => {
    const { privateKey, pub } = generateKeyPair();
    const data = Buffer.from('hello');
    expect(verify(null, data, importPublicKey(pub), sign(null, data, privateKey))).toBe(true);
  });

  it('generates a new pair each time', () => {
    expect(generateKeyPair().pub).not.toBe(generateKeyPair().pub);
  });
});

describe('rawPublicKey / importPublicKey', () => {
  it('derives the raw public key from a private or a public key object', () => {
    const { privateKey, pub } = generateKeyPair();
    expect(rawPublicKey(privateKey)).toBe(pub);
    expect(rawPublicKey(createPublicKey(privateKey))).toBe(pub);
  });

  it('round-trips through importPublicKey', () => {
    const { pub } = generateKeyPair();
    const key = importPublicKey(pub);
    expect(key.type).toBe('public');
    expect(key.asymmetricKeyType).toBe('ed25519');
    expect(rawPublicKey(key)).toBe(pub);
  });

  it('refuses keys that are not Ed25519', () => {
    expect(() => rawPublicKey(generateKeyPairSync('x25519').privateKey)).toThrow(TypeError);
    expect(() => rawPublicKey(generateKeyPairSync('ed448').publicKey)).toThrow(TypeError);
  });

  it('refuses a pub that is not 32 bytes of canonical base64url', () => {
    const { pub } = generateKeyPair();
    for (const bad of ['', pub.slice(1), pub + 'A', pub + '=', '+' + pub.slice(1), encodeBase64Url(Buffer.alloc(33))]) {
      expect(() => importPublicKey(bad), bad).toThrow(TypeError);
    }
  });
});

describe('isTrustedKey', () => {
  const { pub } = generateKeyPair();

  it('accepts {kid, use, pub} for every use', () => {
    expect(KEY_USES).toEqual(['root', 'license', 'release', 'timestamp', 'device']);
    for (const use of KEY_USES) expect(isTrustedKey({ kid: 'k', use, pub })).toBe(true);
  });

  it.each([
    ['null', null],
    ['an array', [pub]],
    ['an empty kid', { kid: '', use: 'release', pub }],
    ['a numeric kid', { kid: 1, use: 'release', pub }],
    ['an unknown use', { kid: 'k', use: 'admin', pub }],
    ['an inherited use name', { kid: 'k', use: 'toString', pub }],
    ['a short pub', { kid: 'k', use: 'release', pub: pub.slice(2) }],
    ['a padded pub', { kid: 'k', use: 'release', pub: pub + '=' }],
    ['a missing pub', { kid: 'k', use: 'release' }],
    ['an extra field', { kid: 'k', use: 'release', pub, note: 'x' }],
  ])('rejects %s', (_name, value) => {
    expect(isTrustedKey(value)).toBe(false);
  });
});
