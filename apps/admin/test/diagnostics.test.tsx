import { MESSAGES } from '@altis/shared';
import type { DashboardResponse } from '@altis/shared/api/dashboard';
import type { DiagnosticsReport, ProbePollResponse } from '@altis/shared/api/diagnostics';
import type { OpView } from '@altis/shared/api/ops';
import { fireEvent, screen, waitFor, within } from '@testing-library/react';
import { afterEach, describe, expect, it, vi } from 'vitest';
import { adminMe, problem, signedIn, startApp, superMe, type FakeHandler } from './fake-api';

// Diagnostik (spec §11, §13.3 "Diagnostik: §11; aktifkan SSE (.manage), konfirmasi 'jam sekarang benar'", §9.4
// "pilihan di Diagnostik"; 1c Task 32): a block for every section of the report; the exposure test's red banner;
// "Uji peramban" (the browser test against /api/v1/diagnostics/probe, its result posted to probe-result); the SSE
// switch and its 409 REALTIME_PROBE_REQUIRED; "Jam sekarang benar" through the reauth dialog; the suggested proxy hops
// with a link to Konfigurasi Sistem; an op in `needs_attention` with Lanjutkan, Batalkan, the operations page and the
// CLI lines.

afterEach(() => {
  vi.unstubAllGlobals();
  vi.restoreAllMocks();
});

const AT = 1_760_000_000_000;
const MIB = 1024 * 1024;
const OP_ID = '01JZ000000000000000000OP01';

function report(o: Partial<DiagnosticsReport> = {}): DiagnosticsReport {
  return {
    release: {
      version: '0.1.0',
      appJsVersion: '0.1.0',
      bootProtocol: 1,
      missing: [],
      unadopted: ['0.0.9'],
      pending: null,
      pinned: null,
      bundled: null,
      keyset: { docs: 1, maxSeq: 1, full: false },
    },
    runtime: { runtime: 'passenger', transport: 'polling', runner: { mode: 'external', lastRuns: { cron_http: AT - 60_000 } } },
    queue: { queued: 2, running: 0, dead: 1, oldestQueuedMs: 90_000 },
    backup: { last: null },
    edition: { edition: 'community', status: 'active' },
    database: {
      dialect: 'mariadb',
      version: '11.4.2-MariaDB',
      fullText: true,
      limits: { maxUserConnections: 10, maxConnections: 151 },
      poolSize: 4,
    },
    dataDir: { bytes: 52_428_800, files: 120, truncated: false, measuredAt: AT - 3_600_000 },
    memory: { rssBytes: 104_857_600, heapUsedBytes: 52_428_800, totalBytes: 4_294_967_296, freeBytes: 1_073_741_824 },
    network: { ipTrust: 'ok', hops: 1, suggestedHops: 1 },
    wasm: { ok: true, hint: null },
    http: { methods: { put: true, patch: true, delete: false }, methodOverride: true, chunkBytes: MIB, probedAt: AT - 86_400_000 },
    audit: { chain: { ok: true, head: 1234, brokenAt: null, checkedAt: AT - 7_200_000 } },
    clock: { anomaly: null },
    exposure: { ok: true, url: null, checkedAt: AT - 7_200_000 },
    disk: { lowAt: null },
    // ---- Phase 2 (catalog): Task 3 (B2): null until the search provider fills them (Task 15) ----
    search: null,
    oai: null,
    ...o,
  };
}

function dashboard(o: Partial<DashboardResponse> = {}): DashboardResponse {
  return {
    version: { current: '0.1.0', appJs: null, bootProtocol: 1, update: null },
    edition: { edition: 'community', status: 'active' },
    lastBackup: null,
    nextBackupAt: null,
    queue: null,
    scheduler: null,
    alerts: [],
    ...o,
  };
}

