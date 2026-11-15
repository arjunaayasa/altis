import type { ItemDetail } from '@altis/shared/api/catalog/items';
import { fireEvent, screen, waitFor, within } from '@testing-library/react';
import { afterEach, describe, expect, it, vi } from 'vitest';
import { adminMe, problem, startApp, type FakeHandler } from '../fake-api';
import { BRANCHES_UTARA_OUTSIDE, FIRST, ITEM, ITEM_CUSTOM_FIELDS, PUSAT, UTARA, RECORD, ROOM_PUSAT, SHELF_800, SHELF_808, SUPPLIER, TK_REF, catalogReads, itemDetail, itemEvent, itemsManagerAt, ulid } from './items-fixtures';

// Eksemplar, one item (Phase 2 Task 25; spec §13, §2.5, §3.4): `GET catalog/items/:id` (the item and its history), the
// form with a status select limited to ITEM_TRANSITIONS[current], the price as a decimal string, the suggested shelf
// when no location is set, `PATCH branches/:branchId/items/:id` with only the changed fields and the version (the
// answer is `{id, version}`, S15, so the screen reads the item again), `DELETE …` (siangi) with `{version}`, and the
// history.

afterEach(() => {
  vi.unstubAllGlobals();
  vi.restoreAllMocks();
});

const PATH = `/admin/catalog/items/${ITEM}`;
const PATCH = `PATCH branches/${PUSAT}/items/${ITEM}`;

/** The reads of the item page; `item` answers `GET catalog/items/:id` (a function: each read may answer anew, or fail). */
function itemRoutes(item: () => ItemDetail | Response, extra: Record<string, FakeHandler> = {}): Record<string, FakeHandler> {
  return catalogReads({ 'GET catalog/items/:id': (req) => (req.params.id === ITEM ? item() : problem(404, 'NOT_FOUND')), ...extra });
}

const statusSelect = async (): Promise<HTMLSelectElement> => (await screen.findByRole('combobox', { name: 'Status' }, FIRST)) as HTMLSelectElement;
const optionsOf = (select: HTMLSelectElement): string[] => [...select.options].map((o) => o.value);

describe('ItemEditScreen: the status select', () => {
  it('an available item offers exactly not_for_loan, repair, missing, withdrawn and lost besides its current status', async () => {
    startApp({ me: adminMe(), path: PATH, routes: itemRoutes(() => itemDetail({ status: 'available' })) });
    const select = await statusSelect();
    expect(optionsOf(select)).toEqual(['available', 'not_for_loan', 'repair', 'missing', 'withdrawn', 'lost']);
    expect([...select.options].map((o) => o.textContent)).toEqual(['Tersedia (saat ini)', 'Baca di tempat', 'Perbaikan', 'Tidak ditemukan di rak', 'Disiangi', 'Dinyatakan hilang']);
    expect(select.value).toBe('available');
  });

  it.each([
    ['missing', ['missing', 'available', 'not_for_loan', 'lost']],
    ['lost', ['lost', 'available', 'withdrawn']],
    ['on_order', ['on_order', 'processing', 'available', 'withdrawn']],
  ] as const)('a %s item offers its own row of the §2.5 table', async (status, offered) => {
    startApp({ me: adminMe(), path: PATH, routes: itemRoutes(() => itemDetail({ status })) });
    expect(optionsOf(await statusSelect())).toEqual(offered);
  });
});

