import { countDistinctGrouped, countGrouped, countRows } from '@altis/db';
import { ITEM_STATUSES, type MessageKey } from '@altis/shared';
import { dateField } from '@altis/shared/api/catalog/common';
import { z } from 'zod';
import { reportColumn, reportIdField, reportParam } from '../params.js';
import { statusAt, type ItemStockFacts, type RecordStockFacts } from '../stock/index.js';
import type { ReportCtx, ReportRow, TableReport } from '../types.js';
import {
  GROUP_NONE,
  STOCK_STATUSES,
  collectionTypesById,
  compareOrder,
  countedWithoutCopiesSql,
  itemScopeSql,
  label,
  liveItemSql,
  locationsById,
  materialTypesByCode,
  offsetPage,
  stockCopies,
  stockDay,
  stockTitleSql,
  textParam,
  vocabLabel,
  type MasterLabel,
} from './common.js';
import { scanAggregate } from './stock-agg.js';

// The collection at a glance (spec §9.1): the titles in the stock (all of them, those with copies, those without
// copies, the electronic ones), the copies in the stock by status, the titles by material type, the copies by
// collection type and by location; each row counts titles and copies (a title once per row it has copies in). The
// stock of today comes from grouped queries over the current rows; the stock of another day from the stock scan, its
// counts carried in the cursor until the scan ends.

/** Titles and copies. */
type Pair = [number, number];

/** The summary's counts. */
interface SummaryAcc {
  /** All titles in the stock and their copies. */
  a: Pair;
  /** Titles with copies. */
  w: number;
  /** Titles without copies. */
  n: number;
  /** Electronic titles and their copies. */
  e: Pair;
  /** By status, by material type code, by collection type id, by location id (GROUP_NONE: none). */
  s: Record<string, Pair>;
  m: Record<string, Pair>;
  c: Record<string, Pair>;
  l: Record<string, Pair>;
}

const count = z.int().min(0).max(Number.MAX_SAFE_INTEGER);
const pair = z.tuple([count, count]);
const byKey = z.record(z.string().min(1).max(64), pair);
const SummaryAccSchema: z.ZodType<SummaryAcc> = z.strictObject({ a: pair, w: count, n: count, e: pair, s: byKey, m: byKey, c: byKey, l: byKey });

const emptyAcc = (): SummaryAcc => ({ a: [0, 0], w: 0, n: 0, e: [0, 0], s: {}, m: {}, c: {}, l: {} });

function add(map: Record<string, Pair>, key: string, titles: number, items: number): void {
  const p = map[key] ?? [0, 0];
  map[key] = [p[0] + titles, p[1] + items];
}

/** Adds each key of `copies` once as a title, with its number of copies. */
function addCopies(map: Record<string, Pair>, copies: readonly ItemStockFacts[], keyOf: (i: ItemStockFacts) => string): void {
  const n = new Map<string, number>();
  for (const i of copies) n.set(keyOf(i), (n.get(keyOf(i)) ?? 0) + 1);
  for (const [key, items] of n) add(map, key, 1, items);
}

/** Adds the titles of a scan batch that are in the stock on `day`. */
function addBatch(acc: SummaryAcc, batch: readonly RecordStockFacts[], day: string, branchId: string | null, electronic: ReadonlySet<string>): void {
  for (const r of batch) {
    const copies = stockCopies(r, day, electronic, { branchId });
    if (copies === null) continue;
    acc.a = [acc.a[0] + 1, acc.a[1] + copies.length];
    if (r.items.length === 0) acc.n += 1;
    else acc.w += 1;
    if (r.materialTypeCode !== null && electronic.has(r.materialTypeCode)) acc.e = [acc.e[0] + 1, acc.e[1] + copies.length];
    add(acc.m, r.materialTypeCode ?? GROUP_NONE, 1, copies.length);
    addCopies(acc.s, copies, (i) => statusAt(i, day));
    addCopies(acc.c, copies, (i) => i.collectionTypeId ?? GROUP_NONE);
    addCopies(acc.l, copies, (i) => i.locationId ?? GROUP_NONE);
  }
}