function op(o: Partial<OpView> = {}): OpView {
  return {
    opId: OP_ID,
    kind: 'backup',
    state: 'needs_attention',
    terminal: false,
    needsAttention: true,
    startedAt: AT - 3_600_000,
    heartbeatAt: AT - 1_800_000,
    finishedAt: null,
    progress: 40,
    message: null,
    error: null,
    pointOfNoReturn: false,
    backupId: null,
    actor: { type: 'staff', id: 'U1' },
    mode: 'external',
    csrfToken: null,
    driveable: false,
    ...o,
  };
}

function routes(r: () => DiagnosticsReport, extra: Record<string, FakeHandler> = {}): Record<string, FakeHandler> {
  return { 'GET diagnostics': () => r(), 'GET dashboard': () => dashboard(), ...extra };
}

const bodiesOf = (app: ReturnType<typeof startApp>, method: string, path: string): unknown[] =>
  app.requests.filter((r) => r.method === method && r.path === path).map((r) => r.body);

describe('the report', () => {
  it('renders a block for every key of DiagnosticsReport', async () => {
    const r = report();
    startApp({ me: adminMe(), path: '/admin/diagnostics', routes: routes(() => r) });
    expect(await screen.findByRole('heading', { name: 'Diagnostik', level: 1 })).toBeTruthy();
    await screen.findByText('11.4.2-MariaDB');
    for (const key of Object.keys(r)) {
      const block = document.querySelector(`[data-diagnostics-block="${key}"]`);
      expect(block, key).not.toBeNull();
      expect(within(block as HTMLElement).getAllByRole('heading').length, key).toBeGreaterThan(0);
    }
    expect(screen.getByText('MariaDB')).toBeTruthy();
    expect(screen.getByText('0.0.9')).toBeTruthy();
  });

  it('a failed exposure test is a red banner naming the URL', async () => {
    startApp({
      me: adminMe(),
      path: '/admin/diagnostics',
      routes: routes(() => report({ exposure: { ok: false, url: 'https://perpus.example/data/config.json', checkedAt: AT } })),
    });
    const banner = await screen.findByRole('alert', { name: 'Uji keterbukaan folder data gagal' });
    expect(within(banner).getByText(MESSAGES.id['alert.exposure_failed'])).toBeTruthy();
    expect(within(banner).getByText('https://perpus.example/data/config.json')).toBeTruthy();
  });

  it('no banner while the exposure test passes', async () => {
    startApp({ me: adminMe(), path: '/admin/diagnostics', routes: routes(() => report()) });
    await screen.findByText('11.4.2-MariaDB');
    expect(screen.queryByRole('alert', { name: 'Uji keterbukaan folder data gagal' })).toBeNull();
  });

  it('suggested hops that differ link to Konfigurasi Sistem (for whoever may open it)', async () => {
    const r = report({ network: { ipTrust: 'spoofable', hops: 0, suggestedHops: 2 } });
    startApp({ me: superMe(), path: '/admin/diagnostics', routes: routes(() => r) });
    const block = (await screen.findByText(/Uji peramban menyarankan 2 hop/)).closest('[data-diagnostics-block]') as HTMLElement;
    expect(within(block).getByRole('link', { name: 'Buka Konfigurasi Sistem' }).getAttribute('href')).toBe('/admin/system');
  });

  it('an admin without system.config.manage gets no link to Konfigurasi Sistem', async () => {
    const r = report({ network: { ipTrust: 'spoofable', hops: 0, suggestedHops: 2 } });
    startApp({ me: adminMe(), path: '/admin/diagnostics', routes: routes(() => r) });
    await screen.findByText(/Uji peramban menyarankan 2 hop/);
    expect(screen.queryByRole('link', { name: 'Buka Konfigurasi Sistem' })).toBeNull();
  });

  // ---- Phase 2 (catalog): Task 3 (B2) ----
  it('the search index and OAI blocks say "tidak tersedia" while the report has them as null', async () => {
    startApp({ me: adminMe(), path: '/admin/diagnostics', routes: routes(() => report()) });
    await screen.findByText('11.4.2-MariaDB');
    for (const [key, title] of [
      ['search', 'Indeks pencarian'],
      ['oai', 'Panen OAI-PMH'],
    ] as const) {
      const block = document.querySelector(`[data-diagnostics-block="${key}"]`) as HTMLElement;
      expect(within(block).getByRole('heading', { name: title })).toBeTruthy();
      expect(within(block).getByText('Tidak tersedia')).toBeTruthy();
    }
  });

  it('once filled, the search block shows the status and the counts, the OAI block the service and the admin e-mail', async () => {
    const r = report({
      search: { status: 'building', docs: 120, records: 130, builtAt: AT - 60_000, jobId: '01JZ0000000000000000000JOB' },
      oai: { enabled: true, adminEmailSet: false },
    });
    startApp({ me: adminMe(), path: '/admin/diagnostics', routes: routes(() => r) });
    const search = (await screen.findByText('Indeks sedang dibangun ulang')).closest('[data-diagnostics-block]') as HTMLElement;
    expect(search.getAttribute('data-diagnostics-block')).toBe('search');
    expect(within(search).getByText('120 dari 130')).toBeTruthy();
    const oai = document.querySelector('[data-diagnostics-block="oai"]') as HTMLElement;
    expect(within(oai).getByText('Aktif')).toBeTruthy();
    expect(within(oai).getByText('Belum diisi')).toBeTruthy();
  });
});

