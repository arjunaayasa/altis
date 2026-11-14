import { countRows } from '@altis/db';
import { sql, type RawBuilder, type SqlBool } from 'kysely';
import { z } from 'zod';
import { reportColumn, reportDateRangeField, reportIdField, reportParam } from '../params.js';
import type { ReportCtx, ReportRow, TableReport } from '../types.js';
import { allOf, chunks, decodeCursor, encodeCursor, moneyCell, rangeParam, textCell, textParam, titleCell, vocabLabel } from './common.js';

// The accession register (spec §9.1, "buku induk"): every copy the library received, by receiving date, then inventory
// number (a copy without one first within its day), then id, read by keyset along the index on (received_date,
// inventory_no). The copies without a receiving date follow, by inventory number, unless a receiving-date range is
// asked for. Withdrawn copies stay in the register (it records what was received); ordered copies are not in it yet.

/** The two parts of the register: the dated copies, then the undated ones. */
type Part = 'dated' | 'undated';

/** Where a page ends: the part, and the receiving date, inventory number and id of its last copy. */
const PositionSchema = z.strictObject({
  p: z.enum(['dated', 'undated']),
  r: z.string().max(10).nullable(),
  n: z.string().max(400).nullable(),
  i: z.string().min(1).max(26).nullable(),
});

type Position = z.infer<typeof PositionSchema>;

/** The copies of the register (both parts, or the dated part of a range). */
function registerWhere(ctx: ReportCtx): RawBuilder<SqlBool> {
  const parts: RawBuilder<SqlBool>[] = [sql<SqlBool>`${sql.ref('i.status')} <> 'on_order'`];
  const branchId = textParam(ctx, 'branchId');
  if (branchId !== null) parts.push(sql<SqlBool>`${sql.ref('i.branch_id')} = ${branchId}`);
  const range = rangeParam(ctx, 'received');
  if (range.from !== null) parts.push(sql<SqlBool>`${sql.ref('i.received_date')} >= ${range.from}`);
  if (range.to !== null) parts.push(sql<SqlBool>`${sql.ref('i.received_date')} <= ${range.to}`);
  return allOf(parts);
}

/** The copies after (inventory number `n`, id `i`) within one receiving date: a copy without a number comes first. */
function afterInventory(n: string | null, i: string): RawBuilder<SqlBool> {
  const inv = sql.ref('i.inventory_no');
  const id = sql.ref('i.id');
  if (n === null) return sql<SqlBool>`(${inv} is not null or ${id} > ${i})`;
  return sql<SqlBool>`(${inv} is not null and (${inv} > ${n} or (${inv} = ${n} and ${id} > ${i})))`;
}

function displayQuery(ctx: ReportCtx) {
  return ctx.db
    .selectFrom('items as i')
    .innerJoin('records as r', 'r.id', 'i.record_id')
    .leftJoin('publishers as p', 'p.id', 'r.publisher_id')
    .leftJoin('suppliers as s', 's.id', 'i.supplier_id')
    .select([
      'i.id',
      'i.inventory_no',
      'i.barcode_display',
      'i.received_date',
      'r.id as record_id',
      'r.title',
      'r.subtitle',
      'r.responsibility',
      'r.edition',
      'r.publication_place',
      'p.place as publisher_place',
      'p.name_display as publisher',
      'r.publication_year',
      'r.publication_date_text',
      'r.physical_desc',
      'i.price',
      'i.acq_source',
      's.name as supplier',
      'i.call_number',
      'r.call_number as record_call_number',
    ]);
}

type Display = Awaited<ReturnType<ReturnType<typeof displayQuery>['execute']>>[number];

/** Up to `max` copies of `part` after `after` (null: from the part's start), in register order. */
async function readPart(ctx: ReportCtx, part: Part, after: Position | null, max: number): Promise<Display[]> {
  const inventoryRank = sql`case when ${sql.ref('i.inventory_no')} is null then 0 else 1 end`;
  let q = displayQuery(ctx).where(registerWhere(ctx));
  if (part === 'dated') {
    q = q.where('i.received_date', 'is not', null);
    if (after !== null && after.r !== null && after.i !== null) {
      const received = sql.ref('i.received_date');
      q = q.where(sql<SqlBool>`(${received} > ${after.r} or (${received} = ${after.r} and ${afterInventory(after.n, after.i)}))`);
    }
    q = q.orderBy('i.received_date');
  } else {
    q = q.where('i.received_date', 'is', null);
    if (after !== null && after.i !== null) q = q.where(afterInventory(after.n, after.i));
  }
  return q.orderBy(inventoryRank).orderBy('i.inventory_no').orderBy('i.id').limit(max).execute();
}

