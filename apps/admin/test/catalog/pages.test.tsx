import { MESSAGES } from '@altis/shared';
import type { PageListItem, PageView } from '@altis/shared/api/opac-pages';
import { fireEvent, screen, waitFor, within } from '@testing-library/react';
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import { ADMIN_MESSAGES, type AdminKey } from '@/i18n';
import { uploadFile } from '@/lib/upload';
import { fromLocalInput } from '@/screens/pages/shared';
import { adminMe, json, problem, signedIn, startApp, type FakeRequest } from '../fake-api';

// The admin screens of Halaman & Berita (Phase 2 Task 20; spec §9.5, §13; S6, S15) through the real router and API
// client against a fake `/api/v1`:
// - the list of one kind (`GET opac/pages?kind=`), the other kind on its tab, archive after a confirmation with the
//   page's version;
// - the editor posts the expected body (`POST opac/pages`, answered `{id, version}` only) and opens the page it made;
//   an edit sends only what changed, with the version, and the next save the version the server answered;
// - the preview is the server's HTML (`POST opac/pages/preview`) in an `<iframe sandbox="" srcdoc>`, never in the
//   admin's own DOM (S6);
// - an image is uploaded as `opac.page_image` and inserted as `![alt](/files/<id>)`;
// - the server's field errors land on their fields.

vi.mock('@/lib/upload', () => ({ uploadFile: vi.fn() }));

const t = (key: AdminKey): string => ADMIN_MESSAGES.id[key];

const PAGE = '01JZPAGE000000000000000001';
const NEWS = '01JZPAGE000000000000000002';
const CREATED = '01JZPAGE000000000000000009';
const IMAGE = '01JZFILE000000000000000007';
const HOUR = 3_600_000;

function item(o: Partial<PageListItem>): PageListItem {
  return {
    id: PAGE,
    kind: 'page',
    slug: 'jam-buka',
    status: 'published',
    publishedAt: Date.UTC(2026, 9, 1, 2, 0),
    showInNav: true,
    title: 'Jam buka',
    hasEnglish: true,
    updatedAt: Date.UTC(2026, 9, 1, 2, 0),
    version: 3,
    ...o,
  };
}

function view(o: Partial<PageView> = {}): PageView {
  return {
    id: PAGE,
    kind: 'page',
    slug: 'jam-buka',
    status: 'published',
    publishedAt: Date.UTC(2026, 9, 1, 2, 0),
    showInNav: true,
    coverFileId: null,
    sortOrder: 1,
    translations: {
      id: { title: 'Jam buka', summary: 'Jam layanan perpustakaan', bodyFormat: 'markdown', body: 'Senin sampai Jumat.', updatedAt: 1 },
      en: { title: 'Opening hours', summary: null, bodyFormat: 'markdown', body: 'Monday to Friday.', updatedAt: 1 },
    },
    archived: false,
    createdAt: 1,
    updatedAt: 1,
    version: 3,
    ...o,
  };
}

/** The non-GET requests to `path`. */
const sent = (requests: FakeRequest[], method: string, path: string): unknown[] => requests.filter((r) => r.method === method && r.path === path).map((r) => r.body);

/** The first wait of a test: it covers the lazy screen's first import, slow on a busy machine. */
const FIRST = { timeout: 10_000 };

/** The tab panel of a language of the editor. */
const panel = (name: string): HTMLElement => screen.getByRole('tabpanel', { name });

beforeEach(() => {
  vi.mocked(uploadFile).mockReset();
});

afterEach(() => {
  vi.unstubAllGlobals();
  vi.restoreAllMocks();
});

