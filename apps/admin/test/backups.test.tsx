import type { BackupItem, BackupListResponse } from '@altis/shared/api/backups';
import type { DashboardResponse } from '@altis/shared/api/dashboard';
import type { EventsResponse } from '@altis/shared/api/events';
import type { JobView } from '@altis/shared/api/jobs';
import { fireEvent, screen, waitFor, within } from '@testing-library/react';
import { afterEach, describe, expect, it, vi } from 'vitest';
import { page } from '@/lib/page';
import { FOLLOW_POLL_MS } from '@/screens/backups/prepare-dialog';
import { DRIVE_IDLE_MS, DRIVE_MIN_GAP_MS } from '@/screens/jobs/detail';
import { adminMe, problem, signedIn, startApp, superMe, type FakeHandler, type FakeRequest } from './fake-api';

// Cadangan (spec §13.3 "Backup: Daftar, buat sekarang, siapkan unduhan (frasa sandi), unggah, restore", §9.9, §9.10;
// 1c Task 32): the list with kind, the "eksternal" badge, status, size and consistency; "Buat sekarang" (a snapshot
// follows its `backup.progress` events, a frozen backup loads the operations page); "Siapkan unduhan" (a passphrase
// typed twice, at least 10 characters, or the explicit unencrypted opt-in; the prepare job driven while the dialog is
// open in external mode, then the download link; 409 BACKUP_PREPARE_IN_PROGRESS offers to wait or cancel); "Unggah"
// (the adaptive chunked upload with progress, then `POST backups/upload`); "Pulihkan" (the library name typed for an
// external archive, the passphrase of an encrypted one; then the operations page).

afterEach(() => {
  vi.unstubAllGlobals();
  vi.restoreAllMocks();
});

const AT = 1_760_000_000_000;
const OWN_ID = '01JZ000000000000000000BK01';
const EXT_ID = '01JZ000000000000000000BK02';
const RUN_ID = '01JZ000000000000000000BK03';
const JOB_ID = '01JZ000000000000000000JB01';
const LIVE_JOB = '01JZ000000000000000000JB09';
const UPLOAD_ID = '01JZ000000000000000000UP01';
const KIB = 1024;

function backup(o: Partial<BackupItem> = {}): BackupItem {
  return {
    id: OWN_ID,
    kind: 'manual',
    status: 'ok',
    size: 1_572_864,
    createdAt: AT,
    consistency: 'snapshot',
    includesFiles: false,
    external: false,
    sameInstall: true,
    schemaVersion: '0009',
    appVersion: '0.1.0',
    dialect: 'sqlite',
    ...o,
  };
}

const EXTERNAL = backup({ id: EXT_ID, kind: 'external', status: 'uploaded', consistency: 'frozen', external: true, sameInstall: false, dialect: 'mysql' });

function job(o: Partial<JobView> = {}): JobView {
  return {
    id: JOB_ID,
    type: 'backup.prepare_download',
    status: 'queued',
    progress: 0,
    progressMessage: null,
    attempts: 0,
    maxAttempts: 5,
    lastError: null,
    runAt: AT,
    createdAt: AT,
    updatedAt: AT,
    finishedAt: null,
    createdBy: 'U1',
    retryable: 'origin-only',
    cancellable: true,
    interactive: true,
    ...o,
  };
}

function dashboardIn(mode: 'worker' | 'external'): DashboardResponse {
  return {
    version: { current: '0.1.0', appJs: null, bootProtocol: 1, update: null },
    edition: { edition: 'community', status: 'active' },
    lastBackup: null,
    nextBackupAt: null,
    queue: { queued: 0, running: 0, dead: 0, oldestQueuedMs: null },
    scheduler: { runner: { mode, lastRuns: {} }, schedules: [] },
    alerts: [],
  };
}

/** The backups API serving `items()` at `GET backups`, in worker mode unless `extra` says otherwise. */
function routes(items: () => BackupItem[], extra: Record<string, FakeHandler> = {}): Record<string, FakeHandler> {
  return {
    'GET backups': (): BackupListResponse => ({ items: items(), nextScheduledAt: AT + 86_400_000 }),
    'GET dashboard': () => dashboardIn('worker'),
    ...extra,
  };
}

