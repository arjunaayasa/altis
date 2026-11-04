import { describe, expect, it } from 'vitest';
import {
  branchCodeField,
  emailField,
  idempotencyKeyField,
  localeField,
  passwordField,
  personNameField,
  timezoneField,
  ulidField,
  usernameField,
  versionField,
} from '../src/api/common.js';
import { newId } from '../src/ids.js';

// Zod maximum lengths equal the column widths (L36); a string field counts characters (code points), like the
// VARCHAR columns, except passwordField, which counts UTF-16 units (M21).
const accepts = (schema: { safeParse: (v: unknown) => { success: boolean } }, value: unknown) => schema.safeParse(value).success;

describe('usernameField (S12: NFKC and trim first, then 3-64 of letters, digits, . _ -)', () => {
  it('trims and keeps case (the key is derived elsewhere)', () => {
    expect(usernameField.parse(' Budi ')).toBe('Budi');
  });

  it('folds full-width and decomposed input before the checks (phone keyboards, macOS)', () => {
    expect(usernameField.parse('ｂｕｄｉ')).toBe('budi');
    expect(usernameField.parse('　Budi　')).toBe('Budi');
    expect(usernameField.parse('Café')).toBe('Café');
  });

  it('refuses 2 characters, inner whitespace and 65 characters', () => {
    expect(accepts(usernameField, 'ab')).toBe(false);
    expect(accepts(usernameField, ' ab ')).toBe(false);
    expect(accepts(usernameField, 'budi santoso')).toBe(false);
    expect(accepts(usernameField, 'budi\tsantoso')).toBe(false);
    expect(accepts(usernameField, 'a'.repeat(65))).toBe(false);
    expect(accepts(usernameField, '')).toBe(false);
    expect(accepts(usernameField, '   ')).toBe(false);
  });

  it('accepts the boundaries 3 and 64', () => {
    expect(usernameField.parse('abc')).toBe('abc');
    expect(usernameField.parse('a'.repeat(64))).toBe('a'.repeat(64));
  });

  it('accepts letters of any script, digits and . _ -', () => {
    expect(usernameField.parse('budi.santoso_01-x')).toBe('budi.santoso_01-x');
    expect(accepts(usernameField, '王小明')).toBe(true);
  });

  it('refuses other punctuation, control and invisible characters', () => {
    for (const bad of ['bu@di', 'bu/di', 'bu,di', "bu'di", 'bu\u0000di', 'bu​di', 'bu‮di', 'budi!']) {
      expect(accepts(usernameField, bad), JSON.stringify(bad)).toBe(false);
    }
  });

  it('counts characters, not UTF-16 units: 64 astral letters fit, 65 do not', () => {
    const astral = '\u{1d49c}'; // MATHEMATICAL SCRIPT CAPITAL A... NFKC folds it to "A"
    expect(usernameField.parse(astral.repeat(64))).toBe('A'.repeat(64));
    expect(accepts(usernameField, astral.repeat(65))).toBe(false);
    const han = '\u{20bb7}'; // a letter outside the BMP that NFKC keeps
    expect(accepts(usernameField, han.repeat(64))).toBe(true);
    expect(accepts(usernameField, han.repeat(65))).toBe(false);
    expect(accepts(usernameField, han.repeat(2))).toBe(false);
    expect(accepts(usernameField, han.repeat(3))).toBe(true);
  });

  it('refuses non-strings', () => {
    expect(accepts(usernameField, 12345)).toBe(false);
    expect(accepts(usernameField, null)).toBe(false);
    expect(accepts(usernameField, undefined)).toBe(false);
  });
});

