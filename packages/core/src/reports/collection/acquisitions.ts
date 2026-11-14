import { ACQ_SOURCES, ddcClassOf, type MessageKey } from '@altis/shared';
import { z } from 'zod';
import { reportColumn, reportIdField, reportParam, reportYearField } from '../params.js';
import { acquisitionOf, firstAcq, type RecordStockFacts } from '../stock/index.js';
import type { ReportColumn, ReportCtx, ReportRow, TableReport } from '../types.js';
import { chunks, label, masterName, moneyCell, textParam, titleCell, vocabLabel } from './common.js';
import { scanAggregate, scanList, type ListEntry } from './stock-agg.js';

// Acquisitions per year and DDC main class (spec §9.1): a copy is dated by the acquisition-date chain (receiving date,
// the date entered in the source system, the record's creation for a migrated copy, the copy's own creation) and the
// time a migration ran is never an acquisition date, so a copy without any of them is in the row "tanpa tanggal", never
// in the year of the migration. Counted in titles, a title is in the year of its first acquisition (an undated copy
// makes it undated; a title without copies, electronic or with a public file, by its creation); in copies, each copy in
// its own year. Ordered copies are never acquisitions: a title with only ordered copies, or orders cancelled before
// they arrived, is in no row, and a copy made here on order counts from the day it arrived (stock.ts). Withdrawn and
// lost copies were acquired and count in their year, and so do archived (weeded) titles; a title merged into another
// does not count. With `detailYear`, the copies acquired in that year with where their date comes from.
//
// Every answer needs the acquisition date of every copy, so the report always reads the stock scan: the matrix keeps
// its counts per year in the cursor and answers its rows when the scan ends; the detail answers its copies as it finds
// them.

/** What the matrix counts. */
export const ACQUISITION_UNITS = Object.freeze(['titles', 'items'] as const);

/** The class columns of the matrix, in order: the ten main classes, 2X and the other classes. */
const CLASS_KEYS = ['c000', 'c100', 'c200', 'c300', 'c400', 'c500', 'c600', 'c700', 'c800', 'c900', 'c2x', 'cnon'] as const;

/** The matrix: one row per year of acquisition (and one for undated copies), one column per DDC main class. */
const MATRIX_COLUMNS: readonly ReportColumn[] = Object.freeze([
  reportColumn('year', 'text'),
  ...[...CLASS_KEYS, 'total'].map((key) => reportColumn(key, 'int')),
]);

/** The copies acquired in `detailYear`. */
const DETAIL_COLUMNS: readonly ReportColumn[] = Object.freeze([
  reportColumn('barcode', 'text'),
  reportColumn('title', 'text'),
  reportColumn('class', 'text'),
  reportColumn('collection_type', 'text'),
  reportColumn('acq_date', 'date'),
  reportColumn('acq_basis', 'text'),
  reportColumn('price', 'money'),
  reportColumn('acq_source', 'text'),
  reportColumn('supplier', 'text'),
]);

/** The counts of the matrix: per year (`YYYY`) and for the undated, one count per class column. */
interface AcqAcc {
  y: Record<string, number[]>;
  u: number[];
}

const counts = z.array(z.int().min(0).max(Number.MAX_SAFE_INTEGER)).length(CLASS_KEYS.length);
const AcqAccSchema: z.ZodType<AcqAcc> = z.strictObject({ y: z.record(z.string().regex(/^\d{4}$/), counts), u: counts });

const zeros = (): number[] => CLASS_KEYS.map(() => 0);

/** The column of a record's main class. */
function classColumn(r: RecordStockFacts): number {
  const main = ddcClassOf(r.classification, r.callNumber).main;
  if (main === '2X') return 10;
  if (main === 'NON') return 11;
  return Number(main[0]);
}

interface AcqFilters {
  yearFrom: number | null;
  yearTo: number | null;
  branchId: string | null;
  acqSource: string | null;
  unit: 'titles' | 'items';
}

