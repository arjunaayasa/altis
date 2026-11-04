import { MESSAGES } from '@altis/shared';
import type { EventsResponse } from '@altis/shared/api/events';
import type { PrecheckReportView, ReleaseLogView, UpdateHistoryResponse, UpdateUploadDryRun, UpdatesView } from '@altis/shared/api/updates';
import { cleanup, fireEvent, screen, waitFor, within } from '@testing-library/react';
import { afterEach, describe, expect, it, vi } from 'vitest';
import { ADMIN_MESSAGES, translate, type AdminKey } from '@/i18n';
import { NAV, visibleNav } from '@/lib/nav';
import { page } from '@/lib/page';
import { KNOWN_TYPES, jobTypeLabel } from '@/screens/jobs/list';
import { adminMe, json, problem, signedIn, startApp, superMe, type FakeHandler, type FakeRequest } from './fake-api';

// Spec §13.3 "Pembaruan" (1d Task 30): "Versi, cek, catatan perubahan, Perbarui, /admin/_update, riwayat, kembali ke
// versi sebelumnya, unggah paket, kanal" (§9.6-9.8). The running version and app.js, Cek (`POST updates/check`), the
// available release with its notes link and its prechecks (each failure's `update.precheck.*` text, the stepping stone,
// "pemulihan DB diperlukan bila gagal", the estimate), Perbarui (reauth → `POST updates/apply` → /admin/_update), the
// manual rollback (disabled with its reason), the package upload (upload → dry run → confirm → apply), the channel, the
// history, image mode (the compose line instead of Perbarui) and the refresh on `system.update` hints. The server is
// faked (fake-api.tsx).

afterEach(() => {
  vi.unstubAllGlobals();
  vi.restoreAllMocks();
});

const AT = 1_793_000_000_000;
const OP_ID = '01JZ000000000000000000OP30';
const UPLOAD_ID = '01JZ000000000000000000UP30';
const KIB = 1024;
const COMPOSE = 'docker compose pull && docker compose up -d';

function precheck(o: Partial<PrecheckReportView> = {}): PrecheckReportView {
  return {
    ok: true,
    failures: [],
    dbRestoreNeeded: false,
    estimateMs: 90_000,
    headroomBytes: 0,
    steppingStone: false,
    candidate: { version: '0.2.0-test', bootProtocol: 1, minUpgradeFrom: '0.0.0' },
    notEntitled: null,
    ...o,
  };
}

function view(o: Partial<UpdatesView> = {}): UpdatesView {
  return {
    current: { version: '0.1.0-test', appJs: '0.1.0-test', bootProtocol: 1 },
    channel: 'stable',
    check: { at: AT, ok: true, error: null },
    available: { version: '0.2.0-test', releasedAt: '2026-10-20', notesUrl: 'https://rilis.altis.example/0.2.0', steppingStone: false, latest: null },
    precheck: precheck(),
    rollback: { available: false, reason: 'no_previous', target: null },
    pinned: null,
    oneClick: true,
    dockerPull: false,
    onlineCheck: true,
    op: null,
    bundledBlocked: null,
    ...o,
  };
}

function logRow(o: Partial<ReleaseLogView> & Pick<ReleaseLogView, 'id'>): ReleaseLogView {
  return {
    version: '0.2.0-test',
    action: 'update',
    fromVersion: '0.1.0-test',
    status: 'done',
    startedAt: AT,
    finishedAt: AT + 60_000,
    backupId: null,
    ...o,
  };
}

const NO_HISTORY: UpdateHistoryResponse = { items: [], nextBefore: null };

/** The update routes of a server whose `GET updates` answers `current()` (read at every request). */
function routes(current: () => UpdatesView, extra: Record<string, FakeHandler> = {}): Record<string, FakeHandler> {
  return {
    'GET updates': () => current(),
    'GET updates/history': () => NO_HISTORY,
    ...extra,
  };
}

/** A server that asks for the password once (401 AUTH_REAUTH_REQUIRED) before `answer` answers. */
function reauthFirst(): { reauth: FakeHandler; guard(answer: FakeHandler): FakeHandler } {
  let reauthed = false;
  return {
    reauth: () => {
      reauthed = true;
      return { reauthUntil: Date.now() + 300_000 };
    },
    guard: (answer) => (req) => (reauthed ? answer(req) : problem(401, 'AUTH_REAUTH_REQUIRED')),
  };
}

const bodiesOf = (requests: FakeRequest[], method: string, path: string): unknown[] =>
  requests.filter((r) => r.method === method && r.path === path).map((r) => r.body);

