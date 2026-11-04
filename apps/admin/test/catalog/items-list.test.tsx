import type { ItemBulkBody, ItemListItem } from '@altis/shared/api/catalog/items';
import { fireEvent, screen, waitFor, within } from '@testing-library/react';
import { afterEach, describe, expect, it, vi } from 'vitest';
import { adminMe, problem, startApp, type FakeHandler } from '../fake-api';
import { BRANCHES_UTARA_OUTSIDE, FIRST, PUSAT, ROOM_UTARA, SHELF_800, TK_REF, UTARA, catalogReads, itemDetail, itemsManagerAt, listItem, ulid } from './items-fixtures';

// Eksemplar, the list (Phase 2 Task 25; spec §13, §3.4): filters (branch, location, status, collection type) kept in
// the URL, a barcode scan field (and any scanner burst on the page) → `GET catalog/items/by-barcode?barcode=` (M2: a
// query, so a barcode with `/` travels as `%2F`) → the item's page, keyset paging, and the bulk change of the selected
// items (`POST branches/:branchId/items/bulk`, ≤ 500, one request per branch the user manages) whose refusals are
// listed.

afterEach(() => {
  vi.unstubAllGlobals();
  vi.restoreAllMocks();
});

const LIST_PATH = '/admin/catalog/items';
const SLASHED = ulid('01JZEKS', 7);

const ROWS: ItemListItem[] = [
  listItem({ id: ulid('01JZEKS', 1), barcode: 'B0000001' }),
  listItem({ id: ulid('01JZEKS', 2), barcode: 'B0000002', status: 'missing' }),
  listItem({ id: ulid('01JZEKS', 3), barcode: 'B0000003', locationPath: { roomId: 'x', roomName: 'Ruang Baca', areaName: null, shelfName: 'Rak 800', shelfHint: null } }),
];

/** The list answers `rows` on one page; `GET catalog/items/:id` answers the item (any id). */
function listRoutes(rows: ItemListItem[], extra: Record<string, FakeHandler> = {}): Record<string, FakeHandler> {
  return catalogReads({
    'GET catalog/items': () => ({ items: rows, nextCursor: null }),
    'GET catalog/items/by-barcode': (req) => (req.query.get('barcode') === 'B/01' ? itemDetail({ id: SLASHED, barcode: 'B/01' }) : problem(404, 'NOT_FOUND')),
    'GET catalog/items/:id': (req) => itemDetail({ id: req.params.id! }),
    ...extra,
  });
}

/** The URLs the SPA asked, as sent (before any decoding). */
const askedUrls = (fetchMock: { mock: { calls: unknown[][] } }): string[] => fetchMock.mock.calls.map((c) => String(c[0]));

