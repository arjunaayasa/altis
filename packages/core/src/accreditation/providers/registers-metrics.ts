import { countRows, type AccredPeriodsTable, type DB } from '@altis/db';
import { DOCUMENT_ASPECTS, DomainError, localDate, t, type DocumentKind, type Locale, type MessageKey } from '@altis/shared';
import type { NoteRef } from '@altis/shared/api/accreditation';
import type { Kysely, Selectable } from 'kysely';
import type { ReportCtx } from '../../reports/types.js';
import { ACCRED_METRICS, type AccredMetricId } from '../metric-ids.js';
import type { AccredNoteKey } from '../notes.js';
import { routineFacts, type RoutineSliceCounts } from '../scoring/rules.js';
import type { AccredMetricContext, AccredMetricValue, AccredValueBasis } from '../types.js';
import { budgetYears, resolveWindow, snapshotDate, type DateSpan } from '../windows.js';

// The metrics of the five registers (activities, staff and their trainings, partnerships, budgets, documents) and the
// reads the register annexes share with them. Every read is bounded by the size of its register (a school library's
// registers hold hundreds of rows), so the provider answers in one call.
//
// - An activity counts once, by the day it was held, in the window of its metric; archived rows never count. The
//   learning item also counts a row of any kind held with the library's facilities, the outside-literacy item a row of
//   any kind with an outside speaker (one activity may count for its own kind and for such an item).
// - A register with no live row at all has not been started: its metrics give no value and say the register is empty.
//   Once it has one row, a count of 0 is a real 0.
// - A document is current at the snapshot date D when it is issued by then (or undated) and still valid then (or
//   without an end); "in a window" means issued in it (undated documents are never in a window).
// - Staff are active at the period's end: started by its last day (or with no start recorded) and not ended before
//   it. Only their trainings count.
// - A partner counts once over every agreement (any kind) that overlaps the window, by its name folded to lower case
//   without accents or repeated spaces.
// - The budget share is the exact mean of the three yearly shares library ÷ parent budget without staff and upkeep,
//   computed with BigInt and cut once; a missing year, or one without that parent budget, gives no value.
// - Percentages and ratios are cut to whole numbers once, at the end, and say so in their notes.
//
// The notes' parameters are Indonesian text: the documents that print them are always Indonesian.

/** The Indonesian names of the registers, for the note that one is empty. */
export const REGISTER_NAMES = Object.freeze({
  activities: 'Kegiatan',
  staff: 'Tenaga',
  partnerships: 'Kerja Sama',
  budgets: 'Anggaran',
  documents: 'Dokumen',
} as const);

/** The register tables. */
type RegisterTable = 'library_activities' | 'library_staff' | 'library_partnerships' | 'library_budgets' | 'library_documents';

const TABLE_REGISTER: Readonly<Record<RegisterTable, keyof typeof REGISTER_NAMES>> = Object.freeze({
  library_activities: 'activities',
  library_staff: 'staff',
  library_partnerships: 'partnerships',
  library_budgets: 'budgets',
  library_documents: 'documents',
});

/** The fields named when a staff entry the metrics need is missing. */
const STAFF_PCS_FIELD = 'jumlah komputer untuk tenaga perpustakaan';

type NoteName<K> = K extends `accred.note.${infer N}` ? N : never;

/** A note of the catalogue by its short name. */
export function note(name: NoteName<AccredNoteKey>, params?: Readonly<Record<string, string | number>>): NoteRef {
  return params === undefined ? { key: `accred.note.${name}` } : { key: `accred.note.${name}`, params: { ...params } };
}

/** The note that `table` has not been started. */
function registerEmpty(table: RegisterTable): NoteRef {
  return note('register_empty', { register: REGISTER_NAMES[TABLE_REGISTER[table]] });
}

/** A value of metric `id` with its catalogue unit. */
export function metricValue(
  id: AccredMetricId,
  value: number | null,
  basis: AccredValueBasis,
  o: Omit<Partial<AccredMetricValue>, 'value' | 'unit' | 'basis'> = {},
): AccredMetricValue {
  const v: AccredMetricValue = { value, unit: ACCRED_METRICS[id].unit, basis, notes: o.notes ?? [] };
  if (o.numerator !== undefined) v.numerator = o.numerator;
  if (o.denominator !== undefined) v.denominator = o.denominator;
  if (o.detail !== undefined) v.detail = o.detail;
  if (o.table !== undefined) v.table = o.table;
  if (o.facts !== undefined) v.facts = o.facts;
  if (o.suggest !== undefined) v.suggest = o.suggest;
  return v;
}

/** `floor(a ÷ b)` of two non-negative integers, exactly (b > 0). */
export function intDiv(a: number, b: number): number {
  return Number(BigInt(a) / BigInt(b));
}

const inSpan = (date: string | null, span: DateSpan): boolean => date !== null && date >= span.from && date <= span.to;

const flag = (v: unknown): boolean => Number(v) === 1;

/** The period's dates as the windows read them. */
export const periodDates = (p: Pick<Selectable<AccredPeriodsTable>, 'starts_on' | 'ends_on'>): { startsOn: string; endsOn: string } => ({
  startsOn: p.starts_on,
  endsOn: p.ends_on,
});

