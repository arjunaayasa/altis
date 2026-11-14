import type { SlimsUsageStartBody, SlimsUsageTestResponse, UsageGroupsView } from '@altis/shared/api/accreditation';
import type { RunView } from '@altis/shared/api/catalog/runs';
import { fireEvent, screen, waitFor, within } from '@testing-library/react';
import { afterEach, describe, expect, it, vi } from 'vitest';
import { UsageTab } from '@/screens/accreditation/tabs/usage';
import { USER_ANI, type FakeHandler, type FakeRequest } from '../fake-api';
import {
  ADMIN_ID,
  FIRST,
  JOB_ID,
  PERIOD_ID,
  RUN_ID,
  T0,
  UPLOAD_ID,
  confirmPassword,
  instrumentsAnswer,
  job,
  periodView,
  renderTab,
  usageGrid,
} from './usage-print-fixtures';

// "Impor dari SLiMS" (spec §10.7, §11.2): a wizard of its own, never the catalogue migration's. The source is a SLiMS
// database (checked before anything is sent, then tested through the accreditation route, which lists the member
// types with a guessed group the user may change) or a SQL dump uploaded in its own upload context. The cut-over date
// starts from what the server knows; the start waits for the password confirmation; the progress and the summary end
// with the note that SLiMS keeps one visitor log for the desk and the guest book. For a dump the member types are only
// known after the run, so the mapping comes then.

afterEach(() => {
  vi.unstubAllGlobals();
  vi.restoreAllMocks();
});

const START = `POST accreditation/periods/${PERIOD_ID}/slims-usage`;
const TEST = 'POST accreditation/slims-usage/test-connection';
const NOTE = /SLiMS tidak membedakan kunjungan dari meja dan dari buku tamu/;

const TESTED: SlimsUsageTestResponse = {
  ok: true,
  tables: [
    { name: 'visitor_count', rows: 5400 },
    { name: 'loan', rows: 1200 },
    { name: 'read_counter', rows: null },
  ],
  memberTypes: [
    { id: '1', name: 'Siswa', guess: 'student' },
    { id: '2', name: 'Guru', guess: 'teacher' },
    { id: '3', name: 'Alumni', guess: 'public' },
  ],
  months: { first: '2019-07', last: '2026-05' },
};

function usageRun(o: Partial<RunView> = {}): RunView {
  return {
    id: RUN_ID,
    kind: 'slims_usage',
    status: 'succeeded',
    dryRun: false,
    format: null,
    options: { sourceKind: 'db', periodId: PERIOD_ID, cutoverOn: '2026-03-01', dedupeMinutes: 60 },
    summary: {
      status: 'succeeded',
      phase: 'report',
      failure: null,
      sourceKind: 'db',
      cutoverOn: '2026-03-01',
      dedupeMinutes: 60,
      rows: { visitor_count: 5400, loan: 1200 },
      dropped: { dateInvalid: {}, afterCutover: {}, loanSeenBefore: 0 },
      firstMonth: '2019-07',
      lastMonth: '2026-02',
      totals: { visits: 5400, visitsDeduped: 5100, loans: 1200, inLibraryUses: 0 },
      memberUnknown: { visits: 30, loans: 4 },
      written: { months: 80, rows: 2400 },
    },
    reportFileId: '01JZ0000000000000000RPTU01',
    outputName: null,
    outputSize: null,
    expiresAt: null,
    jobId: JOB_ID,
    jobStatus: 'succeeded',
    createdAt: T0,
    createdBy: USER_ANI.id,
    finishedAt: T0 + 60_000,
    ...o,
  };
}

const GROUPS: UsageGroupsView = {
  groups: [
    { groupKey: 'slims_type:1', label: 'Siswa', accredGroup: 'student', updatedAt: T0 },
    { groupKey: 'slims_type:2', label: 'Guru', accredGroup: 'teacher', updatedAt: T0 },
  ],
};

