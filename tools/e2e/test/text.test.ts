import { t as sharedT } from '@altis/shared';
import { describe, expect, it } from 'vitest';
import { exactText, tr } from '../lib/text.js';

describe('tr (the words a user sees, from the catalogues the admin SPA renders)', () => {
  it("takes the SPA's own strings in each language", () => {
    expect(tr('id', 'login.submit')).toBe('Masuk');
    expect(tr('en', 'login.submit')).toBe('Sign in');
    expect(tr('id', 'twofa.sign_in_again')).toBe('Masuk lagi');
    expect(tr('id', 'login.remember')).toMatch(/^Ingat saya/);
  });

  it('fills placeholders as the SPA does', () => {
    expect(tr('id', 'home.welcome', { name: 'Siti' })).toBe('Selamat datang, Siti.');
    expect(tr('en', 'home.welcome', { name: 'Siti' })).toBe('Welcome, Siti.');
  });

  it('falls back to the shared catalogue (errors, roles, OPAC)', () => {
    expect(tr('id', 'error.AUTH_TOO_MANY_ATTEMPTS')).toBe(sharedT('id', 'error.AUTH_TOO_MANY_ATTEMPTS'));
    expect(tr('en', 'role.admin')).toBe('Admin');
  });
});

describe('exactText', () => {
  it('matches the whole text only, whatever characters it holds', () => {
    const re = exactText('Reset 2FA (Petugas)?');
    expect(re.test('Reset 2FA (Petugas)?')).toBe(true);
    expect(re.test('  Reset 2FA (Petugas)?  ')).toBe(true);
    expect(re.test('Reset 2FA (Petugas)? lagi')).toBe(false);
  });
});
