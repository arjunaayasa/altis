import { t } from '@altis/shared';
import { reportFieldErrors } from '../../reports/runs/service.js';
import type { ReportCtx } from '../../reports/types.js';
import { snapshotDate } from '../windows.js';
import type { ResolvedCell } from './index.js';
import { loadUsageTable, monthsOfSpan, type UsageTable } from './resolve.js';
import { isProrated, isSchoolLibrary, populationOf, sourcesOf, untilOf } from './series.js';

// What the two usage annexes (`accreditation.annex.l14`, `accreditation.annex.usage_monthly`) read alike: the period of
// their `periodId`, its usage table, the months they print (every month of the period) and the months their totals
// count (up to the snapshot date, as the metrics do), the source text of a row and the label of the totals row, which
// prints the divisor.

/** The usage of an annex's period. */
export interface AnnexUsage {
  table: UsageTable;
  /** Every month of the period: a row each. */
  months: readonly string[];
  /** The months up to the month of the snapshot date: the totals and the divisor. */
  counted: readonly string[];
  population: number | null;
  school: boolean;
}

/** The live period of `ctx.params.periodId`. */
async function annexPeriod(ctx: ReportCtx) {
  const p = await ctx.db
    .selectFrom('accred_periods')
    .select(['starts_on', 'ends_on', 'instrument_id', 'students', 'teachers', 'edu_staff'])
    .where('id', '=', String(ctx.params['periodId']))
    .where('archived_at', 'is', null)
    .executeTakeFirst();
  if (p === undefined) throw reportFieldErrors([{ path: 'params.periodId', code: 'not_found' }]);
  return p;
}

/**
 * How many month rows an annex of the live period `ctx.params.periodId` has.
 *
 * @throws DomainError `VALIDATION_FAILED` `{path: 'params.periodId', code: 'not_found'}` for an unknown or archived period
 */
export async function annexMonthCount(ctx: ReportCtx): Promise<number> {
  const p = await annexPeriod(ctx);
  return monthsOfSpan(p.starts_on, p.ends_on).length;
}

/**
 * The usage of the live period `ctx.params.periodId`.
 *
 * @throws DomainError `VALIDATION_FAILED` `{path: 'params.periodId', code: 'not_found'}` for an unknown or archived period
 */
export async function annexUsage(ctx: ReportCtx): Promise<AnnexUsage> {
  const p = await annexPeriod(ctx);
  const D = snapshotDate(p.ends_on, ctx.today);
  const table = await loadUsageTable(ctx.db, { from: p.starts_on, to: p.ends_on }, ctx.settings);
  return {
    table,
    months: table.months,
    counted: monthsOfSpan(p.starts_on, p.ends_on < D ? p.ends_on : D),
    population: populationOf(p),
    school: isSchoolLibrary(p.instrument_id, ctx.settings),
  };
}

/** The sources of `cells` as words: "Isian manual", "Impor SLiMS" (both, comma-separated), or "Tidak ada data". */
export function sourceWords(ctx: ReportCtx, cells: readonly ResolvedCell[]): string {
  const sources = sourcesOf(cells);
  if (sources.length === 0) return t(ctx.locale, 'report.source.none');
  return sources.map((s) => t(ctx.locale, s === 'manual' ? 'report.source.manual' : 'report.source.slims')).join(', ');
}

/** The source of a month row: {@link sourceWords}, and the last day its figures reach in a cut-over month. */
export function sourceText(ctx: ReportCtx, cells: readonly ResolvedCell[]): string {
  const words = sourceWords(ctx, cells);
  const until = untilOf(cells);
  return until === null ? words : t(ctx.locale, 'report.row.usage.source_until', { source: words, date: until });
}

/**
 * The label of the totals row: the divisor of the monthly averages with how it was found (school months, prorated
 * with its formula, or the months with data outside a school), or that there is no usage yet.
 */
export function totalLabel(ctx: ReportCtx, o: { withData: number; divisor: number | null; school: boolean }): string {
  if (o.divisor === null) return t(ctx.locale, 'report.row.usage.total_no_data');
  if (!o.school) return t(ctx.locale, 'report.row.usage.total_months', { divisor: o.divisor });
  return isProrated(o.withData)
    ? t(ctx.locale, 'report.row.usage.total_school_months_prorated', { divisor: o.divisor, months: o.withData })
    : t(ctx.locale, 'report.row.usage.total_school_months', { divisor: o.divisor });
}
