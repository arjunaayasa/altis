import { createXmlReader, type XmlEvent } from '@altis/core';
import { BASE_CSS, OPAC_CSS, SHELL_CSS } from '@altis/opac-theme';
import { COMMUNITY_SOURCE_URL, LOCALES, t, type Locale } from '@altis/shared';
import { Hono, type Context } from 'hono';
import { Fragment, jsx } from 'hono/jsx';
import type { JSX } from 'hono/jsx/jsx-runtime';
import { describe, expect, it } from 'vitest';
import type { Config } from '../src/config.js';
import { cspHeader } from '../src/http/csp.js';
import type { AppEnv } from '../src/http/request-id.js';
import { legacyRequest, searchRedirectPath } from '../src/opac/catalog/legacy.js';
import { libraryJsonLd, webSiteJsonLd } from '../src/opac/catalog/library-json-ld.js';
import { opacText } from '../src/opac/catalog/messages.js';
import { keptPath, keptQuery, opacPage, pageFrame, type OpacContext, type OpacPageOptions } from '../src/opac/catalog/page.js';
import { opacStatusResponse } from '../src/opac/catalog/respond.js';
import { robotsTxt } from '../src/opac/catalog/robots.js';
import { SITEMAP_MAX_URLS, sitemapIndexXml, urlsetXml, w3cDate } from '../src/opac/catalog/sitemap.js';
import { renderError, renderMaintenance, renderNotFound } from '../src/opac/pages.js';

// The OPAC shell's page frame and its pure parts (Phase 2 Task 21; spec §9.1, §9.2, §9.4, §9.7, §9.9; S6, S7, S17):
// - opacPage: a skip link to <main>, a header with the library name, the menu pages, a GET search form to /cari with a
//   labelled input and a language switch that keeps the path and the query; in <head> the canonical link, hreflang
//   id/en/x-default, OpenGraph basics and the robots meta; every absolute link from config.baseUrl, the path normalised
//   so that a request for `//evil.example` never becomes a protocol-relative link (S7);
// - the status page (S17) and the 1b pages in the same frame;
// - robots.txt, the sitemap XML, the home page's JSON-LD and the parsing of old SLiMS links.
// The database half (the home page, the sitemaps, /index.php through the app) is db/opac-shell.test.ts.

/** Markup without a .tsx file (the unit project runs `*.test.ts`): hono's jsx(), typed as JSX syntax types it. */
function el(tag: string | typeof Fragment, props: Record<string, unknown> | null, ...children: unknown[]): JSX.Element {
  return jsx(tag as string, props, ...(children as Parameters<typeof jsx>[2][])) as unknown as JSX.Element;
}

const BASE = 'https://perpus.sekolah.sch.id';
const NAV = [
  { href: '/halaman/tentang-kami', label: 'Tentang kami' },
  { href: '/halaman/jam-buka', label: 'Jam buka', lang: 'id' as const },
];
const CTX: OpacContext = { locale: 'id', libraryName: 'Perpustakaan SMA <1>', accent: 'blue', baseUrl: BASE, indexable: true, nav: NAV };

/**
 * Answers every GET with `respond(c)` (a catch-all, so that `//evil.example/` reaches it too), and returns the response
 * to a request for `path` with `headers`; `config` is what step 4 would have set.
 */
async function answer(
  respond: (c: Context<AppEnv>) => Response,
  path = '/x',
  headers: Record<string, string> = {},
  config?: Pick<Config, 'baseUrl'>,
): Promise<Response> {
  const app = new Hono<AppEnv>();
  app.get('*', (c) => {
    if (config !== undefined) c.set('config', config as Config);
    return respond(c);
  });
  return app.request(path, { headers });
}

const page = (o: Partial<OpacPageOptions> = {}, path = '/x', ctx: OpacContext = CTX, headers: Record<string, string> = {}) =>
  answer((c) => opacPage({ c }, ctx, { title: 'Judul', robots: 'index', body: () => el('p', null, 'isi'), ...o }), path, headers);

