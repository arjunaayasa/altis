import type { MeResponse } from '@altis/shared/api/auth';
import type { SystemConfigView } from '@altis/shared/api/system-config';
import { fireEvent, screen, waitFor, within } from '@testing-library/react';
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import { buildSync } from '@/lib/build-sync';
import { dirtyForms } from '@/lib/dirty-forms';
import { page } from '@/lib/page';
import { BRANCH_MAIN, USERS, adminMe, startApp, superMe } from './fake-api';
import { ANON, fakeServer, json, partial, renderApp, signedIn } from './fake-server';

// One-time secrets are never lost (spec §4.8, §7.1): the temporary password, the cron token, the 10 recovery codes
// (enabling 2FA at sign-in or in Profil saya, and new codes) and the pending TOTP secret are shown once, and asking
// again costs a reauth or invalidates what was shown. So:
// - while one is requested or shown, it counts as a form being filled: a newer release on the server (the very
//   response that carries the secret may be the first to say so) shows the banner instead of reloading the page;
// - the dialogs close only with their button ("Selesai"), never with Escape or a click outside.

const NEWER = { 'X-Altis-Build': '0.2.0' };

let reload: ReturnType<typeof vi.spyOn>;

beforeEach(() => {
  sessionStorage.clear();
  reload = vi.spyOn(page, 'reload').mockImplementation(() => {});
});

afterEach(() => {
  vi.unstubAllGlobals();
  vi.restoreAllMocks();
  buildSync.mismatch = false;
});

const newer = (body: unknown): Response => json(body, 200, { 'Cache-Control': 'no-store', ...NEWER });

describe('the temporary password (Pengguna → Atur ulang kata sandi)', () => {
  const SECRET = 'abcd-efgh-jkmn-pqrs';

  async function reset() {
    const app = startApp({
      me: adminMe(),
      path: '/admin/users',
      routes: {
        'GET users': () => ({ items: USERS, total: USERS.length, page: 1, pageSize: 25 }),
        'GET branches': () => ({ items: [BRANCH_MAIN] }),
        'POST users/:id/reset-password': () => newer({ temporaryPassword: SECRET }),
      },
    });
    const row = (await screen.findByRole('link', { name: 'budi' })).closest('tr')!;
    fireEvent.click(within(row).getByRole('button', { name: /kata sandi/ }));
    const confirm = await screen.findByRole('alertdialog');
    fireEvent.click(within(confirm).getAllByRole('button').at(-1)!);
    const dialog = await screen.findByRole('dialog', { name: 'Kata sandi sementara' });
    return { app, dialog };
  }

  it('the answer of a newer release does not reload the page under it: the banner shows instead', async () => {
    const { dialog } = await reset();
    expect(within(dialog).getByText(SECRET)).toBeTruthy();
    expect(reload).not.toHaveBeenCalled();
    expect(buildSync.mismatch).toBe(true);
    expect(dirtyForms.count()).toBeGreaterThan(0);
    expect(await screen.findByText('ALTIS telah diperbarui — muat ulang')).toBeTruthy();
  });

  it('Escape and a click outside do not close it; "Selesai" does, and only then may the page reload', async () => {
    const { dialog } = await reset();
    fireEvent.keyDown(dialog, { key: 'Escape' });
    fireEvent.pointerDown(document.body);
    expect(screen.getByRole('dialog', { name: 'Kata sandi sementara' })).toBeTruthy();
    expect(screen.getByText(SECRET)).toBeTruthy();
    fireEvent.click(within(dialog).getByRole('button', { name: 'Selesai' }));
    await waitFor(() => expect(screen.queryByRole('dialog')).toBeNull());
    expect(dirtyForms.count()).toBe(0);
    buildSync.observe('0.2.0');
    expect(reload).toHaveBeenCalledTimes(1);
  });
});

describe('the cron token (Konfigurasi Sistem → Ganti token cron)', () => {
  const TOKEN = 'cron-token-baru-0123456789abcdef';
  const VIEW: SystemConfigView = {
    baseUrl: 'https://perpus.example',
    trustProxy: { hops: 1 },
    allowedOrigins: [],
    smtp: { host: null, port: 587, security: 'starttls', username: null, password: { isSet: false }, from: null },
    cronToken: { isSet: true },
    locked: {},
  };

  async function rotate() {
    startApp({
      me: superMe(),
      path: '/admin/system',
      routes: { 'GET system/config': () => VIEW, 'POST system/cron-token/rotate': () => newer({ cronToken: TOKEN }) },
    });
    fireEvent.click(await screen.findByRole('button', { name: 'Ganti token cron' }));
    const confirm = await screen.findByRole('alertdialog', { name: 'Ganti token cron?' });
    fireEvent.click(within(confirm).getByRole('button', { name: 'Ganti token cron' }));
    return screen.findByRole('dialog', { name: 'Token cron baru' });
  }

  it('the answer of a newer release does not reload the page under it', async () => {
    const dialog = await rotate();
    expect(within(dialog).getByText(TOKEN)).toBeTruthy();
    expect(reload).not.toHaveBeenCalled();
    expect(dirtyForms.count()).toBeGreaterThan(0);
  });

  it('Escape does not close it; "Selesai" does', async () => {
    const dialog = await rotate();
    fireEvent.keyDown(dialog, { key: 'Escape' });
    expect(screen.getByText(TOKEN)).toBeTruthy();
    fireEvent.click(within(dialog).getByRole('button', { name: 'Selesai' }));
    await waitFor(() => expect(screen.queryByRole('dialog')).toBeNull());
    expect(dirtyForms.count()).toBe(0);
  });
});

