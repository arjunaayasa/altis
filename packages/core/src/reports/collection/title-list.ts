import { countGrouped, countRows } from '@altis/db';
import { AUDIENCES } from '@altis/shared';
import { dateField } from '@altis/shared/api/catalog/common';
import { sql, type RawBuilder, type SqlBool } from 'kysely';
import { z } from 'zod';
import { reportClassPrefixField, reportColumn, reportDateRangeField, reportIdField, reportParam } from '../params.js';
import type { RecordStockFacts } from '../stock/index.js';
import type { ReportCtx, ReportRow, TableReport } from '../types.js';
import {
  SCHOOL_LOCAL_WORKS,
  allOf,
  chunks,
  classPrefixSql,
  decodeCursor,
  encodeCursor,
  fictionSql,
  instantRange,
  isFiction,
  itemScopeSql,
  liveItemSql,
  rangeParam,
  scopesItems,
  stockCopies,
  stockDay,
  stockTitleSql,
  textCell,
  textParam,
  titleCell,
  type ItemScope,
} from './common.js';
import { scanList, type ListEntry } from './stock-agg.js';

// The titles of the collection (spec §9.1), with their details and number of copies, filtered by the record (material
// type, class prefix, language, date of input, year of publication, local works of the school, reader audience), by
// their copies (branch, location, collection type: a title with such a copy, counting those copies) and by the fiction
// rule. Without `asOf` every title that is not archived is listed with its copies that are not withdrawn; with `asOf`
// only the stock of that day, with its copies in the stock. Today's list (and the list without a day) is read in title
// order by keyset; another day's list reads the stock scan, in the scan's order.

/** A year of publication (older than the years of acquisition). */
const PUBLICATION_YEAR = z.int().min(1000).max(2100);

/** How the list reads: every title, today's stock (both from the current rows), or another day's stock (the scan). */
type Mode = { kind: 'all' } | { kind: 'stock'; day: string } | { kind: 'scan'; day: string };

function modeOf(ctx: ReportCtx): Mode {
  if (ctx.params['asOf'] === undefined) return { kind: 'all' };
  const { day, scan } = stockDay(ctx);
  return scan ? { kind: 'scan', day } : { kind: 'stock', day };
}

function scopeOf(ctx: ReportCtx): ItemScope {
  return { branchId: textParam(ctx, 'branchId'), locationId: textParam(ctx, 'locationId'), collectionTypeId: textParam(ctx, 'collectionTypeId') };
}

/** The filters on the record itself (the same in every mode). */
function recordFilters(ctx: ReportCtx): RawBuilder<SqlBool>[] {
  const p = ctx.params;
  const parts: RawBuilder<SqlBool>[] = [];
  const materialTypeId = textParam(ctx, 'materialTypeId');
  if (materialTypeId !== null) parts.push(sql<SqlBool>`${sql.ref('r.material_type_id')} = ${materialTypeId}`);
  const classPrefix = textParam(ctx, 'classPrefix');
  if (classPrefix !== null) parts.push(classPrefixSql('r', classPrefix));
  const languageId = textParam(ctx, 'languageId');
  if (languageId !== null) parts.push(sql<SqlBool>`${sql.ref('r.language_id')} = ${languageId}`);
  const input = instantRange(ctx.tz, rangeParam(ctx, 'input'));
  if (input.from !== null) parts.push(sql<SqlBool>`${sql.ref('r.created_at')} >= ${input.from}`);
  if (input.to !== null) parts.push(sql<SqlBool>`${sql.ref('r.created_at')} < ${input.to}`);
  const year = (name: string) => (typeof p[name] === 'number' ? String(p[name]).padStart(4, '0') : null);
  const pubFrom = year('pubYearFrom');
  const pubTo = year('pubYearTo');
  if (pubFrom !== null) parts.push(sql<SqlBool>`${sql.ref('r.publication_year')} >= ${pubFrom}`);
  if (pubTo !== null) parts.push(sql<SqlBool>`${sql.ref('r.publication_year')} <= ${pubTo}`);
  if (p['localWorkOnly'] === true) parts.push(sql<SqlBool>`${sql.ref('r.local_work')} in (${sql.join(SCHOOL_LOCAL_WORKS)})`);
  const audience = textParam(ctx, 'audience');
  if (audience !== null) parts.push(sql<SqlBool>`${sql.ref('r.audience')} = ${audience}`);
  return parts;
}

/** A copy `i` the list counts: not withdrawn (every title) or in the stock of the day. */
function copySql(i: string, mode: Mode): RawBuilder<SqlBool> {
  return mode.kind === 'all' ? sql<SqlBool>`${sql.ref(`${i}.archived_at`)} is null` : liveItemSql(i, mode.day);
}

