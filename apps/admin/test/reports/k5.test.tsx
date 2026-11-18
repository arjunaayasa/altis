import type { CollectionStatistics, LoanStatistics, MemberStatistics, VisitStatistics } from '@altis/shared/api/library-statistics';
import type { ReportCatalogEntry, ReportCell, ReportColumnView, ReportPreviewResponse, ReportRunCreateBody } from '@altis/shared/api/reports';
import { fireEvent, render, screen, waitFor, within } from '@testing-library/react';
import { afterEach, describe, expect, it, vi } from 'vitest';
import { BarChart } from '@/components/bar-chart';
import { adminMe, problem, signedIn, startApp, type FakeRequest } from '../fake-api';
import { PERIOD_ID, instrumentsAnswer, periodView, periodsAnswer, resultsView } from '../accreditation/workspace-fixtures';
import { FIRST, job, optionRoutes, run } from './support';

// The second round of reports in the admin: the compact SVG bar chart (accessible, sensible for no bar, one bar, all
// zeros and too many), the chart of a report's preview drawn from its rows and its totals, the annual report's page (a
// document exported through the run routes: its filters and "Ekspor PDF", no preview), and the library statistics of
// Beranda, one card per module the user reads.

afterEach(() => {
  vi.unstubAllGlobals();
  vi.restoreAllMocks();
});

const col = (key: string, type: ReportColumnView['type']): ReportColumnView => ({ key, labelKey: `report.column.${key}`, type });

const DAILY: ReportCatalogEntry = {
  id: 'visits.daily',
  module: 'visits',
  kind: 'table',
  titleKey: 'report.visits.daily.title',
  personal: false,
  canExport: true,
  formats: ['csv', 'xlsx', 'pdf'],
  orientation: 'portrait',
  params: [],
  columns: [col('date', 'date'), col('weekday', 'text'), col('members', 'int'), col('guests', 'int'), col('total', 'int')],
  chart: { kind: 'rows', label: 'date', value: 'total' },
};

const MONTHLY: ReportCatalogEntry = {
  ...DAILY,
  id: 'visits.monthly',
  titleKey: 'report.visits.monthly.title',
  columns: [col('group', 'text'), col('m01', 'int'), col('m02', 'int'), col('total', 'int')],
  chart: { kind: 'totals', columns: ['m01', 'm02', 'm13'] },
};

const ANNUAL: ReportCatalogEntry = {
  id: 'library.annual_report',
  module: 'library',
  kind: 'document',
  titleKey: 'report.library.annual_report.title',
  personal: false,
  canExport: true,
  formats: ['pdf'],
  orientation: 'portrait',
  params: [{ name: 'year', kind: 'year', labelKey: 'report.param.year', required: false, min: 1900, max: 2100 }],
  columns: null,
  chart: null,
};

describe('the bar chart', () => {
  const draw = (bars: { label: string; value: number }[], maxBars?: number) =>
    render(<BarChart title="Kunjungan per bulan" description="Angka lengkap ada di tabel." bars={bars} format={(v) => String(v)} {...(maxBars === undefined ? {} : { maxBars })} />);

  it('draws nothing without a bar', () => {
    const { container } = draw([]);
    expect(container.innerHTML).toBe('');
  });

  it('is an image named by its title and described, one bar no wider than its cap, the highest value labelled', () => {
    const { container } = draw([{ label: 'Mar', value: 32 }]);
    const img = screen.getByRole('img', { name: 'Kunjungan per bulan Angka lengkap ada di tabel.' });
    expect(img.querySelector('title')?.textContent).toBe('Kunjungan per bulan');
    expect(img.querySelector('desc')?.textContent).toBe('Angka lengkap ada di tabel.');
    const bar = container.querySelector('[data-bar="Mar"] path')!;
    const xs = [...bar.getAttribute('d')!.matchAll(/[MH](-?[\d.]+)/g)].map((m) => Number(m[1]));
    expect(Math.max(...xs) - Math.min(...xs)).toBeLessThanOrEqual(40);
    expect(container.querySelector('[data-bar="Mar"] rect title')?.textContent).toBe('Mar: 32');
    expect([...container.querySelectorAll('text')].map((t) => t.textContent)).toEqual(['32', 'Mar']);
  });

  it('lays all-zero bars flat on the baseline, and draws only the first bars of too many', () => {
    const { container, unmount } = draw([
      { label: 'Jan', value: 0 },
      { label: 'Feb', value: 0 },
    ]);
    expect(container.querySelectorAll('[data-bar]')).toHaveLength(2);
    expect(container.querySelectorAll('path')).toHaveLength(0);
    expect(container.querySelectorAll('line')).toHaveLength(1);
    unmount();
    const many = draw(
      Array.from({ length: 50 }, (_, k) => ({ label: `B${k + 1}`, value: k + 1 })),
      40,
    );
    expect(many.container.querySelectorAll('[data-bar]')).toHaveLength(40);
    // Only the first and the last label of many bars.
    expect([...many.container.querySelectorAll('text')].map((t) => t.textContent)).toEqual(['B1', '40', 'B40']);
  });

  it('is drawn as wide as its box, one unit a pixel, so its labels keep their size on a phone and clip shorter', () => {
    vi.spyOn(HTMLElement.prototype, 'getBoundingClientRect').mockReturnValue({ width: 300, height: 150 } as DOMRect);
    const titles = ['Logika Pemrograman Dasar', 'Mengelola Emosi Remaja', 'Belajar Jaringan dari Nol', 'Aljabar Tanpa Takut', 'Gizi Seimbang Keluarga'];
    const { container } = draw(titles.map((label, k) => ({ label, value: 5 - k })));
    expect(container.querySelector('svg')?.getAttribute('viewBox')).toBe('0 0 300 150');
    // A slot of 60 px holds a label of 10 characters.
    const labels = [...container.querySelectorAll('text')].map((t) => t.textContent).filter((s) => s !== '5');
    expect(labels).toEqual(['Logika Pe…', 'Mengelola…', 'Belajar J…', 'Aljabar T…', 'Gizi Seim…']);
  });
});