/** Answers the reauth dialog with a password. */
async function reauthenticate(): Promise<void> {
  const dialog = await screen.findByRole('dialog', { name: 'Konfirmasi kata sandi' });
  fireEvent.change(within(dialog).getByLabelText('Kata sandi'), { target: { value: 'kata-sandi-ani' } });
  fireEvent.click(within(dialog).getByRole('button', { name: 'Konfirmasi' }));
}

const msg = (key: AdminKey, params?: Record<string, string | number>): string => translate('id', key, params);

describe('Pembaruan: versions and the available release', () => {
  it('shows the running version and app.js, the available 0.2 with its notes link, the estimate; Perbarui enabled', async () => {
    startApp({ me: superMe(), path: '/admin/updates', routes: routes(() => view({ current: { version: '0.1.0-test', appJs: '0.1.3', bootProtocol: 1 } })) });
    expect(await screen.findByRole('heading', { name: 'Pembaruan', level: 1 })).toBeTruthy();
    expect(await screen.findByText('0.1.0-test')).toBeTruthy();
    expect(screen.getByText('0.1.3')).toBeTruthy();
    expect(screen.getByText(/Versi 0\.2\.0-test tersedia/)).toBeTruthy();
    const notes = screen.getByRole('link', { name: /Catatan perubahan/ });
    expect(notes.getAttribute('href')).toBe('https://rilis.altis.example/0.2.0');
    expect(notes.getAttribute('rel')).toContain('noopener');
    expect(screen.getByText('Semua pemeriksaan awal lolos.')).toBeTruthy();
    expect(screen.getByText('Perkiraan lama pemeliharaan: 2 menit.')).toBeTruthy();
    const apply = screen.getByRole('button', { name: 'Perbarui ke 0.2.0-test' }) as HTMLButtonElement;
    expect(apply.disabled).toBe(false);
  });

  it("failures ['min_node'] → Perbarui disabled, with the update.precheck.min_node text", async () => {
    startApp({
      me: superMe(),
      path: '/admin/updates',
      routes: routes(() => view({ precheck: precheck({ ok: false, failures: ['min_node'] }) })),
    });
    expect(await screen.findByText('Versi Node.js di server terlalu lama untuk versi ini.')).toBeTruthy();
    expect(screen.queryByText('Semua pemeriksaan awal lolos.')).toBeNull();
    const apply = screen.getByRole('button', { name: 'Perbarui ke 0.2.0-test' }) as HTMLButtonElement;
    expect(apply.disabled).toBe(true);
    // The button says why it is disabled: the precheck list describes it.
    const described = (apply.getAttribute('aria-describedby') ?? '').split(' ').map((id) => document.getElementById(id)?.textContent ?? '');
    expect(described.join(' ')).toContain('Versi Node.js di server terlalu lama untuk versi ini.');
  });

  // A refused entitlement is the edition seam (ruling R14): the community edition covers every release, a commercial
  // edition may not, and the page still says why.
  it('the stepping stone, "pemulihan DB diperlukan bila gagal", a refused entitlement and the headroom are listed', async () => {
    startApp({
      me: superMe(),
      path: '/admin/updates',
      routes: routes(() =>
        view({
          available: { version: '0.2.0-test', releasedAt: '2026-10-20', notesUrl: null, steppingStone: true, latest: '0.3.0-test' },
          precheck: precheck({
            ok: false,
            failures: ['min_upgrade_from', 'entitlement'],
            dbRestoreNeeded: true,
            steppingStone: true,
            headroomBytes: 50 * KIB * KIB,
            candidate: { version: '0.2.0-test', bootProtocol: 1, minUpgradeFrom: '0.1.5' },
            notEntitled: 'released_after',
          }),
        }),
      ),
    });
    expect(await screen.findByText(/Pasang dulu rilis batu loncatan yang disebutkan/)).toBeTruthy();
    expect(screen.getByText(/0\.1\.5/)).toBeTruthy();
    const entitlement = screen.getByText((text) => text.includes(MESSAGES.id['update.precheck.entitlement']));
    expect(entitlement.textContent).toContain('Rilis ini terbit setelah hak pembaruan edisi ini berakhir.');
    expect(screen.getByText(/Ini rilis batu loncatan/)).toBeTruthy();
    expect(screen.getByText(/0\.3\.0-test/)).toBeTruthy();
    expect(screen.getByText(/database harus dipulihkan dari cadangan/)).toBeTruthy();
    expect(screen.getByText(/50 MB/)).toBeTruthy();
    // No notes link without a notesUrl.
    expect(screen.queryByRole('link', { name: /Catatan perubahan/ })).toBeNull();
  });

  it('a notes link that is not http(s) is not offered as a link', async () => {
    startApp({
      me: superMe(),
      path: '/admin/updates',
      routes: routes(() => view({ available: { version: '0.2.0-test', releasedAt: '2026-10-20', notesUrl: 'javascript:alert(1)', steppingStone: false, latest: null } })),
    });
    expect(await screen.findByText(/Versi 0\.2\.0-test tersedia/)).toBeTruthy();
    expect(screen.queryByRole('link', { name: /Catatan perubahan/ })).toBeNull();
  });

  it('no release available → "already the latest"; the last check failure says why', async () => {
    startApp({
      me: superMe(),
      path: '/admin/updates',
      routes: routes(() => view({ available: null, precheck: null, check: { at: AT, ok: false, error: 'FEED_UNREACHABLE' } })),
    });
    expect(await screen.findByText(/Server pembaruan tidak dapat dihubungi/)).toBeTruthy();
    expect(screen.queryByRole('button', { name: /Perbarui ke/ })).toBeNull();
  });

  it('onlineCheck: false (no feed URL) → "pemeriksaan daring tidak diatur", no Periksa pembaruan; the upload stays', async () => {
    startApp({
      me: superMe(),
      path: '/admin/updates',
      routes: routes(() => view({ onlineCheck: false, check: null, available: null, precheck: null })),
    });
    expect(await screen.findByText('Pemeriksaan pembaruan daring tidak diatur di instalasi ini.')).toBeTruthy();
    expect(screen.queryByRole('button', { name: 'Periksa pembaruan' })).toBeNull();
    expect(screen.queryByText(/Server pembaruan tidak dapat dihubungi/)).toBeNull();
    expect(screen.queryByText('Pembaruan belum pernah diperiksa.')).toBeNull();
    expect(screen.queryByText('ALTIS sudah memakai versi terbaru di kanal ini.')).toBeNull();
    expect(screen.getByText('Unggah paket pembaruan')).toBeTruthy();
  });

  it('a running update op → its state and progress with the link to the operations page; Perbarui disabled', async () => {
    startApp({
      me: superMe(),
      path: '/admin/updates',
      routes: routes(() =>
        view({
          op: {
            opId: OP_ID,
            kind: 'update',
            state: 'downloading',
            terminal: false,
            needsAttention: false,
            startedAt: AT,
            heartbeatAt: AT,
            finishedAt: null,
            progress: 40,
            message: null,
            error: null,
            pointOfNoReturn: false,
            backupId: null,
            actor: { type: 'staff', id: 'U1' },
          },
        }),
      ),
    });
    expect(await screen.findByText(/Mengunduh \(40 %\)/)).toBeTruthy();
    expect(screen.getByRole('link', { name: 'Buka halaman operasi' }).getAttribute('href')).toBe('/admin/_update');
    expect((screen.getByRole('button', { name: 'Perbarui ke 0.2.0-test' }) as HTMLButtonElement).disabled).toBe(true);
  });

  it('a blocked bundled release and a pinned version are shown', async () => {
    startApp({
      me: superMe(),
      path: '/admin/updates',
      routes: routes(() => view({ pinned: '0.2.0-test', bundledBlocked: { version: '0.3.0-test', failures: ['min_db'] } })),
    });
    expect(await screen.findByText(/Rilis terbundel 0\.3\.0-test tidak dipasang/)).toBeTruthy();
    expect(screen.getByText('Versi database terlalu lama untuk versi ini.')).toBeTruthy();
    expect(screen.getByText(/Versi 0\.2\.0-test dilewati/)).toBeTruthy();
  });
});

