import { claimSettingsFiles, groupKeys, readSettings, writeSettings, type SettingKey, type TxCtx } from '@altis/core';
import { DomainError, isDomainError } from '@altis/shared';
import {
  AccreditationSettingsBody,
  CatalogSettingsBody,
  CirculationSettingsBody,
  EmailSettingsBody,
  LibrarySettingsBody,
  MembersSettingsBody,
  OpacSettingsBody,
  PrivacySettingsBody,
  SETTINGS_GROUPS,
  VisitsSettingsBody,
  SecuritySettingsBody,
  type BarcodePattern,
  type CardProfileForSettings as CardProfile,
  type BarcodeSymbology,
  type CatalogConfigView,
  type LabelProfile,
  type SettingsGroupName,
  type SettingsPutResponse,
  type SettingsView,
  type SruServer,
} from '@altis/shared/api/settings';
import { z } from 'zod';
import { route, type RouteContext, type RouteDecl } from '../http/route.js';
import { SYSTEM_CONFIG_ROUTES } from './system-config.js';

// The settings routes of Task 22 (route catalog; spec §6.5, §13.3; decisions D26, D41, M17), and with them the
// system configuration routes of ./system-config.ts: SETTINGS_ROUTES is the one entry of ALL_ROUTES for both.
//
// - `settings.get` (GET settings/:group) answers one of the groups an admin edits (library, email, security, opac and,
//   from Phase 2, catalog) with every key filled: the stored value, else the registry's default. Any other group,
//   `smtp` and `system` included (SMTP is part of the system configuration, `system.ip_trust` belongs to 1c's
//   Diagnostik), is 404.
// - One PUT per group (`settings.<group>.put`, S15), each with its own strict body (@altis/shared/api/settings) whose
//   keys are the settings' names without the group prefix. The handler transaction writes them with writeSettings,
//   audits `settings.update` with `meta {group, keys}` (the changed keys, never a value) and, after its COMMIT,
//   invalidates the settings cache so that this process uses the new values at once (M17; other processes within the
//   cache's 30 s). `PUT settings/security` needs a reauth (§7.3). They answer the changed keys, a small body whatever
//   the texts hold (an idempotency `store` response is at most 60 000 bytes).
// - Phase 2 (Task 2): `PUT settings/catalog` (`settings.catalog.put`), whose `sru.allowPrivateHosts` only a super admin
//   may change (M11), and `GET catalog/config` (`catalog.config`, `catalog.records.read`) for the catalog
//   screens, which need some of the catalogue settings without `system.settings.read`.
// - Reports and accreditation: `PUT settings/accreditation` (`settings.accreditation.put`) for the sixteen settings of
//   the accreditation group; `GET settings/accreditation` is the same settings.get.

const SETTINGS_PATH = '/api/v1/settings';

/** Where each setting of a group sits in its body and its view: the path of property names, and the setting. */
type FieldMap = readonly (readonly [path: readonly string[], key: SettingKey])[];