const esc = (s: string): string => s.replace(/[&<>'"]/g, (ch) => ({ '&': '&amp;', '<': '&lt;', '>': '&gt;', "'": '&#39;', '"': '&quot;' })[ch]!);

/** The `href` of the language link for `locale`. */
function langHref(html: string, locale: Locale): string | undefined {
  return new RegExp(`<a href="([^"]*)" hreflang="${locale}" lang="${locale}"`).exec(html)?.[1]?.replaceAll('&amp;', '&');
}

/** The `href` of `<link rel="alternate" hreflang="…">`. */
function alternate(html: string, hreflang: string): string | undefined {
  return new RegExp(`<link rel="alternate" hreflang="${hreflang}" href="([^"]*)"`).exec(html)?.[1]?.replaceAll('&amp;', '&');
}

function canonical(html: string): string | undefined {
  return /<link rel="canonical" href="([^"]*)"/.exec(html)?.[1]?.replaceAll('&amp;', '&');
}

function meta(html: string, property: string): string | undefined {
  return new RegExp(`<meta property="${property}" content="([^"]*)"`).exec(html)?.[1];
}

/** Every href and src value of `html` (entity-decoded `&amp;`). */
function links(html: string): string[] {
  return [...html.matchAll(/\s(?:href|src|action)="([^"]*)"/g)].map((m) => m[1]!.replaceAll('&amp;', '&'));
}

