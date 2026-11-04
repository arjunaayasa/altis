import type { CollectionTypeView, MaterialTypeView } from '@altis/shared/api/catalog/masters';
import type { SruTestResponse } from '@altis/shared/api/catalog/copy';
import { CatalogSettingsBody, type BarcodePattern, type CatalogSettings, type LabelProfile, type SruServer } from '@altis/shared/api/settings';
import { fireEvent, screen, waitFor, within } from '@testing-library/react';
import { afterEach, describe, expect, it, vi } from 'vitest';
import { adminMe, signedIn, startApp, superMe, type FakeHandler } from '../fake-api';

// Pengaturan › Katalog (Phase 2 spec §13, §12.6, §6.2, §7; plan Task 28): one form for the `catalog` group saved with
// one `PUT settings/catalog` (only the keys that changed, each list whole), checked first with the shared Zod schemas
// (M1: 20 patterns and 20 profiles at most), the SRU "Uji" button (`POST catalog/sru/test`, always 200 `{ok, message}`,
// P2-17) and "Izinkan host privat" for a super admin only (M11). There is no ISBN-service switch: the reserved
// `isbn.arsyaEnabled` is carried as stored and never sent (ruling R23).

afterEach(() => {
  vi.unstubAllGlobals();
  vi.restoreAllMocks();
});

const BUKU_ID = '01JZ0000000000000000000BK1';
const MAJALAH_ID = '01JZ0000000000000000000MJ1';
const UMUM_ID = '01JZ0000000000000000000CT1';

const PATTERN: BarcodePattern = { id: 'default', name: 'Bawaan', prefix: 'B', digits: 7, suffix: '' };

const SPINE: LabelProfile = {
  id: 'spine-a4',
  name: 'Label punggung A4 (3 × 10)',
  kind: 'spine',
  page: 'A4',
  marginMm: { t: 14, r: 10, b: 14, l: 10 },
  cols: 3,
  rows: 10,
  labelWMm: 60,
  labelHMm: 26,
  gapXMm: 5,
  gapYMm: 1,
  fontPt: 9,
  header: '',
  showLibraryName: false,
  symbology: null,
  titleMaxChars: 0,
  border: true,
};

const INDEXES = { isbn: 'bath.isbn', title: 'dc.title', author: 'dc.creator', any: 'cql.serverChoice' };
const PERPUSNAS: SruServer = { id: 'perpusnas', name: 'Perpustakaan Nasional RI', url: '', version: '1.2', recordSchema: 'marcxml', indexes: INDEXES, enabled: false };
const LOC: SruServer = { id: 'loc', name: 'Library of Congress', url: 'http://lx2.loc.gov:210/LCDB', version: '1.1', recordSchema: 'marcxml', indexes: INDEXES, enabled: false };

const CATALOG: CatalogSettings = {
  marcOrgCode: null,
  defaultMaterialTypeId: null,
  defaultCollectionTypeId: null,
  currency: 'IDR',
  barcode: { patterns: [PATTERN], symbology: 'code128' },
  labelProfiles: [SPINE],
  sru: { servers: [PERPUSNAS, LOC], allowPrivateHosts: false },
  isbn: { arsyaEnabled: false },
  attachment: { maxMb: 200 },
  dedupe: { threshold: 80 },
};

const master = { usage: 0, archived: false, version: 1 };
const MATERIAL_TYPES = [
  { ...master, id: BUKU_ID, code: 'BUKU', nameId: 'Buku', nameEn: 'Book', sortOrder: 1 },
  { ...master, id: MAJALAH_ID, code: 'MAJALAH', nameId: 'Majalah', nameEn: 'Magazine', sortOrder: 2 },
] as MaterialTypeView[];
const COLLECTION_TYPES = [{ ...master, id: UMUM_ID, code: 'UMUM', nameId: 'Umum', nameEn: 'General', loanable: true, selfService: true, sortOrder: 1 }] as CollectionTypeView[];

/** `patch` written over `target`: objects merged, lists and values replaced (a key left out keeps its value). */
function applyPatch(target: Record<string, unknown>, patch: Record<string, unknown>): void {
  for (const [key, value] of Object.entries(patch)) {
    const at = target[key];
    if (value !== null && typeof value === 'object' && !Array.isArray(value) && at !== null && typeof at === 'object') {
      applyPatch(at as Record<string, unknown>, value as Record<string, unknown>);
    } else {
      target[key] = structuredClone(value);
    }
  }
}

