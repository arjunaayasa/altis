import { fireEvent, screen, waitFor, within } from '@testing-library/react';
import { afterEach, describe, expect, it, vi } from 'vitest';
import {
  ROLES,
  ROLE_ADMIN,
  ROLE_LIBRARIAN,
  adminMe,
  permissionsAnswer,
  problem,
  signedIn,
  startApp,
  superMe,
  type FakeHandler,
} from './fake-api';

// Spec §13.3 "Peran" and §7.2 (Task 29): the list marks the system roles, the editor groups the permissions by module
// with their perm.* labels, a permission the signed-in user cannot grant is disabled with a hint, and a system role is
// read-only but for its 2FA switch, which only a super admin sees. The server is faked (fake-api.tsx).

afterEach(() => {
  vi.unstubAllGlobals();
  vi.restoreAllMocks();
});

function rolesRoutes(extra: Record<string, FakeHandler> = {}): Record<string, FakeHandler> {
  return {
    'GET roles': () => ({ items: ROLES }),
    'GET roles/:id': (req) => ROLES.find((r) => r.id === req.params['id']) ?? problem(404, 'NOT_FOUND'),
    'GET permissions': () => permissionsAnswer(),
    ...extra,
  };
}

const checkbox = (name: string): HTMLInputElement => screen.getByRole('checkbox', { name }) as HTMLInputElement;

/** A read-only permission's status words, which screen readers read after its label. */
const grantedText = (label: string): string | undefined =>
  screen.getByText(label).closest('li')?.querySelector('.sr-only')?.textContent?.trim();

/** The texts an element's aria-describedby points at. */
const describedBy = (el: HTMLElement): string[] =>
  (el.getAttribute('aria-describedby') ?? '')
    .split(' ')
    .filter((id) => id !== '')
    .map((id) => document.getElementById(id)?.textContent ?? '');

describe('roles list', () => {
  it('marks the system roles "sistem"; "Buat peran" needs system.roles.manage', async () => {
    startApp({ me: adminMe(), path: '/admin/roles', routes: rolesRoutes() });
    const superRow = (await screen.findByRole('link', { name: 'Super Admin' })).closest('tr')!;
    expect(within(superRow).getByText('sistem')).toBeTruthy();
    expect(within(screen.getByRole('link', { name: 'Admin' }).closest('tr')!).getByText('sistem')).toBeTruthy();
    expect(within(screen.getByRole('link', { name: 'Pustakawan' }).closest('tr')!).queryByText('sistem')).toBeNull();
    expect(screen.getByRole('link', { name: 'Buat peran' }).getAttribute('href')).toBe('/admin/roles/new');
  });

  it('a reader sees the list without "Buat peran"', async () => {
    startApp({ me: signedIn({ permissions: ['system.users.read'] }), path: '/admin/roles', routes: rolesRoutes() });
    await screen.findByRole('link', { name: 'Pustakawan' });
    expect(screen.queryByRole('link', { name: 'Buat peran' })).toBeNull();
  });
});

