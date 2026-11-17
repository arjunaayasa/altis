import type { BranchView } from '@altis/shared/api/branches';
import type { DashboardResponse } from '@altis/shared/api/dashboard';
import type { DeskDashboard, DeskHour, LibraryDashboard } from '@altis/shared/api/dashboard-home';
import { fireEvent, screen, waitFor, within } from '@testing-library/react';
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import { axisScale, shownHours } from '@/screens/dashboard-activity';
import { adminMe, problem, signedIn, startApp, superMe } from './fake-api';

// Beranda's library blocks: the desk's activity per hour (its hours, the empty day, the keyboard tooltip and the
// table), "Perlu perhatian" (each line with its count and its screen, one sentence when nothing needs it), the loans by
// subject and the most borrowed titles (counts only, a title linked for a catalogue reader; a failed read said with
// "Coba lagi"), each only for its readers.

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

const SYSTEM: DashboardResponse = {
  version: { current: '0.1.0', appJs: '1.0.0', bootProtocol: 1, update: null },
  edition: { edition: 'community', status: 'active' },
  lastBackup: null,
  nextBackupAt: null,
  queue: null,
  scheduler: null,
  alerts: [],
};

const hours = (busy: Readonly<Record<number, [number, number]>>): DeskHour[] =>
  Array.from({ length: 24 }, (_, hour) => ({ hour, loans: busy[hour]?.[0] ?? 0, returns: busy[hour]?.[1] ?? 0 }));

function desk(o: Partial<DeskDashboard> = {}): DeskDashboard {
  return {
    branchId: 'B1',
    on: '2026-11-15',
    timeZone: 'Asia/Jakarta',
    weekAgo: '2026-11-08',
    loaned: 7,
    returned: 4,
    loanedWeekAgo: 5,
    returnedWeekAgo: 6,
    overdue: 0,
    overdueMembers: 0,
    holdsReady: 0,
    holdsToClear: 0,
    hours: hours({ 8: [4, 1], 9: [2, 3], 18: [1, 0] }),
    ...o,
  };
}

function library(o: Partial<LibraryDashboard> = {}): LibraryDashboard {
  return {
    today: '2026-11-15',
    members: { active: 480, joinedThisMonth: 12, expiringSoon: 0 },
    loans: { longOverdue: 0 },
    usage: {
      from: '2026-10-17',
      to: '2026-11-15',
      bySubject: [
        { main: '800', loans: 142 },
        { main: '500', loans: 96 },
        { main: 'NON', loans: 3 },
      ],
      topTitles: [
        { recordId: '01JZ00000000000000000REC01', title: 'Judul Pertama', loans: 12 },
        { recordId: '01JZ00000000000000000REC02', title: 'Judul Kedua', loans: 9 },
      ],
    },
    ...o,
  };
}

function open(o: { me?: ReturnType<typeof signedIn>; desk?: DeskDashboard; library?: LibraryDashboard; system?: DashboardResponse } = {}) {
  return startApp({
    me: o.me ?? adminMe(),
    path: '/admin',
    routes: {
      'GET dashboard': () => o.system ?? SYSTEM,
      'GET branches': () => ({ items: [BRANCH] }),
      'GET branches/:branchId/dashboard': () => o.desk ?? desk(),
      'GET dashboard/library': () => o.library ?? library(),
    },
  });
}

describe('the hours of the chart and its axis', () => {
  it('07.00 to 16.00, widened to every busy hour', () => {
    expect(shownHours(hours({})).map((h) => h.hour)).toEqual([7, 8, 9, 10, 11, 12, 13, 14, 15, 16]);
    expect(shownHours(hours({ 5: [1, 0], 19: [0, 2] })).map((h) => h.hour)).toEqual(Array.from({ length: 15 }, (_, k) => k + 5));
  });

  it('whole steps of 1, 2 or 5 times a power of ten', () => {
    expect(axisScale(14)).toEqual({ top: 15, step: 5 });
    expect(axisScale(3)).toEqual({ top: 3, step: 1 });
    expect(axisScale(1)).toEqual({ top: 1, step: 1 });
    expect(axisScale(0)).toEqual({ top: 1, step: 1 });
    expect(axisScale(100)).toEqual({ top: 100, step: 50 });
  });
});

