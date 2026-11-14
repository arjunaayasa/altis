/**
 * The accreditation API vocabulary: the institution's profile, periods, answers, monthly usage, the registers and
 * their evidence, the SLiMS usage import, the documents, and the views of results and snapshots.
 *
 * - Every Zod maximum is the column width; a free TEXT value is at most 60 000 UTF-8 bytes; a JSON value is bounded on
 *   its encoded length.
 * - Accreditation is library-wide in this edition: a body naming a branch other than null is refused with the field
 *   error `branch_scope_not_available`.
 * - The views (`…View`, `…Response`) are what the routes answer; the stored payload shapes of the evaluation reuse the
 *   schemas exported here (`NoteRefSchema`, `LetterSchema`, `SnpOutcomeSchema`, `PrerequisitesViewSchema`).
 *
 * No Node built-ins here: the browser bundles this module. Import it as `@altis/shared/api/accreditation`.
 */
import { z } from 'zod';
import {
  ACCRED_GROUPS,
  ACTIVITY_KINDS,
  DOCUMENT_ASPECTS,
  DOCUMENT_KINDS,
  EDUCATION_LEVELS,
  EMPLOYMENTS,
  EVIDENCE_ENTITIES,
  L12_FEATURES,
  PARTNERSHIP_KINDS,
  PERIOD_KINDS,
  SCHOOL_LEVELS,
  SCHOOL_STATUSES,
  SERVICE_CODES,
  STAFF_ROLES,
  USAGE_METRICS,
  type AccredGroup,
  type ActivityKind,
  type DocumentKind,
  type EducationLevel,
  type Employment,
  type EvidenceEntity,
  type EvidenceKind,
  type PartnershipKind,
  type PeriodKind,
  type PeriodStatus,
  type SchoolLevel,
  type ServiceCode,
  type StaffRole,
  type UsageMetric,
} from '../accreditation-vocab.js';
import type { LibraryType, UsedUnit } from './settings.js';
import { emailField, ulidField, versionField } from './common.js';
import { currencyField, dateField, httpUrlField, longText, shortText, sortOrderField } from './catalog/common.js';
import { jsonBytesMax } from './reports.js';

// ---- shared fields -------------------------------------------------------------------------------------------------

/** The largest profile, as JSON. */
export const ACCRED_PROFILE_MAX_BYTES = 16_000;
/** The most cells of one usage write. */
export const USAGE_PUT_MAX_CELLS = 500;
/** The most rows of one member-type mapping write. */
export const USAGE_GROUPS_PUT_MAX = 200;
/** The largest whole number a usage cell or a money column takes (the safe integers of JSON). */
const SAFE_MAX = Number.MAX_SAFE_INTEGER;

/** The value refused: a branch is named where only the whole library is possible in this edition. */
function branchScopeIssue(input: unknown) {
  return { code: 'custom' as const, params: { code: 'branch_scope_not_available' }, message: 'branch_scope_not_available', input };
}

/**
 * `branchId` of an accreditation body: only null (or absent) is accepted; anything else is the field error
 * `branch_scope_not_available` (accreditation and its registers are library-wide in this edition).
 */
export const libraryWideBranchField = z
  .unknown()
  .check(
    z.check<unknown>((ctx) => {
      if (ctx.value !== null) ctx.issues.push(branchScopeIssue(ctx.value));
    }),
  )
  .transform((): null => null);

/** A month `YYYY-MM`. */
export const monthField = z.string().regex(/^\d{4}-(0[1-9]|1[0-2])$/);

/** A non-negative whole number of a nullable INT column. */
const countField = z.int().min(0).max(2_147_483_647);
/** A non-negative whole number of a nullable SMALLINT column. */
const smallCountField = z.int().min(0).max(32_767);

/** The answer letters of an indicator: a = 4, b = 3, c = 2, d = 1. */
export const ANSWER_LETTERS = Object.freeze(['a', 'b', 'c', 'd'] as const);

export type AnswerLetter = (typeof ANSWER_LETTERS)[number];

export const LetterSchema = z.enum(ANSWER_LETTERS);

/** A note printed beside a value: a shared message key and its parameters. */
export const NoteRefSchema = z.strictObject({
  key: z.string().min(1).max(128),
  params: z.record(z.string(), z.union([z.string(), z.number()])).optional(),
});

export type NoteRef = z.infer<typeof NoteRefSchema>;

/** The outcome of one standard of the school compliance tab. */
export const SNP_OUTCOMES = Object.freeze(['pass', 'fail', 'reported', 'not_evaluated', 'not_available'] as const);

export type SnpOutcome = (typeof SNP_OUTCOMES)[number];