/** A preview answer of `visits.daily` with `rows`. */
const dailyPreview = (rows: ReportCell[][]): ReportPreviewResponse => ({ columns: DAILY.columns!, rows, nextCursor: null, totals: null });

function openReport(entry: ReportCatalogEntry, extra: Record<string, (req: FakeRequest) => unknown> = {}) {
  const me = adminMe();
  return startApp({
    me,
    path: `/admin/reports/${entry.id}`,
    routes: {
      'GET reports/catalog': () => ({ reports: [DAILY, MONTHLY, ANNUAL] }),
      'GET reports/runs': () => ({ runs: [], nextCursor: null }),
      ...optionRoutes(),
      ...extra,
    },
  });
}

describe('the chart of a preview', { timeout: 20_000 }, () => {
  it('a bar per row, named by its columns, above the table; none for no row', async () => {
    let rows: ReportCell[][] = [
      ['2026-03-02', 'Senin', 31, 0, 31],
      ['2026-03-04', 'Rabu', 0, 1, 1],
    ];
    openReport(DAILY, { [`POST reports/${DAILY.id}/preview`]: () => dailyPreview(rows) });
    await screen.findByRole('heading', { level: 1, name: 'Kunjungan harian' }, FIRST);
    fireEvent.click(screen.getByRole('button', { name: 'Terapkan' }));
    const chart = await screen.findByRole('img', { name: /^Jumlah per Tanggal/ });
    expect(chart.querySelectorAll('[data-bar]')).toHaveLength(2);
    // A date labels its bar as the table under it says it.
    expect([...chart.querySelectorAll('[data-bar]')].map((b) => b.getAttribute('data-bar'))).toEqual(['2 Mar 2026', '4 Mar 2026']);
    expect(chart.querySelector('desc')?.textContent).toContain('tertinggi 31');
    rows = [];
    fireEvent.click(screen.getByRole('button', { name: 'Terapkan' }));
    await screen.findByText('Tidak ada baris untuk filter ini.');
    expect(screen.queryByRole('img', { name: /Jumlah per Tanggal/ })).toBeNull();
  });

  it('a bar per listed column of the totals row, a column the answer lacks skipped', async () => {
    openReport(MONTHLY, {
      [`POST reports/${MONTHLY.id}/preview`]: () => ({ columns: MONTHLY.columns!, rows: [['Siswa', 5, 7, 12]], nextCursor: null, totals: ['Jumlah', 5, 7, 12] }),
    });
    await screen.findByRole('heading', { level: 1, name: 'Kunjungan per bulan' }, FIRST);
    fireEvent.click(screen.getByRole('button', { name: 'Terapkan' }));
    const chart = await screen.findByRole('img', { name: /^Jumlah per kolom/ });
    expect([...chart.querySelectorAll('[data-bar]')].map((b) => b.getAttribute('data-bar'))).toEqual(['Jan', 'Feb']);
  });
});

describe('the annual report page', { timeout: 20_000 }, () => {
  it('shows its filters without a preview and exports a PDF through reports/runs', async () => {
    const RUN_ID = '01JZ0000000000000000RR0009';
    const JOB_ID = '01JZ0000000000000000JB0009';
    const { requests } = openReport(ANNUAL, {
      'POST reports/runs': () => ({ id: RUN_ID, jobId: JOB_ID }),
      'GET jobs/:id': (req) => job(req.params['id']!, { createdBy: adminMe().user.id }),
      'GET reports/runs/:id': () => run({ id: RUN_ID, reportId: ANNUAL.id, jobId: JOB_ID, format: 'pdf' }),
    });
    await screen.findByRole('heading', { level: 1, name: 'Laporan Tahunan Perpustakaan' }, FIRST);
    const form = screen.getByRole('form', { name: 'Filter' });
    expect(within(form).queryByRole('button', { name: 'Terapkan' })).toBeNull();
    expect(screen.queryByRole('heading', { name: 'Pratinjau' })).toBeNull();
    const panel = screen.getByRole('region', { name: 'Ekspor' });
    expect(within(panel).getAllByRole('button').map((b) => b.textContent)).toEqual(['Ekspor PDF']);
    fireEvent.change(within(form).getByLabelText('Tahun'), { target: { value: '2025' } });
    fireEvent.click(within(panel).getByRole('button', { name: 'Ekspor PDF' }));
    await waitFor(() => expect(requests.filter((r) => r.method === 'POST' && r.path === 'reports/runs')).toHaveLength(1));
    const body = requests.find((r) => r.method === 'POST' && r.path === 'reports/runs')!.body as ReportRunCreateBody;
    expect(body).toEqual({ reportId: ANNUAL.id, format: 'pdf', params: { year: 2025 } });
  });
});

