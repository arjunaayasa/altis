import type { ReportRunCreateBody, ReportRunStarted } from '@altis/shared/api/reports';
import { fireEvent, screen, waitFor, within } from '@testing-library/react';
import { afterEach, describe, expect, it, vi } from 'vitest';
import { page } from '@/lib/page';
import { adminMe, problem, startApp, type FakeHandler, type FakeRequest } from '../fake-api';
import { ACQUISITIONS, DOSSIER, FIRST, TEST_PERSONAL, TEST_ROWS, job, reportRoutes, run } from './support';

// The exports of a report's page: "Ekspor CSV/XLSX/PDF" start a run with the filters of the form (`POST reports/runs`;
// a report holding personal data asks for the password first and goes to `POST reports/runs/personal`), follow its
// job, then show the run: its status, rows, the rows whose non-Latin text the PDF could not print, its warnings,
// its expiry and its file. A report too large for the format says how many rows it has and how many the format
// holds. A report too large to preview says so and keeps its export buttons.

afterEach(() => {
  vi.unstubAllGlobals();
  vi.restoreAllMocks();
});

const RUN_ID = '01JZ0000000000000000RR0001';
const JOB_ID = '01JZ0000000000000000JB0001';
const STARTED: ReportRunStarted = { id: RUN_ID, jobId: JOB_ID };

/** The run start, its job and the run once written. */
function startRoutes(o: { run?: Parameters<typeof run>[0] } = {}): Record<string, FakeHandler> {
  return {
    'POST reports/runs': () => STARTED,
    'POST reports/runs/personal': () => STARTED,
    'GET jobs/:id': (req) => job(req.params['id']!, { createdBy: adminMe().user.id }),
    'GET reports/runs/:id': () => run(o.run ?? { id: RUN_ID, reportId: TEST_ROWS.id, jobId: JOB_ID }),
    'POST auth/reauth': () => ({ reauthUntil: Date.now() + 300_000 }),
  };
}

const starts = (requests: FakeRequest[], path = 'reports/runs') =>
  requests.filter((r) => r.method === 'POST' && r.path === path).map((r) => r.body as ReportRunCreateBody);

/** The export section. */
const exportPanel = (): HTMLElement => screen.getByRole('region', { name: 'Ekspor' });

/** The run list. */
const runList = (): HTMLElement => screen.getByRole('region', { name: 'Ekspor Anda' });

async function open(reportId: string, title: string, routes: Record<string, FakeHandler> = {}, runs: Parameters<typeof reportRoutes>[1] = []) {
  const me = adminMe();
  const app = startApp({ me, path: `/admin/reports/${reportId}`, routes: { ...reportRoutes(me, runs), ...routes } });
  await screen.findByRole('heading', { level: 1, name: title }, FIRST);
  return app;
}

function setRows(n: number): void {
  fireEvent.change(within(screen.getByRole('form', { name: 'Filter' })).getByLabelText('Jumlah baris'), { target: { value: String(n) } });
}

