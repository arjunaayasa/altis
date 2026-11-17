import { jsonForHtmlScript, type SafeHtml } from '@altis/core';
import type { DbHandle } from '@altis/db';
import { DEFAULT_ACCENT, isAccent } from '@altis/opac-theme';
import { LOCALES, isLocale, localDate, resolveLocale, type Locale } from '@altis/shared';
import { OPAC_HOME_DEFAULT, opacHomeTextIn, type OpacHomeContent } from '@altis/shared/api/opac-home';
import type { Context } from 'hono';
import { raw } from 'hono/html';
import type { JSX } from 'hono/jsx/jsx-runtime';
import type { HtmlEscapedString } from 'hono/utils/html';
import type { ContentfulStatusCode } from 'hono/utils/http-status';
import type { Config } from '../../config.js';
import { cspHeader, cspNonce } from '../../http/csp.js';
import type { AppEnv } from '../../http/request-id.js';
import type { AppServices } from '../../services.js';
import { Layout, toDocument, type FrameLink, type HeroBand, type PageFrame, type SiteFooter, type SiteLogo } from '../layout.js';
import { opacText } from './messages.js';
import { hasPublishedNews, navPages, type OpacNavLink } from './queries.js';
import { absoluteUrl, isLocalPath, withLang } from './urls.js';

// The page frame of the catalogue's OPAC pages (Phase 2 Tasks 3 and 21; spec §9.1, §9.2). Every catalogue page handler
// builds its context once (`opacContext`) and answers with `opacPage`, a 404 included (S17: a missing, hidden or
// archived object is `opacPage(…, {status: 404})`, not a thrown error).
//
// The frame (Task 21): a skip link to `<main>`, a header with the library name, the menu pages (`show_in_nav`, ≤ 8),
// a GET search form to /cari and a language switch that keeps the path and the query; in `<head>` the canonical link,
// hreflang id/en/x-default, OpenGraph basics, the robots meta (`opac.indexable = false` → `noindex` everywhere) and
// the JSON-LD scripts with the response's nonce.
//
// S7: a link that keeps the request path (the language switch, the canonical and hreflang links when the page names
// no canonical path) is config.baseUrl + the normalised path (leading slashes and backslashes collapsed to one `/`,
// resolved against baseUrl and refused unless the origin stays baseUrl's) + the validated query. The Host header is
// never read, and a request for `//evil.example` never becomes a protocol-relative link.
//
// S6: this file is one of the two places allowed to import `raw` from hono/html (eslint.config.js). Sanitized HTML
// reaches a page only through `safeHtml`, JSON-LD only through `jsonLdScript`; nothing else here emits raw markup.

/** What every OPAC page is built from: the language of the request and the library's settings. */
export interface OpacContext {
  locale: Locale;
  libraryName: string;
  /** One of the six accents (anything else was replaced by the default). */
  accent: string;
  /** config.baseUrl (P13): every absolute URL starts with it, never with the Host header. */
  baseUrl: string;
  /** False: every page is `noindex` (`opac.indexable`). */
  indexable: boolean;
  /** The menu pages (`show_in_nav`, published, ≤ 8, by `sort_order`); absent: no menu (the status pages). */
  nav?: readonly OpacNavLink[];
  // ---- Komunitas (OPAC look) ----
  /** What the site menu and the footer show of the library; absent: the status pages, which read nothing. */
  site?: SiteInfo;
  /** The year of the request in the library's time zone (the footer's line); absent: the status pages. */
  year?: number;
}

/** The library's site as the menu and the footer of every page show it (from the settings and the published news). */
export interface SiteInfo {
  /** `library.address` (line breaks kept), or null. */
  address: string | null;
  /** The opening hours of the home page's visit block (none while that block is switched off). */
  hours: readonly { days: string; time: string }[];
  /** The library's colour of the header bar (`#rrggbb`), or null: the accent's. */
  brand: string | null;
  /** The home page shows its "about" block (switched on, with content): the menu's "Profil". */
  profile: boolean;
  /** The home page shows its services block: the menu's "Layanan". */
  services: boolean;
  /** The home page shows its visit block (switched on, with an address or hours): the menu's "Kontak". */
  contact: boolean;
  /** A news post is published: the menu's "Berita". */
  news: boolean;
  // ---- Komunitas (OPAC look) ----
  /** The library's logo (header and footer), or null. */
  logo: SiteLogo | null;
  /** The published telephone number and e-mail address, each null when there is none. */
  phone: string | null;
  email: string | null;
  /** The language of the library's own texts (the address, the hours) when it is not the page's. */
  contentLang?: Locale | undefined;
}

