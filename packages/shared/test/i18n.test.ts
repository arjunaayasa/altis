import { afterEach, describe, expect, it, vi } from 'vitest';
import { AUDIT_ACTIONS } from '../src/audit-actions.js';
import { ERROR_CODES } from '../src/errors.js';
import { NEEDS_ATTENTION, OP_KINDS, OP_STATES } from '../src/ops.js';
import { permissionCatalog } from '../src/permissions.js';
import { DEFAULT_LOCALE, LOCALES, MESSAGES, fillPlaceholders, resolveLocale, t, type Locale, type MessageKey } from '../src/i18n/index.js';

/** The `{name}` placeholders of a template, as a sorted list of distinct names. */
function placeholders(template: string): string[] {
  return [...new Set([...template.matchAll(/\{([A-Za-z_][A-Za-z0-9_]*)\}/g)].map((m) => m[1] as string))].sort();
}

const TEST_ONLY_KEYS = ['perm.test.branch.manage', 'perm.module.test'] as const;

afterEach(() => {
  vi.unstubAllGlobals();
  vi.resetModules();
});

describe('LOCALES and DEFAULT_LOCALE', () => {
  it('Indonesian first, English second, Indonesian by default', () => {
    expect([...LOCALES]).toEqual(['id', 'en']);
    expect(DEFAULT_LOCALE).toBe('id');
  });
});

