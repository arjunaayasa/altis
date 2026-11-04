import { MESSAGES } from '@altis/shared';
import { LoginBody, TwoFactorVerifyBody, type MeResponse } from '@altis/shared/api/auth';
import { fireEvent, screen, waitFor } from '@testing-library/react';
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import { page } from '@/lib/page';
import { ANON, fakeServer, json, partial, problem, renderApp, renderInBrowser, signedIn, type FakeServer } from './fake-server';

// The sign-in screens (spec §7.1, §13.3 "Login"; Task 28): the password step, the second factor (code or recovery
// code, remember-me), the re-enrolment step, and where each lands afterwards (safeNext, M11). `fetch` is faked.

const fetchMock = vi.fn<typeof fetch>();
let me: MeResponse;
let server: FakeServer;

beforeEach(() => {
  vi.stubGlobal('fetch', fetchMock);
  me = ANON;
  server = fakeServer(fetchMock, () => me);
});

afterEach(() => {
  fetchMock.mockReset();
  vi.unstubAllGlobals();
  vi.restoreAllMocks();
});

async function fillLogin(o: { username?: string; password?: string; remember?: boolean } = {}): Promise<void> {
  fireEvent.change(await screen.findByLabelText('Nama pengguna'), { target: { value: o.username ?? 'ani' } });
  fireEvent.change(screen.getByLabelText('Kata sandi'), { target: { value: o.password ?? 'buku-tua-di-rak-7' } });
  if (o.remember === true) fireEvent.click(screen.getByRole('checkbox', { name: /Ingat saya/ }));
  fireEvent.click(screen.getByRole('button', { name: 'Masuk' }));
}

/** POST auth/login signs in to `stage`: auth/me answers that session from then on. */
function loginAnswers(stage: 'full' | 'mfa' | 'mfa_setup' | 'recovery', mustChangePassword = false): void {
  server.on('POST auth/login', () => {
    me = stage === 'full' ? signedIn({ mustChangePassword }) : partial(stage);
    return json({ stage, mustChangePassword });
  });
}

