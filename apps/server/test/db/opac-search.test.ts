import fsp from 'node:fs/promises';
import os from 'node:os';
import path from 'node:path';
import { createSettingsCache, createXmlReader, recordUrlPath, type XmlEvent } from '@altis/core';
import { PHASE1_MIGRATIONS, runMigrations } from '@altis/db';
import { OPAC_CSS } from '@altis/opac-theme';
import { newId, t } from '@altis/shared';
import { afterAll, beforeAll, describe, expect, it } from 'vitest';
import { engineLabel, testDb, testDbContext, type TestDbHandle } from '../../../../tools/test/test-db.js';
import { finishSeededIndex, seedCatalog, wipeCatalog, type SeedRecord } from '../../../../packages/core/test/support/search-corpus.js';
import { createApp } from '../../src/app.js';
import { opacText } from '../../src/opac/catalog/messages.js';
import { OPAC_SEARCH_ROUTES } from '../../src/opac/catalog/search-routes.js';
import { ALL_ROUTES } from '../../src/routes.js';
import { createAgent, type AgentReply } from '../agent.js';
import { recordingLogger, sampleConfig } from '../support.js';

// The OPAC search and feeds (Phase 2 Task 33; spec §4.4–§4.7, §9.1, §9.6; S14, S17, M4) through the app, on the engine
// picked by ALTIS_TEST_DB:
// - /cari: result cards, facets with counts (an empty facet hidden, more than 5 values folded into <details>), a
//   selected facet carried in every other link and removable, the correction line (applied: "Menampilkan hasil
//   untuk …"; offered: "Mungkin maksud Anda …"), the rebuilding notice, "lebih dari 10.000", the page cap, invalid
//   parameters ignored (never a 4xx), GET forms and links only (no script), `noindex, follow`;
// - the feeds: /rss (the 50 newest public records from search_doc, S14) and /cari/rss (the top 50 of the same search),
//   RSS 2.0 with atom:link self, absolute URLs from config.baseUrl whatever the Host header says, max-age=900;
// - the rate limit `opac_search` (120/min per IP, /cari and /cari/rss together): the 121st request is the OPAC 429
//   page (S17).
// The query-string parsing itself is unit-tested in opac-search-params.test.ts.

const ctx = testDbContext();
/** In the past at a whole second; every request of the file falls in one minute of the rate limiter. */
const NOW = Date.UTC(2026, 9, 30, 9, 15, 5);
const DAY = 24 * 60 * 60_000;
const CONFIG = sampleConfig();
const BASE = CONFIG.baseUrl;
const HTML = { Accept: 'text/html,application/xhtml+xml,application/xml;q=0.9,*/*;q=0.8' };
const EVIL = { ...HTML, Host: 'evil.example' };

/** The events of `xml` by our own reader, which refuses anything that is not well-formed. */
function readXml(xml: string): XmlEvent[] {
  const reader = createXmlReader();
  return [...reader.write(xml), ...reader.end()];
}

/** The text of every `name` element of `xml` (inside `within` when given). */
function texts(xml: string, name: string, within?: string): string[] {
  const out: string[] = [];
  let inside = false;
  let scope = within === undefined ? 1 : 0;
  for (const e of readXml(xml)) {
    if (within !== undefined && e.type === 'open' && e.name === within) scope += 1;
    else if (within !== undefined && e.type === 'close' && e.name === within) scope -= 1;
    if (e.type === 'open' && e.name === name) inside = true;
    else if (e.type === 'close' && e.name === name) inside = false;
    else if (e.type === 'text' && inside && scope > 0) out.push(e.text);
  }
  return out;
}

/** The attributes of every `name` element of `xml`. */
const attrsOf = (xml: string, name: string): Record<string, string>[] =>
  readXml(xml).flatMap((e) => (e.type === 'open' && e.name === name ? [e.attrs] : []));

/** The markup of the `<section>` whose heading has the id `id`. */
function section(html: string, id: string): string | undefined {
  return new RegExp(`<section[^>]*aria-labelledby="${id}"[^>]*>([\\s\\S]*?)</section>`).exec(html)?.[1];
}

/** `&amp;` and the other entities JSX writes, decoded. */
const decode = (s: string): string =>
  s.replaceAll('&quot;', '"').replaceAll('&#39;', "'").replaceAll('&lt;', '<').replaceAll('&gt;', '>').replaceAll('&amp;', '&');

/** The links of `markup`: href (decoded) and visible text (tags dropped, decoded), in order. */
const links = (markup: string): { href: string; text: string; current: boolean }[] =>
  [...markup.matchAll(/<a ([^>]*)>([\s\S]*?)<\/a>/g)].map((m) => ({
    href: decode(/href="([^"]*)"/.exec(m[1]!)?.[1] ?? ''),
    text: decode(m[2]!.replace(/<[^>]+>/g, ' ').replace(/\s+/g, ' ').trim()),
    current: /aria-current="/.test(m[1]!),
  }));

