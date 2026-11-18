import fsp from 'node:fs/promises';
import os from 'node:os';
import path from 'node:path';
import { previewBody, sanitizedHtml } from '@altis/core';
import { PHASE1_MIGRATIONS, runMigrations } from '@altis/db';
import type { PageListResponse, PagePreviewResponse, PageView } from '@altis/shared/api/opac-pages';
import { afterAll, beforeAll, describe, expect, it } from 'vitest';
import { engineLabel, testDb, testDbContext, type TestDbHandle } from '../../../../tools/test/test-db.js';
import { createApp } from '../../src/app.js';
import { createAgent, type AgentReply } from '../agent.js';
import { recordingLogger, sampleConfig } from '../support.js';
import { seedStaff, sessionCookieFor, sessionCsrfFor } from '../support-auth.js';

// The admin API of Halaman & Berita (Phase 2 Task 20; spec §9.5, §12.2; S15, S6) on the engine picked by ALTIS_TEST_DB:
// - `POST opac/pages` (201), `PATCH opac/pages/:id`, `DELETE opac/pages/:id` ({version}) answer `{id, version}` only
//   (StoreResponse): a page with two 60 KB bodies, created with an Idempotency-Key, is answered and replayed;
// - `GET opac/pages?kind=` lists one kind, `GET opac/pages/:id` reads the page as the editor edits it (an html body
//   stored sanitized);
// - `POST opac/pages/preview` (a read) answers the HTML the OPAC would show, for the editor's sandboxed iframe;
// - all of it needs `opac.pages.manage`.

const ctx = testDbContext();
let h: TestDbHandle;

/** In the past: an audit entry may not be dated ahead of the real clock. */
const NOW = Date.UTC(2026, 9, 22, 9, 0, 5);
const CONFIG = sampleConfig();
const SID = '__Host-altis_sid';
const PAGES = '/api/v1/opac/pages';

interface Client {
  get(p: string): Promise<AgentReply>;
  send(method: 'post' | 'patch' | 'delete', p: string, body?: unknown, key?: string): Promise<AgentReply>;
}

const code = (res: AgentReply): string | undefined => (res.json as { code?: string } | undefined)?.code;
const errors = (res: AgentReply): { path: string; code: string }[] => (res.json as { errors?: { path: string; code: string }[] }).errors ?? [];
const stored = (res: AgentReply): { id: string; version: number } => res.json as { id: string; version: number };

/** A Markdown body of exactly `bytes` ASCII bytes. */
const bodyOf = (bytes: number, line: string): string => {
  const text = `${line}\n\n`.repeat(Math.ceil(bytes / (line.length + 2)));
  return text.slice(0, bytes);
};

