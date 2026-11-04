import { MESSAGES } from '@altis/shared';
import { PasswordChangeBody, ProfilePatchBody, ReauthBody, TwoFactorDisableBody, type MeResponse, type SessionItem } from '@altis/shared/api/auth';
import { act, fireEvent, screen, waitFor, within } from '@testing-library/react';
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import { reauth } from '@/lib/api';
import { ANON, fakeServer, json, problem, renderApp, signedIn, type FakeServer } from './fake-server';

// "Profil saya" (spec §13.3, §13.5; Task 28): name and language, the password, 2FA (regenerate codes, turn off) and
// the user's own sessions; plus the reauth dialog, which asks for a code when 2FA is on. `fetch` is faked.

const fetchMock = vi.fn<typeof fetch>();
let me: MeResponse;
let server: FakeServer;

const ID_A = 'a'.repeat(64);
const ID_B = 'b'.repeat(64);
const SESSIONS: SessionItem[] = [
  {
    id: ID_A,
    current: true,
    createdAt: Date.UTC(2026, 9, 28, 1, 0),
    lastSeenAt: Date.UTC(2026, 9, 28, 2, 0),
    ip: '10.0.0.5',
    userAgent: 'Mozilla/5.0 (Windows NT 10.0; Win64; x64) AppleWebKit/537.36 (KHTML, like Gecko) Chrome/141.0.0.0 Safari/537.36',
    remembered: false,
  },
  {
    id: ID_B,
    current: false,
    createdAt: Date.UTC(2026, 9, 27, 1, 0),
    lastSeenAt: Date.UTC(2026, 9, 27, 3, 0),
    ip: '10.0.0.9',
    userAgent: 'Mozilla/5.0 (Linux; Android 14; SM-A155F) AppleWebKit/537.36 (KHTML, like Gecko) Chrome/141.0.0.0 Mobile Safari/537.36',
    remembered: true,
  },
];

beforeEach(() => {
  vi.stubGlobal('fetch', fetchMock);
  me = signedIn();
  server = fakeServer(fetchMock, () => me);
});

afterEach(() => {
  fetchMock.mockReset();
  vi.unstubAllGlobals();
  vi.restoreAllMocks();
});

describe('profile: name and language', () => {
  it('shows the account and saves name and language with PATCH auth/me; the UI follows the new language', async () => {
    server.on('PATCH auth/me', (body) => {
      const b = body as { name: string; locale: 'id' | 'en' | null };
      me = signedIn({ user: { name: b.name, locale: b.locale } });
      return json((me as Extract<MeResponse, { authenticated: true }>).user);
    });
    renderApp('/admin/profile');
    expect(await screen.findByRole('heading', { name: 'Profil saya' })).toBeTruthy();
    expect(screen.getByText('ani@perpus.example')).toBeTruthy();
    fireEvent.change(screen.getByLabelText('Nama'), { target: { value: '  Ani Rahma ' } });
    fireEvent.change(screen.getByLabelText('Bahasa tampilan'), { target: { value: 'en' } });
    fireEvent.click(screen.getByRole('button', { name: 'Simpan' }));
    await waitFor(() => expect(server.callsTo('PATCH auth/me')).toHaveLength(1));
    const body = server.callsTo('PATCH auth/me')[0]?.body;
    expect(body).toEqual({ name: 'Ani Rahma', locale: 'en' });
    expect(ProfilePatchBody.safeParse(body).success).toBe(true);
    expect(await screen.findByRole('heading', { name: 'My profile' })).toBeTruthy();
    expect(await screen.findByText('Profile saved.')).toBeTruthy();
  });

  it("the library's language is sent as null", async () => {
    me = signedIn({ user: { locale: 'en' } });
    server.on('PATCH auth/me', () => json({}));
    renderApp('/admin/profile');
    fireEvent.change(await screen.findByLabelText('Display language'), { target: { value: '' } });
    fireEvent.click(screen.getByRole('button', { name: 'Save' }));
    await waitFor(() => expect(server.callsTo('PATCH auth/me')[0]?.body).toEqual({ name: 'Ani', locale: null }));
  });

  it('the profile sections are linked from each other', async () => {
    const { router } = renderApp('/admin/profile');
    const tabs = await screen.findByRole('navigation', { name: 'Bagian profil' });
    fireEvent.click(within(tabs).getByRole('link', { name: 'Sesi aktif' }));
    await waitFor(() => expect(router.state.location.pathname).toBe('/admin/profile/sessions'));
  });
});