describe('MESSAGES', () => {
  const keysOf = (locale: Locale) => Object.keys(MESSAGES[locale]).sort();

  it('has a catalog for every locale', () => {
    for (const locale of LOCALES) expect(Object.keys(MESSAGES[locale]).length).toBeGreaterThan(0);
  });

  it('id and en have identical key sets', () => {
    expect(keysOf('en')).toEqual(keysOf('id'));
  });

  it('has no empty value in either language', () => {
    for (const locale of LOCALES) {
      for (const [key, value] of Object.entries(MESSAGES[locale])) {
        expect(value.trim(), `${locale}:${key}`).not.toBe('');
      }
    }
  });

  it('uses the same set of {placeholders} for a key in both languages', () => {
    for (const key of Object.keys(MESSAGES.id) as MessageKey[]) {
      expect(placeholders(MESSAGES.en[key]), key).toEqual(placeholders(MESSAGES.id[key]));
    }
  });

  it('keeps the two languages apart: no English copy left in the Indonesian catalog by accident', () => {
    // A key whose two texts are identical is almost always a forgotten translation. Names and numbers are the
    // only legitimate cases.
    const same = (Object.keys(MESSAGES.id) as MessageKey[]).filter((key) => MESSAGES.id[key] === MESSAGES.en[key]);
    expect(same.sort()).toEqual(['role.admin', 'role.super_admin']);
  });

  it('is frozen, with frozen catalogs', () => {
    expect(Object.isFrozen(MESSAGES)).toBe(true);
    for (const locale of LOCALES) expect(Object.isFrozen(MESSAGES[locale])).toBe(true);
  });

  it('has a message for every error code, permission and audit action', () => {
    for (const locale of LOCALES) {
      const keys = new Set(Object.keys(MESSAGES[locale]));
      for (const code of Object.keys(ERROR_CODES)) expect(keys.has(`error.${code}`), `${locale}:error.${code}`).toBe(true);
      for (const def of permissionCatalog('test')) expect(keys.has(`perm.${def.key}`), `${locale}:perm.${def.key}`).toBe(true);
      for (const action of AUDIT_ACTIONS) expect(keys.has(`audit.${action}`), `${locale}:audit.${action}`).toBe(true);
    }
  });

  it('1c: has a label for every op kind and for every op state of the union plus needs_attention', () => {
    const states = [...new Set([...OP_KINDS.flatMap((kind) => OP_STATES[kind]), NEEDS_ATTENTION])];
    // 26 distinct states across the seven kinds, and needs_attention.
    expect(states).toHaveLength(27);
    for (const locale of LOCALES) {
      const table = MESSAGES[locale] as Record<string, string>;
      for (const kind of OP_KINDS) {
        expect(table[`ops.kind.${kind}`], `${locale}:ops.kind.${kind}`).toBeTruthy();
        expect(placeholders(table[`ops.kind.${kind}`] as string)).toEqual([]);
      }
      for (const state of states) {
        expect(table[`ops.state.${state}`], `${locale}:ops.state.${state}`).toBeTruthy();
        expect(placeholders(table[`ops.state.${state}`] as string)).toEqual([]);
      }
    }
  });

  it('1c: has no ops.kind or ops.state key beyond the vocabulary of @altis/shared/ops', () => {
    const states = new Set([...OP_KINDS.flatMap((kind) => OP_STATES[kind]), NEEDS_ATTENTION]);
    const expected = [...OP_KINDS.map((k) => `ops.kind.${k}`), ...[...states].map((s) => `ops.state.${s}`)].sort();
    for (const locale of LOCALES) {
      const found = Object.keys(MESSAGES[locale]).filter((k) => k.startsWith('ops.kind.') || k.startsWith('ops.state.'));
      expect(found.sort(), locale).toEqual(expected);
    }
  });

  it('1c: has the ops page, the maintenance screen and the dashboard alerts', () => {
    const page = ['title', 'none', 'drive_hint', 'cancel', 'takeover', 'resume', 'cli_hint'] as const;
    const alerts = [
      'runner_stale',
      'clock_anomaly',
      'exposure_failed',
      'backup_missing',
      'backup_failed',
      'jobs_dead',
      'disk_low',
      'ops_attention',
      'ip_trust',
      'audit_broken',
      // 1d (Task 1): the alert kinds Task 29 adds to ALERT_KINDS
      'keyset_full',
      'update_blocked',
      'bundled_ignored',
      'schema_hold',
      // Phase 2 (B2): the search index and OAI-PMH alerts.
      'search_index_mismatch',
      'oai_misconfigured',
    ] as const;
    for (const locale of LOCALES) {
      const table = MESSAGES[locale] as Record<string, string>;
      for (const key of page) expect(table[`ops.page.${key}`], `${locale}:ops.page.${key}`).toBeTruthy();
      for (const key of ['title', 'body'] as const) {
        expect(table[`maintenance.screen.${key}`], `${locale}:maintenance.screen.${key}`).toBeTruthy();
        expect(placeholders(table[`maintenance.screen.${key}`] as string)).toEqual([]);
      }
      for (const key of alerts) {
        expect(table[`alert.${key}`], `${locale}:alert.${key}`).toBeTruthy();
        expect(placeholders(table[`alert.${key}`] as string), `alert.${key}`).toEqual([]);
      }
      const found = Object.keys(table).filter((k) => k.startsWith('alert.')).sort();
      expect(found).toEqual(alerts.map((a) => `alert.${a}`).sort());
    }
  });

  it('Phase 2: a message in both languages for each new permission, module, audit action and error code', () => {
    const perms = [
      'catalog.records.read',
      'catalog.records.manage',
      'catalog.authorities.manage',
      'catalog.masters.manage',
      'catalog.locations.manage',
      'catalog.items.manage',
      'catalog.import.run',
      'catalog.export.run',
      'catalog.migration.run',
      'opac.pages.manage',
    ];
    // The Phase 2 entries, from the first one through the last one (later milestones append after them).
    const audits = AUDIT_ACTIONS.slice(AUDIT_ACTIONS.indexOf('catalog.record.create'), AUDIT_ACTIONS.indexOf('opac.page.archive') + 1);
    expect(audits).toHaveLength(30);
    const codes = Object.keys(ERROR_CODES).slice(
      Object.keys(ERROR_CODES).indexOf('CATALOG_RECORD_HAS_ITEMS'),
      Object.keys(ERROR_CODES).indexOf('MIGRATION_TARGET_NOT_EMPTY') + 1,
    );
    expect(codes).toHaveLength(13);
    const keys = [
      ...perms.map((p) => `perm.${p}`),
      'perm.module.catalog',
      'perm.module.opac',
      ...audits.map((a) => `audit.${a}`),
      ...codes.map((c) => `error.${c}`),
    ];
    for (const key of keys) {
      const id = (MESSAGES.id as Record<string, string>)[key];
      const en = (MESSAGES.en as Record<string, string>)[key];
      expect(id, `id:${key}`).toBeTruthy();
      expect(en, `en:${key}`).toBeTruthy();
      // No English left in the Indonesian text, and no placeholder: the problem body carries the detail.
      expect(id, key).not.toBe(en);
      expect(placeholders(id as string), key).toEqual([]);
      expect(placeholders(en as string), key).toEqual([]);
    }
    // Each permission module of the catalog has its label.
    for (const def of permissionCatalog('production')) {
      for (const locale of LOCALES) expect((MESSAGES[locale] as Record<string, string>)[`perm.module.${def.module}`], def.key).toBeTruthy();
    }
  });

  // ---- Komunitas K1 (edition lane) ----
  it('the refusal of a restore onto tables of another migration lane, in both languages, without placeholders', () => {
    expect(MESSAGES.id['error.BACKUP_EDITION_TABLES']).toBe('Database ini memuat tabel jalur lain; pulihkan dengan kode yang mengenalnya.');
    expect(MESSAGES.en['error.BACKUP_EDITION_TABLES']).toBe(
      'This database holds tables from another migration lane; restore it with code that knows them.',
    );
  });

  it('1c: every notification has a title and a body, the body key being the title key with .title replaced by .body (M44)', () => {
    // The placeholders each sender fills (a row stores the title key and its params; the body key is derived).
    const notifications: Record<string, string[]> = {
      backup_done: ['name'],
      backup_failed: ['name'],
      backup_skipped: [],
      restore_done: ['name'],
      restore_failed: ['name'],
      job_dead: ['name'],
      disk_low: [],
      clock_anomaly: [],
      exposure_failed: ['url'],
      ops_attention: ['name'],
      audit_broken: ['seq'],
      update_available: ['version'],
      // 1d (Task 1). `version` is the release the update or the bundled release aimed at (for update_rolled_back,
      // the version left behind: a reverted update's target, or the version a manual rollback left).
      update_done: ['version'],
      update_failed: ['version'],
      update_rolled_back: ['version'],
      update_restored: ['version'],
      update_restore_failed: ['version'],
      update_blocked: ['version'],
    };
    for (const locale of LOCALES) {
      const table = MESSAGES[locale] as Record<string, string>;
      for (const [x, params] of Object.entries(notifications)) {
        const title = `notification.${x}.title`;
        const body = title.replace(/\.title$/, '.body');
        expect(body).toBe(`notification.${x}.body`);
        expect(table[title], `${locale}:${title}`).toBeTruthy();
        expect(table[body], `${locale}:${body}`).toBeTruthy();
        // A title is one line (it is a list heading); the placeholders are the ones listed, in the body only.
        expect(table[title], `${locale}:${title}`).not.toMatch(/[\r\n]/);
        expect(placeholders(table[title] as string), title).toEqual([]);
        expect(placeholders(table[body] as string), body).toEqual(params);
      }
      const found = Object.keys(table).filter((k) => k.startsWith('notification.')).sort();
      expect(found).toEqual(Object.keys(notifications).flatMap((x) => [`notification.${x}.body`, `notification.${x}.title`]).sort());
    }
  });

  it('1c: the error message of a code that carries a reason in problem+json needs no placeholder', () => {
    for (const locale of LOCALES) {
      for (const code of ['MAINTENANCE', 'BACKUP_INVALID', 'UPLOAD_CHUNK_INVALID', 'UPLOAD_MISMATCH', 'JOB_NOT_RETRYABLE'] as const) {
        expect(placeholders(MESSAGES[locale][`error.${code}`]), `${locale}:${code}`).toEqual([]);
      }
    }
  });

  it('has the permission module labels and the two system roles', () => {
    for (const locale of LOCALES) {
      const table = MESSAGES[locale];
      expect(table['perm.module.system']).toBeTruthy();
      expect(table['role.super_admin']).toBeTruthy();
      expect(table['role.admin']).toBeTruthy();
    }
  });

  it('has the mail templates with the placeholders the senders fill', () => {
    for (const locale of LOCALES) {
      const table = MESSAGES[locale];
      const reset = placeholders(`${table['mail.password_reset.subject']}\n${table['mail.password_reset.body']}`);
      expect(reset).toEqual(['library', 'link', 'minutes', 'name', 'username']);
      expect(placeholders(table['mail.password_reset.body'])).toEqual(expect.arrayContaining(['link', 'minutes', 'name']));
      expect(placeholders(`${table['mail.email_test.subject']}\n${table['mail.email_test.body']}`)).toEqual(['library']);
      // A subject is one line: it ends up in a header.
      expect(table['mail.password_reset.subject']).not.toMatch(/[\r\n]/);
      expect(table['mail.email_test.subject']).not.toMatch(/[\r\n]/);
    }
  });

  it('has the OPAC and banner keys, the error page body taking the {code}', () => {
    for (const locale of LOCALES) {
      const table = MESSAGES[locale];
      expect(placeholders(table['opac.error.body'])).toEqual(['code']);
      for (const key of [
        'opac.home.title',
        'opac.home.coming_soon',
        'opac.home.staff_login',
        'opac.lang.switch',
        'opac.not_found.title',
        'opac.not_found.body',
        'opac.error.title',
        'opac.maintenance.title',
        'opac.maintenance.body',
        'banner.maintenance',
        'banner.clock',
      ] as const) {
        expect(table[key], `${locale}:${key}`).toBeTruthy();
      }
    }
  });

  it('the banners are the maintenance and the clock ones only (no licence banner), without placeholders, in both languages', () => {
    const expected: Record<string, string[]> = {
      'banner.maintenance': [],
      'banner.clock': [],
    };
    for (const locale of LOCALES) {
      const table = MESSAGES[locale] as Record<string, string>;
      for (const [key, params] of Object.entries(expected)) {
        expect(placeholders(table[key] as string), `${locale}:${key}`).toEqual(params);
      }
      const found = Object.keys(table).filter((k) => k.startsWith('banner.')).sort();
      expect(found, locale).toEqual(Object.keys(expected).sort());
    }
  });

  it('1d: the error message of every update and feed code needs no placeholder (problem+json carries no params)', () => {
    const codes = [
      'UPDATE_NONE',
      'UPDATE_NOT_ENTITLED',
      'UPDATE_PRECHECK_FAILED',
      'UPDATE_PACKAGE_INVALID',
      'UPDATE_DOWNLOAD_FAILED',
      'UPDATE_HIDDEN',
      'UPDATE_SCHEMA_HOLD_FAILED',
      'UPDATE_BOOT_FAILED',
      'UPDATE_CHECK_THROTTLED',
      'FEED_INVALID',
      'FEED_UNREACHABLE',
      'ROLLBACK_UNAVAILABLE',
      'RELEASE_PENDING',
    ] as const;
    for (const locale of LOCALES) {
      for (const code of codes) {
        expect(MESSAGES[locale][`error.${code}`], `${locale}:${code}`).toBeTruthy();
        expect(placeholders(MESSAGES[locale][`error.${code}`]), `${locale}:${code}`).toEqual([]);
      }
    }
  });

  it('1d: every code that carries a registered reason (PROBLEM_REASONS of 1d) has its error message', () => {
    // apps/server/src/http/problem.ts holds the reasons; the words are not translated one by one, the UI shows the
    // code's message (and, for prechecks, the update.precheck.* texts below).
    const reasonCodes = [
      'UPDATE_NOT_ENTITLED',
      'UPDATE_PRECHECK_FAILED',
      'UPDATE_PACKAGE_INVALID',
      'UPDATE_BOOT_FAILED',
      'FEED_INVALID',
      'FEED_UNREACHABLE',
      'ROLLBACK_UNAVAILABLE',
      'UPDATE_HIDDEN',
    ] as const;
    for (const locale of LOCALES) {
      for (const code of reasonCodes) expect(MESSAGES[locale][`error.${code}`], `${locale}:${code}`).toBeTruthy();
    }
  });

  it('1d: the update precheck texts, one per UPDATE_PRECHECK_FAILED reason and the four notes, nothing else', () => {
    const expected: Record<string, string[]> = {
      not_newer: [],
      min_upgrade_from: [],
      boot_protocol: [],
      min_node: [],
      min_db: [],
      snapshot_backup: [],
      entitlement: [],
      db_restore_needed: [],
      stepping_stone: [],
      estimate: ['minutes'],
    };
    for (const locale of LOCALES) {
      const table = MESSAGES[locale] as Record<string, string>;
      for (const [x, params] of Object.entries(expected)) {
        const key = `update.precheck.${x}`;
        expect(table[key], `${locale}:${key}`).toBeTruthy();
        expect(placeholders(table[key] as string), `${locale}:${key}`).toEqual(params);
      }
      const found = Object.keys(table).filter((k) => k.startsWith('update.precheck.')).sort();
      expect(found, locale).toEqual(Object.keys(expected).map((x) => `update.precheck.${x}`).sort());
    }
  });

  it('names the community edition and its status in both languages, without placeholders, and has no licence key', () => {
    const expected: Record<string, Record<string, string>> = {
      id: { 'edition.community': 'Edisi Komunitas', 'edition.status.active': 'Aktif' },
      en: { 'edition.community': 'Community Edition', 'edition.status.active': 'Active' },
    };
    for (const locale of LOCALES) {
      const table = MESSAGES[locale] as Record<string, string>;
      for (const [key, text] of Object.entries(expected[locale] ?? {})) {
        expect(table[key], `${locale}:${key}`).toBe(text);
        expect(placeholders(table[key] as string), `${locale}:${key}`).toEqual([]);
      }
      expect(Object.keys(table).filter((k) => k.startsWith('edition.')).sort(), locale).toEqual(['edition.community', 'edition.status.active']);
      const licence = Object.keys(table).filter(
        (k) =>
          k.startsWith('license.') ||
          k.startsWith('error.LICENSE_') ||
          k.startsWith('perm.system.license.') ||
          k.startsWith('audit.license.') ||
          k.startsWith('notification.license_'),
      );
      expect(licence, locale).toEqual([]);
    }
  });

  it('the entitlement texts stay (the edition seam), worded for the edition and not for a licence', () => {
    for (const locale of LOCALES) {
      for (const key of ['error.UPDATE_NOT_ENTITLED', 'update.precheck.entitlement'] as const) {
        expect(MESSAGES[locale][key], `${locale}:${key}`).toBeTruthy();
        expect(MESSAGES[locale][key], `${locale}:${key}`).not.toMatch(/lisensi|licen[cs]e/i);
      }
    }
    expect(MESSAGES.id['error.UPDATE_NOT_ENTITLED']).toBe('Rilis ini tidak tercakup edisi ini.');
    expect(MESSAGES.en['error.UPDATE_NOT_ENTITLED']).toBe('This edition does not cover this release.');
  });

  it('1d: the operations page has the schemaHold instruction (naming the backup) and the database-restore label', () => {
    for (const locale of LOCALES) {
      const table = MESSAGES[locale] as Record<string, string>;
      expect(placeholders(table['ops.page.schema_hold'] as string), `${locale}:ops.page.schema_hold`).toEqual(['backupId']);
      expect(table['ops.page.db_restore_needed'], `${locale}:ops.page.db_restore_needed`).toBeTruthy();
      expect(placeholders(table['ops.page.db_restore_needed'] as string)).toEqual([]);
    }
  });

  it('states the two enumeration-sensitive login errors without saying whether the account exists', () => {
    const reveals = /(tidak ditemukan|tidak terdaftar|belum terdaftar|not found|does not exist|no such|unknown (user|account))/i;
    for (const locale of LOCALES) {
      for (const code of ['AUTH_INVALID_CREDENTIALS', 'AUTH_TOO_MANY_ATTEMPTS'] as const) {
        expect(MESSAGES[locale][`error.${code}`], `${locale}:${code}`).not.toMatch(reveals);
        expect(placeholders(MESSAGES[locale][`error.${code}`])).toEqual([]);
      }
    }
  });

  it('S28: the test-profile keys exist under the test profile', () => {
    for (const locale of LOCALES) {
      for (const key of TEST_ONLY_KEYS) expect(Object.keys(MESSAGES[locale])).toContain(key);
    }
  });

  it('S28: under a production profile the two test-profile keys are gone from both catalogs, nothing else is', async () => {
    const testKeys = Object.keys(MESSAGES.id).sort();
    vi.resetModules();
    vi.stubGlobal('__BUILD_PROFILE__', 'production');
    const production = await import('../src/i18n/index.js');
    for (const locale of LOCALES) {
      const keys = Object.keys(production.MESSAGES[locale]).sort();
      expect(keys).toEqual(testKeys.filter((key) => !(TEST_ONLY_KEYS as readonly string[]).includes(key)));
    }
  });

  it('S28: an undefined __BUILD_PROFILE__ counts as production', async () => {
    vi.resetModules();
    vi.stubGlobal('__BUILD_PROFILE__', undefined);
    const production = await import('../src/i18n/index.js');
    for (const locale of LOCALES) {
      for (const key of TEST_ONLY_KEYS) expect(Object.keys(production.MESSAGES[locale])).not.toContain(key);
    }
  });
});