/** The titles of the list read from the current rows (every title, or today's stock). */
function titleWhere(ctx: ReportCtx, mode: Exclude<Mode, { kind: 'scan' }>): RawBuilder<SqlBool> {
  const scope = scopeOf(ctx);
  const parts = recordFilters(ctx);
  if (mode.kind === 'stock') parts.push(stockTitleSql('r', mode.day, scope, ctx.settings.electronicMaterialTypeCodes));
  else {
    parts.push(sql<SqlBool>`${sql.ref('r.archived_at')} is null`);
    if (scopesItems(scope)) parts.push(sql<SqlBool>`exists (select 1 from items ai where ai.record_id = ${sql.ref('r.id')} and ${copySql('ai', mode)} and ${itemScopeSql('ai', scope)})`);
  }
  if (ctx.params['fictionOnly'] === true) parts.push(fictionSql('r', mode.kind === 'stock' ? mode.day : ctx.today, scope.branchId, ctx.settings));
  return allOf(parts);
}

/** What a row shows of a record. */
const DISPLAY = [
  'r.id',
  'r.title_key',
  'r.title',
  'r.subtitle',
  'r.responsibility',
  'r.edition',
  'p.name_display as publisher',
  'r.publication_place',
  'p.place as publisher_place',
  'r.publication_year',
  'r.publication_date_text',
  'r.classification',
  'r.call_number',
] as const;

function displayQuery(ctx: ReportCtx) {
  return ctx.db.selectFrom('records as r').leftJoin('publishers as p', 'p.id', 'r.publisher_id').select(DISPLAY);
}

type Display = Awaited<ReturnType<ReturnType<typeof displayQuery>['execute']>>[number];

/** The first ISBN or ISSN of each record of `ids`. */
async function standardNumbers(ctx: ReportCtx, ids: readonly string[]): Promise<Map<string, string>> {
  const out = new Map<string, string>();
  for (const part of chunks(ids)) {
    const rows = await ctx.db
      .selectFrom('record_identifiers')
      .select(['record_id', 'value_display'])
      .where('record_id', 'in', part)
      .where('type', 'in', ['isbn', 'issn'])
      .orderBy('record_id')
      .orderBy('sort_order')
      .orderBy('id')
      .execute();
    for (const r of rows) if (!out.has(r.record_id)) out.set(r.record_id, r.value_display);
  }
  return out;
}

/** The row of a title. */
function titleRow(d: Display, isbn: string | undefined, items: number): ReportRow {
  const responsibility = textCell(d.responsibility);
  return [
    responsibility === null ? titleCell(d) : `${titleCell(d)} / ${responsibility}`,
    textCell(d.edition),
    textCell(d.publisher),
    textCell(d.publication_place) ?? textCell(d.publisher_place),
    textCell(d.publication_year) ?? textCell(d.publication_date_text),
    isbn ?? null,
    textCell(d.classification),
    textCell(d.call_number),
    items,
  ];
}

const keyset = z.tuple([z.string().max(400), z.string().min(1).max(26)]);

/** A page of the list from the current rows, in title order. */
async function sqlPage(ctx: ReportCtx, mode: Exclude<Mode, { kind: 'scan' }>, cursor: string | null, limit: number): Promise<{ rows: ReportRow[]; nextCursor: string | null }> {
  let q = displayQuery(ctx).where(titleWhere(ctx, mode)).orderBy('r.title_key').orderBy('r.id').limit(limit + 1);
  if (cursor !== null) {
    const [titleKey, id] = decodeCursor(cursor, keyset);
    q = q.where((eb) => eb.or([eb('r.title_key', '>', titleKey), eb.and([eb('r.title_key', '=', titleKey), eb('r.id', '>', id)])]));
  }
  const found = await q.execute();
  const page = found.slice(0, limit);
  const ids = page.map((d) => d.id);
  const isbn = await standardNumbers(ctx, ids);
  const items = new Map<string, number>();
  const scope = scopeOf(ctx);
  for (const part of chunks(ids)) {
    const copies = ctx.db.selectFrom('items as i').where('i.record_id', 'in', part).where(copySql('i', mode)).where(itemScopeSql('i', scope));
    for (const row of await countGrouped(copies, { rid: 'i.record_id' })) items.set(String(row.rid), row.count);
  }
  const last = page[page.length - 1];
  return {
    rows: page.map((d) => titleRow(d, isbn.get(d.id), items.get(d.id) ?? 0)),
    nextCursor: found.length > limit && last !== undefined ? encodeCursor([last.title_key, last.id]) : null,
  };
}

