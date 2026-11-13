import { countDistinctGrouped, countGrouped, countRows } from '@altis/db';
import { DDC_MAINS, compareDdcRowKeys, ddcClassOf, ddcDivisionKey, ddcRowKind, foldByDdc, type DdcClass, type MessageKey } from '@altis/shared';
import { dateField } from '@altis/shared/api/catalog/common';
import { sql, type RawBuilder } from 'kysely';
import { z } from 'zod';
import { reportColumn, reportIdField, reportParam } from '../params.js';
import type { RecordStockFacts } from '../stock/index.js';
import type { ReportCtx, ReportRow, TableReport } from '../types.js';
import {
  GROUP_NONE,
  collectionTypesById,
  compareOrder,
  countedWithoutCopiesSql,
  fictionSql,
  isFiction,
  isReference,
  itemScopeSql,
  label,
  languagesById,
  liveItemSql,
  materialTypeCodeOf,
  materialTypesByCode,
  offsetPage,
  referenceSql,
  scopesItems,
  stockCopies,
  stockDay,
  stockTitleSql,
  textParam,
  type ItemScope,
  type MasterLabel,
} from './common.js';
import { scanAggregate } from './stock-agg.js';

// Titles and copies per DDC class (spec §9.1, §4.15): the main classes 000–900 (each opened into its ten divisions on
// request, labelled by their numbers only), the Islamic expansion 2X (never counted in 200), and "Lainnya" with one row
// per class number that is not DDC. A record's class comes from its classification, or from its call number when the
// classification is empty; each title is counted once, under its record's class, so the main classes add up to the
// totals row. A breakdown gives one row per class and group (material type, collection type, language, fiction /
// nonfiction / reference, print / electronic); a title with copies of two collection types counts in both groups.
//
// Today's recap groups the current rows by classification and call number in SQL and folds the groups into classes;
// another day's recap reads the stock scan and carries its counts per class in the cursor. Both end in the same rows.
// So that the cursor stays small, at most NON_TOKEN_ROWS_MAX class numbers outside DDC get a row of their own (the
// first ones in order); the others share one row, "Nomor kelas lain".

/** How the recap breaks each class down (one `group` per row). */
export const DDC_RECAP_BREAKDOWNS = Object.freeze(['none', 'material_type', 'collection_type', 'language', 'fnr', 'medium'] as const);

type Breakdown = (typeof DDC_RECAP_BREAKDOWNS)[number];

/** The most class numbers outside DDC with a row of their own. */
export const NON_TOKEN_ROWS_MAX = 100;

/** The groups of the fiction breakdown, in print order. */
const FNR = ['fiction', 'nonfiction', 'reference'] as const;
/** The groups of the medium breakdown, in print order. */
const MEDIA = ['print', 'electronic'] as const;

/** Titles and copies. */
type Pair = [number, number];

/** The recap's counts. */
interface DdcAcc {
  /** All titles and copies. */
  t: Pair;
  /** The group keys; the counts name a group by its index here. */
  g: string[];
  /** By atom (a main class, or a division with `divisions`; `2X`; `NON:<class number>`), by group index. */
  a: Record<string, Record<string, Pair>>;
  /** The class numbers outside DDC past the first NON_TOKEN_ROWS_MAX, by group index. */
  o: Record<string, Pair>;
}

const count = z.int().min(0).max(Number.MAX_SAFE_INTEGER);
const pair = z.tuple([count, count]);
const byGroup = z.record(z.string().regex(/^\d{1,4}$/), pair);
const DdcAccSchema: z.ZodType<DdcAcc> = z.strictObject({
  t: pair,
  g: z.array(z.string().max(64)).max(1000),
  a: z.record(z.string().min(1).max(300), byGroup),
  o: byGroup,
});

const emptyAcc = (): DdcAcc => ({ t: [0, 0], g: [], a: {}, o: {} });

/** The atom a class is counted under. */
function atomOf(c: DdcClass, divisions: boolean): string {
  if (c.main === '2X') return '2X';
  if (c.main === 'NON') return `NON:${c.token}`;
  return divisions && c.division !== null ? ddcDivisionKey(c.division) : c.main;
}

/** A classification that gives `atom` back through `ddcClassOf` (how the counts reach the shared fold). */
function atomClassification(atom: string): string {
  if (atom.startsWith('NON:')) return atom.slice('NON:'.length);
  return /^\d00-\d09$/.test(atom) ? atom.slice(0, 3) : atom;
}

