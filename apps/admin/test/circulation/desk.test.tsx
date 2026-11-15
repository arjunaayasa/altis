import type { BranchView } from '@altis/shared/api/branches';
import type { DeskMemberView, LoanResponse, ReturnResponse } from '@altis/shared/api/circulation';
import { idempotencyKeyField } from '@altis/shared/api/common';
import { fireEvent, screen, waitFor, within } from '@testing-library/react';
import { afterEach, beforeAll, beforeEach, describe, expect, it, vi } from 'vitest';
import { adminMe, problem, startApp, superMe, type FakeHandler } from '../fake-api';

// Meja Layanan: one scan box for a member card or an item barcode, each scan one transaction with its own
// Idempotency-Key, and the outcome said three ways (colour, a sentence, a live region). Kembali (F3) returns by barcode
// alone. A refusal is said in words from its code; an item the member already holds offers "Kembalikan sekarang".

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
const ITEM_ID = '01JZ0000000000000000000I01';
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

const LOAN: LoanResponse = {
  id: '01JZ0000000000000000000L01',
  version: 1,
  dueOn: '2026-11-22',
  item: { id: ITEM_ID, barcode: 'B0001', callNumber: '899.221 HIR l' },
  record: { id: RECORD_ID, title: 'Laskar Pelangi' },
};

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

async function scan(code: string): Promise<void> {
  // The box is a combobox while it looks a member up (name suggestions), a plain text box while it lends or returns.
  const box = await screen.findByLabelText(/^Pindai/);
  fireEvent.change(box, { target: { value: code } });
  fireEvent.click(screen.getByRole('button', { name: 'Proses' }));
}

const headerOf = (init: RequestInit | undefined, name: string): string | null => new Headers(init?.headers).get(name);