describe('t', () => {
  it('returns the catalog text of the locale', () => {
    expect(t('id', 'role.super_admin')).toBe(MESSAGES.id['role.super_admin']);
    expect(t('en', 'opac.home.title')).toBe(MESSAGES.en['opac.home.title']);
    expect(t('id', 'opac.home.title')).not.toBe(t('en', 'opac.home.title'));
  });

  it('fills {placeholders}, strings and numbers alike', () => {
    expect(t('id', 'opac.error.body', { code: 'AB12CD34' })).toContain('AB12CD34');
    expect(t('en', 'opac.error.body', { code: 'AB12CD34' })).toContain('AB12CD34');
    const body = t('id', 'mail.password_reset.body', {
      name: 'Budi',
      username: 'budi',
      library: 'Perpustakaan Cempaka',
      link: 'https://perpus.test/admin/reset-password#token=abc',
      minutes: 30,
    });
    expect(body).toContain('Budi');
    expect(body).toContain('https://perpus.test/admin/reset-password#token=abc');
    expect(body).toContain('30');
    expect(body).not.toMatch(/\{[a-z]+\}/);
  });

  it('fills a placeholder everywhere it occurs', () => {
    const text = t('en', 'mail.password_reset.body', {
      name: 'Dewi',
      username: 'dewi',
      library: 'Cempaka Library',
      link: 'L',
      minutes: 30,
    });
    expect(text.split('Cempaka Library').length - 1).toBe(
      MESSAGES.en['mail.password_reset.body'].split('{library}').length - 1,
    );
  });

  it('leaves an unknown placeholder as written, and a placeholder given no value too', () => {
    expect(t('id', 'opac.error.body', { other: 'x' })).toBe(MESSAGES.id['opac.error.body']);
    expect(t('id', 'opac.error.body')).toBe(MESSAGES.id['opac.error.body']);
    expect(t('id', 'opac.error.body')).toContain('{code}');
    // An extra parameter nobody asked for does nothing.
    expect(t('id', 'opac.error.body', { code: 'Z', extra: 'y' })).toBe(t('id', 'opac.error.body', { code: 'Z' }));
  });

  it('substitutes in one pass: a value that looks like a placeholder is not expanded again', () => {
    const out = t('id', 'opac.error.body', { code: '{code}' });
    expect(out).toContain('{code}');
    const mail = t('id', 'mail.password_reset.body', {
      name: '{link}',
      username: 'u',
      library: 'L',
      link: 'https://x',
      minutes: 30,
    });
    expect(mail).toContain('{link}');
  });

  it('treats the value literally: replacement patterns such as $& and $1 mean nothing', () => {
    expect(t('id', 'opac.error.body', { code: '$&$1$$' })).toContain('$&$1$$');
  });

  it('never resolves a placeholder through the prototype chain', () => {
    // `{constructor}` and `{toString}` are not in the params object, only on its prototype: they stay as written.
    expect(fillPlaceholders('{constructor} {toString} {hasOwnProperty} {code}', { code: 'ok' })).toBe(
      '{constructor} {toString} {hasOwnProperty} ok',
    );
    expect(fillPlaceholders('{__proto__}', {})).toBe('{__proto__}');
    // A param named like an Object.prototype member is just a param.
    expect(fillPlaceholders('{toString}/{code}', { code: 'ok', toString: 'x' })).toBe('x/ok');
    // t() fills through the same helper.
    expect(t('id', 'opac.error.body', { code: 'ok' })).toBe(fillPlaceholders(MESSAGES.id['opac.error.body'], { code: 'ok' }));
  });

  it('falls back to the default locale for a locale it does not know, and to the key for a key it does not have', () => {
    expect(t('fr' as Locale, 'opac.home.title')).toBe(MESSAGES.id['opac.home.title']);
    expect(t('id', 'no.such.key' as MessageKey)).toBe('no.such.key');
  });
});

describe('resolveLocale', () => {
  it('takes the first candidate that is a locale', () => {
    expect(resolveLocale(null, 'fr', 'en')).toBe('en');
    expect(resolveLocale('en', 'id')).toBe('en');
    expect(resolveLocale('id', 'en')).toBe('id');
    expect(resolveLocale(undefined, '', 'en', 'id')).toBe('en');
  });

  it('answers Indonesian when no candidate is a locale', () => {
    expect(resolveLocale()).toBe('id');
    expect(resolveLocale(null, undefined)).toBe('id');
    expect(resolveLocale('fr', 'de', '')).toBe('id');
  });

  it('matches exactly: no case folding, no region, no inherited property names', () => {
    expect(resolveLocale('EN')).toBe('id');
    expect(resolveLocale('en-US')).toBe('id');
    expect(resolveLocale(' en')).toBe('id');
    expect(resolveLocale('toString', '__proto__', 'constructor')).toBe('id');
  });
});
