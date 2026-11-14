import { ACCRED_GROUPS, USAGE_METRICS, type UsageMetric } from '@altis/shared';
import type {
  AccreditationConfigView,
  EvidenceListResponse,
  InstrumentView,
  InstrumentsResponse,
  PeriodView,
  ResultsView,
  UsageGridView,
} from '@altis/shared/api/accreditation';
import type { MeResponse } from '@altis/shared/api/auth';
import type { JobView } from '@altis/shared/api/jobs';
import type { ReportRunView } from '@altis/shared/api/reports';
import { QueryClient, QueryClientProvider } from '@tanstack/react-query';
import { RouterProvider, createMemoryHistory, createRootRoute, createRouter } from '@tanstack/react-router';
import { fireEvent, render, screen } from '@testing-library/react';
import type { JSX } from 'react';
import { vi } from 'vitest';
import { ReauthDialog } from '@/components/reauth-dialog';
import { ADMIN_MESSAGES, I18nProvider } from '@/i18n';
import { ME_KEY } from '@/lib/me';
import { USER_ANI, adminMe, json, problem, type FakeHandler, type FakeRequest } from '../fake-api';

// The fake accreditation API of the Penggunaan Bulanan, Kepatuhan SNP and Cetak tabs: a period of three months, its
// usage grid, the member-type mapping, the instruments with their settings block, the results, the evidence sizes
// and report runs, and a harness that renders one tab (with the reauth dialog beside it, as the shell mounts it)
// against a table of `METHOD path` handlers (`:name` matches one segment; the query is in `req.query`).

export const PERIOD_ID = '01JZ0000000000000000PRDU01';
export const RUN_ID = '01JZ0000000000000000RUNU01';
export const JOB_ID = '01JZ0000000000000000JOBU01';
export const UPLOAD_ID = '01JZ0000000000000000UPLU01';
/** A fixed instant (2025-10-09). */
export const T0 = 1_760_000_000_000;
export const FIRST = { timeout: 10_000 };
export const ADMIN_ID = ADMIN_MESSAGES.id;

export function periodView(o: Partial<PeriodView> = {}): PeriodView {
  return {
    id: PERIOD_ID,
    name: 'Tahun pelajaran 2025/2026',
    instrumentId: 'sch-sd-2025',
    kind: 'custom',
    startsOn: '2026-01-01',
    endsOn: '2026-03-31',
    branchId: null,
    profile: {},
    students: 300,
    teachers: 20,
    eduStaff: 5,
    classes: 12,
    populationServed: null,
    teachersUsing: null,
    allRegisteredConfirmed: true,
    userPcs: null,
    staffPcs: null,
    ictDevices: null,
    scanners: null,
    floorM2: null,
    bandwidthMbps: null,
    hoursPerWeek: null,
    services: null,
    externalWebsiteUrl: null,
    status: 'open',
    frozenAt: null,
    frozenBy: null,
    version: 3,
    createdAt: T0,
    updatedAt: T0,
    lastChangeAt: T0,
    computedAt: null,
    stale: true,
    catalogSyncedAt: null,
    lastUsageImport: null,
    ...o,
  };
}

export function configView(o: Partial<AccreditationConfigView> = {}): AccreditationConfigView {
  return {
    libraryType: 'sekolah',
    schoolYearStartMonth: 7,
    usedUnit: 'titles',
    evidenceMaxMb: 5,
    componentLimitMb: 9,
    liveFrom: '2026-02-01',
    unknownMemberGroupDefault: 'student',
    dedupeMinutes: 60,
    dedupeLegacy: true,
    ...o,
  };
}

export function instrument(o: Partial<InstrumentView> = {}): InstrumentView {
  return {
    id: 'sch-sd-2025',
    decree: 'Kepka Perpusnas 157/2025',
    effectiveFrom: '2026-01-02',
    sourceStatus: 'P-copy',
    libraryTypes: ['sekolah'],
    schoolLevels: ['sd_mi'],
    periodKinds: ['school_year', 'custom'],
    defaultPeriodKind: 'school_year',
    scored: true,
    components: [],
    snp: [],
    ...o,
  };
}

