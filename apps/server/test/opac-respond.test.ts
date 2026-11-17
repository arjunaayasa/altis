import { SETTINGS, sanitizedHtml, type SafeHtml, type SettingKey, type SettingsCache } from '@altis/core';
import type { DbHandle } from '@altis/db';
import { t } from '@altis/shared';
import { Hono, type Context } from 'hono';
import { Fragment, jsx } from 'hono/jsx';
import type { JSX } from 'hono/jsx/jsx-runtime';
import { describe, expect, it } from 'vitest';
import { cspHeader } from '../src/http/csp.js';
import type { AppEnv } from '../src/http/request-id.js';
import { jsonLdScript, opacContext, opacPage, safeHtml, type OpacContext, type OpacPageOptions } from '../src/opac/catalog/page.js';
import { opacStatusResponse, redirect301, textResponse, xmlResponse } from '../src/opac/catalog/respond.js';
import { absoluteUrl, pagePath, withLang } from '../src/opac/catalog/urls.js';
import { opacText } from '../src/opac/catalog/messages.js';

// The OPAC's response helpers (Phase 2 Task 3): the page frame `opacPage` (S6: every script carries the nonce, JSON-LD
// only through `jsonLdScript`, sanitized HTML only through `safeHtml`), the status page of S17, XML and text answers,
// the relative-only 301 (S7), and the URL helpers (absolute URLs from config.baseUrl, never the Host header).

/** Markup without a .tsx file (the unit project runs `*.test.ts`): hono's jsx(), typed as JSX syntax types it. */
function el(tag: string | typeof Fragment, props: Record<string, unknown> | null, ...children: unknown[]): JSX.Element {
  return jsx(tag as string, props, ...(children as Parameters<typeof jsx>[2][])) as unknown as JSX.Element;
}

const BASE = 'https://perpus.sekolah.sch.id';
const CTX: OpacContext = { locale: 'id', libraryName: 'Perpustakaan SMA <1>', accent: 'blue', baseUrl: BASE, indexable: true };

/** Answers GET /x with `respond(c)`, and returns the response to a request with `headers`. */
async function answer(respond: (c: Context<AppEnv>) => Response, path = '/x', headers: Record<string, string> = {}): Promise<Response> {
  const app = new Hono<AppEnv>();
  app.get('/x', (c) => respond(c));
  return app.request(path, { headers });
}

const page = (o: Partial<OpacPageOptions> = {}, ctx: OpacContext = CTX) =>
  answer((c) => opacPage({ c }, ctx, { title: 'Judul', robots: 'index', body: () => el('p', null, 'isi'), ...o }));

/** The nonce of the policy header. */
function policyNonce(res: Response): string {
  const nonce = /'nonce-([A-Za-z0-9_-]+)'/.exec(res.headers.get('content-security-policy') ?? '')?.[1];
  expect(nonce).toBeDefined();
  return nonce!;
}

/** The text of every `<script type="application/ld+json">` element of `html`. */
function jsonLdBlocks(html: string): string[] {
  return [...html.matchAll(/<script type="application\/ld\+json"[^>]*>([\s\S]*?)<\/script>/g)].map((m) => m[1]!);
}

