import { countRows, type DB } from '@altis/db';
import { DDC_MAINS, isUlid, STOCKTAKE_SOURCES, STOCKTAKE_STATUSES, t } from '@altis/shared';
import type { Kysely } from 'kysely';
import { z } from 'zod';
import { decodeCursor, encodeCursor, masterName, textParam, vocabLabel } from '../collection/common.js';
import { escapeLike, localDateTime, titleMatchSql } from '../circulation/common.js';
import { reportClassPrefixField, reportColumn, reportIdField, reportParam } from '../params.js';
import type { ReportCtx, ReportRow, TableReport } from '../types.js';

// The stocktake reports (inventarisasi), all of `stocktake.scan.use`:
// - progress: the counts of a session (in scope, found, misplaced, on loan, not found, the share found) for the whole
//   scope, per DDC main class and per collection type;
// - missing: the copies of a session not found (yet), with what they are and where they belong; filtered by words of
//   the title, the barcode's start, the class prefix, the collection type and the location;
// - misplaced: the copies found at another place than their own: where they belong and where they were scanned;
// - by officer (personal data: staff names): what each officer scanned;
// - history: every session, newest first, with its counts and where it came from.
//
// Scanning is a branch permission: a session report is checked at the session's branch, the history at the branch it
// is asked for (every branch: the permission held globally), so a role granted at one branch only reads that branch's.

const SESSION_PARAM = reportParam('stocktakeId', 'stocktake', { required: true });
const sessionField = { stocktakeId: reportIdField };

const idKeyset = z.tuple([z.string().min(1).max(26)]);

/** The branch of the session the parameters name (none for an id that is no session). */
async function sessionBranch(db: Kysely<DB>, params: Readonly<Record<string, unknown>>): Promise<string | null> {
  const id = params['stocktakeId'];
  if (typeof id !== 'string' || !isUlid(id)) return null;
  return (await db.selectFrom('stocktakes').select('branch_id').where('id', '=', id).executeTakeFirst())?.branch_id ?? null;
}

/** The branch the history is asked for (null: every branch). */
async function historyBranch(_db: Kysely<DB>, params: Readonly<Record<string, unknown>>): Promise<string | null> {
  const id = params['branchId'];
  return typeof id === 'string' && isUlid(id) ? id : null;
}

/** The DDC main class of a stored class key (`000`–`990`, `2X`), else `NON`. */
function mainOf(key: string | null): string {
  if (key === null) return 'NON';
  if (key === '2X') return '2X';
  return /^\d/.test(key) ? `${key[0]}00` : 'NON';
}

function pct(found: number, expected: number): number | null {
  return expected === 0 ? null : Math.round((found / expected) * 1000) / 10;
}

/** The progress of a session (see the top of this file). */
export const stocktakeProgressReport: TableReport = Object.freeze<TableReport>({
  id: 'stocktake.progress',
  module: 'stocktake',
  kind: 'table',
  titleKey: 'report.stocktake.progress.title',
  permission: 'stocktake.scan.use',
  branchOf: sessionBranch,
  personal: false,
  formats: ['csv', 'xlsx', 'pdf'],
  orientation: 'portrait',
  params: [SESSION_PARAM],
  paramsSchema: z.strictObject(sessionField),
  columns: [
    reportColumn('section', 'text', { widthChars: 20 }),
    reportColumn('label', 'text', { widthChars: 24 }),
    reportColumn('expected', 'int'),
    reportColumn('found', 'int'),
    reportColumn('misplaced', 'int'),
    reportColumn('on_loan', 'int'),
    reportColumn('pending', 'int'),
    reportColumn('pct', 'percent'),
  ],
  async rows(ctx, cursor) {
    if (cursor !== null) return { rows: [], nextCursor: null };
    const id = textParam(ctx, 'stocktakeId') ?? '';
    const rows = await ctx.db.selectFrom('stocktake_items').select(['state', 'stat_ddc', 'collection_type_id']).where('stocktake_id', '=', id).where('expected', '=', 1).execute();
    type T = { expected: number; found: number; misplaced: number; onLoan: number; pending: number };
    const add = (map: Map<string, T>, key: string, state: string) => {
      const x = map.get(key) ?? { expected: 0, found: 0, misplaced: 0, onLoan: 0, pending: 0 };
      x.expected += 1;
      if (state === 'found' || state === 'misplaced') x.found += 1;
      if (state === 'misplaced') x.misplaced += 1;
      if (state === 'on_loan') x.onLoan += 1;
      if (state === 'pending') x.pending += 1;
      map.set(key, x);
    };
    const all = new Map<string, T>();
    const byClass = new Map<string, T>();
    const byType = new Map<string, T>();
    for (const r of rows) {
      add(all, '', r.state);
      add(byClass, mainOf(r.stat_ddc), r.state);
      add(byType, r.collection_type_id ?? '', r.state);
    }
    const types = [...byType.keys()].filter((k) => k !== '');
    const typeNames = new Map(
      types.length === 0 ? [] : (await ctx.db.selectFrom('collection_types').select(['id', 'name_id', 'name_en']).where('id', 'in', types).execute()).map((c) => [c.id, masterName(ctx, { name_id: c.name_id, name_en: c.name_en ?? c.name_id })]),
    );
    const line = (section: string, label: string, x: T): ReportRow => [section, label, x.expected, x.found, x.misplaced, x.onLoan, x.pending, pct(x.found, x.expected)];
    const out: ReportRow[] = [];
    const total = all.get('') ?? { expected: 0, found: 0, misplaced: 0, onLoan: 0, pending: 0 };
    out.push(line(t(ctx.locale, 'report.section.stocktake.total'), t(ctx.locale, 'report.row.stocktake.all'), total));
    const classSection = t(ctx.locale, 'report.section.stocktake.class');
    for (const key of [...DDC_MAINS]) {
      const x = byClass.get(key);
      if (x !== undefined) out.push(line(classSection, key === 'NON' ? t(ctx.locale, 'report.row.stocktake.no_class') : key, x));
    }
    const typeSection = t(ctx.locale, 'report.section.stocktake.collection_type');
    const typed = [...byType.entries()].map(([k, x]) => [k === '' ? t(ctx.locale, 'report.row.stocktake.no_collection_type') : (typeNames.get(k) ?? '?'), x] as const);
    for (const [label, x] of typed.sort((a, b) => a[0].localeCompare(b[0]))) out.push(line(typeSection, label, x));
    return { rows: out, nextCursor: null };
  },
});

