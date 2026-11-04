import { createCipheriv, createDecipheriv, hkdfSync, randomBytes, scrypt as scryptCallback } from 'node:crypto';
import { decodeBase64Url, encodeBase64Url } from '@altis/crypto';
import { DomainError } from '@altis/shared';

// The key hierarchy of an encrypted `.altisbak` (spec §9.9, decision C13):
//
//   KEK        = scrypt(NFKC(passphrase), salt, N = 2^16, r = 8, p = 1, 32 bytes)   64 MiB, inside P11's 300 MB
//   DEK        = 32 random bytes per archive, wrapped: AES-256-GCM(KEK, random 12-byte IV, AAD 'altis-backup/1 dek')
//   STREAM key = the DEK itself (stream-cipher.ts): it encrypts nothing else
//   column key = HKDF-SHA256(DEK, empty salt, 'altis-backup/1 columns', 32): re-seals the secret columns (TOTP
//                secrets, secret settings) as `v1:archive:<iv>:<ct>`, with the same AAD as the keyring seal
//                (`table.column.rowId`), so a restore into another installation (branch b) can open them with the
//                passphrase alone
//
// The passphrase is NFKC-normalized (the same passphrase typed on another keyboard or OS, NFC or NFD, gives the
// same key), never trimmed (a space is part of it), and has at least 10 code points. scrypt is deliberately slow
// and must never run inside a re-runnable transaction (S18): derive the KEK first, then open the transaction.

/** scrypt parameters of the KEK; `maxmem` leaves room above the 128 · N · r = 64 MiB scrypt needs. */
export const ARCHIVE_SCRYPT = Object.freeze({ N: 65536, r: 8, p: 1, keylen: 32, maxmem: 134_217_728 });
/** The KDF salt drawn for every archive (stored in the clear header as base64url). */
export const ARCHIVE_SALT_BYTES = 16;
/** The data encryption key of an archive. */
export const DEK_BYTES = 32;
/** The fewest code points (after NFKC) a passphrase may have. */
export const PASSPHRASE_MIN_CODE_POINTS = 10;

const KEY_BYTES = 32;
const IV_BYTES = 12;
const TAG_BYTES = 16;
const DEK_WRAP_AAD = 'altis-backup/1 dek';
const COLUMN_KEY_INFO = 'altis-backup/1 columns';
const LONE_SURROGATE = /[\uD800-\uDBFF](?![\uDC00-\uDFFF])|(?<![\uD800-\uDBFF])[\uDC00-\uDFFF]/;
/** `v1:archive:<12-byte IV, 16 chars>:<ciphertext ‖ tag, at least 22 chars>`, unpadded base64url. */
const ARCHIVE_SEALED = /^v1:archive:([A-Za-z0-9_-]{16}):([A-Za-z0-9_-]{22,})$/;

function checkKey(key: Uint8Array, what: string, caller: string): void {
  if (!(key instanceof Uint8Array) || key.byteLength !== KEY_BYTES) {
    throw new TypeError(`${caller}: the ${what} must be ${KEY_BYTES} bytes`);
  }
}

function passphraseError(code: 'too_small' | 'invalid_string' | 'invalid_type'): DomainError {
  const detail =
    code === 'too_small'
      ? `Frasa sandi arsip minimal ${PASSPHRASE_MIN_CODE_POINTS} karakter / The archive passphrase needs at least ${PASSPHRASE_MIN_CODE_POINTS} characters`
      : 'Frasa sandi arsip tidak valid / The archive passphrase is not valid';
  return new DomainError('VALIDATION_FAILED', { detail, meta: { errors: [{ path: 'passphrase', code }] } });
}

/** The number of code points of `s` (a surrogate pair counts once), without copying it. */
function codePoints(s: string): number {
  let n = 0;
  for (let i = 0; i < s.length; i += 1) {
    const unit = s.charCodeAt(i);
    if (unit >= 0xd800 && unit <= 0xdbff && i + 1 < s.length) {
      const next = s.charCodeAt(i + 1);
      if (next >= 0xdc00 && next <= 0xdfff) i += 1;
    }
    n += 1;
  }
  return n;
}