function addPair(map: Record<string, Pair>, key: string, titles: number, items: number): void {
  const p = map[key] ?? [0, 0];
  map[key] = [p[0] + titles, p[1] + items];
}

function addInto(into: Record<string, Pair>, from: Record<string, Pair>): void {
  for (const [key, p] of Object.entries(from)) addPair(into, key, p[0], p[1]);
}

/**
 * Adds `titles` and `items` of group `group` under `atom`. A class number outside DDC beyond the first
 * NON_TOKEN_ROWS_MAX (in row order) goes into the shared row; one that comes earlier takes the place of the last.
 */
function addAtom(acc: DdcAcc, atom: string, group: string, titles: number, items: number): void {
  let gi = acc.g.indexOf(group);
  if (gi < 0) gi = acc.g.push(group) - 1;
  const key = String(gi);
  let counts = acc.a[atom];
  if (counts === undefined && atom.startsWith('NON:')) {
    const tokens = Object.keys(acc.a).filter((a) => a.startsWith('NON:'));
    if (tokens.length >= NON_TOKEN_ROWS_MAX) {
      const last = tokens.reduce((x, y) => (compareDdcRowKeys(x, y) >= 0 ? x : y));
      if (compareDdcRowKeys(atom, last) > 0) {
        addPair(acc.o, key, titles, items);
        return;
      }
      addInto(acc.o, acc.a[last]!);
      delete acc.a[last];
    }
  }
  if (counts === undefined) acc.a[atom] = counts = {};
  addPair(counts, key, titles, items);
}

/** The recap's filters. */
interface DdcFilters {
  day: string;
  scope: ItemScope;
  materialTypeId: string | null;
  divisions: boolean;
  breakdown: Breakdown;
}

function filtersOf(ctx: ReportCtx, day: string): DdcFilters {
  return {
    day,
    scope: { branchId: textParam(ctx, 'branchId'), locationId: textParam(ctx, 'locationId'), collectionTypeId: textParam(ctx, 'collectionTypeId') },
    materialTypeId: textParam(ctx, 'materialTypeId'),
    divisions: ctx.params['divisions'] === true,
    breakdown: (ctx.params['breakdown'] as Breakdown | undefined) ?? 'none',
  };
}

/** Adds the titles of a scan batch that are in the stock on the day. */
function addBatch(ctx: ReportCtx, acc: DdcAcc, batch: readonly RecordStockFacts[], f: DdcFilters, materialCode: string | null): void {
  const electronic = new Set(ctx.settings.electronicMaterialTypeCodes);
  const referenceCodes = new Set(ctx.settings.referenceCollectionTypeCodes);
  for (const r of batch) {
    if (f.materialTypeId !== null && r.materialTypeCode !== materialCode) continue;
    const copies = stockCopies(r, f.day, electronic, f.scope);
    if (copies === null) continue;
    const atom = atomOf(ddcClassOf(r.classification, r.callNumber), f.divisions);
    acc.t = [acc.t[0] + 1, acc.t[1] + copies.length];
    switch (f.breakdown) {
      case 'none':
        addAtom(acc, atom, '', 1, copies.length);
        break;
      case 'material_type':
        addAtom(acc, atom, r.materialTypeCode ?? GROUP_NONE, 1, copies.length);
        break;
      case 'medium':
        addAtom(acc, atom, r.materialTypeCode !== null && electronic.has(r.materialTypeCode) ? 'electronic' : 'print', 1, copies.length);
        break;
      case 'language':
        addAtom(acc, atom, r.languageId ?? GROUP_NONE, 1, copies.length);
        break;
      case 'collection_type': {
        if (copies.length === 0) addAtom(acc, atom, GROUP_NONE, 1, 0);
        const n = new Map<string, number>();
        for (const i of copies) n.set(i.collectionTypeId ?? GROUP_NONE, (n.get(i.collectionTypeId ?? GROUP_NONE) ?? 0) + 1);
        for (const [group, items] of n) addAtom(acc, atom, group, 1, items);
        break;
      }
      case 'fnr': {
        const fiction = isFiction(r, f.day, ctx.settings);
        addAtom(acc, atom, isReference(r, f.day, ctx.settings) ? 'reference' : fiction ? 'fiction' : 'nonfiction', 1, 0);
        for (const i of copies) {
          const reference = i.collectionTypeCode !== null && referenceCodes.has(i.collectionTypeCode);
          addAtom(acc, atom, reference ? 'reference' : fiction ? 'fiction' : 'nonfiction', 0, 1);
        }
        break;
      }
    }
  }
}

