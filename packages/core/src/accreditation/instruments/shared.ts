import type { ActivityKind } from '@altis/shared';
import type { AccredMetricId } from '../metric-ids.js';
import type { AccredNoteKey } from '../notes.js';
import type {
  AccredBand,
  AccredComponent,
  AccredEvidenceItem,
  AccredIndicator,
  AccredInstrument,
  AccredWindow,
  RangeBand,
  SnpCheck,
} from '../types.js';
import type { AccredInstrumentHeader } from './headers.js';

// The 42 indicators the three school instruments of 2025 share, keyed by the upper secondary numbering (`L8`; the
// catalogue code is `SCH-L8`): each one's component, metric and window, how its value becomes an answer, its required
// elements, the notes it may print and its evidence checklist. Each level file adds what its own decree changes: the
// bands, the number it prints, a wording or a counted list of its own, and its school standards. Only the numbers of
// the bands and the official item numbers come from the decrees; every label is our own paraphrase, kept as a message.

/** Freezes `value` and every object and array reachable from it (an already frozen one is still walked). */
export function deepFreeze<T>(value: T, seen: WeakSet<object> = new WeakSet()): T {
  if (value !== null && typeof value === 'object' && !seen.has(value)) {
    seen.add(value);
    for (const v of Object.values(value)) deepFreeze(v, seen);
    Object.freeze(value);
  }
  return value;
}

// ---- bands -----------------------------------------------------------------------------------------------------------

/** The bounds of one band, both inclusive. */
export type Bounds = { min?: number; max?: number };

/** A value of `n` or more. */
export const atLeast = (n: number): Bounds => ({ min: n });
/** Exactly `n`. */
export const exactly = (n: number): Bounds => ({ min: n, max: n });
/** From `lo` to `hi`. */
export const between = (lo: number, hi: number): Bounds => ({ min: lo, max: hi });
/** A value of `n` or less (lower is better). */
export const atMost = (n: number): Bounds => ({ max: n });

/** The bands a, b and c with the given bounds, then d for every other value. */
export function bands(a: Bounds, b: Bounds, c: Bounds): readonly RangeBand[] {
  return [
    { answer: 'a', ...a },
    { answer: 'b', ...b },
    { answer: 'c', ...c },
    { answer: 'd' },
  ];
}

/**
 * The tiers of K6: the share of titles added over three calendar years is banded by the size of the collection at the
 * start of the window; below 1 000 titles the first tier applies (and the indicator says so).
 */
export const K6_TIERS: readonly { minSize: number; bands: readonly RangeBand[] }[] = deepFreeze([
  { minSize: 0, bands: bands(atLeast(46), between(31, 45), exactly(30)) },
  { minSize: 1501, bands: bands(atLeast(37), between(25, 36), exactly(24)) },
  { minSize: 2000, bands: bands(atLeast(28), between(19, 27), exactly(18)) },
]);

// ---- components ------------------------------------------------------------------------------------------------------

export type ComponentCode = AccredComponent['code'];

/** The six components, in order, with their weights (100 in all). */
export const SCHOOL_COMPONENTS: readonly { code: ComponentCode; weight: number }[] = deepFreeze([
  { code: 'K', weight: 15 },
  { code: 'SP', weight: 10 },
  { code: 'L', weight: 35 },
  { code: 'T', weight: 15 },
  { code: 'F', weight: 15 },
  { code: 'G', weight: 10 },
]);

// ---- evidence --------------------------------------------------------------------------------------------------------

/**
 * Stands for the snapshot date `D` of a period in the parameters of a generated evidence item: a list "as of D" is
 * that list at the date the period is measured. {@link evidenceReportParams} puts the date in.
 */
export const EVIDENCE_SNAPSHOT_DATE = '@snapshot-date';

/**
 * The parameters of the report behind a generated evidence item, for the period `periodId` measured at `D`: the item's
 * own parameters with the snapshot date put in, and the period first for an accreditation report (each of those starts
 * with it).
 */
export function evidenceReportParams(item: AccredEvidenceItem, o: { periodId: string; D: string }): Record<string, unknown> {
  const out: Record<string, unknown> = {};
  if (item.reportId?.startsWith('accreditation.') === true) out['periodId'] = o.periodId;
  for (const [key, value] of Object.entries(item.params ?? {})) out[key] = value === EVIDENCE_SNAPSHOT_DATE ? o.D : value;
  return out;
}