describe('the exports of a report', { timeout: 20_000 }, () => {
  it('a CSV export of a report without personal data posts to reports/runs with the filters, follows the job and offers the file', async () => {
    const { requests, writes } = await open(TEST_ROWS.id, 'Baris uji', startRoutes());
    const panel = exportPanel();
    expect(within(panel).getAllByRole('button').map((b) => b.textContent)).toEqual(['Ekspor CSV', 'Ekspor XLSX', 'Ekspor PDF']);
    // A portrait report offers no paper.
    expect(within(panel).queryByLabelText('Kertas PDF')).toBeNull();
    setRows(30);
    fireEvent.click(within(panel).getByRole('button', { name: 'Ekspor CSV' }));
    await waitFor(() => expect(starts(requests)).toHaveLength(1));
    expect(starts(requests)[0]).toEqual({ reportId: TEST_ROWS.id, format: 'csv', params: { rows: 30 } });
    expect(writes()).toEqual(['POST reports/runs']);
    // The run once its job ended: its file, and the run list read again.
    const link = await within(panel).findByRole('link', { name: /Unduh/ }, FIRST);
    expect(link.getAttribute('href')).toBe(`/api/v1/reports/runs/${RUN_ID}/download`);
    await waitFor(() => expect(requests.filter((r) => r.method === 'GET' && r.path === 'reports/runs').length).toBeGreaterThanOrEqual(2));
  });

  it('a report holding personal data asks for the password first, then posts to reports/runs/personal', async () => {
    const { requests, writes } = await open(TEST_PERSONAL.id, 'Data pribadi uji', startRoutes({ run: { id: RUN_ID, reportId: TEST_PERSONAL.id, personal: true } }));
    const panel = exportPanel();
    expect(within(panel).getByText(/memuat data pribadi/)).toBeTruthy();
    fireEvent.click(within(panel).getByRole('button', { name: 'Ekspor CSV' }));
    const dialog = await screen.findByRole('dialog', { name: 'Konfirmasi kata sandi' });
    // Nothing is sent before the password is confirmed.
    expect(writes()).toEqual([]);
    fireEvent.change(within(dialog).getByLabelText('Kata sandi'), { target: { value: 'kata-sandi-ani' } });
    fireEvent.click(within(dialog).getByRole('button', { name: 'Konfirmasi' }));
    await waitFor(() => expect(starts(requests, 'reports/runs/personal')).toHaveLength(1));
    expect(starts(requests, 'reports/runs/personal')[0]).toEqual({ reportId: TEST_PERSONAL.id, format: 'csv', params: {} });
    expect(writes()).toEqual(['POST auth/reauth', 'POST reports/runs/personal']);
    expect(starts(requests)).toHaveLength(0);
  });

  it('a cancelled password confirmation starts nothing', async () => {
    const { writes } = await open(TEST_PERSONAL.id, 'Data pribadi uji', startRoutes());
    fireEvent.click(within(exportPanel()).getByRole('button', { name: 'Ekspor XLSX' }));
    const dialog = await screen.findByRole('dialog', { name: 'Konfirmasi kata sandi' });
    fireEvent.click(within(dialog).getByRole('button', { name: 'Batal' }));
    await waitFor(() => expect(screen.queryByRole('dialog')).toBeNull());
    expect(writes()).toEqual([]);
  });

  it('a 422 REPORT_TOO_LARGE says how many rows the report has and how many the format holds', async () => {
    const detail = 'Laporan ini 150000 baris; XLSX paling banyak 100000 baris / This report has 150000 rows; a XLSX holds at most 100000';
    await open(TEST_ROWS.id, 'Baris uji', { ...startRoutes(), 'POST reports/runs': () => problem(422, 'REPORT_TOO_LARGE', { detail }) });
    setRows(150_000);
    fireEvent.click(within(exportPanel()).getByRole('button', { name: 'Ekspor XLSX' }));
    expect(
      await within(exportPanel()).findByText('Laporan ini 150.000 baris, sedangkan XLSX paling banyak 100.000 baris. Persempit filternya atau pilih format lain.'),
    ).toBeTruthy();
    // The buttons stay, for another format.
    expect(within(exportPanel()).getByRole('button', { name: 'Ekspor CSV' })).toHaveProperty('disabled', false);
  });

  it('a required filter left empty is marked and no export starts', async () => {
    const { writes } = await open(TEST_ROWS.id, 'Baris uji', startRoutes());
    fireEvent.click(within(exportPanel()).getByRole('button', { name: 'Ekspor PDF' }));
    await waitFor(() => expect(within(screen.getByRole('form', { name: 'Filter' })).getByLabelText('Jumlah baris').getAttribute('aria-invalid')).toBe('true'));
    expect(writes()).toEqual([]);
  });

  it('a landscape report offers the PDF paper and sends it with a PDF export only', async () => {
    const { requests } = await open(ACQUISITIONS.id, 'Perolehan koleksi per tahun', startRoutes({ run: { id: RUN_ID, reportId: ACQUISITIONS.id } }));
    const panel = exportPanel();
    const paper = within(panel).getByLabelText('Kertas PDF') as HTMLSelectElement;
    expect([...paper.options].map((o) => [o.value, o.text])).toEqual([
      ['A4', 'A4 (21 × 29,7 cm)'],
      ['F4', 'F4 (21,5 × 33 cm)'],
    ]);
    fireEvent.change(paper, { target: { value: 'F4' } });
    fireEvent.click(within(panel).getByRole('button', { name: 'Ekspor PDF' }));
    await waitFor(() => expect(starts(requests)).toHaveLength(1));
    expect(starts(requests)[0]).toEqual({ reportId: ACQUISITIONS.id, format: 'pdf', params: {}, pdf: { paper: 'F4' } });
  });

  it('a finished run shows its rows of non-Latin text, its warnings, its expiry and its file', async () => {
    const pdf = run({ id: RUN_ID, reportId: TEST_ROWS.id, format: 'pdf', paper: 'A4', rowCount: 3, nonLatinRows: 2, params: { rows: 3 } });
    const warned = run({ id: '01JZ0000000000000000RR0002', reportId: TEST_ROWS.id, format: 'xlsx', warnings: ['test_warning'] });
    const failed = run({ id: '01JZ0000000000000000RR0003', reportId: TEST_ROWS.id, status: 'failed', errorCode: 'REPORT_TOO_LARGE', downloadable: false, expiresAt: null });
    await open(TEST_ROWS.id, 'Baris uji', {}, [pdf, warned, failed]);
    const list = runList();
    const rows = await within(list).findAllByRole('row');
    const pdfRow = rows.find((r) => within(r).queryByText(/teks non-Latin/) !== null)!;
    expect(within(pdfRow).getByText('2 baris teks non-Latin: lihat XLSX/CSV')).toBeTruthy();
    expect(within(pdfRow).getByText(/kertas A4/)).toBeTruthy();
    expect(within(pdfRow).getByText('Filter: Jumlah baris: 3')).toBeTruthy();
    expect(within(pdfRow).getByText(/Dapat diunduh sampai/)).toBeTruthy();
    expect(within(pdfRow).getByRole('link', { name: /Unduh/ }).getAttribute('href')).toBe(`/api/v1/reports/runs/${RUN_ID}/download`);
    expect(within(list).getByText('Peringatan: test_warning')).toBeTruthy();
    expect(within(list).getByText(/Gagal: Laporan terlalu besar untuk format ini/)).toBeTruthy();
    // A run without non-Latin rows says nothing of them.
    expect(within(list).getAllByText(/teks non-Latin/)).toHaveLength(1);
  });

  it('downloading a personal run asks for the password first', async () => {
    const assign = vi.spyOn(page, 'assign').mockImplementation(() => undefined);
    const personal = run({ id: RUN_ID, reportId: TEST_PERSONAL.id, personal: true });
    await open(TEST_PERSONAL.id, 'Data pribadi uji', startRoutes(), [personal]);
    const button = await within(runList()).findByRole('button', { name: /Unduh/ });
    fireEvent.click(button);
    const dialog = await screen.findByRole('dialog', { name: 'Konfirmasi kata sandi' });
    expect(assign).not.toHaveBeenCalled();
    fireEvent.change(within(dialog).getByLabelText('Kata sandi'), { target: { value: 'kata-sandi-ani' } });
    fireEvent.click(within(dialog).getByRole('button', { name: 'Konfirmasi' }));
    await waitFor(() => expect(assign).toHaveBeenCalledWith(`/api/v1/reports/runs/${RUN_ID}/download`));
  });

  it('downloading a personal run asks for the password even when the session says a confirmation still counts', async () => {
    // The time the server gives is read against the page's clock, which may be far behind the server's: a download
    // never trusts it (a refused download would leave the user on the server's answer instead of the page).
    const assign = vi.spyOn(page, 'assign').mockImplementation(() => undefined);
    const me = { ...adminMe(), reauthUntil: Date.now() + 3_600_000 };
    const personal = run({ id: RUN_ID, reportId: TEST_PERSONAL.id, personal: true });
    startApp({ me, path: `/admin/reports/${TEST_PERSONAL.id}`, routes: { ...reportRoutes(me, [personal]), ...startRoutes() } });
    await screen.findByRole('heading', { level: 1, name: 'Data pribadi uji' }, FIRST);
    fireEvent.click(await within(runList()).findByRole('button', { name: /Unduh/ }));
    const dialog = await screen.findByRole('dialog', { name: 'Konfirmasi kata sandi' });
    expect(assign).not.toHaveBeenCalled();
    // Cancelled: no file.
    fireEvent.click(within(dialog).getByRole('button', { name: 'Batal' }));
    await waitFor(() => expect(screen.queryByRole('dialog')).toBeNull());
    expect(assign).not.toHaveBeenCalled();
  });

  it("a personal export's file downloads right after the export's own password confirmation without asking again", async () => {
    const assign = vi.spyOn(page, 'assign').mockImplementation(() => undefined);
    const { writes } = await open(TEST_PERSONAL.id, 'Data pribadi uji', startRoutes({ run: { id: RUN_ID, reportId: TEST_PERSONAL.id, personal: true } }));
    fireEvent.click(within(exportPanel()).getByRole('button', { name: 'Ekspor CSV' }));
    const dialog = await screen.findByRole('dialog', { name: 'Konfirmasi kata sandi' });
    fireEvent.change(within(dialog).getByLabelText('Kata sandi'), { target: { value: 'kata-sandi-ani' } });
    fireEvent.click(within(dialog).getByRole('button', { name: 'Konfirmasi' }));
    await waitFor(() => expect(screen.queryByRole('dialog')).toBeNull());
    // The run once its job ended, in the export section: its file, behind a button (a personal run).
    const download = await within(exportPanel()).findByRole('button', { name: /Unduh/ }, FIRST);
    fireEvent.click(download);
    await waitFor(() => expect(assign).toHaveBeenCalledWith(`/api/v1/reports/runs/${RUN_ID}/download`));
    expect(screen.queryByRole('dialog')).toBeNull();
    expect(writes()).toEqual(['POST auth/reauth', 'POST reports/runs/personal']);
  });

  it('a failed run says why in words', async () => {
    const failed = (id: string, errorCode: string | null) =>
      run({ id, reportId: TEST_ROWS.id, status: 'failed', errorCode, downloadable: false, expiresAt: null, rowCount: null });
    await open(TEST_ROWS.id, 'Baris uji', {}, [
      failed('01JZ0000000000000000RR0011', 'abandoned'),
      failed('01JZ0000000000000000RR0012', 'disk_full'),
      failed('01JZ0000000000000000RR0013', 'internal'),
      failed('01JZ0000000000000000RR0014', 'some_new_code'),
    ]);
    const list = runList();
    expect(await within(list).findByText('Gagal: Tugas ekspornya terhenti sebelum selesai. Ekspor laporannya lagi.')).toBeTruthy();
    expect(within(list).getByText(/^Gagal: Ruang penyimpanan atau kuota disk habis/)).toBeTruthy();
    expect(within(list).getByText(/^Gagal: Terjadi kesalahan pada server/)).toBeTruthy();
    expect(within(list).getByText('Gagal: kode some_new_code')).toBeTruthy();
    // A failed run has no file.
    expect(within(list).queryByRole('link', { name: /Unduh/ })).toBeNull();
  });

  it('a document is made in the accreditation workspace: its page links there and lists its runs, warnings as sentences', async () => {
    const dossier = run({
      id: RUN_ID,
      reportId: DOSSIER.id,
      format: 'zip',
      personal: true,
      warnings: ['component_over_limit:K:12582912', 'generated_too_large:title_list'],
    });
    const { writes } = await open(DOSSIER.id, 'Berkas bukti akreditasi', {}, [dossier]);
    expect(screen.getByRole('link', { name: 'Buka ruang Akreditasi' }).getAttribute('href')).toBe('/admin/accreditation');
    // No filters, preview or export buttons of its own: the workspace makes it.
    expect(screen.queryByRole('form', { name: 'Filter' })).toBeNull();
    expect(screen.queryByRole('region', { name: 'Ekspor' })).toBeNull();
    const list = runList();
    expect(await within(list).findByText('Komponen K berukuran 12 MB, melebihi batas ukuran per komponen.')).toBeTruthy();
    expect(within(list).getByText('Daftar title_list terlalu panjang untuk dimuat di ZIP; ekspor daftar itu tersendiri.')).toBeTruthy();
    expect(writes()).toEqual([]);
  });

  it('a preview answered 422 export_only says to export instead, and the export buttons stay enabled', async () => {
    await open(TEST_ROWS.id, 'Baris uji', {
      ...startRoutes(),
      [`POST reports/${TEST_ROWS.id}/preview`]: () => problem(422, 'VALIDATION_FAILED', { errors: [{ path: 'params', code: 'export_only' }] }),
    });
    setRows(10);
    fireEvent.click(screen.getByRole('button', { name: 'Terapkan' }));
    expect(await screen.findByText('Laporan ini terlalu besar untuk pratinjau; ekspor saja.')).toBeTruthy();
    for (const name of ['Ekspor CSV', 'Ekspor XLSX', 'Ekspor PDF']) expect(within(exportPanel()).getByRole('button', { name }), name).toHaveProperty('disabled', false);
    // No field is marked: the filters are fine, the preview is not the way.
    expect(within(screen.getByRole('form', { name: 'Filter' })).getByLabelText('Jumlah baris').getAttribute('aria-invalid')).toBeNull();
  });
});
