import type { Permission } from '@altis/shared';
import type { CollectionTypeView, CustomFieldView, LanguageView, MaterialTypeView, SupplierView } from '@altis/shared/api/catalog/masters';
import { fireEvent, screen, waitFor, within } from '@testing-library/react';
import { afterEach, beforeAll, describe, expect, it, vi } from 'vitest';
import { adminMe, problem, signedIn, startApp, type FakeHandler, type FakeRequest } from '../fake-api';

// Data Induk (Phase 2 spec §13, §3.7, §3.8; plan Task 27): a tab per master (Jenis Bahan, Bahasa, Tipe Koleksi,
// Pemasok, Ruas Tambahan), each a table with create, edit and archive. Archiving a master that live records or items
// still use is refused with 409 CATALOG_IN_USE, and the screen says how many (Review Focus 2). A material type is
// edited on its own page with the template editor (§3.8): each record field hidden, optional or required, the default
// RDA codes, MARC type and level, the schema.org and DCMI types and the custom fields shown.

// The screens are lazy chunks: load them before the first test, whose first look for the page waits 1 s at most.
beforeAll(async () => {
  await Promise.all([import('@/screens/catalog/masters/index'), import('@/screens/catalog/masters/material-type')]);
});

afterEach(() => {
  vi.unstubAllGlobals();
  vi.restoreAllMocks();
});

const MT_BOOK = '01JZ0000000000000000000M01';
const MT_MAP = '01JZ0000000000000000000M02';
const LANG_IND = '01JZ0000000000000000000B01';
const LANG_ENG = '01JZ0000000000000000000B02';
const CT_GENERAL = '01JZ0000000000000000000C01';
const SUPPLIER = '01JZ0000000000000000000S01';
const CF_SOURCE = '01JZ0000000000000000000F01';
const CF_SHELF = '01JZ0000000000000000000F02';
const NEW_ID = '01JZ0000000000000000000N01';

function materialType(o: Partial<MaterialTypeView> & Pick<MaterialTypeView, 'id' | 'code' | 'nameId' | 'nameEn'>): MaterialTypeView {
  return {
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
    ...o,
  };
}

const BOOK = materialType({ id: MT_BOOK, code: 'BUKU', nameId: 'Buku', nameEn: 'Book', usage: 3 });
const MAP = materialType({
  id: MT_MAP,
  code: 'PETA',
  nameId: 'Peta',
  nameEn: 'Map',
  marcType: 'e',
  contentType: 'cri',
  carrierType: 'nb',
  schemaType: 'Map',
  dcmiType: 'Image',
  sortOrder: 4,
  version: 2,
});

const IND: LanguageView = { id: LANG_IND, code: 'ind', nameId: 'Indonesia', nameEn: 'Indonesian', usage: 120, archived: false, version: 1 };
const ENG: LanguageView = { id: LANG_ENG, code: 'eng', nameId: 'Inggris', nameEn: 'English', usage: 0, archived: false, version: 1 };

const GENERAL: CollectionTypeView = {
  id: CT_GENERAL,
  code: 'UMUM',
  nameId: 'Umum',
  nameEn: 'General',
  loanable: true,
  selfService: true,
  sortOrder: 0,
  usage: 40,
  archived: false,
  version: 1,
};

const SUPPLIER_ROW: SupplierView = {
  id: SUPPLIER,
  code: 'GRAMED',
  name: 'Toko Buku Gramedia',
  contactName: 'Sari',
  phone: '021-555',
  email: null,
  address: null,
  note: null,
  usage: 2,
  archived: false,
  version: 2,
};

function customField(o: Partial<CustomFieldView> & Pick<CustomFieldView, 'id' | 'code' | 'labelId'>): CustomFieldView {
  return {
    entity: 'records',
    type: 'text',
    labelEn: null,
    options: [],
    required: false,
    sortOrder: 0,
    isPublic: false,
    isSearchable: false,
    usage: 0,
    archived: false,
    version: 1,
    ...o,
  };
}

const SOURCE_FIELD = customField({ id: CF_SOURCE, code: 'ASAL', labelId: 'Asal pengadaan', labelEn: 'Acquired from' });
const SHELF_FIELD = customField({ id: CF_SHELF, code: 'RAK', labelId: 'Rak lama', entity: 'items' });

