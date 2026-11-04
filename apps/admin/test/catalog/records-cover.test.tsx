import type { CatalogConfigView } from '@altis/shared/api/settings';
import type { MaterialTypeView } from '@altis/shared/api/catalog/masters';
import type { RecordDetail } from '@altis/shared/api/catalog/records';
import { fireEvent, screen, waitFor } from '@testing-library/react';
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import { resizeImage, scaledSize } from '@/lib/image-resize';
import { uploadFile } from '@/lib/upload';
import { adminMe, problem, startApp, type FakeRequest } from '../fake-api';

// The cover of a record (Phase 2 spec §8, §13; plan Task 24): the browser shrinks the image (longest side ≤ 600 px,
// WebP or JPEG) before it is uploaded to `catalog.cover`, then `PUT catalog/records/:id/cover {fileId, version}` sets it
// and the record is read again (S15). The server strips the metadata (Task 18).

vi.mock('@/lib/image-resize', async (importOriginal) => {
  const real = await importOriginal<typeof import('@/lib/image-resize')>();
  return { ...real, resizeImage: vi.fn() };
});
vi.mock('@/lib/upload', () => ({ uploadFile: vi.fn() }));

const MT_BOOK = '01JZ0000000000000000000B01';
const RECORD = '01JZ0000000000000000000R01';
const FILE_OLD = '01JZ0000000000000000000F01';
const FILE_NEW = '01JZ0000000000000000000F02';

const BOOK: MaterialTypeView = {
  id: MT_BOOK,
  code: 'BUKU',
  nameId: 'Buku',
  nameEn: 'Book',
  marcType: 'a',
  marcLevel: 'm',
  contentType: 'txt',
  mediaType: 'n',
  carrierType: 'nc',
  schemaType: 'Book',
  dcmiType: 'Text',
  template: { fields: {}, defaults: {}, customFields: [] },
  sortOrder: 0,
  usage: 1,
  archived: false,
  version: 1,
};

const CONFIG: CatalogConfigView = {
  barcodePatterns: [],
  symbology: 'code128',
  labelProfiles: [],
  currency: 'IDR',
  dedupeThreshold: 80,
  defaultMaterialTypeId: MT_BOOK,
  defaultCollectionTypeId: null,
  sruServers: [],
  arsyaEnabled: false,
};

function detail(o: Partial<RecordDetail>): RecordDetail {
  return {
    id: RECORD,
    version: 3,
    materialTypeId: MT_BOOK,
    languageId: null,
    source: null,
    custom: {},
    warnings: [],
    itemCounts: { total: 0, available: 0 },
    createdAt: 1_700_000_000_000,
    updatedAt: 1_700_000_000_000,
    changedAt: 1_700_000_000_000,
    opacVisible: true,
    promoted: false,
    archived: false,
    mergedInto: null,
    materialType: { id: MT_BOOK, code: 'BUKU', nameId: 'Buku', nameEn: 'Book', marcType: 'a', marcLevel: 'm', schemaType: 'Book', dcmiType: 'Text' },
    language: null,
    materialTypeCode: 'BUKU',
    title: 'Ronggeng Dukuh Paruk',
    publisher: null,
    identifiers: [],
    agents: [],
    subjects: [],
    links: [],
    items: [],
    marcExtra: [],
    coverFileId: null,
    attachments: [],
    relations: [],
    customPublic: [],
    ...o,
  };
}

function start(o: { cover: () => string | null; version: () => number; put?: (req: FakeRequest) => unknown }) {
  return startApp({
    me: adminMe(),
    path: `/admin/catalog/records/${RECORD}`,
    routes: {
      'GET catalog/material-types': () => ({ items: [BOOK] }),
      'GET catalog/languages': () => ({ items: [] }),
      'GET catalog/custom-fields': () => ({ items: [] }),
      'GET catalog/config': () => CONFIG,
      'POST catalog/records/duplicates': () => ({ candidates: [], threshold: 80 }),
      [`GET catalog/records/${RECORD}`]: () => detail({ coverFileId: o.cover(), version: o.version() }),
      [`PUT catalog/records/${RECORD}/cover`]: (req) => o.put?.(req) ?? { id: RECORD, version: o.version() },
    },
  });
}

const covers = (requests: FakeRequest[]) => requests.filter((r) => r.method === 'PUT' && r.path === `catalog/records/${RECORD}/cover`).map((r) => r.body);
const reads = (requests: FakeRequest[]) => requests.filter((r) => r.method === 'GET' && r.path === `catalog/records/${RECORD}`).length;

beforeEach(() => {
  vi.mocked(resizeImage).mockReset();
  vi.mocked(uploadFile).mockReset();
});

afterEach(() => {
  vi.unstubAllGlobals();
  vi.restoreAllMocks();
});