describe('Pembaruan: Perbarui', () => {
  it('click → the reauth dialog → POST updates/apply {version} → location.assign(/admin/_update)', async () => {
    const assign = vi.spyOn(page, 'assign').mockImplementation(() => {});
    const server = reauthFirst();
    const { requests } = startApp({
      me: superMe(),
      path: '/admin/updates',
      routes: routes(() => view(), {
        'POST auth/reauth': server.reauth,
        'POST updates/apply': server.guard(() => ({ opId: OP_ID })),
      }),
    });
    fireEvent.click(await screen.findByRole('button', { name: 'Perbarui ke 0.2.0-test' }));
    await reauthenticate();
    await waitFor(() => expect(assign).toHaveBeenCalledWith('/admin/_update'));
    expect(bodiesOf(requests, 'POST', 'updates/apply')).toEqual([{ version: '0.2.0-test' }, { version: '0.2.0-test' }]);
  });

  it('a refused apply (UPDATE_PRECHECK_FAILED min_db) says why and stays on the page', async () => {
    const assign = vi.spyOn(page, 'assign').mockImplementation(() => {});
    startApp({
      me: superMe(),
      path: '/admin/updates',
      routes: routes(() => view(), { 'POST updates/apply': () => problem(409, 'UPDATE_PRECHECK_FAILED', { reason: 'min_db' }) }),
    });
    fireEvent.click(await screen.findByRole('button', { name: 'Perbarui ke 0.2.0-test' }));
    expect(await screen.findByText(/pemeriksaan awal tidak lolos/)).toBeTruthy();
    expect(screen.getByText('Versi database terlalu lama untuk versi ini.')).toBeTruthy();
    expect(assign).not.toHaveBeenCalled();
  });
});

