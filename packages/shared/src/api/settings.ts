/**
 * The settings API vocabulary shared by the server and the admin SPA (spec §6.5, §13.3; decisions D26, D41). No Node
 * built-ins here: the browser bundles this module. Import it as `@altis/shared/api/settings`.
 *
 * Each group an admin edits has one strict body (`PUT settings/<group>`) whose keys are the names of its settings
 * without the group prefix (`library.name` → `name`, `email.template.password_reset.id.subject` →
 * `templates.passwordReset.id.subject`); `GET settings/:group` answers the same shape with every key filled. A key left
 * out keeps its value, `null` clears one that may be cleared (it then reads as its default). The limits are those of
 * the settings registry (packages/core/src/settings/registry.ts), which the server applies again when it writes.
 */
import { z } from 'zod';
import { localeField, timezoneField, ulidField } from './common.js';
import { ACCRED_GROUPS } from '../accreditation-vocab.js';
import { isCalendarDate } from '../dates.js';
import { CardProfile } from './member-ops.js';

/** The card profile as the members settings carry it. */
export type CardProfileForSettings = CardProfile;
import type { Locale } from '../i18n/index.js';

/**
 * The groups of `GET settings/:group` and `PUT settings/<group>`; SMTP is part of the system configuration. Phase 2
 * adds `catalog` (its spec §12.6), read and written with the same `system.settings.read`/`manage`.
 */
export const SETTINGS_GROUPS = Object.freeze([
  'library',
  'email',
  'security',
  'opac',
  // ---- Phase 2 (catalog): Task 2 ----
  'catalog',
  // ---- Komunitas K1 (settings) ----
  'accreditation',
  // ---- Komunitas (circulation core) ----
  'circulation',
  'members',
  // ---- Komunitas K2 (members extended, visits, privacy) ----
  'visits',
  'privacy',
] as const);

export type SettingsGroupName = (typeof SETTINGS_GROUPS)[number];

/** `library.type`. */
export const LIBRARY_TYPES = Object.freeze(['sekolah', 'perguruan_tinggi', 'umum', 'khusus'] as const);

export type LibraryType = (typeof LIBRARY_TYPES)[number];

/** `opac.accent`: the OPAC theme's accent colours. */
export const OPAC_ACCENTS = Object.freeze(['teal', 'blue', 'green', 'purple', 'red', 'slate'] as const);

export type OpacAccent = (typeof OPAC_ACCENTS)[number];

/** A text of at most `max` characters, or null. Not trimmed: multi-line texts keep what was typed. */
const textOrNull = (max: number) => z.string().max(max).nullable();

/** `PUT settings/library`. */
export const LibrarySettingsBody = z.strictObject({
  name: z.string().trim().min(1).max(191).optional(),
  type: z.enum(LIBRARY_TYPES).nullable().optional(),
  address: textOrNull(1000).optional(),
  timezone: timezoneField.optional(),
  locale: localeField.optional(),
});

export type LibrarySettingsBody = z.infer<typeof LibrarySettingsBody>;

/** The placeholder a password-reset mail body must keep: the reset link renderMail fills in. */
export const RESET_LINK_PLACEHOLDER = '{link}';

/**
 * A password-reset mail body (`email.template.password_reset.<locale>.body`): null or blank (both read as the catalog
 * text, which has the link), or at most 4000 characters that keep {@link RESET_LINK_PLACEHOLDER}. A non-blank body
 * without it is refused with the field-error code `missing_link` (issueCode): renderMail fills only the placeholders
 * it knows, so every reset mail would go out without its link (a translated `{tautan}` included) while
 * `auth/password/forgot` still answers 202.
 */
export const passwordResetBodyField = z
  .string()
  .max(4000)
  .check((ctx) => {
    if (ctx.value.trim() !== '' && !ctx.value.includes(RESET_LINK_PLACEHOLDER)) {
      ctx.issues.push({ code: 'custom', params: { code: 'missing_link' }, message: 'missing_link', input: ctx.value });
    }
  })
  .nullable();

