import type { MeResponse } from '@altis/shared/api/auth';
import { QueryClient, QueryClientProvider } from '@tanstack/react-query';
import { render, waitFor } from '@testing-library/react';
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import { csrfToken } from '@/lib/api';
import { gateTarget, useApiQuery, useMe } from '@/lib/me';

// Spec §4.8 / §7.1: `GET auth/me` is the SPA's first request after a page load and the other queries wait for it
// (remember-me restores the session on that request). Its csrfToken is the one the next write carries (D20).

type FullMe = Extract<MeResponse, { authenticated: true }>;

const FULL: FullMe = {
  authenticated: true,
  csrfToken: 'csrf-me',
  stage: 'full',
  mustChangePassword: false,
  user: { id: 'u1', username: 'ani', name: 'Ani', email: null, locale: null, totpEnabled: false, mfaRequired: false },
  permissions: ['system.users.read'],
  branchPermissions: {},
  superAdmin: false,
  reauthUntil: null,
  library: { name: 'Perpustakaan Arsya', locale: 'id' },
  build: '0.1.0',
  banners: [],
};

describe('gateTarget', () => {
  it('a full session may go anywhere', () => {
    expect(gateTarget(FULL, '/admin/users')).toBeNull();
  });

  it('signed out → the sign-in page, back to where the user was afterwards', () => {
    const out: MeResponse = { authenticated: false, csrfToken: 'x', library: FULL.library, build: '0.1.0' };
    expect(gateTarget(out, '/admin/users?q=a')).toBe(`/admin/login?next=${encodeURIComponent('/admin/users?q=a')}`);
    expect(gateTarget(out, '/admin')).toBe('/admin/login');
  });

  it('a pre-2FA session → its sign-in step', () => {
    expect(gateTarget({ ...FULL, stage: 'mfa' }, '/admin')).toBe('/admin/login/2fa');
    expect(gateTarget({ ...FULL, stage: 'mfa_setup' }, '/admin')).toBe('/admin/login/setup-2fa');
    expect(gateTarget({ ...FULL, stage: 'recovery' }, '/admin')).toBe('/admin/login/recovery');
  });

  it('a password that must change → the password page, and only there', () => {
    expect(gateTarget({ ...FULL, mustChangePassword: true }, '/admin/users')).toBe('/admin/profile/password');
    expect(gateTarget({ ...FULL, mustChangePassword: true }, '/admin/profile/password')).toBeNull();
  });
});

describe('meQuery and useApiQuery', () => {
  const fetchMock = vi.fn<typeof fetch>();

  beforeEach(() => {
    vi.stubGlobal('fetch', fetchMock);
  });

  afterEach(() => {
    fetchMock.mockReset();
    vi.unstubAllGlobals();
  });

  function Probe() {
    const me = useMe();
    const branches = useApiQuery<string[]>({ queryKey: ['branches'], path: 'branches' });
    return (
      <p>
        {me?.authenticated ? me.user.name : '-'} {branches.data?.join(',') ?? '-'}
      </p>
    );
  }

  it('auth/me is the first request; other queries start once it answered; its csrfToken is kept', async () => {
    let answerMe: (r: Response) => void = () => {};
    fetchMock.mockImplementation((url) => {
      if (url === '/api/v1/auth/me') return new Promise<Response>((resolve) => (answerMe = resolve));
      return Promise.resolve(new Response(JSON.stringify(['PST']), { status: 200, headers: { 'Content-Type': 'application/json' } }));
    });
    const client = new QueryClient({ defaultOptions: { queries: { retry: false } } });
    const view = render(
      <QueryClientProvider client={client}>
        <Probe />
      </QueryClientProvider>,
    );
    await Promise.resolve();
    expect(fetchMock.mock.calls.map((c) => c[0])).toEqual(['/api/v1/auth/me']);
    answerMe(new Response(JSON.stringify(FULL), { status: 200, headers: { 'Content-Type': 'application/json' } }));
    await waitFor(() => expect(view.container.textContent).toBe('Ani PST'));
    expect(fetchMock.mock.calls.map((c) => c[0])).toEqual(['/api/v1/auth/me', '/api/v1/branches']);
    expect(csrfToken()).toBe('csrf-me');
    client.clear();
  });
});
