import { addMonths, monthOf } from '@altis/shared';
import type { ReportParamSpec } from '@altis/shared/api/reports';
import { textParam } from './collection/common.js';
import { closedRange, yearParam } from './circulation/common.js';
import { reportParam } from './params.js';
import { reportFieldErrors } from './runs/service.js';
import type { ReportCtx } from './types.js';

// The span of days a statistics report reads when it can take an accreditation period: the period's own days when one
// is chosen (`periodId`), else the year or the date range of the report's other parameters. A period is the library's
// (a school year, a calendar year, twelve months to a month, or a span of the library's own), so a report of one year
// can be read for the school year an accreditation is measured over.

/** The optional accreditation-period filter of a statistics report (`report.param.periodId`). */
export const PERIOD_FILTER: ReportParamSpec = reportParam('periodId', 'period');

/** A span of calendar days, both ends included, with the months it touches (`YYYY-MM`, in order). */
export interface ReportSpan {
  from: string;
  to: string;
  months: readonly string[];
  /** The period's name when the span is a period's. */
  periodName: string | null;
}

/** The months `YYYY-MM` from the month of `from` to the month of `to`, in order. */
export function monthsOfSpan(from: string, to: string): string[] {
  const out: string[] = [];
  for (let m = `${monthOf(from)}-01`; monthOf(m) <= monthOf(to); m = addMonths(m, 1)) out.push(monthOf(m));
  return out;
}

/**
 * The live period `params.periodId`, or null when none is chosen.
 *
 * @throws DomainError `VALIDATION_FAILED` `{path: 'periodId', code: 'not_found'}` for a period that is not (or no longer) there
 */
export async function chosenPeriod(ctx: ReportCtx): Promise<{ from: string; to: string; name: string } | null> {
  const id = textParam(ctx, 'periodId');
  if (id === null) return null;
  const row = await ctx.db
    .selectFrom('accred_periods')
    .select(['starts_on', 'ends_on', 'name'])
    .where('id', '=', id)
    .where('archived_at', 'is', null)
    .executeTakeFirst();
  if (row === undefined) throw reportFieldErrors([{ path: 'periodId', code: 'not_found' }]);
  return { from: row.starts_on, to: row.ends_on, name: row.name };
}

/** The span of a report of one year (`year`, else this year), or of the chosen period. */
export async function yearOrPeriodSpan(ctx: ReportCtx): Promise<ReportSpan> {
  const period = await chosenPeriod(ctx);
  if (period !== null) return { ...period, months: monthsOfSpan(period.from, period.to), periodName: period.name };
  const year = yearParam(ctx);
  const from = `${year}-01-01`;
  const to = `${year}-12-31`;
  return { from, to, months: monthsOfSpan(from, to), periodName: null };
}

/** The span of a report of a date range (`name`, else the `fallbackDays` days to today), or of the chosen period. */
export async function rangeOrPeriodSpan(ctx: ReportCtx, name: string, fallbackDays: number): Promise<ReportSpan> {
  const period = await chosenPeriod(ctx);
  if (period !== null) return { ...period, months: monthsOfSpan(period.from, period.to), periodName: period.name };
  const range = closedRange(ctx, name, fallbackDays);
  return { ...range, months: monthsOfSpan(range.from, range.to), periodName: null };
}

/**
 * The span of a matrix with one column (or row) per calendar month: as {@link yearOrPeriodSpan}, a period of more than
 * twelve months refused, since two of its months would fall in one column.
 *
 * @throws DomainError `VALIDATION_FAILED` `{path: 'periodId', code: 'too_big'}` for a period over twelve months
 */
export async function monthMatrixSpan(ctx: ReportCtx): Promise<ReportSpan> {
  const span = await yearOrPeriodSpan(ctx);
  if (span.months.length > 12) throw reportFieldErrors([{ path: 'periodId', code: 'too_big' }]);
  return span;
}
