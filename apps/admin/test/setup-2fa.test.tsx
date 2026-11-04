import type { MeResponse } from '@altis/shared/api/auth';
import { QueryClient, focusManager } from '@tanstack/react-query';
import { act, fireEvent, render, screen, waitFor, within } from '@testing-library/react';
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import { QrCode } from '@/components/qr-code';
import { ME_HOLD_KEY, ME_KEY, meQuery } from '@/lib/me';
import { holdMe, refreshMe, signInGate } from '@/lib/sign-in';
import { ANON, fakeServer, json, partial, problem, renderApp, signedIn, type FakeServer } from './fake-server';

// Enrolling 2FA (spec §7.1; Task 28): the QR code and the secret as text, the code that enables it, then the 10
// recovery codes shown once. Enabling ends every session of the user, the current one included (S11, D22), so the
// screen ends with "Masuk lagi". The same flow serves the forced enrolment of the sign-in (`/admin/login/setup-2fa`)
// and "Profil saya" (`/admin/profile/2fa`).

const SECRET = 'JBSWY3DPEHPK3PXPJBSWY3DPEHPK3PXP';
const URI = `otpauth://totp/Perpustakaan%20Arsya:ani?secret=${SECRET}&issuer=Perpustakaan%20Arsya&algorithm=SHA1&digits=6&period=30`;
const CODES = Array.from({ length: 10 }, (_, i) => `ABCD${i}-1234${i}`);

const fetchMock = vi.fn<typeof fetch>();
let me: MeResponse;
let server: FakeServer;

beforeEach(() => {
  vi.stubGlobal('fetch', fetchMock);
  server = fakeServer(fetchMock, () => me, {
    'POST auth/2fa/setup': () => json({ secret: SECRET, otpauthUri: URI }, 200, { 'Cache-Control': 'no-store' }),
    'POST auth/2fa/enable': () => {
      me = ANON; // every session ended (S11)
      return json({ codes: CODES }, 200, { 'Cache-Control': 'no-store' });
    },
  });
});

afterEach(() => {
  focusManager.setFocused(undefined);
  fetchMock.mockReset();
  vi.unstubAllGlobals();
  vi.restoreAllMocks();
});

/** The secret as the page shows it (in groups), read back without the spaces. */
const shownSecret = (): string | undefined =>
  screen.queryAllByText((_, el) => el?.tagName === 'CODE' && el.textContent?.replace(/\s/g, '') === SECRET)[0]?.textContent?.replace(/\s/g, '');

async function enrol(startLabel: string): Promise<void> {
  fireEvent.click(await screen.findByRole('button', { name: startLabel }));
  await waitFor(() => expect(shownSecret()).toBe(SECRET));
  const qr = screen.getByRole('img', { name: 'Kode QR untuk aplikasi autentikator' });
  expect(qr.tagName.toLowerCase()).toBe('svg');
  expect(qr.querySelectorAll('rect').length).toBeGreaterThan(100);
  fireEvent.change(screen.getByLabelText('Kode autentikator'), { target: { value: '654321' } });
  fireEvent.click(screen.getByRole('button', { name: 'Aktifkan 2FA' }));
}

/** The recovery codes on screen (the list), or [] when none shows. */
const shownCodes = (): string[] => {
  const list = screen.queryByRole('list', { name: 'Kode cadangan' });
  return list === null ? [] : within(list).getAllByRole('listitem').map((li) => li.textContent ?? '');
};

describe('QrCode', () => {
  it('draws the module matrix as <rect>s in an <svg>, on a white quiet zone', () => {
    const { container } = render(<QrCode text={URI} label="QR" />);
    const svg = container.querySelector('svg')!;
    expect(svg.getAttribute('role')).toBe('img');
    const rects = svg.querySelectorAll('rect');
    expect(rects.length).toBeGreaterThan(100);
    expect(rects[0]?.getAttribute('fill')).toBe('#fff');
    expect(svg.innerHTML).not.toContain('<script');
  });

  it('a different text draws a different code', () => {
    const a = render(<QrCode text={URI} label="QR" />).container.innerHTML;
    const b = render(<QrCode text={`${URI}x`} label="QR" />).container.innerHTML;
    expect(a).not.toBe(b);
  });
});

