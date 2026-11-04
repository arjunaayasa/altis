import { describe, expect, it } from 'vitest';
import {
  TOTP,
  base32Decode,
  base32Encode,
  generateTotpSecret,
  hotp,
  matchTotp,
  otpauthUri,
  totpStep,
} from '../src/auth/totp.js';

// TOTP (RFC 6238 over RFC 4226 HOTP, HMAC-SHA1): 30-second steps, 6 digits, a 20-byte secret, ±1 step, and no code
// accepted twice (the caller stores the matched step with `UPDATE … WHERE totp_last_step < ?`).

const utf8 = (s: string): Uint8Array => new TextEncoder().encode(s);

/** The RFC 4226 / RFC 6238 SHA1 test secret. */
const RFC_SECRET = utf8('12345678901234567890');

describe('TOTP', () => {
  it('is 30 s, 6 digits, a 20-byte secret, ±1 step', () => {
    expect(TOTP).toEqual({ periodS: 30, digits: 6, secretBytes: 20, window: 1 });
  });
});

describe('hotp', () => {
  it('gives the SHA1 rows of RFC 6238 Appendix B', () => {
    const rows: Array<[number, string]> = [
      [59, '94287082'],
      [1111111109, '07081804'],
      [1111111111, '14050471'],
      [1234567890, '89005924'],
      [2000000000, '69279037'],
      [20000000000, '65353130'],
    ];
    for (const [t, code] of rows) expect(hotp(RFC_SECRET, Math.floor(t / 30), 8), String(t)).toBe(code);
  });

  it('gives the 6-digit values of RFC 4226 Appendix D', () => {
    const values = ['755224', '287082', '359152', '969429', '338314', '254676', '287922', '162583', '399871', '520489'];
    values.forEach((code, counter) => expect(hotp(RFC_SECRET, counter, 6), String(counter)).toBe(code));
  });

  it('refuses a counter or a digit count outside the RFC', () => {
    expect(() => hotp(RFC_SECRET, -1, 6)).toThrow(RangeError);
    expect(() => hotp(RFC_SECRET, 1.5, 6)).toThrow(RangeError);
    expect(() => hotp(RFC_SECRET, 2 ** 53, 6)).toThrow(RangeError);
    expect(() => hotp(RFC_SECRET, 1, 5)).toThrow(RangeError);
    expect(() => hotp(RFC_SECRET, 1, 9)).toThrow(RangeError);
  });
});

describe('totpStep', () => {
  it('is floor(nowMs / 30 000)', () => {
    expect(totpStep(0)).toBe(0);
    expect(totpStep(29_999)).toBe(0);
    expect(totpStep(30_000)).toBe(1);
    expect(totpStep(59_000)).toBe(1);
    expect(totpStep(1_111_111_109_000)).toBe(0x23523ec);
  });
});

describe('generateTotpSecret', () => {
  it('is 20 random bytes', () => {
    const a = generateTotpSecret();
    const b = generateTotpSecret();
    expect(a).toBeInstanceOf(Uint8Array);
    expect(a).toHaveLength(20);
    expect(Buffer.from(a).equals(Buffer.from(b))).toBe(false);
  });
});

describe('base32', () => {
  // RFC 4648 §10, without the padding.
  const VECTORS: Array<[string, string]> = [
    ['', ''],
    ['f', 'MY'],
    ['fo', 'MZXQ'],
    ['foo', 'MZXW6'],
    ['foob', 'MZXW6YQ'],
    ['fooba', 'MZXW6YTB'],
    ['foobar', 'MZXW6YTBOI'],
  ];

  it('encodes RFC 4648 §10 without padding', () => {
    expect(base32Encode(utf8('foobar'))).toBe('MZXW6YTBOI');
    for (const [text, b32] of VECTORS) expect(base32Encode(utf8(text)), text).toBe(b32);
    expect(base32Encode(RFC_SECRET)).toBe('GEZDGNBVGY3TQOJQGEZDGNBVGY3TQOJQ');
  });

  it('decodes what it encodes', () => {
    for (const [text, b32] of VECTORS) expect(Buffer.from(base32Decode(b32)).toString('utf8'), b32).toBe(text);
    const secret = generateTotpSecret();
    expect(base32Decode(base32Encode(secret))).toEqual(secret);
  });

  it('decodes case-insensitively, ignoring spaces and padding', () => {
    expect(Buffer.from(base32Decode('mzxw 6ytb oi======')).toString('utf8')).toBe('foobar');
    expect(Buffer.from(base32Decode('MZXW6YQ=')).toString('utf8')).toBe('foob');
    expect(base32Decode('gezd gnbv gy3t qojq gezd gnbv gy3t qojq')).toEqual(RFC_SECRET);
  });

  it('refuses characters outside the alphabet', () => {
    // İ, ı and ſ upper- or lower-case to an ASCII letter of the alphabet with toUpperCase, so they must not slip in.
    for (const bad of ['MZXW1', 'MZXW8', 'MZ-XW', 'MZXW6YTBOİ', 'MZXW6YTBOı', 'MZXWſ']) {
      expect(() => base32Decode(bad), bad).toThrow(TypeError);
    }
  });
});