describe('the list of pages and news', () => {
  it('lists one kind; the news tab lists news (a future one is scheduled); archive asks first and sends the version', async () => {
    const later = Date.now() + HOUR;
    const { requests, router } = startApp({
      me: adminMe(),
      path: '/admin/opac/pages',
      routes: {
        'GET opac/pages': (req) =>
          req.query.get('kind') === 'news'
            ? { items: [item({ id: NEWS, kind: 'news', slug: 'lomba', title: 'Lomba menulis', publishedAt: later, showInNav: false, hasEnglish: false })], nextCursor: null }
            : { items: [item({})], nextCursor: null },
        'DELETE opac/pages/:id': (req) => ({ id: req.params['id'], version: 4 }),
      },
    });
    const link = await screen.findByRole('link', { name: 'Jam buka' }, FIRST);
    expect(link.getAttribute('href')).toBe(`/admin/opac/pages/${PAGE}`);
    const row = link.closest('tr')!;
    expect(within(row).getByText('/halaman/jam-buka')).toBeTruthy();
    expect(within(row).getByText('Terbit')).toBeTruthy();
    expect(requests.find((r) => r.path === 'opac/pages')?.query.get('kind')).toBe('page');
    expect(screen.getByRole('link', { name: t('pages.add.page') }).getAttribute('href')).toBe('/admin/opac/pages/new');

    fireEvent.mouseDown(screen.getByRole('tab', { name: 'Berita' }), { button: 0 });
    const news = await screen.findByRole('link', { name: 'Lomba menulis' });
    expect(router.state.location.search).toEqual({ kind: 'news' });
    expect(within(news.closest('tr')!).getByText(t('pages.scheduled'))).toBeTruthy();
    expect(within(news.closest('tr')!).getByText('/berita/lomba')).toBeTruthy();
    expect(screen.getByRole('link', { name: t('pages.add.news') }).getAttribute('href')).toBe('/admin/opac/pages/new?kind=news');

    fireEvent.click(screen.getByRole('button', { name: 'Arsipkan Lomba menulis' }));
    const dialog = await screen.findByRole('alertdialog');
    fireEvent.click(within(dialog).getByRole('button', { name: t('pages.action.archive') }));
    await screen.findByText('“Lomba menulis” diarsipkan.');
    expect(sent(requests, 'DELETE', `opac/pages/${NEWS}`)).toEqual([{ version: 3 }]);
  });

  it('pages through the list with the server’s cursor', async () => {
    const { requests } = startApp({
      me: adminMe(),
      path: '/admin/opac/pages',
      routes: {
        'GET opac/pages': (req) =>
          req.query.get('cursor') === PAGE
            ? { items: [item({ id: NEWS, slug: 'tata-tertib', title: 'Tata tertib' })], nextCursor: null }
            : { items: [item({})], nextCursor: PAGE },
      },
    });
    await screen.findByRole('link', { name: 'Jam buka' }, FIRST);
    fireEvent.click(screen.getByRole('button', { name: ADMIN_MESSAGES.id['table.next'] }));
    await screen.findByRole('link', { name: 'Tata tertib' });
    expect(screen.getByText('Lembar 2')).toBeTruthy();
    fireEvent.click(screen.getByRole('button', { name: ADMIN_MESSAGES.id['table.prev'] }));
    await screen.findByRole('link', { name: 'Jam buka' });
    expect(requests.filter((r) => r.path === 'opac/pages').map((r) => r.query.get('cursor'))).toContain(PAGE);
  });

  it('without opac.pages.manage the screen says so and asks the server nothing', async () => {
    const { requests } = startApp({ me: signedIn({ permissions: ['catalog.records.read'] }), path: '/admin/opac/pages', routes: {} });
    expect(await screen.findByText(MESSAGES.id['error.AUTHZ_DENIED'], undefined, FIRST)).toBeTruthy();
    expect(requests.filter((r) => r.path.startsWith('opac/pages'))).toEqual([]);
  });
});

