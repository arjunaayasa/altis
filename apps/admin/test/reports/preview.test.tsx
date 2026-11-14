import type { ReportCell, ReportPreviewBody, ReportPreviewResponse } from '@altis/shared/api/reports';
import { fireEvent, screen, waitFor, within } from '@testing-library/react';
import { afterEach, describe, expect, it, vi } from 'vitest';
import { adminMe, problem, startApp, type FakeRequest } from '../fake-api';
import { ANNEX_ACTIVITIES, FIRST, PERIOD_ID, SUMMARY, TEST_ROWS, reportRoutes } from './support';

// The paged preview of a report's page: "Terapkan" asks for the first page of 200 rows; "Muat lagi" sends the page's
// cursor and appends the next page under it, until the server says there is no more. "Cetak" prints the rows on
// screen through the print stylesheet: a copy of the preview table with the report's title, its filters in words and
// who printed it when.

afterEach(() => {
  vi.unstubAllGlobals();
  vi.restoreAllMocks();
  document.documentElement.removeAttribute('data-print');
});

/** Row n of `test.rows` as the server writes it. */
const rowOf = (n: number): ReportCell[] => [n, `baris ${n}`, n * 1500];

/** `test.rows` with 250 rows: the first page holds 200, then the cursor `200` gives the last 50. */
function pages(req: FakeRequest): ReportPreviewResponse {
  const body = req.body as ReportPreviewBody;
  const after = body.cursor === undefined || body.cursor === null ? 0 : Number(body.cursor);
  const last = Math.min(250, after + (body.limit ?? 50));
  const rows: ReportCell[][] = [];
  for (let n = after + 1; n <= last; n += 1) rows.push(rowOf(n));
  return { columns: TEST_ROWS.columns!, rows, nextCursor: last < 250 ? String(last) : null, totals: null };
}

const previews = (requests: FakeRequest[]) => requests.filter((r) => r.method === 'POST' && r.path === `reports/${TEST_ROWS.id}/preview`);

/** The body rows of the on-screen preview table. */
const bodyRows = (table: HTMLElement): HTMLElement[] => within(table).getAllByRole('row').filter((r) => r.closest('tbody') !== null);

async function openTestRows() {
  const me = adminMe();
  const app = startApp({ me, path: `/admin/reports/${TEST_ROWS.id}`, routes: { ...reportRoutes(me), [`POST reports/${TEST_ROWS.id}/preview`]: pages } });
  await screen.findByRole('heading', { level: 1, name: 'Baris uji' }, FIRST);
  const form = screen.getByRole('form', { name: 'Filter' });
  fireEvent.change(within(form).getByLabelText('Jumlah baris'), { target: { value: '250' } });
  fireEvent.click(within(form).getByRole('button', { name: 'Terapkan' }));
  const table = await screen.findByRole('table', { name: 'Pratinjau laporan Baris uji' }, FIRST);
  await waitFor(() => expect(bodyRows(table)).toHaveLength(200));
  return { ...app, table };
}

