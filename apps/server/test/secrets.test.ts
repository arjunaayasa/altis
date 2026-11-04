import { createPrivateKey } from 'node:crypto';
import { decodeBase64Url, importPublicKey, rawPublicKey } from '@altis/crypto';
import { isUlid } from '@altis/shared';
import { describe, expect, it } from 'vitest';
import { ConfigSchema } from '../src/config.js';
import { generateInstallSecrets } from '../src/secrets.js';
import { sampleConfig } from './support.js';

describe('generateInstallSecrets', () => {
  const secrets = generateInstallSecrets('2026-10-27');

  it('makes sessionKey and cronToken of 32 random bytes each, as unpadded base64url', () => {
    for (const value of [secrets.secrets.sessionKey, secrets.secrets.cronToken]) {
      expect(value).toMatch(/^[A-Za-z0-9_-]{43}$/);
      expect(decodeBase64Url(value)).toHaveLength(32);
    }
    expect(secrets.secrets.sessionKey).not.toBe(secrets.secrets.cronToken);
  });

  it('gives the install a ULID id and the install date it was given', () => {
    expect(isUlid(secrets.install.id)).toBe(true);
    expect(secrets.install.trialStartedAt).toBe('2026-10-27');
  });

  it('has a keyring with exactly one active key of 32 bytes, with a kid that fits the v1:<kid>:<iv>:<ct> format', () => {
    expect(secrets.keyring).toHaveLength(1);
    expect(secrets.keyring.filter((k) => k.active)).toHaveLength(1);
    const [entry] = secrets.keyring;
    expect(entry!.kid).toMatch(/^[0-9A-Z]{14}$/);
    expect(entry!.kid).not.toContain(':');
    expect(decodeBase64Url(entry!.key)).toHaveLength(32);
  });

  it('makes an Ed25519 install key pair in the format packages/crypto uses', () => {
    const { publicKey, privateKey } = secrets.install;
    expect(decodeBase64Url(publicKey)).toHaveLength(32); // raw public key, base64url
    expect(() => importPublicKey(publicKey)).not.toThrow();
    // the private key is PKCS#8 DER in base64, like the {kid, use, pkcs8} key files of tools/keys
    const key = createPrivateKey({ key: Buffer.from(privateKey, 'base64'), format: 'der', type: 'pkcs8' });
    expect(key.asymmetricKeyType).toBe('ed25519');
    expect(rawPublicKey(key)).toBe(publicKey);
  });

  it('is different every time: no two installs share a secret, a key or an id', () => {
    const other = generateInstallSecrets('2026-10-27');
    expect(other.secrets.sessionKey).not.toBe(secrets.secrets.sessionKey);
    expect(other.secrets.cronToken).not.toBe(secrets.secrets.cronToken);
    expect(other.keyring[0]!.key).not.toBe(secrets.keyring[0]!.key);
    expect(other.keyring[0]!.kid).not.toBe(secrets.keyring[0]!.kid);
    expect(other.install.id).not.toBe(secrets.install.id);
    expect(other.install.publicKey).not.toBe(secrets.install.publicKey);
    expect(other.install.privateKey).not.toBe(secrets.install.privateKey);
  });

  it('produces exactly what the config schema accepts', () => {
    expect(ConfigSchema.safeParse(sampleConfig()).success).toBe(true);
  });

  it.each(['2026-13-01', '2026-02-30', '2026-2-3', '27-10-2026', '', '2026-10-27T00:00:00Z', ' 2026-10-27'])(
    'refuses the install date %j',
    (today) => {
      expect(() => generateInstallSecrets(today)).toThrow(RangeError);
    },
  );

  it('accepts a leap day', () => {
    expect(generateInstallSecrets('2028-02-29').install.trialStartedAt).toBe('2028-02-29');
  });
});
