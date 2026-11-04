import { ADMIN_ASSET_NAME, readReleaseFile } from '@altis/platform';
import { DomainError } from '@altis/shared';
import { cspHeader, cspNonce } from '../http/csp.js';
import { route, type RouteContext, type RouteDecl } from '../http/route.js';

// The admin SPA as the release ships it (spec §4.8, §7.4; decision D31), served from `<release>/public/`:
//
//   GET /admin/assets/:file             admin.assets   a hashed asset: `immutable`, the type of its extension; from the
//                                                      active release, else the previous one (a tab loaded before an
//                                                      update still finds its chunks); 404 in neither
//   GET /admin                          admin.root     index.html, every `__CSP_NONCE__` replaced by a fresh nonce that
//   GET /admin/*                        admin.index    the Content-Security-Policy names too; `no-store`. 503
//                                                      ADMIN_UNAVAILABLE when the release has no index.html. Not for
//                                                      /admin/assets(/…) (404). /admin/_update is the operations page
//                                                      (1c Task 19, `ops.update_page`), mounted before admin.index (M3).
//                                                      `maintenance: allow` (ruling R1c-9): a normal maintenance serves
//                                                      the shell, so a signed-out admin can sign in; a restore does not
//   GET /legal/third-party-notices.txt  legal.notices  the release's THIRD_PARTY_NOTICES.txt
//
// Every one is `session: 'none'` (S29): no cookie is read and no database is touched. File names are checked with
// ADMIN_ASSET_NAME before any file system call, and a real path outside `public/` is never read (readReleaseFile).

/** The placeholder the admin build writes wherever index.html needs the request's nonce (D31). */
export const CSP_NONCE_PLACEHOLDER = '__CSP_NONCE__';

/** `Cache-Control` of a hashed asset: its name changes whenever its content does. */
export const IMMUTABLE_CACHE = 'public, max-age=31536000, immutable';

/** The `Content-Type` of each extension ADMIN_ASSET_NAME accepts. */
const ASSET_TYPES: Readonly<Record<string, string>> = {
  js: 'text/javascript; charset=utf-8',
  css: 'text/css; charset=utf-8',
  woff2: 'font/woff2',
  svg: 'image/svg+xml',
  png: 'image/png',
  ico: 'image/x-icon',
};

export interface AdminAsset {
  body: Buffer<ArrayBuffer>;
  /** The `Content-Type` of its extension. */
  type: string;
}

/** The admin files of the running release (`services.adminAssets`). */
export interface AdminAssets {
  /** index.html as the release ships it (placeholders included), or null when the admin was not built. */
  indexHtml(): Promise<string | null>;
  /** A hashed asset from the active release, else the previous one; null for an invalid name or in neither. */
  asset(name: string): Promise<AdminAsset | null>;
  /** THIRD_PARTY_NOTICES.txt of the active release, or null. */
  notices(): Promise<Buffer<ArrayBuffer> | null>;
}

export interface AdminAssetsOptions {
  /** The directory of the running release. */
  releaseDir: string;
  /** The directory of the previous release (current.json's `previous`), or null; asked on an asset miss only. */
  previousDir(): Promise<string | null>;
}

/** The content type of a valid asset name, or undefined for a name ADMIN_ASSET_NAME refuses. */
function assetType(name: string): string | undefined {
  if (!ADMIN_ASSET_NAME.test(name)) return undefined;
  return ASSET_TYPES[name.slice(name.lastIndexOf('.') + 1)];
}

/**
 * The admin files of the release in `o.releaseDir`. index.html is read once per process, the first time it is
 * found (a release directory never changes; a missing one is looked for again, so a build made after the start is
 * picked up). Assets and notices are read per request.
 */