// ---- today, from grouped queries ----------------------------------------------------------------------------------

/** The classification when it is not blank (the class is read from it). */
const CLS = sql<string | null>`case when trim(${sql.ref('r.classification')}) <> '' then ${sql.ref('r.classification')} end`;
/** The call number when the classification is blank (the class is read from it then). */
const CN = sql<string | null>`case when ${sql.ref('r.classification')} is null or trim(${sql.ref('r.classification')}) = '' then ${sql.ref('r.call_number')} end`;

type GroupedRow = Record<string, string | number | null> & { count: number };

/** The counts of today's stock, from grouped queries over the current rows. */
async function countToday(ctx: ReportCtx, f: DdcFilters): Promise<DdcAcc> {
  const { day, scope } = f;
  const electronic = ctx.settings.electronicMaterialTypeCodes;
  const referenceCodes = ctx.settings.referenceCollectionTypeCodes;
  const fiction = fictionSql('r', day, scope.branchId, ctx.settings);
  let titles = ctx.db.selectFrom('records as r').innerJoin('material_types as mt', 'mt.id', 'r.material_type_id').where(stockTitleSql('r', day, scope, electronic));
  let copies = ctx.db
    .selectFrom('items as i')
    .innerJoin('records as r', 'r.id', 'i.record_id')
    .innerJoin('material_types as mt', 'mt.id', 'r.material_type_id')
    .innerJoin('collection_types as ct', 'ct.id', 'i.collection_type_id')
    .where(liveItemSql('i', day))
    .where('r.archived_at', 'is', null)
    .where(itemScopeSql('i', scope));
  if (f.materialTypeId !== null) {
    titles = titles.where('r.material_type_id', '=', f.materialTypeId);
    copies = copies.where('r.material_type_id', '=', f.materialTypeId);
  }
  const acc = emptyAcc();
  acc.t = [await countRows(titles), await countRows(copies)];

  const empty = sql<string>`''`;
  const titleGroup: Record<Exclude<Breakdown, 'collection_type'>, RawBuilder<unknown>> = {
    none: empty,
    material_type: sql`${sql.ref('mt.code_key')}`,
    medium: sql`${sql.ref('mt.code_key')}`,
    language: sql`${sql.ref('r.language_id')}`,
    fnr: sql`case when ${referenceSql('r', day, scope.branchId, ctx.settings)} then 'reference' when ${fiction} then 'fiction' else 'nonfiction' end`,
  };
  const itemReference = referenceCodes.length === 0 ? sql`1 = 0` : sql`${sql.ref('ct.code_key')} in (${sql.join(referenceCodes)})`;
  const itemGroup: Record<Breakdown, RawBuilder<unknown>> = {
    ...titleGroup,
    collection_type: sql`${sql.ref('i.collection_type_id')}`,
    fnr: sql`case when ${itemReference} then 'reference' when ${fiction} then 'fiction' else 'nonfiction' end`,
  };
  const keys = { cls: 'x.cls', cn: 'x.cn', g: 'x.g' } as const;
  const group = (g: string | number | null): string => {
    if (g === null) return GROUP_NONE;
    const key = String(g);
    if (f.breakdown === 'medium') return electronic.includes(key) ? 'electronic' : 'print';
    return key;
  };
  const add = (rows: readonly GroupedRow[], side: 0 | 1) => {
    for (const row of rows) {
      const atom = atomOf(ddcClassOf(row['cls'] as string | null, row['cn'] as string | null), f.divisions);
      addAtom(acc, atom, group(row['g'] ?? null), side === 0 ? row.count : 0, side === 1 ? row.count : 0);
    }
  };

  const copyGroups = copies.select([CLS.as('cls'), CN.as('cn'), itemGroup[f.breakdown].as('g'), 'i.record_id as rid']);
  if (f.breakdown === 'collection_type') {
    add(await countDistinctGrouped(ctx.db.selectFrom(copyGroups.as('x')), keys, 'x.rid'), 0);
    if (!scopesItems(scope)) {
      let without = ctx.db.selectFrom('records as r').where('r.archived_at', 'is', null).where(countedWithoutCopiesSql('r', electronic));
      if (f.materialTypeId !== null) without = without.where('r.material_type_id', '=', f.materialTypeId);
      // No group key: a title without copies is in the group of none.
      add(await countGrouped(ctx.db.selectFrom(without.select([CLS.as('cls'), CN.as('cn')]).as('x')), { cls: 'x.cls', cn: 'x.cn' }), 0);
    }
  } else {
    add(await countGrouped(ctx.db.selectFrom(titles.select([CLS.as('cls'), CN.as('cn'), titleGroup[f.breakdown].as('g')]).as('x')), keys), 0);
  }
  add(await countGrouped(ctx.db.selectFrom(copyGroups.as('x')), keys), 1);
  return acc;
}

