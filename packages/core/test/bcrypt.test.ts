import { describe, expect, it } from 'vitest';
import { BCRYPT_MAX_COST, bcryptCost, bcryptVerify, isBcryptHash } from '../src/crypto/bcrypt.js';
import { createPasswordHasher } from '../src/crypto/password.js';

// The bcrypt verifier of migrated SLiMS passwords: the public test vectors of the OpenBSD and crypt_blowfish
// implementations, hashes made with Apache's `htpasswd -B` (PHP's `$2y$` form) for a password with non-ASCII letters
// and for passwords over 72 bytes, the cost bound, and the start state derived from pi itself.

/** Public vectors (OpenBSD's regression set and crypt_blowfish's self-test), with the password as bytes. */
const PUBLIC: readonly [hash: string, password: string | Uint8Array][] = [
  ['$2a$05$CCCCCCCCCCCCCCCCCCCCC.E5YPO9kmyuRGyh0XouQYb4YMJKvyOeW', 'U*U'],
  ['$2a$05$CCCCCCCCCCCCCCCCCCCCC.VGOzA784oUp/Z0DY336zx7pLYAy0lwK', 'U*U*'],
  ['$2a$05$XXXXXXXXXXXXXXXXXXXXXOAcXxm9kjPGEMsLznoKqmqw7tc8WCx4a', 'U*U*U'],
  [
    '$2a$05$abcdefghijklmnopqrstuu5s2v8.iXieOjg/.AySBTTZIIVFJeBui',
    '0123456789abcdefghijklmnopqrstuvwxyzABCDEFGHIJKLMNOPQRSTUVWXYZ0123456789chars after 72 are ignored',
  ],
  ['$2y$05$/OK.fbVrR/bpIqNJ5ianF.Sa7shbm4.OzKpvFnX1pQLmQW96oUlCq', Uint8Array.of(0xa3)],
  ['$2b$05$/OK.fbVrR/bpIqNJ5ianF.CE5elHaaO4EbggVDjb8P19RukzXSM3e', Uint8Array.of(0xff, 0xff, 0xa3)],
  ['$2y$05$/OK.fbVrR/bpIqNJ5ianF.CE5elHaaO4EbggVDjb8P19RukzXSM3e', Uint8Array.of(0xff, 0xff, 0xa3)],
  ['$2a$05$CCCCCCCCCCCCCCCCCCCCC.7uG0VCzI2bS7j6ymqJi9CdcdxiRTWNy', ''],
];

/** `htpasswd -nbBC <cost>` output (PHP's `$2y$`), for passwords typed as UTF-8. */
const HTPASSWD: readonly [hash: string, password: string][] = [
  ['$2y$05$uZWUFFpxaAYrf/0WfTyFOOvrvtsAqIBvx4oiC22rmi0uTNdSXeRei', 'kata sandi ñandú 日本'],
  ['$2y$05$32vDzKv9t4TT9rW1FoZHR.CXJ/w2u15S/72MAMHCa4HE0rmp/ygmK', 'é'],
  ['$2y$05$oabie/M.2XPAmvTGEw1lJOwwTmKlYehbFqzlmvM2QPUE8Sozlwb3G', 'Perpustakaan@2024'],
  ['$2y$10$3oR7H9zf1GpuJNuVwBkw8u4qxsZs2PTIyJd4f7I8ZAjT28AdPSb02', 'siswa123'],
];

/** 80 and 75 characters that share their first 72: one hash fits both. */
const LONG_80 = '0123456789012345678901234567890123456789012345678901234567890123456789ABCDEFGHIJ';
const LONG_75 = '0123456789012345678901234567890123456789012345678901234567890123456789ABxyz';
const LONG_HASH = '$2y$05$D7QIK5GjARPjiWQqOoYGWeDuQwojh/VZYLFUp2E3k.ak4M4by3b0i';

