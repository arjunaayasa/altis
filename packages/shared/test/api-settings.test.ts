import { describe, expect, it } from 'vitest';
import { issueCode } from '../src/api/common.js';
import {
  AccreditationSettingsBody,
  BarcodePattern,
  BarcodePatternList,
  CatalogSettingsBody,
  EmailSettingsBody,
  LabelProfile,
  LabelProfileList,
  OpacSettingsBody,
  SETTINGS_GROUPS,
  SruServer,
  SruServerList,
  passwordResetBodyField,
} from '../src/api/settings.js';

// A password-reset mail body the library writes itself must keep `{link}`: renderMail fills only the placeholders it
// knows, so a body without it (or with a translated `{tautan}`) sends every reset mail without its link while
// `auth/password/forgot` still answers 202. Blank and null read as the catalog text, which has the link.

describe('passwordResetBodyField', () => {
  it('a non-blank body without {link} → one custom issue whose field-error code is missing_link', () => {
    for (const body of ['Klik tautan berikut: {tautan}', 'Silakan atur ulang sandi Anda.', '{LINK}', '{ link }']) {
      const result = passwordResetBodyField.safeParse(body);
      expect(result.success, body).toBe(false);
      expect(result.error!.issues.map(issueCode), body).toEqual(['missing_link']);
    }
  });

  it('null, blank, or a text that keeps {link} pass; the 4000-character limit holds', () => {
    for (const body of [null, '', '   \n', 'Buka {link} dalam {minutes} menit.', '{link}']) {
      expect(passwordResetBodyField.safeParse(body).success, String(body)).toBe(true);
    }
    expect(passwordResetBodyField.safeParse(`{link}${'a'.repeat(3994)}`).success).toBe(true);
    expect(passwordResetBodyField.safeParse(`{link}${'a'.repeat(3995)}`).error?.issues.map(issueCode)).toEqual(['too_big']);
  });

  it('EmailSettingsBody refuses it at the body path, per language; the subject needs no link', () => {
    const result = EmailSettingsBody.safeParse({
      templates: { passwordReset: { id: { subject: 'Atur ulang', body: 'Klik {tautan}' }, en: { body: 'Open {link}' } } },
    });
    expect(result.success).toBe(false);
    expect(result.error!.issues.map((i) => ({ path: i.path.join('.'), code: issueCode(i) }))).toEqual([
      { path: 'templates.passwordReset.id.body', code: 'missing_link' },
    ]);
    expect(EmailSettingsBody.safeParse({ templates: { passwordReset: { en: { subject: 'No link here', body: null } } } }).success).toBe(true);
  });
});

describe('issueCode', () => {
  it("is the issue's own code, or the code a custom issue of ours names in params.code", () => {
    expect(issueCode({ code: 'too_big' })).toBe('too_big');
    expect(issueCode({ code: 'custom' })).toBe('custom');
    expect(issueCode({ code: 'custom', params: { code: 'missing_link' } })).toBe('missing_link');
    expect(issueCode({ code: 'custom', params: { code: 7 } })).toBe('custom');
  });
});

// ---- Phase 2 (catalog): Task 2 ----
// The catalog settings group (Phase 2 spec §12.6, §7, §6.2) and the six new OPAC keys: strict bodies whose limits are
// the settings registry's (packages/core/src/settings/registry.ts reuses these schemas).

const pattern = (over: Record<string, unknown> = {}) => ({ id: 'default', name: 'Bawaan', prefix: 'B', digits: 7, suffix: '', ...over });

const profile = (over: Record<string, unknown> = {}) => ({
  id: 'spine-a4',
  name: 'Label punggung A4',
  kind: 'spine',
  page: 'A4',
  marginMm: { t: 14, r: 10, b: 14, l: 10 },
  cols: 3,
  rows: 10,
  labelWMm: 60,
  labelHMm: 26,
  gapXMm: 5,
  gapYMm: 1,
  fontPt: 9,
  header: '',
  showLibraryName: false,
  symbology: null,
  titleMaxChars: 0,
  border: true,
  ...over,
});

const server = (over: Record<string, unknown> = {}) => ({
  id: 'loc',
  name: 'Library of Congress',
  url: 'http://lx2.loc.gov:210/LCDB',
  version: '1.1',
  recordSchema: 'marcxml',
  indexes: { isbn: 'bath.isbn', title: 'dc.title', author: 'dc.creator', any: 'cql.serverChoice' },
  enabled: false,
  ...over,
});

const codes = (r: { success: boolean; error?: { issues: { code: string; params?: Record<string, unknown> }[] } }): string[] =>
  r.success ? [] : r.error!.issues.map(issueCode);

