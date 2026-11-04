import type { CollectionTypeView, MaterialTypeView } from '@altis/shared/api/catalog/masters';
import type { RunView } from '@altis/shared/api/catalog/runs';
import type { JobView } from '@altis/shared/api/jobs';
import { fireEvent, screen, waitFor, within } from '@testing-library/react';
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import { EXPORT_SELECTION_KEY as RECORDS_SELECTION_KEY } from '@/screens/catalog/records/list';
import { EXPORT_SELECTION_KEY } from '@/screens/catalog/exchange/export-form';
import { BRANCH_MAIN, BRANCH_NORTH, json, signedIn, startApp, type FakeHandler, type FakeRequest } from '../fake-api';

// Impor/Ekspor, the export form (Phase 2 spec §5.4, §13; plan Task 29): a format and the filters of `ExportBody`, or
// the records chosen in Bibliografi ("Ekspor terpilih", M2): their ids travel through `sessionStorage`, are read once
// when the page opens with `?export=selection`, and are cleared. The export runs as a job; its run then offers the
// file until it expires.

const T0 = 1_760_000_000_000;
const R1 = '01JZ0000000000000000000R01';
const R2 = '01JZ0000000000000000000R02';
const EXPORT = '01JZ0000000000000000000N09';
const MT_THESIS = '01JZ0000000000000000000B02';
const CT_REF = '01JZ0000000000000000000C02';

const THESIS: MaterialTypeView = {
  id: MT_THESIS,
  code: 'SKRIPSI',
  nameId: 'Skripsi',
  nameEn: 'Thesis',
  marcType: 'a',
  marcLevel: 'm',
  contentType: 'txt',
  mediaType: 'n',
  carrierType: 'nc',
  schemaType: 'Thesis',
  dcmiType: 'Text',
  template: { fields: {}, defaults: {}, customFields: [] },
  sortOrder: 0,
  usage: 1,
  archived: false,
  version: 1,
};

const REFERENCE: CollectionTypeView = {
  id: CT_REF,
  code: 'REFERENSI',
  nameId: 'Referensi',
  nameEn: 'Reference',
  loanable: false,
  selfService: false,
  sortOrder: 1,
  usage: 0,
  archived: false,
  version: 1,
};

const EXPIRES = T0 + 7 * 86_400_000;

const exportRun = (): RunView => ({
  id: EXPORT,
  kind: 'export',
  status: 'succeeded',
  dryRun: false,
  format: 'marcxml',
  options: {},
  summary: { records: 2 },
  reportFileId: null,
  outputName: `${EXPORT}.xml`,
  outputSize: 2048,
  expiresAt: EXPIRES,
  jobId: 'J5',
  createdAt: T0,
  createdBy: 'U1',
  finishedAt: T0 + 5_000,
});

const job = (id: string): JobView => ({
  id,
  type: 'catalog.export',
  status: 'succeeded',
  progress: 100,
  progressMessage: null,
  attempts: 1,
  maxAttempts: 3,
  lastError: null,
  runAt: T0,
  createdAt: T0,
  updatedAt: T0,
  finishedAt: T0,
  createdBy: 'U1',
  retryable: 'origin-only',
  cancellable: true,
  interactive: false,
});

function start(path: string, routes: Record<string, FakeHandler> = {}) {
  return startApp({
    me: signedIn({ permissions: ['catalog.records.read', 'catalog.export.run'] }),
    path,
    routes: {
      'GET branches': () => ({ items: [BRANCH_MAIN, BRANCH_NORTH] }),
      'GET catalog/material-types': () => ({ items: [THESIS] }),
      'GET catalog/collection-types': () => ({ items: [REFERENCE] }),
      'POST catalog/exports': () => json({ runId: EXPORT, jobId: 'J5' }, 202),
      'GET jobs/:id': (req) => job(req.params['id']!),
      [`GET catalog/runs/${EXPORT}`]: () => exportRun(),
      ...routes,
    },
  });
}

const exportBodies = (requests: FakeRequest[]): unknown[] => requests.filter((r) => r.method === 'POST' && r.path === 'catalog/exports').map((r) => r.body);

