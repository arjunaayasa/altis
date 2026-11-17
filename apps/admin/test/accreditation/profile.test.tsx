import type { AccredProfile, EvidenceView, PeriodView } from '@altis/shared/api/accreditation';
import { act, fireEvent, screen, waitFor, within } from '@testing-library/react';
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import { resizeImage } from '@/lib/image-resize';
import { dirtyForms } from '@/lib/dirty-forms';
import { uploadFile } from '@/lib/upload';
import { accreditationKeys } from '@/screens/accreditation/data';
import { adminMe, json, problem, startApp, type FakeHandler } from '../fake-api';
import { PERIOD_ID, T0, indicatorResult, instrumentsAnswer, periodView, periodsAnswer, resultsView } from './workspace-fixtures';

// Profil and Populasi & Sarana keep the version they were opened or last saved with: a photo named, taken out or
// deleted below the form keeps what was typed, another librarian's save is never overwritten (Simpan is refused as
// stale until the form is read again), and after its own save the form shows the values as stored. Both ask before
// the page is left with unsaved changes. The profile photos are evidence files of the period: each can be deleted
// with its file (it then leaves the evidence ZIP), a photo no longer in the profile is listed with its own delete, and
// only images are taken for a photo.

vi.mock('@/lib/image-resize', async (importOriginal) => {
  const real = await importOriginal<typeof import('@/lib/image-resize')>();
  return { ...real, resizeImage: vi.fn() };
});
vi.mock('@/lib/upload', () => ({ uploadFile: vi.fn() }));

const FIRST = { timeout: 10_000 };
const FILE_NEW = '01JZ0000000000000000FIL002';
const FILE_OLD = '01JZ0000000000000000FIL001';
const EVD_NEW = '01JZ0000000000000000EVD002';
const EVD_OLD = '01JZ0000000000000000EVD001';
const NPP = 'NPP (Nomor Pokok Perpustakaan)';

beforeEach(() => {
  vi.mocked(resizeImage).mockReset();
  vi.mocked(uploadFile).mockReset();
});

afterEach(() => {
  vi.unstubAllGlobals();
  vi.restoreAllMocks();
});

function photo(id: string, fileId: string, fileName: string, o: Partial<EvidenceView> = {}): EvidenceView {
  return {
    id,
    periodId: PERIOD_ID,
    indicatorCode: 'SCH-PROFIL',
    evidenceCode: 'photo_front',
    entity: null,
    entityId: null,
    fileId,
    fileName,
    size: 120_000,
    mime: 'image/jpeg',
    caption: '',
    sortOrder: 0,
    createdAt: T0,
    ...o,
  };
}

/**
 * The workspace on tab `tab`, over a fake server that keeps the period and its profile evidence: a PATCH naming an
 * older version is refused, one naming the current version merges the profile and moves the version, and deleting a
 * photo's evidence empties the slot that named it (moving the version), as the real server does.
 */
