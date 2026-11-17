import type { BranchView } from '@altis/shared/api/branches';
import type { MemberListItem, MemberTypeView, MemberView } from '@altis/shared/api/members';
import type { StationView } from '@altis/shared/api/visits';
import { fireEvent, screen, waitFor, within } from '@testing-library/react';
import { afterEach, beforeAll, describe, expect, it, vi } from 'vitest';
import { parseClassPairs } from '@/screens/members/bulk';
import { adminMe, problem, startApp } from '../fake-api';

// The member tools and visits screens, their main paths: the member list's bulk bar (select two members, extend them,
// see the refusal) and a row's ⋯ menu (one member's page with its panel open, archive asked first), the class pairs of
// the promotion, the guestbook stations (a new station shows its code once), and the staff check-in of Kunjungan.

beforeAll(async () => {
  await Promise.all([import('@/screens/members/list'), import('@/screens/members/edit'), import('@/screens/visits/visits')]);
});

afterEach(() => {
  vi.unstubAllGlobals();
  vi.restoreAllMocks();
  window.localStorage.clear();
});

const TYPE_ID = '01JZ0000000000000000000T01';
const SISWA: MemberTypeView = {
  id: TYPE_ID,
  code: 'SISWA',
  nameId: 'Siswa',
  nameEn: 'Student',
  accredGroup: 'student',
  membershipDays: 365,
  loanLimit: 3,
  holdsAllowed: true,
  holdsLimit: 2,
  onlineRenewal: true,
  sortOrder: 0,
  memberCount: 2,
  archived: false,
  version: 1,
};
const BRANCH: BranchView = {
  id: '01JZ0000000000000000000B01',
  code: 'PUSAT',
  name: 'Perpustakaan Pusat',
  address: null,
  timezone: 'Asia/Jakarta',
  isDefault: true,
  archivedAt: null,
  version: 1,
  active: true,
};
const member = (n: number): MemberListItem => ({
  id: `01JZ0000000000000000000M0${n}`,
  memberNo: `S-00${n}`,
  name: `Anggota ${n}`,
  type: { id: TYPE_ID, code: 'SISWA', nameId: 'Siswa', nameEn: 'Student', loanLimit: 3 },
  className: '7A',
  status: 'active',
  expiresOn: '2027-07-01',
  photoFileId: null,
});

/** The whole member behind a row of the list. */
const view = (m: MemberListItem): MemberView => ({
  id: m.id,
  memberNo: m.memberNo,
  type: m.type,
  homeBranchId: null,
  storedStatus: 'active',
  status: m.status,
  statusNote: null,
  name: m.name,
  gender: null,
  birthDate: null,
  identityNo: null,
  institution: null,
  className: m.className,
  email: null,
  phone: null,
  address: null,
  postalCode: null,
  mailingAddress: null,
  notes: null,
  photoFileId: null,
  locale: 'id',
  joinedOn: '2026-07-01',
  validFrom: '2026-07-01',
  expiresOn: m.expiresOn,
  openLoans: 0,
  source: 'manual',
  archived: false,
  createdAt: 1_763_164_800_000,
  updatedAt: 1_763_164_800_000,
  version: 1,
});