const bodiesOf = (app: ReturnType<typeof startApp>, method: string, path: string): unknown[] =>
  app.requests.filter((r) => r.method === method && r.path === path).map((r) => r.body);

/** The row of the list that holds `text`. */
async function rowWith(text: string): Promise<HTMLElement> {
  const table = await screen.findByRole('table');
  const cell = await within(table).findByText(text);
  return cell.closest('tr')!;
}

describe('the backups list', () => {
  it('shows each backup with its kind, the "eksternal" badge, status, size and consistency', async () => {
    startApp({ me: adminMe(), path: '/admin/backups', routes: routes(() => [backup(), EXTERNAL]) });
    expect(await screen.findByRole('heading', { name: 'Cadangan', level: 1 })).toBeTruthy();
    const own = await rowWith('Manual');
    expect(within(own).getByText('Berhasil')).toBeTruthy();
    expect(within(own).getByText('1,5 MB')).toBeTruthy();
    expect(within(own).getByText('Snapshot')).toBeTruthy();
    expect(within(own).queryByText('eksternal')).toBeNull();
    const ext = await rowWith('Arsip unggahan');
    expect(within(ext).getByText('eksternal')).toBeTruthy();
    expect(within(ext).getByText('Diunggah')).toBeTruthy();
    expect(within(ext).getByText('Dibekukan')).toBeTruthy();
  });

  it('offers each action only to the holder of its permission', async () => {
    startApp({ me: signedIn({ permissions: ['system.backup.read'] }), path: '/admin/backups', routes: routes(() => [backup(), EXTERNAL]) });
    await rowWith('Manual');
    expect(screen.queryByRole('button', { name: 'Buat sekarang' })).toBeNull();
    expect(screen.queryByRole('button', { name: /Siapkan unduhan/ })).toBeNull();
    expect(screen.queryByRole('button', { name: /Pulihkan/ })).toBeNull();
    expect(screen.queryByLabelText('Berkas arsip (.altisbak)')).toBeNull();
  });
});

describe('Buat sekarang', () => {
  it('a snapshot backup shows its progress from the backup.progress events', async () => {
    let items = [backup()];
    let sent = false;
    const events = (req: FakeRequest): EventsResponse => {
      const channels = req.query.get('channels')?.split(',') ?? [];
      if (!sent && items.length > 1 && channels.includes('system.backup')) {
        sent = true;
        return {
          cursor: '1.9',
          events: [{ seq: 9, channel: 'system.backup', type: 'backup.progress', payload: { backupId: RUN_ID, progress: 40 }, at: AT }],
        };
      }
      return { cursor: '1.8', events: [] };
    };
    const app = startApp({
      me: adminMe(),
      path: '/admin/backups',
      routes: routes(() => items, {
        'GET events': events,
        'POST backups': () => {
          items = [backup({ id: RUN_ID, status: 'running', size: null, createdAt: AT + 1000 }), backup()];
          return { consistency: 'snapshot', jobId: JOB_ID };
        },
      }),
    });
    fireEvent.click(await screen.findByLabelText('Sertakan berkas unggahan'));
    fireEvent.click(screen.getByRole('button', { name: 'Buat sekarang' }));
    await waitFor(() => expect(bodiesOf(app, 'POST', 'backups')).toEqual([{ includeFiles: true }]));
    expect(await screen.findByText('Cadangan sedang dibuat. Kemajuannya tampil di daftar.')).toBeTruthy();
    const running = await rowWith('Sedang dibuat');
    await waitFor(() => expect(within(running).getByRole('progressbar').getAttribute('aria-valuenow')).toBe('40'), { timeout: 4000 });
  });

  it('a frozen backup loads the operations page /admin/_update', async () => {
    const assign = vi.spyOn(page, 'assign').mockImplementation(() => {});
    const app = startApp({
      me: adminMe(),
      path: '/admin/backups',
      routes: routes(() => [backup()], { 'POST backups': () => ({ consistency: 'frozen', opId: '01JZ000000000000000000OP01' }) }),
    });
    fireEvent.click(await screen.findByRole('button', { name: 'Buat sekarang' }));
    await waitFor(() => expect(assign).toHaveBeenCalledWith('/admin/_update'));
    expect(bodiesOf(app, 'POST', 'backups')).toEqual([{ includeFiles: false }]);
  });

  it('a refusal (another op in progress) is shown', async () => {
    startApp({
      me: adminMe(),
      path: '/admin/backups',
      routes: routes(() => [backup()], { 'POST backups': () => problem(409, 'OPS_IN_PROGRESS') }),
    });
    fireEvent.click(await screen.findByRole('button', { name: 'Buat sekarang' }));
    expect(await screen.findByText('Operasi sistem lain sedang berjalan. Tunggu sampai selesai, lalu coba lagi.')).toBeTruthy();
  });
});

