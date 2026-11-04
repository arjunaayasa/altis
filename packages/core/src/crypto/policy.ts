import { DomainError } from '@altis/shared';
import { COMMON_PASSWORDS } from './common-passwords.js';
import { normalizePassword } from './password.js';

// The password policy (spec §7.1, D16), enforced on the server wherever a password is set (change, reset, install,
// CLI): at least 10 characters (security.password_min_length may ask for up to 64), at most 256, and not one of the
// ~10,000 common passwords (SecLists' list plus our Indonesian one, data/), compared case-insensitively. No
// composition rules. Lengths are code points of the NFKC form, the form that is hashed; nothing is ever trimmed.

/** The longest password accepted, in code points after NFKC. */
export const PASSWORD_MAX_LENGTH = 256;

/** The floor of every minimum length (spec §7.1); the instance setting can only raise it. */
export const PASSWORD_MIN_LENGTH = 10;

export type PasswordWeakness = 'too_short' | 'too_long' | 'common';

let common: Set<string> | undefined;

/** Whether `pw` is on the common-password list: NFKC, then lower case (never trimmed). */
export function isCommonPassword(pw: string): boolean {
  common ??= new Set(COMMON_PASSWORDS.split('\n'));
  return common.has(normalizePassword(pw).toLowerCase());
}

/** The code points of `s` (a surrogate pair counts once, a lone surrogate once), without copying it. */
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

function weak(reason: PasswordWeakness, detail: string): DomainError {
  return new DomainError('PASSWORD_TOO_WEAK', { detail, meta: { reason } });
}

/**
 * Throws unless `pw` may be set as a password. `o.minLength` is the instance's minimum
 * (`security.password_min_length`, from {@link PASSWORD_MIN_LENGTH} up).
 *
 * @throws DomainError `PASSWORD_TOO_WEAK` with `meta.reason` `too_short`, `too_long` or `common` (checked in that
 *   order; the message never repeats the password)
 * @throws TypeError when `o.minLength` is not an integer from 10 to {@link PASSWORD_MAX_LENGTH}
 */
export function checkPasswordPolicy(pw: string, o: { minLength: number }): void {
  const { minLength } = o;
  if (!Number.isSafeInteger(minLength) || minLength < PASSWORD_MIN_LENGTH || minLength > PASSWORD_MAX_LENGTH) {
    throw new TypeError(
      `checkPasswordPolicy: minLength must be an integer from ${PASSWORD_MIN_LENGTH} to ${PASSWORD_MAX_LENGTH}, got ${String(minLength)}`,
    );
  }
  const normalized = normalizePassword(pw);
  const length = codePoints(normalized);
  if (length < minLength) {
    throw weak('too_short', `Kata sandi minimal ${minLength} karakter / The password needs at least ${minLength} characters`);
  }
  if (length > PASSWORD_MAX_LENGTH) {
    throw weak(
      'too_long',
      `Kata sandi maksimal ${PASSWORD_MAX_LENGTH} karakter / The password may have at most ${PASSWORD_MAX_LENGTH} characters`,
    );
  }
  if (isCommonPassword(normalized)) {
    throw weak('common', 'Kata sandi ini terlalu umum / This password is too common');
  }
}
