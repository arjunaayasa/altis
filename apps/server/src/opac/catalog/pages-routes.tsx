import { XmlWriter, latestNews, newsPage, publishedPage, type OpacNewsItem } from '@altis/core';
import { isLocale, resolveLocale, t, type Locale } from '@altis/shared';
import type { Context } from 'hono';
import type { AppEnv } from '../../http/request-id.js';
import type { RouteContext, RouteDecl } from '../../http/route.js';
import { route } from '../../http/route.js';
import { opacText } from './messages.js';
import { opacContext, opacPage, type OpacContext } from './page.js';
import { xmlResponse } from './respond.js';
import { absoluteUrl, pagePath } from './urls.js';
import { newsItemView } from './views/news-item.js';
import { newsListPath, newsListView } from './views/news-list.js';
import { keepLang, pageView, shownText } from './views/page.js';

// The OPAC routes of Halaman & Berita (Phase 2 spec §9.1, §9.5, §9.6; plan Task 20, route catalog): `/halaman/:slug`,
// `/berita/rss`, `/berita` and `/berita/:slug`. Each is `public`, `session: 'none'`, `mode: read`, `maintenance:
// allow`, `idempotency: none`, `audit: null`, without a `query` or `params` schema: the slug and `?hal=` are checked by
// hand, an unknown or ill-formed value is ignored (`hal`) or the 404 page (a slug), never a 422.
//
// - What is shown is what is published at the request's time (`rc.now`): a future `published_at` is a scheduled post,
//   absent from the list and the feed and 404 at its URL until the clock passes it (K14). A missing, draft, scheduled
//   or archived page answers `opacPage(…, {status: 404})` (S17).
// - `/berita/rss` is declared before `/berita/:slug` (Hono serves the first match), so the feed is never a news post;
//   the news slug `rss` is reserved anyway (core opac-pages).
// - The three pages are indexable, with a canonical link from config.baseUrl. The feed is RSS 2.0 with `atom:link
//   rel="self"`, the 20 newest posts, `pubDate` = `published_at` (RFC 822, GMT), cached 15 minutes; every link in it is
//   absolute from config.baseUrl (P13), never from the Host header, and keeps `?lang=` when the request named one.

/** A page's address as the service writes it (`[a-z0-9-]`, 1-191): anything else is no page. */
const SLUG = /^[a-z0-9-]{1,191}$/;
/** `?hal=`: a page number of at most six digits; anything else is page 1. */
const PAGE_PARAM = /^[1-9]\d{0,5}$/;
/** The feed's items (§9.1). */
const FEED_ITEMS = 20;
/** The feed may be cached this long (§9.6). */
const FEED_CACHE = 'public, max-age=900';
const RSS_NS_ATOM = 'http://www.w3.org/2005/Atom';

type PageRoute = RouteContext<unknown, unknown, unknown>;

const PUBLIC_PAGE = {
  method: 'GET',
  public: true,
  session: 'none',
  maintenance: 'allow',
  idempotency: 'none',
  audit: null,
} as const;

/** The language the request named with a valid `?lang=`, or null: what the page's own links keep. */
function requestLang(c: Context<AppEnv>): Locale | null {
  const lang = c.req.query('lang');
  return lang !== undefined && isLocale(lang) ? lang : null;
}

/** The slug of the path, or null when it cannot be a page's. */
function slugOf(rc: PageRoute): string | null {
  const slug = rc.c.req.param('slug');
  return slug !== undefined && SLUG.test(slug) ? slug : null;
}

/** The library's time zone, for the dates of news posts (a bad value falls back to UTC where it is used). */
function timeZoneOf(rc: PageRoute): Promise<string> {
  return rc.services.settings.get<string>(rc.db.db, 'library.timezone');
}

/** The OPAC's 404 page (S17): a missing, draft, scheduled or archived page. */
function notFound(rc: PageRoute, ctx: OpacContext): Response {
  const title = t(ctx.locale, 'opac.not_found.title');
  const text = t(ctx.locale, 'opac.not_found.body');
  return opacPage(rc, ctx, {
    status: 404,
    title,
    description: text,
    robots: 'noindex',
    canonicalPath: null,
    body: () => (
      <>
        <h1>{title}</h1>
        <p>{text}</p>
      </>
    ),
  });
}

const page = route({
  ...PUBLIC_PAGE,
  id: 'opac.page',
  path: '/halaman/:slug',
  handler: async (rc) => {
    const ctx = await opacContext(rc);
    const slug = slugOf(rc);
    const found = slug === null ? null : await publishedPage(rc.db.db, 'page', slug, rc.now);
    if (found === null) return notFound(rc, ctx);
    const view = pageView({ locale: ctx.locale, page: found });
    return opacPage(rc, ctx, {
      title: view.title,
      description: view.description,
      canonicalPath: pagePath('page', found.slug),
      robots: 'index',
      body: () => view.body,
    });
  },
});