/** An evidence item before its label is named after its indicator. */
type EvidenceSpec = Omit<AccredEvidenceItem, 'labelKey'>;

const generated = (code: string, reportId: string, params?: Readonly<Record<string, unknown>>): EvidenceSpec =>
  params === undefined ? { code, kind: 'generated', reportId } : { code, kind: 'generated', reportId, params };
const upload = (code: string): EvidenceSpec => ({ code, kind: 'upload' });
const signed = (code: string): EvidenceSpec => ({ code, kind: 'signed_document' });
const photo = (code: string): EvidenceSpec => ({ code, kind: 'photo' });
const screenshot = (code: string, screen: string): EvidenceSpec => ({ code, kind: 'screenshot', screen });
/** The main evidence of its indicator. */
const primary = (item: EvidenceSpec): EvidenceSpec => ({ ...item, primary: true });

const AS_OF_D = { asOf: EVIDENCE_SNAPSHOT_DATE } as const;
const ACTIVITIES = 'accreditation.annex.activities';
const STAFF = 'accreditation.annex.staff';
const RECORDS_SCREEN = 'catalog/records';
/** An activity list of one kind with the activity reports beside it (the service activities). */
const activityEvidence = (kind: ActivityKind): readonly EvidenceSpec[] => [
  primary(generated('activity_list', ACTIVITIES, { kinds: [kind] })),
  upload('activity_reports'),
];

// ---- the indicators --------------------------------------------------------------------------------------------------

/**
 * An indicator as the three levels share it. `band` is `'range'` when each level gives its own bands, else the band
 * every level uses; `options` names the four option labels of an indicator answered by hand or by a rule.
 */
export interface ConceptIndicator {
  readonly component: ComponentCode;
  readonly code: string;
  readonly metric?: AccredMetricId;
  readonly window: AccredWindow;
  readonly band: 'range' | Exclude<AccredBand, { kind: 'range' }>;
  readonly mandatory?: readonly string[];
  readonly noteKeys: readonly AccredNoteKey[];
  readonly evidence: readonly EvidenceSpec[];
  readonly options?: true;
}

/** A note's name, its key without `accred.note.`. */
type NoteName = AccredNoteKey extends infer K ? (K extends `accred.note.${infer N}` ? N : never) : never;
const notes = (...names: NoteName[]): readonly AccredNoteKey[] => names.map((name): AccredNoteKey => `accred.note.${name}`);
const MANUAL = { kind: 'manual' } as const;
const rule = (r: 'k7' | 'l11' | 't1' | 't3' | 'g4') => ({ kind: 'rule', rule: r }) as const;

