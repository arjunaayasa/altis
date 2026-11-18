import type { PageListItem } from '@altis/shared/api/opac-pages';
import { AccreditationSettingsBody, type AccreditationSettingsView } from '@altis/shared/api/settings';
import { fireEvent, screen, waitFor, within } from '@testing-library/react';
import { afterEach, describe, expect, it, vi } from 'vitest';
import { adminMe, signedIn, startApp, type FakeRequest } from '../fake-api';

// Pengaturan › Akreditasi: the sixteen settings of the `accreditation` group in one form, saved with one
// `PUT settings/accreditation` whose body holds the settings that changed (a list goes whole). The code and prefix
// lists are chips; the website features pick OPAC pages from `GET opac/pages` for a user who manages pages, and take a
// page id otherwise; the group of members deleted in SLiMS offers "Otomatis". The form checks the numbers against the
// shared schemas' bounds before anything is sent.

afterEach(() => {
  vi.unstubAllGlobals();
  vi.restoreAllMocks();
});

const PAGE_PROFILE = '01JZ0000000000000000000PG1';
const PAGE_CONTACT = '01JZ0000000000000000000PG2';
const PAGE_DRAFT = '01JZ0000000000000000000PG3';

const VIEW: AccreditationSettingsView = {
  schoolYearStartMonth: 7,
  fiction: { collectionTypeCodes: ['FIKSI'], callNumberPrefixes: [], ddcPrefixes: [] },
  referenceCollectionTypeCodes: ['REF'],
  electronicMaterialTypeCodes: ['EBOOK'],
  usedUnit: 'titles',
  websiteFeatures: {},
  liveFrom: null,
  evidence: { maxMb: 5, componentLimitMb: 9 },
  textbookCollectionTypeCodes: [],
  k7: { processedThresholdPct: 100 },
  undatedShareMaxPct: 10,
  visits: { dedupeLegacy: true },
  unknownMemberGroup: { default: 'auto' },
};

function page(id: string, title: string, slug: string, status: 'draft' | 'published' = 'published'): PageListItem {
  return { id, kind: 'page', slug, status, publishedAt: status === 'published' ? 1_760_000_000_000 : null, showInNav: true, category: null, eventStartsAt: null, title, hasEnglish: false, updatedAt: null, version: 1 };
}

const PAGES = [page(PAGE_PROFILE, 'Profil Perpustakaan', 'profil'), page(PAGE_CONTACT, 'Hubungi Kami', 'kontak'), page(PAGE_DRAFT, 'Layanan Baru', 'layanan', 'draft')];

/** `patch` written over `target`: objects merged, lists and values replaced. */
function applyPatch(target: Record<string, unknown>, patch: Record<string, unknown>): void {
  for (const [key, value] of Object.entries(patch)) {
    const at = target[key];
    if (value !== null && typeof value === 'object' && !Array.isArray(value) && key !== 'websiteFeatures' && at !== null && typeof at === 'object') {
      applyPatch(at as Record<string, unknown>, value as Record<string, unknown>);
    } else {
      target[key] = structuredClone(value);
    }
  }
}

function start(me = adminMe(), view: AccreditationSettingsView = VIEW) {
  const stored = structuredClone(view);
  const puts: unknown[] = [];
  const app = startApp({
    me,
    path: '/admin/settings/accreditation',
    routes: {
      'GET settings/accreditation': () => structuredClone(stored),
      'PUT settings/accreditation': (req) => {
        puts.push(req.body);
        applyPatch(stored as unknown as Record<string, unknown>, req.body as Record<string, unknown>);
        return { changed: [] };
      },
      'GET opac/pages': () => ({ items: PAGES, nextCursor: null }),
    },
  });
  return { ...app, stored, puts };
}

/** Waits until the form shows the stored group. */
async function opened(): Promise<void> {
  const month = (await screen.findByLabelText('Bulan awal tahun ajaran', undefined, { timeout: 10_000 })) as HTMLSelectElement;
  await waitFor(() => expect(month.value).toBe('7'));
}

const field = (label: string): HTMLInputElement => screen.getByLabelText(label) as HTMLInputElement;

/** Types `value` into the chip field labelled `label` and adds it. */
function addChip(label: string, value: string): void {
  fireEvent.change(field(label), { target: { value } });
  fireEvent.click(screen.getByRole('button', { name: `Tambah ke ${label}` }));
}

/** The chips a list holds, as shown. */
const chips = (label: string): string[] =>
  within(screen.getByRole('list', { name: `${label}, isi saat ini` }))
    .queryAllByRole('listitem')
    .map((li) => li.getAttribute('data-chip') ?? '');

const pageGets = (requests: FakeRequest[]): FakeRequest[] => requests.filter((r) => r.method === 'GET' && r.path === 'opac/pages');

