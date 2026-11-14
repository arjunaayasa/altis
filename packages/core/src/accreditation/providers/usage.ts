import { addDays, addMonths } from '@altis/shared';
import type { NoteRef } from '@altis/shared/api/accreditation';
import { metricsOfProvider, type AccredMetricId } from '../metric-ids.js';
import type { AccredMetricContext, AccredMetricProvider, AccredMetricValue } from '../types.js';
import type { ResolvedCell } from '../usage/index.js';
import { loadUsageTable, monthsOfSpan, USAGE_GROUPS, type UsageRowSource, type UsageTable } from '../usage/resolve.js';
import {
  addCell,
  basisOf,
  divisorNote,
  floorDiv,
  groupWord,
  growthPct,
  importedDedupeMinutes,
  isSchoolLibrary,
  populationOf,
  schoolMonths,
  schoolVisits,
  sourcesOf,
  untilOf,
  usageMonth,
} from '../usage/series.js';
import { resolveWindow } from '../windows.js';

// The `usage` metric provider (spec §10.5, §10.7): the monthly usage table of the period, as manual cells and the SLiMS
// aggregate import store it (`usage_stats`; this edition registers no live usage source). It reads the table once, with
// the member-type mapping as it stands, and answers in one step:
// - `usage.school_months`: the school-month divisor, 10 for a year of data, prorated for fewer months, none without data;
// - `usage.school_visits_pct`: the school community's visits (students, teachers, education staff) × 100 ÷ (divisor ×
//   population), cut; guests and the public are printed apart, deleted members count in the group of their mapping;
// - `usage.monthly_series`: a row per month with the visits of every group, the loans, the uses in the library, the
//   sources of the month's cells and the end of a cut month (the annexes' table);
// - `usage.profile_averages`: visitors, uses in the library and loans per school month (per month with data outside a
//   school);
// - `usage.members_active`: the active members of the period's span, by group;
// - `usage.coverage`: the months with visits and the months with loans;
// - `usage.reading_interest`: visits and loans against the twelve months before, and visits per distinct visitor of
//   each span (read from the span rows, never a sum of monthly distinct counts).
// The months read end with the month of the snapshot date `D`; a span metric reads the rows of exactly the period's
// span (or of the twelve months before it).

const NO_DATA: NoteRef = { key: 'accred.note.usage_no_data' };

/** What every metric of one evaluation reads: the table, the months of the period up to `D`, the spans. */
interface UsageScope {
  ctx: AccredMetricContext;
  table: UsageTable;
  /** The months of the period, up to the month of `D`. */
  months: readonly string[];
  period: { from: string; to: string };
  previous: { from: string; to: string };
  school: boolean;
}

/** The table cell of a value: the number, or an empty text without data. */
const cellText = (value: number | null): string | number => value ?? '';

function schoolMonthsValue(s: UsageScope): AccredMetricValue {
  const withData = s.table.monthsWithDataIn('visits', s.months);
  const divisor = schoolMonths(withData);
  if (divisor === null) return { value: null, unit: 'count', basis: 'none', notes: [NO_DATA], facts: { monthsWithData: 0, divisor: null } };
  const sources = sourcesOf(s.months.flatMap((m) => Object.values(usageMonth(s.table, m).visits)));
  return { value: divisor, unit: 'count', basis: basisOf(sources), notes: [divisorNote(withData, divisor)], facts: { monthsWithData: withData, divisor } };
}

async function schoolVisitsValue(s: UsageScope): Promise<AccredMetricValue> {
  const population = populationOf(s.ctx.period);
  const v = schoolVisits(s.table, s.months, population);
  const notes: NoteRef[] = [v.divisor === null ? NO_DATA : divisorNote(v.withData, v.divisor)];
  const unknownGroup = s.table.unknownGroup;
  if (v.memberUnknown > 0 && unknownGroup !== null) {
    notes.push({ key: 'accred.note.member_unknown', params: { count: v.memberUnknown, group: groupWord(unknownGroup) } });
  }
  if (s.table.dedupe && v.sources.includes('slims')) {
    const minutes = await importedDedupeMinutes(s.ctx.db, s.ctx.settings.dedupeMinutes);
    notes.push({ key: 'accred.note.visits_deduped', params: { minutes, raw: v.raw } });
  }
  if (v.guests + v.publicVisits > 0) notes.push({ key: 'accred.note.guests_excluded', params: { count: v.guests + v.publicVisits } });
  if (population === null || population === 0) notes.push({ key: 'accred.note.population_missing' });
  if (v.cut) notes.push({ key: 'accred.note.truncated' });
  const out: AccredMetricValue = {
    value: v.value,
    unit: 'percent',
    basis: basisOf(v.sources),
    notes,
    detail: { reportId: 'accreditation.annex.l14', params: { periodId: s.ctx.periodId } },
    facts: {
      visits: v.visits,
      raw: v.raw,
      guests: v.guests,
      publicVisits: v.publicVisits,
      memberUnknown: v.memberUnknown,
      divisor: v.divisor,
      population,
    },
  };
  if (v.value !== null && v.divisor !== null && population !== null) {
    out.numerator = v.visits;
    out.denominator = v.divisor * population;
  }
  return out;
}

