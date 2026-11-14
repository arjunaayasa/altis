import type { ReportPreviewResponse } from '@altis/shared/api/reports';
import { fireEvent, screen, waitFor, within } from '@testing-library/react';
import { afterEach, describe, expect, it, vi } from 'vitest';
import { BRANCH_MAIN, adminMe, problem, startApp, type FakeRequest } from '../fake-api';
import { COLLECTION_TYPE_ID, EVERY_KIND, FIRST, LANGUAGE_ID, LOCATION_ID, MATERIAL_TYPE_ID, PERIOD_ID, SHELF_ID, reportRoutes } from './support';

// The filters of a report's page, built from the definition's parameters: one control per parameter, of its kind
// (two date inputs for a date range, a date, a number, a select of the period, branch, location, collection type,
// material type or language, a text, a select or a group of checkboxes for a status with the labels of its
// vocabulary, a checkbox, a whole number). "Terapkan" sends only what was filled in, as the definition's schema
// takes it, and a required parameter left empty is marked before anything is sent.

afterEach(() => {
  vi.unstubAllGlobals();
  vi.restoreAllMocks();
});

const EMPTY_PAGE: ReportPreviewResponse = { columns: [], rows: [], nextCursor: null, totals: null };

const previews = (requests: FakeRequest[], id: string) => requests.filter((r) => r.method === 'POST' && r.path === `reports/${id}/preview`);

/** The filter form. */
const filters = (): HTMLElement => screen.getByRole('form', { name: 'Filter' });

