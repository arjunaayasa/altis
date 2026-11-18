import { sha256hex } from '@altis/core';
import { DEFAULT_ACCENT, OPAC_CSS, brandCss, isAccent } from '@altis/opac-theme';
import { COMMUNITY_SOURCE_URL, LOCALES, t, type Locale } from '@altis/shared';
import { brandRgb, phoneHref } from '@altis/shared/api/opac-home';
import { siteIconPath } from '@altis/shared/api/site-identity';
import type { Child, PropsWithChildren } from 'hono/jsx';
import { opacText } from './catalog/messages.js';
import { OPAC_SEARCH_SCOPES, type OpacSearchScope } from './catalog/search-params.js';
import { FONT_TYPE, opacFontPreloads, opacStylesheetFile } from './fonts.js';
import { Icon } from './icons.js';

// The frame of every OPAC page: `<html lang data-accent>`, the head, a skip link to the content, a thin strip with
// today's opening hours, the published telephone number and e-mail address and the language switch, the site's header
// (the library's logo or its name, the site menu, the member area's button; on a narrow screen the menu is a
// `<details>`, so it opens without a script), the page's content, and a dark footer: the library's logo, address and
// contact, its links, the member links and the opening hours, then the line "Ditenagai ALTIS Community" with the link
// to the source code (AGPL-3.0 section 13: the users of a network service are offered its source) and the staff
// sign-in, after the year and the site's name. Text goes through JSX, which escapes it, and there is no inline script,
// style attribute or event handler: the stylesheet is the one @altis/opac-theme file under a content hash, so the CSP
// needs no `unsafe-inline`; a JSON-LD script carries the response's nonce (catalog/page.tsx), which is also in
// `<meta name="csp-nonce">` like the admin's index.html. The one style element, the library colour's tokens, carries
// that nonce too and holds colours rebuilt from the colour's six hex digits, nothing else.

/** The first 10 hex digits of the SHA-256 of OPAC_CSS, computed once at module load (M30). */
export const OPAC_CSS_HASH: string = sha256hex(OPAC_CSS).slice(0, 10);

/**
 * The file name the stylesheet is served under (`opac.assets`): it changes whenever the CSS does. While the font files
 * are served the pages link the same stylesheet with the `@font-face` rules in front (fonts.ts), under a name of its own.
 */
export const OPAC_CSS_FILE = `opac-${OPAC_CSS_HASH}.css`;

/** The id of `<main>`, the skip link's target. */
export const MAIN_ID = 'isi';

/**
 * No page icon: an empty `data:` URL (the CSP's `img-src` allows `data:`), for a page shown while the icon route may
 * not answer (an update in progress). Without an icon link a browser asks for `/favicon.ico`, which ALTIS does not
 * serve, and logs the 404 as an error. Every other page links the site icon (`/site-icon/<size>.png`).
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

/**
 * The site's brand as the header and the footer show it: the site's name, and the library's logo when it has one (a
 * local path, `/files/<id>`, with its alternative text), the logo for dark backgrounds when it has that too, and
 * whether the name is printed beside the logo (for a logo that is only a mark).
 */
export interface SiteLogo {
  src: string;
  alt: string;
  /** The logo for dark backgrounds; null or absent: the main logo on a small white plate there. */
  dark?: string | null | undefined;
  /** Print the site's name beside the logo. */
  showName?: boolean | undefined;
}

/** What the strip above the header says of today: open with these hours, or closed. */
export interface TodayHours {
  open: boolean;
  /** The hours (`14.00–18.00`); '' when closed. */
  time: string;
}

/** The footer's blocks of a catalogue page; each left out when it has nothing to show. */
export interface SiteFooter {
  /** The library's address (line breaks kept), or null. */
  address: string | null;
  /** The published telephone number and e-mail address, each null when there is none. */
  phone?: string | null | undefined;
  email?: string | null | undefined;
  /** The site's tagline in the page's language, or null. */
  tagline?: string | null | undefined;
  /** The tagline's language when it is not the page's. */
  taglineLang?: Locale | undefined;
  /** The opening hours, one row per group of days; none: no hours block. */
  hours: readonly { days: string; time: string }[];
  /** The language of the address and the hours when it is not the page's. */
  contentLang?: Locale | undefined;
  /** The links: the catalogue, the advanced search, the profile, the news, the published menu pages. */
  links: readonly FrameLink[];
  /** The member links: the member area, how to become a member. */
  member: readonly FrameLink[];
  /** The news feed's address, or null without news. */
  feed?: string | null | undefined;
}

