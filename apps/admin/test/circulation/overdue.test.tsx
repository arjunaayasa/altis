import type { BranchView } from '@altis/shared/api/branches';
import type { LoanListItem } from '@altis/shared/api/circulation';
import { fireEvent, screen } from '@testing-library/react';
import { afterEach, beforeAll, describe, expect, it, vi } from 'vitest';
import { adminMe, startApp } from '../fake-api';

// Terlambat & Jatuh Tempo: the list comes a page at a time and the API gives no total, so the summary must not pass
// the loaded rows off as the whole count.

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
        'GET circulation/loans': (req) =>
          req.query.get('cursor') === null ? { items: [overdueLoan(1, 20), overdueLoan(2, 5)], nextCursor: 'next' } : { items: [overdueLoan(3, 2)], nextCursor: null },
      },
    });
    expect(
      await screen.findByText('Yang sudah dimuat: 2 pinjaman · 2 anggota · terlama 20 hari. Masih ada lagi; muat lebih banyak untuk melihatnya.'),
    ).toBeTruthy();
    expect(screen.queryByText('2 pinjaman · 2 anggota · terlama 20 hari')).toBeNull();
    fireEvent.click(screen.getByRole('button', { name: 'Muat lebih banyak' }));
    expect(await screen.findByText('3 pinjaman · 3 anggota · terlama 20 hari')).toBeTruthy();
  });
});
