/**
 * The fixed vocabularies of reports and accreditation: lists that live in code, not in tables, each frozen `as const`
 * with its own type. {@link ACCREDITATION_VOCAB_LISTS} is joined into `VOCAB_LISTS` (catalog-vocab.ts), so every value
 * has a shared label `vocab.<list>.<value>` in both languages and `i18n/id.ts` checks at compile time that none is
 * missing.
 *
 * No Node built-ins here: the browser bundles this module.
 */
import { DDC_MAINS } from './ddc.js';

/** The groups of the school community an accreditation counts (members, visits and loans are mapped to them). */
export const ACCRED_GROUPS = Object.freeze(['student', 'teacher', 'edu_staff', 'public', 'other'] as const);

export type AccredGroup = (typeof ACCRED_GROUPS)[number];

/** How an accreditation period is cut: a school year, a calendar year, the 12 months ending in a chosen month, or free. */
export const PERIOD_KINDS = Object.freeze(['school_year', 'calendar_year', 'rolling_12', 'custom'] as const);

export type PeriodKind = (typeof PERIOD_KINDS)[number];

/** The kinds of the Activities register. */
export const ACTIVITY_KINDS = Object.freeze([
  'promotion',
  'reading_culture',
  'reading_guidance',
  'writing_guidance',
  'plagiarism_guidance',
  'innovation',
  'external_literacy',
  'needs_survey',
  'satisfaction_survey',
  'preservation',
  'learning_session',
  'stocktake',
  'weeding',
  'award',
  'uniqueness',
  'other',
] as const);

export type ActivityKind = (typeof ACTIVITY_KINDS)[number];

/** The kinds of the Documents register. */
export const DOCUMENT_KINDS = Object.freeze([
  'rules',
  'sop_membership',
  'sop_loan',
  'sop_return',
  'sop_other',
  'collection_policy',
  'founding_decree',
  'npp_certificate',
  'duties',
  'org_structure',
  'school_program',
  'library_program',
  'pos_collection',
  'pos_organisation',
  'pos_service',
  'pos_preservation',
  'pos_promotion',
  'pos_partnership',
  'report_annual',
  'report_semester',
  'report_quarterly',
  'report_monthly',
  'head_performance_report',
  'library_request_letter',
  'other',
] as const);

export type DocumentKind = (typeof DOCUMENT_KINDS)[number];

/** How an evidence item is supplied: a report ALTIS makes, a file, a screenshot, a signed document, a photo. */
export const EVIDENCE_KINDS = Object.freeze(['generated', 'upload', 'screenshot', 'signed_document', 'photo'] as const);

export type EvidenceKind = (typeof EVIDENCE_KINDS)[number];

/**
 * The metrics of the monthly usage table. `visits` is the raw count, `visits_deduped` the count after a member's
 * repeat visits within `visits.dedupeMinutes` are dropped; `members_active` is a span metric (members whose membership
 * runs past the end of the span).
 */
export const USAGE_METRICS = Object.freeze([
  'visits',
  'visits_deduped',
  'visits_online',
  'loans',
  'in_library_uses',
  'distinct_visitors',
  'distinct_borrowers',
  'titles_used',
  'items_used',
  'members_active',
] as const);

export type UsageMetric = (typeof USAGE_METRICS)[number];

/** The kinds of service a library offers (counted for the services indicator). */
export const SERVICE_CODES = Object.freeze([
  'reading_room',
  'circulation',
  'reference',
  'information_literacy',
  'speed_reading',
  'extension',
  'project_learning',
  'ict',
  'other',
] as const);

export type ServiceCode = (typeof SERVICE_CODES)[number];

/** The kind of a written work by the school community (`records.local_work_kind`). */
export const LOCAL_WORK_KINDS = Object.freeze(['written_work', 'clipping', 'short_stories', 'poetry', 'review', 'abstract', 'other'] as const);

export type LocalWorkKind = (typeof LOCAL_WORK_KINDS)[number];

/** Who a record is meant for (`records.audience`). */
export const AUDIENCES = Object.freeze(['general', 'children', 'special_needs'] as const);

export type Audience = (typeof AUDIENCES)[number];

/** Who made a local work (`records.local_work`). */
export const LOCAL_WORKS = Object.freeze(['student', 'teacher', 'staff', 'school', 'local'] as const);

export type LocalWork = (typeof LOCAL_WORKS)[number];

/** The kind of a reference work (`records.reference_kind`). */
export const REFERENCE_KINDS = Object.freeze([
  'encyclopedia',
  'dictionary',
  'handbook',
  'atlas',
  'globe',
  'biography',
  'almanac',
  'directory',
  'other',
] as const);

export type ReferenceKind = (typeof REFERENCE_KINDS)[number];

/** The file formats of a report export. */
export const REPORT_FORMATS = Object.freeze(['csv', 'xlsx', 'pdf', 'zip'] as const);

export type ReportFormat = (typeof REPORT_FORMATS)[number];