/** The school community of a period (students, teachers, education staff), or null while a part is missing. */
export function periodPopulation(p: Pick<Selectable<AccredPeriodsTable>, 'students' | 'teachers' | 'edu_staff'>): number | null {
  if (p.students === null || p.teachers === null || p.edu_staff === null) return null;
  return Number(p.students) + Number(p.teachers) + Number(p.edu_staff);
}

/** Whether `table` has at least one live row. */
export async function registerStarted(db: Kysely<DB>, table: RegisterTable): Promise<boolean> {
  const row = await db
    .selectFrom(table as 'library_activities')
    .select('id')
    .where('archived_at', 'is', null)
    .limit(1)
    .executeTakeFirst();
  return row !== undefined;
}

// ---- activities --------------------------------------------------------------------------------------------------

/** The kind the learning item counts, besides the rows held with the library's facilities. */
export const LEARNING_KIND = 'learning_session';
/** The kind the outside-literacy item counts, besides the rows with an outside speaker. */
export const EXTERNAL_LITERACY_KIND = 'external_literacy';

interface ActivityRow {
  id: string;
  kind: string;
  held_on: string;
  uses_library_facility: number;
  external_speaker: number;
}

/** Whether an activity counts for the learning item. */
export const countsForLearning = (a: Pick<ActivityRow, 'kind' | 'uses_library_facility'>): boolean => a.kind === LEARNING_KIND || flag(a.uses_library_facility);
/** Whether an activity counts for the outside-literacy item. */
export const countsForExternalLiteracy = (a: Pick<ActivityRow, 'kind' | 'external_speaker'>): boolean =>
  a.kind === EXTERNAL_LITERACY_KIND || flag(a.external_speaker);

type ActivityMetricId = Extract<AccredMetricId, `registers.activities.${string}`>;

const ofKind = (kind: string) => ({ match: (a: ActivityRow) => a.kind === kind, detail: { kinds: [kind] } as Record<string, unknown> });

/** What each activity metric counts, and the parameters of the activities annex that lists it. */
const ACTIVITY_COUNTS: Readonly<Record<ActivityMetricId, { match(a: ActivityRow): boolean; detail: Record<string, unknown> }>> = Object.freeze({
  'registers.activities.needs_survey': ofKind('needs_survey'),
  'registers.activities.preservation_3p': { ...ofKind('preservation'), detail: { kinds: ['preservation'], window: 'three_periods' } },
  'registers.activities.learning': { match: countsForLearning, detail: { learning: true } },
  'registers.activities.reading_culture': ofKind('reading_culture'),
  'registers.activities.reading_guidance': ofKind('reading_guidance'),
  'registers.activities.writing_guidance': ofKind('writing_guidance'),
  'registers.activities.plagiarism_guidance': ofKind('plagiarism_guidance'),
  'registers.activities.innovation': ofKind('innovation'),
  'registers.activities.external_literacy': { match: countsForExternalLiteracy, detail: { externalLiteracy: true } },
  'registers.activities.satisfaction_survey': ofKind('satisfaction_survey'),
  'registers.activities.promotion': ofKind('promotion'),
});

const DAY_MS = 86_400_000;

/**
 * The OPAC news published in `span` (by the library's calendar): live, published, not dated ahead of `now`. The time
 * zones of the world lie within a day of UTC, so the rows are first narrowed to a day around the span.
 */
async function newsPublishedIn(db: Kysely<DB>, span: DateSpan, tz: string, now: number): Promise<number> {
  const rows = await db
    .selectFrom('pages')
    .select('published_at')
    .where('kind', '=', 'news')
    .where('status', '=', 'published')
    .where('archived_at', 'is', null)
    .where('published_at', 'is not', null)
    .where('published_at', '<=', now)
    .where('published_at', '>=', Date.parse(`${span.from}T00:00:00Z`) - DAY_MS)
    .where('published_at', '<', Date.parse(`${span.to}T00:00:00Z`) + 2 * DAY_MS)
    .execute();
  return rows.filter((r) => r.published_at !== null && inSpan(localDate(tz, Number(r.published_at)), span)).length;
}

/** The latest day an activity of `kind` was held, at `D` at the latest, or null. */
async function lastHeld(db: Kysely<DB>, kind: string, D: string): Promise<string | null> {
  const row = await db
    .selectFrom('library_activities')
    .select('held_on')
    .where('archived_at', 'is', null)
    .where('kind', '=', kind)
    .where('held_on', '<=', D)
    .orderBy('held_on', 'desc')
    .limit(1)
    .executeTakeFirst();
  return row?.held_on ?? null;
}

// ---- documents ---------------------------------------------------------------------------------------------------

interface DocumentRow {
  id: string;
  kind: string;
  issued_on: string | null;
  valid_until: string | null;
  aspect_codes: string | null;
}

/** Whether a document is current at `D`: issued by then (or undated) and valid then (or without an end). */
export const isCurrentDocument = (d: Pick<DocumentRow, 'issued_on' | 'valid_until'>, D: string): boolean =>
  (d.issued_on === null || d.issued_on <= D) && (d.valid_until === null || d.valid_until >= D);

