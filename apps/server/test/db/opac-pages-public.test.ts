import fsp from 'node:fs/promises';
import os from 'node:os';
import path from 'node:path';
import { createPage, createXmlReader, renderMarkdown, sanitizedHtml, txCtx, type XmlEvent } from '@altis/core';
import { PHASE1_MIGRATIONS, runMigrations, withTx } from '@altis/db';
import { newId, t } from '@altis/shared';
import type { PageBody } from '@altis/shared/api/opac-pages';
import { afterAll, beforeAll, beforeEach, describe, expect, it } from 'vitest';
import { engineLabel, testDb, testDbContext, type TestDbHandle } from '../../../../tools/test/test-db.js';
import { createApp } from '../../src/app.js';
import { opacText } from '../../src/opac/catalog/messages.js';
import { createAgent, type AgentReply } from '../agent.js';
import { recordingLogger, sampleConfig } from '../support.js';

// The public pages of Halaman & Berita (Phase 2 Task 20; spec §9.1, §9.5, §9.6, K14; S6, S17) on the engine picked by
// ALTIS_TEST_DB:
// - `/halaman/:slug`, `/berita` and `/berita/:slug` show what is published at the request's time: a news post published
//   one hour ahead is absent from the list and the feed and 404 at its URL until the clock passes it (K14);
// - English falls back to the Indonesian text, marked `lang="id"`;
// - a body reaches the page only rendered and sanitized again (a stored body that went around the service included);
// - `/berita/rss` is RSS 2.0 with `atom:link rel="self"` from config.baseUrl, the 20 newest posts, `pubDate` from
//   `published_at` and `Cache-Control: public, max-age=900`, and `/berita/:slug` never shadows it;
// - a missing, draft or archived page is the OPAC's 404 page (S17), not a problem.

const ctx = testDbContext();
const CONFIG = sampleConfig({ db: { dialect: 'sqlite' } });
const BASE = CONFIG.baseUrl;
/** In the past: an audit entry may not be dated ahead of the real clock. */
const T0 = Date.UTC(2026, 9, 20, 2, 0, 0);
const HOUR = 3_600_000;
const MINUTE = 60_000;
const HTML = { Accept: 'text/html,application/xhtml+xml' };
const ACTOR = { type: 'cli' as const, id: null, ip: null };

/** A translation with a Markdown body. */
const tr = (title: string, body = `Isi ${title}.`, summary?: string) => ({ title, bodyFormat: 'markdown' as const, body, ...(summary === undefined ? {} : { summary }) });

/** The XML elements of `xml` as a tree (Task 5's reader: no DOCTYPE, the five entities only). */
interface XmlNode {
  name: string;
  attrs: Record<string, string>;
  children: XmlNode[];
  text: string;
}

function parseXml(xml: string): XmlNode {
  const reader = createXmlReader();
  const events: XmlEvent[] = [...reader.write(xml), ...reader.end()];
  const root: XmlNode = { name: '#document', attrs: {}, children: [], text: '' };
  const stack: XmlNode[] = [root];
  for (const e of events) {
    const top = stack[stack.length - 1]!;
    if (e.type === 'open') {
      const node: XmlNode = { name: e.name, attrs: { ...e.attrs }, children: [], text: '' };
      top.children.push(node);
      stack.push(node);
    } else if (e.type === 'close') stack.pop();
    else top.text += e.text;
  }
  return root.children[0]!;
}

const child = (n: XmlNode, name: string): XmlNode | undefined => n.children.find((c) => c.name === name);
const children = (n: XmlNode, name: string): XmlNode[] => n.children.filter((c) => c.name === name);

