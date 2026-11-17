import type { UserDetail, UserListResponse } from '@altis/shared/api/users';
import { act, fireEvent, renderHook, screen, waitFor, within } from '@testing-library/react';
import { useForm } from 'react-hook-form';
import { afterEach, describe, expect, it, vi } from 'vitest';
import { ApiError } from '@/lib/api';
import { applyServerErrors } from '@/lib/form-errors';
import {
  BRANCH_MAIN,
  BRANCH_NORTH,
  ROLES,
  ROLE_ADMIN,
  ROLE_BRANCH,
  USERS,
  USER_ANI,
  USER_BUDI,
  adminMe,
  permissionsAnswer,
  problem,
  signedIn,
  startApp,
  superMe,
  type FakeHandler,
  type SignedIn,
} from './fake-api';

// Spec §13.3 "Pengguna staf" (Task 29): the list (search, status, paging, row actions by permission), create and
// edit forms, the temporary password shown once, and role assignment by scope. The server is faked (fake-api.tsx).

afterEach(() => {
  vi.unstubAllGlobals();
  vi.restoreAllMocks();
});

function usersRoutes(o: { users?: UserDetail[]; total?: number; extra?: Record<string, FakeHandler> } = {}): Record<string, FakeHandler> {
  const users = o.users ?? USERS;
  return {
    'GET users': (req): UserListResponse => {
      const q = (req.query.get('q') ?? '').toLowerCase();
      const status = req.query.get('status');
      const items = users.filter((u) => (q === '' || u.username.includes(q) || u.name.toLowerCase().includes(q)) && (status === null || u.status === status));
      return { items, total: o.total ?? items.length, page: Number(req.query.get('page') ?? 1), pageSize: Number(req.query.get('pageSize') ?? 25) };
    },
    'GET users/:id': (req) => users.find((u) => u.id === req.params['id']) ?? problem(404, 'NOT_FOUND'),
    'GET roles': () => ({ items: ROLES }),
    'GET branches': () => ({ items: [BRANCH_MAIN, BRANCH_NORTH] }),
    'GET permissions': () => permissionsAnswer(),
    ...o.extra,
  };
}

const rowOf = (text: string): HTMLElement => screen.getByRole('link', { name: text }).closest('tr')!;

/** Opens the ⋯ menu of a row and answers the names of its actions. */
async function rowMenu(text: string): Promise<string[]> {
  const trigger = within(rowOf(text)).getByRole('button', { name: /^Tindakan untuk / });
  trigger.focus();
  fireEvent.keyDown(trigger, { key: 'Enter' });
  await screen.findByRole('menu');
  return screen.getAllByRole('menuitem').map((i) => i.textContent ?? '');
}

/** Chooses an action of the open row menu. */
function choose(name: string): void {
  fireEvent.click(screen.getByRole('menuitem', { name }));
}