/** One mail template: null (or blank) is the catalog text. */
const EmailTemplateBody = z.strictObject({
  subject: textOrNull(200).optional(),
  body: passwordResetBodyField.optional(),
});

/** `PUT settings/email`: the sender's display name and the password-reset mail per language. */
export const EmailSettingsBody = z.strictObject({
  senderName: textOrNull(100).optional(),
  templates: z
    .strictObject({
      passwordReset: z.strictObject({ id: EmailTemplateBody.optional(), en: EmailTemplateBody.optional() }).optional(),
    })
    .optional(),
});

export type EmailSettingsBody = z.infer<typeof EmailSettingsBody>;

/** `PUT settings/security` (needs a reauth, §7.3). */
export const SecuritySettingsBody = z.strictObject({
  passwordMinLength: z.int().min(10).max(64).optional(),
  sessionIdleMinutes: z.int().min(5).max(240).optional(),
});

export type SecuritySettingsBody = z.infer<typeof SecuritySettingsBody>;

// ---- Phase 2 (catalog): Task 2 ----
const EMAIL = z.email();

/**
 * `opac.oai.adminEmail` (Phase 2 spec §10): an address of at most 191 characters, or `''` (OAI-PMH then answers 503 and
 * Diagnostik warns). One issue code for both forms (`invalid_format`): a z.union would report `invalid_union`.
 */
export const oaiAdminEmailField = z
  .string()
  .max(191)
  .check((ctx) => {
    if (ctx.value !== '' && !EMAIL.safeParse(ctx.value).success) {
      ctx.issues.push({ code: 'invalid_format', format: 'email', input: ctx.value });
    }
  });

/** `PUT settings/opac`; Phase 2 adds the search page size, indexing, OAI-PMH, the shelf map and the new titles. */
export const OpacSettingsBody = z.strictObject({
  welcome: z.strictObject({ id: textOrNull(1000).optional(), en: textOrNull(1000).optional() }).optional(),
  accent: z.enum(OPAC_ACCENTS).optional(),
  // ---- Phase 2 (catalog): Task 2 ----
  resultsPerPage: z.int().min(10).max(50).optional(),
  indexable: z.boolean().optional(),
  oai: z.strictObject({ enabled: z.boolean().optional(), adminEmail: oaiAdminEmailField.optional() }).optional(),
  showShelfMap: z.boolean().optional(),
  newTitlesCount: z.int().min(0).max(48).optional(),
});

export type OpacSettingsBody = z.infer<typeof OpacSettingsBody>;

/** `GET settings/library`. */
export interface LibrarySettings {
  name: string;
  type: LibraryType | null;
  address: string | null;
  timezone: string;
  locale: Locale;
}

/** A mail template as stored: null is the catalog text. */
export interface EmailTemplate {
  subject: string | null;
  body: string | null;
}

/** `GET settings/email`. */
export interface EmailSettings {
  /** null: the library's name. */
  senderName: string | null;
  templates: { passwordReset: { id: EmailTemplate; en: EmailTemplate } };
}

/** `GET settings/security`. */
export interface SecuritySettings {
  passwordMinLength: number;
  sessionIdleMinutes: number;
}

/** `GET settings/opac`. */
export interface OpacSettings {
  welcome: { id: string | null; en: string | null };
  accent: OpacAccent;
  // ---- Phase 2 (catalog): Task 2 ----
  /** Search results per page, 10-50 (default 20). */
  resultsPerPage: number;
  /** Search engines may index the OPAC (robots, `noindex`); default true. */
  indexable: boolean;
  /** OAI-PMH answers only while `enabled` and `adminEmail` is set; otherwise 503 and a Diagnostik warning. */
  oai: { enabled: boolean; adminEmail: string };
  /** The record page shows the shelf map; default true. */
  showShelfMap: boolean;
  /** New titles on the OPAC home, 0-48 (default 12; 0 hides the block). */
  newTitlesCount: number;
}

