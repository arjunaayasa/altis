import { countGrouped } from '@altis/db';
import type { MessageKey } from '@altis/shared';
import { sql, type RawBuilder, type SqlBool } from 'kysely';
import { z } from 'zod';
import { reportColumn, reportIdField, reportParam } from '../params.js';
import { liveAt, type RecordStockFacts } from '../stock/index.js';
import type { ReportCtx, ReportRow, TableReport } from '../types.js';
import { chunks, decodeCursor, encodeCursor, itemScopeSql, label, liveItemSql, stockTitleSql, textCell, textParam, titleCell } from './common.js';
import { scanList, type ListEntry } from './stock-agg.js';

// The copies and records whose processing is incomplete (spec §9.1; what a shelf-ready collection needs), one row per
// problem per copy or record, the problems in a fixed order: a copy without a receiving date, without a call number
// (neither its own nor its record's), without a location; a record without classification; a copy without any
// acquisition date at all (the acquisition-date chain finds none). Only the collection of today counts: copies that are
// ordered, lost or withdrawn, and records that are archived or have no copy in it, have nothing to fix.
//
// The first four problems are read from the current rows by keyset (copies by barcode, records by title); the last
// needs the acquisition-date chain, so it reads the stock scan, in the scan's order.

/** The problems in print order. */
export const DATA_QUALITY_PROBLEMS = Object.freeze([
  'item_no_received_date',
  'item_no_call_number',
  'item_no_location',
  'record_no_classification',
  'item_no_acq_date',
] as const);

type Problem = (typeof DATA_QUALITY_PROBLEMS)[number];

/** Where a page ends: the problem, and its keyset position (or, for the last problem, the scan's cursor). */
const PositionSchema = z.strictObject({
  p: z.int().min(0).max(DATA_QUALITY_PROBLEMS.length - 1),
  k: z.tuple([z.string().max(400), z.string().min(1).max(26)]).nullable(),
  c: z.string().max(1000).nullable(),
});

type Position = z.infer<typeof PositionSchema>;

const blank = (column: string) => sql<SqlBool>`(${sql.ref(column)} is null or trim(${sql.ref(column)}) = '')`;

/** The condition of each problem of a copy. */
const ITEM_PROBLEMS: Readonly<Record<Exclude<Problem, 'record_no_classification' | 'item_no_acq_date'>, RawBuilder<SqlBool>>> = {
  item_no_received_date: sql<SqlBool>`(${sql.ref('i.received_date')} is null or ${sql.ref('i.received_date')} = '')`,
  item_no_call_number: sql<SqlBool>`(${blank('i.call_number')} and ${blank('r.call_number')})`,
  item_no_location: sql<SqlBool>`${sql.ref('i.location_id')} is null`,
};

/** A row's cells after the problem's label. */
type Cells = [string | null, string, string | null, string | null, string | null];

/** Up to `max` copies with `problem` after `after`, by barcode. */
async function itemProblems(ctx: ReportCtx, problem: keyof typeof ITEM_PROBLEMS, after: [string, string] | null, max: number): Promise<{ key: [string, string]; cells: Cells }[]> {
  let q = ctx.db
    .selectFrom('items as i')
    .innerJoin('records as r', 'r.id', 'i.record_id')
    .leftJoin('locations as l', 'l.id', 'i.location_id')
    .select(['i.id', 'i.barcode_key', 'i.barcode_display', 'r.title', 'r.subtitle', 'i.call_number', 'r.call_number as record_call_number', 'l.name as location'])
    .where(liveItemSql('i', ctx.today))
    .where('r.archived_at', 'is', null)
    .where(itemScopeSql('i', { branchId: textParam(ctx, 'branchId') }))
    .where(ITEM_PROBLEMS[problem]);
  if (after !== null) {
    const [barcodeKey, id] = after;
    q = q.where((eb) => eb.or([eb('i.barcode_key', '>', barcodeKey), eb.and([eb('i.barcode_key', '=', barcodeKey), eb('i.id', '>', id)])]));
  }
  const rows = await q.orderBy('i.barcode_key').orderBy('i.id').limit(max).execute();
  return rows.map((d) => ({
    key: [d.barcode_key, d.id],
    cells: [d.barcode_display, titleCell(d), textCell(d.call_number) ?? textCell(d.record_call_number), textCell(d.location), null],
  }));
}