describe('the member list bulk bar', () => {
  it('extends the selected members and lists the one refused, with its reason', async () => {
    const app = startApp({
      me: adminMe(),
      path: '/admin/anggota',
      routes: {
        'GET members/types': () => ({ items: [SISWA] }),
        'GET branches': () => ({ items: [BRANCH] }),
        'POST members/search': () => ({ items: [member(1), member(2)], nextCursor: null }),
        'POST members/bulk': () => ({ done: 1, refused: [{ id: member(2).id, reason: 'no_days' }] }),
      },
    });
    fireEvent.click(await screen.findByLabelText('Pilih Anggota 1'));
    fireEvent.click(screen.getByLabelText('Pilih Anggota 2'));
    expect(await screen.findByText('2 anggota dipilih')).toBeTruthy();
    fireEvent.click(screen.getByRole('button', { name: 'Perpanjang masa' }));
    fireEvent.change(screen.getByLabelText('Jumlah hari (kosong: sesuai tipe)'), { target: { value: '30' } });
    fireEvent.click(screen.getByRole('button', { name: 'Terapkan ke 2 anggota' }));
    expect(await screen.findByText('1 anggota diubah.')).toBeTruthy();
    expect(screen.getByText(/S-002 Anggota 2: Tipenya tanpa masa berlaku/)).toBeTruthy();
    const body = app.requests.find((r) => r.method === 'POST' && r.path === 'members/bulk')?.body;
    expect(body).toEqual({ action: 'extend', ids: [member(1).id, member(2).id], from: 'expiry', days: 30 });

    fireEvent.click(screen.getByRole('button', { name: 'Tambah ke antrean kartu' }));
    expect(await screen.findByText('2 anggota ditambahkan ke antrean kartu.')).toBeTruthy();
  });

  it('a row ⋯ menu: extend and suspend open the member page with that panel; a suspended member is reactivated', async () => {
    const suspended = { ...member(2), status: 'suspended' as const };
    const app = startApp({
      me: adminMe(),
      path: '/admin/anggota',
      routes: {
        'GET members/types': () => ({ items: [SISWA] }),
        'GET branches': () => ({ items: [BRANCH] }),
        'POST members/search': () => ({ items: [member(1), suspended], nextCursor: null }),
        'GET members/:id': (req) => (req.path.endsWith(member(1).id) ? view(member(1)) : { ...view(suspended), storedStatus: 'suspended', statusNote: 'Kartu hilang' }),
        'GET members/:id/events': () => ({ items: [], nextCursor: null }),
      },
    });
    const menu = async (name: string): Promise<HTMLElement> => {
      fireEvent.keyDown(await screen.findByRole('button', { name: `Tindakan untuk ${name}` }), { key: 'Enter' });
      return screen.findByRole('menu');
    };
    const first = await menu('Anggota 1');
    expect(within(first).getAllByRole('menuitem').map((i) => i.textContent)).toEqual([
      'Lihat dan ubah',
      'Layani di Meja Layanan',
      'Perpanjang masa…',
      'Tangguhkan…',
      'Arsipkan…',
    ]);
    fireEvent.click(within(first).getByRole('menuitem', { name: 'Perpanjang masa…' }));
    expect(await screen.findByRole('form', { name: 'Perpanjang masa keanggotaan' })).toBeTruthy();
    expect(app.router.state.location.pathname).toBe(`/admin/anggota/${member(1).id}`);

    await app.router.navigate({ href: '/admin/anggota' });
    const second = await menu('Anggota 2');
    expect(within(second).queryByRole('menuitem', { name: 'Tangguhkan…' })).toBeNull();
    fireEvent.click(within(second).getByRole('menuitem', { name: 'Aktifkan kembali…' }));
    expect(await screen.findByRole('form', { name: 'Aktifkan kembali Anggota 2?' })).toBeTruthy();
  });

  it('a row ⋯ menu archives one member after asking; open loans are refused above the table, with the way to the desk', async () => {
    let loans = 2;
    const app = startApp({
      me: adminMe(),
      path: '/admin/anggota',
      routes: {
        'GET members/types': () => ({ items: [SISWA] }),
        'GET branches': () => ({ items: [BRANCH] }),
        'POST members/search': () => ({ items: [member(1)], nextCursor: null }),
        'GET members/:id': () => ({ ...view(member(1)), openLoans: loans, version: 4 }),
        'DELETE members/:id': () => (loans > 0 ? problem(409, 'MEMBER_IN_USE') : { id: member(1).id, version: 5 }),
      },
    });
    const archive = async (): Promise<void> => {
      fireEvent.keyDown(await screen.findByRole('button', { name: 'Tindakan untuk Anggota 1' }), { key: 'Enter' });
      fireEvent.click(await screen.findByRole('menuitem', { name: 'Arsipkan…' }));
      const dialog = await screen.findByRole('alertdialog', { name: 'Arsipkan Anggota 1?' });
      fireEvent.click(within(dialog).getByRole('button', { name: 'Arsipkan' }));
    };
    await archive();
    const refused = await screen.findByRole('alert');
    expect(within(refused).getByText('Anggota 1 tidak dapat diarsipkan: masih ada 2 pinjaman terbuka.')).toBeTruthy();
    expect(within(refused).getByRole('link', { name: 'Layani di Meja Layanan' }).getAttribute('href')).toBe(`/admin/layanan?member=${member(1).id}`);

    loans = 0;
    await archive();
    expect(await screen.findByText('Anggota 1 diarsipkan.')).toBeTruthy();
    expect(screen.queryByText(/tidak dapat diarsipkan/)).toBeNull();
    expect(app.requests.filter((r) => r.method === 'DELETE').map((r) => r.body)).toEqual([{ version: 4 }, { version: 4 }]);
  });

  it('reads class pairs line by line; a line without an arrow is named', () => {
    expect(parseClassPairs('VII-A => VIII-A\n\nIX-A =>\n')).toEqual({
      pairs: [
        { from: 'VII-A', to: 'VIII-A' },
        { from: 'IX-A', to: null },
      ],
      bad: null,
    });
    expect(parseClassPairs('VII-A => VIII-A\nVIII-A').bad).toBe(2);
  });
});

