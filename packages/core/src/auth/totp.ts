import { createHmac, randomBytes } from 'node:crypto';
import { safeEqual } from '../crypto/tokens.js';

// Staff two-factor authentication (spec §7.1): TOTP, RFC 6238 over HOTP (RFC 4226) with HMAC-SHA1, 30-second steps,
// 6 digits and a 20-byte secret, the parameters every authenticator app reads from an otpauth:// URI. A code is
// accepted for the current step and one step either side (clock drift), and never twice: matchTotp only accepts a
// step after the user's `totp_last_step`, and the caller stores the matched step with
//
//   UPDATE staff_users SET totp_last_step = :step WHERE id = :id AND totp_last_step < :step
//
// where 0 rows updated means the code was replayed (by a parallel request).

export const TOTP = { periodS: 30, digits: 6, secretBytes: 20, window: 1 } as const;

const PERIOD_MS = TOTP.periodS * 1000;

/**
 * The HOTP value (RFC 4226 §5.3) of `secret` at `counter`: HMAC-SHA1 of the counter as 8 big-endian bytes, dynamic
 * truncation, the last `digits` decimal digits with leading zeros.
 *
 * @throws RangeError unless `counter` is a safe integer ≥ 0 and `digits` an integer from 6 to 8 (RFC 4226 §5.3)
 */
export function hotp(secret: Uint8Array, counter: number, digits: number): string {
  if (!Number.isSafeInteger(counter) || counter < 0) {
    throw new RangeError(`hotp: counter must be a safe integer of at least 0, got ${String(counter)}`);
  }
  if (!Number.isSafeInteger(digits) || digits < 6 || digits > 8) {
    throw new RangeError(`hotp: digits must be an integer from 6 to 8, got ${String(digits)}`);
  }
  const message = Buffer.alloc(8);
  message.writeBigUInt64BE(BigInt(counter));
  const mac = createHmac('sha1', secret).update(message).digest();
  const offset = mac[mac.length - 1]! & 0x0f;
  const binary =
    ((mac[offset]! & 0x7f) << 24) | (mac[offset + 1]! << 16) | (mac[offset + 2]! << 8) | mac[offset + 3]!;
  return String(binary % 10 ** digits).padStart(digits, '0');
}

/** The TOTP time step of `nowMs` (Unix milliseconds): `floor(nowMs / 30 000)`. */
export function totpStep(nowMs: number): number {
  return Math.floor(nowMs / PERIOD_MS);
}

/** A new TOTP secret: 20 bytes (160 bits, RFC 4226 §4's recommendation) from the CSPRNG. */
export function generateTotpSecret(): Uint8Array {
  return new Uint8Array(randomBytes(TOTP.secretBytes));
}

// ---------------------------------------------------------------------------------------------------------------
// Base32 (RFC 4648 §6), the form an authenticator app takes a secret in

const BASE32 = 'ABCDEFGHIJKLMNOPQRSTUVWXYZ234567';

/** `b` in base32 (RFC 4648), upper case, without padding. */
export function base32Encode(b: Uint8Array): string {
  let out = '';
  let bits = 0;
  let value = 0;
  for (const byte of b) {
    value = ((value << 8) | byte) & 0xffff;
    bits += 8;
    while (bits >= 5) {
      out += BASE32[(value >>> (bits - 5)) & 31];
      bits -= 5;
    }
  }
  if (bits > 0) out += BASE32[(value << (5 - bits)) & 31];
  return out;
}

/** The 5-bit value of an ASCII base32 letter or digit of either case, or -1 (never toUpperCase: 'ı' would pass). */
function base32Value(code: number): number {
  if (code >= 0x41 && code <= 0x5a) return code - 0x41; // A-Z
  if (code >= 0x61 && code <= 0x7a) return code - 0x61; // a-z
  if (code >= 0x32 && code <= 0x37) return code - 0x32 + 26; // 2-7
  return -1;
}

/**
 * The bytes of base32 text `s` (RFC 4648), case-insensitive, ignoring white space and `=` wherever they are; bits
 * left over after the last whole byte are dropped.
 *
 * @throws TypeError on any other character
 */
export function base32Decode(s: string): Uint8Array {
  const out: number[] = [];
  let bits = 0;
  let value = 0;
  for (const char of s) {
    if (char === '=' || /\s/.test(char)) continue;
    const v = base32Value(char.charCodeAt(0));
    if (v < 0) throw new TypeError('base32Decode: not base32 text (RFC 4648)');
    value = ((value << 5) | v) & 0xffff;
    bits += 5;
    if (bits >= 8) {
      out.push((value >>> (bits - 8)) & 0xff);
      bits -= 8;
    }
  }
  return Uint8Array.from(out);
}

// ---------------------------------------------------------------------------------------------------------------

/**
 * The step whose code `code` is, among the steps s-1, s and s+1 around `nowMs` (the largest when several match),
 * provided it comes after `lastStep`; otherwise null (a wrong code, out of the window, or a replay). Anything but 6
 * ASCII digits is null. All three codes are computed and compared, so the time taken does not tell which matched.
 *
 * The caller stores the returned step with `UPDATE … WHERE totp_last_step < :step` (0 rows: a replay).
 */
export function matchTotp(secret: Uint8Array, code: string, nowMs: number, lastStep: number): number | null {
  if (typeof code !== 'string' || !/^\d{6}$/.test(code)) return null;
  const s = totpStep(nowMs);
  let matched: number | undefined;
  for (let step = s - TOTP.window; step <= s + TOTP.window; step += 1) {
    // No step before the epoch; only a clock at 1970-01-01 00:00 asks for one.
    const hit = step >= 0 && safeEqual(hotp(secret, step, TOTP.digits), code);
    if (hit) matched = step;
  }
  return matched !== undefined && matched > lastStep ? matched : null;
}

/**
 * The Key URI an authenticator app reads (as a QR code) for `secret`:
 * `otpauth://totp/<issuer>:<account>?secret=<base32>&issuer=<issuer>&algorithm=SHA1&digits=6&period=30`, issuer and
 * account percent-encoded (a colon in either included).
 */
export function otpauthUri(o: { issuer: string; account: string; secret: Uint8Array }): string {
  const issuer = encodeURIComponent(o.issuer);
  const account = encodeURIComponent(o.account);
  return (
    `otpauth://totp/${issuer}:${account}?secret=${base32Encode(o.secret)}&issuer=${issuer}` +
    `&algorithm=SHA1&digits=${TOTP.digits}&period=${TOTP.periodS}`
  );
}
