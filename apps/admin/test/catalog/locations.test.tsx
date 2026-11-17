import type { Permission } from '@altis/shared';
import type { BranchItem } from '@altis/shared/api/branches';
import type { LocationView } from '@altis/shared/api/catalog/locations';
import { fireEvent, screen, waitFor, within } from '@testing-library/react';
import { afterEach, beforeAll, describe, expect, it, vi } from 'vitest';
import { adminMe, problem, signedIn, startApp, type FakeHandler, type FakeRequest } from '../fake-api';

// Lokasi & Rak (Phase 2 spec §13, §3.6; plan Task 27): per branch, the tree room › area › shelf with create, edit,
// archive and the shelf's call-number range. Writes are branch-scoped (`branches/:branchId/locations…`,
// `catalog.locations.manage` at that branch). A location that still holds locations or items is refused with 409
// CATALOG_IN_USE and the screen says what it holds. A move to another room clears the shelf-map boxes drawn on the old
// room's plan (the server names them, Task 40), so the screen asks the admin to redraw them.

// The screen is a lazy chunk: load it before the first test, whose first look for the page waits 1 s at most.
beforeAll(async () => {
  await import('@/screens/catalog/locations/index');
});

afterEach(() => {
  vi.unstubAllGlobals();
  vi.restoreAllMocks();
});

const BRANCH_A = '01JZ00000000000000000BRA01';
const BRANCH_B = '01JZ00000000000000000BRB01';
const ROOM = '01JZ0000000000000000000R01';
const ROOM2 = '01JZ0000000000000000000R02';
const AREA = '01JZ0000000000000000000A01';
const SHELF = '01JZ0000000000000000000S01';
const SHELF2 = '01JZ0000000000000000000S02';
const PLAN = '01JZ0000000000000000000F01';
const PLAN2 = '01JZ0000000000000000000F02';
const NEW_ID = '01JZ0000000000000000000N01';

const branch = (id: string, code: string, name: string, isDefault: boolean): BranchItem => ({
  id,
  code,
  name,
  address: null,
  timezone: 'Asia/Jakarta',
  isDefault,
  archivedAt: null,
  version: 1,
});

const BRANCHES: BranchItem[] = [branch(BRANCH_A, 'PUSAT', 'Perpustakaan Pusat', true), branch(BRANCH_B, 'UTARA', 'Cabang Utara', false)];

function location(o: Partial<LocationView> & Pick<LocationView, 'id' | 'kind' | 'code' | 'name'>): LocationView {
  return {
    branchId: BRANCH_A,
    parentId: null,
    shelfHint: o.name,
    classFrom: null,
    classTo: null,
    mapFileId: null,
    box: null,
    isPublic: true,
    sortOrder: 0,
    itemCount: 0,
    archived: false,
    version: 1,
    ...o,
  };
}

/** Branch A's tree, in the server's tree order: Ruang Baca › Area Anak › Rak 800 (and Rak 900 straight in the room), Ruang Referensi. */
const TREE: LocationView[] = [
  location({ id: ROOM, kind: 'room', code: 'R1', name: 'Ruang Baca', mapFileId: PLAN, version: 1 }),
  location({ id: AREA, kind: 'area', code: 'A1', name: 'Area Anak', parentId: ROOM, version: 2 }),
  location({
    id: SHELF,
    kind: 'shelf',
    code: 'RAK-800',
    name: 'Rak 800',
    parentId: AREA,
    classFrom: '800',
    classTo: '899',
    itemCount: 12,
    box: { x: 100, y: 200, w: 200, h: 200 },
    version: 3,
  }),
  location({ id: SHELF2, kind: 'shelf', code: 'RAK-900', name: 'Rak 900', parentId: ROOM, version: 1 }),
  location({ id: ROOM2, kind: 'room', code: 'R2', name: 'Ruang Referensi', version: 1 }),
];

function startLocations(o: { path?: string; me?: ReturnType<typeof signedIn>; tree?: (req: FakeRequest) => LocationView[]; routes?: Record<string, FakeHandler> } = {}) {
  return startApp({
    me: o.me ?? adminMe(),
    path: o.path ?? '/admin/catalog/locations',
    routes: {
      'GET branches': () => ({ items: BRANCHES }),
      'GET catalog/locations': (req) => ({ items: (o.tree ?? ((r: FakeRequest) => (r.query.get('branchId') === BRANCH_A ? TREE : [])))(req) }),
      ...o.routes,
    },
  });
}