export function createAdminAssets(o: AdminAssetsOptions): AdminAssets {
  let index: string | undefined;
  return {
    async indexHtml() {
      if (index !== undefined) return index;
      const bytes = await readReleaseFile(o.releaseDir, 'admin-index');
      if (bytes === null) return null;
      index = bytes.toString('utf8');
      return index;
    },
    async asset(name) {
      const type = assetType(name);
      if (type === undefined) return null;
      let body = await readReleaseFile(o.releaseDir, 'admin-asset', name);
      if (body === null) {
        const previous = await o.previousDir();
        if (previous !== null && previous !== o.releaseDir) body = await readReleaseFile(previous, 'admin-asset', name);
      }
      return body === null ? null : { body, type };
    },
    notices: () => readReleaseFile(o.releaseDir, 'legal'),
  };
}

/** For an app that runs from no release directory (tests, tools): the admin is not built, nothing is served. */
const NO_ADMIN_ASSETS: AdminAssets = {
  indexHtml: async () => null,
  asset: async () => null,
  notices: async () => null,
};

/** The admin files of `release` (createApp's `deps.release`), or none without one. */
export function adminAssetsOf(release: { dir: string; previousDir(): Promise<string | null> } | undefined): AdminAssets {
  if (release === undefined) return NO_ADMIN_ASSETS;
  return createAdminAssets({ releaseDir: release.dir, previousDir: () => release.previousDir() });
}

/**
 * Paths under /admin that are never the SPA: the asset folder (admin.assets). `/admin/_update` needs no exception any
 * more: `ops.update_page` serves it before admin.index is asked (1c Task 19, M3).
 */
function outsideSpa(urlPath: string): boolean {
  return urlPath === '/admin/assets' || urlPath.startsWith('/admin/assets/');
}

/** index.html with a fresh nonce in it and in its Content-Security-Policy. */
async function serveIndex(rc: RouteContext): Promise<Response> {
  if (outsideSpa(rc.c.req.path)) throw new DomainError('NOT_FOUND');
  const html = await rc.services.adminAssets.indexHtml();
  if (html === null) throw new DomainError('ADMIN_UNAVAILABLE');
  const nonce = cspNonce();
  return rc.c.body(html.replaceAll(CSP_NONCE_PLACEHOLDER, nonce), 200, {
    'Content-Type': 'text/html; charset=utf-8',
    'Cache-Control': 'no-store',
    'Content-Security-Policy': cspHeader(nonce),
  });
}

const adminAssetsRoute = route<unknown, unknown, Record<string, string>>({
  id: 'admin.assets',
  method: 'GET',
  path: '/admin/assets/:file',
  public: true,
  session: 'none',
  maintenance: 'allow',
  idempotency: 'none',
  audit: null,
  handler: async (rc) => {
    const found = await rc.services.adminAssets.asset(rc.params['file'] ?? '');
    if (found === null) throw new DomainError('NOT_FOUND');
    return rc.c.body(found.body, 200, { 'Content-Type': found.type, 'Cache-Control': IMMUTABLE_CACHE });
  },
});

const adminRoot = route({
  id: 'admin.root',
  method: 'GET',
  path: '/admin',
  public: true,
  session: 'none',
  maintenance: 'allow', // ruling R1c-9
  idempotency: 'none',
  audit: null,
  handler: serveIndex,
});

const adminIndex = route({
  id: 'admin.index',
  method: 'GET',
  path: '/admin/*',
  public: true,
  session: 'none',
  maintenance: 'allow', // ruling R1c-9
  idempotency: 'none',
  audit: null,
  handler: serveIndex,
});

const legalNotices = route({
  id: 'legal.notices',
  method: 'GET',
  path: '/legal/third-party-notices.txt',
  public: true,
  session: 'none',
  idempotency: 'none',
  audit: null,
  handler: async (rc) => {
    const text = await rc.services.adminAssets.notices();
    if (text === null) throw new DomainError('NOT_FOUND');
    return rc.c.body(text, 200, { 'Content-Type': 'text/plain; charset=utf-8' });
  },
});

/** The admin page routes, in mount order: admin.assets comes before admin.index's `/admin/*`. */
export const ADMIN_ROUTES: RouteDecl[] = [adminAssetsRoute, adminRoot, adminIndex, legalNotices];
