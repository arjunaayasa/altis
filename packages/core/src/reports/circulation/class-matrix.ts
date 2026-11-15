import { countGrouped, datePrefix, type DB } from '@altis/db';
import type { MessageKey } from '@altis/shared';
import { sql, type SelectQueryBuilder, type SqlBool } from 'kysely';
import { z } from 'zod';
import { label, offsetPage, textParam } from '../collection/common.js';
import { reportColumn, reportIdField, reportParam, reportYearField } from '../params.js';
import type { ReportColumn, ReportCtx, ReportRow, TableReport } from '../types.js';
// ---- Komunitas K5 (reports) ----
import { PERIOD_FILTER, monthMatrixSpan, type ReportSpan } from '../window.js';
import { CLASS_COLUMNS, CLASS_KEYS, MAIN_CLASS_OPTIONS, MONTH_COLUMNS, MONTH_KEYS, classIndexOf, divisionIndexOf, divisionLabel, monthIndexOf, sumOf } from './common.js';

// Two matrices of one year by DDC class, from the class each event kept when it happened (`stat_ddc`):
//
// - `circulation.loans_by_class`: the loans, each counted once, in the month it was lent (a renewal is no new loan);
//   a voided loan not at all. Filtered by collection type, member type and branch (the dimensions the loan kept).
// - `circulation.in_library`: the in-library uses (books read in the library and put back by staff).
//
// Rows are the months of the year and columns the DDC main classes, 2X, the other classes and the total; with a main
// class chosen, rows are its ten divisions and columns the months. Both end with a totals row. With an accreditation
// period chosen (`periodId`, at most twelve months) the period is read instead of the year: rows are its months in
// order, and a division's month columns take each of its months in the column of that calendar month.

type Matrix = { rows: ReportRow[]; totals: ReportRow };

/** The counts of `base` by month and class: rows of the span's months × classes, or (with `main`) divisions × months. */
async function matrixOf(
  ctx: ReportCtx,
  base: SelectQueryBuilder<DB, never, object>,
  dateColumn: string,
  statColumn: string,
  span: ReportSpan,
  main: string | null,
): Promise<Matrix> {
  const groups = await countGrouped(base, { m: datePrefix(dateColumn, 'month'), d: statColumn });
  const total = label(ctx, 'report.row.total' as MessageKey);
  if (main === null) {
    const cells = span.months.map(() => CLASS_KEYS.map(() => 0));
    for (const g of groups) {
      const month = g.m === null ? -1 : span.months.indexOf(String(g.m).slice(0, 7));
      if (month < 0) continue;
      const k = classIndexOf(g.d === null ? null : String(g.d));
      cells[month]![k] = (cells[month]![k] ?? 0) + g.count;
    }
    const rows: ReportRow[] = cells.map((row, k) => [span.months[k]!, ...row, sumOf(row)]);
    const sums = CLASS_KEYS.map((_, c) => sumOf(cells.map((row) => row[c]!)));
    return { rows, totals: [total, ...sums, sumOf(sums)] };
  }
  const cells = Array.from({ length: 10 }, () => MONTH_KEYS.map(() => 0));
  for (const g of groups) {
    const month = monthIndexOf(g.m);
    const division = divisionIndexOf(g.d === null ? null : String(g.d), main);
    if (month === null || division === null) continue;
    cells[division]![month] = (cells[division]![month] ?? 0) + g.count;
  }
  const rows: ReportRow[] = cells.map((row, k) => [divisionLabel(main, k), ...row, sumOf(row)]);
  const sums = MONTH_KEYS.map((_, m) => sumOf(cells.map((row) => row[m]!)));
  return { rows, totals: [total, ...sums, sumOf(sums)] };
}

/** The columns of a matrix: months × classes, or a main class's divisions × months. */
function matrixColumns(params: Record<string, unknown>): readonly ReportColumn[] {
  return typeof params['mainClass'] === 'string' ? [reportColumn('class', 'text'), ...MONTH_COLUMNS] : [reportColumn('month', 'text'), ...CLASS_COLUMNS];
}

const mainOf = (ctx: ReportCtx): string | null => textParam(ctx, 'mainClass');

/** The loans of the span (alias `l`), with the filters. */
function loansOfYear(ctx: ReportCtx, span: ReportSpan): SelectQueryBuilder<DB, never, object> {
  let q = ctx.db
    .selectFrom('loans as l')
    .where('l.loaned_on', '>=', span.from)
    .where('l.loaned_on', '<=', span.to)
    .where(sql<SqlBool>`(l.outcome is null or l.outcome <> 'voided')`);
  const branchId = textParam(ctx, 'branchId');
  if (branchId !== null) q = q.where('l.branch_id', '=', branchId);
  const collectionTypeId = textParam(ctx, 'collectionTypeId');
  if (collectionTypeId !== null) q = q.where('l.stat_collection_type_id', '=', collectionTypeId);
  const memberTypeId = textParam(ctx, 'memberTypeId');
  if (memberTypeId !== null) q = q.where('l.stat_member_type_id', '=', memberTypeId);
  return q as unknown as SelectQueryBuilder<DB, never, object>;
}