const sent = (requests: FakeRequest[], method: string, path: string): FakeRequest[] => requests.filter((r) => r.method === method && r.path === path);

/** The list item of the tree node named `name`. */
const node = (name: string): HTMLElement => screen.getByText(name, { selector: '[data-location-name]' }).closest('li')!;

describe('LocationsScreen', () => {
  it('L13: a branch the server marks inactive is read-only and says why; the screen opens an active one', async () => {
    const oneInactive = [{ ...BRANCHES[0]!, active: false }, { ...BRANCHES[1]!, active: true }];
    startLocations({ routes: { 'GET branches': () => ({ items: oneInactive }) }, tree: () => TREE });
    await screen.findByText('Rak 800', { selector: '[data-location-name]' });
    // The default branch is inactive: the screen opens the active one where the admin manages locations.
    expect((screen.getByLabelText('Cabang') as HTMLSelectElement).value).toBe(BRANCH_B);
    expect(screen.getByRole('button', { name: 'Tambah ruang' })).toBeTruthy();
    fireEvent.change(screen.getByLabelText('Cabang'), { target: { value: BRANCH_A } });
    expect(await screen.findByText('Cabang ini tidak aktif; lokasinya hanya bisa dilihat.')).toBeTruthy();
    expect(screen.queryByRole('button', { name: 'Tambah ruang' })).toBeNull();
  });

  it('renders the tree with its 3 levels: room › area › shelf', async () => {
    const { requests } = startLocations();
    expect(await screen.findByRole('heading', { name: 'Lokasi & Rak' })).toBeTruthy();
    await screen.findByText('Rak 800', { selector: '[data-location-name]' });
    const room = node('Ruang Baca');
    const area = node('Area Anak');
    const shelf = node('Rak 800');
    expect(area.parentElement!.closest('li')).toBe(room);
    expect(shelf.parentElement!.closest('li')).toBe(area);
    expect(node('Rak 900').parentElement!.closest('li')).toBe(room);
    expect(node('Ruang Referensi').parentElement!.closest('li')).toBeNull();
    expect(within(room).getAllByText('Ruang').length).toBeGreaterThan(0);
    expect(within(area).getAllByText('Bagian ruang').length).toBeGreaterThan(0);
    // The shelf's own line: kind, code, class range and its items.
    const line = shelf.querySelector('[data-location-row]')!;
    expect(line.textContent).toContain('Rak');
    expect(line.textContent).toContain('RAK-800');
    expect(line.textContent).toContain('800–899');
    expect(line.textContent).toContain('12 eksemplar');
    expect(requests.some((r) => r.path === 'catalog/locations' && r.query.get('branchId') === BRANCH_A)).toBe(true);
  });

  it('creates a shelf inside an area with the strict body, under the branch', async () => {
    const { requests } = startLocations({ routes: { 'POST branches/:branchId/locations': () => ({ id: NEW_ID, version: 0 }) } });
    await screen.findByText('Area Anak', { selector: '[data-location-name]' });
    fireEvent.click(within(node('Area Anak')).getByRole('button', { name: 'Tambah lokasi di dalam Area Anak' }));
    const dialog = await screen.findByRole('region', { name: 'Tambah lokasi' });
    expect((within(dialog).getByLabelText('Jenis') as HTMLSelectElement).value).toBe('shelf');
    expect((within(dialog).getByLabelText('Di dalam') as HTMLSelectElement).value).toBe(AREA);
    fireEvent.change(within(dialog).getByLabelText('Kode'), { target: { value: 'RAK-810' } });
    fireEvent.change(within(dialog).getByLabelText('Nama'), { target: { value: 'Rak 810' } });
    fireEvent.change(within(dialog).getByLabelText('Nomor panggil dari'), { target: { value: '810' } });
    fireEvent.change(within(dialog).getByLabelText('Nomor panggil sampai'), { target: { value: '819' } });
    fireEvent.click(within(dialog).getByRole('button', { name: 'Simpan' }));
    await waitFor(() => expect(sent(requests, 'POST', `branches/${BRANCH_A}/locations`)).toHaveLength(1));
    expect(sent(requests, 'POST', `branches/${BRANCH_A}/locations`)[0]!.body).toEqual({
      parentId: AREA,
      kind: 'shelf',
      code: 'RAK-810',
      name: 'Rak 810',
      shelfHint: null,
      classFrom: '810',
      classTo: '819',
      isPublic: true,
      sortOrder: 0,
    });
    expect(await screen.findByText('Lokasi Rak 810 disimpan.')).toBeTruthy();
  });

  it('a room has no parent; an area may only sit in a room', async () => {
    startLocations();
    await screen.findByText('Area Anak', { selector: '[data-location-name]' });
    fireEvent.click(screen.getByRole('button', { name: 'Tambah ruang' }));
    let dialog = await screen.findByRole('region', { name: 'Tambah lokasi' });
    expect((within(dialog).getByLabelText('Jenis') as HTMLSelectElement).value).toBe('room');
    expect(within(dialog).queryByLabelText('Di dalam')).toBeNull();
    fireEvent.change(within(dialog).getByLabelText('Jenis'), { target: { value: 'area' } });
    const parents = [...(within(dialog).getByLabelText('Di dalam') as HTMLSelectElement).options].map((o) => o.textContent);
    expect(parents).toEqual(['Ruang Baca (R1)', 'Ruang Referensi (R2)']);
    fireEvent.change(within(dialog).getByLabelText('Jenis'), { target: { value: 'shelf' } });
    const shelfParents = [...(within(dialog).getByLabelText('Di dalam') as HTMLSelectElement).options].map((o) => o.textContent);
    expect(shelfParents).toEqual(['Ruang Baca (R1)', '— Area Anak (A1)', 'Ruang Referensi (R2)']);
    fireEvent.click(within(dialog).getByRole('button', { name: 'Batal' }));
    await waitFor(() => expect(screen.queryByRole('region', { name: 'Tambah lokasi' })).toBeNull());

    // Editing an area never offers itself or anything below it as its parent.
    fireEvent.click(within(node('Area Anak')).getByRole('button', { name: 'Ubah Area Anak' }));
    dialog = await screen.findByRole('region', { name: 'Ubah lokasi' });
    expect([...(within(dialog).getByLabelText('Di dalam') as HTMLSelectElement).options].map((o) => o.value)).toEqual([ROOM, ROOM2]);
  });

  it('archiving a room that still holds locations shows what it holds', async () => {
    const { requests } = startLocations({
      routes: {
        'DELETE branches/:branchId/locations/:id': () =>
          problem(409, 'CATALOG_IN_USE', {
            detail:
              'Lokasi masih berisi 2 lokasi aktif dan 0 eksemplar aktif; pindahkan atau arsipkan dahulu / The location still holds 2 live location(s) and 0 live item(s); move or archive them first',
          }),
      },
    });
    await screen.findByText('Ruang Baca', { selector: '[data-location-name]' });
    fireEvent.click(within(node('Ruang Baca')).getAllByRole('button', { name: 'Arsipkan Ruang Baca' })[0]!);
    const dialog = await screen.findByRole('alertdialog', { name: 'Arsipkan Ruang Baca?' });
    fireEvent.click(within(dialog).getByRole('button', { name: 'Arsipkan' }));
    const alert = await screen.findByText('Ruang Baca masih berisi 2 lokasi aktif dan 0 eksemplar aktif, jadi belum dapat diarsipkan. Pindahkan atau arsipkan dahulu isinya.');
    expect(alert.closest('[role="alert"]')).not.toBeNull();
    expect(sent(requests, 'DELETE', `branches/${BRANCH_A}/locations/${ROOM}`)[0]!.body).toEqual({ version: 1 });
  });

  it('a stale archive reads the tree again, so confirming again sends the current version', async () => {
    let changed = false;
    let deletes = 0;
    const { requests } = startLocations({
      tree: () => (changed ? TREE.map((l) => (l.id === SHELF2 ? { ...l, name: 'Rak 900 lama', version: 7 } : l)) : TREE),
      routes: {
        'DELETE branches/:branchId/locations/:id': () => {
          deletes += 1;
          if (deletes > 1) return { id: SHELF2, version: 8 };
          changed = true;
          return problem(409, 'CONFLICT_STALE');
        },
      },
    });
    await screen.findByText('Rak 900', { selector: '[data-location-name]' });
    fireEvent.click(within(node('Rak 900')).getByRole('button', { name: 'Arsipkan Rak 900' }));
    const dialog = await screen.findByRole('alertdialog', { name: 'Arsipkan Rak 900?' });
    fireEvent.click(within(dialog).getByRole('button', { name: 'Arsipkan' }));
    expect(await within(dialog).findByText('Data ini sudah diubah oleh orang lain. Muat ulang, lalu coba lagi.')).toBeTruthy();
    expect(sent(requests, 'DELETE', `branches/${BRANCH_A}/locations/${SHELF2}`)[0]!.body).toEqual({ version: 1 });
    expect(await screen.findByText('Rak 900 lama', { selector: '[data-location-name]' })).toBeTruthy();

    fireEvent.click(within(dialog).getByRole('button', { name: 'Arsipkan' }));
    expect(await screen.findByText('Lokasi Rak 900 diarsipkan.')).toBeTruthy();
    expect(sent(requests, 'DELETE', `branches/${BRANCH_A}/locations/${SHELF2}`)[1]!.body).toEqual({ version: 7 });
  });

  it('a stale edit reads the tree again, so the reopened dialog holds the current location', async () => {
    let changed = false;
    const { requests } = startLocations({
      tree: () => (changed ? TREE.map((l) => (l.id === SHELF2 ? { ...l, code: 'RAK-901', version: 6 } : l)) : TREE),
      routes: {
        'PATCH branches/:branchId/locations/:id': (req) => {
          if ((req.body as { version: number }).version === 6) return { id: SHELF2, version: 7 };
          changed = true;
          return problem(409, 'CONFLICT_STALE');
        },
      },
    });
    await screen.findByText('Rak 900', { selector: '[data-location-name]' });
    fireEvent.click(within(node('Rak 900')).getByRole('button', { name: 'Ubah Rak 900' }));
    let dialog = await screen.findByRole('region', { name: 'Ubah lokasi' });
    fireEvent.change(within(dialog).getByLabelText('Nama'), { target: { value: 'Rak 900-999' } });
    fireEvent.click(within(dialog).getByRole('button', { name: 'Simpan' }));
    expect(await within(dialog).findByText('Data ini sudah diubah oleh orang lain. Muat ulang, lalu coba lagi.')).toBeTruthy();
    await waitFor(() => expect(within(node('Rak 900')).getByText('RAK-901')).toBeTruthy());

    fireEvent.click(within(dialog).getByRole('button', { name: 'Batal' }));
    await waitFor(() => expect(screen.queryByRole('region', { name: 'Ubah lokasi' })).toBeNull());
    fireEvent.click(within(node('Rak 900')).getByRole('button', { name: 'Ubah Rak 900' }));
    dialog = await screen.findByRole('region', { name: 'Ubah lokasi' });
    expect((within(dialog).getByLabelText('Kode') as HTMLInputElement).value).toBe('RAK-901');
    fireEvent.change(within(dialog).getByLabelText('Nama'), { target: { value: 'Rak 900-999' } });
    fireEvent.click(within(dialog).getByRole('button', { name: 'Simpan' }));
    await waitFor(() => expect(sent(requests, 'PATCH', `branches/${BRANCH_A}/locations/${SHELF2}`)).toHaveLength(2));
    expect(sent(requests, 'PATCH', `branches/${BRANCH_A}/locations/${SHELF2}`)[1]!.body).toEqual({ version: 6, name: 'Rak 900-999' });
  });

  it('the branch select reads that branch; without catalog.locations.manage there the tree is read only', async () => {
    const me = signedIn({ permissions: ['catalog.records.read'] as Permission[] });
    me.branchPermissions = { [BRANCH_B]: ['catalog.locations.manage'] };
    const { requests, router } = startLocations({
      me,
      tree: (r) => (r.query.get('branchId') === BRANCH_B ? [location({ id: ROOM2, branchId: BRANCH_B, kind: 'room', code: 'U1', name: 'Ruang Utara' })] : TREE),
    });
    // The user manages locations only at Cabang Utara: the screen starts there.
    await screen.findByText('Ruang Utara', { selector: '[data-location-name]' });
    expect((screen.getByLabelText('Cabang') as HTMLSelectElement).value).toBe(BRANCH_B);
    expect(screen.getByRole('button', { name: 'Tambah ruang' })).toBeTruthy();

    fireEvent.change(screen.getByLabelText('Cabang'), { target: { value: BRANCH_A } });
    await screen.findByText('Rak 800', { selector: '[data-location-name]' });
    await waitFor(() => expect(router.state.location.search).toEqual({ branchId: BRANCH_A }));
    expect(requests.some((r) => r.path === 'catalog/locations' && r.query.get('branchId') === BRANCH_A)).toBe(true);
    expect(screen.queryByRole('button', { name: 'Tambah ruang' })).toBeNull();
    expect(within(node('Rak 800')).queryByRole('button', { name: 'Ubah Rak 800' })).toBeNull();
    expect(screen.getByText('Anda hanya dapat melihat lokasi cabang ini.')).toBeTruthy();
  });

  it('shows archived locations on request', async () => {
    const { requests } = startLocations({
      tree: (r) => (r.query.get('includeArchived') === 'true' ? [...TREE, location({ id: NEW_ID, kind: 'room', code: 'GDG', name: 'Gudang Lama', archived: true })] : TREE),
    });
    await screen.findByText('Ruang Baca', { selector: '[data-location-name]' });
    expect(screen.queryByText('Gudang Lama')).toBeNull();
    fireEvent.click(screen.getByLabelText('Tampilkan yang diarsipkan'));
    expect(await screen.findByText('Gudang Lama', { selector: '[data-location-name]' })).toBeTruthy();
    expect(within(node('Gudang Lama')).getByText('Diarsipkan')).toBeTruthy();
    expect(requests.some((r) => r.path === 'catalog/locations' && r.query.get('includeArchived') === 'true')).toBe(true);
  });

  it('moving a shelf to another room asks to redraw its box on the new room’s map', async () => {
    let moved = false;
    const { requests } = startLocations({
      tree: () => (moved ? TREE.map((l) => (l.id === SHELF ? { ...l, parentId: ROOM2, box: null, version: 4 } : l)) : TREE),
      routes: {
        'PATCH branches/:branchId/locations/:id': () => {
          moved = true;
          // The server cleared the box drawn on the old room's plan and names it (Task 40).
          return { id: SHELF, version: 4, boxesCleared: [SHELF] };
        },
      },
    });
    await screen.findByText('Rak 800', { selector: '[data-location-name]' });
    fireEvent.click(within(node('Rak 800')).getByRole('button', { name: 'Ubah Rak 800' }));
    const dialog = await screen.findByRole('region', { name: 'Ubah lokasi' });
    fireEvent.change(within(dialog).getByLabelText('Di dalam'), { target: { value: ROOM2 } });
    fireEvent.click(within(dialog).getByRole('button', { name: 'Simpan' }));
    await waitFor(() => expect(sent(requests, 'PATCH', `branches/${BRANCH_A}/locations/${SHELF}`)).toHaveLength(1));
    expect(sent(requests, 'PATCH', `branches/${BRANCH_A}/locations/${SHELF}`)[0]!.body).toEqual({ version: 3, parentId: ROOM2 });
    expect(
      await screen.findByText('Kotak peta Rak 800 dihapus karena lokasinya pindah ruang. Gambar ulang kotaknya pada peta Ruang Referensi.'),
    ).toBeTruthy();
    fireEvent.click(screen.getByRole('button', { name: 'Buka peta Ruang Referensi' }));
    const editor = await screen.findByRole('region', { name: 'Peta rak Ruang Referensi' });
    expect(within(editor).getByText('Perlu digambar ulang')).toBeTruthy();
  });

  it('an area that becomes a room: only its shelves are marked for redrawing, and the notice goes once they are drawn', async () => {
    let moved = false;
    let drawn = false;
    const { requests } = startLocations({
      tree: () => {
        if (!moved) return TREE.map((l) => (l.id === AREA ? { ...l, box: { x: 50, y: 50, w: 400, h: 400 } } : l));
        // The new room has its own floor plan by now; the server cleared the boxes drawn on Ruang Baca's plan.
        return TREE.map((l) => {
          if (l.id === AREA) return { ...l, kind: 'room' as const, parentId: null, box: null, mapFileId: PLAN2, version: 3 };
          if (l.id === SHELF) return drawn ? { ...l, box: { x: 0, y: 0, w: 100, h: 100 }, version: 5 } : { ...l, box: null, version: 4 };
          return l;
        });
      },
      routes: {
        'PATCH branches/:branchId/locations/:id': () => {
          moved = true;
          // A room takes no box: the server names only the shelf to draw again on the new room's map (Task 40).
          return { id: AREA, version: 3, boxesCleared: [SHELF] };
        },
        'PUT branches/:branchId/locations/:id/map': () => {
          drawn = true;
          return { id: SHELF, version: 5 };
        },
      },
    });
    await screen.findByText('Area Anak', { selector: '[data-location-name]' });
    fireEvent.click(within(node('Area Anak')).getByRole('button', { name: 'Ubah Area Anak' }));
    const dialog = await screen.findByRole('region', { name: 'Ubah lokasi' });
    fireEvent.change(within(dialog).getByLabelText('Jenis'), { target: { value: 'room' } });
    fireEvent.click(within(dialog).getByRole('button', { name: 'Simpan' }));
    await waitFor(() => expect(sent(requests, 'PATCH', `branches/${BRANCH_A}/locations/${AREA}`)).toHaveLength(1));
    expect(sent(requests, 'PATCH', `branches/${BRANCH_A}/locations/${AREA}`)[0]!.body).toEqual({ version: 2, parentId: null, kind: 'room' });
    const openMap = await screen.findByRole('button', { name: 'Buka peta Area Anak' });
    await waitFor(() => expect(node('Area Anak').parentElement!.closest('li')).toBeNull());
    const row = (name: string): string => node(name).querySelector('[data-location-row]')!.textContent ?? '';
    // The new room itself takes no box, so it is never marked; its shelf is.
    expect(row('Area Anak')).not.toContain('Perlu digambar ulang');
    expect(row('Rak 800')).toContain('Perlu digambar ulang');

    fireEvent.click(openMap);
    const editor = await screen.findByRole('region', { name: 'Peta rak Area Anak' });
    expect(within(editor).getByText('Perlu digambar ulang')).toBeTruthy();
    fireEvent.click(within(editor).getByRole('button', { name: 'Buat kotak' }));
    fireEvent.click(within(editor).getByRole('button', { name: 'Simpan kotak' }));
    await waitFor(() => expect(sent(requests, 'PUT', `branches/${BRANCH_A}/locations/${SHELF}/map`)).toHaveLength(1));
    expect(await within(editor).findByText('Kotak peta disimpan.')).toBeTruthy();
    // Every box the move cleared is drawn again: the notice and the marks are gone, without a reload.
    await waitFor(() => expect(screen.queryByRole('button', { name: 'Buka peta Area Anak' })).toBeNull());
    expect(screen.queryByText('Perlu digambar ulang')).toBeNull();
    expect(row('Rak 800')).not.toContain('Perlu digambar ulang');
  });

  it('a field error of the server lands on its field (invalid_parent)', async () => {
    startLocations({
      routes: { 'PATCH branches/:branchId/locations/:id': () => problem(422, 'VALIDATION_FAILED', { errors: [{ path: 'parentId', code: 'invalid_parent' }] }) },
    });
    await screen.findByText('Rak 900', { selector: '[data-location-name]' });
    fireEvent.click(within(node('Rak 900')).getByRole('button', { name: 'Ubah Rak 900' }));
    const dialog = await screen.findByRole('region', { name: 'Ubah lokasi' });
    fireEvent.change(within(dialog).getByLabelText('Di dalam'), { target: { value: AREA } });
    fireEvent.click(within(dialog).getByRole('button', { name: 'Simpan' }));
    expect(await within(dialog).findByText('Lokasi induk ini tidak dapat dipakai: sudah diarsipkan, di cabang lain, atau jenisnya tidak sesuai.')).toBeTruthy();
  });
});