/** The site of `home` with `address` and whether news is published (see SiteInfo). */
export function siteInfo(home: OpacHomeContent, address: string | null, news: boolean): SiteInfo {
  const b = home.blocks;
  const about = home.about;
  const hasAddress = address !== null && address.trim() !== '';
  const aboutText = opacHomeTextIn(about.text, 'id') ?? opacHomeTextIn(about.text, 'en');
  // A content saved before the contact and the logo existed reads them as none.
  const contact: OpacHomeContent['contact'] | undefined = home.contact;
  const logo: OpacHomeContent['logo'] | undefined = home.logo;
  const phone = contact?.phone === undefined || contact.phone === null || contact.phone.trim() === '' ? null : contact.phone;
  const email = contact?.email === undefined || contact.email === null || contact.email.trim() === '' ? null : contact.email;
  return {
    address: hasAddress ? address : null,
    hours: b.visit ? home.hours.map((h) => ({ days: h.days, time: h.time })) : [],
    brand: home.brand ?? null,
    profile: b.about && (aboutText !== null || about.photo !== null || about.founded !== null || about.librarians !== null),
    services: b.services && (home.services.length > 0 || home.facilities.length > 0),
    contact: b.visit && (hasAddress || home.hours.length > 0 || phone !== null || email !== null),
    news,
    logo: logo === undefined || logo === null ? null : { src: `/files/${encodeURIComponent(logo.fileId)}`, alt: logo.alt },
    phone,
    email,
  };
}

/**
 * The library's site as the menu and the footer show it (SiteInfo, without its content language): `library.address`
 * and `opac.home` through the settings cache, and whether a news post is published at `now`.
 */
export async function readSiteInfo(settings: AppServices['settings'], handle: DbHandle['db'], now: number): Promise<SiteInfo> {
  const [address, home, news] = await Promise.all([
    settings.get<string | null>(handle, 'library.address'),
    settings.get<OpacHomeContent>(handle, 'opac.home'),
    hasPublishedNews(handle, now),
  ]);
  return siteInfo(home ?? OPAC_HOME_DEFAULT, address ?? null, news);
}

/** The language of the library's own texts (`library.locale`) on a page in `locale`, when it is another one. */
export function siteContentLang(libraryLocale: string, locale: Locale): Locale | undefined {
  return isLocale(libraryLocale) && libraryLocale !== locale ? libraryLocale : undefined;
}

/** One OPAC page. */
export interface OpacPageOptions {
  /** Default 200. */
  status?: number;
  title: string;
  /** The meta description; default the title. */
  description?: string;
  /**
   * The page's canonical path (`/katalog/<id>/<slug>`), written as an absolute link from baseUrl, with the page's
   * `lang` when the request named one; null: none. Absent: a 200 page's canonical is the request's own normalised path
   * and validated query (S7); any other status gets none.
   */
  canonicalPath?: string | null;
  /** `index`: no robots meta; `noindex`; `noindex-follow` (the search page, §9.1). An install that is not indexable is `noindex` everywhere. */
  robots: 'index' | 'noindex' | 'noindex-follow';
  /** More of `<head>` (Dublin Core, a Twitter card, ...); a script in it carries `nonce`. */
  head?: (nonce: string) => JSX.Element;
  /** JSON-LD objects, each written by {@link jsonLdScript}. */
  jsonLd?: object[];
  /** The page's content inside `<main>`; a script in it carries `nonce`. */
  body: (nonce: string) => JSX.Element;
  /** Default `no-store`. */
  cacheControl?: string;
  /**
   * The OpenGraph basics of a 200 page (`og:type`, `og:site_name`, `og:title`, `og:description`, `og:locale`, `og:url`
   * = the canonical link): `type` default `website`, `image` a local path (a cover's `/files/<id>`). False: none.
   */
  openGraph?: { type?: string; image?: string | null } | false;
  /** The search form in the header; default true (the home page shows its own). */
  headerSearch?: boolean;
  /** The page's own search form in the header's search band, in place of the plain one (the results page's). */
  searchBand?: () => JSX.Element;
  // ---- Komunitas (OPAC home page) ----
  /** The home page's hero band around the header (layout.tsx HeroBand). */
  hero?: HeroBand;
}

