import { createHash } from 'node:crypto';
import fsp from 'node:fs/promises';
import path from 'node:path';
import { isDomainError } from '@altis/shared';
import { describe, expect, it } from 'vitest';
import { buildCommonPasswords, LIST_FILES } from '../scripts/gen-common-passwords.js';
import { COMMON_PASSWORDS } from '../src/crypto/common-passwords.js';
import { PASSWORD_MAX_LENGTH, checkPasswordPolicy, isCommonPassword } from '../src/crypto/policy.js';

// The password policy (spec §7.1, D16): at least 10 characters (the instance may ask for more), at most 256, and not
// one of the ~10,000 common passwords of SecLists plus our Indonesian list, compared case-insensitively. Lengths are
// code points after NFKC; no composition rules.

const PACKAGE = path.resolve(import.meta.dirname, '..');

/** The `meta.reason` of the PASSWORD_TOO_WEAK that `pw` is refused with, or null when it passes. */
function refusal(pw: string, minLength = 10): string | null {
  try {
    checkPasswordPolicy(pw, { minLength });
    return null;
  } catch (error) {
    if (!isDomainError(error) || error.code !== 'PASSWORD_TOO_WEAK') throw error;
    expect(error.status).toBe(422);
    return String(error.meta?.['reason']);
  }
}

describe('checkPasswordPolicy', () => {
  it('refuses fewer than 10 characters as too_short', () => {
    expect('abcdefghi').toHaveLength(9);
    expect(refusal('abcdefghi')).toBe('too_short');
    expect(refusal('')).toBe('too_short');
  });

  it('refuses common passwords whatever their case (SecLists and the Indonesian list)', () => {
    expect(refusal('1234567890')).toBe('common');
    expect(refusal('QwertyUIOP')).toBe('common');
    expect(refusal('perpustakaan')).toBe('common');
    expect(refusal('PerpusTakaan')).toBe('common');
    expect(refusal('bismillah123')).toBe('common');
    expect(refusal('ｐｅｒｐｕｓｔａｋａａｎ')).toBe('common'); // full-width
  });

  it('refuses more than 256 characters as too_long', () => {
    expect(PASSWORD_MAX_LENGTH).toBe(256);
    expect(refusal('kuda-lumping-biru-'.repeat(15).slice(0, 257))).toBe('too_long');
    expect(refusal('kuda-lumping-biru-'.repeat(15).slice(0, 256))).toBeNull();
  });

  it("applies the instance's minimum length when it asks for more", () => {
    expect(refusal('kuda-lumpin', 12)).toBe('too_short'); // 11
    expect(refusal('kuda-lumping', 12)).toBeNull(); // 12
  });

  it('passes kuda-lumping-biru', () => {
    expect(refusal('kuda-lumping-biru')).toBeNull();
    expect(() => checkPasswordPolicy('kuda-lumping-biru', { minLength: 10 })).not.toThrow();
  });

  it('counts code points after NFKC, not UTF-16 units', () => {
    expect(refusal('\u{1F40E}'.repeat(10))).toBeNull(); // 10 horses, 20 UTF-16 units
    expect(refusal('\u{1F40E}'.repeat(9))).toBe('too_short');
    expect(refusal('é'.repeat(5))).toBe('too_short'); // 10 units, 5 characters once composed
    expect(refusal('\u{1F40E}'.repeat(256))).toBeNull();
    expect(refusal('\u{1F40E}'.repeat(257))).toBe('too_long');
  });

  it('never trims: spaces count as characters', () => {
    expect(refusal('   kuda   ')).toBeNull();
    expect(refusal(' abcdefgh')).toBe('too_short');
  });

  it('refuses a minimum below 10 or not an integer as a programming error', () => {
    for (const minLength of [9, 0, 10.5, Number.NaN, PASSWORD_MAX_LENGTH + 1]) {
      expect(() => checkPasswordPolicy('kuda-lumping-biru', { minLength }), String(minLength)).toThrow(TypeError);
    }
  });
});

describe('isCommonPassword', () => {
  it('is case-insensitive and applies NFKC, never trimming', () => {
    expect(isCommonPassword('password')).toBe(true);
    expect(isCommonPassword('PASSWORD')).toBe(true);
    expect(isCommonPassword('ｐassword')).toBe(true);
    expect(isCommonPassword(' password')).toBe(false);
    expect(isCommonPassword('kuda-lumping-biru')).toBe(false);
    expect(isCommonPassword('sayangkamu')).toBe(true);
    expect(isCommonPassword('merdeka45')).toBe(true);
  });
});

describe('the common-password list', () => {
  async function lists(): Promise<string[]> {
    return Promise.all(LIST_FILES.map((file) => fsp.readFile(path.join(PACKAGE, file), 'utf8')));
  }

  it('src/crypto/common-passwords.ts is what scripts/gen-common-passwords.ts makes of data/*.txt', async () => {
    expect(COMMON_PASSWORDS).toBe(buildCommonPasswords(await lists()));
  });

  it('holds about 10,000 lower-cased entries, each once, and 30 or more Indonesian ones', async () => {
    const entries = COMMON_PASSWORDS.split('\n');
    expect(entries.length).toBeGreaterThan(9_500);
    expect(new Set(entries).size).toBe(entries.length);
    for (const e of entries) {
      expect(e, JSON.stringify(e)).not.toBe('');
      expect(e).toBe(e.normalize('NFKC').toLowerCase());
    }
    const indonesian = (await lists())[1]!.split('\n').filter((line) => line !== '');
    expect(indonesian.length).toBeGreaterThanOrEqual(30);
    for (const pw of indonesian) expect(isCommonPassword(pw), pw).toBe(true);
  });

  it('data/common-passwords.txt is the SecLists file recorded in data/README.md (SHA-256)', async () => {
    const readme = await fsp.readFile(path.join(PACKAGE, 'data', 'README.md'), 'utf8');
    const recorded = /SHA-256[^`\n]*`([0-9a-f]{64})`/.exec(readme)?.[1];
    if (recorded === undefined) expect.fail('data/README.md must record the SHA-256 of common-passwords.txt as a `<64 hex>` span');
    const bytes = await fsp.readFile(path.join(PACKAGE, 'data', 'common-passwords.txt'));
    expect(createHash('sha256').update(bytes).digest('hex')).toBe(recorded);
    expect(readme).toMatch(/\/commit\/[0-9a-f]{40}\b|\b[0-9a-f]{40}\b/); // the pinned SecLists commit
    await expect(fsp.readFile(path.join(PACKAGE, 'data', 'LICENSE-SecLists.txt'), 'utf8')).resolves.toMatch(/MIT/);
  });
});