describe('Siapkan unduhan', () => {
  async function openPrepare(): Promise<HTMLElement> {
    const own = await rowWith('Manual');
    fireEvent.click(within(own).getByRole('button', { name: /Siapkan unduhan/ }));
    return screen.findByRole('dialog', { name: 'Siapkan unduhan cadangan' });
  }

  const type = (dialog: HTMLElement, label: string, value: string): void => {
    fireEvent.change(within(dialog).getByLabelText(label), { target: { value } });
  };

  it('refuses a 9-character passphrase and two passphrases that differ, before anything is sent', async () => {
    const app = startApp({
      me: superMe(),
      path: '/admin/backups',
      routes: routes(() => [backup()], { 'POST backups/:id/prepare-download': () => problem(500, 'INTERNAL') }),
    });
    const dialog = await openPrepare();
    type(dialog, 'Frasa sandi', 'sembilan9');
    type(dialog, 'Ulangi frasa sandi', 'sembilan9');
    fireEvent.click(within(dialog).getByRole('button', { name: 'Siapkan' }));
    expect(await within(dialog).findByText('Frasa sandi paling sedikit 10 karakter.')).toBeTruthy();
    type(dialog, 'Frasa sandi', 'sepuluh-10');
    type(dialog, 'Ulangi frasa sandi', 'sepuluh-11');
    fireEvent.click(within(dialog).getByRole('button', { name: 'Siapkan' }));
    expect(await within(dialog).findByText('Kedua frasa sandi tidak sama.')).toBeTruthy();
    expect(app.writes()).toEqual([]);
  });

  it('an unencrypted download needs the explicit opt-in box, which warns', async () => {
    const app = startApp({
      me: superMe(),
      path: '/admin/backups',
      routes: routes(() => [backup()], {
        'POST backups/:id/prepare-download': () => ({ jobId: JOB_ID }),
        'GET jobs/:id': () => job(),
      }),
    });
    const dialog = await openPrepare();
    fireEvent.click(within(dialog).getByRole('button', { name: 'Siapkan' }));
    expect(await within(dialog).findByText('Frasa sandi paling sedikit 10 karakter.')).toBeTruthy();
    expect(app.writes()).toEqual([]);
    fireEvent.click(within(dialog).getByLabelText('Unduh tanpa enkripsi'));
    expect(within(dialog).getByText(/Arsip tanpa enkripsi dapat dibaca siapa pun/)).toBeTruthy();
    expect(within(dialog).queryByLabelText('Frasa sandi')).toBeNull();
    fireEvent.click(within(dialog).getByRole('button', { name: 'Siapkan' }));
    await waitFor(() => expect(bodiesOf(app, 'POST', `backups/${OWN_ID}/prepare-download`)).toEqual([{ unencrypted: true }]));
  });

  it('goes through the reauth dialog, drives the job while open (external mode), then links the download', async () => {
    let reauthed = false;
    let current = job();
    const app = startApp({
      me: superMe(),
      path: '/admin/backups',
      routes: routes(() => [backup()], {
        'GET dashboard': () => dashboardIn('external'),
        'POST auth/reauth': () => {
          reauthed = true;
          return { reauthUntil: AT + 300_000 };
        },
        'POST backups/:id/prepare-download': () => (reauthed ? { jobId: JOB_ID } : problem(401, 'AUTH_REAUTH_REQUIRED')),
        'GET jobs/:id': () => current,
        'POST jobs/:id/drive': () => {
          current = job({ status: 'succeeded', progress: 100, updatedAt: AT + 5000, finishedAt: AT + 5000, cancellable: false });
          return current;
        },
      }),
    });
    const dialog = await openPrepare();
    type(dialog, 'Frasa sandi', 'frasa-sandi-panjang');
    type(dialog, 'Ulangi frasa sandi', 'frasa-sandi-panjang');
    fireEvent.click(within(dialog).getByRole('button', { name: 'Siapkan' }));
    const reauth = await screen.findByRole('dialog', { name: 'Konfirmasi kata sandi' });
    fireEvent.change(within(reauth).getByLabelText('Kata sandi'), { target: { value: 'kata-sandi-ani' } });
    fireEvent.click(within(reauth).getByRole('button', { name: 'Konfirmasi' }));
    const link = await screen.findByRole('link', { name: 'Unduh arsip' });
    expect(link.getAttribute('href')).toBe(`/api/v1/backups/${OWN_ID}/download`);
    expect(bodiesOf(app, 'POST', `backups/${OWN_ID}/prepare-download`)).toEqual([
      { passphrase: 'frasa-sandi-panjang' },
      { passphrase: 'frasa-sandi-panjang' },
    ]);
    expect(app.writes().filter((w) => w === `POST jobs/${JOB_ID}/drive`)).toHaveLength(1);
  });

  describe('driving (external mode)', () => {
    afterEach(() => {
      vi.useRealTimers();
    });

    /** External mode; `drive` answers each `POST jobs/:id/drive`. */
    function driven(drive: (n: number) => JobView) {
      let calls = 0;
      let current = job();
      const app = startApp({
        me: superMe(),
        path: '/admin/backups',
        routes: routes(() => [backup()], {
          'GET dashboard': () => dashboardIn('external'),
          'POST backups/:id/prepare-download': () => ({ jobId: JOB_ID }),
          'GET jobs/:id': () => current,
          'POST jobs/:id/drive': () => {
            calls += 1;
            current = drive(calls);
            return current;
          },
        }),
      });
      return { app, drives: () => calls };
    }

    async function prepareUnencrypted(): Promise<HTMLElement> {
      const dialog = await openPrepare();
      fireEvent.click(within(dialog).getByLabelText('Unduh tanpa enkripsi'));
      fireEvent.click(within(dialog).getByRole('button', { name: 'Siapkan' }));
      return dialog;
    }

    it(`drives one call after the other while the job moves, ${DRIVE_MIN_GAP_MS} ms apart at least`, async () => {
      vi.useFakeTimers({ shouldAdvanceTime: true });
      const { drives } = driven((n) =>
        n < 3 ? job({ status: 'running', progress: n * 30, updatedAt: AT + n }) : job({ status: 'succeeded', progress: 100, updatedAt: AT + n, finishedAt: AT + n }),
      );
      await prepareUnencrypted();
      await waitFor(() => expect(drives()).toBe(1));
      expect(await screen.findByText('30 %')).toBeTruthy();
      await vi.advanceTimersByTimeAsync(DRIVE_MIN_GAP_MS);
      await waitFor(() => expect(drives()).toBe(2));
      await vi.advanceTimersByTimeAsync(DRIVE_MIN_GAP_MS);
      expect(await screen.findByRole('link', { name: 'Unduh arsip' })).toBeTruthy();
      expect(drives()).toBe(3);
    });

    it('a drive call that fails on the way (a 502 while the host restarts) offers "Jalankan lagi", which drives again', async () => {
      const { app, drives } = driven((n) =>
        n === 2 ? job({ status: 'succeeded', progress: 100, updatedAt: AT + n, finishedAt: AT + n }) : job({ status: 'running', progress: 10, updatedAt: AT + n }),
      );
      // The first call meets the host's own 502 page (no problem+json), the next one the server.
      const answer = app.fetchMock.getMockImplementation()!;
      let failed = false;
      app.fetchMock.mockImplementation(async (input, init) => {
        if (!failed && init?.method === 'POST' && String(input).endsWith('/drive')) {
          failed = true;
          return new Response('<html>Bad Gateway</html>', { status: 502, headers: { 'Content-Type': 'text/html' } });
        }
        return answer(input, init);
      });
      const dialog = await prepareUnencrypted();
      const again = await within(dialog).findByRole('button', { name: 'Jalankan lagi' });
      expect(drives()).toBe(0);
      fireEvent.click(again);
      expect(await screen.findByRole('link', { name: 'Unduh arsip' }, { timeout: 4000 })).toBeTruthy();
      expect(drives()).toBe(2);
    });

    it('a refusal that will not pass (403) stops driving without "Jalankan lagi"', async () => {
      const app = startApp({
        me: superMe(),
        path: '/admin/backups',
        routes: routes(() => [backup()], {
          'GET dashboard': () => dashboardIn('external'),
          'POST backups/:id/prepare-download': () => ({ jobId: JOB_ID }),
          'GET jobs/:id': () => job({ status: 'running', progress: 10 }),
          'POST jobs/:id/drive': () => problem(403, 'AUTHZ_DENIED'),
        }),
      });
      const dialog = await prepareUnencrypted();
      await waitFor(() => expect(app.writes()).toContain(`POST jobs/${JOB_ID}/drive`));
      expect(await within(dialog).findByText('Anda tidak memiliki izin untuk melakukan ini.')).toBeTruthy();
      expect(within(dialog).queryByRole('button', { name: 'Jalankan lagi' })).toBeNull();
    });

    it('closing the dialog stops driving', async () => {
      vi.useFakeTimers({ shouldAdvanceTime: true });
      // The job is not due yet: every call answers it unchanged, so the loop waits between calls.
      const { drives } = driven(() => job());
      const dialog = await prepareUnencrypted();
      await waitFor(() => expect(drives()).toBe(1));
      fireEvent.click(within(dialog).getAllByRole('button', { name: 'Tutup' })[0]!);
      await waitFor(() => expect(screen.queryByRole('dialog')).toBeNull());
      await vi.advanceTimersByTimeAsync(10 * DRIVE_IDLE_MS);
      expect(drives()).toBe(1);
    });
  });

  it('in worker mode the job is followed through its events, not driven', async () => {
    let done = false;
    let sent = false;
    const events = (req: FakeRequest): EventsResponse => {
      const channels = req.query.get('channels')?.split(',') ?? [];
      if (!sent && channels.includes(`jobs.${JOB_ID}`)) {
        sent = true;
        done = true;
        const e = { seq: 12, channel: `jobs.${JOB_ID}`, type: 'job.finished', payload: { status: 'succeeded', progress: 100 }, at: AT };
        return { cursor: '1.12', events: [e] };
      }
      return { cursor: '1.11', events: [] };
    };
    const app = startApp({
      me: superMe(),
      path: '/admin/backups',
      routes: routes(() => [backup()], {
        'GET events': events,
        'POST backups/:id/prepare-download': () => ({ jobId: JOB_ID }),
        'GET jobs/:id': () => (done ? job({ status: 'succeeded', progress: 100, finishedAt: AT + 1 }) : job({ status: 'running', progress: 30 })),
      }),
    });
    const dialog = await openPrepare();
    fireEvent.click(within(dialog).getByLabelText('Unduh tanpa enkripsi'));
    fireEvent.click(within(dialog).getByRole('button', { name: 'Siapkan' }));
    expect(await within(dialog).findByRole('progressbar')).toBeTruthy();
    expect(await screen.findByRole('link', { name: 'Unduh arsip' }, { timeout: 4000 })).toBeTruthy();
    expect(app.writes().some((w) => w.endsWith('/drive'))).toBe(false);
  });

  describe('following the job (worker mode)', () => {
    afterEach(() => {
      vi.useRealTimers();
    });

    /** For each `GET jobs/<JOB_ID>` sent: whether it carried `X-Altis-Background: 1`. */
    const jobReads = (app: ReturnType<typeof startApp>): boolean[] =>
      app.fetchMock.mock.calls
        .filter(([url, init]) => (init?.method ?? 'GET') === 'GET' && String(url) === `/api/v1/jobs/${JOB_ID}`)
        .map(([, init]) => (init?.headers as Record<string, string>)['X-Altis-Background'] === '1');

    async function prepare(jobAnswer: FakeHandler) {
      vi.useFakeTimers({ shouldAdvanceTime: true });
      const app = startApp({
        me: superMe(),
        path: '/admin/backups',
        routes: routes(() => [backup()], { 'POST backups/:id/prepare-download': () => ({ jobId: JOB_ID }), 'GET jobs/:id': jobAnswer }),
      });
      const dialog = await openPrepare();
      fireEvent.click(within(dialog).getByLabelText('Unduh tanpa enkripsi'));
      fireEvent.click(within(dialog).getByRole('button', { name: 'Siapkan' }));
      return { app, dialog };
    }

    it(`reads a running job every ${FOLLOW_POLL_MS} ms in the background (it never keeps the session alive)`, async () => {
      const { app, dialog } = await prepare(() => job({ status: 'running', progress: 30 }));
      expect(await within(dialog).findByRole('progressbar')).toBeTruthy();
      await vi.advanceTimersByTimeAsync(2 * FOLLOW_POLL_MS);
      await waitFor(() => expect(jobReads(app).length).toBeGreaterThanOrEqual(3));
      expect(jobReads(app).every(Boolean)).toBe(true);
    });

    it('stops reading once the job was refused (404: gone, or not the caller\'s)', async () => {
      const { app, dialog } = await prepare(() => problem(404, 'NOT_FOUND'));
      await waitFor(() => expect(jobReads(app)).toHaveLength(1));
      expect(await within(dialog).findByRole('alert')).toBeTruthy();
      await vi.advanceTimersByTimeAsync(4 * FOLLOW_POLL_MS);
      expect(jobReads(app)).toHaveLength(1);
    });
  });

  it('a 409 BACKUP_PREPARE_IN_PROGRESS offers to wait for the live job or to cancel it', async () => {
    const detail =
      `Unduhan backup ini masih disiapkan dengan pilihan lain (tugas ${LIVE_JOB}); tunggu sampai selesai atau batalkan, lalu siapkan lagi / ` +
      `A download of this backup is still being prepared with other choices (job ${LIVE_JOB}); wait for it or cancel it, then prepare again`;
    const app = startApp({
      me: superMe(),
      path: '/admin/backups',
      routes: routes(() => [backup()], {
        'POST backups/:id/prepare-download': () => problem(409, 'BACKUP_PREPARE_IN_PROGRESS', { detail }),
        'POST jobs/:id/cancel': () => job({ id: LIVE_JOB, status: 'cancelled', cancellable: false, finishedAt: AT + 1 }),
      }),
    });
    const dialog = await openPrepare();
    type(dialog, 'Frasa sandi', 'frasa-sandi-panjang');
    type(dialog, 'Ulangi frasa sandi', 'frasa-sandi-panjang');
    fireEvent.click(within(dialog).getByRole('button', { name: 'Siapkan' }));
    expect(await within(dialog).findByText(new RegExp(`masih disiapkan dengan pilihan lain \\(tugas ${LIVE_JOB}\\)`))).toBeTruthy();
    expect(within(dialog).getByRole('button', { name: 'Tunggu tugas itu' })).toBeTruthy();
    fireEvent.click(within(dialog).getByRole('button', { name: 'Batalkan tugas itu' }));
    await waitFor(() => expect(app.writes()).toContain(`POST jobs/${LIVE_JOB}/cancel`));
    expect(await within(dialog).findByText('Tugas itu dibatalkan. Anda dapat menyiapkan unduhan lagi.')).toBeTruthy();
  });

  it('"Tunggu tugas itu" follows the live job until its archive is ready', async () => {
    const detail = `… (tugas ${LIVE_JOB}) … / … (job ${LIVE_JOB}) …`;
    startApp({
      me: superMe(),
      path: '/admin/backups',
      routes: routes(() => [backup()], {
        'POST backups/:id/prepare-download': () => problem(409, 'BACKUP_PREPARE_IN_PROGRESS', { detail }),
        'GET jobs/:id': (req) => job({ id: req.params['id']!, status: 'succeeded', progress: 100, finishedAt: AT + 1 }),
      }),
    });
    const dialog = await openPrepare();
    fireEvent.click(within(dialog).getByLabelText('Unduh tanpa enkripsi'));
    fireEvent.click(within(dialog).getByRole('button', { name: 'Siapkan' }));
    fireEvent.click(await within(dialog).findByRole('button', { name: 'Tunggu tugas itu' }));
    expect(await screen.findByRole('link', { name: 'Unduh arsip' })).toBeTruthy();
  });
});