/** The authors of each record of `ids`: the main entry first, then in their order. */
async function authorsOf(ctx: ReportCtx, ids: readonly string[]): Promise<Map<string, string>> {
  const out = new Map<string, string[]>();
  for (const part of chunks(ids)) {
    const rows = await ctx.db
      .selectFrom('record_agents as ra')
      .innerJoin('agents as a', 'a.id', 'ra.agent_id')
      .select(['ra.record_id', 'a.name_display'])
      .where('ra.record_id', 'in', part)
      .orderBy('ra.record_id')
      .orderBy('ra.is_main', 'desc')
      .orderBy('ra.sort_order')
      .orderBy('a.id')
      .execute();
    for (const r of rows) {
      const names = out.get(r.record_id) ?? [];
      if (!names.includes(r.name_display)) names.push(r.name_display);
      out.set(r.record_id, names);
    }
  }
  return new Map([...out].map(([id, names]) => [id, names.join('; ')]));
}

/** The first ISBN of each record of `ids`. */
async function isbnOf(ctx: ReportCtx, ids: readonly string[]): Promise<Map<string, string>> {
  const out = new Map<string, string>();
  for (const part of chunks(ids)) {
    const rows = await ctx.db
      .selectFrom('record_identifiers')
      .select(['record_id', 'value_display'])
      .where('record_id', 'in', part)
      .where('type', '=', 'isbn')
      .orderBy('record_id')
      .orderBy('sort_order')
      .orderBy('id')
      .execute();
    for (const r of rows) if (!out.has(r.record_id)) out.set(r.record_id, r.value_display);
  }
  return out;
}

/** The rows of `copies`. */
async function registerRows(ctx: ReportCtx, copies: readonly Display[]): Promise<ReportRow[]> {
  const ids = [...new Set(copies.map((d) => d.record_id))];
  const authors = await authorsOf(ctx, ids);
  const isbn = await isbnOf(ctx, ids);
  return copies.map((d) => {
    const source = [vocabLabel(ctx, 'acq_source', d.acq_source), textCell(d.supplier)].filter((x): x is string => x !== null);
    return [
      textCell(d.inventory_no),
      d.barcode_display,
      d.received_date,
      titleCell(d),
      authors.get(d.record_id) ?? textCell(d.responsibility),
      textCell(d.edition),
      isbn.get(d.record_id) ?? null,
      textCell(d.publication_place) ?? textCell(d.publisher_place),
      textCell(d.publisher),
      textCell(d.publication_year) ?? textCell(d.publication_date_text),
      textCell(d.physical_desc),
      moneyCell(d.price),
      source.length === 0 ? null : source.join(', '),
      textCell(d.call_number) ?? textCell(d.record_call_number),
    ];
  });
}

/** The accession register: every copy by receiving date, then inventory number. */
export const collectionAccessionRegisterReport: TableReport = Object.freeze<TableReport>({
  id: 'collection.accession_register',
  module: 'collection',
  kind: 'table',
  titleKey: 'report.collection.accession_register.title',
  permission: 'reports.statistics.read',
  personal: false,
  formats: ['csv', 'xlsx', 'pdf'],
  orientation: 'landscape',
  params: [reportParam('received', 'dateRange'), reportParam('branchId', 'branch')],
  paramsSchema: z.strictObject({ received: reportDateRangeField.optional(), branchId: reportIdField.optional() }),
  columns: [
    reportColumn('inventory_no', 'text'),
    reportColumn('barcode', 'text'),
    reportColumn('received_date', 'date'),
    ...['title', 'authors', 'edition', 'isbn', 'place', 'publisher', 'year', 'collation'].map((key) => reportColumn(key, 'text')),
    reportColumn('price', 'money'),
    reportColumn('source', 'text'),
    reportColumn('call_number', 'text'),
  ],
  async rows(ctx, cursor, limit) {
    const range = rangeParam(ctx, 'received');
    const withUndated = range.from === null && range.to === null;
    let position: Position | null = cursor === null ? null : decodeCursor(cursor, PositionSchema);
    let part: Part = position?.p ?? 'dated';
    const copies: Display[] = [];
    for (;;) {
      const room = limit - copies.length;
      const found = await readPart(ctx, part, position, room + 1);
      const taken = found.slice(0, room);
      copies.push(...taken);
      if (found.length > room) {
        // A page filled by the dated part ends where the undated part begins.
        const last = taken[taken.length - 1];
        const next: Position = last === undefined ? { p: part, r: null, n: null, i: null } : { p: part, r: last.received_date, n: last.inventory_no, i: last.id };
        return { rows: await registerRows(ctx, copies), nextCursor: encodeCursor(next) };
      }
      if (part === 'undated' || !withUndated) return { rows: await registerRows(ctx, copies), nextCursor: null };
      part = 'undated';
      position = null;
    }
  },
  async count(ctx) {
    return countRows(ctx.db.selectFrom('items as i').where(registerWhere(ctx)));
  },
});