export function instrumentsAnswer(o: { config?: Partial<AccreditationConfigView>; instruments?: InstrumentView[] } = {}): InstrumentsResponse {
  return { instruments: o.instruments ?? [instrument()], config: configView(o.config) };
}

/** The monthly metrics of the grid and its metrics of the whole period. */
const MONTHLY: readonly UsageMetric[] = ['visits', 'visits_deduped', 'visits_online', 'loans', 'in_library_uses', 'distinct_visitors', 'distinct_borrowers'];
const SPAN: readonly UsageMetric[] = ['titles_used', 'items_used', 'distinct_visitors', 'distinct_borrowers', 'members_active'];

type GridCell = UsageGridView['cells'][number];

/**
 * A grid of January to March 2026: every cell without data, except those of `set` (`metric|month|groupKey`, month
 * `''` for the whole period).
 */
export function usageGrid(set: Record<string, Partial<GridCell>> = {}, o: Partial<UsageGridView> = {}): UsageGridView {
  const months = ['2026-01', '2026-02', '2026-03'];
  const groups: UsageGridView['groups'] = [
    { key: '', label: null, accredGroup: null },
    ...ACCRED_GROUPS.map((g) => ({ key: `grp:${g}`, label: null, accredGroup: g })),
    { key: 'guest', label: null, accredGroup: 'guest' },
  ];
  const cells: GridCell[] = [];
  const cell = (metric: UsageMetric, month: string | null, groupKey: string): GridCell => ({
    metric,
    month,
    groupKey,
    value: null,
    source: 'none',
    spanTo: month === null ? '2026-03-31' : null,
    ...set[`${metric}|${month ?? ''}|${groupKey}`],
  });
  for (const metric of USAGE_METRICS) {
    if (MONTHLY.includes(metric)) for (const month of months) for (const g of groups) cells.push(cell(metric, month, g.key));
    if (SPAN.includes(metric)) for (const g of groups) cells.push(cell(metric, null, g.key));
  }
  return { months, metrics: [...USAGE_METRICS], groups, cells, lastImport: null, ...o };
}

export function results(o: Partial<ResultsView> = {}): ResultsView {
  return {
    status: 'ready',
    computedAt: T0,
    changedAt: T0 - 1000,
    stale: false,
    jobId: null,
    prerequisites: null,
    indicators: [],
    snp: [],
    score: null,
    missingEvidence: [],
    ...o,
  };
}

export function evidenceAnswer(bytes: Partial<EvidenceListResponse['componentBytes']> = {}): EvidenceListResponse {
  return { evidence: [], componentBytes: { K: 0, SP: 0, L: 0, T: 0, F: 0, G: 0, profil: 0, ...bytes } };
}

export function job(o: Partial<JobView> = {}): JobView {
  return {
    id: JOB_ID,
    type: 'reports.export',
    status: 'succeeded',
    progress: 100,
    progressMessage: null,
    attempts: 1,
    maxAttempts: 3,
    lastError: null,
    runAt: T0,
    createdAt: T0,
    updatedAt: T0 + 60_000,
    finishedAt: T0 + 60_000,
    createdBy: USER_ANI.id,
    retryable: 'origin-only',
    cancellable: false,
    interactive: true,
    ...o,
  };
}