/** The aspect codes a document of its kind may cover, in the instrument's order, among those it records. */
export function aspectsOf(d: Pick<DocumentRow, 'kind' | 'aspect_codes'>): string[] {
  const allowed = DOCUMENT_ASPECTS[d.kind as DocumentKind] ?? [];
  if (d.aspect_codes === null || allowed.length === 0) return [];
  let parsed: unknown;
  try {
    parsed = JSON.parse(d.aspect_codes);
  } catch {
    return [];
  }
  if (!Array.isArray(parsed)) return [];
  const have = new Set(parsed.filter((c): c is string => typeof c === 'string'));
  return allowed.filter((code) => have.has(code));
}

/** The kinds of the service procedures, in the instrument's order. */
const SERVICE_PROCEDURE_KINDS = Object.freeze(['rules', 'sop_membership', 'sop_loan', 'sop_return'] as const);
/** The kinds of the operating procedures, in the instrument's order. */
const OPERATING_PROCEDURE_KINDS = Object.freeze(['pos_collection', 'pos_organisation', 'pos_service', 'pos_preservation', 'pos_promotion', 'pos_partnership'] as const);
/** The report kinds of the report routine, by the name of their count in the routine's facts. */
const ROUTINE_KINDS = Object.freeze({
  annual: 'report_annual',
  semester: 'report_semester',
  quarterly: 'report_quarterly',
  monthly: 'report_monthly',
} as const satisfies Record<keyof RoutineSliceCounts, DocumentKind>);
const REPORT_KINDS: ReadonlySet<string> = new Set(Object.values(ROUTINE_KINDS));

// ---- staff -------------------------------------------------------------------------------------------------------

/** A staff member as the metrics and the staff annex read them. */
export interface StaffRow {
  id: string;
  name: string;
  position: string | null;
  role: string;
  is_librarian: number;
  employment: string | null;
  education_level: string | null;
  education_library: number;
  library_training: number;
  competency_cert: number;
  association_member: number;
  appointment_ref: string | null;
  starts_on: string | null;
  ends_on: string | null;
}

/** A staff member's place in the staff order: the day they started (none first), then id. */
export const staffKey = (s: Pick<StaffRow, 'starts_on' | 'id'>): [string, string] => [s.starts_on ?? '', s.id];

/** The staff active at `endsOn` (the period's last day), by the day they started, then id. */
export async function activeStaff(db: Kysely<DB>, endsOn: string): Promise<StaffRow[]> {
  const rows = await db
    .selectFrom('library_staff')
    .select([
      'id',
      'name',
      'position',
      'role',
      'is_librarian',
      'employment',
      'education_level',
      'education_library',
      'library_training',
      'competency_cert',
      'association_member',
      'appointment_ref',
      'starts_on',
      'ends_on',
    ])
    .where('archived_at', 'is', null)
    .where((eb) => eb.or([eb('starts_on', 'is', null), eb('starts_on', '<=', endsOn)]))
    .where((eb) => eb.or([eb('ends_on', 'is', null), eb('ends_on', '>=', endsOn)]))
    .execute();
  return rows
    .map((r) => ({ ...r, is_librarian: Number(r.is_librarian) } as StaffRow))
    .sort((a, b) => compareKeys(staffKey(a), staffKey(b)));
}

/** The live trainings of the staff `staffIds` held in `span`. */
export async function trainingsCount(db: Kysely<DB>, staffIds: readonly string[], span: DateSpan): Promise<number> {
  if (staffIds.length === 0) return 0;
  return countRows(
    db
      .selectFrom('staff_trainings')
      .where('archived_at', 'is', null)
      .where('library_staff_id', 'in', [...staffIds])
      .where('held_on', '>=', span.from)
      .where('held_on', '<=', span.to),
  );
}

/** The staff ratios of a period: what the staff indicators divide, and their quotients cut to whole numbers. */
export interface StaffRatios {
  active: number;
  librarians: number;
  population: number | null;
  populationPerStaff: number | null;
  staffPcs: number | null;
  staffPcsPct: number | null;
  /** Trainings of the active staff in the three periods. */
  trainings: number;
  trainingAvg: number | null;
}

/** The staff ratios of period `p` with the snapshot date `D`, for the active staff `staff`. */
export async function staffRatios(db: Kysely<DB>, p: Selectable<AccredPeriodsTable>, D: string, staff: readonly StaffRow[]): Promise<StaffRatios> {
  const active = staff.length;
  const population = periodPopulation(p);
  const staffPcs = p.staff_pcs === null ? null : Number(p.staff_pcs);
  const trainings = await trainingsCount(
    db,
    staff.map((s) => s.id),
    resolveWindow('three_periods', periodDates(p), D),
  );
  return {
    active,
    librarians: staff.filter((s) => flag(s.is_librarian)).length,
    population,
    populationPerStaff: population === null || active === 0 ? null : intDiv(population, active),
    staffPcs,
    staffPcsPct: staffPcs === null || active === 0 ? null : intDiv(staffPcs * 100, active),
    trainings,
    trainingAvg: active === 0 ? null : intDiv(trainings, active),
  };
}

// ---- partnerships ------------------------------------------------------------------------------------------------

/** A partner's name as one partner: decomposed, without accents, lower case, single spaces. */
export function partnerKey(name: string): string {
  return name.normalize('NFKD').replace(/\p{M}/gu, '').toLowerCase().replace(/\s+/g, ' ').trim();
}