describe('Pembaruan: Kembali ke versi sebelumnya', () => {
  it("rollback {available: false, reason: 'incompatible'} → the button disabled with its explanation", async () => {
    startApp({
      me: superMe(),
      path: '/admin/updates',
      routes: routes(() => view({ rollback: { available: false, reason: 'incompatible', target: '0.0.9-test' } })),
    });
    const button = (await screen.findByRole('button', { name: 'Kembali ke versi sebelumnya' })) as HTMLButtonElement;
    expect(button.disabled).toBe(true);
    const explanation = msg('updates.rollback.reason.incompatible');
    expect(screen.getByText(explanation)).toBeTruthy();
    expect(button.getAttribute('aria-describedby')).toBe(screen.getByText(explanation).id);
  });

  it('available → asks first, then (after reauth) POST updates/rollback → /admin/_update', async () => {
    const assign = vi.spyOn(page, 'assign').mockImplementation(() => {});
    const server = reauthFirst();
    const { writes } = startApp({
      me: superMe(),
      path: '/admin/updates',
      routes: routes(() => view({ rollback: { available: true, reason: null, target: '0.0.9-test' } }), {
        'POST auth/reauth': server.reauth,
        'POST updates/rollback': server.guard(() => ({ opId: OP_ID })),
      }),
    });
    fireEvent.click(await screen.findByRole('button', { name: 'Kembali ke versi sebelumnya' }));
    const confirm = await screen.findByRole('alertdialog', { name: 'Kembali ke versi 0.0.9-test?' });
    expect(within(confirm).getByText(/Versi 0\.1\.0-test dilewati/)).toBeTruthy();
    expect(writes()).toEqual([]);
    fireEvent.click(within(confirm).getByRole('button', { name: 'Kembali ke versi 0.0.9-test' }));
    await reauthenticate();
    await waitFor(() => expect(assign).toHaveBeenCalledWith('/admin/_update'));
    expect(writes().filter((w) => w === 'POST updates/rollback')).toHaveLength(2);
  });
});