describe('opacPage', () => {
  it('a whole document: status 200, text/html, no-store, the CSP of a fresh nonce, the title and the library name escaped', async () => {
    const res = await page();
    expect(res.status).toBe(200);
    expect(res.headers.get('content-type')).toBe('text/html; charset=utf-8');
    expect(res.headers.get('cache-control')).toBe('no-store');
    const nonce = policyNonce(res);
    expect(res.headers.get('content-security-policy')).toBe(cspHeader(nonce));
    const html = await res.text();
    expect(html.startsWith('<!DOCTYPE html>')).toBe(true);
    expect(html).toContain('<html lang="id" data-accent="blue"');
    expect(html).toContain('<title>Judul</title>');
    expect(html).toContain('Perpustakaan SMA &lt;1&gt;');
    expect(html).toContain('<p>isi</p>');
    expect(html).not.toContain('name="robots"');
    expect(policyNonce(await page())).not.toBe(nonce);
  });

  it('every <script> carries the nonce of the policy: JSON-LD and the scripts of `head` and `body`', async () => {
    const res = await page({
      head: (nonce) => el('script', { nonce, src: '/assets/x.js' }),
      body: (nonce) => el(Fragment, null, el('p', null, 'isi'), el('script', { nonce, src: '/assets/y.js' })),
      jsonLd: [{ '@type': 'Book', name: 'Laskar Pelangi' }, { '@type': 'WebSite' }],
    });
    const nonce = policyNonce(res);
    const html = await res.text();
    const scripts = [...html.matchAll(/<script\b[^>]*>/gi)].map((m) => m[0]);
    expect(scripts).toHaveLength(4);
    for (const tag of scripts) expect(tag).toContain(`nonce="${nonce}"`);
    expect(jsonLdBlocks(html).map((b) => JSON.parse(b) as unknown)).toEqual([{ '@type': 'Book', name: 'Laskar Pelangi' }, { '@type': 'WebSite' }]);
  });

  it('a jsonLd value holding </script> stays inside its script, and parses back to the value', async () => {
    const evil = { '@type': 'Book', name: '</script><script>alert(1)</script>', note: '<!-- & \u2028 -->' };
    const html = await (await page({ jsonLd: [evil] })).text();
    expect([...html.matchAll(/<script\b/gi)]).toHaveLength(1);
    expect([...html.matchAll(/<\/script>/gi)]).toHaveLength(1);
    const blocks = jsonLdBlocks(html);
    expect(blocks).toHaveLength(1);
    expect(JSON.parse(blocks[0]!)).toEqual(evil);
    expect(html).not.toContain('<script>alert(1)');
  });

  it('robots: index writes no meta; noindex and noindex-follow do; an install that is not indexable is noindex everywhere', async () => {
    expect(await (await page({ robots: 'index' })).text()).not.toContain('name="robots"');
    expect(await (await page({ robots: 'noindex' })).text()).toContain('<meta name="robots" content="noindex"');
    expect(await (await page({ robots: 'noindex-follow' })).text()).toContain('<meta name="robots" content="noindex, follow"');
    const hidden = { ...CTX, indexable: false };
    expect(await (await page({ robots: 'index' }, hidden)).text()).toContain('<meta name="robots" content="noindex"');
    expect(await (await page({ robots: 'noindex-follow' }, hidden)).text()).toContain('<meta name="robots" content="noindex"');
  });

  it('status, description, Cache-Control and the canonical link from baseUrl (never the Host header)', async () => {
    const res = await answer(
      (c) =>
        opacPage({ c }, CTX, {
          status: 404,
          title: 'Tidak ada',
          description: 'Deskripsi',
          canonicalPath: '/katalog/01J000000000000000000000AB/laskar-pelangi',
          robots: 'noindex',
          body: () => el('h1', null, 'Tidak ada'),
          cacheControl: 'public, max-age=900',
        }),
      '/x',
      { Host: 'evil.example' },
    );
    expect(res.status).toBe(404);
    expect(res.headers.get('cache-control')).toBe('public, max-age=900');
    const html = await res.text();
    expect(html).toContain('<meta name="description" content="Deskripsi"');
    expect(html).toContain(`<link rel="canonical" href="${BASE}/katalog/01J000000000000000000000AB/laskar-pelangi"`);
    expect(html).not.toContain('evil.example');
  });

  it('refuses a status that is not an HTTP status and a canonical path that is not a local one', async () => {
    await expect(page({ status: 99 })).resolves.toMatchObject({ status: 500 });
    await expect(page({ canonicalPath: '//evil.example/x' })).resolves.toMatchObject({ status: 500 });
  });
});

describe('safeHtml and jsonLdScript (S6)', () => {
  it('safeHtml puts sanitized HTML on the page as it is, and only SafeHtml (the stub escapes everything)', async () => {
    const stored = sanitizedHtml('<p>Halo <script>x</script></p>');
    const html = await (await page({ body: () => el('div', { class: 'isi' }, safeHtml(stored)) })).text();
    expect(html).toContain(`<div class="isi">${stored}</div>`);
    expect(html).not.toContain('<script>x</script>');
    // @ts-expect-error a plain string is not SafeHtml
    safeHtml('<b>raw</b>');
    const typed: SafeHtml = stored;
    expect(String(safeHtml(typed))).toBe(stored);
  });

  it('jsonLdScript: one script element of type application/ld+json with the nonce, the JSON escaped', () => {
    const markup = String(jsonLdScript('abc_DEF-1', { a: '</script>' }));
    expect(markup).toBe('<script type="application/ld+json" nonce="abc_DEF-1">{"a":"\\u003c/script\\u003e"}</script>');
  });
});