// ---- rows ---------------------------------------------------------------------------------------------------------

/** The label of each group key of the breakdown, in print order. */
async function groupLabels(ctx: ReportCtx, f: DdcFilters, keys: readonly string[]): Promise<{ key: string; label: string | null }[]> {
  const fixed = (list: readonly string[], prefix: string) =>
    list.filter((k) => keys.includes(k)).map((k) => ({ key: k, label: label(ctx, `${prefix}${k}` as MessageKey) }));
  if (f.breakdown === 'none') return keys.map((key) => ({ key, label: null }));
  if (f.breakdown === 'fnr') return fixed(FNR, 'report.group.fnr.');
  if (f.breakdown === 'medium') return fixed(MEDIA, 'report.group.medium.');
  const real = keys.filter((k) => k !== GROUP_NONE);
  let masters: Map<string, MasterLabel>;
  let none: string;
  if (f.breakdown === 'material_type') {
    masters = await materialTypesByCode(ctx, real);
    none = label(ctx, 'report.row.collection.no_items');
  } else if (f.breakdown === 'collection_type') {
    masters = await collectionTypesById(ctx, real);
    none = label(ctx, 'report.row.collection.no_items');
  } else {
    masters = await languagesById(ctx, real);
    none = label(ctx, 'report.row.collection.no_language');
  }
  const orderOf = (k: string): readonly (string | number)[] => (k === GROUP_NONE ? [2] : masters.has(k) ? [0, ...masters.get(k)!.order] : [1, k]);
  return [...keys].sort((a, b) => compareOrder(orderOf(a), orderOf(b))).map((k) => ({ key: k, label: k === GROUP_NONE ? none : (masters.get(k)?.label ?? k) }));
}

/** The class and label cells of a row key. */
function rowHead(ctx: ReportCtx, key: string): [string, string] {
  const kind = ddcRowKind(key);
  if (kind === 'division') {
    const from = key.slice(0, 3);
    return [key, `${from}–${from.slice(0, 2)}9`];
  }
  if (kind === 'NON_token') {
    const token = key.slice('NON:'.length);
    return ['NON', token === '' ? label(ctx, 'report.row.collection.no_class_token') : token];
  }
  return [key, label(ctx, `vocab.ddc_main.${key}` as MessageKey)];
}

/** The recap's rows from its counts: classes in DDC order, each with its groups; the shared row of other numbers last. */
async function ddcRows(ctx: ReportCtx, acc: DdcAcc, f: DdcFilters): Promise<ReportRow[]> {
  const merge = (into: Record<string, Pair> | undefined, v: Record<string, Pair>): Record<string, Pair> => {
    const out: Record<string, Pair> = { ...(into ?? {}) };
    addInto(out, v);
    return out;
  };
  const atoms = Object.entries(acc.a).map(([atom, value]) => ({ classification: atomClassification(atom), callNumber: null, value }));
  const folded = foldByDdc(atoms, merge, { divisions: f.divisions, nonTokens: true });
  const other = Object.keys(acc.o).length > 0;
  if (other) folded.set('NON', merge(folded.get('NON'), acc.o));
  const keys = new Set<string>(DDC_MAINS);
  if (f.divisions) for (const main of DDC_MAINS.slice(0, 10)) for (let d = 0; d < 10; d += 1) keys.add(ddcDivisionKey(`${main[0]}${d}0`));
  for (const key of folded.keys()) keys.add(key);
  const ordered = [...keys].sort(compareDdcRowKeys);
  const labels = await groupLabels(ctx, f, acc.g);
  const index = new Map(acc.g.map((g, k) => [g, String(k)]));

  const rows: ReportRow[] = [];
  const push = (cls: string, text: string, counts: Record<string, Pair> | undefined) => {
    let any = false;
    for (const g of labels) {
      const p = counts?.[index.get(g.key)!];
      if (p === undefined || (p[0] === 0 && p[1] === 0)) continue;
      rows.push([cls, text, g.label, p[0], p[1]]);
      any = true;
    }
    if (!any) rows.push([cls, text, null, 0, 0]);
  };
  for (const key of ordered) push(...rowHead(ctx, key), folded.get(key));
  if (other) push('NON', label(ctx, 'report.row.collection.other_tokens'), acc.o);
  return rows;
}