describe('Pembaruan: Unggah paket', () => {
  /** The chunked upload of one 10-byte file (lib/upload.ts). */
  const uploadRoutes = (): Record<string, FakeHandler> => ({
    'POST files/uploads': () => ({ id: UPLOAD_ID, chunkSize: 256 * KIB, chunks: 1, expiresAt: AT + 86_400_000 }),
    'POST files/uploads/:id/chunks/:n': () => ({ received: 10, complete: true }),
    'POST files/uploads/:id/complete': () => ({ uploadId: UPLOAD_ID, size: 10, sha256: 'a'.repeat(64), mime: 'application/zip' }),
  });

  const choosePackage = async (): Promise<void> => {
    const input = await screen.findByLabelText('Berkas paket (.zip)');
    fireEvent.change(input, { target: { files: [new File([new Uint8Array(10)], 'altis-0.2.0-test.zip', { type: 'application/zip' })] } });
  };

  it('uploadFile (context update) → the dry run → its report → confirm → the real call → /admin/_update', async () => {
    const assign = vi.spyOn(page, 'assign').mockImplementation(() => {});
    const server = reauthFirst();
    const dryRun: UpdateUploadDryRun = {
      version: '0.2.0-test',
      releasedAt: '2026-10-20',
      precheck: precheck({ dbRestoreNeeded: true, estimateMs: 180_000 }),
    };
    const { requests, writes } = startApp({
      me: superMe(),
      path: '/admin/updates',
      routes: routes(() => view({ available: null, precheck: null }), {
        ...uploadRoutes(),
        'POST auth/reauth': server.reauth,
        'POST updates/upload': server.guard((req) => ((req.body as { dryRun?: boolean }).dryRun === true ? dryRun : { opId: OP_ID })),
      }),
    });
    await choosePackage();
    fireEvent.click(screen.getByRole('button', { name: 'Unggah dan periksa' }));
    await reauthenticate();
    expect(await screen.findByText(/Paket ini berisi ALTIS versi 0\.2\.0-test/)).toBeTruthy();
    expect(screen.getByText(/database harus dipulihkan dari cadangan/)).toBeTruthy();
    expect(screen.getByText('Perkiraan lama pemeliharaan: 3 menit.')).toBeTruthy();
    expect(bodiesOf(requests, 'POST', 'files/uploads')).toEqual([expect.objectContaining({ context: 'update', size: 10 })]);
    // Nothing is installed before the confirmation.
    expect(bodiesOf(requests, 'POST', 'updates/upload')).toEqual([
      { uploadId: UPLOAD_ID, dryRun: true },
      { uploadId: UPLOAD_ID, dryRun: true },
    ]);
    expect(assign).not.toHaveBeenCalled();
    fireEvent.click(screen.getByRole('button', { name: 'Pasang versi 0.2.0-test' }));
    await waitFor(() => expect(assign).toHaveBeenCalledWith('/admin/_update'));
    expect(bodiesOf(requests, 'POST', 'updates/upload').at(-1)).toEqual({ uploadId: UPLOAD_ID });
    // The op takes the upload: it is never dropped, not even when the panel goes.
    expect((screen.getByRole('button', { name: 'Batal' }) as HTMLButtonElement).disabled).toBe(true);
    cleanup();
    await new Promise((resolve) => setTimeout(resolve, 50));
    expect(writes().filter((w) => w.startsWith('DELETE'))).toEqual([]);
  });

  it('a failed precheck in the dry run → "Pasang" disabled; "Batal" drops the upload', async () => {
    const dryRun: UpdateUploadDryRun = { version: '0.0.5-test', releasedAt: '2026-01-01', precheck: precheck({ ok: false, failures: ['not_newer'] }) };
    const { writes } = startApp({
      me: superMe(),
      path: '/admin/updates',
      routes: routes(() => view(), {
        ...uploadRoutes(),
        'POST updates/upload': () => dryRun,
        'DELETE files/uploads/:id': () => undefined,
      }),
    });
    await choosePackage();
    fireEvent.click(screen.getByRole('button', { name: 'Unggah dan periksa' }));
    expect(await screen.findByText('Versi ini tidak lebih baru daripada versi yang sedang berjalan.')).toBeTruthy();
    expect((screen.getByRole('button', { name: 'Pasang versi 0.0.5-test' }) as HTMLButtonElement).disabled).toBe(true);
    fireEvent.click(screen.getByRole('button', { name: 'Batal' }));
    await waitFor(() => expect(writes()).toContain(`DELETE files/uploads/${UPLOAD_ID}`));
    expect(screen.queryByText(/Paket ini berisi ALTIS versi/)).toBeNull();
  });

  it('a package refused for its signature (422 UPDATE_PACKAGE_INVALID signature) says why', async () => {
    startApp({
      me: superMe(),
      path: '/admin/updates',
      routes: routes(() => view(), {
        ...uploadRoutes(),
        'POST updates/upload': () => problem(422, 'UPDATE_PACKAGE_INVALID', { reason: 'signature' }),
      }),
    });
    await choosePackage();
    fireEvent.click(screen.getByRole('button', { name: 'Unggah dan periksa' }));
    expect(await screen.findByText(/Paket pembaruan ditolak/)).toBeTruthy();
    expect(screen.getByText(msg('updates.upload.invalid.signature'))).toBeTruthy();
    expect(screen.queryByRole('button', { name: /Pasang versi/ })).toBeNull();
  });

  it('a failed dry run keeps the upload: "Periksa lagi" checks it again without sending the file again', async () => {
    let tries = 0;
    const dryRun: UpdateUploadDryRun = { version: '0.2.0-test', releasedAt: '2026-10-20', precheck: precheck() };
    const { requests, writes } = startApp({
      me: superMe(),
      path: '/admin/updates',
      routes: routes(() => view(), {
        ...uploadRoutes(),
        'POST updates/upload': () => {
          tries += 1;
          return tries === 1 ? problem(409, 'OPS_IN_PROGRESS') : dryRun;
        },
      }),
    });
    await choosePackage();
    fireEvent.click(screen.getByRole('button', { name: 'Unggah dan periksa' }));
    expect(await screen.findByText(/Operasi sistem lain sedang berjalan/)).toBeTruthy();
    fireEvent.click(screen.getByRole('button', { name: 'Periksa lagi' }));
    expect(await screen.findByText(/Paket ini berisi ALTIS versi 0\.2\.0-test/)).toBeTruthy();
    expect(bodiesOf(requests, 'POST', 'updates/upload')).toEqual([
      { uploadId: UPLOAD_ID, dryRun: true },
      { uploadId: UPLOAD_ID, dryRun: true },
    ]);
    expect(writes().filter((w) => w === 'POST files/uploads')).toHaveLength(1);
  });

  it('leaving the page after a dry run drops the upload that was not installed', async () => {
    const dryRun: UpdateUploadDryRun = { version: '0.2.0-test', releasedAt: '2026-10-20', precheck: precheck() };
    const { router, writes } = startApp({
      me: superMe(),
      path: '/admin/updates',
      routes: routes(() => view(), {
        ...uploadRoutes(),
        'POST updates/upload': () => dryRun,
        'DELETE files/uploads/:id': () => undefined,
      }),
    });
    await choosePackage();
    fireEvent.click(screen.getByRole('button', { name: 'Unggah dan periksa' }));
    expect(await screen.findByText(/Paket ini berisi ALTIS versi 0\.2\.0-test/)).toBeTruthy();
    expect(writes().filter((w) => w.startsWith('DELETE'))).toEqual([]);
    await router.navigate({ to: '/admin/about' });
    await waitFor(() => expect(writes()).toContain(`DELETE files/uploads/${UPLOAD_ID}`));
  });

  it('no file chosen → nothing is sent', async () => {
    const { writes } = startApp({ me: superMe(), path: '/admin/updates', routes: routes(() => view()) });
    fireEvent.click(await screen.findByRole('button', { name: 'Unggah dan periksa' }));
    expect(await screen.findByText('Pilih berkas paket terlebih dahulu.')).toBeTruthy();
    expect(writes()).toEqual([]);
  });
});