/** The 42 indicators in the order of the upper secondary instrument. */
export const SCHOOL_INDICATORS: readonly ConceptIndicator[] = deepFreeze<ConceptIndicator[]>([
  // ---- Koleksi ----
  {
    component: 'K',
    code: 'K1',
    metric: 'collection.titles',
    window: 'snapshot',
    band: 'range',
    noteKeys: notes('electronic_counted', 'replacement_records', 'items_without_received_date'),
    evidence: [
      primary(generated('title_list', 'collection.title_list', AS_OF_D)),
      screenshot('catalogue_screenshot', RECORDS_SCREEN),
      generated('ddc_recap', 'accreditation.annex.ddc'),
    ],
  },
  {
    component: 'K',
    code: 'K2',
    metric: 'collection.fiction_pct',
    window: 'snapshot',
    band: 'range',
    noteKeys: notes('fiction_rule', 'truncated'),
    evidence: [
      primary(generated('fiction_list', 'collection.title_list', { ...AS_OF_D, fictionOnly: true })),
      screenshot('fiction_screenshot', RECORDS_SCREEN),
    ],
  },
  {
    component: 'K',
    code: 'K3',
    metric: 'registers.collection_policy_aspects',
    window: 'current',
    band: 'range',
    mandatory: ['a1', 'a2', 'a3', 'a4', 'a5'],
    noteKeys: notes('mandatory_missing', 'register_empty'),
    evidence: [primary(signed('policy_document'))],
  },
  {
    component: 'K',
    code: 'K4',
    metric: 'registers.activities.needs_survey',
    window: 'period',
    band: 'range',
    noteKeys: notes('register_empty'),
    evidence: [primary(upload('survey_report')), generated('activity_list', ACTIVITIES, { kinds: ['needs_survey'] })],
  },
  {
    component: 'K',
    code: 'K5',
    metric: 'usage.collection_used_pct',
    window: 'period',
    band: 'range',
    noteKeys: notes('usage_unit', 'usage_no_data', 'truncated'),
    evidence: [primary(upload('used_list')), photo('use_photo'), generated('usage_table', 'accreditation.annex.usage_monthly')],
  },
  {
    component: 'K',
    code: 'K6',
    metric: 'collection.title_additions_3y_pct',
    window: 'three_calendar_years',
    band: { kind: 'sized_range', sizeMetric: 'collection.titles_window_start', tiers: K6_TIERS },
    noteKeys: notes('k6_tier', 'k6_start_below_1000', 'k6_no_start', 'items_without_received_date', 'undated_share_high', 'truncated'),
    evidence: [primary(generated('additions_table', 'accreditation.annex.additions')), signed('additions_signed')],
  },
  {
    component: 'K',
    code: 'K7',
    metric: 'collection.k7_organisation',
    window: 'current',
    band: rule('k7'),
    noteKeys: notes('k7_unprocessed', 'k7_almost', 'k7_threshold_lowered', 'collection_empty', 'input_missing'),
    evidence: [
      primary(generated('processed_list', 'collection.item_list', AS_OF_D)),
      photo('shelf_photos'),
      generated('data_quality', 'collection.data_quality'),
      photo('scanner_photo'),
      // ---- Komunitas K4 (stocktake) ----
      signed('stocktake_minutes'),
    ],
    options: true,
  },
  {
    component: 'K',
    code: 'K8',
    metric: 'registers.activities.preservation_3p',
    window: 'three_periods',
    band: 'range',
    noteKeys: notes('register_empty'),
    evidence: [
      primary(generated('preservation_list', ACTIVITIES, { kinds: ['preservation'], window: 'three_periods' })),
      photo('preservation_photos'),
      // ---- Komunitas K4 (stocktake) ----
      signed('stocktake_minutes'),
    ],
  },
  // ---- Sarana dan Prasarana ----
  {
    component: 'SP',
    code: 'SP1',
    window: 'current',
    band: MANUAL,
    noteKeys: notes('sp1_floor'),
    evidence: [primary(upload('floor_plan')), photo('room_photos')],
    options: true,
  },
  { component: 'SP', code: 'SP2', window: 'current', band: MANUAL, noteKeys: [], evidence: [primary(photo('shelf_photos'))], options: true },
  {
    component: 'SP',
    code: 'SP3',
    window: 'current',
    band: MANUAL,
    noteKeys: [],
    evidence: [primary(upload('furniture_list')), photo('furniture_photos')],
    options: true,
  },
  {
    component: 'SP',
    code: 'SP4',
    metric: 'period.ict_devices_pct',
    window: 'current',
    band: 'range',
    noteKeys: notes('population_missing', 'input_missing', 'truncated'),
    evidence: [primary(upload('ict_list')), upload('population_source'), photo('ict_photos')],
  },
  {
    component: 'SP',
    code: 'SP5',
    metric: 'registers.staff_pcs_pct',
    window: 'current',
    band: 'range',
    noteKeys: notes('staff_missing', 'input_missing', 'truncated'),
    evidence: [primary(upload('staff_pc_list')), generated('staff_annex', STAFF)],
  },
  {
    component: 'SP',
    code: 'SP6',
    metric: 'period.bandwidth_mbps',
    window: 'current',
    band: 'range',
    noteKeys: notes('input_missing'),
    evidence: [primary(upload('bandwidth_proof'))],
  },
  {
    component: 'SP',
    code: 'SP7',
    metric: 'registers.activities.learning',
    window: 'period',
    band: 'range',
    noteKeys: notes('activity_multi', 'register_empty'),
    evidence: [primary(generated('learning_list', ACTIVITIES, { learning: true })), photo('learning_photos')],
  },
  // ---- Pelayanan ----
  {
    component: 'L',
    code: 'L1',
    metric: 'registers.service_procedures',
    window: 'current',
    band: 'range',
    mandatory: ['rules', 'sop_membership'],
    noteKeys: notes('mandatory_missing', 'register_empty'),
    evidence: [primary(signed('procedure_documents')), photo('procedure_display')],
  },
  {
    component: 'L',
    code: 'L2',
    metric: 'period.services_count',
    window: 'current',
    band: 'range',
    noteKeys: notes('input_missing'),
    evidence: [primary(upload('service_list')), photo('service_photos')],
  },
  {
    component: 'L',
    code: 'L3',
    metric: 'registers.activities.reading_culture',
    window: 'period',
    band: 'range',
    noteKeys: notes('register_empty'),
    evidence: activityEvidence('reading_culture'),
  },
  {
    component: 'L',
    code: 'L4',
    metric: 'registers.activities.reading_guidance',
    window: 'period',
    band: 'range',
    noteKeys: notes('register_empty'),
    evidence: activityEvidence('reading_guidance'),
  },
  {
    component: 'L',
    code: 'L5',
    metric: 'registers.activities.writing_guidance',
    window: 'period',
    band: 'range',
    noteKeys: notes('register_empty'),
    evidence: activityEvidence('writing_guidance'),
  },
  {
    component: 'L',
    code: 'L6',
    metric: 'collection.local_work_kinds',
    window: 'snapshot',
    band: 'range',
    noteKeys: notes('l6_kinds', 'l6_manual'),
    evidence: [
      primary(generated('local_work_list', 'collection.title_list', { ...AS_OF_D, localWorkOnly: true })),
      screenshot('local_work_screenshot', RECORDS_SCREEN),
    ],
  },
  {
    component: 'L',
    code: 'L7',
    metric: 'registers.activities.plagiarism_guidance',
    window: 'period',
    band: 'range',
    noteKeys: notes('register_empty'),
    evidence: activityEvidence('plagiarism_guidance'),
  },
  {
    component: 'L',
    code: 'L8',
    metric: 'registers.activities.innovation',
    window: 'period',
    band: 'range',
    noteKeys: notes('register_empty'),
    evidence: activityEvidence('innovation'),
  },
  {
    component: 'L',
    code: 'L9',
    metric: 'registers.activities.external_literacy',
    window: 'period',
    band: 'range',
    noteKeys: notes('activity_multi', 'register_empty'),
    evidence: [primary(generated('activity_list', ACTIVITIES, { externalLiteracy: true })), upload('activity_reports')],
  },
  {
    component: 'L',
    code: 'L10',
    metric: 'registers.activities.satisfaction_survey',
    window: 'period',
    band: 'range',
    noteKeys: notes('register_empty'),
    evidence: [primary(upload('survey_report')), generated('activity_list', ACTIVITIES, { kinds: ['satisfaction_survey'] })],
  },
  {
    component: 'L',
    code: 'L11',
    metric: 'system.l11_automation',
    window: 'current',
    band: rule('l11'),
    noteKeys: notes('l11_unverified', 'l11_private', 'l11_localhost', 'base_url_unset', 'base_url_public_guess'),
    evidence: [
      // Membership and circulation screens of a later milestone; until they exist the item takes an upload.
      primary(screenshot('membership_screenshot', 'members')),
      screenshot('loan_screenshot', 'circulation/desk'),
      screenshot('return_screenshot', 'circulation/desk'),
      screenshot('opac_screenshot', 'opac:/cari'),
      screenshot('website_screenshot', 'opac:/'),
    ],
    options: true,
  },
  {
    component: 'L',
    code: 'L12',
    metric: 'system.website_features',
    window: 'current',
    band: 'range',
    noteKeys: notes('l12_features', 'l12_not_public', 'l12_external'),
    evidence: [primary(screenshot('feature_screenshots', 'opac:/'))],
  },
  {
    component: 'L',
    code: 'L13',
    metric: 'registers.activities.promotion',
    window: 'period',
    band: 'range',
    noteKeys: notes('l13_news', 'register_empty'),
    evidence: [primary(generated('activity_list', ACTIVITIES, { kinds: ['promotion'] })), upload('promotion_materials')],
  },
  {
    component: 'L',
    code: 'L14',
    metric: 'usage.school_visits_pct',
    window: 'period',
    band: 'range',
    noteKeys: notes(
      'school_months',
      'school_months_prorated',
      'member_unknown',
      'visits_deduped',
      'guests_excluded',
      'population_missing',
      'usage_no_data',
      'truncated',
    ),
    evidence: [primary(generated('l14_annex', 'accreditation.annex.l14')), upload('population_source'), upload('visitor_log')],
  },
  // ---- Tenaga ----
  {
    component: 'T',
    code: 'T1',
    metric: 'registers.head_qualification',
    window: 'current',
    band: rule('t1'),
    noteKeys: notes('head_missing', 'head_multiple', 't1_equivalence', 'input_missing'),
    evidence: [primary(upload('head_diploma')), upload('head_training'), signed('head_appointment')],
    options: true,
  },
  {
    component: 'T',
    code: 'T2',
    metric: 'registers.head_performance_aspects',
    window: 'period',
    band: 'range',
    noteKeys: notes('register_empty'),
    evidence: [primary(signed('performance_report'))],
  },
  {
    component: 'T',
    code: 'T3',
    metric: 'registers.staff_roles',
    window: 'current',
    band: rule('t3'),
    noteKeys: notes('staff_missing'),
    evidence: [primary(generated('staff_annex', STAFF)), signed('staff_appointments'), upload('staff_certificates')],
    options: true,
  },
  {
    component: 'T',
    code: 'T4',
    metric: 'registers.training_avg_3p',
    window: 'three_periods',
    band: 'range',
    noteKeys: notes('t4_scope', 'staff_missing', 'truncated'),
    evidence: [primary(generated('training_recap', STAFF, { section: 'trainings', window: 'three_periods' })), upload('training_certificates')],
  },
  {
    component: 'T',
    code: 'T5',
    metric: 'registers.population_per_staff',
    window: 'current',
    band: 'range',
    noteKeys: notes('population_missing', 'staff_missing', 'truncated'),
    evidence: [primary(generated('ratio_sheet', STAFF, { section: 'ratio' })), upload('population_source')],
  },
  // ---- Penyelenggaraan ----
  {
    component: 'F',
    code: 'F1',
    metric: 'registers.legality_elements',
    window: 'current',
    band: 'range',
    mandatory: ['founding_decree', 'npp'],
    noteKeys: notes('mandatory_missing', 'register_empty'),
    evidence: [primary(signed('founding_decree')), primary(upload('npp_certificate')), signed('duties'), signed('org_structure')],
  },
  {
    component: 'F',
    code: 'F2',
    metric: 'registers.operating_procedures',
    window: 'current',
    band: 'range',
    mandatory: ['pos_collection', 'pos_organisation', 'pos_service'],
    noteKeys: notes('mandatory_missing', 'register_empty'),
    evidence: [primary(signed('pos_documents'))],
  },
  { component: 'F', code: 'F3', window: 'current', band: MANUAL, noteKeys: [], evidence: [primary(signed('school_program'))], options: true },
  {
    component: 'F',
    code: 'F4',
    // The teachers using the library are an entry of the period, like every period value measured as it stands.
    metric: 'period.teachers_using_pct',
    window: 'current',
    band: 'range',
    noteKeys: notes('input_missing', 'truncated'),
    evidence: [primary(upload('lesson_plans')), upload('teacher_recap')],
  },
  // ---- Pengelolaan ----
  {
    component: 'G',
    code: 'G1',
    metric: 'registers.library_program_aspects',
    window: 'current',
    band: 'range',
    mandatory: ['a1', 'a2', 'a3'],
    noteKeys: notes('mandatory_missing', 'register_empty'),
    evidence: [primary(signed('library_program'))],
  },
  {
    component: 'G',
    code: 'G2',
    metric: 'registers.partners_3p',
    window: 'three_periods',
    band: 'range',
    noteKeys: notes('g2_distinct', 'register_empty'),
    evidence: [primary(upload('agreements')), photo('partnership_photos'), generated('partnership_list', 'accreditation.annex.partnerships')],
  },
  {
    component: 'G',
    code: 'G3',
    metric: 'registers.budget_share_3y',
    window: 'budget_years',
    band: 'range',
    noteKeys: notes('budget_incomplete', 'truncated'),
    evidence: [primary(generated('budget_recap', 'accreditation.annex.budgets')), upload('rab_documents')],
  },
  {
    component: 'G',
    code: 'G4',
    metric: 'registers.report_routine_3p',
    window: 'three_periods',
    band: rule('g4'),
    noteKeys: notes('g4_rule', 'g4_undated', 'register_empty'),
    evidence: [
      primary(signed('report_documents')),
      generated('report_list', 'accreditation.annex.documents', { kinds: ['report_annual', 'report_semester', 'report_quarterly', 'report_monthly'] }),
    ],
    options: true,
  },
]);

