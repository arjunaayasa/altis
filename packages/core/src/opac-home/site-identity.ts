import { createHash } from 'node:crypto';
import { upsert, type DB } from '@altis/db';
import { readBytes, uploadPath } from '@altis/platform';
import { DomainError, isUlid } from '@altis/shared';
import type { OpacHomeContent } from '@altis/shared/api/opac-home';
import {
  SITE_ICON_CONTEXT,
  SITE_ICON_SIZES,
  SITE_IDENTITY_DEFAULT,
  SITE_LOGO_CONTEXT,
  siteIconPath,
  type SiteIconSize,
  type SiteIconUrls,
  type SiteIdentity,
  type SiteIdentityPublic,
  type SiteIdentityPutBody,
} from '@altis/shared/api/site-identity';
import type { Kysely, Transaction } from 'kysely';
import type { TxCtx } from '../context.js';
import type { KeyringEntry } from '../crypto/secret-box.js';
import { SiteImageError, siteIconVariant } from '../files/site-images.js';
import { SETTINGS } from '../settings/registry.js';
import { readSettings, writeSettings } from '../settings/service.js';

// The site's identity (the setting `site.identity`): the logo, the logo for dark backgrounds, the site icon, the
// site's name and tagline; read and saved as one thing by the admin screen OPAC › Identitas situs, and read by
// everything that shows the logo or the name.
//
// - Until it is saved for the first time the setting is null, and the identity in force is built from what the site
//   had before: the logo of the home page's content and the library's name (`resolveSiteIdentity`). Once saved, the
//   setting alone counts and the home page's logo is no longer read (a later save of the home page clears it).
// - A revision (16 hex digits of the SHA-256 of the identity in force) names what the screen loaded; a save that names
//   another is refused with CONFLICT_STALE. The save locks the setting's row first (inserting it as null when
//   absent), then reads.
// - The images are uploads of `site.logo` (both logos) and `site.icon`. Saving claims the ones the identity names as
//   public files of the setting (`owner_type 'settings'`, `owner_id 'site.identity'`) and releases the ones it no
//   longer names: they lose their owner and turn `staff`, and the reports housekeeping removes them a day later. The
//   one exception is the old logo: a home page photo the home page (or this setting) holds may stay the main logo, and
//   becomes this setting's file then. Any other file id is a VALIDATION_FAILED at its place in the body.
// - One audit entry `site.identity.update` with the names of the fields that changed.

/** The setting that holds the identity, and the owner id of its images. */
export const SITE_IDENTITY_KEY = 'site.identity';
/** The setting and context the old logo came from. */
const HOME_KEY = 'opac.home';
const HOME_PHOTO_CONTEXT = 'opac.home_photo';

type Db = Kysely<DB> | Transaction<DB>;

/** The identity in force, whether it was ever saved, its revision and the library's name. */
export interface SiteIdentityState {
  identity: SiteIdentity;
  saved: boolean;
  revision: string;
  libraryName: string;
}

/**
 * The identity in force: `stored` when the identity was saved, else the defaults with the home page's old logo.
 * Everything that shows the logo reads it through this.
 */
export function resolveSiteIdentity(stored: SiteIdentity | null, home: Pick<OpacHomeContent, 'logo'> | null): { identity: SiteIdentity; saved: boolean } {
  if (stored !== null) return { identity: stored, saved: true };
  const old = home?.logo ?? null;
  return { identity: { ...SITE_IDENTITY_DEFAULT, logo: old === null ? null : { fileId: old.fileId, alt: old.alt } }, saved: false };
}

/** The site's name: the identity's own, or the library's when that is blank. */
export function siteName(identity: Pick<SiteIdentity, 'name'>, libraryName: string): string {
  const own = identity.name?.trim() ?? '';
  return own === '' ? libraryName : own;
}

/** Where the icon of each size is served; `version` (the icon's file id, or none) makes a new icon a new URL. */
export function siteIconUrls(identity: Pick<SiteIdentity, 'icon'>): SiteIconUrls {
  const version = identity.icon === null ? '' : `?v=${identity.icon.fileId}`;
  return Object.fromEntries(SITE_ICON_SIZES.map((size) => [String(size), `${siteIconPath(size)}${version}`])) as SiteIconUrls;
}

/** The URL a public file is served at. */
const fileUrl = (fileId: string): string => `/files/${fileId}`;

/** Where the identity's images are served. */
export function siteIdentityUrls(identity: SiteIdentity): { logo: string | null; logoDark: string | null; icon: SiteIconUrls } {
  return {
    logo: identity.logo === null ? null : fileUrl(identity.logo.fileId),
    logoDark: identity.logoDark === null ? null : fileUrl(identity.logoDark.fileId),
    icon: siteIconUrls(identity),
  };
}