describe('ItemEditScreen: saving', () => {
  it('sends only the changed fields with the version (the price as a decimal string), then reads the item again', async () => {
    const sent: unknown[] = [];
    let reads = 0;
    let current = itemDetail({ version: 3, supplierId: null });
    const { writes } = startApp({
      me: adminMe(),
      path: PATH,
      routes: itemRoutes(
        () => {
          reads += 1;
          return current;
        },
        {
          [PATCH]: (req) => {
            sent.push(req.body);
            current = itemDetail({ version: 4, status: 'repair', price: '125000.50', currency: 'IDR', supplierId: SUPPLIER, collectionTypeId: TK_REF, note: 'Sampul robek' });
            return { id: ITEM, version: 4 };
          },
        },
      ),
    });
    fireEvent.change(await statusSelect(), { target: { value: 'repair' } });
    fireEvent.change(screen.getByRole('combobox', { name: 'Tipe koleksi' }), { target: { value: TK_REF } });
    fireEvent.change(screen.getByRole('textbox', { name: 'Harga' }), { target: { value: '125000.5' } });
    fireEvent.change(screen.getByRole('combobox', { name: 'Pemasok' }), { target: { value: SUPPLIER } });
    fireEvent.change(screen.getByRole('textbox', { name: 'Catatan' }), { target: { value: 'Sampul robek' } });
    const readsBefore = reads;
    fireEvent.click(screen.getByRole('button', { name: 'Simpan' }));
    expect(await screen.findByText('Perubahan eksemplar disimpan.')).toBeTruthy();
    expect(writes()).toEqual([PATCH]);
    expect(sent).toEqual([{ version: 3, status: 'repair', collectionTypeId: TK_REF, supplierId: SUPPLIER, price: '125000.5', note: 'Sampul robek' }]);
    await waitFor(() => expect(reads).toBeGreaterThan(readsBefore));
    // The form now shows what the server holds, with the new version for the next save.
    await waitFor(() => expect(optionsOf(screen.getByRole('combobox', { name: 'Status' }))[0]).toBe('repair'));
    expect((screen.getByRole('textbox', { name: 'Harga' }) as HTMLInputElement).value).toBe('125000.50');
  });

  it('a save counts even when the read after it fails: the next save carries the new version and only the new change', async () => {
    const sent: unknown[] = [];
    let reads = 0;
    startApp({
      me: adminMe(),
      path: PATH,
      routes: itemRoutes(
        () => {
          reads += 1;
          return reads === 1 ? itemDetail({ version: 3 }) : problem(503, 'DB_UNAVAILABLE');
        },
        {
          [PATCH]: (req) => {
            sent.push(req.body);
            return { id: ITEM, version: 3 + sent.length };
          },
        },
      ),
    });
    fireEvent.change(await statusSelect(), { target: { value: 'repair' } });
    fireEvent.click(screen.getByRole('button', { name: 'Simpan' }));
    expect(await screen.findByText('Perubahan eksemplar disimpan.')).toBeTruthy();
    await waitFor(() => expect(reads).toBeGreaterThan(1));
    // The form keeps what was saved; the status choices are those of the saved status.
    expect(optionsOf(screen.getByRole('combobox', { name: 'Status' }))).toEqual(['repair', 'available', 'not_for_loan', 'withdrawn']);
    fireEvent.change(screen.getByRole('textbox', { name: 'Catatan' }), { target: { value: 'Dijilid ulang' } });
    fireEvent.click(screen.getByRole('button', { name: 'Simpan' }));
    await waitFor(() => expect(sent).toHaveLength(2));
    expect(sent).toEqual([
      { version: 3, status: 'repair' },
      { version: 4, note: 'Dijilid ulang' },
    ]);
  });

  it('clearing a field sends null, and nothing changed sends nothing', async () => {
    const sent: unknown[] = [];
    const { writes } = startApp({
      me: adminMe(),
      path: PATH,
      routes: itemRoutes(() => itemDetail({ callNumber: '899.221 HIR l', inventoryNo: 'INV-1' }), {
        [PATCH]: (req) => {
          sent.push(req.body);
          return { id: ITEM, version: 4 };
        },
      }),
    });
    await statusSelect();
    fireEvent.click(screen.getByRole('button', { name: 'Simpan' }));
    expect(await screen.findByText('Tidak ada perubahan untuk disimpan.')).toBeTruthy();
    expect(writes()).toEqual([]);
    fireEvent.change(screen.getByRole('textbox', { name: 'Nomor panggil' }), { target: { value: '  ' } });
    fireEvent.click(screen.getByRole('button', { name: 'Simpan' }));
    await waitFor(() => expect(sent).toEqual([{ version: 3, callNumber: null }]));
  });

  it('item custom fields: the stored values are shown, only a changed one is sent, a cleared one as null', async () => {
    const sent: unknown[] = [];
    startApp({
      me: adminMe(),
      path: PATH,
      routes: itemRoutes(() => itemDetail({ custom: { 'dana.sumber': 'Hibah', hadiah: true, lama: 'tetap' } }), {
        'GET catalog/custom-fields': () => ({ items: ITEM_CUSTOM_FIELDS }),
        [PATCH]: (req) => {
          sent.push(req.body);
          return { id: ITEM, version: 4 };
        },
      }),
    });
    await statusSelect();
    const source = (await screen.findByRole('textbox', { name: 'Sumber dana (wajib)' })) as HTMLInputElement;
    expect(source.value).toBe('Hibah');
    expect((screen.getByRole('combobox', { name: 'Hadiah' }) as HTMLSelectElement).value).toBe('true');
    // An archived field is not shown (its value stays stored, §3.7).
    expect(screen.queryByRole('textbox', { name: 'Ruas lama' })).toBeNull();
    fireEvent.change(screen.getByRole('combobox', { name: 'Hadiah' }), { target: { value: '' } });
    fireEvent.change(screen.getByRole('combobox', { name: 'Kondisi' }), { target: { value: 'rusak' } });
    fireEvent.click(screen.getByRole('button', { name: 'Simpan' }));
    await waitFor(() => expect(sent).toEqual([{ version: 3, custom: { hadiah: null, kondisi: 'rusak' } }]));
  });

  it('a custom field error of the server lands on its field', async () => {
    startApp({
      me: adminMe(),
      path: PATH,
      routes: itemRoutes(() => itemDetail({ custom: { 'dana.sumber': 'Hibah' } }), {
        'GET catalog/custom-fields': () => ({ items: ITEM_CUSTOM_FIELDS }),
        [PATCH]: () => problem(422, 'VALIDATION_FAILED', { errors: [{ path: 'custom.dana.sumber', code: 'too_big' }] }),
      }),
    });
    await statusSelect();
    const source = await screen.findByRole('textbox', { name: 'Sumber dana (wajib)' });
    fireEvent.change(source, { target: { value: 'APBD' } });
    fireEvent.click(screen.getByRole('button', { name: 'Simpan' }));
    await waitFor(() => expect(source.getAttribute('aria-invalid')).toBe('true'));
  });

  it('a price with three decimals is refused before anything is sent', async () => {
    const { writes } = startApp({ me: adminMe(), path: PATH, routes: itemRoutes(() => itemDetail()) });
    await statusSelect();
    const price = screen.getByRole('textbox', { name: 'Harga' });
    fireEvent.change(price, { target: { value: '12.345' } });
    fireEvent.click(screen.getByRole('button', { name: 'Simpan' }));
    expect(await screen.findByText('Tulis harga dengan angka dan titik desimal, paling banyak 2 angka di belakang titik (contoh: 125000.50).')).toBeTruthy();
    expect(price.getAttribute('aria-invalid')).toBe('true');
    expect(writes()).toEqual([]);
  });

  it('the server’s field errors land on their fields with the items’ own messages (isbn_not_barcode)', async () => {
    startApp({
      me: adminMe(),
      path: PATH,
      routes: itemRoutes(() => itemDetail(), {
        [PATCH]: () => problem(422, 'VALIDATION_FAILED', { errors: [{ path: 'barcode', code: 'isbn_not_barcode' }] }),
      }),
    });
    await statusSelect();
    const barcode = screen.getByRole('textbox', { name: 'Barkod' });
    fireEvent.change(barcode, { target: { value: '9786020332956' } });
    fireEvent.click(screen.getByRole('button', { name: 'Simpan' }));
    expect(await screen.findByText('Ini ISBN, bukan barkod eksemplar. Pindai barkod yang ditempel pada eksemplar.')).toBeTruthy();
    expect(barcode.getAttribute('aria-invalid')).toBe('true');
  });

  it('a location of another branch answered `invalid` says so on the location field', async () => {
    startApp({
      me: adminMe(),
      path: PATH,
      routes: itemRoutes(() => itemDetail(), {
        [PATCH]: () => problem(422, 'VALIDATION_FAILED', { errors: [{ path: 'locationId', code: 'invalid' }] }),
      }),
    });
    await statusSelect();
    fireEvent.change(screen.getByRole('combobox', { name: 'Lokasi' }), { target: { value: SHELF_800 } });
    fireEvent.click(screen.getByRole('button', { name: 'Simpan' }));
    expect(await screen.findByText('Lokasi ini bukan milik cabang eksemplar.')).toBeTruthy();
  });

  it('a stale version says so and offers to load the item again', async () => {
    let version = 3;
    startApp({
      me: adminMe(),
      path: PATH,
      routes: itemRoutes(() => itemDetail({ version }), { [PATCH]: () => problem(409, 'CONFLICT_STALE') }),
    });
    fireEvent.change(await statusSelect(), { target: { value: 'repair' } });
    fireEvent.click(screen.getByRole('button', { name: 'Simpan' }));
    const alert = await screen.findByText('Data ini sudah diubah oleh orang lain. Muat ulang, lalu coba lagi.');
    version = 5;
    fireEvent.click(within(alert.closest('[role="alert"]')!).getByRole('button', { name: 'Muat ulang' }));
    await waitFor(() => expect((screen.getByRole('combobox', { name: 'Status' }) as HTMLSelectElement).value).toBe('available'));
  });
});

