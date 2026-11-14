import type { Permission } from '@altis/shared';
import type { CatalogConfigView } from '@altis/shared/api/settings';
import type { AgentView } from '@altis/shared/api/catalog/authorities';
import type { MarcJsonRecord } from '@altis/shared/api/catalog/exchange';
import type { CustomFieldView, LanguageView, MaterialTypeTemplate, MaterialTypeView } from '@altis/shared/api/catalog/masters';
import { RecordCreateBody, RecordPatchBody, type RecordDetail } from '@altis/shared/api/catalog/records';
import { fireEvent, screen, waitFor, within } from '@testing-library/react';
import { afterEach, describe, expect, it, vi } from 'vitest';
import { checkBody } from '@/screens/catalog/records/duplicates-panel';
import { emptyFormValues } from '@/screens/catalog/records/draft-to-form';
import { adminMe, json, problem, signedIn, startApp, type FakeHandler, type FakeRequest } from '../fake-api';
import { TK_REF, catalogReads } from './items-fixtures';

// The record editor (Phase 2 spec §13, §3.1, §3.3, §3.8; plan Task 24): the sections follow the material type's
// template, the pickers keep a new authority as a `{type, name}` reference, the live duplicate check runs 500 ms after
// the last change, a scanner burst fills the ISBN field, and after each write the record is read again (S15).

const MT_BOOK = '01JZ0000000000000000000B01';
const LANG_IND = '01JZ0000000000000000000G01';
const LANG_ENG = '01JZ0000000000000000000G02';
const RECORD = '01JZ0000000000000000000R01';
const NEW_ID = '01JZ0000000000000000000R09';
const AGENT_PRAM = '01JZ0000000000000000000A01';

function bookType(template: Partial<MaterialTypeTemplate> = {}): MaterialTypeView {
  return {
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
    template: { fields: {}, defaults: { languageId: LANG_IND }, customFields: [], ...template },
    sortOrder: 0,
    usage: 1,
    archived: false,
    version: 1,
  };
}

const LANGUAGES: LanguageView[] = [
  { id: LANG_IND, code: 'ind', nameId: 'Indonesia', nameEn: 'Indonesian', usage: 1, archived: false, version: 1 },
  { id: LANG_ENG, code: 'eng', nameId: 'Inggris', nameEn: 'English', usage: 0, archived: false, version: 1 },
];

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

const PRAM: AgentView = {
  id: AGENT_PRAM,
  type: 'person',
  name: 'Toer, Pramoedya Ananta',
  dates: '1925-2006',
  authoritySource: null,
  authorityRef: null,
  note: null,
  usage: 4,
  mergedInto: null,
  archived: false,
  version: 1,
  createdAt: 1_700_000_000_000,
  updatedAt: null,
};