describe('opacStatusResponse (S17)', () => {
  it.each([
    [404, t('id', 'opac.not_found.title')],
    [410, opacText('id', 'shell.status.410.title')],
    [429, opacText('id', 'shell.status.429.title')],
    [503, opacText('id', 'shell.status.503.title')],
  ] as const)('%i: an HTML page with that status, noindex, no-store, its own nonce, the page title', async (status, title) => {
    const res = await answer((c) => opacStatusResponse(c, status));
    expect(res.status).toBe(status);
    expect(res.headers.get('content-type')).toBe('text/html; charset=utf-8');
    expect(res.headers.get('cache-control')).toBe('no-store');
    expect(res.headers.get('content-security-policy')).toBe(cspHeader(policyNonce(res)));
    expect(res.headers.get('retry-after')).toBeNull();
    const html = await res.text();
    expect(html).toContain(`<h1>${title}</h1>`);
    expect(html).toContain('<meta name="robots" content="noindex"');
    expect(html).not.toMatch(/<script/i);
  });

  it('keeps Retry-After, in the language of ?lang (no setting is read)', async () => {
    const res = await answer((c) => opacStatusResponse(c, 429, { retryAfter: '42' }), '/x?lang=en');
    expect(res.status).toBe(429);
    expect(res.headers.get('retry-after')).toBe('42');
    const html = await res.text();
    expect(html).toContain('<html lang="en"');
    expect(html).toContain(opacText('en', 'shell.status.429.body'));
  });

  it('a Retry-After that is not whole seconds is left out', async () => {
    const res = await answer((c) => opacStatusResponse(c, 503, { retryAfter: '5, x' }));
    expect(res.headers.get('retry-after')).toBeNull();
  });
});

describe('redirect301 (S7: relative locations only)', () => {
  it.each(['/katalog/x', '/katalog/01J000000000000000000000AB/laskar-pelangi', '/cari?q=laskar%20pelangi&lang=en', '/'])('accepts %s', async (location) => {
    const res = await answer((c) => redirect301(c, location));
    expect(res.status).toBe(301);
    expect(res.headers.get('location')).toBe(location);
  });

  it('C13: no-store, since a browser keeps a 301 without freshness forever and its target follows data that changes', async () => {
    const res = await answer((c) => redirect301(c, '/katalog/x'));
    expect(res.headers.get('cache-control')).toBe('no-store');
  });

  it.each([
    '//evil.example',
    '//evil.example/katalog/x',
    '/\\evil.example',
    'https://x',
    'http://evil.example/',
    'katalog/x',
    '',
    ' /katalog',
    '/\t/evil.example',
    '/katalog\r\nSet-Cookie: x=1',
    '/katalog/é',
    '/ruang baca',
  ])('refuses %j with a TypeError', (location) => {
    expect(() => redirect301({} as Context<AppEnv>, location)).toThrow(TypeError);
  });
});

describe('xmlResponse and textResponse', () => {
  it('xmlResponse: the status, application/xml in UTF-8, the Cache-Control given, the text as it is', async () => {
    const res = await answer((c) => xmlResponse(c, 200, '<?xml version="1.0"?><rss/>', 'public, max-age=900'));
    expect(res.status).toBe(200);
    expect(res.headers.get('content-type')).toBe('application/xml; charset=utf-8');
    expect(res.headers.get('cache-control')).toBe('public, max-age=900');
    expect(await res.text()).toBe('<?xml version="1.0"?><rss/>');
  });

  it('textResponse: text/plain in UTF-8', async () => {
    const res = await answer((c) => textResponse(c, 404, 'User-agent: *\n', 'no-store'));
    expect(res.status).toBe(404);
    expect(res.headers.get('content-type')).toBe('text/plain; charset=utf-8');
    expect(res.headers.get('cache-control')).toBe('no-store');
    expect(await res.text()).toBe('User-agent: *\n');
  });
});

