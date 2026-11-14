import { MESSAGES } from '@altis/shared';
import type { ReportRunListResponse, ReportRunView } from '@altis/shared/api/reports';
import { fireEvent, screen, waitFor, within } from '@testing-library/react';
import { afterEach, describe, expect, it, vi } from 'vitest';
import { PrintTab } from '@/screens/accreditation/tabs/print';
import { page } from '@/lib/page';
import type { FakeHandler } from '../fake-api';
import {
  ADMIN_ID,
  FIRST,
  JOB_ID,
  PERIOD_ID,
  RUN_ID,
  confirmPassword,
  evidenceAnswer,
  instrument,
  instrumentsAnswer,
  job,
  periodView,
  renderTab,
  reportRun,
} from './usage-print-fixtures';

// Cetak (spec §6, §10.9): the internal simulation (with its header, behind the password), the evidence file as a PDF,
// one ZIP or one ZIP per component (behind the password) with the running size of each component against the upload
// limit, the statement of 1 000 titles, the request letter template, and the annexes as CSV/XLSX (the staff annex
// through the personal route). Every run shows its progress, its warnings as sentences and its download.

afterEach(() => {
  vi.unstubAllGlobals();
  vi.restoreAllMocks();
});

const ID = MESSAGES.id;
const DOSSIER = `POST accreditation/periods/${PERIOD_ID}/dossier`;
const MB = 1024 * 1024;

function routes(o: { runs?: ReportRunView[]; bytes?: Parameters<typeof evidenceAnswer>[0]; scored?: boolean; extra?: Record<string, FakeHandler> } = {}): Record<string, FakeHandler> {
  const started = { id: RUN_ID, jobId: JOB_ID };
  return {
    'GET accreditation/periods/:id': () => periodView(),
    'GET accreditation/instruments': () => instrumentsAnswer({ instruments: [instrument({ scored: o.scored ?? true })] }),
    'GET accreditation/evidence': () => evidenceAnswer(o.bytes),
    'GET reports/runs': (): ReportRunListResponse => ({ runs: o.runs ?? [], nextCursor: null }),
    'GET reports/runs/:id': () => reportRun({ status: 'running', jobId: JOB_ID }),
    'GET jobs/:id': () => job({ status: 'running', progress: 40, finishedAt: null, interactive: false }),
    'POST accreditation/periods/:id/dossier': () => started,
    'POST accreditation/periods/:id/self-assessment': () => started,
    'POST accreditation/periods/:id/statement-1000': () => started,
    'POST reports/runs': () => started,
    'POST reports/runs/personal': () => started,
    ...o.extra,
  };
}

const card = (title: string): Promise<HTMLElement> => screen.findByRole('region', { name: title }, FIRST);