describe('ItemEditScreen: location and history', () => {
  it('without a location, the suggested shelf is shown and “Pakai saran” puts it in the form (not saved yet)', async () => {
    const sent: unknown[] = [];
    startApp({
      me: adminMe(),
      path: PATH,
      routes: itemRoutes(() => itemDetail({ locationId: null, suggestedLocation: { id: SHELF_808, name: 'Rak 808', shelfHint: 'Lorong 3' } }), {
        [PATCH]: (req) => {
          sent.push(req.body);
          return { id: ITEM, version: 4 };
        },
      }),
    });
    expect(await screen.findByText('Saran rak: Rak 808 (Lorong 3)', undefined, FIRST)).toBeTruthy();
    const select = screen.getByRole('combobox', { name: 'Lokasi' }) as HTMLSelectElement;
    expect(select.value).toBe('');
    expect([...select.options].map((o) => o.textContent)).toEqual(['Tanpa lokasi', 'Ruang Baca', 'Ruang Baca › Rak 800', 'Ruang Baca › Rak 808']);
    fireEvent.click(screen.getByRole('button', { name: 'Pakai saran' }));
    expect(select.value).toBe(SHELF_808);
    expect(sent).toEqual([]);
    fireEvent.click(screen.getByRole('button', { name: 'Simpan' }));
    await waitFor(() => expect(sent).toEqual([{ version: 3, locationId: SHELF_808 }]));
  });

  it('an item with a location shows no suggestion', async () => {
    startApp({
      me: adminMe(),
      path: PATH,
      routes: itemRoutes(() =>
        itemDetail({ locationId: SHELF_800, locationPath: { roomId: ROOM_PUSAT, roomName: 'Ruang Baca', areaName: null, shelfName: 'Rak 800', shelfHint: null } }),
      ),
    });
    await statusSelect();
    expect((screen.getByRole('combobox', { name: 'Lokasi' }) as HTMLSelectElement).value).toBe(SHELF_800);
    expect(screen.queryByText(/Saran rak/)).toBeNull();
  });

  it('shows the history, newest first: status changes, moves and the names of the changed fields', async () => {
    const history = [
      itemEvent({ id: ulid('01JZEV', 4), at: 1_760_400_000_000, type: 'updated', fields: ['price', 'note', 'custom'] }),
      itemEvent({ id: ulid('01JZEV', 3), at: 1_760_300_000_000, type: 'moved', fromLocationId: null, toLocationId: SHELF_800, fields: ['locationId'] }),
      itemEvent({ id: ulid('01JZEV', 2), at: 1_760_200_000_000, type: 'status', fromStatus: 'available', toStatus: 'repair', fields: ['status'], actorType: 'system', actorId: null }),
      itemEvent({ id: ulid('01JZEV', 1), at: 1_760_100_000_000, type: 'created', toStatus: 'available' }),
    ];
    startApp({ me: adminMe(), path: PATH, routes: itemRoutes(() => itemDetail({ history })) });
    const list = await screen.findByRole('list', { name: 'Riwayat' }, FIRST);
    const rows = within(list).getAllByRole('listitem');
    expect(rows.map((r) => within(r).getByRole('heading').textContent)).toEqual(['Diubah', 'Dipindahkan', 'Status diubah', 'Dibuat']);
    expect(within(rows[0]!).getByText('Ruas: Harga, Catatan, Ruas tambahan')).toBeTruthy();
    expect(within(rows[1]!).getByText('Dari Tanpa lokasi ke Ruang Baca › Rak 800')).toBeTruthy();
    expect(within(rows[2]!).getByText('Dari Tersedia ke Perbaikan')).toBeTruthy();
    expect(within(rows[2]!).getByText(/Sistem/)).toBeTruthy();
    expect(within(rows[3]!).getByText('Status awal: Tersedia')).toBeTruthy();
  });

  it('the history is shown even when the branch’s locations cannot be read (a move then names an unknown location)', async () => {
    const history = [itemEvent({ id: ulid('01JZEV', 1), type: 'moved', fromLocationId: null, toLocationId: SHELF_800, fields: ['locationId'] })];
    startApp({
      me: adminMe(),
      path: PATH,
      routes: itemRoutes(() => itemDetail({ history }), { 'GET catalog/locations': () => problem(503, 'DB_UNAVAILABLE') }),
    });
    const move = await screen.findByText('Dari Tanpa lokasi ke lokasi yang tidak dikenal', undefined, FIRST);
    expect(move.closest('ol')).toBe(screen.getByRole('list', { name: 'Riwayat' }));
  });
});

