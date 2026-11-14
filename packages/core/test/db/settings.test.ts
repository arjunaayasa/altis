import { createHash, randomBytes } from 'node:crypto';
import fsp from 'node:fs/promises';
import os from 'node:os';
import path from 'node:path';
import { PHASE1_MIGRATIONS, SETTINGS_SCOPE_CLASS, runMigrations, withTx } from '@altis/db';
import { IP_TRUST_VALUES, isDomainError, newId } from '@altis/shared';
import { afterAll, beforeAll, beforeEach, describe, expect, it } from 'vitest';
import { engineLabel, testDb, testDbContext, type TestDbHandle } from '../../../../tools/test/test-db.js';
import { openValue, secretAad, type KeyringEntry } from '../../src/crypto/secret-box.js';
import { SETTINGS, groupKeys, type SettingKey, type SettingsGroup } from '../../src/settings/registry.js';
import { createSettingsCache, readSecret, readSettings, writeSettings } from '../../src/settings/service.js';
import { loadAccredSettings } from '../../src/settings/accreditation.js';
import { uploadContext } from '../../src/files/contexts.js';
import { acceptChunk, completeUpload, createUpload, uploadOwner } from '../../src/files/uploads.js';

// The settings registry and service (spec §7.6, §7.8; D26, D41): typed keys with defaults, JSON text in
// `settings.value` (JSON text), write-only secrets sealed with AAD `settings.value.<key>`, a purpose-bound secret
// (the SMTP password) cleared when its host, port or username change without a new one, and a cache that other
// processes may serve stale for at most 30 s (P6) while the writer's own process sees its write at once (M17).
// On the engine picked by ALTIS_TEST_DB.

const ctx = testDbContext();
/** A fixed `now` in the past. */
const NOW = 1_767_225_600_000;
const T0 = 1_800_000_000_000;

const keyring: KeyringEntry[] = [{ kid: 'k1', key: randomBytes(32).toString('base64url'), active: true }];
const otherKeyring: KeyringEntry[] = [{ kid: 'k2', key: randomBytes(32).toString('base64url'), active: true }];

/** One valid value per key (the library ones differ from what install seeds); typed as a Record so that a new key breaks the compile until it is listed. */
const SAMPLE: Record<SettingKey, unknown> = {
  'library.name': 'Perpustakaan SMA 1',
  'library.type': 'sekolah',
  'library.address': 'Jl. Merdeka 1\nBandung',
  'library.timezone': 'Asia/Makassar',
  'library.locale': 'en',
  'email.sender_name': 'Perpus SMA 1',
  'email.template.password_reset.id.subject': 'Atur ulang sandi',
  'email.template.password_reset.id.body': 'Buka {{link}}',
  'email.template.password_reset.en.subject': 'Reset your password',
  'email.template.password_reset.en.body': 'Open {{link}}',
  'security.password_min_length': 12,
  'security.session_idle_minutes': 45,
  'opac.welcome.id': 'Selamat datang',
  'opac.welcome.en': 'Welcome',
  'opac.accent': 'blue',
  // ---- Phase 2 (catalog): Task 2 ----
  'opac.resultsPerPage': 30,
  'opac.indexable': false,
  'opac.oai.enabled': false,
  'opac.oai.adminEmail': 'pustakawan@example.org',
  'opac.showShelfMap': false,
  'opac.newTitlesCount': 24,
  'catalog.marcOrgCode': 'IdJaPN',
  'catalog.defaultMaterialTypeId': '01J0000000000000000000000A',
  'catalog.defaultCollectionTypeId': '01J0000000000000000000000B',
  'catalog.currency': 'USD',
  'catalog.barcode.patterns': [
    { id: 'default', name: 'Bawaan', prefix: 'B', digits: 7, suffix: '' },
    { id: 'ref', name: 'Referensi', prefix: 'REF-', digits: 5, suffix: '-R' },
  ],
  'catalog.barcode.symbology': 'code39',
  'catalog.labelProfiles': [
    {
      id: 'kecil',
      name: 'Label kecil',
      kind: 'barcode',
      page: { wMm: 100, hMm: 150 },
      marginMm: { t: 5, r: 5, b: 5, l: 5 },
      cols: 2,
      rows: 4,
      labelWMm: 42.5,
      labelHMm: 30,
      gapXMm: 5,
      gapYMm: 5,
      fontPt: 7.5,
      header: 'Perpus SMA 1',
      showLibraryName: true,
      symbology: 'code128',
      titleMaxChars: 24,
      border: false,
    },
  ],
  'catalog.sru.servers': [
    {
      id: 'kampus',
      name: 'Perpustakaan Kampus',
      url: 'https://sru.example.org/sru',
      version: '2.0',
      recordSchema: 'marcxml',
      indexes: { isbn: 'bath.isbn', title: 'dc.title', author: 'dc.creator', any: 'cql.serverChoice' },
      enabled: true,
    },
  ],
  'catalog.sru.allowPrivateHosts': true,
  'catalog.isbn.arsyaEnabled': true,
  'catalog.attachment.maxMb': 500,
  'catalog.dedupe.threshold': 90,
  'smtp.host': 'smtp.example.org',
  'smtp.port': 465,
  'smtp.security': 'tls',
  'smtp.username': 'mailer',
  'smtp.password': 'rahasia',
  'smtp.from': 'perpus@example.org',
  'system.ip_trust': 'spoofable',
  'system.clock_anomaly': { detectedAt: 1_800_000_000_000, maxSeen: 1_800_000_100_000 },
  'system.clock_confirmed': { at: 1_800_000_200_000, auditSeq: 42 },
  'system.run.worker': 1_800_000_300_000,
  'system.run.cron_cli': 1_800_000_310_000,
  'system.run.cron_http': 1_800_000_320_000,
  'system.run.drive': 1_800_000_330_000,
  'system.run.piggyback': 1_800_000_340_000,
  'system.probe': {
    at: 1_800_000_400_000,
    polling: true,
    sse: false,
    methods: { put: true, patch: true, delete: false },
    chunkBytes: 262_144,
    xff: { spoofable: false, suggestedHops: 1 },
  },
  'system.exposure': { at: 1_800_000_500_000, ok: false, url: 'https://perpus.test/app.js' },
  'system.data_usage': { at: 1_800_000_600_000, bytes: 1_048_576, files: 12, truncated: false },
  'audit.anchor': { seq: 120, hash: '0123456789abcdef'.repeat(4) },
  'audit.verified': { at: 1_800_000_700_000, ok: true, head: 120, headHash: 'fedcba9876543210'.repeat(4), brokenAt: null },
  'system.events_floor': 1234,
  'realtime.sse': true,
  // 1d (Task 1)
  'update.channel': 'beta',
  'update.check': {
    at: 1_800_000_800_000,
    ok: true,
    error: null,
    seq: 7,
    available: {
      version: '0.2.0-test',
      channel: 'beta',
      releasedAt: '2026-11-01',
      bootProtocol: 1,
      minUpgradeFrom: '0.0.0',
      minCodeVersionAfter: '0.1.0-test',
      minNode: '22.16.0',
      minDb: { mysql: '8.0.0', mariadb: '10.6.0', postgres: '15.0' },
      size: 12_345_678,
      sha256: '0123456789abcdef'.repeat(4),
      url: 'https://updates.example.org/packages/altis-0.2.0-test.zip',
      notesUrl: null,
    },
    latest: '0.3.0-test',
    steppingStone: true,
    expiresAt: 1_800_600_000_000,
  },
  'update.notified': '0.2.0-test',
  'update.dashboard_check_at': 1_800_000_900_000,
  'update.bundled_blocked': { version: '0.2.0-test', at: 1_800_001_000_000, failures: ['min_node', 'min_db'] },
  'system.keyset_full': { at: 1_800_001_600_000, refused: 3 },
  // ---- Komunitas K1 (settings) ----
  'accreditation.schoolYearStartMonth': 1,
  'accreditation.fiction.collectionTypeCodes': ['FIKSI', 'NOVEL'],
  'accreditation.fiction.callNumberPrefixes': ['F'],
  'accreditation.fiction.ddcPrefixes': ['899.2'],
  'accreditation.referenceCollectionTypeCodes': ['REF', 'RUJUKAN'],
  'accreditation.electronicMaterialTypeCodes': ['EBOOK', 'EJURNAL'],
  'accreditation.usedUnit': 'items',
  'accreditation.websiteFeatures': { profilePageId: '01J0000000000000000000000C', socialUrls: ['https://instagram.com/perpus'] },
  'accreditation.liveFrom': '2025-07-01',
  'accreditation.evidence.maxMb': 8,
  'accreditation.evidence.componentLimitMb': 20,
  'accreditation.textbookCollectionTypeCodes': ['TEKS'],
  'accreditation.k7.processedThresholdPct': 90,
  'accreditation.undatedShareMaxPct': 5,
  'accreditation.visits.dedupeLegacy': false,
  'accreditation.unknownMemberGroup.default': 'teacher',
  'visits.dedupeMinutes': 30,
  // ---- Komunitas (holds) ----
  'circulation.holds.enabled': false,
  'circulation.holds.opac': false,
  'circulation.holds.onlyWhenNoneAvailable': false,
  'circulation.holds.pickupDays': 5,
  // ---- Komunitas (circulation core) ----
  'circulation.loanVoidMinutes': 5,
  'circulation.lost.useItemPrice': false,
  'circulation.lost.processingFeeMinor': 500_000,
  'members.clearance.prefix': 'SBP',
  'members.clearance.profile': { paper: 'A5', city: 'Bandung', signerTitle: 'Kepala Perpustakaan', signerName: 'Contoh', signerId: 'NIP 1', bodyText: '' },
};

/** Every key of scope `instance` (machine state of this installation, kept by a restore), in registry order; all are in group `system`. */
const INSTANCE_KEYS: readonly SettingKey[] = [
  'system.ip_trust',
  'system.clock_anomaly',
  'system.clock_confirmed',
  'system.run.worker',
  'system.run.cron_cli',
  'system.run.cron_http',
  'system.run.drive',
  'system.run.piggyback',
  'system.probe',
  'system.exposure',
  'system.data_usage',
  'audit.anchor',
  'audit.verified',
  'system.events_floor',
  'realtime.sse',
  // 1d (Task 1): update checks and bundled releases, and the keyset writer's refusals (a restore never undoes them).
  // The community edition has no licence key.
  'update.channel',
  'update.check',
  'update.notified',
  'update.dashboard_check_at',
  'update.bundled_blocked',
  'system.keyset_full',
];

/** The 1d keys whose absent row does not read as null. */
const NON_NULL_1D_DEFAULTS: Partial<Record<SettingKey, unknown>> = {
  'update.channel': 'stable',
};

const GROUPS: SettingsGroup[] = ['library', 'email', 'security', 'opac', 'smtp', 'system', 'catalog', 'accreditation', 'visits', 'circulation', 'members'];