/**
 * What the catalogue's pages add to the bare frame (catalog/page.tsx `pageFrame`): links built from config.baseUrl and
 * the normalised request path (S7), the site menu, the search band, and the footer's blocks. Without it a page keeps
 * the bare header and footer: relative `?lang=` links (the same path on this site), no menu, no search form, only the
 * footer's bottom line.
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
  /** The footer's blocks; absent: the bottom line only. */
  footer?: SiteFooter | undefined;
  /** The library's colour (`#rrggbb`); null or absent: the accent's. */
  brand?: string | null | undefined;
  /** The page's own search form for the search band, in place of `search`'s. */
  searchBand?: Child;
  /** The library's logo in the header and the footer; null or absent: the site's name as text. */
  logo?: SiteLogo | null | undefined;
  /** The year of the footer's line (the request's, in the library's time zone). */
  year?: number | undefined;
  /** Today's opening hours for the strip above the header; null or absent: not said. */
  today?: TodayHours | null | undefined;
  /** The published telephone number and e-mail address for that strip. */
  phone?: string | null | undefined;
  email?: string | null | undefined;
  /** The member area's address (in the page's language when the request named it). */
  accountHref?: string | undefined;
}

/** The library colour as the style element takes it: rebuilt from its channels; null when it is not a `#rrggbb`. */
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
const LANGUAGE_NAMES: Readonly<Record<Locale, string>> = { id: 'Indonesia', en: 'English' };

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
  /** A band across the window above the content, inside `<main>` (a page head, see {@link PageHead}). */
  pageHead?: Child;
  /** The content spans the window (a page made of bands, each with its own `.wrap`); default: one `.wrap`. */
  bleed?: boolean | undefined;
}

/**
 * A search form: GET /cari with a labelled `q`, and the page's `lang` when it came from the query, so that the results
 * stay in that language. `scope`: the field choice (`ruas`) joined to the text, the one given selected. `label`: the
 * label is shown above the field (the home page); otherwise it is for screen readers only.
 */
export function SearchForm(props: { locale: Locale; lang: Locale | null; id: string; label?: boolean; scope?: OpacSearchScope; text?: string; maxlength?: number }) {
  const { locale, lang, id } = props;
  return (
    <form class="search-box" role="search" method="get" action="/cari">
      <label for={id} class={props.label === true ? 'search-label' : 'visually-hidden'}>
        {opacText(locale, 'shell.search.label')}
      </label>
      <span class="search-row">
        <span class="search-join">
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
          <input id={id} type="search" name="q" value={props.text} maxlength={props.maxlength ?? 500} placeholder={opacText(locale, 'shell.search.placeholder')} />
        </span>
        {lang === null ? null : <input type="hidden" name="lang" value={lang} />}
        <button type="submit" class="btn btn-primary">
          <Icon name="search" />
          {opacText(locale, 'shell.search.submit')}
        </button>
      </span>
    </form>
  );
}

/**
 * The site's brand: the logo, 40 px high with its width following it, or the site's name as plain text when the
 * library has no logo. With a logo for dark backgrounds a `<picture>` picks it in the dark scheme (`dark` true: always,
 * the footer); without one the main logo stands on a small white plate wherever the background is dark.
 */
function Brand(props: { logo: SiteLogo | null; name: string; href: string; dark?: boolean }) {
  const { logo, name } = props;
  if (logo === null) {
    return (
      <a class="sitelogo" href={props.href}>
        <span class="sitename">{name}</span>
      </a>
    );
  }
  const other = logo.dark ?? null;
  const height = props.dark === true ? 36 : 40;
  return (
    <a class="sitelogo" href={props.href}>
      {other === null ? (
        <img class={props.dark === true ? 'logo-plate logo-plate-on' : 'logo-plate'} src={logo.src} alt={logo.alt} height={height} decoding="async" />
      ) : props.dark === true ? (
        <img src={other} alt={logo.alt} height={height} decoding="async" />
      ) : (
        <picture>
          <source srcset={other} media="(prefers-color-scheme: dark)" />
          <img src={logo.src} alt={logo.alt} height={height} decoding="async" />
        </picture>
      )}
      {logo.showName === true ? <span class="sitename">{name}</span> : null}
    </a>
  );
}

const present = (value: string | null | undefined): string | null => (value === null || value === undefined || value.trim() === '' ? null : value.trim());