describe('Pulihkan', () => {
  it('an external archive keeps "Pulihkan" disabled until the typed library name matches, then loads /admin/_update', async () => {
    const assign = vi.spyOn(page, 'assign').mockImplementation(() => {});
    const app = startApp({
      me: superMe(),
      path: '/admin/backups',
      routes: routes(() => [backup(), EXTERNAL], { 'POST backups/:id/restore': () => ({ opId: '01JZ000000000000000000OP02' }) }),
    });
    const ext = await rowWith('Arsip unggahan');
    fireEvent.click(within(ext).getByRole('button', { name: /Pulihkan/ }));
    const dialog = await screen.findByRole('dialog', { name: 'Pulihkan data dari cadangan' });
    const submit = within(dialog).getByRole('button', { name: 'Pulihkan' }) as HTMLButtonElement;
    expect(submit.disabled).toBe(true);
    const name = within(dialog).getByLabelText(/Ketik nama perpustakaan ini/);
    fireEvent.change(name, { target: { value: 'Perpustakaan Lain' } });
    expect(submit.disabled).toBe(true);
    fireEvent.change(name, { target: { value: 'Perpustakaan Arsy' } });
    expect(submit.disabled).toBe(true);
    fireEvent.change(name, { target: { value: '  Perpustakaan Arsya ' } });
    expect(submit.disabled).toBe(false);
    fireEvent.change(within(dialog).getByLabelText('Frasa sandi arsip'), { target: { value: 'frasa-sandi-panjang' } });
    fireEvent.click(within(dialog).getByLabelText('Pulihkan database saja, tanpa berkas unggahan'));
    fireEvent.click(submit);
    await waitFor(() => expect(assign).toHaveBeenCalledWith('/admin/_update'));
    expect(bodiesOf(app, 'POST', `backups/${EXT_ID}/restore`)).toEqual([
      { passphrase: 'frasa-sandi-panjang', withoutFiles: true, confirmLibraryName: '  Perpustakaan Arsya ' },
    ]);
  });

  it("this installation's own backup needs no name and no passphrase", async () => {
    const assign = vi.spyOn(page, 'assign').mockImplementation(() => {});
    const app = startApp({
      me: superMe(),
      path: '/admin/backups',
      routes: routes(() => [backup()], { 'POST backups/:id/restore': () => ({ opId: '01JZ000000000000000000OP03' }) }),
    });
    const own = await rowWith('Manual');
    fireEvent.click(within(own).getByRole('button', { name: /Pulihkan/ }));
    const dialog = await screen.findByRole('dialog', { name: 'Pulihkan data dari cadangan' });
    expect(within(dialog).queryByLabelText(/Ketik nama perpustakaan ini/)).toBeNull();
    expect(within(dialog).queryByLabelText('Frasa sandi arsip')).toBeNull();
    fireEvent.click(within(dialog).getByRole('button', { name: 'Pulihkan' }));
    await waitFor(() => expect(assign).toHaveBeenCalledWith('/admin/_update'));
    expect(bodiesOf(app, 'POST', `backups/${OWN_ID}/restore`)).toEqual([{ withoutFiles: false }]);
  });

  it('an encrypted archive without its passphrase says so on the passphrase field', async () => {
    startApp({
      me: superMe(),
      path: '/admin/backups',
      routes: routes(() => [EXTERNAL], { 'POST backups/:id/restore': () => problem(422, 'BACKUP_PASSPHRASE_REQUIRED') }),
    });
    const ext = await rowWith('Arsip unggahan');
    fireEvent.click(within(ext).getByRole('button', { name: /Pulihkan/ }));
    const dialog = await screen.findByRole('dialog', { name: 'Pulihkan data dari cadangan' });
    fireEvent.change(within(dialog).getByLabelText(/Ketik nama perpustakaan ini/), { target: { value: 'Perpustakaan Arsya' } });
    fireEvent.click(within(dialog).getByRole('button', { name: 'Pulihkan' }));
    expect(await within(dialog).findByText('Cadangan ini dienkripsi. Masukkan frasa sandinya.')).toBeTruthy();
    expect(within(dialog).getByLabelText('Frasa sandi arsip').getAttribute('aria-invalid')).toBe('true');
  });
});