describe('login', () => {
  it('submitting sends LoginBody (remember included) and a full session lands on Beranda', async () => {
    loginAnswers('full');
    const { router } = renderApp('/admin/login');
    expect(await screen.findByRole('heading', { name: 'Masuk' })).toBeTruthy();
    await fillLogin({ remember: true });
    await waitFor(() => expect(router.state.location.pathname).toBe('/admin'));
    expect(await screen.findByText('Selamat datang, Ani.')).toBeTruthy();
    const [post] = server.callsTo('POST auth/login');
    expect(post?.body).toEqual({ username: 'ani', password: 'buku-tua-di-rak-7', remember: true });
    expect(LoginBody.safeParse(post?.body).success).toBe(true);
  });

  it('?next=//evil.example lands on /admin after sign-in (M11)', async () => {
    loginAnswers('full');
    const { router } = renderApp(`/admin/login?next=${encodeURIComponent('//evil.example')}`);
    await fillLogin();
    await waitFor(() => expect(router.state.location.pathname).toBe('/admin'));
    expect(router.state.location.href).toBe('/admin');
  });

  it('a same-origin ?next= under /admin is where the user lands', async () => {
    loginAnswers('full');
    const { router } = renderApp(`/admin/login?next=${encodeURIComponent('/admin/profile/sessions')}`);
    await fillLogin();
    await waitFor(() => expect(router.state.location.pathname).toBe('/admin/profile/sessions'));
  });

  // 1c Task 19: the operations page is a server page (ops.update_page): the router never renders it, the page is loaded.
  // These run in the browser's own history, as production does: there the address bar already shows /admin/_update
  // when the route's beforeLoad runs, so only the address the document was loaded at can tell a loop.
  it('?next=/admin/_update: once signed in, the operations page is loaded as a page (page.assign), never routed', async () => {
    const assign = vi.spyOn(page, 'assign').mockImplementation(() => {});
    loginAnswers('full');
    renderInBrowser(`/admin/login?next=${encodeURIComponent('/admin/_update')}`);
    await fillLogin();
    await waitFor(() => expect(assign).toHaveBeenCalledExactlyOnceWith('/admin/_update'));
    expect(window.location.pathname).toBe('/admin/_update');
    expect(screen.queryByRole('heading', { name: 'Halaman tidak ditemukan' })).toBeNull();
  });

  it('?next=/admin/_update for a session already signed in (the sign-in gate) → the page is loaded too', async () => {
    const assign = vi.spyOn(page, 'assign').mockImplementation(() => {});
    me = signedIn();
    renderInBrowser(`/admin/login?next=${encodeURIComponent('/admin/_update')}`);
    await waitFor(() => expect(assign).toHaveBeenCalledExactlyOnceWith('/admin/_update'));
    expect(screen.queryByRole('heading', { name: 'Halaman tidak ditemukan' })).toBeNull();
  });

  it('router.navigate to /admin/_update from another screen → the page is loaded (page.assign), no "not found"', async () => {
    const assign = vi.spyOn(page, 'assign').mockImplementation(() => {});
    me = signedIn();
    const { router } = renderInBrowser('/admin');
    expect(await screen.findByText('Selamat datang, Ani.')).toBeTruthy();
    await router.navigate({ href: '/admin/_update' });
    await waitFor(() => expect(assign).toHaveBeenCalledExactlyOnceWith('/admin/_update'));
    expect(screen.queryByRole('heading', { name: 'Halaman tidak ditemukan' })).toBeNull();
  });

  it('{stage: mfa} navigates to /admin/login/2fa, carrying next and the remember choice', async () => {
    loginAnswers('mfa');
    const { router } = renderApp(`/admin/login?next=${encodeURIComponent('/admin/profile')}`);
    await fillLogin({ remember: true });
    await waitFor(() => expect(router.state.location.pathname).toBe('/admin/login/2fa'));
    expect(router.state.location.search).toEqual({ next: '/admin/profile', remember: true });
    expect(await screen.findByRole('heading', { name: 'Verifikasi dua langkah' })).toBeTruthy();
    expect((screen.getByRole('checkbox', { name: /Ingat saya/ }) as HTMLInputElement).checked).toBe(true);
  });

  it('{stage: mfa_setup} and {stage: recovery} open their own step', async () => {
    loginAnswers('mfa_setup');
    const first = renderApp('/admin/login');
    await fillLogin();
    await waitFor(() => expect(first.router.state.location.pathname).toBe('/admin/login/setup-2fa'));
    first.view.unmount();

    me = ANON;
    loginAnswers('recovery');
    const second = renderApp('/admin/login');
    await fillLogin();
    await waitFor(() => expect(second.router.state.location.pathname).toBe('/admin/login/recovery'));
  });

  it('a password that must change first → /admin/profile/password', async () => {
    loginAnswers('full', true);
    const { router } = renderApp('/admin/login');
    await fillLogin();
    await waitFor(() => expect(router.state.location.pathname).toBe('/admin/profile/password'));
  });

  it('the password detour keeps next: once changed, the user lands on next (M11)', async () => {
    loginAnswers('full', true);
    server.on('POST auth/password/change', () => {
      me = signedIn();
      return json({});
    });
    const { router } = renderApp(`/admin/login?next=${encodeURIComponent('/admin/profile')}`);
    await fillLogin();
    await waitFor(() => expect(router.state.location.pathname).toBe('/admin/profile/password'));
    expect(router.state.location.search).toEqual({ next: '/admin/profile' });
    fireEvent.change(await screen.findByLabelText('Kata sandi saat ini'), { target: { value: 'buku-tua-di-rak-7' } });
    fireEvent.change(screen.getByLabelText('Kata sandi baru'), { target: { value: 'kata-sandi-baru-2026' } });
    fireEvent.change(screen.getByLabelText('Ulangi kata sandi baru'), { target: { value: 'kata-sandi-baru-2026' } });
    fireEvent.click(screen.getByRole('button', { name: 'Ganti kata sandi' }));
    await waitFor(() => expect(router.state.location.pathname).toBe('/admin/profile'));
    expect(await screen.findByRole('heading', { name: 'Profil saya' })).toBeTruthy();
  });

  it('after the password detour, a next outside /admin still lands on /admin (M11)', async () => {
    loginAnswers('full', true);
    server.on('POST auth/password/change', () => {
      me = signedIn();
      return json({});
    });
    const { router } = renderApp(`/admin/login?next=${encodeURIComponent('https://evil.example/admin')}`);
    await fillLogin();
    await waitFor(() => expect(router.state.location.pathname).toBe('/admin/profile/password'));
    fireEvent.change(await screen.findByLabelText('Kata sandi saat ini'), { target: { value: 'buku-tua-di-rak-7' } });
    fireEvent.change(screen.getByLabelText('Kata sandi baru'), { target: { value: 'kata-sandi-baru-2026' } });
    fireEvent.change(screen.getByLabelText('Ulangi kata sandi baru'), { target: { value: 'kata-sandi-baru-2026' } });
    fireEvent.click(screen.getByRole('button', { name: 'Ganti kata sandi' }));
    await waitFor(() => expect(router.state.location.pathname).toBe('/admin'));
    expect(router.state.location.href).toBe('/admin');
  });

  it('a 429 shows the localized AUTH_TOO_MANY_ATTEMPTS with the seconds', async () => {
    server.on('POST auth/login', () => problem(429, 'AUTH_TOO_MANY_ATTEMPTS', { headers: { 'Retry-After': '42' } }));
    renderApp('/admin/login');
    await fillLogin();
    const alert = await screen.findByText((_, el) => el?.getAttribute('role') === 'alert' && /42 detik/.test(el.textContent ?? ''));
    expect(alert.textContent).toContain(MESSAGES.id['error.AUTH_TOO_MANY_ATTEMPTS']);
  });

  it('wrong credentials: the message, the password cleared, the username kept', async () => {
    server.on('POST auth/login', () => problem(401, 'AUTH_INVALID_CREDENTIALS'));
    const { router } = renderApp('/admin/login');
    await fillLogin();
    expect(await screen.findByText(MESSAGES.id['error.AUTH_INVALID_CREDENTIALS'])).toBeTruthy();
    expect((screen.getByLabelText('Kata sandi') as HTMLInputElement).value).toBe('');
    expect((screen.getByLabelText('Nama pengguna') as HTMLInputElement).value).toBe('ani');
    expect(router.state.location.pathname).toBe('/admin/login');
  });

  it('empty fields are refused before anything is sent', async () => {
    renderApp('/admin/login');
    fireEvent.click(await screen.findByRole('button', { name: 'Masuk' }));
    expect((await screen.findAllByText('Wajib diisi.')).length).toBe(2);
    expect(server.callsTo('POST auth/login')).toEqual([]);
  });

  it('403 CSRF_INVALID → auth/me gives a fresh token, the login is sent once more (R1b-1)', async () => {
    let first = true;
    server.on('POST auth/login', () => {
      if (first) {
        first = false;
        return problem(403, 'CSRF_INVALID');
      }
      me = signedIn();
      return json({ stage: 'full', mustChangePassword: false });
    });
    const { router } = renderApp('/admin/login');
    await fillLogin();
    await waitFor(() => expect(router.state.location.pathname).toBe('/admin'));
    expect(server.callsTo('POST auth/login')).toHaveLength(2);
  });

  it('a fully signed-in user opening the sign-in page goes on to next', async () => {
    me = signedIn();
    const { router } = renderApp(`/admin/login?next=${encodeURIComponent('/admin/profile')}`);
    await waitFor(() => expect(router.state.location.pathname).toBe('/admin/profile'));
  });

  it('links to the forgotten-password page', async () => {
    const { router } = renderApp('/admin/login');
    fireEvent.click(await screen.findByRole('link', { name: 'Lupa kata sandi?' }));
    await waitFor(() => expect(router.state.location.pathname).toBe('/admin/forgot-password'));
  });
});