describe('opacPage: the frame (§9.2)', () => {
  it('a skip link first in <body> to <main id>, the library name linking home, the menu pages in order', async () => {
    const html = await (await page()).text();
    const body = html.slice(html.indexOf('<body>'));
    expect(body).toMatch(new RegExp(`^<body><a class="skip-link" href="#isi">${esc(opacText('id', 'shell.skip_link'))}</a>`));
    expect(html).toContain('<main id="isi" tabindex="-1">');
    expect(html).toContain('<a class="brand" href="/">Perpustakaan SMA &lt;1&gt;</a>');
    expect(html).toContain(`<nav class="menu" aria-label="${esc(opacText('id', 'shell.nav.label'))}">`);
    const menu = /<nav class="menu"[^>]*>([\s\S]*?)<\/nav>/.exec(html)![1]!;
    expect([...menu.matchAll(/<a href="([^"]*)"[^>]*>([^<]*)<\/a>/g)].map((m) => [m[1], m[2]])).toEqual([
      ['/halaman/tentang-kami', 'Tentang kami'],
      ['/halaman/jam-buka', 'Jam buka'],
    ]);
    expect(menu).toContain('<a href="/halaman/jam-buka" lang="id">');
  });

  it('no menu without pages', async () => {
    const html = await (await page({}, '/x', { ...CTX, nav: [] })).text();
    expect(html).not.toContain('class="menu"');
    const bare = await (await page({}, '/x', { locale: 'id', libraryName: 'P', accent: 'teal', baseUrl: BASE, indexable: true })).text();
    expect(bare).not.toContain('class="menu"');
  });

  it('a GET search form to /cari whose input has a label; headerSearch: false leaves it out', async () => {
    const html = await (await page()).text();
    const form = /<form class="search-box"[^>]*>[\s\S]*?<\/form>/.exec(html)?.[0];
    expect(form).toBeDefined();
    expect(form).toMatch(/^<form class="search-box" role="search" method="get" action="\/cari">/);
    const id = /<input id="([^"]+)" type="search" name="q"/.exec(form!)?.[1];
    expect(id).toBeDefined();
    expect(form).toContain(`<label for="${id}"`);
    expect(form).toContain(esc(opacText('id', 'shell.search.label')));
    expect(form).toContain(`<button type="submit">${esc(opacText('id', 'shell.search.submit'))}</button>`);
    expect(form).not.toContain('name="lang"');
    expect(await (await page({ headerSearch: false })).text()).not.toContain('class="search-box"');
  });

  it('?lang=en: the frame in English, and the menu, the brand and the search keep the language', async () => {
    const html = await (await page({}, '/x?lang=en', { ...CTX, locale: 'en' })).text();
    expect(html).toContain(`<a class="skip-link" href="#isi">${esc(opacText('en', 'shell.skip_link'))}</a>`);
    expect(html).toContain(esc(opacText('en', 'shell.search.label')));
    expect(html).toContain(`aria-label="${esc(opacText('en', 'shell.nav.label'))}"`);
    expect(html).toContain('<a class="brand" href="/?lang=en">');
    expect(html).toContain('<a href="/halaman/tentang-kami?lang=en">');
    expect(html).toContain('<input type="hidden" name="lang" value="en"');
    for (const key of ['shell.skip_link', 'shell.search.label', 'shell.nav.label'] as const) {
      expect(html).not.toContain(esc(opacText('id', key)));
    }
  });

  it('the language switch keeps the path and the query (without lang and tracking parameters), from baseUrl', async () => {
    const html = await (await page({}, '/x?q=laskar%20pelangi&hal=2&utm_source=ig&fbclid=abc&lang=id', CTX, { Host: 'evil.example' })).text();
    expect(langHref(html, 'en')).toBe(`${BASE}/x?q=laskar+pelangi&hal=2&lang=en`);
    expect(langHref(html, 'id')).toBe(`${BASE}/x?q=laskar+pelangi&hal=2&lang=id`);
    expect(html).toMatch(/<a href="[^"]*" hreflang="id" lang="id" aria-current="true">/);
    expect(html).not.toMatch(/hreflang="en" lang="en" aria-current/);
    expect(html).not.toContain('evil.example');
  });

  it('head: the canonical link of the request path (the page language kept), hreflang id/en/x-default, OpenGraph', async () => {
    const html = await (await page({ description: 'Isi halaman' }, '/x?hal=2&lang=en', { ...CTX, locale: 'en' })).text();
    expect(canonical(html)).toBe(`${BASE}/x?hal=2&lang=en`);
    expect(alternate(html, 'id')).toBe(`${BASE}/x?hal=2&lang=id`);
    expect(alternate(html, 'en')).toBe(`${BASE}/x?hal=2&lang=en`);
    expect(alternate(html, 'x-default')).toBe(`${BASE}/x?hal=2`);
    expect(meta(html, 'og:type')).toBe('website');
    expect(meta(html, 'og:title')).toBe('Judul');
    expect(meta(html, 'og:description')).toBe('Isi halaman');
    expect(meta(html, 'og:site_name')).toBe('Perpustakaan SMA &lt;1&gt;');
    expect(meta(html, 'og:locale')).toBe('en_US');
    expect(meta(html, 'og:url')).toBe(`${BASE}/x?hal=2&amp;lang=en`);
    const plain = await (await page({}, '/x')).text();
    expect(canonical(plain)).toBe(`${BASE}/x`);
    expect(alternate(plain, 'x-default')).toBe(`${BASE}/x`);
    expect(meta(plain, 'og:locale')).toBe('id_ID');
  });

  it('an explicit canonical path wins (the page language appended); null writes none; openGraph: false none', async () => {
    const html = await (await page({ canonicalPath: '/katalog/01J000000000000000000000AB/laskar', openGraph: { type: 'book', image: '/files/01J000000000000000000000CV' } }, '/katalog/01J000000000000000000000AB/salah?lang=en', { ...CTX, locale: 'en' })).text();
    expect(canonical(html)).toBe(`${BASE}/katalog/01J000000000000000000000AB/laskar?lang=en`);
    expect(alternate(html, 'x-default')).toBe(`${BASE}/katalog/01J000000000000000000000AB/laskar`);
    expect(meta(html, 'og:type')).toBe('book');
    expect(meta(html, 'og:image')).toBe(`${BASE}/files/01J000000000000000000000CV`);
    const none = await (await page({ canonicalPath: null, openGraph: false })).text();
    expect(none).not.toContain('rel="canonical"');
    expect(none).not.toContain('rel="alternate"');
    expect(none).not.toContain('property="og:');
  });

  it('a page that is not a 200 gets no canonical, hreflang or OpenGraph of its own', async () => {
    const html = await (await page({ status: 404, robots: 'noindex' })).text();
    expect(html).not.toContain('rel="canonical"');
    expect(html).not.toContain('rel="alternate"');
    expect(html).not.toContain('property="og:');
    expect(html).toContain('<meta name="robots" content="noindex"');
  });

  it('not indexable (opac.indexable = false): noindex on every page', async () => {
    for (const robots of ['index', 'noindex-follow'] as const) {
      expect(await (await page({ robots }, '/x', { ...CTX, indexable: false })).text()).toContain('<meta name="robots" content="noindex"');
    }
  });

  it('every <script> carries the nonce of the policy; the frame adds none of its own', async () => {
    const res = await page({ jsonLd: [{ '@type': 'Library' }, { '@type': 'WebSite' }] });
    const nonce = /'nonce-([A-Za-z0-9_-]+)'/.exec(res.headers.get('content-security-policy') ?? '')![1]!;
    const html = await res.text();
    const scripts = [...html.matchAll(/<script\b[^>]*>/gi)].map((m) => m[0]);
    expect(scripts).toHaveLength(2);
    for (const tag of scripts) expect(tag).toContain(`nonce="${nonce}"`);
    expect(html).not.toMatch(/<style/i);
    expect(html).not.toMatch(/<[a-z][^>]*\s(?:style|on[a-z]+)=/i);
    expect(await (await page()).text()).not.toMatch(/<script/i);
  });
});