/** The markup of the result card of `recordId` in `html` ('' when there is none). */
const cardOf = (html: string, recordId: string): string =>
  html
    .split('<li class="card">')
    .slice(1)
    .map((part) => part.slice(0, part.indexOf('</li>')))
    .find((card) => card.includes(`/katalog/${recordId}/`)) ?? '';

/** The record ids of the result cards of `html`, in order. */
const resultIds = (html: string): string[] =>
  [...(/<ol class="card-list[^"]*"[^>]*>([\s\S]*?)<\/ol>/.exec(html)?.[1] ?? '').matchAll(/<a class="card-title" href="\/katalog\/([^/"]+)\//g)].map((m) => m[1]!);

describe.skipIf(!ctx.available)(`OPAC search, facets and feeds [${engineLabel()}]`, () => {
  let h: TestDbHandle;
  let root: string;
  let app: ReturnType<typeof createApp>;
  let ids: Map<string, string>;
  let branchId: string;
  let readingRoom: string;
  let storeRoom: string;
  const created = new Map<string, number>();
  let peerSerial = 0;
  /** A fresh client address per call (no bucket fills up), unless one is given. */
  const get = (p: string, headers: Record<string, string> = HTML, peer?: string): Promise<AgentReply> => {
    peerSerial += 1;
    return createAgent(app, { peer: peer ?? `198.18.33.${(peerSerial % 250) + 1}` }).get(p, undefined, headers);
  };
  const id = (key: string): string => ids.get(key)!;

  const T0 = NOW - 10 * DAY;
  const SEEDS: SeedRecord[] = [
    {
      key: 'laskar',
      title: 'Laskar Pelangi',
      agents: ['Andrea Hirata'],
      subjects: ['Novel Indonesia', 'Persahabatan'],
      year: '2005',
      language: 'IND',
      classification: '899.221',
      createdAt: T0,
      items: [{ barcode: 'T33-0001' }],
    },
    {
      key: 'pemimpi',
      title: 'Sang Pemimpi',
      agents: ['Andrea Hirata'],
      subjects: ['Novel Indonesia', 'Mimpi'],
      year: '2006',
      language: 'IND',
      classification: '899.221',
      createdAt: T0 + 1000,
      items: [{ barcode: 'T33-0002', status: 'missing' }],
    },
    {
      key: 'edensor',
      title: 'Edensor',
      agents: ['Andrea Hirata'],
      subjects: ['Novel Indonesia', 'Perjalanan'],
      year: '2007',
      language: 'ENG',
      materialType: 'EBOOK',
      classification: '899.221',
      createdAt: T0 + 2000,
    },
    {
      key: 'karakter',
      title: 'Pendidikan Karakter di Sekolah',
      agents: ['Thomas Lickona'],
      subjects: ['Pendidikan', 'Karakter'],
      year: '1995',
      language: 'IND',
      classification: '370.114',
      createdAt: T0 + 3000,
      items: [{ barcode: 'T33-0003' }],
    },
    {
      key: 'filsafat',
      title: 'Filsafat Pendidikan',
      agents: ['Paul Suparno'],
      subjects: ['Pendidikan', 'Filsafat'],
      year: '2000',
      language: 'IND',
      classification: '370.1',
      createdAt: T0 + 4000,
      items: [{ barcode: 'T33-0004', collectionType: 'REF' }],
    },
    { key: 'tersembunyi', title: 'Laskar Rahasia', subjects: ['Rahasia'], language: 'IND', hidden: true, createdAt: T0 + 5000 },
    { key: 'arsip', title: 'Laskar Arsip', archived: true, createdAt: T0 + 6000 },
  ];

  async function insertRoom(name: string, isPublic: boolean): Promise<string> {
    const roomId = newId(T0);
    const code = name.toUpperCase().replace(/\s+/g, '-');
    await h.db
      .insertInto('locations')
      .values({
        id: roomId,
        branch_id: branchId,
        parent_id: null,
        kind: 'room',
        code_display: code,
        code_key: code,
        name,
        shelf_hint: null,
        class_from: null,
        class_to: null,
        map_file_id: null,
        map_x: null,
        map_y: null,
        map_w: null,
        map_h: null,
        is_public: isPublic ? 1 : 0,
        sort_order: 0,
        archived_at: null,
        version: 0,
        created_at: T0,
        created_by: null,
        updated_at: T0,
        updated_by: null,
      })
      .execute();
    return roomId;
  }

  beforeAll(async () => {
    h = await testDb();
    root = await fsp.mkdtemp(path.join(os.tmpdir(), 'altis-opac-search-'));
    await runMigrations(h, { appVersion: '0.1.0', dataDir: path.join(root, 'migrations'), migrations: PHASE1_MIGRATIONS });
    await wipeCatalog(h);
    branchId = newId(T0);
    await h.db
      .insertInto('branches')
      .values({ id: branchId, code_key: 'PUSAT', code_display: 'PUSAT', name: 'Perpustakaan Pusat', address: null, timezone: 'Asia/Jakarta', archived_at: null, created_at: T0, created_by: null, updated_at: T0, updated_by: null })
      .execute();
    readingRoom = await insertRoom('Ruang Baca', true);
    storeRoom = await insertRoom('Gudang Arsip', false);
    SEEDS[0]!.items![0]!.locationId = readingRoom;
    SEEDS[1]!.items![0]!.locationId = storeRoom;
    ids = await seedCatalog(h, SEEDS, { now: T0, branchId });
    for (const s of SEEDS) created.set(s.key, s.createdAt!);
    await finishSeededIndex(h, NOW);
    app = createApp({
      state: { phase: 'ready', db: h, config: CONFIG },
      version: '0.1.0',
      buildId: 'opac-search',
      log: recordingLogger(),
      clock: () => NOW,
      env: {},
      services: { settings: createSettingsCache({ ttlMs: 0 }) },
    });
  }, 120_000);

  afterAll(async () => {
    if (h !== undefined) await wipeCatalog(h);
    await h?.close();
    if (root !== undefined) await fsp.rm(root, { recursive: true, force: true });
  });

  it('the routes: public, session none, read, maintenance allow, no audit, no query schema; /cari and /cari/rss behind ip:opac_search', () => {
    expect(OPAC_SEARCH_ROUTES.map((d) => `${d.method} ${d.path} ${d.id} ${(d.ipLimits ?? []).join(',')}`)).toEqual([
      'GET /cari opac.search opac_search',
      'GET /cari/rss opac.search.rss opac_search',
      'GET /rss opac.rss ',
    ]);
    for (const d of OPAC_SEARCH_ROUTES) {
      expect(d, d.id).toMatchObject({ public: true, session: 'none', maintenance: 'allow', idempotency: 'none', audit: null });
      expect(d.mode ?? 'read').toBe('read');
      expect(d.query).toBeUndefined();
      expect(ALL_ROUTES).toContain(d);
    }
  });

  describe('/cari', () => {
    it('without parameters: every public record, newest first (S14), as cards; noindex, follow; no script; GET forms', async () => {
      const res = await get('/cari', EVIL);
      expect(res.status).toBe(200);
      expect(res.headers.get('content-type')).toBe('text/html; charset=utf-8');
      expect(res.text).toContain('<meta name="robots" content="noindex, follow"');
      expect(resultIds(res.text)).toEqual(['filsafat', 'karakter', 'edensor', 'pemimpi', 'laskar'].map(id));
      expect(res.text).not.toContain(id('tersembunyi'));
      expect(res.text).not.toContain(id('arsip'));
      // The card: the title linking to the record's canonical path, the main agent, the year, the material type, and the
      // availability (from the `av` facet).
      const card = cardOf(res.text, id('laskar'));
      expect(card).toContain(`href="${recordUrlPath(id('laskar'), 'Laskar Pelangi')}"`);
      expect(card).toContain('Andrea Hirata');
      expect(card).toContain('2005');
      expect(card).toContain('Buku');
      expect(card).toContain(opacText('id', 'search.card.available'));
      const pemimpiCard = cardOf(res.text, id('pemimpi'));
      expect(pemimpiCard).not.toContain(opacText('id', 'search.card.available'));
      // Every search control is a plain GET form to /cari; only the hashed shell UI script is linked, never inline script.
      expect([...res.text.matchAll(/<script\b[^>]*>/gi)].map((m) => m[0])).toEqual([expect.stringContaining('src="/assets/opac-ui-')]);
      const forms = [...res.text.matchAll(/<form ([^>]*)>/g)].map((m) => m[1]!);
      expect(forms.length).toBeGreaterThanOrEqual(3); // the search box, the order, the year
      for (const f of forms) expect(f).toMatch(/method="get" action="\/cari"/);
      expect(res.text).not.toContain('evil.example');
      expect(res.text).toContain(`${opacText('id', 'search.count', { count: '5' })}`);
      // The feed of these results is announced.
      expect(res.text).toContain('<link rel="alternate" type="application/rss+xml"');
    });

    it('facets render with their counts; an empty facet is hidden; more than 5 values fold into <details>', async () => {
      const res = await get('/cari');
      const mt = section(res.text, 'facet-mt')!;
      expect(mt).toContain(`>${t('id', 'vocab.facet.mt')}<`);
      expect(links(mt)).toEqual([
        { href: '/cari?jenis=BUKU', text: 'Buku 4', current: false },
        { href: '/cari?jenis=EBOOK', text: 'Buku elektronik 1', current: false },
      ]);
      expect(links(section(res.text, 'facet-lg')!)).toEqual([
        { href: '/cari?bahasa=IND', text: 'Indonesia 4', current: false },
        { href: '/cari?bahasa=ENG', text: 'Inggris 1', current: false },
      ]);
      expect(links(section(res.text, 'facet-av')!)).toEqual([{ href: '/cari?tersedia=1', text: `${opacText('id', 'search.facet.available')} 3`, current: false }]);
      expect(links(section(res.text, 'facet-ct')!)).toEqual([
        { href: '/cari?koleksi=UMUM', text: 'Umum 3', current: false },
        { href: '/cari?koleksi=REF', text: 'Referensi 1', current: false },
      ]);
      expect(links(section(res.text, 'facet-br')!)).toEqual([{ href: '/cari?cabang=PUSAT', text: 'Perpustakaan Pusat 4', current: false }]);
      // The location facet shows public rooms only (the store room holds an item too).
      expect(links(section(res.text, 'facet-lc')!)).toEqual([{ href: `/cari?lokasi=${readingRoom}`, text: 'Ruang Baca 1', current: false }]);
      expect(links(section(res.text, 'facet-cl')!)).toEqual([
        { href: '/cari?kelas=8', text: `800 ${opacText('id', 'shell.home.class.8')} 3`, current: false },
        { href: '/cari?kelas=3', text: `300 ${opacText('id', 'shell.home.class.3')} 2`, current: false },
      ]);
      // No public attachment: the facet is not there at all.
      expect(section(res.text, 'facet-at')).toBeUndefined();
      expect(res.text).not.toContain('id="facet-at"');
      // Subjects: 7 values, the first 5 shown, the other 2 inside "lihat semua".
      const sb = section(res.text, 'facet-sb')!;
      const all = links(sb);
      expect(all).toHaveLength(7);
      expect(all.slice(0, 2).map((l) => l.text)).toEqual(['Novel Indonesia 3', 'Pendidikan 2']);
      const folded = /<details[^>]*>([\s\S]*?)<\/details>/.exec(sb)?.[1] ?? '';
      expect(folded).toContain(`<summary>${opacText('id', 'search.facet.more', { count: '7' })}</summary>`);
      expect(links(folded)).toHaveLength(2);
      expect(links(sb.slice(0, sb.indexOf('<details'))).map((l) => l.text)).toEqual(all.slice(0, 5).map((l) => l.text));
      // Every facet with 5 values or fewer has no <details>.
      expect(mt).not.toContain('<details');
    });

    it('a selected facet narrows the results, adds its parameter to every other link, and its own link removes it', async () => {
      const res = await get('/cari?q=novel&jenis=BUKU&hal=1');
      expect(resultIds(res.text).sort()).toEqual([id('laskar'), id('pemimpi')].sort());
      // Its own facet: the selected value is current and links to the search without it.
      const mt = links(section(res.text, 'facet-mt')!);
      expect(mt).toEqual([{ href: '/cari?q=novel', text: 'Buku 2', current: true }]);
      // Every other facet keeps it.
      for (const l of links(section(res.text, 'facet-lg')!)) expect(l.href).toMatch(/^\/cari\?q=novel&jenis=BUKU&bahasa=/);
      expect(links(section(res.text, 'facet-av')!)).toEqual([{ href: '/cari?q=novel&jenis=BUKU&tersedia=1', text: `${opacText('id', 'search.facet.available')} 1`, current: false }]);
      // The active filters list it with a link that removes it, and one that removes every filter but the text.
      const active = links(section(res.text, 'filter-aktif')!);
      expect(active[0]).toMatchObject({ href: '/cari?q=novel' });
      expect(active[0]!.text).toContain(`${t('id', 'vocab.facet.mt')}: Buku`);
      expect(active.at(-1)).toMatchObject({ href: '/cari?q=novel', text: opacText('id', 'search.filters.clear') });
      // The forms carry the filter as hidden inputs (the order and the year form keep it; the search box too).
      expect(res.text).toContain('<input type="hidden" name="jenis" value="BUKU"');
      // Two filters, ?lang=en: the links keep both and the language.
      const en = await get('/cari?jenis=BUKU&kelas=8&lang=en');
      expect(resultIds(en.text).sort()).toEqual([id('laskar'), id('pemimpi')].sort());
      expect(en.text).toContain(`>${t('en', 'vocab.facet.mt')}<`);
      expect(en.text).toContain(opacText('en', 'search.facets.title'));
      expect(links(section(en.text, 'facet-lg')!)[0]!.href).toBe('/cari?jenis=BUKU&bahasa=IND&kelas=8&lang=en');
      expect(links(section(en.text, 'facet-cl')!)).toEqual([{ href: '/cari?jenis=BUKU&lang=en', text: `800 ${opacText('en', 'shell.home.class.8')} 2`, current: true }]);
    });

    it('the ids: a room, a subject, an agent (a merged agent follows to its target); a hidden room or an unknown id is ignored', async () => {
      expect(resultIds((await get(`/cari?lokasi=${readingRoom}`)).text)).toEqual([id('laskar')]);
      const novel = await h.db.selectFrom('subjects').select('id').where('term_display', '=', 'Novel Indonesia').executeTakeFirstOrThrow();
      expect(resultIds((await get(`/cari?subjek=${novel.id}`)).text)).toEqual(['edensor', 'pemimpi', 'laskar'].map(id));
      const hirata = await h.db.selectFrom('agents').select('id').where('name_display', '=', 'Andrea Hirata').executeTakeFirstOrThrow();
      const byAgent = await get(`/cari?pengarang=${hirata.id}`);
      expect(resultIds(byAgent.text)).toEqual(['edensor', 'pemimpi', 'laskar'].map(id));
      expect(links(section(byAgent.text, 'filter-aktif')!)[0]!.text).toContain('Andrea Hirata');
      // An agent merged into Hirata: its old links still find Hirata's records, and the links carry the live id.
      const old = newId(T0);
      await h.db
        .insertInto('agents')
        .values({ id: old, type: 'person', name_display: 'Hirata, A.', name_key: 'HIRATA A', dates: null, authority_source: null, authority_ref: null, note: null, merged_into: hirata.id, archived_at: T0, version: 1, created_at: T0, created_by: null, updated_at: T0, updated_by: null })
        .execute();
      const merged = await get(`/cari?pengarang=${old}`);
      expect(resultIds(merged.text)).toEqual(['edensor', 'pemimpi', 'laskar'].map(id));
      expect(merged.text).toContain(`name="pengarang" value="${hirata.id}"`);
      // (The frame's language switch keeps the request's own query, S7; the page's links are built from the echo.)
      expect(/<main[\s\S]*<\/main>/.exec(merged.text)![0]).not.toContain(old);
      expect(merged.text).toContain(`<link rel="canonical" href="${BASE}/cari?pengarang=${hirata.id}"/>`);
      // Ignored: the store room (not public), unknown ids, ill-formed values. Never a 4xx.
      const everything = resultIds((await get('/cari')).text);
      for (const q of [`lokasi=${storeRoom}`, `lokasi=${newId(T0)}`, `subjek=${newId(T0)}`, `pengarang=${newId(T0)}`, 'tahun=abc&kelas=12&jenis=NOPE&hal=-1&urut=x&lampiran=exe&tersedia=2']) {
        const res = await get(`/cari?${q}`);
        expect(res.status, q).toBe(200);
        expect(resultIds(res.text), q).toEqual(everything);
        expect(section(res.text, 'filter-aktif'), q).toBeUndefined();
      }
    });

    it('tahun, kelas, tersedia and the orders', async () => {
      expect(resultIds((await get('/cari?tahun=1990-2000')).text)).toEqual(['filsafat', 'karakter'].map(id));
      expect(resultIds((await get('/cari?tahun=2006')).text)).toEqual(['pemimpi'].map(id));
      expect(resultIds((await get('/cari?kelas=3')).text)).toEqual(['filsafat', 'karakter'].map(id));
      expect(resultIds((await get('/cari?tersedia=1')).text)).toEqual(['filsafat', 'karakter', 'laskar'].map(id));
      expect(resultIds((await get('/cari?urut=judul')).text)).toEqual(['edensor', 'filsafat', 'laskar', 'karakter', 'pemimpi'].map(id));
      expect(resultIds((await get('/cari?urut=tahun_lama')).text)).toEqual(['karakter', 'filsafat', 'laskar', 'pemimpi', 'edensor'].map(id));
      // The order form shows the order in use; relevance is offered only with a query text.
      const sorted = await get('/cari?urut=tahun_baru');
      expect(resultIds(sorted.text)).toEqual(['edensor', 'pemimpi', 'laskar', 'filsafat', 'karakter'].map(id));
      expect(sorted.text).toMatch(/<option value="tahun_baru" selected="">/);
      expect(sorted.text).not.toContain('<option value="relevansi"');
      expect((await get('/cari?q=novel')).text).toMatch(/<option value="relevansi" selected="">/);
    });

    it('a typo query shows the correction it applied, and "Cari … saja?" runs the query as typed', async () => {
      const res = await get('/cari?q=pendidkan');
      expect(res.status).toBe(200);
      expect(resultIds(res.text).sort()).toEqual([id('karakter'), id('filsafat')].sort());
      const notice = /<p class="notice notice-correction"[^>]*>([\s\S]*?)<\/p>/.exec(res.text)?.[1] ?? '';
      expect(decode(notice.replace(/<[^>]+>/g, ''))).toBe(
        `${opacText('id', 'search.correction.applied', { to: 'pendidikan' })} ${opacText('id', 'search.correction.original', { from: 'pendidkan' })}`,
      );
      expect(notice).toContain('<em>pendidikan</em>');
      const original = links(notice).find((l) => l.text.includes('pendidkan'))!;
      expect(original.href).toBe('/cari?q=pendidkan&persis=1');
      // The query as typed: nothing found, and the correction offered instead.
      const exact = await get(original.href);
      expect(resultIds(exact.text)).toEqual([]);
      expect(exact.text).toContain(opacText('id', 'search.empty.title'));
      const offer = /<p class="notice notice-correction"[^>]*>([\s\S]*?)<\/p>/.exec(exact.text)?.[1] ?? '';
      expect(decode(offer.replace(/<[^>]+>/g, ''))).toBe(opacText('id', 'search.correction.suggest', { to: 'pendidikan' }));
      expect(links(offer)).toEqual([{ href: '/cari?q=pendidikan', text: 'pendidikan', current: false }]);
    });

    it('with hits, a correction is only offered: "Mungkin maksud Anda …"', async () => {
      const res = await get(`/cari?q=${encodeURIComponent('laskar ATAU pendidkan')}&jenis=BUKU`);
      expect(resultIds(res.text)).toEqual([id('laskar')]);
      const offer = /<p class="notice notice-correction"[^>]*>([\s\S]*?)<\/p>/.exec(res.text)?.[1] ?? '';
      expect(decode(offer.replace(/<[^>]+>/g, ''))).toBe(opacText('id', 'search.correction.suggest', { to: 'laskar ATAU pendidikan' }));
      // The suggestion keeps the filters.
      expect(links(offer)[0]!.href).toBe('/cari?q=laskar+ATAU+pendidikan&jenis=BUKU');
      expect(res.text).not.toContain(opacText('id', 'search.correction.applied', { to: 'laskar ATAU pendidikan' }));
    });

    it('while the index is rebuilt (`building`), the page says the results may be incomplete', async () => {
      expect((await get('/cari')).text).not.toContain(opacText('id', 'search.building'));
      await h.db.updateTable('search_state').set({ status: 'building' }).where('id', '=', 1).execute();
      try {
        const res = await get('/cari?q=laskar');
        expect(res.status).toBe(200);
        expect(res.text).toContain(opacText('id', 'search.building'));
        expect(resultIds(res.text)).toEqual([id('laskar')]);
        expect((await get('/cari?lang=en')).text).toContain(opacText('en', 'search.building'));
      } finally {
        await h.db.updateTable('search_state').set({ status: 'ready' }).where('id', '=', 1).execute();
      }
    });

    it('nothing found: a message, no pager, the facets hidden', async () => {
      const res = await get('/cari?q=zzzzqqqq');
      expect(res.status).toBe(200);
      expect(resultIds(res.text)).toEqual([]);
      expect(res.text).toContain(opacText('id', 'search.empty.title'));
      expect(res.text).not.toContain('class="pager"');
      expect(res.text).not.toContain('class="facet"');
    });

    it('the query is text everywhere: reflected escaped, never markup', async () => {
      const evil = '"><script>alert(1)</script>';
      const res = await get(`/cari?q=${encodeURIComponent(evil)}`);
      expect(res.status).toBe(200);
      expect(res.text).not.toContain('<script>');
      expect(res.text).toContain('&quot;&gt;&lt;script&gt;');
    });

    it('ruas limits the search to a field; the page shows the text as typed, the field chosen in the band', async () => {
      expect(resultIds((await get('/cari?q=hirata&ruas=judul')).text)).toEqual([]);
      const byAuthor = await get('/cari?q=hirata&ruas=pengarang');
      expect(resultIds(byAuthor.text)).toContain(id('laskar'));
      expect(byAuthor.text).not.toContain('pengarang:hirata');
      expect(byAuthor.text).toContain('<input id="cari-q" type="search" name="q" value="hirata"');
      expect(byAuthor.text).toContain(`<option value="pengarang" selected="">${opacText('id', 'search.scope.pengarang')}</option>`);
      expect(resultIds((await get('/cari?q=pelangi&ruas=judul')).text)).toEqual([id('laskar')]);
      // A result row: the line with the class, and the substitute cover of a title without a cover.
      const card = cardOf((await get('/cari?q=pelangi')).text, id('laskar'));
      expect(card).toContain('<span class="book-cover cover-8" aria-hidden="true"><span class="cover-text"><span class="cover-title">Laskar Pelangi</span>');
      expect(card).toContain(`800 ${opacText('id', 'shell.home.class.8')}`);
    });

    it('every class the search page writes is styled', async () => {
      const pages = await Promise.all(['/cari', '/cari?q=pendidkan', '/cari?q=pendidkan&persis=1', '/cari?jenis=BUKU&q=novel', '/cari?q=zzzzqqqq'].map((p) => get(p)));
      const classes = new Set(pages.flatMap((p) => [...p.text.matchAll(/class="([^"]+)"/g)].flatMap((m) => m[1]!.split(/\s+/))));
      // Names without a rule of their own: each marks an element whose look comes from the classes or the block around it.
      for (const hook of ['akun-link', 'foot-about', 'foot-tagline', 'top-today']) classes.delete(hook);
      for (const cls of classes) expect(OPAC_CSS, cls).toContain(`.${cls}`);
    });
  });

  describe('more than 10 000 hits (bare index rows)', () => {
    const bare: string[] = [];

    beforeAll(async () => {
      const rows = Array.from({ length: 10_001 }, (_, i) => {
        const recordId = newId(T0 - DAY);
        bare.push(recordId);
        return { record_id: recordId, is_public: 1 as const, is_archived: 0 as const, t_title: '', t_agents: '', t_subjects: '', t_rest: '', title_key: `bare ${i}`, year: null, created_at: T0 - DAY + i, changed_at: T0 - DAY + i };
      });
      for (let i = 0; i < rows.length; i += 500) await h.db.insertInto('search_doc').values(rows.slice(i, i + 500)).execute();
    }, 120_000);

    afterAll(async () => {
      for (let i = 0; i < bare.length; i += 500) await h.db.deleteFrom('search_doc').where('record_id', 'in', bare.slice(i, i + 500)).execute();
    });

    it('the total reads "lebih dari 10.000", the pager stops at page 50', async () => {
      const res = await get('/cari');
      expect(res.text).toContain(opacText('id', 'search.count_capped', { count: '10.000' }));
      expect(res.text).toContain('lebih dari 10.000');
      // The facet counts come from the top 5 000 hits (§4.6), and the page says so.
      expect(res.text).toContain(opacText('id', 'search.facets.approximate', { count: '5.000' }));
      expect((await get('/cari?q=laskar')).text).not.toContain(opacText('id', 'search.facets.approximate', { count: '5.000' }));
      const pager = links(/<nav class="pager"[^>]*>([\s\S]*?)<\/nav>/.exec(res.text)?.[1] ?? '');
      expect(pager.map((l) => l.href)).toContain('/cari?hal=50');
      expect(pager.some((l) => l.href.includes('hal=51'))).toBe(false);
      expect((await get('/cari?lang=en')).text).toContain(opacText('en', 'search.count_capped', { count: '10,000' }));
    });

    it('hal=51: no results, the message to narrow the search; page 50 shows the same message', async () => {
      const res = await get('/cari?hal=51');
      expect(res.status).toBe(200);
      expect(resultIds(res.text)).toEqual([]);
      expect(res.text).toContain(opacText('id', 'search.page_cap', { max: '1.000' }));
      expect(res.text).not.toContain(opacText('id', 'search.empty.title'));
      const last = await get('/cari?hal=50');
      expect(last.text).toContain(opacText('id', 'search.page_cap', { max: '1.000' }));
      // Page 49 does not say it yet.
      expect((await get('/cari?hal=49')).text).not.toContain(opacText('id', 'search.page_cap', { max: '1.000' }));
    });
  });

  describe('feeds', () => {
    it('/rss: the newest public records from search_doc, RSS 2.0 with atom:link self, absolute URLs from baseUrl, max-age=900', async () => {
      const res = await get('/rss', { Accept: '*/*', Host: 'evil.example' });
      expect(res.status).toBe(200);
      expect(res.headers.get('content-type')).toBe('application/xml; charset=utf-8');
      expect(res.headers.get('cache-control')).toBe('public, max-age=900');
      expect(res.text).not.toContain('evil.example');
      const rss = attrsOf(res.text, 'rss');
      expect(rss).toEqual([{ version: '2.0', 'xmlns:atom': 'http://www.w3.org/2005/Atom' }]);
      expect(attrsOf(res.text, 'atom:link')).toEqual([{ href: `${BASE}/rss`, rel: 'self', type: 'application/rss+xml' }]);
      expect(texts(res.text, 'link', 'channel').slice(0, 1)).toEqual([`${BASE}/`]);
      const order = ['filsafat', 'karakter', 'edensor', 'pemimpi', 'laskar'];
      expect(texts(res.text, 'title', 'item')).toEqual(order.map((k) => SEEDS.find((s) => s.key === k)!.title));
      expect(texts(res.text, 'link', 'item')).toEqual(order.map((k) => `${BASE}${recordUrlPath(id(k), SEEDS.find((s) => s.key === k)!.title)}`));
      expect(texts(res.text, 'guid', 'item')).toEqual(texts(res.text, 'link', 'item'));
      expect(texts(res.text, 'pubDate', 'item')).toEqual(order.map((k) => new Date(created.get(k)!).toUTCString()));
      // ?lang=en: the channel in English, its self link keeps the language.
      const en = await get('/rss?lang=en', { Accept: '*/*' });
      expect(attrsOf(en.text, 'atom:link')[0]!.href).toBe(`${BASE}/rss?lang=en`);
      expect(texts(en.text, 'language')).toEqual(['en']);
      // L08: so do its items, as /berita/rss does: an English subscriber opens each record in English.
      expect(texts(en.text, 'link', 'item')).toEqual(order.map((k) => `${BASE}${recordUrlPath(id(k), SEEDS.find((s) => s.key === k)!.title)}?lang=en`));
      expect(texts(en.text, 'guid', 'item')).toEqual(texts(en.text, 'link', 'item'));
    });

    it('/cari/rss: the top results of the same search, the same parameters in its links; hidden records never', async () => {
      const res = await get('/cari/rss?q=laskar&hal=3&foo=bar', { Accept: '*/*', Host: 'evil.example' });
      expect(res.status).toBe(200);
      expect(res.headers.get('cache-control')).toBe('public, max-age=900');
      expect(texts(res.text, 'title', 'item')).toEqual(['Laskar Pelangi']);
      expect(attrsOf(res.text, 'atom:link')).toEqual([{ href: `${BASE}/cari/rss?q=laskar`, rel: 'self', type: 'application/rss+xml' }]);
      expect(texts(res.text, 'link', 'channel')[0]).toBe(`${BASE}/cari?q=laskar`);
      expect(texts(res.text, 'link', 'item')).toEqual([`${BASE}${recordUrlPath(id('laskar'), 'Laskar Pelangi')}`]);
      // L08: ?lang=en is kept on the channel link and on every item link.
      const en = await get('/cari/rss?q=laskar&lang=en', { Accept: '*/*' });
      expect(texts(en.text, 'link', 'channel')[0]).toBe(`${BASE}/cari?q=laskar&lang=en`);
      expect(texts(en.text, 'link', 'item')).toEqual([`${BASE}${recordUrlPath(id('laskar'), 'Laskar Pelangi')}?lang=en`]);
      const filtered = await get('/cari/rss?q=novel&jenis=BUKU&urut=tahun_baru', { Accept: '*/*' });
      expect(texts(filtered.text, 'title', 'item')).toEqual(['Sang Pemimpi', 'Laskar Pelangi']);
      expect(attrsOf(filtered.text, 'atom:link')[0]!.href).toBe(`${BASE}/cari/rss?q=novel&jenis=BUKU&urut=tahun_baru`);
      // A typo: the feed carries the corrected results, as the page does.
      expect(texts((await get('/cari/rss?q=pendidkan', { Accept: '*/*' })).text, 'title', 'item').sort()).toEqual(['Filsafat Pendidikan', 'Pendidikan Karakter di Sekolah']);
      // The search page links to it.
      expect((await get('/cari?q=novel&jenis=BUKU')).text).toContain('href="/cari/rss?q=novel&amp;jenis=BUKU"');
    });
  });

  describe('rate limit opac_search (120 a minute per IP, S17)', () => {
    it('/cari and /cari/rss share the bucket; the 121st request is the OPAC 429 page; /rss and other visitors are not limited', async () => {
      const peer = '198.18.133.7';
      for (let i = 0; i < 119; i += 1) expect((await get('/cari?q=laskar', HTML, peer)).status, `request ${i + 1}`).toBe(200);
      expect((await get('/cari/rss?q=laskar', { Accept: '*/*' }, peer)).status).toBe(200);
      const over = await get('/cari?q=laskar', HTML, peer);
      expect(over.status).toBe(429);
      expect(over.headers.get('content-type')).toBe('text/html; charset=utf-8');
      expect(over.text).toContain(`<h1>${opacText('id', 'shell.status.429.title')}</h1>`);
      expect(Number(over.headers.get('retry-after'))).toBeGreaterThan(0);
      expect((await get('/cari/rss?q=laskar', { Accept: '*/*' }, peer)).status).toBe(429);
      expect((await get('/rss', { Accept: '*/*' }, peer)).status).toBe(200);
      expect((await get('/cari?q=laskar', HTML, '198.18.133.8')).status).toBe(200);
    }, 120_000);
  });

  // The last block of the file: the 55 records it adds stay until afterAll.
  describe('feeds of many records', () => {
    it('both feeds stop at 50 items, newest first', async () => {
      const extra: SeedRecord[] = Array.from({ length: 55 }, (_, i) => ({ key: `seri-${i}`, title: `Seri Uji ${i}`, createdAt: NOW - DAY + i * 1000 }));
      await seedCatalog(h, extra, { now: NOW - DAY, branchId });
      const titles = texts((await get('/rss', { Accept: '*/*' })).text, 'title', 'item');
      expect(titles).toHaveLength(50);
      expect(titles.slice(0, 2)).toEqual(['Seri Uji 54', 'Seri Uji 53']);
      expect(titles.at(-1)).toBe('Seri Uji 5');
      expect(texts((await get('/cari/rss?q=seri', { Accept: '*/*' })).text, 'title', 'item')).toHaveLength(50);
    });
  });
});