interface PartnershipRow {
  partner: string;
  starts_on: string;
  ends_on: string | null;
}

/** Whether an agreement overlaps `span`. */
export const overlaps = (r: Pick<PartnershipRow, 'starts_on' | 'ends_on'>, span: DateSpan): boolean =>
  r.starts_on <= span.to && (r.ends_on === null || r.ends_on >= span.from);

const distinctPartners = (rows: readonly PartnershipRow[], span: DateSpan): number =>
  new Set(rows.filter((r) => overlaps(r, span)).map((r) => partnerKey(r.partner))).size;

// ---- budgets -----------------------------------------------------------------------------------------------------

/** A budget year of the whole library, in minor units. */
export interface BudgetRow {
  year: number;
  library: number;
  parent: number | null;
  parentNonpersonnel: number | null;
  collection: number | null;
  community: number | null;
  currency: string;
}

const numOrNull = (v: unknown): number | null => (v === null || v === undefined ? null : Number(v));

/** The live budget rows of the whole library for `years`, by year. */
export async function budgetRows(db: Kysely<DB>, years: readonly number[]): Promise<Map<number, BudgetRow>> {
  const rows = await db
    .selectFrom('library_budgets')
    .select(['year', 'library_minor', 'parent_minor', 'parent_nonpersonnel_minor', 'collection_minor', 'community_minor', 'currency'])
    .where('scope_key', '=', '')
    .where('archived_at', 'is', null)
    .where('year', 'in', [...years])
    .execute();
  return new Map(
    rows.map((r) => [
      Number(r.year),
      {
        year: Number(r.year),
        library: Number(r.library_minor),
        parent: numOrNull(r.parent_minor),
        parentNonpersonnel: numOrNull(r.parent_nonpersonnel_minor),
        collection: numOrNull(r.collection_minor),
        community: numOrNull(r.community_minor),
        currency: r.currency,
      },
    ]),
  );
}

/** The share library ÷ parent budget without staff and upkeep of one year, cut to a whole percent; null without that budget. */
export function budgetSharePct(b: BudgetRow | undefined): number | null {
  if (b === undefined || b.parentNonpersonnel === null || b.parentNonpersonnel <= 0) return null;
  return Number((BigInt(b.library) * 100n) / BigInt(b.parentNonpersonnel));
}

/**
 * The exact mean of the yearly shares of `rows`, cut once to a whole percent: floor(Σ (lib_y ÷ par_y) × 100 ÷ n),
 * as one fraction over the product of the parent budgets. Null when a year has no parent budget.
 */
export function budgetShareMean(rows: readonly (BudgetRow | undefined)[]): number | null {
  const pars: bigint[] = [];
  const libs: bigint[] = [];
  for (const b of rows) {
    if (b === undefined || b.parentNonpersonnel === null || b.parentNonpersonnel <= 0) return null;
    pars.push(BigInt(b.parentNonpersonnel));
    libs.push(BigInt(b.library));
  }
  if (pars.length === 0) return null;
  const product = pars.reduce((a, b) => a * b, 1n);
  let numerator = 0n;
  pars.forEach((par, i) => {
    numerator += libs[i]! * (product / par);
  });
  return Number((numerator * 100n) / (BigInt(pars.length) * product));
}

// ---- the provider --------------------------------------------------------------------------------------------------

type RegisterMetricId = Extract<AccredMetricId, `registers.${string}`>;

/** Each read once per call. */
function once<T>(fn: () => Promise<T>): () => Promise<T> {
  let p: Promise<T> | null = null;
  return () => (p ??= fn());
}

/** What the register metrics of one call read, each once. */
class RegisterReads {
  readonly dates: { startsOn: string; endsOn: string };
  private readonly startedCache = new Map<RegisterTable, Promise<boolean>>();

  constructor(readonly ctx: AccredMetricContext) {
    this.dates = periodDates(ctx.period);
  }

  get db(): Kysely<DB> {
    return this.ctx.db;
  }

  get D(): string {
    return this.ctx.D;
  }

  window(id: AccredMetricId) {
    return resolveWindow(ACCRED_METRICS[id].window, this.dates, this.D);
  }

  started(table: RegisterTable): Promise<boolean> {
    let p = this.startedCache.get(table);
    if (p === undefined) {
      p = registerStarted(this.db, table);
      this.startedCache.set(table, p);
    }
    return p;
  }

  /** The live activities from the earliest window start of these metrics to `D`. */
  readonly activities = once(async (): Promise<ActivityRow[]> => {
    const from = [this.window('registers.activities.preservation_3p').from, this.window('registers.stocktake_weeding_3y').from].sort()[0]!;
    const rows = await this.db
      .selectFrom('library_activities')
      .select(['id', 'kind', 'held_on', 'uses_library_facility', 'external_speaker'])
      .where('archived_at', 'is', null)
      .where('held_on', '>=', from)
      .where('held_on', '<=', this.D)
      .execute();
    return rows.map((r) => ({ ...r, uses_library_facility: Number(r.uses_library_facility), external_speaker: Number(r.external_speaker) }));
  });

