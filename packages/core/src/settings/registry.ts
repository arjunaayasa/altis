import type { SettingsScope } from '@altis/db';
import { IP_TRUST_VALUES, isSemver } from '@altis/shared';
import { localeField, timezoneField, ulidField } from '@altis/shared/api/common';
import {
  BARCODE_SYMBOLOGIES,
  BarcodePatternList,
  LabelProfileList,
  SruServerList,
  attachmentMaxMbField,
  currencyField,
  dedupeThresholdField,
  marcOrgCodeField,
  oaiAdminEmailField,
  passwordResetBodyField,
} from '@altis/shared/api/settings';
import { z } from 'zod';

// The registry of settings (spec §6.5, §7.6; D26, D41): every key the `settings` table may hold, with the group
// the admin screens file it under, its scope, its Zod schema and its default. A row that is absent reads as the
// default, so the table holds only what an admin (or install) set.
//
// - `scope` classifies the row for backup and restore (SETTINGS_SCOPE_CLASS): `data` rows are backed up and restored,
//   `instance` rows belong to the install and are kept. `system.ip_trust` and, from 1c, the machine state below it
//   (clock anomaly, run records, probe and exposure results, data usage, the audit anchor, the events floor and the
//   realtime switch) are `instance`: all of them sit in group `system`, which no admin screen lists (SETTINGS_GROUPS
//   of @altis/shared/api/settings lists the groups an admin edits, never `system`), and none is a secret. 1d adds the
//   update state the same way (`update.*`, `system.keyset_full`).
// - A secret (`smtp.password`) is sealed with the keyring and never read back; `boundTo` names the settings it was
//   issued for, so it is cleared when one of them changes without a new secret in the same write (§7.6).
// - Maximum lengths equal the column or form widths the brief gives (L36); Zod counts code points, as VARCHAR does.
// - Phase 2 (its spec §12.6) adds six `opac` keys and the group `catalog`, all `data` and none a secret. The value
//   schemas of the catalog lists are @altis/shared/api/settings's (the admin form validates with the same ones); each
//   list's longest JSON text stays under the 60 000 bytes a MySQL TEXT column holds (settings.test.ts measures it).

export type SettingsGroup = 'library' | 'email' | 'security' | 'opac' | 'smtp' | 'system' | 'catalog';

/** Every registered key. The compiler checks {@link SETTINGS} against it both ways (no missing key, no extra one). */
export type SettingKey =
  | `library.${'name' | 'type' | 'address' | 'timezone' | 'locale'}`
  | 'email.sender_name'
  | `email.template.password_reset.${'id' | 'en'}.${'subject' | 'body'}`
  | `security.${'password_min_length' | 'session_idle_minutes'}`
  | `opac.welcome.${'id' | 'en'}`
  | 'opac.accent'
  | `smtp.${'host' | 'port' | 'security' | 'username' | 'password' | 'from'}`
  | 'system.ip_trust'
  | 'system.clock_anomaly'
  | 'system.clock_confirmed'
  | `system.run.${'worker' | 'cron_cli' | 'cron_http' | 'drive' | 'piggyback'}`
  | 'system.probe'
  | 'system.exposure'
  | 'system.data_usage'
  | 'audit.anchor'
  | 'audit.verified'
  | 'system.events_floor'
  | 'realtime.sse'
  | `update.${'channel' | 'check' | 'notified' | 'dashboard_check_at' | 'bundled_blocked'}`
  | 'system.keyset_full'
  // ---- Phase 2 (catalog): Task 2 ----
  | `opac.${'resultsPerPage' | 'indexable' | 'showShelfMap' | 'newTitlesCount'}`
  | `opac.oai.${'enabled' | 'adminEmail'}`
  | `catalog.${'marcOrgCode' | 'defaultMaterialTypeId' | 'defaultCollectionTypeId' | 'currency' | 'labelProfiles'}`
  | `catalog.barcode.${'patterns' | 'symbology'}`
  | `catalog.sru.${'servers' | 'allowPrivateHosts'}`
  | 'catalog.isbn.arsyaEnabled'
  | 'catalog.attachment.maxMb'
  | 'catalog.dedupe.threshold';

export interface SettingDef {
  group: SettingsGroup;
  scope: SettingsScope;
  /** True when the value is sealed with the keyring and the API only says whether it is set. */
  secret: boolean;
  /** What a value must satisfy (`null` included where the setting may be cleared). */
  schema: z.ZodType;
  /** What an absent row reads as. */
  default: unknown;
  /** For a secret: the settings it is tied to; a change to any of them clears it unless a new secret comes with it. */
  boundTo?: readonly SettingKey[];
}