/**
 * The notes an indicator prints whatever its value, when it lists them (a note of one level only, such as the reading
 * of option d of L3 at SD, is listed by that level alone). Notes about the band, the rule or the required elements
 * come from the engine; the rest from the providers.
 */
export const ALWAYS_NOTES: Readonly<Record<string, readonly AccredNoteKey[]>> = deepFreeze({
  K2: notes('fiction_rule', 'truncated'),
  K5: notes('usage_unit'),
  SP3: notes('sp3_mandatory_hint'),
  SP7: notes('activity_multi'),
  L3: notes('l3_sd_option_d'),
  L6: notes('l6_kinds'),
  L9: notes('activity_multi'),
  L12: notes('l12_features'),
  T4: notes('t4_scope'),
  G2: notes('g2_distinct'),
  G4: notes('g4_rule'),
});

// ---- one level -------------------------------------------------------------------------------------------------------

/** What one level's decree sets for the shared indicators. */
export interface SchoolLevelSpec {
  readonly header: AccredInstrumentHeader;
  /** The concept keys this decree has no item for. */
  readonly without: readonly string[];
  /** The bands of every indicator banded by its level. */
  readonly bands: Readonly<Record<string, readonly RangeBand[]>>;
  /** The item numbers this decree prints where they differ from the concept key. */
  readonly officialNo: Readonly<Record<string, string>>;
  /** The labels of this level where its wording differs. */
  readonly labelKeys: Readonly<Record<string, string>>;
  /** The metric parameters of this level (the counted kinds, the website features). */
  readonly metricParams: Readonly<Record<string, Readonly<Record<string, unknown>>>>;
  /** The notes only this level prints. */
  readonly extraNotes: Readonly<Record<string, readonly AccredNoteKey[]>>;
  readonly snp: readonly SnpCheck[];
}

