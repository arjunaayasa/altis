import type { BranchView } from '@altis/shared/api/branches';
import type { CalendarResponse, DeskMemberView, InLibraryUseResponse, LoanResponse, PolicyResolveResponse, PolicyView } from '@altis/shared/api/circulation';
import { fireEvent, screen, waitFor, within } from '@testing-library/react';
import { afterEach, beforeAll, beforeEach, describe, expect, it, vi } from 'vitest';
import { adminMe, problem, startApp, type FakeHandler } from '../fake-api';

// The circulation core's screens: Baca di Tempat counts an item read in place; the desk forces a refused loan with a
// reason; Kalender adds closed days; Aturan Peminjaman explains which rule applies; Surat Bebas Pustaka checks the
// members and prints their letters.

beforeAll(async () => {
  await import('@/screens/circulation/desk');
  await import('@/screens/circulation/calendar');
  await import('@/screens/circulation/policies');
  await import('@/screens/members/clearances');
});

beforeEach(() => {
  localStorage.clear();
});

afterEach(() => {
  vi.unstubAllGlobals();
  vi.restoreAllMocks();
});

const BRANCH = 'B1';
const MEMBER_ID = '01JZ0000000000000000000A01';

const BRANCH_VIEW: BranchView = {
  id: BRANCH,
  code: 'PUSAT',
  name: 'Perpustakaan Pusat',
  address: null,
  timezone: 'Asia/Jakarta',
  isDefault: true,
  archivedAt: null,
  version: 1,
  active: true,
};

const MEMBER: DeskMemberView = {
  id: MEMBER_ID,
  memberNo: 'A001',
  name: 'Budi Santoso',
  type: { id: '01JZ0000000000000000000T01', code: 'SISWA', nameId: 'Siswa', nameEn: 'Student', loanLimit: 3 },
  className: '7A',
  status: 'active',
  statusNote: null,
  expiresOn: '2027-06-30',
  photoFileId: null,
  notes: null,
  counts: { openLoans: 0, overdue: 0, holdsReady: 0 },
  canBorrow: true,
  borrowRefusal: null,
  loans: [],
  holds: [],
  warnings: [],
  charges: { balance: '0.00', currency: 'IDR', charges: [], payments: [], blocked: null },
};

function start(routes: Record<string, FakeHandler>, path: string) {
  return startApp({
    me: adminMe(),
    path,
    routes: {
      'GET branches': () => ({ items: [BRANCH_VIEW] }),
      'POST branches/:branchId/circulation/members/search': () => ({ items: [] }),
      'GET members/types': () => ({ items: [] }),
      'GET catalog/collection-types': () => ({ items: [] }),
      'GET catalog/material-types': () => ({ items: [] }),
      ...routes,
    },
  });
}

async function scan(code: string): Promise<void> {
  const box = await screen.findByLabelText(/^Pindai/);
  fireEvent.change(box, { target: { value: code } });
  fireEvent.click(screen.getByRole('button', { name: 'Proses' }));
}