  readonly documents = once(
    async (): Promise<DocumentRow[]> =>
      this.db.selectFrom('library_documents').select(['id', 'kind', 'issued_on', 'valid_until', 'aspect_codes']).where('archived_at', 'is', null).execute(),
  );

  readonly staff = once(() => activeStaff(this.db, this.dates.endsOn));

  readonly ratios = once(async () => staffRatios(this.db, this.ctx.period, this.D, await this.staff()));

  readonly partnerships = once(
    async (): Promise<PartnershipRow[]> =>
      this.db.selectFrom('library_partnerships').select(['partner', 'starts_on', 'ends_on']).where('archived_at', 'is', null).execute(),
  );

  readonly budgets = once(() => budgetRows(this.db, budgetYears(this.dates.endsOn)));

  readonly news = once(() => newsPublishedIn(this.db, this.window('registers.activities.promotion'), this.ctx.settings.timezone, this.ctx.now));

  detail(reportId: string, params: Record<string, unknown> = {}): { reportId: string; params: Record<string, unknown> } {
    return { reportId: `accreditation.annex.${reportId}`, params: { periodId: this.ctx.periodId, ...params } };
  }

  /** The current documents of `kind` at `D`. */
  async current(kind: string): Promise<DocumentRow[]> {
    return (await this.documents()).filter((d) => d.kind === kind && isCurrentDocument(d, this.D));
  }
}

const register = (id: AccredMetricId, value: number | null, o: Omit<Partial<AccredMetricValue>, 'value' | 'unit' | 'basis'> = {}): AccredMetricValue =>
  metricValue(id, value, 'register', o);

async function activityCount(r: RegisterReads, id: ActivityMetricId): Promise<AccredMetricValue> {
  const def = ACTIVITY_COUNTS[id];
  const notes: NoteRef[] = [];
  let facts: AccredMetricValue['facts'];
  if (id === 'registers.activities.promotion') {
    const news = await r.news();
    facts = { newsPublished: news };
    if (news > 0) notes.push(note('l13_news', { count: news }));
  }
  const detail = r.detail('activities', def.detail);
  if (!(await r.started('library_activities'))) return register(id, null, { notes: [registerEmpty('library_activities'), ...notes], detail, ...(facts && { facts }) });
  const w = r.window(id);
  const n = (await r.activities()).filter((a) => inSpan(a.held_on, w) && def.match(a)).length;
  return register(id, n, { notes, detail, ...(facts && { facts }) });
}

/** A count of elements found in the documents register (no value while it has not been started). */
async function documentElements(r: RegisterReads, id: AccredMetricId, elements: () => Promise<string[]>, kinds: readonly string[]): Promise<AccredMetricValue> {
  const detail = r.detail('documents', { kinds: [...kinds] });
  if (!(await r.started('library_documents'))) return register(id, null, { notes: [registerEmpty('library_documents')], detail });
  const found = await elements();
  return register(id, found.length, { facts: { elements: found }, detail });
}

/** The union of the aspects of `docs`, in the instrument's order of their kind. */
function aspectUnion(kind: DocumentKind, docs: readonly DocumentRow[]): string[] {
  const have = new Set(docs.flatMap((d) => aspectsOf(d)));
  return DOCUMENT_ASPECTS[kind].filter((code) => have.has(code));
}

async function kindsPresent(r: RegisterReads, kinds: readonly string[]): Promise<string[]> {
  const present = new Set((await r.documents()).filter((d) => isCurrentDocument(d, r.D)).map((d) => d.kind));
  return kinds.filter((k) => present.has(k));
}

const truncated = (): NoteRef[] => [note('truncated')];