describe('forced enrolment: /admin/login/setup-2fa', () => {
  it('QR + secret, then exactly 10 codes and "Masuk lagi" to /admin/login', async () => {
    me = partial('mfa_setup');
    const { router } = renderApp('/admin/login/setup-2fa');
    expect(await screen.findByRole('heading', { name: 'Siapkan verifikasi dua langkah' })).toBeTruthy();
    await enrol('Mulai menyiapkan');
    await waitFor(() => expect(shownCodes()).toEqual(CODES));
    expect(server.callsTo('POST auth/2fa/enable')[0]?.body).toEqual({ code: '654321' });
    expect(screen.getByRole('link', { name: /Unduh/ }).getAttribute('download')).toBeTruthy();

    fireEvent.click(screen.getByRole('button', { name: 'Masuk lagi' }));
    await waitFor(() => expect(router.state.location.pathname).toBe('/admin/login'));
    expect(await screen.findByRole('heading', { name: 'Masuk' })).toBeTruthy();
    expect(screen.getByText(/Verifikasi dua langkah sudah aktif/)).toBeTruthy();
  });

  it('a wrong code keeps the setup on screen and says so', async () => {
    me = partial('mfa_setup');
    server.on('POST auth/2fa/enable', () => problem(401, 'AUTH_MFA_INVALID'));
    renderApp('/admin/login/setup-2fa');
    await enrol('Mulai menyiapkan');
    expect(await screen.findByText(/Kode salah, sudah dipakai/)).toBeTruthy();
    expect(shownSecret()).toBe(SECRET);
    expect(shownCodes()).toEqual([]);
  });

  it('the pre-2FA session ended while scanning (401 AUTH_REQUIRED) → the sign-in page says why, keeping next', async () => {
    me = partial('mfa_setup');
    server.on('POST auth/2fa/enable', () => {
      me = ANON;
      return problem(401, 'AUTH_REQUIRED');
    });
    const { router } = renderApp(`/admin/login/setup-2fa?next=${encodeURIComponent('/admin/profile')}`);
    await enrol('Mulai menyiapkan');
    await waitFor(() => expect(router.state.location.pathname).toBe('/admin/login'));
    expect(await screen.findByText(/waktunya habis/)).toBeTruthy();
    expect(screen.getByRole('heading', { name: 'Masuk' })).toBeTruthy();
    expect(router.state.location.search).toEqual({ next: '/admin/profile', notice: '2fa_ended' });
  });

  it('Back to the sign-in page after enabling, then signing in again, reads auth/me afresh (no loop back to the setup)', async () => {
    me = ANON;
    let stage: 'mfa_setup' | 'mfa' = 'mfa_setup';
    server.on('POST auth/login', () => {
      me = partial(stage);
      return json({ stage, mustChangePassword: false });
    });
    const signIn = async (): Promise<void> => {
      fireEvent.change(await screen.findByLabelText('Nama pengguna'), { target: { value: 'ani' } });
      fireEvent.change(screen.getByLabelText('Kata sandi'), { target: { value: 'buku-tua-di-rak-7' } });
      fireEvent.click(screen.getByRole('button', { name: 'Masuk' }));
    };
    const { router } = renderApp('/admin/login');
    await signIn();
    await waitFor(() => expect(router.state.location.pathname).toBe('/admin/login/setup-2fa'));
    await enrol('Mulai menyiapkan');
    await waitFor(() => expect(shownCodes()).toEqual(CODES));

    stage = 'mfa';
    act(() => router.history.back());
    await waitFor(() => expect(router.state.location.pathname).toBe('/admin/login'));
    expect(await screen.findByRole('heading', { name: 'Masuk' })).toBeTruthy();
    await signIn();
    await waitFor(() => expect(router.state.location.pathname).toBe('/admin/login/2fa'));
    expect(await screen.findByRole('heading', { name: 'Verifikasi dua langkah' })).toBeTruthy();
    await new Promise((resolve) => setTimeout(resolve, 20));
    expect(router.state.location.pathname).toBe('/admin/login/2fa');
    expect(server.callsTo('POST auth/2fa/setup')).toHaveLength(1);
  });
});

