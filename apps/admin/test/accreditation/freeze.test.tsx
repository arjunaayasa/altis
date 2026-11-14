import { MESSAGES } from '@altis/shared';
import type { PeriodView, SnapshotListResponse } from '@altis/shared/api/accreditation';
import { fireEvent, screen, waitFor, within } from '@testing-library/react';
import { afterEach, describe, expect, it, vi } from 'vitest';
import { ADMIN_MESSAGES } from '@/i18n';
import { adminMe, problem, startApp, type FakeHandler } from '../fake-api';
import { PERIOD_ID, T0, indicatorResult, instrumentsAnswer, periodView, periodsAnswer, resultsView } from './workspace-fixtures';

// Riwayat and the frozen period (spec §6, §10.10): "Bekukan" with a note stores a snapshot, and refuses with "Hitung
// ulang dulu" while the results are older than the period's last change; "Cairkan" goes through the password dialog;
// the snapshots are listed with their estimate; a frozen period disables every input of the period's data.

afterEach(() => {
  vi.unstubAllGlobals();
  vi.restoreAllMocks();
});

const FIRST = { timeout: 10_000 };
const ID = MESSAGES.id;
const SNAPSHOT_ID = '01JZ0000000000000000SNP001';
const FILE_ID = '01JZ0000000000000000FIL001';

function open(o: { period?: PeriodView; tab: string; snapshots?: SnapshotListResponse; extra?: Record<string, FakeHandler> }) {
  let period = o.period ?? periodView();
  const routes: Record<string, FakeHandler> = {
    'GET accreditation/instruments': () => instrumentsAnswer(),
    'GET accreditation/periods': () => periodsAnswer(period),
    'GET accreditation/periods/:id': () => period,
    'GET accreditation/periods/:id/results': () =>
      resultsView({ indicators: [indicatorResult('SCH-K1', 'K1', 'K', { suggestion: 'b', final: 'b' }), indicatorResult('SCH-SP1', 'SP1', 'SP')] }),
    'GET accreditation/periods/:id/snapshots': () => o.snapshots ?? { snapshots: [] },
    ...o.extra,
  };
  const app = startApp({ me: adminMe(), path: `/admin/accreditation/${PERIOD_ID}?tab=${o.tab}`, routes });
  return { ...app, setPeriod: (next: PeriodView) => void (period = next) };
}

describe('freezing a period', () => {
  it('stale results: the freeze is refused with "Hitung ulang dulu"', async () => {
    const app = open({
      tab: 'riwayat',
      extra: {
        'POST accreditation/periods/:id/freeze': () =>
          problem(409, 'ACCRED_RESULTS_STALE', { meta: { computedAt: T0, changedAt: T0 + 5_000 } }),
      },
    });
    fireEvent.click(await screen.findByRole('button', { name: 'Bekukan' }, FIRST));
    expect(await screen.findByText(/Hitung ulang dulu/)).toBeTruthy();
    expect(app.writes()).toEqual([`POST accreditation/periods/${PERIOD_ID}/freeze`]);
  });

  it('"Bekukan" sends the note and the page then shows the frozen period', async () => {
    const app = open({
      tab: 'riwayat',
      extra: {
        'POST accreditation/periods/:id/freeze': () => {
          app.setPeriod(periodView({ status: 'frozen', frozenAt: T0 + 10_000, version: 4 }));
          return { id: SNAPSHOT_ID, version: 4 };
        },
      },
    });
    fireEvent.change(await screen.findByRole('textbox', { name: 'Catatan snapshot' }, FIRST), { target: { value: 'Siap diajukan' } });
    fireEvent.click(screen.getByRole('button', { name: 'Bekukan' }));
    await waitFor(() => expect(app.writes()).toEqual([`POST accreditation/periods/${PERIOD_ID}/freeze`]));
    expect(app.requests.find((r) => r.method === 'POST')?.body).toEqual({ note: 'Siap diajukan' });
    expect(await screen.findByRole('button', { name: 'Cairkan' })).toBeTruthy();
    expect(screen.getAllByText(ID['vocab.period_status.frozen']).length).toBeGreaterThan(0);
  });

  it('"Cairkan" asks for the password first', async () => {
    const app = open({
      tab: 'riwayat',
      period: periodView({ status: 'frozen', frozenAt: T0 }),
      extra: { 'POST accreditation/periods/:id/unfreeze': () => problem(401, 'AUTH_REAUTH_REQUIRED') },
    });
    fireEvent.click(await screen.findByRole('button', { name: 'Cairkan' }, FIRST));
    expect(await screen.findByRole('heading', { name: 'Konfirmasi kata sandi' })).toBeTruthy();
    expect(app.writes()).toEqual([`POST accreditation/periods/${PERIOD_ID}/unfreeze`]);
    expect(screen.queryByRole('button', { name: 'Bekukan' })).toBeNull();
    // Cancelled: the period stays frozen (and the password request ends, so the next one opens its own dialog).
    fireEvent.click(screen.getByRole('button', { name: ADMIN_MESSAGES.id['reauth.cancel'] }));
    await waitFor(() => expect(screen.queryByRole('heading', { name: 'Konfirmasi kata sandi' })).toBeNull());
    expect(await screen.findByRole('button', { name: 'Cairkan' })).toBeTruthy();
  });

  it('lists the snapshots with their estimate; a snapshot without the prerequisites shows a practice figure', async () => {
    open({
      tab: 'riwayat',
      snapshots: {
        snapshots: [
          {
            id: SNAPSHOT_ID,
            periodId: PERIOD_ID,
            instrumentId: 'sch-sma-2025',
            na: '82.14',
            naLow: '82.14',
            naHigh: '82.14',
            grade: null,
            prerequisitesMet: false,
            dossierFileId: null,
            note: 'Latihan pertama',
            createdAt: T0,
            createdBy: null,
          },
          {
            id: '01JZ0000000000000000SNP002',
            periodId: PERIOD_ID,
            instrumentId: 'sch-sma-2025',
            na: null,
            naLow: '70.45',
            naHigh: '72.10',
            grade: null,
            prerequisitesMet: true,
            dossierFileId: null,
            note: null,
            createdAt: T0 - 86_400_000,
            createdBy: null,
          },
        ],
      },
    });
    const table = await screen.findByRole('table', undefined, FIRST);
    const rows = within(table).getAllByRole('row').slice(1);
    expect(rows).toHaveLength(2);
    expect(rows[0]!.textContent).toContain('82,14');
    expect(rows[0]!.textContent).toContain(ID['accred.na.exercise']);
    expect(rows[0]!.textContent).toContain('Latihan pertama');
    expect(rows[1]!.textContent).toContain('70,45–72,10');
  });
});