describe('Uji peramban', () => {
  const poll = (): ProbePollResponse => ({
    now: AT,
    ip: '198.51.100.7',
    ipTrust: 'ok',
    xff: ['198.51.100.7'],
    peerPrivate: true,
    suggestedHops: 1,
    ipAtSuggested: '198.51.100.7',
  });

  it('runs the browser test with the real methods and posts probe-result', async () => {
    const app = startApp({
      me: adminMe(),
      path: '/admin/diagnostics',
      routes: routes(() => report(), {
        'GET diagnostics/probe/poll': poll,
        'PUT diagnostics/probe/methods': () => ({ method: 'PUT' }),
        'PATCH diagnostics/probe/methods': () => ({ method: 'PATCH' }),
        'DELETE diagnostics/probe/methods': () => ({ method: 'DELETE' }),
        'POST diagnostics/probe/chunk': () => ({ bytes: 5 * MIB }),
        'POST diagnostics/probe-result': () => ({ ipTrust: 'ok', spoofable: false, suggestedHops: 1 }),
      }),
    });
    fireEvent.click(await screen.findByRole('button', { name: 'Uji peramban' }));
    expect(await screen.findByText('Uji peramban selesai dan hasilnya disimpan.', undefined, { timeout: 4000 })).toBeTruthy();
    expect(bodiesOf(app, 'POST', 'diagnostics/probe-result')).toEqual([
      {
        polling: true,
        sse: false,
        methods: { put: true, patch: true, delete: true },
        chunkBytes: 5 * MIB,
        xff: { cleanXff: ['198.51.100.7'], forgedXff: ['198.51.100.7'], forgedDerived: '198.51.100.7' },
      },
    ]);
    // The methods probe used the real methods, never an override, with the session's CSRF token.
    for (const method of ['PUT', 'PATCH', 'DELETE']) {
      const call = app.fetchMock.mock.calls.find(([url, init]) => String(url).endsWith('/diagnostics/probe/methods') && init?.method === method);
      expect(call, method).toBeTruthy();
      const headers = new Headers(call![1]!.headers);
      expect(headers.get('X-HTTP-Method-Override'), method).toBeNull();
      expect(headers.get('X-CSRF-Token'), method).toBe('csrf-1');
    }
    const results = screen.getByRole('region', { name: 'Uji peramban' });
    expect(within(results).getByText('5 MB')).toBeTruthy();
  });

  it('is not offered without system.diagnostics.manage', async () => {
    startApp({ me: signedIn({ permissions: ['system.diagnostics.read'] }), path: '/admin/diagnostics', routes: routes(() => report()) });
    await screen.findByText('11.4.2-MariaDB');
    expect(screen.queryByRole('button', { name: 'Uji peramban' })).toBeNull();
  });
});