describe('ItemsListScreen: the barcode scan', () => {
  it('typing a barcode with “/” and Enter opens its item; the barcode is sent as ?barcode=B%2F01', async () => {
    const { router, fetchMock } = startApp({ me: adminMe(), path: LIST_PATH, routes: listRoutes(ROWS) });
    const field = await screen.findByRole('textbox', { name: 'Pindai atau ketik barkod' }, FIRST);
    fireEvent.change(field, { target: { value: 'B/01' } });
    fireEvent.submit(field.closest('form')!);
    await waitFor(() => expect(router.state.location.pathname).toBe(`/admin/catalog/items/${SLASHED}`));
    expect(askedUrls(fetchMock)).toContain('/api/v1/catalog/items/by-barcode?barcode=B%2F01');
    expect(await screen.findByRole('heading', { level: 1, name: 'B/01' }, FIRST)).toBeTruthy();
  });

  it('a scanner burst anywhere on the page opens the item too', async () => {
    const { router, fetchMock } = startApp({ me: adminMe(), path: LIST_PATH, routes: listRoutes(ROWS) });
    await screen.findByText('B0000001', undefined, FIRST);
    for (const key of ['B', '/', '0', '1']) fireEvent.keyDown(document.body, { key });
    fireEvent.keyDown(document.body, { key: 'Enter' });
    await waitFor(() => expect(router.state.location.pathname).toBe(`/admin/catalog/items/${SLASHED}`));
    expect(askedUrls(fetchMock)).toContain('/api/v1/catalog/items/by-barcode?barcode=B%2F01');
  });

  it('a scanner burst of a 3-character barcode (the shortest one, §3.4) opens the item too', async () => {
    const SHORT = ulid('01JZEKS', 8);
    const { router, fetchMock } = startApp({
      me: adminMe(),
      path: LIST_PATH,
      routes: listRoutes(ROWS, {
        'GET catalog/items/by-barcode': (req) => (req.query.get('barcode') === 'A12' ? itemDetail({ id: SHORT, barcode: 'A12' }) : problem(404, 'NOT_FOUND')),
      }),
    });
    await screen.findByText('B0000001', undefined, FIRST);
    for (const key of ['A', '1', '2']) fireEvent.keyDown(document.body, { key });
    fireEvent.keyDown(document.body, { key: 'Enter' });
    await waitFor(() => expect(router.state.location.pathname).toBe(`/admin/catalog/items/${SHORT}`));
    expect(askedUrls(fetchMock)).toContain('/api/v1/catalog/items/by-barcode?barcode=A12');
  });

  it('an unknown barcode says so and stays on the list', async () => {
    const { router } = startApp({ me: adminMe(), path: LIST_PATH, routes: listRoutes(ROWS) });
    const field = await screen.findByRole('textbox', { name: 'Pindai atau ketik barkod' }, FIRST);
    fireEvent.change(field, { target: { value: 'B9999999' } });
    fireEvent.click(screen.getByRole('button', { name: 'Buka' }));
    expect(await screen.findByText('Tidak ada eksemplar dengan barkod B9999999.')).toBeTruthy();
    expect(router.state.location.pathname).toBe(LIST_PATH);
  });

  it('a text that cannot be a barcode is answered on the field (the server’s `length` check)', async () => {
    startApp({
      me: adminMe(),
      path: LIST_PATH,
      routes: listRoutes(ROWS, { 'GET catalog/items/by-barcode': () => problem(422, 'VALIDATION_FAILED', { errors: [{ path: 'barcode', code: 'length' }] }) }),
    });
    const field = await screen.findByRole('textbox', { name: 'Pindai atau ketik barkod' }, FIRST);
    fireEvent.change(field, { target: { value: 'B1' } });
    fireEvent.submit(field.closest('form')!);
    expect(await screen.findByText('Barkod harus 3–64 karakter.')).toBeTruthy();
    expect(field.getAttribute('aria-invalid')).toBe('true');
  });
});

