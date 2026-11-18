import { SITE_IDENTITY_DEFAULT, type SiteIdentity, type SiteIdentityView } from '@altis/shared/api/site-identity';
import { fireEvent, screen, waitFor, within } from '@testing-library/react';
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import { ADMIN_MESSAGES, type AdminKey } from '@/i18n';
import { ApiError } from '@/lib/api';
import { uploadFile } from '@/lib/upload';
import { adminMe, problem, publicIdentity, signedIn, startApp, type FakeRequest } from './fake-api';

// Situs / OPAC › Identitas situs through the real router and API client against a fake `/api/v1`: the loaded identity
// in the form, the five previews following the unsaved draft, an SVG refused in the browser with the advice to export
// it as PNG, a chosen image made a PNG and uploaded to its context with the upload's id in the PUT body, the server's
// refusals said per reason, field errors, the save (after which the sidebar's brand is read again), the 409 of a save
// another admin made first, and the screen without the permission. jsdom has no canvas: decoding and encoding are
// stubbed, and the upload itself is mocked.

vi.mock('@/lib/upload', () => ({ uploadFile: vi.fn() }));

const t = (key: AdminKey, params: Record<string, string | number> = {}): string =>
  Object.entries(params).reduce((text, [k, v]) => text.replace(`{${k}}`, String(v)), ADMIN_MESSAGES.id[key]);

const LOGO = '01JZFXQ0000000000000000001';
const DARK = '01JZFXQ0000000000000000002';
const ICON = '01JZFXQ0000000000000000003';
const FRESH = '01JZFXQ0000000000000000009';
const FIRST = { timeout: 10_000 };
const PATH = '/admin/opac/identitas';

function view(identity: Partial<SiteIdentity> = {}, o: Partial<SiteIdentityView> = {}): SiteIdentityView {
  const merged = { ...SITE_IDENTITY_DEFAULT, ...identity };
  return {
    identity: merged,
    saved: true,
    revision: '0123456789abcdef',
    libraryName: 'Perpustakaan SMA 1',
    urls: {
      logo: merged.logo === null ? null : `/files/${merged.logo.fileId}`,
      logoDark: merged.logoDark === null ? null : `/files/${merged.logoDark.fileId}`,
      icon: { '32': '/site-icon/32.png', '180': '/site-icon/180.png', '192': '/site-icon/192.png' },
    },
    ...o,
  };
}

const PNG_HEAD = [0x89, 0x50, 0x4e, 0x47, 0x0d, 0x0a, 0x1a, 0x0a, 0, 0, 0, 13];
const pngFile = (name = 'logo.png'): File => new File([new Uint8Array(PNG_HEAD)], name, { type: 'image/png' });
const jpegFile = (): File => new File([new Uint8Array([0xff, 0xd8, 0xff, 0xe0, 0, 16])], 'logo.jpg', { type: 'image/jpeg' });

const puts = (requests: FakeRequest[]): unknown[] => requests.filter((r) => r.method === 'PUT' && r.path === 'site/identity').map((r) => r.body);
const preview = (name: string): HTMLElement => document.querySelector<HTMLElement>(`[data-preview=${name}]`)!;
const choose = (label: string, file: File): void => {
  fireEvent.change(screen.getByLabelText(label), { target: { files: [file] } });
};

/** The browser's decoder and canvas: an image of `width` × `height`, encoded as a PNG of `bytes`. */
function stubCanvas(width: number, height: number, bytes = 2048) {
  const decode = vi.fn(async () => ({ width, height, close: vi.fn() }));
  vi.stubGlobal('createImageBitmap', decode);
  const drawImage = vi.fn();
  const fillRect = vi.fn();
  vi.spyOn(HTMLCanvasElement.prototype, 'getContext').mockImplementation((() => ({ drawImage, fillRect })) as unknown as HTMLCanvasElement['getContext']);
  const toBlob = vi
    .spyOn(HTMLCanvasElement.prototype, 'toBlob')
    .mockImplementation((done: BlobCallback, type?: string) => done(new Blob([new Uint8Array(bytes)], { type: type ?? 'image/png' })));
  return { decode, drawImage, fillRect, toBlob };
}

beforeEach(() => {
  vi.mocked(uploadFile).mockReset();
});

afterEach(() => {
  vi.restoreAllMocks();
  vi.unstubAllGlobals();
});