describe('the SSE switch', () => {
  it('a 409 REALTIME_PROBE_REQUIRED explains what to do', async () => {
    const app = startApp({
      me: adminMe(),
      path: '/admin/diagnostics',
      routes: routes(() => report(), { 'PUT diagnostics/realtime': () => problem(409, 'REALTIME_PROBE_REQUIRED') }),
    });
    const toggle = await screen.findByRole('switch', { name: 'Gunakan SSE untuk pembaruan langsung' });
    expect((toggle as HTMLInputElement).checked).toBe(false);
    fireEvent.click(toggle);
    expect(await screen.findByText(/SSE belum dapat dinyalakan: di hosting ini, uji peramban harus berhasil/)).toBeTruthy();
    expect(bodiesOf(app, 'PUT', 'diagnostics/realtime')).toEqual([{ sse: true }]);
    expect((screen.getByRole('switch', { name: 'Gunakan SSE untuk pembaruan langsung' }) as HTMLInputElement).checked).toBe(false);
  });

  it('switching on sends sse: true and shows the new transport', async () => {
    let r = report();
    const app = startApp({
      me: adminMe(),
      path: '/admin/diagnostics',
      routes: routes(() => r, {
        'PUT diagnostics/realtime': () => {
          r = report({ runtime: { ...r.runtime, transport: 'sse' } });
          return { sse: true, transport: 'sse' };
        },
      }),
    });
    fireEvent.click(await screen.findByRole('switch', { name: 'Gunakan SSE untuk pembaruan langsung' }));
    expect(await screen.findByText('SSE dinyalakan.')).toBeTruthy();
    await waitFor(() => expect((screen.getByRole('switch', { name: 'Gunakan SSE untuk pembaruan langsung' }) as HTMLInputElement).checked).toBe(true));
    expect(bodiesOf(app, 'PUT', 'diagnostics/realtime')).toEqual([{ sse: true }]);
  });
});

describe('Jam sekarang benar', () => {
  it('asks first, goes through the reauth dialog, then posts clock-confirm', async () => {
    let reauthed = false;
    let r = report({ clock: { anomaly: { detectedAt: AT - 600_000, maxSeen: AT + 3_600_000 } } });
    const app = startApp({
      me: adminMe(),
      path: '/admin/diagnostics',
      routes: routes(() => r, {
        'POST auth/reauth': () => {
          reauthed = true;
          return { reauthUntil: AT + 300_000 };
        },
        'POST diagnostics/clock-confirm': () => {
          if (!reauthed) return problem(401, 'AUTH_REAUTH_REQUIRED');
          r = report();
          return { confirmedAt: AT };
        },
      }),
    });
    fireEvent.click(await screen.findByRole('button', { name: 'Jam sekarang benar' }));
    const confirm = await screen.findByRole('alertdialog', { name: 'Konfirmasi jam server' });
    expect(app.writes()).toEqual([]);
    fireEvent.click(within(confirm).getByRole('button', { name: 'Jam sekarang benar' }));
    const reauth = await screen.findByRole('dialog', { name: 'Konfirmasi kata sandi' });
    fireEvent.change(within(reauth).getByLabelText('Kata sandi'), { target: { value: 'kata-sandi-ani' } });
    fireEvent.click(within(reauth).getByRole('button', { name: 'Konfirmasi' }));
    expect(await screen.findByText('Jam server dikonfirmasi.')).toBeTruthy();
    expect(app.writes()).toEqual(['POST diagnostics/clock-confirm', 'POST auth/reauth', 'POST diagnostics/clock-confirm']);
    await waitFor(() => expect(screen.queryByRole('button', { name: 'Jam sekarang benar' })).toBeNull());
  });

  it('is offered only while an anomaly is active, and only with system.diagnostics.manage', async () => {
    const anomaly = { detectedAt: AT - 600_000, maxSeen: AT + 3_600_000 };
    startApp({ me: signedIn({ permissions: ['system.diagnostics.read'] }), path: '/admin/diagnostics', routes: routes(() => report({ clock: { anomaly } })) });
    expect(await screen.findByText(/Jam server tampak bergeser/)).toBeTruthy();
    expect(screen.queryByRole('button', { name: 'Jam sekarang benar' })).toBeNull();
  });

  it('is not offered without an anomaly', async () => {
    startApp({ me: adminMe(), path: '/admin/diagnostics', routes: routes(() => report()) });
    expect(await screen.findByText('Tidak ada pergeseran jam yang terdeteksi.')).toBeTruthy();
    expect(screen.queryByRole('button', { name: 'Jam sekarang benar' })).toBeNull();
  });
});