describe('the library statistics of the reports page', { timeout: 20_000 }, () => {
  const months = Array.from({ length: 12 }, (_, k) => (k === 2 ? 32 : 0));
  const routes = {
    'GET dashboard': () => problem(500, 'INTERNAL'),
    'GET catalog/statistics': (): CollectionStatistics => ({ today: '2026-03-15', year: 2026, titles: 1200, items: 3400, receivedThisYear: 40 }),
    'GET members/statistics': (): MemberStatistics => ({ today: '2026-03-15', year: 2026, registered: 500, valid: 480, joinedThisYear: 60 }),
    'GET visits/statistics': (): VisitStatistics => ({ today: '2026-03-15', year: 2026, thisMonth: 32, thisYear: 32, byMonth: months }),
    'GET circulation/statistics': (): LoanStatistics => ({ today: '2026-03-15', year: 2026, thisMonth: 10, thisYear: 25, byMonth: months, open: 7, overdue: 2 }),
  };

  it('one card per module the user reads, each read from its own endpoint only', async () => {
    const { requests } = startApp({ me: signedIn({ permissions: ['visits.records.read', 'circulation.records.read'] }), path: '/admin/reports', routes });
    const section = await screen.findByRole('region', { name: 'Statistik perpustakaan' }, FIRST);
    const cards = within(section).getAllByRole('group').map((r) => r.getAttribute('aria-labelledby') && document.getElementById(r.getAttribute('aria-labelledby')!)?.textContent);
    expect(cards).toEqual(['Kunjungan', 'Peminjaman']);
    await within(section).findByText('25');
    expect(within(section).getByRole('img', { name: /^Peminjaman per bulan, 2026/ })).toBeTruthy();
    const read = requests.filter((r) => r.path.endsWith('/statistics')).map((r) => r.path);
    expect([...new Set(read)].sort()).toEqual(['circulation/statistics', 'visits/statistics']);
  });

  it('nothing for a user who reads none of the four modules', async () => {
    const { requests } = startApp({ me: signedIn({ permissions: ['reports.statistics.read'] }), path: '/admin/reports', routes });
    await screen.findByRole('heading', { level: 1, name: 'Laporan' }, FIRST);
    expect(screen.queryByRole('region', { name: 'Statistik perpustakaan' })).toBeNull();
    expect(requests.filter((r) => r.path.endsWith('/statistics'))).toEqual([]);
  });
});

describe('the draft of a signed evidence item', { timeout: 20_000 }, () => {
  /** The workspace's indicators, the signed policy document of K3 drafted by the annual report. */
  function openIndicators(me: ReturnType<typeof adminMe>) {
    const answer = structuredClone(instrumentsAnswer());
    for (const i of answer.instruments) {
      for (const c of i.components) for (const ind of c.indicators) for (const e of ind.evidence) if (e.code === 'policy_document') e.reportId = 'library.annual_report';
    }
    const period = periodView({ instrumentId: 'sch-sma-2025' });
    startApp({
      me,
      path: `/admin/accreditation/${PERIOD_ID}?tab=indikator`,
      routes: {
        'GET accreditation/instruments': () => answer,
        'GET accreditation/periods': () => periodsAnswer(period),
        'GET accreditation/periods/:id': () => period,
        'GET accreditation/periods/:id/results': () => resultsView(),
      },
    });
  }

  it('names the report that drafts it, with a link to make it for the period for a reader of the statistics reports', async () => {
    openIndicators(adminMe());
    const k3 = await screen.findByRole('region', { name: 'K3 · Koleksi butir 3' }, FIRST);
    expect(k3.textContent).toContain('Drafnya dibuat ALTIS lewat laporan Laporan Tahunan Perpustakaan.');
    const href = within(k3).getByRole('link', { name: 'Buat draf' }).getAttribute('href') ?? '';
    expect(href.startsWith('/admin/reports/library.annual_report?')).toBe(true);
    expect(new URLSearchParams(href.split('?')[1]).get('periodId')).toContain(PERIOD_ID);
  });

  it('names it without a link for a reader of the workspace only', async () => {
    openIndicators(signedIn({ permissions: ['accreditation.workspace.read'] }));
    const k3 = await screen.findByRole('region', { name: 'K3 · Koleksi butir 3' }, FIRST);
    expect(k3.textContent).toContain('Laporan Tahunan Perpustakaan');
    expect(within(k3).queryByRole('link', { name: 'Buat draf' })).toBeNull();
  });
});
