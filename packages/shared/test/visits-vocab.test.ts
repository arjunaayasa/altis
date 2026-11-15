import { describe, expect, it } from 'vitest';
import { AUDIT_ACTIONS } from '../src/audit-actions.js';
import { VOCAB_LISTS } from '../src/catalog-vocab.js';
import { ERROR_CODES } from '../src/errors.js';
import { MESSAGES } from '../src/i18n/index.js';
import { MEMBERS_VISITS_EN, MEMBERS_VISITS_ID } from '../src/i18n/members-visits.js';
import { permissionCatalog } from '../src/permissions.js';
import { VISITS_VOCAB_LISTS } from '../src/visits-vocab.js';

// The member tools and visits: their lists are joined into VOCAB_LISTS side by side and in their order, every value
// and every new permission, module, audit action and error code has its message in both languages.

const table = (locale: 'id' | 'en'): Readonly<Record<string, string>> => MESSAGES[locale] as Readonly<Record<string, string>>;

describe('the member tools and visits vocabularies and texts', () => {
  it('are joined into VOCAB_LISTS side by side and in their order, frozen and without duplicates', () => {
    const names = Object.keys(VOCAB_LISTS);
    const first = names.indexOf(Object.keys(VISITS_VOCAB_LISTS)[0]!);
    expect(names.slice(first, first + Object.keys(VISITS_VOCAB_LISTS).length)).toEqual(Object.keys(VISITS_VOCAB_LISTS));
    for (const [list, values] of Object.entries(VISITS_VOCAB_LISTS)) {
      expect(Object.isFrozen(values), list).toBe(true);
      expect(new Set(values).size, list).toBe(values.length);
      for (const value of values) {
        const key = `vocab.${list}.${value}`;
        expect(table('id')[key], `id:${key}`).toBeTruthy();
        expect(table('en')[key], `en:${key}`).toBeTruthy();
      }
    }
  });

  it('a message in both languages for each new permission, the visits module, audit action and error code', () => {
    const perms = permissionCatalog('production').slice(39, 44);
    const from = AUDIT_ACTIONS.indexOf('members.member.restore');
    const codes = Object.keys(ERROR_CODES);
    const keys = [
      ...perms.map((p) => `perm.${p.key}`),
      'perm.module.visits',
      ...AUDIT_ACTIONS.slice(from, from + 13).map((a) => `audit.${a}`),
      ...codes.slice(codes.indexOf('MEMBER_ANONYMIZED'), codes.indexOf('MEMBER_ANONYMIZED') + 4).map((c) => `error.${c}`),
    ];
    expect(keys).toHaveLength(5 + 1 + 13 + 4);
    for (const key of keys) {
      expect(table('id')[key], `id:${key}`).toBeTruthy();
      expect(table('en')[key], `en:${key}`).toBeTruthy();
      expect(table('id')[key], key).not.toBe(table('en')[key]);
    }
    expect(Object.keys(MEMBERS_VISITS_EN).sort()).toEqual(Object.keys(MEMBERS_VISITS_ID).sort());
  });
});