describe('Pembaruan: image mode and access', () => {
  it('oneClick: false, dockerPull: true → no Perbarui, no upload; the compose line is shown', async () => {
    startApp({
      me: superMe(),
      path: '/admin/updates',
      routes: routes(() => view({ oneClick: false, dockerPull: true, rollback: { available: false, reason: 'image', target: null } })),
    });
    expect(await screen.findByText(COMPOSE)).toBeTruthy();
    expect(screen.getByText(/Versi 0\.2\.0-test tersedia/)).toBeTruthy();
    expect(screen.queryByRole('button', { name: /Perbarui ke/ })).toBeNull();
    expect(screen.queryByLabelText('Berkas paket (.zip)')).toBeNull();
    expect((screen.getByRole('button', { name: 'Kembali ke versi sebelumnya' }) as HTMLButtonElement).disabled).toBe(true);
    expect(screen.getByText(msg('updates.rollback.reason.image'))).toBeTruthy();
  });

  it('the Docker runtime in data mode → Perbarui and the compose line both', async () => {
    startApp({ me: superMe(), path: '/admin/updates', routes: routes(() => view({ oneClick: true, dockerPull: true })) });
    expect(await screen.findByText(COMPOSE)).toBeTruthy();
    expect(screen.getByRole('button', { name: 'Perbarui ke 0.2.0-test' })).toBeTruthy();
  });

  it('a viewer with only system.update.read sees the release and Cek, but no Perbarui, upload, rollback or channel change', async () => {
    startApp({
      me: signedIn({ permissions: ['system.update.read'] }),
      path: '/admin/updates',
      routes: routes(() => view({ rollback: { available: true, reason: null, target: '0.0.9-test' } })),
    });
    expect(await screen.findByText(/Versi 0\.2\.0-test tersedia/)).toBeTruthy();
    expect(screen.getByRole('button', { name: 'Periksa pembaruan' })).toBeTruthy();
    expect(screen.queryByRole('button', { name: /Perbarui ke/ })).toBeNull();
    expect(screen.queryByLabelText('Berkas paket (.zip)')).toBeNull();
    expect(screen.queryByRole('button', { name: 'Kembali ke versi sebelumnya' })).toBeNull();
    expect(screen.queryByRole('combobox', { name: 'Kanal pembaruan' })).toBeNull();
    expect(screen.getByText('Stabil')).toBeTruthy();
  });

  it('an admin (system.update.read without run) sees no Perbarui either', async () => {
    startApp({ me: adminMe(), path: '/admin/updates', routes: routes(() => view()) });
    expect(await screen.findByText(/Versi 0\.2\.0-test tersedia/)).toBeTruthy();
    expect(screen.queryByRole('button', { name: /Perbarui ke/ })).toBeNull();
  });

  // 1d review L13 (ruling R1c-9): the operations page opens only for the permission of the op's kind
  // (system.update.run for an update or a rollback); anyone else would meet 403 AUTHZ_DENIED there.
  it.each([
    ['running', { state: 'downloading', needsAttention: false }],
    ['needing attention', { state: 'needs_attention', needsAttention: true }],
  ] as const)('an op %s, seen without system.update.run: its state, no link to the operations page, who can follow it', async (_, o) => {
    startApp({
      me: adminMe(),
      path: '/admin/updates',
      routes: routes(() =>
        view({
          op: {
            opId: OP_ID,
            kind: 'update',
            state: o.state,
            terminal: false,
            needsAttention: o.needsAttention,
            startedAt: AT,
            heartbeatAt: AT,
            finishedAt: null,
            progress: 40,
            message: null,
            error: null,
            pointOfNoReturn: false,
            backupId: null,
            actor: { type: 'staff', id: 'U1' },
          },
        }),
      ),
    });
    expect(await screen.findByText(msg('updates.op.page_run_only'))).toBeTruthy();
    expect(screen.queryByRole('link', { name: 'Buka halaman operasi' })).toBeNull();
  });

  it('without system.update.read → refused without asking the server', async () => {
    const { requests } = startApp({ me: signedIn({ permissions: ['system.users.read'] }), path: '/admin/updates', routes: routes(() => view()) });
    expect(await screen.findByText(/tidak memiliki izin/i)).toBeTruthy();
    expect(requests.filter((r) => r.path.startsWith('updates'))).toEqual([]);
  });
});

