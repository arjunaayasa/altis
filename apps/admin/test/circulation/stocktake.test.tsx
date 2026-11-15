import type { BranchView } from '@altis/shared/api/branches';
import type { StocktakeScanResponse, StocktakeView } from '@altis/shared/api/stocktake';
import { fireEvent, screen, waitFor, within } from '@testing-library/react';
import { afterEach, beforeAll, beforeEach, describe, expect, it, vi } from 'vitest';
import { adminMe, problem, startApp } from '../fake-api';

// Inventarisasi: the session list offers a new session and opens the live one; the session page scans with the keyboard
// (typing and Enter), says what each scan found in words, lists my last scans with "Batalkan", and finishes only with
// the session's name typed in full. After my scan, the counts the session's next poll reads replace my scan's.

beforeAll(async () => {
  await import('@/screens/stocktake/stocktake');
});

beforeEach(() => {
  localStorage.clear();
});

afterEach(() => {
  vi.unstubAllGlobals();
  vi.restoreAllMocks();
});

const BRANCH = '01JZ0000000000000000000B01';
const ID = '01JZ0000000000000000000S01';
const ITEM = '01JZ0000000000000000000I01';

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

const COUNTS = { total: 10, found: 0, misplaced: 0, onLoan: 1, pending: 9, unexpected: 0, unknownCodes: 0 };

function session(o: Partial<StocktakeView> = {}): StocktakeView {
  return {
    id: ID,
    version: 1,
    branch: { id: BRANCH, code: 'PUSAT', name: 'Perpustakaan Pusat' },
    name: 'Inventarisasi 2026',
    scope: {},
    scopeNames: { locations: [], collectionTypes: [], materialTypes: [] },
    status: 'active',
    source: 'altis',
    counts: COUNTS,
    startedAt: Date.UTC(2026, 10, 15, 2),
    startedBy: { id: '01JZ0000000000000000000A01', name: 'Ani' },
    finishedAt: null,
    finishedBy: null,
    options: null,
    jobId: null,
    pendingUploads: 0,
    ...o,
  };
}

const empty = () => ({ items: [], nextCursor: null });