/** The RSS `<item>` of a news post in `locale`. */
function feedItem(w: XmlWriter, item: OpacNewsItem, locale: Locale, lang: Locale | null, baseUrl: string): void {
  const { text } = shownText(item.translations, locale);
  const link = absoluteUrl(baseUrl, keepLang(pagePath('news', item.slug), lang));
  w.open('item').leaf('title', text.title).leaf('link', link).leaf('guid', link, { isPermaLink: 'true' }).leaf('pubDate', new Date(item.publishedAt).toUTCString());
  if (text.summary !== null && text.summary.trim() !== '') w.leaf('description', text.summary);
  w.close();
}

const newsRss = route({
  ...PUBLIC_PAGE,
  id: 'opac.news.rss',
  path: '/berita/rss',
  handler: async (rc) => {
    // No page frame: only the library's name and language are read (no menu, no accent).
    const settings = rc.services.settings;
    const [libraryName, libraryLocale] = await Promise.all([
      settings.get<string>(rc.db.db, 'library.name'),
      settings.get<string>(rc.db.db, 'library.locale'),
    ]);
    const locale = resolveLocale(rc.c.req.query('lang'), libraryLocale);
    const lang = requestLang(rc.c);
    const baseUrl = rc.config.baseUrl;
    const items = await latestNews(rc.db.db, FEED_ITEMS, rc.now);

    const w = new XmlWriter();
    w.raw('<?xml version="1.0" encoding="UTF-8"?>\n');
    w.open('rss', { version: '2.0', 'xmlns:atom': RSS_NS_ATOM }).open('channel');
    w.leaf('title', opacText(locale, 'pages.news.feed_title', { library: libraryName }));
    w.leaf('link', absoluteUrl(baseUrl, keepLang('/berita', lang)));
    w.leaf('description', opacText(locale, 'pages.news.description', { library: libraryName }));
    w.leaf('language', locale);
    w.leaf('atom:link', '', { href: absoluteUrl(baseUrl, keepLang('/berita/rss', lang)), rel: 'self', type: 'application/rss+xml' });
    if (items[0] !== undefined) w.leaf('lastBuildDate', new Date(items[0].publishedAt).toUTCString());
    for (const item of items) feedItem(w, item, locale, lang, baseUrl);
    w.close().close();
    return xmlResponse(rc.c, 200, w.toString(), FEED_CACHE);
  },
});

const newsList = route({
  ...PUBLIC_PAGE,
  id: 'opac.news.list',
  path: '/berita',
  handler: async (rc) => {
    const ctx = await opacContext(rc);
    const hal = rc.c.req.query('hal');
    const number = hal !== undefined && PAGE_PARAM.test(hal) ? Number(hal) : 1;
    const news = await newsPage(rc.db.db, number, rc.now);
    if (number > 1 && news.items.length === 0) return notFound(rc, ctx);
    const view = newsListView({ locale: ctx.locale, lang: requestLang(rc.c), news, timeZone: await timeZoneOf(rc), libraryName: ctx.libraryName });
    const feed = absoluteUrl(ctx.baseUrl, keepLang('/berita/rss', requestLang(rc.c)));
    const feedTitle = opacText(ctx.locale, 'pages.news.feed_title', { library: ctx.libraryName });
    return opacPage(rc, ctx, {
      title: view.title,
      description: view.description,
      canonicalPath: newsListPath(number),
      robots: 'index',
      head: () => <link rel="alternate" type="application/rss+xml" title={feedTitle} href={feed} />,
      body: () => view.body,
    });
  },
});

const newsGet = route({
  ...PUBLIC_PAGE,
  id: 'opac.news.get',
  path: '/berita/:slug',
  handler: async (rc) => {
    const ctx = await opacContext(rc);
    const slug = slugOf(rc);
    const post = slug === null ? null : await publishedPage(rc.db.db, 'news', slug, rc.now);
    if (post === null) return notFound(rc, ctx);
    const view = newsItemView({ locale: ctx.locale, lang: requestLang(rc.c), post, timeZone: await timeZoneOf(rc) });
    return opacPage(rc, ctx, {
      title: view.title,
      description: view.description,
      canonicalPath: pagePath('news', post.slug),
      robots: 'index',
      body: () => view.body,
    });
  },
});

/** In this order: the feed before `/berita/:slug`, which would take its path. */
export const OPAC_PAGES_ROUTES: RouteDecl[] = [page, newsRss, newsList, newsGet];