export const SnpOutcomeSchema = z.enum(SNP_OUTCOMES);

/** The registration prerequisites: at least 1 000 titles, the NPP, the founding decree. */
export const PrerequisitesViewSchema = z.strictObject({
  titles: z.strictObject({ pass: z.boolean(), count: z.number(), asOf: z.string() }),
  npp: z.strictObject({ pass: z.boolean() }),
  foundingDecree: z.strictObject({ pass: z.boolean() }),
  met: z.boolean(),
});

export type PrerequisitesView = z.infer<typeof PrerequisitesViewSchema>;

// ---- profile -------------------------------------------------------------------------------------------------------

const optionalText = (max: number) => shortText(max).nullable().optional();

/** The shape of the profile (see {@link AccredProfile}). */
const profileShape = z.strictObject({
  npp: optionalText(32),
  status: z.enum(SCHOOL_STATUSES).nullable().optional(),
  foundedYear: z.int().min(1800).max(2100).nullable().optional(),
  foundingDecree: z
    .strictObject({ number: optionalText(64), date: dateField.nullable().optional(), issuer: optionalText(191) })
    .nullable()
    .optional(),
  schoolName: optionalText(191),
  schoolLevel: z.enum(SCHOOL_LEVELS).nullable().optional(),
  schoolHead: optionalText(191),
  libraryHead: optionalText(191),
  libraryHeadId: optionalText(32),
  address: z
    .strictObject({
      street: optionalText(191),
      village: optionalText(191),
      district: optionalText(191),
      regency: optionalText(191),
      province: optionalText(64),
      postalCode: optionalText(10),
    })
    .nullable()
    .optional(),
  phone: optionalText(32),
  website: httpUrlField(191).nullable().optional(),
  email: emailField.nullable().optional(),
  previousAccreditation: z
    .strictObject({
      grade: z.enum(['A', 'B', 'C']).nullable().optional(),
      year: z.int().min(1900).max(2100).nullable().optional(),
      certificateNo: optionalText(64),
    })
    .nullable()
    .optional(),
  certificateName: optionalText(191),
  profileVideoUrl: httpUrlField(500).nullable().optional(),
  /** The evidence files (JPEG) of the four profile photos. */
  photos: z
    .strictObject({
      front: ulidField.nullable().optional(),
      collection: ulidField.nullable().optional(),
      staff: ulidField.nullable().optional(),
      readingRoom: ulidField.nullable().optional(),
    })
    .nullable()
    .optional(),
  /** The features of a library website outside ALTIS (each once). */
  externalWebsiteFeatures: z
    .array(z.enum(L12_FEATURES))
    .max(L12_FEATURES.length)
    .check(
      z.check<string[]>((ctx) => {
        if (new Set(ctx.value).size !== ctx.value.length) ctx.issues.push({ code: 'custom', params: { code: 'duplicate' }, message: 'duplicate', input: ctx.value });
      }),
    )
    .nullable()
    .optional(),
});

/**
 * The institution's profile of a period (`accred_periods.profile`): every field optional or null. Its JSON is checked
 * against {@link ACCRED_PROFILE_MAX_BYTES} first (`too_big` at the profile), then its fields.
 */
export const AccredProfile = z.unknown().check(jsonBytesMax(ACCRED_PROFILE_MAX_BYTES)).pipe(profileShape);

export type AccredProfile = z.infer<typeof AccredProfile>;

// ---- periods -------------------------------------------------------------------------------------------------------

/**
 * `POST accreditation/periods`. The span comes from the kind: `startYear` (`school_year`, `calendar_year`), `endMonth`
 * (`rolling_12`), `startsOn` and `endsOn` (`custom`); the service checks which are needed. The profile and the
 * population are copied from `copyFromPeriodId`, else from the latest period.
 */
export const PeriodCreateBody = z.strictObject({
  name: shortText(191).min(1),
  instrumentId: z.string().min(1).max(32),
  kind: z.enum(PERIOD_KINDS),
  startYear: z.int().min(1900).max(2100).optional(),
  endMonth: monthField.optional(),
  startsOn: dateField.optional(),
  endsOn: dateField.optional(),
  branchId: libraryWideBranchField.optional(),
  profile: AccredProfile.optional(),
  copyFromPeriodId: ulidField.optional(),
});

export type PeriodCreateBody = z.infer<typeof PeriodCreateBody>;

/**
 * `PATCH accreditation/periods/:id`: only the fields sent change; null clears one. `teachersUsing` may not exceed
 * `teachers` (`{path: 'teachersUsing', code: 'too_big'}` when both are sent).
 */
