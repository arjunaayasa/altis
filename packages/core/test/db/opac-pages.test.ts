import { newId } from '@altis/shared';
import type { PageBody, PageTranslationInput } from '@altis/shared/api/opac-pages';
import { afterAll, beforeAll, describe, expect, it } from 'vitest';
import { engineLabel, testDbContext } from '../../../../tools/test/test-db.js';
import { renderMarkdown } from '../../src/html/markdown.js';
import { sanitizedHtml } from '../../src/html/sanitize.js';
import {
  OPAC_NEWS_PER_PAGE,
  archivePage,
  createPage,
  getPage,
  latestNews,
  listPages,
  newsPage,
  previewBody,
  publishedPage,
  upcomingEvents,
  updatePage,
} from '../../src/opac-pages/index.js';
import { ACTOR, NOW, audits, failure, fieldErrors, openRecordsDb, seedFile, type RecordsDb } from './catalog-records-support.js';

// Halaman & Berita, the service and the OPAC reads (Phase 2 spec §2.2, §9.5, §9.6, K14; plan Task 20) on the engine
// picked by ALTIS_TEST_DB:
// - a `markdown` body is stored as written, an `html` body as sanitizedHtml(body) (the equality, so the test holds
//   with any sanitizer), and the sanitized form must still fit MySQL TEXT (60 000 bytes: it can grow, `"` → `&quot;`);
// - slugs are unique per kind (archived pages included), the news slug `rss` is reserved, Indonesian is required;
// - a published page without a date is published now; a future `published_at` is a scheduled post the OPAC reads
//   leave out until the clock passes it (K14);
// - a cover and the images of a body (`/files/<id>`) claim their `opac.page_image` upload only while it has no owner
//   at all (owner_type and owner_id both null): an upload the orphan cleanup marked is never taken back;
// - a news post may have a category and an event (start, end, place); a page has none, and a post turned into a page
//   loses its own; the coming events are the published posts whose event has not ended, the soonest first;
// - every write is audited once (`opac.page.*`, entity `pages`), with field names only.

const ctx = testDbContext();
const HOUR = 3_600_000;
const MINUTE = 60_000;

/** A translation with a Markdown body. */
const tr = (title: string, body = `Isi ${title}.`, extra: Partial<PageTranslationInput> = {}): PageTranslationInput => ({
  title,
  bodyFormat: 'markdown',
  body,
  ...extra,
});

/** A page body: a published page with only Indonesian unless `o` says otherwise. */
function pageBody(slug: string, o: Partial<PageBody> = {}): PageBody {
  return {
    kind: 'page',
    slug,
    status: 'published',
    showInNav: false,
    sortOrder: 0,
    translations: { id: tr(`Halaman ${slug}`) },
    ...o,
  };
}

