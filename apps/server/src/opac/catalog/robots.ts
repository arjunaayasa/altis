// robots.txt (Phase 2 Task 21; spec §9.1, §9.7). An indexable OPAC lets crawlers in everywhere but the staff pages,
// the API and the search results (whose pages are `noindex, follow` anyway), and names the sitemap index, an absolute
// URL from config.baseUrl. With `opac.indexable = false` crawlers are kept out of everything (and every page is
// `noindex`, page.tsx).

/** The robots.txt of an OPAC at `baseUrl`. */
export function robotsTxt(baseUrl: string, indexable: boolean): string {
  if (!indexable) return 'User-agent: *\nDisallow: /\n';
  const origin = baseUrl.replace(/\/+$/, '');
  return ['User-agent: *', 'Allow: /', 'Disallow: /admin', 'Disallow: /api', 'Disallow: /cari', '', `Sitemap: ${origin}/sitemap.xml`, ''].join('\n');
}