interface Lists {
  materialTypes?: MaterialTypeView[];
  languages?: LanguageView[];
  collectionTypes?: CollectionTypeView[];
  suppliers?: SupplierView[];
  customFields?: CustomFieldView[];
}

function start(o: { path?: string; permissions?: readonly Permission[]; lists?: Lists; routes?: Record<string, FakeHandler> } = {}) {
  const lists = o.lists ?? {};
  return startApp({
    me: o.permissions === undefined ? adminMe() : signedIn({ permissions: o.permissions }),
    path: o.path ?? '/admin/catalog/masters',
    routes: {
      'GET catalog/material-types': () => ({ items: lists.materialTypes ?? [BOOK, MAP] }),
      'GET catalog/languages': () => ({ items: lists.languages ?? [IND, ENG] }),
      'GET catalog/collection-types': () => ({ items: lists.collectionTypes ?? [GENERAL] }),
      'GET catalog/suppliers': () => ({ items: lists.suppliers ?? [SUPPLIER_ROW] }),
      'GET catalog/custom-fields': (req) => {
        const all = lists.customFields ?? [SOURCE_FIELD, SHELF_FIELD];
        const entity = req.query.get('entity');
        return { items: entity === null ? all : all.filter((f) => f.entity === entity) };
      },
      ...o.routes,
    },
  });
}

const gets = (requests: FakeRequest[], path: string): number => requests.filter((r) => r.method === 'GET' && r.path === path).length;
const sent = (requests: FakeRequest[], method: string, path: string): FakeRequest[] => requests.filter((r) => r.method === method && r.path === path);