export const PeriodPatchBody = z
  .strictObject({
    version: versionField,
    name: shortText(191).min(1).optional(),
    profile: AccredProfile.optional(),
    students: countField.nullable().optional(),
    teachers: countField.nullable().optional(),
    eduStaff: countField.nullable().optional(),
    classes: countField.nullable().optional(),
    populationServed: countField.nullable().optional(),
    teachersUsing: countField.nullable().optional(),
    allRegisteredConfirmed: z.boolean().optional(),
    userPcs: smallCountField.nullable().optional(),
    staffPcs: smallCountField.nullable().optional(),
    ictDevices: smallCountField.nullable().optional(),
    scanners: smallCountField.nullable().optional(),
    floorM2: countField.nullable().optional(),
    bandwidthMbps: countField.nullable().optional(),
    hoursPerWeek: z.int().min(0).max(168).nullable().optional(),
    services: z
      .array(z.enum(SERVICE_CODES))
      .max(SERVICE_CODES.length)
      .check(
        z.check<string[]>((ctx) => {
          if (new Set(ctx.value).size !== ctx.value.length) ctx.issues.push({ code: 'custom', params: { code: 'duplicate' }, message: 'duplicate', input: ctx.value });
        }),
      )
      .nullable()
      .optional(),
    externalWebsiteUrl: httpUrlField(191).nullable().optional(),
  })
  .check((ctx) => {
    const { teachers, teachersUsing } = ctx.value;
    if (typeof teachers === 'number' && typeof teachersUsing === 'number' && teachersUsing > teachers) {
      ctx.issues.push({ code: 'too_big', origin: 'number', maximum: teachers, inclusive: true, path: ['teachersUsing'], input: teachersUsing });
    }
  });

export type PeriodPatchBody = z.infer<typeof PeriodPatchBody>;

/** The SLiMS usage import a period last read. */
export interface UsageImportView {
  runId: string;
  finishedAt: number;
  cutoverOn: string | null;
}

/** `GET accreditation/periods/:id`. `stale`: something changed at or after `computedAt`, or nothing was computed. */
export interface PeriodView {
  id: string;
  name: string;
  instrumentId: string;
  kind: PeriodKind;
  startsOn: string;
  endsOn: string;
  branchId: null;
  profile: AccredProfile;
  students: number | null;
  teachers: number | null;
  eduStaff: number | null;
  classes: number | null;
  populationServed: number | null;
  teachersUsing: number | null;
  allRegisteredConfirmed: boolean;
  userPcs: number | null;
  staffPcs: number | null;
  ictDevices: number | null;
  scanners: number | null;
  floorM2: number | null;
  bandwidthMbps: number | null;
  hoursPerWeek: number | null;
  services: ServiceCode[] | null;
  externalWebsiteUrl: string | null;
  status: PeriodStatus;
  frozenAt: number | null;
  frozenBy: string | null;
  version: number;
  createdAt: number;
  updatedAt: number;
  lastChangeAt: number | null;
  computedAt: number | null;
  stale: boolean;
  catalogSyncedAt: number | null;
  lastUsageImport: UsageImportView | null;
}

export interface PeriodSummaryView {
  id: string;
  name: string;
  instrumentId: string;
  kind: PeriodKind;
  startsOn: string;
  endsOn: string;
  status: PeriodStatus;
  computedAt: number | null;
  stale: boolean;
}

/** `GET accreditation/periods`. */
export interface PeriodListResponse {
  periods: PeriodSummaryView[];
}

// ---- instruments ---------------------------------------------------------------------------------------------------

/** An evidence item of an indicator, as the workspace lists it. */
export interface IndicatorEvidenceView {
  code: string;
  labelKey: string;
  kind: EvidenceKind;
  primary: boolean;
  reportId: string | null;
  screen: string | null;
}

/** An indicator of an instrument; `code` is the catalogue code (`SCH-K1`), `officialNo` the decree's own number. */
export interface IndicatorView {
  code: string;
  officialNo: string;
  labelKey: string;
  manual: boolean;
  window: string;
  optionKeys: string[] | null;
  evidence: IndicatorEvidenceView[];
}

export interface InstrumentView {
  id: string;
  decree: string;
  effectiveFrom: string;
  sourceStatus: 'P' | 'P-copy' | 'U';
  libraryTypes: LibraryType[];
  schoolLevels: SchoolLevel[];
  periodKinds: PeriodKind[];
  defaultPeriodKind: PeriodKind;
  scored: boolean;
  components: { code: string; labelKey: string; weight: number; indicators: IndicatorView[] }[];
  snp: { code: string; labelKey: string }[];
}

