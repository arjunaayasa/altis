import { systemRolePermissions } from '@altis/shared';
import type { MeResponse, MeUser } from '@altis/shared/api/auth';
import { QueryClient, QueryClientProvider } from '@tanstack/react-query';
import { RouterProvider, createBrowserHistory, createMemoryHistory, type RouterHistory } from '@tanstack/react-router';
import { render, type RenderResult } from '@testing-library/react';
import { onTestFinished, type Mock } from 'vitest';
import { connectApiClient, createAppRouter } from '@/routes';

// The fake server of the screen tests (Task 28): `fetch` answers from a table of `METHOD path` handlers (path
// relative to /api/v1), records every call with its parsed body, and answers 404 NOT_FOUND for anything else. The app
// is rendered the way main.tsx does it, with the API client's navigation pointed at the router.

export type SignedIn = Extract<MeResponse, { authenticated: true }>;

export const LIBRARY = { name: 'Perpustakaan Arsya', locale: 'id' } as const;

export const ANON: MeResponse = { authenticated: false, csrfToken: 'csrf-pre', library: LIBRARY, build: '0.1.0' };

/** A fully signed-in admin, changed by `o` (and `o.user`). */
export function signedIn(o: Partial<Omit<SignedIn, 'user'>> & { user?: Partial<MeUser> } = {}): SignedIn {
  const { user, ...rest } = o;
  return {
    authenticated: true,
    csrfToken: 'csrf-1',
    stage: 'full',
    mustChangePassword: false,
    permissions: [...systemRolePermissions('admin')],
    branchPermissions: {},
    superAdmin: false,
    reauthUntil: null,
    library: LIBRARY,
    build: '0.1.0',
    banners: [],
    ...rest,
    user: { id: 'u1', username: 'ani', name: 'Ani', email: 'ani@perpus.example', locale: null, totpEnabled: false, mfaRequired: false, ...user },
  };
}

/** A pre-2FA session in `stage`: no permissions (M10). */
export function partial(stage: 'mfa' | 'mfa_setup' | 'recovery', user: Partial<MeUser> = {}): SignedIn {
  return signedIn({ stage, permissions: [], user: { totpEnabled: stage !== 'mfa_setup', ...user } });
}

export function json(body: unknown, status = 200, headers: Record<string, string> = {}): Response {
  return new Response(body === undefined ? null : JSON.stringify(body), {
    status,
    headers: { 'Content-Type': 'application/json', 'X-Altis-Build': '0.1.0', ...headers },
  });
}

export function problem(
  status: number,
  code: string,
  o: { errors?: { path: string; code: string }[]; reason?: string; headers?: Record<string, string> } = {},
): Response {
  const body = { type: 'about:blank', title: code, status, code, ...(o.errors ? { errors: o.errors } : {}), ...(o.reason ? { reason: o.reason } : {}) };
  return new Response(JSON.stringify(body), {
    status,
    headers: { 'Content-Type': 'application/problem+json', 'X-Altis-Build': '0.1.0', ...o.headers },
  });
}

export type Handler = (body: unknown) => Response | Promise<Response>;

export interface Call {
  method: string;
  path: string;
  body: unknown;
  /** Vitest's global call order (comparable with a spy's `invocationCallOrder`). */
  order: number;
}

export interface FakeServer {
  /** Sets (or replaces) the answer to `METHOD path`, e.g. `on('POST auth/login', ...)`. */
  on(route: string, handler: Handler): void;
  /** Every request so far, oldest first. */
  calls: Call[];
  /** The calls to `METHOD path`. */
  callsTo(route: string): Call[];
}

/** Points `fetchMock` at a table of handlers. `GET auth/me` answers `me()` unless replaced. */
export function fakeServer(fetchMock: Mock<typeof fetch>, me: () => MeResponse, routes: Record<string, Handler> = {}): FakeServer {
  const table = new Map<string, Handler>([['GET auth/me', () => json(me())], ...Object.entries(routes)]);
  const calls: Call[] = [];
  fetchMock.mockImplementation(async (input, init) => {
    const method = init?.method ?? 'GET';
    const path = String(input).replace(/^\/api\/v1\//, '');
    const body = typeof init?.body === 'string' ? (JSON.parse(init.body) as unknown) : undefined;
    const n = fetchMock.mock.calls.length - 1;
    calls.push({ method, path, body, order: fetchMock.mock.invocationCallOrder[n] ?? 0 });
    const handler = table.get(`${method} ${path}`);
    return handler === undefined ? problem(404, 'NOT_FOUND') : handler(body);
  });
  return {
    on: (route, handler) => void table.set(route, handler),
    calls,
    callsTo: (route) => calls.filter((c) => `${c.method} ${c.path}` === route),
  };
}

/**
 * Renders the app at `href` in the browser's own history, as production runs it (main.tsx's router has no `history`
 * option): the address bar moves with every navigation, before a route's `beforeLoad` runs. The address is set first
 * (an in-app address, not a page load: the bundle's modules were loaded at whatever address the test file started
 * with), and put back to `/` when the test ends.
 */
export function renderInBrowser(href: string): ReturnType<typeof renderApp> {
  window.history.replaceState(null, '', href);
  const history = createBrowserHistory();
  onTestFinished(() => {
    history.destroy();
    window.history.replaceState(null, '', '/');
  });
  return renderApp(href, { history });
}

/** Renders the app at `path` (memory history unless `history` is given), as main.tsx wires it. */
export function renderApp(
  path: string,
  o: { history?: RouterHistory } = {},
): { router: ReturnType<typeof createAppRouter>; queryClient: QueryClient; view: RenderResult } {
  const queryClient = new QueryClient({ defaultOptions: { queries: { retry: false }, mutations: { retry: false } } });
  const router = createAppRouter({ queryClient, history: o.history ?? createMemoryHistory({ initialEntries: [path] }) });
  onTestFinished(connectApiClient(router, queryClient));
  const view = render(
    <QueryClientProvider client={queryClient}>
      <RouterProvider router={router} />
    </QueryClientProvider>,
  );
  return { router, queryClient, view };
}