/** The statuses of a report run. */
export const REPORT_RUN_STATUSES = Object.freeze(['queued', 'running', 'succeeded', 'failed', 'cancelled'] as const);

export type ReportRunStatus = (typeof REPORT_RUN_STATUSES)[number];

/** The role of a member of the library staff. */
export const STAFF_ROLES = Object.freeze(['head', 'librarian', 'ict', 'technical', 'other'] as const);

export type StaffRole = (typeof STAFF_ROLES)[number];

/** The employment of a member of the library staff. */
export const EMPLOYMENTS = Object.freeze(['civil_servant', 'contract', 'honorary', 'foundation', 'other'] as const);

export type Employment = (typeof EMPLOYMENTS)[number];

/** The highest education of a member of the library staff. */
export const EDUCATION_LEVELS = Object.freeze(['sma', 'd1', 'd2', 'd3', 'd4', 's1', 's2', 's3', 'other'] as const);

export type EducationLevel = (typeof EDUCATION_LEVELS)[number];

/** The kind of a written partnership. */
export const PARTNERSHIP_KINDS = Object.freeze(['mou', 'pks', 'other'] as const);

export type PartnershipKind = (typeof PARTNERSHIP_KINDS)[number];

/** The level of a school library. */
export const SCHOOL_LEVELS = Object.freeze(['sd_mi', 'smp_mts', 'sma_smk_ma', 'slb', 'paud'] as const);

export type SchoolLevel = (typeof SCHOOL_LEVELS)[number];

/** Whether a school is public or private. */
export const SCHOOL_STATUSES = Object.freeze(['negeri', 'swasta'] as const);

export type SchoolStatus = (typeof SCHOOL_STATUSES)[number];

/** How an answer was given: chosen where ALTIS suggests none, or chosen over ALTIS's suggestion. */
export const ANSWER_MODES = Object.freeze(['manual', 'override'] as const);

export type AnswerMode = (typeof ANSWER_MODES)[number];

/** Whether a period is open or frozen. */
export const PERIOD_STATUSES = Object.freeze(['open', 'frozen'] as const);

export type PeriodStatus = (typeof PERIOD_STATUSES)[number];

/**
 * The aspects a document of each kind may cover, as codes `a1`…`an` in the order of the instrument's own list (their
 * labels are the shared `accred.aspect.<kind>.<code>`). Only the collection policy, the library work programme and the
 * head of library's performance report have aspects.
 */
export const DOCUMENT_ASPECTS: Readonly<Record<DocumentKind, readonly string[]>> = Object.freeze(
  Object.fromEntries(
    DOCUMENT_KINDS.map((kind): [DocumentKind, readonly string[]] => {
      const count = kind === 'collection_policy' || kind === 'library_program' ? 8 : kind === 'head_performance_report' ? 6 : 0;
      return [kind, Object.freeze(Array.from({ length: count }, (_, i) => `a${i + 1}`))];
    }),
  ) as Record<DocumentKind, readonly string[]>,
);

/** The features of the library website the website indicator counts. */
export const L12_FEATURES = Object.freeze(['profile', 'opac', 'services', 'contact', 'databases', 'social', 'faq'] as const);

export type L12Feature = (typeof L12_FEATURES)[number];

/**
 * The register tables an evidence file may belong to. A contract tuple, not a vocabulary: it has no labels.
 */
export const EVIDENCE_ENTITIES = Object.freeze([
  'library_activities',
  'library_staff',
  'staff_trainings',
  'library_partnerships',
  'library_budgets',
  'library_documents',
] as const);

export type EvidenceEntity = (typeof EVIDENCE_ENTITIES)[number];

/**
 * The lists with shared labels, by the `<list>` of their message keys `vocab.<list>.<value>`; spread into
 * `VOCAB_LISTS` after the catalogue's lists. `ddc_main` is the DDC main classes of ddc.ts.
 */
export const ACCREDITATION_VOCAB_LISTS = Object.freeze({
  accred_group: ACCRED_GROUPS,
  period_kind: PERIOD_KINDS,
  activity_kind: ACTIVITY_KINDS,
  document_kind: DOCUMENT_KINDS,
  evidence_kind: EVIDENCE_KINDS,
  usage_metric: USAGE_METRICS,
  service_code: SERVICE_CODES,
  local_work_kind: LOCAL_WORK_KINDS,
  audience: AUDIENCES,
  local_work: LOCAL_WORKS,
  reference_kind: REFERENCE_KINDS,
  report_format: REPORT_FORMATS,
  report_run_status: REPORT_RUN_STATUSES,
  staff_role: STAFF_ROLES,
  employment: EMPLOYMENTS,
  education_level: EDUCATION_LEVELS,
  partnership_kind: PARTNERSHIP_KINDS,
  school_level: SCHOOL_LEVELS,
  school_status: SCHOOL_STATUSES,
  answer_mode: ANSWER_MODES,
  period_status: PERIOD_STATUSES,
  ddc_main: DDC_MAINS,
});