describe('the desk activity of today', () => {
  it('one slot per hour shown, labelled, with a legend and the same figures as a table', async () => {
    open();
    const section = await screen.findByRole('region', { name: 'Aktivitas meja hari ini' });
    const chart = await within(section).findByRole('group', { name: 'Pinjam dan kembali per jam hari ini' });
    const slots = within(chart).getAllByRole('img');
    expect(slots.map((s) => s.getAttribute('data-hour'))).toEqual(['7', '8', '9', '10', '11', '12', '13', '14', '15', '16', '17', '18']);
    expect(slots[1]!.getAttribute('aria-label')).toBe('Pukul 08.00–09.00: 4 pinjam, 1 kembali');
    expect(slots[0]!.getAttribute('aria-label')).toBe('Pukul 07.00–08.00: 0 pinjam, 0 kembali');
    expect(section.querySelector('[data-legend]')?.textContent).toBe('PinjamKembali');
    const table = within(section).getByRole('table', { name: 'Pinjam dan kembali per jam hari ini' });
    expect(within(table).getAllByRole('row')).toHaveLength(13);
    expect(within(table).getByRole('row', { name: 'Pukul 09.00–10.00 2 3' })).toBeTruthy();
  });

  it('the tooltip follows the keyboard: one tab stop, the arrow keys, Home and End', async () => {
    open();
    const chart = await screen.findByRole('group', { name: 'Pinjam dan kembali per jam hari ini' });
    const slots = within(chart).getAllByRole('img');
    expect(slots.map((s) => s.getAttribute('tabindex'))).toEqual(['0', ...Array.from({ length: 11 }, () => '-1')]);
    const tip = () => document.querySelector('[data-activity-tip]')?.textContent;
    expect(tip()).toBeUndefined();
    fireEvent.focus(slots[0]!);
    expect(tip()).toBe('Pukul 07.00–08.00Pinjam 0 · Kembali 0');
    fireEvent.keyDown(slots[0]!, { key: 'ArrowRight' });
    await waitFor(() => expect(document.activeElement).toBe(slots[1]));
    expect(tip()).toBe('Pukul 08.00–09.00Pinjam 4 · Kembali 1');
    fireEvent.keyDown(slots[1]!, { key: 'End' });
    await waitFor(() => expect(document.activeElement).toBe(slots[11]));
    expect(slots[11]!.getAttribute('tabindex')).toBe('0');
    fireEvent.blur(slots[11]!);
    expect(tip()).toBeUndefined();
  });

  it('a day with nothing says so instead of drawing an empty chart', async () => {
    open({ desk: desk({ loaned: 0, returned: 0, hours: hours({}) }) });
    const section = await screen.findByRole('region', { name: 'Aktivitas meja hari ini' });
    expect(await within(section).findByText('Belum ada peminjaman atau pengembalian hari ini.')).toBeTruthy();
    expect(section.querySelector('svg')).toBeNull();
    expect(within(section).queryByRole('table')).toBeNull();
  });

  it('a failed read offers to try again', async () => {
    startApp({
      me: adminMe(),
      path: '/admin',
      routes: { 'GET dashboard': () => SYSTEM, 'GET branches': () => ({ items: [BRANCH] }), 'GET dashboard/library': () => library() },
    });
    const section = await screen.findByRole('region', { name: 'Aktivitas meja hari ini' });
    expect(await within(section).findByText('Grafik gagal dimuat.', {}, { timeout: 5_000 })).toBeTruthy();
    expect(within(section).getByRole('button', { name: 'Coba lagi' })).toBeTruthy();
  });
});