describe('BarcodePattern (§3.4)', () => {
  it('accepts the seed and stores prefix and suffix upper case', () => {
    expect(BarcodePattern.parse(pattern({ prefix: 'bk-', suffix: 'x' }))).toEqual(pattern({ prefix: 'BK-', suffix: 'X' }));
  });

  it('digits 3-12, prefix and suffix at most 16 printable ASCII characters without space, a 1-32 [a-z0-9-] id, a name of 1-64', () => {
    expect(codes(BarcodePattern.safeParse(pattern({ digits: 13 })))).toEqual(['too_big']);
    expect(codes(BarcodePattern.safeParse(pattern({ digits: 2 })))).toEqual(['too_small']);
    expect(codes(BarcodePattern.safeParse(pattern({ digits: 7.5 })))).toEqual(['invalid_type']);
    expect(codes(BarcodePattern.safeParse(pattern({ prefix: 'A'.repeat(17) })))).toEqual(['too_big']);
    for (const prefix of ['B 1', 'Bé', 'B\t', ' B']) expect(BarcodePattern.safeParse(pattern({ prefix })).success, prefix).toBe(false);
    for (const id of ['', 'Default', 'a_b', 'x'.repeat(33)]) expect(BarcodePattern.safeParse(pattern({ id })).success, id).toBe(false);
    expect(BarcodePattern.safeParse(pattern({ name: '' })).success).toBe(false);
    expect(BarcodePattern.safeParse(pattern({ name: 'n'.repeat(65) })).success).toBe(false);
    expect(BarcodePattern.safeParse(pattern({ extra: 1 })).success).toBe(false);
  });

  it('a list holds 1-20 patterns with distinct ids (M1: a 21st is refused)', () => {
    const many = (n: number) => Array.from({ length: n }, (_, i) => pattern({ id: `p-${i}` }));
    expect(BarcodePatternList.safeParse(many(20)).success).toBe(true);
    expect(codes(BarcodePatternList.safeParse(many(21)))).toEqual(['too_big']);
    expect(codes(BarcodePatternList.safeParse([]))).toEqual(['too_small']);
    expect(codes(BarcodePatternList.safeParse([pattern(), pattern()]))).toEqual(['duplicate']);
  });
});

describe('LabelProfile (§7)', () => {
  it('accepts the §7 fields, a preset page or {wMm, hMm}, and a per-profile symbology or null (the catalog default)', () => {
    expect(LabelProfile.safeParse(profile()).success).toBe(true);
    expect(LabelProfile.safeParse(profile({ page: { wMm: 210, hMm: 297 }, symbology: 'code39' })).success).toBe(true);
    expect(LabelProfile.safeParse(profile({ page: 'A5' })).success).toBe(false);
    expect(LabelProfile.safeParse(profile({ kind: 'card' })).success).toBe(false);
    expect(LabelProfile.safeParse(profile({ marginMm: { t: 1, r: 1, b: 1 } })).success).toBe(false);
    expect(LabelProfile.safeParse(profile({ page: { wMm: 210, hMm: 297, extra: 1 } })).success).toBe(false);
  });

  it('refuses a grid that does not fit the page inside its margins', () => {
    // 3 × 60 + 2 × 5 + 10 + 10 = 210: fits A4 exactly; one more millimetre does not.
    expect(LabelProfile.safeParse(profile({ labelWMm: 60 })).success).toBe(true);
    expect(codes(LabelProfile.safeParse(profile({ labelWMm: 61 })))).toEqual(['does_not_fit']);
    expect(codes(LabelProfile.safeParse(profile({ rows: 11 })))).toEqual(['does_not_fit']);
    expect(LabelProfile.safeParse(profile({ page: 'F4', rows: 11 })).success).toBe(true);
  });

  it('a list holds 1-20 profiles with distinct ids', () => {
    const many = (n: number) => Array.from({ length: n }, (_, i) => profile({ id: `l-${i}` }));
    expect(LabelProfileList.safeParse(many(20)).success).toBe(true);
    expect(codes(LabelProfileList.safeParse(many(21)))).toEqual(['too_big']);
    expect(codes(LabelProfileList.safeParse([profile(), profile()]))).toEqual(['duplicate']);
  });
});

