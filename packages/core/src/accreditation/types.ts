import type { AccredPeriodsTable, DB } from '@altis/db';
import type { EvidenceKind, PeriodKind, SchoolLevel, UsageMetric } from '@altis/shared';
import {
  LetterSchema,
  NoteRefSchema,
  PrerequisitesViewSchema,
  SnpOutcomeSchema,
  type AccredProfile,
  type AnswerLetter,
  type NoteRef,
} from '@altis/shared/api/accreditation';
import type { LibraryType } from '@altis/shared/api/settings';
import type { Kysely, Selectable } from 'kysely';
import { z } from 'zod';
import type { AccredSettings } from '../settings/accreditation.js';
import type { AccredMetricId, AccredProviderId } from './metric-ids.js';
import type { AccredNoteKey } from './notes.js';

// The accreditation instruments as data (spec §10.3) and the seam of the metric providers (§10.4).
//
// An instrument is a frozen module: its components and indicators, each with the metric it reads (none for a manual
// answer), the window that metric is measured over, the band that turns a value into a suggested answer, the evidence
// checklist and the keys of the notes it may print. A provider computes a set of metrics for a period, across slices
// when it needs them; the evaluation stores each value (`AccredResultPayload`) and the score is composed when it is read.

/** An answer letter: a = 4, b = 3, c = 2, d = 1. */
export type Letter = AnswerLetter;

/**
 * The span a metric is measured over (windows.ts resolves each against a period and the snapshot date `D`; every
 * window ends at `D` at the latest): the day `D`; the current state; the period; the three periods ending with it; the
 * three calendar years ending in the year the period ends; the three budget years ending then; the twelve months to
 * `D`; the three years to `D`; the period and the twelve months before it.
 */
export type AccredWindow =
  | 'snapshot'
  | 'current'
  | 'period'
  | 'three_periods'
  | 'three_calendar_years'
  | 'budget_years'
  | 'twelve_months'
  | 'three_years'
  | 'period_and_previous';

/** One band of a range: a value from `min` to `max` (both included, each optional) suggests `answer`. */
export type RangeBand = { answer: Letter; min?: number; max?: number };

/**
 * How a value becomes a suggestion: bands tested a → d (no match: d); bands picked by the size of another metric;
 * a rule over the value's facts; or no suggestion at all (the answer is chosen by hand).
 */
export type AccredBand =
  | { kind: 'range'; bands: readonly RangeBand[] }
  | { kind: 'sized_range'; sizeMetric: AccredMetricId; tiers: readonly { minSize: number; bands: readonly RangeBand[] }[] }
  | { kind: 'rule'; rule: 'k7' | 'l11' | 't1' | 't3' | 'g4' }
  | { kind: 'manual' };

/**
 * An item of an indicator's evidence checklist: a report ALTIS makes (`generated`, with its report and parameters), a
 * screenshot of an ALTIS screen, an uploaded file, a signed document or a photo. `primary`: the main evidence.
 */
export interface AccredEvidenceItem {
  code: string;
  labelKey: string;
  kind: EvidenceKind;
  primary?: boolean;
  reportId?: string;
  params?: Readonly<Record<string, unknown>>;
  screen?: string;
}

/**
 * An indicator. `code` is the concept key (`L8`; catalogue code `SCH-L8`), `officialNo` the number the decree of this
 * instrument prints. Without `metric` it is answered by hand. `mandatory`: element codes of the metric's facts that
 * must all be present, else the answer is d.
 */
export interface AccredIndicator {
  code: string;
  officialNo: string;
  labelKey: string;
  metric?: AccredMetricId;
  window: AccredWindow;
  band: AccredBand;
  mandatory?: readonly string[];
  metricParams?: Readonly<Record<string, unknown>>;
  evidence: readonly AccredEvidenceItem[];
  noteKeys?: readonly AccredNoteKey[];
  optionKeys?: readonly string[];
  actionKey: string;
}

export interface AccredComponent {
  code: 'K' | 'SP' | 'L' | 'T' | 'F' | 'G';
  labelKey: string;
  weight: number;
  indicators: readonly AccredIndicator[];
}

/** How a school standard is checked. */
export type SnpRule =
  | { kind: 'min'; value: number }
  | { kind: 'min_by_size'; sizeMetric: AccredMetricId; tiers: readonly { minSize: number; minPct: number }[] }
  | { kind: 'min_by_classes'; tiers: readonly { minClasses: number; maxClasses: number; min: number }[] }
  | { kind: 'ratio_target'; target: number }
  | { kind: 'named_and_min'; named: readonly string[]; min: number }
  | { kind: 'both_within'; years: number }
  | { kind: 'coverage' }
  | { kind: 'staff_by_classes'; above: number; minAbove: number; minElse: number }
  | { kind: 'reported' }
  | { kind: 'not_available' };

/** One standard of the school compliance tab (`SNP-S-01`). */
export interface SnpCheck {
  code: string;
  labelKey: string;
  metric: AccredMetricId | null;
  window: AccredWindow;
  rule: SnpRule;
  ruleKey: string;
}

/**
 * An instrument: its decree (short and full name), the day it applies from, how sure its transcription is, the library
 * types and school levels it is for, the period kinds it accepts and its default, its components and standards, the
 * forms it prints, and whether it is scored at all.
 */
export interface AccredInstrument {
  id: string;
  decree: string;
  decreeTitle: string;
  effectiveFrom: string;
  sourceStatus: 'P' | 'P-copy' | 'U';
  libraryTypes: readonly LibraryType[];
  schoolLevels?: readonly SchoolLevel[];
  periodKinds: readonly PeriodKind[];
  defaultPeriodKind(o: { libraryType: LibraryType | null; schoolLevel: SchoolLevel | null }): PeriodKind;
  components: readonly AccredComponent[];
  snp: readonly SnpCheck[];
  forms: readonly ('submission' | 'profile' | 'certificate_name')[];
  scored: boolean;
}