describe('ItemsListScreen: the list and its filters', () => {
  it('shows the rows: barcode linked to the item, title, branch, location, call number, collection type and status', async () => {
    startApp({ me: adminMe(), path: LIST_PATH, routes: listRoutes(ROWS) });
    const link = await screen.findByRole('link', { name: 'B0000001' }, FIRST);
    expect(link.getAttribute('href')).toBe(`/admin/catalog/items/${ulid('01JZEKS', 1)}`);
    const row = link.closest('tr')!;
    expect(within(row).getByText('Laskar Pelangi')).toBeTruthy();
    expect(within(row).getByText('PUSAT')).toBeTruthy();
    expect(within(row).getByText('Umum')).toBeTruthy();
    expect(within(row).getByText('Tersedia')).toBeTruthy();
    expect(within(row).getByText('899.221 HIR l')).toBeTruthy();
    expect(within(screen.getByRole('link', { name: 'B0000002' }).closest('tr')!).getByText('Tidak ditemukan di rak')).toBeTruthy();
    expect(within(screen.getByRole('link', { name: 'B0000003' }).closest('tr')!).getByText('Ruang Baca › Rak 800')).toBeTruthy();
  });

  it('the branch filter offers every branch for reading; a choice goes to the query and the URL, and opens the location filter', async () => {
    const { router, requests } = startApp({ me: itemsManagerAt([PUSAT]), path: LIST_PATH, routes: listRoutes(ROWS) });
    await screen.findByText('B0000001', undefined, FIRST);
    const branch = screen.getByRole('combobox', { name: 'Cabang' }) as HTMLSelectElement;
    expect([...branch.options].map((o) => o.textContent)).toEqual(['Semua cabang', 'PUSAT · Perpustakaan Pusat', 'UTARA · Cabang Utara', 'LAMA · Cabang Lama (diarsipkan)']);
    const location = screen.getByRole('combobox', { name: 'Lokasi' }) as HTMLSelectElement;
    expect(location.disabled).toBe(true);
    fireEvent.change(branch, { target: { value: UTARA } });
    await waitFor(() => expect(router.state.location.search).toEqual({ branchId: UTARA }));
    await waitFor(() => expect(requests.some((r) => r.path === 'catalog/items' && r.query.get('branchId') === UTARA)).toBe(true));
    await waitFor(() => expect((screen.getByRole('combobox', { name: 'Lokasi' }) as HTMLSelectElement).disabled).toBe(false));
    fireEvent.change(screen.getByRole('combobox', { name: 'Lokasi' }), { target: { value: ROOM_UTARA } });
    fireEvent.change(screen.getByRole('combobox', { name: 'Status' }), { target: { value: 'repair' } });
    fireEvent.change(screen.getByRole('combobox', { name: 'Tipe koleksi' }), { target: { value: TK_REF } });
    await waitFor(() =>
      expect(router.state.location.search).toEqual({ branchId: UTARA, locationId: ROOM_UTARA, status: 'repair', collectionTypeId: TK_REF }),
    );
    const last = requests.filter((r) => r.path === 'catalog/items').at(-1)!;
    expect(Object.fromEntries(last.query)).toEqual({ branchId: UTARA, locationId: ROOM_UTARA, status: 'repair', collectionTypeId: TK_REF, limit: '50' });
  });

  it('opens with the filters of the URL; a value that is not valid there is ignored', async () => {
    const { requests } = startApp({ me: adminMe(), path: `${LIST_PATH}?branchId=${PUSAT}&status=dipinjam&locationId=nope`, routes: listRoutes(ROWS) });
    await screen.findByText('B0000001', undefined, FIRST);
    const asked = requests.filter((r) => r.path === 'catalog/items').at(-1)!;
    expect(Object.fromEntries(asked.query)).toEqual({ branchId: PUSAT, limit: '50' });
    expect((screen.getByRole('combobox', { name: 'Cabang' }) as HTMLSelectElement).value).toBe(PUSAT);
    expect((screen.getByRole('combobox', { name: 'Status' }) as HTMLSelectElement).value).toBe('');
  });

  it('“Muat lagi” reads the next page with the cursor', async () => {
    const { requests } = startApp({
      me: adminMe(),
      path: LIST_PATH,
      routes: listRoutes(ROWS, {
        'GET catalog/items': (req) =>
          req.query.get('cursor') === 'k.B0000003' ? { items: [listItem({ id: ulid('01JZEKS', 4), barcode: 'B0000004' })], nextCursor: null } : { items: ROWS, nextCursor: 'k.B0000003' },
      }),
    });
    await screen.findByText('B0000003', undefined, FIRST);
    fireEvent.click(screen.getByRole('button', { name: 'Muat lagi' }));
    expect(await screen.findByText('B0000004')).toBeTruthy();
    expect(requests.filter((r) => r.path === 'catalog/items').map((r) => r.query.get('cursor'))).toEqual([null, 'k.B0000003']);
    expect(screen.getByText('Semua eksemplar yang cocok sudah tampil.')).toBeTruthy();
  });
});

