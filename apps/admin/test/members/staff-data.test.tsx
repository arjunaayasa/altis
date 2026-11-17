import type { BranchView } from '@altis/shared/api/branches';
import type { LibraryDashboard } from '@altis/shared/api/dashboard-home';
import type { MemberListItem, MemberTypeView, MemberView } from '@altis/shared/api/members';
import { fireEvent, screen, waitFor, within } from '@testing-library/react';
import { afterEach, beforeAll, describe, expect, it, vi } from 'vitest';
import { adminMe, startApp } from '../fake-api';

// The data the staff screens show beside their lists: the member list's loans column (open of the limit, the overdue
// ones in words) and its class list sent in the search body, the member page's overdue figure, the member types' loan
// terms read from the loan rules (with a link to them), and Beranda's due-soon line and today's opening hours.

beforeAll(async () => {
  await Promise.all([import('@/screens/members/list'), import('@/screens/members/edit'), import('@/screens/members/types'), import('@/screens/home')]);
});

afterEach(() => {
  vi.unstubAllGlobals();
  vi.restoreAllMocks();
  window.localStorage.clear();
});

const TYPE_ID = '01JZ0000000000000000000T01';
const SISWA: MemberTypeView = {
  id: TYPE_ID,
  code: 'SISWA',
  nameId: 'Siswa',
  nameEn: 'Student',
  accredGroup: 'student',
  membershipDays: 365,
  loanLimit: 3,
  holdsAllowed: true,
  holdsLimit: 2,
  onlineRenewal: true,
  sortOrder: 0,
  memberCount: 2,
  archived: false,
  version: 1,
  loanRule: { policyId: '01JZ0000000000000000000P01', code: 'DEFAULT', loanDays: 7, renewLimit: 0, loanable: true, others: 2 },
};
const GURU: MemberTypeView = { ...SISWA, id: '01JZ0000000000000000000T02', code: 'GURU', nameId: 'Guru', nameEn: 'Teacher', loanRule: null };
const BRANCH: BranchView = {
  id: '01JZ0000000000000000000B01',
  code: 'PUSAT',
  name: 'Perpustakaan Pusat',
  address: null,
  timezone: 'Asia/Jakarta',
  isDefault: true,
  archivedAt: null,
  version: 1,
  active: true,
};

const member = (n: number, open: number, overdue: number): MemberListItem => ({
  id: `01JZ0000000000000000000M0${n}`,
  memberNo: `S-00${n}`,
  name: `Anggota ${n}`,
  type: { id: TYPE_ID, code: 'SISWA', nameId: 'Siswa', nameEn: 'Student', loanLimit: 3 },
  className: '7A',
  status: 'active',
  expiresOn: '2027-07-01',
  photoFileId: null,
  openLoans: open,
  overdueLoans: overdue,
});

describe('the member list', () => {
  it('shows the open loans of the limit and the overdue ones; the class list fills the filter, sent in the body', async () => {
    const app = startApp({
      me: adminMe(),
      path: '/admin/anggota',
      routes: {
        'GET members/types': () => ({ items: [SISWA] }),
        'GET branches': () => ({ items: [BRANCH] }),
        'GET members/classes': () => ({ items: ['7A', '7B'] }),
        'POST members/search': () => ({ items: [member(1, 2, 1), member(2, 0, 0)], nextCursor: null }),
      },
    });
    const table = await screen.findByRole('table', { name: 'Daftar anggota' });
    const first = within(table).getByRole('row', { name: /Anggota 1/ });
    expect(within(first).getByText('2 dari 3')).toBeTruthy();
    expect(within(first).getByText('1 terlambat').className).toContain('text-bad');
    expect(within(within(table).getByRole('row', { name: /Anggota 2/ })).queryByText(/terlambat/)).toBeNull();
    const cls = screen.getByLabelText('Kelas') as HTMLSelectElement;
    await waitFor(() => expect([...cls.options].map((o) => o.textContent)).toEqual(['Semua kelas', '7A', '7B']));
    fireEvent.change(cls, { target: { value: '7B' } });
    await waitFor(() => expect(app.requests.filter((r) => r.path === 'members/search').at(-1)?.body).toEqual({ limit: 50, className: '7B' }));
  });
});