describe('Unggah', () => {
  it('shows the upload progress, then posts backups/upload with the upload id', async () => {
    const size = 600 * KIB;
    const chunkSize = 256 * KIB;
    let releaseSecond: () => void = () => {};
    const secondHeld = new Promise<void>((resolve) => {
      releaseSecond = resolve;
    });
    let items = [backup()];
    const app = startApp({
      me: superMe(),
      path: '/admin/backups',
      routes: routes(() => items, {
        'POST files/uploads': () => ({ id: UPLOAD_ID, chunkSize, chunks: 3, expiresAt: AT + 86_400_000 }),
        'POST files/uploads/:id/chunks/:n': async (req) => {
          if (req.params['n'] === '1') await secondHeld;
          return { received: Math.min(size, (Number(req.params['n']) + 1) * chunkSize), complete: req.params['n'] === '2' };
        },
        'POST files/uploads/:id/complete': () => ({ uploadId: UPLOAD_ID, size, sha256: 'a'.repeat(64), mime: 'application/zip' }),
        'POST backups/upload': () => {
          const added = { ...EXTERNAL, id: UPLOAD_ID };
          items = [added, backup()];
          return added;
        },
      }),
    });
    const input = await screen.findByLabelText('Berkas arsip (.altisbak)');
    const file = new File([new Uint8Array(size)], 'cadangan.altisbak', { type: 'application/octet-stream' });
    fireEvent.change(input, { target: { files: [file] } });
    fireEvent.click(screen.getByRole('button', { name: 'Unggah' }));
    const bar = await screen.findByRole('progressbar', { name: 'Mengunggah' });
    await waitFor(() => expect(bar.getAttribute('aria-valuenow')).toBe('43'));
    expect(screen.getByText('256 KB dari 600 KB')).toBeTruthy();
    releaseSecond();
    expect(await screen.findByText(/Arsip diunggah/)).toBeTruthy();
    expect(bodiesOf(app, 'POST', 'backups/upload')).toEqual([{ uploadId: UPLOAD_ID }]);
    expect(app.writes().filter((w) => w.startsWith('POST files/uploads/'))).toEqual([
      `POST files/uploads/${UPLOAD_ID}/chunks/0`,
      `POST files/uploads/${UPLOAD_ID}/chunks/1`,
      `POST files/uploads/${UPLOAD_ID}/chunks/2`,
      `POST files/uploads/${UPLOAD_ID}/complete`,
    ]);
    expect(await rowWith('Arsip unggahan')).toBeTruthy();
  });

  it('a busy upload (409 TX_CONFLICT upload_busy) on backups/upload is sent again', async () => {
    vi.useFakeTimers({ shouldAdvanceTime: true });
    try {
      let tries = 0;
      const app = startApp({
        me: superMe(),
        path: '/admin/backups',
        routes: routes(() => [backup()], {
          'POST files/uploads': () => ({ id: UPLOAD_ID, chunkSize: 256 * KIB, chunks: 1, expiresAt: AT + 86_400_000 }),
          'POST files/uploads/:id/chunks/:n': () => ({ received: 10, complete: true }),
          'POST files/uploads/:id/complete': () => ({ uploadId: UPLOAD_ID, size: 10, sha256: 'a'.repeat(64), mime: 'application/zip' }),
          'POST backups/upload': () => {
            tries += 1;
            return tries === 1 ? problem(409, 'TX_CONFLICT', { reason: 'upload_busy' }) : { ...EXTERNAL, id: UPLOAD_ID };
          },
        }),
      });
      const input = await screen.findByLabelText('Berkas arsip (.altisbak)');
      fireEvent.change(input, { target: { files: [new File([new Uint8Array(10)], 'kecil.altisbak')] } });
      fireEvent.click(screen.getByRole('button', { name: 'Unggah' }));
      await waitFor(() => expect(tries).toBe(1));
      await vi.advanceTimersByTimeAsync(1500);
      expect(await screen.findByText(/Arsip diunggah/)).toBeTruthy();
      expect(bodiesOf(app, 'POST', 'backups/upload')).toHaveLength(2);
    } finally {
      vi.useRealTimers();
    }
  });
});