describe('SruServer (§6.2)', () => {
  it('accepts an http(s) URL of at most 500 characters, or an empty one while disabled', () => {
    expect(SruServer.safeParse(server()).success).toBe(true);
    expect(SruServer.safeParse(server({ url: 'https://sru.example.id/sru?x-db=main', enabled: true })).success).toBe(true);
    expect(SruServer.safeParse(server({ url: '', enabled: false })).success).toBe(true);
    expect(codes(SruServer.safeParse(server({ url: '', enabled: true })))).toEqual(['required']);
    expect(codes(SruServer.safeParse(server({ url: `https://x.id/${'a'.repeat(490)}` })))).toEqual(['too_big']);
  });

  it('refuses another scheme, credentials, a fragment, white space or a control character in the URL', () => {
    for (const url of [
      'ftp://sru.example.id/',
      'javascript:alert(1)',
      'https://user:pw@sru.example.id/',
      'https://sru.example.id/#x',
      'https://sru.example.id/a b',
      'https://sru.exa\nmple.id/',
      'sru.example.id',
    ]) {
      expect(codes(SruServer.safeParse(server({ url }))), url).toEqual(['invalid_format']);
    }
  });

  it('version 1.1, 1.2 or 2.0; record schema and indexes 1-64 printable characters', () => {
    expect(SruServer.safeParse(server({ version: '1.0' })).success).toBe(false);
    expect(SruServer.safeParse(server({ recordSchema: 'x'.repeat(65) })).success).toBe(false);
    expect(SruServer.safeParse(server({ indexes: { isbn: 'bath isbn', title: 'dc.title', author: 'dc.creator', any: 'cql.serverChoice' } })).success).toBe(false);
    expect(SruServer.safeParse(server({ indexes: { isbn: 'bath.isbn', title: 'dc.title', author: 'dc.creator' } })).success).toBe(false);
  });

  it('a list holds at most 10 servers with distinct ids', () => {
    const many = (n: number) => Array.from({ length: n }, (_, i) => server({ id: `s-${i}` }));
    expect(SruServerList.safeParse([]).success).toBe(true);
    expect(SruServerList.safeParse(many(10)).success).toBe(true);
    expect(codes(SruServerList.safeParse(many(11)))).toEqual(['too_big']);
    expect(codes(SruServerList.safeParse([server(), server()]))).toEqual(['duplicate']);
  });
});

describe('CatalogSettingsBody and the new OpacSettingsBody keys', () => {
  it('takes every catalog key under its name without the group prefix; strict at every level', () => {
    const body = {
      marcOrgCode: 'IdJaPN',
      defaultMaterialTypeId: '01HZY0000000000000000000AB',
      defaultCollectionTypeId: null,
      currency: 'IDR',
      barcode: { patterns: [pattern()], symbology: 'code39' },
      labelProfiles: [profile()],
      sru: { servers: [server()], allowPrivateHosts: false },
      isbn: { arsyaEnabled: false },
      attachment: { maxMb: 2048 },
      dedupe: { threshold: 50 },
    };
    expect(CatalogSettingsBody.safeParse(body).success).toBe(true);
    expect(CatalogSettingsBody.safeParse({}).success).toBe(true);
    expect(CatalogSettingsBody.safeParse({ ...body, extra: 1 }).success).toBe(false);
    expect(CatalogSettingsBody.safeParse({ barcode: { pattern: [] } }).success).toBe(false);
    expect(CatalogSettingsBody.safeParse({ sru: { allowPrivate: true } }).success).toBe(false);
  });

  it('the limits of §12.6', () => {
    const bad = [
      { marcOrgCode: '' },
      { marcOrgCode: 'x'.repeat(17) },
      { marcOrgCode: 'Id Ja' },
      { currency: 'idr' },
      { currency: 'IDRX' },
      { defaultMaterialTypeId: 'not-a-ulid' },
      { attachment: { maxMb: 0 } },
      { attachment: { maxMb: 2049 } },
      { dedupe: { threshold: 49 } },
      { dedupe: { threshold: 101 } },
      { barcode: { symbology: 'qr' } },
    ];
    for (const b of bad) expect(CatalogSettingsBody.safeParse(b).success, JSON.stringify(b)).toBe(false);
  });

  it('opac: resultsPerPage 10-50, newTitlesCount 0-48, the OAI admin e-mail an address or empty', () => {
    const ok = { resultsPerPage: 10, indexable: false, oai: { enabled: true, adminEmail: '' }, showShelfMap: false, newTitlesCount: 0 };
    expect(OpacSettingsBody.safeParse(ok).success).toBe(true);
    expect(OpacSettingsBody.safeParse({ oai: { adminEmail: 'pustakawan@perpus.example.id' } }).success).toBe(true);
    for (const b of [{ resultsPerPage: 9 }, { resultsPerPage: 51 }, { newTitlesCount: 49 }, { oai: { adminEmail: 'bukan e-mail' } }, { oai: { x: 1 } }]) {
      expect(OpacSettingsBody.safeParse(b).success, JSON.stringify(b)).toBe(false);
    }
    expect(codes(OpacSettingsBody.safeParse({ oai: { adminEmail: 'x@' } }))).toEqual(['invalid_format']);
  });

  it('SETTINGS_GROUPS lists catalog after the Phase 1 groups', () => {
    expect([...SETTINGS_GROUPS].slice(0, 5)).toEqual(['library', 'email', 'security', 'opac', 'catalog']);
  });
});

