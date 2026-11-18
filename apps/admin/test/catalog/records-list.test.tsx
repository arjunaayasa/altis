import type { Permission } from '@altis/shared';
import type { MaterialTypeView } from '@altis/shared/api/catalog/masters';
import type { RecordCountsResponse, RecordListItem, RecordListResponse } from '@altis/shared/api/catalog/records';
import { fireEvent, screen, waitFor, within } from '@testing-library/react';
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import { EXPORT_SELECTION_KEY, EXPORT_SELECTION_MAX, parseRecordsSearch, storeExportSelection } from '@/screens/catalog/records/list';
import { adminMe, problem, signedIn, startApp, type FakeRequest } from '../fake-api';

// Bibliografi, the record list (Phase 2 spec §13, §4.4; plan Task 24): search and filters live in the URL search
// params (the list's query key follows them), the rows show cover, title and main author, type, year, call number,
// item count and the change time, and the selected rows go to the print queue or to "Ekspor terpilih" (M2: the ids
// travel through sessionStorage, never through the URL).

vi.mock('@/components/catalog/print-queue', () => ({
  // The real AddToPrintQueue is Task 30's; this one shows what the list hands it.
  AddToPrintQueue: ({ entries }: { entries: { kind: string; id: string; label: string }[] }) => (
    <output aria-label="Antrean cetak uji">{entries.map((e) => `${e.kind}:${e.id}:${e.label}`).join('|')}</output>
  ),
}));

const MT_BOOK = '01JZ0000000000000000000B01';
const MT_THESIS = '01JZ0000000000000000000B02';
const R1 = '01JZ0000000000000000000R01';
const R2 = '01JZ0000000000000000000R02';
const R3 = '01JZ0000000000000000000R03';

function materialType(id: string, code: string, nameId: string, nameEn: string): MaterialTypeView {
  return {
    id,
    code,
    nameId,
    nameEn,
    marcType: 'a',
    marcLevel: 'm',
    contentType: 'txt',
    mediaType: 'n',
    carrierType: 'nc',
    schemaType: 'Book',
    dcmiType: 'Text',
    template: { fields: {}, defaults: {}, customFields: [] },
    sortOrder: 0,
    usage: 0,
    archived: false,
    version: 1,
  };
}

const TYPES = [materialType(MT_BOOK, 'BUKU', 'Buku', 'Book'), materialType(MT_THESIS, 'SKRIPSI', 'Skripsi', 'Thesis')];

function row(o: Partial<RecordListItem> & Pick<RecordListItem, 'id' | 'title'>): RecordListItem {
  return {
    subtitle: null,
    mainAgent: null,
    materialTypeId: MT_BOOK,
    year: null,
    callNumber: null,
    itemCount: 0,
    coverFileId: null,
    opacVisible: true,
    archived: false,
    changedAt: 1_760_000_000_000,
    ...o,
  };
}

const ROWS: RecordListItem[] = [
  row({ id: R1, title: 'Laskar Pelangi', mainAgent: 'Hirata, Andrea', year: '2005', callNumber: '899.221 HIR l', itemCount: 3, coverFileId: '01JZ0000000000000000000F01' }),
  row({ id: R2, title: 'Bumi Manusia', mainAgent: 'Toer, Pramoedya Ananta', year: '1980', itemCount: 1 }),
  row({ id: R3, title: 'Pengantar Ilmu Perpustakaan', materialTypeId: MT_THESIS, opacVisible: false }),
];

const keyset = (items: RecordListItem[]): RecordListResponse => ({ items, total: null, nextCursor: null, page: null });

/** `GET catalog/records/counts`: the views, and a total that follows the filters asked for. */
const COUNTS = (req: FakeRequest): RecordCountsResponse => ({ views: { all: 1234, no_items: 2, hidden: 1, archived: 0 }, total: req.query.toString() === '' ? 1234 : 7 });