describe.skipIf(!ctx.available)(`Halaman & Berita service and OPAC reads [${engineLabel()}]`, () => {
  let db: RecordsDb;

  beforeAll(async () => {
    db = await openRecordsDb('opac-pages');
    await db.h.db
      .insertInto('staff_users')
      .values({ id: ACTOR.id!, username_key: 'redaksi', username_display: 'redaksi', name: 'Redaksi', password_hash: 'x', status: 'active', created_at: NOW, updated_at: NOW })
      .execute();
  });

  afterAll(async () => {
    await db?.close();
  });

  const fileRow = (id: string) =>
    db.h.db.selectFrom('files').select(['owner_type', 'owner_id', 'access']).where('id', '=', id).executeTakeFirstOrThrow();

  describe('bodies', () => {
    it('an html body with <script> is stored as sanitizedHtml(body); a Markdown body as written', async () => {
      const html = '<p onclick="steal()">Selamat datang</p><script>alert(1)</script><img src="https://evil.example/x.png">';
      const md = '# Jam buka\n\nSenin–Jumat <script>alert(1)</script>\n';
      const view = await db.run((tx) =>
        createPage(tx, pageBody('jam-buka', { translations: { id: tr('Jam buka', md), en: { title: 'Opening hours', bodyFormat: 'html', body: html } } })),
      );
      expect(view.translations.en?.body).toBe(sanitizedHtml(html));
      expect(view.translations.en?.body).not.toContain('<script');
      expect(view.translations.id.body).toBe(md);
      const rows = await db.h.db.selectFrom('page_translations').select(['locale', 'body', 'body_format']).where('page_id', '=', view.id).orderBy('locale').execute();
      expect(rows).toEqual([
        { locale: 'en', body: sanitizedHtml(html), body_format: 'html' },
        { locale: 'id', body: md, body_format: 'markdown' },
      ]);
    });

    it('an html body whose sanitized form passes 60 000 bytes is too_big, though the input fits', async () => {
      // 20 000 quotes are 20 000 bytes; sanitized, each is `&quot;` (6 bytes).
      const html = `<p>${'"'.repeat(20_000)}</p>`;
      expect(new TextEncoder().encode(html).byteLength).toBeLessThan(60_000);
      expect(await fieldErrors(db.run((tx) => createPage(tx, pageBody('kutipan', { translations: { id: { title: 'Kutipan', bodyFormat: 'html', body: html } } }))))).toEqual([
        { path: 'translations.id.body', code: 'too_big' },
      ]);
      expect(await db.h.db.selectFrom('pages').select('id').where('slug_key', '=', 'kutipan').execute()).toEqual([]);
    });

    it('previewBody renders Markdown and sanitizes HTML, as the OPAC does', () => {
      const md = '**tebal** <b>x</b>';
      expect(previewBody('markdown', md)).toBe(renderMarkdown(md));
      const html = '<h1>Judul</h1><iframe src="//x"></iframe>';
      expect(previewBody('html', html)).toBe(sanitizedHtml(html));
    });
  });

  describe('rules', () => {
    it('slugs are unique per kind (an archived page keeps its slug); the same slug in the other kind is fine', async () => {
      const first = await db.run((tx) => createPage(tx, pageBody('profil')));
      expect(await fieldErrors(db.run((tx) => createPage(tx, pageBody('profil'))))).toEqual([{ path: 'slug', code: 'taken' }]);
      const news = await db.run((tx) => createPage(tx, pageBody('profil', { kind: 'news' })));
      expect(news.kind).toBe('news');
      await db.run((tx) => archivePage(tx, first.id, first.version));
      expect(await fieldErrors(db.run((tx) => createPage(tx, pageBody('profil'))))).toEqual([{ path: 'slug', code: 'taken' }]);
      // A patch to another page's slug is taken too; to its own slug it is not.
      const other = await db.run((tx) => createPage(tx, pageBody('layanan')));
      expect(await fieldErrors(db.run((tx) => updatePage(tx, other.id, { version: other.version, slug: 'profil' })))).toEqual([{ path: 'slug', code: 'taken' }]);
      const same = await db.run((tx) => updatePage(tx, other.id, { version: other.version, slug: 'layanan', showInNav: true }));
      expect([same.slug, same.showInNav, same.version]).toEqual(['layanan', true, other.version + 1]);
    });

    it('the news slug `rss` is reserved (its URL is the feed); a page may be called rss', async () => {
      expect(await fieldErrors(db.run((tx) => createPage(tx, pageBody('rss', { kind: 'news' }))))).toEqual([{ path: 'slug', code: 'reserved' }]);
      const page = await db.run((tx) => createPage(tx, pageBody('rss')));
      expect(page.slug).toBe('rss');
      // Turning that page into news would take the feed's URL.
      expect(await fieldErrors(db.run((tx) => updatePage(tx, page.id, { version: page.version, kind: 'news' })))).toEqual([{ path: 'slug', code: 'reserved' }]);
    });

    it('the Indonesian translation is required; English is optional', async () => {
      const body = { ...pageBody('tanpa-id'), translations: { en: tr('English only') } } as unknown as PageBody;
      expect(await fieldErrors(db.run((tx) => createPage(tx, body)))).toEqual([{ path: 'translations.id', code: 'invalid_type' }]);
      const view = await db.run((tx) => createPage(tx, pageBody('hanya-id')));
      expect(view.translations.en).toBeNull();
    });

    it('a body the contract refuses is VALIDATION_FAILED before anything is written (slug, title, unknown key)', async () => {
      expect(await fieldErrors(db.run((tx) => createPage(tx, pageBody('Huruf Besar'))))).toEqual([{ path: 'slug', code: 'invalid_format' }]);
      const extra = { ...pageBody('lebih'), extra: 1 } as unknown as PageBody;
      expect(await fieldErrors(db.run((tx) => createPage(tx, extra)))).toEqual([{ path: '', code: 'unrecognized_keys' }]);
    });

    it('published without a date is published now; a draft keeps the date it was given (or none)', async () => {
      const now = NOW + 5 * MINUTE;
      const published = await db.run((tx) => createPage(tx, pageBody('terbit-kini', { kind: 'news' })), now);
      expect(published.publishedAt).toBe(now);
      const draft = await db.run((tx) => createPage(tx, pageBody('draf', { kind: 'news', status: 'draft' })), now);
      expect(draft.publishedAt).toBeNull();
      const planned = await db.run((tx) => createPage(tx, pageBody('draf-terjadwal', { kind: 'news', status: 'draft', publishedAt: now + HOUR })), now);
      expect(planned.publishedAt).toBe(now + HOUR);
      // Publishing the undated draft later dates it then.
      const later = now + 2 * HOUR;
      const out = await db.run((tx) => updatePage(tx, draft.id, { version: draft.version, status: 'published' }), later);
      expect([out.status, out.publishedAt]).toEqual(['published', later]);
      // An edit keeps the date.
      const again = await db.run((tx) => updatePage(tx, out.id, { version: out.version, sortOrder: 3 }), later + HOUR);
      expect(again.publishedAt).toBe(later);
    });
  });

  describe('writes', () => {
    it('create, update (translations replaced, English removed), archive: each audited once with field names only', async () => {
      const created = await db.run((tx) =>
        createPage(
          tx,
          pageBody('tata-tertib', { showInNav: true, sortOrder: 2, translations: { id: tr('Tata tertib', 'Dilarang makan.'), en: tr('Rules', 'No food.') } }),
        ),
      );
      expect(created).toMatchObject({ kind: 'page', slug: 'tata-tertib', status: 'published', showInNav: true, sortOrder: 2, archived: false, version: 0 });
      expect(created.translations.en).toMatchObject({ title: 'Rules', bodyFormat: 'markdown', body: 'No food.', summary: null });

      expect(await failure(db.run((tx) => updatePage(tx, created.id, { version: created.version + 1, sortOrder: 9 })))).toEqual({ code: 'CONFLICT_STALE' });
      const updated = await db.run((tx) =>
        updatePage(tx, created.id, {
          version: created.version,
          translations: { id: tr('Tata tertib baru', 'Dilarang makan dan minum.', { summary: 'Aturan ruang baca' }), en: null },
        }),
      );
      expect(updated.version).toBe(1);
      expect(updated.translations.id).toMatchObject({ title: 'Tata tertib baru', summary: 'Aturan ruang baca', body: 'Dilarang makan dan minum.' });
      expect(updated.translations.en).toBeNull();
      expect(await db.h.db.selectFrom('page_translations').select('locale').where('page_id', '=', created.id).execute()).toEqual([{ locale: 'id' }]);

      const archived = await db.run((tx) => archivePage(tx, created.id, updated.version));
      expect(archived).toEqual({ id: created.id, version: 2 });
      expect((await getPage(db.h.db, created.id)).archived).toBe(true);
      // Archived already, at its current version: answered as it is (one entry, marked); a stale version is refused.
      expect(await db.run((tx) => archivePage(tx, created.id, 2))).toEqual({ id: created.id, version: 2 });
      expect(await failure(db.run((tx) => archivePage(tx, created.id, 1)))).toEqual({ code: 'CONFLICT_STALE' });
      // Editing an archived page is NOT_FOUND.
      expect(await failure(db.run((tx) => updatePage(tx, created.id, { version: 2, sortOrder: 1 })))).toEqual({ code: 'NOT_FOUND' });

      expect(await audits(db, 'opac.page.create', created.id)).toEqual([
        { entity: 'pages', meta: { kind: 'page', status: 'published', locales: ['id', 'en'] } },
      ]);
      expect(await audits(db, 'opac.page.update', created.id)).toEqual([{ entity: 'pages', meta: { fields: ['translations.id', 'translations.en'] } }]);
      expect(await audits(db, 'opac.page.archive', created.id)).toEqual([
        { entity: 'pages', meta: {} },
        { entity: 'pages', meta: { alreadyArchived: true } },
      ]);
    });

    it('the agenda of a news post: created, read, changed field by field, audited by field name; refused on a page', async () => {
      const start = NOW + 72 * HOUR;
      const post = await db.run((tx) =>
        createPage(tx, pageBody('bedah-buku', { kind: 'news', category: 'agenda', eventStartsAt: start, eventEndsAt: start + 2 * HOUR, eventPlace: '  Ruang baca lantai 2 ' })),
      );
      expect(post).toMatchObject({ category: 'agenda', eventStartsAt: start, eventEndsAt: start + 2 * HOUR, eventPlace: 'Ruang baca lantai 2' });
      expect(await getPage(db.h.db, post.id)).toMatchObject({ category: 'agenda', eventStartsAt: start, eventEndsAt: start + 2 * HOUR, eventPlace: 'Ruang baca lantai 2' });
      // Without them: all null.
      const plain = await db.run((tx) => createPage(tx, pageBody('kabar-biasa', { kind: 'news' })));
      expect(plain).toMatchObject({ category: null, eventStartsAt: null, eventEndsAt: null, eventPlace: null });

      // Refused when created: an end before the start, an end or a place without a start, an agenda on a page.
      expect(await fieldErrors(db.run((tx) => createPage(tx, pageBody('agenda-salah-1', { kind: 'news', eventStartsAt: start, eventEndsAt: start - 1 }))))).toEqual([{ path: 'eventEndsAt', code: 'invalid' }]);
      expect(await fieldErrors(db.run((tx) => createPage(tx, pageBody('agenda-salah-2', { kind: 'news', eventEndsAt: start, eventPlace: 'Aula' }))))).toEqual([
        { path: 'eventEndsAt', code: 'invalid' },
        { path: 'eventPlace', code: 'invalid' },
      ]);
      expect(await fieldErrors(db.run((tx) => createPage(tx, pageBody('agenda-salah-3', { category: 'agenda', eventStartsAt: start }))))).toEqual([
        { path: 'category', code: 'invalid' },
        { path: 'eventStartsAt', code: 'invalid' },
      ]);
      expect(await db.h.db.selectFrom('pages').select('id').where('slug_key', 'like', 'agenda-salah-%').execute()).toEqual([]);

      // A patch is checked against the page as it leaves it: the end sent alone is compared with the start it holds.
      expect(await fieldErrors(db.run((tx) => updatePage(tx, post.id, { version: 0, eventEndsAt: start - 1 })))).toEqual([{ path: 'eventEndsAt', code: 'invalid' }]);
      expect(await fieldErrors(db.run((tx) => updatePage(tx, post.id, { version: 0, eventStartsAt: null })))).toEqual([
        { path: 'eventEndsAt', code: 'invalid' },
        { path: 'eventPlace', code: 'invalid' },
      ]);
      expect(await fieldErrors(db.run((tx) => updatePage(tx, plain.id, { version: 0, eventEndsAt: start })))).toEqual([{ path: 'eventEndsAt', code: 'invalid' }]);
      const moved = await db.run((tx) => updatePage(tx, post.id, { version: 0, category: 'activity', eventEndsAt: null, eventPlace: '' }));
      expect(moved).toMatchObject({ category: 'activity', eventStartsAt: start, eventEndsAt: null, eventPlace: null, version: 1 });
      // The same values sent again change no field.
      await db.run((tx) => updatePage(tx, post.id, { version: 1, category: 'activity', eventStartsAt: start }));
      expect(await audits(db, 'opac.page.update', post.id)).toEqual([
        { entity: 'pages', meta: { fields: ['category', 'eventEndsAt', 'eventPlace'] } },
        { entity: 'pages', meta: { fields: [] } },
      ]);

      // A page takes no agenda; a post turned into a page loses its own.
      const page = await db.run((tx) => createPage(tx, pageBody('bukan-berita')));
      expect(await fieldErrors(db.run((tx) => updatePage(tx, page.id, { version: 0, category: 'agenda' })))).toEqual([{ path: 'category', code: 'invalid' }]);
      expect(await fieldErrors(db.run((tx) => updatePage(tx, post.id, { version: 2, kind: 'page', eventStartsAt: start })))).toEqual([{ path: 'eventStartsAt', code: 'invalid' }]);
      const turned = await db.run((tx) => updatePage(tx, post.id, { version: 2, kind: 'page' }));
      expect(turned).toMatchObject({ kind: 'page', category: null, eventStartsAt: null, eventEndsAt: null, eventPlace: null });
      expect((await audits(db, 'opac.page.update', post.id)).at(-1)).toEqual({ entity: 'pages', meta: { fields: ['kind', 'category', 'eventStartsAt'] } });
    });

    it('unknown ids are NOT_FOUND', async () => {
      const id = newId();
      expect(await failure(getPage(db.h.db, id))).toEqual({ code: 'NOT_FOUND' });
      expect(await failure(getPage(db.h.db, 'bukan-ulid'))).toEqual({ code: 'NOT_FOUND' });
      expect(await failure(db.run((tx) => updatePage(tx, id, { version: 0, sortOrder: 1 })))).toEqual({ code: 'NOT_FOUND' });
      expect(await failure(db.run((tx) => archivePage(tx, id, 0)))).toEqual({ code: 'NOT_FOUND' });
    });
  });

  describe('page images', () => {
    it('a cover claims its unowned opac.page_image upload (owner pages, public); a marked, foreign or missing file is refused', async () => {
      const cover = await seedFile(db, { context: 'opac.page_image' });
      const view = await db.run((tx) => createPage(tx, pageBody('bersampul', { coverFileId: cover })));
      expect(view.coverFileId).toBe(cover);
      expect(await fileRow(cover)).toEqual({ owner_type: 'pages', owner_id: view.id, access: 'public' });
      // Its own cover again: nothing to claim.
      const same = await db.run((tx) => updatePage(tx, view.id, { version: view.version, coverFileId: cover }));
      expect(same.coverFileId).toBe(cover);

      // Marked by the orphan cleanup (owner_type 'orphan', owner_id null): its blob is about to go.
      const marked = await seedFile(db, { context: 'opac.page_image', ownerType: 'orphan' });
      const record = await seedFile(db, { context: 'catalog.cover' });
      const owned = await seedFile(db, { context: 'opac.page_image', ownerType: 'pages', ownerId: newId() });
      for (const fileId of [marked, record, owned]) {
        expect(await fieldErrors(db.run((tx) => createPage(tx, pageBody(`sampul-${fileId.slice(-6).toLowerCase()}`, { coverFileId: fileId })))), fileId).toEqual([
          { path: 'coverFileId', code: 'invalid' },
        ]);
      }
      expect(await fieldErrors(db.run((tx) => createPage(tx, pageBody('sampul-hilang', { coverFileId: newId() }))))).toEqual([{ path: 'coverFileId', code: 'not_found' }]);
      expect(await fileRow(marked)).toEqual({ owner_type: 'orphan', owner_id: null, access: 'staff' });
    });

    it('the images of a body (Markdown or HTML) claim their unowned uploads; a marked one stays marked', async () => {
      const inMd = await seedFile(db, { context: 'opac.page_image' });
      const inHtml = await seedFile(db, { context: 'opac.page_image' });
      const marked = await seedFile(db, { context: 'opac.page_image', ownerType: 'orphan' });
      const foreign = await seedFile(db, { context: 'catalog.cover' });
      const view = await db.run((tx) =>
        createPage(
          tx,
          pageBody('bergambar', {
            translations: {
              id: tr('Bergambar', `![Gedung](/files/${inMd})\n\n![Hilang](/files/${marked})\n\n![Sampul](/files/${foreign})`),
              en: { title: 'Pictures', bodyFormat: 'html', body: `<p><img src="/files/${inHtml}" alt="Building"></p>` },
            },
          }),
        ),
      );
      expect(await fileRow(inMd)).toEqual({ owner_type: 'pages', owner_id: view.id, access: 'public' });
      expect(await fileRow(inHtml)).toEqual({ owner_type: 'pages', owner_id: view.id, access: 'public' });
      expect(await fileRow(marked)).toEqual({ owner_type: 'orphan', owner_id: null, access: 'staff' });
      expect(await fileRow(foreign)).toEqual({ owner_type: null, owner_id: null, access: 'staff' });

      // An image added by an edit is claimed then.
      const later = await seedFile(db, { context: 'opac.page_image' });
      await db.run((tx) => updatePage(tx, view.id, { version: view.version, translations: { id: tr('Bergambar', `![Baru](/files/${later})`) } }));
      expect(await fileRow(later)).toEqual({ owner_type: 'pages', owner_id: view.id, access: 'public' });
    });
  });

  describe('lists', () => {
    it('listPages: one kind, live pages only, newest first, by keyset; the Indonesian title and whether English exists', async () => {
      const ids: string[] = [];
      for (let i = 0; i < 5; i++) {
        const v = await db.run(
          (tx) =>
            createPage(
              tx,
              pageBody(`daftar-${i}`, {
                kind: 'news',
                status: i % 2 === 0 ? 'published' : 'draft',
                translations: i === 0 ? { id: tr(`Daftar ${i}`), en: tr(`List ${i}`) } : { id: tr(`Daftar ${i}`) },
              }),
            ),
          NOW + (100 + i) * MINUTE,
        );
        ids.push(v.id);
      }
      const gone = await db.run((tx) => createPage(tx, pageBody('daftar-arsip', { kind: 'news' })), NOW + 200 * MINUTE);
      await db.run((tx) => archivePage(tx, gone.id, 0));

      const mine = (items: { id: string }[]) => items.filter((p) => ids.includes(p.id)).map((p) => p.id);
      const first = await listPages(db.h.db, { kind: 'news', limit: 2 });
      expect(first.items).toHaveLength(2);
      expect(first.items.map((p) => p.id)).not.toContain(gone.id);
      const all: string[] = [];
      let cursor: string | null = null;
      for (let guard = 0; guard < 50; guard++) {
        const pageOf = await listPages(db.h.db, { kind: 'news', limit: 2, ...(cursor === null ? {} : { cursor }) });
        all.push(...pageOf.items.map((p) => p.id));
        cursor = pageOf.nextCursor;
        if (cursor === null) break;
      }
      expect(new Set(all).size).toBe(all.length);
      expect(all).not.toContain(gone.id);
      expect(mine(all.map((id) => ({ id })))).toEqual([...ids].reverse());

      const drafts = await listPages(db.h.db, { kind: 'news', status: 'draft', limit: 200 });
      expect(mine(drafts.items)).toEqual([ids[3], ids[1]]);
      const item0 = (await listPages(db.h.db, { kind: 'news', limit: 200 })).items.find((p) => p.id === ids[0]);
      expect(item0).toMatchObject({ slug: 'daftar-0', title: 'Daftar 0', hasEnglish: true, status: 'published', kind: 'news' });
      const pagesOnly = await listPages(db.h.db, { kind: 'page', limit: 200 });
      expect(pagesOnly.items.every((p) => p.kind === 'page')).toBe(true);
      expect(await fieldErrors(listPages(db.h.db, { kind: 'news', limit: 2, cursor: 'bukan-kursor' }))).toEqual([{ path: 'cursor', code: 'invalid' }]);
    });
  });

  describe('OPAC reads (K14)', () => {
    /** A clock of its own, far after the other tests' pages. */
    const T0 = NOW + 30 * 24 * HOUR;

    it('publishedPage: published, dated at or before now, not archived, of its kind', async () => {
      const page = await db.run((tx) => createPage(tx, pageBody('sejarah', { translations: { id: tr('Sejarah'), en: tr('History') } })), T0);
      const found = await publishedPage(db.h.db, 'page', 'sejarah', T0);
      expect(found).toMatchObject({ id: page.id, kind: 'page', slug: 'sejarah', publishedAt: T0 });
      expect(found?.translations.id).toMatchObject({ title: 'Sejarah', bodyFormat: 'markdown', body: 'Isi Sejarah.' });
      expect(found?.translations.en?.title).toBe('History');
      expect(await publishedPage(db.h.db, 'news', 'sejarah', T0)).toBeNull();
      expect(await publishedPage(db.h.db, 'page', 'tidak-ada', T0)).toBeNull();

      const draft = await db.run((tx) => createPage(tx, pageBody('sejarah-draf', { status: 'draft', publishedAt: T0 - HOUR })), T0);
      expect(draft.publishedAt).toBe(T0 - HOUR);
      expect(await publishedPage(db.h.db, 'page', 'sejarah-draf', T0)).toBeNull();

      await db.run((tx) => archivePage(tx, page.id, page.version), T0);
      expect(await publishedPage(db.h.db, 'page', 'sejarah', T0)).toBeNull();
    });

    it('a news post published one hour ahead is in no read until the clock passes it', async () => {
      const t = T0 + 24 * HOUR;
      const post = await db.run((tx) => createPage(tx, pageBody('lomba-menulis', { kind: 'news', publishedAt: t + HOUR })), t);
      expect(post.publishedAt).toBe(t + HOUR);
      expect(await publishedPage(db.h.db, 'news', 'lomba-menulis', t)).toBeNull();
      expect((await latestNews(db.h.db, 50, t)).map((n) => n.slug)).not.toContain('lomba-menulis');
      expect((await newsPage(db.h.db, 1, t)).items.map((n) => n.slug)).not.toContain('lomba-menulis');

      expect(await publishedPage(db.h.db, 'news', 'lomba-menulis', t + HOUR - 1)).toBeNull();
      expect((await publishedPage(db.h.db, 'news', 'lomba-menulis', t + HOUR))?.id).toBe(post.id);
      expect((await latestNews(db.h.db, 1, t + HOUR)).map((n) => n.slug)).toEqual(['lomba-menulis']);
      expect((await newsPage(db.h.db, 1, t + HOUR)).items[0]?.slug).toBe('lomba-menulis');
    });

    it('newsPage: 10 per page, newest first, with the page count; latestNews: the n newest', async () => {
      const t = T0 + 48 * HOUR;
      const before = await newsPage(db.h.db, 1, t);
      const slugs: string[] = [];
      for (let i = 0; i < 12; i++) {
        const slug = `kabar-${String(i).padStart(2, '0')}`;
        slugs.push(slug);
        await db.run((tx) => createPage(tx, pageBody(slug, { kind: 'news', publishedAt: t + i * MINUTE, translations: { id: tr(`Kabar ${i}`, 'Isi.', { summary: `Ringkas ${i}` }) } })), t);
      }
      const at = t + HOUR;
      const p1 = await newsPage(db.h.db, 1, at);
      expect(OPAC_NEWS_PER_PAGE).toBe(10);
      expect(p1.items).toHaveLength(10);
      expect(p1.items.slice(0, 10).map((n) => n.slug)).toEqual([...slugs].reverse().slice(0, 10));
      expect(p1.items[0]).toMatchObject({ slug: 'kabar-11', publishedAt: t + 11 * MINUTE, translations: { id: { title: 'Kabar 11', summary: 'Ringkas 11' }, en: null } });
      expect(p1.total).toBe(before.total + 12);
      expect(p1.pages).toBe(Math.ceil(p1.total / 10));
      const p2 = await newsPage(db.h.db, 2, at);
      expect(p2.items.slice(0, 2).map((n) => n.slug)).toEqual(['kabar-01', 'kabar-00']);
      expect((await latestNews(db.h.db, 3, at)).map((n) => n.slug)).toEqual(['kabar-11', 'kabar-10', 'kabar-09']);
      expect(await newsPage(db.h.db, p1.pages + 1, at)).toMatchObject({ items: [], pages: p1.pages });
    });

    it('the news of one category: newsPage and latestNews narrowed, listPages too; a post carries its agenda', async () => {
      const t = T0 + 96 * HOUR;
      const before = await newsPage(db.h.db, 1, t + HOUR, 'collection');
      await db.run((tx) => createPage(tx, pageBody('koleksi-baru-a', { kind: 'news', category: 'collection', publishedAt: t })), t);
      await db.run((tx) => createPage(tx, pageBody('pengumuman-libur', { kind: 'news', category: 'announcement', publishedAt: t + MINUTE })), t);
      await db.run((tx) => createPage(tx, pageBody('koleksi-baru-b', { kind: 'news', category: 'collection', publishedAt: t + 2 * MINUTE })), t);
      await db.run((tx) => createPage(tx, pageBody('tanpa-kategori', { kind: 'news', publishedAt: t + 3 * MINUTE })), t);
      const at = t + HOUR;
      const collection = await newsPage(db.h.db, 1, at, 'collection');
      expect(collection.total).toBe(before.total + 2);
      expect(collection.items.slice(0, 2).map((n) => [n.slug, n.category])).toEqual([
        ['koleksi-baru-b', 'collection'],
        ['koleksi-baru-a', 'collection'],
      ]);
      expect((await latestNews(db.h.db, 1, at, 'announcement')).map((n) => n.slug)).toEqual(['pengumuman-libur']);
      expect((await latestNews(db.h.db, 4, at)).map((n) => n.slug)).toEqual(['tanpa-kategori', 'koleksi-baru-b', 'pengumuman-libur', 'koleksi-baru-a']);
      expect((await latestNews(db.h.db, 1, at))[0]).toMatchObject({ category: null, eventStartsAt: null, eventEndsAt: null, eventPlace: null });
      const listed = await listPages(db.h.db, { kind: 'news', category: 'announcement' });
      expect(listed.items.map((p) => [p.slug, p.category, p.eventStartsAt])).toEqual([['pengumuman-libur', 'announcement', null]]);
    });

    it('upcomingEvents: published posts whose event is ahead or still running, the soonest first, at most n', async () => {
      const t = T0 + 120 * HOUR;
      const DAY = 24 * HOUR;
      const event = (slug: string, o: Partial<PageBody>) => db.run((tx) => createPage(tx, pageBody(slug, { kind: 'news', category: 'agenda', publishedAt: t - DAY, ...o })), t - DAY);
      await event('acara-lusa', { eventStartsAt: t + 2 * DAY, eventPlace: 'Aula' });
      await event('acara-besok', { eventStartsAt: t + DAY, eventEndsAt: t + DAY + HOUR });
      await event('acara-berjalan', { eventStartsAt: t - HOUR, eventEndsAt: t + HOUR, category: 'activity' });
      await event('acara-tepat-sekarang', { eventStartsAt: t });
      // Left out: over (with and without an end), no event, a draft, one published later, an archived one.
      await event('acara-lewat', { eventStartsAt: t - 3 * HOUR, eventEndsAt: t - 1 });
      await event('acara-lewat-tanpa-akhir', { eventStartsAt: t - 1 });
      await event('bukan-acara', {});
      await event('acara-draf', { status: 'draft', eventStartsAt: t + DAY });
      await event('acara-terjadwal', { publishedAt: t + HOUR, eventStartsAt: t + DAY + 1 });
      const gone = await event('acara-diarsipkan', { eventStartsAt: t + DAY });
      await db.run((tx) => archivePage(tx, gone.id, gone.version), t - DAY);

      const events = await upcomingEvents(db.h.db, 10, t);
      expect(events.map((e) => e.slug)).toEqual(['acara-berjalan', 'acara-tepat-sekarang', 'acara-besok', 'acara-lusa']);
      expect(events[0]).toMatchObject({ category: 'activity', eventStartsAt: t - HOUR, eventEndsAt: t + HOUR, eventPlace: null, translations: { id: { title: 'Halaman acara-berjalan' }, en: null } });
      expect(events[3]).toMatchObject({ category: 'agenda', eventStartsAt: t + 2 * DAY, eventEndsAt: null, eventPlace: 'Aula' });
      expect((await upcomingEvents(db.h.db, 2, t)).map((e) => e.slug)).toEqual(['acara-berjalan', 'acara-tepat-sekarang']);
      expect(await upcomingEvents(db.h.db, 0, t)).toEqual([]);
      // Once the running one ended and the scheduled post is out.
      expect((await upcomingEvents(db.h.db, 10, t + HOUR + 1)).map((e) => e.slug)).toEqual(['acara-besok', 'acara-terjadwal', 'acara-lusa']);
      const page = await publishedPage(db.h.db, 'news', 'acara-lusa', t);
      expect(page).toMatchObject({ category: 'agenda', eventStartsAt: t + 2 * DAY, eventEndsAt: null, eventPlace: 'Aula' });
    });
  });
});