describe('Pembaruan: Cek, kanal, riwayat, realtime', () => {
  it('Periksa pembaruan → POST updates/check (202) → the view read again shows the new release', async () => {
    let current = view({ available: null, precheck: null });
    const { requests } = startApp({
      me: superMe(),
      path: '/admin/updates',
      routes: routes(() => current, {
        'POST updates/check': () => {
          current = view({ check: { at: AT + 1000, ok: true, error: null } });
          return json({ jobId: '01JZ000000000000000000JB30' }, 202);
        },
      }),
    });
    fireEvent.click(await screen.findByRole('button', { name: 'Periksa pembaruan' }));
    expect(await screen.findByText(/Versi 0\.2\.0-test tersedia/)).toBeTruthy();
    expect(bodiesOf(requests, 'POST', 'updates/check')).toHaveLength(1);
  });

  it('a second check within 60 s (429 UPDATE_CHECK_THROTTLED) says how long to wait', async () => {
    startApp({
      me: superMe(),
      path: '/admin/updates',
      routes: routes(() => view(), {
        'POST updates/check': () =>
          new Response(JSON.stringify({ type: 'about:blank', title: 'x', status: 429, code: 'UPDATE_CHECK_THROTTLED' }), {
            status: 429,
            headers: { 'Content-Type': 'application/problem+json', 'Retry-After': '42', 'X-Altis-Build': '0.1.0' },
          }),
      }),
    });
    fireEvent.click(await screen.findByRole('button', { name: 'Periksa pembaruan' }));
    expect(await screen.findByText(/Pembaruan baru saja diperiksa.*42 detik/)).toBeTruthy();
  });

  it('the channel select → PUT updates/channel {channel: beta}', async () => {
    let current = view();
    const { requests } = startApp({
      me: superMe(),
      path: '/admin/updates',
      routes: routes(() => current, {
        'PUT updates/channel': (req) => {
          const { channel } = req.body as { channel: 'stable' | 'beta' };
          current = view({ channel, available: null, precheck: null });
          return { channel };
        },
      }),
    });
    const select = (await screen.findByRole('combobox', { name: 'Kanal pembaruan' })) as HTMLSelectElement;
    expect(select.value).toBe('stable');
    fireEvent.change(select, { target: { value: 'beta' } });
    fireEvent.click(screen.getByRole('button', { name: 'Simpan kanal' }));
    expect(await screen.findByText(/Kanal pembaruan diganti ke Beta/)).toBeTruthy();
    expect(bodiesOf(requests, 'PUT', 'updates/channel')).toEqual([{ channel: 'beta' }]);
    await waitFor(() => expect(screen.queryByText(/Versi 0\.2\.0-test tersedia/)).toBeNull());
  });

  it('the history lists releases_log rows newest first, with their action, versions and status', async () => {
    startApp({
      me: superMe(),
      path: '/admin/updates',
      routes: routes(() => view(), {
        'GET updates/history': (): UpdateHistoryResponse => ({
          items: [
            logRow({ id: '01JZ000000000000000000RL02', action: 'rollback', version: '0.1.0-test', fromVersion: '0.2.0-test', status: 'done' }),
            logRow({ id: '01JZ000000000000000000RL01', status: 'rolled_back', backupId: '01JZ000000000000000000BK30' }),
          ],
          nextBefore: null,
        }),
      }),
    });
    const table = await screen.findByRole('table', { name: 'Riwayat pembaruan dan pengembalian versi' });
    const rows = within(table).getAllByRole('row').slice(1);
    expect(rows).toHaveLength(2);
    expect(rows[0]!.textContent).toContain('Kembali ke versi sebelumnya');
    expect(rows[0]!.textContent).toContain('0.2.0-test → 0.1.0-test');
    expect(rows[0]!.textContent).toContain('Selesai');
    expect(rows[1]!.textContent).toContain('Pembaruan');
    expect(rows[1]!.textContent).toContain('0.1.0-test → 0.2.0-test');
    expect(rows[1]!.textContent).toContain('Dikembalikan ke versi sebelumnya');
    expect(rows[1]!.textContent).toContain('01JZ000000000000000000BK30');
  });

  it('an update.checked hint on system.update → the screen reads GET updates again', async () => {
    let current = view({ available: null, precheck: null });
    let sent = false;
    const events = (req: FakeRequest): EventsResponse => {
      const channels = req.query.get('channels')?.split(',') ?? [];
      if (!sent && req.query.get('cursor') !== null && channels.includes('system.update')) {
        sent = true;
        current = view();
        return { cursor: '1.31', events: [{ seq: 31, channel: 'system.update', type: 'update.checked', payload: { available: '0.2.0-test' }, at: AT }] };
      }
      return { cursor: '1.30', events: [] };
    };
    startApp({ me: superMe(), path: '/admin/updates', routes: routes(() => current, { 'GET events': events }) });
    expect(await screen.findByText(/ALTIS sudah memakai versi terbaru/)).toBeTruthy();
    expect(await screen.findByText(/Versi 0\.2\.0-test tersedia/, {}, { timeout: 6000 })).toBeTruthy();
  });
});

