import { afterEach, describe, expect, it, vi } from 'vitest';
import { AUDIT_ACTIONS } from '../src/audit-actions.js';
import { ERROR_CODES } from '../src/errors.js';
import { NEEDS_ATTENTION, OP_KINDS, OP_STATES } from '../src/ops.js';
import { permissionCatalog } from '../src/permissions.js';
import { DOCUMENT_ASPECTS, DOCUMENT_KINDS, L12_FEATURES } from '../src/accreditation-vocab.js';
import { ANNEX_COLLECTION_EN, ANNEX_COLLECTION_ID } from '../src/i18n/k1/annex-collection.js';
import { ANNEX_REGISTERS_EN, ANNEX_REGISTERS_ID } from '../src/i18n/k1/annex-registers.js';
import { ANNEX_USAGE_EN, ANNEX_USAGE_ID } from '../src/i18n/k1/annex-usage.js';
import { COLLECTION_REPORTS_EN, COLLECTION_REPORTS_ID } from '../src/i18n/k1/collection-reports.js';
import { DEFAULT_LOCALE, LOCALES, MESSAGES, fillPlaceholders, resolveLocale, t, type Locale, type MessageKey } from '../src/i18n/index.js';

/** The `{name}` placeholders of a template, as a sorted list of distinct names. */
function placeholders(template: string): string[] {
  return [...new Set([...template.matchAll(/\{([A-Za-z_][A-Za-z0-9_]*)\}/g)].map((m) => m[1] as string))].sort();
}