describe('bcryptVerify', () => {
  it.each(PUBLIC)('the public vector %s verifies, and a changed password does not', async (hash, password) => {
    expect(await bcryptVerify(password, hash)).toBe(true);
    // Changed in its first byte (a byte after the 72nd would not count).
    const other = typeof password === 'string' ? `!${password}` : Uint8Array.from([0x21, ...password]);
    expect(await bcryptVerify(other, hash)).toBe(false);
  });

  it.each(HTPASSWD)('the $2y$ hash %s of a typed password verifies (non-ASCII as UTF-8)', async (hash, password) => {
    expect(await bcryptVerify(password, hash)).toBe(true);
    expect(await bcryptVerify(password.normalize('NFD') === password ? `${password}x` : password.normalize('NFD'), hash)).toBe(false);
  });

  it('a password over 72 bytes counts by its first 72 bytes only', async () => {
    expect(LONG_80.length).toBe(80);
    expect(await bcryptVerify(LONG_80, LONG_HASH)).toBe(true);
    expect(await bcryptVerify(LONG_75, LONG_HASH)).toBe(true);
    expect(await bcryptVerify(LONG_80.slice(0, 71), LONG_HASH)).toBe(false);
  });

  it('refuses a cost above 12 or below 4, a malformed hash and another algorithm without verifying', async () => {
    const tooCostly = '$2y$13$3oR7H9zf1GpuJNuVwBkw8u4qxsZs2PTIyJd4f7I8ZAjT28AdPSb02';
    expect(bcryptCost(tooCostly)).toBe(13);
    expect(BCRYPT_MAX_COST).toBe(12);
    expect(await bcryptVerify('siswa123', tooCostly)).toBe(false);
    expect(await bcryptVerify('U*U', '$2a$03$CCCCCCCCCCCCCCCCCCCCC.E5YPO9kmyuRGyh0XouQYb4YMJKvyOeW')).toBe(false);
    expect(await bcryptVerify('U*U', '$2x$05$CCCCCCCCCCCCCCCCCCCCC.E5YPO9kmyuRGyh0XouQYb4YMJKvyOeW')).toBe(false);
    expect(await bcryptVerify('U*U', '$2a$05$CCCC')).toBe(false);
    expect(isBcryptHash('5f4dcc3b5aa765d61d8327deb882cf99')).toBe(false);
    expect(isBcryptHash(PUBLIC[0]![0])).toBe(true);
  });

  it('the password hasher verifies a bcrypt hash in its queue and always asks for a rehash', async () => {
    const hasher = createPasswordHasher();
    expect(await hasher.verify('siswa123', HTPASSWD[3]![0])).toBe(true);
    expect(await hasher.verify('siswa124', HTPASSWD[3]![0])).toBe(false);
    expect(hasher.needsRehash(HTPASSWD[3]![0])).toBe(true);
  });
});

describe('the Blowfish start state', () => {
  it('is the fractional part of pi in hexadecimal: 18 subkeys, then the four S-boxes', async () => {
    // pi * 2^bits by Machin's formula, pi = 16 atan(1/5) - 4 atan(1/239), with 64 guard bits.
    const words = 1042;
    const bits = BigInt(words * 32 + 64);
    const one = 1n << bits;
    const atanInv = (x: bigint): bigint => {
      let sum = 0n;
      let term = one / x;
      let n = 1n;
      let sign = 1n;
      while (term !== 0n) {
        sum += (sign * term) / n;
        term /= x * x;
        n += 2n;
        sign = -sign;
      }
      return sum;
    };
    const pi = 16n * atanInv(5n) - 4n * atanInv(239n);
    const fraction = (pi - 3n * one) >> 64n;
    const hex = fraction.toString(16).padStart(words * 8, '0');
    // The state the verifier starts from, read through a hash: a correct start state is what makes the vectors pass;
    // here its first subkey and first S-box word are checked against pi directly.
    expect(hex.slice(0, 8)).toBe('243f6a88');
    expect(hex.slice(18 * 8, 19 * 8)).toBe('d1310ba6');
    const source = await import('node:fs').then((fs) => fs.readFileSync(new URL('../src/crypto/bcrypt.ts', import.meta.url), 'utf8'));
    const b64 = [...source.matchAll(/^ {2}'([A-Za-z0-9+/=]+)'(?: \+|;)$/gm)].map((m) => m[1]).join('');
    expect(Buffer.from(b64, 'base64').toString('hex')).toBe(hex);
  });
});