describe('Baca di Tempat and the desk', () => {
  it('counts each item read in place, and says when one is out on loan', async () => {
    let n = 0;
    const app = start(
      {
        'POST branches/:branchId/circulation/in-library-uses': (): InLibraryUseResponse => {
          n += 1;
          return {
            id: `01JZ00000000000000000000U${n}`,
            item: { id: '01JZ0000000000000000000I01', barcode: `B000${n}`, callNumber: null },
            record: { id: '01JZ0000000000000000000R01', title: n === 1 ? 'Laskar Pelangi' : 'Bumi Manusia' },
            status: 'available',
            ...(n === 2 ? { warnings: [{ code: 'item_on_loan' as const }] } : {}),
          };
        },
      },
      '/admin/layanan/baca',
    );
    expect(await screen.findByRole('heading', { name: 'Baca di Tempat' })).toBeTruthy();
    await scan('b0001');
    expect(await screen.findByText('Dicatat dibaca di tempat: Laskar Pelangi', { selector: 'p.text-xl' })).toBeTruthy();
    await scan('B0002');
    expect(await screen.findByText('Dicatat dibaca di tempat: Bumi Manusia', { selector: 'p.text-xl' })).toBeTruthy();
    expect(screen.getAllByText('Eksemplar ini tercatat sedang dipinjam. Kembalikan dulu bila memang sudah di perpustakaan.').length).toBeGreaterThan(0);
    const table = screen.getByRole('table', { name: 'Eksemplar yang dibaca di tempat kali ini' });
    expect(within(table).getAllByRole('row')).toHaveLength(3);
    expect(app.requests.filter((r) => r.path.endsWith('/in-library-uses')).map((r) => r.body)).toEqual([{ barcode: 'b0001' }, { barcode: 'B0002' }]);
  });

  it('a refusal the desk may force offers "Paksa pinjam"; the reason is asked and the loan sent again with it', async () => {
    const loan: LoanResponse = {
      id: '01JZ0000000000000000000L01',
      version: 0,
      dueOn: '2026-11-22',
      item: { id: '01JZ0000000000000000000I01', barcode: 'REF-1', callNumber: null },
      record: { id: '01JZ0000000000000000000R01', title: 'Atlas Indonesia' },
      overrides: ['policy'],
    };
    const app = start(
      {
        'POST branches/:branchId/circulation/members/lookup': () => MEMBER,
        'GET branches/:branchId/circulation/members/:memberId': () => MEMBER,
        'POST branches/:branchId/circulation/loans': (req) =>
          (req.body as { override?: unknown }).override === undefined
            ? problem(409, 'CIRC_NOT_LOANABLE', { reason: 'policy' })
            : new Response(JSON.stringify(loan), { status: 201, headers: { 'Content-Type': 'application/json', 'X-Altis-Build': '0.1.0' } }),
      },
      '/admin/layanan',
    );
    await scan('A001');
    expect(await screen.findByText('Anggota dimuat: Budi Santoso')).toBeTruthy();
    await scan('REF-1');
    fireEvent.click(await screen.findByRole('button', { name: 'Paksa pinjam (Enter)' }));
    const note = await screen.findByLabelText('Alasan memaksa (Aturan melarang pinjaman)');
    fireEvent.change(note, { target: { value: 'Untuk lomba cerdas cermat' } });
    fireEvent.click(screen.getByRole('button', { name: 'Pinjamkan' }));
    expect(await screen.findByText(/^Dipinjam: Atlas Indonesia — jatuh tempo/, { selector: 'p.text-xl' })).toBeTruthy();
    const sent = app.requests.filter((r) => r.path.endsWith('/circulation/loans')).map((r) => r.body);
    expect(sent).toEqual([
      { memberId: MEMBER_ID, barcode: 'REF-1' },
      { memberId: MEMBER_ID, barcode: 'REF-1', override: { reasons: ['policy'], note: 'Untuk lomba cerdas cermat' } },
    ]);
    await waitFor(() => expect(screen.getAllByText(/Dicatat sebagai: Aturan melarang pinjaman\./).length).toBeGreaterThan(0));
  });
});

describe('Kalender', () => {
  it('lists the closed days, marks them in the month, and adds a date range', async () => {
    const answer: CalendarResponse = {
      rules: [{ id: '01JZ0000000000000000000C01', kind: 'weekly', name: 'Minggu', weekday: 7, dateFrom: null, dateTo: null, monthDayFrom: null, monthDayTo: null, version: 0 }],
      closed: [],
    };
    const app = start(
      {
        'GET circulation/calendar': () => answer,
        'POST circulation/calendar': () => new Response(JSON.stringify({ id: '01JZ0000000000000000000C02', version: 0 }), { status: 201, headers: { 'Content-Type': 'application/json' } }),
      },
      '/admin/layanan/kalender',
    );
    expect(await screen.findByRole('heading', { name: 'Kalender' })).toBeTruthy();
    expect(await screen.findByText('Setiap Minggu')).toBeTruthy();
    fireEvent.change(screen.getByLabelText('Nama'), { target: { value: 'Libur semester' } });
    fireEvent.change(screen.getByLabelText('Dari tanggal'), { target: { value: '2026-12-21' } });
    fireEvent.change(screen.getByLabelText('Sampai tanggal'), { target: { value: '2026-12-31' } });
    fireEvent.click(screen.getByRole('button', { name: 'Tambahkan' }));
    expect(await screen.findByText('Libur semester ditambahkan.')).toBeTruthy();
    expect(app.requests.find((r) => r.method === 'POST' && r.path === 'circulation/calendar')?.body).toEqual({
      kind: 'dates',
      name: 'Libur semester',
      dateFrom: '2026-12-21',
      dateTo: '2026-12-31',
    });
  });
});

