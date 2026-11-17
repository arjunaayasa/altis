import { sha256hex } from '@altis/core';
import { DEFAULT_ACCENT, OPAC_CSS, isAccent } from '@altis/opac-theme';
import { COMMUNITY_SOURCE_URL, LOCALES, t, type Locale } from '@altis/shared';
import { OPAC_HOME_OVERLAY, brandRgb } from '@altis/shared/api/opac-home';
import type { Child, PropsWithChildren } from 'hono/jsx';
import { opacText } from './catalog/messages.js';
import { OPAC_SEARCH_SCOPES, type OpacSearchScope } from './catalog/search-params.js';

// The frame of every OPAC page (spec §4.9, §7.4, §9.2, decision D30; Phase 2 Task 21): `<html lang data-accent>`, the
// head, a skip link to the content, a header bar in the library's colour with the library name, the member area link,
// the language switch and (for the catalogue's pages) the site menu (on a narrow screen one "Katalog" link) and a
// search band, and a dark footer: for the catalogue's pages the library's address, its links, opening hours and a
// search field, on every page the line "Ditenagai ALTIS Community" with the link to the source code (AGPL-3.0 section
// 13: the users of a network service are offered its source) and the staff sign-in. Text goes through JSX, which escapes it, and
// there is no inline script, style attribute or event handler: the stylesheet is the one @altis/opac-theme file under
// a content hash, so the CSP needs no `unsafe-inline`; a JSON-LD script carries the response's nonce (catalog/page.tsx),
// which is also in `<meta name="csp-nonce">` like the admin's index.html. The one style element, the library colour of
// the header bar, carries that nonce too and holds a colour rebuilt from its six hex digits, nothing else.

/** The first 10 hex digits of the SHA-256 of OPAC_CSS, computed once at module load (M30). */
export const OPAC_CSS_HASH: string = sha256hex(OPAC_CSS).slice(0, 10);

/** The file name the stylesheet is served under (`opac.assets`): it changes whenever the CSS does. */
export const OPAC_CSS_FILE = `opac-${OPAC_CSS_HASH}.css`;

/** The id of `<main>`, the skip link's target. */
export const MAIN_ID = 'isi';

/**
 * The page icon: an empty `data:` URL (the CSP's `img-src` allows `data:`). Without an icon link a browser asks for
 * `/favicon.ico`, which ALTIS does not serve, and logs the 404 as an error on every first page load.
 */
export const NO_ICON = 'data:,';

/** One link of the menu: a local path and its label (`lang` when the label is not in the page's language). */
export interface FrameLink {
  href: string;
  label: string;
  lang?: Locale | undefined;
  /** The link of the page (or the section of the site) being shown: `aria-current="page"`. */
  current?: boolean | undefined;
}

/** The footer's blocks of a catalogue page; each left out when it has nothing to show. */
export interface SiteFooter {
  /** The library's address (line breaks kept), or null. */
  address: string | null;
  /** The opening hours, one row per group of days; none: no hours block. */
  hours: readonly { days: string; time: string }[];
  /** The language of the address and the hours when it is not the page's. */
  contentLang?: Locale | undefined;
  /** The links: the catalogue, the home page's profile blocks with content, the news, the published menu pages. */
  links: readonly FrameLink[];
  /** The footer's search field to /cari, with the `lang` it keeps. */
  search: { lang: Locale | null };
}

/**
 * What the catalogue's pages add to the 1b frame (Phase 2 Task 21, catalog/page.tsx `pageFrame`): links built from
 * config.baseUrl and the normalised request path (S7), the site menu, the search band, and the footer's blocks.
 * Without it a page keeps the 1b header and footer: relative `?lang=` links (the same path on this site), no menu, no
 * search form, only the footer's bottom line.
 */
export interface PageFrame {
  /** The brand link (the home page, in the page's language when it came from `?lang=`). */
  homeHref: string;
  /** The language switch: each language's link to this page with its query. */
  langHrefs: Readonly<Record<Locale, string>>;
  /** The site menu (none: no menu). */
  nav: readonly FrameLink[];
  /** The search band to /cari, with the `lang` it keeps; null: none. */
  search: { lang: Locale | null } | null;
  // ---- Komunitas (OPAC look) ----
  /** The footer's blocks; absent: the bottom line only. */
  footer?: SiteFooter | undefined;
  /** The library's colour of the header bar (`#rrggbb`); null or absent: the accent's. */
  brand?: string | null | undefined;
  /** The page's own search form for the search band, in place of `search`'s. */
  searchBand?: Child;
}