function filtersOf(ctx: ReportCtx): AcqFilters {
  const year = (name: string) => (typeof ctx.params[name] === 'number' ? (ctx.params[name] as number) : null);
  return {
    yearFrom: year('yearFrom'),
    yearTo: year('yearTo'),
    branchId: textParam(ctx, 'branchId'),
    acqSource: textParam(ctx, 'acqSource'),
    unit: ctx.params['unit'] === 'items' ? 'items' : 'titles',
  };
}

/** Adds the acquisitions of a scan batch. */
function addBatch(acc: AcqAcc, batch: readonly RecordStockFacts[], f: AcqFilters, electronic: ReadonlySet<string>): void {
  const put = (column: number, date: string | null, n = 1): void => {
    if (date === null) {
      acc.u[column]! += n;
      return;
    }
    const year = Number(date.slice(0, 4));
    if ((f.yearFrom !== null && year < f.yearFrom) || (f.yearTo !== null && year > f.yearTo)) return;
    const row = (acc.y[date.slice(0, 4)] ??= zeros());
    row[column]! += n;
  };
  for (const r of batch) {
    if (r.merged) continue;
    const column = classColumn(r);
    const considered = f.acqSource === null ? r.items : r.items.filter((i) => i.acqSource === f.acqSource);
    if (f.unit === 'items') {
      for (const i of considered) {
        const acquired = acquisitionOf(i);
        if (acquired !== null) put(column, acquired.date);
      }
      continue;
    }
    if (r.items.length === 0) {
      // A title without copies is acquired when it is made, if it counts in the stock at all.
      const counted = (r.materialTypeCode !== null && electronic.has(r.materialTypeCode)) || r.hasPublicFile;
      if (f.acqSource === null && counted) put(column, r.createdOn);
      continue;
    }
    const acquired = considered.filter((i) => acquisitionOf(i) !== null);
    if (acquired.length === 0) continue;
    const first = firstAcq({ ...r, items: acquired });
    put(column, first === 'unknown' ? null : first);
  }
}

/** The matrix rows: the years of the range (or those found), the undated row and the totals row. */
function matrixRows(ctx: ReportCtx, acc: AcqAcc, f: AcqFilters): ReportRow[] {
  const found = Object.keys(acc.y).map(Number);
  let lo = f.yearFrom ?? (found.length > 0 ? Math.min(...found) : null);
  let hi = f.yearTo ?? (found.length > 0 ? Math.max(...found) : null);
  lo ??= hi;
  hi ??= lo;
  const total = zeros();
  const rows: ReportRow[] = [];
  const row = (head: string, cells: readonly number[]): void => {
    cells.forEach((n, k) => (total[k]! += n));
    rows.push([head, ...cells, cells.reduce((a, b) => a + b, 0)]);
  };
  if (lo !== null && hi !== null) for (let year = lo; year <= hi; year += 1) row(String(year), acc.y[String(year)] ?? zeros());
  row(label(ctx, 'report.undated'), acc.u);
  rows.push([label(ctx, 'report.row.total'), ...total, total.reduce((a, b) => a + b, 0)]);
  return rows;
}

