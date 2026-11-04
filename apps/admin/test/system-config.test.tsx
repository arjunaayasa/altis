import type { CronTokenRotateResponse, SystemConfigPutResponse, SystemConfigView } from '@altis/shared/api/system-config';
import { fireEvent, screen, waitFor, within } from '@testing-library/react';
import { afterEach, describe, expect, it, vi } from 'vitest';
import { adminMe, problem, startApp, superMe, type FakeHandler } from './fake-api';

// Spec §13.3 "Konfigurasi Sistem" (Task 30): baseUrl, proxy hops, allowed origins, the SMTP transport with its
// write-only password, the test mail and the cron token. A field an environment variable sets is locked with the
// variable's name. The server is faked (fake-api.tsx).

afterEach(() => {
  vi.unstubAllGlobals();
  vi.restoreAllMocks();
});

function view(o: Partial<SystemConfigView> = {}): SystemConfigView {
  return {
    baseUrl: 'https://perpus.example',
    trustProxy: { hops: 1 },
    allowedOrigins: [],
    smtp: {
      host: 'smtp.perpus.example',
      port: 587,
      security: 'starttls',
      username: 'mailer',
      password: { isSet: true },
      from: 'perpustakaan@perpus.example',
    },
    cronToken: { isSet: true },
    locked: {},
    ...o,
  };
}

function routes(current: SystemConfigView, extra: Record<string, FakeHandler> = {}): Record<string, FakeHandler> {
  return {
    'GET system/config': () => current,
    ...extra,
  };
}

const answer = (v: SystemConfigView, signInAgain = false): SystemConfigPutResponse => ({ ...v, signInAgain });

