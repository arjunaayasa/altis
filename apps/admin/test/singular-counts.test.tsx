import { screen, within } from '@testing-library/react';
import { afterEach, describe, expect, it, vi } from 'vitest';
import { ADMIN_MESSAGES, translate, type AdminKey, type Translate } from '@/i18n';
import { formatWait } from '@/install/i18n';
import { ApiError } from '@/lib/api';
import { problemText } from '@/lib/form-errors';
import { ROLES, adminMe, permissionsAnswer, startApp } from './fake-api';

// English counts take the singular when the count is 1 ("1 user", not "1 users"): a counted text has a `<key>_one`
// twin with the same placeholders, chosen for a count of 1. Indonesian has one form for both.

afterEach(() => {
  vi.unstubAllGlobals();
  vi.restoreAllMocks();
});

const SINGULARS: readonly AdminKey[] = [
  'users.paging_one',
  'roles.permission_count_one',
  'roles.holder_count_one',
  'roles.holders_hint_one',
  'jobs.schedules.every_minutes_one',
  'diagnostics.network.suggest_change_one',
  'diagnostics.release.keyset_value_one',
  'form.retry_after_seconds_one',
];

const placeholders = (text: string): string[] => [...text.matchAll(/\{([A-Za-z_]+)\}/g)].map((m) => m[1]!).sort();

describe('English singulars', () => {
  it('every singular has its plural twin, the same placeholders, and its own English text', () => {
    for (const key of SINGULARS) {
      const base = key.replace(/_one$/, '') as AdminKey;
      expect(ADMIN_MESSAGES.en[base], key).toBeDefined();
      expect(placeholders(ADMIN_MESSAGES.en[key]), key).toEqual(placeholders(ADMIN_MESSAGES.en[base]));
      expect(ADMIN_MESSAGES.en[key], key).not.toBe(ADMIN_MESSAGES.en[base]);
      expect(ADMIN_MESSAGES.id[key], key).toBe(ADMIN_MESSAGES.id[base]);
    }
  });

  it('a wait of one second or one minute is said in the singular', () => {
    const en: Translate = (key, params) => translate('en', key, params);
    const wait = (s: number) => problemText(en, new ApiError(429, 'AUTH_TOO_MANY_ATTEMPTS', { retryAfterS: s }));
    expect(wait(1)).toMatch(/1 second\.$/);
    expect(wait(42)).toMatch(/42 seconds\.$/);
    expect(formatWait('en', 1)).toBe('1 second');
    expect(formatWait('en', 60)).toBe('1 minute');
    expect(formatWait('en', 61)).toBe('2 minutes');
  });

  it('the roles list says "1 user" and "2 users"', async () => {
    const me = adminMe();
    startApp({
      me: { ...me, user: { ...me.user, locale: 'en' } },
      path: '/admin/roles',
      routes: { 'GET roles': () => ({ items: ROLES }), 'GET permissions': () => permissionsAnswer() },
    });
    const table = await screen.findByRole('table');
    const holders = within(table)
      .getAllByRole('row')
      .slice(1)
      .map((row) => row.querySelectorAll('td')[3]?.textContent);
    expect(holders).toContain('1 user');
    expect(holders).toContain('2 users');
    expect(holders).not.toContain('1 users');
  });
});
