import type {
  IndicatorEvidenceView,
  IndicatorResultView,
  IndicatorView,
  InstrumentView,
  InstrumentsResponse,
  PeriodListResponse,
  PeriodSummaryView,
  PeriodView,
  ResultsView,
  ScoreView,
} from '@altis/shared/api/accreditation';
import type { JobView } from '@altis/shared/api/jobs';

// The answers of a fake accreditation API for the workspace tests: three instruments (the primary school one, whose
// service items after the plagiarism item carry the decree's own lower numbers; the upper secondary one; the
// unscored statistics mode), a period, its results and a job.

export const PERIOD_ID = '01JZ0000000000000000PRD001';
export const OTHER_PERIOD_ID = '01JZ0000000000000000PRD002';
export const JOB_ID = '01JZ0000000000000000JBA001';
/** A fixed instant (2025-10-09). */
export const T0 = 1_760_000_000_000;

export function evidenceItem(code: string, ik: string, o: Partial<IndicatorEvidenceView> = {}): IndicatorEvidenceView {
  return { code, labelKey: `accred.evidence.${ik}.${code}`, kind: 'upload', primary: false, reportId: null, screen: null, ...o };
}

export function indicator(concept: string, officialNo: string, o: Partial<IndicatorView> = {}): IndicatorView {
  return { code: `SCH-${concept}`, officialNo, labelKey: `accred.ik.${concept}`, manual: false, window: 'snapshot', optionKeys: null, evidence: [], ...o };
}

const SCHOOL_KINDS: InstrumentView['periodKinds'] = ['school_year', 'rolling_12'];

/** The upper secondary instrument: a few indicators of three components. */
export function smaInstrument(): InstrumentView {
  return {
    id: 'sch-sma-2025',
    decree: 'Kepka Perpusnas 159/2025',
    effectiveFrom: '2026-01-02',
    sourceStatus: 'P-copy',
    libraryTypes: ['sekolah'],
    schoolLevels: ['sma_smk_ma'],
    periodKinds: SCHOOL_KINDS,
    defaultPeriodKind: 'school_year',
    scored: true,
    components: [
      {
        code: 'K',
        labelKey: 'accred.component.K',
        weight: 15,
        indicators: [
          indicator('K1', 'K1', {
            evidence: [
              evidenceItem('title_list', 'K1', { kind: 'generated', primary: true, reportId: 'collection.title_list' }),
              evidenceItem('catalogue_screenshot', 'K1', { kind: 'screenshot', screen: 'catalog/records' }),
              evidenceItem('ddc_recap', 'K1', { kind: 'generated', reportId: 'accreditation.annex.ddc' }),
            ],
          }),
          indicator('K2', 'K2'),
          indicator('K3', 'K3', { window: 'current', evidence: [evidenceItem('policy_document', 'K3', { kind: 'signed_document', primary: true })] }),
        ],
      },
      {
        code: 'SP',
        labelKey: 'accred.component.SP',
        weight: 10,
        indicators: [
          indicator('SP1', 'SP1', {
            manual: true,
            window: 'current',
            optionKeys: ['accred.ik.SP1.option.a', 'accred.ik.SP1.option.b', 'accred.ik.SP1.option.c', 'accred.ik.SP1.option.d'],
          }),
        ],
      },
      { code: 'L', labelKey: 'accred.component.L', weight: 35, indicators: [indicator('L7', 'L7'), indicator('L8', 'L8')] },
    ],
    snp: [],
  };
}

/** The primary school instrument: no plagiarism item, so `SCH-L8` is the decree's service item 7. */
export function sdInstrument(): InstrumentView {
  return {
    ...smaInstrument(),
    id: 'sch-sd-2025',
    decree: 'Kepka Perpusnas 157/2025',
    schoolLevels: ['sd_mi'],
    components: [
      {
        code: 'L',
        labelKey: 'accred.component.L',
        weight: 35,
        indicators: [indicator('L6', 'L6'), indicator('L8', 'L7'), indicator('L9', 'L8')],
      },
    ],
  };
}

/** The statistics mode: every library, every period kind, no indicator and no score. */
export function generalInstrument(): InstrumentView {
  return {
    id: 'general-stats',
    decree: 'Peraturan Perpusnas 2/2022',
    effectiveFrom: '2026-01-02',
    sourceStatus: 'P',
    libraryTypes: ['sekolah', 'perguruan_tinggi', 'umum', 'khusus'],
    schoolLevels: ['sd_mi', 'smp_mts', 'sma_smk_ma', 'slb', 'paud'],
    periodKinds: ['school_year', 'calendar_year', 'rolling_12', 'custom'],
    defaultPeriodKind: 'calendar_year',
    scored: false,
    components: [],
    snp: [],
  };
}

