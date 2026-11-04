import type { Permission } from '@altis/shared';
import type { BranchItem } from '@altis/shared/api/branches';
import type { LocationMapBody, LocationView } from '@altis/shared/api/catalog/locations';
import { fireEvent, screen, waitFor, within } from '@testing-library/react';
import { afterEach, beforeAll, describe, expect, it, vi } from 'vitest';
import { adminMe, problem, signedIn, startApp, type FakeHandler, type FakeRequest } from '../fake-api';

// The shelf map editor of Lokasi & Rak (Phase 2 spec §3.6, §13; plan Task 27; the API of Task 14): a room's floor plan
// (a `catalog.floor_plan` upload, put on the room with `PUT …/map {floorPlanFileId}`) and the boxes of its areas and
// shelves drawn over the picture in permil of its size, with the pointer (draw, move, resize by the corner) or the
// arrow keys (5‰, with Shift 1‰). "Simpan kotak" puts each changed box (`PUT …/map {box, version}`).

const mocks = vi.hoisted(() => ({ uploadFile: vi.fn() }));
vi.mock('@/lib/upload', async (importOriginal) => ({ ...(await importOriginal<typeof import('@/lib/upload')>()), uploadFile: mocks.uploadFile }));

// The screen is a lazy chunk: load it before the first test, whose first look for the page waits 1 s at most.
beforeAll(async () => {
  await import('@/screens/catalog/locations/index');
});

afterEach(() => {
  vi.unstubAllGlobals();
  vi.restoreAllMocks();
  mocks.uploadFile.mockReset();
});

const BRANCH = '01JZ00000000000000000BRA01';
const ROOM = '01JZ0000000000000000000R01';
const ROOM2 = '01JZ0000000000000000000R02';
const AREA = '01JZ0000000000000000000A01';
const SHELF = '01JZ0000000000000000000S01';
const SHELF2 = '01JZ0000000000000000000S02';
const PLAN = '01JZ0000000000000000000F01';
const NEW_PLAN = '01JZ0000000000000000000F02';

const BRANCHES: BranchItem[] = [
  { id: BRANCH, code: 'PUSAT', name: 'Perpustakaan Pusat', address: null, timezone: 'Asia/Jakarta', isDefault: true, archivedAt: null, version: 1 },
];

