import { ACQ_SOURCES, ITEM_STATUSES, type Permission } from '@altis/shared';
import type { BranchListResponse } from '@altis/shared/api/branches';
import { EMPTY_TEMPLATE, type CollectionTypeView, type LanguageView, type MasterListResponse, type MaterialTypeView } from '@altis/shared/api/catalog/masters';
import type { LocationListResponse, LocationView } from '@altis/shared/api/catalog/locations';
import type { PeriodListResponse } from '@altis/shared/api/accreditation';
import type { JobView } from '@altis/shared/api/jobs';
import type {
  ReportCatalogEntry,
  ReportCatalogResponse,
  ReportColumnView,
  ReportParamSpec,
  ReportRunListResponse,
  ReportRunView,
} from '@altis/shared/api/reports';
import type { MeResponse } from '@altis/shared/api/auth';
import { BRANCH_MAIN, BRANCH_NORTH, type FakeHandler } from '../fake-api';

// The fake server of the Laporan screen tests: catalogue entries shaped as the server lists them, the option lists the
// filter form reads, runs and jobs. The catalogue answers like the server: only the definitions whose permission the
// signed-in user holds.

/** An hour ago. */
export const AT = Date.now() - 3_600_000;
export const FIRST = { timeout: 10_000 };

export const PERIOD_ID = '01JZ0000000000000000PE0001';
export const LOCATION_ID = '01JZ0000000000000000LC0001';
export const SHELF_ID = '01JZ0000000000000000LC0002';
export const COLLECTION_TYPE_ID = '01JZ0000000000000000CT0001';
export const MATERIAL_TYPE_ID = '01JZ0000000000000000MT0001';
export const LANGUAGE_ID = '01JZ0000000000000000LG0001';

const param = (name: string, kind: ReportParamSpec['kind'], o: Partial<ReportParamSpec> = {}): ReportParamSpec => ({
  name,
  kind,
  labelKey: `report.param.${name}`,
  required: false,
  ...o,
});

const col = (key: string, type: ReportColumnView['type']): ReportColumnView => ({ key, labelKey: `report.column.${key}`, type });

function entry(o: Partial<ReportCatalogEntry> & Pick<ReportCatalogEntry, 'id' | 'module'>): ReportCatalogEntry {
  return {
    kind: 'table',
    titleKey: `report.${o.id}.title`,
    personal: false,
    canExport: true,
    formats: ['csv', 'xlsx', 'pdf'],
    orientation: 'portrait',
    params: [],
    columns: [],
    ...o,
  };
}

export const SUMMARY = entry({
  id: 'collection.summary',
  module: 'collection',
  params: [param('branchId', 'branch'), param('asOf', 'asOf')],
  columns: [col('section', 'text'), col('item', 'text'), col('titles', 'int'), col('items', 'int')],
});

export const ACQUISITIONS = entry({
  id: 'collection.acquisitions',
  module: 'collection',
  orientation: 'landscape',
  params: [param('yearFrom', 'year', { min: 1900, max: 2100 }), param('yearTo', 'year', { min: 1900, max: 2100 })],
  columns: null,
});

/** A definition with a parameter of every kind the form knows, none required. */
export const EVERY_KIND = entry({
  id: 'collection.item_list',
  module: 'collection',
  orientation: 'landscape',
  params: [
    param('received', 'dateRange'),
    param('asOf', 'asOf'),
    param('yearFrom', 'year', { min: 1900, max: 2100 }),
    param('periodId', 'period'),
    param('branchId', 'branch'),
    param('locationId', 'location'),
    param('collectionTypeId', 'collectionType'),
    param('materialTypeId', 'materialType'),
    param('languageId', 'language'),
    param('classPrefix', 'classPrefix'),
    param('texts', 'text'),
    param('status', 'status', { multiple: true, options: [...ITEM_STATUSES], optionLabelPrefix: 'vocab.item_status.' }),
    param('acqSource', 'status', { options: [...ACQ_SOURCES], optionLabelPrefix: 'vocab.acq_source.' }),
    param('fictionOnly', 'bool'),
    param('rows', 'int', { min: 0, max: 200_000 }),
  ],
  columns: [col('barcode', 'text'), col('title', 'text')],
});

/** `test.rows`: `rows` (required), `texts` (lines), `countless`; columns n, text, amount. */
export const TEST_ROWS = entry({
  id: 'test.rows',
  module: 'collection',
  titleKey: 'report.test.rows.title',
  params: [param('rows', 'int', { required: true, min: 0, max: 200_000 }), param('texts', 'text', { multiple: true }), param('countless', 'bool')],
  columns: [col('n', 'int'), col('text', 'text'), col('amount', 'money')],
});

/** `test.personal`: a personal table report. */
export const TEST_PERSONAL = entry({
  id: 'test.personal',
  module: 'collection',
  titleKey: 'report.test.personal.title',
  personal: true,
  columns: [col('name', 'text')],
});

export const ANNEX_STAFF = entry({
  id: 'accreditation.annex.staff',
  module: 'accreditation',
  personal: true,
  orientation: 'landscape',
  params: [param('periodId', 'period', { required: true }), param('section', 'status', { options: ['staff', 'trainings', 'ratio'] })],
  columns: null,
});

export const DOSSIER = entry({
  id: 'accreditation.dossier',
  module: 'accreditation',
  kind: 'document',
  personal: true,
  canExport: false,
  formats: ['pdf', 'zip'],
  params: [param('periodId', 'period', { required: true })],
  columns: null,
});

