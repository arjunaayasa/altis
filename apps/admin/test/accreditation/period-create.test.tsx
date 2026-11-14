import { MESSAGES } from '@altis/shared';
import { fireEvent, screen, waitFor } from '@testing-library/react';
import { afterEach, describe, expect, it, vi } from 'vitest';
import { adminMe, problem, signedIn, startApp, type FakeHandler } from '../fake-api';
import { OTHER_PERIOD_ID, instrumentsAnswer, periodView, periodsAnswer, resultsView } from './workspace-fixtures';

// A new accreditation period (spec §6, §10.2, §10.5): the instrument, the period kind and the input that kind needs (a
// year for a school or calendar year, the last month for twelve rolling months, two dates for a free span), the school
// level of the profile, and where the profile is copied from. The server decides whether the instrument fits the
// library; its refusal is shown.

afterEach(() => {
  vi.unstubAllGlobals();
  vi.restoreAllMocks();
});

const FIRST = { timeout: 10_000 };
const ID = MESSAGES.id;
const NEW_ID = '01JZ0000000000000000PRD009';

function open(o: { libraryType?: 'sekolah' | 'umum'; me?: ReturnType<typeof adminMe>; create?: FakeHandler } = {}) {
  const routes: Record<string, FakeHandler> = {
    'GET accreditation/instruments': () => instrumentsAnswer({ libraryType: o.libraryType ?? 'sekolah' }),
    'GET accreditation/periods': () => periodsAnswer(periodView({ id: OTHER_PERIOD_ID, name: 'Akreditasi 2025' })),
    'GET accreditation/periods/:id': () => periodView({ id: NEW_ID }),
    'GET accreditation/periods/:id/results': () => resultsView(),
    'POST accreditation/periods': o.create ?? (() => new Response(JSON.stringify({ id: NEW_ID, version: 1 }), { status: 201, headers: { 'Content-Type': 'application/json' } })),
  };
  return startApp({ me: o.me ?? adminMe(), path: '/admin/accreditation/new', routes });
}

const select = (name: string) => screen.getByRole('combobox', { name }) as HTMLSelectElement;