describe('the filters of a report', { timeout: 20_000 }, () => {
  it('render one control per parameter, each of its kind, and "Terapkan" sends only what was filled in', async () => {
    const me = adminMe();
    const { requests } = startApp({
      me,
      path: `/admin/reports/${EVERY_KIND.id}`,
      routes: { ...reportRoutes(me), [`POST reports/${EVERY_KIND.id}/preview`]: () => EMPTY_PAGE },
    });
    await screen.findByRole('heading', { level: 1, name: 'Daftar eksemplar' }, FIRST);
    const form = filters();
    // One control per parameter, in the definition's order.
    expect([...form.querySelectorAll('[data-param]')].map((e) => e.getAttribute('data-param'))).toEqual(EVERY_KIND.params.map((p) => p.name));

    const received = within(form).getByRole('group', { name: 'Tanggal terima' });
    expect(within(received).getByLabelText('Dari tanggal')).toHaveProperty('type', 'date');
    expect(within(received).getByLabelText('Sampai tanggal')).toHaveProperty('type', 'date');
    expect(within(form).getByLabelText('Per tanggal')).toHaveProperty('type', 'date');
    const year = within(form).getByLabelText('Dari tahun');
    expect(year).toHaveProperty('type', 'number');
    expect([year.getAttribute('min'), year.getAttribute('max')]).toEqual(['1900', '2100']);
    const selects: [label: string, option: string, value: string][] = [
      ['Periode akreditasi', 'Tahun ajaran 2025/2026 (2025-07-01 s.d. 2026-06-30)', PERIOD_ID],
      ['Cabang', 'Perpustakaan Pusat (PUSAT)', BRANCH_MAIN.id],
      ['Lokasi', 'Ruang baca (R1)', LOCATION_ID],
      ['Tipe koleksi', 'Referensi (REF)', COLLECTION_TYPE_ID],
      ['Jenis bahan', 'Buku (BUKU)', MATERIAL_TYPE_ID],
      ['Bahasa', 'Indonesia (ind)', LANGUAGE_ID],
      ['Sumber pengadaan', 'Pembelian', 'purchase'],
    ];
    for (const [label, option, value] of selects) {
      const select = within(form).getByLabelText(label);
      expect(select.tagName, label).toBe('SELECT');
      expect((await within(select).findByRole('option', { name: option })).getAttribute('value'), label).toBe(value);
      // Nothing chosen yet: the empty choice is selected and sends nothing.
      expect((select as HTMLSelectElement).value, label).toBe('');
    }
    // A shelf is listed under its room.
    expect(within(within(form).getByLabelText('Lokasi')).getByRole('option', { name: /Rak A \(RAK-A\)/ }).getAttribute('value')).toBe(SHELF_ID);
    expect(within(form).getByLabelText('Awalan kelas')).toHaveProperty('type', 'text');
    expect(within(form).getByLabelText('Teks baris')).toHaveProperty('type', 'text');
    const status = within(form).getByRole('group', { name: 'Status eksemplar' });
    expect(within(status).getAllByRole('checkbox')).toHaveLength(8);
    expect(within(status).getByRole('checkbox', { name: 'Tersedia' })).toBeTruthy();
    expect(within(status).getByRole('checkbox', { name: 'Dinyatakan hilang' })).toBeTruthy();
    expect(within(form).getByRole('checkbox', { name: 'Hanya fiksi' })).toBeTruthy();
    const rows = within(form).getByLabelText('Jumlah baris');
    expect(rows).toHaveProperty('type', 'number');
    expect([rows.getAttribute('min'), rows.getAttribute('max')]).toEqual(['0', '200000']);

    fireEvent.change(within(received).getByLabelText('Dari tanggal'), { target: { value: '2025-01-01' } });
    fireEvent.change(within(received).getByLabelText('Sampai tanggal'), { target: { value: '2025-12-31' } });
    fireEvent.click(within(status).getByRole('checkbox', { name: 'Dinyatakan hilang' }));
    fireEvent.click(within(status).getByRole('checkbox', { name: 'Tersedia' }));
    fireEvent.click(within(form).getByRole('checkbox', { name: 'Hanya fiksi' }));
    fireEvent.click(within(form).getByRole('button', { name: 'Terapkan' }));

    await waitFor(() => expect(previews(requests, EVERY_KIND.id)).toHaveLength(1));
    const body = previews(requests, EVERY_KIND.id)[0]!.body as { params: unknown; limit?: number; cursor?: unknown };
    expect(body).toMatchObject({ params: { received: { from: '2025-01-01', to: '2025-12-31' }, status: ['available', 'lost'], fictionOnly: true } });
    // Exactly these: nothing left empty is sent, and the statuses come in the definition's order.
    expect(body.params).toEqual({ received: { from: '2025-01-01', to: '2025-12-31' }, status: ['available', 'lost'], fictionOnly: true });
    expect(body.limit).toBe(200);
    expect(body.cursor).toBeUndefined();
  });

  it('sends a chosen select, a year and a whole number as the schema takes them', async () => {
    const me = adminMe();
    const { requests } = startApp({
      me,
      path: `/admin/reports/${EVERY_KIND.id}`,
      routes: { ...reportRoutes(me), [`POST reports/${EVERY_KIND.id}/preview`]: () => EMPTY_PAGE },
    });
    await screen.findByRole('heading', { level: 1, name: 'Daftar eksemplar' }, FIRST);
    const form = filters();
    await within(within(form).getByLabelText('Cabang')).findByRole('option', { name: 'Perpustakaan Pusat (PUSAT)' });
    fireEvent.change(within(form).getByLabelText('Cabang'), { target: { value: BRANCH_MAIN.id } });
    fireEvent.change(within(form).getByLabelText('Dari tahun'), { target: { value: '2024' } });
    fireEvent.change(within(form).getByLabelText('Jumlah baris'), { target: { value: '12' } });
    fireEvent.change(within(form).getByLabelText('Awalan kelas'), { target: { value: ' 2X ' } });
    fireEvent.change(within(form).getByLabelText('Sumber pengadaan'), { target: { value: 'gift' } });
    fireEvent.click(within(form).getByRole('button', { name: 'Terapkan' }));
    await waitFor(() => expect(previews(requests, EVERY_KIND.id)).toHaveLength(1));
    expect((previews(requests, EVERY_KIND.id)[0]!.body as { params: unknown }).params).toEqual({
      branchId: BRANCH_MAIN.id,
      yearFrom: 2024,
      rows: 12,
      classPrefix: '2X',
      acqSource: 'gift',
    });
  });

  it('marks a required parameter left empty and sends nothing; a parameter the server refuses is marked on its field', async () => {
    const me = adminMe();
    let answer: () => Response | ReportPreviewResponse = () => EMPTY_PAGE;
    const { requests } = startApp({
      me,
      path: '/admin/reports/accreditation.annex.staff',
      routes: { ...reportRoutes(me), 'POST reports/accreditation.annex.staff/preview': () => answer() },
    });
    await screen.findByRole('heading', { level: 1, name: 'Lampiran: tenaga perpustakaan' }, FIRST);
    const form = filters();
    fireEvent.click(within(form).getByRole('button', { name: 'Terapkan' }));
    const period = within(form).getByLabelText('Periode akreditasi');
    await waitFor(() => expect(period.getAttribute('aria-invalid')).toBe('true'));
    expect(within(form).getByText('Wajib diisi.')).toBeTruthy();
    expect(previews(requests, 'accreditation.annex.staff')).toHaveLength(0);

    answer = () => problem(422, 'VALIDATION_FAILED', { errors: [{ path: 'params.section', code: 'invalid_value' }] });
    await within(period).findByRole('option', { name: /Tahun ajaran 2025\/2026/ });
    fireEvent.change(period, { target: { value: PERIOD_ID } });
    fireEvent.change(within(form).getByLabelText('Bagian'), { target: { value: 'ratio' } });
    fireEvent.click(within(form).getByRole('button', { name: 'Terapkan' }));
    await waitFor(() => expect(within(form).getByLabelText('Bagian').getAttribute('aria-invalid')).toBe('true'));
    expect(within(form).getByText('Pilihan ini tidak tersedia.')).toBeTruthy();
    expect(period.getAttribute('aria-invalid')).toBeNull();
    expect((previews(requests, 'accreditation.annex.staff')[0]!.body as { params: unknown }).params).toEqual({ periodId: PERIOD_ID, section: 'ratio' });
  });

  it('takes its first values from the page address, so a link can open a report on a period', async () => {
    const me = adminMe();
    startApp({ me, path: `/admin/reports/accreditation.annex.staff?periodId=${PERIOD_ID}&section=trainings`, routes: reportRoutes(me) });
    await screen.findByRole('heading', { level: 1, name: 'Lampiran: tenaga perpustakaan' }, FIRST);
    const period = within(filters()).getByLabelText('Periode akreditasi') as HTMLSelectElement;
    await within(period).findByRole('option', { name: /Tahun ajaran 2025\/2026/ });
    expect(period.value).toBe(PERIOD_ID);
    expect((within(filters()).getByLabelText('Bagian') as HTMLSelectElement).value).toBe('trainings');
  });
});
