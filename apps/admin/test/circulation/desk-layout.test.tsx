import type { BranchView } from '@altis/shared/api/branches';
import type { DeskMemberView, LoanResponse } from '@altis/shared/api/circulation';
import type { DeskDashboard } from '@altis/shared/api/dashboard-home';
import type { HoldView } from '@altis/shared/api/holds';
import { fireEvent, screen, waitFor, within } from '@testing-library/react';
import { afterEach, beforeAll, beforeEach, describe, expect, it, vi } from 'vitest';
import { adminMe, startApp, type FakeHandler } from '../fake-api';

// Meja Layanan's layout: the left column stacks the scan card, the member and the member's tabs; the right one holds
// the member's holds ready for pickup ("Pinjamkan sekarang" lends the kept copy as a scan would), what the member's
// type allows, and today's figures at the desk's branch. None of it takes the scan box's place: the focus goes back
// to the box after the button, and the keys of the desk work as before (desk.test.tsx, desk-keys.test.tsx).

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
const RECORD_ID = '01JZ0000000000000000000R01';

const BRANCH_VIEW: BranchView = { id: BRANCH, code: 'PUSAT', name: 'Perpustakaan Pusat', address: null, timezone: 'Asia/Jakarta', isDefault: true, archivedAt: null, version: 1, active: true };

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

function hold(o: Partial<HoldView> = {}): HoldView {
  return {
    id: '01JZ0000000000000000000H01',
    version: 1,
    status: 'ready',
    record: { id: RECORD_ID, title: 'Bumi Manusia' },
    item: { id: 'I1', barcode: 'B0001', callNumber: null },
    pinned: false,
    member: { id: MEMBER_ID, memberNo: 'A001', name: 'Budi Santoso', className: '7A' },
    pickupBranch: { id: BRANCH, code: 'PUSAT', name: 'Perpustakaan Pusat' },
    source: 'desk',
    placedOn: '2026-11-10',
    placedAt: 1,
    position: null,
    readyAt: 2,
    pickupUntil: '2026-11-22',
    expiresOn: null,
    closedAt: null,
    closeReason: null,
    shelfClearedAt: null,
    ...o,
  };
}

const today = (o: Partial<DeskDashboard> = {}): DeskDashboard => ({
  branchId: BRANCH,
  on: '2026-11-19',
  timeZone: 'Asia/Jakarta',
  weekAgo: '2026-11-12',
  loaned: 14,
  returned: 6,
  loanedWeekAgo: 0,
  returnedWeekAgo: 0,
  overdue: 0,
  overdueMembers: 0,
  holdsReady: 2,
  holdsToClear: 0,
  hours: [],
  ...o,
});

const LOAN: LoanResponse = {
  id: '01JZ0000000000000000000L01',
  version: 1,
  dueOn: '2026-11-26',
  item: { id: 'I1', barcode: 'B0001', callNumber: null },
  record: { id: RECORD_ID, title: 'Bumi Manusia' },
};

function start(routes: Record<string, FakeHandler>) {
  return startApp({
    me: adminMe(),
    path: '/admin/layanan',
    routes: {
      'GET branches': () => ({ items: [BRANCH_VIEW] }),
      'POST branches/:branchId/circulation/members/search': () => ({ items: [] }),
      'GET branches/:branchId/dashboard': () => today(),
      ...routes,
    },
  });
}

async function scan(code: string): Promise<void> {
  const box = await screen.findByLabelText(/^Pindai/);
  fireEvent.change(box, { target: { value: code } });
  fireEvent.click(screen.getByRole('button', { name: 'Proses' }));
}

const side = (name: string): HTMLElement | null => document.querySelector(`[data-desk-side="${name}"]`);
const facts = (el: HTMLElement): string[][] => [...el.querySelectorAll('dl > div')].map((row) => [row.querySelector('dt')?.textContent ?? '', row.querySelector('dd')?.textContent ?? '']);