/** The in-library uses of the span (alias `u`). */
function usesOfYear(ctx: ReportCtx, span: ReportSpan): SelectQueryBuilder<DB, never, object> {
  let q = ctx.db.selectFrom('item_uses as u').where('u.used_on', '>=', span.from).where('u.used_on', '<=', span.to);
  const branchId = textParam(ctx, 'branchId');
  if (branchId !== null) q = q.where('u.branch_id', '=', branchId);
  return q as unknown as SelectQueryBuilder<DB, never, object>;
}

const MAIN_CLASS_PARAM = reportParam('mainClass', 'status', { options: MAIN_CLASS_OPTIONS, optionLabelPrefix: 'vocab.ddc_main.' });

/** Loans per month and DDC class (see the top of this file). */
export const circulationLoansByClassReport: TableReport = Object.freeze<TableReport>({
  id: 'circulation.loans_by_class',
  module: 'circulation',
  kind: 'table',
  titleKey: 'report.circulation.loans_by_class.title',
  permission: 'reports.statistics.read',
  personal: false,
  formats: ['csv', 'xlsx', 'pdf'],
  orientation: 'landscape',
  params: [
    reportParam('year', 'year', { min: 1900, max: 2100 }),
    MAIN_CLASS_PARAM,
    reportParam('collectionTypeId', 'collectionType'),
    reportParam('memberTypeId', 'memberType'),
    reportParam('branchId', 'branch'),
    // ---- Komunitas K5 (reports) ----
    PERIOD_FILTER,
  ],
  paramsSchema: z.strictObject({
    year: reportYearField.optional(),
    mainClass: z.enum(MAIN_CLASS_OPTIONS as [string, ...string[]]).optional(),
    collectionTypeId: reportIdField.optional(),
    memberTypeId: reportIdField.optional(),
    branchId: reportIdField.optional(),
    periodId: reportIdField.optional(),
  }),
  columns: matrixColumns,
  chart: { kind: 'rows', label: 'month', value: 'total' },
  async rows(ctx, cursor, limit) {
    const span = await monthMatrixSpan(ctx);
    const m = await matrixOf(ctx, loansOfYear(ctx, span), 'l.loaned_on', 'l.stat_ddc', span, mainOf(ctx));
    return offsetPage(m.rows, cursor, limit);
  },
  async totals(ctx) {
    const span = await monthMatrixSpan(ctx);
    return (await matrixOf(ctx, loansOfYear(ctx, span), 'l.loaned_on', 'l.stat_ddc', span, mainOf(ctx))).totals;
  },
  async count(ctx) {
    return mainOf(ctx) === null ? (await monthMatrixSpan(ctx)).months.length : 10;
  },
});

/** In-library uses per month and DDC class (see the top of this file). */
export const circulationInLibraryReport: TableReport = Object.freeze<TableReport>({
  id: 'circulation.in_library',
  module: 'circulation',
  kind: 'table',
  titleKey: 'report.circulation.in_library.title',
  permission: 'reports.statistics.read',
  personal: false,
  formats: ['csv', 'xlsx', 'pdf'],
  orientation: 'landscape',
  params: [
    reportParam('year', 'year', { min: 1900, max: 2100 }),
    MAIN_CLASS_PARAM,
    reportParam('branchId', 'branch'),
    // ---- Komunitas K5 (reports) ----
    PERIOD_FILTER,
  ],
  paramsSchema: z.strictObject({
    year: reportYearField.optional(),
    mainClass: z.enum(MAIN_CLASS_OPTIONS as [string, ...string[]]).optional(),
    branchId: reportIdField.optional(),
    periodId: reportIdField.optional(),
  }),
  columns: matrixColumns,
  chart: { kind: 'rows', label: 'month', value: 'total' },
  async rows(ctx, cursor, limit) {
    const span = await monthMatrixSpan(ctx);
    const m = await matrixOf(ctx, usesOfYear(ctx, span), 'u.used_on', 'u.stat_ddc', span, mainOf(ctx));
    return offsetPage(m.rows, cursor, limit);
  },
  async totals(ctx) {
    const span = await monthMatrixSpan(ctx);
    return (await matrixOf(ctx, usesOfYear(ctx, span), 'u.used_on', 'u.stat_ddc', span, mainOf(ctx))).totals;
  },
  async count(ctx) {
    return mainOf(ctx) === null ? (await monthMatrixSpan(ctx)).months.length : 10;
  },
});