describe('S7: links that keep the request path start with config.baseUrl', () => {
  it.each(['//evil.example/?lang=en', '/\\evil.example/?lang=en', '//evil.example', '/\\/\\evil.example/x?lang=en', '/.//evil.example/?lang=en'])(
    'a request for %j',
    async (path) => {
      const res = await page({}, path, CTX, { Host: 'evil.example' });
      expect(res.status).toBe(200);
      const html = await res.text();
      const lang = langHref(html, 'en');
      expect(lang?.startsWith(`${BASE}/`), lang).toBe(true);
      expect(langHref(html, 'id')?.startsWith(`${BASE}/`)).toBe(true);
      expect(canonical(html)?.startsWith(`${BASE}/`), canonical(html)).toBe(true);
      for (const hreflang of ['id', 'en', 'x-default']) expect(alternate(html, hreflang)?.startsWith(`${BASE}/`)).toBe(true);
      for (const link of links(html)) {
        expect(link.startsWith('//') || link.startsWith('/\\'), link).toBe(false);
        // The footer's source link (AGPL-3.0 §13) is the one fixed absolute link; it keeps no request path.
        expect(link.startsWith(BASE) || link.startsWith('/') || link.startsWith('#') || link === COMMUNITY_SOURCE_URL, link).toBe(true);
      }
      expect(html).not.toMatch(/https?:\/\/evil\.example/);
    },
  );

  it('keptPath: leading slashes and backslashes collapsed to one /, resolved against baseUrl, always a local path', () => {
    expect(keptPath('http://evil.example//evil.example/', BASE)).toBe('/evil.example/');
    expect(keptPath('http://h/\\\\evil.example', BASE)).toBe('/evil.example');
    expect(keptPath('http://h/a/../b', BASE)).toBe('/b');
    expect(keptPath('http://h/.//evil.example', BASE)).toBe('/evil.example');
    expect(keptPath('http://h/katalog/%C3%A9?x=1#y', BASE)).toBe('/katalog/%C3%A9');
    expect(keptPath('http://h/', BASE)).toBe('/');
    expect(keptPath('not a url', BASE)).toBe('/');
    expect(keptPath('http://h//x', '')).toBe('/x');
  });

  it('keptQuery: lang, tracking parameters, odd names and control characters left out; at most 20 parameters', () => {
    expect(keptQuery('http://h/x?q=a%20b&lang=en&utm_source=ig&gclid=1&hal=2').toString()).toBe('q=a+b&hal=2');
    expect(keptQuery('http://h/x?q=%00x&a%3Cb=1&ok=%E2%80%A8&n=1').toString()).toBe('n=1');
    expect(keptQuery(`http://h/x?${Array.from({ length: 30 }, (_, i) => `p${i}=${i}`).join('&')}`).toString().split('&')).toHaveLength(20);
    expect(keptQuery(`http://h/x?q=${'a'.repeat(1001)}`).toString()).toBe('');
  });

  it('pageFrame: without a baseUrl (no config yet) the language links stay on this site, path and query kept', async () => {
    const app = new Hono<AppEnv>();
    let frame: ReturnType<typeof pageFrame> | undefined;
    app.get('*', (c) => {
      frame = pageFrame(c, { locale: 'id', baseUrl: '' }, { search: true });
      return c.text('ok');
    });
    await app.request('//evil.example/x?q=1&lang=id');
    expect(frame?.langHrefs).toEqual({ id: '/evil.example/x?q=1&lang=id', en: '/evil.example/x?q=1&lang=en' });
    expect(frame?.homeHref).toBe('/?lang=id');
    expect(frame?.search).toEqual({ lang: 'id' });
    expect(frame?.nav).toEqual([]);
  });
});

