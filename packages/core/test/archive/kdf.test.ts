import { randomBytes } from 'node:crypto';
import { isDomainError } from '@altis/shared';
import { describe, expect, it } from 'vitest';
import {
  ARCHIVE_SALT_BYTES,
  ARCHIVE_SCRYPT,
  DEK_BYTES,
  columnKey,
  deriveKek,
  openArchiveValue,
  sealArchiveValue,
  unwrapDek,
  wrapDek,
} from '../../src/archive/kdf.js';

// The archive's key hierarchy (decision C13): KEK = scrypt(NFKC passphrase), the per-archive DEK wrapped with it
// (AES-256-GCM), the column key HKDF-SHA256(DEK, 'altis-backup/1 columns') that re-seals secret columns.

const SALT = new Uint8Array(ARCHIVE_SALT_BYTES).fill(3);

async function rejection(p: Promise<unknown>): Promise<unknown> {
  try {
    await p;
  } catch (error) {
    return error;
  }
  throw new Error('expected a rejection');
}

function thrown(fn: () => unknown): unknown {
  try {
    fn();
  } catch (error) {
    return error;
  }
  throw new Error('expected a throw');
}

describe('deriveKek', () => {
  it('uses scrypt N = 2^16, r = 8, p = 1 (64 MiB, inside P11)', () => {
    expect(ARCHIVE_SCRYPT).toEqual({ N: 65536, r: 8, p: 1, keylen: 32, maxmem: 134_217_728 });
    expect(Object.isFrozen(ARCHIVE_SCRYPT)).toBe(true);
  });

  it('refuses a passphrase of 9 code points with VALIDATION_FAILED, and accepts 10', async () => {
    const error = await rejection(deriveKek('123456789', SALT));
    expect(isDomainError(error) && error.code).toBe('VALIDATION_FAILED');
    expect(isDomainError(error) && error.meta).toEqual({ errors: [{ path: 'passphrase', code: 'too_small' }] });
    // Ten code points, of which one is outside the BMP (two UTF-16 units): length counts code points.
    const kek = await deriveKek('12345678\u{1F600}x', SALT);
    expect(kek.byteLength).toBe(32);
  });

  it('never trims: spaces count toward the length and change the key', async () => {
    const spaced = await deriveKek(' 12345678 ', SALT); // 10 code points only with its spaces: accepted
    const plain = await deriveKek('x12345678x', SALT);
    expect(spaced.byteLength).toBe(32);
    expect(Buffer.from(spaced).equals(Buffer.from(plain))).toBe(false);
    expect(Buffer.from(await deriveKek('  abcdefghij', SALT)).equals(Buffer.from(await deriveKek('abcdefghij', SALT)))).toBe(false);
  }, 30_000);

  it('refuses a passphrase with a lone surrogate', async () => {
    const error = await rejection(deriveKek('abcdefghij\uD800', SALT));
    expect(isDomainError(error) && error.code).toBe('VALIDATION_FAILED');
    expect(isDomainError(error) && error.meta).toEqual({ errors: [{ path: 'passphrase', code: 'invalid_string' }] });
  });

  it('refuses a salt that is not 16 bytes', async () => {
    await expect(deriveKek('correct horse battery', new Uint8Array(8))).rejects.toThrow(TypeError);
  });
});

describe('DEK wrapping', () => {
  it('unwraps the same DEK from a passphrase typed in NFC and in NFD', async () => {
    const nfc = 'Perpustakaan café Ångström';
    const nfd = nfc.normalize('NFD');
    expect(nfd).not.toBe(nfc);
    const dek = randomBytes(DEK_BYTES);
    const wrapped = wrapDek(await deriveKek(nfc, SALT), dek);
    expect(Buffer.from(unwrapDek(await deriveKek(nfd, SALT), wrapped)).equals(dek)).toBe(true);
  }, 30_000);

  it('refuses the wrong passphrase with BACKUP_PASSPHRASE_INVALID', async () => {
    const dek = randomBytes(DEK_BYTES);
    const wrapped = wrapDek(await deriveKek('kata sandi yang benar', SALT), dek);
    const other = await deriveKek('kata sandi yang salah', SALT);
    const error = thrown(() => unwrapDek(other, wrapped));
    expect(isDomainError(error) && error.code).toBe('BACKUP_PASSPHRASE_INVALID');
    // and a damaged wrap
    const damaged = thrown(() => unwrapDek(other, { iv: wrapped.iv, ct: 'AAAA' }));
    expect(isDomainError(damaged) && damaged.code).toBe('BACKUP_PASSPHRASE_INVALID');
  }, 30_000);

  it('wraps with a fresh IV each time and refuses keys of the wrong size', () => {
    const kek = new Uint8Array(32).fill(1);
    const dek = randomBytes(DEK_BYTES);
    const a = wrapDek(kek, dek);
    const b = wrapDek(kek, dek);
    expect(a.iv).not.toBe(b.iv);
    expect(Buffer.from(unwrapDek(kek, b)).equals(dek)).toBe(true);
    expect(() => wrapDek(new Uint8Array(16), dek)).toThrow(TypeError);
    expect(() => wrapDek(kek, new Uint8Array(31))).toThrow(TypeError);
  });
});

describe('column key and archive-sealed values', () => {
  const dek = new Uint8Array(32).fill(5);
  const aad = 'staff_users.totp_secret_enc.01JBQ7T1D1V6B3R6Z8Y2Q5W4XA';

  it('derives the column key with HKDF-SHA256(DEK, "altis-backup/1 columns")', () => {
    const key = columnKey(dek);
    expect(key.byteLength).toBe(32);
    expect(Buffer.from(key).equals(Buffer.from(dek))).toBe(false);
    expect(Buffer.from(columnKey(dek)).equals(Buffer.from(key))).toBe(true);
  });

  it('round-trips v1:archive:<iv>:<ct> with the same AAD and fails with another', () => {
    const key = columnKey(dek);
    const sealed = sealArchiveValue(key, aad, 'JBSWY3DPEHPK3PXP');
    expect(sealed).toMatch(/^v1:archive:[A-Za-z0-9_-]{16}:[A-Za-z0-9_-]{22,}$/);
    expect(openArchiveValue(key, aad, sealed)).toBe('JBSWY3DPEHPK3PXP');
    const error = thrown(() => openArchiveValue(key, 'staff_users.totp_secret_enc.01JBQ7T1D1V6B3R6Z8Y2Q5W4XB', sealed));
    expect(isDomainError(error) && error.code).toBe('SECRET_UNREADABLE');
    const malformed = thrown(() => openArchiveValue(key, aad, 'v1:k1:AAAAAAAAAAAAAAAA:AAAAAAAAAAAAAAAAAAAAAA'));
    expect(isDomainError(malformed) && malformed.code).toBe('SECRET_UNREADABLE');
    const otherKey = thrown(() => openArchiveValue(columnKey(new Uint8Array(32).fill(6)), aad, sealed));
    expect(isDomainError(otherKey) && otherKey.code).toBe('SECRET_UNREADABLE');
  });
});