type DefInput = Omit<SettingDef, 'scope' | 'secret'> & Partial<Pick<SettingDef, 'scope' | 'secret'>>;

/** A frozen definition; the scope is `data` and the value is not a secret unless it says otherwise. */
function def(input: DefInput): SettingDef {
  const { boundTo, ...rest } = input;
  return Object.freeze({
    scope: 'data' as const,
    secret: false,
    ...rest,
    ...(boundTo === undefined ? {} : { boundTo: Object.freeze([...boundTo]) }),
  });
}

/** A 1c/1d machine-state definition: group `system`, scope `instance`, not a secret. */
function instance(input: Pick<SettingDef, 'schema' | 'default'>): SettingDef {
  return def({ group: 'system', scope: 'instance', ...input });
}

/** A text of at most `max` characters, or null. Not trimmed: multi-line texts keep what was typed. */
const textOrNull = (max: number) => z.string().max(max).nullable();

/** A SHA-256 as 64 lower-case hex digits (what `digest('hex')` writes). */
const SHA256_HEX = z.string().regex(/^[0-9a-f]{64}$/);

/** An epoch-millisecond count or another whole number; the checks that matter (a window, an order) are the readers'. */
const int = z.int();

const HOSTNAME = z.hostname();
const IPV6 = z.ipv6();

/** A release version: SemVer 2.0.0 (no leading `v`), at most 64 characters. */
const SEMVER = z
  .string()
  .max(64)
  .refine((s) => isSemver(s));

/** A calendar day as `YYYY-MM-DD` (a release's `releasedAt`). */
const DAY = z.string().regex(/^\d{4}-(?:0[1-9]|1[0-2])-(?:0[1-9]|[12]\d|3[01])$/);

/** A short non-empty text of the feed (a version floor such as `minNode`, a precheck failure name). */
const word = (max: number) => z.string().min(1).max(max);

/**
 * One entry of the signed update feed (§9.6; `FeedEntry` of `@altis/crypto/feed`, which the feed parser reduces to
 * exactly these fields, unknown ones dropped), as the last check stored it. `bootProtocol` is any positive whole
 * number here: the precheck, not the stored check, refuses one other than 1.
 */
const FEED_ENTRY = z.strictObject({
  version: SEMVER,
  channel: z.enum(['stable', 'beta']),
  releasedAt: DAY,
  bootProtocol: int.min(1),
  minUpgradeFrom: word(64),
  minCodeVersionAfter: word(64),
  minNode: word(64),
  minDb: z.strictObject({ mysql: word(64), mariadb: word(64), postgres: word(64) }),
  size: int.min(0),
  sha256: SHA256_HEX,
  url: word(2048),
  notesUrl: word(2048).nullable(),
});

/** A host name (an IPv4 address reads as one) or an IPv6 address, at most 191 characters, or null. */
const hostOrNull = z
  .string()
  .max(191)
  .check((ctx) => {
    // One issue code for both forms: a z.union of the two would report `invalid_union`, which no form message maps.
    if (!HOSTNAME.safeParse(ctx.value).success && !IPV6.safeParse(ctx.value).success) {
      ctx.issues.push({ code: 'invalid_format', format: 'hostname', input: ctx.value });
    }
  })
  .nullable();

// ---- Phase 2 (catalog): Task 2 ----
/** `value` frozen to its leaves: a default is shared by every reader of the process (readSettings hands it out). */
function deepFreeze<T>(value: T): T {
  if (value !== null && typeof value === 'object') {
    for (const inner of Object.values(value)) deepFreeze(inner);
    Object.freeze(value);
  }
  return value;
}

/**
 * The default of a list setting, parsed by its own schema first: it is then in the form a write stores (barcode
 * affixes upper case, keys in schema order), so writing it back over an absent row changes nothing.
 */
function seed<T>(schema: z.ZodType<T>, value: unknown): T {
  return deepFreeze(schema.parse(value));
}