describe('profile: password', () => {
  async function fill(current: string, next: string, confirm = next): Promise<void> {
    fireEvent.change(await screen.findByLabelText('Kata sandi saat ini'), { target: { value: current } });
    fireEvent.change(screen.getByLabelText('Kata sandi baru'), { target: { value: next } });
    fireEvent.change(screen.getByLabelText('Ulangi kata sandi baru'), { target: { value: confirm } });
    fireEvent.click(screen.getByRole('button', { name: 'Ganti kata sandi' }));
  }

  it('sends {current, next} and confirms', async () => {
    server.on('POST auth/password/change', () => json({}));
    renderApp('/admin/profile/password');
    await fill('kata-sandi-lama', 'kata-sandi-baru-2026');
    expect(await screen.findByText(/Kata sandi sudah diganti/)).toBeTruthy();
    const body = server.callsTo('POST auth/password/change')[0]?.body;
    expect(body).toEqual({ current: 'kata-sandi-lama', next: 'kata-sandi-baru-2026' });
    expect(PasswordChangeBody.safeParse(body).success).toBe(true);
  });

  it('a mismatch is caught before sending; a wrong current password shows on its field', async () => {
    server.on('POST auth/password/change', () => problem(401, 'AUTH_INVALID_CREDENTIALS'));
    renderApp('/admin/profile/password');
    await fill('kata-sandi-lama', 'kata-sandi-baru-2026', 'kata-sandi-baru-2025');
    expect(await screen.findByText('Kedua kata sandi tidak sama.')).toBeTruthy();
    expect(server.callsTo('POST auth/password/change')).toEqual([]);

    fireEvent.change(screen.getByLabelText('Ulangi kata sandi baru'), { target: { value: 'kata-sandi-baru-2026' } });
    fireEvent.click(screen.getByRole('button', { name: 'Ganti kata sandi' }));
    expect(await screen.findByText('Kata sandi saat ini salah.')).toBeTruthy();
    expect(screen.getByLabelText('Kata sandi saat ini').getAttribute('aria-invalid')).toBe('true');
  });

  it('a required change says so, and once done the user goes on to Beranda', async () => {
    me = signedIn({ mustChangePassword: true });
    server.on('POST auth/password/change', () => {
      me = signedIn();
      return json({});
    });
    const { router } = renderApp('/admin/profile/password');
    expect(await screen.findByText(MESSAGES.id['error.AUTH_PASSWORD_CHANGE_REQUIRED'])).toBeTruthy();
    await fill('sementara-1234-abcd', 'kata-sandi-baru-2026');
    await waitFor(() => expect(router.state.location.pathname).toBe('/admin'));
  });
});

describe('profile: sessions', () => {
  it('the current session has a badge; revoking another calls DELETE auth/sessions/<id>', async () => {
    let sessions = SESSIONS;
    server.on('GET auth/sessions', () => json(sessions));
    server.on(`DELETE auth/sessions/${ID_B}`, () => {
      sessions = SESSIONS.filter((s) => s.id !== ID_B);
      return json({});
    });
    renderApp('/admin/profile/sessions');
    const list = await screen.findByRole('list', { name: 'Daftar sesi' });
    const rows = within(list).getAllByRole('listitem');
    expect(rows).toHaveLength(2);
    expect(within(rows[0]!).getByText('Sesi ini')).toBeTruthy();
    expect(within(rows[0]!).getByText(/Chrome di Windows/)).toBeTruthy();
    expect(within(rows[0]!).queryByRole('button', { name: /Akhiri/ })).toBeNull();
    expect(within(rows[1]!).queryByText('Sesi ini')).toBeNull();
    expect(within(rows[1]!).getByText('Diingat')).toBeTruthy();

    fireEvent.click(within(rows[1]!).getByRole('button', { name: /Akhiri/ }));
    await waitFor(() => expect(server.callsTo(`DELETE auth/sessions/${ID_B}`)).toHaveLength(1));
    await waitFor(() => expect(within(screen.getByRole('list', { name: 'Daftar sesi' })).getAllByRole('listitem')).toHaveLength(1));
  });
});

