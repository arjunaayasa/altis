import type { DB } from '@altis/db';
import { t, type AccredGroup, type MessageKey } from '@altis/shared';
import type { NoteRef } from '@altis/shared/api/accreditation';
import type { Kysely } from 'kysely';
import type { AccredSettings } from '../../settings/accreditation.js';
import { instrumentById } from '../instruments/index.js';
import { isSchoolInstrument } from '../periods/instruments-view.js';
import { slimsUsageRunSettings } from '../slims-usage/settings.js';
import type { AccredInstrument, AccredValueBasis } from '../types.js';
import type { ResolvedCell } from './index.js';
import { USAGE_GROUPS, type UsageGroup, type UsageRowSource, type UsageTable } from './resolve.js';

// What the usage metrics and the usage annexes compute alike: the school-month divisor (spec §10.5), the share of the
// school community's visits, the cells of one month of the series, and the small arithmetic they share. Every share and
// average is computed once, at the end, with whole numbers, and cut (never rounded).

/** The groups of the school community: their visits are the share's numerator. */
export const SCHOOL_GROUPS = Object.freeze(['student', 'teacher', 'edu_staff'] as const satisfies readonly AccredGroup[]);

export type SchoolGroup = (typeof SCHOOL_GROUPS)[number];

/** A school year counts this many school months; a year has twelve calendar months. */
const SCHOOL_YEAR_MONTHS = 10;
const YEAR_MONTHS = 12;

const isSchoolGroup = (g: UsageGroup): g is SchoolGroup => (SCHOOL_GROUPS as readonly string[]).includes(g);

/** `floor(num × 100 ÷ den)` exactly (non-negative `num`, positive `den`). */
export function floorPct(num: number, den: number): number {
  return Number((BigInt(num) * 100n) / BigInt(den));
}

/** `floor(num ÷ den)` exactly (non-negative `num`, positive `den`). */
export function floorDiv(num: number, den: number): number {
  return Number(BigInt(num) / BigInt(den));
}

/** `(num − base) × 100 ÷ base`, the decimals cut toward zero (a fall is negative); `base` positive. */
export function growthPct(num: number, base: number): number {
  return Number(((BigInt(num) - BigInt(base)) * 100n) / BigInt(base));
}

/**
 * The school-month divisor for `withData` calendar months with data: one school year is ten school months, so twelve
 * months give 10 and fewer are prorated, `ceil(10 × months ÷ 12)`; none give no divisor.
 */
export function schoolMonths(withData: number): number | null {
  if (withData <= 0) return null;
  return Math.floor((SCHOOL_YEAR_MONTHS * withData + YEAR_MONTHS - 1) / YEAR_MONTHS);
}

/** Whether the divisor of `withData` months is prorated (fewer months than a year). */
export const isProrated = (withData: number): boolean => withData < YEAR_MONTHS;

/** The note that prints the school-month divisor: the full one, or the prorated one with its months. */
export function divisorNote(withData: number, divisor: number): NoteRef {
  return isProrated(withData)
    ? { key: 'accred.note.school_months_prorated', params: { months: withData, divisor } }
    : { key: 'accred.note.school_months', params: { divisor } };
}

/** The school community of a period: students, teachers and education staff; null while any of them is not filled in. */
export function populationOf(p: { students: number | null; teachers: number | null; edu_staff: number | null }): number | null {
  if (p.students === null || p.teachers === null || p.edu_staff === null) return null;
  return Number(p.students) + Number(p.teachers) + Number(p.edu_staff);
}

/** Whether the library of a period is a school's: the library type, or a school instrument. */
export function isSchoolLibrary(instrument: AccredInstrument | string | null, settings: AccredSettings): boolean {
  const ins = typeof instrument === 'string' ? instrumentById(instrument) : instrument;
  return settings.libraryType === 'sekolah' || (ins !== null && isSchoolInstrument(ins));
}

/** The sources of `cells` that have data, manual first. */
export function sourcesOf(cells: Iterable<ResolvedCell>): UsageRowSource[] {
  const seen = new Set<UsageRowSource>();
  for (const c of cells) if (c.source !== 'none') seen.add(c.source);
  return (['manual', 'slims'] as const).filter((s) => seen.has(s));
}

/** The latest end of a cut span among `cells` (a cut-over month), or null. */
export function untilOf(cells: Iterable<ResolvedCell>): string | null {
  let out: string | null = null;
  for (const c of cells) if (c.spanTo !== null && (out === null || c.spanTo > out)) out = c.spanTo;
  return out;
}