describe('matchTotp', () => {
  const secret = utf8('altis-perpus-secret!');
  const now = 1_793_000_012_345; // a moment in 2026
  const s = totpStep(now);
  const codeAt = (step: number): string => hotp(secret, step, 6);

  it('accepts the codes of steps s-1, s and s+1, returning that step', () => {
    expect(matchTotp(secret, codeAt(s - 1), now, 0)).toBe(s - 1);
    expect(matchTotp(secret, codeAt(s), now, 0)).toBe(s);
    expect(matchTotp(secret, codeAt(s + 1), now, 0)).toBe(s + 1);
  });

  it('refuses the codes of steps s-2 and s+2', () => {
    expect(matchTotp(secret, codeAt(s - 2), now, 0)).toBeNull();
    expect(matchTotp(secret, codeAt(s + 2), now, 0)).toBeNull();
  });

  it('refuses a code of a step at or before lastStep (a replay)', () => {
    expect(matchTotp(secret, codeAt(s), now, s)).toBeNull();
    expect(matchTotp(secret, codeAt(s - 1), now, s - 1)).toBeNull();
    expect(matchTotp(secret, codeAt(s - 1), now, s)).toBeNull();
    expect(matchTotp(secret, codeAt(s), now, s - 1)).toBe(s);
    expect(matchTotp(secret, codeAt(s + 1), now, s)).toBe(s + 1);
  });

  it('refuses anything but 6 ASCII digits', () => {
    expect(matchTotp(secret, '12345', now, 0)).toBeNull();
    expect(matchTotp(secret, 'abcdef', now, 0)).toBeNull();
    expect(matchTotp(secret, `${codeAt(s)} `, now, 0)).toBeNull();
    expect(matchTotp(secret, `${codeAt(s)}0`, now, 0)).toBeNull();
    expect(matchTotp(secret, codeAt(s).replace(/\d/g, (d) => String.fromCodePoint(0xff10 + Number(d))), now, 0)).toBeNull();
    expect(matchTotp(secret, 123456 as unknown as string, now, 0)).toBeNull();
  });

  it('works on the step boundary', () => {
    const boundary = (s + 1) * 30_000;
    expect(matchTotp(secret, codeAt(s + 2), boundary - 1, 0)).toBeNull();
    expect(matchTotp(secret, codeAt(s + 2), boundary, 0)).toBe(s + 2);
    expect(matchTotp(secret, codeAt(s - 1), boundary, 0)).toBeNull();
  });
});

describe('otpauthUri', () => {
  it('is the Key URI an authenticator app reads', () => {
    expect(otpauthUri({ issuer: 'ALTIS Perpus', account: 'budi', secret: RFC_SECRET })).toBe(
      'otpauth://totp/ALTIS%20Perpus:budi?secret=GEZDGNBVGY3TQOJQGEZDGNBVGY3TQOJQ&issuer=ALTIS%20Perpus&algorithm=SHA1&digits=6&period=30',
    );
    const secret = generateTotpSecret();
    expect(otpauthUri({ issuer: 'ALTIS Perpus', account: 'budi', secret })).toBe(
      `otpauth://totp/ALTIS%20Perpus:budi?secret=${base32Encode(secret)}&issuer=ALTIS%20Perpus&algorithm=SHA1&digits=6&period=30`,
    );
  });

  it('percent-encodes the issuer and the account, colons included', () => {
    expect(otpauthUri({ issuer: 'Perpus: Kota & Desa', account: 'siti@perpus.id', secret: RFC_SECRET })).toBe(
      'otpauth://totp/Perpus%3A%20Kota%20%26%20Desa:siti%40perpus.id?secret=GEZDGNBVGY3TQOJQGEZDGNBVGY3TQOJQ' +
        '&issuer=Perpus%3A%20Kota%20%26%20Desa&algorithm=SHA1&digits=6&period=30',
    );
  });
});