/** What a visitor without a session may know of the identity: nothing but what the public site shows. */
export function publicSiteIdentity(identity: SiteIdentity, libraryName: string): SiteIdentityPublic {
  const name = siteName(identity, libraryName);
  const blank = (t: string | null): string | null => (t === null || t.trim() === '' ? null : t);
  return {
    name,
    tagline: { id: blank(identity.tagline.id), en: blank(identity.tagline.en) },
    showNameBesideLogo: identity.showNameBesideLogo,
    logo: identity.logo === null ? null : { url: fileUrl(identity.logo.fileId), alt: identity.logo.alt.trim() === '' ? name : identity.logo.alt },
    logoDark: identity.logoDark === null ? null : { url: fileUrl(identity.logoDark.fileId) },
    hasIcon: identity.icon !== null,
    icon: siteIconUrls(identity),
  };
}

function revisionOf(identity: SiteIdentity, saved: boolean): string {
  return createHash('sha256').update(JSON.stringify([saved, identity])).digest('hex').slice(0, 16);
}

/** The identity in force as stored now (not through a cache), with its revision and the library's name. */
export async function readSiteIdentity(db: Db): Promise<SiteIdentityState> {
  const values = await readSettings(db, [SITE_IDENTITY_KEY, HOME_KEY, 'library.name'], []);
  const { identity, saved } = resolveSiteIdentity(values[SITE_IDENTITY_KEY] as SiteIdentity | null, values[HOME_KEY] as OpacHomeContent | null);
  return { identity, saved, revision: revisionOf(identity, saved), libraryName: values['library.name'] as string };
}

/** True once the identity was saved: the home page's own logo is not read any more. */
export async function siteIdentitySaved(db: Db): Promise<boolean> {
  return (await readSettings(db, [SITE_IDENTITY_KEY], []))[SITE_IDENTITY_KEY] !== null;
}

/** The icons made so far, by file id and size (a file's content never changes; a new icon is a new file). */
const iconCache = new Map<string, Uint8Array>();
const ICON_CACHE_ENTRIES = 12;
/** The stored icon is at most 512 px a side; anything larger than this is not one. */
const STORED_ICON_MAX_BYTES = 2 * 1024 * 1024;

/**
 * The site icon `fileId` as a `size` × `size` PNG, made from the stored icon (and kept in memory); null when the file
 * is not the identity's stored icon or cannot be read.
 */
export async function siteIconPng(db: Db, dataDir: string, fileId: string, size: SiteIconSize): Promise<Uint8Array | null> {
  if (!isUlid(fileId)) return null;
  const key = `${fileId}:${size}`;
  const cached = iconCache.get(key);
  if (cached !== undefined) return cached;
  const row = await db.selectFrom('files').select(['context', 'status', 'owner_type', 'owner_id']).where('id', '=', fileId).executeTakeFirst();
  if (row === undefined || row.context !== SITE_ICON_CONTEXT || row.status !== 'ok' || row.owner_type !== 'settings' || row.owner_id !== SITE_IDENTITY_KEY) return null;
  const stored = await readBytes(uploadPath(dataDir, fileId), STORED_ICON_MAX_BYTES).catch(() => null);
  if (stored === null) return null;
  let png: Uint8Array;
  try {
    png = siteIconVariant(stored, size);
  } catch (error) {
    if (error instanceof SiteImageError) return null;
    throw error;
  }
  if (iconCache.size >= ICON_CACHE_ENTRIES) iconCache.clear();
  iconCache.set(key, png);
  return png;
}

/** A blank text is none. */
const textOrNull = (value: string | null): string | null => (value === null || value.trim() === '' ? null : value.trim());

/** `identity` as it is stored: blank name and taglines as null. */
function normalized(identity: SiteIdentity): SiteIdentity {
  return {
    logo: identity.logo === null ? null : { fileId: identity.logo.fileId, alt: identity.logo.alt.trim() },
    logoDark: identity.logoDark === null ? null : { fileId: identity.logoDark.fileId },
    icon: identity.icon === null ? null : { fileId: identity.icon.fileId },
    name: textOrNull(identity.name),
    tagline: { id: textOrNull(identity.tagline.id), en: textOrNull(identity.tagline.en) },
    showNameBesideLogo: identity.showNameBesideLogo,
  };
}

const FIELDS = ['logo', 'logoDark', 'icon', 'name', 'tagline', 'showNameBesideLogo'] as const satisfies readonly (keyof SiteIdentity)[];

