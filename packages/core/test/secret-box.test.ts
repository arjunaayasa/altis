import { randomBytes } from 'node:crypto';
import { decodeBase64Url } from '@altis/crypto';
import { isDomainError } from '@altis/shared';
import { describe, expect, it } from 'vitest';
import { openValue, sealValue, secretAad, type KeyringEntry } from '../src/crypto/secret-box.js';

// Encrypted values (spec §7.6): `v1:<kid>:<iv>:<ct>`, AES-256-GCM with the keyring's active key, a 12-byte IV,
// ct = ciphertext‖tag, all unpadded base64url, and AAD = `table.column.rowId`.

const SEALED = /^v1:[0-9A-Za-z_-]{1,64}:[A-Za-z0-9_-]{16}:[A-Za-z0-9_-]{22,}$/;

const newKey = (): string => randomBytes(32).toString('base64url');

const AAD = secretAad('staff_users', 'totp_secret_enc', '01JBX3Q5N2V8W9YZ0ABCDEFGHJ');

/** The `meta.reason` of the SECRET_UNREADABLE that opening `sealed` throws (fails when it opens). */
function unreadable(keyring: readonly KeyringEntry[], aad: string, sealed: string): unknown {
  try {
    openValue(keyring, aad, sealed);
  } catch (error) {
    if (!isDomainError(error) || error.code !== 'SECRET_UNREADABLE') throw error;
    expect(error.status).toBe(500);
    return error.meta?.['reason'];
  }
  return expect.fail(`${sealed} opened`);
}

describe('secretAad', () => {
  it('is table.column.rowId', () => {
    expect(secretAad('settings', 'value_enc', 'smtp.password')).toBe('settings.value_enc.smtp.password');
  });
});

describe('sealValue / openValue', () => {
  const keyring: KeyringEntry[] = [{ kid: '01JBX3Q5N2V8W9', key: newKey(), active: true }];

  it('round-trips, including the empty string and non-ASCII text', () => {
    for (const plaintext of ['rahasia SMTP', '', 'kata sandi ✓ — 日本 \u{1F40E}', 'x'.repeat(4096)]) {
      const sealed = sealValue(keyring, AAD, plaintext);
      expect(openValue(keyring, AAD, sealed)).toBe(plaintext);
    }
  });

  it('writes v1:<kid>:<iv>:<ct> with a 12-byte IV and ct = ciphertext‖16-byte tag', () => {
    const sealed = sealValue(keyring, AAD, 'abc');
    expect(sealed).toMatch(SEALED);
    const [, , iv, ct] = sealed.split(':');
    expect(decodeBase64Url(iv!)).toHaveLength(12);
    expect(decodeBase64Url(ct!)).toHaveLength(3 + 16);
    expect(sealValue(keyring, AAD, '')).toMatch(SEALED); // the tag alone: 22 characters
  });

  it('uses a fresh IV every time', () => {
    const a = sealValue(keyring, AAD, 'sama');
    const b = sealValue(keyring, AAD, 'sama');
    expect(a).not.toBe(b);
    expect(a.split(':')[2]).not.toBe(b.split(':')[2]);
  });

  it('refuses another AAD with SECRET_UNREADABLE', () => {
    const sealed = sealValue(keyring, AAD, 'rahasia');
    expect(unreadable(keyring, secretAad('staff_users', 'totp_secret_enc', 'another-row'), sealed)).toBe(
      'auth_failed',
    );
    expect(unreadable(keyring, secretAad('settings', 'value_enc', 'smtp.password'), sealed)).toBe('auth_failed');
  });

  it('refuses a kid absent from the keyring with SECRET_UNREADABLE', () => {
    const sealed = sealValue(keyring, AAD, 'rahasia');
    const other: KeyringEntry[] = [{ kid: 'another-kid', key: keyring[0]!.key, active: true }];
    expect(unreadable(other, AAD, sealed)).toBe('unknown_kid');
  });

  it('refuses a wrong key under the same kid, and any tampering, with SECRET_UNREADABLE', () => {
    const sealed = sealValue(keyring, AAD, 'rahasia');
    const wrongKey: KeyringEntry[] = [{ ...keyring[0]!, key: newKey() }];
    expect(unreadable(wrongKey, AAD, sealed)).toBe('auth_failed');

    const [v, kid, iv, ct] = sealed.split(':') as [string, string, string, string];
    const flip = (b64u: string): string => {
      const bytes = decodeBase64Url(b64u)!;
      bytes[0] = bytes[0]! ^ 1;
      return bytes.toString('base64url');
    };
    expect(unreadable(keyring, AAD, [v, kid, flip(iv), ct].join(':'))).toBe('auth_failed');
    expect(unreadable(keyring, AAD, [v, kid, iv, flip(ct)].join(':'))).toBe('auth_failed');
    const bytes = decodeBase64Url(ct)!;
    expect(unreadable(keyring, AAD, [v, kid, iv, bytes.subarray(0, bytes.length - 1).toString('base64url')].join(':'))).toBe(
      'auth_failed',
    );
  });

  it('refuses malformed values with SECRET_UNREADABLE', () => {
    const sealed = sealValue(keyring, AAD, 'rahasia');
    const [, kid, iv, ct] = sealed.split(':') as [string, string, string, string];
    const malformed = [
      '',
      'rahasia',
      `v2:${kid}:${iv}:${ct}`,
      `v1:${kid}:${iv}`,
      `v1:${kid}:${iv}:${ct}:extra`,
      `v1::${iv}:${ct}`,
      `v1:${kid}:${iv}=:${ct}`,
      `v1:${kid}:${iv.slice(1)}:${ct}`, // 11 bytes of IV
      `v1:${kid}:${iv}:${ct.slice(0, 21)}`, // shorter than a tag
      `v1:${kid}:${iv}:${ct}=`,
      `v1:${kid}:${iv}:${ct.replace(/^./, '+')}`,
      ` ${sealed}`,
      `${sealed}\n`,
    ];
    for (const value of malformed) expect(unreadable(keyring, AAD, value), JSON.stringify(value)).toBe('malformed');
    expect(unreadable(keyring, AAD, 42 as unknown as string)).toBe('malformed');
  });

  it('never puts the plaintext, the key or the AAD in the error', () => {
    const sealed = sealValue(keyring, AAD, 'rahasia-sekali');
    const other: KeyringEntry[] = [{ ...keyring[0]!, key: newKey() }];
    try {
      openValue(other, AAD, sealed);
      expect.fail('opened');
    } catch (error) {
      const text = JSON.stringify({ message: (error as Error).message, meta: (error as { meta?: unknown }).meta });
      expect(text).not.toContain('rahasia-sekali');
      expect(text).not.toContain(keyring[0]!.key);
      expect(text).not.toContain(other[0]!.key);
    }
  });
});