describe('personNameField (1-191 characters, trimmed, no control characters)', () => {
  it('trims, so a trailing newline from a paste is not a control character', () => {
    expect(personNameField.parse('  Budi Santoso  ')).toBe('Budi Santoso');
    expect(personNameField.parse('Budi Santoso\r\n')).toBe('Budi Santoso');
  });

  it('refuses empty and blank names', () => {
    expect(accepts(personNameField, '')).toBe(false);
    expect(accepts(personNameField, '   ')).toBe(false);
  });

  it('accepts 191 characters and refuses 192', () => {
    expect(accepts(personNameField, 'n'.repeat(191))).toBe(true);
    expect(accepts(personNameField, 'n'.repeat(192))).toBe(false);
  });

  it('counts characters, not UTF-16 units', () => {
    expect(accepts(personNameField, '\u{20bb7}'.repeat(191))).toBe(true);
    expect(accepts(personNameField, '\u{20bb7}'.repeat(192))).toBe(false);
  });

  it('refuses control characters (C0, DEL, C1) anywhere', () => {
    for (const bad of ['Bu\ndi', 'Bu\tdi', 'Bu\u0000di', 'Bu\u007fdi', 'Bu\u0085di', 'Bu\u009fdi', 'Bu\rdi']) {
      expect(accepts(personNameField, bad), JSON.stringify(bad)).toBe(false);
    }
  });

  it('keeps inner spaces and ordinary punctuation', () => {
    expect(personNameField.parse("Siti Nur O'Brien-Lee, S.Pd.")).toBe("Siti Nur O'Brien-Lee, S.Pd.");
  });
});

describe('emailField (at most 191, z.email())', () => {
  it('accepts an address and refuses what is not one', () => {
    expect(emailField.parse('budi@example.com')).toBe('budi@example.com');
    for (const bad of ['', 'budi', 'budi@', '@example.com', 'budi@example', 'bu di@example.com']) {
      expect(accepts(emailField, bad), JSON.stringify(bad)).toBe(false);
    }
  });

  it('refuses more than 191 characters', () => {
    const local = 'a'.repeat(60);
    const long = `${local}@${'b'.repeat(63)}.${'c'.repeat(63)}.example.com`; // 60 + 1 + 63 + 1 + 63 + 1 + 11 = 200
    expect(long.length).toBeGreaterThan(191);
    expect(accepts(emailField, long)).toBe(false);
    const fits = `${local}@${'b'.repeat(63)}.${'c'.repeat(50)}.com`; // 60 + 1 + 63 + 1 + 50 + 4 = 179
    expect(fits.length).toBeLessThanOrEqual(191);
    expect(accepts(emailField, fits)).toBe(true);
  });

  it('accepts exactly 191 and refuses 192', () => {
    const domain = `${'b'.repeat(63)}.${'c'.repeat(63)}.example.com`; // 63 + 1 + 63 + 1 + 11 = 139
    const make = (total: number) => `${'a'.repeat(total - domain.length - 1)}@${domain}`;
    expect(make(191)).toHaveLength(191);
    // The local part of 51 characters is within the 64 allowed by RFC 5321.
    expect(accepts(emailField, make(191))).toBe(true);
    expect(accepts(emailField, make(192))).toBe(false);
  });
});

describe('passwordField (1-512 UTF-16 units, never trimmed or normalized)', () => {
  it('keeps the value byte for byte', () => {
    expect(passwordField.parse('  päss  ')).toBe('  päss  ');
    expect(passwordField.parse('Café')).toBe('Café');
    expect(passwordField.parse('ａｂｃ')).toBe('ａｂｃ');
  });

  it('refuses the empty string, accepts a single space', () => {
    expect(accepts(passwordField, '')).toBe(false);
    expect(passwordField.parse(' ')).toBe(' ');
  });

  it('accepts 512 UTF-16 units and refuses 513', () => {
    expect(accepts(passwordField, 'p'.repeat(512))).toBe(true);
    expect(accepts(passwordField, 'p'.repeat(513))).toBe(false);
    // An astral character is two units: 256 of them fill the 512, one more does not fit.
    expect(accepts(passwordField, '\u{1f511}'.repeat(256))).toBe(true);
    expect(accepts(passwordField, `${'\u{1f511}'.repeat(256)}a`)).toBe(false);
  });
});

describe('ulidField (Crockford, 26)', () => {
  it('accepts a generated id', () => {
    const id = newId();
    expect(ulidField.parse(id)).toBe(id);
  });

  it('refuses anything else', () => {
    const id = newId();
    for (const bad of ['', 'x', id.toLowerCase(), id.slice(1), `${id}0`, ` ${id}`, `${id}\n`, `I${id.slice(1)}`, `U${id.slice(1)}`, '8'.repeat(26)]) {
      expect(accepts(ulidField, bad), JSON.stringify(bad)).toBe(false);
    }
  });
});

