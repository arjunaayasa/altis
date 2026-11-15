import type { BranchView } from '@altis/shared/api/branches';
import type { ChargeView, DeskChargesView, PaymentSummaryResponse, PaymentView } from '@altis/shared/api/charges';
import type { DeskMemberView } from '@altis/shared/api/circulation';
import { fireEvent, screen, waitFor, within } from '@testing-library/react';
import { afterEach, beforeAll, beforeEach, describe, expect, it, vi } from 'vitest';
import { adminMe, startApp, type FakeHandler } from '../fake-api';

// Charges at the desk and on Denda & Pembayaran: the Denda tab shows the balance and the open charges, B on a loan row
// opens the pay dialog, a payment goes out with its own Idempotency-Key and offers its receipt; an overdue loan shows
// its running fine; the daily cash summary lists the days and the methods.

beforeAll(async () => {
  await import('@/screens/circulation/desk');
  await import('@/screens/circulation/charges');
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

const CHARGE: ChargeView = {
  id: '01JZ0000000000000000000C01',
  version: 0,
  memberId: MEMBER_ID,
  branchId: BRANCH,
  loanId: '01JZ0000000000000000000L01',
  kind: 'overdue',
  description: 'Terlambat 3 hari: B0001 Laskar Pelangi',
  amount: '1500.00',
  paid: '0.00',
  waived: '0.00',
  balance: '1500.00',
  currency: 'IDR',
  status: 'open',
  chargedOn: '2026-11-10',
  dateUnknown: false,
  source: 'system',
  item: { id: '01JZ0000000000000000000I01', barcode: 'B0001', title: 'Laskar Pelangi' },
};

const PAYMENT: PaymentView = {
  id: '01JZ0000000000000000000P01',
  version: 0,
  memberId: MEMBER_ID,
  branchId: BRANCH,
  receiptNo: 'PUSAT/2026/000001',
  amount: '1500.00',
  currency: 'IDR',
  method: 'cash',
  paidOn: '2026-11-15',
  paidAt: 1,
  receivedBy: 'Petugas',
  note: null,
  voided: false,
  voidedAt: null,
  voidReason: null,
  allocations: [{ chargeId: CHARGE.id, amount: '1500.00', kind: 'overdue', description: CHARGE.description }],
};

function deskMember(charges: Partial<DeskChargesView> = {}): DeskMemberView {
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
    counts: { openLoans: 1, overdue: 1, holdsReady: 0 },
    canBorrow: true,
    borrowRefusal: null,
    loans: [
      {
        id: '01JZ0000000000000000000L02',
        version: 1,
        branchId: BRANCH,
        item: { id: '01JZ0000000000000000000I02', barcode: 'B0002', callNumber: null },
        record: { id: '01JZ0000000000000000000R02', title: 'Bumi Manusia' },
        loanedOn: '2026-11-01',
        dueOn: '2026-11-08',
        daysLate: 7,
        renewals: 0,
        renewLimit: 1,
        finePreview: { amount: '2500.00', currency: 'IDR', days: 5 },
      },
    ],
    holds: [],
    warnings: [],
    charges: { balance: '1500.00', currency: 'IDR', charges: [CHARGE], payments: [], blocked: null, ...charges },
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

describe('charges at the desk', () => {
  it('shows the running fine and the balance; B on a loan row pays the open charges and offers the receipt', async () => {
    let member = deskMember();
    const app = start(
      {
        'GET branches/:branchId/circulation/members/:memberId': () => member,
        'POST branches/:branchId/circulation/slips': () => new Response(new Uint8Array([37, 80, 68, 70]), { status: 200, headers: { 'Content-Type': 'application/pdf' } }),
        'POST branches/:branchId/circulation/members/:memberId/payments': () => {
          member = deskMember({ balance: '0.00', charges: [], payments: [PAYMENT] });
          return new Response(JSON.stringify(PAYMENT), { status: 201, headers: { 'Content-Type': 'application/json', 'X-Altis-Build': '0.1.0' } });
        },
      },
      `/admin/layanan?member=${MEMBER_ID}`,
    );

    expect(await screen.findByText('Tanggungan Rp 1.500')).toBeTruthy();
    fireEvent.mouseDown(await screen.findByRole('tab', { name: /^Dipinjam/ }));
    expect(await screen.findByText('Denda berjalan Rp 2.500 (5 hari dikenai denda)')).toBeTruthy();

    const row = screen.getByRole('row', { name: /Bumi Manusia/ });
    fireEvent.keyDown(row, { key: 'b' });
    const dialog = await screen.findByRole('dialog', { name: 'Terima pembayaran' });
    expect((within(dialog).getByLabelText('Jumlah dibayar') as HTMLInputElement).value).toBe('1500');
    fireEvent.click(within(dialog).getByRole('button', { name: 'Terima pembayaran' }));

    expect(await screen.findByText('Pembayaran Rp 1.500 diterima. Kuitansi PUSAT/2026/000001.', { selector: 'p.text-xl' })).toBeTruthy();
    const call = app.fetchMock.mock.calls.find(([url, init]) => String(url).endsWith(`/members/${MEMBER_ID}/payments`) && init?.method === 'POST');
    expect(JSON.parse(String(call?.[1]?.body))).toEqual({ amount: '1500', method: 'cash', chargeIds: [CHARGE.id] });
    expect(new Headers(call?.[1]?.headers).get('Idempotency-Key')).toMatch(/^desk-pay:[0-9a-f]{32}$/);
    const link = screen.getByRole('link', { name: 'Cetak kuitansi PUSAT/2026/000001' });
    expect(link.getAttribute('href')).toBe(`/api/v1/branches/${BRANCH}/circulation/payments/${PAYMENT.id}/receipt`);
    await waitFor(() => expect(screen.queryByText('Tanggungan Rp 1.500')).toBeNull());

    // F9: the slip of this visit holds the payment; the tab opened at once shows the PDF.
    const tab = { location: { href: '' }, close: vi.fn() };
    vi.stubGlobal('open', vi.fn(() => tab));
    vi.stubGlobal('URL', Object.assign(URL, { createObjectURL: vi.fn(() => 'blob:slip') }));
    fireEvent.keyDown(window, { key: 'F9' });
    expect(await screen.findByText('Slip transaksi dibuka untuk dicetak.', { selector: 'p.text-xl' })).toBeTruthy();
    const slip = app.fetchMock.mock.calls.find(([url, init]) => String(url).endsWith(`branches/${BRANCH}/circulation/slips`) && init?.method === 'POST');
    expect(JSON.parse(String(slip?.[1]?.body))).toEqual({ loanIds: [], returnedLoanIds: [], paymentIds: [PAYMENT.id] });
    expect(tab.location.href).toBe('blob:slip');
  });

  it('a blocked member is told why on the card', async () => {
    const blocked = { ...deskMember({ blocked: 'unpaid' }), borrowRefusal: 'CIRC_MEMBER_BLOCKED' as const, canBorrow: false };
    start({ 'GET branches/:branchId/circulation/members/:memberId': () => blocked }, `/admin/layanan?member=${MEMBER_ID}`);
    expect((await screen.findAllByText('Diblokir: Tanggungan biaya melebihi batas')).length).toBeGreaterThan(0);
  });
});

describe('Denda & Pembayaran', () => {
  it('the daily cash summary lists each day, the methods and the staff', async () => {
    const summary: PaymentSummaryResponse = {
      from: '2026-11-15',
      to: '2026-11-15',
      currency: 'IDR',
      days: [{ day: '2026-11-15', count: 2, total: '3500.00', byMethod: { cash: '1500.00', transfer: '2000.00', other: '0.00' }, byStaff: [] }],
      all: { count: 2, total: '3500.00', byMethod: { cash: '1500.00', transfer: '2000.00', other: '0.00' } },
      byStaff: [{ staffId: '01JZ0000000000000000000S01', name: 'Siti Kasir', count: 2, total: '3500.00', byMethod: { cash: '1500.00', transfer: '2000.00', other: '0.00' } }],
      voided: { count: 1, total: '500.00' },
    };
    start(
      {
        'GET circulation/charges/open': () => ({ currency: 'IDR', items: [], total: '0.00', truncated: false }),
        'GET circulation/payments/summary': () => summary,
      },
      '/admin/layanan/denda',
    );
    expect(await screen.findByRole('heading', { name: 'Denda & Pembayaran' })).toBeTruthy();
    expect(await screen.findByText('Tidak ada anggota dengan tanggungan.')).toBeTruthy();
    fireEvent.mouseDown(screen.getByRole('tab', { name: 'Kas harian' }));
    const table = await screen.findByRole('table', { name: 'Pembayaran per hari' });
    expect(within(table).getAllByText('Rp 3.500').length).toBe(2);
    expect(screen.getByText('Siti Kasir')).toBeTruthy();
    expect(screen.getByText('1 pembayaran dibatalkan (Rp 500) tidak dihitung.')).toBeTruthy();
  });
});
