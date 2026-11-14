import type { EventItem } from '@altis/shared/api/events';
import { fireEvent, screen, waitFor, within } from '@testing-library/react';
import { afterEach, describe, expect, it, vi } from 'vitest';
import { accreditationEventKeys, accreditationKeys } from '@/screens/accreditation/data';
import { adminMe, problem, signedIn, startApp, type FakeHandler } from '../fake-api';
import {
  JOB_ID,
  OTHER_PERIOD_ID,
  PERIOD_ID,
  T0,
  instrumentsAnswer,
  jobView,
  periodView,
  periodsAnswer,
  resultsView,
} from './workspace-fixtures';

// The accreditation workspace frame (spec §6 "Akreditasi", §10.4, §10.12) through the real router and API client
// against a fake `/api/v1`: the period picker, the instrument with its decree and source status, the status line (the
// last catalogue sync from SLiMS with its link to the migration wizard in sync mode, when the results were computed,
// the stale marker, "Hitung ulang" with its job, the reminder to recalculate after catalogue edits) and the tab bar
// kept in the `tab` search param.

afterEach(() => {
  vi.unstubAllGlobals();
  vi.restoreAllMocks();
});

const FIRST = { timeout: 10_000 };

function routes(o: { period?: ReturnType<typeof periodView>; periods?: ReturnType<typeof periodView>[]; extra?: Record<string, FakeHandler> } = {}) {
  const period = o.period ?? periodView();
  const periods = o.periods ?? [period];
  return {
    'GET accreditation/instruments': () => instrumentsAnswer(),
    'GET accreditation/periods': () => periodsAnswer(...periods),
    'GET accreditation/periods/:id': (req) => periods.find((p) => p.id === req.params['id']) ?? problem(404, 'NOT_FOUND'),
    'GET accreditation/periods/:id/results': () => resultsView(),
    'GET accreditation/periods/:id/snapshots': () => ({ snapshots: [] }),
    ...o.extra,
  } satisfies Record<string, FakeHandler>;
}

