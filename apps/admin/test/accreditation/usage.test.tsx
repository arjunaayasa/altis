import type { UsageGridView, UsageGroupsView, UsagePutBody } from '@altis/shared/api/accreditation';
import { fireEvent, screen, waitFor, within } from '@testing-library/react';
import { afterEach, describe, expect, it, vi } from 'vitest';
import { UsageTab } from '@/screens/accreditation/tabs/usage';
import { USER_ANI, signedIn, type FakeHandler } from '../fake-api';
import { ADMIN_ID, FIRST, PERIOD_ID, T0, instrumentsAnswer, periodView, renderTab, usageGrid } from './usage-print-fixtures';

// Penggunaan Bulanan (spec §6, §10.7): the grid of months × metrics of one group at a time with the source of every
// cell, manual cells saved together in writes of at most 500 cells, the cells of the whole period, the last SLiMS
// import with its cut-over date, and the mapping of SLiMS member types (and of the members SLiMS deleted) to the
// accreditation groups, which takes effect without a new import.

afterEach(() => {
  vi.unstubAllGlobals();
  vi.restoreAllMocks();
});

const USAGE = `accreditation/periods/${PERIOD_ID}/usage`;

const GROUPS: UsageGroupsView = {
  groups: [
    { groupKey: 'slims_type:1', label: 'Siswa', accredGroup: 'student', updatedAt: T0 },
    { groupKey: 'slims_type:2', label: 'Guru', accredGroup: 'teacher', updatedAt: T0 },
    { groupKey: 'member_unknown', label: null, accredGroup: 'student', updatedAt: T0 },
  ],
};

function routes(o: { grid?: UsageGridView; period?: ReturnType<typeof periodView>; groups?: UsageGroupsView } = {}): Record<string, FakeHandler> {
  return {
    'GET accreditation/periods/:id': () => o.period ?? periodView(),
    'GET accreditation/periods/:id/usage': () => o.grid ?? usageGrid(),
    'PUT accreditation/periods/:id/usage': () => ({ id: PERIOD_ID, version: 3 }),
    'GET accreditation/usage-groups': () => o.groups ?? GROUPS,
    'PUT accreditation/usage-groups': (req) => ({ count: (req.body as { groups: unknown[] }).groups.length }),
    'GET accreditation/instruments': () => instrumentsAnswer(),
  };
}

const cellInput = (name: RegExp) => screen.findByRole('textbox', { name }, FIRST) as Promise<HTMLInputElement>;