describe('system configuration', () => {
  it('a field in locked is disabled and names its environment variable', async () => {
    startApp({ me: superMe(), path: '/admin/system', routes: routes(view({ locked: { baseUrl: 'ALTIS_BASE_URL' } })) });
    const baseUrl = (await screen.findByLabelText('Alamat situs (baseUrl)')) as HTMLInputElement;
    await waitFor(() => expect(baseUrl.value).toBe('https://perpus.example'));
    expect(baseUrl.disabled).toBe(true);
    expect(screen.getAllByText(/ALTIS_BASE_URL/).length).toBeGreaterThan(0);
    const hops = screen.getByLabelText('Jumlah proxy tepercaya (trustProxy.hops)') as HTMLInputElement;
    expect(hops.disabled).toBe(false);
  });

  it('the saved SMTP password shows as "tersimpan" with an empty input; saving with it empty sends no password key', async () => {
    const puts: unknown[] = [];
    startApp({
      me: superMe(),
      path: '/admin/system',
      routes: routes(view({ locked: { baseUrl: 'ALTIS_BASE_URL' } }), {
        'PUT system/config': (req) => {
          puts.push(req.body);
          return answer(view({ locked: { baseUrl: 'ALTIS_BASE_URL' }, smtp: { ...view().smtp, from: 'pustaka@perpus.example' } }));
        },
      }),
    });
    const password = (await screen.findByLabelText(/Kata sandi SMTP/)) as HTMLInputElement;
    expect(password.value).toBe('');
    expect(screen.getByText('tersimpan')).toBeTruthy();
    const from = screen.getByLabelText('Alamat pengirim') as HTMLInputElement;
    await waitFor(() => expect(from.value).toBe('perpustakaan@perpus.example'));
    fireEvent.change(from, { target: { value: 'pustaka@perpus.example' } });
    fireEvent.click(screen.getByRole('button', { name: 'Simpan' }));
    await waitFor(() => expect(puts).toHaveLength(1));
    expect(puts[0]).toEqual({ smtp: { from: 'pustaka@perpus.example' } });
    const smtp = (puts[0] as { smtp: Record<string, unknown> }).smtp;
    expect(Object.prototype.hasOwnProperty.call(smtp, 'password')).toBe(false);
    expect(await screen.findByText('Perubahan disimpan.')).toBeTruthy();
  });

  it('a new SMTP password is sent; a locked field never is', async () => {
    const puts: unknown[] = [];
    startApp({
      me: superMe(),
      path: '/admin/system',
      routes: routes(view({ locked: { baseUrl: 'ALTIS_BASE_URL', 'trustProxy.hops': 'ALTIS_TRUST_PROXY_HOPS' } }), {
        'PUT system/config': (req) => {
          puts.push(req.body);
          return answer(view({ locked: { baseUrl: 'ALTIS_BASE_URL', 'trustProxy.hops': 'ALTIS_TRUST_PROXY_HOPS' } }));
        },
      }),
    });
    const password = (await screen.findByLabelText(/Kata sandi SMTP/)) as HTMLInputElement;
    await waitFor(() => expect((screen.getByLabelText('Host SMTP') as HTMLInputElement).value).toBe('smtp.perpus.example'));
    fireEvent.change(password, { target: { value: 'rahasia-baru' } });
    fireEvent.click(screen.getByRole('button', { name: 'Simpan' }));
    await waitFor(() => expect(puts).toHaveLength(1));
    expect(puts[0]).toEqual({ smtp: { password: 'rahasia-baru' } });
    await waitFor(() => expect(password.value).toBe(''));
  });

  it('changing the host while a password is saved warns that the password will be cleared', async () => {
    startApp({ me: superMe(), path: '/admin/system', routes: routes(view()) });
    const host = (await screen.findByLabelText('Host SMTP')) as HTMLInputElement;
    await waitFor(() => expect(host.value).toBe('smtp.perpus.example'));
    expect(screen.queryByText(/kata sandi yang tersimpan akan dihapus/)).toBeNull();
    fireEvent.change(host, { target: { value: 'smtp.lain.example' } });
    expect(await screen.findByText(/kata sandi yang tersimpan akan dihapus/)).toBeTruthy();
  });

  it('an http→https switch refused with origin_mismatch shows the server detail', async () => {
    const detail = 'Alamat https membuat cookie masuk hanya berlaku di https / An https address makes the sign-in cookies https-only';
    startApp({
      me: superMe(),
      path: '/admin/system',
      routes: routes(view({ baseUrl: 'http://perpus.example' }), {
        'PUT system/config': () => problem(422, 'INVALID_BASE_URL', { reason: 'origin_mismatch', detail }),
      }),
    });
    const baseUrl = (await screen.findByLabelText('Alamat situs (baseUrl)')) as HTMLInputElement;
    await waitFor(() => expect(baseUrl.value).toBe('http://perpus.example'));
    fireEvent.change(baseUrl, { target: { value: 'https://perpus.example' } });
    fireEvent.click(screen.getByRole('button', { name: 'Simpan' }));
    expect(await screen.findByText(detail)).toBeTruthy();
    expect(screen.getByText(/agar Anda tidak terkunci/)).toBeTruthy();
  });

  it('signInAgain tells the admin to sign in again at the new address', async () => {
    startApp({
      me: superMe(),
      path: '/admin/system',
      routes: routes(view({ baseUrl: 'http://perpus.example', allowedOrigins: ['https://perpus.example'] }), {
        'PUT system/config': () => answer(view({ baseUrl: 'https://perpus.example', allowedOrigins: ['https://perpus.example'] }), true),
      }),
    });
    const baseUrl = (await screen.findByLabelText('Alamat situs (baseUrl)')) as HTMLInputElement;
    await waitFor(() => expect(baseUrl.value).toBe('http://perpus.example'));
    fireEvent.change(baseUrl, { target: { value: 'https://perpus.example' } });
    fireEvent.click(screen.getByRole('button', { name: 'Simpan' }));
    const link = await screen.findByRole('link', { name: /Masuk di https:\/\/perpus\.example/ });
    expect(link.getAttribute('href')).toBe('https://perpus.example/admin/login');
    // A long address breaks inside the link instead of widening the page on a 375 px phone.
    expect(link.className.split(' ')).toContain('break-all');
  });

  it('"Kirim e-mail uji" posts the address to system/config/email-test', async () => {
    const posted: unknown[] = [];
    startApp({
      me: superMe(),
      path: '/admin/system',
      routes: routes(view(), {
        'POST system/config/email-test': (req) => {
          posted.push(req.body);
          return { sent: true };
        },
      }),
    });
    const to = (await screen.findByLabelText('Kirim ke')) as HTMLInputElement;
    fireEvent.change(to, { target: { value: 'uji@perpus.example' } });
    fireEvent.click(screen.getByRole('button', { name: 'Kirim e-mail uji' }));
    await waitFor(() => expect(posted).toEqual([{ to: 'uji@perpus.example' }]));
    expect(await screen.findByText(/E-mail uji terkirim ke uji@perpus\.example/)).toBeTruthy();
  });

  it('a failed test mail says which SMTP stage failed', async () => {
    startApp({
      me: superMe(),
      path: '/admin/system',
      routes: routes(view(), { 'POST system/config/email-test': () => problem(502, 'SMTP_FAILED', { reason: 'auth' }) }),
    });
    fireEvent.change(await screen.findByLabelText('Kirim ke'), { target: { value: 'uji@perpus.example' } });
    fireEvent.click(screen.getByRole('button', { name: 'Kirim e-mail uji' }));
    expect(await screen.findByText(/menolak nama pengguna atau kata sandi/)).toBeTruthy();
  });

  it("a failed stage with its own message does not repeat the server's explanation of it", async () => {
    const detail = 'SMTP authentication failed for user mailer (535 5.7.8).';
    startApp({
      me: superMe(),
      path: '/admin/system',
      routes: routes(view(), { 'POST system/config/email-test': () => problem(502, 'SMTP_FAILED', { reason: 'auth', detail }) }),
    });
    fireEvent.change(await screen.findByLabelText('Kirim ke'), { target: { value: 'uji@perpus.example' } });
    fireEvent.click(screen.getByRole('button', { name: 'Kirim e-mail uji' }));
    expect(await screen.findByText(/menolak nama pengguna atau kata sandi/)).toBeTruthy();
    expect(screen.queryByText(detail)).toBeNull();
  });

  it('a problem without a stage message still shows the explanation the server wrote', async () => {
    const detail = 'Alamat ini sudah dipakai oleh instalasi lain.';
    startApp({
      me: superMe(),
      path: '/admin/system',
      routes: routes(view(), { 'POST system/config/email-test': () => problem(502, 'SMTP_FAILED', { reason: 'unknown_stage', detail }) }),
    });
    fireEvent.change(await screen.findByLabelText('Kirim ke'), { target: { value: 'uji@perpus.example' } });
    fireEvent.click(screen.getByRole('button', { name: 'Kirim e-mail uji' }));
    expect(await screen.findByText(detail)).toBeTruthy();
  });

  it('"Ganti token cron" asks first, then shows the new token once', async () => {
    const token = 'cron-token-baru-0123456789abcdef';
    const { writes } = startApp({
      me: superMe(),
      path: '/admin/system',
      routes: routes(view(), { 'POST system/cron-token/rotate': (): CronTokenRotateResponse => ({ cronToken: token }) }),
    });
    fireEvent.click(await screen.findByRole('button', { name: 'Ganti token cron' }));
    const confirm = await screen.findByRole('alertdialog', { name: 'Ganti token cron?' });
    expect(writes()).toEqual([]);
    fireEvent.click(within(confirm).getByRole('button', { name: 'Ganti token cron' }));
    const dialog = await screen.findByRole('dialog', { name: 'Token cron baru' });
    expect(within(dialog).getByText(token)).toBeTruthy();
    expect(writes()).toEqual(['POST system/cron-token/rotate']);
    fireEvent.click(within(dialog).getByRole('button', { name: 'Selesai' }));
    await waitFor(() => expect(screen.queryByRole('dialog', { name: 'Token cron baru' })).toBeNull());
    expect(document.body.textContent).not.toContain(token);
  });

  it('an admin (no system.config.manage) gets the refusal, not a form', async () => {
    startApp({ me: adminMe(), path: '/admin/system', routes: { 'GET system/config': () => problem(403, 'AUTHZ_DENIED') } });
    expect(await screen.findByText('Anda tidak memiliki izin untuk melakukan ini.')).toBeTruthy();
    expect(screen.queryByLabelText('Alamat situs (baseUrl)')).toBeNull();
  });
});