/** Each register metric. */
const REGISTER_METRICS: Readonly<Record<RegisterMetricId, (r: RegisterReads, id: AccredMetricId) => Promise<AccredMetricValue>>> = Object.freeze({
  'registers.activities.needs_survey': (r: RegisterReads) => activityCount(r, 'registers.activities.needs_survey'),
  'registers.activities.preservation_3p': (r: RegisterReads) => activityCount(r, 'registers.activities.preservation_3p'),
  'registers.activities.learning': (r: RegisterReads) => activityCount(r, 'registers.activities.learning'),
  'registers.activities.reading_culture': (r: RegisterReads) => activityCount(r, 'registers.activities.reading_culture'),
  'registers.activities.reading_guidance': (r: RegisterReads) => activityCount(r, 'registers.activities.reading_guidance'),
  'registers.activities.writing_guidance': (r: RegisterReads) => activityCount(r, 'registers.activities.writing_guidance'),
  'registers.activities.plagiarism_guidance': (r: RegisterReads) => activityCount(r, 'registers.activities.plagiarism_guidance'),
  'registers.activities.innovation': (r: RegisterReads) => activityCount(r, 'registers.activities.innovation'),
  'registers.activities.external_literacy': (r: RegisterReads) => activityCount(r, 'registers.activities.external_literacy'),
  'registers.activities.satisfaction_survey': (r: RegisterReads) => activityCount(r, 'registers.activities.satisfaction_survey'),
  'registers.activities.promotion': (r: RegisterReads) => activityCount(r, 'registers.activities.promotion'),

  'registers.collection_policy_aspects': (r, id) =>
    documentElements(r, id, async () => aspectUnion('collection_policy', await r.current('collection_policy')), ['collection_policy']),
  'registers.library_program_aspects': (r, id) =>
    documentElements(r, id, async () => aspectUnion('library_program', await r.current('library_program')), ['library_program']),
  'registers.head_performance_aspects': (r, id) =>
    documentElements(
      r,
      id,
      async () => {
        const w = r.window(id);
        return aspectUnion('head_performance_report', (await r.documents()).filter((d) => d.kind === 'head_performance_report' && inSpan(d.issued_on, w)));
      },
      ['head_performance_report'],
    ),
  'registers.service_procedures': (r, id) => documentElements(r, id, () => kindsPresent(r, SERVICE_PROCEDURE_KINDS), SERVICE_PROCEDURE_KINDS),
  'registers.operating_procedures': (r, id) => documentElements(r, id, () => kindsPresent(r, OPERATING_PROCEDURE_KINDS), OPERATING_PROCEDURE_KINDS),

  'registers.legality_elements': async (r, id) => {
    const detail = r.detail('documents', { kinds: ['founding_decree', 'duties', 'org_structure'] });
    const npp = (r.ctx.profile.npp ?? '').trim() !== '';
    const started = await r.started('library_documents');
    if (!started && !npp) return register(id, null, { notes: [registerEmpty('library_documents')], detail });
    const docs = started ? await kindsPresent(r, ['founding_decree', 'duties', 'org_structure']) : [];
    const elements = ['founding_decree', 'npp', 'duties', 'org_structure'].filter((e) => (e === 'npp' ? npp : docs.includes(e)));
    return register(id, elements.length, { facts: { elements }, detail });
  },

  'registers.founding_decree_registered': async (r, id) => {
    const any = (await r.documents()).some((d) => d.kind === 'founding_decree');
    return register(id, any ? 1 : 0, { detail: r.detail('documents', { kinds: ['founding_decree'] }) });
  },

  'registers.report_routine_3p': async (r, id) => {
    const detail = r.detail('documents', { kinds: Object.values(ROUTINE_KINDS) });
    if (!(await r.started('library_documents'))) return register(id, null, { notes: [registerEmpty('library_documents')], detail });
    const reports = (await r.documents()).filter((d) => REPORT_KINDS.has(d.kind));
    const slices = r.window(id).slices ?? [];
    const counts = slices.map((s) => {
      const inSlice = reports.filter((d) => inSpan(d.issued_on, s));
      const count = (kind: string) => inSlice.filter((d) => d.kind === kind).length;
      return { annual: count(ROUTINE_KINDS.annual), semester: count(ROUTINE_KINDS.semester), quarterly: count(ROUTINE_KINDS.quarterly), monthly: count(ROUTINE_KINDS.monthly) };
    }) as [RoutineSliceCounts, RoutineSliceCounts, RoutineSliceCounts];
    const undated = reports.filter((d) => d.issued_on === null).length;
    const total = counts.reduce((n, c) => n + c.annual + c.semester + c.quarterly + c.monthly, 0);
    return register(id, total, { facts: routineFacts(counts, undated), detail });
  },

  'registers.partners_3p': async (r, id) => {
    const detail = r.detail('partnerships');
    if (!(await r.started('library_partnerships'))) return register(id, null, { notes: [registerEmpty('library_partnerships')], detail });
    return register(id, distinctPartners(await r.partnerships(), r.window(id)), { detail });
  },

  'registers.budget_share_3y': async (r, id) => {
    const years = budgetYears(r.dates.endsOn);
    const rows = await r.budgets();
    const table = years.map((y) => {
      const b = rows.get(y);
      return [y, b?.library ?? '', b?.parentNonpersonnel ?? '', budgetSharePct(b) ?? ''];
    });
    const value = budgetShareMean(years.map((y) => rows.get(y)));
    const detail = r.detail('budgets');
    if (value === null) return register(id, null, { notes: [note('budget_incomplete')], table, detail });
    return register(id, value, { notes: truncated(), table, detail });
  },

  'registers.budget_share_year': async (r, id) => {
    const b = (await r.budgets()).get(budgetYears(r.dates.endsOn)[2]);
    const value = budgetSharePct(b);
    const detail = r.detail('budgets');
    if (value === null || b === undefined) return register(id, null, { notes: [note('budget_incomplete')], detail });
    return register(id, value, { numerator: b.library, denominator: b.parentNonpersonnel!, notes: truncated(), detail });
  },

  'registers.profile_budget': async (r, id) => {
    const b = (await r.budgets()).get(budgetYears(r.dates.endsOn)[2]);
    if (b === undefined) return register(id, null, { notes: [note('budget_incomplete')] });
    return register(id, b.library, {
      table: [
        ['library_minor', b.library],
        ['community_minor', b.community ?? ''],
        ['collection_minor', b.collection ?? ''],
        ['parent_minor', b.parent ?? ''],
        ['currency', b.currency],
      ],
    });
  },

  'registers.active_staff': async (r, id) => {
    const detail = r.detail('staff', { section: 'staff' });
    if (!(await r.started('library_staff'))) return register(id, null, { notes: [registerEmpty('library_staff')], detail });
    const n = (await r.staff()).length;
    return register(id, n, { notes: n === 0 ? [note('staff_missing')] : [], detail });
  },

  'registers.staff_pcs_pct': async (r, id) => {
    const q = await r.ratios();
    const detail = r.detail('staff', { section: 'ratio' });
    const notes: NoteRef[] = [];
    if (q.staffPcs === null) notes.push(note('input_missing', { field: STAFF_PCS_FIELD }));
    if (q.active === 0) notes.push(note('staff_missing'));
    if (q.staffPcsPct === null || q.staffPcs === null) return register(id, null, { notes, detail });
    return register(id, q.staffPcsPct, { numerator: q.staffPcs, denominator: q.active, notes: truncated(), detail });
  },

  'registers.population_per_staff': async (r, id) => {
    const q = await r.ratios();
    const detail = r.detail('staff', { section: 'ratio' });
    const notes: NoteRef[] = [];
    if (q.population === null) notes.push(note('population_missing'));
    if (q.active === 0) notes.push(note('staff_missing'));
    if (q.populationPerStaff === null || q.population === null) return register(id, null, { notes, detail });
    return register(id, q.populationPerStaff, { numerator: q.population, denominator: q.active, notes: truncated(), detail });
  },

  'registers.training_avg_3p': async (r, id) => {
    const q = await r.ratios();
    const detail = r.detail('staff', { section: 'trainings', window: 'three_periods' });
    if (q.trainingAvg === null) return register(id, null, { notes: [note('staff_missing')], detail });
    return register(id, q.trainingAvg, { numerator: q.trainings, denominator: q.active, notes: truncated(), detail });
  },

  'registers.head_qualification': async (r, id) => {
    const detail = r.detail('staff', { section: 'staff' });
    const heads = (await r.staff()).filter((s) => s.role === 'head');
    // The head used is the one who started last (ties: the smallest id).
    const head = [...heads].sort((a, b) => compareKeys([b.starts_on ?? '', a.id], [a.starts_on ?? '', b.id]))[0];
    if (head === undefined) return register(id, null, { notes: [note('head_missing')], detail });
    return register(id, heads.length, {
      facts: {
        heads: heads.length,
        educationLevel: head.education_level,
        educationLibrary: flag(head.education_library),
        libraryTraining: flag(head.library_training),
      },
      detail,
    });
  },

  'registers.staff_roles': async (r, id) => {
    const staff = await r.staff();
    const detail = r.detail('staff', { section: 'staff' });
    if (staff.length === 0) return register(id, null, { notes: [note('staff_missing')], detail });
    const technical = staff.filter((s) => s.role === 'technical');
    return register(id, staff.length, {
      facts: {
        active: staff.length,
        librarians: staff.filter((s) => flag(s.is_librarian)).length,
        ict: staff.filter((s) => s.role === 'ict').length,
        technical: technical.length,
        technicalCertified: technical.filter((s) => flag(s.library_training) || flag(s.competency_cert)).length,
      },
      detail,
    });
  },

  'registers.profile_staff': async (r, id) => {
    const staff = await r.staff();
    const count = (pick: (s: StaffRow) => unknown) => staff.filter((s) => flag(pick(s))).length;
    return register(id, staff.length, {
      table: [
        ['total', staff.length],
        ['librarians', count((s) => s.is_librarian)],
        ['education_library', count((s) => s.education_library)],
        ['competency_cert', count((s) => s.competency_cert)],
        ['association_member', count((s) => s.association_member)],
      ],
    });
  },

  'registers.profile_counts': async (r, id) => {
    const period = resolveWindow('period', r.dates, r.D);
    const three = resolveWindow('three_periods', r.dates, r.D);
    const activities = await r.activities();
    const held = (kind: string, span: DateSpan) => activities.filter((a) => a.kind === kind && inSpan(a.held_on, span)).length;
    const partners = distinctPartners(await r.partnerships(), period);
    return register(id, partners, {
      table: [
        ['partners', partners],
        ['innovation', held('innovation', period)],
        ['uniqueness', held('uniqueness', period)],
        ['award', held('award', three)],
      ],
    });
  },

  'registers.stocktake_weeding_3y': async (r, id) => {
    const w = r.window(id);
    const n = (await r.activities()).filter((a) => (a.kind === 'stocktake' || a.kind === 'weeding') && inSpan(a.held_on, w)).length;
    const [lastStocktake, lastWeeding] = await Promise.all([lastHeld(r.db, 'stocktake', r.D), lastHeld(r.db, 'weeding', r.D)]);
    return register(id, n, { facts: { lastStocktake, lastWeeding }, detail: r.detail('activities', { kinds: ['stocktake', 'weeding'], window: 'three_periods' }) });
  },
});