/** What `GET settings/:group` answers, per group. */
export interface SettingsView {
  library: LibrarySettings;
  email: EmailSettings;
  security: SecuritySettings;
  opac: OpacSettings;
  // ---- Phase 2 (catalog): Task 2 ----
  catalog: CatalogSettings;
  // ---- Komunitas K1 (settings) ----
  accreditation: AccreditationSettingsView;
  // ---- Komunitas (circulation core) ----
  circulation: CirculationSettingsView;
  members: MembersSettingsView;
  // ---- Komunitas K2 (members extended, visits, privacy) ----
  visits: VisitsSettingsView;
  privacy: PrivacySettingsView;
}

/**
 * What every `PUT settings/<group>` answers: the settings whose value changed (their registry names, in registry
 * order; empty when every value sent was the stored one). The values themselves are read with `GET settings/:group`.
 */
export interface SettingsPutResponse {
  changed: string[];
}

// ---- Phase 2 (catalog): Task 2 ----------------------------------------------------------------------------------
// The `catalog` group (Phase 2 spec §12.6): its value schemas, which the settings registry
// (packages/core/src/settings/registry.ts) reuses, its strict body and its view, and `GET catalog/config`'s answer.

/** A field-error issue of our own (`params.code`, read by issueCode). */
function ownIssue(code: string, input: unknown, path: PropertyKey[] = []) {
  return { code: 'custom' as const, params: { code }, message: code, input, path };
}

/**
 * The id of a barcode pattern, a label profile or an SRU server: 1-32 lower-case letters, digits or `-`. Other requests
 * and screens refer to an entry by it (a label request's `profileId`, an SRU search's `server`).
 */
export const catalogConfigIdField = z.string().regex(/^[a-z0-9-]{1,32}$/);

/** A name shown in the admin: 1-64 characters, trimmed, no control character. */
const configNameField = z.string().trim().min(1).max(64).regex(/^\P{Cc}*$/u);

/** A token of an outside protocol (an SRU index, a record schema): 1-64 printable ASCII characters, no space. */
const asciiTokenField = z.string().min(1).max(64).regex(/^[\x21-\x7E]*$/);

/** Distinct `id`s in a list of entries: a repeated one is the field error `duplicate`, at that entry's `id`. */
function distinctIds(ctx: { value: readonly { id: string }[]; issues: unknown[] }): void {
  const seen = new Set<string>();
  for (const [i, entry] of ctx.value.entries()) {
    if (seen.has(entry.id)) ctx.issues.push(ownIssue('duplicate', entry.id, [i, 'id']));
    seen.add(entry.id);
  }
}

/** `catalog.barcode.symbology` and a label profile's own symbology. */
export const BARCODE_SYMBOLOGIES = Object.freeze(['code128', 'code39'] as const);

export type BarcodeSymbology = (typeof BARCODE_SYMBOLOGIES)[number];

/**
 * A barcode prefix or suffix (§3.4): at most 16 printable ASCII characters without space, stored upper case. With no
 * space, every barcode a pattern makes is already in the normal form of §3.4 (nothing to trim or collapse), and at most
 * 16 + 12 + 16 = 44 characters long.
 */
const barcodeAffixField = z.string().max(16).regex(/^[\x21-\x7E]*$/).toUpperCase();

/**
 * One barcode numbering pattern (`catalog.barcode.patterns`, §3.4): barcodes `<prefix><number zero-padded to
 * digits><suffix>`, numbered by the items service.
 */
export const BarcodePattern = z.strictObject({
  id: catalogConfigIdField,
  name: configNameField,
  prefix: barcodeAffixField,
  digits: z.int().min(3).max(12),
  suffix: barcodeAffixField,
});

export type BarcodePattern = z.infer<typeof BarcodePattern>;

/** `catalog.barcode.patterns`: 1-20 patterns with distinct ids (M1: a 21st is refused). */
export const BarcodePatternList = z.array(BarcodePattern).min(1).max(20).check(distinctIds);

/** The kinds of label (§7): the call number on the spine, the barcode, or both on one label. */
export const LABEL_KINDS = Object.freeze(['spine', 'barcode', 'spine_barcode'] as const);

export type LabelKind = (typeof LABEL_KINDS)[number];