type GroupedRow = Record<string, string | number | null> & { count: number };

/** Adds grouped counts (key `k`) of titles and of copies into `map`. */
function addGrouped(map: Record<string, Pair>, titles: readonly GroupedRow[], items: readonly GroupedRow[]): void {
  for (const row of titles) add(map, row['k'] === null ? GROUP_NONE : String(row['k']), row.count, 0);
  for (const row of items) add(map, row['k'] === null ? GROUP_NONE : String(row['k']), 0, row.count);
}

/** A group key as the counts name it (`GROUP_NONE` for none). */
const keyOf = (value: string | number | null | undefined): string => (value === null || value === undefined ? GROUP_NONE : String(value));

/**
 * The counts of today's stock, from grouped queries over the current rows. Each statement is a pass over the whole
 * collection, so the parts that are sums are read together: the titles once by material type (all titles and the
 * electronic ones are sums of those), the copies once by status, material type, collection type and location at the
 * same time (every copy count is a sum of those). Only the titles per status, collection type and location need a
 * distinct count each (a title with copies in two locations counts in both).
 */
async function countToday(ctx: ReportCtx, branchId: string | null): Promise<SummaryAcc> {
  const day = ctx.today;
  const scope = { branchId };
  const electronic = new Set(ctx.settings.electronicMaterialTypeCodes);
  const copies = () =>
    ctx.db
      .selectFrom('items as i')
      .innerJoin('records as r', 'r.id', 'i.record_id')
      .where(liveItemSql('i', day))
      .where('r.archived_at', 'is', null)
      .where(itemScopeSql('i', scope));
  const acc = emptyAcc();
  const titles = ctx.db
    .selectFrom('records as r')
    .leftJoin('material_types as mt', 'mt.id', 'r.material_type_id')
    .where(stockTitleSql('r', day, scope, [...electronic]));
  for (const row of await countGrouped(titles, { m: 'mt.code_key' })) {
    acc.a[0] += row.count;
    // A title whose material type row is gone counts in the titles, not in a material type (as an inner join had it).
    if (row.m === null) continue;
    add(acc.m, String(row.m), row.count, 0);
    if (electronic.has(String(row.m))) acc.e[0] += row.count;
  }
  const byParts = copies().leftJoin('material_types as mt', 'mt.id', 'r.material_type_id');
  for (const row of await countGrouped(byParts, { s: 'i.status', m: 'mt.code_key', c: 'i.collection_type_id', l: 'i.location_id' })) {
    acc.a[1] += row.count;
    if (row.m !== null) {
      add(acc.m, String(row.m), 0, row.count);
      if (electronic.has(String(row.m))) acc.e[1] += row.count;
    }
    add(acc.s, keyOf(row.s), 0, row.count);
    add(acc.c, keyOf(row.c), 0, row.count);
    add(acc.l, keyOf(row.l), 0, row.count);
  }
  acc.n = branchId !== null ? 0 : await countRows(ctx.db.selectFrom('records as r').where('r.archived_at', 'is', null).where(countedWithoutCopiesSql('r', [...electronic])));
  // A title in the stock either has a copy in it or, without any copy at all, counts without one (`n`): never both.
  acc.w = acc.a[0] - acc.n;
  addGrouped(acc.s, await countDistinctGrouped(copies(), { k: 'i.status' }, 'i.record_id'), []);
  addGrouped(acc.c, await countDistinctGrouped(copies(), { k: 'i.collection_type_id' }, 'i.record_id'), []);
  addGrouped(acc.l, await countDistinctGrouped(copies(), { k: 'i.location_id' }, 'i.record_id'), []);
  return acc;
}

