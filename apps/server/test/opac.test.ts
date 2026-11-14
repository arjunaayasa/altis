import { SETTINGS, sha256hex, type SettingKey, type SettingsCache } from '@altis/core';
import type { DbHandle } from '@altis/db';
import {
  ACCENTS,
  BASE_CSS,
  DETAIL_CSS,
  VISITS_CSS,
  OPAC_CSS,
  OPAC_CSS_MODULES,
  PAGES_CSS,
  SEARCH_CSS,
  SHELL_CSS,
  joinOpacCss,
} from '@altis/opac-theme';
import { DomainError, LOCALES, t, type Locale } from '@altis/shared';
import { describe, expect, it } from 'vitest';
import type { z } from 'zod';
import { createApp } from '../src/app.js';
import { cspHeader } from '../src/http/csp.js';
import type { OpsFence } from '../src/http/ops-fence.js';
import { renderError, renderMaintenance, renderNotFound } from '../src/opac/pages.js';
import { OPAC_CSS_HASH } from '../src/opac/routes.js';
import { ALL_ROUTES } from '../src/routes.js';
import { recordingLogger } from './support.js';

// The temporary OPAC (Task 26, spec §4.9, §7.4, decision D30): the home page, the 404 and 500 pages, the maintenance
// page (exported for 1c) and the stylesheet served from memory under a content hash. The routes are `session: 'none'`:
// settings come through the settings cache (a fake one here), no cookie is read.

const PROBLEM_TYPE = 'application/problem+json';
const HTML_TYPE = 'text/html; charset=utf-8';
const IMMUTABLE = 'public, max-age=31536000, immutable';
const NONCE = /^[A-Za-z0-9_-]{22}$/;
const BROWSER_ACCEPT = 'text/html,application/xhtml+xml,application/xml;q=0.9,image/avif,image/webp,*/*;q=0.8';

/** What Hono's JSX escapes in text and attribute values. */
function esc(s: string): string {
  return s.replace(/[&<>'"]/g, (ch) => ({ '&': '&amp;', '<': '&lt;', '>': '&gt;', "'": '&#39;', '"': '&quot;' })[ch]!);
}

/** A settings cache over `values` (the registry's default for the rest); every read throws with `failing`. */
function fakeSettings(values: Partial<Record<SettingKey, unknown>> = {}, o: { failing?: boolean } = {}): SettingsCache & { reads: SettingKey[] } {
  const reads: SettingKey[] = [];
  return {
    reads,
    async get<T>(_db: unknown, key: SettingKey): Promise<T> {
      reads.push(key);
      if (o.failing === true) throw new Error('settings unavailable');
      return (Object.hasOwn(values, key) ? values[key] : SETTINGS[key].default) as T;
    },
    invalidate: () => {},
  };
}

/** A database handle nothing reads: the fake settings cache ignores it, `session: 'none'` routes read nothing else. */
const NO_DB: DbHandle = {
  db: {} as DbHandle['db'],
  dialect: 'sqlite',
  limits: { maxUserConnections: 0, maxConnections: 1 },
  poolSize: 1,
  close: async () => {},
};

function setup(values: Partial<Record<SettingKey, unknown>> = {}, o: { failing?: boolean; db?: boolean; opsFence?: OpsFence } = {}) {
  const log = recordingLogger();
  const settings = fakeSettings(values, o.failing === undefined ? {} : { failing: o.failing });
  const app = createApp({
    state: o.db === false ? { phase: 'ready' } : { phase: 'ready', db: NO_DB },
    version: '0.1.0',
    buildId: 'b1d0001',
    log,
    services: { settings, ...(o.opsFence === undefined ? {} : { opsFence: o.opsFence }) },
  });
  return { app, log, settings };
}

/** An ops fence that says a restore holds the installation (past its point of no return); it reads no file. */
function restoringFence(): OpsFence {
  const op = { opId: '01JRESTORE0000000000000000', kind: 'restore' as const, state: 'loading', pointOfNoReturn: true };
  return {
    check: async () => {},
    refresh: async () => {},
    maintenance: () => ({ reason: 'restore', since: 0, opId: op.opId, exemptJobIds: [] }),
    epoch: () => 0,
    op: () => op,
    active: () => true,
    restoreInProgress: () => true,
    restorePastPonr: () => true,
  };
}

const LIBRARY = { 'library.name': 'Perpustakaan SMA Negeri 1' } as const;

/** The nonce of `<meta name="csp-nonce" content="…">`. */
function metaNonce(html: string): string | undefined {
  return /<meta name="csp-nonce" content="([^"]*)"/.exec(html)?.[1];
}