/** The published telephone number and e-mail address as links, each with its word; nothing without either. */
export function ContactLines(props: { locale: Locale; phone: string | null | undefined; email: string | null | undefined; class: string }) {
  const { locale } = props;
  const phone = present(props.phone);
  const email = present(props.email);
  if (phone === null && email === null) return null;
  return (
    <p class={props.class}>
      {phone === null ? null : (
        <span>
          {opacText(locale, 'shell.contact.phone')} <a href={phoneHref(phone)}>{phone}</a>
        </span>
      )}
      {email === null ? null : (
        <span>
          {opacText(locale, 'shell.contact.email')} <a href={`mailto:${email}`}>{email}</a>
        </span>
      )}
    </p>
  );
}

/** One step of a page's breadcrumb: a link, or (the last one) the page itself. */
export interface Crumb {
  label: string;
  href?: string | undefined;
  lang?: Locale | undefined;
}

/**
 * A page's head, a band in the second layer across the window: the breadcrumb, then (unless `title` is left out, for
 * a page whose heading stands in its content) the page's heading and one sentence under it.
 */
export function PageHead(props: { locale: Locale; crumbs: readonly Crumb[]; title?: string | undefined; lead?: string | undefined; titleLang?: Locale | undefined }) {
  const { locale, crumbs } = props;
  return (
    <div class={props.title === undefined ? 'pagehead pagehead-slim' : 'pagehead'}>
      <div class="wrap">
        <nav class="crumbs" aria-label={opacText(locale, 'shell.crumbs.label')}>
          <ol>
            {crumbs.map((crumb, i) => (
              <li lang={crumb.lang}>
                {i === 0 ? null : <Icon name="right" />}
                {crumb.href === undefined ? <span aria-current={i === crumbs.length - 1 ? 'page' : undefined}>{crumb.label}</span> : <a href={crumb.href}>{crumb.label}</a>}
              </li>
            ))}
          </ol>
        </nav>
        {props.title === undefined ? null : <h1 lang={props.titleLang}>{props.title}</h1>}
        {props.lead === undefined ? null : <p class="pagehead-lead">{props.lead}</p>}
      </div>
    </div>
  );
}

/**
 * The footer: the library's blocks when the page has them (`footer`), then the line with the year and the site's
 * name, the software, the source code, the news feed and the staff link.
 */
