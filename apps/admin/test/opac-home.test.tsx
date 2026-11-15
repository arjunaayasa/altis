import { OPAC_HOME_DEFAULT, type OpacHomeView } from '@altis/shared/api/opac-home';
import { act, fireEvent, screen, waitFor, within } from '@testing-library/react';
import { afterEach, describe, expect, it, vi } from 'vitest';
import { ADMIN_MESSAGES, type AdminKey } from '@/i18n';
import { uploadFile } from '@/lib/upload';
import { adminMe, problem, signedIn, startApp, type FakeRequest } from './fake-api';

// OPAC › Halaman awal through the real router and API client against a fake `/api/v1`: the loaded content in the form,
// the hero preview following the unsaved draft, the unsaved mark and "Batalkan perubahan", the PUT body (the whole
// content with the revision it was loaded at, blanks as null), the field errors checked before sending, the 409 of a
// save another admin made first, the crop dialog's "Pakai foto ini" (which sends no save of the page and puts the photo
// in the draft), and the screen without the permission.

vi.mock('@/lib/upload', () => ({ uploadFile: vi.fn() }));

const t = (key: AdminKey, params: Record<string, string | number> = {}): string =>
  Object.entries(params).reduce((text, [k, v]) => text.replace(`{${k}}`, String(v)), ADMIN_MESSAGES.id[key]);

const PHOTO = '01JZFILE000000000000000007';
const FIRST = { timeout: 10_000 };

function view(o: Partial<OpacHomeView['home']> = {}): OpacHomeView {
  return {
    home: { ...OPAC_HOME_DEFAULT, services: [{ title: 'Peminjaman', text: null }], ...o },
    welcome: { id: 'Selamat datang.', en: null },
    revision: '0123456789abcdef',
    libraryName: 'Perpustakaan SMA 1',
    accent: 'blue',
  };
}

const puts = (requests: FakeRequest[]): unknown[] => requests.filter((r) => r.method === 'PUT' && r.path === 'opac/home').map((r) => r.body);
/** The save bar at the foot of the form (it stays in sight): the outcome of a save is said there. */
const saveBar = (): HTMLElement => screen.getByRole('button', { name: t('opacHome.save') }).parentElement!;

afterEach(() => {
  vi.restoreAllMocks();
  vi.unstubAllGlobals();
});

