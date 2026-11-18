import fsp from 'node:fs/promises';
import os from 'node:os';
import path from 'node:path';
import { createSettingsCache, createXmlReader, indexRecords, recordUrlPath, writeSettings, type XmlEvent } from '@altis/core';
import { PHASE1_MIGRATIONS, runMigrations, withTx } from '@altis/db';
import { OPAC_CSS } from '@altis/opac-theme';
import { newId, t } from '@altis/shared';
import { afterAll, beforeAll, describe, expect, it } from 'vitest';
import { engineLabel, testDb, testDbContext, type TestDbHandle } from '../../../../tools/test/test-db.js';
import { createApp } from '../../src/app.js';
import { opacText } from '../../src/opac/catalog/messages.js';
import { OPAC_SHELL_ROUTES } from '../../src/opac/catalog/shell-routes.js';
import { w3cDate } from '../../src/opac/catalog/sitemap.js';
import { ALL_ROUTES } from '../../src/routes.js';
import { createAgent, type AgentReply } from '../agent.js';
import { recordingLogger, sampleConfig } from '../support.js';

// The OPAC shell (Phase 2 Task 21; spec §9.1, §9.4, §9.7, §9.9; S7, S13, S14, M4, M5) through the app, on the engine
// picked by ALTIS_TEST_DB:
// - the home page: search box, new titles newest first from search_doc (`opac.newTitlesCount`), promoted titles, the
//   three latest news posts, DDC classes 0-9 to /cari?kelas=N, the menu pages, JSON-LD Library + WebSite with the nonce;
// - robots.txt in both modes, `opac.indexable = false` → noindex;
// - the sitemaps: the index, the catalog files by keyset (10 000 URLs each), the pages file; out of range → 404 page;
// - /index.php: old SLiMS links through migration_map of the latest real migration's source, else home;
// - absolute URLs from config.baseUrl, whatever the Host header says.
// The frame itself (canonical, hreflang, the language switch, S7) is unit-tested in opac-layout.test.ts.

const ctx = testDbContext();
/** In the past (a published_at must be readable as already published), at a whole second. */
const NOW = Date.UTC(2026, 9, 30, 9, 15, 5);
const MINUTE = 60_000;
const HOUR = 60 * MINUTE;
const DAY = 24 * HOUR;
const CONFIG = sampleConfig();
const BASE = CONFIG.baseUrl;
const HTML = { Accept: 'text/html,application/xhtml+xml,application/xml;q=0.9,*/*;q=0.8' };
const EVIL = { ...HTML, Host: 'evil.example' };