describe('Perangkat Buku Tamu and Kunjungan', () => {
  it('a new station shows its activation code once', async () => {
    const stations: StationView[] = [];
    startApp({
      me: adminMe(),
      path: '/admin/layanan/buku-tamu',
      routes: {
        'GET branches': () => ({ items: [BRANCH] }),
        'GET visits/stations': () => ({ items: stations }),
        'POST branches/:branchId/visits/stations': () => {
          stations.push({
            id: '01JZ0000000000000000000S01',
            branchId: BRANCH.id,
            locationId: null,
            name: 'Pintu depan',
            paired: false,
            codeExpiresAt: 1_900_000_000_000,
            activatedAt: null,
            lastSeenAt: null,
            revokedAt: null,
            createdAt: 1_800_000_000_000,
          });
          return new Response(JSON.stringify({ id: '01JZ0000000000000000000S01', code: 'ABCD2345', expiresAt: 1_900_000_000_000 }), {
            status: 201,
            headers: { 'Content-Type': 'application/json', 'X-Altis-Build': '0.1.0' },
          });
        },
      },
    });
    fireEvent.change(await screen.findByLabelText('Nama perangkat'), { target: { value: 'Pintu depan' } });
    fireEvent.click(screen.getByRole('button', { name: 'Tambah perangkat' }));
    expect(await screen.findByText('ABCD-2345')).toBeTruthy();
    await waitFor(() => expect(screen.getByText('Menunggu kode')).toBeTruthy());
  });

  it('a new station can be placed in a room of the branch, and the list names its room', async () => {
    const ROOM = '01JZ0000000000000000000L01';
    const stations: StationView[] = [];
    const bodies: unknown[] = [];
    const room = { id: ROOM, branchId: BRANCH.id, parentId: null, kind: 'room', code: 'RB', name: 'Ruang Baca', shelfHint: null, classFrom: null, classTo: null, mapFileId: null, box: null, isPublic: true, sortOrder: 0, itemCount: 0, archived: false, version: 1 };
    startApp({
      me: adminMe(),
      path: '/admin/layanan/buku-tamu',
      routes: {
        'GET branches': () => ({ items: [BRANCH] }),
        'GET catalog/locations': () => ({ items: [room, { ...room, id: '01JZ0000000000000000000L02', kind: 'shelf', parentId: ROOM, code: 'RB-1', name: 'Rak 1' }] }),
        'GET visits/stations': () => ({ items: stations }),
        'POST branches/:branchId/visits/stations': (req) => {
          bodies.push(req.body);
          stations.push({ id: '01JZ0000000000000000000S02', branchId: BRANCH.id, locationId: ROOM, name: 'Ruang baca', paired: false, codeExpiresAt: 1_900_000_000_000, activatedAt: null, lastSeenAt: null, revokedAt: null, createdAt: 1_800_000_000_000 });
          return new Response(JSON.stringify({ id: '01JZ0000000000000000000S02', code: 'WXYZ2345', expiresAt: 1_900_000_000_000 }), {
            status: 201,
            headers: { 'Content-Type': 'application/json', 'X-Altis-Build': '0.1.0' },
          });
        },
      },
    });
    const select = (await screen.findByLabelText('Ruang')) as HTMLSelectElement;
    // Rooms only: a shelf is no place for a station.
    expect(Array.from(select.options).map((o) => o.textContent)).toEqual(['Tanpa ruang', 'Ruang Baca (RB)']);
    fireEvent.change(screen.getByLabelText('Nama perangkat'), { target: { value: 'Ruang baca' } });
    fireEvent.change(select, { target: { value: ROOM } });
    fireEvent.click(screen.getByRole('button', { name: 'Tambah perangkat' }));
    expect(await screen.findByText('WXYZ-2345')).toBeTruthy();
    expect(bodies).toEqual([{ name: 'Ruang baca', locationId: ROOM }]);
    await waitFor(() => expect(screen.getAllByText('Ruang Baca').length).toBeGreaterThan(0));
  });

  it('a staff check-in by member number greets the member, a repeat says it is not counted again', async () => {
    let calls = 0;
    const app = startApp({
      me: adminMe(),
      path: '/admin/layanan/kunjungan',
      routes: {
        'GET branches': () => ({ items: [BRANCH] }),
        'GET visits/summary': () => ({ on: '2026-11-15', total: 3, members: 2, guests: 1, bySource: { station: 3 } }),
        'GET visits': () => ({ items: [], nextCursor: null }),
        'POST branches/:branchId/visits/checkin': () => {
          calls += 1;
          return { outcome: calls === 1 ? 'recorded' : 'repeat', visitId: calls === 1 ? '01JZ0000000000000000000V01' : null, firstName: 'Budi', expired: false, suspended: false };
        },
      },
    });
    const input = await screen.findByLabelText('Nomor anggota');
    fireEvent.change(input, { target: { value: 'S-001' } });
    fireEvent.click(screen.getByRole('button', { name: 'Catat kunjungan' }));
    expect(await screen.findByText('Kunjungan Budi dicatat.')).toBeTruthy();
    fireEvent.change(screen.getByLabelText('Nomor anggota'), { target: { value: 'S-001' } });
    fireEvent.click(screen.getByRole('button', { name: 'Catat kunjungan' }));
    expect(await screen.findByText(/Budi sudah tercatat/)).toBeTruthy();
    expect(app.requests.find((r) => r.path === `branches/${BRANCH.id}/visits/checkin`)?.body).toEqual({ memberNo: 'S-001' });
  });
});