describe.skipIf(!ctx.available)(`Halaman & Berita API [${engineLabel()}]`, () => {
  let root: string;
  let app: ReturnType<typeof createApp>;
  let editor: Client;
  let stranger: Client;

  async function signedIn(username: string, permissions: string[]): Promise<Client> {
    const user = await seedStaff(h, { username, now: NOW, roles: [{ permissions: permissions as never }] });
    const token = await sessionCookieFor(h, user.id, { now: NOW });
    const agent = createAgent(app);
    agent.setCookie(SID, token);
    const csrf = { 'x-csrf-token': sessionCsrfFor(CONFIG, token) };
    return {
      get: (p) => agent.get(p),
      send: (method, p, body, key) => agent[method](p, body, key === undefined ? csrf : { ...csrf, 'idempotency-key': key }),
    };
  }

  const page = (slug: string, extra: Record<string, unknown> = {}) => ({
    kind: 'page',
    slug,
    status: 'published',
    showInNav: false,
    sortOrder: 0,
    translations: { id: { title: `Halaman ${slug}`, bodyFormat: 'markdown', body: `Isi ${slug}.` } },
    ...extra,
  });

  beforeAll(async () => {
    h = await testDb();
    root = await fsp.realpath(await fsp.mkdtemp(path.join(os.tmpdir(), 'altis-api-pages-')));
    await runMigrations(h, { appVersion: '0.1.0', dataDir: root, migrations: PHASE1_MIGRATIONS });
    app = createApp({ state: { phase: 'ready', db: h, config: CONFIG }, version: '0.1.0', buildId: 'b', log: recordingLogger(), clock: () => NOW, dataDir: root });
    editor = await signedIn('redaksi', ['opac.pages.manage']);
    stranger = await signedIn('pustakawan', ['catalog.records.read']);
  });

  afterAll(async () => {
    await h?.close();
    if (root !== undefined) await fsp.rm(root, { recursive: true, force: true });
  });

  it('create 201 {id, version} only; GET reads the page; the list of its kind shows it', async () => {
    const html = '<p>Koleksi <em>baru</em></p><script>alert(1)</script>';
    const res = await editor.send('post', PAGES, page('koleksi', { translations: { id: { title: 'Koleksi', bodyFormat: 'html', body: html, summary: 'Ringkasan' } } }));
    expect(res.status, res.text).toBe(201);
    expect(res.json).toEqual({ id: expect.any(String), version: 0 });
    const { id } = stored(res);

    const got = await editor.get(`${PAGES}/${id}`);
    expect(got.status, got.text).toBe(200);
    const view = got.json as PageView;
    expect(view).toMatchObject({ id, kind: 'page', slug: 'koleksi', status: 'published', publishedAt: NOW, archived: false, version: 0 });
    expect(view.translations.id).toEqual({ title: 'Koleksi', summary: 'Ringkasan', bodyFormat: 'html', body: sanitizedHtml(html), updatedAt: NOW });
    expect(view.translations.en).toBeNull();

    const list = await editor.get(`${PAGES}?kind=page`);
    expect(list.status, list.text).toBe(200);
    expect((list.json as PageListResponse).items.map((p) => p.id)).toContain(id);
    expect(((await editor.get(`${PAGES}?kind=news`)).json as PageListResponse).items.map((p) => p.id)).not.toContain(id);
    const noKind = await editor.get(PAGES);
    expect([noKind.status, code(noKind), errors(noKind).map((e) => e.path)]).toEqual([422, 'VALIDATION_FAILED', ['kind']]);
  });

  it('S15: two 60 KB bodies with an Idempotency-Key → 201 {id, version}; the replay answers the same, one page, one entry', async () => {
    const id60 = bodyOf(60_000, 'Perpustakaan sekolah membuka layanan baca setiap hari kerja.');
    const en60 = bodyOf(60_000, 'The school library opens its reading room on every working day.');
    expect([new TextEncoder().encode(id60).byteLength, new TextEncoder().encode(en60).byteLength]).toEqual([60_000, 60_000]);
    const body = page('layanan-baca', { translations: { id: { title: 'Layanan baca', bodyFormat: 'markdown', body: id60 }, en: { title: 'Reading room', bodyFormat: 'markdown', body: en60 } } });
    const key = 'halaman-60kb-0001';
    const first = await editor.send('post', PAGES, body, key);
    expect(first.status, first.text).toBe(201);
    expect(first.json).toEqual({ id: expect.any(String), version: 0 });
    const again = await editor.send('post', PAGES, body, key);
    expect([again.status, again.json]).toEqual([201, first.json]);
    expect(await h.db.selectFrom('pages').select('id').where('slug_key', '=', 'layanan-baca').execute()).toEqual([{ id: stored(first).id }]);
    const entries = await h.db.selectFrom('audit_log').select('action').where('entity_id', '=', stored(first).id).execute();
    expect(entries).toEqual([{ action: 'opac.page.create' }]);
    const view = (await editor.get(`${PAGES}/${stored(first).id}`)).json as PageView;
    expect([view.translations.id.body, view.translations.en?.body]).toEqual([id60, en60]);
  });

  it('PATCH and DELETE answer {id, version}; a stale version is 409; field errors name their paths', async () => {
    const { id } = stored(await editor.send('post', PAGES, page('pengumuman', { kind: 'news' })));
    const patched = await editor.send('patch', `${PAGES}/${id}`, { version: 0, status: 'draft', showInNav: true });
    expect([patched.status, patched.json]).toEqual([200, { id, version: 1 }]);
    const stale = await editor.send('patch', `${PAGES}/${id}`, { version: 0, sortOrder: 4 });
    expect([stale.status, code(stale)]).toEqual([409, 'CONFLICT_STALE']);

    const reserved = await editor.send('patch', `${PAGES}/${id}`, { version: 1, slug: 'rss' });
    expect([reserved.status, errors(reserved)]).toEqual([422, [{ path: 'slug', code: 'reserved' }]]);
    stored(await editor.send('post', PAGES, page('lain', { kind: 'news' })));
    const taken = await editor.send('patch', `${PAGES}/${id}`, { version: 1, slug: 'lain' });
    expect([taken.status, errors(taken)]).toEqual([422, [{ path: 'slug', code: 'taken' }]]);
    const tooBig = await editor.send('patch', `${PAGES}/${id}`, {
      version: 1,
      translations: { id: { title: 'Kutipan', bodyFormat: 'html', body: `<p>${'"'.repeat(20_000)}</p>` } },
    });
    expect([tooBig.status, errors(tooBig)]).toEqual([422, [{ path: 'translations.id.body', code: 'too_big' }]]);

    const archived = await editor.send('delete', `${PAGES}/${id}`, { version: 1 });
    expect([archived.status, archived.json]).toEqual([200, { id, version: 2 }]);
    expect(((await editor.get(`${PAGES}?kind=news`)).json as PageListResponse).items.map((p) => p.id)).not.toContain(id);
    expect(((await editor.get(`${PAGES}/${id}`)).json as PageView).archived).toBe(true);
    const unknown = await editor.get(`${PAGES}/01JZ0000000000000000000ABC`);
    expect([unknown.status, code(unknown)]).toEqual([404, 'NOT_FOUND']);
  });

  it('the agenda of a news post: created, read, listed by category, patched; its field errors name their paths', async () => {
    const start = NOW + 10 * 24 * 3_600_000;
    const { id } = stored(await editor.send('post', PAGES, page('bedah-buku', { kind: 'news', category: 'agenda', eventStartsAt: start, eventEndsAt: start + 7_200_000, eventPlace: 'Ruang baca lantai 2' })));
    stored(await editor.send('post', PAGES, page('kabar-koleksi', { kind: 'news', category: 'collection' })));
    expect((await editor.get(`${PAGES}/${id}`)).json).toMatchObject({ category: 'agenda', eventStartsAt: start, eventEndsAt: start + 7_200_000, eventPlace: 'Ruang baca lantai 2' });
    const listed = (await editor.get(`${PAGES}?kind=news&category=agenda`)).json as PageListResponse;
    expect(listed.items.map((p) => [p.id, p.category, p.eventStartsAt])).toEqual([[id, 'agenda', start]]);
    expect((await editor.get(`${PAGES}?kind=news&category=lain`)).status).toBe(422);

    const patched = await editor.send('patch', `${PAGES}/${id}`, { version: 0, category: 'activity', eventEndsAt: null });
    expect([patched.status, patched.json]).toEqual([200, { id, version: 1 }]);
    expect((await editor.get(`${PAGES}/${id}`)).json).toMatchObject({ category: 'activity', eventStartsAt: start, eventEndsAt: null, eventPlace: 'Ruang baca lantai 2' });

    const endFirst = await editor.send('patch', `${PAGES}/${id}`, { version: 1, eventEndsAt: start - 1 });
    expect([endFirst.status, errors(endFirst)]).toEqual([422, [{ path: 'eventEndsAt', code: 'invalid' }]]);
    const noStart = await editor.send('post', PAGES, page('tanpa-mulai', { kind: 'news', eventEndsAt: start }));
    expect([noStart.status, errors(noStart)]).toEqual([422, [{ path: 'eventEndsAt', code: 'invalid' }]]);
    const onPage = await editor.send('post', PAGES, page('bukan-berita', { category: 'agenda' }));
    expect([onPage.status, errors(onPage)]).toEqual([422, [{ path: 'category', code: 'invalid' }]]);
    const unknownCategory = await editor.send('post', PAGES, page('kategori-lain', { kind: 'news', category: 'lain' }));
    expect(unknownCategory.status).toBe(422);
    const longPlace = await editor.send('patch', `${PAGES}/${id}`, { version: 1, eventPlace: 'r'.repeat(161) });
    expect([longPlace.status, errors(longPlace).map((e) => e.path)]).toEqual([422, ['eventPlace']]);
    // Nothing of the refused writes was stored.
    expect((await editor.get(`${PAGES}/${id}`)).json).toMatchObject({ version: 1, category: 'activity', eventEndsAt: null });
  });

  it('preview answers the HTML the OPAC would show: Markdown rendered, HTML sanitized (S6)', async () => {
    const lastSeq = async (): Promise<number> => Number((await h.db.selectFrom('audit_head').select('last_seq').where('id', '=', 1).executeTakeFirstOrThrow()).last_seq);
    const before = await lastSeq();
    const md = '## Jam buka\n\nSenin–Jumat, **07.00–15.00** <img src=x onerror=alert(1)>';
    const res = await editor.send('post', `${PAGES}/preview`, { bodyFormat: 'markdown', body: md });
    expect(res.status, res.text).toBe(200);
    expect(res.json).toEqual({ html: previewBody('markdown', md) } satisfies PagePreviewResponse);
    expect((res.json as PagePreviewResponse).html).toContain('<strong>07.00–15.00</strong>');
    // Raw HTML in Markdown is text: escaped, never an element.
    expect((res.json as PagePreviewResponse).html).not.toContain('<img');
    expect((res.json as PagePreviewResponse).html).toContain('&lt;img');
    const html = '<p onmouseover="x()">Halo</p><script>alert(1)</script>';
    expect((await editor.send('post', `${PAGES}/preview`, { bodyFormat: 'html', body: html })).json).toEqual({ html: sanitizedHtml(html) });
    // A read: nothing audited.
    expect(await lastSeq()).toBe(before);
  });

  it('without opac.pages.manage every route is 403', async () => {
    const { id } = stored(await editor.send('post', PAGES, page('rahasia')));
    const calls: [string, () => Promise<AgentReply>][] = [
      ['list', () => stranger.get(`${PAGES}?kind=page`)],
      ['get', () => stranger.get(`${PAGES}/${id}`)],
      ['create', () => stranger.send('post', PAGES, page('lain-lagi'))],
      ['update', () => stranger.send('patch', `${PAGES}/${id}`, { version: 0, sortOrder: 1 })],
      ['archive', () => stranger.send('delete', `${PAGES}/${id}`, { version: 0 })],
      ['preview', () => stranger.send('post', `${PAGES}/preview`, { bodyFormat: 'markdown', body: 'x' })],
    ];
    for (const [name, call] of calls) {
      const res = await call();
      expect([name, res.status, code(res)]).toEqual([name, 403, 'AUTHZ_DENIED']);
    }
  });
});