/** The accreditation keys, in registry order: the sixteen of group `accreditation`. */
const ACCREDITATION_KEYS: readonly SettingKey[] = [
  'accreditation.schoolYearStartMonth',
  'accreditation.fiction.collectionTypeCodes',
  'accreditation.fiction.callNumberPrefixes',
  'accreditation.fiction.ddcPrefixes',
  'accreditation.referenceCollectionTypeCodes',
  'accreditation.electronicMaterialTypeCodes',
  'accreditation.usedUnit',
  'accreditation.websiteFeatures',
  'accreditation.liveFrom',
  'accreditation.evidence.maxMb',
  'accreditation.evidence.componentLimitMb',
  'accreditation.textbookCollectionTypeCodes',
  'accreditation.k7.processedThresholdPct',
  'accreditation.undatedShareMaxPct',
  'accreditation.visits.dedupeLegacy',
  'accreditation.unknownMemberGroup.default',
];

/** Phase 2's keys (its spec §12.6), in registry order: six of group `opac`, then the twelve of group `catalog`. */
const PHASE2_OPAC_KEYS: readonly SettingKey[] = [
  'opac.resultsPerPage',
  'opac.indexable',
  'opac.oai.enabled',
  'opac.oai.adminEmail',
  'opac.showShelfMap',
  'opac.newTitlesCount',
];
const CATALOG_KEYS: readonly SettingKey[] = [
  'catalog.marcOrgCode',
  'catalog.defaultMaterialTypeId',
  'catalog.defaultCollectionTypeId',
  'catalog.currency',
  'catalog.barcode.patterns',
  'catalog.barcode.symbology',
  'catalog.labelProfiles',
  'catalog.sru.servers',
  'catalog.sru.allowPrivateHosts',
  'catalog.isbn.arsyaEnabled',
  'catalog.attachment.maxMb',
  'catalog.dedupe.threshold',
];

/** What a registry schema says about `value`. */
const accepts = (key: SettingKey, value: unknown): boolean => SETTINGS[key].schema.safeParse(value).success;