// ---- Komunitas K1 (settings) ----
// The accreditation group: a strict body of the sixteen settings under their names without `accreditation.`, with the
// limits of the settings registry (which reuses these schemas). `visits.dedupeMinutes` is not part of it: its group has
// no screen yet.

describe('AccreditationSettingsBody', () => {
  const ULID = '01JZ0000000000000000000ABC';
  const full = {
    schoolYearStartMonth: 7,
    fiction: { collectionTypeCodes: ['fiksi', 'NOVEL'], callNumberPrefixes: ['F', 'FIK'], ddcPrefixes: ['8', '899.2'] },
    referenceCollectionTypeCodes: ['REF'],
    electronicMaterialTypeCodes: ['EBOOK'],
    usedUnit: 'items',
    websiteFeatures: { profilePageId: ULID, faqPageId: ULID, socialUrls: ['https://instagram.com/perpus', 'http://perpus.sch.id/fb'] },
    liveFrom: '2025-07-01',
    evidence: { maxMb: 5, componentLimitMb: 9 },
    textbookCollectionTypeCodes: [],
    k7: { processedThresholdPct: 95 },
    undatedShareMaxPct: 10,
    visits: { dedupeLegacy: false },
    unknownMemberGroup: { default: 'auto' },
  };

  it('SETTINGS_GROUPS ends with accreditation, then circulation and members, then visits and privacy', () => {
    expect([...SETTINGS_GROUPS]).toEqual(['library', 'email', 'security', 'opac', 'catalog', 'accreditation', 'circulation', 'members', 'visits', 'privacy']);
  });

  it('takes every key, nested as the setting names are, and upper-cases the codes', () => {
    const parsed = AccreditationSettingsBody.parse(full);
    expect(parsed.fiction?.collectionTypeCodes).toEqual(['FIKSI', 'NOVEL']);
    expect(AccreditationSettingsBody.safeParse({}).success).toBe(true);
    expect(AccreditationSettingsBody.safeParse({ unknownMemberGroup: { default: null } }).success).toBe(true);
    expect(AccreditationSettingsBody.safeParse({ unknownMemberGroup: { default: 'teacher' } }).success).toBe(true);
    expect(AccreditationSettingsBody.safeParse({ liveFrom: null }).success).toBe(true);
  });

  it('is strict at every level', () => {
    expect(codes(AccreditationSettingsBody.safeParse({ dedupeMinutes: 60 }))).toEqual(['unrecognized_keys']);
    expect(codes(AccreditationSettingsBody.safeParse({ fiction: { prefixes: [] } }))).toEqual(['unrecognized_keys']);
    expect(codes(AccreditationSettingsBody.safeParse({ websiteFeatures: { homePageId: ULID } }))).toEqual(['unrecognized_keys']);
  });

  it('holds the limits of each setting', () => {
    const refused = (body: unknown): string[] => codes(AccreditationSettingsBody.safeParse(body));
    expect(refused({ schoolYearStartMonth: 13 })).toEqual(['too_big']);
    expect(refused({ schoolYearStartMonth: 0 })).toEqual(['too_small']);
    expect(refused({ k7: { processedThresholdPct: 40 } })).toEqual(['too_small']);
    expect(refused({ evidence: { maxMb: 101 } })).toEqual(['too_big']);
    expect(refused({ undatedShareMaxPct: 101 })).toEqual(['too_big']);
    expect(refused({ fiction: { collectionTypeCodes: Array.from({ length: 21 }, (_, i) => `K${i}`) } })).toEqual(['too_big']);
    expect(refused({ fiction: { ddcPrefixes: Array.from({ length: 51 }, (_, i) => `${i}`) } })).toEqual(['too_big']);
    expect(refused({ fiction: { callNumberPrefixes: ['x'.repeat(17)] } })).toEqual(['too_big']);
    expect(refused({ referenceCollectionTypeCodes: [''] })).toEqual(['too_small']);
    expect(refused({ usedUnit: 'pages' })).toEqual(['invalid_value']);
    expect(refused({ liveFrom: '2025-02-30' })).toEqual(['invalid_format']);
    expect(refused({ unknownMemberGroup: { default: 'guest' } })).toEqual(['invalid_value']);
    expect(refused({ websiteFeatures: { socialUrls: ['ftp://x.example'] } })).toEqual(['invalid_format']);
    expect(refused({ websiteFeatures: { socialUrls: Array.from({ length: 6 }, () => 'https://x.example') } })).toEqual(['too_big']);
    expect(refused({ websiteFeatures: { profilePageId: 'halaman-profil' } })).toEqual(['custom']);
  });
});