/** The filtered copies of a session in `states`. */
function sessionCopies(ctx: ReportCtx, states: readonly string[]) {
  const id = textParam(ctx, 'stocktakeId') ?? '';
  let q = ctx.db
    .selectFrom('stocktake_items as s')
    .innerJoin('items as i', 'i.id', 's.item_id')
    .innerJoin('records as r', 'r.id', 'i.record_id')
    .leftJoin('material_types as mt', 'mt.id', 'r.material_type_id')
    .leftJoin('collection_types as ct', 'ct.id', 's.collection_type_id')
    .leftJoin('locations as el', 'el.id', 's.expected_location_id')
    .leftJoin('locations as sl', 'sl.id', 's.scanned_location_id')
    .where('s.stocktake_id', '=', id)
    .where('s.state', 'in', [...states]);
  const title = textParam(ctx, 'titleWords');
  const titleSql = title === null ? null : titleMatchSql(title);
  if (titleSql !== null) q = q.where(titleSql);
  const barcode = textParam(ctx, 'barcode');
  if (barcode !== null) q = q.where('i.barcode_key', 'like', `${escapeLike(barcode.trim().toUpperCase())}%`);
  const cls = textParam(ctx, 'classPrefix');
  if (cls !== null) q = q.where('s.stat_ddc', 'like', `${escapeLike(cls.replace(/\*$/, ''))}%`);
  const type = textParam(ctx, 'collectionTypeId');
  if (type !== null) q = q.where('s.collection_type_id', '=', type);
  const location = textParam(ctx, 'locationId');
  if (location !== null) q = q.where('s.expected_location_id', '=', location);
  return q;
}

const FILTER_PARAMS = [
  SESSION_PARAM,
  reportParam('titleWords', 'text'),
  reportParam('barcode', 'text'),
  reportParam('classPrefix', 'classPrefix'),
  reportParam('collectionTypeId', 'collectionType'),
  reportParam('locationId', 'location'),
];

const filterSchema = z.strictObject({
  ...sessionField,
  titleWords: z.string().trim().min(1).max(200).optional(),
  barcode: z.string().trim().min(1).max(64).optional(),
  classPrefix: reportClassPrefixField.optional(),
  collectionTypeId: reportIdField.optional(),
  locationId: reportIdField.optional(),
});

