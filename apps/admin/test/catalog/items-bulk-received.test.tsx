import { ItemBulkBody, type ItemListItem } from '@altis/shared/api/catalog/items';
import { fireEvent, screen, within } from '@testing-library/react';
import { afterEach, describe, expect, it, vi } from 'vitest';
import { adminMe, startApp, type FakeHandler } from '../fake-api';
import { FIRST, PUSAT, catalogReads, itemDetail, listItem, ulid } from './items-fixtures';

// Eksemplar's bulk change of the receiving date: "Tanggal terima" fills only the copies without one ("Isi yang
// kosong", the default, sent as `receivedDateMode: 'fill_empty'`) or every selected copy ("Timpa semua", `overwrite`).
// A date filled this way is an edit made in ALTIS: before the change is confirmed, the dialog says that such copies no
// longer follow a SLiMS re-sync. The copies that already had a date are refused `received_date_set` and listed.

afterEach(() => {
  vi.unstubAllGlobals();
  vi.restoreAllMocks();
});

const ROWS: ItemListItem[] = [listItem({ id: ulid('01JZEKS', 1), barcode: 'B0000001' }), listItem({ id: ulid('01JZEKS', 2), barcode: 'B0000002' })];

function start(bulk: FakeHandler) {
  const sent: unknown[] = [];
  startApp({
    me: adminMe(),
    path: '/admin/catalog/items',
    routes: catalogReads({
      'GET catalog/items': () => ({ items: ROWS, nextCursor: null }),
      'GET catalog/items/:id': (req) => itemDetail({ id: req.params.id! }),
      'POST branches/:branchId/items/bulk': (req) => {
        sent.push(req.body);
        return bulk(req);
      },
    }),
  });
  return sent;
}

async function openDialog(): Promise<HTMLElement> {
  await screen.findByText('B0000001', undefined, FIRST);
  fireEvent.click(screen.getByRole('checkbox', { name: 'Pilih semua eksemplar yang tampil' }));
  fireEvent.click(screen.getByRole('button', { name: 'Ubah massal' }));
  return screen.findByRole('form', { name: 'Ubah massal eksemplar' });
}

const SYNC_NOTE = /tidak lagi mengikuti penyelarasan ulang dari SLiMS/;

describe('Eksemplar: bulk receiving date', () => {
  it('posts receivedDateMode fill_empty by default, and lists the copies that already had a date', async () => {
    const sent = start(() => ({ updated: 1, refused: [{ id: ulid('01JZEKS', 2), code: 'received_date_set' }] }));
    const dialog = await openDialog();
    expect(within(dialog).queryByText(SYNC_NOTE)).toBeNull();
    const fillEmpty = within(dialog).getByRole('radio', { name: 'Isi yang kosong' }) as HTMLInputElement;
    expect(fillEmpty.checked).toBe(true);
    fireEvent.change(within(dialog).getByLabelText('Tanggal terima'), { target: { value: '2024-07-15' } });
    fireEvent.click(within(dialog).getByRole('button', { name: 'Terapkan' }));
    expect(await within(dialog).findByText('1 eksemplar diubah.')).toBeTruthy();
    const body = { ids: ROWS.map((r) => r.id), set: { receivedDate: '2024-07-15' }, receivedDateMode: 'fill_empty' };
    expect(sent).toEqual([body]);
    expect(ItemBulkBody.safeParse(body).success).toBe(true);
    const refused = within(dialog).getByRole('list', { name: 'Tidak diubah (1)' });
    expect(within(refused).getAllByRole('listitem').map((li) => li.textContent)).toEqual([
      'B0000002 — Tanggal terimanya sudah terisi; pilih timpa untuk mengubahnya.',
    ]);
  });

  it('shows the leave-sync sentence before the confirm button once a date is entered, and posts overwrite when chosen', async () => {
    const sent = start(() => ({ updated: 2, refused: [] }));
    const dialog = await openDialog();
    fireEvent.change(within(dialog).getByLabelText('Tanggal terima'), { target: { value: '2023-01-02' } });
    const note = within(dialog).getByText(SYNC_NOTE);
    expect(note.textContent).toMatch(/dihitung sebagai disunting di ALTIS/);
    const apply = within(dialog).getByRole('button', { name: 'Terapkan' });
    // The sentence comes before the button in the dialog's reading order.
    expect(note.compareDocumentPosition(apply) & Node.DOCUMENT_POSITION_FOLLOWING).toBeTruthy();
    fireEvent.click(within(dialog).getByRole('radio', { name: 'Timpa semua' }));
    fireEvent.click(apply);
    expect(await within(dialog).findByText('2 eksemplar diubah.')).toBeTruthy();
    expect(sent).toEqual([{ ids: ROWS.map((r) => r.id), set: { receivedDate: '2023-01-02' }, receivedDateMode: 'overwrite' }]);
  });

  it('a change without a receiving date sends no receivedDateMode', async () => {
    const sent = start(() => ({ updated: 2, refused: [] }));
    const dialog = await openDialog();
    fireEvent.change(within(dialog).getByRole('combobox', { name: 'Ubah status ke' }), { target: { value: 'repair' } });
    fireEvent.click(within(dialog).getByRole('button', { name: 'Terapkan' }));
    expect(await within(dialog).findByText('2 eksemplar diubah.')).toBeTruthy();
    expect(sent).toEqual([{ ids: ROWS.map((r) => r.id), set: { status: 'repair' } }]);
    expect(PUSAT).toBe(ROWS[0]!.branch.id);
  });
});