async function problem(res: Response): Promise<Record<string, unknown>> {
  expect(res.headers.get('content-type')).toBe(PROBLEM_TYPE);
  return (await res.json()) as Record<string, unknown>;
}

/** The invariants of every OPAC document: doctype, charset, viewport, description, the nonce in the policy, nothing inline. */
function expectDocument(html: string, res?: Response): void {
  expect(html.startsWith('<!DOCTYPE html>')).toBe(true);
  expect(html).toContain('<meta charset="utf-8"');
  expect(html).toMatch(/<meta name="viewport" content="width=device-width, initial-scale=1"/);
  expect(html).toMatch(/<meta name="description" content="[^"]+"/);
  expect(html).toContain(`<link rel="stylesheet" href="/assets/opac-${OPAC_CSS_HASH}.css"`);
  expect(html).not.toMatch(/<script/i);
  expect(html).not.toMatch(/<style/i);
  // Attributes of real tags only: an escaped library name may well contain the text ` onmouseover=`.
  expect(html).not.toMatch(/<[a-z][^>]*\sstyle=/i);
  expect(html).not.toMatch(/<[a-z][^>]*\son[a-z]+=/i);
  const nonce = metaNonce(html);
  expect(nonce).toMatch(NONCE);
  if (res !== undefined) {
    expect(res.headers.get('content-type')).toBe(HTML_TYPE);
    expect(res.headers.get('content-security-policy')).toBe(cspHeader(nonce!));
    expect(res.headers.get('x-content-type-options')).toBe('nosniff');
  }
}

describe('the OPAC routes are declared', () => {
  it('opac.home and opac.assets: GET, public, session none, maintenance allow, no audit', () => {
    const byId = (id: string) => ALL_ROUTES.find((d) => d.id === id);
    expect(byId('opac.home')).toMatchObject({ method: 'GET', path: '/', public: true, session: 'none', maintenance: 'allow', idempotency: 'none', audit: null });
    expect(byId('opac.assets')).toMatchObject({ method: 'GET', path: '/assets/:file', public: true, session: 'none', maintenance: 'allow', idempotency: 'none', audit: null });
  });
});