describe('second factor', () => {
  beforeEach(() => {
    me = partial('mfa');
  });

  async function submitCode(code: string): Promise<void> {
    fireEvent.change(await screen.findByLabelText('Kode autentikator'), { target: { value: code } });
    fireEvent.click(screen.getByRole('button', { name: 'Verifikasi' }));
  }

  it('a code completes the sign-in (remember as chosen) and lands on next', async () => {
    server.on('POST auth/2fa/verify', () => {
      me = signedIn({ user: { totpEnabled: true } });
      return json({ stage: 'full', mustChangePassword: false });
    });
    const { router } = renderApp(`/admin/login/2fa?next=${encodeURIComponent('/admin/profile')}&remember=true`);
    await submitCode('123456');
    await waitFor(() => expect(router.state.location.pathname).toBe('/admin/profile'));
    const body = server.callsTo('POST auth/2fa/verify')[0]?.body;
    expect(body).toEqual({ code: '123456', remember: true });
    expect(TwoFactorVerifyBody.safeParse(body).success).toBe(true);
  });

  it('a recovery code can be used instead', async () => {
    server.on('POST auth/2fa/verify', () => {
      me = signedIn({ user: { totpEnabled: true } });
      return json({ stage: 'full', mustChangePassword: false });
    });
    const { router } = renderApp('/admin/login/2fa');
    fireEvent.click(await screen.findByRole('button', { name: /Pakai kode cadangan/ }));
    fireEvent.change(screen.getByLabelText('Kode cadangan'), { target: { value: ' abcde-12345 ' } });
    fireEvent.click(screen.getByRole('button', { name: 'Verifikasi' }));
    await waitFor(() => expect(router.state.location.pathname).toBe('/admin'));
    expect(server.callsTo('POST auth/2fa/verify')[0]?.body).toEqual({ recoveryCode: 'abcde-12345', remember: false });
  });

  it('a wrong code: the message, the field cleared, still on the page', async () => {
    server.on('POST auth/2fa/verify', () => problem(401, 'AUTH_MFA_INVALID'));
    const { router } = renderApp('/admin/login/2fa');
    await submitCode('000000');
    expect(await screen.findByText(MESSAGES.id['error.AUTH_MFA_INVALID'])).toBeTruthy();
    expect((screen.getByLabelText('Kode autentikator') as HTMLInputElement).value).toBe('');
    expect(router.state.location.pathname).toBe('/admin/login/2fa');
  });

  it('too many wrong codes (401 AUTH_REQUIRED, the session is gone) → the sign-in page says why', async () => {
    server.on('POST auth/2fa/verify', () => {
      me = ANON;
      return problem(401, 'AUTH_REQUIRED');
    });
    const { router } = renderApp(`/admin/login/2fa?next=${encodeURIComponent('/admin/profile')}`);
    await submitCode('999999');
    await waitFor(() => expect(router.state.location.pathname).toBe('/admin/login'));
    expect(await screen.findByText(/terlalu banyak kode yang salah/)).toBeTruthy();
    expect(screen.getByRole('heading', { name: 'Masuk' })).toBeTruthy();
    expect(router.state.location.search).toMatchObject({ next: '/admin/profile' });
  });

  it('Batal signs the half-finished sign-in out', async () => {
    server.on('POST auth/logout', () => {
      me = ANON;
      return new Response(null, { status: 204 });
    });
    const { router } = renderApp('/admin/login/2fa');
    fireEvent.click(await screen.findByRole('button', { name: /Batal/ }));
    await waitFor(() => expect(router.state.location.pathname).toBe('/admin/login'));
    expect(server.callsTo('POST auth/logout')).toHaveLength(1);
  });

  it('signed out → the 2FA page sends the visitor to the sign-in page', async () => {
    me = ANON;
    const { router } = renderApp('/admin/login/2fa');
    await waitFor(() => expect(router.state.location.pathname).toBe('/admin/login'));
  });
});

describe('re-enrolment (stage recovery)', () => {
  it('a recovery code moves the session on to the setup step', async () => {
    me = partial('recovery');
    server.on('POST auth/2fa/verify', () => {
      me = partial('mfa_setup');
      return json({ stage: 'mfa_setup', mustChangePassword: false });
    });
    const { router } = renderApp('/admin/login/recovery');
    fireEvent.change(await screen.findByLabelText('Kode cadangan'), { target: { value: 'ABCDE-12345' } });
    fireEvent.click(screen.getByRole('button', { name: 'Lanjutkan' }));
    await waitFor(() => expect(router.state.location.pathname).toBe('/admin/login/setup-2fa'));
    expect(server.callsTo('POST auth/2fa/verify')[0]?.body).toEqual({ recoveryCode: 'ABCDE-12345' });
  });
});