function detail(o: Partial<RecordDetail> = {}): RecordDetail {
  return {
    id: RECORD,
    version: 3,
    materialTypeId: MT_BOOK,
    languageId: LANG_IND,
    source: 'manual',
    custom: {},
    warnings: [],
    itemCounts: { total: 2, available: 1 },
    createdAt: 1_700_000_000_000,
    updatedAt: 1_760_000_000_000,
    changedAt: 1_760_000_000_000,
    opacVisible: true,
    promoted: false,
    archived: false,
    mergedInto: null,
    materialType: { id: MT_BOOK, code: 'BUKU', nameId: 'Buku', nameEn: 'Book', marcType: 'a', marcLevel: 'm', schemaType: 'Book', dcmiType: 'Text' },
    language: { code: 'ind', nameId: 'Indonesia', nameEn: 'Indonesian' },
    materialTypeCode: 'BUKU',
    title: 'Bumi Manusia',
    publisher: { id: '01JZ0000000000000000000P01', name: 'Hasta Mitra', place: 'Jakarta' },
    publicationYear: '1980',
    contentType: 'txt',
    mediaType: 'n',
    carrierType: 'nc',
    identifiers: [{ type: 'isbn', value: '979-8659-12-7' }],
    agents: [{ id: AGENT_PRAM, type: 'person', name: 'Toer, Pramoedya Ananta', dates: '1925-2006', role: 'aut', isMain: true }],
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

interface Setup {
  path: string;
  type?: MaterialTypeView;
  /** Every material type offered (default: `type` alone). */
  types?: MaterialTypeView[];
  customFields?: CustomFieldView[];
  record?: () => RecordDetail;
  permissions?: readonly Permission[];
  routes?: Record<string, FakeHandler>;
}

function start(o: Setup) {
  const types = o.types ?? [o.type ?? bookType()];
  return startApp({
    me: o.permissions === undefined ? adminMe() : signedIn({ permissions: o.permissions }),
    path: o.path,
    routes: {
      'GET catalog/material-types': () => ({ items: types }),
      'GET catalog/languages': () => ({ items: LANGUAGES }),
      'GET catalog/custom-fields': () => ({ items: o.customFields ?? [] }),
      'GET catalog/config': () => CONFIG,
      'GET catalog/agents': () => ({ items: [PRAM], nextCursor: null }),
      'POST catalog/records/duplicates': () => ({ candidates: [], threshold: 80 }),
      'GET catalog/records/:id/attachments': () => ({ items: [] }),
      [`GET catalog/records/${RECORD}`]: () => (o.record ?? (() => detail()))(),
      ...o.routes,
    },
  });
}

const posts = (requests: FakeRequest[], path: string): FakeRequest[] => requests.filter((r) => r.method !== 'GET' && r.path === path);
const gets = (requests: FakeRequest[], path: string): number => requests.filter((r) => r.method === 'GET' && r.path === path).length;

afterEach(() => {
  vi.unstubAllGlobals();
  vi.restoreAllMocks();
});

describe('RecordCreateScreen', () => {
  it('posts the expected strict body, with an inline agent reference, then opens the record read again with GET', async () => {
    const { requests, router } = start({
      path: '/admin/catalog/records/new',
      routes: {
        'POST catalog/records': () => json({ id: NEW_ID, version: 0 }, 201),
        [`GET catalog/records/${NEW_ID}`]: () => detail({ id: NEW_ID, version: 0, title: 'Laskar Pelangi' }),
      },
    });
    const title = await screen.findByLabelText('Judul (wajib)');
    await waitFor(() => expect((screen.getByLabelText('Jenis bahan (wajib)') as HTMLSelectElement).value).toBe(MT_BOOK));
    fireEvent.change(title, { target: { value: 'Laskar Pelangi' } });
    fireEvent.change(screen.getByLabelText('Tahun terbit'), { target: { value: '2005' } });
    fireEvent.change(screen.getByLabelText('Nilai pengenal 1'), { target: { value: '978-979-3062-79-2' } });

    fireEvent.click(screen.getByRole('combobox', { name: 'Tambah pengarang atau kontributor…' }));
    fireEvent.change(await screen.findByPlaceholderText('Cari nama…'), { target: { value: 'Hirata, Andrea' } });
    fireEvent.click(await screen.findByRole('option', { name: 'Buat baru: “Hirata, Andrea”' }));
    const agents = screen.getByRole('group', { name: 'Pengarang dan kontributor' });
    expect(within(agents).getByText('Hirata, Andrea')).toBeTruthy();
    expect(within(agents).getByText('Baru')).toBeTruthy();

    fireEvent.click(screen.getByRole('button', { name: 'Simpan' }));
    await waitFor(() => expect(posts(requests, 'catalog/records')).toHaveLength(1));
    const body = posts(requests, 'catalog/records')[0]!.body;
    expect(body).toEqual({
      materialTypeId: MT_BOOK,
      title: 'Laskar Pelangi',
      publicationYear: '2005',
      languageId: LANG_IND,
      contentType: 'txt',
      mediaType: 'n',
      carrierType: 'nc',
      opacVisible: true,
      promoted: false,
      identifiers: [{ type: 'isbn', value: '978-979-3062-79-2' }],
      agents: [{ ref: { type: 'person', name: 'Hirata, Andrea' }, role: 'aut', isMain: true }],
    });
    expect(RecordCreateBody.safeParse(body).success).toBe(true);

    await waitFor(() => expect(router.state.location.pathname).toBe(`/admin/catalog/records/${NEW_ID}`));
    await waitFor(() => expect(gets(requests, `catalog/records/${NEW_ID}`)).toBeGreaterThan(0));
    expect(await screen.findByRole('heading', { name: 'Laskar Pelangi' })).toBeTruthy();
    expect(screen.getByText('Cantuman disimpan.')).toBeTruthy();
  });

  it('picks an existing agent by search and keeps it as {id}', async () => {
    const { requests } = start({ path: '/admin/catalog/records/new', routes: { 'POST catalog/records': () => json({ id: NEW_ID, version: 0 }, 201) } });
    fireEvent.change(await screen.findByLabelText('Judul (wajib)'), { target: { value: 'Rumah Kaca' } });
    fireEvent.click(screen.getByRole('combobox', { name: 'Tambah pengarang atau kontributor…' }));
    fireEvent.change(await screen.findByPlaceholderText('Cari nama…'), { target: { value: 'pram' } });
    fireEvent.click(await screen.findByRole('option', { name: /Toer, Pramoedya Ananta/ }));
    await waitFor(() => expect(requests.some((r) => r.path === 'catalog/agents' && r.query.get('q') === 'pram')).toBe(true));
    fireEvent.change(screen.getByLabelText('Peran Toer, Pramoedya Ananta'), { target: { value: 'edt' } });
    fireEvent.click(screen.getByRole('button', { name: 'Simpan' }));
    await waitFor(() => expect(posts(requests, 'catalog/records')).toHaveLength(1));
    expect((posts(requests, 'catalog/records')[0]!.body as RecordCreateBody).agents).toEqual([{ ref: { id: AGENT_PRAM }, role: 'edt', isMain: true }]);
  });

  it('a template with subtitle hidden leaves the field out and marks the required ones; a required error lands on its field', async () => {
    const type = bookType({ fields: { subtitle: 'hidden', edition: 'required' } });
    const { requests } = start({
      path: '/admin/catalog/records/new',
      type,
      routes: { 'POST catalog/records': () => problem(422, 'VALIDATION_FAILED', { errors: [{ path: 'callNumber', code: 'required' }] }) },
    });
    const title = await screen.findByLabelText('Judul (wajib)');
    expect(screen.queryByLabelText(/^Anak judul/)).toBeNull();
    expect(screen.getByLabelText('Edisi (wajib)').getAttribute('aria-required')).toBe('true');
    expect(screen.getByLabelText('Pernyataan tanggung jawab')).toBeTruthy();

    // The form checks the template first: nothing is sent while a required field is empty.
    fireEvent.change(title, { target: { value: 'Ronggeng Dukuh Paruk' } });
    fireEvent.click(screen.getByRole('button', { name: 'Simpan' }));
    const edition = screen.getByLabelText('Edisi (wajib)');
    await waitFor(() => expect(edition.getAttribute('aria-invalid')).toBe('true'));
    expect(screen.getByText('Wajib diisi.')).toBeTruthy();
    expect(posts(requests, 'catalog/records')).toHaveLength(0);

    // The server's own `required` (its template may be newer) lands on the field it names.
    fireEvent.change(edition, { target: { value: 'Cet. 2' } });
    fireEvent.click(screen.getByRole('button', { name: 'Simpan' }));
    await waitFor(() => expect(posts(requests, 'catalog/records')).toHaveLength(1));
    expect(posts(requests, 'catalog/records')[0]!.body).not.toHaveProperty('subtitle');
    const callNumber = screen.getByLabelText('Nomor panggil');
    await waitFor(() => expect(callNumber.getAttribute('aria-invalid')).toBe('true'));
    expect(document.getElementById(callNumber.getAttribute('aria-describedby')!.split(' ')[0]!)?.textContent).toBe('Wajib diisi.');
  });

  it('the live duplicate check posts what the editor holds, 500 ms after the last change, and shows a candidate scoring 100', async () => {
    const { requests } = start({
      path: '/admin/catalog/records/new',
      routes: {
        'POST catalog/records/duplicates': () => ({
          candidates: [{ recordId: RECORD, title: 'Laskar Pelangi', year: '2005', score: 100, reasons: ['isbn', 'title'] }],
          threshold: 80,
        }),
      },
    });
    const title = await screen.findByLabelText('Judul (wajib)');
    fireEvent.change(title, { target: { value: 'Laskar' } });
    fireEvent.change(title, { target: { value: 'Laskar Pelangi' } });
    fireEvent.change(screen.getByLabelText('Nilai pengenal 1'), { target: { value: '9789793062792' } });
    const panel = screen.getByRole('region', { name: 'Kemungkinan duplikat' });
    const link = await within(panel).findByRole('link', { name: /Laskar Pelangi/ }, { timeout: 3000 });
    expect(link.getAttribute('href')).toBe(`/admin/catalog/records/${RECORD}`);
    expect(within(panel).getByText('Skor 100')).toBeTruthy();
    expect(within(panel).getByText('ISBN/ISSN sama')).toBeTruthy();
    expect(within(panel).getByText('Judul mirip')).toBeTruthy();
    // Debounced: only the settled values were checked.
    const checks = posts(requests, 'catalog/records/duplicates').map((r) => r.body);
    expect(checks).toEqual([{ title: 'Laskar Pelangi', identifiers: [{ type: 'isbn', value: '9789793062792' }] }]);
  });

  it('a scanner burst fills the ISBN field, wherever the focus was', async () => {
    start({ path: '/admin/catalog/records/new' });
    const title = await screen.findByLabelText('Judul (wajib)');
    title.focus();
    for (const key of '9789793062792') fireEvent.keyDown(title, { key });
    fireEvent.keyDown(title, { key: 'Enter' });
    await waitFor(() => expect((screen.getByLabelText('Nilai pengenal 1') as HTMLInputElement).value).toBe('9789793062792'));
    expect((title as HTMLInputElement).value).toBe('');
    expect((screen.getByLabelText('Jenis pengenal 1') as HTMLSelectElement).value).toBe('isbn');
  });

  it('a scanned code that is no ISBN (an item barcode) stays out of the ISBN field', async () => {
    start({ path: '/admin/catalog/records/new' });
    const title = await screen.findByLabelText('Judul (wajib)');
    title.focus();
    for (const key of 'B000001234567') fireEvent.keyDown(title, { key });
    fireEvent.keyDown(title, { key: 'Enter' });
    await new Promise((r) => setTimeout(r, 100));
    expect((screen.getByLabelText('Nilai pengenal 1') as HTMLInputElement).value).toBe('');
    expect(screen.queryByLabelText('Nilai pengenal 2')).toBeNull();
  });

  it('another material type brings its RDA codes, its default language and its template, unless already chosen', async () => {
    const MT_MAP = '01JZ0000000000000000000B02';
    const map: MaterialTypeView = {
      ...bookType({ fields: { edition: 'hidden', series: 'required' }, defaults: { languageId: LANG_ENG }, customFields: ['skala'] }),
      id: MT_MAP,
      code: 'PETA',
      nameId: 'Peta',
      nameEn: 'Map',
      contentType: 'cri',
      mediaType: 'n',
      carrierType: 'nb',
    };
    const scale: CustomFieldView = {
      id: '01JZ0000000000000000000C01',
      entity: 'records',
      code: 'skala',
      labelId: 'Skala',
      labelEn: 'Scale',
      type: 'text',
      options: [],
      required: false,
      isPublic: true,
      isSearchable: false,
      sortOrder: 0,
      usage: 0,
      archived: false,
      version: 1,
    };
    const { requests } = start({
      path: '/admin/catalog/records/new',
      types: [bookType(), map],
      customFields: [scale],
      routes: { 'POST catalog/records': () => json({ id: NEW_ID, version: 0 }, 201) },
    });
    await screen.findByLabelText('Judul (wajib)');
    expect(screen.getByLabelText('Edisi')).toBeTruthy();
    expect(screen.queryByLabelText('Skala')).toBeNull();
    // The librarian chose the media type already: it stays.
    fireEvent.change(screen.getByLabelText('Jenis media (RDA)'), { target: { value: 's' } });
    fireEvent.change(screen.getByLabelText('Jenis bahan (wajib)'), { target: { value: MT_MAP } });
    await waitFor(() => expect((screen.getByLabelText('Jenis isi (RDA)') as HTMLSelectElement).value).toBe('cri'));
    expect((screen.getByLabelText('Jenis wadah (RDA)') as HTMLSelectElement).value).toBe('nb');
    expect((screen.getByLabelText('Jenis media (RDA)') as HTMLSelectElement).value).toBe('s');
    expect((screen.getByLabelText('Bahasa') as HTMLSelectElement).value).toBe(LANG_ENG);
    expect(screen.queryByLabelText(/^Edisi/)).toBeNull();
    expect(screen.getByLabelText('Judul seri (wajib)')).toBeTruthy();
    fireEvent.change(await screen.findByLabelText('Skala'), { target: { value: '1:50.000' } });
    fireEvent.change(screen.getByLabelText('Judul (wajib)'), { target: { value: 'Peta Jawa' } });
    fireEvent.change(screen.getByLabelText('Judul seri (wajib)'), { target: { value: 'Peta Rupabumi' } });
    fireEvent.click(screen.getByRole('button', { name: 'Simpan' }));
    await waitFor(() => expect(posts(requests, 'catalog/records')).toHaveLength(1));
    expect(posts(requests, 'catalog/records')[0]!.body).toMatchObject({
      materialTypeId: MT_MAP,
      series: 'Peta Rupabumi',
      languageId: LANG_ENG,
      contentType: 'cri',
      mediaType: 's',
      carrierType: 'nb',
      custom: { skala: '1:50.000' },
    });
  });
});

describe('the duplicate check body', () => {
  it('leaves out a part the contract refuses (a half-typed identifier) instead of stopping the check', () => {
    const v = { ...emptyFormValues(undefined), title: 'Laskar Pelangi', identifiers: [{ type: 'isbn' as const, value: '9'.repeat(65), qualifier: '' }] };
    expect(JSON.parse(checkBody(v, null)!)).toEqual({ title: 'Laskar Pelangi' });
    expect(JSON.parse(checkBody({ ...v, publicationYear: '2005' }, RECORD)!)).toEqual({ title: 'Laskar Pelangi', year: '2005', excludeId: RECORD });
    expect(checkBody({ ...v, title: '  ' }, null)).toBeNull();
  });
});

describe('RecordEditScreen', () => {
  it('sends only what changed with the version, then reads the record again (S15)', async () => {
    let version = 3;
    const { requests } = start({
      path: `/admin/catalog/records/${RECORD}`,
      record: () => detail({ version, subtitle: version > 3 ? 'Roman' : undefined }),
      routes: {
        [`PATCH catalog/records/${RECORD}`]: () => {
          version = 4;
          return { id: RECORD, version };
        },
      },
    });
    expect(await screen.findByRole('heading', { name: 'Bumi Manusia' })).toBeTruthy();
    const subtitle = await screen.findByLabelText('Anak judul');
    await waitFor(() => expect((screen.getByLabelText('Judul (wajib)') as HTMLInputElement).value).toBe('Bumi Manusia'));
    fireEvent.change(subtitle, { target: { value: 'Roman' } });
    const before = gets(requests, `catalog/records/${RECORD}`);
    fireEvent.click(screen.getByRole('button', { name: 'Simpan' }));
    await waitFor(() => expect(posts(requests, `catalog/records/${RECORD}`)).toHaveLength(1));
    const body = posts(requests, `catalog/records/${RECORD}`)[0]!.body;
    expect(body).toEqual({ version: 3, subtitle: 'Roman' });
    expect(RecordPatchBody.safeParse(body).success).toBe(true);
    await waitFor(() => expect(gets(requests, `catalog/records/${RECORD}`)).toBeGreaterThan(before));
    expect(await screen.findByText('Perubahan cantuman disimpan.')).toBeTruthy();

    // The next save carries the new version.
    fireEvent.change(screen.getByLabelText('Edisi'), { target: { value: 'Cet. 9' } });
    fireEvent.click(screen.getByRole('button', { name: 'Simpan' }));
    await waitFor(() => expect(posts(requests, `catalog/records/${RECORD}`)).toHaveLength(2));
    expect(posts(requests, `catalog/records/${RECORD}`)[1]!.body).toEqual({ version: 4, edition: 'Cet. 9' });
  });

  it('a save whose read-back fails still counts: the next save carries the new version and only the next change', async () => {
    let version = 3;
    let reads = 0;
    const { requests } = start({
      path: `/admin/catalog/records/${RECORD}`,
      routes: {
        [`GET catalog/records/${RECORD}`]: () => {
          reads += 1;
          return reads === 2 ? problem(404, 'NOT_FOUND') : detail({ version, subtitle: version > 3 ? 'Roman' : undefined });
        },
        [`PATCH catalog/records/${RECORD}`]: () => {
          version += 1;
          return { id: RECORD, version };
        },
      },
    });
    const subtitle = await screen.findByLabelText('Anak judul');
    await waitFor(() => expect((screen.getByLabelText('Judul (wajib)') as HTMLInputElement).value).toBe('Bumi Manusia'));
    fireEvent.change(subtitle, { target: { value: 'Roman' } });
    fireEvent.click(screen.getByRole('button', { name: 'Simpan' }));
    await waitFor(() => expect(posts(requests, `catalog/records/${RECORD}`)).toHaveLength(1));
    await waitFor(() => expect(reads).toBe(2));
    fireEvent.change(screen.getByLabelText('Edisi'), { target: { value: 'Cet. 9' } });
    fireEvent.click(screen.getByRole('button', { name: 'Simpan' }));
    await waitFor(() => expect(posts(requests, `catalog/records/${RECORD}`)).toHaveLength(2));
    expect(posts(requests, `catalog/records/${RECORD}`)[1]!.body).toEqual({ version: 4, edition: 'Cet. 9' });
  });

  it('CONFLICT_STALE shows a reload notice; reloading reads the record again and drops the change', async () => {
    let title = 'Bumi Manusia';
    const { requests } = start({
      path: `/admin/catalog/records/${RECORD}`,
      record: () => detail({ title, version: title === 'Bumi Manusia' ? 3 : 5 }),
      routes: { [`PATCH catalog/records/${RECORD}`]: () => problem(409, 'CONFLICT_STALE') },
    });
    const field = await screen.findByLabelText('Judul (wajib)');
    await waitFor(() => expect((field as HTMLInputElement).value).toBe('Bumi Manusia'));
    fireEvent.change(field, { target: { value: 'Bumi Manusia (edisi baru)' } });
    fireEvent.click(screen.getByRole('button', { name: 'Simpan' }));
    expect(await screen.findByText(/sudah diubah orang lain sejak Anda membukanya/)).toBeTruthy();
    title = 'Bumi Manusia: Tetralogi Buru 1';
    fireEvent.click(screen.getByRole('button', { name: 'Muat ulang cantuman' }));
    await waitFor(() => expect((screen.getByLabelText('Judul (wajib)') as HTMLInputElement).value).toBe('Bumi Manusia: Tetralogi Buru 1'));
    expect(screen.queryByText(/sudah diubah orang lain sejak Anda membukanya/)).toBeNull();
    fireEvent.change(screen.getByLabelText('Edisi'), { target: { value: 'Cet. 1' } });
    fireEvent.click(screen.getByRole('button', { name: 'Simpan' }));
    await waitFor(() => expect(posts(requests, `catalog/records/${RECORD}`)).toHaveLength(2));
    expect(posts(requests, `catalog/records/${RECORD}`)[1]!.body).toEqual({ version: 5, edition: 'Cet. 1' });
  });

  it('shows the stored warnings, and archives with {version} in the DELETE body', async () => {
    let archived = false;
    const { requests } = start({
      path: `/admin/catalog/records/${RECORD}`,
      record: () => detail({ archived, version: archived ? 4 : 3, warnings: [{ path: 'identifiers.0.value', code: 'isbn_invalid' }] }),
      routes: {
        [`DELETE catalog/records/${RECORD}`]: () => {
          archived = true;
          return { id: RECORD, version: 4 };
        },
      },
    });
    expect(await screen.findByText(/digit pemeriksanya salah/)).toBeTruthy();
    fireEvent.click(screen.getByRole('button', { name: 'Arsipkan' }));
    const dialog = await screen.findByRole('alertdialog');
    fireEvent.click(within(dialog).getByRole('button', { name: 'Arsipkan' }));
    await waitFor(() => expect(posts(requests, `catalog/records/${RECORD}`).map((r) => [r.method, r.body])).toEqual([['DELETE', { version: 3 }]]));
    expect(await screen.findByText('Cantuman ini diarsipkan: tidak tampil di OPAC.')).toBeTruthy();
    expect(screen.getByRole('button', { name: 'Pulihkan' })).toBeTruthy();
  });

  it("C22: the items tab's new items start with the saved material type's template default collection type", async () => {
    start({
      path: `/admin/catalog/records/${RECORD}`,
      type: bookType({ defaults: { languageId: LANG_IND, collectionTypeId: TK_REF } }),
      routes: {
        ...catalogReads(),
        'GET catalog/items': () => ({ items: [], nextCursor: null }),
      },
    });
    await screen.findByRole('heading', { name: 'Bumi Manusia' });
    fireEvent.mouseDown(screen.getByRole('tab', { name: 'Eksemplar (2)' }));
    const quick = await screen.findByRole('form', { name: 'Tambah eksemplar' });
    await waitFor(() => expect((within(quick).getByRole('combobox', { name: 'Tipe koleksi' }) as HTMLSelectElement).value).toBe(TK_REF));
  });

  it('the attachments, items and MARC tabs: the panel lists, the MARC tab reads format=json and links the downloads', async () => {
    const marc: MarcJsonRecord = {
      leader: '00000nam a2200000 i 4500',
      fields: [{ '001': RECORD }, { '245': { ind1: '1', ind2: '0', subfields: [{ a: 'Bumi manusia /' }, { c: 'Pramoedya Ananta Toer.' }] } }],
    };
    const { requests } = start({ path: `/admin/catalog/records/${RECORD}`, routes: { [`GET catalog/records/${RECORD}/marc`]: () => marc } });
    await screen.findByRole('heading', { name: 'Bumi Manusia' });
    expect(screen.getByRole('tab', { name: 'Eksemplar (2)' })).toBeTruthy();
    // On a narrow screen the tabs wrap: the list grows with its rows and each tab keeps one row's height, so the
    // second row never covers the panel (where Tampilan MARC could not be clicked).
    const list = screen.getByRole('tablist', { name: 'Bagian cantuman' });
    expect(list.className.split(/\s+/)).toEqual(expect.arrayContaining(['h-auto', 'flex-wrap']));
    for (const tab of within(list).getAllByRole('tab')) expect(tab.className.split(/\s+/)).toContain('h-7.5');

    fireEvent.mouseDown(screen.getByRole('tab', { name: 'Lampiran' }));
    await waitFor(() => expect(gets(requests, `catalog/records/${RECORD}/attachments`)).toBe(1));

    fireEvent.mouseDown(screen.getByRole('tab', { name: 'Tampilan MARC' }));
    const table = await screen.findByRole('table', { name: 'Ruas MARC cantuman ini' });
    const marcGet = requests.find((r) => r.path === `catalog/records/${RECORD}/marc`)!;
    expect(marcGet.query.get('format')).toBe('json');
    const row245 = within(table).getByText('245').closest('tr')!;
    expect(row245.textContent).toContain('$a Bumi manusia / $c Pramoedya Ananta Toer.');
    expect(within(table).getByText('00000nam a2200000 i 4500')).toBeTruthy();
    expect(screen.getByRole('link', { name: 'Unduh MARC (ISO 2709)' }).getAttribute('href')).toBe(`/api/v1/catalog/records/${RECORD}/marc?format=mrc`);
    expect(screen.getByRole('link', { name: 'Unduh MARCXML' }).getAttribute('href')).toBe(`/api/v1/catalog/records/${RECORD}/marc?format=xml`);
  });

  it('read-only without catalog.records.manage: no save, no duplicate check', async () => {
    const { requests } = start({ path: `/admin/catalog/records/${RECORD}`, permissions: ['catalog.records.read'] });
    await screen.findByRole('heading', { name: 'Bumi Manusia' });
    expect(screen.getByText('Anda hanya dapat melihat cantuman ini.')).toBeTruthy();
    expect(screen.queryByRole('button', { name: 'Simpan' })).toBeNull();
    // The form's fieldset is disabled: every field in it is (`input.disabled` reflects only the input's own attribute).
    expect(screen.getByLabelText('Judul (wajib)').matches(':disabled')).toBe(true);
    await new Promise((r) => setTimeout(r, 700));
    expect(posts(requests, 'catalog/records/duplicates')).toHaveLength(0);
  });
});