function open(o: { tab: 'profil' | 'populasi'; period?: PeriodView; evidence?: EvidenceView[] }) {
  let period = o.period ?? periodView();
  let evidence = [...(o.evidence ?? [])];
  const routes: Record<string, FakeHandler> = {
    'GET accreditation/instruments': () => instrumentsAnswer(),
    'GET accreditation/periods': () => periodsAnswer(period),
    'GET accreditation/periods/:id': () => period,
    'GET accreditation/periods/:id/results': () => resultsView({ indicators: [indicatorResult('SCH-K1', 'K1', 'K')] }),
    'GET accreditation/periods/:id/snapshots': () => ({ snapshots: [] }),
    'GET accreditation/evidence': () => ({ evidence, componentBytes: { K: 0, SP: 0, L: 0, T: 0, F: 0, G: 0, profil: 0 } }),
    'POST accreditation/evidence': (req) => {
      const b = req.body as { uploadId: string; indicatorCode: string; evidenceCode: string; caption: string };
      evidence = [...evidence, photo(EVD_NEW, b.uploadId, 'depan-baru.jpg', { evidenceCode: b.evidenceCode, caption: b.caption, createdAt: T0 + 5_000 })];
      return json({ id: EVD_NEW, version: 0 }, 201);
    },
    'DELETE accreditation/evidence/:id': (req) => {
      const gone = evidence.find((e) => e.id === req.params['id']);
      evidence = evidence.filter((e) => e.id !== req.params['id']);
      const photos = period.profile.photos;
      if (gone !== undefined && photos != null && Object.values(photos).includes(gone.fileId)) {
        const emptied = Object.fromEntries(Object.entries(photos).map(([slot, id]) => [slot, id === gone.fileId ? null : id]));
        period = { ...period, profile: { ...period.profile, photos: emptied as AccredProfile['photos'] }, version: period.version + 1 };
      }
      return { id: req.params['id'], version: 0 };
    },
    'PATCH accreditation/periods/:id': (req) => {
      const { version, profile, ...rest } = req.body as { version: number; profile?: AccredProfile } & Partial<PeriodView>;
      if (version !== period.version) return problem(409, 'CONFLICT_STALE');
      period = { ...period, ...rest, profile: { ...period.profile, ...profile }, version: period.version + 1 };
      return { id: PERIOD_ID, version: period.version };
    },
  };
  const app = startApp({ me: adminMe(), path: `/admin/accreditation/${PERIOD_ID}?tab=${o.tab}`, routes });
  return {
    ...app,
    period: () => period,
    /** Another librarian's save: the period changes on the server, and this page reads it again. */
    async changedElsewhere(change: (p: PeriodView) => PeriodView): Promise<void> {
      period = { ...change(period), version: period.version + 1 };
      await act(() => app.queryClient.invalidateQueries({ queryKey: accreditationKeys.period(PERIOD_ID) }));
    },
  };
}

const patches = (app: ReturnType<typeof open>): unknown[] => app.requests.filter((r) => r.method === 'PATCH').map((r) => r.body);

const field = (role: 'textbox' | 'spinbutton', name: string): HTMLInputElement => screen.getByRole(role, { name }) as HTMLInputElement;

/** The note of a form whose period was changed elsewhere while something is typed. */
const STALE = /sudah diubah di tempat lain setelah formulir ini dibuka/;
const STALE_REFUSAL = 'Data ini sudah diubah oleh orang lain. Muat ulang, lalu coba lagi.';