/** What `opacContext` reads from a route's context (a RouteContext has all of it). */
export interface OpacContextSource {
  readonly c: Context<AppEnv>;
  readonly services: Pick<AppServices, 'settings'>;
  readonly db: DbHandle;
  readonly config: Pick<Config, 'baseUrl'>;
}

/** What `opacPage` answers through (a RouteContext, or a bare Hono context `{c}`). */
export interface OpacResponder {
  readonly c: Context<AppEnv>;
}

/** The time of the request (step 2's reading), or now when the request has none. */
export function requestNow(c: Context<AppEnv>): number {
  const now: unknown = c.get('now');
  return typeof now === 'number' ? now : Date.now();
}

/**
 * The context of an OPAC request: `?lang=` (then `library.locale`), `library.name`, `opac.accent` and
 * `opac.indexable` through the settings cache (30 s, no session is read), `config.baseUrl`, and the menu pages.
 */
export async function opacContext(rc: OpacContextSource): Promise<OpacContext> {
  const handle = rc.db.db;
  const settings = rc.services.settings;
  const now = requestNow(rc.c);
  const [libraryName, libraryLocale, accent, indexable, site, timeZone] = await Promise.all([
    settings.get<string>(handle, 'library.name'),
    settings.get<string>(handle, 'library.locale'),
    settings.get<string>(handle, 'opac.accent'),
    settings.get<boolean>(handle, 'opac.indexable'),
    readSiteInfo(settings, handle, now),
    settings.get<string>(handle, 'library.timezone'),
  ]);
  const locale = resolveLocale(rc.c.req.query('lang'), libraryLocale);
  let today: string;
  try {
    today = localDate(timeZone, now);
  } catch {
    today = localDate('UTC', now);
  }
  return {
    locale,
    libraryName,
    accent: isAccent(accent) ? accent : DEFAULT_ACCENT,
    baseUrl: rc.config.baseUrl,
    indexable: indexable !== false,
    nav: await navPages(handle, now, locale),
    site: { ...site, contentLang: siteContentLang(libraryLocale, locale) },
    year: Number(today.slice(0, 4)),
  };
}

// ---------------------------------------------------------------------------------------------------------------
// Links that keep the request path (S7)

/** The origin a path is resolved against when no baseUrl is known yet (the status page before the config). */
const FALLBACK_BASE = 'https://x.invalid';

/** A query parameter a link keeps: a short ASCII name (the OPAC's own are lower case words). */
const QUERY_NAME = /^[A-Za-z][A-Za-z0-9_]{0,31}$/;
/** Campaign tags: a link to the same page in another language, or its canonical link, does not carry them. */
const TRACKING = /^(?:utm_[A-Za-z0-9_]*|fbclid|gclid|dclid|gbraid|wbraid|msclkid|yclid|mc_cid|mc_eid)$/;
/** Text a link never carries: control characters (C0, DEL, C1), lone surrogates, line and paragraph separators. */
const UNSAFE_TEXT = /[\p{Cc}\p{Cs}\p{Zl}\p{Zp}]/u;
/** At most this many parameters of at most this many characters each are kept. */
const QUERY_MAX = 20;
const QUERY_VALUE_MAX = 1000;

/** `baseUrl` without a trailing slash (config.baseUrl has none; P13). */
function origin(baseUrl: string): string {
  return baseUrl.replace(/\/+$/, '');
}

/**
 * The path of `requestUrl` as a link may keep it: leading slashes and backslashes collapsed to one `/`, resolved
 * against `baseUrl` (dot segments removed, percent-encoded), refused unless the result stays on baseUrl's origin, and
 * collapsed again; `/` for anything that is not a local path then.
 */
