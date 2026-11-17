import type { BranchView } from '@altis/shared/api/branches';
import type { LoanListItem } from '@altis/shared/api/circulation';
import { fireEvent, screen, waitFor } from '@testing-library/react';
import { afterEach, beforeAll, describe, expect, it, vi } from 'vitest';
import { adminMe, startApp } from '../fake-api';

// Terlambat & Jatuh Tempo: the list comes a page at a time and the API gives no total, so the summary must not pass
// the loaded rows off as the whole count. The search and the class go in the body of a POST read, never in a URL; the
// due-soon tab asks for its own list; a member's phone shows in the group head when the server sends it.

beforeAll(async () => {
  await import('@/screens/circulation/overdue');
});

afterEach(() => {
  vi.unstubAllGlobals();
  vi.restoreAllMocks();
});

const BRANCH = 'B1';

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

function overdueLoan(n: number, daysLate: number): LoanListItem {
  return {
    id: `01JZ0000000000000000000L0${n}`,
    version: 1,
    state: 'open',
    overdue: true,
    daysLate,
    branchId: BRANCH,
    loanedOn: '2026-10-01',
    dueOn: '2026-10-08',
    returnedOn: null,
    outcome: null,
    renewals: 0,
    renewLimit: 1,
    item: { id: `01JZ0000000000000000000I0${n}`, barcode: `B000${n}`, callNumber: null },
    record: { id: `01JZ0000000000000000000R0${n}`, title: `Judul ${n}` },
    member: { id: `01JZ0000000000000000000A0${n}`, memberNo: `A00${n}`, name: `Anggota ${n}`, className: null, typeId: '01JZ0000000000000000000T01' },
    finePreview: null,
  };
}

describe('Terlambat & Jatuh Tempo', () => {
  it('the summary counts the loans loaded so far while more pages remain, and the whole list once it is all loaded', async () => {
    startApp({
      me: adminMe(),
      path: '/admin/layanan/terlambat',
      routes: {
        'GET branches': () => ({ items: [BRANCH_VIEW] }),
        'GET members/types': () => ({ items: [] }),
        'GET circulation/loans/classes': () => ({ items: [] }),
        'POST circulation/loans/search': (req) =>
          (req.body as { cursor?: string }).cursor === undefined ? { items: [overdueLoan(1, 20), overdueLoan(2, 5)], nextCursor: 'next' } : { items: [overdueLoan(3, 2)], nextCursor: null },
      },
    });
    expect(
      await screen.findByText('Yang sudah dimuat: 2 pinjaman · 2 anggota · terlama 20 hari. Masih ada lagi; muat lebih banyak untuk melihatnya.'),
    ).toBeTruthy();
    expect(screen.queryByText('2 pinjaman · 2 anggota · terlama 20 hari')).toBeNull();
    fireEvent.click(screen.getByRole('button', { name: 'Muat lebih banyak' }));
    expect(await screen.findByText('3 pinjaman · 3 anggota · terlama 20 hari')).toBeTruthy();
  });

  it('the search, the class and the due-soon tab are sent in the body of the POST read; the phone shows when sent', async () => {
    const withPhone = { ...overdueLoan(1, 3), member: { ...overdueLoan(1, 3).member!, className: 'X-1', phone: '0811-111' } };
    const app = startApp({
      me: adminMe(),
      path: '/admin/layanan/terlambat',
      routes: {
        'GET branches': () => ({ items: [BRANCH_VIEW] }),
        'GET members/types': () => ({ items: [] }),
        'GET circulation/loans/classes': () => ({ items: ['X-1', 'X-2'] }),
        'POST circulation/loans/search': (req) => ((req.body as { tab: string }).tab === 'due_soon' ? { items: [], nextCursor: null } : { items: [withPhone], nextCursor: null }),
      },
    });
    expect(await screen.findByText(/0811-111/)).toBeTruthy();
    fireEvent.change(screen.getByLabelText('Kelas'), { target: { value: 'X-1' } });
    fireEvent.change(screen.getByLabelText('Cari anggota'), { target: { value: 'Ana' } });
    fireEvent.submit(screen.getByRole('form', { name: 'Saringan daftar terlambat' }));
    await waitFor(() => expect(app.requests.some((r) => r.method === 'POST' && (r.body as { q?: string }).q === 'Ana')).toBe(true));
    const sent = app.requests.filter((r) => r.path === 'circulation/loans/search').at(-1)!;
    expect(sent.body).toEqual({ tab: 'overdue', limit: 50, q: 'Ana', className: 'X-1' });
    expect(app.requests.every((r) => !r.query.toString().includes('Ana'))).toBe(true);
    fireEvent.mouseDown(screen.getByRole('tab', { name: 'Jatuh tempo dalam 3 hari' }));
    fireEvent.click(screen.getByRole('tab', { name: 'Jatuh tempo dalam 3 hari' }));
    expect(await screen.findByText('Tidak ada pinjaman jatuh tempo yang cocok dengan saringan ini.')).toBeTruthy();
    expect(app.requests.filter((r) => r.path === 'circulation/loans/search').at(-1)!.body).toMatchObject({ tab: 'due_soon', q: 'Ana', className: 'X-1' });
  });
});
