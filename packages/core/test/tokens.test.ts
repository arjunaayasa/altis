import { decodeBase64Url } from '@altis/crypto';
import { describe, expect, it } from 'vitest';
import { hmacB64u, randomToken, safeEqual, sha256hex } from '../src/crypto/tokens.js';

const hexOf = (b64u: string): string => {
  const bytes = decodeBase64Url(b64u);
  if (bytes === null) return expect.fail(`${b64u} is not canonical unpadded base64url`);
  return bytes.toString('hex');
};

describe('randomToken', () => {
  it('is 32 random bytes as 43 characters of unpadded base64url by default', () => {
    const tokens = new Set<string>();
    for (let i = 0; i < 100; i += 1) {
      const token = randomToken();
      expect(token).toMatch(/^[A-Za-z0-9_-]{43}$/);
      expect(decodeBase64Url(token)).toHaveLength(32);
      tokens.add(token);
    }
    expect(tokens.size).toBe(100);
  });

  it('takes the number of bytes', () => {
    expect(decodeBase64Url(randomToken(16))).toHaveLength(16);
    expect(randomToken(16)).toMatch(/^[A-Za-z0-9_-]{22}$/);
    for (const bytes of [0, -1, 1.5, Number.NaN]) expect(() => randomToken(bytes), String(bytes)).toThrow(RangeError);
  });
});

describe('sha256hex', () => {
  it('is the hex SHA-256 of the UTF-8 text (FIPS 180-2 "abc")', () => {
    expect(sha256hex('abc')).toBe('ba7816bf8f01cfea414140de5dae2223b00361a396177a9cb410ff61f20015ad');
    expect(sha256hex('')).toBe('e3b0c44298fc1c149afbf4c8996fb92427ae41e4649b934ca495991b7852b855');
    expect(sha256hex('é')).toBe(sha256hex('é'));
    expect(sha256hex('é')).not.toBe(sha256hex('é'));
  });
});

describe('hmacB64u', () => {
  const MSG = 'what do ya want for nothing?';
  const CASE_2 = '5bdcc146bf60754e6a042426089575c75a003f089d2739839dec58b964ec3843';

  it('is HMAC-SHA256 as unpadded base64url, a string key being UTF-8 text (RFC 4231 case 2)', () => {
    expect(hexOf(hmacB64u('Jefe', MSG))).toBe(CASE_2);
    expect(hmacB64u('Jefe', MSG)).toMatch(/^[A-Za-z0-9_-]{43}$/);
  });

  it('takes the key as bytes', () => {
    expect(hexOf(hmacB64u(new TextEncoder().encode('Jefe'), MSG))).toBe(CASE_2);
    // RFC 4231 case 1: twenty 0x0b bytes, "Hi There"
    expect(hexOf(hmacB64u(new Uint8Array(20).fill(0x0b), 'Hi There'))).toBe(
      'b0344c61d8db38535ca8afceaf0bf12b881dc200c9833da726e9376c2e32cff7',
    );
  });

  it('truncates to the leftmost `bytes` bytes', () => {
    expect(hexOf(hmacB64u('Jefe', MSG, 16))).toBe(CASE_2.slice(0, 32));
    expect(hexOf(hmacB64u('Jefe', MSG, 32))).toBe(CASE_2);
    for (const bytes of [0, 33, 1.5]) expect(() => hmacB64u('Jefe', MSG, bytes), String(bytes)).toThrow(RangeError);
  });

  it('does not treat a base64url key text as its decoded bytes (M31: callers decode the sessionKey)', () => {
    const key = new Uint8Array(32).fill(7);
    const text = Buffer.from(key).toString('base64url');
    expect(hmacB64u(text, 'csrf:x')).not.toBe(hmacB64u(key, 'csrf:x'));
    expect(hmacB64u(decodeBase64Url(text)!, 'csrf:x')).toBe(hmacB64u(key, 'csrf:x'));
  });
});

describe('safeEqual', () => {
  it('compares strings', () => {
    expect(safeEqual('', '')).toBe(true);
    expect(safeEqual('abc', 'abc')).toBe(true);
    expect(safeEqual('abc', 'abd')).toBe(false);
    expect(safeEqual('é', 'é')).toBe(false);
  });

  it('is false on a length mismatch', () => {
    expect(safeEqual('abc', 'abcd')).toBe(false);
    expect(safeEqual('abcd', 'abc')).toBe(false);
    expect(safeEqual('', 'a')).toBe(false);
    expect(safeEqual('é', 'a')).toBe(false); // same UTF-16 length, different UTF-8 length
  });
});