describe('ItemsListScreen: bulk change', () => {
  it('lists the refusals by barcode with their reason, and the count of the changed items', async () => {
    const sent: { path: string; body: unknown }[] = [];
    startApp({
      me: adminMe(),
      path: LIST_PATH,
      routes: listRoutes(ROWS, {
        'POST branches/:branchId/items/bulk': (req) => {
          sent.push({ path: req.path, body: req.body });
          return {
            updated: 1,
            refused: [
              { id: ulid('01JZEKS', 2), code: 'invalid_transition' },
              { id: ulid('01JZEKS', 3), code: 'not_found' },
            ],
          };
        },
      }),
    });
    await screen.findByText('B0000001', undefined, FIRST);
    fireEvent.click(screen.getByRole('checkbox', { name: 'Pilih semua eksemplar yang tampil' }));
    expect(screen.getByText('3 eksemplar dipilih')).toBeTruthy();
    fireEvent.click(screen.getByRole('button', { name: 'Ubah massal' }));
    const dialog = await screen.findByRole('dialog', { name: 'Ubah massal eksemplar' });
    fireEvent.change(within(dialog).getByRole('combobox', { name: 'Ubah status ke' }), { target: { value: 'repair' } });
    fireEvent.click(within(dialog).getByRole('button', { name: 'Terapkan' }));
    expect(await within(dialog).findByText('1 eksemplar diubah.')).toBeTruthy();
    const body: ItemBulkBody = { ids: ROWS.map((r) => r.id), set: { status: 'repair' } };
    expect(sent).toEqual([{ path: `branches/${PUSAT}/items/bulk`, body }]);
    const refused = within(dialog).getByRole('list', { name: 'Tidak diubah (2)' });
    const rows = within(refused).getAllByRole('listitem');
    expect(rows.map((r) => r.textContent)).toEqual([
      'B0000002 — Status eksemplar ini tidak dapat diubah langsung ke status tersebut.',
      'B0000003 — Eksemplar tidak ditemukan di cabangnya.',
    ]);
  });

  it('sends one request per managed branch, leaves out the items of other branches and says so', async () => {
    const rows = [
      listItem({ id: ulid('01JZEKS', 1), barcode: 'B0000001' }),
      listItem({ id: ulid('01JZEKS', 2), barcode: 'U0000001', branch: { id: UTARA, code: 'UTARA' } }),
      listItem({ id: ulid('01JZEKS', 3), barcode: 'B0000003' }),
    ];
    const sent: { path: string; body: unknown }[] = [];
    startApp({
      me: itemsManagerAt([PUSAT]),
      path: LIST_PATH,
      routes: listRoutes(rows, {
        'POST branches/:branchId/items/bulk': (req) => {
          sent.push({ path: req.path, body: req.body });
          return { updated: (req.body as ItemBulkBody).ids.length, refused: [] };
        },
      }),
    });
    await screen.findByText('B0000001', undefined, FIRST);
    fireEvent.click(screen.getByRole('checkbox', { name: 'Pilih semua eksemplar yang tampil' }));
    fireEvent.click(screen.getByRole('button', { name: 'Ubah massal' }));
    const dialog = await screen.findByRole('dialog', { name: 'Ubah massal eksemplar' });
    expect(within(dialog).getByText('1 eksemplar terpilih ada di cabang yang tidak Anda kelola dan tidak ikut diubah.')).toBeTruthy();
    // One branch: the location may change, to a location of that branch.
    const location = within(dialog).getByRole('combobox', { name: 'Pindahkan ke lokasi' }) as HTMLSelectElement;
    await waitFor(() =>
      expect([...location.options].map((o) => o.textContent)).toEqual(['Tidak diubah', 'Tanpa lokasi', 'Ruang Baca', 'Ruang Baca › Rak 800', 'Ruang Baca › Rak 808']),
    );
    fireEvent.change(location, { target: { value: SHELF_800 } });
    fireEvent.click(within(dialog).getByRole('button', { name: 'Terapkan' }));
    expect(await within(dialog).findByText('2 eksemplar diubah.')).toBeTruthy();
    expect(sent).toEqual([{ path: `branches/${PUSAT}/items/bulk`, body: { ids: [ulid('01JZEKS', 1), ulid('01JZEKS', 3)], set: { locationId: SHELF_800 } } }]);
  });

  it('items of two managed branches: two requests, and no location change offered', async () => {
    const rows = [listItem({ id: ulid('01JZEKS', 1), barcode: 'B0000001' }), listItem({ id: ulid('01JZEKS', 2), barcode: 'U0000001', branch: { id: UTARA, code: 'UTARA' } })];
    const sent: string[] = [];
    startApp({
      me: adminMe(),
      path: LIST_PATH,
      routes: listRoutes(rows, {
        'POST branches/:branchId/items/bulk': (req) => {
          sent.push(req.path);
          return { updated: 1, refused: [] };
        },
      }),
    });
    await screen.findByText('B0000001', undefined, FIRST);
    fireEvent.click(screen.getByRole('checkbox', { name: 'Pilih B0000001' }));
    fireEvent.click(screen.getByRole('checkbox', { name: 'Pilih U0000001' }));
    fireEvent.click(screen.getByRole('button', { name: 'Ubah massal' }));
    const dialog = await screen.findByRole('dialog', { name: 'Ubah massal eksemplar' });
    expect((within(dialog).getByRole('combobox', { name: 'Pindahkan ke lokasi' }) as HTMLSelectElement).disabled).toBe(true);
    expect(within(dialog).getByText('Pindah lokasi hanya dapat dilakukan untuk eksemplar dari satu cabang.')).toBeTruthy();
    fireEvent.change(within(dialog).getByRole('combobox', { name: 'Ubah tipe koleksi ke' }), { target: { value: TK_REF } });
    fireEvent.click(within(dialog).getByRole('button', { name: 'Terapkan' }));
    expect(await within(dialog).findByText('2 eksemplar diubah.')).toBeTruthy();
    expect(sent).toEqual([`branches/${PUSAT}/items/bulk`, `branches/${UTARA}/items/bulk`]);
  });

  it('L13: the items of a branch the server marks inactive are left out and the dialog says so', async () => {
    const rows = [listItem({ id: ulid('01JZEKS', 1), barcode: 'B0000001' }), listItem({ id: ulid('01JZEKS', 2), barcode: 'U0000001', branch: { id: UTARA, code: 'UTARA' } })];
    const sent: string[] = [];
    startApp({
      me: adminMe(),
      path: LIST_PATH,
      routes: listRoutes(rows, {
        'GET branches': () => ({ items: BRANCHES_UTARA_OUTSIDE }),
        'POST branches/:branchId/items/bulk': (req) => {
          sent.push(req.path);
          return { updated: 1, refused: [] };
        },
      }),
    });
    await screen.findByText('B0000001', undefined, FIRST);
    fireEvent.click(screen.getByRole('checkbox', { name: 'Pilih B0000001' }));
    fireEvent.click(screen.getByRole('checkbox', { name: 'Pilih U0000001' }));
    fireEvent.click(screen.getByRole('button', { name: 'Ubah massal' }));
    const dialog = await screen.findByRole('dialog', { name: 'Ubah massal eksemplar' });
    expect(await within(dialog).findByText('1 eksemplar terpilih ada di cabang yang tidak aktif dan tidak ikut diubah.')).toBeTruthy();
    fireEvent.change(within(dialog).getByRole('combobox', { name: 'Ubah tipe koleksi ke' }), { target: { value: TK_REF } });
    fireEvent.click(within(dialog).getByRole('button', { name: 'Terapkan' }));
    expect(await within(dialog).findByText('1 eksemplar diubah.')).toBeTruthy();
    expect(sent).toEqual([`branches/${PUSAT}/items/bulk`]);
  });

  it('L13: a branch whose request is refused does not stop the next branch; the refused branch is listed', async () => {
    const rows = [listItem({ id: ulid('01JZEKS', 1), barcode: 'B0000001' }), listItem({ id: ulid('01JZEKS', 2), barcode: 'U0000001', branch: { id: UTARA, code: 'UTARA' } })];
    const sent: string[] = [];
    startApp({
      me: adminMe(),
      path: LIST_PATH,
      routes: listRoutes(rows, {
        'POST branches/:branchId/items/bulk': (req) => {
          sent.push(req.path);
          return req.params['branchId'] === PUSAT ? problem(403, 'AUTHZ_DENIED') : { updated: 1, refused: [] };
        },
      }),
    });
    await screen.findByText('B0000001', undefined, FIRST);
    fireEvent.click(screen.getByRole('checkbox', { name: 'Pilih B0000001' }));
    fireEvent.click(screen.getByRole('checkbox', { name: 'Pilih U0000001' }));
    fireEvent.click(screen.getByRole('button', { name: 'Ubah massal' }));
    const dialog = await screen.findByRole('dialog', { name: 'Ubah massal eksemplar' });
    fireEvent.change(within(dialog).getByRole('combobox', { name: 'Ubah tipe koleksi ke' }), { target: { value: TK_REF } });
    fireEvent.click(within(dialog).getByRole('button', { name: 'Terapkan' }));
    expect(await within(dialog).findByText('1 eksemplar diubah.')).toBeTruthy();
    expect(sent).toEqual([`branches/${PUSAT}/items/bulk`, `branches/${UTARA}/items/bulk`]);
    expect(within(dialog).getByText(/^Eksemplar cabang PUSAT tidak diubah:/)).toBeTruthy();
  });

  it('nothing chosen to change is refused before anything is sent', async () => {
    const { writes } = startApp({ me: adminMe(), path: LIST_PATH, routes: listRoutes(ROWS) });
    await screen.findByText('B0000001', undefined, FIRST);
    fireEvent.click(screen.getByRole('checkbox', { name: 'Pilih B0000001' }));
    fireEvent.click(screen.getByRole('button', { name: 'Ubah massal' }));
    const dialog = await screen.findByRole('dialog', { name: 'Ubah massal eksemplar' });
    fireEvent.click(within(dialog).getByRole('button', { name: 'Terapkan' }));
    expect(await within(dialog).findByText('Pilih sedikitnya satu perubahan.')).toBeTruthy();
    expect(writes()).toEqual([]);
  });

  it('a reader who manages no branch can select (for the print queue) but has no bulk change', async () => {
    startApp({ me: itemsManagerAt([]), path: LIST_PATH, routes: listRoutes(ROWS) });
    await screen.findByText('B0000001', undefined, FIRST);
    fireEvent.click(screen.getByRole('checkbox', { name: 'Pilih B0000001' }));
    expect(screen.getByText('1 eksemplar dipilih')).toBeTruthy();
    expect(screen.queryByRole('button', { name: 'Ubah massal' })).toBeNull();
  });

  // 501 rows render slowly on a busy machine: a longer limit than the default 5 s.
  it('more than 500 selected items are refused for a bulk change', async () => {
    const many = Array.from({ length: 501 }, (_, i) => listItem({ id: ulid('01JZEKS', i + 1), barcode: `B${String(i + 1).padStart(7, '0')}` }));
    startApp({ me: adminMe(), path: LIST_PATH, routes: listRoutes(many) });
    await screen.findByText('B0000501', undefined, FIRST);
    fireEvent.click(screen.getByRole('checkbox', { name: 'Pilih semua eksemplar yang tampil' }));
    expect(screen.getByText('501 eksemplar dipilih')).toBeTruthy();
    expect((screen.getByRole('button', { name: 'Ubah massal' }) as HTMLButtonElement).disabled).toBe(true);
    expect(screen.getByText('Ubah massal paling banyak 500 eksemplar sekaligus.')).toBeTruthy();
  }, 20_000);
});