describe('opacStatusResponse in the frame (S17)', () => {
  it('the status page has the skip link and the search form, no menu, noindex, and reads nothing', async () => {
    const res = await answer((c) => opacStatusResponse(c, 404), '/hilang?lang=en');
    expect(res.status).toBe(404);
    const html = await res.text();
    expect(html).toContain(`<h1>${esc(t('en', 'opac.not_found.title'))}</h1>`);
    expect(html).toContain('class="skip-link"');
    expect(html).toContain('class="search-box"');
    expect(html).not.toContain('class="menu"');
    expect(html).toContain('<meta name="robots" content="noindex"');
    expect(html).not.toContain('rel="canonical"');
    expect(langHref(html, 'id')).toBe('/hilang?lang=id');
    expect(html).not.toMatch(/<script/i);
  });

  it('with the config of the request, its language links start with baseUrl', async () => {
    const res = await answer((c) => opacStatusResponse(c, 503, { retryAfter: '30' }), '//evil.example/?lang=en', { Host: 'evil.example' }, { baseUrl: BASE });
    expect(res.status).toBe(503);
    expect(res.headers.get('retry-after')).toBe('30');
    const html = await res.text();
    expect(langHref(html, 'id')).toBe(`${BASE}/evil.example/?lang=id`);
    expect(html).not.toMatch(/https?:\/\/evil\.example/);
  });
});

describe('the 1b pages in the shell frame', () => {
  const base = { locale: 'id' as const, nonce: 'abc_DEF-123' };

  it('renderMaintenance and renderError: the skip link, relative language links, no search form', () => {
    for (const html of [renderMaintenance(base), renderError({ ...base, code: 'ABCD1234' })]) {
      expect(html).toContain(`<a class="skip-link" href="#isi">${esc(opacText('id', 'shell.skip_link'))}</a>`);
      expect(html).toContain('<main id="isi" tabindex="-1">');
      expect(html).toContain('href="?lang=en"');
      expect(html).not.toContain('class="search-box"');
    }
  });

  it('renderNotFound with a frame: the menu, the search form and the language links of the frame', () => {
    const html = renderNotFound({
      ...base,
      frame: { homeHref: '/', langHrefs: { id: `${BASE}/x?lang=id`, en: `${BASE}/x?lang=en` }, nav: NAV, search: { lang: null } },
    });
    expect(langHref(html, 'en')).toBe(`${BASE}/x?lang=en`);
    expect(html).toContain('class="menu"');
    expect(html).toContain('class="search-box"');
  });
});

describe('robots.txt (§9.7)', () => {
  it('indexable: Allow /, Disallow /admin /api /cari, the sitemap index from baseUrl', () => {
    expect(robotsTxt(BASE, true)).toBe(
      ['User-agent: *', 'Allow: /', 'Disallow: /admin', 'Disallow: /api', 'Disallow: /cari', '', `Sitemap: ${BASE}/sitemap.xml`, ''].join('\n'),
    );
  });

  it('not indexable: Disallow / and no sitemap', () => {
    expect(robotsTxt(BASE, false)).toBe('User-agent: *\nDisallow: /\n');
  });
});

/** The events of `xml`, read by our own reader (it refuses anything that is not well-formed). */
function readXml(xml: string): XmlEvent[] {
  const reader = createXmlReader();
  return [...reader.write(xml), ...reader.end()];
}

/** The text of every `name` element of `xml`. */
function texts(xml: string, name: string): string[] {
  const out: string[] = [];
  let inside = false;
  for (const e of readXml(xml)) {
    if (e.type === 'open' && e.name === name) inside = true;
    else if (e.type === 'close' && e.name === name) inside = false;
    else if (e.type === 'text' && inside) out.push(e.text);
  }
  return out;
}