describe('the accreditation workspace frame', () => {
  it('shows the instrument with its decree and source status, and when the results were computed', async () => {
    startApp({ me: adminMe(), path: `/admin/accreditation/${PERIOD_ID}`, routes: routes() });
    expect(await screen.findByText(/Kepka Perpusnas 159\/2025/, undefined, FIRST)).toBeTruthy();
    expect(screen.getByText(/salinan, belum dibandingkan dengan JDIH/)).toBeTruthy();
    expect(screen.getByText(/Dihitung pada/)).toBeTruthy();
    expect(screen.getByText('Hitung ulang setelah menyunting katalog.')).toBeTruthy();
    expect(screen.queryByText('basi')).toBeNull();
  });

  it('marks stale results', async () => {
    startApp({ me: adminMe(), path: `/admin/accreditation/${PERIOD_ID}`, routes: routes({ period: periodView({ stale: true }) }) });
    expect(await screen.findByText('basi', undefined, FIRST)).toBeTruthy();
  });

  it('a period never computed says so instead of a time', async () => {
    startApp({ me: adminMe(), path: `/admin/accreditation/${PERIOD_ID}`, routes: routes({ period: periodView({ computedAt: null, stale: true }) }) });
    expect(await screen.findByText('Hasil belum pernah dihitung.', undefined, FIRST)).toBeTruthy();
    expect(screen.queryByText(/Dihitung pada/)).toBeNull();
  });

  it('the status line names the last catalogue sync from SLiMS and links to the migration wizard in sync mode', async () => {
    startApp({ me: adminMe(), path: `/admin/accreditation/${PERIOD_ID}`, routes: routes({ period: periodView({ catalogSyncedAt: T0 }) }) });
    expect(await screen.findByText(/Katalog terakhir diselaraskan dari SLiMS:/, undefined, FIRST)).toBeTruthy();
    const link = screen.getByRole('link', { name: 'Selaraskan katalog dari SLiMS' });
    expect(link.getAttribute('href')).toBe('/admin/catalog/migration?catalogMode=sync');
  });

  it('no sync line for an installation without a SLiMS catalogue run', async () => {
    startApp({ me: adminMe(), path: `/admin/accreditation/${PERIOD_ID}`, routes: routes() });
    await screen.findByText(/Kepka Perpusnas 159\/2025/, undefined, FIRST);
    expect(screen.queryByText(/Katalog terakhir diselaraskan dari SLiMS/)).toBeNull();
    expect(screen.queryByRole('link', { name: 'Selaraskan katalog dari SLiMS' })).toBeNull();
  });

  it('"Hitung ulang" starts the evaluation, follows its job and reads the results again when it ends', async () => {
    let job = jobView();
    const app = startApp({
      me: adminMe(),
      path: `/admin/accreditation/${PERIOD_ID}`,
      routes: routes({
        extra: {
          'POST accreditation/periods/:id/evaluate': () => ({ jobId: JOB_ID, existing: false }),
          'GET jobs/:id': () => job,
        },
      }),
    });
    const button = await screen.findByRole('button', { name: 'Hitung ulang' }, FIRST);
    await screen.findByText('terjawab 40/42');
    const resultsPath = `accreditation/periods/${PERIOD_ID}/results`;
    const before = app.requests.filter((r) => r.method === 'GET' && r.path === resultsPath).length;
    fireEvent.click(button);
    await waitFor(() => expect(app.writes()).toEqual([`POST accreditation/periods/${PERIOD_ID}/evaluate`]));
    await waitFor(() => expect(app.requests.some((r) => r.path === `jobs/${JOB_ID}`)).toBe(true));
    job = jobView({ status: 'succeeded', progress: 100, finishedAt: T0 + 1_000 });
    await app.queryClient.invalidateQueries({ queryKey: ['jobs', JOB_ID] });
    await waitFor(() => expect(app.requests.filter((r) => r.method === 'GET' && r.path === resultsPath).length).toBeGreaterThan(before));
  });

  it('opens the tab named in the search param, and a tab moves the address', async () => {
    const app = startApp({ me: adminMe(), path: `/admin/accreditation/${PERIOD_ID}?tab=riwayat`, routes: routes() });
    const history = await screen.findByRole('tab', { name: 'Riwayat' }, FIRST);
    expect(history.getAttribute('aria-selected')).toBe('true');
    expect(screen.getAllByRole('tab').map((tab) => tab.textContent)).toEqual([
      'Ringkasan',
      'Indikator',
      'Profil',
      'Populasi & Sarana',
      'Register',
      'Penggunaan Bulanan',
      'Kepatuhan SNP',
      'Cetak',
      'Riwayat',
    ]);
    fireEvent.mouseDown(screen.getByRole('tab', { name: 'Indikator' }));
    await waitFor(() => expect(app.router.state.location.search).toEqual({ tab: 'indikator' }));
    expect(app.router.state.location.pathname).toBe(`/admin/accreditation/${PERIOD_ID}`);
  });

  it('the bare workspace opens the latest period; the picker moves to another one', async () => {
    const latest = periodView();
    const older = periodView({ id: OTHER_PERIOD_ID, name: 'Akreditasi 2025', startsOn: '2024-07-01', endsOn: '2025-06-30', status: 'frozen' });
    const app = startApp({ me: adminMe(), path: '/admin/accreditation', routes: routes({ periods: [latest, older] }) });
    const picker = (await screen.findByRole('combobox', { name: 'Periode' }, FIRST)) as HTMLSelectElement;
    expect(picker.value).toBe(PERIOD_ID);
    expect(within(picker).getAllByRole('option').map((o) => o.textContent)).toEqual([
      expect.stringContaining('Akreditasi 2026'),
      expect.stringMatching(/Akreditasi 2025.*dibekukan/),
    ]);
    fireEvent.change(picker, { target: { value: OTHER_PERIOD_ID } });
    await waitFor(() => expect(app.router.state.location.pathname).toBe(`/admin/accreditation/${OTHER_PERIOD_ID}`));
  });

  it('without a period it offers to make the first one', async () => {
    startApp({ me: adminMe(), path: '/admin/accreditation', routes: routes({ periods: [] }) });
    expect(await screen.findByText('Belum ada periode akreditasi', undefined, FIRST)).toBeTruthy();
    expect(screen.getByRole('link', { name: 'Periode baru' }).getAttribute('href')).toBe('/admin/accreditation/new');
  });

  it('a reader without the manage permission is not offered a new period', async () => {
    startApp({ me: signedIn({ permissions: ['accreditation.workspace.read'] }), path: `/admin/accreditation/${PERIOD_ID}`, routes: routes() });
    await screen.findByText(/Kepka Perpusnas 159\/2025/, undefined, FIRST);
    expect(screen.queryByRole('link', { name: 'Periode baru' })).toBeNull();
    expect(screen.getByRole('button', { name: 'Hitung ulang' })).toBeTruthy();
  });

  it('an unknown period says so', async () => {
    startApp({ me: adminMe(), path: `/admin/accreditation/${OTHER_PERIOD_ID}`, routes: routes() });
    expect(await screen.findByText('Periode akreditasi ini tidak ada atau sudah diarsipkan.', undefined, FIRST)).toBeTruthy();
  });
});

describe('the accreditation events', () => {
  const event = (o: Partial<EventItem>): EventItem => ({ seq: 1, channel: 'accreditation', type: 'accreditation.results.changed', payload: { periodId: PERIOD_ID }, at: T0, ...o });

  it('new results of a period make its queries stale (the period, its results, the list)', () => {
    expect(accreditationEventKeys(event({}))).toEqual([accreditationKeys.periods()]);
    expect(accreditationKeys.results(PERIOD_ID).slice(0, 2)).toEqual(accreditationKeys.periods());
    expect(accreditationKeys.period(PERIOD_ID).slice(0, 2)).toEqual(accreditationKeys.periods());
  });

  it('any other event, or one without a period, changes nothing', () => {
    expect(accreditationEventKeys(event({ type: 'catalog.record.changed', channel: 'catalog' }))).toEqual([]);
    expect(accreditationEventKeys(event({ payload: {} }))).toEqual([]);
  });
});