describe('Situs / OPAC › Identitas situs', () => {
  it('loads the identity, previews the unsaved draft in five places, discards, and saves it all at its revision', async () => {
    let publicReads = 0;
    const { requests } = startApp({
      me: adminMe(),
      path: PATH,
      routes: {
        'GET site/identity': () => view({ logo: { fileId: LOGO, alt: 'Logo SMA 1' }, logoDark: { fileId: DARK }, icon: { fileId: ICON }, showNameBesideLogo: false }),
        'PUT site/identity': () => ({ revision: 'fedcba9876543210', changed: ['name'] }),
        'GET site/identity/public': () => {
          publicReads += 1;
          return publicIdentity('Perpustakaan SMA 1');
        },
      },
    });
    expect(await screen.findByRole('heading', { level: 1, name: t('siteIdentity.title') }, FIRST)).toBeTruthy();
    const alt = (await screen.findByLabelText(t('siteIdentity.alt.title'), undefined, FIRST)) as HTMLInputElement;
    expect(alt.value).toBe('Logo SMA 1');
    // The three images on their tiles, each named.
    expect((screen.getByAltText(t('siteIdentity.logo.preview_alt')) as HTMLImageElement).getAttribute('src')).toBe(`/files/${LOGO}`);
    expect((screen.getByAltText(t('siteIdentity.logo_dark.preview_alt')) as HTMLImageElement).getAttribute('src')).toBe(`/files/${DARK}`);
    expect((screen.getByAltText(t('siteIdentity.icon.preview_alt')) as HTMLImageElement).getAttribute('src')).toBe('/site-icon/192.png');

    // The name is blank: the library's name stands in, as the hint says.
    const name = screen.getByLabelText(t('siteIdentity.name.title')) as HTMLInputElement;
    expect(name.value).toBe('');
    expect(name.placeholder).toBe('Perpustakaan SMA 1');
    expect(screen.getByText(t('siteIdentity.name.hint', { name: 'Perpustakaan SMA 1' }))).toBeTruthy();
    expect(preview('header').querySelector('img')!.getAttribute('src')).toBe(`/files/${LOGO}`);
    expect(preview('header').textContent).not.toContain('Perpustakaan SMA 1');
    expect(preview('footer').querySelector('img')!.getAttribute('src')).toBe(`/files/${DARK}`);
    expect(preview('sidebar').querySelector('img')!.getAttribute('src')).toBe(`/files/${DARK}`);
    expect(preview('tab').textContent).toBe(t('siteIdentity.preview.tab_title', { name: 'Perpustakaan SMA 1' }));
    expect(preview('tab').querySelectorAll('img').length).toBe(2);
    // Without a logo: the name as plain text, nothing drawn in its place.
    expect(preview('no-logo').querySelector('img, svg')).toBeNull();
    expect(preview('no-logo').firstElementChild!.textContent).toBe('Perpustakaan SMA 1');
    expect(preview('no-logo').firstElementChild!.className).toContain('font-bold');

    // Nothing to save yet.
    const save = screen.getByRole('button', { name: t('siteIdentity.save') }) as HTMLButtonElement;
    expect(save.disabled).toBe(true);
    expect(screen.getByText(t('siteIdentity.clean'))).toBeTruthy();

    // The previews follow the draft.
    fireEvent.change(name, { target: { value: 'Taman Baca Kali Bening' } });
    fireEvent.change(screen.getByLabelText(t('siteIdentity.tagline.id')), { target: { value: 'Ruang baca warga' } });
    fireEvent.click(screen.getByRole('switch', { name: t('siteIdentity.show_name.label') }));
    expect(preview('header').textContent).toContain('Taman Baca Kali Bening');
    expect(preview('footer').textContent).toContain('Ruang baca warga');
    expect(preview('sidebar').textContent).toBe('Taman Baca Kali Bening');
    expect(preview('tab').textContent).toBe(t('siteIdentity.preview.tab_title', { name: 'Taman Baca Kali Bening' }));
    expect(preview('no-logo').firstElementChild!.textContent).toBe('Taman Baca Kali Bening');
    expect(screen.getByText(t('siteIdentity.dirty'))).toBeTruthy();

    // Removing the dark logo: the main logo stands on a white plate where the background is dark.
    fireEvent.click(screen.getByRole('button', { name: t('siteIdentity.logo_dark.remove') }));
    expect(screen.getByText(t('siteIdentity.logo_dark.empty'))).toBeTruthy();
    expect(preview('footer').querySelector('[data-slot=logo-plate] img')!.getAttribute('src')).toBe(`/files/${LOGO}`);
    expect(preview('sidebar').querySelector('[data-slot=logo-plate] img')!.getAttribute('src')).toBe(`/files/${LOGO}`);

    // "Buang" goes back to what was loaded.
    fireEvent.click(screen.getByRole('button', { name: t('siteIdentity.discard') }));
    expect(name.value).toBe('');
    expect(preview('footer').querySelector('img')!.getAttribute('src')).toBe(`/files/${DARK}`);
    expect(save.disabled).toBe(true);

    fireEvent.change(name, { target: { value: '  Taman Baca Kali Bening ' } });
    fireEvent.change(screen.getByLabelText(t('siteIdentity.tagline.en')), { target: { value: 'A community reading room' } });
    const before = publicReads;
    fireEvent.click(save);
    expect(await screen.findByText(t('siteIdentity.saved'))).toBeTruthy();
    expect(puts(requests)).toEqual([
      {
        revision: '0123456789abcdef',
        identity: {
          logo: { fileId: LOGO, alt: 'Logo SMA 1' },
          logoDark: { fileId: DARK },
          icon: { fileId: ICON },
          name: 'Taman Baca Kali Bening',
          tagline: { id: null, en: 'A community reading room' },
          showNameBesideLogo: false,
        },
      },
    ]);
    // The sidebar's brand is read again after the save.
    await waitFor(() => expect(publicReads).toBeGreaterThan(before));
  });

  it('an identity never saved: the logo the home page held is simply the logo, and it can be saved as it stands', async () => {
    const { requests } = startApp({
      me: adminMe(),
      path: PATH,
      routes: {
        'GET site/identity': () => view({ logo: { fileId: LOGO, alt: '' } }, { saved: false }),
        'PUT site/identity': () => ({ revision: 'fedcba9876543210', changed: [] }),
      },
    });
    const logo = (await screen.findByAltText(t('siteIdentity.logo.preview_alt'), undefined, FIRST)) as HTMLImageElement;
    expect(logo.getAttribute('src')).toBe(`/files/${LOGO}`);
    expect((screen.getByLabelText(t('siteIdentity.alt.title')) as HTMLInputElement).placeholder).toBe('Perpustakaan SMA 1');
    // No dark logo: the dark tile shows the main logo on its plate, and says so in words.
    expect(screen.getByText(t('siteIdentity.logo_dark.empty'))).toBeTruthy();
    expect(screen.getByText(t('siteIdentity.icon.empty'))).toBeTruthy();
    fireEvent.click(screen.getByRole('button', { name: t('siteIdentity.save') }));
    await screen.findByText(t('siteIdentity.saved'));
    expect(puts(requests)).toHaveLength(1);
  });

  it('an SVG is refused in the browser, by its name or by its content, with the advice to export it as PNG', async () => {
    const canvas = stubCanvas(600, 150);
    startApp({ me: adminMe(), path: PATH, routes: { 'GET site/identity': () => view() } });
    await screen.findByText(t('siteIdentity.logo.empty'), undefined, FIRST);
    choose(t('siteIdentity.logo.upload'), new File(['<svg xmlns="http://www.w3.org/2000/svg"/>'], 'logo.svg', { type: 'image/svg+xml' }));
    const refusal = await screen.findByText(t('siteIdentity.image.svg'));
    expect(refusal.closest('[role=alert]')).not.toBeNull();
    // The refusal is tied to the file field.
    const field = screen.getByLabelText(t('siteIdentity.logo.upload'));
    expect(field.getAttribute('aria-invalid')).toBe('true');
    expect(document.getElementById(field.getAttribute('aria-describedby')!.split(' ')[0]!)!.textContent).toBe(t('siteIdentity.image.svg'));

    // Markup that calls itself a PNG is told by its first bytes.
    choose(t('siteIdentity.icon.upload'), new File(['<?xml version="1.0"?>\n<svg width="512" height="512"></svg>'], 'ikon.png', { type: 'image/png' }));
    await waitFor(() => expect(screen.getAllByText(t('siteIdentity.image.svg'))).toHaveLength(2));
    // Something that is no image at all.
    choose(t('siteIdentity.logo_dark.upload'), new File(['%PDF-1.7'], 'logo.png', { type: 'image/png' }));
    expect(await screen.findByText(t('siteIdentity.image.not_image'))).toBeTruthy();

    expect(canvas.decode).not.toHaveBeenCalled();
    expect(vi.mocked(uploadFile)).not.toHaveBeenCalled();
    expect((screen.getByRole('button', { name: t('siteIdentity.save') }) as HTMLButtonElement).disabled).toBe(true);
  });

  it('a chosen image is made a PNG, uploaded to its context, and its upload goes into the saved identity', async () => {
    const canvas = stubCanvas(1920, 480);
    vi.mocked(uploadFile).mockResolvedValueOnce({ uploadId: FRESH }).mockResolvedValueOnce({ uploadId: ICON });
    const { requests } = startApp({
      me: adminMe(),
      path: PATH,
      routes: { 'GET site/identity': () => view(), 'PUT site/identity': () => ({ revision: 'fedcba9876543210', changed: ['logo', 'icon'] }) },
    });
    await screen.findByText(t('siteIdentity.logo.empty'), undefined, FIRST);
    // A JPEG becomes a PNG: scaled down to the stored box, with no backdrop under it.
    choose(t('siteIdentity.logo.upload'), jpegFile());
    expect(await screen.findByLabelText(t('siteIdentity.logo.replace'))).toBeTruthy();
    expect(canvas.drawImage).toHaveBeenLastCalledWith(expect.anything(), 0, 0, 1920, 480, 0, 0, 960, 240);
    expect(canvas.fillRect).not.toHaveBeenCalled();
    expect(canvas.toBlob).toHaveBeenLastCalledWith(expect.any(Function), 'image/png');
    const [blob, options] = vi.mocked(uploadFile).mock.calls[0]!;
    expect(blob.type).toBe('image/png');
    expect(options).toEqual({ context: 'site.logo' });
    expect(screen.getByText(t('siteIdentity.image.fresh', { name: 'logo.jpg', width: 960, height: 240, size: 2 }))).toBeTruthy();
    // Until it is saved the fresh PNG is shown from itself.
    expect(preview('header').querySelector('img')!.getAttribute('src')).toMatch(/^data:image\/png;base64,/);

    // The icon: the centre square, at most 512 px a side.
    choose(t('siteIdentity.icon.upload'), pngFile('ikon.png'));
    expect(await screen.findByLabelText(t('siteIdentity.icon.replace'))).toBeTruthy();
    expect(canvas.drawImage).toHaveBeenLastCalledWith(expect.anything(), 720, 0, 480, 480, 0, 0, 480, 480);
    expect(vi.mocked(uploadFile).mock.calls[1]![1]).toEqual({ context: 'site.icon' });

    fireEvent.change(screen.getByLabelText(t('siteIdentity.alt.title')), { target: { value: 'Logo Taman Baca' } });
    fireEvent.click(screen.getByRole('button', { name: t('siteIdentity.save') }));
    await screen.findByText(t('siteIdentity.saved'));
    expect(puts(requests)).toEqual([
      {
        revision: '0123456789abcdef',
        identity: { ...SITE_IDENTITY_DEFAULT, logo: { fileId: FRESH, alt: 'Logo Taman Baca' }, icon: { fileId: ICON } },
      },
    ]);
  });

  it('an icon below 256 px a side is refused before it is sent; a PNG that stays above 1 MB is given up', async () => {
    stubCanvas(200, 300);
    startApp({ me: adminMe(), path: PATH, routes: { 'GET site/identity': () => view() } });
    await screen.findByText(t('siteIdentity.icon.empty'), undefined, FIRST);
    choose(t('siteIdentity.icon.upload'), pngFile());
    expect(await screen.findByText(t('siteIdentity.image.too_small', { min: 256 }))).toBeTruthy();
    vi.restoreAllMocks();
    const big = stubCanvas(900, 200, 1024 * 1024 + 1);
    choose(t('siteIdentity.logo.upload'), pngFile());
    expect(await screen.findByText(t('siteIdentity.image.too_large'))).toBeTruthy();
    // Drawn again smaller before it is given up.
    expect(big.toBlob).toHaveBeenCalledTimes(3);
    expect(vi.mocked(uploadFile)).not.toHaveBeenCalled();
  });

  it("the server's refusals are said per reason, under the image they are about", async () => {
    stubCanvas(600, 150);
    startApp({ me: adminMe(), path: PATH, routes: { 'GET site/identity': () => view() } });
    await screen.findByText(t('siteIdentity.logo.empty'), undefined, FIRST);
    const cases: [ApiError, string][] = [
      [new ApiError(415, 'UPLOAD_TYPE_REFUSED', { reason: 'damaged' }), t('siteIdentity.image.damaged')],
      [new ApiError(415, 'UPLOAD_TYPE_REFUSED', { reason: 'interlaced' }), t('siteIdentity.image.interlaced')],
      [new ApiError(415, 'UPLOAD_TYPE_REFUSED', { reason: 'dimensions' }), t('siteIdentity.image.dimensions', { max: 4000 })],
      [new ApiError(415, 'UPLOAD_TYPE_REFUSED', { reason: 'too_small' }), t('siteIdentity.image.too_small', { min: 16 })],
      [new ApiError(415, 'UPLOAD_TYPE_REFUSED'), t('siteIdentity.image.type_refused')],
      [new ApiError(413, 'UPLOAD_TOO_LARGE'), t('siteIdentity.image.too_large')],
      [new ApiError(500, 'INTERNAL'), t('siteIdentity.image.upload_failed')],
    ];
    for (const [error, text] of cases) {
      vi.mocked(uploadFile).mockRejectedValueOnce(error);
      choose(t('siteIdentity.logo.upload'), pngFile());
      const said = await screen.findByText(text);
      expect(said.closest('[role=alert]')).not.toBeNull();
    }
    expect(vi.mocked(uploadFile)).toHaveBeenCalledTimes(cases.length);
    // Nothing went into the draft.
    expect(screen.getByText(t('siteIdentity.logo.empty'))).toBeTruthy();
    expect(screen.getByText(t('siteIdentity.clean'))).toBeTruthy();
  });

  it("the server's field errors land on their fields, and the first one takes the focus", async () => {
    startApp({
      me: adminMe(),
      path: PATH,
      routes: {
        'GET site/identity': () => view(),
        'PUT site/identity': () => problem(422, 'VALIDATION_FAILED', { errors: [{ path: 'identity.name', code: 'too_big' }] }),
      },
    });
    const name = (await screen.findByLabelText(t('siteIdentity.name.title'), undefined, FIRST)) as HTMLInputElement;
    fireEvent.change(name, { target: { value: 'Taman Baca' } });
    fireEvent.click(screen.getByRole('button', { name: t('siteIdentity.save') }));
    expect(await screen.findByText(t('siteIdentity.fix_fields'))).toBeTruthy();
    await waitFor(() => expect(name.getAttribute('aria-invalid')).toBe('true'));
    const described = name.getAttribute('aria-describedby')!.split(' ').map((id) => document.getElementById(id)?.textContent);
    expect(described).toContain(ADMIN_MESSAGES.id['form.error.too_big']);
    await waitFor(() => expect(document.activeElement).toBe(name));
  });

  it('a save another admin made first: the conflict is said, and "Muat ulang" reads the identity again', async () => {
    let reads = 0;
    startApp({
      me: adminMe(),
      path: PATH,
      routes: {
        'GET site/identity': () => {
          reads += 1;
          return view({ name: reads === 1 ? 'Nama lama' : 'Nama dari admin lain' }, { revision: reads === 1 ? '0123456789abcdef' : 'aaaaaaaaaaaaaaaa' });
        },
        'PUT site/identity': () => problem(409, 'CONFLICT_STALE'),
      },
    });
    const name = (await screen.findByDisplayValue('Nama lama', undefined, FIRST)) as HTMLInputElement;
    fireEvent.change(name, { target: { value: 'Nama saya' } });
    fireEvent.click(screen.getByRole('button', { name: t('siteIdentity.save') }));
    const said = await screen.findByText(t('siteIdentity.conflict'));
    fireEvent.click(within(said.closest('[role=alert]') as HTMLElement).getByRole('button', { name: t('siteIdentity.reload') }));
    expect(await screen.findByDisplayValue('Nama dari admin lain')).toBeTruthy();
    expect(screen.queryByText(t('siteIdentity.conflict'))).toBeNull();
  });

  it('without opac.pages.manage the screen says so and asks the server nothing', async () => {
    const { requests } = startApp({ me: signedIn({ permissions: ['catalog.records.read'] as never }), path: PATH, routes: { 'GET site/identity': () => view() } });
    expect(await screen.findByText(t('siteIdentity.no_permission'), undefined, FIRST)).toBeTruthy();
    expect(requests.filter((r) => r.path === 'site/identity')).toEqual([]);
    expect(screen.queryByRole('button', { name: t('siteIdentity.save') })).toBeNull();
  });
});
