import type { BranchItem } from '@altis/shared/api/branches';
import { fireEvent, screen, waitFor, within } from '@testing-library/react';
import { afterEach, describe, expect, it, vi } from 'vitest';
import { BRANCH_MAIN, BRANCH_NORTH, BRANCH_OLD, adminMe, signedIn, startApp, type FakeHandler } from './fake-api';

// Spec §13.3 "Cabang" (Task 29): the list, the form (code, name, address, time zone) and archiving with confirmation;
// the default branch has no archive action. The server is faked (fake-api.tsx).

afterEach(() => {
  vi.unstubAllGlobals();
  vi.restoreAllMocks();
});

function branchesRoutes(extra: Record<string, FakeHandler> = {}): Record<string, FakeHandler> {
  return {
    'GET branches': (req) => ({
      items: req.query.get('includeArchived') === 'true' ? [BRANCH_MAIN, BRANCH_NORTH, BRANCH_OLD] : [BRANCH_MAIN, BRANCH_NORTH],
    }),
    ...extra,
  };
}

const rowOf = (code: string): HTMLElement => screen.getByText(code).closest('tr')!;

/** Opens the ⋯ menu of a row and answers the names of its actions. */
async function rowMenu(code: string): Promise<string[]> {
  const trigger = within(rowOf(code)).getByRole('button', { name: /^Tindakan untuk / });
  trigger.focus();
  fireEvent.keyDown(trigger, { key: 'Enter' });
  await screen.findByRole('menu');
  return screen.getAllByRole('menuitem').map((i) => i.textContent ?? '');
}

async function closeMenu(): Promise<void> {
  fireEvent.keyDown(screen.getByRole('menu'), { key: 'Escape' });
  await waitFor(() => expect(screen.queryByRole('menu')).toBeNull());
}

describe('branches list', () => {
  it('the default branch row has no archive action', async () => {
    startApp({ me: adminMe(), path: '/admin/branches', routes: branchesRoutes() });
    await screen.findByText('PUSAT');
    expect(within(rowOf('PUSAT')).getByText('Utama')).toBeTruthy();
    expect(await rowMenu('PUSAT')).toEqual(['Ubah']);
    await closeMenu();
    expect(await rowMenu('UTARA')).toEqual(['Ubah', 'Arsipkan']);
    await closeMenu();
    expect(screen.getByRole('link', { name: 'Tambah cabang' }).getAttribute('href')).toBe('/admin/branches/new');
  });

  it('archiving asks for confirmation, then DELETEs branches/:id', async () => {
    const { writes } = startApp({
      me: adminMe(),
      path: '/admin/branches',
      routes: branchesRoutes({ 'DELETE branches/:id': (): BranchItem => ({ ...BRANCH_NORTH, archivedAt: 1, version: 3 }) }),
    });
    await screen.findByText('UTARA');
    await rowMenu('UTARA');
    fireEvent.click(screen.getByRole('menuitem', { name: 'Arsipkan' }));
    const dialog = await screen.findByRole('alertdialog', { name: 'Arsipkan Cabang Utara?' });
    expect(writes()).toEqual([]);
    fireEvent.click(within(dialog).getByRole('button', { name: 'Arsipkan' }));
    await waitFor(() => expect(writes()).toEqual(['DELETE branches/B2']));
    expect(await screen.findByText('Cabang Utara diarsipkan.')).toBeTruthy();
  });

  it('archived branches show on request, without an archive action', async () => {
    const { requests } = startApp({ me: adminMe(), path: '/admin/branches', routes: branchesRoutes() });
    await screen.findByText('UTARA');
    expect(screen.queryByText('LAMA')).toBeNull();
    fireEvent.click(screen.getByRole('checkbox', { name: 'Tampilkan cabang yang diarsipkan' }));
    await screen.findByText('LAMA');
    expect(requests.at(-1)?.query.get('includeArchived')).toBe('true');
    expect(within(rowOf('LAMA')).getByText('Diarsipkan')).toBeTruthy();
    expect(await rowMenu('LAMA')).toEqual(['Ubah']);
  });

  it('the community edition has no branch limit: no limit notice, no "Pilih cabang aktif", every live branch Aktif', async () => {
    const { requests } = startApp({
      me: adminMe(),
      path: '/admin/branches',
      routes: { 'GET branches': () => ({ items: [BRANCH_MAIN, BRANCH_NORTH].map((b) => ({ ...b, active: true })) }) },
    });
    await screen.findByText('UTARA');
    expect(within(rowOf('PUSAT')).getByText('Aktif')).toBeTruthy();
    expect(within(rowOf('UTARA')).getByText('Aktif')).toBeTruthy();
    expect(screen.queryByRole('button', { name: 'Pilih cabang aktif' })).toBeNull();
    expect(screen.queryByText(/batas lisensi/)).toBeNull();
    expect(requests.some((r) => r.path === 'branches/active-set')).toBe(false);
  });

  it('without system.branches.manage the list has no actions', async () => {
    startApp({ me: signedIn({ permissions: [] }), path: '/admin/branches', routes: branchesRoutes() });
    await screen.findByText('UTARA');
    expect(screen.queryByRole('button', { name: /^Tindakan untuk / })).toBeNull();
    expect(screen.queryByRole('link', { name: 'Tambah cabang' })).toBeNull();
  });
});