/** The rows of a scan batch: the titles in the stock of the day that pass the filters, in the scan's order. */
async function scanEntries(ctx: ReportCtx, batch: readonly RecordStockFacts[], day: string): Promise<ListEntry[]> {
  const electronic = new Set(ctx.settings.electronicMaterialTypeCodes);
  const scope = scopeOf(ctx);
  const copies = new Map<string, number>();
  for (const r of batch) {
    const live = stockCopies(r, day, electronic, scope);
    if (live === null) continue;
    if (ctx.params['fictionOnly'] === true && !isFiction(r, day, ctx.settings)) continue;
    copies.set(r.recordId, live.length);
  }
  if (copies.size === 0) return [];
  const ids = [...copies.keys()];
  const shown = new Map<string, Display>();
  for (const part of chunks(ids)) {
    for (const d of await displayQuery(ctx).where('r.id', 'in', part).where(allOf(recordFilters(ctx))).execute()) shown.set(d.id, d);
  }
  const isbn = await standardNumbers(ctx, [...shown.keys()]);
  return ids.flatMap((id) => {
    const d = shown.get(id);
    return d === undefined ? [] : [{ recordId: id, itemId: null, row: titleRow(d, isbn.get(id), copies.get(id)!) }];
  });
}

/** The titles of the collection with their copies, filtered. */
export const collectionTitleListReport: TableReport = Object.freeze<TableReport>({
  id: 'collection.title_list',
  module: 'collection',
  kind: 'table',
  titleKey: 'report.collection.title_list.title',
  permission: 'reports.statistics.read',
  personal: false,
  formats: ['csv', 'xlsx', 'pdf'],
  orientation: 'landscape',
  params: [
    reportParam('materialTypeId', 'materialType'),
    reportParam('collectionTypeId', 'collectionType'),
    reportParam('classPrefix', 'classPrefix'),
    reportParam('languageId', 'language'),
    reportParam('input', 'dateRange'),
    reportParam('pubYearFrom', 'year', { min: 1000, max: 2100 }),
    reportParam('pubYearTo', 'year', { min: 1000, max: 2100 }),
    reportParam('branchId', 'branch'),
    reportParam('locationId', 'location'),
    reportParam('fictionOnly', 'bool'),
    reportParam('localWorkOnly', 'bool'),
    reportParam('audience', 'status', { options: AUDIENCES, optionLabelPrefix: 'vocab.audience.' }),
    reportParam('asOf', 'asOf'),
  ],
  paramsSchema: z
    .strictObject({
      materialTypeId: reportIdField.optional(),
      collectionTypeId: reportIdField.optional(),
      classPrefix: reportClassPrefixField.optional(),
      languageId: reportIdField.optional(),
      input: reportDateRangeField.optional(),
      pubYearFrom: PUBLICATION_YEAR.optional(),
      pubYearTo: PUBLICATION_YEAR.optional(),
      branchId: reportIdField.optional(),
      locationId: reportIdField.optional(),
      fictionOnly: z.boolean().optional(),
      localWorkOnly: z.boolean().optional(),
      audience: z.enum(AUDIENCES).optional(),
      asOf: dateField.optional(),
    })
    .check((c) => {
      const { pubYearFrom, pubYearTo } = c.value;
      if (pubYearFrom !== undefined && pubYearTo !== undefined && pubYearFrom > pubYearTo) {
        c.issues.push({ code: 'custom', path: ['pubYearTo'], params: { code: 'invalid' }, message: 'invalid', input: pubYearTo });
      }
    }),
  columns: [
    ...['title', 'edition', 'publisher', 'place', 'year', 'isbn_issn', 'classification', 'call_number'].map((key) => reportColumn(key, 'text')),
    reportColumn('items', 'int'),
  ],
  scanBased: (params: Record<string, unknown>) => params['asOf'] !== undefined,
  async rows(ctx, cursor, limit) {
    const mode = modeOf(ctx);
    if (mode.kind !== 'scan') return sqlPage(ctx, mode, cursor, limit);
    return scanList(ctx, cursor, limit, { branchId: scopeOf(ctx).branchId, entries: (batch) => scanEntries(ctx, batch, mode.day) });
  },
  /** The number of titles, read from the current rows; unknown for another day's stock. */
  async count(ctx) {
    const mode = modeOf(ctx);
    if (mode.kind === 'scan') return null;
    return countRows(ctx.db.selectFrom('records as r').where(titleWhere(ctx, mode)));
  },
});