describe('Profil', () => {
  it('a photo uploaded below the form keeps what was typed above it, and Simpan then sends it with the new version', async () => {
    vi.mocked(resizeImage).mockResolvedValue(new Blob([new Uint8Array(2048)], { type: 'image/jpeg' }));
    vi.mocked(uploadFile).mockResolvedValue({ uploadId: FILE_NEW });
    const app = open({ tab: 'profil' });
    const npp = await screen.findByRole('textbox', { name: NPP }, FIRST);
    fireEvent.change(npp, { target: { value: '3301099999' } });
    fireEvent.change(screen.getByRole('textbox', { name: 'Kepala sekolah' }), { target: { value: 'Drs. Budi Santoso' } });

    const photos = screen.getByRole('region', { name: 'Foto profil' });
    const front = within(photos).getByText('Tampak depan perpustakaan').closest('li') as HTMLElement;
    fireEvent.click(within(front).getByRole('button', { name: 'Unggah foto' }));
    const dialog = await screen.findByRole('form', { name: 'Unggah foto' });
    await within(dialog).findByText(/paling besar \d+ MB/);
    fireEvent.change(within(dialog).getByLabelText('Berkas'), { target: { files: [new File([new Uint8Array(4096)], 'depan.png', { type: 'image/png' })] } });
    fireEvent.click(within(dialog).getByRole('button', { name: 'Unggah' }));

    // The photo is named in the profile (the period's version moves) and the period is read again.
    await waitFor(() => expect(app.period().version).toBe(4));
    expect(patches(app)).toEqual([{ version: 3, profile: { photos: { front: FILE_NEW, collection: null, staff: null, readingRoom: null } } }]);
    expect(await within(front).findByRole('link', { name: 'depan-baru.jpg' })).toBeTruthy();
    expect((screen.getByRole('textbox', { name: NPP }) as HTMLInputElement).value).toBe('3301099999');
    expect((screen.getByRole('textbox', { name: 'Kepala sekolah' }) as HTMLInputElement).value).toBe('Drs. Budi Santoso');

    fireEvent.click(screen.getByRole('button', { name: 'Simpan' }));
    await waitFor(() => expect(patches(app)).toHaveLength(2));
    expect(patches(app)[1]).toEqual({ version: 4, profile: { npp: '3301099999', schoolHead: 'Drs. Budi Santoso' } });
    expect(app.period().profile).toMatchObject({ npp: '3301099999', schoolHead: 'Drs. Budi Santoso', photos: { front: FILE_NEW } });
  });

  it('a period changed elsewhere while something is typed is never overwritten: Simpan is refused as stale until the form is read again', async () => {
    const app = open({ tab: 'profil' });
    fireEvent.change(await screen.findByRole('textbox', { name: NPP }, FIRST), { target: { value: '3301099999' } });
    await app.changedElsewhere((p) => ({ ...p, profile: { ...p.profile, npp: '3301077777', schoolName: 'SMA Negeri Contoh' } }));
    // The form stays on the version it was opened with, and says that the period moved on.
    expect(await screen.findByText(STALE)).toBeTruthy();
    expect(field('textbox', NPP).value).toBe('3301099999');
    expect(field('textbox', 'Nama sekolah').value).toBe('SMA Contoh');

    fireEvent.click(screen.getByRole('button', { name: 'Simpan' }));
    expect(await screen.findByText(STALE_REFUSAL)).toBeTruthy();
    expect(patches(app)).toEqual([{ version: 3, profile: { npp: '3301099999' } }]);
    expect(app.period()).toMatchObject({ version: 4, profile: { npp: '3301077777', schoolName: 'SMA Negeri Contoh' } });

    // Read again: what is stored now, and a save over it.
    fireEvent.click(screen.getByRole('button', { name: 'Muat ulang data tersimpan' }));
    await waitFor(() => expect(field('textbox', NPP).value).toBe('3301077777'));
    expect(field('textbox', 'Nama sekolah').value).toBe('SMA Negeri Contoh');
    expect(screen.queryByText(STALE)).toBeNull();
    expect(screen.queryByText(STALE_REFUSAL)).toBeNull();
    fireEvent.change(field('textbox', 'Kepala sekolah'), { target: { value: 'Drs. Budi Santoso' } });
    fireEvent.click(screen.getByRole('button', { name: 'Simpan' }));
    await waitFor(() => expect(patches(app)).toHaveLength(2));
    expect(patches(app)[1]).toEqual({ version: 4, profile: { schoolHead: 'Drs. Budi Santoso' } });
    expect(app.period().profile).toMatchObject({ npp: '3301077777', schoolName: 'SMA Negeri Contoh', schoolHead: 'Drs. Budi Santoso' });
  });

  it('with nothing typed, a period changed elsewhere is simply shown', async () => {
    const app = open({ tab: 'profil' });
    await screen.findByRole('textbox', { name: NPP }, FIRST);
    await app.changedElsewhere((p) => ({ ...p, profile: { ...p.profile, schoolName: 'SMA Negeri Contoh' } }));
    await waitFor(() => expect(field('textbox', 'Nama sekolah').value).toBe('SMA Negeri Contoh'));
    expect(screen.queryByText(STALE)).toBeNull();
    fireEvent.change(field('textbox', NPP), { target: { value: '3301099999' } });
    fireEvent.click(screen.getByRole('button', { name: 'Simpan' }));
    await waitFor(() => expect(patches(app)).toHaveLength(1));
    expect(patches(app)[0]).toEqual({ version: 4, profile: { npp: '3301099999' } });
  });

  it('after its own save the form shows the values as stored, so a later change made elsewhere is shown and never sent back', async () => {
    const app = open({ tab: 'profil' });
    // A trailing space is not stored: the stored name has none.
    fireEvent.change(await screen.findByRole('textbox', { name: 'Kepala sekolah' }, FIRST), { target: { value: 'Drs. Budi Santoso  ' } });
    fireEvent.click(screen.getByRole('button', { name: 'Simpan' }));
    expect(await screen.findByText('Perubahan disimpan.')).toBeTruthy();
    expect(patches(app)).toEqual([{ version: 3, profile: { schoolHead: 'Drs. Budi Santoso' } }]);
    await waitFor(() => expect(field('textbox', 'Kepala sekolah').value).toBe('Drs. Budi Santoso'));

    await app.changedElsewhere((p) => ({ ...p, profile: { ...p.profile, schoolHead: 'Dra. Siti Aminah' } }));
    await waitFor(() => expect(field('textbox', 'Kepala sekolah').value).toBe('Dra. Siti Aminah'));
    expect(screen.queryByText(STALE)).toBeNull();
    fireEvent.change(field('textbox', NPP), { target: { value: '3301099999' } });
    fireEvent.click(screen.getByRole('button', { name: 'Simpan' }));
    await waitFor(() => expect(patches(app)).toHaveLength(2));
    expect(patches(app)[1]).toEqual({ version: 5, profile: { npp: '3301099999' } });
    expect(app.period().profile).toMatchObject({ npp: '3301099999', schoolHead: 'Dra. Siti Aminah' });
  });

  it('taking a photo out of the profile and deleting a photo it names keep what was typed, and Simpan then sends it with the new version', async () => {
    const app = open({
      tab: 'profil',
      period: periodView({ profile: { npp: '3301012345', schoolName: 'SMA Contoh', photos: { front: FILE_NEW, collection: FILE_OLD, staff: null, readingRoom: null } } }),
      evidence: [photo(EVD_NEW, FILE_NEW, 'depan.jpg'), photo(EVD_OLD, FILE_OLD, 'koleksi.jpg', { evidenceCode: 'photo_collection' })],
    });
    fireEvent.change(await screen.findByRole('textbox', { name: NPP }, FIRST), { target: { value: '3301099999' } });
    const photos = screen.getByRole('region', { name: 'Foto profil' });
    const front = within(photos).getByText('Tampak depan perpustakaan').closest('li') as HTMLElement;
    const collection = within(photos).getByText('Ruang koleksi').closest('li') as HTMLElement;

    fireEvent.click(await within(front).findByRole('button', { name: 'Lepas dari profil' }));
    await waitFor(() => expect(app.period().version).toBe(4));
    await waitFor(() => expect(within(front).getByText('belum')).toBeTruthy());
    expect(field('textbox', NPP).value).toBe('3301099999');

    fireEvent.click(await within(collection).findByRole('button', { name: 'Hapus foto koleksi.jpg' }));
    const confirm = await screen.findByRole('alertdialog', { name: 'Hapus foto koleksi.jpg?' });
    fireEvent.click(within(confirm).getByRole('button', { name: 'Hapus foto' }));
    await waitFor(() => expect(app.period().version).toBe(5));
    await waitFor(() => expect(within(collection).getByText('belum')).toBeTruthy());
    expect(field('textbox', NPP).value).toBe('3301099999');
    expect(screen.queryByText(STALE)).toBeNull();

    fireEvent.click(screen.getByRole('button', { name: 'Simpan' }));
    await waitFor(() => expect(patches(app)).toHaveLength(2));
    expect(patches(app)[1]).toEqual({ version: 5, profile: { npp: '3301099999' } });
    expect(app.period().profile).toMatchObject({ npp: '3301099999', photos: { front: null, collection: null } });
  });

  it('unsaved changes ask before the page is left, until they are saved', async () => {
    open({ tab: 'profil' });
    const before = dirtyForms.count();
    fireEvent.change(await screen.findByRole('textbox', { name: NPP }, FIRST), { target: { value: '3301099999' } });
    await waitFor(() => expect(dirtyForms.count()).toBe(before + 1));
    fireEvent.click(screen.getByRole('button', { name: 'Simpan' }));
    expect(await screen.findByText('Perubahan disimpan.')).toBeTruthy();
    await waitFor(() => expect(dirtyForms.count()).toBe(before));
  });

  it('a photo is deleted with its evidence file after a confirmation; a photo no longer in the profile has its own delete', async () => {
    const app = open({
      tab: 'profil',
      period: periodView({ profile: { npp: '3301012345', photos: { front: FILE_NEW, collection: null, staff: null, readingRoom: null } } }),
      evidence: [photo(EVD_OLD, FILE_OLD, 'depan-lama.jpg'), photo(EVD_NEW, FILE_NEW, 'depan-baru.jpg', { createdAt: T0 + 5_000 })],
    });
    const photos = await screen.findByRole('region', { name: 'Foto profil' }, FIRST);
    const front = within(photos).getByText('Tampak depan perpustakaan').closest('li') as HTMLElement;
    expect(await within(front).findByRole('link', { name: 'depan-baru.jpg' })).toBeTruthy();
    // The replaced photo is still the period's evidence (it goes into the evidence ZIP) until it is deleted.
    const old = (await within(front).findByRole('link', { name: 'depan-lama.jpg' })).closest('li') as HTMLElement;
    expect(within(old).getByText('Tidak dipakai di profil, tetapi tetap masuk ZIP berkas bukti sampai dihapus.')).toBeTruthy();

    fireEvent.click(within(front).getByRole('button', { name: 'Hapus foto depan-lama.jpg' }));
    const confirmOld = await screen.findByRole('alertdialog', { name: 'Hapus foto depan-lama.jpg?' });
    fireEvent.click(within(confirmOld).getByRole('button', { name: 'Hapus foto' }));
    await waitFor(() => expect(within(front).queryByRole('link', { name: 'depan-lama.jpg' })).toBeNull());

    fireEvent.click(within(front).getByRole('button', { name: 'Hapus foto depan-baru.jpg' }));
    const confirmNew = await screen.findByRole('alertdialog', { name: 'Hapus foto depan-baru.jpg?' });
    fireEvent.click(within(confirmNew).getByRole('button', { name: 'Hapus foto' }));
    await waitFor(() => expect(within(front).getByText('belum')).toBeTruthy());
    expect(app.writes()).toEqual([`DELETE accreditation/evidence/${EVD_OLD}`, `DELETE accreditation/evidence/${EVD_NEW}`]);
    expect(app.period().profile.photos?.front).toBeNull();
  });

  it('a photo takes images only: a PDF is refused before anything is sent', async () => {
    const app = open({ tab: 'profil' });
    const photos = await screen.findByRole('region', { name: 'Foto profil' }, FIRST);
    const front = within(photos).getByText('Tampak depan perpustakaan').closest('li') as HTMLElement;
    fireEvent.click(within(front).getByRole('button', { name: 'Unggah foto' }));
    const dialog = await screen.findByRole('form', { name: 'Unggah foto' });
    await within(dialog).findByText(/paling besar \d+ MB/);
    const input = within(dialog).getByLabelText('Berkas');
    expect(input.getAttribute('accept')).toBe('image/jpeg,image/png,image/webp');
    fireEvent.change(input, { target: { files: [new File([new Uint8Array(4096)], 'profil.pdf', { type: 'application/pdf' })] } });
    fireEvent.click(within(dialog).getByRole('button', { name: 'Unggah' }));
    expect(await within(dialog).findByText('Pilih gambar (JPG, PNG, WebP).')).toBeTruthy();
    expect(uploadFile).not.toHaveBeenCalled();
    expect(app.writes()).toEqual([]);
  });
});