describe('the sitemap XML (§9.7)', () => {
  it('the index lists /sitemap/katalog/1..N and /sitemap/halaman from baseUrl, in the sitemap namespace', () => {
    const xml = sitemapIndexXml(BASE, 2);
    expect(xml.startsWith('<?xml version="1.0" encoding="UTF-8"?>\n<sitemapindex xmlns="http://www.sitemaps.org/schemas/sitemap/0.9">')).toBe(true);
    expect(texts(xml, 'loc')).toEqual([`${BASE}/sitemap/katalog/1`, `${BASE}/sitemap/katalog/2`, `${BASE}/sitemap/halaman`]);
    expect(texts(sitemapIndexXml(BASE, 1), 'loc')).toEqual([`${BASE}/sitemap/katalog/1`, `${BASE}/sitemap/halaman`]);
  });

  it('a urlset escapes its URLs and writes lastmod in the W3C format', () => {
    const xml = urlsetXml([
      { loc: `${BASE}/cari?q=a&b=<c>`, lastmod: Date.UTC(2026, 9, 30, 9, 15, 5, 123) },
      { loc: `${BASE}/`, lastmod: null },
    ]);
    expect(xml).toContain('<urlset xmlns="http://www.sitemaps.org/schemas/sitemap/0.9">');
    expect(xml).toContain('<loc>https://perpus.sekolah.sch.id/cari?q=a&amp;b=&lt;c&gt;</loc>');
    expect(texts(xml, 'loc')).toEqual([`${BASE}/cari?q=a&b=<c>`, `${BASE}/`]);
    expect(texts(xml, 'lastmod')).toEqual(['2026-10-30T09:15:05Z']);
    expect(w3cDate(0)).toBe('1970-01-01T00:00:00Z');
    expect(SITEMAP_MAX_URLS).toBe(10_000);
  });
});

describe('the home page JSON-LD (§9.4)', () => {
  it('Library: name, the address on one line, the URL of the home page', () => {
    expect(libraryJsonLd({ name: 'Perpus <A>', address: ' Jl. Merdeka 1\n  Bandung ', baseUrl: BASE })).toEqual({
      '@context': 'https://schema.org',
      '@type': 'Library',
      '@id': `${BASE}/#library`,
      name: 'Perpus <A>',
      url: `${BASE}/`,
      address: 'Jl. Merdeka 1 Bandung',
    });
    for (const address of [null, '', '  \n ']) expect(libraryJsonLd({ name: 'P', address, baseUrl: BASE })).not.toHaveProperty('address');
  });

  it('WebSite with a SearchAction to <baseUrl>/cari?q={search_term_string}', () => {
    expect(webSiteJsonLd({ name: 'Perpus', baseUrl: BASE, locale: 'id' })).toEqual({
      '@context': 'https://schema.org',
      '@type': 'WebSite',
      '@id': `${BASE}/#website`,
      name: 'Perpus',
      url: `${BASE}/`,
      inLanguage: 'id',
      publisher: { '@id': `${BASE}/#library` },
      potentialAction: {
        '@type': 'SearchAction',
        target: `${BASE}/cari?q={search_term_string}`,
        'query-input': 'required name=search_term_string',
      },
    });
  });
});

describe('old SLiMS links (§9.9)', () => {
  const q = (o: Record<string, string>) => (name: string) => o[name];

  it('p=show_detail with a numeric id: the record lookup, leading zeros dropped', () => {
    expect(legacyRequest(q({ p: 'show_detail', id: '7' }))).toEqual({ kind: 'record', legacyKey: '7' });
    expect(legacyRequest(q({ p: 'show_detail', id: '007' }))).toEqual({ kind: 'record', legacyKey: '7' });
    expect(legacyRequest(q({ p: 'show_detail', id: '1234567890123456789' }))).toEqual({ kind: 'record', legacyKey: '1234567890123456789' });
  });

  it.each([['x'], [''], ['-1'], ['1e3'], ['0'], ['12345678901234567890'], [' 7'], ['7 ']])('p=show_detail with id %j: home', (id) => {
    expect(legacyRequest(q({ p: 'show_detail', id }))).toEqual({ kind: 'home' });
  });

  it('keywords: a search; blank keywords, another page or nothing: home', () => {
    expect(legacyRequest(q({ search: 'search', keywords: 'laskar pelangi' }))).toEqual({ kind: 'search', q: 'laskar pelangi' });
    expect(legacyRequest(q({ keywords: '  a\u0000b\tc  ' }))).toEqual({ kind: 'search', q: 'a b c' });
    expect(legacyRequest(q({ keywords: '   ' }))).toEqual({ kind: 'home' });
    expect(legacyRequest(q({ p: 'member' }))).toEqual({ kind: 'home' });
    expect(legacyRequest(q({}))).toEqual({ kind: 'home' });
    expect((legacyRequest(q({ keywords: 'x'.repeat(600) })) as { q: string }).q).toHaveLength(500);
  });

  it('searchRedirectPath: /cari?q= with the text percent-encoded, always a local path', () => {
    expect(searchRedirectPath('laskar pelangi & co/2')).toBe('/cari?q=laskar%20pelangi%20%26%20co%2F2');
    expect(searchRedirectPath('é')).toBe('/cari?q=%C3%A9');
  });
});