function Footer(props: { locale: Locale; name: string; home: string; footer: SiteFooter | undefined; logo: SiteLogo | null; year: number }) {
  const { locale, name, footer, logo } = props;
  const phone = present(footer?.phone);
  const email = present(footer?.email);
  return (
    <footer class="site-footer">
      {footer === undefined ? null : (
        <div class="wrap foot-cols">
          <div class="foot-block foot-about">
            <Brand logo={logo} name={name} href={props.home} dark />
            {present(footer.tagline) === null ? null : <p class="foot-tagline" lang={footer.taglineLang}>{footer.tagline}</p>}
            {footer.address === null ? null : (
              <p class="foot-address" lang={footer.contentLang}>
                {footer.address}
              </p>
            )}
            {phone === null && email === null ? null : (
              <p class="foot-contact">
                {phone === null ? null : <a href={phoneHref(phone)}>{phone}</a>}
                {email === null ? null : <a href={`mailto:${email}`}>{email}</a>}
              </p>
            )}
          </div>
          {/* Lists under their headings, not more navigation landmarks: the header's menu is the site's. */}
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
          <div class="foot-block">
            <h2>{opacText(locale, 'shell.footer.member')}</h2>
            <ul class="foot-links">
              {footer.member.map((link) => (
                <li>
                  <a href={link.href}>{link.label}</a>
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
        </div>
      )}
      <div class="foot-bottom">
        <div class="wrap">
          <span>{`© ${props.year} ${name}`}</span>
          <span>{opacText(locale, 'shell.footer.powered')}</span>
          <a href={COMMUNITY_SOURCE_URL} rel="noopener">
            {opacText(locale, 'shell.footer.source')}
          </a>
          {footer?.feed === undefined || footer.feed === null ? null : (
            <a href={footer.feed} type="application/rss+xml">
              {opacText(locale, 'shell.footer.feed')}
            </a>
          )}
          <a class="foot-staff" href="/admin/login">
            {t(locale, 'opac.home.staff_login')}
          </a>
        </div>
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
  const brand = brandColor(frame?.brand);
  const logo = frame?.logo ?? null;
  const name = libraryName ?? t(locale, 'opac.home.title');
  const home = frame?.homeHref ?? '/';
  const account = frame?.accountHref ?? '/akun';
  const phone = present(frame?.phone);
  const email = present(frame?.email);
  const today = frame?.today ?? null;
  const menu = (
    <>
      {nav.map((link) => (
        <a href={link.href} lang={link.lang} aria-current={link.current === true ? 'page' : undefined}>
          {link.label}
        </a>
      ))}
    </>
  );
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
        {/* The site icon (the library's own, or the built-in one) on a page of the running site; a bare page (an error,
            maintenance) may be shown while that route cannot answer, and names no icon. */}
        {frame === undefined ? <link rel="icon" href={NO_ICON} /> : null}
        {frame === undefined ? null : <link rel="icon" type="image/png" sizes="32x32" href={siteIconPath(32)} />}
        {frame === undefined ? null : <link rel="icon" type="image/png" sizes="192x192" href={siteIconPath(192)} />}
        {frame === undefined ? null : <link rel="apple-touch-icon" href={siteIconPath(180)} />}
        {/* The typeface (fonts.ts): only while its files are served. A font is fetched without credentials, hence `crossorigin`. */}
        {opacFontPreloads().map((file) => (
          <link rel="preload" as="font" type={FONT_TYPE} href={`/assets/${file}`} crossorigin="anonymous" />
        ))}
        <link rel="stylesheet" href={`/assets/${opacStylesheetFile(OPAC_CSS_FILE)}`} />
        {brand === null ? null : <style nonce={nonce}>{brandCss(brand)}</style>}
        {props.head ?? null}
      </head>
      <body>
        <a class="skip-link" href={`#${MAIN_ID}`}>
          {opacText(locale, 'shell.skip_link')}
        </a>
        <div class="topstrip">
          <div class="wrap">
            {today === null ? null : (
              <span class="top-today">
                <span class={today.open ? 'open-dot' : 'open-dot open-dot-off'} aria-hidden="true"></span>
                {today.open ? opacText(locale, 'shell.top.open', { time: today.time }) : opacText(locale, 'shell.top.closed')}
              </span>
            )}
            {phone === null ? null : (
              <span class="hide-s">
                <Icon name="phone" />
                <a href={phoneHref(phone)} aria-label={`${opacText(locale, 'shell.contact.phone')} ${phone}`}>
                  {phone}
                </a>
              </span>
            )}
            {email === null ? null : (
              <span class="hide-s">
                <Icon name="mail" />
                <a href={`mailto:${email}`} aria-label={`${opacText(locale, 'shell.contact.email')} ${email}`}>
                  {email}
                </a>
              </span>
            )}
            <nav class="lang" aria-label={t(locale, 'opac.lang.switch')}>
              {LOCALES.map((l) => (
                <a href={frame?.langHrefs[l] ?? `?lang=${l}`} hreflang={l} lang={l} aria-current={l === locale ? 'true' : undefined}>
                  {LANGUAGE_NAMES[l]}
                </a>
              ))}
            </nav>
          </div>
        </div>
        <header class="site-header">
          <div class="wrap">
            <Brand logo={logo} name={name} href={home} />
            {nav.length === 0 ? null : (
              <nav class="mainnav" aria-label={opacText(locale, 'shell.nav.label')}>
                {menu}
              </nav>
            )}
            <div class="head-actions">
              {/* The member area: a static link; the page never reads a member session for it. */}
              <a class={nav.length === 0 ? 'btn btn-outline btn-sm akun-link' : 'btn btn-outline btn-sm akun-link hide-s'} href={account}>
                <Icon name="user" />
                {opacText(locale, 'akun.header.link')}
              </a>
              {/* On a narrow screen the menu is this `<details>`: it opens without a script. */}
              {nav.length === 0 ? null : (
                <details class="mobnav">
                  <summary aria-label={opacText(locale, 'shell.nav.open')}>
                    <Icon name="menu" />
                  </summary>
                  <nav aria-label={opacText(locale, 'shell.nav.label_mobile')}>
                    {menu}
                    <a href={account}>{opacText(locale, 'akun.header.link')}</a>
                  </nav>
                </details>
              )}
            </div>
          </div>
        </header>
        {frame?.searchBand !== undefined ? (
          <div class="search-band">
            <div class="wrap">{frame.searchBand}</div>
          </div>
        ) : search === null ? null : (
          <div class="search-band">
            <div class="wrap">
              <SearchForm locale={locale} lang={search.lang} id="cari-situs" scope="semua" />
            </div>
          </div>
        )}
        <main id={MAIN_ID} tabindex={-1}>
          {props.pageHead ?? null}
          {props.bleed === true ? children : <div class="wrap page">{children}</div>}
        </main>
        <Footer locale={locale} name={name} home={home} footer={frame?.footer} logo={logo} year={frame?.year ?? new Date().getUTCFullYear()} />
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