/** The page sizes a label profile may name, in millimetres (F4 as Indonesian offices use it: 215 × 330). */
export const LABEL_PAGE_MM = Object.freeze({
  A4: Object.freeze({ w: 210, h: 297 }),
  F4: Object.freeze({ w: 215, h: 330 }),
  Letter: Object.freeze({ w: 215.9, h: 279.4 }),
} as const);

export type LabelPageName = keyof typeof LABEL_PAGE_MM;

const LABEL_PAGE_NAMES = Object.freeze(['A4', 'F4', 'Letter'] as const satisfies readonly LabelPageName[]);

/** A length in millimetres between `min` and `max` (Zod numbers refuse Infinity and NaN). */
const mm = (min: number, max: number) => z.number().min(min).max(max);

/** Slack for sums of decimal millimetres (3 × 70.1 is not exactly 210.3 in binary). */
const FIT_EPSILON_MM = 1e-6;

/**
 * One label sheet profile (`catalog.labelProfiles`, §7). `page` is a named size or `{wMm, hMm}`; `marginMm` the page
 * margins; `cols` × `rows` labels of `labelWMm` × `labelHMm` with `gapXMm`/`gapYMm` between them, which must fit the page
 * inside its margins (field error `does_not_fit`). `header` is an optional first line (`''` for none); `symbology` null
 * uses `catalog.barcode.symbology`; `titleMaxChars` cuts the title (0: no title).
 */
export const LabelProfile = z
  .strictObject({
    id: catalogConfigIdField,
    name: configNameField,
    kind: z.enum(LABEL_KINDS),
    page: z.union([z.enum(LABEL_PAGE_NAMES), z.strictObject({ wMm: mm(20, 1000), hMm: mm(20, 1000) })]),
    marginMm: z.strictObject({ t: mm(0, 50), r: mm(0, 50), b: mm(0, 50), l: mm(0, 50) }),
    cols: z.int().min(1).max(10),
    rows: z.int().min(1).max(40),
    labelWMm: mm(5, 1000),
    labelHMm: mm(5, 1000),
    gapXMm: mm(0, 50),
    gapYMm: mm(0, 50),
    fontPt: mm(4, 24),
    header: z.string().trim().max(64).regex(/^\P{Cc}*$/u),
    showLibraryName: z.boolean(),
    symbology: z.enum(BARCODE_SYMBOLOGIES).nullable(),
    titleMaxChars: z.int().min(0).max(200),
    border: z.boolean(),
  })
  .check((ctx) => {
    const p = ctx.value;
    const page = typeof p.page === 'string' ? LABEL_PAGE_MM[p.page] : { w: p.page.wMm, h: p.page.hMm };
    const width = p.marginMm.l + p.cols * p.labelWMm + (p.cols - 1) * p.gapXMm + p.marginMm.r;
    const height = p.marginMm.t + p.rows * p.labelHMm + (p.rows - 1) * p.gapYMm + p.marginMm.b;
    if (width > page.w + FIT_EPSILON_MM || height > page.h + FIT_EPSILON_MM) ctx.issues.push(ownIssue('does_not_fit', p));
  });

export type LabelProfile = z.infer<typeof LabelProfile>;

/** `catalog.labelProfiles`: 1-20 profiles with distinct ids (M1). */
export const LabelProfileList = z.array(LabelProfile).min(1).max(20).check(distinctIds);

/** The SRU versions a server may speak (§6.2). */
export const SRU_VERSIONS = Object.freeze(['1.1', '1.2', '2.0'] as const);

export type SruVersion = (typeof SRU_VERSIONS)[number];

/** True for an http(s) URL without white space, control characters, credentials or a fragment. */
function isPlainHttpUrl(value: string): boolean {
  if (!/^[^\s\p{Cc}]+$/u.test(value) || value.includes('#')) return false;
  let url: URL;
  try {
    url = new URL(value);
  } catch {
    return false;
  }
  return (url.protocol === 'http:' || url.protocol === 'https:') && url.hostname !== '' && url.username === '' && url.password === '';
}

/**
 * An SRU base URL: http or https, at most 500 characters, no white space or control character, no credentials and no
 * fragment; `''` stands for "not set yet" (allowed only while the server is disabled). The outbound client checks the
 * addresses it resolves to on every request (§6.1); this only checks the form.
 */