function scrypt(password: Uint8Array, salt: Uint8Array): Promise<Buffer> {
  const { N, r, p, keylen, maxmem } = ARCHIVE_SCRYPT;
  return new Promise((resolve, reject) => {
    scryptCallback(password, salt, keylen, { N, r, p, maxmem }, (error, key) => (error ? reject(error) : resolve(key)));
  });
}

/**
 * The key-encryption key of an archive: scrypt ({@link ARCHIVE_SCRYPT}) of the NFKC form of `passphrase` (UTF-8),
 * never trimmed, with `salt`. Slow on purpose (about a tenth of a second and 64 MiB): call it outside any transaction.
 *
 * @throws DomainError VALIDATION_FAILED (`errors: [{path: 'passphrase', code}]`): `too_small` below 10 code points
 *   after NFKC, `invalid_string` for a lone surrogate, `invalid_type` for anything but a string
 * @throws TypeError for a salt that is not 16 bytes
 */
export async function deriveKek(passphrase: string, salt: Uint8Array): Promise<Uint8Array> {
  if (typeof passphrase !== 'string') throw passphraseError('invalid_type');
  if (LONE_SURROGATE.test(passphrase)) throw passphraseError('invalid_string');
  const normalized = passphrase.normalize('NFKC');
  if (codePoints(normalized) < PASSPHRASE_MIN_CODE_POINTS) throw passphraseError('too_small');
  if (!(salt instanceof Uint8Array) || salt.byteLength !== ARCHIVE_SALT_BYTES) {
    throw new TypeError(`deriveKek: the salt must be ${ARCHIVE_SALT_BYTES} bytes`);
  }
  return new Uint8Array(await scrypt(Buffer.from(normalized, 'utf8'), salt));
}

/** A new random KDF salt ({@link ARCHIVE_SALT_BYTES} bytes). */
export function newArchiveSalt(): Uint8Array {
  return new Uint8Array(randomBytes(ARCHIVE_SALT_BYTES));
}

/** A new random DEK ({@link DEK_BYTES} bytes). */
export function newDek(): Uint8Array {
  return new Uint8Array(randomBytes(DEK_BYTES));
}

/**
 * `dek` wrapped with `kek`: AES-256-GCM with a fresh 12-byte IV and AAD `'altis-backup/1 dek'`; `ct` = ciphertext ‖
 * tag. Both as unpadded base64url (the header's `encryption.dek`).
 *
 * @throws TypeError unless both keys are 32 bytes
 */
export function wrapDek(kek: Uint8Array, dek: Uint8Array): { iv: string; ct: string } {
  checkKey(kek, 'KEK', 'wrapDek');
  checkKey(dek, 'DEK', 'wrapDek');
  const iv = randomBytes(IV_BYTES);
  const cipher = createCipheriv('aes-256-gcm', kek, iv, { authTagLength: TAG_BYTES });
  cipher.setAAD(Buffer.from(DEK_WRAP_AAD, 'utf8'));
  const ct = Buffer.concat([cipher.update(dek), cipher.final(), cipher.getAuthTag()]);
  return { iv: encodeBase64Url(iv), ct: encodeBase64Url(ct) };
}

function wrongPassphrase(): DomainError {
  return new DomainError('BACKUP_PASSPHRASE_INVALID', {
    detail: 'Frasa sandi tidak membuka arsip ini / The passphrase does not open this archive',
  });
}

/**
 * The DEK that {@link wrapDek} wrapped with `kek`.
 *
 * @throws DomainError BACKUP_PASSPHRASE_INVALID when it does not open (another passphrase, a damaged wrap)
 * @throws TypeError for a KEK that is not 32 bytes
 */
