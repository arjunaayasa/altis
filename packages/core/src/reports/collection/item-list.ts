import { countRows } from '@altis/db';
import { ITEM_STATUSES, type ItemStatus } from '@altis/shared';
import { dateField } from '@altis/shared/api/catalog/common';
import { sql, type RawBuilder, type SqlBool } from 'kysely';
import { z } from 'zod';
import { reportClassPrefixField, reportColumn, reportDateRangeField, reportIdField, reportParam } from '../params.js';
import { liveAt, statusAt, titleGoneAt, type RecordStockFacts } from '../stock/index.js';
import type { ReportCtx, ReportRow, TableReport } from '../types.js';
import {
  allOf,
  chunks,
  classPrefixSql,
  decodeCursor,
  encodeCursor,
  itemScopeSql,
  liveItemSql,
  masterName,
  moneyCell,
  rangeParam,
  stockDay,
  textCell,
  textParam,
  titleCell,
  vocabLabel,
} from './common.js';
import { scanList, type ListEntry } from './stock-agg.js';

// The copies of the collection (spec §9.1), filtered by branch, location, status, collection type, the record's material
// type and class prefix, and the receiving date. Without `asOf` every copy that is not withdrawn is listed (a withdrawn
// one when its status is asked for); with `asOf` only the copies in the stock of that day, with their status of that
// day. Today's list (and the list without a day) is read in barcode order by keyset; another day's list reads the stock
// scan, in the scan's order (by title, then copy).

/** How the list reads: every copy, today's stock (both from the current rows), or another day's stock (the scan). */
type Mode = { kind: 'all' } | { kind: 'stock'; day: string } | { kind: 'scan'; day: string };

function modeOf(ctx: ReportCtx): Mode {
  if (ctx.params['asOf'] === undefined) return { kind: 'all' };
  const { day, scan } = stockDay(ctx);
  return scan ? { kind: 'scan', day } : { kind: 'stock', day };
}

function statusesOf(ctx: ReportCtx): readonly ItemStatus[] | null {
  const value = ctx.params['status'];
  return Array.isArray(value) ? (value as ItemStatus[]) : null;
}

/** The filters every mode reads from the current rows (the status of another day is checked on the scan's facts). */
function itemFilters(ctx: ReportCtx): RawBuilder<SqlBool>[] {
  const parts: RawBuilder<SqlBool>[] = [itemScopeSql('i', { branchId: textParam(ctx, 'branchId'), locationId: textParam(ctx, 'locationId'), collectionTypeId: textParam(ctx, 'collectionTypeId') })];
  const materialTypeId = textParam(ctx, 'materialTypeId');
  if (materialTypeId !== null) parts.push(sql<SqlBool>`${sql.ref('r.material_type_id')} = ${materialTypeId}`);
  const classPrefix = textParam(ctx, 'classPrefix');
  if (classPrefix !== null) parts.push(classPrefixSql('r', classPrefix));
  const received = rangeParam(ctx, 'received');
  if (received.from !== null) parts.push(sql<SqlBool>`${sql.ref('i.received_date')} >= ${received.from}`);
  if (received.to !== null) parts.push(sql<SqlBool>`${sql.ref('i.received_date')} <= ${received.to}`);
  return parts;
}

/** The copies of the list read from the current rows. */
function itemWhere(ctx: ReportCtx, mode: Exclude<Mode, { kind: 'scan' }>): RawBuilder<SqlBool> {
  const parts = itemFilters(ctx);
  const statuses = statusesOf(ctx);
  if (statuses !== null) parts.push(sql<SqlBool>`${sql.ref('i.status')} in (${sql.join(statuses)})`);
  if (mode.kind === 'stock') {
    parts.push(liveItemSql('i', mode.day));
    parts.push(sql<SqlBool>`${sql.ref('r.archived_at')} is null`);
  } else if (statuses === null) parts.push(sql<SqlBool>`${sql.ref('i.archived_at')} is null`);
  return allOf(parts);
}

function displayQuery(ctx: ReportCtx) {
  return ctx.db
    .selectFrom('items as i')
    .innerJoin('records as r', 'r.id', 'i.record_id')
    .innerJoin('collection_types as ct', 'ct.id', 'i.collection_type_id')
    .leftJoin('locations as l', 'l.id', 'i.location_id')
    .select([
      'i.id',
      'i.barcode_key',
      'i.barcode_display',
      'i.inventory_no',
      'r.title',
      'r.subtitle',
      'i.call_number',
      'r.call_number as record_call_number',
      'ct.name_id',
      'ct.name_en',
      'i.status',
      'l.name as location',
      'i.received_date',
      'i.price',
      'i.acq_source',
    ]);
}

type Display = Awaited<ReturnType<ReturnType<typeof displayQuery>['execute']>>[number];