describe('the preview of a report', { timeout: 20_000 }, () => {
  it('shows the first 200 rows; "Muat lagi" sends the cursor and appends the next page', async () => {
    const { requests, table } = await openTestRows();
    expect(previews(requests)).toHaveLength(1);
    expect(previews(requests)[0]!.body).toEqual({ params: { rows: 250 }, limit: 200 });
    // Columns from the answer, labelled with the shared report texts; numbers formatted, money in major units.
    expect(within(table).getAllByRole('columnheader').map((h) => h.textContent)).toEqual(['Nomor', 'Teks', 'Nominal']);
    expect(within(bodyRows(table)[0]!).getAllByRole('cell').map((c) => c.textContent)).toEqual(['1', 'baris 1', '1.500']);
    expect(screen.getByText('200 baris ditampilkan')).toBeTruthy();

    fireEvent.click(screen.getByRole('button', { name: 'Muat lagi' }));
    await waitFor(() => expect(bodyRows(table)).toHaveLength(250));
    expect(previews(requests)).toHaveLength(2);
    expect(previews(requests)[1]!.body).toEqual({ params: { rows: 250 }, cursor: '200', limit: 200 });
    // Appended under the first page, in order.
    expect(within(bodyRows(table)[200]!).getAllByRole('cell')[0]!.textContent).toBe('201');
    expect(within(bodyRows(table)[249]!).getAllByRole('cell')[0]!.textContent).toBe('250');
    expect(screen.queryByRole('button', { name: 'Muat lagi' })).toBeNull();
    expect(screen.getByText('Semua baris sudah ditampilkan.')).toBeTruthy();
  });

  it('a later page refused as export-only keeps the rows shown and says to export the rest', async () => {
    const me = adminMe();
    const routes = {
      ...reportRoutes(me),
      [`POST reports/${TEST_ROWS.id}/preview`]: (req: FakeRequest) =>
        (req.body as ReportPreviewBody).cursor === undefined ? pages(req) : problem(422, 'VALIDATION_FAILED', { errors: [{ path: 'params', code: 'export_only' }] }),
    };
    startApp({ me, path: `/admin/reports/${TEST_ROWS.id}`, routes });
    await screen.findByRole('heading', { level: 1, name: 'Baris uji' }, FIRST);
    const form = screen.getByRole('form', { name: 'Filter' });
    fireEvent.change(within(form).getByLabelText('Jumlah baris'), { target: { value: '250' } });
    fireEvent.click(within(form).getByRole('button', { name: 'Terapkan' }));
    const table = await screen.findByRole('table', { name: 'Pratinjau laporan Baris uji' }, FIRST);
    await waitFor(() => expect(bodyRows(table)).toHaveLength(200));
    fireEvent.click(screen.getByRole('button', { name: 'Muat lagi' }));
    expect(await screen.findByText('Laporan ini terlalu besar untuk pratinjau; ekspor saja.')).toBeTruthy();
    expect(bodyRows(table)).toHaveLength(200);
    expect(screen.queryByText('Data yang dikirim tidak valid', { exact: false })).toBeNull();
  });

  it('"Terapkan" again starts afresh from the first page with the new filters', async () => {
    const { requests, table } = await openTestRows();
    fireEvent.click(screen.getByRole('button', { name: 'Muat lagi' }));
    await waitFor(() => expect(bodyRows(table)).toHaveLength(250));
    const form = screen.getByRole('form', { name: 'Filter' });
    fireEvent.change(within(form).getByLabelText('Jumlah baris'), { target: { value: '120' } });
    fireEvent.click(within(form).getByRole('button', { name: 'Terapkan' }));
    await waitFor(() => expect(previews(requests)).toHaveLength(3));
    expect(previews(requests)[2]!.body).toEqual({ params: { rows: 120 }, limit: 200 });
  });

  it('"Cetak" prints the rows on screen, with the title, the filters in words and who printed it', async () => {
    const { table } = await openTestRows();
    let copy: HTMLElement | null = null;
    const print = vi.spyOn(window, 'print').mockImplementation(() => {
      copy = document.querySelector<HTMLElement>('[data-report-print]');
      expect(document.documentElement.getAttribute('data-print')).toBe('report');
    });
    fireEvent.click(screen.getByRole('button', { name: 'Cetak' }));
    await waitFor(() => expect(print).toHaveBeenCalledTimes(1));
    expect(copy).not.toBeNull();
    const printed = copy!;
    expect(printed.textContent).toContain('Baris uji');
    expect(printed.textContent).toContain('Filter: Jumlah baris: 250');
    expect(printed.textContent).toContain('oleh Ani');
    // The rows shown so far, and a word that the rest is in the PDF export.
    expect(printed.querySelectorAll('tbody tr')).toHaveLength(200);
    expect(printed.textContent).toContain('Hanya 200 baris pertama yang dicetak');
    // The on-screen table is untouched.
    expect(bodyRows(table)).toHaveLength(200);
  });

  it('shows the totals row under the rows', async () => {
    const me = adminMe();
    const answer: ReportPreviewResponse = {
      columns: SUMMARY.columns!,
      rows: [
        ['Judul', 'Semua judul', 12, 30],
        ['Eksemplar menurut status', 'Tersedia', 10, 25],
      ],
      nextCursor: null,
      totals: ['Jumlah', '', 22, 55],
    };
    startApp({ me, path: `/admin/reports/${SUMMARY.id}`, routes: { ...reportRoutes(me), [`POST reports/${SUMMARY.id}/preview`]: () => answer } });
    await screen.findByRole('heading', { level: 1, name: 'Ringkasan koleksi' }, FIRST);
    fireEvent.click(screen.getByRole('button', { name: 'Terapkan' }));
    const table = await screen.findByRole('table', { name: 'Pratinjau laporan Ringkasan koleksi' }, FIRST);
    const foot = table.querySelector('tfoot')!;
    expect(within(foot).getAllByRole('cell').map((c) => c.textContent)).toEqual(['Jumlah', '', '22', '55']);
    expect(bodyRows(table)).toHaveLength(2);
  });
});

