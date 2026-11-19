import { MESSAGES } from '@altis/shared';
import type { BackupItem } from '@altis/shared/api/backups';
import type { Alert, DashboardResponse } from '@altis/shared/api/dashboard';
import type { EventsResponse } from '@altis/shared/api/events';
import type { ScheduleView } from '@altis/shared/api/jobs';
import { screen, waitFor, within } from '@testing-library/react';
import { afterEach, describe, expect, it, vi } from 'vitest';
import { signedIn, startApp, superMe } from './fake-api';

// Dasbor sistem (spec §13.3 "Versi/update, backup terakhir, antrean, penjadwal, peringatan"; Task 31): `GET dashboard`
// is shown as one card on Beranda, "Kesehatan sistem" (one line per section the answer carries: the server leaves out
// what the caller may not see), and with every figure in the section "Sistem" of Tentang, one card per section. The
// alerts are lines of Beranda's "Perlu perhatian" with their links. It is read again when an event arrives on
// `system.status` or `system.backup`. The community edition has no licence card: the Versi card names the edition.

afterEach(() => {
  vi.unstubAllGlobals();
  vi.restoreAllMocks();
});

const AT = 1_760_000_000_000;

const VERSION: DashboardResponse['version'] = { current: '0.1.0', appJs: '1.0.0', bootProtocol: 1, update: null };

const BACKUP: BackupItem = {
  id: '01JZ00000000000000000BACK1',
  kind: 'scheduled',
  status: 'ok',
  size: 5 * 1024 * 1024,
  createdAt: AT - 3_600_000,
  consistency: 'snapshot',
  includesFiles: false,
  external: false,
  sameInstall: true,
  schemaVersion: '0009_ops_jobs',
  appVersion: '0.1.0',
  dialect: 'sqlite',
};

const DAILY: ScheduleView = {
  name: 'backup.daily',
  expr: '0 1 * * *',
  enabled: true,
  nextRunAt: AT + 3_600_000,
  lastRunAt: AT - 82_800_000,
  jobType: 'backup.schedule',
  exprEditable: true,
  permission: 'system.backup.create',
};

const RUNNER_STALE: Alert = { kind: 'runner_stale', severity: 'error', messageKey: 'alert.runner_stale', link: '/admin/diagnostics' };

function dashboard(o: Partial<DashboardResponse> = {}): DashboardResponse {
  return {
    version: VERSION,
    edition: { edition: 'community', status: 'active' },
    lastBackup: null,
    nextBackupAt: null,
    queue: null,
    scheduler: null,
    alerts: [],
    ...o,
  };
}

/** Everything a super admin sees. */
function full(o: Partial<DashboardResponse> = {}): DashboardResponse {
  return dashboard({
    lastBackup: BACKUP,
    nextBackupAt: DAILY.nextRunAt,
    queue: { queued: 3, running: 1, dead: 2, oldestQueuedMs: 90_000 },
    scheduler: { runner: { mode: 'external', lastRuns: { cron_http: AT - 120_000 } }, schedules: [DAILY] },
    alerts: [RUNNER_STALE],
    ...o,
  });
}

/** The card headings of Tentang's system section, in order. */
const cards = (): string[] => within(screen.getByRole('region', { name: 'Sistem' })).getAllByRole('heading', { level: 3 }).map((h) => h.textContent ?? '');