const TEST_ONLY_KEYS = [
  'perm.test.branch.manage',
  'perm.module.test',
  // The labels of the test-profile report definitions.
  'report.test.rows.title',
  'report.test.personal.title',
  'report.test.document.title',
  'report.column.n',
  'report.column.text',
  'report.column.amount',
  'report.param.rows',
  'report.param.texts',
  'report.param.countless',
] as const;

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
      // ---- Komunitas (notices): the hold shelf to clear, and reminders that did not go out ----
      circulation_hold_shelf: ['count'],
      circulation_notices_failed: ['failed', 'skipped'],
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

  it('S28: under a production profile the test-profile keys are gone from both catalogs, nothing else is', async () => {
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

// ---- Komunitas K1 (reports and accreditation) ----
// The shared texts of reports and accreditation: the registry labels, the fixed workspace and output texts, the notes,
// the component, indicator, option, aspect, element and evidence labels, the suggested actions and the report
// glossary. The owners of the four shared slot files add their fixed row labels there, under their own prefix, and
// those are held to the same rules here.

const table = (locale: Locale): Readonly<Record<string, string>> => MESSAGES[locale] as Readonly<Record<string, string>>;

/** Every key of a family (the keys that start with `prefix`), sorted. */
const family = (prefix: string): string[] => Object.keys(MESSAGES.id).filter((k) => k.startsWith(prefix)).sort();

/** The indicator codes of the school instruments (the senior-secondary numbering, 42 in all). */
const IK_CODES = [
  ...['K1', 'K2', 'K3', 'K4', 'K5', 'K6', 'K7', 'K8'],
  ...['SP1', 'SP2', 'SP3', 'SP4', 'SP5', 'SP6', 'SP7'],
  ...Array.from({ length: 14 }, (_, i) => `L${i + 1}`),
  ...['T1', 'T2', 'T3', 'T4', 'T5'],
  ...['F1', 'F2', 'F3', 'F4'],
  ...['G1', 'G2', 'G3', 'G4'],
];

/** The evidence checklist codes per indicator. */
const EVIDENCE: Readonly<Record<string, readonly string[]>> = {
  K1: ['title_list', 'catalogue_screenshot', 'ddc_recap'],
  K2: ['fiction_list', 'fiction_screenshot'],
  K3: ['policy_document'],
  K4: ['survey_report', 'activity_list'],
  K5: ['used_list', 'use_photo', 'usage_table'],
  K6: ['additions_table', 'additions_signed'],
  K7: ['processed_list', 'shelf_photos', 'data_quality', 'scanner_photo'],
  K8: ['preservation_list', 'preservation_photos'],
  SP1: ['floor_plan', 'room_photos'],
  SP2: ['shelf_photos'],
  SP3: ['furniture_list', 'furniture_photos'],
  SP4: ['ict_list', 'population_source', 'ict_photos'],
  SP5: ['staff_pc_list', 'staff_annex'],
  SP6: ['bandwidth_proof'],
  SP7: ['learning_list', 'learning_photos'],
  L1: ['procedure_documents', 'procedure_display'],
  L2: ['service_list', 'service_photos'],
  L3: ['activity_list', 'activity_reports'],
  L4: ['activity_list', 'activity_reports'],
  L5: ['activity_list', 'activity_reports'],
  L6: ['local_work_list', 'local_work_screenshot'],
  L7: ['activity_list', 'activity_reports'],
  L8: ['activity_list', 'activity_reports'],
  L9: ['activity_list', 'activity_reports'],
  L10: ['survey_report', 'activity_list'],
  L11: ['membership_screenshot', 'loan_screenshot', 'return_screenshot', 'opac_screenshot', 'website_screenshot'],
  L12: ['feature_screenshots'],
  L13: ['activity_list', 'promotion_materials'],
  L14: ['l14_annex', 'population_source', 'visitor_log'],
  T1: ['head_diploma', 'head_training', 'head_appointment'],
  T2: ['performance_report'],
  T3: ['staff_annex', 'staff_appointments', 'staff_certificates'],
  T4: ['training_recap', 'training_certificates'],
  T5: ['ratio_sheet', 'population_source'],
  F1: ['founding_decree', 'npp_certificate', 'duties', 'org_structure'],
  F2: ['pos_documents'],
  F3: ['school_program'],
  F4: ['lesson_plans', 'teacher_recap'],
  G1: ['library_program'],
  G2: ['agreements', 'partnership_photos', 'partnership_list'],
  G3: ['budget_recap', 'rab_documents'],
  G4: ['report_documents', 'report_list'],
};

/** The indicators whose answer is chosen from labelled options a to d. */
const OPTION_IKS = ['SP1', 'SP2', 'SP3', 'F3', 'K7', 'L11', 'T1', 'T3', 'G4'];

/** The notes of indicators and of the SNP tab (the ones that wait for the members and visits milestone excluded). */
const NOTES = [
  'catalogue_synced',
  'recompute_after_catalogue',
  'truncated',
  'mandatory_missing',
  'register_empty',
  'input_missing',
  'population_missing',
  'activity_multi',
  'electronic_counted',
  'replacement_records',
  'fiction_rule',
  'k2_overlap',
  'items_without_received_date',
  'undated_share_high',
  'k6_tier',
  'k6_start_below_1000',
  'k6_no_start',
  'k7_unprocessed',
  'k7_almost',
  'collection_empty',
  'k7_threshold_lowered',
  'l6_kinds',
  'l6_manual',
  'usage_no_data',
  'usage_unit',
  'school_months',
  'school_months_prorated',
  'member_unknown',
  'visits_deduped',
  'guests_excluded',
  'staff_missing',
  'head_missing',
  'head_multiple',
  't1_equivalence',
  't4_scope',
  'g2_distinct',
  'budget_incomplete',
  'g4_rule',
  'g4_undated',
  'l3_sd_option_d',
  'l13_news',
  'l11_unverified',
  'l11_private',
  'l11_localhost',
  'base_url_unset',
  'base_url_public_guess',
  'l12_features',
  'l12_not_public',
  'l12_external',
  'sp1_floor',
  'sp3_mandatory_hint',
  'snp_textbook_default',
  'snp_serials_approx',
  'snp_tier_outside',
  'snp_start_below_1000',
  'snp_no_previous',
  'snp_not_available',
  'snp_selected',
];

/** The element codes of the required-element lists, the website features, the work kinds and the services. */
const ELEMENTS = [
  'rules',
  'sop_membership',
  'sop_loan',
  'sop_return',
  'founding_decree',
  'npp',
  'duties',
  'org_structure',
  'pos_collection',
  'pos_organisation',
  'pos_service',
  'pos_preservation',
  'pos_promotion',
  'pos_partnership',
  ...L12_FEATURES,
  'written_work',
  'clipping',
  'short_stories',
  'poetry',
  'review',
  'abstract',
  'reading_room',
  'circulation',
  'reference',
  'information_literacy',
  'speed_reading',
  'extension',
  'project_learning',
  'ict',
  'other',
];

/** Every report definition (the three test-profile ones included). */
const REPORT_IDS = [
  'collection.summary',
  'collection.ddc_recap',
  'collection.acquisitions',
  'collection.title_list',
  'collection.item_list',
  'collection.accession_register',
  'collection.data_quality',
  'collection.attachment_downloads',
  'accreditation.annex.ddc',
  'accreditation.annex.collection_matrix',
  'accreditation.annex.additions',
  'accreditation.annex.l14',
  'accreditation.annex.usage_monthly',
  'accreditation.annex.staff',
  'accreditation.annex.budgets',
  'accreditation.annex.activities',
  'accreditation.annex.partnerships',
  'accreditation.annex.documents',
  'accreditation.dossier',
  'accreditation.self_assessment',
  'accreditation.statement_1000',
  'members.list',
  // ---- Komunitas (member, visit and circulation reports) ----
  'members.summary',
  'members.expiring',
  'members.reprint_list',
  'visits.monthly',
  'visits.daily',
  'visits.list',
  'circulation.summary',
  'circulation.loans_by_class',
  'circulation.item_usage',
  'circulation.top_titles',
  'circulation.in_library',
  'circulation.loan_history',
  'circulation.open_loans',
  'circulation.overdue',
  'circulation.due_soon',
  'circulation.holds',
  'circulation.charges',
  'circulation.payments_daily',
  'circulation.top_borrowers',
  // ---- Komunitas K4 (stocktake) ----
  'stocktake.progress',
  'stocktake.missing',
  'stocktake.misplaced',
  'stocktake.by_officer',
  'stocktake.history',
  'test.rows',
  'test.personal',
  'test.document',
];

/** Every column key of the report definitions. */
const REPORT_COLUMNS = [
  ...['section', 'item', 'titles', 'items', 'class', 'label', 'group', 'year', 'total'],
  ...['c000', 'c100', 'c200', 'c300', 'c400', 'c500', 'c600', 'c700', 'c800', 'c900', 'c2x', 'cnon'],
  ...['barcode', 'title', 'collection_type', 'acq_date', 'acq_basis', 'price', 'acq_source', 'supplier'],
  ...['edition', 'publisher', 'place', 'isbn_issn', 'classification', 'call_number'],
  ...['inventory_no', 'status', 'location', 'received_date', 'authors', 'isbn', 'collation', 'source'],
  ...['problem', 'detail', 'attachment', 'mime', 'downloads', 'medium', 'kind', 'pct'],
  ...['month', 'student', 'teacher', 'edu_staff', 'school_visits', 'population'],
  ...['visits_student', 'visits_teacher', 'visits_edu_staff', 'visits_public', 'visits_other', 'visits_guest', 'loans', 'in_library_uses'],
  ...['name', 'position', 'role', 'is_librarian', 'employment', 'education', 'library_training', 'competency_cert', 'association_member'],
  ...['appointment_ref', 'starts_on', 'ends_on', 'training', 'organizer', 'held_on', 'hours', 'value'],
  ...['library', 'parent', 'parent_nonpersonnel', 'collection', 'community', 'participants', 'partner', 'scope'],
  ...['reference', 'issued_on', 'issued_by', 'aspects', 'valid_until'],
  ...['n', 'text', 'amount'],
  ...['member_no', 'member_type', 'gender', 'member_status', 'joined_on', 'expires_on', 'email', 'phone', 'address'],
  // ---- Komunitas (member, visit and circulation reports) ----
  ...['registered', 'active', 'expired', 'suspended', 'days_left', 'source_no', 'source_barcode'],
  ...['m01', 'm02', 'm03', 'm04', 'm05', 'm06', 'm07', 'm08', 'm09', 'm10', 'm11', 'm12'],
  ...['date', 'weekday', 'members', 'guests', 'visited_at', 'institution', 'purpose', 'rank'],
  ...['loaned_on', 'due_on', 'returned_on', 'renewals', 'outcome', 'days_late', 'fine', 'placed_on', 'queue_position', 'pickup_until'],
  ...['charged_on', 'description', 'paid', 'waived', 'balance', 'paid_on', 'method', 'staff', 'payments', 'receipt_no', 'voided'],
  // ---- Komunitas K4 (stocktake) ----
  ...['expected', 'found', 'misplaced', 'on_loan', 'pending', 'unexpected', 'unknown_codes', 'material_type', 'expected_location'],
  ...['scanned_location', 'scanned_at', 'officer', 'session', 'branch', 'started_at', 'finished_at'],
];

/** Every parameter name of the report definitions. */
const REPORT_PARAMS = [
  ...['periodId', 'branchId', 'asOf', 'locationId', 'collectionTypeId', 'materialTypeId', 'divisions', 'breakdown'],
  ...['yearFrom', 'yearTo', 'acqSource', 'unit', 'detailYear', 'classPrefix', 'languageId', 'input', 'pubYearFrom', 'pubYearTo'],
  ...['fictionOnly', 'localWorkOnly', 'audience', 'status', 'received', 'created', 'access'],
  ...['section', 'window', 'kinds', 'learning', 'externalLiteracy', 'part', 'zipMode'],
  ...['rows', 'texts', 'countless'],
  ...['memberTypeId', 'className', 'memberStatus', 'homeBranchId', 'joined', 'expires', 'contact'],
  // ---- Komunitas (member, visit and circulation reports) ----
  ...['range', 'mainClass', 'year', 'month', 'search', 'minLoans', 'top', 'member', 'titleWords', 'barcode', 'loaned', 'loanState'],
  ...['overdueOnly', 'groupBy', 'minDaysLate', 'due', 'days', 'holdStatus', 'placed', 'chargeStatus', 'charged', 'method'],
  ...['view', 'kind', 'guestsOnly', 'institution', 'visited', 'source', 'rowsBy'],
  // ---- Komunitas K4 (stocktake) ----
  ...['stocktakeId'],
];

/** The options of every `status` parameter that has no vocabulary list of its own. */
const REPORT_OPTIONS: Readonly<Record<string, readonly string[]>> = {
  breakdown: ['none', 'material_type', 'collection_type', 'language', 'fnr', 'medium'],
  unit: ['titles', 'items'],
  section: ['staff', 'trainings', 'ratio'],
  window: ['period', 'three_periods'],
  part: ['all', 'request_letter'],
  zipMode: ['combined', 'components'],
  access: ['public', 'staff'],
  // ---- Komunitas (member, visit and circulation reports) ----
  top: ['10', '50'],
  loanState: ['open', 'returned', 'lost'],
  groupBy: ['member', 'item'],
  view: ['days', 'receipts'],
  kind: ['members', 'items'],
  rowsBy: ['member_type', 'accred_group', 'class', 'source'],
};

/** The four shared slot files of the later report owners, with the prefix of their keys. */
const SLOTS = [
  { name: 'collection-reports', prefix: 'report.row.collection.', id: COLLECTION_REPORTS_ID, en: COLLECTION_REPORTS_EN },
  { name: 'annex-registers', prefix: 'report.row.registers.', id: ANNEX_REGISTERS_ID, en: ANNEX_REGISTERS_EN },
  { name: 'annex-usage', prefix: 'report.row.usage.', id: ANNEX_USAGE_ID, en: ANNEX_USAGE_EN },
  { name: 'annex-collection', prefix: 'report.row.accred_collection.', id: ANNEX_COLLECTION_ID, en: ANNEX_COLLECTION_EN },
] as const;

/** A research, decision or criterion reference, or a planning status mark: never part of a product text. */
const PLANNING_ID = /\b(DK|P|Q|U|R)-?\d{1,3}\b|\b[rR][1-5] §|\bK\d-C\d{2}\b|K1P-|A§|\[(P|U|A)/;

describe('reports and accreditation texts', () => {
  it('a message in both languages for each new permission, module, audit action and error code', () => {
    const perms = ['reports.statistics.read', 'accreditation.workspace.read', 'accreditation.workspace.manage'];
    const audits = AUDIT_ACTIONS.slice(AUDIT_ACTIONS.indexOf('reports.run.start'), AUDIT_ACTIONS.indexOf('members.member.create'));
    expect(audits).toHaveLength(18);
    const codes = [
      'REPORT_TOO_LARGE',
      'REPORT_RUN_EXPIRED',
      'ACCRED_PERIOD_FROZEN',
      'ACCRED_INSTRUMENT_MISMATCH',
      'ACCRED_PERIOD_SPAN',
      'ACCRED_RESULTS_STALE',
      'MIGRATION_PRECHECK_FAILED',
    ];
    const keys = [
      ...perms.map((p) => `perm.${p}`),
      'perm.module.reports',
      'perm.module.accreditation',
      ...audits.map((a) => `audit.${a}`),
      ...codes.map((c) => `error.${c}`),
    ];
    for (const key of keys) {
      expect(table('id')[key], `id:${key}`).toBeTruthy();
      expect(table('en')[key], `en:${key}`).toBeTruthy();
      expect(table('id')[key], key).not.toBe(table('en')[key]);
      expect(placeholders(table('id')[key]!), key).toEqual([]);
    }
    expect(table('id')['perm.reports.statistics.read']).toBe('Melihat dan mengekspor laporan agregat (tanpa data pribadi)');
    expect(table('id')['perm.accreditation.workspace.read']).toBe('Melihat ruang akreditasi, hasil, snapshot, dan berkas bukti');
    expect(table('id')['perm.module.reports']).toBe('Laporan');
    expect(table('id')['perm.module.accreditation']).toBe('Akreditasi');
  });

  it('the fixed workspace texts read as written, the disclaimer word for word', () => {
    expect(table('id')['accred.disclaimer.estimate']).toBe(
      'Perkiraan berdasarkan data ALTIS dan isian Anda. Bukan nilai resmi; penilaian resmi dilakukan asesor Perpusnas.',
    );
    expect(table('id')['accred.source.copy']).toBe('salinan, belum dibandingkan dengan JDIH');
    expect(table('id')['accred.prereq.failed']).toBe('Belum memenuhi prasyarat pendaftaran (Pasal 9)');
    expect(placeholders(table('id')['accred.prereq.titles']!)).toEqual(['count', 'date']);
    expect(['A', 'B', 'C', 'D'].map((g) => table('id')[`accred.predicate.${g}`])).toEqual(['Sangat Baik', 'Baik', 'Cukup Baik', 'Tidak Terakreditasi']);
    expect(table('id')['accred.na.exercise']).toBe('Perkiraan latihan: prasyarat pendaftaran belum terpenuhi');
    expect(table('en')['accred.na.exercise']).toBe('Practice estimate: registration prerequisites not met');
    expect(family('accred.prereq.')).toEqual(['accred.prereq.failed', 'accred.prereq.founding_decree', 'accred.prereq.npp', 'accred.prereq.titles']);
  });

  it('every note, and no note of the members and visits milestone yet', () => {
    expect(family('accred.note.')).toEqual(NOTES.map((n) => `accred.note.${n}`).sort());
    for (const k2 of ['online_visits', 'class_visit_adjusted', 'all_registered']) expect(table('id')[`accred.note.${k2}`], k2).toBeUndefined();
    expect(placeholders(table('id')['accred.note.undated_share_high']!)).toEqual(['max', 'pct']);
    expect(placeholders(table('id')['accred.note.school_months_prorated']!)).toEqual(['divisor', 'months']);
  });

  it('the components, every indicator (with the primary-school variants), and the options of the chosen indicators', () => {
    expect(family('accred.component.')).toEqual(['F', 'G', 'K', 'L', 'SP', 'T'].map((c) => `accred.component.${c}`));
    const labels = family('accred.ik.').filter((k) => !k.includes('.option.'));
    expect(labels).toEqual([...IK_CODES.map((c) => `accred.ik.${c}`), 'accred.ik.L4.sd', 'accred.ik.L12.sd'].sort());
    const options = family('accred.ik.').filter((k) => k.includes('.option.'));
    expect(options).toEqual(OPTION_IKS.flatMap((ik) => ['a', 'b', 'c', 'd'].map((o) => `accred.ik.${ik}.option.${o}`)).sort());
    // The middle options of four indicators wait for the verified decree text and point to the instrument.
    for (const ik of ['SP1', 'SP2', 'SP3', 'F3']) {
      expect(table('id')[`accred.ik.${ik}.option.b`], ik).toBe('Kondisi di antara pilihan a dan c; lihat deskripsi pilihan b pada instrumen');
      expect(table('id')[`accred.ik.${ik}.option.c`], ik).toBe('Kondisi di antara pilihan b dan d; lihat deskripsi pilihan c pada instrumen');
    }
  });

  it('the aspect labels follow DOCUMENT_ASPECTS, and every element has its label', () => {
    const aspects = DOCUMENT_KINDS.flatMap((kind) => DOCUMENT_ASPECTS[kind].map((code) => `accred.aspect.${kind}.${code}`));
    expect(family('accred.aspect.')).toEqual(aspects.sort());
    expect(table('id')['accred.aspect.library_program.a3']).toBe('Bidang 3');
    expect(family('accred.element.')).toEqual([...new Set(ELEMENTS)].map((e) => `accred.element.${e}`).sort());
  });

  it('every evidence item of every indicator, and one suggested action per indicator', () => {
    const evidence = Object.entries(EVIDENCE).flatMap(([ik, codes]) => codes.map((code) => `accred.evidence.${ik}.${code}`));
    expect(Object.keys(EVIDENCE)).toEqual(IK_CODES);
    expect(family('accred.evidence.')).toEqual(evidence.sort());
    expect(family('accred.gap.action.')).toEqual(IK_CODES.map((ik) => `accred.gap.action.${ik}`).sort());
  });

  it('the report glossary: titles, columns, parameters, options, groups, sources and fixed texts', () => {
    expect(family('report.').filter((k) => k.endsWith('.title') && !k.startsWith('report.column.') && !k.startsWith('report.row.'))).toEqual(
      REPORT_IDS.map((id) => `report.${id}.title`).sort(),
    );
    expect(family('report.column.')).toEqual([...new Set(REPORT_COLUMNS)].map((c) => `report.column.${c}`).sort());
    expect(family('report.param.')).toEqual([...new Set(REPORT_PARAMS)].map((p) => `report.param.${p}`).sort());
    expect(family('report.group.')).toEqual(
      ['fnr.fiction', 'fnr.nonfiction', 'fnr.reference', 'medium.electronic', 'medium.print'].map((g) => `report.group.${g}`),
    );
    expect(family('report.source.')).toEqual(['report.source.manual', 'report.source.none', 'report.source.slims']);
    expect(family('report.data_quality.problem.')).toEqual(
      ['item_no_acq_date', 'item_no_call_number', 'item_no_location', 'item_no_received_date', 'record_no_classification'].map(
        (p) => `report.data_quality.problem.${p}`,
      ),
    );
    expect(family('report.acq_basis.')).toEqual(['input_on', 'item_created', 'received', 'record_created'].map((b) => `report.acq_basis.${b}`));
    expect(family('report.summary.section.').length).toBeGreaterThan(0);
    expect(table('id')['report.row.total']).toBe('Jumlah');
    expect(table('en')['report.row.total']).toBe('Total');
    expect(table('id')['report.non_latin_note']).toBe('teks non-Latin: lihat XLSX/CSV');
    expect(table('id')['report.footer']).toBe('Dicetak {date} oleh {name} · halaman {page}/{pages}');
    expect(table('en')['report.footer']).toBe('Printed {date} by {name} · page {page}/{pages}');
    expect(table('id')['report.undated']).toBe('tanpa tanggal');
    expect(table('id')['report.export_only']).toBe('Laporan ini terlalu besar untuk pratinjau; ekspor saja.');
  });

  it('every report.option family holds exactly the options of its parameter', () => {
    const found = family('report.option.');
    expect(found).toEqual(Object.entries(REPORT_OPTIONS).flatMap(([param, values]) => values.map((v) => `report.option.${param}.${v}`)).sort());
    for (const [param, values] of Object.entries(REPORT_OPTIONS)) {
      expect(found.filter((k) => k.startsWith(`report.option.${param}.`)).length, param).toBe(values.length);
    }
  });

  it('the accreditation and report texts carry no planning reference, status mark or section sign', () => {
    const keys = Object.keys(MESSAGES.id).filter((k) => k.startsWith('accred.') || k.startsWith('report.') || k.startsWith('vocab.'));
    for (const locale of LOCALES) {
      for (const key of keys) {
        const text = table(locale)[key]!;
        expect(text, `${locale}:${key}`).not.toMatch(PLANNING_ID);
        expect(text, `${locale}:${key}`).not.toContain('§');
        expect(text, `${locale}:${key}`).not.toContain('[');
      }
    }
  });

  it.each(SLOTS)('the slot $name: the same keys in both languages, under its prefix, held by MESSAGES as written', ({ prefix, id, en }) => {
    const ids = id as Readonly<Record<string, string>>;
    const ens = en as Readonly<Record<string, string>>;
    expect(Object.keys(ens).sort()).toEqual(Object.keys(ids).sort());
    for (const [key, text] of Object.entries(ids)) {
      expect(key.startsWith(prefix), key).toBe(true);
      expect(text.trim(), key).not.toBe('');
      expect(placeholders(ens[key]!), key).toEqual(placeholders(text));
      expect(ens[key], key).not.toBe(text);
      expect(table('id')[key], key).toBe(text);
      expect(table('en')[key], key).toBe(ens[key]);
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