describe('Populasi & Sarana', () => {
  it('a period changed elsewhere while numbers are typed is never overwritten: Simpan is refused as stale until the form is read again', async () => {
    const app = open({ tab: 'populasi' });
    const before = dirtyForms.count();
    fireEvent.change(await screen.findByRole('spinbutton', { name: 'Siswa' }, FIRST), { target: { value: '400' } });
    await waitFor(() => expect(dirtyForms.count()).toBe(before + 1));
    await app.changedElsewhere((p) => ({ ...p, students: 380, floorM2: 150 }));
    expect(await screen.findByText(STALE)).toBeTruthy();
    expect(field('spinbutton', 'Luas ruang (m²)').value).toBe('120');
    expect(field('spinbutton', 'Siswa').value).toBe('400');

    fireEvent.click(screen.getByRole('button', { name: 'Simpan' }));
    expect(await screen.findByText(STALE_REFUSAL)).toBeTruthy();
    expect(patches(app)).toEqual([{ version: 3, students: 400 }]);
    expect(app.period()).toMatchObject({ version: 4, students: 380, floorM2: 150 });
    expect(dirtyForms.count()).toBe(before + 1);

    fireEvent.click(screen.getByRole('button', { name: 'Muat ulang data tersimpan' }));
    await waitFor(() => expect(field('spinbutton', 'Siswa').value).toBe('380'));
    expect(field('spinbutton', 'Luas ruang (m²)').value).toBe('150');
    expect(screen.queryByText(STALE)).toBeNull();
    await waitFor(() => expect(dirtyForms.count()).toBe(before));
  });

  it('after its own save the numbers show as stored, so a later change made elsewhere is shown and never sent back', async () => {
    const app = open({ tab: 'populasi' });
    // A leading zero is not stored: the stored number has none.
    fireEvent.change(await screen.findByRole('spinbutton', { name: 'Siswa' }, FIRST), { target: { value: '0400' } });
    fireEvent.click(screen.getByRole('button', { name: 'Simpan' }));
    expect(await screen.findByText('Perubahan disimpan.')).toBeTruthy();
    expect(patches(app)).toEqual([{ version: 3, students: 400 }]);
    await waitFor(() => expect(field('spinbutton', 'Siswa').value).toBe('400'));

    await app.changedElsewhere((p) => ({ ...p, students: 450 }));
    await waitFor(() => expect(field('spinbutton', 'Siswa').value).toBe('450'));
    expect(screen.queryByText(STALE)).toBeNull();
    fireEvent.change(field('spinbutton', 'Rombongan belajar (rombel)'), { target: { value: '14' } });
    fireEvent.click(screen.getByRole('button', { name: 'Simpan' }));
    await waitFor(() => expect(patches(app)).toHaveLength(2));
    expect(patches(app)[1]).toEqual({ version: 5, classes: 14 });
    expect(app.period()).toMatchObject({ students: 450, classes: 14 });
  });
});

