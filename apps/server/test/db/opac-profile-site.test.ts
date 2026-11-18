import fsp from 'node:fs/promises';
import os from 'node:os';
import path from 'node:path';
import { createPage, createSettingsCache, indexRecords, refreshClassActivity, refreshPopularTitles, txCtx, writeSettings } from '@altis/core';
import { PHASE1_MIGRATIONS, runMigrations, withTx } from '@altis/db';
import { newId, normalizeKey } from '@altis/shared';
import { OPAC_HOME_BLOCKS, OPAC_HOME_DEFAULT, type OpacHomeBlock, type OpacHomeContent } from '@altis/shared/api/opac-home';
import type { PageBody } from '@altis/shared/api/opac-pages';
import { afterAll, beforeAll, describe, expect, it } from 'vitest';
import { engineLabel, testDb, testDbContext, type TestDbHandle } from '../../../../tools/test/test-db.js';
import { createApp } from '../../src/app.js';
import { HOME_GALLERY } from '../../src/opac/catalog/home.js';
import { opacText } from '../../src/opac/catalog/messages.js';
import { OPAC_SLIDER_FILE } from '../../src/opac/slider.js';
import { createAgent, type AgentReply } from '../agent.js';
import { recordingLogger, sampleConfig } from '../support.js';

// The library's site on the OPAC, through the app on the engine picked by ALTIS_TEST_DB: the home page's blocks (each
// only with content and while switched on), its figures (counts, never a person), the news with its categories and
// events, the profile page and the gallery. No datum of a member or a visitor reaches any of these pages.

const ctx = testDbContext();
/** A Sunday noon in Asia/Jakarta, in the past: an audit entry may not be dated ahead of the real clock. */
const NOW = Date.UTC(2026, 10, 15, 5, 0, 0);
const HOUR = 3_600_000;
const DAY = 24 * HOUR;
const CONFIG = sampleConfig();
const HTML = { Accept: 'text/html' };
const ACTOR = { type: 'cli' as const, id: null, ip: null };

/** The markup of the `<section>` whose heading has the id `id`. */
function section(html: string, id: string): string | undefined {
  return new RegExp(`<section[^>]*aria-labelledby="${id}"[^>]*>([\\s\\S]*?)</section>`).exec(html)?.[1];
}

/** The first group of `pattern` in `html`; '' when it does not match. */
const part = (html: string, pattern: RegExp): string => pattern.exec(html)?.[1] ?? '';

/** The id of the heading each home block's section is labelled by. */
const BLOCK_HEADING: Readonly<Record<OpacHomeBlock, string>> = {
  about: 'tentang-judul',
  services: 'layanan-judul',
  newTitles: 'judul-baru',
  popular: 'judul-populer',
  classes: 'jelajah-kelas',
  promoted: 'judul-unggulan',
  readingClasses: 'kelas-rajin',
  news: 'berita-terbaru',
  visit: 'kunjungi-judul',
};

const heading = (id: string): string => ` id="${id}"`;

interface Fixture {
  h: TestDbHandle;
  root: string;
  app: ReturnType<typeof createApp>;
}

async function fixture(name: string): Promise<Fixture> {
  const h = await testDb();
  const root = await fsp.mkdtemp(path.join(os.tmpdir(), `altis-${name}-`));
  await runMigrations(h, { appVersion: '0.1.0', dataDir: path.join(root, 'migrations'), migrations: PHASE1_MIGRATIONS });
  const app = createApp({
    state: { phase: 'ready', db: h, config: CONFIG },
    version: '0.1.0',
    buildId: name,
    log: recordingLogger(),
    clock: () => NOW,
    env: {},
    // Every request reads the settings again, so a test's change shows at once.
    services: { settings: createSettingsCache({ ttlMs: 0 }) },
  });
  return { h, root, app };
}

async function dispose(f: Fixture | undefined): Promise<void> {
  await f?.h.close();
  if (f !== undefined) await fsp.rm(f.root, { recursive: true, force: true });
}

describe.skipIf(!ctx.available)(`the library's site without content [${engineLabel()}]`, () => {
  let f: Fixture;
  const get = (p: string): Promise<AgentReply> => createAgent(f.app).get(p, undefined, HTML);

  beforeAll(async () => {
    f = await fixture('opac-site-empty');
  }, 120_000);

  afterAll(() => dispose(f));

  it('the home page shows no block that has nothing to show: only the hero, the search and the subjects by class', async () => {
    const res = await get('/');
    expect(res.status, res.text).toBe(200);
    const html = res.text;
    expect(html).toContain('<section class="hero"');
    expect(html).toContain('id="cari-beranda"');
    for (const block of OPAC_HOME_BLOCKS) {
      if (block === 'classes') expect(html).toContain(heading(BLOCK_HEADING[block]));
      else expect(html, block).not.toContain(heading(BLOCK_HEADING[block]));
    }
    for (const absent of [' id="tentang"', ' id="layanan"', ' id="kunjungi"', 'class="figures', 'class="svc-grid"', 'class="gallery"', 'class="news-rows"', 'class="agenda"', 'class="visit', 'class="cta"']) {
      expect(html, absent).not.toContain(absent);
    }
    // Nothing links to a page that does not exist.
    expect(html).not.toContain('href="/profil');
    expect(html).not.toContain('href="/galeri');
    expect(html).not.toContain('href="/berita');
  });

  it('/profil and /galeri are the 404 page; /berita says there is no news', async () => {
    for (const p of ['/profil', '/galeri', '/profil?lang=en', '/galeri?lang=en']) {
      const res = await get(p);
      expect(res.status, p).toBe(404);
      expect(res.text, p).toContain('<meta name="robots" content="noindex"');
    }
    const news = await get('/berita');
    expect(news.status, news.text).toBe(200);
    expect(news.text).toContain(`<p>${opacText('id', 'pages.news.empty')}</p>`);
    expect(news.text).not.toContain('class="news-rows"');
    expect(news.text).not.toContain('class="agenda"');
  });
});