describe.skipIf(!ctx.available)(`Halaman & Berita on the OPAC [${engineLabel()}]`, () => {
  let h: TestDbHandle;
  let root: string;
  let app: ReturnType<typeof createApp>;
  let now = T0;

  const get = (p: string): Promise<AgentReply> => createAgent(app).get(p, undefined, HTML);

  /** A page written through the service at `at`. */
  async function page(body: Partial<PageBody> & { slug: string }, at = T0): Promise<string> {
    const full: PageBody = { kind: 'page', status: 'published', showInNav: false, sortOrder: 0, translations: { id: tr(`Halaman ${body.slug}`) }, ...body };
    return (await withTx(h, (trx) => createPage(txCtx(trx, at, ACTOR), full))).id;
  }

  beforeAll(async () => {
    h = await testDb();
    root = await fsp.realpath(await fsp.mkdtemp(path.join(os.tmpdir(), 'altis-opac-pages-')));
    await runMigrations(h, { appVersion: '0.1.0', dataDir: root, migrations: PHASE1_MIGRATIONS });
    app = createApp({ state: { phase: 'ready', db: h, config: CONFIG }, version: '0.1.0', buildId: 'b', log: recordingLogger(), clock: () => now, dataDir: root });
  });

  beforeEach(() => {
    now = T0 + 10 * MINUTE;
  });

  afterAll(async () => {
    await h?.close();
    if (root !== undefined) await fsp.rm(root, { recursive: true, force: true });
  });

  describe('/halaman/:slug', () => {
    it('shows a published page: its title, its body rendered, a canonical link from baseUrl, indexable', async () => {
      const md = '## Layanan\n\nKami buka **setiap hari**.\n';
      await page({ slug: 'tentang-kami', translations: { id: tr('Tentang kami', md, 'Profil singkat perpustakaan') } });
      const res = await get('/halaman/tentang-kami');
      expect(res.status, res.text).toBe(200);
      expect(res.headers.get('content-type')).toBe('text/html; charset=utf-8');
      expect(res.text).toContain('<html lang="id"');
      expect(res.text).toContain('<title>Tentang kami</title>');
      expect(res.text).toContain('<h1>Tentang kami</h1>');
      expect(res.text).toContain(renderMarkdown(md));
      expect(res.text).toContain(`<link rel="canonical" href="${BASE}/halaman/tentang-kami"`);
      expect(res.text).toContain('<meta name="description" content="Profil singkat perpustakaan"');
      expect(res.text).not.toMatch(/<meta name="robots"/);
    });

    it('in English: the English text when there is one; else the Indonesian one, marked lang="id"', async () => {
      await page({ slug: 'jam-buka', translations: { id: tr('Jam buka', 'Senin sampai Jumat.'), en: tr('Opening hours', 'Monday to Friday.') } });
      await page({ slug: 'sejarah', translations: { id: tr('Sejarah', 'Didirikan tahun 1950.') } });

      const both = await get('/halaman/jam-buka?lang=en');
      expect(both.status, both.text).toBe(200);
      expect(both.text).toContain('<html lang="en"');
      expect(both.text).toContain('<h1>Opening hours</h1>');
      expect(both.text).toContain('Monday to Friday.');
      expect(both.text).not.toMatch(/<article[^>]* lang=/);
      expect(both.text).not.toContain(opacText('en', 'pages.fallback'));

      const fallback = await get('/halaman/sejarah?lang=en');
      expect(fallback.status, fallback.text).toBe(200);
      expect(fallback.text).toContain('<html lang="en"');
      const article = /<article[^>]*>[\s\S]*<\/article>/.exec(fallback.text)?.[0] ?? '';
      expect(article).toMatch(/^<article[^>]* lang="id"/);
      expect(article).toContain('<h1>Sejarah</h1>');
      expect(article).toContain('Didirikan tahun 1950.');
      expect(fallback.text).toContain(opacText('en', 'pages.fallback'));
      // In Indonesian, no mark and no note.
      const id = await get('/halaman/sejarah');
      expect(id.text).not.toMatch(/<article[^>]* lang=/);
      expect(id.text).not.toContain(opacText('id', 'pages.fallback'));
    });

    it('a stored body reaches the page only sanitized again (S6), even one written around the service', async () => {
      const id = await page({ slug: 'migrasi' });
      const raw = '<p>Halo</p><script>alert(document.cookie)</script><img src="https://evil.example/t.gif" onerror="x()"><a href="javascript:alert(1)">klik</a>';
      await h.db.updateTable('page_translations').set({ body_format: 'html', body: raw }).where('page_id', '=', id).where('locale', '=', 'id').execute();
      const res = await get('/halaman/migrasi');
      expect(res.status, res.text).toBe(200);
      expect(res.text).toContain(sanitizedHtml(raw));
      expect(res.text).not.toContain('alert(document.cookie)');
      expect(res.text).not.toContain('evil.example');
      expect(res.text).not.toContain('javascript:');
      expect(res.text).not.toContain('onerror');
    });

    it('unknown, draft, scheduled, archived or ill-formed: the 404 page, noindex (S17)', async () => {
      const archived = await page({ slug: 'diarsipkan' });
      await h.db.updateTable('pages').set({ archived_at: T0 }).where('id', '=', archived).execute();
      await page({ slug: 'konsep', status: 'draft' });
      await page({ slug: 'nanti', publishedAt: now + HOUR });
      await page({ slug: 'sebagai-berita', kind: 'news' });
      for (const p of ['/halaman/tidak-ada', '/halaman/diarsipkan', '/halaman/konsep', '/halaman/nanti', '/halaman/sebagai-berita', '/halaman/Huruf_Besar']) {
        const res = await get(p);
        expect(res.status, p).toBe(404);
        expect(res.headers.get('content-type'), p).toBe('text/html; charset=utf-8');
        expect(res.text, p).toContain(`<h1>${t('id', 'opac.not_found.title')}</h1>`);
        expect(res.text, p).toContain('<meta name="robots" content="noindex"');
      }
    });
  });

  describe('/berita and /berita/:slug (K14)', () => {
    it('a news post published one hour ahead is absent from the list and the feed, and 404, until the clock passes it', async () => {
      const at = T0 + 24 * HOUR;
      now = at;
      await page({ kind: 'news', slug: 'lomba-baca-puisi', publishedAt: at + HOUR, translations: { id: tr('Lomba baca puisi', 'Daftarkan diri Anda.', 'Lomba untuk pelajar') } }, at);

      const before = { list: await get('/berita'), feed: await get('/berita/rss'), post: await get('/berita/lomba-baca-puisi') };
      expect(before.list.status).toBe(200);
      expect(before.list.text).not.toContain('lomba-baca-puisi');
      expect(before.feed.status).toBe(200);
      expect(before.feed.text).not.toContain('lomba-baca-puisi');
      expect(before.post.status).toBe(404);

      now = at + HOUR;
      const after = { list: await get('/berita'), feed: await get('/berita/rss'), post: await get('/berita/lomba-baca-puisi') };
      expect(after.list.text).toContain('href="/berita/lomba-baca-puisi"');
      expect(after.list.text).toContain('Lomba untuk pelajar');
      expect(after.feed.text).toContain(`${BASE}/berita/lomba-baca-puisi`);
      expect(after.post.status, after.post.text).toBe(200);
      expect(after.post.text).toContain('<h1>Lomba baca puisi</h1>');
      expect(after.post.text).toContain(`datetime="${new Date(at + HOUR).toISOString()}"`);
      expect(after.post.text).toContain(`<link rel="canonical" href="${BASE}/berita/lomba-baca-puisi"`);
    });

    it('the list: 10 per page, newest first, `hal` pages it, past the last page is 404, an odd `hal` is page 1', async () => {
      const at = T0 + 48 * HOUR;
      for (let i = 0; i < 13; i++) {
        await page({ kind: 'news', slug: `warta-${String(i).padStart(2, '0')}`, publishedAt: at + i * MINUTE, translations: { id: tr(`Warta ${i}`) } }, at);
      }
      now = at + HOUR;
      const first = await get('/berita');
      expect(first.status, first.text).toBe(200);
      const slugsOn = (html: string): string[] => [...html.matchAll(/href="\/berita\/(warta-\d\d)"/g)].map((m) => m[1]!);
      expect(slugsOn(first.text).slice(0, 10)).toEqual(['warta-12', 'warta-11', 'warta-10', 'warta-09', 'warta-08', 'warta-07', 'warta-06', 'warta-05', 'warta-04', 'warta-03']);
      expect(first.text).toContain('href="/berita?hal=2"');
      expect(first.text).toContain(`<link rel="alternate" type="application/rss+xml"`);
      const second = await get('/berita?hal=2');
      expect(second.status).toBe(200);
      expect(slugsOn(second.text).slice(0, 3)).toEqual(['warta-02', 'warta-01', 'warta-00']);
      expect(second.text).toContain(`<link rel="canonical" href="${BASE}/berita?hal=2"`);
      expect(second.text).toContain('href="/berita"');
      // 13 or 14 posts (with the K14 test's): two pages; the third is past the last.
      expect(second.text).not.toContain('href="/berita?hal=3"');
      expect((await get('/berita?hal=3')).status).toBe(404);
      const odd = await get('/berita?hal=abc');
      expect(odd.status).toBe(200);
      expect(slugsOn(odd.text)[0]).toBe('warta-12');
      // In English: the links keep the language, an Indonesian-only post is marked.
      const en = await get('/berita?lang=en');
      expect(en.text).toContain('href="/berita/warta-12?lang=en"');
      expect(en.text).toMatch(/<article lang="id">\s*<h2><a href="\/berita\/warta-12\?lang=en">Warta 12<\/a><\/h2>/);
    });
  });

  describe('/berita/rss', () => {
    it('RSS 2.0 with atom:link rel="self" from baseUrl, the 20 newest posts, pubDate = published_at, cached 15 minutes', async () => {
      const at = T0 + 72 * HOUR;
      for (let i = 0; i < 22; i++) {
        await page(
          { kind: 'news', slug: `kabar-${String(i).padStart(2, '0')}`, publishedAt: at + i * MINUTE, translations: { id: tr(`Kabar & berita ${i}`, 'Isi.', `Ringkas <${i}>`), en: tr(`News ${i}`) } },
          at,
        );
      }
      now = at + HOUR;
      const res = await get('/berita/rss');
      expect(res.status, res.text).toBe(200);
      expect(res.headers.get('cache-control')).toBe('public, max-age=900');
      expect(res.headers.get('content-type')).toMatch(/xml/);
      const rss = parseXml(res.text);
      expect([rss.name, rss.attrs['version'], rss.attrs['xmlns:atom']]).toEqual(['rss', '2.0', 'http://www.w3.org/2005/Atom']);
      const channel = child(rss, 'channel')!;
      const self = child(channel, 'atom:link')!;
      expect(self.attrs).toEqual({ href: `${BASE}/berita/rss`, rel: 'self', type: 'application/rss+xml' });
      expect(child(channel, 'link')?.text).toBe(`${BASE}/berita`);
      expect(child(channel, 'language')?.text).toBe('id');
      const items = children(channel, 'item');
      expect(items).toHaveLength(20);
      const newest = items[0]!;
      expect(child(newest, 'title')?.text).toBe('Kabar & berita 21');
      expect(child(newest, 'description')?.text).toBe('Ringkas <21>');
      expect(child(newest, 'link')?.text).toBe(`${BASE}/berita/kabar-21`);
      expect(child(newest, 'guid')).toMatchObject({ attrs: { isPermaLink: 'true' }, text: `${BASE}/berita/kabar-21` });
      expect(child(newest, 'pubDate')?.text).toBe(new Date(at + 21 * MINUTE).toUTCString());
      expect(items.map((i) => child(i, 'link')?.text)).not.toContain(`${BASE}/berita/kabar-01`);

      const en = parseXml((await get('/berita/rss?lang=en')).text);
      const enChannel = child(en, 'channel')!;
      expect(child(enChannel, 'atom:link')?.attrs['href']).toBe(`${BASE}/berita/rss?lang=en`);
      expect(child(enChannel, 'language')?.text).toBe('en');
      expect(child(children(enChannel, 'item')[0]!, 'title')?.text).toBe('News 21');
      expect(child(children(enChannel, 'item')[0]!, 'link')?.text).toBe(`${BASE}/berita/kabar-21?lang=en`);
    });

    it('is not shadowed by /berita/:slug, even by a news row named rss that went around the service', async () => {
      const id = newId();
      await h.db
        .insertInto('pages')
        .values({ id, kind: 'news', slug_key: 'rss', status: 'published', published_at: T0, show_in_nav: 0, cover_file_id: null, sort_order: 0, archived_at: null, created_at: T0, created_by: null, updated_at: T0, updated_by: null })
        .execute();
      await h.db.insertInto('page_translations').values({ page_id: id, locale: 'id', title: 'Bukan umpan', summary: null, body_format: 'markdown', body: 'x', updated_at: T0 }).execute();
      const res = await get('/berita/rss');
      expect(res.status).toBe(200);
      expect(res.headers.get('content-type')).toMatch(/xml/);
      expect(parseXml(res.text).name).toBe('rss');
      expect(res.text).not.toContain('<html');
    });
  });
});