/** Every definition of these tests, with the permission that lists it. */
const DEFINITIONS: readonly [ReportCatalogEntry, Permission][] = [
  [SUMMARY, 'reports.statistics.read'],
  [ACQUISITIONS, 'reports.statistics.read'],
  [EVERY_KIND, 'reports.statistics.read'],
  [TEST_ROWS, 'reports.statistics.read'],
  [TEST_PERSONAL, 'reports.statistics.read'],
  [ANNEX_STAFF, 'accreditation.workspace.read'],
  [DOSSIER, 'accreditation.workspace.read'],
];

/** `GET reports/catalog` for `me`: the definitions whose permission they hold. */
export function catalogFor(me: MeResponse): ReportCatalogResponse {
  const held = me.authenticated ? new Set<string>(me.permissions) : new Set<string>();
  return { reports: DEFINITIONS.filter(([, p]) => held.has(p)).map(([e]) => e) };
}

/** A run of `reportId` as `GET reports/runs` lists it. */
export function run(o: Partial<ReportRunView> & Pick<ReportRunView, 'id' | 'reportId'>): ReportRunView {
  return {
    format: 'csv',
    locale: 'id',
    personal: false,
    status: 'succeeded',
    rowCount: 3,
    nonLatinRows: 0,
    outputSize: 120,
    errorCode: null,
    jobId: null,
    expiresAt: Date.now() + 7 * 86_400_000,
    createdAt: AT,
    createdBy: null,
    finishedAt: AT + 60_000,
    params: {},
    paper: null,
    warnings: [],
    mine: true,
    downloadable: true,
    ...o,
  };
}

/** A job of the export (`reports.export`), ended unless `o` says otherwise. */
export function job(id: string, o: Partial<JobView> = {}): JobView {
  return {
    id,
    type: 'reports.export',
    status: 'succeeded',
    progress: 100,
    progressMessage: null,
    attempts: 1,
    maxAttempts: 3,
    lastError: null,
    runAt: AT,
    createdAt: AT,
    updatedAt: AT + 60_000,
    finishedAt: AT + 60_000,
    createdBy: null,
    retryable: 'api',
    cancellable: false,
    interactive: true,
    ...o,
  };
}

const location = (o: Partial<LocationView> & Pick<LocationView, 'id' | 'code' | 'name'>): LocationView => ({
  branchId: BRANCH_MAIN.id,
  parentId: null,
  kind: 'room',
  shelfHint: null,
  classFrom: null,
  classTo: null,
  mapFileId: null,
  box: null,
  isPublic: true,
  sortOrder: 0,
  itemCount: 0,
  archived: false,
  version: 1,
  ...o,
});

const master = { usage: 0, archived: false, version: 1 };

/** The option lists of the filter form. */
export function optionRoutes(): Record<string, FakeHandler> {
  const branches: BranchListResponse = { items: [BRANCH_MAIN, BRANCH_NORTH].map((b) => ({ ...b, active: true })) };
  const locations: LocationListResponse = {
    items: [
      location({ id: LOCATION_ID, code: 'R1', name: 'Ruang baca' }),
      location({ id: SHELF_ID, code: 'RAK-A', name: 'Rak A', kind: 'shelf', parentId: LOCATION_ID }),
    ],
  };
  const collectionTypes: MasterListResponse<CollectionTypeView> = {
    items: [{ id: COLLECTION_TYPE_ID, code: 'REF', nameId: 'Referensi', nameEn: 'Reference', loanable: false, selfService: false, sortOrder: 1, ...master }],
  };
  const materialTypes: MasterListResponse<MaterialTypeView> = {
    items: [
      {
        id: MATERIAL_TYPE_ID,
        code: 'BUKU',
        nameId: 'Buku',
        nameEn: 'Book',
        marcType: 'a',
        marcLevel: 'm',
        contentType: 'txt',
        mediaType: 'n',
        carrierType: 'nc',
        schemaType: 'Book',
        dcmiType: 'Text',
        template: { ...EMPTY_TEMPLATE },
        sortOrder: 1,
        ...master,
      },
    ],
  };
  const languages: MasterListResponse<LanguageView> = { items: [{ id: LANGUAGE_ID, code: 'ind', nameId: 'Indonesia', nameEn: 'Indonesian', ...master }] };
  const periods: PeriodListResponse = {
    periods: [
      {
        id: PERIOD_ID,
        name: 'Tahun ajaran 2025/2026',
        instrumentId: 'sch-sma-2025',
        kind: 'school_year',
        startsOn: '2025-07-01',
        endsOn: '2026-06-30',
        status: 'open',
        computedAt: null,
        stale: false,
      },
    ],
  };
  return {
    'GET branches': () => branches,
    'GET catalog/locations': () => locations,
    'GET catalog/collection-types': () => collectionTypes,
    'GET catalog/material-types': () => materialTypes,
    'GET catalog/languages': () => languages,
    'GET accreditation/periods': () => periods,
  };
}

/** The routes every Laporan screen reads: the catalogue for `me`, the option lists, and `runs` as the run list. */
export function reportRoutes(me: MeResponse, runs: ReportRunView[] = []): Record<string, FakeHandler> {
  const list: ReportRunListResponse = { runs, nextCursor: null };
  return {
    'GET reports/catalog': () => catalogFor(me),
    'GET reports/runs': (req) => ({ ...list, runs: list.runs.filter((r) => r.reportId === req.query.get('reportId')) }),
    ...optionRoutes(),
  };
}