/** A fake server: the catalog group as stored, the masters, and `POST catalog/sru/test` answering `sruTest`. */
function catalogStore(o: { settings?: Partial<CatalogSettings>; sruTest?: (body: unknown) => SruTestResponse } = {}) {
  const stored = { ...structuredClone(CATALOG), ...structuredClone(o.settings ?? {}) } as CatalogSettings;
  const puts: unknown[] = [];
  const tests: unknown[] = [];
  const routes: Record<string, FakeHandler> = {
    'GET settings/catalog': () => structuredClone(stored),
    'PUT settings/catalog': (req) => {
      puts.push(req.body);
      applyPatch(stored as unknown as Record<string, unknown>, req.body as Record<string, unknown>);
      return { changed: Object.keys(req.body as object).map((k) => `catalog.${k}`) };
    },
    'GET catalog/material-types': () => ({ items: MATERIAL_TYPES }),
    'GET catalog/collection-types': () => ({ items: COLLECTION_TYPES }),
    'POST catalog/sru/test': (req) => {
      tests.push(req.body);
      return (o.sruTest ?? (() => ({ ok: true, version: '1.2' })))(req.body);
    },
  };
  return { stored, puts, tests, routes };
}

/** Opens Pengaturan › Katalog and waits until the form shows the stored values. */
async function open(me = adminMe(), store = catalogStore()) {
  const app = startApp({ me, path: '/admin/settings/catalog', routes: store.routes });
  const currency = (await screen.findByLabelText('Mata uang', undefined, { timeout: 5000 })) as HTMLInputElement;
  await waitFor(() => expect(currency.value).toBe('IDR'));
  return { ...app, store };
}

const input = (label: string, within_: HTMLElement = document.body): HTMLInputElement => within(within_).getByLabelText(label) as HTMLInputElement;

const group = (name: string): HTMLElement => screen.getByRole('group', { name });

/** The whole group is one large form (four sections, three list editors): jsdom renders it slowly on a loaded machine. */
const SLOW = { timeout: 20_000 };