const OPTIONS = ['a', 'b', 'c', 'd'] as const;

/** The indicator `c` of the level `spec`. */
function levelIndicator(c: ConceptIndicator, spec: SchoolLevelSpec): AccredIndicator {
  let band: AccredBand;
  if (c.band === 'range') {
    const list = spec.bands[c.code];
    if (list === undefined) throw new TypeError(`${spec.header.id}: no bands for ${c.code}`);
    band = { kind: 'range', bands: list };
  } else {
    band = c.band;
  }
  const ind: AccredIndicator = {
    code: c.code,
    officialNo: spec.officialNo[c.code] ?? c.code,
    labelKey: spec.labelKeys[c.code] ?? `accred.ik.${c.code}`,
    window: c.window,
    band,
    evidence: c.evidence.map((e) => ({ ...e, labelKey: `accred.evidence.${c.code}.${e.code}` })),
    noteKeys: [...c.noteKeys, ...(spec.extraNotes[c.code] ?? [])],
    actionKey: `accred.gap.action.${c.code}`,
  };
  if (c.metric !== undefined) ind.metric = c.metric;
  if (c.mandatory !== undefined) ind.mandatory = c.mandatory;
  const params = spec.metricParams[c.code];
  if (params !== undefined) ind.metricParams = params;
  if (c.options === true) ind.optionKeys = OPTIONS.map((o) => `accred.ik.${c.code}.option.${o}`);
  return ind;
}

/**
 * The instrument of one school level: the shared indicators this decree has, in order, with the level's bands,
 * numbers, wordings, parameters and notes, and its standards. Throws when the level's data does not fit the shared
 * indicators (a band list for an indicator it has not, or none for one it has).
 */
export function buildSchoolInstrument(spec: SchoolLevelSpec): AccredInstrument {
  const concepts = SCHOOL_INDICATORS.filter((c) => !spec.without.includes(c.code));
  const banded = new Set(concepts.filter((c) => c.band === 'range').map((c) => c.code));
  for (const code of Object.keys(spec.bands)) {
    if (!banded.has(code)) throw new TypeError(`${spec.header.id}: bands for ${code}, which is not banded by level`);
  }
  const components: AccredComponent[] = SCHOOL_COMPONENTS.map(({ code, weight }) => ({
    code,
    labelKey: `accred.component.${code}`,
    weight,
    indicators: concepts.filter((c) => c.component === code).map((c) => levelIndicator(c, spec)),
  }));
  return deepFreeze<AccredInstrument>({ ...spec.header, components, snp: spec.snp });
}
