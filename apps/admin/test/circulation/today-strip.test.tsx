import type { BranchView } from '@altis/shared/api/branches';
import type { CirculationDaySummary } from '@altis/shared/api/circulation-summary';
import type { DashboardResponse } from '@altis/shared/api/dashboard';
import type { ReportCatalogEntry } from '@altis/shared/api/reports';
import type { VisitSummary } from '@altis/shared/api/visits';
import { screen, waitFor, within } from '@testing-library/react';
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import { adminMe, signedIn, startApp } from '../fake-api';

// The numbers of today on Beranda: lent, returned, overdue and holds ready at the desk's branch, and today's visits,
// each a link to its screen; nothing for a user who holds neither permission. The report catalogue lists the member,
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

const SUMMARY: CirculationDaySummary = { branchId: 'B1', on: '2026-11-15', loaned: 12, returned: 9, overdue: 3, holdsReady: 2 };
const VISITS: VisitSummary = { on: '2026-11-15', total: 1234, members: 1200, guests: 34, bySource: { station: 1234 } };

describe('the numbers of today', () => {
  it('shows the desk branch’s loans, returns, overdue loans and holds ready, and today’s visits, each linking to its screen', async () => {
    const { requests } = startApp({
      me: adminMe(),
      path: '/admin',
      routes: {
        'GET dashboard': () => DASHBOARD,
        'GET branches': () => ({ items: [BRANCH] }),
        'GET branches/:branchId/circulation/summary': () => SUMMARY,
        'GET visits/summary': () => VISITS,
      },
    });
    const strip = await screen.findByRole('region', { name: 'Hari ini' });
    await waitFor(() => expect(within(strip).getByText('1.234')).toBeTruthy());
    const figure = (key: string) => strip.querySelector(`[data-figure="${key}"]`) as HTMLAnchorElement;
    expect([figure('loaned').textContent, figure('loaned').getAttribute('href')]).toEqual(['Dipinjam hari ini12', '/admin/layanan']);
    expect([figure('returned').textContent, figure('returned').getAttribute('href')]).toEqual(['Dikembalikan hari ini9', '/admin/layanan/kembali']);
    expect([figure('overdue').textContent, figure('overdue').getAttribute('href')]).toEqual(['Pinjaman terlambat3', '/admin/layanan/terlambat']);
    expect([figure('holds_ready').textContent, figure('holds_ready').getAttribute('href')]).toEqual(['Reservasi siap diambil2', '/admin/layanan/rak-tunggu']);
    expect(figure('visits').getAttribute('href')).toBe('/admin/layanan/kunjungan');
    expect(within(strip).getByText('Cabang Perpustakaan Pusat')).toBeTruthy();
    expect(requests.find((r) => r.path === 'branches/B1/circulation/summary')).toBeDefined();
    expect(requests.filter((r) => r.path === 'visits/summary').map((r) => r.query.get('branchId'))).toEqual(['B1']);
  });

  it('a staff member without the desk or the visits permission sees no strip', async () => {
    startApp({ me: signedIn({ permissions: [] }), path: '/admin', routes: { 'GET dashboard': () => DASHBOARD, 'GET branches': () => ({ items: [BRANCH] }) } });
    await screen.findByRole('group', { name: 'Dasbor sistem' });
    expect(screen.queryByRole('region', { name: 'Hari ini' })).toBeNull();
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