describe('key rotation', () => {
  it('seals with the active kid', () => {
    const keyring: KeyringEntry[] = [
      { kid: '01JBX3Q5N2V8W9', key: newKey(), active: false },
      { kid: '01JC0000000000', key: newKey(), active: true },
      { kid: '01JA0000000000', key: newKey(), active: false },
    ];
    expect(sealValue(keyring, AAD, 'rahasia').startsWith('v1:01JC0000000000:')).toBe(true);
  });

  it('opens a value sealed with a key that is now inactive but still in the keyring', () => {
    const old: KeyringEntry = { kid: 'old', key: newKey(), active: true };
    const sealed = sealValue([old], AAD, 'rahasia lama');
    const rotated: KeyringEntry[] = [{ ...old, active: false }, { kid: 'new', key: newKey(), active: true }];
    expect(openValue(rotated, AAD, sealed)).toBe('rahasia lama');
    expect(sealValue(rotated, AAD, 'rahasia baru').startsWith('v1:new:')).toBe(true);
  });

  it('refuses to seal without exactly one active, well-formed key (a configuration error)', () => {
    const key = newKey();
    expect(() => sealValue([], AAD, 'x')).toThrow(TypeError);
    expect(() => sealValue([{ kid: 'a', key, active: false }], AAD, 'x')).toThrow(TypeError);
    expect(() =>
      sealValue(
        [
          { kid: 'a', key, active: true },
          { kid: 'b', key: newKey(), active: true },
        ],
        AAD,
        'x',
      ),
    ).toThrow(TypeError);
    expect(() => sealValue([{ kid: 'a', key: key.slice(0, 22), active: true }], AAD, 'x')).toThrow(TypeError);
    expect(() => sealValue([{ kid: 'a:b', key, active: true }], AAD, 'x')).toThrow(TypeError);
  });
});