describe('the cover of a record', () => {
  it('resizes the image (maxSide 600) before the upload, then PUTs {fileId, version} and reads the record again', async () => {
    let cover: string | null = null;
    let version = 3;
    const small = new Blob([new Uint8Array([1, 2, 3])], { type: 'image/webp' });
    vi.mocked(resizeImage).mockResolvedValue(small);
    vi.mocked(uploadFile).mockResolvedValue({ uploadId: FILE_NEW });
    const { requests } = start({
      cover: () => cover,
      version: () => version,
      put: () => {
        cover = FILE_NEW;
        version = 4;
        return { id: RECORD, version };
      },
    });
    expect(await screen.findByText('Belum ada sampul.')).toBeTruthy();
    const file = new File([new Uint8Array(4096)], 'sampul.jpg', { type: 'image/jpeg' });
    const before = reads(requests);
    fireEvent.change(screen.getByLabelText('Pilih gambar sampul'), { target: { files: [file] } });

    await waitFor(() => expect(covers(requests)).toEqual([{ fileId: FILE_NEW, version: 3 }]));
    expect(resizeImage).toHaveBeenCalledWith(file, { maxSide: 600, type: 'image/webp' });
    expect(uploadFile).toHaveBeenCalledWith(small, expect.objectContaining({ context: 'catalog.cover' }));
    expect(vi.mocked(resizeImage).mock.invocationCallOrder[0]).toBeLessThan(vi.mocked(uploadFile).mock.invocationCallOrder[0]!);
    await waitFor(() => expect(reads(requests)).toBeGreaterThan(before));
    const img = await screen.findByRole('img', { name: 'Sampul Ronggeng Dukuh Paruk' });
    expect(img.getAttribute('src')).toBe(`/files/${FILE_NEW}`);
    expect(screen.getByText('Sampul disimpan.')).toBeTruthy();
  });

  it('removes the cover with {fileId: null, version}', async () => {
    let cover: string | null = FILE_OLD;
    let version = 7;
    const { requests } = start({
      cover: () => cover,
      version: () => version,
      put: () => {
        cover = null;
        version = 8;
        return { id: RECORD, version };
      },
    });
    await screen.findByRole('img', { name: 'Sampul Ronggeng Dukuh Paruk' });
    fireEvent.click(screen.getByRole('button', { name: 'Hapus sampul' }));
    await waitFor(() => expect(covers(requests)).toEqual([{ fileId: null, version: 7 }]));
    expect(await screen.findByText('Belum ada sampul.')).toBeTruthy();
    expect(resizeImage).not.toHaveBeenCalled();
  });

  it('an image the browser cannot read is refused before anything is sent', async () => {
    vi.mocked(resizeImage).mockRejectedValue(new TypeError('decode'));
    const { requests } = start({ cover: () => null, version: () => 3 });
    await screen.findByText('Belum ada sampul.');
    fireEvent.change(screen.getByLabelText('Pilih gambar sampul'), { target: { files: [new File(['x'], 'rusak.png', { type: 'image/png' })] } });
    expect(await screen.findByText(/Gambar ini tidak dapat dibaca/)).toBeTruthy();
    expect(uploadFile).not.toHaveBeenCalled();
    expect(covers(requests)).toEqual([]);
  });

  it('a refused PUT shows the server’s reason', async () => {
    vi.mocked(resizeImage).mockResolvedValue(new Blob(['x'], { type: 'image/webp' }));
    vi.mocked(uploadFile).mockResolvedValue({ uploadId: FILE_NEW });
    start({ cover: () => null, version: () => 3, put: () => problem(409, 'CONFLICT_STALE') });
    await screen.findByText('Belum ada sampul.');
    fireEvent.change(screen.getByLabelText('Pilih gambar sampul'), { target: { files: [new File(['x'], 'a.jpg', { type: 'image/jpeg' })] } });
    expect(await screen.findByText('Data ini sudah diubah oleh orang lain. Muat ulang, lalu coba lagi.')).toBeTruthy();
  });
});

describe('resizeImage (lib/image-resize.ts)', () => {
  it('scaledSize keeps the ratio within maxSide and never enlarges', () => {
    expect(scaledSize(1200, 800, 600)).toEqual({ width: 600, height: 400 });
    expect(scaledSize(800, 1600, 600)).toEqual({ width: 300, height: 600 });
    expect(scaledSize(400, 300, 600)).toEqual({ width: 400, height: 300 });
    expect(scaledSize(3000, 1, 600)).toEqual({ width: 600, height: 1 });
  });

  it('draws the decoded image on a canvas of the scaled size and encodes it as asked, JPEG when WebP is not supported', async () => {
    const { resizeImage: realResize } = await vi.importActual<typeof import('@/lib/image-resize')>('@/lib/image-resize');
    const bitmap = { width: 1200, height: 900, close: vi.fn() };
    vi.stubGlobal('createImageBitmap', vi.fn(async () => bitmap));
    const drawImage = vi.fn();
    const fillRect = vi.fn();
    const sizes: [number, number][] = [];
    vi.spyOn(HTMLCanvasElement.prototype, 'getContext').mockImplementation(function (this: HTMLCanvasElement) {
      sizes.push([this.width, this.height]);
      return { drawImage, fillRect, fillStyle: '#000000', imageSmoothingQuality: 'low' } as unknown as CanvasRenderingContext2D;
    } as unknown as HTMLCanvasElement['getContext']);
    const asked: string[] = [];
    vi.spyOn(HTMLCanvasElement.prototype, 'toBlob').mockImplementation((done: BlobCallback, type?: string) => {
      asked.push(type ?? '');
      // This browser cannot encode WebP: it answers PNG, as browsers do.
      done(new Blob(['x'], { type: type === 'image/webp' ? 'image/png' : (type ?? 'image/png') }));
    });
    const file = new File([new Uint8Array(10)], 'besar.jpg', { type: 'image/jpeg' });
    const out = await realResize(file, { maxSide: 600, type: 'image/webp' });
    expect(sizes).toEqual([[600, 450]]);
    expect(drawImage).toHaveBeenCalledWith(bitmap, 0, 0, 600, 450);
    // A transparent PNG gets a white backdrop first: JPEG has no transparency, and would turn it black.
    expect(fillRect).toHaveBeenCalledWith(0, 0, 600, 450);
    expect(fillRect.mock.invocationCallOrder[0]).toBeLessThan(drawImage.mock.invocationCallOrder[0]!);
    expect(asked).toEqual(['image/webp', 'image/jpeg']);
    expect(out.type).toBe('image/jpeg');
    expect(bitmap.close).toHaveBeenCalled();
  });
});