export function keptPath(requestUrl: string, baseUrl: string): string {
  let pathname: string;
  try {
    pathname = new URL(requestUrl).pathname;
  } catch {
    return '/';
  }
  const base = baseUrl === '' ? FALLBACK_BASE : baseUrl;
  let resolved: URL;
  try {
    resolved = new URL(pathname.replace(/^[/\\]+/, '/'), base);
    if (resolved.origin !== new URL(base).origin) return '/';
  } catch {
    return '/';
  }
  const path = resolved.pathname.replace(/^[/\\]+/, '/');
  return isLocalPath(path) ? path : '/';
}

/**
 * The query of `requestUrl` as a link may keep it, in order: no `lang` (each link sets its own), no campaign tag, no
 * parameter with an odd name or a value over 1 000 characters or holding a control character; at most 20.
 */
export function keptQuery(requestUrl: string): URLSearchParams {
  const out = new URLSearchParams();
  let params: URLSearchParams;
  try {
    params = new URL(requestUrl).searchParams;
  } catch {
    return out;
  }
  let kept = 0;
  for (const [name, value] of params) {
    if (kept >= QUERY_MAX) break;
    if (name === 'lang' || !QUERY_NAME.test(name) || TRACKING.test(name)) continue;
    if (value.length > QUERY_VALUE_MAX || UNSAFE_TEXT.test(value)) continue;
    out.append(name, value);
    kept += 1;
  }
  return out;
}

/** `?<query>` with `lang` set when given, or '' when there is nothing to write. */
function queryWith(query: URLSearchParams, lang: Locale | null): string {
  const q = new URLSearchParams(query);
  if (lang !== null) q.set('lang', lang);
  const text = q.toString();
  return text === '' ? '' : `?${text}`;
}

/** The language the request named with a valid `?lang=` (the first one), or null: what the page's own links keep. */
export function requestLang(c: Context<AppEnv>): Locale | null {
  const lang = c.req.query('lang');
  return lang !== undefined && isLocale(lang) ? lang : null;
}

/** `path` (a local path) without its `lang` parameters, the rest of the query and the fragment kept. */
function withoutLang(path: string): string {
  const hashAt = path.indexOf('#');
  const hash = hashAt === -1 ? '' : path.slice(hashAt);
  const rest = hashAt === -1 ? path : path.slice(0, hashAt);
  const queryAt = rest.indexOf('?');
  if (queryAt === -1) return path;
  const params = rest
    .slice(queryAt + 1)
    .split('&')
    .filter((p) => p !== '' && p !== 'lang' && !p.startsWith('lang='));
  return `${rest.slice(0, queryAt)}${params.length === 0 ? '' : `?${params.join('&')}`}${hash}`;
}

/** The section of the site a path belongs to: what the menu marks as the current page. */
function sectionOf(path: string): string {
  if (path === '/') return '/';
  if (path === '/cari' || path.startsWith('/cari/') || path.startsWith('/katalog/')) return '/cari';
  if (path === '/berita' || path.startsWith('/berita/')) return '/berita';
  return path;
}

/**
 * The site menu: Beranda and Katalog always, then Profil, Layanan, Berita and Kontak when their target has content
 * (the home page's blocks, a published news post), then the menu pages; each in the page's language when the request
 * named it, the one of the current path marked.
 */
export function siteMenu(locale: Locale, site: SiteInfo | undefined, pages: readonly OpacNavLink[], lang: Locale | null, path: string): FrameLink[] {
  const keep = (href: string): string => (lang === null ? href : withLang(href, lang));
  const anchor = (id: string): string => `${keep('/')}#${id}`;
  const current = sectionOf(path);
  const entries: [href: string, key: Parameters<typeof opacText>[1], section: string | null][] = [
    [keep('/'), 'shell.menu.home', '/'],
    [keep('/cari'), 'shell.menu.catalog', '/cari'],
  ];
  if (site?.profile === true) entries.push([anchor('tentang'), 'shell.menu.profile', null]);
  if (site?.services === true) entries.push([anchor('layanan'), 'shell.menu.services', null]);
  if (site?.news === true) entries.push([keep('/berita'), 'shell.menu.news', '/berita']);
  if (site?.contact === true) entries.push([anchor('kunjungi'), 'shell.menu.contact', null]);
  return [
    ...entries.map(([href, key, section]): FrameLink => ({ href, label: opacText(locale, key), current: section !== null && section === current })),
    ...pages.map((link): FrameLink => ({ href: keep(link.href), label: link.label, lang: link.lang, current: link.href === path })),
  ];
}

