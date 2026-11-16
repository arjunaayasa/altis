import { MESSAGES } from '@altis/shared';
import type { EvidenceView, ResultsView } from '@altis/shared/api/accreditation';
import { fireEvent, screen, waitFor, within } from '@testing-library/react';
import { afterEach, describe, expect, it, vi } from 'vitest';
import { adminMe, signedIn, startApp, type FakeHandler } from '../fake-api';
import { PERIOD_ID, T0, evidenceItem, indicator, indicatorResult, instrumentsAnswer, periodView, periodsAnswer, resultsView } from './workspace-fixtures';

// Indikator (spec §6, §10.3, §10.6): every indicator under its component with the decree's own number written as
// "Pelayanan butir 7" (a primary school instrument has no plagiarism item, so the concept `SCH-L8` is its service item
// 7), the computed value with its formula, source and notes, ALTIS's suggestion and the librarian's answer (an override
// needs a note), the evidence checklist with the ALTIS screen to capture and the upload, and the detail report.

afterEach(() => {
  vi.unstubAllGlobals();
  vi.restoreAllMocks();
});

const FIRST = { timeout: 10_000 };
const ID = MESSAGES.id;
const FILE_ID = '01JZ0000000000000000FIL001';
const EVIDENCE_ID = '01JZ0000000000000000EVD001';

/** The evidence row of a file uploaded for the policy document item of `SCH-K3`. */
const policyFile = (): EvidenceView => ({
  id: EVIDENCE_ID,
  periodId: PERIOD_ID,
  indicatorCode: 'SCH-K3',
  evidenceCode: 'policy_document',
  entity: null,
  entityId: null,
  fileId: FILE_ID,
  fileName: 'salah-unggah.pdf',
  size: 80_000,
  mime: 'application/pdf',
  caption: '',
  sortOrder: 0,
  createdAt: T0,
});

function open(o: { instrumentId?: string; results?: ResultsView; me?: ReturnType<typeof adminMe>; extra?: Record<string, FakeHandler> } = {}) {
  const period = periodView({ instrumentId: o.instrumentId ?? 'sch-sma-2025' });
  const routes: Record<string, FakeHandler> = {
    'GET accreditation/instruments': () => instrumentsAnswer(),
    'GET accreditation/periods': () => periodsAnswer(period),
    'GET accreditation/periods/:id': () => period,
    'GET accreditation/periods/:id/results': () => o.results ?? resultsView(),
    ...o.extra,
  };
  return startApp({ me: o.me ?? adminMe(), path: `/admin/accreditation/${PERIOD_ID}?tab=indikator`, routes });
}