/** The rows of a part listed by master rows, in the masters' order; the row without a master (`GROUP_NONE`) last. */
function masterRows(section: string, map: Record<string, Pair>, masters: Map<string, MasterLabel>, none: string): ReportRow[] {
  const keys = Object.keys(map).filter((k) => map[k]![0] > 0 || map[k]![1] > 0);
  const orderOf = (k: string): readonly (string | number)[] => (k === GROUP_NONE ? [2] : masters.has(k) ? [0, ...masters.get(k)!.order] : [1, k]);
  // Two masters alike in order, label and code (locations of two branches) keep one order: by their id.
  keys.sort((a, b) => compareOrder(orderOf(a), orderOf(b)) || compareOrder([a], [b]));
  return keys.map((k) => [section, k === GROUP_NONE ? none : (masters.get(k)?.label ?? k), map[k]![0], map[k]![1]]);
}

/** The summary's rows from its counts. */
async function summaryRows(ctx: ReportCtx, acc: SummaryAcc): Promise<ReportRow[]> {
  const section = (key: string) => label(ctx, `report.summary.section.${key}` as MessageKey);
  const row = (key: string) => label(ctx, `report.row.collection.${key}` as MessageKey);
  const titles = section('titles');
  const rows: ReportRow[] = [
    [titles, row('titles_all'), acc.a[0], acc.a[1]],
    [titles, row('titles_with_items'), acc.w, acc.a[1]],
    [titles, row('titles_without_items'), acc.n, 0],
    [titles, row('titles_electronic'), acc.e[0], acc.e[1]],
  ];
  // The statuses a copy in the stock has, always; another one only when a copy has it (a row out of step).
  for (const status of ITEM_STATUSES) {
    const p = acc.s[status];
    if (STOCK_STATUSES.includes(status) || p !== undefined) rows.push([section('items_by_status'), vocabLabel(ctx, 'item_status', status), p?.[0] ?? 0, p?.[1] ?? 0]);
  }
  const keys = (map: Record<string, Pair>) => Object.keys(map).filter((k) => k !== GROUP_NONE);
  rows.push(...masterRows(section('titles_by_material_type'), acc.m, await materialTypesByCode(ctx, keys(acc.m)), row('no_items')));
  rows.push(...masterRows(section('items_by_collection_type'), acc.c, await collectionTypesById(ctx, keys(acc.c)), row('no_items')));
  rows.push(...masterRows(section('items_by_location'), acc.l, await locationsById(ctx, keys(acc.l)), row('no_location')));
  return rows;
}

/** The collection at a glance: titles, copies by status, titles by material type, copies by collection type and location. */
export const collectionSummaryReport: TableReport = Object.freeze<TableReport>({
  id: 'collection.summary',
  module: 'collection',
  kind: 'table',
  titleKey: 'report.collection.summary.title',
  permission: 'reports.statistics.read',
  personal: false,
  formats: ['csv', 'xlsx', 'pdf'],
  orientation: 'portrait',
  params: [reportParam('branchId', 'branch'), reportParam('asOf', 'asOf')],
  paramsSchema: z.strictObject({ branchId: reportIdField.optional(), asOf: dateField.optional() }),
  columns: [reportColumn('section', 'text'), reportColumn('item', 'text'), reportColumn('titles', 'int'), reportColumn('items', 'int')],
  /** A stock on another day than today needs the scan (the run code leaves `asOf` out when it is today). */
  scanBased: (params: Record<string, unknown>) => params['asOf'] !== undefined,
  async rows(ctx, cursor, limit) {
    const { day, scan } = stockDay(ctx);
    const branchId = textParam(ctx, 'branchId');
    if (!scan) return offsetPage(await summaryRows(ctx, await countToday(ctx, branchId)), cursor, limit);
    const electronic = new Set(ctx.settings.electronicMaterialTypeCodes);
    const step = await scanAggregate(ctx, cursor, {
      branchId,
      schema: SummaryAccSchema,
      init: emptyAcc,
      visit: (acc, batch) => addBatch(acc, batch, day, branchId, electronic),
    });
    if (!step.done) return { rows: [], nextCursor: step.cursor };
    return { rows: await summaryRows(ctx, step.acc), nextCursor: null };
  },
});