function start(
  o: { path?: string; permissions?: readonly Permission[]; list?: (req: FakeRequest) => RecordListResponse; counts?: ((req: FakeRequest) => unknown) | null } = {},
) {
  return startApp({
    me: o.permissions === undefined ? adminMe() : signedIn({ permissions: o.permissions }),
    path: o.path ?? '/admin/catalog/records',
    routes: {
      'GET catalog/records': (req) => (o.list ?? (() => keyset(ROWS)))(req),
      'GET catalog/material-types': () => ({ items: TYPES }),
      ...(o.counts === null ? {} : { 'GET catalog/records/counts': o.counts ?? COUNTS }),
    },
  });
}

/** The `GET catalog/records/counts` requests, as their query strings. */
const countQueries = (requests: FakeRequest[]): string[] => requests.filter((r) => r.method === 'GET' && r.path === 'catalog/records/counts').map((r) => r.query.toString());

/** The `GET catalog/records` requests, as their query strings. */
const listQueries = (requests: FakeRequest[]): string[] => requests.filter((r) => r.method === 'GET' && r.path === 'catalog/records').map((r) => r.query.toString());

beforeEach(() => {
  sessionStorage.clear();
});

afterEach(() => {
  vi.unstubAllGlobals();
  vi.restoreAllMocks();
});

