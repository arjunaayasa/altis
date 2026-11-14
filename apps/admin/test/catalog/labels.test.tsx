import type { ItemDetail } from '@altis/shared/api/catalog/items';
import type { CatalogConfigView } from '@altis/shared/api/settings';
import { fireEvent, screen, waitFor, within } from '@testing-library/react';
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import { printQueueKey, type QueueEntry } from '@/components/catalog/print-queue';
import { adminMe, problem, signedIn, startApp, type FakeHandler, type FakeRequest } from '../fake-api';

// Cetak Label (Phase 2 spec §7, §13; plan Task 30, route `catalog.labels.create` of Task 36) through the real router
// and API client against a fake `/api/v1`: the print queue (remove, clear), adding an item by its barcode, the label
// profile of `GET catalog/config`, the start position and the copies; "Buat PDF" posts
// `{profileId, itemIds | recordIds, startPosition, copies}` and offers the PDF the server answered, telling how many
// queued entries gave no label (`X-Altis-Label-Skipped`); the 422 CATALOG_LABEL_LIMIT refusal is explained.

const idOf = (n: number): string => `01JZ0000000000000000000T${String(n).padStart(2, '0')}`;
const item = (n: number, label = `B000${n}`): QueueEntry => ({ kind: 'item', id: idOf(n), label });
const record = (n: number, label: string): QueueEntry => ({ kind: 'record', id: idOf(n), label });

const CONFIG: CatalogConfigView = {
  barcodePatterns: [],
  symbology: 'code128',
  labelProfiles: [
    { id: 'spine-a4', name: 'Punggung A4 3×10', kind: 'spine' },
    { id: 'barcode-a4', name: 'Barkod A4 3×8', kind: 'barcode' },
  ],
  currency: 'IDR',
  dedupeThreshold: 80,
  defaultMaterialTypeId: null,
  defaultCollectionTypeId: null,
  sruServers: [],
  arsyaEnabled: false,
};

/** A small PDF answer as the label route sends it. */
function pdf(skipped = 0): Response {
  return new Response(new TextEncoder().encode('%PDF-1.4\n%%EOF\n'), {
    status: 200,
    headers: { 'Content-Type': 'application/pdf', 'Content-Disposition': 'inline; filename="label.pdf"', 'X-Altis-Label-Skipped': String(skipped), 'X-Altis-Build': '0.1.0' },
  });
}

function itemDetail(o: Partial<ItemDetail> & Pick<ItemDetail, 'id' | 'barcode'>): ItemDetail {
  return {
    record: { id: '01JZ0000000000000000000R01', title: 'Laskar Pelangi' },
    branch: { id: '01JZ0000000000000000000B01', code: 'PUSAT', name: 'Perpustakaan Pusat' },
    inventoryNo: null,
    callNumber: '899.221 HIR l',
    locationId: null,
    locationPath: null,
    suggestedLocation: null,
    collectionTypeId: '01JZ0000000000000000000C01',
    status: 'available',
    statusNote: null,
    partsTotal: 1,
    acqSource: null,
    orderNo: null,
    orderDate: null,
    receivedDate: null,
    invoiceDate: null,
    supplierId: null,
    invoiceNo: null,
    price: null,
    currency: null,
    note: null,
    custom: {},
    loanable: true,
    selfService: false,
    circulation: { state: null },
    archived: false,
    createdAt: 1,
    updatedAt: null,
    version: 1,
    history: [],
    ...o,
  };
}

const FIRST = { timeout: 10_000 };

const queueOf = (): QueueEntry[] => JSON.parse(localStorage.getItem(printQueueKey('U1')) ?? '[]') as QueueEntry[];
const posted = (requests: FakeRequest[]): unknown[] => requests.filter((r) => r.method === 'POST' && r.path === 'catalog/labels').map((r) => r.body);

function start(queue: QueueEntry[], routes: Record<string, FakeHandler> = {}) {
  localStorage.setItem(printQueueKey('U1'), JSON.stringify(queue));
  return startApp({
    me: adminMe(),
    path: '/admin/catalog/labels',
    routes: { 'GET catalog/config': () => CONFIG, 'POST catalog/labels': () => pdf(), ...routes },
  });
}

let created: Blob[] = [];

beforeEach(() => {
  localStorage.clear();
  created = [];
  // jsdom has no object URLs: record what the screen makes one of.
  Object.defineProperty(URL, 'createObjectURL', {
    configurable: true,
    value: vi.fn((blob: Blob) => {
      created.push(blob);
      return `blob:https://altis.test/${created.length}`;
    }),
  });
  Object.defineProperty(URL, 'revokeObjectURL', { configurable: true, value: vi.fn() });
});

