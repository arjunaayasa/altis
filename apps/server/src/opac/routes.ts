import type { SettingsCache } from '@altis/core';
import type { DbHandle } from '@altis/db';
import { OPAC_CSS } from '@altis/opac-theme';
import { DomainError, newId, resolveLocale } from '@altis/shared';
import type { Context } from 'hono';
import { IMMUTABLE_CACHE } from '../admin/serve.js';
import { cspHeader, cspNonce } from '../http/csp.js';
import type { Logger } from '../logger.js';
import type { AppEnv } from '../http/request-id.js';
import { route, type RouteDecl } from '../http/route.js';
import { loggableError } from '../safe-error.js';
import { homeResponse } from './catalog/home.js';
import { pageFrame, requestNow } from './catalog/page.js';
import { navPages, type OpacNavLink } from './catalog/queries.js';
import { OPAC_CSS_FILE } from './layout.js';
import { renderError, renderNotFound } from './pages.js';

// The OPAC's own routes (spec §4.9, §9.1; decisions D2, D30), after the catalogue's (opac/catalog, Phase 2):
//
//   GET /              opac.home    the catalogue's home page (Phase 2 Task 21, catalog/home.tsx): search box, new
//                                   and promoted titles, news, DDC classes, JSON-LD Library + WebSite
//   GET /assets/:file  opac.assets  OPAC_CSS from memory under its content hash (`immutable`); any other name is 404
//
// Both are `session: 'none'` (S29): no cookie is read and no session is looked up. The home page reads its settings
// through the settings cache and the catalogue through the database, never a session; the stylesheet needs neither.
// They are `maintenance: 'allow'` as the route catalog says.
//
// Beyond the two routes this file holds what createApp uses for the HTML flavours of its two catch-alls: a path that is
// not under /api/ and whose Accept header names text/html gets the OPAC 404 page (notFoundResponse) and, for an
// unexpected failure, the OPAC 500 page (errorPageResponse); every other request keeps the problem+json it always had.
// Every HTML response carries its own nonce and the Content-Security-Policy that names it.

/**
 * The first 10 hex digits of the SHA-256 of OPAC_CSS, computed once at module load (M30). It is defined in layout.tsx,
 * which links the stylesheet by it, so that the pages do not have to import their own routes.
 */
export { OPAC_CSS_HASH } from './layout.js';

/** The `Cache-Control` of a page: it is built from settings, with a nonce of its own in it. */
const PAGE_CACHE = 'no-store';

/** Answers `status` with the page `render` makes for a fresh nonce, and the policy naming that nonce. */
function htmlResponse(c: Context<AppEnv>, status: 200 | 404 | 500, render: (nonce: string) => string): Response {
  const nonce = cspNonce();
  return c.body(render(nonce), status, {
    'Content-Type': 'text/html; charset=utf-8',
    'Cache-Control': PAGE_CACHE,
    'Content-Security-Policy': cspHeader(nonce),
  });
}

/** The settings the 404 page is built from. */
interface OpacSettings {
  libraryName: string;
  libraryLocale: string;
  accent: string;
}

async function loadOpacSettings(settings: SettingsCache, db: DbHandle): Promise<OpacSettings> {
  const handle = db.db;
  const [libraryName, libraryLocale, accent] = await Promise.all([
    settings.get<string>(handle, 'library.name'),
    settings.get<string>(handle, 'library.locale'),
    settings.get<string>(handle, 'opac.accent'),
  ]);
  return { libraryName, libraryLocale, accent };
}

const home = route({
  id: 'opac.home',
  method: 'GET',
  path: '/',
  public: true,
  session: 'none',
  maintenance: 'allow',
  idempotency: 'none',
  audit: null,
  // No `query` schema: a public page gets whatever a link carries (utm_source, fbclid) and must not answer 422 for it.
  // `?lang=` is read as text and taken only when it is one of the locales (resolveLocale).
  handler: async (rc) => homeResponse(rc),
});

const assets = route<unknown, unknown, Record<string, string>>({
  id: 'opac.assets',
  method: 'GET',
  path: '/assets/:file',
  public: true,
  session: 'none',
  maintenance: 'allow',
  idempotency: 'none',
  audit: null,
  handler: async (rc) => {
    if (rc.params['file'] !== OPAC_CSS_FILE) throw new DomainError('NOT_FOUND');
    return rc.c.body(OPAC_CSS, 200, { 'Content-Type': 'text/css; charset=utf-8', 'Cache-Control': IMMUTABLE_CACHE });
  },
});

/** The OPAC routes (route catalog: opac.assets, opac.home). */
export const OPAC_ROUTES: RouteDecl[] = [assets, home];

// ---------------------------------------------------------------------------------------------------------------
// HTML or problem+json

/**
 * Whether the request is answered with a page rather than problem+json (http/html-request.ts, where step 5 asks it
 * too since 1c Task 19).
 */
export { wantsHtml } from '../http/html-request.js';

/**
 * The OPAC 404 page in the catalogue's frame (Phase 2 Task 21): its language is `?lang=`, then `library.locale`; it
 * carries the library's name, accent and menu when they can be read, the search form, and a language switch that
 * keeps the path from the request's config.baseUrl (S7; on this site before the install). The settings come from the
 * cache; a failed read (no database, a database error) is only logged, never turned into another answer: a 404 stays
 * a 404 page.
 */
export async function notFoundResponse(
  c: Context<AppEnv>,
  o: { settings: SettingsCache; db: DbHandle | undefined; log: Logger },
): Promise<Response> {
  let s: OpacSettings | null = null;
  if (o.db !== undefined) {
    try {
      s = await loadOpacSettings(o.settings, o.db);
    } catch (error) {
      o.log.warn('opac: settings unavailable for the 404 page', { err: loggableError(error) });
    }
  }
  const locale = resolveLocale(c.req.query('lang'), s?.libraryLocale);
  let nav: OpacNavLink[] = [];
  if (o.db !== undefined && s !== null) {
    try {
      nav = await navPages(o.db.db, requestNow(c), locale);
    } catch (error) {
      o.log.warn('opac: the menu is unavailable for the 404 page', { err: loggableError(error) });
    }
  }
  const config: { baseUrl?: unknown } | undefined = c.get('config');
  const frame = pageFrame(c, { locale, baseUrl: typeof config?.baseUrl === 'string' ? config.baseUrl : '', nav }, { search: true });
  return htmlResponse(c, 404, (nonce) =>
    renderNotFound({ locale, nonce, frame, ...(s === null ? {} : { libraryName: s.libraryName, accent: s.accent }) }),
  );
}

/**
 * The OPAC 500 page: a generic message and the last 8 characters of the request id (§11), nothing of the failure. The
 * error has been logged by the caller. No settings are read here: the failure may well be the database, and an error
 * page must not wait for it a second time, so the language is `?lang=` or the default.
 */
export function errorPageResponse(c: Context<AppEnv>): Response {
  const code = ((c.get('requestId') as string | undefined) ?? newId()).slice(-8);
  const locale = resolveLocale(c.req.query('lang'));
  return htmlResponse(c, 500, (nonce) => renderError({ locale, code, nonce }));
}
