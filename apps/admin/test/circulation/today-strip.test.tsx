import type { BranchView } from '@altis/shared/api/branches';
import type { DashboardResponse } from '@altis/shared/api/dashboard';
import type { DeskDashboard, LibraryDashboard } from '@altis/shared/api/dashboard-home';
import type { ReportCatalogEntry } from '@altis/shared/api/reports';
import type { VisitSummary } from '@altis/shared/api/visits';
import { screen, waitFor, within } from '@testing-library/react';
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import { adminMe, signedIn, startApp } from '../fake-api';

// The numbers of today on Beranda: lent, returned and overdue at the desk's branch and today's visits from the
// guestbook (the active members in their place for a user who may not read the visits), each a link to its screen (a
// plain figure for a user who may not open it); nothing for a user who holds none of the permissions. The holds ready
// move to "Perlu perhatian"; the visits card repeats today's visits. The report catalogue lists the member,
// visit and circulation reports under their own modules.

beforeEach(() => {
  localStorage.clear();
});

afterEach(() => {
  vi.unstubAllGlobals();
  vi.restoreAllMocks();
});

const BRANCH: BranchView = {
  id: 'B1',
  code: 'PUSAT',
  name: 'Perpustakaan Pusat',
  address: null,
  timezone: 'Asia/Jakarta',
  isDefault: true,
  archivedAt: null,
  version: 1,
  active: true,
};

const DASHBOARD: DashboardResponse = {
  version: { current: '0.1.0', appJs: '1.0.0', bootProtocol: 1, update: null },
  edition: { edition: 'community', status: 'active' },
  lastBackup: null,
  nextBackupAt: null,
  queue: null,
  scheduler: null,
  alerts: [],
};

const HOURS = Array.from({ length: 24 }, (_, hour) => ({ hour, loans: hour === 8 ? 12 : 0, returns: hour === 9 ? 9 : 0 }));
const DESK: DeskDashboard = {
  branchId: 'B1',
  on: '2026-11-15',
  timeZone: 'Asia/Jakarta',
  weekAgo: '2026-11-08',
  loaned: 12,
  returned: 9,
  loanedWeekAgo: 10,
  returnedWeekAgo: 1234,
  overdue: 3,
  overdueMembers: 2,
  holdsReady: 2,
  holdsToClear: 0,
  hours: HOURS,
};
const LIBRARY: LibraryDashboard = { today: '2026-11-15', members: { active: 480, joinedThisMonth: 12, expiringSoon: 0 }, loans: { longOverdue: 0 }, usage: null };
const VISITS: VisitSummary = { on: '2026-11-15', total: 1234, members: 1200, guests: 34, bySource: { station: 1234 } };