const FIELDS: Readonly<Record<SettingsGroupName, FieldMap>> = Object.freeze({
  library: [
    [['name'], 'library.name'],
    [['type'], 'library.type'],
    [['address'], 'library.address'],
    [['timezone'], 'library.timezone'],
    [['locale'], 'library.locale'],
  ],
  email: [
    [['senderName'], 'email.sender_name'],
    [['templates', 'passwordReset', 'id', 'subject'], 'email.template.password_reset.id.subject'],
    [['templates', 'passwordReset', 'id', 'body'], 'email.template.password_reset.id.body'],
    [['templates', 'passwordReset', 'en', 'subject'], 'email.template.password_reset.en.subject'],
    [['templates', 'passwordReset', 'en', 'body'], 'email.template.password_reset.en.body'],
  ],
  security: [
    [['passwordMinLength'], 'security.password_min_length'],
    [['sessionIdleMinutes'], 'security.session_idle_minutes'],
  ],
  opac: [
    [['welcome', 'id'], 'opac.welcome.id'],
    [['welcome', 'en'], 'opac.welcome.en'],
    [['accent'], 'opac.accent'],
    // ---- Phase 2 (catalog): Task 2 ----
    [['resultsPerPage'], 'opac.resultsPerPage'],
    [['indexable'], 'opac.indexable'],
    [['oai', 'enabled'], 'opac.oai.enabled'],
    [['oai', 'adminEmail'], 'opac.oai.adminEmail'],
    [['showShelfMap'], 'opac.showShelfMap'],
    [['newTitlesCount'], 'opac.newTitlesCount'],
  ],
  // ---- Phase 2 (catalog): Task 2 ----
  catalog: [
    [['marcOrgCode'], 'catalog.marcOrgCode'],
    [['defaultMaterialTypeId'], 'catalog.defaultMaterialTypeId'],
    [['defaultCollectionTypeId'], 'catalog.defaultCollectionTypeId'],
    [['currency'], 'catalog.currency'],
    [['barcode', 'patterns'], 'catalog.barcode.patterns'],
    [['barcode', 'symbology'], 'catalog.barcode.symbology'],
    [['labelProfiles'], 'catalog.labelProfiles'],
    [['sru', 'servers'], 'catalog.sru.servers'],
    [['sru', 'allowPrivateHosts'], 'catalog.sru.allowPrivateHosts'],
    [['isbn', 'arsyaEnabled'], 'catalog.isbn.arsyaEnabled'],
    [['attachment', 'maxMb'], 'catalog.attachment.maxMb'],
    [['dedupe', 'threshold'], 'catalog.dedupe.threshold'],
  ],
  // ---- Komunitas K1 (settings) ----
  accreditation: [
    [['schoolYearStartMonth'], 'accreditation.schoolYearStartMonth'],
    [['fiction', 'collectionTypeCodes'], 'accreditation.fiction.collectionTypeCodes'],
    [['fiction', 'callNumberPrefixes'], 'accreditation.fiction.callNumberPrefixes'],
    [['fiction', 'ddcPrefixes'], 'accreditation.fiction.ddcPrefixes'],
    [['referenceCollectionTypeCodes'], 'accreditation.referenceCollectionTypeCodes'],
    [['electronicMaterialTypeCodes'], 'accreditation.electronicMaterialTypeCodes'],
    [['usedUnit'], 'accreditation.usedUnit'],
    [['websiteFeatures'], 'accreditation.websiteFeatures'],
    [['liveFrom'], 'accreditation.liveFrom'],
    [['evidence', 'maxMb'], 'accreditation.evidence.maxMb'],
    [['evidence', 'componentLimitMb'], 'accreditation.evidence.componentLimitMb'],
    [['textbookCollectionTypeCodes'], 'accreditation.textbookCollectionTypeCodes'],
    [['k7', 'processedThresholdPct'], 'accreditation.k7.processedThresholdPct'],
    [['undatedShareMaxPct'], 'accreditation.undatedShareMaxPct'],
    [['visits', 'dedupeLegacy'], 'accreditation.visits.dedupeLegacy'],
    [['unknownMemberGroup', 'default'], 'accreditation.unknownMemberGroup.default'],
  ],
  // ---- Komunitas (circulation core) ----
  circulation: [
    // ---- Komunitas (holds) ----
    [['holds', 'enabled'], 'circulation.holds.enabled'],
    [['holds', 'opac'], 'circulation.holds.opac'],
    [['holds', 'onlyWhenNoneAvailable'], 'circulation.holds.onlyWhenNoneAvailable'],
    [['holds', 'pickupDays'], 'circulation.holds.pickupDays'],
    [['loanVoidMinutes'], 'circulation.loanVoidMinutes'],
    [['lost', 'useItemPrice'], 'circulation.lost.useItemPrice'],
    [['lost', 'processingFeeMinor'], 'circulation.lost.processingFeeMinor'],
    // ---- Komunitas (member area) ----
    [['renew', 'opac'], 'circulation.renew.opac'],
  ],
  members: [
    [['clearance', 'prefix'], 'members.clearance.prefix'],
    [['clearance', 'profile'], 'members.clearance.profile'],
    // ---- Komunitas K2 (members extended) ----
    [['card', 'profile'], 'members.card.profile'],
    // ---- Komunitas (member area) ----
    [['password', 'minLength'], 'members.password.minLength'],
    [['opac', 'enabled'], 'members.opac.enabled'],
    [['session', 'idleMinutes'], 'members.session.idleMinutes'],
    [['session', 'absoluteHours'], 'members.session.absoluteHours'],
  ],
  // ---- Komunitas K2 (members extended, visits, privacy) ----
  visits: [
    [['dedupeMinutes'], 'visits.dedupeMinutes'],
    [['fromDesk'], 'visits.fromDesk'],
    [['fromOnline'], 'visits.fromOnline'],
    [['askPurpose'], 'visits.askPurpose'],
    [['station', 'showPhoto'], 'visits.station.showPhoto'],
    [['station', 'welcome', 'id'], 'visits.station.welcome.id'],
    [['station', 'welcome', 'en'], 'visits.station.welcome.en'],
  ],
  privacy: [
    [['loans', 'anonymizeAfterYears'], 'privacy.loans.anonymizeAfterYears'],
    [['visits', 'anonymizeAfterYears'], 'privacy.visits.anonymizeAfterYears'],
    [['members', 'anonymizeArchivedAfterYears'], 'privacy.members.anonymizeArchivedAfterYears'],
  ],
});