describe('system dashboard', () => {
  it('a runner_stale alert shows its message with a link to /admin/diagnostics, as a line of "Perlu perhatian"', async () => {
    startApp({ me: superMe(), path: '/admin', routes: { 'GET dashboard': () => full() } });
    const alerts = await screen.findByRole('region', { name: 'Perlu perhatian' });
    const item = (await within(alerts).findByText(MESSAGES.id['alert.runner_stale'])).closest('li');
    expect(item).not.toBeNull();
    const link = within(item as HTMLElement).getByRole('link');
    expect(link.getAttribute('href')).toBe('/admin/diagnostics');
    expect(within(item as HTMLElement).getByText('Masalah')).toBeTruthy();
  });

  it('a staff user without permissions sees the version card only', async () => {
    startApp({ me: signedIn({ permissions: [] }), path: '/admin/about', routes: { 'GET dashboard': () => dashboard() } });
    expect(await screen.findByRole('heading', { level: 3, name: 'Versi' })).toBeTruthy();
    expect(cards()).toEqual(['Versi']);
  });

  it('Beranda: a staff user without permissions gets the health card with the version and no line', async () => {
    startApp({ me: signedIn({ permissions: [] }), path: '/admin', routes: { 'GET dashboard': () => dashboard() } });
    const health = await screen.findByRole('region', { name: 'Kesehatan sistem' });
    expect(await within(health).findByText('ALTIS 0.1.0 · Edisi Komunitas')).toBeTruthy();
    expect(health.querySelectorAll('[data-health]')).toHaveLength(0);
    expect(within(health).getByRole('link', { name: 'Detail' }).getAttribute('href')).toBe('/admin/about');
    // The cards with every figure are on Tentang, the library's yearly figures on the reports page.
    expect(screen.queryByRole('region', { name: 'Sistem' })).toBeNull();
    expect(screen.queryByRole('region', { name: 'Statistik perpustakaan' })).toBeNull();
    expect(document.querySelector('[data-figures-moved]')).toBeNull();
    expect(screen.queryByRole('region', { name: 'Perlu perhatian' })).toBeNull();
    // The welcome stays under the title, and a user without any library block gets the hint to the command palette.
    expect(screen.getByText('Selamat datang, Ani.')).toBeTruthy();
    expect(screen.getByText(/^Pilih menu untuk mulai bekerja/)).toBeTruthy();
  });

  it('a super admin sees every section: version, last backup, queue and scheduler (no licence card)', async () => {
    startApp({ me: superMe(), path: '/admin/about', routes: { 'GET dashboard': () => full() } });
    await screen.findByRole('heading', { level: 3, name: 'Versi' });
    expect(cards()).toEqual(['Versi', 'Cadangan terakhir', 'Antrean tugas', 'Penjadwal']);
    expect(screen.queryByRole('region', { name: 'Lisensi' })).toBeNull();
    expect(screen.queryByRole('link', { name: /Lisensi/ })).toBeNull();
    const queue = screen.getByRole('region', { name: 'Antrean tugas' });
    expect(within(queue).getByText('3')).toBeTruthy();
    expect(within(queue).getByRole('link', { name: 'Lihat tugas' }).getAttribute('href')).toBe('/admin/jobs');
    const scheduler = screen.getByRole('region', { name: 'Penjadwal' });
    expect(within(scheduler).getByText('Cron atau pemicu luar')).toBeTruthy();
    expect(within(scheduler).getByRole('link', { name: 'Lihat jadwal' }).getAttribute('href')).toBe('/admin/jobs/schedules');
    const backup = screen.getByRole('region', { name: 'Cadangan terakhir' });
    expect(within(backup).getByText('Berhasil')).toBeTruthy();
  });

  it('Beranda: the health card has one line per section, each with its sentence, its state in words and its page', async () => {
    startApp({ me: superMe(), path: '/admin', routes: { 'GET dashboard': () => full({ alerts: [] }) } });
    const health = await screen.findByRole('region', { name: 'Kesehatan sistem' });
    await waitFor(() => expect(health.querySelectorAll('[data-health]').length).toBe(3));
    const line = (name: string) => health.querySelector(`[data-health="${name}"]`) as HTMLElement;
    expect([...health.querySelectorAll('[data-health]')].map((li) => li.getAttribute('data-health'))).toEqual(['backup', 'queue', 'scheduler']);
    expect(within(line('backup')).getByRole('link', { name: 'Cadangan terakhir' }).getAttribute('href')).toBe('/admin/backups');
    expect(within(line('backup')).getByText(/· 5 MB$/)).toBeTruthy();
    expect(within(line('backup')).getByText('Berhasil')).toBeTruthy();
    expect(within(line('queue')).getByRole('link', { name: 'Antrean tugas' }).getAttribute('href')).toBe('/admin/jobs');
    expect(within(line('queue')).getByText('3 menunggu · 1 berjalan')).toBeTruthy();
    expect(within(line('queue')).getByText('2 gagal')).toBeTruthy();
    expect(within(line('scheduler')).getByRole('link', { name: 'Penjadwal' }).getAttribute('href')).toBe('/admin/jobs/schedules');
    expect(within(line('scheduler')).getByText('1 dari 1 jadwal aktif')).toBeTruthy();
    expect(within(line('scheduler')).getByText('Aktif')).toBeTruthy();
    // A reader of the library's figures is told where the yearly figures are.
    const moved = document.querySelector('[data-figures-moved]') as HTMLElement;
    expect(within(moved).getByRole('link', { name: 'Semua laporan' }).getAttribute('href')).toBe('/admin/reports');
  });

  it('Beranda: a quiet runner, an empty queue and no backup yet say so in the health card', async () => {
    startApp({
      me: superMe(),
      path: '/admin',
      routes: { 'GET dashboard': () => full({ lastBackup: null, queue: { queued: 0, running: 0, dead: 0, oldestQueuedMs: null } }) },
    });
    const health = await screen.findByRole('region', { name: 'Kesehatan sistem' });
    await waitFor(() => expect(health.querySelectorAll('[data-health]').length).toBe(3));
    const line = (name: string) => health.querySelector(`[data-health="${name}"]`) as HTMLElement;
    expect(within(line('backup')).getByText('Belum ada cadangan.')).toBeTruthy();
    expect(within(line('queue')).getByText('Lancar')).toBeTruthy();
    expect(within(line('scheduler')).getByText('Tidak berjalan')).toBeTruthy();
  });

  it('the Versi card names the edition: "Edisi Komunitas", for everyone', async () => {
    startApp({ me: signedIn({ permissions: [] }), path: '/admin/about', routes: { 'GET dashboard': () => dashboard() } });
    const version = await screen.findByRole('region', { name: 'Versi' });
    expect(within(version).getByText('Edisi')).toBeTruthy();
    expect(within(version).getByText('Edisi Komunitas')).toBeTruthy();
    expect(within(version).getByText('0.1.0')).toBeTruthy();
  });

  it('a backup reader with no backup yet sees the backup card saying so', async () => {
    startApp({
      me: signedIn({ permissions: ['system.backup.read'] }),
      path: '/admin/about',
      routes: { 'GET dashboard': () => dashboard() },
    });
    const backup = await screen.findByRole('region', { name: 'Cadangan terakhir' });
    expect(within(backup).getByText('Belum ada cadangan.')).toBeTruthy();
    expect(cards()).toEqual(['Versi', 'Cadangan terakhir']);
  });

  it('an event on system.status reads the dashboard again', async () => {
    // The first poll is answered once the dashboard has been read: its event then hints at a change.
    let answered!: () => void;
    const firstAnswer = new Promise<void>((resolve) => {
      answered = resolve;
    });
    let answers = 0;
    let polls = 0;
    const events = async (): Promise<EventsResponse> => {
      polls += 1;
      if (polls > 1) return { cursor: '1.4', events: [] };
      await firstAnswer;
      return { cursor: '1.4', events: [{ seq: 4, channel: 'system.status', type: 'clock.anomaly', payload: {}, at: AT }] };
    };
    const app = startApp({
      me: superMe(),
      path: '/admin',
      routes: {
        'GET dashboard': () => {
          answers += 1;
          answered();
          return answers === 1 ? full({ alerts: [] }) : full({ alerts: [RUNNER_STALE] });
        },
        'GET events': events,
      },
    });
    expect(await screen.findByRole('region', { name: 'Perlu perhatian' })).toBeTruthy();
    expect(answers).toBe(2);
    const channels = app.requests.find((r) => r.path === 'events')?.query.get('channels')?.split(',') ?? [];
    expect(channels).toEqual(expect.arrayContaining(['system.status', 'system.backup']));
  });

  it('a backup.progress hint does not read the dashboard again', async () => {
    let answered!: () => void;
    const firstAnswer = new Promise<void>((resolve) => {
      answered = resolve;
    });
    let answers = 0;
    let polls = 0;
    let hinted = false;
    const events = async (): Promise<EventsResponse> => {
      polls += 1;
      if (polls > 1) return { cursor: '1.5', events: [] };
      await firstAnswer;
      hinted = true;
      return { cursor: '1.5', events: [{ seq: 5, channel: 'system.backup', type: 'backup.progress', payload: {}, at: AT }] };
    };
    startApp({
      me: superMe(),
      path: '/admin',
      routes: {
        'GET dashboard': () => {
          answers += 1;
          answered();
          return full();
        },
        'GET events': events,
      },
    });
    await screen.findByRole('region', { name: 'Perlu perhatian' });
    await waitFor(() => expect(hinted).toBe(true));
    // Time for the answer to reach the realtime client and for any read it caused to go out.
    await new Promise((resolve) => setTimeout(resolve, 100));
    expect(answers).toBe(1);
  });
});