describe('the URL helpers', () => {
  it('absoluteUrl: baseUrl and a local path', () => {
    expect(absoluteUrl(BASE, '/sitemap.xml')).toBe(`${BASE}/sitemap.xml`);
    expect(absoluteUrl(`${BASE}/`, '/cari?q=a')).toBe(`${BASE}/cari?q=a`);
    for (const bad of ['//evil.example', '/\\evil.example', 'https://x/y', 'x', '']) expect(() => absoluteUrl(BASE, bad), bad).toThrow(TypeError);
  });

  it('pagePath: /halaman/<slug> and /berita/<slug>, the slug percent-encoded', () => {
    expect(pagePath('page', 'tentang-kami')).toBe('/halaman/tentang-kami');
    expect(pagePath('news', 'buka-sabtu')).toBe('/berita/buka-sabtu');
    expect(pagePath('page', 'a/b?c')).toBe('/halaman/a%2Fb%3Fc');
  });

  it('withLang sets the lang parameter, keeping the rest of the query and the fragment', () => {
    expect(withLang('/katalog/x', 'en')).toBe('/katalog/x?lang=en');
    expect(withLang('/cari?q=a%20b&lang=id&hal=2', 'en')).toBe('/cari?q=a%20b&hal=2&lang=en');
    expect(withLang('/halaman/x#isi', 'id')).toBe('/halaman/x?lang=id#isi');
    expect(() => withLang('//evil.example', 'en')).toThrow(TypeError);
  });
});

describe('opacContext', () => {
  /** A settings cache over `values` (the registry's default for the rest). */
  function settings(values: Partial<Record<SettingKey, unknown>>): SettingsCache & { reads: SettingKey[] } {
    const reads: SettingKey[] = [];
    return {
      reads,
      async get<T>(_db: unknown, key: SettingKey): Promise<T> {
        reads.push(key);
        return (Object.hasOwn(values, key) ? values[key] : SETTINGS[key].default) as T;
      },
      invalidate: () => {},
    };
  }
  /**
   * A Kysely stand-in whose every query finds nothing: Task 21's opacContext also reads the menu pages (none here).
   * `then` stays undefined, so that awaiting a builder does not take it for a promise.
   */
  const noRows: unknown = new Proxy(() => undefined, {
    get: (_target, prop) => (prop === 'execute' ? async () => [] : prop === 'then' ? undefined : () => noRows),
    apply: () => noRows,
  });
  const db = { db: noRows } as unknown as DbHandle;

  // Task 21 replaced the S22 literal: `opac.indexable` is read for real, and the menu pages come with the context.
  it('reads the library name, language, accent and opac.indexable through the settings cache; baseUrl from the config; the menu', async () => {
    const cache = settings({ 'library.name': 'Perpus', 'library.locale': 'en', 'opac.accent': 'green' });
    let got: OpacContext | undefined;
    const app = new Hono<AppEnv>();
    app.get('/x', async (c) => {
      got = await opacContext({ c, services: { settings: cache }, db, config: { baseUrl: BASE } });
      return c.text('ok');
    });
    await app.request('/x', { headers: { Host: 'evil.example' } });
    // The site of the menu and the footer: nothing set up, no news published.
    const site = { address: null, hours: [], brand: null, profile: false, services: false, contact: false, news: false };
    expect(got).toEqual({ locale: 'en', libraryName: 'Perpus', accent: 'green', baseUrl: BASE, indexable: true, nav: [], site });
    expect(cache.reads.sort()).toEqual(['library.address', 'library.locale', 'library.name', 'opac.accent', 'opac.home', 'opac.indexable']);
    await app.request('/x?lang=id');
    expect(got?.locale).toBe('id');
  });

  it('an accent that is not one of the six is the default', async () => {
    let got: OpacContext | undefined;
    const app = new Hono<AppEnv>();
    app.get('/x', async (c) => {
      got = await opacContext({ c, services: { settings: settings({ 'opac.accent': 'x"><b' }) }, db, config: { baseUrl: BASE } });
      return c.text('ok');
    });
    await app.request('/x');
    expect(got?.accent).toBe('teal');
  });
});