describe('MastersScreen', () => {
  it('shows a tab per master, each with its table; the tab follows the URL', async () => {
    const { router, requests } = start();
    expect(await screen.findByRole('heading', { name: 'Data Induk' })).toBeTruthy();
    const types = await screen.findByRole('table', { name: 'Daftar jenis bahan' });
    const book = within(types).getByText('BUKU').closest('tr')!;
    expect(within(book).getByText('Buku')).toBeTruthy();
    expect(within(book).getByText('a / m')).toBeTruthy();
    expect(within(book).getByText('txt / n / nc')).toBeTruthy();
    expect(within(book).getByText('3')).toBeTruthy();
    expect(within(book).getByRole('link', { name: 'Ubah BUKU' }).getAttribute('href')).toBe(`/admin/catalog/masters/material-types/${MT_BOOK}`);
    expect(screen.getByRole('link', { name: 'Tambah jenis bahan' }).getAttribute('href')).toBe('/admin/catalog/masters/material-types/new');

    for (const name of ['Jenis Bahan', 'Bahasa', 'Tipe Koleksi', 'Pemasok', 'Ruas Tambahan']) expect(screen.getByRole('tab', { name })).toBeTruthy();

    fireEvent.mouseDown(screen.getByRole('tab', { name: 'Bahasa' }));
    const languages = await screen.findByRole('table', { name: 'Daftar bahasa' });
    expect(within(languages).getByText('ind').closest('tr')!.textContent).toContain('Indonesian');
    await waitFor(() => expect(router.state.location.search).toEqual({ tab: 'languages' }));
    expect(gets(requests, 'catalog/languages')).toBe(1);

    fireEvent.mouseDown(screen.getByRole('tab', { name: 'Ruas Tambahan' }));
    const fields = await screen.findByRole('table', { name: 'Daftar ruas tambahan' });
    expect(within(fields).getByText('ASAL').closest('tr')!.textContent).toContain('Cantuman');
    expect(within(fields).getByText('RAK').closest('tr')!.textContent).toContain('Eksemplar');
  });

  it('opens the tab the URL names', async () => {
    start({ path: '/admin/catalog/masters?tab=suppliers' });
    const suppliers = await screen.findByRole('table', { name: 'Daftar pemasok' });
    expect(within(suppliers).getByText('Toko Buku Gramedia')).toBeTruthy();
    expect(screen.getByRole('tab', { name: 'Pemasok' }).getAttribute('aria-selected')).toBe('true');
  });

  it('creates a language with the strict body and reads the list again', async () => {
    const { requests } = start({ path: '/admin/catalog/masters?tab=languages', routes: { 'POST catalog/languages': () => ({ id: NEW_ID, version: 0 }) } });
    await screen.findByRole('table', { name: 'Daftar bahasa' });
    fireEvent.click(screen.getByRole('button', { name: 'Tambah bahasa' }));
    const dialog = await screen.findByRole('region', { name: 'Tambah bahasa' });
    fireEvent.change(within(dialog).getByLabelText('Kode'), { target: { value: ' sun ' } });
    fireEvent.change(within(dialog).getByLabelText('Nama (Indonesia)'), { target: { value: 'Sunda' } });
    fireEvent.change(within(dialog).getByLabelText('Nama (Inggris)'), { target: { value: 'Sundanese' } });
    fireEvent.click(within(dialog).getByRole('button', { name: 'Simpan' }));
    await waitFor(() => expect(sent(requests, 'POST', 'catalog/languages')).toHaveLength(1));
    expect(sent(requests, 'POST', 'catalog/languages')[0]!.body).toEqual({ code: 'sun', nameId: 'Sunda', nameEn: 'Sundanese' });
    expect(await screen.findByText('Bahasa sun disimpan.')).toBeTruthy();
    await waitFor(() => expect(gets(requests, 'catalog/languages')).toBe(2));
    expect(screen.queryByRole('region', { name: 'Tambah bahasa' })).toBeNull();
  });

  it('puts a server field error on its field', async () => {
    start({
      path: '/admin/catalog/masters?tab=languages',
      routes: { 'POST catalog/languages': () => problem(422, 'VALIDATION_FAILED', { errors: [{ path: 'code', code: 'taken' }] }) },
    });
    await screen.findByRole('table', { name: 'Daftar bahasa' });
    fireEvent.click(screen.getByRole('button', { name: 'Tambah bahasa' }));
    const dialog = await screen.findByRole('region', { name: 'Tambah bahasa' });
    fireEvent.change(within(dialog).getByLabelText('Kode'), { target: { value: 'ind' } });
    fireEvent.change(within(dialog).getByLabelText('Nama (Indonesia)'), { target: { value: 'Indonesia' } });
    fireEvent.change(within(dialog).getByLabelText('Nama (Inggris)'), { target: { value: 'Indonesian' } });
    fireEvent.click(within(dialog).getByRole('button', { name: 'Simpan' }));
    expect(await within(dialog).findByText('Sudah dipakai. Gunakan yang lain.')).toBeTruthy();
    expect(within(dialog).getByLabelText('Kode').getAttribute('aria-invalid')).toBe('true');
  });

  it('edits a supplier: only what changed, with its version', async () => {
    const { requests } = start({
      path: '/admin/catalog/masters?tab=suppliers',
      routes: { 'PATCH catalog/suppliers/:id': () => ({ id: SUPPLIER, version: 3 }) },
    });
    const table = await screen.findByRole('table', { name: 'Daftar pemasok' });
    fireEvent.click(within(table).getByRole('button', { name: 'Ubah GRAMED' }));
    const dialog = await screen.findByRole('region', { name: 'Ubah pemasok' });
    expect((within(dialog).getByLabelText('Nama kontak') as HTMLInputElement).value).toBe('Sari');
    fireEvent.change(within(dialog).getByLabelText('Telepon'), { target: { value: '0812-1111' } });
    fireEvent.change(within(dialog).getByLabelText('Nama kontak'), { target: { value: '  ' } });
    fireEvent.click(within(dialog).getByRole('button', { name: 'Simpan' }));
    await waitFor(() => expect(sent(requests, 'PATCH', `catalog/suppliers/${SUPPLIER}`)).toHaveLength(1));
    expect(sent(requests, 'PATCH', `catalog/suppliers/${SUPPLIER}`)[0]!.body).toEqual({ version: 2, contactName: null, phone: '0812-1111' });
  });

  it('a collection type keeps its flags and order in the form', async () => {
    const { requests } = start({
      path: '/admin/catalog/masters?tab=collection-types',
      routes: { 'POST catalog/collection-types': () => ({ id: NEW_ID, version: 0 }) },
    });
    await screen.findByRole('table', { name: 'Daftar tipe koleksi' });
    fireEvent.click(screen.getByRole('button', { name: 'Tambah tipe koleksi' }));
    const dialog = await screen.findByRole('region', { name: 'Tambah tipe koleksi' });
    fireEvent.change(within(dialog).getByLabelText('Kode'), { target: { value: 'REF' } });
    fireEvent.change(within(dialog).getByLabelText('Nama (Indonesia)'), { target: { value: 'Referensi' } });
    fireEvent.change(within(dialog).getByLabelText('Nama (Inggris)'), { target: { value: 'Reference' } });
    fireEvent.click(within(dialog).getByLabelText('Boleh dipinjam swalayan (mandiri)'));
    fireEvent.change(within(dialog).getByLabelText('Urutan'), { target: { value: '2' } });
    fireEvent.click(within(dialog).getByRole('button', { name: 'Simpan' }));
    await waitFor(() => expect(sent(requests, 'POST', 'catalog/collection-types')).toHaveLength(1));
    expect(sent(requests, 'POST', 'catalog/collection-types')[0]!.body).toEqual({
      code: 'REF',
      nameId: 'Referensi',
      nameEn: 'Reference',
      loanable: true,
      selfService: false,
      sortOrder: 2,
    });
  });

  it('archiving a master that is in use shows its count; an unused one is archived', async () => {
    let archived = false;
    const { requests } = start({
      lists: { materialTypes: [BOOK, MAP] },
      routes: {
        'DELETE catalog/material-types/:id': (req) =>
          req.params['id'] === MT_BOOK
            ? problem(409, 'CATALOG_IN_USE', {
                detail:
                  'Jenis bahan ini masih dipakai 3 cantuman aktif; ubah dahulu cantuman itu / This material type is still used by 3 live record(s); change them first',
              })
            : ((archived = true), { id: MT_MAP, version: 3 }),
      },
    });
    const table = await screen.findByRole('table', { name: 'Daftar jenis bahan' });

    fireEvent.click(within(table).getByRole('button', { name: 'Arsipkan BUKU' }));
    let dialog = await screen.findByRole('alertdialog', { name: 'Arsipkan BUKU?' });
    fireEvent.click(within(dialog).getByRole('button', { name: 'Arsipkan' }));
    const alert = await screen.findByText('BUKU masih dipakai 3 cantuman aktif, jadi belum dapat diarsipkan. Ubah dahulu cantuman itu.');
    expect(alert.closest('[role="alert"]')).not.toBeNull();
    expect(sent(requests, 'DELETE', `catalog/material-types/${MT_BOOK}`)[0]!.body).toEqual({ version: 1 });
    await waitFor(() => expect(screen.queryByRole('alertdialog')).toBeNull());

    fireEvent.click(within(table).getByRole('button', { name: 'Arsipkan PETA' }));
    dialog = await screen.findByRole('alertdialog', { name: 'Arsipkan PETA?' });
    fireEvent.click(within(dialog).getByRole('button', { name: 'Arsipkan' }));
    expect(await screen.findByText('PETA diarsipkan.')).toBeTruthy();
    expect(archived).toBe(true);
    expect(sent(requests, 'DELETE', `catalog/material-types/${MT_MAP}`)[0]!.body).toEqual({ version: 2 });
    expect(screen.queryByText(/masih dipakai/)).toBeNull();
  });

  it('a collection type in use counts items; the count comes from the row when the server gives none', async () => {
    start({
      path: '/admin/catalog/masters?tab=collection-types',
      routes: { 'DELETE catalog/collection-types/:id': () => problem(409, 'CATALOG_IN_USE') },
    });
    const table = await screen.findByRole('table', { name: 'Daftar tipe koleksi' });
    fireEvent.click(within(table).getByRole('button', { name: 'Arsipkan UMUM' }));
    const dialog = await screen.findByRole('alertdialog', { name: 'Arsipkan UMUM?' });
    fireEvent.click(within(dialog).getByRole('button', { name: 'Arsipkan' }));
    expect(await screen.findByText('UMUM masih dipakai 40 eksemplar aktif, jadi belum dapat diarsipkan. Pindahkan dahulu eksemplar itu ke tipe lain.')).toBeTruthy();
  });

  it('a stale archive reads the list again, so confirming again sends the current version', async () => {
    let changed = false;
    let deletes = 0;
    const { requests } = start({
      routes: {
        'GET catalog/material-types': () => ({ items: changed ? [BOOK, { ...MAP, nameId: 'Peta dunia', version: 5 }] : [BOOK, MAP] }),
        'DELETE catalog/material-types/:id': () => {
          deletes += 1;
          if (deletes > 1) return { id: MT_MAP, version: 6 };
          changed = true;
          return problem(409, 'CONFLICT_STALE');
        },
      },
    });
    const table = await screen.findByRole('table', { name: 'Daftar jenis bahan' });
    fireEvent.click(within(table).getByRole('button', { name: 'Arsipkan PETA' }));
    const dialog = await screen.findByRole('alertdialog', { name: 'Arsipkan PETA?' });
    fireEvent.click(within(dialog).getByRole('button', { name: 'Arsipkan' }));
    expect(await within(dialog).findByText('Data ini sudah diubah oleh orang lain. Muat ulang, lalu coba lagi.')).toBeTruthy();
    expect(sent(requests, 'DELETE', `catalog/material-types/${MT_MAP}`)[0]!.body).toEqual({ version: 2 });
    await waitFor(() => expect(gets(requests, 'catalog/material-types')).toBe(2));
    expect(await within(table).findByText('Peta dunia')).toBeTruthy();

    fireEvent.click(within(dialog).getByRole('button', { name: 'Arsipkan' }));
    expect(await screen.findByText('PETA diarsipkan.')).toBeTruthy();
    expect(sent(requests, 'DELETE', `catalog/material-types/${MT_MAP}`)[1]!.body).toEqual({ version: 5 });
  });

  it('a stale edit reads the list again, so the reopened dialog holds the current row', async () => {
    let changed = false;
    const { requests } = start({
      path: '/admin/catalog/masters?tab=languages',
      routes: {
        'GET catalog/languages': () => ({ items: changed ? [IND, { ...ENG, nameEn: 'English (UK)', version: 4 }] : [IND, ENG] }),
        'PATCH catalog/languages/:id': (req) => {
          if ((req.body as { version: number }).version === 4) return { id: LANG_ENG, version: 5 };
          changed = true;
          return problem(409, 'CONFLICT_STALE');
        },
      },
    });
    const table = await screen.findByRole('table', { name: 'Daftar bahasa' });
    fireEvent.click(within(table).getByRole('button', { name: 'Ubah eng' }));
    let dialog = await screen.findByRole('region', { name: 'Ubah bahasa' });
    fireEvent.change(within(dialog).getByLabelText('Nama (Indonesia)'), { target: { value: 'Bahasa Inggris' } });
    fireEvent.click(within(dialog).getByRole('button', { name: 'Simpan' }));
    expect(await within(dialog).findByText('Data ini sudah diubah oleh orang lain. Muat ulang, lalu coba lagi.')).toBeTruthy();
    await waitFor(() => expect(gets(requests, 'catalog/languages')).toBe(2));

    fireEvent.click(within(dialog).getByRole('button', { name: 'Batal' }));
    await waitFor(() => expect(screen.queryByRole('region', { name: 'Ubah bahasa' })).toBeNull());
    fireEvent.click(within(table).getByRole('button', { name: 'Ubah eng' }));
    dialog = await screen.findByRole('region', { name: 'Ubah bahasa' });
    expect((within(dialog).getByLabelText('Nama (Inggris)') as HTMLInputElement).value).toBe('English (UK)');
    fireEvent.change(within(dialog).getByLabelText('Nama (Indonesia)'), { target: { value: 'Bahasa Inggris' } });
    fireEvent.click(within(dialog).getByRole('button', { name: 'Simpan' }));
    await waitFor(() => expect(sent(requests, 'PATCH', `catalog/languages/${LANG_ENG}`)).toHaveLength(2));
    expect(sent(requests, 'PATCH', `catalog/languages/${LANG_ENG}`)[1]!.body).toEqual({ version: 4, nameId: 'Bahasa Inggris' });
    expect(await screen.findByText('Bahasa eng disimpan.')).toBeTruthy();
  });

  it('creates a select custom field with its options', async () => {
    const { requests } = start({
      path: '/admin/catalog/masters?tab=custom-fields',
      routes: { 'POST catalog/custom-fields': () => ({ id: NEW_ID, version: 0 }) },
    });
    await screen.findByRole('table', { name: 'Daftar ruas tambahan' });
    fireEvent.click(screen.getByRole('button', { name: 'Tambah ruas tambahan' }));
    const dialog = await screen.findByRole('region', { name: 'Tambah ruas tambahan' });
    fireEvent.change(within(dialog).getByLabelText('Untuk'), { target: { value: 'items' } });
    fireEvent.change(within(dialog).getByLabelText('Jenis isian'), { target: { value: 'select' } });
    fireEvent.change(within(dialog).getByLabelText('Kode'), { target: { value: 'KONDISI' } });
    fireEvent.change(within(dialog).getByLabelText('Label (Indonesia)'), { target: { value: 'Kondisi fisik' } });

    // A choice field without options is refused before anything is sent.
    fireEvent.click(within(dialog).getByRole('button', { name: 'Simpan' }));
    expect(await within(dialog).findByText('Tambahkan paling sedikit satu pilihan.')).toBeTruthy();
    expect(sent(requests, 'POST', 'catalog/custom-fields')).toHaveLength(0);

    fireEvent.click(within(dialog).getByRole('button', { name: 'Tambah pilihan' }));
    fireEvent.change(within(dialog).getByLabelText('Nilai pilihan 1'), { target: { value: 'baik' } });
    fireEvent.change(within(dialog).getByLabelText('Label pilihan 1 (Indonesia)'), { target: { value: 'Baik' } });
    fireEvent.change(within(dialog).getByLabelText('Label pilihan 1 (Inggris)'), { target: { value: 'Good' } });
    fireEvent.click(within(dialog).getByRole('button', { name: 'Tambah pilihan' }));
    fireEvent.change(within(dialog).getByLabelText('Nilai pilihan 2'), { target: { value: 'rusak' } });
    fireEvent.change(within(dialog).getByLabelText('Label pilihan 2 (Indonesia)'), { target: { value: 'Rusak' } });
    fireEvent.click(within(dialog).getByLabelText('Tampil di OPAC'));
    fireEvent.click(within(dialog).getByRole('button', { name: 'Simpan' }));
    await waitFor(() => expect(sent(requests, 'POST', 'catalog/custom-fields')).toHaveLength(1));
    expect(sent(requests, 'POST', 'catalog/custom-fields')[0]!.body).toEqual({
      entity: 'items',
      type: 'select',
      code: 'KONDISI',
      labelId: 'Kondisi fisik',
      labelEn: null,
      options: [
        { value: 'baik', labelId: 'Baik', labelEn: 'Good' },
        { value: 'rusak', labelId: 'Rusak', labelEn: null },
      ],
      required: false,
      sortOrder: 0,
      isPublic: true,
      isSearchable: false,
    });
  });

  it('a duplicate option value from the server lands on that option', async () => {
    const withOptions = customField({
      id: CF_SOURCE,
      code: 'ASAL',
      labelId: 'Asal pengadaan',
      type: 'select',
      options: [
        { value: 'beli', labelId: 'Pembelian', labelEn: null },
        { value: 'hadiah', labelId: 'Hadiah', labelEn: null },
      ],
      version: 4,
    });
    const { requests } = start({
      path: '/admin/catalog/masters?tab=custom-fields',
      lists: { customFields: [withOptions] },
      routes: {
        'PATCH catalog/custom-fields/:id': () => problem(422, 'VALIDATION_FAILED', { errors: [{ path: 'options.1.value', code: 'duplicate' }] }),
      },
    });
    const table = await screen.findByRole('table', { name: 'Daftar ruas tambahan' });
    fireEvent.click(within(table).getByRole('button', { name: 'Ubah ASAL' }));
    const dialog = await screen.findByRole('region', { name: 'Ubah ruas tambahan' });
    // Entity and type never change (the strict patch refuses them): shown, not editable.
    expect(within(dialog).queryByLabelText('Untuk')).toBeNull();
    expect(within(dialog).getByText('Pilihan tunggal')).toBeTruthy();
    fireEvent.change(within(dialog).getByLabelText('Nilai pilihan 2'), { target: { value: 'Beli' } });
    fireEvent.click(within(dialog).getByRole('button', { name: 'Simpan' }));
    expect(await within(dialog).findByText('Nilai pilihan ini sudah dipakai pilihan lain.')).toBeTruthy();
    expect(sent(requests, 'PATCH', `catalog/custom-fields/${CF_SOURCE}`)[0]!.body).toEqual({
      version: 4,
      options: [
        { value: 'beli', labelId: 'Pembelian', labelEn: null },
        { value: 'Beli', labelId: 'Hadiah', labelEn: null },
      ],
    });
  });

  it('without catalog.masters.manage the tables are read only', async () => {
    start({ permissions: ['catalog.records.read'] });
    const table = await screen.findByRole('table', { name: 'Daftar jenis bahan' });
    expect(within(table).getByText('BUKU')).toBeTruthy();
    expect(screen.queryByRole('link', { name: 'Tambah jenis bahan' })).toBeNull();
    expect(within(table).queryByRole('button', { name: 'Arsipkan BUKU' })).toBeNull();
    // The material type's page still opens, read only.
    expect(within(table).getByRole('link', { name: 'Lihat BUKU' })).toBeTruthy();
  });
});