describe('the hold on auth/me while the codes show', () => {
  it('refreshMe and the sign-in gate still read auth/me from the server after a hold', async () => {
    me = signedIn();
    const queryClient = new QueryClient({ defaultOptions: { queries: { retry: false } } });
    await queryClient.fetchQuery(meQuery);
    holdMe(queryClient);
    me = ANON; // the server ended the session (S11)
    const reads = server.callsTo('GET auth/me').length;

    expect(queryClient.getQueryData(ME_HOLD_KEY)).toBe(true);
    await refreshMe(queryClient);
    expect(server.callsTo('GET auth/me')).toHaveLength(reads + 1);
    expect(queryClient.getQueryData(ME_KEY)).toEqual(ANON);
    expect(queryClient.getQueryData(ME_HOLD_KEY)).not.toBe(true); // the components read auth/me on their own again

    me = signedIn();
    await queryClient.fetchQuery({ ...meQuery, staleTime: 0 });
    holdMe(queryClient);
    me = partial('mfa');
    await signInGate(queryClient, 'login', {});
    expect(server.callsTo('GET auth/me')).toHaveLength(reads + 3);
    expect(queryClient.getQueryData(ME_KEY)).toEqual(partial('mfa'));
    queryClient.clear();
  });
});

describe('Profil saya: /admin/profile/2fa', () => {
  it('enabling shows the 10 codes once: leaving and coming back does not show them again', async () => {
    me = signedIn();
    const { router } = renderApp('/admin/profile/2fa');
    await enrol('Mulai menyiapkan');
    await waitFor(() => expect(shownCodes()).toHaveLength(10));
    expect(screen.getByRole('button', { name: 'Masuk lagi' })).toBeTruthy();

    // The session is gone on the server: the codes stay while they show, but leaving the page ends the hold, and
    // the shell's gate, reading auth/me afresh, sends the user to the sign-in page.
    await act(() => router.navigate({ to: '/admin' }));
    await waitFor(() => expect(router.state.location.pathname).toBe('/admin/login'));
    expect(await screen.findByRole('heading', { name: 'Masuk' })).toBeTruthy();
    expect(shownCodes()).toEqual([]);

    // Signed in again (now with 2FA on), the page has no codes to show.
    me = signedIn({ user: { totpEnabled: true } });
    await act(() => router.navigate({ to: '/admin/profile/2fa' }));
    await waitFor(() => expect(router.state.location.pathname).toBe('/admin/profile/2fa'));
    expect(await screen.findByRole('button', { name: 'Buat kode baru' })).toBeTruthy();
    expect(shownCodes()).toEqual([]);
    expect(screen.queryByText(CODES[0]!)).toBeNull();
  });

  it('the codes stay on screen when the window regains focus minutes later (auth/me, now signed out, is not refetched)', async () => {
    me = signedIn();
    renderApp('/admin/profile/2fa');
    await enrol('Mulai menyiapkan');
    await waitFor(() => expect(shownCodes()).toHaveLength(10));
    const reads = server.callsTo('GET auth/me').length;
    const later = Date.now() + 5 * 60_000;
    vi.spyOn(Date, 'now').mockReturnValue(later);
    act(() => {
      focusManager.setFocused(false);
      focusManager.setFocused(true);
    });
    await new Promise((resolve) => setTimeout(resolve, 20));
    expect(server.callsTo('GET auth/me')).toHaveLength(reads);
    expect(shownCodes()).toHaveLength(10);
  });

  it('"Masuk lagi" opens the sign-in page', async () => {
    me = signedIn();
    const { router } = renderApp('/admin/profile/2fa');
    await enrol('Mulai menyiapkan');
    fireEvent.click(await screen.findByRole('button', { name: 'Masuk lagi' }));
    await waitFor(() => expect(router.state.location.pathname).toBe('/admin/login'));
  });
});