/** The accreditation settings the workspace needs (it does not hold the settings permission). */
export interface AccreditationConfigView {
  libraryType: LibraryType | null;
  schoolYearStartMonth: number;
  usedUnit: UsedUnit;
  evidenceMaxMb: number;
  componentLimitMb: number;
  liveFrom: string | null;
  unknownMemberGroupDefault: AccredGroup | null;
  dedupeMinutes: number;
  dedupeLegacy: boolean;
}

/** `GET accreditation/instruments`. */
export interface InstrumentsResponse {
  instruments: InstrumentView[];
  config: AccreditationConfigView;
}

// ---- answers -------------------------------------------------------------------------------------------------------

/**
 * `PUT accreditation/periods/:id/answers/:code`. `manual`: an answer where ALTIS suggests none; `override`: an answer
 * over ALTIS's suggestion, which needs a note (`{path: 'note', code: 'required'}`). `answer: null` with `manual`
 * removes the answer.
 */
export const AnswerPutBody = z
  .strictObject({
    answer: LetterSchema.nullable(),
    mode: z.enum(['manual', 'override']),
    note: longText.nullable(),
  })
  .check((ctx) => {
    if (ctx.value.mode === 'override' && (ctx.value.note === null || ctx.value.note.trim() === '')) {
      ctx.issues.push({ code: 'custom', path: ['note'], params: { code: 'required' }, message: 'required', input: ctx.value.note });
    }
  });

export type AnswerPutBody = z.infer<typeof AnswerPutBody>;

// ---- monthly usage -------------------------------------------------------------------------------------------------

/** A group of a usage cell: `''` (total), a population group, or `guest`. */
export const USAGE_CELL_GROUP_KEY = /^(|grp:(student|teacher|edu_staff|public|other)|guest)$/;

/**
 * The metrics only an import counts, never a manual cell: the visits without a member's repeats are found by comparing
 * each member's check-ins, which a figure counted by hand cannot do (a librarian's own `visits` cell is what a month
 * counts, and it wins over the import's figures of that month).
 */
export const USAGE_IMPORT_ONLY_METRICS: readonly UsageMetric[] = Object.freeze(['visits_deduped']);

/**
 * `PUT accreditation/periods/:id/usage`: 1-500 cells. `month: null` is the period's whole span (for a span metric);
 * `value: null` removes the manual cell. A metric of {@link USAGE_IMPORT_ONLY_METRICS} is refused
 * (`cells.<i>.metric` `import_only`).
 */
export const UsagePutBody = z.strictObject({
  cells: z
    .array(
      z
        .strictObject({
          metric: z.enum(USAGE_METRICS),
          month: monthField.nullable(),
          groupKey: z.string().regex(USAGE_CELL_GROUP_KEY),
          value: z.int().min(0).max(SAFE_MAX).nullable(),
        })
        .check((ctx) => {
          if (USAGE_IMPORT_ONLY_METRICS.includes(ctx.value.metric)) {
            ctx.issues.push({ code: 'custom', path: ['metric'], params: { code: 'import_only' }, message: 'import_only', input: ctx.value.metric });
          }
        }),
    )
    .min(1)
    .max(USAGE_PUT_MAX_CELLS),
});

export type UsagePutBody = z.infer<typeof UsagePutBody>;

/** Where a usage cell's value comes from. */
export type UsageCellSource = 'manual' | 'slims' | 'none';

/** `GET accreditation/periods/:id/usage`. `spanTo` is set on a cell of a span metric. */
export interface UsageGridView {
  months: string[];
  metrics: UsageMetric[];
  groups: { key: string; label: string | null; accredGroup: AccredGroup | 'guest' | null }[];
  cells: { metric: UsageMetric; month: string | null; groupKey: string; value: number | null; source: UsageCellSource; spanTo: string | null }[];
  lastImport: UsageImportView | null;
}

/** `GET accreditation/usage-groups`: how a source system's member types count. */
export interface UsageGroupsView {
  groups: { groupKey: string; label: string | null; accredGroup: AccredGroup | null; updatedAt: number }[];
}

/** A member type of a source system (`slims_type:<id>`) or the members a source no longer has (`member_unknown`). */
export const USAGE_GROUP_MAP_KEY = /^(slims_type:[0-9A-Za-z_-]{1,36}|member_unknown)$/;

/** `PUT accreditation/usage-groups`: 1-200 rows. */
export const UsageGroupsPutBody = z.strictObject({
  groups: z
    .array(z.strictObject({ groupKey: z.string().regex(USAGE_GROUP_MAP_KEY), accredGroup: z.enum(ACCRED_GROUPS).nullable() }))
    .min(1)
    .max(USAGE_GROUPS_PUT_MAX),
});