describe('ItemEditScreen: access and archive', () => {
  it('read-only for a reader who does not manage items at the item’s branch', async () => {
    const { writes } = startApp({ me: itemsManagerAt([ulid('01JZBR', 2)]), path: PATH, routes: itemRoutes(() => itemDetail()) });
    await statusSelect();
    expect(screen.getByText(/tidak dapat mengubahnya/)).toBeTruthy();
    expect(screen.queryByRole('button', { name: 'Simpan' })).toBeNull();
    expect(screen.queryByRole('button', { name: 'Siangi' })).toBeNull();
    expect(screen.getByRole('textbox', { name: 'Barkod' }).matches(':disabled')).toBe(true);
    expect(writes()).toEqual([]);
  });

  it('L13: an item at a branch the server marks inactive is read-only and says why', async () => {
    startApp({
      me: adminMe(),
      path: PATH,
      routes: itemRoutes(() => itemDetail({ branch: { id: UTARA, code: 'UTARA', name: 'Cabang Utara' } }), {
        'GET branches': () => ({ items: BRANCHES_UTARA_OUTSIDE }),
      }),
    });
    await statusSelect();
    expect(await screen.findByText('Cabang ini tidak aktif; datanya hanya bisa dibaca.')).toBeTruthy();
    expect(screen.queryByRole('button', { name: 'Simpan' })).toBeNull();
    expect(screen.queryByRole('button', { name: 'Siangi' })).toBeNull();
  });

  it('a manager at the item’s branch may edit it', async () => {
    startApp({ me: itemsManagerAt([PUSAT]), path: PATH, routes: itemRoutes(() => itemDetail()) });
    await statusSelect();
    expect(screen.getByRole('button', { name: 'Simpan' })).toBeTruthy();
    expect(screen.getByRole('link', { name: 'Laskar Pelangi' }).getAttribute('href')).toBe(`/admin/catalog/records/${RECORD}`);
  });

  it('“Siangi” asks first, then DELETEs with the version and reads the item again', async () => {
    const sent: unknown[] = [];
    let archived = false;
    const { writes } = startApp({
      me: adminMe(),
      path: PATH,
      routes: itemRoutes(() => itemDetail(archived ? { status: 'withdrawn', archived: true, version: 4 } : {}), {
        [`DELETE branches/${PUSAT}/items/${ITEM}`]: (req) => {
          sent.push(req.body);
          archived = true;
          return { id: ITEM, version: 4 };
        },
      }),
    });
    await statusSelect();
    fireEvent.click(screen.getByRole('button', { name: 'Siangi' }));
    const dialog = await screen.findByRole('alertdialog', { name: 'Siangi eksemplar ini?' });
    expect(writes()).toEqual([]);
    fireEvent.click(within(dialog).getByRole('button', { name: 'Siangi' }));
    await waitFor(() => expect(sent).toEqual([{ version: 3 }]));
    expect(await screen.findByText(/sudah disiangi dan diarsipkan/)).toBeTruthy();
    // Withdrawn: the only way back is `processing`.
    expect(optionsOf(await statusSelect())).toEqual(['withdrawn', 'processing']);
    expect(screen.queryByRole('button', { name: 'Siangi' })).toBeNull();
  });

  it('an unknown item is “not found”', async () => {
    startApp({ me: adminMe(), path: `/admin/catalog/items/${ulid('01JZEKS', 9)}`, routes: itemRoutes(() => itemDetail()) });
    expect(await screen.findByText('Data atau halaman yang diminta tidak ditemukan.', undefined, FIRST)).toBeTruthy();
  });
});
