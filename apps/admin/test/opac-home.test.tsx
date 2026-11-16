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
        'GET opac/home': () => (saved ? { ...view({ title: { id: 'Ruang baca', en: null } }), revision: 'fedcba9876543210' } : view()),
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

    const heading = screen.getByLabelText(t('opacHome.text.heading_id')) as HTMLInputElement;
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
    const weekdays = screen.getByRole('group', { name: t('opacHome.hours.weekdays', { n: 1 }) });
    for (const day of [5, 1, 3, 2, 4] as const) fireEvent.click(within(weekdays).getByLabelText(t(`opacHome.hours.weekday.${day}` as AdminKey)));
    fireEvent.change(screen.getByLabelText(t('opacHome.about.founded')), { target: { value: '1987' } });
    fireEvent.click(screen.getByRole('button', { name: t('opacHome.save') }));
    await screen.findByText(t('opacHome.saved'));
    expect(puts(requests)).toEqual([
      {
        revision: '0123456789abcdef',
        home: {
          ...OPAC_HOME_DEFAULT,
          title: { id: 'Ruang baca', en: null },
          about: { ...OPAC_HOME_DEFAULT.about, founded: 1987 },
          services: [{ title: 'Peminjaman', text: null }],
          hours: [{ days: 'Senin–Jumat', time: '07.00–15.00', weekdays: [1, 2, 3, 4, 5] }],
          blocks: { ...OPAC_HOME_DEFAULT.blocks, promoted: false },
        },
        welcome: { id: 'Selamat datang.', en: null },
      },
    ]);
    // The editor starts again from what the server holds now; the bar says it was saved and its button has the focus.
    await waitFor(() => expect((screen.getByLabelText(t('opacHome.text.heading_id')) as HTMLInputElement).value).toBe('Ruang baca'));
    expect(screen.queryByText(t('opacHome.dirty'))).toBeNull();
    expect(within(saveBar()).getByText(t('opacHome.saved'))).toBeTruthy();
    expect(document.activeElement).toBe(screen.getByRole('button', { name: t('opacHome.save') }));
  });

  it('checks the draft before sending: a photo needs its alternative text, a year must be a number', async () => {
    const { requests } = startApp({
      me: adminMe(),
      path: '/admin/opac/beranda',
      routes: { 'GET opac/home': () => view({ hero: { fileId: PHOTO, alt: 'Gedung', position: 50, overlay: 60 } }) },
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

  it('the preview has the hero band\'s proportions, not the photo\'s 16:9: on a wide screen "Posisi foto" moves the photo, on a phone its sides are cut', async () => {
    startApp({ me: adminMe(), path: '/admin/opac/beranda', routes: { 'GET opac/home': () => view({ hero: { fileId: PHOTO, alt: 'Gedung', position: 50, overlay: 60 } }) } });
    const wide = await screen.findByRole('figure', { name: t('opacHome.preview.wide') }, FIRST);
    const phone = screen.getByRole('figure', { name: t('opacHome.preview.phone') });
    const photo = (frame: HTMLElement): HTMLImageElement => frame.querySelector('img')!;
    const ratio = (frame: HTMLElement): number => {
      const [w, h] = photo(frame).parentElement!.style.aspectRatio.split('/').map(Number) as [number, number];
      return w / h;
    };
    // Wider than the photo: its top and bottom are cut, so the position decides what shows; narrower: its sides.
    expect(ratio(wide)).toBeGreaterThan((16 / 9) * 1.5);
    expect(ratio(phone)).toBeLessThan(1);
    expect(photo(wide).style.objectPosition).toBe('50% 50%');
    fireEvent.change(screen.getByLabelText(t('opacHome.hero.position')), { target: { value: '20' } });
    expect(photo(wide).style.objectPosition).toBe('50% 20%');
    expect(photo(phone).style.objectPosition).toBe('50% 20%');
    expect(within(wide).getByText('Perpustakaan SMA 1')).toBeTruthy();
  });

  it('the overlay slider darkens the preview from its floor, the library colour fills a band without a photo, and both are saved', async () => {
    const { requests } = startApp({
      me: adminMe(),
      path: '/admin/opac/beranda',
      routes: {
        'GET opac/home': () => view({ hero: { fileId: PHOTO, alt: 'Gedung', position: 50, overlay: 60 } }),
        'PUT opac/home': () => ({ revision: 'fedcba9876543210', changed: ['opac.home'] }),
      },
    });
    const wide = await screen.findByRole('figure', { name: t('opacHome.preview.wide') }, FIRST);
    const overlay = (): HTMLElement => wide.querySelector<HTMLElement>('[data-overlay]')!;
    expect(overlay().style.backgroundColor).toBe('rgba(8, 12, 20, 0.6)');
    const slider = screen.getByLabelText(t('opacHome.hero.overlay')) as HTMLInputElement;
    expect([slider.min, slider.max, slider.step, slider.value]).toEqual(['60', '80', '5', '60']);
    fireEvent.change(slider, { target: { value: '75' } });
    expect(overlay().style.backgroundColor).toBe('rgba(8, 12, 20, 0.75)');

    // Too light a colour is refused before sending, with its own message; a dark one is taken (and stored lower case).
    const brand = screen.getByLabelText(t('opacHome.brand.label')) as HTMLInputElement;
    fireEvent.change(brand, { target: { value: '#ffd966' } });
    fireEvent.click(screen.getByRole('button', { name: t('opacHome.save') }));
    expect(await screen.findByText(t('opacHome.brand.low_contrast'))).toBeTruthy();
    expect(brand.getAttribute('aria-invalid')).toBe('true');
    expect(puts(requests)).toEqual([]);
    fireEvent.change(brand, { target: { value: '#1E3A8A' } });
    // The refusal was about the old value: it goes, and the hint gives the new colour's contrast.
    expect(screen.queryByText(t('opacHome.brand.low_contrast'))).toBeNull();
    expect(brand.getAttribute('aria-invalid')).toBeNull();
    expect(screen.getByText(t('opacHome.brand.contrast_ok', { ratio: '10,3', min: '4,5' }))).toBeTruthy();
    fireEvent.click(screen.getByRole('button', { name: t('opacHome.photo.remove') }));
    // Without the photo, the preview's band is the library colour.
    expect((wide.firstElementChild as HTMLElement).style.backgroundColor).toBe('rgb(30, 58, 138)');
    fireEvent.click(screen.getByRole('button', { name: t('opacHome.save') }));
    await screen.findByText(t('opacHome.saved'));
    expect(puts(requests)).toEqual([
      expect.objectContaining({ home: expect.objectContaining({ hero: null, brand: '#1e3a8a' }) }),
    ]);
  });

  it('the heading and paragraph per language; the preview shows the other language when one is blank', async () => {
    const { requests } = startApp({
      me: adminMe(),
      path: '/admin/opac/beranda',
      routes: { 'GET opac/home': () => view({ title: { id: 'Ruang baca', en: null } }), 'PUT opac/home': () => ({ revision: 'fedcba9876543210', changed: ['opac.home'] }) },
    });
    const preview = await screen.findByRole('complementary', { name: t('opacHome.preview.title') }, FIRST);
    fireEvent.click(within(preview).getByRole('button', { name: t('opacHome.preview.lang_en') }));
    // No English heading or lead: the Indonesian ones show.
    expect(within(preview).getAllByText('Ruang baca').length).toBeGreaterThan(0);
    expect(within(preview).getByText('Selamat datang.')).toBeTruthy();
    fireEvent.change(screen.getByLabelText(t('opacHome.text.heading_en')), { target: { value: 'A reading room' } });
    fireEvent.change(screen.getByLabelText(t('opacHome.about.text_en')), { target: { value: 'Founded in 1987.' } });
    expect(within(preview).getByText('A reading room')).toBeTruthy();
    fireEvent.click(screen.getByRole('button', { name: t('opacHome.save') }));
    await screen.findByText(t('opacHome.saved'));
    expect(puts(requests)).toEqual([
      expect.objectContaining({
        home: expect.objectContaining({ title: { id: 'Ruang baca', en: 'A reading room' }, about: expect.objectContaining({ text: { id: null, en: 'Founded in 1987.' } }) }),
      }),
    ]);
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
    const heading = (await screen.findByLabelText(t('opacHome.text.heading_id'), undefined, FIRST)) as HTMLInputElement;
    fireEvent.change(heading, { target: { value: 'Judul saya' } });
    fireEvent.click(screen.getByRole('button', { name: t('opacHome.save') }));
    expect(await within(saveBar()).findByText(t('opacHome.conflict'))).toBeTruthy();
    expect(within(saveBar()).getByRole('button', { name: t('opacHome.reload') })).toBeTruthy();
    expect(heading.value).toBe('Judul saya');
  });

  it('"Pakai foto ini" in the crop dialog uploads the photo, drawn in its frame as soon as the dialog opens, into the draft and does not save the page', async () => {
    vi.stubGlobal('createImageBitmap', vi.fn(async () => ({ width: 1600, height: 900, close: vi.fn() })));
    // Only the crop fills its frame (the decoding draws the bitmap alone).
    const fillRect = vi.fn();
    vi.spyOn(HTMLCanvasElement.prototype, 'getContext').mockImplementation((() => ({ drawImage: vi.fn(), fillRect })) as unknown as HTMLCanvasElement['getContext']);
    vi.spyOn(HTMLCanvasElement.prototype, 'toBlob').mockImplementation((done: BlobCallback) => done(new Blob(['x'], { type: 'image/jpeg' })));
    vi.mocked(uploadFile).mockResolvedValue({ uploadId: PHOTO } as never);
    const { requests } = startApp({
      me: adminMe(),
      path: '/admin/opac/beranda',
      routes: { 'GET opac/home': () => view(), 'PUT opac/home': () => ({ revision: 'fedcba9876543210', changed: ['opac.home'] }) },
    });
    const [hero] = await screen.findAllByLabelText(t('opacHome.photo.upload'), undefined, FIRST);
    fireEvent.change(hero!, { target: { files: [new File([new Uint8Array(10)], 'gedung.jpg', { type: 'image/jpeg' })] } });
    const use = await screen.findByRole('button', { name: t('opacHome.crop.use') });
    // The dialog's content mounts in a portal: the crop is drawn once its canvas is there, before any slider moves.
    await waitFor(() => expect(fillRect).toHaveBeenCalledWith(0, 0, 1600, 900));
    fireEvent.click(use);
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
    await screen.findByLabelText(t('opacHome.text.heading_id'), undefined, FIRST);
    await act(() => router.navigate({ to: '/admin/about' }));
    await waitFor(() => expect(screen.queryByLabelText(t('opacHome.text.heading_id'))).toBeNull());
    // Saved meanwhile under Pengaturan › OPAC (the welcome text is part of this screen's revision), while the admin is
    // on another screen for a moment.
    current = { ...view(), welcome: { id: 'Halo dari pengaturan.', en: null }, accent: 'red', revision: 'aaaaaaaaaaaaaaaa' };
    await new Promise((r) => setTimeout(r, 50));
    await act(() => router.navigate({ to: '/admin/opac/beranda' }));
    expect(await screen.findByDisplayValue('Halo dari pengaturan.')).toBeTruthy();
    fireEvent.change(screen.getByLabelText(t('opacHome.text.heading_id')), { target: { value: 'Ruang baca' } });
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