export type UsageGroupsPutBody = z.infer<typeof UsageGroupsPutBody>;

// ---- registers -----------------------------------------------------------------------------------------------------

/** The five registers by the last segment of their routes. */
export const REGISTER_KINDS = Object.freeze(['activities', 'staff', 'partnerships', 'budgets', 'documents'] as const);

export type RegisterKind = (typeof REGISTER_KINDS)[number];

const activityFields = {
  kind: z.enum(ACTIVITY_KINDS),
  title: shortText(191).min(1),
  heldOn: dateField,
  endedOn: dateField.nullable().optional(),
  participants: countField.nullable().optional(),
  partner: optionalText(191),
  usesLibraryFacility: z.boolean(),
  externalSpeaker: z.boolean(),
  description: longText.nullable().optional(),
  branchId: libraryWideBranchField.optional(),
};

/** `POST accreditation/activities`. */
export const ActivityBody = z.strictObject(activityFields);
export type ActivityBody = z.infer<typeof ActivityBody>;
/** `PATCH accreditation/activities/:id`. */
export const ActivityPatchBody = z.strictObject({ version: versionField, ...partial(activityFields) });
export type ActivityPatchBody = z.infer<typeof ActivityPatchBody>;

const staffFields = {
  staffUserId: ulidField.nullable().optional(),
  name: shortText(191).min(1),
  position: optionalText(191),
  role: z.enum(STAFF_ROLES),
  isLibrarian: z.boolean(),
  employment: z.enum(EMPLOYMENTS).nullable().optional(),
  educationLevel: z.enum(EDUCATION_LEVELS).nullable().optional(),
  educationLibrary: z.boolean(),
  libraryTraining: z.boolean(),
  competencyCert: z.boolean(),
  associationMember: z.boolean(),
  appointmentRef: optionalText(191),
  startsOn: dateField,
  endsOn: dateField.nullable().optional(),
  branchId: libraryWideBranchField.optional(),
};

/** `POST accreditation/staff`. */
export const StaffBody = z.strictObject(staffFields);
export type StaffBody = z.infer<typeof StaffBody>;
/** `PATCH accreditation/staff/:id`. */
export const StaffPatchBody = z.strictObject({ version: versionField, ...partial(staffFields) });
export type StaffPatchBody = z.infer<typeof StaffPatchBody>;

const trainingFields = {
  title: shortText(191).min(1),
  organizer: optionalText(191),
  heldOn: dateField,
  hours: smallCountField.nullable().optional(),
  certificateUploadId: ulidField.nullable().optional(),
  branchId: libraryWideBranchField.optional(),
};

/** `POST accreditation/staff/:id/trainings`. */
export const TrainingBody = z.strictObject(trainingFields);
export type TrainingBody = z.infer<typeof TrainingBody>;
/** `PATCH accreditation/trainings/:id`. */
export const TrainingPatchBody = z.strictObject({ version: versionField, ...partial(trainingFields) });
export type TrainingPatchBody = z.infer<typeof TrainingPatchBody>;

const partnershipFields = {
  partner: shortText(191).min(1),
  kind: z.enum(PARTNERSHIP_KINDS),
  startsOn: dateField,
  endsOn: dateField.nullable().optional(),
  scope: longText.nullable().optional(),
  documentUploadId: ulidField.nullable().optional(),
  branchId: libraryWideBranchField.optional(),
};

/** `POST accreditation/partnerships`. */
export const PartnershipBody = z.strictObject(partnershipFields);
export type PartnershipBody = z.infer<typeof PartnershipBody>;
/** `PATCH accreditation/partnerships/:id`. */
export const PartnershipPatchBody = z.strictObject({ version: versionField, ...partial(partnershipFields) });
export type PartnershipPatchBody = z.infer<typeof PartnershipPatchBody>;

/** An amount in minor units (BIGINT), within the safe integers of JSON. */
const minorField = z.int().min(0).max(SAFE_MAX);

const budgetFields = {
  year: z.int().min(1900).max(2100),
  libraryMinor: minorField,
  parentMinor: minorField.nullable().optional(),
  parentNonpersonnelMinor: minorField.nullable().optional(),
  collectionMinor: minorField.nullable().optional(),
  communityMinor: minorField.nullable().optional(),
  currency: currencyField,
  note: longText.nullable().optional(),
  branchId: libraryWideBranchField.optional(),
};

/** `POST accreditation/budgets`. */
export const BudgetBody = z.strictObject(budgetFields);
export type BudgetBody = z.infer<typeof BudgetBody>;
/** `PATCH accreditation/budgets/:id`. */
export const BudgetPatchBody = z.strictObject({ version: versionField, ...partial(budgetFields) });
export type BudgetPatchBody = z.infer<typeof BudgetPatchBody>;