describe('unsaved changes and the workspace navigation', () => {
  const UNSAVED = 'Perubahan belum disimpan';

  it('another tab asks first: Batal keeps the tab and what was typed, going on opens the other tab', async () => {
    const app = open({ tab: 'profil' });
    const before = dirtyForms.count();
    fireEvent.change(await screen.findByRole('textbox', { name: NPP }, FIRST), { target: { value: '3301099999' } });
    await waitFor(() => expect(dirtyForms.count()).toBe(before + 1));

    fireEvent.mouseDown(screen.getByRole('tab', { name: 'Indikator' }));
    const ask = await screen.findByRole('alertdialog', { name: UNSAVED });
    expect(within(ask).getByText(/belum Anda simpan/)).toBeTruthy();
    fireEvent.click(within(ask).getByRole('button', { name: 'Batal' }));
    await waitFor(() => expect(screen.queryByRole('alertdialog', { name: UNSAVED })).toBeNull());
    expect(app.router.state.location.search).toEqual({ tab: 'profil' });
    await waitFor(() => expect(field('textbox', NPP).value).toBe('3301099999'));
    // The focus back on the tab it came from does not ask again.
    expect(screen.queryByRole('alertdialog', { name: UNSAVED })).toBeNull();

    fireEvent.mouseDown(screen.getByRole('tab', { name: 'Populasi & Sarana' }));
    const again = await screen.findByRole('alertdialog', { name: UNSAVED });
    expect(app.router.state.location.search).toEqual({ tab: 'profil' });
    fireEvent.click(within(again).getByRole('button', { name: 'Lanjutkan tanpa menyimpan' }));
    await waitFor(() => expect(app.router.state.location.search).toEqual({ tab: 'populasi' }));
    expect(await screen.findByRole('spinbutton', { name: 'Siswa' })).toBeTruthy();
    await waitFor(() => expect(dirtyForms.count()).toBe(before));
    expect(app.writes()).toEqual([]);
  });

  it('with nothing typed the tab changes at once; a link out of the workspace asks too while something is typed', async () => {
    const app = open({ tab: 'populasi' });
    await screen.findByRole('spinbutton', { name: 'Siswa' }, FIRST);
    fireEvent.mouseDown(screen.getByRole('tab', { name: 'Profil' }));
    await waitFor(() => expect(app.router.state.location.search).toEqual({ tab: 'profil' }));
    expect(screen.queryByRole('alertdialog', { name: UNSAVED })).toBeNull();

    fireEvent.change(await screen.findByRole('textbox', { name: 'Kepala sekolah' }, FIRST), { target: { value: 'Drs. Budi Santoso' } });
    await waitFor(() => expect(dirtyForms.count()).toBeGreaterThan(0));
    fireEvent.click(screen.getAllByRole('link', { name: 'Beranda' })[0]!);
    const ask = await screen.findByRole('alertdialog', { name: UNSAVED });
    expect(app.router.state.location.pathname).toBe(`/admin/accreditation/${PERIOD_ID}`);
    fireEvent.click(within(ask).getByRole('button', { name: 'Lanjutkan tanpa menyimpan' }));
    await waitFor(() => expect(app.router.state.location.pathname).toBe('/admin'));
    expect(app.writes()).toEqual([]);
  });
});