describe.skipIf(!ctx.available)(`the library's site with content [${engineLabel()}]`, () => {
  let f: Fixture;
  let peer = 0;
  const get = (p: string): Promise<AgentReply> => {
    peer += 1;
    return createAgent(f.app, { peer: `198.18.41.${(peer % 250) + 1}` }).get(p, undefined, HTML);
  };

  /** What no public page may show: every datum of a member or a visitor. */
  const secrets: string[] = [];
  const galleryIds: string[] = [];
  let facilityId = '';
  let home: OpacHomeContent;

  const EVENT_START = NOW + 3 * DAY;
  const EVENT_PLACE = 'Ruang Baca Lantai Dua';
  const PAST_PLACE = 'Aula Lama';

  async function setSettings(patch: Record<string, unknown>): Promise<void> {
    await withTx(f.h, (trx) => writeSettings(trx, patch, { keyring: CONFIG.keyring, now: NOW, actorId: null }).then(() => undefined));
  }

  const setHome = (content: OpacHomeContent): Promise<void> => setSettings({ 'opac.home': content });

  /** A published news post written through the service. */
  async function post(body: Partial<PageBody> & { slug: string; title: string }, at: number): Promise<void> {
    const { title, ...rest } = body;
    const full: PageBody = {
      kind: 'news',
      status: 'published',
      publishedAt: at,
      showInNav: false,
      sortOrder: 0,
      translations: { id: { title, bodyFormat: 'markdown', body: `Isi ${title}.`, summary: `Ringkasan ${title}` } },
      ...rest,
    };
    await withTx(f.h, (trx) => createPage(txCtx(trx, at, ACTOR), full));
  }

  beforeAll(async () => {
    f = await fixture('opac-site-full');
    const db = f.h.db;
    await setSettings({ 'library.name': 'Perpustakaan Contoh', 'library.address': 'Jl. Pendidikan 1\nKota Contoh' });
    const buku = (await db.selectFrom('material_types').select('id').where('code_key', '=', 'BUKU').executeTakeFirstOrThrow()).id;
    const umum = (await db.selectFrom('collection_types').select('id').where('code_key', '=', 'UMUM').executeTakeFirstOrThrow()).id;
    const siswa = (await db.selectFrom('member_types').select('id').where('code_key', '=', 'SISWA').executeTakeFirstOrThrow()).id;
    const branchId = newId(NOW);
    await db.insertInto('branches').values({ id: branchId, code_key: 'PST', code_display: 'PST', name: 'Pusat', timezone: 'Asia/Jakarta', created_at: NOW, updated_at: NOW }).execute();

    // Seven members: five active ones (the figure), one whose card has run out, one who is not active.
    const memberIds: string[] = [];
    for (let i = 0; i < 7; i += 1) {
      const id = newId(NOW);
      const no = `ANG-88${i}`;
      const name = `Rahasia Anggota ${i}`;
      const phone = `0812-5550-10${i}`;
      const email = `anggota.rahasia${i}@anggota.example`;
      await db
        .insertInto('members')
        .values({
          id,
          member_no_display: no,
          member_no_key: normalizeKey(no),
          member_type_id: siswa,
          status: i === 6 ? 'inactive' : 'active',
          name,
          name_key: name.toLowerCase(),
          class_name: 'X-1',
          phone,
          email,
          joined_on: '2025-01-01',
          valid_from: '2025-01-01',
          expires_on: i === 5 ? '2026-01-01' : '2099-01-01',
          created_at: NOW,
          updated_at: NOW,
        })
        .execute();
      memberIds.push(id);
      secrets.push(id, no, name, phone, email);
    }

    // Two titles; the second is promoted and was borrowed by the five active members (class X-1).
    const records: string[] = [];
    for (const [i, title] of ['Laskar Pelangi', 'Bumi Manusia'].entries()) {
      const id = newId(NOW);
      await db
        .insertInto('records')
        .values({ id, material_type_id: buku, title, title_key: title.toLowerCase(), source: 'manual', promoted: i, changed_at: NOW, created_at: NOW, updated_at: NOW })
        .execute();
      const itemId = newId(NOW);
      await db
        .insertInto('items')
        .values({ id: itemId, record_id: id, branch_id: branchId, barcode_display: `B-${i}`, barcode_key: `B-${i}`, collection_type_id: umum, status: 'available', currency: 'IDR', created_at: NOW, updated_at: NOW })
        .execute();
      records.push(id);
      if (i === 0) continue;
      for (let k = 0; k < 5; k += 1) {
        const at = NOW - (5 + k) * DAY;
        const on = new Date(at).toISOString().slice(0, 10);
        await db
          .insertInto('loans')
          .values({
            id: newId(at),
            item_id: itemId,
            open_item_id: null,
            record_id: id,
            member_id: memberIds[k]!,
            branch_id: branchId,
            loaned_on: on,
            loaned_at: at,
            due_on: on,
            returned_on: on,
            returned_at: at + HOUR,
            return_branch_id: branchId,
            outcome: 'returned',
            loan_days: 7,
            renew_limit: 1,
            grace_days: 0,
            fine_per_day_minor: 0,
            currency: 'IDR',
            source: 'desk',
            stat_class_name: 'X-1',
            created_at: at,
            updated_at: at,
          })
          .execute();
      }
    }
    await withTx(f.h, (trx) => indexRecords(trx, records, NOW));
    await refreshPopularTitles(f.h, NOW);
    await refreshClassActivity(f.h, NOW);

    // Five visits: three of this year (the figure), one voided, one of last year.
    const visits: { at: number; member: string | null; guest: string | null; institution: string | null; voided: boolean }[] = [
      { at: NOW - 2 * DAY, member: memberIds[0]!, guest: null, institution: null, voided: false },
      { at: NOW - 3 * DAY, member: null, guest: 'Tamu Rahasia Satu', institution: 'Lembaga Rahasia Satu', voided: false },
      { at: Date.UTC(2026, 0, 2, 3, 0, 0), member: memberIds[1]!, guest: null, institution: null, voided: false },
      { at: NOW - 4 * DAY, member: null, guest: 'Tamu Rahasia Dua', institution: null, voided: true },
      { at: Date.UTC(2025, 5, 1, 3, 0, 0), member: null, guest: 'Tamu Rahasia Tiga', institution: null, voided: false },
    ];
    for (const v of visits) {
      await db
        .insertInto('visits')
        .values({
          id: newId(v.at),
          branch_id: branchId,
          location_id: null,
          visited_on: new Date(v.at + 7 * HOUR).toISOString().slice(0, 10),
          visited_at: v.at,
          source: 'desk',
          member_id: v.member,
          member_type_id: v.member === null ? null : siswa,
          accred_group: null,
          class_name: null,
          guest_name: v.guest,
          guest_institution: v.institution,
          purpose: null,
          station_id: null,
          day_key: null,
          note: null,
          voided_at: v.voided ? v.at + HOUR : null,
          voided_by: null,
          created_by: null,
        })
        .execute();
      if (v.guest !== null) secrets.push(v.guest);
      if (v.institution !== null) secrets.push(v.institution);
    }

    // News: an event ahead, an event that is over, a post of another category, a post without one.
    await post({ slug: 'bedah-buku', title: 'Bedah buku bulan ini', category: 'agenda', eventStartsAt: EVENT_START, eventEndsAt: EVENT_START + 2 * HOUR, eventPlace: EVENT_PLACE }, NOW - 4 * HOUR);
    await post({ slug: 'lomba-mendongeng', title: 'Lomba mendongeng', category: 'agenda', eventStartsAt: NOW - 10 * DAY, eventEndsAt: NOW - 10 * DAY + HOUR, eventPlace: PAST_PLACE }, NOW - 3 * HOUR);
    await post({ slug: 'buku-baru', title: 'Buku baru November', category: 'collection' }, NOW - 2 * HOUR);
    await post({ slug: 'libur-semester', title: 'Libur semester' }, NOW - HOUR);

    facilityId = newId(NOW);
    for (let i = 0; i < 6; i += 1) galleryIds.push(newId(NOW + i + 1));
    home = {
      ...OPAC_HOME_DEFAULT,
      about: {
        text: { id: 'Perpustakaan sekolah untuk semua warga.', en: null },
        photo: null,
        founded: 1987,
        librarians: 2,
        history: { id: 'Berdiri sebagai ruang baca kecil.\n\nPindah ke gedung sendiri.', en: null },
      },
      services: [{ title: 'Peminjaman', text: 'Pinjam hingga tujuh hari.' }],
      facilities: [{ fileId: facilityId, alt: 'Ruang baca utama', caption: 'Meja baca dan rak terbuka' }],
      hours: [{ days: 'Senin–Jumat', time: '07.00–15.00', weekdays: [1, 2, 3, 4, 5] }],
      blocks: { ...OPAC_HOME_DEFAULT.blocks, readingClasses: true },
      contact: { phone: '(021) 555-0100', email: 'perpustakaan@sekolah.example' },
      timeline: [
        { year: 1987, text: { id: 'Ruang baca dibuka', en: 'The reading room opens' } },
        { year: 2005, text: { id: 'Gedung baru diresmikan', en: null } },
      ],
      vision: { id: 'Menjadi pusat belajar warga sekolah.', en: 'To be the school community’s place to learn.' },
      mission: [
        { id: 'Menyediakan koleksi bermutu', en: 'Provide a good collection' },
        { id: 'Menumbuhkan minat baca', en: null },
      ],
      staff: [
        { name: 'Sekar Wulandari', role: { id: 'Kepala perpustakaan', en: 'Head librarian' } },
        { name: 'Bagas Pratama', role: { id: 'Pustakawan', en: null } },
        { name: 'Made Arimbawa', role: { id: null, en: 'Volunteer' } },
      ],
      gallery: galleryIds.map((fileId, i) => ({ fileId, alt: `Foto galeri ${i + 1}`, caption: { id: `Keterangan foto ${i + 1}`, en: i === 0 ? 'Caption of photo 1' : null } })),
    };
    await setHome(home);
  }, 120_000);

  afterAll(() => dispose(f));

  it('the home page shows every block that is on and has content; a block switched off is gone, the others stay', async () => {
    const all = (await get('/')).text;
    for (const block of OPAC_HOME_BLOCKS) expect(all, block).toContain(heading(BLOCK_HEADING[block]));
    for (const shown of [' id="tentang"', ' id="layanan"', ' id="kunjungi"', 'class="svc-grid"', 'class="card-grid home-titles"', '<ol class="rank"', '<ul class="ddc"', 'class="news-rows"', 'class="agenda"', 'class="gallery"', 'class="cta"']) {
      expect(all, shown).toContain(shown);
    }
    try {
      for (const off of OPAC_HOME_BLOCKS) {
        await setHome({ ...home, blocks: { ...home.blocks, [off]: false } });
        const html = (await get('/')).text;
        for (const block of OPAC_HOME_BLOCKS) {
          if (block === off) expect(html, `${off} off`).not.toContain(heading(BLOCK_HEADING[block]));
          else expect(html, `${off} off: ${block}`).toContain(heading(BLOCK_HEADING[block]));
        }
        // The gallery has no switch: it shows while it has a photo.
        expect(html, `${off} off: gallery`).toContain(heading('galeri-judul'));
      }
    } finally {
      await setHome(home);
    }
  });

  it('the figures are counts: the titles, the active members, the visits of this year (voided ones left out), the year founded', async () => {
    for (const [locale, p] of [
      ['id', '/'],
      ['en', '/?lang=en'],
    ] as const) {
      const block = section((await get(p)).text, 'tentang-judul')!;
      const figures = part(block, /<dl class="figures[^"]*"[^>]*>([\s\S]*?)<\/dl>/);
      expect([...figures.matchAll(/<dt>([^<]*)<\/dt><dd>([^<]*)<\/dd>/g)].map((m) => [m[1], m[2]])).toEqual([
        [opacText(locale, 'home.figure.titles'), '2'],
        [opacText(locale, 'home.figure.members'), '5'],
        [opacText(locale, 'home.figure.visits'), '3'],
        [opacText(locale, 'home.figure.founded'), '1987'],
      ]);
    }
  });

  it('no datum of a member or a visitor is on the home page, the profile, the news or the gallery', async () => {
    expect(secrets.length).toBeGreaterThan(35);
    for (const p of ['/', '/profil', '/berita', '/berita/bedah-buku', '/galeri', '/?lang=en', '/profil?lang=en', '/berita?lang=en', '/galeri?lang=en']) {
      const res = await get(p);
      expect(res.status, p).toBe(200);
      for (const secret of secrets) expect(res.text, `${p}: ${secret}`).not.toContain(secret);
      // The people of the profile are the ones the staff typed in for publication.
      if (p.startsWith('/profil')) expect(res.text).toContain('Sekar Wulandari');
    }
  });

  describe('the news and the agenda', () => {
    it('a post with a category and an event: the category word, then the event box with its time and place', async () => {
      const res = await get('/berita/bedah-buku');
      expect(res.status, res.text).toBe(200);
      const article = part(res.text, /<article class="page-article"[^>]*>([\s\S]*?)<\/article>/);
      // The category and the date stand above the heading.
      expect(article).toMatch(new RegExp(`^<p class="page-meta newsmeta"><b>${opacText('id', 'pages.category.agenda')}</b> · <time datetime="[^"]+">[^<]+</time></p><h1>Bedah buku bulan ini</h1>`));
      const box = part(article, /<div class="eventbox"[^>]*>([\s\S]*?)<\/div>/);
      expect(box).toContain(`<dt>${opacText('id', 'pages.event.when')}</dt>`);
      expect(box).toContain(`<time datetime="${new Date(EVENT_START).toISOString()}">`);
      // 12.00 to 14.00 on 18 November in the library's time zone.
      expect(box).toMatch(/18 November 2026, 12[.:]00–14[.:]00<\/time>/);
      expect(box).toContain(`<dt>${opacText('id', 'pages.event.where')}</dt><dd>${EVENT_PLACE}</dd>`);
      // The link back to the list ends the page's content.
      expect(res.text).toContain(`<p class="page-back"><a href="/berita">${opacText('id', 'pages.news.back')} →</a></p>`);

      const en = await get('/berita/bedah-buku?lang=en');
      expect(en.text).toContain(`<b>${opacText('en', 'pages.category.agenda')}</b>`);
      expect(en.text).toContain(`<dt>${opacText('en', 'pages.event.where')}</dt><dd>${EVENT_PLACE}</dd>`);
      expect(en.text).toContain('<a href="/berita?lang=en">');
    });

    it('a post without an event has no event box; one without a category shows its date alone', async () => {
      const collection = (await get('/berita/buku-baru')).text;
      expect(collection).toContain(`<b>${opacText('id', 'pages.category.collection')}</b>`);
      expect(collection).not.toContain('eventbox');
      const plain = (await get('/berita/libur-semester')).text;
      expect(plain).not.toContain('eventbox');
      expect(plain).toMatch(/<p class="page-meta newsmeta"><time datetime="[^"]+">/);
    });

    const rows = (html: string): string[] => [...part(html, /<ul class="news-rows">([\s\S]*?)<\/ul>/).matchAll(/<h2><a href="([^"]*)">/g)].map((m) => m[1]!);
    const tabs = (html: string): string => part(html, /<nav class="texttabs"[^>]*>([\s\S]*?)<\/nav>/);

    it('/berita?kategori=agenda lists the agenda posts only and marks its tab; an unknown category is ignored', async () => {
      const everything = ['/berita/libur-semester', '/berita/buku-baru', '/berita/lomba-mendongeng', '/berita/bedah-buku'];
      const list = await get('/berita');
      expect(list.status, list.text).toBe(200);
      expect(rows(list.text)).toEqual(everything);
      expect(tabs(list.text)).toContain(`<a href="/berita" aria-current="true">${opacText('id', 'pages.news.all')}</a>`);
      expect(tabs(list.text)).toContain(`<a href="/berita?kategori=agenda">${opacText('id', 'pages.category.agenda')}</a>`);
      expect([...tabs(list.text).matchAll(/aria-current/g)]).toHaveLength(1);

      const agenda = await get('/berita?kategori=agenda');
      expect(agenda.status, agenda.text).toBe(200);
      expect(rows(agenda.text)).toEqual(['/berita/lomba-mendongeng', '/berita/bedah-buku']);
      expect(tabs(agenda.text)).toContain(`<a href="/berita?kategori=agenda" aria-current="true">${opacText('id', 'pages.category.agenda')}</a>`);
      expect(tabs(agenda.text)).toContain(`<a href="/berita">${opacText('id', 'pages.news.all')}</a>`);
      expect([...tabs(agenda.text).matchAll(/aria-current/g)]).toHaveLength(1);
      expect(agenda.text).toContain(`<link rel="canonical" href="${CONFIG.baseUrl}/berita?kategori=agenda"`);

      // The language is kept beside the category.
      const en = await get('/berita?kategori=collection&lang=en');
      expect(rows(en.text)).toEqual(['/berita/buku-baru?lang=en']);
      expect(tabs(en.text)).toContain(`<a href="/berita?kategori=collection&amp;lang=en" aria-current="true">${opacText('en', 'pages.category.collection')}</a>`);

      // A category without a post says so.
      const none = await get('/berita?kategori=activity');
      expect(none.status).toBe(200);
      expect(none.text).toContain(`<p>${opacText('id', 'pages.news.empty_category')}</p>`);

      for (const p of ['/berita?kategori=nope', '/berita?kategori=', '/berita?kategori=AGENDA', '/berita?kategori=%3Cscript%3E']) {
        const res = await get(p);
        expect(res.status, p).toBe(200);
        expect(rows(res.text), p).toEqual(everything);
        expect(tabs(res.text), p).toContain(`<a href="/berita" aria-current="true">`);
        expect(res.text, p).not.toContain('<script>');
      }
    });

    it('the events ahead stand beside the list and on the home page; one that is over does not', async () => {
      const aside = part((await get('/berita')).text, /<aside class="box-stack">([\s\S]*?)<\/aside>/);
      expect(aside).toContain(`<h2 id="agenda-terdekat">${opacText('id', 'pages.news.agenda')}</h2>`);
      const agenda = part(aside, /<ul class="agenda">([\s\S]*?)<\/ul>/);
      expect([...agenda.matchAll(/<li>/g)]).toHaveLength(1);
      expect(agenda).toContain(`<time class="datebox" datetime="${new Date(EVENT_START).toISOString()}"><b>18</b><small>Nov</small></time>`);
      expect(agenda).toContain('<a class="agenda-title" href="/berita/bedah-buku">Bedah buku bulan ini</a>');
      expect(agenda).toMatch(new RegExp(`<span class="agenda-meta">12[.:]00 · ${EVENT_PLACE}</span>`));
      expect(aside).not.toContain('Lomba mendongeng');
      expect(aside).not.toContain(PAST_PLACE);
      // The opening hours stand under it.
      expect(aside).toContain(`<h2 id="jam-buka">${opacText('id', 'pages.news.hours')}</h2>`);
      expect(aside).toContain('<th scope="row">Senin–Jumat</th><td>07.00–15.00</td>');

      const block = section((await get('/')).text, 'berita-terbaru')!;
      // The three latest posts as rows, each title an h3.
      expect([...part(block, /<ul class="news-rows">([\s\S]*?)<\/ul>/).matchAll(/<h3><a href="([^"]*)">/g)].map((m) => m[1])).toEqual([
        '/berita/libur-semester',
        '/berita/buku-baru',
        '/berita/lomba-mendongeng',
      ]);
      const homeAgenda = part(block, /<aside aria-labelledby="agenda-terdekat">([\s\S]*?)<\/aside>/);
      expect(homeAgenda).toContain(`${opacText('id', 'home.agenda.title')}`);
      expect([...homeAgenda.matchAll(/<li>/g)]).toHaveLength(1);
      expect(homeAgenda).toContain('<a class="agenda-title" href="/berita/bedah-buku">Bedah buku bulan ini</a>');
      expect(homeAgenda).not.toContain(PAST_PLACE);
    });
  });

  describe('the profile', () => {
    const SECTIONS = ['sejarah', 'visi', 'pengelola', 'fasilitas', 'anggota'];
    const sectionIds = (html: string): string[] => [...html.matchAll(/<section class="psec" id="([^"]*)" aria-labelledby="([^"]*)">/g)].map((m) => m[1]!);
    const navLinks = (html: string): string[] => [...part(html, /<nav class="sidenav"[^>]*>([\s\S]*?)<\/nav>/).matchAll(/href="([^"]*)"/g)].map((m) => m[1]!);

    it('/profil: the history and its timeline, the vision and mission, the people, the facilities, how to become a member with the loan rules', async () => {
      const res = await get('/profil');
      expect(res.status, res.text).toBe(200);
      const html = res.text;
      expect(html).toContain(`<title>${opacText('id', 'pages.profile.title', { library: 'Perpustakaan Contoh' })}</title>`);
      expect(html).toContain(`<link rel="canonical" href="${CONFIG.baseUrl}/profil"`);
      expect(html).not.toMatch(/<meta name="robots"/);
      expect(html).toContain(`<h1>${opacText('id', 'pages.profile.title', { library: 'Perpustakaan Contoh' })}</h1>`);

      // The navigation of the page names its sections, in order.
      expect(sectionIds(html)).toEqual(SECTIONS);
      expect(navLinks(html)).toEqual(SECTIONS.map((id) => `#${id}`));
      for (const id of SECTIONS) expect(html).toContain(`<section class="psec" id="${id}" aria-labelledby="${id}-judul"><h2 id="${id}-judul">`);

      const history = section(html, 'sejarah-judul')!;
      expect(history).toContain(`<h2 id="sejarah-judul">${opacText('id', 'pages.profile.history')}</h2><p>Berdiri sebagai ruang baca kecil.</p><p>Pindah ke gedung sendiri.</p>`);
      expect([...history.matchAll(/<span class="timeline-year">(\d+)<\/span><p>([^<]*)<\/p>/g)].map((m) => [m[1], m[2]])).toEqual([
        ['1987', 'Ruang baca dibuka'],
        ['2005', 'Gedung baru diresmikan'],
      ]);

      const vision = section(html, 'visi-judul')!;
      expect(vision).toContain(`<h2 id="visi-judul">${opacText('id', 'pages.profile.vision')}</h2>`);
      expect(vision).toContain('<blockquote class="vision">Menjadi pusat belajar warga sekolah.</blockquote>');
      expect(vision).toContain('<ol class="mission"><li><span>Menyediakan koleksi bermutu</span></li><li><span>Menumbuhkan minat baca</span></li></ol>');

      const people = section(html, 'pengelola-judul')!;
      expect(people).toContain('<li><b>Sekar Wulandari</b><span>Kepala perpustakaan</span></li>');
      expect(people).toContain('<li><b>Bagas Pratama</b><span>Pustakawan</span></li>');
      // A role written in English only is shown, marked as English.
      expect(people).toContain('<li><b>Made Arimbawa</b><span lang="en">Volunteer</span></li>');

      const facilities = section(html, 'fasilitas-judul')!;
      expect(facilities).toContain(`<img src="/files/${facilityId}" alt="Ruang baca utama"`);
      expect(facilities).toContain('<figcaption>Meja baca dan rak terbuka</figcaption>');

      const join = section(html, 'anggota-judul')!;
      expect(join).toContain(`<table class="rules" aria-label="${opacText('id', 'pages.profile.rules')}">`);
      expect(join).toContain(`<th scope="col">${opacText('id', 'home.rules.type')}</th>`);
      expect(join).toMatch(/<th scope="row">Siswa<\/th><td>[^<]+<\/td>/);
      expect([...join.matchAll(/<th scope="row"/g)].length).toBeGreaterThanOrEqual(1);
      expect(join).toContain(`<a class="btn btn-outline" href="/#kunjungi">${opacText('id', 'pages.profile.hours_link')}</a>`);
      expect(join).toContain('<a class="btn btn-outline" href="/akun">');
      // The site menu names the profile and marks it.
      expect(html).toContain(`<a href="/profil" aria-current="page">${opacText('id', 'shell.menu.profile')}</a>`);
      expect(html).not.toContain('style=');
    });

    it('/profil?lang=en: English labels and texts, the Indonesian text where there is no English one (marked), and every link keeps the language', async () => {
      const res = await get('/profil?lang=en');
      expect(res.status, res.text).toBe(200);
      const html = res.text;
      expect(html).toContain('<html lang="en"');
      expect(html).toContain(`<h1>${opacText('en', 'pages.profile.title', { library: 'Perpustakaan Contoh' })}</h1>`);
      expect(sectionIds(html)).toEqual(SECTIONS);
      expect(navLinks(html)).toEqual(SECTIONS.map((id) => `#${id}`));
      for (const [id, key] of [
        ['sejarah', 'pages.profile.history'],
        ['visi', 'pages.profile.vision'],
        ['pengelola', 'pages.profile.staff'],
        ['fasilitas', 'pages.profile.facilities'],
        ['anggota', 'pages.profile.join'],
      ] as const) {
        expect(html).toContain(`<h2 id="${id}-judul">${opacText('en', key)}</h2>`);
        expect(html).toContain(`<a href="#${id}">${opacText('en', key)}</a>`);
      }
      expect(html).toContain('<p lang="id">Berdiri sebagai ruang baca kecil.</p>');
      expect(html).toContain('<span class="timeline-year">1987</span><p>The reading room opens</p>');
      expect(html).toContain('<span class="timeline-year">2005</span><p lang="id">Gedung baru diresmikan</p>');
      expect(html).toContain('<blockquote class="vision">To be the school community’s place to learn.</blockquote>');
      expect(html).toContain('<li><span>Provide a good collection</span></li><li lang="id"><span>Menumbuhkan minat baca</span></li>');
      expect(html).toContain('<li><b>Sekar Wulandari</b><span>Head librarian</span></li>');
      expect(html).toContain('<li><b>Bagas Pratama</b><span lang="id">Pustakawan</span></li>');
      expect(html).toContain('<li><b>Made Arimbawa</b><span>Volunteer</span></li>');

      const join = section(html, 'anggota-judul')!;
      expect(join).toContain(`<a class="btn btn-outline" href="/?lang=en#kunjungi">${opacText('en', 'pages.profile.hours_link')}</a>`);
      expect(join).toContain('<a class="btn btn-outline" href="/akun?lang=en">');
      // The breadcrumb and the menu keep the language too.
      expect(part(html, /<nav class="crumbs"[^>]*>([\s\S]*?)<\/nav>/)).toContain('<a href="/?lang=en">');
      expect(html).toContain(`<a href="/profil?lang=en" aria-current="page">${opacText('en', 'shell.menu.profile')}</a>`);
      // No link of the page's own drops the language (the language switch names each language itself).
      const main = part(html, /<main[^>]*>([\s\S]*?)<\/main>/);
      for (const m of main.matchAll(/href="(\/[^"#]*)/g)) expect(m[1], m[1]).toContain('lang=en');
    });

    it('the home page links the profile from its about block, its services and its call to become a member', async () => {
      const html = (await get('/')).text;
      expect(section(html, 'tentang-judul')).toContain('<a class="more-link" href="/profil">');
      expect(section(html, 'layanan-judul')).toContain('href="/profil#fasilitas"');
      expect(section(html, 'kunjungi-judul')).toContain('<a class="btn btn-primary" href="/profil#anggota">');
    });

    it('/profil is the 404 page while the about block is off, and with it the links to it are gone', async () => {
      await setHome({ ...home, blocks: { ...home.blocks, about: false } });
      try {
        const res = await get('/profil');
        expect(res.status).toBe(404);
        expect(res.text).not.toContain('class="psec"');
        expect(res.text).not.toContain('Sekar Wulandari');
        const front = (await get('/')).text;
        expect(front).not.toContain('href="/profil');
        // The call to become a member leads to the member area then.
        expect(section(front, 'kunjungi-judul')).toContain('<a class="btn btn-primary" href="/akun">');
      } finally {
        await setHome(home);
      }
      expect((await get('/profil')).status).toBe(200);
    });

    it('a section without content is left out of the page and of its navigation', async () => {
      await setHome({ ...home, vision: { id: null, en: null }, mission: [], staff: [], facilities: [] });
      try {
        const html = (await get('/profil')).text;
        expect(sectionIds(html)).toEqual(['sejarah', 'anggota']);
        expect(navLinks(html)).toEqual(['#sejarah', '#anggota']);
      } finally {
        await setHome(home);
      }
    });
  });

  describe('the gallery', () => {
    const figures = (html: string): { src: string; alt: string; caption: string | undefined }[] =>
      [...html.matchAll(/<li><figure[^>]*><img src="([^"]*)" alt="([^"]*)"[^>]*>(?:<figcaption>([^<]*)<\/figcaption>)?<\/figure><\/li>/g)].map((m) => ({ src: m[1]!, alt: m[2]!, caption: m[3] }));

    it('/galeri lists every photo with its alternative text and caption', async () => {
      const res = await get('/galeri');
      expect(res.status, res.text).toBe(200);
      expect(res.text).toContain(`<h1>${opacText('id', 'pages.gallery.title')}</h1>`);
      expect(res.text).toContain(`<link rel="canonical" href="${CONFIG.baseUrl}/galeri"`);
      const list = part(res.text, /<ul class="gallery gallery-page">([\s\S]*?)<\/ul>/);
      expect(figures(list)).toEqual(galleryIds.map((id, i) => ({ src: `/files/${id}`, alt: `Foto galeri ${i + 1}`, caption: `Keterangan foto ${i + 1}` })));

      // In English: the English caption, else the Indonesian one, marked.
      const en = part((await get('/galeri?lang=en')).text, /<ul class="gallery gallery-page">([\s\S]*?)<\/ul>/);
      expect(figures(en).map((p) => p.caption)).toEqual(['Caption of photo 1', ...galleryIds.slice(1).map((_, i) => `Keterangan foto ${i + 2}`)]);
      expect(en).toMatch(/^<li><figure><img /);
      expect([...en.matchAll(/<figure lang="id">/g)]).toHaveLength(galleryIds.length - 1);
    });

    it('the home page shows the first four photos and links the gallery; the footer links it too', async () => {
      expect(HOME_GALLERY).toBe(4);
      const html = (await get('/')).text;
      const block = section(html, 'galeri-judul')!;
      expect(block).toContain(`<a class="section-link" href="/galeri">${opacText('id', 'home.gallery.all')} →</a>`);
      expect(figures(part(block, /<ul class="gallery">([\s\S]*?)<\/ul>/)).map((p) => p.src)).toEqual(galleryIds.slice(0, 4).map((id) => `/files/${id}`));
      for (const id of galleryIds.slice(4)) expect(html).not.toContain(id);
      expect(part(html, /<footer class="site-footer">([\s\S]*?)<\/footer>/)).toContain(`<a href="/galeri">${opacText('id', 'shell.menu.gallery')}</a>`);
      expect(section((await get('/?lang=en')).text, 'galeri-judul')).toContain('href="/galeri?lang=en"');
    });

    it('/galeri is the 404 page without a photo, and the home page has no gallery then', async () => {
      await setHome({ ...home, gallery: [] });
      try {
        expect((await get('/galeri')).status).toBe(404);
        const html = (await get('/')).text;
        expect(html).not.toContain(heading('galeri-judul'));
        expect(html).not.toContain('href="/galeri');
      } finally {
        await setHome(home);
      }
    });
  });

  describe('the hero', () => {
    const NO_TEXT = { id: null, en: null };
    const slide = (id: string, over: Partial<OpacHomeContent['hero']['slides'][number]> = {}): OpacHomeContent['hero']['slides'][number] => ({
      id,
      fileId: newId(),
      alt: `Foto ${id}`,
      position: 50,
      note: NO_TEXT,
      title: { id: `Judul ${id}`, en: null },
      subtitle: NO_TEXT,
      cta: null,
      active: true,
      from: null,
      until: null,
      ...over,
    });
    const scripts = (html: string): string[] => [...html.matchAll(/<script\b[^>]*>/g)].map((m) => m[0]).filter((tag) => !tag.includes('application/ld+json'));

    it('several slides today: all of them in the page, the controls, and the one script file, which the policy allows and the app serves', async () => {
      // NOW is the 15th of November in the library's time zone: the slide that ended on the 14th and the one switched off stay out.
      const slides = [
        slide('satu', { cta: { label: { id: 'Lihat katalog', en: null }, target: { kind: 'catalog' } } }),
        slide('lewat', { until: '2026-11-14' }),
        slide('dua', { from: '2026-11-15', until: '2026-11-15' }),
        slide('mati', { active: false }),
        slide('tiga', { cta: { label: { id: 'Profil kami', en: null }, target: { kind: 'profile' } } }),
      ];
      await setHome({ ...home, hero: { slides, autoplay: false, intervalSec: 10 } });
      try {
        const res = await get('/');
        const html = res.text;
        const hero = part(html, /(<section class="hero"[\s\S]*?<\/section>)/);
        expect([...hero.matchAll(/<(h[12])>([^<]*)<\/h[12]>/g)].map((m) => [m[1], m[2]])).toEqual([
          ['h1', 'Judul satu'],
          ['h2', 'Judul dua'],
          ['h2', 'Judul tiga'],
        ]);
        expect(hero).toContain('data-autoplay="false" data-interval="10" aria-roledescription="carousel"');
        expect([...hero.matchAll(/<a href="(#slide-\d)"/g)].map((m) => m[1])).toEqual(['#slide-1', '#slide-2', '#slide-3']);
        expect(hero).toContain('<a class="btn btn-inv" href="/cari">Lihat katalog</a>');
        expect(hero).toContain('<a class="btn btn-inv" href="/profil">Profil kami</a>');
        expect(html.match(/<h1\b/g)).toHaveLength(1);
        // The one script: a file of this site under its content hash, deferred; nothing inline.
        expect(scripts(html)).toEqual([`<script src="/assets/${OPAC_SLIDER_FILE}" defer="">`]);
        expect(html).not.toMatch(/<[a-z][^>]*\son[a-z]+=/i);
        const policy = res.headers.get('content-security-policy') ?? '';
        expect(policy).toMatch(/script-src [^;]*'self'/);
        expect(policy).not.toMatch(/script-src [^;]*'unsafe-inline'/);
        const file = await get(`/assets/${OPAC_SLIDER_FILE}`);
        expect(file.status).toBe(200);
        expect(file.headers.get('content-type')).toBe('text/javascript; charset=utf-8');
        // The first slide's photo is the page's picture for a link preview.
        expect(html).toContain(`<meta property="og:image" content="${CONFIG.baseUrl}/files/${slides[0]!.fileId}"`);
        // The page language is kept in a slide's button.
        expect((await get('/?lang=en')).text).toContain('<a class="btn btn-inv" href="/cari?lang=en" lang="id">Lihat katalog</a>');
      } finally {
        await setHome(home);
      }
    });

    it('one slide today, or none: no controls and no script at all', async () => {
      for (const slides of [[slide('satu'), slide('lewat', { until: '2026-11-14' })], []]) {
        await setHome({ ...home, hero: { slides, autoplay: true, intervalSec: 7 } });
        try {
          const html = (await get('/')).text;
          expect(scripts(html)).toEqual([]);
          expect(html).not.toContain('opac-slider-');
          const hero = part(html, /(<section class="hero"[\s\S]*?<\/section>)/);
          for (const absent of ['hero-ui', '<button', 'data-hero', 'aria-roledescription']) expect(hero, absent).not.toContain(absent);
          expect(html.match(/<h1\b/g)).toHaveLength(1);
        } finally {
          await setHome(home);
        }
      }
    });
  });
});
