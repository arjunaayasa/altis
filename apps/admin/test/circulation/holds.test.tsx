import type { BranchView } from '@altis/shared/api/branches';
import type { DeskMemberView, ReturnResponse } from '@altis/shared/api/circulation';
import type { HoldShelfResponse, HoldView } from '@altis/shared/api/holds';
import { fireEvent, screen, waitFor, within } from '@testing-library/react';
import { afterEach, beforeAll, beforeEach, describe, expect, it, vi } from 'vitest';
import { adminMe, problem, startApp } from '../fake-api';

// Holds at the desk and on the hold shelf: a return that keeps the copy for a hold says for whom (and offers the slip),
// the member's Reservasi tab lists the holds, a refused hold is said in words, and Rak Tunggu & Reservasi lists the
// kept copies, the copies to put back and the queues, with "Sudah di rak" and "Tandai siap".

beforeAll(async () => {
  await import('@/screens/circulation/desk');
  await import('@/screens/circulation/holds');
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
const RECORD_ID = '01JZ0000000000000000000R01';

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

function hold(o: Partial<HoldView> = {}): HoldView {
  return {
    id: '01JZ0000000000000000000H01',
    version: 1,
    status: 'waiting',
    record: { id: RECORD_ID, title: 'Bumi Manusia' },
    item: null,
    pinned: false,
    member: { id: MEMBER_ID, memberNo: 'A001', name: 'Budi Santoso', className: '7A' },
    pickupBranch: { id: BRANCH, code: 'PUSAT', name: 'Perpustakaan Pusat' },
    source: 'desk',
    placedOn: '2026-11-10',
    placedAt: 1,
    position: 2,
    readyAt: null,
    pickupUntil: null,
    expiresOn: null,
    closedAt: null,
    closeReason: null,
    shelfClearedAt: null,
    ...o,
  };
}

function deskMember(o: Partial<DeskMemberView> = {}): DeskMemberView {
  return {
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
    ...o,
  };
}

async function scan(code: string): Promise<void> {
  const box = await screen.findByLabelText(/^Pindai/);
  fireEvent.change(box, { target: { value: code } });
  fireEvent.click(screen.getByRole('button', { name: 'Proses' }));
}

describe('holds at the desk', () => {
  it('a return that keeps the copy for a hold says for whom and until when, and offers the slip', async () => {
    startApp({
      me: adminMe(),
      path: '/admin/layanan/kembali',
      routes: {
        'GET branches': () => ({ items: [BRANCH_VIEW] }),
        'POST branches/:branchId/circulation/returns': (): ReturnResponse => ({
          id: '01JZ0000000000000000000L01',
          version: 2,
          memberId: '01JZ0000000000000000000A09',
          memberNo: 'A009',
          item: { id: '01JZ0000000000000000000I01', barcode: 'B0001', callNumber: null },
          record: { id: RECORD_ID, title: 'Bumi Manusia' },
          loanedOn: '2026-11-01',
          dueOn: '2026-11-08',
          returnedOn: '2026-11-08',
          daysLate: 0,
          hold: { holdId: '01JZ0000000000000000000H01', memberId: MEMBER_ID, memberNo: 'A001', memberName: 'Budi Santoso', pickupUntil: '2026-11-11' },
        }),
      },
    });
    await scan('B0001');
    expect(await screen.findByText('Simpan di rak tunggu untuk A001', { selector: 'p.text-xl' })).toBeTruthy();
    expect(screen.getByText(/^Budi Santoso, ambil paling lambat .+\. Bumi Manusia$/)).toBeTruthy();
    expect(screen.getByRole('button', { name: 'Cetak slip rak tunggu' })).toBeTruthy();
    expect(screen.getByText('Rak tunggu: A001')).toBeTruthy();
  });

  it('the Reservasi tab lists the member\'s holds; a refused hold is said in words', async () => {
    const member = deskMember({ holds: [hold({ status: 'ready', position: null, pickupUntil: '2026-11-18', item: { id: 'I1', barcode: 'B0001', callNumber: null } })], counts: { openLoans: 0, overdue: 0, holdsReady: 1 } });
    startApp({
      me: adminMe(),
      path: '/admin/layanan',
      routes: {
        'GET branches': () => ({ items: [BRANCH_VIEW] }),
        'POST branches/:branchId/circulation/members/search': () => ({ items: [] }),
        'POST branches/:branchId/circulation/members/lookup': () => member,
        'GET branches/:branchId/circulation/members/:memberId': () => member,
        'GET catalog/records': () => ({ items: [{ id: RECORD_ID, title: 'Anak Semua Bangsa', subtitle: null, mainAgent: 'Pramoedya', materialTypeId: 'M', year: '1980', callNumber: null, itemCount: 2, coverFileId: null, opacVisible: true, archived: false, changedAt: 1 }], total: 1, nextCursor: null, page: 1 }),
        'POST branches/:branchId/circulation/holds': () => problem(409, 'CIRC_HOLD_REFUSED', { reason: 'available' }),
      },
    });
    await scan('A001');
    expect(await screen.findByText('Reservasi siap diambil: 1')).toBeTruthy();
    // F7 twice: Transaksi kali ini → Dipinjam → Reservasi.
    fireEvent.keyDown(window, { key: 'F7' });
    fireEvent.keyDown(window, { key: 'F7' });
    expect((await screen.findByRole('tab', { name: 'Reservasi (1)' })).getAttribute('aria-selected')).toBe('true');
    const table = await screen.findByRole('table', { name: 'Reservasi aktif Budi Santoso' });
    expect(within(table).getByText('Siap diambil')).toBeTruthy();

    fireEvent.click(screen.getByRole('button', { name: 'Tambah reservasi…' }));
    const dialog = await screen.findByRole('dialog');
    fireEvent.change(within(dialog).getByLabelText('Cari judul'), { target: { value: 'anak' } });
    fireEvent.click(within(dialog).getByRole('button', { name: 'Cari judul' }));
    fireEvent.click(await within(dialog).findByRole('button', { name: 'Pesan' }));
    expect(await within(dialog).findByText('Ada eksemplar yang tersedia di rak')).toBeTruthy();
  });

  it('while "Tambah reservasi" is open a scan lends nothing, and Esc closes the dialog without ending the visit', async () => {
    const member = deskMember();
    const loans: unknown[] = [];
    startApp({
      me: adminMe(),
      path: '/admin/layanan',
      routes: {
        'GET branches': () => ({ items: [BRANCH_VIEW] }),
        'POST branches/:branchId/circulation/members/search': () => ({ items: [] }),
        'POST branches/:branchId/circulation/members/lookup': () => member,
        'GET branches/:branchId/circulation/members/:memberId': () => member,
        'POST branches/:branchId/circulation/loans': (req) => {
          loans.push(req.body);
          return problem(404, 'NOT_FOUND');
        },
      },
    });
    await scan('A001');
    expect(await screen.findByRole('region', { name: 'Anggota Budi Santoso' })).toBeTruthy();
    fireEvent.keyDown(window, { key: 'F7' });
    fireEvent.keyDown(window, { key: 'F7' });
    fireEvent.click(await screen.findByRole('button', { name: 'Tambah reservasi…' }));
    const dialog = await screen.findByRole('dialog');
    // A scanner is a keyboard: a burst of keys ending with Enter, aimed at the dialog's search box.
    const target = document.activeElement ?? document.body;
    for (const key of ['B', '0', '0', '0', '2', 'Enter']) fireEvent.keyDown(target, { key });
    expect(
      await screen.findByText('Pindaian B0002 tidak diproses karena ada jendela yang terbuka. Tutup jendela itu, lalu pindai lagi.', { selector: 'p.text-xl' }),
    ).toBeTruthy();
    expect(loans).toEqual([]);

    fireEvent.keyDown(document.activeElement ?? document.body, { key: 'Escape' });
    await waitFor(() => expect(dialog.isConnected).toBe(false));
    expect(screen.getByRole('region', { name: 'Anggota Budi Santoso' })).toBeTruthy();

    // In a browser the dialog's own Esc handler runs first, marks the key as used and closes the dialog; the desk may
    // already see no dialog when the same key reaches it. A used Esc is not the desk's: the visit goes on.
    const used = (e: KeyboardEvent): void => {
      if (e.key === 'Escape') e.preventDefault();
    };
    document.addEventListener('keydown', used, { capture: true });
    try {
      fireEvent.keyDown(document.activeElement ?? document.body, { key: 'Escape' });
    } finally {
      document.removeEventListener('keydown', used, { capture: true });
    }
    expect(screen.getByRole('region', { name: 'Anggota Budi Santoso' })).toBeTruthy();
    // An Esc nobody used still ends the visit.
    fireEvent.keyDown(document.activeElement ?? document.body, { key: 'Escape' });
    expect(await screen.findByText('Belum ada anggota')).toBeTruthy();
  });
});

describe('Rak Tunggu & Reservasi', () => {
  it('lists the kept copies, the copies to put back and the queues; "Sudah di rak" and "Tandai siap" call the branch\'s routes', async () => {
    let shelf: HoldShelfResponse = {
      today: '2026-11-15',
      ready: [hold({ id: '01JZ0000000000000000000H02', status: 'ready', position: null, pickupUntil: '2026-11-14', item: { id: 'I2', barcode: 'B0002', callNumber: null } })],
      toClear: [hold({ id: '01JZ0000000000000000000H03', status: 'expired', position: null, closeReason: 'expired_pickup', item: { id: 'I3', barcode: 'B0003', callNumber: null } })],
      waitingTitles: [{ record: { id: RECORD_ID, title: 'Rumah Kaca' }, waiting: 3, firstPlacedOn: '2026-11-01', firstHoldId: '01JZ0000000000000000000H04' }],
    };
    const app = startApp({
      me: adminMe(),
      path: '/admin/layanan/rak-tunggu',
      routes: {
        'GET branches': () => ({ items: [BRANCH_VIEW] }),
        'GET branches/:branchId/circulation/hold-shelf': () => shelf,
        'POST branches/:branchId/circulation/hold-shelf/:holdId/clear': () => {
          shelf = { ...shelf, toClear: [] };
          return { id: '01JZ0000000000000000000H03', version: 2, status: 'expired', pickupUntil: null };
        },
        'POST branches/:branchId/circulation/holds/:id/ready': () => ({ id: '01JZ0000000000000000000H04', version: 2, status: 'ready', pickupUntil: '2026-11-18' }),
      },
    });
    expect(await screen.findByRole('heading', { name: 'Siap diambil (1)' })).toBeTruthy();
    expect(screen.getByText('Lewat batas ambil')).toBeTruthy();
    expect(screen.getByText('Tidak diambil sampai batas ambil')).toBeTruthy();

    fireEvent.click(screen.getByRole('button', { name: 'Sudah di rak' }));
    expect(await screen.findByText('Eksemplar dicatat sudah kembali di rak.')).toBeTruthy();
    expect(app.requests.some((r) => r.path === `branches/${BRANCH}/circulation/hold-shelf/01JZ0000000000000000000H03/clear`)).toBe(true);
    await waitFor(() => expect(screen.getByText('Tidak ada eksemplar yang perlu dikembalikan ke rak.')).toBeTruthy());

    fireEvent.click(screen.getByRole('button', { name: 'Tandai siap…' }));
    const dialog = await screen.findByRole('dialog');
    fireEvent.change(within(dialog).getByLabelText('Barkod eksemplar'), { target: { value: 'B0004' } });
    fireEvent.click(within(dialog).getByRole('button', { name: 'Tahan eksemplar' }));
    expect(await screen.findByText(/^Eksemplar ditahan sampai /)).toBeTruthy();
    expect(app.requests.find((r) => r.path.endsWith('/holds/01JZ0000000000000000000H04/ready'))?.body).toEqual({ barcode: 'B0004' });
  });
});