describe('Pengaturan › Katalog', SLOW, () => {
  it('is a section of Pengaturan, next to the other groups', async () => {
    startApp({ me: adminMe(), path: '/admin/settings', routes: catalogStore().routes });
    const sections = await screen.findByRole('navigation', { name: 'Bagian pengaturan' }, { timeout: 5000 });
    expect(within(sections).getByRole('link', { name: 'Katalog' }).getAttribute('href')).toBe('/admin/settings/catalog');
  });

  it('saves every change with one PUT settings/catalog whose body the strict schema accepts', async () => {
    const { store, requests } = await open();
    await waitFor(() => expect(within(screen.getByLabelText('Jenis bahan bawaan')).getAllByRole('option')).toHaveLength(3));
    fireEvent.change(input('Kode organisasi MARC'), { target: { value: 'JKT-ARSYA' } });
    fireEvent.change(screen.getByLabelText('Jenis bahan bawaan'), { target: { value: BUKU_ID } });
    fireEvent.change(screen.getByLabelText('Tipe koleksi bawaan'), { target: { value: UMUM_ID } });
    fireEvent.change(screen.getByLabelText('Simbologi barkod'), { target: { value: 'code39' } });
    fireEvent.click(screen.getByRole('button', { name: 'Tambah pola' }));
    expect(input('Kode pola 2').value).toBe('pola-2');
    fireEvent.change(input('Nama pola 2'), { target: { value: 'Referensi' } });
    fireEvent.change(input('Awalan pola 2'), { target: { value: 'ref' } });
    fireEvent.change(input('Jumlah digit pola 2'), { target: { value: '6' } });
    expect(screen.getByText('REF000001')).toBeTruthy();
    fireEvent.change(input('Ambang skor duplikat'), { target: { value: '85' } });
    fireEvent.click(screen.getByRole('button', { name: 'Simpan' }));

    await waitFor(() => expect(store.puts).toHaveLength(1));
    expect(store.puts[0]).toEqual({
      marcOrgCode: 'JKT-ARSYA',
      defaultMaterialTypeId: BUKU_ID,
      defaultCollectionTypeId: UMUM_ID,
      barcode: { patterns: [PATTERN, { id: 'pola-2', name: 'Referensi', prefix: 'REF', digits: 6, suffix: '' }], symbology: 'code39' },
      dedupe: { threshold: 85 },
    });
    expect(CatalogSettingsBody.safeParse(store.puts[0]).success).toBe(true);
    expect(await screen.findByText('Perubahan disimpan.')).toBeTruthy();
    // The group is read on opening, just before the PUT (has anyone else changed it?) and after it; the saved
    // pattern's code can no longer be changed.
    expect(requests.filter((r) => r.method === 'GET' && r.path === 'settings/catalog')).toHaveLength(3);
    await waitFor(() => expect(input('Kode pola 2').readOnly).toBe(true));
    expect(input('Kode pola 1').readOnly).toBe(true);
  });

  it('a profile change is sent as the whole list, and the sheet preview follows the grid', async () => {
    const { store } = await open();
    const profile = group(SPINE.name);
    expect(within(profile).getByRole('img', { name: `Pratinjau lembar ${SPINE.name}: 3 × 10 label` })).toBeTruthy();
    // A saved profile starts closed: its summary, its preview, and the button that opens its fields.
    expect(within(profile).getByText('Punggung buku (nomor panggil), kertas A4, 3 × 10 label per lembar')).toBeTruthy();
    expect(within(profile).queryByLabelText('Kolom')).toBeNull();
    fireEvent.click(within(profile).getByRole('button', { name: `Ubah rincian ${SPINE.name}` }));
    fireEvent.change(input('Kolom', profile), { target: { value: '2' } });
    fireEvent.change(input('Ukuran kertas', profile), { target: { value: 'custom' } });
    fireEvent.change(input('Lebar kertas (mm)', profile), { target: { value: '150' } });
    await waitFor(() => expect(within(profile).getByRole('img', { name: `Pratinjau lembar ${SPINE.name}: 2 × 10 label` })).toBeTruthy());
    // The preview draws one rectangle per label inside the page.
    expect(within(profile).getByRole('img').querySelectorAll('[data-label-cell]')).toHaveLength(20);
    fireEvent.click(screen.getByRole('button', { name: 'Simpan' }));
    await waitFor(() => expect(store.puts).toHaveLength(1));
    expect(store.puts[0]).toEqual({ labelProfiles: [{ ...SPINE, cols: 2, page: { wMm: 150, hMm: 297 } }] });
    expect(CatalogSettingsBody.safeParse(store.puts[0]).success).toBe(true);
  });

  it('a grid that does not fit its page is refused with the schema check before anything is sent', async () => {
    const { writes } = await open();
    const profile = group(SPINE.name);
    fireEvent.click(within(profile).getByRole('button', { name: `Ubah rincian ${SPINE.name}` }));
    fireEvent.change(input('Kolom', profile), { target: { value: '4' } });
    fireEvent.click(screen.getByRole('button', { name: 'Simpan' }));
    expect(await within(profile).findByText('Label tidak muat di kertas ini. Kurangi jumlah, ukuran, atau jarak label, atau marginnya.')).toBeTruthy();
    expect(writes()).toEqual([]);
  });

  it('a 21st pattern and a 21st profile are refused before anything is sent (M1: 20 of each)', { timeout: 40_000 }, async () => {
    const patterns = Array.from({ length: 20 }, (_, i): BarcodePattern => ({ ...PATTERN, id: `p-${i + 1}`, name: `Pola ${i + 1}`, prefix: `P${i + 1}` }));
    const profiles = Array.from({ length: 20 }, (_, i): LabelProfile => ({ ...SPINE, id: `profil-${i + 1}`, name: `Profil ${i + 1}` }));
    const store = catalogStore({ settings: { barcode: { patterns, symbology: 'code128' }, labelProfiles: profiles } });
    const { writes } = await open(adminMe(), store);
    expect(screen.getAllByLabelText(/^Nama pola \d+$/)).toHaveLength(20);

    fireEvent.click(screen.getByRole('button', { name: 'Tambah pola' }));
    expect(await screen.findByText('Paling banyak 20 pola barkod.')).toBeTruthy();
    expect(screen.getAllByLabelText(/^Nama pola \d+$/)).toHaveLength(20);

    fireEvent.click(screen.getByRole('button', { name: 'Tambah profil' }));
    expect(await screen.findByText('Paling banyak 20 profil label.')).toBeTruthy();
    expect(screen.getAllByRole('button', { name: /^Ubah rincian Profil \d+$/ })).toHaveLength(20);

    fireEvent.click(screen.getByRole('button', { name: 'Simpan' }));
    expect(await screen.findByText('Tidak ada perubahan untuk disimpan.')).toBeTruthy();
    expect(writes()).toEqual([]);
  });

  it('a list another admin changed since the page opened is not overwritten; the newer settings can be loaded', async () => {
    const { store } = await open();
    // Another admin adds a profile meanwhile.
    store.stored.labelProfiles = [SPINE, { ...SPINE, id: 'lain', name: 'Profil admin lain' }];
    const profile = group(SPINE.name);
    fireEvent.click(within(profile).getByRole('button', { name: `Ubah rincian ${SPINE.name}` }));
    fireEvent.change(input('Kolom', profile), { target: { value: '2' } });
    fireEvent.click(screen.getByRole('button', { name: 'Simpan' }));
    expect(await screen.findByText(/^Sejak halaman ini dibuka, pengaturan yang Anda ubah juga diubah di tempat lain\./)).toBeTruthy();
    expect(store.puts).toEqual([]);
    fireEvent.click(screen.getByRole('button', { name: 'Muat pengaturan terbaru' }));
    expect(await screen.findByRole('group', { name: 'Profil admin lain' })).toBeTruthy();
    // A change to another setting still saves: only what the body writes is compared.
    fireEvent.change(input('Mata uang'), { target: { value: 'usd' } });
    fireEvent.click(screen.getByRole('button', { name: 'Simpan' }));
    await waitFor(() => expect(store.puts).toEqual([{ currency: 'USD' }]));
  });

  it('a stored default stays chosen once the masters arrive, an archived one labelled as such, and nothing is sent for it', async () => {
    const archived = { ...COLLECTION_TYPES[0], id: '01JZ0000000000000000000CT2', code: 'LAMA', nameId: 'Koleksi lama', nameEn: 'Old collection', archived: true };
    const store = catalogStore({ settings: { defaultMaterialTypeId: MAJALAH_ID, defaultCollectionTypeId: archived.id } });
    store.routes['GET catalog/collection-types'] = () => ({ items: [...COLLECTION_TYPES, archived] });
    await open(adminMe(), store);
    const material = screen.getByLabelText('Jenis bahan bawaan') as HTMLSelectElement;
    const collection = screen.getByLabelText('Tipe koleksi bawaan') as HTMLSelectElement;
    await waitFor(() => expect(within(material).getAllByRole('option')).toHaveLength(3));
    await waitFor(() => expect(within(collection).getByRole('option', { name: 'Koleksi lama (diarsipkan)' })).toBeTruthy());
    expect(material.value).toBe(MAJALAH_ID);
    expect(material.selectedOptions[0]?.textContent).toBe('Majalah');
    expect(collection.value).toBe(archived.id);
    fireEvent.change(input('Mata uang'), { target: { value: 'usd' } });
    fireEvent.click(screen.getByRole('button', { name: 'Simpan' }));
    await waitFor(() => expect(store.puts).toEqual([{ currency: 'USD' }]));
  });

  it('a duplicate pattern code is refused on its row', async () => {
    const { writes } = await open();
    fireEvent.click(screen.getByRole('button', { name: 'Tambah pola' }));
    fireEvent.change(input('Kode pola 2'), { target: { value: 'default' } });
    fireEvent.change(input('Nama pola 2'), { target: { value: 'Kedua' } });
    fireEvent.click(screen.getByRole('button', { name: 'Simpan' }));
    await waitFor(() => expect(input('Kode pola 2').getAttribute('aria-invalid')).toBe('true'));
    expect(screen.getByText(/Kode ini sudah dipakai di daftar ini\./)).toBeTruthy();
    expect(writes()).toEqual([]);
  });
});