const sruUrlField = z
  .string()
  .max(500)
  .check((ctx) => {
    if (ctx.value !== '' && !isPlainHttpUrl(ctx.value)) ctx.issues.push({ code: 'invalid_format', format: 'url', input: ctx.value });
  });

/**
 * One SRU server of copy cataloguing (`catalog.sru.servers`, §6.2): its base URL, version and record schema, and the
 * indexes it is searched with for an ISBN, a title, an author and any word. Field error `required` at `url` for an
 * enabled server without a URL.
 */
export const SruServer = z
  .strictObject({
    id: catalogConfigIdField,
    name: configNameField,
    url: sruUrlField,
    version: z.enum(SRU_VERSIONS),
    recordSchema: asciiTokenField,
    indexes: z.strictObject({ isbn: asciiTokenField, title: asciiTokenField, author: asciiTokenField, any: asciiTokenField }),
    enabled: z.boolean(),
  })
  .check((ctx) => {
    if (ctx.value.enabled && ctx.value.url === '') ctx.issues.push(ownIssue('required', ctx.value.url, ['url']));
  });

export type SruServer = z.infer<typeof SruServer>;

/** `catalog.sru.servers`: at most 10 servers with distinct ids. */
export const SruServerList = z.array(SruServer).max(10).check(distinctIds);

/** `catalog.marcOrgCode`: 1-16 letters, digits or `-` (the MARC organization code of 003 and 040 `$a`), or null. */
export const marcOrgCodeField = z.string().min(1).max(16).regex(/^[A-Za-z0-9-]*$/).nullable();

/** `catalog.currency`: an ISO 4217 code. */
export const currencyField = z.string().regex(/^[A-Z]{3}$/);

/** `catalog.attachment.maxMb`: the largest attachment, 1-2048 MB (the upload context's static ceiling is 2 GiB). */
export const attachmentMaxMbField = z.int().min(1).max(2048);

/** `catalog.dedupe.threshold`: the score from which two records are offered as duplicates, 50-100. */
export const dedupeThresholdField = z.int().min(50).max(100);

/**
 * `PUT settings/catalog`: each key is its setting's name without `catalog.` (`catalog.barcode.patterns` →
 * `barcode.patterns`). Only a super admin may change `sru.allowPrivateHosts` (M11: 403 for anyone else).
 */
export const CatalogSettingsBody = z.strictObject({
  marcOrgCode: marcOrgCodeField.optional(),
  defaultMaterialTypeId: ulidField.nullable().optional(),
  defaultCollectionTypeId: ulidField.nullable().optional(),
  currency: currencyField.optional(),
  barcode: z.strictObject({ patterns: BarcodePatternList.optional(), symbology: z.enum(BARCODE_SYMBOLOGIES).optional() }).optional(),
  labelProfiles: LabelProfileList.optional(),
  sru: z.strictObject({ servers: SruServerList.optional(), allowPrivateHosts: z.boolean().optional() }).optional(),
  /** `catalog.isbn.arsyaEnabled`: reserved, ignored by the community edition (accepted for compatibility). */
  isbn: z.strictObject({ arsyaEnabled: z.boolean().optional() }).optional(),
  attachment: z.strictObject({ maxMb: attachmentMaxMbField.optional() }).optional(),
  dedupe: z.strictObject({ threshold: dedupeThresholdField.optional() }).optional(),
});

export type CatalogSettingsBody = z.infer<typeof CatalogSettingsBody>;

/** `GET settings/catalog`. */
export interface CatalogSettings {
  /** null: an export omits 003 and the 040 `$a`. */
  marcOrgCode: string | null;
  defaultMaterialTypeId: string | null;
  defaultCollectionTypeId: string | null;
  currency: string;
  barcode: { patterns: BarcodePattern[]; symbology: BarcodeSymbology };
  labelProfiles: LabelProfile[];
  sru: { servers: SruServer[]; allowPrivateHosts: boolean };
  /** Reserved, ignored by the community edition. */
  isbn: { arsyaEnabled: boolean };
  attachment: { maxMb: number };
  dedupe: { threshold: number };
}

