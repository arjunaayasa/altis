import type { Locale } from '@altis/shared';

// The home page's JSON-LD (Phase 2 Task 21; spec §9.4): the library as a schema.org `Library` and the OPAC as a
// `WebSite` whose `SearchAction` points at the search page. Every URL comes from config.baseUrl. The objects go on the
// page only through `jsonLdScript` (page.tsx, S6), which escapes them for a script element.

const CONTEXT = 'https://schema.org';

/** `baseUrl` without a trailing slash (config.baseUrl has none; P13). */
const origin = (baseUrl: string): string => baseUrl.replace(/\/+$/, '');

/**
 * `Library`: the library's name, its address (`library.address`, its whitespace on one line; left out when blank) and
 * the URL of the home page, with an `@id` the WebSite names as its publisher.
 */
export function libraryJsonLd(o: { name: string; address: string | null; baseUrl: string }): Record<string, unknown> {
  const home = `${origin(o.baseUrl)}/`;
  const address = (o.address ?? '').replace(/\s+/g, ' ').trim();
  return {
    '@context': CONTEXT,
    '@type': 'Library',
    '@id': `${home}#library`,
    name: o.name,
    url: home,
    ...(address === '' ? {} : { address }),
  };
}

/** `WebSite` with a `SearchAction` to `<baseUrl>/cari?q={search_term_string}` (the search box of a search engine). */
export function webSiteJsonLd(o: { name: string; baseUrl: string; locale: Locale }): Record<string, unknown> {
  const home = `${origin(o.baseUrl)}/`;
  return {
    '@context': CONTEXT,
    '@type': 'WebSite',
    '@id': `${home}#website`,
    name: o.name,
    url: home,
    inLanguage: o.locale,
    publisher: { '@id': `${home}#library` },
    potentialAction: {
      '@type': 'SearchAction',
      target: `${origin(o.baseUrl)}/cari?q={search_term_string}`,
      'query-input': 'required name=search_term_string',
    },
  };
}