describe('a frozen period', () => {
  it('disables the answer picker', async () => {
    open({ tab: 'indikator', period: periodView({ status: 'frozen', frozenAt: T0 }) });
    const k1 = await screen.findByRole('region', { name: 'K1 · Koleksi butir 1' }, FIRST);
    for (const radio of within(k1).getAllByRole('radio')) expect((radio as HTMLInputElement).disabled).toBe(true);
    expect((within(k1).getByRole('button', { name: 'Simpan jawaban' }) as HTMLButtonElement).disabled).toBe(true);
  });

  it('disables the population, facility and profile inputs', async () => {
    open({ tab: 'populasi', period: periodView({ status: 'frozen', frozenAt: T0 }) });
    const students = (await screen.findByRole('spinbutton', { name: 'Siswa' }, FIRST)) as HTMLInputElement;
    expect(students.disabled).toBe(true);
    expect((screen.getByRole('checkbox', { name: 'Semua warga sekolah terdaftar sebagai anggota perpustakaan' }) as HTMLInputElement).disabled).toBe(true);
    expect(screen.queryByRole('button', { name: 'Simpan' })).toBeNull();
  });

  it('disables the profile inputs', async () => {
    open({ tab: 'profil', period: periodView({ status: 'frozen', frozenAt: T0 }) });
    const npp = (await screen.findByRole('textbox', { name: 'NPP (Nomor Pokok Perpustakaan)' }, FIRST)) as HTMLInputElement;
    expect(npp.value).toBe('3301012345');
    expect(npp.disabled).toBe(true);
    expect(screen.queryByRole('button', { name: 'Simpan' })).toBeNull();
  });
});