describe('localeField', () => {
  it('is id or en', () => {
    expect(localeField.parse('id')).toBe('id');
    expect(localeField.parse('en')).toBe('en');
    for (const bad of ['', 'ID', 'en-US', 'fr', 'id ']) expect(accepts(localeField, bad), bad).toBe(false);
  });
});

describe('branchCodeField (S12: NFKC and trim first, then 1-32 of A-Z a-z 0-9 _ -)', () => {
  it('trims', () => {
    expect(branchCodeField.parse('CAB-1 ')).toBe('CAB-1');
    expect(branchCodeField.parse('  PUSAT_2')).toBe('PUSAT_2');
  });

  it('folds full-width input', () => {
    expect(branchCodeField.parse('ＣＡＢ-１')).toBe('CAB-1');
  });

  it('accepts 1 and 32 characters, refuses empty and 33', () => {
    expect(branchCodeField.parse('A')).toBe('A');
    expect(accepts(branchCodeField, 'A'.repeat(32))).toBe(true);
    expect(accepts(branchCodeField, 'A'.repeat(33))).toBe(false);
    expect(accepts(branchCodeField, '')).toBe(false);
    expect(accepts(branchCodeField, '   ')).toBe(false);
  });

  it('refuses inner spaces and characters outside the set', () => {
    for (const bad of ['CAB 1', 'CAB.1', 'CAB/1', 'CÄB', 'مركز', 'CAB​1']) {
      expect(accepts(branchCodeField, bad), JSON.stringify(bad)).toBe(false);
    }
  });
});

describe('timezoneField (at most 64, accepted by Intl.DateTimeFormat)', () => {
  it('accepts IANA names', () => {
    expect(timezoneField.parse('Asia/Jakarta')).toBe('Asia/Jakarta');
    expect(timezoneField.parse('UTC')).toBe('UTC');
    expect(timezoneField.parse('America/Argentina/Buenos_Aires')).toBe('America/Argentina/Buenos_Aires');
  });

  it('refuses unknown zones, the empty string and more than 64 characters', () => {
    expect(accepts(timezoneField, 'Mars/Base')).toBe(false);
    expect(accepts(timezoneField, '')).toBe(false);
    expect(accepts(timezoneField, 'Asia/Jakarta '.repeat(5))).toBe(false);
    expect(accepts(timezoneField, 'A'.repeat(65))).toBe(false);
  });
});

describe('versionField (int >= 0)', () => {
  it('accepts non-negative integers', () => {
    expect(versionField.parse(0)).toBe(0);
    expect(versionField.parse(7)).toBe(7);
  });

  it('refuses negatives, fractions, numeric strings and non-finite numbers', () => {
    for (const bad of [-1, 1.5, '1', null, undefined, Number.NaN, Number.POSITIVE_INFINITY]) {
      expect(accepts(versionField, bad), String(bad)).toBe(false);
    }
  });

  it('refuses what an INT column cannot hold', () => {
    expect(accepts(versionField, 2_147_483_647)).toBe(true);
    expect(accepts(versionField, 2_147_483_648)).toBe(false);
  });
});

describe('idempotencyKeyField (^[A-Za-z0-9._:-]{8,64}$)', () => {
  it('accepts keys of 8 to 64 allowed characters', () => {
    expect(idempotencyKeyField.parse('abcd1234')).toBe('abcd1234');
    expect(idempotencyKeyField.parse('k'.repeat(64))).toBe('k'.repeat(64));
    expect(idempotencyKeyField.parse(newId())).toHaveLength(26);
    expect(idempotencyKeyField.parse('req:2026-10-27.a_b-c')).toBe('req:2026-10-27.a_b-c');
  });

  it('refuses short, long and ill-formed keys', () => {
    expect(accepts(idempotencyKeyField, 'short')).toBe(false);
    expect(accepts(idempotencyKeyField, 'k'.repeat(7))).toBe(false);
    expect(accepts(idempotencyKeyField, 'k'.repeat(65))).toBe(false);
    expect(accepts(idempotencyKeyField, 'abc def ghi')).toBe(false);
    expect(accepts(idempotencyKeyField, 'abcdefgh\n')).toBe(false);
    expect(accepts(idempotencyKeyField, ' abcdefgh')).toBe(false);
    expect(accepts(idempotencyKeyField, 'abcdefgé')).toBe(false);
    expect(accepts(idempotencyKeyField, '')).toBe(false);
  });
});
