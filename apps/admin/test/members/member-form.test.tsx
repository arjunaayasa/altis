import type { BranchView } from '@altis/shared/api/branches';
import type { MemberTypeView, MemberView } from '@altis/shared/api/members';
import { fireEvent, screen } from '@testing-library/react';
import { afterEach, beforeAll, describe, expect, it, vi } from 'vitest';
import { adminMe, problem, startApp } from '../fake-api';

// Anggota baru: the form is checked with the shared contract first, sends only what was filled (no gender unless
// chosen, no dates unless typed: the server counts them from today and the type), shows the server's field errors on
// their fields (a taken member number), and opens the new member's page after the save.

beforeAll(async () => {
  await Promise.all([import('@/screens/members/edit')]);
});

afterEach(() => {
  vi.unstubAllGlobals();
  vi.restoreAllMocks();
});

const TYPE_ID = '01JZ0000000000000000000T01';
const NEW_ID = '01JZ0000000000000000000N01';

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

const BRANCH: BranchView = {
  id: 'B1',
  code: 'PUSAT',
  name: 'Perpustakaan Pusat',
  address: null,
  timezone: 'Asia/Jakarta',
  isDefault: true,
  archivedAt: null,
  version: 1,
  active: true,
};

const CREATED: MemberView = {
  id: NEW_ID,
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

describe('Anggota baru', () => {
  it('shows a taken number on its field, then saves only what was filled and opens the member', async () => {
    let attempts = 0;
    const app = startApp({
      me: adminMe(),
      path: '/admin/anggota/baru',
      routes: {
        'GET members/types': () => ({ items: [SISWA] }),
        'GET branches': () => ({ items: [BRANCH] }),
        'POST members': () => {
          attempts += 1;
          if (attempts === 1) return problem(422, 'VALIDATION_FAILED', { errors: [{ path: 'memberNo', code: 'taken' }] });
          return new Response(JSON.stringify({ id: NEW_ID, version: 1 }), { status: 201, headers: { 'Content-Type': 'application/json', 'X-Altis-Build': '0.1.0' } });
        },
        'GET members/:id': () => CREATED,
        'GET members/:id/events': () => ({ items: [], nextCursor: null }),
      },
    });

    expect(await screen.findByRole('heading', { name: 'Anggota baru' })).toBeTruthy();
    // The contract's own checks first: nothing is sent without the required fields.
    fireEvent.click(screen.getByRole('button', { name: 'Simpan' }));
    expect(await screen.findAllByText('Wajib diisi.')).not.toHaveLength(0);
    expect(app.requests.filter((r) => r.method === 'POST')).toHaveLength(0);

    fireEvent.change(screen.getByLabelText('Nomor anggota'), { target: { value: 'b 001' } });
    await screen.findByRole('option', { name: 'SISWA — Siswa' });
    fireEvent.change(screen.getByLabelText('Tipe anggota'), { target: { value: TYPE_ID } });
    fireEvent.change(screen.getByLabelText('Nama'), { target: { value: '  Siti Aminah ' } });
    fireEvent.change(screen.getByLabelText('Kelas'), { target: { value: '8B' } });
    // Gender has no default: "Tidak diisi" is the one checked.
    expect((screen.getByLabelText('Tidak diisi') as HTMLInputElement).checked).toBe(true);

    fireEvent.click(screen.getByRole('button', { name: 'Simpan' }));
    expect(await screen.findByText('Sudah dipakai. Gunakan yang lain.')).toBeTruthy();
    expect(screen.getByLabelText('Nomor anggota').getAttribute('aria-invalid')).toBe('true');

    fireEvent.click(screen.getByRole('button', { name: 'Simpan' }));
    expect(await screen.findByRole('heading', { name: 'Siti Aminah' })).toBeTruthy();
    expect(screen.getByText('Anggota ditambahkan.')).toBeTruthy();

    const body = app.requests.filter((r) => r.method === 'POST' && r.path === 'members')[1]?.body as Record<string, unknown>;
    expect(body).toMatchObject({ memberNo: 'b 001', memberTypeId: TYPE_ID, name: 'Siti Aminah', className: '8B', gender: null, homeBranchId: null, locale: 'id' });
    expect(body).not.toHaveProperty('joinedOn');
    expect(body).not.toHaveProperty('expiresOn');
  });
});