export function instrumentsAnswer(o: { libraryType?: InstrumentsResponse['config']['libraryType'] } = {}): InstrumentsResponse {
  return {
    instruments: [sdInstrument(), smaInstrument(), generalInstrument()],
    config: {
      libraryType: o.libraryType === undefined ? 'sekolah' : o.libraryType,
      schoolYearStartMonth: 7,
      usedUnit: 'titles',
      evidenceMaxMb: 5,
      componentLimitMb: 9,
      liveFrom: null,
      unknownMemberGroupDefault: 'student',
      dedupeMinutes: 60,
      dedupeLegacy: false,
    },
  };
}

export function periodView(o: Partial<PeriodView> = {}): PeriodView {
  return {
    id: PERIOD_ID,
    name: 'Akreditasi 2026',
    instrumentId: 'sch-sma-2025',
    kind: 'school_year',
    startsOn: '2025-07-01',
    endsOn: '2026-06-30',
    branchId: null,
    profile: { npp: '3301012345', schoolName: 'SMA Contoh', schoolLevel: 'sma_smk_ma' },
    students: 360,
    teachers: 30,
    eduStaff: 12,
    classes: 12,
    populationServed: null,
    teachersUsing: 20,
    allRegisteredConfirmed: false,
    userPcs: 4,
    staffPcs: 2,
    ictDevices: 6,
    scanners: 1,
    floorM2: 120,
    bandwidthMbps: 50,
    hoursPerWeek: 40,
    services: ['reading_room', 'circulation'],
    externalWebsiteUrl: null,
    status: 'open',
    frozenAt: null,
    frozenBy: null,
    version: 3,
    createdAt: T0,
    updatedAt: T0,
    lastChangeAt: T0,
    computedAt: T0 + 60_000,
    stale: false,
    catalogSyncedAt: null,
    lastUsageImport: null,
    ...o,
  };
}

export function summaryOf(p: PeriodView): PeriodSummaryView {
  return {
    id: p.id,
    name: p.name,
    instrumentId: p.instrumentId,
    kind: p.kind,
    startsOn: p.startsOn,
    endsOn: p.endsOn,
    status: p.status,
    computedAt: p.computedAt,
    stale: p.stale,
  };
}

export function periodsAnswer(...periods: PeriodView[]): PeriodListResponse {
  return { periods: periods.map(summaryOf) };
}

export function scoreView(o: Partial<ScoreView> = {}): ScoreView {
  return {
    answered: 40,
    total: 42,
    perComponent: [
      { code: 'K', sum: 24, max: 32, n: 8, weight: 15 },
      { code: 'SP', sum: 20, max: 28, n: 7, weight: 10 },
      { code: 'L', sum: 40, max: 56, n: 14, weight: 35 },
    ],
    na: null,
    naLow: '70.45',
    naHigh: '72.10',
    grade: null,
    gaps: [
      { code: 'SCH-K3', officialNo: 'K3', component: 'K', gap: '1.4062', actionKey: 'accred.gap.action.K3' },
      { code: 'SCH-L8', officialNo: 'L8', component: 'L', gap: '1.2500', actionKey: 'accred.gap.action.L8' },
    ],
    ...o,
  };
}

export function indicatorResult(code: string, officialNo: string, component: string, o: Partial<IndicatorResultView> = {}): IndicatorResultView {
  return {
    code,
    officialNo,
    component,
    labelKey: `accred.ik.${code.replace(/^SCH-/, '')}`,
    metric: null,
    value: null,
    numerator: null,
    denominator: null,
    unit: 'count',
    basis: 'none',
    notes: [],
    detail: null,
    table: null,
    suggestion: null,
    suggest: true,
    answer: null,
    final: null,
    evidence: [],
    ...o,
  };
}

export function resultsView(o: Partial<ResultsView> = {}): ResultsView {
  return {
    status: 'ready',
    computedAt: T0 + 60_000,
    changedAt: T0,
    stale: false,
    jobId: null,
    prerequisites: { titles: { pass: true, count: 1_250, asOf: '2026-06-30' }, npp: { pass: true }, foundingDecree: { pass: true }, met: true },
    indicators: [],
    snp: [],
    score: scoreView(),
    missingEvidence: [],
    ...o,
  };
}

export function jobView(o: Partial<JobView> = {}): JobView {
  return {
    id: JOB_ID,
    type: 'accreditation.evaluate',
    status: 'running',
    progress: 10,
    progressMessage: null,
    attempts: 1,
    maxAttempts: 3,
    lastError: null,
    runAt: T0,
    createdAt: T0,
    updatedAt: T0,
    finishedAt: null,
    createdBy: null,
    retryable: 'api',
    cancellable: false,
    interactive: false,
    ...o,
  };
}