// ---- Komunitas (OPAC home page) ----
/**
 * The home page's hero: the header becomes a band of the library's photo under an even dark overlay (or of the library
 * colour without one), with the site menu over it and the page's heading and lead sentence below the menu. Its text
 * is white on at least 4.5:1 whatever the photo (the overlay's floor), and the photo sits absolutely in the band, so
 * its arrival moves nothing.
 */
export interface HeroBand {
  title: string;
  /** The heading's language when it is not the page's (the other language's text shown in its place). */
  titleLang?: Locale | undefined;
  /** The lead sentence (line breaks kept), or null. */
  lead: string | null;
  /** The lead's language when it is not the page's. */
  leadLang?: Locale | undefined;
  /**
   * A local path (`/files/<id>`), its alternative text, its vertical position (0-100, steps of 10) and the darkness of
   * its overlay (percent, 60-80 in steps of 5); null: none.
   */
  photo: { src: string; alt: string; position: number; overlay: number; width: number; height: number } | null;
  /** The band's colour without a photo (`#rrggbb`); null: the accent's. */
  brand?: string | null | undefined;
}

/** The position class of a photo: its position rounded to a step of 10 within 0-100. */
function heroPosition(position: number): number {
  const p = Number.isFinite(position) ? Math.round(position / 10) * 10 : 50;
  return Math.min(100, Math.max(0, p));
}

/** The overlay class of a photo: its darkness rounded to a step within the setting's range (never under its floor). */
function heroOverlay(overlay: number): number {
  const { min, max, step } = OPAC_HOME_OVERLAY;
  const o = Number.isFinite(overlay) ? Math.round(overlay / step) * step : OPAC_HOME_OVERLAY.default;
  return Math.min(max, Math.max(min, o));
}

/** The library colour as the style element writes it: rebuilt from its channels; null when it is not a `#rrggbb`. */
function brandColor(value: string | null | undefined): string | null {
  const rgb = brandRgb(value);
  return rgb === null ? null : `#${rgb.map((c) => c.toString(16).padStart(2, '0')).join('')}`;
}

/** What every `render*` function takes besides its own fields. */
export interface PageOptions {
  locale: Locale;
  /** The nonce of the response's Content-Security-Policy (cspNonce()). */
  nonce: string;
  /** The library's name when it is known; the pages call themselves "Katalog"/"Catalogue" without one. */
  libraryName?: string | undefined;
  /** One of the six accents; anything else (or nothing) is the default. */
  accent?: string | undefined;
  /** Phase 2 Task 21: the catalogue's header (see PageFrame); absent: the 1b header. */
  frame?: PageFrame | undefined;
}

/** A language's name in that language: it is the same whatever language the page is in, so not a message key. */
const LANGUAGE_NAMES: Readonly<Record<Locale, string>> = { id: 'Bahasa Indonesia', en: 'English' };

/** The seconds `<meta http-equiv="refresh">` may ask for: a retry sooner than 5 s is a flood, later than 1 h is forgotten. */
const MIN_REFRESH_S = 5;
const MAX_REFRESH_S = 3600;

/** The refresh interval for a `Retry-After` of `s` seconds, or undefined when there is none worth asking for. */
function refreshSeconds(s: number | undefined): number | undefined {
  if (s === undefined || !Number.isFinite(s) || s <= 0) return undefined;
  return Math.min(MAX_REFRESH_S, Math.max(MIN_REFRESH_S, Math.ceil(s)));
}

export interface LayoutProps extends PageOptions {
  /** The `<title>`. */
  title: string;
  /** The meta description. */
  description: string;
  /** False (the default is true) for the pages a search engine has no use for: 404, 500, maintenance. */
  indexable?: boolean;
  /** Ask the browser to load the page again after this many seconds (the maintenance page). */
  retryAfterS?: number | undefined;
  /**
   * Phase 2 Task 3 (the catalogue's `opacPage`): the robots meta's content when there is one (`noindex`,
   * `noindex, follow`); it replaces what `indexable` would write.
   */
  robots?: string | undefined;
  /** Phase 2 Task 3: more of `<head>` after the stylesheet (the canonical link, JSON-LD scripts with the nonce). */
  head?: Child;
  // ---- Komunitas (OPAC home page) ----
  /** The home page's hero band (see HeroBand); absent: the plain header. */
  hero?: HeroBand | undefined;
}