describe('SETTINGS registry', () => {
  it('has exactly the keys of the brief, in groups', () => {
    expect(Object.keys(SETTINGS).sort()).toEqual(Object.keys(SAMPLE).sort());
    expect(groupKeys('library')).toEqual([
      'library.name',
      'library.type',
      'library.address',
      'library.timezone',
      'library.locale',
    ]);
    expect(groupKeys('email')).toHaveLength(5);
    expect(groupKeys('security')).toEqual(['security.password_min_length', 'security.session_idle_minutes']);
    expect(groupKeys('opac')).toEqual(['opac.welcome.id', 'opac.welcome.en', 'opac.accent', ...PHASE2_OPAC_KEYS]);
    expect(groupKeys('catalog')).toEqual(CATALOG_KEYS);
    expect(groupKeys('smtp')).toEqual([
      'smtp.host',
      'smtp.port',
      'smtp.security',
      'smtp.username',
      'smtp.password',
      'smtp.from',
    ]);
    expect(groupKeys('system')).toEqual(INSTANCE_KEYS);
    expect(groupKeys('accreditation')).toEqual(ACCREDITATION_KEYS);
    expect(groupKeys('visits')).toEqual(['visits.dedupeMinutes']);
    // ---- Komunitas (holds, circulation core) ----
    expect(groupKeys('circulation')).toEqual([
      'circulation.holds.enabled',
      'circulation.holds.opac',
      'circulation.holds.onlyWhenNoneAvailable',
      'circulation.holds.pickupDays',
      'circulation.loanVoidMinutes',
      'circulation.lost.useItemPrice',
      'circulation.lost.processingFeeMinor',
    ]);
    expect(groupKeys('members')).toEqual(['members.clearance.prefix', 'members.clearance.profile']);
    expect(GROUPS.flatMap((g) => groupKeys(g)).sort()).toEqual(Object.keys(SETTINGS).sort());
    // The group is the key's first segment, but for the instance keys of 1c that read `audit.*` and `realtime.*`: all system.
    for (const key of Object.keys(SETTINGS) as SettingKey[]) {
      expect(SETTINGS[key].group, key).toBe(INSTANCE_KEYS.includes(key) ? 'system' : key.split('.')[0]);
    }
  });

  it('defaults are the brief values and satisfy their own schemas', () => {
    expect(SETTINGS['library.name'].default).toBe('Perpustakaan');
    expect(SETTINGS['library.timezone'].default).toBe('Asia/Jakarta');
    expect(SETTINGS['library.locale'].default).toBe('id');
    expect(SETTINGS['security.password_min_length'].default).toBe(10);
    expect(SETTINGS['security.session_idle_minutes'].default).toBe(30);
    expect(SETTINGS['opac.accent'].default).toBe('teal');
    expect(SETTINGS['smtp.port'].default).toBe(587);
    expect(SETTINGS['smtp.security'].default).toBe('starttls');
    expect(SETTINGS['system.ip_trust'].default).toBe('ok');
    for (const key of ['library.type', 'library.address', 'email.sender_name', 'smtp.host', 'smtp.password'] as const) {
      expect(SETTINGS[key].default).toBeNull();
    }
    // 1c: absent row = null, except the events floor (0). 1d: also null, except the channel ('stable') and the two lists ([]).
    const nonNull = new Set<SettingKey>(['system.ip_trust', 'system.events_floor', ...(Object.keys(NON_NULL_1D_DEFAULTS) as SettingKey[])]);
    for (const key of INSTANCE_KEYS.filter((k) => !nonNull.has(k))) {
      expect(SETTINGS[key].default, key).toBeNull();
    }
    expect(SETTINGS['system.events_floor'].default).toBe(0);
    for (const [key, value] of Object.entries(NON_NULL_1D_DEFAULTS)) expect(SETTINGS[key as SettingKey].default, key).toEqual(value);
    for (const [key, def] of Object.entries(SETTINGS)) {
      expect(def.schema.safeParse(def.default).success, key).toBe(true);
    }
  });

  it('every key has scope data but the instance keys (system.ip_trust and the 1c machine state); only smtp.password is a secret, bound to host/port/username (L37)', () => {
    for (const [key, def] of Object.entries(SETTINGS)) {
      expect(Object.keys(SETTINGS_SCOPE_CLASS), key).toContain(def.scope);
      expect(def.scope, key).toBe(INSTANCE_KEYS.includes(key as SettingKey) ? 'instance' : 'data');
      expect(def.secret, key).toBe(key === 'smtp.password');
      if (key !== 'smtp.password') expect(def.boundTo, key).toBeUndefined();
    }
    expect(SETTINGS['smtp.password'].boundTo).toEqual(['smtp.host', 'smtp.port', 'smtp.username']);
  });

  it('library schemas', () => {
    expect(accepts('library.name', 'a'.repeat(191))).toBe(true);
    expect(accepts('library.name', 'a'.repeat(192))).toBe(false);
    expect(accepts('library.name', '')).toBe(false);
    expect(accepts('library.name', '   ')).toBe(false);
    expect(accepts('library.name', null)).toBe(false);
    for (const type of ['sekolah', 'perguruan_tinggi', 'umum', 'khusus', null]) expect(accepts('library.type', type)).toBe(true);
    expect(accepts('library.type', 'swasta')).toBe(false);
    expect(accepts('library.address', 'a'.repeat(1000))).toBe(true);
    expect(accepts('library.address', 'a'.repeat(1001))).toBe(false);
    expect(accepts('library.address', null)).toBe(true);
    expect(accepts('library.timezone', 'Asia/Jakarta')).toBe(true);
    expect(accepts('library.timezone', 'Mars/Olympus')).toBe(false);
    expect(accepts('library.timezone', null)).toBe(false);
    expect(accepts('library.locale', 'id')).toBe(true);
    expect(accepts('library.locale', 'en')).toBe(true);
    expect(accepts('library.locale', 'fr')).toBe(false);
  });

  it('email schemas', () => {
    expect(accepts('email.sender_name', 'a'.repeat(100))).toBe(true);
    expect(accepts('email.sender_name', 'a'.repeat(101))).toBe(false);
    expect(accepts('email.sender_name', null)).toBe(true);
    for (const lang of ['id', 'en'] as const) {
      const subject = `email.template.password_reset.${lang}.subject` as const;
      const body = `email.template.password_reset.${lang}.body` as const;
      expect(accepts(subject, 'a'.repeat(200))).toBe(true);
      expect(accepts(subject, 'a'.repeat(201))).toBe(false);
      expect(accepts(subject, null)).toBe(true);
      expect(accepts(body, `{link}${'a'.repeat(3994)}`)).toBe(true);
      expect(accepts(body, `{link}${'a'.repeat(3995)}`)).toBe(false);
      expect(accepts(body, null)).toBe(true);
      // A body of the library's own must keep the reset link; blank reads as the catalog text, which has it.
      expect(accepts(body, 'Klik tautan berikut: {tautan}')).toBe(false);
      expect(accepts(body, '  ')).toBe(true);
    }
  });

  it('security schemas', () => {
    expect(accepts('security.password_min_length', 9)).toBe(false);
    expect(accepts('security.password_min_length', 10)).toBe(true);
    expect(accepts('security.password_min_length', 64)).toBe(true);
    expect(accepts('security.password_min_length', 65)).toBe(false);
    expect(accepts('security.password_min_length', 10.5)).toBe(false);
    expect(accepts('security.password_min_length', '12')).toBe(false);
    expect(accepts('security.password_min_length', null)).toBe(false);
    expect(accepts('security.session_idle_minutes', 4)).toBe(false);
    expect(accepts('security.session_idle_minutes', 5)).toBe(true);
    expect(accepts('security.session_idle_minutes', 240)).toBe(true);
    expect(accepts('security.session_idle_minutes', 241)).toBe(false);
  });

  it('opac schemas', () => {
    for (const key of ['opac.welcome.id', 'opac.welcome.en'] as const) {
      expect(accepts(key, 'a'.repeat(1000))).toBe(true);
      expect(accepts(key, 'a'.repeat(1001))).toBe(false);
      expect(accepts(key, null)).toBe(true);
    }
    for (const accent of ['teal', 'blue', 'green', 'purple', 'red', 'slate']) expect(accepts('opac.accent', accent)).toBe(true);
    expect(accepts('opac.accent', 'pink')).toBe(false);
    expect(accepts('opac.accent', null)).toBe(false);
  });

  // ---- Phase 2 (catalog): Task 2 ----
  describe('Phase 2 (its spec §12.6): the catalog group and the new opac keys', () => {
    it('the defaults of the plan, all of scope data and none a secret', () => {
      expect(Object.fromEntries(PHASE2_OPAC_KEYS.map((k) => [k, SETTINGS[k].default]))).toEqual({
        'opac.resultsPerPage': 20,
        'opac.indexable': true,
        'opac.oai.enabled': true,
        'opac.oai.adminEmail': '',
        'opac.showShelfMap': true,
        'opac.newTitlesCount': 12,
      });
      expect(SETTINGS['catalog.marcOrgCode'].default).toBeNull();
      expect(SETTINGS['catalog.defaultMaterialTypeId'].default).toBeNull();
      expect(SETTINGS['catalog.defaultCollectionTypeId'].default).toBeNull();
      expect(SETTINGS['catalog.currency'].default).toBe('IDR');
      expect(SETTINGS['catalog.barcode.patterns'].default).toEqual([{ id: 'default', name: 'Bawaan', prefix: 'B', digits: 7, suffix: '' }]);
      expect(SETTINGS['catalog.barcode.symbology'].default).toBe('code128');
      expect(SETTINGS['catalog.sru.allowPrivateHosts'].default).toBe(false);
      expect(SETTINGS['catalog.isbn.arsyaEnabled'].default).toBe(false);
      expect(SETTINGS['catalog.attachment.maxMb'].default).toBe(200);
      expect(SETTINGS['catalog.dedupe.threshold'].default).toBe(80);
      for (const key of [...PHASE2_OPAC_KEYS, ...CATALOG_KEYS]) {
        expect(SETTINGS[key].group, key).toBe(key.split('.')[0]);
        expect([SETTINGS[key].scope, SETTINGS[key].secret], key).toEqual(['data', false]);
      }
    });

    it('three label profiles are seeded: A4 3×10 spine, A4 3×8 barcode, A4 2×7 spine and barcode, with margins of at least 5 mm', () => {
      const profiles = SETTINGS['catalog.labelProfiles'].default as {
        kind: string;
        page: unknown;
        cols: number;
        rows: number;
        marginMm: Record<string, number>;
      }[];
      expect(profiles.map((p) => [p.kind, p.page, p.cols, p.rows])).toEqual([
        ['spine', 'A4', 3, 10],
        ['barcode', 'A4', 3, 8],
        ['spine_barcode', 'A4', 2, 7],
      ]);
      for (const p of profiles) for (const side of Object.values(p.marginMm)) expect(side).toBeGreaterThanOrEqual(5);
    });

    it('two SRU servers are seeded, both disabled (P5): Perpusnas without a URL until the owner verifies it, and LoC', () => {
      const servers = SETTINGS['catalog.sru.servers'].default as { id: string; url: string; enabled: boolean; indexes: unknown }[];
      expect(servers.map((s) => [s.id, s.url, s.enabled])).toEqual([
        ['perpusnas', '', false],
        ['loc', 'http://lx2.loc.gov:210/LCDB', false],
      ]);
      for (const s of servers) {
        expect(s.indexes).toEqual({ isbn: 'bath.isbn', title: 'dc.title', author: 'dc.creator', any: 'cql.serverChoice' });
      }
    });

    it('opac schemas of Phase 2', () => {
      expect([accepts('opac.resultsPerPage', 9), accepts('opac.resultsPerPage', 10), accepts('opac.resultsPerPage', 50), accepts('opac.resultsPerPage', 51)]).toEqual([
        false,
        true,
        true,
        false,
      ]);
      expect([accepts('opac.newTitlesCount', -1), accepts('opac.newTitlesCount', 0), accepts('opac.newTitlesCount', 48), accepts('opac.newTitlesCount', 49)]).toEqual([
        false,
        true,
        true,
        false,
      ]);
      for (const key of ['opac.indexable', 'opac.oai.enabled', 'opac.showShelfMap'] as const) {
        expect([accepts(key, true), accepts(key, false), accepts(key, null), accepts(key, 'true')], key).toEqual([true, true, false, false]);
      }
      expect(accepts('opac.oai.adminEmail', '')).toBe(true);
      expect(accepts('opac.oai.adminEmail', 'admin@perpus.example.id')).toBe(true);
      expect(accepts('opac.oai.adminEmail', 'admin')).toBe(false);
      expect(accepts('opac.oai.adminEmail', null)).toBe(false);
    });

    it('catalog schemas: the limits of §12.6 (the shapes are pinned in packages/shared/test/api-settings.test.ts)', () => {
      expect(accepts('catalog.marcOrgCode', null)).toBe(true);
      expect(accepts('catalog.marcOrgCode', 'x'.repeat(16))).toBe(true);
      expect(accepts('catalog.marcOrgCode', 'x'.repeat(17))).toBe(false);
      expect(accepts('catalog.defaultMaterialTypeId', 'nope')).toBe(false);
      expect(accepts('catalog.currency', 'Rp')).toBe(false);
      expect(accepts('catalog.barcode.symbology', 'ean13')).toBe(false);
      expect(accepts('catalog.attachment.maxMb', 0)).toBe(false);
      expect(accepts('catalog.attachment.maxMb', 2048)).toBe(true);
      expect(accepts('catalog.attachment.maxMb', 2049)).toBe(false);
      expect(accepts('catalog.dedupe.threshold', 49)).toBe(false);
      expect(accepts('catalog.dedupe.threshold', 100)).toBe(true);
      expect(accepts('catalog.barcode.patterns', [])).toBe(false);
      expect(accepts('catalog.labelProfiles', [])).toBe(false);
      expect(accepts('catalog.sru.servers', [])).toBe(true);
      expect(accepts('catalog.sru.allowPrivateHosts', null)).toBe(false);
    });

    it('every JSON text the catalog settings may hold fits a MySQL TEXT column (at most 60 000 bytes)', () => {
      // The largest lists: 20 patterns, 20 profiles, 10 servers, each with the longest values their schemas accept.
      const big = (s: string, n: number): string => s.repeat(n);
      const patterns = Array.from({ length: 20 }, (_, i) => ({ id: `p${i}`.padEnd(32, 'x'), name: big('€', 64), prefix: big('"', 16), digits: 12, suffix: big('\\', 16) }));
      const profiles = Array.from({ length: 20 }, (_, i) => ({
        ...(SETTINGS['catalog.labelProfiles'].default as Record<string, unknown>[])[0],
        id: `l${i}`.padEnd(32, 'x'),
        name: big('€', 64),
        header: big('€', 64),
      }));
      const servers = Array.from({ length: 10 }, (_, i) => ({
        id: `s${i}`.padEnd(32, 'x'),
        name: big('€', 64),
        url: `https://x.example/${big('€', 480)}`,
        version: '2.0',
        recordSchema: big('"', 64),
        indexes: { isbn: big('"', 64), title: big('"', 64), author: big('"', 64), any: big('"', 64) },
        enabled: true,
      }));
      for (const [key, value] of [
        ['catalog.barcode.patterns', patterns],
        ['catalog.labelProfiles', profiles],
        ['catalog.sru.servers', servers],
      ] as const) {
        const parsed = SETTINGS[key].schema.safeParse(value);
        expect(parsed.success, key).toBe(true);
        expect(Buffer.byteLength(JSON.stringify(parsed.data), 'utf8'), key).toBeLessThanOrEqual(60_000);
      }
    });
  });

  it('smtp schemas', () => {
    expect(accepts('smtp.host', 'smtp.example.com')).toBe(true);
    expect(accepts('smtp.host', 'localhost')).toBe(true);
    expect(accepts('smtp.host', '192.0.2.10')).toBe(true);
    expect(accepts('smtp.host', '2001:db8::25')).toBe(true);
    expect(accepts('smtp.host', null)).toBe(true);
    expect(accepts('smtp.host', 'not a host')).toBe(false);
    expect(accepts('smtp.host', 'smtp.example.com:587')).toBe(false);
    expect(accepts('smtp.host', 'https://smtp.example.com')).toBe(false);
    expect(accepts('smtp.host', '')).toBe(false);
    // 191 characters is the column width; 192 is refused although each label is valid on its own.
    expect(accepts('smtp.host', `${'a'.repeat(60)}.${'b'.repeat(60)}.${'c'.repeat(60)}.${'d'.repeat(8)}`)).toBe(true);
    expect(accepts('smtp.host', `${'a'.repeat(60)}.${'b'.repeat(60)}.${'c'.repeat(60)}.${'d'.repeat(9)}`)).toBe(false);
    expect(accepts('smtp.port', 0)).toBe(false);
    expect(accepts('smtp.port', 1)).toBe(true);
    expect(accepts('smtp.port', 65535)).toBe(true);
    expect(accepts('smtp.port', 65536)).toBe(false);
    expect(accepts('smtp.port', 25.5)).toBe(false);
    for (const security of ['none', 'starttls', 'tls']) expect(accepts('smtp.security', security)).toBe(true);
    expect(accepts('smtp.security', 'ssl')).toBe(false);
    expect(accepts('smtp.username', 'a'.repeat(191))).toBe(true);
    expect(accepts('smtp.username', 'a'.repeat(192))).toBe(false);
    expect(accepts('smtp.username', null)).toBe(true);
    expect(accepts('smtp.from', 'perpus@example.org')).toBe(true);
    expect(accepts('smtp.from', null)).toBe(true);
    expect(accepts('smtp.from', 'perpus')).toBe(false);
    expect(accepts('smtp.from', `${'a'.repeat(180)}@example.org`)).toBe(false);
    // A secret is a non-empty string or null (cleared); it is not trimmed.
    expect(accepts('smtp.password', 'rahasia')).toBe(true);
    expect(accepts('smtp.password', ' kata sandi ')).toBe(true);
    expect(accepts('smtp.password', null)).toBe(true);
    expect(accepts('smtp.password', '')).toBe(false);
    expect(accepts('smtp.password', 1234)).toBe(false);
  });

  it('system.ip_trust takes IP_TRUST_VALUES', () => {
    for (const value of IP_TRUST_VALUES) expect(accepts('system.ip_trust', value)).toBe(true);
    expect(accepts('system.ip_trust', 'maybe')).toBe(false);
    expect(accepts('system.ip_trust', null)).toBe(false);
  });

  describe('1c instance settings (Task 1)', () => {
    const HASH = 'ab'.repeat(32);
    const ints: SettingKey[] = ['system.run.worker', 'system.run.cron_cli', 'system.run.cron_http', 'system.run.drive', 'system.run.piggyback'];

    it('system.run.<mode>: an integer or null, one key per mode (M20)', () => {
      expect(ints.map((k) => k.slice('system.run.'.length))).toEqual(['worker', 'cron_cli', 'cron_http', 'drive', 'piggyback']);
      for (const key of ints) {
        expect(accepts(key, 1_800_000_000_000), key).toBe(true);
        expect(accepts(key, null), key).toBe(true);
        expect(accepts(key, 1.5), key).toBe(false);
        expect(accepts(key, '1800000000000'), key).toBe(false);
        expect(accepts(key, {}), key).toBe(false);
        expect(accepts(key, undefined), key).toBe(false);
      }
    });

    it('system.clock_anomaly and system.clock_confirmed: strict objects of integers, or null', () => {
      expect(accepts('system.clock_anomaly', { detectedAt: 1, maxSeen: 2 })).toBe(true);
      expect(accepts('system.clock_anomaly', null)).toBe(true);
      expect(accepts('system.clock_anomaly', { detectedAt: 1 })).toBe(false);
      expect(accepts('system.clock_anomaly', { detectedAt: 1, maxSeen: 2.5 })).toBe(false);
      expect(accepts('system.clock_anomaly', { detectedAt: 1, maxSeen: 2, extra: 3 })).toBe(false);
      expect(accepts('system.clock_confirmed', { at: 1, auditSeq: 0 })).toBe(true);
      expect(accepts('system.clock_confirmed', null)).toBe(true);
      expect(accepts('system.clock_confirmed', { at: 1 })).toBe(false);
      expect(accepts('system.clock_confirmed', { at: '1', auditSeq: 0 })).toBe(false);
      expect(accepts('system.clock_confirmed', { at: 1, auditSeq: 0, by: 'x' })).toBe(false);
    });

    it('system.probe: the browser test result, strict at every level', () => {
      const ok = SAMPLE['system.probe'] as Record<string, unknown>;
      expect(accepts('system.probe', ok)).toBe(true);
      expect(accepts('system.probe', null)).toBe(true);
      expect(accepts('system.probe', { ...ok, chunkBytes: null, xff: { spoofable: true, suggestedHops: null } })).toBe(true);
      expect(accepts('system.probe', { at: 1 })).toBe(false);
      expect(accepts('system.probe', { ...ok, extra: 1 })).toBe(false);
      expect(accepts('system.probe', { ...ok, polling: 1 })).toBe(false);
      expect(accepts('system.probe', { ...ok, methods: { put: true, patch: true } })).toBe(false);
      expect(accepts('system.probe', { ...ok, methods: { put: true, patch: true, delete: true, post: true } })).toBe(false);
      expect(accepts('system.probe', { ...ok, chunkBytes: 1.5 })).toBe(false);
      expect(accepts('system.probe', { ...ok, chunkBytes: undefined })).toBe(false);
      expect(accepts('system.probe', { ...ok, xff: { spoofable: true } })).toBe(false);
      expect(accepts('system.probe', { ...ok, xff: { spoofable: true, suggestedHops: 1, extra: 1 } })).toBe(false);
    });

    it('system.exposure: url at most 191 characters, or null', () => {
      expect(accepts('system.exposure', { at: 1, ok: true, url: null })).toBe(true);
      expect(accepts('system.exposure', { at: 1, ok: false, url: 'u'.repeat(191) })).toBe(true);
      expect(accepts('system.exposure', { at: 1, ok: false, url: 'u'.repeat(192) })).toBe(false);
      expect(accepts('system.exposure', null)).toBe(true);
      expect(accepts('system.exposure', { at: 1, ok: true })).toBe(false);
      expect(accepts('system.exposure', { at: 1, ok: true, url: null, extra: 1 })).toBe(false);
    });

    it('system.data_usage: {at, bytes, files, truncated}, or null', () => {
      expect(accepts('system.data_usage', { at: 1, bytes: 0, files: 0, truncated: true })).toBe(true);
      expect(accepts('system.data_usage', null)).toBe(true);
      expect(accepts('system.data_usage', { at: 1, bytes: 0, files: 0 })).toBe(false);
      expect(accepts('system.data_usage', { at: 1, bytes: 1.5, files: 0, truncated: false })).toBe(false);
      expect(accepts('system.data_usage', { at: 1, bytes: 0, files: 0, truncated: false, extra: 1 })).toBe(false);
    });

    it('audit.anchor: seq of at least 0 and a 64-character hex hash, or null', () => {
      expect(accepts('audit.anchor', { seq: 0, hash: HASH })).toBe(true);
      expect(accepts('audit.anchor', null)).toBe(true);
      expect(accepts('audit.anchor', { seq: -1, hash: HASH })).toBe(false);
      expect(accepts('audit.anchor', { seq: 1.5, hash: HASH })).toBe(false);
      expect(accepts('audit.anchor', { seq: 1, hash: HASH.slice(1) })).toBe(false);
      expect(accepts('audit.anchor', { seq: 1, hash: `${HASH}0` })).toBe(false);
      expect(accepts('audit.anchor', { seq: 1, hash: 'g'.repeat(64) })).toBe(false);
      expect(accepts('audit.anchor', { seq: 1, hash: HASH.toUpperCase() })).toBe(false);
      expect(accepts('audit.anchor', { seq: 1, hash: HASH, extra: 1 })).toBe(false);
    });

    it('audit.verified: the last verification, with the hash that lets the next run continue (M5)', () => {
      const ok = { at: 1, ok: true, head: 7, headHash: HASH, brokenAt: null };
      expect(accepts('audit.verified', ok)).toBe(true);
      expect(accepts('audit.verified', { ...ok, ok: false, brokenAt: 5 })).toBe(true);
      expect(accepts('audit.verified', null)).toBe(true);
      expect(accepts('audit.verified', { at: 1, ok: true, head: 7, brokenAt: null })).toBe(false);
      expect(accepts('audit.verified', { ...ok, headHash: 'xyz' })).toBe(false);
      expect(accepts('audit.verified', { ...ok, brokenAt: 1.5 })).toBe(false);
      expect(accepts('audit.verified', { ...ok, brokenAt: undefined })).toBe(false);
      expect(accepts('audit.verified', { ...ok, extra: 1 })).toBe(false);
    });

    it('system.events_floor: an integer of at least 0 (M15)', () => {
      expect(accepts('system.events_floor', 0)).toBe(true);
      expect(accepts('system.events_floor', 12_345)).toBe(true);
      expect(accepts('system.events_floor', -1)).toBe(false);
      expect(accepts('system.events_floor', 1.5)).toBe(false);
      expect(accepts('system.events_floor', null)).toBe(false);
      expect(accepts('system.events_floor', '0')).toBe(false);
    });

    it('realtime.sse: a boolean, or null for automatic', () => {
      expect(accepts('realtime.sse', true)).toBe(true);
      expect(accepts('realtime.sse', false)).toBe(true);
      expect(accepts('realtime.sse', null)).toBe(true);
      expect(accepts('realtime.sse', 1)).toBe(false);
      expect(accepts('realtime.sse', 'true')).toBe(false);
    });

    it('none of them is a secret, and none is bound to another setting', () => {
      for (const key of INSTANCE_KEYS) {
        expect(SETTINGS[key].secret, key).toBe(false);
        expect(SETTINGS[key].boundTo, key).toBeUndefined();
      }
    });
  });

  describe('1d instance settings (Task 1)', () => {
    const KEYS_1D = INSTANCE_KEYS.slice(INSTANCE_KEYS.indexOf('update.channel'));
    const check = SAMPLE['update.check'] as Record<string, unknown>;
    const entry = check['available'] as Record<string, unknown>;

    it('every 1d key has scope instance, group system, is not a secret, and its sample satisfies its schema', () => {
      expect(KEYS_1D).toHaveLength(6);
      for (const key of KEYS_1D) {
        expect(SETTINGS[key].scope, key).toBe('instance');
        expect(SETTINGS[key].group, key).toBe('system');
        expect(SETTINGS[key].secret, key).toBe(false);
        expect(accepts(key, SAMPLE[key]), key).toBe(true);
      }
    });

    it('update.channel: stable or beta', () => {
      expect(accepts('update.channel', 'stable')).toBe(true);
      expect(accepts('update.channel', 'beta')).toBe(true);
      expect(accepts('update.channel', 'nightly')).toBe(false);
      expect(accepts('update.channel', null)).toBe(false);
    });

    it('update.check: the last check, with the feed entry it found, strict at every level', () => {
      expect(accepts('update.check', null)).toBe(true);
      // A failed check: an error code (a 5xx reason included, ≤ 64), nothing found.
      const failed = { at: 1, ok: false, error: 'FEED_UNREACHABLE:timeout', seq: null, available: null, latest: null, steppingStone: false };
      expect(accepts('update.check', failed)).toBe(true);
      expect(accepts('update.check', { ...failed, error: 'E'.repeat(64) })).toBe(true);
      expect(accepts('update.check', { ...failed, error: 'E'.repeat(65) })).toBe(false);
      expect(accepts('update.check', { ...check, latest: 'v0.3.0' })).toBe(false);
      expect(accepts('update.check', { ...check, steppingStone: undefined })).toBe(false);
      expect(accepts('update.check', { ...check, extra: 1 })).toBe(false);
      // Review C07: the expiry of the feed that offered the entry; absent in a check stored before it was recorded.
      expect(accepts('update.check', { ...check, expiresAt: null })).toBe(true);
      expect(accepts('update.check', { ...check, expiresAt: 1.5 })).toBe(false);
      expect(accepts('update.check', { ...check, at: 1.5 })).toBe(false);
      // The entry: the feed's fields, nothing else.
      expect(accepts('update.check', { ...check, available: { ...entry, notesUrl: 'https://updates.example.org/notes/0.2.0' } })).toBe(true);
      expect(accepts('update.check', { ...check, available: { ...entry, version: 'latest' } })).toBe(false);
      expect(accepts('update.check', { ...check, available: { ...entry, channel: 'nightly' } })).toBe(false);
      expect(accepts('update.check', { ...check, available: { ...entry, releasedAt: '2026-11-1' } })).toBe(false);
      expect(accepts('update.check', { ...check, available: { ...entry, sha256: 'xyz' } })).toBe(false);
      expect(accepts('update.check', { ...check, available: { ...entry, size: -1 } })).toBe(false);
      expect(accepts('update.check', { ...check, available: { ...entry, minDb: { mysql: '8.0.0', mariadb: '10.6.0' } } })).toBe(false);
      expect(accepts('update.check', { ...check, available: { ...entry, firmware: {} } })).toBe(false);
    });

    it('update.notified and update.dashboard_check_at: a version or a time, or null', () => {
      expect(accepts('update.notified', '0.2.0')).toBe(true);
      expect(accepts('update.notified', null)).toBe(true);
      expect(accepts('update.notified', '0.2')).toBe(false);
      expect(accepts('update.dashboard_check_at', 1_800_000_000_000)).toBe(true);
      expect(accepts('update.dashboard_check_at', null)).toBe(true);
      expect(accepts('update.dashboard_check_at', 1.5)).toBe(false);
    });

    it('update.bundled_blocked: the version, the time and at most 8 failures', () => {
      const ok = { version: '0.2.0-test', at: 1, failures: [] as string[] };
      expect(accepts('update.bundled_blocked', ok)).toBe(true);
      expect(accepts('update.bundled_blocked', null)).toBe(true);
      expect(accepts('update.bundled_blocked', { ...ok, failures: Array.from({ length: 8 }, () => 'min_node') })).toBe(true);
      expect(accepts('update.bundled_blocked', { ...ok, failures: Array.from({ length: 9 }, () => 'min_node') })).toBe(false);
      expect(accepts('update.bundled_blocked', { ...ok, version: 'x' })).toBe(false);
      expect(accepts('update.bundled_blocked', { ...ok, extra: 1 })).toBe(false);
    });

    it('system.keyset_full', () => {
      expect(accepts('system.keyset_full', { at: 1, refused: 0 })).toBe(true);
      expect(accepts('system.keyset_full', null)).toBe(true);
      expect(accepts('system.keyset_full', { at: 1 })).toBe(false);
    });

    it('the community edition registers no licence or active-set key', () => {
      const keys = Object.keys(SETTINGS);
      expect(keys.filter((k) => k.startsWith('license.') || k.startsWith('active_set.'))).toEqual([]);
      // Reserved and ignored, kept for settings and API compatibility.
      expect(keys).toContain('catalog.isbn.arsyaEnabled');
    });
  });

  // ---- Komunitas K1 (settings) ----
  describe('the accreditation group and the visit repeat window', () => {
    it('the defaults, all of scope data and none a secret', () => {
      expect(Object.fromEntries(ACCREDITATION_KEYS.map((k) => [k, SETTINGS[k].default]))).toEqual({
        'accreditation.schoolYearStartMonth': 7,
        'accreditation.fiction.collectionTypeCodes': ['FIKSI'],
        'accreditation.fiction.callNumberPrefixes': [],
        'accreditation.fiction.ddcPrefixes': [],
        'accreditation.referenceCollectionTypeCodes': ['REF'],
        'accreditation.electronicMaterialTypeCodes': ['EBOOK'],
        'accreditation.usedUnit': 'titles',
        'accreditation.websiteFeatures': {},
        'accreditation.liveFrom': null,
        'accreditation.evidence.maxMb': 5,
        'accreditation.evidence.componentLimitMb': 9,
        'accreditation.textbookCollectionTypeCodes': [],
        'accreditation.k7.processedThresholdPct': 100,
        'accreditation.undatedShareMaxPct': 10,
        'accreditation.visits.dedupeLegacy': true,
        'accreditation.unknownMemberGroup.default': 'auto',
      });
      expect(SETTINGS['visits.dedupeMinutes'].default).toBe(60);
      for (const key of [...ACCREDITATION_KEYS, 'visits.dedupeMinutes' as const]) {
        expect([SETTINGS[key].scope, SETTINGS[key].secret], key).toEqual(['data', false]);
      }
    });

    it('the limits of each schema', () => {
      expect(accepts('accreditation.schoolYearStartMonth', 1)).toBe(true);
      expect(accepts('accreditation.schoolYearStartMonth', 12)).toBe(true);
      expect(accepts('accreditation.schoolYearStartMonth', 13)).toBe(false);
      expect(accepts('accreditation.k7.processedThresholdPct', 50)).toBe(true);
      expect(accepts('accreditation.k7.processedThresholdPct', 40)).toBe(false);
      expect(accepts('accreditation.k7.processedThresholdPct', 101)).toBe(false);
      expect(accepts('accreditation.undatedShareMaxPct', 0)).toBe(true);
      expect(accepts('accreditation.evidence.maxMb', 0)).toBe(false);
      expect(accepts('accreditation.evidence.componentLimitMb', 100)).toBe(true);
      expect(accepts('accreditation.fiction.collectionTypeCodes', Array.from({ length: 21 }, (_, i) => `K${i}`))).toBe(false);
      expect(accepts('accreditation.fiction.ddcPrefixes', Array.from({ length: 50 }, (_, i) => `${i}`))).toBe(true);
      expect(accepts('accreditation.liveFrom', '2025-02-29')).toBe(false);
      expect(accepts('accreditation.liveFrom', null)).toBe(true);
      for (const v of ['auto', null, 'student', 'teacher', 'edu_staff', 'public', 'other']) {
        expect(accepts('accreditation.unknownMemberGroup.default', v), String(v)).toBe(true);
      }
      expect(accepts('accreditation.unknownMemberGroup.default', 'guest')).toBe(false);
      expect(accepts('accreditation.websiteFeatures', { socialUrls: ['https://a.example', 'https://b.example'] })).toBe(true);
      expect(accepts('accreditation.websiteFeatures', { blogPageId: '01J0000000000000000000000C' })).toBe(false);
      // The repeat window of member visits: 0 turns the rule off; at most half a day.
      expect(accepts('visits.dedupeMinutes', 0)).toBe(true);
      expect(accepts('visits.dedupeMinutes', 720)).toBe(true);
      expect(accepts('visits.dedupeMinutes', 721)).toBe(false);
      expect(accepts('visits.dedupeMinutes', -1)).toBe(false);
    });

    it('the codes are stored upper case, so a default written back changes nothing', () => {
      expect(SETTINGS['accreditation.fiction.collectionTypeCodes'].schema.parse(['fiksi'])).toEqual(['FIKSI']);
      expect(Object.isFrozen(SETTINGS['accreditation.fiction.collectionTypeCodes'].default)).toBe(true);
      expect(Object.isFrozen(SETTINGS['accreditation.websiteFeatures'].default)).toBe(true);
    });
  });

  it('the registry is frozen', () => {
    expect(Object.isFrozen(SETTINGS)).toBe(true);
    expect(() => {
      (SETTINGS as Record<string, unknown>)['library.extra'] = {};
    }).toThrow(TypeError);
  });
});