describe('Cetak', () => {
  it('the simulation card carries the internal header text', async () => {
    renderTab(PrintTab, routes());
    const simulation = await card(ID['report.accreditation.self_assessment.title']);
    expect(within(simulation).getByText(ID['accred.simulation.header'])).toBeTruthy();
    expect(within(await card(ID['report.accreditation.dossier.title'])).queryByText(ID['accred.simulation.header'])).toBeNull();
  });

  it('a component of 9.5 MB with a 9 MB limit shows the warning on that component only', async () => {
    renderTab(PrintTab, routes({ bytes: { K: 9.5 * MB, SP: 2 * MB, profil: 1 * MB } }));
    const sizes = await screen.findByRole('table', { name: ADMIN_ID['accreditation.print.sizes.title'] }, FIRST);
    const row = (code: string): HTMLElement => sizes.querySelector(`tr[data-component="${code}"]`) as HTMLElement;
    await waitFor(() => expect(within(row('K')).getByText('9,5 MB dari 9 MB')).toBeTruthy());
    expect(within(row('K')).getByText('Melebihi batas 9 MB. Perkecil atau kurangi berkasnya sebelum mengunggah.')).toBeTruthy();
    for (const code of ['SP', 'L', 'T', 'F', 'G', 'profil']) expect(within(row(code)).queryByText(/Melebihi batas/)).toBeNull();
    expect(sizes.querySelectorAll('[data-over-limit]')).toHaveLength(1);
  });

  it('the dossier ZIP per component posts {format: zip_components} after the password confirmation', async () => {
    const api = renderTab(PrintTab, routes());
    const dossier = await card(ID['report.accreditation.dossier.title']);
    fireEvent.click(within(dossier).getByRole('button', { name: ADMIN_ID['accreditation.print.dossier.zip_components'] }));
    await screen.findByRole('dialog', { name: ADMIN_ID['reauth.title'] }, FIRST);
    expect(api.to(DOSSIER)).toEqual([]);
    await confirmPassword();
    await waitFor(() => expect(api.to(DOSSIER)).toHaveLength(1));
    expect(api.to(DOSSIER)[0]!.body).toEqual({ format: 'zip_components' });
    const writes = api.writes();
    expect(writes.indexOf('POST auth/reauth')).toBeGreaterThanOrEqual(0);
    expect(writes.indexOf('POST auth/reauth')).toBeLessThan(writes.indexOf(DOSSIER));
    // The new run follows its job.
    expect(await screen.findByRole('progressbar', undefined, FIRST)).toBeTruthy();
  });

  it('the simulation, the PDF and the request letter go behind the password too; the statement does not', async () => {
    const api = renderTab(PrintTab, routes());
    const simulation = await card(ID['report.accreditation.self_assessment.title']);
    fireEvent.click(within(simulation).getByRole('button', { name: ADMIN_ID['accreditation.print.simulation.make'] }));
    await confirmPassword();
    await waitFor(() => expect(api.to(`POST accreditation/periods/${PERIOD_ID}/self-assessment`)).toHaveLength(1));
    expect(api.to(`POST accreditation/periods/${PERIOD_ID}/self-assessment`)[0]!.body).toEqual({});

    const dossier = await card(ID['report.accreditation.dossier.title']);
    fireEvent.click(within(dossier).getByRole('button', { name: ADMIN_ID['accreditation.print.request_letter'] }));
    await confirmPassword();
    await waitFor(() => expect(api.to(DOSSIER)).toHaveLength(1));
    expect(api.to(DOSSIER)[0]!.body).toEqual({ format: 'pdf', part: 'request_letter' });

    const reauths = api.to('POST auth/reauth').length;
    const statement = await card(ID['report.accreditation.statement_1000.title']);
    fireEvent.click(within(statement).getByRole('button', { name: ADMIN_ID['accreditation.print.statement.make'] }));
    await waitFor(() => expect(api.to(`POST accreditation/periods/${PERIOD_ID}/statement-1000`)).toHaveLength(1));
    expect(api.to('POST auth/reauth')).toHaveLength(reauths);
    expect(screen.queryByRole('dialog', { name: ADMIN_ID['reauth.title'] })).toBeNull();
  });

  it('annexes: CSV/XLSX through the run route, the staff annex through the personal route after the password', async () => {
    const api = renderTab(PrintTab, routes());
    const annexes = await card(ADMIN_ID['accreditation.print.annexes.title']);
    const ddc = ID['report.accreditation.annex.ddc.title'];
    fireEvent.click(within(annexes).getByRole('button', { name: `Buat ${ID['vocab.report_format.csv']}: ${ddc}` }));
    await waitFor(() => expect(api.to('POST reports/runs')).toHaveLength(1));
    expect(api.to('POST reports/runs')[0]!.body).toEqual({ reportId: 'accreditation.annex.ddc', format: 'csv', params: { periodId: PERIOD_ID } });

    const staff = ID['report.accreditation.annex.staff.title'];
    fireEvent.click(within(annexes).getByRole('button', { name: `Buat ${ID['vocab.report_format.xlsx']}: ${staff}` }));
    await confirmPassword();
    await waitFor(() => expect(api.to('POST reports/runs/personal')).toHaveLength(1));
    expect(api.to('POST reports/runs/personal')[0]!.body).toEqual({ reportId: 'accreditation.annex.staff', format: 'xlsx', params: { periodId: PERIOD_ID } });
    expect(api.to('POST reports/runs')).toHaveLength(1);
  });

  it('a finished ZIP run with a component over the limit shows the sentence for K, and its download asks for the password', async () => {
    const assign = vi.spyOn(page, 'assign').mockImplementation(() => undefined);
    renderTab(
      PrintTab,
      routes({
        runs: [
          reportRun({ warnings: ['component_over_limit:K:9961472'] }),
          reportRun({ id: '01JZ0000000000000000RUNU02', reportId: 'accreditation.annex.ddc', format: 'csv', personal: false, params: { periodId: PERIOD_ID } }),
          // Another period's run is not listed.
          reportRun({ id: '01JZ0000000000000000RUNU03', params: { periodId: '01JZ0000000000000000PRDU99', part: 'all', zipMode: 'combined' } }),
        ],
      }),
    );
    const runs = await card(ADMIN_ID['accreditation.print.runs.title']);
    const sentence = await within(runs).findByText(/Komponen K \(Koleksi Perpustakaan\) berukuran 9,5 MB/, undefined, FIRST);
    expect(sentence.textContent).toContain('9 MB');
    expect(within(runs).getAllByRole('listitem')).toHaveLength(2);

    const csv = within(runs).getByRole('link', { name: new RegExp(ID['report.accreditation.annex.ddc.title']) });
    expect(csv.getAttribute('href')).toBe('/api/v1/reports/runs/01JZ0000000000000000RUNU02/download');

    fireEvent.click(within(runs).getByRole('button', { name: new RegExp(`^${ADMIN_ID['accreditation.print.runs.download']} ${ID['report.accreditation.dossier.title']}`) }));
    await confirmPassword();
    await waitFor(() => expect(assign).toHaveBeenCalledWith(`/api/v1/reports/runs/${RUN_ID}/download`));
  });

  it('a generated list too large for the ZIP is said in words', async () => {
    renderTab(PrintTab, routes({ runs: [reportRun({ warnings: ['generated_too_large:title_list'] })] }));
    const runs = await card(ADMIN_ID['accreditation.print.runs.title']);
    expect(await within(runs).findByText(/Daftar title_list melebihi 10\.000 baris/, undefined, FIRST)).toBeTruthy();
  });

  it('an unscored instrument offers neither the simulation nor the ZIP per component nor the request letter', async () => {
    renderTab(PrintTab, routes({ scored: false }));
    const dossier = await card(ID['report.accreditation.dossier.title']);
    await waitFor(() => expect(screen.queryByRole('region', { name: ID['report.accreditation.self_assessment.title'] })).toBeNull());
    expect(within(dossier).queryByRole('button', { name: ADMIN_ID['accreditation.print.dossier.zip_components'] })).toBeNull();
    expect(within(dossier).queryByRole('button', { name: ADMIN_ID['accreditation.print.request_letter'] })).toBeNull();
    expect(within(dossier).getByRole('button', { name: ADMIN_ID['accreditation.print.dossier.zip'] })).toBeTruthy();
  });
});
