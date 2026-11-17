import fsp from 'node:fs/promises';
import os from 'node:os';
import path from 'node:path';
import { createSettingsCache, indexRecords, refreshClassActivity, refreshPopularTitles, writeSettings } from '@altis/core';
import { PHASE1_MIGRATIONS, runMigrations, withTx } from '@altis/db';
import { newId, normalizeKey } from '@altis/shared';
import { OPAC_HOME_DEFAULT, type OpacHomeContent } from '@altis/shared/api/opac-home';
import { afterAll, beforeAll, describe, expect, it } from 'vitest';
import { engineLabel, testDb, testDbContext, type TestDbHandle } from '../../../../tools/test/test-db.js';
import { createApp } from '../../src/app.js';
import { opacText } from '../../src/opac/catalog/messages.js';
import { CATALOGUE_FACTS_TTL_MS, cachedCatalogueFacts, catalogueFacts, publicLoanRules } from '../../src/opac/catalog/queries.js';
import { createAgent, type AgentReply } from '../agent.js';
import { recordingLogger, sampleConfig } from '../support.js';

// The OPAC home page as the library's profile site, through the app on the engine picked by ALTIS_TEST_DB: the hero
// band (the photo under its overlay of the chosen darkness, or the library colour), the floating search card with
// today's hours, the profile blocks shown only with content and while switched on, the texts per language with the
// other language as fallback, escaped and marked with their language, the subject pills and availability of the title
// lists, today's row of the opening hours, the popular titles from their aggregate, and the loans per class (off by
// default, a class only with five borrowers). No borrower datum reaches the page or the "most borrowed" search: not a
// member's name, number or id, and no loan count of a title.

const ctx = testDbContext();
const NOW = Date.UTC(2026, 10, 15, 5, 0, 0);
const DAY = 86_400_000;
const CONFIG = sampleConfig();
const HTML = { Accept: 'text/html' };

/** `template` escaped, its `{name}` the bold `value` (the search card's facts). */
const bold = (template: string, name: string, value: string): string => esc(template).replace(`{${name}}`, `<strong>${esc(value)}</strong>`);

