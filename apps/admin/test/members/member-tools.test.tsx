import type { BranchView } from '@altis/shared/api/branches';
import type { MemberListItem, MemberTypeView } from '@altis/shared/api/members';
import type { StationView } from '@altis/shared/api/visits';
import { fireEvent, screen, waitFor } from '@testing-library/react';
import { afterEach, beforeAll, describe, expect, it, vi } from 'vitest';
import { parseClassPairs } from '@/screens/members/bulk';
import { adminMe, startApp } from '../fake-api';

// The member tools and visits screens, their main paths: the member list's bulk bar (select two members, extend them,
// see the refusal), the class pairs of the promotion, the guestbook stations (a new station shows its code once), and
// the staff check-in of Kunjungan.

beforeAll(async () => {
  await Promise.all([import('@/screens/members/list'), import('@/screens/visits/visits')]);
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