/**
 * A search form: GET /cari with a labelled `q`, and the page's `lang` when it came from the query, so that the results
 * stay in that language. `scope`: the field choice (`ruas`) before the text, the one given selected.
 */
export function SearchForm(props: { locale: Locale; lang: Locale | null; id: string; hero?: boolean; scope?: OpacSearchScope; footer?: boolean }) {
  const { locale, lang, id } = props;
  return (
    <form class={props.hero === true ? 'search-box search-hero' : 'search-box'} role="search" method="get" action="/cari">
      {props.hero === true ? (
        <label for={id}>{opacText(locale, 'shell.search.label')}</label>
      ) : (
        <label for={id} class="visually-hidden">
          {opacText(locale, 'shell.search.label')}
        </label>
      )}
      <span class="search-row">
        {props.scope === undefined ? null : (
          <>
            <label for={`${id}-ruas`} class="visually-hidden">
              {opacText(locale, 'search.scope.label')}
            </label>
            <select id={`${id}-ruas`} name="ruas">
              {OPAC_SEARCH_SCOPES.map((s) => (
                <option value={s} selected={s === props.scope}>
                  {opacText(locale, `search.scope.${s}`)}
                </option>
              ))}
            </select>
          </>
        )}
        <input
          id={id}
          type="search"
          name="q"
          maxlength={500}
          placeholder={opacText(locale, props.footer === true ? 'shell.footer.search_placeholder' : 'shell.search.placeholder')}
        />
        {lang === null ? null : <input type="hidden" name="lang" value={lang} />}
        <button type="submit">{opacText(locale, 'shell.search.submit')}</button>
      </span>
    </form>
  );
}

/** The footer: the library's blocks when the page has them (`footer`), then the software's line and the staff link. */
function Footer(props: { locale: Locale; libraryName: string | undefined; footer: SiteFooter | undefined }) {
  const { locale, libraryName, footer } = props;
  return (
    <footer class="site-footer">
      {footer === undefined ? null : (
        <div class="foot-grid">
          {footer.address === null || libraryName === undefined ? null : (
            <div class="foot-block">
              <h2>{libraryName}</h2>
              <p class="foot-address" lang={footer.contentLang}>
                {footer.address}
              </p>
            </div>
          )}
          {/* A list under its heading, not a second navigation landmark: the header's menu is the site's. */}
          <div class="foot-block">
            <h2>{opacText(locale, 'shell.footer.links')}</h2>
            <ul class="foot-links">
              {footer.links.map((link) => (
                <li>
                  <a href={link.href} lang={link.lang}>
                    {link.label}
                  </a>
                </li>
              ))}
            </ul>
          </div>
          {footer.hours.length === 0 ? null : (
            <div class="foot-block">
              <h2 id="kaki-jam">{opacText(locale, 'shell.footer.hours')}</h2>
              <table class="foot-hours" aria-labelledby="kaki-jam">
                <tbody lang={footer.contentLang}>
                  {footer.hours.map((h) => (
                    <tr>
                      <th scope="row">{h.days}</th>
                      <td>{h.time}</td>
                    </tr>
                  ))}
                </tbody>
              </table>
            </div>
          )}
          <div class="foot-block foot-search">
            <h2>{opacText(locale, 'shell.footer.search')}</h2>
            <SearchForm locale={locale} lang={footer.search.lang} id="cari-kaki" footer />
          </div>
        </div>
      )}
      <div class="foot-bottom">
        <p>
          <span>{opacText(locale, 'shell.footer.powered')}</span>
          <a href={COMMUNITY_SOURCE_URL} rel="noopener">
            {opacText(locale, 'shell.footer.source')}
          </a>
        </p>
        <p>
          <a href="/admin/login">{t(locale, 'opac.home.staff_login')}</a>
        </p>
      </div>
    </footer>
  );
}