/** The totals row: every title once, and every copy. */
function totalsRow(ctx: ReportCtx, acc: DdcAcc): ReportRow {
  return [null, label(ctx, 'report.row.total'), null, acc.t[0], acc.t[1]];
}

/** Titles and copies per DDC main class (with divisions), `2X` and the other classes. */
export const collectionDdcRecapReport: TableReport = Object.freeze<TableReport>({
  id: 'collection.ddc_recap',
  module: 'collection',
  kind: 'table',
  titleKey: 'report.collection.ddc_recap.title',
  permission: 'reports.statistics.read',
  personal: false,
  formats: ['csv', 'xlsx', 'pdf'],
  orientation: 'portrait',
  params: [
    reportParam('branchId', 'branch'),
    reportParam('asOf', 'asOf'),
    reportParam('locationId', 'location'),
    reportParam('collectionTypeId', 'collectionType'),
    reportParam('materialTypeId', 'materialType'),
    reportParam('divisions', 'bool'),
    reportParam('breakdown', 'status', { options: DDC_RECAP_BREAKDOWNS }),
  ],
  paramsSchema: z.strictObject({
    branchId: reportIdField.optional(),
    asOf: dateField.optional(),
    locationId: reportIdField.optional(),
    collectionTypeId: reportIdField.optional(),
    materialTypeId: reportIdField.optional(),
    divisions: z.boolean().optional(),
    breakdown: z.enum(DDC_RECAP_BREAKDOWNS).default('none'),
  }),
  columns: [
    reportColumn('class', 'text'),
    reportColumn('label', 'text'),
    reportColumn('group', 'text'),
    reportColumn('titles', 'int'),
    reportColumn('items', 'int'),
  ],
  scanBased: (params: Record<string, unknown>) => params['asOf'] !== undefined,
  /**
   * Today's rows a page at a time, with the totals row apart; another day's rows all in the call that ends the scan,
   * the totals row last among them.
   */
  async rows(ctx, cursor, limit) {
    const { day, scan } = stockDay(ctx);
    const f = filtersOf(ctx, day);
    if (!scan) return offsetPage(await ddcRows(ctx, await countToday(ctx, f), f), cursor, limit);
    const materialCode = f.materialTypeId === null ? null : await materialTypeCodeOf(ctx.db, f.materialTypeId);
    const step = await scanAggregate(ctx, cursor, {
      branchId: f.scope.branchId,
      schema: DdcAccSchema,
      init: emptyAcc,
      visit: (acc, batch) => addBatch(ctx, acc, batch, f, materialCode),
    });
    if (!step.done) return { rows: [], nextCursor: step.cursor };
    return { rows: [...(await ddcRows(ctx, step.acc, f)), totalsRow(ctx, step.acc)], nextCursor: null };
  },
  /** Today's totals row; another day's is the last of its rows. */
  async totals(ctx) {
    const { day, scan } = stockDay(ctx);
    if (scan) return null;
    const f = filtersOf(ctx, day);
    let titles = ctx.db.selectFrom('records as r').where(stockTitleSql('r', day, f.scope, ctx.settings.electronicMaterialTypeCodes));
    let copies = ctx.db
      .selectFrom('items as i')
      .innerJoin('records as r', 'r.id', 'i.record_id')
      .where(liveItemSql('i', day))
      .where('r.archived_at', 'is', null)
      .where(itemScopeSql('i', f.scope));
    if (f.materialTypeId !== null) {
      titles = titles.where('r.material_type_id', '=', f.materialTypeId);
      copies = copies.where('r.material_type_id', '=', f.materialTypeId);
    }
    const acc = emptyAcc();
    acc.t = [await countRows(titles), await countRows(copies)];
    return totalsRow(ctx, acc);
  },
});