describe('MaterialTypeEditScreen and the template editor', () => {
  const editPath = `/admin/catalog/masters/material-types/${MT_BOOK}`;

  it('posts {fields: {subtitle: "required"}} when the subtitle becomes required', async () => {
    const { requests } = start({ path: editPath, routes: { 'PATCH catalog/material-types/:id': () => ({ id: MT_BOOK, version: 2 }) } });
    expect(await screen.findByRole('heading', { name: 'Buku' })).toBeTruthy();
    const subtitle = screen.getByLabelText('Anak judul') as HTMLSelectElement;
    expect(subtitle.value).toBe('optional');
    expect([...subtitle.options].map((o) => o.textContent)).toEqual(['Tersembunyi', 'Opsional', 'Wajib']);
    fireEvent.change(subtitle, { target: { value: 'required' } });
    fireEvent.click(screen.getByRole('button', { name: 'Simpan' }));
    await waitFor(() => expect(sent(requests, 'PATCH', `catalog/material-types/${MT_BOOK}`)).toHaveLength(1));
    expect(sent(requests, 'PATCH', `catalog/material-types/${MT_BOOK}`)[0]!.body).toEqual({
      version: 1,
      template: { fields: { subtitle: 'required' }, defaults: {}, customFields: [] },
    });
    expect(await screen.findByText('Jenis bahan BUKU disimpan.')).toBeTruthy();
  });

  it('shows every template field, the title always required, and the stored states', async () => {
    const book = materialType({
      ...BOOK,
      template: { fields: { notes: 'hidden', identifiers: 'required', subtitle: 'optional' }, defaults: { languageId: LANG_IND }, customFields: ['ASAL'] },
    });
    start({ path: editPath, lists: { materialTypes: [book] } });
    await screen.findByRole('heading', { name: 'Buku' });
    const template = screen.getByRole('table', { name: 'Ruas cantuman menurut templat' });
    // title + the 18 RECORD_FIELD_NAMES
    expect(within(template).getAllByRole('row')).toHaveLength(1 + 1 + 18);
    expect(within(template).getByText('Judul').closest('tr')!.textContent).toContain('Selalu wajib');
    expect((screen.getByLabelText('Catatan') as HTMLSelectElement).value).toBe('hidden');
    expect((screen.getByLabelText('Pengenal (ISBN, ISSN, DOI)') as HTMLSelectElement).value).toBe('required');
    expect((screen.getByLabelText('Bahasa bawaan') as HTMLSelectElement).value).toBe(LANG_IND);
    expect((screen.getByLabelText('Asal pengadaan (ASAL)') as HTMLInputElement).checked).toBe(true);
    // Only the records' custom fields are offered (RAK is an items field).
    expect(screen.queryByLabelText('Rak lama (RAK)')).toBeNull();
  });

  // A long form filled field by field: it may take more than the default 5 s on a busy machine.
  it('a new material type posts the whole body: RDA codes, MARC type and level, schema.org and DCMI, the template', async () => {
    const { requests, router } = start({
      path: '/admin/catalog/masters/material-types/new',
      routes: { 'POST catalog/material-types': () => new Response(JSON.stringify({ id: NEW_ID, version: 0 }), { status: 201, headers: { 'Content-Type': 'application/json' } }) },
    });
    expect(await screen.findByRole('heading', { name: 'Jenis bahan baru' })).toBeTruthy();
    fireEvent.change(screen.getByLabelText('Kode'), { target: { value: 'DISERTASI' } });
    fireEvent.change(screen.getByLabelText('Nama (Indonesia)'), { target: { value: 'Disertasi' } });
    fireEvent.change(screen.getByLabelText('Nama (Inggris)'), { target: { value: 'Dissertation' } });
    const marcType = screen.getByLabelText('Tipe cantuman MARC (leader/06)') as HTMLSelectElement;
    expect(marcType.value).toBe('a');
    fireEvent.change(screen.getByLabelText('Tingkat bibliografis MARC (leader/07)'), { target: { value: 'm' } });
    const content = screen.getByLabelText('Jenis isi RDA (336)') as HTMLSelectElement;
    expect([...content.options].some((o) => o.value === 'txt' && o.textContent === 'txt — text')).toBe(true);
    fireEvent.change(content, { target: { value: 'txt' } });
    fireEvent.change(screen.getByLabelText('Jenis media RDA (337)'), { target: { value: 'c' } });
    fireEvent.change(screen.getByLabelText('Jenis wadah RDA (338)'), { target: { value: 'cr' } });
    fireEvent.change(screen.getByLabelText('Tipe schema.org'), { target: { value: 'Thesis' } });
    fireEvent.change(screen.getByLabelText('Tipe DCMI'), { target: { value: 'Text' } });
    fireEvent.change(screen.getByLabelText('Catatan'), { target: { value: 'hidden' } });
    fireEvent.change(screen.getByLabelText('Ringkasan'), { target: { value: 'required' } });
    fireEvent.change(screen.getByLabelText('Bahasa bawaan'), { target: { value: LANG_IND } });
    fireEvent.change(screen.getByLabelText('Tipe koleksi bawaan eksemplar'), { target: { value: CT_GENERAL } });
    fireEvent.click(screen.getByLabelText('Asal pengadaan (ASAL)'));
    fireEvent.click(screen.getByRole('button', { name: 'Simpan' }));
    await waitFor(() => expect(sent(requests, 'POST', 'catalog/material-types')).toHaveLength(1));
    expect(sent(requests, 'POST', 'catalog/material-types')[0]!.body).toEqual({
      code: 'DISERTASI',
      nameId: 'Disertasi',
      nameEn: 'Dissertation',
      marcType: 'a',
      marcLevel: 'm',
      contentType: 'txt',
      mediaType: 'c',
      carrierType: 'cr',
      schemaType: 'Thesis',
      dcmiType: 'Text',
      template: {
        fields: { summary: 'required', notes: 'hidden' },
        defaults: { collectionTypeId: CT_GENERAL, languageId: LANG_IND },
        customFields: ['ASAL'],
      },
      sortOrder: 0,
    });
    await waitFor(() => expect(router.state.location.pathname).toBe(`/admin/catalog/masters/material-types/${NEW_ID}`));
  }, 20_000);

  it('a template code the server refuses shows on the custom fields', async () => {
    start({
      path: editPath,
      routes: {
        'PATCH catalog/material-types/:id': () => problem(422, 'VALIDATION_FAILED', { errors: [{ path: 'template.customFields.0', code: 'archived' }] }),
      },
    });
    await screen.findByRole('heading', { name: 'Buku' });
    fireEvent.click(screen.getByLabelText('Asal pengadaan (ASAL)'));
    fireEvent.click(screen.getByRole('button', { name: 'Simpan' }));
    const group = screen.getByRole('group', { name: 'Ruas tambahan yang tampil' });
    expect(await within(group).findByText('Sudah diarsipkan, jadi tidak dapat dipakai lagi.')).toBeTruthy();
  });

  it('read only without catalog.masters.manage', async () => {
    start({ path: editPath, permissions: ['catalog.records.read'] });
    await screen.findByRole('heading', { name: 'Buku' });
    expect(screen.queryByRole('button', { name: 'Simpan' })).toBeNull();
    expect((screen.getByLabelText('Anak judul') as HTMLSelectElement).disabled).toBe(true);
  });
});