describe('a new accreditation period', () => {
  it('an upper secondary instrument for a public library shows the mismatch refusal', async () => {
    const app = open({ libraryType: 'umum', create: () => problem(422, 'ACCRED_INSTRUMENT_MISMATCH', { meta: { libraryType: 'umum', schoolLevel: 'sma_smk_ma' } }) });
    fireEvent.change(await screen.findByRole('textbox', { name: 'Nama periode' }, FIRST), { target: { value: 'Akreditasi 2026' } });
    fireEvent.change(select('Instrumen'), { target: { value: 'sch-sma-2025' } });
    fireEvent.change(screen.getByRole('spinbutton', { name: 'Tahun mulai tahun pelajaran' }), { target: { value: '2025' } });
    fireEvent.click(screen.getByRole('button', { name: 'Buat periode' }));
    expect(await screen.findByText(ID['error.ACCRED_INSTRUMENT_MISMATCH'])).toBeTruthy();
    expect(app.writes()).toEqual(['POST accreditation/periods']);
    expect(app.router.state.location.pathname).toBe('/admin/accreditation/new');
  });

  it('the span input follows the kind: a year, the last month, or two dates', async () => {
    open();
    await screen.findByRole('textbox', { name: 'Nama periode' }, FIRST);
    fireEvent.change(select('Instrumen'), { target: { value: 'general-stats' } });
    const kind = select('Jenis periode');
    expect([...kind.options].map((o) => o.value)).toEqual(['school_year', 'calendar_year', 'rolling_12', 'custom']);
    expect(kind.value).toBe('calendar_year');
    expect(screen.getByRole('spinbutton', { name: 'Tahun' })).toBeTruthy();

    fireEvent.change(kind, { target: { value: 'rolling_12' } });
    expect(screen.getByLabelText('Bulan terakhir').getAttribute('type')).toBe('month');
    expect(screen.queryByRole('spinbutton', { name: 'Tahun' })).toBeNull();

    fireEvent.change(kind, { target: { value: 'custom' } });
    expect(screen.getByLabelText('Tanggal mulai').getAttribute('type')).toBe('date');
    expect(screen.getByLabelText('Tanggal selesai').getAttribute('type')).toBe('date');
    expect(screen.queryByLabelText('Bulan terakhir')).toBeNull();

    fireEvent.change(kind, { target: { value: 'school_year' } });
    expect(screen.getByRole('spinbutton', { name: 'Tahun mulai tahun pelajaran' })).toBeTruthy();
    expect(screen.queryByLabelText('Tanggal mulai')).toBeNull();
  });

  it('a school instrument offers only its own kinds and sends its school level; the new period opens', async () => {
    const app = open();
    fireEvent.change(await screen.findByRole('textbox', { name: 'Nama periode' }, FIRST), { target: { value: 'Akreditasi 2026' } });
    fireEvent.change(select('Instrumen'), { target: { value: 'sch-sma-2025' } });
    expect([...select('Jenis periode').options].map((o) => o.value)).toEqual(['school_year', 'rolling_12']);
    expect(select('Jenjang sekolah').value).toBe('sma_smk_ma');
    fireEvent.change(screen.getByRole('spinbutton', { name: 'Tahun mulai tahun pelajaran' }), { target: { value: '2025' } });
    fireEvent.change(select('Salin profil dan populasi dari'), { target: { value: OTHER_PERIOD_ID } });
    fireEvent.click(screen.getByRole('button', { name: 'Buat periode' }));
    await waitFor(() => expect(app.router.state.location.pathname).toBe(`/admin/accreditation/${NEW_ID}`));
    expect(app.requests.find((r) => r.method === 'POST')?.body).toEqual({
      name: 'Akreditasi 2026',
      instrumentId: 'sch-sma-2025',
      kind: 'school_year',
      startYear: 2025,
      profile: { schoolLevel: 'sma_smk_ma' },
      copyFromPeriodId: OTHER_PERIOD_ID,
    });
  });

  it('twelve rolling months send the last month', async () => {
    const app = open();
    fireEvent.change(await screen.findByRole('textbox', { name: 'Nama periode' }, FIRST), { target: { value: 'Statistik 12 bulan' } });
    fireEvent.change(select('Instrumen'), { target: { value: 'general-stats' } });
    fireEvent.change(select('Jenis periode'), { target: { value: 'rolling_12' } });
    fireEvent.change(screen.getByLabelText('Bulan terakhir'), { target: { value: '2026-05' } });
    fireEvent.change(select('Jenjang sekolah'), { target: { value: '' } });
    fireEvent.click(screen.getByRole('button', { name: 'Buat periode' }));
    await waitFor(() => expect(app.writes()).toEqual(['POST accreditation/periods']));
    expect(app.requests.find((r) => r.method === 'POST')?.body).toEqual({
      name: 'Statistik 12 bulan',
      instrumentId: 'general-stats',
      kind: 'rolling_12',
      endMonth: '2026-05',
    });
  });

  it('a free span sends its two days and shows the span refusal of the server', async () => {
    const app = open({ create: () => problem(422, 'ACCRED_PERIOD_SPAN', { meta: { kind: 'custom', months: 30 } }) });
    fireEvent.change(await screen.findByRole('textbox', { name: 'Nama periode' }, FIRST), { target: { value: 'Statistik dua tahun' } });
    fireEvent.change(select('Instrumen'), { target: { value: 'general-stats' } });
    fireEvent.change(select('Jenis periode'), { target: { value: 'custom' } });
    fireEvent.change(screen.getByLabelText('Tanggal mulai'), { target: { value: '2024-01-01' } });
    fireEvent.change(screen.getByLabelText('Tanggal selesai'), { target: { value: '2026-06-30' } });
    expect(screen.getByText('Periode: 1 Jan 2024 s.d. 30 Jun 2026.')).toBeTruthy();
    fireEvent.click(screen.getByRole('button', { name: 'Buat periode' }));
    expect(await screen.findByText(ID['error.ACCRED_PERIOD_SPAN'])).toBeTruthy();
    expect(app.requests.find((r) => r.method === 'POST')?.body).toEqual({
      name: 'Statistik dua tahun',
      instrumentId: 'general-stats',
      kind: 'custom',
      startsOn: '2024-01-01',
      endsOn: '2026-06-30',
      // The school level chosen with the upper secondary instrument stays: the statistics mode takes every level.
      profile: { schoolLevel: 'sma_smk_ma' },
    });
  });

  it('an empty name or year is not sent', async () => {
    const app = open();
    await screen.findByRole('textbox', { name: 'Nama periode' }, FIRST);
    fireEvent.change(select('Instrumen'), { target: { value: 'sch-sma-2025' } });
    fireEvent.change(screen.getByRole('spinbutton', { name: 'Tahun mulai tahun pelajaran' }), { target: { value: '' } });
    fireEvent.click(screen.getByRole('button', { name: 'Buat periode' }));
    expect((await screen.findAllByText('Wajib diisi.')).length).toBe(2);
    expect(app.writes()).toEqual([]);
  });

  it('a reader without the manage permission cannot make one', async () => {
    open({ me: signedIn({ permissions: ['accreditation.workspace.read'] }) });
    expect(await screen.findByText('Anda tidak memegang izin untuk membuat periode akreditasi.', undefined, FIRST)).toBeTruthy();
    expect(screen.queryByRole('button', { name: 'Buat periode' })).toBeNull();
  });
});