/** The footer of a page with `site`: the library's address and hours, its links, and the search field. */
export function siteFooter(locale: Locale, site: SiteInfo | undefined, pages: readonly OpacNavLink[], lang: Locale | null): SiteFooter {
  const keep = (href: string): string => (lang === null ? href : withLang(href, lang));
  const links: FrameLink[] = [{ href: keep('/cari'), label: opacText(locale, 'shell.menu.catalog') }];
  if (site?.profile === true) links.push({ href: `${keep('/')}#tentang`, label: opacText(locale, 'shell.footer.profile') });
  if (site?.services === true) links.push({ href: `${keep('/')}#layanan`, label: opacText(locale, 'shell.menu.services') });
  if (site?.news === true) links.push({ href: keep('/berita'), label: opacText(locale, 'shell.menu.news') });
  if (site?.contact === true) links.push({ href: `${keep('/')}#kunjungi`, label: opacText(locale, 'shell.footer.visit') });
  for (const page of pages) links.push({ href: keep(page.href), label: page.label, lang: page.lang });
  return {
    address: site?.address ?? null,
    phone: site?.phone ?? null,
    email: site?.email ?? null,
    hours: site?.hours ?? [],
    contentLang: site?.contentLang,
    links,
    search: { lang },
  };
}

/**
 * The header and footer of a catalogue page (layout.tsx PageFrame): the language switch to this path and query in each
 * language from baseUrl (on this site, root-relative, while no baseUrl is known), the brand, the site menu and the
 * footer's links in the page's language when the request named it, and the search form when `o.search`.
 */
export function pageFrame(c: Context<AppEnv>, ctx: Pick<OpacContext, 'locale' | 'baseUrl' | 'nav' | 'site' | 'year'>, o: { search: boolean }): PageFrame {
  const url = c.req.url;
  const path = keptPath(url, ctx.baseUrl);
  const here = `${origin(ctx.baseUrl)}${path}`;
  const query = keptQuery(url);
  const lang = requestLang(c);
  const langHrefs = Object.fromEntries(LOCALES.map((l) => [l, `${here}${queryWith(query, l)}`])) as Record<Locale, string>;
  const pages = ctx.nav ?? [];
  return {
    homeHref: lang === null ? '/' : `/?lang=${lang}`,
    langHrefs,
    nav: ctx.nav === undefined ? [] : siteMenu(ctx.locale, ctx.site, pages, lang, path),
    search: o.search ? { lang } : null,
    footer: siteFooter(ctx.locale, ctx.site, pages, lang),
    brand: ctx.site?.brand ?? null,
    logo: ctx.site?.logo ?? null,
    year: ctx.year,
  };
}

/**
 * The canonical link and its hreflang alternates of a page, absolute; null when the page has none (`canonicalPath:
 * null`, a page that is not a 200 and names none, or no baseUrl to make a link absolute with).
 */
function canonicalLinks(
  c: Context<AppEnv>,
  ctx: OpacContext,
  o: OpacPageOptions,
  status: number,
): { canonical: string; alternates: [hreflang: string, href: string][] } | null {
  if (o.canonicalPath === null) return null;
  if (o.canonicalPath !== undefined && !isLocalPath(o.canonicalPath)) throw new TypeError('opacPage: the canonical path must be a local path (/x)');
  if (ctx.baseUrl === '' || (o.canonicalPath === undefined && status !== 200)) return null;
  const path =
    o.canonicalPath === undefined ? `${keptPath(c.req.url, ctx.baseUrl)}${queryWith(keptQuery(c.req.url), null)}` : withoutLang(o.canonicalPath);
  const lang = requestLang(c);
  return {
    canonical: absoluteUrl(ctx.baseUrl, lang === null ? path : withLang(path, lang)),
    alternates: [...LOCALES.map((l): [string, string] => [l, absoluteUrl(ctx.baseUrl, withLang(path, l))]), ['x-default', absoluteUrl(ctx.baseUrl, path)]],
  };
}

