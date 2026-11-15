import { describe, expect, it } from 'vitest';
import { AUDIT_ACTIONS } from '../src/audit-actions.js';
import { VOCAB_LISTS } from '../src/catalog-vocab.js';
import { CIRCULATION_VOCAB_LISTS, MEMBER_STATUSES, MEMBER_STORED_STATUSES, RENEW_REFUSALS } from '../src/circulation-vocab.js';
import { ERROR_CODES } from '../src/errors.js';
import { MESSAGES } from '../src/i18n/index.js';
import { MEMBERS_CIRCULATION_EN, MEMBERS_CIRCULATION_ID } from '../src/i18n/members-circulation.js';
import { permissionCatalog } from '../src/permissions.js';

// The members and circulation vocabularies and texts: the lists are joined last into VOCAB_LISTS, every value has a
// label in both languages, and every new permission, module, audit action and error code has its message.

const table = (locale: 'id' | 'en'): Readonly<Record<string, string>> => MESSAGES[locale] as Readonly<Record<string, string>>;
const placeholders = (s: string): string[] => [...s.matchAll(/\{([A-Za-z_][A-Za-z0-9_]*)\}/g)].map((m) => m[1]!).sort();

describe('the members and circulation vocabularies', () => {
  it('are joined into VOCAB_LISTS after the earlier lists, under their list names, frozen and without duplicates', () => {
    const names = Object.keys(VOCAB_LISTS);
    const first = names.indexOf(Object.keys(CIRCULATION_VOCAB_LISTS)[0]!);
    expect(names.slice(first, first + Object.keys(CIRCULATION_VOCAB_LISTS).length)).toEqual(Object.keys(CIRCULATION_VOCAB_LISTS));
    for (const [list, values] of Object.entries(CIRCULATION_VOCAB_LISTS)) {
      expect((VOCAB_LISTS as Record<string, readonly string[]>)[list], list).toBe(values);
      expect(Object.isFrozen(values), list).toBe(true);
      expect(new Set(values).size, list).toBe(values.length);
    }
  });

  it('the stored statuses are the shown ones a row can hold itself; renewal refusals start with the ones this milestone checks', () => {
    for (const s of MEMBER_STORED_STATUSES) expect(MEMBER_STATUSES).toContain(s);
    expect(RENEW_REFUSALS.slice(0, 5)).toEqual(['changed', 'suspended', 'expired', 'same_day', 'limit']);
  });

  it('every value of every list has a label in both languages, the two different', () => {
    for (const [list, values] of Object.entries(CIRCULATION_VOCAB_LISTS)) {
      for (const value of values) {
        const key = `vocab.${list}.${value}`;
        expect(table('id')[key], `id:${key}`).toBeTruthy();
        expect(table('en')[key], `en:${key}`).toBeTruthy();
        expect(table('id')[key], key).not.toBe(table('en')[key]);
      }
    }
  });
});

describe('the members and circulation texts', () => {
  it('a message in both languages for each new permission, module, audit action and error code, without placeholders', () => {
    const perms = permissionCatalog('production').slice(32, 39);
    expect(perms.every((d) => d.module === 'members' || d.module === 'circulation')).toBe(true);
    const from = AUDIT_ACTIONS.indexOf('members.member.create');
    const audits = AUDIT_ACTIONS.slice(from, from + 15);
    expect(audits.at(-1)).toBe('circulation.policy.archive');
    const codeKeys = Object.keys(ERROR_CODES);
    const codes = codeKeys.slice(codeKeys.indexOf('MEMBER_IN_USE'), codeKeys.indexOf('MEMBER_IN_USE') + 12);
    expect(codes.at(-1)).toBe('CIRC_RENEW_REFUSED');
    const keys = [
      ...perms.map((p) => `perm.${p.key}`),
      'perm.module.members',
      'perm.module.circulation',
      ...audits.map((a) => `audit.${a}`),
      ...codes.map((c) => `error.${c}`),
    ];
    for (const key of keys) {
      expect(table('id')[key], `id:${key}`).toBeTruthy();
      expect(table('en')[key], `en:${key}`).toBeTruthy();
      expect(table('id')[key], key).not.toBe(table('en')[key]);
      expect(placeholders(table('id')[key]!), key).toEqual([]);
    }
  });

  it('the slot file has the same keys in both languages, all spread into the shared catalogs', () => {
    expect(Object.keys(MEMBERS_CIRCULATION_EN).sort()).toEqual(Object.keys(MEMBERS_CIRCULATION_ID).sort());
    for (const [key, text] of Object.entries(MEMBERS_CIRCULATION_ID)) expect(table('id')[key], key).toBe(text);
    for (const [key, text] of Object.entries(MEMBERS_CIRCULATION_EN)) expect(table('en')[key], key).toBe(text);
  });
});