describe('@altis/opac-theme', () => {
  it('ACCENTS are the six names of the opac.accent setting (Task 8), and OPAC_CSS has a [data-accent] block for each', () => {
    expect([...ACCENTS]).toEqual(['teal', 'blue', 'green', 'purple', 'red', 'slate']);
    const schema = SETTINGS['opac.accent'].schema as z.ZodEnum;
    expect([...schema.options].sort()).toEqual([...ACCENTS].sort());
    for (const name of ACCENTS) {
      expect(OPAC_CSS).toMatch(new RegExp(`\\[data-accent=${name}\\]\\s*\\{[^}]*--accent:\\s*#[0-9a-f]{6}`));
    }
  });

  it('the stylesheet pulls in nothing from elsewhere (the CSP allows the app origin and data: images only)', () => {
    expect(OPAC_CSS).not.toMatch(/@import/i);
    expect(OPAC_CSS).not.toMatch(/https?:/i);
    expect(OPAC_CSS).not.toMatch(/url\(\s*['"]?(?!data:)/i);
  });

  it('OPAC_CSS_HASH is the first 10 hex digits of the SHA-256 of OPAC_CSS', () => {
    expect(OPAC_CSS_HASH).toMatch(/^[0-9a-f]{10}$/);
    expect(OPAC_CSS_HASH).toBe(sha256hex(OPAC_CSS).slice(0, 10));
  });

  // ---- Phase 2 (catalog): Task 3 (S16) ----
  it('S16: OPAC_CSS is the join of the per-owner modules in a fixed order: base, shell, pages, search, detail', () => {
    expect(OPAC_CSS_MODULES).toEqual([BASE_CSS, SHELL_CSS, PAGES_CSS, SEARCH_CSS, DETAIL_CSS, VISITS_CSS]);
    expect(Object.isFrozen(OPAC_CSS_MODULES)).toBe(true);
    expect(OPAC_CSS).toBe(joinOpacCss([BASE_CSS, SHELL_CSS, PAGES_CSS, SEARCH_CSS, DETAIL_CSS, VISITS_CSS]));
    expect(OPAC_CSS.startsWith(BASE_CSS)).toBe(true);
    // An empty module adds nothing (not even a line break); the others are joined by one.
    expect(joinOpacCss(['a{}', '', 'b{}', ''])).toBe('a{}\nb{}');
    expect(BASE_CSS).toMatch(/^:root\{/); // the 1b tokens and layout live in base.ts
  });

  it('S16: a change to any one module changes OPAC_CSS and so its hash (and the stylesheet URL)', () => {
    const modules = [BASE_CSS, SHELL_CSS, PAGES_CSS, SEARCH_CSS, DETAIL_CSS, VISITS_CSS];
    const hashes = new Set([OPAC_CSS_HASH]);
    modules.forEach((_, i) => {
      const changed = modules.map((m, j) => (j === i ? `${m}\n.x${i}{color:red}` : m));
      const css = joinOpacCss(changed);
      expect(css, `module ${i}`).not.toBe(OPAC_CSS);
      hashes.add(sha256hex(css).slice(0, 10));
    });
    expect(hashes.size).toBe(modules.length + 1);
  });
});

// The home page became the catalogue's in Phase 2 (Task 21, opac/catalog/home.tsx): it reads the catalogue, so its
// tests (the library name and title, the language, the accent, the welcome text, escaping, a nonce per request, no
// session, HEAD, campaign parameters) moved to db/opac-shell.test.ts, on a real database; the frame is in
// opac-layout.test.ts. What needs no catalogue stays here.

describe('the home page', () => {
  it('a settings failure on the home page is an error like any other: 500 HTML with the request id code', async () => {
    const { app } = setup(LIBRARY, { failing: true });
    const res = await app.request('/', { headers: { Accept: BROWSER_ACCEPT } });
    expect(res.status).toBe(500);
    expect(await res.text()).toContain(res.headers.get('x-request-id')!.slice(-8));
  });
});

describe('the stylesheet', () => {
  it('GET /assets/opac-<hash>.css: 200, text/css, immutable, the very string of OPAC_CSS, from memory', async () => {
    const { app } = setup();
    const res = await app.request(`/assets/opac-${OPAC_CSS_HASH}.css`);
    expect(res.status).toBe(200);
    expect(res.headers.get('content-type')).toBe('text/css; charset=utf-8');
    expect(res.headers.get('cache-control')).toBe(IMMUTABLE);
    expect(res.headers.get('x-content-type-options')).toBe('nosniff');
    expect(await res.text()).toBe(OPAC_CSS);
  });

  it('needs no database and no settings (a stale tab loads its CSS while the database is down)', async () => {
    const { app, settings } = setup({}, { db: false });
    expect((await app.request(`/assets/opac-${OPAC_CSS_HASH}.css`)).status).toBe(200);
    expect(settings.reads).toEqual([]);
  });

  it.each([
    'opac-0123456789.css',
    `opac-${'0'.repeat(10)}.css`,
    `opac-${OPAC_CSS_HASH}.css.map`,
    `opac-${OPAC_CSS_HASH}.js`,
    `OPAC-${OPAC_CSS_HASH}.css`,
    `opac-${OPAC_CSS_HASH.toUpperCase()}.css`,
    `opac-${OPAC_CSS_HASH.slice(0, 9)}.css`,
    'opac.css',
    '..%2Fopac.css',
    '',
  ])('/assets/%s: 404 problem NOT_FOUND', async (file) => {
    const { app } = setup();
    const res = await app.request(`/assets/${file}`);
    expect(res.status).toBe(404);
    expect(res.headers.get('cache-control')).not.toBe(IMMUTABLE);
    expect(await problem(res)).toMatchObject({ status: 404, code: 'NOT_FOUND' });
  });
});

describe('not found', () => {
  it('a path with Accept: text/html: 404 OPAC page with lang, the CSP header and a link home', async () => {
    const { app } = setup(LIBRARY);
    const res = await app.request('/tidak-ada', { headers: { Accept: 'text/html' } });
    expect(res.status).toBe(404);
    const html = await res.text();
    expectDocument(html, res);
    expect(html).toContain('<html lang="id" data-accent="teal">');
    expect(html).toContain(`<h1>${esc(t('id', 'opac.not_found.title'))}</h1>`);
    expect(html).toContain(esc(t('id', 'opac.not_found.body')));
    expect(html).toMatch(/<a [^>]*href="\/"/);
    expect(html).toContain('<meta name="robots" content="noindex"');
    expect(res.headers.get('cache-control')).toBe('no-store');
  });

  it('a browser Accept header gets the page; the page language follows ?lang, then the library', async () => {
    const { app } = setup({ ...LIBRARY, 'library.locale': 'en' });
    const lib = await app.request('/no/such/page?x=1', { headers: { Accept: BROWSER_ACCEPT } });
    expect(lib.status).toBe(404);
    const html = await lib.text();
    expect(html).toContain('<html lang="en"');
    expect(html).toContain(esc(t('en', 'opac.not_found.body')));
    const id = await (await app.request('/no/such/page?lang=id', { headers: { Accept: BROWSER_ACCEPT } })).text();
    expect(id).toContain('<html lang="id"');
    expect(id).toContain(esc(t('id', 'opac.not_found.title')));
  });

  it('the page carries the library name and accent when the settings can be read', async () => {
    const { app } = setup({ ...LIBRARY, 'opac.accent': 'red' });
    const html = await (await app.request('/x', { headers: { Accept: 'text/html' } })).text();
    expect(html).toContain('data-accent="red"');
    expect(html).toContain('Perpustakaan SMA Negeri 1');
  });

  it('settings that cannot be read, or no database at all, still give the page (Indonesian, default accent)', async () => {
    for (const o of [{ failing: true }, { db: false }]) {
      const { app } = setup(LIBRARY, o);
      const res = await app.request('/x', { headers: { Accept: 'text/html' } });
      expect(res.status).toBe(404);
      const html = await res.text();
      expect(html).toContain('<html lang="id" data-accent="teal">');
      expect(html).toContain(esc(t('id', 'opac.not_found.title')));
    }
  });

  it('Accept: application/json, */*, none, or text/html;q=0: the problem+json 404 as before', async () => {
    const { app } = setup(LIBRARY);
    const requests: Record<string, string>[] = [
      { Accept: 'application/json' },
      { Accept: '*/*' },
      { Accept: 'text/html;q=0' },
      { Accept: 'text/htmlx' },
      {},
    ];
    for (const headers of requests) {
      const res = await app.request('/tidak-ada', { headers });
      expect(res.status).toBe(404);
      expect(await problem(res)).toMatchObject({ status: 404, code: 'NOT_FOUND', traceId: res.headers.get('x-request-id') });
      expect(res.headers.get('content-security-policy')).toBeNull();
    }
  });

  it('a path under /api/ is the problem+json 404 whatever the Accept header says', async () => {
    const { app } = setup(LIBRARY);
    for (const url of ['/api/v1/tidak-ada', '/api/anything']) {
      const res = await app.request(url, { headers: { Accept: BROWSER_ACCEPT } });
      expect(res.status).toBe(404);
      expect(await problem(res)).toMatchObject({ code: 'NOT_FOUND' });
    }
  });

  it('the security headers and the request id are on the page too', async () => {
    const { app } = setup(LIBRARY);
    const res = await app.request('/x', { headers: { Accept: 'text/html' } });
    expect(res.headers.get('x-request-id')).toMatch(/^[0-9A-HJKMNP-TV-Z]{26}$/);
    expect(res.headers.get('referrer-policy')).toBe('same-origin');
  });
});

describe('the error page', () => {
  const STACK = /hunter2|srv|secret|\.ts\b|\.js\b|node_modules|Error:|\bat \w/;

  it('an unexpected error on an HTML path: 500 OPAC page with the last 8 characters of X-Request-Id, no detail', async () => {
    const { app, log } = setup(LIBRARY);
    app.get('/boom', () => {
      throw new Error('password=hunter2 at /srv/secret/path');
    });
    const res = await app.request('/boom', { headers: { Accept: BROWSER_ACCEPT } });
    expect(res.status).toBe(500);
    const html = await res.text();
    expectDocument(html, res);
    const id = res.headers.get('x-request-id')!;
    expect(html).toContain(id.slice(-8));
    expect(html).not.toContain(id);
    expect(html).toContain(`<h1>${esc(t('id', 'opac.error.title'))}</h1>`);
    expect(html).toContain(esc(t('id', 'opac.error.body', { code: id.slice(-8) })));
    expect(html).not.toMatch(STACK);
    expect(html).toContain('<meta name="robots" content="noindex"');
    expect(res.headers.get('cache-control')).toBe('no-store');
    const line = log.lines.find((l) => l.level === 'error');
    expect(line?.fields['requestId']).toBe(id);
    expect(line?.fields['path']).toBe('/boom');
  });

  it('the language follows ?lang (no settings are read for an error)', async () => {
    const { app, settings } = setup({ ...LIBRARY, 'library.locale': 'en' });
    app.get('/boom', () => {
      throw new Error('x');
    });
    const html = await (await app.request('/boom?lang=en', { headers: { Accept: 'text/html' } })).text();
    expect(html).toContain('<html lang="en"');
    expect(html).toContain(esc(t('en', 'opac.error.title')));
    const fallback = await (await app.request('/boom', { headers: { Accept: 'text/html' } })).text();
    expect(fallback).toContain('<html lang="id"');
    expect(settings.reads).toEqual([]);
  });

  it('a thrown value that is not an Error is the same page', async () => {
    const { app } = setup();
    app.get('/odd', () => {
      throw 'not an error object';
    });
    const res = await app.request('/odd', { headers: { Accept: 'text/html' } });
    expect(res.status).toBe(500);
    expect(await res.text()).toContain(res.headers.get('x-request-id')!.slice(-8));
  });

  it('a 500 DomainError is the page too', async () => {
    const { app } = setup();
    app.get('/internal', () => {
      throw new DomainError('INTERNAL', { detail: 'host db.internal refused' });
    });
    const res = await app.request('/internal', { headers: { Accept: 'text/html' } });
    expect(res.status).toBe(500);
    expect(await res.text()).not.toContain('db.internal');
  });

  it('Accept: application/json, none, or a path under /api/: the problem+json 500 as before', async () => {
    const { app } = setup();
    app.get('/boom', () => {
      throw new Error('x');
    });
    app.get('/api/v1/boom', () => {
      throw new Error('x');
    });
    for (const [url, headers] of [
      ['/boom', { Accept: 'application/json' }],
      ['/boom', {}],
      ['/api/v1/boom', { Accept: BROWSER_ACCEPT }],
    ] as const) {
      const res = await app.request(url, { headers });
      expect(res.status).toBe(500);
      expect(await problem(res)).toMatchObject({ status: 500, code: 'INTERNAL', traceId: res.headers.get('x-request-id') });
      expect(res.headers.get('content-security-policy')).toBeNull();
    }
  });

  // Phase 2 Task 3 (S17): 404, 410, 429 and 503 are the OPAC status page for a browser too (db/opac-status-pages.test.ts);
  // a JSON client still gets the code the operator needs.
  it('a 500 is the error page, 404/410/429/503 the status page; every other status keeps its problem+json', async () => {
    const { app, settings } = setup();
    app.get('/down', () => {
      throw new DomainError('DB_UNAVAILABLE');
    });
    app.get('/gone', () => {
      throw new DomainError('NOT_FOUND');
    });
    app.get('/conflict', () => {
      throw new DomainError('CONFLICT_STALE');
    });
    const down = await app.request('/down', { headers: { Accept: 'text/html' } });
    expect(down.status).toBe(503);
    expect(down.headers.get('content-type')).toBe(HTML_TYPE);
    const gone = await app.request('/gone', { headers: { Accept: 'text/html' } });
    expect(gone.status).toBe(404);
    expect(await gone.text()).toContain(esc(t('id', 'opac.not_found.title')));
    expect(settings.reads).toEqual([]); // a status page reads no setting (the 503 may be the database)
    const json = await app.request('/down', { headers: { Accept: 'application/json' } });
    expect(await problem(json)).toMatchObject({ code: 'DB_UNAVAILABLE' });
    const conflict = await app.request('/conflict', { headers: { Accept: 'text/html' } });
    expect(conflict.status).toBe(409);
    expect(await problem(conflict)).toMatchObject({ code: 'CONFLICT_STALE' });
  });

  it('while the app is not ready the phase gate still answers problem+json (the install instruction)', async () => {
    const app = createApp({ state: { phase: 'not_installed' }, version: '0.1.0', buildId: 'b1', log: recordingLogger() });
    const res = await app.request('/katalog', { headers: { Accept: BROWSER_ACCEPT } });
    expect(res.status).toBe(503);
    expect(await problem(res)).toMatchObject({ code: 'NOT_INSTALLED' });
    // The home page itself sends a browser to the install wizard (1c Task 10).
    const home = await app.request('/', { headers: { Accept: BROWSER_ACCEPT } });
    expect(home.status).toBe(302);
    expect(home.headers.get('location')).toBe('/install');
  });
});

describe('the maintenance page during a restore (1c Task 19, step 5)', () => {
  it.each(LOCALES)('GET /?lang=%s as a browser → 503, Retry-After: 30, the maintenance page in that language, no settings read', async (locale) => {
    const { app, settings } = setup(LIBRARY, { opsFence: restoringFence() });
    const res = await app.request(`/?lang=${locale}`, { headers: { Accept: BROWSER_ACCEPT } });
    expect(res.status).toBe(503);
    expect(res.headers.get('retry-after')).toBe('30');
    expect(res.headers.get('cache-control')).toBe('no-store');
    const html = await res.text();
    expectDocument(html, res);
    expect(html).toContain(`<html lang="${locale}"`);
    expect(html).toContain(esc(t(locale, 'opac.maintenance.title')));
    expect(html).toContain(esc(t(locale, 'opac.maintenance.body')));
    // The page asks the browser to look again after Retry-After; it is not the admin's, so no link to the op page.
    expect(html).toContain('<meta http-equiv="refresh" content="30"');
    expect(html).not.toContain('/admin/_update');
    // A restore may have dropped every table: nothing is read for the page.
    expect(settings.reads).toEqual([]);
  });

  it('the same request without Accept: text/html → problem+json 503 MAINTENANCE, reason restore', async () => {
    const { app } = setup(LIBRARY, { opsFence: restoringFence() });
    const res = await app.request('/', { headers: { Accept: 'application/json' } });
    expect(res.status).toBe(503);
    expect(res.headers.get('retry-after')).toBe('30');
    expect(await problem(res)).toMatchObject({ code: 'MAINTENANCE', reason: 'restore' });
  });
});

describe('renderNotFound, renderError, renderMaintenance', () => {
  const nonce = 'abc_DEF-123';

  it.each(LOCALES)('renderNotFound (%s): the title and body of the locale', (locale: Locale) => {
    const html = renderNotFound({ locale, nonce });
    expect(html).toContain(`<html lang="${locale}"`);
    expect(html).toContain(esc(t(locale, 'opac.not_found.title')));
    expect(html).toContain(esc(t(locale, 'opac.not_found.body')));
  });

  it.each(LOCALES)('renderError (%s): the code is shown and escaped, nothing else of the failure', (locale: Locale) => {
    const html = renderError({ locale, code: 'AB12CD34', nonce });
    expect(html).toContain(esc(t(locale, 'opac.error.title')));
    expect(html).toContain(esc(t(locale, 'opac.error.body', { code: 'AB12CD34' })));
    expect(renderError({ locale, code: '<i>&', nonce })).toContain('&lt;i&gt;&amp;');
  });

  it.each(LOCALES)('renderMaintenance (%s) contains opac.maintenance.title and the body', (locale: Locale) => {
    const html = renderMaintenance({ locale, nonce });
    expect(html).toContain(`<html lang="${locale}"`);
    expect(html).toContain(esc(t(locale, 'opac.maintenance.title')));
    expect(html).toContain(esc(t(locale, 'opac.maintenance.body')));
    expect(html).toContain('<meta name="robots" content="noindex"');
    expect(html).not.toContain('http-equiv');
    expect(html).not.toMatch(/<script/i);
  });

  it('renderMaintenance with retryAfterS asks the browser to look again after that many seconds (kept within 5 s to 1 h)', () => {
    expect(renderMaintenance({ locale: 'id', nonce, retryAfterS: 120 })).toContain('<meta http-equiv="refresh" content="120"');
    expect(renderMaintenance({ locale: 'id', nonce, retryAfterS: 1 })).toContain('content="5"');
    expect(renderMaintenance({ locale: 'id', nonce, retryAfterS: 90_000 })).toContain('content="3600"');
    expect(renderMaintenance({ locale: 'id', nonce, retryAfterS: 30.2 })).toContain('content="31"');
    for (const retryAfterS of [0, -5, Number.NaN, Number.POSITIVE_INFINITY]) {
      expect(renderMaintenance({ locale: 'id', nonce, retryAfterS })).not.toContain('http-equiv');
    }
  });

  it.each(LOCALES)('renderMaintenance (%s) with updateLink links the operations page (1c Task 19: pages under /admin)', (locale: Locale) => {
    const html = renderMaintenance({ locale, nonce, updateLink: true });
    expect(html).toContain('href="/admin/_update"');
    expect(html).toContain(esc(t(locale, 'opac.maintenance.update_link')));
    expect(renderMaintenance({ locale, nonce })).not.toContain('/admin/_update');
  });

  it('the page of 1c may carry the library name and accent', () => {
    const html = renderMaintenance({ locale: 'id', nonce, libraryName: 'Perpus', accent: 'blue' });
    expect(html).toContain('data-accent="blue"');
    expect(html).toContain('Perpus');
  });
});
