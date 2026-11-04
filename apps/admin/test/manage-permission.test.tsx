import { screen, waitFor, within } from '@testing-library/react';
import { afterEach, describe, expect, it, vi } from 'vitest';
import { BRANCH_MAIN, BRANCH_NORTH, adminMe, permissionsAnswer, signedIn, startApp } from './fake-api';

// The create and edit screens follow the permission gating of the rest of the SPA (spec §7.2; the server refuses
// with 403 anyway): without the section's manage permission, a deep link to them shows a read-only or no-access state
// (the fields disabled, no save button), never a form that is refused only once it is sent.

afterEach(() => {
  vi.unstubAllGlobals();
  vi.restoreAllMocks();
});

const NO_ACCESS = 'Anda tidak memiliki izin untuk melakukan ini.';

/** Every form control inside the main region is disabled (itself, or by a disabled fieldset), and there is no save button. */
function expectReadOnly(): void {
  const main = screen.getByRole('main');
  const controls = within(main).queryAllByRole('textbox');
  expect(controls.length).toBeGreaterThan(0);
  for (const control of controls) expect(control.matches(':disabled'), control.outerHTML).toBe(true);
  for (const box of within(main).queryAllByRole('checkbox')) expect(box.matches(':disabled')).toBe(true);
  expect(within(main).queryByRole('button', { name: 'Simpan' })).toBeNull();
}

describe('without the manage permission', () => {
  it('Buat peran (no system.roles.manage): no access, the form disabled, no save', async () => {
    startApp({
      me: signedIn({ permissions: ['system.users.read'] }),
      path: '/admin/roles/new',
      routes: { 'GET permissions': () => permissionsAnswer() },
    });
    expect(await screen.findByText(NO_ACCESS)).toBeTruthy();
    await screen.findByLabelText('Nama peran');
    expectReadOnly();
  });

  it('Tambah cabang (no system.branches.manage): no access, the form disabled, no save', async () => {
    startApp({ me: signedIn({ permissions: ['system.users.read'] }), path: '/admin/branches/new', routes: {} });
    expect(await screen.findByText(NO_ACCESS)).toBeTruthy();
    await screen.findByLabelText('Kode cabang');
    expectReadOnly();
  });

  it('Ubah cabang (no system.branches.manage): the branch read-only, no save', async () => {
    startApp({
      me: signedIn({ permissions: ['system.users.read'] }),
      path: '/admin/branches/B2',
      routes: { 'GET branches': () => ({ items: [BRANCH_MAIN, BRANCH_NORTH] }) },
    });
    const name = (await screen.findByLabelText('Nama cabang')) as HTMLInputElement;
    await waitFor(() => expect(name.value).toBe('Cabang Utara'));
    expect(screen.getByText('Anda hanya dapat melihat cabang ini. Untuk mengubahnya diperlukan izin mengelola cabang.')).toBeTruthy();
    expectReadOnly();
  });

  it('Tambah pengguna (no system.users.manage): no access, the form disabled, no save', async () => {
    startApp({ me: signedIn({ permissions: ['system.users.read'] }), path: '/admin/users/new', routes: {} });
    expect(await screen.findByText(NO_ACCESS)).toBeTruthy();
    await screen.findByLabelText('Nama pengguna');
    expectReadOnly();
  });

  it('with the permission the same screens stay editable', async () => {
    startApp({ me: adminMe(), path: '/admin/branches/new', routes: {} });
    const code = await screen.findByLabelText('Kode cabang');
    expect(code.matches(':disabled')).toBe(false);
    expect(screen.getByRole('button', { name: 'Simpan' })).toBeTruthy();
    expect(screen.queryByText(NO_ACCESS)).toBeNull();
  });
});