describe('branch form', () => {
  it('creating POSTs code, name, address and time zone, then returns to the list', async () => {
    const posted: unknown[] = [];
    const { router } = startApp({
      me: adminMe(),
      path: '/admin/branches/new',
      routes: branchesRoutes({
        'POST branches': (req) => {
          posted.push(req.body);
          return new Response(JSON.stringify({ ...BRANCH_NORTH, id: 'B9' }), { status: 201, headers: { 'Content-Type': 'application/json' } });
        },
      }),
    });
    const timezone = (await screen.findByLabelText('Zona waktu')) as HTMLInputElement;
    expect(timezone.value).toBe('Asia/Jakarta');
    fireEvent.change(screen.getByLabelText('Kode cabang'), { target: { value: 'SELATAN' } });
    fireEvent.change(screen.getByLabelText('Nama cabang'), { target: { value: 'Cabang Selatan' } });
    fireEvent.change(screen.getByLabelText('Alamat'), { target: { value: 'Jl. Selatan 2' } });
    fireEvent.change(timezone, { target: { value: 'Asia/Makassar' } });
    fireEvent.click(screen.getByRole('button', { name: 'Simpan' }));
    await waitFor(() => expect(posted).toHaveLength(1));
    expect(posted[0]).toEqual({ code: 'SELATAN', name: 'Cabang Selatan', address: 'Jl. Selatan 2', timezone: 'Asia/Makassar' });
    await waitFor(() => expect(router.state.location.pathname).toBe('/admin/branches'));
  });

  it('an unknown time zone is refused before anything is sent', async () => {
    const { writes } = startApp({ me: adminMe(), path: '/admin/branches/new', routes: branchesRoutes() });
    fireEvent.change(await screen.findByLabelText('Kode cabang'), { target: { value: 'X1' } });
    fireEvent.change(screen.getByLabelText('Nama cabang'), { target: { value: 'X' } });
    const timezone = screen.getByLabelText('Zona waktu');
    fireEvent.change(timezone, { target: { value: 'Mars/Olympus' } });
    fireEvent.click(screen.getByRole('button', { name: 'Simpan' }));
    await waitFor(() => expect(timezone.getAttribute('aria-invalid')).toBe('true'));
    expect(writes()).toEqual([]);
  });

  it('editing PATCHes the changes with the version', async () => {
    const patched: unknown[] = [];
    const { router } = startApp({
      me: adminMe(),
      path: '/admin/branches/B2',
      routes: branchesRoutes({
        'PATCH branches/:id': (req) => {
          patched.push(req.body);
          return { ...BRANCH_NORTH, name: 'Cabang Utara Baru', version: 3 };
        },
      }),
    });
    const name = (await screen.findByLabelText('Nama cabang')) as HTMLInputElement;
    await waitFor(() => expect(name.value).toBe('Cabang Utara'));
    fireEvent.change(name, { target: { value: 'Cabang Utara Baru' } });
    fireEvent.click(screen.getByRole('button', { name: 'Simpan' }));
    await waitFor(() => expect(patched).toHaveLength(1));
    expect(patched[0]).toEqual({ version: BRANCH_NORTH.version, name: 'Cabang Utara Baru' });
    await waitFor(() => expect(router.state.location.pathname).toBe('/admin/branches'));
  });
});