export function unwrapDek(kek: Uint8Array, w: { iv: string; ct: string }): Uint8Array {
  checkKey(kek, 'KEK', 'unwrapDek');
  const iv = typeof w?.iv === 'string' ? decodeBase64Url(w.iv) : null;
  const ct = typeof w?.ct === 'string' ? decodeBase64Url(w.ct) : null;
  if (iv === null || ct === null || iv.byteLength !== IV_BYTES || ct.byteLength !== DEK_BYTES + TAG_BYTES) {
    throw wrongPassphrase();
  }
  const decipher = createDecipheriv('aes-256-gcm', kek, iv, { authTagLength: TAG_BYTES });
  decipher.setAAD(Buffer.from(DEK_WRAP_AAD, 'utf8'));
  decipher.setAuthTag(ct.subarray(DEK_BYTES));
  try {
    return new Uint8Array(Buffer.concat([decipher.update(ct.subarray(0, DEK_BYTES)), decipher.final()]));
  } catch {
    throw wrongPassphrase();
  }
}

/**
 * The column key of an archive: HKDF-SHA256(dek, empty salt, info `'altis-backup/1 columns'`, 32 bytes).
 *
 * @throws TypeError for a DEK that is not 32 bytes
 */
export function columnKey(dek: Uint8Array): Uint8Array {
  checkKey(dek, 'DEK', 'columnKey');
  return new Uint8Array(hkdfSync('sha256', dek, new Uint8Array(0), COLUMN_KEY_INFO, KEY_BYTES));
}

/**
 * `plaintext` (UTF-8) sealed with the column key and `aad` (`table.column.rowId`, as secretAad builds it):
 * `v1:archive:<iv>:<ct>` (AES-256-GCM, fresh 12-byte IV, ct = ciphertext ‖ tag, unpadded base64url).
 *
 * @throws TypeError for a column key that is not 32 bytes
 */
export function sealArchiveValue(key: Uint8Array, aad: string, plaintext: string): string {
  checkKey(key, 'column key', 'sealArchiveValue');
  const iv = randomBytes(IV_BYTES);
  const cipher = createCipheriv('aes-256-gcm', key, iv, { authTagLength: TAG_BYTES });
  cipher.setAAD(Buffer.from(aad, 'utf8'));
  const ct = Buffer.concat([cipher.update(plaintext, 'utf8'), cipher.final(), cipher.getAuthTag()]);
  return `v1:archive:${encodeBase64Url(iv)}:${encodeBase64Url(ct)}`;
}

function unreadable(reason: 'malformed' | 'auth_failed'): DomainError {
  return new DomainError('SECRET_UNREADABLE', {
    detail: 'Nilai rahasia dalam arsip tidak dapat dibuka / A secret in the archive cannot be opened',
    meta: { reason, kid: 'archive' },
  });
}

/**
 * The plaintext of a value sealed by {@link sealArchiveValue} with the same column key and AAD.
 *
 * @throws DomainError SECRET_UNREADABLE (`kid: 'archive'`) with `reason` `malformed` (not a `v1:archive:` value) or
 *   `auth_failed` (another key or AAD, or a changed value); it never carries the value or the plaintext
 * @throws TypeError for a column key that is not 32 bytes
 */
export function openArchiveValue(key: Uint8Array, aad: string, sealed: string): string {
  checkKey(key, 'column key', 'openArchiveValue');
  const m = typeof sealed === 'string' ? ARCHIVE_SEALED.exec(sealed) : null;
  const iv = m === null ? null : decodeBase64Url(m[1]!);
  const ct = m === null ? null : decodeBase64Url(m[2]!);
  if (iv === null || ct === null || iv.byteLength !== IV_BYTES || ct.byteLength < TAG_BYTES) throw unreadable('malformed');
  const decipher = createDecipheriv('aes-256-gcm', key, iv, { authTagLength: TAG_BYTES });
  decipher.setAAD(Buffer.from(aad, 'utf8'));
  decipher.setAuthTag(ct.subarray(ct.byteLength - TAG_BYTES));
  try {
    return Buffer.concat([decipher.update(ct.subarray(0, ct.byteLength - TAG_BYTES)), decipher.final()]).toString('utf8');
  } catch {
    throw unreadable('auth_failed');
  }
}