/** Up to `max` records of today's collection without classification after `after`, by title, with their copies. */
async function recordProblems(ctx: ReportCtx, after: [string, string] | null, max: number): Promise<{ key: [string, string]; cells: Cells }[]> {
  const branchId = textParam(ctx, 'branchId');
  let q = ctx.db
    .selectFrom('records as r')
    .select(['r.id', 'r.title_key', 'r.title', 'r.subtitle', 'r.call_number'])
    .where(stockTitleSql('r', ctx.today, { branchId }, ctx.settings.electronicMaterialTypeCodes))
    .where(blank('r.classification'));
  if (after !== null) {
    const [titleKey, id] = after;
    q = q.where((eb) => eb.or([eb('r.title_key', '>', titleKey), eb.and([eb('r.title_key', '=', titleKey), eb('r.id', '>', id)])]));
  }
  const rows = await q.orderBy('r.title_key').orderBy('r.id').limit(max).execute();
  const copies = new Map<string, number>();
  for (const part of chunks(rows.map((r) => r.id))) {
    const live = ctx.db
      .selectFrom('items as i')
      .where('i.record_id', 'in', part)
      .where(liveItemSql('i', ctx.today))
      .where(itemScopeSql('i', { branchId }));
    for (const row of await countGrouped(live, { rid: 'i.record_id' })) copies.set(String(row.rid), row.count);
  }
  return rows.map((d) => ({
    key: [d.title_key, d.id],
    cells: [null, titleCell(d), textCell(d.call_number), null, label(ctx, 'report.row.collection.copies', { count: copies.get(d.id) ?? 0 })],
  }));
}

/** The copies of a scan batch in today's collection without any acquisition date, in the scan's order. */
async function undatedEntries(ctx: ReportCtx, batch: readonly RecordStockFacts[], problem: string): Promise<ListEntry[]> {
  const found = batch.flatMap((r) => (r.archived ? [] : r.items.filter((i) => i.acqDate === null && liveAt(i, ctx.today)).map((i) => ({ recordId: r.recordId, itemId: i.itemId }))));
  const shown = new Map<string, Cells>();
  const detail = label(ctx, 'report.row.collection.fill_received_date');
  for (const part of chunks(found.map((x) => x.itemId))) {
    const rows = await ctx.db
      .selectFrom('items as i')
      .innerJoin('records as r', 'r.id', 'i.record_id')
      .leftJoin('locations as l', 'l.id', 'i.location_id')
      .select(['i.id', 'i.barcode_display', 'r.title', 'r.subtitle', 'i.call_number', 'r.call_number as record_call_number', 'l.name as location'])
      .where('i.id', 'in', part)
      .execute();
    for (const d of rows) shown.set(d.id, [d.barcode_display, titleCell(d), textCell(d.call_number) ?? textCell(d.record_call_number), textCell(d.location), detail]);
  }
  return found.flatMap((x) => {
    const cells = shown.get(x.itemId);
    return cells === undefined ? [] : [{ recordId: x.recordId, itemId: x.itemId, row: [problem, ...cells] }];
  });
}

/** Copies and records whose processing is incomplete, one problem per row. */
export const collectionDataQualityReport: TableReport = Object.freeze<TableReport>({
  id: 'collection.data_quality',
  module: 'collection',
  kind: 'table',
  titleKey: 'report.collection.data_quality.title',
  permission: 'reports.statistics.read',
  personal: false,
  formats: ['csv', 'xlsx', 'pdf'],
  orientation: 'portrait',
  params: [reportParam('branchId', 'branch')],
  paramsSchema: z.strictObject({ branchId: reportIdField.optional() }),
  columns: ['problem', 'barcode', 'title', 'call_number', 'location', 'detail'].map((key) => reportColumn(key, 'text')),
  async rows(ctx, cursor, limit) {
    let position: Position = cursor === null ? { p: 0, k: null, c: null } : decodeCursor(cursor, PositionSchema);
    const rows: ReportRow[] = [];
    for (;;) {
      const problem = DATA_QUALITY_PROBLEMS[position.p]!;
      const text = label(ctx, `report.data_quality.problem.${problem}` as MessageKey);
      const room = limit - rows.length;
      if (problem === 'item_no_acq_date') {
        if (room === 0) return { rows, nextCursor: encodeCursor(position) };
        const page = await scanList(ctx, position.c, room, {
          branchId: textParam(ctx, 'branchId'),
          entries: (batch) => undatedEntries(ctx, batch, text),
        });
        rows.push(...page.rows);
        return { rows, nextCursor: page.nextCursor === null ? null : encodeCursor({ p: position.p, k: null, c: page.nextCursor }) };
      }
      const found = problem === 'record_no_classification' ? await recordProblems(ctx, position.k, room + 1) : await itemProblems(ctx, problem, position.k, room + 1);
      const taken = found.slice(0, room);
      rows.push(...taken.map((x): ReportRow => [text, ...x.cells]));
      if (found.length > room) {
        const last = taken[taken.length - 1];
        return { rows, nextCursor: encodeCursor({ p: position.p, k: last === undefined ? position.k : last.key, c: null }) };
      }
      position = { p: position.p + 1, k: null, c: null };
    }
  },
});