describe('role editor', () => {
  it('groups permissions by module; one the admin does not hold, or only a super admin grants, is disabled with a hint', async () => {
    startApp({ me: adminMe(), path: '/admin/roles/new', routes: rolesRoutes() });
    const system = await screen.findByRole('group', { name: 'Sistem' });
    expect(within(system).getAllByRole('checkbox').length).toBe(19);
    expect(screen.getByRole('group', { name: 'Uji' })).toBeTruthy();

    const run = checkbox('Menjalankan pembaruan');
    expect(run.disabled).toBe(true);
    expect(describedBy(run)).toContain('Anda tidak memiliki izin ini.');
    const roles = checkbox('Mengelola peran');
    expect(roles.disabled).toBe(true);
    expect(describedBy(roles)).toContain('Hanya Super Admin yang dapat memberikan izin ini.');
    expect(checkbox('Melihat pengguna').disabled).toBe(false);
  });

  it('a super admin may pick every permission', async () => {
    startApp({ me: superMe(), path: '/admin/roles/new', routes: rolesRoutes() });
    await screen.findByRole('group', { name: 'Sistem' });
    expect(checkbox('Menjalankan pembaruan').disabled).toBe(false);
    expect(checkbox('Mengelola peran').disabled).toBe(false);
  });

  it('creating POSTs RoleCreateBody (permissions in catalog order) and opens the new role', async () => {
    const posted: unknown[] = [];
    const { router } = startApp({
      me: adminMe(),
      path: '/admin/roles/new',
      routes: rolesRoutes({
        'POST roles': (req) => {
          posted.push(req.body);
          return new Response(JSON.stringify({ ...ROLE_LIBRARIAN, id: 'R9NEW' }), { status: 201, headers: { 'Content-Type': 'application/json' } });
        },
      }),
    });
    await screen.findByRole('group', { name: 'Sistem' });
    fireEvent.change(screen.getByLabelText('Nama peran'), { target: { value: 'Pustakawan Senior' } });
    fireEvent.click(checkbox('Melihat catatan audit'));
    fireEvent.click(checkbox('Melihat pengguna'));
    fireEvent.click(screen.getByRole('button', { name: 'Simpan' }));
    await waitFor(() => expect(posted).toHaveLength(1));
    expect(posted[0]).toEqual({
      name: 'Pustakawan Senior',
      description: null,
      permissions: ['system.users.read', 'system.audit.read'],
      mfaRequired: false,
    });
    await waitFor(() => expect(router.state.location.pathname).toBe('/admin/roles/R9NEW'));
    expect(await screen.findByText('Peran dibuat.')).toBeTruthy();
  });

  it('a taken name appears under the name field', async () => {
    startApp({
      me: adminMe(),
      path: '/admin/roles/new',
      routes: rolesRoutes({ 'POST roles': () => problem(422, 'VALIDATION_FAILED', { errors: [{ path: 'name', code: 'taken' }] }) }),
    });
    await screen.findByRole('group', { name: 'Sistem' });
    const name = screen.getByLabelText('Nama peran');
    fireEvent.change(name, { target: { value: 'Pustakawan' } });
    fireEvent.click(checkbox('Melihat pengguna'));
    fireEvent.click(screen.getByRole('button', { name: 'Simpan' }));
    await waitFor(() => expect(describedBy(name)).toContain('Sudah dipakai. Gunakan yang lain.'));
  });

  it('editing a custom role PATCHes only the changes, with its version', async () => {
    const patched: unknown[] = [];
    startApp({
      me: adminMe(),
      path: `/admin/roles/${ROLE_LIBRARIAN.id}`,
      routes: rolesRoutes({
        'PATCH roles/:id': (req) => {
          patched.push(req.body);
          return { ...ROLE_LIBRARIAN, version: ROLE_LIBRARIAN.version + 1 };
        },
      }),
    });
    await waitFor(() => expect(checkbox('Melihat pengguna').checked).toBe(true));
    fireEvent.click(checkbox('Melihat catatan audit'));
    fireEvent.click(screen.getByRole('button', { name: 'Simpan' }));
    await waitFor(() => expect(patched).toHaveLength(1));
    expect(patched[0]).toEqual({ version: ROLE_LIBRARIAN.version, permissions: ['system.users.read', 'system.audit.read'] });
    expect(await screen.findByText('Perubahan disimpan.')).toBeTruthy();
  });

  it('the super_admin page renders read-only permissions and no switch for an admin', async () => {
    startApp({ me: adminMe(), path: '/admin/roles/R0SUPER', routes: rolesRoutes() });
    expect(await screen.findByText('Ini peran sistem. Izinnya dihitung otomatis dari katalog dan tidak dapat diubah.')).toBeTruthy();
    const system = await screen.findByRole('group', { name: 'Sistem' });
    expect(within(system).getAllByRole('listitem')).toHaveLength(19);
    expect(grantedText('Menjalankan pembaruan')).toBe('(diberikan)');
    expect(screen.queryAllByRole('checkbox')).toEqual([]);
    expect(screen.queryByRole('switch')).toBeNull();
    expect(screen.queryByRole('button', { name: 'Simpan' })).toBeNull();
    expect(screen.queryByRole('textbox', { name: 'Nama peran' })).toBeNull();
  });

  it("the admin role's page marks what the role lacks", async () => {
    startApp({ me: adminMe(), path: `/admin/roles/${ROLE_ADMIN.id}`, routes: rolesRoutes() });
    await screen.findByRole('group', { name: 'Sistem' });
    expect(grantedText('Menjalankan pembaruan')).toBe('(tidak diberikan)');
    expect(grantedText('Mengelola peran')).toBe('(diberikan)');
    expect(screen.queryByRole('switch')).toBeNull();
  });

  it("a super admin gets only the system role's 2FA switch; saving PATCHes {version, mfaRequired}", async () => {
    const patched: unknown[] = [];
    startApp({
      me: superMe(),
      path: `/admin/roles/${ROLE_ADMIN.id}`,
      routes: rolesRoutes({
        'PATCH roles/:id': (req) => {
          patched.push(req.body);
          return { ...ROLE_ADMIN, mfaRequired: true, version: 2 };
        },
      }),
    });
    const toggle = await screen.findByRole('switch', { name: 'Wajibkan 2FA bagi semua pemegang peran ini' });
    expect(screen.queryAllByRole('checkbox')).toEqual([]);
    expect(screen.queryByRole('textbox', { name: 'Nama peran' })).toBeNull();
    fireEvent.click(toggle);
    fireEvent.click(screen.getByRole('button', { name: 'Simpan' }));
    await waitFor(() => expect(patched).toHaveLength(1));
    expect(patched[0]).toEqual({ version: ROLE_ADMIN.version, mfaRequired: true });
  });

  it('a custom role with a permission the admin cannot grant is read-only for them', async () => {
    startApp({ me: adminMe(), path: '/admin/roles/R2UPD', routes: rolesRoutes() });
    expect(await screen.findByText('Peran ini berisi izin yang tidak dapat Anda berikan, jadi Anda tidak dapat mengubahnya.')).toBeTruthy();
    expect(screen.queryByRole('button', { name: 'Simpan' })).toBeNull();
    expect(screen.queryByRole('button', { name: 'Hapus peran' })).toBeNull();
  });

  it('deleting a custom role asks first, then DELETEs it and returns to the list', async () => {
    const { router, writes } = startApp({
      me: adminMe(),
      path: `/admin/roles/${ROLE_LIBRARIAN.id}`,
      routes: rolesRoutes({ 'DELETE roles/:id': () => ROLE_LIBRARIAN }),
    });
    fireEvent.click(await screen.findByRole('button', { name: 'Hapus peran' }));
    const dialog = await screen.findByRole('alertdialog', { name: 'Hapus peran Pustakawan?' });
    expect(writes()).toEqual([]);
    fireEvent.click(within(dialog).getByRole('button', { name: 'Hapus peran' }));
    await waitFor(() => expect(writes()).toEqual(['DELETE roles/R1PUST']));
    await waitFor(() => expect(router.state.location.pathname).toBe('/admin/roles'));
  });
});