const documentFields = {
  kind: z.enum(DOCUMENT_KINDS),
  title: shortText(191).min(1),
  reference: optionalText(191),
  issuedOn: dateField.nullable().optional(),
  issuedBy: optionalText(191),
  aspectCodes: z.array(z.string().min(1).max(8)).max(16).nullable().optional(),
  validUntil: dateField.nullable().optional(),
  fileUploadId: ulidField.nullable().optional(),
  branchId: libraryWideBranchField.optional(),
};

/** The aspect codes of `value` that are not one of `DOCUMENT_ASPECTS[kind]`, as `{path: 'aspectCodes.<i>', code: 'invalid'}`. */
function aspectIssues(value: { kind?: DocumentKind | undefined; aspectCodes?: string[] | null | undefined }): z.core.$ZodRawIssue[] {
  const { kind, aspectCodes } = value;
  if (kind === undefined || aspectCodes === null || aspectCodes === undefined) return [];
  const allowed = DOCUMENT_ASPECTS[kind];
  return aspectCodes.flatMap((code, i) =>
    allowed.includes(code) ? [] : [{ code: 'custom' as const, path: ['aspectCodes', i], params: { code: 'invalid' }, message: 'invalid', input: code }],
  );
}

/** `POST accreditation/documents`. */
export const DocumentBody = z.strictObject(documentFields).check((ctx) => {
  ctx.issues.push(...aspectIssues(ctx.value));
});
export type DocumentBody = z.infer<typeof DocumentBody>;
/** `PATCH accreditation/documents/:id` (aspect codes sent without the kind are checked by the service against the stored kind). */
export const DocumentPatchBody = z.strictObject({ version: versionField, ...partial(documentFields) }).check((ctx) => {
  ctx.issues.push(...aspectIssues(ctx.value));
});
export type DocumentPatchBody = z.infer<typeof DocumentPatchBody>;

/** Every field of `fields` optional (a register patch). */
function partial<T extends Record<string, z.ZodType>>(fields: T): { [K in keyof T]: z.ZodOptional<T[K]> } {
  return Object.fromEntries(Object.entries(fields).map(([k, v]) => [k, v.optional()])) as { [K in keyof T]: z.ZodOptional<T[K]> };
}

/** The trail of a register row. */
export interface RegisterTrail {
  id: string;
  version: number;
  createdAt: number;
  createdBy: string | null;
  updatedAt: number;
  updatedBy: string | null;
}

export interface ActivityView extends RegisterTrail {
  kind: ActivityKind;
  title: string;
  heldOn: string;
  endedOn: string | null;
  participants: number | null;
  partner: string | null;
  usesLibraryFacility: boolean;
  externalSpeaker: boolean;
  description: string | null;
}

export interface TrainingView {
  id: string;
  staffId: string;
  title: string;
  organizer: string | null;
  heldOn: string;
  hours: number | null;
  certificateFileId: string | null;
  certificateFileName: string | null;
  version: number;
}

export interface StaffView extends RegisterTrail {
  staffUserId: string | null;
  name: string;
  position: string | null;
  role: StaffRole;
  isLibrarian: boolean;
  employment: Employment | null;
  educationLevel: EducationLevel | null;
  educationLibrary: boolean;
  libraryTraining: boolean;
  competencyCert: boolean;
  associationMember: boolean;
  appointmentRef: string | null;
  startsOn: string | null;
  endsOn: string | null;
  trainings: TrainingView[];
}

export interface PartnershipView extends RegisterTrail {
  partner: string;
  kind: PartnershipKind;
  startsOn: string;
  endsOn: string | null;
  scope: string | null;
  documentFileId: string | null;
  documentFileName: string | null;
}

export interface BudgetView extends RegisterTrail {
  year: number;
  libraryMinor: number;
  parentMinor: number | null;
  parentNonpersonnelMinor: number | null;
  collectionMinor: number | null;
  communityMinor: number | null;
  currency: string;
  note: string | null;
}

export interface DocumentView extends RegisterTrail {
  kind: DocumentKind;
  title: string;
  reference: string | null;
  issuedOn: string | null;
  issuedBy: string | null;
  aspectCodes: string[];
  validUntil: string | null;
  fileId: string | null;
  fileName: string | null;
}

// ---- evidence ------------------------------------------------------------------------------------------------------

/**
 * `POST accreditation/evidence`: an `accreditation.evidence` upload linked to a period's indicator or to a register
 * row. A period or an entity is required; `indicatorCode` needs `periodId`, `evidenceCode` needs `indicatorCode`, and an
 * entity goes with its id (each a `required` field error).
 */