function monthlySeriesValue(s: UsageScope): AccredMetricValue {
  const table: (string | number)[][] = [];
  const all: UsageRowSource[] = [];
  let total = 0;
  for (const m of s.months) {
    const u = usageMonth(s.table, m);
    const cells = [...Object.values(u.visits), u.loans, u.uses];
    const sources = sourcesOf(cells);
    all.push(...sources);
    total += u.visits.total.value ?? 0;
    table.push([
      m,
      cellText(u.visits.student.value),
      cellText(u.visits.teacher.value),
      cellText(u.visits.edu_staff.value),
      cellText(u.visits.public.value),
      cellText(u.visits.other.value),
      cellText(u.visits.guest.value),
      cellText(u.loans.value),
      cellText(u.uses.value),
      sources.length === 0 ? 'none' : sources.join('+'),
      untilOf(cells) ?? '',
    ]);
  }
  return {
    value: total,
    unit: 'count',
    basis: basisOf(all),
    notes: [],
    detail: { reportId: 'accreditation.annex.usage_monthly', params: { periodId: s.ctx.periodId } },
    table,
  };
}

function profileAveragesValue(s: UsageScope): AccredMetricValue {
  const withData = s.table.monthsWithDataIn('visits', s.months);
  const divisor = s.school ? schoolMonths(withData) : withData > 0 ? withData : null;
  if (divisor === null) return { value: null, unit: 'count', basis: 'none', notes: [NO_DATA], facts: { divisor: null, monthsWithData: 0, school: s.school } };
  let visitors: number | null = null;
  let uses: number | null = null;
  let loans: number | null = null;
  const cells: ResolvedCell[] = [];
  for (const m of s.months) {
    const u = usageMonth(s.table, m);
    visitors = addCell(visitors, u.visits.total);
    uses = addCell(uses, u.uses);
    loans = addCell(loans, u.loans);
    cells.push(u.visits.total, u.uses, u.loans);
  }
  const row = (key: string, n: number | null): (string | number)[] => [key, n ?? 0, floorDiv(n ?? 0, divisor)];
  return {
    value: floorDiv(visitors ?? 0, divisor),
    unit: 'count',
    basis: basisOf(sourcesOf(cells)),
    notes: s.school ? [divisorNote(withData, divisor)] : [],
    table: [row('visitors', visitors), row('in_library_uses', uses), row('loans', loans)],
    facts: { divisor, monthsWithData: withData, school: s.school },
  };
}

function membersActiveValue(s: UsageScope): AccredMetricValue {
  const total = s.table.spanValue('members_active', s.period);
  if (total.value === null) return { value: null, unit: 'count', basis: 'none', notes: [NO_DATA] };
  const table: (string | number)[][] = [];
  for (const g of USAGE_GROUPS) {
    const c = s.table.spanCell('members_active', s.period, g);
    if (c.value !== null) table.push([g, c.value]);
  }
  return { value: total.value, unit: 'count', basis: basisOf(sourcesOf([total])), notes: [], table };
}

function coverageValue(s: UsageScope): AccredMetricValue {
  const visitMonths = s.table.monthsWithDataIn('visits', s.months);
  const loanMonths = s.table.monthsWithDataIn('loans', s.months);
  const cells = s.months.flatMap((m) => [s.table.cell('visits', m, 'total'), s.table.cell('loans', m, 'total')]);
  return {
    value: visitMonths,
    unit: 'count',
    basis: basisOf(sourcesOf(cells)),
    notes: [],
    table: [
      ['visits', visitMonths],
      ['loans', loanMonths],
    ],
    facts: { visitMonths, loanMonths },
  };
}