describe('OPAC › Halaman awal', () => {
  it('loads the content, previews the unsaved heading, marks and discards changes, and saves the whole content at its revision', async () => {
    let saved = false;
    const { requests } = startApp({
      me: adminMe(),
      path: '/admin/opac/beranda',
      routes: {
        'GET opac/home': () => (saved ? { ...view({ title: 'Ruang baca' }), revision: 'fedcba9876543210' } : view()),
        'PUT opac/home': () => {
          saved = true;
          return { revision: 'fedcba9876543210', changed: ['opac.home'] };
        },
      },
    });
    await screen.findByRole('heading', { name: t('opacHome.title') }, FIRST);
    const preview = await screen.findByRole('complementary', { name: t('opacHome.preview.title') }, FIRST);
    expect(within(preview).getByText('Perpustakaan SMA 1')).toBeTruthy();
    expect(within(preview).getByText('Selamat datang.')).toBeTruthy();
    expect(screen.getByRole('link', { name: t('opacHome.view_site') }).getAttribute('href')).toBe('/');
    expect((screen.getByLabelText(t('opacHome.services.name', { n: 1 })) as HTMLInputElement).value).toBe('Peminjaman');
    expect(screen.queryByText(t('opacHome.dirty'))).toBeNull();

    const heading = screen.getByLabelText(t('opacHome.text.heading')) as HTMLInputElement;
    fireEvent.change(heading, { target: { value: 'Ruang baca' } });
    expect(within(preview).getByText('Ruang baca')).toBeTruthy();
    expect(screen.getByText(t('opacHome.dirty'))).toBeTruthy();
    fireEvent.click(screen.getByRole('button', { name: t('opacHome.discard') }));
    expect(heading.value).toBe('');
    expect(screen.queryByText(t('opacHome.dirty'))).toBeNull();

    fireEvent.change(heading, { target: { value: 'Ruang baca' } });
    fireEvent.click(screen.getByLabelText(t('opacHome.blocks.promoted')));
    fireEvent.click(screen.getByRole('button', { name: t('opacHome.hours.add') }));
    fireEvent.change(screen.getByLabelText(t('opacHome.hours.days', { n: 1 })), { target: { value: 'Senin–Jumat' } });
    fireEvent.change(screen.getByLabelText(t('opacHome.hours.time', { n: 1 })), { target: { value: '07.00–15.00' } });
    fireEvent.change(screen.getByLabelText(t('opacHome.about.founded')), { target: { value: '1987' } });
    fireEvent.click(screen.getByRole('button', { name: t('opacHome.save') }));
    await screen.findByText(t('opacHome.saved'));
    expect(puts(requests)).toEqual([
      {
        revision: '0123456789abcdef',
        home: {
          ...OPAC_HOME_DEFAULT,
          title: 'Ruang baca',
          about: { ...OPAC_HOME_DEFAULT.about, founded: 1987 },
          services: [{ title: 'Peminjaman', text: null }],
          hours: [{ days: 'Senin–Jumat', time: '07.00–15.00' }],
          blocks: { ...OPAC_HOME_DEFAULT.blocks, promoted: false },
        },
        welcome: { id: 'Selamat datang.', en: null },
      },
    ]);
    // The editor starts again from what the server holds now; the bar says it was saved and its button has the focus.
    await waitFor(() => expect((screen.getByLabelText(t('opacHome.text.heading')) as HTMLInputElement).value).toBe('Ruang baca'));
    expect(screen.queryByText(t('opacHome.dirty'))).toBeNull();
    expect(within(saveBar()).getByText(t('opacHome.saved'))).toBeTruthy();
    expect(document.activeElement).toBe(screen.getByRole('button', { name: t('opacHome.save') }));
  });

  it('checks the draft before sending: a photo needs its alternative text, a year must be a number', async () => {
    const { requests } = startApp({
      me: adminMe(),
      path: '/admin/opac/beranda',
      routes: { 'GET opac/home': () => view({ hero: { fileId: PHOTO, alt: 'Gedung', position: 50 } }) },
    });
    const alt = (await screen.findByLabelText(t('opacHome.photo.alt'), undefined, FIRST)) as HTMLInputElement;
    fireEvent.change(alt, { target: { value: '   ' } });
    fireEvent.change(screen.getByLabelText(t('opacHome.about.founded')), { target: { value: 'dulu' } });
    fireEvent.click(screen.getByRole('button', { name: t('opacHome.save') }));
    expect(await within(saveBar()).findByText(t('opacHome.fix_fields'))).toBeTruthy();
    expect(alt.getAttribute('aria-invalid')).toBe('true');
    expect(screen.getByLabelText(t('opacHome.about.founded')).getAttribute('aria-invalid')).toBe('true');
    // The first refused field takes the focus (and so comes into sight).
    await waitFor(() => expect(document.activeElement).toBe(alt));
    expect(puts(requests)).toEqual([]);
  });

  it("a save another admin made first: the 409 says so and offers to reload, keeping the draft until then", async () => {
    startApp({
      me: adminMe(),
      path: '/admin/opac/beranda',
      routes: {
        'GET opac/home': () => view(),
        'PUT opac/home': () => problem(409, 'CONFLICT_STALE'),
      },
    });
    const heading = (await screen.findByLabelText(t('opacHome.text.heading'), undefined, FIRST)) as HTMLInputElement;
    fireEvent.change(heading, { target: { value: 'Judul saya' } });
    fireEvent.click(screen.getByRole('button', { name: t('opacHome.save') }));
    expect(await within(saveBar()).findByText(t('opacHome.conflict'))).toBeTruthy();
    expect(within(saveBar()).getByRole('button', { name: t('opacHome.reload') })).toBeTruthy();
    expect(heading.value).toBe('Judul saya');
  });

  it('"Pakai foto ini" in the crop dialog uploads the photo into the draft and does not save the page', async () => {
    vi.stubGlobal('createImageBitmap', vi.fn(async () => ({ width: 1600, height: 900, close: vi.fn() })));
    vi.spyOn(HTMLCanvasElement.prototype, 'getContext').mockImplementation((() => ({ drawImage: vi.fn(), fillRect: vi.fn() })) as unknown as HTMLCanvasElement['getContext']);
    vi.spyOn(HTMLCanvasElement.prototype, 'toBlob').mockImplementation((done: BlobCallback) => done(new Blob(['x'], { type: 'image/jpeg' })));
    vi.mocked(uploadFile).mockResolvedValue({ uploadId: PHOTO } as never);
    const { requests } = startApp({
      me: adminMe(),
      path: '/admin/opac/beranda',
      routes: { 'GET opac/home': () => view(), 'PUT opac/home': () => ({ revision: 'fedcba9876543210', changed: ['opac.home'] }) },
    });
    const [hero] = await screen.findAllByLabelText(t('opacHome.photo.upload'), undefined, FIRST);
    fireEvent.change(hero!, { target: { files: [new File([new Uint8Array(10)], 'gedung.jpg', { type: 'image/jpeg' })] } });
    fireEvent.click(await screen.findByRole('button', { name: t('opacHome.crop.use') }));
    expect(await screen.findByLabelText(t('opacHome.photo.replace'))).toBeTruthy();
    expect(vi.mocked(uploadFile)).toHaveBeenCalledTimes(1);
    expect(screen.getByText(t('opacHome.dirty'))).toBeTruthy();
    expect(puts(requests)).toEqual([]);
  });

  it('opened again after another screen, it reads the content afresh: a change saved meanwhile is shown and its revision sent', async () => {
    let current = view();
    const { router, requests } = startApp({
      me: adminMe(),
      path: '/admin/opac/beranda',
      routes: {
        'GET opac/home': () => current,
        'PUT opac/home': (r) =>
          (r.body as { revision: string }).revision === current.revision ? { revision: 'fedcba9876543210', changed: ['opac.home'] } : problem(409, 'CONFLICT_STALE'),
      },
    });
    await screen.findByLabelText(t('opacHome.text.heading'), undefined, FIRST);
    await act(() => router.navigate({ to: '/admin/about' }));
    await waitFor(() => expect(screen.queryByLabelText(t('opacHome.text.heading'))).toBeNull());
    // Saved meanwhile under Pengaturan › OPAC (the welcome text is part of this screen's revision), while the admin is
    // on another screen for a moment.
    current = { ...view(), welcome: { id: 'Halo dari pengaturan.', en: null }, accent: 'red', revision: 'aaaaaaaaaaaaaaaa' };
    await new Promise((r) => setTimeout(r, 50));
    await act(() => router.navigate({ to: '/admin/opac/beranda' }));
    expect(await screen.findByDisplayValue('Halo dari pengaturan.')).toBeTruthy();
    fireEvent.change(screen.getByLabelText(t('opacHome.text.heading')), { target: { value: 'Ruang baca' } });
    fireEvent.click(screen.getByRole('button', { name: t('opacHome.save') }));
    await screen.findByText(t('opacHome.saved'));
    expect(puts(requests).map((b) => (b as { revision: string }).revision)).toEqual(['aaaaaaaaaaaaaaaa']);
  });

  it('without opac.pages.manage the screen says so and reads nothing', async () => {
    const { requests } = startApp({ me: signedIn({ permissions: ['catalog.records.read'] }), path: '/admin/opac/beranda', routes: {} });
    expect(await screen.findByText(t('opacHome.no_permission'), undefined, FIRST)).toBeTruthy();
    expect(requests.some((r) => r.path === 'opac/home')).toBe(false);
  });
});