describe('Penggunaan Bulanan: the grid', () => {
  it('editing two cells sends one PUT with both; a SLiMS cell and a manual cell show their source', async () => {
    const api = renderTab(
      UsageTab,
      routes({ grid: usageGrid({ 'visits|2026-01|': { value: 120, source: 'slims' }, 'loans|2026-02|': { value: 40, source: 'manual' } }) }),
    );
    const visitsJan = await cellInput(/^Kunjungan \(mentah\), Januari 2026,/);
    const loansFeb = await cellInput(/^Peminjaman, Februari 2026,/);
    expect(visitsJan.value).toBe('120');
    expect(within(visitsJan.closest('td')!).getByText('Impor SLiMS')).toBeTruthy();
    expect(within(loansFeb.closest('td')!).getByText('Isian manual')).toBeTruthy();
    expect(within((await cellInput(/^Kunjungan \(mentah\), Maret 2026,/)).closest('td')!).getByText('Tidak ada data')).toBeTruthy();

    fireEvent.change(visitsJan, { target: { value: '130' } });
    fireEvent.change(loansFeb, { target: { value: '' } });
    fireEvent.click(screen.getByRole('button', { name: ADMIN_ID['accreditation.usage.save'] }));

    await waitFor(() => expect(api.to(`PUT ${USAGE}`)).toHaveLength(1));
    const body = api.to(`PUT ${USAGE}`)[0]!.body as UsagePutBody;
    expect(body).toEqual({
      cells: [
        { metric: 'visits', month: '2026-01', groupKey: '', value: 130 },
        { metric: 'loans', month: '2026-02', groupKey: '', value: null },
      ],
    });
    expect(await screen.findByText(ADMIN_ID['accreditation.usage.saved'])).toBeTruthy();
  });

  it('a cell of another group and a cell of the whole period go into the same write', async () => {
    const api = renderTab(UsageTab, routes());
    fireEvent.change(await cellInput(/^Peminjaman, Januari 2026,/), { target: { value: '7' } });
    fireEvent.change(screen.getByRole('combobox', { name: ADMIN_ID['accreditation.usage.group'] }), { target: { value: 'grp:teacher' } });
    fireEvent.change(await cellInput(/^Kunjungan \(mentah\), Maret 2026, kelompok Guru\/Dosen/), { target: { value: '15' } });
    fireEvent.change(await cellInput(/^Judul yang dimanfaatkan, Seluruh periode, kelompok Guru\/Dosen/), { target: { value: '80' } });
    fireEvent.click(screen.getByRole('button', { name: ADMIN_ID['accreditation.usage.save'] }));
    await waitFor(() => expect(api.to(`PUT ${USAGE}`)).toHaveLength(1));
    expect((api.to(`PUT ${USAGE}`)[0]!.body as UsagePutBody).cells).toEqual([
      { metric: 'loans', month: '2026-01', groupKey: '', value: 7 },
      { metric: 'visits', month: '2026-03', groupKey: 'grp:teacher', value: 15 },
      { metric: 'titles_used', month: null, groupKey: 'grp:teacher', value: 80 },
    ]);
  });

  it('a value that is not a whole number is refused before anything is sent', async () => {
    const api = renderTab(UsageTab, routes());
    const input = await cellInput(/^Peminjaman, Januari 2026,/);
    fireEvent.change(input, { target: { value: '-3' } });
    fireEvent.click(screen.getByRole('button', { name: ADMIN_ID['accreditation.usage.save'] }));
    expect(await screen.findByText(ADMIN_ID['accreditation.usage.invalid'])).toBeTruthy();
    expect(input.getAttribute('aria-invalid')).toBe('true');
    expect(api.writes()).toEqual([]);
  });

  it('a frozen period disables editing', async () => {
    const api = renderTab(UsageTab, routes({ period: periodView({ status: 'frozen', frozenAt: T0, frozenBy: USER_ANI.id }) }));
    const input = await cellInput(/^Kunjungan \(mentah\), Januari 2026,/);
    expect(input.disabled).toBe(true);
    expect(screen.queryByRole('button', { name: ADMIN_ID['accreditation.usage.save'] })).toBeNull();
    expect(screen.getByText(ADMIN_ID['accreditation.usage.frozen'])).toBeTruthy();
    expect(api.writes()).toEqual([]);
  });

  it('a reader without the manage permission sees the grid but cannot edit it', async () => {
    renderTab(UsageTab, routes(), { me: signedIn({ permissions: ['accreditation.workspace.read'] }) });
    expect((await cellInput(/^Kunjungan \(mentah\), Januari 2026,/)).disabled).toBe(true);
    expect(screen.queryByRole('button', { name: ADMIN_ID['accreditation.usage.import_open'] })).toBeNull();
    expect(((await screen.findByRole('combobox', { name: 'Kelompok untuk Guru' })) as HTMLSelectElement).disabled).toBe(true);
  });

  it('a cut month says until when its SLiMS figures count, and the last import shows its cut-over date', async () => {
    renderTab(
      UsageTab,
      routes({
        grid: usageGrid(
          { 'visits|2026-01|': { value: 50, source: 'slims', spanTo: '2026-01-14' } },
          { lastImport: { runId: '01JZ0000000000000000RUNU09', finishedAt: T0, cutoverOn: '2026-01-15' } },
        ),
      }),
    );
    const td = (await cellInput(/^Kunjungan \(mentah\), Januari 2026,/)).closest('td')!;
    expect(within(td).getByText('sampai 2026-01-14')).toBeTruthy();
    expect(screen.getByText(/Tanggal cut-over: 2026-01-15/)).toBeTruthy();
  });
});