/** The register metrics among `ids`, each computed once. */
export async function computeRegisterMetrics(ctx: AccredMetricContext, ids: readonly AccredMetricId[]): Promise<Map<AccredMetricId, AccredMetricValue>> {
  const reads = new RegisterReads(ctx);
  const out = new Map<AccredMetricId, AccredMetricValue>();
  for (const id of ids) {
    if (out.has(id)) continue;
    const fn = (REGISTER_METRICS as Partial<Record<AccredMetricId, (r: RegisterReads, id: AccredMetricId) => Promise<AccredMetricValue>>>)[id];
    if (fn !== undefined) out.set(id, await fn(reads, id));
  }
  return out;
}

// ---- the annexes' keyset pages -----------------------------------------------------------------------------------

/** Two keys `[date, id]` in order. */
export function compareKeys(a: readonly [string, string], b: readonly [string, string]): number {
  if (a[0] !== b[0]) return a[0] < b[0] ? -1 : 1;
  if (a[1] !== b[1]) return a[1] < b[1] ? -1 : 1;
  return 0;
}

/** A page cursor: the date (empty for none) and the id of the page's last row. */
const CURSOR = /^(\d{4}-\d{2}-\d{2}|)\|([0-9A-Z]{26})$/;

/** The cursor after the row `[date, id]`. */
export function keyCursor(date: string | null, id: string): string {
  return `${date ?? ''}|${id}`;
}