describe('the member page', () => {
  it('the summary strip says the overdue loans, in red when there are any', async () => {
    const m: MemberView = {
      id: '01JZ0000000000000000000M01',
      memberNo: 'S-001',
      type: { id: TYPE_ID, code: 'SISWA', nameId: 'Siswa', nameEn: 'Student', loanLimit: 3 },
      homeBranchId: null,
      storedStatus: 'active',
      status: 'active',
      statusNote: null,
      name: 'Anggota 1',
      gender: null,
      birthDate: null,
      identityNo: null,
      institution: null,
      className: '7A',
      email: null,
      phone: null,
      address: null,
      postalCode: null,
      mailingAddress: null,
      notes: null,
      photoFileId: null,
      locale: 'id',
      joinedOn: '2026-07-01',
      validFrom: '2026-07-01',
      expiresOn: '2027-07-01',
      openLoans: 2,
      overdueLoans: 1,
      source: 'manual',
      archived: false,
      createdAt: 1_763_164_800_000,
      updatedAt: 1_763_164_800_000,
      version: 1,
    };
    startApp({
      me: adminMe(),
      path: `/admin/anggota/${m.id}`,
      routes: {
        'GET members/types': () => ({ items: [SISWA] }),
        'GET branches': () => ({ items: [BRANCH] }),
        'GET members/:id': () => m,
        'GET circulation/loans': () => ({ items: [], nextCursor: null }),
      },
    });
    await screen.findByRole('heading', { name: 'Anggota 1' });
    const strip = await waitFor(() => document.querySelector<HTMLElement>('dl[aria-label="Ringkasan anggota"]')!);
    const late = within(strip).getByText('Terlambat').parentElement!;
    expect(late.textContent).toBe('Terlambat1');
    expect(late.querySelector('.text-bad')).not.toBeNull();
    expect(within(strip).queryByText('Berlaku mulai')).toBeNull();
  });
});

describe('the member types', () => {
  it('the loan period and renewals of the general rule, read-only, that other rules exist, and the link to the rules', async () => {
    startApp({ me: adminMe(), path: '/admin/anggota/tipe', routes: { 'GET members/types': () => ({ items: [SISWA, GURU] }) } });
    const table = await screen.findByRole('table', { name: 'Daftar tipe anggota' });
    const siswa = within(table).getByRole('row', { name: /SISWA/ });
    expect(within(siswa).getByText('7 hari')).toBeTruthy();
    expect(within(siswa).getByText('ada 2 aturan khusus')).toBeTruthy();
    expect(within(siswa).getByText('Tidak bisa')).toBeTruthy();
    expect(within(within(table).getByRole('row', { name: /GURU/ })).getByText('Belum ada aturan')).toBeTruthy();
    expect(screen.getByRole('link', { name: 'Buka Aturan Peminjaman' }).getAttribute('href')).toBe('/admin/layanan/aturan');
  });
});

describe('Beranda', () => {
  const library = (o: Partial<LibraryDashboard>): LibraryDashboard => ({ today: '2026-11-18', members: null, loans: { longOverdue: 0, dueSoon: 4 }, usage: null, ...o });
  const open = (lib: LibraryDashboard) =>
    startApp({
      me: adminMe(),
      path: '/admin',
      routes: {
        'GET dashboard': () => ({
          version: { current: '0.1.0', appJs: '1.0.0', bootProtocol: 1, update: null },
          edition: { edition: 'community', status: 'active' },
          lastBackup: null,
          nextBackupAt: null,
          queue: null,
          scheduler: null,
          alerts: [],
        }),
        'GET branches': () => ({ items: [BRANCH] }),
        'GET branches/:branchId/dashboard': () => ({ branchId: BRANCH.id, on: '2026-11-18', timeZone: 'Asia/Jakarta', weekAgo: '2026-11-11', loaned: 0, returned: 0, loanedWeekAgo: 0, returnedWeekAgo: 0, overdue: 0, overdueMembers: 0, holdsReady: 0, holdsToClear: 0, hours: [] }),
        'GET dashboard/library': () => lib,
      },
    });

  it("the loans due within two days lead to the overdue screen's due-soon tab; today's hours follow the date", async () => {
    open(library({ openToday: { times: ['07.00–15.00'], closed: false } }));
    const line = await screen.findByRole('link', { name: 'Jatuh tempo dalam 2 hari 4' });
    expect(line.getAttribute('href')).toBe('/admin/layanan/terlambat?tab=due_soon');
    expect(await screen.findByText(/Rabu, 18 November 2026 · buka 07\.00–15\.00/)).toBeTruthy();
  });

  it('no hours set: no hours text; a day the calendar closes says so', async () => {
    open(library({ openToday: null, loans: { longOverdue: 0, dueSoon: 0 } }));
    expect(await screen.findByText(/Rabu, 18 November 2026/)).toBeTruthy();
    expect(screen.queryByText(/buka|tutup hari ini/)).toBeNull();
    expect(screen.queryByRole('link', { name: /Jatuh tempo dalam/ })).toBeNull();
  });
});
