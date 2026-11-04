import { randomBytes } from 'node:crypto';
import { sha256hex } from './tokens.js';

// Codes a person reads, writes down or types by hand, in Crockford's base32 alphabet (0-9 and A-Z without I, L, O
// and U), 5 bits per character:
//
// - recovery codes (spec §7.1: 10 per user, each used once): XXXXX-XXXXX, 50 bits; the database keeps only
//   recoveryCodeHash of the normalized code;
// - temporary passwords (an admin's password reset, the CLI): xxxx-xxxx-xxxx-xxxx in lower case, 80 bits.

const CROCKFORD = '0123456789ABCDEFGHJKMNPQRSTVWXYZ';

/** `length` uniform Crockford characters: each takes the low 5 bits of a random byte (256 is a multiple of 32). */
function crockford(length: number): string {
  const bytes = randomBytes(length);
  let out = '';
  for (const byte of bytes) out += CROCKFORD[byte & 31];
  return out;
}

/** The longest batch generateRecoveryCodes makes. */
const MAX_CODES = 100;

/**
 * `n` (default 10) distinct recovery codes, `XXXXX-XXXXX` in upper-case Crockford (50 bits each).
 * @throws RangeError unless `n` is an integer from 1 to 100
 */
export function generateRecoveryCodes(n = 10): string[] {
  if (!Number.isSafeInteger(n) || n < 1 || n > MAX_CODES) {
    throw new RangeError(`generateRecoveryCodes: n must be an integer from 1 to ${MAX_CODES}, got ${String(n)}`);
  }
  const codes = new Set<string>();
  while (codes.size < n) {
    const code = crockford(10);
    codes.add(`${code.slice(0, 5)}-${code.slice(5)}`);
  }
  return [...codes];
}

/**
 * The 10 characters of a recovery code as typed, or null when it is not one: NFKC (full-width input from a phone
 * keyboard), upper case, white space and dashes removed (`-`, and the Unicode dashes and minus sign that
 * autocorrect makes of it), `I` and `L` read as `1` and `O` as `0` (Crockford's decoding); what remains must be
 * exactly 10 Crockford characters.
 */
export function normalizeRecoveryCode(s: string): string | null {
  if (typeof s !== 'string') return null;
  const normalized = s
    .normalize('NFKC')
    .toUpperCase()
    .replace(/[\s\-‐-―−]+/g, '')
    .replace(/[IL]/g, '1')
    .replace(/O/g, '0');
  return /^[0-9A-HJKMNP-TV-Z]{10}$/.test(normalized) ? normalized : null;
}

/** What the database keeps of a recovery code: `sha256hex(userId + ':' + normalized)` (normalizeRecoveryCode). */
export function recoveryCodeHash(userId: string, normalized: string): string {
  return sha256hex(`${userId}:${normalized}`);
}

/** A temporary password, `xxxx-xxxx-xxxx-xxxx` in lower-case Crockford (80 bits); it passes the password policy. */
export function temporaryPassword(): string {
  const chars = crockford(16).toLowerCase();
  return `${chars.slice(0, 4)}-${chars.slice(4, 8)}-${chars.slice(8, 12)}-${chars.slice(12)}`;
}