describe('Meja Layanan: the layout', () => {
  it('before a member: the scan card and "Belum ada anggota" on the left, today at the desk on the right', async () => {
    const app = start({});
    const box = await screen.findByLabelText(/^Pindai/);
    await waitFor(() => expect(facts(side('today')!)).toEqual([['Dipinjam', '14'], ['Dikembalikan', '6'], ['Reservasi siap diambil', '2']]));
    expect(within(screen.getByRole('region', { name: 'Hari ini di meja' })).getByText('14')).toBeTruthy();
    expect(side('holds')).toBeNull();
    expect(side('rules')).toBeNull();
    // The scan card comes first and holds the mode switch and the box; the member's place follows it in the same column.
    const scanCard = document.querySelector('[data-desk-scan]') as HTMLElement;
    expect(scanCard.contains(box)).toBe(true);
    expect(within(scanCard).getByRole('group', { name: 'Mode meja' })).toBeTruthy();
    const none = screen.getByRole('complementary', { name: 'Belum ada anggota' });
    expect(scanCard.compareDocumentPosition(none) & Node.DOCUMENT_POSITION_FOLLOWING).toBeTruthy();
    expect(scanCard.parentElement).toBe(none.parentElement);
    expect(none.compareDocumentPosition(side('today')!) & Node.DOCUMENT_POSITION_FOLLOWING).toBeTruthy();
    expect(document.activeElement).toBe(box);
    // One read of today's figures, for the desk's branch, in the background.
    expect(app.requests.filter((r) => r.path === `branches/${BRANCH}/dashboard`)).toHaveLength(1);
  });

  it('a member: the member card, then the tabs; beside them the ready holds, the rules of the type and today', async () => {
    const member = deskMember({
      loanRule: { policyId: '01JZ0000000000000000000P01', code: 'DEFAULT', loanDays: 7, renewLimit: 1, loanable: true, others: 2 },
      holds: [hold(), hold({ id: '01JZ0000000000000000000H02', record: { id: RECORD_ID, title: 'Laskar Pelangi' }, item: { id: 'I2', barcode: 'C0009', callNumber: null }, pickupBranch: { id: 'B2', code: 'CAB', name: 'Cabang Timur' } }), hold({ id: '01JZ0000000000000000000H03', status: 'waiting', item: null, position: 1, pickupUntil: null })],
      counts: { openLoans: 0, overdue: 0, holdsReady: 2 },
    });
    start({
      'POST branches/:branchId/circulation/members/lookup': () => member,
      'GET branches/:branchId/circulation/members/:memberId': () => member,
    });
    await scan('A001');
    const panel = await screen.findByRole('complementary', { name: 'Budi Santoso' });
    const scanCard = document.querySelector('[data-desk-scan]') as HTMLElement;
    const tabs = screen.getByRole('tablist', { name: 'Pinjaman anggota' }).closest('[data-slot="tabs"]') as HTMLElement;
    // One column: scan, member, tabs, in that order.
    expect([scanCard.parentElement, tabs.parentElement]).toEqual([panel.parentElement, panel.parentElement]);
    expect(scanCard.compareDocumentPosition(panel) & Node.DOCUMENT_POSITION_FOLLOWING).toBeTruthy();
    expect(panel.compareDocumentPosition(tabs) & Node.DOCUMENT_POSITION_FOLLOWING).toBeTruthy();
    expect(within(panel).getByRole('button', { name: 'Selesai (Esc)' })).toBeTruthy();
    expect(within(panel).getByRole('link', { name: 'Buka profil anggota' }).getAttribute('href')).toBe(`/admin/anggota/${MEMBER_ID}`);

    // The side column, in order.
    expect([...document.querySelectorAll('[data-desk-side]')].map((el) => el.getAttribute('data-desk-side'))).toEqual(['holds', 'rules', 'today']);
    const holdsCard = screen.getByRole('region', { name: 'Reservasi siap diambil' });
    const ready = [...holdsCard.querySelectorAll('[data-ready-hold]')] as HTMLElement[];
    // Only the ready ones; the copy kept here can be lent from the card, the one kept at another branch cannot.
    expect(ready.map((li) => li.textContent)).toEqual(['Bumi ManusiaB0001 · Rak tunggu · ambil sebelum Min, 22 Nov 2026Pinjamkan sekarang', 'Laskar PelangiC0009 · Rak tunggu Cabang Timur · ambil sebelum Min, 22 Nov 2026']);
    expect(facts(screen.getByRole('region', { name: 'Aturan tipe Siswa' }))).toEqual([['Batas pinjam', '3 eksemplar'], ['Lama pinjam', '7 hari'], ['Perpanjangan', '1 kali']]);
    expect(within(screen.getByRole('region', { name: 'Aturan tipe Siswa' })).getByText('Sebagian koleksi memakai aturan lain.')).toBeTruthy();
  });

  it('"Pinjamkan sekarang" lends the kept copy as a scan of its barcode would, gives the focus back to the box, and today is read again', async () => {
    let member = deskMember({ holds: [hold()], counts: { openLoans: 0, overdue: 0, holdsReady: 1 } });
    let loaned = 14;
    const app = start({
      'POST branches/:branchId/circulation/members/lookup': () => member,
      'GET branches/:branchId/circulation/members/:memberId': () => member,
      'GET branches/:branchId/dashboard': () => today({ loaned }),
      'POST branches/:branchId/circulation/loans': () => {
        member = deskMember({ counts: { openLoans: 1, overdue: 0, holdsReady: 0 } });
        loaned = 15;
        return new Response(JSON.stringify(LOAN), { status: 201, headers: { 'Content-Type': 'application/json', 'X-Altis-Build': '0.1.0' } });
      },
    });
    await scan('A001');
    const holdsCard = await screen.findByRole('region', { name: 'Reservasi siap diambil' });
    fireEvent.click(within(holdsCard).getByRole('button', { name: 'Pinjamkan sekarang' }));
    expect(await screen.findByText(/^Dipinjam: Bumi Manusia — jatuh tempo/, { selector: 'p.text-xl' })).toBeTruthy();
    const call = app.fetchMock.mock.calls.find(([url, init]) => String(url).endsWith(`branches/${BRANCH}/circulation/loans`) && init?.method === 'POST');
    expect(JSON.parse(String(call?.[1]?.body))).toEqual({ memberId: MEMBER_ID, barcode: 'B0001' });
    expect(new Headers(call?.[1]?.headers).get('Idempotency-Key')).toMatch(/^desk-loan:[0-9a-f]{32}$/);
    await waitFor(() => expect(document.activeElement).toBe(screen.getByLabelText(/^Pindai/)));
    // The hold is gone from the card, and today's figures were read again.
    expect(await within(holdsCard).findByText('Tidak ada reservasi anggota ini yang menunggu diambil.')).toBeTruthy();
    await waitFor(() => expect(facts(side('today')!)[0]).toEqual(['Dipinjam', '15']));
  });

  it('a type without a loan limit or a general rule says so; a failed read of today shows no made-up number', async () => {
    const member = deskMember({ type: { id: '01JZ0000000000000000000T02', code: 'GURU', nameId: 'Guru', nameEn: null, loanLimit: null }, loanRule: null });
    start({
      'POST branches/:branchId/circulation/members/lookup': () => member,
      'GET branches/:branchId/circulation/members/:memberId': () => member,
      'GET branches/:branchId/dashboard': () => new Response(null, { status: 500 }),
    });
    await scan('A001');
    const rules = await screen.findByRole('region', { name: 'Aturan tipe Guru' });
    expect(facts(rules)).toEqual([['Batas pinjam', 'Tanpa batas']]);
    expect(within(rules).getByText('Belum ada aturan pinjam umum untuk tipe ini.')).toBeTruthy();
    expect(facts(side('today')!)).toEqual([['Dipinjam', '—'], ['Dikembalikan', '—'], ['Reservasi siap diambil', '—']]);
  });

  it('Kembali (F3): the tally of the returns above today, and no member cards', async () => {
    start({});
    await screen.findByLabelText(/^Pindai/);
    fireEvent.keyDown(window, { key: 'F3' });
    const tally = await screen.findByRole('complementary', { name: 'Ringkasan' });
    expect(tally.compareDocumentPosition(side('today')!) & Node.DOCUMENT_POSITION_FOLLOWING).toBeTruthy();
    expect(tally.parentElement).toBe(side('today')!.parentElement);
    expect(side('holds')).toBeNull();
    expect(screen.queryByRole('complementary', { name: 'Belum ada anggota' })).toBeNull();
  });
});