/** The refusal of a cursor this report did not give. */
export function badCursor(): DomainError {
  return new DomainError('VALIDATION_FAILED', {
    detail: 'Data yang dikirim tidak valid / The submitted data is not valid',
    meta: { errors: [{ path: 'cursor', code: 'invalid' }] },
  });
}

/** The key a cursor names, or null for the first page. */
export function parseKeyCursor(cursor: string | null): [string, string] | null {
  if (cursor === null) return null;
  const m = CURSOR.exec(cursor);
  if (m === null) throw badCursor();
  return [m[1]!, m[2]!];
}

/** A page of at most `limit` of `rows` (already in key order) after `after`, and the cursor of the next. */
export function pageAfter<T>(rows: readonly T[], keyOf: (row: T) => [string, string], after: [string, string] | null, limit: number): { page: T[]; next: string | null } {
  const rest = after === null ? rows : rows.filter((r) => compareKeys(keyOf(r), after) > 0);
  const page = rest.slice(0, limit);
  const last = page[page.length - 1];
  return { page, next: rest.length > limit && last !== undefined ? keyCursor(...keyOf(last)) : null };
}

/** The period an annex is run for and its snapshot date. */
export async function annexPeriod(ctx: ReportCtx): Promise<{ period: Selectable<AccredPeriodsTable>; D: string }> {
  const id = ctx.params['periodId'];
  const period =
    typeof id !== 'string'
      ? undefined
      : await ctx.db.selectFrom('accred_periods').selectAll().where('id', '=', id).where('archived_at', 'is', null).executeTakeFirst();
  if (period === undefined) throw new DomainError('NOT_FOUND', { detail: 'Periode akreditasi tidak ditemukan / The accreditation period was not found' });
  return { period, D: snapshotDate(period.ends_on, ctx.today) };
}

/**
 * A page of at most `limit` of the fixed rows of a one-page section (budget years, ratios). Its cursor is the index of
 * the next row (`#4`), so a small preview page still holds to its limit.
 */
export function pageFixed<T>(rows: readonly T[], cursor: string | null, limit: number): { page: T[]; next: string | null } {
  let start = 0;
  if (cursor !== null) {
    const m = /^#(\d{1,4})$/.exec(cursor);
    start = m === null ? -1 : Number(m[1]);
    if (start < 1 || start >= rows.length) throw badCursor();
  }
  const end = start + limit;
  return { page: rows.slice(start, end), next: end < rows.length ? `#${end}` : null };
}

/** A money amount in minor units as the major units a report cell shows (two decimals), or null. */
export function majorUnits(minor: number | null): number | null {
  return minor === null ? null : minor / 100;
}

/** The label of `value` of the vocabulary `list` (`vocab.<list>.<value>`), or the value itself when it has none. */
export function vocabLabel(locale: Locale, list: string, value: string | null): string | null {
  if (value === null) return null;
  const key = `vocab.${list}.${value}`;
  const text = t(locale, key as MessageKey);
  return text === key ? value : text;
}

/** A fixed row label of the register annexes (`report.row.registers.<name>`). */
export function rowLabel(locale: Locale, name: keyof typeof ANNEX_ROW_NAMES): string {
  return t(locale, ANNEX_ROW_NAMES[name]);
}

const ANNEX_ROW_NAMES = Object.freeze({
  yes: 'report.row.registers.yes',
  no: 'report.row.registers.no',
  education_library: 'report.row.registers.education_library',
  'ratio.active_staff': 'report.row.registers.ratio.active_staff',
  'ratio.librarians': 'report.row.registers.ratio.librarians',
  'ratio.population': 'report.row.registers.ratio.population',
  'ratio.population_per_staff': 'report.row.registers.ratio.population_per_staff',
  'ratio.staff_pcs': 'report.row.registers.ratio.staff_pcs',
  'ratio.staff_pcs_pct': 'report.row.registers.ratio.staff_pcs_pct',
  'ratio.trainings_3p': 'report.row.registers.ratio.trainings_3p',
  'ratio.training_avg_3p': 'report.row.registers.ratio.training_avg_3p',
  budget_mean: 'report.row.registers.budget_mean',
} as const satisfies Record<string, MessageKey>);

/** "Yes" or "no" for a flag column. */
export function yesNo(locale: Locale, v: unknown): string {
  return rowLabel(locale, flag(v) ? 'yes' : 'no');
}