// Every registered key of a group has its place, and nothing else: checked once, when the module loads.
for (const group of SETTINGS_GROUPS) {
  const mapped = FIELDS[group].map(([, key]) => key);
  if (JSON.stringify(mapped) !== JSON.stringify(groupKeys(group))) {
    throw new Error(`settings API: the fields of group ${group} do not match the settings registry`);
  }
}

/** The value at `path` of a body (undefined when a part of it is absent). */
function valueAt(body: unknown, path: readonly string[]): unknown {
  let at: unknown = body;
  for (const name of path) {
    if (at === null || typeof at !== 'object') return undefined;
    at = (at as Record<string, unknown>)[name];
  }
  return at;
}

/** The writeSettings patch of a body: the keys it holds (undefined keeps a value). */
function patchOf(body: unknown, fields: FieldMap): Partial<Record<SettingKey, unknown>> {
  const patch: Partial<Record<SettingKey, unknown>> = {};
  for (const [path, key] of fields) {
    const value = valueAt(body, path);
    if (value !== undefined) patch[key] = value;
  }
  return patch;
}

/** The view of a group from the values of its settings: every path filled. */
function viewOf(values: Partial<Record<SettingKey, unknown>>, fields: FieldMap): Record<string, unknown> {
  const view: Record<string, unknown> = {};
  for (const [path, key] of fields) {
    let at = view;
    for (const name of path.slice(0, -1)) at = (at[name] ??= {}) as Record<string, unknown>;
    at[path.at(-1)!] = values[key];
  }
  return view;
}

/**
 * writeSettings's VALIDATION_FAILED with the body's paths instead of the settings' names (the body schemas hold the
 * registry's limits, so this only shows when the two disagree).
 */
function inBodyTerms(error: unknown, fields: FieldMap): unknown {
  if (!isDomainError(error) || error.code !== 'VALIDATION_FAILED' || !Array.isArray(error.meta?.['errors'])) return error;
  const pathOf = new Map<string, string>(fields.map(([path, key]) => [key, path.join('.')]));
  const errors = (error.meta['errors'] as { path?: unknown; code?: unknown }[]).map((e) => ({
    path: typeof e.path === 'string' ? (pathOf.get(e.path) ?? e.path) : '',
    code: typeof e.code === 'string' ? e.code : 'invalid',
  }));
  return new DomainError('VALIDATION_FAILED', { ...(error.detail === undefined ? {} : { detail: error.detail }), meta: { errors } });
}

const GroupParams = z.strictObject({ group: z.string().max(64) });

function isGroup(group: string): group is SettingsGroupName {
  return (SETTINGS_GROUPS as readonly string[]).includes(group);
}