describe('users list', () => {
  it('with only system.users.read the table renders and no row actions show', async () => {
    startApp({ me: signedIn({ permissions: ['system.users.read'] }), path: '/admin/users', routes: usersRoutes() });
    await screen.findByRole('link', { name: 'budi' });
    const table = screen.getByRole('table');
    expect(within(table).getAllByRole('row')).toHaveLength(1 + USERS.length);
    expect(within(table).getByText('Budi Santoso')).toBeTruthy();
    expect(within(table).queryByRole('button')).toBeNull();
    expect(within(table).queryByRole('columnheader', { name: 'Tindakan' })).toBeNull();
    expect(screen.queryByRole('link', { name: 'Tambah pengguna' })).toBeNull();
  });

  it('with system.users.manage each row offers its actions in its ⋯ menu, but not on the signed-in user', async () => {
    startApp({ me: adminMe(), path: '/admin/users', routes: usersRoutes() });
    await screen.findByRole('link', { name: 'budi' });
    expect(within(screen.getByRole('table')).getByRole('columnheader', { name: 'Tindakan' })).toBeTruthy();
    expect(await rowMenu('budi')).toEqual(['Atur ulang kata sandi', 'Atur ulang 2FA', 'Nonaktifkan']);
    fireEvent.keyDown(screen.getByRole('menu'), { key: 'Escape' });
    await waitFor(() => expect(screen.queryByRole('menu')).toBeNull());
    // Citra is disabled and has no 2FA to reset.
    expect(await rowMenu('citra')).toEqual(['Aktifkan', 'Atur ulang kata sandi']);
    fireEvent.keyDown(screen.getByRole('menu'), { key: 'Escape' });
    await waitFor(() => expect(screen.queryByRole('menu')).toBeNull());
    expect(within(rowOf('ani')).queryByRole('button')).toBeNull();
    expect(screen.getByRole('link', { name: 'Tambah pengguna' }).getAttribute('href')).toBe('/admin/users/new');
  });

  it('search and the status filter go to the server; paging asks for the next page', async () => {
    const { requests } = startApp({ me: adminMe(), path: '/admin/users', routes: usersRoutes({ total: 60 }) });
    await screen.findByRole('link', { name: 'budi' });
    expect(screen.getByText('Halaman 1 dari 3 · 60 pengguna')).toBeTruthy();
    fireEvent.click(screen.getByRole('button', { name: 'Berikutnya' }));
    await waitFor(() => expect(requests.at(-1)?.query.get('page')).toBe('2'));

    fireEvent.change(screen.getByRole('searchbox', { name: 'Cari pengguna' }), { target: { value: 'bud' } });
    fireEvent.click(screen.getByRole('button', { name: 'Cari' }));
    await waitFor(() => expect(requests.at(-1)?.query.get('q')).toBe('bud'));
    expect(requests.at(-1)?.query.get('page')).toBe('1');

    fireEvent.change(screen.getByRole('combobox', { name: 'Status' }), { target: { value: 'disabled' } });
    await waitFor(() => expect(requests.at(-1)?.query.get('status')).toBe('disabled'));
  });

  it('disabling asks first, then POSTs users/:id/disable', async () => {
    const { writes } = startApp({
      me: adminMe(),
      path: '/admin/users',
      routes: usersRoutes({ extra: { 'POST users/:id/disable': () => ({ ...USER_BUDI, status: 'disabled' }) } }),
    });
    await screen.findByRole('link', { name: 'budi' });
    await rowMenu('budi');
    choose('Nonaktifkan');
    const dialog = await screen.findByRole('alertdialog', { name: 'Nonaktifkan Budi Santoso?' });
    expect(writes()).toEqual([]);
    fireEvent.click(within(dialog).getByRole('button', { name: 'Nonaktifkan' }));
    await waitFor(() => expect(writes()).toEqual(['POST users/U2/disable']));
    expect(await screen.findByText('Budi Santoso dinonaktifkan.')).toBeTruthy();
  });
});

describe('temporary password', () => {
  const SECRET = 'Sementara-7Kq2-xY9p';

  it('a reset shows the temporary password once; closing the dialog forgets it', async () => {
    const { writes, queryClient } = startApp({
      me: adminMe(),
      path: '/admin/users',
      routes: usersRoutes({ extra: { 'POST users/:id/reset-password': () => ({ temporaryPassword: SECRET }) } }),
    });
    await screen.findByRole('link', { name: 'budi' });
    await rowMenu('budi');
    choose('Atur ulang kata sandi');
    const confirm = await screen.findByRole('alertdialog', { name: 'Atur ulang kata sandi Budi Santoso?' });
    fireEvent.click(within(confirm).getByRole('button', { name: 'Atur ulang kata sandi' }));

    const dialog = await screen.findByRole('dialog', { name: 'Kata sandi sementara' });
    expect(within(dialog).getByText(SECRET)).toBeTruthy();
    expect(writes()).toEqual(['POST users/U2/reset-password']);

    fireEvent.click(within(dialog).getByRole('button', { name: 'Selesai' }));
    await waitFor(() => expect(screen.queryByRole('dialog')).toBeNull());
    expect(document.body.textContent).not.toContain(SECRET);
    for (const input of document.querySelectorAll('input')) expect(input.value).not.toBe(SECRET);
    const cached = JSON.stringify([
      queryClient.getQueryCache().getAll().map((q) => q.state.data),
      queryClient.getMutationCache().getAll().map((m) => m.state.data),
    ]);
    expect(cached).not.toContain(SECRET);
  });
});