/**
 * Claims the images `identity` names as public files of the setting and releases the setting's other files.
 *
 * @throws DomainError VALIDATION_FAILED (`not_found`, or `invalid` for a file of another context, not stored, or owned
 *   by something else) at the image's place in the body
 */
async function claimImages(trx: Transaction<DB>, identity: SiteIdentity): Promise<void> {
  const slots: { path: string; fileId: string; context: string; oldLogo: boolean }[] = [];
  if (identity.logo !== null) slots.push({ path: 'identity.logo.fileId', fileId: identity.logo.fileId, context: SITE_LOGO_CONTEXT, oldLogo: true });
  if (identity.logoDark !== null) slots.push({ path: 'identity.logoDark.fileId', fileId: identity.logoDark.fileId, context: SITE_LOGO_CONTEXT, oldLogo: false });
  if (identity.icon !== null) slots.push({ path: 'identity.icon.fileId', fileId: identity.icon.fileId, context: SITE_ICON_CONTEXT, oldLogo: false });
  const wanted = [...new Set(slots.map((s) => s.fileId))];
  if (wanted.length > 0) {
    const rows = await trx.selectFrom('files').select(['id', 'context', 'status', 'owner_type', 'owner_id']).where('id', 'in', wanted).execute();
    const byId = new Map(rows.map((r) => [r.id, r]));
    const errors: { path: string; code: string }[] = [];
    for (const slot of slots) {
      const f = byId.get(slot.fileId);
      if (f === undefined) {
        errors.push({ path: slot.path, code: 'not_found' });
        continue;
      }
      const unowned = f.owner_type === null && f.owner_id === null;
      const ours = f.owner_type === 'settings' && f.owner_id === SITE_IDENTITY_KEY;
      const homes = f.owner_type === 'settings' && f.owner_id === HOME_KEY;
      // The old logo: a home page photo that the home page or this setting holds (never a loose upload of that context).
      const old = slot.oldLogo && f.context === HOME_PHOTO_CONTEXT && (ours || homes);
      const own = f.context === slot.context && (unowned || ours);
      if (f.status !== 'ok' || !(own || old)) errors.push({ path: slot.path, code: 'invalid' });
    }
    if (errors.length > 0) {
      throw new DomainError('VALIDATION_FAILED', { detail: 'Gambar identitas situs tidak valid / An image of the site identity is not valid', meta: { errors } });
    }
    await trx.updateTable('files').set({ owner_type: 'settings', owner_id: SITE_IDENTITY_KEY, access: 'public' }).where('id', 'in', wanted).execute();
  }
  let release = trx.updateTable('files').set({ owner_type: null, owner_id: null, access: 'staff' }).where('owner_type', '=', 'settings').where('owner_id', '=', SITE_IDENTITY_KEY);
  if (wanted.length > 0) release = release.where('id', 'not in', wanted);
  await release.execute();
}

/**
 * Saves the identity (see the top of this file) in `tx`, if `body.revision` is the stored one. Answers the new
 * revision and the fields that changed (in the identity's order).
 *
 * @throws DomainError CONFLICT_STALE when the identity in force is not the revision the body names; VALIDATION_FAILED
 *   for an image that cannot be claimed
 */
export async function saveSiteIdentity(
  tx: TxCtx,
  body: SiteIdentityPutBody,
  o: { keyring: readonly KeyringEntry[] },
): Promise<{ revision: string; changed: string[] }> {
  const { trx } = tx;
  // Lock first: the setting's row, inserted as its default (null) when absent.
  const def = SETTINGS[SITE_IDENTITY_KEY];
  const seed = { value: JSON.stringify(def.default), is_secret: 0, scope: def.scope, updated_at: tx.now, updated_by: tx.actor.id };
  await upsert(trx, 'settings', { key: SITE_IDENTITY_KEY }, seed, { scope: def.scope });
  const current = await readSiteIdentity(trx);
  if (current.revision !== body.revision) {
    throw new DomainError('CONFLICT_STALE', {
      detail:
        'Identitas situs sudah diubah orang lain; muat ulang lalu ulangi perubahan Anda / ' +
        'The site identity was changed by someone else; reload it and make your changes again',
    });
  }
  const identity = normalized(body.identity);
  await claimImages(trx, identity);
  await writeSettings(trx, { [SITE_IDENTITY_KEY]: identity }, { keyring: o.keyring, now: tx.now, actorId: tx.actor.id });
  const changed = FIELDS.filter((field) => JSON.stringify(current.identity[field]) !== JSON.stringify(identity[field]));
  await tx.audit({ action: 'site.identity.update', entity: 'settings', entityId: null, meta: { fields: changed, first: !current.saved } });
  return { revision: revisionOf(identity, true), changed };
}
