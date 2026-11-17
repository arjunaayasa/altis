import type { BranchView } from '@altis/shared/api/branches';
import type { DeskLoanView, DeskMemberView, LoanResponse, ReturnResponse } from '@altis/shared/api/circulation';
import { fireEvent, screen, waitFor, within } from '@testing-library/react';
import { afterEach, beforeAll, beforeEach, describe, expect, it, vi } from 'vitest';
import { adminMe, problem, startApp, type FakeHandler } from '../fake-api';

// Meja Layanan, the keys and the scanner: the scan box takes the focus back after every action, Esc steps back one
// level at a time, F3 keeps the member it leaves (F2 brings the panel back), ↓ goes from the box to the loans and ↑
// back, K / P / Shift+P act on the rows, F7 / F8 move between the tabs, and the keys themselves show as a panel in the
// page (not a dialog), so a scan while it is open still counts. The result card names its main fact on the right.

beforeAll(async () => {
  await import('@/screens/circulation/desk');
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

function loan(n: number, o: Partial<DeskLoanView> = {}): DeskLoanView {
  return {
    id: `01JZ0000000000000000000L0${n}`,
    version: 1,
    branchId: BRANCH,
    item: { id: `01JZ0000000000000000000I0${n}`, barcode: `B000${n}`, callNumber: null },
    record: { id: `01JZ0000000000000000000R0${n}`, title: `Judul ${n}` },
    loanedOn: '2026-11-10',
    dueOn: '2099-11-17',
    daysLate: 0,
    renewals: 0,
    renewLimit: 2,
    finePreview: null,
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
    expiresOn: '2099-06-30',
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

function start(routes: Record<string, FakeHandler>, path = '/admin/layanan') {
  return startApp({
    me: adminMe(),
    path,
    routes: {
      'GET branches': () => ({ items: [BRANCH_VIEW] }),
      'POST branches/:branchId/circulation/members/search': () => ({ items: [] }),
      ...routes,
    },
  });
}

const box = (): Promise<HTMLElement> => screen.findByLabelText(/^Pindai/);

async function scan(code: string): Promise<void> {
  fireEvent.change(await box(), { target: { value: code } });
  fireEvent.click(screen.getByRole('button', { name: 'Proses' }));
}

const title = (text: string | RegExp): Promise<HTMLElement> => screen.findByText(text, { selector: 'p.text-xl' });

describe('Meja Layanan: keys and scanner', () => {
  it('"?" shows the keys as a panel in the page, not a dialog, and a scan while it is open still lends', async () => {
    const member = deskMember();
    const app = start({
      'POST branches/:branchId/circulation/members/lookup': () => member,
      'GET branches/:branchId/circulation/members/:memberId': () => member,
      'POST branches/:branchId/circulation/loans': (): LoanResponse => ({
        id: '01JZ0000000000000000000L05',
        version: 1,
        dueOn: '2026-11-24',
        item: { id: '01JZ0000000000000000000I05', barcode: 'B0005', callNumber: null },
        record: { id: '01JZ0000000000000000000R05', title: 'Judul 5' },
      }),
    });
    await box();
    fireEvent.keyDown(window, { key: '?' });
    const keys = await screen.findByRole('region', { name: 'Pintasan meja layanan' });
    expect(within(keys).getByText('Cari anggota per nama')).toBeTruthy();
    expect(screen.queryByRole('dialog')).toBeNull();
    expect(screen.getByRole('button', { name: 'Pintasan' }).getAttribute('aria-expanded')).toBe('true');

    await scan('A001');
    await title('Anggota dimuat: Budi Santoso');
    await scan('B0005');
    // The main fact of a loan, on the right of the result: the due date.
    const card = screen.getByTestId('desk-feedback');
    await waitFor(() => expect(within(card).getByText('Jatuh tempo')).toBeTruthy());
    expect(within(card).getByText(/24 Nov 2026/, { selector: 'strong' })).toBeTruthy();
    expect(app.writes().filter((w) => w.endsWith('/loans'))).toEqual([`POST branches/${BRANCH}/circulation/loans`]);
    // The box has the focus back after the scan.
    await waitFor(() => expect(document.activeElement).toBe(screen.getByLabelText(/^Pindai/)));

    fireEvent.keyDown(window, { key: '?' });
    await waitFor(() => expect(screen.queryByRole('region', { name: 'Pintasan meja layanan' })).toBeNull());
  });

  it('Esc steps back one level at a time: the offer first, then the member (the visit summed up)', async () => {
    const member = deskMember({ counts: { openLoans: 1, overdue: 0, holdsReady: 0 }, loans: [loan(9)] });
    start({
      'POST branches/:branchId/circulation/members/lookup': () => member,
      'GET branches/:branchId/circulation/members/:memberId': () => member,
      'POST branches/:branchId/circulation/loans': () => problem(409, 'CIRC_ITEM_ON_LOAN', { reason: 'same_member' }),
    });
    await scan('A001');
    await title('Anggota dimuat: Budi Santoso');
    await scan('B0009');
    await title('Eksemplar ini sedang dipinjam anggota ini. Kembalikan sekarang?');
    expect(screen.getByRole('button', { name: 'Kembalikan sekarang (Enter)' })).toBeTruthy();

    fireEvent.keyDown(window, { key: 'Escape' });
    expect(await title('Dibatalkan')).toBeTruthy();
    expect(screen.queryByRole('button', { name: 'Kembalikan sekarang (Enter)' })).toBeNull();
    // The member is still there.
    expect(screen.getByRole('complementary', { name: 'Budi Santoso' })).toBeTruthy();

    fireEvent.keyDown(window, { key: 'Escape' });
    expect(await title('Selesai dengan Budi Santoso')).toBeTruthy();
    expect(screen.getByText('0 dipinjam, 0 dikembalikan, 0 diperpanjang. Pindai kartu anggota berikutnya.')).toBeTruthy();
    expect(await screen.findByText('Belum ada anggota')).toBeTruthy();
  });

  it('F3 takes returns without forgetting the member: its tally beside the list, and F2 brings the member back', async () => {
    const member = deskMember();
    start({
      'POST branches/:branchId/circulation/members/lookup': () => member,
      'GET branches/:branchId/circulation/members/:memberId': () => member,
      'POST branches/:branchId/circulation/returns': (): ReturnResponse => ({
        id: '01JZ0000000000000000000L07',
        version: 2,
        memberId: '01JZ0000000000000000000A07',
        memberNo: 'A007',
        item: { id: '01JZ0000000000000000000I07', barcode: 'B0007', callNumber: null },
        record: { id: '01JZ0000000000000000000R07', title: 'Judul 7' },
        loanedOn: '2026-10-20',
        dueOn: '2026-10-27',
        returnedOn: '2026-11-15',
        daysLate: 19,
      }),
    });
    await scan('A001');
    await title('Anggota dimuat: Budi Santoso');
    fireEvent.keyDown(window, { key: 'F3' });
    await screen.findByRole('textbox', { name: 'Pindai eksemplar yang dikembalikan' });
    expect(screen.getByRole('button', { name: /^Kembali/, pressed: true })).toBeTruthy();
    await scan('B0007');
    await title('Dikembalikan — terlambat 19 hari');
    // The fact on the right says how late, as a number in words.
    expect(within(screen.getByTestId('desk-feedback')).getByText('19 hari')).toBeTruthy();
    const tally = screen.getByRole('complementary', { name: 'Ringkasan' });
    expect(within(tally).getByText('Tekan F2 untuk kembali ke Budi Santoso.')).toBeTruthy();
    const table = screen.getByRole('table', { name: 'Pengembalian kali ini' });
    expect(within(table).getByText('Terlambat 19 hari')).toBeTruthy();

    fireEvent.keyDown(window, { key: 'F2' });
    expect(await screen.findByRole('complementary', { name: 'Budi Santoso' })).toBeTruthy();
    expect(await screen.findByRole('textbox', { name: 'Pindai eksemplar untuk dipinjam oleh Budi Santoso' })).toBeTruthy();
  });

  it('↓ from the box reaches the first loan, ↑ goes back; K returns the row and P renews it; F7 / F8 change the tab', async () => {
    let member = deskMember({ counts: { openLoans: 2, overdue: 0, holdsReady: 0 }, loans: [loan(1), loan(2)] });
    const app = start({
      'POST branches/:branchId/circulation/members/lookup': () => member,
      'GET branches/:branchId/circulation/members/:memberId': () => member,
      'POST branches/:branchId/circulation/returns': (req): ReturnResponse => {
        member = deskMember({ counts: { openLoans: 1, overdue: 0, holdsReady: 0 }, loans: [loan(2)] });
        return {
          id: '01JZ0000000000000000000L01',
          version: 2,
          memberId: MEMBER_ID,
          memberNo: 'A001',
          item: { id: '01JZ0000000000000000000I01', barcode: (req.body as { barcode: string }).barcode, callNumber: null },
          record: { id: '01JZ0000000000000000000R01', title: 'Judul 1' },
          loanedOn: '2026-11-10',
          dueOn: '2099-11-17',
          returnedOn: '2026-11-15',
          daysLate: 0,
        };
      },
      'POST branches/:branchId/circulation/loans/:id/renew': () => ({ id: '01JZ0000000000000000000L02', version: 2, dueOn: '2099-12-01' }),
    });
    await scan('A001');
    await title('Anggota dimuat: Budi Santoso');
    const input = await box();
    input.focus();
    fireEvent.keyDown(input, { key: 'ArrowDown' });
    const first = await screen.findByRole('row', { name: /^Judul 1, jatuh tempo/ });
    await waitFor(() => expect(document.activeElement).toBe(first));
    expect(screen.getByRole('tab', { name: 'Dipinjam (2)' }).getAttribute('aria-selected')).toBe('true');
    fireEvent.keyDown(first, { key: 'ArrowDown' });
    const second = screen.getByRole('row', { name: /^Judul 2, jatuh tempo/ });
    expect(document.activeElement).toBe(second);
    fireEvent.keyDown(second, { key: 'ArrowUp' });
    expect(document.activeElement).toBe(first);
    fireEvent.keyDown(first, { key: 'ArrowUp' });
    expect(document.activeElement).toBe(input);

    fireEvent.keyDown(input, { key: 'ArrowDown' });
    await waitFor(() => expect(document.activeElement).toBe(screen.getByRole('row', { name: /^Judul 1, jatuh tempo/ })));
    fireEvent.keyDown(document.activeElement!, { key: 'k' });
    await title('Dikembalikan tepat waktu');
    expect(app.requests.find((r) => r.path.endsWith('/circulation/returns'))?.body).toEqual({ barcode: 'B0001' });
    await waitFor(() => expect(document.activeElement).toBe(screen.getByLabelText(/^Pindai/)));

    fireEvent.keyDown(screen.getByLabelText(/^Pindai/), { key: 'ArrowDown' });
    const left = await screen.findByRole('row', { name: /^Judul 2, jatuh tempo/ });
    await waitFor(() => expect(document.activeElement).toBe(left));
    fireEvent.keyDown(left, { key: 'p' });
    await title(/^Diperpanjang: jatuh tempo baru/);
    expect(within(screen.getByTestId('desk-feedback')).getByText('Jatuh tempo baru')).toBeTruthy();
    expect(app.writes().filter((w) => !w.endsWith('/lookup'))).toEqual([`POST branches/${BRANCH}/circulation/returns`, `POST branches/${BRANCH}/circulation/loans/01JZ0000000000000000000L02/renew`]);

    // F7 / F8: the next and the previous tab of the member's panel.
    fireEvent.keyDown(window, { key: 'F7' });
    await waitFor(() => expect(screen.getByRole('tab', { name: /^Reservasi/ }).getAttribute('aria-selected')).toBe('true'));
    fireEvent.keyDown(window, { key: 'F8' });
    await waitFor(() => expect(screen.getByRole('tab', { name: /^Dipinjam/ }).getAttribute('aria-selected')).toBe('true'));
  });

  it('Enter on the empty box takes a "Paksa pinjam" offer and leaves the focus in the reason field, not in the box', async () => {
    const member = deskMember();
    start({
      'POST branches/:branchId/circulation/members/lookup': () => member,
      'GET branches/:branchId/circulation/members/:memberId': () => member,
      'POST branches/:branchId/circulation/loans': () => problem(409, 'CIRC_NOT_LOANABLE', { reason: 'policy' }),
    });
    await scan('A001');
    await title('Anggota dimuat: Budi Santoso');
    await scan('REF-1');
    await screen.findByRole('button', { name: 'Paksa pinjam (Enter)' });
    await scan('');
    const reason = await screen.findByLabelText('Alasan memaksa (Aturan melarang pinjaman)');
    // Two frames: the one that focuses the reason field and any later one that would take the focus back to the box.
    await new Promise((resolve) => requestAnimationFrame(() => requestAnimationFrame(resolve)));
    await waitFor(() => expect(document.activeElement).toBe(reason));
  });

  it('a click on the page’s empty space gives the box its focus back, never one on a control', async () => {
    start({});
    const input = await box();
    const sound = screen.getByRole('button', { name: 'Bunyi aktif' });
    sound.focus();
    fireEvent.mouseUp(sound);
    expect(document.activeElement).toBe(sound);
    const empty = screen.getByText('Belum ada anggota');
    fireEvent.mouseUp(empty);
    expect(document.activeElement).toBe(input);
  });
});