describe('create', () => {
  it('checks the fields first; a taken username appears under the field', async () => {
    const posted: unknown[] = [];
    startApp({
      me: adminMe(),
      path: '/admin/users/new',
      routes: usersRoutes({
        extra: {
          'POST users': (req) => {
            posted.push(req.body);
            return problem(422, 'VALIDATION_FAILED', { errors: [{ path: 'username', code: 'taken' }] });
          },
        },
      }),
    });
    const username = await screen.findByLabelText('Nama pengguna');
    fireEvent.click(screen.getByRole('button', { name: 'Simpan' }));
    await waitFor(() => expect(username.getAttribute('aria-invalid')).toBe('true'));
    expect(posted).toEqual([]);

    fireEvent.change(username, { target: { value: 'budi' } });
    fireEvent.change(screen.getByLabelText('Nama lengkap'), { target: { value: 'Budi Lain' } });
    fireEvent.change(screen.getByLabelText('Kata sandi awal'), { target: { value: 'kata-sandi-baru-123' } });
    fireEvent.click(screen.getByRole('button', { name: 'Simpan' }));
    await waitFor(() => expect(posted).toHaveLength(1));
    expect(posted[0]).toEqual({
      username: 'budi',
      name: 'Budi Lain',
      email: null,
      password: 'kata-sandi-baru-123',
      locale: null,
      mfaRequired: false,
      mustChangePassword: true,
    });
    await waitFor(() => {
      const described = (username.getAttribute('aria-describedby') ?? '').split(' ').map((id) => document.getElementById(id)?.textContent);
      expect(described).toContain('Sudah dipakai. Gunakan yang lain.');
    });
    expect(username.getAttribute('aria-invalid')).toBe('true');
  });

  it('a created user opens on their own page, ready for roles', async () => {
    const created = { ...USER_BUDI, id: 'U9', username: 'dewi', name: 'Dewi', roles: [] };
    const { router } = startApp({
      me: adminMe(),
      path: '/admin/users/new',
      routes: usersRoutes({ users: [...USERS, created], extra: { 'POST users': () => new Response(JSON.stringify(created), { status: 201, headers: { 'Content-Type': 'application/json' } }) } }),
    });
    fireEvent.change(await screen.findByLabelText('Nama pengguna'), { target: { value: 'dewi' } });
    fireEvent.change(screen.getByLabelText('Nama lengkap'), { target: { value: 'Dewi' } });
    fireEvent.change(screen.getByLabelText('Kata sandi awal'), { target: { value: 'kata-sandi-baru-123' } });
    fireEvent.click(screen.getByRole('button', { name: 'Simpan' }));
    await waitFor(() => expect(router.state.location.pathname).toBe('/admin/users/U9'));
    expect(await screen.findByText('Pengguna dibuat. Sekarang tetapkan perannya.')).toBeTruthy();
  });

  it('an existing user opened from the list says nothing about being created', async () => {
    startApp({ me: adminMe(), path: '/admin/users/U2', routes: usersRoutes() });
    await screen.findByRole('heading', { name: 'Budi Santoso' });
    expect(screen.queryByText('Pengguna dibuat. Sekarang tetapkan perannya.')).toBeNull();
  });
});