function routes(o: { run?: RunView; extra?: Record<string, FakeHandler> } = {}): Record<string, FakeHandler> {
  return {
    'GET accreditation/periods/:id': () => periodView(),
    'GET accreditation/periods/:id/usage': () => usageGrid(),
    'GET accreditation/usage-groups': () => GROUPS,
    'PUT accreditation/usage-groups': () => ({ count: 1 }),
    'GET accreditation/instruments': () => instrumentsAnswer(),
    'POST accreditation/slims-usage/test-connection': () => TESTED,
    'POST accreditation/periods/:id/slims-usage': () => new Response(JSON.stringify({ runId: RUN_ID, jobId: JOB_ID }), { status: 201, headers: { 'Content-Type': 'application/json', 'X-Altis-Build': '0.1.0' } }),
    'GET jobs/:id': () => job({ type: 'accreditation.import_slims_usage' }),
    'GET catalog/runs/:id': () => o.run ?? usageRun(),
    'POST files/uploads': () => ({ id: UPLOAD_ID, chunkSize: 256 * 1024, chunks: 1, expiresAt: T0 + 86_400_000 }),
    'POST files/uploads/:id/chunks/:n': () => ({ received: 10, complete: true }),
    'POST files/uploads/:id/complete': (req: FakeRequest) => ({ uploadId: req.params['id'], size: 10, sha256: 'a'.repeat(64), mime: 'text/plain' }),
    ...o.extra,
  };
}

const text = (label: string, value: string): void => {
  fireEvent.change(screen.getByLabelText(label), { target: { value } });
};

async function openWizard(): Promise<HTMLElement> {
  fireEvent.click(await screen.findByRole('button', { name: ADMIN_ID['accreditation.usage.import_open'] }, FIRST));
  return screen.getByRole('region', { name: ADMIN_ID['accreditation.usage.wizard.title'] });
}

function fillDb(): void {
  fireEvent.click(screen.getByLabelText(ADMIN_ID['accreditation.usage.source.kind_db']));
  text(ADMIN_ID['catalog.migration.db.host'], 'localhost');
  text(ADMIN_ID['catalog.migration.db.port'], '3306');
  text(ADMIN_ID['catalog.migration.db.user'], 'slims');
  text(ADMIN_ID['catalog.migration.db.password'], 'rahasia');
  text(ADMIN_ID['catalog.migration.db.database'], 'slims9');
}