describe('profile: 2FA turned on', () => {
  beforeEach(() => {
    me = signedIn({ user: { totpEnabled: true } });
  });

  it('new recovery codes go through the reauth dialog (password + code) and show once', async () => {
    let reauthed = false;
    const codes = Array.from({ length: 10 }, (_, i) => `QRSTU-6789${i}`);
    server.on('POST auth/2fa/recovery-codes', () => (reauthed ? json({ codes }) : problem(401, 'AUTH_REAUTH_REQUIRED')));
    server.on('POST auth/reauth', () => {
      reauthed = true;
      return json({ reauthUntil: Date.now() + 300_000 });
    });
    renderApp('/admin/profile/2fa');
    fireEvent.click(await screen.findByRole('button', { name: 'Buat kode baru' }));
    const dialog = await screen.findByRole('dialog', { name: 'Konfirmasi kata sandi' });
    fireEvent.change(within(dialog).getByLabelText('Kata sandi'), { target: { value: 'kata-sandi-ani' } });
    fireEvent.change(within(dialog).getByLabelText('Kode autentikator'), { target: { value: '112233' } });
    fireEvent.click(within(dialog).getByRole('button', { name: 'Konfirmasi' }));
    const list = await screen.findByRole('list', { name: 'Kode cadangan' });
    expect(within(list).getAllByRole('listitem').map((li) => li.textContent)).toEqual(codes);
    const reauthBody = server.callsTo('POST auth/reauth')[0]?.body;
    expect(reauthBody).toEqual({ password: 'kata-sandi-ani', code: '112233' });
    expect(ReauthBody.safeParse(reauthBody).success).toBe(true);
    fireEvent.click(screen.getByRole('button', { name: 'Selesai' }));
    await waitFor(() => expect(screen.queryByRole('list', { name: 'Kode cadangan' })).toBeNull());
  });

  it('turning 2FA off needs password + code, then ends with "Masuk lagi"', async () => {
    server.on('POST auth/2fa/disable', () => {
      me = ANON;
      return json({});
    });
    const { router } = renderApp('/admin/profile/2fa');
    fireEvent.change(await screen.findByLabelText('Kata sandi'), { target: { value: 'kata-sandi-ani' } });
    fireEvent.change(screen.getByLabelText('Kode autentikator'), { target: { value: '445566' } });
    fireEvent.click(screen.getByRole('button', { name: 'Nonaktifkan 2FA' }));
    expect(await screen.findByText(/sudah dinonaktifkan/)).toBeTruthy();
    const body = server.callsTo('POST auth/2fa/disable')[0]?.body;
    expect(body).toEqual({ password: 'kata-sandi-ani', code: '445566' });
    expect(TwoFactorDisableBody.safeParse(body).success).toBe(true);
    fireEvent.click(screen.getByRole('button', { name: 'Masuk lagi' }));
    await waitFor(() => expect(router.state.location.pathname).toBe('/admin/login'));
  });

  it('when 2FA is required for the account there is nothing to turn off', async () => {
    me = signedIn({ user: { totpEnabled: true, mfaRequired: true } });
    renderApp('/admin/profile/2fa');
    expect(await screen.findByText(/diwajibkan untuk akun Anda/)).toBeTruthy();
    expect(screen.queryByRole('button', { name: 'Nonaktifkan 2FA' })).toBeNull();
  });
});

describe('reauth dialog', () => {
  it('a 429 shows how long to wait; the code field is emptied after a wrong code', async () => {
    me = signedIn({ user: { totpEnabled: true } });
    let attempt = 0;
    server.on('POST auth/reauth', () => {
      attempt += 1;
      return attempt === 1 ? problem(401, 'AUTH_MFA_INVALID') : problem(429, 'AUTH_TOO_MANY_ATTEMPTS', { headers: { 'Retry-After': '30' } });
    });
    renderApp('/admin');
    await screen.findByText('Selamat datang, Ani.');
    let settled = false;
    act(() => {
      reauth.request().catch(() => (settled = true));
    });
    const dialog = await screen.findByRole('dialog', { name: 'Konfirmasi kata sandi' });
    fireEvent.change(within(dialog).getByLabelText('Kata sandi'), { target: { value: 'kata-sandi-ani' } });
    fireEvent.change(within(dialog).getByLabelText('Kode autentikator'), { target: { value: '000000' } });
    fireEvent.click(within(dialog).getByRole('button', { name: 'Konfirmasi' }));
    expect(await within(dialog).findByText(MESSAGES.id['error.AUTH_MFA_INVALID'])).toBeTruthy();
    expect((within(dialog).getByLabelText('Kode autentikator') as HTMLInputElement).value).toBe('');
    fireEvent.change(within(dialog).getByLabelText('Kode autentikator'), { target: { value: '111111' } });
    fireEvent.click(within(dialog).getByRole('button', { name: 'Konfirmasi' }));
    expect(await within(dialog).findByText(/30 detik/)).toBeTruthy();
    fireEvent.click(within(dialog).getByRole('button', { name: 'Batal' }));
    await waitFor(() => expect(settled).toBe(true));
  });
});