/** GET settings/:group. */
const settingsGet = route({
  id: 'settings.get',
  method: 'GET',
  path: `${SETTINGS_PATH}/:group`,
  permission: 'system.settings.read',
  idempotency: 'none',
  audit: null,
  params: GroupParams,
  handler: async (rc) => {
    const group = rc.params.group;
    if (!isGroup(group)) throw new DomainError('NOT_FOUND');
    const fields = FIELDS[group];
    // Read afresh, not through the settings cache: the screen shows what is stored now.
    const values = await readSettings(rc.db.db, fields.map(([, key]) => key), rc.config.keyring);
    const body = viewOf(values, fields) as unknown as SettingsView[typeof group];
    return { body };
  },
});

/** The settings whose stored value only a super admin may change (Phase 2, M11). */
type SuperAdminOnly = readonly SettingKey[];

/**
 * Whether `patch` changes one of `guarded` from what is stored (read through `db`, outside any transaction).
 * Values are compared as JSON texts, as writeSettings does.
 */
async function changesAny(rc: RouteContext<unknown, unknown, unknown>, patch: Partial<Record<SettingKey, unknown>>, guarded: SuperAdminOnly): Promise<boolean> {
  const sent = guarded.filter((key) => patch[key] !== undefined);
  if (sent.length === 0) return false;
  const stored = await readSettings(rc.db.db, sent, rc.config.keyring);
  return sent.some((key) => JSON.stringify(stored[key]) !== JSON.stringify(patch[key]));
}

/**
 * The PUT of one group: `settings.<group>.put`. With `superAdminOnly` (Phase 2, M11), a caller who is not a super
 * admin and whose body changes one of those settings is refused in `prepare` with 403 AUTHZ_DENIED (counted and audited
 * as step 9's refusals are, naming the route's own permission); sending the stored value back is allowed. The
 * handler never writes those keys for such a caller, so a super admin's change committed between `prepare` and the
 * handler is never undone by it.
 */
function settingsPut<B>(
  group: SettingsGroupName,
  body: z.ZodType<B>,
  o: { reauth?: true; superAdminOnly?: SuperAdminOnly; afterWrite?: (tx: TxCtx, patch: Partial<Record<SettingKey, unknown>>) => Promise<void> } = {},
): RouteDecl {
  const fields = FIELDS[group];
  const guarded = o.superAdminOnly ?? [];
  return route({
    id: `settings.${group}.put`,
    method: 'PUT',
    path: `${SETTINGS_PATH}/${group}`,
    permission: 'system.settings.manage',
    ...(o.reauth === undefined ? {} : { reauth: true }),
    idempotency: 'store',
    audit: 'settings.update',
    body,
    ...(guarded.length === 0
      ? {}
      : {
          prepare: async (rc: RouteContext<B, unknown, unknown>) => {
            const auth = rc.auth!; // a permission route: step 9 found a session
            if (!auth.grants.superAdmin && (await changesAny(rc, patchOf(rc.body, fields), guarded))) {
              throw await rc.authzDenied('system.settings.manage');
            }
          },
        }),
    handler: async (rc) => {
      const tx = rc.tx();
      const patch = patchOf(rc.body, fields);
      if (!rc.auth!.grants.superAdmin) for (const key of guarded) delete patch[key];
      let keys: SettingKey[];
      try {
        keys = await writeSettings(tx.trx, patch, {
          keyring: rc.config.keyring,
          now: rc.now,
          actorId: rc.auth!.subjectId, // a permission route: step 9 found a session
        });
      } catch (error) {
        throw inBodyTerms(error, fields);
      }
      if (o.afterWrite !== undefined) await o.afterWrite(tx, patch);
      await tx.audit({ action: 'settings.update', entity: 'settings', entityId: null, meta: { group, keys } });
      rc.afterCommit(() => rc.services.settings.invalidate());
      const response: SettingsPutResponse = { changed: keys };
      return { body: response };
    },
  });
}

// ---- Phase 2 (catalog): Task 2 ----

