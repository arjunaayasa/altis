import { MESSAGES } from '@altis/shared';
import { PasswordForgotBody, PasswordResetBody, type MeResponse } from '@altis/shared/api/auth';
import { createBrowserHistory } from '@tanstack/react-router';
import { fireEvent, screen, waitFor } from '@testing-library/react';
import { afterEach, beforeEach, describe, expect, it, vi, type MockInstance } from 'vitest';
import { ANON, fakeServer, json, problem, renderApp, type FakeServer } from './fake-server';

// "Lupa sandi" and the reset link (spec §7.1 "Reset sandi"; Task 28). The link is `/admin/reset-password#token=<t>`:
// the page reads the token from the fragment and drops the fragment from the address bar (history.replaceState)
// before anything else happens, so the token stays out of the history, bookmarks and screenshots.

const TOKEN = 'Q2xhdWRlLXJlc2V0LXRva2VuLWZvci1hbmktMDEyMzQ'; // 43 base64url characters
const fetchMock = vi.fn<typeof fetch>();
let me: MeResponse;
let server: FakeServer;
let history: ReturnType<typeof createBrowserHistory> | undefined;
let consoleError: MockInstance<typeof console.error>;

beforeEach(() => {
  vi.stubGlobal('fetch', fetchMock);
  me = ANON;
  server = fakeServer(fetchMock, () => me);
  consoleError = vi.spyOn(console, 'error');
});

afterEach(() => {
  history?.destroy();
  history = undefined;
  window.history.replaceState(null, '', '/');
  fetchMock.mockReset();
  vi.unstubAllGlobals();
  // React's warnings (e.g. a router update while the page renders) are reported once per run: every test checks.
  const errors = consoleError.mock.calls.map((c) => String(c[0]));
  vi.restoreAllMocks();
  expect(errors).toEqual([]);
});

/**
 * Opens `href` as a fresh page load in the browser's own history (the reset link comes from a mail). The spies on
 * `replaceState`/`pushState` are installed after the address is set, so they see only what the app does.
 */
function openPage(href: string) {
  window.history.replaceState(null, '', href);
  const replaceState = vi.spyOn(window.history, 'replaceState');
  const pushState = vi.spyOn(window.history, 'pushState');
  history = createBrowserHistory();
  return { ...renderApp(href, { history }), replaceState, pushState };
}

async function fillNewPassword(password: string, confirm = password): Promise<void> {
  fireEvent.change(await screen.findByLabelText('Kata sandi baru'), { target: { value: password } });
  fireEvent.change(screen.getByLabelText('Ulangi kata sandi baru'), { target: { value: confirm } });
  fireEvent.click(screen.getByRole('button', { name: 'Simpan kata sandi' }));
}

