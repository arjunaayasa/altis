import { permissionCatalog, systemRolePermissions, type Permission } from '@altis/shared';
import type { MeResponse } from '@altis/shared/api/auth';
import type { BranchItem } from '@altis/shared/api/branches';
import type { PermissionListResponse, RoleItem } from '@altis/shared/api/roles';
import type { SiteIdentityPublic } from '@altis/shared/api/site-identity';
import type { UserDetail } from '@altis/shared/api/users';
import { QueryClient, QueryClientProvider } from '@tanstack/react-query';
import { RouterProvider, createMemoryHistory } from '@tanstack/react-router';
import { render } from '@testing-library/react';
import { onTestFinished, vi } from 'vitest';
import { connectApiClient, createAppRouter } from '@/routes';

// A fake `/api/v1` for the screen tests: `fetch` is replaced by a table of `METHOD path` handlers (`:name` matches one
// path segment), so the screens run through the real API client (CSRF, problem+json, retries) and the real router.

export type SignedIn = Extract<MeResponse, { authenticated: true }>;

export function signedIn(o: { id?: string; permissions?: readonly Permission[]; superAdmin?: boolean } = {}): SignedIn {
  return {
    authenticated: true,
    csrfToken: 'csrf-1',
    stage: 'full',
    mustChangePassword: false,
    user: { id: o.id ?? 'U1', username: 'ani', name: 'Ani', email: null, locale: null, totpEnabled: false, mfaRequired: false },
    permissions: [...(o.permissions ?? systemRolePermissions('admin'))],
    branchPermissions: {},
    superAdmin: o.superAdmin ?? false,
    reauthUntil: null,
    library: { name: 'Perpustakaan Arsya', locale: 'id' },
    build: '0.1.0',
    banners: [],
  };
}

/** An `admin` (every permission but the four of ADMIN_EXCLUDED). */
export const adminMe = (): SignedIn => signedIn({ permissions: systemRolePermissions('admin') });

/** A `super_admin`. */
export const superMe = (): SignedIn => signedIn({ permissions: systemRolePermissions('super_admin'), superAdmin: true });

/** `GET site/identity/public` of a site that set nothing: the library's name, no logo, the built-in icon. */
export const publicIdentity = (name: string, o: Partial<SiteIdentityPublic> = {}): SiteIdentityPublic => ({
  name,
  tagline: { id: null, en: null },
  showNameBesideLogo: true,
  logo: null,
  logoDark: null,
  hasIcon: false,
  icon: { '32': '/site-icon/32.png', '180': '/site-icon/180.png', '192': '/site-icon/192.png' },
  ...o,
});

export interface FakeRequest {
  method: string;
  /** Relative to /api/v1, without the query. */
  path: string;
  params: Record<string, string>;
  query: URLSearchParams;
  body: unknown;
}

export type FakeHandler = (req: FakeRequest) => unknown;

export const json = (body: unknown, status = 200): Response =>
  new Response(JSON.stringify(body), { status, headers: { 'Content-Type': 'application/json', 'X-Altis-Build': '0.1.0' } });

export const problem = (status: number, code: string, extra: Record<string, unknown> = {}): Response =>
  new Response(JSON.stringify({ type: 'about:blank', title: code, status, code, ...extra }), {
    status,
    headers: { 'Content-Type': 'application/problem+json', 'X-Altis-Build': '0.1.0' },
  });

function match(pattern: string, path: string): Record<string, string> | null {
  const want = pattern.split('/');
  const got = path.split('/');
  if (want.length !== got.length) return null;
  const params: Record<string, string> = {};
  for (let i = 0; i < want.length; i++) {
    const w = want[i]!;
    const g = decodeURIComponent(got[i]!);
    if (w.startsWith(':')) params[w.slice(1)] = g;
    else if (w !== g) return null;
  }
  return params;
}

/**
 * Starts the SPA at `path` for `me`, answering `routes` (`'GET users/:id'` → handler). A handler returns a Response,
 * or a body answered as 200 JSON; an unknown route answers 404 NOT_FOUND. Every request lands in `requests`.
 */
