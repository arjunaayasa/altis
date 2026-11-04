import { createHash } from 'node:crypto';
import { describe, expect, it } from 'vitest';
import {
  generateRecoveryCodes,
  normalizeRecoveryCode,
  recoveryCodeHash,
  temporaryPassword,
} from '../src/crypto/codes.js';
import { checkPasswordPolicy } from '../src/crypto/policy.js';

// Recovery codes (10 per user, 50 bits each) and temporary passwords (80 bits) in Crockford's base32 alphabet:
// 0-9 and A-Z without I, L, O and U, so that what a librarian reads aloud or copies by hand survives.

const CROCKFORD = '0123456789ABCDEFGHJKMNPQRSTVWXYZ';
const RECOVERY_CODE = /^[0-9A-HJKMNP-TV-Z]{5}-[0-9A-HJKMNP-TV-Z]{5}$/;
const TEMPORARY_PASSWORD = /^[0-9a-hjkmnp-tv-z]{4}(-[0-9a-hjkmnp-tv-z]{4}){3}$/;

describe('generateRecoveryCodes', () => {
  it('gives 10 unique codes XXXXX-XXXXX by default', () => {
    const codes = generateRecoveryCodes();
    expect(codes).toHaveLength(10);
    expect(new Set(codes).size).toBe(10);
    for (const code of codes) expect(code).toMatch(RECOVERY_CODE);
  });

  it('takes the number of codes', () => {
    expect(generateRecoveryCodes(3)).toHaveLength(3);
    for (const n of [0, -1, 1.5, 101]) expect(() => generateRecoveryCodes(n), String(n)).toThrow(RangeError);
  });

  it('uses the whole Crockford alphabet', () => {
    const seen = new Set(Array.from({ length: 100 }, () => generateRecoveryCodes().join('')).join('').replace(/-/g, ''));
    expect([...seen].sort().join('')).toBe(CROCKFORD);
  });

  it('normalizes each code to its 10 characters', () => {
    for (const code of generateRecoveryCodes()) {
      expect(normalizeRecoveryCode(code)).toBe(code.replace('-', ''));
      expect(normalizeRecoveryCode(code.toLowerCase())).toBe(code.replace('-', ''));
    }
  });
});

describe('normalizeRecoveryCode', () => {
  it('upper-cases and removes spaces and dashes', () => {
    expect(normalizeRecoveryCode('abcde fghjk')).toBe('ABCDEFGHJK');
    expect(normalizeRecoveryCode('ABCDE-FGHJK')).toBe('ABCDEFGHJK');
    expect(normalizeRecoveryCode('  ab-cde fg hjk  ')).toBe('ABCDEFGHJK');
    expect(normalizeRecoveryCode('abcde\tfghjk\n')).toBe('ABCDEFGHJK');
    expect(normalizeRecoveryCode('abcde–fghjk')).toBe('ABCDEFGHJK'); // an en dash from autocorrect
    expect(normalizeRecoveryCode('abcde fghjk')).toBe('ABCDEFGHJK'); // a no-break space
  });

  it('reads I and L as 1 and O as 0', () => {
    expect(normalizeRecoveryCode('ilo00-00000')).toBe('1100000000');
    expect(normalizeRecoveryCode('ILOil-LOoOo')).toBe('1101110000');
  });

  it('accepts what a phone keyboard types in full width', () => {
    expect(normalizeRecoveryCode('ａｂｃｄｅ－ｆｇｈｊｋ')).toBe('ABCDEFGHJK');
  });

  it('refuses anything but exactly 10 Crockford characters', () => {
    expect(normalizeRecoveryCode('abcde-fghj')).toBeNull(); // 9
    expect(normalizeRecoveryCode('abcde-fghjkm')).toBeNull(); // 11
    expect(normalizeRecoveryCode('')).toBeNull();
    expect(normalizeRecoveryCode('abcde-fghju')).toBeNull(); // U is not Crockford
    expect(normalizeRecoveryCode('abcde_fghjk')).toBeNull();
    expect(normalizeRecoveryCode('abcde.fghjk')).toBeNull();
    expect(normalizeRecoveryCode(null as unknown as string)).toBeNull();
  });
});

describe('recoveryCodeHash', () => {
  it("is sha256hex(userId + ':' + normalized)", () => {
    const userId = '01JBX3Q5N2V8W9YZ0ABCDEFGHJ';
    const expected = createHash('sha256').update(`${userId}:ABCDEFGHJK`, 'utf8').digest('hex');
    expect(recoveryCodeHash(userId, 'ABCDEFGHJK')).toBe(expected);
    expect(recoveryCodeHash('01JBX3Q5N2V8W9YZ0ABCDEFGHK', 'ABCDEFGHJK')).not.toBe(expected);
  });
});

describe('temporaryPassword', () => {
  it('is xxxx-xxxx-xxxx-xxxx in lower-case Crockford and passes the password policy', () => {
    const passwords = new Set<string>();
    for (let i = 0; i < 200; i += 1) {
      const pw = temporaryPassword();
      expect(pw).toMatch(TEMPORARY_PASSWORD);
      expect(() => checkPasswordPolicy(pw, { minLength: 10 })).not.toThrow();
      passwords.add(pw);
    }
    expect(passwords.size).toBe(200);
  });

  it('uses the whole lower-case Crockford alphabet', () => {
    const seen = new Set(Array.from({ length: 200 }, () => temporaryPassword()).join('').replace(/-/g, ''));
    expect([...seen].sort().join('')).toBe(CROCKFORD.toLowerCase());
  });
});