const esc = (s: string): string => s.replace(/[&<>'"]/g, (ch) => ({ '&': '&amp;', '<': '&lt;', '>': '&gt;', "'": '&#39;', '"': '&quot;' })[ch]!);

/** The markup of the `<section>` whose heading has the id `id`. */
function section(html: string, id: string): string | undefined {
  return new RegExp(`<section[^>]*aria-labelledby="${id}"[^>]*>([\\s\\S]*?)</section>`).exec(html)?.[1];
}

describe.skipIf(!ctx.available)(`the OPAC home page as a profile site [${engineLabel()}]`, () => {
  let h: TestDbHandle;
  let root: string;
  let app: ReturnType<typeof createApp>;
  let peer = 0;
  const get = (p: string): Promise<AgentReply> => {
    peer += 1;
    return createAgent(app, { peer: `198.18.40.${(peer % 250) + 1}` }).get(p, undefined, HTML);
  };
  const borrowers: { id: string; no: string; name: string }[] = [];
  let photoId = '';
  let aboutPhotoId = '';
  let subjectId = '';
  const records: string[] = [];
  const itemIds: string[] = [];
  let branchId = '';
  let siswa = '';

  async function setSettings(patch: Record<string, unknown>): Promise<void> {
    await withTx(h, (trx) => writeSettings(trx, patch, { keyring: CONFIG.keyring, now: NOW, actorId: null }).then(() => undefined));
  }

  const setHome = (home: OpacHomeContent): Promise<void> => setSettings({ 'opac.home': home });

  beforeAll(async () => {
    h = await testDb();
    root = await fsp.mkdtemp(path.join(os.tmpdir(), 'altis-opac-home-'));
    await runMigrations(h, { appVersion: '0.1.0', dataDir: path.join(root, 'migrations'), migrations: PHASE1_MIGRATIONS });
    await setSettings({ 'library.name': 'Perpustakaan SMA 1', 'library.address': 'Jl. Pendidikan 1\nKota Contoh', 'opac.welcome.id': 'Cari buku <di> katalog.' });
    const db = h.db;
    const buku = (await db.selectFrom('material_types').select('id').where('code_key', '=', 'BUKU').executeTakeFirstOrThrow()).id;
    const umum = (await db.selectFrom('collection_types').select('id').where('code_key', '=', 'UMUM').executeTakeFirstOrThrow()).id;
    siswa = (await db.selectFrom('member_types').select('id').where('code_key', '=', 'SISWA').executeTakeFirstOrThrow()).id;
    branchId = newId(NOW);
    await db.insertInto('branches').values({ id: branchId, code_key: 'POP', code_display: 'POP', name: 'Cabang', timezone: 'Asia/Jakarta', created_at: NOW, updated_at: NOW }).execute();
    for (let i = 0; i < 3; i += 1) {
      const id = newId(NOW);
      const no = `ANG-77${i}`;
      const name = `Rahasia Peminjam ${i}`;
      await db
        .insertInto('members')
        .values({
          id,
          member_no_display: no,
          member_no_key: normalizeKey(no),
          member_type_id: siswa,
          status: 'active',
          name,
          name_key: name.toLowerCase(),
          joined_on: '2026-01-01',
          valid_from: '2026-01-01',
          expires_on: '2099-01-01',
          created_at: NOW,
          updated_at: NOW,
        })
        .execute();
      borrowers.push({ id, no, name });
    }
    subjectId = newId(NOW);
    await db
      .insertInto('subjects')
      .values({ id: subjectId, type: 'topic', term_display: 'Novel <Indonesia>', term_key: 'novel indonesia', classification: null, scope_note: null, authority_source: null, merged_into: null, archived_at: null, created_at: NOW, created_by: null, updated_at: NOW, updated_by: null })
      .execute();
    for (const title of ['Laskar Pelangi', 'Bumi Manusia']) {
      const id = newId(NOW);
      await db.insertInto('records').values({ id, material_type_id: buku, title, title_key: title.toLowerCase(), source: 'manual', changed_at: NOW, created_at: NOW, updated_at: NOW }).execute();
      const itemId = newId(NOW);
      await db
        .insertInto('items')
        .values({ id: itemId, record_id: id, branch_id: branchId, barcode_display: `B-${title.length}`, barcode_key: `B-${title.length}`, collection_type_id: umum, status: 'available', currency: 'IDR', created_at: NOW, updated_at: NOW })
        .execute();
      await db.insertInto('record_subjects').values({ record_id: id, subject_id: subjectId }).execute();
      records.push(id);
      itemIds.push(itemId);
      if (title !== 'Bumi Manusia') continue;
      // Bumi Manusia: three borrowers, four loans in the last month.
      for (const [k, b] of [0, 1, 2, 0].entries()) {
        const at = NOW - (5 + k) * DAY;
        const on = new Date(at).toISOString().slice(0, 10);
        await db
          .insertInto('loans')
          .values({
            id: newId(at),
            item_id: itemId,
            open_item_id: null,
            record_id: id,
            member_id: borrowers[b]!.id,
            branch_id: branchId,
            loaned_on: on,
            loaned_at: at,
            due_on: on,
            returned_on: on,
            returned_at: at + 3_600_000,
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
    await withTx(h, (trx) => indexRecords(trx, records, NOW));
    await refreshPopularTitles(h, NOW);
    photoId = newId(NOW);
    aboutPhotoId = newId(NOW);
    for (const id of [photoId, aboutPhotoId]) {
      await db
        .insertInto('files')
        .values({
          id,
          original_name: 'gedung.jpg',
          mime: 'image/jpeg',
          size: 10,
          sha256: '0'.repeat(64),
          context: 'opac.home_photo',
          owner_type: 'settings',
          owner_id: 'opac.home',
          access: 'public',
          status: 'ok',
          created_at: NOW,
          created_by: null,
        })
        .execute();
    }
    app = createApp({
      state: { phase: 'ready', db: h, config: CONFIG },
      version: '0.1.0',
      buildId: 'opac-home',
      log: recordingLogger(),
      clock: () => NOW,
      env: {},
      services: { settings: createSettingsCache({ ttlMs: 0 }) },
    });
  }, 120_000);

  afterAll(async () => {
    await h?.close();
    if (root !== undefined) await fsp.rm(root, { recursive: true, force: true });
  });

  it('without a profile: the hero in the library colour (no photo), the library name as heading, the welcome as lead, the search card; no profile block', async () => {
    const html = (await get('/')).text;
    expect(html).toContain('<header class="site-header hero-band">');
    expect(html).not.toContain('hero-img');
    expect(html).toContain('<h1>Perpustakaan SMA 1</h1>');
    expect(html).toContain('<p class="hero-lead">Cari buku &lt;di&gt; katalog.</p>');
    expect(html).toContain('<div class="home-search">');
    expect(html).toContain(`<span>${bold(opacText('id', 'home.search.titles'), 'count', '2')}</span>`);
    for (const id of ['tentang-judul', 'layanan-judul']) expect(section(html, id), id).toBeUndefined();
    // The visit block shows the library's address alone.
    expect(section(html, 'kunjungi-judul')).toContain('<p class="visit-address">Jl. Pendidikan 1\nKota Contoh</p>');
    expect(html).not.toContain('style=');
  });

  it('the ten DDC classes with their public titles from the search index, one read; each class links to its search, an empty one too', async () => {
    const zero = { '0': 0, '1': 0, '2': 0, '3': 0, '4': 0, '5': 0, '6': 0, '7': 0, '8': 0, '9': 0 };
    expect(await catalogueFacts(h.db)).toEqual({ classes: zero, available: 2 });
    const classify = async (values: (string | null)[]): Promise<void> => {
      for (const [i, value] of values.entries()) await h.db.updateTable('records').set({ classification: value }).where('id', '=', records[i]!).execute();
      await withTx(h, (trx) => indexRecords(trx, records, NOW));
    };
    await classify(['899.221 3', '305.4']);
    try {
      expect(await catalogueFacts(h.db)).toEqual({ classes: { ...zero, '3': 1, '8': 1 }, available: 2 });
      // The count is what the class's search finds.
      expect((await get('/cari?kelas=8')).text).toContain(esc(opacText('id', 'search.count_one')));

      // Kept a minute per database (a Kysely of its own here, so that the page's reads do not share the entry).
      let at = 1_000;
      const own = h.db.withoutPlugins();
      const first = await cachedCatalogueFacts(own, () => at);
      await classify(['899.221 3', '512']);
      at += CATALOGUE_FACTS_TTL_MS - 1;
      expect(await cachedCatalogueFacts(own, () => at)).toEqual(first);
      at += 1;
      expect((await cachedCatalogueFacts(own, () => at)).classes).toEqual({ ...zero, '5': 1, '8': 1 });

      // The page: ten links to /cari?kelas=N, each with its number of titles in words.
      const block = section((await get('/')).text, 'jelajah-kelas')!;
      expect([...block.matchAll(/href="([^"]*)"/g)].map((m) => m[1])).toEqual(Array.from({ length: 10 }, (_, n) => `/cari?kelas=${n}`));
      expect([...block.matchAll(/<span class="class-count">([^<]*)<\/span>/g)]).toHaveLength(10);
      expect(block).toContain(esc(opacText('id', 'home.subjects.scheme')));
    } finally {
      await classify([null, null]);
    }
  });

  it('the loan rules per member type of the visit block: each type that may borrow, its limit and the period of its rule; no member', async () => {
    expect(await publicLoanRules(h.db, 'id')).toEqual([
      { name: 'Siswa', limit: 3, days: 7 },
      { name: 'Guru', limit: 10, days: 7 },
      { name: 'Tenaga kependidikan', limit: 5, days: 7 },
      { name: 'Umum', limit: 2, days: 7 },
    ]);
    // A type that may not borrow is left out; a rule of its own wins over the general one.
    const umum = (await h.db.selectFrom('member_types').select('id').where('code_key', '=', 'UMUM').executeTakeFirstOrThrow()).id;
    const policy = newId(NOW);
    await h.db.updateTable('member_types').set({ loan_limit: 0 }).where('id', '=', umum).execute();
    await h.db.updateTable('member_types').set({ loan_limit: null }).where('id', '=', siswa).execute();
    await h.db
      .insertInto('policies')
      .values({
        id: policy,
        code_display: 'SISWA14',
        code_key: 'SISWA14',
        name: 'Siswa',
        member_type_id: siswa,
        collection_type_id: null,
        material_type_id: null,
        branch_id: null,
        scope_key: `${siswa}/*/*/*`,
        loanable: 1,
        loan_days: 14,
        loan_limit: null,
        renew_limit: 1,
        fine_per_day_minor: 0,
        fine_cap_minor: null,
        grace_days: 0,
        currency: 'IDR',
        archived_at: null,
        version: 0,
        created_at: NOW,
        created_by: null,
        updated_at: NOW,
        updated_by: null,
      })
      .execute();
    try {
      const en = await publicLoanRules(h.db, 'en');
      expect(en.map((r) => [r.name, r.limit, r.days])).toEqual([
        ['Pupil', null, 14],
        ['Teacher', 10, 7],
        ['Education staff', 5, 7],
      ]);
      const visit = section((await get('/?lang=en')).text, 'kunjungi-judul')!;
      expect(visit).toContain(`<h3 id="aturan-pinjam">${esc(opacText('en', 'home.rules.title'))}</h3>`);
      expect(visit).toContain(`<tr><th scope="row">Pupil</th><td>${esc(opacText('en', 'home.rules.no_limit'))}, ${esc(opacText('en', 'home.rules.days', { count: '14' }))}</td></tr>`);
      expect(visit).toContain(`<tr><th scope="row">Teacher</th><td>${esc(opacText('en', 'home.rules.items', { count: '10' }))}, ${esc(opacText('en', 'home.rules.days', { count: '7' }))}</td></tr>`);
      expect(visit).not.toContain('General public');
      // The location: the address and a link that opens it in a map app; nothing of a third party on the page.
      expect(visit).toContain(`<a class="map-link" href="https://www.openstreetmap.org/search?query=Jl.%20Pendidikan%201%20Kota%20Contoh" rel="noopener noreferrer">`);
      for (const b of borrowers) expect(visit).not.toContain(b.name);
    } finally {
      await h.db.deleteFrom('policies').where('id', '=', policy).execute();
      await h.db.updateTable('member_types').set({ loan_limit: 2 }).where('id', '=', umum).execute();
      await h.db.updateTable('member_types').set({ loan_limit: 3 }).where('id', '=', siswa).execute();
    }
  });

  it('the dark footer of every public page: the library and its address, the links with content, the search field, the source', async () => {
    // An address no route serves too: its 404 page has the same frame.
    for (const path of ['/', '/cari', `/katalog/${records[0]!}/laskar-pelangi`, '/katalogg']) {
      const html = (await get(path)).text;
      const footer = /<footer class="site-footer">([\s\S]*?)<\/footer>/.exec(html)?.[1];
      expect(footer, path).toBeDefined();
      expect(footer, path).toContain('<h2>Perpustakaan SMA 1</h2><p class="foot-address">Jl. Pendidikan 1\nKota Contoh</p>');
      expect(footer, path).toContain('href="/#kunjungi"');
      expect(footer, path).toContain('id="cari-kaki"');
      expect(footer, path).toContain('href="https://github.com/arjunaayasa/altis" rel="noopener"');
      expect(footer, path).toContain('href="/admin/login"');
      // No hours set up yet: no hours block and no placeholder.
      expect(footer, path).not.toContain('foot-hours');
    }
    // In English the library's own texts carry their language.
    expect((await get('/?lang=en')).text).toContain('<p class="foot-address" lang="id">Jl. Pendidikan 1\nKota Contoh</p>');
  });

  it('with a profile: the photo under the overlay with its alt text and position, the heading, about with its facts, the services and photos, the hours; texts escaped', async () => {
    await setHome({
      ...OPAC_HOME_DEFAULT,
      title: { id: 'Ruang baca <untuk> semua', en: null },
      hero: { fileId: photoId, alt: 'Gedung "B" perpustakaan', position: 40, overlay: 70 },
      about: {
        text: { id: 'Berdiri sejak 1987.\nMelayani siswa & guru.', en: 'Founded in 1987.' },
        photo: { fileId: aboutPhotoId, alt: 'Ruang baca', caption: 'Lantai 1' },
        founded: 1987,
        librarians: 3,
      },
      services: [{ title: 'Peminjaman <buku>', text: 'Bawa kartu anggota.' }],
      facilities: [],
      // NOW is Sunday 15 November 2026 in the library's time zone.
      hours: [
        { days: 'Senin–Jumat', time: '07.00–15.00', weekdays: [1, 2, 3, 4, 5] },
        { days: 'Minggu', time: 'Tutup', weekdays: [7] },
      ],
    });
    const html = (await get('/')).text;
    expect(html).toContain('<header class="site-header hero-band hero-photo hero-ov-70">');
    expect(html).toContain(`<img class="hero-img hero-pos-40" src="/files/${photoId}" alt="Gedung &quot;B&quot; perpustakaan" width="1600" height="900" decoding="async"/>`);
    expect(html).toContain('<h1>Ruang baca &lt;untuk&gt; semua</h1>');
    expect(html).toContain('<meta property="og:image" content="');
    const about = section(html, 'tentang-judul')!;
    expect(about).toContain('<p class="about-text">Berdiri sejak 1987.\nMelayani siswa &amp; guru.</p>');
    expect(about).toContain('<figcaption>Lantai 1</figcaption>');
    expect(about).toContain(`<dt>${opacText('id', 'home.fact.founded')}</dt><dd>1987</dd>`);
    expect(about).toContain(`<dd>${opacText('id', 'home.fact.titles_value', { count: '2' })}</dd>`);
    expect(about).toContain(`<dt>${opacText('id', 'home.fact.members')}</dt><dd>3</dd>`);
    expect(about).toContain(`<dd>${opacText('id', 'home.fact.librarians_value', { count: '3' })}</dd>`);
    expect(section(html, 'layanan-judul')).toContain('<h3>Peminjaman &lt;buku&gt;</h3>');
    const visit = section(html, 'kunjungi-judul')!;
    expect(visit).toContain('<tr><th scope="row">Senin–Jumat</th><td>07.00–15.00</td></tr>');
    // Today's row in bold (its class) and named so in words.
    expect(visit).toContain(`<tr class="today"><th scope="row">Minggu <span lang="id">(${opacText('id', 'home.visit.today')})</span></th><td>Tutup</td></tr>`);
    expect(html).toContain(`<span>${bold(opacText('id', 'home.search.today'), 'time', 'Tutup')}</span>`);
    expect(html).not.toContain('<untuk>');
    expect(html).not.toContain('<buku>');
    expect(html).not.toContain('style=');
    expect(html).not.toContain('<style');

    // In English: the English paragraph; the heading and lead have none, so the Indonesian ones show, marked so; the
    // library's own texts carry their language.
    const en = (await get('/?lang=en')).text;
    expect(en).toContain('<h1 lang="id">Ruang baca &lt;untuk&gt; semua</h1>');
    expect(en).toContain('<p class="hero-lead" lang="id">Cari buku &lt;di&gt; katalog.</p>');
    expect(en).toContain('<p class="about-text">Founded in 1987.</p>');
    expect(en).toContain('<ul class="service-list" lang="id">');
    expect(en).toContain(`<span lang="en">(${opacText('en', 'home.visit.today')})</span>`);
  });

  it('a day the library calendar closes: no row of the hours is today\'s and no time is given for today; the page says it is closed', async () => {
    const before = (await h.db.selectFrom('settings').select('value').where('key', '=', 'opac.home').executeTakeFirst())?.value ?? null;
    await setHome({
      ...OPAC_HOME_DEFAULT,
      hours: [
        { days: 'Senin–Sabtu', time: '07.00–15.00', weekdays: [1, 2, 3, 4, 5, 6] },
        { days: 'Minggu', time: '08.00–12.00', weekdays: [7] },
      ],
    });
    const open = (await get('/')).text;
    expect(open).toContain(bold(opacText('id', 'home.search.today'), 'time', '08.00–12.00'));
    expect(open).not.toContain(esc(opacText('id', 'home.search.closed_today')));
    // A holiday covering NOW (Sunday 15 November 2026 in the library's time zone).
    const holiday = newId(NOW);
    await h.db
      .insertInto('calendars')
      .values({ id: holiday, branch_id: null, kind: 'dates', weekday: null, date_from: '2026-11-14', date_to: '2026-11-16', month_day_from: null, month_day_to: null, name: 'Libur semester', archived_at: null, created_at: NOW, created_by: null, updated_at: NOW, updated_by: null })
      .execute();
    try {
      for (const locale of ['id', 'en'] as const) {
        const html = (await get(locale === 'id' ? '/' : '/?lang=en')).text;
        expect(html, locale).not.toContain(bold(opacText(locale, 'home.search.today'), 'time', '08.00–12.00'));
        expect(html, locale).toContain(`<span>${esc(opacText(locale, 'home.search.closed_today'))}</span>`);
        const visit = section(html, 'kunjungi-judul')!;
        expect(visit, locale).not.toContain('class="today"');
        expect(visit, locale).toContain(esc(opacText(locale, 'home.visit.closed_today')));
        expect(visit, locale).toContain('<tr><th scope="row">Minggu</th><td>08.00–12.00</td></tr>');
      }
    } finally {
      await h.db.deleteFrom('calendars').where('id', '=', holiday).execute();
      if (before !== null) await setSettings({ 'opac.home': JSON.parse(before) as unknown });
    }
  });

  it('the overlay never lighter than its floor; the library colour without a photo as a nonce style of six hex digits, nothing else', async () => {
    const stored = (await h.db.selectFrom('settings').select('value').where('key', '=', 'opac.home').executeTakeFirstOrThrow()).value!;
    const home = JSON.parse(stored) as OpacHomeContent;
    try {
      // A row edited by hand to a lighter overlay is refused as a whole (the page falls back to the default content).
      await h.db.updateTable('settings').set({ value: JSON.stringify({ ...home, hero: { ...home.hero, overlay: 40 } }) }).where('key', '=', 'opac.home').execute();
      let html = (await get('/')).text;
      expect(html).not.toContain('hero-ov-40');
      expect(html).toContain('<header class="site-header hero-band">');

      await setHome({ ...home, hero: null, brand: '#1E3A8A' });
      const reply = await get('/');
      html = reply.text;
      const nonce = /<meta name="csp-nonce" content="([^"]+)"/.exec(html)?.[1];
      expect(nonce).toBeDefined();
      expect(html).toContain(`<style nonce="${nonce}">.site-header{--hero-bg:#1e3a8a}</style>`);
      expect(reply.headers.get('content-security-policy')).toContain(`style-src 'self' 'nonce-${nonce}'`);
      expect(html).not.toContain('style=');
      // The 404 page of an address no route serves has the library colour too.
      const missing = await get('/katalogg');
      expect(missing.status).toBe(404);
      const missingNonce = /<meta name="csp-nonce" content="([^"]+)"/.exec(missing.text)?.[1];
      expect(missing.text).toContain(`<style nonce="${missingNonce}">.site-header{--hero-bg:#1e3a8a}</style>`);

      // Anything else in the row is no colour: the whole content falls back, and no style element is written.
      await h.db
        .updateTable('settings')
        .set({ value: JSON.stringify({ ...home, hero: null, brand: '#000;}body{display:none' }) })
        .where('key', '=', 'opac.home')
        .execute();
      html = (await get('/')).text;
      expect(html).not.toContain('<style');
      expect(html).not.toContain('display:none');
    } finally {
      await setHome(home);
    }
  });

  it('the subject pills above the new titles with their number of titles, and each card says its availability in words', async () => {
    const html = (await get('/')).text;
    const fresh = section(html, 'judul-baru')!;
    const available = (locale: 'id' | 'en') => `<span class="status status-ok card-status">${esc(opacText(locale, 'search.card.available'))}</span>`;
    expect(fresh).toContain(`<ul class="subject-pills" aria-label="${esc(opacText('id', 'home.pills.label'))}">`);
    expect(fresh).toContain(`<a href="/cari?subjek=${subjectId}">Novel &lt;Indonesia&gt;<span class="pill-count" aria-hidden="true">2</span>`);
    expect(fresh.split(available('id')).length - 1).toBe(2);
    // The popular titles carry the same pills and words.
    const popular = section(html, 'judul-populer')!;
    expect(popular).toContain('class="subject-pills"');
    expect(popular).toContain(available('id'));

    // A copy under repair: the title has a copy, but none on the shelf.
    await h.db.updateTable('items').set({ status: 'repair' }).where('id', '=', itemIds[0]!).execute();
    await withTx(h, (trx) => indexRecords(trx, records, NOW));
    try {
      const after = section((await get('/?lang=en')).text, 'judul-baru')!;
      expect(after).toContain(`<span class="status status-muted card-status">${esc(opacText('en', 'search.card.off_shelf'))}</span>`);
      expect(after).toContain(available('en'));
    } finally {
      await h.db.updateTable('items').set({ status: 'available' }).where('id', '=', itemIds[0]!).execute();
      await withTx(h, (trx) => indexRecords(trx, records, NOW));
    }
  });

  it('a block switched off is left out, whatever it holds', async () => {
    const stored = (await h.db.selectFrom('settings').select('value').where('key', '=', 'opac.home').executeTakeFirstOrThrow()).value!;
    const home = JSON.parse(stored) as OpacHomeContent;
    await setHome({ ...home, blocks: { ...home.blocks, about: false, services: false, visit: false, popular: false, classes: false } });
    const html = (await get('/')).text;
    for (const id of ['tentang-judul', 'layanan-judul', 'kunjungi-judul', 'judul-populer', 'jelajah-kelas', 'kelas-rajin']) expect(section(html, id), id).toBeUndefined();
    await setHome(home);
  });

  it('the popular titles: cards with covers like the new titles, linking the most borrowed search; no borrower and no count on the page or in that search', async () => {
    const html = (await get('/')).text;
    const popular = section(html, 'judul-populer')!;
    expect(popular).toContain('<ul class="card-grid">');
    expect(popular).toContain('class="book-cover cover-');
    expect(popular).toContain(`<p class="section-sub">${esc(opacText('id', 'home.popular.note'))}</p>`);
    expect(popular).not.toContain('popular-list');
    expect(popular).toContain('Bumi Manusia');
    expect(popular).toMatch(/href="\/katalog\/[0-9A-Z]{26}\/bumi-manusia"/);
    expect(popular).not.toContain('Laskar Pelangi');
    expect(popular).toContain('href="/cari?urut=populer"');
    const search = (await get('/cari?urut=populer')).text;
    expect(search.indexOf('Bumi Manusia')).toBeGreaterThan(-1);
    expect(search.indexOf('Bumi Manusia')).toBeLessThan(search.indexOf('Laskar Pelangi'));
    expect(search).toContain(`<option value="populer" selected="">${esc(opacText('id', 'search.sort.populer'))}</option>`);
    for (const page of [html, search, (await get('/?lang=en')).text]) {
      for (const b of borrowers) {
        expect(page).not.toContain(b.name);
        expect(page).not.toContain(b.no);
        expect(page).not.toContain(b.id);
      }
      // The four loans are never shown as a number of loans.
      expect(page).not.toMatch(/4\s*(?:kali|pinjaman|loans)/i);
    }
  });

  it('the loans per class: off by default; on, a class shows only with five different borrowers, by its counts and never a member', async () => {
    const stored = (await h.db.selectFrom('settings').select('value').where('key', '=', 'opac.home').executeTakeFirstOrThrow()).value!;
    const home = JSON.parse(stored) as OpacHomeContent;
    expect(home.blocks.readingClasses).toBe(false);
    await refreshClassActivity(h, NOW);
    expect(section((await get('/')).text, 'kelas-rajin')).toBeUndefined();

    // On, with three borrowers in X-1: still nothing.
    await setHome({ ...home, blocks: { ...home.blocks, readingClasses: true } });
    expect(section((await get('/')).text, 'kelas-rajin')).toBeUndefined();

    // Two more borrowers of X-1 lend the other title: five borrowers, six loans, two titles.
    for (let i = 3; i < 5; i += 1) {
      const id = newId(NOW);
      const no = `ANG-77${i}`;
      const name = `Rahasia Peminjam ${i}`;
      await h.db
        .insertInto('members')
        .values({
          id,
          member_no_display: no,
          member_no_key: normalizeKey(no),
          member_type_id: siswa,
          status: 'active',
          name,
          name_key: name.toLowerCase(),
          class_name: 'X-1',
          joined_on: '2026-01-01',
          valid_from: '2026-01-01',
          expires_on: '2099-01-01',
          created_at: NOW,
          updated_at: NOW,
        })
        .execute();
      borrowers.push({ id, no, name });
      const at = NOW - (10 + i) * DAY;
      const on = new Date(at).toISOString().slice(0, 10);
      await h.db
        .insertInto('loans')
        .values({
          id: newId(at),
          item_id: itemIds[0]!,
          open_item_id: null,
          record_id: records[0]!,
          member_id: id,
          branch_id: branchId,
          loaned_on: on,
          loaned_at: at,
          due_on: on,
          returned_on: on,
          returned_at: at + 3_600_000,
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
    await refreshClassActivity(h, NOW);
    try {
      for (const [locale, path] of [
        ['id', '/'],
        ['en', '/?lang=en'],
      ] as const) {
        const page = (await get(path)).text;
        const block = section(page, 'kelas-rajin')!;
        expect(block).toContain(`<h2 id="kelas-rajin">${esc(opacText(locale, 'home.classes.title'))}</h2>`);
        expect(block).toContain(`<span class="class-place">${esc(opacText(locale, 'home.classes.place', { n: '1' }))}</span>`);
        expect(block).toContain('<span class="class-label">X-1</span>');
        expect(block).toContain(`<span class="class-counts">${esc(opacText(locale, 'home.classes.counts', { loans: '6', titles: '2' }))}</span>`);
        for (const b of borrowers) {
          expect(page).not.toContain(b.name);
          expect(page).not.toContain(b.no);
          expect(page).not.toContain(b.id);
        }
      }
    } finally {
      await setHome(home);
    }
  });
});