describe('the language of a preview and of its printed copy', { timeout: 20_000 }, () => {
  /** An admin who reads the screens in English. */
  const english = () => {
    const me = adminMe();
    return { ...me, user: { ...me.user, locale: 'en' as const } };
  };

  /** Prints the preview and gives the printed copy as it was when the browser printed it. */
  async function printCopy(button: string): Promise<HTMLElement> {
    let copy: HTMLElement | null = null;
    const print = vi.spyOn(window, 'print').mockImplementation(() => {
      copy = document.querySelector<HTMLElement>('[data-report-print]')!.cloneNode(true) as HTMLElement;
    });
    fireEvent.click(screen.getByRole('button', { name: button }));
    await waitFor(() => expect(print).toHaveBeenCalledTimes(1));
    expect(copy).not.toBeNull();
    return copy!;
  }

  const heads = (table: HTMLElement): (string | null)[] => [...table.querySelectorAll('thead th')].map((h) => h.textContent);
  const firstRow = (table: HTMLElement): (string | null)[] => [...table.querySelectorAll('tbody tr:first-child td')].map((c) => c.textContent);

  it('an accreditation annex is shown and printed in Indonesian for a user reading English, as its export is written', async () => {
    const me = english();
    // The server writes the annex's cells in Indonesian whatever the reader reads; one more page waits.
    const answer: ReportPreviewResponse = {
      columns: ANNEX_ACTIVITIES.columns!,
      rows: [['Promosi perpustakaan', 'Pameran buku', '2026-08-14', 1500, null]],
      nextCursor: '1',
      totals: null,
    };
    const { requests } = startApp({
      me,
      path: `/admin/reports/${ANNEX_ACTIVITIES.id}`,
      routes: { ...reportRoutes(me), [`POST reports/${ANNEX_ACTIVITIES.id}/preview`]: () => answer },
    });
    // The screen itself is in the reader's language.
    await screen.findByRole('heading', { level: 1, name: 'Annex: library activities' }, FIRST);
    const form = screen.getByRole('form', { name: 'Filters' });
    const period = within(form).getByLabelText('Accreditation period');
    await within(period).findByRole('option', { name: 'Tahun ajaran 2025/2026 (2025-07-01 to 2026-06-30)' });
    fireEvent.change(period, { target: { value: PERIOD_ID } });
    fireEvent.click(within(form).getByRole('checkbox', { name: 'Library promotion' }));
    fireEvent.click(within(form).getByRole('button', { name: 'Apply' }));

    // The table on screen is the annex as it is handed in: Indonesian heads, dates and numbers.
    const table = await screen.findByRole('table', { name: 'Pratinjau laporan Lampiran: kegiatan perpustakaan' }, FIRST);
    expect(table.getAttribute('lang')).toBe('id');
    expect(heads(table)).toEqual(['Jenis', 'Judul', 'Tanggal pelaksanaan', 'Jumlah peserta', 'Mitra']);
    expect(firstRow(table)).toEqual(['Promosi perpustakaan', 'Pameran buku', '14 Agu 2026', '1.500', '']);
    expect((requests.find((r) => r.path === `reports/${ANNEX_ACTIVITIES.id}/preview`)!.body as ReportPreviewBody).params).toEqual({
      periodId: PERIOD_ID,
      kinds: ['promotion'],
    });
    // What is around it stays in the reader's language.
    expect(screen.getByRole('heading', { level: 2, name: 'Preview' })).toBeTruthy();
    expect(screen.getByText('1 rows shown')).toBeTruthy();
    expect(screen.getByRole('button', { name: 'Load more' })).toBeTruthy();

    // The printed copy is wholly Indonesian: title, filters in words, who printed it when, the partial line, the table.
    const printed = await printCopy('Print');
    expect(printed.getAttribute('lang')).toBe('id');
    const lines = [...printed.querySelectorAll('header > *')].map((e) => e.textContent);
    expect(lines[0]).toBe('Perpustakaan Arsya');
    expect(lines[1]).toBe('Lampiran: kegiatan perpustakaan');
    expect(lines[2]).toBe('Filter: Periode akreditasi: Tahun ajaran 2025/2026 (2025-07-01 s.d. 2026-06-30); Jenis: Promosi perpustakaan');
    expect(lines[3]).toMatch(/^Dicetak \d{1,2} \S+ \d{4}, \d{2}\.\d{2} oleh Ani$/);
    expect(lines[4]).toBe('Hanya 1 baris pertama yang dicetak; seluruh laporan ada di ekspor PDF.');
    expect(lines).toHaveLength(5);
    const copyTable = printed.querySelector('table')!;
    expect(copyTable.querySelector('caption')!.textContent).toBe('Lampiran: kegiatan perpustakaan');
    expect(heads(copyTable)).toEqual(['Jenis', 'Judul', 'Tanggal pelaksanaan', 'Jumlah peserta', 'Mitra']);
    expect(firstRow(copyTable)).toEqual(['Promosi perpustakaan', 'Pameran buku', '14 Agu 2026', '1.500', '']);
  });

  it('any other report is shown and printed in the reader\'s own language', async () => {
    const me = english();
    const answer: ReportPreviewResponse = { columns: TEST_ROWS.columns!, rows: [[1, 'line 1', 1500]], nextCursor: null, totals: null };
    startApp({ me, path: `/admin/reports/${TEST_ROWS.id}`, routes: { ...reportRoutes(me), [`POST reports/${TEST_ROWS.id}/preview`]: () => answer } });
    await screen.findByRole('heading', { level: 1, name: 'Test rows' }, FIRST);
    const form = screen.getByRole('form', { name: 'Filters' });
    fireEvent.change(within(form).getByLabelText('Rows'), { target: { value: '1' } });
    fireEvent.click(within(form).getByRole('button', { name: 'Apply' }));
    const table = await screen.findByRole('table', { name: 'Preview of the report Test rows' }, FIRST);
    expect(table.getAttribute('lang')).toBe('en');
    expect(heads(table)).toEqual(['Number', 'Text', 'Amount']);
    expect(firstRow(table)).toEqual(['1', 'line 1', '1,500']);

    const printed = await printCopy('Print');
    expect(printed.getAttribute('lang')).toBe('en');
    const lines = [...printed.querySelectorAll('header > *')].map((e) => e.textContent);
    expect(lines.slice(1, 3)).toEqual(['Test rows', 'Filters: Rows: 1']);
    expect(lines[3]).toMatch(/^Printed \d{1,2} \S+ \d{4}, \d{2}:\d{2} by Ani$/);
    expect(heads(printed.querySelector('table')!)).toEqual(['Number', 'Text', 'Amount']);
  });
});