describe('the numbers of today', () => {
  it('shows the desk branch’s loans, returns and overdue loans and today’s visits, each linking to its screen', async () => {
    const { requests } = startApp({
      me: adminMe(),
      path: '/admin',
      routes: {
        'GET dashboard': () => DASHBOARD,
        'GET branches': () => ({ items: [BRANCH] }),
        'GET branches/:branchId/dashboard': () => DESK,
        'GET dashboard/library': () => LIBRARY,
        'GET visits/summary': () => VISITS,
      },
    });
    const strip = await screen.findByRole('region', { name: 'Angka hari ini' });
    await waitFor(() => expect(within(strip).getByText('1.234')).toBeTruthy());
    await waitFor(() => expect(within(strip).getByText('12')).toBeTruthy());
    const figure = (key: string) => strip.querySelector(`[data-figure="${key}"]`) as HTMLAnchorElement;
    expect([figure('loaned').textContent, figure('loaned').getAttribute('href')]).toEqual(['Dipinjam hari ini12Minggu lalu 10', '/admin/layanan']);
    expect([figure('returned').textContent, figure('returned').getAttribute('href')]).toEqual(['Dikembalikan hari ini9Minggu lalu 1.234', '/admin/layanan/kembali']);
    expect([figure('overdue').textContent, figure('overdue').getAttribute('href')]).toEqual(['Pinjaman terlambat32 anggota', '/admin/layanan/terlambat']);
    expect([figure('visits').textContent, figure('visits').getAttribute('href')]).toEqual(['Kunjungan hari ini1.234dari buku tamu', '/admin/layanan/kunjungan']);
    // Four figures at most: the active members are a figure of the library's statistics on the reports page.
    expect(figure('active_members')).toBeNull();
    expect(strip.querySelectorAll('[data-figure]')).toHaveLength(4);
    expect(requests.find((r) => r.path === 'branches/B1/dashboard')).toBeDefined();
    // The holds ready for pickup are a line of "Perlu perhatian"; today's visits are a figure of the strip only (the
    // visits card with the month and the year is on the reports page).
    const attention = screen.getByRole('region', { name: 'Perlu perhatian' });
    expect(within(attention).getByRole('link', { name: 'Reservasi siap diambil 2' }).getAttribute('href')).toBe('/admin/layanan/rak-tunggu');
    expect(screen.queryByRole('region', { name: 'Statistik perpustakaan' })).toBeNull();
    expect(requests.filter((r) => r.path === 'visits/summary').map((r) => r.query.get('branchId'))).toEqual([null]);
  });

  it('a user who reads the members but not the visits sees the active members as the fourth figure', async () => {
    const me = signedIn({ permissions: ['members.records.read'] });
    me.branchPermissions = { B1: ['circulation.desk.use'] };
    startApp({
      me,
      path: '/admin',
      routes: {
        'GET dashboard': () => DASHBOARD,
        'GET branches': () => ({ items: [BRANCH] }),
        'GET branches/:branchId/dashboard': () => DESK,
        'GET dashboard/library': () => ({ ...LIBRARY, loans: null }),
      },
    });
    const strip = await screen.findByRole('region', { name: 'Angka hari ini' });
    await waitFor(() => expect(within(strip).getByText('480')).toBeTruthy());
    const members = strip.querySelector('[data-figure="active_members"]') as HTMLAnchorElement;
    expect([members.textContent, members.getAttribute('href')]).toEqual(['Anggota aktif48012 baru bulan ini', '/admin/anggota']);
    expect(strip.querySelector('[data-figure="visits"]')).toBeNull();
  });

  it('a desk user without the overdue list sees the overdue figure without a link; nothing of the members', async () => {
    const me = signedIn({ permissions: [] });
    me.branchPermissions = { B1: ['circulation.desk.use'] };
    startApp({
      me,
      path: '/admin',
      routes: {
        'GET dashboard': () => DASHBOARD,
        'GET branches': () => ({ items: [BRANCH] }),
        'GET branches/:branchId/dashboard': () => DESK,
        'GET dashboard/library': () => ({ ...LIBRARY, members: null, loans: null }),
      },
    });
    const strip = await screen.findByRole('region', { name: 'Angka hari ini' });
    await waitFor(() => expect(within(strip).getByText('12')).toBeTruthy());
    expect([...strip.querySelectorAll('[data-figure]')].map((f) => [f.getAttribute('data-figure'), f.tagName])).toEqual([
      ['loaned', 'A'],
      ['returned', 'A'],
      ['overdue', 'DIV'],
    ]);
  });

  it('a staff member without the desk or the members permission sees no strip', async () => {
    startApp({
      me: signedIn({ permissions: [] }),
      path: '/admin',
      routes: { 'GET dashboard': () => DASHBOARD, 'GET branches': () => ({ items: [BRANCH] }), 'GET dashboard/library': () => ({ ...LIBRARY, members: null, loans: null }) },
    });
    await within(await screen.findByRole('region', { name: 'Kesehatan sistem' })).findByText(/^ALTIS /);
    expect(screen.queryByRole('region', { name: 'Angka hari ini' })).toBeNull();
  });
});

describe('the report catalogue', () => {
  const entry = (id: string, module: ReportCatalogEntry['module']): ReportCatalogEntry => ({
    id,
    module,
    kind: 'table',
    titleKey: `report.${id}.title`,
    personal: false,
    canExport: true,
    formats: ['csv', 'xlsx', 'pdf'],
    orientation: 'portrait',
    params: [],
    columns: null,
  });

  it('lists the member, visit and circulation reports under their own modules', async () => {
    await import('@/screens/reports/catalog');
    startApp({
      me: adminMe(),
      path: '/admin/reports',
      routes: {
        'GET reports/catalog': () => ({
          reports: [entry('members.summary', 'members'), entry('visits.monthly', 'visits'), entry('circulation.summary', 'circulation')],
        }),
      },
    });
    const visits = await screen.findByRole('region', { name: 'Kunjungan' });
    expect(within(visits).getByText('Kunjungan per bulan')).toBeTruthy();
    const circulation = screen.getByRole('region', { name: 'Sirkulasi' });
    expect(within(circulation).getByText('Ringkasan sirkulasi')).toBeTruthy();
    expect(within(screen.getByRole('region', { name: 'Anggota' })).getByText('Ringkasan anggota')).toBeTruthy();
  });
});

describe('the links to the reports', () => {
  it('the overdue list links to the overdue and due-soon reports for a records reader', async () => {
    await import('@/screens/circulation/overdue');
    startApp({ me: adminMe(), path: '/admin/layanan/terlambat', routes: { 'GET circulation/loans': () => ({ items: [], nextCursor: null }) } });
    const line = await waitFor(() => {
      const found = document.querySelector('[data-report-links]');
      expect(found).not.toBeNull();
      return found as HTMLElement;
    });
    expect([...line.querySelectorAll('a')].map((a) => [a.textContent, a.getAttribute('href')])).toEqual([
      ['Pinjaman terlambat', '/admin/reports/circulation.overdue'],
      ['Pinjaman yang segera jatuh tempo', '/admin/reports/circulation.due_soon'],
    ]);
  });
});