describe('edit', () => {
  function patchRoutes(patched: unknown[]) {
    return usersRoutes({
      extra: {
        'PATCH users/:id': (req) => {
          patched.push(req.body);
          const user = USERS.find((u) => u.id === req.params['id'])!;
          return { ...user, ...(req.body as object), version: user.version + 1 };
        },
      },
    });
  }

  it('editing oneself leaves mfaRequired out of the PATCH', async () => {
    const patched: unknown[] = [];
    startApp({ me: adminMe(), path: '/admin/users/U1', routes: patchRoutes(patched) });
    const name = await screen.findByLabelText('Nama lengkap');
    await waitFor(() => expect((name as HTMLInputElement).value).toBe('Ani'));
    // The requirement is shown on one's own page, but cannot be changed there (D24).
    const mfa = screen.queryByRole('checkbox', { name: 'Wajib verifikasi dua langkah (2FA)' });
    expect(mfa).not.toBeNull();
    expect(mfa!.matches(':disabled')).toBe(true);
    fireEvent.change(name, { target: { value: 'Ani Lestari' } });
    fireEvent.click(screen.getByRole('button', { name: 'Simpan' }));
    await waitFor(() => expect(patched).toHaveLength(1));
    expect(patched[0]).toEqual({ version: USER_ANI.version, name: 'Ani Lestari' });
    expect(await screen.findByText('Perubahan disimpan.')).toBeTruthy();
  });

  it("editing someone else sends the changed fields and the version, mfaRequired included", async () => {
    const patched: unknown[] = [];
    startApp({ me: adminMe(), path: '/admin/users/U2', routes: patchRoutes(patched) });
    const mfa = await screen.findByRole('checkbox', { name: 'Wajib verifikasi dua langkah (2FA)' });
    expect((mfa as HTMLInputElement).disabled).toBe(false);
    fireEvent.click(mfa);
    fireEvent.click(screen.getByRole('button', { name: 'Simpan' }));
    await waitFor(() => expect(patched).toHaveLength(1));
    expect(patched[0]).toEqual({ version: USER_BUDI.version, mfaRequired: true });
  });

  it('CONFLICT_STALE says so and offers to reload the data', async () => {
    startApp({
      me: adminMe(),
      path: '/admin/users/U2',
      routes: usersRoutes({ extra: { 'PATCH users/:id': () => problem(409, 'CONFLICT_STALE') } }),
    });
    const name = await screen.findByLabelText('Nama lengkap');
    await waitFor(() => expect((name as HTMLInputElement).value).toBe('Budi Santoso'));
    fireEvent.change(name, { target: { value: 'Budi S.' } });
    fireEvent.click(screen.getByRole('button', { name: 'Simpan' }));
    expect(await screen.findByText('Data ini sudah diubah oleh orang lain. Muat ulang, lalu coba lagi.')).toBeTruthy();
    expect(screen.getByRole('button', { name: 'Muat ulang data' })).toBeTruthy();
  });
});

