import { VISIT_SOURCES, isoWeekday, type MessageKey } from '@altis/shared';
import { z } from 'zod';
import { label, offsetPage, textParam } from '../collection/common.js';
import { sumOf } from '../circulation/common.js';
import { reportColumn, reportDateRangeField, reportIdField, reportParam } from '../params.js';
import type { ReportCtx, ReportRow, TableReport } from '../types.js';
import { PERIOD_FILTER, rangeOrPeriodSpan } from '../window.js';

// The visits by hour of the day and day of the week (no personal data): people counted, each visit by its head count,
// a voided visit not at all, in the hour of the branch's own clock it was recorded at (the library's for a branch
// without a time zone) and on the weekday of its day. Rows run from the first hour with a visit to the last (none
// without visits), each with a column per weekday, Monday first, and the total; the totals row closes the table.
// Filtered by a date range (the last 30 days by default) or an accreditation period, a branch and a source.

/** The weekday columns, Monday (1) to Sunday (7). */
const WEEKDAY_KEYS = ['wd1', 'wd2', 'wd3', 'wd4', 'wd5', 'wd6', 'wd7'] as const;

/** The visits read per round trip. */
const BATCH = 5_000;

/** The hour formatter of each time zone. */
const HOUR_FORMATS = new Map<string, Intl.DateTimeFormat>();

/** The hour (0-23) of the instant `at` in `tz`. */
function hourIn(tz: string, at: number): number {
  let f = HOUR_FORMATS.get(tz);
  if (f === undefined) {
    f = new Intl.DateTimeFormat('en-GB', { timeZone: tz, hour: '2-digit', hourCycle: 'h23' });
    HOUR_FORMATS.set(tz, f);
  }
  const hour = Number(f.formatToParts(at).find((p) => p.type === 'hour')?.value);
  return Number.isInteger(hour) && hour >= 0 && hour < 24 ? hour : 0;
}

/** `HH:00–HH:59`. */
const hourLabel = (h: number): string => `${String(h).padStart(2, '0')}:00–${String(h).padStart(2, '0')}:59`;

async function byHour(ctx: ReportCtx): Promise<{ rows: ReportRow[]; totals: ReportRow }> {
  const span = await rangeOrPeriodSpan(ctx, 'range', 30);
  const branches = await ctx.db.selectFrom('branches').select(['id', 'timezone']).execute();
  const tzOf = new Map(branches.map((b) => [b.id, b.timezone || ctx.tz]));
  const branchId = textParam(ctx, 'branchId');
  const source = textParam(ctx, 'source');
  const cells = Array.from({ length: 24 }, () => WEEKDAY_KEYS.map(() => 0));
  for (let after: string | null = null; ; ) {
    let q = ctx.db
      .selectFrom('visits as v')
      .select(['v.id', 'v.branch_id', 'v.visited_on', 'v.visited_at', 'v.headcount'])
      .where('v.visited_on', '>=', span.from)
      .where('v.visited_on', '<=', span.to)
      .where('v.voided_at', 'is', null)
      .orderBy('v.id')
      .limit(BATCH);
    if (branchId !== null) q = q.where('v.branch_id', '=', branchId);
    if (source !== null) q = q.where('v.source', '=', source);
    if (after !== null) q = q.where('v.id', '>', after);
    const batch = await q.execute();
    for (const v of batch) {
      const hour = hourIn(tzOf.get(v.branch_id) ?? ctx.tz, Number(v.visited_at));
      const day = isoWeekday(v.visited_on) - 1;
      cells[hour]![day] = (cells[hour]![day] ?? 0) + Number(v.headcount);
    }
    if (batch.length < BATCH) break;
    after = batch[batch.length - 1]!.id;
  }
  const busy = cells.map((row, h) => (sumOf(row) > 0 ? h : -1)).filter((h) => h >= 0);
  const rows: ReportRow[] = [];
  if (busy.length > 0) {
    for (let h = busy[0]!; h <= busy[busy.length - 1]!; h += 1) rows.push([hourLabel(h), ...cells[h]!, sumOf(cells[h]!)]);
  }
  const sums = WEEKDAY_KEYS.map((_, d) => sumOf(cells.map((row) => row[d]!)));
  return { rows, totals: [label(ctx, 'report.row.total' as MessageKey), ...sums, sumOf(sums)] };
}

/** The visits by hour and weekday (see the top of this file). */
export const visitsByHourReport: TableReport = Object.freeze<TableReport>({
  id: 'visits.by_hour',
  module: 'visits',
  kind: 'table',
  titleKey: 'report.visits.by_hour.title',
  permission: 'reports.statistics.read',
  personal: false,
  formats: ['csv', 'xlsx', 'pdf'],
  orientation: 'portrait',
  params: [
    reportParam('range', 'dateRange'),
    PERIOD_FILTER,
    reportParam('branchId', 'branch'),
    reportParam('source', 'status', { options: VISIT_SOURCES, optionLabelPrefix: 'vocab.visit_source.' }),
  ],
  paramsSchema: z.strictObject({
    range: reportDateRangeField.optional(),
    periodId: reportIdField.optional(),
    branchId: reportIdField.optional(),
    source: z.enum(VISIT_SOURCES).optional(),
  }),
  columns: [reportColumn('hour', 'text'), ...WEEKDAY_KEYS.map((key) => reportColumn(key, 'int')), reportColumn('total', 'int')],
  chart: { kind: 'rows', label: 'hour', value: 'total' },
  async rows(ctx, cursor, limit) {
    return offsetPage((await byHour(ctx)).rows, cursor, limit);
  },
  async totals(ctx) {
    return (await byHour(ctx)).totals;
  },
});
