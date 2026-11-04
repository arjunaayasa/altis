import { systemRolePermissions } from '@altis/shared';
import type { IsbnLookupResponse, SruSearchResponse } from '@altis/shared/api/catalog/copy';
import type { LanguageView, MaterialTypeView } from '@altis/shared/api/catalog/masters';
import type { RecordDraft } from '@altis/shared/api/catalog/record-data';
import type { RecordCreateBody } from '@altis/shared/api/catalog/records';
import type { CatalogConfigView } from '@altis/shared/api/settings';
import { QueryClient, QueryClientProvider } from '@tanstack/react-query';
import { fireEvent, render, screen, waitFor, within } from '@testing-library/react';
import { afterEach, describe, expect, it, vi } from 'vitest';
import { IsbnLookupButton, SruCopyDialog, type CopyPick } from '@/components/catalog/sru-dialog';
import { ME_KEY } from '@/lib/me';
import { adminMe, json, problem, signedIn, startApp, type FakeRequest } from '../fake-api';

// Copy cataloguing in the admin (Phase 2 spec §6.2, §6.3, §13; plan Task 32, K7, M13): "Salin dari SRU"
// (`GET catalog/sru/search`) and "Cari ISBN" (`GET catalog/lookup/isbn/:isbn`) answer drafts with their duplicate hints;
// "Pilih" hands `{draft, source}` to the editor, and `{draft, source, addItemNow: true}` with "Tambah eksemplar
// sekarang" ticked, after which the editor opens the saved record on its items tab.

const DUP = '01JZ0000000000000000000R05';
const NEW_ID = '01JZ0000000000000000000R09';
const MT_BOOK = '01JZ0000000000000000000B01';

function draft(title: string, isbn: string, o: Partial<RecordDraft> = {}): RecordDraft {
  return {
    materialTypeCode: 'BUKU',
    title,
    publisher: { name: 'Bentang Pustaka', place: 'Yogyakarta' },
    publicationYear: '2005',
    identifiers: [{ type: 'isbn', value: isbn }],
    agents: [{ type: 'person', name: 'Hirata, Andrea', role: 'aut', isMain: true }],
    subjects: [],
    links: [],
    items: [],
    marcExtra: [],
    ...o,
  };
}

const LASKAR = draft('Laskar pelangi', '9786020332956');
const PEMIMPI = draft('Sang pemimpi', '9789793062921');

const CONFIG: CatalogConfigView = {
  barcodePatterns: [],
  symbology: 'code128',
  labelProfiles: [],
  currency: 'IDR',
  dedupeThreshold: 80,
  defaultMaterialTypeId: MT_BOOK,
  defaultCollectionTypeId: null,
  sruServers: [
    { id: 'perpusnas', name: 'Perpustakaan Nasional RI', enabled: true },
    { id: 'kampus', name: 'Perpustakaan Kampus', enabled: true },
    { id: 'loc', name: 'Library of Congress', enabled: false },
  ],
  arsyaEnabled: true,
};

interface Call {
  method: string;
  path: string;
  query: URLSearchParams;
}