export const EvidenceCreateBody = z
  .strictObject({
    uploadId: ulidField,
    periodId: ulidField.nullable().optional(),
    indicatorCode: z.string().min(1).max(16).nullable().optional(),
    evidenceCode: z.string().min(1).max(32).nullable().optional(),
    entity: z.enum(EVIDENCE_ENTITIES).nullable().optional(),
    entityId: ulidField.nullable().optional(),
    caption: shortText(191),
    sortOrder: sortOrderField.optional(),
  })
  .check((ctx) => {
    const v = ctx.value;
    const has = (x: unknown): boolean => x !== null && x !== undefined;
    const required = (path: string): void => {
      ctx.issues.push({ code: 'custom', path: [path], params: { code: 'required' }, message: 'required', input: undefined });
    };
    if (!has(v.periodId) && !has(v.entity)) required('periodId');
    else if (has(v.indicatorCode) && !has(v.periodId)) required('periodId');
    if (has(v.evidenceCode) && !has(v.indicatorCode)) required('indicatorCode');
    if (has(v.entity) !== has(v.entityId)) required(has(v.entity) ? 'entityId' : 'entity');
  });

export type EvidenceCreateBody = z.infer<typeof EvidenceCreateBody>;

export interface EvidenceView {
  id: string;
  periodId: string | null;
  indicatorCode: string | null;
  evidenceCode: string | null;
  entity: EvidenceEntity | null;
  entityId: string | null;
  fileId: string;
  fileName: string;
  size: number;
  mime: string;
  caption: string;
  sortOrder: number;
  createdAt: number;
}

/** The evidence components and the profile, by their codes. */
export type EvidenceComponent = 'K' | 'SP' | 'L' | 'T' | 'F' | 'G' | 'profil';

/** `GET accreditation/evidence`: the files, and the running size of each component's files. */
export interface EvidenceListResponse {
  evidence: EvidenceView[];
  componentBytes: Record<EvidenceComponent, number>;
}

// ---- the SLiMS usage import ----------------------------------------------------------------------------------------

/** A SLiMS database, read only. */
export const SlimsDbConfigBody = z.strictObject({
  host: z.string().trim().min(1).max(191),
  port: z.int().min(1).max(65_535),
  user: z.string().min(1).max(64),
  password: z.string().max(256),
  database: z.string().min(1).max(64),
  tls: z.boolean(),
});

export type SlimsDbConfigBody = z.infer<typeof SlimsDbConfigBody>;

/** `POST accreditation/slims-usage/test-connection`. */
export const SlimsUsageTestBody = z.strictObject({ db: SlimsDbConfigBody });

export type SlimsUsageTestBody = z.infer<typeof SlimsUsageTestBody>;

/** The answer of a connection test (a failure is a 200 with `ok: false`). */
export type SlimsUsageTestResponse =
  | {
      ok: true;
      tables: { name: string; rows: number | null }[];
      memberTypes: { id: string; name: string; guess: AccredGroup }[];
      months: { first: string; last: string } | null;
    }
  | { ok: false; code: string; reason: string | null };

/**
 * `POST accreditation/periods/:id/slims-usage`: the source (a database or a `accreditation.slims_dump` upload), the
 * day the library moved to ALTIS (`cutoverOn`: SLiMS counts end the day before), the member type mapping and the group
 * of members SLiMS no longer has.
 */
export const SlimsUsageStartBody = z.strictObject({
  source: z.discriminatedUnion('kind', [
    z.strictObject({ kind: z.literal('db'), db: SlimsDbConfigBody }),
    z.strictObject({ kind: z.literal('dump'), uploadId: ulidField }),
  ]),
  cutoverOn: dateField.nullable().optional(),
  memberTypeGroups: z
    .record(z.string().min(1).max(36), z.enum(ACCRED_GROUPS).nullable())
    .check(
      z.check<Record<string, unknown>>((ctx) => {
        if (Object.keys(ctx.value).length > USAGE_GROUPS_PUT_MAX) {
          ctx.issues.push({ code: 'custom', params: { code: 'too_big' }, message: 'too_big', input: ctx.value });
        }
      }),
    )
    .optional(),
  unknownMemberGroup: z.enum(ACCRED_GROUPS).nullable().optional(),
});

export type SlimsUsageStartBody = z.infer<typeof SlimsUsageStartBody>;

// ---- documents and freezing ----------------------------------------------------------------------------------------

