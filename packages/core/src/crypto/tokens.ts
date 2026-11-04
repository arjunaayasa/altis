import { createHash, createHmac, randomBytes, timingSafeEqual } from 'node:crypto';
import { encodeBase64Url } from '@altis/crypto';

// Small primitives of the access layer: random tokens (sessions, remember-me, password reset), SHA-256 of what the
// database keeps instead of a token, HMAC (CSRF, device cookie) and constant-time comparison.

/** The HMAC-SHA256 output size in bytes. */
const HMAC_BYTES = 32;

/**
 * `bytes` bytes (default 32, 256 bits) from the operating system's CSPRNG, as unpadded base64url (43 characters
 * for 32 bytes). @throws RangeError unless `bytes` is an integer from 1 to 1024
 */
export function randomToken(bytes = 32): string {
  if (!Number.isSafeInteger(bytes) || bytes < 1 || bytes > 1024) {
    throw new RangeError(`randomToken: bytes must be an integer from 1 to 1024, got ${String(bytes)}`);
  }
  return encodeBase64Url(randomBytes(bytes));
}

/** The SHA-256 of the UTF-8 bytes of `s`, as 64 lower-case hex digits. */
export function sha256hex(s: string): string {
  return createHash('sha256').update(s, 'utf8').digest('hex');
}

/**
 * HMAC-SHA256 of the UTF-8 bytes of `msg`, truncated to its leftmost `bytes` bytes (default all 32), as unpadded
 * base64url.
 *
 * A string `key` is UTF-8 text, as in RFC 4231; it is never decoded. A key held as base64url (the install's
 * `sessionKey`) is passed decoded, as its 32 bytes: `decodeBase64Url(config.secrets.sessionKey)` (M31, D45).
 *
 * @throws RangeError unless `bytes` is an integer from 1 to 32
 */
export function hmacB64u(key: string | Uint8Array, msg: string, bytes: number = HMAC_BYTES): string {
  if (!Number.isSafeInteger(bytes) || bytes < 1 || bytes > HMAC_BYTES) {
    throw new RangeError(`hmacB64u: bytes must be an integer from 1 to ${HMAC_BYTES}, got ${String(bytes)}`);
  }
  const keyBytes = typeof key === 'string' ? Buffer.from(key, 'utf8') : key;
  const mac = createHmac('sha256', keyBytes).update(msg, 'utf8').digest();
  return encodeBase64Url(mac.subarray(0, bytes));
}

/**
 * Whether `a` and `b` are the same string, in time that depends only on their length: the UTF-8 bytes are compared
 * with `timingSafeEqual`. Different lengths (in UTF-8 bytes) are false at once; the length of a token is no secret.
 * Anything but two strings is false.
 */
export function safeEqual(a: string, b: string): boolean {
  if (typeof a !== 'string' || typeof b !== 'string') return false;
  const x = Buffer.from(a, 'utf8');
  const y = Buffer.from(b, 'utf8');
  return x.length === y.length && timingSafeEqual(x, y);
}
