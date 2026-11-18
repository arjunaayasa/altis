import { systemRolePermissions } from '@altis/shared';
import type { MeResponse } from '@altis/shared/api/auth';
import { QueryClient, QueryClientProvider } from '@tanstack/react-query';
import { RouterProvider, createMemoryHistory } from '@tanstack/react-router';
import { act, render, screen } from '@testing-library/react';
import { afterEach, beforeEach, describe, expect, it, onTestFinished, vi } from 'vitest';
import { connectApiClient, createAppRouter } from '@/routes';

// A password that must change first leaves the user one page (/admin/profile/password), and the server refuses every
// other request until it has changed (403). The frame around that page reads nothing the stage does not allow: no
// realtime client (stream or polling) and no notification count, so the page does not collect refusals while it waits.

type SignedIn = Extract<MeResponse, { authenticated: true }>;

function signedIn(mustChangePassword: boolean): SignedIn {
  return {
    authenticated: true,
    csrfToken: 'csrf-1',
    stage: 'full',
    mustChangePassword,
    user: { id: 'u1', username: 'ani', name: 'Ani', email: null, locale: null, totpEnabled: false, mfaRequired: false },
    permissions: [...systemRolePermissions('admin')],
    branchPermissions: {},
    superAdmin: false,
    reauthUntil: null,
    library: { name: 'Perpustakaan Uji', locale: 'id' },
    build: '0.1.0',
    banners: [],
  };
}

const json = (body: unknown, status = 200): Response =>
  new Response(JSON.stringify(body), { status, headers: { 'Content-Type': 'application/json', 'X-Altis-Build': '0.1.0' } });

const refused = (): Response =>
  new Response(JSON.stringify({ type: 'about:blank', title: 'Forbidden', status: 403, code: 'AUTH_PASSWORD_CHANGE_REQUIRED' }), {
    status: 403,
    headers: { 'Content-Type': 'application/problem+json', 'X-Altis-Build': '0.1.0' },
  });

const fetchMock = vi.fn<typeof fetch>();

function setup(me: MeResponse, path: string) {
  fetchMock.mockImplementation(async (url, init) => {
    if (url === '/api/v1/auth/me' && (init?.method ?? 'GET') === 'GET') return json(me);
    if (String(url).startsWith('/api/v1/notifications')) return me.authenticated && !me.mustChangePassword ? json({ items: [], unread: 0, nextBefore: null }) : refused();
    if (String(url).startsWith('/api/v1/events')) return me.authenticated && !me.mustChangePassword ? json({ events: [], cursor: 'c1' }) : refused();
    return refused();
  });
  const queryClient = new QueryClient({ defaultOptions: { queries: { retry: false } } });
  const router = createAppRouter({ queryClient, history: createMemoryHistory({ initialEntries: [path] }) });
  onTestFinished(connectApiClient(router, queryClient));
  render(
    <QueryClientProvider client={queryClient}>
      <RouterProvider router={router} />
    </QueryClientProvider>,
  );
}

const paths = (): string[] => fetchMock.mock.calls.map((c) => String(c[0]).split('?', 1)[0]!);

beforeEach(() => {
  vi.stubGlobal('fetch', fetchMock);
  sessionStorage.clear();
});

afterEach(() => {
  fetchMock.mockReset();
  vi.unstubAllGlobals();
  vi.restoreAllMocks();
});

describe('a password that must change first', () => {
  it('the frame reads neither events nor notifications while the password page waits', async () => {
    setup(signedIn(true), '/admin/profile/password');
    expect(await screen.findByLabelText('Kata sandi saat ini')).toBeTruthy();
    await act(() => new Promise((resolve) => setTimeout(resolve, 300)));
    // The sidebar's brand is the public site identity, which any visitor may read: it is no session-bound request.
    expect(paths().filter((p) => p !== '/api/v1/auth/me' && p !== '/api/v1/site/identity/public')).toEqual([]);
    expect(screen.queryByRole('button', { name: /^Notifikasi/ })).toBeNull();
  });

  it('a full session still reads both', async () => {
    setup(signedIn(false), '/admin/profile/password');
    expect(await screen.findByLabelText('Kata sandi saat ini')).toBeTruthy();
    await act(() => new Promise((resolve) => setTimeout(resolve, 300)));
    expect(paths()).toContain('/api/v1/notifications');
    expect(paths()).toContain('/api/v1/events');
    expect(screen.getByRole('button', { name: /^Notifikasi/ })).toBeTruthy();
  });
});