/**
 * `GET catalog/config` (`catalog.records.read`): what the catalog screens need of the settings without
 * `system.settings.read`: the barcode patterns and the symbology, the label profiles and the SRU servers by name only
 * (no URL), the currency, the duplicate threshold and the defaults.
 */
export interface CatalogConfigView {
  barcodePatterns: BarcodePattern[];
  symbology: BarcodeSymbology;
  labelProfiles: { id: string; name: string; kind: LabelKind }[];
  currency: string;
  dedupeThreshold: number;
  defaultMaterialTypeId: string | null;
  defaultCollectionTypeId: string | null;
  sruServers: { id: string; name: string; enabled: boolean }[];
  /** `catalog.isbn.arsyaEnabled`: reserved, ignored by the community edition. */
  arsyaEnabled: boolean;
}

// ---- Komunitas K1 (settings) ----------------------------------------------------------------------------------------
// The `accreditation` group: its value schemas, which the settings registry (packages/core/src/settings/registry.ts)
// reuses, its strict body and its view. Every key is of scope `data` and none is a secret. The repeat window of member
// visits (`visits.dedupeMinutes`, group `visits`) is registered too, but its group has no screen yet.

/**
 * A master code of a list setting (a collection type or a material type code): 1-16 printable ASCII characters,
 * trimmed, stored upper case so it compares as the masters' code keys do.
 */
export const accredCodeField = z.string().trim().min(1).max(16).regex(/^[\x20-\x7E]*$/).toUpperCase();

/** A list of master codes (at most 20). */
export const accredCodeListField = z.array(accredCodeField).max(20);

/** A call number or DDC prefix: 1-16 characters without a control character, trimmed. */
export const accredPrefixField = z.string().trim().min(1).max(16).regex(/^\P{Cc}*$/u);

/** `accreditation.schoolYearStartMonth`: the month a school year starts in, 1-12 (default July). */
export const schoolYearStartMonthField = z.int().min(1).max(12);

/** `accreditation.usedUnit`: collection use is counted per title or per copy. */
export const USED_UNITS = Object.freeze(['titles', 'items'] as const);

export type UsedUnit = (typeof USED_UNITS)[number];

/** A social media address of the website features: an http(s) URL of at most 500 characters. */
const socialUrlField = z
  .string()
  .max(500)
  .check((ctx) => {
    if (!isPlainHttpUrl(ctx.value)) ctx.issues.push({ code: 'invalid_format', format: 'url', input: ctx.value });
  });

/**
 * `accreditation.websiteFeatures`: which OPAC page shows each feature of the library website the website indicator
 * counts (profile, services, contact, online databases, FAQ), and up to five social media addresses.
 */
export const WebsiteFeatures = z.strictObject({
  profilePageId: ulidField.optional(),
  servicesPageId: ulidField.optional(),
  contactPageId: ulidField.optional(),
  databasesPageId: ulidField.optional(),
  faqPageId: ulidField.optional(),
  socialUrls: z.array(socialUrlField).max(5).optional(),
});

export type WebsiteFeatures = z.infer<typeof WebsiteFeatures>;

/** A calendar date `YYYY-MM-DD`, or null (`accreditation.liveFrom`: the day the library started working in ALTIS). */
export const calendarDateOrNull = z
  .string()
  .check((ctx) => {
    if (!isCalendarDate(ctx.value)) ctx.issues.push({ code: 'invalid_format', format: 'date', input: ctx.value });
  })
  .nullable();

/** `accreditation.evidence.maxMb` and `.componentLimitMb`: 1-100 MB. */
export const evidenceMbField = z.int().min(1).max(100);

/** `accreditation.k7.processedThresholdPct`: the share of fully processed copies a collection needs, 50-100 %. */
export const processedThresholdPctField = z.int().min(50).max(100);

/** `accreditation.undatedShareMaxPct`: above this share of copies without an acquisition date no suggestion is made. */
export const undatedShareMaxPctField = z.int().min(0).max(100);

