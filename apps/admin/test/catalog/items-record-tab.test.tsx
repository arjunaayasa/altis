import type { MeResponse } from '@altis/shared/api/auth';
import type { ItemBatchBody, ItemCreateBody, ItemListItem } from '@altis/shared/api/catalog/items';
import { QueryClient, QueryClientProvider } from '@tanstack/react-query';
import { RouterProvider, createMemoryHistory, createRootRoute, createRouter } from '@tanstack/react-router';
import { fireEvent, render, screen, waitFor, within } from '@testing-library/react';
import { afterEach, describe, expect, it, vi } from 'vitest';
import { RecordItemsTab, type RecordItemsTabProps } from '@/components/catalog/record-items-tab';
import { ME_KEY } from '@/lib/me';
import { adminMe, json, problem, type FakeHandler, type FakeRequest } from '../fake-api';
import { BRANCHES_UTARA_OUTSIDE, COLLECTION_TYPES, FIRST, ITEM_CUSTOM_FIELDS, PUSAT, RECORD, SHELF_800, TK_REF, TK_UMUM, UTARA, catalogReads, itemsManagerAt, listItem, ulid } from './items-fixtures';

// The items tab of the record editor (Phase 2 Task 25; spec §13 "tab eksemplar"): the record's items
// (`GET catalog/items?recordId=`), quick add (`POST branches/:branchId/items`) and the batch dialog numbered by a
// barcode pattern of `GET catalog/config` (`POST branches/:branchId/items/batch`, ≤ 100, showing the created and the
// skipped barcodes). Writes are offered only at the branches where the user manages items (`holdsAt`).

afterEach(() => {
  vi.unstubAllGlobals();
  vi.restoreAllMocks();
});

const ROWS: ItemListItem[] = [
  listItem({ id: ulid('01JZEKS', 1), barcode: 'B0000001' }),
  listItem({ id: ulid('01JZEKS', 2), barcode: 'U0000001', branch: { id: UTARA, code: 'UTARA' }, status: 'repair' }),
];