/** The settings `GET catalog/config` reads. */
const CATALOG_CONFIG_KEYS = [
  'catalog.barcode.patterns',
  'catalog.barcode.symbology',
  'catalog.labelProfiles',
  'catalog.currency',
  'catalog.dedupe.threshold',
  'catalog.defaultMaterialTypeId',
  'catalog.defaultCollectionTypeId',
  'catalog.sru.servers',
  'catalog.isbn.arsyaEnabled',
] as const satisfies readonly SettingKey[];

/**
 * GET catalog/config: what the catalog screens need of the settings, for a holder of
 * `catalog.records.read` without `system.settings.read`. Profiles and SRU servers by id and name only: no SRU URL and
 * no `allowPrivateHosts` reach a reader. Read afresh, as `GET settings/:group` is.
 */
const catalogConfig = route({
  id: 'catalog.config',
  method: 'GET',
  path: '/api/v1/catalog/config',
  permission: 'catalog.records.read',
  idempotency: 'none',
  audit: null,
  handler: async (rc) => {
    const s = await readSettings(rc.db.db, CATALOG_CONFIG_KEYS, rc.config.keyring);
    const profiles = s['catalog.labelProfiles'] as LabelProfile[];
    const servers = s['catalog.sru.servers'] as SruServer[];
    const body: CatalogConfigView = {
      barcodePatterns: s['catalog.barcode.patterns'] as BarcodePattern[],
      symbology: s['catalog.barcode.symbology'] as BarcodeSymbology,
      labelProfiles: profiles.map((p) => ({ id: p.id, name: p.name, kind: p.kind })),
      currency: s['catalog.currency'] as string,
      dedupeThreshold: s['catalog.dedupe.threshold'] as number,
      defaultMaterialTypeId: s['catalog.defaultMaterialTypeId'] as string | null,
      defaultCollectionTypeId: s['catalog.defaultCollectionTypeId'] as string | null,
      sruServers: servers.map((server) => ({ id: server.id, name: server.name, enabled: server.enabled })),
      arsyaEnabled: s['catalog.isbn.arsyaEnabled'] as boolean,
    };
    return { body };
  },
});

// ---- Komunitas K2 (members extended) ----
/**
 * Claims the card pictures (logo, signature, stamp) the saved card profile names, as files of the setting; the ones it
 * no longer names lose their owner and are swept as orphan uploads a day later.
 */
async function claimCardAssets(tx: TxCtx, patch: Partial<Record<SettingKey, unknown>>): Promise<void> {
  const profile = patch['members.card.profile'] as CardProfile | undefined;
  if (profile === undefined) return;
  const ids = [profile.logoFileId, profile.back.signatureFileId, profile.back.stampFileId].filter((id): id is string => id !== null);
  await claimSettingsFiles(tx.trx, 'members.card.profile', 'members.card_asset', ids);
}

/** The settings routes, then the system configuration's (route catalog order). */
export const SETTINGS_ROUTES: RouteDecl[] = [
  settingsGet,
  settingsPut('security', SecuritySettingsBody, { reauth: true }),
  settingsPut('library', LibrarySettingsBody),
  settingsPut('email', EmailSettingsBody),
  settingsPut('opac', OpacSettingsBody),
  // ---- Phase 2 (catalog): Task 2 ----
  // M11: only a super admin may let the SRU client reach private addresses (an `admin` could otherwise turn
  // `sru/test` into a probe of the internal network).
  settingsPut('catalog', CatalogSettingsBody, { superAdminOnly: ['catalog.sru.allowPrivateHosts'] }),
  catalogConfig,
  // ---- Komunitas K1 (settings) ----
  settingsPut('accreditation', AccreditationSettingsBody),
  // ---- Komunitas (circulation core) ----
  settingsPut('circulation', CirculationSettingsBody),
  // ---- Komunitas K2 (members extended): the card pictures are claimed as files of the setting ----
  settingsPut('members', MembersSettingsBody, { afterWrite: claimCardAssets }),
  // ---- Komunitas K2 (visits, privacy): the retention periods need a fresh password confirmation ----
  settingsPut('visits', VisitsSettingsBody),
  settingsPut('privacy', PrivacySettingsBody, { reauth: true }),
  ...SYSTEM_CONFIG_ROUTES,
];