/**
 * `POST accreditation/periods/:id/dossier`: the evidence file as a PDF, one ZIP, or one ZIP per component inside one
 * ZIP. `part: 'request_letter'` (only with `pdf`) makes the request letter alone.
 */
export const DossierBody = z
  .strictObject({
    format: z.enum(['pdf', 'zip', 'zip_components']),
    part: z.enum(['all', 'request_letter']).optional(),
  })
  .check((ctx) => {
    if (ctx.value.part === 'request_letter' && ctx.value.format !== 'pdf') {
      ctx.issues.push({ code: 'custom', path: ['part'], params: { code: 'invalid' }, message: 'invalid', input: ctx.value.part });
    }
  });

export type DossierBody = z.infer<typeof DossierBody>;

/** `POST accreditation/periods/:id/self-assessment`. */
export const SelfAssessmentBody = z.strictObject({});
export type SelfAssessmentBody = z.infer<typeof SelfAssessmentBody>;

/** `POST accreditation/periods/:id/statement-1000`. */
export const Statement1000Body = z.strictObject({});
export type Statement1000Body = z.infer<typeof Statement1000Body>;

/** `POST accreditation/periods/:id/freeze`. */
export const FreezeBody = z.strictObject({ note: shortText(191).nullable().optional() });
export type FreezeBody = z.infer<typeof FreezeBody>;

// ---- results and snapshots -----------------------------------------------------------------------------------------

/** An indicator's computed value, suggestion, answer and evidence, as the workspace shows it. */
export interface IndicatorResultView {
  code: string;
  officialNo: string;
  component: string;
  labelKey: string;
  metric: string | null;
  value: number | null;
  numerator: number | null;
  denominator: number | null;
  unit: string;
  basis: string;
  notes: NoteRef[];
  detail: { reportId: string; params: Record<string, unknown> } | null;
  table: (string | number)[][] | null;
  suggestion: AnswerLetter | null;
  suggest: boolean;
  answer: { answer: AnswerLetter | null; mode: 'manual' | 'override'; note: string | null; updatedAt: number; updatedBy: string | null } | null;
  final: AnswerLetter | null;
  evidence: { code: string; present: boolean; files: { id: string; name: string; caption: string }[] }[];
}

export interface SnpResultView {
  code: string;
  labelKey: string;
  outcome: SnpOutcome;
  value: number | null;
  rule: string;
  notes: NoteRef[];
}

/**
 * The estimated score: `na` (two decimals) only when every indicator is answered, else the range `naLow`…`naHigh`;
 * `grade` only with `na` and the prerequisites met. `gaps` are the largest ones, each `gap` with four decimals.
 */
export interface ScoreView {
  answered: number;
  total: number;
  perComponent: { code: string; sum: number; max: number; n: number; weight: number }[];
  na: string | null;
  naLow: string;
  naHigh: string;
  grade: 'A' | 'B' | 'C' | 'D' | null;
  gaps: { code: string; officialNo: string; component: string; gap: string; actionKey: string }[];
}

/** `GET accreditation/periods/:id/results`. */
export interface ResultsView {
  status: 'missing' | 'queued' | 'running' | 'ready' | 'failed';
  computedAt: number | null;
  changedAt: number | null;
  stale: boolean;
  jobId: string | null;
  prerequisites: PrerequisitesView | null;
  indicators: IndicatorResultView[];
  snp: SnpResultView[];
  score: ScoreView | null;
  missingEvidence: { component: string; items: { indicatorCode: string; officialNo: string; evidenceCode: string; labelKey: string }[] }[];
}

/**
 * The compact frozen values of a snapshot: per indicator its value, numerator, denominator, final answer, mode, basis
 * and note keys; per standard its outcome and value; the prerequisites; the missing evidence per component as
 * `<indicator code>.<evidence code>`.
 */
export interface CompactSnapshot {
  i: Record<string, { v: number | null; n: number | null; d: number | null; a: AnswerLetter | null; m: 'manual' | 'override' | 'computed' | null; b: string; k: string[] }>;
  s: Record<string, { o: string; v: number | null }>;
  p: PrerequisitesView;
  e: Record<string, string[]>;
}

export interface SnapshotView {
  id: string;
  periodId: string;
  instrumentId: string;
  na: string | null;
  naLow: string;
  naHigh: string;
  grade: 'A' | 'B' | 'C' | 'D' | null;
  prerequisitesMet: boolean;
  dossierFileId: string | null;
  note: string | null;
  createdAt: number;
  createdBy: string | null;
  values: CompactSnapshot;
}

/** `GET accreditation/periods/:id/snapshots`. */
export interface SnapshotListResponse {
  snapshots: Omit<SnapshotView, 'values'>[];
}