describe('Perlu perhatian', () => {
  it('each line with its count and the screen that deals with it, errors of the system first', async () => {
    open({
      desk: desk({ holdsToClear: 3, holdsReady: 2 }),
      library: library({ members: { active: 480, joinedThisMonth: 12, expiringSoon: 7 }, loans: { longOverdue: 4 } }),
      system: {
        ...SYSTEM,
        alerts: [
          { kind: 'jobs_dead', severity: 'warning', messageKey: 'alert.jobs_dead', params: { count: 2 }, link: '/admin/jobs' },
          { kind: 'runner_stale', severity: 'error', messageKey: 'alert.runner_stale', link: '/admin/diagnostics' },
        ],
      },
    });
    const region = await screen.findByRole('region', { name: 'Perlu perhatian' });
    await waitFor(() => expect(region.querySelectorAll('[data-attention-item]')).toHaveLength(6));
    expect([...region.querySelectorAll('[data-attention-item]')].map((li) => [li.getAttribute('data-attention-item'), li.querySelector('a')?.getAttribute('href')])).toEqual([
      ['alert.runner_stale', '/admin/diagnostics'],
      ['long_overdue', '/admin/layanan/terlambat'],
      ['holds_to_clear', '/admin/layanan/rak-tunggu'],
      ['holds_ready', '/admin/layanan/rak-tunggu'],
      // The report set to the members the line counts: active, not yet ended, ending within 14 days.
      ['expiring', '/admin/reports/members.expiring?days=14&activeOnly=true'],
      ['alert.jobs_dead', '/admin/jobs'],
    ]);
    expect(within(region).getByRole('link', { name: 'Terlambat lebih dari 14 hari 4' })).toBeTruthy();
    expect(within(region).getByRole('link', { name: 'Keanggotaan berakhir dalam 14 hari 7' })).toBeTruthy();
  });

  it('says in one sentence that nothing needs attention, once its reads have answered', async () => {
    open();
    const region = await screen.findByRole('region', { name: 'Perlu perhatian' });
    expect(await within(region).findByText('Tidak ada yang perlu ditangani saat ini.')).toBeTruthy();
    expect(region.querySelectorAll('[data-attention-item]')).toHaveLength(0);
  });

  it('is left out for a user who reads none of its sources and has no line', async () => {
    open({ me: signedIn({ permissions: ['catalog.records.read'] }), library: library({ members: null, loans: null, usage: null }) });
    await screen.findByRole('heading', { name: 'Beranda', level: 1 });
    await waitFor(() => expect(document.querySelector('[data-home]')).not.toBeNull());
    expect(screen.queryByRole('region', { name: 'Perlu perhatian' })).toBeNull();
  });

  it('says the library figures could not be read, with "Coba lagi", instead of claiming nothing needs attention', async () => {
    let fail = true;
    startApp({
      me: adminMe(),
      path: '/admin',
      routes: {
        'GET dashboard': () => SYSTEM,
        'GET branches': () => ({ items: [BRANCH] }),
        'GET branches/:branchId/dashboard': () => desk(),
        'GET dashboard/library': () => (fail ? problem(500, 'INTERNAL') : library({ loans: { longOverdue: 3 } })),
      },
    });
    const region = await screen.findByRole('region', { name: 'Perlu perhatian' });
    expect(await within(region).findByText('Angka perpustakaan gagal dimuat.', {}, { timeout: 5_000 })).toBeTruthy();
    expect(within(region).queryByText('Tidak ada yang perlu ditangani saat ini.')).toBeNull();
    fail = false;
    fireEvent.click(within(region).getByRole('button', { name: 'Coba lagi' }));
    await waitFor(() => expect(region.querySelector('[data-attention-item="long_overdue"]')).not.toBeNull());
    expect(within(region).queryByText('Angka perpustakaan gagal dimuat.')).toBeNull();
  });
});

