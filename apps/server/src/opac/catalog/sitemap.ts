import { XmlWriter } from '@altis/core';

// The sitemaps (Phase 2 Task 21; spec §9.1, §9.7; sitemaps.org protocol 0.9): the index `/sitemap.xml` names the
// catalog files `/sitemap/katalog/1..N` (N = ⌈public records / 10 000⌉, at least 1) and the pages file
// `/sitemap/halaman`; each file lists at most 10 000 URLs with `lastmod` in the W3C format. Every URL is absolute from
// config.baseUrl. The XML is written by our own writer (escaped, characters XML 1.0 forbids dropped).

/** URLs per sitemap file (the protocol allows 50 000; the spec keeps 10 000 so that one file is cheap to build). */
export const SITEMAP_MAX_URLS = 10_000;

const NS = 'http://www.sitemaps.org/schemas/sitemap/0.9';
const DECLARATION = '<?xml version="1.0" encoding="UTF-8"?>\n';

/** The `Cache-Control` of the sitemaps and robots.txt: crawlers read them rarely, and a new record waits at most 1 h. */
export const SITEMAP_CACHE = 'public, max-age=3600';

/** `ms` as a W3C datetime in UTC, to the second (`2026-10-30T09:15:05Z`). */
export function w3cDate(ms: number): string {
  return new Date(ms).toISOString().replace(/\.\d{3}Z$/, 'Z');
}

/** The sitemap index of an OPAC at `baseUrl` with `catalogFiles` catalog files (at least 1). */
export function sitemapIndexXml(baseUrl: string, catalogFiles: number): string {
  const origin = baseUrl.replace(/\/+$/, '');
  const w = new XmlWriter().raw(DECLARATION).open('sitemapindex', { xmlns: NS });
  for (let n = 1; n <= Math.max(1, catalogFiles); n += 1) w.open('sitemap').leaf('loc', `${origin}/sitemap/katalog/${n}`).close();
  w.open('sitemap').leaf('loc', `${origin}/sitemap/halaman`).close();
  return w.close().toString();
}

/** One URL of a sitemap file: an absolute URL, and its last change (epoch ms) when known. */
export interface SitemapUrl {
  loc: string;
  lastmod: number | null;
}

/** A sitemap file of `urls`. */
export function urlsetXml(urls: readonly SitemapUrl[]): string {
  const w = new XmlWriter().raw(DECLARATION).open('urlset', { xmlns: NS });
  for (const u of urls) {
    w.open('url').leaf('loc', u.loc);
    if (u.lastmod !== null) w.leaf('lastmod', w3cDate(u.lastmod));
    w.close();
  }
  return w.close().toString();
}
