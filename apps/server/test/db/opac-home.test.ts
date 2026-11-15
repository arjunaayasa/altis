import fsp from 'node:fs/promises';
import os from 'node:os';
import path from 'node:path';
import { createSettingsCache, indexRecords, refreshPopularTitles, writeSettings } from '@altis/core';
import { PHASE1_MIGRATIONS, runMigrations, withTx } from '@altis/db';
import { newId, normalizeKey } from '@altis/shared';
import { OPAC_HOME_DEFAULT, type OpacHomeContent } from '@altis/shared/api/opac-home';
import { afterAll, beforeAll, describe, expect, it } from 'vitest';
import { engineLabel, testDb, testDbContext, type TestDbHandle } from '../../../../tools/test/test-db.js';
import { createApp } from '../../src/app.js';
import { opacText } from '../../src/opac/catalog/messages.js';
import { createAgent, type AgentReply } from '../agent.js';
import { recordingLogger, sampleConfig } from '../support.js';

// The OPAC home page as the library's profile site, through the app on the engine picked by ALTIS_TEST_DB: the hero
// band (the photo under its overlay, or the library colour), the floating search card, the profile blocks shown only
// with content and while switched on, the library's texts escaped and marked with its language, and the popular titles
// from their aggregate. No borrower datum reaches the page or the "most borrowed" search: not a member's name, number
// or id, and no loan count.

const ctx = testDbContext();
const NOW = Date.UTC(2026, 10, 15, 5, 0, 0);
const DAY = 86_400_000;
const CONFIG = sampleConfig();
const HTML = { Accept: 'text/html' };

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
    const siswa = (await db.selectFrom('member_types').select('id').where('code_key', '=', 'SISWA').executeTakeFirstOrThrow()).id;
    const branchId = newId(NOW);
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
    const records: string[] = [];
    for (const title of ['Laskar Pelangi', 'Bumi Manusia']) {
      const id = newId(NOW);
      await db.insertInto('records').values({ id, material_type_id: buku, title, title_key: title.toLowerCase(), source: 'manual', changed_at: NOW, created_at: NOW, updated_at: NOW }).execute();
      const itemId = newId(NOW);
      await db
        .insertInto('items')
        .values({ id: itemId, record_id: id, branch_id: branchId, barcode_display: `B-${title.length}`, barcode_key: `B-${title.length}`, collection_type_id: umum, status: 'available', currency: 'IDR', created_at: NOW, updated_at: NOW })
        .execute();
      records.push(id);
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
    expect(html).toContain(esc(opacText('id', 'home.search.titles', { count: '2' })));
    for (const id of ['tentang-judul', 'layanan-judul']) expect(section(html, id), id).toBeUndefined();
    // The visit block shows the library's address alone.
    expect(section(html, 'kunjungi-judul')).toContain('<p class="visit-address">Jl. Pendidikan 1\nKota Contoh</p>');
    expect(html).not.toContain('style=');
  });

  it('with a profile: the photo under the overlay with its alt text and position, the heading, about with its facts, the services and photos, the hours; texts escaped', async () => {
    await setHome({
      ...OPAC_HOME_DEFAULT,
      title: 'Ruang baca <untuk> semua',
      hero: { fileId: photoId, alt: 'Gedung "B" perpustakaan', position: 40 },
      about: { text: 'Berdiri sejak 1987.\nMelayani siswa & guru.', photo: { fileId: aboutPhotoId, alt: 'Ruang baca', caption: 'Lantai 1' }, founded: 1987, librarians: 3 },
      services: [{ title: 'Peminjaman <buku>', text: 'Bawa kartu anggota.' }],
      facilities: [],
      hours: [{ days: 'Senin–Jumat', time: '07.00–15.00' }],
    });
    const html = (await get('/')).text;
    expect(html).toContain('<header class="site-header hero-band hero-photo">');
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
    expect(section(html, 'kunjungi-judul')).toContain('<th scope="row">Senin–Jumat</th><td>07.00–15.00</td>');
    expect(html).not.toContain('<untuk>');
    expect(html).not.toContain('<buku>');
    expect(html).not.toContain('style=');

    // In English, the library's own texts carry their language.
    const en = (await get('/?lang=en')).text;
    expect(en).toContain('<p class="about-text" lang="id">');
    expect(en).toContain('<ul class="service-list" lang="id">');
  });

  it('a block switched off is left out, whatever it holds', async () => {
    const stored = (await h.db.selectFrom('settings').select('value').where('key', '=', 'opac.home').executeTakeFirstOrThrow()).value!;
    const home = JSON.parse(stored) as OpacHomeContent;
    await setHome({ ...home, blocks: { ...home.blocks, about: false, services: false, visit: false, popular: false, classes: false } });
    const html = (await get('/')).text;
    for (const id of ['tentang-judul', 'layanan-judul', 'kunjungi-judul', 'judul-populer', 'jelajah-kelas']) expect(section(html, id), id).toBeUndefined();
    await setHome(home);
  });

  it('the popular titles: a numbered list linking the most borrowed search; no borrower and no count on the page or in that search', async () => {
    const html = (await get('/')).text;
    const popular = section(html, 'judul-populer')!;
    expect(popular).toContain('<ol class="popular-list">');
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
});