/** The detail rows of a scan batch: the copies acquired in `year`, in the scan's order. */
async function detailEntries(ctx: ReportCtx, batch: readonly RecordStockFacts[], f: AcqFilters, year: number): Promise<ListEntry[]> {
  const prefix = `${year}-`;
  const found = batch.flatMap((r) =>
    r.merged
      ? []
      : r.items.flatMap((i) => {
          const acquired = acquisitionOf(i);
          return acquired !== null && acquired.date !== null && acquired.date.startsWith(prefix) && (f.acqSource === null || i.acqSource === f.acqSource)
            ? [{ r, i, acquired }]
            : [];
        }),
  );
  if (found.length === 0) return [];
  const shown = new Map<string, { barcode: string; title: string; collectionType: string; supplier: string | null }>();
  for (const ids of chunks(found.map((x) => x.i.itemId))) {
    const rows = await ctx.db
      .selectFrom('items as i')
      .innerJoin('records as r', 'r.id', 'i.record_id')
      .innerJoin('collection_types as ct', 'ct.id', 'i.collection_type_id')
      .leftJoin('suppliers as s', 's.id', 'i.supplier_id')
      .select(['i.id', 'i.barcode_display', 'r.title', 'r.subtitle', 'ct.name_id', 'ct.name_en', 's.name as supplier'])
      .where('i.id', 'in', ids)
      .execute();
    for (const x of rows) shown.set(x.id, { barcode: x.barcode_display, title: titleCell(x), collectionType: masterName(ctx, x), supplier: x.supplier });
  }
  return found.flatMap(({ r, i, acquired }) => {
    const s = shown.get(i.itemId);
    if (s === undefined) return [];
    const row: ReportRow = [
      s.barcode,
      s.title,
      ddcClassOf(r.classification, r.callNumber).main,
      s.collectionType,
      acquired.date,
      acquired.basis === null ? null : label(ctx, `report.acq_basis.${acquired.basis}` as MessageKey),
      moneyCell(i.price),
      vocabLabel(ctx, 'acq_source', i.acqSource),
      s.supplier,
    ];
    return [{ recordId: r.recordId, itemId: i.itemId, row }];
  });
}

/** Acquisitions per year and DDC main class; with `detailYear`, that year's copies. Always a scan of the stock. */
export const collectionAcquisitionsReport: TableReport = Object.freeze<TableReport>({
  id: 'collection.acquisitions',
  module: 'collection',
  kind: 'table',
  titleKey: 'report.collection.acquisitions.title',
  permission: 'reports.statistics.read',
  personal: false,
  formats: ['csv', 'xlsx', 'pdf'],
  orientation: 'landscape',
  params: [
    reportParam('yearFrom', 'year', { min: 1900, max: 2100 }),
    reportParam('yearTo', 'year', { min: 1900, max: 2100 }),
    reportParam('branchId', 'branch'),
    reportParam('acqSource', 'status', { options: ACQ_SOURCES, optionLabelPrefix: 'vocab.acq_source.' }),
    reportParam('unit', 'status', { options: ACQUISITION_UNITS }),
    reportParam('detailYear', 'year', { min: 1900, max: 2100 }),
  ],
  paramsSchema: z
    .strictObject({
      yearFrom: reportYearField.optional(),
      yearTo: reportYearField.optional(),
      branchId: reportIdField.optional(),
      acqSource: z.enum(ACQ_SOURCES).optional(),
      unit: z.enum(ACQUISITION_UNITS).default('titles'),
      detailYear: reportYearField.optional(),
    })
    .check((c) => {
      const { yearFrom, yearTo } = c.value;
      if (yearFrom !== undefined && yearTo !== undefined && yearFrom > yearTo) {
        c.issues.push({ code: 'custom', path: ['yearTo'], params: { code: 'invalid' }, message: 'invalid', input: yearTo });
      }
    }),
  columns: (params: Record<string, unknown>) => (params['detailYear'] === undefined ? MATRIX_COLUMNS : DETAIL_COLUMNS),
  scanBased: () => true,
  /** The matrix all in the call that ends the scan (its totals row last); the detail a page at a time. */
  async rows(ctx, cursor, limit) {
    const f = filtersOf(ctx);
    const detailYear = ctx.params['detailYear'];
    if (typeof detailYear === 'number') {
      return scanList(ctx, cursor, limit, { branchId: f.branchId, entries: (batch) => detailEntries(ctx, batch, f, detailYear) });
    }
    const electronic = new Set(ctx.settings.electronicMaterialTypeCodes);
    const step = await scanAggregate(ctx, cursor, {
      branchId: f.branchId,
      schema: AcqAccSchema,
      init: () => ({ y: {}, u: zeros() }),
      visit: (acc, batch) => addBatch(acc, batch, f, electronic),
    });
    if (!step.done) return { rows: [], nextCursor: step.cursor };
    return { rows: matrixRows(ctx, step.acc, f), nextCursor: null };
  },
});