describe('an op in needs_attention', () => {
  const attention = (): DashboardResponse =>
    dashboard({ alerts: [{ kind: 'ops_attention', severity: 'error', messageKey: 'alert.ops_attention', link: '/admin/_update' }] });

  it('shows Lanjutkan, which posts ops/drive {resume: true}, Batalkan, the operations page and the CLI lines', async () => {
    let current = op();
    const app = startApp({
      me: superMe(),
      path: '/admin/diagnostics',
      routes: routes(() => report(), {
        'GET dashboard': attention,
        'GET ops/current': () => current,
        'POST ops/drive': () => {
          current = op({ state: 'exporting', needsAttention: false, driveable: true });
          return current;
        },
      }),
    });
    const block = await screen.findByRole('region', { name: 'Operasi sistem perlu ditangani' });
    expect(within(block).getByText(/Pencadangan/)).toBeTruthy();
    expect(within(block).getByRole('link', { name: 'Buka halaman operasi' }).getAttribute('href')).toBe('/admin/_update');
    // Final review (OPS-ATTN-EXIT): the CLI way out is ops:resume or ops:cancel, not a forced maintenance:off.
    expect(within(block).getByText(/node app\.js ops:resume\s+node app\.js ops:cancel/)).toBeTruthy();
    expect(within(block).queryByText(/maintenance:off/)).toBeNull();
    expect(within(block).getByRole('button', { name: 'Batalkan operasi' })).toBeTruthy();
    fireEvent.click(within(block).getByRole('button', { name: 'Lanjutkan operasi' }));
    await waitFor(() => expect(bodiesOf(app, 'POST', 'ops/drive')).toEqual([{ resume: true }]));
    expect(await screen.findByText('Operasi dilanjutkan. Ikuti kemajuannya di halaman operasi.')).toBeTruthy();
  });

  it('Batalkan is not offered past the point of no return, nor ops:cancel among the CLI lines', async () => {
    startApp({
      me: superMe(),
      path: '/admin/diagnostics',
      routes: routes(() => report(), {
        'GET dashboard': attention,
        'GET ops/current': () => op({ kind: 'restore', pointOfNoReturn: true, backupId: '01JZ000000000000000000BK01' }),
      }),
    });
    const block = await screen.findByRole('region', { name: 'Operasi sistem perlu ditangani' });
    expect(within(block).getByRole('button', { name: 'Lanjutkan operasi' })).toBeTruthy();
    expect(within(block).queryByRole('button', { name: 'Batalkan operasi' })).toBeNull();
    expect(within(block).getByText(/node app\.js ops:resume/)).toBeTruthy();
    expect(within(block).queryByText(/ops:cancel/)).toBeNull();
  });

  it('an op.json nobody can read: ops:cancel sets it aside, then maintenance:off or the restore line names the backup', async () => {
    startApp({
      me: superMe(),
      path: '/admin/diagnostics',
      routes: routes(() => report(), {
        'GET dashboard': attention,
        'GET ops/current': () =>
          op({ kind: 'restore', pointOfNoReturn: true, startedAt: null, heartbeatAt: null, actor: null, backupId: '01JZ000000000000000000BK01' }),
      }),
    });
    const block = await screen.findByRole('region', { name: 'Operasi sistem perlu ditangani' });
    expect(
      within(block).getByText(/node app\.js ops:cancel\s+node app\.js maintenance:off\s+node app\.js backup:restore 01JZ000000000000000000BK01/),
    ).toBeTruthy();
  });

  it('Batalkan asks first, then posts ops/cancel', async () => {
    const app = startApp({
      me: superMe(),
      path: '/admin/diagnostics',
      routes: routes(() => report(), {
        'GET dashboard': attention,
        'GET ops/current': () => op(),
        'POST ops/cancel': () => op({ state: 'aborted', terminal: true, needsAttention: false, finishedAt: AT }),
      }),
    });
    const block = await screen.findByRole('region', { name: 'Operasi sistem perlu ditangani' });
    fireEvent.click(within(block).getByRole('button', { name: 'Batalkan operasi' }));
    const dialog = await screen.findByRole('alertdialog');
    expect(app.writes()).toEqual([]);
    fireEvent.click(within(dialog).getByRole('button', { name: 'Batalkan operasi' }));
    await waitFor(() => expect(app.writes()).toEqual(['POST ops/cancel']));
    expect(await screen.findByText('Operasi dibatalkan.')).toBeTruthy();
  });

  it('nothing is asked of ops/current without the ops_attention alert', async () => {
    const app = startApp({ me: superMe(), path: '/admin/diagnostics', routes: routes(() => report()) });
    await screen.findByText('11.4.2-MariaDB');
    await waitFor(() => expect(app.requests.some((r) => r.path === 'dashboard')).toBe(true));
    expect(app.requests.some((r) => r.path === 'ops/current')).toBe(false);
    expect(screen.queryByRole('region', { name: 'Operasi sistem perlu ditangani' })).toBeNull();
  });
});