describe('the shell theme (S16)', () => {
  it('shared tokens in base: focus, cards, facets, availability and the shelf map', () => {
    for (const token of ['--focus', '--card-bg', '--card-border', '--facet-bg', '--ok', '--warn', '--danger', '--map-shelf', '--map-highlight']) {
      expect(BASE_CSS, token).toContain(`${token}:`);
    }
  });

  it('the shell classes exist, focus is visible on every control, and the skip link shows on focus', () => {
    for (const cls of [
      '.skip-link',
      '.skip-link:focus',
      '.menu',
      '.search-box',
      '.visually-hidden',
      '.card-grid',
      '.card',
      '.card-cover',
      '.facet',
      '.availability',
      '.status-ok',
      '.shelf-map',
      '.class-grid',
      '.news-list',
    ]) {
      expect(SHELL_CSS, cls).toContain(`${cls}`);
    }
    expect(SHELL_CSS).toMatch(/:focus-visible\{outline:3px solid var\(--focus\)/);
    expect(OPAC_CSS).not.toMatch(/@import|url\(/);
  });

  it('the footer: the staff sign-in, then the source code link (AGPL-3.0 §13) with rel="noopener", in both languages', async () => {
    for (const locale of LOCALES) {
      const html = await (await page({}, `/x?lang=${locale}`, { ...CTX, locale })).text();
      const footer = /<footer class="site-footer">([\s\S]*?)<\/footer>/.exec(html)?.[1];
      expect(footer).toBeDefined();
      expect([...footer!.matchAll(/<a ([^>]*)>([^<]*)<\/a>/g)].map((m) => [m[1], m[2]])).toEqual([
        ['href="/admin/login"', esc(t(locale, 'opac.home.staff_login'))],
        [`href="${COMMUNITY_SOURCE_URL}" rel="noopener"`, esc(opacText(locale, 'shell.footer.source'))],
      ]);
    }
    expect(opacText('id', 'shell.footer.source')).toBe('Kode sumber (AGPL-3.0)');
    expect(opacText('en', 'shell.footer.source')).toBe('Source code (AGPL-3.0)');
    for (const html of [renderMaintenance({ locale: 'id', nonce: 'abc' }), renderNotFound({ locale: 'en', nonce: 'abc' })]) {
      expect(html).toContain(`<a href="${COMMUNITY_SOURCE_URL}" rel="noopener">`);
    }
  });

  it('every class the frame writes is styled', async () => {
    const html = await (await page({}, '/x')).text();
    const classes = new Set([...html.matchAll(/class="([^"]+)"/g)].flatMap((m) => m[1]!.split(/\s+/)));
    for (const cls of classes) expect(OPAC_CSS, cls).toContain(`.${cls}`);
  });

  it('the frame CSP header names the page nonce (unchanged from 1b)', async () => {
    const res = await page();
    const nonce = /<meta name="csp-nonce" content="([^"]+)"/.exec(await res.text())![1]!;
    expect(res.headers.get('content-security-policy')).toBe(cspHeader(nonce));
  });
});

describe('the frame copy', () => {
  it('every shell key has an Indonesian and an English text, different from each other', () => {
    for (const key of ['shell.skip_link', 'shell.nav.label', 'shell.search.label', 'shell.search.submit'] as const) {
      for (const locale of LOCALES) expect(opacText(locale, key)).not.toBe(key);
      expect(opacText('en', key)).not.toBe(opacText('id', key));
    }
  });
});