describe('role assignment', () => {
  const roleOptions = (): string[] =>
    within(screen.getByRole('combobox', { name: 'Peran' }))
      .getAllByRole('option')
      .map((o) => o.textContent ?? '');

  async function openBudi(me: SignedIn, user: UserDetail = USER_BUDI, extra: Record<string, FakeHandler> = {}) {
    const app = startApp({ me, path: `/admin/users/${user.id}`, routes: usersRoutes({ users: [USER_ANI, user], extra }) });
    await screen.findByRole('heading', { name: 'Peran' });
    await waitFor(() => expect(roleOptions().length).toBeGreaterThan(1));
    return app;
  }

  it('an admin is offered neither the admin nor the super admin role, nor a role with a super-admin-only permission', async () => {
    await openBudi(adminMe());
    expect(roleOptions()).toEqual(['Pilih peran…', 'Petugas Cabang', 'Pustakawan']);
  });

  it('a super admin is offered every role', async () => {
    await openBudi(superMe());
    expect(roleOptions()).toEqual(['Pilih peran…', 'Super Admin', 'Admin', 'Operator Pembaruan', 'Petugas Cabang', 'Pustakawan']);
  });

  it('an assignment of the admin role cannot be removed by an admin, but by a super admin', async () => {
    const withAdmin: UserDetail = { ...USER_BUDI, roles: [{ roleId: ROLE_ADMIN.id, key: 'admin', name: 'Admin', branchId: null }] };
    await openBudi(adminMe(), withAdmin);
    expect(screen.queryByRole('button', { name: 'Lepas Admin (Global)' })).toBeNull();
    expect(screen.getByText('Hanya Super Admin yang dapat memberikan atau mencabut peran ini.')).toBeTruthy();
  });

  it('a super admin may remove the admin role', async () => {
    const withAdmin: UserDetail = { ...USER_BUDI, roles: [{ roleId: ROLE_ADMIN.id, key: 'admin', name: 'Admin', branchId: null }] };
    await openBudi(superMe(), withAdmin);
    expect(screen.getByRole('button', { name: 'Lepas Admin (Global)' })).toBeTruthy();
  });

  it('pairs a role with a scope (global, or a branch from GET branches) and PUTs the whole list', async () => {
    const put: unknown[] = [];
    const { requests } = await openBudi(adminMe(), USER_BUDI, {
      'PUT users/:id/roles': (req) => {
        put.push(req.body);
        return USER_BUDI;
      },
    });
    expect(requests.some((r) => r.method === 'GET' && r.path === 'branches')).toBe(true);
    const scope = screen.getByRole('combobox', { name: 'Cakupan' });

    // A role with a global permission can only be assigned globally.
    fireEvent.change(screen.getByRole('combobox', { name: 'Peran' }), { target: { value: 'R1PUST' } });
    const north = within(scope).getByRole('option', { name: 'Cabang Utara' }) as HTMLOptionElement;
    expect(north.disabled).toBe(true);
    expect(screen.getByText('Peran ini berisi izin global, jadi hanya bisa ditugaskan secara global.')).toBeTruthy();

    fireEvent.change(screen.getByRole('combobox', { name: 'Peran' }), { target: { value: 'R3CAB' } });
    expect(north.disabled).toBe(false);
    fireEvent.change(scope, { target: { value: 'B2' } });
    fireEvent.click(screen.getByRole('button', { name: 'Tambahkan' }));
    expect(screen.getByRole('button', { name: 'Lepas Petugas Cabang (Cabang Utara)' })).toBeTruthy();

    fireEvent.click(screen.getByRole('button', { name: 'Simpan peran' }));
    await waitFor(() => expect(put).toHaveLength(1));
    expect(put[0]).toEqual({
      assignments: [
        { roleId: 'R1PUST', branchId: null },
        { roleId: 'R3CAB', branchId: 'B2' },
      ],
    });
    expect(await screen.findByText('Peran disimpan.')).toBeTruthy();
  });

  it('a branch scope with a long name wraps inside its badge (no sideways scrolling on a 375 px phone)', async () => {
    const long = { ...BRANCH_NORTH, id: 'B9', name: 'Perpustakaan Daerah Kabupaten Banyuwangi Cabang Genteng' };
    const scoped: UserDetail = { ...USER_BUDI, roles: [{ roleId: ROLE_BRANCH.id, key: ROLE_BRANCH.key, name: ROLE_BRANCH.name, branchId: long.id }] };
    startApp({
      me: adminMe(),
      path: `/admin/users/${scoped.id}`,
      routes: usersRoutes({ users: [USER_ANI, scoped], extra: { 'GET branches': () => ({ items: [BRANCH_MAIN, long] }) } }),
    });
    // The badge, not the option of the scope select.
    const badge = await screen.findByText(long.name, { selector: 'span' });
    const classes = badge.className.split(' ');
    expect(classes).toContain('whitespace-normal');
    expect(classes).not.toContain('whitespace-nowrap');
  });

  it("one's own roles are read-only (rule 4)", async () => {
    startApp({ me: adminMe(), path: '/admin/users/U1', routes: usersRoutes() });
    expect(await screen.findByText('Anda tidak dapat mengubah peran Anda sendiri.')).toBeTruthy();
    expect(screen.queryByRole('button', { name: 'Tambahkan' })).toBeNull();
    expect(screen.queryByRole('button', { name: 'Simpan peran' })).toBeNull();
  });
});

describe('applyServerErrors', () => {
  it('maps VALIDATION_FAILED paths to fields with form.error.<code>', () => {
    const { result } = renderHook(() => useForm<{ username: string; assignments: { roleId: string }[] }>());
    act(() =>
      applyServerErrors(
        result.current,
        new ApiError(422, 'VALIDATION_FAILED', {
          errors: [
            { path: 'username', code: 'taken' },
            { path: 'assignments.0.roleId', code: 'not_found' },
          ],
        }),
      ),
    );
    expect(result.current.getFieldState('username').error).toMatchObject({ type: 'taken', message: 'form.error.taken' });
    expect(result.current.getFieldState('assignments.0.roleId').error).toMatchObject({ message: 'form.error.not_found' });
  });

  it('ignores other problems', () => {
    const { result } = renderHook(() => useForm<{ username: string }>());
    act(() => applyServerErrors(result.current, new ApiError(409, 'CONFLICT_STALE')));
    expect(result.current.getFieldState('username').error).toBeUndefined();
  });
});