/** The copies not found (see the top of this file). */
export const stocktakeMissingReport: TableReport = Object.freeze<TableReport>({
  id: 'stocktake.missing',
  module: 'stocktake',
  kind: 'table',
  titleKey: 'report.stocktake.missing.title',
  permission: 'stocktake.scan.use',
  branchOf: sessionBranch,
  personal: false,
  formats: ['csv', 'xlsx', 'pdf'],
  orientation: 'landscape',
  params: FILTER_PARAMS,
  paramsSchema: filterSchema,
  columns: [
    reportColumn('barcode', 'text', { widthChars: 14 }),
    reportColumn('title', 'text', { widthChars: 32 }),
    reportColumn('material_type', 'text', { widthChars: 12 }),
    reportColumn('class', 'text', { widthChars: 6 }),
    reportColumn('collection_type', 'text', { widthChars: 12 }),
    reportColumn('call_number', 'text', { widthChars: 14 }),
    reportColumn('expected_location', 'text', { widthChars: 16 }),
  ],
  async rows(ctx, cursor, limit) {
    let q = sessionCopies(ctx, ['pending']).select([
      's.item_id',
      'i.barcode_display',
      'r.title',
      'mt.name_id as mt_id',
      'mt.name_en as mt_en',
      's.stat_ddc',
      'ct.name_id as ct_id',
      'ct.name_en as ct_en',
      'i.call_number',
      'r.call_number as record_call_number',
      'el.name as location',
    ]);
    if (cursor !== null) q = q.where('s.item_id', '>', decodeCursor(cursor, idKeyset)[0]);
    const found = await q.orderBy('s.item_id').limit(limit + 1).execute();
    const page = found.slice(0, limit);
    const rows: ReportRow[] = page.map((r) => [
      r.barcode_display,
      r.title,
      r.mt_id === null ? null : masterName(ctx, { name_id: r.mt_id, name_en: r.mt_en ?? r.mt_id }),
      r.stat_ddc,
      r.ct_id === null ? null : masterName(ctx, { name_id: r.ct_id, name_en: r.ct_en ?? r.ct_id }),
      r.call_number ?? r.record_call_number,
      r.location,
    ]);
    const last = page[page.length - 1];
    return { rows, nextCursor: found.length > limit && last !== undefined ? encodeCursor([last.item_id]) : null };
  },
  async count(ctx) {
    return countRows(sessionCopies(ctx, ['pending']));
  },
});

/** The copies found at another place (see the top of this file). */
export const stocktakeMisplacedReport: TableReport = Object.freeze<TableReport>({
  id: 'stocktake.misplaced',
  module: 'stocktake',
  kind: 'table',
  titleKey: 'report.stocktake.misplaced.title',
  permission: 'stocktake.scan.use',
  branchOf: sessionBranch,
  personal: false,
  formats: ['csv', 'xlsx', 'pdf'],
  orientation: 'landscape',
  params: FILTER_PARAMS,
  paramsSchema: filterSchema,
  columns: [
    reportColumn('barcode', 'text', { widthChars: 14 }),
    reportColumn('title', 'text', { widthChars: 32 }),
    reportColumn('call_number', 'text', { widthChars: 14 }),
    reportColumn('expected_location', 'text', { widthChars: 16 }),
    reportColumn('scanned_location', 'text', { widthChars: 16 }),
    reportColumn('scanned_at', 'text', { widthChars: 16 }),
  ],
  async rows(ctx, cursor, limit) {
    let q = sessionCopies(ctx, ['misplaced']).select([
      's.item_id',
      'i.barcode_display',
      'r.title',
      'i.call_number',
      'r.call_number as record_call_number',
      'el.name as expected_location',
      'sl.name as scanned_location',
      's.scanned_at',
    ]);
    if (cursor !== null) q = q.where('s.item_id', '>', decodeCursor(cursor, idKeyset)[0]);
    const found = await q.orderBy('s.item_id').limit(limit + 1).execute();
    const page = found.slice(0, limit);
    const rows: ReportRow[] = page.map((r) => [
      r.barcode_display,
      r.title,
      r.call_number ?? r.record_call_number,
      r.expected_location,
      r.scanned_location,
      r.scanned_at === null ? null : localDateTime(ctx.tz, Number(r.scanned_at)),
    ]);
    const last = page[page.length - 1];
    return { rows, nextCursor: found.length > limit && last !== undefined ? encodeCursor([last.item_id]) : null };
  },
  async count(ctx) {
    return countRows(sessionCopies(ctx, ['misplaced']));
  },
});