/** Where a value comes from: no data, the SLiMS import (alone or with manual cells), or manual cells only. */
export function basisOf(sources: Iterable<UsageRowSource>): AccredValueBasis {
  const list = [...sources];
  if (list.length === 0) return 'none';
  return list.includes('slims') ? 'imported' : 'manual';
}

/** The cells of one month of the series: the visits counted of every group and their total, the loans and the uses. */
export interface UsageMonth {
  month: string;
  visits: Readonly<Record<UsageGroup | 'total', ResolvedCell>>;
  loans: ResolvedCell;
  uses: ResolvedCell;
}

export function usageMonth(table: UsageTable, month: string): UsageMonth {
  const visits = {} as Record<UsageGroup | 'total', ResolvedCell>;
  for (const g of USAGE_GROUPS) visits[g] = table.cell('visits', month, g);
  visits.total = table.cell('visits', month, 'total');
  return { month, visits, loans: table.cell('loans', month, 'total'), uses: table.cell('in_library_uses', month, 'total') };
}

/** Adds `cell` to a running sum that stays null until a cell has data. */
export const addCell = (sum: number | null, cell: ResolvedCell): number | null => (cell.value === null ? sum : (sum ?? 0) + cell.value);

/** The school community's visits over some months of a period, and the share of the decree's worked example. */
export interface SchoolVisits {
  /** Calendar months with a visits cell. */
  withData: number;
  divisor: number | null;
  /** Per school group: the visits counted (null: no cell). */
  byGroup: Readonly<Record<SchoolGroup, number | null>>;
  /** The visits counted of the school community (the numerator). */
  visits: number;
  /** The same with the raw visits of the import. */
  raw: number;
  guests: number;
  publicVisits: number;
  /** The visits of deleted members counted in a group. */
  memberUnknown: number;
  /** The sources of the visits cells read. */
  sources: readonly UsageRowSource[];
  population: number | null;
  /** `floor(visits × 100 ÷ (divisor × population))`, or null without a divisor or a population. */
  value: number | null;
  /** The division of `value` had decimals, cut. */
  cut: boolean;
}

export function schoolVisits(table: UsageTable, months: readonly string[], population: number | null): SchoolVisits {
  const withData = table.monthsWithDataIn('visits', months);
  const divisor = schoolMonths(withData);
  const rawTable = table.withDedupe(false);
  const byGroup: Record<SchoolGroup, number | null> = { student: null, teacher: null, edu_staff: null };
  let visits = 0;
  let raw = 0;
  let guests = 0;
  let publicVisits = 0;
  const cells: ResolvedCell[] = [];
  for (const m of months) {
    for (const g of USAGE_GROUPS) {
      const c = table.cell('visits', m, g);
      cells.push(c);
      if (c.value === null) continue;
      if (isSchoolGroup(g)) {
        visits += c.value;
        byGroup[g] = (byGroup[g] ?? 0) + c.value;
      } else if (g === 'guest') guests += c.value;
      else if (g === 'public') publicVisits += c.value;
    }
    for (const g of SCHOOL_GROUPS) raw += rawTable.cell('visits', m, g).value ?? 0;
  }
  const usable = divisor !== null && population !== null && population > 0;
  const value = usable ? floorPct(visits, divisor * population) : null;
  return {
    withData,
    divisor,
    byGroup,
    visits,
    raw,
    guests,
    publicVisits,
    memberUnknown: table.memberUnknownIn('visits', months),
    sources: sourcesOf(cells),
    population,
    value,
    cut: usable && (visits * 100) % (divisor * population) !== 0,
  };
}

/** The label of a population group in the language of the documents, in lower case (inside a sentence). */
export const groupWord = (g: AccredGroup): string => t('id', `vocab.accred_group.${g}` as MessageKey).toLowerCase();

/** The repeat window of the latest SLiMS usage import (in minutes), or `fallback` when there is none or it is unreadable. */
export async function importedDedupeMinutes(db: Kysely<DB>, fallback: number): Promise<number> {
  const r = await db
    .selectFrom('catalog_runs')
    .select('options')
    .where('kind', '=', 'slims_usage')
    .where('status', '=', 'succeeded')
    .where('dry_run', '=', 0)
    .where('finished_at', 'is not', null)
    .orderBy('finished_at', 'desc')
    .orderBy('id', 'desc')
    .limit(1)
    .executeTakeFirst();
  if (r === undefined) return fallback;
  try {
    const parsed = slimsUsageRunSettings.safeParse(JSON.parse(r.options));
    return parsed.success ? parsed.data.dedupeMinutes : fallback;
  } catch {
    return fallback;
  }
}
