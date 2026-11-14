import { sha256hex } from '@altis/core';
import { DEFAULT_ACCENT, OPAC_CSS, isAccent } from '@altis/opac-theme';
import { COMMUNITY_SOURCE_URL, LOCALES, t, type Locale } from '@altis/shared';
import type { Child, PropsWithChildren } from 'hono/jsx';
import { opacText } from './catalog/messages.js';

// The frame of every OPAC page (spec §4.9, §7.4, §9.2, decision D30; Phase 2 Task 21): `<html lang data-accent>`, the
// head, a skip link to the content, a header with the library name, the language switch and (for the catalogue's
// pages) the menu and a search form, a footer with the staff sign-in and the link to the source code (AGPL-3.0
// section 13: the users of a network service are offered its source). Text goes through JSX, which escapes it, and
// there is no inline script, style or event handler: the stylesheet is the one @altis/opac-theme file under a content
// hash, so the CSP needs no `unsafe-inline`; a JSON-LD script carries the response's nonce (catalog/page.tsx), which
// is also in `<meta name="csp-nonce">` like the admin's index.html.

/** The first 10 hex digits of the SHA-256 of OPAC_CSS, computed once at module load (M30). */
export const OPAC_CSS_HASH: string = sha256hex(OPAC_CSS).slice(0, 10);

/** The file name the stylesheet is served under (`opac.assets`): it changes whenever the CSS does. */
export const OPAC_CSS_FILE = `opac-${OPAC_CSS_HASH}.css`;

/** The id of `<main>`, the skip link's target. */
export const MAIN_ID = 'isi';

/** One link of the menu: a local path and its label (`lang` when the label is not in the page's language). */
export interface FrameLink {
  href: string;
  label: string;
  lang?: Locale | undefined;
}

/**
 * What the catalogue's pages add to the 1b frame (Phase 2 Task 21, catalog/page.tsx `pageFrame`): links built from
 * config.baseUrl and the normalised request path (S7), the menu, and the search form. Without it a page keeps the 1b
 * header: relative `?lang=` links (the same path on this site), no menu, no search form.
 */
export interface PageFrame {
  /** The brand link (the home page, in the page's language when it came from `?lang=`). */
  homeHref: string;
  /** The language switch: each language's link to this page with its query. */
  langHrefs: Readonly<Record<Locale, string>>;
  /** The menu pages (none: no menu). */
  nav: readonly FrameLink[];
  /** The search form to /cari, with the `lang` it keeps; null: none. */
  search: { lang: Locale | null } | null;
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
}

/**
 * The search form of the header (and of the home page, `id` and `hero` apart): GET /cari with a labelled `q`, and the
 * page's `lang` when it came from the query, so that the results stay in that language.
 */
export function SearchForm(props: { locale: Locale; lang: Locale | null; id: string; hero?: boolean }) {
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
        <input id={id} type="search" name="q" maxlength={500} placeholder={opacText(locale, 'shell.search.placeholder')} />
        {lang === null ? null : <input type="hidden" name="lang" value={lang} />}
        <button type="submit">{opacText(locale, 'shell.search.submit')}</button>
      </span>
    </form>
  );
}

export function Layout(props: PropsWithChildren<LayoutProps>) {
  const { locale, nonce, title, description, libraryName, frame, children } = props;
  const accent = isAccent(props.accent) ? props.accent : DEFAULT_ACCENT;
  const refresh = refreshSeconds(props.retryAfterS);
  const robots = props.robots ?? (props.indexable === false ? 'noindex' : undefined);
  const nav = frame?.nav ?? [];
  const search = frame?.search ?? null;
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
        <link rel="stylesheet" href={`/assets/${OPAC_CSS_FILE}`} />
        {props.head ?? null}
      </head>
      <body>
        <a class="skip-link" href={`#${MAIN_ID}`}>
          {opacText(locale, 'shell.skip_link')}
        </a>
        <header class="site-header">
          <div class="bar">
            <a class="brand" href={frame?.homeHref ?? '/'}>
              {libraryName ?? t(locale, 'opac.home.title')}
            </a>
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
          {nav.length === 0 && search === null ? null : (
            <div class="bar bar-tools">
              {nav.length === 0 ? null : (
                <nav class="menu" aria-label={opacText(locale, 'shell.nav.label')}>
                  <ul>
                    {nav.map((link) => (
                      <li>
                        <a href={link.href} lang={link.lang}>
                          {link.label}
                        </a>
                      </li>
                    ))}
                  </ul>
                </nav>
              )}
              {search === null ? null : <SearchForm locale={locale} lang={search.lang} id="cari-situs" />}
            </div>
          )}
        </header>
        <main id={MAIN_ID} tabindex={-1}>
          {children}
        </main>
        <footer class="site-footer">
          <div class="bar">
            <a href="/admin/login">{t(locale, 'opac.home.staff_login')}</a>
            <a href={COMMUNITY_SOURCE_URL} rel="noopener">
              {opacText(locale, 'shell.footer.source')}
            </a>
          </div>
        </footer>
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