describe('reset-password', () => {
  it('replaceState drops the fragment before the POST, whose body carries the token from the hash', async () => {
    let atPost: { href: string; length: number } | undefined;
    server.on('POST auth/password/reset', () => {
      atPost = { href: window.location.href, length: window.history.length };
      return json({});
    });
    const length = window.history.length;
    const { router, replaceState, pushState } = openPage(`/admin/reset-password#token=${TOKEN}`);
    await screen.findByLabelText('Kata sandi baru');
    expect(window.location.hash).toBe('');
    expect(window.location.href).not.toContain('#');
    expect(window.location.pathname).toBe('/admin/reset-password');

    await fillNewPassword('rak-buku-baru-2026');
    await waitFor(() => expect(server.callsTo('POST auth/password/reset')).toHaveLength(1));
    const post = server.callsTo('POST auth/password/reset')[0]!;
    expect(post.body).toEqual({ token: TOKEN, password: 'rak-buku-baru-2026' });
    expect(PasswordResetBody.safeParse(post.body).success).toBe(true);

    // The page's own replaceState (to the bare path) came before the POST; no entry was pushed meanwhile, so the
    // entry that held the token is gone rather than kept in the back/forward history.
    const dropped = replaceState.mock.calls.findIndex((c) => c[2] === '/admin/reset-password');
    expect(dropped).toBeGreaterThanOrEqual(0);
    expect(replaceState.mock.invocationCallOrder[dropped]).toBeLessThan(post.order);
    expect(pushState.mock.invocationCallOrder.filter((n) => n < post.order)).toEqual([]);
    expect(atPost).toEqual({ href: `${window.location.origin}/admin/reset-password`, length });

    await waitFor(() => expect(router.state.location.pathname).toBe('/admin/login'));
    expect(await screen.findByText(/Kata sandi baru sudah disimpan/)).toBeTruthy();
  });

  it("the router's own location drops the token too, without updating the router while the page renders", async () => {
    const { router } = openPage(`/admin/reset-password#token=${TOKEN}`);
    await screen.findByLabelText('Kata sandi baru');
    await waitFor(() => expect(router.state.location.hash).toBe(''));
    expect(router.state.location.href).not.toContain(TOKEN);
    expect(router.history.location.href).not.toContain(TOKEN);
    expect(router.state.resolvedLocation?.href ?? '').not.toContain(TOKEN);
  });

  it('a link without a token says so and offers a new one, without sending anything', async () => {
    openPage('/admin/reset-password');
    expect(await screen.findByText(/Tautan ini tidak lengkap atau sudah dipakai/)).toBeTruthy();
    expect(screen.getByRole('link', { name: 'Minta tautan baru' }).getAttribute('href')).toBe('/admin/forgot-password');
    expect(server.calls.filter((c) => c.method !== 'GET')).toEqual([]);
  });

  it('the two passwords must match (checked before sending)', async () => {
    openPage(`/admin/reset-password#token=${TOKEN}`);
    await fillNewPassword('rak-buku-baru-2026', 'rak-buku-baru-2025');
    expect(await screen.findByText('Kedua kata sandi tidak sama.')).toBeTruthy();
    expect(server.callsTo('POST auth/password/reset')).toEqual([]);
  });

  it('a weak password is reported on the field, with the reason', async () => {
    server.on('POST auth/password/reset', () => problem(422, 'PASSWORD_TOO_WEAK', { reason: 'common' }));
    openPage(`/admin/reset-password#token=${TOKEN}`);
    await fillNewPassword('password123');
    expect(await screen.findByText(/terlalu umum/)).toBeTruthy();
  });

  it('an expired or used link → the localized message and a way to ask again', async () => {
    server.on('POST auth/password/reset', () => problem(400, 'AUTH_RESET_TOKEN_INVALID'));
    openPage(`/admin/reset-password#token=${TOKEN}`);
    await fillNewPassword('rak-buku-baru-2026');
    expect(await screen.findByText(MESSAGES.id['error.AUTH_RESET_TOKEN_INVALID'])).toBeTruthy();
    expect(screen.getByRole('link', { name: 'Minta tautan baru' })).toBeTruthy();
  });
});

describe('forgot-password', () => {
  it('sends the address and shows the same confirmation whatever the answer means', async () => {
    server.on('POST auth/password/forgot', () => json({ accepted: true }, 202));
    renderApp('/admin/forgot-password');
    fireEvent.change(await screen.findByLabelText('Alamat e-mail'), { target: { value: 'ani@perpus.example' } });
    fireEvent.click(screen.getByRole('button', { name: 'Kirim tautan' }));
    expect(await screen.findByText(/Jika alamat itu terdaftar pada akun yang aktif/)).toBeTruthy();
    const body = server.callsTo('POST auth/password/forgot')[0]?.body;
    expect(body).toEqual({ email: 'ani@perpus.example' });
    expect(PasswordForgotBody.safeParse(body).success).toBe(true);
    expect(screen.getByRole('link', { name: 'Kembali ke halaman masuk' }).getAttribute('href')).toBe('/admin/login');
  });

  it('an address that is not an address is refused before sending', async () => {
    renderApp('/admin/forgot-password');
    fireEvent.change(await screen.findByLabelText('Alamat e-mail'), { target: { value: 'ani-at-perpus' } });
    fireEvent.click(screen.getByRole('button', { name: 'Kirim tautan' }));
    expect(await screen.findByText('Formatnya belum benar.')).toBeTruthy();
    expect(server.callsTo('POST auth/password/forgot')).toEqual([]);
  });

  it('a 429 tells how long to wait', async () => {
    server.on('POST auth/password/forgot', () => problem(429, 'AUTH_TOO_MANY_ATTEMPTS', { headers: { 'Retry-After': '300' } }));
    renderApp('/admin/forgot-password');
    fireEvent.change(await screen.findByLabelText('Alamat e-mail'), { target: { value: 'ani@perpus.example' } });
    fireEvent.click(screen.getByRole('button', { name: 'Kirim tautan' }));
    expect(await screen.findByText(/sekitar 5 menit/)).toBeTruthy();
  });
});
