import { recordUrlPath } from '@altis/core';
import { t } from '@altis/shared';
import { route, type RouteDecl, type RouteContext } from '../../http/route.js';
import { legacyRedirectPath } from './legacy.js';
import { opacContext, opacPage } from './page.js';
import { publicRecordCount, sitemapPages, sitemapRecords } from './queries.js';
import { redirect301, textResponse, xmlResponse } from './respond.js';
import { robotsTxt } from './robots.js';
import { SITEMAP_CACHE, SITEMAP_MAX_URLS, sitemapIndexXml, urlsetXml } from './sitemap.js';
import { absoluteUrl, pagePath } from './urls.js';

// The OPAC shell's machine routes (Phase 2 Task 21; spec §9.1, §9.7, §9.9), besides the home page (`opac.home`,
// routes.ts, rendered by home.tsx):
//
//   GET /robots.txt          opac.robots           robots.txt (Disallow: / when `opac.indexable` is false)
//   GET /sitemap.xml         opac.sitemap.index    the index of the catalog files and the pages file
//   GET /sitemap/katalog/:n  opac.sitemap.catalog  public records by id, 10 000 per file, by keyset (M5)
//   GET /sitemap/halaman     opac.sitemap.pages    the home page, the published pages and news posts
//   GET /index.php           opac.legacy           old SLiMS links: a 301 to the record, the search or home (S13)
//
// Like every OPAC route (§9.1): public, `session: 'none'` (no cookie is read), mode read, `maintenance: allow`,
// `idempotency: none`, `audit: null`, no `query` or `params` schema (values are checked by hand, unknown ones ignored).
// Every absolute URL comes from config.baseUrl, never from the Host header. A catalog file past the last answers the
// OPAC's 404 page (S17).

/** The declaration fields every route of this file shares. */
const OPAC = { method: 'GET', public: true, session: 'none', maintenance: 'allow', idempotency: 'none', audit: null } as const;

/** A sitemap page number: 1 to 999 999, without a leading zero. */
const PAGE_NUMBER = /^[1-9]\d{0,5}$/;

/** The OPAC's 404 page for a sitemap file that does not exist. */
async function notFoundPage(rc: RouteContext<unknown, unknown, Record<string, string>>): Promise<Response> {
  const ctx = await opacContext(rc);
  const title = t(ctx.locale, 'opac.not_found.title');
  const body = t(ctx.locale, 'opac.not_found.body');
  return opacPage(rc, ctx, {
    status: 404,
    title,
    description: body,
    robots: 'noindex',
    canonicalPath: null,
    body: () => (
      <>
        <h1>{title}</h1>
        <p>{body}</p>
      </>
    ),
  });
}

const robots = route({
  ...OPAC,
  id: 'opac.robots',
  path: '/robots.txt',
  handler: async (rc) => {
    const indexable = await rc.services.settings.get<boolean>(rc.db.db, 'opac.indexable');
    return textResponse(rc.c, 200, robotsTxt(rc.config.baseUrl, indexable !== false), SITEMAP_CACHE);
  },
});

const sitemapIndex = route({
  ...OPAC,
  id: 'opac.sitemap.index',
  path: '/sitemap.xml',
  handler: async (rc) => {
    const files = Math.max(1, Math.ceil((await publicRecordCount(rc.db.db)) / SITEMAP_MAX_URLS));
    return xmlResponse(rc.c, 200, sitemapIndexXml(rc.config.baseUrl, files), SITEMAP_CACHE);
  },
});

const sitemapCatalog = route<unknown, unknown, Record<string, string>>({
  ...OPAC,
  id: 'opac.sitemap.catalog',
  path: '/sitemap/katalog/:n',
  handler: async (rc) => {
    const n = rc.params['n'] ?? '';
    const records = PAGE_NUMBER.test(n) ? await sitemapRecords(rc.db.db, Number(n), SITEMAP_MAX_URLS) : null;
    if (records === null) return notFoundPage(rc);
    const base = rc.config.baseUrl;
    const xml = urlsetXml(records.map((r) => ({ loc: absoluteUrl(base, recordUrlPath(r.id, r.title)), lastmod: r.changedAt })));
    return xmlResponse(rc.c, 200, xml, SITEMAP_CACHE);
  },
});

const sitemapHalaman = route({
  ...OPAC,
  id: 'opac.sitemap.pages',
  path: '/sitemap/halaman',
  handler: async (rc) => {
    const base = rc.config.baseUrl;
    // The home page first, then at most 9 999 pages and news posts: one file of at most 10 000 URLs (§9.7).
    const pages = await sitemapPages(rc.db.db, rc.now, SITEMAP_MAX_URLS - 1);
    const xml = urlsetXml([
      { loc: absoluteUrl(base, '/'), lastmod: null },
      ...pages.map((p) => ({ loc: absoluteUrl(base, pagePath(p.kind, p.slug)), lastmod: p.lastmod })),
    ]);
    return xmlResponse(rc.c, 200, xml, SITEMAP_CACHE);
  },
});

const legacy = route({
  ...OPAC,
  id: 'opac.legacy',
  path: '/index.php',
  handler: async (rc) => redirect301(rc.c, await legacyRedirectPath(rc.db.db, (name) => rc.c.req.query(name))),
});

/** The OPAC shell's routes (the home page is `opac.home` in routes.ts). */
export const OPAC_SHELL_ROUTES: RouteDecl[] = [robots, sitemapIndex, sitemapCatalog, sitemapHalaman, legacy];