/**
 * `accreditation.unknownMemberGroup.default`: the group of visits by members deleted in SLiMS; `'auto'` reads as
 * students in a school library and as none elsewhere; null counts them in no group.
 */
export const unknownMemberGroupField = z.enum([...ACCRED_GROUPS, 'auto']).nullable();

/** `visits.dedupeMinutes`: a member's check-in within this many minutes of an earlier one is a repeat; 0 turns it off. */
export const visitsDedupeMinutesField = z.int().min(0).max(720);

// ---- Komunitas K2 (members extended, visits, privacy) ----
/** `privacy.*.anonymizeAfterYears`: 1-20 years, or null (never). */
export const anonymizeYearsField = z.int().min(1).max(20).nullable();

/** `PUT settings/visits`: the repeat window, the visit sources, and the guestbook station's options. */
export const VisitsSettingsBody = z.strictObject({
  dedupeMinutes: visitsDedupeMinutesField.optional(),
  fromDesk: z.boolean().optional(),
  fromOnline: z.boolean().optional(),
  askPurpose: z.boolean().optional(),
  station: z
    .strictObject({
      showPhoto: z.boolean().optional(),
      welcome: z.strictObject({ id: textOrNull(300).optional(), en: textOrNull(300).optional() }).optional(),
    })
    .optional(),
});

export type VisitsSettingsBody = z.infer<typeof VisitsSettingsBody>;

/** `GET settings/visits`. */
export interface VisitsSettingsView {
  dedupeMinutes: number;
  fromDesk: boolean;
  fromOnline: boolean;
  askPurpose: boolean;
  station: { showPhoto: boolean; welcome: { id: string | null; en: string | null } };
}

/** `PUT settings/privacy` (needs a fresh password confirmation): the retention periods of personal data in history. */
export const PrivacySettingsBody = z.strictObject({
  loans: z.strictObject({ anonymizeAfterYears: anonymizeYearsField.optional() }).optional(),
  visits: z.strictObject({ anonymizeAfterYears: anonymizeYearsField.optional() }).optional(),
  members: z.strictObject({ anonymizeArchivedAfterYears: anonymizeYearsField.optional() }).optional(),
});

export type PrivacySettingsBody = z.infer<typeof PrivacySettingsBody>;

/** `GET settings/privacy`. */
export interface PrivacySettingsView {
  loans: { anonymizeAfterYears: number | null };
  visits: { anonymizeAfterYears: number | null };
  members: { anonymizeArchivedAfterYears: number | null };
}

/** `PUT settings/accreditation`: each key is its setting's name without `accreditation.`, nested at its dots. */
export const AccreditationSettingsBody = z.strictObject({
  schoolYearStartMonth: schoolYearStartMonthField.optional(),
  fiction: z
    .strictObject({
      collectionTypeCodes: accredCodeListField.optional(),
      callNumberPrefixes: z.array(accredPrefixField).max(20).optional(),
      ddcPrefixes: z.array(accredPrefixField).max(50).optional(),
    })
    .optional(),
  referenceCollectionTypeCodes: accredCodeListField.optional(),
  electronicMaterialTypeCodes: accredCodeListField.optional(),
  usedUnit: z.enum(USED_UNITS).optional(),
  websiteFeatures: WebsiteFeatures.optional(),
  liveFrom: calendarDateOrNull.optional(),
  evidence: z.strictObject({ maxMb: evidenceMbField.optional(), componentLimitMb: evidenceMbField.optional() }).optional(),
  textbookCollectionTypeCodes: accredCodeListField.optional(),
  k7: z.strictObject({ processedThresholdPct: processedThresholdPctField.optional() }).optional(),
  undatedShareMaxPct: undatedShareMaxPctField.optional(),
  visits: z.strictObject({ dedupeLegacy: z.boolean().optional() }).optional(),
  unknownMemberGroup: z.strictObject({ default: unknownMemberGroupField.optional() }).optional(),
});

export type AccreditationSettingsBody = z.infer<typeof AccreditationSettingsBody>;

