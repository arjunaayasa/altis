import { createHash } from 'node:crypto';
import { defaultSiteIcon, publicSiteIdentity, readSiteIdentity, resolveSiteIdentity, saveSiteIdentity, siteIconPng, siteIdentityUrls } from '@altis/core';
import { DomainError } from '@altis/shared';
import type { OpacHomeContent } from '@altis/shared/api/opac-home';
import {
  SITE_ICON_SIZES,
  SiteIdentityPutBody,
  type SiteIconSize,
  type SiteIdentity,
  type SiteIdentityPublic,
  type SiteIdentityPutResponse,
  type SiteIdentityView,
} from '@altis/shared/api/site-identity';
import type { RouteContext, RouteDecl } from '../http/route.js';
import { route } from '../http/route.js';

// The site's identity (the logo, the logo for dark backgrounds, the site icon, the name and the tagline).
//
//   GET /api/v1/site/identity          site.identity.get     the identity in force with its revision, the library's
//                                                            name and the images' URLs; `opac.pages.manage`
//   PUT /api/v1/site/identity          site.identity.put     saves it (core: CONFLICT_STALE when the revision moved
//                                                            on, the images claimed as public files, audit
//                                                            `site.identity.update`); `opac.pages.manage`
//   GET /api/v1/site/identity/public   site.identity.public  no session: the name, the tagline and the images' URLs,
//                                                            which the public site shows anyway, for the admin's
//                                                            sign-in page and shell; read through the settings cache
//   GET /site-icon/:file               site.icon             `32.png`, `180.png`, `192.png`: the site icon in that
//                                                            size, or the built-in icon while the site has none;
//                                                            what `<link rel="icon">` of every page points at
//
// The logo files themselves are public files (`/files/<id>`). After a save the settings cache is emptied, so this
// process serves the new identity at once (others within the cache's lifetime).

const PATH = '/api/v1/site/identity';

const identityGet = route({
  id: 'site.identity.get',
  method: 'GET',
  path: PATH,
  permission: 'opac.pages.manage',
  idempotency: 'none',
  audit: null,
  handler: async (rc) => {
    // Read afresh, not through the settings cache: the screen shows what is stored now.
    const state = await readSiteIdentity(rc.db.db);
    const body: SiteIdentityView = {
      identity: state.identity,
      saved: state.saved,
      revision: state.revision,
      libraryName: state.libraryName,
      urls: siteIdentityUrls(state.identity),
    };
    return { body };
  },
});

const identityPut = route({
  id: 'site.identity.put',
  method: 'PUT',
  path: PATH,
  permission: 'opac.pages.manage',
  idempotency: 'store',
  audit: 'site.identity.update',
  body: SiteIdentityPutBody,
  handler: async (rc) => {
    const saved = await saveSiteIdentity(rc.tx(), rc.body, { keyring: rc.config.keyring });
    rc.afterCommit(() => rc.services.settings.invalidate());
    const body: SiteIdentityPutResponse = { revision: saved.revision, changed: saved.changed };
    return { body };
  },
});

/** The identity in force and the library's name, through the settings cache. */
export async function cachedSiteIdentity(rc: Pick<RouteContext, 'db' | 'services'>): Promise<{ identity: SiteIdentity; libraryName: string }> {
  const handle = rc.db.db;
  const [stored, home, libraryName] = await Promise.all([
    rc.services.settings.get<SiteIdentity | null>(handle, 'site.identity'),
    rc.services.settings.get<OpacHomeContent | null>(handle, 'opac.home'),
    rc.services.settings.get<string>(handle, 'library.name'),
  ]);
  return { identity: resolveSiteIdentity(stored, home).identity, libraryName };
}

const identityPublic = route({
  id: 'site.identity.public',
  method: 'GET',
  path: `${PATH}/public`,
  public: true,
  session: 'none',
  // As the sign-in it is shown on: open while the site is in maintenance.
  maintenance: 'allow',
  idempotency: 'none',
  audit: null,
  handler: async (rc) => {
    const { identity, libraryName } = await cachedSiteIdentity(rc);
    const body: SiteIdentityPublic = publicSiteIdentity(identity, libraryName);
    return { body, headers: { 'Cache-Control': 'no-cache' } };
  },
});

/** How long a browser keeps the icon before it asks again (with its ETag): a new icon shows within minutes. */
const ICON_CACHE = 'public, max-age=300';
/** The same for a URL that names the icon's file (`?v=<id>`): a new icon has a new URL. */
const ICON_CACHE_VERSIONED = 'public, max-age=86400';

const ICON_FILES: ReadonlyMap<string, SiteIconSize> = new Map(SITE_ICON_SIZES.map((size) => [`${size}.png`, size]));

/** Whether an `If-None-Match` header names `etag` (weak comparison; `*` matches). */
function etagListed(ifNoneMatch: string | undefined, etag: string): boolean {
  if (ifNoneMatch === undefined) return false;
  return ifNoneMatch.split(',').some((tag) => {
    const t = tag.trim();
    return t === '*' || (t.startsWith('W/') ? t.slice(2) : t) === etag;
  });
}

const iconGet = route<unknown, unknown, Record<string, string>>({
  id: 'site.icon',
  method: 'GET',
  path: '/site-icon/:file',
  public: true,
  session: 'none',
  maintenance: 'allow',
  idempotency: 'none',
  audit: null,
  // No `query` schema: `?v=` only makes a new icon a new URL, and is never read as more than "present".
  handler: async (rc) => {
    const size = ICON_FILES.get(rc.params['file'] ?? '');
    if (size === undefined) throw new DomainError('NOT_FOUND');
    // The built-in icon answers whenever the site's own cannot be read: before the install, while a restore runs, or
    // when its file is gone. A page's icon never fails.
    let png = defaultSiteIcon(size);
    try {
      const stored = await rc.services.settings.get<SiteIdentity | null>(rc.db.db, 'site.identity');
      const fileId = stored?.icon?.fileId;
      if (fileId !== undefined) png = (await siteIconPng(rc.db.db, rc.services.dataDir, fileId, size)) ?? png;
    } catch {
      // the built-in icon
    }
    const etag = `"${createHash('sha256').update(png).digest('hex').slice(0, 32)}"`;
    const headers = {
      'Cache-Control': rc.c.req.query('v') === undefined ? ICON_CACHE : ICON_CACHE_VERSIONED,
      ETag: etag,
    };
    if (etagListed(rc.c.req.header('if-none-match'), etag)) return new Response(null, { status: 304, headers });
    return rc.c.body(png as Uint8Array<ArrayBuffer>, 200, {
      ...headers,
      'Content-Type': 'image/png',
      'Content-Length': String(png.byteLength),
      'X-Content-Type-Options': 'nosniff',
      'Cross-Origin-Resource-Policy': 'same-origin',
    });
  },
});

/** The routes of the site identity: the admin screen's two, the public reading and the icon. */
export const SITE_IDENTITY_ROUTES: RouteDecl[] = [identityGet, identityPut, identityPublic, iconGet];
