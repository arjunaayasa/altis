import { t } from '@altis/shared';
import { opacText } from './catalog/messages.js';
import { Layout, toDocument, type PageOptions } from './layout.js';

// The OPAC's own error pages (Phase 1b; spec §4.9, §13.3): 404, 500 and the maintenance page. Each returns a whole
// HTML document as a string (no streaming, no client script). Every text is a message key (`opac.*`) or a value JSX
// escapes: a library name and an error code never reach the page raw. The home page became the catalogue's in Phase 2
// (Task 21, catalog/home.tsx); the 404 page then carries the catalogue's header when its caller gives the `frame`.

/** The 404 page: what the OPAC answers for a path nothing serves, to a browser (in the catalogue's frame when given). */
export function renderNotFound(o: PageOptions): string {
  const { locale } = o;
  const title = t(locale, 'opac.not_found.title');
  return toDocument(
    <Layout {...o} title={title} description={t(locale, 'opac.not_found.body')} indexable={false}>
      <h1>{title}</h1>
      <p>{t(locale, 'opac.not_found.body')}</p>
      {/* The way back the text names, as a link (the home page in the language of this one). */}
      <p>
        <a href={o.frame?.homeHref ?? '/'}>{opacText(locale, 'shell.menu.home')}</a>
      </p>
    </Layout>,
  );
}

export interface ErrorPageOptions extends PageOptions {
  /** The last 8 characters of the request id (§11): what a visitor reads out to the staff. Nothing else of the failure. */
  code: string;
}

/** The 500 page: a generic message and the 8-character code, never a detail or a stack. */
export function renderError(o: ErrorPageOptions): string {
  const { locale, code, ...page } = o;
  const title = t(locale, 'opac.error.title');
  return toDocument(
    <Layout locale={locale} {...page} title={title} description={title} indexable={false}>
      <h1>{title}</h1>
      <p>{t(locale, 'opac.error.body', { code })}</p>
    </Layout>,
  );
}

export interface MaintenanceOptions extends PageOptions {
  /** Seconds until the service is expected back (1c's `Retry-After`): the browser looks again after that long. */
  retryAfterS?: number | undefined;
  /**
   * Link the operations page `/admin/_update` (1c Task 19): for a path under /admin, whose pages are closed during
   * maintenance while the operations page is not.
   */
  updateLink?: boolean | undefined;
}

/** The maintenance page (exported for 1c, which serves it with a 503 while an update or a restore runs). */
export function renderMaintenance(o: MaintenanceOptions): string {
  const { locale, updateLink, ...page } = o;
  const title = t(locale, 'opac.maintenance.title');
  return toDocument(
    <Layout locale={locale} {...page} title={title} description={t(locale, 'opac.maintenance.body')} indexable={false}>
      <h1>{title}</h1>
      <p>{t(locale, 'opac.maintenance.body')}</p>
      {updateLink === true ? (
        <p>
          <a href="/admin/_update">{t(locale, 'opac.maintenance.update_link')}</a>
        </p>
      ) : null}
    </Layout>,
  );
}