/** A fake `/api/v1`: `routes['METHOD path']` answers (a Response, or a body as 200 JSON); anything else is a 404 problem. */
function stubApi(routes: Record<string, (query: URLSearchParams) => unknown>) {
  const calls: Call[] = [];
  vi.stubGlobal(
    'fetch',
    vi.fn<typeof fetch>(async (input, init) => {
      const url = new URL(String(input), 'https://altis.test');
      const method = init?.method ?? 'GET';
      const path = url.pathname.replace(/^\/api\/v1\//, '');
      calls.push({ method, path, query: url.searchParams });
      const handler = routes[`${method} ${path}`];
      if (handler === undefined) return problem(404, 'NOT_FOUND');
      const answer = handler(url.searchParams);
      return answer instanceof Response ? answer : json(answer);
    }),
  );
  const searches = (): Record<string, string>[] => calls.filter((c) => c.path === 'catalog/sru/search').map((c) => Object.fromEntries(c.query));
  return { calls, searches };
}

function renderWithApp(node: React.ReactNode) {
  const queryClient = new QueryClient({ defaultOptions: { queries: { retry: false }, mutations: { retry: false } } });
  queryClient.setQueryData(ME_KEY, signedIn({ id: 'U1', permissions: systemRolePermissions('admin') }));
  return render(<QueryClientProvider client={queryClient}>{node}</QueryClientProvider>);
}

/** One page of the fake server: `records` from `start` of `total`. */
const page = (records: SruSearchResponse['records'], total = records.length, start = 1): SruSearchResponse => ({ total, start, records });

afterEach(() => {
  vi.unstubAllGlobals();
  vi.restoreAllMocks();
});

describe('SruCopyDialog', () => {
  function open(o: { initialIsbn?: string } = {}) {
    const onPick = vi.fn<(c: CopyPick) => void>();
    const onOpenChange = vi.fn<(open: boolean) => void>();
    renderWithApp(<SruCopyDialog open onOpenChange={onOpenChange} onPick={onPick} {...o} />);
    return { onPick, onOpenChange };
  }

  it('searches the chosen server, index and term; each result shows its draft and duplicate hint; "Pilih" → onPick({draft, source})', async () => {
    const api = stubApi({
      'GET catalog/config': () => CONFIG,
      'GET catalog/sru/search': () => page([{ draft: LASKAR, duplicate: null }, { draft: PEMIMPI, duplicate: { recordId: DUP, score: 92 } }], 2),
    });
    const { onPick } = open();
    const dialog = await screen.findByRole('dialog', { name: 'Salin dari SRU' });
    // Only the enabled servers are offered, the first one chosen.
    const server = (await within(dialog).findByLabelText('Server')) as HTMLSelectElement;
    expect([...server.options].map((o) => o.textContent)).toEqual(['Perpustakaan Nasional RI', 'Perpustakaan Kampus']);
    fireEvent.change(server, { target: { value: 'kampus' } });
    fireEvent.change(within(dialog).getByLabelText('Cari berdasarkan'), { target: { value: 'author' } });
    fireEvent.change(within(dialog).getByLabelText('Kata pencarian'), { target: { value: '  Hirata ' } });
    fireEvent.click(within(dialog).getByRole('button', { name: 'Cari' }));

    const results = await within(dialog).findByRole('list', { name: 'Hasil pencarian' });
    expect(api.searches()).toEqual([{ server: 'kampus', index: 'author', q: 'Hirata', start: '1' }]);
    expect(within(dialog).getByText('2 hasil di server, ditampilkan nomor 1 sampai 2.')).toBeTruthy();
    const laskar = within(results).getByText('Laskar pelangi').closest('li')!;
    expect(within(laskar).getByText('Hirata, Andrea · Yogyakarta : Bentang Pustaka · 2005')).toBeTruthy();
    expect(within(laskar).getByText('Nomor ISBN: 9786020332956')).toBeTruthy();
    expect(within(laskar).queryByText(/Mungkin duplikat/)).toBeNull();
    const pemimpi = within(results).getByText('Sang pemimpi').closest('li')!;
    expect(within(pemimpi).getByText('Mungkin duplikat (skor 92)')).toBeTruthy();
    const link = within(pemimpi).getByRole('link', { name: 'Buka cantuman yang mirip dengan Sang pemimpi di tab baru' });
    expect([link.getAttribute('href'), link.getAttribute('target'), link.getAttribute('rel')]).toEqual([`/admin/catalog/records/${DUP}`, '_blank', 'noopener noreferrer']);

    fireEvent.click(within(results).getByRole('button', { name: 'Pilih Sang pemimpi' }));
    expect(onPick).toHaveBeenCalledTimes(1);
    expect(onPick.mock.calls[0]![0]).toStrictEqual({ draft: PEMIMPI, source: 'sru:kampus' });
  });

  it('with "Tambah eksemplar sekarang" ticked, "Pilih" → onPick({draft, source, addItemNow: true}) (M13)', async () => {
    stubApi({ 'GET catalog/config': () => CONFIG, 'GET catalog/sru/search': () => page([{ draft: LASKAR, duplicate: null }]) });
    const { onPick } = open();
    const dialog = await screen.findByRole('dialog', { name: 'Salin dari SRU' });
    fireEvent.change(await within(dialog).findByLabelText('Kata pencarian'), { target: { value: 'laskar' } });
    fireEvent.click(within(dialog).getByRole('button', { name: 'Cari' }));
    const box = (await within(dialog).findByLabelText('Tambah eksemplar sekarang')) as HTMLInputElement;
    expect(box.checked).toBe(false);
    fireEvent.click(box);
    fireEvent.click(within(dialog).getByRole('button', { name: 'Pilih Laskar pelangi' }));
    expect(onPick.mock.calls[0]![0]).toStrictEqual({ draft: LASKAR, source: 'sru:perpusnas', addItemNow: true });
  });

  it('opened with the editor\'s ISBN: searched at once by ISBN on the first enabled server', async () => {
    const api = stubApi({ 'GET catalog/config': () => CONFIG, 'GET catalog/sru/search': () => page([{ draft: LASKAR, duplicate: null }]) });
    open({ initialIsbn: ' 978-602-03-3295-6 ' });
    const dialog = await screen.findByRole('dialog', { name: 'Salin dari SRU' });
    expect(await within(dialog).findByText('Laskar pelangi')).toBeTruthy();
    expect(api.searches()).toEqual([{ server: 'perpusnas', index: 'isbn', q: '978-602-03-3295-6', start: '1' }]);
    expect((within(dialog).getByLabelText('Cari berdasarkan') as HTMLSelectElement).value).toBe('isbn');
  });

  it('a scan while the dialog is open searches the ISBN it read', async () => {
    const api = stubApi({ 'GET catalog/config': () => CONFIG, 'GET catalog/sru/search': () => page([{ draft: LASKAR, duplicate: null }]) });
    open();
    const dialog = await screen.findByRole('dialog', { name: 'Salin dari SRU' });
    await within(dialog).findByLabelText('Kata pencarian');
    for (const key of '9786020332956') fireEvent.keyDown(dialog, { key });
    fireEvent.keyDown(dialog, { key: 'Enter' });
    expect(await within(dialog).findByText('Laskar pelangi')).toBeTruthy();
    expect(api.searches()).toEqual([{ server: 'perpusnas', index: 'isbn', q: '9786020332956', start: '1' }]);
  });

  it('pages through the results: "Halaman berikutnya" asks for start 21 of the same search', async () => {
    const api = stubApi({
      'GET catalog/config': () => CONFIG,
      'GET catalog/sru/search': (q) => page([{ draft: q.get('start') === '1' ? LASKAR : PEMIMPI, duplicate: null }], 25, Number(q.get('start'))),
    });
    open();
    const dialog = await screen.findByRole('dialog', { name: 'Salin dari SRU' });
    fireEvent.change(await within(dialog).findByLabelText('Kata pencarian'), { target: { value: 'hirata' } });
    fireEvent.click(within(dialog).getByRole('button', { name: 'Cari' }));
    await within(dialog).findByText('Laskar pelangi');
    // The server answered one record where 20 were due: the others could not be read.
    expect(within(dialog).getByText('Sebagian cantuman di halaman ini tidak dapat dibaca dan dilewati.')).toBeTruthy();
    expect((within(dialog).getByRole('button', { name: 'Halaman sebelumnya' }) as HTMLButtonElement).disabled).toBe(true);
    // The term typed afterwards does not change the paged search.
    fireEvent.change(within(dialog).getByLabelText('Kata pencarian'), { target: { value: 'lain' } });
    fireEvent.click(within(dialog).getByRole('button', { name: 'Halaman berikutnya' }));
    expect(await within(dialog).findByText('Sang pemimpi')).toBeTruthy();
    expect(within(dialog).getByText('25 hasil di server, ditampilkan nomor 21 sampai 25.')).toBeTruthy();
    expect(api.searches().map((s) => [s['q'], s['start']])).toEqual([
      ['hirata', '1'],
      ['hirata', '21'],
    ]);
  });

  it('a failed search shows the problem (CATALOG_SRU_INVALID); an empty term is refused before anything is sent', async () => {
    const api = stubApi({ 'GET catalog/config': () => CONFIG, 'GET catalog/sru/search': () => problem(502, 'CATALOG_SRU_INVALID') });
    open();
    const dialog = await screen.findByRole('dialog', { name: 'Salin dari SRU' });
    fireEvent.change(await within(dialog).findByLabelText('Kata pencarian'), { target: { value: '   ' } });
    fireEvent.click(within(dialog).getByRole('button', { name: 'Cari' }));
    expect(await within(dialog).findByText('Isi kata pencarian.')).toBeTruthy();
    expect(api.searches()).toEqual([]);
    fireEvent.change(within(dialog).getByLabelText('Kata pencarian'), { target: { value: 'x' } });
    fireEvent.click(within(dialog).getByRole('button', { name: 'Cari' }));
    expect(await within(dialog).findByText('Jawaban server SRU tidak sesuai dengan standar SRU.')).toBeTruthy();
    expect(api.searches()).toHaveLength(1);
  });

  it('L09: a server that refused the search (a diagnostic) shows its own message, not "not an SRU answer"', async () => {
    stubApi({
      'GET catalog/config': () => CONFIG,
      'GET catalog/sru/search': () => problem(502, 'CATALOG_SRU_INVALID', { detail: 'Unsupported index: dc.title' }),
    });
    open();
    const dialog = await screen.findByRole('dialog', { name: 'Salin dari SRU' });
    fireEvent.change(await within(dialog).findByLabelText('Kata pencarian'), { target: { value: 'laskar' } });
    fireEvent.click(within(dialog).getByRole('button', { name: 'Cari' }));
    expect(await within(dialog).findByText('Server SRU menolak pencarian ini: Unsupported index: dc.title')).toBeTruthy();
    expect(within(dialog).queryByText('Jawaban server SRU tidak sesuai dengan standar SRU.')).toBeNull();
  });

  it('without an enabled server it says so and searches nothing, even with an ISBN', async () => {
    const api = stubApi({ 'GET catalog/config': () => ({ ...CONFIG, sruServers: [{ id: 'loc', name: 'Library of Congress', enabled: false }] }) });
    open({ initialIsbn: '9786020332956' });
    const dialog = await screen.findByRole('dialog', { name: 'Salin dari SRU' });
    expect(await within(dialog).findByText(/Belum ada server SRU yang aktif/)).toBeTruthy();
    expect(api.searches()).toEqual([]);
  });
});

describe('IsbnLookupButton', () => {
  function renderButton(isbn: string) {
    const onPick = vi.fn<(c: CopyPick) => void>();
    const onExisting = vi.fn<(recordId: string) => void>();
    renderWithApp(<IsbnLookupButton isbn={isbn} onPick={onPick} onExisting={onExisting} />);
    return { onPick, onExisting };
  }

  const FOUND: IsbnLookupResponse = {
    isbn13: '9786020332956',
    local: null,
    candidates: [
      { source: 'sru:perpusnas', draft: LASKAR, duplicate: null },
      { source: 'isbn:arsya', draft: draft('Laskar pelangi (cetakan baru)', '9786020332963'), duplicate: { recordId: DUP, score: 100 } },
    ],
    errors: [{ source: 'sru:kampus', code: 'CATALOG_OUTBOUND_FAILED' }],
  };

  it('a record of the catalogue holds the ISBN → onExisting(its id), no candidates shown', async () => {
    const api = stubApi({
      'GET catalog/config': () => CONFIG,
      'GET catalog/lookup/isbn/978-602-03-3295-6': () => ({ isbn13: '9786020332956', local: { recordId: DUP, title: 'Laskar Pelangi' }, candidates: [], errors: [] }),
    });
    const { onExisting, onPick } = renderButton(' 978-602-03-3295-6 ');
    fireEvent.click(screen.getByRole('button', { name: 'Cari ISBN' }));
    await waitFor(() => expect(onExisting).toHaveBeenCalledWith(DUP));
    expect(api.calls.filter((c) => c.path.startsWith('catalog/lookup/isbn/'))).toHaveLength(1);
    expect(screen.queryByRole('dialog')).toBeNull();
    expect(onPick).not.toHaveBeenCalled();
  });

  it('the candidates of the sources with their duplicate hints and the sources that failed; "Pilih" with the box ticked → addItemNow', async () => {
    stubApi({ 'GET catalog/config': () => CONFIG, 'GET catalog/lookup/isbn/9786020332956': () => FOUND });
    const { onPick, onExisting } = renderButton('9786020332956');
    fireEvent.click(screen.getByRole('button', { name: 'Cari ISBN' }));
    const dialog = await screen.findByRole('dialog', { name: 'Hasil pencarian ISBN 9786020332956' });
    const list = within(dialog).getByRole('list', { name: 'Hasil pencarian ISBN 9786020332956' });
    const first = within(list).getByText('Laskar pelangi').closest('li')!;
    expect(await within(first).findByText('Sumber: Perpustakaan Nasional RI')).toBeTruthy();
    const second = within(list).getByText('Laskar pelangi (cetakan baru)').closest('li')!;
    // `isbn:arsya` is a source value kept for compatibility, named neutrally.
    expect(within(second).getByText('Sumber: Layanan ISBN')).toBeTruthy();
    expect(within(second).getByText('Mungkin duplikat (skor 100)')).toBeTruthy();
    expect(within(dialog).getByText(/^Perpustakaan Kampus: tidak berhasil\./)).toBeTruthy();

    fireEvent.click(within(dialog).getByLabelText('Tambah eksemplar sekarang'));
    fireEvent.click(within(first).getByRole('button', { name: 'Pilih Laskar pelangi' }));
    expect(onPick.mock.calls[0]![0]).toStrictEqual({ draft: LASKAR, source: 'sru:perpusnas', addItemNow: true });
    expect(onExisting).not.toHaveBeenCalled();
    await waitFor(() => expect(screen.queryByRole('dialog')).toBeNull());
  });

  it('"Pilih" without the box → onPick({draft, source}) only', async () => {
    stubApi({ 'GET catalog/config': () => CONFIG, 'GET catalog/lookup/isbn/9786020332956': () => FOUND });
    const { onPick } = renderButton('9786020332956');
    fireEvent.click(screen.getByRole('button', { name: 'Cari ISBN' }));
    const dialog = await screen.findByRole('dialog', { name: 'Hasil pencarian ISBN 9786020332956' });
    fireEvent.click(within(dialog).getByRole('button', { name: 'Pilih Laskar pelangi (cetakan baru)' }));
    expect(onPick.mock.calls[0]![0]).toStrictEqual({ draft: FOUND.candidates[1]!.draft, source: 'isbn:arsya' });
  });

  it('no candidate: says no source found it; without any enabled source it says that instead', async () => {
    const none: IsbnLookupResponse = { isbn13: '9786020332956', local: null, candidates: [], errors: [] };
    stubApi({ 'GET catalog/config': () => ({ ...CONFIG, sruServers: [], arsyaEnabled: false }), 'GET catalog/lookup/isbn/9786020332956': () => none });
    renderButton('9786020332956');
    fireEvent.click(screen.getByRole('button', { name: 'Cari ISBN' }));
    const dialog = await screen.findByRole('dialog', { name: 'Hasil pencarian ISBN 9786020332956' });
    expect(await within(dialog).findByText(/^Belum ada sumber salin katalog yang aktif/)).toBeTruthy();
  });

  it('the reserved arsyaEnabled is no source: with no SRU server enabled it still says none is active', async () => {
    const none: IsbnLookupResponse = { isbn13: '9786020332956', local: null, candidates: [], errors: [] };
    stubApi({ 'GET catalog/config': () => ({ ...CONFIG, sruServers: [], arsyaEnabled: true }), 'GET catalog/lookup/isbn/9786020332956': () => none });
    renderButton('9786020332956');
    fireEvent.click(screen.getByRole('button', { name: 'Cari ISBN' }));
    const dialog = await screen.findByRole('dialog', { name: 'Hasil pencarian ISBN 9786020332956' });
    expect(await within(dialog).findByText(/^Belum ada sumber salin katalog yang aktif/)).toBeTruthy();
  });

  it('an invalid ISBN says so; a 429 shows its wait; an empty ISBN field disables the button', async () => {
    stubApi({
      'GET catalog/lookup/isbn/12345': () => problem(422, 'VALIDATION_FAILED', { errors: [{ path: 'isbn', code: 'invalid' }] }),
      'GET catalog/lookup/isbn/9786020332956': () =>
        new Response(JSON.stringify({ type: 'about:blank', title: 'x', status: 429, code: 'AUTH_TOO_MANY_ATTEMPTS' }), {
          status: 429,
          headers: { 'Content-Type': 'application/problem+json', 'Retry-After': '42', 'X-Altis-Build': '0.1.0' },
        }),
    });
    const { unmount } = renderWithApp(<IsbnLookupButton isbn="12345" onPick={vi.fn()} onExisting={vi.fn()} />);
    fireEvent.click(screen.getByRole('button', { name: 'Cari ISBN' }));
    expect((await screen.findByRole('alert')).textContent).toBe('ISBN ini tidak valid. Periksa angka-angkanya.');
    unmount();

    renderWithApp(<IsbnLookupButton isbn="9786020332956" onPick={vi.fn()} onExisting={vi.fn()} />);
    fireEvent.click(screen.getByRole('button', { name: 'Cari ISBN' }));
    expect((await screen.findByRole('alert')).textContent).toMatch(/42 detik/);
    expect(screen.queryByRole('dialog')).toBeNull();
  });

  it('an empty ISBN field: the button is disabled and nothing is asked', () => {
    const api = stubApi({});
    renderButton('  ');
    expect((screen.getByRole('button', { name: 'Cari ISBN' }) as HTMLButtonElement).disabled).toBe(true);
    expect(api.calls).toEqual([]);
  });
});

describe('the record editor with the real copy dialog (M13)', () => {
  function type(id: string, code: string): MaterialTypeView {
    return {
      id,
      code,
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
      usage: 0,
      archived: false,
      version: 1,
    };
  }

  function start() {
    const languages: LanguageView[] = [];
    return startApp({
      me: adminMe(),
      path: '/admin/catalog/records/new',
      routes: {
        'GET catalog/material-types': () => ({ items: [type(MT_BOOK, 'BUKU')] }),
        'GET catalog/languages': () => ({ items: languages }),
        'GET catalog/custom-fields': () => ({ items: [] }),
        'GET catalog/config': () => CONFIG,
        'POST catalog/records/duplicates': () => ({ candidates: [], threshold: 80 }),
        'GET catalog/sru/search': () => page([{ draft: LASKAR, duplicate: null }]),
        'POST catalog/records': () => json({ id: NEW_ID, version: 0 }, 201),
      },
    });
  }

  const creates = (requests: FakeRequest[]) => requests.filter((r) => r.method === 'POST' && r.path === 'catalog/records');

  it('"Tambah eksemplar sekarang" → the form is filled, the notice says what follows, and the save opens the record on its items tab', async () => {
    const { requests, router } = start();
    // The editor is a lazy chunk: its first load in a file can take a while on a busy machine.
    await screen.findByLabelText('Judul (wajib)', undefined, { timeout: 15_000 });
    fireEvent.click(await screen.findByRole('button', { name: 'Salin dari SRU' }));
    const dialog = await screen.findByRole('dialog', { name: 'Salin dari SRU' });
    fireEvent.change(await within(dialog).findByLabelText('Kata pencarian'), { target: { value: 'laskar' } });
    fireEvent.click(within(dialog).getByRole('button', { name: 'Cari' }));
    fireEvent.click(await within(dialog).findByLabelText('Tambah eksemplar sekarang'));
    fireEvent.click(within(dialog).getByRole('button', { name: 'Pilih Laskar pelangi' }));

    await waitFor(() => expect((screen.getByLabelText('Judul (wajib)') as HTMLInputElement).value).toBe('Laskar pelangi'));
    expect(screen.queryByRole('dialog', { name: 'Salin dari SRU' })).toBeNull();
    expect(screen.getByText(/Formulir diisi dari salinan \(Perpustakaan Nasional RI\)\..*tab Eksemplar akan dibuka/)).toBeTruthy();

    fireEvent.click(screen.getByRole('button', { name: 'Simpan' }));
    await waitFor(() => expect(creates(requests)).toHaveLength(1));
    const body = creates(requests)[0]!.body as RecordCreateBody;
    expect([body.title, body.source]).toEqual(['Laskar pelangi', 'sru:perpusnas']);
    await waitFor(() => expect(router.state.location.pathname).toBe(`/admin/catalog/records/${NEW_ID}`));
    expect(router.state.location.search).toEqual({ tab: 'items' });
  }, 30_000);
});