describe('Meja Layanan', () => {
  it('finds the member by card, then lends a scanned item with its own Idempotency-Key and says the due date', async () => {
    let member = deskMember();
    const app = start({
      'POST branches/:branchId/circulation/members/lookup': () => member,
      'GET branches/:branchId/circulation/members/:memberId': () => member,
      'POST branches/:branchId/circulation/loans': () => {
        member = deskMember({ counts: { openLoans: 1, overdue: 0, holdsReady: 0 }, loans: [{ id: LOAN.id, version: 1, branchId: BRANCH, item: LOAN.item, record: LOAN.record, loanedOn: '2026-11-15', dueOn: LOAN.dueOn, daysLate: 0, renewals: 0, renewLimit: 1, finePreview: null }] });
        return new Response(JSON.stringify(LOAN), { status: 201, headers: { 'Content-Type': 'application/json', 'X-Altis-Build': '0.1.0' } });
      },
    });

    expect(await screen.findByRole('heading', { name: 'Meja Layanan' })).toBeTruthy();
    expect(await screen.findByText('Belum ada anggota')).toBeTruthy();
    await scan('a001');
    expect(await screen.findByText('Anggota dimuat: Budi Santoso')).toBeTruthy();
    expect(app.requests.find((r) => r.path.endsWith('/members/lookup'))?.body).toEqual({ no: 'a001' });
    // The box now lends to this member.
    expect(await screen.findByRole('textbox', { name: 'Pindai eksemplar untuk dipinjam oleh Budi Santoso' })).toBeTruthy();
    expect(screen.queryByRole('combobox')).toBeNull();

    await scan('B0001');
    expect(await screen.findByText(/^Dipinjam: Laskar Pelangi — jatuh tempo/, { selector: 'p.text-xl' })).toBeTruthy();
    expect(screen.getByText('Pinjaman ke-1 dari 3. Pindai eksemplar berikutnya.')).toBeTruthy();
    const loanCall = app.fetchMock.mock.calls.find(([url, init]) => String(url).endsWith(`branches/${BRANCH}/circulation/loans`) && init?.method === 'POST');
    expect(JSON.parse(String(loanCall?.[1]?.body))).toEqual({ memberId: MEMBER_ID, barcode: 'B0001' });
    expect(headerOf(loanCall?.[1], 'Idempotency-Key')).toMatch(/^desk-loan:[0-9a-f]{32}$/);
    // Screen readers hear it from the fixed status region.
    await waitFor(() => expect(within(screen.getAllByRole('status')[0]!).queryByText(/Dipinjam: Laskar Pelangi/)).toBeTruthy());
    // The panel lists the loan.
    expect(await screen.findByRole('tab', { name: 'Dipinjam (1)' })).toBeTruthy();
  });

  it('says a refusal in words from its code, and offers to return an item the member already holds', async () => {
    const held = deskMember({
      counts: { openLoans: 1, overdue: 0, holdsReady: 0 },
      loans: [{ id: LOAN.id, version: 1, branchId: BRANCH, item: { ...LOAN.item, barcode: 'B0009' }, record: LOAN.record, loanedOn: '2026-11-10', dueOn: '2026-11-17', daysLate: 0, renewals: 0, renewLimit: 1, finePreview: null }],
    });
    const app = start({
      'POST branches/:branchId/circulation/members/lookup': () => held,
      'GET branches/:branchId/circulation/members/:memberId': () => held,
      'POST branches/:branchId/circulation/loans': (req) =>
        (req.body as { barcode: string }).barcode === 'B0009' ? problem(409, 'CIRC_ITEM_ON_LOAN') : problem(409, 'CIRC_NOT_LOANABLE', { reason: 'status' }),
      'POST branches/:branchId/circulation/returns': (): ReturnResponse => ({
        id: LOAN.id,
        version: 2,
        memberId: MEMBER_ID,
        memberNo: 'A001',
        item: { ...LOAN.item, barcode: 'B0009' },
        record: LOAN.record,
        loanedOn: '2026-11-10',
        dueOn: '2026-11-17',
        returnedOn: '2026-11-15',
        daysLate: 0,
      }),
    });

    await scan('A001');
    expect(await screen.findByText('Anggota dimuat: Budi Santoso')).toBeTruthy();

    await scan('B0002');
    expect(await screen.findByText('Eksemplar tidak tersedia untuk dipinjam.', { selector: 'p.text-xl' })).toBeTruthy();
    await waitFor(() => expect(within(screen.getByRole('alert')).queryByText('Eksemplar tidak tersedia untuk dipinjam.')).toBeTruthy());

    await scan('B0009');
    expect(await screen.findByText('Eksemplar ini sedang dipinjam anggota ini. Kembalikan sekarang?', { selector: 'p.text-xl' })).toBeTruthy();
    // Enter on the empty box accepts the offer.
    await scan('');
    expect(await screen.findByText('Dikembalikan tepat waktu')).toBeTruthy();
    expect(app.requests.find((r) => r.path.endsWith('/circulation/returns'))?.body).toEqual({ barcode: 'B0009' });
  });

  it('Enter in the name search acts on the text in the box, not on the suggestions of a shorter text still on screen', async () => {
    const people = [
      { id: '01JZ0000000000000000000A02', memberNo: 'A002', name: 'Siti Aminah', className: null, status: 'active' as const },
      { id: MEMBER_ID, memberNo: 'A001', name: 'Siti Badriah', className: null, status: 'active' as const },
    ];
    const app = start({
      'POST branches/:branchId/circulation/members/search': (req) => {
        const q = (req.body as { q: string }).q.toLowerCase();
        return { items: people.filter((p) => p.name.toLowerCase().startsWith(q)) };
      },
      'GET branches/:branchId/circulation/members/:memberId': (req) => {
        const p = people.find((x) => x.id === req.params.memberId)!;
        return deskMember({ id: p.id, memberNo: p.memberNo, name: p.name });
      },
    });
    await screen.findByRole('combobox', { name: 'Pindai kartu atau ketik nomor/nama anggota' });
    fireEvent.keyDown(window, { key: 'F6' });
    const box = await screen.findByRole('combobox', { name: 'Cari anggota per nama' });
    fireEvent.change(box, { target: { value: 'Siti' } });
    expect(await screen.findByRole('option', { name: /Siti Aminah/ })).toBeTruthy();
    // More text, and Enter before the pause that would refresh the suggestions.
    fireEvent.change(box, { target: { value: 'Siti B' } });
    fireEvent.click(screen.getByRole('button', { name: 'Proses' }));
    expect(await screen.findByText('Anggota dimuat: Siti Badriah')).toBeTruthy();
    expect(screen.queryByText('Anggota dimuat: Siti Aminah')).toBeNull();
    expect(app.requests.filter((r) => r.path.endsWith('/members/search')).map((r) => r.body)).toContainEqual({ q: 'Siti B' });
  });

  it('an item scanned while the member panel loads waits for it; a scan while a dialog is open is said, not lost in silence', async () => {
    let release = (): void => undefined;
    const loaded = new Promise<void>((resolve) => {
      release = resolve;
    });
    const app = start(
      {
        'GET branches/:branchId/circulation/members/:memberId': async () => {
          await loaded;
          return deskMember();
        },
        'POST branches/:branchId/circulation/loans': () => LOAN,
      },
      `/admin/layanan?member=${MEMBER_ID}`,
    );
    await scan('B0001');
    await new Promise((resolve) => setTimeout(resolve, 50));
    expect(app.writes()).toEqual([]);
    release();
    expect(await screen.findByText(/^Dipinjam: Laskar Pelangi — jatuh tempo/, { selector: 'p.text-xl' })).toBeTruthy();
    expect(app.writes()).toEqual([`POST branches/${BRANCH}/circulation/loans`]);

    fireEvent.click(screen.getByRole('button', { name: 'Pintasan (?)' }));
    await screen.findByRole('dialog');
    const target = document.activeElement ?? document.body;
    for (const key of ['B', '0', '0', '0', '2', 'Enter']) fireEvent.keyDown(target, { key });
    expect(
      await screen.findByText('Pindaian B0002 tidak diproses karena ada jendela yang terbuka. Tutup jendela itu, lalu pindai lagi.', { selector: 'p.text-xl' }),
    ).toBeTruthy();
    expect(app.writes()).toEqual([`POST branches/${BRANCH}/circulation/loans`]);
  });

  it('F3 switches to returns by barcode alone; a late return says how late', async () => {
    const app = start({
      'POST branches/:branchId/circulation/returns': (): ReturnResponse => ({
        id: LOAN.id,
        version: 2,
        memberId: MEMBER_ID,
        memberNo: 'A001',
        item: LOAN.item,
        record: LOAN.record,
        loanedOn: '2026-11-01',
        dueOn: '2026-11-08',
        returnedOn: '2026-11-11',
        daysLate: 3,
      }),
    });
    await screen.findByRole('combobox', { name: 'Pindai kartu atau ketik nomor/nama anggota' });
    fireEvent.keyDown(window, { key: 'F3' });
    expect(await screen.findByRole('textbox', { name: 'Pindai eksemplar yang dikembalikan' })).toBeTruthy();
    await scan('B0001');
    expect(await screen.findByText('Dikembalikan — terlambat 3 hari')).toBeTruthy();
    expect(app.requests.filter((r) => r.method === 'POST').map((r) => r.path)).toEqual([`branches/${BRANCH}/circulation/returns`]);
  });

  it('a late return whose fine left out closed days names both counts, so the fine does not look wrong', async () => {
    start({
      'POST branches/:branchId/circulation/returns': (): ReturnResponse => ({
        id: LOAN.id,
        version: 2,
        memberId: MEMBER_ID,
        memberNo: 'A001',
        item: LOAN.item,
        record: LOAN.record,
        loanedOn: '2026-10-29',
        dueOn: '2026-11-05',
        returnedOn: '2026-11-15',
        daysLate: 10,
        finedDays: 8,
      }),
    });
    await screen.findByRole('combobox', { name: 'Pindai kartu atau ketik nomor/nama anggota' });
    fireEvent.keyDown(window, { key: 'F3' });
    await screen.findByRole('textbox', { name: 'Pindai eksemplar yang dikembalikan' });
    await scan('B0001');
    expect(await screen.findByText('Dikembalikan — terlambat 10 hari (8 hari dikenai denda)')).toBeTruthy();
  });

  it('"Hilang" and "Ubah jatuh tempo" send an Idempotency-Key the API accepts, a new one for another request', async () => {
    const loan = { id: LOAN.id, version: 1, branchId: BRANCH, item: LOAN.item, record: LOAN.record, loanedOn: '2026-11-10', dueOn: '2026-11-17', daysLate: 0, renewals: 0, renewLimit: 1, finePreview: null };
    const held = deskMember({ counts: { openLoans: 1, overdue: 0, holdsReady: 0 }, loans: [loan] });
    // "Ubah jatuh tempo" needs the desk override, which the super admin holds.
    const app = startApp({
      me: superMe(),
      path: '/admin/layanan',
      routes: {
        'GET branches': () => ({ items: [BRANCH_VIEW] }),
        'POST branches/:branchId/circulation/members/search': () => ({ items: [] }),
        'POST branches/:branchId/circulation/members/lookup': () => held,
        'GET branches/:branchId/circulation/members/:memberId': () => held,
        'PATCH branches/:branchId/circulation/loans/:id/due': (req) => ({ id: LOAN.id, version: 2, dueOn: (req.body as { dueOn: string }).dueOn }),
        'POST branches/:branchId/circulation/loans/:id/lost': () => ({ id: LOAN.id, version: 3, itemStatus: 'lost', replacement: '85000.00', currency: 'IDR', charged: true }),
      },
    });
    await scan('a001');
    expect(await screen.findByText('Anggota dimuat: Budi Santoso')).toBeTruthy();
    fireEvent.mouseDown(await screen.findByRole('tab', { name: 'Dipinjam (1)' }));
    const keyOf = (method: string, suffix: string): string[] =>
      app.fetchMock.mock.calls.filter(([url, init]) => String(url).endsWith(suffix) && init?.method === method).map(([, init]) => headerOf(init, 'Idempotency-Key') ?? '');

    for (const day of ['2026-11-20', '2026-11-24']) {
      fireEvent.click(await screen.findByRole('button', { name: 'Ubah jatuh tempo' }));
      const due = await screen.findByRole('dialog', { name: 'Ubah jatuh tempo' });
      fireEvent.change(within(due).getByLabelText('Jatuh tempo baru'), { target: { value: day } });
      fireEvent.change(within(due).getByLabelText(/^Alasan/), { target: { value: 'Siswa sakit' } });
      fireEvent.click(within(due).getByRole('button', { name: 'Simpan jatuh tempo' }));
      await waitFor(() => expect(screen.queryByRole('dialog', { name: 'Ubah jatuh tempo' })).toBeNull());
    }
    const dueKeys = keyOf('PATCH', `/loans/${LOAN.id}/due`);
    expect(dueKeys).toHaveLength(2);
    for (const key of dueKeys) expect(idempotencyKeyField.safeParse(key).success).toBe(true);
    expect(dueKeys[0]).toMatch(/^desk-due:[0-9a-f]{32}$/);
    expect(dueKeys[1]).not.toBe(dueKeys[0]);

    fireEvent.click(screen.getByRole('button', { name: 'Hilang' }));
    const lost = await screen.findByRole('dialog', { name: 'Catat eksemplar hilang' });
    fireEvent.click(within(lost).getByRole('button', { name: 'Catat hilang' }));
    await waitFor(() => expect(keyOf('POST', `/loans/${LOAN.id}/lost`)).toHaveLength(1));
    const [lostKey] = keyOf('POST', `/loans/${LOAN.id}/lost`);
    expect(idempotencyKeyField.safeParse(lostKey).success).toBe(true);
    expect(lostKey).toMatch(/^desk-lost:[0-9a-f]{32}$/);
  });
});
