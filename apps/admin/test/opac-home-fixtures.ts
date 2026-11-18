import { OPAC_HOME_DEFAULT, type OpacHomeSlide, type OpacHomeView } from '@altis/shared/api/opac-home';
import { fireEvent, screen } from '@testing-library/react';
import { vi } from 'vitest';
import { ADMIN_MESSAGES, type AdminKey } from '@/i18n';
import { uploadFile } from '@/lib/upload';
import type { FakeRequest } from './fake-api';

// What the tests of OPAC › Halaman awal share: the Indonesian copy, a loaded content, slides and file ids the schema
// takes, the PUT bodies a test saw, the way to another tab, and a photo upload without a canvas (jsdom has none: the
// decoder, the canvas and the upload are stubbed, so "Pakai foto ini" hands the page a file id).

export const t = (key: AdminKey, params: Record<string, string | number> = {}): string =>
  Object.entries(params).reduce((text, [k, v]) => text.replace(`{${k}}`, String(v)), ADMIN_MESSAGES.id[key]);

export const FIRST = { timeout: 10_000 };

/** A file id the schema takes (a ULID), by number. */
export const fileId = (n: number): string => `01JZFXQ00000000000000000${String(n).padStart(2, '0')}`;

const NONE = { id: null, en: null };

/** A slide named `slide-<n>` with the photo `fileId(n)`, shown always, titled in Indonesian only. */
export function slide(n: number, o: Partial<OpacHomeSlide> = {}): OpacHomeSlide {
  return { id: `slide-${n}`, fileId: fileId(n), alt: `Foto ${n}`, position: 50, note: NONE, title: { id: `Judul ${n}`, en: null }, subtitle: NONE, cta: null, active: true, from: null, until: null, ...o };
}

export const heroOf = (...slides: OpacHomeSlide[]): OpacHomeView['home']['hero'] => ({ slides, autoplay: true, intervalSec: 7 });

export function view(o: Partial<OpacHomeView['home']> = {}): OpacHomeView {
  return {
    home: { ...OPAC_HOME_DEFAULT, services: [{ title: 'Peminjaman', text: null }], ...o },
    welcome: { id: 'Selamat datang.', en: null },
    revision: '0123456789abcdef',
    libraryName: 'Perpustakaan SMA 1',
    accent: 'blue',
  };
}

export const SAVED = { revision: 'fedcba9876543210', changed: ['opac.home'] };

export const puts = (requests: FakeRequest[]): unknown[] => requests.filter((r) => r.method === 'PUT' && r.path === 'opac/home').map((r) => r.body);

/** Opens the tab named by `key` and waits for it. */
export async function openTab(key: AdminKey): Promise<void> {
  const link = screen.getByRole('link', { name: new RegExp(`^${t(key)}`) });
  fireEvent.click(link);
  await vi.waitFor(() => {
    if (link.getAttribute('data-status') !== 'active') throw new Error('the tab is not open yet');
  });
}

export const save = (): void => {
  fireEvent.click(screen.getByRole('button', { name: t('opacHome.save') }));
};

/** Stubs the image decoder, the canvas and the upload: the next uploads answer `ids` in turn. */
export function stubPhotoUpload(...ids: string[]): void {
  vi.stubGlobal('createImageBitmap', vi.fn(async () => ({ width: 1600, height: 900, close: vi.fn() })));
  vi.spyOn(HTMLCanvasElement.prototype, 'getContext').mockImplementation((() => ({ drawImage: vi.fn(), fillRect: vi.fn() })) as unknown as HTMLCanvasElement['getContext']);
  vi.spyOn(HTMLCanvasElement.prototype, 'toBlob').mockImplementation((done: BlobCallback) => done(new Blob(['x'], { type: 'image/jpeg' })));
  const upload = vi.mocked(uploadFile);
  upload.mockReset();
  for (const id of ids) upload.mockResolvedValueOnce({ uploadId: id } as never);
}

/** Chooses a photo in the file field labelled `label`, and takes the crop as it is. */
export async function choosePhoto(label: string): Promise<void> {
  fireEvent.change(screen.getByLabelText(label), { target: { files: [new File(['x'], 'foto.jpg', { type: 'image/jpeg' })] } });
  fireEvent.click(await screen.findByRole('button', { name: t('opacHome.crop.use') }));
}
