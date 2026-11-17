import fsp from 'node:fs/promises';
import os from 'node:os';
import path from 'node:path';
import { createSettingsCache, indexRecords, readSettings, recordUrlPath, writeSettings } from '@altis/core';
import { PHASE1_MIGRATIONS, runMigrations, withTx } from '@altis/db';
import { newId, normalizeKey } from '@altis/shared';
import { OPAC_HOME_DEFAULT } from '@altis/shared/api/opac-home';
import { afterAll, beforeAll, describe, expect, it } from 'vitest';
import { engineLabel, testDb, testDbContext, type TestDbHandle } from '../../../../tools/test/test-db.js';
import { createApp } from '../../src/app.js';
import { seedLibrary } from '../../src/cli/install.js';
import { opacText } from '../../src/opac/catalog/messages.js';
import { createAgent, type AgentReply } from '../agent.js';
import { recordingLogger, sampleConfig } from '../support.js';

// The public site's pieces of this round, through the app on the engine picked by ALTIS_TEST_DB: what a title's copies
// allow now on the home page's cards, the result rows and the record page (the same words everywhere, from one grouped
// read of a page's copies, never anything about a borrower), the ISBN scope and field (an exact match), the advanced
// search page (a GET form whose answer is the normal results page), the count also when it is zero with "Hapus filter",
// and the library's logo and public contact in the header, the footer and the visit block.

const ctx = testDbContext();
const NOW = Date.UTC(2026, 10, 15, 5, 0, 0);
const CONFIG = sampleConfig();
const HTML = { Accept: 'text/html' };