const esc = (s: string): string => s.replace(/[&<>'"]/g, (ch) => ({ '&': '&amp;', '<': '&lt;', '>': '&gt;', "'": '&#39;', '"': '&quot;' })[ch]!);

/** The events of `xml` by our own reader, which refuses anything that is not well-formed. */
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

/** The record ids in the `/katalog/<id>/` links of `locs`. */
const recordIds = (locs: string[]): string[] => locs.map((l) => /\/katalog\/([^/]+)\//.exec(l)?.[1] ?? l);

/** The text of every `<script type="application/ld+json">` element of `html`, parsed. */
function jsonLd(html: string): Record<string, unknown>[] {
  return [...html.matchAll(/<script type="application\/ld\+json"[^>]*>([\s\S]*?)<\/script>/g)].map((m) => JSON.parse(m[1]!) as Record<string, unknown>);
}

/** The markup of the `<section>` whose heading has the id `id`. */
function section(html: string, id: string): string | undefined {
  return new RegExp(`<section[^>]*aria-labelledby="${id}"[^>]*>([\\s\\S]*?)</section>`).exec(html)?.[1];
}

/** The hrefs of the links of `markup`, in order (entity-decoded `&amp;`). */
const hrefs = (markup: string): string[] => [...markup.matchAll(/<a [^>]*href="([^"]*)"/g)].map((m) => m[1]!.replaceAll('&amp;', '&'));

describe.skipIf(!ctx.available)(`OPAC shell: home, robots, sitemaps, old SLiMS links [${engineLabel()}]`, () => {
  let h: TestDbHandle;
  let root: string;
  let app: ReturnType<typeof createApp>;
  let buku: string;
  let peerSerial = 0;
  const agent = () => createAgent(app, { peer: `198.18.21.${(peerSerial % 250) + 1}` });
  const get = (p: string, headers: Record<string, string> = HTML): Promise<AgentReply> => {
    peerSerial += 1;
    return agent().get(p, undefined, headers);
  };

  async function setSettings(patch: Record<string, unknown>): Promise<void> {
    await withTx(h, (trx) => writeSettings(trx, patch, { keyring: CONFIG.keyring, now: NOW, actorId: null }).then(() => undefined));
  }

  interface RecordSeed {
    id?: string;
    title: string;
    createdAt?: number;
    changedAt?: number;
    visible?: boolean;
    archived?: boolean;
    promoted?: boolean;
    mergedInto?: string | null;
    year?: string | null;
    cover?: string | null;
  }

  function recordRow(r: RecordSeed) {
    const created = r.createdAt ?? NOW - DAY;
    return {
      id: r.id ?? newId(created),
      material_type_id: buku,
      title: r.title,
      subtitle: null,
      responsibility: null,
      title_key: r.title.toLowerCase(),
      edition: null,
      material_detail: null,
      publisher_id: null,
      publication_place: null,
      publication_year: r.year ?? null,
      publication_date_text: null,
      physical_desc: null,
      series: null,
      classification: null,
      call_number: null,
      language_id: null,
      content_type: null,
      media_type: null,
      carrier_type: null,
      summary: null,
      notes: null,
      cover_file_id: r.cover ?? null,
      opac_visible: r.visible === false ? (0 as const) : (1 as const),
      promoted: r.promoted === true ? (1 as const) : (0 as const),
      source: 'manual',
      merged_into: r.mergedInto ?? null,
      changed_at: r.changedAt ?? created,
      archived_at: r.archived === true ? created : null,
      version: 0,
      created_at: created,
      created_by: null,
      updated_at: created,
      updated_by: null,
    };
  }

  /** Inserts the records (500 per statement) and returns their ids, in the order given. */
  async function seedRecords(seeds: RecordSeed[], o: { index?: boolean } = {}): Promise<string[]> {
    const rows = seeds.map(recordRow);
    for (let i = 0; i < rows.length; i += 500) await h.db.insertInto('records').values(rows.slice(i, i + 500)).execute();
    const ids = rows.map((r) => r.id);
    if (o.index === true) await withTx(h, (trx) => indexRecords(trx, ids, NOW));
    return ids;
  }

  interface PageSeed {
    kind: 'page' | 'news';
    slug: string;
    title: string;
    titleEn?: string;
    summary?: string;
    status?: 'draft' | 'published';
    publishedAt?: number | null;
    nav?: boolean;
    sortOrder?: number;
    archived?: boolean;
    updatedAt?: number;
  }

  async function seedPages(seeds: PageSeed[]): Promise<void> {
    for (const p of seeds) {
      const id = newId(NOW);
      const updated = p.updatedAt ?? NOW - 10 * DAY;
      await h.db
        .insertInto('pages')
        .values({
          id,
          kind: p.kind,
          slug_key: p.slug,
          status: p.status ?? 'published',
          published_at: p.publishedAt === undefined ? NOW - 2 * DAY : p.publishedAt,
          show_in_nav: p.nav === true ? 1 : 0,
          cover_file_id: null,
          sort_order: p.sortOrder ?? 0,
          archived_at: p.archived === true ? NOW - DAY : null,
          version: 0,
          created_at: NOW - 20 * DAY,
          created_by: null,
          updated_at: updated,
          updated_by: null,
        })
        .execute();
      const translations = [{ locale: 'id', title: p.title }];
      if (p.titleEn !== undefined) translations.push({ locale: 'en', title: p.titleEn });
      await h.db
        .insertInto('page_translations')
        .values(
          translations.map((tr) => ({
            page_id: id,
            locale: tr.locale,
            title: tr.title,
            summary: p.summary === undefined ? null : `${p.summary} (${tr.locale})`,
            body_format: 'markdown',
            body: 'Isi.',
            updated_at: updated,
          })),
        )
        .execute();
    }
  }

  async function clearCatalog(): Promise<void> {
    await h.db.deleteFrom('record_agents').execute();
    await h.db.deleteFrom('migration_map').execute();
    await h.db.deleteFrom('catalog_runs').execute();
    await h.db.deleteFrom('records').execute();
    await h.db.deleteFrom('page_translations').execute();
    await h.db.deleteFrom('pages').execute();
  }

  beforeAll(async () => {
    h = await testDb();
    root = await fsp.mkdtemp(path.join(os.tmpdir(), 'altis-opac-shell-'));
    await runMigrations(h, { appVersion: '0.1.0', dataDir: path.join(root, 'migrations'), migrations: PHASE1_MIGRATIONS });
    buku = (await h.db.selectFrom('material_types').select('id').where('code_key', '=', 'BUKU').executeTakeFirstOrThrow()).id;
    await setSettings({ 'library.name': 'Perpustakaan <SMA> Negeri 1', 'library.address': 'Jl. Merdeka 1\nBandung' });
    app = createApp({
      state: { phase: 'ready', db: h, config: CONFIG },
      version: '0.1.0',
      buildId: 'opac-shell',
      log: recordingLogger(),
      clock: () => NOW,
      env: {},
      // No cache: a setting this test writes is read by the next request.
      services: { settings: createSettingsCache({ ttlMs: 0 }) },
    });
  }, 120_000);

  afterAll(async () => {
    await h?.close();
    if (root !== undefined) await fsp.rm(root, { recursive: true, force: true });
  });

  it('the shell routes: public, session none, read, maintenance allow, no audit, no query schema, in ALL_ROUTES', () => {
    expect(OPAC_SHELL_ROUTES.map((d) => `${d.method} ${d.path} ${d.id}`)).toEqual([
      'GET /robots.txt opac.robots',
      'GET /sitemap.xml opac.sitemap.index',
      'GET /sitemap/katalog/:n opac.sitemap.catalog',
      'GET /sitemap/halaman opac.sitemap.pages',
      'GET /index.php opac.legacy',
    ]);
    for (const d of [...OPAC_SHELL_ROUTES, ALL_ROUTES.find((r) => r.id === 'opac.home')!]) {
      expect(d, d.id).toMatchObject({ public: true, session: 'none', maintenance: 'allow', idempotency: 'none', audit: null });
      expect(d.mode ?? 'read').toBe('read');
      expect(d.query).toBeUndefined();
      expect(ALL_ROUTES).toContain(d);
    }
  });

  describe('sitemaps of 10 001 public records, one hidden and one archived (M5)', () => {
    let publicIds: string[];
    let hidden: string;
    let archived: string;
    const changedOf = new Map<string, number>();
    const titleOf = new Map<string, string>();

    beforeAll(async () => {
      // The hidden and the archived record sort before every public one: a keyset walk that counted them would put
      // another id on page 2.
      [hidden, archived] = (await seedRecords([
        { title: 'Tersembunyi', createdAt: NOW - 3 * DAY, visible: false },
        { title: 'Diarsipkan', createdAt: NOW - 3 * DAY + 1, archived: true },
      ])) as [string, string];
      const seeds = Array.from({ length: 10_001 }, (_, i) => ({ title: `Judul ${i}`, createdAt: NOW - DAY, changedAt: NOW - DAY + i * 1000 }));
      publicIds = await seedRecords(seeds);
      publicIds.forEach((id, i) => {
        changedOf.set(id, seeds[i]!.changedAt);
        titleOf.set(id, seeds[i]!.title);
      });
      publicIds.sort();
      expect(hidden < publicIds[0]! && archived < publicIds[0]!).toBe(true);
    }, 120_000);

    afterAll(clearCatalog);

    it('/sitemap.xml lists 2 catalog files and the pages file, from baseUrl even with Host: evil.example; it parses', async () => {
      const res = await get('/sitemap.xml', EVIL);
      expect(res.status).toBe(200);
      expect(res.headers.get('content-type')).toBe('application/xml; charset=utf-8');
      expect(res.headers.get('cache-control')).toBe('public, max-age=3600');
      expect(texts(res.text, 'loc')).toEqual([`${BASE}/sitemap/katalog/1`, `${BASE}/sitemap/katalog/2`, `${BASE}/sitemap/halaman`]);
      expect(res.text).not.toContain('evil.example');
    });

    it('page 1 holds the first 10 000 public ids by id, page 2 exactly the 10 001st; the hidden and archived records appear nowhere', async () => {
      const one = await get('/sitemap/katalog/1', EVIL);
      expect(one.status).toBe(200);
      expect(one.headers.get('content-type')).toBe('application/xml; charset=utf-8');
      const locs1 = texts(one.text, 'loc');
      expect(locs1).toHaveLength(10_000);
      expect(recordIds(locs1)).toEqual(publicIds.slice(0, 10_000));
      expect(locs1.slice(0, 3)).toEqual(publicIds.slice(0, 3).map((id) => `${BASE}${recordUrlPath(id, titleOf.get(id)!)}`));

      const two = await get('/sitemap/katalog/2', EVIL);
      expect(two.status).toBe(200);
      const locs2 = texts(two.text, 'loc');
      expect(recordIds(locs2)).toEqual([publicIds[10_000]]);
      expect(texts(two.text, 'lastmod')).toEqual([w3cDate(changedOf.get(publicIds[10_000]!)!)]);
      expect(texts(two.text, 'lastmod')[0]).toMatch(/^\d{4}-\d\d-\d\dT\d\d:\d\d:\d\dZ$/);

      const index = (await get('/sitemap.xml')).text;
      for (const xml of [one.text, two.text, index]) {
        expect(xml).not.toContain(hidden);
        expect(xml).not.toContain(archived);
        expect(xml).not.toContain('evil.example');
      }
    });

    it('a page past the last, page 0 or a page that is not a number → the OPAC 404 page', async () => {
      for (const n of ['3', '0', 'abc', '01', '1.5', '-1', '9999999']) {
        const res = await get(`/sitemap/katalog/${n}`);
        expect(res.status, n).toBe(404);
        expect(res.headers.get('content-type')).toBe('text/html; charset=utf-8');
        expect(res.text).toContain(esc(t('id', 'opac.not_found.title')));
        expect(res.text).toContain('<meta name="robots" content="noindex"');
      }
    });
  });

  describe('an empty catalogue', () => {
    it('the index still lists one catalog file, and that file is an empty urlset', async () => {
      expect(texts((await get('/sitemap.xml')).text, 'loc')).toEqual([`${BASE}/sitemap/katalog/1`, `${BASE}/sitemap/halaman`]);
      const one = await get('/sitemap/katalog/1');
      expect(one.status).toBe(200);
      expect(texts(one.text, 'loc')).toEqual([]);
      expect(readXml(one.text).some((e) => e.type === 'open' && e.name === 'urlset')).toBe(true);
      expect((await get('/sitemap/katalog/2')).status).toBe(404);
    });
  });

  describe('/sitemap/halaman', () => {
    beforeAll(() =>
      seedPages([
        { kind: 'page', slug: 'tentang-kami', title: 'Tentang kami', updatedAt: NOW - 5 * DAY, publishedAt: NOW - 6 * DAY },
        { kind: 'page', slug: 'jam-buka', title: 'Jam buka', updatedAt: NOW - 5 * DAY, publishedAt: NOW - 2 * HOUR },
        { kind: 'page', slug: 'konsep', title: 'Konsep', status: 'draft', publishedAt: null },
        { kind: 'page', slug: 'nanti', title: 'Nanti', publishedAt: NOW + HOUR },
        { kind: 'page', slug: 'lama', title: 'Lama', archived: true },
        { kind: 'news', slug: 'buka-sabtu', title: 'Buka hari Sabtu', updatedAt: NOW - 3 * DAY, publishedAt: NOW - 3 * DAY },
        { kind: 'news', slug: 'besok', title: 'Besok', publishedAt: NOW + MINUTE },
      ]),
    );

    afterAll(clearCatalog);

    it('the home page, the published pages and the published news; lastmod from the later of update and publication', async () => {
      const res = await get('/sitemap/halaman', EVIL);
      expect(res.status).toBe(200);
      expect(res.headers.get('content-type')).toBe('application/xml; charset=utf-8');
      expect(texts(res.text, 'loc')).toEqual([`${BASE}/`, `${BASE}/halaman/jam-buka`, `${BASE}/halaman/tentang-kami`, `${BASE}/berita/buka-sabtu`]);
      expect(texts(res.text, 'lastmod')).toEqual([w3cDate(NOW - 2 * HOUR), w3cDate(NOW - 5 * DAY), w3cDate(NOW - 3 * DAY)]);
      expect(res.text).not.toContain('evil.example');
    });
  });

  describe('robots.txt', () => {
    afterAll(() => setSettings({ 'opac.indexable': true }));

    it('indexable: Allow /, Disallow /admin /api /cari, the sitemap from baseUrl even with Host: evil.example', async () => {
      const res = await get('/robots.txt', { Host: 'evil.example' });
      expect(res.status).toBe(200);
      expect(res.headers.get('content-type')).toBe('text/plain; charset=utf-8');
      expect(res.text).toBe(`User-agent: *\nAllow: /\nDisallow: /admin\nDisallow: /api\nDisallow: /cari\n\nSitemap: ${BASE}/sitemap.xml\n`);
      expect((await get('/', EVIL)).text).not.toContain('name="robots"');
    });

    it('opac.indexable = false: Disallow / and noindex on the home page and every other page', async () => {
      await setSettings({ 'opac.indexable': false });
      expect((await get('/robots.txt')).text).toBe('User-agent: *\nDisallow: /\n');
      expect((await get('/')).text).toContain('<meta name="robots" content="noindex"');
      expect((await get('/sitemap/katalog/9')).text).toContain('<meta name="robots" content="noindex"');
    });
  });

  describe('the home page', () => {
    let newest: string[];
    let hiddenNewest: string;
    let promoted: string[];
    let withAuthor: string;

    beforeAll(async () => {
      // 14 public records, one a minute apart (newest first), a hidden one newer than all, two promoted ones older.
      const fresh = Array.from({ length: 14 }, (_, i) => ({ title: `Buku Baru ${i}`, createdAt: NOW - (i + 1) * MINUTE, year: '2026' }));
      newest = await seedRecords(fresh, { index: true });
      [hiddenNewest] = (await seedRecords([{ title: 'Rahasia Baru', createdAt: NOW - 1000, visible: false }], { index: true })) as [string];
      promoted = await seedRecords(
        [
          { title: 'Pilihan Pertama', createdAt: NOW - 30 * DAY, promoted: true, changedAt: NOW - 2 * DAY },
          { title: 'Pilihan Kedua', createdAt: NOW - 31 * DAY, promoted: true, changedAt: NOW - 3 * DAY, cover: '01JCOVER000000000000000000' },
        ],
        { index: true },
      );
      await seedRecords([{ title: 'Pilihan Tersembunyi', createdAt: NOW - 32 * DAY, promoted: true, visible: false }], { index: true });
      withAuthor = newest[0]!;
      const agentId = newId(NOW);
      await h.db
        .insertInto('agents')
        .values({
          id: agentId,
          type: 'person',
          name_display: 'Andrea Hirata',
          name_key: 'ANDREA HIRATA',
          dates: null,
          authority_source: null,
          authority_ref: null,
          note: null,
          merged_into: null,
          archived_at: null,
          version: 0,
          created_at: NOW - DAY,
          created_by: null,
          updated_at: NOW - DAY,
          updated_by: null,
        })
        .execute();
      await h.db.insertInto('record_agents').values({ record_id: withAuthor, agent_id: agentId, role: 'aut', is_main: 1, sort_order: 0 }).execute();

      await seedPages([
        // News: four published (one hour apart), one scheduled, one draft.
        ...[1, 2, 3, 4].map((k) => ({ kind: 'news' as const, slug: `berita-${k}`, title: `Berita ${k}`, titleEn: `News ${k}`, summary: `Ringkasan ${k}`, publishedAt: NOW - k * HOUR })),
        { kind: 'news', slug: 'terjadwal', title: 'Berita Terjadwal', publishedAt: NOW + HOUR },
        { kind: 'news', slug: 'draf', title: 'Berita Draf', status: 'draft', publishedAt: null },
        // Menu: nine published pages in the menu (sort orders 9..1), one draft, one scheduled, one outside the menu.
        ...[1, 2, 3, 4, 5, 6, 7, 8, 9].map((k) => ({
          kind: 'page' as const,
          slug: `menu-${k}`,
          title: `Menu ${k}`,
          ...(k === 1 ? {} : { titleEn: `Menu EN ${k}` }),
          nav: true,
          sortOrder: k,
        })),
        { kind: 'page', slug: 'menu-draf', title: 'Menu Draf', status: 'draft', publishedAt: null, nav: true, sortOrder: 0 },
        { kind: 'page', slug: 'menu-nanti', title: 'Menu Nanti', publishedAt: NOW + HOUR, nav: true, sortOrder: 0 },
        { kind: 'page', slug: 'bukan-menu', title: 'Bukan Menu', nav: false, sortOrder: 0 },
      ]);
    }, 60_000);

    afterAll(clearCatalog);

    it('200 HTML: the library name and title, the search box, robots index, no coming-soon text, no session', async () => {
      const res = await get('/', { ...EVIL, Cookie: '__Host-altis_sid=whatever' });
      expect(res.status).toBe(200);
      expect(res.headers.get('content-type')).toBe('text/html; charset=utf-8');
      expect(res.headers.get('cache-control')).toBe('no-store');
      expect(res.headers.get('set-cookie')).toBeNull();
      const html = res.text;
      expect(html).toContain('<html lang="id" data-accent="teal">');
      expect(html).toContain(`<title>Perpustakaan &lt;SMA&gt; Negeri 1 · ${t('id', 'opac.home.title')}</title>`);
      expect(html).toContain('<h1>Perpustakaan &lt;SMA&gt; Negeri 1</h1>');
      expect(html).not.toContain('<SMA>');
      expect(html).not.toContain(esc(t('id', 'opac.home.coming_soon')));
      expect(html).not.toContain('name="robots"');
      // The search under the hero: GET /cari, an input with its visible label; the page has no second form.
      const forms = [...html.matchAll(/<form [^>]*>[\s\S]*?<\/form>/g)].map((m) => m[0]);
      expect(forms).toHaveLength(1);
      expect(html).toContain('<div class="search-band home-search">');
      expect(forms[0]).toMatch(/^<form class="search-box" role="search" method="get" action="\/cari">/);
      const input = /<input id="([^"]+)" type="search" name="q"/.exec(forms[0]!)?.[1];
      expect(input).toBe('cari-beranda');
      expect(forms[0]).toContain(`<label for="${input}" class="search-label">${esc(opacText('id', 'shell.search.label'))}</label>`);
      // The canonical link and every absolute URL from baseUrl.
      expect(html).toContain(`<link rel="canonical" href="${BASE}/"`);
      expect(html).not.toContain('evil.example');
    });

    it('new titles: the newest public records first, six of them at most (opac.newTitlesCount is 12), the hidden one left out', async () => {
      const html = (await get('/')).text;
      const titles = section(html, 'judul-baru');
      expect(titles).toBeDefined();
      expect(titles).toContain(`<h2 id="judul-baru">${esc(opacText('id', 'shell.home.new_titles'))}</h2>`);
      // "Lihat semua" in the head, then the six titles (the classes follow in the same block).
      const cards = titles!.slice(0, titles!.indexOf('</ul>'));
      expect(cards).toContain('<ul class="card-grid home-titles">');
      expect(hrefs(cards)).toEqual(['/cari', ...newest.slice(0, 6).map((id, i) => recordUrlPath(id, `Buku Baru ${i}`))]);
      expect(titles).not.toContain(hiddenNewest);
      expect(titles).toContain('Andrea Hirata');
    });

    it('promoted titles: public ones only, the latest changed first, a cover from /files', async () => {
      const html = (await get('/')).text;
      const block = section(html, 'judul-unggulan');
      expect(block).toBeDefined();
      expect(hrefs(block!)).toEqual([recordUrlPath(promoted[0]!, 'Pilihan Pertama'), recordUrlPath(promoted[1]!, 'Pilihan Kedua')]);
      expect(block).toContain('src="/files/01JCOVER000000000000000000"');
      expect(block).not.toContain('Pilihan Tersembunyi');
    });

    it('the three latest published news posts; scheduled posts and drafts left out', async () => {
      const html = (await get('/')).text;
      const block = section(html, 'berita-terbaru');
      expect(block).toBeDefined();
      // "Semua berita" in the head, then the three posts.
      expect(hrefs(block!)).toEqual(['/berita', '/berita/berita-1', '/berita/berita-2', '/berita/berita-3']);
      expect(block).toContain('Ringkasan 1 (id)');
      expect(block).toContain(`<time datetime="${new Date(NOW - HOUR).toISOString()}">`);
      expect(block).not.toContain('Terjadwal');
      expect(block).not.toContain('Draf');
    });

    it('DDC classes 0-9 link to /cari?kelas=N (M4)', async () => {
      const block = /<ul class="ddc" aria-labelledby="jelajah-kelas">([\s\S]*?)<\/ul>/.exec((await get('/')).text)?.[1];
      expect(block).toBeDefined();
      expect(hrefs(block!)).toEqual(Array.from({ length: 10 }, (_, n) => `/cari?kelas=${n}`));
      for (let n = 0; n < 10; n += 1) expect(block).toContain(esc(opacText('id', `shell.home.class.${n}` as 'shell.home.class.0')));
    });

    it('the menu: at most 8 published pages of the menu, by sort order', async () => {
      const html = (await get('/')).text;
      const menu = /<nav class="mainnav"[^>]*>([\s\S]*?)<\/nav>/.exec(html)?.[1];
      expect(menu).toBeDefined();
      // The site's own entries (Berita: news is published; Kontak: the library has an address), then the pages.
      expect(hrefs(menu!)).toEqual(['/', '/cari', '/berita', '/#kunjungi', ...[1, 2, 3, 4, 5, 6, 7, 8].map((k) => `/halaman/menu-${k}`)]);
      expect(menu).toContain(`<a href="/" aria-current="page">${esc(opacText('id', 'shell.menu.home'))}</a>`);
    });

    it('JSON-LD: every script carries the nonce of the policy; Library and WebSite with the SearchAction', async () => {
      const res = await get('/', EVIL);
      const nonce = /'nonce-([A-Za-z0-9_-]+)'/.exec(res.headers.get('content-security-policy') ?? '')?.[1];
      expect(nonce).toBeDefined();
      const scripts = [...res.text.matchAll(/<script\b[^>]*>/gi)].map((m) => m[0]);
      expect(scripts.length).toBeGreaterThanOrEqual(2);
      for (const tag of scripts) expect(tag).toContain(`nonce="${nonce}"`);
      const blocks = jsonLd(res.text);
      expect(blocks.map((b) => b['@type'])).toEqual(['Library', 'WebSite']);
      expect(blocks[0]).toMatchObject({ name: 'Perpustakaan <SMA> Negeri 1', address: 'Jl. Merdeka 1 Bandung', url: `${BASE}/` });
      expect(blocks[1]).toMatchObject({
        url: `${BASE}/`,
        potentialAction: { '@type': 'SearchAction', target: `${BASE}/cari?q={search_term_string}`, 'query-input': 'required name=search_term_string' },
      });
    });

    it('?lang=en switches the strings; a page without English keeps its Indonesian title with lang="id"', async () => {
      const html = (await get('/?lang=en')).text;
      expect(html).toContain('<html lang="en"');
      expect(html).toContain(`<title>Perpustakaan &lt;SMA&gt; Negeri 1 · ${t('en', 'opac.home.title')}</title>`);
      for (const key of ['shell.home.new_titles', 'shell.home.promoted', 'shell.home.news', 'shell.home.classes', 'shell.search.label'] as const) {
        expect(html, key).toContain(esc(opacText('en', key)));
        expect(html, key).not.toContain(esc(opacText('id', key)));
      }
      expect(html).toContain('>News 1<');
      const menu = /<nav class="mainnav"[^>]*>([\s\S]*?)<\/nav>/.exec(html)![1]!;
      expect(menu).toContain('<a href="/halaman/menu-1?lang=en" lang="id">Menu 1</a>');
      expect(menu).toContain('<a href="/halaman/menu-2?lang=en">Menu EN 2</a>');
      expect(html).toContain(`<link rel="canonical" href="${BASE}/?lang=en"`);
    });

    it('the welcome text of the page language; opac.newTitlesCount = 0 leaves the new titles out', async () => {
      await setSettings({ 'opac.welcome.id': 'Selamat datang <di> perpustakaan.', 'opac.newTitlesCount': 0 });
      try {
        const html = (await get('/')).text;
        // The welcome text is the hero's lead sentence (the OPAC home page as the library's profile site).
        expect(html).toContain('<p class="slide-lead">Selamat datang &lt;di&gt; perpustakaan.</p>');
        expect(section(html, 'judul-baru')).toBeUndefined();
        expect(section(html, 'judul-unggulan')).toBeDefined();
      } finally {
        await setSettings({ 'opac.welcome.id': null, 'opac.newTitlesCount': 12 });
      }
    });

    it('the accent of the settings, a fresh nonce per request, library.locale without ?lang, campaign parameters ignored', async () => {
      await setSettings({ 'opac.accent': 'purple', 'library.locale': 'en' });
      try {
        const first = await get('/');
        const second = await get('/?utm_source=ig&fbclid=abc');
        expect(first.text).toContain('<html lang="en" data-accent="purple">');
        expect(second.status).toBe(200);
        const nonceOf = (r: AgentReply) => /'nonce-([A-Za-z0-9_-]+)'/.exec(r.headers.get('content-security-policy') ?? '')?.[1];
        expect(nonceOf(first)).not.toBe(nonceOf(second));
        expect(second.text).toContain(`<meta name="csp-nonce" content="${nonceOf(second)}"`);
        // The canonical link and the language switch leave campaign tags out.
        expect(second.text).toContain(`<link rel="canonical" href="${BASE}/"`);
        expect(second.text).not.toContain('utm_source');
        expect((await get('/?lang=id')).text).toContain('<html lang="id"');
        expect((await get('/?lang=fr')).text).toContain('<html lang="en"');
      } finally {
        await setSettings({ 'opac.accent': 'teal', 'library.locale': 'id' });
      }
    });

    it('every class the home page writes is styled by the theme (no inline style)', async () => {
      const html = (await get('/')).text;
      const classes = new Set([...html.matchAll(/class="([^"]+)"/g)].flatMap((m) => m[1]!.split(/\s+/)));
      expect(classes.size).toBeGreaterThan(15);
      // Names without a rule of their own: each marks an element whose look comes from the classes or the block around it.
      for (const hook of ['akun-link', 'foot-about', 'foot-tagline', 'top-today', 'home-search', 'map-link']) classes.delete(hook);
      for (const cls of classes) expect(OPAC_CSS, cls).toContain(`.${cls}`);
      expect(html).not.toMatch(/<[a-z][^>]*\sstyle=/i);
    });

    it('HEAD / answers like GET without a body', async () => {
      const res = await app.request('/', { method: 'HEAD' }, { incoming: { socket: { remoteAddress: '198.18.21.251' } } });
      expect(res.status).toBe(200);
      expect(await res.text()).toBe('');
    });
  });

  describe('S7: a request for //evil.example is the 404 page whose language links start with baseUrl', () => {
    it.each([
      ['//evil.example/?lang=en', '/evil.example/'],
      ['/\\evil.example?lang=en', '/evil.example'],
    ])('%j', async (p, kept) => {
      const res = await get(p, EVIL);
      expect(res.status).toBe(404);
      const html = res.text;
      const lang = [...html.matchAll(/<a href="([^"]*)" hreflang="(id|en)"/g)].map((m) => m[1]!.replaceAll('&amp;', '&'));
      expect(lang).toEqual([`${BASE}${kept}?lang=id`, `${BASE}${kept}?lang=en`]);
      expect(html).not.toMatch(/href="\/\//);
      expect(html).not.toMatch(/https?:\/\/evil\.example/);
      expect(html).toContain(esc(t('en', 'opac.not_found.title')));
    });
  });

  describe('/index.php: old SLiMS links (§9.9, S13)', () => {
    let r7: string;
    let r8hidden: string;
    let rKampus: string;
    let rMergedTarget: string;
    const runOptions = (sourceName: string) =>
      JSON.stringify({
        sourceKind: 'dump',
        db: null,
        branchId: newId(NOW),
        priceMode: 'minor',
        sourceName,
        allowNonEmpty: false,
        dumpStagingId: null,
        files: null,
        filesStagingId: null,
        filesDir: null,
        adoptedFrom: null,
      });
    async function run(o: { sourceName: string; dryRun: boolean; status: string; createdAt: number }): Promise<string> {
      const id = newId(o.createdAt);
      await h.db
        .insertInto('catalog_runs')
        .values({
          id,
          kind: 'migration',
          status: o.status,
          dry_run: o.dryRun ? 1 : 0,
          format: null,
          options: runOptions(o.sourceName),
          summary: '{}',
          report_file_id: null,
          output_name: null,
          output_size: null,
          expires_at: null,
          job_id: null,
          created_at: o.createdAt,
          created_by: null,
          finished_at: o.status === 'running' ? null : o.createdAt + MINUTE,
        })
        .execute();
      return id;
    }
    const map = (source: string, key: string, target: string) =>
      h.db.insertInto('migration_map').values({ source, entity: 'biblio', legacy_key: key, target_id: target, run_id: newId(NOW) }).execute();

    beforeAll(async () => {
      [r7, r8hidden, rKampus, rMergedTarget] = (await seedRecords([
        { title: 'Laskar Pelangi' },
        { title: 'Disembunyikan', visible: false },
        { title: 'Bumi Manusia' },
        { title: 'Ronggeng Dukuh Paruk' },
      ])) as [string, string, string, string];
      const [merged] = await seedRecords([{ title: 'Ronggeng (ganda)', archived: true, mergedInto: rMergedTarget }]);
      await map('slims', '7', r7!);
      await map('slims', '8', r8hidden!);
      await map('slims', '10', merged!);
      await map('kampus', '7', rKampus!);
    });

    afterAll(clearCatalog);

    const location = async (p: string): Promise<string | null> => {
      const res = await get(p, {});
      expect(res.status, p).toBe(301);
      // C13: the target follows the migration map and the record's visibility, so a browser must not keep it.
      expect(res.headers.get('cache-control'), p).toBe('no-store');
      return res.headers.get('location');
    };

    it('p=show_detail&id=7 with a map row of source slims → 301 to /katalog/<id>/<slug>', async () => {
      expect(await location('/index.php?p=show_detail&id=7')).toBe(recordUrlPath(r7, 'Laskar Pelangi'));
      expect(await location('/index.php?id=7&p=show_detail&lang=en_US')).toBe(recordUrlPath(r7, 'Laskar Pelangi'));
    });

    it('an unknown id, a hidden record, an id that is not a number → 301 to /', async () => {
      for (const q of ['p=show_detail&id=9', 'p=show_detail&id=8', 'p=show_detail&id=x', 'p=show_detail', 'p=show_detail&id=7%0A']) {
        expect(await location(`/index.php?${q}`), q).toBe('/');
      }
    });

    it('a record merged into another → its target (one hop)', async () => {
      expect(await location('/index.php?p=show_detail&id=10')).toBe(recordUrlPath(rMergedTarget, 'Ronggeng Dukuh Paruk'));
    });

    it('?keywords=x → 301 to /cari?q=x; anything else → 301 to /', async () => {
      expect(await location('/index.php?search=search&keywords=laskar+pelangi')).toBe('/cari?q=laskar%20pelangi');
      expect(await location('/index.php?keywords=%2F%2Fevil.example')).toBe('/cari?q=%2F%2Fevil.example');
      for (const p of ['/index.php', '/index.php?p=member', '/index.php?keywords=', '/index.php?p=fstream&fid=3']) expect(await location(p), p).toBe('/');
    });

    it('S13: the latest succeeded real migration names the source; a later dry run, a failed or a running one does not', async () => {
      await run({ sourceName: 'kampus', dryRun: false, status: 'succeeded', createdAt: NOW - 3 * DAY });
      expect(await location('/index.php?p=show_detail&id=7')).toBe(recordUrlPath(rKampus, 'Bumi Manusia'));
      await run({ sourceName: 'x', dryRun: true, status: 'succeeded', createdAt: NOW - 2 * DAY });
      await run({ sourceName: 'y', dryRun: false, status: 'failed', createdAt: NOW - DAY });
      await run({ sourceName: 'z', dryRun: false, status: 'running', createdAt: NOW - HOUR });
      expect(await location('/index.php?p=show_detail&id=7')).toBe(recordUrlPath(rKampus, 'Bumi Manusia'));
      // The source has no row for this id: home, never another source's record.
      expect(await location('/index.php?p=show_detail&id=10')).toBe('/');
    });
  });
});