// ---------------------------------------------------------------------------------------------------------------
// The page

/** The statuses that carry no body. */
const CONTENTLESS: ReadonlySet<number> = new Set([204, 205, 304]);

/** The robots meta content of each choice (`index` writes none). */
const ROBOTS: Readonly<Record<OpacPageOptions['robots'], string | undefined>> = {
  index: undefined,
  noindex: 'noindex',
  'noindex-follow': 'noindex, follow',
};

/** `og:locale` of each language. */
const OG_LOCALES: Readonly<Record<Locale, string>> = { id: 'id_ID', en: 'en_US' };

/**
 * Sanitized HTML on a page as it is: the one place a `SafeHtml` (from `sanitizedHtml` or `renderMarkdown`) becomes
 * markup JSX does not escape (S6). Anything else must be text, which JSX escapes.
 */
export function safeHtml(s: SafeHtml): HtmlEscapedString {
  return raw(s);
}

/**
 * `<script type="application/ld+json" nonce>` around `value` (spec §9.4, S6): its JSON written by
 * `jsonForHtmlScript`, so a `</script>` in a title stays inside the script.
 */
export function jsonLdScript(nonce: string, value: unknown): JSX.Element {
  return (
    <script type="application/ld+json" nonce={nonce}>
      {raw(jsonForHtmlScript(value))}
    </script>
  );
}

/**
 * The response of an OPAC page (see the top of this file): the frame with `o.body` in `<main>`; in `<head>` the
 * canonical and hreflang links, OpenGraph, `o.head` and the JSON-LD scripts; a fresh nonce in every script and in the
 * Content-Security-Policy.
 *
 * @throws TypeError for a status that is not 200-599, or a canonical path or OpenGraph image that is not local
 */
export function opacPage(rc: OpacResponder, ctx: OpacContext, o: OpacPageOptions): Response {
  const status = o.status ?? 200;
  if (!Number.isInteger(status) || status < 200 || status > 599 || CONTENTLESS.has(status)) {
    throw new TypeError(`opacPage: ${String(status)} is not a status a page is answered with`);
  }
  const description = o.description ?? o.title;
  const links = canonicalLinks(rc.c, ctx, o, status);
  const og = o.openGraph === false || status !== 200 ? null : (o.openGraph ?? {});
  const image = og?.image === undefined || og.image === null || ctx.baseUrl === '' ? null : absoluteUrl(ctx.baseUrl, og.image);
  const nonce = cspNonce();
  const head = (
    <>
      {links === null ? null : <link rel="canonical" href={links.canonical} />}
      {(links?.alternates ?? []).map(([hreflang, href]) => (
        <link rel="alternate" hreflang={hreflang} href={href} />
      ))}
      {og === null ? null : (
        <>
          <meta property="og:type" content={og.type ?? 'website'} />
          <meta property="og:site_name" content={ctx.libraryName} />
          <meta property="og:title" content={o.title} />
          <meta property="og:description" content={description} />
          <meta property="og:locale" content={OG_LOCALES[ctx.locale]} />
          {links === null ? null : <meta property="og:url" content={links.canonical} />}
          {image === null ? null : <meta property="og:image" content={image} />}
        </>
      )}
      {o.head?.(nonce) ?? null}
      {(o.jsonLd ?? []).map((value) => jsonLdScript(nonce, value))}
    </>
  );
  const document = toDocument(
    <Layout
      locale={ctx.locale}
      nonce={nonce}
      libraryName={ctx.libraryName}
      accent={ctx.accent}
      title={o.title}
      description={description}
      robots={ctx.indexable ? ROBOTS[o.robots] : 'noindex'}
      head={head}
      frame={{ ...pageFrame(rc.c, ctx, { search: o.headerSearch !== false }), searchBand: o.searchBand?.() }}
      hero={o.hero}
    >
      {o.body(nonce)}
    </Layout>,
  );
  return rc.c.body(document, status as ContentfulStatusCode, {
    'Content-Type': 'text/html; charset=utf-8',
    'Cache-Control': o.cacheControl ?? 'no-store',
    'Content-Security-Policy': cspHeader(nonce),
  });
}
