import { DEFAULT_ACCENT } from '@altis/opac-theme';
import { resolveLocale, t, type Locale } from '@altis/shared';
import type { Context } from 'hono';
import { Fragment, jsx } from 'hono/jsx';
import type { JSX } from 'hono/jsx/jsx-runtime';
import type { ContentfulStatusCode } from 'hono/utils/http-status';
import type { AppEnv } from '../../http/request-id.js';
import { opacText } from './messages.js';
import { opacPage } from './page.js';
import { isLocalPath } from './urls.js';

// The OPAC's answers that are not a page of its own (Phase 2 Task 3): XML (sitemaps, feeds, OAI-PMH, MARCXML), text
// (robots.txt, RIS, BibTeX), a permanent redirect to a local path (S7), and the status page a browser gets for an
// error (S17; app.ts failure()). Task 21 renders the status page in the complete frame of `opacPage` (skip link,
// search form, a language switch that keeps the path) with the same signature.

/** `xml` with `status`, as `application/xml` in UTF-8, with the `Cache-Control` given. */
export function xmlResponse(c: Context<AppEnv>, status: number, xml: string, cacheControl: string): Response {
  return c.body(xml, status as ContentfulStatusCode, { 'Content-Type': 'application/xml; charset=utf-8', 'Cache-Control': cacheControl });
}

/** `text` with `status`, as `text/plain` in UTF-8, with the `Cache-Control` given. */
export function textResponse(c: Context<AppEnv>, status: number, text: string, cacheControl: string): Response {
  return c.body(text, status as ContentfulStatusCode, { 'Content-Type': 'text/plain; charset=utf-8', 'Cache-Control': cacheControl });
}

/**
 * A 301 to `location`, which must be a local path (S7): it starts with one `/` (never `//` or `/\`, which a browser
 * reads as another site) and holds printable ASCII only (a tab or a line break, which a browser drops, could turn it
 * into `//host`). A redirect never goes to another site, whatever the request or a record says.
 *
 * It is sent `no-store`: a browser keeps a 301 without freshness forever, and every target here follows data that can
 * change (a title's slug, a merge, the SLiMS migration map, a record's visibility). A kept redirect would outlive the
 * data, and a title changed back would loop. A search engine still reads it as a permanent move.
 *
 * @throws TypeError for any other location (a bug of the caller: the path is built by the code, never taken as is)
 */
export function redirect301(c: Context<AppEnv>, location: string): Response {
  if (!isLocalPath(location)) throw new TypeError('redirect301: the location must be a local path (/x)');
  c.header('Cache-Control', 'no-store');
  return c.redirect(location, 301);
}

/** The statuses of the OPAC status page (S17). */
export type OpacStatus = 404 | 410 | 429 | 503;

/** A `Retry-After` the page keeps: whole seconds (what problem+json sends). */
const RETRY_AFTER = /^\d{1,10}$/;

/** The title and text of each status page in `locale` (404 is the 1b page's shared copy). */
function statusText(locale: Locale, status: OpacStatus): { title: string; body: string } {
  switch (status) {
    case 404:
      return { title: t(locale, 'opac.not_found.title'), body: t(locale, 'opac.not_found.body') };
    case 410:
      return { title: opacText(locale, 'shell.status.410.title'), body: opacText(locale, 'shell.status.410.body') };
    case 429:
      return { title: opacText(locale, 'shell.status.429.title'), body: opacText(locale, 'shell.status.429.body') };
    case 503:
      return { title: opacText(locale, 'shell.status.503.title'), body: opacText(locale, 'shell.status.503.body') };
  }
}

/** Markup in a .ts file: hono's jsx(), typed as JSX syntax types it (its runtime value is the same node). */
function element(tag: string | typeof Fragment, ...children: (string | JSX.Element)[]): JSX.Element {
  return jsx(tag as string, null, ...(children as Parameters<typeof jsx>[2][])) as unknown as JSX.Element;
}

/**
 * The OPAC status page (S17): what a browser gets for a 404, 410, 429 or 503 on a page, with that status, `noindex`,
 * `no-store` and `Retry-After` when given (whole seconds). Its language is `?lang=` or Indonesian, and neither a
 * setting nor the menu is read: the failure may well be the database, and an error page must not wait for it. The
 * language switch keeps the path from the request's config.baseUrl (S7), or on this site while no config is known.
 */
export function opacStatusResponse(c: Context<AppEnv>, status: OpacStatus, o: { retryAfter?: string } = {}): Response {
  const locale = resolveLocale(c.req.query('lang'));
  const text = statusText(locale, status);
  if (o.retryAfter !== undefined && RETRY_AFTER.test(o.retryAfter)) c.header('Retry-After', o.retryAfter);
  const config: { baseUrl?: unknown } | undefined = c.get('config');
  const baseUrl = typeof config?.baseUrl === 'string' ? config.baseUrl : '';
  return opacPage(
    { c },
    { locale, libraryName: t(locale, 'opac.home.title'), accent: DEFAULT_ACCENT, baseUrl, indexable: false },
    {
      status,
      title: text.title,
      description: text.body,
      robots: 'noindex',
      canonicalPath: null,
      body: () => element(Fragment, element('h1', text.title), element('p', text.body)),
    },
  );
}