// ---- 1d Task 29 (preflight S13): the update card linking to Pembaruan --------------------------------------------
describe('system dashboard: updates (1d Task 29)', () => {
  const UPDATE: NonNullable<DashboardResponse['version']['update']> = {
    available: { version: '0.2.0', releasedAt: '2026-10-20', notesUrl: null, steppingStone: false },
    checkedAt: AT - 3_600_000,
    entitled: true,
    oneClick: true,
    pinned: null,
  };

  it('the update card shows the release found and links to Pembaruan (/admin/updates); "Perlu perhatian" says it is there', async () => {
    startApp({ me: superMe(), path: '/admin/about', routes: { 'GET dashboard': () => full({ version: { ...VERSION, update: UPDATE }, alerts: [] }) } });
    const card = await screen.findByRole('region', { name: 'Pembaruan' });
    expect(cards()).toEqual(['Versi', 'Pembaruan', 'Cadangan terakhir', 'Antrean tugas', 'Penjadwal']);
    expect(within(card).getByText('0.2.0')).toBeTruthy();
    expect(within(card).getByRole('link', { name: 'Buka Pembaruan' }).getAttribute('href')).toBe('/admin/updates');
    expect(within(card).queryByText(/tidak mencakup/)).toBeNull();
  });

  it('Beranda: a release found is a line of "Perlu perhatian" and the state of the health card\'s Pembaruan line', async () => {
    startApp({ me: superMe(), path: '/admin', routes: { 'GET dashboard': () => full({ version: { ...VERSION, update: UPDATE }, alerts: [] }) } });
    const attention = await screen.findByRole('region', { name: 'Perlu perhatian' });
    expect((await within(attention).findByRole('link', { name: 'Pembaruan 0.2.0 tersedia' })).getAttribute('href')).toBe('/admin/updates');
    const line = document.querySelector('[data-health="update"]') as HTMLElement;
    expect(within(line).getByRole('link', { name: 'Pembaruan' }).getAttribute('href')).toBe('/admin/updates');
    expect(within(line).getByText('0.2.0 tersedia')).toBeTruthy();
    expect(within(line).getByText(/^Diperiksa /)).toBeTruthy();
  });

  it('Beranda: before any update check the health card offers "Periksa"; after one with nothing newer it says "Terbaru"', async () => {
    let update = { ...UPDATE, available: null, checkedAt: null as number | null };
    const app = startApp({ me: superMe(), path: '/admin', routes: { 'GET dashboard': () => full({ version: { ...VERSION, update }, alerts: [] }) } });
    const health = await screen.findByRole('region', { name: 'Kesehatan sistem' });
    const check = await within(health).findByRole('link', { name: 'Periksa pembaruan' });
    expect(check.getAttribute('href')).toBe('/admin/updates');
    expect(within(health).getByText('Belum pernah diperiksa')).toBeTruthy();
    update = { ...update, checkedAt: AT };
    await app.queryClient.invalidateQueries({ queryKey: ['dashboard'] });
    expect(await within(health).findByText('Terbaru')).toBeTruthy();
    expect(within(health).queryByRole('link', { name: 'Periksa pembaruan' })).toBeNull();
  });

  it('the update card: a release this edition does not cover (the edition seam), a pin, image mode', async () => {
    const update = { ...UPDATE, entitled: false, oneClick: false, pinned: '0.1.5' };
    startApp({ me: superMe(), path: '/admin/about', routes: { 'GET dashboard': () => full({ version: { ...VERSION, update }, alerts: [] }) } });
    const card = await screen.findByRole('region', { name: 'Pembaruan' });
    expect(within(card).getByText('Edisi ini tidak mencakup rilis ini.')).toBeTruthy();
    expect(within(card).queryByText(/[Ll]isensi/)).toBeNull();
    expect(within(card).getByText('0.1.5')).toBeTruthy();
    expect(within(card).getByText(/image Docker/)).toBeTruthy();
    expect(within(card).getByRole('link', { name: 'Buka Pembaruan' }).getAttribute('href')).toBe('/admin/updates');
  });

  it('the update card when nothing newer was found, or before any check', async () => {
    const update = { ...UPDATE, available: null, checkedAt: null };
    startApp({ me: superMe(), path: '/admin/about', routes: { 'GET dashboard': () => full({ version: { ...VERSION, update }, alerts: [] }) } });
    const card = await screen.findByRole('region', { name: 'Pembaruan' });
    expect(within(card).getByText('Tidak ada pembaruan')).toBeTruthy();
    expect(within(card).getByText('Belum pernah')).toBeTruthy();
  });

  it('no update card without the update section (a staff member without system.update.read)', async () => {
    startApp({
      me: signedIn({ permissions: ['system.jobs.read'] }),
      path: '/admin/about',
      routes: { 'GET dashboard': () => dashboard({ queue: { queued: 0, running: 0, dead: 0, oldestQueuedMs: null } }) },
    });
    await screen.findByRole('region', { name: 'Antrean tugas' });
    expect(cards()).toEqual(['Versi', 'Antrean tugas']);
  });

  it('the alerts of 1d show their message and the page that explains them, errors first', async () => {
    const alerts: Alert[] = [
      { kind: 'schema_hold', severity: 'error', messageKey: 'alert.schema_hold', link: '/admin/updates' },
      { kind: 'update_blocked', severity: 'warning', messageKey: 'alert.update_blocked', link: '/admin/updates' },
      { kind: 'bundled_ignored', severity: 'info', messageKey: 'alert.bundled_ignored', link: '/admin/updates' },
    ];
    startApp({ me: superMe(), path: '/admin', routes: { 'GET dashboard': () => full({ alerts }) } });
    const region = await screen.findByRole('region', { name: 'Perlu perhatian' });
    await waitFor(() => expect(region.querySelectorAll('[data-attention-item]').length).toBeGreaterThan(0));
    for (const alert of alerts) {
      const item = within(region).getByText(MESSAGES.id[alert.messageKey as keyof typeof MESSAGES.id]).closest('li') as HTMLElement;
      expect(within(item).getByRole('link').getAttribute('href'), alert.kind).toBe(alert.link);
    }
    expect([...region.querySelectorAll('[data-attention-item]')].map((li) => li.getAttribute('data-attention-item'))).toEqual([
      'alert.schema_hold',
      'alert.update_blocked',
      'alert.bundled_ignored',
    ]);
  });
});
