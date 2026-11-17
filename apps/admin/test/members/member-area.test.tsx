import type { MemberTypeView, MemberView } from '@altis/shared/api/members';
import { fireEvent, screen, waitFor, within } from '@testing-library/react';
import { afterEach, beforeAll, describe, expect, it, vi } from 'vitest';
import { adminMe, problem, startApp } from '../fake-api';

// The admin side of the OPAC member area: a member type's OPAC options (holds, their limit, online renewal) are sent
// with the type, and staff set or remove a member's OPAC password from the member's page (a weak password is said on
// its field; the page tells what happened).

beforeAll(async () => {
  await Promise.all([import('@/screens/members/edit'), import('@/screens/members/types')]);
});

afterEach(() => {
  vi.unstubAllGlobals();
  vi.restoreAllMocks();
});

const TYPE_ID = '01JZ0000000000000000000T01';
const MEMBER_ID = '01JZ0000000000000000000N01';

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
  memberCount: 12,
  archived: false,
  version: 1,
};

const MEMBER: MemberView = {
  id: MEMBER_ID,
  memberNo: 'B 001',
  type: { id: TYPE_ID, code: 'SISWA', nameId: 'Siswa', nameEn: 'Student', loanLimit: 3 },
  homeBranchId: null,
  storedStatus: 'active',
  status: 'active',
  statusNote: null,
  name: 'Siti Aminah',
  gender: null,
  birthDate: null,
  identityNo: null,
  institution: null,
  className: '8B',
  email: null,
  phone: null,
  address: null,
  postalCode: null,
  mailingAddress: null,
  notes: null,
  photoFileId: null,
  locale: 'id',
  joinedOn: '2026-11-15',
  validFrom: '2026-11-15',
  expiresOn: '2027-11-15',
  openLoans: 0,
  source: 'manual',
  archived: false,
  createdAt: 1_763_164_800_000,
  updatedAt: 1_763_164_800_000,
  version: 1,
};

describe('Tipe Anggota: the OPAC options', () => {
  it('sends only the changed OPAC options of a type', async () => {
    const app = startApp({
      me: adminMe(),
      path: '/admin/anggota/tipe',
      routes: {
        'GET members/types': () => ({ items: [SISWA] }),
        'PATCH members/types/:id': () => ({ id: TYPE_ID, version: 2 }),
      },
    });
    fireEvent.click(await screen.findByRole('button', { name: /Ubah/ }));
    // The form opens in the page, above the table (no dialog).
    expect(screen.queryByRole('dialog')).toBeNull();
    const dialog = await screen.findByRole('form', { name: /^Ubah tipe anggota/ });
    const renew = within(dialog).getByLabelText('Boleh memperpanjang pinjaman sendiri lewat OPAC') as HTMLInputElement;
    expect(renew.checked).toBe(true);
    fireEvent.click(renew);
    fireEvent.change(within(dialog).getByLabelText('Batas reservasi aktif'), { target: { value: '5' } });
    fireEvent.click(within(dialog).getByRole('button', { name: 'Simpan tipe' }));
    await waitFor(() => expect(app.requests.some((r) => r.method === 'PATCH')).toBe(true));
    expect(app.requests.find((r) => r.method === 'PATCH')?.body).toEqual({ version: 1, holdsLimit: 5, onlineRenewal: false });
  });
});

describe("the member's OPAC password", () => {
  it('a weak password is said on its field; a saved one ends with a notice, a removal sends null', async () => {
    let calls = 0;
    const app = startApp({
      me: adminMe(),
      path: `/admin/anggota/${MEMBER_ID}`,
      routes: {
        'GET members/types': () => ({ items: [SISWA] }),
        'GET branches': () => ({ items: [] }),
        'GET members/:id': () => MEMBER,
        'GET members/:id/events': () => ({ items: [], nextCursor: null }),
        'PUT members/:id/password': () => {
          calls += 1;
          return calls === 1 ? problem(422, 'PASSWORD_TOO_WEAK', { reason: 'common' }) : { id: MEMBER_ID, version: 2 };
        },
      },
    });
    fireEvent.keyDown(await screen.findByRole('button', { name: 'Tindakan lain' }), { key: 'Enter' });
    fireEvent.click(await screen.findByRole('menuitem', { name: 'Atur kata sandi OPAC…' }));
    // The form opens in the page under the head, not in a dialog.
    let dialog = await screen.findByRole('form', { name: 'Kata sandi OPAC' });
    expect(screen.queryByRole('dialog')).toBeNull();
    fireEvent.change(within(dialog).getByLabelText('Kata sandi baru'), { target: { value: 'password123' } });
    fireEvent.click(within(dialog).getByRole('button', { name: 'Simpan kata sandi' }));
    expect(await within(dialog).findByText('Kata sandi ini terlalu umum dan mudah ditebak. Pilih yang lain.')).toBeTruthy();
    fireEvent.change(within(dialog).getByLabelText('Kata sandi baru'), { target: { value: 'buku-pelajaran-9' } });
    fireEvent.click(within(dialog).getByRole('button', { name: 'Simpan kata sandi' }));
    expect(await screen.findByText('Kata sandi OPAC anggota disimpan.')).toBeTruthy();

    fireEvent.keyDown(screen.getByRole('button', { name: 'Tindakan lain' }), { key: 'Enter' });
    fireEvent.click(await screen.findByRole('menuitem', { name: 'Atur kata sandi OPAC…' }));
    dialog = await screen.findByRole('form', { name: 'Kata sandi OPAC' });
    fireEvent.click(within(dialog).getByRole('button', { name: 'Hapus kata sandi' }));
    expect(await screen.findByText(/Kata sandi OPAC anggota dihapus/)).toBeTruthy();
    const bodies = app.requests.filter((r) => r.method === 'PUT').map((r) => r.body);
    expect(bodies).toEqual([
      { password: 'password123', mustReset: true },
      { password: 'buku-pelajaran-9', mustReset: true },
      { password: null, mustReset: false },
    ]);
  });
});