describe('Pengaturan › Katalog: SRU servers', SLOW, () => {
  it('"Uji" posts the URL and version and shows the failure message the server gave', async () => {
    const store = catalogStore({ sruTest: () => ({ ok: false, code: 'CATALOG_SRU_INVALID', message: 'Unsupported version: 1.1' }) });
    await open(adminMe(), store);
    fireEvent.click(screen.getByRole('button', { name: 'Uji server Library of Congress' }));
    expect(await screen.findByText('Uji gagal: Unsupported version: 1.1')).toBeTruthy();
    expect(store.tests).toEqual([{ url: 'http://lx2.loc.gov:210/LCDB', version: '1.1' }]);
    // The answer is about the URL and version it tested: it goes once the row holds another.
    fireEvent.change(input('Versi SRU', group('Library of Congress')), { target: { value: '1.2' } });
    await waitFor(() => expect(screen.queryByText('Uji gagal: Unsupported version: 1.1')).toBeNull());
  });

  it('"Uji" of a server that answered names its version; an empty URL is not sent', async () => {
    const store = catalogStore({ sruTest: () => ({ ok: true, version: '1.2' }) });
    await open(adminMe(), store);
    fireEvent.click(screen.getByRole('button', { name: 'Uji server Library of Congress' }));
    expect(await screen.findByText('Server menjawab dengan benar (SRU 1.2).')).toBeTruthy();
    fireEvent.click(screen.getByRole('button', { name: 'Uji server Perpustakaan Nasional RI' }));
    expect(await screen.findByText('Isi URL dasar yang benar terlebih dahulu.')).toBeTruthy();
    expect(store.tests).toHaveLength(1);
  });

  it('an enabled server without a URL is refused on its URL field', async () => {
    const { writes } = await open();
    const perpusnas = group('Perpustakaan Nasional RI');
    fireEvent.click(within(perpusnas).getByLabelText('Aktif'));
    fireEvent.click(screen.getByRole('button', { name: 'Simpan' }));
    await waitFor(() => expect(input('URL dasar', perpusnas).getAttribute('aria-invalid')).toBe('true'));
    expect(writes()).toEqual([]);
  });

  it('"Izinkan host privat" is read-only for an admin, with the reason; there is no ISBN-service switch', async () => {
    await open(adminMe());
    expect(input('Izinkan host privat').disabled).toBe(true);
    expect(screen.getByText('Hanya super admin yang dapat mengubah pengaturan ini.')).toBeTruthy();
    expect(screen.queryByLabelText(/layanan ISBN/i)).toBeNull();
    expect(screen.queryByText(/layanan ISBN|ketentuan layanan/i)).toBeNull();
  });

  it('a stored isbn.arsyaEnabled is never sent, even when it is true', async () => {
    const { store } = await open(adminMe(), catalogStore({ settings: { isbn: { arsyaEnabled: true } } }));
    fireEvent.change(input('Mata uang'), { target: { value: 'USD' } });
    fireEvent.click(screen.getByRole('button', { name: 'Simpan' }));
    await waitFor(() => expect(store.puts).toEqual([{ currency: 'USD' }]));
  });

  it('a super admin may switch "Izinkan host privat"; it is saved in the same body', async () => {
    const { store } = await open(superMe());
    const allow = input('Izinkan host privat');
    expect(allow.disabled).toBe(false);
    expect(screen.queryByText('Hanya super admin yang dapat mengubah pengaturan ini.')).toBeNull();
    fireEvent.click(allow);
    fireEvent.click(screen.getByRole('button', { name: 'Simpan' }));
    await waitFor(() => expect(store.puts).toEqual([{ sru: { allowPrivateHosts: true } }]));
  });
});

describe('Pengaturan › Katalog: read-only', SLOW, () => {
  it('with system.settings.read only, nothing can be changed or tested and the masters are not asked for', async () => {
    const { requests } = await open(signedIn({ permissions: ['system.settings.read'] }));
    expect(input('Mata uang').disabled).toBe(true);
    expect(input('Nama pola 1').disabled).toBe(true);
    expect(screen.queryByRole('button', { name: 'Simpan' })).toBeNull();
    expect(screen.queryByRole('button', { name: 'Tambah pola' })).toBeNull();
    expect(screen.queryByRole('button', { name: 'Uji server Library of Congress' })).toBeNull();
    expect(requests.some((r) => r.path.startsWith('catalog/'))).toBe(false);
  });
});