/** A fake `/api/v1` (`:name` matches one segment); unknown routes answer 404. */
function stubApi(routes: Record<string, FakeHandler>) {
  const requests: FakeRequest[] = [];
  vi.stubGlobal(
    'fetch',
    vi.fn<typeof fetch>(async (input, init) => {
      const url = new URL(String(input), 'https://altis.test');
      const method = init?.method ?? 'GET';
      const path = url.pathname.replace(/^\/api\/v1\//, '');
      const body = typeof init?.body === 'string' ? (JSON.parse(init.body) as unknown) : undefined;
      for (const [key, handler] of Object.entries(routes)) {
        const [m, pattern] = key.split(' ') as [string, string];
        const want = pattern.split('/');
        const got = path.split('/');
        if (m !== method || want.length !== got.length) continue;
        const params: Record<string, string> = {};
        if (!want.every((w, i) => (w.startsWith(':') ? ((params[w.slice(1)] = decodeURIComponent(got[i]!)), true) : w === got[i]))) continue;
        const req: FakeRequest = { method, path, params, query: url.searchParams, body };
        requests.push(req);
        const answer = await handler(req);
        return answer instanceof Response ? answer : json(answer);
      }
      requests.push({ method, path, params: {}, query: url.searchParams, body });
      return problem(404, 'NOT_FOUND');
    }),
  );
  return { requests, writes: () => requests.filter((r) => r.method !== 'GET').map((r) => `${r.method} ${r.path}`) };
}

/** Renders the tab for `me` inside a router (its barcodes link to the item pages). */
function renderTab(me: MeResponse, routes: Record<string, FakeHandler> = {}, props: Partial<RecordItemsTabProps> = {}) {
  const api = stubApi(catalogReads({ 'GET catalog/items': () => ({ items: ROWS, nextCursor: null }), ...routes }));
  const queryClient = new QueryClient({ defaultOptions: { queries: { retry: false }, mutations: { retry: false } } });
  queryClient.setQueryData(ME_KEY, me);
  const root = createRootRoute({ component: () => <RecordItemsTab recordId={RECORD} {...props} /> });
  const router = createRouter({ routeTree: root, history: createMemoryHistory({ initialEntries: ['/'] }) });
  render(
    <QueryClientProvider client={queryClient}>
      <RouterProvider router={router} />
    </QueryClientProvider>,
  );
  return { ...api, queryClient };
}

const optionTexts = (select: HTMLElement): string[] => [...(select as HTMLSelectElement).options].map((o) => o.textContent ?? '');

describe('RecordItemsTab', () => {
  it('lists the record’s items with a link to each', async () => {
    const { requests } = renderTab(adminMe());
    const link = await screen.findByRole('link', { name: 'B0000001' }, FIRST);
    expect(link.getAttribute('href')).toBe(`/admin/catalog/items/${ulid('01JZEKS', 1)}`);
    const other = screen.getByRole('link', { name: 'U0000001' }).closest('tr')!;
    expect(within(other).getByText('UTARA')).toBeTruthy();
    expect(within(other).getByText('Perbaikan')).toBeTruthy();
    const asked = requests.find((r) => r.path === 'catalog/items')!;
    expect(asked.query.get('recordId')).toBe(RECORD);
  });

  it('the branch selects hide the branches without catalog.items.manage (quick add and batch)', async () => {
    renderTab(itemsManagerAt([PUSAT]));
    await screen.findByText('B0000001', undefined, FIRST);
    const quick = screen.getByRole('form', { name: 'Tambah eksemplar' });
    expect(optionTexts(within(quick).getByRole('combobox', { name: 'Cabang' }))).toEqual(['PUSAT · Perpustakaan Pusat']);
    fireEvent.click(screen.getByRole('button', { name: 'Tambah banyak dengan pola barkod' }));
    const dialog = await screen.findByRole('dialog', { name: 'Tambah eksemplar dengan pola barkod' });
    expect(optionTexts(within(dialog).getByRole('combobox', { name: 'Cabang' }))).toEqual(['PUSAT · Perpustakaan Pusat']);
  });

  it('an admin may add at every live branch (not the archived one)', async () => {
    renderTab(adminMe());
    await screen.findByText('B0000001', undefined, FIRST);
    const quick = screen.getByRole('form', { name: 'Tambah eksemplar' });
    expect(optionTexts(within(quick).getByRole('combobox', { name: 'Cabang' }))).toEqual(['PUSAT · Perpustakaan Pusat', 'UTARA · Cabang Utara']);
  });

  it('L13: a branch the server marks inactive is offered neither in quick add nor in the batch dialog', async () => {
    renderTab(adminMe(), { 'GET branches': () => ({ items: BRANCHES_UTARA_OUTSIDE }) });
    await screen.findByText('B0000001', undefined, FIRST);
    const quick = screen.getByRole('form', { name: 'Tambah eksemplar' });
    await waitFor(() => expect(optionTexts(within(quick).getByRole('combobox', { name: 'Cabang' }))).toEqual(['PUSAT · Perpustakaan Pusat']));
    fireEvent.click(screen.getByRole('button', { name: 'Tambah banyak dengan pola barkod' }));
    const dialog = await screen.findByRole('dialog', { name: 'Tambah eksemplar dengan pola barkod' });
    expect(optionTexts(within(dialog).getByRole('combobox', { name: 'Cabang' }))).toEqual(['PUSAT · Perpustakaan Pusat']);
  });

  it('a reader who manages no branch only sees the list', async () => {
    renderTab(itemsManagerAt([]));
    await screen.findByText('B0000001', undefined, FIRST);
    expect(screen.queryByRole('form', { name: 'Tambah eksemplar' })).toBeNull();
    expect(screen.queryByRole('button', { name: 'Tambah banyak dengan pola barkod' })).toBeNull();
  });

  it('quick add posts the item at the chosen branch, says so, and reads the list again', async () => {
    const sent: unknown[] = [];
    const { requests } = renderTab(adminMe(), {
      'POST branches/:branchId/items': (req) => {
        sent.push({ path: req.path, body: req.body });
        return new Response(JSON.stringify({ id: ulid('01JZEKS', 9), version: 0 }), { status: 201, headers: { 'Content-Type': 'application/json' } });
      },
    });
    await screen.findByText('B0000001', undefined, FIRST);
    const quick = screen.getByRole('form', { name: 'Tambah eksemplar' });
    // The default collection type of the catalog config is chosen already.
    await waitFor(() => expect((within(quick).getByRole('combobox', { name: 'Tipe koleksi' }) as HTMLSelectElement).value).toBe(TK_UMUM));
    fireEvent.change(within(quick).getByRole('combobox', { name: 'Cabang' }), { target: { value: PUSAT } });
    await waitFor(() => expect(optionTexts(within(quick).getByRole('combobox', { name: 'Lokasi' }))).toContain('Ruang Baca › Rak 800'));
    fireEvent.change(within(quick).getByRole('combobox', { name: 'Lokasi' }), { target: { value: SHELF_800 } });
    const barcode = within(quick).getByRole('textbox', { name: 'Barkod' });
    fireEvent.change(barcode, { target: { value: ' b0000009 ' } });
    const listsBefore = requests.filter((r) => r.path === 'catalog/items').length;
    fireEvent.click(within(quick).getByRole('button', { name: 'Tambahkan' }));
    expect(await screen.findByText('Eksemplar b0000009 ditambahkan.')).toBeTruthy();
    const body: ItemCreateBody = { recordId: RECORD, barcode: ' b0000009 ', collectionTypeId: TK_UMUM, status: 'available', partsTotal: 1, locationId: SHELF_800 };
    expect(sent).toEqual([{ path: `branches/${PUSAT}/items`, body }]);
    await waitFor(() => expect(requests.filter((r) => r.path === 'catalog/items').length).toBeGreaterThan(listsBefore));
    // Ready for the next one: the barcode is empty, the branch and the location stay.
    expect((barcode as HTMLInputElement).value).toBe('');
    expect((within(quick).getByRole('combobox', { name: 'Lokasi' }) as HTMLSelectElement).value).toBe(SHELF_800);
  });

  it('an added item makes the record’s reads stale (the editor’s item count) as well as the items lists', async () => {
    const { queryClient } = renderTab(adminMe(), {
      'POST branches/:branchId/items': () => new Response(JSON.stringify({ id: ulid('01JZEKS', 9), version: 0 }), { status: 201, headers: { 'Content-Type': 'application/json' } }),
    });
    const detailKey = ['catalog', 'records', 'detail', RECORD];
    const listKey = ['catalog', 'records', 'list', {}];
    queryClient.setQueryData(detailKey, { id: RECORD });
    queryClient.setQueryData(listKey, { items: [] });
    await screen.findByText('B0000001', undefined, FIRST);
    const quick = screen.getByRole('form', { name: 'Tambah eksemplar' });
    await waitFor(() => expect((within(quick).getByRole('combobox', { name: 'Tipe koleksi' }) as HTMLSelectElement).value).toBe(TK_UMUM));
    fireEvent.change(within(quick).getByRole('textbox', { name: 'Barkod' }), { target: { value: 'B0000009' } });
    fireEvent.keyDown(within(quick).getByRole('textbox', { name: 'Barkod' }), { key: 'Enter' });
    expect(await screen.findByText('Eksemplar B0000009 ditambahkan.')).toBeTruthy();
    await waitFor(() => expect(queryClient.getQueryState(detailKey)?.isInvalidated).toBe(true));
    expect(queryClient.getQueryState(listKey)?.isInvalidated).toBe(true);
  });

  it('quick add puts a taken barcode on the barcode field', async () => {
    renderTab(adminMe(), {
      'POST branches/:branchId/items': () => problem(422, 'VALIDATION_FAILED', { errors: [{ path: 'barcode', code: 'taken' }] }),
    });
    await screen.findByText('B0000001', undefined, FIRST);
    const quick = screen.getByRole('form', { name: 'Tambah eksemplar' });
    await waitFor(() => expect((within(quick).getByRole('combobox', { name: 'Tipe koleksi' }) as HTMLSelectElement).value).toBe(TK_UMUM));
    fireEvent.change(within(quick).getByRole('textbox', { name: 'Barkod' }), { target: { value: 'B0000001' } });
    fireEvent.click(within(quick).getByRole('button', { name: 'Tambahkan' }));
    expect(await within(quick).findByText('Barkod ini sudah dipakai eksemplar lain.')).toBeTruthy();
  });

  it('an archived record is said as such (the record is no field of the quick add)', async () => {
    renderTab(adminMe(), {
      'POST branches/:branchId/items': () => problem(422, 'VALIDATION_FAILED', { errors: [{ path: 'recordId', code: 'archived' }] }),
    });
    await screen.findByText('B0000001', undefined, FIRST);
    const quick = screen.getByRole('form', { name: 'Tambah eksemplar' });
    await waitFor(() => expect((within(quick).getByRole('combobox', { name: 'Tipe koleksi' }) as HTMLSelectElement).value).toBe(TK_UMUM));
    fireEvent.change(within(quick).getByRole('textbox', { name: 'Barkod' }), { target: { value: 'B0000009' } });
    fireEvent.click(within(quick).getByRole('button', { name: 'Tambahkan' }));
    expect(await within(quick).findByText('Cantuman ini sudah diarsipkan. Pulihkan cantumannya dulu untuk menambah eksemplar.')).toBeTruthy();
  });
});

// C22: the material type's template default (`template.defaults.collectionTypeId`, spec §3.8, "Tipe koleksi bawaan
// eksemplar") is what new items start with, while it names a live collection type; else the catalogue's default.
describe('RecordItemsTab: the template default collection type (C22)', () => {
  const ARCHIVED_TYPE = ulid('01JZTK', 3);

  it('quick add and the batch dialog start with the template default, not the catalogue default', async () => {
    const sent: unknown[] = [];
    renderTab(
      adminMe(),
      {
        'POST branches/:branchId/items': (req) => {
          sent.push(req.body);
          return new Response(JSON.stringify({ id: ulid('01JZEKS', 9), version: 0 }), { status: 201, headers: { 'Content-Type': 'application/json' } });
        },
      },
      { defaultCollectionTypeId: TK_REF },
    );
    await screen.findByText('B0000001', undefined, FIRST);
    const quick = screen.getByRole('form', { name: 'Tambah eksemplar' });
    await waitFor(() => expect((within(quick).getByRole('combobox', { name: 'Tipe koleksi' }) as HTMLSelectElement).value).toBe(TK_REF));
    fireEvent.change(within(quick).getByRole('textbox', { name: 'Barkod' }), { target: { value: 'R00001X' } });
    fireEvent.click(within(quick).getByRole('button', { name: 'Tambahkan' }));
    await waitFor(() => expect(sent).toHaveLength(1));
    expect(sent[0]).toMatchObject({ collectionTypeId: TK_REF });
    fireEvent.click(screen.getByRole('button', { name: 'Tambah banyak dengan pola barkod' }));
    const dialog = await screen.findByRole('dialog', { name: 'Tambah eksemplar dengan pola barkod' });
    expect((within(dialog).getByRole('combobox', { name: 'Tipe koleksi' }) as HTMLSelectElement).value).toBe(TK_REF);
  });

  it('a template default that is archived or gone falls back to the catalogue default', async () => {
    renderTab(
      adminMe(),
      {
        'GET catalog/collection-types': () => ({
          items: [...COLLECTION_TYPES, { ...COLLECTION_TYPES[1]!, id: ARCHIVED_TYPE, code: 'LAMA', nameId: 'Lama', archived: true }],
        }),
      },
      { defaultCollectionTypeId: ARCHIVED_TYPE },
    );
    await screen.findByText('B0000001', undefined, FIRST);
    const quick = screen.getByRole('form', { name: 'Tambah eksemplar' });
    await waitFor(() => expect((within(quick).getByRole('combobox', { name: 'Tipe koleksi' }) as HTMLSelectElement).value).toBe(TK_UMUM));
  });
});

// The item custom fields (`GET catalog/custom-fields?entity=items`, spec §3.7): quick add and the batch dialog offer the
// live ones, ask for a required one before sending, and send the values as `custom` (the batch in its `template`).
describe('RecordItemsTab: item custom fields', () => {
  const created = () => new Response(JSON.stringify({ id: ulid('01JZEKS', 9), version: 0 }), { status: 201, headers: { 'Content-Type': 'application/json' } });

  it('quick add asks for a required custom field before sending, then sends the values as custom', async () => {
    const sent: unknown[] = [];
    const { requests } = renderTab(adminMe(), {
      'GET catalog/custom-fields': () => ({ items: ITEM_CUSTOM_FIELDS }),
      'POST branches/:branchId/items': (req) => {
        sent.push(req.body);
        return created();
      },
    });
    await screen.findByText('B0000001', undefined, FIRST);
    const quick = screen.getByRole('form', { name: 'Tambah eksemplar' });
    const source = await within(quick).findByRole('textbox', { name: 'Sumber dana (wajib)' });
    expect(within(quick).queryByRole('textbox', { name: 'Ruas lama' })).toBeNull();
    expect(requests.find((r) => r.path === 'catalog/custom-fields')?.query.get('entity')).toBe('items');
    await waitFor(() => expect((within(quick).getByRole('combobox', { name: 'Tipe koleksi' }) as HTMLSelectElement).value).toBe(TK_UMUM));
    fireEvent.change(within(quick).getByRole('textbox', { name: 'Barkod' }), { target: { value: 'B0000009' } });
    fireEvent.click(within(quick).getByRole('button', { name: 'Tambahkan' }));
    await waitFor(() => expect(source.getAttribute('aria-invalid')).toBe('true'));
    expect(within(quick).getByText('Wajib diisi.')).toBeTruthy();
    expect(sent).toEqual([]);

    fireEvent.change(source, { target: { value: ' Hibah ' } });
    fireEvent.change(within(quick).getByRole('combobox', { name: 'Hadiah' }), { target: { value: 'true' } });
    fireEvent.click(within(quick).getByRole('button', { name: 'Tambahkan' }));
    expect(await screen.findByText('Eksemplar B0000009 ditambahkan.')).toBeTruthy();
    expect(sent).toEqual([
      { recordId: RECORD, barcode: 'B0000009', collectionTypeId: TK_UMUM, status: 'available', partsTotal: 1, custom: { 'dana.sumber': 'Hibah', hadiah: true } },
    ]);
  });

  it('a custom field error of the server lands on its field (a code holding a dot)', async () => {
    renderTab(adminMe(), {
      'GET catalog/custom-fields': () => ({ items: ITEM_CUSTOM_FIELDS.filter((d) => !d.required) }),
      'POST branches/:branchId/items': () => problem(422, 'VALIDATION_FAILED', { errors: [{ path: 'custom.kondisi', code: 'invalid' }] }),
    });
    await screen.findByText('B0000001', undefined, FIRST);
    const quick = screen.getByRole('form', { name: 'Tambah eksemplar' });
    const kondisi = await within(quick).findByRole('combobox', { name: 'Kondisi' });
    await waitFor(() => expect((within(quick).getByRole('combobox', { name: 'Tipe koleksi' }) as HTMLSelectElement).value).toBe(TK_UMUM));
    fireEvent.change(within(quick).getByRole('textbox', { name: 'Barkod' }), { target: { value: 'B0000009' } });
    fireEvent.change(kondisi, { target: { value: 'baik' } });
    fireEvent.click(within(quick).getByRole('button', { name: 'Tambahkan' }));
    await waitFor(() => expect(kondisi.getAttribute('aria-invalid')).toBe('true'));
  });

  it('the batch dialog sends the custom values in its template, and puts template.custom.<code> on its field', async () => {
    const sent: unknown[] = [];
    let calls = 0;
    renderTab(adminMe(), {
      'GET catalog/custom-fields': () => ({ items: ITEM_CUSTOM_FIELDS }),
      'POST branches/:branchId/items/batch': (req) => {
        sent.push(req.body);
        calls += 1;
        if (calls === 1) return problem(422, 'VALIDATION_FAILED', { errors: [{ path: 'template.custom.dana.sumber', code: 'too_big' }] });
        return new Response(JSON.stringify({ created: [{ id: ulid('01JZEKS', 6), barcode: 'B0000006' }], skipped: [] }), {
          status: 201,
          headers: { 'Content-Type': 'application/json' },
        });
      },
    });
    await screen.findByText('B0000001', undefined, FIRST);
    fireEvent.click(screen.getByRole('button', { name: 'Tambah banyak dengan pola barkod' }));
    const dialog = await screen.findByRole('dialog', { name: 'Tambah eksemplar dengan pola barkod' });
    const source = await within(dialog).findByRole('textbox', { name: 'Sumber dana (wajib)' });
    fireEvent.click(within(dialog).getByRole('button', { name: 'Buat eksemplar' }));
    await waitFor(() => expect(source.getAttribute('aria-invalid')).toBe('true'));
    expect(sent).toEqual([]);
    fireEvent.change(source, { target: { value: 'APBD' } });
    fireEvent.click(within(dialog).getByRole('button', { name: 'Buat eksemplar' }));
    await waitFor(() => expect(sent).toHaveLength(1));
    expect(sent[0]).toMatchObject({ template: { collectionTypeId: TK_UMUM, status: 'available', partsTotal: 1, custom: { 'dana.sumber': 'APBD' } } });
    await waitFor(() => expect(source.getAttribute('aria-invalid')).toBe('true'));
    fireEvent.change(source, { target: { value: 'APBN' } });
    fireEvent.click(within(dialog).getByRole('button', { name: 'Buat eksemplar' }));
    expect(await within(dialog).findByRole('list', { name: 'Dibuat (1)' })).toBeTruthy();
  });
});

describe('BatchDialog', () => {
  it('an archived record is said as such in the batch dialog too', async () => {
    renderTab(adminMe(), {
      'POST branches/:branchId/items/batch': () => problem(422, 'VALIDATION_FAILED', { errors: [{ path: 'recordId', code: 'archived' }] }),
    });
    await screen.findByText('B0000001', undefined, FIRST);
    fireEvent.click(screen.getByRole('button', { name: 'Tambah banyak dengan pola barkod' }));
    const dialog = await screen.findByRole('dialog', { name: 'Tambah eksemplar dengan pola barkod' });
    fireEvent.click(within(dialog).getByRole('button', { name: 'Buat eksemplar' }));
    expect(await within(dialog).findByText('Cantuman ini sudah diarsipkan. Pulihkan cantumannya dulu untuk menambah eksemplar.')).toBeTruthy();
  });

  it('numbers by the chosen pattern and shows the created and the skipped barcodes', async () => {
    const sent: unknown[] = [];
    renderTab(adminMe(), {
      'POST branches/:branchId/items/batch': (req) => {
        sent.push({ path: req.path, body: req.body });
        return new Response(
          JSON.stringify({
            created: [
              { id: ulid('01JZEKS', 6), barcode: 'R00006X' },
              { id: ulid('01JZEKS', 8), barcode: 'R00008X' },
              { id: ulid('01JZEKS', 9), barcode: 'R00009X' },
            ],
            skipped: [{ barcode: 'R00007X', reason: 'taken' }],
          }),
          { status: 201, headers: { 'Content-Type': 'application/json' } },
        );
      },
    });
    await screen.findByText('B0000001', undefined, FIRST);
    fireEvent.click(screen.getByRole('button', { name: 'Tambah banyak dengan pola barkod' }));
    const dialog = await screen.findByRole('dialog', { name: 'Tambah eksemplar dengan pola barkod' });
    const pattern = within(dialog).getByRole('combobox', { name: 'Pola barkod' });
    expect(optionTexts(pattern)).toEqual(['Umum (B0000001)', 'Referensi (R00001X)']);
    fireEvent.change(pattern, { target: { value: 'ref' } });
    fireEvent.change(within(dialog).getByRole('combobox', { name: 'Cabang' }), { target: { value: UTARA } });
    fireEvent.change(within(dialog).getByRole('spinbutton', { name: 'Jumlah eksemplar' }), { target: { value: '3' } });
    fireEvent.change(within(dialog).getByRole('combobox', { name: 'Tipe koleksi' }), { target: { value: TK_REF } });
    fireEvent.click(within(dialog).getByRole('button', { name: 'Buat eksemplar' }));
    const created = await within(dialog).findByRole('list', { name: 'Dibuat (3)' });
    expect(within(created).getAllByRole('listitem').map((li) => li.textContent)).toEqual(['R00006X', 'R00008X', 'R00009X']);
    const skipped = within(dialog).getByRole('list', { name: 'Dilewati karena sudah dipakai (1)' });
    expect(within(skipped).getAllByRole('listitem').map((li) => li.textContent)).toEqual(['R00007X']);
    const body: ItemBatchBody = { recordId: RECORD, count: 3, patternId: 'ref', template: { collectionTypeId: TK_REF, status: 'available', partsTotal: 1 } };
    expect(sent).toEqual([{ path: `branches/${UTARA}/items/batch`, body }]);
  });

  it('sends an idempotency key, the same one when the same batch is sent again after a lost answer', async () => {
    const keys: (string | null)[] = [];
    let calls = 0;
    renderTab(adminMe(), {
      'POST branches/:branchId/items/batch': () => {
        calls += 1;
        if (calls === 1) throw new TypeError('Failed to fetch');
        return new Response(JSON.stringify({ created: [{ id: ulid('01JZEKS', 6), barcode: 'B0000006' }], skipped: [] }), {
          status: 201,
          headers: { 'Content-Type': 'application/json' },
        });
      },
    });
    const fetchMock = vi.mocked(fetch);
    await screen.findByText('B0000001', undefined, FIRST);
    fireEvent.click(screen.getByRole('button', { name: 'Tambah banyak dengan pola barkod' }));
    const dialog = await screen.findByRole('dialog', { name: 'Tambah eksemplar dengan pola barkod' });
    fireEvent.change(within(dialog).getByRole('spinbutton', { name: 'Jumlah eksemplar' }), { target: { value: '1' } });
    fireEvent.click(within(dialog).getByRole('button', { name: 'Buat eksemplar' }));
    expect(await within(dialog).findByText('Server tidak dapat dihubungi. Periksa koneksi Anda, lalu coba lagi.')).toBeTruthy();
    fireEvent.click(within(dialog).getByRole('button', { name: 'Buat eksemplar' }));
    expect(await within(dialog).findByRole('list', { name: 'Dibuat (1)' })).toBeTruthy();
    for (const [input, init] of fetchMock.mock.calls) {
      if (String(input).endsWith('/items/batch')) keys.push(new Headers(init?.headers).get('Idempotency-Key'));
    }
    expect(keys).toHaveLength(2);
    expect(keys[0]).toMatch(/^[A-Za-z0-9._:-]{8,64}$/);
    expect(keys[1]).toBe(keys[0]);
  });

  it('an exhausted pattern is said on the pattern field', async () => {
    renderTab(adminMe(), {
      'POST branches/:branchId/items/batch': () => problem(422, 'VALIDATION_FAILED', { errors: [{ path: 'patternId', code: 'exhausted' }] }),
    });
    await screen.findByText('B0000001', undefined, FIRST);
    fireEvent.click(screen.getByRole('button', { name: 'Tambah banyak dengan pola barkod' }));
    const dialog = await screen.findByRole('dialog', { name: 'Tambah eksemplar dengan pola barkod' });
    fireEvent.click(within(dialog).getByRole('button', { name: 'Buat eksemplar' }));
    expect(await within(dialog).findByText('Nomor pola barkod ini sudah habis. Pilih pola lain atau tambah digitnya di Pengaturan › Katalog.')).toBeTruthy();
    expect(within(dialog).getByRole('combobox', { name: 'Pola barkod' }).getAttribute('aria-invalid')).toBe('true');
  });

  it('a count above 100 is refused before anything is sent', async () => {
    const { writes } = renderTab(adminMe());
    await screen.findByText('B0000001', undefined, FIRST);
    fireEvent.click(screen.getByRole('button', { name: 'Tambah banyak dengan pola barkod' }));
    const dialog = await screen.findByRole('dialog', { name: 'Tambah eksemplar dengan pola barkod' });
    fireEvent.change(within(dialog).getByRole('spinbutton', { name: 'Jumlah eksemplar' }), { target: { value: '101' } });
    fireEvent.click(within(dialog).getByRole('button', { name: 'Buat eksemplar' }));
    expect(await within(dialog).findByText('Isi angka 1 sampai 100.')).toBeTruthy();
    expect(writes()).toEqual([]);
  });
});