describe('Impor dari SLiMS: a database', () => {
  it('the test posts {db} to the accreditation route, never the catalogue migration one, and lists the member types with guesses', async () => {
    const api = renderTab(UsageTab, routes());
    await openWizard();
    fillDb();
    fireEvent.click(screen.getByRole('button', { name: ADMIN_ID['catalog.migration.db.test'] }));
    await waitFor(() => expect(api.to(TEST)).toHaveLength(1));
    expect(api.to(TEST)[0]!.body).toEqual({ db: { host: 'localhost', port: 3306, user: 'slims', password: 'rahasia', database: 'slims9', tls: false } });
    expect(api.requests.filter((r) => r.path.startsWith('catalog/migrations'))).toEqual([]);
    expect(await screen.findByText('Data penggunaan dari 2019-07 sampai 2026-05.')).toBeTruthy();
    const tables = screen.getByRole('table', { name: ADMIN_ID['accreditation.usage.test.tables'] });
    expect(within(tables).getByText('visitor_count')).toBeTruthy();
    expect(within(tables).getByText(ADMIN_ID['catalog.migration.db.rows_unknown'])).toBeTruthy();

    fireEvent.click(screen.getByRole('button', { name: ADMIN_ID['accreditation.usage.next'] }));
    expect((screen.getByRole('combobox', { name: 'Kelompok untuk Siswa' }) as HTMLSelectElement).value).toBe('student');
    expect((screen.getByRole('combobox', { name: 'Kelompok untuk Guru' }) as HTMLSelectElement).value).toBe('teacher');
    expect((screen.getByRole('combobox', { name: 'Kelompok untuk Alumni' }) as HTMLSelectElement).value).toBe('public');
  });

  it('a field that is not right is shown before anything is sent, and a refused test says why', async () => {
    const api = renderTab(
      UsageTab,
      routes({ extra: { [TEST]: () => ({ ok: false, code: 'MIGRATION_SOURCE_UNREACHABLE', reason: 'ECONNREFUSED' }) } }),
    );
    await openWizard();
    fireEvent.click(screen.getByLabelText(ADMIN_ID['accreditation.usage.source.kind_db']));
    text(ADMIN_ID['catalog.migration.db.port'], '99999');
    fireEvent.click(screen.getByRole('button', { name: ADMIN_ID['catalog.migration.db.test'] }));
    expect((await screen.findAllByText(ADMIN_ID['form.error.required'])).length).toBeGreaterThan(0);
    expect(api.to(TEST)).toEqual([]);

    fillDb();
    fireEvent.click(screen.getByRole('button', { name: ADMIN_ID['catalog.migration.db.test'] }));
    expect(await screen.findByText(/ECONNREFUSED/)).toBeTruthy();
    fireEvent.click(screen.getByRole('button', { name: ADMIN_ID['accreditation.usage.next'] }));
    expect(screen.getByText(ADMIN_ID['accreditation.usage.test.required'])).toBeTruthy();
  });

  it('the start waits for the password, then holds the edited types, the deleted-members group and the cut-over date', async () => {
    const api = renderTab(UsageTab, routes());
    await openWizard();
    fillDb();
    fireEvent.click(screen.getByRole('button', { name: ADMIN_ID['catalog.migration.db.test'] }));
    await screen.findByText('Data penggunaan dari 2019-07 sampai 2026-05.');
    fireEvent.click(screen.getByRole('button', { name: ADMIN_ID['accreditation.usage.next'] }));

    fireEvent.change(screen.getByRole('combobox', { name: 'Kelompok untuk Alumni' }), { target: { value: 'other' } });
    const cutover = screen.getByLabelText(ADMIN_ID['accreditation.usage.cutover']) as HTMLInputElement;
    // The default comes from the server: the accreditation settings' live date (no earlier import).
    expect(cutover.value).toBe('2026-02-01');
    fireEvent.change(cutover, { target: { value: '2026-03-01' } });
    const unknown = screen.getByRole('combobox', { name: ADMIN_ID['accreditation.usage.unknown_group'] }) as HTMLSelectElement;
    expect(unknown.value).toBe('student');
    fireEvent.change(unknown, { target: { value: 'public' } });

    fireEvent.click(screen.getByRole('button', { name: ADMIN_ID['accreditation.usage.start'] }));
    expect(await screen.findByRole('dialog', { name: ADMIN_ID['reauth.title'] }, FIRST)).toBeTruthy();
    expect(api.to(START)).toEqual([]);
    await confirmPassword();

    await waitFor(() => expect(api.to(START)).toHaveLength(1));
    const writes = api.writes();
    expect(writes.indexOf('POST auth/reauth')).toBeGreaterThanOrEqual(0);
    expect(writes.indexOf('POST auth/reauth')).toBeLessThan(writes.indexOf(START));
    const body = api.to(START)[0]!.body as SlimsUsageStartBody;
    expect(body).toEqual({
      source: { kind: 'db', db: { host: 'localhost', port: 3306, user: 'slims', password: 'rahasia', database: 'slims9', tls: false } },
      cutoverOn: '2026-03-01',
      memberTypeGroups: { '1': 'student', '2': 'teacher', '3': 'other' },
      unknownMemberGroup: 'public',
    });

    // Progress, then the summary with its note.
    expect(await screen.findByText(NOTE, undefined, FIRST)).toBeTruthy();
    expect(screen.getByText('Bulan: 2019-07 sampai 2026-02')).toBeTruthy();
    expect(screen.getByText(/Dari anggota terhapus: 30 kunjungan dan 4 peminjaman/)).toBeTruthy();
    const report = screen.getByRole('link', { name: ADMIN_ID['accreditation.usage.summary.report'] });
    expect(report.getAttribute('href')).toBe(`/api/v1/catalog/runs/${RUN_ID}/report`);
  });

  it('a cancelled password confirmation starts nothing', async () => {
    const api = renderTab(UsageTab, routes());
    await openWizard();
    fillDb();
    fireEvent.click(screen.getByRole('button', { name: ADMIN_ID['catalog.migration.db.test'] }));
    await screen.findByText('Data penggunaan dari 2019-07 sampai 2026-05.');
    fireEvent.click(screen.getByRole('button', { name: ADMIN_ID['accreditation.usage.next'] }));
    fireEvent.click(screen.getByRole('button', { name: ADMIN_ID['accreditation.usage.start'] }));
    await screen.findByRole('dialog', { name: ADMIN_ID['reauth.title'] }, FIRST);
    fireEvent.click(screen.getByRole('button', { name: ADMIN_ID['reauth.cancel'] }));
    expect(await screen.findByText(ADMIN_ID['accreditation.usage.reauth_cancelled'])).toBeTruthy();
    expect(api.to(START)).toEqual([]);
  });
});