afterEach(() => {
  vi.unstubAllGlobals();
  vi.restoreAllMocks();
});

describe('Cetak Label', () => {
  it('posts {profileId, itemIds, startPosition, copies} and offers the PDF the server made', async () => {
    const { requests } = start([item(1), item(2), item(3)]);
    const table = await screen.findByRole('table', { name: 'Antrean cetak' }, FIRST);
    expect(within(table).getByText('B0001')).toBeTruthy();
    expect(screen.getByText('3 dari 1.000 butir')).toBeTruthy();

    fireEvent.change(await screen.findByLabelText('Profil label'), { target: { value: 'barcode-a4' } });
    fireEvent.change(screen.getByLabelText('Posisi awal'), { target: { value: '4' } });
    fireEvent.change(screen.getByLabelText('Salinan per label'), { target: { value: '2' } });
    fireEvent.click(screen.getByRole('button', { name: 'Buat PDF' }));

    const open = await screen.findByRole('link', { name: 'Buka PDF' });
    expect(posted(requests)).toEqual([{ profileId: 'barcode-a4', itemIds: [idOf(1), idOf(2), idOf(3)], startPosition: 4, copies: 2 }]);
    expect(open.getAttribute('href')).toBe('blob:https://altis.test/1');
    expect(open.getAttribute('target')).toBe('_blank');
    const download = screen.getByRole('link', { name: 'Unduh PDF' });
    expect(download.getAttribute('href')).toBe('blob:https://altis.test/1');
    expect(download.getAttribute('download')).toBe('label.pdf');
    expect(created[0]?.size).toBeGreaterThan(0);
    // The queue is kept until the user removes what was printed.
    expect(queueOf()).toHaveLength(3);
    fireEvent.click(screen.getByRole('button', { name: 'Keluarkan yang sudah dicetak dari antrean' }));
    await waitFor(() => expect(queueOf()).toEqual([]));
  });

  it('the default profile is the first, the start position 1 and one copy; skipped entries are told', async () => {
    const { requests } = start([item(1), item(2)], { 'POST catalog/labels': () => pdf(1) });
    await screen.findByRole('table', { name: 'Antrean cetak' }, FIRST);
    await waitFor(() => expect((screen.getByLabelText('Profil label') as HTMLSelectElement).value).toBe('spine-a4'));
    fireEvent.click(screen.getByRole('button', { name: 'Buat PDF' }));
    await screen.findByRole('link', { name: 'Buka PDF' });
    expect(posted(requests)).toEqual([{ profileId: 'spine-a4', itemIds: [idOf(1), idOf(2)], startPosition: 1, copies: 1 }]);
    expect(screen.getByText(/1 butir antrean tidak menghasilkan label/)).toBeTruthy();
  });

  it('a queue of items and records prints one kind at a time: the records post recordIds', async () => {
    const { requests } = start([item(1), record(2, 'Laskar Pelangi'), record(3, 'Bumi Manusia')]);
    await screen.findByRole('table', { name: 'Antrean cetak' }, FIRST);
    await waitFor(() => expect((screen.getByLabelText('Profil label') as HTMLSelectElement).value).toBe('spine-a4'));
    fireEvent.click(screen.getByLabelText('Cantuman di antrean (2), semua eksemplarnya'));
    fireEvent.click(screen.getByRole('button', { name: 'Buat PDF' }));
    await screen.findByRole('link', { name: 'Buka PDF' });
    expect(posted(requests)).toEqual([{ profileId: 'spine-a4', recordIds: [idOf(2), idOf(3)], startPosition: 1, copies: 1 }]);
    fireEvent.click(screen.getByRole('button', { name: 'Keluarkan yang sudah dicetak dari antrean' }));
    await waitFor(() => expect(queueOf()).toEqual([item(1)]));
  });

  it('explains the 422 CATALOG_LABEL_LIMIT refusal', async () => {
    start([record(2, 'Ensiklopedia')], { 'POST catalog/labels': () => problem(422, 'CATALOG_LABEL_LIMIT', { meta: { max: 1000 } }) });
    await screen.findByRole('table', { name: 'Antrean cetak' }, FIRST);
    await waitFor(() => expect((screen.getByLabelText('Profil label') as HTMLSelectElement).value).toBe('spine-a4'));
    fireEvent.click(screen.getByRole('button', { name: 'Buat PDF' }));
    const alert = await screen.findByText(/Satu PDF memuat paling banyak 1.000 label/);
    expect(alert.textContent).toContain('eksemplar');
    expect(screen.queryByRole('link', { name: 'Buka PDF' })).toBeNull();
  });

  it('a profile that is gone is said at the profile field', async () => {
    start([item(1)], { 'POST catalog/labels': () => problem(422, 'VALIDATION_FAILED', { errors: [{ path: 'profileId', code: 'not_found' }] }) });
    await screen.findByRole('table', { name: 'Antrean cetak' }, FIRST);
    await waitFor(() => expect((screen.getByLabelText('Profil label') as HTMLSelectElement).value).toBe('spine-a4'));
    fireEvent.click(screen.getByRole('button', { name: 'Buat PDF' }));
    expect(await screen.findByText('Profil label ini tidak ada lagi. Pilih profil lain.')).toBeTruthy();
  });

  it('checks the start position and the copies before anything is sent', async () => {
    const { requests } = start([item(1)]);
    await screen.findByRole('table', { name: 'Antrean cetak' }, FIRST);
    fireEvent.change(await screen.findByLabelText('Posisi awal'), { target: { value: '0' } });
    fireEvent.change(screen.getByLabelText('Salinan per label'), { target: { value: '6' } });
    fireEvent.click(screen.getByRole('button', { name: 'Buat PDF' }));
    expect(await screen.findByText('Isi angka 1 sampai 1.000.')).toBeTruthy();
    expect(screen.getByText('Isi angka 1 sampai 5.')).toBeTruthy();
    expect(posted(requests)).toEqual([]);
  });

  it('adds an item by its barcode, and says when a barcode is unknown or archived', async () => {
    start([], {
      'GET catalog/items/by-barcode': (req) => {
        const code = req.query.get('barcode');
        if (code === 'B0007') return itemDetail({ id: idOf(7), barcode: 'B0007' });
        if (code === 'B0008') return itemDetail({ id: idOf(8), barcode: 'B0008', archived: true });
        return problem(404, 'NOT_FOUND');
      },
    });
    expect(await screen.findByText(/Antrean kosong/, undefined, FIRST)).toBeTruthy();
    const field = screen.getByLabelText('Barkod eksemplar');
    fireEvent.change(field, { target: { value: 'B0007' } });
    fireEvent.click(screen.getByRole('button', { name: 'Tambah' }));
    const table = await screen.findByRole('table', { name: 'Antrean cetak' });
    expect(within(table).getByText('B0007 — Laskar Pelangi')).toBeTruthy();
    expect(queueOf()).toEqual([item(7, 'B0007 — Laskar Pelangi')]);

    fireEvent.change(field, { target: { value: 'B0008' } });
    fireEvent.click(screen.getByRole('button', { name: 'Tambah' }));
    expect(await screen.findByText('Eksemplar B0008 diarsipkan dan tidak diberi label.')).toBeTruthy();

    fireEvent.change(field, { target: { value: 'X999' } });
    fireEvent.click(screen.getByRole('button', { name: 'Tambah' }));
    expect(await screen.findByText('Barkod X999 tidak ditemukan.')).toBeTruthy();
    expect(queueOf()).toHaveLength(1);
  });

  it('removes one entry, and clears the queue after a confirmation', async () => {
    start([item(1), item(2), record(3, 'Laskar Pelangi')]);
    const table = await screen.findByRole('table', { name: 'Antrean cetak' }, FIRST);
    fireEvent.click(within(table).getByRole('button', { name: 'Keluarkan B0002 dari antrean' }));
    await waitFor(() => expect(queueOf().map((e) => e.id)).toEqual([idOf(1), idOf(3)]));
    expect(within(table).getByText('Cantuman')).toBeTruthy();

    fireEvent.click(screen.getByRole('button', { name: 'Kosongkan antrean' }));
    const dialog = await screen.findByRole('alertdialog');
    fireEvent.click(within(dialog).getByRole('button', { name: 'Kosongkan' }));
    expect(await screen.findByText(/Antrean kosong/)).toBeTruthy();
    expect(queueOf()).toEqual([]);
  });

  it('a user without catalog.records.read is told so, and nothing is asked', async () => {
    const { requests } = startApp({ me: signedIn({ permissions: ['system.users.read'] }), path: '/admin/catalog/labels', routes: {} });
    expect(await screen.findByText('Anda tidak memiliki izin untuk melakukan ini.', undefined, FIRST)).toBeTruthy();
    expect(requests.filter((r) => r.path.startsWith('catalog/'))).toEqual([]);
  });
});