/** The value a provider computes for a metric. */
export type AccredMetricUnit = 'count' | 'percent' | 'ratio' | 'mbps' | 'years' | 'code';

/** Where a value comes from. */
export const ACCRED_VALUE_BASES = Object.freeze(['live', 'migrated', 'imported', 'manual', 'register', 'setting', 'members', 'none'] as const);

export type AccredValueBasis = (typeof ACCRED_VALUE_BASES)[number];

/**
 * A metric's value: null when there is no data (`notes` say why). Percentages and ratios are already truncated.
 * `facts` feed the rules and the mandatory elements (never stored in a snapshot); `suggest: false` prints the value
 * without suggesting an answer. `table` has at most 200 rows.
 */
export interface AccredMetricValue {
  value: number | null;
  numerator?: number;
  denominator?: number;
  unit: AccredMetricUnit;
  basis: AccredValueBasis;
  notes: readonly NoteRef[];
  detail?: { reportId: string; params: Record<string, unknown> };
  table?: readonly (readonly (string | number)[])[];
  facts?: Readonly<Record<string, number | string | boolean | null | readonly string[]>>;
  suggest?: false;
}

/** What a provider computes with: the period, its profile and instrument, the snapshot date `D` and the settings. */
export interface AccredMetricContext {
  db: Kysely<DB>;
  periodId: string;
  period: Selectable<AccredPeriodsTable>;
  profile: AccredProfile;
  instrument: AccredInstrument;
  /** The snapshot date: the period's end, or today while it lies ahead. */
  D: string;
  today: string;
  settings: AccredSettings;
  /** config.json's `baseUrl` (how reachable the system is), or null. */
  baseUrl: string | null;
  now: number;
  budgetLeftMs(): number;
  /** The `metricParams` the instrument's indicators give `metric` (empty when none). */
  paramsOf(metric: AccredMetricId): Readonly<Record<string, unknown>>;
}

/** Where a provider stopped: its JSON is at most 32 000 bytes. */
export type ProviderResume = { cursor: string; state: unknown };

/** One call of a provider: every value asked for, or where to go on in the next slice. */
export type ProviderStep = { done: true; values: ReadonlyMap<AccredMetricId, AccredMetricValue> } | { done: false; resume: ProviderResume };

export interface AccredMetricProvider {
  readonly id: AccredProviderId;
  readonly metrics: readonly AccredMetricId[];
  compute(ctx: AccredMetricContext, ids: readonly AccredMetricId[], resume: ProviderResume | null): Promise<ProviderStep>;
}

/** A source of a monthly usage metric, counted over a span (optionally for one group). */
export interface UsageSource {
  metric: UsageMetric;
  count(db: Kysely<DB>, span: { from: string; to: string }, o: { groupKey?: string }): Promise<number>;
}

/**
 * A stored metric value (`accred_results.payload`): {@link AccredMetricValue} without `facts`, its table possibly cut
 * (`tableTruncated`). Parsed on every read.
 */
export const AccredStoredValue = z.strictObject({
  value: z.number().nullable(),
  numerator: z.number().optional(),
  denominator: z.number().optional(),
  unit: z.enum(['count', 'percent', 'ratio', 'mbps', 'years', 'code']),
  basis: z.enum(ACCRED_VALUE_BASES),
  notes: z.array(NoteRefSchema),
  detail: z.strictObject({ reportId: z.string(), params: z.record(z.string(), z.unknown()) }).optional(),
  table: z.array(z.array(z.union([z.string(), z.number()]))).optional(),
  tableTruncated: z.literal(true).optional(),
  suggest: z.literal(false).optional(),
});

export type AccredStoredValue = z.infer<typeof AccredStoredValue>;

/**
 * The payload of a result row (`accred_results.payload`, JSON of at most 16 000 bytes): an indicator's value, size
 * value and suggestion with the scoring notes; a standard's value and outcome; or the prerequisites (the row
 * `SCH-PRASYARAT`).
 */
export const AccredResultPayload = z.discriminatedUnion('kind', [
  z.strictObject({
    kind: z.literal('indicator'),
    metric: z.string().nullable(),
    value: AccredStoredValue.nullable(),
    size: AccredStoredValue.nullable(),
    suggestion: LetterSchema.nullable(),
    notes: z.array(NoteRefSchema),
  }),
  z.strictObject({
    kind: z.literal('snp'),
    metric: z.string().nullable(),
    value: AccredStoredValue.nullable(),
    outcome: SnpOutcomeSchema,
    rule: z.string(),
    notes: z.array(NoteRefSchema),
  }),
  z.strictObject({ kind: z.literal('prerequisites'), prerequisites: PrerequisitesViewSchema, titles: AccredStoredValue }),
]);

export type AccredResultPayload = z.infer<typeof AccredResultPayload>;

/**
 * The payload of a period's `_meta` row: the evaluation's state, when it started (its `computedAt` once ready), the
 * job, how long it took and the prerequisites it found.
 */
export const AccredMetaPayload = z.strictObject({
  status: z.enum(['running', 'ready', 'failed']),
  startedAt: z.number(),
  jobId: z.string(),
  computedAt: z.number().optional(),
  durationMs: z.number().optional(),
  prerequisites: PrerequisitesViewSchema.optional(),
});

export type AccredMetaPayload = z.infer<typeof AccredMetaPayload>;