describe('the loans of the last 30 days', () => {
  it('by subject with the class names, most first, and as a table; the most borrowed titles numbered', async () => {
    open({ me: superMe() });
    const subjects = await screen.findByRole('region', { name: 'Peminjaman per subjek' });
    expect(within(subjects).getByText('30 hari terakhir')).toBeTruthy();
    const list = await within(subjects).findByRole('list', { name: 'Peminjaman per kelas DDC, 30 hari terakhir' });
    expect(within(list).getAllByRole('listitem').map((li) => li.textContent)).toEqual(['800 Kesusastraan142', '500 Sains dan matematika96', 'Lainnya (bukan DDC)3']);
    expect(within(subjects).getByRole('table', { name: 'Peminjaman per kelas DDC, 30 hari terakhir' })).toBeTruthy();
    expect(within(subjects).getByRole('link', { name: 'Laporan lengkap' }).getAttribute('href')).toBe('/admin/reports/circulation.loans_by_class');
    const top = screen.getByRole('region', { name: 'Judul paling sering dipinjam' });
    const items = within(top).getAllByRole('listitem');
    expect(items.map((li) => li.textContent)).toEqual(['1Judul Pertama12×dipinjam 12 kali', '2Judul Kedua9×dipinjam 9 kali']);
    expect(within(items[0]!).getByRole('link', { name: 'Judul Pertama' }).getAttribute('href')).toBe('/admin/catalog/records/01JZ00000000000000000REC01');
    expect(within(top).getByRole('link', { name: 'Laporan lengkap' }).getAttribute('href')).toBe('/admin/reports/circulation.top_titles');
  });

  it('an empty month says so in each block', async () => {
    open({ library: library({ usage: { from: '2026-10-17', to: '2026-11-15', bySubject: [], topTitles: [] } }) });
    expect(await screen.findByText('Belum ada peminjaman dalam 30 hari terakhir.')).toBeTruthy();
    expect(screen.getByText('Belum ada judul yang dipinjam dalam 30 hari terakhir.')).toBeTruthy();
  });

  it('a failed read keeps both blocks on the page, says so and offers to try again', async () => {
    let fail = true;
    startApp({
      me: superMe(),
      path: '/admin',
      routes: {
        'GET dashboard': () => SYSTEM,
        'GET branches': () => ({ items: [BRANCH] }),
        'GET branches/:branchId/dashboard': () => desk(),
        'GET dashboard/library': () => (fail ? problem(500, 'INTERNAL') : library()),
      },
    });
    const subjects = await screen.findByRole('region', { name: 'Peminjaman per subjek' });
    const top = screen.getByRole('region', { name: 'Judul paling sering dipinjam' });
    expect(await within(subjects).findByText('Angka perpustakaan gagal dimuat.', {}, { timeout: 5_000 })).toBeTruthy();
    expect(within(top).getByText('Angka perpustakaan gagal dimuat.')).toBeTruthy();
    fail = false;
    fireEvent.click(within(subjects).getByRole('button', { name: 'Coba lagi' }));
    expect(await within(subjects).findByRole('list', { name: 'Peminjaman per kelas DDC, 30 hari terakhir' })).toBeTruthy();
    await waitFor(() => expect(top.querySelectorAll('[data-top-title]')).toHaveLength(2));
  });

  it('a desk-only user sees the desk blocks and none of the library ones', async () => {
    const me = signedIn({ permissions: [] });
    me.branchPermissions = { B1: ['circulation.desk.use'] };
    open({ me, library: library({ members: null, loans: null, usage: null }) });
    await screen.findByRole('region', { name: 'Aktivitas meja hari ini' });
    expect(screen.getByRole('link', { name: 'Buka Meja Layanan' }).getAttribute('href')).toBe('/admin/layanan');
    await waitFor(() => expect(screen.queryByRole('region', { name: 'Peminjaman per subjek' })).toBeNull());
    expect(screen.queryByRole('region', { name: 'Statistik perpustakaan' })).toBeNull();
  });
});