describe('the page editor', () => {
  it('a new news post: posts the expected body ({id, version} answered) and opens the post it created', async () => {
    const { requests, router } = startApp({
      me: adminMe(),
      path: '/admin/opac/pages/new?kind=news',
      routes: {
        'POST opac/pages': () => json({ id: CREATED, version: 0 }, 201),
        'GET opac/pages/:id': () => view({ id: CREATED, kind: 'news', slug: 'lomba-menulis-cerpen-2026', version: 0 }),
      },
    });
    expect(await screen.findByRole('heading', { name: t('pages.new.news') }, FIRST)).toBeTruthy();
    const id = panel('Bahasa Indonesia');
    fireEvent.change(within(id).getByLabelText(t('pages.field.title')), { target: { value: 'Lomba Menulis Cerpen 2026' } });
    // The address follows the title until it is typed.
    expect((screen.getByLabelText(t('pages.field.slug')) as HTMLInputElement).value).toBe('lomba-menulis-cerpen-2026');
    fireEvent.change(within(id).getByLabelText(t('pages.field.summary')), { target: { value: 'Untuk pelajar SMA' } });
    fireEvent.change(within(id).getByLabelText(t('pages.field.body')), { target: { value: '## Syarat\n\nTerbuka untuk pelajar.' } });
    fireEvent.change(screen.getByLabelText(t('pages.field.status')), { target: { value: 'published' } });
    fireEvent.change(screen.getByLabelText(t('pages.field.published_at')), { target: { value: '2026-11-02T08:00' } });
    fireEvent.click(screen.getByLabelText(t('pages.field.show_in_nav')));
    fireEvent.click(screen.getByRole('button', { name: ADMIN_MESSAGES.id['form.save'] }));

    await waitFor(() => expect(router.state.location.pathname).toBe(`/admin/opac/pages/${CREATED}`));
    expect(sent(requests, 'POST', 'opac/pages')).toEqual([
      {
        kind: 'news',
        slug: 'lomba-menulis-cerpen-2026',
        status: 'published',
        publishedAt: fromLocalInput('2026-11-02T08:00'),
        showInNav: true,
        sortOrder: 0,
        translations: { id: { title: 'Lomba Menulis Cerpen 2026', summary: 'Untuk pelajar SMA', bodyFormat: 'markdown', body: '## Syarat\n\nTerbuka untuk pelajar.' } },
      },
    ]);
    // The editor reads the post it made (S15: the answer carries only {id, version}).
    expect(await screen.findByRole('heading', { name: 'Jam buka' })).toBeTruthy();
    expect(requests.some((r) => r.method === 'GET' && r.path === `opac/pages/${CREATED}`)).toBe(true);
  });

  it('the preview is the server’s HTML in an iframe whose sandbox is empty (S6)', async () => {
    const html = '<h2>Syarat</h2><p>Terbuka <strong>untuk</strong> pelajar.</p>';
    const { requests } = startApp({ me: adminMe(), path: '/admin/opac/pages/new', routes: { 'POST opac/pages/preview': () => ({ html }) } });
    const id = await waitFor(() => panel('Bahasa Indonesia'), FIRST);
    fireEvent.change(within(id).getByLabelText(t('pages.field.body')), { target: { value: '## Syarat\n\nTerbuka **untuk** pelajar.' } });
    fireEvent.click(within(id).getByRole('button', { name: t('pages.preview.button') }));
    const frame = await screen.findByTitle(t('pages.preview.title'));
    expect(frame.tagName).toBe('IFRAME');
    expect(frame.getAttribute('sandbox')).toBe('');
    expect(frame.getAttribute('srcdoc')).toBe(html);
    expect(sent(requests, 'POST', 'opac/pages/preview')).toEqual([{ bodyFormat: 'markdown', body: '## Syarat\n\nTerbuka **untuk** pelajar.' }]);
    // Never in the admin's own DOM.
    expect(document.querySelector('strong')).toBeNull();
    expect(screen.queryByRole('heading', { name: 'Syarat' })).toBeNull();
  });

  it('an image is uploaded as opac.page_image and inserted as ![alt](/files/<id>); the alt text is required', async () => {
    vi.mocked(uploadFile).mockResolvedValue({ uploadId: IMAGE });
    startApp({ me: adminMe(), path: '/admin/opac/pages/new', routes: {} });
    const id = await waitFor(() => panel('Bahasa Indonesia'), FIRST);
    const body = within(id).getByLabelText(t('pages.field.body')) as HTMLTextAreaElement;
    fireEvent.change(body, { target: { value: 'Gedung baru kami:' } });
    const file = new File([new Uint8Array([0x47, 0x49, 0x46, 0x38])], 'gedung.gif', { type: 'image/gif' });
    fireEvent.change(within(id).getByLabelText(t('pages.image.file')), { target: { files: [file] } });
    fireEvent.click(within(id).getByRole('button', { name: t('pages.image.insert') }));
    expect(await within(id).findByText(t('pages.image.alt_required'))).toBeTruthy();
    expect(uploadFile).not.toHaveBeenCalled();

    fireEvent.change(within(id).getByLabelText(t('pages.image.alt')), { target: { value: 'Gedung [baru]' } });
    fireEvent.click(within(id).getByRole('button', { name: t('pages.image.insert') }));
    await within(id).findByText(t('pages.image.inserted'));
    expect(vi.mocked(uploadFile).mock.calls[0]?.[0]).toBe(file);
    expect(vi.mocked(uploadFile).mock.calls[0]?.[1]).toMatchObject({ context: 'opac.page_image' });
    expect(body.value).toBe(`Gedung baru kami:\n\n![Gedung \\[baru\\]](/files/${IMAGE})\n`);
  });

  it('an edit sends only what changed with the version, removes English, then saves with the version answered', async () => {
    let version = 3;
    const { requests } = startApp({
      me: adminMe(),
      path: `/admin/opac/pages/${PAGE}`,
      routes: {
        'GET opac/pages/:id': () => view({ version }),
        'PATCH opac/pages/:id': (req) => {
          version += 1;
          return { id: req.params['id'], version };
        },
      },
    });
    expect(await screen.findByRole('heading', { name: 'Jam buka' }, FIRST)).toBeTruthy();
    expect((screen.getByLabelText(t('pages.field.slug')) as HTMLInputElement).value).toBe('jam-buka');
    expect(screen.getByRole('link', { name: t('pages.action.view') }).getAttribute('href')).toBe('/halaman/jam-buka');
    fireEvent.change(within(panel('Bahasa Indonesia')).getByLabelText(t('pages.field.title')), { target: { value: 'Jam layanan' } });
    fireEvent.mouseDown(screen.getByRole('tab', { name: 'Bahasa Inggris' }), { button: 0 });
    const en = panel('Bahasa Inggris');
    expect((within(en).getByLabelText(t('pages.field.title')) as HTMLInputElement).value).toBe('Opening hours');
    fireEvent.click(within(en).getByLabelText(t('pages.english.include')));
    fireEvent.click(screen.getByRole('button', { name: ADMIN_MESSAGES.id['form.save'] }));
    await screen.findByText(t('pages.saved'));
    expect(sent(requests, 'PATCH', `opac/pages/${PAGE}`)).toEqual([
      { version: 3, translations: { id: { title: 'Jam layanan', summary: 'Jam layanan perpustakaan', bodyFormat: 'markdown', body: 'Senin sampai Jumat.' }, en: null } },
    ]);

    // Nothing changed: nothing sent. Then the order: with the version the first save answered.
    fireEvent.click(await screen.findByRole('button', { name: ADMIN_MESSAGES.id['form.save'] }));
    fireEvent.change(screen.getByLabelText(t('pages.field.sort_order')), { target: { value: '5' } });
    fireEvent.click(await screen.findByRole('button', { name: ADMIN_MESSAGES.id['form.save'] }));
    await waitFor(() => expect(sent(requests, 'PATCH', `opac/pages/${PAGE}`)).toHaveLength(2));
    expect(sent(requests, 'PATCH', `opac/pages/${PAGE}`)[1]).toEqual({ version: 4, sortOrder: 5 });
  });

  it('the server’s field errors land on their fields: a taken address, an English body too big (its tab opens)', async () => {
    let answer = problem(422, 'VALIDATION_FAILED', { errors: [{ path: 'slug', code: 'taken' }] });
    startApp({ me: adminMe(), path: '/admin/opac/pages/new', routes: { 'POST opac/pages': () => answer } });
    const id = await waitFor(() => panel('Bahasa Indonesia'), FIRST);
    fireEvent.change(within(id).getByLabelText(t('pages.field.title')), { target: { value: 'Profil' } });
    fireEvent.change(within(id).getByLabelText(t('pages.field.body')), { target: { value: 'Isi.' } });
    fireEvent.click(screen.getByRole('button', { name: ADMIN_MESSAGES.id['form.save'] }));
    const slug = screen.getByLabelText(t('pages.field.slug'));
    await waitFor(() => expect(slug.getAttribute('aria-invalid')).toBe('true'));
    expect(screen.getByText(ADMIN_MESSAGES.id['form.error.taken'])).toBeTruthy();

    answer = problem(422, 'VALIDATION_FAILED', { errors: [{ path: 'translations.en.body', code: 'too_big' }] });
    fireEvent.mouseDown(screen.getByRole('tab', { name: 'Bahasa Inggris' }), { button: 0 });
    fireEvent.click(within(panel('Bahasa Inggris')).getByLabelText(t('pages.english.include')));
    fireEvent.change(within(panel('Bahasa Inggris')).getByLabelText(t('pages.field.title')), { target: { value: 'Profile' } });
    fireEvent.change(within(panel('Bahasa Inggris')).getByLabelText(t('pages.field.body')), { target: { value: 'Body.' } });
    fireEvent.change(screen.getByLabelText(t('pages.field.slug')), { target: { value: 'profil-baru' } });
    fireEvent.mouseDown(screen.getByRole('tab', { name: 'Bahasa Indonesia' }), { button: 0 });
    fireEvent.click(screen.getByRole('button', { name: ADMIN_MESSAGES.id['form.save'] }));
    const enBody = await waitFor(() => within(panel('Bahasa Inggris')).getByLabelText(t('pages.field.body')));
    await waitFor(() => expect(enBody.getAttribute('aria-invalid')).toBe('true'));
    expect(within(panel('Bahasa Inggris')).getByText(ADMIN_MESSAGES.id['form.error.too_big'])).toBeTruthy();
  });
});