/** The keys, in the order the admin screens list them (groupKeys and the changed-keys result follow it). */
export const SETTINGS: Readonly<Record<SettingKey, SettingDef>> = Object.freeze({
  'library.name': def({
    group: 'library',
    schema: z.string().trim().min(1).max(191),
    default: 'Perpustakaan',
  }),
  'library.type': def({
    group: 'library',
    schema: z.enum(['sekolah', 'perguruan_tinggi', 'umum', 'khusus']).nullable(),
    default: null,
  }),
  'library.address': def({ group: 'library', schema: textOrNull(1000), default: null }),
  'library.timezone': def({ group: 'library', schema: timezoneField, default: 'Asia/Jakarta' }),
  'library.locale': def({ group: 'library', schema: localeField, default: 'id' }),

  'email.sender_name': def({ group: 'email', schema: textOrNull(100), default: null }),
  // null = the catalog text of @altis/shared (packages/shared/src/i18n). A body of the library's own must keep
  // `{link}` (missing_link otherwise): without it every reset mail goes out without its link.
  'email.template.password_reset.id.subject': def({ group: 'email', schema: textOrNull(200), default: null }),
  'email.template.password_reset.id.body': def({ group: 'email', schema: passwordResetBodyField, default: null }),
  'email.template.password_reset.en.subject': def({ group: 'email', schema: textOrNull(200), default: null }),
  'email.template.password_reset.en.body': def({ group: 'email', schema: passwordResetBodyField, default: null }),

  'security.password_min_length': def({ group: 'security', schema: z.int().min(10).max(64), default: 10 }),
  'security.session_idle_minutes': def({ group: 'security', schema: z.int().min(5).max(240), default: 30 }),

  'opac.welcome.id': def({ group: 'opac', schema: textOrNull(1000), default: null }),
  'opac.welcome.en': def({ group: 'opac', schema: textOrNull(1000), default: null }),
  'opac.accent': def({
    group: 'opac',
    schema: z.enum(['teal', 'blue', 'green', 'purple', 'red', 'slate']),
    default: 'teal',
  }),

  'smtp.host': def({ group: 'smtp', schema: hostOrNull, default: null }),
  'smtp.port': def({ group: 'smtp', schema: z.int().min(1).max(65535), default: 587 }),
  'smtp.security': def({ group: 'smtp', schema: z.enum(['none', 'starttls', 'tls']), default: 'starttls' }),
  'smtp.username': def({ group: 'smtp', schema: textOrNull(191), default: null }),
  // Never trimmed or normalized: it is handed to the SMTP server exactly as typed.
  'smtp.password': def({
    group: 'smtp',
    secret: true,
    schema: z.string().min(1).max(512).nullable(),
    default: null,
    boundTo: ['smtp.host', 'smtp.port', 'smtp.username'],
  }),
  'smtp.from': def({ group: 'smtp', schema: z.email().max(191).nullable(), default: null }),

  'system.ip_trust': def({ group: 'system', scope: 'instance', schema: z.enum(IP_TRUST_VALUES), default: 'ok' }),

  // ---- 1c: the machine state of this installation. Every key is `instance` (a restore keeps it), JSON text, not a
  // secret; an absent row reads as the default. Objects are strict: a reader sees the keys below and nothing else.
  // Raised when the clock looks wrong (§10.4); only an admin's confirmation or a signed time clears it.
  'system.clock_anomaly': instance({
    schema: z.strictObject({ detectedAt: int, maxSeen: int }).nullable(),
    default: null,
  }),
  // The confirmation the detector measures from: it ignores timestamps from before `at`.
  'system.clock_confirmed': instance({ schema: z.strictObject({ at: int, auditSeq: int }).nullable(), default: null }),
  // The epoch ms of the last successful run of each mode. One key per mode, so concurrent writers never lose each
  // other's update (M20).
  'system.run.worker': instance({ schema: int.nullable(), default: null }),
  'system.run.cron_cli': instance({ schema: int.nullable(), default: null }),
  'system.run.cron_http': instance({ schema: int.nullable(), default: null }),
  'system.run.drive': instance({ schema: int.nullable(), default: null }),
  'system.run.piggyback': instance({ schema: int.nullable(), default: null }),
  // The browser test of Diagnostik (§11): polling and SSE through this host's proxy, which methods a WAF lets
  // through, the largest chunk that passed, and what the X-Forwarded-For chain looks like.
  'system.probe': instance({
    schema: z
      .strictObject({
        at: int,
        polling: z.boolean(),
        sse: z.boolean(),
        methods: z.strictObject({ put: z.boolean(), patch: z.boolean(), delete: z.boolean() }),
        chunkBytes: int.nullable(),
        xff: z.strictObject({ spoofable: z.boolean(), suggestedHops: int.nullable() }),
      })
      .nullable(),
    default: null,
  }),
  // The last exposure check (data or app folder reachable through the web); `url` is the one that answered.
  'system.exposure': instance({
    schema: z.strictObject({ at: int, ok: z.boolean(), url: z.string().max(191).nullable() }).nullable(),
    default: null,
  }),
  // What DATA_DIR holds, from the last scan; `truncated` when the scan stopped at its budget.
  'system.data_usage': instance({
    schema: z.strictObject({ at: int, bytes: int, files: int, truncated: z.boolean() }).nullable(),
    default: null,
  }),
  // The audit chain's anchor after a retention purge (§7.8): the last deleted entry's seq and hash.
  'audit.anchor': instance({
    schema: z.strictObject({ seq: int.min(0), hash: SHA256_HEX }).nullable(),
    default: null,
  }),
  // The last chain verification. `headHash` lets the next run continue from `{seq: head, hash: headHash}` (M5).
  'audit.verified': instance({
    schema: z
      .strictObject({ at: int, ok: z.boolean(), head: int, headHash: SHA256_HEX, brokenAt: int.nullable() })
      .nullable(),
    default: null,
  }),
  // The highest `seq` purgeEvents deleted (M15, decision C43): a cursor below it is older than retention.
  'system.events_floor': instance({ schema: int.min(0), default: 0 }),
  // null = automatic: on, except on `passenger`/`litespeed` (decision C6).
  'realtime.sse': instance({ schema: z.boolean().nullable(), default: null }),

  // ---- 1d: updates. Same rules as 1c: `instance` (a restore keeps them), JSON text, not secret, strict objects.
  // The update channel the feed is read from (§9.6).
  'update.channel': instance({ schema: z.enum(['stable', 'beta']), default: 'stable' }),
  // The last update check (Task 28): when, whether it worked (else `error` holds the code, a 5xx reason included, which
  // never reaches a client otherwise: preflight M6), the feed's `seq`, the entry to install, the latest entry's version
  // and whether the entry is a stepping stone below it. Review C07: the feed's freshness expiry (§9.6); 1d review L14:
  // the channel it read. Both are absent in a check stored before they were recorded.
  'update.check': instance({
    schema: z
      .strictObject({
        at: int,
        channel: z.enum(['stable', 'beta']).optional(),
        ok: z.boolean(),
        error: z.string().max(64).nullable(),
        seq: int.nullable(),
        available: FEED_ENTRY.nullable(),
        latest: SEMVER.nullable(),
        steppingStone: z.boolean(),
        expiresAt: int.nullable().optional(),
      })
      .nullable(),
    default: null,
  }),
  // The last version an `update_available` notification went out for: one per version (D1d-30).
  'update.notified': instance({ schema: SEMVER.nullable(), default: null }),
  // When opening the dashboard last enqueued a check: at most once an hour (§9.6 step 1).
  'update.dashboard_check_at': instance({ schema: int.nullable(), default: null }),
  // A newer bundled release whose prechecks failed (§9.8 row 2, Task 27): which, when, and the failures.
  'update.bundled_blocked': instance({
    schema: z.strictObject({ version: SEMVER, at: int, failures: z.array(word(64)).max(8) }).nullable(),
    default: null,
  }),
  // The keyset writer refused documents because DATA_DIR/releases/keyset.json is full (R65c): the Diagnostik alert.
  'system.keyset_full': instance({ schema: z.strictObject({ at: int, refused: int.min(0) }).nullable(), default: null }),

  // ---- Phase 2 (catalog): Task 2 ----
  // The OPAC (Phase 2 spec §9, §10): results per page, indexing, OAI-PMH (on only with an admin e-mail), the shelf map
  // and the new titles of the home page.
  'opac.resultsPerPage': def({ group: 'opac', schema: z.int().min(10).max(50), default: 20 }),
  'opac.indexable': def({ group: 'opac', schema: z.boolean(), default: true }),
  'opac.oai.enabled': def({ group: 'opac', schema: z.boolean(), default: true }),
  'opac.oai.adminEmail': def({ group: 'opac', schema: oaiAdminEmailField, default: '' }),
  'opac.showShelfMap': def({ group: 'opac', schema: z.boolean(), default: true }),
  'opac.newTitlesCount': def({ group: 'opac', schema: z.int().min(0).max(48), default: 12 }),
  // The catalog (§12.6). marcOrgCode null: an export omits 003 and the 040 $a (P2-32). The default material and
  // collection types are ids of masters (not checked here: a reader falls back when one is gone).
  'catalog.marcOrgCode': def({ group: 'catalog', schema: marcOrgCodeField, default: null }),
  'catalog.defaultMaterialTypeId': def({ group: 'catalog', schema: ulidField.nullable(), default: null }),
  'catalog.defaultCollectionTypeId': def({ group: 'catalog', schema: ulidField.nullable(), default: null }),
  'catalog.currency': def({ group: 'catalog', schema: currencyField, default: 'IDR' }),
  'catalog.barcode.patterns': def({
    group: 'catalog',
    schema: BarcodePatternList,
    default: seed(BarcodePatternList, [{ id: 'default', name: 'Bawaan', prefix: 'B', digits: 7, suffix: '' }]),
  }),
  'catalog.barcode.symbology': def({ group: 'catalog', schema: z.enum(BARCODE_SYMBOLOGIES), default: 'code128' }),
  // Three A4 sheets (§7), each grid fitting the page inside margins of at least 5 mm.
  'catalog.labelProfiles': def({
    group: 'catalog',
    schema: LabelProfileList,
    default: seed(LabelProfileList, [
      // 10 + 3 × 60 + 2 × 5 + 10 = 210 wide; 14 + 10 × 26 + 9 × 1 + 14 = 297 high.
      {
        id: 'spine-a4',
        name: 'Label punggung A4 (3 × 10)',
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
      },
      // 6 + 3 × 64 + 2 × 3 + 6 = 210 wide; 10 + 8 × 32 + 7 × 3 + 10 = 297 high.
      {
        id: 'barcode-a4',
        name: 'Label barkod A4 (3 × 8)',
        kind: 'barcode',
        page: 'A4',
        marginMm: { t: 10, r: 6, b: 10, l: 6 },
        cols: 3,
        rows: 8,
        labelWMm: 64,
        labelHMm: 32,
        gapXMm: 3,
        gapYMm: 3,
        fontPt: 8,
        header: '',
        showLibraryName: true,
        symbology: null,
        titleMaxChars: 30,
        border: false,
      },
      // 7.5 + 2 × 95 + 1 × 5 + 7.5 = 210 wide; 7 + 7 × 37 + 6 × 4 + 7 = 297 high.
      {
        id: 'spine-barcode-a4',
        name: 'Label punggung dan barkod A4 (2 × 7)',
        kind: 'spine_barcode',
        page: 'A4',
        marginMm: { t: 7, r: 7.5, b: 7, l: 7.5 },
        cols: 2,
        rows: 7,
        labelWMm: 95,
        labelHMm: 37,
        gapXMm: 5,
        gapYMm: 4,
        fontPt: 8,
        header: '',
        showLibraryName: true,
        symbology: null,
        titleMaxChars: 40,
        border: true,
      },
    ]),
  }),
  // Both seeds stay disabled until the owner has verified them (P5); Perpusnas has no URL until then (P2-33).
  'catalog.sru.servers': def({
    group: 'catalog',
    schema: SruServerList,
    default: seed(SruServerList, [
      {
        id: 'perpusnas',
        name: 'Perpustakaan Nasional RI',
        url: '',
        version: '1.2',
        recordSchema: 'marcxml',
        indexes: { isbn: 'bath.isbn', title: 'dc.title', author: 'dc.creator', any: 'cql.serverChoice' },
        enabled: false,
      },
      {
        id: 'loc',
        name: 'Library of Congress',
        url: 'http://lx2.loc.gov:210/LCDB',
        version: '1.1',
        recordSchema: 'marcxml',
        indexes: { isbn: 'bath.isbn', title: 'dc.title', author: 'dc.creator', any: 'cql.serverChoice' },
        enabled: false,
      },
    ]),
  }),
  // Super admin only (M11): settings.catalog.put refuses anyone else's change of it.
  'catalog.sru.allowPrivateHosts': def({ group: 'catalog', schema: z.boolean(), default: false }),
  // Reserved: accepted and ignored by the community edition (kept for settings and API compatibility, ruling R23).
  'catalog.isbn.arsyaEnabled': def({ group: 'catalog', schema: z.boolean(), default: false }),
  'catalog.attachment.maxMb': def({ group: 'catalog', schema: attachmentMaxMbField, default: 200 }),
  'catalog.dedupe.threshold': def({ group: 'catalog', schema: dedupeThresholdField, default: 80 }),
});

/** The registered keys in registry order. */
const KEYS = Object.freeze(Object.keys(SETTINGS) as SettingKey[]);

/** True for a registered key (an own key of {@link SETTINGS}; `constructor` and `__proto__` are not). */
export function isSettingKey(key: unknown): key is SettingKey {
  return typeof key === 'string' && Object.hasOwn(SETTINGS, key);
}

/** The keys of `group`, in registry order. */
export function groupKeys(group: SettingsGroup): SettingKey[] {
  return KEYS.filter((key) => SETTINGS[key].group === group);
}

/** Every registered key, in registry order. */
export function allSettingKeys(): SettingKey[] {
  return [...KEYS];
}