const esc = (s: string): string => s.replace(/[&<>'"]/g, (ch) => ({ '&': '&amp;', '<': '&lt;', '>': '&gt;', "'": '&#39;', '"': '&quot;' })[ch]!);

/** The markup of the `<section>` whose heading has the id `id`. */
function section(html: string, id: string): string | undefined {
  return new RegExp(`<section[^>]*aria-labelledby="${id}"[^>]*>([\\s\\S]*?)</section>`).exec(html)?.[1];
}

/** The `<li class="card">` of the title `title` in `html`. */
function cardOf(html: string, title: string): string {
  const cards = [...html.matchAll(/<li class="card">([\s\S]*?)<\/li>/g)].map((m) => m[1]!);
  const card = cards.find((c) => c.includes(`>${esc(title)}`));
  if (card === undefined) throw new Error(`no card of ${title}`);
  return card;
}

describe.skipIf(!ctx.available)(`the public site's gaps [${engineLabel()}]`, () => {
  let h: TestDbHandle;
  let root: string;
  let app: ReturnType<typeof createApp>;
  let peer = 0;
  const get = (p: string): Promise<AgentReply> => {
    peer += 1;
    return createAgent(app, { peer: `198.18.41.${(peer % 250) + 1}` }).get(p, undefined, HTML);
  };
  const ids: Record<string, string> = {};
  const borrower = { id: '', no: 'RHS-404', name: 'Peminjam Sangat Rahasia' };
  const logoId = newId(NOW);

  beforeAll(async () => {
    h = await testDb();
    root = await fsp.mkdtemp(path.join(os.tmpdir(), 'altis-opac-gaps-'));
    await runMigrations(h, { appVersion: '0.1.0', dataDir: path.join(root, 'migrations'), migrations: PHASE1_MIGRATIONS });
    const db = h.db;
    const buku = (await db.selectFrom('material_types').select('id').where('code_key', '=', 'BUKU').executeTakeFirstOrThrow()).id;
    const umum = (await db.selectFrom('collection_types').select('id').where('code_key', '=', 'UMUM').executeTakeFirstOrThrow()).id;
    const siswa = (await db.selectFrom('member_types').select('id').where('code_key', '=', 'SISWA').executeTakeFirstOrThrow()).id;
    const branch = newId(NOW);
    await db.insertInto('branches').values({ id: branch, code_key: 'PUSAT2', code_display: 'PUSAT2', name: 'Pusat', timezone: 'Asia/Jakarta', created_at: NOW, updated_at: NOW }).execute();
    borrower.id = newId(NOW);
    await db
      .insertInto('members')
      .values({
        id: borrower.id,
        member_no_display: borrower.no,
        member_no_key: normalizeKey(borrower.no),
        member_type_id: siswa,
        status: 'active',
        name: borrower.name,
        name_key: borrower.name.toLowerCase(),
        email: 'rahasia@rumah.example',
        joined_on: '2026-01-01',
        valid_from: '2026-01-01',
        expires_on: '2099-01-01',
        created_at: NOW,
        updated_at: NOW,
      })
      .execute();
    let n = 0;
    const copy = async (recordId: string, status: string, loanDue?: string): Promise<void> => {
      n += 1;
      const itemId = newId(NOW);
      await db
        .insertInto('items')
        .values({ id: itemId, record_id: recordId, branch_id: branch, barcode_display: `GAP-${n}`, barcode_key: `GAP-${n}`, collection_type_id: umum, status, currency: 'IDR', created_at: NOW, updated_at: NOW })
        .execute();
      if (loanDue === undefined) return;
      await db
        .insertInto('loans')
        .values({
          id: newId(NOW),
          item_id: itemId,
          open_item_id: itemId,
          record_id: recordId,
          member_id: borrower.id,
          branch_id: branch,
          loaned_on: '2026-11-07',
          loaned_at: NOW - 8 * 86_400_000,
          due_on: loanDue,
          loan_days: 14,
          renew_limit: 1,
          grace_days: 0,
          fine_per_day_minor: 0,
          currency: 'IDR',
          source: 'desk',
          created_at: NOW,
          updated_at: NOW,
        })
        .execute();
    };
    for (const title of ['Laskar Pelangi', 'Sang Pemimpi', 'Kamus Besar', 'Edensor']) {
      const id = newId(NOW);
      await db
        .insertInto('records')
        .values({ id, material_type_id: buku, title, title_key: title.toLowerCase(), publication_year: '2005', source: 'manual', changed_at: NOW, created_at: NOW, updated_at: NOW })
        .execute();
      ids[title] = id;
    }
    await copy(ids['Laskar Pelangi']!, 'available');
    await copy(ids['Laskar Pelangi']!, 'available', '2026-11-29');
    await copy(ids['Sang Pemimpi']!, 'available', '2026-11-21');
    await copy(ids['Sang Pemimpi']!, 'available', '2026-12-02');
    await copy(ids['Kamus Besar']!, 'not_for_loan');
    await copy(ids['Edensor']!, 'available');
    await db
      .insertInto('record_identifiers')
      .values({ id: newId(NOW), record_id: ids['Edensor']!, type: 'isbn', value_display: '978-979-3062-79-2', value_key: '9789793062792' })
      .execute();
    await withTx(h, (trx) => indexRecords(trx, Object.values(ids), NOW));
    await db
      .insertInto('files')
      .values({
        id: logoId,
        original_name: 'logo.jpg',
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
    await withTx(h, (trx) =>
      writeSettings(
        trx,
        {
          'library.name': 'Perpustakaan Gap',
          'library.address': 'Jl. Contoh 1',
          'opac.home': {
            ...OPAC_HOME_DEFAULT,
            logo: { fileId: logoId, alt: 'Logo Perpustakaan Gap' },
            contact: { phone: '(021) 555-0101', email: 'perpustakaan@gap.example' },
          },
        },
        { keyring: CONFIG.keyring, now: NOW, actorId: null },
      ).then(() => undefined),
    );
    app = createApp({
      state: { phase: 'ready', db: h, config: CONFIG },
      version: '0.1.0',
      buildId: 'opac-gaps',
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

  /** No page says anything about the borrower: name, number, e-mail or id. */
  const noBorrower = (html: string): void => {
    for (const secret of [borrower.name, borrower.no, 'rahasia@rumah.example', borrower.id]) expect(html, secret).not.toContain(secret);
  };

  describe("a title's copies", () => {
    const WORDS: Record<string, [string, string]> = {
      'Laskar Pelangi': ['status status-ok', opacText('id', 'search.card.available_some', { count: 1, total: 2 })],
      'Sang Pemimpi': ['status status-warn', opacText('id', 'search.card.on_loan', { date: '21 Nov' })],
      'Kamus Besar': ['status status-muted', opacText('id', 'search.card.library_use')],
      Edensor: ['status status-ok', opacText('id', 'search.card.available')],
    };

    it('the home page cards: available (n of m), on loan with the earliest due date, library use only; nothing about who holds a copy', async () => {
      const html = (await get('/')).text;
      const fresh = section(html, 'judul-baru')!;
      for (const [title, [cls, words]] of Object.entries(WORDS)) expect(cardOf(fresh, title), title).toContain(`<span class="${cls} card-status">${esc(words)}</span>`);
      noBorrower(html);
    });

    it('the result rows say the same words, in English too', async () => {
      const html = (await get('/cari')).text;
      for (const [title, [cls, words]] of Object.entries(WORDS)) expect(cardOf(html, title), title).toContain(`<span class="${cls}">${esc(words)}</span>`);
      const en = (await get('/cari?lang=en')).text;
      expect(cardOf(en, 'Sang Pemimpi')).toContain(esc(opacText('en', 'search.card.on_loan', { date: '21 Nov' })));
      expect(cardOf(en, 'Laskar Pelangi')).toContain(esc(opacText('en', 'search.card.available_some', { count: 1, total: 2 })));
      noBorrower(html);
      noBorrower(en);
    });

    it("the record page's line, summary and table agree with the card", async () => {
      const laskar = (await get(recordUrlPath(ids['Laskar Pelangi']!, 'Laskar Pelangi'))).text;
      expect(laskar).toContain(`<p class="record-shelf"><span class="status status-ok">${esc(WORDS['Laskar Pelangi']![1])}</span></p>`);
      expect(laskar).toContain(esc(opacText('id', 'detail.availability_summary', { count: 2, available: 1 })));
      expect(laskar).toContain(esc(opacText('id', 'detail.on_loan', { date: '29 November 2026' })));
      const kamus = (await get(recordUrlPath(ids['Kamus Besar']!, 'Kamus Besar'))).text;
      expect(kamus).toContain(`<p class="record-shelf"><span class="status status-muted">${esc(WORDS['Kamus Besar']![1])}</span></p>`);
      // The status cell is marked so that a phone shows it first when a copy reads as a card.
      expect(kamus).toContain(`<td class="availability-status"><span class="status status-muted">${esc(opacText('id', 'search.card.library_use'))}</span></td>`);
      expect(kamus).toContain(esc(opacText('id', 'detail.availability_summary', { count: 1, available: 0 })));
      const pemimpi = (await get(recordUrlPath(ids['Sang Pemimpi']!, 'Sang Pemimpi'))).text;
      expect(pemimpi).toContain(esc(WORDS['Sang Pemimpi']![1]));
      for (const html of [laskar, kamus, pemimpi]) noBorrower(html);
    });
  });

  describe('the ISBN scope and field', () => {
    it('ruas=isbn finds the holder of the ISBN exactly, in its 10-digit form too; the scope stays chosen', async () => {
      const html = (await get('/cari?q=979-3062-79-7&ruas=isbn')).text;
      expect([...html.matchAll(/<li class="card">/g)]).toHaveLength(1);
      expect(cardOf(html, 'Edensor')).toBeTruthy();
      expect(html).toContain('<option value="isbn" selected="">');
      expect(html).toContain(esc(opacText('id', 'search.count_one')));
    });

    it('a text that is no ISBN finds nothing: the count says 0, never another title', async () => {
      const html = (await get('/cari?q=Laskar&ruas=isbn')).text;
      expect(html).not.toContain('<li class="card">');
      expect(html).toContain(`<p class="search-count">${esc(opacText('id', 'search.count_zero'))}</p>`);
      expect(html).toContain(esc(opacText('id', 'search.empty.title')));
    });

    it('the isbn field is a filter shown among the active ones, with a link that removes it', async () => {
      const html = (await get('/cari?isbn=9793062797')).text;
      expect(cardOf(html, 'Edensor')).toBeTruthy();
      const active = section(html, 'filter-aktif')!;
      expect(active).toContain(`<a href="/cari">${esc(`${opacText('id', 'search.filter.isbn')}: 9793062797`)} `);
    });
  });

  describe('the results page', () => {
    it('with a filter set: "Hapus filter" beside the count, to the same search without the filters', async () => {
      const html = (await get('/cari?q=pelangi&jenis=BUKU&tahun=2005')).text;
      expect(html).toContain(`<a class="filters-remove" href="/cari?q=pelangi">${esc(opacText('id', 'search.filters.remove'))}</a>`);
      expect((await get('/cari?q=pelangi')).text).not.toContain('filters-remove');
      // Nothing found with a filter: the count says 0 and the empty state offers to remove them.
      const none = (await get('/cari?q=pelangi&tahun=1990')).text;
      expect(none).toContain(`<p class="search-count">${esc(opacText('id', 'search.count_zero'))}</p>`);
      expect(none).toContain(`<a class="empty-clear" href="/cari?q=pelangi">`);
    });

    it('links the advanced search with the same search filled in', async () => {
      const html = (await get('/cari?q=pelangi&ruas=judul&jenis=BUKU&urut=judul')).text;
      expect(html).toContain(`<a class="advanced-link" href="/cari/lanjutan?q=pelangi&amp;ruas=judul&amp;jenis=BUKU">${esc(opacText('id', 'search.advanced.link'))}</a>`);
    });
  });

  describe('the advanced search page', () => {
    it('a GET form to /cari over the existing parameters, without a script; noindex', async () => {
      const res = await get('/cari/lanjutan');
      expect(res.status).toBe(200);
      const html = res.text;
      expect(html).toContain(`<h1>${esc(opacText('id', 'search.advanced.title'))}</h1>`);
      expect(html).toContain('<meta name="robots" content="noindex, follow"');
      expect(html).not.toContain('<script');
      expect(html).toContain('<form class="advanced-form" method="get" action="/cari">');
      for (const name of ['q', 'judul', 'penulis', 'topik', 'penerbit', 'isbn', 'tahun']) expect(html, name).toMatch(new RegExp(`<input id="[^"]+" type="text" name="${name}"`));
      for (const name of ['jenis', 'bahasa', 'koleksi', 'urut']) expect(html, name).toContain(`name="${name}"`);
      expect(html).toContain('<option value="BUKU">');
      expect(html).toContain('<input id="lanjut-tersedia" type="checkbox" name="tersedia" value="1"/>');
      // Every field has its visible label.
      for (const m of html.matchAll(/<(?:input|select) id="(lanjut-[a-z]+)"/g)) expect(html, m[1]).toContain(`<label for="${m[1]!}">`);
    });

    it('opens with the search a link carried: the text in its field, the filters chosen', async () => {
      const html = (await get('/cari/lanjutan?q=pelangi&ruas=judul&jenis=BUKU&tersedia=1&lang=en')).text;
      expect(html).toContain('<input id="lanjut-judul" type="text" name="judul" value="pelangi"');
      expect(html).toContain('<option value="BUKU" selected="">');
      expect(html).toContain('<input id="lanjut-tersedia" type="checkbox" name="tersedia" value="1" checked=""/>');
      expect(html).toContain('<input type="hidden" name="lang" value="en"/>');
      expect(html).toContain(`<h1>${esc(opacText('en', 'search.advanced.title'))}</h1>`);
    });

    it('its answer is the normal results page, the fields folded into the text and the filters shown', async () => {
      const html = (await get('/cari?q=&judul=pelangi&penulis=&topik=&penerbit=&isbn=&tahun=2005&jenis=BUKU&urut=relevansi')).text;
      expect(cardOf(html, 'Laskar Pelangi')).toBeTruthy();
      expect(html).toContain('<input id="cari-q" type="search" name="q" value="judul:pelangi"');
      const active = section(html, 'filter-aktif')!;
      expect(active).toContain('/cari?q=judul%3Apelangi&amp;tahun=2005&amp;urut=relevansi');
    });

    it('linked from the home page search card', async () => {
      const html = (await get('/')).text;
      expect(html).toContain(`<a href="/cari/lanjutan">${esc(opacText('id', 'search.advanced.link'))}</a>`);
      // The ISBN scope is one of the card's choices.
      expect(html).toContain(`<input type="radio" name="ruas" value="isbn"/><span>${esc(opacText('id', 'search.scope.isbn'))}</span>`);
    });
  });

  describe("the library's logo and contact", () => {
    it('the logo with its alternative text before the name in the header and the footer; the contact as links in the footer and the visit block', async () => {
      const html = (await get('/')).text;
      expect(html).toContain(`<img class="brand-logo" src="/files/${logoId}" alt="Logo Perpustakaan Gap" height="40" decoding="async"/><span class="brand-name">Perpustakaan Gap</span>`);
      expect(html).toContain(`<img class="foot-logo" src="/files/${logoId}" alt="Logo Perpustakaan Gap"`);
      const visit = section(html, 'kunjungi-judul')!;
      for (const part of [visit, /<footer[\s\S]*<\/footer>/.exec(html)![0]]) {
        expect(part).toContain('<a href="tel:0215550101">(021) 555-0101</a>');
        expect(part).toContain('<a href="mailto:perpustakaan@gap.example">perpustakaan@gap.example</a>');
      }
      // The footer's line: the year and the library.
      expect(html).toContain('<span>© 2026 Perpustakaan Gap</span>');
      // Every page has them, the results page too.
      const results = (await get('/cari')).text;
      expect(results).toContain('class="brand-logo"');
      expect(results).toContain('href="tel:0215550101"');
    });
  });

  // Last: it seeds the library profile again.
  describe('the OPAC accent', () => {
    const accentRow = () => h.db.selectFrom('settings').select('value').where('key', '=', 'opac.accent').executeTakeFirst();
    const accent = async () => (await readSettings(h.db, ['opac.accent'], []))['opac.accent'];
    const profile = { name: 'Perpustakaan Gap', timezone: 'Asia/Jakarta', locale: 'id' as const };

    it("an install made before keeps the accent it reads (no row: the setting's default, untouched by this release)", async () => {
      expect(await accentRow()).toBeUndefined();
      expect(await accent()).toBe('teal');
      expect((await get('/')).text).toContain('<html lang="id" data-accent="teal">');
    });

    it("a fresh install starts with the design's blue; a stored choice is never changed, a resumed install included", async () => {
      await withTx(h, (trx) => seedLibrary(trx, profile, { now: NOW }));
      expect(await accent()).toBe('blue');
      expect((await get('/')).text).toContain('<html lang="id" data-accent="blue">');
      await withTx(h, (trx) => writeSettings(trx, { 'opac.accent': 'green' }, { keyring: CONFIG.keyring, now: NOW, actorId: null }).then(() => undefined));
      await withTx(h, (trx) => seedLibrary(trx, profile, { now: NOW + 1000 }));
      expect(await accent()).toBe('green');
      expect((await get('/')).text).toContain('<html lang="id" data-accent="green">');
    });
  });
});