// ---- 1d Task 29 (A9: §11 "rilis yang hilang atau tidak teradopsi"), and the edition (ruling R9) ----------------------
describe('the edition and the releases (1d Task 29)', () => {
  const block = async (key: string): Promise<HTMLElement> => {
    await screen.findByText('11.4.2-MariaDB');
    return document.querySelector(`[data-diagnostics-block="${key}"]`) as HTMLElement;
  };

  it('the edition: "Edisi Komunitas", active; no licence block and no link to a Lisensi page', async () => {
    startApp({ me: superMe(), path: '/admin/diagnostics', routes: routes(() => report()) });
    const edition = await block('edition');
    expect(within(edition).getByRole('heading', { name: 'Edisi' })).toBeTruthy();
    expect(within(edition).getByText('Edisi Komunitas')).toBeTruthy();
    expect(within(edition).getByText('Aktif')).toBeTruthy();
    expect(document.querySelector('[data-diagnostics-block="license"]')).toBeNull();
    expect(screen.queryByRole('link', { name: /Lisensi/ })).toBeNull();
  });

  it('an edition the build does not know by name is shown as the server words it', async () => {
    startApp({ me: adminMe(), path: '/admin/diagnostics', routes: routes(() => report({ edition: { edition: 'other', status: 'paused' } })) });
    const edition = await block('edition');
    expect(within(edition).getByText('other')).toBeTruthy();
    expect(within(edition).getByText('paused')).toBeTruthy();
  });

  it('the releases: pending, pinned, the bundled release with its relation and note, the keyset store (full: a problem)', async () => {
    const r = report({
      release: {
        ...report().release,
        pending: '0.2.0',
        pinned: '0.1.5',
        bundled: { version: '0.1.5', relation: 'older', note: 'ignored' },
        keyset: { docs: 3, maxSeq: 7, full: true },
      },
    });
    startApp({ me: adminMe(), path: '/admin/diagnostics', routes: routes(() => r) });
    const release = await block('release');
    expect(within(release).getByText('0.2.0')).toBeTruthy();
    expect(within(release).getByText('0.1.5')).toBeTruthy();
    expect(within(release).getByText('0.1.5 (lebih lama): diabaikan')).toBeTruthy();
    expect(within(release).getByText(/3 dokumen, seq tertinggi 7/).className).toMatch(/text-destructive/);
    expect(within(release).getByText(/Berkas penuh/)).toBeTruthy();
  });
});