describe('Penggunaan Bulanan: the member-type mapping', () => {
  it('changing slims_type:2 to Umum sends PUT accreditation/usage-groups; the deleted members have their own row', async () => {
    const api = renderTab(UsageTab, routes());
    const guru = (await screen.findByRole('combobox', { name: 'Kelompok untuk Guru' }, FIRST)) as HTMLSelectElement;
    expect(guru.value).toBe('teacher');
    const unknown = screen.getByRole('combobox', { name: `Kelompok untuk ${ADMIN_ID['accreditation.usage.groups.unknown']}` }) as HTMLSelectElement;
    expect(unknown.value).toBe('student');

    fireEvent.change(guru, { target: { value: 'public' } });
    await waitFor(() => expect(api.to('PUT accreditation/usage-groups')).toHaveLength(1));
    expect(api.to('PUT accreditation/usage-groups')[0]!.body).toEqual({ groups: [{ groupKey: 'slims_type:2', accredGroup: 'public' }] });
  });

  it('"Tidak dihitung" sends a null group; a missing deleted-members row shows the default group', async () => {
    const api = renderTab(UsageTab, routes({ groups: { groups: [GROUPS.groups[0]!] } }));
    const unknown = (await screen.findByRole(
      'combobox',
      { name: `Kelompok untuk ${ADMIN_ID['accreditation.usage.groups.unknown']}` },
      FIRST,
    )) as HTMLSelectElement;
    await waitFor(() => expect(unknown.value).toBe('student'));
    fireEvent.change(screen.getByRole('combobox', { name: 'Kelompok untuk Siswa' }), { target: { value: '' } });
    await waitFor(() => expect(api.to('PUT accreditation/usage-groups')).toHaveLength(1));
    expect(api.to('PUT accreditation/usage-groups')[0]!.body).toEqual({ groups: [{ groupKey: 'slims_type:1', accredGroup: null }] });
  });
});

describe('Penggunaan Bulanan: opening the SLiMS import', () => {
  const UNSAVED = ADMIN_ID['accreditation.unsaved.title'];
  const WIZARD = ADMIN_ID['accreditation.usage.wizard.title'];
  const openImport = (): void => void fireEvent.click(screen.getByRole('button', { name: ADMIN_ID['accreditation.usage.import_open'] }));

  it('asks first while cells are unsaved: Batal keeps them, going on opens the import in their place', async () => {
    const api = renderTab(UsageTab, routes());
    fireEvent.change(await cellInput(/^Peminjaman, Januari 2026,/), { target: { value: '7' } });
    openImport();
    const ask = await screen.findByRole('alertdialog', { name: UNSAVED });
    expect(screen.queryByRole('heading', { name: WIZARD })).toBeNull();
    fireEvent.click(within(ask).getByRole('button', { name: ADMIN_ID['form.cancel'] }));
    await waitFor(() => expect(screen.queryByRole('alertdialog', { name: UNSAVED })).toBeNull());
    await waitFor(() => expect((screen.getByRole('textbox', { name: /^Peminjaman, Januari 2026,/ }) as HTMLInputElement).value).toBe('7'));
    expect(screen.queryByRole('heading', { name: WIZARD })).toBeNull();

    openImport();
    const again = await screen.findByRole('alertdialog', { name: UNSAVED });
    fireEvent.click(within(again).getByRole('button', { name: ADMIN_ID['accreditation.unsaved.leave'] }));
    expect(await screen.findByRole('heading', { name: WIZARD })).toBeTruthy();
    expect(screen.queryByRole('textbox', { name: /^Peminjaman, Januari 2026,/ })).toBeNull();
    expect(api.writes()).toEqual([]);
  });

  it('opens at once when no cell is unsaved', async () => {
    renderTab(UsageTab, routes());
    await cellInput(/^Peminjaman, Januari 2026,/);
    openImport();
    expect(await screen.findByRole('heading', { name: WIZARD })).toBeTruthy();
    expect(screen.queryByRole('alertdialog', { name: UNSAVED })).toBeNull();
  });
});