// The community edition binds nothing to the site address: a baseUrl on another host is saved at once, with no
// question and no read of a licence.
describe('system configuration: a new site address', () => {
  it('a baseUrl on another host → PUT system/config at once, no warning, no GET license', async () => {
    const puts: unknown[] = [];
    const { requests } = startApp({
      me: superMe(),
      path: '/admin/system',
      routes: routes(view(), {
        'PUT system/config': (req) => {
          puts.push(req.body);
          return answer(view({ baseUrl: (req.body as { baseUrl: string }).baseUrl }));
        },
      }),
    });
    const baseUrl = (await screen.findByLabelText('Alamat situs (baseUrl)')) as HTMLInputElement;
    await waitFor(() => expect(baseUrl.value).toBe('https://perpus.example'));
    fireEvent.change(baseUrl, { target: { value: 'https://perpustakaan.example.id' } });
    fireEvent.click(screen.getByRole('button', { name: 'Simpan' }));
    await waitFor(() => expect(puts).toEqual([{ baseUrl: 'https://perpustakaan.example.id' }]));
    expect(await screen.findByText('Perubahan disimpan.')).toBeTruthy();
    expect(screen.queryByRole('alertdialog')).toBeNull();
    expect(requests.some((r) => r.path.startsWith('license'))).toBe(false);
  });
});
