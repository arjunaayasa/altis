import { createCipheriv, createDecipheriv, randomBytes } from 'node:crypto';
import { decodeBase64Url, encodeBase64Url } from '@altis/crypto';
import { DomainError } from '@altis/shared';

// Secrets kept in the database (spec §7.6), such as the SMTP password and TOTP secrets, are sealed with the
// install's keyring (`config.json`):
//
//   v1:<kid>:<iv>:<ct>
//
// AES-256-GCM under the key `kid`, a fresh 12-byte IV, `ct` = ciphertext‖16-byte tag, every part unpadded base64url.
// The AAD is `table.column.rowId` (secretAad), so a value copied into another row or column does not open.
//
// New values are sealed with the active key; any key still in the keyring opens what it sealed, so `secrets:rotate`
// can add a key and re-seal the registered columns at its own pace. A value that does not open (malformed, a key
// that is gone, a failed tag: another install's database after a restore without its passphrase) throws
// SECRET_UNREADABLE, which never carries the value, the key or the plaintext.

/** An entry of `config.keyring`: `key` is 32 bytes as unpadded base64url; exactly one entry is active. */
export type KeyringEntry = { kid: string; key: string; active: boolean };

const VERSION = 'v1';
const ALGORITHM = 'aes-256-gcm';
const KEY_BYTES = 32;
const IV_BYTES = 12;
const TAG_BYTES = 16;

/** What a kid may be: it is written between colons (the same rule as config.json's keyring schema). */
const KID = /^[0-9A-Za-z_-]{1,64}$/;

/** `v1:<kid>:<iv>:<ct>`; a 12-byte IV is 16 characters and a ct holds at least the 16-byte tag (22 characters). */
const SEALED = /^v1:([0-9A-Za-z_-]{1,64}):([A-Za-z0-9_-]{16}):([A-Za-z0-9_-]{22,})$/;

type UnreadableReason = 'malformed' | 'unknown_kid' | 'auth_failed';

/** The AAD of the secret in column `column` of row `rowId` of `table`: `table.column.rowId`. */
export function secretAad(table: string, column: string, rowId: string): string {
  return `${table}.${column}.${rowId}`;
}

function unreadable(reason: UnreadableReason, kid?: string, cause?: unknown): DomainError {
  return new DomainError('SECRET_UNREADABLE', {
    detail: 'Nilai rahasia tersimpan tidak dapat dibuka / A stored secret cannot be opened',
    meta: kid === undefined ? { reason } : { reason, kid },
    ...(cause === undefined ? {} : { cause }),
  });
}

/** The 32 key bytes of `entry`. @throws TypeError when the entry is not well formed (a configuration error) */
function keyOf(entry: KeyringEntry, caller: string): Buffer {
  const key = typeof entry.key === 'string' ? decodeBase64Url(entry.key) : null;
  if (typeof entry.kid !== 'string' || !KID.test(entry.kid) || key === null || key.length !== KEY_BYTES) {
    throw new TypeError(`${caller}: keyring entries need a kid of [0-9A-Za-z_-]{1,64} and a 32-byte base64url key`);
  }
  return key;
}

/**
 * `plaintext` (UTF-8) sealed with the keyring's active key and `aad` (see {@link secretAad}): `v1:<kid>:<iv>:<ct>`.
 *
 * @throws TypeError unless the keyring has exactly one active entry and it is well formed (config.json guarantees
 *   both)
 */
export function sealValue(keyring: readonly KeyringEntry[], aad: string, plaintext: string): string {
  const active = keyring.filter((entry) => entry.active);
  if (active.length !== 1) {
    throw new TypeError(`sealValue: the keyring must have exactly one active key, found ${active.length}`);
  }
  const entry = active[0]!;
  const key = keyOf(entry, 'sealValue');
  const iv = randomBytes(IV_BYTES);
  const cipher = createCipheriv(ALGORITHM, key, iv, { authTagLength: TAG_BYTES });
  cipher.setAAD(Buffer.from(aad, 'utf8'));
  const ct = Buffer.concat([cipher.update(plaintext, 'utf8'), cipher.final(), cipher.getAuthTag()]);
  return `${VERSION}:${entry.kid}:${encodeBase64Url(iv)}:${encodeBase64Url(ct)}`;
}

/**
 * The plaintext of `sealed`, opened with the keyring entry it names (active or not) and `aad`.
 *
 * @throws DomainError `SECRET_UNREADABLE` with `meta.reason` `malformed`, `unknown_kid` (the kid is not in the
 *   keyring) or `auth_failed` (wrong key, wrong AAD, or a value that was changed)
 * @throws TypeError when the entry it names is not well formed (a configuration error)
 */
export function openValue(keyring: readonly KeyringEntry[], aad: string, sealed: string): string {
  const m = typeof sealed === 'string' ? SEALED.exec(sealed) : null;
  if (m === null) throw unreadable('malformed');
  const kid = m[1]!;
  const iv = decodeBase64Url(m[2]!);
  const ct = decodeBase64Url(m[3]!);
  if (iv === null || ct === null || iv.length !== IV_BYTES || ct.length < TAG_BYTES) throw unreadable('malformed');
  const entry = keyring.find((candidate) => candidate.kid === kid);
  if (entry === undefined) throw unreadable('unknown_kid', kid);
  const key = keyOf(entry, 'openValue');
  const decipher = createDecipheriv(ALGORITHM, key, iv, { authTagLength: TAG_BYTES });
  decipher.setAAD(Buffer.from(aad, 'utf8'));
  decipher.setAuthTag(ct.subarray(ct.length - TAG_BYTES));
  try {
    return Buffer.concat([decipher.update(ct.subarray(0, ct.length - TAG_BYTES)), decipher.final()]).toString('utf8');
  } catch (error) {
    throw unreadable('auth_failed', kid, error);
  }
}