export function Layout(props: PropsWithChildren<LayoutProps>) {
  const { locale, nonce, title, description, libraryName, frame, children } = props;
  const accent = isAccent(props.accent) ? props.accent : DEFAULT_ACCENT;
  const refresh = refreshSeconds(props.retryAfterS);
  const robots = props.robots ?? (props.indexable === false ? 'noindex' : undefined);
  const nav = frame?.nav ?? [];
  const search = frame?.search ?? null;
  // ---- Komunitas (OPAC home page) ----
  const hero = props.hero;
  const headerClass =
    hero === undefined ? 'site-header' : hero.photo === null ? 'site-header hero-band' : `site-header hero-band hero-photo hero-ov-${heroOverlay(hero.photo.overlay)}`;
  const brand = brandColor(hero?.brand ?? frame?.brand);
  // The home link is `/` or `/?lang=xx`: the catalogue's is the same with `/cari`.
  const catalogHref = frame === undefined ? null : `/cari${frame.homeHref.slice(1)}`;
  return (
    <html lang={locale} data-accent={accent}>
      <head>
        <meta charset="utf-8" />
        <meta name="viewport" content="width=device-width, initial-scale=1" />
        <meta name="color-scheme" content="light dark" />
        <meta name="description" content={description} />
        <meta name="csp-nonce" content={nonce} />
        {robots === undefined ? null : <meta name="robots" content={robots} />}
        {refresh === undefined ? null : <meta http-equiv="refresh" content={String(refresh)} />}
        <title>{title}</title>
        <link rel="icon" href={NO_ICON} />
        <link rel="stylesheet" href={`/assets/${OPAC_CSS_FILE}`} />
        {brand === null ? null : <style nonce={nonce}>{`.site-header{--hero-bg:${brand}}`}</style>}
        {props.head ?? null}
      </head>
      <body>
        <a class="skip-link" href={`#${MAIN_ID}`}>
          {opacText(locale, 'shell.skip_link')}
        </a>
        <header class={headerClass}>
          {hero === undefined || hero.photo === null ? null : (
            <img
              class={`hero-img hero-pos-${heroPosition(hero.photo.position)}`}
              src={hero.photo.src}
              alt={hero.photo.alt}
              width={hero.photo.width}
              height={hero.photo.height}
              decoding="async"
            />
          )}
          <div class="bar">
            <a class="brand" href={frame?.homeHref ?? '/'}>
              {libraryName ?? t(locale, 'opac.home.title')}
            </a>
            {nav.length === 0 ? null : (
              <nav class="menu" aria-label={opacText(locale, 'shell.nav.label')}>
                <ul>
                  {nav.map((link) => (
                    <li>
                      <a href={link.href} lang={link.lang} aria-current={link.current === true ? 'page' : undefined}>
                        {link.label}
                      </a>
                    </li>
                  ))}
                </ul>
              </nav>
            )}
            {/* On a narrow screen the menu gives way to this one link to the catalogue (the footer keeps the others). */}
            {nav.length === 0 || catalogHref === null ? null : (
              <a class="nav-catalog" href={catalogHref}>
                {opacText(locale, 'shell.menu.catalog')}
              </a>
            )}
            {/* Komunitas (member area): a static link; the page never reads a member session for it. */}
            <a class="akun-link" href="/akun">
              {opacText(locale, 'akun.header.link')}
            </a>
            <nav class="lang" aria-label={t(locale, 'opac.lang.switch')}>
              {LOCALES.map((l) => (
                <a href={frame?.langHrefs[l] ?? `?lang=${l}`} hreflang={l} lang={l} aria-current={l === locale ? 'true' : undefined}>
                  {LANGUAGE_NAMES[l]}
                </a>
              ))}
            </nav>
          </div>
          {frame?.searchBand !== undefined ? (
            <div class="search-band">
              <div class="bar bar-tools">{frame.searchBand}</div>
            </div>
          ) : search === null ? null : (
            <div class="search-band">
              <div class="bar bar-tools">
                <SearchForm locale={locale} lang={search.lang} id="cari-situs" scope="semua" />
              </div>
            </div>
          )}
          {hero === undefined ? null : (
            <div class="hero-text">
              <h1 lang={hero.titleLang}>{hero.title}</h1>
              {hero.lead === null ? null : (
                <p class="hero-lead" lang={hero.leadLang}>
                  {hero.lead}
                </p>
              )}
            </div>
          )}
        </header>
        <main id={MAIN_ID} tabindex={-1}>
          {children}
        </main>
        <Footer locale={locale} libraryName={libraryName} footer={frame?.footer} />
      </body>
    </html>
  );
}

/** The document of a rendered page: the doctype (JSX has none) and the markup as one string. */
export function toDocument(page: { toString(): unknown }): string {
  const markup = page.toString();
  if (typeof markup !== 'string') throw new TypeError('toDocument: an OPAC page must render synchronously');
  return `<!DOCTYPE html>${markup}`;
}
