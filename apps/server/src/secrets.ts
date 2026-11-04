import { randomBytes } from 'node:crypto';
import { generateKeyPair } from '@altis/crypto';
import { newId } from '@altis/shared';
import { isCalendarDate, type Config } from './config.js';

// The secrets of a new install (spec §7.6), generated once by the installer and kept in `config.json`.

/** 32 random bytes from the operating system's CSPRNG, as unpadded base64url. */
function randomKey(): string {
  return randomBytes(32).toString('base64url');
}

/**
 * The key id of a keyring entry: the first 14 characters of a ULID (10 of time, 4 random), so that kids sort by
 * creation and two keys made in the same millisecond still differ. Crockford base32 has no `:`, which the
 * `v1:<kid>:<iv>:<ct>` format of encrypted values needs.
 */
function newKid(): string {
  return newId().slice(0, 14);
}

/**
 * Everything `config.json` holds that is made at install time:
 *
 * - `secrets.sessionKey` and `secrets.cronToken`: 32 random bytes each, unpadded base64url;
 * - `keyring`: one entry, active, with a key of 32 random bytes;
 * - `install`: a new ULID `id`, a new Ed25519 key pair (`publicKey` is the raw key as base64url, as in
 *   `@altis/crypto`; `privateKey` is PKCS#8 DER as base64, as in the `{kid, use, pkcs8}` key files of tools/keys)
 *   and `trialStartedAt`, the install date, which is `today`.
 *
 * @param today the day the install happens, `YYYY-MM-DD`, in the library's time zone
 * @throws RangeError when `today` is not a calendar date in `YYYY-MM-DD` form
 */
export function generateInstallSecrets(today: string): Pick<Config, 'secrets' | 'keyring' | 'install'> {
  if (typeof today !== 'string' || !isCalendarDate(today)) {
    throw new RangeError('generateInstallSecrets: today must be a calendar date in the form YYYY-MM-DD');
  }
  const { privateKey, pub } = generateKeyPair();
  return {
    secrets: { sessionKey: randomKey(), cronToken: randomKey() },
    keyring: [{ kid: newKid(), key: randomKey(), active: true }],
    install: {
      id: newId(),
      publicKey: pub,
      privateKey: privateKey.export({ format: 'der', type: 'pkcs8' }).toString('base64'),
      trialStartedAt: today,
    },
  };
}