export function startApp(o: { me: MeResponse; path: string; routes: Record<string, FakeHandler> }) {
  const requests: FakeRequest[] = [];
  const fetchMock = vi.fn<typeof fetch>(async (input, init) => {
    const url = new URL(String(input), 'https://altis.test');
    const method = init?.method ?? 'GET';
    const path = url.pathname.replace(/^\/api\/v1\//, '');
    const body = typeof init?.body === 'string' ? (JSON.parse(init.body) as unknown) : undefined;
    if (path === 'auth/me' && method === 'GET') return json(o.me);
    // The brand of the sidebar and the sign-in page: a site without a logo, unless the test answers it itself. It is
    // not kept in `requests`, so no test that counts its own requests sees it.
    if (path === 'site/identity/public' && method === 'GET' && o.routes['GET site/identity/public'] === undefined) return json(publicIdentity(o.me.library.name));
    for (const [key, handler] of Object.entries(o.routes)) {
      const [m, pattern] = key.split(' ') as [string, string];
      if (m !== method) continue;
      const params = match(pattern, path);
      if (params === null) continue;
      const req: FakeRequest = { method, path, params, query: url.searchParams, body };
      requests.push(req);
      const answer = await handler(req);
      return answer instanceof Response ? answer : answer === undefined ? new Response(null, { status: 204 }) : json(answer);
    }
    requests.push({ method, path, params: {}, query: url.searchParams, body });
    return problem(404, 'NOT_FOUND');
  });
  vi.stubGlobal('fetch', fetchMock);
  const queryClient = new QueryClient({ defaultOptions: { queries: { retry: false }, mutations: { retry: false } } });
  const router = createAppRouter({ queryClient, history: createMemoryHistory({ initialEntries: [o.path] }) });
  onTestFinished(connectApiClient(router, queryClient));
  render(
    <QueryClientProvider client={queryClient}>
      <RouterProvider router={router} />
    </QueryClientProvider>,
  );
  /** The requests other than `GET`, as `METHOD path`. */
  const writes = (): string[] => requests.filter((r) => r.method !== 'GET').map((r) => `${r.method} ${r.path}`);
  return { router, queryClient, requests, writes, fetchMock };
}

// ---- fixtures ------------------------------------------------------------------------------------------------------

export const ROLE_SUPER: RoleItem = {
  id: 'R0SUPER',
  key: 'super_admin',
  name: 'Super Admin',
  description: null,
  isSystem: true,
  mfaRequired: false,
  permissions: [...systemRolePermissions('super_admin')],
  holders: 1,
  version: 1,
};

export const ROLE_ADMIN: RoleItem = {
  id: 'R0ADMIN',
  key: 'admin',
  name: 'Admin',
  description: null,
  isSystem: true,
  mfaRequired: false,
  permissions: [...systemRolePermissions('admin')],
  holders: 2,
  version: 1,
};

export const ROLE_LIBRARIAN: RoleItem = {
  id: 'R1PUST',
  key: 'PUSTAKAWAN',
  name: 'Pustakawan',
  description: 'Melihat data pengguna',
  isSystem: false,
  mfaRequired: false,
  permissions: ['system.users.read'],
  holders: 1,
  version: 4,
};

export const ROLE_UPDATER: RoleItem = {
  id: 'R2UPD',
  key: 'OPERATOR PEMBARUAN',
  name: 'Operator Pembaruan',
  description: null,
  isSystem: false,
  mfaRequired: true,
  permissions: ['system.update.read', 'system.update.run'],
  holders: 0,
  version: 1,
};

/** A role whose only permission is branch-scoped (the test profile's `test.branch.manage`). */
export const ROLE_BRANCH: RoleItem = {
  id: 'R3CAB',
  key: 'PETUGAS CABANG',
  name: 'Petugas Cabang',
  description: null,
  isSystem: false,
  mfaRequired: false,
  permissions: ['test.branch.manage'],
  holders: 0,
  version: 1,
};

export const ROLES: RoleItem[] = [ROLE_SUPER, ROLE_ADMIN, ROLE_UPDATER, ROLE_BRANCH, ROLE_LIBRARIAN];

export const BRANCH_MAIN: BranchItem = {
  id: 'B1',
  code: 'PUSAT',
  name: 'Perpustakaan Pusat',
  address: 'Jl. Merdeka 1',
  timezone: 'Asia/Jakarta',
  isDefault: true,
  archivedAt: null,
  version: 1,
};

export const BRANCH_NORTH: BranchItem = {
  id: 'B2',
  code: 'UTARA',
  name: 'Cabang Utara',
  address: null,
  timezone: 'Asia/Jakarta',
  isDefault: false,
  archivedAt: null,
  version: 2,
};

export const BRANCH_OLD: BranchItem = {
  id: 'B3',
  code: 'LAMA',
  name: 'Cabang Lama',
  address: null,
  timezone: 'Asia/Makassar',
  isDefault: false,
  archivedAt: 1_700_000_000_000,
  version: 5,
};

/** `GET permissions` as the server answers it (the build profile's catalog). */
export const permissionsAnswer = (): PermissionListResponse => ({
  items: permissionCatalog().map(({ key, scope, module }) => ({ key, scope, module })),
});

function userDetail(o: Partial<UserDetail> & Pick<UserDetail, 'id' | 'username' | 'name'>): UserDetail {
  return {
    email: null,
    status: 'active',
    totpEnabled: false,
    mfaRequired: false,
    lastLoginAt: null,
    roles: [],
    locale: null,
    mustChangePassword: false,
    version: 1,
    createdAt: 1_700_000_000_000,
    updatedAt: 1_700_000_000_000,
    ...o,
  };
}

/** The signed-in user of signedIn() (id U1), an admin. */
export const USER_ANI = userDetail({
  id: 'U1',
  username: 'ani',
  name: 'Ani',
  email: 'ani@perpus.example',
  totpEnabled: true,
  lastLoginAt: 1_760_000_000_000,
  roles: [{ roleId: ROLE_ADMIN.id, key: 'admin', name: 'Admin', branchId: null }],
  version: 3,
});

export const USER_BUDI = userDetail({
  id: 'U2',
  username: 'budi',
  name: 'Budi Santoso',
  totpEnabled: true,
  roles: [{ roleId: ROLE_LIBRARIAN.id, key: ROLE_LIBRARIAN.key, name: ROLE_LIBRARIAN.name, branchId: null }],
  version: 7,
});

export const USER_CITRA = userDetail({ id: 'U3', username: 'citra', name: 'Citra', status: 'disabled' });

export const USERS: UserDetail[] = [USER_ANI, USER_BUDI, USER_CITRA];
