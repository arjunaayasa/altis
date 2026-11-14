import type { Permission } from '@altis/shared';
import type { MaterialTypeView } from '@altis/shared/api/catalog/masters';
import { RecordBulkBody, type RecordBulkResponse, type RecordListItem, type RecordListResponse } from '@altis/shared/api/catalog/records';
import { fireEvent, screen, within } from '@testing-library/react';
import { afterEach, describe, expect, it, vi } from 'vitest';
import { adminMe, signedIn, startApp, type FakeHandler, type FakeRequest } from '../fake-api';

// Bibliografi's bulk change of the accreditation fields: the selected records get the same Sasaran pembaca, Karya
// lokal, Jenis karya or Jenis referensi (`POST catalog/records/bulk {ids, set}`, at most 500 records); a field left
// "Tidak diubah" is not sent, "Kosongkan" sends null. The records the server refuses are listed by title with their
// reason.

vi.mock('@/components/catalog/print-queue', () => ({
  AddToPrintQueue: () => null,
}));

const MT_BOOK = '01JZ0000000000000000000B01';
const REC_A = '01JZ0000000000000000000RA1';
const REC_B = '01JZ0000000000000000000RB1';
const REC_C = '01JZ0000000000000000000RC1';

const BOOK: MaterialTypeView = {
  id: MT_BOOK,
  code: 'BUKU',
  nameId: 'Buku',
  nameEn: 'Book',
  marcType: 'a',
  marcLevel: 'm',
  contentType: 'txt',
  mediaType: 'n',
  carrierType: 'nc',
  schemaType: 'Book',
  dcmiType: 'Text',
  template: { fields: {}, defaults: {}, customFields: [] },
  sortOrder: 0,
  usage: 0,
  archived: false,
  version: 1,
};

function row(id: string, title: string): RecordListItem {
  return {
    id,
    title,
    subtitle: null,
    mainAgent: null,
    materialTypeId: MT_BOOK,
    year: null,
    callNumber: null,
    itemCount: 0,
    coverFileId: null,
    opacVisible: true,
    archived: false,
    changedAt: 1_760_000_000_000,
  };
}

const ROWS = [row(REC_A, 'Dongeng Kancil'), row(REC_B, 'Cerita Rakyat Nusantara'), row(REC_C, 'Kamus Bergambar')];

function start(o: { permissions?: readonly Permission[]; bulk?: FakeHandler } = {}) {
  return startApp({
    me: o.permissions === undefined ? adminMe() : signedIn({ permissions: o.permissions }),
    path: '/admin/catalog/records',
    routes: {
      'GET catalog/records': (): RecordListResponse => ({ items: ROWS, total: null, nextCursor: null, page: null }),
      'GET catalog/material-types': () => ({ items: [BOOK] }),
      'POST catalog/records/bulk': o.bulk ?? ((): RecordBulkResponse => ({ updated: 3, refused: [] })),
    },
  });
}

const bulkBodies = (requests: FakeRequest[]): unknown[] => requests.filter((r) => r.method === 'POST' && r.path === 'catalog/records/bulk').map((r) => r.body);

async function openDialog(): Promise<HTMLElement> {
  await screen.findByRole('link', { name: 'Dongeng Kancil' }, { timeout: 10_000 });
  fireEvent.click(screen.getByRole('checkbox', { name: 'Pilih semua yang tampil' }));
  fireEvent.click(screen.getByRole('button', { name: 'Ubah data akreditasi' }));
  return screen.findByRole('dialog', { name: 'Ubah data akreditasi cantuman' });
}

afterEach(() => {
  vi.unstubAllGlobals();
  vi.restoreAllMocks();
});

describe('Bibliografi: bulk change of the accreditation fields', () => {
  it('posts {ids, set} with only the field chosen, then lists the refusals by title with their reason', async () => {
    const { requests } = start({
      bulk: (): RecordBulkResponse => ({
        updated: 1,
        refused: [
          { id: REC_B, code: 'archived' },
          { id: REC_C, code: 'not_found' },
        ],
      }),
    });
    const dialog = await openDialog();
    expect(within(dialog).getByText(/3 cantuman terpilih/)).toBeTruthy();
    expect(within(dialog).getByText(/tidak membuat cantuman hasil migrasi dianggap disunting di ALTIS/)).toBeTruthy();
    fireEvent.change(within(dialog).getByLabelText('Sasaran pembaca'), { target: { value: 'children' } });
    fireEvent.click(within(dialog).getByRole('button', { name: 'Terapkan' }));
    expect(await within(dialog).findByText('1 cantuman diubah.')).toBeTruthy();
    const body = { ids: [REC_A, REC_B, REC_C], set: { audience: 'children' } };
    expect(bulkBodies(requests)).toEqual([body]);
    expect(RecordBulkBody.safeParse(body).success).toBe(true);
    const refused = within(dialog).getByRole('list', { name: 'Tidak diubah (2)' });
    expect(within(refused).getAllByRole('listitem').map((li) => li.textContent)).toEqual([
      'Cerita Rakyat Nusantara — Cantuman sudah diarsipkan.',
      'Kamus Bergambar — Cantuman tidak ditemukan.',
    ]);
  });

  it('"Kosongkan" sends null, several fields go in one request, and nothing is sent before a change is chosen', async () => {
    const { requests } = start();
    const dialog = await openDialog();
    fireEvent.click(within(dialog).getByRole('button', { name: 'Terapkan' }));
    expect(await within(dialog).findByText('Pilih sedikitnya satu perubahan.')).toBeTruthy();
    expect(bulkBodies(requests)).toEqual([]);

    fireEvent.change(within(dialog).getByLabelText('Karya lokal'), { target: { value: 'student' } });
    fireEvent.change(within(dialog).getByLabelText('Jenis karya'), { target: { value: 'short_stories' } });
    fireEvent.change(within(dialog).getByLabelText('Jenis referensi'), { target: { value: 'none' } });
    expect(within(within(dialog).getByLabelText('Jenis referensi')).getByRole('option', { name: 'Kosongkan' })).toBeTruthy();
    fireEvent.click(within(dialog).getByRole('button', { name: 'Terapkan' }));
    expect(await within(dialog).findByText('3 cantuman diubah.')).toBeTruthy();
    expect(bulkBodies(requests)).toEqual([{ ids: [REC_A, REC_B, REC_C], set: { localWork: 'student', localWorkKind: 'short_stories', referenceKind: null } }]);
    expect(RecordBulkBody.safeParse(bulkBodies(requests)[0]).success).toBe(true);
  });

  it('is offered only to a user who manages records', async () => {
    start({ permissions: ['catalog.records.read'] });
    await screen.findByRole('link', { name: 'Dongeng Kancil' }, { timeout: 10_000 });
    fireEvent.click(screen.getByRole('checkbox', { name: 'Pilih semua yang tampil' }));
    expect(screen.getByText('3 dipilih')).toBeTruthy();
    expect(screen.queryByRole('button', { name: 'Ubah data akreditasi' })).toBeNull();
  });
});