/** `GET settings/accreditation`. */
export interface AccreditationSettingsView {
  /** The month a school year starts in, 1-12 (default 7). */
  schoolYearStartMonth: number;
  /** How a title counts as fiction: by collection type code, call number prefix or DDC prefix. */
  fiction: { collectionTypeCodes: string[]; callNumberPrefixes: string[]; ddcPrefixes: string[] };
  referenceCollectionTypeCodes: string[];
  electronicMaterialTypeCodes: string[];
  usedUnit: UsedUnit;
  websiteFeatures: WebsiteFeatures;
  liveFrom: string | null;
  evidence: { maxMb: number; componentLimitMb: number };
  /** Empty: every non-reference title counts as enrichment. */
  textbookCollectionTypeCodes: string[];
  k7: { processedThresholdPct: number };
  undatedShareMaxPct: number;
  visits: { dedupeLegacy: boolean };
  unknownMemberGroup: { default: (typeof ACCRED_GROUPS)[number] | 'auto' | null };
}

// ---- Komunitas (circulation core) ----------------------------------------------------------------------------------
// The group `circulation` (`GET|PUT settings/circulation`): how long a loan may still be voided and how a lost item is
// charged; in the group `members` (`GET|PUT settings/members`), the numbered clearance letters (their number prefix and
// the letter profile). Every key is of scope `data` and none is a secret.

/** `circulation.loanVoidMinutes`: how long after a loan the desk may still void it, 0-60 minutes (0: never). */
export const loanVoidMinutesField = z.int().min(0).max(60);

/** A sum in minor units, 0 or more (`circulation.lost.processingFeeMinor`). */
export const minorAmountField = z.int().min(0).max(Number.MAX_SAFE_INTEGER);

/** `members.clearance.prefix`: the start of a clearance letter number, 1-16 printable characters without `/`. */
export const clearancePrefixField = z.string().trim().min(1).max(16).regex(/^[\x21-\x2E\x30-\x7E]+$/);

/** The paper of a clearance letter: a sheet (A4, A5) or a receipt roll (58 or 80 mm). */
export const CLEARANCE_PROFILE_PAPERS = Object.freeze(['A4', 'A5', '58', '80'] as const);

/** A plain text of at most `max` characters, trimmed, newlines allowed. */
const plainText = (max: number) => z.string().trim().max(max);

/**
 * `members.clearance.profile`: the paper of a clearance letter, the place it is signed in, who signs it (title, name,
 * staff number), and the statement printed above the signature (plain text; empty: the built-in sentence).
 */
export const ClearanceProfile = z.strictObject({
  paper: z.enum(CLEARANCE_PROFILE_PAPERS),
  city: plainText(60),
  signerTitle: plainText(60),
  signerName: plainText(80),
  signerId: plainText(60),
  bodyText: plainText(1000),
});

export type ClearanceProfile = z.infer<typeof ClearanceProfile>;

/** `PUT settings/circulation`: each key is its setting's name without `circulation.`, nested at its dots. */
export const CirculationSettingsBody = z.strictObject({
  loanVoidMinutes: loanVoidMinutesField.optional(),
  lost: z.strictObject({ useItemPrice: z.boolean().optional(), processingFeeMinor: minorAmountField.optional() }).optional(),
});

export type CirculationSettingsBody = z.infer<typeof CirculationSettingsBody>;

/** `GET settings/circulation`. */
export interface CirculationSettingsView {
  loanVoidMinutes: number;
  lost: { useItemPrice: boolean; processingFeeMinor: number };
}

/** `PUT settings/members`: each key is its setting's name without `members.`, nested at its dots. */
export const MembersSettingsBody = z.strictObject({
  clearance: z.strictObject({ prefix: clearancePrefixField.optional(), profile: ClearanceProfile.optional() }).optional(),
  // ---- Komunitas K2 (members extended): the member card profile (`members.card.profile`) ----
  card: z.strictObject({ profile: CardProfile.optional() }).optional(),
});

export type MembersSettingsBody = z.infer<typeof MembersSettingsBody>;

/** `GET settings/members`. */
export interface MembersSettingsView {
  clearance: { prefix: string; profile: ClearanceProfile };
  card: { profile: CardProfile };
}