export function reportRun(o: Partial<ReportRunView> = {}): ReportRunView {
  return {
    id: RUN_ID,
    reportId: 'accreditation.dossier',
    format: 'zip',
    locale: 'id',
    personal: true,
    status: 'succeeded',
    rowCount: null,
    nonLatinRows: null,
    outputSize: 12_000_000,
    errorCode: null,
    jobId: JOB_ID,
    expiresAt: Date.now() + 86_400_000,
    createdAt: T0,
    createdBy: USER_ANI.id,
    finishedAt: T0 + 60_000,
    params: { periodId: PERIOD_ID, part: 'all', zipMode: 'combined' },
    paper: null,
    warnings: [],
    mine: true,
    downloadable: true,
    ...o,
  };
}

/** A fake `/api/v1`: `GET auth/me` answers `me`; `POST auth/reauth` confirms the password; unknown routes answer 404. */
export function stubApi(me: MeResponse, routes: Record<string, FakeHandler>) {
  const requests: FakeRequest[] = [];
  const table: Record<string, FakeHandler> = {
    'GET auth/me': () => me,
    'POST auth/reauth': () => ({ reauthUntil: Date.now() + 300_000 }),
    ...routes,
  };
  vi.stubGlobal(
    'fetch',
    vi.fn<typeof fetch>(async (input, init) => {
      const url = new URL(String(input), 'https://altis.test');
      const method = init?.method ?? 'GET';
      const path = url.pathname.replace(/^\/api\/v1\//, '');
      const body = typeof init?.body === 'string' ? (JSON.parse(init.body) as unknown) : undefined;
      for (const [key, handler] of Object.entries(table)) {
        const [m, pattern] = key.split(' ') as [string, string];
        const want = pattern.split('/');
        const got = path.split('/');
        if (m !== method || want.length !== got.length) continue;
        const params: Record<string, string> = {};
        if (!want.every((w, i) => (w.startsWith(':') ? ((params[w.slice(1)] = decodeURIComponent(got[i]!)), true) : w === got[i]))) continue;
        const req: FakeRequest = { method, path, params, query: url.searchParams, body };
        requests.push(req);
        const answer = await handler(req);
        return answer instanceof Response ? answer : answer === undefined ? new Response(null, { status: 204 }) : json(answer);
      }
      requests.push({ method, path, params: {}, query: url.searchParams, body });
      return problem(404, 'NOT_FOUND');
    }),
  );
  /** The requests other than `GET`, as `METHOD path`, in order. */
  const writes = (): string[] => requests.filter((r) => r.method !== 'GET').map((r) => `${r.method} ${r.path}`);
  const to = (route: string): FakeRequest[] => requests.filter((r) => `${r.method} ${r.path}` === route);
  return { requests, writes, to };
}

/** Renders `Tab` of the period for `me` inside a router, with the reauth dialog the shell mounts beside every screen. */
export function renderTab(Tab: (props: { periodId: string }) => JSX.Element, routes: Record<string, FakeHandler>, o: { me?: MeResponse } = {}) {
  const me = o.me ?? adminMe();
  const api = stubApi(me, routes);
  const queryClient = new QueryClient({ defaultOptions: { queries: { retry: false }, mutations: { retry: false } } });
  queryClient.setQueryData(ME_KEY, me);
  const root = createRootRoute({
    component: () => (
      <I18nProvider locale="id">
        <Tab periodId={PERIOD_ID} />
        <ReauthDialog />
      </I18nProvider>
    ),
  });
  const router = createRouter({ routeTree: root, history: createMemoryHistory({ initialEntries: ['/'] }) });
  render(
    <QueryClientProvider client={queryClient}>
      <RouterProvider router={router} />
    </QueryClientProvider>,
  );
  return { ...api, queryClient };
}

/** Confirms the password in the open reauth dialog. */
export async function confirmPassword(): Promise<void> {
  const dialog = await screen.findByRole('dialog', { name: ADMIN_ID['reauth.title'] }, FIRST);
  const input = dialog.querySelector('input[type="password"]') as HTMLInputElement;
  fireEvent.change(input, { target: { value: 'sandi-staf' } });
  fireEvent.click(screen.getByRole('button', { name: ADMIN_ID['reauth.submit'] }));
}