/** Epoch ms of a local day's first millisecond. */
const localDay = (day: string): number => new Date(`${day}T00:00:00`).getTime();

beforeEach(() => {
  sessionStorage.clear();
});

afterEach(() => {
  vi.unstubAllGlobals();
  vi.restoreAllMocks();
});

describe('the export form', () => {
  it('reads the selection Bibliografi stored under the same key', () => {
    expect(EXPORT_SELECTION_KEY).toBe(RECORDS_SELECTION_KEY);
  });

  it('posts filter.recordIds from the sessionStorage selection, clears it, and offers the file until it expires', async () => {
    sessionStorage.setItem(EXPORT_SELECTION_KEY, JSON.stringify([R1, R2]));
    const { requests, router } = start('/admin/catalog/exchange?export=selection');
    expect(await screen.findByText('2 cantuman terpilih dari Bibliografi')).toBeTruthy();
    expect(screen.getByRole('tab', { name: 'Ekspor' }).getAttribute('aria-selected')).toBe('true');
    // Read once: the storage is cleared and the address no longer asks for it.
    await waitFor(() => expect(sessionStorage.getItem(EXPORT_SELECTION_KEY)).toBeNull());
    await waitFor(() => expect(router.state.location.search).toEqual({ tab: 'export' }));
    // A selection replaces the search filters.
    expect(screen.queryByLabelText('Kata pencarian')).toBeNull();

    fireEvent.change(screen.getByLabelText('Format ekspor'), { target: { value: 'marcxml' } });
    fireEvent.click(screen.getByLabelText('Sertakan data eksemplar'));
    fireEvent.click(screen.getByRole('button', { name: 'Mulai ekspor' }));
    await waitFor(() => expect(exportBodies(requests)).toEqual([{ format: 'marcxml', filter: { recordIds: [R1, R2], includeItems: true } }]));

    const result = await screen.findByRole('region', { name: 'Hasil ekspor' });
    const link = within(result).getByRole('link', { name: 'Unduh berkas ekspor' });
    expect(link.getAttribute('href')).toBe(`/api/v1/catalog/runs/${EXPORT}/download`);
    expect(within(result).getByText(/Berkas dapat diunduh sampai/)).toBeTruthy();
  });

  it('"Ekspor dengan filter" drops the selection', async () => {
    sessionStorage.setItem(EXPORT_SELECTION_KEY, JSON.stringify([R1]));
    const { requests } = start('/admin/catalog/exchange?export=selection');
    expect(await screen.findByText('1 cantuman terpilih dari Bibliografi')).toBeTruthy();
    fireEvent.click(screen.getByRole('button', { name: 'Ekspor dengan filter' }));
    expect(await screen.findByLabelText('Kata pencarian')).toBeTruthy();
    fireEvent.click(screen.getByRole('button', { name: 'Mulai ekspor' }));
    await waitFor(() => expect(exportBodies(requests)).toEqual([{ format: 'marc21', filter: {} }]));
  });

  it('without a selection, posts the filters (the change day as local midnight)', async () => {
    const { requests } = start('/admin/catalog/exchange?tab=export');
    fireEvent.change(await screen.findByLabelText('Kata pencarian'), { target: { value: '  pengarang:hirata  ' } });
    fireEvent.change(await screen.findByLabelText('Jenis bahan'), { target: { value: MT_THESIS } });
    fireEvent.change(await screen.findByLabelText('Tipe koleksi'), { target: { value: CT_REF } });
    fireEvent.change(await screen.findByLabelText('Cabang'), { target: { value: BRANCH_NORTH.id } });
    fireEvent.change(screen.getByLabelText('Diubah sejak'), { target: { value: '2026-01-02' } });
    fireEvent.click(screen.getByLabelText('Sertakan cantuman yang diarsipkan'));
    fireEvent.change(screen.getByLabelText('Format ekspor'), { target: { value: 'csv-items' } });
    fireEvent.click(screen.getByRole('button', { name: 'Mulai ekspor' }));
    await waitFor(() =>
      expect(exportBodies(requests)).toEqual([
        {
          format: 'csv-items',
          filter: {
            q: 'pengarang:hirata',
            materialTypeId: MT_THESIS,
            collectionTypeId: CT_REF,
            branchId: BRANCH_NORTH.id,
            changedSince: localDay('2026-01-02'),
            includeArchived: true,
          },
        },
      ]),
    );
  });

  it('a selection that is gone or malformed is never sent; the page says so', async () => {
    sessionStorage.setItem(EXPORT_SELECTION_KEY, JSON.stringify([R1, 'bukan-ulid']));
    const { requests } = start('/admin/catalog/exchange?export=selection');
    expect(await screen.findByText(/Pilihan cantuman dari Bibliografi tidak tersedia lagi/)).toBeTruthy();
    fireEvent.click(screen.getByRole('button', { name: 'Mulai ekspor' }));
    await waitFor(() => expect(exportBodies(requests)).toEqual([{ format: 'marc21', filter: {} }]));
  });

  it('C20: a selection made among archived records keeps "Sertakan cantuman yang diarsipkan", ticked, and sends it', async () => {
    sessionStorage.setItem(EXPORT_SELECTION_KEY, JSON.stringify({ ids: [R1, R2], archived: true }));
    const { requests } = start('/admin/catalog/exchange?export=selection');
    expect(await screen.findByText('2 cantuman terpilih dari Bibliografi')).toBeTruthy();
    const box = screen.getByLabelText('Sertakan cantuman yang diarsipkan') as HTMLInputElement;
    expect(box.checked).toBe(true);
    fireEvent.click(screen.getByRole('button', { name: 'Mulai ekspor' }));
    await waitFor(() => expect(exportBodies(requests)).toEqual([{ format: 'marc21', filter: { recordIds: [R1, R2], includeArchived: true } }]));
  });

  it('C20: a live selection offers the box unticked; ticked, it travels with the ids', async () => {
    sessionStorage.setItem(EXPORT_SELECTION_KEY, JSON.stringify({ ids: [R1], archived: false }));
    const { requests } = start('/admin/catalog/exchange?export=selection');
    expect(await screen.findByText('1 cantuman terpilih dari Bibliografi')).toBeTruthy();
    const box = screen.getByLabelText('Sertakan cantuman yang diarsipkan') as HTMLInputElement;
    expect(box.checked).toBe(false);
    fireEvent.click(box);
    fireEvent.click(screen.getByRole('button', { name: 'Mulai ekspor' }));
    await waitFor(() => expect(exportBodies(requests)).toEqual([{ format: 'marc21', filter: { recordIds: [R1], includeArchived: true } }]));
  });

  it('C20: a selection export that wrote fewer records than were chosen says how many were left out', async () => {
    sessionStorage.setItem(EXPORT_SELECTION_KEY, JSON.stringify({ ids: [R1, R2], archived: false }));
    start('/admin/catalog/exchange?export=selection', {
      [`GET catalog/runs/${EXPORT}`]: () => ({ ...exportRun(), summary: { records: 0, items: 0, skipped: { marc_too_long: 0 }, bytes: 120 } }),
    });
    expect(await screen.findByText('2 cantuman terpilih dari Bibliografi')).toBeTruthy();
    fireEvent.click(screen.getByRole('button', { name: 'Mulai ekspor' }));
    const result = await screen.findByRole('region', { name: 'Hasil ekspor' });
    expect(await within(result).findByText(/2 dari 2 cantuman terpilih tidak diekspor/)).toBeTruthy();
  });

  it('a selection is still read when sessionStorage refuses to clear it', async () => {
    sessionStorage.setItem(EXPORT_SELECTION_KEY, JSON.stringify([R2]));
    vi.spyOn(Storage.prototype, 'removeItem').mockImplementation(() => {
      throw new DOMException('blocked', 'SecurityError');
    });
    const { requests } = start('/admin/catalog/exchange?export=selection');
    expect(await screen.findByText('1 cantuman terpilih dari Bibliografi')).toBeTruthy();
    fireEvent.click(screen.getByRole('button', { name: 'Mulai ekspor' }));
    await waitFor(() => expect(exportBodies(requests)).toEqual([{ format: 'marc21', filter: { recordIds: [R2] } }]));
  });
});