describe('Indikator', () => {
  it('a primary school period numbers SCH-L8 as the decree does: "Pelayanan butir 7"', async () => {
    open({
      instrumentId: 'sch-sd-2025',
      results: resultsView({
        indicators: [indicatorResult('SCH-L6', 'L6', 'L'), indicatorResult('SCH-L8', 'L7', 'L'), indicatorResult('SCH-L9', 'L8', 'L')],
      }),
    });
    const item7 = await screen.findByRole('region', { name: 'L7 · Pelayanan butir 7' }, FIRST);
    expect(within(item7).getByText('SCH-L8')).toBeTruthy();
    expect(within(item7).getByText(ID['accred.ik.L8'])).toBeTruthy();
    const item8 = screen.getByRole('region', { name: 'L8 · Pelayanan butir 8' });
    expect(within(item8).getByText('SCH-L9')).toBeTruthy();
    expect(screen.queryByText('SCH-L7')).toBeNull();
    expect(screen.getByRole('heading', { name: ID['accred.component.L'] })).toBeTruthy();
  });

  it('the value with its formula, source and notes; the suggestion and an own answer both show', async () => {
    open({
      results: resultsView({
        indicators: [
          indicatorResult('SCH-K2', 'K2', 'K', {
            metric: 'collection.fiction_pct',
            value: 23,
            numerator: 230,
            denominator: 1_000,
            unit: 'percent',
            basis: 'live',
            notes: [{ key: 'accred.note.fiction_rule', params: { rule: 'tipe koleksi FIKSI' } }],
            suggestion: 'b',
            answer: { answer: 'c', mode: 'manual', note: null, updatedAt: T0, updatedBy: null },
            final: 'c',
          }),
        ],
      }),
    });
    const k2 = await screen.findByRole('region', { name: 'K2 · Koleksi butir 2' }, FIRST);
    expect(within(k2).getByText('230 × 100 ÷ 1.000 = 23 %')).toBeTruthy();
    expect(within(k2).getByText('Sumber: data ALTIS')).toBeTruthy();
    expect(within(k2).getByText('Judul dihitung sebagai fiksi menurut aturan ini: tipe koleksi FIKSI.')).toBeTruthy();
    expect(within(k2).getByText('Saran ALTIS: b')).toBeTruthy();
    expect(within(k2).getByText(`Jawaban tersimpan: c (${ID['vocab.answer_mode.manual']})`)).toBeTruthy();
    expect(within(k2).getByText('Jawaban akhir: c')).toBeTruthy();
  });

  it('an override without a note is not sent; with a note it is', async () => {
    const app = open({
      results: resultsView({ indicators: [indicatorResult('SCH-K1', 'K1', 'K', { value: 1_250, unit: 'count', basis: 'live', suggestion: 'b', final: 'b' })] }),
      extra: { 'PUT accreditation/periods/:id/answers/:code': () => ({ id: PERIOD_ID, version: 3 }) },
    });
    const k1 = await screen.findByRole('region', { name: 'K1 · Koleksi butir 1' }, FIRST);
    fireEvent.click(within(k1).getByRole('radio', { name: 'a' }));
    fireEvent.click(within(k1).getByRole('radio', { name: ID['vocab.answer_mode.override'] }));
    fireEvent.click(within(k1).getByRole('button', { name: 'Simpan jawaban' }));
    expect(await within(k1).findByText('Wajib diisi.')).toBeTruthy();
    expect(app.writes()).toEqual([]);

    fireEvent.change(within(k1).getByRole('textbox', { name: 'Catatan' }), { target: { value: 'Daftar judul diperiksa ulang' } });
    fireEvent.click(within(k1).getByRole('button', { name: 'Simpan jawaban' }));
    await waitFor(() => expect(app.writes()).toEqual([`PUT accreditation/periods/${PERIOD_ID}/answers/SCH-K1`]));
    const put = app.requests.find((r) => r.method === 'PUT');
    expect(put?.body).toEqual({ answer: 'a', mode: 'override', note: 'Daftar judul diperiksa ulang' });
  });

  it('a manual indicator offers its option texts and stores a manual answer; a stored answer can be removed', async () => {
    const app = open({
      results: resultsView({
        indicators: [
          indicatorResult('SCH-SP1', 'SP1', 'SP', { answer: { answer: 'b', mode: 'manual', note: null, updatedAt: T0, updatedBy: null }, final: 'b' }),
        ],
      }),
      extra: { 'PUT accreditation/periods/:id/answers/:code': () => ({ id: PERIOD_ID, version: 3 }) },
    });
    const sp1 = await screen.findByRole('region', { name: 'SP1 · Sarana dan Prasarana butir 1' }, FIRST);
    expect(within(sp1).getByText('ALTIS tidak memberi saran untuk butir ini.')).toBeTruthy();
    const d = within(sp1).getByRole('radio', { name: `d: ${ID['accred.ik.SP1.option.d']}` });
    fireEvent.click(d);
    fireEvent.click(within(sp1).getByRole('button', { name: 'Simpan jawaban' }));
    await waitFor(() => expect(app.writes()).toHaveLength(1));
    expect(app.requests.find((r) => r.method === 'PUT')?.body).toEqual({ answer: 'd', mode: 'manual', note: null });

    fireEvent.click(within(sp1).getByRole('button', { name: 'Hapus jawaban' }));
    await waitFor(() => expect(app.writes()).toHaveLength(2));
    expect(app.requests.filter((r) => r.method === 'PUT')[1]?.body).toEqual({ answer: null, mode: 'manual', note: null });
  });

  it('the evidence checklist says what is there, names the ALTIS screen to capture and offers the upload', async () => {
    open({
      results: resultsView({
        indicators: [
          indicatorResult('SCH-K1', 'K1', 'K', {
            evidence: [
              { code: 'title_list', present: true, files: [] },
              { code: 'catalogue_screenshot', present: false, files: [] },
              { code: 'ddc_recap', present: true, files: [] },
            ],
          }),
        ],
      }),
    });
    const k1 = await screen.findByRole('region', { name: 'K1 · Koleksi butir 1' }, FIRST);
    const list = within(k1).getByRole('list', { name: 'Daftar periksa bukti' });
    const [titles, shot] = within(list).getAllByRole('listitem');
    expect(titles!.textContent).toContain(ID['accred.evidence.K1.title_list']);
    expect(within(titles!).getByText('ada')).toBeTruthy();
    expect(titles!.textContent).toContain(ID['report.collection.title_list.title']);
    expect(within(shot!).getByText('belum')).toBeTruthy();
    expect(shot!.textContent).toContain('Tangkap layar ALTIS: Bibliografi');
    expect(within(shot!).getByRole('button', { name: 'Unggah berkas' })).toBeTruthy();
    expect(within(titles!).queryByRole('button', { name: 'Unggah berkas' })).toBeNull();
  });

  it('a wrong file is removed from its item after a confirmation, and the item then says it is missing', async () => {
    let removed = false;
    const k3 = (): ResultsView =>
      resultsView({
        indicators: [
          indicatorResult('SCH-K3', 'K3', 'K', {
            evidence: [{ code: 'policy_document', present: !removed, files: removed ? [] : [{ id: FILE_ID, name: 'salah-unggah.pdf', caption: '' }] }],
          }),
        ],
      });
    const app = open({
      results: k3(),
      extra: {
        'GET accreditation/periods/:id/results': () => k3(),
        'GET accreditation/evidence': () => ({
          evidence: removed ? [] : [policyFile()],
          componentBytes: { K: removed ? 0 : 80_000, SP: 0, L: 0, T: 0, F: 0, G: 0, profil: 0 },
        }),
        'DELETE accreditation/evidence/:id': () => {
          removed = true;
          return { id: EVIDENCE_ID, version: 0 };
        },
      },
    });
    const item = await screen.findByRole('region', { name: 'K3 · Koleksi butir 3' }, FIRST);
    expect(within(item).getByRole('link', { name: 'salah-unggah.pdf' }).getAttribute('href')).toBe(`/files/${FILE_ID}`);
    fireEvent.click(await within(item).findByRole('button', { name: 'Hapus berkas salah-unggah.pdf' }));
    const confirm = await screen.findByRole('alertdialog', { name: 'Hapus berkas salah-unggah.pdf?' });
    expect(within(confirm).getByText(/tidak lagi masuk berkas bukti dan ZIP-nya/)).toBeTruthy();
    fireEvent.click(within(confirm).getByRole('button', { name: 'Hapus' }));
    await waitFor(() => expect(app.writes()).toEqual([`DELETE accreditation/evidence/${EVIDENCE_ID}`]));
    await waitFor(() => expect(within(item).queryByRole('link', { name: 'salah-unggah.pdf' })).toBeNull());
    expect(within(item).getByText('belum')).toBeTruthy();
  });

  // ---- the stocktake minutes as evidence ----
  it('an item that takes the stocktake minutes links the stored minutes of a chosen finished session', async () => {
    const SESSION = '01JZ0000000000000000STK001';
    // The upper secondary instrument with its K7 and the minutes item.
    const instruments = instrumentsAnswer();
    const sma = instruments.instruments.find((i) => i.id === 'sch-sma-2025')!;
    sma.components[0]!.indicators.push(indicator('K7', 'K7', { window: 'current', evidence: [evidenceItem('stocktake_minutes', 'K7', { kind: 'signed_document' })] }));
    const app = open({
      results: resultsView({ indicators: [indicatorResult('SCH-K7', 'K7', 'K', { evidence: [{ code: 'stocktake_minutes', present: false, files: [] }] })] }),
      extra: {
        'GET accreditation/instruments': () => instruments,
        'GET accreditation/evidence': () => ({ evidence: [], componentBytes: { K: 0, SP: 0, L: 0, T: 0, F: 0, G: 0, profil: 0 } }),
        'GET accreditation/evidence/stocktake-minutes': () => ({
          items: [
            {
              stocktakeId: SESSION,
              name: 'Inventarisasi 2026',
              branch: { id: '01JZ0000000000000000000B01', code: 'PUSAT', name: 'Perpustakaan Pusat' },
              finishedAt: T0,
              fileId: FILE_ID,
              fileName: 'berita-acara-inventarisasi.pdf',
              size: 80_000,
            },
          ],
        }),
        'POST accreditation/evidence/stocktake-minutes': () => ({ id: EVIDENCE_ID, version: 0 }),
      },
    });
    const item = await screen.findByRole('region', { name: 'K7 · Koleksi butir 7' }, FIRST);
    fireEvent.click(within(item).getByRole('button', { name: 'Lampirkan berita acara inventarisasi' }));
    const dialog = await screen.findByRole('dialog', { name: 'Lampirkan berita acara inventarisasi' });
    const select = (await within(dialog).findByLabelText('Sesi inventarisasi')) as HTMLSelectElement;
    await waitFor(() => expect(select.disabled).toBe(false));
    // Nothing chosen: nothing is sent.
    fireEvent.click(within(dialog).getByRole('button', { name: 'Lampirkan' }));
    expect(await within(dialog).findByText('Pilih sesi inventarisasi.')).toBeTruthy();
    fireEvent.change(select, { target: { value: SESSION } });
    fireEvent.click(within(dialog).getByRole('button', { name: 'Lampirkan' }));
    await waitFor(() => expect(app.writes()).toEqual(['POST accreditation/evidence/stocktake-minutes']));
    expect(app.requests.find((r) => r.method === 'POST')?.body).toEqual({ stocktakeId: SESSION, periodId: PERIOD_ID, indicatorCode: 'SCH-K7' });
    await waitFor(() => expect(screen.queryByRole('dialog', { name: 'Lampirkan berita acara inventarisasi' })).toBeNull());
  });

  it('a reader sees the files of an item but cannot remove them', async () => {
    open({
      me: signedIn({ permissions: ['accreditation.workspace.read'] }),
      results: resultsView({
        indicators: [
          indicatorResult('SCH-K3', 'K3', 'K', {
            evidence: [{ code: 'policy_document', present: true, files: [{ id: FILE_ID, name: 'kebijakan.pdf', caption: '' }] }],
          }),
        ],
      }),
      extra: { 'GET accreditation/evidence': () => ({ evidence: [policyFile()], componentBytes: { K: 0, SP: 0, L: 0, T: 0, F: 0, G: 0, profil: 0 } }) },
    });
    const item = await screen.findByRole('region', { name: 'K3 · Koleksi butir 3' }, FIRST);
    expect(within(item).getByRole('link', { name: 'kebijakan.pdf' })).toBeTruthy();
    expect(within(item).queryByRole('button', { name: /^Hapus/ })).toBeNull();
  });

  it('links the detail report with its parameters', async () => {
    open({
      results: resultsView({
        indicators: [indicatorResult('SCH-K1', 'K1', 'K', { value: 1_250, detail: { reportId: 'collection.title_list', params: { asOf: '2026-06-30' } } })],
      }),
    });
    const k1 = await screen.findByRole('region', { name: 'K1 · Koleksi butir 1' }, FIRST);
    const href = within(k1).getByRole('link', { name: 'Buka laporan rincian' }).getAttribute('href') ?? '';
    expect(href.startsWith('/admin/reports/collection.title_list?')).toBe(true);
    expect(new URLSearchParams(href.split('?')[1]).get('asOf')).toContain('2026-06-30');
  });

  it('a collection report is linked only for a holder of the statistics permission; an annex for every reader', async () => {
    open({
      me: signedIn({ permissions: ['accreditation.workspace.read'] }),
      results: resultsView({
        indicators: [
          indicatorResult('SCH-K1', 'K1', 'K', { value: 1_250, detail: { reportId: 'collection.title_list', params: {} } }),
          indicatorResult('SCH-K3', 'K3', 'K', { value: 2, detail: { reportId: 'accreditation.annex.documents', params: { periodId: PERIOD_ID } } }),
        ],
      }),
    });
    const k1 = await screen.findByRole('region', { name: 'K1 · Koleksi butir 1' }, FIRST);
    expect(within(k1).queryByRole('link', { name: 'Buka laporan rincian' })).toBeNull();
    const k3 = screen.getByRole('region', { name: 'K3 · Koleksi butir 3' });
    expect(within(k3).getByRole('link', { name: 'Buka laporan rincian' }).getAttribute('href')).toContain('/admin/reports/accreditation.annex.documents?');
  });

  it('a reader without the manage permission sees the answers but cannot change them', async () => {
    open({
      me: signedIn({ permissions: ['accreditation.workspace.read'] }),
      results: resultsView({ indicators: [indicatorResult('SCH-K1', 'K1', 'K', { suggestion: 'a', final: 'a' })] }),
    });
    const k1 = await screen.findByRole('region', { name: 'K1 · Koleksi butir 1' }, FIRST);
    expect((within(k1).getByRole('radio', { name: 'a' }) as HTMLInputElement).disabled).toBe(true);
    expect((within(k1).getByRole('button', { name: 'Simpan jawaban' }) as HTMLButtonElement).disabled).toBe(true);
  });
});