describe('Pembaruan: navigation, job types, i18n', () => {
  it('Pembaruan is in the navigation after Konfigurasi Sistem, for system.update.read', () => {
    const at = NAV.findIndex((item) => item.to === '/admin/updates');
    // Phase 2 (its spec §13): in the Sistem group.
    expect(NAV[at]).toEqual({ to: '/admin/updates', labelKey: 'nav.updates', permission: 'system.update.read', group: 'system' });
    expect(NAV[at - 1]?.to).toBe('/admin/system');
    expect(visibleNav(adminMe()).map((item) => item.to)).toContain('/admin/updates');
    expect(visibleNav(signedIn({ permissions: ['system.users.read'] })).map((item) => item.to)).not.toContain('/admin/updates');
  });

  it('the jobs of 1d (update.check, release.adopt, release.retention) are known, with a label in both languages', () => {
    for (const type of ['update.check', 'release.adopt', 'release.retention']) {
      expect(KNOWN_TYPES).toContain(type);
      for (const locale of ['id', 'en'] as const) {
        const label = jobTypeLabel((key, params) => translate(locale, key, params), type);
        expect(label, `${locale} ${type}`).not.toBe(type);
      }
    }
  });

  const placeholders = (text: string): string[] => [...text.matchAll(/\{([A-Za-z_][A-Za-z0-9_]*)\}/g)].map((m) => m[1]!).sort();
  const NEW_KEY = /^(?:nav\.updates$|updates\.|jobs\.type\.(?:update\.check|release\.adopt|release\.retention)$)/;

  it('the new keys exist in id and en, none empty, with the same placeholders', () => {
    const keys = (Object.keys(ADMIN_MESSAGES.id) as AdminKey[]).filter((key) => NEW_KEY.test(key));
    expect(keys.length).toBeGreaterThan(40);
    for (const key of keys) {
      expect(ADMIN_MESSAGES.en[key]?.trim(), `en ${key}`).toBeTruthy();
      expect(ADMIN_MESSAGES.id[key].trim(), `id ${key}`).toBeTruthy();
      expect(placeholders(ADMIN_MESSAGES.en[key]), key).toEqual(placeholders(ADMIN_MESSAGES.id[key]));
    }
    expect((Object.keys(ADMIN_MESSAGES.en) as AdminKey[]).filter((key) => NEW_KEY.test(key)).sort()).toEqual([...keys].sort());
  });
});