describe.skipIf(!ctx.available)(`settings service [${engineLabel()}]`, () => {
  let h: TestDbHandle;
  let dataDir: string;

  beforeAll(async () => {
    h = await testDb();
    dataDir = await fsp.mkdtemp(path.join(os.tmpdir(), 'altis-core-settings-'));
    await runMigrations(h, { appVersion: '0.1.0', dataDir, migrations: PHASE1_MIGRATIONS });
  });

  afterAll(async () => {
    await h?.close();
    if (dataDir !== undefined) await fsp.rm(dataDir, { recursive: true, force: true });
  });

  beforeEach(async () => {
    await h.db.deleteFrom('settings').execute();
  });

  /** The three rows install seeds (JSON text, scope data); the default values are not the ones install writes. */
  async function seedInstall(
    values: { name: string; timezone: string; locale: string } = { name: 'Perpustakaan Pelita', timezone: 'Asia/Makassar', locale: 'en' },
  ): Promise<void> {
    const seeds: [string, string][] = [
      ['library.name', values.name],
      ['library.timezone', values.timezone],
      ['library.locale', values.locale],
    ];
    for (const [key, value] of seeds) {
      await h.db
        .insertInto('settings')
        .values({ key, value: JSON.stringify(value), is_secret: 0, scope: 'data', updated_at: NOW - 1000, updated_by: null })
        .execute();
    }
  }

  const row = (key: string) => h.db.selectFrom('settings').selectAll().where('key', '=', key).executeTakeFirst();
  const rows = () => h.db.selectFrom('settings').selectAll().orderBy('key').execute();

  /** `writeSettings` in a transaction of its own, by a fresh actor. */
  const write = (patch: Partial<Record<SettingKey, unknown>>, o: { now?: number; actorId?: string | null } = {}) =>
    withTx(h, (trx) => writeSettings(trx, patch, { keyring, now: o.now ?? NOW, actorId: o.actorId ?? null }));

  /** What `fn` throws, which must be a DomainError VALIDATION_FAILED; its `meta.errors`. */
  async function validationErrors(fn: () => Promise<unknown>): Promise<{ path: string; code: string }[]> {
    try {
      await fn();
    } catch (error) {
      if (!isDomainError(error) || error.code !== 'VALIDATION_FAILED') throw error;
      expect(error.status).toBe(422);
      return error.meta?.['errors'] as { path: string; code: string }[];
    }
    return expect.fail('did not throw');
  }

  describe('readSettings', () => {
    it('returns the seeded values, and the defaults for absent rows', async () => {
      await seedInstall();
      expect(await readSettings(h.db, groupKeys('library'), keyring)).toEqual({
        'library.name': 'Perpustakaan Pelita',
        'library.type': null,
        'library.address': null,
        'library.timezone': 'Asia/Makassar',
        'library.locale': 'en',
      });
    });

    it('returns the defaults on an empty table, and only the keys asked for', async () => {
      expect(await readSettings(h.db, ['library.name', 'security.password_min_length', 'smtp.port'], keyring)).toEqual({
        'library.name': 'Perpustakaan',
        'security.password_min_length': 10,
        'smtp.port': 587,
      });
      expect(await readSettings(h.db, [], keyring)).toEqual({});
    });

    it('reads inside a transaction, and sees its own writes there', async () => {
      await withTx(h, async (trx) => {
        await writeSettings(trx, { 'opac.accent': 'red' }, { keyring, now: NOW, actorId: null });
        expect(await readSettings(trx, ['opac.accent'], keyring)).toEqual({ 'opac.accent': 'red' });
      });
    });

    it('a secret reads as {isSet}, never as its value', async () => {
      expect(await readSettings(h.db, ['smtp.password'], keyring)).toEqual({ 'smtp.password': { isSet: false } });
      await write({ 'smtp.password': 'rahasia' });
      const read = await readSettings(h.db, groupKeys('smtp'), keyring);
      expect(read['smtp.password']).toEqual({ isSet: true });
      expect(JSON.stringify(read)).not.toContain('rahasia');
      expect(JSON.stringify(read)).not.toContain('v1:');
    });

    it('falls back to the default for a stored value that is not JSON or breaks its schema', async () => {
      const bad: [string, string | null][] = [
        ['library.name', 'not json'],
        ['security.password_min_length', '3'],
        ['opac.accent', '"pink"'],
        ['smtp.port', null],
      ];
      for (const [key, value] of bad) {
        await h.db
          .insertInto('settings')
          .values({ key, value, is_secret: 0, scope: 'data', updated_at: NOW, updated_by: null })
          .execute();
      }
      expect(await readSettings(h.db, bad.map(([key]) => key as SettingKey), keyring)).toEqual({
        'library.name': 'Perpustakaan',
        'security.password_min_length': 10,
        'opac.accent': 'teal',
        'smtp.port': 587,
      });
    });

    it('reads a key whose registered scope is instance', async () => {
      expect(await readSettings(h.db, ['system.ip_trust'], keyring)).toEqual({ 'system.ip_trust': 'ok' });
      await write({ 'system.ip_trust': 'collapsed' });
      expect(await readSettings(h.db, ['system.ip_trust'], keyring)).toEqual({ 'system.ip_trust': 'collapsed' });
    });

    it('Phase 2: on an empty table every new key reads its default', async () => {
      const keys = [...PHASE2_OPAC_KEYS, ...CATALOG_KEYS];
      expect(await readSettings(h.db, keys, keyring)).toEqual(Object.fromEntries(keys.map((k) => [k, SETTINGS[k].default])));
      expect((await readSettings(h.db, ['catalog.currency', 'opac.resultsPerPage'], keyring))).toEqual({
        'catalog.currency': 'IDR',
        'opac.resultsPerPage': 20,
      });
    });

    it('1c: on an empty table the run records read null, system.events_floor 0 and realtime.sse null', async () => {
      expect(await readSettings(h.db, ['system.run.worker'], keyring)).toEqual({ 'system.run.worker': null });
      expect(await readSettings(h.db, ['system.events_floor', 'realtime.sse'], keyring)).toEqual({
        'system.events_floor': 0,
        'realtime.sse': null,
      });
      const absent = INSTANCE_KEYS.filter(
        (k) => k !== 'system.ip_trust' && k !== 'system.events_floor' && !Object.hasOwn(NON_NULL_1D_DEFAULTS, k),
      );
      const read = await readSettings(h.db, absent, keyring);
      for (const key of absent) expect(read[key], key).toBeNull();
    });

    it("1d: on an empty table update.channel reads 'stable' and every other 1d key null", async () => {
      expect(await readSettings(h.db, ['update.channel'], keyring)).toEqual({ 'update.channel': 'stable' });
      const nulls = INSTANCE_KEYS.slice(INSTANCE_KEYS.indexOf('update.channel')).filter((k) => !Object.hasOwn(NON_NULL_1D_DEFAULTS, k));
      expect(nulls).toHaveLength(5);
      const read = await readSettings(h.db, nulls, keyring);
      for (const key of nulls) expect(read[key], key).toBeNull();
    });

    it('1c: a stored object that breaks its schema reads as the default (null), not as the broken value', async () => {
      await h.db
        .insertInto('settings')
        .values({ key: 'system.probe', value: '{"at":1}', is_secret: 0, scope: 'instance', updated_at: NOW, updated_by: null })
        .execute();
      expect(await readSettings(h.db, ['system.probe'], keyring)).toEqual({ 'system.probe': null });
    });
  });

  describe('writeSettings', () => {
    it('refuses an invalid value with VALIDATION_FAILED, path = the key', async () => {
      const errors = await validationErrors(() => write({ 'security.password_min_length': 9 }));
      expect(errors).toEqual([{ path: 'security.password_min_length', code: 'too_small' }]);
      expect(await rows()).toEqual([]);
    });

    // ---- Phase 2 (catalog): Task 2 ----
    it('Phase 2: a barcode pattern of 13 digits → VALIDATION_FAILED at catalog.barcode.patterns.0.digits; nothing written', async () => {
      const errors = await validationErrors(() =>
        write({ 'catalog.barcode.patterns': [{ id: 'default', name: 'Bawaan', prefix: 'B', digits: 13, suffix: '' }] }),
      );
      // 1d (Task 1): the path goes on into a list's value, to the first issue's place in it.
      expect(errors).toEqual([{ path: 'catalog.barcode.patterns.0.digits', code: 'too_big' }]);
      expect(await rows()).toEqual([]);
    });

    it('Phase 2: the lists round-trip as JSON text, a pattern prefix and suffix stored upper case; the default writes nothing', async () => {
      const patterns = [{ id: 'default', name: 'Bawaan', prefix: 'bk-', digits: 6, suffix: 'x' }];
      expect(await write({ 'catalog.barcode.patterns': patterns })).toEqual(['catalog.barcode.patterns']);
      const stored = [{ id: 'default', name: 'Bawaan', prefix: 'BK-', digits: 6, suffix: 'X' }];
      expect(await row('catalog.barcode.patterns')).toMatchObject({ value: JSON.stringify(stored), scope: 'data', is_secret: 0 });
      expect(await readSettings(h.db, ['catalog.barcode.patterns'], keyring)).toEqual({ 'catalog.barcode.patterns': stored });
      // The same value again (sent in lower case) changes nothing.
      expect(await write({ 'catalog.barcode.patterns': patterns })).toEqual([]);
      // Writing a default over an absent row writes no row.
      await h.db.deleteFrom('settings').execute();
      const defaults = Object.fromEntries(CATALOG_KEYS.map((k) => [k, SETTINGS[k].default]));
      expect(await write(defaults)).toEqual([]);
      expect(await rows()).toEqual([]);
    });

    it('a password-reset body without {link} → VALIDATION_FAILED {path: the key, code: missing_link}', async () => {
      const errors = await validationErrors(() => write({ 'email.template.password_reset.id.body': 'Klik {tautan}' }));
      expect(errors).toEqual([{ path: 'email.template.password_reset.id.body', code: 'missing_link' }]);
      expect(await rows()).toEqual([]);
    });

    it('lists every invalid key (and no value), and writes none of the patch', async () => {
      const errors = await withTx(h, async (trx) => {
        let seen: { path: string; code: string }[] = [];
        try {
          await writeSettings(
            trx,
            { 'library.name': 'Valid name', 'opac.accent': 'pink', 'smtp.port': 70000, 'smtp.password': 'SEKRET-VALUE' },
            { keyring, now: NOW, actorId: null },
          );
        } catch (error) {
          if (!isDomainError(error) || error.code !== 'VALIDATION_FAILED') throw error;
          expect(JSON.stringify(error.meta)).not.toContain('pink');
          expect(JSON.stringify(error)).not.toContain('SEKRET-VALUE');
          seen = error.meta?.['errors'] as typeof seen;
        }
        // Nothing of the patch was written before the failure, not even the valid key.
        expect(await trx.selectFrom('settings').select('key').execute()).toEqual([]);
        return seen;
      });
      expect(errors).toEqual([
        { path: 'opac.accent', code: 'invalid_value' },
        { path: 'smtp.port', code: 'too_big' },
      ]);
    });

    it('refuses a key outside the registry (a programming error, not user input)', async () => {
      await expect(write({ 'library.nope': 'x' } as never)).rejects.toThrow(TypeError);
      await expect(write({ constructor: 'x' } as never)).rejects.toThrow(TypeError);
      expect(await rows()).toEqual([]);
    });

    it('stores JSON text with the registered scope, the time and the actor; returns the changed keys', async () => {
      const actorId = newId();
      const changed = await write(
        { 'security.session_idle_minutes': 45, 'library.name': 'Perpus "Baru"', 'opac.accent': 'blue' },
        { actorId },
      );
      // In registry order, not in the order of the patch.
      expect(changed).toEqual(['library.name', 'security.session_idle_minutes', 'opac.accent']);
      expect(await row('library.name')).toMatchObject({
        value: '"Perpus \\"Baru\\""',
        is_secret: 0,
        scope: 'data',
        updated_at: NOW,
        updated_by: actorId,
      });
      expect(await row('security.session_idle_minutes')).toMatchObject({ value: '45', scope: 'data' });
      expect(await row('opac.accent')).toMatchObject({ value: '"blue"', scope: 'data' });
      expect(await readSettings(h.db, ['library.name', 'security.session_idle_minutes'], keyring)).toEqual({
        'library.name': 'Perpus "Baru"',
        'security.session_idle_minutes': 45,
      });
    });

    it('stores the value the schema produced (a name is trimmed)', async () => {
      await write({ 'library.name': '  Perpus Kota  ' });
      expect((await row('library.name'))?.value).toBe('"Perpus Kota"');
    });

    it('writes system.ip_trust with scope instance', async () => {
      expect(await write({ 'system.ip_trust': 'spoofable' })).toEqual(['system.ip_trust']);
      expect(await row('system.ip_trust')).toMatchObject({ value: '"spoofable"', scope: 'instance', is_secret: 0 });
    });

    it('1c: system.probe {at: 1} is VALIDATION_FAILED with a path under system.probe, and nothing is written', async () => {
      // 1d (Task 1): the path goes on into the value (the first missing field here), as update.bundled_blocked does below.
      expect(await validationErrors(() => write({ 'system.probe': { at: 1 } }))).toEqual([
        { path: 'system.probe.polling', code: expect.any(String) },
      ]);
      expect(await rows()).toEqual([]);
    });

    it('1d: update.bundled_blocked {failures: [1]} → VALIDATION_FAILED at update.bundled_blocked.failures.0; nine failures → VALIDATION_FAILED; nothing written', async () => {
      const blocked = { version: '0.2.0-test', at: 1 };
      expect(await validationErrors(() => write({ 'update.bundled_blocked': { ...blocked, failures: [1] } }))).toEqual([
        { path: 'update.bundled_blocked.failures.0', code: expect.any(String) },
      ]);
      const nine = Array.from({ length: 9 }, (_, i) => `failure_${i}`);
      expect(await validationErrors(() => write({ 'update.bundled_blocked': { ...blocked, failures: nine } }))).toEqual([
        { path: 'update.bundled_blocked.failures', code: 'too_big' },
      ]);
      expect(await rows()).toEqual([]);
      // Eight are fine, and read back as written.
      const eight = { ...blocked, failures: nine.slice(0, 8) };
      expect(await write({ 'update.bundled_blocked': eight })).toEqual(['update.bundled_blocked']);
      expect(await readSettings(h.db, ['update.bundled_blocked'], keyring)).toEqual({ 'update.bundled_blocked': eight });
    });

    it('1c: every machine-state key is stored as JSON text with scope instance, and reads back as written', async () => {
      const keys = INSTANCE_KEYS.filter((k) => k !== 'system.ip_trust');
      const patch: Partial<Record<SettingKey, unknown>> = {};
      for (const key of keys) patch[key] = SAMPLE[key];
      expect((await write(patch)).sort()).toEqual([...keys].sort());
      for (const key of keys) {
        expect(await row(key), key).toMatchObject({ value: JSON.stringify(SAMPLE[key]), scope: 'instance', is_secret: 0 });
      }
      expect(await readSettings(h.db, keys, keyring)).toEqual(Object.fromEntries(keys.map((k) => [k, SAMPLE[k]])));
      // The same values again change nothing; null clears an object key back to its default.
      expect(await write(patch)).toEqual([]);
      expect(await write({ 'system.probe': null, 'realtime.sse': null })).toEqual(['system.probe', 'realtime.sse']);
      expect(await readSettings(h.db, ['system.probe', 'realtime.sse'], keyring)).toEqual({ 'system.probe': null, 'realtime.sse': null });
    });

    it('1c: two modes write their own run record, and neither overwrites the other (M20)', async () => {
      await write({ 'system.run.worker': 1_800_000_000_000 });
      await write({ 'system.run.cron_http': 1_800_000_000_500 });
      expect(await readSettings(h.db, ['system.run.worker', 'system.run.cron_http', 'system.run.drive'], keyring)).toEqual({
        'system.run.worker': 1_800_000_000_000,
        'system.run.cron_http': 1_800_000_000_500,
        'system.run.drive': null,
      });
    });

    it('1c: events_floor refuses a negative number', async () => {
      expect(await validationErrors(() => write({ 'system.events_floor': -1 }))).toEqual([
        { path: 'system.events_floor', code: expect.any(String) },
      ]);
    });

    it('undefined keeps a value; null clears a nullable one (back to its default null)', async () => {
      await write({ 'library.address': 'Jl. Pelita 1', 'library.type': 'umum', 'email.sender_name': 'Perpus' });
      expect(await write({ 'library.address': undefined, 'library.type': null })).toEqual(['library.type']);
      expect(await readSettings(h.db, ['library.address', 'library.type', 'email.sender_name'], keyring)).toEqual({
        'library.address': 'Jl. Pelita 1',
        'library.type': null,
        'email.sender_name': 'Perpus',
      });
      expect((await row('library.type'))?.value).toBe('null');
      expect(await write({})).toEqual([]);
    });

    it('null for a key that cannot be null is VALIDATION_FAILED', async () => {
      expect(await validationErrors(() => write({ 'library.name': null }))).toEqual([
        { path: 'library.name', code: 'invalid_type' },
      ]);
    });

    it('returns no key, and leaves the row alone, when a value does not change', async () => {
      await write({ 'library.name': 'Perpus A', 'smtp.port': 465 }, { now: NOW });
      const before = await rows();
      expect(await write({ 'library.name': 'Perpus A', 'smtp.port': 465 }, { now: NOW + 5000, actorId: newId() })).toEqual([]);
      expect(await rows()).toEqual(before);
      // Equal to the default of an absent row: no change either, and no row.
      expect(await write({ 'opac.accent': 'teal', 'library.type': null })).toEqual([]);
      expect(await row('opac.accent')).toBeUndefined();
      expect(await row('library.type')).toBeUndefined();
    });

    it('returns only the keys that changed in a patch of several', async () => {
      await write({ 'library.name': 'Perpus A', 'security.password_min_length': 12 });
      expect(await write({ 'library.name': 'Perpus A', 'security.password_min_length': 14, 'smtp.port': 25 }, { now: NOW + 1 })).toEqual([
        'security.password_min_length',
        'smtp.port',
      ]);
      expect((await row('library.name'))?.updated_at).toBe(NOW);
      expect((await row('smtp.port'))?.updated_at).toBe(NOW + 1);
    });

    it('rolls back with its transaction, and a failed attempt leaves nothing', async () => {
      await expect(
        withTx(h, async (trx) => {
          await writeSettings(trx, { 'library.name': 'Tidak jadi' }, { keyring, now: NOW, actorId: null });
          throw new Error('the action failed');
        }),
      ).rejects.toThrow('the action failed');
      expect(await rows()).toEqual([]);
    });

    it('is re-runnable: the same call twice in a row gives the same rows (withTx may run it again)', async () => {
      const first = await write({ 'library.name': 'Perpus A', 'smtp.host': 'smtp.example.org' });
      const second = await write({ 'library.name': 'Perpus A', 'smtp.host': 'smtp.example.org' });
      expect(first).toEqual(['library.name', 'smtp.host']);
      expect(second).toEqual([]);
      // The host's bound secret is written cleared (T8), not reported.
      expect((await rows()).map((r) => [r.key, r.value])).toEqual([
        ['library.name', '"Perpus A"'],
        ['smtp.host', '"smtp.example.org"'],
        ['smtp.password', null],
      ]);
    });
  });

  describe('secrets', () => {
    it('smtp.password is stored as v1: text with is_secret 1, sealed with AAD settings.value.<key>', async () => {
      expect(await write({ 'smtp.password': 'rahasia' })).toEqual(['smtp.password']);
      const stored = await row('smtp.password');
      expect(stored?.value).toMatch(/^v1:k1:[A-Za-z0-9_-]{16}:[A-Za-z0-9_-]{22,}$/);
      expect(stored?.value).not.toContain('rahasia');
      expect(stored).toMatchObject({ is_secret: 1, scope: 'data' });
      expect(openValue(keyring, secretAad('settings', 'value', 'smtp.password'), stored!.value!)).toBe('rahasia');
      // Another row's AAD does not open it (a copy into another key is detected).
      expect(() => openValue(keyring, secretAad('settings', 'value', 'smtp.username'), stored!.value!)).toThrow();
    });

    it('readSettings returns {isSet: true} and readSecret returns the value', async () => {
      await write({ 'smtp.password': 'rahasia' });
      expect((await readSettings(h.db, ['smtp.password'], keyring))['smtp.password']).toEqual({ isSet: true });
      expect(await readSecret(h.db, 'smtp.password', keyring)).toBe('rahasia');
    });

    it('readSecret reads inside a transaction too', async () => {
      await withTx(h, async (trx) => {
        await writeSettings(trx, { 'smtp.password': 'di dalam' }, { keyring, now: NOW, actorId: null });
        expect(await readSecret(trx, 'smtp.password', keyring)).toBe('di dalam');
      });
    });

    it('readSecret gives null when the secret is absent or cleared', async () => {
      expect(await readSecret(h.db, 'smtp.password', keyring)).toBeNull();
      await write({ 'smtp.password': 'rahasia' });
      expect(await write({ 'smtp.password': null })).toEqual(['smtp.password']);
      expect(await readSecret(h.db, 'smtp.password', keyring)).toBeNull();
      expect((await row('smtp.password'))?.value).toBeNull();
      expect((await readSettings(h.db, ['smtp.password'], keyring))['smtp.password']).toEqual({ isSet: false });
      // Clearing a cleared secret changes nothing.
      expect(await write({ 'smtp.password': null })).toEqual([]);
    });

    it('a secret is never trimmed or normalized', async () => {
      await write({ 'smtp.password': '  Ａbc é ' });
      expect(await readSecret(h.db, 'smtp.password', keyring)).toBe('  Ａbc é ');
    });

    it('readSecret on a key that is not a secret is a TypeError', async () => {
      await expect(readSecret(h.db, 'library.name', keyring)).rejects.toThrow(TypeError);
    });

    it('a secret that another keyring sealed is SECRET_UNREADABLE, which carries no value', async () => {
      await write({ 'smtp.password': 'rahasia' });
      await expect(readSecret(h.db, 'smtp.password', otherKeyring)).rejects.toMatchObject({ code: 'SECRET_UNREADABLE' });
      // isSet needs no key: it is a fact about the row.
      expect((await readSettings(h.db, ['smtp.password'], otherKeyring))['smtp.password']).toEqual({ isSet: true });
    });

    it('a new secret is sealed afresh with the active key (a different IV each time)', async () => {
      await write({ 'smtp.password': 'rahasia' });
      const first = (await row('smtp.password'))?.value;
      await write({ 'smtp.password': 'rahasia' });
      const second = (await row('smtp.password'))?.value;
      expect(second).not.toBe(first);
      expect(await readSecret(h.db, 'smtp.password', keyring)).toBe('rahasia');
    });
  });

  describe('a purpose-bound secret (spec §7.6)', () => {
    const smtp = { 'smtp.host': 'smtp.example.org', 'smtp.port': 587, 'smtp.username': 'mailer' } as const;

    async function withPassword(): Promise<void> {
      await write({ ...smtp, 'smtp.password': 'rahasia' });
      expect(await readSecret(h.db, 'smtp.password', keyring)).toBe('rahasia');
    }

    it('changing smtp.host alone clears smtp.password (row value NULL) and reports it', async () => {
      await withPassword();
      expect(await write({ 'smtp.host': 'mail.example.org' })).toEqual(['smtp.host', 'smtp.password']);
      expect((await row('smtp.password'))?.value).toBeNull();
      expect(await readSecret(h.db, 'smtp.password', keyring)).toBeNull();
      expect((await readSettings(h.db, ['smtp.password'], keyring))['smtp.password']).toEqual({ isSet: false });
      expect(await row('smtp.password')).toMatchObject({ is_secret: 1, updated_at: NOW });
    });

    it('changing smtp.host together with a new smtp.password keeps the new one', async () => {
      await withPassword();
      expect(await write({ 'smtp.host': 'mail.example.org', 'smtp.password': 'baru' })).toEqual(['smtp.host', 'smtp.password']);
      expect(await readSecret(h.db, 'smtp.password', keyring)).toBe('baru');
    });

    it('smtp.port and smtp.username clear it too', async () => {
      await withPassword();
      expect(await write({ 'smtp.port': 465 })).toEqual(['smtp.port', 'smtp.password']);
      expect(await readSecret(h.db, 'smtp.password', keyring)).toBeNull();
      await write({ 'smtp.password': 'lagi' });
      expect(await write({ 'smtp.username': 'orang-lain' })).toEqual(['smtp.username', 'smtp.password']);
      expect(await readSecret(h.db, 'smtp.password', keyring)).toBeNull();
    });

    it('a patch that repeats the current host, port and username keeps the secret', async () => {
      await withPassword();
      expect(await write({ ...smtp })).toEqual([]);
      expect(await readSecret(h.db, 'smtp.password', keyring)).toBe('rahasia');
    });

    it('fields that are not bound (security, from) keep the secret', async () => {
      await withPassword();
      expect(await write({ 'smtp.security': 'tls', 'smtp.from': 'perpus@example.org', 'library.name': 'Lain' })).toEqual([
        'library.name',
        'smtp.security',
        'smtp.from',
      ]);
      expect(await readSecret(h.db, 'smtp.password', keyring)).toBe('rahasia');
    });

    it('T8: a changed host with no secret stored writes the cleared (NULL) secret row anyway, and does not report it', async () => {
      // Always written: the write waits for (and then overrides) a concurrent writer of the secret that this
      // transaction's read could not see yet, so a password never stays bound to another host.
      expect(await write({ 'smtp.host': 'mail.example.org' })).toEqual(['smtp.host']);
      expect(await row('smtp.password')).toMatchObject({ value: null, is_secret: 1 });
      expect(await write({ 'smtp.host': 'mail2.example.org' })).toEqual(['smtp.host']);
      expect((await row('smtp.password'))?.value).toBeNull();
    });

    it('T8: a host change racing a write of {host, password} ends with the password unset (meaningful on PostgreSQL and MySQL/MariaDB)', async () => {
      let entered!: () => void;
      const written = new Promise<void>((resolve) => (entered = resolve));
      let release!: () => void;
      const held = new Promise<void>((resolve) => (release = resolve));
      // Super admin 1 sets host A with its password and has not committed yet.
      const first = withTx(h, async (trx) => {
        await writeSettings(trx, { 'smtp.host': 'a.example.org', 'smtp.password': 'untuk-A' }, { keyring, now: NOW, actorId: null });
        entered();
        await held;
      });
      await written;
      // Super admin 2 changes the host only.
      const second = write({ 'smtp.host': 'b.example.org' });
      release();
      await first;
      await second;
      expect((await readSettings(h.db, ['smtp.host'], keyring))['smtp.host']).toBe('b.example.org');
      expect(await readSecret(h.db, 'smtp.password', keyring)).toBeNull();
    });

    it('an explicit smtp.password: null with a changed host is one clear, reported once', async () => {
      await withPassword();
      expect(await write({ 'smtp.host': 'mail.example.org', 'smtp.password': null })).toEqual(['smtp.host', 'smtp.password']);
      expect(await readSecret(h.db, 'smtp.password', keyring)).toBeNull();
    });

    it('a refused patch clears nothing', async () => {
      await withPassword();
      await validationErrors(() => write({ 'smtp.host': 'mail.example.org', 'smtp.port': 0 }));
      expect(await readSecret(h.db, 'smtp.password', keyring)).toBe('rahasia');
      expect((await readSettings(h.db, ['smtp.host'], keyring))['smtp.host']).toBe('smtp.example.org');
    });
  });

  describe('L37: scopes', () => {
    it('after the seeds and one write of every group, settings holds only registered keys with their registered scope', async () => {
      await seedInstall({ name: 'Perpustakaan', timezone: 'Asia/Jakarta', locale: 'id' });
      for (const group of GROUPS) {
        const patch: Partial<Record<SettingKey, unknown>> = {};
        for (const key of groupKeys(group)) patch[key] = SAMPLE[key];
        expect((await write(patch)).sort(), group).toEqual([...groupKeys(group)].sort());
      }
      const stored = await h.db.selectFrom('settings').select(['key', 'scope', 'is_secret']).execute();
      expect(stored.map((r) => r.key).sort()).toEqual(Object.keys(SETTINGS).sort());
      for (const r of stored) {
        const def = SETTINGS[r.key as SettingKey];
        expect(def, r.key).toBeDefined();
        expect(r.scope, r.key).toBe(def.scope);
        expect(Object.keys(SETTINGS_SCOPE_CLASS), r.key).toContain(r.scope);
        expect(r.is_secret, r.key).toBe(def.secret ? 1 : 0);
      }
      // Everything reads back as written (the secret as isSet).
      const all = Object.keys(SETTINGS) as SettingKey[];
      const read = await readSettings(h.db, all, keyring);
      for (const key of all) expect(read[key], key).toEqual(key === 'smtp.password' ? { isSet: true } : SAMPLE[key]);
    });

    it('a write puts a row with a wrong scope back to the registered one', async () => {
      await h.db
        .insertInto('settings')
        .values({ key: 'opac.accent', value: '"red"', is_secret: 0, scope: 'instance', updated_at: NOW, updated_by: null })
        .execute();
      await write({ 'opac.accent': 'green' });
      expect(await row('opac.accent')).toMatchObject({ value: '"green"', scope: 'data' });
    });
  });

  describe('createSettingsCache', () => {
    let t: number;
    const clock = () => t;
    const setDirect = (key: string, value: unknown) =>
      h.db
        .updateTable('settings')
        .set({ value: JSON.stringify(value), updated_at: t })
        .where('key', '=', key)
        .execute();

    beforeEach(async () => {
      t = T0;
      await seedInstall();
    });

    it('serves a value cached at t0 at t0 + 29 s and re-reads it at t0 + 31 s (P6)', async () => {
      const cache = createSettingsCache({ clock });
      expect(await cache.get<string>(h.db, 'library.name')).toBe('Perpustakaan Pelita');
      await setDirect('library.name', 'Dari proses lain');
      t = T0 + 29_000;
      expect(await cache.get<string>(h.db, 'library.name')).toBe('Perpustakaan Pelita');
      t = T0 + 31_000;
      expect(await cache.get<string>(h.db, 'library.name')).toBe('Dari proses lain');
    });

    it('the default time to live is 30 s: stale just under it, re-read from it on', async () => {
      const cache = createSettingsCache({ clock });
      await cache.get(h.db, 'library.name');
      await setDirect('library.name', 'Baru');
      t = T0 + 29_999;
      expect(await cache.get(h.db, 'library.name')).toBe('Perpustakaan Pelita');
      t = T0 + 30_000;
      expect(await cache.get(h.db, 'library.name')).toBe('Baru');
    });

    it('takes a time to live of its own, and each key ages on its own', async () => {
      const cache = createSettingsCache({ ttlMs: 5_000, clock });
      await cache.get(h.db, 'library.name');
      t = T0 + 3_000;
      await cache.get(h.db, 'library.locale');
      await setDirect('library.name', 'Baru');
      await setDirect('library.locale', 'id');
      t = T0 + 6_000;
      expect(await cache.get(h.db, 'library.name')).toBe('Baru');
      expect(await cache.get(h.db, 'library.locale')).toBe('en');
      t = T0 + 8_000;
      expect(await cache.get(h.db, 'library.locale')).toBe('id');
    });

    it('serves a default for an absent row, and caches that too', async () => {
      const cache = createSettingsCache({ clock });
      expect(await cache.get<number>(h.db, 'security.session_idle_minutes')).toBe(30);
      await write({ 'security.session_idle_minutes': 60 });
      t = T0 + 10_000;
      expect(await cache.get<number>(h.db, 'security.session_idle_minutes')).toBe(30);
    });

    it('invalidate() makes the next get read at once: a writer sees its own write (M17)', async () => {
      const cache = createSettingsCache({ clock });
      expect(await cache.get<number>(h.db, 'security.password_min_length')).toBe(10);
      await withTx(h, (trx) => writeSettings(trx, { 'security.password_min_length': 14 }, { keyring, now: NOW, actorId: null }));
      // Before the afterCommit hook runs, this process still serves the old value (as another process may, for up to 30 s).
      expect(await cache.get<number>(h.db, 'security.password_min_length')).toBe(10);
      cache.invalidate();
      expect(await cache.get<number>(h.db, 'security.password_min_length')).toBe(14);
    });

    it('a read already running when invalidate() is called does not put its stale value back', async () => {
      const cache = createSettingsCache({ clock });
      const inFlight = cache.get<string>(h.db, 'library.name');
      cache.invalidate();
      expect(await inFlight).toBe('Perpustakaan Pelita');
      await setDirect('library.name', 'Setelah invalidasi');
      expect(await cache.get<string>(h.db, 'library.name')).toBe('Setelah invalidasi');
    });

    it('never caches a secret: it reads {isSet} afresh every time', async () => {
      const cache = createSettingsCache({ clock });
      expect(await cache.get<{ isSet: boolean }>(h.db, 'smtp.password')).toEqual({ isSet: false });
      await write({ 'smtp.password': 'rahasia' });
      expect(await cache.get<{ isSet: boolean }>(h.db, 'smtp.password')).toEqual({ isSet: true });
      await write({ 'smtp.password': null });
      expect(await cache.get<{ isSet: boolean }>(h.db, 'smtp.password')).toEqual({ isSet: false });
    });

    it('does not cache what a transaction reads (it may roll back)', async () => {
      const cache = createSettingsCache({ clock });
      await withTx(h, async (trx) => {
        await writeSettings(trx, { 'library.name': 'Belum pasti' }, { keyring, now: NOW, actorId: null });
        expect(await cache.get<string>(trx, 'library.name')).toBe('Belum pasti');
        throw new Error('rolled back');
      }).catch(() => undefined);
      expect(await cache.get<string>(h.db, 'library.name')).toBe('Perpustakaan Pelita');
    });

    it('uses Date.now when no clock is given', async () => {
      const cache = createSettingsCache();
      expect(await cache.get<string>(h.db, 'library.locale')).toBe('en');
      await setDirect('library.locale', 'id');
      expect(await cache.get<string>(h.db, 'library.locale')).toBe('en');
      cache.invalidate();
      expect(await cache.get<string>(h.db, 'library.locale')).toBe('id');
    });
  });

  // ---- Komunitas K1 (settings) ----
  describe('the accreditation settings', () => {
    it('every key reads its default on an empty table', async () => {
      const keys = [...groupKeys('accreditation'), 'visits.dedupeMinutes' as const];
      expect(await readSettings(h.db, keys, keyring)).toEqual(Object.fromEntries(keys.map((k) => [k, SETTINGS[k].default])));
    });

    it('a processed-copies threshold under 50 is refused with VALIDATION_FAILED and nothing is written', async () => {
      expect(await validationErrors(() => write({ 'accreditation.k7.processedThresholdPct': 40 }))).toEqual([
        { path: 'accreditation.k7.processedThresholdPct', code: 'too_small' },
      ]);
      expect(await row('accreditation.k7.processedThresholdPct')).toBeUndefined();
    });

    it('the visit repeat window takes 0 and 720 minutes and refuses 721', async () => {
      await write({ 'visits.dedupeMinutes': 0 });
      expect((await readSettings(h.db, ['visits.dedupeMinutes'], keyring))['visits.dedupeMinutes']).toBe(0);
      await write({ 'visits.dedupeMinutes': 720 });
      expect((await readSettings(h.db, ['visits.dedupeMinutes'], keyring))['visits.dedupeMinutes']).toBe(720);
      expect(await validationErrors(() => write({ 'visits.dedupeMinutes': 721 }))).toEqual([{ path: 'visits.dedupeMinutes', code: 'too_big' }]);
    });

    it('loadAccredSettings: the defaults, the library type and time zone, and no group for unknown members outside a school', async () => {
      expect(await loadAccredSettings(h.db)).toEqual({
        schoolYearStartMonth: 7,
        fiction: { collectionTypeCodes: ['FIKSI'], callNumberPrefixes: [], ddcPrefixes: [] },
        referenceCollectionTypeCodes: ['REF'],
        electronicMaterialTypeCodes: ['EBOOK'],
        usedUnit: 'titles',
        websiteFeatures: {},
        liveFrom: null,
        evidenceMaxMb: 5,
        componentLimitMb: 9,
        textbookCollectionTypeCodes: [],
        k7ThresholdPct: 100,
        undatedShareMaxPct: 10,
        dedupeLegacy: true,
        unknownMemberGroupDefault: null,
        dedupeMinutes: 60,
        libraryType: null,
        timezone: 'Asia/Jakarta',
      });
    });

    it("loadAccredSettings: 'auto' is students for a school library, none for a public one; an explicit choice stays", async () => {
      await write({ 'library.type': 'sekolah', 'library.timezone': 'Asia/Makassar' });
      expect(await loadAccredSettings(h.db)).toMatchObject({ unknownMemberGroupDefault: 'student', libraryType: 'sekolah', timezone: 'Asia/Makassar' });
      await write({ 'library.type': 'umum' });
      expect((await loadAccredSettings(h.db)).unknownMemberGroupDefault).toBeNull();
      await write({ 'library.type': 'sekolah', 'accreditation.unknownMemberGroup.default': null });
      expect((await loadAccredSettings(h.db)).unknownMemberGroupDefault).toBeNull();
      await write({ 'accreditation.unknownMemberGroup.default': 'teacher', 'accreditation.k7.processedThresholdPct': 90, 'visits.dedupeMinutes': 0 });
      expect(await loadAccredSettings(h.db)).toMatchObject({ unknownMemberGroupDefault: 'teacher', k7ThresholdPct: 90, dedupeMinutes: 0 });
    });

    describe('evidence uploads', () => {
      const STAFF = newId(NOW);
      const MIB = 1024 * 1024;
      const owner = uploadOwner(STAFF);
      const sha = (data: Uint8Array): string => createHash('sha256').update(data).digest('hex');

      beforeAll(async () => {
        await h.db
          .insertInto('staff_users')
          .values({ id: STAFF, username_key: 'bukti', username_display: 'bukti', name: 'Petugas Bukti', password_hash: 'x', status: 'active', created_at: NOW, updated_at: NOW })
          .execute();
      });

      /** What `fn` throws, which must be a DomainError. */
      async function failure(fn: () => Promise<unknown>): Promise<{ code: string; meta?: Record<string, unknown> }> {
        try {
          await fn();
        } catch (error) {
          if (!isDomainError(error)) throw error;
          return { code: error.code, ...(error.meta === undefined ? {} : { meta: error.meta }) };
        }
        return expect.fail('did not throw');
      }

      /** Declares, sends and completes an evidence upload of `data`; the file id. */
      async function upload(data: Uint8Array, name: string): Promise<string> {
        const context = uploadContext('accreditation.evidence')!;
        const session = await withTx(h, (trx) => createUpload(trx, { owner, context, size: data.byteLength, sha256: sha(data), now: NOW, dataDir }));
        try {
          for (let n = 0; n * session.chunkSize < data.byteLength; n += 1) {
            await acceptChunk(h, { id: session.id, owner, n, data: data.subarray(n * session.chunkSize, (n + 1) * session.chunkSize), now: NOW, dataDir });
          }
          const done = await completeUpload(h, { id: session.id, owner, originalName: name, now: NOW, dataDir });
          return (done as { fileId: string }).fileId;
        } finally {
          await h.db.deleteFrom('upload_sessions').where('id', '=', session.id).execute();
        }
      }

      it('takes a PDF as a staff file of its context and refuses a PNG (only PDF and JPEG)', async () => {
        const pdf = new Uint8Array(Buffer.from('%PDF-1.4\n1 0 obj << >> endobj\ntrailer << >>\n%%EOF\n', 'latin1'));
        const fileId = await upload(pdf, 'kebijakan.pdf');
        expect(await h.db.selectFrom('files').select(['context', 'mime']).where('id', '=', fileId).executeTakeFirstOrThrow()).toEqual({
          context: 'accreditation.evidence',
          mime: 'application/pdf',
        });
        const png = new Uint8Array([0x89, 0x50, 0x4e, 0x47, 0x0d, 0x0a, 0x1a, 0x0a, ...new Uint8Array(56)]);
        expect(await failure(() => upload(png, 'foto.png'))).toMatchObject({ code: 'UPLOAD_TYPE_REFUSED' });
      });

      it('accreditation.evidence.maxMb = 5: a 6 MiB PDF is refused when it is declared', async () => {
        await write({ 'accreditation.evidence.maxMb': 5 });
        const context = uploadContext('accreditation.evidence')!;
        const declare = (size: number) => withTx(h, (trx) => createUpload(trx, { owner, context, size, sha256: '0'.repeat(64), now: NOW, dataDir }));
        expect(await failure(() => declare(6 * MIB))).toEqual({ code: 'UPLOAD_TOO_LARGE', meta: expect.objectContaining({ maxBytes: 5 * MIB }) });
        const ok = await declare(5 * MIB);
        await h.db.deleteFrom('upload_sessions').where('id', '=', ok.id).execute();
      });
    });
  });
});