/** What each officer scanned (personal data: the staff names). */
export const stocktakeByOfficerReport: TableReport = Object.freeze<TableReport>({
  id: 'stocktake.by_officer',
  module: 'stocktake',
  kind: 'table',
  titleKey: 'report.stocktake.by_officer.title',
  permission: 'stocktake.scan.use',
  branchOf: sessionBranch,
  personal: true,
  formats: ['csv', 'xlsx', 'pdf'],
  orientation: 'portrait',
  params: [SESSION_PARAM],
  paramsSchema: z.strictObject(sessionField),
  columns: [
    reportColumn('officer', 'text', { source: { table: 'staff_users', column: 'name' }, widthChars: 28 }),
    reportColumn('found', 'int'),
    reportColumn('misplaced', 'int'),
    reportColumn('unexpected', 'int'),
  ],
  async rows(ctx, cursor) {
    if (cursor !== null) return { rows: [], nextCursor: null };
    const id = textParam(ctx, 'stocktakeId') ?? '';
    const found = await ctx.db
      .selectFrom('stocktake_items as s')
      .leftJoin('staff_users as u', 'u.id', 's.scanned_by')
      .select(['s.scanned_by', 's.scanned_by_name', 'u.name', 's.state'])
      .select((eb) => eb.fn.countAll<number>().as('n'))
      .where('s.stocktake_id', '=', id)
      .where('s.state', 'in', ['found', 'misplaced', 'unexpected'])
      .groupBy(['s.scanned_by', 's.scanned_by_name', 'u.name', 's.state'])
      .execute();
    const by = new Map<string, [string, number, number, number]>();
    for (const r of found) {
      const key = r.scanned_by ?? `name:${r.scanned_by_name ?? ''}`;
      const o = by.get(key) ?? [r.name ?? r.scanned_by_name ?? '?', 0, 0, 0];
      const n = Number(r.n);
      if (r.state === 'found') o[1] += n;
      else if (r.state === 'misplaced') {
        o[1] += n;
        o[2] += n;
      } else o[3] += n;
      by.set(key, o);
    }
    return { rows: [...by.values()].sort((a, b) => b[1] - a[1] || a[0].localeCompare(b[0])), nextCursor: null };
  },
});

/** Every session (see the top of this file). */
export const stocktakeHistoryReport: TableReport = Object.freeze<TableReport>({
  id: 'stocktake.history',
  module: 'stocktake',
  kind: 'table',
  titleKey: 'report.stocktake.history.title',
  permission: 'stocktake.scan.use',
  branchOf: historyBranch,
  personal: false,
  formats: ['csv', 'xlsx', 'pdf'],
  orientation: 'landscape',
  params: [reportParam('branchId', 'branch')],
  paramsSchema: z.strictObject({ branchId: reportIdField.optional() }),
  columns: [
    reportColumn('session', 'text', { widthChars: 24 }),
    reportColumn('branch', 'text', { widthChars: 10 }),
    reportColumn('started_at', 'text', { widthChars: 16 }),
    reportColumn('finished_at', 'text', { widthChars: 16 }),
    reportColumn('status', 'text', { widthChars: 12 }),
    reportColumn('source', 'text', { widthChars: 12 }),
    reportColumn('expected', 'int'),
    reportColumn('found', 'int'),
    reportColumn('pending', 'int'),
    reportColumn('misplaced', 'int'),
    reportColumn('on_loan', 'int'),
    reportColumn('unexpected', 'int'),
    reportColumn('unknown_codes', 'int'),
  ],
  async rows(ctx, cursor, limit) {
    let q = ctx.db.selectFrom('stocktakes as s').innerJoin('branches as b', 'b.id', 's.branch_id').selectAll('s').select('b.code_display');
    const branchId = textParam(ctx, 'branchId');
    if (branchId !== null) q = q.where('s.branch_id', '=', branchId);
    if (cursor !== null) q = q.where('s.id', '<', decodeCursor(cursor, idKeyset)[0]);
    const found = await q.orderBy('s.id', 'desc').limit(limit + 1).execute();
    const page = found.slice(0, limit);
    const rows: ReportRow[] = page.map((s) => {
      const total = Number(s.total);
      const fnd = Number(s.found);
      const onLoan = Number(s.on_loan);
      return [
        s.name,
        s.code_display,
        localDateTime(ctx.tz, Number(s.started_at)),
        s.finished_at === null ? null : localDateTime(ctx.tz, Number(s.finished_at)),
        (STOCKTAKE_STATUSES as readonly string[]).includes(s.status) ? vocabLabel(ctx, 'stocktake_status', s.status) : s.status,
        (STOCKTAKE_SOURCES as readonly string[]).includes(s.source) ? vocabLabel(ctx, 'stocktake_source', s.source) : s.source,
        total,
        fnd,
        Math.max(0, total - fnd - onLoan),
        Number(s.misplaced),
        onLoan,
        Number(s.unexpected),
        Number(s.unknown_codes),
      ];
    });
    const last = page[page.length - 1];
    return { rows, nextCursor: found.length > limit && last !== undefined ? encodeCursor([last.id]) : null };
  },
});