describe('Aturan Peminjaman', () => {
  it('shows the rule that applies to a combination, and why the others lose', async () => {
    const rule = (o: Partial<PolicyView>): PolicyView => ({
      id: '01JZ0000000000000000000P01',
      code: 'DEFAULT',
      name: 'Aturan umum',
      memberTypeId: null,
      collectionTypeId: null,
      materialTypeId: null,
      branchId: null,
      loanable: true,
      loanDays: 7,
      loanLimit: null,
      renewLimit: 1,
      finePerDay: '0.00',
      fineCap: null,
      graceDays: 0,
      currency: 'IDR',
      specificity: 0,
      openLoans: 0,
      archived: false,
      version: 0,
      ...o,
    });
    const general = rule({});
    const fiction = rule({ id: '01JZ0000000000000000000P02', code: 'FIKSI-3', name: 'Fiksi', collectionTypeId: '01JZ0000000000000000000K01', specificity: 1, finePerDay: '500.00', graceDays: 1 });
    const resolved: PolicyResolveResponse = {
      winner: fiction,
      candidates: [
        { policy: fiction, rank: 1, reason: 'more_specific' },
        { policy: general, rank: 2, reason: 'less_specific' },
      ],
    };
    start(
      {
        'GET circulation/policies': () => ({ items: [general, fiction] }),
        'GET circulation/policies/resolve': () => resolved,
        'GET catalog/collection-types': () => ({ items: [{ id: '01JZ0000000000000000000K01', code: 'FIKSI', nameId: 'Fiksi', nameEn: 'Fiction', archived: false }] }),
      },
      '/admin/layanan/aturan',
    );
    expect(await screen.findByRole('heading', { name: 'Aturan mana yang berlaku?' })).toBeTruthy();
    const ranking = await screen.findByRole('list', { name: 'Aturan yang cocok, yang berlaku lebih dulu' });
    expect(within(ranking).getAllByRole('listitem').map((li) => li.textContent)).toEqual([
      expect.stringContaining('FIKSI-3'),
      expect.stringContaining('DEFAULT'),
    ]);
    expect(within(ranking).getByText('Paling banyak dimensi terisi')).toBeTruthy();
    // The fine is money in the library's currency, as everywhere else (not a bare amount and a code).
    expect(screen.getByText('Rp 500 (tenggang 1 hari)')).toBeTruthy();
  });
});

describe('Surat Bebas Pustaka', () => {
  it('finds a class, checks who passes, prints the letters and lists them', async () => {
    const pupils = [
      { id: MEMBER_ID, memberNo: 'A001', name: 'Budi Santoso', type: MEMBER.type, className: '9A', status: 'active' as const, expiresOn: null, photoFileId: null },
      { id: '01JZ0000000000000000000A02', memberNo: 'A002', name: 'Citra Lestari', type: MEMBER.type, className: '9A', status: 'active' as const, expiresOn: null, photoFileId: null },
    ];
    const fetchSpy: string[] = [];
    const app = start(
      {
        'POST members/search': () => ({ items: pupils, nextCursor: null }),
        'POST members/clearances/check': () => ({
          items: [
            { memberId: pupils[0]!.id, memberNo: 'A001', name: 'Budi Santoso', className: '9A', refusals: [] },
            { memberId: pupils[1]!.id, memberNo: 'A002', name: 'Citra Lestari', className: '9A', refusals: ['open_loans'] },
          ],
        }),
        'GET members/clearances': () => ({ items: [], nextCursor: null }),
        'POST members/clearances': () => {
          fetchSpy.push('issue');
          return new Response(new Uint8Array([37, 80, 68, 70]), {
            status: 200,
            headers: { 'Content-Type': 'application/pdf', 'X-Altis-Clearance-Issued': '1', 'X-Altis-Clearance-Refused': '1' },
          });
        },
      },
      '/admin/anggota/bebas-pustaka',
    );
    vi.stubGlobal('open', vi.fn());
    URL.createObjectURL = vi.fn(() => 'blob:surat');
    URL.revokeObjectURL = vi.fn();
    expect(await screen.findByRole('heading', { name: 'Surat Bebas Pustaka' })).toBeTruthy();
    fireEvent.change(screen.getByLabelText('Atau satu kelas'), { target: { value: '9A' } });
    fireEvent.click(screen.getByRole('button', { name: 'Cari' }));
    fireEvent.click(await screen.findByRole('button', { name: 'Tambahkan semua' }));
    fireEvent.click(screen.getByRole('button', { name: 'Periksa' }));
    expect(await screen.findByText('1 anggota lolos, 1 belum bisa mendapat surat.')).toBeTruthy();
    expect(screen.getByText('Masih ada pinjaman terbuka')).toBeTruthy();
    fireEvent.click(screen.getByRole('button', { name: 'Cetak surat' }));
    expect(await screen.findByText('1 surat diterbitkan, 1 anggota ditolak.')).toBeTruthy();
    expect(fetchSpy).toEqual(['issue']);
    expect(app.requests.find((r) => r.path === 'members/clearances/check')?.body).toEqual({ memberIds: [pupils[0]!.id, pupils[1]!.id] });
  });
});