describe('the period data of an open period', () => {
  it('Populasi & Sarana sends only the changed fields with the version, including the registration statement', async () => {
    const app = open({
      tab: 'populasi',
      extra: { 'PATCH accreditation/periods/:id': () => ({ id: PERIOD_ID, version: 4 }) },
    });
    fireEvent.change(await screen.findByRole('spinbutton', { name: 'Siswa' }, FIRST), { target: { value: '400' } });
    fireEvent.click(screen.getByRole('checkbox', { name: 'Semua warga sekolah terdaftar sebagai anggota perpustakaan' }));
    fireEvent.click(screen.getByRole('button', { name: 'Simpan' }));
    await waitFor(() => expect(app.writes()).toEqual([`PATCH accreditation/periods/${PERIOD_ID}`]));
    expect(app.requests.find((r) => r.method === 'PATCH')?.body).toEqual({ version: 3, students: 400, allRegisteredConfirmed: true });
  });

  it('Profil sends the changed profile fields', async () => {
    const app = open({
      tab: 'profil',
      extra: { 'PATCH accreditation/periods/:id': () => ({ id: PERIOD_ID, version: 4 }) },
    });
    fireEvent.change(await screen.findByRole('textbox', { name: 'Kepala sekolah' }, FIRST), { target: { value: 'Dra. Siti Aminah' } });
    fireEvent.click(screen.getByRole('button', { name: 'Simpan' }));
    await waitFor(() => expect(app.writes()).toEqual([`PATCH accreditation/periods/${PERIOD_ID}`]));
    expect(app.requests.find((r) => r.method === 'PATCH')?.body).toEqual({ version: 3, profile: { schoolHead: 'Dra. Siti Aminah' } });
  });

  it('a field refused by the server shows on its field', async () => {
    open({
      tab: 'profil',
      extra: { 'PATCH accreditation/periods/:id': () => problem(422, 'VALIDATION_FAILED', { errors: [{ path: 'profile.npp', code: 'too_big' }] }) },
    });
    fireEvent.change(await screen.findByRole('textbox', { name: 'NPP (Nomor Pokok Perpustakaan)' }, FIRST), { target: { value: '33010123456' } });
    fireEvent.click(screen.getByRole('button', { name: 'Simpan' }));
    const npp = await screen.findByRole('textbox', { name: 'NPP (Nomor Pokok Perpustakaan)' });
    await waitFor(() => expect(npp.getAttribute('aria-invalid')).toBe('true'));
  });

  it('Profil names each photo slot, and taking a photo out sends the four slots', async () => {
    const app = open({
      tab: 'profil',
      period: periodView({ profile: { npp: '3301012345', photos: { front: FILE_ID, collection: null, staff: null, readingRoom: null } } }),
      extra: {
        'GET accreditation/evidence': () => ({
          evidence: [
            {
              id: '01JZ0000000000000000EVD001',
              periodId: PERIOD_ID,
              indicatorCode: 'SCH-PROFIL',
              evidenceCode: 'photo_front',
              entity: null,
              entityId: null,
              fileId: FILE_ID,
              fileName: 'tampak-depan.jpg',
              size: 120_000,
              mime: 'image/jpeg',
              caption: 'Tampak depan',
              sortOrder: 0,
              createdAt: T0,
            },
          ],
          componentBytes: { K: 0, SP: 0, L: 0, T: 0, F: 0, G: 0, profil: 120_000 },
        }),
        'PATCH accreditation/periods/:id': () => ({ id: PERIOD_ID, version: 4 }),
      },
    });
    const photos = await screen.findByRole('region', { name: 'Foto profil' }, FIRST);
    const front = within(photos).getByText('Tampak depan perpustakaan').closest('li') as HTMLElement;
    expect(within(front).getByText('ada')).toBeTruthy();
    expect((await within(front).findByRole('link', { name: 'tampak-depan.jpg' })).getAttribute('href')).toBe(`/files/${FILE_ID}`);
    const staff = within(photos).getByText('Tenaga perpustakaan').closest('li') as HTMLElement;
    expect(within(staff).getByText('belum')).toBeTruthy();
    fireEvent.click(within(front).getByRole('button', { name: 'Lepas dari profil' }));
    await waitFor(() => expect(app.writes()).toEqual([`PATCH accreditation/periods/${PERIOD_ID}`]));
    expect(app.requests.find((r) => r.method === 'PATCH')?.body).toEqual({
      version: 3,
      profile: { photos: { front: null, collection: null, staff: null, readingRoom: null } },
    });
  });
});

describe('a snapshot with its frozen evidence file', () => {
  it('is downloaded only after the password is confirmed', async () => {
    open({
      tab: 'riwayat',
      period: periodView({ status: 'frozen', frozenAt: T0 }),
      snapshots: {
        snapshots: [
          {
            id: SNAPSHOT_ID,
            periodId: PERIOD_ID,
            instrumentId: 'sch-sma-2025',
            na: '82.14',
            naLow: '82.14',
            naHigh: '82.14',
            grade: 'B',
            prerequisitesMet: true,
            dossierFileId: FILE_ID,
            note: null,
            createdAt: T0,
            createdBy: null,
          },
        ],
      },
    });
    const row = (await screen.findAllByRole('row', undefined, FIRST))[1]!;
    expect(row.textContent).toContain(`82,14 · Predikat: B (${ID['accred.predicate.B']})`);
    fireEvent.click(within(row).getByRole('button', { name: 'Unduh' }));
    expect(await screen.findByRole('heading', { name: 'Konfirmasi kata sandi' })).toBeTruthy();
    fireEvent.click(screen.getByRole('button', { name: ADMIN_MESSAGES.id['reauth.cancel'] }));
    await waitFor(() => expect(screen.queryByRole('heading', { name: 'Konfirmasi kata sandi' })).toBeNull());
  });
});
