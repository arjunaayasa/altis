import { MESSAGES } from '@altis/shared';
import { renderHook } from '@testing-library/react';
import { createElement, type ReactNode } from 'react';
import { describe, expect, it } from 'vitest';
import { ADMIN_MESSAGES, I18nProvider, useT, type AdminKey } from '@/i18n';

// The SPA's own strings (decision D29): Indonesian first, English complete. Shared families (error.*, perm.*,
// audit.*, banner.*) come from @altis/shared through the same useT().

const SHARED_PREFIXES = ['error.', 'perm.', 'audit.', 'role.', 'mail.', 'opac.', 'banner.', 'vocab.', 'report.', 'accred.'];

const placeholders = (text: string): string[] => [...text.matchAll(/\{([A-Za-z_][A-Za-z0-9_]*)\}/g)].map((m) => m[1]!).sort();

describe('ADMIN_MESSAGES', () => {
  it('id and en have the same keys and no empty value', () => {
    const id = Object.keys(ADMIN_MESSAGES.id).sort();
    expect(id.length).toBeGreaterThan(0);
    expect(Object.keys(ADMIN_MESSAGES.en).sort()).toEqual(id);
    for (const locale of ['id', 'en'] as const) {
      for (const [key, text] of Object.entries(ADMIN_MESSAGES[locale])) expect(text.trim(), `${locale} ${key}`).not.toBe('');
    }
  });

  it('both languages use the same placeholders for a key', () => {
    for (const key of Object.keys(ADMIN_MESSAGES.id) as AdminKey[]) {
      expect(placeholders(ADMIN_MESSAGES.en[key]), key).toEqual(placeholders(ADMIN_MESSAGES.id[key]));
    }
  });

  it('no admin key takes a shared family prefix', () => {
    for (const key of Object.keys(ADMIN_MESSAGES.id)) {
      expect(SHARED_PREFIXES.some((prefix) => key.startsWith(prefix)), key).toBe(false);
    }
  });

  it('the build mismatch banner says what spec §4.8 says', () => {
    expect(ADMIN_MESSAGES.id['shell.build_mismatch']).toBe('ALTIS telah diperbarui — muat ulang');
  });
});

describe('useT', () => {
  const wrapper =
    (locale: 'id' | 'en') =>
    ({ children }: { children: ReactNode }) =>
      createElement(I18nProvider, { locale }, children);

  it('translates admin keys in the provider locale, with placeholders', () => {
    const { result } = renderHook(() => useT(), { wrapper: wrapper('en') });
    expect(result.current('nav.home')).toBe(ADMIN_MESSAGES.en['nav.home']);
    const { result: id } = renderHook(() => useT(), { wrapper: wrapper('id') });
    expect(id.current('home.welcome', { name: 'Ani' })).toContain('Ani');
  });

  it('falls back to the shared messages for error.*, perm.*, audit.* and banner.*', () => {
    const { result } = renderHook(() => useT(), { wrapper: wrapper('en') });
    expect(result.current('error.AUTH_REQUIRED')).toBe(MESSAGES.en['error.AUTH_REQUIRED']);
    expect(result.current('perm.system.users.read')).toBe(MESSAGES.en['perm.system.users.read']);
    expect(result.current('audit.users.create')).toBe(MESSAGES.en['audit.users.create']);
    expect(result.current('banner.maintenance')).toBe(MESSAGES.en['banner.maintenance']);
  });

  it('defaults to Indonesian without a provider', () => {
    const { result } = renderHook(() => useT());
    expect(result.current('nav.home')).toBe('Beranda');
  });
});