/** The row of a copy, with its status (of the day, for another day's list). */
function itemRow(ctx: ReportCtx, d: Display, status: string): ReportRow {
  return [
    d.barcode_display,
    textCell(d.inventory_no),
    titleCell(d),
    textCell(d.call_number) ?? textCell(d.record_call_number),
    masterName(ctx, d),
    vocabLabel(ctx, 'item_status', status),
    textCell(d.location),
    d.received_date,
    moneyCell(d.price),
    vocabLabel(ctx, 'acq_source', d.acq_source),
  ];
}

const keyset = z.tuple([z.string().max(400), z.string().min(1).max(26)]);

/** A page of the list from the current rows, in barcode order. */
async function sqlPage(ctx: ReportCtx, mode: Exclude<Mode, { kind: 'scan' }>, cursor: string | null, limit: number): Promise<{ rows: ReportRow[]; nextCursor: string | null }> {
  let q = displayQuery(ctx).where(itemWhere(ctx, mode)).orderBy('i.barcode_key').orderBy('i.id').limit(limit + 1);
  if (cursor !== null) {
    const [barcodeKey, id] = decodeCursor(cursor, keyset);
    q = q.where((eb) => eb.or([eb('i.barcode_key', '>', barcodeKey), eb.and([eb('i.barcode_key', '=', barcodeKey), eb('i.id', '>', id)])]));
  }
  const found = await q.execute();
  const page = found.slice(0, limit);
  const last = page[page.length - 1];
  return {
    rows: page.map((d) => itemRow(ctx, d, d.status)),
    nextCursor: found.length > limit && last !== undefined ? encodeCursor([last.barcode_key, last.id]) : null,
  };
}

/** The rows of a scan batch: the copies in the stock of the day that pass the filters, in the scan's order. */
async function scanEntries(ctx: ReportCtx, batch: readonly RecordStockFacts[], day: string): Promise<ListEntry[]> {
  const statuses = statusesOf(ctx);
  const found: { recordId: string; itemId: string; status: ItemStatus }[] = [];
  for (const r of batch) {
    if (titleGoneAt(r, day)) continue;
    for (const i of r.items) {
      if (!liveAt(i, day)) continue;
      const status = statusAt(i, day);
      if (statuses === null || statuses.includes(status)) found.push({ recordId: r.recordId, itemId: i.itemId, status });
    }
  }
  const shown = new Map<string, Display>();
  for (const part of chunks(found.map((x) => x.itemId))) {
    for (const d of await displayQuery(ctx).where('i.id', 'in', part).where(allOf(itemFilters(ctx))).execute()) shown.set(d.id, d);
  }
  return found.flatMap((x) => {
    const d = shown.get(x.itemId);
    return d === undefined ? [] : [{ recordId: x.recordId, itemId: x.itemId, row: itemRow(ctx, d, x.status) }];
  });
}

/** The copies of the collection, filtered. */
export const collectionItemListReport: TableReport = Object.freeze<TableReport>({
  id: 'collection.item_list',
  module: 'collection',
  kind: 'table',
  titleKey: 'report.collection.item_list.title',
  permission: 'reports.statistics.read',
  personal: false,
  formats: ['csv', 'xlsx', 'pdf'],
  orientation: 'landscape',
  params: [
    reportParam('branchId', 'branch'),
    reportParam('locationId', 'location'),
    reportParam('status', 'status', { multiple: true, options: ITEM_STATUSES, optionLabelPrefix: 'vocab.item_status.' }),
    reportParam('collectionTypeId', 'collectionType'),
    reportParam('materialTypeId', 'materialType'),
    reportParam('classPrefix', 'classPrefix'),
    reportParam('received', 'dateRange'),
    reportParam('asOf', 'asOf'),
  ],
  paramsSchema: z.strictObject({
    branchId: reportIdField.optional(),
    locationId: reportIdField.optional(),
    status: z.array(z.enum(ITEM_STATUSES)).min(1).max(ITEM_STATUSES.length).optional(),
    collectionTypeId: reportIdField.optional(),
    materialTypeId: reportIdField.optional(),
    classPrefix: reportClassPrefixField.optional(),
    received: reportDateRangeField.optional(),
    asOf: dateField.optional(),
  }),
  columns: [
    ...['barcode', 'inventory_no', 'title', 'call_number', 'collection_type', 'status', 'location'].map((key) => reportColumn(key, 'text')),
    reportColumn('received_date', 'date'),
    reportColumn('price', 'money'),
    reportColumn('acq_source', 'text'),
  ],
  scanBased: (params: Record<string, unknown>) => params['asOf'] !== undefined,
  async rows(ctx, cursor, limit) {
    const mode = modeOf(ctx);
    if (mode.kind !== 'scan') return sqlPage(ctx, mode, cursor, limit);
    return scanList(ctx, cursor, limit, { branchId: textParam(ctx, 'branchId'), entries: (batch) => scanEntries(ctx, batch, mode.day) });
  },
  /** The number of copies, read from the current rows; unknown for another day's stock. */
  async count(ctx) {
    const mode = modeOf(ctx);
    if (mode.kind === 'scan') return null;
    return countRows(ctx.db.selectFrom('items as i').innerJoin('records as r', 'r.id', 'i.record_id').where(itemWhere(ctx, mode)));
  },
});