describe('recovery codes and the TOTP secret', () => {
  const SECRET = 'JBSWY3DPEHPK3PXPJBSWY3DPEHPK3PXP';
  const URI = `otpauth://totp/Perpustakaan%20Arsya:ani?secret=${SECRET}&issuer=Perpustakaan%20Arsya`;
  const CODES = Array.from({ length: 10 }, (_, i) => `ABCD${i}-1234${i}`);
  let me: MeResponse;

  function serve(o: { enable?: () => Response } = {}) {
    const fetchMock = vi.fn<typeof fetch>();
    vi.stubGlobal('fetch', fetchMock);
    return fakeServer(fetchMock, () => me, {
      'POST auth/2fa/setup': () => json({ secret: SECRET, otpauthUri: URI }, 200, { 'Cache-Control': 'no-store' }),
      'POST auth/2fa/enable': o.enable ?? (() => {
        me = ANON;
        return newer({ codes: CODES });
      }),
      'POST auth/2fa/recovery-codes': () => newer({ codes: CODES }),
    });
  }

  const codesShown = (): boolean => screen.queryByRole('list', { name: 'Kode cadangan' }) !== null;

  async function enrol(start: string): Promise<void> {
    fireEvent.click(await screen.findByRole('button', { name: start }));
    await screen.findByRole('img', { name: 'Kode QR untuk aplikasi autentikator' });
    // The pending secret is on screen: it counts as a form being filled.
    await waitFor(() => expect(dirtyForms.count()).toBeGreaterThan(0));
    fireEvent.change(screen.getByLabelText('Kode autentikator'), { target: { value: '654321' } });
    fireEvent.click(screen.getByRole('button', { name: 'Aktifkan 2FA' }));
  }

  it('the sign-in enrolment: the answer of a newer release shows the codes, no reload', async () => {
    me = partial('mfa_setup');
    serve();
    renderApp('/admin/login/setup-2fa');
    await enrol('Mulai menyiapkan');
    await waitFor(() => expect(codesShown()).toBe(true));
    expect(reload).not.toHaveBeenCalled();
    expect(dirtyForms.count()).toBeGreaterThan(0);
  });

  it('Profil saya, enabling: the codes stay; leaving them through "Masuk lagi" lets go', async () => {
    me = signedIn();
    serve();
    const { router } = renderApp('/admin/profile/2fa');
    await enrol('Mulai menyiapkan');
    await waitFor(() => expect(codesShown()).toBe(true));
    expect(reload).not.toHaveBeenCalled();
    expect(dirtyForms.count()).toBeGreaterThan(0);
    fireEvent.click(screen.getByRole('button', { name: 'Masuk lagi' }));
    await waitFor(() => expect(router.state.location.pathname).toBe('/admin/login'));
    await screen.findByRole('heading', { name: 'Masuk' });
    expect(dirtyForms.count()).toBe(0);
  });

  it('Profil saya, new recovery codes: the answer of a newer release shows them, no reload, until "Selesai"', async () => {
    me = signedIn({ user: { totpEnabled: true } });
    serve();
    renderApp('/admin/profile/2fa');
    fireEvent.click(await screen.findByRole('button', { name: 'Buat kode baru' }));
    await waitFor(() => expect(codesShown()).toBe(true));
    expect(reload).not.toHaveBeenCalled();
    expect(dirtyForms.count()).toBeGreaterThan(0);
    fireEvent.click(screen.getByRole('button', { name: 'Selesai' }));
    await waitFor(() => expect(codesShown()).toBe(false));
    expect(dirtyForms.count()).toBe(0);
  });

  it('nothing is held before the enrolment starts', async () => {
    me = signedIn();
    serve();
    renderApp('/admin/profile/2fa');
    await screen.findByRole('button', { name: 'Mulai menyiapkan' });
    expect(dirtyForms.count()).toBe(0);
  });
});