describe('stocktake', () => {
  it('the list shows the live session and the history; a new session is offered only when none is live', async () => {
    startApp({
      me: adminMe(),
      path: '/admin/layanan/inventarisasi',
      routes: {
        'GET branches': () => ({ items: [BRANCH_VIEW] }),
        'GET branches/:branchId/stocktakes': () => ({ items: [session(), session({ id: '01JZ0000000000000000000S00', name: 'Inventarisasi 2023', status: 'finished', finishedAt: 1 })] }),
      },
    });
    expect(await screen.findByText('Sesi "Inventarisasi 2026" sedang berjalan di cabang ini.')).toBeTruthy();
    const table = await screen.findByRole('table', { name: 'Riwayat sesi' });
    expect(within(table).getByText('Inventarisasi 2023')).toBeTruthy();
    expect(within(table).getAllByText('Selesai')).toHaveLength(2);
    expect(screen.queryByRole('button', { name: 'Buat sesi' })).toBeNull();
  });

  it('a new session names the collection types in the language of the screen', async () => {
    const me = adminMe();
    const type = (code: string, nameId: string, nameEn: string) => ({ id: `01JZ00000000000000000C${code.slice(0, 4).padEnd(4, '0')}`, code, nameId, nameEn, loanable: true, selfService: false, sortOrder: 0, usage: 0, archived: false, version: 1 });
    startApp({
      me: { ...me, user: { ...me.user, locale: 'en' } },
      path: '/admin/layanan/inventarisasi',
      routes: {
        'GET branches': () => ({ items: [BRANCH_VIEW] }),
        'GET branches/:branchId/stocktakes': () => ({ items: [] }),
        'GET catalog/locations': () => ({ items: [] }),
        'GET catalog/collection-types': () => ({ items: [type('UMUM', 'Umum', 'General'), type('REF', 'Referensi', 'Reference')] }),
      },
    });
    const select = await screen.findByLabelText('Collection types');
    await waitFor(() => expect([...select.querySelectorAll('option')].map((o) => o.textContent)).toEqual(['General (UMUM)', 'Reference (REF)']));
  });

  it('scans by keyboard, says each outcome in words, undoes my scan, and finishes with the name typed', async () => {
    const scans: unknown[] = [];
    const answers: StocktakeScanResponse[] = [
      { outcome: 'found', code: 'B0001', item: { id: ITEM, barcode: 'B0001', title: 'Bumi Manusia', callNumber: '899 PRA', location: { id: 'L1', name: 'Rak A' } }, counts: { ...COUNTS, found: 1, pending: 8 } },
      { outcome: 'unknown', code: 'XYZ', item: null, counts: { ...COUNTS, found: 1, pending: 8, unknownCodes: 1 } },
      { outcome: 'on_loan', code: 'B0002', item: { id: 'I2', barcode: 'B0002', title: 'Anak Semua Bangsa', callNumber: null, location: null }, counts: { ...COUNTS, found: 1, pending: 8, unknownCodes: 1 } },
    ];
    let undone = 0;
    let finish: unknown = null;
    startApp({
      me: adminMe(),
      path: `/admin/layanan/inventarisasi/${BRANCH}/${ID}`,
      routes: {
        'GET branches': () => ({ items: [BRANCH_VIEW] }),
        'GET branches/:branchId/stocktakes/:id': () => session(),
        'GET branches/:branchId/stocktakes/:id/items': empty,
        'GET branches/:branchId/stocktakes/:id/unknown-codes': empty,
        'GET branches/:branchId/stocktakes/:id/officers': () => ({ items: [] }),
        'GET catalog/locations': () => ({ items: [] }),
        'POST branches/:branchId/stocktakes/:id/scans': (req) => {
          scans.push(req.body);
          return answers[scans.length - 1];
        },
        'DELETE branches/:branchId/stocktakes/:id/scans/:itemId': () => {
          undone += 1;
          return { undone: true, counts: COUNTS };
        },
        'POST branches/:branchId/stocktakes/:id/finish': (req) => {
          finish = req.body;
          return (req.body as { confirmName: string }).confirmName === 'Inventarisasi 2026' ? { id: ID, jobId: 'J1' } : problem(422, 'VALIDATION_FAILED', { errors: [{ path: 'confirmName', code: 'mismatch' }] });
        },
      },
    });
    const box = await screen.findByLabelText(/^Pindai atau ketik barkod/);
    const scan = (code: string) => {
      fireEvent.change(box, { target: { value: code } });
      fireEvent.submit(box.closest('form')!);
    };
    scan('B0001');
    expect(await screen.findByText('Tercatat ditemukan.')).toBeTruthy();
    expect(screen.getByText('Bumi Manusia', { selector: 'p' })).toBeTruthy();
    scan('XYZ');
    expect(await screen.findByText('Kode ini tidak dikenal sebagai barkod eksemplar; dicatat di daftar kode tak dikenal.')).toBeTruthy();
    scan('B0002');
    expect(await screen.findByText('Eksemplar ada di rak tetapi tercatat dipinjam. Periksa di Meja Layanan.')).toBeTruthy();
    expect(scans).toEqual([{ barcode: 'B0001' }, { barcode: 'XYZ' }, { barcode: 'B0002' }]);

    // My last scans: only the found copy can be undone.
    const recent = screen.getByText('Pindaian terakhir saya').parentElement!;
    const undo = within(recent).getAllByRole('button', { name: 'Batalkan' });
    expect(undo).toHaveLength(1);
    fireEvent.click(undo[0]!);
    await waitFor(() => expect(undone).toBe(1));
    expect(await within(recent).findByText('dibatalkan')).toBeTruthy();

    fireEvent.click(screen.getByRole('button', { name: 'Selesaikan sesi' }));
    const dialog = await screen.findByRole('dialog');
    fireEvent.change(within(dialog).getByLabelText(/^Ketik nama sesi/), { target: { value: 'Inventarisasi' } });
    fireEvent.click(within(dialog).getByRole('button', { name: 'Selesaikan' }));
    expect(await within(dialog).findByText('Nama sesi tidak sama.')).toBeTruthy();
    expect(finish).toBeNull();
    fireEvent.change(within(dialog).getByLabelText(/^Ketik nama sesi/), { target: { value: 'Inventarisasi 2026' } });
    fireEvent.click(within(dialog).getByRole('button', { name: 'Selesaikan' }));
    await waitFor(() => expect(finish).toEqual({ confirmName: 'Inventarisasi 2026', markMissing: true, restoreFound: true }));
  });

  it('shows the polled counts again after my scan', async () => {
    let polled = COUNTS;
    const app = startApp({
      me: adminMe(),
      path: `/admin/layanan/inventarisasi/${BRANCH}/${ID}`,
      routes: {
        'GET branches': () => ({ items: [BRANCH_VIEW] }),
        'GET branches/:branchId/stocktakes/:id': () => session({ counts: polled }),
        'GET branches/:branchId/stocktakes/:id/items': empty,
        'GET branches/:branchId/stocktakes/:id/unknown-codes': empty,
        'GET branches/:branchId/stocktakes/:id/officers': () => ({ items: [] }),
        'GET catalog/locations': () => ({ items: [] }),
        'POST branches/:branchId/stocktakes/:id/scans': () => ({
          outcome: 'found',
          code: 'B0001',
          item: { id: ITEM, barcode: 'B0001', title: 'Bumi Manusia', callNumber: null, location: null },
          counts: { ...COUNTS, found: 1, pending: 8 },
        }),
      },
    });
    const found = () => screen.getByText('Ditemukan', { selector: 'dt' }).nextElementSibling?.textContent;
    const box = await screen.findByLabelText(/^Pindai atau ketik barkod/);
    fireEvent.change(box, { target: { value: 'B0001' } });
    fireEvent.submit(box.closest('form')!);
    expect(await screen.findByText('Tercatat ditemukan.')).toBeTruthy();
    await waitFor(() => expect(found()).toBe('1'));
    // Three other officers scanned meanwhile: the next poll reads their scans too.
    polled = { ...COUNTS, found: 4, pending: 5 };
    await app.queryClient.refetchQueries({ queryKey: ['stocktake', 'session', ID] });
    await waitFor(() => expect(found()).toBe('4'));
  });
});
