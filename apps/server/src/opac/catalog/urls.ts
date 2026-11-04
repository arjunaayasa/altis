import type { Locale } from '@altis/shared';

// The URLs of the OPAC (Phase 2 Task 3; spec §9.1, §9.2, P13, S7). Every absolute URL (canonical, sitemap, feeds, OAI,
// JSON-LD) is config.baseUrl plus a local path, never built from the Host header; a path from a request or a record is
// first checked to be local (`/x`, never `//host` or `/\host`, which a browser reads as another site).

/**
 * A local path: one `/`, then not a second `/` or `\`, then printable ASCII without spaces (anything else, a non-ASCII
 * slug included, is percent-encoded by whoever builds the path). Control characters are refused too: a browser drops a
 * tab or a line break inside a URL, so `/\t/evil.example` would become `//evil.example`.
 */
const LOCAL_PATH = /^\/(?![/\\])[\x21-\x7e]*$/;

/** Whether `path` is a local path (see {@link LOCAL_PATH}): what a redirect and an absolute URL may be built from. */
export function isLocalPath(path: unknown): path is string {
  return typeof path === 'string' && LOCAL_PATH.test(path);
}

/**
 * `baseUrl` + `path`: the absolute URL of a local path (config.baseUrl is an origin without a trailing slash, P13; a
 * trailing slash is dropped all the same).
 *
 * @throws TypeError when `path` is not a local path
 */
export function absoluteUrl(baseUrl: string, path: string): string {
  if (!isLocalPath(path)) throw new TypeError('absoluteUrl: the path must be a local path (/x)');
  return `${baseUrl.replace(/\/+$/, '')}${path}`;
}

/** The OPAC path of a published page (`/halaman/<slug>`) or news post (`/berita/<slug>`), the slug percent-encoded. */
export function pagePath(kind: 'page' | 'news', slug: string): string {
  return `/${kind === 'page' ? 'halaman' : 'berita'}/${encodeURIComponent(slug)}`;
}

/**
 * `path` with its `lang` query parameter set to `locale` (§9.1: one path in both languages, the language from
 * `?lang=`): an earlier `lang` is dropped, the other parameters keep their order and encoding, a fragment stays last.
 *
 * @throws TypeError when `path` is not a local path
 */
export function withLang(path: string, locale: Locale): string {
  if (!isLocalPath(path)) throw new TypeError('withLang: the path must be a local path (/x)');
  const hashAt = path.indexOf('#');
  const hash = hashAt === -1 ? '' : path.slice(hashAt);
  const rest = hashAt === -1 ? path : path.slice(0, hashAt);
  const queryAt = rest.indexOf('?');
  const pathname = queryAt === -1 ? rest : rest.slice(0, queryAt);
  const params = queryAt === -1 ? [] : rest.slice(queryAt + 1).split('&').filter((p) => p !== '' && p !== 'lang' && !p.startsWith('lang='));
  return `${pathname}?${[...params, `lang=${locale}`].join('&')}${hash}`;
}