describe('Impor dari SLiMS: a dump', () => {
  it('uploads in accreditation.slims_dump after the password, starts without a mapping, and asks for the mapping after the run', async () => {
    const api = renderTab(UsageTab, routes({ run: usageRun({ options: { sourceKind: 'dump', periodId: PERIOD_ID, cutoverOn: null, dedupeMinutes: 60 } }) }));
    await openWizard();
    fireEvent.click(screen.getByLabelText(ADMIN_ID['accreditation.usage.source.kind_dump']));
    fireEvent.click(screen.getByRole('button', { name: ADMIN_ID['accreditation.usage.next'] }));
    expect(screen.getByText(ADMIN_ID['accreditation.usage.source.dump_required'])).toBeTruthy();

    const file = new File(['-- dump\n'], 'slims-backup.sql', { type: 'application/sql' });
    fireEvent.change(screen.getByLabelText(ADMIN_ID['catalog.migration.dump.file']), { target: { files: [file] } });
    fireEvent.click(screen.getByRole('button', { name: ADMIN_ID['accreditation.usage.next'] }));
    expect(screen.getByText(ADMIN_ID['accreditation.usage.types.dump_later'])).toBeTruthy();
    expect(screen.queryByRole('combobox', { name: /^Kelompok untuk Siswa/ })).toBeNull();
    fireEvent.change(screen.getByLabelText(ADMIN_ID['accreditation.usage.cutover']), { target: { value: '' } });

    fireEvent.click(screen.getByRole('button', { name: ADMIN_ID['accreditation.usage.start'] }));
    await screen.findByRole('dialog', { name: ADMIN_ID['reauth.title'] }, FIRST);
    expect(api.to('POST files/uploads')).toEqual([]);
    await confirmPassword();

    await waitFor(() => expect(api.to(START)).toHaveLength(1));
    expect(api.to('POST files/uploads')[0]!.body).toMatchObject({ context: 'accreditation.slims_dump' });
    expect(api.to(START)[0]!.body).toEqual({ source: { kind: 'dump', uploadId: UPLOAD_ID }, cutoverOn: null, unknownMemberGroup: 'student' });

    const wizard = screen.getByRole('region', { name: ADMIN_ID['accreditation.usage.wizard.title'] });
    expect(await within(wizard).findByText(NOTE, undefined, FIRST)).toBeTruthy();
    expect(within(wizard).getByRole('heading', { name: ADMIN_ID['accreditation.usage.summary.map_title'] })).toBeTruthy();
    fireEvent.change(await within(wizard).findByRole('combobox', { name: 'Kelompok untuk Guru' }), { target: { value: 'edu_staff' } });
    await waitFor(() => expect(api.to('PUT accreditation/usage-groups')).toHaveLength(1));
    expect(api.to('PUT accreditation/usage-groups')[0]!.body).toEqual({ groups: [{ groupKey: 'slims_type:2', accredGroup: 'edu_staff' }] });
  });
});