function location(o: Partial<LocationView> & Pick<LocationView, 'id' | 'kind' | 'code' | 'name'>): LocationView {
  return {
    branchId: BRANCH,
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

/** Ruang Baca (with a plan) › Area Anak › Rak 800 (with a box), Rak 900 (no box); Ruang Referensi (no plan). */
function tree(): LocationView[] {
  return [
    location({ id: ROOM, kind: 'room', code: 'R1', name: 'Ruang Baca', mapFileId: PLAN }),
    location({ id: AREA, kind: 'area', code: 'A1', name: 'Area Anak', parentId: ROOM, version: 2 }),
    location({ id: SHELF, kind: 'shelf', code: 'RAK-800', name: 'Rak 800', parentId: AREA, box: { x: 100, y: 200, w: 200, h: 200 }, version: 3 }),
    location({ id: SHELF2, kind: 'shelf', code: 'RAK-900', name: 'Rak 900', parentId: ROOM }),
    location({ id: ROOM2, kind: 'room', code: 'R2', name: 'Ruang Referensi' }),
  ];
}

/** The app at Lokasi & Rak over a fake tree that `PUT …/map` changes as the server would (`tree` may change it more). */
function startMap(o: { me?: ReturnType<typeof signedIn>; map?: FakeHandler; tree?: (rows: LocationView[]) => LocationView[] } = {}) {
  const rows = tree();
  const putMap: FakeHandler = (req) => {
    const row = rows.find((l) => l.id === req.params['id'])!;
    const body = req.body as LocationMapBody;
    if (body.floorPlanFileId !== undefined) row.mapFileId = body.floorPlanFileId;
    if (body.box !== undefined) row.box = body.box;
    row.version += 1;
    return { id: row.id, version: row.version };
  };
  return startApp({
    me: o.me ?? adminMe(),
    path: '/admin/catalog/locations',
    routes: {
      'GET branches': () => ({ items: BRANCHES }),
      'GET catalog/locations': () => ({ items: (o.tree ?? ((r) => r))(rows).map((l) => ({ ...l })) }),
      'PUT branches/:branchId/locations/:id/map': o.map ?? putMap,
    },
  });
}

const sent = (requests: FakeRequest[], method: string, path: string): FakeRequest[] => requests.filter((r) => r.method === method && r.path === path);

/** Opens the map of `room` and answers its region. */
async function openMap(room: string): Promise<HTMLElement> {
  fireEvent.click(await screen.findByRole('button', { name: `Peta ${room}` }));
  return screen.findByRole('region', { name: `Peta rak ${room}` });
}

/** The drawing surface of the map, laid out as a `width`×`height` picture at the page's top left. */
function surfaceOf(region: HTMLElement, width = 1000, height = 500): HTMLElement {
  const surface = region.querySelector<HTMLElement>('[data-map-surface]');
  expect(surface).not.toBeNull();
  vi.spyOn(surface!, 'getBoundingClientRect').mockReturnValue({ x: 0, y: 0, left: 0, top: 0, width, height, right: width, bottom: height, toJSON: () => ({}) });
  return surface!;
}

/** The selected box's position fields. */
function coords(region: HTMLElement): { x: string; y: string; w: string; h: string } {
  const value = (label: string): string => (within(region).getByLabelText(label) as HTMLInputElement).value;
  return { x: value('Kiri (‰)'), y: value('Atas (‰)'), w: value('Lebar (‰)'), h: value('Tinggi (‰)') };
}

describe('MapEditor', () => {
  it('turns a drag from (100, 100) to (300, 200) on a 1000×500 picture into the box {x: 100, y: 200, w: 200, h: 200}; arrow keys nudge it', async () => {
    const { requests } = startMap();
    const region = await openMap('Ruang Baca');
    expect(within(region).getByRole('img', { name: 'Denah Ruang Baca' }).getAttribute('src')).toBe(`/files/${PLAN}`);
    fireEvent.click(within(region).getByRole('radio', { name: 'Rak 900' }));
    const surface = surfaceOf(region);

    fireEvent.pointerDown(surface, { clientX: 100, clientY: 100, pointerId: 1, button: 0 });
    fireEvent.pointerMove(surface, { clientX: 300, clientY: 200, pointerId: 1 });
    fireEvent.pointerUp(surface, { clientX: 300, clientY: 200, pointerId: 1 });
    expect(coords(region)).toEqual({ x: '100', y: '200', w: '200', h: '200' });
    const box = within(region).getByRole('button', { name: 'Kotak Rak 900' });
    expect([box.style.left, box.style.top, box.style.width, box.style.height]).toEqual(['10%', '20%', '20%', '20%']);

    // 5‰ per arrow key, 1‰ with Shift.
    fireEvent.keyDown(box, { key: 'ArrowRight' });
    fireEvent.keyDown(box, { key: 'ArrowUp', shiftKey: true });
    expect(coords(region)).toEqual({ x: '105', y: '199', w: '200', h: '200' });
    expect(within(region).getByText('Diubah, belum disimpan')).toBeTruthy();

    fireEvent.click(within(region).getByRole('button', { name: 'Simpan kotak' }));
    await waitFor(() => expect(sent(requests, 'PUT', `branches/${BRANCH}/locations/${SHELF2}/map`)).toHaveLength(1));
    expect(sent(requests, 'PUT', `branches/${BRANCH}/locations/${SHELF2}/map`)[0]!.body).toEqual({ version: 1, box: { x: 105, y: 199, w: 200, h: 200 } });
    expect(await within(region).findByText('Kotak peta disimpan.')).toBeTruthy();
    // Only the changed box was put; the list is read again and shows it saved.
    expect(sent(requests, 'PUT', `branches/${BRANCH}/locations/${SHELF}/map`)).toHaveLength(0);
    await waitFor(() => expect(within(region).queryByText('Diubah, belum disimpan')).toBeNull());
  });

  it('moves a box by dragging it and resizes it by its corner; the fields keep it inside the picture', async () => {
    const { requests } = startMap();
    const region = await openMap('Ruang Baca');
    fireEvent.click(within(region).getByRole('radio', { name: 'Rak 800' }));
    const surface = surfaceOf(region);
    const box = within(region).getByRole('button', { name: 'Kotak Rak 800' });
    expect(coords(region)).toEqual({ x: '100', y: '200', w: '200', h: '200' });

    // Grab the box at (150‰, 300‰) and drop it 100‰ to the right and 100‰ lower.
    fireEvent.pointerDown(box, { clientX: 150, clientY: 150, pointerId: 1, button: 0 });
    fireEvent.pointerMove(surface, { clientX: 250, clientY: 200, pointerId: 1 });
    fireEvent.pointerUp(surface, { clientX: 250, clientY: 200, pointerId: 1 });
    expect(coords(region)).toEqual({ x: '200', y: '300', w: '200', h: '200' });

    // Its bottom-right corner, now at (400‰, 500‰), pulled to (500‰, 700‰).
    const handle = box.querySelector<HTMLElement>('[data-box-handle]')!;
    fireEvent.pointerDown(handle, { clientX: 400, clientY: 250, pointerId: 2, button: 0 });
    fireEvent.pointerMove(surface, { clientX: 500, clientY: 350, pointerId: 2 });
    fireEvent.pointerUp(surface, { clientX: 500, clientY: 350, pointerId: 2 });
    expect(coords(region)).toEqual({ x: '200', y: '300', w: '300', h: '400' });

    // A width that would leave the picture is cut at its edge.
    fireEvent.change(within(region).getByLabelText('Lebar (‰)'), { target: { value: '950' } });
    expect(coords(region).w).toBe('800');
    fireEvent.change(within(region).getByLabelText('Lebar (‰)'), { target: { value: '300' } });

    fireEvent.click(within(region).getByRole('button', { name: 'Simpan kotak' }));
    await waitFor(() => expect(sent(requests, 'PUT', `branches/${BRANCH}/locations/${SHELF}/map`)).toHaveLength(1));
    expect(sent(requests, 'PUT', `branches/${BRANCH}/locations/${SHELF}/map`)[0]!.body).toEqual({ version: 3, box: { x: 200, y: 300, w: 300, h: 400 } });
  });

  it('uploads a floor plan (catalog.floor_plan) and puts it on the room; a plan can be removed', async () => {
    mocks.uploadFile.mockResolvedValue({ uploadId: NEW_PLAN });
    const { requests } = startMap();
    let region = await openMap('Ruang Referensi');
    expect(within(region).getByText('Ruang ini belum punya denah. Unggah gambar denahnya untuk menggambar kotak rak.')).toBeTruthy();

    // Larger than the context's 5 MB: refused before anything is sent.
    const big = new File([new Uint8Array(5 * 1024 * 1024 + 1)], 'besar.png', { type: 'image/png' });
    fireEvent.change(within(region).getByLabelText('Unggah denah'), { target: { files: [big] } });
    expect(await within(region).findByText('Berkas denah lebih besar dari 5 MB.')).toBeTruthy();
    expect(mocks.uploadFile).not.toHaveBeenCalled();

    const file = new File(['png'], 'denah.png', { type: 'image/png' });
    fireEvent.change(within(region).getByLabelText('Unggah denah'), { target: { files: [file] } });
    await waitFor(() => expect(sent(requests, 'PUT', `branches/${BRANCH}/locations/${ROOM2}/map`)).toHaveLength(1));
    expect(mocks.uploadFile).toHaveBeenCalledWith(file, { context: 'catalog.floor_plan' });
    expect(sent(requests, 'PUT', `branches/${BRANCH}/locations/${ROOM2}/map`)[0]!.body).toEqual({ version: 1, floorPlanFileId: NEW_PLAN });
    expect(await within(region).findByText('Denah disimpan.')).toBeTruthy();
    expect((await within(region).findByRole('img', { name: 'Denah Ruang Referensi' })).getAttribute('src')).toBe(`/files/${NEW_PLAN}`);

    region = await openMap('Ruang Baca');
    fireEvent.click(within(region).getByRole('button', { name: 'Hapus denah' }));
    await waitFor(() => expect(sent(requests, 'PUT', `branches/${BRANCH}/locations/${ROOM}/map`)).toHaveLength(1));
    expect(sent(requests, 'PUT', `branches/${BRANCH}/locations/${ROOM}/map`)[0]!.body).toEqual({ version: 1, floorPlanFileId: null });
    expect(await within(region).findByText('Denah dihapus.')).toBeTruthy();
  });

  it('a stale version is refused: the problem shows, the drawing stays unsaved and saving again sends the current version', async () => {
    let refused = false;
    const { requests } = startMap({
      map: (req) => {
        if (refused) return { id: req.params['id'], version: 9 };
        refused = true;
        return problem(409, 'CONFLICT_STALE');
      },
      tree: (rows) => (refused ? rows.map((l) => (l.id === SHELF2 ? { ...l, version: 8 } : l)) : rows),
    });
    const region = await openMap('Ruang Baca');
    fireEvent.click(within(region).getByRole('radio', { name: 'Rak 900' }));
    const surface = surfaceOf(region);
    fireEvent.pointerDown(surface, { clientX: 100, clientY: 100, pointerId: 1, button: 0 });
    fireEvent.pointerUp(surface, { clientX: 200, clientY: 200, pointerId: 1 });
    const gets = (): number => sent(requests, 'GET', 'catalog/locations').length;
    const before = gets();
    fireEvent.click(within(region).getByRole('button', { name: 'Simpan kotak' }));
    expect(await within(region).findByText('Data ini sudah diubah oleh orang lain. Muat ulang, lalu coba lagi.')).toBeTruthy();
    expect(within(region).getByText('Diubah, belum disimpan')).toBeTruthy();
    expect(sent(requests, 'PUT', `branches/${BRANCH}/locations/${SHELF2}/map`)[0]!.body).toEqual({ version: 1, box: { x: 100, y: 200, w: 100, h: 200 } });
    // The tree is read again, so the drawing goes with the version the server holds now.
    await waitFor(() => expect(gets()).toBe(before + 1));

    fireEvent.click(within(region).getByRole('button', { name: 'Simpan kotak' }));
    await waitFor(() => expect(sent(requests, 'PUT', `branches/${BRANCH}/locations/${SHELF2}/map`)).toHaveLength(2));
    expect(sent(requests, 'PUT', `branches/${BRANCH}/locations/${SHELF2}/map`)[1]!.body).toEqual({ version: 8, box: { x: 100, y: 200, w: 100, h: 200 } });
    expect(await within(region).findByText('Kotak peta disimpan.')).toBeTruthy();
  });

  it('a stale plan change is refused and the tree read again, so trying again sends the room’s current version', async () => {
    let refused = false;
    const { requests } = startMap({
      map: (req) => {
        if (refused) return { id: req.params['id'], version: 4 };
        refused = true;
        return problem(409, 'CONFLICT_STALE');
      },
      tree: (rows) => (refused ? rows.map((l) => (l.id === ROOM ? { ...l, name: 'Ruang Baca Utama', version: 3 } : l)) : rows),
    });
    const region = await openMap('Ruang Baca');
    fireEvent.click(within(region).getByRole('button', { name: 'Hapus denah' }));
    expect(await within(region).findByText('Data ini sudah diubah oleh orang lain. Muat ulang, lalu coba lagi.')).toBeTruthy();
    expect(await screen.findByRole('region', { name: 'Peta rak Ruang Baca Utama' })).toBe(region);

    fireEvent.click(within(region).getByRole('button', { name: 'Hapus denah' }));
    await waitFor(() => expect(sent(requests, 'PUT', `branches/${BRANCH}/locations/${ROOM}/map`)).toHaveLength(2));
    expect(sent(requests, 'PUT', `branches/${BRANCH}/locations/${ROOM}/map`).map((r) => r.body)).toEqual([
      { version: 1, floorPlanFileId: null },
      { version: 3, floorPlanFileId: null },
    ]);
    expect(await within(region).findByText('Denah dihapus.')).toBeTruthy();
  });

  it('read only without catalog.locations.manage: the plan and the boxes show, nothing can be drawn', async () => {
    const { requests } = startMap({ me: signedIn({ permissions: ['catalog.records.read'] as Permission[] }) });
    const region = await openMap('Ruang Baca');
    expect(within(region).getByRole('img', { name: 'Denah Ruang Baca' })).toBeTruthy();
    // The boxes are pictures here, not controls.
    expect(within(region).getByRole('img', { name: 'Kotak Rak 800' })).toBeTruthy();
    expect(within(region).queryByRole('button', { name: 'Kotak Rak 800' })).toBeNull();
    expect(within(region).queryByLabelText('Unggah denah')).toBeNull();
    expect(within(region).queryByRole('button', { name: 'Simpan kotak' })).toBeNull();
    expect(within(region).queryByRole('radio')).toBeNull();
    const surface = surfaceOf(region);
    fireEvent.pointerDown(surface, { clientX: 100, clientY: 100, pointerId: 1, button: 0 });
    fireEvent.pointerUp(surface, { clientX: 300, clientY: 200, pointerId: 1 });
    expect(within(region).queryByText('Diubah, belum disimpan')).toBeNull();
    expect(requests.filter((r) => r.method !== 'GET')).toHaveLength(0);
  });
});

// A move (Task 14, P1 T14): a location a move takes to another room loses its box there, and its version goes up. A box
// drawn for it on this room's plan and not saved yet no longer belongs to this map: it is neither counted (the unsaved
// text, the dirty guard, the question before closing, L15) nor saved onto the location in its new room.
describe('MapEditor: a location moved to another room', () => {
  it("an area moved out of the room takes its shelf's unsaved box with it; the other unsaved box is still saved", async () => {
    let moved = false;
    const { requests, queryClient } = startMap({
      tree: (rows) =>
        moved
          ? rows.map((l) =>
              l.id === AREA ? { ...l, parentId: ROOM2, version: l.version + 1 } : l.id === SHELF ? { ...l, box: null, version: l.version + 1 } : l,
            )
          : rows,
    });
    const region = await openMap('Ruang Baca');
    fireEvent.keyDown(within(region).getByRole('button', { name: 'Kotak Rak 800' }), { key: 'ArrowRight' });
    fireEvent.click(within(region).getByRole('radio', { name: 'Rak 900' }));
    fireEvent.click(within(region).getByRole('button', { name: 'Buat kotak' }));
    expect(within(region).getByText('2 kotak belum disimpan.')).toBeTruthy();

    // The tree's edit dialog moved Area Anak (and Rak 800 below it) to Ruang Referensi; the page read the tree again.
    moved = true;
    await queryClient.invalidateQueries({ queryKey: ['catalog', 'locations'] });
    await waitFor(() => expect(within(region).queryByRole('radio', { name: 'Rak 800' })).toBeNull());
    await waitFor(() => expect(within(region).getByText('1 kotak belum disimpan.')).toBeTruthy());

    fireEvent.click(within(region).getByRole('button', { name: 'Simpan kotak' }));
    expect(await within(region).findByText('Kotak peta disimpan.')).toBeTruthy();
    expect(sent(requests, 'PUT', `branches/${BRANCH}/locations/${SHELF2}/map`)).toHaveLength(1);
    expect(sent(requests, 'PUT', `branches/${BRANCH}/locations/${SHELF}/map`)).toHaveLength(0);
  });

  it('a shelf someone else moved: the stale refusal reads the tree again, and saving again does not put the old-room box', async () => {
    let refused = false;
    const { requests } = startMap({
      map: () => {
        refused = true;
        return problem(409, 'CONFLICT_STALE');
      },
      tree: (rows) => (refused ? rows.map((l) => (l.id === SHELF2 ? { ...l, parentId: ROOM2, version: 8 } : l)) : rows),
    });
    const region = await openMap('Ruang Baca');
    fireEvent.click(within(region).getByRole('radio', { name: 'Rak 900' }));
    fireEvent.click(within(region).getByRole('button', { name: 'Buat kotak' }));
    expect(within(region).getByText('1 kotak belum disimpan.')).toBeTruthy();
    fireEvent.click(within(region).getByRole('button', { name: 'Simpan kotak' }));
    expect(await within(region).findByText('Data ini sudah diubah oleh orang lain. Muat ulang, lalu coba lagi.')).toBeTruthy();

    // Read again: Rak 900 is in Ruang Referensi now, so nothing is left to save on this map.
    await waitFor(() => expect(within(region).queryByRole('radio', { name: 'Rak 900' })).toBeNull());
    await waitFor(() => expect(within(region).queryByText('1 kotak belum disimpan.')).toBeNull());
    const save = within(region).getByRole('button', { name: 'Simpan kotak' }) as HTMLButtonElement;
    expect(save.disabled).toBe(true);
    fireEvent.click(save);
    // Closing the map asks nothing: no box of this room is unsaved.
    fireEvent.click(within(region).getByRole('button', { name: 'Tutup peta' }));
    await waitFor(() => expect(screen.queryByRole('region', { name: 'Peta rak Ruang Baca' })).toBeNull());
    expect(screen.queryByRole('alertdialog')).toBeNull();
    expect(sent(requests, 'PUT', `branches/${BRANCH}/locations/${SHELF2}/map`)).toHaveLength(1);
  });
});

// L15: unsaved boxes are never dropped without a question: closing the map, opening another room's map or another
// branch asks first; the archived toggle keeps the map (the list stays shown while it is read again).
describe('MapEditor: unsaved boxes (L15)', () => {
  /** Opens Ruang Baca's map and moves Rak 800's box by one arrow key: one unsaved box. */
  async function oneUnsaved(): Promise<HTMLElement> {
    const region = await openMap('Ruang Baca');
    fireEvent.keyDown(within(region).getByRole('button', { name: 'Kotak Rak 800' }), { key: 'ArrowRight' });
    expect(within(region).getByText('1 kotak belum disimpan.')).toBeTruthy();
    return region;
  }

  it('closing the map with unsaved boxes asks first; "Batal" keeps them, confirming closes it', async () => {
    startMap();
    const region = await oneUnsaved();
    fireEvent.click(within(region).getByRole('button', { name: 'Tutup peta' }));
    const ask = await screen.findByRole('alertdialog', { name: 'Buang kotak yang belum disimpan?' });
    fireEvent.click(within(ask).getByRole('button', { name: 'Batal' }));
    await waitFor(() => expect(screen.queryByRole('alertdialog')).toBeNull());
    expect(within(screen.getByRole('region', { name: 'Peta rak Ruang Baca' })).getByText('1 kotak belum disimpan.')).toBeTruthy();
    fireEvent.click(within(screen.getByRole('region', { name: 'Peta rak Ruang Baca' })).getByRole('button', { name: 'Tutup peta' }));
    fireEvent.click(within(await screen.findByRole('alertdialog')).getByRole('button', { name: 'Buang perubahan' }));
    await waitFor(() => expect(screen.queryByRole('region', { name: 'Peta rak Ruang Baca' })).toBeNull());
  });

  it("opening another room's map with unsaved boxes asks first", async () => {
    startMap();
    await oneUnsaved();
    fireEvent.click(screen.getByRole('button', { name: 'Peta Ruang Referensi' }));
    const ask = await screen.findByRole('alertdialog', { name: 'Buang kotak yang belum disimpan?' });
    // Still open behind the question (the modal hides the page from the accessibility tree meanwhile).
    expect(screen.getByRole('region', { name: 'Peta rak Ruang Baca', hidden: true })).toBeTruthy();
    fireEvent.click(within(ask).getByRole('button', { name: 'Buang perubahan' }));
    expect(await screen.findByRole('region', { name: 'Peta rak Ruang Referensi' })).toBeTruthy();
  });

  it('the archived toggle keeps the map and its unsaved boxes', async () => {
    startMap();
    await oneUnsaved();
    fireEvent.click(screen.getByLabelText('Tampilkan yang diarsipkan'));
    await new Promise((r) => setTimeout(r, 50));
    const region = await screen.findByRole('region', { name: 'Peta rak Ruang Baca' });
    expect(within(region).getByText('1 kotak belum disimpan.')).toBeTruthy();
  });

  it('another branch with unsaved boxes asks first', async () => {
    const OTHER = '01JZ00000000000000000BRB01';
    const { router } = startApp({
      me: adminMe(),
      path: '/admin/catalog/locations',
      routes: {
        'GET branches': () => ({ items: [...BRANCHES, { ...BRANCHES[0]!, id: OTHER, code: 'UTARA', name: 'Cabang Utara', isDefault: false }] }),
        'GET catalog/locations': (req) => ({ items: req.query.get('branchId') === BRANCH ? tree() : [] }),
      },
    });
    await oneUnsaved();
    fireEvent.change(screen.getByLabelText('Cabang'), { target: { value: OTHER } });
    const ask = await screen.findByRole('alertdialog', { name: 'Buang kotak yang belum disimpan?' });
    expect(router.state.location.search).toEqual({});
    fireEvent.click(within(ask).getByRole('button', { name: 'Buang perubahan' }));
    await waitFor(() => expect(router.state.location.search).toEqual({ branchId: OTHER }));
  });
});