/** Leaf settings of a body: `fiction.ddcPrefixes`, `websiteFeatures`, ... */
function settingKeys(body: Record<string, unknown>, prefix = ''): string[] {
  return Object.entries(body).flatMap(([key, value]) =>
    value !== null && typeof value === 'object' && !Array.isArray(value) && key !== 'websiteFeatures'
      ? settingKeys(value as Record<string, unknown>, `${prefix}${key}.`)
      : [`${prefix}${key}`],
  );
}

const SLOW = { timeout: 30_000 };

describe('Pengaturan › Akreditasi', SLOW, () => {
  it('is a section of Pengaturan', async () => {
    start();
    await opened();
    const sections = screen.getByRole('navigation', { name: 'Bagian pengaturan' });
    expect(within(sections).getByRole('link', { name: 'Akreditasi' }).getAttribute('href')).toBe('/admin/settings/accreditation');
    expect(document.querySelector('[data-screen-placeholder]')).toBeNull();
  });

  it('saving after a change of every setting posts the sixteen keys, which the strict schema accepts', async () => {
    const { puts, requests, stored } = start();
    await opened();
    expect(chips('Tipe koleksi fiksi (kode)')).toEqual(['FIKSI']);
    expect(chips('Tipe koleksi buku teks (kode)')).toEqual([]);

    fireEvent.change(screen.getByLabelText('Bulan awal tahun ajaran'), { target: { value: '1' } });
    fireEvent.change(field('Mulai bekerja di ALTIS'), { target: { value: '2025-07-01' } });
    addChip('Tipe koleksi fiksi (kode)', ' fiksi-anak ');
    addChip('Awalan nomor panggil fiksi', 'F');
    addChip('Awalan DDC fiksi', '899.221 3');
    fireEvent.click(screen.getByRole('button', { name: 'Hapus REF dari Tipe koleksi referensi (kode)' }));
    addChip('Tipe koleksi referensi (kode)', 'referensi');
    // Enter adds too.
    fireEvent.change(field('Jenis bahan elektronik (kode)'), { target: { value: 'cd' } });
    fireEvent.keyDown(field('Jenis bahan elektronik (kode)'), { key: 'Enter' });
    addChip('Tipe koleksi buku teks (kode)', 'TEKS');
    fireEvent.change(screen.getByLabelText('Satuan koleksi terpakai'), { target: { value: 'items' } });
    fireEvent.change(field('Ambang koleksi terolah (%)'), { target: { value: '95' } });
    fireEvent.change(field('Batas eksemplar tanpa tanggal perolehan (%)'), { target: { value: '15' } });

    const profile = screen.getByLabelText('Halaman profil perpustakaan') as HTMLSelectElement;
    await waitFor(() => expect(profile.options.length).toBe(4));
    expect([...profile.options].map((o) => o.textContent)).toEqual(['(tidak dipilih)', 'Profil Perpustakaan (/profil)', 'Hubungi Kami (/kontak)', 'Layanan Baru (/layanan, draf)']);
    fireEvent.change(profile, { target: { value: PAGE_PROFILE } });
    fireEvent.change(screen.getByLabelText('Halaman kontak'), { target: { value: PAGE_CONTACT } });
    addChip('Alamat media sosial', 'https://instagram.com/perpus');

    fireEvent.change(field('Ukuran terbesar satu berkas bukti (MB)'), { target: { value: '8' } });
    fireEvent.change(field('Batas ukuran bukti per komponen (MB)'), { target: { value: '10' } });
    fireEvent.click(screen.getByRole('checkbox', { name: 'Abaikan kunjungan berulang dari data SLiMS' }));
    fireEvent.change(screen.getByLabelText('Kelompok anggota SLiMS yang sudah dihapus'), { target: { value: 'teacher' } });

    fireEvent.click(screen.getByRole('button', { name: 'Simpan' }));
    await waitFor(() => expect(puts).toHaveLength(1));
    const body = puts[0] as Record<string, unknown>;
    expect(body).toEqual({
      schoolYearStartMonth: 1,
      fiction: { collectionTypeCodes: ['FIKSI', 'FIKSI-ANAK'], callNumberPrefixes: ['F'], ddcPrefixes: ['899.221 3'] },
      referenceCollectionTypeCodes: ['REFERENSI'],
      electronicMaterialTypeCodes: ['EBOOK', 'CD'],
      usedUnit: 'items',
      websiteFeatures: { profilePageId: PAGE_PROFILE, contactPageId: PAGE_CONTACT, socialUrls: ['https://instagram.com/perpus'] },
      liveFrom: '2025-07-01',
      evidence: { maxMb: 8, componentLimitMb: 10 },
      textbookCollectionTypeCodes: ['TEKS'],
      k7: { processedThresholdPct: 95 },
      undatedShareMaxPct: 15,
      visits: { dedupeLegacy: false },
      unknownMemberGroup: { default: 'teacher' },
    });
    expect(settingKeys(body)).toHaveLength(16);
    expect(AccreditationSettingsBody.safeParse(body).success).toBe(true);
    expect(await screen.findByText('Perubahan disimpan.')).toBeTruthy();
    expect(stored.k7.processedThresholdPct).toBe(95);
    expect(pageGets(requests).length).toBeGreaterThan(0);

    // Saved: the form starts over from what the server holds, and a second save sends nothing.
    await waitFor(() => expect(chips('Tipe koleksi referensi (kode)')).toEqual(['REFERENSI']));
    fireEvent.click(screen.getByRole('button', { name: 'Simpan' }));
    expect(await screen.findByText('Tidak ada perubahan untuk disimpan.')).toBeTruthy();
    expect(puts).toHaveLength(1);
  });

  it('processedThresholdPct 40 shows the field error and sends nothing', async () => {
    const { puts } = start();
    await opened();
    const threshold = field('Ambang koleksi terolah (%)');
    fireEvent.change(threshold, { target: { value: '40' } });
    fireEvent.click(screen.getByRole('button', { name: 'Simpan' }));
    await waitFor(() => expect(threshold.getAttribute('aria-invalid')).toBe('true'));
    const error = document.getElementById(threshold.getAttribute('aria-describedby')!.split(' ')[0]!);
    expect(error?.textContent).toBe('Isi bilangan bulat dalam rentang yang tertera.');
    expect(screen.getByText(/Antara 50 dan 100/)).toBeTruthy();
    expect(puts).toEqual([]);
  });

  it('a chip list refuses a duplicate and a list that is full', async () => {
    start(adminMe(), { ...VIEW, referenceCollectionTypeCodes: Array.from({ length: 20 }, (_, i) => `REF${i + 1}`) });
    await opened();
    addChip('Tipe koleksi fiksi (kode)', 'fiksi');
    expect(screen.getByText('FIKSI sudah ada di daftar.')).toBeTruthy();
    expect(chips('Tipe koleksi fiksi (kode)')).toEqual(['FIKSI']);
    addChip('Tipe koleksi referensi (kode)', 'KAMUS');
    expect(screen.getByText('Daftar ini paling banyak berisi 20 isian.')).toBeTruthy();
    expect(chips('Tipe koleksi referensi (kode)')).toHaveLength(20);
  });

  it('the group of deleted SLiMS members offers "Otomatis", the five groups and none (sent as null)', async () => {
    const { puts } = start();
    await opened();
    const group = screen.getByLabelText('Kelompok anggota SLiMS yang sudah dihapus') as HTMLSelectElement;
    expect(group.value).toBe('auto');
    expect([...group.options].map((o) => o.textContent)).toEqual([
      'Otomatis (siswa untuk perpustakaan sekolah)',
      'Siswa/Mahasiswa',
      'Guru/Dosen',
      'Tenaga kependidikan',
      'Umum',
      'Lainnya',
      'Tidak dihitung pada kelompok mana pun',
    ]);
    fireEvent.change(group, { target: { value: 'none' } });
    fireEvent.click(screen.getByRole('button', { name: 'Simpan' }));
    await waitFor(() => expect(puts).toEqual([{ unknownMemberGroup: { default: null } }]));
  });

  it('without opac.pages.manage a page is given by its id, and the pages are not read', async () => {
    const { puts, requests } = start(signedIn({ permissions: ['system.settings.read', 'system.settings.manage'] }), {
      ...VIEW,
      websiteFeatures: { faqPageId: PAGE_DRAFT },
    });
    await opened();
    const faq = field('Halaman tanya jawab (FAQ)');
    expect(faq.tagName).toBe('INPUT');
    expect(faq.value).toBe(PAGE_DRAFT);
    const profile = field('Halaman profil perpustakaan');
    fireEvent.change(profile, { target: { value: 'bukan-id' } });
    fireEvent.click(screen.getByRole('button', { name: 'Simpan' }));
    await waitFor(() => expect(profile.getAttribute('aria-invalid')).toBe('true'));
    expect(puts).toEqual([]);
    fireEvent.change(profile, { target: { value: PAGE_PROFILE } });
    fireEvent.click(screen.getByRole('button', { name: 'Simpan' }));
    await waitFor(() => expect(puts).toEqual([{ websiteFeatures: { profilePageId: PAGE_PROFILE, faqPageId: PAGE_DRAFT } }]));
    expect(pageGets(requests)).toEqual([]);
  });

  it('a reader without system.settings.manage sees every setting disabled and no save button', async () => {
    start(signedIn({ permissions: ['system.settings.read'] }));
    await opened();
    expect(field('Ambang koleksi terolah (%)').disabled).toBe(true);
    expect(field('Tipe koleksi fiksi (kode)').disabled).toBe(true);
    expect((screen.getByLabelText('Bulan awal tahun ajaran') as HTMLSelectElement).disabled).toBe(true);
    expect(screen.queryByRole('button', { name: 'Hapus FIKSI dari Tipe koleksi fiksi (kode)' })).toBeNull();
    expect(screen.queryByRole('button', { name: 'Simpan' })).toBeNull();
  });
});