describe('RecordsListScreen', () => {
  it('lists the records: cover, title and main author, type, year, call number, items and the change', async () => {
    start();
    const table = await screen.findByRole('table', { name: 'Daftar cantuman bibliografi' });
    const first = within(table).getByRole('link', { name: 'Laskar Pelangi' }).closest('tr')!;
    expect(first.querySelector('img')?.getAttribute('src')).toBe('/files/01JZ0000000000000000000F01');
    expect(within(first).getByRole('link', { name: 'Laskar Pelangi' }).getAttribute('href')).toBe(`/admin/catalog/records/${R1}`);
    expect(within(first).getByText('Hirata, Andrea')).toBeTruthy();
    expect(within(first).getByText('Buku')).toBeTruthy();
    expect(within(first).getByText('2005')).toBeTruthy();
    expect(within(first).getByText('899.221 HIR l')).toBeTruthy();
    expect(within(first).getByText('3')).toBeTruthy();
    const third = within(table).getByRole('link', { name: 'Pengantar Ilmu Perpustakaan' }).closest('tr')!;
    expect(within(third).getByText('Skripsi')).toBeTruthy();
    expect(within(third).getByText('Tersembunyi dari OPAC')).toBeTruthy();
    expect(screen.getByRole('link', { name: 'Tambah cantuman' }).getAttribute('href')).toBe('/admin/catalog/records/new');
  });

  it('a filter change updates the search params and the query key, and the request follows', async () => {
    const { router, requests, queryClient } = start();
    await screen.findByRole('link', { name: 'Laskar Pelangi' });
    expect(listQueries(requests)).toEqual(['limit=50']);

    fireEvent.change(screen.getByLabelText('Jenis bahan'), { target: { value: MT_THESIS } });
    await waitFor(() => expect(router.state.location.search).toEqual({ materialTypeId: MT_THESIS }));
    await waitFor(() => expect(listQueries(requests)).toContain(`materialTypeId=${MT_THESIS}&limit=50`));

    fireEvent.change(screen.getByLabelText('Tampil di OPAC'), { target: { value: 'only' } });
    fireEvent.change(screen.getByLabelText('Eksemplar'), { target: { value: 'false' } });
    fireEvent.click(screen.getByLabelText('Hanya yang diarsipkan'));
    await waitFor(() => expect(router.state.location.search).toEqual({ materialTypeId: MT_THESIS, hidden: 'only', hasItems: false, archived: true }));

    fireEvent.change(screen.getByLabelText('Cari cantuman'), { target: { value: 'judul:laskar "anak belitung"' } });
    fireEvent.click(screen.getByRole('button', { name: 'Cari' }));
    await waitFor(() => expect(router.state.location.search).toMatchObject({ q: 'judul:laskar "anak belitung"' }));
    await waitFor(() => {
      const last = new URLSearchParams(listQueries(requests).at(-1));
      expect(Object.fromEntries(last)).toEqual({
        q: 'judul:laskar "anak belitung"',
        materialTypeId: MT_THESIS,
        hidden: 'only',
        archived: 'true',
        hasItems: 'false',
        limit: '50',
      });
    });

    const keys = queryClient
      .getQueryCache()
      .findAll({ queryKey: ['catalog', 'records', 'list'] })
      .map((q) => q.queryKey[3]);
    expect(keys).toContainEqual({});
    expect(keys).toContainEqual({ materialTypeId: MT_THESIS });
    expect(keys).toContainEqual({ q: 'judul:laskar "anak belitung"', materialTypeId: MT_THESIS, hidden: 'only', archived: true, hasItems: false });
  });

  it('the filters are read back from the URL, and a changed range is sent as epoch milliseconds of local days', async () => {
    const { requests } = start({ path: `/admin/catalog/records?materialTypeId=${MT_BOOK}&changedFrom=2026-10-01&changedTo=2026-10-02&sort=title` });
    await screen.findByRole('link', { name: 'Laskar Pelangi' });
    expect((screen.getByLabelText('Jenis bahan') as HTMLSelectElement).value).toBe(MT_BOOK);
    // The range is a chip that says it, and opens the two days.
    fireEvent.click(screen.getByRole('button', { name: 'Diubah 1 Okt 2026 – 2 Okt 2026' }));
    const range = await screen.findByRole('dialog', { name: 'Terakhir diubah' });
    expect((within(range).getByLabelText('Diubah sejak') as HTMLInputElement).value).toBe('2026-10-01');
    expect((within(range).getByLabelText('Diubah sampai') as HTMLInputElement).value).toBe('2026-10-02');
    expect((screen.getByLabelText('Urutan') as HTMLSelectElement).value).toBe('title');
    const sent = Object.fromEntries(new URLSearchParams(listQueries(requests).at(-1)));
    expect(sent).toEqual({
      materialTypeId: MT_BOOK,
      changedFrom: String(new Date('2026-10-01T00:00:00').getTime()),
      changedTo: String(new Date('2026-10-02T23:59:59.999').getTime()),
      sort: 'title',
      limit: '50',
    });
  });

  it('the tabs carry the numbers of the views from the server; the foot says how many of how many are loaded', async () => {
    const { requests } = start({
      list: (req) => (req.query.get('cursor') === 'c.1.X' ? keyset([ROWS[2]!]) : { ...keyset(ROWS.slice(0, 2)), nextCursor: 'c.1.X' }),
    });
    await screen.findByRole('link', { name: 'Laskar Pelangi' });
    const tabs = screen.getByRole('navigation', { name: 'Tampilan daftar' });
    await waitFor(() => expect(within(tabs).getAllByRole('link').map((a) => a.textContent)).toEqual(['Semua 1234', 'Tanpa eksemplar 2', 'Disembunyikan dari OPAC 1', 'Diarsipkan 0']));
    expect(within(tabs).getByRole('link', { name: 'Semua 1234' }).getAttribute('aria-current')).toBe('page');
    const foot = document.querySelector('[data-list-count]') as HTMLElement;
    expect(foot.textContent).toBe('Menampilkan 2 dari 1.234 cantuman');
    fireEvent.click(screen.getByRole('button', { name: 'Muat lagi' }));
    await screen.findByRole('link', { name: 'Pengantar Ilmu Perpustakaan' });
    expect(foot.textContent).toBe('Menampilkan 3 dari 1.234 cantuman');
    // Asked once, with no filter: loading more rows does not count again.
    expect(countQueries(requests)).toEqual(['']);
  });

  it('the total follows the filters in use (not the search text or the order), under the same parameters as the list', async () => {
    const { requests } = start({ path: `/admin/catalog/records?materialTypeId=${MT_BOOK}&changedFrom=2026-10-01&sort=title` });
    await screen.findByRole('link', { name: 'Laskar Pelangi' });
    await waitFor(() => expect((document.querySelector('[data-list-count]') as HTMLElement).textContent).toBe('Menampilkan 3 dari 7 cantuman'));
    expect(countQueries(requests).map((q) => Object.fromEntries(new URLSearchParams(q)))).toEqual([
      { materialTypeId: MT_BOOK, changedFrom: String(new Date('2026-10-01T00:00:00').getTime()) },
    ]);
  });

  it('a search says its own total; a search text never borrows the count of the filters', async () => {
    start({
      path: '/admin/catalog/records?q=laskar',
      list: () => ({ items: ROWS.slice(0, 1), total: 61, nextCursor: null, page: 1 }),
    });
    await screen.findByRole('link', { name: 'Laskar Pelangi' });
    expect((document.querySelector('[data-list-count]') as HTMLElement).textContent).toBe('Menampilkan 1 dari 61 cantuman');
  });

  it('without the counts (a failed read) the tabs carry no number and the foot says only what is loaded', async () => {
    start({ counts: () => problem(500, 'INTERNAL') });
    await screen.findByRole('link', { name: 'Laskar Pelangi' });
    const tabs = screen.getByRole('navigation', { name: 'Tampilan daftar' });
    await waitFor(() => expect((document.querySelector('[data-list-count]') as HTMLElement).textContent).toBe('3 cantuman tampil'));
    expect(within(tabs).getAllByRole('link').map((a) => a.textContent)).toEqual(['Semua', 'Tanpa eksemplar', 'Disembunyikan dari OPAC', 'Diarsipkan']);
  });

  it('the filters are chips: named controls in the tab order, one in use says its value, and each can be cleared', async () => {
    const { router } = start();
    await screen.findByRole('link', { name: 'Laskar Pelangi' });
    const tools = screen.getByRole('group', { name: 'Saring cantuman' });
    const chips = [...tools.querySelectorAll('[data-chip]')] as HTMLElement[];
    const said = (c: HTMLElement): string => c.querySelector('[data-chip-text]')?.textContent ?? '';
    expect(chips.map(said)).toEqual(['Jenis bahan', 'Tampil di OPAC', 'Eksemplar', 'Tanggal diubah', 'Hanya yang diarsipkan', 'Urutan: Terakhir diubah']);
    expect(chips.filter((c) => c.hasAttribute('data-on'))).toEqual([]);
    // Each chip holds one focusable native control (or is the button itself), named after the filter.
    const type = within(tools).getByRole('combobox', { name: 'Jenis bahan' }) as HTMLSelectElement;
    expect([...type.options].map((o) => o.textContent)).toEqual(['Semua jenis', 'Buku', 'Skripsi']);
    expect(type.tabIndex).toBe(0);
    expect(within(tools).getByRole('combobox', { name: 'Tampil di OPAC' })).toBeTruthy();
    expect(within(tools).getByRole('combobox', { name: 'Eksemplar' })).toBeTruthy();
    expect(within(tools).getByRole('combobox', { name: 'Urutan' })).toBeTruthy();
    expect(within(tools).getByRole('checkbox', { name: 'Hanya yang diarsipkan' })).toBeTruthy();
    expect(within(tools).getByRole('button', { name: 'Tanggal diubah' })).toBeTruthy();

    fireEvent.change(type, { target: { value: MT_THESIS } });
    await waitFor(() => expect(router.state.location.search).toEqual({ materialTypeId: MT_THESIS }));
    const chip = type.closest('[data-chip]') as HTMLElement;
    await waitFor(() => expect(said(chip)).toBe('Jenis bahan: Skripsi'));
    expect(chip.hasAttribute('data-on')).toBe(true);
    // The value is for the eye only: the control keeps its own name and says its value itself.
    expect(within(tools).getByRole('combobox', { name: 'Jenis bahan' })).toBe(type);

    // The date range: opened with the keyboard's own click, set, said by the chip, and cleared inside it.
    fireEvent.click(within(tools).getByRole('button', { name: 'Tanggal diubah' }));
    const range = await screen.findByRole('dialog', { name: 'Terakhir diubah' });
    fireEvent.change(within(range).getByLabelText('Diubah sejak'), { target: { value: '2026-10-01' } });
    await waitFor(() => expect(router.state.location.search).toEqual({ materialTypeId: MT_THESIS, changedFrom: '2026-10-01' }));
    expect(await within(tools).findByRole('button', { name: 'Diubah sejak 1 Okt 2026' })).toBeTruthy();
    fireEvent.click(within(range).getByRole('button', { name: 'Hapus rentang tanggal' }));
    await waitFor(() => expect(router.state.location.search).toEqual({ materialTypeId: MT_THESIS }));

    fireEvent.change(type, { target: { value: '' } });
    await waitFor(() => expect(router.state.location.search).toEqual({}));
    await waitFor(() => expect(chip.hasAttribute('data-on')).toBe(false));

    fireEvent.click(within(tools).getByRole('checkbox', { name: 'Hanya yang diarsipkan' }));
    await waitFor(() => expect(router.state.location.search).toEqual({ archived: true }));
    fireEvent.click(within(tools).getByRole('button', { name: 'Hapus filter' }));
    await waitFor(() => expect(router.state.location.search).toEqual({}));
  });

  it('reads the search params as the router parsed them, dropping anything unknown or malformed', () => {
    // The router reads `?q=2005&hasItems=false` as JSON: a number and a boolean.
    expect(parseRecordsSearch({ q: 2005, hasItems: false, archived: 'true', hidden: 'only', sort: 'title' })).toEqual({
      q: '2005',
      hasItems: false,
      archived: true,
      hidden: 'only',
      sort: 'title',
    });
    expect(parseRecordsSearch({ q: true })).toEqual({ q: 'true' });
    expect(parseRecordsSearch({ q: '  ', materialTypeId: 'BUKU', hidden: 'yes', archived: false, changedFrom: '1/10/2026', sort: 'score', page: 3 })).toEqual({});
    expect(parseRecordsSearch({ q: 'x'.repeat(600) }).q).toHaveLength(500);
  });

  it('loads the next page by its cursor', async () => {
    const { requests } = start({
      list: (req) => (req.query.get('cursor') === 'c.1.X' ? keyset([ROWS[2]!]) : { ...keyset(ROWS.slice(0, 2)), nextCursor: 'c.1.X' }),
    });
    await screen.findByRole('link', { name: 'Bumi Manusia' });
    expect(screen.queryByRole('link', { name: 'Pengantar Ilmu Perpustakaan' })).toBeNull();
    fireEvent.click(screen.getByRole('button', { name: 'Muat lagi' }));
    await screen.findByRole('link', { name: 'Pengantar Ilmu Perpustakaan' });
    expect(listQueries(requests).at(-1)).toBe('limit=50&cursor=c.1.X');
    expect(screen.queryByRole('button', { name: 'Muat lagi' })).toBeNull();
  });

  it('M2: "Ekspor terpilih" puts the 3 selected ids in sessionStorage and opens Impor/Ekspor with ?export=selection', async () => {
    const { router } = start();
    await screen.findByRole('link', { name: 'Laskar Pelangi' });
    fireEvent.click(screen.getByRole('checkbox', { name: 'Pilih Laskar Pelangi' }));
    fireEvent.click(screen.getByRole('checkbox', { name: 'Pilih Bumi Manusia' }));
    fireEvent.click(screen.getByRole('checkbox', { name: 'Pilih Pengantar Ilmu Perpustakaan' }));
    expect(screen.getByText('3 dipilih')).toBeTruthy();
    // The print queue gets the same rows, as records.
    expect(screen.getByRole('status', { name: 'Antrean cetak uji' }).textContent).toBe(
      `record:${R1}:Laskar Pelangi|record:${R2}:Bumi Manusia|record:${R3}:Pengantar Ilmu Perpustakaan`,
    );
    fireEvent.click(screen.getByRole('button', { name: 'Ekspor terpilih' }));
    await waitFor(() => expect(router.state.location.pathname).toBe('/admin/catalog/exchange'));
    expect(router.state.location.search).toEqual({ export: 'selection' });
    expect(JSON.parse(sessionStorage.getItem(EXPORT_SELECTION_KEY)!)).toEqual({ ids: [R1, R2, R3], archived: false });
    expect(EXPORT_SELECTION_KEY).toBe('altis.exportSelection');
    // The ids never travel in the URL.
    expect(router.state.location.href).not.toContain(R1);
  });

  it('C20: a selection holding an archived record is stored with `archived: true`, so the export includes it', async () => {
    const archived = row({ id: R2, title: 'Bumi Manusia', archived: true });
    start({ path: '/admin/catalog/records?archived=true', list: () => keyset([archived]) });
    await screen.findByRole('link', { name: 'Bumi Manusia' });
    fireEvent.click(screen.getByRole('checkbox', { name: 'Pilih Bumi Manusia' }));
    fireEvent.click(screen.getByRole('button', { name: 'Ekspor terpilih' }));
    // Read where it is written: the export page that opens next reads the selection and clears it.
    const stored = await waitFor(() => {
      const text = sessionStorage.getItem(EXPORT_SELECTION_KEY);
      expect(text).not.toBeNull();
      return text!;
    });
    expect(JSON.parse(stored)).toEqual({ ids: [R2], archived: true });
  });

  it('M2: with sessionStorage throwing, it shows a notice instead and stays on the list', async () => {
    vi.spyOn(Storage.prototype, 'setItem').mockImplementation(() => {
      throw new DOMException('blocked', 'SecurityError');
    });
    const { router } = start();
    await screen.findByRole('link', { name: 'Laskar Pelangi' });
    fireEvent.click(screen.getByRole('checkbox', { name: 'Pilih semua yang tampil' }));
    expect(screen.getByText('3 dipilih')).toBeTruthy();
    fireEvent.click(screen.getByRole('button', { name: 'Ekspor terpilih' }));
    expect(await screen.findByText(/peramban ini tidak mengizinkan penyimpanan sesi/)).toBeTruthy();
    expect(router.state.location.pathname).toBe('/admin/catalog/records');
  });

  it('M2: more than 1 000 ids are refused with their own reason, a blocked storage with another', () => {
    expect(EXPORT_SELECTION_MAX).toBe(1000);
    const many = Array.from({ length: 1001 }, (_, i) => `01JZ${String(i).padStart(22, '0')}`);
    const setItem = vi.spyOn(Storage.prototype, 'setItem');
    expect(storeExportSelection(many)).toBe('too_many');
    expect(setItem).not.toHaveBeenCalled();
    expect(storeExportSelection(many.slice(0, 1000))).toBe('stored');
    expect(JSON.parse(sessionStorage.getItem(EXPORT_SELECTION_KEY)!).ids).toHaveLength(1000);
    setItem.mockImplementation(() => {
      throw new Error('quota');
    });
    expect(storeExportSelection([R1])).toBe('blocked');
  });

  it('without catalog.records.manage and catalog.export.run there is no "Tambah cantuman" nor "Ekspor terpilih"', async () => {
    start({ permissions: ['catalog.records.read'] });
    await screen.findByRole('link', { name: 'Laskar Pelangi' });
    fireEvent.click(screen.getByRole('checkbox', { name: 'Pilih Laskar Pelangi' }));
    expect(screen.queryByRole('link', { name: 'Tambah cantuman' })).toBeNull();
    expect(screen.queryByRole('button', { name: 'Ekspor terpilih' })).toBeNull();
    // Printing labels needs only catalog.records.read.
    expect(screen.getByRole('status', { name: 'Antrean cetak uji' }).textContent).toBe(`record:${R1}:Laskar Pelangi`);
  });
});