/** The total cells of `metric` over `months` and their sum (null when none has data). */
function totalOver(t: UsageTable, metric: 'visits' | 'loans', months: readonly string[]): { sum: number | null; cells: ResolvedCell[] } {
  const cells = months.map((m) => t.cell(metric, m, 'total'));
  return { sum: cells.reduce<number | null>(addCell, null), cells };
}

function readingInterestValue(s: UsageScope): AccredMetricValue {
  const previousMonths = monthsOfSpan(s.previous.from, s.previous.to);
  const visits = totalOver(s.table, 'visits', s.months);
  const visitsBefore = totalOver(s.table, 'visits', previousMonths);
  const loans = totalOver(s.table, 'loans', s.months);
  const loansBefore = totalOver(s.table, 'loans', previousMonths);
  const distinct = s.table.spanValue('distinct_visitors', s.period);
  const distinctBefore = s.table.spanValue('distinct_visitors', s.previous);
  const sources = sourcesOf([...visits.cells, ...visitsBefore.cells, ...loans.cells, ...loansBefore.cells, distinct, distinctBefore]);
  const v = visits.sum ?? 0;
  const v0 = visitsBefore.sum ?? 0;
  if (v0 === 0 || distinct.value === null || distinctBefore.value === null) {
    return { value: null, unit: 'percent', basis: basisOf(sources), notes: [{ key: 'accred.note.snp_no_previous' }] };
  }
  const l = loans.sum ?? 0;
  const l0 = loansBefore.sum ?? 0;
  const visitsGrowth = growthPct(v, v0);
  const loansGrowth = l0 > 0 ? growthPct(l, l0) : null;
  const frequency = distinct.value > 0 ? floorDiv(v, distinct.value) : null;
  const frequencyBefore = distinctBefore.value > 0 ? floorDiv(v0, distinctBefore.value) : null;
  return {
    value: visitsGrowth,
    unit: 'percent',
    basis: basisOf(sources),
    notes: [],
    table: [
      ['visits', v0, v, visitsGrowth],
      ['loans', l0, l, loansGrowth ?? ''],
      ['frequency', frequencyBefore ?? '', frequency ?? '', ''],
    ],
    facts: {
      visits: v,
      visitsPrevious: v0,
      visitsGrowth,
      loans: l,
      loansPrevious: l0,
      loansGrowth,
      distinctVisitors: distinct.value,
      distinctVisitorsPrevious: distinctBefore.value,
      frequency,
      frequencyPrevious: frequencyBefore,
    },
  };
}

async function compute(ctx: AccredMetricContext, ids: readonly AccredMetricId[]): Promise<Map<AccredMetricId, AccredMetricValue>> {
  const span = { startsOn: ctx.period.starts_on, endsOn: ctx.period.ends_on };
  const window = resolveWindow('period', span, ctx.D);
  const period = { from: span.startsOn, to: span.endsOn };
  const previous = { from: addMonths(span.startsOn, -12), to: addDays(span.startsOn, -1) };
  const from = ids.includes('usage.reading_interest') ? previous.from : period.from;
  const scope: UsageScope = {
    ctx,
    table: await loadUsageTable(ctx.db, { from, to: period.to }, ctx.settings),
    months: monthsOfSpan(window.from, window.to),
    period,
    previous,
    school: isSchoolLibrary(ctx.instrument, ctx.settings),
  };
  const values = new Map<AccredMetricId, AccredMetricValue>();
  for (const id of ids) {
    switch (id) {
      case 'usage.school_months':
        values.set(id, schoolMonthsValue(scope));
        break;
      case 'usage.school_visits_pct':
        values.set(id, await schoolVisitsValue(scope));
        break;
      case 'usage.monthly_series':
        values.set(id, monthlySeriesValue(scope));
        break;
      case 'usage.profile_averages':
        values.set(id, profileAveragesValue(scope));
        break;
      case 'usage.members_active':
        values.set(id, membersActiveValue(scope));
        break;
      case 'usage.coverage':
        values.set(id, coverageValue(scope));
        break;
      case 'usage.reading_interest':
        values.set(id, readingInterestValue(scope));
        break;
      default:
        throw new TypeError(`the usage provider does not compute ${id}`);
    }
  }
  return values;
}

export const usageProvider: AccredMetricProvider = Object.freeze<AccredMetricProvider>({
  id: 'usage',
  metrics: metricsOfProvider('usage'),
  compute: async (ctx, ids) => ({ done: true, values: await compute(ctx, ids) }),
});
